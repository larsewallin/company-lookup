// Ecuador: SRI catastro del RUC (companies only), imported into the Blob index.
'use strict';

const { record } = require('./_common');
const index = require('../bulk/index');
const { publicBase } = require('../blob');

const SRC = 'SRI RUC register (Ecuador)';
const normalise = (n) => { const d = String(n || '').replace(/\D/g, ''); return d.length === 13 ? d : d.length === 10 ? `${d}001` : null; };

function make(env = process.env) {
  const base = () => publicBase(env.BLOB_READ_WRITE_TOKEN || '');
  return {
    country: 'EC',
    name: SRC,
    normalise,
    async search(fetchFn, q) {
      const b = base(); if (!b) return [];
      const n = /^\d{10}(\d{3})?$/.test(String(q).trim()) ? normalise(q) : null;
      if (n) {
        const r = await index.get(fetchFn, b, 'EC', n);
        return r ? [{ number: r.number, name: r.name, status: r.status, incorporated: r.incorporated }] : [];
      }
      return (await index.search(fetchFn, b, 'EC', q)) || [];
    },
    async get(fetchFn, number) {
      const b = base(); const n = normalise(number);
      if (!b || !n) return null;
      const r = await index.get(fetchFn, b, 'EC', n);
      if (!r) return null;
      const situations = [];
      if (r.shell) situations.push({ level: r.flag === 'stop' ? 'stop' : 'check', label: r.flag === 'stop' ? 'Listed by SRI as a shell company' : 'Previously listed by SRI as a shell company',
        detail: `SRI catastro de empresas fantasmas: "${r.shell}".${r.flag === 'stop' ? '' : ' The RUC was later reactivated.'}` });
      else if (r.flag) situations.push({ level: r.flag, label: r.status_label, detail: `SRI lists the RUC as: ${r.status_label}.` });
      return record({
        register: { name: SRC, number: r.number, gleif_as: [r.number], url: 'https://srienlinea.sri.gob.ec/sri-en-linea/SriRucWeb/ConsultaRuc/Consultas/consultaRuc' },
        legal_name: r.name,
        other_names: r.other_name ? [r.other_name] : [],
        status: r.status,
        status_label: r.status_label,
        incorporated: r.incorporated,
        registered_address: r.location || null,
        industry: r.activity ? [{ code: r.activity.code, label: r.activity.label }] : [],
        extra: [['RUC', r.number], r.special ? ['Special taxpayer', 'Yes (contribuyente especial)'] : null, ['Data', 'SRI open data (parish and canton only; start date is when activities began)']].filter(Boolean),
        situations,
      });
    },
  };
}

module.exports = make();
module.exports.make = make;
