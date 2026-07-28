require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const { ThreadType } = require('zca-js');

const { login, startListening, sendTextMessage } = require('./zaloClient');
const { logMessage, getMessagesSince } = require('./store');
const { saveSessionBase64 } = require('./sessionStore');
const { sendToTelegram, formatReport, escapeHtml } = require('./telegramReporter');

const app = express();
app.use(express.json());

// Render chạy sau proxy, cần trust proxy để lấy đúng IP client
app.set('trust proxy', true);

// === IP Allowlist (chỉ cho health check) ===
// UptimeRobot cần ping / và /health, nhưng chỉ từ các IP cụ thể.
// Các route khác (/send, /report/now) vẫn mở cho bạn xài.
// Set ALLOWED_IPS env var để ghi đè, cách nhau bằng dấu phẩy.
// Đặt 0.0.0.0/0 để cho phép tất cả (local dev).

function expandIPv6(ip) {
  // Chuẩn hoá IPv6: giải nén ::, thêm leading zeros, lower case
  // Ví dụ: 2a01:4ff:2f0:3b3a::1 → 2a01:04ff:02f0:3b3a:0000:0000:0000:0001
  if (!ip.includes(':')) return ip; // IPv4, không cần xử lý
  let parts = ip.split(':');
  const emptyIndex = parts.indexOf('');
  if (emptyIndex !== -1) {
    // Đếm số group :: cần thay thế
    const fillCount = 8 - (parts.length - 1);
    const fill = Array(fillCount).fill('0000');
    parts.splice(emptyIndex, parts.lastIndexOf('') - emptyIndex + 1, ...fill);
  }
  // Pad mỗi group lên 4 ký tự, lower case
  return parts.map(g => g.padStart(4, '0').toLowerCase()).join(':');
}

function ipInList(clientIP, ipList) {
  // Strip ::ffff: prefix nếu có
  const raw = clientIP.includes('::ffff:')
    ? clientIP.replace(/^::ffff:/, '')
    : clientIP;

  const normalized = raw.includes(':') ? expandIPv6(raw) : raw.toLowerCase();

  return ipList.some(allowed => {
    // Cho phép CIDR cơ bản: 0.0.0.0/0 = allow all
    if (allowed === '0.0.0.0/0' || allowed === '::0/0') return true;

    const expanded = allowed.includes(':') ? expandIPv6(allowed) : allowed.toLowerCase();
    return normalized === expanded;
  });
}

const DEFAULT_ALLOWED_IPS = [
  // UptimeRobot IPv6 — Singapore
  '2a01:4ff:2f0:3b3a::1',
  '2a01:4ff:2f0:27de::1',
  '2a01:4ff:2f0:193c::1',
  // UptimeRobot IPv6 — Tokyo
  '2400:6180:100:d0::94b6:4001',
  '2400:6180:100:d0::94b6:5001',
  '2400:6180:100:d0::94b6:7001',
  // UptimeRobot IPv6 — others
  '2406:da14:94d:8601:9d0d:7754:bedf:e4f5',
  '2406:da14:94d:8601:b325:ff58:2bba:7934',
  '2406:da14:94d:8601:db4b:c5ac:2cbe:9a79',
];

const allowedIPs = (process.env.ALLOWED_IPS || '').trim()
  ? process.env.ALLOWED_IPS.split(',').map(s => s.trim()).filter(Boolean)
  : DEFAULT_ALLOWED_IPS;

// Middleware chỉ áp dụng cho health check routes
const healthCheckIPGuard = (req, res, next) => {
  if (ipInList(req.ip, allowedIPs)) {
    return next();
  }
  console.log(`[ip-block] Từ chối health check từ IP ${req.ip}`);
  return res.status(403).json({ ok: false, error: 'IP không được phép' });
};

app.get('/', healthCheckIPGuard, (_req, res) => res.status(200).json({ ok: true, uptime: process.uptime() }));
app.get('/health', healthCheckIPGuard, (_req, res) => res.status(200).json({ ok: true, uptime: process.uptime() }));

const PORT = process.env.PORT || 3000;
const REPORT_CRON = process.env.REPORT_CRON || '0 8 * * *';

const recentBridgeSends = new Map();
let bridgeSendSeq = 0;

setInterval(() => {
  const cutoff = Date.now() - 15_000;
  for (const [key, ts] of recentBridgeSends) {
    if (ts < cutoff) recentBridgeSends.delete(key);
  }
}, 15_000);

async function sendAndLog(threadId, text, threadType = ThreadType.User) {
  const dedupKey = `${bridgeSendSeq++}:${threadId}:${text}`;
  recentBridgeSends.set(dedupKey, Date.now());

  const result = await sendTextMessage(threadId, text, threadType);
  logMessage({ direction: 'out', userId: threadId, userName: null, content: text, msgType: 'text' });
  return result;
}

function formatTelegramForward(message, direction) {
  const name = message.data?.dName || message.threadId;
  const time = new Date().toLocaleTimeString('vi-VN');
  const icon = direction === 'in' ? '📩' : '📤';
  const label = direction === 'in' ? 'RECEIVED FROM' : 'SENT TO';
  const content = (message.data?.content || '').slice(0, 1000);
  return (
    `<code>${escapeHtml(time)}</code>\n` +
    `${icon} <b>${label} ${escapeHtml(name)}</b>\n` +
    `${escapeHtml(content)}`
  );
}

function handleIncomingMessage(message) {
  const content = message?.data?.content;
  const isPlainText = typeof content === 'string';
  if (!isPlainText) return;

  const direction = message.isSelf ? 'out' : 'in';

  if (message.isSelf) {
    for (const [key, ts] of recentBridgeSends) {
      if (key.endsWith(`:${message.threadId}:${content}`)) {
        recentBridgeSends.delete(key);
        console.log(`[dedup] Bỏ qua tin echo từ /send: ${content}`);
        return;
      }
    }
  }

  logMessage({
    direction,
    userId: message.threadId,
    userName: message.data?.dName || null,
    content,
    msgType: 'text',
  });

  console.log(`[${direction === 'in' ? 'NHẬN' : 'GỬI'}] ${message.data?.dName || message.threadId}: ${content}`);

  const telegramText = formatTelegramForward(message, direction);
  sendToTelegram(telegramText).catch((err) =>
    console.error('[forward] Không gửi được tin nhắn lên Telegram:', err.message)
  );
}

app.post('/send', async (req, res) => {
  const { threadId, text, isGroup } = req.body;
  if (!threadId || !text) return res.status(400).json({ error: 'threadId và text là bắt buộc' });
  try {
    const threadType = isGroup ? ThreadType.Group : ThreadType.User;
    const result = await sendAndLog(threadId, text, threadType);
    res.json({ ok: true, result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

async function runReport({ sinceHours = 24, title } = {}) {
  const since = new Date(Date.now() - sinceHours * 3600 * 1000).toISOString();
  const messages = getMessagesSince(since);
  const text = formatReport(messages, { title: title || `Báo cáo Zalo (${sinceHours}h gần nhất)` });
  await sendToTelegram(text);
  console.log(`[report] Đã gửi báo cáo (${messages.length} tin nhắn) lên Telegram.`);
}

app.get('/report/now', async (_req, res) => {
  try {
    await runReport({ sinceHours: 24 });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

async function main() {
  // === Luôn start HTTP server trước ===
  // Dù login có thành công hay không, server vẫn sống để health check
  app.listen(PORT, () => {
    console.log(`Bridge server đang chạy tại http://localhost:${PORT}`);
    console.log(`Gửi tin nhắn thủ công: POST http://localhost:${PORT}/send`);
    console.log(`Báo cáo thủ công: GET http://localhost:${PORT}/report/now`);
    console.log(`Lịch báo cáo tự động: ${REPORT_CRON}`);
  });

  // 1. Đăng nhập
  const result = await login();

  if (!result) {
    // Login thất bại trên headless (Render) — session hết hạn, không thể QR
    console.error(
      '⚠️  KHÔNG THỂ ĐĂNG NHẬP ZALO — session đã hết hạn.\n' +
      '   Server vẫn chạy để nhận health check từ UptimeRobot.\n' +
      '   Cập nhật SESSION_JSON_BASE64 trên Render dashboard và restart.'
    );
    sendToTelegram(
      '⚠️ <b>Zalo bridge: Session hết hạn</b>\n' +
      'Không thể đăng nhập lại — cần session mới.\n\n' +
      'Cập nhật biến <code>SESSION_JSON_BASE64</code> trên Render dashboard và deploy lại.'
    ).catch((err) => console.error('[startup] Không gửi được cảnh báo Telegram:', err.message));
    return; // keep server alive, don't start listening
  }

  // 2. Tạo file session_base64.txt để copy lên Render dashboard
  saveSessionBase64();

  // 3. Bắt đầu lắng nghe tin nhắn — với auto-reconnect + callback khi session hết hạn
  startListening(handleIncomingMessage, (reason) => {
    console.error(`[session] Session hết hạn: ${reason}`);
    sendToTelegram(
      '⚠️ <b>Zalo bridge: Mất kết nối</b>\n' +
      `Lý do: ${escapeHtml(reason)}\n\n` +
      'Cập nhật <code>SESSION_JSON_BASE64</code> trên Render dashboard và deploy lại.'
    ).catch(() => {});
  });

  // 4. Lịch báo cáo tự động
  cron.schedule(REPORT_CRON, () => {
    runReport({ sinceHours: 24 }).catch((err) => console.error('[cron] Lỗi gửi báo cáo:', err));
  });

  // 5. Báo khởi động
  sendToTelegram('✅ Zalo-Telegram bridge vừa khởi động (hoặc restart).').catch((err) =>
    console.error('[startup] Không gửi được thông báo khởi động:', err.message)
  );
}

main().catch((err) => {
  console.error('Lỗi khởi động:', err);
  // Không process.exit() — giữ server sống để health check
});

// === Xử lý lỗi toàn cục ===
// uncaughtException: lỗi nghiêm trọng, log và thoát (Render sẽ restart tự động)
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException:', err);
  // Không exit — để server sống cho health check
});

// unhandledRejection: thường do zca-js WebSocket, không nên crash process
process.on('unhandledRejection', (reason) => {
  console.error('[warn] unhandledRejection:', reason);
  // Chỉ log, không exit — reconnect sẽ xử lý sau
});

module.exports = { sendAndLog };
