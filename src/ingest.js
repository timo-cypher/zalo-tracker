const { ThreadType } = require('zca-js');
const axios = require('axios');
const store = require('./store');
const events = require('./events');
const mediaStore = require('./mediaStore');
const { loadAccountSession } = require('./sessionStore');

/**
 * Xử lý message event từ zca-js listener và lưu vào DB.
 * entry: { ownId, api, name, avatar } — tài khoản đang đăng nhập
 * message: UserMessage | GroupMessage từ zca-js
 */
async function handleMessage(entry, message) {
  try {
    const data = message.data || {};
    const isGroup = message.type === ThreadType.Group;
    const threadType = isGroup ? ThreadType.Group : ThreadType.User;
    const accountId = entry.ownId;
    const threadId = message.threadId;

    // 1. Bỏ qua nếu thread đã bị gỡ khỏi hệ thống theo dõi
    if (!(await store.isThreadTracked(accountId, threadId, threadType))) {
      return;
    }

    // 2. Loại tin nhắn từ zca-js (dùng cho detectMedia)
    const msgTypeRaw = data.msgType || '';

    // 3. Lấy tên + avatar + phone của THREAD (người nhận/nhóm)
    //    Truyền sẵn row cũ trong DB + tên tài khoản để:
    //    - Không gọi API lại nếu đã có đủ dữ liệu (phone chỉ lấy 1 lần)
    //    - Phát hiện tên bị lỗi (trùng tên tài khoản của chính mình) để sửa
    const candidateKey = `${accountId}:${threadId}:${threadType}`;
    const existingRow = await store.getThreadByKey(candidateKey);
    const ownerName =
      entry.name || (await store.getAccounts()).find((a) => a.id === accountId)?.name || null;

    const meta = await fetchThreadMeta(entry, threadId, isGroup, {
      existing: existingRow,
      ownerName,
    });

    // Đảm bảo account tồn tại trong DB (FK threads.account_id -> accounts.id)
    await store.upsertAccount({ id: accountId, name: entry.name, avatar: entry.avatar });

    const threadKey = await store.upsertThread({
      accountId,
      threadId,
      threadType,
      name: meta.name,
      avatar: meta.avatar,
      phone: meta.phone,
    });

    // Thread có thể bị gỡ tracking giữa chừng (race) — kiểm tra lại
    const threadRow = await store.getThreadByKey(threadKey);
    if (!threadRow || threadRow.is_tracked !== 1) return;

    // 4. Tên NGƯỜI GỬI tin nhắn này (khác tên thread — quan trọng trong nhóm
    //    và khi chính mình gửi tin: dName lúc đó là tên mình)
    const senderName = message.isSelf
      ? entry.name
      : (data.dName || meta.name || null);

    // 5. Phát hiện loại tin nhắn + media
    const detected = detectMedia(data.content, msgTypeRaw);
    const direction = message.isSelf ? 'out' : 'in';
    const senderId = message.isSelf ? accountId : data.uidFrom || threadId;

    let content;
    let msgType;
    let mediaUrl;
    if (detected) {
      msgType = detected.type; // photo | video | sticker
      mediaUrl = detected.url;
      content = detected.desc || (detected.type === 'video' ? '[Video]' : '[Ảnh]');

      // === Lưu media vĩnh viễn lên R2 (nếu đã cấu hình) ===
      // URL Zalo CDN hết hạn sau vài ngày — R2 giữ file vĩnh viễn.
      // mediaUrl sẽ được THAY bằng key R2 (qua helper r2://) nếu upload thành công.
      const r2Key = await archiveMedia(entry, detected, accountId, data.msgId);
      if (r2Key) {
        mediaUrl = `r2://${r2Key}`;
      }
    } else if (typeof data.content === 'string') {
      content = data.content;
      msgType = 'text';
    } else if (data.content && data.content.stickerUrl) {
      msgType = 'sticker';
      mediaUrl = data.content.stickerUrl;
      content = '[Sticker]';
    } else {
      msgType = 'other';
      content = '[Tin nhắn không hỗ trợ]';
    }

    // 6. Lưu vào DB
    const msgId = data.msgId ? String(data.msgId) : data.cliMsgId ? String(data.cliMsgId) : null;
    const createdAt = new Date(Number(data.ts) || Date.now()).toISOString();

    const id = await store.insertMessage({
      accountId,
      threadKey,
      msgId,
      direction,
      senderId,
      senderName,
      content,
      msgType,
      mediaUrl,
      createdAt,
    });

    if (id === null) {
      // Duplicate — chỉ cập nhật preview, không emit
      return;
    }

    await store.updateThreadPreview(threadKey, content.slice(0, 100), createdAt);

    // 7. Đẩy đến web UI qua SSE
    events.emitMessage({
      accountId,
      threadKey,
      threadId,
      isGroup,
      id,
      direction,
      senderId,
      senderName,
      content,
      msgType,
      mediaUrl,
      createdAt,
    });

    console.log(
      `[msg:${accountId}] ${direction === 'in' ? '⬅' : '➡'} ${threadRow.name || threadId}: ${content.slice(0, 50)}`
    );
  } catch (err) {
    console.error('[ingest] Lỗi xử lý tin nhắn:', err?.message || err);
  }
}

// ============================================================
// Lấy tên/avatar/phone của thread
//
// Quy tắc (đúng yêu cầu "phone chỉ lấy MỘT lần"):
//   1. Người đã có ĐỦ tên (không trùng tên tài khoản mình) + phone trong DB
//      -> dùng luôn DB, KHÔNG gọi API nữa.
//   2. Chưa đủ (người mới, tên bị lỗi, chưa từng lấy phone) -> gọi API 1 lần.
//   3. Lần gọi đó nếu người này ẩn SĐT -> đánh dấu phone='' (đã thử),
//      không bao giờ thử lại cho người đó (trừ khi bấm "Làm mới tên").
//
// Dùng chung cho handleMessage, /api/threads/:key/refresh và refresh-all.
// ============================================================
const userInfoCache = new Map(); // userId -> { name, avatar, phone, at }
const groupInfoCache = new Map(); // groupId -> { name, avatar, at }
const META_TTL = 24 * 60 * 60 * 1000; // 24h
const ERROR_TTL = 60 * 1000; // lỗi thì thử lại sau 60s, không spam API từng tin

async function fetchThreadMeta(entry, threadId, isGroup, { existing = null, ownerName = null, force = false } = {}) {
  if (isGroup) {
    return await fetchGroupMeta(entry, threadId, { existing, force });
  }
  return await fetchUserMeta(entry, threadId, { existing, ownerName, force });
}

/**
 * Người thường 1-1: tên/avatar/phone lấy từ profile của chính người đó.
 *
 * ⚠️ KHÔNG dùng data.dName làm tên thread — dName là tên NGƯỜI GỬI tin nhắn.
 * Khi mình gửi tin cho A, dName = tên mình, không phải tên A.
 */
async function fetchUserMeta(entry, threadId, { existing = null, ownerName = null, force = false } = {}) {
  // --- Quy tắc 1: DB đã đủ dữ liệu -> bỏ qua API hoàn toàn ---
  const nameOk = !!existing?.name && (!ownerName || existing.name !== ownerName);
  const phoneAttempted = existing?.phone != null; // null/undefined = chưa từng lấy
  if (!force && nameOk && phoneAttempted) {
    const meta = {
      name: existing.name,
      avatar: existing.avatar || null,
      phone: existing.phone,
      at: Date.now(),
    };
    userInfoCache.set(threadId, meta);
    return meta;
  }

  // --- In-memory cache ngắn hạn ---
  const cached = userInfoCache.get(threadId);
  if (!force && cached && Date.now() - cached.at < (cached.error ? ERROR_TTL : META_TTL)) {
    return cached;
  }

  // --- Quy tắc 2: gọi API lấy profile của NGƯỜI KIA ---
  let name = null;
  let avatar = null;
  let phone = null;
  let ok = false;

  try {
    const info = await entry.api.getUserInfo(threadId);
    // Gộp cả changed/unchanged — Zalo có thể trả profile ở either
    const profiles = {
      ...(info?.unchanged_profiles || {}),
      ...(info?.changed_profiles || {}),
    };
    const profile = profiles[`${threadId}_0`] || profiles[String(threadId)] || null;
    if (profile) {
      name = profile.displayName || null;
      avatar = profile.avatar || null;
      // '' = đã thử lấy nhưng người này ẩn SĐT -> không thử lại nữa
      phone = profile.phoneNumber || existing?.phone || '';
      ok = true;
    }
  } catch {
    /* lỗi API — đánh dấu error, thử lại sau 60s */
  }

  const meta = { name, avatar, phone, at: Date.now(), error: !ok };
  userInfoCache.set(threadId, meta);
  return meta;
}

/**
 * Nhóm: tên + avatar nhóm từ getGroupInfo (không có phone).
 */
async function fetchGroupMeta(entry, threadId, { existing = null, force = false } = {}) {
  // Nhóm đã có tên -> dùng DB, không gọi API
  if (!force && existing?.name) {
    const meta = { name: existing.name, avatar: existing.avatar || null, phone: null, at: Date.now() };
    groupInfoCache.set(threadId, meta);
    return meta;
  }

  const cached = groupInfoCache.get(threadId);
  if (!force && cached && Date.now() - cached.at < (cached.error ? ERROR_TTL : META_TTL)) {
    return cached;
  }

  let name = null;
  let avatar = null;
  let ok = false;

  try {
    const info = await entry.api.getGroupInfo(String(threadId));
    const g = info?.gridInfoMap?.[String(threadId)];
    if (g) {
      name = g.name || null;
      avatar = g.fullAvt || g.avt || null;
      ok = true;
    }
  } catch {
    /* lỗi API */
  }

  const meta = { name, avatar, phone: null, at: Date.now(), error: !ok };
  groupInfoCache.set(threadId, meta);
  return meta;
}

// ============================================================
// Archive media lên R2 — tải từ Zalo CDN bằng cookie session,
// upload lên R2 để giữ vĩnh viễn (URL Zalo hết hạn).
// Không cấu hình R2 -> no-op, giữ nguyên URL Zalo.
// ============================================================
const MAX_VIDEO_BYTES = 100 * 1024 * 1024; // 100MB — video lớn hơn thì bỏ qua (URL vẫn giữ)

async function archiveMedia(entry, detected, accountId, msgId) {
  if (!mediaStore.isConfigured() || !detected.url) return null;

  try {
    // Headers tải từ Zalo CDN — cần cookie + UA của session (video cần auth)
    const session = loadAccountSession(accountId) || {};
    const headers = {
      'User-Agent': session.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      Referer: 'https://zalo.me/',
    };
    if (Array.isArray(session.cookie)) {
      headers.Cookie = session.cookie.map((c) => `${c.key || c.name}=${c.value}`).join('; ');
    }

    // Video có thể rất lớn — chỉ tải nếu content-length dưới ngưỡng
    if (detected.type === 'video') {
      try {
        const head = await axios.head(detected.url, { headers, timeout: 10_000 });
        const size = Number(head.headers['content-length'] || 0);
        if (size > MAX_VIDEO_BYTES) {
          console.log(`[media] Video ${(size / 1048576).toFixed(1)}MB > 100MB — giữ URL Zalo`);
          return null;
        }
      } catch {
        /* không HEAD được — thử tải luôn, axios sẽ hủy nếu quá maxContentLength */
      }
    }

    const res = await axios.get(detected.url, {
      responseType: 'arraybuffer',
      headers,
      timeout: 120_000,
      maxContentLength: MAX_VIDEO_BYTES,
    });

    const contentType = res.headers['content-type'] || '';
    const ext = contentType.includes('png') ? 'png'
      : contentType.includes('gif') ? 'gif'
      : contentType.includes('webp') ? 'webp'
      : contentType.includes('video') ? 'mp4'
      : 'jpg';

    // Key: <năm>/<tháng>/<accountId>/<msgId>.<ext> — gọn, dễ dọn theo thời gian
    const now = new Date();
    const key = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${accountId}/${msgId || Date.now()}.${ext}`;

    const saved = await mediaStore.uploadMedia(key, Buffer.from(res.data), contentType || undefined);
    if (saved) {
      console.log(`[media] Đã lưu ${detected.type} lên R2: ${key} (${(res.data.length / 1024).toFixed(0)}KB)`);
      return key;
    }
    return null;
  } catch (err) {
    console.error('[media] Lỗi archive media:', err?.message || err);
    return null;
  }
}

// ============================================================
// Media detection (từ bản cũ, đã kiểm chứng hoạt động)
// ============================================================
function detectMedia(content, msgType) {
  if (typeof content !== 'object' || !content) return null;

  // Video: msgType = chat.video.msg, content = TAttachmentContent (href = video URL)
  if (msgType === 'chat.video.msg' && content.href) {
    return { type: 'video', url: content.href, desc: content.description || '' };
  }

  // Fallback: href trỏ tới video CDN
  if (content.href && typeof content.href === 'string' &&
      (content.href.includes('video-') || content.href.includes('/video/'))) {
    return { type: 'video', url: content.href, desc: content.description || '' };
  }

  // Ảnh: oriUrl / normalUrl / hdUrl / thumb
  const imgUrl = content.oriUrl || content.normalUrl || content.hdUrl || content.thumb;
  if (imgUrl && typeof imgUrl === 'string') {
    return { type: 'photo', url: imgUrl, desc: content.desc || content.description || '' };
  }

  // Sticker
  if (content.stickerUrl) {
    return { type: 'sticker', url: content.stickerUrl, desc: '🎨 Sticker' };
  }

  return null;
}

module.exports = { handleMessage, fetchThreadMeta };
