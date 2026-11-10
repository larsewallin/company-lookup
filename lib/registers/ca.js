// Canada: federal corporations (Corporations Canada open data) and Quebec (Registraire des entreprises open
// data), both imported into the Blob index by api/bulk-import.js. Other provinces are not in open data.
// IDs: ca:<federal corporation number> (up to 8 digits) and ca:qc-<NEQ> (Quebec, 10 digits).
'use strict';

const { record } = require('./_common');
const index = require('../bulk/index');
const { publicBase } = require('../blob');

const FED = 'Corporations Canada (federal)';
const QC = 'Registraire des entreprises (Quebec)';

function normalise(n) {
  const raw = String(n || '').trim().toLowerCase();
  const d = raw.replace(/\D/g, '');
  if (raw.startsWith('qc') || d.length === 10) return d.length === 10 ? `qc-${d}` : null;
  return d.length >= 3 && d.length <= 8 ? String(Number(d)) : null;
}
const isQc = (n) => String(n).startsWith('qc-');

function make(env = process.env) {
  const base = () => publicBase(env.BLOB_READ_WRITE_TOKEN || '');
  const lookup = (fetchFn, b, n) => index.get(fetchFn, b, isQc(n) ? 'QC' : 'CA', n);
  return {
    country: 'CA',
    name: `${FED}; ${QC}`,
    normalise,
    async search(fetchFn, q) {
      const b = base(); if (!b) return [];
      if (/^(qc-?)?[\d\s-]{3,12}$/i.test(String(q).trim())) {
        const n = normalise(q); const r = n ? await lookup(fetchFn, b, n) : null;
        return r ? [{ number: r.number, name: r.name, city: isQc(r.number) ? 'Quebec' : r.province || null, status: r.status, incorporated: r.incorporated, source: isQc(r.number) ? QC : FED }] : [];
      }
      const [fed, qc] = await Promise.all([index.search(fetchFn, b, 'CA', q).catch(() => null), index.search(fetchFn, b, 'QC', q).catch(() => null)]);
      return [...(fed || []).map((r) => ({ ...r, source: FED })), ...(qc || []).map((r) => ({ ...r, city: 'Quebec', source: QC }))];
    },
    async get(fetchFn, number, { asOfIso } = {}) {
      const b = base(); const n = normalise(number);
      if (!b || !n) return null;
      const r = await lookup(fetchFn, b, n);
      if (!r) return null;
      return isQc(n) ? quebec(r, asOfIso) : federal(r, asOfIso);
    },
  };
}

function federal(r, asOfIso) {
  const situations = [];
  if (r.flag) situations.push({ level: r.flag, label: r.status_label, detail: `Corporations Canada shows: ${r.status_label}. Corporations that miss annual filings are dissolved.` });
  // Annual returns are due within 60 days after each anniversary; two missed years is a Check.
  const year = asOfIso ? Number(asOfIso.slice(0, 4)) : null;
  if (!r.flag && r.status === 'active' && year && r.last_filing_year && r.last_filing_year < year - 1) {
    situations.push({ level: 'check', label: 'Annual return overdue', detail: `The last annual return filed with Corporations Canada was for ${r.last_filing_year}.` });
  }
  return record({
    register: { name: FED, number: r.number, gleif_as: [r.number, `${r.number.slice(0, -1)}-${r.number.slice(-1)}`], url: `https://ised-isde.canada.ca/cc/lgcy/fdrlCrpDtls.html?corpId=${r.number}` },
    legal_name: r.name,
    other_names: r.other_name ? [r.other_name] : [],
    legal_form: r.legal_form,
    status: r.status,
    status_label: r.status_label,
    incorporated: r.incorporated,
    registered_address: r.registered_address || null,
    extra: [
      r.bn ? ['Business number (BN)', r.bn] : null,
      r.last_filing_year ? ['Last annual return', String(r.last_filing_year)] : null,
      r.last_meeting ? ['Last annual meeting', r.last_meeting] : null,
      ['Data', 'Corporations Canada open data (federal corporations only)'],
    ].filter(Boolean),
    situations,
  });
}

function quebec(r, asOfIso) {
  const neq = r.number.slice(3);
  const situations = [];
  if (r.flag === 'stop') situations.push({ level: 'stop', label: 'Bankruptcy recorded', detail: 'The Quebec enterprise register shows a bankruptcy (faillite) indicator for this enterprise.' });
  // The annual update must be filed by its deadline; missing two in a row leads to striking off.
  if (r.status === 'active' && asOfIso && r.prev_update_year && r.prev_update_deadline && asOfIso > r.prev_update_deadline && (!r.last_update_year || r.last_update_year < r.prev_update_year)) {
    situations.push({ level: 'check', label: 'Annual update overdue', detail: `The ${r.prev_update_year} annual update was due by ${r.prev_update_deadline}; the last one filed is ${r.last_update_year || 'none on record'}.` });
  }
  return record({
    register: { name: QC, number: neq, gleif_as: [neq], url: 'https://www.registreentreprises.gouv.qc.ca/' },
    legal_name: r.name,
    other_names: r.other_name ? [r.other_name] : [],
    legal_form: r.legal_form,
    status: r.status,
    status_label: r.status_label,
    incorporated: r.incorporated,
    ceased: r.status === 'inactive' ? r.status_date || null : null,
    registered_address: r.registered_address || null,
    industry: r.activity ? [{ code: r.activity[0], label: r.activity[1] || 'CAE' }] : [],
    size: r.employees_qc ? `${r.employees_qc} employees in Quebec` : null, // e.g. "11–25 employees in Quebec"
    extra: [
      ['NEQ', neq],
      r.law ? ['Constituted under', r.law] : null,
      r.last_update_year ? ['Last annual update', String(r.last_update_year)] : null,
      ['Data', 'Registraire des entreprises du Québec open data (monthly)'],
    ].filter(Boolean),
    situations,
  });
}

module.exports = make();
module.exports.make = make;
