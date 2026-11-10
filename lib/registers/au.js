// Australia: ASIC company dataset on data.gov.au (CKAN datastore). Free, no key. Refreshed weekly.
// One row per company name: the row marked "Current Name Indicator" = Y carries the current name;
// older names come as extra rows with the current name in "Current Name". No addresses in this dataset.
'use strict';

const { record, ckan, digits } = require('./_common');

const BASE = 'https://data.gov.au/data';
const RES = '5c3914e6-413e-4a2c-b890-bf8efe3eabf2';
const SRC = 'ASIC (Australia)';

// ACN is 9 digits; an ABN is 11 digits and, for companies, ends in the ACN.
const normalise = (n) => { const s = digits(n); return s.length === 9 ? s : s.length === 11 ? s.slice(2) : null; };

const STATUS = {
  REGD: ['active', 'Registered'], EXAD: ['active', 'Under external administration'], SOFF: ['active', 'Strike-off action in progress'],
  NOAC: ['inactive', 'Not active'], DRGD: ['inactive', 'Deregistered'], CNCL: ['inactive', 'Cancelled'], DISS: ['inactive', 'Dissolved'],
};
const TYPE = { APTY: 'Australian proprietary company', APUB: 'Australian public company', FNOS: 'Foreign company', RACN: 'Registered Australian body', RACA: 'Registered Australian body', ASSN: 'Association', TRST: 'Trust', NONC: 'Non-company' };
const CLASS = { LMSH: 'limited by shares', LMGT: 'limited by guarantee', UNLM: 'unlimited', NLTD: 'no liability', LMSG: 'limited by shares and guarantee' };
const SUB = { LIST: 'listed', LISN: 'listed', ULST: 'unlisted', ULSN: 'unlisted', ULSS: 'unlisted superannuation trustee', PSTC: 'superannuation trustee', PNPC: 'not-for-profit', HUNT: 'home unit company' };

const auDate = (s) => { const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(s || '').trim()); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
const currentName = (r) => (r['Current Name Indicator'] === 'Y' || !r['Current Name'] ? r['Company Name'] : r['Current Name']);
const status = (r) => STATUS[r.Status] || ['active', r.Status || 'Unknown'];

// Collapse name rows into one hit per ACN, keeping the current name.
function byAcn(rows) {
  const out = new Map();
  for (const r of rows) {
    const acn = r.ACN && String(r.ACN).padStart(9, '0');
    if (!acn || out.has(acn)) continue;
    out.set(acn, { number: acn, name: currentName(r), status: status(r)[0], incorporated: auDate(r['Date of Registration']) });
  }
  return [...out.values()];
}

async function search(fetchFn, q) {
  const n = /^[\d\s]+$/.test(String(q).trim()) ? normalise(q) : null;
  const rows = n
    ? await ckan(fetchFn, BASE, RES, { filters: { ACN: n } }, SRC)
    : await ckan(fetchFn, BASE, RES, { q, limit: 30 }, SRC);
  return byAcn(rows);
}

async function get(fetchFn, number) {
  const n = normalise(number);
  if (!n) return null;
  const rows = await ckan(fetchFn, BASE, RES, { filters: { ACN: n }, limit: 20 }, SRC);
  if (!rows.length) return null;
  const r = rows.find((x) => x['Current Name Indicator'] === 'Y') || rows[0];
  const name = currentName(r);
  const [st, label] = status(r);
  const situations = [];
  if (r.Status === 'EXAD') situations.push({ level: 'stop', label: 'Under external administration', detail: 'ASIC shows the company in external administration (administration, liquidation or receivership).' });
  if (r.Status === 'SOFF') situations.push({ level: 'stop', label: 'Strike-off action in progress', detail: 'ASIC has started deregistering the company, often after missed annual reviews or fees.' });
  const form = [TYPE[r.Type] || r.Type, CLASS[r.Class], SUB[r['Sub Class']]].filter(Boolean).join(', ');
  const former = [...new Set(rows.map((x) => x['Company Name']).filter((x) => x && x !== name))].map((x) => ({ name: x }));
  return record({
    register: { name: 'ASIC (Australia)', number: n, gleif_as: `${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6)}`, url: `https://connectonline.asic.gov.au/RegistrySearch/faces/landing/SearchRegisters.jspx` },
    legal_name: name,
    former_names: former,
    legal_form: form || null,
    status: st,
    status_label: label,
    incorporated: auDate(r['Date of Registration']),
    ceased: auDate(r['Date of Deregistration']),
    extra: [r.ABN ? ['ABN', String(r.ABN)] : null, r['Previous State of Registration'] ? ['Previously registered in', r['Previous State of Registration']] : null].filter(Boolean),
    situations,
  });
}

module.exports = { country: 'AU', name: 'ASIC (Australia)', search, get, normalise };
