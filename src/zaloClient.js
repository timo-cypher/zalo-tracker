const path = require("path");
const { exec } = require("child_process");
const { Zalo, LoginQRCallbackEventType } = require("zca-js");
const { saveSession, loadSession, saveSessionBase64 } = require("./sessionStore");

let api = null;

/**
 * Cố mở file ảnh QR bằng app mặc định của OS, để không cần tự đi tìm file.
 * Nếu chạy trên server không có GUI (VPS/Render/WSL không có desktop), lệnh
 * này sẽ fail im lặng — không sao, đường dẫn vẫn được in ra console để bạn
 * tự copy ra máy khác mở (ví dụ scp về máy cá nhân).
 */
function tryOpenImage(filePath) {
  const abs = path.resolve(filePath);
  const cmd =
    process.platform === "darwin"
      ? `open "${abs}"`
      : process.platform === "win32"
        ? `start "" "${abs}"`
        : `xdg-open "${abs}"`;
  exec(cmd, (err) => {
    if (err) {
      console.log(
        "(Không tự mở được ảnh QR — hãy tự mở file theo đường dẫn phía trên.)",
      );
    }
  });
}

async function login() {
  const zalo = new Zalo({
    selfListen: true,  // bắt cả tin nhắn mình gửi từ app Zalo, không chỉ tin nhắn đến
    checkUpdate: true,
    logging: false,
  });

  const saved = loadSession();

  if (saved) {
    try {
      console.log("Tìm thấy session đã lưu, thử đăng nhập lại không cần QR...");
      api = await zalo.login(saved);
      console.log(`Đăng nhập lại thành công, tài khoản id: ${api.getOwnId()}`);
      return api;
    } catch (err) {
      console.warn(
        "Session cũ không dùng được (có thể đã hết hạn):",
        err.message,
      );
      console.warn("Chuyển sang đăng nhập lại bằng QR...");
    }
  }

  console.log("Đang tạo mã QR đăng nhập, vui lòng đợi vài giây...");

  try {
    api = await zalo.loginQR({}, (event) => {
      switch (event.type) {
        case LoginQRCallbackEventType.QRCodeGenerated: {
          // event.actions.saveToFile() lưu ảnh QR xuống đĩa
          const qrPath = "qr.png";
          event.actions.saveToFile(qrPath).then(() => {
            const abs = path.resolve(qrPath);
            console.log("========================================================");
            console.log(`  ĐÃ TẠO XONG MÃ QR — mở file ảnh sau để quét:`);
            console.log(`  ${abs}`);
            console.log("  Quét bằng app Zalo trên điện thoại:");
            console.log("  Cài đặt > Thiết bị đăng nhập > Quét mã QR");
            console.log("========================================================");
            tryOpenImage(qrPath);
          }).catch((err) => {
            console.error("Không thể lưu file ảnh QR:", err.message);
          });
          break;
        }
        case LoginQRCallbackEventType.QRCodeExpired:
          console.log("Mã QR đã hết hạn, đang tạo lại...");
          break;
        case LoginQRCallbackEventType.QRCodeScanned:
          console.log("Đã quét mã QR, vui lòng xác nhận trên điện thoại...");
          break;
        case LoginQRCallbackEventType.QRCodeDeclined:
          console.log("Yêu cầu đăng nhập đã bị từ chối trên điện thoại.");
          break;
        case LoginQRCallbackEventType.GotLoginInfo:
          // Lưu session cookie/imei/userAgent để lần sau không cần quét QR lại
          saveSession({
            cookie: event.data.cookie,
            imei: event.data.imei,
            userAgent: event.data.userAgent,
          });
          saveSessionBase64(); // tự động tạo file session_base64.txt
          console.log("Đã lưu session đăng nhập cho lần sau.");
          break;
      }
    });
  } catch (err) {
    console.error("Đăng nhập QR thất bại:", err);
    throw err;
  }

  console.log(`Đã đăng nhập Zalo với tài khoản id: ${api.getOwnId()}`);

  return api;
}

function startListening(onMessage) {
  if (!api) throw new Error("Chưa đăng nhập — gọi login() trước.");
  api.listener.on("message", onMessage);

  // Theo dõi trạng thái WebSocket để debug nếu mất kết nối
  api.listener.on("connected", () => console.log("[ws] WebSocket đã kết nối"));
  api.listener.on("disconnected", (code, reason) =>
    console.log(`[ws] WebSocket mất kết nối: code=${code}, reason=${reason}`)
  );
  api.listener.on("error", (err) =>
    console.error("[ws] WebSocket lỗi:", err?.message || err)
  );
  api.listener.on("closed", (code, reason) =>
    console.log(`[ws] WebSocket đã đóng: code=${code}, reason=${reason}`)
  );

  api.listener.start();
}

async function sendTextMessage(threadId, text, threadType) {
  if (!api) throw new Error("Chưa đăng nhập — gọi login() trước.");
  return api.sendMessage({ msg: text }, threadId, threadType);
}

function getApi() {
  return api;
}

module.exports = { login, startListening, sendTextMessage, getApi };
