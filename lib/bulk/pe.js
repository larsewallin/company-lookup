// Peru: SUNAT "padrón reducido del RUC" (www2.sunat.gob.pe/padron_reducido_ruc.zip), pipe-separated Latin-1 text.
// Layout checked on 2026-11-08 (padron_reducido_ruc.txt, 1.58 GB):
// RUC|NOMBRE O RAZÓN SOCIAL|ESTADO DEL CONTRIBUYENTE|CONDICIÓN DE DOMICILIO|UBIGEO|TIPO DE VÍA|NOMBRE DE VÍA|CÓDIGO DE ZONA|
// TIPO DE ZONA|NÚMERO|INTERIOR|LOTE|DEPARTAMENTO|MANZANA|KILÓMETRO|
// Only legal entities are kept (RUC starting with 20); individuals (10, 15, 17) are excluded for privacy.
'use strict';

const { rows } = require('./csv');

const clean = (s) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t === '-' ? '' : t; };

// ESTADO DEL CONTRIBUYENTE -> [status, English label, flag]
function status(estado) {
  const e = estado.toUpperCase();
  if (e === 'ACTIVO') return ['active', 'Active taxpayer', null];
  if (e.startsWith('SUSPENSION')) return ['active', 'Activities temporarily suspended', 'check'];
  if (e.startsWith('BAJA')) return ['inactive', e === 'BAJA DEFINITIVA' ? 'Deregistered (baja definitiva)' : e.includes('OFICI') ? 'Deregistered by SUNAT (baja de oficio)' : `Deregistered (${estado.toLowerCase()})`, null];
  return ['active', estado || 'Unknown', null];
}

function row(f) {
  const ruc = clean(f[0]);
  if (!/^20\d{9}$/.test(ruc)) return null;
  const name = clean(f[1]); if (!name) return null;
  const [st, label, flag] = status(clean(f[2]));
  const cond = clean(f[3]).toUpperCase();
  const out = { number: ruc, name, status: st, status_label: label };
  if (flag) out.flag = flag;
  if (cond && cond !== 'HABIDO') out.address_condition = cond;
  const street = [clean(f[5]), clean(f[6]), clean(f[9]) && `${clean(f[9])}`, clean(f[10]) && `int. ${clean(f[10])}`,
    clean(f[11]) && `lote ${clean(f[11])}`, clean(f[12]) && `dpto. ${clean(f[12])}`, clean(f[13]) && `mz. ${clean(f[13])}`, clean(f[14]) && `km ${clean(f[14])}`].filter(Boolean).join(' ');
  const zone = [clean(f[8]), clean(f[7])].filter(Boolean).join(' ');
  const addr = [street, zone].filter(Boolean).join(', ');
  if (addr) out.registered_address = addr;
  const ubigeo = clean(f[4]); if (/^\d{6}$/.test(ubigeo)) out.ubigeo = ubigeo;
  return out;
}

async function addFile(chunks, add) {
  let header = true; let n = 0;
  for await (const f of rows(chunks, '|', { quotes: false })) {
    if (header) { header = false; continue; }
    const x = row(f); if (x) { add(x); n++; }
  }
  return n;
}

module.exports = { addFile, row, status };
