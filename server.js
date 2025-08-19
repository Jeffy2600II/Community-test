// server.js (updated to support showEmail and profile changes)
// Community app with accounts, multi-account cookies, followers, notifications, posts, comments
const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = 3000;
const SECRET = "community_super_secret_2025";
const DATA_DIR = path.join(__dirname, 'data');
const USERS_DIR = path.join(DATA_DIR, 'users');
const POSTS_DIR = path.join(DATA_DIR, 'posts');
const UPLOADS_DIR = path.join(__dirname, 'public/uploads');
const PROFILE_PIC_DIR = path.join(UPLOADS_DIR, 'profile_pics');
const POST_IMG_DIR = path.join(UPLOADS_DIR, 'post_images');

[DATA_DIR, USERS_DIR, POSTS_DIR, UPLOADS_DIR, PROFILE_PIC_DIR, POST_IMG_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

app.use(express.static('public'));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(cookieParser());

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
   Helper functions
   ------------------------ */
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
            } catch { /* ignore parse errors */ }
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
            } catch { /* ignore */ }
        }
    }
    return null;
}
function getUserDir(userId) { return path.join(USERS_DIR, userId); }
function getUserProfilePath(userId) { return path.join(USERS_DIR, userId, 'profile.json'); }
function getFollowersPath(userId) { return path.join(USERS_DIR, userId, 'followers.json'); }
function getFollowingPath(userId) { return path.join(USERS_DIR, userId, 'following.json'); }
function getPostDir(postId) { return path.join(POSTS_DIR, postId); }
function getPostPath(postId) { return path.join(POSTS_DIR, postId, 'post.json'); }
function getPostCommentsPath(postId) { return path.join(POSTS_DIR, postId, 'comments.json'); }

/* authMiddleware: protects HTML routes and APIs that expect a session via cookie.token */
function authMiddleware(req, res, next) {
    const token = req.cookies.token;
    if (!token) {
        // For browser navigation we redirect to login
        return res.redirect('/login');
    }
    try {
        req.user = jwt.verify(token, SECRET);
        next();
    } catch {
        res.clearCookie('token');
        return res.redirect('/login');
    }
}

/* Lightweight JSON file helpers for followers/following and notifications */
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

/* Notifications helpers (store per-user in users/{id}/notifications.json) */
function ensureUserNotificationsFile(userId) {
    const p = path.join(getUserDir(userId), 'notifications.json');
    if (!fs.existsSync(p)) fs.writeFileSync(p, '[]', 'utf8');
    return p;
}
/**
 * addNotificationToUser: will skip creating a notification if meta.actorId or meta.actorUsername
 * indicates the actor is the same as the recipient (prevents self-notify).
 * Returns created notification object or null if skipped / error.
 */
function addNotificationToUser(userId, type, message, meta = {}) {
    try {
        // determine recipient username if possible
        let recipientUsername = null;
        const profilePath = getUserProfilePath(userId);
        if (fs.existsSync(profilePath)) {
            try {
                const p = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
                recipientUsername = p.username;
            } catch {}
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

/* -- Helpers for accounts-in-cookie (client-visible list) -- */
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
    try {
        res.cookie('accounts', JSON.stringify(accounts), { httpOnly: false });
    } catch { /* ignore */ }
}
function filterValidAccounts(accounts) {
    const out = [];
    for (let token of accounts) {
        try {
            jwt.verify(token, SECRET);
            out.push(token);
        } catch { /* skip invalid */ }
    }
    return out;
}

/* ------------------------
   HTML pages routes
   ------------------------ */
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'views/index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'views/login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'views/register.html')));

// Serve personal profile page (requires auth) - this page uses /api/profile to fetch data
app.get('/profile', authMiddleware, (req, res) => res.sendFile(path.join(__dirname, 'views/profile.html')));
app.get('/profile/edit', authMiddleware, (req, res) => res.sendFile(path.join(__dirname, 'views/edit_profile.html')));

// public user profile (view other users)
app.get('/user/:username', (req, res) => res.sendFile(path.join(__dirname, 'views/user_profile.html')));

// accounts managing page
app.get('/accounts', authMiddleware, (req, res) => res.sendFile(path.join(__dirname, 'views/accounts.html')));

// Post pages
app.get('/post/create', authMiddleware, (req, res) => res.sendFile(path.join(__dirname, 'views/create_post.html')));
app.get('/post/:id/edit', authMiddleware, (req, res) => res.sendFile(path.join(__dirname, 'views/edit_post.html')));
app.get('/post/:id', (req, res) => res.sendFile(path.join(__dirname, 'views/post.html')));

/* ------------------------
   API routes
   ------------------------ */

/* Auth: register, login, add-account, logout, switch, accounts list */
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
        password,
        // privacy setting: whether to show email on public profile
        showEmail: false,
        createdAt: new Date().toISOString()
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

    const token = jwt.sign({ id: user.id, email: user.email, username: user.username }, SECRET, { expiresIn: '2d' });
    res.cookie('token', token, { httpOnly: true });

    // add to accounts cookie list
    const existing = readAccountsFromReq(req);
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

    const token = jwt.sign({ id: user.id, email: user.email, username: user.username }, SECRET, { expiresIn: '2d' });
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

    if (!req.cookies.token) res.cookie('token', token, { httpOnly: true });

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
                res.cookie('token', token, { httpOnly: true });
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
                if (accounts.length > 0) res.cookie('token', accounts[0], { httpOnly: true });
                else res.clearCookie('token');
            }
        } catch {
            if (accounts.length > 0) res.cookie('token', accounts[0], { httpOnly: true });
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

/* Profile APIs */
app.get('/api/profile', authMiddleware, (req, res) => {
    const userId = req.user.id;
    const profile = JSON.parse(fs.readFileSync(getUserProfilePath(userId), 'utf8'));
    // owner view -> include email and showEmail flag
    const safe = { ...profile };
    delete safe.password;
    const followers = getFollowersForUser(userId) || [];
    const following = getFollowingForUser(userId) || [];
    res.json({ success: true, profile: safe, followersCount: followers.length, followingCount: following.length });
});

/**
 * Public profile endpoint:
 * - returns profile information
 * - will NOT include email unless profile.showEmail === true OR the requester is owner
 */
app.get('/api/user/:username', (req, res) => {
    const user = findUserByUsername(req.params.username);
    if (!user) return res.json({ success: false, msg: 'ไม่พบผู้ใช้' });

    const followers = getFollowersForUser(user._userId) || [];
    const following = getFollowingForUser(user._userId) || [];

    let myUsername = null;
    let myUserId = null;
    const token = req.cookies.token;
    if (token) {
        try {
            const p = jwt.verify(token, SECRET);
            myUsername = p.username;
            myUserId = p.id;
        } catch {}
    }

    const isFollowingFlag = myUserId ? isFollowing(myUserId, user._userId) : false;

    // Prepare public-safe profile object
    const publicProfile = { ...user };
    delete publicProfile.password;

    // If requester is not owner and user didn't opt-in to showEmail, strip email
    if (!myUserId || String(myUserId) !== String(user._userId)) {
        if (!publicProfile.showEmail) {
            delete publicProfile.email;
        }
    }

    res.json({
        success: true,
        profile: publicProfile,
        followersCount: followers.length,
        followingCount: following.length,
        isFollowing: isFollowingFlag,
        myUsername
    });
});

/* Update profile (owner only) - accept showEmail setting */
app.post('/api/profile/update', authMiddleware, (req, res) => {
    const userId = req.user.id;
    const profilePath = getUserProfilePath(userId);
    if (!fs.existsSync(profilePath)) return res.json({ success: false, msg: 'Profile missing' });

    const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    const { displayName, email, showEmail } = req.body;
    if (displayName) profile.displayName = displayName;
    // Allow owner to change email (optional)
    if (email) profile.email = email;
    // showEmail may be sent as boolean or string 'true'
    if (typeof showEmail !== 'undefined') {
        profile.showEmail = (showEmail === true || showEmail === 'true' || showEmail === '1' || showEmail === 1);
    }
    fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2), 'utf8');
    res.json({ success: true });
});

/* Follow / Unfollow and other APIs remain unchanged beyond previous implementation */
/* Follow / Unfollow */
app.post('/api/user/:username/follow', authMiddleware, (req, res) => {
    const target = findUserByUsername(req.params.username);
    if (!target) return res.json({ success: false, msg: 'Target not found' });
    const actorId = req.user.id;
    if (actorId === target._userId) return res.json({ success: false, msg: 'Cannot follow yourself' });

    addFollower(target._userId, actorId);

    // notify target of new follower (meta includes actor)
    addNotificationToUser(target._userId, 'new_follower', `${req.user.username} ติดตามคุณ`, { actorId, actorUsername: req.user.username });

    const followers = getFollowersForUser(target._userId) || [];
    res.json({ success: true, followersCount: followers.length });
});

app.post('/api/user/:username/unfollow', authMiddleware, (req, res) => {
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

/* Notifications API (unchanged) */
app.get('/api/notifications', authMiddleware, (req, res) => {
    const userId = req.user.id;
    const nots = getNotificationsForUser(userId);
    const unreadCount = nots.filter(n => !n.read).length;
    res.json({ success: true, notifications: nots, unread: unreadCount });
});
app.post('/api/notifications/mark-read', authMiddleware, (req, res) => {
    const userId = req.user.id;
    const { ids } = req.body;
    const updated = markNotificationsRead(userId, ids || []);
    res.json({ success: true, notifications: updated, unread: updated.filter(n => !n.read).length });
});

/* The rest of post/comment endpoints unchanged (omitted here for brevity if same as previous implementation) */
/* For completeness, include them as in the prior full server.js if needed. */

/* 404 fallback */
app.use((req, res) => {
    res.status(404).send('Not found');
});

/* Start server */
app.listen(PORT, () => {
    console.log(`Community app running at http://localhost:${PORT}`);
});