// Estonia: e-Business Register (Äriregister) public autocomplete. Free, no key.
'use strict';

const { getJson } = require('../http');

const BASE = 'https://ariregister.rik.ee/est/api/autocomplete';
const STATUS = { R: ['active', 'Registered'], L: ['liquidation', 'In liquidation'], N: ['bankrupt', 'In bankruptcy'], K: ['inactive', 'Deleted'] };

function normalise(n) {
  const s = String(n || '').replace(/\D/g, '');
  return /^\d{8}$/.test(s) ? s : null;
}

function legalForm(name) {
  const m = String(name || '').match(/\b(OÜ|AS|MTÜ|SA|TÜ|UÜ|FIE)\s*$/i);
  const map = { OÜ: 'Private limited company (OÜ)', AS: 'Public limited company (AS)', MTÜ: 'Non-profit association (MTÜ)',
    SA: 'Foundation (SA)', TÜ: 'General partnership (TÜ)', UÜ: 'Limited partnership (UÜ)', FIE: 'Sole trader (FIE)' };
  return m ? map[m[1].toUpperCase()] || m[1] : null;
}

async function search(fetchFn, q) {
  const data = await getJson(fetchFn, `${BASE}?q=${encodeURIComponent(q)}`, { source: 'Äriregister (Estonia)' });
  return ((data && data.data) || []).slice(0, 15).map((c) => ({
    number: String(c.reg_code),
    name: c.name,
    city: c.legal_address ? (c.legal_address.split(',')[1] || '').trim() || null : null,
    status: (STATUS[c.status] || [c.status])[0],
    incorporated: null,
  }));
}

async function get(fetchFn, number) {
  const code = normalise(number);
  if (!code) return null;
  const data = await getJson(fetchFn, `${BASE}?q=${code}`, { source: 'Äriregister (Estonia)' });
  const c = ((data && data.data) || []).find((x) => String(x.reg_code) === code);
  if (!c) return null;
  const [status, label] = STATUS[c.status] || ['active', c.status];
  const situations = [];
  if (c.status === 'L') situations.push({ level: 'stop', label: 'In liquidation', detail: 'The register shows the company is in liquidation.' });
  if (c.status === 'N') situations.push({ level: 'stop', label: 'Bankruptcy', detail: 'The register shows the company is in bankruptcy.' });
  return {
    register: { name: 'e-Business Register (Estonia)', number: code, url: c.url || `https://ariregister.rik.ee/eng/company/${code}` },
    legal_name: c.name,
    other_names: [],
    former_names: (c.historical_names || []).map((n) => ({ name: n, to: null })),
    legal_form: legalForm(c.name),
    status: status === 'inactive' ? 'inactive' : 'active',
    status_label: label,
    incorporated: null,
    ceased: null,
    registered_address: [c.legal_address, c.zip_code, 'Estonia'].filter(Boolean).join(', '),
    industry: [],
    employees: null,
    size: null,
    website: null,
    vat: null,
    officers: null,
    auditor: null,
    financials: null,
    last_accounts: null,
    situations,
    is_sole_trader: /\bFIE\s*$/i.test(c.name || ''),
  };
}

module.exports = { country: 'EE', name: 'Äriregister (Estonia)', search, get, normalise };
