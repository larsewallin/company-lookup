// Peru: SUNAT taxpayer register (padrón reducido del RUC), legal entities only, imported into the Blob index.
'use strict';

const { record } = require('./_common');
const index = require('../bulk/index');
const { publicBase } = require('../blob');

const SRC = 'SUNAT RUC register (Peru)';
const normalise = (n) => { const d = String(n || '').replace(/\D/g, ''); return /^20\d{9}$/.test(d) ? d : null; };

function make(env = process.env) {
  const base = () => publicBase(env.BLOB_READ_WRITE_TOKEN || '');
  return {
    country: 'PE',
    name: SRC,
    normalise,
    async search(fetchFn, q) {
      const b = base(); if (!b) return [];
      if (/^[\d\s]{11,13}$/.test(String(q).trim())) {
        const n = normalise(q); const r = n ? await index.get(fetchFn, b, 'PE', n) : null;
        return r ? [{ number: r.number, name: r.name, status: r.status }] : [];
      }
      return (await index.search(fetchFn, b, 'PE', q)) || [];
    },
    async get(fetchFn, number) {
      const b = base(); const n = normalise(number);
      if (!b || !n) return null;
      const r = await index.get(fetchFn, b, 'PE', n);
      if (!r) return null;
      const situations = [];
      if (r.flag === 'check') situations.push({ level: 'check', label: r.status_label, detail: 'SUNAT shows the company’s activities as temporarily suspended.' });
      if (r.address_condition === 'NO HABIDO') situations.push({ level: 'stop', label: 'Not found at its tax address (no habido)', detail: 'SUNAT could not locate the company at its declared tax address. Invoices and contracts with it carry tax and collection risk.' });
      else if (r.address_condition === 'NO HALLADO') situations.push({ level: 'check', label: 'Not located at its tax address (no hallado)', detail: 'SUNAT could not find the company at its declared address on a visit.' });
      return record({
        register: { name: SRC, number: r.number, gleif_as: [r.number], url: 'https://e-consultaruc.sunat.gob.pe/' },
        legal_name: r.name,
        status: r.status,
        status_label: r.status_label,
        registered_address: r.registered_address ? `${r.registered_address}${r.ubigeo ? ` (ubigeo ${r.ubigeo})` : ''}` : null,
        extra: [['RUC', r.number], r.address_condition ? ['Address condition', r.address_condition] : null, ['Data', 'SUNAT padrón reducido del RUC (monthly)']].filter(Boolean),
        situations,
      });
    },
  };
}

module.exports = make();
module.exports.make = make;
