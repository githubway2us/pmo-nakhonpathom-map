#!/usr/bin/env node
/* ============================================================================
 * reset-admin.js — รีเซ็ตรหัสผ่านจากเครื่องเซิร์ฟเวอร์ (ใช้เมื่อแอดมินลืมรหัสผ่าน)
 *
 *   node reset-admin.js                 รีเซ็ตบัญชี admin (สุ่มรหัสใหม่ให้)
 *   node reset-admin.js somchai         รีเซ็ตบัญชีผู้ใช้อื่น
 *   node reset-admin.js admin --create  สร้างบัญชี admin ใหม่ ถ้ายังไม่มี
 *   node reset-admin.js admin --yes     ข้ามการถามยืนยัน (ใช้ในสคริปต์)
 *   node reset-admin.js admin --password "รหัสใหม่1"   กำหนดรหัสเอง (ไม่แนะนำ: ค้างใน history)
 *
 * ต้องรันบนเครื่องที่มีไฟล์ data.db เท่านั้น (ไม่มีช่องทางผ่านเว็บ จึงปลอดภัยกว่า)
 * ตัวแปร env: DB_PATH=ที่อยู่ไฟล์ฐานข้อมูล (ค่าเริ่มต้น ./data.db ข้าง ๆ สคริปต์นี้)
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

const BCRYPT_ROUNDS = 12;               // ต้องตรงกับ server.js
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');

/* ---------- อ่านอาร์กิวเมนต์ ---------- */
const pos = [], opt = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--password') opt.password = argv[++i];
  else if (a.startsWith('--')) opt[a.slice(2)] = true;
  else pos.push(a);
}
if (opt.help || opt.h) {
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 14).join('\n'));
  process.exit(0);
}
const username = pos[0] || 'admin';

const die = msg => { console.error('\n✗ ' + msg + '\n'); process.exit(1); };

/* ---------- รหัสผ่านสุ่ม (ตัดตัวอักษรที่สับสนง่าย: 0 O 1 l I) ---------- */
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const DIGITS = '23456789';
function genPassword(len = 16) {
  const all = LETTERS + DIGITS;
  const pick = set => set[crypto.randomInt(set.length)];
  const chars = [pick(LETTERS), pick(DIGITS)];
  while (chars.length < len) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {          // สลับตำแหน่งแบบ Fisher–Yates
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}
const policyOk = p => typeof p === 'string' && p.length >= 8 && /[A-Za-z]/.test(p) && /\d/.test(p);

const ask = q => new Promise(res => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(q, a => { rl.close(); res(a.trim()); });
});

(async () => {
  if (!fs.existsSync(DB_PATH)) die(`ไม่พบฐานข้อมูล: ${DB_PATH}\n  (รันในโฟลเดอร์เดียวกับ server.js หรือกำหนด DB_PATH)`);

  const db = new Database(DB_PATH);
  db.pragma('busy_timeout = 5000');
  const cols = new Set(db.prepare('PRAGMA table_info(users)').all().map(c => c.name));
  const acols = new Set(db.prepare('PRAGMA table_info(audit_logs)').all().map(c => c.name));
  if (!cols.has('username') || !cols.has('password')) die('โครงสร้างตาราง users ไม่ถูกต้อง');

  let user = db.prepare('SELECT id, username, role, status FROM users WHERE username=?').get(username);

  if (!user && !opt.create) {
    const admins = db.prepare("SELECT username FROM users WHERE role='admin'").all().map(r => r.username);
    die(`ไม่พบผู้ใช้ "${username}"\n  บัญชีแอดมินที่มีอยู่: ${admins.join(', ') || '(ยังไม่มี)'}\n` +
        '  ถ้าต้องการสร้างใหม่ ให้เพิ่ม --create');
  }

  let newPwd = opt.password;
  if (newPwd !== undefined && !policyOk(newPwd))
    die('รหัสผ่านที่กำหนดต้องยาวอย่างน้อย 8 ตัวอักษร และมีทั้งตัวอักษรและตัวเลข');
  const generated = newPwd === undefined;
  if (generated) newPwd = genPassword();

  /* ---------- ยืนยันก่อนทำ ---------- */
  console.log('\n=== รีเซ็ตรหัสผ่าน ===');
  console.log('ฐานข้อมูล :', DB_PATH);
  console.log('บัญชี     :', username, user ? `(role=${user.role}, status=${user.status})` : '(จะสร้างใหม่เป็น admin)');
  console.log('ผลที่ตามมา : รหัสผ่านเดิมใช้ไม่ได้ และเซสชันที่ล็อกอินค้างอยู่ของบัญชีนี้จะถูกยกเลิก');
  if (!opt.yes) {
    const a = await ask('\nพิมพ์ YES เพื่อยืนยัน: ');
    if (a !== 'YES') die('ยกเลิกแล้ว ไม่มีการเปลี่ยนแปลง');
  }

  /* ---------- สำรองฐานข้อมูลก่อนแก้ ---------- */
  const bdir = path.join(path.dirname(DB_PATH), 'backups');
  fs.mkdirSync(bdir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const bfile = path.join(bdir, `data-before-reset-${stamp}.db`);
  await db.backup(bfile);
  console.log('✓ สำรองฐานข้อมูลไว้ที่', bfile);

  /* ---------- แก้ข้อมูล ---------- */
  const hash = bcrypt.hashSync(newPwd, BCRYPT_ROUNDS);
  let uid;
  db.transaction(() => {
    if (!user) {
      uid = db.prepare(`INSERT INTO users (username,password,first_name,last_name,nickname,affiliation,phone,role,status)
        VALUES (?,?,?,?,?,?,?,'admin','approved')`)
        .run(username, hash, 'ผู้ดูแล', 'ระบบ', 'แอดมิน', 'เจ้าหน้าที่', '-').lastInsertRowid;
      return;
    }
    uid = user.id;
    const sets = ['password=?'], vals = [hash];
    if (cols.has('token_version')) sets.push('token_version=COALESCE(token_version,0)+1');   // ยกเลิกเซสชันเก่า
    if (cols.has('updated_at')) sets.push("updated_at=datetime('now','localtime')");
    if (cols.has('must_change_password')) sets.push('must_change_password=1');
    if (user.role === 'admin') sets.push("status='approved'");                              // ปลดล็อกบัญชีแอดมิน
    db.prepare(`UPDATE users SET ${sets.join(',')} WHERE id=?`).run(...vals, uid);

    if (acols.has('action')) {
      const f = ['user_id', 'action', 'resource_type', 'resource_id', 'ip', 'user_agent'];
      const v = [uid, user ? 'CLI_RESET_PASSWORD' : 'CLI_CREATE_ADMIN', 'USER', uid, 'cli', 'reset-admin.js'];
      if (acols.has('request_id')) { f.push('request_id'); v.push(''); }
      db.prepare(`INSERT INTO audit_logs (${f.join(',')}) VALUES (${f.map(() => '?').join(',')})`).run(...v);
    }
  })();
  if (!user && acols.has('action')) {
    db.prepare(`INSERT INTO audit_logs (user_id,action,resource_type,resource_id,ip,user_agent)
                VALUES (?,?,?,?,?,?)`).run(uid, 'CLI_CREATE_ADMIN', 'USER', uid, 'cli', 'reset-admin.js');
  }
  db.close();

  /* ---------- แสดงผล ---------- */
  console.log('\n✓ เสร็จเรียบร้อย');
  console.log('──────────────────────────────────────────');
  console.log('  ชื่อผู้ใช้ :', username);
  console.log('  รหัสผ่านใหม่:', newPwd, generated ? '' : '(ที่คุณกำหนด)');
  console.log('──────────────────────────────────────────');
  console.log('• แสดงครั้งเดียว — จดไว้ แล้วเข้าสู่ระบบและเปลี่ยนรหัสผ่านทันที');
  console.log('• ถ้าบัญชีถูกล็อกจากการใส่รหัสผิดหลายครั้ง ให้รีสตาร์ตเซิร์ฟเวอร์ (ตัวนับอยู่ในหน่วยความจำ)');
  console.log('• ล้างหน้าจอ/ประวัติคำสั่งหลังใช้งาน (PowerShell: Clear-Host)\n');
})().catch(e => die(e.message));
