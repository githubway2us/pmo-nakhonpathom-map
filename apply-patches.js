/* apply-patches.js — แก้ server.js v2 ของคุณอัตโนมัติ 6 จุด (สำรองเป็น server.js.bak ก่อน)
   วิธีใช้:  node apply-patches.js            (รันในโฟลเดอร์เดียวกับ server.js) */
const fs = require('fs');
const FILE = 'server.js';
let s = fs.readFileSync(FILE, 'utf8');
fs.writeFileSync(FILE + '.bak', s);

const patches = [
  ['ส่ง writeAudit ให้ export (บันทึก audit เมื่อส่งออก Excel)',
    /require\('\.\/export'\)\(\{ app, db, auth, adminOnly, pointRow(, writeAudit)? \}\);/,
    "require('./export')({ app, db, auth, adminOnly, pointRow, writeAudit });"],
  ['ใช้ req.ip แทน x-forwarded-for (ปลอมได้) ตอนบันทึก PDPA',
    /const pdpaAcknowledgedIp =[\s\S]*?null;/,
    'const pdpaAcknowledgedIp = req.ip || null;'],
  ['ล้าง loginTries ที่หมดอายุ',
    /const loginTries = new Map\(\);(?!\s*\n?setInterval)/,
    "const loginTries = new Map();\nsetInterval(() => { const n = Date.now(); for (const [k, v] of loginTries) if (n - v.at > 30 * 60e3) loginTries.delete(k); }, 10 * 60e3).unref();"],
  ["สังกัด 'other' แสดงข้อความที่ผู้ใช้ระบุ (shape)",
    "affiliation: r.affiliation === 'อื่นๆ' ? r.affiliation_other : r.affiliation,",
    "affiliation: ['other', 'อื่นๆ'].includes(r.affiliation) ? r.affiliation_other : r.affiliation,"],
  ['ต้องระบุสังกัดเมื่อเลือก "อื่น ๆ" ตอนสมัคร',
    '  /* ตรวจสอบ username */',
    "  if (affiliation === 'other' && !affiliation_other)\n    return fail(400, 'กรุณาระบุตำแหน่ง/สังกัด');\n\n  /* ตรวจสอบ username */"],
  ['กรองตามกรอบแผนที่ (bbox) ใน GET /api/points',
    "if (q.mine === '1') { w.push('p.user_id=?'); a.push(req.user.id); }",
    "if (q.mine === '1') { w.push('p.user_id=?'); a.push(req.user.id); }\n  const bb = String(q.bbox || '').split(',').map(Number);   // minLng,minLat,maxLng,maxLat\n  if (bb.length === 4 && bb.every(Number.isFinite)) {\n    w.push('p.lng BETWEEN ? AND ? AND p.lat BETWEEN ? AND ?'); a.push(bb[0], bb[2], bb[1], bb[3]);\n  }"],
];

let bad = 0;
for (const [name, from, to] of patches) {
  if (s.includes(to)) { console.log('• ทำไว้แล้ว (ข้าม):', name); continue; }   // รันซ้ำได้ ไม่ซ้อน
  const hit = typeof from === 'string' ? s.includes(from) : from.test(s);
  if (!hit) { console.log('✗ ไม่พบตำแหน่ง (ข้าม):', name); bad++; continue; }
  s = typeof from === 'string' ? s.replace(from, () => to) : s.replace(from, () => to);
  console.log('✓', name);
}
fs.writeFileSync(FILE, s);
console.log(bad ? `\nเสร็จ แต่ข้าม ${bad} จุด (ดูข้อความด้านบน) — ไฟล์เดิมสำรองไว้ที่ server.js.bak`
                : '\nเสร็จครบทุกจุด — ไฟล์เดิมสำรองไว้ที่ server.js.bak');
