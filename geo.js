/* geo.js — ระบบพื้นที่ละเอียดระดับ อำเภอ/ตำบล/หมู่ สำหรับแผนที่ (เพิ่มเข้า server.js เดิม) */
const fs = require('fs');
const path = require('path');
const ADMIN = require('./nkp-admin.json');           // อำเภอ -> [ตำบล]

// ไฟล์เขตตำบล (GeoJSON) — วางไว้นอก public เพื่อให้ต้องล็อกอินก่อนจึงโหลดได้
const GEOJSON = process.env.GEOJSON_PATH || path.join(__dirname, 'data', 'tambon.geojson');
// ชื่อ property ใน GeoJSON (ปรับด้วย env ได้ถ้าไฟล์ของคุณใช้ชื่ออื่น)
const KEYS = {
  tambon: [process.env.TAMBON_KEY, 'tam_th', 'TAM_NAMT', 'tb_th', 'tambon', 'name'].filter(Boolean),
  amphoe: [process.env.AMPHOE_KEY, 'amp_th', 'AMP_NAMT', 'ap_th', 'amphoe'].filter(Boolean)
};
const BOUNDS = { minLat: 13.6, maxLat: 14.25, minLng: 99.85, maxLng: 100.45 }; // กรอบคร่าว ๆ ของจังหวัด

const norm = s => String(s || '').replace(/^(ตำบล|ต\.|อำเภอ|อ\.)\s*/, '').trim();
const pick = (o, keys) => { for (const k of keys) if (o[k]) return o[k]; return ''; };
const inBounds = (lat, lng) =>
  lat >= BOUNDS.minLat && lat <= BOUNDS.maxLat && lng >= BOUNDS.minLng && lng <= BOUNDS.maxLng;

function amphoeOf(tambon) {            // หาอำเภอจากชื่อตำบล (เฉพาะกรณีชื่อไม่ซ้ำ)
  const c = Object.keys(ADMIN).filter(a => ADMIN[a].includes(tambon));
  return c.length === 1 ? c[0] : null;
}

/* ---------- โหลดเขตตำบล + point-in-polygon ---------- */
const STATUS = { file: GEOJSON, exists: false, loaded: false, features: 0,
                 tambonKey: null, amphoeKey: null, matched: 0, note: '' };
const allTam = new Set(Object.values(ADMIN).flat()), allAmp = new Set(Object.keys(ADMIN));

// เดาชื่อ property ของ ตำบล/อำเภอ จากค่าที่ตรงกับรายชื่อจริง (ไม่ต้องตั้ง env เอง)
function detectKeys(raw) {
  const sc = {};
  for (const f of raw.slice(0, 500)) for (const [k, v] of Object.entries(f.properties)) {
    if (typeof v !== 'string') continue;
    const n = norm(v), s = (sc[k] ||= { tam: 0, amp: 0 });
    if (allTam.has(n)) s.tam++;
    if (allAmp.has(n)) s.amp++;
  }
  const best = w => Object.entries(sc).sort((a, b) => b[1][w] - a[1][w])[0];
  const t = best('tam'), a = best('amp');
  return { tambon: process.env.TAMBON_KEY || (t && t[1].tam ? t[0] : null),
           amphoe: process.env.AMPHOE_KEY || (a && a[1].amp ? a[0] : null) };
}

let feats = null;
function load() {
  if (feats) return feats;
  feats = [];
  STATUS.exists = fs.existsSync(GEOJSON);
  if (!STATUS.exists) {
    STATUS.note = 'ไม่พบไฟล์เขตตำบล — วางไฟล์ไว้ที่ ' + GEOJSON;
    console.warn('[geo]', STATUS.note);
    return feats;
  }
  try {
    const gj = JSON.parse(fs.readFileSync(GEOJSON, 'utf8'));
    const raw = []; let swap = null;
    for (const f of gj.features || []) {
      const g = f.geometry; if (!g) continue;
      let polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
      if (!polys.length) continue;
      if (swap === null) {                       // ตรวจระบบพิกัดจากจุดแรก
        const [x, y] = polys[0][0][0];
        swap = x >= 13 && x <= 15 && y >= 99 && y <= 101;   // สลับ lat/lng มา
        if (!swap && (Math.abs(x) > 180 || Math.abs(y) > 90)) {
          STATUS.note = 'พิกัดในไฟล์ไม่ใช่ WGS84 (lat/lng) — ต้องแปลงเป็น EPSG:4326 ก่อนใช้งาน';
          console.error('[geo]', STATUS.note); return feats;
        }
      }
      if (swap) polys = polys.map(p => p.map(r => r.map(([x, y]) => [y, x])));
      let x1 = 180, y1 = 90, x2 = -180, y2 = -90;
      for (const p of polys) for (const [x, y] of p[0]) {
        if (x < x1) x1 = x; if (x > x2) x2 = x; if (y < y1) y1 = y; if (y > y2) y2 = y;
      }
      // ข้ามพื้นที่นอกจังหวัด (กรณีใช้ไฟล์ทั้งประเทศ)
      if (x2 < BOUNDS.minLng || x1 > BOUNDS.maxLng || y2 < BOUNDS.minLat || y1 > BOUNDS.maxLat) continue;
      raw.push({ polys, box: [x1, y1, x2, y2], properties: f.properties || {} });
    }
    const k = detectKeys(raw);
    STATUS.tambonKey = k.tambon; STATUS.amphoeKey = k.amphoe;
    const names = new Set();
    for (const r of raw) {
      const tambon = k.tambon ? norm(r.properties[k.tambon]) : '';
      const amphoe = k.amphoe ? norm(r.properties[k.amphoe]) : '';
      if (allTam.has(tambon)) names.add(tambon);
      feats.push({ polys: r.polys, box: r.box, tambon, amphoe: amphoe || amphoeOf(tambon) });
    }
    STATUS.loaded = true; STATUS.features = feats.length; STATUS.matched = names.size;
    if (!feats.length) STATUS.note = 'ไม่มีพื้นที่ในไฟล์ที่อยู่ในกรอบจังหวัดนครปฐม';
    else if (!k.tambon) STATUS.note = 'หา property ชื่อตำบลในไฟล์ไม่เจอ — ตั้ง env TAMBON_KEY';
    console.log(`[geo] โหลดเขต ${feats.length} พื้นที่ (ตำบลตรงรายชื่อ ${names.size}/106) key ตำบล=${k.tambon} อำเภอ=${k.amphoe}`);
  } catch (e) { STATUS.note = 'อ่านไฟล์เขตไม่ได้: ' + e.message; console.error('[geo]', STATUS.note); }
  return feats;
}
function inRing(x, y, ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
const inPoly = (x, y, p) => inRing(x, y, p[0]) && !p.slice(1).some(h => inRing(x, y, h));

function locate(lat, lng) {
  for (const f of load()) {
    const [x1, y1, x2, y2] = f.box;
    if (lng < x1 || lng > x2 || lat < y1 || lat > y2) continue;
    if (f.polys.some(p => inPoly(lng, lat, p)))
      return { tambon: f.tambon, amphoe: f.amphoe || amphoeOf(f.tambon) };
  }
  return null;
}

/* ตัดสินพื้นที่ของจุด: ถ้ามีเขตตำบลจะใช้ผลจากพิกัดเป็นหลัก ไม่งั้นใช้ค่าที่ผู้ใช้เลือก */
function resolveArea(b, lat, lng) {
  const out = { amphoe: norm(b.amphoe) || null, tambon: norm(b.tambon) || null,
    moo: String(b.moo || '').trim() || null, source: null, warning: null };
  const hit = locate(lat, lng);
  if (hit) {
    if (out.tambon && out.tambon !== hit.tambon)
      out.warning = `พิกัดอยู่ในตำบล${hit.tambon} ต่างจากที่เลือก (${out.tambon}) ระบบใช้ตำบลตามพิกัด`;
    out.amphoe = hit.amphoe; out.tambon = hit.tambon; out.source = 'boundary';
  } else if (out.amphoe || out.tambon) {
    if (out.amphoe && !ADMIN[out.amphoe]) return { error: `ไม่พบอำเภอ${out.amphoe} ในจังหวัดนครปฐม` };
    if (!out.amphoe) out.amphoe = amphoeOf(out.tambon);
    if (out.tambon && !(ADMIN[out.amphoe] || []).includes(out.tambon))
      return { error: `ตำบล${out.tambon} ไม่อยู่ในอำเภอ${out.amphoe || 'ที่ระบุ'}` };
    out.source = 'manual';
  }
  if (!inBounds(lat, lng)) out.warning = 'พิกัดอยู่นอกกรอบจังหวัดนครปฐม โปรดตรวจสอบตำแหน่ง';
  return out;
}

/* ---------- เพิ่มคอลัมน์ใหม่ให้ตาราง points (ปลอดภัย รันซ้ำได้) ---------- */
function migrate(db) {
  const have = db.prepare('PRAGMA table_info(points)').all().map(c => c.name);
  for (const [col, type] of [['amphoe', 'TEXT'], ['tambon', 'TEXT'], ['moo', 'TEXT'],
    ['accuracy', 'REAL'], ['area_source', 'TEXT']])
    if (!have.includes(col)) db.exec(`ALTER TABLE points ADD COLUMN ${col} ${type}`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_points_area ON points(amphoe, tambon);
           CREATE INDEX IF NOT EXISTS idx_points_geo ON points(lat, lng);`);
}

/* ---------- เส้นทาง API ใหม่ ---------- */
function mount({ app, db, io, auth, approved, adminOnly, shape, pointRow, writeAudit }) {
  // ตรวจสถานะไฟล์เขตตำบล (แอดมิน) — เปิดใน browser: /api/geo/status
  app.get('/api/geo/status', auth, adminOnly, (_, res) => { load(); res.json(STATUS); });

  // รายชื่ออำเภอ→ตำบล สำหรับ dropdown
  app.get('/api/geo/admin', auth, approved, (_, res) => res.json(ADMIN));

  // ไฟล์เขตตำบล (ต้องล็อกอิน)
  app.get('/api/geo/boundaries', auth, approved, (_, res) => {
    if (!fs.existsSync(GEOJSON)) return res.status(404).json({ error: 'ยังไม่มีไฟล์เขตตำบลบนเซิร์ฟเวอร์' });
    res.set('Cache-Control', 'private, max-age=86400').type('application/geo+json').sendFile(GEOJSON);
  });

  // พิกัด -> อำเภอ/ตำบล (ใช้ตอนผู้ใช้ปักหมุด/ลากหมุด)
  app.get('/api/geo/locate', auth, approved, (req, res) => {
    const lat = parseFloat(req.query.lat), lng = parseFloat(req.query.lng);
    if (Number.isNaN(lat) || Number.isNaN(lng)) return res.status(400).json({ error: 'พิกัดไม่ถูกต้อง' });
    const hit = locate(lat, lng);
    res.json({ ...(hit || { amphoe: null, tambon: null }), inProvince: inBounds(lat, lng),
      reason: hit ? null : (load().length ? 'outside' : 'no_boundary') });
  });

  // จุดแบบรวมกลุ่มตามระดับซูม (ซูมออก = กลุ่มใหญ่ ซูมเข้า = จุดจริง)
  // GET /api/points/clusters?zoom=11&bbox=minLng,minLat,maxLng,maxLat
  app.get('/api/points/clusters', auth, approved, (req, res) => {
    const zoom = Math.max(0, Math.min(18, parseInt(req.query.zoom, 10) || 10));
    const w = ["status='approved' AND deleted_at IS NULL"], a = [];
    const bb = String(req.query.bbox || '').split(',').map(Number);
    if (bb.length === 4 && bb.every(Number.isFinite)) {
      w.push('lng BETWEEN ? AND ? AND lat BETWEEN ? AND ?'); a.push(bb[0], bb[2], bb[1], bb[3]);
    }
    if (zoom >= 16) return res.json({ mode: 'points', zoom, items: db.prepare(
      `SELECT id,lat,lng,case_name caseName,case_type caseType,amphoe,tambon FROM points
       WHERE ${w.join(' AND ')} LIMIT 2000`).all(...a) });
    const step = 45 / 2 ** zoom;                       // ขนาดช่องกริด (องศา)
    const rows = db.prepare(`SELECT COUNT(*) n, AVG(lat) lat, AVG(lng) lng, MIN(id) id,
        MIN(case_name) caseName FROM points WHERE ${w.join(' AND ')}
        GROUP BY CAST(lat/${step} AS INTEGER), CAST(lng/${step} AS INTEGER)`).all(...a);
    res.json({ mode: 'clusters', zoom, items: rows });
  });

  // สถิติรายอำเภอ/ตำบล แยกตามลักษณะเคส (แอดมินเลือก status ได้)
  app.get('/api/stats/area', auth, approved, (req, res) => {
    const st = req.user.role === 'admin' && ['approved', 'pending', 'rejected'].includes(req.query.status)
      ? req.query.status : 'approved';
    const rows = db.prepare(`SELECT COALESCE(amphoe,'ไม่ระบุ') amphoe, COALESCE(tambon,'ไม่ระบุ') tambon,
      case_type, COUNT(*) c FROM points WHERE status=? AND deleted_at IS NULL GROUP BY 1,2,3`).all(st);
    const out = {};
    for (const r of rows) {
      const a = out[r.amphoe] ||= { total: 0, tambons: {} };
      const t = a.tambons[r.tambon] ||= { total: 0, types: {} };
      a.total += r.c; t.total += r.c; t.types[r.case_type] = (t.types[r.case_type] || 0) + r.c;
    }
    res.json({ status: st, amphoes: out });
  });

  // ย้ายหมุด/แก้พื้นที่ (เจ้าของแก้ได้เฉพาะจุดที่ยังรออนุมัติ, แอดมินแก้ได้ทุกจุด)
  app.put('/api/points/:id/location', auth, approved, (req, res) => {
    const id = Number(req.params.id);
    const p = db.prepare('SELECT * FROM points WHERE id=? AND deleted_at IS NULL').get(id);
    if (!p) return res.status(404).json({ error: 'ไม่พบพิกัดนี้' });
    const admin = req.user.role === 'admin';
    if (!admin && !(p.user_id === req.user.id && p.status === 'pending'))
      return res.status(403).json({ error: 'แก้ไขได้เฉพาะจุดของตนเองที่ยังรออนุมัติ' });
    const b = req.body || {};
    const lat = b.lat === undefined ? p.lat : parseFloat(b.lat);
    const lng = b.lng === undefined ? p.lng : parseFloat(b.lng);
    if (Number.isNaN(lat) || Number.isNaN(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180)
      return res.status(400).json({ error: 'พิกัดไม่ถูกต้อง' });
    const area = resolveArea({ amphoe: b.amphoe ?? (b.lat === undefined ? p.amphoe : ''),
      tambon: b.tambon ?? (b.lat === undefined ? p.tambon : ''), moo: b.moo ?? p.moo }, lat, lng);
    if (area.error) return res.status(400).json({ error: area.error });
    db.prepare(`UPDATE points SET lat=?,lng=?,amphoe=?,tambon=?,moo=?,area_source=? WHERE id=?`)
      .run(lat, lng, area.amphoe, area.tambon, area.moo, area.source, id);
    const point = shape(db.prepare(`${pointRow} WHERE p.id=?`).get(id));
    // ไม่ broadcast ข้อมูลเต็ม (มีข้อมูลส่วนบุคคล) — ส่งเฉพาะเจ้าของ + hint ให้ client ดึงใหม่เอง
    io.to('user:' + point.reporterId).emit('point:mine', point);
    if (point.status === 'approved') io.emit('point:update-hint', { id });
    else io.to('admins').emit('point:update-hint', { id });
    if (writeAudit) writeAudit(req.user.id, admin ? 'ADMIN_UPDATE_POINT_LOCATION' : 'UPDATE_POINT_LOCATION', 'POINT', id, req);
    res.json({ ok: true, point, warning: area.warning });
  });

  // เติมอำเภอ/ตำบลให้จุดเก่าที่ยังไม่มี (รันครั้งเดียวหลังวางไฟล์เขตตำบล)
  app.post('/api/admin/geo/backfill', auth, adminOnly, (_, res) => {
    const rows = db.prepare('SELECT id,lat,lng FROM points WHERE tambon IS NULL').all();
    const up = db.prepare('UPDATE points SET amphoe=?,tambon=?,area_source=? WHERE id=?');
    let filled = 0;
    db.transaction(() => rows.forEach(r => {
      const h = locate(r.lat, r.lng); if (h) { up.run(h.amphoe, h.tambon, 'boundary', r.id); filled++; }
    }))();
    res.json({ ok: true, checked: rows.length, filled });
  });
}

module.exports = { mount, migrate, resolveArea, locate, ADMIN };
