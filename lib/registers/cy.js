// Cyprus: Registrar of Companies monthly open data (data.gov.cy dataset 1026, CC BY 4.0),
// imported into the Blob search index by api/bulk-import.js. Works once BLOB_READ_WRITE_TOKEN is set
// and the first import has run; until then search returns nothing and the card says the index is missing.
'use strict';

const { record } = require('./_common');
const index = require('../bulk/index');
const { publicBase } = require('../blob');

const SRC = 'Registrar of Companies (Cyprus)';

// "HE 123456", "ΗΕ123456" (Greek letters), "123456" -> HE123456; overseas companies AE...
function normalise(n) {
  const s = String(n || '').toUpperCase().replace(/Η/g, 'H').replace(/Ε/g, 'E').replace(/Α/g, 'A').replace(/[\s.\-]/g, '');
  const m = /^(HE|AE)?(\d{1,7})$/.exec(s);
  return m ? `${m[1] || 'HE'}${m[2]}` : null;
}

const base = (env) => publicBase(env.BLOB_READ_WRITE_TOKEN || '');

function make(env = process.env) {
  return {
    country: 'CY',
    name: SRC,
    normalise,
    async search(fetchFn, q) {
      const b = base(env); if (!b) return [];
      const n = /\d{3,}/.test(q) ? normalise(q) : null;
      if (n) { const r = await index.get(fetchFn, b, 'CY', n); return r ? [{ number: r.number, name: r.name, status: r.status, incorporated: r.incorporated }] : []; }
      return (await index.search(fetchFn, b, 'CY', q)) || [];
    },
    async get(fetchFn, number) {
      const b = base(env); const n = normalise(number);
      if (!b || !n) return null;
      const r = await index.get(fetchFn, b, 'CY', n);
      if (!r) return null;
      return record({
        register: { name: SRC, number: r.number, // GLEIF mostly writes Greek letters ("ΗΕ 165"), sometimes Latin ("HE485950").
        gleif_as: [`${r.number.startsWith('AE') ? 'ΑΕ' : 'ΗΕ'} ${r.number.slice(2)}`, r.number], url: 'https://efiling.drcor.mcit.gov.cy/DrcorPublic/SearchForm.aspx' },
        legal_name: r.name,
        legal_form: r.legal_form || null,
        status: r.status,
        status_label: r.status_label,
        incorporated: r.incorporated,
        ceased: r.status === 'inactive' ? r.status_date : null,
        registered_address: r.registered_address,
        officers: r.officers || [],
        extra: [r.status_date ? ['Status since', r.status_date] : null, ['Data', 'Registrar open data, updated monthly']].filter(Boolean),
        situations: r.flag ? [{ level: r.flag, label: r.status_label, detail: `The Cyprus Registrar of Companies shows: ${r.status_label}.` }] : [],
      });
    },
  };
}

module.exports = make();
module.exports.make = make;
