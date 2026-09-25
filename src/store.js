const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || './data/messages.db';

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON'); // mặc định SQLite TẮT FK — không bật thì ON DELETE CASCADE không chạy

// ============================================================
// Schema
// ============================================================
db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id            TEXT PRIMARY KEY,             -- zalo ownId
    name          TEXT,
    avatar        TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at  TEXT
  );

  CREATE TABLE IF NOT EXISTS threads (
    id           TEXT PRIMARY KEY,              -- accountId:threadId:threadType
    account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    thread_id    TEXT NOT NULL,                 -- partner user id or group id
    thread_type  INTEGER NOT NULL,              -- 0 = User, 1 = Group (zca-js ThreadType)
    name         TEXT,
    phone        TEXT,                          -- số điện thoại (người dùng thường, nếu lấy được)
    avatar       TEXT,
    last_msg_preview  TEXT,
    last_msg_at       TEXT,
    is_tracked   INTEGER NOT NULL DEFAULT 1,    -- 0 = ngừng lưu tin nhắn mới (ẩn khỏi UI)
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_threads_account ON threads(account_id, is_tracked);
  CREATE INDEX IF NOT EXISTS idx_threads_last_msg ON threads(last_msg_at);

  CREATE TABLE IF NOT EXISTS removed_threads (
    id           TEXT PRIMARY KEY,              -- accountId:threadId:threadType
    account_id   TEXT NOT NULL,
    thread_id    TEXT NOT NULL,
    thread_type  INTEGER NOT NULL,
    name         TEXT,
    removed_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Migration nhẹ: thêm cột phone cho DB đã tạo từ phiên bản v2.0 đầu
function ensurePhoneColumn() {
  const cols = db.prepare('PRAGMA table_info(threads)').all().map((c) => c.name);
  if (!cols.includes('phone')) {
    db.exec('ALTER TABLE threads ADD COLUMN phone TEXT');
    console.log('[migrate] Đã thêm cột phone vào bảng threads.');
  }
  if (!cols.includes('is_tracked')) {
    db.exec('ALTER TABLE threads ADD COLUMN is_tracked INTEGER NOT NULL DEFAULT 1');
  }
  const hasRemoved = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='removed_threads'")
    .get();
  if (!hasRemoved) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS removed_threads (
        id           TEXT PRIMARY KEY,
        account_id   TEXT NOT NULL,
        thread_id    TEXT NOT NULL,
        thread_type  INTEGER NOT NULL,
        name         TEXT,
        removed_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }
}

ensurePhoneColumn();

// ============================================================
// One-time migration from the legacy single-account schema
// (old table `messages` with columns user_id/user_name/phone/...)
// ============================================================
function migrateLegacy() {
  const hasLegacy = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'")
    .get();
  if (!hasLegacy) return false;

  const cols = db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
  // New-schema messages table has thread_key; legacy does not
  return !cols.includes('thread_key');
}

if (migrateLegacy()) {
  console.log('[migrate] Phát hiện DB cũ (bản bridge) — chuyển sang schema đa tài khoản...');

  const legacyRows = db.prepare('SELECT * FROM messages').all();
  const MIGRATED_ACCOUNT_ID = 'legacy';

  db.exec('DROP TABLE messages');
  db.exec(`
    CREATE TABLE messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id  TEXT NOT NULL,
      thread_key  TEXT NOT NULL,
      msg_id      TEXT,                           -- zalo msgId (dedup)
      direction   TEXT NOT NULL,                  -- 'in' | 'out'
      sender_id   TEXT,                           -- who actually sent it
      sender_name TEXT,
      content     TEXT,                           -- text or media description
      msg_type    TEXT,                           -- text | photo | video | sticker | other
      media_url   TEXT,
      created_at  TEXT NOT NULL
    );
    CREATE INDEX idx_messages_thread ON messages(thread_key, created_at);
    CREATE INDEX idx_messages_msg_id ON messages(msg_id);
  `);

  db.transaction(() => {
    db.prepare(
      `INSERT OR IGNORE INTO accounts (id, name, avatar) VALUES (?, ?, ?)`
    ).run(MIGRATED_ACCOUNT_ID, 'Tài khoản cũ (trước khi nâng cấp)', null);

    const insertThread = db.prepare(`
      INSERT OR IGNORE INTO threads (id, account_id, thread_id, thread_type, name, avatar, is_tracked)
      VALUES (?, ?, ?, 0, ?, NULL, 1)
    `);
    const insertMsg = db.prepare(`
      INSERT INTO messages (account_id, thread_key, msg_id, direction, sender_id, sender_name, content, msg_type, media_url, created_at)
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, NULL, ?)
    `);

    for (const m of legacyRows) {
      // Legacy rows had no account info: bucket them under a pseudo-account
      const threadKey = `${MIGRATED_ACCOUNT_ID}:${m.user_id}:0`;
      insertThread.run(threadKey, MIGRATED_ACCOUNT_ID, m.user_id, m.user_name || m.user_id);
      // Legacy datetime('now') là UTC không có timezone -> chuẩn hoá sang ISO
      let createdAt = m.created_at;
      if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(createdAt)) {
        createdAt = createdAt.replace(' ', 'T') + 'Z';
      }
      insertMsg.run(
        MIGRATED_ACCOUNT_ID,
        threadKey,
        m.direction,
        m.direction === 'in' ? m.user_id : MIGRATED_ACCOUNT_ID,
        m.direction === 'in' ? m.user_name || m.user_id : null,
        m.content,
        m.msg_type || 'text',
        createdAt
      );
    }
  })();

  console.log(`[migrate] Đã chuyển ${legacyRows.length} tin nhắn cũ xong.`);
} else {
  // DB mới hoặc đã migrate — đảm bảo bảng + index tồn tại
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id  TEXT NOT NULL,
      thread_key  TEXT NOT NULL,
      msg_id      TEXT,
      direction   TEXT NOT NULL,
      sender_id   TEXT,
      sender_name TEXT,
      content     TEXT,
      msg_type    TEXT,
      media_url   TEXT,
      created_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_key, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_msg_id ON messages(msg_id);
  `);
}

// ============================================================
// Accounts
// ============================================================
const upsertAccountStmt = db.prepare(`
  INSERT INTO accounts (id, name, avatar, last_seen_at)
  VALUES (@id, @name, @avatar, datetime('now'))
  ON CONFLICT(id) DO UPDATE SET
    name = COALESCE(excluded.name, accounts.name),
    avatar = COALESCE(excluded.avatar, accounts.avatar),
    last_seen_at = excluded.last_seen_at
`);

function upsertAccount({ id, name, avatar }) {
  upsertAccountStmt.run({ id, name: name || null, avatar: avatar || null });
}

function getAccounts() {
  return db.prepare(`SELECT * FROM accounts ORDER BY created_at ASC`).all();
}

function removeAccount(id) {
  // Bảng messages không có FK constraint nên phải xoá thủ công:
  // theo thread_key của account này (cascade qua threads không phủ messages)
  const threadKeys = db.prepare('SELECT id FROM threads WHERE account_id = ?').all(id).map((t) => t.id);
  db.transaction(() => {
    for (const key of threadKeys) {
      db.prepare('DELETE FROM messages WHERE thread_key = ?').run(key);
    }
    db.prepare('DELETE FROM messages WHERE account_id = ?').run(id); // phòng messages mồ côi
    db.prepare('DELETE FROM removed_threads WHERE account_id = ?').run(id);
    db.prepare('DELETE FROM accounts WHERE id = ?').run(id); // cascade xoá threads
  })();
}

// ============================================================
// Threads
// ============================================================
function upsertThread({ accountId, threadId, threadType, name, avatar, phone }) {
  const key = `${accountId}:${threadId}:${threadType}`;
  // ⚠️ phone: '' = "đã thử lấy nhưng người này ẩn SĐT" — phải giữ nguyên chuỗi
  // rỗng (không đổi thành null) để không bao giờ gọi API lấy phone lại.
  const phoneVal = phone === '' ? '' : phone || null;
  db.prepare(`
    INSERT INTO threads (id, account_id, thread_id, thread_type, name, avatar, phone, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      name = COALESCE(excluded.name, threads.name),
      avatar = COALESCE(excluded.avatar, threads.avatar),
      phone = COALESCE(excluded.phone, threads.phone),
      updated_at = excluded.updated_at
  `).run(key, accountId, threadId, threadType, name || null, avatar || null, phoneVal);
  return key;
}

function setThreadPhone(threadKey, phone) {
  if (!phone) return;
  db.prepare('UPDATE threads SET phone = ? WHERE id = ?').run(phone, threadKey);
}

/**
 * Bỏ theo dõi: ngừng lưu tin nhắn mới, giữ lại dữ liệu cũ, có thể theo dõi lại.
 */
function setThreadTracking(threadKey, tracked) {
  db.prepare('UPDATE threads SET is_tracked = ? WHERE id = ?').run(tracked ? 1 : 0, threadKey);
}

// ============================================================
// Removed threads (blacklist vĩnh viễn — sống độc lập với bảng threads)
// ============================================================

/**
 * Gỡ vĩnh viễn: xoá thread + dữ liệu, và ghi nhớ vào blacklist để thread
 * này KHÔNG bao giờ tự xuất hiện lại dù có tin nhắn mới.
 */
function removeThreadPermanently(threadKey) {
  const thread = getThreadByKey(threadKey);
  db.prepare('DELETE FROM messages WHERE thread_key = ?').run(threadKey);
  db.prepare('DELETE FROM threads WHERE id = ?').run(threadKey);
  if (thread) {
    db.prepare(`
      INSERT OR REPLACE INTO removed_threads (id, account_id, thread_id, thread_type, name, removed_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `).run(threadKey, thread.account_id, thread.thread_id, thread.thread_type, thread.name);
  } else {
    // Thread chưa có trong DB — parse key (accountId:threadId:threadType)
    const idx1 = threadKey.indexOf(':');
    const idx2 = threadKey.lastIndexOf(':');
    if (idx1 > 0 && idx2 > idx1) {
      db.prepare(`
        INSERT OR REPLACE INTO removed_threads (id, account_id, thread_id, thread_type, name, removed_at)
        VALUES (?, ?, ?, ?, NULL, datetime('now'))
      `).run(
        threadKey,
        threadKey.slice(0, idx1),
        threadKey.slice(idx1 + 1, idx2),
        Number(threadKey.slice(idx2 + 1)) || 0
      );
    }
  }
}

/**
 * Cho phép thread bị gỡ vĩnh viễn quay lại (xuất hiện từ tin nhắn mới).
 */
function unremoveThread(threadKey) {
  db.prepare('DELETE FROM removed_threads WHERE id = ?').run(threadKey);
}

function isThreadRemoved(accountId, threadId, threadType) {
  const key = `${accountId}:${threadId}:${threadType}`;
  return !!db.prepare('SELECT 1 FROM removed_threads WHERE id = ?').get(key);
}

function getRemovedThreads(accountId) {
  return db.prepare(
    'SELECT * FROM removed_threads WHERE account_id = ? ORDER BY removed_at DESC'
  ).all(accountId);
}

function getTrackedThreads(accountId) {
  return db.prepare(
    'SELECT * FROM threads WHERE account_id = ? AND is_tracked = 1 ORDER BY last_msg_at DESC'
  ).all(accountId);
}

function getAllThreads(accountId) {
  return db.prepare(
    'SELECT * FROM threads WHERE account_id = ? ORDER BY last_msg_at DESC'
  ).all(accountId);
}

function getThreadByKey(threadKey) {
  return db.prepare('SELECT * FROM threads WHERE id = ?').get(threadKey);
}

function isThreadTracked(accountId, threadId, threadType) {
  // 1. Blacklist vĩnh viễn luôn thắng — kể cả khi thread row xuất hiện lại
  if (isThreadRemoved(accountId, threadId, threadType)) return false;

  const key = `${accountId}:${threadId}:${threadType}`;
  const row = db.prepare('SELECT is_tracked FROM threads WHERE id = ?').get(key);
  // Untracked = row tồn tại với is_tracked=0. Thread mới chưa biết mặc định được theo dõi.
  return row ? row.is_tracked === 1 : true;
}

function updateThreadPreview(threadKey, preview, atISO) {
  db.prepare(
    'UPDATE threads SET last_msg_preview = ?, last_msg_at = ? WHERE id = ?'
  ).run(preview, atISO, threadKey);
}

// ============================================================
// Messages
// ============================================================
const insertMsgStmt = db.prepare(`
  INSERT INTO messages (account_id, thread_key, msg_id, direction, sender_id, sender_name, content, msg_type, media_url, created_at)
  VALUES (@accountId, @threadKey, @msgId, @direction, @senderId, @senderName, @content, @msgType, @mediaUrl, @createdAt)
`);

function insertMessage(m) {
  // Dedup by zalo msgId (echo/retry can deliver the same message twice)
  if (m.msgId) {
    const exists = db
      .prepare('SELECT 1 FROM messages WHERE msg_id = ? AND account_id = ?')
      .get(m.msgId, m.accountId);
    if (exists) return null;
  }
  const result = insertMsgStmt.run({
    accountId: m.accountId,
    threadKey: m.threadKey,
    msgId: m.msgId || null,
    direction: m.direction,
    senderId: m.senderId || null,
    senderName: m.senderName || null,
    content: m.content || '',
    msgType: m.msgType || 'text',
    mediaUrl: m.mediaUrl || null,
    createdAt: m.createdAt,
  });
  return Number(result.lastInsertRowid);
}

function getMessages(threadKey, { before, limit = 50 } = {}) {
  const params = { threadKey, limit };
  let where = 'thread_key = @threadKey';
  if (before) {
    where += ' AND id < @before';
    params.before = before;
  }
  return db.prepare(`
    SELECT * FROM messages
    WHERE ${where}
    ORDER BY id DESC
    LIMIT @limit
  `).all(params).reverse();
}

function countMessages(threadKey) {
  return db.prepare('SELECT COUNT(*) AS c FROM messages WHERE thread_key = ?').get(threadKey).c;
}

/**
 * Xoá toàn bộ tin nhắn của một thread (khi bỏ theo dõi và muốn xoá dữ liệu cũ).
 */
function deleteThreadMessages(threadKey) {
  return db.prepare('DELETE FROM messages WHERE thread_key = ?').run(threadKey);
}

/**
 * Xoá hẳn thread (kèm tin nhắn) — dùng khi "gỡ khỏi hệ thống theo dõi".
 */
function deleteThread(threadKey) {
  db.prepare('DELETE FROM messages WHERE thread_key = ?').run(threadKey);
  db.prepare('DELETE FROM threads WHERE id = ?').run(threadKey);
}

module.exports = {
  db,
  upsertAccount,
  getAccounts,
  removeAccount,
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
  insertMessage,
  getMessages,
  countMessages,
  deleteThreadMessages,
  deleteThread,
};
