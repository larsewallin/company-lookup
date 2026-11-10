// Wikidata: free, open (CC0) facts about notable companies. Used to enrich cards, never as a register.
// Matched only by exact identifiers (LEI or a national company number), never by name.
'use strict';
const { userAgent } = require('./ua');

const { getJson } = require('./http');

const ENDPOINT = 'https://query.wikidata.org/sparql';
// Wikimedia asks automated clients for a descriptive User-Agent.
const UA = userAgent();

// Wikidata properties holding national company numbers (checked against live data 2026-11-08).
// US uses the SEC CIK (10 digits); BR the formatted CNPJ.
const NATIONAL_PROP = { GB: 'P2622', FR: 'P1616', NO: 'P2333', FI: 'P12980', CZ: 'P4156', US: 'P5531', BR: 'P6204' };

const lit = (s) => '"' + String(s).replace(/["\\\n\r]/g, '') + '"';

function buildQuery({ lei, country, number }) {
  const ids = [];
  if (lei && /^[A-Z0-9]{20}$/.test(lei)) ids.push(`{ ?item wdt:P1278 ${lit(lei)} }`);
  if (number && NATIONAL_PROP[country]) ids.push(`{ ?item wdt:${NATIONAL_PROP[country]} ${lit(number)} }`);
  if (!ids.length) return null;
  return `SELECT ?item ?label ?article (GROUP_CONCAT(DISTINCT STR(?website);separator="|") AS ?websites) (MIN(?inception) AS ?founded)
 (GROUP_CONCAT(DISTINCT CONCAT(?hqL,"@",COALESCE(?hqCountry,""));separator="|") AS ?hqs)
 (GROUP_CONCAT(DISTINCT CONCAT(STRAFTER(STR(?parent),"entity/"),"@",?parentL);separator="|") AS ?parents)
 (GROUP_CONCAT(DISTINCT ?subL;separator="|") AS ?subs)
 (GROUP_CONCAT(DISTINCT ?industryL;separator="|") AS ?industries)
 (GROUP_CONCAT(DISTINCT CONCAT(STR(?emp),"@",COALESCE(STR(?empDate),""));separator="|") AS ?emps)
 (GROUP_CONCAT(DISTINCT CONCAT(?exL,"@",COALESCE(?ticker,""));separator="|") AS ?listings)
WHERE {
  ${ids.join(' UNION ')}
  OPTIONAL { ?item rdfs:label ?label FILTER(LANG(?label)="en") }
  OPTIONAL { ?item wdt:P856 ?website }
  OPTIONAL { ?item wdt:P571 ?inception }
  OPTIONAL { ?item wdt:P159 ?hq . ?hq rdfs:label ?hqL FILTER(LANG(?hqL)="en") OPTIONAL { ?hq wdt:P17/wdt:P297 ?hqCountry } }
  OPTIONAL { ?item wdt:P749 ?parent . ?parent rdfs:label ?parentL FILTER(LANG(?parentL)="en") }
  OPTIONAL { ?item wdt:P355 ?sub . ?sub rdfs:label ?subL FILTER(LANG(?subL)="en") }
  OPTIONAL { ?item wdt:P452 ?industry . ?industry rdfs:label ?industryL FILTER(LANG(?industryL)="en") }
  OPTIONAL { ?item p:P1128 ?es . ?es ps:P1128 ?emp . OPTIONAL { ?es pq:P585 ?empDate } }
  OPTIONAL { ?item p:P414 ?xs . ?xs ps:P414 ?ex . ?ex rdfs:label ?exL FILTER(LANG(?exL)="en") OPTIONAL { ?xs pq:P249 ?ticker } }
  OPTIONAL { ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> }
} GROUP BY ?item ?label ?article LIMIT 3`;
}

const split = (b, k) => (b[k] && b[k].value ? b[k].value.split('|').filter(Boolean) : []);

// Prefer a bare domain (no path), then .com, then the company's own country TLD, then the shortest.
function pickWebsite(urls, country) {
  if (!urls.length) return null;
  const cc = country ? '.' + country.toLowerCase() : null;
  const score = (u) => {
    let host = u; let path = '';
    try { const x = new URL(u); host = x.hostname; path = x.pathname.replace(/\/$/, ''); } catch (e) { /* keep raw */ }
    return [path ? 1 : 0, host.endsWith('.com') ? 0 : cc && host.endsWith(cc) ? 1 : 2, u.length];
  };
  return urls.map((u) => [score(u), u]).sort((a, b) => {
    for (let i = 0; i < 3; i++) if (a[0][i] !== b[0][i]) return a[0][i] - b[0][i];
    return a[1] < b[1] ? -1 : 1;
  })[0][1];
}

function parse(b, country) {
  if (!b) return null;
  const qid = b.item.value.split('/').pop();
  const emps = split(b, 'emps').map((s) => { const [v, d] = s.split('@'); return { v: Number(v), d: d ? d.slice(0, 10) : '' }; })
    .filter((x) => Number.isFinite(x.v)).sort((a, c) => (a.d < c.d ? 1 : a.d > c.d ? -1 : c.v - a.v));
  const hq = split(b, 'hqs').map((s) => { const [city, cc] = s.split('@'); return { city, country: cc || null }; })[0] || null;
  return {
    qid,
    url: `https://www.wikidata.org/wiki/${qid}`,
    label: b.label ? b.label.value : null,
    wikipedia: b.article ? b.article.value : null,
    website: pickWebsite(split(b, 'websites'), country),
    founded: b.founded ? String(b.founded.value).slice(0, 10) : null,
    hq,
    parents: split(b, 'parents').map((s) => { const i = s.indexOf('@'); return { qid: s.slice(0, i), name: s.slice(i + 1) }; }),
    industries: split(b, 'industries').slice(0, 4),
    subsidiaries: split(b, 'subs').slice(0, 40),
    employees: emps[0] ? { count: emps[0].v, as_of: emps[0].d || null } : null,
    listings: split(b, 'listings').map((s) => { const [exchange, ticker] = s.split('@'); return { exchange, ticker: ticker || null }; }),
  };
}

async function lookup(fetchFn, { lei, country, number }) {
  const q = buildQuery({ lei, country, number });
  if (!q) return null;
  const data = await getJson(fetchFn, `${ENDPOINT}?format=json&query=${encodeURIComponent(q)}`, {
    source: 'Wikidata', headers: { 'User-Agent': UA, Accept: 'application/sparql-results+json' },
  });
  const rows = (data && data.results && data.results.bindings) || [];
  // Several items can share an identifier (duplicates); prefer the one with a Wikipedia article, then a label.
  const best = rows.slice().sort((x, y) => (x.article ? 0 : 1) - (y.article ? 0 : 1) || (x.label ? 0 : 1) - (y.label ? 0 : 1))[0];
  return parse(best, country);
}

// Companies trading under a stock ticker (P414 stock exchange, qualifier P249 ticker), with an LEI.
async function byTicker(fetchFn, ticker) {
  const t = String(ticker || '').trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9.\-]{0,7}$/.test(t) || /^\d+$/.test(t)) return [];
  const q = `SELECT ?item ?lei (SAMPLE(?exL) AS ?exchange) (SAMPLE(?exC) AS ?exCountry) WHERE {
  ?item p:P414 ?s . ?s pq:P249 ${lit(t)} ; ps:P414 ?ex . ?ex rdfs:label ?exL FILTER(LANG(?exL)="en")
  OPTIONAL { ?ex wdt:P17/wdt:P297 ?exC }
  ?item wdt:P1278 ?lei } GROUP BY ?item ?lei LIMIT 10`;
  const data = await getJson(fetchFn, `${ENDPOINT}?format=json&query=${encodeURIComponent(q)}`, {
    source: 'Wikidata', headers: { 'User-Agent': UA, Accept: 'application/sparql-results+json' }, timeoutMs: 6000,
  });
  const rows = (data && data.results && data.results.bindings) || [];
  return rows.map((b) => ({ item: b.item.value.split('/').pop(), lei: b.lei.value, exchange: b.exchange ? b.exchange.value : null, exchange_country: b.exCountry ? b.exCountry.value : null, ticker: t }));
}

module.exports = { lookup, byTicker, buildQuery, parse, pickWebsite, NATIONAL_PROP };
