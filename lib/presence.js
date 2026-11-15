// Presence data (tier 3): Overture Maps places. Pure functions only: the card, name and domain
// normalisation, and the rules that link a place to a legal entity.
//
// Presence data says a business appears to exist at an address. It is not an official record and not a
// legal identifier, so a presence card has no verdict, no flags and no status, and it never overwrites a
// register fact. Order of trust: official register, then GLEIF, then presence data.
'use strict';

const { normName } = require('./gleif');

const NOTICE = 'Presence data from Overture Maps. Not an official record and not a legal identifier.';
const LABEL = 'Not an official record';
const ATTRIBUTION = '© Overture Maps Foundation';

// ---------- normalisation ----------

// Legal-form words beyond the ones GLEIF ranking already strips (gleif.normName).
const EXTRA_FORMS = new Set(['tbk', 'pt', 'cv', 'ud', 'sau', 'slu', 'slne', 'sccl', 'scs', 'sca', 'snc', 'sasu', 'eurl', 'sprl', 'srls',
  'sapa', 'scarl', 'lda', 'ltda', 'eireli', 'me', 'epp', 'bhd', 'sdn', 'pvt', 'private', 'pjsc', 'jsc', 'ooo', 'zao', 'oao', 'sro', 'spol',
  'kft', 'zrt', 'nyrt', 'doo', 'dd', 'ad', 'ead', 'ood', 'ehf', 'hf', 'ky', 'tmi', 'as', 'ou', 'uab', 'sia', 'tov', 'llc', 'fze', 'fzco',
  'wll', 'est', 'gk', 'yk', 'ltd', 'co', 'cia', 'y', 'e', 'et', 'und', 'and', '&']);

/** Lower-case, accents and punctuation removed, legal suffixes (Ltd, GmbH, SA, Tbk…) dropped. */
function normaliseName(s) {
  return normName(String(s || '').replace(/&/g, ' and ')).split(' ').filter((w) => w && !EXTRA_FORMS.has(w)).join(' ');
}

// Names are similar when, after normalisation, they are equal, or the shorter one's words all appear
// in the longer one and cover at least half of it ("Coleago Consulting" ~ "Coleago Consulting Services").
function similarNames(a, b) {
  const x = normaliseName(a); const y = normaliseName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.replace(/ /g, '') === y.replace(/ /g, '')) return true;
  const [s, l] = x.split(' ').length <= y.split(' ').length ? [x.split(' '), y.split(' ')] : [y.split(' '), x.split(' ')];
  const longSet = new Set(l);
  return s.every((w) => longSet.has(w)) && s.length / l.length >= 0.5 && s.join('').length >= 4;
}

// Second-level suffixes under which registrations happen (example.co.uk, example.com.au).
const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'gov', 'ac', 'edu', 'ltd', 'plc', 'me', 'or', 'ne', 'go', 'gob', 'gouv', 'nom', 'biz', 'info', 'web', 'sch', 'mil', 'id', 'asn']);
// Hosts that are platforms, not a company's own site: never evidence of identity.
const PLATFORMS = new Set(['facebook.com', 'fb.com', 'instagram.com', 'twitter.com', 'x.com', 'linkedin.com', 'youtube.com', 'tiktok.com',
  'whatsapp.com', 'wa.me', 'linktr.ee', 'google.com', 'goo.gl', 'business.site', 'wixsite.com', 'blogspot.com', 'wordpress.com',
  'yelp.com', 'tripadvisor.com', 'foursquare.com', 'booking.com', 'wikipedia.org', 'tokko.io', 'tokopedia.com', 'shopee.co.id', 'bit.ly']);

/** The registrable domain of a URL or host ("https://www.shop.acme.co.uk/x" → "acme.co.uk"), or null. */
function registrableDomain(input) {
  if (!input) return null;
  let s = String(input).trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#]/)[0].replace(/^[^@]*@/, '').replace(/:\d+$/, '').replace(/\.$/, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s)) return null;
  const parts = s.split('.');
  const take = parts.length >= 3 && parts[parts.length - 1].length === 2 && SECOND_LEVEL.has(parts[parts.length - 2]) ? 3 : 2;
  return parts.slice(-take).join('.');
}

/** A company's own domain from a URL, or null for social and listing platforms. */
function companyDomain(input) {
  const d = registrableDomain(input);
  return d && !PLATFORMS.has(d) ? d : null;
}

const normPostcode = (p) => (p ? String(p).toUpperCase().replace(/[^A-Z0-9]/g, '') : null);
const normStreet = (s) => (s ? normName(String(s).split(',')[0]).replace(/\b(street|st|road|rd|avenue|ave|av|avenida|calle|rue|boulevard|bd|blvd|jalan|jl)\b/g, '').replace(/\s+/g, ' ').trim() : null);

// Postcode and street from a free-text register address ("77 Abbotsbury Road, London, W14 8EP").
function addressParts(addr) {
  if (!addr) return { street: null, postcode: null };
  if (typeof addr === 'object') return { street: addr.street || addr.address_line_1 || addr.freeform || null, postcode: addr.postcode || addr.postal_code || null };
  const s = String(addr);
  const uk = s.match(/\b([A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2})\b/i);
  const num = s.match(/\b(\d{4,6})\b/);
  return { street: s.split(',')[0], postcode: uk ? uk[1] : num ? num[1] : null };
}

// ---------- matching ----------

/**
 * Classify one legal-entity candidate against a presence record.
 * presence: a presence card (name, address.country, address.postcode, address.street, websites)
 * entity:   { id, name, country, website, address, register }
 * Returns { level: 'strong' | 'probable' | 'none', evidence: {...} }.
 *   strong   same company domain AND similar name, same country: linked automatically.
 *   probable similar name AND same street or postcode (no domain evidence), or same domain with a
 *            very different name: shown as "possibly the same as…", never merged.
 * Brand is never used: outlets of one brand are often separate legal entities.
 */
function classify(presence, entity) {
  const none = { level: 'none', evidence: {} };
  const pc = presence.address && presence.address.country;
  if (!pc || !entity.country || pc !== entity.country) return none;
  const nameOk = similarNames(presence.name, entity.name);
  const pDomains = new Set((presence.websites || []).map(companyDomain).filter(Boolean));
  const eDomain = companyDomain(entity.website);
  const domain = eDomain && pDomains.has(eDomain) ? eDomain : null;
  if (domain && nameOk) return { level: 'strong', evidence: { domain, name: [presence.name, entity.name], country: pc } };
  if (domain) return { level: 'probable', evidence: { domain, name_differs: [presence.name, entity.name], country: pc } };
  if (!nameOk) return none;
  const ea = addressParts(entity.address);
  const pp = normPostcode(presence.address.postcode); const ep = normPostcode(ea.postcode);
  const ps = normStreet(presence.address.street); const es = normStreet(ea.street);
  if (pp && ep && pp === ep) return { level: 'probable', evidence: { name: [presence.name, entity.name], postcode: presence.address.postcode, country: pc } };
  if (ps && es && ps === es) return { level: 'probable', evidence: { name: [presence.name, entity.name], street: presence.address.street, country: pc } };
  return none;
}

/** Best match over candidates: the single strong match if exactly one, plus probable ones (max 3). */
function bestMatch(presence, entities) {
  const scored = entities.map((e) => ({ entity: e, ...classify(presence, e) })).filter((x) => x.level !== 'none');
  const strong = scored.filter((x) => x.level === 'strong');
  // Two different entities both "strong" is ambiguous: demote both to probable rather than guess.
  if (strong.length > 1) strong.forEach((x) => { x.level = 'probable'; });
  return {
    strong: strong.length === 1 ? strong[0] : null,
    probable: scored.filter((x) => x.level === 'probable').slice(0, 3),
  };
}

// ---------- the card ----------

const clean = (a) => (Array.isArray(a) ? a.filter((x) => x != null && String(x).trim()) : []);
const round = (n) => Math.round(n * 1e6) / 1e6;

// One entry per source dataset and licence, with its latest update time and what it contributed.
function sourceList(sources) {
  const by = new Map();
  for (const s of sources || []) {
    if (!s || !s.dataset) continue;
    const key = `${s.dataset}|${s.license || ''}`;
    const e = by.get(key) || { dataset: s.dataset, license: s.license || null, update_time: null, record_id: null, properties: [] };
    if (s.update_time && (!e.update_time || String(s.update_time) > e.update_time)) e.update_time = String(s.update_time);
    if (!e.record_id && s.record_id) e.record_id = String(s.record_id);
    e.properties.push(s.property ? String(s.property).replace(/^\/properties\//, '') : 'record');
    by.set(key, e);
  }
  return [...by.values()].map((e) => ({ ...e, properties: [...new Set(e.properties)] }));
}

/**
 * A presence card from one raw Overture place row.
 * @param row        Overture places row (lib/overture.js)
 * @param release    the Overture release the row came from
 * @param checkedAt  ISO time of the fetch
 * @param registerFor (country) => register name or null, for the "Search the official register" pointer
 */
function presenceCard(row, { release, checkedAt, registerFor = () => null }) {
  const a = (row.addresses || [])[0] || {};
  const country = a.country ? String(a.country).toUpperCase() : null;
  const name = row.names && row.names.primary ? String(row.names.primary) : null;
  const b = row.bbox || {};
  const brandName = row.brand && row.brand.names && row.brand.names.primary;
  const sources = sourceList(row.sources);
  const card = {
    tier: 'presence',
    notice: NOTICE,
    id: row.id,
    name,
    categories: row.taxonomy || row.basic_category ? {
      primary: (row.taxonomy && row.taxonomy.primary) || row.basic_category || null,
      basic: row.basic_category || null,
      hierarchy: (row.taxonomy && row.taxonomy.hierarchy) || [],
      alternates: (row.taxonomy && row.taxonomy.alternates) || [],
    } : null,
    address: {
      street: a.freeform || null, locality: a.locality || null, postcode: a.postcode || null, region: a.region || null, country,
    },
    location: Number.isFinite(b.xmin) && Number.isFinite(b.ymin)
      ? { lon: round((b.xmin + (Number.isFinite(b.xmax) ? b.xmax : b.xmin)) / 2), lat: round((b.ymin + (Number.isFinite(b.ymax) ? b.ymax : b.ymin)) / 2) }
      : null,
  };
  const websites = clean(row.websites); const phones = clean(row.phones); const socials = clean(row.socials);
  if (websites.length) card.websites = websites;
  if (phones.length) card.phones = phones;
  if (socials.length) card.socials = socials;
  if (brandName) card.brand = { name: String(brandName), wikidata: row.brand.wikidata || null };
  card.confidence = Number.isFinite(row.confidence) ? Math.round(row.confidence * 1000) / 1000 : null;
  card.sources = sources;
  card.attribution = `${ATTRIBUTION}. Sources: ${sources.filter((s) => s.dataset !== 'Overture').map((s) => `${s.dataset} (${s.license || 'licence not stated'})`).join(', ') || 'Overture'}.`;
  card.release = release;
  card.checked_at = checkedAt;
  card.linked_entity = null;
  card.possible_matches = [];
  const reg = country ? registerFor(country) : null;
  card.official_register = reg && name
    ? { label: 'Search the official register', register: reg, tool: 'search_companies', arguments: { query: name.slice(0, 100), country } }
    : null;
  return card;
}

/** The short form used in search results and under a legal entity's card. */
function presenceSummary(card) {
  const s = { id: `overture:${card.id}`, tier: 'presence', label: LABEL, name: card.name, address: card.address, location: card.location };
  if (card.categories) s.category = card.categories.primary;
  if (card.websites) s.websites = card.websites;
  if (card.phones) s.phones = card.phones;
  s.sources = card.sources.map((x) => ({ dataset: x.dataset, license: x.license, update_time: x.update_time }));
  s.release = card.release;
  return s;
}

module.exports = {
  NOTICE, LABEL, ATTRIBUTION,
  normaliseName, similarNames, registrableDomain, companyDomain, addressParts,
  classify, bestMatch, presenceCard, presenceSummary, sourceList,
};
