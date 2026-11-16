// Request handlers for /api/* and /v1/* (search, company, presence, reports, health), with dependencies
// injected for tests. One set of handlers serves both: with `apiVersion: '1'` the same logic answers with
// the v1 contract (docs/api-v1.md): `api_version` on every response, errors as { code, message }, and
// API keys for trusted callers. Without it, responses are exactly the original /api/* shapes.
'use strict';

const gleif = require('./gleif');
const { chSearch, chCompany, rdapDomain, normaliseDomain } = require('./sources');
const { buildCard, applySanctions, sanctionsNames } = require('./card');
const registers = require('./registers');
const wikidata = require('./wikidata');
const vies = require('./vies');
const { createOverture, parseId } = require('./overture');
const presence = require('./presence');
const { createStore, locationsFor } = require('./presence-store');
const sanctionsLib = require('./sanctions');
const { callerName } = require('./keys');
const places = require('./places');
const blob = require('./blob');
const PKG_VERSION = require('../package.json').version;

// Best-effort per-instance limit so one visitor can't use up source quotas.
const WINDOW_MS = 5 * 60 * 1000;
const LIMIT = 40;
const hits = new Map();
function rateLimited(ip, now, limit = LIMIT) {
  const arr = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();
  return arr.length > limit;
}
// Seconds until the bucket is back under its limit (the sliding window's oldest counted hit expires).
function retryAfter(ip, now, limit = LIMIT) {
  const arr = hits.get(ip) || [];
  const t = arr[Math.max(0, arr.length - limit)];
  return t ? Math.max(1, Math.ceil((t + WINDOW_MS - now) / 1000)) : 1;
}

function normaliseNumber(input) {
  if (!input) return null;
  let s = String(input).toUpperCase().replace(/\s+/g, '');
  if (/^\d{1,8}$/.test(s)) s = s.padStart(8, '0');
  return /^[A-Z0-9]{8}$/.test(s) ? s : null;
}

const LEI_RE = /^[A-Z0-9]{18}[0-9]{2}$/;

function send(res, status, body, cacheSeconds = 0) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', cacheSeconds > 0
    ? `public, max-age=300, s-maxage=${cacheSeconds}, stale-while-revalidate=${cacheSeconds * 7}`
    : 'no-store');
  res.end(JSON.stringify(body));
}

// ---------- v1 contract ----------

const API_VERSION = '1';
const CODES = { 400: 'bad_request', 404: 'not_found', 405: 'method_not_allowed', 429: 'rate_limited', 500: 'internal', 502: 'upstream_unavailable', 503: 'upstream_busy' };
const STATUS_OF = { bad_request: 400, not_found: 404, method_not_allowed: 405, rate_limited: 429, internal: 500, upstream_unavailable: 502, upstream_busy: 503, not_configured: 503 };

// Turns a handler's response into the v1 shape. Errors ({ error: "message", ...extra }) become
// { api_version, error: { code, message, ...extra } }; a handler can name the code with `_code`.
function toV1(status, body, retryAfterSeconds) {
  if (status < 400 || !body || typeof body.error !== 'string') return { status, body: { api_version: API_VERSION, ...body } };
  const { error, _code, ...rest } = body;
  const code = _code || CODES[status] || (status >= 500 ? 'internal' : 'bad_request');
  const err = { code, message: error, ...rest };
  if (code === 'rate_limited') err.retry_after = retryAfterSeconds || 60;
  return { status: _code ? STATUS_OF[_code] : status, body: { api_version: API_VERSION, error: err }, retryAfter: err.retry_after };
}

function sendV1(res, status, body, cacheSeconds = 0, retryAfterSeconds) {
  const out = toV1(status, body, retryAfterSeconds);
  if (out.retryAfter) res.setHeader('Retry-After', String(out.retryAfter));
  return send(res, out.status, out.body, out.status >= 500 ? 0 : cacheSeconds);
}

// The base URL for links the API returns: COMPANY_LOOKUP_PUBLIC_URL if set, else the host the request came to.
function publicBase(req, env = process.env) {
  const fixed = env.COMPANY_LOOKUP_PUBLIC_URL ? String(env.COMPANY_LOOKUP_PUBLIC_URL).trim() : '';
  if (/^https?:\/\/[^\s/]+/i.test(fixed)) return fixed.replace(/\/+$/, '');
  const h = (req && req.headers) || {};
  const host = String(h['x-forwarded-host'] || h.host || '').split(',')[0].trim();
  if (!/^[A-Za-z0-9.-]+(:\d+)?$/.test(host)) return '';
  const local = /^(localhost|127\.|\[::1\])/.test(host);
  const proto = String(h['x-forwarded-proto'] || (local ? 'http' : 'https')).split(',')[0].trim();
  return `${proto === 'http' ? 'http' : 'https'}://${host}`;
}

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  return (xf ? String(xf).split(',')[0] : req.socket && req.socket.remoteAddress) || 'unknown';
}

// One ranking across all sources: name match first, then active, then entities with an LEI
// (usually larger, real trading companies), then shorter names. Stable for equal scores.
function rankResults(results, q) {
  const nq = gleif.normName(q);
  const score = (r) => {
    const n = gleif.normName(r.name);
    const tier = n === nq ? 0 : n.startsWith(nq + ' ') ? 1 : (' ' + n + ' ').includes(' ' + nq + ' ') ? 2 : 3;
    return [tier, r.status === 'active' ? 0 : 1, r.lei ? 0 : 1, n.split(' ').length];
  };
  return results.map((r, i) => [score(r), i, r]).sort((a, b) => {
    for (let k = 0; k < a[0].length; k++) if (a[0][k] !== b[0][k]) return a[0][k] - b[0][k];
    return a[1] - b[1];
  }).map((x) => x[2]);
}

const settle = (p) => p.then((data) => ({ ok: true, data }), (e) => ({ ok: false, error: e }));

// `limit` and `keyPrefix` let the MCP endpoint use its own, larger bucket: AI platforms call
// from a few shared addresses, so the per-visitor website limit would block all their users at once.
// `apiVersion: '1'` gives the v1 contract and turns on API keys (see lib/keys.js); omitted, nothing changes.
function createHandlers({ fetchFn = fetch, env = process.env, now = () => new Date(), limit = LIMIT, keyPrefix = '', overture = null, store = null, presenceCandidates = null, apiVersion = null, placesSearch = null, placesStatus = null, sanctions = null } = {}) {
  const key = () => env.COMPANIES_HOUSE_API_KEY;
  const keyLimit = Number(env.COMPANY_LOOKUP_KEY_RATE_LIMIT) > 0 ? Math.floor(Number(env.COMPANY_LOOKUP_KEY_RATE_LIMIT)) : limit * 10;
  // The trusted caller's name for a valid API key (v1 only), worked out once per request and logged.
  const caller = (req) => {
    if (!apiVersion || req._internal) return null;
    if (req._caller === undefined) {
      req._caller = callerName(req, env);
      if (req._caller) console.log(`Company Lookup v${apiVersion} request from ${req._caller}: ${String(req.url || '').split('?')[0]}`);
    }
    return req._caller;
  };
  // Internal calls (linking a presence record to legal entities) don't use up the visitor's limit.
  // Keyed callers have their own bucket, never shared with anonymous traffic.
  const limited = (req) => {
    if (req._internal) return false;
    const who = caller(req);
    const bucket = who ? `\u0000key:${who}` : keyPrefix + clientIp(req);
    const lim = who ? keyLimit : limit;
    const t = now().getTime();
    if (!rateLimited(bucket, t, lim)) return false;
    req._retryAfter = retryAfter(bucket, t, lim);
    return true;
  };
  // `_code` names a v1 error code; it is dropped from /api/* responses, which stay as they were.
  const reply = (res, status, body, cacheSeconds = 0, retry) => {
    if (apiVersion) return sendV1(res, status, body, cacheSeconds, retry);
    if (body && body._code) { body = { ...body }; delete body._code; }
    return send(res, status, body, cacheSeconds);
  };
  const tooMany = (req, res, message) => reply(res, 429, { error: message }, 0, req._retryAfter);
  const ov = overture || createOverture({ fetchFn, nowMs: () => now().getTime() });
  const links = store || createStore({ fetchFn, env, nowMs: () => now().getTime() });
  // Name search over stored Overture places (phase 3 pilot countries), from the same Blob store.
  const placesBase = blob.storeBase(env);
  const findPlaces = placesSearch || ((cc, q) => places.search(fetchFn, placesBase, cc, q, 10));
  const placesState = placesStatus || (() => places.status(fetchFn, placesBase));
  const sanctionsStore = sanctions || sanctionsLib.createSanctionsStore({ fetchFn, base: blob.storeBase(env), nowMs: () => now().getTime() });
  // Screens names against the sanctions index; null when no index is set up on this server.
  async function screenNames(names) {
    if (!sanctionsStore.enabled) return null;
    const idx = await sanctionsStore.load();
    if (!idx) return { state: 'unavailable', notice: sanctionsLib.NOTICE };
    return {
      state: 'ok', notice: sanctionsLib.NOTICE, checked_at: idx.built_at, lists: sanctionsLib.listsSummary(idx),
      results: names.map((n) => ({ name: n.name, role: n.role, matches: sanctionsLib.screen(idx, n.name, { country: n.country || null, limit: 5 }).matches })),
    };
  }
  const registerFor = (country) => (country === 'GB' ? (key() ? 'Companies House' : null) : registers.byCountry[country] ? registers.byCountry[country].name : null);

  async function search(req, res) {
    if (req.method !== 'GET') return reply(res, 405, { error: 'GET only' });
    const q = String((req.query && req.query.q) || '').trim();
    const country = String((req.query && req.query.country) || '').toUpperCase();
    if (q.length < 2 || q.length > 100) return reply(res, 400, { error: 'Enter between 2 and 100 characters.' });
    if (country && !/^[A-Z]{2}$/.test(country)) return reply(res, 400, { error: 'Unknown country.' });
    if (limited(req)) return tooMany(req, res, 'Too many lookups. Try again in a few minutes.');

    const useCh = !!key() && (country === '' || country === 'GB');
    const reg = registers.byCountry[country] || null;
    // A short single word may be a stock ticker (Wikidata), looked up alongside the name search.
    const maybeTicker = /^[A-Za-z0-9.\-]{1,8}$/.test(q) && !/^\d+$/.test(q) && !gleif.isIsin(q);
    const [gl, uk, nat, tk] = await Promise.all([
      settle(gleif.search(fetchFn, q, country || null)),
      useCh ? settle(chSearch(fetchFn, key(), q)) : Promise.resolve(null),
      reg && !gleif.isIsin(q) ? settle(reg.search(fetchFn, q)) : Promise.resolve(null),
      maybeTicker ? settle(wikidata.byTicker(fetchFn, q)) : Promise.resolve(null),
    ]);
    if (!gl.ok && (!uk || !uk.ok) && (!nat || !nat.ok)) return reply(res, 502, { error: 'The company registers could not be reached. Try again shortly.' });

    const glResults = gl.ok ? gl.data : [];
    const glGbNumbers = new Set(glResults.filter((r) => r.country === 'GB' && r.number).map((r) => normaliseNumber(r.number)));
    const ukResults = uk && uk.ok ? uk.data
      .filter((c) => !glGbNumbers.has(c.company_number))
      .map((c) => ({ id: `gb:${c.company_number}`, source: 'Companies House', name: c.name, country: 'GB', city: null,
        status: c.status, number: c.company_number, address: c.address, incorporated: c.incorporated })) : [];
    let natResults = [];
    if (nat && nat.ok) {
      // Register results may carry `match`: the number GLEIF uses (e.g. a Swiss UID) when their own ID differs.
      const key = (n) => (n ? reg.normalise(n) || String(n).replace(/[^0-9A-Za-z]/g, '').toUpperCase() : null);
      natResults = nat.data.map((c) => {
        const num = reg.normalise(c.number) || c.number;
        const matchKey = key(c.match || num);
        const lei = glResults.find((r) => r.country === country && r.number && key(r.number) === matchKey);
        return { id: `${country.toLowerCase()}:${num}`, source: c.source || reg.name, name: c.name, country, city: c.city,
          status: c.status, number: num, incorporated: c.incorporated, lei: lei ? lei.lei : undefined, _match: matchKey };
      });
      // A register hit replaces the matching GLEIF hit (the card adds GLEIF data anyway).
      const natKeys = new Set(natResults.map((x) => x._match));
      for (let i = glResults.length - 1; i >= 0; i--) {
        const r = glResults[i];
        if (r.country === country && r.number && natKeys.has(key(r.number))) glResults.splice(i, 1);
      }
      natResults.forEach((x) => delete x._match);
    }
    let results = rankResults(country === 'GB' ? [...ukResults, ...glResults] : reg ? [...natResults, ...glResults] : [...glResults, ...ukResults], q);
    // Ticker matches go first, labelled; companies not already in the results are fetched from GLEIF.
    const tickers = tk && tk.ok ? tk.data : [];
    if (tickers.length) {
      const label = new Map(tickers.map((t) => [t.lei, `${t.ticker}${t.exchange ? ' on ' + t.exchange : ''}`]));
      const have = new Set(results.map((r) => r.lei).filter(Boolean));
      const extra = await settle(gleif.byLeis(fetchFn, tickers.map((t) => t.lei).filter((l) => !have.has(l))));
      const added = extra.ok ? extra.data.filter((r) => !country || r.country === country) : [];
      results = [...added, ...results];
      // One Wikidata item can carry several LEIs (e.g. Siemens AG and Siemens plc); keep those in the exchange's country.
      const countryOf = new Map(results.filter((r) => r.lei).map((r) => [r.lei, r.country]));
      const byItem = new Map();
      tickers.forEach((t) => byItem.set(t.item, (byItem.get(t.item) || []).concat(t)));
      for (const group of byItem.values()) {
        if (group.length < 2) continue;
        const home = group.filter((t) => t.exchange_country && countryOf.get(t.lei) === t.exchange_country);
        if (home.length) group.filter((t) => !home.includes(t)).forEach((t) => label.delete(t.lei));
      }
      const hit = (r) => r.lei && label.has(r.lei);
      results.forEach((r) => { if (hit(r)) r.ticker = label.get(r.lei); });
      results = [...results.filter(hit), ...results.filter((r) => !hit(r))];
    }
    const warnings = [];
    if (nat && !nat.ok) warnings.push(`${reg.name} could not be reached (${nat.error && nat.error.status ? 'HTTP ' + nat.error.status : 'no response'}), so results may be incomplete.`);
    if (!gl.ok) warnings.push('GLEIF could not be reached, so results may be incomplete.');
    if (uk && !uk.ok) {
      const st = uk.error && uk.error.status;
      warnings.push([400, 401, 403].includes(st)
        ? `Companies House refused the API key (HTTP ${st}), so UK results come from GLEIF only. Check COMPANIES_HOUSE_API_KEY.`
        : `Companies House could not be reached (${st ? 'HTTP ' + st : 'no response'}), so UK results may be incomplete.`);
    }
    results = results.slice(0, 20);
    results.forEach((r) => { r.tier = r.source === 'GLEIF' ? 'gleif' : 'register'; });
    // Presence data (tier 3) comes after legal entities: linked places sit under their entity as locations;
    // other known places follow in `presence`, each labelled "Not an official record".
    let presenceResults = [];
    if (links.enabled) {
      const idx = await links.load();
      const shown = new Set();
      for (const r of results) {
        const locs = locationsFor(idx, [r.id, r.lei ? `lei:${r.lei}` : null]);
        if (locs.length) { r.locations = locs.slice(0, 10); locs.forEach((l) => shown.add(l.id)); }
      }
      const nq = presence.normaliseName(q);
      presenceResults = nq.length < 2 ? [] : Object.values(idx.records || {})
        .filter((rec) => rec.summary && !shown.has(rec.summary.id) && (!country || rec.country === country))
        .filter((rec) => rec.norm === nq || (rec.norm || '').startsWith(nq + ' ') || (' ' + (rec.norm || '') + ' ').includes(' ' + nq + ' '))
        .slice(0, 10)
        .map((rec) => ({ ...rec.summary, linked_entity: rec.link && rec.link.status === 'active' ? { id: rec.link.entity_id, name: rec.link.entity_name } : null }));
      // In the pilot countries, other places come from the stored Overture extract (lib/places.js).
      if (country && places.PILOT.includes(country) && presenceResults.length < 10) {
        const got = await settle(withTimeout(findPlaces(country, q), 4000));
        if (got.ok) {
          const seen = new Set([...shown, ...presenceResults.map((p) => p.id)]);
          for (const p of got.data || []) {
            if (presenceResults.length >= 10) break;
            if (seen.has(p.id)) continue;
            seen.add(p.id);
            presenceResults.push({ ...p, linked_entity: null });
          }
        }
      }
    }
    return reply(res, 200, { query: q, country: country || null, results, presence: presenceResults, warnings }, warnings.length ? 0 : 3600);
  }

  async function company(req, res) {
    if (req.method !== 'GET') return reply(res, 405, { error: 'GET only' });
    const query = req.query || {};
    let id = String(query.id || (query.number ? `gb:${query.number}` : '')).trim();
    const rawSite = query.website ? String(query.website).slice(0, 300) : '';
    const domainName = rawSite ? normaliseDomain(rawSite) : null;
    if (rawSite && !domainName) return reply(res, 400, { error: 'That website address does not look right.' });

    if (/^overture:/i.test(id)) return reply(res, 400, { error: `This is a presence record from Overture Maps, not a legal entity. Use get_presence_card (${apiVersion ? '/v1/presence' : '/api/presence'}).` });
    let kind; let value;
    let reg = null;
    if (/^lei:/i.test(id)) { kind = 'lei'; value = id.slice(4).toUpperCase(); if (!LEI_RE.test(value)) value = null; }
    else if (/^gb:/i.test(id)) { kind = 'gb'; value = normaliseNumber(id.slice(3)); }
    else if (/^[a-z]{2}:/i.test(id) && registers.byCountry[id.slice(0, 2).toUpperCase()]) {
      kind = 'nat'; reg = registers.byCountry[id.slice(0, 2).toUpperCase()]; value = reg.normalise(id.slice(3));
    }
    if (!kind || !value) return reply(res, 400, { error: 'Unknown company reference.' });
    if (kind === 'gb' && !key()) return reply(res, 500, { error: 'UK register lookups are not set up yet.', _code: 'not_configured' });
    if (limited(req)) return tooMany(req, res, 'Too many lookups. Try again in a few minutes.');

    let g = null; let gleifState = 'none'; let ch = null; let chState = 'not-applicable';
    let nat = null; let natState = 'not-applicable';
    const asOfIso = now().toISOString().slice(0, 10);

    if (kind === 'lei') {
      try {
        g = await gleif.record(fetchFn, value);
      } catch (e) {
        return reply(res, 502, { error: 'GLEIF could not be reached. Try again shortly.' });
      }
      if (!g) return reply(res, 404, { error: `No LEI record ${value}.` }, 3600);
      gleifState = 'ok';
      const r2 = registers.byCountry[g.country];
      if (r2) {
        reg = r2;
        const num = r2.normalise(g.registered_as);
        if (num) {
          const r = await settle(r2.get(fetchFn, num, { asOfIso, nameHint: g.legal_name }));
          if (r.ok && r.data) { nat = r.data; natState = 'ok'; } else natState = 'error';
        } else {
          chState = 'not-connected';
        }
      } else if (g.country === 'GB') {
        const num = normaliseNumber(g.registered_as);
        if (num && key()) {
          const r = await settle(chCompany(fetchFn, key(), num));
          if (r.ok && r.data) { ch = r.data; chState = 'ok'; } else chState = 'error';
        } else {
          chState = 'not-connected';
        }
      } else {
        chState = 'not-connected';
      }
    } else if (kind === 'nat') {
      try {
        nat = await reg.get(fetchFn, value, { asOfIso });
      } catch (e) {
        return reply(res, 502, { error: `${reg.name} could not be reached (${e && e.status ? 'HTTP ' + e.status : 'no response'}). Try again shortly.` });
      }
      if (!nat) return reply(res, 404, { error: `No company ${value} in the ${reg.name} register.`, flag: 'Not on the register' }, 3600);
      natState = 'ok';
      // Match the LEI by the register's own number (IDs like sg:D-196800306E carry a prefix).
      const regNo = nat.register && nat.register.number ? String(nat.register.number) : value;
      // Adapters can give GLEIF's own spelling (e.g. "009 661 901" for an Australian ACN) as register.gleif_as.
      const gleifAs = nat.register && nat.register.gleif_as ? [].concat(nat.register.gleif_as).filter(Boolean).map(String) : [];
      const tries = [...new Set([...gleifAs, regNo, regNo.replace(/[^0-9A-Za-z]/g, ''), value])];
      const r = await settle((async () => {
        for (const t of tries) { const lei = await gleif.byRegistration(fetchFn, t, reg.country); if (lei) return gleif.record(fetchFn, lei); }
        return null;
      })());
      if (!r.ok) gleifState = 'error';
      else if (r.data) { g = r.data; gleifState = 'ok'; }
    } else {
      try {
        ch = await chCompany(fetchFn, key(), value);
      } catch (e) {
        if (e && e.status === 429) return reply(res, 503, { error: 'Companies House is busy. Try again in a few minutes.' });
        const status = e && e.status ? e.status : 0;
        console.warn(`Companies House company lookup failed: HTTP ${status || 'no response'}`);
        if (status === 400 || status === 401 || status === 403) return reply(res, 502, { error: `Companies House refused the API key (HTTP ${status}). Check COMPANIES_HOUSE_API_KEY: the full key from a Live application's REST key, copied by hand, with no IP or domain restrictions.` });
        return reply(res, 502, { error: `Companies House could not be reached (${status ? 'HTTP ' + status : 'no response'}). Try again shortly.` });
      }
      if (!ch) return reply(res, 404, { error: `No company ${value} on the Companies House register.`, flag: 'Not on the register' }, 3600);
      chState = 'ok';
      const r = await settle(gleif.byRegistration(fetchFn, value, 'GB').then((lei) => (lei ? gleif.record(fetchFn, lei) : null)));
      if (!r.ok) gleifState = 'error';
      else if (r.data) { g = r.data; gleifState = 'ok'; }
    }

    // Wikidata enrichment, matched only by LEI or national number.
    const country = (g && g.country) || (reg && reg.country) || (ch ? 'GB' : null);
    const natNumber = ch ? ch.profile.company_number : nat ? nat.register.number : g && g.registered_as ? g.registered_as : null;
    const vatNumber = nat && nat.vat && nat.vat.number && vies.split(nat.vat.number) ? nat.vat.number : null;
    const [w, v] = await Promise.all([
      settle(wikidata.lookup(fetchFn, { lei: g ? g.lei : null, country, number: natNumber })),
      vatNumber ? settle(vies.check(fetchFn, vatNumber)) : Promise.resolve(null),
    ]);
    const viesResult = v && v.ok ? v.data : null;
    const viesState = !v ? 'not-applicable' : !v.ok ? 'error' : viesResult && viesResult.unavailable ? 'unavailable' : 'ok';
    const wiki = w.ok ? w.data : null;
    const wikiState = !w.ok ? 'error' : wiki ? 'ok' : 'none';

    // Domain age: the website the visitor typed, else the one the register or Wikidata gives.
    let domain = null;
    let siteFrom = domainName ? 'entered' : null;
    let checkDomain = domainName;
    if (!checkDomain) {
      const fromReg = nat && nat.website ? normaliseDomain(nat.website) : null;
      const fromWiki = wiki && wiki.website ? normaliseDomain(wiki.website) : null;
      checkDomain = fromReg || fromWiki;
      siteFrom = fromReg ? 'register' : fromWiki ? 'Wikidata' : null;
    }
    if (checkDomain) {
      const d = await settle(rdapDomain(fetchFn, checkDomain));
      domain = { input: checkDomain, from: siteFrom, ok: d.ok, data: d.ok ? d.data : null };
    }
    const card = buildCard({ g, gleifState, ch, chState, nat, natState, wiki, wikiState, viesResult, viesState, natName: reg ? reg.name : null, natCountry: reg ? reg.country : null, domain, asOfIso });
    card.id = kind === 'lei' ? `lei:${value}` : kind === 'nat' ? `${reg.country.toLowerCase()}:${value}` : `gb:${value}`;
    // Sanctions lists (OFAC, EU, UN, UK): the company's own names and its parents.
    try {
      const sc = await screenNames(sanctionsNames(card).map((n) => ({ ...n, country: card.identity.country })));
      if (sc) applySanctions(card, sc);
    } catch (e) { console.warn(`Sanctions screening failed: ${e.message}`); }
    // Places linked to this entity (presence data, tier 3). Shown beside register facts, never replacing them.
    if (links.enabled) {
      const idx = await links.load();
      const locs = locationsFor(idx, [card.id, g ? `lei:${g.lei}` : null, id]);
      if (locs.length) card.presence = { notice: presence.NOTICE, locations: locs.slice(0, 25) };
    }
    return reply(res, 200, card, 21600);
  }

  // ---------- presence data (Overture Maps) ----------

  const placeCache = new Map(); // `${release}:${id}` -> row
  const asJson = (handler, query) => new Promise((resolve, reject) => {
    const fake = { statusCode: 200, setHeader() {}, end(t) { try { resolve({ status: this.statusCode, body: JSON.parse(t) }); } catch (e) { reject(e); } } };
    Promise.resolve(handler({ method: 'GET', query, headers: {}, socket: {}, _internal: true }, fake)).catch(reject);
  });

  // Candidates from search_companies(name, country), each with its card's website and address.
  async function candidates(card) {
    const r = await asJson(search, { q: card.name.slice(0, 100), country: card.address.country });
    if (r.status !== 200) return [];
    const top = r.body.results.filter((x) => x.kind !== 'fund' && x.country === card.address.country).slice(0, 3);
    const cards = await Promise.all(top.map((x) => asJson(company, { id: x.id }).catch(() => null)));
    return top.map((x, i) => {
      const c = cards[i] && cards[i].status === 200 ? cards[i].body : null;
      const reg = c && c.identity ? c : null;
      return {
        id: x.id, name: (reg && reg.identity.legal_name) || x.name, country: x.country,
        website: (reg && (reg.identity.website || (reg.web && reg.web.domain))) || null,
        address: (reg && reg.identity.registered_address) || x.address || null,
        register: x.source, number: x.number || null,
        ids: [x.id, reg && reg.id, x.lei ? `lei:${x.lei}` : null].filter(Boolean),
      };
    });
  }

  // The report link: relative on /api/* (as before), a full URL on /v1/.
  const reportUrl = (req) => (apiVersion ? `${publicBase(req, env)}/v${apiVersion}/presence-report` : '/api/presence-report');
  const linkView = (l, gersId, req) => ({
    id: l.entity_id, name: l.entity_name, register: l.register, number: l.number, level: l.level, evidence: l.evidence, linked_on: l.date,
    text: l.level === 'strong' ? `This place is linked to ${l.entity_name} (${l.register}${l.number ? ', ' + l.number : ''}).` : `Possibly the same as ${l.entity_name} (${l.register}${l.number ? ', ' + l.number : ''}).`,
    report: { method: 'POST', url: reportUrl(req), body: { id: gersId, entity_id: l.entity_id } },
  });

  async function link(card, req) {
    const idx = await links.load();
    const prev = idx.records && idx.records[card.id];
    const fresh = prev && prev.checked && now().getTime() - Date.parse(prev.checked) < 30 * 86400000;
    let rec = prev;
    if (!fresh && card.name && card.address.country) {
      const rejected = new Set((prev && prev.rejected) || []);
      const ents = (await (presenceCandidates || candidates)(card)).filter((e) => !rejected.has(e.id));
      const best = presence.bestMatch(card, ents);
      const date = now().toISOString().slice(0, 10);
      const keep = prev && prev.link && prev.link.status === 'reported' ? prev.link : null; // a reported link stays held out
      const asLink = (m, level) => ({ entity_id: m.entity.id, entity_ids: m.entity.ids, entity_name: m.entity.name, register: m.entity.register, number: m.entity.number, level, evidence: m.evidence, date, status: 'active' });
      rec = {
        summary: presence.presenceSummary(card), norm: presence.normaliseName(card.name), country: card.address.country, checked: now().toISOString(),
        link: keep || (best.strong ? asLink(best.strong, 'strong') : null),
        probable: best.probable.map((m) => asLink(m, 'probable')).map((p) => {
          const old = prev && (prev.probable || []).find((x) => x.entity_id === p.entity_id);
          return old && old.status === 'reported' ? old : p;
        }),
        rejected: [...rejected],
      };
      const saved = rec;
      await links.update(req, (i) => { i.records = i.records || {}; i.records[card.id] = saved; }).catch((e) => console.warn(`Presence link not saved: ${e.message}`));
    }
    if (!rec) return card;
    if (rec.link && rec.link.status === 'active') card.linked_entity = linkView(rec.link, card.id, req);
    else if (rec.link && rec.link.status === 'reported') card.link_note = `A link to ${rec.link.entity_name} was reported as wrong and is held back until it is reviewed.`;
    card.possible_matches = (rec.probable || []).filter((p) => p.status === 'active').map((p) => linkView(p, card.id, req));
    return card;
  }

  async function presenceCard(req, res) {
    if (req.method !== 'GET') return reply(res, 405, { error: 'GET only' });
    const query = req.query || {};
    const id = parseId(query.id);
    if (!id) return reply(res, 400, { error: 'Give an Overture GERS ID, e.g. 6f8bce4f-a274-4494-9f2c-dd051bca0bb4.' });
    const lon = query.lon != null && query.lon !== '' ? Number(query.lon) : NaN;
    const lat = query.lat != null && query.lat !== '' ? Number(query.lat) : NaN;
    if ((query.lon || query.lat) && !(lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90)) return reply(res, 400, { error: 'lon and lat must be decimal degrees.' });
    if (limited(req)) return tooMany(req, res, 'Too many lookups. Try again in a few minutes.');
    let found;
    try {
      const release = await ov.latestRelease();
      const hit = placeCache.get(`${release}:${id}`);
      found = hit ? { row: hit, release } : await ov.place(id, Number.isFinite(lon) ? { lon, lat } : {});
      if (found) { if (placeCache.size > 2000) placeCache.clear(); placeCache.set(`${found.release}:${id}`, found.row); }
    } catch (e) {
      console.warn(`Overture lookup failed: ${e.message}`);
      return reply(res, 502, { error: `Overture Maps could not be reached (${e && e.status ? 'HTTP ' + e.status : 'no response'}). Try again shortly.` });
    }
    if (!found) return reply(res, 404, { error: `No place ${id} in the current Overture Maps release.`, tier: 'presence', notice: presence.NOTICE }, 3600);
    let card = presence.presenceCard(found.row, { release: found.release, checkedAt: now().toISOString(), registerFor });
    if (query.link !== '0') {
      try { card = await withTimeout(link(card, req), 15000); } catch (e) { card.link_note = 'Matching to legal entities did not finish; try again for linked entities.'; }
    }
    return reply(res, 200, card, 3600);
  }

  async function presenceReport(req, res) {
    if (req.method !== 'POST') return reply(res, 405, { error: 'POST only' });
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
    const id = parseId(body && body.id);
    const entityId = body && typeof body.entity_id === 'string' ? body.entity_id.slice(0, 80) : '';
    if (!id || !entityId) return reply(res, 400, { error: 'Give id (the GERS ID) and entity_id (the linked entity).' });
    if (limited(req)) return tooMany(req, res, 'Too many reports. Try again in a few minutes.');
    const reason = body.reason ? String(body.reason).slice(0, 500) : null;
    const by = caller(req); // reports from keyed callers are labelled with the caller's name
    let found = false;
    const ok = await links.update(req, (idx) => {
      const rec = idx.records && idx.records[id];
      if (!rec) return false;
      const mark = (l) => { if (l && l.entity_id === entityId) { l.status = 'reported'; l.report = by ? { reason, at: now().toISOString(), by } : { reason, at: now().toISOString() }; found = true; } };
      mark(rec.link); (rec.probable || []).forEach(mark);
      return found ? undefined : false;
    }).catch(() => 'error');
    if (ok === 'error') return reply(res, 503, { error: 'Reports cannot be saved here (no link store is set up).', _code: 'upstream_unavailable' });
    if (!ok) return reply(res, 503, { error: 'Reports cannot be saved here (no link store is set up).', _code: 'not_configured' });
    if (!found) return reply(res, 404, { error: 'No such link.' });
    return reply(res, 200, { ok: true, status: 'reported', message: 'Thank you. The link is held back until it is reviewed.' });
  }

  // ---------- health (v1) ----------
  // Cheap: no register calls. The Overture release comes from the hourly-cached STAC catalog; the Blob
  // store gets one HEAD request. The answer is kept for HEALTH_TTL_MS per instance.
  let healthCache = null;
  async function health(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return reply(res, 405, { error: 'GET only' });
    const t = now().getTime();
    if (!healthCache || t - healthCache.at > HEALTH_TTL_MS) {
      const [rel, blobUp, placesUp] = await Promise.all([
        settle(withTimeout(ov.latestRelease(), 3000)),
        links.enabled ? settle(withTimeout(links.ping ? links.ping() : links.load().then(() => true), 3000)) : Promise.resolve(null),
        links.enabled ? settle(withTimeout(placesState(), 3000)) : Promise.resolve(null),
      ]);
      const release = rel.ok && rel.data ? String(rel.data) : null;
      const blobReachable = blobUp ? blobUp.ok && blobUp.data === true : null;
      const sources = {
        companies_house: key() ? 'configured' : 'not_configured',
        overture: release ? 'ok' : 'unreachable',
        blob: !links.enabled ? 'not_configured' : blobReachable ? 'ok' : 'unreachable',
        registers: Object.keys(registers.byCountry).length,
      };
      healthCache = { at: t, body: {
        status: !release || (links.enabled && !blobReachable) ? 'degraded' : 'ok',
        api_version: apiVersion || API_VERSION,
        version: PKG_VERSION,
        commit: env.VERCEL_GIT_COMMIT_SHA || null,
        overture_release: release,
        blob: { configured: links.enabled, reachable: blobReachable },
        sources,
        // Stored Overture place indexes for name search (phase 3 pilot): per country { release, count, built_at } or null.
        places: placesUp && placesUp.ok ? placesUp.data : null,
        checked_at: new Date(t).toISOString(),
      } };
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=5, s-maxage=10');
    res.end(JSON.stringify(healthCache.body));
  }

  // ---------- sanctions screening (any company name, or a list of up to 50) ----------

  async function sanctionsScreen(req, res) {
    let names = [];
    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
      names = body && Array.isArray(body.names) ? body.names : [];
    } else if (req.method === 'GET') {
      const q = req.query || {};
      if (q.name) names = [{ name: q.name, country: q.country }];
    } else return reply(res, 405, { error: 'GET or POST only', _code: 'method_not_allowed' });
    names = names.map((n) => (typeof n === 'string' ? { name: n } : n || {}))
      .map((n) => ({ name: String(n.name || '').trim().slice(0, 200), country: /^[A-Za-z]{2}$/.test(n.country || '') ? n.country.toUpperCase() : null }))
      .filter((n) => n.name);
    if (!names.length) return reply(res, 400, { error: 'Give a company name (?name=...), or POST {"names": [{"name": "...", "country": "GB"}]}.', _code: 'bad_request' });
    if (names.length > 50) return reply(res, 400, { error: 'Up to 50 names per request.', _code: 'bad_request' });
    if (limited(req)) return tooMany(req, res, 'Too many lookups. Try again in a few minutes.');
    if (!sanctionsStore.enabled) return reply(res, 503, { error: 'Sanctions screening is not set up on this server (no Blob store).', _code: 'not_configured' });
    const idx = await sanctionsStore.load();
    if (!idx) return reply(res, 503, { error: 'The sanctions index is not available yet. Try again later.', _code: 'upstream_unavailable' });
    const results = names.map((n) => {
      const r = sanctionsLib.screen(idx, n.name, { country: n.country, limit: 10 });
      return { name: n.name, country: n.country, normalised: r.normalised,
        result: r.matches.length ? 'possible_match' : 'no_match', matches: r.matches };
    });
    return reply(res, 200, { notice: sanctionsLib.NOTICE, checked_at: idx.built_at, lists: sanctionsLib.listsSummary(idx),
      entities_only: true, results }, 3600);
  }

  const api = { search, company, presence: presenceCard, presenceReport, health, sanctions: sanctionsScreen };
  if (!apiVersion) return api;
  // On v1, anything unexpected still answers in the documented shape.
  const guard = (fn) => async (req, res) => {
    try { return await fn(req, res); } catch (e) {
      console.error(`Company Lookup v${apiVersion} error: ${e && e.message}`);
      if (!res.headersSent && !res.writableEnded) return reply(res, 500, { error: 'Something went wrong. Try again shortly.' });
    }
  };
  return Object.fromEntries(Object.entries(api).map(([k, fn]) => [k, guard(fn)]));
}

const HEALTH_TTL_MS = 10 * 1000;

function withTimeout(p, ms) {
  let t;
  return Promise.race([p, new Promise((_, reject) => { t = setTimeout(() => reject(new Error('timeout')), ms); })]).finally(() => clearTimeout(t));
}

module.exports = { createHandlers, normaliseNumber, toV1, sendV1, publicBase, API_VERSION };
