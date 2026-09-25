require('dotenv').config();

const store = require('./store');
const { setOnMessage, restoreSessions } = require('./zaloManager');
const { handleMessage } = require('./ingest');
const app = require('./server');

const PORT = process.env.PORT || 3000;

// Đăng ký handler trước khi restore session để không bỏ sót tin nhắn
setOnMessage(handleMessage);

async function main() {
  // Postgres: tạo schema nếu chưa có (SQLite tự tạo lúc require)
  await store.init();

  app.listen(PORT, () => {
    console.log(`Web server đang chạy tại http://localhost:${PORT}`);
    console.log(`DB backend: ${store.isPostgres ? 'Postgres (DATABASE_URL)' : 'SQLite (local)'}`);
    console.log('Mở trình duyệt để đăng nhập Zalo bằng QR và xem tin nhắn.');
  });

  const restored = await restoreSessions();
  const okCount = restored.filter((r) => r.ok).length;
  console.log(`[startup] Đã khôi phục ${okCount}/${restored.length} tài khoản Zalo.`);
}

// Lỗi toàn cục: chỉ log, không exit (giữ server sống cho web UI)
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[warn] unhandledRejection:', reason);
});

main().catch((err) => {
  console.error('Lỗi khởi động:', err);
});
