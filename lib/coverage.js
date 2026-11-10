// How many companies each source holds. Where a source can report its size, it is asked today; live sources whose APIs
// give no total use the register's own published statistics (marked 'published', with the date). Totals are summed in code.
'use strict';

const { getJson } = require('./http');
const { publicBase } = require('./blob');
const sg = require('./registers/sg');

const ckanTotal = async (f, base, res, filters, path = '/api/3/action/datastore_search') => {
  const q = `${base}${path}?resource_id=${res}&limit=0${filters ? '&filters=' + encodeURIComponent(JSON.stringify(filters)) : ''}`;
  const d = await getJson(f, q, { source: base, timeoutMs: 15000 });
  return d && d.result ? d.result.total : null;
};
const socrataCount = async (f, domain, set, select, where) => {
  const q = `https://${domain}/resource/${set}.json?$select=${encodeURIComponent(select + ' as n')}${where ? '&$where=' + encodeURIComponent(where) : ''}`;
  const d = await getJson(f, q, { source: domain, timeoutMs: 20000 });
  return Array.isArray(d) && d[0] ? Number(d[0].n) : null;
};
const manifestCount = async (f, env, cc) => {
  const base = publicBase(env.BLOB_READ_WRITE_TOKEN || ''); if (!base) return null;
  const m = await getJson(f, `${base}/bulk/${cc}/manifest.json`, { source: 'index', allow404: true });
  return m ? m.count : null;
};

// [country, source name, what is counted, counter]
const SOURCES = [
  ['AR', 'Registro Nacional de Sociedades', 'companies (yearly snapshot)', (f, env) => manifestCount(f, env, 'ar')],
  ['AU', 'ASIC company dataset', 'companies (current names, all statuses)', (f) => ckanTotal(f, 'https://data.gov.au/data', '5c3914e6-413e-4a2c-b890-bf8efe3eabf2', { 'Current Name Indicator': 'Y' })],
  ['BR', 'Receita Federal CNPJ', 'companies (no individual entrepreneurs; shards imported so far)', async (f, env) => {
    const n = await Promise.all([...Array(10).keys()].map((i) => manifestCount(f, env, `br${i}`)));
    return n.some((x) => x != null) ? n.reduce((a, x) => a + (x || 0), 0) : null;
  }],
  ['CA', 'Corporations Canada (federal)', 'corporations, active and dissolved', (f, env) => manifestCount(f, env, 'ca')],
  ['CA', 'Registraire des entreprises (Quebec)', 'enterprises (no sole proprietorships; struck off within 10 years)', (f, env) => manifestCount(f, env, 'qc')],
  ['CL', 'Registro de Empresas y Sociedades', 'companies formed online since 2013', (f, env) => manifestCount(f, env, 'cl')],
  ['CO', 'RUES', 'legal entities, all statuses', (f) => socrataCount(f, 'www.datos.gov.co', 'c82u-588k', 'count(*)', "codigo_categoria_matricula='01'")],
  ['CY', 'Registrar of Companies', 'companies, all statuses', (f, env) => manifestCount(f, env, 'cy')],
  ['IE', 'CRO open data', 'companies', (f) => ckanTotal(f, 'https://opendata.cro.ie', '3fef41bc-b8f4-4b10-8434-ce51c29b1bba')],
  ['IL', 'Companies Registrar', 'companies', (f) => ckanTotal(f, 'https://data.gov.il', 'f004176c-b85f-4542-8901-7b3176f9a054')],
  ['LV', 'Register of Enterprises', 'entities', (f) => ckanTotal(f, 'https://data.gov.lv/dati', '25e80bf3-f107-4ab4-89ef-251b5b9374e9')],
  ['NO', 'Brønnøysund', 'registered entities', async (f) => { const d = await getJson(f, 'https://data.brreg.no/enhetsregisteret/api/enheter?size=1', { source: 'Brønnøysund', timeoutMs: 15000 }); return d && d.page ? d.page.totalElements : null; }],
  ['SG', 'ACRA', 'entities', async (f) => {
    let n = 0;
    for (const id of Object.values(sg.BY_LETTER)) { const t = await ckanTotal(f, 'https://data.gov.sg', id, null, '/api/action/datastore_search'); if (t == null) return null; n += t; }
    return n;
  }],
  ['NC', 'ISEE RIDET', 'active entities (individuals included in the count)', async (f) => { const d = await getJson(f, 'https://data.gouv.nc/api/explore/v2.1/catalog/datasets/entreprises-actives-au-ridet/records?limit=0', { source: 'data.gouv.nc', timeoutMs: 15000 }); return d && Number.isFinite(d.total_count) ? d.total_count : null; }],
  ['DO', 'DGII taxpayer register', 'legal entities (no individuals)', (f, env) => manifestCount(f, env, 'do')],
  ['EC', 'SRI RUC register', 'companies (sociedades), all statuses', (f, env) => manifestCount(f, env, 'ec')],
  ['IN', 'MCA registrations', 'companies and LLPs registered since 2016', (f, env) => manifestCount(f, env, 'in')],
  ['LU', 'RCS annual accounts (STATEC)', 'companies that filed accounts in the last three years', (f, env) => manifestCount(f, env, 'lu')],
  ['MD', 'ASP State Register', 'companies (no sole traders), all statuses', (f, env) => manifestCount(f, env, 'md')],
  ['PE', 'SUNAT RUC register', 'legal entities, all statuses', (f, env) => manifestCount(f, env, 'pe')],
  ['PY', 'DNIT RUC register', 'legal entities (no individuals)', (f, env) => manifestCount(f, env, 'py')],
  ['RO', 'ONRC trade register', 'companies and cooperatives (no natural persons), all statuses', (f, env) => manifestCount(f, env, 'ro')],
  ['RU', 'FNS revenue and expenses', 'organisations that filed accounts (no individuals)', (f, env) => manifestCount(f, env, 'ru')],
  ['SI', 'AJPES business register', 'registered entities (no sole traders)', (f, env) => manifestCount(f, env, 'si')],
  ['UA', 'Unified State Register', 'legal entities (terminated within 10 years kept)', (f, env) => manifestCount(f, env, 'ua')],
  ['US', 'Texas Comptroller', 'franchise tax entities (no individuals)', (f) => socrataCount(f, 'data.texas.gov', '9cir-efmm', 'count(*)', require('./registers/us').TX_ENTITY)],
  ['US', 'Pennsylvania DOS', 'active registrations', (f) => socrataCount(f, 'data.pa.gov', 'xvd7-5r2c', 'count(distinct filing_number)')],
  ['US', 'Oregon SOS', 'active businesses (no trading names)', (f) => socrataCount(f, 'data.oregon.gov', 'tckn-sxa6', 'count(distinct registry_number)', "entity_type not in ('ASSUMED BUSINESS NAME','RESERVED NAME','REGISTERED NAME')")],
  ['US', 'New York DOS', 'active corporations', (f) => socrataCount(f, 'data.ny.gov', 'n9v6-gdp6', 'count(*)')],
  ['US', 'Colorado SOS', 'business entities', (f) => socrataCount(f, 'data.colorado.gov', '4ykn-tg5h', 'count(*)')],
  ['US', 'Connecticut SOS', 'business entities', (f) => socrataCount(f, 'data.ct.gov', 'n7gp-d28j', 'count(*)')],
];
// Live sources whose APIs give no total. Their size comes from the register's own published statistics, so it is an
// estimate (dated, and not always the same definition). Parts are kept as published and added up in code.
// [country, source name, what is counted, parts, as of, where published]
const PUBLISHED = [
  ['FR', 'Recherche d’entreprises (SIRENE)', 'active companies (sociétés) in industry, construction, trade and services; sole traders not counted', [2500000], '2022', 'insee.fr/fr/statistiques/8727786'],
  ['HK', 'Companies Registry', 'local companies on the register', [1609720], '2026-06-30', 'info.gov.hk (Companies Registry, first half 2026)'],
  ['TW', 'GCIS', 'registered companies', [787955], '2024-09-30', 'gcis.nat.gov.tw (company registration statistics)'],
  ['CH', 'Zefix (LINDAS)', 'entities in the commercial register (includes registered sole proprietorships)', [757720], '2025-01-01', 'EHRA activity report 2024'],
  ['FI', 'PRH', 'trade register minus private traders', [728137, -275702], '2026-01-09', 'prh.fi (number of businesses in the trade register)'],
  ['CZ', 'ARES', 'economic subjects minus self-employed individuals (includes associations)', [2893480, -2028363], '2025-12-31', 'csu.gov.cz (statistics from the register of economic subjects)'],
  ['SK', 'RPO', 's.r.o. and a.s. companies in the business register', [365205, 6457], '2025-12-31', 'justice.gov.sk (business register statistics)'],
  ['EE', 'Äriregister', 'companies in the business register', [297421], '2026-06-30', 'e-Business Register via The Baltic Times'],
];
// Used when a live count fails (e.g. a rate limit), so the country is not dropped from the total.
const FALLBACK = {
  ACRA: [['SG', 'ACRA', 'business entities (published total; includes sole proprietorships)', [640842], '2026-10-01', 'acra.gov.sg (business registry statistics)']],
};
// Searchable, but no reliable count or by number only.
const NOT_COUNTED = [
  ['PL', 'KRS, number lookup only'],
  ['US', 'SEC EDGAR (overlaps the state registers)'],
];
const sum = (parts) => parts.reduce((a, x) => a + x, 0);
const pub = ([country, name, what, parts, asOf, where]) => ({ country, name, what, count: sum(parts), basis: 'published', as_of: asOf, published_by: where });

async function coverage(fetchFn, env = process.env) {
  const results = await Promise.all(SOURCES.map(async ([country, name, what, fn]) => {
    try { const count = await fn(fetchFn, env); return { country, name, what, count: Number.isFinite(count) ? count : null }; } catch (e) { return { country, name, what, count: null, error: e.message }; }
  }));
  for (const r of results) {
    if (r.count != null) { r.basis = 'counted'; continue; }
    const fb = FALLBACK[r.name]; if (fb) Object.assign(r, pub(fb[0]), { name: r.name });
  }
  const all = [...results, ...PUBLISHED.map(pub)];
  const withCount = all.filter((r) => r.count != null);
  let gleif = null;
  try { const d = await getJson(fetchFn, 'https://api.gleif.org/api/v1/lei-records?page%5Bsize%5D=1', { source: 'GLEIF', timeoutMs: 15000 }); gleif = d && d.meta && d.meta.pagination ? d.meta.pagination.total : null; } catch (e) { /* leave null */ }
  const counted = withCount.filter((r) => r.basis === 'counted');
  return {
    total: withCount.reduce((a, r) => a + r.count, 0),
    total_counted: counted.reduce((a, r) => a + r.count, 0),
    total_published: withCount.filter((r) => r.basis === 'published').reduce((a, r) => a + r.count, 0),
    countries_counted: new Set(withCount.map((r) => r.country)).size,
    sources: all,
    not_counted: NOT_COUNTED.map(([country, name]) => ({ country, name })),
    gleif_lei_records: gleif,
    note: 'An estimate. "Counted" figures are asked of each source today; "published" figures come from the register\'s own statistics (dated) for live sources whose APIs give no total. GLEIF and Wikidata overlap with the registers, so they are shown separately.',
  };
}

module.exports = { coverage, SOURCES, PUBLISHED };
