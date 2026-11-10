// United States: there is no national company register. This adapter combines free, no-key sources:
//  - SEC EDGAR: public companies and other SEC filers (including many private Form D filers)
//  - New York Department of State, active corporations (data.ny.gov, n9v6-gdp6)
//  - Colorado Secretary of State, business entities (data.colorado.gov, 4ykn-tg5h)
//  - Connecticut Secretary of State, business registry (data.ct.gov, n7gp-d28j)
//  - Texas Comptroller, franchise tax permit holders (data.texas.gov, 9cir-efmm; codes from its record layout)
//  - Oregon Secretary of State, active businesses (data.oregon.gov, tckn-sxa6)
//  - Pennsylvania Department of State, active registrations (data.pa.gov, xvd7-5r2c)
// IDs carry the source: sec-0000018230, ny-1393779, co-19981033526, ct-2913573, tx-32106582219, or-8739914, pa-0000159516.
'use strict';
const { userAgent } = require('../ua');

const { getJson } = require('../http');
const { record, socrata, soqlString, soqlLike, soqlPrefix, isoDate, digits } = require('./_common');

// SEC asks automated clients to identify themselves; SEC_USER_AGENT may override.
const secHeaders = () => ({ 'User-Agent': process.env.SEC_USER_AGENT || userAgent() });

const STATES = {
  NY: 'New York', CO: 'Colorado', CT: 'Connecticut', TX: 'Texas', OR: 'Oregon', PA: 'Pennsylvania',
};

// ---------- SEC ----------
async function secSearch(fetchFn, q) {
  const d = await getJson(fetchFn, `https://efts.sec.gov/LATEST/search-index?keysTyped=${encodeURIComponent(q)}`, { source: 'SEC EDGAR', headers: secHeaders() });
  return (((d && d.hits && d.hits.hits) || [])).slice(0, 10).map((h) => {
    const name = String(h._source.entity || '').replace(/\s*\([A-Z0-9.,\- ]+\)\s*$/, '');
    return { number: `sec-${String(h._id).padStart(10, '0')}`, name, city: null, status: 'active', incorporated: null, source: 'SEC EDGAR' };
  });
}

const ANNUAL = new Set(['10-K', '20-F', '40-F', '10-K405']);

async function secGet(fetchFn, cik, { asOfIso } = {}) {
  const d = await getJson(fetchFn, `https://data.sec.gov/submissions/CIK${cik}.json`, { source: 'SEC EDGAR', allow404: true, headers: secHeaders() });
  if (!d || !d.name) return null;
  const rec = d.filings && d.filings.recent ? d.filings.recent : { form: [], filingDate: [] };
  const filings = (rec.form || []).map((f, i) => ({ form: f, date: rec.filingDate[i] }));
  const lastAnnual = filings.find((f) => ANNUAL.has(f.form));
  const lastAny = filings[0];
  const situations = [];
  if (lastAnnual && asOfIso) {
    const months = (Number(asOfIso.slice(0, 4)) - Number(lastAnnual.date.slice(0, 4))) * 12 + (Number(asOfIso.slice(5, 7)) - Number(lastAnnual.date.slice(5, 7)));
    const deregistered = filings.some((f) => /^15-/.test(f.form) && f.date > lastAnnual.date);
    if (deregistered) situations.push({ level: 'note', label: 'Deregistered with the SEC', detail: 'A Form 15 was filed after the last annual report, so the company no longer files with the SEC.' });
    else if (months > 15) situations.push({ level: 'check', label: 'No recent annual report', detail: `The last annual report (${lastAnnual.form}) was filed ${lastAnnual.date}.` });
  }
  const a = (d.addresses && d.addresses.business) || {};
  return record({
    register: { name: 'SEC EDGAR (US)', number: cik, url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}` },
    legal_name: d.name,
    former_names: (d.formerNames || []).map((n) => ({ name: n.name, to: isoDate(n.to) })),
    legal_form: d.entityType ? `${d.entityType[0].toUpperCase()}${d.entityType.slice(1)} entity` : null,
    status_label: 'SEC filer',
    registered_address: [a.street1, a.street2, a.city, a.stateOrCountry, a.zipCode].filter(Boolean).join(', ') || null,
    industry: d.sic ? [{ code: d.sic, label: d.sicDescription || 'SIC' }] : [],
    other_names: [],
    incorporated: null,
    extra: [
      d.stateOfIncorporationDescription || d.stateOfIncorporation ? ['Incorporated in', d.stateOfIncorporationDescription || d.stateOfIncorporation] : null,
      d.tickers && d.tickers.length ? ['Tickers', d.tickers.map((t, i) => t + (d.exchanges && d.exchanges[i] ? ` (${d.exchanges[i]})` : '')).join(', ')] : null,
      d.fiscalYearEnd ? ['Fiscal year end', `${d.fiscalYearEnd.slice(0, 2)}-${d.fiscalYearEnd.slice(2)}`] : null,
      lastAnnual ? ['Latest annual report', `${lastAnnual.form}, filed ${lastAnnual.date}`] : null,
      lastAny ? ['Latest SEC filing', `${lastAny.form}, filed ${lastAny.date}`] : null,
    ].filter(Boolean),
    last_accounts: lastAnnual ? lastAnnual.date.slice(0, 4) : null,
    situations,
  });
}

// ---------- New York ----------
const NY = { domain: 'data.ny.gov', set: 'n9v6-gdp6' };
function nyRecord(r) {
  return record({
    register: { name: 'New York Department of State', number: r.dos_id, url: 'https://apps.dos.ny.gov/publicInquiry/' },
    legal_name: r.current_entity_name,
    legal_form: r.entity_type ? r.entity_type.charAt(0) + r.entity_type.slice(1).toLowerCase() : null,
    status_label: 'Active (NY active corporations list)',
    incorporated: isoDate(r.initial_dos_filing_date),
    registered_address: [r.dos_process_address_1, r.dos_process_city, r.dos_process_state, r.dos_process_zip].filter(Boolean).join(', ') || null,
    extra: [r.jurisdiction ? ['Jurisdiction', r.jurisdiction] : null, r.county ? ['County', r.county] : null,
      r.registered_agent_name ? ['Registered agent', r.registered_agent_name] : null].filter(Boolean),
    address_note: 'Address for service of process',
  });
}

// ---------- Colorado ----------
const CO = { domain: 'data.colorado.gov', set: '4ykn-tg5h' };
function coRecord(r) {
  const st = String(r.entitystatus || '');
  const inactive = /dissolved|withdrawn|expired|revoked|converted|merged/i.test(st);
  const situations = [];
  if (/delinquent/i.test(st)) situations.push({ level: 'check', label: 'Delinquent with the state', detail: `Colorado lists the entity as "${st}", usually for a missed periodic report.` });
  return record({
    register: { name: 'Colorado Secretary of State', number: r.entityid, url: `https://www.coloradosos.gov/biz/BusinessEntityDetail.do?masterFileId=${r.entityid}` },
    legal_name: r.entityname,
    legal_form: r.entitytype || null,
    status: inactive ? 'inactive' : 'active',
    status_label: st || 'Unknown',
    incorporated: isoDate(r.entityformdate),
    registered_address: [r.principaladdress1, r.principaladdress2, r.principalcity, r.principalstate, r.principalzipcode, r.principalcountry].filter(Boolean).join(', ') || null,
    extra: [r.jurisdictonofformation ? ['Formed in', r.jurisdictonofformation] : null, r.agentorganizationname ? ['Registered agent', r.agentorganizationname] : null].filter(Boolean),
    situations,
  });
}

// ---------- Connecticut ----------
const CT = { domain: 'data.ct.gov', set: 'n7gp-d28j' };
function ctRecord(r, asOfIso) {
  const st = String(r.status || '');
  const situations = [];
  const due = isoDate(r.annual_report_due_date);
  if (st === 'Active' && due && asOfIso && due < asOfIso) situations.push({ level: 'check', label: 'Annual report overdue', detail: `Connecticut lists the annual report as due ${due}.` });
  return record({
    register: { name: 'Connecticut Secretary of State', number: r.accountnumber, url: 'https://service.ct.gov/business/s/onlinebusinesssearch' },
    legal_name: r.name,
    legal_form: r.business_type || null,
    status: st && st !== 'Active' ? 'inactive' : 'active',
    status_label: [st, r.sub_status].filter(Boolean).join(' · ') || 'Unknown',
    incorporated: isoDate(r.date_registration),
    registered_address: [r.billingstreet, r.billingcity, r.billingstate, r.billingpostalcode, r.billingcountry].filter(Boolean).join(', ') || null,
    industry: r.naics_code ? [{ code: (String(r.naics_code).match(/\((\d+)\)/) || [])[1] || '', label: String(r.naics_code).replace(/\s*\(\d+\)\s*$/, '') }] : [],
    extra: [r.formation_place ? ['Formed in', r.formation_place] : null, due ? ['Annual report due', due] : null].filter(Boolean),
    situations,
  });
}


// ---------- Texas ----------
// Every taxpayer set up for franchise tax (most corporations, LLCs and partnerships doing business in Texas).
// Individuals, sole proprietorships and estates are excluded for privacy.
const TX = { domain: 'data.texas.gov', set: '9cir-efmm' };
// Codes can carry trailing spaces in this dataset (e.g. "A " in status columns), so match with and without them.
const TX_ENTITY = "taxpayer_organizational_type not in ('IS','S','ES','IS ','S ','ES ','S  ') AND taxpayer_organizational_type not like 'IS %' AND taxpayer_organizational_type not like 'ES %'";
const TX_TYPE = { CT: 'Texas profit corporation', CF: 'Foreign profit corporation', CL: 'Texas limited liability company', CI: 'Foreign limited liability company',
  CN: 'Texas non-profit corporation', CM: 'Foreign non-profit corporation', CP: 'Texas professional corporation', CU: 'Foreign professional corporation',
  CR: 'Texas insurance corporation', CS: 'Foreign insurance corporation', PL: 'Texas limited partnership', PF: 'Foreign limited partnership', PX: 'Texas LLP',
  PY: 'Foreign LLP', P: 'General partnership', L: 'Limited liability company', M: 'Limited liability partnership', C: 'Corporation', AB: 'Texas business association',
  AC: 'Foreign business association', AP: 'Texas professional association', AF: 'Foreign professional association', TR: 'Trust', TF: 'Foreign business trust',
  HF: 'Foreign holding company', J: 'Joint venture', SF: 'Foreign joint stock company', ST: 'Texas joint stock company' };
const TX_SOS = { A: 'Active', R: 'Reinstated', B: 'Consolidated', C: 'Converted', D: 'Dissolved', E: 'Expired', F: 'Forfeited (franchise tax)', G: 'Miscellaneous',
  I: 'Closed by FDIC', J: 'State charter pulled', K: 'Forfeited (registered agent)', L: 'Forfeited (registered office)', M: 'Merged', N: 'Forfeited (hot check)',
  P: 'Forfeited (court order)', T: 'Terminated', W: 'Withdrawn' };
const TX_RTTB = { A: 'Active', D: 'Active, eligible for termination or withdrawal', N: 'Forfeited', I: 'Franchise tax involuntarily ended', U: 'Franchise tax not established', '': 'Franchise tax ended' };
const t = (v) => String(v == null ? '' : v).trim();
function txActive(r) { const sos = t(r.sos_status_code); const rt = t(r.right_to_transact_business_code); return (!sos || sos === 'A' || sos === 'R') && rt !== 'I' && rt !== ''; }
function txRecord(r) {
  const sos = t(r.sos_status_code); const rt = t(r.right_to_transact_business_code);
  const situations = [];
  if (rt === 'N' && (!sos || sos === 'A' || sos === 'R')) situations.push({ level: 'stop', label: 'Right to transact business forfeited', detail: 'The Texas Comptroller has forfeited the right to do business in Texas, usually for unpaid franchise tax or missing reports. Contracts can be hard to enforce.' });
  if (rt === 'D') situations.push({ level: 'check', label: 'Eligible for termination', detail: 'The Texas Comptroller lists the entity as eligible for termination or withdrawal.' });
  if (/^[FKLNP]$/.test(sos)) situations.push({ level: 'stop', label: 'Forfeited in Texas', detail: `Texas Secretary of State status: ${TX_SOS[sos]}.` });
  const date = (s) => isoDate(s);
  return record({
    register: { name: 'Texas Comptroller (franchise tax)', number: r.taxpayer_number, gleif_as: t(r.secretary_of_state_sos_or_coa_file_number) || null, url: 'https://comptroller.texas.gov/taxes/franchise/account-status/search' },
    legal_name: r.taxpayer_name,
    legal_form: TX_TYPE[t(r.taxpayer_organizational_type)] || t(r.taxpayer_organizational_type) || null,
    status: txActive(r) ? 'active' : 'inactive',
    status_label: [sos ? `SOS: ${TX_SOS[sos] || sos}` : null, `Right to transact: ${TX_RTTB[rt] || rt}`].filter(Boolean).join(' · '),
    incorporated: date(r.sos_charter_date) || date(r.responsibility_beginning_date),
    registered_address: [r.taxpayer_address, r.taxpayer_city, r.taxpayer_state, r.taxpayer_zip].map(t).filter(Boolean).join(', ') || null,
    industry: t(r._621111) ? [{ code: t(r._621111), label: 'NAICS' }] : [],
    extra: [t(r.secretary_of_state_sos_or_coa_file_number) ? ['Texas SOS file number', t(r.secretary_of_state_sos_or_coa_file_number)] : null,
      date(r.responsibility_beginning_date) ? ['Franchise tax liable since', date(r.responsibility_beginning_date)] : null].filter(Boolean),
    situations,
  });
}

// ---------- Oregon ----------
// Active businesses only; one row per associated name (registered agent, addresses). Assumed business names
// (trading names, often sole traders) and reserved or registered names are excluded.
const OR = { domain: 'data.oregon.gov', set: 'tckn-sxa6' };
const OR_ENTITY = "entity_type not in ('ASSUMED BUSINESS NAME','RESERVED NAME','REGISTERED NAME')";
const title = (s) => String(s || '').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
const orGleif = (n) => { const d = String(n || '').replace(/\D/g, '').padStart(8, '0'); return d.length === 8 ? `${d.slice(0, 6)}-${d.slice(6)}` : null; };
function orRecord(rows) {
  const r = rows[0];
  const by = (type) => rows.find((x) => x.associated_name_type === type);
  const place = by('PRINCIPAL PLACE OF BUSINESS') || by('MAILING ADDRESS') || {};
  const agent = by('REGISTERED AGENT');
  return record({
    // GLEIF writes Oregon registry numbers zero-padded with a hyphen before the last two digits (8739914 -> 087399-14).
    register: { name: 'Oregon Secretary of State', number: r.registry_number, gleif_as: orGleif(r.registry_number), url: `https://egov.sos.state.or.us/br/pkg_web_name_srch_inq.login` },
    legal_name: r.business_name,
    legal_form: r.entity_type ? title(r.entity_type) : null,
    status: 'active',
    status_label: 'Active (Oregon active businesses list)',
    incorporated: isoDate(r.registry_date),
    registered_address: [place.address, place.city, place.state, place.zip].filter(Boolean).join(', ') || null,
    extra: [r.jurisdiction && r.jurisdiction !== 'OR' ? ['Formed in', r.jurisdiction] : null,
      agent && agent.entity_of_record_name ? ['Registered agent', agent.entity_of_record_name] : null].filter(Boolean),
  });
}

// ---------- Pennsylvania ----------
// Current (active) registrations; one row per officer or party, all carrying the business address.
const PA = { domain: 'data.pa.gov', set: 'xvd7-5r2c' };
function paRecord(rows) {
  const r = rows[0];
  const seen = new Set();
  const officers = rows.filter((x) => x.last_name && x.party_type).map((x) => ({ name: [x.first_name, x.middle_name, x.last_name].filter(Boolean).join(' '), role: x.party_type }))
    .filter((o) => { const k = o.name + '|' + o.role; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 25);
  return record({
    register: { name: 'Pennsylvania Department of State', number: r.filing_number, gleif_as: String(Number(r.filing_number)), url: 'https://file.dos.pa.gov/search/business' },
    legal_name: r.business_name_source_ || r.business_name,
    legal_form: r.typeofbusinessregistration || null,
    status: 'active',
    status_label: 'Active (Pennsylvania current registrations)',
    incorporated: isoDate(r.creationdate),
    registered_address: [r.address_line1, r.address_line2, r.city, r.state, r.zip].filter(Boolean).join(', ') || null,
    officers,
    extra: [r.shortcountyname ? ['County', r.shortcountyname] : null].filter(Boolean),
  });
}

// ---------- adapter ----------
function normalise(n) {
  const m = String(n || '').trim().toLowerCase().match(/^(sec|ny|co|ct|tx|or|pa)-([a-z0-9]+)$/);
  if (!m) return null;
  return m[1] === 'sec' ? `sec-${digits(m[2]).padStart(10, '0')}` : `${m[1]}-${m[2].toUpperCase()}`;
}

async function search(fetchFn, q) {
  const like = soqlLike(q);
  const settle = (p) => p.then((v) => v, () => []);
  const [sec, ny, co, ct, tx, or, pa] = await Promise.all([
    settle(secSearch(fetchFn, q)),
    settle(socrata(fetchFn, NY.domain, NY.set, `upper(current_entity_name) like ${like}`, {}, 'New York DOS')),
    settle(socrata(fetchFn, CO.domain, CO.set, `upper(entityname) like ${like}`, {}, 'Colorado SOS')),
    settle(socrata(fetchFn, CT.domain, CT.set, `upper(name) like ${like}`, {}, 'Connecticut SOS')),
    settle(socrata(fetchFn, TX.domain, TX.set, `${TX_ENTITY} AND ${soqlPrefix('taxpayer_name', q)}`, { limit: 25 }, 'Texas Comptroller')),
    settle(socrata(fetchFn, OR.domain, OR.set, `${OR_ENTITY} AND ${soqlPrefix('business_name', q)}`, { limit: 60, select: 'registry_number,business_name,registry_date' }, 'Oregon SOS')),
    settle(socrata(fetchFn, PA.domain, PA.set, soqlPrefix('business_name', q), { limit: 60, select: 'filing_number,business_name_source_,city,state,creationdate' }, 'Pennsylvania DOS')),
  ]);
  return [
    ...sec,
    ...ny.map((r) => ({ number: `ny-${r.dos_id}`, name: r.current_entity_name, city: r.dos_process_city || null, status: 'active', incorporated: isoDate(r.initial_dos_filing_date), source: 'New York DOS' })),
    ...co.map((r) => ({ number: `co-${r.entityid}`, name: r.entityname, city: [r.principalcity, r.principalstate].filter(Boolean).join(', ') || null, status: /good standing|delinquent/i.test(r.entitystatus || '') ? 'active' : String(r.entitystatus || '').toLowerCase(), incorporated: isoDate(r.entityformdate), source: 'Colorado SOS' })),
    ...ct.map((r) => ({ number: `ct-${r.accountnumber}`, name: r.name, city: r.billingcity || null, status: (r.status || '').toLowerCase(), incorporated: isoDate(r.date_registration), source: 'Connecticut SOS' })),
    ...tx.map((r) => ({ number: `tx-${r.taxpayer_number}`, name: r.taxpayer_name, city: r.taxpayer_city ? `${t(r.taxpayer_city)}, ${t(r.taxpayer_state)}` : null, status: txActive(r) ? 'active' : 'inactive', incorporated: isoDate(r.sos_charter_date), source: 'Texas Comptroller' })),
    ...[...new Map(or.map((r) => [r.registry_number, r])).values()].map((r) => ({ number: `or-${r.registry_number}`, name: r.business_name, city: 'Oregon', status: 'active', incorporated: isoDate(r.registry_date), source: 'Oregon SOS' })),
    ...[...new Map(pa.map((r) => [r.filing_number, r])).values()].map((r) => ({ number: `pa-${r.filing_number}`, name: r.business_name_source_, city: r.city ? `${r.city}, ${r.state || 'PA'}` : null, status: 'active', incorporated: isoDate(r.creationdate), source: 'Pennsylvania DOS' })),
  ];
}

async function get(fetchFn, number, { asOfIso } = {}) {
  const id = normalise(number);
  if (!id) return null;
  const [src, val] = id.split('-');
  if (src === 'sec') return secGet(fetchFn, val, { asOfIso });
  if (src === 'ny') { const r = await socrata(fetchFn, NY.domain, NY.set, `dos_id=${soqlString(val)}`, { limit: 1 }, 'New York DOS'); return r[0] ? nyRecord(r[0]) : null; }
  if (src === 'co') { const r = await socrata(fetchFn, CO.domain, CO.set, `entityid=${soqlString(val)}`, { limit: 1 }, 'Colorado SOS'); return r[0] ? coRecord(r[0]) : null; }
  if (src === 'ct') { const r = await socrata(fetchFn, CT.domain, CT.set, `accountnumber=${soqlString(val)}`, { limit: 1 }, 'Connecticut SOS'); return r[0] ? ctRecord(r[0], asOfIso) : null; }
  if (src === 'tx') { const r = await socrata(fetchFn, TX.domain, TX.set, `${TX_ENTITY} AND taxpayer_number=${soqlString(val)}`, { limit: 1 }, 'Texas Comptroller'); return r[0] ? txRecord(r[0]) : null; }
  if (src === 'or') { const r = await socrata(fetchFn, OR.domain, OR.set, `${OR_ENTITY} AND registry_number=${soqlString(val)}`, { limit: 10 }, 'Oregon SOS'); return r[0] ? orRecord(r) : null; }
  if (src === 'pa') { const r = await socrata(fetchFn, PA.domain, PA.set, `filing_number=${soqlString(val)}`, { limit: 60 }, 'Pennsylvania DOS'); return r[0] ? paRecord(r) : null; }
  return null;
}

module.exports = { TX_ENTITY, country: 'US', name: 'US sources (SEC, NY, CO, CT, TX, OR, PA)', search, get, normalise, STATES };
