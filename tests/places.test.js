// Offline tests for name search over stored Overture places (phase 3 pilot): run with `node --test tests/places.test.js`.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const places = require('../lib/places');
const index = require('../lib/bulk/index');
const { createHandlers } = require('../lib/handlers');
const S = require('./support/scenarios');

// Lines as scripts/places/extract.sql writes them (shape checked against the 2026-10-21.0 schema).
const LINES = [
  { id: 'e9f7b271-ee77-4e06-afb2-13494e13850c', name: 'Sabiene Rohlwink Heilpraktiker', street: 'Elbchaussee 189G', locality: 'Hamburg', postcode: '22605', region: 'HH', lon: 9.9012, lat: 53.5501, cat: 'physical_therapy', conf: 0.9471, src: ['meta|CDLA-Permissive-2.0'] },
  { id: '4078d539-a66c-4a57-91e1-c52efc3d3b69', name: 'Ahrens Malerbetrieb', street: 'Augustenhöh 1', locality: 'Hamburg', postcode: '22761', region: 'HH', lon: 9.92, lat: 53.56, cat: 'painting', conf: 0.9471, src: ['meta|CDLA-Permissive-2.0', 'Foursquare|Apache-2.0'] },
  { id: '630f29bb-302b-435b-ada1-c4313cba1dca', name: 'Metra Gmbh', street: 'Bahrenfelder Marktplatz 7', locality: 'Hamburg', postcode: '22761', region: 'HH', lon: 9.91, lat: 53.565, cat: 'advertising_agency', conf: 0.5, src: ['BrightQuery|CDLA-Permissive-2.0'] },
  { id: '11111111-2222-3333-4444-555555555555', name: 'Bäckerei Müller', street: null, locality: 'München', postcode: '80331', region: 'BY', lon: 11.575, lat: 48.137, cat: 'bakery', conf: 0.8, src: ['meta|CDLA-Permissive-2.0'] },
];
const BASE = 'https://abc123.public.blob.vercel-storage.com';

// Serves an index built from LINES at BASE/places/de/…, like the Blob store would.
function servedIndex(lines = LINES, { release = '2026-10-21.0' } = {}) {
  const b = index.createBuilder({ sBuckets: 8, only: 's', rowOf: places.rowOf });
  lines.forEach((o) => b.add(places.toRecord(o)));
  const files = {};
  for (const [p, t] of b.files()) files[p] = t;
  const manifest = { country: 'DE', base: `${BASE}/places/de/1`, release, count: b.count, s_buckets: 8, t_layout: 2, split: b.split };
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    if (url === `${BASE}/places/de/manifest.json`) return S.json(200, manifest);
    const m = url.match(/\/places\/de\/1\/(.+)$/);
    if (m && files[m[1]]) return S.json(200, JSON.parse(files[m[1]]));
    return S.json(404, {});
  };
  return { fetchFn, calls, files, manifest };
}

test('rows keep what a place summary needs; summaries are labelled presence data', () => {
  const row = places.rowOf(places.toRecord(LINES[1]));
  assert.equal(row[0], LINES[1].id);
  assert.equal(row[1], 'Ahrens Malerbetrieb');
  assert.deepEqual(row[4][8], [['meta', 'CDLA-Permissive-2.0'], ['Foursquare', 'Apache-2.0']]);
  const s = places.summaryOf({ number: row[0], name: row[1], extra: row[4] }, 'DE', '2026-10-21.0');
  assert.deepEqual(s, {
    id: 'overture:4078d539-a66c-4a57-91e1-c52efc3d3b69', tier: 'presence', label: 'Not an official record', name: 'Ahrens Malerbetrieb',
    address: { street: 'Augustenhöh 1', locality: 'Hamburg', postcode: '22761', region: 'HH', country: 'DE' },
    location: { lon: 9.92, lat: 53.56 }, category: 'painting',
    sources: [{ dataset: 'meta', license: 'CDLA-Permissive-2.0', update_time: null }, { dataset: 'Foursquare', license: 'Apache-2.0', update_time: null }],
    release: '2026-10-21.0',
  });
});

test('search: whole words by prefix, accents ignored, only pilot countries, nothing without an index', async () => {
  index._resetManifests();
  const { fetchFn } = servedIndex();
  let r = await places.search(fetchFn, BASE, 'DE', 'ahrens maler');
  assert.deepEqual(r.map((x) => x.name), ['Ahrens Malerbetrieb']);
  r = await places.search(fetchFn, BASE, 'DE', 'Backerei Muller');
  assert.equal(r[0].name, 'Bäckerei Müller');
  assert.equal(r[0].address.locality, 'München');
  assert.equal(r[0].release, '2026-10-21.0');
  assert.deepEqual(await places.search(fetchFn, BASE, 'GB', 'ahrens'), [], 'not a pilot country');
  assert.deepEqual(await places.search(fetchFn, null, 'DE', 'ahrens'), [], 'no store');
  index._resetManifests();
  assert.deepEqual(await places.search(async () => S.json(404, {}), BASE, 'IT', 'roma'), [], 'not built yet');
});

test('search handler: stored places join the presence list, labelled, after linked places, never as results', async () => {
  index._resetManifests();
  const { fetchFn } = servedIndex();
  const h = createHandlers({ ...S.deps(), placesSearch: (cc, q) => places.search(fetchFn, BASE, cc, q, 10) });
  const res = S.mockRes();
  await h.search(S.req('GET', { q: 'Ahrens Malerbetrieb', country: 'DE' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.presence.length, 1);
  const p = res.body.presence[0];
  assert.equal(p.tier, 'presence');
  assert.equal(p.label, 'Not an official record');
  assert.equal(p.linked_entity, null);
  assert.ok(res.body.results.every((r) => r.tier !== 'presence'));
  // Other countries don't call the place index.
  let called = false;
  const g = createHandlers({ ...S.deps(), placesSearch: async () => { called = true; return []; } });
  await g.search(S.req('GET', { q: 'Example Trading', country: 'GB' }), S.mockRes());
  await g.search(S.req('GET', { q: 'Example Trading' }), S.mockRes());
  assert.equal(called, false);
});

test('search handler: a slow or failing place index never breaks search', async () => {
  const h = createHandlers({ ...S.deps(), placesSearch: async () => { throw new Error('blob down'); } });
  const res = S.mockRes();
  await h.search(S.req('GET', { q: 'Ahrens', country: 'DE' }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.presence, []);
});

test('health lists the place indexes', async () => {
  const h = createHandlers({ ...S.deps(), apiVersion: '1', placesStatus: async () => ({ DE: { release: '2026-10-21.0', count: 4, built_at: '2026-11-16T00:00:00Z' }, IT: null }) });
  const res = S.mockRes();
  await h.health(S.req('GET', {}), res);
  assert.equal(res.body.places.DE.count, 4);
  assert.equal(res.body.places.IT, null);
});

test('packs: round trip, and the build script writes packs and metadata from an extract', () => {
  const files = [['s/1.json', '{"abc":[]}'], ['t/1-2.json', '{}']];
  assert.deepEqual(places.decodePack(places.encodePack(files)), files);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'places-'));
  fs.mkdirSync(path.join(dir, 'extract', 'cc=DE'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'extract', 'cc=DE', 'data_0.json'), LINES.map((l) => JSON.stringify(l)).join('\n') + '\n');
  execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'places', 'build.js'), 'DE', path.join(dir, 'extract'), path.join(dir, 'out'), '2026-10-21.0'], { encoding: 'utf8' });
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'out', 'de-meta.json'), 'utf8'));
  assert.equal(meta.count, 4);
  assert.equal(meta.release, '2026-10-21.0');
  const packed = places.decodePack(fs.readFileSync(path.join(dir, 'out', 'de-0.ndjson.gz')));
  assert.equal(packed.length, meta.files);
  assert.ok(packed.every(([p]) => /^[st]\//.test(p)));
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- import into Blob ----------

function fakeBlob() {
  const store = new Map(); // pathname -> text
  const blobFetch = async (url, init = {}) => {
    const u = new URL(url);
    const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    if (init.method === 'PUT') { const p = u.searchParams.get('pathname'); store.set(p, String(init.body)); return ok({ url: `${BASE}/${p}`, pathname: p }); }
    if (u.pathname.endsWith('/delete')) { for (const x of JSON.parse(init.body).urls) store.delete(x.replace(`${BASE}/`, '')); return ok({}); }
    const prefix = u.searchParams.get('prefix') || '';
    return ok({ blobs: [...store.keys()].filter((k) => k.startsWith(prefix)).map((k) => ({ pathname: k, url: `${BASE}/${k}` })), hasMore: false });
  };
  return { store, blobFetch };
}
const TAG = 'places-2026-10-21.0';
function release(assets) {
  return async (url) => {
    const name = url.startsWith(`https://github.com/larsewallin/company-lookup/releases/download/${TAG}/`) ? url.split('/').pop() : null;
    if (name && assets[name]) return { ok: true, status: 200, arrayBuffer: async () => assets[name] };
    if (url.endsWith('/places/de/manifest.json')) return S.json(404, {});
    return { ok: false, status: 404, arrayBuffer: async () => Buffer.alloc(0), json: async () => ({}) };
  };
}
const ENV = { BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_abc123_secret' };
const post = (query) => ({ method: 'POST', query, headers: {} });

test('import: packs are copied into a new version; finalize switches the manifest and removes old versions', async () => {
  index._resetManifests();
  const files = [['s/1.json', '{"ahr":[]}'], ['s/2.json', '{"mal":[]}'], ['t/1-3.json', '{}']];
  const assets = {
    'de-0.ndjson.gz': places.encodePack(files.slice(0, 2)), 'de-1.ndjson.gz': places.encodePack(files.slice(2)),
    'de-meta.json': Buffer.from(JSON.stringify({ country: 'DE', release: '2026-10-21.0', count: 4, s_buckets: 8, split: [], files: 3, packs: 2 })),
  };
  const { store, blobFetch } = fakeBlob();
  store.set('places/de/202501010/s/1.json', '{}'); // an older version
  const imp = places.createPlacesImport({ fetchFn: release(assets), blobFetch, env: ENV });
  let res = S.mockRes(); await imp(post({ cc: 'DE', tag: TAG, finalize: '1' }), res);
  assert.equal(res.statusCode, 409, 'finalize refuses before every pack is in');
  res = S.mockRes(); await imp(post({ cc: 'DE', tag: TAG, pack: '0' }), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.files, 2);
  res = S.mockRes(); await imp(post({ cc: 'DE', tag: TAG, pack: '1' }), res);
  assert.ok(store.has('places/de/202610210/t/1-3.json'));
  res = S.mockRes(); await imp(post({ cc: 'DE', tag: TAG, finalize: '1' }), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const m = JSON.parse(store.get('places/de/manifest.json'));
  assert.equal(m.base, `${BASE}/places/de/202610210`);
  assert.equal(m.release, '2026-10-21.0');
  assert.equal(m.count, 4);
  assert.ok(!store.has('places/de/202501010/s/1.json'), 'the old version is removed');
});

test('import: refuses bad input, other repos and files outside the index layout', async () => {
  const { blobFetch } = fakeBlob();
  const evil = { 'de-0.ndjson.gz': places.encodePack([['../../bulk/cy/manifest.json', '{}']]) };
  const imp = places.createPlacesImport({ fetchFn: release(evil), blobFetch, env: ENV });
  const cases = [
    [{ method: 'GET', query: {} }, 405],
    [post({ cc: 'GB', tag: TAG, pack: '0' }), 400],
    [post({ cc: 'DE', tag: 'v1.0', pack: '0' }), 400],
    [post({ cc: 'DE', tag: TAG, pack: 'x' }), 400],
    [post({ cc: 'DE', tag: TAG, pack: '7' }), 404],
    [post({ cc: 'DE', tag: TAG, pack: '0' }), 400],
    [post({ cc: 'DE', tag: TAG }), 400],
  ];
  for (const [r, status] of cases) { const res = S.mockRes(); await imp({ headers: {}, ...r }, res); assert.equal(res.statusCode, status, JSON.stringify(r.query)); }
  const noStore = places.createPlacesImport({ fetchFn: release({}), blobFetch, env: {} });
  const res = S.mockRes(); await noStore(post({ cc: 'DE', tag: TAG, pack: '0' }), res);
  assert.equal(res.statusCode, 503);
});
