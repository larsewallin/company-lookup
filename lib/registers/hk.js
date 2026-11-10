// Hong Kong: Companies Registry open-data API (data.cr.gov.hk, "Registered Office Address of Live Local Companies").
// Free, no key, updated daily. Live local companies only (no dissolved companies, no non-Hong Kong companies).
// Fields checked on 2026-11-08: Brn, Chinese_Company_Name, English_Company_Name, Address_of_Registered_Office,
// Company_Type, Date_of_Incorporation (dd-mm-yyyy), Re-domiciliation_Date. Name search is by prefix (begins_with).
'use strict';

const { record } = require('./_common');
const { getJson } = require('../http');

const SRC = 'Companies Registry (Hong Kong)';
const API = 'https://data.cr.gov.hk/cr/api/api/v1/api_builder/json/local/search';
const val = (v) => (v && v !== 'NULL' ? String(v).trim() : null);
const date = (s) => { const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(String(s || '').trim()); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
const normalise = (n) => { const s = String(n || '').replace(/[\s-]/g, '').toUpperCase(); return /^[A-Z]?\d{7,8}$/.test(s) ? s : null; };
const url = (key, op, v) => `${API}?query[0][key1]=${key}&query[0][key2]=${op}&query[0][key3]=${encodeURIComponent(v)}`;

async function query(fetchFn, key, op, v) {
  const d = await getJson(fetchFn, url(key, op, v), { source: SRC });
  return Array.isArray(d) ? d : [];
}

const brief = (r) => ({ number: r.Brn, name: val(r.English_Company_Name) || val(r.Chinese_Company_Name), city: 'Hong Kong', status: 'active', incorporated: date(r.Date_of_Incorporation) });

async function search(fetchFn, q) {
  const s = String(q || '').trim();
  if (!s) return [];
  const n = normalise(s);
  if (n) return (await query(fetchFn, 'Brn', 'equal', n)).map(brief);
  return (await query(fetchFn, 'Comp_name', 'begins_with', s)).slice(0, 15).map(brief);
}

async function get(fetchFn, number) {
  const n = normalise(number);
  if (!n) return null;
  const r = (await query(fetchFn, 'Brn', 'equal', n))[0];
  if (!r) return null;
  const en = val(r.English_Company_Name); const zh = val(r.Chinese_Company_Name);
  const redom = date(r['Re-domiciliation_Date']);
  return record({
    register: { name: SRC, number: r.Brn, gleif_as: [r.Brn], url: 'https://www.icris.cr.gov.hk/' },
    legal_name: en || zh,
    other_names: en && zh ? [zh] : [],
    legal_form: val(r.Company_Type),
    status: 'active',
    status_label: 'Live (on the Companies Register)',
    incorporated: date(r.Date_of_Incorporation),
    registered_address: val(r.Address_of_Registered_Office),
    extra: [['Business Registration Number', r.Brn], redom ? ['Re-domiciled to Hong Kong', redom] : null,
      ['Data', 'Companies Registry open data (live local companies only)']].filter(Boolean),
  });
}

module.exports = { country: 'HK', name: SRC, search, get, normalise };
