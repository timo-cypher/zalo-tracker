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

      // Nếu đang chạy trên server không có terminal (Render, VPS không GUI),
      // không thể quét QR — trả về null để caller giữ server sống và gửi cảnh báo
      if (!process.stdin.isTTY) {
        console.warn(
          "Môi trường không có terminal (headless) — bỏ qua QR login."
        );
        return null;
      }

      console.warn("Chuyển sang đăng nhập lại bằng QR...");
    }
  }

  // === Dưới đây chỉ chạy khi có terminal (máy local) ===
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

function startListening(onMessage, onSessionExpired) {
  if (!api) throw new Error("Chưa đăng nhập — gọi login() trước.");

  /**
   * Đăng ký lại tất cả event handlers lên listener hiện tại.
   * Hàm này có thể gọi nhiều lần (sau re-login) vì listener
   * instance được tạo lại mỗi lần login.
   */
  function registerEvents() {
    const lis = api.listener;

    lis.removeAllListeners();
    lis.on("message", onMessage);

    lis.on("connected", () => console.log("[ws] WebSocket đã kết nối"));
    lis.on("disconnected", (code, reason) =>
      console.log(`[ws] WebSocket mất kết nối: code=${code}, reason=${reason}`)
    );
    lis.on("error", (err) =>
      console.error("[ws] WebSocket lỗi:", err?.message || err)
    );

    let expiredNotified = false; // chỉ gửi Telegram 1 lần, tránh spam

    // Khi zca-js đã thử retry hết mức (nếu retryOnClose=true) mà vẫn không
    // được, nó emit "closed". Lúc này cần login lại với session đã lưu.
    lis.on("closed", async (code, reason) => {
      console.log(`[ws] WebSocket đã đóng hẳn: code=${code}, reason=${reason}`);

      try {
        const saved = loadSession();
        if (!saved) throw new Error("Không có session đã lưu để login lại.");

        const newZalo = new Zalo({
          selfListen: true,
          checkUpdate: true,
          logging: false,
        });
        api = await newZalo.login(saved);
        console.log(`[reconnect] Đã login lại, tài khoản id: ${api.getOwnId()}`);

        // Reset cờ vì đã login thành công
        expiredNotified = false;

        // Đăng ký lại events với api mới
        registerEvents();
        api.listener.start({ retryOnClose: true });
        console.log("[reconnect] WebSocket đã được khởi động lại.");
      } catch (err) {
        console.error("[reconnect] Không thể login lại:", err.message);

        // Chỉ gửi Telegram 1 lần duy nhất, không spam
        if (!expiredNotified) {
          expiredNotified = true;
          if (typeof onSessionExpired === "function") {
            onSessionExpired(err.message);
          }
        }

        // Thử lại im lặng mỗi 60 giây — không gửi Telegram nữa
        setTimeout(() => {
          console.log("[reconnect] Thử login lại sau 60s (im lặng)...");
          api.listener.emit("closed", code, reason);
        }, 60_000);
      }
    });
  }

  registerEvents();

  // BẬT retryOnClose — zca-js tự động thử lại khi mất kết nối tạm thời
  api.listener.start({ retryOnClose: true });
}

async function sendTextMessage(threadId, text, threadType) {
  if (!api) throw new Error("Chưa đăng nhập — gọi login() trước.");
  return api.sendMessage({ msg: text }, threadId, threadType);
}

function getApi() {
  return api;
}

module.exports = { login, startListening, sendTextMessage, getApi };
