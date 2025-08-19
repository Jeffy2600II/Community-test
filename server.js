// server.js (full, updated)
// Features:
// - Argon2 password hashing
// - Access token (JWT) short-lived, refresh tokens server-side (rotating)
// - Device manager integration: device-linked sessions & inactivity-based revocation (30 days)
// - Followers / following per-user
// - Notifications per-user
// - Posts & comments CRUD
// - Profile APIs with showEmail privacy setting
// - Secure cookie usage, helmet, basic rate-limiting
//
// Requirements:
// npm i express body-parser cookie-parser multer jsonwebtoken uuid argon2 helmet express-rate-limit

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

const deviceManager = require('./public/server/deviceManager'); // ensure file exists

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

// Secrets - set these via environment in production
const SECRET = process.env.JWT_SECRET || "community_super_secret_2025";
const REFRESH_TOKEN_HMAC_KEY = process.env.REFRESH_HMAC_KEY || "refresh_hmac_key_change_me";

const DATA_DIR = path.join(__dirname, 'data');
const USERS_DIR = path.join(DATA_DIR, 'users');
const POSTS_DIR = path.join(DATA_DIR, 'posts');
const UPLOADS_DIR = path.join(__dirname, 'public/uploads');
const PROFILE_PIC_DIR = path.join(UPLOADS_DIR, 'profile_pics');
const POST_IMG_DIR = path.join(UPLOADS_DIR, 'post_images');

[DATA_DIR, USERS_DIR, POSTS_DIR, UPLOADS_DIR, PROFILE_PIC_DIR, POST_IMG_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Security middleware
app.use(helmet());
app.use(express.static('public'));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(cookieParser());

// rate limiter (basic)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
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
const upload = multer({ storage: storage });

/* ------------------------
   Helper utilities
   ------------------------ */
function readJSON(p, fallback = null) {
  try { if (!fs.existsSync(p)) return fallback; return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function writeJSON(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8'); }

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
                    const safe = { ...user };
                    delete safe.password;
                    return { ...safe, _userId: userId };
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
                if (user.email === email) return user;
            } catch {}
        }
    }
    return null;
}

function getUserDir(userId) { return path.join(USERS_DIR, userId); }
function getUserProfilePath(userId) { return path.join(USERS_DIR, userId, 'profile.json'); }
function getUserSessionsPath(userId) { return path.join(USERS_DIR, userId, 'sessions.json'); }
function ensureUserSessionsFile(userId) { const p = getUserSessionsPath(userId); if (!fs.existsSync(p)) fs.writeFileSync(p, '[]', 'utf8'); return p; }
function readUserSessions(userId) { ensureUserSessionsFile(userId); try { return JSON.parse(fs.readFileSync(getUserSessionsPath(userId), 'utf8')); } catch { return []; } }
function writeUserSessions(userId, arr) { fs.writeFileSync(getUserSessionsPath(userId), JSON.stringify(arr, null, 2), 'utf8'); }

function getFollowersPath(userId) { return path.join(getUserDir(userId), 'followers.json'); }
function getFollowingPath(userId) { return path.join(getUserDir(userId), 'following.json'); }
function getPostDir(postId) { return path.join(POSTS_DIR, postId); }
function getPostPath(postId) { return path.join(POSTS_DIR, postId, 'post.json'); }
function getPostCommentsPath(postId) { return path.join(POSTS_DIR, postId, 'comments.json'); }

function ensureJsonFile(p, initial = '[]') { if (!fs.existsSync(p)) fs.writeFileSync(p, initial, 'utf8'); return p; }
function getFollowersForUser(userId) { const p = getFollowersPath(userId); ensureJsonFile(p); try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return []; } }
function getFollowingForUser(userId) { const p = getFollowingPath(userId); ensureJsonFile(p); try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return []; } }
function addFollower(targetUserId, followerUserId) {
    const fPath = ensureJsonFile(getFollowersPath(targetUserId));
    let followers = JSON.parse(fs.readFileSync(fPath, 'utf8'));
    if (!followers.includes(followerUserId)) { followers.push(followerUserId); fs.writeFileSync(fPath, JSON.stringify(followers, null, 2), 'utf8'); }
    const folPath = ensureJsonFile(getFollowingPath(followerUserId));
    let following = JSON.parse(fs.readFileSync(folPath, 'utf8'));
    if (!following.includes(targetUserId)) { following.push(targetUserId); fs.writeFileSync(folPath, JSON.stringify(following, null, 2), 'utf8'); }
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

/* Notifications helpers */
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
            try { const p = JSON.parse(fs.readFileSync(profilePath, 'utf8')); recipientUsername = p.username; } catch {}
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
        console.error('addNotificationToUser error:', err && err.message);
        return null;
    }
}
function getNotificationsForUser(userId) { const p = ensureUserNotificationsFile(userId); try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return []; } }
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

/* Token/session utilities */
function generateRandomTokenBytes(n = 48) { return crypto.randomBytes(n).toString('hex'); }
function hashRefreshToken(token) { return crypto.createHmac('sha256', REFRESH_TOKEN_HMAC_KEY).update(token).digest('hex'); }
function signAccessToken(payload, opts = {}) { return jwt.sign(payload, SECRET, { expiresIn: opts.expiresIn || '15m' }); }
function verifyAccessToken(token) { try { return jwt.verify(token, SECRET); } catch { return null; } }

function createSession(userId, meta = {}, expiresAt = null) {
    const sessions = readUserSessions(userId);
    const rawToken = generateRandomTokenBytes(48);
    const tokenHash = hashRefreshToken(rawToken);
    const sessionId = uuidv4();
    const now = new Date().toISOString();
    const session = { id: sessionId, tokenHash, createdAt: now, lastUsedAt: now, expiresAt: expiresAt, revoked: false, meta };
    sessions.push(session);
    writeUserSessions(userId, sessions);
    return { rawToken, sessionId };
}

function rotateRefreshTokenForUser(userId, incomingRawToken) {
    const sessions = readUserSessions(userId);
    const incomingHash = hashRefreshToken(incomingRawToken);
    for (let s of sessions) {
        if (s.tokenHash === incomingHash && !s.revoked) {
            if (s.expiresAt && new Date(s.expiresAt) < new Date()) return null;
            const newRaw = generateRandomTokenBytes(48);
            s.tokenHash = hashRefreshToken(newRaw);
            s.lastUsedAt = new Date().toISOString();
            writeUserSessions(userId, sessions);
            return { newRaw, sessionId: s.id };
        }
    }
    return null;
}

function revokeSessionByToken(userId, rawToken) {
    const sessions = readUserSessions(userId);
    const h = hashRefreshToken(rawToken);
    let changed = false;
    for (let s of sessions) {
        if (s.tokenHash === h && !s.revoked) { s.revoked = true; changed = true; }
    }
    if (changed) writeUserSessions(userId, sessions);
    return changed;
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

/* Device & inactivity policy */
const INACTIVITY_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function authMiddleware(req, res, next) {
    const token = req.cookies.token;
    if (!token) return res.redirect('/login');
    const payload = verifyAccessToken(token);
    if (!payload) return res.redirect('/login');

    const deviceId = req.cookies.deviceId;
    if (deviceId && deviceManager.isInactive(deviceId, INACTIVITY_THRESHOLD_MS)) {
        deviceManager.revokeDevice(deviceId);
        res.clearCookie('token'); res.clearCookie('refresh');
        return res.redirect('/login');
    }
    if (deviceId) deviceManager.recordActivity(deviceId);
    req.user = payload;
    next();
}

function apiAuthMiddleware(req, res, next) {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ success: false, msg: 'Not authenticated' });
    const payload = verifyAccessToken(token);
    if (!payload) return res.status(401).json({ success: false, msg: 'Token invalid or expired' });

    const deviceId = req.cookies.deviceId;
    if (deviceId && deviceManager.isInactive(deviceId, INACTIVITY_THRESHOLD_MS)) {
        deviceManager.revokeDevice(deviceId);
        res.clearCookie('token'); res.clearCookie('refresh');
        return res.status(401).json({ success: false, msg: 'Device inactive, logged out' });
    }
    if (deviceId) deviceManager.recordActivity(deviceId);
    req.user = payload;
    next();
}

/* ------------------------
   HTML page routes
   ------------------------ */
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
   Auth & session APIs
   ------------------------ */

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
        id: userId, username, email,
        displayName: username,
        profilePic: '',
        password: hashed,
        createdAt: new Date().toISOString(),
        showEmail: false,
        bio: ''
    };
    writeJSON(getUserProfilePath(userId), profile);
    writeJSON(path.join(userDir, 'posts.json'), []);
    writeJSON(path.join(userDir, 'comments.json'), []);
    writeJSON(path.join(userDir, 'notifications.json'), []);
    writeJSON(getUserSessionsPath(userId), []);
    writeJSON(getFollowersPath(userId), []);
    writeJSON(getFollowingPath(userId), []);

    res.json({ success: true });
});

app.post('/api/login', authLimiter, async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.json({ success: false, msg: 'Missing credentials' });
    const user = findUserByEmail(email);
    if (!user) return res.json({ success: false, msg: 'Invalid credentials' });

    try {
        const ok = await argon2.verify(user.password, password);
        if (!ok) return res.json({ success: false, msg: 'Invalid credentials' });
    } catch {
        return res.json({ success: false, msg: 'Invalid credentials' });
    }

    const accessPayload = { id: user.id, username: user.username };
    const accessToken = signAccessToken(accessPayload, { expiresIn: '15m' });

    const meta = { ip: req.ip, ua: req.get('User-Agent') || '', createdFrom: 'web' };
    const { rawToken, sessionId } = createSession(user.id, meta, null);

    let deviceId = req.cookies.deviceId;
    if (!deviceId) {
        deviceId = deviceManager.createDevice();
        res.cookie('deviceId', deviceId, {
            httpOnly: false,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'Strict',
            maxAge: 5 * 365 * 24 * 60 * 60 * 1000
        });
    }
    deviceManager.linkSession(deviceId, user.id, sessionId);

    res.cookie('token', accessToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'Strict',
        maxAge: 15 * 60 * 1000
    });
    res.cookie('refresh', rawToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'Strict',
        maxAge: 365 * 24 * 60 * 60 * 1000
    });

    // maintain accounts cookie (client-visible minimal tokens)
    const tokenForAccounts = jwt.sign({ id: user.id, email: user.email, username: user.username }, SECRET, { expiresIn: '365d' });
    try {
        const existing = req.cookies.accounts ? JSON.parse(req.cookies.accounts) : [];
        const arr = Array.isArray(existing) ? existing : [];
        const hasUser = arr.some(t => {
            try { return jwt.verify(t, SECRET).username === user.username; } catch { return false; }
        });
        if (!hasUser) arr.push(tokenForAccounts);
        res.cookie('accounts', JSON.stringify(arr), { httpOnly: false });
    } catch {}

    res.json({ success: true });
});

app.post('/api/token/refresh', async (req, res) => {
    const rawRefresh = req.cookies.refresh;
    const deviceId = req.cookies.deviceId;

    if (deviceId && deviceManager.isInactive(deviceId, INACTIVITY_THRESHOLD_MS)) {
        deviceManager.revokeDevice(deviceId);
        res.clearCookie('token'); res.clearCookie('refresh');
        return res.status(401).json({ success: false, msg: 'Device inactive, please login again' });
    }
    if (!rawRefresh) return res.status(401).json({ success: false, msg: 'No refresh token' });

    // naive scan - for file-based store. Replace with DB lookup for production.
    const userDirs = fs.readdirSync(USERS_DIR || []);
    for (let userId of userDirs) {
        const sessionsPath = getUserSessionsPath(userId);
        if (!fs.existsSync(sessionsPath)) continue;
        const rotated = rotateRefreshTokenForUser(userId, rawRefresh);
        if (rotated) {
            if (deviceId) {
                deviceManager.recordActivity(deviceId);
                deviceManager.linkSession(deviceId, userId, rotated.sessionId);
            }
            const profile = JSON.parse(fs.readFileSync(getUserProfilePath(userId), 'utf8'));
            const newAccess = signAccessToken({ id: profile.id, username: profile.username }, { expiresIn: '15m' });

            res.cookie('token', newAccess, {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: 'Strict',
                maxAge: 15 * 60 * 1000
            });
            res.cookie('refresh', rotated.newRaw, {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: 'Strict',
                maxAge: 365 * 24 * 60 * 60 * 1000
            });
            return res.json({ success: true });
        }
    }

    return res.status(401).json({ success: false, msg: 'Refresh token invalid' });
});

app.post('/api/logout', (req, res) => {
    const rawRefresh = req.cookies.refresh;
    const deviceId = req.cookies.deviceId;

    if (rawRefresh) {
        const userDirs = fs.readdirSync(USERS_DIR || []);
        for (let userId of userDirs) {
            const sessionsPath = getUserSessionsPath(userId);
            if (!fs.existsSync(sessionsPath)) continue;
            const sessions = readUserSessions(userId);
            const found = sessions.find(s => s.tokenHash === hashRefreshToken(rawRefresh));
            if (found) {
                found.revoked = true;
                writeUserSessions(userId, sessions);
                if (deviceId) deviceManager.unlinkSession(deviceId, userId, found.id);
                break;
            }
        }
    }

    res.clearCookie('token'); res.clearCookie('refresh');
    res.json({ success: true });
});

app.post('/api/logout-all', apiAuthMiddleware, (req, res) => {
    const userId = req.user.id;
    const sessions = readUserSessions(userId);
    for (let s of sessions) s.revoked = true;
    writeUserSessions(userId, sessions);

    const devicesDir = path.join(__dirname, 'data', 'devices');
    if (fs.existsSync(devicesDir)) {
        for (const f of fs.readdirSync(devicesDir)) {
            try {
                const device = JSON.parse(fs.readFileSync(path.join(devicesDir, f), 'utf8'));
                device.sessions = device.sessions.filter(s => s.userId !== userId);
                fs.writeFileSync(path.join(devicesDir, f), JSON.stringify(device, null, 2), 'utf8');
            } catch {}
        }
    }

    res.clearCookie('token'); res.clearCookie('refresh');
    res.json({ success: true });
});

/* ------------------------
   Profile endpoints
   ------------------------ */

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

app.post('/api/profile/update', apiAuthMiddleware, (req, res) => {
    const userId = req.user.id;
    const profilePath = getUserProfilePath(userId);
    if (!fs.existsSync(profilePath)) return res.json({ success: false, msg: 'Profile not found' });
    const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    const { displayName, email, showEmail, bio } = req.body;
    if (displayName) profile.displayName = displayName;
    if (typeof email !== 'undefined') profile.email = email;
    if (typeof showEmail !== 'undefined') {
        if (typeof showEmail === 'string') profile.showEmail = showEmail === 'true' || showEmail === '1';
        else profile.showEmail = !!showEmail;
    }
    if (typeof bio !== 'undefined') profile.bio = bio;
    fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2), 'utf8');
    res.json({ success: true });
});

app.post('/api/profile/upload-pic', apiAuthMiddleware, upload.single('profilePic'), (req, res) => {
    const userId = req.user.id;
    const profilePath = getUserProfilePath(userId);
    if (!fs.existsSync(profilePath)) return res.json({ success: false, msg: 'Profile not found' });
    const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    if (req.file) {
        // remove old pic if exists
        if (profile.profilePic && fs.existsSync(path.join(__dirname, 'public', profile.profilePic))) {
            try { fs.unlinkSync(path.join(__dirname, 'public', profile.profilePic)); } catch {}
        }
        profile.profilePic = '/uploads/profile_pics/' + req.file.filename;
        fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2), 'utf8');
        return res.json({ success: true, profilePic: profile.profilePic });
    }
    res.json({ success: false, msg: 'No file' });
});

app.post('/api/profile/remove-pic', apiAuthMiddleware, (req, res) => {
    const userId = req.user.id;
    const profilePath = getUserProfilePath(userId);
    if (!fs.existsSync(profilePath)) return res.json({ success: false, msg: 'Profile not found' });
    const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    if (profile.profilePic && fs.existsSync(path.join(__dirname, 'public', profile.profilePic))) {
        try { fs.unlinkSync(path.join(__dirname, 'public', profile.profilePic)); } catch {}
    }
    profile.profilePic = '';
    fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2), 'utf8');
    res.json({ success: true });
});

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
    const publicProfile = { id: user.id, username: user.username, displayName: user.displayName, profilePic: user.profilePic || '', createdAt: user.createdAt, showEmail: !!user.showEmail };
    if (user.showEmail) publicProfile.email = user.email;
    res.json({ success: true, profile: publicProfile, followersCount: followers.length, followingCount: following.length, isFollowing: isFollowingFlag, myUsername });
});

/* Follow / Unfollow */
app.post('/api/user/:username/follow', apiAuthMiddleware, (req, res) => {
    const target = findUserByUsername(req.params.username);
    if (!target) return res.json({ success: false, msg: 'Target not found' });
    const actorId = req.user.id;
    if (actorId === target._userId) return res.json({ success: false, msg: 'Cannot follow yourself' });

    addFollower(target._userId, actorId);
    addNotificationToUser(target._userId, 'new_follower', `${req.user.username} ติดตามคุณ`, { actorId, actorUsername: req.user.username });
    const followers = getFollowersForUser(target._userId) || [];
    res.json({ success: true, followersCount: followers.length });
});

app.post('/api/user/:username/unfollow', apiAuthMiddleware, (req, res) => {
    const target = findUserByUsername(req.params.username);
    if (!target) return res.json({ success: false, msg: 'Target not found' });
    const actorId = req.user.id;
    if (actorId === target._userId) return res.json({ success: false, msg: 'Cannot unfollow yourself' });

    removeFollower(target._userId, actorId);
    const followers = getFollowersForUser(target._userId) || [];
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

/* Notifications */
app.get('/api/notifications', apiAuthMiddleware, (req, res) => {
    const userId = req.user.id;
    const nots = getNotificationsForUser(userId);
    const unreadCount = nots.filter(n => !n.read).length;
    res.json({ success: true, notifications: nots, unread: unreadCount });
});
app.post('/api/notifications/mark-read', apiAuthMiddleware, (req, res) => {
    const userId = req.user.id;
    const { ids } = req.body;
    const updated = markNotificationsRead(userId, ids || []);
    res.json({ success: true, notifications: updated, unread: updated.filter(n => !n.read).length });
});

/* ------------------------
   Posts & Comments
   ------------------------ */

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
    writeJSON(getPostPath(postId), post);
    writeJSON(getPostCommentsPath(postId), []);

    // update user's posts list
    const userPostsPath = path.join(getUserDir(userId), 'posts.json');
    let userPosts = [];
    if (fs.existsSync(userPostsPath)) userPosts = JSON.parse(fs.readFileSync(userPostsPath, 'utf8'));
    userPosts.unshift(postId);
    fs.writeFileSync(userPostsPath, JSON.stringify(userPosts, null, 2), 'utf8');

    // notify followers
    try {
        const followers = getFollowersForUser(userId) || [];
        for (let followerId of followers) {
            addNotificationToUser(followerId, 'new_post', `${username} โพสต์ใหม่: "${title}"`, { postId, actorId: userId, actorUsername: username });
        }
    } catch (e) { console.error('notify followers error', e && e.message); }

    res.json({ success: true, postId });
});

app.post('/api/post/:id/edit', apiAuthMiddleware, upload.single('postImage'), (req, res) => {
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
        if (post.image && fs.existsSync(path.join(__dirname, 'public', post.image))) {
            try { fs.unlinkSync(path.join(__dirname, 'public', post.image)); } catch {}
        }
        post.image = '/uploads/post_images/' + req.file.filename;
    }
    post.updatedAt = new Date().toISOString();
    writeJSON(postPath, post);
    res.json({ success: true });
});

app.delete('/api/post/:id', apiAuthMiddleware, (req, res) => {
    const userId = req.user.id;
    const username = req.user.username;
    const postId = req.params.id;
    const postPath = getPostPath(postId);
    if (!fs.existsSync(postPath)) return res.json({ success: false, msg: 'Not found' });
    const post = JSON.parse(fs.readFileSync(postPath, 'utf8'));
    if (post.username !== username) return res.json({ success: false, msg: 'Not owner' });
    if (post.image && fs.existsSync(path.join(__dirname, 'public', post.image))) {
        try { fs.unlinkSync(path.join(__dirname, 'public', post.image)); } catch {}
    }
    fs.rmSync(getPostDir(postId), { recursive: true, force: true });
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
        try { myUsername = verifyAccessToken(token).username; } catch {}
    }
    res.json({ success: true, post, comments, owner: post.username, myUsername });
});

app.get('/api/posts', (req, res) => {
    if (!fs.existsSync(POSTS_DIR)) return res.json({ success: true, posts: [] });
    const postDirs = fs.readdirSync(POSTS_DIR);
    let posts = [];
    for (let postId of postDirs) {
        const postPath = getPostPath(postId);
        if (fs.existsSync(postPath)) {
            const post = JSON.parse(fs.readFileSync(postPath, 'utf8'));
            posts.push(post);
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
            if (fs.existsSync(postPath)) posts.push(JSON.parse(fs.readFileSync(postPath, 'utf8')));
        }
    }
    posts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ success: true, posts });
});

/* Comments */
app.post('/api/post/:id/comment', apiAuthMiddleware, (req, res) => {
    const postId = req.params.id;
    const username = req.user.username;
    const { content } = req.body;
    if (!content) return res.json({ success: false, msg: 'Empty comment' });
    const comment = { id: uuidv4(), postId, username, content, createdAt: new Date().toISOString() };
    const commentsPath = getPostCommentsPath(postId);
    let comments = [];
    if (fs.existsSync(commentsPath)) comments = JSON.parse(fs.readFileSync(commentsPath, 'utf8'));
    comments.push(comment);
    writeJSON(commentsPath, comments);
    const userObj = findUserByUsername(username);
    if (userObj) {
        const userCommentsPath = path.join(getUserDir(userObj._userId), 'comments.json');
        let userComments = [];
        if (fs.existsSync(userCommentsPath)) userComments = JSON.parse(fs.readFileSync(userCommentsPath, 'utf8'));
        userComments.push(comment.id);
        fs.writeFileSync(userCommentsPath, JSON.stringify(userComments, null, 2), 'utf8');
    }
    // Notify post owner if different
    try {
        const post = JSON.parse(fs.readFileSync(getPostPath(postId), 'utf8'));
        if (post && post.username && post.username !== username) {
            const ownerObj = findUserByUsername(post.username);
            if (ownerObj) {
                addNotificationToUser(ownerObj._userId, 'comment', `${username} แสดงความคิดเห็นในโพสต์ของคุณ`, { postId, commentId: comment.id, actorId: userObj && userObj._userId, actorUsername: username });
            }
        }
    } catch {}
    res.json({ success: true });
});

app.delete('/api/post/:postId/comment/:commentId', apiAuthMiddleware, (req, res) => {
    const { postId, commentId } = req.params;
    const username = req.user.username;
    const commentsPath = getPostCommentsPath(postId);
    if (!fs.existsSync(commentsPath)) return res.json({ success: false, msg: 'Not found' });
    let comments = JSON.parse(fs.readFileSync(commentsPath, 'utf8'));
    const idx = comments.findIndex(c => c.id === commentId && c.username === username);
    if (idx === -1) return res.json({ success: false, msg: 'Not owner' });
    comments.splice(idx, 1);
    writeJSON(commentsPath, comments);
    res.json({ success: true });
});

/* ------------------------
   404 fallback & start
   ------------------------ */
app.use((req, res) => { res.status(404).send('Not found'); });

app.listen(PORT, () => {
    console.log(`Community app running at http://localhost:${PORT}`);
});