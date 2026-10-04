/* export.js — ส่งออกพิกัดเป็นไฟล์ Excel (เฉพาะแอดมิน) */
const ExcelJS = require('exceljs');

// กัน Excel formula injection: ข้อความที่ขึ้นต้นด้วย = + - @ จะถูกนำหน้าด้วย '
const safe = v => (typeof v === 'string' && /^[=+\-@\t\r]/.test(v)) ? "'" + v : v;
const ST = { approved: 'อนุมัติแล้ว', pending: 'รออนุมัติ', rejected: 'ไม่อนุมัติ' };

module.exports = function mountExport({ app, db, auth, adminOnly, pointRow, writeAudit }) {
  // GET /api/admin/export.xlsx?status=&amphoe=&tambon=&type=
  app.get('/api/admin/export.xlsx', auth, adminOnly, async (req, res) => {
    try {
      const q = req.query, w = ['p.deleted_at IS NULL'], a = [];
      if (ST[q.status]) { w.push('p.status=?'); a.push(q.status); }
      for (const [k, col] of [['amphoe', 'p.amphoe'], ['tambon', 'p.tambon'], ['type', 'p.case_type']])
        if (q[k]) { w.push(col + '=?'); a.push(String(q[k])); }
      const rows = db.prepare(`${pointRow} WHERE ${w.join(' AND ')} ORDER BY p.id`).all(...a);
      const pc = {};
      db.prepare('SELECT point_id, COUNT(*) c FROM point_photos GROUP BY point_id').all()
        .forEach(r => pc[r.point_id] = r.c);

      const wb = new ExcelJS.Workbook();
      wb.creator = 'พมจ.นครปฐม'; wb.created = new Date();
      const ws = wb.addWorksheet('พิกัด', { views: [{ state: 'frozen', ySplit: 1 }] });
      ws.columns = [
        ['รหัส', 8], ['ชื่อเคส', 24], ['ลักษณะเคส', 18], ['ผู้ดูแล', 20], ['เบอร์ผู้ดูแล', 15],
        ['ที่อยู่', 34], ['อำเภอ', 16], ['ตำบล', 16], ['หมู่ที่', 8], ['Latitude', 13], ['Longitude', 13],
        ['ความแม่นยำ GPS (ม.)', 14], ['สถานะ', 13], ['เหตุผลที่ไม่อนุมัติ', 24], ['ผู้บันทึก', 24],
        ['สังกัดผู้บันทึก', 16], ['เบอร์ผู้บันทึก', 15], ['วันที่บันทึก', 19], ['จำนวนรูป', 9],
        ['หมายเหตุ', 30], ['ลิงก์แผนที่', 14]
      ].map(([header, width]) => ({ header, width }));
      rows.forEach(r => ws.addRow([
        r.id, safe(r.case_name), safe(r.case_type === 'อื่นๆ' ? (r.case_type_other || 'อื่นๆ') : r.case_type),
        safe(r.caretaker_name || ''), safe(r.caretaker_phone || ''), safe(r.address || ''),
        r.amphoe || '', r.tambon || '', safe(r.moo || ''), r.lat, r.lng, r.accuracy ?? '',
        ST[r.status] || r.status, safe(r.reject_reason || ''),
        safe(`${r.first_name} ${r.last_name}` + (r.nickname ? ` (${r.nickname})` : '')),
        safe(['other', 'อื่นๆ'].includes(r.affiliation) ? (r.affiliation_other || '') : r.affiliation),
        safe(r.reporter_phone || ''), r.created_at, pc[r.id] || 0, safe(r.note || ''),
        { text: 'เปิดแผนที่', hyperlink: `https://www.google.com/maps?q=${r.lat},${r.lng}` }
      ]));
      const hr = ws.getRow(1);
      hr.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      hr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3864' } };
      hr.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      hr.height = 32;
      ws.getColumn(10).numFmt = '0.000000'; ws.getColumn(11).numFmt = '0.000000';
      ws.autoFilter = { from: 'A1', to: { row: 1, column: 21 } };

      // ชีตสรุปรายอำเภอ/ตำบล
      const sum = {};
      rows.forEach(r => { const k = (r.amphoe || 'ไม่ระบุ') + '|' + (r.tambon || 'ไม่ระบุ'); sum[k] = (sum[k] || 0) + 1; });
      const s2 = wb.addWorksheet('สรุปรายพื้นที่', { views: [{ state: 'frozen', ySplit: 1 }] });
      s2.columns = [{ header: 'อำเภอ', width: 20 }, { header: 'ตำบล', width: 20 }, { header: 'จำนวนจุด', width: 12 }];
      Object.entries(sum).sort((x, y) => y[1] - x[1])
        .forEach(([k, n]) => s2.addRow([...k.split('|'), n]));
      s2.addRow(['รวม', '', rows.length]).font = { bold: true };
      s2.getRow(1).font = { bold: true };

      const d = new Date(), p2 = n => String(n).padStart(2, '0');
      const fn = `points-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}.xlsx`;
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${fn}"`);
      if (writeAudit) writeAudit(req.user.id, 'ADMIN_EXPORT_POINTS', 'POINT', null, req);
      console.log(`[export] ${req.user.username} ส่งออก ${rows.length} จุด`, JSON.stringify(q));
      await wb.xlsx.write(res); res.end();
    } catch (e) {
      console.error('[export]', e);
      if (!res.headersSent) res.status(500).json({ error: 'ส่งออกไฟล์ไม่สำเร็จ' }); else res.end();
    }
  });
};
