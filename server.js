/* ============================================================================
 * 🛡️ GEO-CASE SYSTEM — SERVER (v2 / Production-Hardened)
 * ----------------------------------------------------------------------------
 * ✦ Security : JWT token-versioning, rate-limit, origin-guard, magic-byte +
 *              extension whitelist, forced Content-Type, helmet, bcrypt-12
 * ✦ Feature  : pagination, search, near-me (Haversine), แก้ไขเคส, ลบเคส,
 *              avatar route แบบมีสิทธิ์, audit-log + retention, backup rotation
 * ✦ Ops      : structured JSON log, health check (ไม่ติด rate-limit),
 *              graceful shutdown, statement cache, WAL tuning, migration
 *  Optional deps : npm i helmet compression
 * ==========================================================================*/
'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const Database = require('better-sqlite3');
const { Server } = require('socket.io');
const geo = require('./geo');

/* ---------- 1) CONFIG & ENV ---------- */
const PORT = Number(process.env.PORT) || 3000;
const SECRET = process.env.JWT_SECRET;
const ISSUER = 'geo-case-api';
const PROD = process.env.NODE_ENV === 'production';
const BCRYPT_ROUNDS = 12;
const JWT_TTL = '8h';
const COOKIE_MAX_AGE = 8 * 3600e3;

const loginTries = new Map();
setInterval(() => { const n = Date.now(); for (const [k, v] of loginTries) if (n - v.at > 30 * 60e3) loginTries.delete(k); }, 10 * 60e3).unref();

const DUMMY_HASH = bcrypt.hashSync(
  'dummy-password-for-timing-only-9X7k2Lm4',
  BCRYPT_ROUNDS
);
const AUDIT_RETENTION_DAYS = Number(process.env.AUDIT_RETENTION_DAYS) || 180;
const BACKUP_KEEP = Number(process.env.BACKUP_KEEP) || 14;

if (!SECRET || SECRET.length < 32)
  throw new Error('Critical Security Error: JWT_SECRET must be defined and at least 32 characters long.');

/* ---------- 2) STRUCTURED LOGGER ---------- */
const log = (level, msg, meta = {}) => {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...meta });
  (level === 'error' ? console.error : console.log)(line);
};

/* ---------- 3) APP CORE ---------- */
const app = express();
app.set('trust proxy', process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) : 1);
app.disable('x-powered-by');

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.SOCKET_ORIGIN ? process.env.SOCKET_ORIGIN.split(',') : false, credentials: true },
  maxHttpBufferSize: 1e6,
  pingInterval: 25000,
  pingTimeout: 20000
});

try { app.use(require('compression')()); } catch { log('warn', 'compression ไม่ได้ติดตั้ง (แนะนำ: npm i compression)'); }
try {
  const helmet = require('helmet');
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' }   // ให้ tile server รับ Referer ได้
  }));
} catch { log('warn', 'helmet ไม่ได้ติดตั้ง — แนะนำอย่างยิ่งใน production (npm i helmet)'); }

/* ---------- 4) DATABASE + MIGRATION ---------- */
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new Database(path.join(__dirname, 'data.db'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

const tableCols = t => new Set(db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name));
const hasCol = (t, c) => tableCols(t).has(c);
const addCol = (table, ddl) => {
  const col = ddl.split(' ')[0];
  if (!hasCol(table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl};`);
};

function migrate() {
  const v = db.pragma('user_version', { simple: true });

  if (v < 1) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      first_name TEXT, last_name TEXT, nickname TEXT,
      affiliation TEXT, affiliation_other TEXT,
      phone TEXT,
      avatar TEXT,
      facebook TEXT, tiktok TEXT, line_id TEXT, website TEXT,
      role TEXT NOT NULL DEFAULT 'user',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS points (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      lat REAL NOT NULL, lng REAL NOT NULL,
      case_name TEXT NOT NULL,
      case_type TEXT NOT NULL, case_type_other TEXT,
      caretaker_name TEXT, caretaker_phone TEXT,
      address TEXT, note TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      reject_reason TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY(user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS point_photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      point_id INTEGER NOT NULL,
      file TEXT NOT NULL,
      FOREIGN KEY(point_id) REFERENCES points(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      action TEXT NOT NULL,
      resource_type TEXT,
      resource_id INTEGER,
      ip TEXT,
      user_agent TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    `);
    db.pragma('user_version = 1');
    log('info', 'DB migration v1 applied');
  }

  // ✅ idempotent — ต้องรันทุกครั้ง ไม่ผูกกับ user_version
  addCol('users', 'token_version INTEGER NOT NULL DEFAULT 0');
  addCol('users', 'last_login_at TEXT');
  addCol('users', 'updated_at TEXT');

  /* ---------- PDPA ---------- */
  addCol('users', 'pdpa_acknowledged INTEGER NOT NULL DEFAULT 0');
  addCol('users', 'pdpa_acknowledged_at TEXT');
  addCol('users', 'pdpa_notice_version TEXT');
  addCol('users', 'pdpa_acknowledged_ip TEXT');
  addCol('users', 'pdpa_acknowledged_user_agent TEXT');

  addCol('points', 'updated_at TEXT');
  addCol('points', 'deleted_at TEXT');
  addCol('audit_logs', 'request_id TEXT');
}

// ✅ สร้าง index หลัง geo.migrate() เท่านั้น และข้ามคอลัมน์ที่ยังไม่มี
function ensureIndexes() {
  const idx = [
    ['idx_points_status',     'points',       'status'],
    ['idx_points_user',       'points',       'user_id'],
    ['idx_points_amphoe',     'points',       'amphoe'],
    ['idx_points_tambon',     'points',       'tambon'],
    ['idx_points_case_type',  'points',       'case_type'],
    ['idx_points_deleted',    'points',       'deleted_at'],
    ['idx_photos_point',      'point_photos', 'point_id'],
    ['idx_users_status',      'users',        'status'],
    ['idx_audit_created',     'audit_logs',   'created_at'],
    ['idx_audit_user',        'audit_logs',   'user_id']
  ];
  for (const [name, tbl, col] of idx) {
    try {
      if (hasCol(tbl, col)) db.exec(`CREATE INDEX IF NOT EXISTS ${name} ON ${tbl}(${col});`);
      else log('warn', 'ข้าม index เพราะยังไม่มีคอลัมน์', { name, tbl, col });
    } catch (e) { log('error', 'สร้าง index ไม่สำเร็จ', { name, err: e.message }); }
  }
}

migrate();
geo.migrate(db);     // geo เพิ่ม amphoe/tambon/moo/accuracy/area_source
ensureIndexes();     // แล้วค่อยสร้าง index

require('./scale-server')({ db, log });
/* ---------- 5) PREPARED STATEMENT CACHE ---------- */
const _stmts = new Map();
const P = sql => { let s = _stmts.get(sql); if (!s) _stmts.set(sql, (s = db.prepare(sql))); return s; };

const INITIAL_ADMIN_PWD = process.env.INITIAL_ADMIN_PASSWORD;
if (!P('SELECT 1 FROM users WHERE username=?').get('admin')) {
  if (!INITIAL_ADMIN_PWD || INITIAL_ADMIN_PWD.length < 8) {
    log('warn', 'กำหนด INITIAL_ADMIN_PASSWORD (อย่างน้อย 8 ตัวอักษร) เพื่อสร้างบัญชีผู้ดูแลเริ่มต้น');
  } else {
    P(`INSERT INTO users (username,password,first_name,last_name,nickname,affiliation,phone,role,status)
       VALUES (?,?,?,?,?,?,?,'admin','approved')`)
      .run('admin', bcrypt.hashSync(INITIAL_ADMIN_PWD, BCRYPT_ROUNDS), 'ผู้ดูแล', 'ระบบ', 'แอดมิน', 'เจ้าหน้าที่', '-');
    log('info', 'สร้างแอดมินเริ่มต้นสำเร็จ');
  }
}

/* ---------- 6) HEALTH (ก่อน rate-limit — uptime monitor ยิงถี่ได้) ---------- */
app.get('/api/health', (_, res) => {
  let dbOk = true;
  try { P('SELECT 1').get(); } catch { dbOk = false; }
  res.status(dbOk ? 200 : 503).json({ ok: dbOk, uptime: Math.floor(process.uptime()), ts: new Date().toISOString() });
});

/* ---------- 7) RATE LIMITER ---------- */
function rateLimit({ windowMs = 60e3, max = 60, keyFn = req => req.ip, message = 'คำขอมากเกินไป กรุณาลองใหม่ภายหลัง' } = {}) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, arr] of hits) {
      const kept = arr.filter(ts => now - ts < windowMs);
      kept.length ? hits.set(k, kept) : hits.delete(k);
    }
  }, windowMs).unref();
  return (req, res, next) => {
    const k = keyFn(req), now = Date.now();
    const arr = (hits.get(k) || []).filter(ts => now - ts < windowMs);
    if (arr.length >= max) {
      res.setHeader('Retry-After', Math.ceil(windowMs / 1e3));
      return res.status(429).json({ error: message });
    }
    arr.push(now); hits.set(k, arr); next();
  };
}
app.use(rateLimit({ windowMs: 60e3, max: Number(process.env.RATE_MAX) || 1500 }));
const loginLimiter    = rateLimit({ windowMs: 10 * 60e3, max: 30 });
const registerLimiter = rateLimit({ windowMs: 3600e3, max: 10 });
const writeLimiter    = rateLimit({ windowMs: 10 * 60e3, max: 60 });

/* ---------- 8) CSRF ORIGIN-GUARD ---------- */
app.use((req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const origin = req.get('origin') || req.get('referer') || '';
  if (!origin) return next();
  try {
    const host = new URL(origin).host;
    const allowed = new Set([req.get('host'), process.env.PUBLIC_HOST].filter(Boolean));
    if (!allowed.has(host)) return res.status(403).json({ error: 'Origin ไม่ได้รับอนุญาต' });
  } catch { return res.status(403).json({ error: 'Origin ไม่ได้รับอนุญาต' }); }
  next();
});

/* ---------- 9) REQUEST-ID / PARSERS / STATIC ---------- */
app.use((req, res, next) => {
  req.id = crypto.randomBytes(8).toString('hex');
  res.setHeader('X-Request-Id', req.id);
  next();
});
app.use(express.json({ limit: '200kb' }));
app.use(express.urlencoded({ extended: true, limit: '200kb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public'), { maxAge: PROD ? '1d' : 0 }));
// /uploads ไม่เปิด static — ต้องผ่าน /api/photos/:id และ /api/avatars/:uid เท่านั้น

/* ---------- 10) AUDIT / HELPERS ---------- */
function writeAudit(userId, action, resourceType, resourceId, req) {
  try {
    P(`INSERT INTO audit_logs (user_id, action, resource_type, resource_id, ip, user_agent, request_id)
       VALUES (?,?,?,?,?,?,?)`)
      .run(userId ?? null, action, resourceType ?? null,
           resourceId == null ? null : (Number(resourceId) || null),
           req.ip || '', (req.get('user-agent') || '').slice(0, 250), req.id || '');
  } catch (err) { log('error', 'audit fail', { err: err.message }); }
}

const clean = (v, max = 200) => typeof v === 'string'
  ? v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max) : '';
const likeQ = s => '%' + String(s).slice(0, 100).replace(/[\\%_]/g, m => '\\' + m) + '%';
const intId = v => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371, d = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * d / 2) ** 2 +
            Math.cos(lat1 * d) * Math.cos(lat2 * d) * Math.sin((lng2 - lng1) * d / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/* ---------- 11) UPLOAD + MAGIC-BYTE + EXT WHITELIST ---------- */
const EXT_OK = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOAD_DIR),
  filename: (_, file, cb) => {
    const e = path.extname(file.originalname || '').toLowerCase();
    cb(null, crypto.randomBytes(16).toString('hex') + (EXT_OK.has(e) ? e : '.jpg'));
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024, files: 6 },
  fileFilter: (_, file, cb) => cb(null, ALLOWED_MIME.has(file.mimetype))
});

function sniffImage(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const b = Buffer.alloc(12);
      fs.readSync(fd, b, 0, 12, 0);
      if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
      if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';
      if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
      return null;
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}
function purgeFiles(files) { (files || []).forEach(f => fs.unlink(f.path, () => {})); }

function safeUploadPath(rel) {
  if (!rel) return null;
  try {
    const f = path.resolve(__dirname, String(rel).replace(/^\//, ''));
    return f.startsWith(UPLOAD_DIR + path.sep) ? f : null;   // กัน path traversal
  } catch { return null; }
}
function removeFile(rel) {
  const f = safeUploadPath(rel);
  if (f) fs.unlink(f, () => {});
}
// ส่งไฟล์รูปโดยบังคับ Content-Type จาก magic bytes จริง — กัน stored XSS
function sendImage(res, filePath, maxAge) {
  const mime = sniffImage(filePath);
  if (!mime) return res.status(404).json({ error: 'ไม่พบไฟล์' });
  res.type(mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', 'inline');
  res.sendFile(filePath, {
    headers: { 'Cache-Control': `private, max-age=${maxAge}` },
    lastModified: true, etag: true, acceptRanges: true
  });
}

/* ---------- 12) AUTH ---------- */
function sign(u) {
  return jwt.sign({ id: u.id, role: u.role, tv: u.token_version || 0 }, SECRET, { expiresIn: JWT_TTL, issuer: ISSUER });
}
const COOKIE_OPTS = { httpOnly: true, sameSite: 'lax', secure: PROD, path: '/', maxAge: COOKIE_MAX_AGE };

function auth(req, res, next) {
  const t = req.cookies.token;
  if (!t) return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบ' });
  try {
    const p = jwt.verify(t, SECRET, { issuer: ISSUER });
    const u = P('SELECT * FROM users WHERE id=?').get(p.id);
    if (!u || (u.token_version || 0) !== (p.tv || 0))
      return res.status(401).json({ error: 'เซสชันไม่ถูกต้อง กรุณาเข้าสู่ระบบใหม่' });
    req.user = u; next();
  } catch { res.status(401).json({ error: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่' }); }
}
const approved  = (req, res, next) => req.user.status === 'approved' ? next() : res.status(403).json({ error: 'บัญชียังไม่ได้รับการอนุมัติ' });
const adminOnly = (req, res, next) => req.user.role === 'admin' ? next() : res.status(403).json({ error: 'เฉพาะผู้ดูแลระบบ' });

const kickSockets = uid => { try { io.in('user:' + uid).disconnectSockets(true); } catch {} };

const avatarUrl = u => (u && u.avatar ? `/api/avatars/${u.id}` : null);

const safeUser = u => ({
  id: u.id, username: u.username, firstName: u.first_name, lastName: u.last_name,
  nickname: u.nickname, affiliation: u.affiliation, affiliationOther: u.affiliation_other,
  phone: u.phone, avatar: avatarUrl(u), facebook: u.facebook, tiktok: u.tiktok,
  lineId: u.line_id, website: u.website, role: u.role, status: u.status,
  createdAt: u.created_at, lastLoginAt: u.last_login_at
});

/* ---------- 13) POINTS SHAPE (แก้ N+1) ---------- */
const pointRow = `SELECT p.*, u.first_name, u.last_name, u.nickname, u.affiliation,
  u.affiliation_other, u.phone AS reporter_phone, u.avatar FROM points p JOIN users u ON u.id=p.user_id`;

function shape(r, withPhotos = true) {
  if (!r) return null;
  return {
    id: r.id,
    reporterId: r.user_id,
    lat: r.lat, lng: r.lng, caseName: r.case_name,
    caseType: r.case_type, caseTypeOther: r.case_type_other,
    caretakerName: r.caretaker_name, caretakerPhone: r.caretaker_phone,
    address: r.address, note: r.note, status: r.status, rejectReason: r.reject_reason,
    amphoe: r.amphoe, tambon: r.tambon, moo: r.moo,
    accuracy: r.accuracy, areaSource: r.area_source,
    createdAt: r.created_at, updatedAt: r.updated_at,
    reporter: {
      name: `${r.first_name} ${r.last_name}` + (r.nickname ? ` (${r.nickname})` : ''),
      affiliation: ['other', 'อื่นๆ'].includes(r.affiliation) ? r.affiliation_other : r.affiliation,
      phone: r.reporter_phone,
      avatar: r.avatar ? `/api/avatars/${r.user_id}` : null
    },
    photos: withPhotos
      ? P('SELECT id FROM point_photos WHERE point_id=?').all(r.id).map(x => `/api/photos/${x.id}`)
      : []
  };
}

// ดึงรูปทีเดียวทั้งชุด แทนที่จะยิงทีละแถว
function shapeMany(rows) {
  if (!rows || !rows.length) return [];
  const ids = rows.map(r => r.id);
  const byPoint = new Map();
  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    const ph = db.prepare(
      `SELECT id, point_id FROM point_photos WHERE point_id IN (${part.map(() => '?').join(',')}) ORDER BY id`
    ).all(...part);
    for (const p of ph) {
      if (!byPoint.has(p.point_id)) byPoint.set(p.point_id, []);
      byPoint.get(p.point_id).push(`/api/photos/${p.id}`);
    }
  }
  return rows.map(r => {
    const o = shape(r, false);
    o.photos = byPoint.get(r.id) || [];
    return o;
  });
}

geo.mount({
  app, db, io, auth, approved, adminOnly,
  shape, shapeMany, pointRow, writeAudit, rateLimit
});
require('./export')({ app, db, auth, adminOnly, pointRow, writeAudit });

/* ---------- 14) AUTH ROUTES ---------- */

const PDPA_NOTICE_VERSION = '1.0';
const PDPA_NOTICE_DATE = '2026-10-04';

app.post('/api/register', registerLimiter, upload.single('avatar'), (req, res) => {

  const b = req.body || {};

  const username = clean(b.username, 32);
  const password = typeof b.password === 'string' ? b.password : '';

  const first_name = clean(b.first_name, 100);
  const last_name = clean(b.last_name, 100);
  const phone = clean(b.phone, 20);
  const affiliation = clean(b.affiliation, 100);
  const affiliation_other = clean(b.affiliation_other, 100);

  /*
   * ตรวจสอบการรับทราบประกาศคุ้มครองข้อมูลส่วนบุคคล
   * ต้องตรวจสอบที่ Server เสมอ ไม่ควรพึ่ง required ของ HTML เพียงอย่างเดียว
   */
  const pdpaAcknowledged =
    b.pdpa_acknowledge === '1' ||
    b.pdpa_acknowledge === 'true' ||
    b.pdpa_acknowledge === 'on';

  const fail = (code, msg) => {
    purgeFiles(req.file ? [req.file] : []);
    return res.status(code).json({ error: msg });
  };

  /* ตรวจสอบข้อมูลจำเป็น */
  if (
    !username ||
    !password ||
    !first_name ||
    !last_name ||
    !phone ||
    !affiliation
  ) {
    return fail(400, 'กรุณากรอกข้อมูลที่จำเป็นให้ครบถ้วน');
  }

  /* ตรวจสอบการรับทราบ PDPA */
  if (!pdpaAcknowledged) {
    return fail(
      400,
      'กรุณาอ่านและรับทราบประกาศเกี่ยวกับการคุ้มครองข้อมูลส่วนบุคคลก่อนสมัครสมาชิก'
    );
  }

  if (affiliation === 'other' && !affiliation_other)
    return fail(400, 'กรุณาระบุตำแหน่ง/สังกัด');

  /* ตรวจสอบ username */
  if (!/^[a-zA-Z0-9_.]{3,32}$/.test(username)) {
    return fail(
      400,
      'ชื่อผู้ใช้ต้องประกอบด้วย a-z, A-Z, 0-9, _ หรือ . และมีความยาว 3–32 ตัวอักษร'
    );
  }

  /* ตรวจสอบ password */
  if (
    password.length < 8 ||
    !/[A-Za-z]/.test(password) ||
    !/\d/.test(password)
  ) {
    return fail(
      400,
      'รหัสผ่านต้องมีความยาวอย่างน้อย 8 ตัวอักษร และประกอบด้วยตัวอักษรและตัวเลข'
    );
  }

  /* ตรวจสอบเบอร์โทรศัพท์ */
  if (!/^[0-9+\-\s()]{6,20}$/.test(phone)) {
    return fail(400, 'หมายเลขโทรศัพท์ไม่ถูกต้อง');
  }

  /* ตรวจสอบ username ซ้ำ */
  if (P('SELECT 1 FROM users WHERE username=?').get(username)) {
    return fail(409, 'ชื่อผู้ใช้นี้ถูกใช้แล้ว');
  }

  /* จัดการรูปโปรไฟล์ */
  let avatar = null;

  if (req.file) {
    if (sniffImage(req.file.path)) {
      avatar = '/uploads/' + req.file.filename;
    } else {
      fs.unlink(req.file.path, () => {});
    }
  }

  /*
   * บันทึกข้อมูลการรับทราบประกาศ PDPA
   */
  const pdpaAcknowledgedAt = new Date().toISOString();

  /*
   * IP Address
   */
  const pdpaAcknowledgedIp = req.ip || null;

  /*
   * User-Agent
   */
  const pdpaAcknowledgedUserAgent =
    clean(req.get('user-agent'), 500);

  try {

    P(`
      INSERT INTO users (
        username,
        password,
        first_name,
        last_name,
        nickname,
        affiliation,
        affiliation_other,
        phone,
        avatar,
        facebook,
        tiktok,
        line_id,
        website,

        pdpa_acknowledged,
        pdpa_acknowledged_at,
        pdpa_notice_version,
        pdpa_acknowledged_ip,
        pdpa_acknowledged_user_agent

      )
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(

      username,
      bcrypt.hashSync(password, BCRYPT_ROUNDS),

      first_name,
      last_name,
      clean(b.nickname, 100),

      affiliation,
      affiliation_other,
      phone,
      avatar,

      clean(b.facebook, 200),
      clean(b.tiktok, 200),
      clean(b.line_id, 100),
      clean(b.website, 200),

      1,
      pdpaAcknowledgedAt,
      PDPA_NOTICE_VERSION,
      pdpaAcknowledgedIp,
      pdpaAcknowledgedUserAgent
    );

    /*
     * Audit Log
     */
    writeAudit(
      null,
      'REGISTER',
      'USER',
      null,
      req
    );

    /*
     * บันทึก Audit เพิ่มว่าได้รับทราบประกาศ PDPA
     */
    writeAudit(
      null,
      'PDPA_ACKNOWLEDGE',
      'USER',
      null,
      req
    );

    io.to('admins').emit('user:pending');

    return res.json({
      ok: true,
      message: 'สมัครสมาชิกสำเร็จ กรุณารอผู้ดูแลระบบตรวจสอบและอนุมัติบัญชีก่อนเข้าใช้งาน',
      pdpa: {
        acknowledged: true,
        notice_version: PDPA_NOTICE_VERSION,
        acknowledged_at: pdpaAcknowledgedAt
      }
    });

  } catch (err) {

    /*
     * หากบันทึกฐานข้อมูลไม่สำเร็จ
     * ให้ลบไฟล์รูปที่เพิ่งอัปโหลด เพื่อไม่ให้เกิดไฟล์ค้าง
     */
    if (req.file) {
      purgeFiles([req.file]);
    }

    console.error('REGISTER ERROR:', err);

    return res.status(500).json({
      error: 'ไม่สามารถดำเนินการสมัครสมาชิกได้ กรุณาลองใหม่อีกครั้ง'
    });
  }
});

app.post('/api/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  const uname = clean(username, 32);
  const key = req.ip + '|' + uname;
  const t = loginTries.get(key) || { n: 0, at: 0 };
  if (t.n >= 8 && Date.now() - t.at < 10 * 60000)
    return res.status(429).json({ error: 'พยายามเข้าสู่ระบบบ่อยเกินไป กรุณาลองใหม่ใน 10 นาที' });

  const u = P('SELECT * FROM users WHERE username=?').get(uname || '');
  let ok = false;
  if (u) ok = bcrypt.compareSync(password || '', u.password);
  else bcrypt.compareSync(password || '', DUMMY_HASH);

  if (!u || !ok) {
    loginTries.set(key, { n: t.n + 1, at: Date.now() });
    writeAudit(u?.id ?? null, 'LOGIN_FAILED', 'USER', u?.id ?? null, req);
    return res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
  }
  if (u.status === 'pending') return res.status(403).json({ error: 'บัญชีรออนุมัติจากผู้ดูแลระบบ' });
  if (u.status === 'rejected') return res.status(403).json({ error: 'บัญชีถูกปฏิเสธ กรุณาติดต่อผู้ดูแล' });

  loginTries.delete(key);
  P(`UPDATE users SET last_login_at=datetime('now','localtime') WHERE id=?`).run(u.id);
  writeAudit(u.id, 'LOGIN_SUCCESS', 'USER', u.id, req);
  res.cookie('token', sign(u), COOKIE_OPTS);
  res.json({ ok: true, user: safeUser(u) });
});

app.post('/api/logout', auth, (req, res) => {
  writeAudit(req.user.id, 'LOGOUT', 'USER', req.user.id, req);
  res.clearCookie('token', { path: '/' });
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => res.json(safeUser(req.user)));

app.post('/api/me/password', auth, rateLimit({ windowMs: 60e3, max: 5 }), (req, res) => {
  const { current, next: np } = req.body || {};
  if (typeof current !== 'string' || typeof np !== 'string')
    return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });
  if (!bcrypt.compareSync(current, req.user.password))
    return res.status(401).json({ error: 'รหัสผ่านปัจจุบันไม่ถูกต้อง' });
  if (np.length < 8 || !/[A-Za-z]/.test(np) || !/\d/.test(np))
    return res.status(400).json({ error: 'รหัสผ่านใหม่ต้องยาวอย่างน้อย 8 ตัวอักษร และมีทั้งตัวอักษรและตัวเลข' });

  const tv = (req.user.token_version || 0) + 1;
  P(`UPDATE users SET password=?, token_version=?, updated_at=datetime('now','localtime') WHERE id=?`)
    .run(bcrypt.hashSync(np, BCRYPT_ROUNDS), tv, req.user.id);
  writeAudit(req.user.id, 'CHANGE_PASSWORD', 'USER', req.user.id, req);
  kickSockets(req.user.id);                                   // เตะ socket อุปกรณ์อื่นด้วย
  res.cookie('token', sign({ ...req.user, token_version: tv }), COOKIE_OPTS);
  res.json({ ok: true, message: 'เปลี่ยนรหัสผ่านสำเร็จ (อุปกรณ์อื่นถูกออกจากระบบแล้ว)' });
});

const PROFILE_FIELDS = ['first_name', 'last_name', 'nickname', 'phone', 'facebook', 'tiktok', 'line_id', 'website'];
app.patch('/api/me', auth, (req, res) => {
  const b = req.body || {};
  const sets = [], vals = [];
  for (const f of PROFILE_FIELDS)
    if (typeof b[f] === 'string') { sets.push(`${f}=?`); vals.push(clean(b[f], 200)); }
  if (typeof b.affiliation_other === 'string') { sets.push('affiliation_other=?'); vals.push(clean(b.affiliation_other, 100)); }
  if (!sets.length) return res.status(400).json({ error: 'ไม่มีข้อมูลที่ต้องการแก้ไข' });
  if (typeof b.phone === 'string' && b.phone && !/^[0-9+\-\s()]{6,20}$/.test(clean(b.phone, 20)))
    return res.status(400).json({ error: 'เบอร์โทรศัพท์ไม่ถูกต้อง' });
  vals.push(req.user.id);
  P(`UPDATE users SET ${sets.join(',')}, updated_at=datetime('now','localtime') WHERE id=?`).run(...vals);
  const u = P('SELECT * FROM users WHERE id=?').get(req.user.id);
  writeAudit(req.user.id, 'UPDATE_PROFILE', 'USER', req.user.id, req);
  io.to('user:' + req.user.id).emit('me:updated', safeUser(u));
  res.json({ ok: true, user: safeUser(u) });
});

app.post('/api/me/avatar', auth, upload.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'กรุณาแนบไฟล์รูป avatar' });
  if (!sniffImage(req.file.path)) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'ไฟล์รูปไม่ถูกต้อง' });
  }
  const old = req.user.avatar;
  P(`UPDATE users SET avatar=?, updated_at=datetime('now','localtime') WHERE id=?`)
    .run('/uploads/' + req.file.filename, req.user.id);
  if (old) removeFile(old);
  writeAudit(req.user.id, 'UPDATE_AVATAR', 'USER', req.user.id, req);
  res.json({ ok: true, avatar: `/api/avatars/${req.user.id}?v=${Date.now()}` });
});

/* ---------- 15) PROTECTED FILES ---------- */
app.get('/api/avatars/:uid', auth, (req, res) => {
  const uid = intId(req.params.uid);
  if (!uid) return res.status(400).json({ error: 'id ไม่ถูกต้อง' });
  const row = P('SELECT avatar FROM users WHERE id=?').get(uid);
  const f = safeUploadPath(row?.avatar);
  if (!f || !fs.existsSync(f)) return res.status(404).json({ error: 'ไม่พบรูปโปรไฟล์' });
  sendImage(res, f, 600);
});

app.get('/api/photos/:id', auth, approved, (req, res) => {
  const id = intId(req.params.id);
  if (!id) return res.status(400).json({ error: 'id ไม่ถูกต้อง' });
  const photo = P(`SELECT ph.file, p.user_id, p.status, p.deleted_at
                   FROM point_photos ph JOIN points p ON p.id = ph.point_id
                   WHERE ph.id = ?`).get(id);
  if (!photo || (photo.deleted_at && req.user.role !== 'admin'))
    return res.status(404).json({ error: 'ไม่พบไฟล์รูปภาพ' });
  if (photo.status !== 'approved' && photo.user_id !== req.user.id && req.user.role !== 'admin')
    return res.status(403).json({ error: 'ไม่มีสิทธิ์เข้าถึงรูปภาพนี้' });

  const filePath = safeUploadPath(photo.file);
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: 'ไม่พบไฟล์' });
  sendImage(res, filePath, 300);     // ไม่เขียน audit — เปลืองเกินจำเป็น
});

/* ---------- 16) POINTS ---------- */
app.get('/api/points', auth, approved, (req, res) => {
  const q = req.query;
  const w = ['p.deleted_at IS NULL'], a = [];

  if (req.user.role === 'admin' && ['pending', 'approved', 'rejected'].includes(q.status)) {
    w.push('p.status=?'); a.push(q.status);
  } else {
    w.push("(p.status='approved' OR p.user_id=?)"); a.push(req.user.id);
  }
  if (q.amphoe) { w.push('p.amphoe=?'); a.push(String(q.amphoe).slice(0, 100)); }
  if (q.tambon) { w.push('p.tambon=?'); a.push(String(q.tambon).slice(0, 100)); }
  if (q.type)   { w.push('p.case_type=?'); a.push(String(q.type).slice(0, 100)); }
  if (q.mine === '1') { w.push('p.user_id=?'); a.push(req.user.id); }
  const bb = String(q.bbox || '').split(',').map(Number);   // minLng,minLat,maxLng,maxLat
  if (bb.length === 4 && bb.every(Number.isFinite)) {
    w.push('p.lng BETWEEN ? AND ? AND p.lat BETWEEN ? AND ?'); a.push(bb[0], bb[2], bb[1], bb[3]);
  }
  if (q.q) {
    const lk = likeQ(q.q);
    w.push(`(p.case_name LIKE ? ESCAPE '\\' OR p.note LIKE ? ESCAPE '\\' OR p.address LIKE ? ESCAPE '\\')`);
    a.push(lk, lk, lk);
  }

  const page  = Math.max(1, parseInt(q.page, 10) || 1);
  const limit = Math.min(500, Math.max(1, parseInt(q.limit, 10) || 500));

  // ---- near-me : bbox ใน SQL → Haversine ใน JS → ค่อยแบ่งหน้า ----
  let near = null;
  if (q.lat != null && q.lng != null) {
    const lat = parseFloat(q.lat), lng = parseFloat(q.lng);
    const radius = Math.min(Math.max(parseFloat(q.radius) || 5, 0.1), 100);
    if (!Number.isNaN(lat) && !Number.isNaN(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      near = { lat, lng, radius };
      const dLat = radius / 111.32;
      const dLng = radius / (Math.abs(Math.cos(lat * Math.PI / 180)) * 111.32 || 1);
      w.push('p.lat BETWEEN ? AND ?', 'p.lng BETWEEN ? AND ?');
      a.push(lat - dLat, lat + dLat, lng - dLng, lng + dLng);
    }
  }
  const where = w.join(' AND ');

  if (near) {
    const rows = P(`${pointRow} WHERE ${where} ORDER BY p.id DESC LIMIT 5000`).all(...a);
    let items = shapeMany(rows)
      .map(it => ({ ...it, distanceKm: +haversineKm(near.lat, near.lng, it.lat, it.lng).toFixed(3) }))
      .filter(it => it.distanceKm <= near.radius)
      .sort((x, y) => x.distanceKm - y.distanceKm);
    const total = items.length;
    items = items.slice((page - 1) * limit, page * limit);
    res.setHeader('X-Total-Count', total);
    res.setHeader('X-Page', page);
    res.setHeader('X-Per-Page', limit);
    res.setHeader('X-Total-Pages', Math.max(1, Math.ceil(total / limit)));
    return res.json(items);
  }

  const total = P(`SELECT COUNT(*) c FROM points p WHERE ${where}`).get(...a).c;
  const rows = P(`${pointRow} WHERE ${where} ORDER BY p.id DESC LIMIT ? OFFSET ?`)
    .all(...a, limit, (page - 1) * limit);

  res.setHeader('X-Total-Count', total);
  res.setHeader('X-Page', page);
  res.setHeader('X-Per-Page', limit);
  res.setHeader('X-Total-Pages', Math.max(1, Math.ceil(total / limit)));
  res.json(shapeMany(rows));
});

app.get('/api/points/:id', auth, approved, (req, res) => {
  const id = intId(req.params.id);
  if (!id) return res.status(400).json({ error: 'id ไม่ถูกต้อง' });
  const r = P(`${pointRow} WHERE p.id=? AND p.deleted_at IS NULL`).get(id);
  if (!r) return res.status(404).json({ error: 'ไม่พบข้อมูล' });
  if (r.status !== 'approved' && r.user_id !== req.user.id && req.user.role !== 'admin')
    return res.status(403).json({ error: 'ไม่มีสิทธิ์เข้าถึงเคสนี้' });
  res.json(shape(r));
});

app.post('/api/points', auth, approved, writeLimiter, upload.array('photos', 6), (req, res) => {
  const b = req.body || {};
  const lat = parseFloat(b.lat), lng = parseFloat(b.lng);
  if (Number.isNaN(lat) || Number.isNaN(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    purgeFiles(req.files); return res.status(400).json({ error: 'พิกัดไม่ถูกต้อง' });
  }
  const case_name = clean(b.case_name, 200), case_type = clean(b.case_type, 100);
  if (!case_name || !case_type) {
    purgeFiles(req.files); return res.status(400).json({ error: 'กรอกชื่อเคสและลักษณะเคส' });
  }
  const phone = clean(b.caretaker_phone, 20);
  if (phone && !/^[0-9+\-\s()]{6,20}$/.test(phone)) {
    purgeFiles(req.files); return res.status(400).json({ error: 'เบอร์ผู้ดูแลไม่ถูกต้อง' });
  }

  const files = req.files || [];
  if (files.some(f => !sniffImage(f.path))) {
    purgeFiles(files);
    return res.status(400).json({ error: 'พบไฟล์ที่ไม่ใช่รูปภาพจริง' });
  }

  const area = geo.resolveArea(b, lat, lng);
  if (area.error) { purgeFiles(files); return res.status(400).json({ error: area.error }); }

  const accuracy = parseFloat(b.accuracy);
  const info = P(`INSERT INTO points (user_id,lat,lng,case_name,case_type,case_type_other,
      caretaker_name,caretaker_phone,address,note,amphoe,tambon,moo,accuracy,area_source)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    req.user.id, lat, lng, case_name, case_type, clean(b.case_type_other, 100),
    clean(b.caretaker_name, 150), phone, clean(b.address, 300), clean(b.note, 2000),
    area.amphoe, area.tambon, area.moo,
    Number.isFinite(accuracy) && accuracy >= 0 && accuracy <= 100000 ? accuracy : null,
    area.source);

  const ins = P('INSERT INTO point_photos (point_id,file) VALUES (?,?)');
  files.forEach(f => ins.run(info.lastInsertRowid, '/uploads/' + f.filename));

  const point = shape(P(`${pointRow} WHERE p.id=?`).get(info.lastInsertRowid));
  writeAudit(req.user.id, 'CREATE', 'POINT', info.lastInsertRowid, req);

  io.to('admins').emit('point:pending', { id: point.id, status: point.status });
  io.to('user:' + req.user.id).emit('point:mine', point);
  res.json({ ok: true, message: 'บันทึกพิกัดสำเร็จ รอผู้ดูแลระบบอนุมัติ', point, warning: area.warning });
});

/* ✅ ใหม่: แก้ไขเคส — เจ้าของแก้ได้เฉพาะตอน pending, admin แก้ได้ทุกสถานะ */
const POINT_TEXT_FIELDS = {
  case_name: 200, case_type: 100, case_type_other: 100,
  caretaker_name: 150, address: 300, note: 2000
};
app.patch('/api/points/:id', auth, approved, writeLimiter, (req, res) => {
  const id = intId(req.params.id);
  if (!id) return res.status(400).json({ error: 'id ไม่ถูกต้อง' });
  const p = P('SELECT * FROM points WHERE id=? AND deleted_at IS NULL').get(id);
  if (!p) return res.status(404).json({ error: 'ไม่พบข้อมูล' });

  const isAdmin = req.user.role === 'admin';
  if (p.user_id !== req.user.id && !isAdmin) return res.status(403).json({ error: 'ไม่มีสิทธิ์' });
  if (!isAdmin && p.status !== 'pending')
    return res.status(400).json({ error: 'แก้ไขได้เฉพาะเคสที่ยังรออนุมัติ' });

  const b = req.body || {};
  const sets = [], vals = [];
  for (const [f, max] of Object.entries(POINT_TEXT_FIELDS))
    if (typeof b[f] === 'string') { sets.push(`${f}=?`); vals.push(clean(b[f], max)); }

  if (typeof b.caretaker_phone === 'string') {
    const ph = clean(b.caretaker_phone, 20);
    if (ph && !/^[0-9+\-\s()]{6,20}$/.test(ph)) return res.status(400).json({ error: 'เบอร์ผู้ดูแลไม่ถูกต้อง' });
    sets.push('caretaker_phone=?'); vals.push(ph);
  }

  if (b.lat != null && b.lng != null) {
    const lat = parseFloat(b.lat), lng = parseFloat(b.lng);
    if (Number.isNaN(lat) || Number.isNaN(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180)
      return res.status(400).json({ error: 'พิกัดไม่ถูกต้อง' });
    const area = geo.resolveArea(b, lat, lng);
    if (area.error) return res.status(400).json({ error: area.error });
    sets.push('lat=?', 'lng=?', 'amphoe=?', 'tambon=?', 'moo=?', 'area_source=?');
    vals.push(lat, lng, area.amphoe, area.tambon, area.moo, area.source);
  }

  if (!sets.length) return res.status(400).json({ error: 'ไม่มีข้อมูลที่ต้องการแก้ไข' });

  // ผู้ใช้แก้เคสที่เคยถูกปฏิเสธ → กลับไปรออนุมัติใหม่
  if (!isAdmin && p.status === 'rejected') { sets.push('status=?', 'reject_reason=?'); vals.push('pending', null); }

  vals.push(id);
  P(`UPDATE points SET ${sets.join(',')}, updated_at=datetime('now','localtime') WHERE id=?`).run(...vals);
  writeAudit(req.user.id, isAdmin ? 'ADMIN_UPDATE_POINT' : 'UPDATE_POINT', 'POINT', id, req);

  const point = shape(P(`${pointRow} WHERE p.id=?`).get(id));
  io.to('user:' + p.user_id).emit('point:mine', point);
  if (point.status === 'approved') io.emit('point:update-hint', { id });
  res.json({ ok: true, point });
});

app.delete('/api/points/:id', auth, (req, res) => {
  const id = intId(req.params.id);
  if (!id) return res.status(400).json({ error: 'id ไม่ถูกต้อง' });
  const p = P('SELECT id, user_id, status FROM points WHERE id=? AND deleted_at IS NULL').get(id);
  if (!p) return res.status(404).json({ error: 'ไม่พบข้อมูล' });
  const isAdmin = req.user.role === 'admin';
  if (p.user_id !== req.user.id && !isAdmin) return res.status(403).json({ error: 'ไม่มีสิทธิ์' });
  if (!isAdmin && p.status !== 'pending') return res.status(400).json({ error: 'ลบได้เฉพาะเคสที่ยังรออนุมัติ' });

  P(`UPDATE points SET deleted_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=?`).run(id);
  writeAudit(req.user.id, 'DELETE_POINT', 'POINT', id, req);
  io.emit('point:removed', { id });
  res.json({ ok: true });
});

require('./routes-extra')({ app, db, io, auth, approved, upload, writeLimiter, rateLimit, P, clean, intId, sniffImage, purgeFiles, removeFile, shape, pointRow, writeAudit, geo, bcrypt, sign, COOKIE_OPTS, kickSockets, safeUser, PROFILE_FIELDS, BCRYPT_ROUNDS });
/* ---------- 17) ADMIN ---------- */
app.get('/api/admin/stats', auth, adminOnly, (req, res) => {
  const g = q => P(q).get().c;
  res.json({
    pendingUsers:   g("SELECT COUNT(*) c FROM users WHERE status='pending'"),
    approvedUsers:  g("SELECT COUNT(*) c FROM users WHERE status='approved'"),
    pendingPoints:  g("SELECT COUNT(*) c FROM points WHERE status='pending' AND deleted_at IS NULL"),
    approvedPoints: g("SELECT COUNT(*) c FROM points WHERE status='approved' AND deleted_at IS NULL"),
    rejectedPoints: g("SELECT COUNT(*) c FROM points WHERE status='rejected' AND deleted_at IS NULL"),
    deletedPoints:  g('SELECT COUNT(*) c FROM points WHERE deleted_at IS NOT NULL'),
    photosTotal:    g('SELECT COUNT(*) c FROM point_photos'),
    auditTotal:     g('SELECT COUNT(*) c FROM audit_logs')
  });
});

app.get('/api/admin/users', auth, adminOnly, (req, res) => {
  const q = req.query, w = [], a = [];
  if (q.status && ['pending', 'approved', 'rejected'].includes(q.status)) { w.push('status=?'); a.push(q.status); }
  if (q.q) {
    const lk = likeQ(q.q);
    w.push(`(username LIKE ? ESCAPE '\\' OR first_name LIKE ? ESCAPE '\\' OR last_name LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\')`);
    a.push(lk, lk, lk, lk);
  }
  const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(q.limit, 10) || 100));
  const total = P(`SELECT COUNT(*) c FROM users ${where}`).get(...a).c;
  const rows = P(`SELECT * FROM users ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...a, limit, (page - 1) * limit);
  res.setHeader('X-Total-Count', total);
  res.setHeader('X-Total-Pages', Math.max(1, Math.ceil(total / limit)));
  res.json(rows.map(safeUser));
});

app.post('/api/admin/users/:id/status', auth, adminOnly, (req, res) => {
  const id = intId(req.params.id);
  const { status } = req.body || {};
  if (!id || !['approved', 'rejected', 'pending'].includes(status))
    return res.status(400).json({ error: 'ข้อมูลไม่ถูกต้อง' });
  const u = P('SELECT id, role FROM users WHERE id=?').get(id);
  if (!u) return res.status(404).json({ error: 'ไม่พบสมาชิกนี้' });
  if (u.role === 'admin' && status !== 'approved')
    return res.status(400).json({ error: 'ไม่สามารถระงับบัญชีผู้ดูแลระบบได้' });
  if (u.id === req.user.id && status !== 'approved')
    return res.status(400).json({ error: 'ไม่สามารถเปลี่ยนสถานะบัญชีของตัวเองได้' });

  if (status !== 'approved') {
    P('UPDATE users SET status=?, token_version=token_version+1 WHERE id=?').run(status, id);
    io.to('user:' + id).emit('user:status', { status });
    kickSockets(id);                                  // ✅ เตะ socket ที่ต่ออยู่ทันที
  } else {
    P('UPDATE users SET status=? WHERE id=?').run(status, id);
    io.to('user:' + id).emit('user:status', { status });
  }

  writeAudit(req.user.id, 'ADMIN_UPDATE_USER_STATUS', 'USER', id, req);
  res.json({ ok: true });
});

app.get('/api/admin/points', auth, adminOnly, (req, res) => {
  const q = req.query, w = [], a = [];
  w.push(q.deleted === '1' ? 'p.deleted_at IS NOT NULL' : 'p.deleted_at IS NULL');
  if (q.status && ['pending', 'approved', 'rejected'].includes(q.status)) { w.push('p.status=?'); a.push(q.status); }
  if (q.q) {
    const lk = likeQ(q.q);
    w.push(`(p.case_name LIKE ? ESCAPE '\\' OR p.note LIKE ? ESCAPE '\\')`);
    a.push(lk, lk);
  }
  const where = 'WHERE ' + w.join(' AND ');
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(q.limit, 10) || 100));
  const total = P(`SELECT COUNT(*) c FROM points p ${where}`).get(...a).c;
  const rows = P(`${pointRow} ${where} ORDER BY p.id DESC LIMIT ? OFFSET ?`).all(...a, limit, (page - 1) * limit);
  res.setHeader('X-Total-Count', total);
  res.setHeader('X-Total-Pages', Math.max(1, Math.ceil(total / limit)));
  res.json(shapeMany(rows));
});

app.post('/api/admin/points/:id/status', auth, adminOnly, (req, res) => {
  const id = intId(req.params.id);
  const { status, reason } = req.body || {};
  if (!id || !['approved', 'rejected', 'pending'].includes(status))
    return res.status(400).json({ error: 'สถานะไม่ถูกต้อง' });
  const rec = P('SELECT id, user_id FROM points WHERE id=? AND deleted_at IS NULL').get(id);
  if (!rec) return res.status(404).json({ error: 'ไม่พบพิกัดนี้' });

  P(`UPDATE points SET status=?, reject_reason=?, updated_at=datetime('now','localtime') WHERE id=?`)
    .run(status, status === 'rejected' ? clean(reason, 300) : null, id);
  writeAudit(req.user.id, 'ADMIN_UPDATE_POINT_STATUS', 'POINT', id, req);

  const point = shape(P(`${pointRow} WHERE p.id=?`).get(id));
  if (status === 'approved') {
    io.to('admins').emit('point:approved', { id: point.id });
    io.emit('point:update-hint', { id: point.id });
  } else {
    io.emit('point:removed', { id: point.id });
  }
  io.to('user:' + rec.user_id).emit('point:mine', point);
  res.json({ ok: true, point });
});

// กู้คืนเคสที่ถูก soft delete
app.post('/api/admin/points/:id/restore', auth, adminOnly, (req, res) => {
  const id = intId(req.params.id);
  if (!id) return res.status(400).json({ error: 'id ไม่ถูกต้อง' });
  const rec = P('SELECT id FROM points WHERE id=? AND deleted_at IS NOT NULL').get(id);
  if (!rec) return res.status(404).json({ error: 'ไม่พบเคสที่ถูกลบ' });
  P(`UPDATE points SET deleted_at=NULL, updated_at=datetime('now','localtime') WHERE id=?`).run(id);
  writeAudit(req.user.id, 'ADMIN_RESTORE_POINT', 'POINT', id, req);
  res.json({ ok: true, point: shape(P(`${pointRow} WHERE p.id=?`).get(id)) });
});

// ลบถาวร (พร้อมไฟล์บนดิสก์)
app.delete('/api/admin/points/:id', auth, adminOnly, (req, res) => {
  const id = intId(req.params.id);
  if (!id) return res.status(400).json({ error: 'id ไม่ถูกต้อง' });
  const rec = P('SELECT id FROM points WHERE id=?').get(id);
  if (!rec) return res.status(404).json({ error: 'ไม่พบพิกัดนี้' });

  const files = P('SELECT file FROM point_photos WHERE point_id=?').all(id);
  db.transaction(() => {
    P('DELETE FROM point_photos WHERE point_id=?').run(id);
    P('DELETE FROM points WHERE id=?').run(id);
  })();
  files.forEach(f => removeFile(f.file));
  writeAudit(req.user.id, 'ADMIN_DELETE_POINT', 'POINT', id, req);
  io.emit('point:removed', { id });
  res.json({ ok: true });
});

app.get('/api/admin/audit', auth, adminOnly, (req, res) => {
  const q = req.query, w = [], a = [];
  if (q.action) { w.push('a.action LIKE ?'); a.push(String(q.action).slice(0, 50) + '%'); }
  if (intId(q.userId)) { w.push('a.user_id=?'); a.push(intId(q.userId)); }
  const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(q.limit, 10) || 50));
  const total = P(`SELECT COUNT(*) c FROM audit_logs a ${where}`).get(...a).c;
  const rows = P(`SELECT a.*, u.username FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id
                  ${where} ORDER BY a.id DESC LIMIT ? OFFSET ?`).all(...a, limit, (page - 1) * limit);
  res.setHeader('X-Total-Count', total);
  res.setHeader('X-Total-Pages', Math.max(1, Math.ceil(total / limit)));
  res.json(rows);
});

/* ---------- 18) SOCKET.IO AUTH ---------- */
function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > -1) { try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch {} }
  });
  return out;
}

io.use((socket, next) => {
  try {
    const token = parseCookies(socket.handshake.headers.cookie).token || socket.handshake.auth?.token;
    if (!token) return next(new Error('unauthorized'));
    const p = jwt.verify(token, SECRET, { issuer: ISSUER });
    const u = P('SELECT id, role, status, token_version FROM users WHERE id=?').get(p.id);
    if (!u || u.status !== 'approved' || (u.token_version || 0) !== (p.tv || 0))
      return next(new Error('unauthorized'));
    socket.data.user = { id: u.id, role: u.role };
    next();
  } catch { next(new Error('unauthorized')); }
});

io.on('connection', socket => {
  const { id, role } = socket.data.user;
  socket.join('user:' + id);
  if (role === 'admin') socket.join('admins');
});

/* ---------- 19) 404 / SPA FALLBACK / ERROR ---------- */
app.use('/api', (_, res) => res.status(404).json({ error: 'ไม่พบ endpoint นี้' }));

// SPA fallback — refresh ที่ /admin ฯลฯ ไม่ 404 (ใช้ได้ทั้ง Express 4 และ 5)
const INDEX_HTML = path.join(__dirname, 'public', 'index.html');
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) return next();
  if (path.extname(req.path)) return next();        // ไฟล์ static ที่ไม่มีจริง → 404 ปกติ
  res.sendFile(INDEX_HTML);
});

app.use((err, req, res, _next) => {
  if (err instanceof multer.MulterError)
    return res.status(413).json({ error: 'ไฟล์ใหญ่เกิน 10 MB หรือจำนวนรูปเกินที่กำหนด' });
  if (err?.type === 'entity.too.large' || (err instanceof SyntaxError && err.status === 400))
    return res.status(400).json({ error: 'รูปแบบข้อมูลไม่ถูกต้อง' });
  log('error', 'unhandled', { id: req.id, msg: err?.message, stack: err?.stack });
  res.status(500).json({ error: 'เกิดข้อผิดพลาดในระบบ', requestId: req.id });
});

/* ---------- 20) AUTO BACKUP + ROTATION ---------- */
const BACKUP_DIR = path.join(__dirname, 'backups');
function rotateBackups() {
  try {
    fs.readdirSync(BACKUP_DIR)
      .filter(f => /^data-\d{4}-\d{2}-\d{2}\.db$/.test(f))
      .sort()
      .slice(0, -BACKUP_KEEP)
      .forEach(f => { fs.unlink(path.join(BACKUP_DIR, f), () => {}); log('info', 'backup rotated out', { f }); });
  } catch (e) { log('error', 'backup rotate failed', { err: e.message }); }
}
function runBackup() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const file = path.join(BACKUP_DIR, `data-${new Date().toISOString().slice(0, 10)}.db`);
    db.backup(file)
      .then(() => { log('info', 'backup OK', { file }); rotateBackups(); })
      .catch(e => log('error', 'backup failed', { err: e.message }));
  } catch (e) { log('error', 'backup failed', { err: e.message }); }
}
setTimeout(runBackup, 15e3).unref();
setInterval(runBackup, 24 * 3600e3).unref();

/* ---------- 21) AUDIT RETENTION + WAL CHECKPOINT ---------- */
function purgeAudit() {
  try {
    const n = P(`DELETE FROM audit_logs WHERE created_at < datetime('now','localtime','-${AUDIT_RETENTION_DAYS} days')`).run().changes;
    if (n) log('info', 'audit purged', { rows: n, keepDays: AUDIT_RETENTION_DAYS });
  } catch (e) { log('error', 'audit purge failed', { err: e.message }); }
}
setTimeout(purgeAudit, 60e3).unref();
setInterval(purgeAudit, 24 * 3600e3).unref();
setInterval(() => { try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch {} }, 6 * 3600e3).unref();

/* ---------- 22) GRACEFUL SHUTDOWN ---------- */
let shuttingDown = false;
function shutdown(sig, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', `shutdown (${sig})...`);
  try { io.disconnectSockets(true); } catch {}
  try { io.close(); } catch {}
  server.close(() => {
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch {}
    try { db.close(); } catch {}
    process.exit(code);
  });
  setTimeout(() => process.exit(code || 1), 10e3).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', err => {
  log('error', 'uncaughtException', { msg: err.message, stack: err.stack });
  shutdown('uncaughtException', 1);
});
process.on('unhandledRejection', r => log('error', 'unhandledRejection', { reason: String(r) }));

server.listen(PORT, () =>
  log('info', 'Geo-Case System v2 พร้อมใช้งาน', { port: PORT, mode: PROD ? 'production' : 'development' }));