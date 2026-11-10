// Slovenia: AJPES business register open data, imported into the Blob index by api/bulk-import.js.
'use strict';

const { record } = require('./_common');
const index = require('../bulk/index');
const { publicBase } = require('../blob');

const SRC = 'AJPES business register (Slovenia)';
// Matična številka: 7 digits plus a 3-digit unit suffix (000 = the company itself); accept either.
const normalise = (n) => { const d = String(n || '').replace(/\D/g, ''); return d.length === 10 ? d : d.length === 7 ? `${d}000` : null; };

function make(env = process.env) {
  const base = () => publicBase(env.BLOB_READ_WRITE_TOKEN || '');
  return {
    country: 'SI',
    name: SRC,
    normalise,
    async search(fetchFn, q) {
      const b = base(); if (!b) return [];
      if (/^[\d\s]{7,11}$/.test(String(q).trim())) {
        const n = normalise(q); const r = n ? await index.get(fetchFn, b, 'SI', n) : null;
        return r ? [{ number: r.number, name: r.name, status: r.status }] : [];
      }
      return (await index.search(fetchFn, b, 'SI', q)) || [];
    },
    async get(fetchFn, number) {
      const b = base(); const n = normalise(number);
      if (!b || !n) return null;
      const r = await index.get(fetchFn, b, 'SI', n);
      if (!r) return null;
      return record({
        register: { name: SRC, number: r.number, gleif_as: [r.number, r.number.slice(0, 7)], url: 'https://www.ajpes.si/prs/' },
        legal_name: r.name,
        legal_form: r.legal_form,
        status: r.status,
        status_label: r.status_label,
        registered_address: r.registered_address || null,
        extra: [r.registry ? ['Registry office', r.registry] : null, ['Data', 'AJPES open data (currently registered entities)']].filter(Boolean),
      });
    },
  };
}

module.exports = make();
module.exports.make = make;
