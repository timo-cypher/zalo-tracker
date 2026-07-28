const fs = require('fs');
const path = require('path');

const SESSION_PATH = process.env.SESSION_PATH || './data/session.json';

function saveSession({ cookie, imei, userAgent }) {
  fs.mkdirSync(path.dirname(SESSION_PATH), { recursive: true });
  fs.writeFileSync(SESSION_PATH, JSON.stringify({ cookie, imei, userAgent }, null, 2));
}

function loadSession() {
  // Ưu tiên 1: file session đã có sẵn trên đĩa (persistent disk, hoặc chạy local)
  if (fs.existsSync(SESSION_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(SESSION_PATH, 'utf8'));
    } catch {
      /* file hỏng, thử fallback bên dưới */
    }
  }

  // Ưu tiên 2: bootstrap từ biến môi trường SESSION_JSON_BASE64 — dùng khi
  // deploy lên Render/nơi không có sẵn file session và không muốn phụ thuộc
  // persistent disk. Cách tạo giá trị này:
  //   base64 -c data/session.json   (macOS: base64 data/session.json)
  // rồi dán kết quả vào env var SESSION_JSON_BASE64 trên Render dashboard.
  const b64 = process.env.SESSION_JSON_BASE64;
  if (b64) {
    try {
      const decoded = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
      saveSession(decoded); // ghi ra đĩa để lần sau đọc trực tiếp, không cần decode lại
      console.log('Đã khởi tạo session từ biến môi trường SESSION_JSON_BASE64.');
      return decoded;
    } catch (err) {
      console.warn('SESSION_JSON_BASE64 không hợp lệ:', err.message);
    }
  }

  return null;
}

function clearSession() {
  if (fs.existsSync(SESSION_PATH)) fs.unlinkSync(SESSION_PATH);
}

module.exports = { saveSession, loadSession, clearSession };
