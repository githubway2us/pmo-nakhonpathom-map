'use strict';
/* routes-extra.js — เพิ่ม route ที่ app.html เรียกแต่ server.js ยังไม่มี
 *  PUT /api/points/:id  (แก้ไขเคส + เพิ่ม/ลบรูป, multipart)
 *  PUT /api/profile     (แก้โปรไฟล์ + avatar + เปลี่ยนรหัสผ่านโดยยืนยันรหัสเดิม)
 */
module.exports = function mount(d) {
  const { app, db, io, auth, approved, upload, writeLimiter, rateLimit, P, clean, intId,
          sniffImage, purgeFiles, removeFile, shape, pointRow, writeAudit, geo, bcrypt,
          sign, COOKIE_OPTS, kickSockets, safeUser, PROFILE_FIELDS, BCRYPT_ROUNDS } = d;
  const PHONE = /^[0-9+\-\s()]{6,20}$/;
  const MAX_PHOTOS = 6;

  /* ---------- แก้ไขเคส ---------- */
  app.put('/api/points/:id', auth, approved, writeLimiter, upload.array('photos', MAX_PHOTOS), (req, res) => {
    const files = req.files || [];
    const fail = (code, msg) => { purgeFiles(files); return res.status(code).json({ error: msg }); };

    const id = intId(req.params.id);
    if (!id) return fail(400, 'id ไม่ถูกต้อง');
    const p = P('SELECT * FROM points WHERE id=? AND deleted_at IS NULL').get(id);
    if (!p) return fail(404, 'ไม่พบข้อมูล');
    const isAdmin = req.user.role === 'admin';
    if (p.user_id !== req.user.id && !isAdmin) return fail(403, 'ไม่มีสิทธิ์แก้ไขเคสนี้');

    const b = req.body || {};
    const case_name = clean(b.case_name, 200), case_type = clean(b.case_type, 100);
    if (!case_name || !case_type) return fail(400, 'กรอกชื่อเคสและลักษณะเคส');
    const phone = clean(b.caretaker_phone, 20);
    if (phone && !PHONE.test(phone)) return fail(400, 'เบอร์ผู้ดูแลไม่ถูกต้อง');
    const lat = parseFloat(b.lat), lng = parseFloat(b.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180)
      return fail(400, 'พิกัดไม่ถูกต้อง');
    if (files.some(f => !sniffImage(f.path))) return fail(400, 'พบไฟล์ที่ไม่ใช่รูปภาพจริง');

    let remove = [];
    try { remove = JSON.parse(b.removePhotos || '[]'); } catch { /* ignore */ }
    remove = (Array.isArray(remove) ? remove : []).map(intId).filter(Boolean);
    const cur = P('SELECT id, file FROM point_photos WHERE point_id=?').all(id);
    const delRows = cur.filter(r => remove.includes(r.id));
    if (cur.length - delRows.length + files.length > MAX_PHOTOS)
      return fail(400, `รูปรวมต้องไม่เกิน ${MAX_PHOTOS} รูป`);

    const area = geo.resolveArea(b, lat, lng);
    if (area.error) return fail(400, area.error);

    // ผู้ใช้ทั่วไปแก้เคสที่อนุมัติ/ถูกปฏิเสธแล้ว → กลับไปรออนุมัติใหม่
    const toPending = !isAdmin && p.status !== 'pending';
    const statusSql = toPending ? ", status='pending', reject_reason=NULL" : '';

    db.transaction(() => {
      P(`UPDATE points SET lat=?, lng=?, case_name=?, case_type=?, case_type_other=?,
           caretaker_name=?, caretaker_phone=?, address=?, note=?,
           amphoe=?, tambon=?, moo=?, area_source=?${statusSql},
           updated_at=datetime('now','localtime') WHERE id=?`)
        .run(lat, lng, case_name, case_type, clean(b.case_type_other, 100),
             clean(b.caretaker_name, 150), phone, clean(b.address, 300), clean(b.note, 2000),
             area.amphoe, area.tambon, area.moo, area.source, id);
      const del = P('DELETE FROM point_photos WHERE id=? AND point_id=?');
      delRows.forEach(r => del.run(r.id, id));
      const ins = P('INSERT INTO point_photos (point_id,file) VALUES (?,?)');
      files.forEach(f => ins.run(id, '/uploads/' + f.filename));
    })();
    delRows.forEach(r => removeFile(r.file));

    writeAudit(req.user.id, isAdmin ? 'ADMIN_UPDATE_POINT' : 'UPDATE_POINT', 'POINT', id, req);
    const point = shape(P(`${pointRow} WHERE p.id=?`).get(id));
    io.to('user:' + p.user_id).emit('point:mine', point);
    if (point.status === 'approved') io.emit('point:update-hint', { id });
    else {
      if (p.status === 'approved') io.emit('point:removed', { id });   // เพิ่งถูกดึงกลับไปรออนุมัติ
      io.to('admins').emit('point:pending', { id, status: point.status });
    }
    res.json({
      ok: true, point, warning: area.warning, statusChanged: toPending,
      message: toPending ? 'แก้ไขสำเร็จ — ส่งกลับไปรอผู้ดูแลอนุมัติใหม่' : 'แก้ไขสำเร็จ'
    });
  });

  /* ---------- แก้โปรไฟล์ ---------- */
  const profLimiter = rateLimit({ windowMs: 10 * 60e3, max: 30 });
  app.put('/api/profile', auth, profLimiter, upload.single('avatar'), (req, res) => {
    const fail = (code, msg) => { purgeFiles(req.file ? [req.file] : []); return res.status(code).json({ error: msg }); };
    const b = req.body || {};
    const sets = [], vals = [];

    for (const f of PROFILE_FIELDS) {
      if (typeof b[f] !== 'string') continue;
      const v = clean(b[f], 200);
      if ((f === 'first_name' || f === 'last_name') && !v) return fail(400, 'ชื่อและนามสกุลต้องไม่ว่าง');
      if (f === 'phone' && v && !PHONE.test(v)) return fail(400, 'เบอร์โทรศัพท์ไม่ถูกต้อง');
      sets.push(`${f}=?`); vals.push(v);
    }
    if (typeof b.affiliation === 'string' && clean(b.affiliation, 100)) {
      sets.push('affiliation=?'); vals.push(clean(b.affiliation, 100));
    }
    if (typeof b.affiliation_other === 'string') { sets.push('affiliation_other=?'); vals.push(clean(b.affiliation_other, 100)); }

    let newTv = null;
    if (typeof b.password === 'string' && b.password) {
      const np = b.password;
      if (np.length < 8 || !/[A-Za-z]/.test(np) || !/\d/.test(np))
        return fail(400, 'รหัสผ่านใหม่ต้องยาวอย่างน้อย 8 ตัวอักษร และมีทั้งตัวอักษรและตัวเลข');
      if (typeof b.current_password !== 'string' || !bcrypt.compareSync(b.current_password, req.user.password))
        return fail(401, 'รหัสผ่านปัจจุบันไม่ถูกต้อง');
      newTv = (req.user.token_version || 0) + 1;
      sets.push('password=?', 'token_version=?');
      vals.push(bcrypt.hashSync(np, BCRYPT_ROUNDS), newTv);
    }

    let oldAvatar = null;
    if (req.file) {
      if (!sniffImage(req.file.path)) return fail(400, 'ไฟล์รูปโปรไฟล์ไม่ถูกต้อง');
      oldAvatar = req.user.avatar;
      sets.push('avatar=?'); vals.push('/uploads/' + req.file.filename);
    }
    if (!sets.length) return fail(400, 'ไม่มีข้อมูลที่ต้องการแก้ไข');

    vals.push(req.user.id);
    P(`UPDATE users SET ${sets.join(', ')}, updated_at=datetime('now','localtime') WHERE id=?`).run(...vals);
    if (oldAvatar) removeFile(oldAvatar);

    const u = P('SELECT * FROM users WHERE id=?').get(req.user.id);
    writeAudit(req.user.id, newTv !== null ? 'CHANGE_PASSWORD' : 'UPDATE_PROFILE', 'USER', req.user.id, req);
    if (newTv !== null) { kickSockets(u.id); res.cookie('token', sign(u), COOKIE_OPTS); }
    io.to('user:' + u.id).emit('me:updated', safeUser(u));
    res.json({ ok: true, user: safeUser(u) });
  });
};
