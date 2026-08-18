'use strict';

/* global Terminal, FitAddon, WebLinksAddon */

const api = window.infocat;

const state = {
  branding: null,
  tabs: new Map(),   // id -> tab object
  activeId: null,
  seq: 0
};

/* ------------------------------ Bootstrap -------------------------------- */

(async function init() {
  state.branding = await api.getBranding();
  applyBranding(state.branding);
  wireGlobalUI();
  wireTerminalEvents();
  await refreshSessions();

  const enc = await api.encryptionAvailable();
  document.getElementById('enc-status').textContent = enc
    ? '🔒 Saved passwords encrypted by your OS keychain'
    : '⚠ OS encryption unavailable — passwords stored obfuscated only';
})();

function applyBranding(b) {
  const root = document.documentElement.style;
  const c = b.colors || {};
  const map = {
    brand: c.brand, 'brand-hover': c.brandHover, 'brand-dim': c.brandDim,
    accent: c.accent, bg: c.bg, 'bg-panel': c.bgPanel, 'bg-elevated': c.bgElevated,
    border: c.border, text: c.text, 'text-muted': c.textMuted,
    danger: c.danger, success: c.success
  };
  for (const [k, v] of Object.entries(map)) if (v) root.setProperty('--' + k, v);

  const logoPath = '../branding/' + (b.logo || 'logomark.png');
  document.getElementById('brand-logo').src = logoPath;
  document.getElementById('welcome-logo').src = logoPath;
  document.getElementById('brand-name').textContent = b.shortName || 'Infocat';
  document.getElementById('brand-tag').textContent = (b.appName || 'Terminal').replace(b.shortName || '', '').trim() || 'Terminal';
  document.getElementById('welcome-title').textContent = b.appName || 'Infocat Terminal';
  document.getElementById('welcome-tag').textContent = b.tagline || '';
  document.title = b.windowTitle || b.appName || 'Infocat Terminal';
}

/* ------------------------------ Tabs / panes ----------------------------- */

function nextId() { return 'term-' + (++state.seq); }

function createTab({ title, kind }) {
  const id = nextId();
  const paneEl = document.createElement('div');
  paneEl.className = 'pane';
  paneEl.id = 'pane-' + id;
  document.getElementById('panes').appendChild(paneEl);

  const term = new Terminal({
    fontFamily: 'ui-monospace, "Cascadia Mono", "JetBrains Mono", Menlo, Consolas, monospace',
    fontSize: 13,
    cursorBlink: true,
    scrollback: 5000,
    theme: state.branding.terminalTheme || {}
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  try { term.loadAddon(new WebLinksAddon.WebLinksAddon((_e, url) => api.openExternal(url))); } catch (_) {}
  term.open(paneEl);

  term.onData((data) => api.sendInput(id, data));
  term.onResize(({ cols, rows }) => api.resize(id, cols, rows));

  // Tab button
  const tabEl = document.createElement('div');
  tabEl.className = 'tab';
  tabEl.dataset.id = id;
  tabEl.innerHTML =
    `<span class="status-dot connecting"></span>` +
    `<span class="tab-title"></span>` +
    `<button class="tab-close" title="Close">✕</button>`;
  tabEl.querySelector('.tab-title').textContent = title;
  tabEl.addEventListener('click', (e) => {
    if (e.target.classList.contains('tab-close')) { closeTab(id); return; }
    activateTab(id);
  });
  document.getElementById('tabbar').appendChild(tabEl);

  const tab = { id, kind, term, fit, tabEl, paneEl, title, sftpReady: false, sftpCwd: '.' };
  state.tabs.set(id, tab);
  document.getElementById('welcome').style.display = 'none';
  activateTab(id);
  return tab;
}

function activateTab(id) {
  state.activeId = id;
  for (const [tid, t] of state.tabs) {
    const on = tid === id;
    t.tabEl.classList.toggle('active', on);
    t.paneEl.classList.toggle('active', on);
    if (on) {
      setTimeout(() => { t.fit.fit(); t.term.focus(); }, 0);
      updateSftpDrawer(t);
    }
  }
}

function closeTab(id) {
  const t = state.tabs.get(id);
  if (!t) return;
  api.closeTerm(id);
  t.term.dispose();
  t.tabEl.remove();
  t.paneEl.remove();
  state.tabs.delete(id);
  if (state.activeId === id) {
    const next = state.tabs.keys().next().value;
    if (next) activateTab(next);
    else {
      state.activeId = null;
      document.getElementById('welcome').style.display = 'flex';
      hideSftp();
    }
  }
}

function setStatus(id, status, message) {
  const t = state.tabs.get(id);
  if (!t) return;
  const dot = t.tabEl.querySelector('.status-dot');
  dot.className = 'status-dot ' + status;
  if (message && (status === 'error')) {
    t.term.writeln(`\r\n\x1b[38;5;203m● ${message}\x1b[0m`);
  }
}

/* ------------------------- Opening connections --------------------------- */

function openLocalTab() {
  const t = createTab({ title: 'local', kind: 'local' });
  const { cols, rows } = t.term;
  api.openLocal({ id: t.id, cols, rows });
}

function openSshTab({ sessionId, inline, label }) {
  const t = createTab({ title: label || (inline && inline.host) || 'ssh', kind: 'ssh' });
  const { cols, rows } = t.term;
  api.openSsh({ id: t.id, sessionId, inline, cols, rows });
}

/* ---------------------------- Terminal events ---------------------------- */

function wireTerminalEvents() {
  api.onData(({ id, data }) => {
    const t = state.tabs.get(id);
    if (t) t.term.write(data);
  });
  api.onStatus(({ id, status, message }) => {
    setStatus(id, status, message);
    const t = state.tabs.get(id);
    if (t && status === 'connecting' && message) t.term.writeln(`\x1b[38;5;141m${message}\x1b[0m`);
  });
  api.onExit(({ id }) => {
    const t = state.tabs.get(id);
    if (t) {
      setStatus(id, 'error');
      t.term.writeln('\r\n\x1b[38;5;245m[session closed]\x1b[0m');
    }
  });
  api.onSftpReady(({ id }) => {
    const t = state.tabs.get(id);
    if (t) { t.sftpReady = true; if (state.activeId === id) updateSftpDrawer(t); }
  });

  window.addEventListener('resize', () => {
    const t = state.tabs.get(state.activeId);
    if (t) t.fit.fit();
  });
}

/* -------------------------------- SFTP ----------------------------------- */

function updateSftpDrawer(tab) {
  if (tab && tab.kind === 'ssh' && tab.sftpReady) {
    showSftp();
    loadSftp(tab, tab.sftpCwd || '.');
  } else {
    hideSftp();
  }
}
function showSftp() { document.getElementById('sftp').classList.remove('hidden'); }
function hideSftp() { document.getElementById('sftp').classList.add('hidden'); }

async function loadSftp(tab, dir) {
  const listEl = document.getElementById('sftp-list');
  listEl.innerHTML = '<div class="sftp-empty">Loading…</div>';
  try {
    const { cwd, items } = await api.sftpList(tab.id, dir);
    tab.sftpCwd = cwd;
    document.getElementById('sftp-path').textContent = cwd;
    listEl.innerHTML = '';
    if (!items.length) {
      listEl.innerHTML = '<div class="sftp-empty">Empty folder</div>';
      return;
    }
    for (const it of items) {
      const row = document.createElement('div');
      row.className = 'sftp-row';
      const path = joinPosix(cwd, it.name);
      row.innerHTML =
        `<span class="sftp-ic">${it.isDir ? '📁' : '📄'}</span>` +
        `<span class="sftp-name"></span>` +
        `<span class="sftp-size">${it.isDir ? '' : humanSize(it.size)}</span>` +
        `<span class="row-actions"></span>`;
      row.querySelector('.sftp-name').textContent = it.name;
      const actions = row.querySelector('.row-actions');
      if (!it.isDir) {
        const dl = mkIconBtn('⬇', 'Download');
        dl.addEventListener('click', (e) => { e.stopPropagation(); api.sftpDownload(tab.id, path, it.name); });
        actions.appendChild(dl);
      }
      const del = mkIconBtn('🗑', 'Delete');
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (confirm(`Delete ${it.name}?`)) {
          try { await api.sftpDelete(tab.id, path, it.isDir); loadSftp(tab, cwd); }
          catch (err) { alert('Delete failed: ' + err.message); }
        }
      });
      actions.appendChild(del);
      row.addEventListener('click', () => { if (it.isDir) loadSftp(tab, path); });
      listEl.appendChild(row);
    }
  } catch (err) {
    listEl.innerHTML = `<div class="sftp-empty">SFTP error: ${escapeHtml(err.message)}</div>`;
  }
}

function wireSftpUI() {
  document.getElementById('sftp-close').addEventListener('click', hideSftp);
  document.getElementById('sftp-refresh').addEventListener('click', () => {
    const t = state.tabs.get(state.activeId); if (t) loadSftp(t, t.sftpCwd);
  });
  document.getElementById('sftp-up').addEventListener('click', () => {
    const t = state.tabs.get(state.activeId); if (t) loadSftp(t, parentPosix(t.sftpCwd));
  });
  document.getElementById('sftp-upload').addEventListener('click', async () => {
    const t = state.tabs.get(state.activeId); if (!t) return;
    try { const r = await api.sftpUpload(t.id, t.sftpCwd); if (!r.canceled) loadSftp(t, t.sftpCwd); }
    catch (err) { alert('Upload failed: ' + err.message); }
  });
  document.getElementById('sftp-mkdir').addEventListener('click', async () => {
    const t = state.tabs.get(state.activeId); if (!t) return;
    const name = prompt('New folder name:');
    if (!name) return;
    try { await api.sftpMkdir(t.id, joinPosix(t.sftpCwd, name)); loadSftp(t, t.sftpCwd); }
    catch (err) { alert('Create folder failed: ' + err.message); }
  });
}

/* --------------------------- Saved sessions ------------------------------ */

async function refreshSessions() {
  const list = await api.listSessions();
  const el = document.getElementById('session-list');
  el.innerHTML = '';
  if (!list.length) {
    el.innerHTML = '<div class="session-empty">No saved sessions yet. Click + to add one.</div>';
    return;
  }
  for (const s of list) {
    const item = document.createElement('div');
    item.className = 'session-item';
    item.innerHTML =
      `<span class="session-dot"></span>` +
      `<span class="session-meta">` +
        `<div class="session-label"></div>` +
        `<div class="session-sub"></div>` +
      `</span>` +
      `<span class="session-actions"></span>`;
    item.querySelector('.session-label').textContent = s.label;
    item.querySelector('.session-sub').textContent = `${s.username}@${s.host}:${s.port}`;
    if (s.color) item.querySelector('.session-dot').style.background = s.color;

    const actions = item.querySelector('.session-actions');
    const edit = mkIconBtn('✎', 'Edit');
    edit.addEventListener('click', (e) => { e.stopPropagation(); openDialog(s); });
    const del = mkIconBtn('🗑', 'Delete');
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (confirm(`Delete saved session "${s.label}"?`)) { await api.deleteSession(s.id); refreshSessions(); }
    });
    actions.appendChild(edit); actions.appendChild(del);

    item.addEventListener('click', () => openSshTab({ sessionId: s.id, label: s.label }));
    el.appendChild(item);
  }
}

/* ------------------------------ Dialog ----------------------------------- */

let editingId = null;

function openDialog(session) {
  editingId = session ? session.id : null;
  document.getElementById('dialog-title').textContent = session ? 'Edit session' : 'New SSH connection';
  document.getElementById('f-label').value = session ? session.label : '';
  document.getElementById('f-host').value = session ? session.host : '';
  document.getElementById('f-port').value = session ? session.port : 22;
  document.getElementById('f-user').value = session ? session.username : '';
  document.getElementById('f-auth').value = session ? session.authType : 'password';
  document.getElementById('f-pass').value = '';
  document.getElementById('f-key').value = session ? (session.privateKeyPath || '') : '';
  document.getElementById('f-passphrase').value = '';
  document.getElementById('f-startup').value = session ? (session.startupCommand || '') : '';
  document.getElementById('f-save').checked = !!session;
  document.getElementById('dialog-connect').textContent = session ? 'Save & connect' : 'Connect';
  updateAuthVisibility();
  document.getElementById('dialog-backdrop').classList.remove('hidden');
  document.getElementById('f-host').focus();
}

function closeDialog() {
  document.getElementById('dialog-backdrop').classList.add('hidden');
  editingId = null;
}

function updateAuthVisibility() {
  const auth = document.getElementById('f-auth').value;
  document.getElementById('wrap-pass').classList.toggle('hidden', auth !== 'password');
  document.getElementById('wrap-key').classList.toggle('hidden', auth !== 'key');
}

function readDialog() {
  return {
    id: editingId || undefined,
    label: document.getElementById('f-label').value.trim(),
    type: 'ssh',
    host: document.getElementById('f-host').value.trim(),
    port: parseInt(document.getElementById('f-port').value, 10) || 22,
    username: document.getElementById('f-user').value.trim(),
    authType: document.getElementById('f-auth').value,
    password: document.getElementById('f-pass').value,
    privateKeyPath: document.getElementById('f-key').value.trim(),
    passphrase: document.getElementById('f-passphrase').value,
    startupCommand: document.getElementById('f-startup').value.trim()
  };
}

async function submitDialog() {
  const data = readDialog();
  if (!data.host) { alert('Host is required.'); return; }
  if (!data.username) { alert('Username is required.'); return; }
  if (!data.label) data.label = data.host;

  const save = document.getElementById('f-save').checked;
  let sessionId;
  if (save) {
    sessionId = await api.saveSession(data);
    await refreshSessions();
  }
  closeDialog();
  if (sessionId) openSshTab({ sessionId, label: data.label });
  else openSshTab({ inline: data, label: data.label });
}

/* ------------------------------ Global UI -------------------------------- */

function wireGlobalUI() {
  document.getElementById('btn-new-ssh').addEventListener('click', () => openDialog(null));
  document.getElementById('welcome-ssh').addEventListener('click', () => openDialog(null));
  document.getElementById('btn-add-session').addEventListener('click', () => openDialog(null));
  document.getElementById('btn-new-local').addEventListener('click', openLocalTab);
  document.getElementById('welcome-local').addEventListener('click', openLocalTab);

  document.getElementById('dialog-close').addEventListener('click', closeDialog);
  document.getElementById('dialog-cancel').addEventListener('click', closeDialog);
  document.getElementById('dialog-connect').addEventListener('click', submitDialog);
  document.getElementById('f-auth').addEventListener('change', updateAuthVisibility);
  document.getElementById('btn-browse-key').addEventListener('click', async () => {
    const p = await api.pickKeyFile();
    if (p) document.getElementById('f-key').value = p;
  });
  document.getElementById('dialog-backdrop').addEventListener('click', (e) => {
    if (e.target.id === 'dialog-backdrop') closeDialog();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDialog();
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'T' || e.key === 't')) { e.preventDefault(); openLocalTab(); }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'w') && state.activeId) { e.preventDefault(); closeTab(state.activeId); }
  });

  wireSftpUI();
}

/* ------------------------------ Helpers ---------------------------------- */

function mkIconBtn(txt, title) {
  const b = document.createElement('button');
  b.className = 'icon-btn'; b.textContent = txt; b.title = title || '';
  return b;
}
function humanSize(n) {
  if (n == null) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v : v.toFixed(1)) + ' ' + u[i];
}
function joinPosix(dir, name) {
  if (dir.endsWith('/')) return dir + name;
  return dir + '/' + name;
}
function parentPosix(dir) {
  if (dir === '/' || !dir) return '/';
  const parts = dir.replace(/\/+$/, '').split('/');
  parts.pop();
  const p = parts.join('/');
  return p === '' ? '/' : p;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
