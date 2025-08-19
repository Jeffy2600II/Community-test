// deviceService.js
// - เก็บ device metadata (deviceId, lastActivity)
// - ปรับปรุง lastActivity เมื่ออุปกรณ์มีการใช้งาน
// - revoke sessions ที่ผูกกับ device ที่ inactivity เกิน threshold
// - ต้องการโครงสร้าง sessions per-user ที่มี session.meta.deviceId

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const ROOT = path.join(__dirname); // public/server
const DATA_FILE = path.join(ROOT, 'devices.json');
// path to users dir (server.js ควรกำหนดค่าเดียวกันกับของ main server)
const USERS_DIR = path.join(__dirname, '..', '..', 'data', 'users');

// กำหนดเกณฑ์ inactivity (มิลลิวินาที) - default: 30 วัน
const INACTIVITY_TIMEOUT_MS = (process.env.DEVICE_INACTIVITY_DAYS ? Number(process.env.DEVICE_INACTIVITY_DAYS) : 30) * 24 * 60 * 60 * 1000;

// ความถี่ในการรัน cleaner (วัน) - default: 1 วัน
const CLEANER_INTERVAL_MS = (process.env.DEVICE_CLEANER_INTERVAL_HOURS ? Number(process.env.DEVICE_CLEANER_INTERVAL_HOURS) : 24) * 60 * 60 * 1000;

function ensureFile() {
  if (!fs.existsSync(ROOT)) fs.mkdirSync(ROOT, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({}, null, 2), 'utf8');
}
function readAll() {
  ensureFile();
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) { return {}; }
}
function writeAll(obj) {
  ensureFile();
  fs.writeFileSync(DATA_FILE, JSON.stringify(obj, null, 2), 'utf8');
}

// Create a device id cookie if not present (returns deviceId)
function ensureDeviceIdCookie(req, res) {
  // cookie name
  const cookieName = 'device_id';
  let deviceId = req.cookies && req.cookies[cookieName];
  if (!deviceId) {
    deviceId = uuidv4();
    // set long lived cookie (e.g., 1 year)
    const oneYear = 365 * 24 * 60 * 60 * 1000;
    res.cookie(cookieName, deviceId, { httpOnly: false, maxAge: oneYear, sameSite: 'Lax' });
  }
  // ensure device entry exists
  const all = readAll();
  if (!all[deviceId]) {
    all[deviceId] = { id: deviceId, createdAt: new Date().toISOString(), lastActivity: new Date().toISOString() };
    writeAll(all);
  }
  return deviceId;
}

// Update lastActivity timestamp for a device
function touchDevice(deviceId) {
  if (!deviceId) return false;
  const all = readAll();
  if (!all[deviceId]) {
    all[deviceId] = { id: deviceId, createdAt: new Date().toISOString(), lastActivity: new Date().toISOString() };
  } else {
    all[deviceId].lastActivity = new Date().toISOString();
  }
  writeAll(all);
  return true;
}

// Get lastActivity (Date object) or null
function getDeviceLastActivity(deviceId) {
  const all = readAll();
  if (!all[deviceId]) return null;
  return new Date(all[deviceId].lastActivity);
}

// Find all sessions (userId + sessionId) that reference this deviceId
// Assumes sessions stored per-user at data/users/{userId}/sessions.json
function findSessionsByDevice(deviceId) {
  const out = [];
  if (!fs.existsSync(USERS_DIR)) return out;
  const users = fs.readdirSync(USERS_DIR);
  for (let uid of users) {
    try {
      const sessionsPath = path.join(USERS_DIR, uid, 'sessions.json');
      if (!fs.existsSync(sessionsPath)) continue;
      const sessions = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
      for (let s of sessions) {
        if (s && s.meta && s.meta.deviceId && s.meta.deviceId === deviceId && !s.revoked) {
          out.push({ userId: uid, sessionId: s.id });
        }
      }
    } catch (e) { /* ignore parse errors */ }
  }
  return out;
}

// Revoke all sessions associated with a device
function revokeDeviceSessions(deviceId) {
  const found = findSessionsByDevice(deviceId);
  for (let f of found) {
    try {
      const sessionsPath = path.join(USERS_DIR, f.userId, 'sessions.json');
      const sessions = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
      let changed = false;
      for (let s of sessions) {
        if (s.id === f.sessionId && !s.revoked) {
          s.revoked = true;
          changed = true;
        }
      }
      if (changed) fs.writeFileSync(sessionsPath, JSON.stringify(sessions, null, 2), 'utf8');
    } catch (e) { /* ignore */ }
  }
  // mark device as revoked (optional)
  const all = readAll();
  if (all[deviceId]) {
    all[deviceId].revokedAt = new Date().toISOString();
    writeAll(all);
  }
  return found.length;
}

// Cleaner: revoke devices inactive > INACTIVITY_TIMEOUT_MS
function runCleanerOnce() {
  const all = readAll();
  const now = Date.now();
  const revokedDevices = [];
  for (let did of Object.keys(all)) {
    try {
      const last = new Date(all[did].lastActivity).getTime();
      if (isNaN(last)) continue;
      if ((now - last) > INACTIVITY_TIMEOUT_MS) {
        revokeDeviceSessions(did);
        revokedDevices.push(did);
      }
    } catch (e) { /* ignore */ }
  }
  return revokedDevices;
}

// start background cleaner timer
let cleanerInterval = null;
function startCleaner() {
  if (cleanerInterval) return;
  cleanerInterval = setInterval(() => {
    try {
      const revoked = runCleanerOnce();
      if (revoked && revoked.length) {
        console.log('[deviceService] revoked devices due to inactivity:', revoked.length);
      }
    } catch (e) {
      console.error('[deviceService] cleaner error', e && e.message);
    }
  }, CLEANER_INTERVAL_MS);
  // run once at startup
  try { const r = runCleanerOnce(); if (r.length) console.log('[deviceService] initial revoked:', r.length); } catch (e) {}
}

// Export API
module.exports = {
  ensureDeviceIdCookie,
  touchDevice,
  getDeviceLastActivity,
  findSessionsByDevice,
  revokeDeviceSessions,
  runCleanerOnce,
  startCleaner,
  INACTIVITY_TIMEOUT_MS
};