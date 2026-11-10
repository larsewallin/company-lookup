// Russia: Federal Tax Service (FNS) open data "Сведения о суммах доходов и расходов по данным бухгалтерской (финансовой)
// отчетности организации" (dataset 7707329152-revexp, file.nalog.ru/opendata/7707329152-revexp/data-<date>-structure-20180110.zip).
// A ZIP of a few thousand UTF-8 XML files with 900 documents each. Layout checked on 2026-11-08 (data-20261025):
// <Документ ДатаДок="25.10.2026" ДатаСост="31.12.2025"><СведНП НаимОрг="..." ИННЮЛ="7610013395"/>
//   <СведДохРасх СумДоход="1317000.00" СумРасход="1215000.00"/></Документ>
// It lists organisations (legal entities only, 10-digit INN) that filed accounts for the year, with revenue and expenses.
// The open data has no status or address; inclusion means the organisation filed accounts for that year.
'use strict';

const ENT = { quot: '"', apos: "'", amp: '&', lt: '<', gt: '>' };
const unescape = (s) => s.replace(/&(quot|apos|amp|lt|gt);|&#(\d+);/g, (m, n, d) => (n ? ENT[n] : String.fromCharCode(Number(d))));
const attr = (tag, name) => { const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag); return m ? unescape(m[1]).replace(/\s+/g, ' ').trim() : ''; };
const date = (s) => { const m = /(\d{2})\.(\d{2})\.(\d{4})/.exec(s || ''); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
const money = (s) => { const n = Number(s); return Number.isFinite(n) ? Math.round(n) : null; };

// Common long legal forms -> short forms used in Russia.
const FORMS = [['ПУБЛИЧНОЕ АКЦИОНЕРНОЕ ОБЩЕСТВО', 'ПАО'], ['НЕПУБЛИЧНОЕ АКЦИОНЕРНОЕ ОБЩЕСТВО', 'АО'], ['АКЦИОНЕРНОЕ ОБЩЕСТВО', 'АО'],
  ['ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ', 'ООО'], ['ЗАКРЫТОЕ АКЦИОНЕРНОЕ ОБЩЕСТВО', 'ЗАО'], ['ОТКРЫТОЕ АКЦИОНЕРНОЕ ОБЩЕСТВО', 'ОАО']];
function shortName(name) {
  for (const [long, short] of FORMS) if (name.toUpperCase().startsWith(long + ' ')) return `${short} ${name.slice(long.length + 1)}`;
  return null;
}

// One XML file's text -> records.
function documents(xml) {
  const out = [];
  const re = /<Документ(?=[\s>])([^>]*)>([\s\S]*?)<\/Документ>/g; let m;
  while ((m = re.exec(xml))) {
    const head = m[1]; const body = m[2];
    const np = /<СведНП(?=[\s/>])[^>]*\/?>/.exec(body); if (!np) continue;
    const inn = attr(np[0], 'ИННЮЛ'); const name = attr(np[0], 'НаимОрг');
    if (!/^\d{10}$/.test(inn) || !name) continue;
    const r = { number: inn, name, status: 'active', status_label: 'Filed accounts with the tax service', period: date(attr(head, 'ДатаСост')) };
    const short = shortName(name); if (short) r.other_name = short;
    const dr = /<СведДохРасх(?=[\s/>])[^>]*\/?>/.exec(body);
    if (dr) { const inc = money(attr(dr[0], 'СумДоход')); const exp = money(attr(dr[0], 'СумРасход')); if (inc != null) r.revenue = inc; if (exp != null) r.expenses = exp; }
    out.push(r);
  }
  return out;
}

module.exports = { documents, shortName };
