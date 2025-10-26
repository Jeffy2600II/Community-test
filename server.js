// server.js (updated: deduplicate uploaded post files to avoid double-save when client
// sends the same file in multiple multipart fields)
//
// Requires: npm install express body-parser cookie-parser multer jimp jsonwebtoken uuid
// Optional: exif-parser to honor orientation
//
// Note: This is the full server.js used by the project with one change:
// - saveUploadedPostFiles now deduplicates incoming multer file objects by an MD5
//   fingerprint (buffer) + size + originalname before processing/writing them.
// - Added endpoint POST /api/post/:postId/comment/:commentId/edit to allow editing comments
//   (requires authentication and owner check).

const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const Jimp = require('jimp');
const crypto = require('crypto');

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

// multer in-memory storage so we can process images with jimp before writing
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

/* Small FS helper */
function ensureJsonFile(p, initial = '[]') {
  if (!fs.existsSync(p)) fs.writeFileSync(p, initial, 'utf8');
  return p;
}

/* Optional EXIF orientation support */
let ExifParser = null;
try {
  ExifParser = require('exif-parser');
} catch (e) {
  ExifParser = null;
}
async function applyExifOrientationIfNeeded(buffer, jimpImage) {
  if (!ExifParser) return jimpImage;
  try {
    const parser = ExifParser.create(buffer);
    const result = parser.parse();
    const ori = result.tags && result.tags.Orientation;
    if (ori === 3) jimpImage.rotate(180);
    else if (ori === 6) jimpImage.rotate(90);
    else if (ori === 8) jimpImage.rotate(270);
  } catch (e) {
    // ignore parse errors
  }
  return jimpImage;
}

/* ------------------------
   Search helpers
   ------------------------ */
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

/* ------------------------
   JSON helpers
   ------------------------ */
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

/* ------------------------
   Notifications
   ------------------------ */
function ensureUserNotificationsFile(userId) {
  const p = path.join(getUserDir(userId), 'notifications.json');
  if (!fs.existsSync(p)) fs.writeFileSync(p, '[]', 'utf8');
  return p;
}
function addNotificationToUser(userId, type, message, meta = {}) {
  try {
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
   API routes (auth/accounts)
   ------------------------ */

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
 Profile picture upload (unchanged)...
 */
app.post('/api/profile/upload-pic', authMiddleware, uploadMemory.fields([{ name: 'profilePic', maxCount: 1 }, { name: 'original', maxCount: 1 }]), async (req, res) => {
  const userId = req.user.id;
  const profFiles = req.files || {};
  const profileFiles = profFiles.profilePic || [];
  if (profileFiles.length === 0) return res.json({ success: false, msg: 'No file uploaded' });

  const profilePicFile = profileFiles[0]; // buffer available
  const originalFiles = profFiles.original || [];
  const replaceOriginal = (req.body && (req.body.replaceOriginal === '1' || req.body.replaceOriginal === 'true'));

  try {
    const profilePath = getUserProfilePath(userId);
    if (!fs.existsSync(profilePath)) return res.json({ success: false, msg: 'Profile not found' });

    const outDir = getUserProfilePicDir(userId);
    const croppedPath = getUserProfilePicCroppedPath(userId);
    const originalPath = getUserProfilePicOriginalPath(userId);

    if (originalFiles.length > 0) {
      fs.writeFileSync(originalPath, originalFiles[0].buffer);
    } else {
      if (!fs.existsSync(originalPath) || replaceOriginal) {
        fs.writeFileSync(originalPath, profilePicFile.buffer);
      }
    }

    try {
      const img = await Jimp.read(profilePicFile.buffer);
      await applyExifOrientationIfNeeded(profilePicFile.buffer, img);
      const w = img.bitmap.width || 0;
      const h = img.bitmap.height || 0;
      if (w > 0 && h > 0) {
        const min = Math.min(w, h);
        const left = Math.floor((w - min) / 2);
        const top = Math.floor((h - min) / 2);
        await img.clone().crop(left, top, min, min).resize(400, 400).quality(92).writeAsync(croppedPath);
      } else {
        await img.clone().resize(400, 400).quality(92).writeAsync(croppedPath);
      }
    } catch (e) {
      try {
        fs.writeFileSync(croppedPath, profilePicFile.buffer);
      } catch (e2) {
        console.error('failed to write avatar fallback:', e2 && e2.message);
        return res.status(500).json({ success: false, msg: 'Save failed' });
      }
    }

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
   Posts & Comments (support multiple images, dedupe incoming uploads)
   ------------------------ */

/**
 * Compute MD5 fingerprint for a buffer
 */
function fingerprintBuffer(buf) {
  try {
    return crypto.createHash('md5').update(buf).digest('hex');
  } catch (e) {
    return null;
  }
}

/**
 * Helper: save uploaded files (array of multer file objects) into post images directory.
 * Deduplicates incoming files by fingerprint+size+originalname to avoid double-saving the same buffer.
 * Returns array of public paths (e.g., /data/posts/{postId}/images/image-0.jpg)
 */
async function saveUploadedPostFiles(postId, uploadedFiles) {
  if (!uploadedFiles || !uploadedFiles.length) return [];
  // Deduplicate using a Map keyed by fingerprint|size|originalname
  const uniqueMap = new Map();
  for (const f of uploadedFiles) {
    try {
      const fp = fingerprintBuffer(f.buffer) || '';
      const key = `${fp}|${f.size || 0}|${(f.originalname || '')}`;
      if (!uniqueMap.has(key)) uniqueMap.set(key, f);
      else {
        // duplicate detected - skip
      }
    } catch (e) {
      // on error, still add by fallback key using size+name
      const key = `fallback|${f.size||0}|${f.originalname||''}|${Math.random().toString(36).slice(2,6)}`;
      uniqueMap.set(key, f);
    }
  }

  const imgDir = getPostImagesDir(postId);
  const savedPaths = [];
  let idx = 0;
  for (const f of uniqueMap.values()) {
    const filename = `image-${Date.now()}-${idx}.jpg`;
    idx++;
    const dest = path.join(imgDir, filename);
    try {
      const img = await Jimp.read(f.buffer);
      await applyExifOrientationIfNeeded(f.buffer, img);
      const MAX = 1200;
      if (img.bitmap.width > MAX || img.bitmap.height > MAX) {
        await img.clone().scaleToFit(MAX, MAX).quality(88).writeAsync(dest);
      } else {
        await img.clone().quality(88).writeAsync(dest);
      }
    } catch (e) {
      // fallback write raw buffer
      try { fs.writeFileSync(dest, f.buffer); } catch (e2) { console.error('save fallback failed', e2 && e2.message); }
    }
    savedPaths.push(`/data/posts/${postId}/images/${filename}`);
  }
  return savedPaths;
}

// Create post (now supports multiple images)
app.post('/api/post/create', authMiddleware, uploadMemory.fields([{ name: 'postImage', maxCount: 20 }, { name: 'postImages[]', maxCount: 20 }]), async (req, res) => {
  try {
    const userId = req.user.id;
    const username = req.user.username;
    const { title, content } = req.body;
    if (!content) return res.json({ success: false, msg: 'Missing content' });

    const postId = uuidv4();
    const postDir = getPostDir(postId);
    fs.mkdirSync(postDir, { recursive: true });

    // collect uploaded files from multiple possible fields
    const files = [];
    if (req.files) {
      if (Array.isArray(req.files['postImage'])) files.push(...req.files['postImage']);
      if (Array.isArray(req.files['postImages[]'])) files.push(...req.files['postImages[]']);
      Object.keys(req.files).forEach(k => {
        if (!['postImage', 'postImages[]'].includes(k) && Array.isArray(req.files[k])) files.push(...req.files[k]);
      });
    }

    let images = [];
    if (files.length > 0) {
      images = await saveUploadedPostFiles(postId, files);
    }

    // legacy compatibility: keep single 'image' field pointing to first image
    const post = {
      id: postId,
      username,
      title: title || '',
      content,
      image: images.length ? images[0] : '',
      images: images,
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
        const snippet = (post.title && post.title.trim().length > 0) ? post.title : (post.content || '').slice(0, 60);
        addNotificationToUser(fid, 'new_post', `${username} โพสต์ใหม่: "${snippet}"`, { postId, actorId: userId, actorUsername: username });
      }
    } catch (e) { console.error('notify followers error', e && e.message) }

    res.json({ success: true, postId });
  } catch (e) {
    console.error('create post error', e && e.message);
    res.status(500).json({ success: false, msg: 'Create failed' });
  }
});

// Edit post: accept new files (many) and deleteImages[] markers to remove existing images
app.post('/api/post/:id/edit', authMiddleware, uploadMemory.fields([{ name: 'postImage', maxCount: 20 }, { name: 'postImages[]', maxCount: 20 }]), async (req, res) => {
  try {
    const userId = req.user.id;
    const username = req.user.username;
    const postId = req.params.id;
    const postPath = getPostPath(postId);
    if (!fs.existsSync(postPath)) return res.json({ success: false, msg: 'Not found' });
    const post = JSON.parse(fs.readFileSync(postPath, 'utf8'));
    if (post.username !== username) return res.json({ success: false, msg: 'Not owner' });

    const { title, content } = req.body;
    if (typeof content !== 'undefined' && content !== null) post.content = content;
    if (typeof title !== 'undefined') post.title = title || '';

    // normalize existing images array
    if (!Array.isArray(post.images)) {
      post.images = [];
      if (post.image) post.images.push(post.image);
    }

    // handle deleteImages[] from client (may be string or array)
    let deletes = [];
    if (req.body) {
      if (Array.isArray(req.body['deleteImages[]'])) deletes = req.body['deleteImages[]'];
      else if (Array.isArray(req.body.deleteImages)) deletes = req.body.deleteImages;
      else if (typeof req.body['deleteImages[]'] === 'string') deletes = [req.body['deleteImages[]']];
      else if (typeof req.body.deleteImages === 'string') deletes = [req.body.deleteImages];
    }
    // perform deletion: match by exact URL, by filename suffix, or by index
    if (deletes.length > 0) {
      for (const d of deletes) {
        try {
          // try to find by exact match first
          let idx = post.images.findIndex(u => u === d);
          if (idx === -1) {
            // try match by filename suffix
            idx = post.images.findIndex(u => {
              try {
                const p = path.basename(u);
                if (!p) return false;
                return (p === d) || u.endsWith(d) || p === String(d);
              } catch (e) { return false; }
            });
          }
          // if still not found but d is numeric index
          if (idx === -1 && !isNaN(Number(d))) {
            const nd = Number(d);
            if (nd >= 0 && nd < post.images.length) idx = nd;
          }
          if (idx !== -1) {
            // remove file from disk
            const urlPath = post.images[idx];
            try {
              const local = path.join(__dirname, urlPath);
              if (fs.existsSync(local)) fs.unlinkSync(local);
            } catch (e) { /* ignore unlink errors */ }
            post.images.splice(idx, 1);
          }
        } catch (e) { console.warn('deleteImages handling error', e && e.message); }
      }
    }

    // collect uploaded new files and append them
    const files = [];
    if (req.files) {
      if (Array.isArray(req.files['postImage'])) files.push(...req.files['postImage']);
      if (Array.isArray(req.files['postImages[]'])) files.push(...req.files['postImages[]']);
      Object.keys(req.files).forEach(k => {
        if (!['postImage', 'postImages[]'].includes(k) && Array.isArray(req.files[k])) files.push(...req.files[k]);
      });
    }

    if (files.length > 0) {
      const newPaths = await saveUploadedPostFiles(postId, files);
      post.images = post.images.concat(newPaths);
    }

    // maintain legacy field
    post.image = post.images.length ? post.images[0] : '';

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
  // Ensure backward compatibility: if post.images missing but post.image exists, synthesize images array
  if (!Array.isArray(post.images)) {
    post.images = [];
    if (post.image) post.images.push(post.image);
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
      try {
        const p = JSON.parse(fs.readFileSync(ppath, 'utf8'));
        if (!Array.isArray(p.images)) {
          p.images = [];
          if (p.image) p.images.push(p.image);
        }
        posts.push(p);
      } catch {}
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
        try {
          const p = JSON.parse(fs.readFileSync(postPath, 'utf8'));
          if (!Array.isArray(p.images)) {
            p.images = [];
            if (p.image) p.images.push(p.image);
          }
          posts.push(p);
        } catch {}
      }
    }
  }
  posts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ success: true, posts });
});

/* Comments (unchanged) */
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
        addNotificationToUser(ownerObj._userId, 'comment', `${username} แสดงความคิดเห็นในโพสต์ของคุณ`, { postId, commentId: comment.id, actorUsername: username, actorId: userObj ? userObj.id : undefined });
      }
    }
  } catch (e) { /* ignore */ }

  res.json({ success: true });
});

/*
  NEW: Edit comment endpoint
  - Verifies auth, verifies the comment exists, verifies ownership, updates content and writes back.
  - Returns the updated comment on success.
*/
app.post('/api/post/:postId/comment/:commentId/edit', authMiddleware, (req, res) => {
  try {
    const { postId, commentId } = req.params;
    const userId = req.user.id;
    const username = req.user.username;
    const commentsPath = getPostCommentsPath(postId);
    if (!fs.existsSync(commentsPath)) return res.json({ success: false, msg: 'ไม่พบโพสต์/คอมเมนต์' });

    let comments = JSON.parse(fs.readFileSync(commentsPath, 'utf8'));
    const idx = comments.findIndex(c => c.id === commentId);
    if (idx === -1) return res.json({ success: false, msg: 'คอมเมนต์ไม่พบ' });

    const comment = comments[idx];
    if (comment.username !== username) return res.json({ success: false, msg: 'ไม่ได้รับอนุญาต' });

    const { content } = req.body;
    if (typeof content === 'undefined' || String(content).trim() === '') {
      return res.json({ success: false, msg: 'เนื้อหาห้ามว่าง' });
    }

    // update
    comment.content = String(content);
    comment.updatedAt = new Date().toISOString();
    comments[idx] = comment;
    fs.writeFileSync(commentsPath, JSON.stringify(comments, null, 2), 'utf8');

    res.json({ success: true, comment });
  } catch (e) {
    console.error('edit comment error', e && e.message);
    res.status(500).json({ success: false, msg: 'แก้ไขคอมเมนต์ล้มเหลว' });
  }
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