// India: MCA company, LLP and foreign-company registrations since 2016 (India Data Portal), imported into the Blob index.
'use strict';

const { record } = require('./_common');
const index = require('../bulk/index');
const { publicBase } = require('../blob');

const SRC = 'Ministry of Corporate Affairs (India)';
const CIN = /^[LU]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6}$/;
const LLPIN = /^[A-Z]{3}-\d{4}$/;
const FCIN = /^F\d{5}$/;
const normalise = (n) => { const s = String(n || '').trim().toUpperCase().replace(/\s+/g, ''); return CIN.test(s) || LLPIN.test(s) || FCIN.test(s) ? s : null; };
const kindOf = (n) => (LLPIN.test(n) ? 'LLPIN' : FCIN.test(n) ? 'FCRN' : 'CIN');

function make(env = process.env) {
  const base = () => publicBase(env.BLOB_READ_WRITE_TOKEN || '');
  return {
    country: 'IN',
    name: SRC,
    normalise,
    async search(fetchFn, q) {
      const b = base(); if (!b) return [];
      const n = normalise(q);
      if (n) {
        const r = await index.get(fetchFn, b, 'IN', n);
        return r ? [{ number: r.number, name: r.name, status: r.status, incorporated: r.incorporated }] : [];
      }
      return (await index.search(fetchFn, b, 'IN', q)) || [];
    },
    async get(fetchFn, number) {
      const b = base(); const n = normalise(number);
      if (!b || !n) return null;
      const r = await index.get(fetchFn, b, 'IN', n);
      if (!r) return null;
      const situations = [];
      if (r.flag === 'unknown') situations.push({ level: 'check', label: 'Current status not published', detail: 'The open MCA data gives the registration but not whether the company is still active, struck off or in liquidation. Check the MCA master data (mca.gov.in).' });
      else if (r.flag) situations.push({ level: r.flag, label: r.status_label, detail: `MCA status: ${r.status_label}.` });
      return record({
        register: { name: SRC, number: r.number, gleif_as: [r.number], url: 'https://www.mca.gov.in/content/mca/global/en/mca/master-data/MDS.html' },
        legal_name: r.name,
        legal_form: r.legal_form || null,
        status: r.status,
        status_label: r.status_label,
        incorporated: r.incorporated,
        registered_address: r.registered_address || null,
        industry: r.activity ? [{ code: null, label: r.activity }] : [],
        share_capital: r.paid_up ? `INR ${Number(r.paid_up).toLocaleString('en-IN')} paid up` : null,
        extra: [[kindOf(r.number), r.number], r.roc ? ['Registrar of Companies', r.roc] : null,
          ['Data', 'MCA registrations since 2016 via the India Data Portal (no current status)']].filter(Boolean),
        situations,
      });
    },
  };
}

module.exports = make();
module.exports.make = make;
