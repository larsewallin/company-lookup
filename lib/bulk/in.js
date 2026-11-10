// India: Ministry of Corporate Affairs company registrations, republished on the India Data Portal (CKAN dataset
// company-registrations, ODC Attribution). Layout checked on 2026-11-08. Six CSVs:
//   Indian Company Registrations (2016 to late 2023): id, registration_date, cin, state_name, state_code, roc,
//     company_name, company_status, company_type, company_class, company_category, act_description, company_address,
//     company_email, authorized_capital, paidup_capital
//   Indian Company Registrations New (from 2023-11): id, cin, company_class, company_name, registration_date,
//     company_type, act_code, act_description
//   LLP registrations (old: llpin, llp_name, incorporation_date, llp_status, ..., company_address; new: llpin,
//     llp_name, registration_date, act_code, act_description) and foreign company registrations (fcin, office_type).
// Only companies registered since 2016 are included, and company_status is almost always "Not Available", so the
// current status (struck off, under liquidation) is not known from this data. Company e-mails are left out.
'use strict';

const { records } = require('./csv');

const clean = (s) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return /^not available$/i.test(t) ? '' : t; };
const day = (s) => { const m = /^(\d{4}-\d{2}-\d{2})/.exec(clean(s)); return m ? m[1] : null; };
const money = (s) => { const n = Number(clean(s)); return Number.isFinite(n) && n > 0 ? String(Math.round(n)) : null; };

function status(raw) {
  const s = clean(raw).toLowerCase();
  if (!s) return ['active', 'Registered (current status not in the open data)', 'unknown'];
  if (/strike|struck|dissolved|amalgamated|converted to llp/.test(s)) return ['inactive', clean(raw), null];
  if (/liquidation|winding/.test(s)) return ['active', clean(raw), 'stop'];
  if (/dormant|inactive/.test(s)) return ['active', clean(raw), 'check'];
  if (/^active$/.test(s)) return ['active', 'Active', null];
  return ['active', clean(raw), null];
}

// kind: 'company' | 'llp' | 'foreign'
function row(r, kind) {
  const number = clean(kind === 'llp' ? r.llpin : kind === 'foreign' ? r.fcin : r.cin).toUpperCase();
  const name = clean(kind === 'llp' ? r.llp_name : r.company_name);
  if (!number || !name) return null;
  const [st, label, flag] = status(kind === 'llp' ? r.llp_status : r.company_status);
  const out = { number, name, status: st, status_label: label, incorporated: day(r.registration_date || r.incorporation_date) };
  if (flag) out.flag = flag;
  out.legal_form = kind === 'llp' ? 'Limited Liability Partnership'
    : kind === 'foreign' ? ['Foreign company', clean(r.office_type)].filter(Boolean).join(', ')
      : [clean(r.company_class), clean(r.company_category)].filter(Boolean).join(', ') || null;
  const addr = clean(r.company_address); if (addr) out.registered_address = addr;
  const act = clean(r.act_description); if (act) out.activity = act;
  const roc = clean(r.roc); if (roc) out.roc = roc;
  const cap = money(r.paidup_capital); if (cap) out.paid_up = cap;
  return out;
}

// files: [{ kind, chunks, until }] read in order; a file with `until` keeps only rows registered before that date.
// Returns the earliest registration date seen in each file (so a later, older file can stop where a newer one starts).
async function addFile(chunks, kind, add, { until = null } = {}) {
  let n = 0; let first = null;
  for await (const r of records(chunks)) {
    const x = row(r, kind); if (!x) continue;
    if (until && x.incorporated && x.incorporated >= until) continue;
    if (x.incorporated && (!first || x.incorporated < first)) first = x.incorporated;
    add(x); n++;
  }
  return { n, first };
}

module.exports = { addFile, row, status };
