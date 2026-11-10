// Dominican Republic: DGII taxpayer register (RNC), dgii.gov.do/app/WebApps/Consultas/RNC/DGII_RNC.zip, one pipe-separated
// Latin-1 text file (TMP/DGII_RNC.TXT, 91 MB, no header). Layout checked on 2026-11-08:
// RNC|RAZON SOCIAL|NOMBRE COMERCIAL|ACTIVIDAD ECONOMICA (30 chars)| | | | |FECHA INICIO (dd/mm/yyyy)|ESTADO|REGIMEN DE PAGO
// Companies and other legal entities have a 9-digit RNC; individuals are listed under their 11-digit cédula and
// are excluded for privacy.
'use strict';

const { rows } = require('./csv');

const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const date = (s) => { const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(clean(s)); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };

function status(estado) {
  const e = clean(estado).toUpperCase();
  if (e === 'ACTIVO') return ['active', 'Active taxpayer', null];
  if (e === 'SUSPENDIDO') return ['active', 'Suspended by DGII (suspendido)', 'check'];
  if (/CESE TEMPORAL/.test(e)) return ['active', 'Temporarily ceased trading (cese temporal)', 'check'];
  if (/BAJA|ANULADO|CESE DEFINITIVO/.test(e)) return ['inactive', `Deregistered (${e.toLowerCase()})`, null];
  return ['active', e || 'Unknown', null];
}

function row(f) {
  const rnc = clean(f[0]);
  if (!/^\d{9}$/.test(rnc)) return null;
  const name = clean(f[1]); if (!name) return null;
  const [st, label, flag] = status(f[9]);
  const out = { number: rnc, name, status: st, status_label: label, incorporated: date(f[8]) };
  if (flag) out.flag = flag;
  const trade = clean(f[2]); if (trade && trade !== name) out.other_name = trade;
  const act = clean(f[3]); if (act) out.activity = act;
  const regime = clean(f[10]); if (regime) out.regime = regime;
  return out;
}

async function addFile(chunks, add) {
  let n = 0;
  for await (const f of rows(chunks, '|', { quotes: false })) { const x = row(f); if (x) { add(x); n++; } }
  return n;
}

module.exports = { addFile, row, status };
