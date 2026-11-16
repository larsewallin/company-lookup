// Offline tests for the stable /v1/ API (docs/api-v1.md): contract, API keys, errors, health and
// regression of the old /api/* routes. Run with `node --test tests/v1.test.js`.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHandlers, toV1, publicBase } = require('../lib/handlers');
const { createMcp } = require('../lib/mcp');
const keys = require('../lib/keys');
const S = require('./support/scenarios');
const SNAPSHOT = require('./fixtures/api-legacy-snapshot.json');

const KEY = 'cl_test-key-never-real-0123456789abcdef';
const OTHER = 'cl_another-test-key-9876543210';
const REPORTER = 'cl_reporter-test-key-5555555555';
const reporterEnv = () => ({ COMPANIES_HOUSE_API_KEY: 'test-key', COMPANY_LOOKUP_API_KEYS: `reporter-app:${keys.sha256(REPORTER).toString('hex')}` });
const KEYS_ENV = `trade-credit-monitor:${keys.sha256(KEY).toString('hex')}, other-app:${keys.sha256(OTHER).toString('hex')}`;

const v1 = (extra = {}) => createHandlers({ ...S.deps(extra), apiVersion: '1' });
const legacy = (extra = {}) => createHandlers(S.deps(extra));
async function call(h, fn, request) { const res = S.mockRes(); await h[fn](request, res); return res; }

// ---------- a tiny type checker for the documented shapes ----------
// spec: { field: 'string' | 'number' | 'boolean' | 'array' | 'object' | 'string|null' | … ; '?field' = may be missing }
function shape(obj, spec, where = 'body') {
  assert.ok(obj && typeof obj === 'object', `${where} is an object`);
  for (const [k0, t] of Object.entries(spec)) {
    const optional = k0.startsWith('?');
    const k = optional ? k0.slice(1) : k0;
    if (!(k in obj)) { assert.ok(optional, `${where}.${k} is present`); continue; }
    const v = obj[k];
    const ok = t.split('|').some((one) => (one === 'null' ? v === null : one === 'array' ? Array.isArray(v) : one === 'object' ? v && typeof v === 'object' && !Array.isArray(v) : typeof v === one));
    assert.ok(ok, `${where}.${k} is ${t} (got ${JSON.stringify(v)})`);
  }
}
const ERROR_SHAPE = { api_version: 'string', error: 'object' };
const ERR = { code: 'string', message: 'string' };
function assertError(res, status, code) {
  assert.equal(res.statusCode, status, JSON.stringify(res.body));
  shape(res.body, ERROR_SHAPE);
  shape(res.body.error, ERR, 'error');
  assert.equal(res.body.api_version, '1');
  assert.equal(res.body.error.code, code);
  assert.deepEqual(Object.keys(res.body), ['api_version', 'error']);
}

// ---------- regression: /api/* is unchanged ----------

test('regression: /api/* responses match the snapshot taken before v1 was added', async () => {
  const out = await S.runAll(legacy());
  for (const name of Object.keys(SNAPSHOT)) assert.deepEqual(out[name], SNAPSHOT[name], name);
  assert.deepEqual(Object.keys(out), Object.keys(SNAPSHOT));
});

test('regression: /api/* ignores API keys and keeps its own error shape', async () => {
  const h = legacy({ env: { COMPANIES_HOUSE_API_KEY: 'test-key', COMPANY_LOOKUP_API_KEYS: KEYS_ENV } });
  const res = await call(h, 'company', S.req('GET', { id: 'xx:1' }, null, { authorization: `Bearer ${KEY}` }));
  assert.deepEqual(res.body, { error: 'Unknown company reference.' });
  const reports = legacy();
  await call(reports, 'presence', S.req('GET', { id: S.COLEAGO, lon: '-0.20729', lat: '51.50255' }));
  const r = await call(reports, 'presenceReport', S.req('POST', {}, { id: S.COLEAGO, entity_id: 'gb:06960521' }));
  assert.equal(r.statusCode, 200);
});

test('regression: the MCP server and library are unaffected', async () => {
  const mcp = createMcp(S.deps());
  const res = S.mockRes();
  await mcp.handler({ method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' }, socket: {} }, res);
  const names = res.body.result.tools.map((t) => t.name);
  assert.deepEqual(names, ['search_companies', 'get_company_card', 'get_presence_card']);
  const { createLookup } = require('../lib/index');
  const lookup = createLookup(S.deps());
  const card = await lookup.company('gb:01234567');
  assert.equal(card.api_version, undefined, 'the library returns the plain card');
});

// ---------- one handler: v1 is /api/* plus api_version ----------

test('v1 success bodies are the /api/* bodies with api_version added', async () => {
  const out = await S.runAll(v1());
  for (const [name, snap] of Object.entries(SNAPSHOT)) {
    if (snap.status !== 200) continue;
    const got = out[name];
    assert.equal(got.status, 200, name);
    assert.equal(got.body.api_version, '1', name);
    assert.equal(Object.keys(got.body)[0], 'api_version', `${name}: api_version comes first`);
    const { api_version: _, ...rest } = got.body;
    const norm = (b) => JSON.parse(JSON.stringify(b).replaceAll('https://example.test/v1/presence-report', '/api/presence-report'));
    assert.deepEqual(norm(rest), snap.body, name);
    assert.equal(got.headers['cache-control'], snap.headers['cache-control'], `${name}: same cache headers`);
  }
});

// ---------- contract ----------

test('contract: GET /v1/search', async () => {
  const res = await call(v1(), 'search', S.req('GET', { q: 'Example Trading', country: 'GB' }));
  assert.equal(res.statusCode, 200);
  shape(res.body, { api_version: 'string', query: 'string', country: 'string|null', results: 'array', presence: 'array', warnings: 'array' });
  assert.ok(res.body.results.length > 0);
  for (const r of res.body.results) {
    shape(r, { id: 'string', source: 'string', name: 'string', country: 'string', tier: 'string', '?status': 'string|null', '?number': 'string|null', '?city': 'string|null', '?address': 'string|null', '?incorporated': 'string|null', '?lei': 'string', '?ticker': 'string', '?kind': 'string', '?locations': 'array' }, 'result');
    assert.ok(['register', 'gleif'].includes(r.tier));
  }
  assert.match(res.headers['cache-control'], /s-maxage=3600/);
});

test('contract: search lists linked places as locations[] and other places in presence[]', async () => {
  const store = S.memStore();
  const h = v1({ store });
  await call(h, 'presence', S.req('GET', { id: S.COLEAGO, lon: '-0.20729', lat: '51.50255' }));
  // Make the place's link point at the company the fake register returns, plus one unlinked place.
  const rec = store.idx.records[S.COLEAGO];
  rec.link.entity_ids = ['gb:01234567']; rec.norm = 'example trading';
  store.idx.records['00000000-0000-0000-0000-00000000000a'] = { summary: { ...rec.summary, id: 'overture:00000000-0000-0000-0000-00000000000a' }, norm: 'example trading', country: 'GB', link: null };
  const res = await call(h, 'search', S.req('GET', { q: 'Example Trading', country: 'GB' }));
  const ent = res.body.results.find((r) => r.id === 'gb:01234567');
  assert.equal(ent.locations.length, 1);
  shape(ent.locations[0], { id: 'string', tier: 'string', label: 'string', name: 'string', address: 'object', location: 'object' }, 'location');
  assert.equal(res.body.presence.length, 1);
  shape(res.body.presence[0], { id: 'string', tier: 'string', label: 'string', name: 'string', address: 'object', location: 'object', linked_entity: 'object|null' }, 'presence');
  assert.equal(res.body.presence[0].tier, 'presence');
});

test('contract: GET /v1/company', async () => {
  const res = await call(v1(), 'company', S.req('GET', { id: 'gb:01234567' }));
  assert.equal(res.statusCode, 200);
  shape(res.body, { api_version: 'string', id: 'string', verdict: 'string', flags: 'array', identity: 'object', ids: 'object', sources: 'array', gaps: 'array', next_step: 'string', as_of: 'string', rules: 'object', '?group': 'object|null', '?people': 'object|null', '?filings': 'object|null', '?charges': 'object|null', '?web': 'object|null', '?financials': 'object|null', '?about': 'object|null', '?presence': 'object' });
  assert.ok(['stop', 'check', 'clear'].includes(res.body.verdict));
  shape(res.body.identity, { legal_name: 'string', country: 'string', status: 'string|null' }, 'identity');
  for (const f of res.body.flags) shape(f, { level: 'string', label: 'string', detail: 'string', source: 'string' }, 'flag');
  assert.match(res.headers['cache-control'], /s-maxage=21600/);
});

test('contract: company card presence.locations[]', async () => {
  const store = S.memStore();
  const h = v1({ store });
  await call(h, 'presence', S.req('GET', { id: S.COLEAGO, lon: '-0.20729', lat: '51.50255' }));
  store.idx.records[S.COLEAGO].link.entity_ids = ['gb:01234567'];
  const res = await call(h, 'company', S.req('GET', { id: 'gb:01234567' }));
  shape(res.body.presence, { notice: 'string', locations: 'array' }, 'presence');
  assert.equal(res.body.presence.locations[0].tier, 'presence');
});

test('contract: GET /v1/presence', async () => {
  const res = await call(v1(), 'presence', S.req('GET', { id: S.COLEAGO, lon: '-0.20729', lat: '51.50255' }));
  assert.equal(res.statusCode, 200);
  shape(res.body, { api_version: 'string', tier: 'string', notice: 'string', id: 'string', name: 'string|null', categories: 'object|null', address: 'object', location: 'object|null', '?websites': 'array', '?phones': 'array', '?socials': 'array', '?brand': 'object', confidence: 'number|null', sources: 'array', attribution: 'string', release: 'string', checked_at: 'string', linked_entity: 'object|null', possible_matches: 'array', official_register: 'object|null', '?link_note': 'string' });
  assert.equal(res.body.tier, 'presence');
  for (const s of res.body.sources) shape(s, { dataset: 'string', license: 'string|null', update_time: 'string|null', record_id: 'string|null', properties: 'array' }, 'source');
  const l = res.body.linked_entity;
  shape(l, { id: 'string', name: 'string', register: 'string', number: 'string|null', level: 'string', evidence: 'object', linked_on: 'string', text: 'string', report: 'object' }, 'linked_entity');
  assert.equal(l.report.url, 'https://example.test/v1/presence-report', 'v1 report links are full v1 URLs');
  shape(res.body.official_register, { label: 'string', register: 'string', tool: 'string', arguments: 'object' }, 'official_register');
});

test('contract: POST /v1/presence-report', async () => {
  const h = v1();
  await call(h, 'presence', S.req('GET', { id: S.COLEAGO, lon: '-0.20729', lat: '51.50255' }));
  const res = await call(h, 'presenceReport', S.req('POST', {}, { id: S.COLEAGO, entity_id: 'gb:06960521' }));
  assert.equal(res.statusCode, 200);
  shape(res.body, { api_version: 'string', ok: 'boolean', status: 'string', message: 'string' });
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('contract: GET /v1/coverage', async () => {
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' });
  try {
    const res = S.mockRes();
    await require('../api/v1/coverage')({ method: 'GET', query: {}, headers: {} }, res);
    assert.equal(res.statusCode, 200);
    shape(res.body, { api_version: 'string', as_of: 'string' });
    const legacyRes = S.mockRes();
    await require('../api/coverage')({ method: 'GET', query: {}, headers: {} }, legacyRes);
    const { api_version: _, ...rest } = res.body;
    assert.deepEqual(Object.keys(rest), Object.keys(legacyRes.body));
    assert.equal(legacyRes.body.api_version, undefined);
    const post = S.mockRes();
    await require('../api/v1/coverage')({ method: 'POST', query: {}, headers: {} }, post);
    assertError(post, 405, 'method_not_allowed');
  } finally { global.fetch = realFetch; }
});

// ---------- health ----------

test('health: ok with release, version and Blob status; no register calls; cached', async () => {
  const calls = [];
  let t = Date.parse('2026-11-15T12:00:00Z');
  const store = { ...S.memStore(), ping: async () => true };
  const h = createHandlers({ ...S.deps({ store, fetchFn: async (u) => { calls.push(u); return S.json(404, {}); }, now: () => new Date(t), env: { COMPANIES_HOUSE_API_KEY: 'k', VERCEL_GIT_COMMIT_SHA: 'abc123' } }), apiVersion: '1' });
  let res = await call(h, 'health', S.req('GET', {}));
  assert.equal(res.statusCode, 200);
  shape(res.body, { status: 'string', api_version: 'string', version: 'string', commit: 'string|null', overture_release: 'string|null', blob: 'object', sources: 'object', checked_at: 'string' });
  assert.equal(res.body.status, 'ok');
  assert.equal(res.body.overture_release, '2026-10-21.0');
  assert.equal(res.body.commit, 'abc123');
  assert.deepEqual(res.body.blob, { configured: true, reachable: true });
  assert.equal(res.body.sources.companies_house, 'configured');
  assert.equal(calls.length, 0, 'no live register calls');
  assert.match(res.headers['cache-control'], /s-maxage=10/);
  const first = res.body.checked_at;
  t += 5000; res = await call(h, 'health', S.req('GET', {}));
  assert.equal(res.body.checked_at, first, 'cached for a few seconds');
  t += 11000; res = await call(h, 'health', S.req('GET', {}));
  assert.notEqual(res.body.checked_at, first);
});

test('health: degraded when Overture or the Blob store cannot be reached; ok with no store set up', async () => {
  const down = { latestRelease: async () => { throw new Error('down'); } };
  let res = await call(v1({ overture: down }), 'health', S.req('GET', {}));
  assert.equal(res.body.status, 'degraded');
  assert.equal(res.body.overture_release, null);
  res = await call(v1({ store: { ...S.memStore(), ping: async () => { throw new Error('x'); } } }), 'health', S.req('GET', {}));
  assert.equal(res.body.status, 'degraded');
  assert.equal(res.body.sources.blob, 'unreachable');
  res = await call(v1({ store: { enabled: false, load: async () => ({ records: {} }), update: async () => false } }), 'health', S.req('GET', {}));
  assert.equal(res.body.status, 'ok');
  assert.deepEqual(res.body.blob, { configured: false, reachable: null });
});

// ---------- errors ----------

test('errors: every v1 code has the documented shape and status', async () => {
  const h = v1();
  assertError(await call(h, 'search', S.req('GET', { q: 'x' })), 400, 'bad_request');
  assertError(await call(h, 'company', S.req('GET', { id: 'gb:07777777' })), 404, 'not_found');
  assertError(await call(h, 'search', S.req('POST', {})), 405, 'method_not_allowed');
  assertError(await call(h, 'company', S.req('GET', { id: 'gb:09999999' })), 503, 'upstream_busy');
  assertError(await call(h, 'company', S.req('GET', { id: 'gb:08888888' })), 502, 'upstream_unavailable');
  assertError(await call(v1({ env: {} }), 'company', S.req('GET', { id: 'gb:01234567' })), 503, 'not_configured');
  const noStore = v1({ store: { enabled: false, load: async () => ({ records: {} }), update: async () => false } });
  assertError(await call(noStore, 'presenceReport', S.req('POST', {}, { id: S.COLEAGO, entity_id: 'gb:1' })), 503, 'not_configured');
  const broken = v1({ store: { enabled: true, load: async () => { throw new Error('boom'); }, update: async () => true } });
  const res = await call(broken, 'search', S.req('GET', { q: 'Example Trading', country: 'GB' }));
  assertError(res, 500, 'internal');
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('errors: extra details stay inside error, and the human message is kept', async () => {
  const res = await call(v1(), 'company', S.req('GET', { id: 'gb:07777777' }));
  assert.equal(res.body.error.message, 'No company 07777777 on the Companies House register.');
  assert.equal(res.body.error.flag, 'Not on the register');
  assert.equal(toV1(200, { a: 1 }).body.api_version, '1');
});

test('errors: rate_limited carries retry_after and a Retry-After header', async () => {
  const h = v1();
  let res;
  for (let i = 0; i < 41; i++) res = await call(h, 'search', { method: 'GET', query: { q: 'abc' }, headers: { 'x-forwarded-for': '10.200.0.1' }, socket: {} });
  assertError(res, 429, 'rate_limited');
  assert.equal(typeof res.body.error.retry_after, 'number');
  assert.ok(res.body.error.retry_after > 0 && res.body.error.retry_after <= 300);
  assert.equal(res.headers['retry-after'], String(res.body.error.retry_after));
  assert.equal(res.body.error.message, 'Too many lookups. Try again in a few minutes.');
});

// ---------- API keys ----------

const keyedEnv = (extra = {}) => ({ COMPANIES_HOUSE_API_KEY: 'test-key', COMPANY_LOOKUP_API_KEYS: KEYS_ENV, ...extra });
const hit = (h, ip, headers = {}) => call(h, 'search', { method: 'GET', query: { q: 'abc' }, headers: { 'x-forwarded-for': ip, ...headers }, socket: {} });

test('keys: a valid key gets the keyed limit (10x by default), separate from anonymous traffic', async () => {
  const h = v1({ env: keyedEnv() });
  const ip = '10.201.0.1';
  for (let i = 0; i < 41; i++) await hit(h, ip); // anonymous traffic from the same address uses up its own limit
  assert.equal((await hit(h, ip)).statusCode, 429);
  let res;
  for (let i = 0; i < 400; i++) { res = await hit(h, ip, { authorization: `Bearer ${KEY}` }); assert.equal(res.statusCode, 200, `keyed request ${i + 1}`); }
  res = await hit(h, ip, { authorization: `Bearer ${KEY}` });
  assert.equal(res.statusCode, 429);
  // Another key has its own bucket.
  assert.equal((await hit(h, ip, { 'x-api-key': OTHER })).statusCode, 200);
});

test('keys: COMPANY_LOOKUP_KEY_RATE_LIMIT sets the keyed limit; X-Api-Key works too', async () => {
  const h = v1({ env: keyedEnv({ COMPANY_LOOKUP_KEY_RATE_LIMIT: '3', COMPANY_LOOKUP_API_KEYS: `limit-test:${keys.sha256(KEY).toString('hex')}` }) });
  for (let i = 0; i < 3; i++) assert.equal((await hit(h, '10.202.0.1', { 'x-api-key': KEY })).statusCode, 200);
  assert.equal((await hit(h, '10.202.0.2', { 'x-api-key': KEY })).statusCode, 429, 'the key, not the address, is limited');
});

test('keys: an invalid or malformed key falls back to anonymous, without an error', async () => {
  const h = v1({ env: keyedEnv() });
  for (const headers of [{ authorization: 'Bearer cl_wrong' }, { authorization: 'Basic abc' }, { 'x-api-key': '' }, { authorization: `Bearer ${'x'.repeat(500)}` }]) {
    const res = await call(h, 'search', S.req('GET', { q: 'Example Trading', country: 'GB' }, null, headers));
    assert.equal(res.statusCode, 200, JSON.stringify(headers).slice(0, 60));
  }
  let res;
  for (let i = 0; i < 41; i++) res = await hit(h, '10.203.0.1', { authorization: 'Bearer cl_wrong' });
  assert.equal(res.statusCode, 429, 'an unknown key gets the anonymous limit');
});

test('keys: without COMPANY_LOOKUP_API_KEYS nothing changes', async () => {
  const h = v1();
  const a = await call(h, 'company', S.req('GET', { id: 'gb:01234567' }));
  const b = await call(h, 'company', S.req('GET', { id: 'gb:01234567' }, null, { authorization: `Bearer ${KEY}` }));
  assert.deepEqual(a.body, b.body);
  let res;
  for (let i = 0; i < 41; i++) res = await hit(h, '10.204.0.1', { authorization: `Bearer ${KEY}` });
  assert.equal(res.statusCode, 429);
});

test('keys: the caller name is logged, the raw key never is, and reports are labelled', async () => {
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  let report; let card;
  try {
    const h = v1({ env: reporterEnv() });
    const headers = { authorization: `Bearer ${REPORTER}` };
    card = await call(h, 'presence', S.req('GET', { id: S.COLEAGO, lon: '-0.20729', lat: '51.50255' }, null, headers));
    report = await call(h, 'presenceReport', S.req('POST', {}, { id: S.COLEAGO, entity_id: 'gb:06960521' }, headers));
  } finally { console.log = orig; }
  assert.ok(logs.some((l) => l.includes('reporter-app')), logs.join('\n'));
  assert.ok(!logs.some((l) => l.includes(REPORTER)));
  assert.ok(!JSON.stringify(card.body).includes(REPORTER) && !JSON.stringify(report.body).includes(REPORTER));
  assert.equal(report.statusCode, 200);
});

test('keys: a keyed report is labelled with the caller name; an anonymous one is not', async () => {
  const store = S.memStore();
  const h = v1({ store, env: reporterEnv() });
  await call(h, 'presence', S.req('GET', { id: S.COLEAGO, lon: '-0.20729', lat: '51.50255' }));
  const res = await call(h, 'presenceReport', S.req('POST', {}, { id: S.COLEAGO, entity_id: 'gb:06960521' }, { 'x-api-key': REPORTER }));
  assert.equal(res.statusCode, 200);
  assert.equal(store.idx.records[S.COLEAGO].link.report.by, 'reporter-app');
  const anonStore = S.memStore();
  const a = v1({ store: anonStore, env: reporterEnv() });
  await call(a, 'presence', S.req('GET', { id: S.COLEAGO, lon: '-0.20729', lat: '51.50255' }));
  await call(a, 'presenceReport', S.req('POST', {}, { id: S.COLEAGO, entity_id: 'gb:06960521' }));
  assert.equal(anonStore.idx.records[S.COLEAGO].link.report.by, undefined);
});

test('keys: parsing skips bad entries and accepts commas, spaces and new lines', () => {
  const h = 'a'.repeat(64);
  const parsed = keys.parseKeys(`one:${h},two:${h.toUpperCase()}\nbad:xyz  :${h} three:${h}`);
  assert.deepEqual(parsed.map((k) => k.name), ['one', 'two', 'three']);
  assert.equal(keys.keyFrom({ headers: { authorization: 'bearer  abc ' } }), 'abc');
  assert.equal(keys.keyFrom({ headers: { 'x-api-key': ' xyz ' } }), 'xyz');
  assert.equal(keys.keyFrom({ headers: {} }), null);
  assert.equal(keys.callerName({ headers: { authorization: `Bearer ${KEY}` } }, { COMPANY_LOOKUP_API_KEYS: KEYS_ENV }), 'trade-credit-monitor');
  assert.equal(keys.callerName({ headers: { authorization: `Bearer ${KEY}` } }, {}), null);
});

test('keys: the key script prints a key and a matching name:hash line', () => {
  const { execFileSync } = require('child_process');
  const out = execFileSync(process.execPath, [require('path').join(__dirname, '..', 'scripts', 'new-api-key.js'), 'test-app'], { encoding: 'utf8' }).split('\n');
  const key = out[1];
  assert.match(key, /^cl_[A-Za-z0-9_-]{43}$/);
  assert.equal(out[4], `test-app:${keys.sha256(key).toString('hex')}`);
  assert.equal(keys.callerName({ headers: { 'x-api-key': key } }, { COMPANY_LOOKUP_API_KEYS: out[4] }), 'test-app');
});

// ---------- base URL ----------

test('public URL: COMPANY_LOOKUP_PUBLIC_URL wins, else the request host', async () => {
  assert.equal(publicBase({ headers: { host: 'x.test' } }, { COMPANY_LOOKUP_PUBLIC_URL: 'https://companylookup.org/' }), 'https://companylookup.org');
  assert.equal(publicBase({ headers: { host: 'open-company-lookup.vercel.app', 'x-forwarded-proto': 'https' } }, {}), 'https://open-company-lookup.vercel.app');
  assert.equal(publicBase({ headers: { host: 'localhost:3000' } }, {}), 'http://localhost:3000');
  assert.equal(publicBase({ headers: { host: 'bad host/<x>' } }, {}), '');
  const res = await call(v1({ env: { COMPANIES_HOUSE_API_KEY: 'k', COMPANY_LOOKUP_PUBLIC_URL: 'https://companylookup.org' } }), 'presence', S.req('GET', { id: S.COLEAGO, lon: '-0.20729', lat: '51.50255' }));
  assert.equal(res.body.linked_entity.report.url, 'https://companylookup.org/v1/presence-report');
});
