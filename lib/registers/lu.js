// Luxembourg: companies that filed annual accounts at the RCS (STATEC open data), with key figures, Blob index.
'use strict';

const { record } = require('./_common');
const index = require('../bulk/index');
const { publicBase } = require('../blob');

const SRC = 'RCS annual accounts (Luxembourg)';
const normalise = (n) => { const m = /^([A-Z])\s*0*(\d{1,7})$/.exec(String(n || '').trim().toUpperCase()); return m ? `${m[1]}${m[2]}` : null; };
const money = (v, cur) => (v == null ? null : `${cur || 'EUR'} ${Number(v).toLocaleString('en')}`);

function make(env = process.env) {
  const base = () => publicBase(env.BLOB_READ_WRITE_TOKEN || '');
  return {
    country: 'LU',
    name: SRC,
    normalise,
    async search(fetchFn, q) {
      const b = base(); if (!b) return [];
      const n = normalise(q);
      if (n) { const r = await index.get(fetchFn, b, 'LU', n); return r ? [{ number: r.number, name: r.name, status: r.status }] : []; }
      return (await index.search(fetchFn, b, 'LU', q)) || [];
    },
    async get(fetchFn, number) {
      const b = base(); const n = normalise(number);
      if (!b || !n) return null;
      const r = await index.get(fetchFn, b, 'LU', n);
      if (!r) return null;
      const situations = [];
      if (r.equity != null && r.equity < 0) situations.push({ level: 'check', label: 'Negative equity', detail: `Equity was ${money(r.equity, r.currency)} in the accounts for ${r.year} filed at the RCS.` });
      return record({
        register: { name: SRC, number: r.number, gleif_as: [r.number, `${r.number[0]} ${r.number.slice(1)}`], url: 'https://www.lbr.lu/' },
        legal_name: r.name,
        status: 'active',
        status_label: r.status_label,
        financials: r.year && (r.revenue != null || r.net_result != null) ? { year: r.year, revenue: r.revenue ?? null, net_result: r.net_result ?? null, currency: r.currency || 'EUR' } : null,
        last_accounts: r.year || null,
        extra: [['RCS number', r.number], r.assets != null ? [`Total assets (${r.year})`, money(r.assets, r.currency)] : null,
          r.equity != null ? [`Equity (${r.year})`, money(r.equity, r.currency)] : null, r.period_end ? ['Financial year ended', r.period_end] : null,
          ['Data', 'STATEC Centrale des Bilans open data (companies that filed accounts; no address or status)']].filter(Boolean),
        situations,
      });
    },
  };
}

module.exports = make();
module.exports.make = make;
