'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { Client: SSHClient } = require('ssh2');

let pty = null;
try {
  pty = require('node-pty');
} catch (err) {
  console.warn('[infocat] node-pty not available — local terminal disabled until deps are rebuilt:', err.message);
}

const store = require('./sessionStore');

const branding = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'branding', 'branding.json'), 'utf8')
);

/** Active terminal sessions keyed by renderer-supplied id. */
const terms = new Map();

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 560,
    title: branding.windowTitle || 'Infocat Terminal',
    backgroundColor: (branding.colors && branding.colors.bg) || '#0d1117',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

/* ----------------------------- Local terminal ---------------------------- */

function openLocal({ id, cols, rows, cwd, startupCommand }) {
  if (!pty) {
    send('term:status', { id, status: 'error', message: 'Local terminal unavailable: node-pty is not built. Run "npm run rebuild".' });
    return;
  }
  const shell = process.env.SHELL ||
    (process.platform === 'win32' ? 'powershell.exe' : '/bin/bash');

  const proc = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: cwd || os.homedir(),
    env: process.env
  });

  terms.set(id, { type: 'local', proc });

  proc.onData((data) => send('term:data', { id, data }));
  proc.onExit(({ exitCode }) => {
    send('term:exit', { id, code: exitCode });
    terms.delete(id);
  });

  send('term:status', { id, status: 'connected', message: `local shell (${shell})` });

  if (startupCommand) {
    proc.write(startupCommand + '\r');
  }
}

/* -------------------------------- SSH ------------------------------------ */

function buildAuth(sess) {
  const cfg = {
    host: sess.host,
    port: Number(sess.port) || 22,
    username: sess.username,
    keepaliveInterval: 20000,
    readyTimeout: 30000,
    // Ask for keyboard-interactive so servers that only offer it still work.
    tryKeyboard: true
  };

  if (sess.authType === 'key' && sess.privateKeyPath) {
    cfg.privateKey = fs.readFileSync(sess.privateKeyPath);
    if (sess.passphrase) cfg.passphrase = sess.passphrase;
  } else if (sess.authType === 'agent') {
    cfg.agent = process.platform === 'win32'
      ? (process.env.SSH_AUTH_SOCK || 'pageant')
      : process.env.SSH_AUTH_SOCK;
  } else {
    cfg.password = sess.password || '';
  }
  return cfg;
}

function openSsh({ id, sess, cols, rows }) {
  const conn = new SSHClient();
  const record = { type: 'ssh', conn, stream: null, sftp: null, sess };
  terms.set(id, record);

  send('term:status', { id, status: 'connecting', message: `Connecting to ${sess.username}@${sess.host}:${sess.port || 22}…` });

  conn.on('ready', () => {
    conn.shell({ term: 'xterm-256color', cols: cols || 80, rows: rows || 24 }, (err, stream) => {
      if (err) {
        send('term:status', { id, status: 'error', message: 'Shell error: ' + err.message });
        conn.end();
        return;
      }
      record.stream = stream;
      send('term:status', { id, status: 'connected', message: `Connected to ${sess.host}` });

      stream.on('data', (d) => send('term:data', { id, data: d.toString('utf8') }));
      stream.stderr.on('data', (d) => send('term:data', { id, data: d.toString('utf8') }));
      stream.on('close', () => {
        send('term:exit', { id, code: 0 });
        conn.end();
      });

      if (sess.startupCommand) {
        stream.write(sess.startupCommand + '\n');
      }
    });

    // Open an SFTP channel for the file browser (best-effort).
    conn.sftp((err, sftp) => {
      if (!err) {
        record.sftp = sftp;
        send('sftp:ready', { id });
      }
    });
  });

  conn.on('keyboard-interactive', (name, instr, lang, prompts, finish) => {
    // Answer every prompt with the stored password (common for MFA-less servers).
    finish(prompts.map(() => sess.password || ''));
  });

  conn.on('error', (err) => {
    send('term:status', { id, status: 'error', message: err.message });
    terms.delete(id);
  });

  conn.on('close', () => {
    terms.delete(id);
  });

  try {
    conn.connect(buildAuth(sess));
  } catch (err) {
    send('term:status', { id, status: 'error', message: err.message });
    terms.delete(id);
  }
}

/* ----------------------------- IPC: terminals ---------------------------- */

ipcMain.handle('branding:get', () => branding);

ipcMain.handle('term:openLocal', (_e, args) => {
  openLocal(args);
  return true;
});

ipcMain.handle('term:openSsh', (_e, args) => {
  // args: { id, sessionId?, inline?, cols, rows }
  let sess;
  if (args.sessionId) {
    sess = store.getSessionFull(args.sessionId);
    if (!sess) {
      send('term:status', { id: args.id, status: 'error', message: 'Saved session not found.' });
      return false;
    }
  } else {
    sess = args.inline || {};
  }
  openSsh({ id: args.id, sess, cols: args.cols, rows: args.rows });
  return true;
});

ipcMain.on('term:input', (_e, { id, data }) => {
  const t = terms.get(id);
  if (!t) return;
  if (t.type === 'local' && t.proc) t.proc.write(data);
  else if (t.type === 'ssh' && t.stream) t.stream.write(data);
});

ipcMain.on('term:resize', (_e, { id, cols, rows }) => {
  const t = terms.get(id);
  if (!t) return;
  try {
    if (t.type === 'local' && t.proc) t.proc.resize(cols, rows);
    else if (t.type === 'ssh' && t.stream) t.stream.setWindow(rows, cols, 0, 0);
  } catch (_) { /* ignore transient resize errors */ }
});

ipcMain.on('term:close', (_e, { id }) => {
  const t = terms.get(id);
  if (!t) return;
  try {
    if (t.type === 'local' && t.proc) t.proc.kill();
    else if (t.type === 'ssh' && t.conn) t.conn.end();
  } catch (_) { /* ignore */ }
  terms.delete(id);
});

/* ------------------------------- IPC: SFTP ------------------------------- */

function withSftp(id) {
  const t = terms.get(id);
  if (!t || t.type !== 'ssh' || !t.sftp) return null;
  return t.sftp;
}

ipcMain.handle('sftp:list', async (_e, { id, path: dir }) => {
  const sftp = withSftp(id);
  if (!sftp) throw new Error('SFTP not ready for this session.');
  const target = dir || '.';
  const realDir = await new Promise((resolve, reject) => {
    sftp.realpath(target, (err, abs) => (err ? reject(err) : resolve(abs)));
  });
  const entries = await new Promise((resolve, reject) => {
    sftp.readdir(realDir, (err, list) => (err ? reject(err) : resolve(list)));
  });
  const items = entries.map((e) => {
    const isDir = e.attrs.isDirectory();
    return {
      name: e.filename,
      isDir,
      size: e.attrs.size,
      mtime: e.attrs.mtime * 1000,
      longname: e.longname
    };
  }).sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
  return { cwd: realDir, items };
});

ipcMain.handle('sftp:download', async (_e, { id, remotePath, name }) => {
  const sftp = withSftp(id);
  if (!sftp) throw new Error('SFTP not ready.');
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Download file',
    defaultPath: path.join(app.getPath('downloads'), name || path.basename(remotePath))
  });
  if (canceled || !filePath) return { canceled: true };
  await new Promise((resolve, reject) => {
    sftp.fastGet(remotePath, filePath, (err) => (err ? reject(err) : resolve()));
  });
  return { canceled: false, filePath };
});

ipcMain.handle('sftp:upload', async (_e, { id, remoteDir }) => {
  const sftp = withSftp(id);
  if (!sftp) throw new Error('SFTP not ready.');
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Upload file(s)',
    properties: ['openFile', 'multiSelections']
  });
  if (canceled || !filePaths.length) return { canceled: true };
  for (const local of filePaths) {
    const remote = path.posix.join(remoteDir || '.', path.basename(local));
    await new Promise((resolve, reject) => {
      sftp.fastPut(local, remote, (err) => (err ? reject(err) : resolve()));
    });
  }
  return { canceled: false, count: filePaths.length };
});

ipcMain.handle('sftp:mkdir', async (_e, { id, remotePath }) => {
  const sftp = withSftp(id);
  if (!sftp) throw new Error('SFTP not ready.');
  await new Promise((resolve, reject) => {
    sftp.mkdir(remotePath, (err) => (err ? reject(err) : resolve()));
  });
  return true;
});

ipcMain.handle('sftp:delete', async (_e, { id, remotePath, isDir }) => {
  const sftp = withSftp(id);
  if (!sftp) throw new Error('SFTP not ready.');
  await new Promise((resolve, reject) => {
    const fn = isDir ? sftp.rmdir.bind(sftp) : sftp.unlink.bind(sftp);
    fn(remotePath, (err) => (err ? reject(err) : resolve()));
  });
  return true;
});

/* --------------------------- IPC: session store -------------------------- */

ipcMain.handle('sessions:list', () => store.listSessions());
ipcMain.handle('sessions:save', (_e, session) => store.saveSession(session));
ipcMain.handle('sessions:delete', (_e, sessId) => {
  store.deleteSession(sessId);
  return true;
});
ipcMain.handle('sessions:encryptionAvailable', () => store.encryptionAvailable());

/* ------------------------------- IPC: misc ------------------------------- */

ipcMain.handle('dialog:openKey', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Select private key',
    properties: ['openFile']
  });
  if (canceled || !filePaths.length) return null;
  return filePaths[0];
});

ipcMain.handle('shell:openExternal', (_e, url) => {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  return true;
});

/* ------------------------------- App lifecycle --------------------------- */

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  // Tear down any live connections.
  for (const [, t] of terms) {
    try {
      if (t.type === 'local' && t.proc) t.proc.kill();
      else if (t.type === 'ssh' && t.conn) t.conn.end();
    } catch (_) { /* ignore */ }
  }
  terms.clear();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
