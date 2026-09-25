const crypto = require('crypto');
const axios = require('axios');

/**
 * Lưu media (ảnh/video/sticker) lên Cloudflare R2 (S3-compatible).
 *
 * - Không dùng SDK AWS (nặng) — tự ký request theo AWS Signature V4,
 *   chỉ cần axios đã có sẵn.
 * - Nếu chưa cấu hình R2 (thiếu env) -> mọi hàm no-op, app chạy như cũ
 *   (media vẫn dùng URL Zalo trực tiếp).
 *
 * Env cần thiết:
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_BASE (optional)
 */

// Đọc env ĐỘNG (mỗi lần dùng) — tránh thứ tự require trước khi dotenv load
function cfg() {
  return {
    accountId: process.env.R2_ACCOUNT_ID || '',
    accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
    bucket: process.env.R2_BUCKET || '',
    publicBase: process.env.R2_PUBLIC_BASE || '',
  };
}

function isConfigured() {
  const c = cfg();
  return !!(c.accountId && c.accessKeyId && c.secretAccessKey && c.bucket);
}

// ============================================================
// AWS Signature V4 (chỉ đủ cho R2: PUT/GET object, service s3)
// ============================================================
function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

/**
 * Tạo Authorization header cho S3 request.
 */
function signRequest({ method, host, path, queryParams = {}, body = '', contentType = '' }) {
  const { accessKeyId, secretAccessKey } = cfg();
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // 20260925T071234Z
  const dateStamp = amzDate.slice(0, 8);
  const region = 'auto'; // R2 dùng 'auto'
  const service = 's3';
  const payloadHash = sha256Hex(body);

  // Canonical query string — sort keys
  const sortedQuery = Object.keys(queryParams)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(queryParams[k])}`)
    .join('&');

  const canonicalUri = path
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');

  const canonicalHeaders =
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';

  const canonicalRequest = [
    method,
    canonicalUri,
    sortedQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    headers: {
      Host: host,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
      Authorization: authorization,
      ...(contentType ? { 'Content-Type': contentType } : {}),
    },
    url: `https://${host}${canonicalUri}${sortedQuery ? '?' + sortedQuery : ''}`,
  };
}

// ============================================================
// Public API
// ============================================================

/**
 * Upload buffer lên R2.
 * @param {string} key đường dẫn object, ví dụ "2026/09/msg_123/photo.jpg"
 * @param {Buffer} buffer dữ liệu file
 * @param {string} contentType mime type
 * @returns {Promise<string|null>} key đã lưu, hoặc null nếu R2 chưa cấu hình/lỗi
 */
async function uploadMedia(key, buffer, contentType) {
  if (!isConfigured()) return null;
  const { accountId, bucket } = cfg();

  const host = `${accountId}.r2.cloudflarestorage.com`;
  const path = `/${bucket}/${key}`;

  const { headers, url } = signRequest({
    method: 'PUT',
    host,
    path,
    body: buffer,
    contentType: contentType || 'application/octet-stream',
  });

  try {
    await axios.put(url, buffer, {
      headers,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 120_000,
    });
    return key;
  } catch (err) {
    console.error('[r2] Upload thất bại:', err?.response?.status || '', err?.message);
    return null;
  }
}

/**
 * Tạo stream đọc file từ R2 (để /api/media pipe về browser).
 * @returns {Promise<{stream, contentType}|null>} null nếu không có/lỗi
 */
async function getMediaStream(key, range) {
  if (!isConfigured()) return null;
  const { accountId, bucket } = cfg();

  const host = `${accountId}.r2.cloudflarestorage.com`;
  const path = `/${bucket}/${key}`;

  const { headers } = signRequest({
    method: 'GET',
    host,
    path,
    body: '',
  });
  if (range) headers.Range = range;

  try {
    const res = await axios.get(`https://${host}${path}`, {
      headers,
      responseType: 'stream',
      timeout: 120_000,
      maxContentLength: Infinity,
      validateStatus: (s) => s === 200 || s === 206,
    });
    return { stream: res.data, contentType: res.headers['content-type'] || 'application/octet-stream' };
  } catch (err) {
    console.error('[r2] Đọc thất bại:', err?.response?.status || '', err?.message);
    return null;
  }
}

/**
 * Nếu bucket public (R2_PUBLIC_BASE được set), trả URL trực tiếp —
 * nhanh hơn và giảm tải cho server.
 */
function getPublicUrl(key) {
  const { publicBase } = cfg();
  if (!isConfigured() || !publicBase) return null;
  return `${publicBase.replace(/\/$/, '')}/${key}`;
}

module.exports = { isConfigured, uploadMedia, getMediaStream, getPublicUrl };
