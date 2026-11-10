// Companies House (UK) and RDAP domain records. No dependencies.
// Each function takes an injectable fetch so tests can run offline.
'use strict';

const { getJson, SourceError } = require('./http');

const CH_BASE = 'https://api.company-information.service.gov.uk';
const RDAP_BASE = 'https://rdap.org/domain/';
// ---------- Companies House ----------

function chHeaders(apiKey) {
  // Basic auth: the API key is the username, the password is empty.
  return { Authorization: 'Basic ' + Buffer.from(apiKey + ':').toString('base64') };
}

async function chSearch(fetchFn, apiKey, query) {
  const url = `${CH_BASE}/search/companies?q=${encodeURIComponent(query)}&items_per_page=10`;
  const data = await getJson(fetchFn, url, { headers: chHeaders(apiKey), source: 'Companies House' });
  return (data && data.items ? data.items : []).map((it) => ({
    company_number: it.company_number,
    name: it.title,
    status: it.company_status || null,
    incorporated: it.date_of_creation || null,
    address: it.address_snippet || null,
    type: it.company_type || null,
  }));
}

// Fetches everything the card needs for one company. Profile is required;
// the rest are optional and become gaps if they fail.
async function chCompany(fetchFn, apiKey, number) {
  const h = chHeaders(apiKey);
  const src = 'Companies House';
  const profile = await getJson(fetchFn, `${CH_BASE}/company/${number}`, { headers: h, source: src, allow404: true });
  if (!profile) return null;

  const part = async (path, allow404 = true) => {
    try {
      return { ok: true, data: await getJson(fetchFn, `${CH_BASE}/company/${number}${path}`, { headers: h, source: src, allow404 }) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  };
  const [officers, psc, charges, insolvency] = await Promise.all([
    part('/officers?items_per_page=100'),
    part('/persons-with-significant-control?items_per_page=100'),
    profile.has_charges ? part('/charges?items_per_page=100') : Promise.resolve({ ok: true, data: null }),
    profile.has_insolvency_history ? part('/insolvency') : Promise.resolve({ ok: true, data: null }),
  ]);
  return { profile, officers, psc, charges, insolvency };
}

// ---------- RDAP (domain age) ----------

function normaliseDomain(input) {
  if (!input) return null;
  let s = String(input).trim().toLowerCase();
  s = s.replace(/^[a-z]+:\/\//, '').split(/[/?#]/)[0].replace(/:\d+$/, '').replace(/^www\./, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) || s.length > 253) return null;
  return s;
}

// RDAP: ask the registry for the domain's TLD directly, found through IANA's bootstrap file.
// (The rdap.org redirector proved unreliable from the hosting provider.) Falls back to rdap.org.
const IANA_BOOTSTRAP = 'https://data.iana.org/rdap/dns.json';
const RDAP_HEADERS = { Accept: 'application/rdap+json, application/json' };
let bootstrap = null; // { at, map: { tld: baseUrl } }

async function rdapBase(fetchFn, tld) {
  if (!bootstrap || Date.now() - bootstrap.at > 24 * 3600 * 1000) {
    const data = await getJson(fetchFn, IANA_BOOTSTRAP, { source: 'IANA RDAP bootstrap' });
    const map = {};
    for (const [tlds, urls] of (data && data.services) || []) {
      const url = (urls || []).find((u) => u.startsWith('https://')) || (urls || [])[0];
      for (const t of tlds || []) if (url) map[t.toLowerCase()] = url.endsWith('/') ? url : url + '/';
    }
    bootstrap = { at: Date.now(), map };
  }
  return bootstrap.map[tld] || null;
}

async function rdapDomain(fetchFn, domain) {
  const tld = domain.split('.').pop();
  let base = null;
  try { base = await rdapBase(fetchFn, tld); } catch (e) { base = null; }
  if (!base && bootstrap) return { found: false, no_rdap: true }; // the TLD's registry offers no RDAP
  const url = base ? `${base}domain/${encodeURIComponent(domain)}` : RDAP_BASE + encodeURIComponent(domain);
  const data = await getJson(fetchFn, url, { source: 'RDAP', allow404: true, headers: RDAP_HEADERS });
  if (!data) return { found: false };
  const ev = (data.events || []).find((e) => e.eventAction === 'registration');
  return { found: true, registered: ev ? String(ev.eventDate).slice(0, 10) : null };
}

function _resetRdapCache() { bootstrap = null; }

module.exports = { chSearch, chCompany, rdapDomain, normaliseDomain, SourceError, _resetRdapCache };
