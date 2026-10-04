'use strict';
/* apply-scale.js — รันในโฟลเดอร์โปรเจกต์:  node apply-scale.js
 * วางไฟล์ scale-server.js / scale-app.js / scale-admin.js ไว้โฟลเดอร์เดียวกับไฟล์นี้ก่อน
 * สำรองไฟล์เดิมเป็น *.bak-scale-วันที่ • รันซ้ำได้ • จุดที่หาไม่เจอจะรายงานแล้วข้าม */
const fs = require('fs');
const path = require('path');
const ROOT = process.cwd(), HERE = __dirname;
const STAMP = new Date().toISOString().slice(0, 10);
const find = (...c) => c.map(p => path.join(ROOT, p)).find(p => fs.existsSync(p));
const out = [];

function patch(file, label, edits) {
  if (!file) { out.push(`✗ ${label}: ไม่พบไฟล์`); return; }
  const orig = fs.readFileSync(file, 'utf8');
  const crlf = orig.includes('\r\n');
  const nl = s => (crlf ? s.replace(/\r?\n/g, '\r\n') : s);
  let src = orig;
  for (const [name, a, b] of edits) {
    if (src.includes(nl(b))) { out.push(`• ${label}: ${name} — ทำไว้แล้ว`); continue; }
    const n = src.split(nl(a)).length - 1;
    if (n !== 1) { out.push(`✗ ${label}: ${name} — พบ ${n} จุด (ข้าม)`); continue; }
    src = src.replace(nl(a), () => nl(b));
    out.push(`✓ ${label}: ${name}`);
  }
  if (src !== orig) { fs.copyFileSync(file, `${file}.bak-scale-${STAMP}`); fs.writeFileSync(file, src, 'utf8'); }
}
const code = f => { const p = path.join(HERE, f); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; };
const END = '</script></body></html>';
const embed = f => { const c = code(f); return c ? `</script>\n<script>\n${c}\n</script></body></html>` : null; };

/* ---------- server.js ---------- */
if (code('scale-server.js') && HERE !== ROOT) fs.copyFileSync(path.join(HERE, 'scale-server.js'), path.join(ROOT, 'scale-server.js'));
const M5 = '/* ---------- 5) PREPARED STATEMENT CACHE ---------- */';
const QT = "if (q.type)   { w.push('p.case_type=?'); a.push(String(q.type).slice(0, 100)); }";
patch(find('server.js'), 'server.js', [
  ['mount scale-server (index/pragma)', M5, "require('./scale-server')({ db, log });\n" + M5],
  ['พารามิเตอร์ mine=1 (เคสของฉัน)', QT, QT + "\n  if (q.mine === '1') { w.push('p.user_id=?'); a.push(req.user.id); }"],
  ['เพดาน rate-limit รวม (ออฟฟิศใช้ IP เดียวกัน)', 'app.use(rateLimit({ windowMs: 60e3, max: 300 }));',
    'app.use(rateLimit({ windowMs: 60e3, max: Number(process.env.RATE_MAX) || 1500 }));']
]);

/* ---------- geo.js : cluster ใช้ covering index + กรองตำบลได้ ---------- */
const CT = "if (req.query.type)   { w.push('p.case_type=?'); a.push(String(req.query.type).slice(0, 100)); }";
patch(find('geo.js'), 'geo.js', [
  ['cluster ไม่ต้องอ่านแถวจริง', 'MIN(p.case_name) caseName', '0 _pad'],
  ['cluster กรองตำบล', CT, CT + "\n    if (req.query.tambon) { w.push('p.tambon=?'); a.push(String(req.query.tambon).slice(0, 100)); }"]
]);

/* ---------- หน้าเว็บ (ฝังโค้ดไว้ในหน้า เพื่อให้ทำงานก่อนการโหลดครั้งแรกเสมอ) ---------- */
const eApp = embed('scale-app.js'), eAdm = embed('scale-admin.js');
patch(find('public/app.html', 'app.html'), 'app.html', eApp
  ? [['แผนที่แบบโหลดตามกรอบจอ (cluster)', END, eApp]] : []);
if (!eApp) out.push('✗ app.html: ไม่พบ scale-app.js');
patch(find('public/admin.html', 'admin.html'), 'admin.html', eAdm ? [
  ['รายการสมาชิกแบบแบ่งหน้า', "const us=await (await fetch('/api/admin/users'+q)).json();", "const us=await pg('/api/admin/users',q);"],
  ['รายการพิกัดแบบแบ่งหน้า', "const ps=await (await fetch('/api/admin/points'+q)).json();", "const ps=await pg('/api/admin/points',q);"],
  ['แถบค้นหา + ตัวแบ่งหน้า', END, eAdm]
] : []);
if (!eAdm) out.push('✗ admin.html: ไม่พบ scale-admin.js');

console.log('\n' + out.join('\n') + '\n\nเสร็จแล้ว → restart server แล้วกด Ctrl+F5\n');
