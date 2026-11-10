// Offline tests: run with `node --test tests/lookup.test.js`.
// Fixtures follow the documented Companies House, GLEIF and RDAP response shapes.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHandlers, normaliseNumber } = require('../lib/handlers');
const { monthsBetween, parseDate, ownershipBands } = require('../lib/card');
const { normaliseDomain } = require('../lib/sources');

const NOW = new Date('2026-11-07T12:00:00Z');

function baseProfile(over = {}) {
  return {
    company_name: 'EXAMPLE TRADING LIMITED', company_number: '01234567', company_status: 'active',
    type: 'ltd', jurisdiction: 'england-wales', date_of_creation: '2010-03-15',
    registered_office_address: { address_line_1: '1 High Street', locality: 'London', postal_code: 'EC1A 1AA', country: 'England' },
    sic_codes: ['46900'], has_charges: false, has_insolvency_history: false,
    accounts: { next_due: '2027-09-30', overdue: false, last_accounts: { made_up_to: '2025-12-31', type: 'full' } },
    confirmation_statement: { next_due: '2027-03-29', overdue: false },
    ...over,
  };
}

function json(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// Router-based fake fetch. routes: { substring: response | (url) => response }
function fakeFetch(routes, calls = []) {
  return async (url, opts) => {
    calls.push({ url, opts });
    for (const [k, v] of Object.entries(routes)) {
      if (url.includes(k)) return typeof v === 'function' ? v(url) : v;
    }
    return json(404, {});
  };
}

function defaultRoutes(profile, extra = {}) {
  // Routes in `extra` are matched first and replace defaults with the same key.
  const defaults = baseRoutes(profile);
  const out = { ...extra };
  for (const [k, v] of Object.entries(defaults)) if (!(k in out)) out[k] = v;
  return out;
}

function baseRoutes(profile) {
  return {
    '/officers': json(200, { items: [
      { name: 'SMITH, Jane', officer_role: 'director', appointed_on: '2015-01-01' },
      { name: 'OLD, Bob', officer_role: 'director', appointed_on: '2010-03-15', resigned_on: '2014-01-01' },
    ] }),
    '/persons-with-significant-control': json(200, { items: [
      { name: 'Ms Jane Smith', kind: 'individual-person-with-significant-control', natures_of_control: ['ownership-of-shares-75-to-100-percent', 'voting-rights-75-to-100-percent'] },
      { kind: 'persons-with-significant-control-statement' },
    ] }),
    'api.gleif.org': json(200, { data: [] }),
    [`/company/${profile.company_number}`]: json(200, profile),
  };
}


function mockRes() {
  return {
    statusCode: 0, headers: {}, body: null,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(b) { this.body = JSON.parse(b); },
  };
}
const req = (query) => ({ method: 'GET', query, headers: { 'x-forwarded-for': '10.0.0.' + Math.floor(Math.random() * 250) } });

async function lookup(profile, { extra = {}, query = {}, env = { COMPANIES_HOUSE_API_KEY: 'test-key' }, calls = [] } = {}) {
  const { company } = createHandlers({ fetchFn: fakeFetch(defaultRoutes(profile, extra), calls), env, now: () => NOW });
  const res = mockRes();
  await company(req({ number: profile.company_number, ...query }), res);
  return res;
}
const labels = (res) => res.body.flags.map((f) => f.label);

test('clean, established company: no flags, verdict clear', async () => {
  const res = await lookup(baseProfile());
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.verdict, 'clear');
  assert.deepEqual(res.body.flags, []);
  assert.equal(res.body.identity.age, '16 years, 7 months');
  assert.equal(res.body.people.officers.length, 1, 'resigned officers are left out');
  assert.deepEqual(res.body.people.owners[0].control, ['Shares 75–100%', 'Votes 75–100%']);
  assert.equal(res.body.people.owners.length, 1, 'PSC statements are not owners');
  assert.match(res.headers['cache-control'], /s-maxage=21600/);
});

test('Companies House key is sent as Basic auth username', async () => {
  const calls = [];
  await lookup(baseProfile(), { calls });
  const ch = calls.find((c) => c.url.includes('company-information'));
  assert.equal(ch.opts.headers.Authorization, 'Basic ' + Buffer.from('test-key:').toString('base64'));
  const gl = calls.find((c) => c.url.includes('gleif'));
  assert.equal(gl.opts.headers.Authorization, undefined, 'key never goes to other sources');
});

test('dissolved company: Stop', async () => {
  const res = await lookup(baseProfile({ company_status: 'dissolved', date_of_cessation: '2024-02-01' }));
  assert.equal(res.body.verdict, 'stop');
  assert.ok(labels(res).includes('Not active'));
});

test('strike-off proposed: Stop', async () => {
  const res = await lookup(baseProfile({ company_status_detail: 'active-proposal-to-strike-off' }));
  assert.deepEqual(labels(res), ['Strike-off proposed']);
});

test('insolvency history: Stop with case type', async () => {
  const p = baseProfile({ has_insolvency_history: true, company_status: 'liquidation' });
  const res = await lookup(p, { extra: { '/insolvency': json(200, { cases: [{ type: 'creditors-voluntary-liquidation' }] }) } });
  assert.ok(labels(res).includes('Insolvency history'));
  assert.match(res.body.flags.find((f) => f.label === 'Insolvency history').detail, /Creditors voluntary liquidation/);
  assert.equal(res.body.flags[0].level, 'stop');
});

test('young company boundary: 23 months flags, 24 months does not', async () => {
  let res = await lookup(baseProfile({ date_of_creation: '2024-12-07' }));
  assert.ok(labels(res).includes('Young company'));
  res = await lookup(baseProfile({ date_of_creation: '2024-11-07' }));
  assert.ok(!labels(res).includes('Young company'));
});

test('accounts overdue: by register flag or by past due date', async () => {
  let res = await lookup(baseProfile({ accounts: { overdue: true, next_due: '2026-09-30' } }));
  assert.ok(labels(res).includes('Accounts overdue'));
  res = await lookup(baseProfile({ accounts: { overdue: false, next_due: '2026-10-01' } }));
  assert.ok(labels(res).includes('Accounts overdue'));
  assert.equal(res.body.next_step.startsWith('Ask the company'), true);
});

test('recent name change flags; an old one does not', async () => {
  let res = await lookup(baseProfile({ previous_company_names: [{ name: 'OLD NAME LTD', effective_from: '2010-03-15', ceased_on: '2026-05-01' }] }));
  assert.ok(labels(res).includes('Recent name change'));
  res = await lookup(baseProfile({ previous_company_names: [{ name: 'OLD NAME LTD', effective_from: '2010-03-15', ceased_on: '2019-05-01' }] }));
  assert.ok(!labels(res).includes('Recent name change'));
});

test('new secured lending is a Note; satisfied charges are not outstanding', async () => {
  const p = baseProfile({ has_charges: true });
  const res = await lookup(p, { extra: { '/charges': json(200, { items: [
    { status: 'outstanding', created_on: '2026-06-01', persons_entitled: [{ name: 'Big Bank PLC' }] },
    { status: 'fully-satisfied', created_on: '2026-07-01', persons_entitled: [{ name: 'Old Lender' }] },
    { status: 'outstanding', created_on: '2015-01-01', persons_entitled: [{ name: 'Big Bank PLC' }] },
  ] }) } });
  assert.equal(res.body.charges.outstanding, 2);
  assert.equal(res.body.charges.total, 3);
  assert.deepEqual(res.body.charges.lenders, ['Big Bank PLC']);
  assert.deepEqual(res.body.flags, [{ level: 'note', label: 'New secured lending', detail: '1 charge registered in the last 12 months.', source: 'Companies House' }]);
  assert.equal(res.body.verdict, 'clear', 'a note alone does not change the verdict');
});

test('new website domain flags from RDAP', async () => {
  const res = await lookup(baseProfile(), {
    query: { website: 'https://www.Example-Trading.co.uk/about' },
    extra: { 'rdap.org/domain/example-trading.co.uk': json(200, { events: [{ eventAction: 'registration', eventDate: '2026-08-01T10:00:00Z' }] }) },
  });
  assert.equal(res.body.web.domain, 'example-trading.co.uk');
  assert.ok(labels(res).includes('New website domain'));
});

test('GLEIF parents are shown', async () => {
  const lei = '5493001KJTIIGC8Y1R12';
  const res = await lookup(baseProfile(), { extra: {
    [`lei-records/${lei}/direct-parent`]: json(200, { data: { attributes: { lei: 'P1', entity: { legalName: { name: 'Parent Holdings Ltd' }, legalAddress: { country: 'GB' } } } } }),
    [`lei-records/${lei}/ultimate-parent`]: json(404, {}),
    [`lei-records/${lei}`]: json(200, { data: { attributes: { lei, entity: { legalName: { name: 'EXAMPLE TRADING LIMITED' }, status: 'ACTIVE', legalAddress: { country: 'GB' }, registeredAs: '01234567' }, registration: { status: 'ISSUED' } } } }),
    'api.gleif.org/api/v1/lei-records?': json(200, { data: [{ attributes: { lei, entity: { legalName: { name: 'EXAMPLE TRADING LIMITED' }, status: 'ACTIVE' }, registration: { status: 'ISSUED' } } }] }),
  } });
  assert.equal(res.body.group.lei, lei);
  assert.equal(res.body.group.direct_parent.name, 'Parent Holdings Ltd');
  assert.equal(res.body.group.ultimate_parent, null);
});

test('a failing optional source becomes a gap, not a flag, and the card still builds', async () => {
  const res = await lookup(baseProfile(), { extra: { '/officers': json(500, {}), 'api.gleif.org': json(503, {}) } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.people.officers, null);
  assert.ok(res.body.gaps.some((g) => /Officers/.test(g)));
  assert.ok(res.body.gaps.some((g) => /GLEIF/.test(g)));
  assert.deepEqual(res.body.flags, []);
});

test('unknown company number: 404 Not on the register', async () => {
  const { company } = createHandlers({ fetchFn: fakeFetch({}), env: { COMPANIES_HOUSE_API_KEY: 'k' }, now: () => NOW });
  const res = mockRes();
  await company(req({ number: '99999999' }), res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.flag, 'Not on the register');
});

test('bad input is refused before any call; UK lookups need the key', async () => {
  const calls = [];
  const h1 = createHandlers({ fetchFn: fakeFetch({}, calls), env: { COMPANIES_HOUSE_API_KEY: 'k' }, now: () => NOW });
  let res = mockRes(); await h1.company(req({ number: '../etc' }), res); assert.equal(res.statusCode, 400);
  res = mockRes(); await h1.company(req({ id: 'lei:NOTANLEI' }), res); assert.equal(res.statusCode, 400);
  res = mockRes(); await h1.company(req({ id: 'xx:123' }), res); assert.equal(res.statusCode, 400);
  res = mockRes(); await h1.company(req({ number: '01234567', website: 'not a site' }), res); assert.equal(res.statusCode, 400);
  res = mockRes(); await h1.search(req({ q: 'a' }), res); assert.equal(res.statusCode, 400);
  res = mockRes(); await h1.search(req({ q: 'tesco', country: 'GBR' }), res); assert.equal(res.statusCode, 400);
  const h2 = createHandlers({ fetchFn: fakeFetch({}, calls), env: {}, now: () => NOW });
  res = mockRes(); await h2.company(req({ id: 'gb:01234567' }), res); assert.equal(res.statusCode, 500);
  assert.equal(calls.length, 0);
});

test('search: all sources down gives 502; one down gives partial results with a warning', async () => {
  let h = createHandlers({ fetchFn: fakeFetch({}), env: { COMPANIES_HOUSE_API_KEY: 'k' }, now: () => NOW });
  let res = mockRes(); await h.search(req({ q: 'tesco' }), res);
  assert.equal(res.statusCode, 502);
  h = createHandlers({ fetchFn: fakeFetch({ '/search/companies': json(200, { items: [{ title: 'TESCO PLC', company_number: '00445790', company_status: 'active' }] }) }), env: { COMPANIES_HOUSE_API_KEY: 'k' }, now: () => NOW });
  res = mockRes(); await h.search(req({ q: 'tesco' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.results.length, 1);
  assert.match(res.body.warnings[0], /GLEIF/);
  assert.equal(res.headers['cache-control'], 'no-store', 'partial results are not cached');
});

const gl = (lei, name, country, extra = {}) => ({ attributes: { lei, entity: { legalName: { name }, legalAddress: { country, city: 'X' }, status: 'ACTIVE', ...extra }, registration: { status: 'ISSUED' } } });

test('search: GLEIF works with no Companies House key, passes the country filter', async () => {
  const calls = [];
  const { search } = createHandlers({ fetchFn: fakeFetch({ 'filter%5Bfulltext%5D=siemens': json(200, { data: [gl('W38RGI023J3WT1HWRP32', 'Siemens Aktiengesellschaft', 'DE', { registeredAs: 'HRB 6684' })] }) }, calls), env: {}, now: () => NOW });
  const res = mockRes(); await search(req({ q: 'siemens', country: 'de' }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.results[0], { id: 'lei:W38RGI023J3WT1HWRP32', source: 'GLEIF', name: 'Siemens Aktiengesellschaft', country: 'DE', city: 'X', status: 'active', number: 'HRB 6684', lei: 'W38RGI023J3WT1HWRP32' });
  assert.ok(calls[0].url.includes('filter%5Bentity.legalAddress.country%5D=DE'));
  assert.ok(!calls.some((c) => c.url.includes('company-information')));
});

test('search: fuzzy fallback when full-text finds nothing', async () => {
  const lei = '213800ABCDEFGHIJKL12';
  const { search } = createHandlers({ fetchFn: fakeFetch({
    'filter%5Bfulltext%5D': json(200, { data: [] }),
    '/fuzzycompletions': json(200, { data: [{ attributes: { value: 'NORTHWIND LTD' }, relationships: { 'lei-records': { data: { type: 'lei-records', id: lei } } } }] }),
    'filter%5Blei%5D=': json(200, { data: [gl(lei, 'NORTHWIND LTD', 'IE')] }),
  }), env: {}, now: () => NOW });
  const res = mockRes(); await search(req({ q: 'nortwind' }), res);
  assert.equal(res.body.results[0].name, 'NORTHWIND LTD');
});

test('search: UK results merge with GLEIF without duplicates', async () => {
  const { search } = createHandlers({ fetchFn: fakeFetch({
    'filter%5Bfulltext%5D': json(200, { data: [gl('2138002P5RNKC5W2JZ46', 'TESCO PLC', 'GB', { registeredAs: '00445790' })] }),
    '/search/companies?q=tesco': json(200, { items: [
      { title: 'TESCO PLC', company_number: '00445790', company_status: 'active', date_of_creation: '1947-11-27', address_snippet: 'Welwyn Garden City' },
      { title: 'TESCO STORES LIMITED', company_number: '00519500', company_status: 'active', date_of_creation: '1953-07-29', address_snippet: 'Welwyn Garden City' },
    ] }),
  }), env: { COMPANIES_HOUSE_API_KEY: 'k' }, now: () => NOW });
  const res = mockRes(); await search(req({ q: 'tesco', country: 'GB' }), res);
  assert.deepEqual(res.body.results.map((r) => r.id), ['lei:2138002P5RNKC5W2JZ46', 'gb:00519500'], 'exact name first');
});

function gleifCompany(lei, entity, registration = { status: 'ISSUED' }) {
  return { [`lei-records/${lei}/direct-parent`]: json(404, {}), [`lei-records/${lei}/ultimate-parent`]: json(404, {}),
    [`lei-records/${lei}`]: json(200, { data: { attributes: { lei, ocid: 'de/K1101R_HRB6684', entity, registration } } }) };
}
async function leiLookup(lei, entity, registration, env = {}, extraRoutes = {}) {
  // Extra routes are matched first and replace defaults with the same key.
  const base = gleifCompany(lei, entity, registration);
  const routes = { ...extraRoutes };
  for (const [k, v] of Object.entries(base)) if (!(k in routes)) routes[k] = v;
  const { company } = createHandlers({ fetchFn: fakeFetch(routes), env, now: () => NOW });
  const res = mockRes(); await company(req({ id: `lei:${lei}` }), res);
  return res;
}

test('LEI card outside the UK: identity from GLEIF, national register gap', async () => {
  const lei = 'W38RGI023J3WT1HWRP32';
  const res = await leiLookup(lei, { legalName: { name: 'Siemens Aktiengesellschaft' }, otherNames: [{ name: 'Siemens AG' }], status: 'ACTIVE',
    legalAddress: { addressLines: ['Werner-von-Siemens-Straße 1'], city: 'München', postalCode: '80333', country: 'DE' }, headquartersAddress: { addressLines: ['Werner-von-Siemens-Straße 1'], city: 'München', postalCode: '80333', country: 'DE' },
    registeredAs: 'HRB 6684', registeredAt: { id: 'RA000304' }, legalForm: { id: 'ZHED' }, creationDate: '1897-10-12T00:00:00Z' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.verdict, 'clear');
  assert.equal(res.body.identity.country, 'DE');
  assert.equal(res.body.identity.hq_address, null, 'same HQ is not repeated');
  assert.deepEqual(res.body.identity.other_names, ['Siemens AG']);
  assert.equal(res.body.identity.register.number, 'HRB 6684');
  assert.equal(res.body.ids.opencorporates, 'https://opencorporates.com/companies/de/K1101R_HRB6684');
  assert.equal(res.body.people, null);
  assert.ok(res.body.gaps.some((g) => /national register for DE is not connected/.test(g)));
  assert.equal(res.body.id, `lei:${lei}`);
});

test('LEI flags: inactive, successor, lapsed LEI, HQ abroad, young company', async () => {
  const lei = '5299000ABCDEFGHIJ012';
  const res = await leiLookup(lei, { legalName: { name: 'Shellco BV' }, status: 'INACTIVE', expiration: { date: '2026-05-01', reason: 'CORPORATE_ACTION' },
    successorEntity: { lei: '529900ZZZZZZZZZZZZ99', name: 'Bigco NV' }, legalAddress: { country: 'NL' }, headquartersAddress: { country: 'CY' }, creationDate: '2025-06-01' },
    { status: 'LAPSED', nextRenewalDate: '2026-06-01T00:00:00Z' });
  const byLabel = Object.fromEntries(res.body.flags.map((f) => [f.label, f.level]));
  assert.deepEqual(byLabel, { 'Not active': 'stop', 'Succeeded by another entity': 'check', 'Young company': 'check', 'LEI not renewed': 'note', 'Headquartered in another country': 'note' });
  assert.equal(res.body.flags[0].label, 'Not active');
  assert.match(res.body.flags[0].detail, /Corporate action, 2026-05-01/);
});

test('UK LEI is enriched from Companies House; the register wins and flags are not doubled', async () => {
  const lei = '2138002P5RNKC5W2JZ46';
  const res = await leiLookup(lei, { legalName: { name: 'TESCO PLC' }, status: 'INACTIVE', legalAddress: { country: 'GB' }, registeredAs: '445790' }, undefined,
    { COMPANIES_HOUSE_API_KEY: 'k' },
    { '/company/00445790/officers': json(200, { items: [] }), '/company/00445790/persons': json(200, { items: [] }),
      '/company/00445790': json(200, baseProfile({ company_name: 'TESCO PLC', company_number: '00445790', company_status: 'dissolved' })) });
  assert.equal(res.body.identity.register.name, 'Companies House (UK)');
  assert.deepEqual(res.body.flags.map((f) => f.label), ['Not active']);
  assert.equal(res.body.flags[0].source, 'Companies House');
  assert.ok(res.body.people);
});

test('UK LEI without a key: card still builds from GLEIF', async () => {
  const lei = '2138002P5RNKC5W2JZ46';
  const res = await leiLookup(lei, { legalName: { name: 'TESCO PLC' }, status: 'ACTIVE', legalAddress: { country: 'GB' }, registeredAs: '00445790' });
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.gaps.some((g) => /not connected/.test(g)));
});

test('unknown LEI: 404', async () => {
  const { company } = createHandlers({ fetchFn: fakeFetch({}), env: {}, now: () => NOW });
  const res = mockRes(); await company(req({ id: 'lei:5299000ABCDEFGHIJ012' }), res);
  assert.equal(res.statusCode, 404);
});

test('rate limit kicks in per visitor', async () => {
  const { search } = createHandlers({ fetchFn: fakeFetch({ '/search/companies': json(200, { items: [] }) }), env: { COMPANIES_HOUSE_API_KEY: 'k' }, now: () => NOW });
  let last;
  for (let i = 0; i < 41; i++) { last = mockRes(); await search({ method: 'GET', query: { q: 'abc' }, headers: { 'x-forwarded-for': '1.2.3.4' } }, last); }
  assert.equal(last.statusCode, 429);
});

test('helpers', () => {
  assert.equal(normaliseNumber('445790'), '00445790');
  assert.equal(normaliseNumber('sc 123456'), 'SC123456');
  assert.equal(normaliseNumber('123456789'), null);
  assert.equal(normaliseDomain('HTTP://www.foo.co.uk:8080/x?y'), 'foo.co.uk');
  assert.equal(normaliseDomain('localhost'), null);
  assert.equal(monthsBetween(parseDate('2024-01-31'), parseDate('2024-02-29')), 0);
  assert.equal(monthsBetween(parseDate('2024-01-31'), parseDate('2024-03-31')), 2);
  assert.deepEqual(ownershipBands(['ownership-of-shares-25-to-50-percent-as-trust', 'right-to-appoint-and-remove-directors']), ['Shares 25–50%', 'Appoints directors']);
});

test('GLEIF ranking puts the exact company first', () => {
  const { rank, normName } = require('../lib/gleif');
  const r = (name, status = 'ACTIVE', category = 'GENERAL') => ({ attributes: { lei: name, entity: { legalName: { name }, status, category } } });
  const order = rank([
    r('Siemens Advanta Solutions GmbH'), r('Siemens High Yield', 'ACTIVE', 'FUND'), r('SHC Trust e.V.'),
    r('Siemens Beteiligungen Europa GmbH', 'INACTIVE'), r('Siemens Aktiengesellschaft'), r('Valentin Siemens Verpachtungs UG'),
  ], 'siemens').map((x) => x.attributes.lei);
  assert.equal(order[0], 'Siemens Aktiengesellschaft');
  assert.equal(order[order.length - 1], 'SHC Trust e.V.');
  assert.ok(order.indexOf('Siemens High Yield') > order.indexOf('Siemens Advanta Solutions GmbH'), 'funds after companies');
  assert.equal(normName('Société Générale S.A.'), 'societe generale');
});

// ---------- national registers (fixtures trimmed from real responses, Nov 2026) ----------

const FR_MICHELIN = { siren: '424622884', nom_complet: 'MICHELIN', nom_raison_sociale: 'MICHELIN', sigle: null,
  siege: { adresse: 'LE CLOS GUERIN 74540 GRUFFY', libelle_commune: 'GRUFFY', nom_commercial: null },
  activite_principale: '68.20B', categorie_entreprise: null, date_creation: '1999-08-27', date_fermeture: null,
  dirigeants: [{ nom: 'MICHELIN', prenoms: 'DENIS', annee_de_naissance: '1958', qualite: 'Gérant', type_dirigeant: 'personne physique' }],
  etat_administratif: 'A', nature_juridique: '6540', tranche_effectif_salarie: 'NN', finances: null, complements: { est_entrepreneur_individuel: false } };

async function natLookup(id, routes, env = {}) {
  const { company } = createHandlers({ fetchFn: fakeFetch({ 'api.gleif.org': json(200, { data: [] }), ...routes }), env, now: () => NOW });
  const res = mockRes(); await company(req({ id }), res);
  return res;
}

test('France: search maps SIREN results; card shows officers, VAT number, no birth dates', async () => {
  const { search } = createHandlers({ fetchFn: fakeFetch({ 'recherche-entreprises': json(200, { results: [FR_MICHELIN] }), 'api.gleif.org': json(200, { data: [] }) }), env: {}, now: () => NOW });
  let res = mockRes(); await search(req({ q: 'michelin', country: 'FR' }), res);
  assert.deepEqual(res.body.results[0], { id: 'fr:424622884', source: 'French business register', name: 'MICHELIN', country: 'FR', city: 'GRUFFY', status: 'active', number: '424622884', incorporated: '1999-08-27' });
  res = await natLookup('fr:424 622 884', { 'recherche-entreprises': json(200, { results: [{ ...FR_MICHELIN, finances: { 2023: { ca: 1000, resultat_net: 10 }, 2024: { ca: 1200, resultat_net: -5 } } }] }) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.identity.register.number, '424622884');
  assert.equal(res.body.identity.legal_form, 'SCI (property company)');
  assert.equal(res.body.identity.vat.number, 'FR62424622884');
  assert.deepEqual(res.body.people.officers, [{ name: 'DENIS MICHELIN', role: 'Gérant' }]);
  assert.ok(!JSON.stringify(res.body).includes('1958'), 'birth years are never shown');
  assert.deepEqual(res.body.financials, { year: '2024', revenue: 1200, net_result: -5, currency: 'EUR' });
  assert.equal(res.body.verdict, 'clear');
  assert.equal(res.body.id, 'fr:424622884');
});

test('France: ceased company is Stop; sole trader hides people', async () => {
  let res = await natLookup('fr:424622884', { 'recherche-entreprises': json(200, { results: [{ ...FR_MICHELIN, etat_administratif: 'C', date_fermeture: '2025-01-31' }] }) });
  assert.equal(res.body.flags[0].label, 'Not active');
  res = await natLookup('fr:424622884', { 'recherche-entreprises': json(200, { results: [{ ...FR_MICHELIN, nature_juridique: '1000' }] }) });
  assert.equal(res.body.people, null);
  assert.ok(res.body.flags.some((f) => f.label === 'Sole trader'));
});

const NO_EQUINOR = { organisasjonsnummer: '923609016', navn: 'EQUINOR ASA', antallAnsatte: 21231, harRegistrertAntallAnsatte: true,
  forretningsadresse: { adresse: ['Forusbeen 50'], postnummer: '4035', poststed: 'STAVANGER', land: 'Norge' },
  historiskeNavn: [{ navn: 'STATOIL ASA', tilDato: '2018-05-16 07:05:45' }], hjemmeside: 'www.equinor.com', konkurs: false,
  naeringskode1: { beskrivelse: 'Utvinning av råolje', kode: '06.100' }, organisasjonsform: { beskrivelse: 'Allmennaksjeselskap', kode: 'ASA' },
  registrertIMvaregisteret: true, sisteInnsendteAarsregnskap: '2025', stiftelsesdato: '1972-09-18', underAvvikling: false, underTvangsavviklingEllerTvangsopplosning: false };
const NO_ROLES = { rollegrupper: [
  { type: { kode: 'DAGL' }, roller: [{ avregistrert: false, person: { fodselsdato: '1968-05-04', navn: { fornavn: 'Anders', etternavn: 'Opedal' } }, type: { kode: 'DAGL', beskrivelse: 'Daglig leder' } }] },
  { type: { kode: 'STYR' }, roller: [
    { avregistrert: false, person: { navn: { fornavn: 'Jarle Kjell', etternavn: 'Roth' } }, type: { kode: 'LEDE', beskrivelse: 'Styrets leder' } },
    { avregistrert: true, person: { navn: { fornavn: 'Finn', etternavn: 'Ruyter' } }, type: { kode: 'MEDL', beskrivelse: 'Styremedlem' } }] },
  { type: { kode: 'REVI' }, roller: [{ avregistrert: false, enhet: { navn: ['ERNST & YOUNG AS'], organisasjonsnummer: '976389387' }, type: { kode: 'REVI', beskrivelse: 'Revisor' } }] },
] };

test('Norway: roles in English, auditor, no birth dates, accounts up to date', async () => {
  const res = await natLookup('no:923 609 016', { '/enheter/923609016/roller': json(200, NO_ROLES), '/enheter/923609016': json(200, NO_EQUINOR) });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.people.officers, [{ name: 'Anders Opedal', role: 'CEO' }, { name: 'Jarle Kjell Roth', role: 'Chair' }]);
  assert.equal(res.body.identity.auditor, 'ERNST & YOUNG AS');
  assert.equal(res.body.identity.vat.number, 'NO923609016MVA');
  assert.ok(!JSON.stringify(res.body).includes('1968'));
  assert.equal(res.body.verdict, 'clear');
  assert.match(res.body.next_step, /2025/);
});

test('Norway: bankruptcy is Stop; overdue accounts is Check', async () => {
  const res = await natLookup('no:923609016', { '/enheter/923609016/roller': json(200, { rollegrupper: [] }),
    '/enheter/923609016': json(200, { ...NO_EQUINOR, konkurs: true, sisteInnsendteAarsregnskap: '2023' }) });
  const byLabel = Object.fromEntries(res.body.flags.map((f) => [f.label, f.level]));
  assert.equal(byLabel.Bankruptcy, 'stop');
  assert.equal(byLabel['Accounts overdue'], 'check');
  const { accountsExpectedYear } = require('../lib/registers/no');
  assert.equal(accountsExpectedYear('2026-07-31'), 2024);
  assert.equal(accountsExpectedYear('2026-08-01'), 2025);
});

const FI_KONE = { businessId: { value: '1927400-1', registrationDate: '2004-11-01' },
  names: [{ name: 'KONE Oyj', type: '1', registrationDate: '2005-06-01' }, { name: 'Kone Engineering', type: '3' }, { name: 'KONE Corporation', type: '2' }],
  mainBusinessLine: { type: '28220', descriptions: [{ languageCode: '3', description: 'Manufacture of lifting and handling equipment' }] },
  companyForms: [{ type: '17', descriptions: [{ languageCode: '3', description: 'Public limited company' }] }], companySituations: [],
  registeredEntries: [{ type: '80', register: '6', registrationDate: '2005-06-01' }],
  addresses: [{ type: 1, street: 'Kartanontie', buildingNumber: '1', postCode: '00330', postOffices: [{ city: 'HELSINKI', languageCode: '1' }] }],
  tradeRegisterStatus: '1', status: '2', registrationDate: '2005-06-01' };

test('Finland: card from PRH, VAT registered, situations become Stop flags', async () => {
  let res = await natLookup('fi:1927400-1', { 'opendata-ytj-api/v3/companies?businessId': json(200, { companies: [FI_KONE] }) });
  assert.equal(res.body.identity.legal_name, 'KONE Oyj');
  assert.deepEqual(res.body.identity.other_names, ['Kone Engineering', 'KONE Corporation']);
  assert.equal(res.body.identity.registered_address, 'Kartanontie 1, 00330 HELSINKI, Finland');
  assert.deepEqual(res.body.identity.vat, { number: 'FI19274001', registered: true });
  assert.equal(res.body.verdict, 'clear');
  res = await natLookup('fi:19274001', { 'opendata-ytj-api/v3/companies?businessId': json(200, { companies: [{ ...FI_KONE,
    companySituations: [{ type: 'KONK', registrationDate: '2026-09-01', descriptions: [{ languageCode: '3', description: 'Bankruptcy' }] }] }] }) });
  assert.deepEqual(res.body.flags[0], { level: 'stop', label: 'Bankruptcy', detail: 'The register shows "Bankruptcy" since 2026-09-01.', source: 'Finnish Trade Register (PRH / YTJ)' });
});

test('Estonia: autocomplete record, liquidation is Stop', async () => {
  const rec = { company_id: 9000226987, reg_code: 14532901, name: 'Bolt Operations OÜ', historical_names: ['Billify OÜ'], status: 'L',
    legal_address: 'Harju maakond, Tallinn, Kesklinna linnaosa, Vana-Lõuna tn 15', zip_code: '10134', url: 'https://ariregister.rik.ee/est/company/14532901/Bolt-Operations-OÜ' };
  const res = await natLookup('ee:14532901', { 'ariregister.rik.ee': json(200, { status: 'OK', data: [rec] }) });
  assert.equal(res.body.identity.legal_form, 'Private limited company (OÜ)');
  assert.deepEqual(res.body.identity.former_names, [{ name: 'Billify OÜ', to: null }]);
  assert.equal(res.body.flags[0].label, 'In liquidation');
});

test('Czechia: search uses POST; insolvency register entry is Stop', async () => {
  const calls = [];
  const skoda = { ico: '00177041', obchodniJmeno: 'Škoda Auto a.s.', sidlo: { nazevObce: 'Mladá Boleslav', textovaAdresa: 'tř. Václava Klementa 869, Mladá Boleslav II, 29301 Mladá Boleslav', nazevStatu: 'Česká republika' },
    pravniForma: '121', datumVzniku: '1990-11-20', dic: 'CZ00177041', czNace: ['70200', '00', '29100'],
    seznamRegistraci: { stavZdrojeVr: 'AKTIVNI', stavZdrojeDph: 'AKTIVNI', stavZdrojeIr: 'NEEXISTUJICI' }, dalsiUdaje: [{ datovyZdroj: 'vr', spisovaZnacka: 'B 332/MSPH' }] };
  const { search } = createHandlers({ fetchFn: fakeFetch({ '/vyhledat': json(200, { pocetCelkem: 1, ekonomickeSubjekty: [skoda] }), 'api.gleif.org': json(200, { data: [] }) }, calls), env: {}, now: () => NOW });
  let res = mockRes(); await search(req({ q: 'skoda auto', country: 'CZ' }), res);
  assert.equal(res.body.results[0].id, 'cz:00177041');
  const post = calls.find((c) => c.url.includes('/vyhledat'));
  assert.equal(post.opts.method, 'POST');
  assert.deepEqual(JSON.parse(post.opts.body), { obchodniJmeno: 'skoda auto', start: 0, pocet: 15 });
  res = await natLookup('cz:177041', { 'ekonomicke-subjekty/00177041': json(200, skoda) });
  assert.equal(res.body.identity.legal_form, 'Joint-stock company (a.s.)');
  assert.deepEqual(res.body.identity.industry, ['70200 (CZ-NACE)', '29100 (CZ-NACE)']);
  assert.equal(res.body.verdict, 'clear');
  res = await natLookup('cz:00177041', { 'ekonomicke-subjekty/00177041': json(200, { ...skoda, seznamRegistraci: { stavZdrojeIr: 'AKTIVNI' } }) });
  assert.equal(res.body.flags[0].label, 'Insolvency register entry');
});

test('register hit replaces the matching GLEIF hit and carries its LEI', async () => {
  const { search } = createHandlers({ fetchFn: fakeFetch({
    'recherche-entreprises': json(200, { results: [FR_MICHELIN] }),
    'api.gleif.org': json(200, { data: [{ attributes: { lei: '969500XXXXXXXXXXXX12', entity: { legalName: { name: 'MICHELIN' }, legalAddress: { country: 'FR' }, status: 'ACTIVE', registeredAs: '424 622 884' } } }] }),
  }), env: {}, now: () => NOW });
  const res = mockRes(); await search(req({ q: 'michelin', country: 'FR' }), res);
  assert.equal(res.body.results.length, 1);
  assert.equal(res.body.results[0].lei, '969500XXXXXXXXXXXX12');
});

test('LEI card for a French company pulls the French register', async () => {
  const lei = '969500XXXXXXXXXXXX12';
  const res = await leiLookup(lei, { legalName: { name: 'MICHELIN' }, status: 'ACTIVE', legalAddress: { country: 'FR' }, registeredAs: '424622884' }, undefined, {},
    { 'recherche-entreprises': json(200, { results: [FR_MICHELIN] }) });
  assert.equal(res.body.identity.register.name, 'French business register (SIRENE / RNE)');
  assert.ok(res.body.people);
  assert.ok(!res.body.gaps.some((g) => /not connected/.test(g)));
});

test('results from register and GLEIF are ranked together', async () => {
  const fi = (id, name, active = true) => ({ businessId: { value: id, registrationDate: '1978-03-15' }, names: [{ name, type: '1' }], tradeRegisterStatus: active ? '1' : '4', ...(active ? {} : { endDate: '2001-01-01' }) });
  const { search } = createHandlers({ fetchFn: fakeFetch({
    'opendata-ytj-api': json(200, { companies: [fi('0100126-7', 'Huvilakartano Kommandiittiyhtiö Ikonen', false), fi('0103193-3', 'Tekno-Kone Oy', false), fi('0100761-8', 'Laitoskone Oy')] }),
    'filter%5Bfulltext%5D': json(200, { data: [
      { attributes: { lei: '2138001GUCIPEDLMDU97', entity: { legalName: { name: 'KONE HISSIT OY' }, legalAddress: { country: 'FI' }, status: 'ACTIVE', registeredAs: '1904292-1' } } },
      { attributes: { lei: '2138001CNF45JP5XZK38', entity: { legalName: { name: 'KONE OYJ' }, legalAddress: { country: 'FI' }, status: 'ACTIVE', registeredAs: '1927400-1' } } }] }),
  }), env: {}, now: () => NOW });
  const res = mockRes(); await search(req({ q: 'kone', country: 'FI' }), res);
  assert.deepEqual(res.body.results.slice(0, 2).map((r) => r.name), ['KONE OYJ', 'KONE HISSIT OY']);
  assert.equal(res.body.results[res.body.results.length - 1].name, 'Huvilakartano Kommandiittiyhtiö Ikonen');
});

// ---------- Wikidata (fixture from a real response, Nov 2026) ----------
const WD_EQUINOR = { head: {}, results: { bindings: [{
  item: { value: 'http://www.wikidata.org/entity/Q1776022' }, label: { value: 'Equinor ASA' }, article: { value: 'https://en.wikipedia.org/wiki/Equinor' },
  websites: { value: 'https://equinor.ar|https://equinor.ar/en|https://equinor.co.kr|https://equinor.com|https://equinor.no|https://equinorstorage.de/en' },
  founded: { value: '2007-10-01T00:00:00Z' }, hqs: { value: 'Stavanger@NO' }, industries: { value: 'petroleum industry' },
  emps: { value: '20000@2019-10-01T00:00:00Z|18000@2016-01-01T00:00:00Z' }, listings: { value: 'New York Stock Exchange@EQNR|Oslo Stock Exchange@EQNR' },
}] } };

test('Wikidata: query matches only by identifiers, escapes input, and parses', () => {
  const wd = require('../lib/wikidata');
  const q = wd.buildQuery({ lei: 'OW6OFBNCKXC4US5C7523', country: 'NO', number: '923609016' });
  assert.match(q, /wdt:P1278 "OW6OFBNCKXC4US5C7523"/);
  assert.match(q, /wdt:P2333 "923609016"/);
  assert.equal(wd.buildQuery({ lei: 'bad"lei', country: 'DE', number: 'HRB 1' }), null, 'no usable identifier, no query');
  assert.ok(!wd.buildQuery({ country: 'GB', number: '1"} ; DROP' }).includes('"} ;'), 'quotes stripped');
  const r = wd.parse(WD_EQUINOR.results.bindings[0], 'NO');
  assert.equal(r.website, 'https://equinor.com');
  assert.deepEqual(r.employees, { count: 20000, as_of: '2019-10-01' });
  assert.deepEqual(r.hq, { city: 'Stavanger', country: 'NO' });
  assert.deepEqual(r.listings, [{ exchange: 'New York Stock Exchange', ticker: 'EQNR' }, { exchange: 'Oslo Stock Exchange', ticker: 'EQNR' }]);
  assert.equal(wd.pickWebsite(['https://acme.de/en', 'https://acme.de'], 'DE'), 'https://acme.de');
});

test('Wikidata enriches the card; its website feeds the domain-age check; failure is only a gap', async () => {
  const calls = [];
  const routes = { 'query.wikidata.org': json(200, WD_EQUINOR), 'rdap.org/domain/equinor.com': json(200, { events: [{ eventAction: 'registration', eventDate: '1997-06-24T00:00:00Z' }] }),
    '/enheter/923609016/roller': json(200, { rollegrupper: [] }), '/enheter/923609016': json(200, { ...NO_EQUINOR, hjemmeside: null }), 'api.gleif.org': json(200, { data: [] }) };
  const { company } = createHandlers({ fetchFn: fakeFetch(routes, calls), env: {}, now: () => NOW });
  let res = mockRes(); await company(req({ id: 'no:923609016' }), res);
  assert.equal(res.body.about.wikipedia, 'https://en.wikipedia.org/wiki/Equinor');
  assert.equal(res.body.identity.website, 'https://equinor.com');
  assert.deepEqual(res.body.web, { domain: 'equinor.com', from: 'Wikidata', registered: '1997-06-24', age: '29 years, 4 months' });
  const wq = calls.find((c) => c.url.includes('query.wikidata.org'));
  assert.match(wq.opts.headers['User-Agent'], /company-lookup/);
  assert.equal(res.body.verdict, 'clear');
  const down = { ...routes, 'query.wikidata.org': json(503, {}) };
  const h2 = createHandlers({ fetchFn: fakeFetch(down), env: {}, now: () => NOW });
  res = mockRes(); await h2.company(req({ id: 'no:923609016' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.about, null);
  assert.ok(res.body.gaps.some((g) => /Wikidata could not be reached/.test(g)));
});

// ---------- VIES and Poland (fixtures trimmed from real responses, Nov 2026) ----------
test('VIES: valid, not valid (Check flag) and unavailable (gap)', async () => {
  const fr = { 'recherche-entreprises': json(200, { results: [FR_MICHELIN] }) };
  let res = await natLookup('fr:424622884', { ...fr, '/ms/FR/vat/62424622884': json(200, { isValid: true, requestDate: '2026-11-08T05:28:11.208Z', userError: 'VALID', name: 'MICHELIN', address: 'LE CLOS GUERIN\n74540 GRUFFY' }) });
  assert.deepEqual(res.body.identity.vat.vies, { valid: true, name: 'MICHELIN', checked: '2026-11-08' });
  assert.equal(res.body.verdict, 'clear');
  res = await natLookup('fr:424622884', { ...fr, '/ms/FR/vat/62424622884': json(200, { isValid: false, requestDate: '2026-11-08T05:28:11.208Z', userError: 'INVALID', name: '---' }) });
  assert.equal(res.body.flags[0].label, 'VAT number not valid');
  res = await natLookup('fr:424622884', { ...fr, '/ms/FR/vat/62424622884': json(200, { isValid: false, userError: 'MS_UNAVAILABLE' }) });
  assert.ok(!res.body.flags.some((f) => f.label === 'VAT number not valid'));
  assert.ok(res.body.gaps.some((g) => /VIES/.test(g)));
  const { split } = require('../lib/vies');
  assert.equal(split('NO923609016MVA'), null, 'non-EU numbers are not sent to VIES');
});

const KRS_ORLEN = { odpis: { naglowekA: { numerKRS: '0000028860', dataRejestracjiWKRS: '19.07.2001' }, dane: {
  dzial1: { danePodmiotu: { formaPrawna: 'SPÓŁKA AKCYJNA', identyfikatory: { regon: '61018820100000', nip: '7740001454' }, nazwa: 'ORLEN SPÓŁKA AKCYJNA' },
    siedzibaIAdres: { adres: { ulica: 'CHEMIKÓW', nrDomu: '7', miejscowosc: 'PŁOCK', kodPocztowy: '09-411', kraj: 'POLSKA' }, adresStronyInternetowej: 'WWW.ORLEN.PL' },
    kapital: { wysokoscKapitaluZakladowego: { wartosc: '1451177561,25', waluta: 'PLN' } } },
  dzial2: { reprezentacja: { sklad: [{ nazwisko: { nazwiskoICzlon: 'F*****' }, imiona: { imie: 'I*******' }, funkcjaWOrganie: 'PREZES ZARZĄDU' }] } },
  dzial3: { przedmiotDzialalnosci: { przedmiotPrzewazajacejDzialalnosci: [{ opis: 'WYTWARZANIE I PRZETWARZANIE PRODUKTÓW RAFINACJI ROPY NAFTOWEJ', kodDzial: '19', kodKlasa: '20', kodPodklasa: 'Z' }] },
    wzmiankiOZlozonychDokumentach: { wzmiankaOZlozeniuRocznegoSprawozdaniaFinansowego: [{ dataZlozenia: '17.06.2025', zaOkresOdDo: 'OD 01.01.2024 DO 31.12.2024' }, { dataZlozenia: '16.06.2026', zaOkresOdDo: 'OD 01.01.2025 DO 31.12.2025' }, { dataZlozenia: '29.04.2005', zaOkresOdDo: '2001 ROK' }] } },
  dzial4: {}, dzial5: {}, dzial6: { polaczeniePodzialPrzeksztalcenie: [{ okreslenieOkolicznosci: 'PRZEJĘCIE INNEJ SPÓŁKI' }] } } } };

test('Poland: KRS card by number, masked officers never shown, merger is not a flag; section 6 liquidation is Stop', async () => {
  let res = await natLookup('pl:28860', { 'OdpisAktualny/0000028860?rejestr=P': json(200, KRS_ORLEN) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.identity.legal_name, 'ORLEN SPÓŁKA AKCYJNA');
  assert.equal(res.body.identity.legal_form, 'Spółka Akcyjna');
  assert.equal(res.body.identity.incorporated, '2001-07-19');
  assert.equal(res.body.identity.registered_address, 'CHEMIKÓW 7, 09-411 PŁOCK, Polska');
  assert.equal(res.body.identity.vat.number, 'PL7740001454');
  assert.equal(res.body.identity.share_capital, '1451177561,25 PLN');
  assert.equal(res.body.people, null);
  assert.ok(!JSON.stringify(res.body).includes('F*****'));
  assert.equal(res.body.filings.last_accounts_year, '2025');
  assert.equal(res.body.verdict, 'clear');
  const liq = JSON.parse(JSON.stringify(KRS_ORLEN)); liq.odpis.dane.dzial6.likwidacja = { otwarcieLikwidacji: [{ data: '01.09.2026' }] };
  res = await natLookup('pl:0000028860', { 'OdpisAktualny/0000028860?rejestr=P': json(200, liq) });
  assert.equal(res.body.flags[0].label, 'Liquidation, bankruptcy or restructuring entry');
  const { search } = createHandlers({ fetchFn: fakeFetch({ 'OdpisAktualny/0000028860?rejestr=P': json(200, KRS_ORLEN), 'api.gleif.org': json(200, { data: [] }) }), env: {}, now: () => NOW });
  const s = mockRes(); await search(req({ q: '0000028860', country: 'PL' }), s);
  assert.equal(s.body.results[0].id, 'pl:0000028860');
});

test('RDAP via IANA bootstrap: registry queried directly; TLD without RDAP is a clear gap', async () => {
  const { rdapDomain, _resetRdapCache } = require('../lib/sources');
  _resetRdapCache();
  const calls = [];
  const f = fakeFetch({
    'data.iana.org/rdap/dns.json': json(200, { services: [[['com', 'net'], ['https://rdap.verisign.com/com/v1/']], [['uk'], ['https://rdap.nominet.uk/uk/']]] }),
    'rdap.verisign.com/com/v1/domain/equinor.com': json(200, { events: [{ eventAction: 'registration', eventDate: '1997-06-24T04:00:00Z' }] }),
  }, calls);
  assert.deepEqual(await rdapDomain(f, 'equinor.com'), { found: true, registered: '1997-06-24' });
  assert.match(calls[1].opts.headers.Accept, /application\/rdap\+json/);
  assert.deepEqual(await rdapDomain(f, 'equinor.no'), { found: false, no_rdap: true });
  assert.equal(calls.filter((c) => c.url.includes('iana')).length, 1, 'bootstrap is cached');
  _resetRdapCache();
});

test('Wikidata picks the item with a Wikipedia article when an identifier is shared', async () => {
  const wd = require('../lib/wikidata');
  const rows = [{ item: { value: 'http://www.wikidata.org/entity/Q139096224' }, hqs: { value: 'Mladá Boleslav@CZ' } },
    { item: { value: 'http://www.wikidata.org/entity/Q29637' }, label: { value: 'Škoda Auto' }, article: { value: 'https://en.wikipedia.org/wiki/%C5%A0koda_Auto' } }];
  const r = await wd.lookup(fakeFetch({ 'query.wikidata.org': json(200, { results: { bindings: rows } }) }), { lei: '529900I8XOZDM4ZQSQ21', country: 'CZ', number: '00177041' });
  assert.equal(r.qid, 'Q29637');
});

// ---------- US, Slovakia, Brazil, Israel, Latvia, Taiwan (fixtures trimmed from real responses, Nov 2026) ----------
test('US: search merges SEC and state registers; SEC card shows filings; state flags', async () => {
  const calls = [];
  const routes = {
    'efts.sec.gov': json(200, { hits: { hits: [{ _id: '18230', _source: { entity: 'CATERPILLAR INC (CAT)' } }] } }),
    'data.ny.gov': json(200, [{ dos_id: '1393779', current_entity_name: 'PFIZER H.C.P. CORPORATION', initial_dos_filing_date: '1989-11-06T00:00:00.000', dos_process_city: 'NEW YORK' }]),
    'data.colorado.gov': json(200, [{ entityid: '19981033526', entityname: 'CHIPOTLE MEXICAN GRILL, INC.', principalcity: 'Newport Beach', principalstate: 'CA', entitystatus: 'Good Standing', entityformdate: '1998-02-20T00:00:00.000' }]),
    'data.ct.gov': json(200, []),
    'api.gleif.org': json(200, { data: [] }),
  };
  const { search } = createHandlers({ fetchFn: fakeFetch(routes, calls), env: {}, now: () => NOW });
  const res = mockRes(); await search(req({ q: "o'brien", country: 'US' }), res);
  assert.deepEqual(res.body.results.map((r) => r.id).sort(), ['us:co-19981033526', 'us:ny-1393779', 'us:sec-0000018230']);
  assert.equal(res.body.results.find((r) => r.id === 'us:sec-0000018230').name, 'CATERPILLAR INC');
  const co = calls.find((c) => c.url.includes('data.colorado.gov'));
  assert.ok(decodeURIComponent(co.url).includes("like '%O''BRIEN%'"), 'quotes escaped in SoQL');
  assert.ok(calls.find((c) => c.url.includes('efts.sec.gov')).opts.headers['User-Agent']);

  const sec = { name: 'CATERPILLAR INC', entityType: 'operating', sic: '3531', sicDescription: 'Construction, Mining & Materials Handling Machinery & Equip',
    tickers: ['CAT'], exchanges: ['NYSE'], fiscalYearEnd: '1231', stateOfIncorporation: 'DE', stateOfIncorporationDescription: 'DE',
    addresses: { business: { street1: '5205 N. O\'CONNOR BLVD.', city: 'IRVING', stateOrCountry: 'TX', zipCode: '75039' } },
    formerNames: [{ name: 'CATERPILLAR TRACTOR CO', from: '1994-01-01T00:00:00.000Z', to: '1994-06-01T00:00:00.000Z' }],
    filings: { recent: { form: ['8-K', '10-Q', '10-K'], filingDate: ['2026-10-30', '2026-08-01', '2026-02-14'] } } };
  let r = await natLookup('us:sec-18230', { 'data.sec.gov/submissions/CIK0000018230.json': json(200, sec) });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.identity.legal_name, 'CATERPILLAR INC');
  assert.deepEqual(r.body.identity.extra.find((x) => x[0] === 'Tickers'), ['Tickers', 'CAT (NYSE)']);
  assert.equal(r.body.verdict, 'clear');
  r = await natLookup('us:sec-0000018230', { 'data.sec.gov/submissions/CIK0000018230.json': json(200, { ...sec, filings: { recent: { form: ['8-K', '10-K'], filingDate: ['2026-10-30', '2025-02-14'] } } }) });
  assert.equal(r.body.flags[0].label, 'No recent annual report');
  r = await natLookup('us:co-19981033526', { 'data.colorado.gov': json(200, [{ entityid: '19981033526', entityname: 'X LLC', entitystatus: 'Delinquent', entityformdate: '2010-01-01T00:00:00.000' }]) });
  assert.equal(r.body.flags[0].label, 'Delinquent with the state');
  r = await natLookup('us:ct-2913573', { 'data.ct.gov': json(200, [{ name: '30 Aetna Street, LLC', business_type: 'LLC', status: 'Active', accountnumber: '2913573', annual_report_due_date: '2026-03-31T00:00:00.000', business_email_address: 'someone@example.com', date_registration: '2023-12-22T00:00:00.000' }]) });
  assert.equal(r.body.flags[0].label, 'Annual report overdue');
  assert.ok(!JSON.stringify(r.body).includes('someone@example.com'), 'personal emails never shown');
});

test('Slovakia: RPO search and card; liquidation in the name is Stop', async () => {
  const e = { id: 1003617, identifiers: [{ value: '31322832', validFrom: '1992-04-29' }],
    fullNames: [{ value: 'SLOVNAFT a.s.', validFrom: '1992-04-29', validTo: '1998-11-29' }, { value: 'SLOVNAFT, a.s.', validFrom: '2008-05-30' }],
    addresses: [{ validFrom: '2006-06-16', street: 'Vlčie hrdlo', buildingNumber: '1', postalCodes: ['82412'], municipality: { value: 'Bratislava' }, country: { value: 'Slovenská republika' } }],
    establishment: '1992-05-01', sourceRegister: { value: { value: 'Obchodný register', code: '1' }, registrationNumbers: [{ value: 'Sa/426/B' }] } };
  let r = await natLookup('sk:31322832', { 'rpo/v1/search?identifier=31322832': json(200, { results: [e] }) });
  assert.equal(r.body.identity.legal_name, 'SLOVNAFT, a.s.');
  assert.equal(r.body.identity.registered_address, 'Vlčie hrdlo 1, 82412 Bratislava, Slovenská republika');
  assert.equal(r.body.verdict, 'clear');
  r = await natLookup('sk:31322832', { 'rpo/v1/search?identifier=31322832': json(200, { results: [{ ...e, fullNames: [{ value: 'X, s.r.o. v likvidácii', validFrom: '2020-01-01' }] }] }) });
  assert.equal(r.body.flags[0].label, 'In liquidation');
});

test('Brazil: CNPJ card, officers without ages, special status is Stop', async () => {
  const pb = { cnpj: '33000167000101', razao_social: 'PETROLEO BRASILEIRO S A PETROBRAS', nome_fantasia: 'PETROBRAS - EDISE', natureza_juridica: 'Sociedade de Economia Mista',
    descricao_situacao_cadastral: 'ATIVA', data_situacao_cadastral: '2005-11-03', situacao_especial: '', data_inicio_atividade: '1966-09-28', descricao_tipo_de_logradouro: 'AVENIDA',
    logradouro: 'REPUBLICA DO CHILE', numero: '65', bairro: 'CENTRO', cep: '20031170', municipio: 'RIO DE JANEIRO', uf: 'RJ', cnae_fiscal: 600001, cnae_fiscal_descricao: 'Extração de petróleo e gás natural',
    porte: 'DEMAIS', capital_social: 205431960000, qsa: [{ nome_socio: 'MAGDA MARIA DE REGINA CHAMBRIARD', qualificacao_socio: 'Presidente', faixa_etaria: 'Entre 61 a 70 anos' }] };
  let r = await natLookup('br:33.000.167/0001-01', { 'brasilapi.com.br/api/cnpj/v1/33000167000101': json(200, pb) });
  assert.equal(r.body.identity.register.number, '33.000.167/0001-01');
  assert.deepEqual(r.body.people.officers, [{ name: 'MAGDA MARIA DE REGINA CHAMBRIARD', role: 'Presidente' }]);
  assert.ok(!JSON.stringify(r.body).includes('61 a 70'));
  assert.equal(r.body.verdict, 'clear');
  r = await natLookup('br:33000167000101', { 'brasilapi.com.br/api/cnpj/v1/33000167000101': json(200, { ...pb, situacao_especial: 'RECUPERACAO JUDICIAL' }) });
  assert.equal(r.body.flags[0].level, 'stop');
});

test('Israel: Hebrew registrar record in English; violator and overdue report flags', async () => {
  const row = { 'מספר חברה': 513526889, 'שם חברה': 'טבע תיווך בע~מ', 'שם באנגלית': 'TEVA BROKERAGE LTD', 'סוג תאגיד': 'ישראלית חברה פרטית', 'סטטוס חברה': 'פעילה',
    'תאריך התאגדות': '23/03/2004', 'חברה ממשלתית': 'לא', 'מפרה': '', 'שנה אחרונה של דוח שנתי (שהוגש)': 2026, 'שם עיר': 'הרצליה', 'שם רחוב': 'הנשיא יצחק בן צבי', 'מספר בית': '58', 'מדינה': 'ישראל' };
  let r = await natLookup('il:513526889', { 'data.gov.il': json(200, { success: true, result: { records: [row] } }) });
  assert.equal(r.body.identity.legal_name, 'TEVA BROKERAGE LTD');
  assert.equal(r.body.identity.legal_form, 'Israeli private company');
  assert.equal(r.body.identity.incorporated, '2004-03-23');
  assert.deepEqual(r.body.identity.other_names, ['טבע תיווך בע"מ']);
  assert.equal(r.body.verdict, 'clear');
  r = await natLookup('il:513526889', { 'data.gov.il': json(200, { success: true, result: { records: [{ ...row, 'מפרה': 'מפרה', 'שנה אחרונה של דוח שנתי (שהוגש)': 2022 }] } }) });
  assert.deepEqual(r.body.flags.map((f) => f.label).sort(), ['Annual report overdue', 'Marked as a violating company']);
});

test('Latvia: register record, VAT number for VIES, terminated is Stop', async () => {
  const row = { regcode: 40003245752, name: 'Akciju sabiedrība "Air Baltic Corporation"', type_text: 'Akciju sabiedrība', regtype_text: 'Komercreģistrs', registered: '1995-08-28T00:00:00', terminated: null, address: 'Mārupes nov., Mārupes pag., lidosta "Rīga" 10/1', index: 1053 };
  let r = await natLookup('lv:40003245752', { 'data.gov.lv': json(200, { success: true, result: { records: [row] } }) });
  assert.equal(r.body.identity.vat.number, 'LV40003245752');
  assert.equal(r.body.verdict, 'clear');
  r = await natLookup('lv:40003245752', { 'data.gov.lv': json(200, { success: true, result: { records: [{ ...row, terminated: '2020-01-01T00:00:00' }] } }) });
  assert.equal(r.body.flags[0].label, 'Not active');
});

test('Taiwan: UBN card with ROC dates; English names are not sent to the Chinese-only index', async () => {
  const tsmc = { Business_Accounting_NO: '22099131', Company_Status_Desc: '核准設立', Company_Name: '台灣積體電路製造股份有限公司', Paid_In_Capital_Amount: 259323700670,
    Responsible_Name: '魏哲家', Company_Location: '新竹科學園區新竹市力行六路8號', Register_Organization_Desc: '新竹科學園區管理局', Company_Setup_Date: '0760221', Change_Of_Approval_Data: '1150821', Revoke_App_Date: '', Sus_Beg_Date: '', Sus_End_Date: '' };
  const r = await natLookup('tw:22099131', { '5F64D864': json(200, [tsmc]) });
  assert.equal(r.body.identity.incorporated, '1987-02-21');
  assert.equal(r.body.identity.status, 'Active (核准設立)');
  assert.equal(r.body.verdict, 'clear');
  const calls = [];
  const { search } = createHandlers({ fetchFn: fakeFetch({ 'api.gleif.org': json(200, { data: [] }) }, calls), env: {}, now: () => NOW });
  const s = mockRes(); await search(req({ q: 'tsmc', country: 'TW' }), s);
  assert.ok(!calls.some((c) => c.url.includes('gcis')));
});

test('Brazil falls back to minhareceita.org when BrasilAPI refuses', async () => {
  const r = await natLookup('br:33000167000101', { 'brasilapi.com.br': json(403, {}), 'minhareceita.org/33000167000101': json(200, { cnpj: '33000167000101', razao_social: 'PETROLEO BRASILEIRO S A PETROBRAS', descricao_situacao_cadastral: 'ATIVA', qsa: [] }) });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.identity.legal_name, 'PETROLEO BRASILEIRO S A PETROBRAS');
});

test('Singapore: search picks the dataset by first letter; card from ACRA; overdue accounts is Check', async () => {
  const calls = [];
  const dbs = { uen: '196800306E', entity_name: 'DBS BANK LTD.', entity_type_description: 'Local Company', business_constitution_description: 'na', company_type_description: 'Public Company Limited by Shares',
    entity_status_description: 'Live Company', registration_incorporation_date: '1968-07-16', block: '12', street_name: 'MARINA BOULEVARD', level_no: 'na', unit_no: 'na', building_name: 'na',
    postal_code: '018982', other_address_line1: 'na', other_address_line2: 'na', account_due_date: '2027-07-31', annual_return_date: '2026-06-03', primary_ssic_code: '64191', primary_ssic_description: 'na',
    primary_user_described_activity: 'na', no_of_officers: '12', former_entity_name1: 'THE DEVELOPMENT BANK OF SINGAPORE LIMITED', former_entity_name2: 'na', name_of_audit_firm1: 'na' };
  const routes = { 'resource_id=d_acbc938ec77af18f94cecc4a7c9ec720': json(200, { success: true, result: { records: [dbs] } }), 'api.gleif.org': json(200, { data: [] }) };
  const { search } = createHandlers({ fetchFn: fakeFetch(routes, calls), env: {}, now: () => NOW });
  const s = mockRes(); await search(req({ q: 'dbs bank', country: 'SG' }), s);
  assert.equal(s.body.results[0].id, 'sg:D-196800306E');
  let r = await natLookup('sg:D-196800306E', routes);
  assert.equal(r.body.identity.legal_name, 'DBS BANK LTD.');
  assert.equal(r.body.identity.registered_address, '12 MARINA BOULEVARD, Singapore 018982');
  assert.deepEqual(r.body.identity.former_names, [{ name: 'THE DEVELOPMENT BANK OF SINGAPORE LIMITED', to: null }]);
  assert.equal(r.body.verdict, 'clear');
  r = await natLookup('sg:D-196800306E', { 'resource_id=d_acbc938ec77af18f94cecc4a7c9ec720': json(200, { success: true, result: { records: [{ ...dbs, account_due_date: '2026-01-31' }] } }) });
  assert.equal(r.body.flags[0].label, 'Accounts overdue');
});

test('register card finds its LEI by the register number, not the internal ID', async () => {
  const calls = [];
  const dbs = { uen: '196800306E', entity_name: 'DBS BANK LTD.', entity_status_description: 'Live Company', registration_incorporation_date: '1968-07-16' };
  const { company } = createHandlers({ fetchFn: fakeFetch({ 'resource_id=d_acbc938ec77af18f94cecc4a7c9ec720': json(200, { success: true, result: { records: [dbs] } }), 'api.gleif.org': json(200, { data: [] }) }, calls), env: {}, now: () => NOW });
  const res = mockRes(); await company(req({ id: 'sg:D-196800306E' }), res);
  const g = calls.find((c) => c.url.includes('registeredAs'));
  assert.ok(g.url.includes('registeredAs%5D=196800306E'));
});

test('Switzerland: Zefix via LINDAS SPARQL, by name and by UID; legal form translated', async () => {
  const calls = [];
  const row = { c: { value: 'https://register.ld.admin.ch/zefix/company/108994' }, name: { value: 'Logitech international S.A.' }, uid: { value: 'CHE101502641' },
    street: { value: 'EPFL - Quartier de l\'Innovation, Daniel Borel Innovation Center' }, zip: { value: '1015' }, city: { value: 'Lausanne' }, lf: { value: 'https://ld.admin.ch/ech/97/legalforms/0106' } };
  const f = fakeFetch({ 'ld.admin.ch/query': (url) => json(200, { results: { bindings: [row] } }), 'api.gleif.org': json(200, { data: [] }) }, calls);
  const { search, company } = createHandlers({ fetchFn: f, env: {}, now: () => NOW });
  const s = mockRes(); await search(req({ q: 'logitech', country: 'CH' }), s);
  assert.equal(s.body.results[0].id, 'ch:108994');
  const post = calls.find((c) => c.url.includes('ld.admin.ch'));
  assert.equal(post.opts.method, 'POST');
  assert.match(decodeURIComponent(post.opts.body), /CONTAINS\(LCASE\(STR\(\?name\)\), "logitech"\)/);
  const res = mockRes(); await company(req({ id: 'ch:108994' }), res);
  assert.equal(res.body.identity.legal_form, 'Company limited by shares (AG/SA)');
  assert.equal(res.body.identity.register.number, 'CHE-101.502.641');
  assert.equal(res.body.verdict, 'clear');
});

test('Swiss register hits replace GLEIF hits with the same UID', async () => {
  const row = { c: { value: 'https://register.ld.admin.ch/zefix/company/108994' }, name: { value: 'Logitech international S.A.' }, uid: { value: 'CHE101502641' }, city: { value: 'Lausanne' } };
  const { search } = createHandlers({ fetchFn: fakeFetch({ 'ld.admin.ch/query': json(200, { results: { bindings: [row] } }),
    'filter%5Bfulltext%5D': json(200, { data: [{ attributes: { lei: '549300SN6PRK6IJJC215', entity: { legalName: { name: 'LOGITECH INTERNATIONAL S.A.' }, legalAddress: { country: 'CH' }, status: 'ACTIVE', registeredAs: 'CHE-101.502.641' } } }] }) }), env: {}, now: () => NOW });
  const res = mockRes(); await search(req({ q: 'logitech', country: 'CH' }), res);
  assert.equal(res.body.results.length, 1);
  assert.equal(res.body.results[0].id, 'ch:108994');
  assert.equal(res.body.results[0].lei, '549300SN6PRK6IJJC215');
});

// ---------- Groups (fixture shapes from real GLEIF responses, Nov 2026) ----------
test('Groups: subsidiaries, group size, why there is no parent, parent risk', async () => {
  const lei = 'W38RGI023J3WT1HWRP32';
  const ent = (l, name, country, status = 'ACTIVE') => ({ attributes: { lei: l, entity: { legalName: { name }, legalAddress: { country }, status } } });
  let res = await leiLookup(lei, { legalName: { name: 'Siemens Aktiengesellschaft' }, status: 'ACTIVE', legalAddress: { country: 'DE' } }, undefined, {}, {
    [`lei-records/${lei}/direct-children`]: json(200, { meta: { pagination: { total: 462 } }, data: [ent('529900YQP0HHGTCX1K98', 'De Novo Software, LLC', 'US'), ent('5299000000000000AA11', 'Alpha GmbH', 'DE', 'INACTIVE')] }),
    [`lei-records/${lei}/ultimate-children`]: json(200, { meta: { pagination: { total: 574 } }, data: [] }),
    [`lei-records/${lei}/direct-parent-reporting-exception`]: json(200, { data: { attributes: { reason: 'NO_KNOWN_PERSON' } } }),
    [`lei-records/${lei}/ultimate-parent-reporting-exception`]: json(200, { data: { attributes: { reason: 'NO_KNOWN_PERSON' } } }),
  });
  const g = res.body.group;
  assert.equal(g.subsidiaries.total, 462);
  assert.equal(g.all_subsidiaries_total, 574);
  assert.equal(g.group_size, 575, 'top of group: all subsidiaries plus itself');
  assert.deepEqual(g.subsidiaries.items.map((x) => x.name), ['De Novo Software, LLC', 'Alpha GmbH'], 'active first');
  assert.match(g.no_parent_reason, /widely held/);
  assert.equal(res.body.verdict, 'clear');

  const sub = '529900YQP0HHGTCX1K98';
  res = await leiLookup(sub, { legalName: { name: 'De Novo Software, LLC' }, status: 'ACTIVE', legalAddress: { country: 'US' } }, undefined, {}, {
    [`lei-records/${sub}/direct-parent`]: json(200, { data: ent(lei, 'Siemens Aktiengesellschaft', 'DE', 'INACTIVE') }),
    [`lei-records/${sub}/ultimate-parent`]: json(200, { data: ent(lei, 'Siemens Aktiengesellschaft', 'DE', 'INACTIVE') }),
    [`lei-records/${lei}/ultimate-children`]: json(200, { meta: { pagination: { total: 574 } }, data: [] }),
  });
  assert.equal(res.body.group.group_size, 575, 'group size counted from the ultimate parent');
  assert.equal(res.body.flags[0].label, 'Parent company not active');
  assert.doesNotMatch(res.body.next_step, /guarantee/, 'no guarantee suggestion from an inactive parent');
  assert.equal(res.body.group.direct_parent.name, 'Siemens Aktiengesellschaft');
});

test('Groups: undisclosed parent is a Note', async () => {
  const lei = '5299000ABCDEFGHIJ012';
  const res = await leiLookup(lei, { legalName: { name: 'Quietco BV' }, status: 'ACTIVE', legalAddress: { country: 'NL' } }, undefined, {}, {
    [`lei-records/${lei}/direct-parent-reporting-exception`]: json(200, { data: { attributes: { reason: 'NON_PUBLIC' } } }),
  });
  assert.deepEqual(res.body.flags.map((f) => [f.level, f.label]), [['note', 'Parent not disclosed']]);
});

test('Ireland: CRO open data card; strike-off listed is Stop; long-overdue annual return is Check', async () => {
  const rec = { company_num: 104547, company_name: 'RYANAIR DESIGNATED ACTIVITY COMPANY', company_status: 'Normal ', company_type: 'DAC - Designated Activity Company (limited by shares)',
    company_reg_date: '1984-11-28T00:00:00', last_ar_date: '2025-10-09T00:00:00', company_address_1: 'RYANAIR DUBLIN OFFICE', company_address_2: 'AIRSIDE BUSINESS PARK',
    company_address_3: 'SWORDS CO. DUBLIN', company_address_4: 'SWORDS,DUBLIN', comp_dissolved_date: null, nard: '2026-10-09T00:00:00', last_accounts_date: '2025-03-31T00:00:00', nace_v2_code: 5110, eircode: null };
  const route = (r) => ({ 'opendata.cro.ie': json(200, { success: true, result: { records: [r] } }) });
  let res = await natLookup('ie:104547', route(rec));
  assert.equal(res.body.identity.legal_name, 'RYANAIR DESIGNATED ACTIVITY COMPANY');
  assert.equal(res.body.verdict, 'clear', 'a return date one month ago is not flagged (data lag)');
  res = await natLookup('ie:104547', route({ ...rec, nard: '2026-05-01T00:00:00' }));
  assert.equal(res.body.flags[0].label, 'Annual return overdue');
  res = await natLookup('ie:104547', route({ ...rec, company_status: 'Strike Off Listed' }));
  assert.equal(res.body.flags[0].label, 'Listed for strike-off');
  res = await natLookup('ie:104547', route({ ...rec, company_status: 'Dissolved', comp_dissolved_date: '2020-01-01T00:00:00' }));
  assert.equal(res.body.flags[0].label, 'Not active');
});

test('Australia: ASIC rows collapse to one company with its current name; external administration is Stop', async () => {
  const cur = { _id: 1, 'Company Name': 'QANTAS AIRWAYS LIMITED', ACN: '009661901', Type: 'APUB', Class: 'LMSH', 'Sub Class': 'LIST', Status: 'REGD',
    'Date of Registration': '18/01/1934', 'Date of Deregistration': null, 'Previous State of Registration': 'QLD', 'Current Name Indicator': 'Y', ABN: '16009661901', 'Current Name': null };
  const old = { ...cur, _id: 2, 'Company Name': 'QANTAS EMPIRE AIRWAYS LIMITED', 'Current Name Indicator': null, 'Current Name': 'QANTAS AIRWAYS LIMITED' };
  const route = (rows) => ({ 'data.gov.au': json(200, { success: true, result: { records: rows } }) });
  const { search } = createHandlers({ fetchFn: fakeFetch({ ...route([old, cur]), 'api.gleif.org': json(200, { data: [] }) }), env: {}, now: () => NOW });
  let res = mockRes(); await search(req({ q: 'qantas', country: 'AU' }), res);
  assert.equal(res.body.results.length, 1);
  assert.equal(res.body.results[0].name, 'QANTAS AIRWAYS LIMITED');
  assert.equal(res.body.results[0].id, 'au:009661901');
  res = await natLookup('au:16 009 661 901', route([old, cur]));
  assert.equal(res.body.identity.legal_name, 'QANTAS AIRWAYS LIMITED');
  assert.deepEqual(res.body.identity.former_names, [{ name: 'QANTAS EMPIRE AIRWAYS LIMITED' }]);
  assert.equal(res.body.identity.incorporated, '1934-01-18');
  assert.equal(res.body.identity.legal_form, 'Australian public company, limited by shares, listed');
  assert.equal(res.body.verdict, 'clear');
  res = await natLookup('au:009661901', route([{ ...cur, Status: 'EXAD' }]));
  assert.equal(res.body.flags[0].label, 'Under external administration');
  res = await natLookup('au:009661901', route([{ ...cur, Status: 'DRGD', 'Date of Deregistration': '01/02/2020' }]));
  assert.equal(res.body.flags[0].label, 'Not active');
});

test('Colombia: RUES card for a legal entity; renewal overdue is Check; cancelled is not active', async () => {
  const rec = { codigo_camara: '04', camara_comercio: 'BOGOTA', matricula: '1291197', razon_social: 'ECOPETROL S A', nit: '899999068', digito_verificacion: '1',
    cod_ciiu_act_econ_pri: '0610', cod_ciiu_act_econ_sec: '0620', fecha_matricula: '20030718', ultimo_ano_renovado: '2026', fecha_vigencia: '21030707',
    tipo_sociedad: 'SOCIEDAD COMERCIAL', organizacion_juridica: 'SOCIEDAD ANONIMA', codigo_categoria_matricula: '01', codigo_estado_matricula: '01', estado_matricula: 'ACTIVA',
    representante_legal: 'NOMBRE DE PRUEBA' };
  const route = (rows) => ({ 'datos.gov.co': json(200, rows) });
  let res = await natLookup('co:899999068-1', route([rec]));
  assert.equal(res.body.identity.legal_name, 'ECOPETROL S A');
  assert.equal(res.body.identity.incorporated, '2003-07-18');
  assert.deepEqual(res.body.people.officers, [{ name: 'NOMBRE DE PRUEBA', role: 'Legal representative' }]);
  assert.equal(res.body.verdict, 'clear');
  res = await natLookup('co:899999068', route([{ ...rec, ultimo_ano_renovado: '2024' }]));
  assert.equal(res.body.flags[0].label, 'Registration not renewed');
  res = await natLookup('co:899999068', route([{ ...rec, codigo_estado_matricula: '03', estado_matricula: 'CANCELADA' }, { ...rec, fecha_matricula: '19990101', codigo_estado_matricula: '03', estado_matricula: 'CANCELADA' }]));
  assert.equal(res.body.flags[0].label, 'Not active');
});

test('GLEIF spellings: Australian ACN with spaces and Colombian NIT with check digit link to the LEI and dedupe', async () => {
  const au = { 'Company Name': 'QANTAS AIRWAYS LIMITED', ACN: '009661901', Type: 'APUB', Class: 'LMSH', 'Sub Class': 'LIST', Status: 'REGD', 'Date of Registration': '18/01/1934', 'Current Name Indicator': 'Y', ABN: '16009661901' };
  const lei = 'YLXNW6TI6QSK1H8H0N82';
  const glRec = { attributes: { lei, entity: { legalName: { name: 'QANTAS AIRWAYS LIMITED' }, status: 'ACTIVE', legalAddress: { country: 'AU' }, registeredAs: '009 661 901' } } };
  let seen = [];
  const routes = { 'data.gov.au': json(200, { success: true, result: { records: [au] } }), 'registeredAs%5D=009%20661%20901': json(200, { data: [{ attributes: { lei } }] }),
    [`lei-records/${lei}`]: json(200, { data: glRec }), 'api.gleif.org': json(200, { data: [] }) };
  const { company } = createHandlers({ fetchFn: (u, o) => { seen.push(u); return fakeFetch(routes)(u, o); }, env: {}, now: () => NOW });
  const res = mockRes(); await company(req({ id: 'au:009661901' }), res);
  assert.equal(res.body.ids.lei, lei);
  // Colombia: a GLEIF hit "899999068-1" is merged into the RUES hit.
  const co = { razon_social: 'ECOPETROL S A', nit: '899999068', digito_verificacion: '1', codigo_estado_matricula: '01', fecha_matricula: '20030718', camara_comercio: 'BOGOTA' };
  const gl = { id: '254900IDGKCJICKBPA66', attributes: { lei: '254900IDGKCJICKBPA66', entity: { legalName: { name: 'Ecopetrol S.A.' }, status: 'ACTIVE', legalAddress: { country: 'CO', city: 'Bogotá' }, registeredAs: '899999068-1' }, registration: {} } };
  const { search } = createHandlers({ fetchFn: fakeFetch({ 'datos.gov.co': json(200, [co]), 'api.gleif.org': json(200, { data: [gl] }) }), env: {}, now: () => NOW });
  const r2 = mockRes(); await search(req({ q: 'ecopetrol', country: 'CO' }), r2);
  assert.deepEqual(r2.body.results.map((x) => [x.id, x.lei]), [['co:899999068', '254900IDGKCJICKBPA66']]);
});

test('Texas: franchise tax permit holder card; forfeited right to transact is Stop; sole proprietors excluded from queries', async () => {
  const rec = { taxpayer_number: '32106582219', taxpayer_name: 'DELL TECHNOLOGIES INC.', taxpayer_address: '1 DELL WAY', taxpayer_city: 'ROUND ROCK', taxpayer_state: 'TX', taxpayer_zip: '78682',
    taxpayer_organizational_type: 'CT', record_type_code: 'U', responsibility_beginning_date: '2022-03-01T00:00:00.000', secretary_of_state_sos_or_coa_file_number: '0806671479',
    sos_charter_date: '2022-03-01T00:00:00.000', sos_status_code: 'A', right_to_transact_business_code: 'A', _621111: '551112' };
  const urls = [];
  const routes = (r) => ({ 'data.texas.gov': json(200, [r]) });
  const look = async (r) => { const { company } = createHandlers({ fetchFn: (u, o) => { urls.push(u); return fakeFetch({ 'api.gleif.org': json(200, { data: [] }), ...routes(r) })(u, o); }, env: {}, now: () => NOW }); const res = mockRes(); await company(req({ id: 'us:tx-32106582219' }), res); return res; };
  let res = await look(rec);
  assert.equal(res.body.identity.legal_name, 'DELL TECHNOLOGIES INC.');
  assert.equal(res.body.identity.legal_form, 'Texas profit corporation');
  assert.equal(res.body.identity.registered_address, '1 DELL WAY, ROUND ROCK, TX, 78682');
  assert.equal(res.body.verdict, 'clear');
  assert.ok(urls.some((u) => decodeURIComponent(u).includes("not in ('IS','S','ES','IS ','S ','ES ','S  ')")), 'individuals are filtered out');
  assert.ok(urls.some((u) => decodeURIComponent(u).includes('registeredAs]=0806671479')), 'LEI looked up by SOS file number');
  res = await look({ ...rec, right_to_transact_business_code: 'N ' });
  assert.equal(res.body.flags[0].label, 'Right to transact business forfeited');
  res = await look({ ...rec, sos_status_code: 'D', right_to_transact_business_code: '' });
  assert.equal(res.body.flags[0].label, 'Not active');
});

test('Oregon and Pennsylvania: active-list cards; assumed business names excluded; PA officers deduplicated', async () => {
  const urls = [];
  const orRows = [
    { registry_number: '8739914', business_name: 'NIKE, INC.', entity_type: 'DOMESTIC BUSINESS CORPORATION', registry_date: '1969-09-08T00:00:00.000', associated_name_type: 'REGISTERED AGENT', entity_of_record_name: 'UNITED AGENT GROUP INC.', city: 'PORTLAND', state: 'OR', jurisdiction: 'OR' },
    { registry_number: '8739914', business_name: 'NIKE, INC.', entity_type: 'DOMESTIC BUSINESS CORPORATION', registry_date: '1969-09-08T00:00:00.000', associated_name_type: 'PRINCIPAL PLACE OF BUSINESS', address: 'ONE BOWERMAN DR', city: 'BEAVERTON', state: 'OR', zip: '97005', jurisdiction: 'OR' }];
  const paRows = [
    { business_name_source_: 'THE HERSHEY COMPANY', filing_number: '0000159516', address_line1: '19 E CHOCOLATE AVE', city: 'Hershey', state: 'PA', zip: '17033', typeofbusinessregistration: 'Foreign Business Corporation', creationdate: '1927-11-02T00:00:00.000', party_type: 'President', first_name: 'A', last_name: 'PERSON', shortcountyname: 'Dauphin' },
    { business_name_source_: 'THE HERSHEY COMPANY', filing_number: '0000159516', address_line1: '19 E CHOCOLATE AVE', city: 'Hershey', state: 'PA', zip: '17033', typeofbusinessregistration: 'Foreign Business Corporation', creationdate: '1927-11-02T00:00:00.000', party_type: 'President', first_name: 'A', last_name: 'PERSON' }];
  const make = () => createHandlers({ fetchFn: (u, o) => { urls.push(u); return fakeFetch({ 'api.gleif.org': json(200, { data: [] }), 'data.oregon.gov': json(200, orRows), 'data.pa.gov': json(200, paRows) })(u, o); }, env: {}, now: () => NOW });
  let res = mockRes(); await make().company(req({ id: 'us:or-8739914' }), res);
  assert.equal(res.body.identity.legal_name, 'NIKE, INC.');
  assert.equal(res.body.identity.registered_address, 'ONE BOWERMAN DR, BEAVERTON, OR, 97005');
  assert.equal(res.body.identity.legal_form, 'Domestic Business Corporation');
  assert.ok(urls.some((u) => decodeURIComponent(u).includes("not in ('ASSUMED BUSINESS NAME'")));
  assert.ok(urls.some((u) => decodeURIComponent(u).includes('registeredAs]=087399-14')), 'GLEIF spelling of the Oregon number');
  res = mockRes(); await make().company(req({ id: 'us:pa-0000159516' }), res);
  assert.equal(res.body.identity.legal_name, 'THE HERSHEY COMPANY');
  assert.deepEqual(res.body.people.officers, [{ name: 'A PERSON', role: 'President' }]);
  assert.equal(res.body.verdict, 'clear');
});

test('Listed companies: ISIN search finds the issuer; ticker match goes first; card shows securities', async () => {
  const lei = '787RXPR0UX0O0XUXPZ81';
  const nike = { id: lei, attributes: { lei, entity: { legalName: { name: 'NIKE, INC.' }, status: 'ACTIVE', legalAddress: { country: 'US', city: 'Beaverton' }, registeredAs: '087399-14' }, registration: { status: 'ISSUED' } } };
  // ISIN
  let urls = [];
  let h = createHandlers({ fetchFn: (u, o) => { urls.push(u); return fakeFetch({ 'filter%5Bisin%5D=US6541061031': json(200, { data: [nike] }), 'api.gleif.org': json(200, { data: [] }) })(u, o); }, env: {}, now: () => NOW });
  let res = mockRes(); await h.search(req({ q: 'us6541061031' }), res);
  assert.deepEqual(res.body.results.map((r) => [r.id, r.isin]), [[`lei:${lei}`, 'US6541061031']]);
  assert.ok(!urls.some((u) => u.includes('query.wikidata.org')), 'an ISIN is not treated as a ticker');
  // Ticker
  const wd = { results: { bindings: [{ item: { value: 'http://www.wikidata.org/entity/Q483915' }, lei: { value: lei }, exchange: { value: 'New York Stock Exchange' } }] } };
  h = createHandlers({ fetchFn: fakeFetch({ 'query.wikidata.org': json(200, wd), 'filter%5Blei%5D=': json(200, { data: [nike] }),
    'api.gleif.org': json(200, { data: [{ id: 'X', attributes: { lei: '5493001KJTIIGC8Y1R12', entity: { legalName: { name: 'NKE Holdings Ltd' }, status: 'ACTIVE', legalAddress: { country: 'GB' } }, registration: {} } }] }) }), env: {}, now: () => NOW });
  res = mockRes(); await h.search(req({ q: 'nke' }), res);
  assert.equal(res.body.results[0].id, `lei:${lei}`);
  assert.equal(res.body.results[0].ticker, 'NKE on New York Stock Exchange');
  assert.equal(res.body.results.length, 2);
  // Card
  res = await leiLookup(lei, nike.attributes.entity, undefined, {}, { [`lei-records/${lei}/isins`]: json(200, { meta: { pagination: { total: 51 } }, data: [{ attributes: { isin: 'US6541061031' } }, { attributes: { isin: 'US654106AG82' } }] }) });
  assert.deepEqual(res.body.ids.isins, { total: 51, items: ['US6541061031', 'US654106AG82'] });
});

test('Ticker: one Wikidata item with two LEIs keeps the one in the exchange country', async () => {
  const ent = (lei, name, country) => ({ id: lei, attributes: { lei, entity: { legalName: { name }, status: 'ACTIVE', legalAddress: { country } }, registration: {} } });
  const ag = ent('W38RGI023J3WT1HWRP32', 'Siemens Aktiengesellschaft', 'DE'); const plc = ent('213800AAAAAAAAAAAA11', 'SIEMENS PLC', 'GB');
  const b = (lei) => ({ item: { value: 'http://www.wikidata.org/entity/Q81230' }, lei: { value: lei }, exchange: { value: 'Frankfurt Stock Exchange' }, exCountry: { value: 'DE' } });
  const h = createHandlers({ fetchFn: fakeFetch({ 'query.wikidata.org': json(200, { results: { bindings: [b(ag.id), b(plc.id)] } }), 'api.gleif.org': json(200, { data: [ag, plc] }) }), env: {}, now: () => NOW });
  const res = mockRes(); await h.search(req({ q: 'SIE' }), res);
  assert.deepEqual(res.body.results.map((r) => [r.name, r.ticker || null]), [['Siemens Aktiengesellschaft', 'SIE on Frankfurt Stock Exchange'], ['SIEMENS PLC', null]]);
});

test('Hong Kong: prefix name search and BRN card from the Companies Registry API', async () => {
  const hsbc = { Brn: '67535478', Chinese_Company_Name: 'NULL', English_Company_Name: 'HSBC Asia Holdings Limited', Address_of_Registered_Office: "1 QUEEN'S RD CENTRAL, HONG KONG",
    Company_Type: 'Private company limited by shares', Date_of_Incorporation: '29-03-2017', 'Re-domiciliation_Date': null };
  const calls = [];
  const routes = { 'data.cr.gov.hk': json(200, [hsbc]), 'api.gleif.org': json(200, { data: [] }) };
  const { search } = createHandlers({ fetchFn: fakeFetch(routes, calls), env: {}, now: () => NOW });
  const s = mockRes(); await search(req({ q: 'HSBC Asia', country: 'HK' }), s);
  assert.equal(s.body.results[0].id, 'hk:67535478');
  assert.ok(calls.some((c) => c.url.includes('key2]=begins_with&query[0][key3]=HSBC%20Asia')));
  const r = await natLookup('hk:67535478', routes);
  assert.equal(r.body.identity.legal_name, 'HSBC Asia Holdings Limited');
  assert.equal(r.body.identity.incorporated, '2017-03-29');
  assert.equal(r.body.identity.registered_address, "1 QUEEN'S RD CENTRAL, HONG KONG");
  assert.deepEqual(r.body.identity.other_names, []);
});

test('New Caledonia: live RIDET search; individuals filtered out; card from rid7', async () => {
  const org = { rid7: '0637546', denomination: 'SOCIETE LE NICKEL', date_entreprises_actives: '2026-06-30', code_formjur: '57', libelle_formjur: 'SAS', code_ape: '0729Z', libelle_naf: 'Extraction de minerais', libelle_commune: 'Nouméa', province: 'province Sud' };
  const ind = { ...org, rid7: '1111111', denomination: 'DUPONT JEAN', code_formjur: '10' };
  const calls = [];
  const routes = { 'data.gouv.nc': json(200, { total_count: 2, results: [org, ind] }), 'api.gleif.org': json(200, { data: [] }) };
  const { search } = createHandlers({ fetchFn: fakeFetch(routes, calls), env: {}, now: () => NOW });
  const s = mockRes(); await search(req({ q: 'nickel', country: 'NC' }), s);
  assert.deepEqual(s.body.results.filter((r) => r.source.startsWith('RIDET')).map((r) => r.id), ['nc:0637546']);
  const r = await natLookup('nc:0637546', { 'data.gouv.nc': json(200, { results: [org] }) });
  assert.equal(r.body.identity.legal_name, 'SOCIETE LE NICKEL');
  assert.equal(r.body.identity.registered_address, 'Nouméa, province Sud, New Caledonia');
});
