// server.js (updated - sliding session / 30d expiry)
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
const SESSION_DAYS = 30; // sliding window length in days
const SESSION_MAX_AGE = SESSION_DAYS * 24 * 60 * 60 * 1000; // ms

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
        // set maxAge to SESSION_MAX_AGE to align with sliding expiry window
        res.cookie('accounts', JSON.stringify(accounts), { httpOnly: false, maxAge: SESSION_MAX_AGE });
    } catch { /* ignore */ }
}
function filterValidAccounts(accounts) {
    const out = [];
    for (let token of accounts) {
        try {
            jwt.verify(token, SECRET);
            out.push(token);
        } catch { /* skip invalid/expired */ }
    }
    return out;
}

/* ------------------------
   Sliding session middleware
   - Refreshes all valid tokens in accounts cookie and active token cookie
   - New tokens expire in SESSION_DAYS (sliding window)
   ------------------------ */
app.use((req, res, next) => {
    try {
        // Refresh accounts cookie tokens
        const currentAccounts = readAccountsFromReq(req);
        const newAccounts = [];
        for (let t of currentAccounts) {
            try {
                const payload = jwt.verify(t, SECRET);
                // re-issue token with same payload and new expiry
                const newToken = jwt.sign({ id: payload.id, email: payload.email, username: payload.username }, SECRET, { expiresIn: `${SESSION_DAYS}d` });
                newAccounts.push(newToken);
            } catch {
                // skip expired/invalid
            }
        }
        // Write refreshed accounts cookie (may be empty)
        writeAccountsCookie(res, newAccounts);

        // Refresh active token if present
        const activeToken = req.cookies.token;
        if (activeToken) {
            try {
                const payload = jwt.verify(activeToken, SECRET);
                const newActive = jwt.sign({ id: payload.id, email: payload.email, username: payload.username }, SECRET, { expiresIn: `${SESSION_DAYS}d` });
                // Set HttpOnly token cookie with aligned maxAge
                res.cookie('token', newActive, { httpOnly: true, maxAge: SESSION_MAX_AGE });
                // Ensure accounts list contains a token for this username (replace if necessary)
                // Build a map by username from refreshed accounts
                const mapByUsername = {};
                for (let t of newAccounts) {
                    try {
                        const p = jwt.verify(t, SECRET);
                        mapByUsername[p.username] = t;
                    } catch {}
                }
                mapByUsername[payload.username] = newActive; // ensure active included
                // replace newAccounts array from map to keep one token per username
                const finalAccounts = Object.values(mapByUsername);
                writeAccountsCookie(res, finalAccounts);
            } catch {
                // active token invalid/expired -> clear active cookie
                res.clearCookie('token');
            }
        }
    } catch (e) {
        // fail-safe: do not block requests on middleware error
        console.error('slidingSessionMiddleware error:', e && e.message);
    }
    next();
});

/* ------------------------
   HTML pages routes
   ------------------------ */
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'views/index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'views/login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'views/register.html')));

// personal profile page (requires auth)
app.get('/profile', authMiddleware, (req, res) => res.sendFile(path.join(__dirname, 'views/profile.html')));
app.get('/profile/edit', authMiddleware, (req, res) => res.sendFile(path.join(__dirname, 'views/edit_profile.html')));

// public user profile
app.get('/user/:username', (req, res) => res.sendFile(path.join(__dirname, 'views/user_profile.html')));

// accounts page
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

    // create token with SESSION_DAYS expiry
    const token = jwt.sign({ id: user.id, email: user.email, username: user.username }, SECRET, { expiresIn: `${SESSION_DAYS}d` });
    // set active session cookie (HttpOnly) with maxAge
    res.cookie('token', token, { httpOnly: true, maxAge: SESSION_MAX_AGE });

    // also add to accounts cookie list (store token strings) so client can see added accounts
    const existing = readAccountsFromReq(req);
    let valid = filterValidAccounts(existing);
    const already = valid.find(t => {
        try { return jwt.verify(t, SECRET).username === user.username; } catch { return false; }
    });
    if (!already) {
        valid.push(token);
    } else {
        // replace existing token for that username with new token
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

    // push token into accounts cookie (but do not set active token cookie)
    let accounts = readAccountsFromReq(req);
    accounts = filterValidAccounts(accounts);
    const exists = accounts.find(t => {
        try { return jwt.verify(t, SECRET).username === user.username; } catch { return false; }
    });
    if (!exists) accounts.push(token);
    else {
        // replace existing token for same username
        accounts = accounts.map(t => {
            try {
                const p = jwt.verify(t, SECRET);
                if (p.username === user.username) return token;
                return t;
            } catch { return null; }
        }).filter(Boolean);
    }
    writeAccountsCookie(res, accounts);

    // if no active token currently set, make this one active
    if (!req.cookies.token) {
        res.cookie('token', token, { httpOnly: true, maxAge: SESSION_MAX_AGE });
    }

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
                // set as active
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
    // if active token belonged to removed username, change active to first available or clear
    const activeToken = req.cookies.token;
    if (activeToken) {
        try {
            const p = jwt.verify(activeToken, SECRET);
            if (p.username === username) {
                if (accounts.length > 0) {
                    res.cookie('token', accounts[0], { httpOnly: true, maxAge: SESSION_MAX_AGE });
                } else {
                    res.clearCookie('token');
                }
            }
        } catch {
            // invalid active token -> set first if exists
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
            // get displayName from user profile if exists
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
        try {
            active = jwt.verify(activeToken, SECRET).username;
        } catch { active = null; }
    }
    res.json({ success: true, accounts: out, active });
});

/* Profile APIs */
app.get('/api/profile', authMiddleware, (req, res) => {
    const userId = req.user.id;
    const profileRaw = JSON.parse(fs.readFileSync(getUserProfilePath(userId), 'utf8'));
    const profile = { ...profileRaw };
    delete profile.password;
    if (typeof profile.showEmail === 'undefined') profile.showEmail = false;
    const followers = getFollowersForUser(userId) || [];
    const following = getFollowingForUser(userId) || [];
    res.json({ success: true, profile, followersCount: followers.length, followingCount: following.length });
});

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
        try {
            const p = jwt.verify(token, SECRET);
            myUsername = p.username;
            myUserId = p.id;
        } catch {}
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

/* Update profile (owner) */
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

/* Follow / Unfollow */
app.post('/api/user/:username/follow', authMiddleware, (req, res) => {
    const target = findUserByUsername(req.params.username);
    if (!target) return res.json({ success: false, msg: 'Target not found' });
    const actorId = req.user.id;
    if (actorId === target._userId) return res.json({ success: false, msg: 'Cannot follow yourself' });

    addFollower(target._userId, actorId);
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

/* Notifications API */
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

/* Posts & Comments (unchanged logic) */

app.post('/api/post/create', authMiddleware, upload.single('postImage'), (req, res) => {
    const userId = req.user.id;
    const username = req.user.username;
    const { title, content } = req.body;
    if (!title || !content) return res.json({ success: false, msg: 'Missing fields' });

    const postId = uuidv4();
    const postDir = getPostDir(postId);
    fs.mkdirSync(postDir, { recursive: true });

    let img = '';
    if (req.file) img = '/uploads/post_images/' + req.file.filename;

    const post = {
        id: postId,
        username,
        title,
        content,
        image: img,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
    fs.writeFileSync(getPostPath(postId), JSON.stringify(post, null, 2), 'utf8');
    fs.writeFileSync(getPostCommentsPath(postId), '[]', 'utf8');

    const userPostsPath = path.join(getUserDir(userId), 'posts.json');
    let userPosts = [];
    if (fs.existsSync(userPostsPath)) userPosts = JSON.parse(fs.readFileSync(userPostsPath, 'utf8'));
    userPosts.unshift(postId);
    fs.writeFileSync(userPostsPath, JSON.stringify(userPosts, null, 2), 'utf8');

    try {
        const followers = getFollowersForUser(userId) || [];
        for (let followerId of followers) {
            addNotificationToUser(followerId, 'new_post', `${username} โพสต์ใหม่: "${title}"`, { postId, actorId: userId, actorUsername: username });
        }
    } catch (e) {
        console.error('notify followers error', e && e.message);
    }

    res.json({ success: true, postId });
});

app.post('/api/post/:id/edit', authMiddleware, upload.single('postImage'), (req, res) => {
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
            fs.unlinkSync(path.join(__dirname, 'public', post.image));
        }
        post.image = '/uploads/post_images/' + req.file.filename;
    }
    post.updatedAt = new Date().toISOString();
    fs.writeFileSync(postPath, JSON.stringify(post, null, 2), 'utf8');
    res.json({ success: true });
});

app.delete('/api/post/:id', authMiddleware, (req, res) => {
    const userId = req.user.id;
    const username = req.user.username;
    const postId = req.params.id;
    const postPath = getPostPath(postId);
    if (!fs.existsSync(postPath)) return res.json({ success: false, msg: 'Not found' });
    const post = JSON.parse(fs.readFileSync(postPath, 'utf8'));
    if (post.username !== username) return res.json({ success: false, msg: 'Not owner' });
    if (post.image && fs.existsSync(path.join(__dirname, 'public', post.image))) {
        fs.unlinkSync(path.join(__dirname, 'public', post.image));
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
        try { myUsername = jwt.verify(token, SECRET).username; } catch {}
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

    const userObj = findUserByUsername(username);
    if (userObj) {
        const userCommentsPath = path.join(getUserDir(userObj._userId), 'comments.json');
        let userComments = [];
        if (fs.existsSync(userCommentsPath)) userComments = JSON.parse(fs.readFileSync(userCommentsPath, 'utf8'));
        userComments.push(comment.id);
        fs.writeFileSync(userCommentsPath, JSON.stringify(userComments, null, 2), 'utf8');
    }

    try {
        const post = JSON.parse(fs.readFileSync(getPostPath(postId), 'utf8'));
        if (post && post.username && post.username !== username) {
            const ownerObj = findUserByUsername(post.username);
            if (ownerObj) {
                addNotificationToUser(ownerObj._userId, 'comment', `${username} แสดงความคิดเห็นในโพสต์ของคุณ`, { postId, commentId: comment.id, actorId: userObj && userObj._userId, actorUsername: username });
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