// deviceManager.js
// Manage device-linked sessions and inactivity-based revocation.
// Stored under data/devices/{deviceId}.json
// API:
// - ensureDevice(deviceId) -> device object
// - createDevice() -> deviceId (uuid)
// - linkSession(deviceId, userId, sessionId)
// - unlinkSession(deviceId, userId, sessionId)
// - recordActivity(deviceId) -> updates lastActivity timestamp
// - isInactive(deviceId, thresholdMs) -> boolean
// - revokeDevice(deviceId) -> revokes all linked sessions (marks revoked=true in each user's sessions.json)
// - getLinkedSessions(deviceId) -> [{ userId, sessionId }]
//
// Note: This is a synchronous, file-IO simple implementation to match the rest of the codebase.
// In production consider moving devices and sessions into a proper DB.

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const ROOT = path.join(__dirname, '..', '..', 'data'); // assumes public/server relative to repo root
const DEVICES_DIR = path.join(ROOT, 'devices');

if (!fs.existsSync(DEVICES_DIR)) fs.mkdirSync(DEVICES_DIR, { recursive: true });

function devicePath(deviceId) {
  return path.join(DEVICES_DIR, deviceId + '.json');
}

function ensureDevice(deviceId) {
  const p = devicePath(deviceId);
  if (!fs.existsSync(p)) {
    const now = new Date().toISOString();
    const device = {
      id: deviceId,
      createdAt: now,
      lastActivity: now,
      // array of { userId, sessionId }
      sessions: []
    };
    fs.writeFileSync(p, JSON.stringify(device, null, 2), 'utf8');
    return device;
  }
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    // if corrupted, recreate
    const now = new Date().toISOString();
    const device = {
      id: deviceId,
      createdAt: now,
      lastActivity: now,
      sessions: []
    };
    fs.writeFileSync(p, JSON.stringify(device, null, 2), 'utf8');
    return device;
  }
}

function createDevice() {
  const id = uuidv4();
  ensureDevice(id);
  return id;
}

function saveDevice(device) {
  fs.writeFileSync(devicePath(device.id), JSON.stringify(device, null, 2), 'utf8');
}

function linkSession(deviceId, userId, sessionId) {
  if (!deviceId) return;
  const device = ensureDevice(deviceId);
  const exists = device.sessions.find(s => s.userId === userId && s.sessionId === sessionId);
  if (!exists) {
    device.sessions.push({ userId, sessionId });
  }
  device.lastActivity = new Date().toISOString();
  saveDevice(device);
}

function unlinkSession(deviceId, userId, sessionId) {
  if (!deviceId) return;
  const p = devicePath(deviceId);
  if (!fs.existsSync(p)) return;
  const device = JSON.parse(fs.readFileSync(p, 'utf8'));
  device.sessions = device.sessions.filter(s => !(s.userId === userId && s.sessionId === sessionId));
  device.lastActivity = new Date().toISOString();
  saveDevice(device);
}

function recordActivity(deviceId) {
  if (!deviceId) return;
  const device = ensureDevice(deviceId);
  device.lastActivity = new Date().toISOString();
  saveDevice(device);
}

function getLinkedSessions(deviceId) {
  if (!deviceId) return [];
  const p = devicePath(deviceId);
  if (!fs.existsSync(p)) return [];
  const device = JSON.parse(fs.readFileSync(p, 'utf8'));
  return device.sessions || [];
}

function isInactive(deviceId, thresholdMs) {
  if (!deviceId) return false;
  const p = devicePath(deviceId);
  if (!fs.existsSync(p)) return false;
  const device = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!device.lastActivity) return false;
  const last = new Date(device.lastActivity).getTime();
  return (Date.now() - last) > thresholdMs;
}

/**
 * Revoke all sessions linked to this device.
 * This function will look up users' sessions.json files and mark matching session ids revoked = true.
 * Returns array of { userId, sessionId, revoked: true|false }
 */
function revokeDevice(deviceId) {
  if (!deviceId) return [];
  const linked = getLinkedSessions(deviceId);
  const results = [];
  for (const { userId, sessionId } of linked) {
    const userSessionsPath = path.join(ROOT, 'users', userId, 'sessions.json');
    if (!fs.existsSync(userSessionsPath)) {
      results.push({ userId, sessionId, revoked: false, reason: 'no sessions file' });
      continue;
    }
    const sessions = JSON.parse(fs.readFileSync(userSessionsPath, 'utf8'));
    let changed = false;
    for (let s of sessions) {
      if (s.id === sessionId && !s.revoked) {
        s.revoked = true;
        changed = true;
      }
    }
    if (changed) fs.writeFileSync(userSessionsPath, JSON.stringify(sessions, null, 2), 'utf8');
    results.push({ userId, sessionId, revoked: changed });
  }
  // After revocation, clear device sessions list
  const p = devicePath(deviceId);
  if (fs.existsSync(p)) {
    const device = JSON.parse(fs.readFileSync(p, 'utf8'));
    device.sessions = [];
    device.lastActivity = new Date().toISOString();
    saveDevice(device);
  }
  return results;
}

module.exports = {
  ensureDevice,
  createDevice,
  linkSession,
  unlinkSession,
  recordActivity,
  getLinkedSessions,
  isInactive,
  revokeDevice
};