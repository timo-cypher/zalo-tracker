require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const { ThreadType } = require('zca-js');

const { login, startListening, sendTextMessage, getApi } = require('./zaloClient');
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

// === Phone number cache: chỉ query 1 lần/người/ngày ===
const phoneCache = new Map(); // userId -> { phone, fetchedAt }
const PHONE_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

const phonePendingFetches = new Map(); // userId -> Promise để dedup concurrent requests

async function fetchPhoneNumber(userId) {
  // Kiểm tra cache
  const cached = phoneCache.get(userId);
  if (cached && Date.now() - cached.fetchedAt < PHONE_CACHE_TTL_MS) {
    return cached.phone;
  }

  // Nếu đang có request cho userId này đang bay, dùng lại promise đó
  if (phonePendingFetches.has(userId)) {
    return phonePendingFetches.get(userId);
  }

  const promise = (async () => {
    try {
      const api = getApi();
      if (!api) return null;

      const result = await api.getUserInfo(userId);
      const key = `${userId}_0`;
      const profile = result?.changed_profiles?.[key];
      const phone = profile?.phoneNumber || null;

      phoneCache.set(userId, { phone, fetchedAt: Date.now() });

      if (phone) {
        console.log(`[phone] Đã lấy sđt cho ${profile.displayName || userId}: ${phone}`);
      } else {
        console.log(`[phone] ${profile?.displayName || userId}: không có sđt (đã ẩn)`);
      }

      return phone;
    } catch (err) {
      console.error(`[phone] Lỗi lấy sđt cho ${userId}:`, err.message);
      phoneCache.set(userId, { phone: null, fetchedAt: Date.now() - PHONE_CACHE_TTL_MS + 5 * 60 * 1000 });
      return null;
    } finally {
      phonePendingFetches.delete(userId);
    }
  })();

  phonePendingFetches.set(userId, promise);
  return promise;
}

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

function formatTelegramForward(message, direction, phone) {
  const name = message.data?.dName || message.threadId;
  const phoneSuffix = phone ? ` [${escapeHtml(phone)}]` : '';
  const time = new Date().toLocaleTimeString('vi-VN');
  const icon = direction === 'in' ? '📩' : '📤';
  const label = direction === 'in' ? 'RECEIVED FROM' : 'SENT TO';
  const content = (message.data?.content || '').slice(0, 1000);
  return (
    `<code>${escapeHtml(time)}</code>\n` +
    `${icon} <b>${label} ${escapeHtml(name)}${phoneSuffix}</b>\n` +
    `${escapeHtml(content)}`
  );
}

/**
 * Phát hiện loại media từ content object + msgType của Zalo message.
 *
 * Kết quả debug cho thấy:
 *   - Video:   msgType = "chat.video.msg", content = TAttachmentContent (href=video URL, thumb=thumbnail)
 *   - Ảnh:     msgType = ?, content có oriUrl/normalUrl/hdUrl (image fields)
 *   - Sticker:  content có stickerUrl
 *
 * Trả về { type: 'photo'|'video'|null, url: string|null, desc: string }.
 */
function detectMedia(content, msgType) {
  if (typeof content !== 'object' || !content) return null;

  // === Dùng msgType từ Zalo để xác định (ưu tiên cao nhất) ===
  if (msgType === 'chat.video.msg' && content.href) {
    return { type: 'video', url: content.href, desc: content.description || '' };
  }

  // === Fallback: href trỏ tới video CDN ===
  if (content.href && typeof content.href === 'string' &&
      (content.href.includes('video-') || content.href.includes('/video/'))) {
    return { type: 'video', url: content.href, desc: content.description || '' };
  }

  // === ẢNH: oriUrl / normalUrl / hdUrl / thumb ===
  const imgUrl = content.oriUrl || content.normalUrl || content.hdUrl || content.thumb;
  if (imgUrl && typeof imgUrl === 'string') {
    return { type: 'photo', url: imgUrl, desc: content.desc || content.description || '' };
  }

  // === Sticker ===
  if (content.stickerUrl) {
    return { type: 'photo', url: content.stickerUrl, desc: '🎨 Sticker' };
  }

  return null;
}

async function handleIncomingMessage(message) {
  try {
    const content = message?.data?.content;
    const direction = message.isSelf ? 'out' : 'in';
    const displayName = message.data?.dName || message.threadId;

    // Lấy số điện thoại từ cache hoặc API (chỉ query lần đầu trong ngày)
    const phone = await fetchPhoneNumber(message.threadId);
    const phoneSuffix = phone ? ` [${phone}]` : '';

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

      const textMsgId = logMessage({ direction, userId: message.threadId, userName: displayName, phone, content, msgType: 'text' });
      console.log(`[${direction === 'in' ? 'NHẬN' : 'GỬI'}] ${displayName}${phoneSuffix}: ${content}`);

      sendToTelegram(formatTelegramForward(message, direction, phone))
        .then(() => deleteMessage(textMsgId))
        .catch((err) => console.error('[forward] Lỗi gửi text:', err.message));
      return;
    }

    // === XỬ LÝ MEDIA (ảnh / video / sticker) ===
    const msgType = message.data?.msgType || '';
    const media = detectMedia(content, msgType);

    if (media) {
      const logContent = media.desc || `[${media.type === 'video' ? 'Video' : 'Ảnh'}]`;
      const mediaMsgId = logMessage({ direction, userId: message.threadId, userName: displayName, phone, content: logContent, msgType: media.type });
      console.log(`[${direction === 'in' ? 'NHẬN' : 'GỬI'}] ${displayName}${phoneSuffix}: ${logContent}`);

      const time = new Date().toLocaleTimeString('vi-VN');
      const icon = direction === 'in' ? '📩' : '📤';
      const label = direction === 'in' ? 'RECEIVED FROM' : 'SENT TO';
      const caption = `<code>${escapeHtml(time)}</code>\n${icon} <b>${label} ${escapeHtml(displayName)}${escapeHtml(phoneSuffix)}</b>`;

      sendMediaToTelegram(media.url, media.type, caption)
        .then(() => deleteMessage(mediaMsgId))
        .catch((err) => {
          console.error(`[forward] Lỗi gửi ${media.type}:`, err.message);
          if (media.type === 'video') {
            sendToTelegram(
              `${caption}\n` +
              `🎬 <i>[Video — không thể tải xuống, dung lượng quá lớn hoặc URL đã hết hạn]</i>`
            ).catch(() => {});
          }
        });
      return;
    }

    // === LOẠI KHÁC ===
    console.log(`[${direction === 'in' ? 'NHẬN' : 'GỬI'}] ${displayName}${phoneSuffix}: [message type không xác định]`);
    const otherMsgId = logMessage({ direction, userId: message.threadId, userName: displayName, phone, content: '[unsupported]', msgType: 'other' });

    const time = new Date().toLocaleTimeString('vi-VN');
    const icon = direction === 'in' ? '📩' : '📤';
    const label = direction === 'in' ? 'RECEIVED FROM' : 'SENT TO';
    const fallbackText =
      `<code>${escapeHtml(time)}</code>\n` +
      `${icon} <b>${label} ${escapeHtml(displayName)}${escapeHtml(phoneSuffix)}</b>\n` +
      `📎 [File/Sticker/Link]`;
    sendToTelegram(fallbackText)
      .then(() => deleteMessage(otherMsgId))
      .catch((err) => console.error('[forward] Lỗi gửi fallback:', err.message));
  } catch (err) {
    console.error('[handler] Lỗi xử lý tin nhắn:', err?.message || err);
  }
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
