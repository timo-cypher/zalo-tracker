/**
 * Store facade — chọn backend tự động:
 *   - Có DATABASE_URL  -> Postgres (src/store.pg.js) — deploy free tier (Render free không có disk)
 *   - Không            -> SQLite (src/store.sqlite.js) — local / máy có disk
 *
 * Interface ĐỒNG NHẤT (async) cho cả hai — mọi caller dùng await store.xxx().
 */
const USE_PG = !!process.env.DATABASE_URL;

const backend = USE_PG
  ? require('./store.pg')
  : require('./store.sqlite');

function makeApi(mod, isPg) {
  const out = { isPostgres: isPg, USE_PG };
  for (const key of Object.keys(mod)) {
    const v = mod[key];
    if (typeof v === 'function') {
      out[key] = async (...args) => v(...args);
    } else {
      out[key] = v; // db (SQLite) / pool (PG)
    }
  }
  if (!isPg) {
    // SQLite: mọi hàm vốn đồng bộ — đã bọc promise ở trên.
    // init() không cần (schema tạo lúc require).
    out.init = async () => {};
  }
  return out;
}

module.exports = makeApi(backend, USE_PG);
