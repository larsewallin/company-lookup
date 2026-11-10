// Argentina: Registro Nacional de Sociedades (Ministerio de Justicia open data), imported into the Blob index
// by api/bulk-import.js. Companies only; the CUIT is the identifier.
'use strict';

const { record } = require('./_common');
const index = require('../bulk/index');
const { publicBase } = require('../blob');

const SRC = 'Registro Nacional de Sociedades (Argentina)';
const normalise = (n) => { const d = String(n || '').replace(/\D/g, ''); return d.length === 11 ? d : null; };
const fmt = (c) => `${c.slice(0, 2)}-${c.slice(2, 10)}-${c.slice(10)}`;

function make(env = process.env) {
  const base = () => publicBase(env.BLOB_READ_WRITE_TOKEN || '');
  return {
    country: 'AR',
    name: SRC,
    normalise,
    async search(fetchFn, q) {
      const b = base(); if (!b) return [];
      if (/^[\d\s.-]{11,14}$/.test(String(q).trim())) {
        const n = normalise(q); const r = n ? await index.get(fetchFn, b, 'AR', n) : null;
        return r ? [{ number: r.number, name: r.name, status: r.status, incorporated: r.incorporated }] : [];
      }
      return (await index.search(fetchFn, b, 'AR', q)) || [];
    },
    async get(fetchFn, number) {
      const b = base(); const n = normalise(number);
      if (!b || !n) return null;
      const r = await index.get(fetchFn, b, 'AR', n);
      if (!r) return null;
      const situations = [];
      if (r.flag) situations.push({ level: r.flag, label: r.flag_label, detail: `The registered name says the company is ${r.flag_label.toLowerCase()}.` });
      if (r.fiscal_address_state) situations.push({ level: 'check', label: 'Tax address not confirmed', detail: `AFIP marks the tax address as: ${r.fiscal_address_state.toLowerCase()}.` });
      return record({
        register: { name: SRC, number: fmt(r.number), gleif_as: [r.number, fmt(r.number)], url: 'https://datos.jus.gob.ar/dataset/registro-nacional-de-sociedades' },
        legal_name: r.name,
        legal_form: r.legal_form,
        status: r.status,
        status_label: r.status_label,
        incorporated: r.incorporated,
        registered_address: r.registered_address || null,
        industry: (r.activities || []).map(([code, label]) => ({ code, label: label || 'CLAE' })),
        extra: [
          ['CUIT', fmt(r.number)],
          r.fiscal_address ? ['Tax address', r.fiscal_address] : null,
          r.updated ? ['Record updated', r.updated] : null,
          ['Data', 'Registro Nacional de Sociedades open data (yearly snapshot)'],
        ].filter(Boolean),
        situations,
      });
    },
  };
}

module.exports = make();
module.exports.make = make;
