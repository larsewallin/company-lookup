// Quebec: Registraire des entreprises open data (donneesquebec.ca "Registre des entreprises", monthly ZIP).
// Files and codes checked against the ZIP on 2026-11-08:
//  - Nom.csv: NEQ, NOM_ASSUJ, NOM_ASSUJ_LANG_ETRNG, STAT_NOM (V in force, A former), TYP_NOM_ASSUJ (N name, M numbered
//    name, A other name, V name version), DAT_INIT_NOM_ASSUJ, DAT_FIN_NOM_ASSUJ
//  - Entreprise.csv: NEQ, IND_FAIL (bankruptcy O/N), DAT_IMMAT, COD_REGIM_JURI, COD_INTVAL_EMPLO_QUE, COD_STAT_IMMAT
//    (IM registered, RO/RX struck off ex officio, RD struck off on request, AI notice of intent, NI not registered),
//    COD_FORME_JURI (IND = sole proprietorship), DAT_STAT_IMMAT, AN_DECL (last annual update), AN_PROD_PRE,
//    DAT_LIMIT_PROD_PRE, COD_ACT_ECON_CAE, DESC_ACT_ECON_ASSUJ, NOM_LOCLT_CONSTI, DAT_CONSTI, ADR_DOMCL_LIGN1..4_ADR
//  - DomaineValeur.csv: TYP_DOM_VAL, COD_DOM_VAL, VAL_DOM_FRAN (labels for every code)
// Sole proprietorships (individuals) are excluded. Struck-off entities are kept for 10 years after striking off.
'use strict';

const { records } = require('./csv');

const STATUS = { IM: ['active', 'Immatriculée (registered)'], AI: ['active', 'Avis d’intention de constitution'], NI: ['active', 'Non immatriculée'],
  RO: ['inactive', 'Radiée d’office (struck off)'], RX: ['inactive', 'Radiée d’office, article 59 (struck off)'], RD: ['inactive', 'Radiée sur demande (struck off on request)'] };
const KEEP_STRUCK_OFF_YEARS = 10;
// INTVAL_EMPLO_QUE bands (employees in Quebec), from DomaineValeur.csv. N/P not declared, O none.
const EMPLOYEES = { A: '1–5', B: '6–10', C: '11–25', D: '26–49', E: '50–99', F: '100–249', G: '250–499', H: '500–749', I: '750–999', J: '1,000–2,499', K: '2,500–4,999', L: '5,000+' };

const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const date = (s) => { const m = /^(\d{4}-\d{2}-\d{2})/.exec(clean(s)); return m ? m[1] : null; };

async function domain(chunks) {
  const out = {};
  for await (const r of records(chunks)) (out[r.TYP_DOM_VAL] || (out[r.TYP_DOM_VAL] = {}))[clean(r.COD_DOM_VAL)] = clean(r.VAL_DOM_FRAN);
  return out;
}

// Name per NEQ: the in-force official name (N), else the in-force numbered name (M). Struck-off enterprises
// only have former names (STAT_NOM A), so the most recent former N/M name is the fallback.
async function names(chunks, stats = {}) {
  const best = new Map(); const rank = { N: 2, M: 1 }; stats.nameRows = 0;
  for await (const r of records(chunks)) {
    if (++stats.nameRows === 1) stats.firstNameRow = Object.keys(r).slice(0, 5);
    const typ = r.TYP_NOM_ASSUJ || r.TYP_NOM;
    if (!rank[typ] || (r.STAT_NOM !== 'V' && r.STAT_NOM !== 'A')) continue;
    const cur = r.STAT_NOM === 'V'; const end = cur ? '9999' : (r.DAT_FIN_NOM_ASSUJ || '');
    const prev = best.get(r.NEQ);
    const better = !prev || (cur && !prev.cur) || (cur === prev.cur && (end > prev.end || (end === prev.end && rank[typ] > prev.r)));
    if (better) best.set(r.NEQ, { r: rank[typ], cur, end, n: clean(r.NOM_ASSUJ), o: clean(r.NOM_ASSUJ_LANG_ETRNG) || null });
  }
  return best;
}

function row(r, nameOf, dom, cutoff) {
  if (r.COD_FORME_JURI === 'IND') return null;
  const neq = clean(r.NEQ); const nm = nameOf.get(neq);
  if (!neq || !nm) return null;
  const st = STATUS[r.COD_STAT_IMMAT] || ['active', clean(r.COD_STAT_IMMAT) || 'Unknown'];
  const statusDate = date(r.DAT_STAT_IMMAT);
  if (st[0] === 'inactive' && statusDate && statusDate < cutoff) return null;
  const lab = (t, c) => (c && dom[t] && dom[t][c]) || null;
  const out = { number: `qc-${neq}`, name: nm.n, status: st[0], status_label: st[1],
    legal_form: lab('FORM_JURI', r.COD_FORME_JURI) || clean(r.COD_FORME_JURI) || null,
    incorporated: date(r.DAT_CONSTI) || date(r.DAT_IMMAT) };
  if (nm.o && nm.o !== nm.n) out.other_name = nm.o;
  if (statusDate) out.status_date = statusDate;
  if (clean(r.IND_FAIL) === 'O') out.flag = 'stop';
  const law = lab('REGIM_JURI', clean(r.COD_REGIM_JURI)); if (law) out.law = law;
  const emp = EMPLOYEES[clean(r.COD_INTVAL_EMPLO_QUE)]; if (emp) out.employees_qc = emp;
  const act = clean(r.COD_ACT_ECON_CAE); if (act && act.length >= 3) out.activity = [act, clean(r.DESC_ACT_ECON_ASSUJ) || lab('ACT_ECON', act)];
  const addr = [r.ADR_DOMCL_LIGN1_ADR, r.ADR_DOMCL_LIGN2_ADR, r.ADR_DOMCL_LIGN3_ADR, r.ADR_DOMCL_LIGN4_ADR].map(clean).filter(Boolean).join(', ');
  if (addr) out.registered_address = addr;
  const y = Number(clean(r.AN_DECL)); if (y) out.last_update_year = y;
  const due = Number(clean(r.AN_PROD_PRE)); const lim = date(r.DAT_LIMIT_PROD_PRE);
  if (due && lim) { out.prev_update_year = due; out.prev_update_deadline = lim; }
  return out;
}

// zipRead(name) -> async iterable of text chunks for that entry.
async function build(zipRead, add, asOfIso, stats = {}) {
  const cutoff = `${Number(asOfIso.slice(0, 4)) - KEEP_STRUCK_OFF_YEARS}${asOfIso.slice(4, 10)}`;
  const dom = await domain(zipRead('DomaineValeur.csv'));
  stats.codeTypes = Object.keys(dom).length;
  const nameOf = await names(zipRead('Nom.csv'), stats);
  stats.names = nameOf.size;
  let n = 0; stats.rows = 0;
  for await (const r of records(zipRead('Entreprise.csv'))) {
    stats.rows++;
    if (stats.rows === 1) stats.firstRowKeys = Object.keys(r).slice(0, 4);
    const x = row(r, nameOf, dom, cutoff);
    nameOf.delete(clean(r.NEQ));
    if (x) { add(x); n++; }
  }
  stats.kept = n;
  return n;
}

module.exports = { build, row, names, domain, STATUS };
