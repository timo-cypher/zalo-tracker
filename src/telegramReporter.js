const axios = require('axios');

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
 * Gửi ảnh/video lên Telegram kèm caption.
 * @param {string} fileUrl - URL trực tiếp của file (từ Zalo CDN)
 * @param {'photo'|'video'} mediaType - loại media
 * @param {string} [caption] - text mô tả (HTML)
 */
async function sendMediaToTelegram(fileUrl, mediaType, caption) {
  const method = mediaType === 'video' ? 'sendVideo' : 'sendPhoto';
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;
  const payload = {
    chat_id: TELEGRAM_CHAT_ID,
    [mediaType === 'video' ? 'video' : 'photo']: fileUrl,
    disable_web_page_preview: true,
  };
  if (caption) {
    payload.caption = caption.slice(0, 1024); // Telegram giới hạn 1024 ký tự cho caption
    payload.parse_mode = 'HTML';
  }
  await axios.post(url, payload);
}

module.exports = { sendToTelegram, sendMediaToTelegram, formatReport, escapeHtml };
