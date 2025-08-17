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

function findUserByUsername(usernameRaw) {
    const username = decodeURIComponent(usernameRaw);
    const userDirs = fs.readdirSync(USERS_DIR);
    for (let userId of userDirs) {
        const profilePath = path.join(USERS_DIR, userId, 'profile.json');
        if (fs.existsSync(profilePath)) {
            const user = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
            if (user.username === username) {
                delete user.password;
                return { ...user, _userId: userId };
            }
        }
    }
    return null;
}
function findUserByEmail(email) {
    const userDirs = fs.readdirSync(USERS_DIR);
    for (let userId of userDirs) {
        const profilePath = path.join(USERS_DIR, userId, 'profile.json');
        if (fs.existsSync(profilePath)) {
            const user = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
            if (user.email === email) return user;
        }
    }
    return null;
}
function getUserDir(userId) {
    return path.join(USERS_DIR, userId);
}
function getUserProfilePath(userId) {
    return path.join(USERS_DIR, userId, 'profile.json');
}
function getPostDir(postId) {
    return path.join(POSTS_DIR, postId);
}
function getPostPath(postId) {
    return path.join(POSTS_DIR, postId, 'post.json');
}
function getPostCommentsPath(postId) {
    return path.join(POSTS_DIR, postId, 'comments.json');
}
function authMiddleware(req, res, next) {
    const token = req.cookies.token;
    if (!token) return res.redirect('/login');
    try {
        req.user = jwt.verify(token, SECRET);
        next();
    } catch {
        res.clearCookie('token');
        res.redirect('/login');
    }
}

// Notifications helpers (store per-user in users/{id}/notifications.json)
function ensureUserNotificationsFile(userId) {
    const p = path.join(getUserDir(userId), 'notifications.json');
    if (!fs.existsSync(p)) fs.writeFileSync(p, '[]', 'utf8');
    return p;
}
function addNotificationToUser(userId, type, message, meta = {}) {
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
}
function getNotificationsForUser(userId) {
    const p = ensureUserNotificationsFile(userId);
    const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
    return arr;
}
function markNotificationsRead(userId, ids = []) {
    const p = ensureUserNotificationsFile(userId);
    let arr = JSON.parse(fs.readFileSync(p, 'utf8'));
    let changed = false;
    if (!Array.isArray(ids) || ids.length === 0) {
        // mark all read
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

// -- Helpers for accounts-in-cookie (client-visible list) --
function readAccountsFromReq(req) {
    try {
        const s = req.cookies.accounts;
        if (!s) return [];
        const parsed = JSON.parse(s);
        if (!Array.isArray(parsed)) return [];
        return parsed;
    } catch {
        return [];
    }
}
function writeAccountsCookie(res, accounts) {
    try {
        // store array of token strings as JSON in a non-HttpOnly cookie so client can read list
        res.cookie('accounts', JSON.stringify(accounts), { httpOnly: false });
    } catch {
        // ignore
    }
}
function filterValidAccounts(accounts) {
    const out = [];
    for (let token of accounts) {
        try {
            const payload = jwt.verify(token, SECRET);
            out.push(token);
        } catch {
            // skip invalid/expired
        }
    }
    return out;
}

// HTML pages
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'views/index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'views/login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'views/register.html')));
app.get('/profile', authMiddleware, (req, res) => res.sendFile(path.join(__dirname, 'views/user_profile.html')));
app.get('/profile/edit', authMiddleware, (req, res) => res.sendFile(path.join(__dirname, 'views/edit_profile.html')));
app.get('/user/:username', (req, res) => res.sendFile(path.join(__dirname, 'views/user_profile.html')));
app.get('/accounts', authMiddleware, (req, res) => res.sendFile(path.join(__dirname, 'views/accounts.html'))); // manage accounts page

// API: Auth/Register/Login/AddAccount/Logout/Switch/AccountsList
app.post('/api/register', (req, res) => {
    const { username, email, password } = req.body;
    if (!username || !email || !password)
        return res.json({ success: false, msg: 'Missing fields' });
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
        createdAt: new Date().toISOString()
    };
    fs.writeFileSync(getUserProfilePath(userId), JSON.stringify(profile, null, 2), 'utf8');
    fs.writeFileSync(path.join(userDir, 'posts.json'), '[]', 'utf8');
    fs.writeFileSync(path.join(userDir, 'comments.json'), '[]', 'utf8');
    fs.writeFileSync(path.join(userDir, 'notifications.json'), '[]', 'utf8');
    res.json({ success: true });
});
app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    const user = findUserByEmail(email);
    if (!user || user.password !== password)
        return res.json({ success: false, msg: 'Invalid credentials' });
    const token = jwt.sign({ id: user.id, email: user.email, username: user.username }, SECRET, { expiresIn: '2d' });
    // set active session cookie (HttpOnly)
    res.cookie('token', token, { httpOnly: true });

    // also add to accounts cookie list (store token strings) so client can see added accounts
    const existing = readAccountsFromReq(req);
    // keep only valid tokens, avoid duplicates for same username
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

// เพิ่มบัญชีแบบ "เพิ่มเข้ารายการบัญชี" โดยไม่เปลี่ยนบัญชี active
app.post('/api/add-account', (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.json({ success: false, msg: 'Missing fields' });
    const user = findUserByEmail(email);
    if (!user || user.password !== password) return res.json({ success: false, msg: 'Invalid credentials' });
    const token = jwt.sign({ id: user.id, email: user.email, username: user.username }, SECRET, { expiresIn: '2d' });

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
        res.cookie('token', token, { httpOnly: true });
    }

    res.json({ success: true, username: user.username });
});

// logout clears active token (but keep accounts list)
app.post('/api/logout', (req, res) => {
    res.clearCookie('token');
    res.json({ success: true });
});

// switch active account: body { username }
app.post('/api/accounts/switch', (req, res) => {
    const { username } = req.body;
    if (!username) return res.json({ success: false, msg: 'Missing username' });
    const accounts = filterValidAccounts(readAccountsFromReq(req));
    for (let token of accounts) {
        try {
            const p = jwt.verify(token, SECRET);
            if (p.username === username) {
                // set as active
                res.cookie('token', token, { httpOnly: true });
                return res.json({ success: true });
            }
        } catch {}
    }
    return res.json({ success: false, msg: 'Account not found' });
});

// remove an account from saved list; body { username }
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
                    res.cookie('token', accounts[0], { httpOnly: true });
                } else {
                    res.clearCookie('token');
                }
            }
        } catch {
            // invalid active token -> set first if exists
            if (accounts.length > 0) res.cookie('token', accounts[0], { httpOnly: true });
            else res.clearCookie('token');
        }
    } else {
        if (accounts.length === 0) res.clearCookie('token');
    }
    res.json({ success: true });
});

// return list of saved accounts with minimal info and indicate active username
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

// backward compatibility for token-based switch (kept)
app.post('/api/switch-account', (req, res) => {
    const { token } = req.body;
    if (!token) return res.json({ success: false, msg: 'No token' });
    try {
        jwt.verify(token, SECRET);
        res.cookie('token', token, { httpOnly: true });
        // also ensure it's in accounts cookie
        let accounts = filterValidAccounts(readAccountsFromReq(req));
        if (!accounts.includes(token)) {
            accounts.push(token);
            writeAccountsCookie(res, accounts);
        }
        return res.json({ success: true });
    } catch {
        return res.json({ success: false, msg: 'Invalid token' });
    }
});

app.get('/api/profile', authMiddleware, (req, res) => {
    const userId = req.user.id;
    const profile = JSON.parse(fs.readFileSync(getUserProfilePath(userId), 'utf8'));
    delete profile.password;
    res.json({ success: true, profile });
});
app.get('/api/user/:username', (req, res) => {
    const user = findUserByUsername(req.params.username);
    if (!user) return res.json({ success: false, msg: 'ไม่พบผู้ใช้' });
    res.json({ success: true, profile: user });
});
app.post('/api/profile/update', authMiddleware, (req, res) => {
    const userId = req.user.id;
    const { displayName, email } = req.body;
    const profilePath = getUserProfilePath(userId);
    const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    if (displayName) profile.displayName = displayName;
    if (email) profile.email = email;
    fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2), 'utf8');
    res.json({ success: true });
});
app.post('/api/profile/upload-pic', authMiddleware, upload.single('profilePic'), (req, res) => {
    const userId = req.user.id;
    const profilePath = getUserProfilePath(userId);
    const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    if (profile.profilePic && fs.existsSync(path.join(__dirname, 'public', profile.profilePic))) {
        fs.unlinkSync(path.join(__dirname, 'public', profile.profilePic));
    }
    profile.profilePic = '/uploads/profile_pics/' + req.file.filename;
    fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2), 'utf8');
    res.json({ success: true, pic: profile.profilePic });
});
app.post('/api/profile/remove-pic', authMiddleware, (req, res) => {
    const userId = req.user.id;
    const profilePath = getUserProfilePath(userId);
    const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    if (profile.profilePic && fs.existsSync(path.join(__dirname, 'public', profile.profilePic))) {
        fs.unlinkSync(path.join(__dirname, 'public', profile.profilePic));
    }
    profile.profilePic = '';
    fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2), 'utf8');
    res.json({ success: true });
});

// Notifications API
app.get('/api/notifications', authMiddleware, (req, res) => {
    const userId = req.user.id;
    const nots = getNotificationsForUser(userId);
    const unreadCount = nots.filter(n => !n.read).length;
    res.json({ success: true, notifications: nots, unread: unreadCount });
});
app.post('/api/notifications/mark-read', authMiddleware, (req, res) => {
    const userId = req.user.id;
    const { ids } = req.body; // optional array of ids; if absent, mark all read
    const updated = markNotificationsRead(userId, ids || []);
    res.json({ success: true, notifications: updated, unread: updated.filter(n => !n.read).length });
});

// expose simple account settings endpoint (read-only summary)
app.get('/api/account/settings', authMiddleware, (req, res) => {
    const userId = req.user.id;
    const profile = JSON.parse(fs.readFileSync(getUserProfilePath(userId), 'utf8'));
    delete profile.password;
    // example security metadata
    const settings = {
        profile,
        security: {
            twoFactorEnabled: false,
            sessions: [] // in future could list sessions
        },
        preferences: {
            emailNotifications: true
        }
    };
    res.json({ success: true, settings });
});

// --- POST CRUD ---
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
    // update user's posts
    const userPostsPath = path.join(getUserDir(userId), 'posts.json');
    let userPosts = [];
    if (fs.existsSync(userPostsPath)) userPosts = JSON.parse(fs.readFileSync(userPostsPath, 'utf8'));
    userPosts.unshift(postId);
    fs.writeFileSync(userPostsPath, JSON.stringify(userPosts, null, 2), 'utf8');

    // create a notification to self (example)
    addNotificationToUser(userId, 'post_created', `คุณได้สร้างโพสต์ "${title}"`, { postId });

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
    // update user's posts
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
    if (fs.existsSync(getPostCommentsPath(postId)))
        comments = JSON.parse(fs.readFileSync(getPostCommentsPath(postId), 'utf8'));
    let myUsername = null;
    const token = req.cookies.token;
    if (token) {
        try {
            myUsername = jwt.verify(token, SECRET).username;
        } catch {}
    }
    res.json({ success: true, post, comments, owner: post.username, myUsername });
});
app.get('/api/posts', (req, res) => {
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

// --- COMMENT CRUD ---
app.post('/api/post/:id/comment', authMiddleware, (req, res) => {
    const postId = req.params.id;
    const username = req.user.username;
    const { content } = req.body;
    if (!content) return res.json({ success: false, msg: 'Empty comment' });
    const comment = {
        id: uuidv4(),
        postId,
        username,
        content,
        createdAt: new Date().toISOString()
    };
    const commentsPath = getPostCommentsPath(postId);
    let comments = [];
    if (fs.existsSync(commentsPath)) comments = JSON.parse(fs.readFileSync(commentsPath, 'utf8'));
    comments.push(comment);
    fs.writeFileSync(commentsPath, JSON.stringify(comments, null, 2), 'utf8');
    // update user's comments
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
                addNotificationToUser(ownerObj._userId, 'comment', `${username} แสดงความคิดเห็นในโพสต์ของคุณ`, { postId, commentId: comment.id });
            }
        }
    } catch {}
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

// 404 fallback
app.use((req, res) => {
    res.status(404).send('Not found');
});

app.listen(PORT, () => {
    console.log(`Community app running at http://localhost:${PORT}`);
});