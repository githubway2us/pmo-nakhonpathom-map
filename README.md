# ชุดไฟล์ระบบแผนที่พิกัด พมจ.นครปฐม (v3)

ไฟล์ในชุดนี้: geo.js, export.js, nkp-admin.json, package.json, public/app.html, public/admin.html, apply-patches.js
ไฟล์ของคุณที่ไม่ได้อยู่ในชุดและไม่ต้องแก้: server.js (แก้ด้วย apply-patches.js), public/index.html, public/gov-config.js, public/style.css, scale-server.js, routes-extra.js

1. แตก zip ทับโฟลเดอร์โปรเจกต์ (ไฟล์ server.js ของคุณยังอยู่เหมือนเดิม)
2. `node apply-patches.js`  → แก้ server.js 6 จุด และสำรองเป็น server.js.bak
3. `npm install` (จะติดตั้ง exceljs, helmet, compression เพิ่ม)
4. วางไฟล์เขตตำบลที่ data/tambon.geojson (ถ้ามี) แล้ว `npm start`
5. ต้องตั้ง JWT_SECRET (อย่างน้อย 32 ตัวอักษร) และ INITIAL_ADMIN_PASSWORD ตาม server.js v2
