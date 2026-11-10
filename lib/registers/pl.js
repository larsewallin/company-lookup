// Poland: National Court Register (KRS) open API. Free, no key. Lookup by KRS number only
// (no name search), so Polish companies are found through GLEIF or by typing the KRS number.
// Officer names are masked by the API and are not shown.
'use strict';

const { getJson } = require('../http');

const BASE = 'https://api-krs.ms.gov.pl/api/krs/OdpisAktualny';

function normalise(n) {
  const s = String(n || '').replace(/\D/g, '');
  return /^\d{1,10}$/.test(s) ? s.padStart(10, '0') : null;
}

const plDate = (s) => {
  const m = String(s || '').match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};
const title = (s) => (s ? String(s).toLowerCase().replace(/(^|[\s\-"(])(\p{L})/gu, (m, a, b) => a + b.toUpperCase()) : s);

async function fetchRecord(fetchFn, krs) {
  for (const rejestr of ['P', 'S']) {
    const d = await getJson(fetchFn, `${BASE}/${krs}?rejestr=${rejestr}&format=json`, { source: 'KRS (Poland)', allow404: true });
    if (d && d.odpis) return d.odpis;
  }
  return null;
}

// Only number search is possible: a 10-digit (or shorter) KRS number returns that company.
async function search(fetchFn, q) {
  const krs = /^\s*\d{6,10}\s*$/.test(q) ? normalise(q) : null;
  if (!krs) return [];
  const o = await fetchRecord(fetchFn, krs);
  if (!o) return [];
  const d1 = (o.dane && o.dane.dzial1) || {};
  return [{
    number: krs,
    name: d1.danePodmiotu ? d1.danePodmiotu.nazwa : null,
    city: d1.siedzibaIAdres && d1.siedzibaIAdres.adres ? title(d1.siedzibaIAdres.adres.miejscowosc) : null,
    status: 'active',
    incorporated: plDate(o.naglowekA && o.naglowekA.dataRejestracjiWKRS),
  }];
}

function lastAccountsYear(d3) {
  const list = (d3 && d3.wzmiankiOZlozonychDokumentach && d3.wzmiankiOZlozonychDokumentach.wzmiankaOZlozeniuRocznegoSprawozdaniaFinansowego) || [];
  let best = null;
  for (const x of list) {
    const years = String(x.zaOkresOdDo || '').match(/\b(19|20)\d{2}\b/g);
    if (!years) continue;
    const y = Number(years[years.length - 1]);
    if (best === null || y > best) best = y;
  }
  return best ? String(best) : null;
}

async function get(fetchFn, number) {
  const krs = normalise(number);
  if (!krs) return null;
  const o = await fetchRecord(fetchFn, krs);
  if (!o) return null;
  const dane = o.dane || {};
  const d1 = dane.dzial1 || {};
  const p = d1.danePodmiotu || {};
  const a = (d1.siedzibaIAdres && d1.siedzibaIAdres.adres) || {};
  const ids = p.identyfikatory || {};
  const situations = [];
  const d6 = dane.dzial6 || {};
  const serious = Object.keys(d6).filter((k) => k !== 'polaczeniePodzialPrzeksztalcenie' && d6[k] && (Array.isArray(d6[k]) ? d6[k].length : Object.keys(d6[k]).length));
  if (serious.length) situations.push({ level: 'stop', label: 'Liquidation, bankruptcy or restructuring entry', detail: `KRS section 6 has entries (${serious.join(', ')}).` });
  const d4 = dane.dzial4 || {};
  if (Object.keys(d4).some((k) => d4[k] && (Array.isArray(d4[k]) ? d4[k].length : Object.keys(d4[k]).length))) {
    situations.push({ level: 'check', label: 'Arrears or claims on the register', detail: 'KRS section 4 (arrears, claims or enforcement) has entries.' });
  }
  const deleted = !!(o.naglowekA && (o.naglowekA.dataWykreslenia || o.naglowekA.dataWykresleniaZRejestru));
  const capital = d1.kapital && d1.kapital.wysokoscKapitaluZakladowego;
  return {
    register: { name: 'National Court Register (KRS, Poland)', number: krs, url: `https://wyszukiwarka-krs.ms.gov.pl/details?krs=${krs}` },
    legal_name: p.nazwa || null,
    other_names: [],
    former_names: [],
    legal_form: title(p.formaPrawna) || null,
    status: deleted ? 'inactive' : 'active',
    status_label: deleted ? 'Deleted from the register' : 'Registered',
    incorporated: plDate(o.naglowekA && o.naglowekA.dataRejestracjiWKRS),
    ceased: null,
    registered_address: [[a.ulica, a.nrDomu].filter(Boolean).join(' '), [a.kodPocztowy, a.miejscowosc].filter(Boolean).join(' '), title(a.kraj)].filter(Boolean).join(', ') || null,
    industry: ((dane.dzial3 && dane.dzial3.przedmiotDzialalnosci && dane.dzial3.przedmiotDzialalnosci.przedmiotPrzewazajacejDzialalnosci) || [])
      .map((x) => ({ code: [x.kodDzial, x.kodKlasa, x.kodPodklasa].filter(Boolean).join('.'), label: title(x.opis) })),
    employees: null,
    size: null,
    website: d1.siedzibaIAdres && d1.siedzibaIAdres.adresStronyInternetowej ? d1.siedzibaIAdres.adresStronyInternetowej.toLowerCase() : null,
    vat: ids.nip ? { number: `PL${ids.nip}`, registered: null } : null,
    officers: null,
    auditor: null,
    financials: null,
    share_capital: capital ? `${capital.wartosc} ${capital.waluta}` : null,
    last_accounts: lastAccountsYear(dane.dzial3),
    situations,
    is_sole_trader: false,
  };
}

module.exports = { country: 'PL', name: 'KRS (Poland)', search, get, normalise };
