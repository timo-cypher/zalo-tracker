const { Zalo, ThreadType, LoginQRCallbackEventType } = require('zca-js');
const {
  saveAccountSession,
  loadAccountSessions,
  deleteAccountSession,
} = require('./sessionStore');
const store = require('./store');

/**
 * Quản lý nhiều tài khoản Zalo cùng lúc.
 *
 * Mỗi account:
 *   - có 1 session riêng (data/sessions/<ownId>.json)
 *   - có 1 instance Zalo + api riêng
 *   - có 1 listener riêng (zca-js: mở Zalo Web song song sẽ kick listener,
 *     nên mỗi tài khoản chỉ chạy đúng 1 listener của app này)
 */
const accounts = new Map(); // ownId -> { ownId, api, listener, name, avatar }

// Web QR login flow đang chờ (chỉ 1 flow tại 1 thời điểm)
let activeQrFlow = null;
// ID bắt buộc dùng chung giữa các flow (zca-js yêu cầu userAgent nhất quán)
let sharedUserAgent = null;

function makeUserAgent() {
  if (!sharedUserAgent) {
    sharedUserAgent =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
  }
  return sharedUserAgent;
}

function getAccount(ownId) {
  return accounts.get(ownId) || null;
}

function listAccounts() {
  return [...accounts.values()].map((a) => ({
    ownId: a.ownId,
    name: a.name,
    avatar: a.avatar,
    connected: !!a.connected,
  }));
}

function getAnyApi() {
  for (const a of accounts.values()) return a.api;
  return null;
}

// ============================================================
// Ingestion — được gán từ ngoài (index.js) để tránh circular import
// ============================================================
let onMessageHandler = null;
function setOnMessage(handler) {
  onMessageHandler = handler;
}

// ============================================================
// QR login flow (khởi tạo từ web)
// ============================================================

/**
 * Bắt đầu flow đăng nhập QR. Trả về { flowId, image } — image là data URL
 * hiển thị trực tiếp trong <img> trên web.
 */
async function startQrLogin() {
  if (activeQrFlow) {
    return { ok: false, error: 'Đã có một phiên đăng nhập QR đang chờ. Hãy huỷ trước.' };
  }

  const flowId = `qr_${Date.now()}`;
  const flow = {
    id: flowId,
    status: 'waiting_scan', // waiting_scan | scanned | confirmed | done | expired | declined | error
    image: null,
    accountName: null,
    accountAvatar: null,
    error: null,
    startedAt: Date.now(),
  };
  activeQrFlow = flow;

  const zalo = new Zalo({ selfListen: true, checkUpdate: true, logging: false });
  const ua = makeUserAgent();

  // Chạy loginQR bất đồng bộ — kết quả được cập nhật vào `flow` và web poll /api/auth/status
  (async () => {
    try {
      const api = await zalo.loginQR(
        { userAgent: ua, language: 'vi' },
        (event) => {
          switch (event.type) {
            case LoginQRCallbackEventType.QRCodeGenerated: {
              // event.data.image là base64 PNG (đã bỏ prefix data:image/png;base64,)
              flow.image = `data:image/png;base64,${event.data.image}`;
              flow.status = 'waiting_scan';
              break;
            }
            case LoginQRCallbackEventType.QRCodeExpired: {
              // zca-js tự retry qua actions.retry — theo dõi trạng thái để web biết
              flow.status = 'expired';
              break;
            }
            case LoginQRCallbackEventType.QRCodeScanned: {
              flow.status = 'scanned';
              flow.accountName = event.data?.display_name || null;
              flow.accountAvatar = event.data?.avatar || null;
              break;
            }
            case LoginQRCallbackEventType.QRCodeDeclined: {
              flow.status = 'declined';
              break;
            }
            case LoginQRCallbackEventType.GotLoginInfo: {
              // Session đầy đủ — sẽ lưu sau khi biết ownId (ở dưới)
              flow._loginInfo = event.data;
              break;
            }
          }
        }
      );

      // Người dùng đã bấm Huỷ trước khi quét — bỏ qua kết quả
      if (flow.cancelled) {
        console.log('[qr] Flow đã bị huỷ — bỏ qua kết quả đăng nhập.');
        return;
      }

      // === Đăng nhập thành công ===
      flow.status = 'done';
      const ownId = api.getOwnId();
      let name = flow.accountName;
      let avatar = flow.accountAvatar;

      try {
        const accInfo = await api.fetchAccountInfo();
        name = accInfo?.profile?.displayName || name;
        avatar = accInfo?.profile?.avatar || avatar;
      } catch {
        /* không lấy được profile — dùng fallback từ QR scan */
      }

      // Lưu session theo ownId để lần sau tự đăng nhập lại
      saveAccountSession(ownId, {
        cookie: flow._loginInfo?.cookie || null,
        imei: flow._loginInfo?.imei || null,
        userAgent: flow._loginInfo?.userAgent || ua,
      });

      // Ghi account vào DB TRƯỚC khi start listener — threads có FK
      // account_id -> accounts.id, thiếu bước này sẽ lỗi khi tin nhắn đầu đến
      store.upsertAccount({ id: ownId, name, avatar });

      const entry = {
        ownId,
        api,
        listener: api.listener,
        name,
        avatar,
        connected: false,
      };
      accounts.set(ownId, entry);
      attachListenerEvents(entry);
      startListener(entry);
      flow.accountName = name;
      flow.accountAvatar = avatar;

      console.log(`[account] Đã đăng nhập: ${name || ownId} (${ownId})`);
    } catch (err) {
      // Người dùng bấm Huỷ -> abort() -> ZaloApiLoginQRAborted
      if (activeQrFlow === flow) {
        flow.status = 'error';
        flow.error = err?.message || String(err);
      }
      console.error('[qr] Login thất bại:', err?.message || err);
    }
  })();

  // Đợi chút để QR được tạo trước khi trả về (thường <2s)
  for (let i = 0; i < 30; i++) {
    if (flow.image || flow.status === 'error') break;
    await new Promise((r) => setTimeout(r, 200));
  }

  return {
    ok: true,
    flowId: flow.id,
    image: flow.image,
    status: flow.status,
  };
}

function getQrStatus() {
  if (!activeQrFlow) return { active: false };
  const { id, status, image, accountName, accountAvatar, error, startedAt } = activeQrFlow;
  return { active: true, flowId: id, status, image, accountName, accountAvatar, error, startedAt };
}

function cancelQrLogin() {
  if (!activeQrFlow) return { ok: true };
  // Flow kết thúc tự nhiên khi QR hết hạn; không có cách abort cleanly
  // từ ngoài (loginQR promise vẫn chờ) — nên đánh dấu huỷ và bỏ qua kết quả.
  activeQrFlow.cancelled = true;
  activeQrFlow = null;
  return { ok: true };
}

// ============================================================
// Listener events + reconnect
// ============================================================
function attachListenerEvents(entry) {
  const lis = entry.listener;
  lis.removeAllListeners();

  lis.on('message', (msg) => {
    if (onMessageHandler) onMessageHandler(entry, msg);
  });

  lis.on('connected', () => {
    entry.connected = true;
    console.log(`[ws:${entry.ownId}] Đã kết nối`);
  });
  lis.on('disconnected', (code, reason) => {
    entry.connected = false;
    console.log(`[ws:${entry.ownId}] Mất kết nối: code=${code} reason=${reason}`);
  });
  lis.on('error', (err) => {
    console.error(`[ws:${entry.ownId}] Lỗi:`, err?.message || err);
  });

  lis.on('closed', async (code, reason) => {
    console.log(`[ws:${entry.ownId}] Đóng hẳn: code=${code} reason=${reason}`);
    entry.connected = false;
    await tryRelogin(entry);
  });
}

async function tryRelogin(entry) {
  try {
    const saved = loadAccountSession(entry.ownId);
    if (!saved) throw new Error('Không có session đã lưu');

    const zalo = new Zalo({ selfListen: true, checkUpdate: true, logging: false });
    const api = await zalo.login(saved);
    entry.api = api;
    entry.listener = api.listener;
    entry.connected = false;
    console.log(`[relogin:${entry.ownId}] Thành công`);

    attachListenerEvents(entry);
    startListener(entry);
  } catch (err) {
    console.error(`[relogin:${entry.ownId}] Thất bại: ${err?.message} — thử lại sau 60s`);
    setTimeout(() => tryRelogin(entry), 60_000);
  }
}

function startListener(entry) {
  try {
    entry.listener.start({ retryOnClose: true });
  } catch (err) {
    console.error(`[ws:${entry.ownId}] Không start được listener:`, err?.message || err);
  }
}

// ============================================================
// Khởi động: tự đăng nhập lại các session đã lưu
// ============================================================
async function restoreSessions() {
  const sessions = loadAccountSessions();
  const results = [];
  for (const ownId of Object.keys(sessions)) {
    try {
      const zalo = new Zalo({ selfListen: true, checkUpdate: true, logging: false });
      const api = await zalo.login(sessions[ownId]);
      let name = null;
      let avatar = null;
      try {
        const accInfo = await api.fetchAccountInfo();
        name = accInfo?.profile?.displayName || null;
        avatar = accInfo?.profile?.avatar || null;
      } catch {
        /* fallback bên dưới */
      }

      // Đảm bảo account tồn tại trong DB (FK threads.account_id -> accounts.id)
      store.upsertAccount({ id: ownId, name, avatar });

      const entry = { ownId, api, listener: api.listener, name, avatar, connected: false };
      accounts.set(ownId, entry);
      attachListenerEvents(entry);
      startListener(entry);
      results.push({ ownId, ok: true, name });
      console.log(`[restore] Đã đăng nhập lại: ${name || ownId} (${ownId})`);
    } catch (err) {
      results.push({ ownId, ok: false, error: err?.message });
      console.warn(`[restore] Session ${ownId} không dùng được: ${err?.message}`);
    }
  }
  return results;
}

function removeAccountRuntime(ownId) {
  const entry = accounts.get(ownId);
  if (entry) {
    try {
      entry.listener.stop();
    } catch {
      /* đã đóng rồi */
    }
    accounts.delete(ownId);
  }
  deleteAccountSession(ownId);
}

module.exports = {
  ThreadType,
  startQrLogin,
  getQrStatus,
  cancelQrLogin,
  restoreSessions,
  removeAccountRuntime,
  getAccount,
  listAccounts,
  getAnyApi,
  setOnMessage,
};
