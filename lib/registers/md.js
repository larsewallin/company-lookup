// Moldova: ASP State Register of legal units (companies; no sole traders), imported into the Blob index.
'use strict';

const { record } = require('./_common');
const index = require('../bulk/index');
const { publicBase } = require('../blob');

const SRC = 'State Register of legal units (Moldova)';
const normalise = (n) => { const d = String(n || '').replace(/\D/g, ''); return d.length === 13 ? d : null; };

function make(env = process.env) {
  const base = () => publicBase(env.BLOB_READ_WRITE_TOKEN || '');
  return {
    country: 'MD',
    name: SRC,
    normalise,
    async search(fetchFn, q) {
      const b = base(); if (!b) return [];
      const n = /^\d{13}$/.test(String(q).trim()) ? String(q).trim() : null;
      if (n) { const r = await index.get(fetchFn, b, 'MD', n); return r ? [{ number: r.number, name: r.name, status: r.status, incorporated: r.incorporated }] : []; }
      return (await index.search(fetchFn, b, 'MD', q)) || [];
    },
    async get(fetchFn, number) {
      const b = base(); const n = normalise(number);
      if (!b || !n) return null;
      const r = await index.get(fetchFn, b, 'MD', n);
      if (!r) return null;
      const owners = (r.corporate_founders || []).map((f) => `${f.name}${f.share ? ` (${f.share})` : ''}`);
      return record({
        register: { name: SRC, number: r.number, gleif_as: [r.number], url: 'https://www.asp.gov.md/ro/date-deschise/date-statistice/company' },
        legal_name: r.name,
        legal_form: r.legal_form,
        status: r.status,
        status_label: r.status_label,
        incorporated: r.incorporated,
        ceased: r.status === 'inactive' ? r.status_date || null : null,
        registered_address: r.registered_address || null,
        industry: (r.activity_codes || []).map((c) => ({ code: c, label: 'CAEM' })),
        extra: [['IDNO', r.number], owners.length ? ['Corporate shareholders', owners.join('; ')] : null,
          ['Data', 'ASP open data (managers and individual founders left out)']].filter(Boolean),
        situations: [],
      });
    },
  };
}

module.exports = make();
module.exports.make = make;
