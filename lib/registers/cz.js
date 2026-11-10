// Czechia: ARES (Administrativní registr ekonomických subjektů). Free, no key.
// https://ares.gov.cz/ekonomicke-subjekty-v-be/rest
'use strict';

const { getJson } = require('../http');

const BASE = 'https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty';
const FORMS = {
  '101': 'Sole trader', '102': 'Sole trader (farmer)', '105': 'Sole trader', '111': 'General partnership (v.o.s.)',
  '112': 'Limited liability company (s.r.o.)', '113': 'Limited partnership (k.s.)', '121': 'Joint-stock company (a.s.)',
  '205': 'Cooperative', '141': 'Public benefit company (o.p.s.)', '117': 'Foundation', '706': 'Association',
  '931': 'Branch of a foreign company', '421': 'Foreign entity',
};
const SOLE = new Set(['101', '102', '105', '107', '108']);

function normalise(n) {
  const s = String(n || '').replace(/\D/g, '');
  return /^\d{1,8}$/.test(s) ? s.padStart(8, '0') : null;
}

function summary(e) {
  return {
    number: e.ico,
    name: e.obchodniJmeno,
    city: e.sidlo ? e.sidlo.nazevObce || null : null,
    status: e.datumZaniku ? 'ceased' : 'active',
    incorporated: e.datumVzniku || null,
  };
}

async function search(fetchFn, q) {
  const data = await getJson(fetchFn, `${BASE}/vyhledat`, {
    source: 'ARES (Czechia)', method: 'POST', body: { obchodniJmeno: q, start: 0, pocet: 15 },
  });
  return ((data && data.ekonomickeSubjekty) || []).map(summary);
}

async function get(fetchFn, number) {
  const ico = normalise(number);
  if (!ico) return null;
  const e = await getJson(fetchFn, `${BASE}/${ico}`, { source: 'ARES (Czechia)', allow404: true });
  if (!e) return null;
  const reg = e.seznamRegistraci || {};
  const ceased = !!e.datumZaniku || reg.stavZdrojeVr === 'ZANIKLY';
  const situations = [];
  if (reg.stavZdrojeIr === 'AKTIVNI') situations.push({ level: 'stop', label: 'Insolvency register entry', detail: 'ARES shows an active record in the Czech insolvency register.' });
  const vr = (e.dalsiUdaje || []).find((d) => d.datovyZdroj === 'vr');
  return {
    register: { name: 'ARES (Czechia)', number: ico, url: `https://ares.gov.cz/ekonomicke-subjekty?ico=${ico}` },
    legal_name: e.obchodniJmeno,
    other_names: [],
    former_names: [],
    legal_form: FORMS[e.pravniForma] || (e.pravniForma ? `Legal form code ${e.pravniForma}` : null),
    status: ceased ? 'inactive' : 'active',
    status_label: ceased ? `Ceased${e.datumZaniku ? ' ' + e.datumZaniku : ''}` : 'Active',
    incorporated: e.datumVzniku || null,
    ceased: e.datumZaniku || null,
    registered_address: e.sidlo ? [e.sidlo.textovaAdresa, e.sidlo.nazevStatu].filter(Boolean).join(', ') : null,
    industry: (e.czNace || []).filter((c) => c && c !== '00').slice(0, 5).map((c) => ({ code: c, label: 'CZ-NACE' })),
    employees: null,
    size: null,
    website: null,
    vat: e.dic ? { number: e.dic, registered: reg.stavZdrojeDph === 'AKTIVNI' } : null,
    officers: null,
    auditor: null,
    financials: null,
    last_accounts: null,
    situations,
    is_sole_trader: SOLE.has(String(e.pravniForma)),
    court_file: vr && vr.spisovaZnacka ? vr.spisovaZnacka : null,
  };
}

module.exports = { country: 'CZ', name: 'ARES (Czechia)', search, get, normalise };
