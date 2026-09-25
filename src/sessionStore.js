/**
 * Session storage — chọn backend tự động:
 *   - Có DATABASE_URL -> bảng sessions trong Postgres (free tier không có disk)
 *   - Không           -> file data/sessions/<ownId>.json (local / có disk)
 *
 * Mọi hàm đều async để interface thống nhất.
 */
const USE_PG = !!process.env.DATABASE_URL;
const store = require('./store');

const fileStore = USE_PG ? null : require('./fileSessionStore');

async function saveAccountSession(ownId, session) {
  if (USE_PG) return store.saveSession(ownId, session);
  return fileStore.saveAccountSession(ownId, session);
}

async function loadAccountSession(ownId) {
  if (USE_PG) return store.loadSession(ownId);
  return fileStore.loadAccountSession(ownId);
}

async function loadAccountSessions() {
  if (USE_PG) return store.loadAllSessions();
  return fileStore.loadAccountSessions();
}

async function deleteAccountSession(ownId) {
  if (USE_PG) return store.deleteSession(ownId);
  return fileStore.deleteAccountSession(ownId);
}

module.exports = { USE_PG, saveAccountSession, loadAccountSession, loadAccountSessions, deleteAccountSession };
