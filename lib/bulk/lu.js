// Luxembourg: STATEC Centrale des Bilans, "HVD Annex 5 Companies and Company Ownership - Annual deposits <year>" on
// data.public.lu (CC BY-SA): every annual-accounts deposit made at the RCS in a calendar year, one JSON file per year.
// Layout checked on 2026-11-09 (hvd.annualdeposits2024.json, 243 MB): a JSON array of
//   { "featuretype": "hvd.AnnualDeposits", "Declarations": "<pseudo-JSON text>" }
// where the text reads: { RcsNumber : B80587, LegalUnitName : EFFE International SA, Declarations : [ { Declaration :
//   { type : CA_BILANABR, StartDate : 2023-01-01, EndDate : 2023-12-31, YearRef : 2023, RCSDepositDate : ..., Currency : EUR,
//   FormData : { Field : [ { id : 0_Actif_2010, Label : TOTAL DU BILAN (ACTIF), Data : 80152.87, PreviousData : ... } ...
// Only companies that filed accounts appear; the latest financial year per RCS number is kept. Confidential P&L
// accounts are not published, so turnover is often missing.
'use strict';

const num = (s) => { const n = Number(s); return Number.isFinite(n) ? Math.round(n) : null; };

// Pull "Label : X, Data : 123.45" pairs and keep the lines a credit card needs (matched by label, not id).
function figures(text) {
  const out = {};
  const re = /Label : (.*?), Data : (-?\d+(?:\.\d+)?)/g; let m;
  while ((m = re.exec(text))) {
    const label = m[1].toLowerCase(); const v = num(m[2]);
    if (out.assets == null && /^total du bilan \(actif\)/.test(label)) out.assets = v;
    else if (out.equity == null && /^capitaux propres$/.test(label)) out.equity = v;
    else if (out.net_result == null && /^r[ée]sultat de l'exercice$|^b[ée]n[ée]fice ou perte de l'exercice/.test(label)) out.net_result = v;
    else if (out.revenue == null && /chiffre d'affaires net|montant net du chiffre d'affaires/.test(label)) out.revenue = v;
  }
  return out;
}

function declaration(text) {
  const rcs = (/RcsNumber : ([A-Z]\d+)/.exec(text) || [])[1];
  const name = (/LegalUnitName : (.*?), Declarations : \[/.exec(text) || [])[1];
  if (!rcs || !name) return null;
  const year = (/YearRef : (\d{4})/.exec(text) || [])[1] || null;
  const end = (/EndDate : (\d{4}-\d{2}-\d{2})/.exec(text) || [])[1] || null;
  const deposited = (/RCSDepositDate : (\d{4}-\d{2}-\d{2})/.exec(text) || [])[1] || null;
  const currency = (/Currency : ([A-Z]{3})/.exec(text) || [])[1] || 'EUR';
  const type = (/type : (CA_[A-Z]+)/.exec(text) || [])[1] || null;
  return { number: rcs, name: name.replace(/_and_/g, '&').replace(/\s+/g, ' ').trim(), year, period_end: end, deposited, currency, type, ...figures(text) };
}

// Streams one year file; calls onDecl for each deposit. The "Declarations" value is a JSON string (escaped quotes).
async function eachDeposit(chunks, onDecl) {
  const key = '"Declarations"'; let buf = ''; let n = 0;
  for await (const c of chunks) {
    buf += c;
    for (;;) {
      const k = buf.indexOf(key); if (k < 0) { buf = buf.slice(-key.length); break; }
      const m = /^\s*:\s*"/.exec(buf.slice(k + key.length, k + key.length + 20));
      if (!m) { if (buf.length - (k + key.length) < 20) { buf = buf.slice(k); break; } buf = buf.slice(k + key.length); continue; }
      const s = k + key.length + m[0].length - 1; // the opening quote of the string value
      const open = { length: 1 };
      let e = s + open.length; let esc = false;
      for (; e < buf.length; e++) { const ch = buf[e]; if (esc) { esc = false; continue; } if (ch === '\\') { esc = true; continue; } if (ch === '"') break; }
      if (e >= buf.length) { buf = buf.slice(k); break; }
      let text; try { text = JSON.parse(buf.slice(s, e + 1)); } catch (x) { text = buf.slice(s + 1, e); }
      const d = declaration(text); if (d) { onDecl(d); n++; }
      buf = buf.slice(e + 1);
    }
    if (buf.length > 20e6) throw new Error('Luxembourg deposit over 20 MB (unexpected layout)');
  }
  return n;
}

// Keep the latest financial year (then latest deposit) per RCS number.
function better(a, b) { if (!a) return true; if ((b.year || '') !== (a.year || '')) return (b.year || '') > (a.year || ''); return (b.deposited || '') >= (a.deposited || ''); }

function toRecord(d) {
  const r = { number: d.number, name: d.name, status: 'active', status_label: d.year ? `Filed annual accounts for ${d.year}` : 'Filed annual accounts', year: d.year, period_end: d.period_end, currency: d.currency };
  for (const k of ['revenue', 'net_result', 'assets', 'equity']) if (d[k] != null) r[k] = d[k];
  if (d.type) r.accounts_type = d.type;
  return r;
}

module.exports = { eachDeposit, declaration, figures, better, toRecord };
