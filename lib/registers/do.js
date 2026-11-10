// Dominican Republic: DGII taxpayer register (RNC, legal entities only), imported into the Blob index.
'use strict';

const { record } = require('./_common');
const index = require('../bulk/index');
const { publicBase } = require('../blob');

const SRC = 'DGII taxpayer register (Dominican Republic)';
const normalise = (n) => { const d = String(n || '').replace(/\D/g, ''); return d.length === 9 ? d : null; };

function make(env = process.env) {
  const base = () => publicBase(env.BLOB_READ_WRITE_TOKEN || '');
  return {
    country: 'DO',
    name: SRC,
    normalise,
    async search(fetchFn, q) {
      const b = base(); if (!b) return [];
      const n = /^[\d-]{9,11}$/.test(String(q).trim()) ? normalise(q) : null;
      if (n) {
        const r = await index.get(fetchFn, b, 'DO', n);
        return r ? [{ number: r.number, name: r.name, status: r.status, incorporated: r.incorporated }] : [];
      }
      return (await index.search(fetchFn, b, 'DO', q)) || [];
    },
    async get(fetchFn, number) {
      const b = base(); const n = normalise(number);
      if (!b || !n) return null;
      const r = await index.get(fetchFn, b, 'DO', n);
      if (!r) return null;
      const situations = [];
      if (r.flag) situations.push({ level: r.flag, label: r.status_label, detail: `DGII lists the taxpayer as: ${r.status_label}.` });
      return record({
        register: { name: SRC, number: r.number, gleif_as: [r.number, `${r.number.slice(0, 1)}-${r.number.slice(1, 3)}-${r.number.slice(3, 8)}-${r.number.slice(8)}`], url: 'https://dgii.gov.do/app/WebApps/ConsultasWeb2/ConsultasWeb/consultas/rnc.aspx' },
        legal_name: r.name,
        other_names: r.other_name ? [r.other_name] : [],
        status: r.status,
        status_label: r.status_label,
        incorporated: r.incorporated,
        industry: r.activity ? [{ code: null, label: r.activity }] : [],
        extra: [['RNC', r.number], r.regime ? ['Tax regime', r.regime] : null, ['Data', 'DGII RNC list (no addresses; start date is when activities began)']].filter(Boolean),
        situations,
      });
    },
  };
}

module.exports = make();
module.exports.make = make;
