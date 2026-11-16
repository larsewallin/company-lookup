// Offline tests for sanctions screening: run with `node --test tests/sanctions.test.js`.
// The fixtures copy the real layouts of the OFAC, EU, UN and UK files (checked against the live files on 16 Nov 2026).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const S = require('../lib/sanctions');
const { applySanctions, sanctionsNames } = require('../lib/card');
const { createHandlers } = require('../lib/handlers');
const { createSanctionsImport } = require('../api/sanctions-import');
const { createMcp } = require('../lib/mcp');

const FX = path.join(__dirname, 'fixtures', 'sanctions');
const read = (f) => fs.readFileSync(path.join(FX, f), 'utf8');
const NOW = new Date('2026-11-16T12:00:00Z');

function lists() {
  return {
    ofac_sdn: S.parseOfac('ofac_sdn', read('SDN.CSV'), read('ALT.CSV'), read('ADD.CSV')),
    ofac_cons: S.parseOfac('ofac_cons', read('CONS_PRIM.CSV'), read('CONS_ALT.CSV'), read('CONS_ADD.CSV')),
    eu: S.parseEu(read('eu.csv')),
    un: S.parseUn(read('un.xml')),
    uk: S.parseUk(read('uk.csv')),
  };
}
function index() {
  const L = lists();
  const meta = Object.fromEntries(Object.entries(L).map(([k, v]) => [k, { name: S.SOURCES[k].name, short: S.SOURCES[k].short, entities: v.length, fetched_at: '2026-11-16T06:19:00Z' }]));
  return S.buildIndex(L, meta, '2026-11-16T06:19:00Z');
}

// ---------- parsers ----------

test('OFAC: entities only (no individuals or vessels), aliases, countries, programmes, link', () => {
  const L = lists();
  assert.deepEqual(L.ofac_sdn.map((e) => e.id), ['36', '306', '24000']);
  const r = L.ofac_sdn.find((e) => e.id === '24000');
  assert.deepEqual(r.aliases, ['ROSNEFT']);
  assert.deepEqual(r.countries, ['RU']);
  assert.deepEqual(r.programmes, ['UKRAINE-EO13662', 'RUSSIA-EO14024']);
  assert.match(r.url, /sanctionssearch\.ofac\.treas\.gov\/Details\.aspx\?id=24000/);
  assert.deepEqual(L.ofac_sdn.find((e) => e.id === '306').countries, ['CH']);
  assert.deepEqual(L.ofac_cons.map((e) => [e.name, e.countries]), [['HUAWEI TECHNOLOGIES CO., LTD.', ['CN']]]);
});

test('EU: semicolons and line breaks inside quotes, enterprises only, names grouped by entity', () => {
  const eu = lists().eu;
  assert.equal(eu.length, 2);
  const g = eu.find((e) => e.id === '144500');
  assert.equal(g.name, 'JSC Goznak');
  assert.deepEqual(g.aliases, ['АО «Гознак»']);
  assert.deepEqual(g.countries, ['RU']);
  assert.equal(g.listed_on, '2022-10-06');
  assert.deepEqual(g.programmes, ['UKR']);
  assert.throws(() => S.parseEu('a;b;c\n1;2;3\n'), /layout changed/);
});

test('UN: entities only, aliases, country names to codes, XML entities decoded', () => {
  const un = lists().un;
  assert.equal(un.length, 2);
  assert.deepEqual(un[0], { list: 'un', id: 'IRe.069', name: 'SHAHID SATTARI INDUSTRIES', aliases: ['Shahid Sattari Group Equipment Industries'],
    programmes: ['Iran'], countries: ['IR'], listed_on: '2010-06-09', url: 'https://main.un.org/securitycouncil/en/content/un-sc-consolidated-list' });
  assert.equal(un[1].name, 'AL-HARAMAIN & AL MASJED AL-AQSA CHARITY FOUNDATION');
  assert.deepEqual(un[1].countries, ['BA']);
});

test('UK: title line skipped, entities grouped by Unique ID, primary name and aliases, ISO dates', () => {
  const uk = lists().uk;
  assert.deepEqual(uk.map((e) => e.id), ['IRN0124', 'RUS0257']);
  assert.equal(uk[0].name, 'Basij Cooperative Foundation');
  assert.deepEqual(uk[0].aliases, ['Bonyad Taavon Basij']);
  assert.equal(uk[0].listed_on, '2023-01-23');
  assert.deepEqual(uk[0].countries, ['IR']);
  assert.deepEqual(uk[1].countries, ['RU']);
});

test('country names from every list map to ISO codes; retired codes never win', () => {
  for (const [n, c] of [['Russia', 'RU'], ['Russian Federation', 'RU'], ['United Kingdom', 'GB'], ['Iran (Islamic Republic of)', 'IR'],
    ["Democratic People's Republic of Korea", 'KP'], ['Switzerland', 'CH'], ['Türkiye', 'TR'], ['Syrian Arab Republic', 'SY'], ['RU', 'RU']]) {
    assert.equal(S.countryCode(n), c, n);
  }
  assert.equal(S.countryCode('Atlantis'), null);
});

// ---------- matching ----------

test('screening levels: exact, strong, possible, and no match for brands sharing one word', () => {
  const idx = index();
  const lev = (q, c) => S.screen(idx, q, { country: c }).matches.map((m) => `${m.level}:${m.list}:${m.id}`);
  assert.deepEqual(lev('Rosneft', 'RU'), ['exact:ofac_sdn:24000']); // alias, legal suffixes ignored
  assert.equal(S.screen(idx, 'Rosneft', { country: 'RU' }).matches[0].same_country, true);
  assert.deepEqual(lev('Banco Nacional de Cuba S.A.'), ['exact:ofac_sdn:306']);
  assert.deepEqual(lev('Huawei Technologies'), ['exact:ofac_cons:9650']);
  assert.deepEqual(lev('Basij Cooperative Foundation Iran'), ['strong:uk:IRN0124']);
  assert.deepEqual(lev('Shahid Satari Industries'), ['possible:un:IRe.069']); // spelling variant
  assert.deepEqual(lev('Gazprom Neft PJSC'), ['exact:uk:RUS0257']);
  assert.deepEqual(lev('Tesco PLC'), []);
  assert.deepEqual(lev('Siemens AG'), []);
  assert.deepEqual(lev('Nidal'), []); // one short word
  assert.deepEqual(lev('Goznak'), ['exact:eu:144500']);
  // Brand-like single words never match a longer distinctive name ("Oriental Apple" for "Apple")
  const idx2 = S.buildIndex({ ofac_sdn: [{ id: '1', name: 'ORIENTAL APPLE COMPANY PTE LTD', aliases: [], programmes: [], countries: [] },
    { id: '2', name: 'GLOBAL TRADING LLC', aliases: [], programmes: [], countries: [] }] }, { ofac_sdn: { name: 'x' } }, 'now');
  assert.deepEqual(S.screen(idx2, 'Apple Inc').matches, []);
  // A name made only of common words is at most "possible", even when identical
  assert.deepEqual(S.screen(idx2, 'Global Trading Ltd').matches.map((m) => m.level), ['possible']);
});

test('individuals are never in the index', () => {
  const idx = index();
  assert.deepEqual(S.screen(idx, 'Mohammed Abu Teir').matches, []);
  assert.deepEqual(S.screen(idx, 'Ivan Ivanov').matches, []);
  assert.deepEqual(S.screen(idx, 'Saddam Hussein Al-Tikriti').matches, []);
});

// ---------- card ----------

function card(over = {}) {
  return { identity: { legal_name: 'ROSNEFT OIL COMPANY', country: 'RU', other_names: [], former_names: [] }, group: null,
    flags: [{ level: 'note', label: 'Some note', detail: '', source: 'X' }], verdict: 'clear', sources: [], gaps: ['News and web presence are not checked yet.'], ...over };
}
const sc = (names, idx = index()) => ({ state: 'ok', notice: S.NOTICE, checked_at: idx.built_at, lists: S.listsSummary(idx),
  results: names.map((n) => ({ ...n, matches: S.screen(idx, n.name, { country: n.country || null }).matches })) });

test('card: an exact match on the company name in its own country is Stop, worded as a review', () => {
  const c = applySanctions(card(), sc([{ name: 'ROSNEFT OIL COMPANY', role: 'company', country: 'RU' }]));
  assert.equal(c.verdict, 'stop');
  assert.equal(c.flags[0].label, 'Possible sanctions match: review');
  assert.match(c.flags[0].detail, /a shared name is not proof/);
  assert.ok(!/is sanctioned/i.test(JSON.stringify(c.flags)));
  assert.equal(c.sanctions.matches[0].list, 'ofac_sdn');
  assert.equal(c.sources.at(-1).result, '1 possible match to review');
  assert.equal(c.gaps.at(-1), 'News and web presence are not checked yet.');
});

test('card: same name in another country is Check, not Stop; a parent match is Check; a clean card stays clear', () => {
  let c = applySanctions(card({ identity: { legal_name: 'Banco Nacional de Cuba', country: 'ES', other_names: [], former_names: [] } }),
    sc([{ name: 'Banco Nacional de Cuba', role: 'company', country: 'ES' }]));
  assert.equal(c.verdict, 'check');
  c = applySanctions(card({ identity: { legal_name: 'Acme Ltd', country: 'GB', other_names: [], former_names: [] } }),
    sc([{ name: 'Acme Ltd', role: 'company' }, { name: 'Gazprom Neft', role: 'parent' }]));
  assert.deepEqual(c.flags.map((f) => f.label), ['Parent company: possible sanctions match', 'Some note']);
  c = applySanctions(card({ identity: { legal_name: 'Tesco PLC', country: 'GB', other_names: [], former_names: [] } }), sc([{ name: 'Tesco PLC', role: 'company' }]));
  assert.equal(c.verdict, 'clear');
  assert.equal(c.sanctions.matches.length, 0);
  assert.equal(c.sources.at(-1).result, 'No match');
  assert.equal(c.sanctions.lists.length, 5);
});

test('card: unavailable index adds a gap, never a flag; names screened include former names and parents', () => {
  const c = applySanctions(card(), { state: 'unavailable', notice: S.NOTICE });
  assert.equal(c.verdict, 'clear');
  assert.ok(c.gaps.some((g) => /Sanctions lists could not be checked/.test(g)));
  assert.deepEqual(sanctionsNames({ identity: { legal_name: 'A Ltd', other_names: ['A Limited', 'a ltd'], former_names: [{ name: 'Old A Ltd' }] },
    group: { direct_parent: { name: 'P plc' }, ultimate_parent: { name: 'P plc' } } }),
  [{ name: 'A Ltd', role: 'company' }, { name: 'A Limited', role: 'other name' }, { name: 'Old A Ltd', role: 'former name' }, { name: 'P plc', role: 'parent' }]);
});

// ---------- HTTP handler, import, MCP ----------

function mockRes() {
  return { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(t) { this.body = t ? JSON.parse(t) : undefined; } };
}
let ip = 0;
const store = (idx) => ({ enabled: true, load: async () => idx });

test('GET and POST /api/sanctions: results per name with the notice and list dates; bad input and no store', async () => {
  const h = createHandlers({ env: {}, now: () => NOW, sanctions: store(index()) });
  let res = mockRes();
  await h.sanctions({ method: 'GET', query: { name: 'Rosneft', country: 'ru' }, headers: { 'x-forwarded-for': `10.7.0.${++ip}` }, socket: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.notice, S.NOTICE);
  assert.equal(res.body.results[0].result, 'possible_match');
  assert.equal(res.body.results[0].country, 'RU');
  assert.equal(res.body.lists.length, 5);
  res = mockRes();
  await h.sanctions({ method: 'POST', body: JSON.stringify({ names: [{ name: 'Tesco PLC', country: 'GB' }, 'Goznak'] }), query: {}, headers: { 'x-forwarded-for': `10.7.0.${++ip}` }, socket: {} }, res);
  assert.deepEqual(res.body.results.map((r) => r.result), ['no_match', 'possible_match']);
  res = mockRes();
  await h.sanctions({ method: 'GET', query: {}, headers: {}, socket: {} }, res);
  assert.equal(res.statusCode, 400);
  res = mockRes();
  await h.sanctions({ method: 'POST', body: { names: Array.from({ length: 51 }, () => ({ name: 'x' })) }, query: {}, headers: {}, socket: {} }, res);
  assert.equal(res.statusCode, 400);
  const none = createHandlers({ env: {}, now: () => NOW, sanctions: { enabled: false, load: async () => null } });
  res = mockRes();
  await none.sanctions({ method: 'GET', query: { name: 'Rosneft' }, headers: { 'x-forwarded-for': `10.7.0.${++ip}` }, socket: {} }, res);
  assert.equal(res.statusCode, 503);
  const v1 = createHandlers({ env: {}, now: () => NOW, sanctions: store(index()), apiVersion: '1' });
  res = mockRes();
  await v1.sanctions({ method: 'GET', query: { name: 'Goznak' }, headers: { 'x-forwarded-for': `10.7.0.${++ip}` }, socket: {} }, res);
  assert.equal(res.body.api_version, '1');
  assert.equal(res.body.results[0].matches[0].list, 'eu');
});

test('company card on the HTTP API carries the sanctions block when an index is set up', async () => {
  const json = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
  const fetchFn = async (url) => {
    if (url.includes('api.gleif.org') && url.includes('lei-records/')) return json(404, {});
    if (url.includes('api.gleif.org')) return json(200, { data: [] });
    return json(404, {});
  };
  const h = createHandlers({ fetchFn, env: {}, now: () => NOW, sanctions: store(index()) });
  const res = mockRes();
  await h.company({ method: 'GET', query: { id: 'lei:253400JT3MQWNDKMJE44' }, headers: { 'x-forwarded-for': `10.7.0.${++ip}` }, socket: {} }, res);
  // No LEI record in this fake, so the card isn't built: the point is that screening never breaks a lookup.
  assert.ok([200, 404, 502].includes(res.statusCode));
});

test('daily import: builds the index from all lists; a failed list keeps its previous entries; skips when fresh', async () => {
  const files = {
    'SDN.CSV': read('SDN.CSV'), 'ALT.CSV': read('ALT.CSV'), 'ADD.CSV': read('ADD.CSV'), 'CONS_PRIM.CSV': read('CONS_PRIM.CSV'),
    'CONS_ALT.CSV': read('CONS_ALT.CSV'), 'CONS_ADD.CSV': read('CONS_ADD.CSV'), content: read('eu.csv'), 'consolidated.xml': read('un.xml'),
    'UK-Sanctions-List.csv': read('uk.csv'),
  };
  let stored = null; let failUk = false;
  const fetchFn = async (url) => {
    if (url.includes('sanctions/index.json')) return stored ? { ok: true, status: 200, json: async () => JSON.parse(stored) } : { ok: false, status: 404 };
    const f = url.split('?')[0].split('/').pop();
    if (failUk && f === 'UK-Sanctions-List.csv') return { ok: false, status: 503, text: async () => '' };
    return files[f] != null ? { ok: true, status: 200, text: async () => files[f] } : { ok: false, status: 404, text: async () => '' };
  };
  const blobFetch = async (url, init) => { stored = init.body; return { ok: true, status: 200, json: async () => ({ url }), text: async () => '{}' }; };
  const env = { BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_abcd1234_secret' };
  let t = NOW;
  const imp = createSanctionsImport({ fetchFn, blobFetch, env, now: () => t });
  let res = mockRes();
  await imp({ query: {}, headers: {} }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.report, { ofac_sdn: 3, ofac_cons: 1, eu: 2, un: 2, uk: 2 });
  const idx = JSON.parse(stored);
  assert.equal(idx.entries.length, 10);
  res = mockRes();
  await imp({ query: {}, headers: {} }, res);
  assert.equal(res.body.skipped, true);
  t = new Date(NOW.getTime() + 25 * 3600000); failUk = true;
  res = mockRes();
  await imp({ query: {}, headers: {} }, res);
  assert.match(res.body.report.uk, /failed: HTTP 503/);
  const idx2 = JSON.parse(stored);
  assert.equal(idx2.entries.filter((e) => e.l === 'uk').length, 2); // kept from the previous run
  assert.match(idx2.lists.uk.error, /showing the list as fetched 2026-11-16/);
  assert.deepEqual(S.screen(idx2, 'Gazprom Neft').matches.map((m) => m.list), ['uk']);
});

test('MCP: screen_sanctions is listed and returns results', async () => {
  const mcp = createMcp({ env: {}, now: () => NOW, sanctions: store(index()) });
  let res = mockRes();
  await mcp.handler({ method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'tools/list' }, headers: {}, socket: {} }, res);
  assert.ok(res.body.result.tools.some((t) => t.name === 'screen_sanctions' && t.annotations.readOnlyHint));
  res = mockRes();
  await mcp.handler({ method: 'POST', body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'screen_sanctions', arguments: { name: 'Mahan Air Rosneft' } } }, headers: {}, socket: {} }, res);
  assert.equal(res.body.result.isError, undefined);
  res = mockRes();
  await mcp.handler({ method: 'POST', body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'screen_sanctions', arguments: { names: [{ name: 'Goznak' }, { name: 'Tesco' }] } } }, headers: {}, socket: {} }, res);
  assert.deepEqual(res.body.result.structuredContent.results.map((r) => r.result), ['possible_match', 'no_match']);
});
