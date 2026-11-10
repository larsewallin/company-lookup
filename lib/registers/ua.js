// Ukraine: Unified State Register of legal entities (Ministry of Justice open data), imported into the Blob index.
'use strict';

const { record } = require('./_common');
const index = require('../bulk/index');
const { publicBase } = require('../blob');

const SRC = 'Unified State Register (Ukraine)';
const normalise = (n) => { const d = String(n || '').replace(/\D/g, ''); return d.length === 8 ? d : null; };

function make(env = process.env) {
  const base = () => publicBase(env.BLOB_READ_WRITE_TOKEN || '');
  return {
    country: 'UA',
    name: SRC,
    normalise,
    async search(fetchFn, q) {
      const b = base(); if (!b) return [];
      if (/^\d{8}$/.test(String(q).trim())) {
        const r = await index.get(fetchFn, b, 'UA', String(q).trim());
        return r ? [{ number: r.number, name: r.name, status: r.status, incorporated: r.incorporated }] : [];
      }
      return (await index.search(fetchFn, b, 'UA', q)) || [];
    },
    async get(fetchFn, number) {
      const b = base(); const n = normalise(number);
      if (!b || !n) return null;
      const r = await index.get(fetchFn, b, 'UA', n);
      if (!r) return null;
      const situations = [];
      if (r.flag) situations.push({ level: r.flag, label: r.status_label, detail: `The Unified State Register shows: ${r.status_label}.` });
      return record({
        register: { name: SRC, number: r.number, gleif_as: [r.number], url: 'https://usr.minjust.gov.ua/' },
        legal_name: r.name,
        other_names: r.other_name ? [r.other_name] : [],
        legal_form: r.legal_form,
        status: r.status,
        status_label: r.status_label,
        incorporated: r.incorporated,
        ceased: r.status === 'inactive' ? r.status_date || null : null,
        share_capital: r.capital ? `UAH ${r.capital}` : null,
        extra: [['EDRPOU', r.number], ['Data', 'Ministry of Justice open data (no addresses in the open file)']],
        situations,
      });
    },
  };
}

module.exports = make();
module.exports.make = make;
