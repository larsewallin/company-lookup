// Offline tests for presence data (Overture Maps, tier 3): run with `node --test tests/presence.test.js`.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const P = require('../lib/presence');
const { parseId } = require('../lib/overture');
const { createHandlers } = require('../lib/handlers');
const { createMcp } = require('../lib/mcp');

const NOW = new Date('2026-11-15T12:00:00Z');
const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'overture-places.json'), 'utf8')).records;
const byName = (n) => FIX.find((f) => f.row.names.primary === n);
const registerFor = (c) => ({ GB: 'Companies House', FR: 'French business register' }[c] || null);
const cardOf = (n) => { const f = byName(n); return P.presenceCard(f.row, { release: f.release, checkedAt: NOW.toISOString(), registerFor }); };

function mockRes() {
  return { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(t) { this.body = t ? JSON.parse(t) : undefined; } };
}
let ip = 0;
const req = (query, extra = {}) => ({ method: 'GET', query, headers: { 'x-forwarded-for': `10.9.0.${++ip}` }, socket: {}, ...extra });
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

// An in-memory link store with the same interface as lib/presence-store.js.
function memStore(records = {}) {
  const idx = { records };
  return { enabled: true, idx, load: async () => idx, update: async (r, mutate) => { mutate(idx); return true; } };
}
// An Overture reader that serves the fixtures.
const fakeOverture = { latestRelease: async () => '2026-10-21.0', place: async (id) => { const f = FIX.find((x) => x.row.id === id); return f ? { row: f.row, release: f.release } : null; } };

// ---------- normalisation ----------

test('domain normalisation: registrable domain, www and paths ignored, platforms are not company domains', () => {
  assert.equal(P.registrableDomain('http://www.coleago.com/'), 'coleago.com');
  assert.equal(P.registrableDomain('https://shop.acme.co.uk/en/contact?x=1'), 'acme.co.uk');
  assert.equal(P.registrableDomain('HTTPS://WWW.Example.COM.AU:443/'), 'example.com.au');
  assert.equal(P.registrableDomain('westkensingtonremovals.org.uk'), 'westkensingtonremovals.org.uk');
  assert.equal(P.registrableDomain('https://www.westernunion.com/fr/fr/home.html'), 'westernunion.com');
  assert.equal(P.registrableDomain('not a url'), null);
  assert.equal(P.companyDomain('https://www.instagram.com/sonyantoni_?igsh=x'), null);
  assert.equal(P.companyDomain('https://www.facebook.com/426656581019149'), null);
  assert.equal(P.companyDomain('https://api.whatsapp.com/send?phone=1'), null);
  assert.equal(P.companyDomain('https://tataabadi.com/'), 'tataabadi.com');
});

test('name normalisation: case, accents, punctuation and legal suffixes', () => {
  assert.equal(P.normaliseName('Coleago Consulting Ltd'), 'coleago consulting');
  assert.equal(P.normaliseName('COLEAGO CONSULTING LIMITED'), 'coleago consulting');
  assert.equal(P.normaliseName('Materiales De Construcción Sebastián Alvaro S.l.'), 'materiales de construccion sebastian alvaro');
  assert.equal(P.normaliseName('PT Tata Abadi Tbk'), 'tata abadi');
  assert.equal(P.normaliseName('Siemens Aktiengesellschaft'), 'siemens');
  assert.equal(P.normaliseName('Müller GmbH & Co. KG'), 'muller');
  assert.ok(P.similarNames('Coleago Consulting Ltd', 'COLEAGO CONSULTING LIMITED'));
  assert.ok(P.similarNames('Tata Abadi Billboard', 'PT Tata Abadi Billboard Indonesia'));
  assert.ok(!P.similarNames('Western Union', 'Western Union Payment Services Ireland Limited Europe Branch'));
  assert.ok(!P.similarNames('ubitricity', 'Shell UK Limited'));
});

test('parseId accepts bare and prefixed GERS IDs only', () => {
  assert.equal(parseId('6F8BCE4F-A274-4494-9F2C-DD051BCA0BB4'), '6f8bce4f-a274-4494-9f2c-dd051bca0bb4');
  assert.equal(parseId('overture:6f8bce4f-a274-4494-9f2c-dd051bca0bb4'), '6f8bce4f-a274-4494-9f2c-dd051bca0bb4');
  assert.equal(parseId('gb:00445790'), null);
  assert.equal(parseId(''), null);
});

// ---------- match levels ----------

const coleagoCH = { id: 'gb:06960521', name: 'COLEAGO CONSULTING LIMITED', country: 'GB', website: 'coleago.com', address: '77 Abbotsbury Road, London, W14 8EP', register: 'Companies House', number: '06960521' };

test('strong match: same registrable domain and similar name in the same country', () => {
  const m = P.classify(cardOf('Coleago Consulting Ltd'), coleagoCH);
  assert.equal(m.level, 'strong');
  assert.deepEqual(m.evidence.domain, 'coleago.com');
});

test('probable match: similar name and same postcode, no domain evidence', () => {
  const m = P.classify(cardOf('Coleago Consulting Ltd'), { ...coleagoCH, website: null });
  assert.equal(m.level, 'probable');
  assert.equal(m.evidence.postcode, 'W14 8EP');
});

test('probable, not strong: same domain with a very different name', () => {
  const m = P.classify(cardOf('Coleago Consulting Ltd'), { ...coleagoCH, name: 'Abbotsbury Holdings Two Limited' });
  assert.equal(m.level, 'probable');
  assert.equal(m.evidence.domain, 'coleago.com');
});

test('no match: same name in a different country', () => {
  assert.equal(P.classify(cardOf('Coleago Consulting Ltd'), { ...coleagoCH, country: 'IE' }).level, 'none');
});

test('no match: brand only (outlets of one brand are often separate legal entities)', () => {
  const card = cardOf('ubitricity');
  assert.equal(card.brand.name, 'ubitricity');
  // An entity that shares only the brand: different name, no website match, different address.
  const ent = { id: 'gb:12345678', name: 'Shell EV Charging Solutions UK Limited', country: 'GB', website: 'shell.co.uk', address: '1 Main Street, London, EC1A 1AA', register: 'Companies House' };
  assert.equal(P.classify(card, ent).level, 'none');
  // Even an entity named after the brand needs domain or address evidence.
  assert.equal(P.classify(card, { ...ent, name: 'Ubitricity Limited' }).level, 'none');
});

test('no match: a social or platform URL is never domain evidence', () => {
  const card = cardOf('Bison Motor');
  assert.equal(P.classify(card, { id: 'x', name: 'Instagram Indonesia', country: 'ID', website: 'instagram.com' }).level, 'none');
});

test('two different strong candidates are ambiguous: both shown as probable, none linked', () => {
  const card = cardOf('Coleago Consulting Ltd');
  const best = P.bestMatch(card, [coleagoCH, { ...coleagoCH, id: 'gb:99999999', number: '99999999' }]);
  assert.equal(best.strong, null);
  assert.equal(best.probable.length, 2);
});

// ---------- the fixture set ----------

test('fixtures: about 10 real records in at least 3 countries, one without a register', () => {
  const countries = new Set(FIX.map((f) => f.row.addresses[0].country));
  assert.ok(FIX.length >= 10);
  assert.ok(countries.size >= 3);
  assert.ok([...countries].some((c) => !registerFor(c)));
});

test('fixtures: every card has the tier, notice, sources with licences and the release; no verdict, flags or status', () => {
  for (const f of FIX) {
    const c = P.presenceCard(f.row, { release: f.release, checkedAt: NOW.toISOString(), registerFor });
    assert.equal(c.tier, 'presence');
    assert.equal(c.notice, 'Presence data from Overture Maps. Not an official record and not a legal identifier.');
    assert.equal(c.release, '2026-10-21.0');
    assert.equal(c.checked_at, NOW.toISOString());
    assert.ok(c.sources.length >= 1);
    for (const s of c.sources) { assert.ok(s.dataset); assert.ok(s.license, `${f.row.id} ${s.dataset} licence`); assert.ok(s.update_time); }
    assert.match(c.attribution, /^© Overture Maps Foundation\. Sources: /);
    assert.equal(c.linked_entity, null);
    for (const k of ['verdict', 'flags', 'status']) assert.ok(!(k in c), k);
    assert.equal(c.id, f.row.id);
    assert.equal(c.name, f.row.names.primary);
    assert.equal(c.address.country, f.row.addresses[0].country);
    assert.ok(c.location.lon >= -180 && c.location.lat <= 90);
    // Optional fields only where present.
    assert.equal('websites' in c, !!(f.row.websites && f.row.websites.length));
    assert.equal('socials' in c, !!(f.row.socials && f.row.socials.length));
    assert.equal('brand' in c, !!(f.row.brand && f.row.brand.names && f.row.brand.names.primary));
  }
});

test('fixtures: specific cards are correct', () => {
  const c = cardOf('Coleago Consulting Ltd');
  assert.deepEqual(c.address, { street: '77 ABBOTSBURY ROAD', locality: 'LONDON', postcode: 'W14 8EP', region: 'WSM', country: 'GB' });
  assert.deepEqual(c.location, { lon: -0.207295, lat: 51.502556 });
  assert.deepEqual(c.websites, ['http://www.coleago.com/']);
  assert.equal(c.categories.primary, 'business_consulting');
  assert.equal(c.confidence, 0.5);
  assert.deepEqual(c.sources.map((s) => [s.dataset, s.license]), [['BrightQuery', 'CDLA-Permissive-2.0'], ['Overture', 'CDLA-Permissive-2.0']]);
  assert.deepEqual(c.official_register, { label: 'Search the official register', register: 'Companies House', tool: 'search_companies', arguments: { query: 'Coleago Consulting Ltd', country: 'GB' } });
  assert.equal(cardOf('Filles du Sud').sources[0].license, 'Apache-2.0'); // Foursquare
  assert.equal(cardOf('ubitricity').sources[0].license, 'CC0-1.0'); // AllThePlaces
  assert.match(cardOf('ubitricity').attribution, /AllThePlaces \(CC0-1\.0\)/);
  assert.equal(cardOf('3W Academy').official_register.register, 'French business register');
  assert.equal(cardOf('Tata Abadi Billboard').official_register, null); // Indonesia: no register connected
  assert.equal(cardOf('Materiales De Construcción Sebastián Alvaro S.l.').official_register, null); // Spain
});

test('fixtures: the strong match links and the brand-only case stays separate', () => {
  const best = P.bestMatch(cardOf('Coleago Consulting Ltd'), [coleagoCH]);
  assert.equal(best.strong.entity.id, 'gb:06960521');
  const brand = P.bestMatch(cardOf('ubitricity'), [{ id: 'gb:1', name: 'Ubitricity Limited', country: 'GB', website: 'ubitricity.com', address: 'Somewhere, EC1A 1AA' }]);
  assert.equal(brand.strong, null);
  assert.equal(brand.probable.length, 0);
});

// ---------- HTTP handler, linking, search and reports ----------

function handlers(store, candidates) {
  return createHandlers({ fetchFn: async () => json(404, {}), env: { COMPANIES_HOUSE_API_KEY: 'k' }, now: () => NOW, overture: fakeOverture, store, presenceCandidates: candidates });
}

test('presence handler: card, strong link stored and shown at the top, report holds it out', async () => {
  const store = memStore();
  const h = handlers(store, async () => [{ ...coleagoCH, ids: ['gb:06960521', 'lei:213800AAAAAAAAAAAA12'] }]);
  let res = mockRes();
  await h.presence(req({ id: 'overture:6f8bce4f-a274-4494-9f2c-dd051bca0bb4', lon: '-0.20729', lat: '51.50255' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.tier, 'presence');
  assert.equal(res.body.linked_entity.id, 'gb:06960521');
  assert.equal(res.body.linked_entity.text, 'This place is linked to COLEAGO CONSULTING LIMITED (Companies House, 06960521).');
  assert.deepEqual(res.body.linked_entity.report.body, { id: '6f8bce4f-a274-4494-9f2c-dd051bca0bb4', entity_id: 'gb:06960521' });
  const rec = store.idx.records['6f8bce4f-a274-4494-9f2c-dd051bca0bb4'];
  assert.equal(rec.link.level, 'strong');
  assert.deepEqual(rec.link.evidence.domain, 'coleago.com');
  assert.equal(rec.link.date, '2026-11-15');

  // Search: the linked place appears under its entity, not separately.
  const s = createHandlers({ fetchFn: async (url) => (url.includes('company-information') && url.includes('search') ? json(200, { items: [{ company_number: '06960521', title: 'COLEAGO CONSULTING LIMITED', company_status: 'active', address_snippet: '77 Abbotsbury Road, London, W14 8EP' }] }) : json(200, { data: [] })), env: { COMPANIES_HOUSE_API_KEY: 'k' }, now: () => NOW, store });
  res = mockRes(); await s.search(req({ q: 'coleago consulting', country: 'GB' }), res);
  assert.equal(res.statusCode, 200);
  const ent = res.body.results.find((r) => r.id === 'gb:06960521');
  assert.ok(ent, JSON.stringify(res.body));
  assert.equal(ent.locations.length, 1);
  assert.equal(ent.locations[0].id, 'overture:6f8bce4f-a274-4494-9f2c-dd051bca0bb4');
  assert.equal(ent.locations[0].label, 'Not an official record');
  assert.deepEqual(res.body.presence, []);

  // Report the link: it is held out until reviewed.
  res = mockRes();
  await h.presenceReport({ method: 'POST', body: JSON.stringify({ id: '6f8bce4f-a274-4494-9f2c-dd051bca0bb4', entity_id: 'gb:06960521', reason: 'different company' }), headers: {}, socket: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(rec.link.status, 'reported');
  res = mockRes(); await h.presence(req({ id: '6f8bce4f-a274-4494-9f2c-dd051bca0bb4' }), res);
  assert.equal(res.body.linked_entity, null);
  assert.match(res.body.link_note, /reported as wrong/);
  res = mockRes(); await s.search(req({ q: 'coleago consulting', country: 'GB' }), res);
  assert.equal(res.body.results.find((r) => r.id === 'gb:06960521').locations, undefined);
  assert.equal(res.body.presence.length, 1); // now listed on its own, after legal entities
  assert.equal(res.body.presence[0].linked_entity, null);
});

test('presence handler: probable matches are shown, never merged; brand-only stays standalone', async () => {
  const store = memStore();
  const h = handlers(store, async (card) => (card.name === 'ubitricity'
    ? [{ id: 'gb:1', name: 'Ubitricity Limited', country: 'GB', website: null, address: 'Elsewhere, EC1A 1AA', register: 'Companies House', number: '1', ids: ['gb:1'] }]
    : [{ ...coleagoCH, website: null, ids: ['gb:06960521'] }]));
  let res = mockRes(); await h.presence(req({ id: '6f8bce4f-a274-4494-9f2c-dd051bca0bb4' }), res);
  assert.equal(res.body.linked_entity, null);
  assert.equal(res.body.possible_matches.length, 1);
  assert.match(res.body.possible_matches[0].text, /^Possibly the same as COLEAGO CONSULTING LIMITED/);
  res = mockRes(); await h.presence(req({ id: '9581fb61-2d2c-4bb1-a94f-590fef09a5d5' }), res);
  assert.equal(res.body.linked_entity, null);
  assert.deepEqual(res.body.possible_matches, []);
});

test('presence handler: bad id, bad point, unknown place, and get_company_card refuses presence ids', async () => {
  const h = handlers(memStore(), async () => []);
  let res = mockRes(); await h.presence(req({ id: 'gb:123' }), res); assert.equal(res.statusCode, 400);
  res = mockRes(); await h.presence(req({ id: '6f8bce4f-a274-4494-9f2c-dd051bca0bb4', lon: '500', lat: '1' }), res); assert.equal(res.statusCode, 400);
  res = mockRes(); await h.presence(req({ id: '00000000-0000-4000-8000-000000000000' }), res);
  assert.equal(res.statusCode, 404); assert.equal(res.body.tier, 'presence'); assert.ok(res.body.notice);
  res = mockRes(); await h.company(req({ id: 'overture:6f8bce4f-a274-4494-9f2c-dd051bca0bb4' }), res);
  assert.equal(res.statusCode, 400); assert.match(res.body.error, /get_presence_card/);
});

test('presence handler: Overture unreachable gives a 502 with a reason', async () => {
  const h = createHandlers({ env: {}, now: () => NOW, overture: { latestRelease: async () => { const e = new Error('x'); e.status = 503; throw e; } }, store: memStore() });
  const res = mockRes(); await h.presence(req({ id: '6f8bce4f-a274-4494-9f2c-dd051bca0bb4' }), res);
  assert.equal(res.statusCode, 502); assert.match(res.body.error, /HTTP 503/);
});

test('MCP: get_presence_card returns the presence card', async () => {
  const mcp = createMcp({ env: {}, now: () => NOW, overture: fakeOverture, store: memStore(), presenceCandidates: async () => [] });
  const res = mockRes();
  await mcp.handler({ method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_presence_card', arguments: { id: 'edc9a0e9-948b-4cf9-9c85-12056611bac0', lon: 106.72269, lat: -6.21583 } } }, headers: {}, socket: {} }, res);
  const r = res.body.result;
  assert.equal(r.isError, undefined);
  assert.equal(r.structuredContent.tier, 'presence');
  assert.equal(r.structuredContent.name, 'Tata Abadi Billboard');
  assert.equal(r.structuredContent.official_register, null);
});
