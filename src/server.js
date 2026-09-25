const crypto = require('crypto');
const express = require('express');
const path = require('path');
const { ThreadType } = require('zca-js');
const store = require('./store');
const events = require('./events');
const zaloManager = require('./zaloManager');
const { handleMessage, fetchThreadMeta } = require('./ingest');
const mediaStore = require('./mediaStore');

const app = express();
app.use(express.json());
app.set('trust proxy', true);

// ============================================================
// Basic Auth — bảo vệ toàn bộ web khi deploy công khai
//
// Cấu hình trong .env:
//   WEB_USER=zalo          (tên đăng nhập, mặc định 'zalo')
//   WEB_PASSWORD=matkhau   (BẮT BUỘC nếu muốn bật bảo vệ)
//
// Không đặt WEB_PASSWORD (hoặc để rỗng) -> web mở tự do như cũ.
// /health được miễn xác thực để uptime monitor hoạt động.
// ============================================================
function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    // So sánh giả để không lộ độ dài qua timing
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

const WEB_USER = process.env.WEB_USER || 'zalo';
const WEB_PASSWORD = process.env.WEB_PASSWORD || '';
const AUTH_ENABLED = WEB_PASSWORD.length > 0;

function basicAuth(req, res, next) {
  if (!AUTH_ENABLED) return next();

  const header = req.headers.authorization || '';
  if (header.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      const user = idx >= 0 ? decoded.slice(0, idx) : '';
      const pass = idx >= 0 ? decoded.slice(idx + 1) : '';
      if (timingSafeEqualStr(user, WEB_USER) && timingSafeEqualStr(pass, WEB_PASSWORD)) {
        return next();
      }
    } catch {
      /* header hỏng — rơi xuống 401 */
    }
  }

  res.setHeader('WWW-Authenticate', 'Basic realm="Zalo Archive", charset="UTF-8"');
  res.status(401);
  // API trả JSON, trang web trả text đơn giản (browser tự hiện hộp đăng nhập)
  if (req.path.startsWith('/api/')) {
    return res.json({ error: 'Cần đăng nhập' });
  }
  return res.send('Cần đăng nhập');
}

// /health miễn auth (uptime monitor) — đặt TRƯỚC middleware
app.get('/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

if (AUTH_ENABLED) {
  console.log(`[auth] Bảo mật web ĐANG BẬT (user: ${WEB_USER})`);
}
app.use(basicAuth);

// ============================================================
// Static web UI
// ============================================================
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR));

// ============================================================
// Auth — QR login flow (khởi tạo từ web)
// ============================================================
app.post('/api/auth/qr/start', async (_req, res) => {
  try {
    const result = await zaloManager.startQrLogin();
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/auth/qr/status', (_req, res) => {
  res.json(zaloManager.getQrStatus());
});

app.post('/api/auth/qr/cancel', (_req, res) => {
  res.json(zaloManager.cancelQrLogin());
});

// ============================================================
// Accounts
// ============================================================
app.get('/api/accounts', async (_req, res) => {
  try {
    const runtime = new Map(zaloManager.listAccounts().map((a) => [a.ownId, a]));
    const dbAccounts = await store.getAccounts();
    const merged = dbAccounts.map((a) => ({
      id: a.id,
      name: a.name,
      avatar: a.avatar,
      connected: runtime.get(a.id)?.connected || false,
    }));
    res.json(merged);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/accounts/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await zaloManager.removeAccountRuntime(id); // dừng listener + xoá session
    await store.removeAccount(id); // xoá account + threads + messages
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ============================================================
// Threads (chat heads)
// ============================================================
app.get('/api/threads', async (req, res) => {
  try {
  const { accountId, includeUntracked } = req.query;
  if (!accountId) return res.status(400).json({ error: 'accountId là bắt buộc' });

  const rows = includeUntracked === '1'
    ? await store.getAllThreads(accountId)
    : await store.getTrackedThreads(accountId);

  const threads = rows.map((t) => ({
    key: t.id,
    threadId: t.thread_id,
    isGroup: t.thread_type === ThreadType.Group,
    name: t.name,
    phone: t.phone || null,
    avatar: t.avatar,
    lastMsgPreview: t.last_msg_preview,
    lastMsgAt: t.last_msg_at,
    isTracked: t.is_tracked === 1,
  }));
  res.json(threads);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Danh sách thread đã bị gỡ vĩnh viễn (blacklist) — để UI có thể hoàn tác
app.get('/api/threads/removed', async (req, res) => {
  try {
  const { accountId } = req.query;
  if (!accountId) return res.status(400).json({ error: 'accountId là bắt buộc' });
  const rows = await store.getRemovedThreads(accountId);
  res.json(rows.map((t) => ({
    key: t.id,
    threadId: t.thread_id,
    isGroup: t.thread_type === ThreadType.Group,
    name: t.name || t.thread_id,
    removedAt: t.removed_at,
  })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cho phép thread bị gỡ vĩnh viễn quay lại (khi có tin nhắn mới)
app.post('/api/threads/:key/unremove', async (req, res) => {
  await store.unremoveThread(req.params.key);
  res.json({ ok: true });
});

/**
 * Làm mới tên/avatar/phone của thread từ Zalo — dùng để sửa tên thread
 * bị lưu sai (bản cũ lấy tên NGƯỜI GỬI làm tên thread).
 * force=true: bỏ qua cache/DB, gọi lại Zalo (kể cả phone đã thử).
 */
app.post('/api/threads/:key/refresh', async (req, res) => {
  try {
    const thread = store.getThreadByKey(req.params.key);
    if (!thread) return res.status(404).json({ error: 'Không tìm thấy thread' });

    const entry = zaloManager.getAccount(thread.account_id);
    if (!entry) return res.status(400).json({ error: 'Tài khoản chưa đăng nhập' });

    const isGroup = thread.thread_type === ThreadType.Group;
    const meta = await fetchThreadMeta(entry, thread.thread_id, isGroup, {
      existing: thread,
      ownerName: entry.name,
      force: true,
    });

    if (!meta.name && !meta.avatar && !meta.phone) {
      return res.status(502).json({ error: 'Zalo không trả về thông tin — thử lại sau' });
    }

    await store.upsertThread({
      accountId: thread.account_id,
      threadId: thread.thread_id,
      threadType: thread.thread_type,
      name: meta.name,
      avatar: meta.avatar,
      phone: meta.phone,
    });

    const updated = await store.getThreadByKey(thread.id);
    res.json({
      ok: true,
      thread: {
        key: updated.id,
        name: updated.name,
        phone: updated.phone,
        avatar: updated.avatar,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Làm mới TẤT CẢ thread của một tài khoản — sửa một lần toàn bộ tên bị lỗi.
 * Chỉ gọi Zalo cho thread thiếu tên/tên trùng tên tài khoản/chưa có phone.
 */
app.post('/api/threads/refresh-all', async (req, res) => {
  try {
    const { accountId } = req.body || {};
    if (!accountId) return res.status(400).json({ error: 'accountId là bắt buộc' });

    const entry = zaloManager.getAccount(accountId);
    if (!entry) return res.status(400).json({ error: 'Tài khoản chưa đăng nhập' });

    const threads = await store.getAllThreads(accountId);
    const results = [];
    for (const t of threads) {
      const isGroup = t.thread_type === ThreadType.Group;
      const nameCorrupted = !t.name || (entry.name && t.name === entry.name);
      const needsPhone = !isGroup && t.phone == null; // null/undefined = chưa từng lấy

      if (!nameCorrupted && !needsPhone) {
        results.push({ key: t.id, name: t.name, skipped: true });
        continue;
      }

      try {
        const meta = await fetchThreadMeta(entry, t.thread_id, isGroup, {
          existing: t,
          ownerName: entry.name,
          force: nameCorrupted, // tên lỗi -> force; chỉ thiếu phone -> dùng quy tắc 1 lần
        });
        if (meta.name || meta.avatar || meta.phone) {
          await store.upsertThread({
            accountId,
            threadId: t.thread_id,
            threadType: t.thread_type,
            name: meta.name,
            avatar: meta.avatar,
            phone: meta.phone,
          });
          results.push({ key: t.id, name: meta.name || t.name, updated: true });
        } else {
          results.push({ key: t.id, error: 'no data' });
        }
      } catch (err) {
        results.push({ key: t.id, error: err.message });
      }

      // Nghỉ nhỏ giữa các lần gọi API để khỏi giống bot
      await new Promise((r) => setTimeout(r, 300));
    }

    res.json({ ok: true, total: threads.length, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bỏ theo dõi / theo dõi lại một thread
app.post('/api/threads/:key/tracking', async (req, res) => {
  try {
  const { key } = req.params;
  const tracked = req.body?.tracked;
  if (typeof tracked !== 'boolean') {
    return res.status(400).json({ error: 'body.tracked (boolean) là bắt buộc' });
  }
  const thread = await store.getThreadByKey(key);
  if (!thread) return res.status(404).json({ error: 'Không tìm thấy thread' });
  await store.setThreadTracking(key, tracked);
  res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Gỡ vĩnh viễn khỏi hệ thống: xoá thread + toàn bộ tin nhắn đã lưu, và
 * ghi vào blacklist — thread này sẽ KHÔNG xuất hiện lại dù có tin nhắn mới
 * (trừ khi bấm "Cho phép quay lại" trong mục Đã gỡ của Quản lý theo dõi).
 */
app.delete('/api/threads/:key', async (req, res) => {
  try {
  await store.removeThreadPermanently(req.params.key);
  res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Messages
// ============================================================
app.get('/api/messages', async (req, res) => {
  try {
  const { threadKey, before, limit } = req.query;
  if (!threadKey) return res.status(400).json({ error: 'threadKey là bắt buộc' });
  const msgs = await store.getMessages(threadKey, {
    before: before ? Number(before) : undefined,
    limit: Math.min(Number(limit) || 50, 200),
  });
  res.json(msgs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/messages/count', async (req, res) => {
  try {
  const { threadKey } = req.query;
  if (!threadKey) return res.status(400).json({ error: 'threadKey là bắt buộc' });
  res.json({ count: await store.countMessages(threadKey) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// SSE — tin nhắn mới theo thời gian thực
// ============================================================
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');

  const unsubscribe = events.onMessage((payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  });

  // Ping mỗi 25s để giữ connection
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);

  req.on('close', () => {
    clearInterval(ping);
    unsubscribe();
  });
});

// ============================================================
// Proxy avatar qua server — Zalo CDN chặn hotlink/referer
// ============================================================
app.get('/api/avatar', async (req, res) => {
  const { url } = req.query;
  if (!url || !/^https:\/\/(s100|s120|s240|avatar|file)\.zalo\.cdn\.com\//.test(url)) {
    return res.status(400).json({ error: 'URL không hợp lệ' });
  }
  try {
    const axios = require('axios');
    const response = await axios.get(url, {
      responseType: 'stream',
      timeout: 10_000,
      headers: { Referer: 'https://zalo.me/' },
    });
    res.setHeader('Content-Type', response.headers['content-type'] || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    response.data.pipe(res);
  } catch (err) {
    res.status(502).json({ error: 'Không tải được avatar' });
  }
});

// ============================================================
// Media: phục vụ ảnh/video/sticker trong tin nhắn.
//   - r2://key  -> stream từ R2 (file lưu vĩnh viễn)
//   - https://  -> proxy từ Zalo CDN (URL còn hạn) hoặc public R2 URL
// ============================================================
app.get('/api/media', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL là bắt buộc' });

  // === R2 object (r2://<key>) ===
  if (url.startsWith('r2://')) {
    const key = url.slice(5);
    const range = req.headers.range;
    const result = await mediaStore.getMediaStream(key, range);
    if (!result) return res.status(404).json({ error: 'Không tìm thấy media trong R2' });

    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    if (range && result.stream.statusCode === 206) {
      res.status(206);
    }
    result.stream.pipe(res);
    return;
  }

  // === URL trực tiếp (Zalo CDN hoặc R2 public) ===
  if (!/^https:\/\//.test(url)) {
    return res.status(400).json({ error: 'URL không hợp lệ' });
  }
  try {
    const axios = require('axios');
    const response = await axios.get(url, {
      responseType: 'stream',
      timeout: 30_000,
      maxContentLength: 100 * 1024 * 1024, // 100MB
      headers: { Referer: 'https://zalo.me/' },
    });
    res.setHeader('Content-Type', response.headers['content-type'] || 'application/octet-stream');
    if (response.headers['content-length']) {
      res.setHeader('Content-Length', response.headers['content-length']);
    }
    response.data.pipe(res);
  } catch (err) {
    res.status(502).json({ error: 'Không tải được media' });
  }
});

// ============================================================
// Health — đã đăng ký trước middleware auth ở trên
// ============================================================
app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

// Đăng xuất khỏi basic auth: trả 401 khiến browser xoá credentials đã lưu
app.get('/logout', (req, res) => {
  res.setHeader('WWW-Authenticate', 'Basic realm="Zalo Archive", charset="UTF-8"');
  res.status(401).send('Logged out');
});

module.exports = app;
