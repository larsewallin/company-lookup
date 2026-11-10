// Finland: PRH / YTJ open data API v3. Free, no key. CC BY 4.0.
// https://avoindata.prh.fi/opendata-ytj-api/v3
'use strict';

const { getJson } = require('../http');

const BASE = 'https://avoindata.prh.fi/opendata-ytj-api/v3/companies';

function normalise(n) {
  const s = String(n || '').replace(/\s/g, '');
  if (/^\d{7}-\d$/.test(s)) return s;
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 7)}-${s.slice(7)}`;
  return null;
}

const en = (descs) => {
  const d = (descs || []).find((x) => x.languageCode === '3') || (descs || [])[0];
  return d ? d.description : null;
};

function current(list) { return (list || []).filter((x) => !x.endDate); }

function address(c) {
  const a = (c.addresses || []).find((x) => x.type === 1) || (c.addresses || [])[0];
  if (!a) return null;
  const city = (a.postOffices || []).find((p) => p.languageCode === '1') || (a.postOffices || [])[0];
  const street = [a.street, a.buildingNumber, a.entrance, a.apartmentNumber].filter(Boolean).join(' ') || (a.postOfficeBox ? `PO Box ${a.postOfficeBox}` : '');
  return [a.co ? `c/o ${a.co}` : null, street, [a.postCode, city && city.city].filter(Boolean).join(' '), 'Finland'].filter(Boolean).join(', ');
}

function summary(c) {
  const name = current(c.names).find((n) => n.type === '1') || (c.names || [])[0];
  const city = (() => { const a = (c.addresses || [])[0]; const p = a && (a.postOffices || [])[0]; return p ? p.city : null; })();
  return {
    number: c.businessId.value,
    name: name ? name.name : null,
    city,
    status: c.endDate || c.tradeRegisterStatus === '4' ? 'ceased' : 'active',
    incorporated: (c.businessId && c.businessId.registrationDate) || c.registrationDate || null,
  };
}

async function search(fetchFn, q) {
  const data = await getJson(fetchFn, `${BASE}?name=${encodeURIComponent(q)}`, { source: 'PRH (Finland)' });
  return ((data && data.companies) || []).slice(0, 15).map(summary);
}

async function get(fetchFn, number) {
  const id = normalise(number);
  if (!id) return null;
  const data = await getJson(fetchFn, `${BASE}?businessId=${encodeURIComponent(id)}`, { source: 'PRH (Finland)', allow404: true });
  const c = data && (data.companies || []).find((x) => x.businessId && x.businessId.value === id);
  if (!c) return null;
  const s = summary(c);
  const names = c.names || [];
  const form = current(c.companyForms)[0];
  const situations = (c.companySituations || []).filter((x) => !x.endDate).map((x) => ({
    level: 'stop', label: en(x.descriptions) || `Register situation ${x.type}`, detail: `The register shows "${en(x.descriptions) || x.type}"${x.registrationDate ? ' since ' + x.registrationDate : ''}.`,
  }));
  const vatRegistered = (c.registeredEntries || []).some((r) => r.register === '6' && !r.endDate);
  return {
    register: { name: 'Finnish Trade Register (PRH / YTJ)', number: id, url: `https://tietopalvelu.ytj.fi/yritys/${id}` },
    legal_name: s.name,
    other_names: current(names).filter((n) => n.type !== '1').map((n) => n.name),
    former_names: names.filter((n) => n.type === '1' && n.endDate).map((n) => ({ name: n.name, to: n.endDate })),
    legal_form: form ? en(form.descriptions) : null,
    status: s.status === 'active' ? 'active' : 'inactive',
    status_label: s.status === 'active' ? 'Registered' : `Ceased${c.endDate ? ' ' + c.endDate : ''}`,
    incorporated: s.incorporated,
    ceased: c.endDate || null,
    registered_address: address(c),
    industry: c.mainBusinessLine ? [{ code: c.mainBusinessLine.type, label: en(c.mainBusinessLine.descriptions) }] : [],
    employees: null,
    size: null,
    website: c.website && c.website.url ? c.website.url : null,
    vat: { number: `FI${id.replace('-', '')}`, registered: vatRegistered },
    officers: null,
    auditor: null,
    financials: null,
    last_accounts: null,
    situations,
    is_sole_trader: !!(form && /sole trader|toiminimi|private trader/i.test(en(form.descriptions) || '')),
  };
}

module.exports = { country: 'FI', name: 'PRH (Finland)', search, get, normalise };
