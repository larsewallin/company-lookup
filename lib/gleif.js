// GLEIF: the free global LEI database. No key. Used as the global base source.
'use strict';

const { getJson } = require('./http');

const BASE = 'https://api.gleif.org/api/v1';

function addr(a) {
  if (!a) return null;
  return [...(a.addressLines || []), a.city, a.region, a.postalCode, a.country].filter(Boolean).join(', ') || null;
}

// Short form for search results.
function summary(rec) {
  const a = rec.attributes || rec;
  const e = a.entity || {};
  return {
    id: `lei:${a.lei}`,
    source: 'GLEIF',
    name: e.legalName ? e.legalName.name : null,
    country: e.legalAddress ? e.legalAddress.country : null,
    city: e.legalAddress ? e.legalAddress.city : null,
    status: e.status ? e.status.toLowerCase() : null,
    number: e.registeredAs || null,
    lei: a.lei,
  };
}

// Legal-form words ignored when comparing names, so "Siemens Aktiengesellschaft" matches "siemens".
const FORM_WORDS = new Set(['ag', 'aktiengesellschaft', 'gmbh', 'mbh', 'kg', 'co', 'ohg', 'se', 'sa', 'sas', 'sarl', 'srl', 'spa', 'bv', 'nv',
  'ab', 'publ', 'as', 'asa', 'oy', 'oyj', 'aps', 'a/s', 'ltd', 'limited', 'plc', 'llp', 'lp', 'llc', 'inc', 'incorporated', 'corp',
  'corporation', 'company', 'the', 'holding', 'holdings', 'group', 'kk', 'pty', 'pte', 'sl', 'sp', 'zoo', 'ev', 'eg', 'ug']);

function normName(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/\./g, '')
    .replace(/[^a-z0-9/ ]+/g, ' ').split(/\s+/).filter((w) => w && !FORM_WORDS.has(w)).join(' ');
}

// Best match first: exact name, then names starting with the query, then the rest.
// Ties: active before inactive, companies before funds, shorter names first.
function rank(recs, q) {
  const nq = normName(q);
  const score = (r) => {
    const e = r.attributes.entity || {};
    const n = normName(e.legalName && e.legalName.name);
    const others = (e.otherNames || []).map((x) => normName(x.name));
    const tier = n === nq || others.includes(nq) ? 0 : n.startsWith(nq + ' ') ? 1 : (' ' + n + ' ').includes(' ' + nq + ' ') ? 2 : 3;
    return [tier, e.status === 'ACTIVE' ? 0 : 1, e.category === 'FUND' ? 1 : 0, n.split(' ').length, n];
  };
  return recs.map((r) => [score(r), r]).sort((a, b) => {
    for (let i = 0; i < a[0].length; i++) if (a[0][i] !== b[0][i]) return a[0][i] < b[0][i] ? -1 : 1;
    return 0;
  }).map((x) => x[1]);
}

const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;
const isIsin = (q) => ISIN_RE.test(String(q).toUpperCase().replace(/\s/g, ''));

// Records for a list of LEIs (used for ticker matches), in GLEIF summary form.
async function byLeis(fetchFn, leis) {
  if (!leis.length) return [];
  const got = await getJson(fetchFn, `${BASE}/lei-records?filter%5Blei%5D=${leis.slice(0, 20).join(',')}&page%5Bsize%5D=20`, { source: 'GLEIF' });
  return ((got && got.data) || []).map(summary);
}

// Securities (ISINs) GLEIF links to an LEI: shares and bonds. Total plus the first few.
async function isins(fetchFn, lei) {
  try {
    const d = await getJson(fetchFn, `${BASE}/lei-records/${lei}/isins?page%5Bsize%5D=10`, { source: 'GLEIF', allow404: true });
    if (!d) return null;
    const total = d.meta && d.meta.pagination ? d.meta.pagination.total : (d.data || []).length;
    return total ? { total, items: (d.data || []).map((x) => x.attributes && x.attributes.isin).filter(Boolean) } : null;
  } catch (e) {
    return null;
  }
}

async function search(fetchFn, q, country) {
  // An ISIN goes straight to the issuer.
  if (isIsin(q)) {
    const d = await getJson(fetchFn, `${BASE}/lei-records?filter%5Bisin%5D=${encodeURIComponent(String(q).toUpperCase().replace(/\s/g, ''))}`, { source: 'GLEIF' });
    return ((d && d.data) || []).map(summary).map((r) => ({ ...r, isin: String(q).toUpperCase().replace(/\s/g, '') }));
  }
  const c = country ? `&filter%5Bentity.legalAddress.country%5D=${encodeURIComponent(country)}` : '';
  const data = await getJson(fetchFn, `${BASE}/lei-records?filter%5Bfulltext%5D=${encodeURIComponent(q)}${c}&page%5Bsize%5D=50`, { source: 'GLEIF' });
  let recs = (data && data.data) || [];
  if (!recs.length) {
    // Fall back to fuzzy name matching for misspellings.
    const fz = await getJson(fetchFn, `${BASE}/fuzzycompletions?field=entity.legalName&q=${encodeURIComponent(q)}`, { source: 'GLEIF' });
    const leis = ((fz && fz.data) || [])
      .map((d) => d.relationships && d.relationships['lei-records'] && d.relationships['lei-records'].data && d.relationships['lei-records'].data.id)
      .filter(Boolean).slice(0, 15);
    if (leis.length) {
      const got = await getJson(fetchFn, `${BASE}/lei-records?filter%5Blei%5D=${leis.join(',')}&page%5Bsize%5D=15`, { source: 'GLEIF' });
      recs = ((got && got.data) || []).filter((r) => !country || ((r.attributes.entity || {}).legalAddress || {}).country === country);
    }
  }
  return rank(recs, q).slice(0, 15).map(summary);
}

async function parent(fetchFn, lei, kind) {
  try {
    const p = await getJson(fetchFn, `${BASE}/lei-records/${lei}/${kind}`, { source: 'GLEIF', allow404: true });
    if (!p || !p.data) return null;
    const s = summary(p.data);
    return { lei: s.lei, name: s.name, country: s.country, status: s.status };
  } catch (e) {
    return { error: e.message };
  }
}

// Full record plus parents, normalised for the card.
// Why GLEIF has no parent for an entity (reporting exceptions), in plain words.
const EXCEPTIONS = {
  NO_KNOWN_PERSON: 'No controlling parent: ownership is widely held or no one controls the company',
  NATURAL_PERSONS: 'Controlled by one or more private individuals, not by a company',
  NON_CONSOLIDATING: 'Has a parent, but the parent does not consolidate it in its accounts',
  NO_LEI: 'Has a parent that has no LEI',
  NON_PUBLIC: 'Has a parent that is not disclosed',
  BINDING_LEGAL_COMMITMENTS: 'Has a parent that is not disclosed (legal commitments)',
  LEGAL_OBSTACLES: 'Has a parent that is not disclosed (legal obstacles)',
  DISCLOSURE_DETRIMENTAL: 'Has a parent that is not disclosed (disclosure would be detrimental)',
  DETRIMENT_NOT_EXCLUDED: 'Has a parent that is not disclosed (possible detriment)',
  CONSENT_NOT_OBTAINED: 'Has a parent that is not disclosed (consent not obtained)',
};
const UNDISCLOSED = new Set(['NON_PUBLIC', 'BINDING_LEGAL_COMMITMENTS', 'LEGAL_OBSTACLES', 'DISCLOSURE_DETRIMENTAL', 'DETRIMENT_NOT_EXCLUDED', 'CONSENT_NOT_OBTAINED']);

async function exception(fetchFn, lei, kind) {
  try {
    const d = await getJson(fetchFn, `${BASE}/lei-records/${lei}/${kind}-parent-reporting-exception`, { source: 'GLEIF', allow404: true });
    const a = d && d.data && d.data.attributes;
    if (!a || !a.reason) return null;
    return { reason: a.reason, label: EXCEPTIONS[a.reason] || a.reason, undisclosed: UNDISCLOSED.has(a.reason), reference: a.reference || null };
  } catch (e) {
    return null;
  }
}

// Subsidiaries: total and the first page (up to 50), active first.
async function children(fetchFn, lei, kind, size = 50) {
  try {
    const d = await getJson(fetchFn, `${BASE}/lei-records/${lei}/${kind}-children?page%5Bsize%5D=${size}`, { source: 'GLEIF', allow404: true });
    if (!d) return { total: 0, items: [] };
    const total = d.meta && d.meta.pagination ? d.meta.pagination.total : (d.data || []).length;
    const items = (d.data || []).map((x) => { const s = summary(x); return { lei: s.lei, name: s.name, country: s.country, status: s.status }; })
      .sort((a, b) => (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1) || String(a.name).localeCompare(String(b.name)));
    return { total, items };
  } catch (e) {
    return { error: e.message, total: null, items: [] };
  }
}

async function record(fetchFn, lei) {
  const data = await getJson(fetchFn, `${BASE}/lei-records/${encodeURIComponent(lei)}`, { source: 'GLEIF', allow404: true });
  if (!data || !data.data) return null;
  const a = data.data.attributes || {};
  const e = a.entity || {};
  const r = a.registration || {};
  const [direct, ultimate, kids, allKids, securities] = await Promise.all([
    parent(fetchFn, a.lei, 'direct-parent'), parent(fetchFn, a.lei, 'ultimate-parent'),
    children(fetchFn, a.lei, 'direct'), children(fetchFn, a.lei, 'ultimate', 1), isins(fetchFn, a.lei),
  ]);
  // Why there is no parent, and how big the whole group is (counted from the top).
  const [directEx, ultimateEx, groupKids] = await Promise.all([
    !direct ? exception(fetchFn, a.lei, 'direct') : null,
    !ultimate ? exception(fetchFn, a.lei, 'ultimate') : null,
    ultimate && !ultimate.error && ultimate.lei !== a.lei ? children(fetchFn, ultimate.lei, 'ultimate', 1) : null,
  ]);
  return {
    lei: a.lei,
    legal_name: e.legalName ? e.legalName.name : null,
    other_names: (e.otherNames || []).map((n) => n.name).filter(Boolean),
    country: e.legalAddress ? e.legalAddress.country : null,
    jurisdiction: e.jurisdiction || null,
    legal_form: e.legalForm ? (e.legalForm.other || (e.legalForm.id ? `${e.legalForm.id} (ELF code)` : null)) : null,
    status: e.status || null, // ACTIVE | INACTIVE
    created: e.creationDate ? String(e.creationDate).slice(0, 10) : null,
    expiration: e.expiration && (e.expiration.date || e.expiration.reason)
      ? { date: e.expiration.date ? String(e.expiration.date).slice(0, 10) : null, reason: e.expiration.reason || null } : null,
    successor: e.successorEntity && (e.successorEntity.lei || e.successorEntity.name) ? { lei: e.successorEntity.lei || null, name: e.successorEntity.name || null } : null,
    legal_address: addr(e.legalAddress),
    hq_address: addr(e.headquartersAddress),
    hq_country: e.headquartersAddress ? e.headquartersAddress.country : null,
    registered_at: e.registeredAt ? e.registeredAt.id || null : null,
    registered_as: e.registeredAs || null,
    category: e.category || null,
    lei_status: r.status || null, // ISSUED | LAPSED | RETIRED | MERGED ...
    lei_next_renewal: r.nextRenewalDate ? String(r.nextRenewalDate).slice(0, 10) : null,
    lei_last_update: r.lastUpdateDate ? String(r.lastUpdateDate).slice(0, 10) : null,
    ocid: a.ocid || null,
    bic: a.bic || null,
    direct_parent: direct && !direct.error ? direct : null,
    ultimate_parent: ultimate && !ultimate.error ? ultimate : null,
    parent_errors: [direct, ultimate].some((x) => x && x.error),
    direct_parent_exception: directEx,
    ultimate_parent_exception: ultimateEx,
    direct_children: kids,
    ultimate_children_total: allKids.total,
    securities,
    // Entities in the whole group under the ultimate parent, including the parent itself.
    group_size: groupKids && groupKids.total != null ? groupKids.total + 1 : (!ultimate && allKids.total ? allKids.total + 1 : null),
  };
}

// Used by the UK path: find an LEI from a Companies House number.
async function byRegistration(fetchFn, number, country = 'GB') {
  const url = `${BASE}/lei-records?filter%5Bentity.registeredAs%5D=${encodeURIComponent(number)}` +
    `&filter%5Bentity.legalAddress.country%5D=${country}&page%5Bsize%5D=5`;
  const data = await getJson(fetchFn, url, { source: 'GLEIF' });
  const rec = data && data.data && data.data[0];
  return rec ? rec.attributes.lei : null;
}

module.exports = { search, record, byRegistration, byLeis, isins, isIsin, summary, rank, normName };
