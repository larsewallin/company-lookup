'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { rows } = require('../lib/bulk/csv');
const cy = require('../lib/bulk/cy');

async function* from(s, size = 7) { for (let i = 0; i < s.length; i += size) yield s.slice(i, i + size); }
const all = async (g) => { const out = []; for await (const x of g) out.push(x); return out; };

test('CSV parser: quotes, doubled quotes, newlines in quotes, CRLF, any chunk boundary', async () => {
  const text = 'a,b,c\r\n"x, y","he said ""hi""","line1\nline2"\r\n1,,3\r\n';
  for (const size of [1, 2, 3, 5, 7, 11, 100]) {
    const got = await all(rows(from(text, size)));
    assert.deepEqual(got, [['a', 'b', 'c'], ['x, y', 'he said "hi"', 'line1\nline2'], ['1', '', '3']], `chunk size ${size}`);
  }
});

test('Cyprus bulk: companies with address and officers; business names excluded; Greek statuses mapped', async () => {
  const org = 'ORGANISATION_NAME,REGISTRATION_NO,ORGANISATION_TYPE_CODE,ORGANISATION_TYPE,ORGANISATION_SUB_TYPE,NAME_STATUS_CODE,NAME_STATUS,REGISTRATION_DATE,ORGANISATION_STATUS,ORGANISATION_STATUS_DATE,ADDRESS_SEQ_NO\r\n'
    + 'EXAMPLE TRADING LIMITED,123456,C,Εταιρεία,Ιδιωτική,ACR,Τελευταίο Όνομα,01/02/2015,Εγγεγραμμένη,01/02/2015,24\r\n'
    + 'OLD CO LIMITED,1000,C,Εταιρεία,Ιδιωτική,ACR,Τελευταίο Όνομα,01/02/1990,Δημοσιεύτηκε η Τρίμηνη,01/09/2026,\r\n'
    + 'CYPRUS MINES CORPORATION,1,O,Αλλοδαπή Εταιρεία,,ACR,Τελευταίο Όνομα,20/06/1923,Διαγραμμένη,16/08/1974,\r\n'
    + 'JOHN SMITH TRADING,77,B,Εμπορική Επωνυμία,,ACR,Τελευταίο Όνομα,01/01/2000,Εγγεγραμμένη,01/01/2000,\r\n';
  const ro = 'ADDRESS_SEQ_NO,STREET,BUILDING,TERRITORY\r\n24,"Δάμωνος, ","KARMAZI, Flat 51, ","Μέσα Γειτονιά, Λεμεσός, Κύπρος"\r\n';
  const off = 'ORGANISATION_NAME,REGISTRATION_NO,ORGANISATION_TYPE_CODE,ORGANISATION_TYPE,PERSON_OR_ORGANISATION_NAME,OFFICIAL_POSITION\r\nEXAMPLE TRADING LIMITED,123456,C,Εταιρεία,A DIRECTOR,Διευθυντής\r\n';
  const got = await cy.build({ organisations: from(org, 50), offices: from(ro, 50), officials: from(off, 50) });
  assert.deepEqual(got.map((o) => [o.number, o.status, o.flag]), [['HE123456', 'active', null], ['HE1000', 'active', 'stop'], ['AE1', 'inactive', null]]);
  assert.equal(got[0].registered_address, 'Δάμωνος, KARMAZI, Flat 51, Μέσα Γειτονιά, Λεμεσός, Κύπρος');
  assert.equal(got[0].legal_form, 'Company, private');
  assert.equal(got[0].incorporated, '2015-02-01');
  assert.deepEqual(got[0].officers, [{ name: 'A DIRECTOR', role: 'Director' }]);
  assert.equal(got[1].status_label, 'Three-month strike-off notice published');
});

// ---- Blob index and import job, against an in-memory fake of the Blob API and data.gov.cy ----
const index = require('../lib/bulk/index');
const { createImport } = require('../api/bulk-import');
const TOKEN = 'vercel_blob_rw_AbCdStore1_secret';
const PUBLIC = 'https://abcdstore1.public.blob.vercel-storage.com';

function fakeBlob(extraRoutes = {}) {
  const store = new Map(); // pathname -> { body, uploadedAt }
  let clock = Date.parse('2026-11-08T12:00:00Z');
  const fetchFn = async (url, init = {}) => {
    const u = new URL(url);
    const ok = (obj) => ({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) });
    if (u.host === 'vercel.com' && u.pathname === '/api/blob/' && init.method === 'PUT') {
      assert.equal(init.headers.authorization, `Bearer ${TOKEN}`);
      const p = u.searchParams.get('pathname'); store.set(p, { body: init.body, uploadedAt: new Date(clock).toISOString() });
      return ok({ url: `${PUBLIC}/${p}`, pathname: p });
    }
    if (u.host === 'vercel.com' && u.pathname === '/api/blob' && !init.method) {
      const pre = u.searchParams.get('prefix');
      return ok({ blobs: [...store].filter(([p]) => p.startsWith(pre)).map(([p, v]) => ({ pathname: p, url: `${PUBLIC}/${p}`, uploadedAt: v.uploadedAt })), hasMore: false });
    }
    if (u.host === 'vercel.com' && u.pathname === '/api/blob/delete') {
      JSON.parse(init.body).urls.forEach((x) => store.delete(new URL(x).pathname.slice(1))); return ok({});
    }
    if (u.origin === PUBLIC) {
      const v = store.get(u.pathname.slice(1));
      return v ? { ok: true, status: 200, json: async () => JSON.parse(v.body), text: async () => v.body } : { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    }
    for (const [k, v] of Object.entries(extraRoutes)) if (url.includes(k)) return v();
    throw new Error('unexpected fetch ' + url);
  };
  return { store, fetchFn, tick: (ms) => { clock += ms; }, now: () => clock };
}
const csvRes = (text) => () => ({ ok: true, status: 200, body: (async function* () { const b = Buffer.from(text, 'utf8'); for (let i = 0; i < b.length; i += 13) yield b.subarray(i, i + 13); })(), text: async () => text });
const mres = () => ({ statusCode: 200, headers: {}, body: null, setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = JSON.parse(b); } });

const ORG = 'ORGANISATION_NAME,REGISTRATION_NO,ORGANISATION_TYPE_CODE,ORGANISATION_TYPE,ORGANISATION_SUB_TYPE,NAME_STATUS_CODE,NAME_STATUS,REGISTRATION_DATE,ORGANISATION_STATUS,ORGANISATION_STATUS_DATE,ADDRESS_SEQ_NO\r\n'
  + 'BANK OF CYPRUS PUBLIC COMPANY LIMITED,165,C,Εταιρεία,Δημόσια,ACR,Τελευταίο Όνομα,11/10/1943,Εγγεγραμμένη,11/10/1943,24\r\n'
  + 'ΚΥΠΡΙΑΚΗ ΤΡΑΠΕΖΑ ΛΙΜΙΤΕΔ,200,C,Εταιρεία,Ιδιωτική,ACR,Τελευταίο Όνομα,01/01/2001,Δημοσιεύτηκε η Τρίμηνη,01/09/2026,\r\n'
  + 'CYPRUS BANKING SERVICES LTD,300,C,Εταιρεία,Ιδιωτική,ACR,Τελευταίο Όνομα,01/01/2010,Διαγραμμένη,01/01/2020,\r\n';
const RO = 'ADDRESS_SEQ_NO,STREET,BUILDING,TERRITORY\r\n24,"Στασίνου 51, ",,"Λευκωσία, Κύπρος"\r\n';
const OFF = 'ORGANISATION_NAME,REGISTRATION_NO,ORGANISATION_TYPE_CODE,ORGANISATION_TYPE,PERSON_OR_ORGANISATION_NAME,OFFICIAL_POSITION\r\nBANK OF CYPRUS PUBLIC COMPANY LIMITED,165,C,Εταιρεία,A DIRECTOR,Διευθυντής\r\n';
const PAGE = '<a href="/sites/default/files/registered_office_102.csv">x</a><a href="/sites/default/files/organisation_officials_89.csv">x</a><a href="https://www.data.gov.cy/sites/default/files/organisations_103.csv">x</a>';
const cyRoutes = () => ({ 'dataset/1026': () => ({ ok: true, status: 200, text: async () => PAGE }), 'organisations_103.csv': csvRes(ORG), 'registered_office_102.csv': csvRes(RO), 'organisation_officials_89.csv': csvRes(OFF) });

test('Bulk import: builds the Cyprus index in Blob, then refuses to rerun within 20 days', async () => {
  const b = fakeBlob(cyRoutes());
  const run = async () => { const res = mres(); await createImport({ fetchFn: b.fetchFn, blobFetch: b.fetchFn, env: { BLOB_READ_WRITE_TOKEN: TOKEN }, now: b.now })({ query: { country: 'cy' } }, res); return res; };
  let res = await run();
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.count, 3);
  assert.equal(res.body.active, 2);
  assert.ok(b.store.has('bulk/cy/manifest.json'));
  assert.ok(!b.store.has('bulk/cy/lock.json'), 'lock removed');
  const v1 = res.body.version;
  res = await run();
  assert.equal(res.body.skipped, true);
  // 21 days later it rebuilds and removes the old version.
  b.tick(21 * 86400000);
  res = await run();
  assert.equal(res.body.ok, true);
  assert.notEqual(res.body.version, v1);
  assert.ok(![...b.store.keys()].some((p) => p.includes(`/${v1}/`)), 'old version deleted');
  // Without a token it does nothing.
  const r2 = mres(); await createImport({ fetchFn: b.fetchFn, blobFetch: b.fetchFn, env: {}, now: b.now })({ query: { country: 'CY' } }, r2);
  assert.equal(r2.statusCode, 503);
});

test('Bulk import: a much smaller file does not replace a good index', async () => {
  const b = fakeBlob(cyRoutes());
  await createImport({ fetchFn: b.fetchFn, blobFetch: b.fetchFn, env: { BLOB_READ_WRITE_TOKEN: TOKEN }, now: b.now })({ query: { country: 'CY' } }, mres());
  b.tick(21 * 86400000);
  const small = { ...cyRoutes(), 'organisations_103.csv': csvRes(ORG.split('\r\n').slice(0, 2).join('\r\n') + '\r\n') };
  const b2fetch = async (u, i) => { for (const [k, v] of Object.entries(small)) if (u.includes(k)) return v(); return b.fetchFn(u, i); };
  const res = mres(); await createImport({ fetchFn: b2fetch, blobFetch: b.fetchFn, env: { BLOB_READ_WRITE_TOKEN: TOKEN }, now: b.now })({ query: { country: 'CY' } }, res);
  assert.equal(res.statusCode, 500);
  assert.match(res.body.error, /keeping the old one/);
  assert.ok(!b.store.has('bulk/cy/lock.json'));
});

test('Cyprus register: word-prefix search and card from the Blob index', async () => {
  const b = fakeBlob(cyRoutes());
  await createImport({ fetchFn: b.fetchFn, blobFetch: b.fetchFn, env: { BLOB_READ_WRITE_TOKEN: TOKEN }, now: b.now })({ query: { country: 'CY' } }, mres());
  index._resetManifests();
  const cyReg = require('../lib/registers/cy').make({ BLOB_READ_WRITE_TOKEN: TOKEN });
  assert.deepEqual((await cyReg.search(b.fetchFn, 'bank cyp')).map((r) => r.number), ['HE165', 'HE300']);
  assert.deepEqual((await cyReg.search(b.fetchFn, 'bank of cyprus public')).map((r) => r.number), ['HE165', 'HE300']);
  assert.deepEqual((await cyReg.search(b.fetchFn, 'cyprus')).map((r) => [r.number, r.status]), [['HE165', 'active'], ['HE300', 'inactive']]);
  assert.deepEqual((await cyReg.search(b.fetchFn, 'κυπριακη')).map((r) => r.number), ['HE200']);
  assert.deepEqual((await cyReg.search(b.fetchFn, 'ΗΕ 165')).map((r) => r.number), ['HE165']);
  const card = await cyReg.get(b.fetchFn, 'HE165');
  assert.equal(card.legal_name, 'BANK OF CYPRUS PUBLIC COMPANY LIMITED');
  assert.equal(card.registered_address, 'Στασίνου 51, Λευκωσία, Κύπρος');
  assert.equal(card.legal_form, 'Company, public');
  assert.deepEqual(card.register.gleif_as, ['ΗΕ 165', 'HE165']);
  const flagged = await cyReg.get(b.fetchFn, '200');
  assert.equal(flagged.situations[0].level, 'stop');
  // No token: no results, no errors.
  assert.deepEqual(await require('../lib/registers/cy').make({}).search(b.fetchFn, 'bank'), []);
});

test('Blob uploads retry dropped streams and 5xx, but not 4xx', async () => {
  const blob = require('../lib/blob');
  let n = 0;
  const flaky = async () => { n++; if (n === 1) { const e = new Error('fetch failed'); e.cause = { code: 'ERR_HTTP2_STREAM_ERROR' }; throw e; } if (n === 2) return { ok: false, status: 503 }; return { ok: true, status: 200, json: async () => ({ url: 'u' }) }; };
  const t0 = Date.now();
  assert.deepEqual(await blob.put(flaky, TOKEN, 'x.json', '{}'), { url: 'u' });
  assert.equal(n, 3);
  assert.ok(Date.now() - t0 < 5000);
  await assert.rejects(blob.put(async () => ({ ok: false, status: 403 }), TOKEN, 'x.json', '{}'), /HTTP 403/);
});

const CA_HEAD = '﻿Corporation number,Business number (BN),Corporate name - form 1,Corporate name - form 2,Governing legislation,Status,Status Detail,Anniversary date,Year of last annual filing,Date of last annual meeting,Street,Street 2,City/town,Province/territory,Country,Postal code,Minimum number of directors,Maximum number of directors\n';
const CA_ACTIVE = CA_HEAD
  + '8075930,837890706,Gestion FNX Inc.,FNX Management Inc.,Canada Business Corporations Act,Active,,2012-01-09,2026,2026-01-09,378 Boileau,,Saint-Eustache,QC,CA,J7R 4R7,1,5\n'
  + '8284083,801423500,Superior HVAC Inc.,,Canada Business Corporations Act,Active,Active - Dissolution Pending (non-compliance),2012-09-01,2024,2024-10-21,6 DeSantis Crt.,,Hamilton,ON,CA,L8W 3A9,1,1\n'
  + '821624,106665656,90824 CANADA LTD.,,Canada Business Corporations Act,Active,,1979-02-26,2023,2023-02-10,"100, THE EAST MALL",UNIT 11,TORONTO,ON,CA,M8Z 5X2,1,15\n';
const CA_INACTIVE = CA_HEAD + '8593094,846556835,Stellar Point Productions Inc.,,Canada Business Corporations Act,Dissolved,Dissolved by the corporation,2013-07-29,,,5 Carlow Court,,Whitby,ON,CA,L1N 9T7,1,10\n';

test('Canada bulk: streaming import of the federal files; dissolution pending is Stop; old filings are Check', async () => {
  const routes = { 'corporations-active-cbca-en.csv': csvRes(CA_ACTIVE), 'corporations-active-non-cbca-en.csv': csvRes(CA_HEAD), 'corporations-inactive-or-dissolved-cbca-en.csv': csvRes(CA_INACTIVE), 'corporations-inactive-or-dissolved-non-cbca-en.csv': csvRes(CA_HEAD) };
  const b = fakeBlob(routes);
  const res = mres(); await createImport({ fetchFn: b.fetchFn, blobFetch: b.fetchFn, env: { BLOB_READ_WRITE_TOKEN: TOKEN }, now: b.now })({ query: { country: 'CA' } }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.count, 4);
  assert.equal(res.body.active, 3);
  assert.equal(res.body.s_buckets, 1024);
  index._resetManifests();
  const caReg = require('../lib/registers/ca').make({ BLOB_READ_WRITE_TOKEN: TOKEN });
  assert.deepEqual((await caReg.search(b.fetchFn, 'gestion fnx')).map((r) => r.number), ['8075930']);
  assert.deepEqual((await caReg.search(b.fetchFn, '807593-0')).map((r) => r.name), ['Gestion FNX Inc.']);
  let card = await caReg.get(b.fetchFn, '8075930', { asOfIso: '2026-11-08' });
  assert.deepEqual(card.other_names, ['FNX Management Inc.']);
  assert.equal(card.registered_address, '378 Boileau, Saint-Eustache, QC, J7R 4R7');
  assert.deepEqual(card.situations, []);
  card = await caReg.get(b.fetchFn, '8284083', { asOfIso: '2026-11-08' });
  assert.equal(card.situations[0].level, 'stop');
  assert.equal(card.situations[0].label, 'Dissolution pending (non-compliance)');
  card = await caReg.get(b.fetchFn, '821624', { asOfIso: '2026-11-08' });
  assert.equal(card.situations[0].label, 'Annual return overdue');
  card = await caReg.get(b.fetchFn, '8593094', { asOfIso: '2026-11-08' });
  assert.equal(card.status, 'inactive');
});

test('Index: a crowded word prefix is split into longer prefixes, so rarer words stay findable', async () => {
  const b = index.createBuilder({ sBuckets: 8 });
  for (let i = 0; i < 15001; i++) b.add({ number: String(100000 + i), name: `Maple Mansion ${i}`, status: 'active' });
  b.add({ number: '999999', name: 'Manulife Financial', status: 'active' });
  b.add({ number: '999998', name: 'Maple Zebra Trading', status: 'active' });
  const files = {}; for (const [p, t] of b.files()) files[p] = t;
  assert.deepEqual(b.split, ['man', 'mans', 'mansi', 'map', 'mapl', 'maple']);
  assert.ok(Object.keys(files).some((p) => p.startsWith('t/')));
  assert.ok(Math.max(...Object.values(files).map((t) => t.length)) < 2e6);
  const store = Object.fromEntries(Object.entries(files).map(([p, t]) => [`https://x.test/v/${p}`, t]));
  store['https://x.test/bulk/zz/manifest.json'] = JSON.stringify({ base: 'https://x.test/v', s_buckets: 8, t_layout: 2, split: b.split });
  const f = async (u) => (store[u] ? { ok: true, status: 200, json: async () => JSON.parse(store[u]), text: async () => store[u] } : { ok: false, status: 404, json: async () => ({}), text: async () => '' });
  index._resetManifests();
  assert.deepEqual((await index.search(f, 'https://x.test', 'ZZ', 'manulife')).map((r) => r.number), ['999999']);
  assert.deepEqual((await index.search(f, 'https://x.test', 'ZZ', 'manu fin')).map((r) => r.number), ['999999']);
  assert.deepEqual((await index.search(f, 'https://x.test', 'ZZ', 'maple zebra')).map((r) => r.number), ['999998']);
  assert.equal((await index.search(f, 'https://x.test', 'ZZ', 'mansion 1234')).length >= 1, true);
});

test('Coverage: counts come from each source; total is summed in code; a failing source is not counted', async () => {
  const { coverage, SOURCES, PUBLISHED } = require('../lib/coverage');
  const counts = { 'data.gov.au': 3000000, 'opendata.cro.ie': 900000, 'data.gov.il': 600000, 'data.gov.lv': 450000, 'data.gov.sg': 20000 };
  const f = async (url) => {
    const ok = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });
    for (const [host, n] of Object.entries(counts)) if (url.includes(host)) return ok({ success: true, result: { total: n, records: [] } });
    if (url.includes('datos.gov.co')) return ok([{ n: '2483554' }]);
    if (url.includes('data.texas.gov')) return { ok: false, status: 503, json: async () => ({}), text: async () => '' };
    if (url.includes('data.pa.gov') || url.includes('data.oregon.gov') || url.includes('data.ny.gov') || url.includes('data.colorado.gov') || url.includes('data.ct.gov')) return ok([{ n: '100' }]);
    if (url.includes('brreg')) return ok({ page: { totalElements: 1200000 } });
    if (url.includes('/bulk/ca/manifest.json')) return ok({ count: 1578206 });
    if (url.includes('/bulk/cy/manifest.json')) return ok({ count: 502581 });
    if (url.includes('/bulk/qc/manifest.json')) return ok({ count: 1000000 });
    if (url.includes('/bulk/ar/manifest.json')) return ok({ count: 700000 });
    if (url.includes('/bulk/si/manifest.json')) return ok({ count: 150000 });
    if (url.includes('/bulk/cl/manifest.json')) return ok({ count: 1200000 });
    if (url.includes('/bulk/pe/manifest.json')) return ok({ count: 900000 });
    if (url.includes('/bulk/ua/manifest.json')) return ok({ count: 1100000 });
    if (url.includes('api.gleif.org')) return ok({ meta: { pagination: { total: 2900000 } } });
    if (url.includes('data.gouv.nc')) return ok({ total_count: 40000, results: [] });
    throw new Error('unexpected ' + url);
  };
  const c = await coverage(f, { BLOB_READ_WRITE_TOKEN: TOKEN });
  const tx = c.sources.find((s) => s.name === 'Texas Comptroller');
  assert.equal(tx.count, null);
  const counted = 3000000 + 1578206 + 1000000 + 700000 + 150000 + 1200000 + 900000 + 1100000 + 2483554 + 502581 + 900000 + 600000 + 450000 + 1200000 + 27 * 20000 + 5 * 100 + 40000;
  const published = PUBLISHED.reduce((a, p) => a + p[3].reduce((x, y) => x + y, 0), 0);
  assert.equal(c.total_counted, counted);
  assert.equal(c.total_published, published);
  assert.equal(c.total, counted + published);
  assert.equal(c.sources.length, SOURCES.length + PUBLISHED.length);
  assert.equal(c.sources.find((s) => s.country === 'FI').count, 728137 - 275702);
  assert.equal(c.sources.find((s) => s.country === 'FR').basis, 'published');
  assert.equal(c.gleif_lei_records, 2900000);
  assert.equal(c.countries_counted, 16 + PUBLISHED.length);
});

test('ZIP over HTTP: lists entries from the tail and streams one entry by range', async () => {
  const zip = require('../lib/bulk/zip');
  const file = require('fs').readFileSync(require('path').join(__dirname, 'fixtures/sample.zip'));
  const f = async (url, init = {}) => {
    const m = /bytes=(\d+)-(\d+)/.exec((init.headers || {}).Range || '');
    const a = m ? Number(m[1]) : 0; const b = m ? Math.min(Number(m[2]), file.length - 1) : file.length - 1;
    const part = file.subarray(a, b + 1);
    return { ok: true, status: m ? 206 : 200, headers: { get: (k) => (k.toLowerCase() === 'content-range' ? `bytes ${a}-${b}/${file.length}` : null) },
      arrayBuffer: async () => part.buffer.slice(part.byteOffset, part.byteOffset + part.length),
      body: (async function* () { for (let i = 0; i < part.length; i += 1000) yield part.subarray(i, i + 1000); })() };
  };
  const list = await zip.entries(f, 'https://x.test/a.zip');
  assert.deepEqual(list.map((e) => e.name), ['readme.txt', 'data/prs.csv']);
  let text = ''; for await (const t of zip.text(f, 'https://x.test/a.zip', list[1])) text += t;
  const lines = text.trim().split('\n');
  assert.equal(lines.length, 5001);
  assert.equal(lines[4999 + 1], '4999;PODJETJE 4999 D.O.O.;A');
});

test('Quebec bulk: names joined to enterprises, individuals excluded, bankruptcy Stop, overdue update Check', async () => {
  const qcb = require('../lib/bulk/qc');
  const files = {
    'DomaineValeur.csv': 'TYP_DOM_VAL,COD_DOM_VAL,VAL_DOM_FRAN\r\nFORM_JURI,CIE,Société par actions ou compagnie\r\nFORM_JURI,IND,Entreprise individuelle\r\nREGIM_JURI,024,"QUÉBEC : Loi sur les sociétés par actions (RLRQ, C. S-31.1)"\r\nINTVAL_EMPLO_QUE,C,De 11 à 25\r\nACT_ECON,9961,Agences de voyages\r\n',
    'Nom.csv': 'NEQ,NOM_ASSUJ,NOM_ASSUJ_LANG_ETRNG,STAT_NOM,TYP_NOM_ASSUJ,DAT_INIT_NOM_ASSUJ,DAT_FIN_NOM_ASSUJ\r\n1140031510,9000-0001 QUÉBEC INC.,,V,M,1994-01-06,\r\n1140031510,VOYAGES SOLEIL INC.,SUN TRAVEL INC.,V,N,1995-01-01,\r\n1140031510,ANCIEN NOM,,A,N,1994-01-06,1995-01-01\r\n1140077777,RADIEE RECENTE INC.,,A,N,2010-01-01,2024-05-01\r\n1140077777,PLUS ANCIEN NOM,,A,N,2000-01-01,2010-01-01\r\n2240000000,JEAN TREMBLAY,,V,N,2000-01-01,\r\n1140099999,VIEILLE CIE INC.,,V,N,1990-01-01,\r\n1140088888,FAILLITE INC.,,V,N,2001-01-01,\r\n',
    'Entreprise.csv': 'NEQ,IND_FAIL,DAT_IMMAT,COD_REGIM_JURI,COD_INTVAL_EMPLO_QUE,DAT_CESS_PREVU,COD_STAT_IMMAT,COD_FORME_JURI,DAT_STAT_IMMAT,COD_REGIM_JURI_CONSTI,DAT_DEPO_DECLR,AN_DECL,AN_PROD,DAT_LIMIT_PROD,AN_PROD_PRE,DAT_LIMIT_PROD_PRE,DAT_MAJ_INDEX_NOM,COD_ACT_ECON_CAE,NO_ACT_ECON_ASSUJ,DESC_ACT_ECON_ASSUJ,COD_ACT_ECON_CAE2,NO_ACT_ECON_ASSUJ2,DESC_ACT_ECON_ASSUJ2,NOM_LOCLT_CONSTI,DAT_CONSTI,IND_CONVEN_UNMN_ACTNR,IND_RET_TOUT_POUVR,IND_LIMIT_RESP,DAT_DEB_RESP,DAT_FIN_RESP,OBJET_SOC,NO_MTR_VOLONT,ADR_DOMCL_ADR_DISP,ADR_DOMCL_LIGN1_ADR,ADR_DOMCL_LIGN2_ADR,ADR_DOMCL_LIGN3_ADR,ADR_DOMCL_LIGN4_ADR\r\n'
      + '1140031510,N,1994-01-19,024,C,,IM,CIE,1994-01-19,400,2024-07-08,2024,2026,2026-10-01,2025,2025-10-01,,9961,1,AGENCE DE VOYAGES,,,,QUÉBEC,1994-01-18,O,N,,,,,,N,320-275 RUE du Parvis,Québec (Québec),,G1K6G7\r\n'
      + '2240000000,N,2000-01-01,,A,,IM,IND,2000-01-01,,,,,,,,,,,,,,,,,,,,,,,,N,1 rue Privée,Laval,,H7E4P7\r\n'
      + '1140099999,N,1990-01-01,024,,,RO,CIE,2001-01-01,,,,,,,,,,,,,,,,,,,,,,,,N,,,,\r\n'
      + '1140077777,N,2010-01-01,024,,,RO,CIE,2024-05-01,,,,,,,,,,,,,,,,,,,,,,,,N,,,,\r\n'
      + '1140088888,O,2001-01-01,024,,,IM,CIE,2001-01-01,,2026-01-01,2026,2026,2026-10-01,2025,2025-10-01,,,,,,,,,,,,,,,,,N,1 rue X,Montréal,,H1H1H1\r\n',
  };
  const read = (name) => (async function* () { yield files[name]; })();
  const got = []; await qcb.build(read, (r) => got.push(r), '2026-11-08');
  assert.deepEqual(got.map((r) => [r.number, r.name, r.status]), [['qc-1140031510', 'VOYAGES SOLEIL INC.', 'active'], ['qc-1140077777', 'RADIEE RECENTE INC.', 'inactive'], ['qc-1140088888', 'FAILLITE INC.', 'active']], 'individual and old struck-off excluded; recent struck-off keeps its last name');
  got.splice(1, 1);
  const v = got[0];
  assert.equal(v.name, 'VOYAGES SOLEIL INC.');
  assert.equal(v.other_name, 'SUN TRAVEL INC.');
  assert.equal(v.legal_form, 'Société par actions ou compagnie');
  assert.equal(v.registered_address, '320-275 RUE du Parvis, Québec (Québec), G1K6G7');
  // Card through the Canada adapter (index built in a fake Blob store)
  const b = index.createBuilder({ sBuckets: 8 }); got.forEach((r) => b.add(r));
  const store = {}; for (const [p, t] of b.files()) store[`https://abcdstore1.public.blob.vercel-storage.com/bulk/qc/v/${p}`] = t;
  store['https://abcdstore1.public.blob.vercel-storage.com/bulk/qc/manifest.json'] = JSON.stringify({ base: 'https://abcdstore1.public.blob.vercel-storage.com/bulk/qc/v', s_buckets: 8 });
  const f = async (u) => (store[u] ? { ok: true, status: 200, json: async () => JSON.parse(store[u]), text: async () => store[u] } : { ok: false, status: 404, json: async () => ({}), text: async () => '' });
  index._resetManifests();
  const caReg = require('../lib/registers/ca').make({ BLOB_READ_WRITE_TOKEN: TOKEN });
  const hits = await caReg.search(f, 'voyages soleil');
  assert.deepEqual(hits.map((r) => [r.number, r.source]), [['qc-1140031510', 'Registraire des entreprises (Quebec)']]);
  let card = await caReg.get(f, 'qc-1140031510', { asOfIso: '2026-11-08' });
  assert.equal(card.situations[0].label, 'Annual update overdue');
  assert.equal(card.size, '11–25 employees in Quebec');
  card = await caReg.get(f, '1140088888', { asOfIso: '2026-11-08' });
  assert.equal(card.situations[0].label, 'Bankruptcy recorded');
});

test('Argentina bulk: rows grouped by CUIT, active activities, liquidation Stop, unknown tax address Check', async () => {
  const arb = require('../lib/bulk/ar');
  const H = 'cuit,razon_social,fecha_hora_contrato_social,tipo_societario,fecha_hora_actualizacion,numero_inscripcion,dom_fiscal_provincia,dom_fiscal_localidad,dom_fiscal_calle,dom_fiscal_numero,dom_fiscal_piso,dom_fiscal_departamento,dom_fiscal_cp,dom_fiscal_estado_domicilio,dom_legal_provincia,dom_legal_localidad,dom_legal_calle,dom_legal_numero,dom_legal_piso,dom_legal_departamento,dom_legal_cp,dom_legal_estado_domicilio,actividad_codigo,actividad_descripcion,actividad_orden,actividad_estado,actividad_vigencia\r\n';
  const csv = H
    + '30500000127,SEGUROS GALICIA S. A.,1912-04-30-00:00,SOCIEDAD ANONIMA,2026-04-30-09:25,,CIUDAD AUTONOMA BUENOS AIRES,CAPITAL FEDERAL,"PERON, JUAN TTE.GRAL.",430,6,,1038,DECLARADO POR INTERNET,CIUDAD AUTONOMA BUENOS AIRES,CAPITAL FEDERAL,PERON JUAN TTE.GRAL.,430,6,,1038,DECLARADO,651220,Servicios de seguros patrimoniales,1,AC,S\r\n'
    + '30500000127,SEGUROS GALICIA S. A.,1912-04-30-00:00,SOCIEDAD ANONIMA,2026-04-30-09:25,,CIUDAD AUTONOMA BUENOS AIRES,CAPITAL FEDERAL,"PERON, JUAN TTE.GRAL.",430,6,,1038,DECLARADO POR INTERNET,CIUDAD AUTONOMA BUENOS AIRES,CAPITAL FEDERAL,PERON JUAN TTE.GRAL.,430,6,,1038,DECLARADO,661220,,1,BD,S\r\n'
    + '30500000747,BANCO COMERCIAL DE TRES ARROYOS S A,1906-09-01-00:00,SOCIEDAD ANONIMA,2024-01-01-09:51,,BUENOS AIRES,TRES ARROYOS,BETOLAZA,189,,,7500,INEXISTENTE - DESCONOCIDO,BUENOS AIRES,TRES ARROYOS,AV MORENO,300,,,7500,NO CONFIRMADO,659890,,1,AC,S\r\n'
    + '30500001115,BOSTON COMPAÑIA ARGENTINA DE SEGUROS S A EN LIQUIDACION,1925-02-19-12:00,SOCIEDAD ANONIMA,2026-08-11-11:38,,CIUDAD AUTONOMA BUENOS AIRES,CAPITAL FEDERAL,SUIPACHA,268,03,,1008,CONFIRMADO,CIUDAD AUTONOMA BUENOS AIRES,CAPITAL FEDERAL,SUIPACHA,268,03,,1008,DECLARADO,651220,Seguros,1,AC,S\r\n';
  const got = []; await arb.addFile((async function* () { yield csv; })(), (r) => got.push(r));
  assert.deepEqual(got.map((r) => r.number), ['30500000127', '30500000747', '30500001115']);
  assert.deepEqual(got[0].activities, [['651220', 'Servicios de seguros patrimoniales']]);
  assert.equal(got[0].registered_address, 'PERON JUAN TTE.GRAL. 430, piso 6, CAPITAL FEDERAL, CIUDAD AUTONOMA BUENOS AIRES, 1038');
  const b = index.createBuilder({ sBuckets: 8 }); got.forEach((r) => b.add(r));
  const store = {}; for (const [p, t] of b.files()) store[`https://abcdstore1.public.blob.vercel-storage.com/bulk/ar/v/${p}`] = t;
  store['https://abcdstore1.public.blob.vercel-storage.com/bulk/ar/manifest.json'] = JSON.stringify({ base: 'https://abcdstore1.public.blob.vercel-storage.com/bulk/ar/v', s_buckets: 8 });
  const f = async (u) => (store[u] ? { ok: true, status: 200, json: async () => JSON.parse(store[u]), text: async () => store[u] } : { ok: false, status: 404, json: async () => ({}), text: async () => '' });
  index._resetManifests();
  const arReg = require('../lib/registers/ar').make({ BLOB_READ_WRITE_TOKEN: TOKEN });
  assert.deepEqual((await arReg.search(f, 'seguros galicia')).map((r) => r.number), ['30500000127']);
  assert.deepEqual((await arReg.search(f, '30-50000012-7')).map((r) => r.name), ['SEGUROS GALICIA S. A.']);
  let card = await arReg.get(f, '30500001115');
  assert.equal(card.situations[0].label, 'In liquidation');
  card = await arReg.get(f, '30500000747');
  assert.equal(card.situations[0].label, 'Tax address not confirmed');
  assert.deepEqual(card.register.gleif_as, ['30500000747', '30-50000074-7']);
});

test('Slovenia bulk: UTF-16 CSV in a ZIP; sole traders excluded', async () => {
  const zipl = require('../lib/bulk/zip'); const sib = require('../lib/bulk/si');
  const csv = '\uFEFF"Matična številka","Popolno ime","HSEID","Pravnoorganizacijska oblika","Registrski organ","Ulica","Hišna št.","Hišna št. dodatek","Naselje","Poštna št.","Pošta","Država"\r\n'
    + '"5000040100","AVTOSERVIS JERŠINOVIČ JERNEJ JERŠINOVIČ S.P.","10040000018810","Samostojni podjetnik posameznik s.p.","AJPES, izpostava Ljubljana","Voljčeva cesta","011","A","Vrhnika","1360","Vrhnika","SLOVENIJA"\r\n'
    + '"5000674000","SEMENIČ TRANSPORT d.o.o.","10040000011074","Družba z omejeno odgovornostjo d.o.o.","Okrožno sodišče Nova Gorica","Podnanos","001","","Podnanos","5272","Podnanos","SLOVENIJA"\r\n';
  const buf = Buffer.from(csv, 'utf16le');
  const zlib = require('zlib'); const comp = zlib.deflateRawSync(buf);
  // Minimal single-entry ZIP: local header + data + central directory + end record.
  const name = Buffer.from('opsiprs.csv'); const crc = 0;
  const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(buf.length, 22); lh.writeUInt16LE(name.length, 26);
  const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(buf.length, 24); cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(0, 42);
  const local = Buffer.concat([lh, name, comp]); const central = Buffer.concat([cd, name]);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(central.length, 12); eocd.writeUInt32LE(local.length, 16);
  const file = Buffer.concat([local, central, eocd]); void crc;
  const f = async (url, init = {}) => {
    const m = /bytes=(\d+)-(\d+)/.exec((init.headers || {}).Range || ''); const a = m ? Number(m[1]) : 0; const b2 = m ? Math.min(Number(m[2]), file.length - 1) : file.length - 1;
    const part = file.subarray(a, b2 + 1);
    return { ok: true, status: 206, headers: { get: (k) => (k.toLowerCase() === 'content-range' ? `bytes ${a}-${b2}/${file.length}` : null) }, arrayBuffer: async () => part.buffer.slice(part.byteOffset, part.byteOffset + part.length), body: (async function* () { for (let i = 0; i < part.length; i += 7) yield part.subarray(i, i + 7); })() };
  };
  const list = await zipl.entries(f, 'https://x.test/si.zip');
  const got = []; await sib.addFile(zipl.text(f, 'https://x.test/si.zip', list[0], 'utf-16le'), (r) => got.push(r));
  assert.deepEqual(got.map((r) => [r.number, r.name]), [['5000674000', 'SEMENIČ TRANSPORT d.o.o.']]);
  assert.equal(got[0].registered_address, 'Podnanos 001, Podnanos, 5272 Podnanos');
});

test('Chile bulk: semicolon CSVs across years; dissolution marks inactive; RUT lookup', async () => {
  const clb = require('../lib/bulk/cl');
  const H = '\uFEFFID;RUT;Razon Social;Fecha de actuacion (1era firma);Fecha de registro (ultima firma);Fecha de aprobacion x SII;Anio;Mes;Comuna Tributaria;Region Tributaria;Codigo de sociedad;Tipo de actuacion;Capital;Comuna Social;Region Social\r\n';
  const y2013 = H + '84;76286049-K;Servicios Digitales Enubis Cam limitada;02-05-2013;02-05-2013;02-05-2013;2013;Mayo;MAIPU;13;SRL;CONSTITUCIÓN;7000000;MAIPU;13\r\n'
    + '508;76286055-4;Fast Good Chile Limitada;02-05-2013;02-05-2013;02-05-2013;2013;Mayo;SAN MIGUEL;13;SRL;CONSTITUCIÓN;25000000;SAN MIGUEL;13\r\n';
  const y2020 = H + '9;76286055-4;Fast Good Chile Limitada;01-03-2020;01-03-2020;01-03-2020;2020;Marzo;SAN MIGUEL;13;SRL;DISOLUCIÓN;;SAN MIGUEL;13\r\n';
  const col = clb.createCollector();
  await col.addFile((async function* () { yield y2013; })());
  await col.addFile((async function* () { yield y2020; })());
  const got = [...col.records()];
  assert.deepEqual(got.map((r) => [r.number, r.status]), [['76286049-K', 'active'], ['76286055-4', 'inactive']]);
  assert.equal(got[0].legal_form, 'Sociedad de responsabilidad limitada');
  assert.equal(got[1].status_date, '2020-03-01');
  const b = index.createBuilder({ sBuckets: 8 }); got.forEach((r) => b.add(r));
  const store = {}; for (const [p, t] of b.files()) store[`https://abcdstore1.public.blob.vercel-storage.com/bulk/cl/v/${p}`] = t;
  store['https://abcdstore1.public.blob.vercel-storage.com/bulk/cl/manifest.json'] = JSON.stringify({ base: 'https://abcdstore1.public.blob.vercel-storage.com/bulk/cl/v', s_buckets: 8 });
  const f = async (u) => (store[u] ? { ok: true, status: 200, json: async () => JSON.parse(store[u]), text: async () => store[u] } : { ok: false, status: 404, json: async () => ({}), text: async () => '' });
  index._resetManifests();
  const clReg = require('../lib/registers/cl').make({ BLOB_READ_WRITE_TOKEN: TOKEN });
  assert.deepEqual((await clReg.search(f, '76.286.049-k')).map((r) => r.name), ['Servicios Digitales Enubis Cam limitada']);
  const card = await clReg.get(f, '76286055-4');
  assert.equal(card.status, 'inactive');
  assert.equal(card.share_capital, 'CLP 25,000,000');
});

test('Peru bulk: companies only; baja inactive; no habido Stop; suspension Check', async () => {
  const peb = require('../lib/bulk/pe');
  const txt = 'RUC|NOMBRE O RAZÓN SOCIAL|ESTADO DEL CONTRIBUYENTE|CONDICIÓN DE DOMICILIO|UBIGEO|TIPO DE VÍA|NOMBRE DE VÍA|CÓDIGO DE ZONA|TIPO DE ZONA|NÚMERO|INTERIOR|LOTE|DEPARTAMENTO|MANZANA|KILÓMETRO|\n'
    + '10452159428|GARCIA CHANCO CARLOS AUGUSTO|ACTIVO|HABIDO|-|-|-|-|-|-|-|-|-|-|-|\n'
    + '20100047218|BANCO DE CREDITO DEL PERU|ACTIVO|HABIDO|150114|AV.|CENTENARIO|-|-|156|-|-|-|-|-|\n'
    + '20500000001|EMPRESA FANTASMA S.A.C.|ACTIVO|NO HABIDO|150101|JR.|LIMA|-|-|100|-|-|-|-|-|\n'
    + '20500000002|CERRADA S.A.|BAJA DE OFICIO|HABIDO|-|-|-|-|-|-|-|-|-|-|-|\n'
    + '20500000004|EMPRESA "LOS ANDES S.A.C.|ACTIVO|HABIDO|-|-|-|-|-|-|-|-|-|-|-|\n'
    + '20500000003|PAUSADA S.A.C.|SUSPENSION TEMPORAL|HABIDO|-|-|-|-|-|-|-|-|-|-|-|\n';
  const got = []; await peb.addFile((async function* () { yield txt; })(), (r) => got.push(r));
  assert.deepEqual(got.map((r) => [r.number, r.status]), [['20100047218', 'active'], ['20500000001', 'active'], ['20500000002', 'inactive'], ['20500000004', 'active'], ['20500000003', 'active']], 'a lone quote in a name does not swallow later rows');
  assert.equal(got[0].registered_address, 'AV. CENTENARIO 156');
  const b = index.createBuilder({ sBuckets: 8 }); got.forEach((r) => b.add(r));
  const store = {}; for (const [p, t] of b.files()) store[`https://abcdstore1.public.blob.vercel-storage.com/bulk/pe/v/${p}`] = t;
  store['https://abcdstore1.public.blob.vercel-storage.com/bulk/pe/manifest.json'] = JSON.stringify({ base: 'https://abcdstore1.public.blob.vercel-storage.com/bulk/pe/v', s_buckets: 8 });
  const f = async (u) => (store[u] ? { ok: true, status: 200, json: async () => JSON.parse(store[u]), text: async () => store[u] } : { ok: false, status: 404, json: async () => ({}), text: async () => '' });
  index._resetManifests();
  const peReg = require('../lib/registers/pe').make({ BLOB_READ_WRITE_TOKEN: TOKEN });
  assert.deepEqual((await peReg.search(f, 'banco credito')).map((r) => r.number), ['20100047218']);
  let card = await peReg.get(f, '20500000001');
  assert.equal(card.situations[0].level, 'stop');
  card = await peReg.get(f, '20500000003');
  assert.equal(card.situations[0].label, 'Activities temporarily suspended');
  assert.equal(await peReg.get(f, '10452159428'), null);
});

test('Two-pass import: word index and records built in separate passes give the same searchable index', async () => {
  const { IMPORTERS } = require('../api/bulk-import');
  const recs = [{ number: '20100047218', name: 'BANCO DE CREDITO DEL PERU', status: 'active' }, { number: '20500000002', name: 'CERRADA S.A.', status: 'inactive' }];
  let passes = 0;
  IMPORTERS.ZZ = async () => ({ feed: async (add) => { passes++; recs.forEach(add); return recs.length; }, sBuckets: 8, source: {} });
  try {
    const b = fakeBlob();
    const res = mres(); await createImport({ fetchFn: b.fetchFn, blobFetch: b.fetchFn, env: { BLOB_READ_WRITE_TOKEN: TOKEN }, now: b.now })({ query: { country: 'ZZ' } }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(passes, 2);
    assert.equal(res.body.count, 2);
    assert.equal(res.body.active, 1);
    index._resetManifests();
    const base = 'https://abcdstore1.public.blob.vercel-storage.com';
    assert.deepEqual((await index.search(b.fetchFn, base, 'ZZ', 'banco credito')).map((r) => r.number), ['20100047218']);
    assert.equal((await index.get(b.fetchFn, base, 'ZZ', '20500000002')).name, 'CERRADA S.A.');
  } finally { delete IMPORTERS.ZZ; }
});

test('Sliced passes: four slices (two word halves, two record halves) give a complete index', async () => {
  const { IMPORTERS } = require('../api/bulk-import');
  const recs = [];
  for (let i = 0; i < 15050; i++) recs.push({ number: String(20500000000 + i), name: `MANSION COMERCIAL ${i} S.A.C.`, status: i % 3 ? 'active' : 'inactive' });
  recs.push({ number: '20100047218', name: 'BANCO DE CREDITO DEL PERU', status: 'active' });
  IMPORTERS.ZZ = async () => ({ feed: async (add) => { recs.forEach(add); }, sBuckets: 16, source: {},
    passes: [{ only: 's', sRange: [0, 8] }, { only: 's', sRange: [8, 16] }, { only: 'd', dRange: [0, 500] }, { only: 'd', dRange: [500, 1000] }] });
  try {
    const b = fakeBlob();
    const res = mres(); await createImport({ fetchFn: b.fetchFn, blobFetch: b.fetchFn, env: { BLOB_READ_WRITE_TOKEN: TOKEN }, now: b.now })({ query: { country: 'ZZ' } }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.count, recs.length);
    assert.ok(res.body.split.includes('man'));
    index._resetManifests();
    const base = 'https://abcdstore1.public.blob.vercel-storage.com';
    assert.deepEqual((await index.search(b.fetchFn, base, 'ZZ', 'banco credito')).map((r) => r.number), ['20100047218']);
    assert.equal((await index.search(b.fetchFn, base, 'ZZ', 'mansion comercial 15049')).length >= 1, true);
    for (const n of ['20500000000', '20500000999', '20100047218']) assert.ok(await index.get(b.fetchFn, base, 'ZZ', n), n);
  } finally { delete IMPORTERS.ZZ; }
});

test('Ukraine bulk: XML subjects streamed across chunks; old terminations skipped; wind-up Stop', async () => {
  const uab = require('../lib/bulk/ua');
  const xml = '<?xml version="1.0" encoding="windows-1251"?>\n<DATA FORMAT_VERSION="1.0">\n'
    + '<SUBJECT><RECORD>1</RECORD><NAME>ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ &quot;АГРОСВІТ&quot;</NAME><SHORT_NAME>ТОВ &quot;АГРОСВІТ&quot;</SHORT_NAME><OPF>ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ</OPF><EDRPOU>33444728</EDRPOU><STAN>зареєстровано</STAN><FOUNDERS><FOUNDER>ІВАНЕНКО ІВАН</FOUNDER></FOUNDERS><AUTHORIZED_CAPITAL>100,00</AUTHORIZED_CAPITAL><REGISTRATION>24.05.2005; 24.05.2005; 10671020000003069</REGISTRATION><TERMINATED_INFO/></SUBJECT>\n'
    + '<SUBJECT><RECORD>2</RECORD><NAME>&quot;СТАРА&quot;</NAME><OPF>ПРИВАТНЕ ПІДПРИЄМСТВО</OPF><EDRPOU>14359609</EDRPOU><STAN>припинено</STAN><REGISTRATION>16.09.1996</REGISTRATION><TERMINATED_INFO>05.12.2006; 1067; причина</TERMINATED_INFO></SUBJECT>\n'
    + '<SUBJECT><RECORD>3</RECORD><NAME>ПРИВАТНЕ ПІДПРИЄМСТВО &quot;ЛІКВІД&quot;</NAME><OPF>ПРИВАТНЕ ПІДПРИЄМСТВО</OPF><EDRPOU>22788425</EDRPOU><STAN>в стані припинення</STAN><REGISTRATION>21.10.2005; 21.10.2005</REGISTRATION><TERMINATION_STARTED_INFO><OP_DATE>21.10.2005</OP_DATE></TERMINATION_STARTED_INFO></SUBJECT>\n</DATA>';
  async function* chunks() { for (let i = 0; i < xml.length; i += 37) yield xml.slice(i, i + 37); }
  const got = []; await uab.addFile(chunks(), (r) => got.push(r), '2026-11-08');
  assert.deepEqual(got.map((r) => [r.number, r.status, r.flag || null]), [['33444728', 'active', null], ['22788425', 'active', 'stop']]);
  assert.equal(got[0].name, 'ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ "АГРОСВІТ"');
  assert.equal(got[0].incorporated, '2005-05-24');
  assert.equal(JSON.stringify(got[0]).includes('ІВАНЕНКО'), false, 'founders not kept');
  const b = index.createBuilder({ sBuckets: 8 }); got.forEach((r) => b.add(r));
  const store = {}; for (const [p, t] of b.files()) store[`https://abcdstore1.public.blob.vercel-storage.com/bulk/ua/v/${p}`] = t;
  store['https://abcdstore1.public.blob.vercel-storage.com/bulk/ua/manifest.json'] = JSON.stringify({ base: 'https://abcdstore1.public.blob.vercel-storage.com/bulk/ua/v', s_buckets: 8, t_layout: 2 });
  const f = async (u) => (store[u] ? { ok: true, status: 200, json: async () => JSON.parse(store[u]), text: async () => store[u] } : { ok: false, status: 404, json: async () => ({}), text: async () => '' });
  index._resetManifests();
  const uaReg = require('../lib/registers/ua').make({ BLOB_READ_WRITE_TOKEN: TOKEN });
  assert.deepEqual((await uaReg.search(f, 'агросвіт')).map((r) => r.number), ['33444728']);
  const card = await uaReg.get(f, '22788425');
  assert.equal(card.situations[0].level, 'stop');
});

test('XLSX reader: shared strings, inline strings, empty cells and dates, streamed from a ZIP', async () => {
  const xl = require('../lib/bulk/xlsx'); const zipl = require('../lib/bulk/zip');
  const file = require('fs').readFileSync(require('path').join(__dirname, 'fixtures/sample.xlsx'));
  const f = async (url, init = {}) => {
    const m = /bytes=(\d+)-(\d+)/.exec((init.headers || {}).Range || ''); const a = m ? Number(m[1]) : 0; const b2 = m ? Math.min(Number(m[2]), file.length - 1) : file.length - 1;
    const part = file.subarray(a, b2 + 1);
    return { ok: true, status: 206, headers: { get: (k) => (k.toLowerCase() === 'content-range' ? `bytes ${a}-${b2}/${file.length}` : null) }, arrayBuffer: async () => part.buffer.slice(part.byteOffset, part.byteOffset + part.length), body: (async function* () { for (let i = 0; i < part.length; i += 11) yield part.subarray(i, i + 11); })() };
  };
  const list = await zipl.entries(f, 'https://x.test/a.xlsx');
  const read = (name) => { const e = list.find((x) => x.name === name); if (!e) throw new Error(`${name} missing`); return zipl.text(f, 'https://x.test/a.xlsx', e); };
  const got = []; for await (const r of xl.records(read)) got.push(r);
  assert.deepEqual(got[0], { IDNO: '1003600000001', Denumirea: '„ORANGE MOLDOVA” S.A.', Forma: 'Societate pe acțiuni', Data: '35796' });
  assert.equal(got[1].Denumirea, 'ÎNTREPRINDEREA & CO');
  assert.equal(got[1].Forma, '');
  assert.equal(xl.excelDate('35796'), '1998-01-01');
});

test('ZIP text: stopping early cancels the download without unhandled errors', async () => {
  const zipl = require('../lib/bulk/zip');
  const file = require('fs').readFileSync(require('path').join(__dirname, 'fixtures/sample.zip'));
  let aborted = false;
  const f = async (url, init = {}) => {
    const m = /bytes=(\d+)-(\d+)/.exec((init.headers || {}).Range || ''); const a = m ? Number(m[1]) : 0; const b2 = m ? Math.min(Number(m[2]), file.length - 1) : file.length - 1;
    const part = file.subarray(a, b2 + 1);
    if (init.signal) init.signal.addEventListener('abort', () => { aborted = true; });
    return { ok: true, status: 206, headers: { get: (k) => (k.toLowerCase() === 'content-range' ? `bytes ${a}-${b2}/${file.length}` : null) }, arrayBuffer: async () => part.buffer.slice(part.byteOffset, part.byteOffset + part.length),
      body: (async function* () { for (let i = 0; i < part.length; i += 50) { if (init.signal && init.signal.aborted) throw new Error('aborted'); yield part.subarray(i, i + 50); await new Promise((r) => setImmediate(r)); } })() };
  };
  const unhandled = []; const on = (e) => unhandled.push(e); process.on('unhandledRejection', on);
  try {
    const list = await zipl.entries(f, 'https://x.test/a.zip');
    let got = ''; for await (const t of zipl.text(f, 'https://x.test/a.zip', list[1])) { got += t; if (got.length > 100) break; }
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(got.startsWith('id;naziv'));
    assert.equal(aborted, true);
    assert.deepEqual(unhandled, []);
  } finally { process.off('unhandledRejection', on); }
});

test('India bulk: new files first, old file stops where they begin; e-mails dropped; status unknown is Check', async () => {
  const inb = require('../lib/bulk/in');
  const oldCsv = 'id,registration_date,cin,state_name,state_code,roc,company_name,company_status,company_type,company_class,company_category,act_description,company_address,company_email,authorized_capital,paidup_capital\n'
    + '0,2016-01-01,U72300AP2016PTC098004,Andhra Pradesh,28.0,Roc-Hyderabad,LINCOLN TECHNOLOGY SOLUTIONS (INDIA) PRIVATE LIMITED,Not Available,Non-Government Company,Private,Company Limited By Shares,Not Available,"C/90, Anil Real Estate,   Vizianagaram Andhra Pradesh INDIA 535270",someone@example.com,1000000.0,100000.0\n'
    + '1,2023-11-01,U82300TN2023OPC164902,Tamil Nadu,33,Roc-Chennai,CIRCLE27 MARKETING (OPC) PRIVATE LIMITED,Not Available,Non-Government Company,One Person Company,Company Limited By Shares,Not Available,Chennai,Not Available,100000.0,100000.0\n';
  const newCsv = 'id,cin,company_class,company_name,registration_date,company_type,act_code,act_description\n1,U82300TN2023OPC164902,One Person Company,Circle27 Marketing (Opc) Private Limited,2023-11-01,Non-Government Company,82.0,"Community, personal & Social Services"\n';
  const llpCsv = '"id","llpin","llp_name","registration_date","act_code","act_description"\r\n0,"ACD-7227","SRI MOOKAMBIKA AGRO FOODS LLP","2023-11-01",1.0,"Agriculture and Allied Activities"\r\n';
  async function* ch(s) { for (let i = 0; i < s.length; i += 29) yield s.slice(i, i + 29); }
  const got = [];
  const { first } = await inb.addFile(ch(newCsv), 'company', (r) => got.push(r));
  assert.equal(first, '2023-11-01');
  await inb.addFile(ch(oldCsv), 'company', (r) => got.push(r), { until: first });
  await inb.addFile(ch(llpCsv), 'llp', (r) => got.push(r));
  assert.deepEqual(got.map((r) => r.number), ['U82300TN2023OPC164902', 'U72300AP2016PTC098004', 'ACD-7227']);
  assert.equal(JSON.stringify(got).includes('example.com'), false, 'e-mails not kept');
  assert.equal(got[1].registered_address, 'C/90, Anil Real Estate, Vizianagaram Andhra Pradesh INDIA 535270');
  assert.equal(got[2].legal_form, 'Limited Liability Partnership');
  const b = index.createBuilder({ sBuckets: 8 }); got.forEach((r) => b.add(r));
  const store = {}; for (const [p, t] of b.files()) store[`https://abcdstore1.public.blob.vercel-storage.com/bulk/in/v/${p}`] = t;
  store['https://abcdstore1.public.blob.vercel-storage.com/bulk/in/manifest.json'] = JSON.stringify({ base: 'https://abcdstore1.public.blob.vercel-storage.com/bulk/in/v', s_buckets: 8, t_layout: 2 });
  const f = async (u) => (store[u] ? { ok: true, status: 200, json: async () => JSON.parse(store[u]), text: async () => store[u] } : { ok: false, status: 404, json: async () => ({}), text: async () => '' });
  index._resetManifests();
  const reg = require('../lib/registers/in').make({ BLOB_READ_WRITE_TOKEN: TOKEN });
  assert.deepEqual((await reg.search(f, 'lincoln technology')).map((r) => r.number), ['U72300AP2016PTC098004']);
  assert.deepEqual((await reg.search(f, 'acd-7227')).map((r) => r.number), ['ACD-7227']);
  const card = await reg.get(f, 'U72300AP2016PTC098004');
  assert.equal(card.situations[0].label, 'Current status not published');
  assert.equal(card.share_capital, 'INR 1,00,000 paid up');
});

test('Dominican Republic bulk: 9-digit RNCs only (no individuals); suspended is Check; baja is inactive', async () => {
  const dob = require('../lib/bulk/do');
  const txt = '00300749256|CASTALIO LEONIDAS RUIZ SANTANA|MOTO PRESTAMO|PRÉSTAMO DE DINERO| | | | ||SUSPENDIDO|NORMAL\r\n'
    + '101001577|CERVECERIA NACIONAL DOMINICANA SA|CND|ELABORACIÓN DE CERVEZA| | | | |15/03/1947|ACTIVO|NORMAL\r\n'
    + '130123456|EMPRESA "SUSPENDIDA" SRL||COMERCIO| | | | ||SUSPENDIDO|NORMAL\r\n'
    + '401500001|VIEJA SA||SERVICIOS| | | | ||DADO DE BAJA|NORMAL\r\n';
  async function* ch() { for (let i = 0; i < txt.length; i += 23) yield txt.slice(i, i + 23); }
  const got = []; await dob.addFile(ch(), (r) => got.push(r));
  assert.deepEqual(got.map((r) => [r.number, r.status, r.flag || null]), [['101001577', 'active', null], ['130123456', 'active', 'check'], ['401500001', 'inactive', null]]);
  assert.equal(got[0].incorporated, '1947-03-15');
  assert.equal(got[1].name, 'EMPRESA "SUSPENDIDA" SRL');
  assert.equal(JSON.stringify(got).includes('CASTALIO'), false, 'individuals not kept');
});

test('Ecuador bulk: companies only; one record per RUC from the head office across files; shell list is Stop', async () => {
  const ecb = require('../lib/bulk/ec');
  const head = ecb.COL.join('|') + '\n';
  const line = (o) => ecb.COL.map((c) => o[c] || '').join('|') + '\n';
  const base = { CODIGO_JURISDICCION: 'PICHINCHA', ESTADO_CONTRIBUYENTE: 'ACTIVO', CLASE_CONTRIBUYENTE: 'GEN', FECHA_INICIO_ACTIVIDADES: '1990-01-02 00:00:00', TIPO_CONTRIBUYENTE: 'SOCIEDAD', ESTADO_ESTABLECIMIENTO: 'ABI', CODIGO_CIIU: 'C110300', ACTIVIDAD_ECONOMICA: 'ELABORACIÓN DE CERVEZA' };
  const guayas = head + line({ ...base, NUMERO_RUC: '1790041220001', RAZON_SOCIAL: 'CERVECERIA NACIONAL CN S.A.', NUMERO_ESTABLECIMIENTO: '2', DESCRIPCION_PROVINCIA_EST: 'GUAYAS', DESCRIPCION_CANTON_EST: 'GUAYAQUIL' })
    + line({ ...base, NUMERO_RUC: '0990000001001', RAZON_SOCIAL: 'SOLO SUCURSAL S.A.', NUMERO_ESTABLECIMIENTO: '3', DESCRIPCION_CANTON_EST: 'DAULE' })
    + line({ ...base, NUMERO_RUC: '1725902892001', RAZON_SOCIAL: 'NARVAEZ VASQUEZ YESSENIA', TIPO_CONTRIBUYENTE: 'PERSONA NATURAL', NUMERO_ESTABLECIMIENTO: '1' });
  const pichincha = head + line({ ...base, NUMERO_RUC: '1790041220001', RAZON_SOCIAL: 'CERVECERIA NACIONAL CN S.A.', NUMERO_ESTABLECIMIENTO: '1', NOMBRE_FANTASIA_COMERCIAL: 'CERVECERIA NACIONAL', DESCRIPCION_PROVINCIA_EST: 'PICHINCHA', DESCRIPCION_CANTON_EST: 'QUITO', DESCRIPCION_PARROQUIA_EST: 'CUMBAYA' })
    + line({ ...base, NUMERO_RUC: '1792444713001', RAZON_SOCIAL: 'INCONCIV CONSTRUCCIONES CIA. LTDA.', NUMERO_ESTABLECIMIENTO: '1', ESTADO_CONTRIBUYENTE: 'SUSPENDIDO', FECHA_SUSPENSION_DEFINITIVA: '' });
  const shellCsv = 'NRO_CONTRIBUYENTE|NUMERO_RUC| RAZON_SOCIAL|TIPO_CONTRIBUYENTE|DETALLE_CALIFICACION|FECHA_REACTIVACION_RUC\r\n6|1792444713001|INCONCIV CONSTRUCCIONES CIA. LTDA.|SOCIEDAD|EMPRESA INEXISTENTE / FANTASMA|\r\n1|1351650526001|BRAVO ACOSTA|PERSONA NATURAL|X|\r\n';
  async function* ch(s) { for (let i = 0; i < s.length; i += 31) yield s.slice(i, i + 31); }
  const state = ecb.newState(await ecb.shells(ch(shellCsv)));
  assert.equal(state.shells.size, 1);
  const got = [];
  await ecb.addFile(ch(guayas), (r) => got.push(r), state);
  await ecb.addFile(ch(pichincha), (r) => got.push(r), state);
  ecb.finish(state, (r) => got.push(r));
  assert.deepEqual(got.map((r) => r.number), ['1790041220001', '1792444713001', '0990000001001']);
  assert.equal(got[0].location, 'CUMBAYA, QUITO, PICHINCHA');
  assert.equal(got[0].other_name, 'CERVECERIA NACIONAL');
  assert.equal(got[1].flag, 'stop');
  assert.equal(JSON.stringify(got).includes('NARVAEZ'), false, 'individuals not kept');
  const reg = require('../lib/registers/ec');
  assert.equal(reg.normalise('1790041220'), '1790041220001');
});

test('ZIP from memory: same entries and text as the range reader', async () => {
  const zip = require('../lib/bulk/zip');
  const file = require('fs').readFileSync(require('path').join(__dirname, 'fixtures/sample.zip'));
  const list = zip.entriesFromBuffer(file);
  assert.deepEqual(list.map((e) => e.name), ['readme.txt', 'data/prs.csv']);
  let text = ''; for await (const t of zip.textFromBuffer(file, list[1])) text += t;
  assert.equal(text.trim().split('\n').length, 5001);
});

test('Paraguay bulk: legal entities (RUC 8xxxxxxx) only; blocked is Stop; card number carries the check digit', async () => {
  const pyb = require('../lib/bulk/py');
  const txt = '1000018|TRINIDAD, SEBASTIAN|6|TISE651860P|SUSPENSION TEMPORAL|\n80000519|BANCO BASA S.A.|8|BBSA123|ACTIVO|\n80012345|EMPRESA BLOQUEADA S.A.|1||BLOQUEADO|\n80099999|VIEJA SRL|2||CANCELADO|\n';
  async function* ch() { for (let i = 0; i < txt.length; i += 17) yield txt.slice(i, i + 17); }
  const got = []; await pyb.addFile(ch(), (r) => got.push(r));
  assert.deepEqual(got.map((r) => [r.number, r.status, r.flag || null]), [['80000519', 'active', null], ['80012345', 'active', 'stop'], ['80099999', 'inactive', null]]);
  assert.equal(JSON.stringify(got).includes('TRINIDAD'), false, 'individuals not kept');
  assert.equal(require('../lib/registers/py').normalise('80000519-8'), '80000519');
});

test('Brazil bulk: Empresas lines; individuals (2135, 4xxx) excluded; head-office CNPJ with check digits (also alphanumeric)', async () => {
  const brb = require('../lib/bulk/br');
  assert.equal(brb.headOffice('33000167'), '33000167000101');
  assert.equal(brb.checkDigits('12ABC34501DE'), '35');
  const txt = '"41273589";"IRENILDA OLIVEIRA SILVA 11338767810";"2135";"50";"5000,00";"01";""\n'
    + '"41273590";"MARIA DAS MERCES SOARES LEMOS";"4014";"34";"0,00";"05";""\n'
    + '"33000167";"PETROLEO BRASILEIRO S A PETROBRAS";"2038";"10";"205431960490,52";"05";""\r\n'
    + '"41273603";"GRAFLINE ACESSORIOS  GRAFICOS LTDA";"2062";"49";"10000,00";"01";""';
  async function* ch() { for (let i = 0; i < txt.length; i += 41) yield txt.slice(i, i + 41); }
  const got = []; await brb.addFile(ch(), (r) => got.push(r));
  assert.deepEqual(got.map((r) => r.number), ['33000167000101', '41273603000144']);
  assert.equal(got[0].capital, 205431960491);
  assert.equal(got[1].name, 'GRAFLINE ACESSORIOS GRAFICOS LTDA');
  assert.equal(JSON.stringify(got).includes('IRENILDA'), false, 'individuals not kept');
  // Name search across shards: only the shards that exist answer.
  const b = index.createBuilder({ sBuckets: 8 }); got.forEach((r) => b.add(r));
  const store = {}; for (const [p, t] of b.files()) store[`https://abcdstore1.public.blob.vercel-storage.com/bulk/br3/v/${p}`] = t;
  store['https://abcdstore1.public.blob.vercel-storage.com/bulk/br3/manifest.json'] = JSON.stringify({ base: 'https://abcdstore1.public.blob.vercel-storage.com/bulk/br3/v', s_buckets: 8, t_layout: 2 });
  const f = async (u) => (store[u] ? { ok: true, status: 200, json: async () => JSON.parse(store[u]), text: async () => store[u] } : { ok: false, status: 404, json: async () => ({}), text: async () => '' });
  index._resetManifests();
  const old = process.env.BLOB_READ_WRITE_TOKEN; process.env.BLOB_READ_WRITE_TOKEN = TOKEN;
  try {
    const reg = require('../lib/registers/br');
    const hits = await reg.search(f, 'petrobras');
    assert.deepEqual(hits.map((h) => h.number), ['33000167000101']);
    assert.equal(reg.normalise('12.ABC.345/01DE-35'), '12ABC34501DE35');
  } finally { if (old === undefined) delete process.env.BLOB_READ_WRITE_TOKEN; else process.env.BLOB_READ_WRITE_TOKEN = old; }
});

test('ZIP sequential reader: every entry in one download, in archive order', async () => {
  const zip = require('../lib/bulk/zip');
  const file = require('fs').readFileSync(require('path').join(__dirname, 'fixtures/sample.zip'));
  const list = zip.entriesFromBuffer(file);
  const f = async () => ({ ok: true, status: 200, body: (async function* () { for (let i = 0; i < file.length; i += 777) yield file.subarray(i, i + 777); })() });
  const seen = [];
  await zip.eachEntry(f, 'https://x.test/a.zip', list, (e, t) => { seen.push([e.name, t.trim().split('\n').length]); });
  assert.deepEqual(seen, [['readme.txt', seen[0][1]], ['data/prs.csv', 5001]]);
});

test('Russia bulk: FNS revenue/expenses documents; short legal form; card shows revenue, not a computed result', async () => {
  const rub = require('../lib/bulk/ru');
  const xml = '<?xml version="1.0" encoding="UTF-8"?><Файл ТипИнф="ОТКРДАННЫЕ5"><Документ ИдДок="a" ДатаДок="25.10.2026" ДатаСост="31.12.2025"><СведНП НаимОрг="ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ &quot;ВИКО&quot;" ИННЮЛ="7726500020"/><СведДохРасх СумДоход="33250000.00" СумРасход="27999000.00"/></Документ>'
    + '<Документ ИдДок="b" ДатаСост="31.12.2025"><СведНП НаимОрг="ИВАНОВ" ИННЮЛ="123"/></Документ></Файл>';
  const got = rub.documents(xml);
  assert.equal(got.length, 1);
  assert.equal(got[0].other_name, 'ООО "ВИКО"');
  const b = index.createBuilder({ sBuckets: 8 }); got.forEach((r) => b.add(r));
  const store = {}; for (const [p, t] of b.files()) store[`https://abcdstore1.public.blob.vercel-storage.com/bulk/ru/v/${p}`] = t;
  store['https://abcdstore1.public.blob.vercel-storage.com/bulk/ru/manifest.json'] = JSON.stringify({ base: 'https://abcdstore1.public.blob.vercel-storage.com/bulk/ru/v', s_buckets: 8, t_layout: 2 });
  const f = async (u) => (store[u] ? { ok: true, status: 200, json: async () => JSON.parse(store[u]), text: async () => store[u] } : { ok: false, status: 404, json: async () => ({}), text: async () => '' });
  index._resetManifests();
  const reg = require('../lib/registers/ru').make({ BLOB_READ_WRITE_TOKEN: TOKEN });
  assert.deepEqual((await reg.search(f, 'общество вико')).map((r) => r.number), ['7726500020']);
  const card = await reg.get(f, '7726500020');
  assert.deepEqual(card.financials, { year: '2025', revenue: 33250000, net_result: null, currency: 'RUB' });
  assert.ok(card.extra.some(([k, v]) => k === 'Expenses (2025)' && v === 'RUB 27,999,000'));
});

test('ZIP sequential reader resumes a dropped download with a Range request', async () => {
  const zip = require('../lib/bulk/zip');
  const file = require('fs').readFileSync(require('path').join(__dirname, 'fixtures/sample.zip'));
  const list = zip.entriesFromBuffer(file);
  let calls = 0;
  const f = async (url, init = {}) => {
    calls++;
    const m = /bytes=(\d+)-/.exec((init.headers || {}).Range || ''); const from = m ? Number(m[1]) : 0;
    const part = file.subarray(from);
    return { ok: !m, status: m ? 206 : 200, body: (async function* () { for (let i = 0; i < part.length; i += 500) { if (calls === 1 && i > 3000) throw new Error('terminated'); yield part.subarray(i, i + 500); } })() };
  };
  const seen = [];
  await zip.eachEntry(f, 'https://x.test/a.zip', list, (e, t) => { seen.push(e.name); });
  assert.deepEqual(seen, ['readme.txt', 'data/prs.csv']);
  assert.equal(calls, 2);
});

test('XLSX element reader does not drop an element whose tag name ends at a chunk boundary', async () => {
  const { elements } = require('../lib/bulk/xlsx');
  const xml = '<sst><si><t>A</t></si><si><t>B</t></si><si><t>C</t></si></sst>';
  for (let cut = 1; cut < xml.length; cut++) {
    async function* ch() { yield xml.slice(0, cut); yield xml.slice(cut); }
    const got = []; for await (const e of elements(ch(), 'si')) got.push(e.replace(/<[^>]+>/g, ''));
    assert.deepEqual(got, ['A', 'B', 'C'], `cut at ${cut}`);
  }
});

test('Moldova bulk: header found after the title row; sole traders excluded; liquidated inactive; only corporate founders kept', async () => {
  const mdb = require('../lib/bulk/md');
  const rows = [
    ['', '', '', 'Date din Registrul de stat (starea pînă la 02.11.2026)', ''],
    ['IDNO/ Cod fiscal', 'Data înregistrării', 'Denumirea completă', 'Forma org./jurid.', 'Adresa', 'Codul unităţii administrativ-teritoriale (CUATM)', 'Lista conducătorilor (cu indicarea rolurilor)', 'Lista fondatorilor (cu indicarea cotei părţi în capitalul social %)', 'Genuri de activitate nelicentiate', 'Genuri de activitate licentiate', 'Data lichidării'],
    ['1003600000001', '33604', 'INTREPRINDEREA INDIVIDUALA "X"', 'Întreprindere individuală', 'BĂLȚI', '300', 'POPESCU ION [Administrator]', 'POPESCU ION', '72100', '', ''],
    ['1003602023531', '33605', 'INTREPRINDEREA DE STAT "RUBIN"', 'Întreprindere de stat', 'MD-5901, FĂLEȘTI', '4301', 'CUHTIȚCHI NICOLAI [Administrator]', 'STATUL (100,00%)', '64200, 52483', '', '40119'],
    ['1002600012345', '40000', '"MOLDCOM" S.R.L.', 'Societate cu răspundere limitată', 'MD-2008, CHIȘINĂU', '120', 'PATLEA ANATOL [Administrator]', 'PATLEA ANATOL (50,00%), "HOLDCO" S.R.L. (50,00%)', '50301', '', ''],
  ];
  async function* it() { for (const r of rows) yield r; }
  const got = []; await mdb.addRows(it(), (r) => got.push(r));
  assert.deepEqual(got.map((r) => [r.number, r.status]), [['1003602023531', 'inactive'], ['1002600012345', 'active']]);
  assert.deepEqual(got[1].corporate_founders, [{ name: '"HOLDCO" S.R.L.', share: '50.00%' }]);
  assert.equal(JSON.stringify(got).includes('PATLEA'), false, 'private persons not kept');
  assert.equal(got[0].incorporated, '1992-01-02');
});

test('Index search ranks whole-word matches above prefix matches', async () => {
  const b = index.createBuilder({ sBuckets: 8 });
  [{ number: '1', name: 'ЗАКРЫТОЕ АКЦИОНЕРНОЕ ОБЩЕСТВО "ВИКОС"', status: 'active' }, { number: '2', name: 'ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ "ВИКО"', status: 'active' }].forEach((r) => b.add(r));
  const store = {}; for (const [p, t] of b.files()) store[`https://abcdstore1.public.blob.vercel-storage.com/bulk/zz/v/${p}`] = t;
  store['https://abcdstore1.public.blob.vercel-storage.com/bulk/zz/manifest.json'] = JSON.stringify({ base: 'https://abcdstore1.public.blob.vercel-storage.com/bulk/zz/v', s_buckets: 8, t_layout: 2 });
  const f = async (u) => (store[u] ? { ok: true, status: 200, json: async () => JSON.parse(store[u]), text: async () => store[u] } : { ok: false, status: 404, json: async () => ({}), text: async () => '' });
  index._resetManifests();
  const hits = await index.search(f, 'https://abcdstore1.public.blob.vercel-storage.com', 'ZZ', 'вико');
  assert.deepEqual(hits.map((h) => h.number), ['2', '1']);
});

test('Romania bulk: natural persons (F...) excluded; worst status wins; radiată inactive; sanctions code Stop', async () => {
  const rob = require('../lib/bulk/ro');
  async function* ch(s) { for (let i = 0; i < s.length; i += 37) yield s.slice(i, i + 37); }
  const nom = '﻿COD^DENUMIRE\r\n1048^funcțiune\r\n1084^radiată\r\n2151^sancțiuni internaționale\r\n2069^sediu expirat\r\n';
  const stare = '﻿COD_INMATRICULARE^COD\r\nJ40/1/1991^1048\r\nJ40/2/1991^1048\r\nJ40/2/1991^2151\r\nJ40/3/1991^1084\r\nF40/9/1991^1048\r\nJ40/4/1991^2069\r\n';
  const firms = '﻿DENUMIRE^CUI^COD_INMATRICULARE^DATA_INMATRICULARE^EUID^FORMA_JURIDICA^ADR_TARA^ADR_JUDET^ADR_LOCALITATE^ADR_DEN_STRADA^ADR_NR_STRADA^ADR_BLOC^ADR_SCARA^ADR_ETAJ^ADR_APARTAMENT^ADR_COD_POSTAL^ADR_SECTOR^ADR_COMPLETARE\r\n'
    + 'ALFA SRL^1568158^J40/1/1991^30/05/1991^ROONRC.J40/1/1991^SRL^România^Bucureşti^Bucureşti Sectorul 1^Str. FORTUNEI^8^^^^^  84662^1^\r\n'
    + 'BETA SA^451787^J40/2/1991^12/04/1991^ROONRC.J40/2/1991^SA^România^Bucureşti^Bucureşti Sectorul 3^B-dul PALLADY^57^^^^^032258^3^HALA\r\n'
    + 'GAMA SRL^371815^J40/3/1991^10/06/1991^ROONRC.J40/3/1991^SRL^România^Bucureşti^Bucureşti Sectorul 4^Str. TOHANI^2^^^^^0^4^\r\n'
    + 'POPESCU ION PFA^9113160^F40/9/1991^13/08/1997^ROONRC.F40/9/1991^PFA^România^Bucureşti^Bucureşti^Str. X^1^^^^^0^6^\r\n'
    + 'DELTA SRL^373913^J40/4/1991^10/02/1992^ROONRC.J40/4/1991^SRL^România^Cluj^Cluj-Napoca^Str. Y^5^^^^^400000^^\r\n';
  const codeMap = await rob.codes(ch(nom));
  const statusOf = await rob.statuses(ch(stare), codeMap);
  const got = []; await rob.addFirms(ch(firms), (r) => got.push(r), statusOf, codeMap);
  assert.deepEqual(got.map((r) => [r.number, r.status, r.flag || null]), [['1568158', 'active', null], ['451787', 'active', 'stop'], ['371815', 'inactive', null], ['373913', 'active', 'check']]);
  assert.equal(got[1].status_label, 'sancțiuni internaționale');
  assert.equal(got[0].registered_address, 'Str. FORTUNEI nr. 8, 84662 Bucureşti Sectorul 1, Bucureşti');
  assert.equal(got[0].incorporated, '1991-05-30');
  assert.equal(JSON.stringify(got).includes('POPESCU'), false, 'natural persons not kept');
  assert.equal(require('../lib/registers/ro').normalise('RO 1568158'), '1568158');
});

test('Luxembourg bulk: deposits streamed from the JSON array; latest year per RCS; negative equity is Check', async () => {
  const lub = require('../lib/bulk/lu');
  const dep = (rcs, name, year, eq, res) => JSON.stringify({ featuretype: 'hvd.AnnualDeposits', Declarations: `{ RcsNumber : ${rcs}, LegalUnitName : ${name}, Declarations : [ { Declaration : { type : CA_BILANABR, StartDate : ${year}-01-01, EndDate : ${year}-12-31, YearRef : ${year}, RCSDepositDate : ${Number(year) + 1}-06-01T10:00:00Z, Currency : EUR, FormData : { Field : [ { id : 0_Actif_2010, Label : TOTAL DU BILAN (ACTIF), Data : 1000.00, PreviousData : 900.00 }, { id : 1_CapProp_2010, Label : Capitaux propres, Data : ${eq}, PreviousData : 1.00 }, { id : 8_ResultEx_2020, Label : Résultat de l'exercice, Data : ${res} } ] } } } ] }` }, null, 1);
  const file = '[\r\n' + [dep('B80587', 'EFFE International SA', '2022', '10.00', '5.00'), dep('B80587', 'EFFE International SA', '2023', '-312420.63', '46909.45'), dep('B230641', 'BAHA INVEST S.A., LUXEMBOURG', '2023', '24079.48', '4735.77')].join(',\r\n') + '\r\n]';
  async function* ch() { for (let i = 0; i < file.length; i += 53) yield file.slice(i, i + 53); }
  const best = new Map(); await lub.eachDeposit(ch(), (d) => { if (lub.better(best.get(d.number), d)) best.set(d.number, d); });
  assert.deepEqual([...best.keys()], ['B80587', 'B230641']);
  assert.equal(best.get('B80587').year, '2023');
  assert.equal(best.get('B230641').name, 'BAHA INVEST S.A., LUXEMBOURG');
  const b = index.createBuilder({ sBuckets: 8 }); for (const d of best.values()) b.add(lub.toRecord(d));
  const store = {}; for (const [p, t] of b.files()) store[`https://abcdstore1.public.blob.vercel-storage.com/bulk/lu/v/${p}`] = t;
  store['https://abcdstore1.public.blob.vercel-storage.com/bulk/lu/manifest.json'] = JSON.stringify({ base: 'https://abcdstore1.public.blob.vercel-storage.com/bulk/lu/v', s_buckets: 8, t_layout: 2 });
  const f = async (u) => (store[u] ? { ok: true, status: 200, json: async () => JSON.parse(store[u]), text: async () => store[u] } : { ok: false, status: 404, json: async () => ({}), text: async () => '' });
  index._resetManifests();
  const reg = require('../lib/registers/lu').make({ BLOB_READ_WRITE_TOKEN: TOKEN });
  assert.deepEqual((await reg.search(f, 'b 80587')).map((r) => r.number), ['B80587']);
  const card = await reg.get(f, 'B80587');
  assert.equal(card.situations[0].label, 'Negative equity');
  assert.deepEqual(card.financials, { year: '2023', revenue: null, net_result: 46909, currency: 'EUR' });
});
