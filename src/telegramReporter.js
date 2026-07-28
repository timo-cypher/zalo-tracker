const axios = require('axios');
const FormData = require('form-data');
const { loadSession } = require('./sessionStore');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function sendToTelegram(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  // Telegram giới hạn 4096 ký tự/tin nhắn -> cắt thành nhiều phần nếu cần
  const chunks = splitIntoChunks(text, 4000);
  for (const chunk of chunks) {
    await axios.post(url, {
      chat_id: TELEGRAM_CHAT_ID,
      text: chunk,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  }
}

function splitIntoChunks(text, maxLen) {
  const chunks = [];
  let rest = text;
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf('\n', maxLen);
    if (cut <= 0) cut = maxLen;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length) chunks.push(rest);
  return chunks;
}

/**
 * Format danh sách tin nhắn (đến/đi) thành báo cáo text dễ đọc, nhóm theo user.
 */
function formatReport(messages, { title = 'Báo cáo Zalo' } = {}) {
  if (!messages.length) {
    return `<b>${escapeHtml(title)}</b>\nKhông có tin nhắn nào trong khoảng thời gian này.`;
  }

  const byUser = new Map();
  for (const m of messages) {
    if (!byUser.has(m.user_id)) byUser.set(m.user_id, []);
    byUser.get(m.user_id).push(m);
  }

  const lines = [`<b>${escapeHtml(title)}</b>`, `Tổng: ${messages.length} tin nhắn, ${byUser.size} tài khoản\n`];

  for (const [userId, msgs] of byUser) {
    const name = msgs.find((m) => m.user_name)?.user_name || userId;
    const inCount = msgs.filter((m) => m.direction === 'in').length;
    const outCount = msgs.filter((m) => m.direction === 'out').length;
    lines.push(`👤 <b>${escapeHtml(name)}</b> (${userId}) — đến: ${inCount}, đi: ${outCount}`);
    for (const m of msgs) {
      const arrow = m.direction === 'in' ? '⬅️' : '➡️';
      const time = m.created_at.split('.')[0];
      lines.push(`  ${arrow} [${time}] ${escapeHtml(truncate(m.content, 200))}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

/**
 * Chuyển mảng cookie từ session Zalo thành chuỗi header Cookie.
 */
function formatCookies(cookieArr) {
  if (!Array.isArray(cookieArr)) return '';
  return cookieArr.map(c => `${c.key || c.name}=${c.value}`).join('; ');
}

/**
 * Gửi ảnh/video lên Telegram kèm caption.
 * Ảnh: gửi URL trực tiếp (Zalo CDN ảnh thường không cần auth).
 * Video: tải về từ Zalo CDN bằng cookies, rồi upload lên Telegram (vì CDN video cần auth).
 *
 * @param {string} fileUrl - URL của file từ Zalo
 * @param {'photo'|'video'} mediaType - loại media
 * @param {string} [caption] - text mô tả (HTML)
 */
async function sendMediaToTelegram(fileUrl, mediaType, caption) {
  const truncatedCaption = caption ? caption.slice(0, 1024) : undefined;

  if (mediaType === 'photo') {
    // Ảnh — gửi URL trực tiếp, Telegram tự tải về
    const payload = {
      chat_id: TELEGRAM_CHAT_ID,
      photo: fileUrl,
      disable_web_page_preview: true,
    };
    if (truncatedCaption) {
      payload.caption = truncatedCaption;
      payload.parse_mode = 'HTML';
    }
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`, payload);
    return;
  }

  // === Video — tải về từ Zalo CDN bằng cookies rồi upload lên Telegram ===
  const session = loadSession();
  const cookieStr = formatCookies(session?.cookie);

  const dlHeaders = { 'User-Agent': session?.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };
  if (cookieStr) dlHeaders.Cookie = cookieStr;

  console.log('[media] Đang tải video từ Zalo CDN...');

  const dlResponse = await axios.get(fileUrl, {
    responseType: 'stream',
    headers: dlHeaders,
    timeout: 60_000,
  });

  const ext = (dlResponse.headers['content-type'] || '').includes('video') ? 'mp4' : 'mp4';

  const form = new FormData();
  form.append('chat_id', TELEGRAM_CHAT_ID);
  form.append('video', dlResponse.data, {
    filename: `video.${ext}`,
    contentType: dlResponse.headers['content-type'] || 'video/mp4',
  });
  if (truncatedCaption) {
    form.append('caption', truncatedCaption);
    form.append('parse_mode', 'HTML');
  }

  // Upload lên Telegram
  console.log('[media] Đang upload video lên Telegram...');
  await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendVideo`, form, {
    headers: form.getHeaders(),
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    timeout: 300_000, // 5 phút cho video lớn
  });

  console.log('[media] Video đã gửi lên Telegram thành công.');
}

module.exports = { sendToTelegram, sendMediaToTelegram, formatReport, escapeHtml };
