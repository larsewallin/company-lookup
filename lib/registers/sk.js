// Slovakia: Register of Legal Entities (RPO) by the Statistical Office. Free, no key.
// https://api.statistics.sk/rpo/v1
'use strict';

const { getJson } = require('../http');
const { record, digits } = require('./_common');

const BASE = 'https://api.statistics.sk/rpo/v1/search';
const current = (list) => (list || []).find((x) => !x.validTo) || (list || [])[(list || []).length - 1] || null;

function normalise(n) {
  const s = digits(n);
  return /^\d{6,8}$/.test(s) ? s.padStart(8, '0') : null;
}

function addr(a) {
  if (!a) return null;
  return [[a.street, a.buildingNumber || (a.regNumber ? String(a.regNumber) : null)].filter(Boolean).join(' '),
    [(a.postalCodes || [])[0], a.municipality && a.municipality.value].filter(Boolean).join(' '), a.country && a.country.value].filter(Boolean).join(', ') || null;
}

function toRecord(e) {
  const name = current(e.fullNames);
  const ico = current(e.identifiers);
  const reg = e.sourceRegister && e.sourceRegister.value ? e.sourceRegister.value.value : null;
  const regCode = e.sourceRegister && e.sourceRegister.value ? e.sourceRegister.value.code : null;
  const nm = name ? name.value : null;
  const situations = [];
  if (!e.termination && /v likvid[aá]cii/i.test(nm || '')) situations.push({ level: 'stop', label: 'In liquidation', detail: 'The registered name says the company is in liquidation (v likvidácii).' });
  if (!e.termination && /v konkurze/i.test(nm || '')) situations.push({ level: 'stop', label: 'Bankruptcy', detail: 'The registered name says the company is in bankruptcy (v konkurze).' });
  return record({
    register: { name: `Register of Legal Entities (RPO, Slovakia)${reg ? ' · ' + reg : ''}`, number: ico ? ico.value : String(e.id), url: `https://rpo.statistics.sk/rpo/#/detail/${e.id}` },
    legal_name: nm,
    former_names: (e.fullNames || []).filter((n) => n.validTo).map((n) => ({ name: n.value, to: n.validTo })),
    status: e.termination ? 'inactive' : 'active',
    status_label: e.termination ? `Terminated ${e.termination}` : 'Active',
    incorporated: e.establishment || null,
    ceased: e.termination || null,
    registered_address: addr(current(e.addresses)),
    extra: [reg ? ['Source register', reg] : null,
      e.sourceRegister && e.sourceRegister.registrationNumbers && e.sourceRegister.registrationNumbers[0] ? ['File number', e.sourceRegister.registrationNumbers[0].value] : null].filter(Boolean),
    situations,
    is_sole_trader: regCode === '2',
  });
}

async function search(fetchFn, q) {
  const n = normalise(q);
  const url = n && /^\s*\d[\d\s]*$/.test(q) ? `${BASE}?identifier=${n}` : `${BASE}?fullName=${encodeURIComponent(q)}`;
  const d = await getJson(fetchFn, url, { source: 'RPO (Slovakia)' });
  return ((d && d.results) || []).slice(0, 25).map((e) => {
    const r = toRecord(e);
    const city = current(e.addresses);
    return { number: r.register.number, name: r.legal_name, city: city && city.municipality ? city.municipality.value : null,
      status: e.termination ? 'terminated' : 'active', incorporated: e.establishment || null };
  });
}

async function get(fetchFn, number) {
  const ico = normalise(number);
  if (!ico) return null;
  const d = await getJson(fetchFn, `${BASE}?identifier=${ico}`, { source: 'RPO (Slovakia)' });
  const list = (d && d.results) || [];
  const e = list.find((x) => !x.termination) || list[0];
  return e ? toRecord(e) : null;
}

module.exports = { country: 'SK', name: 'RPO (Slovakia)', search, get, normalise };
