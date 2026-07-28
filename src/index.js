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

// Root route trả về 200 để UptimeRobot không báo Down (nó ping vào URL gốc)
app.get('/', (_req, res) => res.status(200).json({ ok: true, uptime: process.uptime() }));
app.get('/health', (_req, res) => res.status(200).json({ ok: true, uptime: process.uptime() }));

const PORT = process.env.PORT || 3000;
const REPORT_CRON = process.env.REPORT_CRON || '0 8 * * *';

/**
 * Cơ chế chống gửi trùng (dedup):
 * Khi gửi tin qua /send endpoint, sendAndLog ghi vào Set này.
 * Khi WebSocket echo về, handleIncomingMessage kiểm tra và bỏ qua.
 */
const recentBridgeSends = new Map(); // key -> timestamp
let bridgeSendSeq = 0;

// Dọn dẹp Map mỗi 15 giây
setInterval(() => {
  const cutoff = Date.now() - 15_000;
  for (const [key, ts] of recentBridgeSends) {
    if (ts < cutoff) recentBridgeSends.delete(key);
  }
}, 15_000);

/**
 * Gọi hàm này thay vì gọi thẳng zaloClient.sendTextMessage ở nơi khác trong code,
 * để mọi tin nhắn gửi đi đều tự động được log.
 */
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
  // Bỏ qua tin nhắn không phải text
  const content = message?.data?.content;
  const isPlainText = typeof content === 'string';
  if (!isPlainText) return;

  const direction = message.isSelf ? 'out' : 'in';

  // === Chống trùng: nếu tin này vừa được gửi qua /send endpoint thì bỏ qua ===
  if (message.isSelf) {
    for (const [key, ts] of recentBridgeSends) {
      if (key.endsWith(`:${message.threadId}:${content}`)) {
        recentBridgeSends.delete(key);
        console.log(`[dedup] Bỏ qua tin echo từ /send: ${content}`);
        return; // Đã được sendAndLog xử lý rồi
      }
    }
  }

  // Log vào SQLite
  logMessage({
    direction,
    userId: message.threadId,
    userName: message.data?.dName || null,
    content,
    msgType: 'text',
  });

  console.log(`[${direction === 'in' ? 'NHẬN' : 'GỬI'}] ${message.data?.dName || message.threadId}: ${content}`);

  // Forward real-time lên Telegram
  const telegramText = formatTelegramForward(message, direction);
  sendToTelegram(telegramText).catch((err) =>
    console.error('[forward] Không gửi được tin nhắn lên Telegram:', err.message)
  );
}

// --- Endpoint thủ công để test gửi tin nhắn (và tự log) ---
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

// --- Sinh báo cáo và gửi lên Telegram ---
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
  // 1. Đăng nhập (tự thử session đã lưu trước, fallback QR nếu cần — xem zaloClient.js)
  await login();

  // Tạo file session_base64.txt để copy lên Render dashboard
  saveSessionBase64();

  // 2. Bắt đầu lắng nghe tin nhắn đến/đi
  startListening(handleIncomingMessage);

  // 3. Lịch báo cáo tự động
  cron.schedule(REPORT_CRON, () => {
    runReport({ sinceHours: 24 }).catch((err) => console.error('[cron] Lỗi gửi báo cáo:', err));
  });

  // 4. Server HTTP cho các endpoint thủ công (/send, /report/now)
  app.listen(PORT, () => {
    console.log(`Bridge server đang chạy tại http://localhost:${PORT}`);
    console.log(`Gửi tin nhắn thủ công: POST http://localhost:${PORT}/send`);
    console.log(`Báo cáo thủ công: GET http://localhost:${PORT}/report/now`);
    console.log(`Lịch báo cáo tự động: ${REPORT_CRON}`);
  });

  // 5. Báo cho biết process vừa khởi động (hữu ích để phát hiện restart do crash)
  sendToTelegram('✅ Zalo-Telegram bridge vừa khởi động (hoặc restart).').catch((err) =>
    console.error('[startup] Không gửi được thông báo khởi động:', err.message)
  );
}

main().catch((err) => {
  console.error('Lỗi khởi động:', err);
  process.exit(1); // để pm2/systemd tự restart theo policy đã cấu hình
});

// --- Bắt lỗi toàn cục ---
// Thay vì để process "treo" ở trạng thái nửa sống nửa chết khi có lỗi không
// bắt được (ví dụ zca-js mất kết nối đột ngột), thoát hẳn để process manager
// (pm2/systemd) khởi động lại sạch — đáng tin cậy hơn là tự viết logic
// reconnect tay cho một thư viện không chính thức, ít tài liệu.
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandledRejection:', reason);
  process.exit(1);
});

module.exports = { sendAndLog };
