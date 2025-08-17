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

// static files serve as-is (ensure browser reads as utf-8, especially for HTML/JS/CSS)
app.use(express.static('public'));

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(cookieParser());

// Force charset=utf-8 for all API and HTML responses
app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
    }
    next();
});

// Utility functions
function safeReadJSON(filepath) {
    if (!fs.existsSync(filepath)) return null;
    return JSON.parse(fs.readFileSync(filepath, 'utf8'));
}
function safeWriteJSON(filepath, obj) {
    fs.writeFileSync(filepath, JSON.stringify(obj, null, 2), 'utf8');
}

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

// ----------- HTML Pages -----------
function sendHtml(res, file) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.sendFile(path.join(__dirname, file));
}
app.get('/', (req, res) => sendHtml(res, 'views/index.html'));
app.get('/login', (req, res) => sendHtml(res, 'views/login.html'));
app.get('/register', (req, res) => sendHtml(res, 'views/register.html'));
app.get('/profile', authMiddleware, (req, res) => sendHtml(res, 'views/profile.html'));
app.get('/profile/edit', authMiddleware, (req, res) => sendHtml(res, 'views/edit_profile.html'));
app.get('/user/:username', (req, res) => sendHtml(res, 'views/user_profile.html'));
app.get('/user/:username/posts', (req, res) => sendHtml(res, 'views/user_posts.html'));
app.get('/post/create', authMiddleware, (req, res) => sendHtml(res, 'views/create_post.html'));
app.get('/post/:id', (req, res) => sendHtml(res, 'views/post.html'));
app.get('/post/:id/edit', authMiddleware, (req, res) => sendHtml(res, 'views/edit_post.html'));
app.get('/404', (req, res) => sendHtml(res, 'views/404.html'));

// ----------- Multer for file upload -----------
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

// ----------- API -----------
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
    safeWriteJSON(getUserProfilePath(userId), profile);
    safeWriteJSON(path.join(userDir, 'posts.json'), []);
    safeWriteJSON(path.join(userDir, 'comments.json'), []);
    res.json({ success: true });
});
app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    const user = findUserByEmail(email);
    if (!user || user.password !== password)
        return res.json({ success: false, msg: 'Invalid credentials' });
    const token = jwt.sign({ id: user.id, email: user.email, username: user.username }, SECRET, { expiresIn: '2d' });
    res.cookie('token', token, { httpOnly: true });
    res.json({ success: true, token });
});
app.post('/api/logout', (req, res) => {
    res.clearCookie('token');
    res.json({ success: true });
});
app.post('/api/switch-account', (req, res) => {
    const { token } = req.body;
    if (!token) return res.json({ success: false, msg: 'No token' });
    try {
        jwt.verify(token, SECRET);
        res.cookie('token', token, { httpOnly: true });
        return res.json({ success: true });
    } catch {
        return res.json({ success: false, msg: 'Invalid token' });
    }
});
app.get('/api/profile', authMiddleware, (req, res) => {
    const userId = req.user.id;
    const profile = safeReadJSON(getUserProfilePath(userId));
    if (profile) delete profile.password;
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
    const profile = safeReadJSON(profilePath);
    if (displayName) profile.displayName = displayName;
    if (email) profile.email = email;
    safeWriteJSON(profilePath, profile);
    res.json({ success: true });
});
app.post('/api/profile/upload-pic', authMiddleware, upload.single('profilePic'), (req, res) => {
    const userId = req.user.id;
    const profilePath = getUserProfilePath(userId);
    const profile = safeReadJSON(profilePath);
    if (profile.profilePic && fs.existsSync(path.join(__dirname, 'public', profile.profilePic))) {
        fs.unlinkSync(path.join(__dirname, 'public', profile.profilePic));
    }
    profile.profilePic = '/uploads/profile_pics/' + req.file.filename;
    safeWriteJSON(profilePath, profile);
    res.json({ success: true, pic: profile.profilePic });
});
app.post('/api/profile/remove-pic', authMiddleware, (req, res) => {
    const userId = req.user.id;
    const profilePath = getUserProfilePath(userId);
    const profile = safeReadJSON(profilePath);
    if (profile.profilePic && fs.existsSync(path.join(__dirname, 'public', profile.profilePic))) {
        fs.unlinkSync(path.join(__dirname, 'public', profile.profilePic));
    }
    profile.profilePic = '';
    safeWriteJSON(profilePath, profile);
    res.json({ success: true });
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
    safeWriteJSON(getPostPath(postId), post);
    safeWriteJSON(getPostCommentsPath(postId), []);
    // update user's posts
    const userPostsPath = path.join(getUserDir(userId), 'posts.json');
    let userPosts = [];
    if (fs.existsSync(userPostsPath)) userPosts = safeReadJSON(userPostsPath);
    userPosts.unshift(postId);
    safeWriteJSON(userPostsPath, userPosts);
    res.json({ success: true, postId });
});
app.post('/api/post/:id/edit', authMiddleware, upload.single('postImage'), (req, res) => {
    const userId = req.user.id;
    const username = req.user.username;
    const postId = req.params.id;
    const postPath = getPostPath(postId);
    if (!fs.existsSync(postPath)) return res.json({ success: false, msg: 'Not found' });
    const post = safeReadJSON(postPath);
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
    safeWriteJSON(postPath, post);
    res.json({ success: true });
});
app.delete('/api/post/:id', authMiddleware, (req, res) => {
    const userId = req.user.id;
    const username = req.user.username;
    const postId = req.params.id;
    const postPath = getPostPath(postId);
    if (!fs.existsSync(postPath)) return res.json({ success: false, msg: 'Not found' });
    const post = safeReadJSON(postPath);
    if (post.username !== username) return res.json({ success: false, msg: 'Not owner' });
    if (post.image && fs.existsSync(path.join(__dirname, 'public', post.image))) {
        fs.unlinkSync(path.join(__dirname, 'public', post.image));
    }
    fs.rmSync(getPostDir(postId), { recursive: true, force: true });
    // update user's posts
    const userPostsPath = path.join(getUserDir(userId), 'posts.json');
    let userPosts = [];
    if (fs.existsSync(userPostsPath)) userPosts = safeReadJSON(userPostsPath);
    userPosts = userPosts.filter(pid => pid !== postId);
    safeWriteJSON(userPostsPath, userPosts);
    res.json({ success: true });
});
app.get('/api/post/:id', (req, res) => {
    const postId = req.params.id;
    const postPath = getPostPath(postId);
    if (!fs.existsSync(postPath)) return res.json({ success: false, msg: 'Not found' });
    const post = safeReadJSON(postPath);
    let comments = [];
    if (fs.existsSync(getPostCommentsPath(postId)))
        comments = safeReadJSON(getPostCommentsPath(postId));
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
        const post = safeReadJSON(getPostPath(postId));
        if (post) posts.push(post);
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
        const postIds = safeReadJSON(userPostsPath);
        for (let pid of postIds) {
            const post = safeReadJSON(getPostPath(pid));
            if (post) posts.push(post);
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
    if (fs.existsSync(commentsPath)) comments = safeReadJSON(commentsPath);
    comments.push(comment);
    safeWriteJSON(commentsPath, comments);
    // update user's comments
    const userObj = findUserByUsername(username);
    if (userObj) {
        const userCommentsPath = path.join(getUserDir(userObj._userId), 'comments.json');
        let userComments = [];
        if (fs.existsSync(userCommentsPath)) userComments = safeReadJSON(userCommentsPath);
        userComments.push(comment.id);
        safeWriteJSON(userCommentsPath, userComments);
    }
    res.json({ success: true });
});
app.delete('/api/post/:postId/comment/:commentId', authMiddleware, (req, res) => {
    const { postId, commentId } = req.params;
    const username = req.user.username;
    const commentsPath = getPostCommentsPath(postId);
    if (!fs.existsSync(commentsPath)) return res.json({ success: false, msg: 'Not found' });
    let comments = safeReadJSON(commentsPath);
    const idx = comments.findIndex(c => c.id === commentId && c.username === username);
    if (idx === -1) return res.json({ success: false, msg: 'Not owner' });
    comments.splice(idx, 1);
    safeWriteJSON(commentsPath, comments);
    res.json({ success: true });
});

// 404 fallback
app.use((req, res) => {
    res.status(404);
    sendHtml(res, 'views/404.html');
});

app.listen(PORT, () => {
    console.log(`Community app running at http://localhost:${PORT}`);
});