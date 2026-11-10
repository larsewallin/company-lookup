// Monthly import of bulk-file registers into the Blob search index (see lib/bulk/README.md).
// Runs from Vercel Cron. Anyone may call it, but it only runs if the index is missing or older
// than 20 days and no other run is in progress, so repeated calls do nothing.
'use strict';
const { userAgent } = require('../lib/ua');

const blob = require('../lib/blob');
const index = require('../lib/bulk/index');
const cy = require('../lib/bulk/cy');
const ca = require('../lib/bulk/ca');
const zip = require('../lib/bulk/zip');
const xlsx = require('../lib/bulk/xlsx');
const qc = require('../lib/bulk/qc');
const ar = require('../lib/bulk/ar');
const si = require('../lib/bulk/si');
const cl = require('../lib/bulk/cl');
const pe = require('../lib/bulk/pe');
const ua = require('../lib/bulk/ua');
const inMca = require('../lib/bulk/in');
const doRnc = require('../lib/bulk/do');
const ec = require('../lib/bulk/ec');
const py = require('../lib/bulk/py');
const brEmp = require('../lib/bulk/br');
const ru = require('../lib/bulk/ru');
const md = require('../lib/bulk/md');
const ro = require('../lib/bulk/ro');
const lu = require('../lib/bulk/lu');

const DAY = 86400000;
const MIN_AGE = 20 * DAY;
const LOCK_AGE = 15 * 60000;
// Bump when the index layout changes: an index built with an older layout may be rebuilt at any time.
const LAYOUT = 3;
// Per-country layout versions: raising one rebuilds only that country's index on its next run.
const COUNTRY_LAYOUT = { LU: 2 }; // 3: Quebec keeps struck-off enterprises (former names). t_layout 2 (split files per word bucket) is read alongside older indexes.

// Turn a fetch() body into text chunks (UTF-8 safe across chunk boundaries).
async function* text(res, encoding = 'utf-8') {
  const dec = new TextDecoder(encoding);
  for await (const chunk of res.body) yield dec.decode(chunk, { stream: true });
  const tail = dec.decode(); if (tail) yield tail;
}
// Network errors from fetch() hide the reason in e.cause (e.g. ECONNRESET, UND_ERR_SOCKET).
const why = (e) => [e.message, e.cause && (e.cause.code || e.cause.message)].filter(Boolean).join(': ');
async function* download(fetchFn, url, encoding = 'utf-8') {
  let res;
  try { res = await fetchFn(url); } catch (e) { throw new Error(`Download of ${url.split('/').pop()} failed (${why(e)})`); }
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}): ${url}`);
  try { yield* text(res, encoding); } catch (e) { throw new Error(`Reading ${url.split('/').pop()} failed (${why(e)})`); }
}

// Fixed source files per country (never user-supplied URLs). Used by the importers and by ?peek=1,
// which returns the first few KB of each file so the layout can be checked before writing a parser.
const FILES = {
  LT: ['https://www.registrucentras.lt/aduomenys/?byla=JAR_IREGISTRUOTI.csv', 'https://www.registrucentras.lt/aduomenys/?byla=JAR_ISREGISTRUOTI.csv'],
  PE: ['https://www2.sunat.gob.pe/padron_reducido_ruc.zip'],
  MX: ['https://www.inegi.org.mx/contenidos/masiva/denue/denue_00_csv.zip'],
  // Layout checks: Dominican Republic (DGII RNC list), Ecuador (SRI RUC catastro, Pichincha), Paraguay (DNIT RUC list page).
  DO: ['https://dgii.gov.do/app/WebApps/Consultas/RNC/DGII_RNC.zip'],
  EC: ['https://www.sri.gob.ec/datasets', 'https://www.sri.gob.ec/o/sri-portlet-biblioteca-alfresco-internet/descargar/909ad236-f46c-488f-8661-f2f4e5faf1c4/SRI_Catastro_Empresas_Fantasmas.csv'],
  PY: ['https://www.dnit.gov.py/web/portal-institucional/listado-de-ruc-con-sus-equivalencias'],
  BR: [`https://arquivos.receitafederal.gov.br/public.php/dav/files/gn672Ad4CF8N6TK/Dados/Cadastros/CNPJ/2026-10/Empresas0.zip`],
  // Bulgaria: Registry Agency open-data pages (layout checks).
  BG: ['https://portal.registryagency.bg/CR/en/opendata', 'https://data.egov.bg/organisation/registry-agency/datasets', 'https://data.egov.bg/data?q=%D1%82%D1%8A%D1%80%D0%B3%D0%BE%D0%B2%D1%81%D0%BA%D0%B8+%D1%80%D0%B5%D0%B3%D0%B8%D1%81%D1%82%D1%8A%D1%80'],
  // Layout checks for the overnight sweep (fixed URLs only).
  XK: ['https://biznesetehapura.com/open-data', 'https://biznesetehapura.com/en/open-data', 'https://arbk.rks-gov.net/'],
  RX: ['https://www.nalog.gov.ru/opendata/7707329152-sshr2019/', 'https://www.nalog.gov.ru/opendata/7707329152-revexp/', 'https://www.nalog.gov.ru/opendata/7707329152-paytax/', 'https://www.nalog.gov.ru/opendata/7707329152-snr/'],
  BY: ['https://egr.gov.by/api/v2/egr/getBaseInfoByRegNum/100582333', 'https://egr.gov.by/api/v2/egr/getJurNamesByRegNum/100582333'],
  GE: ['https://data.gov.ge/?q=%E1%83%A1%E1%83%90%E1%83%9B%E1%83%94%E1%83%AC%E1%83%90%E1%83%A0%E1%83%9B%E1%83%94', 'https://napr.gov.ge/'],
  IM: ['https://services.gov.im/ded/services/companiesregistry/', 'https://www.gov.im/categories/business-and-industries/companies-registry/'],
  JE: ['https://www.jerseyfsc.org/registry/', 'https://opendata.gov.je/'],
  GG: ['https://www.guernseyregistry.com/'],
  MT: ['https://mbr.mt/', 'https://open.data.gov.mt/'],
  LI: ['https://www.oera.li/', 'https://opendata.li/'],
  AM: ['https://www.e-register.am/en/', 'https://data.gov.am/'],
  MDX: ['https://www.asp.gov.md/sites/default/files/date-deschise/date-statistice/2026/rsud/company.xlsx'],
  KZ: ['https://data.egov.kz/datasets/view?index=gbd_ul', 'https://data.egov.kz/api/v4/gbd_ul/v1?source=%7B%22size%22%3A2%7D'],
  // US states (layout checks): Alaska, North Carolina, Iowa.
  USAK: ['https://www.commerce.alaska.gov/web/cbpl/Corporations.aspx', 'https://www.commerce.alaska.gov/web/cbpl/Corporations/SearchCorporations'],
  USNC: ['https://www.sosnc.gov/online_services/data_subscriptions/about_the_data', 'https://www.sosnc.gov/online_services/data_subscriptions'],
  USIA: ['https://data.iowa.gov/api/views/ez5t-3qay/rows.csv?accessType=DOWNLOAD'],
  // Middle East and Asia probes (portal search APIs; fixed URLs).
  QA: ['https://www.data.gov.qa/api/explore/v2.1/catalog/datasets?where=search(%22commercial%22)&limit=10'],
  BH: ['https://www.data.gov.bh/api/explore/v2.1/catalog/datasets?where=search(%22commercial%22)&limit=10'],
  SA: ['https://open.data.gov.sa/en/datasets?search=commercial%20registration', 'https://open.data.gov.sa/data/api/datasets?search=commercial%20registration'],
  OM: ['https://data.gov.om/api/explore/v2.1/catalog/datasets?where=search(%22companies%22)&limit=10'],
  UZ: ['https://data.egov.uz/apiClient/main/gettable?id=607feffa7b6428eee08802b7', 'https://data.egov.uz/eng/spheres/607feffa7b6428eee08802b7?orgId=84'],
  MO: ['https://data.gov.mo/api/v1/search?keyword=company'],
  MN: ['https://opendata.burtgel.gov.mn/', 'https://opendata.gov.mn/'],
  RW: ['https://org.rdb.rw/', 'https://statistics.gov.rw/'],
  EG: ['https://www.gafi.gov.eg/'],
  PR: ['https://api.us.socrata.com/api/catalog/v1?domains=data.pr.gov&q=corporaciones&limit=5', 'https://api.us.socrata.com/api/catalog/v1?q=registered%20corporations%20puerto%20rico&limit=5'],
  LUX: ['https://download.data.public.lu/resources/hvd-annex-5-companies-and-company-ownership-annual-deposits-2024/20261025-042525/hvd.annualdeposits2024.json'],
  ROC: ['https://data.gov.ro/dataset/a03a00da-2fed-4607-97f1-5147c3ff32a6/resource/1ac3a154-d9f5-46bd-a007-de95453c6a26/download/n_stare_firma.csv'],
  ROF: ['https://data.gov.ro/dataset/223b1037-008c-4996-bf5f-455879e889ab/resource/5d13a0f8-b3ef-4426-a927-7c05a9f20eae/download/od_firme.csv'],
  NC: ['https://data.gouv.nc/api/explore/v2.1/catalog/datasets?where=search(%22ridet%22)&limit=5', 'https://data.gouv.nc/api/explore/v2.1/catalog/datasets/entreprises-actives-au-ridet/records?limit=2'],
  PF: ['https://data.ispf.pf/', 'https://www.data.gouv.fr/api/1/datasets/?q=polynesie+entreprises+tahiti&page_size=5'],
  // Hong Kong Companies Registry open-data API (data.cr.gov.hk): layout checks only.
  HK: [
    'https://data.cr.gov.hk/cr/api/api/v1/api_builder/json/local/search?query[0][key1]=Brn&query[0][key2]=equal&query[0][key3]=C1572528',
    'https://data.cr.gov.hk/cr/api/api/v1/api_builder/json/local/search?query[0][key1]=Comp_name&query[0][key2]=begins_with&query[0][key3]=HSBC',
    'https://data.cr.gov.hk/cr/api/api/v1/api_builder/json/foreign/search?query[0][key1]=Comp_name&query[0][key2]=begins_with&query[0][key3]=APPLE',
    'https://data.cr.gov.hk/cr/api/api/v1/api_builder/json/local/search',
  ],
  CA: [
    'https://d4bf66bykfyaf.cloudfront.net/corporations-active-cbca-en.csv',
    'https://d4bf66bykfyaf.cloudfront.net/corporations-active-non-cbca-en.csv',
    'https://d4bf66bykfyaf.cloudfront.net/corporations-inactive-or-dissolved-cbca-en.csv',
    'https://d4bf66bykfyaf.cloudfront.net/corporations-inactive-or-dissolved-non-cbca-en.csv',
  ],
};

// Open-data portals (CKAN) whose current files are looked up by dataset name.
const CKAN = {
  SI: { base: 'https://podatki.gov.si', pkg: 'poslovni-register-slovenije' },
  QC: { base: 'https://www.donneesquebec.ca/recherche', pkg: 'registre-des-entreprises' },
  CL: { base: 'https://datos.gob.cl', pkg: 'registro-de-empresas-y-sociedades' },
  AR: { base: 'https://datos.jus.gob.ar', pkg: 'registro-nacional-de-sociedades' },
  UA: { base: 'https://data.gov.ua', pkg: '03cc1239-3988-4451-aa0d-aadb77448714' },
  IN: { base: 'https://ckandev.indiadataportal.com', pkg: 'company-registrations' },
  MD: { base: 'https://dataset.live.egov.md', pkg: '11736-date-din-registrul-de-stat-al-unitatilor-de-drept-privind-intreprinderile-inregistrate-in-repu' },
};
// Portals searched (fixed bases and queries) to find a country's company dataset.
const SEARCH = {
  RO: { base: 'https://data.gov.ro', q: 'firme onrc' },
  AR: { base: 'https://datos.jus.gob.ar', q: 'sociedades' },
  MD: { base: 'https://dataset.gov.md', q: 'persoanelor juridice' },
  LT: { base: 'https://data.gov.lt', q: 'juridiniai asmenys' },
  UA: { base: 'https://data.gov.ua', q: 'Єдиний державний реєстр юридичних осіб' },
  BE: { base: 'https://data.gov.be', q: 'KBO BCE enterprises' },
  USCAT: { base: 'https://catalog.data.gov', q: 'business entities secretary of state corporations' },
  BD: { base: 'http://data.gov.bd', q: 'company registered RJSC' },
  LK: { base: 'https://data.gov.lk', q: 'companies registered' },
  NP: { base: 'https://opendatanepal.com', q: 'company registration' },
  MU: { base: 'https://data.govmu.org', q: 'companies' },
  GH: { base: 'https://data.gov.gh', q: 'companies registered' },
  MA: { base: 'https://data.gov.ma/data', q: 'entreprises registre commerce' },
  TN: { base: 'https://catalog.data.gov.tn', q: 'registre entreprises' },
  KE: { base: 'https://www.opendata.go.ke', q: 'companies' },
  ZA: { base: 'https://data.gov.za', q: 'companies CIPC' },
  NG: { base: 'https://data.gov.ng', q: 'companies' },
  PT: { base: 'https://dados.gov.pt', q: 'empresas registo comercial' },
  HU: { base: 'https://adatkatalogus.hu', q: 'cégjegyzék' },
  RO2: { base: 'https://data.gov.ro', q: 'onrc firme' },
  IT: { base: 'https://www.dati.gov.it/opendata', q: 'registro imprese elenco imprese' },
  ES: { base: 'https://datos.gob.es/apidata', q: 'sociedades mercantiles' },
  USCAT2: { base: 'https://catalog.data.gov', q: 'registered business entities active corporations llc' },
  TH: { base: 'https://opendata.dbd.go.th', q: 'นิติบุคคล' },
  PA: { base: 'https://www.datosabiertos.gob.pa', q: 'sociedades registro publico' },
};
async function ckanSearch(fetchFn, cc) {
  const c = SEARCH[cc];
  const r = await fetchFn(`${c.base}/api/3/action/package_search?rows=8&q=${encodeURIComponent(c.q)}`, { headers: { 'User-Agent': userAgent() } });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch (e) { return { status: r.status, body: text.slice(0, 300) }; }
  return ((j.result && j.result.results) || []).map((p) => ({ name: p.name, title: p.title, org: p.organization && p.organization.title, modified: p.metadata_modified,
    resources: (p.resources || []).slice(0, 8).map((x) => ({ name: x.name, format: x.format, url: x.url, datastore: x.datastore_active || false })) }));
}
async function ckanResources(fetchFn, cc) {
  const c = CKAN[cc];
  const r = await fetchFn(`${c.base}/api/3/action/package_show?id=${c.pkg}`, { headers: { 'User-Agent': userAgent() } });
  const body = await r.text();
  let j; try { j = JSON.parse(body); } catch (e) { throw new Error(`${c.base} did not return JSON (HTTP ${r.status}): ${body.slice(0, 120)}`); }
  return ((j.result && j.result.resources) || []).map((x) => ({ name: x.name, format: x.format, url: x.url, size: x.size || null, modified: x.last_modified || x.metadata_modified || null }));
}

async function peekSafe(...args) { try { return await peek(...args); } catch (e) { return { error: why(e) }; } }

async function peek(fetchFn, cc, opts = {}) {
  const maxBytes = Math.min(Number(opts.bytes) || 3000, 20000);
  if (SEARCH[cc] && !CKAN[cc] && !FILES[cc]) { try { return await ckanSearch(fetchFn, cc); } catch (e) { return { error: why(e) }; } }
  if (CKAN[cc]) {
    const res = (await ckanResources(fetchFn, cc)).slice(0, Number(opts.max) || 4);
    const out = [];
    for (const r of res) {
      const item = { ...r };
      try {
        if (/zip|xlsx/i.test(r.format) || /\.(zip|xlsx)($|\?)/i.test(r.url)) {
          const list = await zip.entries(fetchFn, r.url);
          item.entries = list.slice(0, 20).map((e) => ({ name: e.name, size: e.size }));
          const want = opts.entry ? list.find((e) => e.name === opts.entry) : null;
          const first = want || list.find((e) => /\.(csv|txt|tsv)$/i.test(e.name)) || list.find((e) => /\.xml$/i.test(e.name));
          if (first && opts.skip && first.size < 2e6) {
            // Small files only: drop lines starting with the given prefix (e.g. a long code list section).
            let all = ''; for await (const t of zip.text(fetchFn, r.url, first)) all += t;
            item.entry = first.name; item.head = all.split(/\r?\n/).filter((l) => !l.startsWith(opts.skip)).join('\n').slice(0, maxBytes);
          } else if (first) { let head = ''; for await (const t of zip.text(fetchFn, r.url, first)) { head += t; if (head.length > maxBytes) break; } item.entry = first.name; item.head = head.slice(0, maxBytes); }
        } else if (/csv|txt/i.test(r.format)) {
          const g = await fetchFn(r.url, { headers: { Range: 'bytes=0-2999' } });
          item.status = g.status; item.head = Buffer.from(await g.arrayBuffer()).subarray(0, 3000).toString('utf8');
        }
      } catch (e) { item.error = why(e); }
      out.push(item);
    }
    return out;
  }
  const out = [];
  for (const url of FILES[cc] || []) {
    if (/\.xlsx$/i.test(url)) {
      // Spreadsheets: sheet list and the first rows of the first sheet.
      try {
        const list = await zip.entries(fetchFn, url);
        const read = (name) => { const e = list.find((x) => x.name === name); if (!e) throw new Error(`${name} missing`); return zip.text(fetchFn, url, e); };
        const sheets = list.filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name)).map((e) => ({ name: e.name, size: e.size }));
        const first = []; for await (const r of xlsx.rows(read, sheets[0] ? sheets[0].name : undefined)) { first.push(r); if (first.length >= (Number(opts.max) || 6)) break; }
        out.push({ file: url, sheets, rows: first });
      } catch (e) { out.push({ file: url, error: why(e) }); }
      continue;
    }
    if (/\.zip$/i.test(url)) {
      if (opts.scan && cc === 'BR') {
        // Measure a Brazil Empresas file: lines, companies kept, bytes and speed, for up to 600 s.
        const t0 = Date.now(); let lines = 0; let kept = 0; let chars = 0; let done = true;
        try {
          const list = await zip.entries(fetchFn, url);
          for await (const c of zip.text(fetchFn, url, list[0], 'latin1')) {
            chars += c.length;
            for (let i = c.indexOf('\n'); i >= 0; i = c.indexOf('\n', i + 1)) lines++;
            if (Date.now() - t0 > 600000) { done = false; break; }
          }
          kept = null;
          const r = { file: url, entry: list[0].name, size: list[0].size, compressed: list[0].compressedSize, chars, lines, done, seconds: Math.round((Date.now() - t0) / 1000) };
          console.log('brazil-scan', JSON.stringify(r)); out.push(r);
        } catch (e) { out.push({ file: url, error: why(e), chars, lines, seconds: Math.round((Date.now() - t0) / 1000) }); }
        continue;
      }
      if (opts.whole) {
        try { const buf = await zip.fetchWhole(fetchFn, url, 60e6); const list = zip.entriesFromBuffer(buf); let head = ''; if (list[0]) { for await (const t of zip.textFromBuffer(buf, list[0], opts.enc || 'latin1')) { head += t; if (head.length > 3000) break; } } out.push({ file: url, bytes: buf.length, entries: list.slice(0, 5).map((x) => ({ name: x.name, size: x.size })), head: head.slice(0, 3000) }); } catch (e) { out.push({ file: url, error: why(e) }); }
        continue;
      }
      try { const list = await zip.entries(fetchFn, url); const e = list[0]; let head = ''; if (e) { for await (const t of zip.text(fetchFn, url, e, opts.enc || 'latin1')) { head += t; if (head.length > 3000) break; } } out.push({ file: url, entries: list.slice(0, 5).map((x) => ({ name: x.name, size: x.size })), head: head.slice(0, 3000) }); } catch (e) { out.push({ file: url, error: why(e) }); }
      continue;
    }
    try {
      if (opts.links) {
        // HTML pages: list the data-file links they contain instead of the first bytes.
        const r = await fetchFn(url, { headers: { 'User-Agent': userAgent() } });
        const html = (await r.text()).slice(0, 3e6);
        const links = [...new Set((html.match(/(?:https?:)?[^"'\s<>]+\.(?:zip|csv|xlsx|txt|json|xml)(?:\?[^"'\s<>]*)?/gi) || []))].slice(0, 200);
        out.push({ file: url, status: r.status, links });
        continue;
      }
      if (opts.scan && !/\.zip$/i.test(url)) {
        // Measure a plain file: bytes and lines read and seconds taken, for up to 600 s (logged, since the
        // caller may time out first).
        const t0 = Date.now(); let bytes = 0; let lines = 0; let done = true; const ac = new AbortController();
        try {
          const r = await fetchFn(url, { signal: ac.signal });
          for await (const c of r.body) { bytes += c.length; for (let i = c.indexOf(10); i >= 0; i = c.indexOf(10, i + 1)) lines++; if (Date.now() - t0 > 600000) { done = false; break; } }
        } catch (e) { out.push({ file: url, error: why(e), bytes, lines }); continue; } finally { ac.abort(); }
        const res = { file: url.split('/').pop(), bytes, lines, done, seconds: Math.round((Date.now() - t0) / 1000) };
        console.log('scan', JSON.stringify(res)); out.push(res);
        continue;
      }
      // Read only the first few KB, even when the server ignores the Range header and sends the whole file.
      const ac = new AbortController();
      const r = await fetchFn(url, { headers: { Range: 'bytes=0-3999' }, signal: ac.signal });
      const parts = []; let got = 0;
      const want = Math.max(4000, maxBytes);
      try { for await (const c of r.body) { parts.push(Buffer.from(c)); got += c.length; if (got >= want) break; } } finally { ac.abort(); }
      const b = Buffer.concat(parts).subarray(0, want);
      out.push({ file: url.split('/').pop(), status: r.status, size: r.headers.get('content-range') || r.headers.get('content-length'), head: b.toString('utf8') });
    } catch (e) { out.push({ file: url.split('/').pop(), error: why(e) }); }
  }
  return out;
}

// Brazil: the newest monthly folder (YYYY-MM) that has the file, this month or up to two months back.
const BR_DAV = 'https://arquivos.receitafederal.gov.br/public.php/dav/files/gn672Ad4CF8N6TK/Dados/Cadastros/CNPJ';
async function brazilFile(fetchFn, asOfIso, name) {
  const [y, m] = asOfIso.split('-').map(Number);
  for (let back = 0; back < 3; back++) {
    const d = new Date(Date.UTC(y, m - 1 - back, 1));
    const url = `${BR_DAV}/${d.toISOString().slice(0, 7)}/${name}`;
    const r = await fetchFn(url, { headers: { Range: 'bytes=0-0' } }).catch(() => null);
    if (r && (r.status === 206 || r.status === 200)) { try { if (r.body && r.body.cancel) await r.body.cancel(); } catch (e) { /* ignore */ } return url; }
  }
  throw new Error(`${name} not found in the last three monthly folders of the Receita Federal share`);
}

const IMPORTERS = {
  // Cyprus: file names change every month (organisations_103.csv ...), so find them on the dataset page.
  CY: async (fetchFn) => {
    // The page may give relative links (/sites/default/files/...); the DCAT feed is the fallback.
    const pages = ['https://www.data.gov.cy/en/dataset/1026', 'https://www.data.gov.cy/en/dataset/1026/dcat-ap-2.0/json'];
    const tried = [];
    let urls = null;
    for (const p of pages) {
      const r = await fetchFn(p, { headers: { 'User-Agent': userAgent() } });
      const page = r.ok ? await r.text() : '';
      tried.push(`${p.split('/').slice(-2).join('/')}: HTTP ${r.status}, ${page.length} chars`);
      const find = (stem) => { const m = page.replace(/\\\//g, '/').match(new RegExp(`(?:https://www\\.data\\.gov\\.cy)?/sites/default/files/${stem}_\\d+\\.csv`)); return m && (m[0].startsWith('http') ? m[0] : 'https://www.data.gov.cy' + m[0]); };
      const u = { organisations: find('organisations'), offices: find('registered_office'), officials: find('organisation_officials') };
      if (u.organisations && u.offices) { urls = u; break; }
    }
    if (!urls) throw new Error(`Could not find the Cyprus files on data.gov.cy (${tried.join('; ')})`);
    const records = await cy.build({
      organisations: download(fetchFn, urls.organisations),
      offices: download(fetchFn, urls.offices),
      officials: urls.officials ? download(fetchFn, urls.officials) : null,
    });
    const builder = index.createBuilder();
    records.forEach((r) => builder.add(r));
    return { builder, source: urls };
  },
  // Quebec: Registraire des entreprises monthly ZIP (donneesquebec.ca), read entry by entry over HTTP ranges.
  QC: async (fetchFn, { asOfIso }) => {
    const res = (await ckanResources(fetchFn, 'QC')).find((r) => /zip/i.test(r.format));
    if (!res) throw new Error('Quebec ZIP not found on donneesquebec.ca');
    const list = await zip.entries(fetchFn, res.url);
    const read = (name) => { const e = list.find((x) => x.name === name); if (!e) throw new Error(`${name} missing from the Quebec ZIP`); return zip.text(fetchFn, res.url, e); };
    const builder = index.createBuilder({ sBuckets: 1024 });
    const stats = {};
    await qc.build(read, (r) => builder.add(r), asOfIso, stats);
    if (!builder.count) throw new Error(`No Quebec records kept: ${JSON.stringify(stats)}`);
    return { builder, source: { url: res.url, modified: res.modified, stats } };
  },
  // Slovenia: AJPES business register, ZIP on podatki.gov.si with a UTF-16 CSV inside.
  SI: async (fetchFn) => {
    const res = (await ckanResources(fetchFn, 'SI')).find((r) => /zip/i.test(r.format));
    if (!res) throw new Error('Slovenia ZIP not found on podatki.gov.si');
    const list = await zip.entries(fetchFn, res.url);
    const csv = list.find((e) => /\.csv$/i.test(e.name));
    if (!csv) throw new Error('No CSV inside the Slovenia ZIP');
    const builder = index.createBuilder();
    await si.addFile(zip.text(fetchFn, res.url, csv, 'utf-16le'), (r) => builder.add(r));
    return { builder, source: { url: res.url, file: csv.name } };
  },
  // Chile: Registro de Empresas y Sociedades, one CSV per year on datos.gob.cl, read in order.
  CL: async (fetchFn) => {
    const files = (await ckanResources(fetchFn, 'CL')).filter((r) => /csv/i.test(r.format) && /\d{4}/.test(r.name));
    files.sort((a, b) => a.name.localeCompare(b.name));
    if (!files.length) throw new Error('Chile CSVs not found on datos.gob.cl');
    const col = cl.createCollector();
    for (const f of files) await col.addFile(download(fetchFn, f.url));
    const builder = index.createBuilder();
    for (const r of col.records()) builder.add(r);
    return { builder, source: { files: files.map((f) => f.name) } };
  },
  // Peru: SUNAT padrón reducido del RUC (ZIP with one 1.6 GB Latin-1 text file), companies only.
  PE: async (fetchFn) => {
    const url = FILES.PE[0];
    const list = await zip.entries(fetchFn, url);
    const txt = list.find((e) => /\.txt$/i.test(e.name));
    if (!txt) throw new Error('No text file inside the SUNAT ZIP');
    // Too many companies for one pass in memory: read the file twice (word index, then records).
    return { feed: (add) => pe.addFile(zip.text(fetchFn, url, txt, 'latin1'), add), sBuckets: 1024, source: { url, file: txt.name },
      passes: [{ only: 's', sRange: [0, 512] }, { only: 's', sRange: [512, 1024] }, { only: 'd', dRange: [0, 500] }, { only: 'd', dRange: [500, 1000] }] };
  },
  // Ukraine: Unified State Register, UO.zip (legal entities only; FOP.zip, individual entrepreneurs, is not used).
  UA: async (fetchFn, { asOfIso }) => {
    const res = (await ckanResources(fetchFn, 'UA')).find((r) => /^uo\.zip$/i.test(String(r.name).trim()));
    if (!res) throw new Error('UO.zip not found on data.gov.ua');
    const list = await zip.entries(fetchFn, res.url);
    const xml = list.find((e) => /\.xml$/i.test(e.name));
    if (!xml) throw new Error('No XML inside UO.zip');
    return { feed: (add) => ua.addFile(zip.text(fetchFn, res.url, xml, 'windows-1251'), add, asOfIso), sBuckets: 1024,
      source: { url: res.url, file: xml.name, modified: res.modified }, passes: [{ only: 's' }, { only: 'd' }] };
  },
  // India: MCA company, LLP and foreign-company registrations on the India Data Portal. The "New" files (from late
  // 2023) are read first; the older files then stop at the date the new ones begin, so nobody is counted twice.
  IN: async (fetchFn) => {
    const res = await ckanResources(fetchFn, 'IN');
    const find = (name) => res.find((r) => r.name.trim().toLowerCase() === name.toLowerCase());
    const pairs = [['company', 'Indian Company Registrations New', 'Indian Company Registrations'],
      ['llp', 'Limited Liability Partnership(LLPs) Company Registrations New', 'Limited Liability Partnership(LLPs) Company Registrations'],
      ['foreign', 'Foreign Company Registrations New', 'Foreign Company Registrations']].map(([kind, nw, old]) => ({ kind, nw: find(nw), old: find(old) }));
    const missing = pairs.filter((p) => !p.nw && !p.old).map((p) => p.kind);
    if (missing.length) throw new Error(`India files not found on the India Data Portal: ${missing.join(', ')}`);
    const feed = async (add) => {
      for (const p of pairs) {
        let until = null;
        if (p.nw) until = (await inMca.addFile(download(fetchFn, p.nw.url), p.kind, add)).first;
        if (p.old) await inMca.addFile(download(fetchFn, p.old.url), p.kind, add, { until });
      }
    };
    return { feed, sBuckets: 1024, passes: [{ only: 's' }, { only: 'd' }],
      source: { files: pairs.flatMap((p) => [p.nw, p.old].filter(Boolean).map((r) => ({ name: r.name, url: r.url, modified: r.modified }))) } };
  },
  // Dominican Republic: DGII RNC list (one Latin-1 text file in a ZIP; legal entities only).
  DO: async (fetchFn) => {
    const url = FILES.DO[0];
    const list = await zip.entries(fetchFn, url);
    const txt = list.find((e) => /\.txt$/i.test(e.name));
    if (!txt) throw new Error('No text file inside DGII_RNC.zip');
    const builder = index.createBuilder();
    await doRnc.addFile(zip.text(fetchFn, url, txt, 'latin1'), (r) => builder.add(r));
    return { builder, source: { url, file: txt.name } };
  },
  // Ecuador: SRI catastro del RUC, one ZIP per province (links found on sri.gob.ec/datasets), companies only,
  // plus the SRI list of shell companies. One record per RUC (head office), across all provinces.
  EC: async (fetchFn) => {
    const r = await fetchFn(FILES.EC[0], { headers: { 'User-Agent': userAgent() } });
    const html = await r.text();
    const zips = [...new Set(html.match(/https:\/\/descargas\.sri\.gob\.ec\/download\/datosAbiertos\/SRI_RUC_[^"'\s<>]+\.zip/g) || [])];
    if (zips.length < 20) throw new Error(`Only ${zips.length} Ecuador province files found on sri.gob.ec/datasets (HTTP ${r.status})`);
    const shellUrl = (html.match(/https:\/\/www\.sri\.gob\.ec\/[^"'\s<>]+Empresas_Fantasmas\.csv/i) || [])[0] || null;
    // Under 1M companies, so one pass (word index and records together) fits in memory.
    const builder = index.createBuilder({ sBuckets: 1024 });
    const add = (x) => builder.add(x);
    {
      const state = ec.newState(shellUrl ? await ec.shells(download(fetchFn, shellUrl, 'latin1')) : new Map());
      for (const url of zips) {
        const u = encodeURI(decodeURI(url));
        const list = await zip.entries(fetchFn, u);
        const csv = list.find((e) => /\.csv$/i.test(e.name));
        if (!csv) throw new Error(`No CSV inside ${url.split('/').pop()}`);
        await ec.addFile(zip.text(fetchFn, u, csv), add, state);
      }
      ec.finish(state, add);
    }
    return { builder, source: { files: zips.length, shells: shellUrl } };
  },
  // Paraguay: DNIT RUC list, ten small ZIPs linked from one page; the server has no Range support, so each is read whole.
  PY: async (fetchFn) => {
    const r = await fetchFn(FILES.PY[0], { headers: { 'User-Agent': userAgent() } });
    const html = await r.text();
    const paths = [...new Set(html.match(/\/documents\/[^"'\s<>]+\/ruc\d\.zip/g) || [])];
    if (paths.length < 10) throw new Error(`Only ${paths.length} Paraguay RUC files found on dnit.gov.py (HTTP ${r.status})`);
    const builder = index.createBuilder();
    for (const p of paths) {
      const buf = await zip.fetchWhole(fetchFn, `https://www.dnit.gov.py${p}`, 60e6);
      const e = zip.entriesFromBuffer(buf).find((x) => /\.txt$/i.test(x.name));
      if (!e) throw new Error(`No text file inside ${p.split('/').pop()}`);
      await py.addFile(zip.textFromBuffer(buf, e), (x) => builder.add(x));
    }
    return { builder, source: { files: paths } };
  },
  // Brazil: Receita Federal CNPJ "Empresas" files, one index shard per file (BR0 ... BR9), from the newest monthly
  // folder on the public WebDAV share. Names only; the card comes from the live CNPJ lookup.
  ...Object.fromEntries([...Array(10).keys()].map((i) => [`BR${i}`, async (fetchFn, { asOfIso }) => {
    const url = await brazilFile(fetchFn, asOfIso, `Empresas${i}.zip`);
    const list = await zip.entries(fetchFn, url);
    const e = list[0]; if (!e) throw new Error(`Empresas${i}.zip is empty`);
    return { feed: (add) => brEmp.addFile(zip.text(fetchFn, url, e, 'latin1'), add), sBuckets: 1024,
      passes: [{ only: 's', sRange: [0, 512] }, { only: 's', sRange: [512, 1024] }], source: { url, file: e.name } };
  }])),
  // Russia: FNS open data on organisations' revenue and expenses (latest ZIP linked from the dataset page), read in one
  // sequential download because it holds thousands of small XML files.
  RU: async (fetchFn) => {
    const page = 'https://www.nalog.gov.ru/opendata/7707329152-revexp/';
    const r = await fetchFn(page, { headers: { 'User-Agent': userAgent() } });
    const html = await r.text();
    const url = (html.match(/https:\/\/file\.nalog\.ru\/opendata\/7707329152-revexp\/data-\d{8}-structure-\d{8}\.zip/) || [])[0];
    if (!url) throw new Error(`No data file linked from the FNS revexp page (HTTP ${r.status})`);
    const list = await zip.entries(fetchFn, url);
    const feed = (add) => zip.eachEntry(fetchFn, url, list, (e, xml) => { for (const x of ru.documents(xml)) add(x); });
    return { feed, sBuckets: 1024, passes: [{ only: 's' }, { only: 'd' }], source: { url, files: list.length } };
  },
  // Moldova: ASP State Register of legal units, company.xlsx linked from the open-data page (the year in the path changes).
  MD: async (fetchFn) => {
    const page = 'https://www.asp.gov.md/ro/date-deschise/date-statistice/company';
    const r = await fetchFn(page, { headers: { 'User-Agent': userAgent() } });
    const html = await r.text();
    const url = (html.match(/https:\/\/www\.asp\.gov\.md\/sites\/default\/files\/[^"'\s<>]*company\.xlsx/) || [])[0];
    if (!url) throw new Error(`company.xlsx not linked from the ASP open-data page (HTTP ${r.status})`);
    const list = await zip.entries(fetchFn, url);
    const read = (name) => { const e = list.find((x) => x.name === name); if (!e) throw new Error(`${name} missing from company.xlsx`); return zip.text(fetchFn, url, e); };
    const builder = index.createBuilder();
    await md.addRows(xlsx.rows(read, 'xl/worksheets/sheet1.xml'), (x) => builder.add(x));
    return { builder, source: { url } };
  },
  // Romania: ONRC firms on data.gov.ro, the newest "Firme înregistrate la Registrul Comerțului" package (CKAN). Only
  // reachable from Europe, so this runs through /api/bulk-import-eu (fra1). Status codes are loaded once and joined.
  RO: async (fetchFn) => {
    const base = 'https://data.gov.ro';
    const UA = { 'User-Agent': userAgent() };
    const r = await fetchFn(`${base}/api/3/action/package_search?rows=20&sort=metadata_modified%20desc&q=${encodeURIComponent('Firme înregistrate la Registrul Comerțului')}`, { headers: UA });
    const j = await r.json();
    const pkgs = ((j.result && j.result.results) || []).filter((p) => /^Firme înregistrate la Registrul Comer/i.test(p.title || ''));
    const res = (p, re) => (p.resources || []).find((x) => re.test(String(x.name || '') + ' ' + String(x.url || '')));
    const pkg = pkgs.find((p) => res(p, /od_firme\.csv/i) && res(p, /od_stare_firma\.csv/i));
    if (!pkg) throw new Error(`No ONRC package with OD_FIRME and OD_STARE_FIRMA found (HTTP ${r.status})`);
    const nom = pkgs.map((p) => res(p, /n_stare_firma\.csv/i)).find(Boolean);
    const nomUrl = nom ? nom.url : 'https://data.gov.ro/dataset/a03a00da-2fed-4607-97f1-5147c3ff32a6/resource/1ac3a154-d9f5-46bd-a007-de95453c6a26/download/n_stare_firma.csv';
    const firmsUrl = res(pkg, /od_firme\.csv/i).url; const stareUrl = res(pkg, /od_stare_firma\.csv/i).url;
    let joined = null;
    const feed = async (add) => {
      if (!joined) { const codeMap = await ro.codes(download(fetchFn, nomUrl)); joined = { codeMap, statusOf: await ro.statuses(download(fetchFn, stareUrl), codeMap) }; }
      await ro.addFirms(download(fetchFn, firmsUrl), add, joined.statusOf, joined.codeMap);
    };
    return { feed, sBuckets: 1024, passes: [{ only: 's', sRange: [0, 512] }, { only: 's', sRange: [512, 1024] }, { only: 'd', dRange: [0, 500] }, { only: 'd', dRange: [500, 1000] }], source: { package: pkg.title, modified: pkg.metadata_modified, firms: firmsUrl } };
  },
  // Luxembourg: STATEC annual-accounts deposits (the last three years' files on data.public.lu), latest
  // financial year per RCS number.
  LU: async (fetchFn, { asOfIso }) => {
    const y = Number(asOfIso.slice(0, 4));
    const UA = { 'User-Agent': userAgent() };
    const files = [];
    for (const year of [y - 2, y - 1, y]) {
      const r = await fetchFn(`https://data.public.lu/api/1/datasets/hvd-annex-5-companies-and-company-ownership-annual-deposits-${year}/`, { headers: UA });
      if (!r.ok) continue;
      const j = await r.json();
      const res = (j.resources || []).find((x) => new RegExp(`annualdeposits${year}\\.json$`, 'i').test(x.url || x.title || ''));
      if (res) files.push({ year, url: res.url });
    }
    if (!files.length) throw new Error('No Luxembourg annual-deposit files found on data.public.lu');
    const best = new Map();
    for (const f of files) await lu.eachDeposit(download(fetchFn, f.url), (d) => { if (lu.better(best.get(d.number), d)) best.set(d.number, d); });
    const builder = index.createBuilder();
    for (const d of best.values()) builder.add(lu.toRecord(d));
    return { builder, source: { files } };
  },
  // Argentina: Registro Nacional de Sociedades, the latest yearly ZIP (one CSV snapshot inside).
  AR: async (fetchFn) => {
    const zips = (await ckanResources(fetchFn, 'AR')).filter((r) => /zip/i.test(r.format) && /sociedades - \d{4}$/i.test(r.name.trim()));
    zips.sort((a, b) => b.name.localeCompare(a.name));
    if (!zips.length) throw new Error('Argentina ZIP not found on datos.jus.gob.ar');
    const list = await zip.entries(fetchFn, zips[0].url);
    const csv = list.find((e) => /\.csv$/i.test(e.name));
    if (!csv) throw new Error('No CSV inside the Argentina ZIP');
    const builder = index.createBuilder({ sBuckets: 1024 });
    await ar.addFile(zip.text(fetchFn, zips[0].url, csv), (r) => builder.add(r));
    return { builder, source: { url: zips[0].url, file: csv.name, modified: zips[0].modified } };
  },
  // Canada: Corporations Canada federal corporations (daily CSVs, Open Government Licence - Canada).
  CA: async (fetchFn) => {
    const builder = index.createBuilder({ sBuckets: 1024 });
    for (const url of FILES.CA) await ca.addFile(download(fetchFn, url), (r) => builder.add(r));
    return { builder, source: { files: FILES.CA } };
  },
};

// Upload files from a generator with n in flight; returns how many were uploaded.
async function upload(gen, n, fn) {
  let count = 0;
  const next = () => { const x = gen.next(); return x.done ? null : x.value; };
  await Promise.all(Array.from({ length: n }, async () => { for (let item = next(); item; item = next()) { await fn(item); count++; } }));
  return count;
}

function createImport({ fetchFn = fetch, blobFetch = blob.http1Fetch, env = process.env, now = () => Date.now() } = {}) {
  return async function handler(req, res) {
    const send = (code, body) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(body)); };
    const token = env.BLOB_READ_WRITE_TOKEN;
    if (!token) return send(503, { error: 'Blob storage is not connected.' });
    const cc = String((req.query && req.query.country) || '').toUpperCase();
    if (req.query && req.query.peek && (FILES[cc] || CKAN[cc] || SEARCH[cc])) return send(200, { peek: await peekSafe(fetchFn, cc, { entry: req.query.entry ? String(req.query.entry) : null, bytes: req.query.bytes, skip: req.query.skip ? String(req.query.skip) : null, max: req.query.max, enc: req.query.enc ? String(req.query.enc) : null, links: !!req.query.links, whole: !!req.query.whole, scan: !!req.query.scan }) });
    if (!IMPORTERS[cc]) return send(404, { error: 'Unknown country.' });
    const prefix = `bulk/${cc.toLowerCase()}/`;
    const t = now();
    let stage = 'start';
    try {
      stage = 'checking the index';
      const existing = await blob.list(blobFetch, token, prefix);
      const at = (name) => { const b = existing.find((x) => x.pathname === prefix + name); return b ? Date.parse(b.uploadedAt) : null; };
      const built = at('manifest.json'); const locked = at('lock.json');
      const current = existing.find((x) => x.pathname === prefix + 'manifest.json');
      const cur = current ? await (await blobFetch(current.url + '?v=' + t)).json().catch(() => null) : null;
      const outdated = !cur || (cur.layout || 1) < LAYOUT || (cur.country_layout || 1) < (COUNTRY_LAYOUT[cc] || 1);
      if (built && t - built < MIN_AGE && !outdated) return send(200, { skipped: true, reason: 'Index is less than 20 days old.', built_at: new Date(built).toISOString() });
      if (locked && t - locked < LOCK_AGE) return send(409, { skipped: true, reason: 'An import is already running.' });
      await blob.put(blobFetch, token, prefix + 'lock.json', JSON.stringify({ started: new Date(t).toISOString() }), { cacheSeconds: 60 });

      stage = 'downloading and parsing';
      const got = await IMPORTERS[cc](fetchFn, { asOfIso: new Date(t).toISOString().slice(0, 10) });
      const { source } = got;
      const version = new Date(t).toISOString().replace(/[-:T]/g, '').slice(0, 12);
      const base = `${blob.publicBase(token)}/${prefix}${version}`;
      const put = ([path, text]) => blob.put(blobFetch, token, `${prefix}${version}/${path}`, text);
      const prev = cur;
      // Refuse to replace a good index with a much smaller one (a broken or partial download).
      const check = (n) => {
        if (prev && prev.count && n < prev.count * 0.8) throw new Error(`Only ${n} records, previous index had ${prev.count}; keeping the old one.`);
        if (!n) throw new Error('No records parsed.');
      };
      let builder; let nFiles = 0;
      const split = [];
      if (got.feed) {
        // Several passes over the source, each building one slice of the index (see createBuilder).
        const passes = got.passes || [{ only: 's' }, { only: 'd' }];
        for (let i = 0; i < passes.length; i++) {
          stage = `pass ${i + 1} of ${passes.length}: reading`;
          const b = index.createBuilder({ sBuckets: got.sBuckets, ...passes[i] });
          await got.feed((r) => b.add(r));
          console.log(`bulk-import ${cc} pass ${i + 1}/${passes.length} read ${b.count} records at ${Math.round((now() - t) / 1000)} s`);
          if (i === 0) { check(b.count); builder = b; }
          stage = `pass ${i + 1} of ${passes.length}: writing`;
          nFiles += await upload(b.files(), 12, put);
          console.log(`bulk-import ${cc} pass ${i + 1}/${passes.length} written at ${Math.round((now() - t) / 1000)} s`);
          split.push(...b.split);
        }
      } else {
        builder = got.builder;
        stage = 'writing the index';
        check(builder.count);
        nFiles = await upload(builder.files(), 12, put);
        split.push(...builder.split);
      }
      const m = { country: cc, layout: LAYOUT, country_layout: COUNTRY_LAYOUT[cc] || 1, version, base, built_at: new Date(t).toISOString(), count: builder.count, active: builder.active, s_buckets: builder.sBuckets, t_layout: 2, split: [...new Set(split)].sort(), source };
      await blob.put(blobFetch, token, prefix + 'manifest.json', JSON.stringify(m), { cacheSeconds: 60 });
      // Remove older versions and the lock.
      const stale = existing.filter((x) => x.pathname !== prefix + 'manifest.json' && !x.pathname.startsWith(`${prefix}${version}/`)).map((x) => x.url);
      if (stale.length) await blob.del(blobFetch, token, stale);
      const lock = await blob.list(blobFetch, token, prefix + 'lock.json');
      if (lock.length) await blob.del(blobFetch, token, lock.map((x) => x.url));
      return send(200, { ok: true, ...m, files: nFiles, seconds: Math.round((now() - t) / 1000) });
    } catch (e) {
      try { const l = (await blob.list(blobFetch, token, prefix + 'lock.json'))[0]; if (l) await blob.del(blobFetch, token, [l.url]); } catch (e2) { /* ignore */ }
      console.error(`bulk-import ${cc} failed while ${stage}:`, why(e));
      return send(500, { error: why(e), stage });
    }
  };
}

module.exports = createImport();
module.exports.createImport = createImport;
module.exports.IMPORTERS = IMPORTERS;
