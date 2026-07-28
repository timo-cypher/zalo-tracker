const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || './data/messages.db';

// Đảm bảo thư mục chứa file DB tồn tại
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    direction TEXT NOT NULL,       -- 'in' (khách nhắn đến) | 'out' (mình nhắn đi)
    user_id TEXT NOT NULL,         -- Zalo user_id của khách
    user_name TEXT,                -- tên hiển thị (nếu Zalo trả về)
    phone TEXT,                    -- số điện thoại (nếu lấy được)
    content TEXT,                  -- nội dung tin nhắn (text)
    msg_type TEXT,                 -- text | image | sticker | ...
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
  CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id);
`);

/**
 * Ghi lại một tin nhắn (đến hoặc đi).
 */
function logMessage({ direction, userId, userName, phone, content, msgType = 'text' }) {
  const stmt = db.prepare(`
    INSERT INTO messages (direction, user_id, user_name, phone, content, msg_type)
    VALUES (@direction, @userId, @userName, @phone, @content, @msgType)
  `);
  const result = stmt.run({ direction, userId, userName: userName || null, phone: phone || null, content: content || '', msgType });
  return Number(result.lastInsertRowid); // trả về ID để sau này xoá nếu cần
}

/**
 * Xoá một tin nhắn theo ID.
 */
function deleteMessage(id) {
  db.prepare('DELETE FROM messages WHERE id = ?').run(id);
}

/**
 * Lấy toàn bộ tin nhắn trong khoảng thời gian [sinceISO, untilISO).
 * Mặc định: 24h gần nhất.
 */
function getMessagesSince(sinceISO) {
  const stmt = db.prepare(`
    SELECT * FROM messages
    WHERE created_at >= ?
    ORDER BY created_at ASC
  `);
  return stmt.all(sinceISO);
}

module.exports = { db, logMessage, deleteMessage, getMessagesSince };
