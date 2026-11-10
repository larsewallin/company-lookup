// Switzerland: commercial register (Zefix) published as linked open data on LINDAS (ld.admin.ch). Free, no key.
// LINDAS holds companies currently in the register, without dates or status history.
'use strict';

const { getJson } = require('../http');
const { record } = require('./_common');

const ENDPOINT = 'https://ld.admin.ch/query';
const PREFIX = 'PREFIX schema: <http://schema.org/>\n';
const FORMS = {
  '0101': 'Sole proprietorship', '0103': 'General partnership', '0104': 'Limited partnership', '0105': 'Partnership limited by shares',
  '0106': 'Company limited by shares (AG/SA)', '0107': 'Limited liability company (GmbH/Sàrl)', '0108': 'Cooperative', '0109': 'Association',
  '0110': 'Foundation', '0111': 'Swiss branch', '0151': 'Branch of a foreign company', '0113': 'Special legal form',
};

const lit = (s) => '"' + String(s).toLowerCase().replace(/["\\\n\r]/g, '') + '"';
const uidDigits = (s) => { const m = String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, '').match(/^CHE(\d{9})/) || String(s || '').replace(/\D/g, '').match(/^(\d{9})$/); return m ? m[1] : null; };
const fmtUid = (d) => `CHE-${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6)}`;

async function sparql(fetchFn, q) {
  const d = await getJson(fetchFn, ENDPOINT, { source: 'Zefix (Switzerland)', method: 'POST', form: 'query=' + encodeURIComponent(PREFIX + q),
    headers: { Accept: 'application/sparql-results+json' }, timeoutMs: 20000 });
  return (d && d.results && d.results.bindings) || [];
}

// IDs: the Zefix company number from LINDAS (ch:108994), or a UID (CHE-101.502.641) from GLEIF.
function normalise(n) {
  const s = String(n || '').trim();
  const u = uidDigits(s);
  if (u) return `CHE${u}`;
  return /^\d{1,8}$/.test(s) ? s : null;
}

const SELECT = `SELECT ?c ?name ?uid ?street ?zip ?city ?lf ?desc WHERE {
  %FILTER%
  OPTIONAL { ?c schema:identifier ?id . FILTER(CONTAINS(STR(?id), "/UID/")) BIND(STRAFTER(STR(?id), "/UID/") AS ?uid) }
  OPTIONAL { ?c schema:address ?a . ?a schema:streetAddress ?street . OPTIONAL { ?a schema:postalCode ?zip } OPTIONAL { ?a schema:addressLocality ?city } }
  OPTIONAL { ?c schema:additionalType ?lf }
  OPTIONAL { ?c schema:description ?desc }
}`;

async function search(fetchFn, q) {
  const u = uidDigits(q);
  const where = u
    ? `?c a <https://schema.ld.admin.ch/ZefixOrganisation> ; schema:legalName ?name ; schema:identifier ?uidIri . FILTER(STRENDS(STR(?uidIri), "/UID/CHE${u}"))`
    : `?c a <https://schema.ld.admin.ch/ZefixOrganisation> ; schema:legalName ?name . FILTER(CONTAINS(LCASE(STR(?name)), ${lit(q)}))`;
  const rows = await sparql(fetchFn, SELECT.replace('%FILTER%', where) + ' LIMIT 15');
  const seen = new Set();
  return rows.filter((b) => (seen.has(b.c.value) ? false : seen.add(b.c.value))).map((b) => ({
    number: b.c.value.split('/').pop(), match: b.uid ? `CHE${uidDigits(b.uid.value)}` : null, name: b.name.value, city: b.city ? b.city.value : null, status: 'active', incorporated: null,
  }));
}

async function get(fetchFn, number) {
  const id = normalise(number);
  if (!id) return null;
  const where = id.startsWith('CHE')
    ? `?c a <https://schema.ld.admin.ch/ZefixOrganisation> ; schema:legalName ?name ; schema:identifier ?uidIri . FILTER(STRENDS(STR(?uidIri), "/UID/${id}"))`
    : `BIND(<https://register.ld.admin.ch/zefix/company/${id}> AS ?c) ?c schema:legalName ?name .`;
  const rows = await sparql(fetchFn, SELECT.replace('%FILTER%', where) + ' LIMIT 5');
  const b = rows[0];
  if (!b) return null;
  const names = await sparql(fetchFn, `SELECT DISTINCT ?n WHERE { <${b.c.value}> schema:name ?n }`);
  const legal = b.name.value;
  const lf = b.lf ? b.lf.value.split('/').pop() : null;
  const uid = b.uid ? uidDigits(b.uid.value) : null;
  return record({
    register: { name: 'Commercial register (Zefix, Switzerland)', number: uid ? fmtUid(uid) : b.c.value.split('/').pop(), url: uid ? `https://www.zefix.ch/en/search/entity/list?name=${fmtUid(uid)}` : 'https://www.zefix.ch/' },
    legal_name: legal,
    other_names: [...new Set(names.filter((x) => x.n).map((x) => x.n.value).filter((n) => n !== legal))],
    legal_form: lf ? FORMS[lf] || `Legal form code ${lf}` : null,
    status_label: 'In the commercial register',
    registered_address: [b.street && b.street.value, [b.zip && b.zip.value, b.city && b.city.value].filter(Boolean).join(' '), 'Switzerland'].filter(Boolean).join(', '),
    extra: [uid ? ['UID', fmtUid(uid)] : null, b.desc ? ['Purpose', b.desc.value.length > 300 ? b.desc.value.slice(0, 297) + '…' : b.desc.value] : null].filter(Boolean),
    is_sole_trader: lf === '0101',
  });
}

module.exports = { country: 'CH', name: 'Zefix (Switzerland)', search, get, normalise };
