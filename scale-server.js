'use strict';
/* scale-server.js — เตรียม SQLite ให้รับข้อมูลระดับแสน–ล้านแถว (mount จาก server.js) */
module.exports = function mount({ db, log }) {
  const t0 = Date.now();
  const run = sql => { try { db.exec(sql); } catch (e) { log('warn', 'scale: ' + e.message, { sql }); } };

  db.pragma('cache_size = -65536');        // แคช ~64 MB
  db.pragma('mmap_size = 268435456');      // memory-map 256 MB
  db.pragma('temp_store = MEMORY');

  // covering index สำหรับ: cluster/แผนที่, รายการแบ่งหน้า, สถิติรายพื้นที่, เคสของฉัน
  run('CREATE INDEX IF NOT EXISTS idx_points_map   ON points(status, deleted_at, lat, lng)');
  run('CREATE INDEX IF NOT EXISTS idx_points_list  ON points(deleted_at, status, id)');
  run('CREATE INDEX IF NOT EXISTS idx_points_stats ON points(status, deleted_at, amphoe, tambon, case_type)');
  run('CREATE INDEX IF NOT EXISTS idx_points_mine  ON points(user_id, status, id)');

  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='sqlite_stat1'").get()) db.exec('ANALYZE');
    db.pragma('optimize');
  } catch (e) { log('warn', 'scale analyze: ' + e.message); }
  setInterval(() => { try { db.pragma('optimize'); } catch {} }, 6 * 3600e3).unref();

  log('info', 'scale-server พร้อม (index + pragma)', { ms: Date.now() - t0 });
};
