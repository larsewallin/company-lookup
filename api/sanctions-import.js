// Daily download of the public sanctions lists into one index in the Blob store (sanctions/index.json).
// Runs from Vercel Cron. Anyone may call it, but it only rebuilds when the index is older than 20 hours
// (or missing), so repeated calls do nothing. A list that fails to download keeps its previous entries.
'use strict';

const blob = require('../lib/blob');
const S = require('../lib/sanctions');
const { userAgent } = require('../lib/ua');

const MIN_AGE = 20 * 3600000;
const PATH = 'sanctions/index.json';

function createSanctionsImport({ fetchFn = fetch, blobFetch = blob.http1Fetch, env = process.env, now = () => new Date() } = {}) {
  const get = async (url) => {
    const res = await fetchFn(url, { headers: { 'User-Agent': userAgent(), Accept: '*/*' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.split('?')[0].split('/').pop()}`);
    return res.text();
  };
  const parsers = {
    ofac_sdn: async (f) => S.parseOfac('ofac_sdn', ...(await Promise.all(f.map(get)))),
    ofac_cons: async (f) => S.parseOfac('ofac_cons', ...(await Promise.all(f.map(get)))),
    eu: async (f) => S.parseEu(await get(f[0])),
    un: async (f) => S.parseUn(await get(f[0])),
    uk: async (f) => S.parseUk(await get(f[0])),
  };

  return async function handler(req, res) {
    const send = (status, body) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(body));
    };
    const token = blob.auth(env, req);
    const base = blob.storeBase(env) || (token && blob.publicBase(token.storeId));
    if (!token || !base) return send(503, { error: 'No Blob store is connected, so the sanctions index cannot be stored.' });
    const force = req.query && (req.query.force === '1');

    let prev = null;
    try {
      const r = await fetchFn(`${base}/${PATH}?v=${now().getTime()}`);
      if (r.ok) prev = await r.json();
    } catch (e) { /* first run */ }
    if (prev && !force && now().getTime() - Date.parse(prev.built_at) < MIN_AGE) {
      return send(200, { skipped: true, reason: 'The index is less than 20 hours old.', built_at: prev.built_at });
    }

    const entriesByList = {}; const meta = {}; const report = {};
    await Promise.all(Object.entries(S.SOURCES).map(async ([key, src]) => {
      const fetchedAt = now().toISOString();
      try {
        const entries = await parsers[key](src.files);
        if (!entries.length) throw new Error('no entities found (layout change?)');
        entriesByList[key] = entries;
        meta[key] = { name: src.name, short: src.short, licence: src.licence, search: src.search, source: src.files[0].split('?')[0], fetched_at: fetchedAt, entities: entries.length };
        report[key] = entries.length;
      } catch (e) {
        // Keep the previous entries for this list, and say how old they are.
        const old = prev ? prev.entries.filter((x) => x.l === key) : [];
        const oldMeta = prev && prev.lists[key];
        entriesByList[key] = old.map((x) => ({ id: x.i, name: x.n, aliases: x.a, programmes: x.p, countries: x.c, listed_on: x.d, url: x.u }));
        meta[key] = { ...(oldMeta || { name: src.name, short: src.short, licence: src.licence, search: src.search, source: src.files[0].split('?')[0], fetched_at: null, entities: 0 }),
          error: `Last download failed (${e.message}); ${oldMeta && oldMeta.fetched_at ? `showing the list as fetched ${oldMeta.fetched_at}` : 'not screened'}.` };
        report[key] = `failed: ${e.message}`;
      }
    }));
    if (!Object.values(meta).some((m) => !m.error)) return send(502, { error: 'Every sanctions list failed to download.', report });

    const index = S.buildIndex(entriesByList, meta, now().toISOString());
    await blob.put(blobFetch, token, PATH, JSON.stringify(index), { cacheSeconds: 3600 });
    return send(200, { built_at: index.built_at, entities: index.entries.length, report });
  };
}

module.exports = createSanctionsImport();
module.exports.createSanctionsImport = createSanctionsImport;
