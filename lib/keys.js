// API keys for trusted server-to-server callers of the /v1/ routes.
//
// COMPANY_LOOKUP_API_KEYS holds `name:sha256hex` pairs, separated by commas, spaces or new lines,
// e.g. "trade-credit-monitor:3f1c…". Only hashes are stored, never raw keys. Make a key with
// `node scripts/new-api-key.js <name>`.
//
// A caller sends the key as `Authorization: Bearer <key>` or `X-Api-Key: <key>`. A valid key gives
// the caller its own, higher rate limit and its name in logs. A missing, unknown or malformed key is
// treated exactly like an anonymous caller: never an error.
'use strict';

const crypto = require('crypto');

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HASH_RE = /^[0-9a-f]{64}$/;

const sha256 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest();

/** Parses COMPANY_LOOKUP_API_KEYS into [{ name, hash: Buffer }]. Malformed entries are skipped. */
function parseKeys(raw) {
  if (!raw) return [];
  const out = [];
  for (const part of String(raw).split(/[\s,]+/)) {
    const i = part.lastIndexOf(':');
    if (i < 1) continue;
    const name = part.slice(0, i);
    const hash = part.slice(i + 1).toLowerCase();
    if (NAME_RE.test(name) && HASH_RE.test(hash)) out.push({ name, hash: Buffer.from(hash, 'hex') });
  }
  return out;
}

/** The raw key a request carries, or null. */
function keyFrom(req) {
  const h = (req && req.headers) || {};
  const auth = h.authorization || h.Authorization;
  if (auth) {
    const m = String(auth).match(/^\s*Bearer\s+(\S+)\s*$/i);
    if (m) return m[1];
  }
  const x = h['x-api-key'] || h['X-Api-Key'];
  return x ? String(x).trim() || null : null;
}

let cacheRaw = null; let cacheKeys = [];

/**
 * The caller's name for a valid key, or null. Every configured hash is compared, in constant time,
 * so the time taken doesn't depend on which key (if any) matched.
 */
function callerName(req, env = process.env) {
  const raw = env.COMPANY_LOOKUP_API_KEYS;
  if (!raw) return null;
  if (raw !== cacheRaw) { cacheKeys = parseKeys(raw); cacheRaw = raw; }
  const key = keyFrom(req);
  if (!key || key.length > 200 || !cacheKeys.length) return null;
  const h = sha256(key);
  let found = null;
  for (const k of cacheKeys) if (crypto.timingSafeEqual(k.hash, h) && !found) found = k.name;
  return found;
}

module.exports = { parseKeys, keyFrom, callerName, sha256 };
