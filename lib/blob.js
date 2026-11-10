// Vercel Blob over its REST API (the same calls the official @vercel/blob SDK makes; no dependency).
// The token comes from BLOB_READ_WRITE_TOKEN, which Vercel sets when a Blob store is connected to the project.
'use strict';

const API = 'https://vercel.com/api/blob';
const VERSION = '11';

// fetch()-shaped client over HTTP/1.1 (Node's https module). Node's built-in fetch can negotiate HTTP/2 with
// the Blob API, and large uploads then fail with ERR_HTTP2_STREAM_ERROR; HTTP/1.1 avoids that.
function http1Fetch(url, init = {}) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const body = init.body == null ? null : Buffer.from(init.body);
    const req = https.request(url, { method: init.method || 'GET', headers: { ...(init.headers || {}), ...(body ? { 'content-length': body.length } : {}) }, timeout: 60000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text: async () => text, json: async () => JSON.parse(text) });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const headers = (token, extra) => ({ authorization: `Bearer ${token}`, 'x-api-version': VERSION, ...extra });

// Public URL base of the store: the store ID is the fourth part of the token (vercel_blob_rw_<storeId>_<secret>).
function publicBase(token) {
  const id = String(token || '').split('_')[3];
  return id ? `https://${id.toLowerCase()}.public.blob.vercel-storage.com` : null;
}

// Retries network errors and 429/5xx up to 4 times with backoff (the Blob API drops streams under load).
async function call(fetchFn, url, init, what, { retries = 4, wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res = null; let err = null;
    try { res = await fetchFn(url, init); } catch (e) { err = e; }
    if (res && res.ok) return res.json();
    const retryable = err || res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= retries) {
      if (err) throw new Error(`Blob ${what} failed: ${[err.message, err.cause && (err.cause.code || err.cause.message)].filter(Boolean).join(': ')}`);
      throw new Error(`Blob ${what} failed: HTTP ${res.status}`);
    }
    await wait(500 * 2 ** attempt + Math.floor(Math.random() * 250));
  }
}

// Upload (overwriting) one file. cacheSeconds sets the CDN cache time (minimum 60).
function put(fetchFn, token, pathname, body, { contentType = 'application/json', cacheSeconds = 2592000 } = {}) {
  return call(fetchFn, `${API}/?${new URLSearchParams({ pathname })}`, {
    method: 'PUT', body,
    headers: headers(token, { 'x-content-type': contentType, 'x-add-random-suffix': '0', 'x-allow-overwrite': '1', 'x-cache-control-max-age': String(cacheSeconds) }),
  }, 'upload');
}

// Every blob under a prefix.
async function list(fetchFn, token, prefix) {
  const out = []; let cursor = null;
  do {
    const q = new URLSearchParams({ prefix, limit: '1000' }); if (cursor) q.set('cursor', cursor);
    const d = await call(fetchFn, `${API}?${q}`, { headers: headers(token) }, 'list');
    out.push(...(d.blobs || [])); cursor = d.hasMore ? d.cursor : null;
  } while (cursor);
  return out;
}

async function del(fetchFn, token, urls) {
  for (let i = 0; i < urls.length; i += 500) {
    await call(fetchFn, `${API}/delete`, { method: 'POST', headers: headers(token, { 'content-type': 'application/json' }), body: JSON.stringify({ urls: urls.slice(i, i + 500) }) }, 'delete');
  }
}

module.exports = { put, list, del, publicBase, http1Fetch };
