// Moldova: Public Services Agency (ASP) "Date din Registrul de stat al unităţilor de drept privind întreprinderile
// înregistrate", company.xlsx linked from asp.gov.md/ro/date-deschise/date-statistice/company. Layout checked on
// 2026-11-08 (state at 02.11.2026), sheet1, title row then header row:
// IDNO/ Cod fiscal | Data înregistrării (Excel date) | Denumirea completă | Forma org./jurid. | Adresa | CUATM |
// Lista conducătorilor | Lista fondatorilor (cu cota %) | Genuri de activitate nelicentiate | ... licentiate | Data lichidării
// Sole traders (întreprindere individuală) and peasant farms are excluded. Managers are left out (private persons);
// founders are kept only when they are clearly organisations (corporate shareholders, the state).
'use strict';

const { excelDate } = require('./xlsx');

const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const INDIVIDUAL = /întreprindere individual|intreprindere individual|gospodări[ae] ț[ăa]r[ăa]neasc|gospodaria taraneasca|titular de patent/i;
const ORG = /\b(S\.?R\.?L\.?|S\.?A\.?|Î\.?C\.?S\.?|I\.?C\.?S\.?|LTD|LLC|GMBH|AG|SRL|STATUL|PRIMĂRIA|PRIMARIA|CONSILIUL|MINISTERUL|AGENȚIA|AGENTIA|COOPERATIVA|ASOCIAȚIA|ASOCIATIA|FONDUL|COMPANIA|COMPANY|CORPORATION|HOLDING|BANCA|UNIVERSITATEA|ÎNTREPRINDEREA|INTREPRINDEREA|SOCIETATEA|LIMITED|B\.?V\.?|S\.?P\.?A\.?|SP\. Z O\.O\.|OOO|ООО|АО|ПАО)\b/i;

// "NAME (12,50%), OTHER NAME (87,50%)" -> organisations only, with their share.
function corporateFounders(list) {
  const out = [];
  for (const part of clean(list).split(/,\s*(?=[^()]*(?:\(|$))/)) {
    const m = /^(.*?)\s*\(([\d.,]+)%\)\s*$/.exec(part.trim());
    const name = clean(m ? m[1] : part); if (!name || !ORG.test(name)) continue;
    out.push(m ? { name, share: `${m[2].replace(',', '.')}%` } : { name });
  }
  return out;
}

// Header names (row 2) -> positions, so a column moving does not break the import.
const COLS = { idno: /^IDNO/i, reg: /^Data înregistr/i, name: /^Denumirea/i, form: /^Forma/i, addr: /^Adresa/i, founders: /^Lista fondatorilor/i, act: /^Genuri de activitate nelicen/i, liq: /^Data lichid/i };

function makeRow(header) {
  const idx = {}; for (const [k, re] of Object.entries(COLS)) idx[k] = header.findIndex((h) => re.test(clean(h)));
  for (const k of ['idno', 'name', 'form']) if (idx[k] < 0) throw new Error(`Moldova company.xlsx: column for ${k} not found`);
  return (r) => {
    const g = (k) => (idx[k] >= 0 ? clean(r[idx[k]]) : '');
    const idno = g('idno').replace(/\D/g, ''); const name = g('name'); const form = g('form');
    if (!/^\d{13}$/.test(idno) || !name || INDIVIDUAL.test(form)) return null;
    const liq = excelDate(g('liq'));
    const out = { number: idno, name, legal_form: form || null, status: liq ? 'inactive' : 'active', status_label: liq ? `Liquidated (${liq})` : 'Registered', incorporated: excelDate(g('reg')) };
    if (liq) out.status_date = liq;
    const addr = g('addr'); if (addr) out.registered_address = addr;
    const f = corporateFounders(g('founders')); if (f.length) out.corporate_founders = f;
    const act = g('act'); if (act) out.activity_codes = act.split(/,\s*/).slice(0, 5);
    return out;
  };
}

// rowsIter: async iterable of arrays (xlsx.rows). Skips the title row; the header is the first row starting with IDNO.
async function addRows(rowsIter, add) {
  let row = null; let n = 0;
  for await (const r of rowsIter) {
    if (!row) { if (/^IDNO/i.test(clean(r[0]))) row = makeRow(r); continue; }
    const x = row(r); if (x) { add(x); n++; }
  }
  if (!row) throw new Error('Moldova company.xlsx: header row not found');
  return n;
}

module.exports = { addRows, corporateFounders, makeRow };
