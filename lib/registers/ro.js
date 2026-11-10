// Romania: ONRC trade register (companies and cooperatives; no natural persons), imported into the Blob index.
'use strict';

const { record } = require('./_common');
const index = require('../bulk/index');
const { publicBase } = require('../blob');

const SRC = 'ONRC trade register (Romania)';
const normalise = (n) => { const d = String(n || '').toUpperCase().replace(/^RO/, '').replace(/\D/g, ''); return d.length >= 2 && d.length <= 10 ? d : null; };

function make(env = process.env) {
  const base = () => publicBase(env.BLOB_READ_WRITE_TOKEN || '');
  return {
    country: 'RO',
    name: SRC,
    normalise,
    async search(fetchFn, q) {
      const b = base(); if (!b) return [];
      if (/^(RO)?\s*\d{2,10}$/i.test(String(q).trim())) {
        const r = await index.get(fetchFn, b, 'RO', normalise(q));
        return r ? [{ number: r.number, name: r.name, status: r.status, incorporated: r.incorporated }] : [];
      }
      return (await index.search(fetchFn, b, 'RO', q)) || [];
    },
    async get(fetchFn, number) {
      const b = base(); const n = normalise(number);
      if (!b || !n) return null;
      const r = await index.get(fetchFn, b, 'RO', n);
      if (!r) return null;
      const situations = [];
      if (r.flag) situations.push({ level: r.flag, label: r.status_label, detail: `ONRC lists the firm as: ${r.status_label}.` });
      return record({
        register: { name: SRC, number: r.number, gleif_as: [r.reg_no, r.number].filter(Boolean), url: 'https://www.onrc.ro/' },
        legal_name: r.name,
        legal_form: r.legal_form,
        status: r.status,
        status_label: r.status_label,
        incorporated: r.incorporated,
        registered_address: r.registered_address || null,
        extra: [['CUI', r.number], r.reg_no ? ['Trade register no.', r.reg_no] : null, r.euid ? ['EUID', r.euid] : null,
          ['Data', 'ONRC open data on data.gov.ro']].filter(Boolean),
        situations,
      });
    },
  };
}

module.exports = make();
module.exports.make = make;
