// Paraguay: DNIT (formerly SET) "Listado de RUC con sus equivalencias", ruc0.zip ... ruc9.zip, each one UTF-8 text file
// with no header. Layout checked on 2026-11-08: RUC|NOMBRE O RAZON SOCIAL|DV|RUC ANTERIOR|ESTADO|
// Legal entities have RUCs from 80000000 up; lower numbers are individuals' cédulas and are excluded for privacy.
'use strict';

const { rows } = require('./csv');

const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

function status(estado) {
  const e = clean(estado).toUpperCase();
  if (e === 'ACTIVO') return ['active', 'Active taxpayer', null];
  if (e === 'SUSPENSION TEMPORAL') return ['active', 'Temporarily suspended (suspensión temporal)', 'check'];
  if (e === 'BLOQUEADO') return ['active', 'Blocked by DNIT (bloqueado)', 'stop'];
  if (e === 'CANCELADO' || e.startsWith('CANCELADO')) return ['inactive', 'Cancelled (cancelado)', null];
  return ['active', e || 'Unknown', null];
}

function row(f) {
  const ruc = clean(f[0]);
  if (!/^8\d{7}$/.test(ruc)) return null;
  const name = clean(f[1]); if (!name) return null;
  const [st, label, flag] = status(f[4]);
  const out = { number: ruc, name, status: st, status_label: label };
  if (flag) out.flag = flag;
  const dv = clean(f[2]); if (/^\d$/.test(dv)) out.dv = dv;
  return out;
}

async function addFile(chunks, add) {
  let n = 0;
  for await (const f of rows(chunks, '|', { quotes: false })) { const x = row(f); if (x) { add(x); n++; } }
  return n;
}

module.exports = { addFile, row, status };
