// Chile: Registro de Empresas y Sociedades (companies formed online since 2013), imported into the Blob index.
'use strict';

const { record } = require('./_common');
const index = require('../bulk/index');
const { publicBase } = require('../blob');
const { rutDigits } = require('../bulk/cl');

const SRC = 'Registro de Empresas y Sociedades (Chile)';
const normalise = (n) => { const d = rutDigits(n); return d.length >= 8 && d.length <= 9 ? `${d.slice(0, -1)}-${d.slice(-1)}` : null; };

function make(env = process.env) {
  const base = () => publicBase(env.BLOB_READ_WRITE_TOKEN || '');
  return {
    country: 'CL',
    name: SRC,
    normalise,
    async search(fetchFn, q) {
      const b = base(); if (!b) return [];
      if (/^[\d.\s]{7,11}-?[\dkK]$/.test(String(q).trim())) {
        const n = normalise(q); const r = n ? await index.get(fetchFn, b, 'CL', n) : null;
        return r ? [{ number: r.number, name: r.name, status: r.status, incorporated: r.incorporated }] : [];
      }
      return (await index.search(fetchFn, b, 'CL', q)) || [];
    },
    async get(fetchFn, number) {
      const b = base(); const n = normalise(number);
      if (!b || !n) return null;
      const r = await index.get(fetchFn, b, 'CL', n);
      if (!r) return null;
      return record({
        register: { name: SRC, number: r.number, gleif_as: [r.number, r.number.replace('-', '')], url: 'https://www.registrodeempresasysociedades.cl/' },
        legal_name: r.name,
        legal_form: r.legal_form,
        status: r.status,
        status_label: r.status_label,
        incorporated: r.incorporated,
        ceased: r.status === 'inactive' ? r.status_date || null : null,
        registered_address: r.registered_address || null,
        share_capital: r.capital ? `CLP ${r.capital.toLocaleString('en-US')}` : null,
        extra: [['RUT', r.number], ['Data', 'Registro de Empresas y Sociedades open data (companies formed online since 2013)']],
      });
    },
  };
}

module.exports = make();
module.exports.make = make;
