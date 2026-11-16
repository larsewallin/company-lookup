// Sanctions screening against four official, public lists, for companies (entities) only:
//   US OFAC SDN list and Consolidated (non-SDN) list (sanctionslistservice.ofac.treas.gov, public domain)
//   EU consolidated financial sanctions list (webgate.ec.europa.eu FSF, reuse under Decision 2011/833/EU)
//   UN Security Council consolidated list (scsanctions.un.org)
//   UK Sanctions List (sanctionslist.fcdo.gov.uk, Open Government Licence; the only UK list since 28 Jan 2026)
// The lists are downloaded once a day (api/sanctions-import.js) into one compact index in the Blob store.
// Individuals are not screened: Company Lookup covers companies, not private persons.
//
// A name match is a prompt to review, never a determination: same or similar names are common, and
// identity is confirmed on other details (address, registration number, ownership).
'use strict';

const presence = require('./presence');

// Legal-form phrases common on sanctions lists (Russian and CIS forms written out in English).
const FORM_PHRASES = /\b(?:(?:open|closed|public|private|non[- ]public)\s+)?joint[- ]stock\s+compan(?:y|ies)\b|\blimited\s+liability\s+(?:company|partnership)\b|\bstate\s+unitary\s+enterprise\b|\bfederal\s+state\s+unitary\s+enterprise\b|\bsociety\s+with\s+limited\s+liability\b/gi;
/** Name normalisation for screening: as for presence data, plus the long legal-form phrases above. */
function normaliseName(s) {
  return presence.normaliseName(String(s || '').replace(FORM_PHRASES, ' '));
}

const NOTICE = 'Screening of the company name against public sanctions lists. A possible match needs review; '
  + 'it is not a finding that the company is sanctioned. Not a compliance system.';

const SOURCES = {
  ofac_sdn: {
    name: 'US OFAC SDN list', short: 'OFAC SDN', licence: 'Public domain (US Government)',
    files: ['SDN.CSV', 'ALT.CSV', 'ADD.CSV'].map((f) => `https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/${f}`),
    search: 'https://sanctionssearch.ofac.treas.gov/',
  },
  ofac_cons: {
    name: 'US OFAC Consolidated (non-SDN) list', short: 'OFAC non-SDN', licence: 'Public domain (US Government)',
    files: ['CONS_PRIM.CSV', 'CONS_ALT.CSV', 'CONS_ADD.CSV'].map((f) => `https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/${f}`),
    search: 'https://sanctionssearch.ofac.treas.gov/',
  },
  eu: {
    name: 'EU consolidated financial sanctions list', short: 'EU', licence: 'Reuse under Commission Decision 2011/833/EU',
    files: ['https://webgate.ec.europa.eu/fsd/fsf/public/files/csvFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw'],
    search: 'https://www.sanctionsmap.eu/',
  },
  un: {
    name: 'UN Security Council consolidated list', short: 'UN', licence: 'United Nations (official public list)',
    files: ['https://scsanctions.un.org/resources/xml/en/consolidated.xml'],
    search: 'https://main.un.org/securitycouncil/en/content/un-sc-consolidated-list',
  },
  uk: {
    name: 'UK Sanctions List', short: 'UK', licence: 'Open Government Licence v3.0',
    files: ['https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.csv'],
    search: 'https://search-uk-sanctions-list.service.gov.uk/',
  },
};

// ---------- CSV (quote-aware, streaming over a string) ----------

function* csvRows(text, delim = ',') {
  let i = 0; const n = text.length;
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  while (i < n) {
    const row = []; let field = ''; let q = false;
    for (; i < n; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c;
      } else if (c === '"' && field === '') q = true;
      else if (c === delim) { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        i++; break;
      } else field += c;
    }
    row.push(field);
    if (row.length > 1 || row[0] !== '') yield row;
  }
}

const nul = (s) => { const t = String(s == null ? '' : s).trim(); return t === '' || t === '-0-' ? null : t; };
const uniq = (a) => [...new Set(a.filter(Boolean))];

// ---------- countries: every list writes them differently ----------

let countryMap = null;
const RETIRED = new Set(['SU', 'UK', 'YU', 'CS', 'DD', 'ZR', 'TP', 'BU', 'FX', 'NT', 'AN', 'QO', 'EU', 'EZ', 'UN', 'XA', 'XB', 'XK']);
function countryCode(s) {
  if (!s) return null;
  const t = String(s).trim();
  if (/^[A-Z]{2}$/.test(t)) return t;
  if (!countryMap) {
    countryMap = new Map();
    let dn = null;
    try { dn = new Intl.DisplayNames(['en'], { type: 'region' }); } catch (e) { /* very old Node */ }
    if (dn) {
      for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
        const code = String.fromCharCode(a, b);
        let name; try { name = dn.of(code); } catch (e) { continue; }
        // First code wins; skip retired and reserved codes that share a name (SU = Russia, UK = United Kingdom).
        if (name && name !== code && !RETIRED.has(code)) {
          for (const k of [name.toLowerCase(), name.toLowerCase().replace(/ & /g, ' and ')]) if (!countryMap.has(k)) countryMap.set(k, code);
        }
      }
    }
    const extra = {
      'russian federation': 'RU', 'iran (islamic republic of)': 'IR', iran: 'IR', 'syrian arab republic': 'SY', syria: 'SY',
      'korea, north': 'KP', "democratic people's republic of korea": 'KP', 'north korea': 'KP', 'korea, south': 'KR',
      'republic of korea': 'KR', 'south korea': 'KR', turkey: 'TR', 'türkiye': 'TR', 'venezuela (bolivarian republic of)': 'VE',
      'bolivia (plurinational state of)': 'BO', 'united states': 'US', 'united states of america': 'US', usa: 'US',
      'united kingdom of great britain and northern ireland': 'GB', uk: 'GB', 'great britain': 'GB',
      'congo, democratic republic of the': 'CD', 'democratic republic of the congo': 'CD', 'congo (democratic republic)': 'CD',
      'lao people\'s democratic republic': 'LA', laos: 'LA', 'viet nam': 'VN', 'burma': 'MM', 'myanmar (burma)': 'MM',
      'republic of moldova': 'MD', 'moldova, republic of': 'MD', 'united republic of tanzania': 'TZ', 'tanzania': 'TZ',
      'west bank': 'PS', 'gaza': 'PS', 'palestinian territories': 'PS', 'state of palestine': 'PS', 'crimea': 'UA',
      'czech republic': 'CZ', 'brunei darussalam': 'BN', 'cabo verde': 'CV', 'cape verde': 'CV', 'cote d\'ivoire': 'CI',
      "côte d'ivoire": 'CI', 'ivory coast': 'CI', 'hong kong sar': 'HK', 'macau': 'MO', 'macao': 'MO', 'taiwan, province of china': 'TW',
      'the netherlands': 'NL', 'netherlands (the)': 'NL', 'uae': 'AE', 'kyrgyz republic': 'KG', 'slovak republic': 'SK',
    };
    for (const [k, v] of Object.entries(extra)) countryMap.set(k, v);
  }
  return countryMap.get(t.toLowerCase().replace(/\s+/g, ' ')) || null;
}

// ---------- parsers: each returns [{ list, id, name, aliases, programmes, countries, listed_on, url }] ----------

function parseOfac(list, prim, alt, add) {
  const by = new Map();
  for (const r of csvRows(prim)) {
    const type = nul(r[2]);
    if (type) continue; // 'individual', 'vessel', 'aircraft'; entities have no type ('-0-')
    const id = nul(r[0]); const name = nul(r[1]);
    if (!id || !name) continue;
    by.set(id, { list, id, name, aliases: [], programmes: uniq(String(r[3] || '').split(/[;\]\[]+/).map((x) => nul(x.replace(/[[\]]/g, '')))),
      countries: [], listed_on: null, remarks: nul(r[11]) });
  }
  for (const r of csvRows(alt)) {
    const e = by.get(nul(r[0])); const nm = nul(r[3]);
    if (e && nm) e.aliases.push(nm);
  }
  for (const r of csvRows(add)) {
    const e = by.get(nul(r[0])); const c = countryCode(nul(r[4]));
    if (e && c) e.countries.push(c);
  }
  return [...by.values()].map((e) => ({ ...e, aliases: uniq(e.aliases), countries: uniq(e.countries),
    url: `https://sanctionssearch.ofac.treas.gov/Details.aspx?id=${encodeURIComponent(e.id)}` }));
}

function parseEu(text) {
  const rows = csvRows(text, ';');
  const head = rows.next().value || [];
  const col = (name) => head.findIndex((h) => h.replace(/^﻿/, '') === name);
  const C = {
    id: col('Entity_LogicalId'), type: col('Entity_SubjectType_ClassificationCode'), ref: col('Entity_EU_ReferenceNumber'),
    date: col('Entity_DesignationDate'), reg: col('Entity_Regulation_NumberTitle'), prog: col('Entity_Regulation_Programme'),
    url: col('Entity_Regulation_PublicationUrl'), name: col('NameAlias_WholeName'), addr: col('Address_CountryIso2Code'),
    cit: col('Citizenship_CountryIso2Code'),
  };
  if (C.id < 0 || C.name < 0 || C.type < 0) throw new Error('EU list layout changed (columns not found)');
  const by = new Map();
  for (const r of rows) {
    if (r[C.type] !== 'enterprise') continue;
    const id = nul(r[C.id]); if (!id) continue;
    let e = by.get(id);
    if (!e) {
      e = { list: 'eu', id, name: null, aliases: [], programmes: [], countries: [], listed_on: nul(r[C.date]),
        regulation: nul(r[C.reg]), url: nul(r[C.url]), eu_ref: nul(r[C.ref]) };
      by.set(id, e);
    }
    const nm = nul(r[C.name]);
    if (nm) { if (!e.name) e.name = nm; else e.aliases.push(nm); }
    if (nul(r[C.prog])) e.programmes.push(nul(r[C.prog]));
    for (const k of [C.addr, C.cit]) if (k >= 0 && /^[A-Z]{2}$/.test(r[k] || '')) e.countries.push(r[k]);
  }
  return [...by.values()].filter((e) => e.name).map((e) => ({ ...e, aliases: uniq(e.aliases).filter((a) => a !== e.name),
    programmes: uniq(e.programmes), countries: uniq(e.countries) }));
}

const xmlText = (s) => String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (m, d) => String.fromCharCode(+d)).replace(/&amp;/g, '&').trim();
const tag = (block, name) => { const m = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`)); return m ? nul(xmlText(m[1])) : null; };
const tags = (block, name) => [...block.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'g'))].map((m) => nul(xmlText(m[1])));

function parseUn(xml) {
  const out = [];
  for (const m of xml.matchAll(/<ENTITY>([\s\S]*?)<\/ENTITY>/g)) {
    const b = m[1];
    const name = tag(b, 'FIRST_NAME'); const ref = tag(b, 'REFERENCE_NUMBER');
    if (!name || !ref) continue;
    const aliases = [...b.matchAll(/<ENTITY_ALIAS>([\s\S]*?)<\/ENTITY_ALIAS>/g)].map((a) => tag(a[1], 'ALIAS_NAME'));
    const countries = [...b.matchAll(/<ENTITY_ADDRESS>([\s\S]*?)<\/ENTITY_ADDRESS>/g)].map((a) => countryCode(tag(a[1], 'COUNTRY')));
    out.push({ list: 'un', id: ref, name, aliases: uniq(aliases), programmes: uniq([tag(b, 'UN_LIST_TYPE')]),
      countries: uniq(countries), listed_on: tag(b, 'LISTED_ON'),
      url: 'https://main.un.org/securitycouncil/en/content/un-sc-consolidated-list' });
  }
  if (!out.length && !/<CONSOLIDATED_LIST/.test(xml)) throw new Error('UN list layout changed (no CONSOLIDATED_LIST)');
  return out;
}

const ukDate = (s) => { const m = String(s || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/); return m ? `${m[3]}-${m[2]}-${m[1]}` : s || null; };

function parseUk(text) {
  const rows = csvRows(text, ',');
  let head = rows.next().value || [];
  if (!head.includes('Unique ID')) head = rows.next().value || []; // first line is "Report Date: …"
  const col = (name) => head.indexOf(name);
  const C = { id: col('Unique ID'), name: col('Name 6'), ntype: col('Name type'), regime: col('Regime Name'),
    dtype: col('Designation Type'), date: col('Date Designated'), country: col('Address Country'),
    reg: col('Business registration number(s)') };
  if (C.id < 0 || C.name < 0 || C.dtype < 0) throw new Error('UK list layout changed (columns not found)');
  const by = new Map();
  for (const r of rows) {
    if (String(r[C.dtype] || '').trim().toLowerCase() !== 'entity') continue;
    const id = nul(r[C.id]); const nm = nul(r[C.name]);
    if (!id || !nm) continue;
    let e = by.get(id);
    if (!e) { e = { list: 'uk', id, name: null, aliases: [], programmes: [], countries: [], listed_on: ukDate(nul(r[C.date])) }; by.set(id, e); }
    if (/^primary name$/i.test(String(r[C.ntype] || '').trim()) && !e.name) e.name = nm; else e.aliases.push(nm);
    if (nul(r[C.regime])) e.programmes.push(nul(r[C.regime]));
    const c = countryCode(nul(r[C.country])); if (c) e.countries.push(c);
  }
  return [...by.values()].map((e) => {
    const name = e.name || e.aliases[0];
    return { ...e, name, aliases: uniq(e.aliases).filter((a) => a !== name), programmes: uniq(e.programmes), countries: uniq(e.countries),
      url: 'https://search-uk-sanctions-list.service.gov.uk/' };
  });
}

// ---------- index ----------

/** Compact index: names normalised once at build time. */
function buildIndex(entriesByList, meta, builtAt) {
  const entries = [];
  for (const list of Object.keys(entriesByList)) {
    for (const e of entriesByList[list]) {
      const names = uniq([e.name, ...e.aliases]).slice(0, 40);
      entries.push({
        l: list, i: e.id, n: e.name, a: names.slice(1), p: e.programmes.slice(0, 6), c: e.countries.slice(0, 10),
        d: e.listed_on || null, u: e.url || null, k: names.map((x) => normaliseName(x)).filter((x) => x && x.length >= 2),
      });
    }
  }
  return { built_at: builtAt, notice: NOTICE, lists: meta, entries };
}

// ---------- matching ----------

// Words too common to match on alone ("Global", "Trading", "Bank").
const COMMON = new Set(['international', 'global', 'trading', 'trade', 'group', 'holding', 'holdings', 'company', 'bank', 'general',
  'services', 'service', 'industries', 'industry', 'industrial', 'energy', 'oil', 'gas', 'shipping', 'investment', 'investments',
  'development', 'management', 'enterprise', 'enterprises', 'commercial', 'import', 'export', 'logistics', 'construction', 'technology',
  'technologies', 'solutions', 'national', 'united', 'capital', 'finance', 'financial', 'resources', 'petroleum', 'airlines', 'air',
  'marine', 'maritime', 'engineering', 'systems', 'products', 'foundation', 'organization', 'organisation', 'center', 'centre',
  'new', 'first', 'world', 'east', 'west', 'north', 'south', 'middle', 'star', 'gold', 'golden', 'the', 'of', 'for', 'de', 'la', 'al']);

function trigrams(s) {
  const t = ` ${s} `; const g = new Set();
  for (let i = 0; i < t.length - 2; i++) g.add(t.slice(i, i + 3));
  return g;
}
function dice(a, b) {
  if (!a.size || !b.size) return 0;
  let n = 0; for (const x of a) if (b.has(x)) n++;
  return (2 * n) / (a.size + b.size);
}

/** How well one normalised list name matches the normalised query. 0 = no match. */
function score(q, qTok, qTri, name) {
  if (name === q) return qTok.some((t) => !COMMON.has(t) && t.length >= 3) ? 1 : 0.86; // "Global Trading" alone is not distinctive
  const nTok = name.split(' ');
  const qs = new Set(qTok); const ns = new Set(nTok);
  let inter = 0; for (const t of qs) if (ns.has(t)) inter++;
  const jac = inter / (qs.size + ns.size - inter);
  const [small, big] = qs.size <= ns.size ? [qs, ns] : [ns, qs];
  const contained = [...small].every((t) => big.has(t));
  const distinctive = [...small].filter((t) => !COMMON.has(t) && t.length >= 4);
  if (jac >= 0.9) return 0.95;
  if (contained && small.size >= 2 && distinctive.length >= 1) return 0.9;
  // One distinctive word ("Rosneft") matches a list name only if every other word there is a common one
  // ("Rosneft Oil"), never "Oriental Apple" for "Apple".
  if (contained && small.size === 1 && distinctive.length === 1 && distinctive[0].length >= 5
    && [...big].every((t) => small.has(t) || COMMON.has(t))) return 0.86;
  // Spelling variants (transliteration): only for names of similar length, and never on common words alone
  if (Math.abs(name.length - q.length) <= Math.max(3, q.length * 0.25) && qTok.some((t) => !COMMON.has(t) && t.length >= 4)) {
    const d = dice(qTri, trigrams(name));
    if (d >= 0.86) return Math.min(0.89, d);
  }
  return 0;
}

/**
 * Screen one name against the index.
 * Returns { query, normalised, matches: [{ level, score, list, list_name, id, name, matched_name, programmes, countries,
 * listed_on, url, same_country }] } with level 'exact' (same name after normalisation), 'strong' or 'possible'.
 */
function screen(index, name, { country = null, limit = 10 } = {}) {
  const q = normaliseName(name);
  const out = { query: name, normalised: q, matches: [] };
  if (!q || q.length < 2) return out;
  const qTok = q.split(' '); const qTri = trigrams(q);
  for (const e of index.entries) {
    let best = 0; let bestIdx = -1;
    for (let k = 0; k < e.k.length; k++) {
      const s = score(q, qTok, qTri, e.k[k]);
      if (s > best) { best = s; bestIdx = k; }
      if (best === 1) break;
    }
    if (!best) continue;
    const names = [e.n, ...e.a];
    const meta = index.lists[e.l] || {};
    out.matches.push({
      level: best === 1 ? 'exact' : best >= 0.9 ? 'strong' : 'possible',
      score: Math.round(best * 100) / 100,
      list: e.l, list_name: meta.name || e.l, id: e.i, name: e.n,
      matched_name: names[bestIdx] || e.n, programmes: e.p, countries: e.c, listed_on: e.d, url: e.u,
      same_country: country && e.c.length ? e.c.includes(country) : null,
    });
  }
  const rank = { exact: 0, strong: 1, possible: 2 };
  out.matches.sort((a, b) => rank[a.level] - rank[b.level] || (b.same_country === true) - (a.same_country === true) || b.score - a.score);
  out.matches = out.matches.slice(0, limit);
  return out;
}

/** The lists block shown with every result: which lists, when they were fetched, how many entities. */
function listsSummary(index) {
  return Object.entries(index.lists).map(([k, v]) => ({ list: k, name: v.name, entities: v.entities, fetched_at: v.fetched_at,
    licence: v.licence, search: v.search, ...(v.error ? { error: v.error } : {}) }));
}

// ---------- loading the index from the Blob store ----------

const PATH = 'sanctions/index.json';

/** Reads sanctions/index.json from the Blob store, cached in memory for an hour. */
function createSanctionsStore({ fetchFn = fetch, base = null, nowMs = () => Date.now(), ttlMs = 3600000 } = {}) {
  let cached = null; let at = 0; let pending = null;
  async function load() {
    if (!base) return null;
    if (cached && nowMs() - at < ttlMs) return cached;
    if (pending) return pending;
    pending = (async () => {
      try {
        const res = await fetchFn(`${base}/${PATH}?v=${Math.floor(nowMs() / ttlMs)}`);
        if (!res.ok) return cached;
        const idx = await res.json();
        if (idx && Array.isArray(idx.entries)) { cached = idx; at = nowMs(); }
        return cached;
      } catch (e) {
        return cached;
      } finally { pending = null; }
    })();
    return pending;
  }
  return { enabled: !!base, load };
}

module.exports = { PATH, createSanctionsStore, NOTICE, SOURCES, csvRows, countryCode, parseOfac, parseEu, parseUn, parseUk, buildIndex, screen, listsSummary, normaliseName };
