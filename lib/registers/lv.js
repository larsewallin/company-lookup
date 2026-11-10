// Latvia: Register of Enterprises (Uzņēmumu reģistrs) open data on data.gov.lv. Free, no key.
'use strict';

const { record, ckan, digits, isoDate } = require('./_common');

const BASE = 'https://data.gov.lv/dati';
const RES = '25e80bf3-f107-4ab4-89ef-251b5b9374e9';
const normalise = (n) => { const s = digits(n); return /^\d{11}$/.test(s) ? s : null; };
const clean = (s) => String(s || '').replace(/^"(.*)"$/, '$1').replace(/\s+/g, ' ').trim();

async function search(fetchFn, q) {
  const n = normalise(q);
  const rows = n
    ? await ckan(fetchFn, BASE, RES, { filters: { regcode: Number(n) } }, 'Latvian Register of Enterprises')
    : await ckan(fetchFn, BASE, RES, { q }, 'Latvian Register of Enterprises');
  return rows.map((r) => ({ number: String(r.regcode), name: clean(r.name), city: r.address ? r.address.split(',')[0] : null,
    status: r.terminated ? 'terminated' : 'active', incorporated: isoDate(r.registered) }));
}

async function get(fetchFn, number) {
  const n = normalise(number);
  if (!n) return null;
  const r = (await ckan(fetchFn, BASE, RES, { filters: { regcode: Number(n) }, limit: 1 }, 'Latvian Register of Enterprises'))[0];
  if (!r) return null;
  const terminated = isoDate(r.terminated);
  return record({
    register: { name: 'Latvian Register of Enterprises', number: n, url: `https://info.ur.gov.lv/#/legal-entity/${n}` },
    legal_name: clean(r.name),
    legal_form: r.type_text || null,
    status: terminated ? 'inactive' : 'active',
    status_label: terminated ? `Terminated ${terminated}` : 'Registered',
    incorporated: isoDate(r.registered),
    ceased: terminated,
    registered_address: [r.address, r.index ? `LV-${r.index}` : null, 'Latvia'].filter(Boolean).join(', '),
    vat: { number: `LV${n}`, registered: null },
    extra: [r.regtype_text ? ['Register', r.regtype_text] : null].filter(Boolean),
  });
}

module.exports = { country: 'LV', name: 'Latvian Register of Enterprises', search, get, normalise };
