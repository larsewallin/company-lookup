// New Caledonia: ISEE RIDET "entreprises actives" on data.gouv.nc (Opendatasoft API, free, no key), queried live.
// Fields checked on 2026-11-09: rid7, denomination, date_entreprises_actives, code_formjur, libelle_formjur, code_ape,
// libelle_naf, code_commune, libelle_commune, province. Active entities only (about 40,500). Individuals (French
// legal-form codes 1x, entrepreneurs individuels) are excluded.
'use strict';

const { record } = require('./_common');
const { getJson } = require('../http');

const SRC = 'RIDET (New Caledonia)';
const API = 'https://data.gouv.nc/api/explore/v2.1/catalog/datasets/entreprises-actives-au-ridet/records';
const normalise = (n) => { const d = String(n || '').replace(/\D/g, ''); return d.length === 7 ? d : d.length === 10 ? d.slice(0, 7) : null; };
const individual = (r) => /^1/.test(String(r.code_formjur || ''));
// GLEIF writes RIDET numbers as 9 digits with spaces (000 813 980).
const quote = (s) => `"${String(s).replace(/["\\]/g, ' ')}"`;

async function query(fetchFn, where, limit = 20) {
  const d = await getJson(fetchFn, `${API}?where=${encodeURIComponent(where)}&limit=${limit}`, { source: SRC });
  return ((d && d.results) || []).filter((r) => !individual(r));
}

async function search(fetchFn, q) {
  const s = String(q || '').trim(); if (!s) return [];
  const n = normalise(s);
  const rows = n && /^\d[\d\s.]*$/.test(s) ? await query(fetchFn, `rid7=${quote(n)}`, 1) : await query(fetchFn, `search(denomination, ${quote(s)})`, 20);
  return rows.map((r) => ({ number: r.rid7, name: r.denomination, city: r.libelle_commune || null, status: 'active' }));
}

async function get(fetchFn, number) {
  const n = normalise(number); if (!n) return null;
  const r = (await query(fetchFn, `rid7=${quote(n)}`, 1))[0];
  if (!r) return null;
  return record({
    register: { name: SRC, number: r.rid7, gleif_as: [r.rid7, ((p) => `${p.slice(0, 3)} ${p.slice(3, 6)} ${p.slice(6)}`)(String(r.rid7).padStart(9, '0'))], url: 'https://data.gouv.nc/explore/dataset/entreprises-actives-au-ridet/' },
    legal_name: r.denomination,
    legal_form: r.libelle_formjur || null,
    status: 'active',
    status_label: `Active in RIDET (${r.date_entreprises_actives || 'latest list'})`,
    registered_address: [r.libelle_commune, r.province, 'New Caledonia'].filter(Boolean).join(', '),
    industry: r.code_ape ? [{ code: r.code_ape, label: r.libelle_naf || 'NAF' }] : [],
    extra: [['RIDET', r.rid7], ['Data', 'ISEE open data, active enterprises (commune only)']],
  });
}

module.exports = { country: 'NC', name: SRC, search, get, normalise };
