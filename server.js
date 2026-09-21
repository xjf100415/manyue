/**
 * JM Clone - 个人漫画/图片浏览平台
 * 管理员可上传图片，访客仅浏览
 */

const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;

// ============ 配置 ============

// 管理员密码 (建议修改为自己的密码，首次启动会自动生成默认密码)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'bBtz6169';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

// 数据存储路径 - Render 持久化磁盘优先，本地回退
const PERSISTENT_DIR = process.env.RENDER_DISK_PATH || '/opt/data';
const IS_RENDER = !!process.env.RENDER || !!process.env.RENDER_SERVICE_ID;

const DATA_DIR = IS_RENDER && fs.existsSync(PERSISTENT_DIR)
  ? path.join(PERSISTENT_DIR, 'data')
  : path.join(__dirname, 'data');
const UPLOADS_DIR = IS_RENDER && fs.existsSync(PERSISTENT_DIR)
  ? path.join(PERSISTENT_DIR, 'uploads')
  : path.join(__dirname, 'public', 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');

// 确保目录存在
[DATA_DIR, UPLOADS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// ============ 数据库 (JSON 文件存储) ============

function loadDB() {
  if (fs.existsSync(DB_FILE)) {
    const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
    // 兼容旧数据：确保字段存在
    if (!data.announcements) data.announcements = [];
    if (!data.nextAnnouncementId) data.nextAnnouncementId = 1;
    if (!data.users) data.users = {};
    return data;
  }
  const emptyDB = { comics: [], nextId: 1, announcements: [], nextAnnouncementId: 1, users: {} };
  saveDB(emptyDB);
  return emptyDB;
}

function saveDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

let db = loadDB();

// ============ 中间件 ============

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24小时
  }
}));

// 静态文件
app.use(express.static(path.join(__dirname, 'public')));

// 上传文件 - 从持久化磁盘提供 (Render 部署时)
if (IS_RENDER && UPLOADS_DIR.includes(PERSISTENT_DIR)) {
  app.use('/uploads', express.static(UPLOADS_DIR));
}

// 管理员认证中间件
function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) {
    return next();
  }
  return res.status(401).json({ error: '请先登录管理员账号' });
}

// 设备识别：通过 X-Device-Id 请求头识别用户设备
function getDeviceId(req) {
  const deviceId = req.get('X-Device-Id');
  if (!deviceId || typeof deviceId !== 'string') return null;
  const id = deviceId.trim();
  if (!id) return null;
  return id.slice(0, 128);
}

// 获取或创建某个设备对应的用户数据
function getOrCreateUser(deviceId) {
  if (!db.users) db.users = {};
  if (!db.users[deviceId]) {
    db.users[deviceId] = {
      history: [],
      favorites: [],
      stats: {
        readingStreakDays: 0,
        lastReadDate: null
      }
    };
    saveDB(db);
  }
  return db.users[deviceId];
}

// ============ Multer 文件上传配置 ============

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const comicId = req.body.comicId || 'temp';
    const chapterId = req.body.chapterId || 'temp';
    const dir = path.join(UPLOADS_DIR, comicId, chapterId);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    // 保持原始文件名，但加上时间戳避免冲突
    const ext = path.extname(file.originalname);
    const name = path.basename(file.originalname, ext);
    cb(null, `${name}-${Date.now()}${ext}`);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB 单文件限制
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('仅支持图片文件 (jpg, png, gif, webp, bmp)'));
    }
  }
});

// ============ API 路由 ============

// ---- 认证相关 ----

// 管理员登录
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    res.json({ success: true, message: '登录成功' });
  } else {
    res.status(401).json({ error: '密码错误' });
  }
});

// 管理员登出
app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true, message: '已登出' });
});

// 检查登录状态
app.get('/api/auth/status', (req, res) => {
  res.json({ isAdmin: !!(req.session && req.session.isAdmin) });
});

// ---- 漫画相关 (公开接口) ----

// 获取所有漫画列表
app.get('/api/comics', (req, res) => {
  const comics = db.comics.map(c => ({
    id: c.id,
    title: c.title,
    cover: c.cover,
    description: c.description,
    tags: c.tags || [],
    chapterCount: (c.chapters || []).length,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt
  }));
  res.json(comics);
});

// 获取单个漫画详情
app.get('/api/comics/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const comic = db.comics.find(c => c.id === id);
  if (!comic) {
    return res.status(404).json({ error: '漫画不存在' });
  }
  res.json({
    id: comic.id,
    title: comic.title,
    cover: comic.cover,
    description: comic.description,
    tags: comic.tags || [],
    chapters: (comic.chapters || []).map(ch => ({
      id: ch.id,
      title: ch.title,
      pageCount: (ch.pages || []).length,
      readMode: ch.readMode || 'page',
      createdAt: ch.createdAt
    })),
    createdAt: comic.createdAt,
    updatedAt: comic.updatedAt
  });
});

// 获取章节页面 (公开接口，返回图片路径列表)
app.get('/api/comics/:comicId/chapters/:chapterId', (req, res) => {
  const comicId = parseInt(req.params.comicId);
  const chapterId = parseInt(req.params.chapterId);
  const comic = db.comics.find(c => c.id === comicId);
  if (!comic) {
    return res.status(404).json({ error: '漫画不存在' });
  }
  const chapter = (comic.chapters || []).find(ch => ch.id === chapterId);
  if (!chapter) {
    return res.status(404).json({ error: '章节不存在' });
  }
  res.json({
    comicId: comic.id,
    comicTitle: comic.title,
    chapterId: chapter.id,
    chapterTitle: chapter.title,
    pages: chapter.pages || [],
    readMode: chapter.readMode || 'page',
    totalChapters: comic.chapters.length,
    currentChapterIndex: comic.chapters.findIndex(ch => ch.id === chapterId)
  });
});

// ---- 公告接口 (公开) ----

// 获取最新公告列表
app.get('/api/announcements', (req, res) => {
  const announcements = (db.announcements || [])
    .filter(a => a.active)
    .sort((a, b) => b.createdAt - a.createdAt);
  res.json(announcements.map(a => ({
    id: a.id,
    title: a.title,
    content: a.content,
    type: a.type || 'info',
    createdAt: a.createdAt
  })));
});

// ---- 搜索接口 (公开) ----

// 搜索漫画 (按标题、标签、描述)
app.get('/api/search', (req, res) => {
  try {
    const q = (req.query.q || '').toString().trim().toLowerCase();
    if (!q) {
      return res.json([]);
    }
    const results = db.comics.filter(c => {
      const title = (c.title || '').toLowerCase();
      const description = (c.description || '').toLowerCase();
      const tags = (c.tags || []).map(t => String(t).toLowerCase());
      return title.includes(q) || description.includes(q) || tags.some(t => t.includes(q));
    }).map(c => ({
      id: c.id,
      title: c.title,
      cover: c.cover,
      description: c.description,
      tags: c.tags || [],
      chapterCount: (c.chapters || []).length,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt
    }));
    res.json(results);
  } catch (err) {
    console.error('搜索失败:', err);
    res.status(500).json({ error: '搜索失败' });
  }
});

// ---- 用户阅读历史 / 收藏 / 统计 (基于设备识别) ----

// 记录阅读历史
app.post('/api/user/history', (req, res) => {
  try {
    const deviceId = getDeviceId(req);
    if (!deviceId) {
      return res.status(400).json({ error: '缺少 X-Device-Id 请求头' });
    }
    const { comicId, chapterId, comicTitle, chapterTitle, page, totalPages } = req.body;
    if (comicId === undefined || chapterId === undefined) {
      return res.status(400).json({ error: '缺少漫画或章节信息' });
    }
    const user = getOrCreateUser(deviceId);
    const now = Date.now();
    const numComicId = Number(comicId);
    const numChapterId = Number(chapterId);
    const entry = {
      id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
      comicId: numComicId,
      chapterId: numChapterId,
      comicTitle: comicTitle || '',
      chapterTitle: chapterTitle || '',
      page: page !== undefined ? Number(page) : 0,
      totalPages: totalPages !== undefined ? Number(totalPages) : 0,
      readAt: now
    };
    // 同一漫画同一章节更新已有记录，避免重复
    const existingIndex = user.history.findIndex(h => h.comicId === numComicId && h.chapterId === numChapterId);
    if (existingIndex !== -1) {
      entry.id = user.history[existingIndex].id;
      user.history[existingIndex] = entry;
    } else {
      user.history.unshift(entry);
    }
    // 限制历史记录数量
    if (user.history.length > 100) {
      user.history = user.history.slice(0, 100);
    }
    // 更新阅读连续天数
    if (!user.stats) user.stats = {};
    const todayStr = new Date(now).toISOString().slice(0, 10);
    const yesterdayStr = new Date(now - 86400000).toISOString().slice(0, 10);
    const last = user.stats.lastReadDate;
    if (last !== todayStr) {
      if (last === yesterdayStr) {
        user.stats.readingStreakDays = (user.stats.readingStreakDays || 0) + 1;
      } else {
        user.stats.readingStreakDays = 1;
      }
      user.stats.lastReadDate = todayStr;
    }
    saveDB(db);
    res.json({ success: true, history: entry });
  } catch (err) {
    console.error('记录阅读历史失败:', err);
    res.status(500).json({ error: '记录阅读历史失败' });
  }
});

// 获取阅读历史 (最近 20 条，按时间倒序)
app.get('/api/user/history', (req, res) => {
  try {
    const deviceId = getDeviceId(req);
    if (!deviceId) {
      return res.status(400).json({ error: '缺少 X-Device-Id 请求头' });
    }
    const user = getOrCreateUser(deviceId);
    const history = (user.history || []).slice(0, 20);
    res.json(history);
  } catch (err) {
    console.error('获取阅读历史失败:', err);
    res.status(500).json({ error: '获取阅读历史失败' });
  }
});

// 删除单条阅读历史
app.delete('/api/user/history/:id', (req, res) => {
  try {
    const deviceId = getDeviceId(req);
    if (!deviceId) {
      return res.status(400).json({ error: '缺少 X-Device-Id 请求头' });
    }
    const user = getOrCreateUser(deviceId);
    const index = (user.history || []).findIndex(h => h.id === req.params.id);
    if (index === -1) {
      return res.status(404).json({ error: '历史记录不存在' });
    }
    user.history.splice(index, 1);
    saveDB(db);
    res.json({ success: true });
  } catch (err) {
    console.error('删除阅读历史失败:', err);
    res.status(500).json({ error: '删除阅读历史失败' });
  }
});

// 添加收藏
app.post('/api/user/favorites', (req, res) => {
  try {
    const deviceId = getDeviceId(req);
    if (!deviceId) {
      return res.status(400).json({ error: '缺少 X-Device-Id 请求头' });
    }
    const { comicId, comicTitle, cover } = req.body;
    if (comicId === undefined) {
      return res.status(400).json({ error: '缺少漫画 ID' });
    }
    const user = getOrCreateUser(deviceId);
    const numComicId = Number(comicId);
    // 去重
    const existing = user.favorites.find(f => f.comicId === numComicId);
    if (existing) {
      return res.json({ success: true, message: '已收藏', favorite: existing });
    }
    const favorite = {
      comicId: numComicId,
      comicTitle: comicTitle || '',
      cover: cover || null,
      addedAt: Date.now()
    };
    user.favorites.push(favorite);
    saveDB(db);
    res.json({ success: true, favorite });
  } catch (err) {
    console.error('添加收藏失败:', err);
    res.status(500).json({ error: '添加收藏失败' });
  }
});

// 获取收藏列表
app.get('/api/user/favorites', (req, res) => {
  try {
    const deviceId = getDeviceId(req);
    if (!deviceId) {
      return res.status(400).json({ error: '缺少 X-Device-Id 请求头' });
    }
    const user = getOrCreateUser(deviceId);
    res.json(user.favorites || []);
  } catch (err) {
    console.error('获取收藏列表失败:', err);
    res.status(500).json({ error: '获取收藏列表失败' });
  }
});

// 取消收藏
app.delete('/api/user/favorites/:comicId', (req, res) => {
  try {
    const deviceId = getDeviceId(req);
    if (!deviceId) {
      return res.status(400).json({ error: '缺少 X-Device-Id 请求头' });
    }
    const user = getOrCreateUser(deviceId);
    const numComicId = Number(req.params.comicId);
    const index = user.favorites.findIndex(f => f.comicId === numComicId);
    if (index === -1) {
      return res.status(404).json({ error: '收藏不存在' });
    }
    user.favorites.splice(index, 1);
    saveDB(db);
    res.json({ success: true });
  } catch (err) {
    console.error('取消收藏失败:', err);
    res.status(500).json({ error: '取消收藏失败' });
  }
});

// 获取用户统计
app.get('/api/user/stats', (req, res) => {
  try {
    const deviceId = getDeviceId(req);
    if (!deviceId) {
      return res.status(400).json({ error: '缺少 X-Device-Id 请求头' });
    }
    const user = getOrCreateUser(deviceId);
    const history = user.history || [];
    const readComicIds = new Set(history.map(h => h.comicId));
    const readChapterKeys = new Set(history.map(h => `${h.comicId}-${h.chapterId}`));
    const totalPagesRead = history.reduce((sum, h) => sum + (h.page || 0), 0);
    res.json({
      totalReadComics: readComicIds.size,
      totalChaptersRead: readChapterKeys.size,
      totalPagesRead,
      readingStreakDays: user.stats.readingStreakDays || 0,
      lastReadDate: user.stats.lastReadDate || null
    });
  } catch (err) {
    console.error('获取用户统计失败:', err);
    res.status(500).json({ error: '获取用户统计失败' });
  }
});

// 获取所有公告 (含已禁用的，管理端用)
app.get('/api/admin/announcements/all', requireAdmin, (req, res) => {
  const announcements = (db.announcements || [])
    .sort((a, b) => b.createdAt - a.createdAt);
  res.json(announcements.map(a => ({
    id: a.id,
    title: a.title,
    content: a.content,
    type: a.type || 'info',
    active: a.active,
    createdAt: a.createdAt
  })));
});

// 发布公告
app.post('/api/admin/announcements', requireAdmin, (req, res) => {
  const { title, content, type } = req.body;
  if (!title || !content) {
    return res.status(400).json({ error: '请填写公告标题和内容' });
  }
  const announcement = {
    id: db.nextAnnouncementId++,
    title,
    content,
    type: type || 'info',
    active: true,
    createdAt: Date.now()
  };
  db.announcements.push(announcement);
  saveDB(db);
  res.json({ success: true, announcement });
});

// 更新公告
app.put('/api/admin/announcements/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const announcement = db.announcements.find(a => a.id === id);
  if (!announcement) {
    return res.status(404).json({ error: '公告不存在' });
  }
  const { title, content, type, active } = req.body;
  if (title !== undefined) announcement.title = title;
  if (content !== undefined) announcement.content = content;
  if (type !== undefined) announcement.type = type;
  if (active !== undefined) announcement.active = active;
  saveDB(db);
  res.json({ success: true, announcement });
});

// 删除公告
app.delete('/api/admin/announcements/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const index = db.announcements.findIndex(a => a.id === id);
  if (index === -1) {
    return res.status(404).json({ error: '公告不存在' });
  }
  db.announcements.splice(index, 1);
  saveDB(db);
  res.json({ success: true });
});

// ---- 管理员接口 (需要登录) ----

// 创建新漫画
app.post('/api/admin/comics', requireAdmin, (req, res) => {
  const { title, description, tags, cover } = req.body;
  if (!title) {
    return res.status(400).json({ error: '请填写漫画标题' });
  }
  const now = Date.now();
  const comic = {
    id: db.nextId++,
    title,
    description: description || '',
    tags: tags || [],
    cover: cover || null,
    chapters: [],
    createdAt: now,
    updatedAt: now
  };
  db.comics.push(comic);
  saveDB(db);
  res.json({ success: true, comic });
});

// 更新漫画信息
app.put('/api/admin/comics/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const comic = db.comics.find(c => c.id === id);
  if (!comic) {
    return res.status(404).json({ error: '漫画不存在' });
  }
  const { title, description, tags, cover } = req.body;
  if (title !== undefined) comic.title = title;
  if (description !== undefined) comic.description = description;
  if (tags !== undefined) comic.tags = tags;
  if (cover !== undefined) comic.cover = cover;
  comic.updatedAt = Date.now();
  saveDB(db);
  res.json({ success: true, comic });
});

// 删除漫画
app.delete('/api/admin/comics/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const index = db.comics.findIndex(c => c.id === id);
  if (index === -1) {
    return res.status(404).json({ error: '漫画不存在' });
  }
  // 删除上传的图片文件
  const comicDir = path.join(UPLOADS_DIR, String(id));
  if (fs.existsSync(comicDir)) {
    fs.rmSync(comicDir, { recursive: true, force: true });
  }
  db.comics.splice(index, 1);
  saveDB(db);
  res.json({ success: true });
});

// 创建新章节
app.post('/api/admin/comics/:id/chapters', requireAdmin, (req, res) => {
  const comicId = parseInt(req.params.id);
  const comic = db.comics.find(c => c.id === comicId);
  if (!comic) {
    return res.status(404).json({ error: '漫画不存在' });
  }
  const { title, readMode } = req.body;
  if (!title) {
    return res.status(400).json({ error: '请填写章节标题' });
  }
  const chapterId = comic.chapters.length > 0
    ? Math.max(...comic.chapters.map(ch => ch.id)) + 1
    : 1;
  const chapter = {
    id: chapterId,
    title,
    pages: [],
    readMode: readMode === 'scroll' ? 'scroll' : 'page', // 'page' = 翻页模式, 'scroll' = 滚动模式
    createdAt: Date.now()
  };
  comic.chapters.push(chapter);
  comic.updatedAt = Date.now();
  saveDB(db);
  res.json({ success: true, chapter });
});

// 上传章节图片 (支持多文件)
app.post('/api/admin/comics/:comicId/chapters/:chapterId/upload', requireAdmin, upload.array('images', 100), (req, res) => {
  const comicId = parseInt(req.params.comicId);
  const chapterId = parseInt(req.params.chapterId);
  const comic = db.comics.find(c => c.id === comicId);
  if (!comic) {
    return res.status(404).json({ error: '漫画不存在' });
  }
  const chapter = comic.chapters.find(ch => ch.id === chapterId);
  if (!chapter) {
    return res.status(404).json({ error: '章节不存在' });
  }
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: '请选择图片文件' });
  }

  const uploadedPages = req.files.map((file, index) => {
    const relativePath = `/uploads/${comicId}/${chapterId}/${file.filename}`;
    return relativePath;
  });

  chapter.pages = [...chapter.pages, ...uploadedPages];
  comic.updatedAt = Date.now();
  saveDB(db);

  res.json({
    success: true,
    uploadedCount: req.files.length,
    totalPages: chapter.pages.length,
    pages: uploadedPages
  });
});

// 更新章节阅读模式
app.put('/api/admin/comics/:comicId/chapters/:chapterId/readMode', requireAdmin, (req, res) => {
  const comicId = parseInt(req.params.comicId);
  const chapterId = parseInt(req.params.chapterId);
  const comic = db.comics.find(c => c.id === comicId);
  if (!comic) return res.status(404).json({ error: '漫画不存在' });
  const chapter = comic.chapters.find(ch => ch.id === chapterId);
  if (!chapter) return res.status(404).json({ error: '章节不存在' });
  chapter.readMode = req.body.readMode === 'scroll' ? 'scroll' : 'page';
  comic.updatedAt = Date.now();
  saveDB(db);
  res.json({ success: true, readMode: chapter.readMode });
});

// 删除章节
app.delete('/api/admin/comics/:comicId/chapters/:chapterId', requireAdmin, (req, res) => {
  const comicId = parseInt(req.params.comicId);
  const chapterId = parseInt(req.params.chapterId);
  const comic = db.comics.find(c => c.id === comicId);
  if (!comic) {
    return res.status(404).json({ error: '漫画不存在' });
  }
  const chapterIndex = comic.chapters.findIndex(ch => ch.id === chapterId);
  if (chapterIndex === -1) {
    return res.status(404).json({ error: '章节不存在' });
  }
  // 删除章节图片
  const chapterDir = path.join(UPLOADS_DIR, String(comicId), String(chapterId));
  if (fs.existsSync(chapterDir)) {
    fs.rmSync(chapterDir, { recursive: true, force: true });
  }
  comic.chapters.splice(chapterIndex, 1);
  comic.updatedAt = Date.now();
  saveDB(db);
  res.json({ success: true });
});

// 删除单张图片
app.delete('/api/admin/comics/:comicId/chapters/:chapterId/pages/:pageIndex', requireAdmin, (req, res) => {
  const comicId = parseInt(req.params.comicId);
  const chapterId = parseInt(req.params.chapterId);
  const pageIndex = parseInt(req.params.pageIndex);
  const comic = db.comics.find(c => c.id === comicId);
  if (!comic) return res.status(404).json({ error: '漫画不存在' });
  const chapter = comic.chapters.find(ch => ch.id === chapterId);
  if (!chapter) return res.status(404).json({ error: '章节不存在' });
  if (pageIndex < 0 || pageIndex >= chapter.pages.length) {
    return res.status(400).json({ error: '页面索引无效' });
  }
  const filePath = path.join(__dirname, 'public', chapter.pages[pageIndex]);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
  chapter.pages.splice(pageIndex, 1);
  comic.updatedAt = Date.now();
  saveDB(db);
  res.json({ success: true, totalPages: chapter.pages.length });
});

// 设置漫画封面
app.post('/api/admin/comics/:id/cover', requireAdmin, upload.single('cover'), (req, res) => {
  const id = parseInt(req.params.id);
  const comic = db.comics.find(c => c.id === id);
  if (!comic) {
    return res.status(404).json({ error: '漫画不存在' });
  }
  if (!req.file) {
    return res.status(400).json({ error: '请选择封面图片' });
  }
  const coverPath = `/uploads/covers/${req.file.filename}`;
  // 移动文件到 covers 目录
  const coversDir = path.join(UPLOADS_DIR, 'covers');
  if (!fs.existsSync(coversDir)) {
    fs.mkdirSync(coversDir, { recursive: true });
  }
  const oldPath = req.file.path;
  const newPath = path.join(coversDir, req.file.filename);
  fs.renameSync(oldPath, newPath);
  comic.cover = coverPath;
  comic.updatedAt = Date.now();
  saveDB(db);
  res.json({ success: true, cover: coverPath });
});

// 上传章节图片并自动设置第一张为封面 (辅助接口)
app.post('/api/admin/comics/:comicId/chapters/:chapterId/pages/reorder', requireAdmin, (req, res) => {
  const comicId = parseInt(req.params.comicId);
  const chapterId = parseInt(req.params.chapterId);
  const comic = db.comics.find(c => c.id === comicId);
  if (!comic) return res.status(404).json({ error: '漫画不存在' });
  const chapter = comic.chapters.find(ch => ch.id === chapterId);
  if (!chapter) return res.status(404).json({ error: '章节不存在' });
  const { newOrder } = req.body;
  if (!Array.isArray(newOrder) || newOrder.length !== chapter.pages.length) {
    return res.status(400).json({ error: '排序数据无效' });
  }
  chapter.pages = newOrder;
  comic.updatedAt = Date.now();
  saveDB(db);
  res.json({ success: true, pages: chapter.pages });
});

// ============ PWA 支持 ============

app.get('/manifest.json', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'manifest.json'));
});

app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

// ============ 页面路由 ============

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/comic/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'comic.html'));
});

app.get('/reader/:comicId/:chapterId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'reader.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/profile', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'profile.html'));
});

app.get('/settings', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'settings.html'));
});

// ============ Render Deploy Hook 代理 ============

// 触发 Render 部署（管理员接口）
app.post('/api/admin/deploy', requireAdmin, (req, res) => {
  const { hookUrl } = req.body;

  if (!hookUrl || typeof hookUrl !== 'string') {
    return res.status(400).json({ error: '缺少 Deploy Hook URL' });
  }

  // 验证 URL 格式
  let parsedUrl;
  try {
    parsedUrl = new URL(hookUrl);
  } catch (e) {
    return res.status(400).json({ error: 'Deploy Hook URL 格式无效' });
  }

  // 只允许 https://api.render.com 或 http(s)://api.render.com
  if (!parsedUrl.hostname.includes('render.com')) {
    return res.status(400).json({ error: '仅支持 Render.com 的 Deploy Hook URL' });
  }

  const options = {
    method: 'POST',
    hostname: parsedUrl.hostname,
    path: parsedUrl.pathname + parsedUrl.search,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': 0
    },
    timeout: 30000
  };

  const requestModule = parsedUrl.protocol === 'https:' ? https : http;
  let responseSent = false;

  const deployReq = requestModule.request(options, (deployRes) => {
    let body = '';
    deployRes.on('data', chunk => { body += chunk; });
    deployRes.on('end', () => {
      if (responseSent) return;
      responseSent = true;

      if (deployRes.statusCode === 200 || deployRes.statusCode === 202) {
        let deployId = null;
        try {
          const data = JSON.parse(body);
          deployId = data.deployID || data.id || null;
        } catch (e) {}

        const message = deployRes.statusCode === 200
          ? '部署已触发，正在重新部署云端服务器'
          : '已有部署正在进行中，将在当前部署完成后自动开始';

        res.json({
          success: true,
          message,
          deployId,
          statusCode: deployRes.statusCode
        });
      } else {
        res.status(deployRes.statusCode || 500).json({
          error: `部署失败 (HTTP ${deployRes.statusCode})`,
          detail: body.substring(0, 200)
        });
      }
    });
  });

  deployReq.on('error', (err) => {
    if (responseSent) return;
    responseSent = true;
    console.error('Deploy hook error:', err.message);
    res.status(502).json({ error: '部署请求失败：' + err.message });
  });

  deployReq.on('timeout', () => {
    if (responseSent) return;
    responseSent = true;
    deployReq.destroy();
    res.status(504).json({ error: '部署请求超时（30秒），请检查 Hook URL 是否正确' });
  });

  deployReq.end();
});

// 获取部署配置状态
app.get('/api/admin/deploy/status', requireAdmin, (req, res) => {
  res.json({
    isRender: IS_RENDER,
    persistentDir: IS_RENDER && fs.existsSync(PERSISTENT_DIR) ? PERSISTENT_DIR : null,
    dataDir: DATA_DIR,
    uploadsDir: UPLOADS_DIR
  });
});

// ============ 404 处理 ============

// API 404
app.use('/api', (req, res) => {
  res.status(404).json({ error: '接口不存在' });
});

// 页面 404
app.use((req, res) => {
  res.status(404).send(`
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>404 - 漫阅</title>
  <style>
    body { background:#0d0d0f;color:#e0e0e0;font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0; }
    .box { text-align:center; }
    .code { font-size:80px;font-weight:bold;color:#5b8def;margin:0; }
    .msg { color:#707070;margin:8px 0 24px; }
    a { display:inline-block;padding:10px 28px;background:#252525;color:#5b8def;border-radius:8px;text-decoration:none;font-weight:bold; }
    a:hover { background:#2a2a2a; }
  </style>
</head>
<body>
  <div class="box">
    <p class="code">404</p>
    <p class="msg">页面不存在</p>
    <a href="/">返回首页</a>
  </div>
</body>
</html>
  `);
});

// ============ 启动服务器 ============

app.listen(PORT, '0.0.0.0', () => {
  console.log('\n========================================');
  console.log('  JM Clone 漫画平台已启动');
  console.log('========================================');
  console.log(`  访问地址: http://localhost:${PORT}`);
  console.log(`  管理后台: http://localhost:${PORT}/admin`);
  console.log('========================================\n');
});
