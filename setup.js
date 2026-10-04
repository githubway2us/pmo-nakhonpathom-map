/* setup.js — ตัวแตกไฟล์โปรเจกต์ พมจ.นครปฐม */
const fs = require('fs');
const path = require('path');

const BUNDLE = path.join(__dirname, 'bundle.txt');
if (!fs.existsSync(BUNDLE)) {
  console.error('❌ ไม่พบไฟล์ bundle.txt — กรุณาวางไว้ในโฟลเดอร์เดียวกับ setup.js');
  process.exit(1);
}

const raw = fs.readFileSync(BUNDLE, 'utf8').replace(/\r\n/g, '\n');
const parts = raw.split(/^=====\s*FILE:\s*(.+?)\s*=====$/m);

if (parts.length < 3) {
  console.error('❌ รูปแบบ bundle.txt ไม่ถูกต้อง (ไม่พบเครื่องหมาย ===== FILE: ... =====)');
  process.exit(1);
}

let count = 0;
for (let i = 1; i < parts.length; i += 2) {
  const rel = parts[i].trim();
  const body = parts[i + 1].replace(/^\n/, '').trimEnd() + '\n';
  const full = path.join(__dirname, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body, 'utf8');
  console.log('✔ สร้าง  ' + rel + '  (' + body.length.toLocaleString() + ' ตัวอักษร)');
  count++;
}

fs.mkdirSync(path.join(__dirname, 'uploads'), { recursive: true });
console.log('✔ สร้าง  uploads/');
console.log('\n🎉 สร้างไฟล์เสร็จทั้งหมด ' + count + ' ไฟล์');
console.log('\nขั้นตอนถัดไป:');
console.log('  1) npm install');
console.log('  2) npm start');
console.log('  3) เปิด http://localhost:3000   (admin / admin123)\n');