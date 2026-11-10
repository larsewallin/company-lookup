// Ireland: Companies Registration Office (CRO) open data on opendata.cro.ie (CKAN). Free, no key.
// The dataset is refreshed periodically, so filing dates can lag by a few weeks.
'use strict';

const { record, ckan, digits, isoDate } = require('./_common');

const BASE = 'https://opendata.cro.ie';
const RES = '3fef41bc-b8f4-4b10-8434-ce51c29b1bba';
const SRC = 'CRO (Ireland)';
const normalise = (n) => { const s = digits(n); return /^\d{1,7}$/.test(s) ? String(Number(s)) : null; };
const INACTIVE = /dissolved|struck off|ceased|deleted|de-registered|conv\. to/i;
const STOP = /liquidation|administration|examinership|receivership/i;

function monthsBefore(iso, months) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

async function search(fetchFn, q) {
  const n = normalise(q);
  const rows = n && /^\s*\d+\s*$/.test(q)
    ? await ckan(fetchFn, BASE, RES, { filters: { company_num: Number(n) } }, SRC)
    : await ckan(fetchFn, BASE, RES, { q, limit: 20 }, SRC);
  return rows.map((r) => ({ number: String(r.company_num), name: r.company_name, city: r.company_address_4 || r.company_address_3 || null,
    status: /^normal/i.test(String(r.company_status).trim()) ? 'active' : String(r.company_status).trim().toLowerCase(), incorporated: isoDate(r.company_reg_date) }));
}

async function get(fetchFn, number, { asOfIso } = {}) {
  const n = normalise(number);
  if (!n) return null;
  const r = (await ckan(fetchFn, BASE, RES, { filters: { company_num: Number(n) }, limit: 1 }, SRC))[0];
  if (!r) return null;
  const st = String(r.company_status || '').trim();
  const situations = [];
  if (st === 'Strike Off Listed') situations.push({ level: 'stop', label: 'Listed for strike-off', detail: 'The CRO lists the company for strike-off, usually for missing annual returns.' });
  if (STOP.test(st) && !/stayed/i.test(st)) situations.push({ level: 'stop', label: st, detail: `CRO status: "${st}".` });
  const nard = isoDate(r.nard);
  // Annual returns are due 28 days after the return date; allow two more months for the open data to catch up.
  if (/^normal/i.test(st) && nard && asOfIso && nard < monthsBefore(asOfIso, 3)) {
    situations.push({ level: 'check', label: 'Annual return overdue', detail: `The annual return date was ${nard} and the CRO data shows no return filed since.` });
  }
  return record({
    register: { name: 'Companies Registration Office (Ireland)', number: n, url: `https://core.cro.ie/` },
    legal_name: r.company_name,
    legal_form: r.company_type || null,
    status: INACTIVE.test(st) ? 'inactive' : 'active',
    status_label: st || 'Unknown',
    incorporated: isoDate(r.company_reg_date),
    ceased: isoDate(r.comp_dissolved_date),
    registered_address: [r.company_address_1, r.company_address_2, r.company_address_3, r.company_address_4, r.eircode, 'Ireland'].filter((x) => x && String(x).trim()).join(', '),
    industry: r.nace_v2_code ? [{ code: String(r.nace_v2_code), label: 'NACE' }] : [],
    last_accounts: r.last_accounts_date ? String(r.last_accounts_date).slice(0, 4) : null,
    extra: [isoDate(r.last_ar_date) ? ['Last annual return', isoDate(r.last_ar_date)] : null, nard ? ['Next annual return date', nard] : null,
      isoDate(r.last_accounts_date) ? ['Last accounts made up to', isoDate(r.last_accounts_date)] : null].filter(Boolean),
    situations,
  });
}

module.exports = { country: 'IE', name: 'CRO (Ireland)', search, get, normalise };
