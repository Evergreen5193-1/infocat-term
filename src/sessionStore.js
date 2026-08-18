'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, safeStorage } = require('electron');

/**
 * Persists saved connection profiles to a JSON file in the app's userData dir.
 * Secret fields (password, passphrase) are encrypted with Electron's safeStorage
 * (OS keychain / DPAPI) when available, and never stored in plaintext.
 */

const FILE = () => path.join(app.getPath('userData'), 'sessions.json');
const SECRET_FIELDS = ['password', 'passphrase'];

function canEncrypt() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch (_) {
    return false;
  }
}

function encryptSecret(plain) {
  if (plain == null || plain === '') return '';
  if (canEncrypt()) {
    return 'enc:' + safeStorage.encryptString(String(plain)).toString('base64');
  }
  // Fallback (encryption backend unavailable): mark clearly so it is never mistaken for encrypted.
  return 'plain:' + Buffer.from(String(plain), 'utf8').toString('base64');
}

function decryptSecret(stored) {
  if (!stored) return '';
  if (stored.startsWith('enc:')) {
    try {
      return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
    } catch (_) {
      return '';
    }
  }
  if (stored.startsWith('plain:')) {
    return Buffer.from(stored.slice(6), 'utf8').toString('utf8');
  }
  return '';
}

function readRaw() {
  try {
    const txt = fs.readFileSync(FILE(), 'utf8');
    const data = JSON.parse(txt);
    return Array.isArray(data.sessions) ? data.sessions : [];
  } catch (_) {
    return [];
  }
}

function writeRaw(sessions) {
  const dir = path.dirname(FILE());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(FILE(), JSON.stringify({ version: 1, sessions }, null, 2), 'utf8');
}

/** Returns sessions with secrets stripped — safe to send to the renderer. */
function listSessions() {
  return readRaw().map((s) => {
    const out = { ...s };
    for (const f of SECRET_FIELDS) {
      out['has' + f[0].toUpperCase() + f.slice(1)] = !!s[f];
      delete out[f];
    }
    return out;
  });
}

/** Full record incl. decrypted secrets — used internally to open a connection. */
function getSessionFull(id) {
  const s = readRaw().find((x) => x.id === id);
  if (!s) return null;
  const out = { ...s };
  for (const f of SECRET_FIELDS) {
    out[f] = decryptSecret(s[f]);
  }
  return out;
}

function saveSession(session) {
  const sessions = readRaw();
  const id = session.id || crypto.randomUUID();
  const record = {
    id,
    label: session.label || session.host || 'Session',
    type: session.type || 'ssh', // 'ssh' | 'local'
    host: session.host || '',
    port: Number(session.port) || 22,
    username: session.username || '',
    authType: session.authType || 'password', // 'password' | 'key' | 'agent'
    privateKeyPath: session.privateKeyPath || '',
    color: session.color || '',
    startupCommand: session.startupCommand || '',
    updatedAt: Date.now()
  };
  // Only overwrite a secret when a new non-empty value is provided;
  // otherwise keep the previously stored (encrypted) value.
  const existing = sessions.find((x) => x.id === id);
  for (const f of SECRET_FIELDS) {
    if (session[f]) {
      record[f] = encryptSecret(session[f]);
    } else if (existing && existing[f]) {
      record[f] = existing[f];
    } else {
      record[f] = '';
    }
  }

  const idx = sessions.findIndex((x) => x.id === id);
  if (idx >= 0) sessions[idx] = record;
  else sessions.push(record);
  writeRaw(sessions);
  return id;
}

function deleteSession(id) {
  const sessions = readRaw().filter((x) => x.id !== id);
  writeRaw(sessions);
}

module.exports = {
  listSessions,
  getSessionFull,
  saveSession,
  deleteSession,
  encryptionAvailable: canEncrypt
};
