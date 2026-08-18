'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Minimal, explicit API surface exposed to the renderer.
 * The renderer never touches Node or ssh2 directly.
 */
contextBridge.exposeInMainWorld('infocat', {
  getBranding: () => ipcRenderer.invoke('branding:get'),

  // Terminals
  openLocal: (args) => ipcRenderer.invoke('term:openLocal', args),
  openSsh: (args) => ipcRenderer.invoke('term:openSsh', args),
  sendInput: (id, data) => ipcRenderer.send('term:input', { id, data }),
  resize: (id, cols, rows) => ipcRenderer.send('term:resize', { id, cols, rows }),
  closeTerm: (id) => ipcRenderer.send('term:close', { id }),

  onData: (cb) => sub('term:data', cb),
  onExit: (cb) => sub('term:exit', cb),
  onStatus: (cb) => sub('term:status', cb),
  onSftpReady: (cb) => sub('sftp:ready', cb),

  // SFTP
  sftpList: (id, path) => ipcRenderer.invoke('sftp:list', { id, path }),
  sftpDownload: (id, remotePath, name) => ipcRenderer.invoke('sftp:download', { id, remotePath, name }),
  sftpUpload: (id, remoteDir) => ipcRenderer.invoke('sftp:upload', { id, remoteDir }),
  sftpMkdir: (id, remotePath) => ipcRenderer.invoke('sftp:mkdir', { id, remotePath }),
  sftpDelete: (id, remotePath, isDir) => ipcRenderer.invoke('sftp:delete', { id, remotePath, isDir }),

  // Saved sessions
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  saveSession: (s) => ipcRenderer.invoke('sessions:save', s),
  deleteSession: (id) => ipcRenderer.invoke('sessions:delete', id),
  encryptionAvailable: () => ipcRenderer.invoke('sessions:encryptionAvailable'),

  // Misc
  pickKeyFile: () => ipcRenderer.invoke('dialog:openKey'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url)
});

function sub(channel, cb) {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}
