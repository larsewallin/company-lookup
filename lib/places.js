// Name search over Overture Maps places (presence data, tier 3) in countries without a connected
// register. Phase 3 pilot: DE, IT, ES, NL, BE, AT. See docs/presence-plan.md.
//
// How the index gets there, monthly:
//   1. .github/workflows/places-monthly.yml extracts the pilot countries' places from Overture's GeoParquet
//      with DuckDB (scripts/places/extract.sql) and builds the word index with the same builder as the
//      hosted register indexes (lib/bulk/index.js), in packs of files (scripts/places/build.js).
//   2. The packs are attached to a GitHub release of this repo (tag places-<Overture release>).
//   3. The workflow calls POST /api/places-import, which copies each pack into the Blob store (OIDC: no
//      token leaves Vercel) and then switches places/<cc>/manifest.json to the new version.
//
// Rows are presence data: never an official record, never merged with register results.
'use strict';

const zlib = require('zlib');
const index = require('./bulk/index');
const blob = require('./blob');

const PILOT = ['DE', 'IT', 'ES', 'NL', 'BE', 'AT'];
const REPO = 'larsewallin/company-lookup';
const TAG_RE = /^places-\d{4}-\d{2}-\d{2}\.\d+$/;
const PATH_RE = /^[st]\/[0-9]+(-[0-9]+)?\.json$/;
const LABEL = 'Not an official record';
const ROOT = 'places';

const round6 = (x) => (Number.isFinite(x) ? Math.round(x * 1e6) / 1e6 : null);

// One NDJSON line from scripts/places/extract.sql -> a builder record (only the word index is built).
const toRecord = (o) => ({ number: o.id, name: o.name, status: 'active', o });

// Word-index row: [GERS id, name, 1, null, [category, street, locality, postcode, region, lon, lat, confidence, [[dataset, licence]]]]
function rowOf(r) {
  const o = r.o;
  const src = (o.src || []).map((x) => { const i = String(x).indexOf('|'); return i < 0 ? [String(x), null] : [x.slice(0, i), x.slice(i + 1) || null]; });
  return [o.id, o.name, 1, null, [o.cat || null, o.street || null, o.locality || null, o.postcode || null, o.region || null,
    round6(o.lon), round6(o.lat), Number.isFinite(o.conf) ? Math.round(o.conf * 1000) / 1000 : null, src]];
}

// A search hit -> the place summary used in search's `presence` list (same shape as presence-store summaries).
function summaryOf(hit, cc, release) {
  const [category, street, locality, postcode, region, lon, lat, , src] = hit.extra || [];
  const s = {
    id: `overture:${hit.number}`, tier: 'presence', label: LABEL, name: hit.name,
    address: { street: street || null, locality: locality || null, postcode: postcode || null, region: region || null, country: cc },
    location: lon != null && lat != null ? { lon, lat } : null,
  };
  if (category) s.category = category;
  s.sources = (src || []).map(([dataset, license]) => ({ dataset, license: license || null, update_time: null }));
  s.release = release || null;
  return s;
}

/** Places matching q in one pilot country (whole words by prefix), or [] when there is no index. */
async function search(fetchFn, base, cc, q, limit = 10) {
  if (!base || !PILOT.includes(cc)) return [];
  const hits = await index.search(fetchFn, base, cc, q, limit, { root: ROOT });
  if (!hits || !hits.length) return [];
  const m = await index.manifest(fetchFn, base, cc, ROOT);
  return hits.map((h) => summaryOf(h, cc, m && m.release));
}

/** The pilot countries' index state for /v1/health: { DE: { release, count, built_at } | null, … }. */
async function status(fetchFn, base) {
  if (!base) return null;
  const out = {};
  await Promise.all(PILOT.map(async (cc) => {
    try { const m = await index.manifest(fetchFn, base, cc, ROOT); out[cc] = m ? { release: m.release || null, count: m.count || 0, built_at: m.built_at || null } : null; } catch (e) { out[cc] = null; }
  }));
  return out;
}

// ---------- packs (build side and import side) ----------

const encodePack = (files) => zlib.gzipSync(files.map((f) => JSON.stringify(f)).join('\n') + '\n');
function decodePack(buf) {
  return zlib.gunzipSync(buf).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const versionOf = (tag) => tag.slice('places-'.length).replace(/\D/g, '');
const assetUrl = (tag, name) => `https://github.com/${REPO}/releases/download/${tag}/${name}`;

// Runs fn over items with `n` at a time.
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const it = items[i++]; await fn(it); } }));
}

/**
 * POST /api/places-import?cc=DE&tag=places-2026-10-21.0&pack=3   copies one pack into Blob
 * POST /api/places-import?cc=DE&tag=places-2026-10-21.0&finalize=1   switches the manifest to that version
 * Anyone may call it, but it only copies files from this repo's own releases, and finalize only switches
 * to a version whose files are all in the store, with at least 80% of the previous count.
 */
function createPlacesImport({ fetchFn = fetch, blobFetch = blob.http1Fetch, env = process.env, now = () => Date.now() } = {}) {
  const send = (res, status, body) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(body));
  };
  const getAsset = async (tag, name) => {
    const r = await fetchFn(assetUrl(tag, name));
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`GitHub release asset ${name}: HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  };

  return async function handler(req, res) {
    if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
    const q = req.query || {};
    const cc = String(q.cc || '').toUpperCase();
    const tag = String(q.tag || '');
    if (!PILOT.includes(cc)) return send(res, 400, { error: `cc must be one of ${PILOT.join(', ')}.` });
    if (!TAG_RE.test(tag)) return send(res, 400, { error: 'tag must look like places-2026-10-21.0' });
    const token = blob.auth(env, req);
    if (!token) return send(res, 503, { error: 'No Blob store is set up.' });
    const prefix = `${ROOT}/${cc.toLowerCase()}/`;
    const version = versionOf(tag);
    const t0 = now();
    try {
      if (q.pack != null && q.pack !== '') {
        const n = Number(q.pack);
        if (!Number.isInteger(n) || n < 0 || n > 9999) return send(res, 400, { error: 'pack must be a number.' });
        const buf = await getAsset(tag, `${cc.toLowerCase()}-${n}.ndjson.gz`);
        if (!buf) return send(res, 404, { error: `No pack ${n} for ${cc} in ${tag}.` });
        const files = decodePack(buf);
        if (files.some(([p, t]) => !PATH_RE.test(p) || typeof t !== 'string')) return send(res, 400, { error: 'Unexpected file in pack.' });
        await pool(files, 8, ([p, text]) => blob.put(blobFetch, token, `${prefix}${version}/${p}`, text));
        return send(res, 200, { ok: true, country: cc, version, pack: n, files: files.length, seconds: Math.round((now() - t0) / 1000) });
      }
      if (q.finalize) {
        const metaBuf = await getAsset(tag, `${cc.toLowerCase()}-meta.json`);
        if (!metaBuf) return send(res, 404, { error: `No metadata for ${cc} in ${tag}.` });
        const meta = JSON.parse(metaBuf.toString('utf8'));
        const existing = await blob.list(blobFetch, token, prefix);
        const have = existing.filter((x) => x.pathname.startsWith(`${prefix}${version}/`)).length;
        if (have < meta.files) return send(res, 409, { error: `Only ${have} of ${meta.files} files are in the store; import every pack first.` });
        const base = blob.storeBase(env) || blob.publicBase(token.storeId);
        const prev = await index.manifest(fetchFn, base, cc, ROOT).catch(() => null);
        if (prev && prev.count && meta.count < prev.count * 0.8 && !q.force) return send(res, 409, { error: `Only ${meta.count} places, the live index has ${prev.count}; keeping it.` });
        const m = {
          country: cc, version, base: `${blob.publicBase(token.storeId)}/${prefix}${version}`, built_at: new Date(now()).toISOString(),
          release: meta.release, count: meta.count, s_buckets: meta.s_buckets, t_layout: 2, split: meta.split || [],
          source: 'Overture Maps places (presence data, not an official record)', tag,
        };
        await blob.put(blobFetch, token, `${prefix}manifest.json`, JSON.stringify(m), { cacheSeconds: 60 });
        const stale = existing.filter((x) => x.pathname !== `${prefix}manifest.json` && !x.pathname.startsWith(`${prefix}${version}/`)).map((x) => x.url);
        if (stale.length) await blob.del(blobFetch, token, stale);
        return send(res, 200, { ok: true, ...m, split: m.split.length, removed: stale.length });
      }
      return send(res, 400, { error: 'Give pack=<n> or finalize=1.' });
    } catch (e) {
      console.error(`places-import ${cc} ${tag} failed: ${e && e.message}`);
      return send(res, 502, { error: `Import failed: ${e && e.message}` });
    }
  };
}

module.exports = { PILOT, ROOT, TAG_RE, toRecord, rowOf, summaryOf, search, status, encodePack, decodePack, createPlacesImport, versionOf, assetUrl };
