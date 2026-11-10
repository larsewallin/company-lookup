// Russia: FNS open data on organisations' revenue and expenses (all legal entities that filed accounts), Blob index.
'use strict';

const { record } = require('./_common');
const index = require('../bulk/index');
const { publicBase } = require('../blob');

const SRC = 'Federal Tax Service open data (Russia)';
const normalise = (n) => { const d = String(n || '').replace(/\D/g, ''); return d.length === 10 ? d : null; };
const rub = (v) => (v == null ? null : `RUB ${Number(v).toLocaleString('en')}`);

function make(env = process.env) {
  const base = () => publicBase(env.BLOB_READ_WRITE_TOKEN || '');
  return {
    country: 'RU',
    name: SRC,
    normalise,
    async search(fetchFn, q) {
      const b = base(); if (!b) return [];
      if (/^\d{10}$/.test(String(q).trim())) {
        const r = await index.get(fetchFn, b, 'RU', String(q).trim());
        return r ? [{ number: r.number, name: r.other_name || r.name, status: r.status }] : [];
      }
      return (await index.search(fetchFn, b, 'RU', q)) || [];
    },
    async get(fetchFn, number) {
      const b = base(); const n = normalise(number);
      if (!b || !n) return null;
      const r = await index.get(fetchFn, b, 'RU', n);
      if (!r) return null;
      const year = r.period ? r.period.slice(0, 4) : null;
      return record({
        register: { name: SRC, number: r.number, gleif_as: [r.number], url: 'https://egrul.nalog.ru/' },
        legal_name: r.name,
        other_names: r.other_name ? [r.other_name] : [],
        status: 'active',
        status_label: year ? `Filed accounts for ${year} with the tax service` : r.status_label,
        financials: r.revenue != null && year ? { year, revenue: r.revenue, net_result: null, currency: 'RUB' } : null,
        last_accounts: year,
        extra: [['INN', r.number], r.expenses != null && year ? [`Expenses (${year})`, rub(r.expenses)] : null,
          ['Data', 'FNS open data on revenue and expenses; no address or registration status (check EGRUL)']].filter(Boolean),
        situations: [],
      });
    },
  };
}

module.exports = make();
module.exports.make = make;
