// Paraguay: DNIT RUC list (legal entities only), imported into the Blob index.
'use strict';

const { record } = require('./_common');
const index = require('../bulk/index');
const { publicBase } = require('../blob');

const SRC = 'DNIT RUC register (Paraguay)';
const normalise = (n) => { const m = /^(8\d{7})(?:-?\d)?$/.exec(String(n || '').trim()); return m ? m[1] : null; };

function make(env = process.env) {
  const base = () => publicBase(env.BLOB_READ_WRITE_TOKEN || '');
  return {
    country: 'PY',
    name: SRC,
    normalise,
    async search(fetchFn, q) {
      const b = base(); if (!b) return [];
      const n = normalise(q);
      if (n) {
        const r = await index.get(fetchFn, b, 'PY', n);
        return r ? [{ number: r.number, name: r.name, status: r.status }] : [];
      }
      return (await index.search(fetchFn, b, 'PY', q)) || [];
    },
    async get(fetchFn, number) {
      const b = base(); const n = normalise(number);
      if (!b || !n) return null;
      const r = await index.get(fetchFn, b, 'PY', n);
      if (!r) return null;
      const full = r.dv ? `${r.number}-${r.dv}` : r.number;
      const situations = [];
      if (r.flag) situations.push({ level: r.flag, label: r.status_label, detail: `DNIT lists the RUC as: ${r.status_label}.` });
      return record({
        register: { name: SRC, number: full, gleif_as: [full, r.number, r.dv ? `${r.number}${r.dv}` : null].filter(Boolean), url: 'https://www.dnit.gov.py/' },
        legal_name: r.name,
        status: r.status,
        status_label: r.status_label,
        extra: [['RUC', full], ['Data', 'DNIT RUC list (name and status only)']],
        situations,
      });
    },
  };
}

module.exports = make();
module.exports.make = make;
