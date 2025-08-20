// server.js (full) - stores profile originals + cropped, post images per-post, sliding sessions
// Requires: npm install express body-parser cookie-parser multer sharp jsonwebtoken uuid

const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const sharp = require('sharp');

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET = "community_super_secret_2025";
const SESSION_DAYS = 30;
const SESSION_MAX_AGE = SESSION_DAYS * 24 * 60 * 60 * 1000;

const DATA_DIR = path.join(__dirname, 'data');
const USERS_DIR = path.join(DATA_DIR, 'users');
const POSTS_DIR = path.join(DATA_DIR, 'posts');

[DATA_DIR, USERS_DIR, POSTS_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

app.use(express.static('public'));
// serve data (user/post images) so frontend can request /data/...
app.use('/data', express.static(path.join(__dirname, 'data')));

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(cookieParser());

// multer in-memory storage so we can process images with sharp before writing
const uploadMemory = multer({ storage: multer.memoryStorage() });

/* ------------------------
   Helpers
   ------------------------ */
function getUserDir(userId) { return path.join(USERS_DIR, userId); }
function getUserProfilePath(userId) { return path.join(getUserDir(userId), 'profile.json'); }
function getFollowersPath(userId) { return path.join(getUserDir(userId), 'followers.json'); }
function getFollowingPath(userId) { return path.join(getUserDir(userId), 'following.json'); }
function getUserProfilePicDir(userId) {
  const dir = path.join(getUserDir(userId), 'profile_pic');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function getUserProfilePicOriginalPath(userId) {
  return path.join(getUserProfilePicDir(userId), 'original.jpg');
}
function getUserProfilePicCroppedPath(userId) {
  return path.join(getUserProfilePicDir(userId), 'avatar.jpg');
}
function removeAllProfilePics(userId) {
  const dir = getUserProfilePicDir(userId);
  if (fs.existsSync(dir)) {
    const files = fs.readdirSync(dir);
    for (const f of files) {
      try { fs.unlinkSync(path.join(dir, f)); } catch (e) { /* ignore */ }
    }
  }
}
function getPostDir(postId) { return path.join(POSTS_DIR, postId); }
function getPostPath(postId) { return path.join(getPostDir(postId), 'post.json'); }
function getPostCommentsPath(postId) { return path.join(getPostDir(postId), 'comments.json'); }
function getPostImagesDir(postId) {
  const dir = path.join(getPostDir(postId), 'images');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/* Search helpers */
function findUserByUsername(usernameRaw) {
  const username = decodeURIComponent(usernameRaw);
  if (!fs.existsSync(USERS_DIR)) return null;
  const userDirs = fs.readdirSync(USERS_DIR);
  for (let userId of userDirs) {
    const profilePath = getUserProfilePath(userId);
    if (!fs.existsSync(profilePath)) continue;
    try {
      const u = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
      if (u.username === username) {
        const safe = { ...u };
        delete safe.password;
        return { ...safe, _userId: userId };
      }
    } catch { /* ignore parse errors */ }
  }
  return null;
}
function findUserByEmail(email) {
  if (!fs.existsSync(USERS_DIR)) return null;
  const userDirs = fs.readdirSync(USERS_DIR);
  for (let userId of userDirs) {
    const profilePath = getUserProfilePath(userId);
    if (!fs.existsSync(profilePath)) continue;
    try {
      const u = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
      if (u.email === email) return u;
    } catch {}
  }
  return null;
}

/* Simple JSON-file helpers */
function ensureJsonFile(p, initial = '[]') {
  if (!fs.existsSync(p)) fs.writeFileSync(p, initial, 'utf8');
  return p;
}
function getFollowersForUser(userId) {
  const p = getFollowersPath(userId);
  ensureJsonFile(p);
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return []; }
}
function getFollowingForUser(userId) {
  const p = getFollowingPath(userId);
  ensureJsonFile(p);
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return []; }
}
function addFollower(targetUserId, followerUserId) {
  const fPath = ensureJsonFile(getFollowersPath(targetUserId));
  let followers = JSON.parse(fs.readFileSync(fPath, 'utf8'));
  if (!followers.includes(followerUserId)) {
    followers.push(followerUserId);
    fs.writeFileSync(fPath, JSON.stringify(followers, null, 2), 'utf8');
  }
  const folPath = ensureJsonFile(getFollowingPath(followerUserId));
  let following = JSON.parse(fs.readFileSync(folPath, 'utf8'));
  if (!following.includes(targetUserId)) {
    following.push(targetUserId);
    fs.writeFileSync(folPath, JSON.stringify(following, null, 2), 'utf8');
  }
}
function removeFollower(targetUserId, followerUserId) {
  const fPath = ensureJsonFile(getFollowersPath(targetUserId));
  let followers = JSON.parse(fs.readFileSync(fPath, 'utf8'));
  followers = followers.filter(id => id !== followerUserId);
  fs.writeFileSync(fPath, JSON.stringify(followers, null, 2), 'utf8');

  const folPath = ensureJsonFile(getFollowingPath(followerUserId));
  let following = JSON.parse(fs.readFileSync(folPath, 'utf8'));
  following = following.filter(id => id !== targetUserId);
  fs.writeFileSync(folPath, JSON.stringify(following, null, 2), 'utf8');
}
function isFollowing(followerUserId, targetUserId) {
  const following = getFollowingForUser(followerUserId);
  return following.includes(targetUserId);
}

/* Notifications */
function ensureUserNotificationsFile(userId) {
  const p = path.join(getUserDir(userId), 'notifications.json');
  if (!fs.existsSync(p)) fs.writeFileSync(p, '[]', 'utf8');
  return p;
}
function addNotificationToUser(userId, type, message, meta = {}) {
  try {
    // avoid self-notifications (meta may contain actor info)
    const profilePath = getUserProfilePath(userId);
    let recipientUsername = null;
    if (fs.existsSync(profilePath)) {
      try { recipientUsername = JSON.parse(fs.readFileSync(profilePath, 'utf8')).username; } catch {}
    }
    if (meta) {
      if (meta.actorId && String(meta.actorId) === String(userId)) return null;
      if (meta.actorUsername && recipientUsername && String(meta.actorUsername) === String(recipientUsername)) return null;
    }

    const p = ensureUserNotificationsFile(userId);
    const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
    const n = {
      id: uuidv4(),
      type,
      message,
      meta,
      createdAt: new Date().toISOString(),
      read: false
    };
    arr.unshift(n);
    fs.writeFileSync(p, JSON.stringify(arr, null, 2), 'utf8');
    return n;
  } catch (err) {
    console.error('addNotificationToUser error:', err && err.message);
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
    arr = arr.map(n => ({ ...n, read: true }));
    changed = true;
  } else {
    arr = arr.map(n => {
      if (ids.includes(n.id) && !n.read) { changed = true; return { ...n, read: true }; }
      return n;
    });
  }
  if (changed) fs.writeFileSync(p, JSON.stringify(arr, null, 2), 'utf8');
  return arr;
}

/* Accounts cookie helpers */
function readAccountsFromReq(req) {
  try {
    const s = req.cookies.accounts;
    if (!s) return [];
    const parsed = JSON.parse(s);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch { return []; }
}
function writeAccountsCookie(res, accounts) {
  try { res.cookie('accounts', JSON.stringify(accounts), { httpOnly: false, maxAge: SESSION_MAX_AGE }); } catch {}
}
function filterValidAccounts(accounts) {
  const out = [];
  for (let token of accounts) {
    try { jwt.verify(token, SECRET); out.push(token); } catch {}
  }
  return out;
}

/* Sliding session middleware */
app.use((req, res, next) => {
  try {
    const currentAccounts = readAccountsFromReq(req);
    const newAccounts = [];
    for (let t of currentAccounts) {
      try {
        const payload = jwt.verify(t, SECRET);
        const newToken = jwt.sign({ id: payload.id, email: payload.email, username: payload.username }, SECRET, { expiresIn: `${SESSION_DAYS}d` });
        newAccounts.push(newToken);
      } catch {}
    }
    writeAccountsCookie(res, newAccounts);

    const activeToken = req.cookies.token;
    if (activeToken) {
      try {
        const payload = jwt.verify(activeToken, SECRET);
        const newActive = jwt.sign({ id: payload.id, email: payload.email, username: payload.username }, SECRET, { expiresIn: `${SESSION_DAYS}d` });
        res.cookie('token', newActive, { httpOnly: true, maxAge: SESSION_MAX_AGE });

        const mapByUsername = {};
        for (let t of newAccounts) {
          try { const p = jwt.verify(t, SECRET); mapByUsername[p.username] = t; } catch {}
        }
        mapByUsername[payload.username] = newActive;
        writeAccountsCookie(res, Object.values(mapByUsername));
      } catch {
        res.clearCookie('token');
      }
    }
  } catch (e) {
    console.error('slidingSessionMiddleware error:', e && e.message);
  }
  next();
});

/* ------------------------
   Auth / HTML routes
   ------------------------ */
function authMiddleware(req, res, next) {
  const token = req.cookies.token;
  if (!token) return res.redirect('/login');
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    res.clearCookie('token');
    return res.redirect('/login');
  }
}

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'views/index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'views/login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'views/register.html')));
app.get('/profile', authMiddleware, (req, res) => res.sendFile(path.join(__dirname, 'views/profile.html')));
app.get('/profile/edit', authMiddleware, (req, res) => res.sendFile(path.join(__dirname, 'views/edit_profile.html')));
app.get('/user/:username', (req, res) => res.sendFile(path.join(__dirname, 'views/user_profile.html')));
app.get('/accounts', authMiddleware, (req, res) => res.sendFile(path.join(__dirname, 'views/accounts.html')));
app.get('/post/create', authMiddleware, (req, res) => res.sendFile(path.join(__dirname, 'views/create_post.html')));
app.get('/post/:id/edit', authMiddleware, (req, res) => res.sendFile(path.join(__dirname, 'views/edit_post.html')));
app.get('/post/:id', (req, res) => res.sendFile(path.join(__dirname, 'views/post.html')));

/* ------------------------
   API routes
   ------------------------ */

/* Register / Login / Accounts */
app.post('/api/register', (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) return res.json({ success: false, msg: 'Missing fields' });
  if (findUserByUsername(username)) return res.json({ success: false, msg: 'Username exists' });
  if (findUserByEmail(email)) return res.json({ success: false, msg: 'Email exists' });

  const userId = uuidv4();
  const userDir = getUserDir(userId);
  fs.mkdirSync(userDir, { recursive: true });

  const profile = {
    id: userId,
    username, email,
    displayName: username,
    profilePic: '',
    profilePicOriginal: '',
    password,
    createdAt: new Date().toISOString(),
    showEmail: false
  };
  fs.writeFileSync(getUserProfilePath(userId), JSON.stringify(profile, null, 2), 'utf8');
  fs.writeFileSync(path.join(userDir, 'posts.json'), '[]', 'utf8');
  fs.writeFileSync(path.join(userDir, 'comments.json'), '[]', 'utf8');
  fs.writeFileSync(path.join(userDir, 'notifications.json'), '[]', 'utf8');
  fs.writeFileSync(getFollowersPath(userId), '[]', 'utf8');
  fs.writeFileSync(getFollowingPath(userId), '[]', 'utf8');

  res.json({ success: true });
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  const user = findUserByEmail(email);
  if (!user || user.password !== password) return res.json({ success: false, msg: 'Invalid credentials' });

  const token = jwt.sign({ id: user.id, email: user.email, username: user.username }, SECRET, { expiresIn: `${SESSION_DAYS}d` });
  res.cookie('token', token, { httpOnly: true, maxAge: SESSION_MAX_AGE });

  let existing = readAccountsFromReq(req);
  let valid = filterValidAccounts(existing);
  const already = valid.find(t => {
    try { return jwt.verify(t, SECRET).username === user.username; } catch { return false; }
  });
  if (!already) valid.push(token);
  else {
    valid = valid.map(t => {
      try {
        const p = jwt.verify(t, SECRET);
        if (p.username === user.username) return token;
        return t;
      } catch { return null; }
    }).filter(Boolean);
  }
  writeAccountsCookie(res, valid);
  res.json({ success: true });
});

app.post('/api/add-account', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.json({ success: false, msg: 'Missing fields' });
  const user = findUserByEmail(email);
  if (!user || user.password !== password) return res.json({ success: false, msg: 'Invalid credentials' });
  const token = jwt.sign({ id: user.id, email: user.email, username: user.username }, SECRET, { expiresIn: `${SESSION_DAYS}d` });

  let accounts = readAccountsFromReq(req);
  accounts = filterValidAccounts(accounts);
  const exists = accounts.find(t => {
    try { return jwt.verify(t, SECRET).username === user.username; } catch { return false; }
  });
  if (!exists) accounts.push(token);
  else {
    accounts = accounts.map(t => {
      try {
        const p = jwt.verify(t, SECRET);
        if (p.username === user.username) return token;
        return t;
      } catch { return null; }
    }).filter(Boolean);
  }
  writeAccountsCookie(res, accounts);

  if (!req.cookies.token) res.cookie('token', token, { httpOnly: true, maxAge: SESSION_MAX_AGE });
  res.json({ success: true, username: user.username });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true });
});

app.post('/api/accounts/switch', (req, res) => {
  const { username } = req.body;
  if (!username) return res.json({ success: false, msg: 'Missing username' });
  const accounts = filterValidAccounts(readAccountsFromReq(req));
  for (let token of accounts) {
    try {
      const p = jwt.verify(token, SECRET);
      if (p.username === username) {
        res.cookie('token', token, { httpOnly: true, maxAge: SESSION_MAX_AGE });
        return res.json({ success: true });
      }
    } catch {}
  }
  return res.json({ success: false, msg: 'Account not found' });
});

app.post('/api/accounts/remove', (req, res) => {
  const { username } = req.body;
  if (!username) return res.json({ success: false, msg: 'Missing username' });
  let accounts = filterValidAccounts(readAccountsFromReq(req));
  accounts = accounts.filter(t => {
    try {
      const p = jwt.verify(t, SECRET);
      return p.username !== username;
    } catch { return false; }
  });
  writeAccountsCookie(res, accounts);
  const activeToken = req.cookies.token;
  if (activeToken) {
    try {
      const p = jwt.verify(activeToken, SECRET);
      if (p.username === username) {
        if (accounts.length > 0) res.cookie('token', accounts[0], { httpOnly: true, maxAge: SESSION_MAX_AGE });
        else res.clearCookie('token');
      }
    } catch {
      if (accounts.length > 0) res.cookie('token', accounts[0], { httpOnly: true, maxAge: SESSION_MAX_AGE });
      else res.clearCookie('token');
    }
  } else {
    if (accounts.length === 0) res.clearCookie('token');
  }
  res.json({ success: true });
});

app.get('/api/accounts', (req, res) => {
  const accounts = filterValidAccounts(readAccountsFromReq(req));
  const out = [];
  for (let token of accounts) {
    try {
      const p = jwt.verify(token, SECRET);
      const u = findUserByUsername(p.username);
      out.push({
        username: p.username,
        displayName: (u && u.displayName) || p.username,
        profilePic: (u && u.profilePic) || ''
      });
    } catch {}
  }
  let active = null;
  const activeToken = req.cookies.token;
  if (activeToken) {
    try { active = jwt.verify(activeToken, SECRET).username; } catch { active = null; }
  }
  res.json({ success: true, accounts: out, active });
});

/* ------------------------
   Profile APIs (including original + cropped handling)
   ------------------------ */

// Return profile (owner) with profilePicOriginal if present
app.get('/api/profile', authMiddleware, (req, res) => {
  const userId = req.user.id;
  const profilePath = getUserProfilePath(userId);
  if (!fs.existsSync(profilePath)) return res.json({ success: false, msg: 'Profile not found' });
  const profileRaw = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  const profile = { ...profileRaw };
  delete profile.password;
  if (typeof profile.showEmail === 'undefined') profile.showEmail = false;
  res.json({ success: true, profile, followersCount: getFollowersForUser(userId).length, followingCount: getFollowingForUser(userId).length });
});

// public user profile
app.get('/api/user/:username', (req, res) => {
  const user = findUserByUsername(req.params.username);
  if (!user) return res.json({ success: false, msg: 'ไม่พบผู้ใช้' });

  if (typeof user.showEmail === 'undefined') user.showEmail = false;

  const followers = getFollowersForUser(user._userId) || [];
  const following = getFollowingForUser(user._userId) || [];

  let myUsername = null;
  let myUserId = null;
  const token = req.cookies.token;
  if (token) {
    try { const p = jwt.verify(token, SECRET); myUsername = p.username; myUserId = p.id; } catch {}
  }

  const isFollowingFlag = myUserId ? isFollowing(myUserId, user._userId) : false;

  const publicProfile = {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    profilePic: user.profilePic || '',
    createdAt: user.createdAt,
    showEmail: !!user.showEmail
  };
  if (user.showEmail) publicProfile.email = user.email;

  res.json({
    success: true,
    profile: publicProfile,
    followersCount: followers.length,
    followingCount: following.length,
    isFollowing: isFollowingFlag,
    myUsername
  });
});

// update profile text fields
app.post('/api/profile/update', authMiddleware, (req, res) => {
  const userId = req.user.id;
  const profilePath = getUserProfilePath(userId);
  if (!fs.existsSync(profilePath)) return res.json({ success: false, msg: 'Profile not found' });
  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  const { displayName, email, showEmail } = req.body;
  if (displayName) profile.displayName = displayName;
  if (typeof email !== 'undefined') profile.email = email;
  if (typeof showEmail !== 'undefined') {
    if (typeof showEmail === 'string') profile.showEmail = showEmail === 'true' || showEmail === '1';
    else profile.showEmail = !!showEmail;
  }
  fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2), 'utf8');
  res.json({ success: true });
});

/*
 Upload profile picture endpoint behavior:
 - Accepts multipart/form-data with:
    - 'profilePic' (required) => the image to use for the cropped avatar (may already be cropped client-side)
    - optional 'original' file field => if provided, server will save this as original.jpg and also create/update avatar.jpg
    - optional form field 'replaceOriginal' = '1' => when set and original exists, overwrite original with profilePic buffer
 - If 'original' not provided:
    - If user has no existing original, server will save the incoming profilePic as original too (so original preserved)
    - If original exists and replaceOriginal is not set, server will keep the existing original and only replace avatar.jpg
 This approach preserves the un-cropped original whenever possible.
*/
app.post('/api/profile/upload-pic', authMiddleware, uploadMemory.fields([{ name: 'profilePic', maxCount: 1 }, { name: 'original', maxCount: 1 }]), async (req, res) => {
  const userId = req.user.id;
  // profilePic is required (the image we will use to generate avatar.jpg)
  const profFiles = req.files || {};
  const profileFiles = profFiles.profilePic || [];
  if (profileFiles.length === 0) return res.json({ success: false, msg: 'No file uploaded' });

  const profilePicFile = profileFiles[0]; // buffer available
  const originalFiles = profFiles.original || [];
  const replaceOriginal = (req.body && (req.body.replaceOriginal === '1' || req.body.replaceOriginal === 'true'));

  try {
    // ensure user exists
    const profilePath = getUserProfilePath(userId);
    if (!fs.existsSync(profilePath)) return res.json({ success: false, msg: 'Profile not found' });

    const outDir = getUserProfilePicDir(userId);
    const croppedPath = getUserProfilePicCroppedPath(userId);
    const originalPath = getUserProfilePicOriginalPath(userId);

    // If explicit original file provided, write it
    if (originalFiles.length > 0) {
      fs.writeFileSync(originalPath, originalFiles[0].buffer);
    } else {
      // If no original provided:
      // - If user has no original saved yet -> save incoming profilePic as original as well
      // - If user has original and replaceOriginal flag set -> overwrite original with incoming profilePic
      if (!fs.existsSync(originalPath) || replaceOriginal) {
        fs.writeFileSync(originalPath, profilePicFile.buffer);
      }
      // otherwise: keep existing original (do nothing)
    }

    // Always (re)create avatar.jpg from the provided profilePic buffer (ensure square)
    // We will fit into 400x400; if incoming isn't square, we center-crop to square first then resize.
    const img = sharp(profilePicFile.buffer);
    const meta = await img.metadata().catch(() => ({}));
    // if not square, center crop to square using smallest side, then resize
    if (meta.width && meta.height) {
      const min = Math.min(meta.width, meta.height);
      await img.extract({ left: Math.floor((meta.width - min) / 2), top: Math.floor((meta.height - min) / 2), width: min, height: min })
               .resize(400, 400)
               .toFormat('jpeg')
               .toFile(croppedPath);
    } else {
      // fallback: just resize to 400x400
      await img.resize(400, 400).toFormat('jpeg').toFile(croppedPath);
    }

    // update profile.json to reflect paths
    const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    profile.profilePic = `/data/users/${userId}/profile_pic/avatar.jpg`;
    profile.profilePicOriginal = `/data/users/${userId}/profile_pic/original.jpg`;
    fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2), 'utf8');

    res.json({ success: true, url: profile.profilePic, original: profile.profilePicOriginal });
  } catch (e) {
    console.error('upload-pic error:', e && e.message);
    res.status(500).json({ success: false, msg: 'Save failed' });
  }
});

// Remove profile picture (both original & avatar)
app.post('/api/profile/remove-pic', authMiddleware, (req, res) => {
  try {
    const userId = req.user.id;
    removeAllProfilePics(userId);
    const profilePath = getUserProfilePath(userId);
    if (fs.existsSync(profilePath)) {
      const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
      profile.profilePic = '';
      profile.profilePicOriginal = '';
      fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2), 'utf8');
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, msg: 'Remove failed' });
  }
});

/* Follow / Unfollow */
app.post('/api/user/:username/follow', authMiddleware, (req, res) => {
  const target = findUserByUsername(req.params.username);
  if (!target) return res.json({ success: false, msg: 'Target not found' });
  const actorId = req.user.id;
  if (actorId === target._userId) return res.json({ success: false, msg: 'Cannot follow yourself' });

  addFollower(target._userId, actorId);
  addNotificationToUser(target._userId, 'new_follower', `${req.user.username} ติดตามคุณ`, { actorId, actorUsername: req.user.username });

  res.json({ success: true, followersCount: getFollowersForUser(target._userId).length });
});

app.post('/api/user/:username/unfollow', authMiddleware, (req, res) => {
  const target = findUserByUsername(req.params.username);
  if (!target) return res.json({ success: false, msg: 'Target not found' });
  const actorId = req.user.id;
  if (actorId === target._userId) return res.json({ success: false, msg: 'Cannot unfollow yourself' });

  removeFollower(target._userId, actorId);

  res.json({ success: true, followersCount: getFollowersForUser(target._userId).length });
});

/* Notifications */
app.get('/api/notifications', authMiddleware, (req, res) => {
  const userId = req.user.id;
  const nots = getNotificationsForUser(userId);
  const unread = nots.filter(n => !n.read).length;
  res.json({ success: true, notifications: nots, unread });
});
app.post('/api/notifications/mark-read', authMiddleware, (req, res) => {
  const userId = req.user.id;
  const updated = markNotificationsRead(userId, req.body.ids || []);
  res.json({ success: true, notifications: updated, unread: updated.filter(n => !n.read).length });
});

/* ------------------------
   Posts & Comments
   ------------------------ */

// Create post (store post in data/posts/{postId}/post.json, store post image in data/posts/{postId}/images/main.jpg)
app.post('/api/post/create', authMiddleware, uploadMemory.single('postImage'), async (req, res) => {
  try {
    const userId = req.user.id;
    const username = req.user.username;
    const { title, content } = req.body;
    if (!title || !content) return res.json({ success: false, msg: 'Missing fields' });

    const postId = uuidv4();
    const postDir = getPostDir(postId);
    fs.mkdirSync(postDir, { recursive: true });

    let imgPathPublic = '';
    if (req.file) {
      const imgDir = getPostImagesDir(postId);
      const dest = path.join(imgDir, 'main.jpg');
      // resize to fit inside 1200x1200 to avoid huge uploads
      await sharp(req.file.buffer).resize({ width: 1200, height: 1200, fit: 'inside' }).toFormat('jpeg').toFile(dest);
      imgPathPublic = `/data/posts/${postId}/images/main.jpg`;
    }

    const post = {
      id: postId,
      username,
      title,
      content,
      image: imgPathPublic,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    fs.writeFileSync(getPostPath(postId), JSON.stringify(post, null, 2), 'utf8');
    fs.writeFileSync(getPostCommentsPath(postId), '[]', 'utf8');

    // add post id to user's posts.json
    const userPostsPath = path.join(getUserDir(userId), 'posts.json');
    let userPosts = [];
    if (fs.existsSync(userPostsPath)) userPosts = JSON.parse(fs.readFileSync(userPostsPath, 'utf8'));
    userPosts.unshift(postId);
    fs.writeFileSync(userPostsPath, JSON.stringify(userPosts, null, 2), 'utf8');

    // notify followers
    try {
      const followers = getFollowersForUser(userId) || [];
      for (let fid of followers) {
        addNotificationToUser(fid, 'new_post', `${username} โพสต์ใหม่: "${title}"`, { postId, actorId: userId, actorUsername: username });
      }
    } catch (e) { console.error('notify followers error', e && e.message) }

    res.json({ success: true, postId });
  } catch (e) {
    console.error('create post error', e && e.message);
    res.status(500).json({ success: false, msg: 'Create failed' });
  }
});

// Edit post (allow changing image; if image changed, remove old image file and save new into same post image folder)
app.post('/api/post/:id/edit', authMiddleware, uploadMemory.single('postImage'), async (req, res) => {
  try {
    const userId = req.user.id;
    const username = req.user.username;
    const postId = req.params.id;
    const postPath = getPostPath(postId);
    if (!fs.existsSync(postPath)) return res.json({ success: false, msg: 'Not found' });
    const post = JSON.parse(fs.readFileSync(postPath, 'utf8'));
    if (post.username !== username) return res.json({ success: false, msg: 'Not owner' });

    const { title, content } = req.body;
    if (title) post.title = title;
    if (content) post.content = content;

    if (req.file) {
      // remove old image file if exists
      if (post.image) {
        try {
          const localPath = path.join(__dirname, post.image);
          if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
        } catch (e) {}
      }
      const imgDir = getPostImagesDir(postId);
      const dest = path.join(imgDir, 'main.jpg');
      await sharp(req.file.buffer).resize({ width: 1200, height: 1200, fit: 'inside' }).toFormat('jpeg').toFile(dest);
      post.image = `/data/posts/${postId}/images/main.jpg`;
    }

    post.updatedAt = new Date().toISOString();
    fs.writeFileSync(postPath, JSON.stringify(post, null, 2), 'utf8');
    res.json({ success: true });
  } catch (e) {
    console.error('edit post error', e && e.message);
    res.status(500).json({ success: false, msg: 'Edit failed' });
  }
});

// Delete post (remove folder including images)
app.delete('/api/post/:id', authMiddleware, (req, res) => {
  const userId = req.user.id;
  const username = req.user.username;
  const postId = req.params.id;
  const postPath = getPostPath(postId);
  if (!fs.existsSync(postPath)) return res.json({ success: false, msg: 'Not found' });
  const post = JSON.parse(fs.readFileSync(postPath, 'utf8'));
  if (post.username !== username) return res.json({ success: false, msg: 'Not owner' });

  // remove associated image files (they live inside post dir)
  try {
    fs.rmSync(getPostDir(postId), { recursive: true, force: true });
  } catch (e) { /* ignore */ }

  // remove post id from user posts.json
  const userPostsPath = path.join(getUserDir(userId), 'posts.json');
  let userPosts = [];
  if (fs.existsSync(userPostsPath)) userPosts = JSON.parse(fs.readFileSync(userPostsPath, 'utf8'));
  userPosts = userPosts.filter(pid => pid !== postId);
  fs.writeFileSync(userPostsPath, JSON.stringify(userPosts, null, 2), 'utf8');

  res.json({ success: true });
});

app.get('/api/post/:id', (req, res) => {
  const postId = req.params.id;
  const postPath = getPostPath(postId);
  if (!fs.existsSync(postPath)) return res.json({ success: false, msg: 'Not found' });
  const post = JSON.parse(fs.readFileSync(postPath, 'utf8'));
  let comments = [];
  if (fs.existsSync(getPostCommentsPath(postId))) comments = JSON.parse(fs.readFileSync(getPostCommentsPath(postId), 'utf8'));
  let myUsername = null;
  const token = req.cookies.token;
  if (token) {
    try { myUsername = jwt.verify(token, SECRET).username; } catch {}
  }
  res.json({ success: true, post, comments, owner: post.username, myUsername });
});

app.get('/api/posts', (req, res) => {
  if (!fs.existsSync(POSTS_DIR)) return res.json({ success: true, posts: [] });
  const postDirs = fs.readdirSync(POSTS_DIR);
  let posts = [];
  for (let postId of postDirs) {
    const ppath = getPostPath(postId);
    if (fs.existsSync(ppath)) {
      try { posts.push(JSON.parse(fs.readFileSync(ppath, 'utf8'))); } catch {}
    }
  }
  posts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ success: true, posts });
});

app.get('/api/user/:username/posts', (req, res) => {
  const user = findUserByUsername(req.params.username);
  if (!user) return res.json({ success: false, posts: [] });
  const userPostsPath = path.join(getUserDir(user._userId), 'posts.json');
  let posts = [];
  if (fs.existsSync(userPostsPath)) {
    const postIds = JSON.parse(fs.readFileSync(userPostsPath, 'utf8'));
    for (let pid of postIds) {
      const postPath = getPostPath(pid);
      if (fs.existsSync(postPath)) {
        try { posts.push(JSON.parse(fs.readFileSync(postPath, 'utf8'))); } catch {}
      }
    }
  }
  posts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ success: true, posts });
});

/* Comments */
app.post('/api/post/:id/comment', authMiddleware, (req, res) => {
  const postId = req.params.id;
  const username = req.user.username;
  const { content } = req.body;
  if (!content) return res.json({ success: false, msg: 'Empty comment' });

  const comment = { id: uuidv4(), postId, username, content, createdAt: new Date().toISOString() };
  const commentsPath = getPostCommentsPath(postId);
  let comments = [];
  if (fs.existsSync(commentsPath)) comments = JSON.parse(fs.readFileSync(commentsPath, 'utf8'));
  comments.push(comment);
  fs.writeFileSync(commentsPath, JSON.stringify(comments, null, 2), 'utf8');

  // add to user's comments.json
  const userObj = findUserByUsername(username);
  if (userObj) {
    const userCommentsPath = path.join(getUserDir(userObj._userId), 'comments.json');
    let userComments = [];
    if (fs.existsSync(userCommentsPath)) userComments = JSON.parse(fs.readFileSync(userCommentsPath, 'utf8'));
    userComments.push(comment.id);
    fs.writeFileSync(userCommentsPath, JSON.stringify(userComments, null, 2), 'utf8');
  }

  // notify post owner
  try {
    const post = JSON.parse(fs.readFileSync(getPostPath(postId), 'utf8'));
    if (post && post.username && post.username !== username) {
      const ownerObj = findUserByUsername(post.username);
      if (ownerObj) {
        addNotificationToUser(ownerObj._userId, 'comment', `${username} แสดงความคิดเห็นในโพสต์ของคุณ`, { postId, commentId: comment.id, actorUsername: username });
      }
    }
  } catch (e) { /* ignore */ }

  res.json({ success: true });
});

app.delete('/api/post/:postId/comment/:commentId', authMiddleware, (req, res) => {
  const { postId, commentId } = req.params;
  const username = req.user.username;
  const commentsPath = getPostCommentsPath(postId);
  if (!fs.existsSync(commentsPath)) return res.json({ success: false, msg: 'Not found' });
  let comments = JSON.parse(fs.readFileSync(commentsPath, 'utf8'));
  const idx = comments.findIndex(c => c.id === commentId && c.username === username);
  if (idx === -1) return res.json({ success: false, msg: 'Not owner' });
  comments.splice(idx, 1);
  fs.writeFileSync(commentsPath, JSON.stringify(comments, null, 2), 'utf8');
  res.json({ success: true });
});

/* 404 fallback */
app.use((req, res) => {
  res.status(404).send('Not found');
});

/* Start server */
app.listen(PORT, () => {
  console.log(`Community app running at http://localhost:${PORT}`);
});