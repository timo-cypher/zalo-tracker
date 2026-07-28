require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const { ThreadType } = require('zca-js');

const { login, startListening, sendTextMessage } = require('./zaloClient');
const { logMessage, deleteMessage, getMessagesSince } = require('./store');
const { saveSessionBase64 } = require('./sessionStore');
const { sendToTelegram, sendMediaToTelegram, formatReport, escapeHtml } = require('./telegramReporter');

const app = express();
app.use(express.json());

app.set('trust proxy', true);

app.get('/', (_req, res) => res.status(200).json({ ok: true, uptime: process.uptime() }));
app.get('/health', (_req, res) => res.status(200).json({ ok: true, uptime: process.uptime() }));

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

/**
 * Phát hiện loại media từ content object của Zalo message.
 * Trả về { type: 'photo'|'video'|null, url: string|null, desc: string }.
 */
function detectMedia(content) {
  if (typeof content !== 'object' || !content) return null;

  // Ảnh: content có oriUrl / normalUrl / thumb
  const imgUrl = content.oriUrl || content.normalUrl || content.hdUrl || content.thumb;
  if (imgUrl && typeof imgUrl === 'string') {
    return { type: 'photo', url: imgUrl, desc: content.desc || '' };
  }

  // Video: content có fileUrl + tên file có đuôi video
  if (content.fileUrl && typeof content.fileUrl === 'string') {
    const ext = (content.fileName || '').split('.').pop().toLowerCase();
    if (['mp4', 'mov', 'avi', 'mkv', 'webm', '3gp'].includes(ext) || !ext) {
      return { type: 'video', url: content.fileUrl, desc: content.desc || '' };
    }
  }

  // Sticker: content có stickerUrl / stickerId
  const stkUrl = content.stickerUrl || (content.stickerId ? `https://zalo-stickers.zdn.vn/${content.stickerId}` : null);
  if (stkUrl) {
    return { type: 'photo', url: stkUrl, desc: '🎨 Sticker' };
  }

  return null;
}

function handleIncomingMessage(message) {
  const content = message?.data?.content;
  const direction = message.isSelf ? 'out' : 'in';

  const displayName = message.data?.dName || message.threadId;

  // === XỬ LÝ TEXT ===
  if (typeof content === 'string') {
    // Dedup cho tin gửi từ /send
    if (message.isSelf) {
      for (const [key, ts] of recentBridgeSends) {
        if (key.endsWith(`:${message.threadId}:${content}`)) {
          recentBridgeSends.delete(key);
          console.log(`[dedup] Bỏ qua tin echo từ /send: ${content}`);
          return;
        }
      }
    }

    const textMsgId = logMessage({ direction, userId: message.threadId, userName: displayName, content, msgType: 'text' });
    console.log(`[${direction === 'in' ? 'NHẬN' : 'GỬI'}] ${displayName}: ${content}`);

    sendToTelegram(formatTelegramForward(message, direction))
      .then(() => deleteMessage(textMsgId))
      .catch((err) => console.error('[forward] Lỗi gửi text:', err.message));
    return;
  }

  // === XỬ LÝ MEDIA (ảnh / video / sticker) ===
  const media = detectMedia(content);
  if (media) {
    // Log vào SQLite
    const logContent = media.desc || `[${media.type === 'video' ? 'Video' : 'Ảnh'}]`;
    const mediaMsgId = logMessage({ direction, userId: message.threadId, userName: displayName, content: logContent, msgType: media.type });
    console.log(`[${direction === 'in' ? 'NHẬN' : 'GỬI'}] ${displayName}: ${logContent}`);

    // Tạo caption: thời gian + tên người gửi
    const time = new Date().toLocaleTimeString('vi-VN');
    const icon = direction === 'in' ? '📩' : '📤';
    const label = direction === 'in' ? 'RECEIVED FROM' : 'SENT TO';
    const caption = `<code>${escapeHtml(time)}</code>\n${icon} <b>${label} ${escapeHtml(displayName)}</b>`;

    // Gửi media lên Telegram, xoá SQLite nếu thành công
    sendMediaToTelegram(media.url, media.type, caption)
      .then(() => deleteMessage(mediaMsgId))
      .catch((err) => console.error(`[forward] Lỗi gửi ${media.type}:`, err.message));
    return;
  }

  // === LOẠI KHÁC (link preview, file, v.v.) — log + báo text ===
  console.log(`[${direction === 'in' ? 'NHẬN' : 'GỬI'}] ${displayName}: [message type không xác định]`);
  const otherMsgId = logMessage({ direction, userId: message.threadId, userName: displayName, content: '[unsupported]', msgType: 'other' });

  const time = new Date().toLocaleTimeString('vi-VN');
  const icon = direction === 'in' ? '📩' : '📤';
  const label = direction === 'in' ? 'RECEIVED FROM' : 'SENT TO';
  const fallbackText =
    `<code>${escapeHtml(time)}</code>\n` +
    `${icon} <b>${label} ${escapeHtml(displayName)}</b>\n` +
    `📎 [File/Sticker/Link]`;
  sendToTelegram(fallbackText)
    .then(() => deleteMessage(otherMsgId))
    .catch((err) => console.error('[forward] Lỗi gửi fallback:', err.message));
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
