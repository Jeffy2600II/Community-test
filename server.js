// server.js (full, updated)
// Community app with:
// - Argon2id password hashing
// - Access JWT (short-lived) + refresh tokens (rotating) stored hashed server-side per-user
// - Device-based inactivity management via public/server/deviceService.js
// - Sessions per-user with meta (deviceId, ua, ip)
// - Follow/unfollow, posts, comments, notifications (file storage)
// - Secure cookie settings (HttpOnly, Secure when NODE_ENV=production), helmet, simple rate limiting
//
// Requirements:
// npm i express body-parser cookie-parser multer jsonwebtoken uuid crypto argon2 helmet express-rate-limit
//
// Environment variables recommended:
// - JWT_SECRET (required in production)
// - REFRESH_HMAC_KEY (required in production)
// - NODE_ENV=production when deploying with HTTPS

const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const argon2 = require('argon2');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const deviceService = require('./public/server/deviceService');

const app = express();
const PORT = process.env.PORT || 3000;

// Secrets - set via env in production
const SECRET = process.env.JWT_SECRET || "community_super_secret_2025"; // replace in prod
const REFRESH_TOKEN_HMAC_KEY = process.env.REFRESH_HMAC_KEY || "refresh_hmac_key_change_me";

const DATA_DIR = path.join(__dirname, 'data');
const USERS_DIR = path.join(DATA_DIR, 'users');
const POSTS_DIR = path.join(DATA_DIR, 'posts');
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
const PROFILE_PIC_DIR = path.join(UPLOADS_DIR, 'profile_pics');
const POST_IMG_DIR = path.join(UPLOADS_DIR, 'post_images');

[DATA_DIR, USERS_DIR, POSTS_DIR, UPLOADS_DIR, PROFILE_PIC_DIR, POST_IMG_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// security middleware
app.use(helmet());
app.use(express.static('public'));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(cookieParser());

// basic rate limiter for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 80,
  message: { success: false, msg: 'Too many requests, slow down' }
});

// multer for uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    if (file.fieldname === 'profilePic') cb(null, PROFILE_PIC_DIR);
    else cb(null, POST_IMG_DIR);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname);
    cb(null, uuidv4() + ext);
  }
});
const upload = multer({ storage });

// ---------- helpers ----------
function findUserByUsername(usernameRaw) {
  const username = decodeURIComponent(usernameRaw);
  if (!fs.existsSync(USERS_DIR)) return null;
  const userDirs = fs.readdirSync(USERS_DIR);
  for (let userId of userDirs) {
    const profilePath = path.join(USERS_DIR, userId, 'profile.json');
    if (fs.existsSync(profilePath)) {
      try {
        const user = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
        if (user.username === username) {
          return { ...user, _userId: userId };
        }
      } catch {}
    }
  }
  return null;
}
function findUserByEmail(email) {
  if (!fs.existsSync(USERS_DIR)) return null;
  const userDirs = fs.readdirSync(USERS_DIR);
  for (let userId of userDirs) {
    const profilePath = path.join(USERS_DIR, userId, 'profile.json');
    if (fs.existsSync(profilePath)) {
      try {
        const user = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
        if (user.email === email) return { ...user, _userId: userId };
      } catch {}
    }
  }
  return null;
}
function getUserDir(userId) { return path.join(USERS_DIR, userId); }
function getUserProfilePath(userId) { return path.join(USERS_DIR, userId, 'profile.json'); }
function getUserSessionsPath(userId) { return path.join(USERS_DIR, userId, 'sessions.json'); }
function ensureUserSessionsFile(userId) {
  const p = getUserSessionsPath(userId);
  if (!fs.existsSync(p)) fs.writeFileSync(p, '[]', 'utf8');
  return p;
}
function readUserSessions(userId) {
  ensureUserSessionsFile(userId);
  try { return JSON.parse(fs.readFileSync(getUserSessionsPath(userId), 'utf8')); } catch { return []; }
}
function writeUserSessions(userId, arr) {
  fs.writeFileSync(getUserSessionsPath(userId), JSON.stringify(arr, null, 2), 'utf8');
}
function getFollowersPath(userId) { return path.join(getUserDir(userId), 'followers.json'); }
function getFollowingPath(userId) { return path.join(getUserDir(userId), 'following.json'); }
function getPostDir(postId) { return path.join(POSTS_DIR, postId); }
function getPostPath(postId) { return path.join(POSTS_DIR, postId, 'post.json'); }
function getPostCommentsPath(postId) { return path.join(POSTS_DIR, postId, 'comments.json'); }

// Token utilities
function generateRandomTokenBytes(n = 48) {
  return crypto.randomBytes(n).toString('hex');
}
function hashRefreshToken(token) {
  return crypto.createHmac('sha256', REFRESH_TOKEN_HMAC_KEY).update(token).digest('hex');
}
function signAccessToken(payload, opts = {}) {
  const signOptions = { expiresIn: opts.expiresIn || '15m' };
  return jwt.sign(payload, SECRET, signOptions);
}
function verifyAccessToken(token) {
  try {
    return jwt.verify(token, SECRET);
  } catch {
    return null;
  }
}

// ---------- session management ----------
function createSession(userId, meta = {}) {
  const sessions = readUserSessions(userId);
  const rawToken = generateRandomTokenBytes(48);
  const tokenHash = hashRefreshToken(rawToken);
  const sessionId = uuidv4();
  const now = new Date().toISOString();
  const session = {
    id: sessionId,
    tokenHash,
    createdAt: now,
    lastUsedAt: now,
    expiresAt: null, // no fixed expiry; device inactivity and manual revoke manage lifecycle
    revoked: false,
    meta
  };
  sessions.push(session);
  writeUserSessions(userId, sessions);
  return { rawToken, sessionId };
}

function rotateRefreshToken(userId, incomingRawToken) {
  const sessions = readUserSessions(userId);
  const incomingHash = hashRefreshToken(incomingRawToken);
  for (let s of sessions) {
    if (s.tokenHash === incomingHash && !s.revoked) {
      if (s.expiresAt && new Date(s.expiresAt) < new Date()) return null;
      const newRaw = generateRandomTokenBytes(48);
      s.tokenHash = hashRefreshToken(newRaw);
      s.lastUsedAt = new Date().toISOString();
      writeUserSessions(userId, sessions);
      return newRaw;
    }
  }
  return null;
}

function revokeSessionByToken(rawToken) {
  const incomingHash = hashRefreshToken(rawToken);
  const users = fs.existsSync(USERS_DIR) ? fs.readdirSync(USERS_DIR) : [];
  for (let uid of users) {
    const sessionsPath = getUserSessionsPath(uid);
    if (!fs.existsSync(sessionsPath)) continue;
    const sessions = readUserSessions(uid);
    let changed = false;
    for (let s of sessions) {
      if (s.tokenHash === incomingHash && !s.revoked) { s.revoked = true; changed = true; }
    }
    if (changed) writeUserSessions(uid, sessions);
  }
}
function revokeSessionById(userId, sessionId) {
  const sessions = readUserSessions(userId);
  let changed = false;
  for (let s of sessions) {
    if (s.id === sessionId && !s.revoked) { s.revoked = true; changed = true; }
  }
  if (changed) writeUserSessions(userId, sessions);
  return changed;
}
function revokeSessionsByDevice(deviceId) {
  // uses deviceService.findSessionsByDevice which returns array of {userId, sessionId}
  const list = deviceService.findSessionsByDevice(deviceId);
  for (let f of list) {
    revokeSessionById(f.userId, f.sessionId);
  }
  return list.length;
}

// ---------- notifications helpers ----------
function ensureUserNotificationsFile(userId) {
  const p = path.join(getUserDir(userId), 'notifications.json');
  if (!fs.existsSync(p)) fs.writeFileSync(p, '[]', 'utf8');
  return p;
}
function addNotificationToUser(userId, type, message, meta = {}) {
  try {
    let recipientUsername = null;
    const profilePath = getUserProfilePath(userId);
    if (fs.existsSync(profilePath)) {
      try { recipientUsername = JSON.parse(fs.readFileSync(profilePath, 'utf8')).username; } catch {}
    }
    if (meta) {
      if (meta.actorId && String(meta.actorId) === String(userId)) return null;
      if (meta.actorUsername && recipientUsername && String(meta.actorUsername) === String(recipientUsername)) return null;
    }
    const p = ensureUserNotificationsFile(userId);
    const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
    const n = { id: uuidv4(), type, message, meta, createdAt: new Date().toISOString(), read: false };
    arr.unshift(n);
    fs.writeFileSync(p, JSON.stringify(arr, null, 2), 'utf8');
    return n;
  } catch (err) {
    console.error('addNotificationToUser error', err && err.message);
    return null;
  }
}
function getNotificationsForUser(userId) {
  const p = ensureUserNotificationsFile(userId);
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return []; }
}
function markNotificationsRead(userId, ids = []) {
  const p = ensureUserNotificationsFile(userId);
  let arr = JSON.parse(fs.readFileSync(p, 'utf8'));
  let changed = false;
  if (!Array.isArray(ids) || ids.length === 0) {
    arr = arr.map(n => ({ ...n, read: true })); changed = true;
  } else {
    arr = arr.map(n => { if (ids.includes(n.id) && !n.read) { changed = true; return { ...n, read: true }; } return n; });
  }
  if (changed) fs.writeFileSync(p, JSON.stringify(arr, null, 2), 'utf8');
  return arr;
}

// ---------- auth middleware ----------
function apiAuthMiddleware(req, res, next) {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ success: false, msg: 'Not authenticated' });
  const payload = verifyAccessToken(token);
  if (!payload) return res.status(401).json({ success: false, msg: 'Token invalid or expired' });
  req.user = payload;

  // touch device lastActivity if device cookie present
  try {
    const deviceId = req.cookies && req.cookies['device_id'];
    if (deviceId) deviceService.touchDevice(deviceId);
  } catch (e) {}

  next();
}

// ---------- HTML routes ----------
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'views/index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'views/login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'views/register.html')));
app.get('/profile', (req, res) => {
  // profile page expects server to redirect if not authenticated (client will call /api/profile)
  res.sendFile(path.join(__dirname, 'views/profile.html'));
});
app.get('/profile/edit', (req, res) => res.sendFile(path.join(__dirname, 'views/edit_profile.html')));
app.get('/user/:username', (req, res) => res.sendFile(path.join(__dirname, 'views/user_profile.html')));
app.get('/accounts', (req, res) => res.sendFile(path.join(__dirname, 'views/accounts.html')));
app.get('/post/create', (req, res) => res.sendFile(path.join(__dirname, 'views/create_post.html')));
app.get('/post/:id/edit', (req, res) => res.sendFile(path.join(__dirname, 'views/edit_post.html')));
app.get('/post/:id', (req, res) => res.sendFile(path.join(__dirname, 'views/post.html')));

// ---------- API: auth & sessions ----------
app.post('/api/register', authLimiter, async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) return res.json({ success: false, msg: 'Missing fields' });
  if (findUserByUsername(username)) return res.json({ success: false, msg: 'Username exists' });
  if (findUserByEmail(email)) return res.json({ success: false, msg: 'Email exists' });

  const userId = uuidv4();
  const userDir = getUserDir(userId);
  fs.mkdirSync(userDir, { recursive: true });

  const hashed = await argon2.hash(password, { type: argon2.argon2id });

  const profile = {
    id: userId,
    username, email,
    displayName: username,
    profilePic: '',
    password: hashed,
    createdAt: new Date().toISOString(),
    showEmail: false,
    bio: ''
  };
  fs.writeFileSync(getUserProfilePath(userId), JSON.stringify(profile, null, 2), 'utf8');
  fs.writeFileSync(path.join(userDir, 'posts.json'), '[]', 'utf8');
  fs.writeFileSync(path.join(userDir, 'comments.json'), '[]', 'utf8');
  fs.writeFileSync(path.join(userDir, 'notifications.json'), '[]', 'utf8');
  fs.writeFileSync(getUserSessionsPath(userId), '[]', 'utf8');
  fs.writeFileSync(getFollowersPath(userId), '[]', 'utf8');
  fs.writeFileSync(getFollowingPath(userId), '[]', 'utf8');

  res.json({ success: true });
});

app.post('/api/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.json({ success: false, msg: 'Missing credentials' });
  const userObj = findUserByEmail(email);
  if (!userObj) return res.json({ success: false, msg: 'Invalid credentials' });

  try {
    const ok = await argon2.verify(userObj.password, password);
    if (!ok) return res.json({ success: false, msg: 'Invalid credentials' });
  } catch {
    return res.json({ success: false, msg: 'Invalid credentials' });
  }

  // ensure device_id cookie and capture deviceId
  const deviceId = deviceService.ensureDeviceIdCookie(req, res);

  // create session with meta including deviceId
  const meta = { ip: req.ip, ua: req.get('User-Agent') || '', deviceId, createdFrom: 'web' };
  const { rawToken } = createSession(userObj.id, meta);

  // access token (short-lived)
  const accessPayload = { id: userObj.id, username: userObj.username };
  const accessToken = signAccessToken(accessPayload, { expiresIn: '15m' });

  // cookie options
  const secureCookies = process.env.NODE_ENV === 'production';
  // set access token cookie
  res.cookie('token', accessToken, { httpOnly: true, secure: secureCookies, sameSite: 'Strict', maxAge: 15 * 60 * 1000 });
  // set refresh cookie (long-lived but will be rotated); choose long but finite expiry (e.g., 180 days)
  res.cookie('refresh', rawToken, { httpOnly: true, secure: secureCookies, sameSite: 'Strict', maxAge: 180 * 24 * 60 * 60 * 1000 });

  // Add to accounts cookie (client-visible minimal JWT for account switching) but do not store sensitive tokens there
  try {
    const tokenForAccounts = jwt.sign({ id: userObj.id, email: userObj.email, username: userObj.username }, SECRET, { expiresIn: '365d' });
    const existing = req.cookies.accounts ? JSON.parse(req.cookies.accounts) : [];
    const arr = Array.isArray(existing) ? existing : [];
    if (!arr.some(t => { try { return jwt.verify(t, SECRET).username === userObj.username; } catch { return false; } })) {
      arr.push(tokenForAccounts);
    }
    res.cookie('accounts', JSON.stringify(arr), { httpOnly: false });
  } catch {}

  res.json({ success: true });
});

// Refresh endpoint: rotates refresh token and issues new access token
app.post('/api/token/refresh', async (req, res) => {
  const rawRefresh = req.cookies.refresh;
  if (!rawRefresh) return res.status(401).json({ success: false, msg: 'No refresh token' });

  // scan users for matching refresh token hash
  const userDirs = fs.existsSync(USERS_DIR) ? fs.readdirSync(USERS_DIR) : [];
  for (let uid of userDirs) {
    const sessionsPath = getUserSessionsPath(uid);
    if (!fs.existsSync(sessionsPath)) continue;
    const sessions = readUserSessions(uid);
    const incomingHash = hashRefreshToken(rawRefresh);
    const s = sessions.find(x => x.tokenHash === incomingHash && !x.revoked);
    if (!s) continue;
    if (s.expiresAt && new Date(s.expiresAt) < new Date()) return res.status(401).json({ success: false, msg: 'Refresh expired' });

    // rotate
    const newRaw = rotateRefreshToken(uid, rawRefresh);
    if (!newRaw) return res.status(401).json({ success: false, msg: 'Invalid refresh token' });

    // issue new access token
    const profile = JSON.parse(fs.readFileSync(getUserProfilePath(uid), 'utf8'));
    const newAccess = signAccessToken({ id: profile.id, username: profile.username }, { expiresIn: '15m' });

    const secureCookies = process.env.NODE_ENV === 'production';
    res.cookie('token', newAccess, { httpOnly: true, secure: secureCookies, sameSite: 'Strict', maxAge: 15 * 60 * 1000 });
    res.cookie('refresh', newRaw, { httpOnly: true, secure: secureCookies, sameSite: 'Strict', maxAge: 180 * 24 * 60 * 60 * 1000 });

    // touch device if metadata exists
    try { if (s.meta && s.meta.deviceId) deviceService.touchDevice(s.meta.deviceId); } catch (e) {}

    return res.json({ success: true });
  }
  return res.status(401).json({ success: false, msg: 'Refresh token invalid' });
});

// Logout current refresh session
app.post('/api/logout', (req, res) => {
  const rawRefresh = req.cookies.refresh;
  if (rawRefresh) revokeSessionByToken(rawRefresh);
  res.clearCookie('token'); res.clearCookie('refresh');
  res.json({ success: true });
});

// Logout-all (revoke all of user's sessions) - requires auth
app.post('/api/logout-all', apiAuthMiddleware, (req, res) => {
  const userId = req.user.id;
  const sessions = readUserSessions(userId);
  sessions.forEach(s => s.revoked = true);
  writeUserSessions(userId, sessions);
  res.clearCookie('token'); res.clearCookie('refresh');
  res.json({ success: true });
});

// ---------- API: profile & public profile ----------
app.get('/api/profile', apiAuthMiddleware, (req, res) => {
  const userId = req.user.id;
  const profileRaw = JSON.parse(fs.readFileSync(getUserProfilePath(userId), 'utf8'));
  const profile = { ...profileRaw };
  delete profile.password;
  if (typeof profile.showEmail === 'undefined') profile.showEmail = false;
  const followers = fs.existsSync(getFollowersPath(userId)) ? JSON.parse(fs.readFileSync(getFollowersPath(userId), 'utf8')) : [];
  const following = fs.existsSync(getFollowingPath(userId)) ? JSON.parse(fs.readFileSync(getFollowingPath(userId), 'utf8')) : [];
  res.json({ success: true, profile, followersCount: followers.length, followingCount: following.length });
});

// Public profile: email only if showEmail true
app.get('/api/user/:username', (req, res) => {
  const user = findUserByUsername(req.params.username);
  if (!user) return res.json({ success: false, msg: 'ไม่พบผู้ใช้' });
  if (typeof user.showEmail === 'undefined') user.showEmail = false;
  const followers = fs.existsSync(getFollowersPath(user._userId)) ? JSON.parse(fs.readFileSync(getFollowersPath(user._userId), 'utf8')) : [];
  const following = fs.existsSync(getFollowingPath(user._userId)) ? JSON.parse(fs.readFileSync(getFollowingPath(user._userId), 'utf8')) : [];

  let myUsername = null, myUserId = null;
  const token = req.cookies.token;
  if (token) {
    const p = verifyAccessToken(token);
    if (p) { myUsername = p.username; myUserId = p.id; }
  }
  const isFollowingFlag = myUserId ? (fs.existsSync(getFollowingPath(myUserId)) && JSON.parse(fs.readFileSync(getFollowingPath(myUserId), 'utf8')).includes(user._userId)) : false;

  const publicProfile = {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    profilePic: user.profilePic || '',
    createdAt: user.createdAt,
    showEmail: !!user.showEmail
  };
  if (user.showEmail) publicProfile.email = user.email;

  res.json({ success: true, profile: publicProfile, followersCount: followers.length, followingCount: following.length, isFollowing: isFollowingFlag, myUsername });
});

// Update profile (owner)
app.post('/api/profile/update', apiAuthMiddleware, (req, res) => {
  const userId = req.user.id;
  const profilePath = getUserProfilePath(userId);
  if (!fs.existsSync(profilePath)) return res.json({ success: false, msg: 'Profile not found' });
  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  const { displayName, email, showEmail, bio } = req.body;
  if (displayName) profile.displayName = displayName;
  if (typeof email !== 'undefined') profile.email = email;
  if (typeof showEmail !== 'undefined') profile.showEmail = showEmail === true || showEmail === 'true';
  if (typeof bio !== 'undefined') profile.bio = bio;
  fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2), 'utf8');
  res.json({ success: true });
});

// Upload/remove profile pic
app.post('/api/profile/upload-pic', apiAuthMiddleware, upload.single('profilePic'), (req, res) => {
  const userId = req.user.id;
  const profilePath = getUserProfilePath(userId);
  if (!fs.existsSync(profilePath)) return res.json({ success: false, msg: 'Profile not found' });
  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  if (req.file) {
    profile.profilePic = '/uploads/profile_pics/' + req.file.filename;
    fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2), 'utf8');
    return res.json({ success: true });
  }
  res.json({ success: false, msg: 'No file' });
});
app.post('/api/profile/remove-pic', apiAuthMiddleware, (req, res) => {
  const userId = req.user.id;
  const profilePath = getUserProfilePath(userId);
  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  profile.profilePic = '';
  fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2), 'utf8');
  res.json({ success: true });
});

// ---------- API: follow/unfollow ----------
function ensureJsonFile(p, initial = '[]') { if (!fs.existsSync(p)) fs.writeFileSync(p, initial, 'utf8'); return p; }
function getFollowersForUser(userId) { const p = getFollowersPath(userId); ensureJsonFile(p); try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return []; } }
function getFollowingForUser(userId) { const p = getFollowingPath(userId); ensureJsonFile(p); try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return []; } }

app.post('/api/user/:username/follow', apiAuthMiddleware, (req, res) => {
  const target = findUserByUsername(req.params.username);
  if (!target) return res.json({ success: false, msg: 'Target not found' });
  const actorId = req.user.id;
  if (actorId === target._userId) return res.json({ success: false, msg: 'Cannot follow yourself' });

  // add follower
  const fPath = ensureJsonFile(getFollowersPath(target._userId));
  let followers = JSON.parse(fs.readFileSync(fPath, 'utf8'));
  if (!followers.includes(actorId)) { followers.push(actorId); fs.writeFileSync(fPath, JSON.stringify(followers, null, 2), 'utf8'); }
  const folPath = ensureJsonFile(getFollowingPath(actorId));
  let following = JSON.parse(fs.readFileSync(folPath, 'utf8'));
  if (!following.includes(target._userId)) { following.push(target._userId); fs.writeFileSync(folPath, JSON.stringify(following, null, 2), 'utf8'); }

  addNotificationToUser(target._userId, 'new_follower', `${req.user.username} ติดตามคุณ`, { actorId, actorUsername: req.user.username });

  res.json({ success: true, followersCount: followers.length });
});
app.post('/api/user/:username/unfollow', apiAuthMiddleware, (req, res) => {
  const target = findUserByUsername(req.params.username);
  if (!target) return res.json({ success: false, msg: 'Target not found' });
  const actorId = req.user.id;
  const fPath = ensureJsonFile(getFollowersPath(target._userId));
  let followers = JSON.parse(fs.readFileSync(fPath, 'utf8'));
  followers = followers.filter(id => id !== actorId);
  fs.writeFileSync(fPath, JSON.stringify(followers, null, 2), 'utf8');

  const folPath = ensureJsonFile(getFollowingPath(actorId));
  let following = JSON.parse(fs.readFileSync(folPath, 'utf8'));
  following = following.filter(id => id !== target._userId);
  fs.writeFileSync(folPath, JSON.stringify(following, null, 2), 'utf8');

  res.json({ success: true, followersCount: followers.length });
});

app.get('/api/user/:username/followers', (req, res) => {
  const user = findUserByUsername(req.params.username);
  if (!user) return res.json({ success: false, msg: 'User not found' });
  const followers = getFollowersForUser(user._userId) || [];
  const out = followers.map(uid => {
    const p = JSON.parse(fs.readFileSync(getUserProfilePath(uid), 'utf8'));
    delete p.password;
    return { id: uid, username: p.username, displayName: p.displayName, profilePic: p.profilePic || '' };
  });
  res.json({ success: true, followers: out });
});
app.get('/api/user/:username/following', (req, res) => {
  const user = findUserByUsername(req.params.username);
  if (!user) return res.json({ success: false, msg: 'User not found' });
  const following = getFollowingForUser(user._userId) || [];
  const out = following.map(uid => {
    const p = JSON.parse(fs.readFileSync(getUserProfilePath(uid), 'utf8'));
    delete p.password;
    return { id: uid, username: p.username, displayName: p.displayName, profilePic: p.profilePic || '' };
  });
  res.json({ success: true, following: out });
});

// ---------- API: notifications ----------
app.get('/api/notifications', apiAuthMiddleware, (req, res) => {
  const userId = req.user.id;
  const nots = getNotificationsForUser(userId);
  const unread = nots.filter(n => !n.read).length;
  res.json({ success: true, notifications: nots, unread });
});
app.post('/api/notifications/mark-read', apiAuthMiddleware, (req, res) => {
  const userId = req.user.id;
  const { ids } = req.body;
  const updated = markNotificationsRead(userId, ids || []);
  res.json({ success: true, notifications: updated, unread: updated.filter(n => !n.read).length });
});

// ---------- API: posts & comments ----------
app.post('/api/post/create', apiAuthMiddleware, upload.single('postImage'), (req, res) => {
  const userId = req.user.id;
  const username = req.user.username;
  const { title, content } = req.body;
  if (!title || !content) return res.json({ success: false, msg: 'Missing fields' });
  const postId = uuidv4();
  const postDir = getPostDir(postId);
  fs.mkdirSync(postDir, { recursive: true });
  let img = '';
  if (req.file) img = '/uploads/post_images/' + req.file.filename;
  const post = { id: postId, username, title, content, image: img, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  fs.writeFileSync(getPostPath(postId), JSON.stringify(post, null, 2), 'utf8');
  fs.writeFileSync(getPostCommentsPath(postId), '[]', 'utf8');
  // update user's posts
  const userPostsPath = path.join(getUserDir(userId), 'posts.json');
  let userPosts = fs.existsSync(userPostsPath) ? JSON.parse(fs.readFileSync(userPostsPath, 'utf8')) : [];
  userPosts.unshift(postId);
  fs.writeFileSync(userPostsPath, JSON.stringify(userPosts, null, 2), 'utf8');

  // notify followers
  try {
    const followers = getFollowersForUser(userId) || [];
    for (let fid of followers) {
      addNotificationToUser(fid, 'new_post', `${username} โพสต์ใหม่: "${title}"`, { postId, actorId: userId, actorUsername: username });
    }
  } catch (e) { console.error('notify followers error', e && e.message); }

  res.json({ success: true, postId });
});

app.post('/api/post/:id/comment', apiAuthMiddleware, (req, res) => {
  const postId = req.params.id;
  const username = req.user.username;
  const { content } = req.body;
  if (!content) return res.json({ success: false, msg: 'Empty comment' });
  const comment = { id: uuidv4(), postId, username, content, createdAt: new Date().toISOString() };
  const commentsPath = getPostCommentsPath(postId);
  let comments = fs.existsSync(commentsPath) ? JSON.parse(fs.readFileSync(commentsPath, 'utf8')) : [];
  comments.push(comment);
  fs.writeFileSync(commentsPath, JSON.stringify(comments, null, 2), 'utf8');

  // update user's comment list
  const userObj = findUserByUsername(username);
  if (userObj) {
    const userCommentsPath = path.join(getUserDir(userObj._userId), 'comments.json');
    let userComments = fs.existsSync(userCommentsPath) ? JSON.parse(fs.readFileSync(userCommentsPath, 'utf8')) : [];
    userComments.push(comment.id);
    fs.writeFileSync(userCommentsPath, JSON.stringify(userComments, null, 2), 'utf8');
  }

  // notify post owner
  try {
    if (fs.existsSync(getPostPath(postId))) {
      const post = JSON.parse(fs.readFileSync(getPostPath(postId), 'utf8'));
      if (post && post.username && post.username !== username) {
        const ownerObj = findUserByUsername(post.username);
        if (ownerObj) addNotificationToUser(ownerObj._userId, 'comment', `${username} แสดงความคิดเห็นในโพสต์ของคุณ`, { postId, commentId: comment.id, actorId: userObj && userObj._userId, actorUsername: username });
      }
    }
  } catch (e) {}

  res.json({ success: true });
});

// get posts listing
app.get('/api/posts', (req, res) => {
  if (!fs.existsSync(POSTS_DIR)) return res.json({ success: true, posts: [] });
  const postDirs = fs.readdirSync(POSTS_DIR);
  let posts = [];
  for (let pid of postDirs) {
    const ppath = getPostPath(pid);
    if (fs.existsSync(ppath)) posts.push(JSON.parse(fs.readFileSync(ppath, 'utf8')));
  }
  posts.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ success: true, posts });
});
app.get('/api/post/:id', (req, res) => {
  const postId = req.params.id;
  const postPath = getPostPath(postId);
  if (!fs.existsSync(postPath)) return res.json({ success: false, msg: 'Not found' });
  const post = JSON.parse(fs.readFileSync(postPath, 'utf8'));
  const comments = fs.existsSync(getPostCommentsPath(postId)) ? JSON.parse(fs.readFileSync(getPostCommentsPath(postId), 'utf8')) : [];
  res.json({ success: true, post, comments });
});
app.get('/api/user/:username/posts', (req, res) => {
  const user = findUserByUsername(req.params.username);
  if (!user) return res.json({ success: false, posts: [] });
  const userPostsPath = path.join(getUserDir(user._userId), 'posts.json');
  let posts = [];
  if (fs.existsSync(userPostsPath)) {
    const postIds = JSON.parse(fs.readFileSync(userPostsPath, 'utf8'));
    for (let pid of postIds) { if (fs.existsSync(getPostPath(pid))) posts.push(JSON.parse(fs.readFileSync(getPostPath(pid), 'utf8'))); }
  }
  posts.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ success: true, posts });
});

// ---------- Session & device endpoints for user ----------
app.get('/api/sessions', apiAuthMiddleware, (req, res) => {
  const userId = req.user.id;
  const sessions = readUserSessions(userId);
  // redact tokenHash
  const out = sessions.map(s => ({ id: s.id, createdAt: s.createdAt, lastUsedAt: s.lastUsedAt, revoked: s.revoked, meta: s.meta }));
  res.json({ success: true, sessions: out });
});
app.post('/api/sessions/revoke/:sessionId', apiAuthMiddleware, (req, res) => {
  const userId = req.user.id;
  const sid = req.params.sessionId;
  const ok = revokeSessionById(userId, sid);
  res.json({ success: ok });
});
app.post('/api/sessions/revoke-device/:deviceId', apiAuthMiddleware, (req, res) => {
  const deviceId = req.params.deviceId;
  // only allow user to revoke sessions tied to this device if any belong to them
  const found = deviceService.findSessionsByDevice(deviceId);
  const myUserId = req.user.id;
  const mine = found.filter(f => f.userId === myUserId);
  if (mine.length === 0) return res.json({ success: false, msg: 'No sessions for your account on this device' });
  // revoke all sessions for that device (including other accounts on that device)
  const count = revokeSessionsByDevice(deviceId);
  // mark device revoked in devices.json too
  deviceService.revokeDeviceSessions(deviceId);
  res.json({ success: true, revokedSessions: count });
});
app.get('/api/sessions/devices', apiAuthMiddleware, (req, res) => {
  // return devices that have sessions for this user
  const devicesFile = path.join(__dirname, 'public', 'server', 'devices.json');
  let devices = {};
  if (fs.existsSync(devicesFile)) devices = JSON.parse(fs.readFileSync(devicesFile, 'utf8'));
  const myUserId = req.user.id;
  const deviceList = [];
  for (let did of Object.keys(devices)) {
    const assoc = deviceService.findSessionsByDevice(did);
    if (assoc.some(a => a.userId === myUserId)) deviceList.push(devices[did]);
  }
  res.json({ success: true, devices: deviceList });
});

// ---------- startup: start device cleaner ----------
deviceService.startCleaner();

// ---------- 404 ----------
app.use((req, res) => { res.status(404).send('Not found'); });

// ---------- start ----------
app.listen(PORT, () => {
  console.log(`Community app running at http://localhost:${PORT}`);
});