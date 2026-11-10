// EU VAT number check (VIES). Free, no key. Confirms whether a VAT number is valid today.
'use strict';

const { getJson } = require('./http');

const BASE = 'https://ec.europa.eu/taxation_customs/vies/rest-api/ms';
// EU member states plus Northern Ireland (XI). Greece uses EL in VAT numbers.
const EU = new Set(['AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'EL', 'ES', 'FI', 'FR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK', 'XI']);

function split(vat) {
  const s = String(vat || '').toUpperCase().replace(/[\s.\-]/g, '');
  const m = s.match(/^([A-Z]{2})([0-9A-Z]{2,13})$/);
  if (!m || !EU.has(m[1])) return null;
  return { cc: m[1], number: m[2] };
}

async function check(fetchFn, vat) {
  const v = split(vat);
  if (!v) return null;
  const d = await getJson(fetchFn, `${BASE}/${v.cc}/vat/${encodeURIComponent(v.number)}`, { source: 'VIES' });
  if (!d) return null;
  if (d.userError && !['VALID', 'INVALID'].includes(d.userError)) {
    return { vat: v.cc + v.number, valid: null, unavailable: d.userError };
  }
  const clean = (x) => (x && x.trim() && x.trim() !== '---' ? x.replace(/\n/g, ', ').trim() : null);
  return { vat: v.cc + v.number, valid: d.isValid === true, name: clean(d.name), address: clean(d.address), checked: d.requestDate ? String(d.requestDate).slice(0, 10) : null };
}

module.exports = { check, split, EU };
