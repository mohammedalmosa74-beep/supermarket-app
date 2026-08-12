const express = require('express');
require('dotenv').config();
const cors = require('cors');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const rateLimit = require('express-rate-limit');

const app = express();
app.set('trust proxy', 1);
const server = require('http').createServer(app);
const io = require('socket.io')(server, { cors: { origin: '*' } });

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) { console.error('FATAL: JWT_SECRET must be set in .env'); process.exit(1); }
const PORT = process.env.PORT || 3000;

// Input sanitization helper
function sanitize(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/<[^>]*>/g, '').replace(/[<>"'\\]/g, '').trim();
}

// Global rate limiter
function ipKey(req) { return req.ip; }
const globalLimiter = rateLimit({ windowMs: 60000, max: 300, keyGenerator: ipKey, message: { error: 'طلبات كثيرة جداً، حاول بعد دقيقة' }, standardHeaders: true, legacyHeaders: false, skip: function(req) { return req.method === 'GET' && (req.path.startsWith('/uploads/') || req.path.startsWith('/vendor/') || req.path.startsWith('/styles') || req.path.startsWith('/scripts') || req.path.startsWith('/images')); } });
const authLimiter = rateLimit({ windowMs: 60000, max: 5, keyGenerator: function(req) { return (req.ip || '') + '|' + (req.body && req.body.phone ? req.body.phone : ''); }, message: { error: 'محاولات كثيرة جداً، حاول بعد دقيقة' }, standardHeaders: true, legacyHeaders: false });
const orderLimiter = rateLimit({ windowMs: 30000, max: 5, keyGenerator: function(req) { return (req.ip || '') + '|' + (req.user ? req.user.id : ''); }, message: { error: 'طلبات كثيرة جداً، حاول بعد 30 ثانية' }, standardHeaders: true, legacyHeaders: false });
const adminLimiter = rateLimit({ windowMs: 60000, max: 60, keyGenerator: ipKey, message: { error: 'طلبات كثيرة جداً، حاول بعد دقيقة' }, standardHeaders: true, legacyHeaders: false });
const spamLimiter = rateLimit({ windowMs: 60000, max: 10, keyGenerator: function(req) { return (req.ip || '') + '|' + (req.user ? req.user.id : ''); }, message: { error: 'إرسال متكرر جداً، حاول بعد دقيقة' }, standardHeaders: true, legacyHeaders: false });
const pushLimiter = rateLimit({ windowMs: 60000, max: 20, keyGenerator: function(req) { return (req.ip || '') + '|' + (req.user ? req.user.id : ''); }, message: { error: 'طلبات كثيرة جداً، حاول بعد دقيقة' }, standardHeaders: true, legacyHeaders: false });

// Validation helpers
function validate(fields) {
  return function(req, res, next) {
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      var val = f.in === 'body' ? req.body[f.name] : f.name === 'id' ? req.params.id : req.params[f.name];
      if (f.required && (val === undefined || val === null || val === '')) {
        return res.status(400).json({ error: f.message || 'حقل ' + f.name + ' مطلوب' });
      }
      if (f.type === 'number' && val !== undefined && val !== null && val !== '') {
        var num = parseFloat(val);
        if (isNaN(num)) return res.status(400).json({ error: f.message || 'حقل ' + f.name + ' يجب أن يكون رقماً' });
        if (f.min !== undefined && num < f.min) return res.status(400).json({ error: f.message || 'حقل ' + f.name + ' أقل من ' + f.min });
        if (f.max !== undefined && num > f.max) return res.status(400).json({ error: f.message || 'حقل ' + f.name + ' أكبر من ' + f.max });
      }
      if (f.type === 'string' && val !== undefined && val !== null) {
        if (f.maxLength && val.length > f.maxLength) return res.status(400).json({ error: f.message || 'حقل ' + f.name + ' طويل جداً' });
        if (f.minLength && val.length < f.minLength) return res.status(400).json({ error: f.message || f.name + ' قصير جداً' });
      }
    }
    next();
  };
}

// Upload config (memory storage -> Supabase Storage)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: function(req, file, cb) {
    var allowed = /\.(jpg|jpeg|png|gif|webp|svg)$/i;
    if (allowed.test(path.extname(file.originalname))) cb(null, true);
    else cb(new Error('يُسمح فقط بصور JPG, PNG, GIF, WebP, SVG'));
  }
});

const BUCKET_NAME = process.env.SUPABASE_BUCKET || 'product-images';

async function ensureBucket() {
  const { data: buckets } = await db.supabase.storage.listBuckets();
  if (!buckets || !buckets.some(b => b.name === BUCKET_NAME)) {
    await db.supabase.storage.createBucket(BUCKET_NAME, { public: true });
    console.log('Bucket created: ' + BUCKET_NAME);
  }
}

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https:', 'data:'],
      imgSrc: ["'self'", 'data:', 'https:'],
      fontSrc: ["'self'", 'https:', 'data:'],
      connectSrc: ["'self'", 'https:', 'wss:'],
      frameSrc: ["'self'", 'https://maps.google.com', 'https://www.google.com'],
      objectSrc: ["'none'"]
    }
  }
}));
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '5mb' }));
app.use(globalLimiter);

// DB setup (Supabase)
const db = require('./supabase/db');

// ============ WEB PUSH NOTIFICATIONS ============
let webpush = null;
try {
  webpush = require('web-push');
  const vapidPublic = process.env.VAPID_PUBLIC_KEY || 'BIUGaCbtDWjTe30uWuChoB85jPPcbxpipQzf3YbSCeSdP8-X9Iq6TUAlJd2KlhkgCUT2r9zVa9rLkmX6ahOisog';
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY || 'I6gXa0oHWYf9i4jxA0BqVaIuskdD_dFbEoCzN1J1qk0';
  webpush.setVapidDetails('mailto:admin@supermarket.app', vapidPublic, vapidPrivate);
} catch (e) { console.log('web-push not available:', e.message); }

function sendPushToUser(userId, title, body, url) {
  if (!webpush) return;
  const subs = (db.get('pushSubs') || db.get('push_subs') || []).value();
  if (!subs || !subs.length) return;
  const payload = JSON.stringify({ title, body, url: url || '/' });
  subs.filter(function(s) { return s.userId === userId; }).forEach(function(s) {
    webpush.sendNotification(s.subscription, payload).catch(function(err) {
      if (err && (err.statusCode === 404 || err.statusCode === 410)) {
        db.get('pushSubs').remove({ userId: userId, subscription: s.subscription }).write();
      }
    });
  });
}

app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || 'BIUGaCbtDWjTe30uWuChoB85jPPcbxpipQzf3YbSCeSdP8-X9Iq6TUAlJd2KlhkgCUT2r9zVa9rLkmX6ahOisog' });
});

app.post('/api/push/subscribe', auth, pushLimiter, (req, res) => {
  try {
    const sub = req.body.subscription;
    if (!sub || !sub.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
    const key = JSON.stringify(sub);
    const list = db.get('pushSubs').value();
    if (!list) db.set('pushSubs', []).write();
    const existing = db.get('pushSubs').find(function(s) { return JSON.stringify(s.subscription) === key && s.userId === req.user.id; }).value();
    if (!existing) db.get('pushSubs').push({ userId: req.user.id, subscription: sub, createdAt: new Date().toISOString() }).write();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/push/subscribe', auth, pushLimiter, (req, res) => {
  try {
    db.get('pushSubs').remove(function(s) { return s.userId === req.user.id; }).write();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// ============ END WEB PUSH ============

const defaultProducts = [
  { id: 1, name: 'طماطم', sub: 'خضار', cat: '1', price: 3000, unit: 'كغ', image: '', badge: '', discount: 0, stock: 100, active: true, preorder: false },
  { id: 2, name: 'خيار', sub: 'خضار', cat: '1', price: 2000, unit: 'كغ', image: '', badge: '', discount: 0, stock: 100, active: true, preorder: false },
  { id: 3, name: 'بصل', sub: 'خضار', cat: '1', price: 1500, unit: 'كغ', image: '', badge: '', discount: 0, stock: 100, active: true, preorder: false },
  { id: 4, name: 'بطاطا', sub: 'خضار', cat: '1', price: 2500, unit: 'كغ', image: '', badge: '', discount: 0, stock: 100, active: true, preorder: false },
  { id: 5, name: 'حليب طازج', sub: 'ألبان', cat: '2', price: 6000, unit: 'لتر', image: '', badge: '', discount: 0, stock: 50, active: true, preorder: false },
  { id: 6, name: 'لبنة', sub: 'ألبان', cat: '2', price: 8000, unit: 'كغ', image: '', badge: '', discount: 0, stock: 30, active: true, preorder: false },
  { id: 7, name: 'جبنة بيضاء', sub: 'ألبان', cat: '2', price: 10000, unit: 'كغ', image: '', badge: '', discount: 0, stock: 25, active: true, preorder: false },
  { id: 8, name: 'دجاج', sub: 'لحوم', cat: '3', price: 15000, unit: 'كغ', image: '', badge: '', discount: 0, stock: 40, active: true, preorder: false },
  { id: 9, name: 'لحم عجل', sub: 'لحوم', cat: '3', price: 35000, unit: 'كغ', image: '', badge: '', discount: 0, stock: 30, active: true, preorder: false },
  { id: 10, name: 'بيض', sub: 'بيض', cat: '3', price: 12000, unit: 'كرتونة', image: '', badge: '', discount: 0, stock: 60, active: true, preorder: false }
];

// Seed defaults if empty (checked inside db.init)

// Helper: generate order ID
function genOrderId() {
  return 'ORD-' + Date.now().toString(36).toUpperCase();
}

// ============ AUTO BACKUP ============
function backupData() {
  try {
    var fs = require('fs');
    var dir = path.join(__dirname, 'db', 'backups');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    var data = JSON.stringify(db.getState(), null, 2);
    var now = new Date();
    var filename = 'backup-' + now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0') + '-' + String(now.getDate()).padStart(2,'0') + '.json';
    fs.writeFileSync(path.join(dir, filename), data);
    // Keep only last 30 backups
    var files = fs.readdirSync(dir).filter(function(f) { return f.startsWith('backup-'); }).sort();
    while (files.length > 30) { fs.unlinkSync(path.join(dir, files.shift())); }
  } catch(e) { console.error('Backup error:', e.message); }
}
// Run backup every 6 hours
setInterval(backupData, 6 * 3600000);
setTimeout(backupData, 5000); // First backup after 5 seconds

// ============ STOCK MOVEMENT LOG ============
function logStock(productId, productName, oldStock, newStock, reason) {
  if (oldStock === newStock) return;
  db.get('stockLog').push({ productId: productId, productName: productName, oldStock: oldStock, newStock: newStock, diff: newStock - oldStock, reason: reason || '', time: Date.now() }).write();
}

// ============ SALES GOALS ============
app.get('/api/goals', adminAuth, (req, res) => {
  var goals = db.get('salesGoals').value() || { daily: 500000, weekly: 3000000, monthly: 12000000 };
  res.json(goals);
});
app.put('/api/goals', adminAuth, (req, res) => {
  db.set('salesGoals', req.body).write();
  res.json({ success: true });
});

// Middleware: verify token
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    // Admin tokens pass through auth too
    if (req.user.admin) return next();
    // Check if user still exists
    var user = db.get('users').find({ id: req.user.id }).value();
    if (!user) return res.status(401).json({ error: 'الحساب لم يعد موجوداً' });
    // Token version check: old tokens die after password change
    if (req.user.pwVer && user.pwVer && req.user.pwVer !== user.pwVer) return res.status(401).json({ error: 'انتهت الجلسة، سجل دخولك من جديد' });
    if (user.blocked) return res.status(403).json({ error: 'حسابك محظور، يرجى التواصل مع الإدارة', blockReason: user.blockReason || '' });
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function adminAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (!decoded.admin) return res.status(403).json({ error: 'Not admin' });
    var settings = db.get('settings').value();
    if (decoded.pwVer && settings.adminVer && decoded.pwVer !== settings.adminVer) return res.status(401).json({ error: 'انتهت الجلسة، سجل دخولك من جديد' });
    req.admin = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ============ AUTH ============
app.post('/api/auth/register', authLimiter, validate([
  { name: 'phone', in: 'body', required: true, type: 'string', minLength: 10, maxLength: 10, message: 'رقم الهاتف مطلوب (10 أرقام)' },
  { name: 'password', in: 'body', required: true, type: 'string', minLength: 4, maxLength: 30, message: 'كلمة السر مطلوبة (4-30 حرف)' }
]), async (req, res) => {
  try {
    const { phone, name, password } = req.body;
    if (!/^09\d{8}$/.test(phone)) return res.status(400).json({ error: 'رقم الهاتف يجب أن يبدأ بـ 09 ويتكون من 10 أرقام' });
    if (name && typeof name === 'string' && name.length > 100) return res.status(400).json({ error: 'الاسم طويل جداً' });
    const safeName = name ? sanitize(name) : 'مستخدم';
    const existing = db.get('users').find({ phone }).value();
    if (existing) {
      return res.status(409).json({ error: 'هذا الرقم مسجل بالفعل، سجل دخولك بكلمة السر الخاصة بك' });
    }
    const pwHash = bcrypt.hashSync(password, 10);
    const user = { id: Date.now().toString(36), phone, passwordHash: pwHash, name: safeName, dob: '', city: '', address: '', points: 0, pwVer: 1, profile: {}, createdAt: new Date().toISOString() };
    db.get('users').push(user).write();
    // Generate referral code for new user
    var refCode = (safeName || 'user').substring(0, 3).toUpperCase() + user.id.slice(-4);
    if (!db.get('referrals').find({ code: refCode }).value()) {
      db.get('referrals').push({ code: refCode, userId: user.id, name: user.name, used: false }).write();
    }
    const token = jwt.sign({ id: user.id, phone: user.phone, pwVer: user.pwVer || 1 }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, phone: user.phone, name: user.name, dob: '', city: '', points: 0 } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/login', authLimiter, validate([
  { name: 'phone', in: 'body', required: true, type: 'string', minLength: 10, maxLength: 10, message: 'رقم الهاتف مطلوب (10 أرقام)' },
  { name: 'password', in: 'body', required: true, type: 'string', minLength: 1, message: 'كلمة السر مطلوبة' }
]), async (req, res) => {
  try {
    const { phone, password } = req.body;
    if (!/^09\d{8}$/.test(phone)) return res.status(400).json({ error: 'رقم الهاتف يجب أن يبدأ بـ 09 ويتكون من 10 أرقام' });
    const user = db.get('users').find({ phone }).value();
    if (!user) return res.status(404).json({ error: 'هذا الرقم غير مسجل، يرجى إنشاء حساب جديد' });
    if (!user.passwordHash) return res.status(401).json({ error: 'هذا الحساب لا يملك كلمة سر، سجل حساباً جديداً برقم مختلف' });
    if (!bcrypt.compareSync(password, user.passwordHash)) return res.status(401).json({ error: 'كلمة السر غير صحيحة' });
    const token = jwt.sign({ id: user.id, phone: user.phone, pwVer: user.pwVer || 1 }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, phone: user.phone, name: user.name, dob: user.dob, city: user.city, points: user.points || 0 } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ OTP AUTH (customer app) ============
const otpStore = {};
function genOtpCode() { return String(Math.floor(100000 + Math.random() * 900000)); }
function cleanupOtps() { var now = Date.now(); for (var k in otpStore) { if (otpStore[k].expires < now) delete otpStore[k]; } }
app.post('/api/auth/otp/request', authLimiter, validate([
  { name: 'phone', in: 'body', required: true, type: 'string', minLength: 10, maxLength: 10, message: 'رقم الهاتف مطلوب (10 أرقام)' }
]), (req, res) => {
  const phone = req.body.phone;
  if (!/^09\d{8}$/.test(phone)) return res.status(400).json({ error: 'رقم الهاتف يجب أن يبدأ بـ 09 ويتكون من 10 أرقام' });
  cleanupOtps();
  const code = genOtpCode();
  otpStore[phone] = { code, expires: Date.now() + 5 * 60 * 1000, attempts: 0 };
  // OTP is shown in the app (no SMS provider yet)
  res.json({ success: true, devCode: code, expiresIn: 300 });
});
app.post('/api/auth/otp/verify', authLimiter, validate([
  { name: 'phone', in: 'body', required: true, type: 'string', minLength: 10, maxLength: 10, message: 'رقم الهاتف مطلوب (10 أرقام)' },
  { name: 'code', in: 'body', required: true, type: 'string', minLength: 6, maxLength: 6, message: 'الكود مطلوب (6 أرقام)' }
]), async (req, res) => {
  try {
    const { phone, code } = req.body;
    if (!/^09\d{8}$/.test(phone)) return res.status(400).json({ error: 'رقم الهاتف يجب أن يبدأ بـ 09 ويتكون من 10 أرقام' });
    cleanupOtps();
    var otp = otpStore[phone];
    if (!otp) return res.status(400).json({ error: 'اطلب كوداً أولاً' });
    if (Date.now() > otp.expires) { delete otpStore[phone]; return res.status(400).json({ error: 'انتهت صلاحية الكود، اطلب كوداً جديداً' }); }
    if (otp.code !== code.trim()) {
      otp.attempts++;
      if (otp.attempts >= 5) { delete otpStore[phone]; return res.status(400).json({ error: 'محاولات كثيرة، اطلب كوداً جديداً' }); }
      return res.status(401).json({ error: 'الكود غير صحيح' });
    }
    delete otpStore[phone];
    var user = db.get('users').find({ phone }).value();
    var isNew = false;
    if (!user) {
      isNew = true;
      user = { id: Date.now().toString(36), phone, passwordHash: null, name: 'مستخدم', dob: '', city: '', address: '', points: 0, pwVer: 1, profile: {}, createdAt: new Date().toISOString() };
      db.get('users').push(user).write();
      var refCode = 'USR' + user.id.slice(-4);
      if (!db.get('referrals').find({ code: refCode }).value()) {
        db.get('referrals').push({ code: refCode, userId: user.id, name: user.name, used: false }).write();
      }
    }
    const token = jwt.sign({ id: user.id, phone: user.phone, pwVer: user.pwVer || 1 }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, isNew, user: { id: user.id, phone: user.phone, name: user.name, dob: user.dob, city: user.city, points: user.points || 0 } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/admin', authLimiter, validate([
  { name: 'password', in: 'body', required: true, type: 'string', minLength: 1, message: 'كلمة السر مطلوبة' }
]), (req, res) => {
  const { password } = req.body;
  const settings = db.get('settings').value();
  if (bcrypt.compareSync(password, settings.adminPW)) {
    const token = jwt.sign({ admin: true, pwVer: settings.adminVer || 1 }, JWT_SECRET, { expiresIn: '24h' });
    return res.json({ token });
  }
  res.status(401).json({ error: 'كلمة سر خطأ' });
});

app.get('/api/auth/me', auth, (req, res) => {
  const user = db.get('users').find({ id: req.user.id }).value();
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json({ id: user.id, phone: user.phone, name: user.name, dob: user.dob, city: user.city, points: user.points });
});

app.put('/api/auth/profile', auth, validate([
  { name: 'name', in: 'body', required: false, type: 'string', maxLength: 100, message: 'الاسم طويل جداً' }
]), (req, res) => {
  const { name, dob, city, address, landmark, floor, apt, deliveryNotes } = req.body;
  const user = db.get('users').find({ id: req.user.id });
  if (!user.value()) return res.status(404).json({ error: 'المستخدم غير موجود' });
  // Row-level security: already enforced by req.user.id matching JWT
  const updates = {};
  if (name !== undefined && name.trim()) updates.name = sanitize(name);
  if (dob !== undefined) updates.dob = dob;
  if (city !== undefined) updates.city = city;
  const profile = user.value().profile || {};
  if (address !== undefined) profile.address = address;
  if (landmark !== undefined) profile.landmark = landmark;
  if (floor !== undefined) profile.floor = floor;
  if (apt !== undefined) profile.apt = apt;
  if (deliveryNotes !== undefined) profile.deliveryNotes = deliveryNotes;
  updates.profile = profile;
  user.assign(updates).write();
  res.json({ success: true });
});

// Change own password (invalidates all old tokens via pwVer bump)
app.put('/api/auth/password', auth, authLimiter, validate([
  { name: 'oldPassword', in: 'body', required: true, type: 'string', minLength: 1, message: 'كلمة السر الحالية مطلوبة' },
  { name: 'newPassword', in: 'body', required: true, type: 'string', minLength: 4, maxLength: 30, message: 'كلمة السر الجديدة مطلوبة (4-30 حرف)' }
]), (req, res) => {
  try {
    var userEnt = db.get('users').find({ id: req.user.id });
    var user = userEnt.value();
    if (!user) return res.status(404).json({ error: 'المستخدم غير موجود' });
    if (!user.passwordHash) return res.status(400).json({ error: 'هذا الحساب لا يملك كلمة سر' });
    if (!bcrypt.compareSync(req.body.oldPassword, user.passwordHash)) return res.status(401).json({ error: 'كلمة السر الحالية غير صحيحة' });
    userEnt.assign({ passwordHash: bcrypt.hashSync(req.body.newPassword, 10), pwVer: (user.pwVer || 1) + 1 }).write();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: reset a customer's password (invalidates their tokens)
app.put('/api/customers/:id/password', adminAuth, adminLimiter, validate([
  { name: 'password', in: 'body', required: true, type: 'string', minLength: 4, maxLength: 30, message: 'كلمة السر الجديدة مطلوبة (4-30 حرف)' }
]), (req, res) => {
  var userEnt = db.get('users').find({ id: req.params.id });
  if (!userEnt.value()) return res.status(404).json({ error: 'العميل غير موجود' });
  userEnt.assign({ passwordHash: bcrypt.hashSync(req.body.password, 10), pwVer: (userEnt.value().pwVer || 1) + 1 }).write();
  db.get('adminLog').push({ action: 'password-reset', detail: 'إعادة تعيين كلمة سر زبون ' + (userEnt.value().phone || req.params.id), time: Date.now() }).write();
  res.json({ success: true });
});
app.get('/api/referral/my', auth, (req, res) => {
  var ref = db.get('referrals').find({ userId: req.user.id }).value();
  if (!ref) return res.status(404).json({ error: 'لا يوجد كود إحالة' });
  res.json({ success: true, code: ref.code, used: ref.used });
});
app.get('/api/referral/:code', (req, res) => {
  var code = req.params.code;
  var ref = db.get('referrals').find({ code: code }).value();
  if (!ref) return res.status(404).json({ error: 'كود الإحالة غير صحيح' });
  res.json({ success: true, name: ref.name, used: ref.used });
});

app.post('/api/referral/claim', auth, spamLimiter, validate([
  { name: 'code', in: 'body', required: true, type: 'string', minLength: 4, message: 'كود الإحالة مطلوب' }
]), (req, res) => {
  var code = req.body.code;
  var ref = db.get('referrals').find({ code: code }).value();
  if (!ref) return res.status(404).json({ error: 'كود الإحالة غير صحيح' });
  if (ref.used) return res.status(400).json({ error: 'كود الإحالة مستخدم بالفعل' });
  var user = db.get('users').find({ id: req.user.id }).value();
  if (!user) return res.status(404).json({ error: 'المستخدم غير موجود' });
  if (user.usedReferral) return res.status(400).json({ error: 'لقد استخدمت كود إحالة من قبل' });
  var settings = db.get('settings').value();
  var bonus = parseInt(settings.ptsValue) * 5 || 50;
  db.get('referrals').find({ code: code }).assign({ used: true, usedBy: req.user.id, usedAt: Date.now() }).write();
  db.get('users').find({ id: req.user.id }).assign({ usedReferral: true }).write();
  var refUser = db.get('users').find({ id: ref.userId }).value();
  if (refUser) db.get('users').find({ id: ref.userId }).assign({ points: (refUser.points || 0) + bonus }).write();
  res.json({ success: true, bonus: bonus, message: 'تم إضافة ' + bonus + ' نقطة كمكافأة' });
});

// ============ DELIVERY ASSIGNMENT ============
app.post('/api/orders/:id/delivery', adminAuth, adminLimiter, validate([
  { name: 'name', in: 'body', required: true, type: 'string', message: 'اسم المندوب مطلوب' }
]), (req, res) => {
  var order = db.get('orders').find({ id: req.params.id }).value();
  if (!order) return res.status(404).json({ error: 'الطلب غير موجود' });
  db.get('orders').find({ id: req.params.id }).assign({ deliveryPerson: req.body.name, deliveryPersonPhone: req.body.phone || '', deliveryAssignedAt: Date.now() }).write();
  io.to('user:' + order.userId).emit('delivery-assigned', { orderId: order.id, name: req.body.name, phone: req.body.phone || '' });
  io.to('user:' + order.userId).emit('order-status', { id: order.id, status: order.status, timeline: order.timeline });
  if (order.userId) sendPushToUser(order.userId, 'تحديث طلبك', 'حالة طلبك #' + order.id + ' أصبحت: ' + (order.status === 'pending' ? 'قيد الانتظار' : order.status === 'confirmed' ? 'مؤكد' : order.status === 'preparing' ? 'قيد التحضير' : order.status === 'delivering' ? 'قيد التوصيل' : order.status === 'delivered' ? 'تم التوصيل' : 'ملغي'), '/customer.html?v=9');
  // Notify the delivery person
  var dp = db.get('deliveryPersons').find({ name: req.body.name }).value();
  if (dp) {
    io.to('delivery:' + dp.id).emit('delivery-assigned', { orderId: order.id, name: req.body.name, phone: req.body.phone || '', order: order });
  }
  res.json({ success: true });
});

// ============ CASHIER ORDER (admin places for customer) ============
app.post('/api/orders/cashier', adminAuth, adminLimiter, validate([
  { name: 'customerPhone', in: 'body', required: true, type: 'string', minLength: 7 },
  { name: 'customerName', in: 'body', required: true, type: 'string', minLength: 1 },
  { name: 'address', in: 'body', required: true, type: 'string', minLength: 5 },
  { name: 'items', in: 'body', required: true }
]), (req, res) => {
  var items = req.body.items || [];
  if (!items.length) return res.status(400).json({ error: 'الطلب يجب أن يحتوي منتجات' });
  for (var i = 0; i < items.length; i++) {
    var prod = db.get('products').find({ id: items[i].id || items[i].productId }).value();
    if (!prod) return res.status(400).json({ error: 'المنتج غير موجود: ' + (items[i].name || items[i].id) });
    if (prod.stock != null && (items[i].quantity || items[i].qty || 1) > prod.stock) {
      return res.status(400).json({ error: 'المنتج ' + prod.name + ' غير متوفر بالكمية المطلوبة' });
    }
  }
  var customer = db.get('users').find({ phone: req.body.customerPhone }).value();
  var order = {
    id: genOrderId(),
    userId: customer ? customer.id : 'walkin_' + Date.now(),
    customerPhone: req.body.customerPhone,
    customerName: req.body.customerName,
    items: items,
    status: 'confirmed',
    date: new Date().toISOString(),
    total: req.body.total || 0,
    address: req.body.address,
    cashierOrder: true,
    cashierId: req.admin.id
  };
  db.get('orders').push(order).write();
  res.json({ success: true, orderId: order.id });
});

// ============ SALES ANALYTICS ============
app.get('/api/analytics', adminAuth, (req, res) => {
  var orders = db.get('orders').filter({ status: 'delivered' }).value();
  var totalSales = 0, totalCost = 0, orderCount = orders.length;
  orders.forEach(function(o) {
    totalSales += o.total || 0;
    (o.items || []).forEach(function(item) {
      var prod = db.get('products').find({ id: item.id || item.productId }).value();
      if (prod && prod.cost) totalCost += (prod.cost * (item.quantity || item.qty || 1));
    });
  });
  var profit = totalSales - totalCost;
  var products = db.get('products').value();
  var lowStock = products.filter(function(p) { return p.active && p.stock != null && p.stock <= 5; }).length;
  var outOfStock = products.filter(function(p) { return p.active && p.stock != null && p.stock === 0; }).length;
  res.json({
    totalSales: totalSales,
    totalCost: totalCost,
    profit: profit,
    orderCount: orderCount,
    lowStock: lowStock,
    outOfStock: outOfStock,
    avgOrder: orderCount ? Math.round(totalSales / orderCount) : 0
  });
});

// ============ PRODUCTS ============
app.get('/api/products', (req, res) => {
  let products = db.get('products').value();
  const { cat, q, lowStock } = req.query;
  if (cat) products = products.filter(p => p.cat == cat);
  if (q) products = products.filter(p => p.name.includes(q) || p.sub.includes(q));
  if (lowStock) products = products.filter(p => (p.stock || 0) <= parseInt(lowStock));
  res.json(products);
});

app.get('/api/products/:id', (req, res) => {
  const p = db.get('products').find({ id: parseInt(req.params.id) }).value();
  if (!p) return res.status(404).json({ error: 'Not found' });
  res.json(p);
});

app.post('/api/products', adminAuth, validate([
  { name: 'name', in: 'body', required: true, type: 'string', maxLength: 200, message: 'اسم المنتج مطلوب' },
  { name: 'price', in: 'body', required: true, type: 'number', min: 1, message: 'سعر المنتج مطلوب وأكبر من 0' }
]), (req, res) => {
  const p = req.body;
  const maxId = db.get('products').maxBy('id').value()?.id || 0;
  p.id = maxId + 1;
  p.name = p.name.trim();
  if (!p.cat) p.cat = p.category || '';
  p.image2 = p.image2 || '';
  if (p.stock === undefined || p.stock === null) p.stock = 0;
  if (p.cost === undefined || p.cost === null) p.cost = 0;
  if (p.active === undefined) p.active = true;
  db.get('products').push(p).write();
  io.emit('products-update');
  res.json(p);
});

app.put('/api/products/:id', adminAuth, validate([
  { name: 'name', in: 'body', required: false, type: 'string', maxLength: 200 },
  { name: 'price', in: 'body', required: false, type: 'number', min: 1 },
  { name: 'stock', in: 'body', required: false, type: 'number', min: 0 },
  { name: 'cost', in: 'body', required: false, type: 'number', min: 0 }
]), (req, res) => {
  const id = parseInt(req.params.id);
  const existing = db.get('products').find({ id }).value();
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const oldStock = existing.stock || 0;
  const oldPrice = existing.price;
  db.get('products').find({ id }).assign(req.body).write();
  io.emit('products-update');
  // Notify watchers if stock returned or price changed
  if ((oldStock === 0 && (req.body.stock || 0) > 0) || (req.body.price && req.body.price !== oldPrice)) {
    const watchers = db.get('watchedProducts').filter({ productId: id }).value();
    const product = db.get('products').find({ id }).value();
    if (oldStock === 0 && product.stock > 0) {
      watchers.forEach(w => io.to('user:' + w.userId).emit('product-stock', { product }));
    }
  if (req.body.price && req.body.price !== oldPrice) {
    watchers.forEach(w => io.to('user:' + w.userId).emit('product-price', { product, oldPrice }));
  }
}
res.json({ success: true });
});

// Bulk price update
app.post('/api/products/bulk-price', adminAuth, validate([
  { name: 'pct', in: 'body', required: true, type: 'number', message: 'نسبة التغيير مطلوبة' },
  { name: 'filter', in: 'body', required: false }
]), (req, res) => {
  var pct = parseFloat(req.body.pct);
  var filter = req.body.filter || {};
  var products = db.get('products').value();
  if (filter.cat) products = products.filter(function(p) { return p.cat == filter.cat; });
  if (filter.active !== undefined) products = products.filter(function(p) { return p.active === filter.active; });
  var count = 0;
  products.forEach(function(p) {
    var newPrice = Math.round(p.price * (1 + pct / 100));
    if (newPrice > 0) { db.get('products').find({ id: p.id }).assign({ price: newPrice }).write(); count++; }
  });
  io.emit('products-update');
  db.get('adminLog').push({ action: 'bulk-price', detail: count + ' منتج: ' + pct + '%', time: Date.now() }).write();
  res.json({ success: true, count: count });
});

app.delete('/api/products/:id', adminAuth, (req, res) => {
  db.get('products').remove({ id: parseInt(req.params.id) }).write();
  io.emit('products-update');
  res.json({ success: true });
});

// Bulk product actions
app.post('/api/products/bulk', adminAuth, (req, res) => {
  const { ids, action, value } = req.body;
  if (!ids || !ids.length || !action) return res.status(400).json({ error: 'Invalid request' });
  ids.forEach(function(id) {
    var prod = db.get('products').find({ id: parseInt(id) });
    if (prod.value()) {
      if (action === 'delete') db.get('products').remove({ id: parseInt(id) }).write();
      else if (action === 'toggle') prod.assign({ active: !prod.value().active }).write();
      else if (action === 'activate') prod.assign({ active: true }).write();
      else if (action === 'deactivate') prod.assign({ active: false }).write();
      else if (action === 'category' && value) prod.assign({ cat: value }).write();
    }
  });
  io.emit('products-update');
  db.get('adminLog').push({ action: 'bulk-products', detail: ids.length + ' منتجات: ' + action, time: Date.now() }).write();
  res.json({ success: true, count: ids.length });
});

// Image upload (to Supabase Storage)
app.post('/api/upload', adminAuth, function(req, res) {
  upload.single('image')(req, res, async function(err) {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'لم يتم اختيار صورة' });
    try {
      const ext = path.extname(req.file.originalname).toLowerCase();
      const fileName = Date.now() + '-' + Math.round(Math.random() * 1E9) + ext;
      const { error: upErr } = await db.supabase.storage.from(BUCKET_NAME).upload(fileName, req.file.buffer, {
        contentType: req.file.mimetype
      });
      if (upErr) return res.status(500).json({ error: 'فشل رفع الصورة: ' + upErr.message });
      const { data: pubData } = db.supabase.storage.from(BUCKET_NAME).getPublicUrl(fileName);
      res.json({ url: pubData.publicUrl });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
});

// ============ CATEGORIES ============
app.get('/api/categories', (req, res) => res.json(db.get('categories').value()));
app.put('/api/categories', adminAuth, (req, res) => {
  db.set('categories', req.body).write();
  res.json({ success: true });
});
app.post('/api/categories', adminAuth, validate([
  { name: 'name', in: 'body', required: true, type: 'string', maxLength: 100, message: 'اسم القسم مطلوب' }
]), (req, res) => {
  const cats = db.get('categories').value();
  const maxId = cats.length ? Math.max.apply(null, cats.map(c => c.id)) : 0;
  const cat = { id: maxId + 1, name: req.body.name, icon: req.body.icon || 'fa-tag', color: req.body.color || '#6B7280' };
  db.get('categories').push(cat).write();
  res.json(cat);
});
app.delete('/api/categories/:id', adminAuth, (req, res) => {
  db.get('categories').remove({ id: parseInt(req.params.id) }).write();
  res.json({ success: true });
});

// ============ ORDERS ============
app.get('/api/orders', auth, (req, res) => {
  const orders = db.get('orders').filter(o => o.userId === req.user.id).orderBy('date', 'desc').value();
  res.json(orders);
});

app.get('/api/orders/all', adminAuth, (req, res) => {
  let orders = db.get('orders').orderBy('date', 'desc').value();
  const { status, phone, archived } = req.query;
  if (status === 'archived') orders = orders.filter(o => o.archived);
  else if (status) orders = orders.filter(o => o.status === status);
  else orders = orders.filter(o => !o.archived);
  if (phone) orders = orders.filter(o => (o.phone || '').includes(phone));
  res.json(orders);
});

app.post('/api/orders', auth, orderLimiter, validate([
  { name: 'address', in: 'body', required: true, type: 'string', minLength: 3, maxLength: 500, message: 'عنوان التوصيل مطلوب' },
  { name: 'items', in: 'body', required: true, message: 'الطلب يجب أن يحتوي منتجات' }
]), (req, res) => {
  const { items, address, floor, lat, lng, payment, txnId, orderNote, deliverySlot, contactPhone, total, deliveryFee, discount, couponCode, deliveryDate, giftMessage } = req.body;
  if (!items || !items.length) return res.status(400).json({ error: 'الطلب يجب أن يحتوي منتجات' });
  const user = db.get('users').find({ id: req.user.id }).value();
  // Row-level security: order.userId = req.user.id (enforced below)
  // Validate items have required fields
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    if (!item.id && !item.productId) return res.status(400).json({ error: 'معرف المنتج مطلوب' });
    if (!item.quantity && !item.qty) return res.status(400).json({ error: 'كمية المنتج مطلوبة' });
  }
  // Validate stock availability
  for (var j = 0; j < items.length; j++) {
    var item2 = items[j];
    var prod = db.get('products').find({ id: item2.id || item2.productId }).value();
    if (prod && prod.stock != null && (item2.quantity || item2.qty || 1) > prod.stock) {
      return res.status(400).json({ error: 'المنتج ' + (prod.name || item2.name || '') + ' غير متوفر بالكمية المطلوبة (المتبقي: ' + prod.stock + ')' });
    }
  }
  const order = {
    id: genOrderId(),
    userId: req.user.id,
    items: items || [],
    status: 'pending',
    date: new Date().toISOString(),
    total: total || 0,
    deliveryFee: deliveryFee || 0,
    discount: discount || 0,
    payment: payment || 'cash',
    txnId: txnId || '',
    address: address || '',
    floor: floor || '',
    lat: lat || null,
    lng: lng || null,
    phone: user?.phone || '',
    orderNote: orderNote || '',
    customerName: user?.name || '',
    deliverySlot: deliverySlot || '',
    contactPhone: contactPhone || '',
    couponCode: couponCode || '',
    deliveryDate: deliveryDate || '',
    giftMessage: giftMessage || '',
    timeline: { pending: Date.now() },
    deliveryCode: String(Math.floor(1000 + Math.random() * 9000)),
    archived: false
  };
  // Track coupon usage
  if (couponCode) {
    var coupon = db.get('coupons').find({ code: couponCode.toUpperCase() }).value();
    if (coupon) {
      db.get('coupons').find({ code: couponCode.toUpperCase() }).assign({ used: (coupon.used || 0) + 1 }).write();
      db.get('couponUsage').push({ code: couponCode, userId: req.user.id, phone: user?.phone || '', orderId: order.id, date: new Date().toISOString(), discount: discount || 0 }).write();
    }
  }
  // Enforce minimum order total
  const minOrder = db.get('settings').value().minOrder || 0;
  if (minOrder > 0 && order.total < minOrder) return res.status(400).json({ error: 'الحد الأدنى للطلب ' + minOrder + ' ل.س' });
  db.get('orders').push(order).write();
  io.to('admin').emit('new-order', order);
  io.to('user:' + req.user.id).emit('my-order', order);
  res.json(order);
});

app.put('/api/orders/:id/status', adminAuth, adminLimiter, (req, res) => {
  const { status } = req.body;
  const order = db.get('orders').find({ id: req.params.id });
  if (!order.value()) return res.status(404).json({ error: 'Not found' });
  if (status === 'confirmed' || status === 'preparing') decrementStock(order.value());
  const updates = { status, timeline: { ...order.value().timeline, [status]: Date.now() } };
  if (status === 'confirmed' || status === 'preparing') updates.stockDecremented = true;
  if (status === 'delivering' && !order.value().eta) updates.eta = Date.now() + 40 * 60 * 1000;
  if (status === 'delivered') { updates.eta = null; if (order.value().total) addPoints(order.value().userId, order.value().total); }
  order.assign(updates).write();
  io.to('admin').emit('order-status', { id: req.params.id, status, timeline: updates.timeline });
  io.to('user:' + order.value().userId).emit('order-status', { id: req.params.id, status, timeline: updates.timeline });
  if (order.value().userId) sendPushToUser(order.value().userId, 'تحديث طلبك', 'حالة طلبك #' + req.params.id + ' أصبحت: ' + (status === 'pending' ? 'قيد الانتظار' : status === 'confirmed' ? 'مؤكد' : status === 'preparing' ? 'قيد التحضير' : status === 'delivering' ? 'قيد التوصيل' : status === 'delivered' ? 'تم التوصيل' : 'ملغي'), '/customer.html?v=9');
  db.get('adminLog').push({ action: 'status', detail: `طلب ${req.params.id}: ${status}`, time: Date.now() }).write();
  res.json({ success: true });
});

// Bulk status update
app.put('/api/orders/bulk-status', adminAuth, adminLimiter, (req, res) => {
  const { ids, status } = req.body;
  if (!ids || !ids.length) return res.status(400).json({ error: 'No IDs provided' });
  ids.forEach(function(id) {
    var order = db.get('orders').find({ id: id });
    if (order.value()) {
      if (status === 'confirmed' || status === 'preparing') decrementStock(order.value());
      var updates = { status: status, timeline: { ...order.value().timeline, [status]: Date.now() } };
      if (status === 'confirmed' || status === 'preparing') updates.stockDecremented = true;
      if (status === 'delivering' && !order.value().eta) updates.eta = Date.now() + 40 * 60 * 1000;
      if (status === 'delivered') { updates.eta = null; if (order.value().total) addPoints(order.value().userId, order.value().total); }
      order.assign(updates).write();
      io.to('user:' + order.value().userId).emit('order-status', { id: id, status: status, timeline: updates.timeline });
    }
  });
  db.get('adminLog').push({ action: 'bulk-status', detail: ids.length + ' طلبات: ' + status, time: Date.now() }).write();
  res.json({ success: true, count: ids.length });
});

app.put('/api/orders/:id/archive', adminAuth, adminLimiter, (req, res) => {
  db.get('orders').find({ id: req.params.id }).assign({ archived: true }).write();
  res.json({ success: true });
});

app.put('/api/orders/:id/unarchive', adminAuth, adminLimiter, (req, res) => {
  db.get('orders').find({ id: req.params.id }).assign({ archived: false }).write();
  res.json({ success: true });
});

// Customer cancel own pending order
app.put('/api/orders/:id/cancel', auth, spamLimiter, (req, res) => {
  const order = db.get('orders').find({ id: req.params.id });
  if (!order.value()) return res.status(404).json({ error: 'Not found' });
  if (order.value().userId !== req.user.id) return res.status(403).json({ error: 'لا يمكنك إلغاء هذا الطلب' });
  if (order.value().status !== 'pending') return res.status(400).json({ error: 'يمكن إلغاء الطلبات المعلقة فقط' });
  const updates = { status: 'cancelled', timeline: { ...order.value().timeline, cancelled: Date.now() } };
  order.assign(updates).write();
  io.to('admin').emit('order-status', { id: req.params.id, status: 'cancelled', timeline: updates.timeline });
  io.to('user:' + req.user.id).emit('order-status', { id: req.params.id, status: 'cancelled', timeline: updates.timeline });
  db.get('adminLog').push({ action: 'status', detail: `طلب ${req.params.id}: ألغاه الزبون`, time: Date.now() }).write();
  res.json({ success: true });
});

app.put('/api/orders/:id/note', adminAuth, adminLimiter, (req, res) => {
  db.get('orders').find({ id: req.params.id }).assign({ notes: req.body.notes }).write();
  res.json({ success: true });
});

// Invoice data for order (used by admin print)
app.get('/api/orders/:id/invoice', auth, (req, res) => {
  var order = db.get('orders').find({ id: req.params.id }).value();
  if (!order) return res.status(404).json({ error: 'الطلب غير موجود' });
  if (!req.user.admin && order.userId !== req.user.id) return res.status(403).json({ error: 'غير مصرح' });
  var products = db.get('products').value();
  var items = (order.items || []).map(function(item) {
    var prod = products.find(function(p) { return (p.id == item.id || p.id == item.productId); });
    return { name: prod ? prod.name : 'منتج', price: prod ? prod.price : (item.price || 0), qty: item.quantity || item.qty || 1, total: (prod ? prod.price : (item.price || 0)) * (item.quantity || item.qty || 1) };
  });
  var settings = db.get('settings').value();
  res.json({ order: order, items: items, settings: { deliveryFee: settings.deliveryFee, waNumber: settings.waNumber } });
});

function addPoints(userId, total) {
  const user = db.get('users').find({ id: userId }).value();
  if (!user) return;
  const settings = db.get('settings').value();
  // Loyalty tiers: bonus multiplier based on total spent
  var orders = db.get('orders').filter({ userId: userId, status: 'delivered' }).value();
  var totalSpent = orders.reduce(function(s, o) { return s + (o.total || 0); }, 0);
  var multiplier = 1;
  if (totalSpent >= 10000000) multiplier = 3; // Gold: 10M+
  else if (totalSpent >= 5000000) multiplier = 2; // Silver: 5M+
  else if (totalSpent >= 1000000) multiplier = 1.5; // Bronze: 1M+
  const pts = Math.floor(total * (settings.ptsRate || 0.01) * multiplier);
  if (pts > 0) { db.get('users').find({ id: userId }).update('points', function(p) { return (p || 0) + pts; }).write(); logPoints(userId, pts, 'earned', 'طلب بقيمة ' + total); }
}

function decrementStock(order) {
  if (!order || order.stockDecremented) return;
  (order.items || []).forEach(function(item) {
    var prod = db.get('products').find({ id: item.id || item.productId });
    if (prod.value()) {
      var qty = item.quantity || item.qty || 1;
      var oldStock = prod.value().stock || 0;
      var newStock = Math.max(0, oldStock - qty);
      prod.update('stock', function(s) { return newStock; }).write();
      logStock(item.id || item.productId, item.name || prod.value().name, oldStock, newStock, 'طلب ' + (order.id || ''));
    }
  });
}

app.post('/api/points/redeem', auth, spamLimiter, (req, res) => {
  const { amount } = req.body;
  const user = db.get('users').find({ id: req.user.id }).value();
  if (!user) return res.status(404).json({ error: 'User not found' });
  const settings = db.get('settings').value();
  const ptsValue = settings.ptsValue || 10;
  const ptsNeeded = Math.ceil(amount / ptsValue) * 10;
  if ((user.points || 0) < ptsNeeded) return res.status(400).json({ error: 'نقاط غير كافية' });
  db.get('users').find({ id: req.user.id }).update('points', p => (p || 0) - ptsNeeded).write();
  logPoints(req.user.id, -ptsNeeded, 'redeemed', 'استبدال نقاط بقيمة ' + amount);
  res.json({ success: true, deducted: ptsNeeded, remaining: (user.points || 0) - ptsNeeded });
});

// ============ COUPONS ============
app.get('/api/coupons', adminAuth, (req, res) => res.json(db.get('coupons').value()));
// Public: verify a single coupon code (without exposing the full list)
app.post('/api/coupons/check', rateLimit({ windowMs: 60000, max: 30 }), validate([
  { name: 'code', in: 'body', required: true, type: 'string', maxLength: 50, message: 'كود الخصم مطلوب' }
]), (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  const coupon = db.get('coupons').find({ code }).value();
  if (!coupon) return res.json({ valid: false });
  res.json({ valid: true, code: coupon.code, pct: coupon.pct, maxUses: coupon.maxUses, used: coupon.used });
});
app.post('/api/coupons', adminAuth, validate([
  { name: 'code', in: 'body', required: true, type: 'string', maxLength: 50, message: 'كود الكوبون مطلوب' },
  { name: 'pct', in: 'body', required: true, type: 'number', min: 1, max: 100, message: 'نسبة الخصم مطلوبة (1-100)' },
  { name: 'maxUses', in: 'body', required: false, type: 'number', min: 1 }
]), (req, res) => {
  const { code, pct, maxUses } = req.body;
  var existing = db.get('coupons').find({ code: code.toUpperCase() }).value();
  if (existing) return res.status(400).json({ error: 'الكود موجود مسبقاً' });
  db.get('coupons').push({ code: code.toUpperCase(), pct: parseFloat(pct), maxUses: parseInt(maxUses) || 100, used: 0 }).write();
  res.json({ success: true });
});
app.delete('/api/coupons/:code', adminAuth, (req, res) => {
  db.get('coupons').remove({ code: req.params.code }).write();
  res.json({ success: true });
});

// ============ SUGGESTIONS ============
app.get('/api/suggestions', adminAuth, (req, res) => {
  res.json(db.get('suggestions').orderBy('time', 'desc').value());
});
app.post('/api/suggestions', auth, spamLimiter, validate([
  { name: 'text', in: 'body', required: true, type: 'string', minLength: 1, maxLength: 1000, message: 'نص الاقتراح مطلوب' }
]), (req, res) => {
  const user = db.get('users').find({ id: req.user.id }).value();
  const s = { text: sanitize(req.body.text), userId: req.user.id, name: user?.name || '', phone: user?.phone || '', time: Date.now() };
  db.get('suggestions').push(s).write();
  io.to('admin').emit('new-suggestion', s);
  res.json({ success: true });
});
app.delete('/api/suggestions/:time', adminAuth, (req, res) => {
  db.get('suggestions').remove({ time: parseInt(req.params.time) }).write();
  res.json({ success: true });
});

// ============ PRODUCT REQUESTS ============
app.get('/api/requests', adminAuth, (req, res) => {
  res.json(db.get('productRequests').orderBy('time', 'desc').value());
});
app.post('/api/requests', auth, spamLimiter, validate([
  { name: 'name', in: 'body', required: true, type: 'string', maxLength: 200, message: 'اسم المنتج مطلوب' }
]), (req, res) => {
  const user = db.get('users').find({ id: req.user.id }).value();
  const r = { name: sanitize(req.body.name), desc: sanitize(req.body.desc || ''), userId: req.user.id, phone: user?.phone || '', time: Date.now() };
  db.get('productRequests').push(r).write();
  io.to('admin').emit('new-request', r);
  res.json({ success: true });
});
app.delete('/api/requests/:time', adminAuth, (req, res) => {
  db.get('productRequests').remove({ time: parseInt(req.params.time) }).write();
  res.json({ success: true });
});

// ============ ADMIN MESSAGES ============
app.get('/api/messages', adminAuth, (req, res) => {
  res.json(db.get('adminMessages').orderBy('time', 'desc').value());
});
app.post('/api/messages', adminAuth, spamLimiter, validate([
  { name: 'phone', in: 'body', required: true, type: 'string', minLength: 7, message: 'رقم الهاتف مطلوب' },
  { name: 'text', in: 'body', required: true, type: 'string', minLength: 1, maxLength: 2000, message: 'نص الرسالة مطلوب' }
]), (req, res) => {
  const m = { phone: sanitize(req.body.phone), text: sanitize(req.body.text), time: Date.now(), read: false };
  db.get('adminMessages').push(m).write();
  var user = db.get('users').find({ phone: req.body.phone }).value();
  io.to('user:' + (user?.id || req.body.phone)).emit('admin-msg', m);
  res.json({ success: true });
});
app.get('/api/messages/my', auth, (req, res) => {
  const user = db.get('users').find({ id: req.user.id }).value();
  const msgs = db.get('adminMessages').filter(m => m.phone === user?.phone).value();
  res.json(msgs);
});

// ============ BROADCAST ============
app.post('/api/broadcast', adminAuth, (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'النص مطلوب' });
  const msg = { text, time: Date.now(), broadcast: true };
  db.get('adminMessages').push(msg).write();
  io.emit('admin-broadcast', { text });
  db.get('adminLog').push({ action: 'broadcast', detail: 'بث: ' + text.slice(0, 50), time: Date.now() }).write();
  res.json({ success: true });
});

// ============ ONESIGNAL NOTIFICATIONS ============
app.post('/api/onesignal/broadcast', adminAuth, (req, res) => {
  const { title, body } = req.body;
  if (!title || !body) return res.status(400).json({ error: 'العنوان والنص مطلوبان' });
  const appId = process.env.ONESIGNAL_APP_ID;
  const apiKey = process.env.ONESIGNAL_API_KEY;
  if (!appId || !apiKey) return res.status(500).json({ error: 'إعداد OneSignal غير مكتمل' });
  const payload = {
    app_id: appId,
    included_segments: ['Total Subscriptions'],
    target_channel: 'push',
    headings: { en: title },
    contents: { en: body }
  };
  fetch('https://api.onesignal.com/notifications', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + apiKey },
    body: JSON.stringify(payload)
  }).then(r => r.json()).then(data => {
    if (data.errors && data.errors.length) return res.status(400).json({ error: data.errors.join(' | ') });
    db.get('adminLog').push({ action: 'onesignal', detail: 'إشعار: ' + title.slice(0, 40) + ' | id=' + data.id + ' | received=' + data.recipients, time: Date.now() }).write();
    res.json({ success: true, received: data.recipients || 0, id: data.id });
  }).catch(err => res.status(500).json({ error: err.message }));
});

// ============ CUSTOMERS ============
app.get('/api/customers', adminAuth, (req, res) => {
  const customers = db.get('users').value().map(u => {
    const orders = db.get('orders').filter(o => o.userId === u.id).value();
    return {
      id: u.id, phone: u.phone, name: u.name,
      orderCount: orders.length,
      totalSpent: orders.reduce((s, o) => s + (o.total || 0), 0),
      lastOrder: orders.length ? orders[0].date : null,
      blocked: u.blocked || false,
      blockReason: u.blockReason || '',
      adminNotes: u.adminNotes || '',
      adminFlag: u.adminFlag || '',
      points: u.points || 0,
      dob: u.dob || '',
      city: u.city || '',
      createdAt: u.createdAt || ''
    };
  });
  res.json(customers);
});

// Block/unblock customer
app.put('/api/customers/:id/block', adminAuth, (req, res) => {
  var user = db.get('users').find({ id: req.params.id });
  if (!user.value()) return res.status(404).json({ error: 'المستخدم غير موجود' });
  var updates = { blocked: req.body.blocked === true };
  if (req.body.blocked === true && req.body.reason) updates.blockReason = req.body.reason;
  if (req.body.blocked === false) updates.blockReason = '';
  user.assign(updates).write();
  res.json({ success: true, blocked: req.body.blocked === true, reason: updates.blockReason || '' });
});

// Top customers (for analytics widget)
app.get('/api/customers/top', adminAuth, (req, res) => {
  var customers = db.get('users').value().map(function(u) {
    var orders = db.get('orders').filter({ userId: u.id, status: 'delivered' }).value();
    return { id: u.id, name: u.name, phone: u.phone, totalSpent: orders.reduce(function(s, o) { return s + (o.total || 0); }, 0), orderCount: orders.length, points: u.points || 0 };
  }).filter(function(c) { return c.totalSpent > 0; }).sort(function(a, b) { return b.totalSpent - a.totalSpent; }).slice(0, 10);
  res.json(customers);
});

// ============ TOP CUSTOMERS WIDGET ============
app.get('/api/top-customers', adminAuth, (req, res) => {
  var customers = db.get('users').value().map(function(u) {
    var orders = db.get('orders').filter({ userId: u.id, status: 'delivered' }).value();
    return { name: u.name, phone: u.phone, total: orders.reduce(function(s, o) { return s + (o.total || 0); }, 0), count: orders.length };
  }).filter(function(c) { return c.total > 0; }).sort(function(a, b) { return b.total - a.total; }).slice(0, 5);
  res.json(customers);
});

// CSV export: orders
app.get('/api/orders/export', adminAuth, (req, res) => {
  var orders = db.get('orders').filter({ status: 'delivered' }).value().sort(function(a, b) { return b.date > a.date ? 1 : -1; });
  var rows = [['رقم الطلب', 'العميل', 'الهاتف', 'التاريخ', 'المجموع', 'الحالة']];
  orders.forEach(function(o) {
    rows.push([o.id, o.name || o.customerName || '', o.phone || o.customerPhone || '', o.date, o.total || 0, o.status]);
  });
  var csv = rows.map(function(r) { return r.join(','); }).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename=orders.csv');
  res.send('\uFEFF' + csv);
});

// CSV export: products
app.get('/api/products/export', adminAuth, (req, res) => {
  var products = db.get('products').value();
  var rows = [['المعرف', 'الاسم', 'السعر', 'المخزون', 'القسم', 'نشط', 'التكلفة']];
  products.forEach(function(p) {
    rows.push([p.id, p.name, p.price, p.stock != null ? p.stock : '', p.cat || '', p.active ? 'نعم' : 'لا', p.cost || '']);
  });
  var csv = rows.map(function(r) { return r.join(','); }).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename=products.csv');
  res.send('\uFEFF' + csv);
});

// Coupon usage tracking
app.get('/api/coupons/usage', adminAuth, (req, res) => {
  var usage = db.get('couponUsage').value() || [];
  res.json(usage);
});

// ============ WATCHED PRODUCTS ============
app.get('/api/watch', auth, (req, res) => {
  const watched = db.get('watchedProducts').filter({ userId: req.user.id }).value();
  res.json(watched);
});
app.post('/api/watch', auth, spamLimiter, (req, res) => {
  const { productId } = req.body;
  if (!productId) return res.status(400).json({ error: 'productId مطلوب' });
  const existing = db.get('watchedProducts').find({ userId: req.user.id, productId }).value();
  if (existing) return res.json({ success: true });
  db.get('watchedProducts').push({ userId: req.user.id, productId, addedAt: Date.now() }).write();
  res.json({ success: true });
});
app.delete('/api/watch/:productId', auth, (req, res) => {
  db.get('watchedProducts').remove({ userId: req.user.id, productId: parseInt(req.params.productId) }).write();
  res.json({ success: true });
});

// ============ SETTINGS ============
app.get('/api/settings', (req, res) => {
  const s = db.get('settings').value();
  res.json({
    storeName: s.storeName || 'السوبر ماركت',
    storeAddress: s.storeAddress || '',
    storePhone: s.storePhone || '',
    storeDesc: s.storeDesc || '',
    storeLogo: s.storeLogo || '',
    storeFacebook: s.storeFacebook || '',
    storeInstagram: s.storeInstagram || '',
    storeTiktok: s.storeTiktok || '',
    storeLocation: s.storeLocation || '',
    deliveryFee: s.deliveryFee,
    waNumber: s.waNumber,
    ptsRate: s.ptsRate,
    ptsValue: s.ptsValue,
    minFree: s.minFree,
    minOrder: s.minOrder || 0,
    deliverySlots: s.deliverySlots || '["9-12","12-3","3-6","6-9"]',
    bizHours: s.bizHours,
    dealEnd: db.get('dealEnd').value(),
    promo: db.get('promo').value()
  });
});

app.put('/api/settings', adminAuth, validate([
  { name: 'deliveryFee', in: 'body', required: false, type: 'number', min: 0 },
  { name: 'minFree', in: 'body', required: false, type: 'number', min: 0 },
  { name: 'minOrder', in: 'body', required: false, type: 'number', min: 0 },
  { name: 'ptsRate', in: 'body', required: false, type: 'number', min: 0, max: 1 },
  { name: 'ptsValue', in: 'body', required: false, type: 'number', min: 1 }
]), (req, res) => {
  const allowed = ['storeName', 'storeAddress', 'storePhone', 'storeDesc', 'storeLogo', 'storeFacebook', 'storeInstagram', 'storeTiktok', 'storeLocation', 'deliveryFee', 'waNumber', 'ptsRate', 'ptsValue', 'minFree', 'minOrder', 'deliverySlots', 'bizHours', 'adminPW', 'dealEnd', 'promo'];
  const updates = {};
  for (const k of allowed) {
    if (req.body[k] !== undefined) updates[k] = req.body[k];
  }
  if (updates.adminPW) { updates.adminPW = bcrypt.hashSync(updates.adminPW, 10); updates.adminVer = (db.get('settings').value().adminVer || 1) + 1; }
  db.get('settings').assign(updates).write();
  if (req.body.dealEnd !== undefined) db.set('dealEnd', req.body.dealEnd).write();
  if (req.body.promo !== undefined) io.emit('deal-update', db.get('promo').value());
  res.json({ success: true });
});

// Change admin password (requires current password, invalidates old admin sessions)
app.put('/api/auth/admin-password', adminAuth, authLimiter, validate([
  { name: 'oldPassword', in: 'body', required: true, type: 'string', minLength: 1, message: 'كلمة السر الحالية مطلوبة' },
  { name: 'newPassword', in: 'body', required: true, type: 'string', minLength: 4, maxLength: 30, message: 'كلمة السر الجديدة مطلوبة (4-30 حرف)' }
]), (req, res) => {
  var settings = db.get('settings').value();
  if (!bcrypt.compareSync(req.body.oldPassword, settings.adminPW)) return res.status(401).json({ error: 'كلمة السر الحالية غير صحيحة' });
  db.get('settings').assign({ adminPW: bcrypt.hashSync(req.body.newPassword, 10), adminVer: (settings.adminVer || 1) + 1 }).write();
  db.get('adminLog').push({ action: 'admin-password', detail: 'تغيير كلمة سر الأدمن', time: Date.now() }).write();
  res.json({ success: true });
});

// Reset settings to defaults
app.post('/api/settings/reset', adminAuth, (req, res) => {
  var defaults = { storeName: 'السوبر ماركت', storeAddress: '', storePhone: '', storeDesc: '', deliveryFee: 5000, waNumber: '', ptsRate: 0.1, ptsValue: 100, minFree: 50000, minOrder: 0, deliverySlots: '["9-12","12-3","3-6","6-9"]', bizHours: '', adminPW: db.get('settings').value().adminPW, dealEnd: null, promo: null };
  db.get('settings').assign(defaults).write();
  db.get('adminLog').push({ action: 'settings-reset', detail: 'إعادة تعيين الإعدادات', time: Date.now() }).write();
  res.json({ success: true });
});

// ============ ADMIN LOG ============
app.get('/api/admin-log', adminAuth, (req, res) => {
  res.json(db.get('adminLog').orderBy('time', 'desc').take(100).value());
});

// ============ DASHBOARD STATS ============
app.get('/api/admin/stats', adminAuth, (req, res) => {
  const orders = db.get('orders').value();
  const users = db.get('users').value();
  var today = new Date().toISOString().slice(0, 10);
  var todayOrders = orders.filter(function(o) { return o.date && o.date.slice(0, 10) === today; });
  var topUser = { name: '-', total: 0 };
  var userMap = {};
  orders.forEach(function(o) {
    var key = o.phone || o.name || 'unknown';
    userMap[key] = userMap[key] || { name: o.name || o.customerName || key, total: 0, phone: o.phone || '' };
    userMap[key].total += o.total || 0;
  });
  Object.keys(userMap).forEach(function(k) {
    if (userMap[k].total > topUser.total) topUser = userMap[k];
  });
  // Best-selling products (from delivered orders)
  var prodCount = {};
  orders.filter(function(o) { return o.status === 'delivered'; }).forEach(function(o) {
    (o.items || []).forEach(function(item) {
      var pid = item.id || item.productId || item.name || 'unknown';
      prodCount[pid] = (prodCount[pid] || 0) + (item.quantity || item.qty || 1);
    });
  });
  var topProducts = Object.keys(prodCount).sort(function(a,b) { return (prodCount[b] || 0) - (prodCount[a] || 0); }).slice(0, 5).map(function(pid) {
    var p = db.get('products').find({ id: parseInt(pid) }).value();
    return { id: pid, name: p ? p.name : pid, count: prodCount[pid] };
  });
  res.json({
    totalOrders: orders.length,
    totalUsers: users.length,
    revenue: orders.reduce((s, o) => s + (o.total || 0), 0),
    pending: orders.filter(o => o.status === 'pending').length,
    confirmed: orders.filter(o => o.status === 'confirmed').length,
    preparing: orders.filter(o => o.status === 'preparing').length,
    delivering: orders.filter(o => o.status === 'delivering').length,
    delivered: orders.filter(o => o.status === 'delivered').length,
    cancelled: orders.filter(o => o.status === 'cancelled').length,
    todayOrders: todayOrders.length,
    topCustomer: topUser.name,
    topCustomerTotal: topUser.total,
    topCustomerPhone: topUser.phone,
    topProducts: topProducts
  });
});

// Sales data for chart (last N days)
app.get('/api/admin/sales', adminAuth, (req, res) => {
  const days = parseInt(req.query.days) || 7;
  const orders = db.get('orders').filter(o => o.status === 'delivered').value();
  const data = [];
  for (var i = days - 1; i >= 0; i--) {
    var d = new Date();
    d.setDate(d.getDate() - i);
    var dateStr = d.toISOString().slice(0, 10);
    var dayOrders = orders.filter(function(o) { return o.date && o.date.slice(0, 10) === dateStr; });
    var total = dayOrders.reduce(function(s, o) { return s + (o.total || 0); }, 0);
    var labels = ['الأحد','الإثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
    data.push({ date: dateStr, day: labels[d.getDay()] || d.getDay(), total: total, count: dayOrders.length });
  }
  res.json(data);
});

// ============ SOCKET.IO ============
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  function verifyToken(tok) {
    if (!tok) tok = socket.handshake.auth && socket.handshake.auth.token;
    try { return jwt.verify(tok || '', JWT_SECRET); } catch (e) { return null; }
  }
  socket.on('join', (data) => {
    var room = typeof data === 'string' ? data : (data && data.room);
    var decoded = verifyToken(typeof data === 'string' ? null : (data && data.token));
    if (!decoded || !decoded.id || room !== 'user:' + decoded.id) return;
    socket.join(room);
    console.log(`Socket ${socket.id} joined room ${room}`);
  });
  socket.on('admin-join', (tok) => {
    var decoded = verifyToken(tok);
    if (!decoded || !decoded.admin) return;
    socket.join('admin');
    console.log(`Admin ${socket.id} joined admin room`);
  });
  socket.on('join-delivery', (did, tok) => {
    if (did && typeof did === 'object') { tok = did.token; did = did.did; }
    var decoded = verifyToken(tok);
    if (!decoded || decoded.role !== 'delivery' || decoded.id !== did) return;
    socket.join('delivery:' + did);
    console.log(`Delivery ${socket.id} joined room delivery:${did}`);
  });
  socket.on('delivery-location', (data) => {
    var decoded = verifyToken(null);
    if (!decoded || decoded.role !== 'delivery') return;
    if (data && data.orderId) {
      var ord = db.get('orders').find({ id: data.orderId }).value();
      if (ord && ord.deliveryPerson === decoded.name) {
        io.to('user:' + ord.userId).emit('delivery-location', { lat: data.lat, lng: data.lng, name: data.name, orderId: data.orderId });
      }
    }
  });
  socket.on('disconnect', () => console.log('Client disconnected:', socket.id));
});

// ============ REVIEWS ============
app.post('/api/reviews', auth, spamLimiter, validate([
  { name: 'productId', in: 'body', required: true, type: 'number', message: 'معرف المنتج مطلوب' },
  { name: 'rating', in: 'body', required: true, type: 'number', min: 1, max: 5, message: 'التقييم من 1 إلى 5' },
  { name: 'comment', in: 'body', required: false, type: 'string', maxLength: 1000 }
]), (req, res) => {
  var product = db.get('products').find({ id: req.body.productId }).value();
  if (!product) return res.status(404).json({ error: 'المنتج غير موجود' });
  var existing = db.get('reviews').find({ userId: req.user.id, productId: req.body.productId }).value();
  if (existing) return res.status(400).json({ error: 'قمت بتقييم هذا المنتج مسبقاً' });
  var review = { id: Date.now().toString(36), userId: req.user.id, userName: req.user.name || 'مستخدم', productId: req.body.productId, rating: req.body.rating, comment: req.body.comment || '', image: req.body.image || '', date: new Date().toISOString() };
  db.get('reviews').push(review).write();
  res.json({ success: true, review: review });
});
app.get('/api/reviews/:productId', (req, res) => {
  var reviews = db.get('reviews').filter({ productId: parseInt(req.params.productId) }).value().reverse();
  res.json(reviews);
});
app.delete('/api/reviews/:id', adminAuth, (req, res) => {
  db.get('reviews').remove({ id: req.params.id }).write();
  res.json({ success: true });
});

// ============ SUPPORT TICKETS ============
app.post('/api/tickets', auth, spamLimiter, validate([
  { name: 'subject', in: 'body', required: true, type: 'string', minLength: 3, maxLength: 200, message: 'عنوان التذكرة مطلوب' },
  { name: 'message', in: 'body', required: true, type: 'string', minLength: 5, maxLength: 2000, message: 'الرسالة مطلوبة' }
]), (req, res) => {
  var ticket = { id: 'TKT-' + Date.now().toString(36).toUpperCase(), userId: req.user.id, userName: req.user.name || 'مستخدم', subject: sanitize(req.body.subject), status: 'open', messages: [{ from: 'user', text: sanitize(req.body.message), time: Date.now() }], date: new Date().toISOString() };
  db.get('tickets').push(ticket).write();
  io.to('admin').emit('new-ticket', ticket);
  res.json({ success: true, ticket: ticket });
});
app.get('/api/tickets', auth, (req, res) => {
  var tickets = db.get('tickets').filter({ userId: req.user.id }).value().reverse();
  res.json(tickets);
});
app.get('/api/tickets/all', adminAuth, (req, res) => {
  res.json(db.get('tickets').value().reverse());
});
app.post('/api/tickets/:id/reply', auth, validate([
  { name: 'text', in: 'body', required: true, type: 'string', minLength: 1, maxLength: 2000 }
]), (req, res) => {
  var ticket = db.get('tickets').find({ id: req.params.id });
  if (!ticket.value()) return res.status(404).json({ error: 'التذكرة غير موجودة' });
  if (ticket.value().userId !== req.user.id && !req.user.admin) return res.status(403).json({ error: 'غير مصرح' });
  var msgs = ticket.value().messages || [];
  msgs.push({ from: req.user.admin ? 'admin' : 'user', text: req.body.text, time: Date.now() });
  ticket.assign({ messages: msgs, status: req.user.admin ? 'answered' : 'open' }).write();
  var target = req.user.admin ? 'user:' + ticket.value().userId : 'admin';
  io.to(target).emit('ticket-reply', ticket.value());
  res.json({ success: true, ticket: ticket.value() });
});
app.put('/api/tickets/:id/status', adminAuth, (req, res) => {
  db.get('tickets').find({ id: req.params.id }).assign({ status: req.body.status || 'closed' }).write();
  res.json({ success: true });
});

// ============ RECURRING ORDERS ============
app.post('/api/recurring', auth, validate([
  { name: 'frequency', in: 'body', required: true, type: 'string', message: 'التكرار مطلوب (weekly/monthly)' },
  { name: 'items', in: 'body', required: true },
  { name: 'address', in: 'body', required: true, type: 'string', minLength: 5 }
]), (req, res) => {
  var r = { id: 'REC-' + Date.now().toString(36).toUpperCase(), userId: req.user.id, frequency: req.body.frequency, items: req.body.items || [], address: req.body.address, total: req.body.total || 0, nextDate: req.body.nextDate || '', active: true, created: new Date().toISOString() };
  db.get('recurringOrders').push(r).write();
  res.json({ success: true, recurring: r });
});
app.get('/api/recurring', auth, (req, res) => {
  res.json(db.get('recurringOrders').filter({ userId: req.user.id }).value());
});
app.get('/api/recurring/all', adminAuth, (req, res) => {
  res.json(db.get('recurringOrders').value());
});
app.put('/api/recurring/:id', auth, (req, res) => {
  var r = db.get('recurringOrders').find({ id: req.params.id });
  if (!r.value()) return res.status(404).json({ error: 'غير موجود' });
  if (r.value().userId !== req.user.id && !req.user.admin) return res.status(403).json({ error: 'غير مصرح' });
  if (req.body.active !== undefined) r.assign({ active: req.body.active }).write();
  if (req.body.frequency) r.assign({ frequency: req.body.frequency }).write();
  if (req.body.items) r.assign({ items: req.body.items }).write();
  if (req.body.address) r.assign({ address: req.body.address }).write();
  if (req.body.total) r.assign({ total: req.body.total }).write();
  if (req.body.nextDate) r.assign({ nextDate: req.body.nextDate }).write();
  res.json({ success: true });
});

// ============ POINTS HISTORY ============
app.get('/api/points/history', auth, (req, res) => {
  var history = db.get('pointsHistory').filter({ userId: req.user.id }).value().reverse();
  res.json(history);
});

// Admin: get all points history
app.get('/api/points/all', adminAuth, (req, res) => {
  var all = db.get('pointsHistory').value().reverse();
  // Enrich with user names
  var users = db.get('users').value();
  all = all.map(function(p) {
    var u = users.find(function(u) { return u.id === p.userId; });
    p.userName = u ? (u.name || u.phone || '') : '';
    p.userPhone = u ? (u.phone || '') : '';
    return p;
  });
  res.json(all);
});

// Points tracking: add to history when earned/spent (called from addPoints and redeem)
function logPoints(userId, amount, type, note) {
  if (!amount) return;
  db.get('pointsHistory').push({ userId: userId, amount: amount, type: type, note: note || '', date: new Date().toISOString() }).write();
}

app.delete('/api/recurring/:id', adminAuth, (req, res) => {
  var r = db.get('recurringOrders').remove({ id: req.params.id }).write();
  if (!r.length) return res.status(404).json({ error: 'غير موجود' });
  res.json({ success: true });
});

// ============ SALES REPORTS ============
app.get('/api/reports/sales', adminAuth, (req, res) => {
  var period = req.query.period || 'daily';
  var orders = db.get('orders').filter({ status: 'delivered' }).value();
  var now = new Date();
  var groups = {};
  orders.forEach(function(o) {
    var d = new Date(o.date);
    var key;
    if (period === 'daily') key = d.toISOString().slice(0, 10);
    else if (period === 'weekly') { var start = new Date(d); start.setDate(d.getDate() - d.getDay()); key = start.toISOString().slice(0, 10); }
    else if (period === 'monthly') key = d.toISOString().slice(0, 7);
    else key = d.toISOString().slice(0, 10);
    if (!groups[key]) groups[key] = { date: key, total: 0, count: 0, items: 0 };
    groups[key].total += o.total || 0;
    groups[key].count += 1;
    groups[key].items += (o.items || []).length;
  });
  var result = Object.keys(groups).sort().map(function(k) { return groups[k]; });
  var totals = { totalSales: result.reduce(function(s, r) { return s + r.total; }, 0), totalOrders: result.reduce(function(s, r) { return s + r.count; }, 0), totalItems: result.reduce(function(s, r) { return s + r.items; }, 0) };
  res.json({ report: result, totals: totals, period: period });
});

// ============ STOCK LOG ============
app.get('/api/stock/log', adminAuth, (req, res) => {
  var log = db.get('stockLog').value().reverse().slice(0, 200);
  res.json(log);
});

// ============ BULK STOCK UPDATE ============
app.post('/api/products/bulk-stock', adminAuth, (req, res) => {
  var updates = req.body.updates || [];
  var count = 0;
  updates.forEach(function(u) {
    var prod = db.get('products').find({ id: parseInt(u.id) });
    if (prod.value()) {
      var oldStock = prod.value().stock || 0;
      var newStock = parseInt(u.stock);
      if (!isNaN(newStock) && newStock >= 0) {
        prod.assign({ stock: newStock }).write();
        logStock(parseInt(u.id), prod.value().name, oldStock, newStock, 'تحديث يدوي');
        count++;
      }
    }
  });
  io.emit('products-update');
  res.json({ success: true, count: count });
});

// ============ SALES BY CATEGORY ============
app.get('/api/reports/categories', adminAuth, (req, res) => {
  var orders = db.get('orders').filter({ status: 'delivered' }).value();
  var products = db.get('products').value();
  var catSales = {};
  var total = 0;
  orders.forEach(function(o) {
    (o.items || []).forEach(function(item) {
      var prod = products.find(function(p) { return p.id == (item.id || item.productId); });
      var cat = prod ? (prod.cat || prod.category || 'أخرى') : 'أخرى';
      var qty = item.quantity || item.qty || 1;
      var itemTotal = (prod ? prod.price : (item.price || 0)) * qty;
      if (!catSales[cat]) catSales[cat] = { name: cat, total: 0, count: 0 };
      catSales[cat].total += itemTotal;
      catSales[cat].count += qty;
      total += itemTotal;
    });
  });
  var result = Object.keys(catSales).map(function(k) { catSales[k].pct = total > 0 ? Math.round(catSales[k].total / total * 100) : 0; return catSales[k]; }).sort(function(a, b) { return b.total - a.total; });
  res.json({ categories: result, total: total });
});

// ============ PEAK HOURS ============
app.get('/api/reports/peak-hours', adminAuth, (req, res) => {
  var orders = db.get('orders').filter({ status: 'delivered' }).value();
  var hours = {};
  for (var h = 0; h < 24; h++) hours[h] = { hour: h, count: 0, total: 0 };
  orders.forEach(function(o) {
    var d = new Date(o.date);
    var h = d.getHours();
    if (hours[h]) { hours[h].count++; hours[h].total += o.total || 0; }
  });
  res.json(Object.keys(hours).map(function(k) { return hours[k]; }));
});

// ============ CUSTOMER NOTES ============
app.put('/api/customers/:id/notes', adminAuth, (req, res) => {
  var user = db.get('users').find({ id: req.params.id });
  if (!user.value()) return res.status(404).json({ error: 'المستخدم غير موجود' });
  user.assign({ adminNotes: req.body.notes || '', adminFlag: req.body.flag || '' }).write();
  res.json({ success: true });
});

// ============ RETURN / REFUND ============
app.post('/api/orders/:id/return', adminAuth, (req, res) => {
  var order = db.get('orders').find({ id: req.params.id });
  if (!order.value()) return res.status(404).json({ error: 'الطلب غير موجود' });
  if (order.value().status !== 'delivered') return res.status(400).json({ error: 'يمكن إرجاع الطلبات المسلمة فقط' });
  order.assign({ status: 'returned', returnedAt: Date.now(), returnNote: req.body.note || '', returnedItems: (order.value().items || []).map(function(i) { return Object.assign({}, i); }) }).write();
  // Restore stock
  (order.value().items || []).forEach(function(item) {
    var prod = db.get('products').find({ id: item.id || item.productId });
    if (prod.value()) {
      var oldStock = prod.value().stock || 0;
      var qty = item.quantity || item.qty || 1;
      prod.assign({ stock: oldStock + qty }).write();
      logStock(item.id || item.productId, item.name || prod.value().name, oldStock, oldStock + qty, 'إرجاع طلب ' + order.value().id);
    }
  });
  io.to('admin').emit('order-status', { id: order.value().id, status: 'returned' });
  io.to('user:' + order.value().userId).emit('order-status', { id: order.value().id, status: 'returned' });
  db.get('adminLog').push({ action: 'return', detail: 'طلب ' + order.value().id + ' مرتجع', time: Date.now() }).write();
  res.json({ success: true });
});

// ============ EXPIRING PRODUCTS ============
app.get('/api/products/expiring', adminAuth, (req, res) => {
  var products = db.get('products').filter(function(p) { return p.expiryDate && new Date(p.expiryDate) - Date.now() < 7 * 86400000 && p.active !== false; }).value();
  res.json(products);
});

// ============ REORDER LIST ============
app.get('/api/reorder-list', adminAuth, (req, res) => {
  var threshold = parseInt(req.query.threshold) || 10;
  var products = db.get('products').filter(function(p) { return p.active !== false && p.stock != null && p.stock <= threshold; }).value().sort(function(a, b) { return (a.stock || 0) - (b.stock || 0); });
  res.json(products);
});

// ============ TODAY VS YESTERDAY ============
app.get('/api/reports/today', adminAuth, (req, res) => {
  var now = new Date();
  var todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  var yesterdayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).toISOString();
  var todayOrders = db.get('orders').filter(function(o) { return o.date >= todayStart; }).value();
  var yesterdayOrders = db.get('orders').filter(function(o) { return o.date >= yesterdayStart && o.date < todayStart; }).value();
  res.json({
    today: { count: todayOrders.length, total: todayOrders.reduce(function(s, o) { return s + (o.total || 0); }, 0) },
    yesterday: { count: yesterdayOrders.length, total: yesterdayOrders.reduce(function(s, o) { return s + (o.total || 0); }, 0) }
  });
});

// ============ CUSTOMER DETAIL DATA ============
app.get('/api/customers/:id/orders', adminAuth, (req, res) => {
  var orders = db.get('orders').filter({ userId: req.params.id }).value().reverse();
  res.json(orders);
});
app.get('/api/customers/:id/tickets', adminAuth, (req, res) => {
  var tickets = db.get('tickets').filter({ userId: req.params.id }).value().reverse();
  res.json(tickets);
});
app.get('/api/customers/:id/points', adminAuth, (req, res) => {
  var history = db.get('pointsHistory').filter({ userId: req.params.id }).value().reverse();
  res.json(history);
});
app.get('/api/customers/:id/recurring', adminAuth, (req, res) => {
  var recurring = db.get('recurringOrders').filter({ userId: req.params.id }).value();
  res.json(recurring);
});

// ============ DELIVERY PERSON SYSTEM ============
function deliveryAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'delivery') return res.status(403).json({ error: 'Not a delivery person' });
    var person = db.get('deliveryPersons').find({ id: decoded.id }).value();
    if (!person) return res.status(401).json({ error: 'الحساب لم يعد موجوداً' });
    if (decoded.pwVer && person.pwVer && decoded.pwVer !== person.pwVer) return res.status(401).json({ error: 'انتهت الجلسة، سجل دخولك من جديد' });
    if (person.active === false) return res.status(403).json({ error: 'هذا الحساب موقوف' });
    req.delivery = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}
app.post('/api/delivery/login', authLimiter, validate([
  { name: 'phone', in: 'body', required: true, type: 'string', minLength: 7, maxLength: 15 },
  { name: 'password', in: 'body', required: true, type: 'string', minLength: 1 }
]), async (req, res) => {
  try {
    const { phone, password } = req.body;
    const person = db.get('deliveryPersons').find({ phone }).value();
    if (!person || !bcrypt.compareSync(password, person.password)) return res.status(401).json({ error: 'رقم الهاتف أو كلمة السر خطأ' });
    if (person.active === false) return res.status(403).json({ error: 'هذا الحساب موقوف، يرجى التواصل مع الإدارة' });
    const token = jwt.sign({ id: person.id, phone: person.phone, name: person.name, role: 'delivery', pwVer: person.pwVer || 1 }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, person: { id: person.id, name: person.name, phone: person.phone } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/delivery/me', deliveryAuth, (req, res) => {
  const person = db.get('deliveryPersons').find({ id: req.delivery.id }).value();
  if (!person) return res.status(404).json({ error: 'Not found' });
  res.json({ id: person.id, name: person.name, phone: person.phone, active: person.active });
});
// Admin: manage delivery persons
app.get('/api/delivery/persons', adminAuth, (req, res) => {
  res.json(db.get('deliveryPersons').value().map(function(p) { return { id: p.id, name: p.name, phone: p.phone, active: p.active !== false, createdAt: p.createdAt }; }));
});
app.post('/api/delivery/persons', adminAuth, validate([
  { name: 'name', in: 'body', required: true, type: 'string', minLength: 1, message: 'اسم المندوب مطلوب' },
  { name: 'phone', in: 'body', required: true, type: 'string', minLength: 7, maxLength: 15, message: 'رقم الهاتف مطلوب' },
  { name: 'password', in: 'body', required: true, type: 'string', minLength: 4, message: 'كلمة السر مطلوبة (4 أحرف على الأقل)' }
]), async (req, res) => {
  try {
    const { name, phone, password } = req.body;
    if (db.get('deliveryPersons').find({ phone }).value()) return res.status(400).json({ error: 'هذا الرقم مسجل مسبقاً' });
    const person = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name, phone, password: bcrypt.hashSync(password, 10), pwVer: 1, active: true, createdAt: new Date().toISOString() };
    db.get('deliveryPersons').push(person).write();
    res.json({ success: true, person });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/delivery/persons/:id', adminAuth, async (req, res) => {
  const person = db.get('deliveryPersons').find({ id: req.params.id });
  if (!person.value()) return res.status(404).json({ error: 'المندوب غير موجود' });
  const updates = {};
  if (req.body.name) updates.name = req.body.name;
  if (req.body.phone) updates.phone = req.body.phone;
  if (req.body.password) updates.password = bcrypt.hashSync(req.body.password, 10);
  if (req.body.password) updates.pwVer = (person.value().pwVer || 1) + 1;
  if (req.body.active !== undefined) updates.active = req.body.active;
  person.assign(updates).write();
  res.json({ success: true });
});
app.delete('/api/delivery/persons/:id', adminAuth, (req, res) => {
  db.get('deliveryPersons').remove({ id: req.params.id }).write();
  res.json({ success: true });
});
// Delivery person: get their assigned orders
app.get('/api/delivery/orders', deliveryAuth, (req, res) => {
  var orders = db.get('orders').filter(function(o) { return o.deliveryPerson === req.delivery.name; }).value().sort(function(a, b) { return (b.date || '') > (a.date || '') ? 1 : -1; });
  // Attach user info for each order
  var result = orders.map(function(o) {
    var user = db.get('users').find({ id: o.userId }).value();
    return Object.assign({}, o, { customerName: o.customerName || user?.name || '', customerPhone: o.contactPhone || o.phone || user?.phone || '', customerAddress: o.address || user?.address || '' });
  });
  res.json(result);
});
// Delivery person: update order status (delivering/delivered)
app.put('/api/delivery/orders/:id/status', deliveryAuth, spamLimiter, (req, res) => {
  const { status, cashCollected, deliveryNote, deliveryCode } = req.body;
  if (!['delivering', 'delivered'].includes(status)) return res.status(400).json({ error: 'حالة غير صالحة' });
  var orderEnt = db.get('orders').find({ id: req.params.id });
  if (!orderEnt.value()) return res.status(404).json({ error: 'الطلب غير موجود' });
  if (orderEnt.value().deliveryPerson !== req.delivery.name) return res.status(403).json({ error: 'هذا الطلب غير مسند إليك' });
  if (status === 'delivered' && orderEnt.value().deliveryCode && deliveryCode !== orderEnt.value().deliveryCode) {
    return res.status(400).json({ error: 'كود التوصيل خطأ!' });
  }
  const updates = { status: status, timeline: Object.assign({}, orderEnt.value().timeline, { [status]: Date.now() }) };
  if (status === 'delivering' && !orderEnt.value().eta) updates.eta = Date.now() + 40 * 60 * 1000;
  if (status === 'delivered') {
    updates.eta = null;
    if (orderEnt.value().total) addPoints(orderEnt.value().userId, orderEnt.value().total);
    if (cashCollected) updates.cashCollected = cashCollected;
    if (deliveryNote) updates.deliveryNote = deliveryNote;
  }
  orderEnt.assign(updates).write();
  io.to('admin').emit('order-status', { id: req.params.id, status: status, timeline: updates.timeline });
  io.to('user:' + orderEnt.value().userId).emit('order-status', { id: req.params.id, status: status, timeline: updates.timeline, deliveryNote: deliveryNote || '' });
  io.to('delivery:' + req.delivery.id).emit('my-status', { id: req.params.id, status: status });
  res.json({ success: true });
});
// Delivery person: update ETA
app.put('/api/delivery/orders/:id/eta', deliveryAuth, spamLimiter, (req, res) => {
  var order = db.get('orders').find({ id: req.params.id });
  if (!order.value()) return res.status(404).json({ error: 'الطلب غير موجود' });
  if (order.value().deliveryPerson !== req.delivery.name) return res.status(403).json({ error: 'هذا الطلب غير مسند إليك' });
  var etaTs = typeof req.body.eta === 'string' ? new Date(req.body.eta).getTime() : Number(req.body.eta) || 0;
  order.assign({ eta: etaTs }).write();
  io.to('user:' + order.value().userId).emit('order-status', { id: req.params.id, eta: etaTs });
  res.json({ success: true });
});

app.get('/', (req, res) => res.redirect('/customer.html?v=9'));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/delivery', (req, res) => res.sendFile(path.join(__dirname, 'public', 'delivery.html')));
app.use(express.static(path.join(__dirname, 'public')));

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

db.ready.then(async () => {
  try { await ensureBucket(); } catch (e) { console.error('Bucket warning:', e.message); }
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Customer app: http://localhost:${PORT}`);
    console.log(`Admin panel: http://localhost:${PORT}/admin`);
    console.log(`Delivery app: http://localhost:${PORT}/delivery`);
  });
}).catch(e => {
  console.error('فشل الاتصال بقاعدة البيانات Supabase:', e.message);
  process.exit(1);
});
