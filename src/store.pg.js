/**
 * Postgres store — dùng khi deploy (Render free không có persistent disk).
 * Cùng interface (async) với src/store.js (SQLite) — chọn tự động:
 *   - Có DATABASE_URL  -> Postgres (Supabase/Neon/...)
 *   - Không            -> SQLite (chạy local / máy có disk)
 *
 * Schema giống hệt SQLite + bảng sessions (lưu Zalo sessions vào DB thay
 * cho file data/sessions/<ownId>.json — free tier không có disk).
 */
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: /supabase|neon|amazonaws/.test(process.env.DATABASE_URL || '')
    ? { rejectUnauthorized: false }
    : undefined,
  max: 5,
});

// ============================================================
// Schema
// ============================================================
async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      id            TEXT PRIMARY KEY,
      name          TEXT,
      avatar        TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at  TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS threads (
      id                TEXT PRIMARY KEY,
      account_id        TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      thread_id         TEXT NOT NULL,
      thread_type       INTEGER NOT NULL,
      name              TEXT,
      phone             TEXT,
      avatar            TEXT,
      last_msg_preview  TEXT,
      last_msg_at       TIMESTAMPTZ,
      is_tracked        INTEGER NOT NULL DEFAULT 1,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at        TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_threads_account ON threads(account_id, is_tracked);
    CREATE INDEX IF NOT EXISTS idx_threads_last_msg ON threads(last_msg_at);

    CREATE TABLE IF NOT EXISTS messages (
      id           BIGSERIAL PRIMARY KEY,
      account_id   TEXT NOT NULL,
      thread_key   TEXT NOT NULL,
      msg_id       TEXT,
      direction    TEXT NOT NULL,
      sender_id    TEXT,
      sender_name  TEXT,
      content      TEXT,
      msg_type     TEXT,
      media_url    TEXT,
      created_at   TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_key, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_msg_id ON messages(account_id, msg_id)
      WHERE msg_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS removed_threads (
      id           TEXT PRIMARY KEY,
      account_id   TEXT NOT NULL,
      thread_id    TEXT NOT NULL,
      thread_type  INTEGER NOT NULL,
      name         TEXT,
      removed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS sessions (
      own_id      TEXT PRIMARY KEY,
      data        JSONB NOT NULL,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

// Helpers: chuyển snake_case rows -> camelCase fields mà app đang dùng
function rowToAccount(r) {
  if (!r) return null;
  return { id: r.id, name: r.name, avatar: r.avatar, created_at: r.created_at, last_seen_at: r.last_seen_at };
}

function rowToThread(r) {
  if (!r) return null;
  return {
    id: r.id,
    account_id: r.account_id,
    thread_id: r.thread_id,
    thread_type: r.thread_type,
    name: r.name,
    phone: r.phone,
    avatar: r.avatar,
    last_msg_preview: r.last_msg_preview,
    last_msg_at: r.last_msg_at,
    is_tracked: r.is_tracked,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function rowToMessage(r) {
  if (!r) return null;
  return {
    id: Number(r.id),
    account_id: r.account_id,
    thread_key: r.thread_key,
    msg_id: r.msg_id,
    direction: r.direction,
    sender_id: r.sender_id,
    sender_name: r.sender_name,
    content: r.content,
    msg_type: r.msg_type,
    media_url: r.media_url,
    created_at: r.created_at,
  };
}

// ============================================================
// Sessions (thay sessionStore.js khi dùng Postgres)
// ============================================================
async function saveSession(ownId, session) {
  await pool.query(
    `INSERT INTO sessions (own_id, data, updated_at) VALUES ($1, $2, now())
     ON CONFLICT(own_id) DO UPDATE SET data = $2, updated_at = now()`,
    [ownId, JSON.stringify(session)]
  );
}

async function loadSession(ownId) {
  const { rows } = await pool.query('SELECT data FROM sessions WHERE own_id = $1', [ownId]);
  if (!rows.length) return null;
  try { return rows[0].data; } catch { return null; }
}

async function loadAllSessions() {
  const { rows } = await pool.query('SELECT own_id, data FROM sessions');
  const out = {};
  for (const r of rows) {
    try { out[r.own_id] = typeof r.data === 'string' ? JSON.parse(r.data) : r.data; } catch {}
  }
  return out;
}

async function deleteSession(ownId) {
  await pool.query('DELETE FROM sessions WHERE own_id = $1', [ownId]);
}

// ============================================================
// Accounts
// ============================================================
async function upsertAccount({ id, name, avatar }) {
  await pool.query(
    `INSERT INTO accounts (id, name, avatar, last_seen_at) VALUES ($1, $2, $3, now())
     ON CONFLICT(id) DO UPDATE SET
       name = COALESCE($2, accounts.name),
       avatar = COALESCE($3, accounts.avatar),
       last_seen_at = now()`,
    [id, name || null, avatar || null]
  );
}

async function getAccounts() {
  const { rows } = await pool.query('SELECT * FROM accounts ORDER BY created_at ASC');
  return rows.map(rowToAccount);
}

/**
 * Xoá account + toàn bộ dữ liệu. Trả về danh sách media_url (r2://...) để
 * caller xóa nốt object trên R2 (nếu không sẽ thành rác mồ côi).
 */
async function removeAccount(id) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: mediaRows } = await client.query(
      "SELECT media_url FROM messages WHERE account_id = $1 AND media_url LIKE 'r2://%'",
      [id]
    );
    const { rows } = await client.query('SELECT id FROM threads WHERE account_id = $1', [id]);
    for (const t of rows) {
      await client.query('DELETE FROM messages WHERE thread_key = $1', [t.id]);
    }
    await client.query('DELETE FROM messages WHERE account_id = $1', [id]);
    await client.query('DELETE FROM removed_threads WHERE account_id = $1', [id]);
    await client.query('DELETE FROM sessions WHERE own_id = $1', [id]);
    await client.query('DELETE FROM accounts WHERE id = $1', [id]); // cascade threads
    await client.query('COMMIT');
    return mediaRows.map((r) => r.media_url).filter(Boolean);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ============================================================
// Threads
// ============================================================
async function upsertThread({ accountId, threadId, threadType, name, avatar, phone }) {
  const key = `${accountId}:${threadId}:${threadType}`;
  // phone === '' nghĩa là "đã thử lấy nhưng ẩn SĐT" — giữ chuỗi rỗng
  const phoneVal = phone === '' ? '' : phone || null;
  await pool.query(
    `INSERT INTO threads (id, account_id, thread_id, thread_type, name, avatar, phone, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT(id) DO UPDATE SET
       name = COALESCE($5, threads.name),
       avatar = COALESCE($6, threads.avatar),
       phone = COALESCE($7, threads.phone),
       updated_at = now()`,
    [key, accountId, threadId, threadType, name || null, avatar || null, phoneVal]
  );
  return key;
}

async function setThreadPhone(threadKey, phone) {
  if (!phone) return;
  await pool.query('UPDATE threads SET phone = $2 WHERE id = $1', [threadKey, phone]);
}

async function setThreadTracking(threadKey, tracked) {
  await pool.query('UPDATE threads SET is_tracked = $2 WHERE id = $1', [threadKey, tracked ? 1 : 0]);
}

/**
 * Gỡ vĩnh viễn thread. Trả về danh sách media_url (r2://...) đã thu thập
 * TRƯỚC khi xoá rows — caller dùng để xóa object trên R2.
 */
async function removeThreadPermanently(threadKey) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: mediaRows } = await client.query(
      "SELECT media_url FROM messages WHERE thread_key = $1 AND media_url LIKE 'r2://%'",
      [threadKey]
    );
    const { rows } = await client.query('SELECT * FROM threads WHERE id = $1', [threadKey]);
    await client.query('DELETE FROM messages WHERE thread_key = $1', [threadKey]);
    await client.query('DELETE FROM threads WHERE id = $1', [threadKey]);

    let row = rows[0] || null;
    if (!row) {
      // Thread chưa có trong DB — parse key (accountId:threadId:threadType)
      const i1 = threadKey.indexOf(':');
      const i2 = threadKey.lastIndexOf(':');
      if (i1 > 0 && i2 > i1) {
        row = {
          account_id: threadKey.slice(0, i1),
          thread_id: threadKey.slice(i1 + 1, i2),
          thread_type: Number(threadKey.slice(i2 + 1)) || 0,
          name: null,
        };
      }
    }
    if (row) {
      await client.query(
        `INSERT INTO removed_threads (id, account_id, thread_id, thread_type, name, removed_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT(id) DO UPDATE SET removed_at = now()`,
        [threadKey, row.account_id, row.thread_id, row.thread_type, row.name]
      );
    }
    await client.query('COMMIT');
    return mediaRows.map((r) => r.media_url).filter(Boolean);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function unremoveThread(threadKey) {
  await pool.query('DELETE FROM removed_threads WHERE id = $1', [threadKey]);
}

async function isThreadRemoved(accountId, threadId, threadType) {
  const key = `${accountId}:${threadId}:${threadType}`;
  const { rowCount } = await pool.query('SELECT 1 FROM removed_threads WHERE id = $1', [key]);
  return rowCount > 0;
}

async function getRemovedThreads(accountId) {
  const { rows } = await pool.query(
    'SELECT * FROM removed_threads WHERE account_id = $1 ORDER BY removed_at DESC',
    [accountId]
  );
  return rows;
}

async function getTrackedThreads(accountId) {
  const { rows } = await pool.query(
    'SELECT * FROM threads WHERE account_id = $1 AND is_tracked = 1 ORDER BY last_msg_at DESC NULLS LAST',
    [accountId]
  );
  return rows.map(rowToThread);
}

async function getAllThreads(accountId) {
  const { rows } = await pool.query(
    'SELECT * FROM threads WHERE account_id = $1 ORDER BY last_msg_at DESC NULLS LAST',
    [accountId]
  );
  return rows.map(rowToThread);
}

async function getThreadByKey(threadKey) {
  const { rows } = await pool.query('SELECT * FROM threads WHERE id = $1', [threadKey]);
  return rowToThread(rows[0]);
}

async function isThreadTracked(accountId, threadId, threadType) {
  if (await isThreadRemoved(accountId, threadId, threadType)) return false;
  const key = `${accountId}:${threadId}:${threadType}`;
  const { rows } = await pool.query('SELECT is_tracked FROM threads WHERE id = $1', [key]);
  return rows.length ? rows[0].is_tracked === 1 : true;
}

async function updateThreadPreview(threadKey, preview, atISO) {
  await pool.query(
    'UPDATE threads SET last_msg_preview = $2, last_msg_at = $3 WHERE id = $1',
    [threadKey, preview, atISO]
  );
}

// ============================================================
// Messages
// ============================================================
async function insertMessage(m) {
  // Dedup bằng UNIQUE index (account_id, msg_id) — null msg_id vẫn cho qua
  try {
    const { rows } = await pool.query(
      `INSERT INTO messages (account_id, thread_key, msg_id, direction, sender_id, sender_name, content, msg_type, media_url, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [m.accountId, m.threadKey, m.msgId || null, m.direction, m.senderId || null,
       m.senderName || null, m.content || '', m.msgType || 'text', m.mediaUrl || null, m.createdAt]
    );
    return Number(rows[0].id);
  } catch (err) {
    if (err.code === '23505') return null; // duplicate msg_id
    throw err;
  }
}

async function getMessages(threadKey, { before, limit = 50 } = {}) {
  const params = [threadKey, Math.min(limit, 200)];
  let where = 'thread_key = $1';
  if (before) {
    where += ' AND id < $3';
    params.push(before);
  }
  const { rows } = await pool.query(
    `SELECT * FROM messages WHERE ${where} ORDER BY id DESC LIMIT $2`,
    params
  );
  return rows.map(rowToMessage).reverse();
}

async function countMessages(threadKey) {
  const { rows } = await pool.query('SELECT COUNT(*) c FROM messages WHERE thread_key = $1', [threadKey]);
  return Number(rows[0].c);
}

async function deleteThreadMessages(threadKey) {
  await pool.query('DELETE FROM messages WHERE thread_key = $1', [threadKey]);
}

module.exports = {
  isPostgres: true,
  init,
  pool,
  // sessions
  saveSession,
  loadSession,
  loadAllSessions,
  deleteSession,
  // accounts
  upsertAccount,
  getAccounts,
  removeAccount,
  // threads
  upsertThread,
  setThreadPhone,
  setThreadTracking,
  removeThreadPermanently,
  unremoveThread,
  isThreadRemoved,
  getRemovedThreads,
  getTrackedThreads,
  getAllThreads,
  getThreadByKey,
  isThreadTracked,
  updateThreadPreview,
  // messages
  insertMessage,
  getMessages,
  countMessages,
  deleteThreadMessages,
};
