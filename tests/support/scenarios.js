// Fixed request scenarios run against the HTTP handlers. Used to snapshot the /api/* responses
// (tests/fixtures/api-legacy-snapshot.json) and to check /v1/ wraps the same handlers.
'use strict';
const fs = require('fs');
const path = require('path');

const NOW = new Date('2026-11-15T12:00:00Z');
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'overture-places.json'), 'utf8')).records;

const profile = {
  company_name: 'EXAMPLE TRADING LIMITED', company_number: '01234567', company_status: 'active',
  type: 'ltd', jurisdiction: 'england-wales', date_of_creation: '2010-03-15',
  registered_office_address: { address_line_1: '1 High Street', locality: 'London', postal_code: 'EC1A 1AA', country: 'England' },
  sic_codes: ['46900'], has_charges: false, has_insolvency_history: false,
  accounts: { next_due: '2027-09-30', overdue: false, last_accounts: { made_up_to: '2025-12-31', type: 'full' } },
  confirmation_statement: { next_due: '2027-03-29', overdue: false },
};

// Fake upstreams: Companies House (one company, one search hit), GLEIF and everything else empty.
function fetchFn(url) {
  if (url.includes('company-information') && url.includes('/search/companies')) {
    return Promise.resolve(json(200, { items: [{ company_number: '01234567', title: 'EXAMPLE TRADING LIMITED', company_status: 'active', address_snippet: '1 High Street, London, EC1A 1AA', date_of_creation: '2010-03-15' }] }));
  }
  if (url.includes('company-information') && url.includes('/company/01234567/officers')) return Promise.resolve(json(200, { items: [{ name: 'SMITH, Jane', officer_role: 'director', appointed_on: '2015-01-01' }] }));
  if (url.includes('company-information') && url.includes('/company/01234567/persons-with-significant-control')) return Promise.resolve(json(200, { items: [] }));
  if (url.includes('company-information') && /\/company\/01234567(\?|$)/.test(url)) return Promise.resolve(json(200, profile));
  if (url.includes('company-information') && url.includes('/company/09999999')) {
    return Promise.resolve(json(429, {}));
  }
  if (url.includes('company-information') && url.includes('/company/08888888')) return Promise.resolve(json(500, {}));
  if (url.includes('gleif')) return Promise.resolve(json(200, { data: [] }));
  return Promise.resolve(json(404, {}));
}

function memStore(records = {}) {
  const idx = { records };
  return { enabled: true, idx, load: async () => idx, update: async (r, mutate) => { mutate(idx); return true; }, ping: async () => true };
}
const fakeOverture = {
  latestRelease: async () => '2026-10-21.0',
  place: async (id) => { const f = FIX.find((x) => x.row.id === id); return f ? { row: f.row, release: f.release } : null; },
};
const COLEAGO = '6f8bce4f-a274-4494-9f2c-dd051bca0bb4';
const candidates = async () => [{ id: 'gb:06960521', name: 'COLEAGO CONSULTING LIMITED', country: 'GB', website: 'https://www.coleago.com', address: { line: '77 Abbotsbury Road', locality: 'London', postcode: 'W14 8EP', country: 'GB' }, register: 'Companies House', number: '06960521', ids: ['gb:06960521'] }];

function deps(extra = {}) {
  return { fetchFn, env: { COMPANIES_HOUSE_API_KEY: 'test-key' }, now: () => NOW, overture: fakeOverture, store: memStore(), presenceCandidates: candidates, ...extra };
}

let n = 0;
const req = (method, query, body, headers = {}) => ({ method, query, body, headers: { 'x-forwarded-for': `10.77.0.${++n % 250}`, host: 'example.test', ...headers }, socket: {} });

// [name, handler name, request factory]
const SCENARIOS = [
  ['search ok', 'search', () => req('GET', { q: 'Example Trading', country: 'GB' })],
  ['search too short', 'search', () => req('GET', { q: 'x' })],
  ['search bad country', 'search', () => req('GET', { q: 'Example', country: 'GBR' })],
  ['search POST', 'search', () => req('POST', {})],
  ['company ok', 'company', () => req('GET', { id: 'gb:01234567' })],
  ['company unknown ref', 'company', () => req('GET', { id: 'xx:1' })],
  ['company bad website', 'company', () => req('GET', { id: 'gb:01234567', website: 'not a site' })],
  ['company overture id', 'company', () => req('GET', { id: 'overture:abc' })],
  ['company not found', 'company', () => req('GET', { id: 'gb:07777777' })],
  ['company upstream busy', 'company', () => req('GET', { id: 'gb:09999999' })],
  ['company upstream down', 'company', () => req('GET', { id: 'gb:08888888' })],
  ['presence ok', 'presence', () => req('GET', { id: COLEAGO, lon: '-0.20729', lat: '51.50255' })],
  ['presence bad id', 'presence', () => req('GET', { id: 'nope' })],
  ['presence bad lon', 'presence', () => req('GET', { id: COLEAGO, lon: '999', lat: '1' })],
  ['presence not found', 'presence', () => req('GET', { id: '00000000-0000-0000-0000-000000000000' })],
  ['report bad body', 'presenceReport', () => req('POST', {}, { id: 'x' })],
  ['report GET', 'presenceReport', () => req('GET', {})],
  ['report no such link', 'presenceReport', () => req('POST', {}, { id: COLEAGO, entity_id: 'gb:00000000' })],
  ['report ok', 'presenceReport', () => req('POST', {}, { id: COLEAGO, entity_id: 'gb:06960521', reason: 'Different company' })],
  ['presence after report', 'presence', () => req('GET', { id: COLEAGO, lon: '-0.20729', lat: '51.50255' })],
];

function mockRes() {
  return { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(t) { this.body = t ? JSON.parse(t) : undefined; } };
}

// Runs every scenario against one set of handlers (in order: presence links are stored before reports).
async function runAll(h) {
  const out = {};
  for (const [name, fn, make] of SCENARIOS) {
    const res = mockRes();
    await h[fn](make(), res);
    out[name] = { status: res.statusCode, headers: res.headers, body: res.body };
  }
  return out;
}

module.exports = { NOW, deps, req, mockRes, runAll, SCENARIOS, memStore, fakeOverture, candidates, COLEAGO, json, fetchFn };
