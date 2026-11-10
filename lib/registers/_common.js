// Small shared helpers for register adapters.
'use strict';

const { getJson } = require('../http');

// Blank record shape every adapter fills (see card.js for how fields are used).
function record(fields) {
  return {
    register: null, legal_name: null, other_names: [], former_names: [], legal_form: null,
    status: 'active', status_label: 'Active', incorporated: null, ceased: null, registered_address: null,
    industry: [], employees: null, size: null, website: null, vat: null, officers: null, auditor: null,
    financials: null, share_capital: null, last_accounts: null, situations: [], is_sole_trader: false,
    ...fields,
  };
}

// CKAN datastore (used by data.gov.il, data.gov.lv and others). Free, no key.
async function ckan(fetchFn, base, resourceId, { q, filters, limit = 15, headers = {} }, source) {
  const params = [`resource_id=${resourceId}`, `limit=${limit}`];
  if (q) params.push(`q=${encodeURIComponent(q)}`);
  if (filters) params.push(`filters=${encodeURIComponent(JSON.stringify(filters))}`);
  const path = base.includes('data.gov.sg') ? '/api/action/datastore_search' : '/api/3/action/datastore_search';
  const d = await getJson(fetchFn, `${base}${path}?${params.join('&')}`, { source, headers });
  return (d && d.success && d.result && d.result.records) || [];
}

// Socrata (US state open data portals). Free, no key at low volume.
async function socrata(fetchFn, domain, dataset, where, { limit = 15, order, q, select, group } = {}, source) {
  const params = [`$limit=${limit}`, `$where=${encodeURIComponent(where)}`];
  if (select) params.push(`$select=${encodeURIComponent(select)}`);
  if (group) params.push(`$group=${encodeURIComponent(group)}`);
  if (q) params.push(`$q=${encodeURIComponent(q)}`);
  if (order) params.push(`$order=${encodeURIComponent(order)}`);
  const d = await getJson(fetchFn, `https://${domain}/resource/${dataset}.json?${params.join('&')}`, { source });
  return Array.isArray(d) ? d : [];
}
const soqlString = (s) => "'" + String(s).toUpperCase().replace(/'/g, "''") + "'";
const soqlLike = (s) => "'%" + String(s).toUpperCase().replace(/'/g, "''").replace(/[%_]/g, '') + "%'";

// Fast name search on large Socrata datasets: names starting with the query, or with "THE " + query.
// (A "%x%" scan takes 2-6 s on datasets with millions of rows; a prefix match takes about 0.2 s.)
const soqlPrefix = (field, s) => {
  const v = String(s).toUpperCase().trim().replace(/'/g, "''").replace(/^THE\s+/, '');
  return `(starts_with(upper(${field}), '${v}') OR starts_with(upper(${field}), 'THE ${v}'))`;
};
const isoDate = (s) => (s && /^\d{4}-\d{2}-\d{2}/.test(String(s)) ? String(s).slice(0, 10) : null);
const digits = (s) => String(s || '').replace(/\D/g, '');

module.exports = { record, ckan, socrata, soqlString, soqlLike, soqlPrefix, isoDate, digits };
