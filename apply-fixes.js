'use strict';
/* apply-fixes.js — รันในโฟลเดอร์โปรเจกต์:  node apply-fixes.js
 * แก้ geo.js / server.js / app.html / tambon.geojson / data.db ด้วยการแทนที่ข้อความที่ระบุตรงตัว
 * - สำรองไฟล์เดิมเป็น *.bak-YYYY-MM-DD ก่อนแก้ทุกครั้ง
 * - รันซ้ำได้ (ถ้าแก้แล้วจะข้าม) / จุดที่หาไม่เจอจะรายงานแต่ไม่พัง
 */
const fs = require('fs');
const path = require('path');
const ROOT = process.cwd();
const STAMP = new Date().toISOString().slice(0, 10);
const find = (...c) => c.map(p => path.join(ROOT, p)).find(p => fs.existsSync(p));
const out = [];

function patch(file, label, edits) {
  if (!file) { out.push(`✗ ${label}: ไม่พบไฟล์ (ตรวจว่ารันในโฟลเดอร์โปรเจกต์)`); return; }
  const orig = fs.readFileSync(file, 'utf8');
  const crlf = orig.includes('\r\n');
  const nl = s => (crlf ? s.replace(/\r?\n/g, '\r\n') : s);
  let src = orig;
  for (const [name, a, b] of edits) {
    if (b && src.includes(nl(b))) { out.push(`• ${label}: ${name} — ทำไว้แล้ว`); continue; }
    const n = src.split(nl(a)).length - 1;
    if (n === 0) { out.push(`✗ ${label}: ${name} — ไม่พบข้อความเดิม (ข้าม)`); continue; }
    if (n > 1) { out.push(`✗ ${label}: ${name} — พบ ${n} จุด ไม่แน่ชัด (ข้าม)`); continue; }
    src = src.replace(nl(a), () => nl(b));
    out.push(`✓ ${label}: ${name}`);
  }
  if (src !== orig) {
    fs.copyFileSync(file, `${file}.bak-${STAMP}`);
    fs.writeFileSync(file, src, 'utf8');
  }
}

/* ---------- geo.js : รู้จัก ADM3_TH / ADM2_TH ---------- */
patch(find('geo.js'), 'geo.js', [
  ['KEYS ตำบล', "[process.env.TAMBON_KEY, 'tam_th',", "[process.env.TAMBON_KEY, 'ADM3_TH', 'tam_th',"],
  ['KEYS อำเภอ', "[process.env.AMPHOE_KEY, 'amp_th',", "[process.env.AMPHOE_KEY, 'ADM2_TH', 'amp_th',"]
]);

/* ---------- server.js : mount routes-extra + ส่ง warning ตอนบันทึก ---------- */
const MARK = '/* ---------- 17) ADMIN ---------- */';
patch(find('server.js'), 'server.js', [
  ['เพิ่ม PUT /api/points/:id และ PUT /api/profile', MARK,
    "require('./routes-extra')({ app, db, io, auth, approved, upload, writeLimiter, rateLimit, P, clean, intId, sniffImage, purgeFiles, removeFile, shape, pointRow, writeAudit, geo, bcrypt, sign, COOKIE_OPTS, kickSockets, safeUser, PROFILE_FIELDS, BCRYPT_ROUNDS });\n" + MARK],
  ['ส่ง warning ตอนสร้างเคส',
    "res.json({ ok: true, message: 'บันทึกพิกัดสำเร็จ รอผู้ดูแลระบบอนุมัติ', point });",
    "res.json({ ok: true, message: 'บันทึกพิกัดสำเร็จ รอผู้ดูแลระบบอนุมัติ', point, warning: area.warning });"]
]);
if (!fs.existsSync(path.join(ROOT, 'routes-extra.js')))
  out.push('✗ ไม่พบ routes-extra.js ในโฟลเดอร์นี้ — วางไฟล์ไว้ข้าง server.js ก่อนสตาร์ท');

/* ---------- app.html ---------- */
patch(find('public/app.html', 'app.html'), 'app.html', [
  ['PK รู้จัก ADM3_TH', "const PK=['tam_th',", "const PK=['ADM3_TH','tam_th',"],
  ['AK รู้จัก ADM2_TH', "const AK=['amp_th',", "const AK=['ADM2_TH','amp_th',"],
  ['ADMIN ใช้ .amphoes', "try{ADMIN=await (await fetch('/api/geo/admin')).json()}",
    "try{const j=await (await fetch('/api/geo/admin')).json();ADMIN=j.amphoes||j}"],
  ['ลบรูปเดิมแล้วหายจากรายการ', 'existingPhotos=existingPhotos.filter(x=>x!==id);',
    'existingPhotos=existingPhotos.filter(x=>String(x)!==String(id));'],
  ['ลบ script ที่โหลด .css ผิดชนิด',
    '<script src="https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css"></script>', ''],
  ['เปลี่ยนรหัสผ่านต้องยืนยันรหัสเดิม', "const r=await fetch('/api/profile',{method:'PUT',body:new FormData(e.target)});",
    "const pfd=new FormData(e.target);if(pfd.get('password')){const cur=prompt('กรอกรหัสผ่านปัจจุบันเพื่อยืนยันการเปลี่ยนรหัสผ่าน');if(!cur)return toast('ยกเลิกการเปลี่ยนรหัสผ่าน','err');pfd.append('current_password',cur);}else pfd.delete('password');const r=await fetch('/api/profile',{method:'PUT',body:pfd});"],
  ['แสดง warning หลังบันทึกเคส', "toast('✅ บันทึกพิกัดสำเร็จ! รอผู้ดูแลระบบอนุมัติ');",
    "toast('✅ บันทึกพิกัดสำเร็จ! รอผู้ดูแลระบบอนุมัติ');if(d.warning)setTimeout(()=>toast('⚠️ '+d.warning,'err'),3400);"]
]);

/* ---------- GeoJSON : สะกดชื่อตำบลให้ตรงกับ nkp-admin.json ---------- */
const gj = process.env.GEOJSON_PATH || find('data/tambon.geojson');
if (gj && fs.existsSync(gj)) {
  const s = fs.readFileSync(gj, 'utf8');
  const n = s.split('ศรีษะทอง').length - 1;
  if (n) {
    fs.copyFileSync(gj, `${gj}.bak-${STAMP}`);
    fs.writeFileSync(gj, s.split('ศรีษะทอง').join('ศีรษะทอง'), 'utf8');
    out.push(`✓ tambon.geojson: แก้ "ศรีษะทอง" → "ศีรษะทอง" ${n} จุด`);
  } else out.push('• tambon.geojson: ชื่อ ศีรษะทอง ถูกต้องแล้ว');
} else out.push('✗ tambon.geojson: ไม่พบไฟล์ (ตั้ง GEOJSON_PATH ถ้าอยู่ที่อื่น)');

/* ---------- data.db : แก้ข้อมูลเก่าที่สะกดผิด ---------- */
try {
  const dbFile = find('data.db');
  if (dbFile) {
    const Database = require(require.resolve('better-sqlite3', { paths: [ROOT] }));
    const db = new Database(dbFile);
    db.pragma('busy_timeout = 5000');
    const r = db.prepare("UPDATE points SET tambon='ศีรษะทอง' WHERE tambon='ศรีษะทอง'").run();
    db.close();
    out.push(`✓ data.db: แก้ข้อมูลเก่า ${r.changes} แถว`);
  }
} catch (e) { out.push('• data.db: ข้าม (' + e.message + ')'); }

console.log('\n' + out.join('\n') + '\n\nเสร็จแล้ว → restart server แล้วกด Ctrl+F5 ที่หน้าเว็บ\n');
