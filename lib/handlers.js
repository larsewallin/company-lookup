// Request handlers for /api/search and /api/company, with dependencies injected for tests.
'use strict';

const gleif = require('./gleif');
const { chSearch, chCompany, rdapDomain, normaliseDomain } = require('./sources');
const { buildCard } = require('./card');
const registers = require('./registers');
const wikidata = require('./wikidata');
const vies = require('./vies');

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
function createHandlers({ fetchFn = fetch, env = process.env, now = () => new Date(), limit = LIMIT, keyPrefix = '' } = {}) {
  const key = () => env.COMPANIES_HOUSE_API_KEY;
  const limited = (req) => rateLimited(keyPrefix + clientIp(req), now().getTime(), limit);

  async function search(req, res) {
    if (req.method !== 'GET') return send(res, 405, { error: 'GET only' });
    const q = String((req.query && req.query.q) || '').trim();
    const country = String((req.query && req.query.country) || '').toUpperCase();
    if (q.length < 2 || q.length > 100) return send(res, 400, { error: 'Enter between 2 and 100 characters.' });
    if (country && !/^[A-Z]{2}$/.test(country)) return send(res, 400, { error: 'Unknown country.' });
    if (limited(req)) return send(res, 429, { error: 'Too many lookups. Try again in a few minutes.' });

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
    if (!gl.ok && (!uk || !uk.ok) && (!nat || !nat.ok)) return send(res, 502, { error: 'The company registers could not be reached. Try again shortly.' });

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
    if (uk && !uk.ok) warnings.push(`Companies House could not be reached (${uk.error && uk.error.status ? 'HTTP ' + uk.error.status : 'no response'}), so UK results may be incomplete.`);
    return send(res, 200, { query: q, country: country || null, results: results.slice(0, 20), warnings }, warnings.length ? 0 : 3600);
  }

  async function company(req, res) {
    if (req.method !== 'GET') return send(res, 405, { error: 'GET only' });
    const query = req.query || {};
    let id = String(query.id || (query.number ? `gb:${query.number}` : '')).trim();
    const rawSite = query.website ? String(query.website).slice(0, 300) : '';
    const domainName = rawSite ? normaliseDomain(rawSite) : null;
    if (rawSite && !domainName) return send(res, 400, { error: 'That website address does not look right.' });

    let kind; let value;
    let reg = null;
    if (/^lei:/i.test(id)) { kind = 'lei'; value = id.slice(4).toUpperCase(); if (!LEI_RE.test(value)) value = null; }
    else if (/^gb:/i.test(id)) { kind = 'gb'; value = normaliseNumber(id.slice(3)); }
    else if (/^[a-z]{2}:/i.test(id) && registers.byCountry[id.slice(0, 2).toUpperCase()]) {
      kind = 'nat'; reg = registers.byCountry[id.slice(0, 2).toUpperCase()]; value = reg.normalise(id.slice(3));
    }
    if (!kind || !value) return send(res, 400, { error: 'Unknown company reference.' });
    if (kind === 'gb' && !key()) return send(res, 500, { error: 'UK register lookups are not set up yet.' });
    if (limited(req)) return send(res, 429, { error: 'Too many lookups. Try again in a few minutes.' });

    let g = null; let gleifState = 'none'; let ch = null; let chState = 'not-applicable';
    let nat = null; let natState = 'not-applicable';
    const asOfIso = now().toISOString().slice(0, 10);

    if (kind === 'lei') {
      try {
        g = await gleif.record(fetchFn, value);
      } catch (e) {
        return send(res, 502, { error: 'GLEIF could not be reached. Try again shortly.' });
      }
      if (!g) return send(res, 404, { error: `No LEI record ${value}.` }, 3600);
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
        return send(res, 502, { error: `${reg.name} could not be reached (${e && e.status ? 'HTTP ' + e.status : 'no response'}). Try again shortly.` });
      }
      if (!nat) return send(res, 404, { error: `No company ${value} in the ${reg.name} register.`, flag: 'Not on the register' }, 3600);
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
        if (e && e.status === 429) return send(res, 503, { error: 'Companies House is busy. Try again in a few minutes.' });
        const status = e && e.status ? e.status : 0;
        console.warn(`Companies House company lookup failed: HTTP ${status || 'no response'}`);
        if (status === 401 || status === 403) return send(res, 502, { error: `Companies House refused the API key (HTTP ${status}). Check COMPANIES_HOUSE_API_KEY: a Live REST key, with no IP or domain restrictions.` });
        return send(res, 502, { error: `Companies House could not be reached (${status ? 'HTTP ' + status : 'no response'}). Try again shortly.` });
      }
      if (!ch) return send(res, 404, { error: `No company ${value} on the Companies House register.`, flag: 'Not on the register' }, 3600);
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
    return send(res, 200, card, 21600);
  }

  return { search, company };
}

module.exports = { createHandlers, normaliseNumber };
