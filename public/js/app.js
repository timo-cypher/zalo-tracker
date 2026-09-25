// ============================================================
// Zalo Archive — web app (read-only)
// ============================================================

const state = {
  accounts: [],
  currentAccount: null,
  threads: [],
  currentThread: null,
  messages: [],
  oldestId: null,
  hasMore: false,
  searchQuery: '',
  eventSource: null,
};

const $ = (id) => document.getElementById(id);

// ============================================================
// API helpers
// ============================================================
async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (res.status === 401) {
    // Mất đăng nhập web (basic auth) — reload để browser hiện hộp đăng nhập
    window.location.reload();
    throw new Error('Cần đăng nhập');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ============================================================
// Init
// ============================================================
async function init() {
  await refreshAccounts();

  if (state.accounts.length === 0) {
    $('empty-screen').classList.remove('hidden');
    $('app').classList.add('hidden');
  } else {
    $('empty-screen').classList.add('hidden');
    $('app').classList.remove('hidden');
    renderAccountBar();
    await selectAccount(state.accounts[0]?.id);
  }

  connectSSE();
}

async function refreshAccounts() {
  state.accounts = await api('/api/accounts');
}

// ============================================================
// Accounts
// ============================================================
function renderAccountBar() {
  const bar = $('account-bar');
  bar.innerHTML = '';

  for (const acc of state.accounts) {
    const chip = document.createElement('button');
    chip.className = 'account-chip' + (acc.id === state.currentAccount ? ' active' : '') +
      (acc.connected ? ' connected' : '');
    chip.title = acc.name || acc.id;

    const img = document.createElement('img');
    img.src = avatarUrl(acc.avatar, acc.name || acc.id);
    img.onerror = () => { img.src = fallbackAvatar(acc.name || acc.id); };

    const name = document.createElement('div');
    name.className = 'account-name';
    name.textContent = acc.name || acc.id.slice(0, 8);

    const dot = document.createElement('div');
    dot.className = 'status-dot';

    chip.append(img, name, dot);
    chip.onclick = () => selectAccount(acc.id);
    bar.appendChild(chip);
  }
}

async function selectAccount(accountId) {
  state.currentAccount = accountId;
  state.currentThread = null;
  renderAccountBar();
  await loadThreads();
  showChatPlaceholder();
}

// ============================================================
// Threads (chat heads)
// ============================================================
async function loadThreads() {
  if (!state.currentAccount) return;
  state.threads = await api(`/api/threads?accountId=${encodeURIComponent(state.currentAccount)}`);
  renderThreadList();
}

function renderThreadList() {
  const list = $('thread-list');
  list.innerHTML = '';

  const query = state.searchQuery.trim().toLowerCase();
  const filtered = query
    ? state.threads.filter((t) => (t.name || '').toLowerCase().includes(query))
    : state.threads;

  if (filtered.length === 0) {
    const note = document.createElement('div');
    note.className = 'empty-note';
    note.textContent = query ? 'Không tìm thấy cuộc trò chuyện nào.' : 'Chưa có cuộc trò chuyện nào.';
    list.appendChild(note);
    return;
  }

  for (const t of filtered) {
    const item = document.createElement('div');
    item.className = 'thread-item' + (t.key === state.currentThread?.key ? ' active' : '');

    const img = document.createElement('img');
    img.className = 'thread-avatar' + (t.isGroup ? ' group' : '');
    img.src = avatarUrl(t.avatar, t.name || t.threadId);
    img.onerror = () => { img.src = fallbackAvatar(t.name || t.threadId); };

    const info = document.createElement('div');
    info.className = 'thread-info';
    const name = document.createElement('div');
    name.className = 'thread-name';
    name.append(document.createTextNode(t.name || t.threadId));
    if (t.phone) {
      const phoneSpan = document.createElement('span');
      phoneSpan.className = 'thread-phone';
      phoneSpan.textContent = t.phone;
      name.appendChild(phoneSpan);
    }
    const preview = document.createElement('div');
    preview.className = 'thread-preview';
    preview.textContent = t.lastMsgPreview || '—';
    info.append(name, preview);

    const time = document.createElement('div');
    time.className = 'thread-time';
    time.textContent = t.lastMsgAt ? formatTime(t.lastMsgAt) : '';

    item.append(img, info, time);
    item.onclick = () => openThread(t);
    list.appendChild(item);
  }
}

async function openThread(t) {
  state.currentThread = t;
  document.querySelector('.app').classList.add('chat-open');
  renderThreadList(); // update active highlight

  $('chat-empty').classList.add('hidden');
  $('chat-view').classList.remove('hidden');

  $('chat-name').textContent = t.name || t.threadId;
  $('chat-sub').textContent = t.isGroup
    ? 'Nhóm'
    : (t.phone ? `SĐT: ${t.phone}` : 'Bạn bè');
  state._forceScroll = true;
  const avatar = $('chat-avatar');
  avatar.src = avatarUrl(t.avatar, t.name || t.threadId);
  avatar.onerror = () => { avatar.src = fallbackAvatar(t.name || t.threadId); };

  // Reset menu
  $('thread-menu').classList.add('hidden');
  updateMenuButtons();

  await loadMessages(t.key, { reset: true });
}

function updateMenuButtons() {
  const t = state.currentThread;
  if (!t) return;
  $('btn-stop-tracking').textContent = t.isTracked
    ? '⏸ Tạm ngừng lưu tin nhắn người này'
    : '▶ Lưu lại tin nhắn người này';
}

// ============================================================
// Messages
// ============================================================
async function loadMessages(threadKey, { reset = false, before = null } = {}) {
  if (reset) {
    state.messages = [];
    state.oldestId = null;
    state.hasMore = true;
  }

  if (!state.hasMore && !reset) return;

  let url = `/api/messages?threadKey=${encodeURIComponent(threadKey)}&limit=50`;
  const cursor = before || state.oldestId;
  if (cursor) url += `&before=${cursor}`;

  const batch = await api(url);

  if (reset) {
    state.messages = batch;
  } else {
    // prepend older messages
    state.messages = [...batch, ...state.messages];
  }

  state.hasMore = batch.length === 50;
  if (batch.length > 0) {
    state.oldestId = state.messages[0].id;
  }

  renderMessages();
}

// Append 1 tin nhắn mới (SSE) — không re-render toàn bộ để giữ
// trạng thái video đang phát / vị trí scroll
function appendMessage(m) {
  state.messages.push(m);

  const list = $('message-list');
  const wasAtBottom = isNearBottom(list);

  const day = new Date(m.created_at).toDateString();
  if (day !== state._lastDay) {
    list.appendChild(dateSeparator(m.created_at));
    state._lastDay = day;
    state._lastSender = null;
  }

  const isOut = m.direction === 'out';
  if (state.currentThread?.isGroup && !isOut && m.sender_id !== state._lastSender) {
    const senderLine = document.createElement('div');
    senderLine.className = 'msg-sender';
    senderLine.textContent = m.sender_name || m.sender_id;
    list.appendChild(senderLine);
  }
  state._lastSender = m.sender_id;

  list.appendChild(buildMessageRow(m));
  if (wasAtBottom) scrollToBottom();
}

function buildMessageRow(m) {
  const isOut = m.direction === 'out';
  const row = document.createElement('div');
  row.className = `msg-row ${isOut ? 'out' : 'in'}`;

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';

  if (m.msg_type === 'photo' || m.msg_type === 'sticker') {
    const img = document.createElement('img');
    img.className = 'msg-media';
    img.src = `/api/media?url=${encodeURIComponent(m.media_url)}`;
    img.onclick = () => window.open(img.src, '_blank');
    bubble.appendChild(img);
    if (m.content && m.content !== '[Ảnh]' && m.content !== '[Sticker]') {
      const cap = document.createElement('div');
      cap.textContent = m.content;
      bubble.appendChild(cap);
    }
  } else if (m.msg_type === 'video') {
    const video = document.createElement('video');
    video.className = 'msg-media video';
    video.controls = true;
    video.src = `/api/media?url=${encodeURIComponent(m.media_url)}`;
    bubble.appendChild(video);
  } else {
    bubble.textContent = m.content;
  }

  const time = document.createElement('div');
  time.className = 'msg-time';
  time.textContent = new Date(m.created_at).toLocaleTimeString('vi-VN', {
    hour: '2-digit',
    minute: '2-digit',
  });

  row.append(bubble, time);
  return row;
}

function renderMessages() {
  const list = $('message-list');
  const wasAtBottom = isNearBottom(list);
  list.innerHTML = '';

  state._lastDay = null;
  state._lastSender = null;

  for (const m of state.messages) {
    const day = new Date(m.created_at).toDateString();
    if (day !== state._lastDay) {
      list.appendChild(dateSeparator(m.created_at));
      state._lastDay = day;
      state._lastSender = null;
    }

    const isOut = m.direction === 'out';
    if (state.currentThread?.isGroup && !isOut && m.sender_id !== state._lastSender) {
      const senderLine = document.createElement('div');
      senderLine.className = 'msg-sender';
      senderLine.textContent = m.sender_name || m.sender_id;
      list.appendChild(senderLine);
    }
    state._lastSender = m.sender_id;

    list.appendChild(buildMessageRow(m));
  }

  if (wasAtBottom || state._forceScroll) {
    scrollToBottom();
    state._forceScroll = false;
  }
  $('load-more').classList.toggle('hidden', !state.hasMore);
}

function dateSeparator(iso) {
  const div = document.createElement('div');
  div.className = 'msg-date-sep';
  const span = document.createElement('span');
  span.textContent = formatDate(iso);
  div.appendChild(span);
  return div;
}

function isNearBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
}
function scrollToBottom() {
  const list = $('message-list');
  list.scrollTop = list.scrollHeight;
}

// ============================================================
// SSE — tin nhắn mới
// ============================================================
function connectSSE() {
  if (state.eventSource) state.eventSource.close();
  const es = new EventSource('/api/events');
  state.eventSource = es;

  es.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }

    // Cập nhật preview/thread list
    const idx = state.threads.findIndex((t) => t.key === msg.threadKey);
    if (idx >= 0) {
      state.threads[idx].lastMsgPreview = msg.content;
      state.threads[idx].lastMsgAt = msg.createdAt;
      const [t] = state.threads.splice(idx, 1);
      state.threads.unshift(t);
    } else {
      // Thread mới — reload danh sách
      loadThreads();
    }
    renderThreadList();

    // Nếu đang mở đúng thread này -> append tin nhắn
    if (state.currentThread && msg.threadKey === state.currentThread.key) {
      appendMessage({
        id: msg.id,
        direction: msg.direction,
        sender_id: msg.senderId,
        sender_name: msg.senderName,
        content: msg.content,
        msg_type: msg.msgType,
        media_url: msg.mediaUrl,
        created_at: msg.createdAt,
      });
    }
  };
}

// ============================================================
// QR login
// ============================================================
async function openQrModal() {
  $('qr-modal').classList.remove('hidden');
  $('qr-overlay').classList.add('hidden');
  $('qr-spinner').classList.remove('hidden');
  $('qr-status').textContent = 'Đang tạo mã QR...';
  $('qr-image').src = '';

  try {
    const res = await api('/api/auth/qr/start', { method: 'POST' });
    if (!res.ok) {
      showQrState(res.error, true);
      return;
    }
    $('qr-image').src = res.image;
    $('qr-status').textContent = 'Quét mã bằng app Zalo trên điện thoại';
    pollQrStatus();
  } catch (err) {
    showQrState(err.message, true);
  }
}

let qrPollTimer = null;
function pollQrStatus() {
  clearInterval(qrPollTimer);
  qrPollTimer = setInterval(async () => {
    try {
      const s = await api('/api/auth/qr/status');
      if (!s.active) {
        clearInterval(qrPollTimer);
        return;
      }
      if (s.status === 'scanned') {
        $('qr-status').textContent = `Đã quét — hãy xác nhận trên điện thoại (${s.accountName || ''})`;
      } else if (s.status === 'done') {
        clearInterval(qrPollTimer);
        $('qr-spinner').classList.add('hidden');
        $('qr-status').textContent = `Đăng nhập thành công: ${s.accountName || ''}`;
        await refreshAccounts();
        if (state.accounts.length === 1) {
          // Lần đầu có tài khoản -> vào app luôn
          $('empty-screen').classList.add('hidden');
          $('app').classList.remove('hidden');
          renderAccountBar();
          await selectAccount(state.accounts[0].id);
        } else {
          renderAccountBar();
        }
        setTimeout(() => $('qr-modal').classList.add('hidden'), 800);
      } else if (s.status === 'expired') {
        showQrState('Mã QR đã hết hạn.', true);
      } else if (s.status === 'declined') {
        showQrState('Yêu cầu đăng nhập bị từ chối trên điện thoại.', true);
      } else if (s.status === 'error') {
        showQrState(s.error || 'Lỗi không xác định', true);
      }
    } catch {
      /* tạm thời — poll tiếp */
    }
  }, 1500);
}

function showQrState(text, showRetry) {
  $('qr-spinner').classList.add('hidden');
  $('qr-overlay').classList.remove('hidden');
  $('qr-overlay-text').textContent = text;
  $('btn-qr-retry').classList.toggle('hidden', !showRetry);
  $('qr-status').textContent = '';
}

function closeQrModal() {
  $('qr-modal').classList.add('hidden');
  clearInterval(qrPollTimer);
  api('/api/auth/qr/cancel', { method: 'POST' }).catch(() => {});
}

// ============================================================
// Quản lý theo dõi
// ============================================================
async function openManageModal() {
  $('manage-modal').classList.remove('hidden');
  await renderManageList();
}

async function renderManageList() {
  const list = $('manage-list');
  list.innerHTML = '<div class="empty-note">Đang tải...</div>';

  const threads = await api(
    `/api/threads?accountId=${encodeURIComponent(state.currentAccount)}&includeUntracked=1`
  );
  const removed = await api(
    `/api/threads/removed?accountId=${encodeURIComponent(state.currentAccount)}`
  );

  list.innerHTML = '';

  if (threads.length === 0 && removed.length === 0) {
    list.innerHTML = '<div class="empty-note">Chưa có cuộc trò chuyện nào.</div>';
    return;
  }

  // === Danh sách đang tương tác ===
  for (const t of threads) {
    const item = document.createElement('div');
    item.className = 'manage-item';

    const img = document.createElement('img');
    img.src = avatarUrl(t.avatar, t.name || t.threadId);
    img.onerror = () => { img.src = fallbackAvatar(t.name || t.threadId); };

    const info = document.createElement('div');
    info.className = 'manage-info';
    const name = document.createElement('div');
    name.className = 'manage-name';
    name.textContent = (t.isGroup ? '👥 ' : '') + (t.name || t.threadId) +
      (t.phone ? ` · ${t.phone}` : '');
    const sub = document.createElement('div');
    sub.className = 'manage-sub';
    sub.textContent = t.isTracked
      ? 'Đang lưu tin nhắn'
      : 'Tạm dừng — tin nhắn mới không được lưu';
    info.append(name, sub);

    const actions = document.createElement('div');
    actions.className = 'manage-actions';

    const refreshBtn = document.createElement('button');
    refreshBtn.textContent = 'Làm mới tên';
    refreshBtn.onclick = async () => {
      refreshBtn.disabled = true;
      refreshBtn.textContent = '...';
      try {
        await api(`/api/threads/${encodeURIComponent(t.key)}/refresh`, { method: 'POST' });
        await renderManageList();
        await loadThreads();
      } catch (err) {
        alert('Không làm mới được: ' + err.message);
        refreshBtn.disabled = false;
        refreshBtn.textContent = 'Làm mới tên';
      }
    };

    const toggleBtn = document.createElement('button');
    toggleBtn.textContent = t.isTracked ? 'Ngừng lưu' : 'Lưu lại';
    toggleBtn.onclick = async () => {
      await api(`/api/threads/${encodeURIComponent(t.key)}/tracking`, {
        method: 'POST',
        body: JSON.stringify({ tracked: !t.isTracked }),
      });
      await renderManageList();
      await loadThreads();
    };

    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = 'Gỡ vĩnh viễn';
    deleteBtn.className = 'danger';
    deleteBtn.onclick = async () => {
      if (!confirm(`Gỡ vĩnh viễn "${t.name || t.threadId}"?\n\nToàn bộ tin nhắn đã lưu sẽ bị XOÁ và người/nhóm này sẽ KHÔNG xuất hiện lại kể cả khi có tin nhắn mới.`)) return;
      await api(`/api/threads/${encodeURIComponent(t.key)}`, { method: 'DELETE' });
      await renderManageList();
      await loadThreads();
      if (state.currentThread?.key === t.key) showChatPlaceholder();
    };

    actions.append(refreshBtn, toggleBtn, deleteBtn);
    item.append(img, info, actions);
    list.appendChild(item);
  }

  // === Danh sách đã gỡ vĩnh viễn ===
  if (removed.length > 0) {
    const heading = document.createElement('div');
    heading.className = 'manage-heading';
    heading.textContent = 'Đã gỡ vĩnh viễn';
    list.appendChild(heading);

    for (const t of removed) {
      const item = document.createElement('div');
      item.className = 'manage-item removed';

      const img = document.createElement('img');
      img.src = fallbackAvatar(t.name);

      const info = document.createElement('div');
      info.className = 'manage-info';
      const name = document.createElement('div');
      name.className = 'manage-name';
      name.textContent = (t.isGroup ? '👥 ' : '') + (t.name || t.threadId);
      const sub = document.createElement('div');
      sub.className = 'manage-sub';
      sub.textContent = 'Đã xoá dữ liệu — không lưu tin nhắn mới';
      info.append(name, sub);

      const actions = document.createElement('div');
      actions.className = 'manage-actions';

      const undoBtn = document.createElement('button');
      undoBtn.textContent = 'Cho phép quay lại';
      undoBtn.onclick = async () => {
        await api(`/api/threads/${encodeURIComponent(t.key)}/unremove`, { method: 'POST' });
        await renderManageList();
      };

      actions.append(undoBtn);
      item.append(img, info, actions);
      list.appendChild(item);
    }
  }
}

function showChatPlaceholder() {
  document.querySelector('.app').classList.remove('chat-open');
  $('chat-view').classList.add('hidden');
  $('chat-empty').classList.remove('hidden');
  state.currentThread = null;
}

// ============================================================
// Helpers
// ============================================================
function avatarUrl(avatar, seed) {
  return avatar ? `/api/avatar?url=${encodeURIComponent(avatar)}` : fallbackAvatar(seed);
}

function fallbackAvatar(seed) {
  const initials = (seed || '?')
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96">
    <rect width="100%" height="100%" rx="48" fill="#a5c8f0"/>
    <text x="50%" y="50%" dy="0.36em" text-anchor="middle"
      font-family="Arial" font-size="38" fill="#fff">${escapeHtml(initials)}</text>
  </svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"]/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  }[c]));
}

function formatTime(iso) {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
}

function formatDate(iso) {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Hôm nay';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Hôm qua';
  return d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// ============================================================
// Event wiring
// ============================================================
$('btn-open-login').onclick = openQrModal;
$('btn-add-account').onclick = openQrModal;
$('btn-manage').onclick = openManageModal;
$('btn-close-qr').onclick = closeQrModal;
$('btn-close-manage').onclick = () => $('manage-modal').classList.add('hidden');

// Đăng xuất khỏi web (basic auth): gọi /logout với user/pass sai để browser
// xoá thông tin đã lưu, rồi reload -> hiện lại hộp đăng nhập
$('btn-logout').onclick = async () => {
  try {
    await fetch('/logout', { headers: { Authorization: 'Basic ' + btoa('logout:logout') } });
  } catch { /* bỏ qua */ }
  window.location.reload();
};

$('btn-refresh-all').onclick = async () => {
  const btn = $('btn-refresh-all');
  btn.disabled = true;
  btn.textContent = 'Đang làm mới... (có thể mất vài giây)';
  try {
    const res = await api('/api/threads/refresh-all', {
      method: 'POST',
      body: JSON.stringify({ accountId: state.currentAccount }),
    });
    const updated = res.results.filter((r) => r.updated).length;
    btn.textContent = `Xong — ${updated}/${res.total} thread được cập nhật`;
    await renderManageList();
    await loadThreads();
  } catch (err) {
    btn.textContent = 'Lỗi: ' + err.message;
  } finally {
    btn.disabled = false;
    setTimeout(() => { btn.textContent = '🔄 Làm mới tất cả tên & SĐT từ Zalo'; }, 4000);
  }
};
$('btn-qr-retry').onclick = openQrModal;

$('btn-thread-menu').onclick = () => $('thread-menu').classList.toggle('hidden');

$('btn-refresh-name').onclick = async () => {
  const t = state.currentThread;
  if (!t) return;
  $('thread-menu').classList.add('hidden');
  try {
    await api(`/api/threads/${encodeURIComponent(t.key)}/refresh`, { method: 'POST' });
    await loadThreads();
    // Mở lại thread với dữ liệu mới
    const fresh = state.threads.find((x) => x.key === t.key);
    if (fresh) await openThread(fresh);
  } catch (err) {
    alert('Không làm mới được tên: ' + err.message);
  }
};

$('btn-stop-tracking').onclick = async () => {
  const t = state.currentThread;
  if (!t) return;
  await api(`/api/threads/${encodeURIComponent(t.key)}/tracking`, {
    method: 'POST',
    body: JSON.stringify({ tracked: !t.isTracked }),
  });
  t.isTracked = !t.isTracked;
  updateMenuButtons();
  await loadThreads();
};

$('btn-delete-thread').onclick = async () => {
  const t = state.currentThread;
  if (!t) return;
  if (!confirm(`Gỡ vĩnh viễn "${t.name || t.threadId}"?\n\nToàn bộ tin nhắn đã lưu sẽ bị XOÁ và người/nhóm này sẽ KHÔNG xuất hiện lại kể cả khi có tin nhắn mới.`)) return;
  await api(`/api/threads/${encodeURIComponent(t.key)}`, { method: 'DELETE' });
  await loadThreads();
  showChatPlaceholder();
};

$('search-input').oninput = (e) => {
  state.searchQuery = e.target.value;
  renderThreadList();
};

$('load-more').querySelector('button').onclick = () => {
  if (state.currentThread) loadMessages(state.currentThread.key, { reset: false });
};

document.addEventListener('click', (e) => {
  // Đóng thread menu khi bấm ra ngoài
  if (!e.target.closest('#thread-menu') && !e.target.closest('#btn-thread-menu')) {
    $('thread-menu').classList.add('hidden');
  }
});

// ============================================================
// Start
// ============================================================
init();
