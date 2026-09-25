# Zalo Archive (v2)

Lưu trữ toàn bộ tin nhắn **đến** và **đi** trên tài khoản Zalo cá nhân của bạn
(qua thư viện không chính thức [zca-js](https://github.com/RFS-ADRENO/zca-js)),
lưu vào SQLite và xem lại trên **web giao diện giống Zalo** — chỉ đọc.

## Tính năng

- **Web UI giống Zalo**: chat head cho mỗi người/nhóm, bong bóng tin nhắn
  đến/đi, ảnh/video/sticker hiển thị trực tiếp, tìm kiếm theo tên.
- **Đa tài khoản**: đăng nhập nhiều tài khoản Zalo bằng QR; mỗi tài khoản có
  lịch sử chat riêng, chuyển qua lại bằng thanh account ở đầu sidebar.
- **Tên + SĐT tự động**: tên hiển thị lấy từ profile của người đó (không nhầm
  với tên bạn khi chính bạn nhắn tin), kèm số điện thoại nếu người đó công khai
  — chỉ gọi API đúng 1 lần/người, không spam Zalo.
- **Chỉ đọc**: web không gửi tin nhắn — chỉ xem lại những gì đã lưu.
- **Quản lý theo dõi từng người/nhóm**:
  - *Tạm ngừng lưu*: ngừng lưu tin nhắn mới, giữ dữ liệu cũ, lưu lại được
  - *Gỡ vĩnh viễn*: xoá thread + dữ liệu và đưa vào blacklist — không bao giờ
    xuất hiện lại kể cả khi có tin nhắn mới (trừ khi chọn "Cho phép quay lại")
- **Archive media vĩnh viễn (tuỳ chọn — Cloudflare R2)**: ảnh/video được tải
  từ Zalo CDN và upload lên R2, vì URL Zalo CDN hết hạn sau vài ngày.
- **Tin nhắn real-time**: tin mới hiện ngay trên web (SSE), không cần refresh.
- **Session tự lưu**: sau khi quét QR lần đầu, các lần chạy sau tự đăng nhập
  lại (mỗi tài khoản một file session trong `data/sessions/`).

## ⚠️ Đọc trước khi dùng

`zca-js` mô phỏng giao thức của Zalo Web/PC — **đây không phải API chính
thức của Zalo**. Rủi ro:

- Zalo có thể phát hiện hoạt động bất thường và **tạm khoá hoặc khoá vĩnh
  viễn tài khoản**. Dùng trên tài khoản của chính bạn, có phương án backup.
- Thư viện có thể ngừng hoạt động bất cứ lúc nào nếu Zalo thay đổi giao thức.
- Chạy 1 listener cho mỗi tài khoản (mở Zalo Web song song cùng tài khoản sẽ
  làm listener của app bị ngắt kết nối).

## 1. Cài đặt & chạy

```bash
npm install
npm start
```

Mở `http://localhost:3000` trên trình duyệt:

1. Bấm **Đăng nhập bằng QR**.
2. Mở app Zalo trên điện thoại → **Cài đặt → Thiết bị đăng nhập → Quét mã QR**.
3. Xác nhận trên điện thoại. Sau vài giây web chuyển sang giao diện chat.

Muốn thêm tài khoản khác: bấm nút **＋** trên sidebar và quét QR bằng tài
khoản kia. Lịch sử chat của tài khoản nào hiện khi đang chọn tài khoản đó.

## 2. Cấu trúc dữ liệu

```
data/
├── messages.db          # SQLite: accounts, threads, messages
└── sessions/            # session mỗi tài khoản (cookie/imei/userAgent)
    └── <ownId>.json
```

Tin nhắn cũ từ bản bridge v1 (Telegram) sẽ được **tự động chuyển đổi** sang
schema mới khi chạy lần đầu (nằm dưới account "Tài khoản cũ").

Dung lượng: ~190 bytes/tin nhắn (media chỉ lưu URL/key, không lưu file trong
SQLite). 1 GB đĩa ≈ 5,7 triệu tin nhắn.

## 3. Quản lý theo dõi

Bấm nút **⚙** trên sidebar (hoặc **⋮** trong khung chat):

- **Tạm ngừng lưu** — ngừng lưu tin nhắn mới của người/nhóm đó, dữ liệu cũ
  giữ nguyên, có thể lưu lại bất cứ lúc nào.
- **Gỡ vĩnh viễn** — xoá thread + toàn bộ tin nhắn đã lưu và đưa vào
  blacklist. Người/nhóm đó KHÔNG xuất hiện lại kể cả khi có tin nhắn mới.
  Hoàn tác trong mục "Đã gỡ vĩnh viễn" dưới cùng của modal ⚙.
- **Làm mới tên** — gọi lại Zalo lấy tên/SĐT mới nhất của người đó (dùng khi
  người đó đổi tên, kết bạn sau, hoặc mở quyền hiển thị SĐT).
- **Làm mới tất cả** — sửa hàng loạt thread thiếu tên/SĐT trong một cú bấm.

## 4. Archive media lên Cloudflare R2 (tuỳ chọn)

Ảnh/video chỉ lưu URL trong DB — nhưng **URL Zalo CDN hết hạn sau vài ngày**.
Muốn archive vĩnh viễn:

1. Tạo account [Cloudflare](https://dash.cloudflare.com) → **R2** → tạo bucket.
2. **R2 → Manage API Tokens → Create API Token** (Object Read & Write).
3. Điền vào `.env` (xem mẫu trong `.env.example`):

```
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET=zalo-media
R2_PUBLIC_BASE=          # tuỳ chọn — nếu bật public access cho bucket
```

4. Restart. Mọi ảnh/video mới tự upload lên R2. Free tier 10 GB, zero egress.

Không cấu hình R2 = app vẫn chạy bình thường, media sống theo tuổi thọ URL Zalo.

## 5. API (tuỳ chọn)

| Endpoint | Mô tả |
|---|---|
| `POST /api/auth/qr/start` | Bắt đầu flow đăng nhập QR |
| `GET /api/auth/qr/status` | Trạng thái flow QR |
| `GET /api/accounts` | Danh sách tài khoản |
| `GET /api/threads?accountId=...` | Danh sách cuộc trò chuyện |
| `POST /api/threads/:key/refresh` | Làm mới tên/SĐT một thread |
| `POST /api/threads/refresh-all` | Làm mới tất cả thread của 1 tài khoản |
| `GET /api/messages?threadKey=...` | Tin nhắn (phân trang `&before=<id>`) |
| `GET /api/media?url=...` | Stream media (R2 hoặc Zalo CDN) |
| `GET /api/events` | SSE tin nhắn mới theo thời gian thực |
| `GET /health` | Health check |

## 6. Deploy 24/24

### Phương án A — Hoàn toàn MIỄN PHÍ ($0/tháng)

```
Render free (app) + Supabase Postgres free (DB) + UptimeRobot (keep-alive)
```

1. **Supabase**: tạo project tại [supabase.com](https://supabase.com) →
   Project Settings → Database → copy **Connection string (URI)**.
2. **Render**: Dashboard → New → **Blueprint** → chọn repo. Điền biến:
   - `WEB_USER`, `WEB_PASSWORD` (bắt buộc)
   - `DATABASE_URL` (bắt buộc — URI Supabase vừa copy)
   - `R2_*` (tuỳ chọn)
3. **UptimeRobot** ([uptimerobot.com](https://uptimerobot.com), free):
   thêm HTTP monitor ping `https://<app>.onrender.com/health` mỗi 5 phút.

⚠️ **Bước 3 là bắt buộc**: Render free ngủ sau 15 phút không có traffic —
WebSocket Zalo đứt và **tin nhắn trong lúc ngủ bị mất vĩnh viễn**. Ping mỗi
5 phút giữ service luôn thức.

Sau khi deploy: mở web → đăng nhập `WEB_USER`/`WEB_PASSWORD` → quét QR Zalo.

### Phương án B — Ổn định nhất ($7/tháng)

Render **Starter** + persistent disk 1GB: dùng `render.yaml` nhưng đổi
`plan: free` → `plan: starter` và thêm disk như Blueprint cũ trong git history.
SQLite chạy local trên disk, không cần DATABASE_URL, không sợ ngủ.

### Chạy local / VPS riêng

```bash
pm2 start ecosystem.config.js
```

Không cần DATABASE_URL — SQLite dùng ngay.

### Bảo mật web (basic auth)

Khi deploy công khai (Render/VPS) — **bắt buộc** điền vào `.env`:

```
WEB_USER=zalo
WEB_PASSWORD=mat-khau-cua-ban
```

Restart server → web hiện hộp đăng nhập của trình duyệt. Nút **⎋** trên
sidebar để đăng xuất. Endpoint `/health` được miễn xác thực để uptime monitor
vẫn hoạt động. Chạy local thì có thể bỏ trống — web mở tự do như cũ.

## 7. So với bản v1 (bridge Telegram)

| | v1 (bridge) | v2 (archive) |
|---|---|---|
| Xem tin nhắn | Qua Telegram bot | Web UI giống Zalo |
| Đa tài khoản | ❌ | ✅ (mỗi tài khoản 1 session riêng) |
| Tên + SĐT người chat | ❌ | ✅ (tự động, 1 lần/người) |
| Chọn lưu/không lưu | ❌ | ✅ (từng người/nhóm + blacklist vĩnh viễn) |
| Media vĩnh viễn | ❌ (URL hết hạn) | ✅ (R2, tuỳ chọn) |
| Gửi tin nhắn | POST /send | ❌ (chỉ đọc) |
| Báo cáo định kỳ | ✅ cron | ❌ (không cần — xem trực tiếp) |
