// Argentina: Registro Nacional de Sociedades (Ministerio de Justicia open data, datos.jus.gob.ar), yearly ZIP
// with one CSV snapshot. Layout checked on 2026-11-08 (registro-nacional-sociedades-20260918.csv, 906 MB):
// cuit, razon_social, fecha_hora_contrato_social, tipo_societario, fecha_hora_actualizacion, numero_inscripcion,
// dom_fiscal_* and dom_legal_* (provincia, localidad, calle, numero, piso, departamento, cp, estado_domicilio),
// actividad_codigo, actividad_descripcion, actividad_orden, actividad_estado (AC active, BD ended), actividad_vigencia.
// One row per company and activity, sorted by CUIT. Companies only (CUIT 30/33/34), no individuals.
// The file has no status column: a name ending in "EN LIQUIDACION" / "EN QUIEBRA" is the only status signal.
'use strict';

const { records } = require('./csv');

const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const date = (s) => { const m = /^(\d{4}-\d{2}-\d{2})/.exec(clean(s)); return m ? m[1] : null; };

function address(r, p) {
  const street = [clean(r[`${p}_calle`]), clean(r[`${p}_numero`])].filter(Boolean).join(' ');
  const unit = [clean(r[`${p}_piso`]) && `piso ${clean(r[`${p}_piso`])}`, clean(r[`${p}_departamento`]) && `depto ${clean(r[`${p}_departamento`])}`].filter(Boolean).join(' ');
  return [street, unit, clean(r[`${p}_localidad`]), clean(r[`${p}_provincia`]), clean(r[`${p}_cp`])].filter(Boolean).join(', ');
}

function company(rows) {
  const r = rows[0];
  const cuit = clean(r.cuit).replace(/\D/g, '');
  const name = clean(r.razon_social);
  if (cuit.length !== 11 || !name) return null;
  const acts = [];
  for (const x of rows) {
    if (clean(x.actividad_estado) !== 'AC' || !clean(x.actividad_codigo)) continue;
    const code = clean(x.actividad_codigo);
    if (!acts.some((a) => a[0] === code)) acts.push([code, clean(x.actividad_descripcion) || null, Number(x.actividad_orden) || 9]);
  }
  acts.sort((a, b) => a[2] - b[2]);
  const out = { number: cuit, name, status: 'active', status_label: 'Registered (the register publishes no status)',
    legal_form: clean(r.tipo_societario) || null, incorporated: date(r.fecha_hora_contrato_social) };
  const legal = address(r, 'dom_legal'); const fiscal = address(r, 'dom_fiscal');
  if (legal) out.registered_address = legal;
  if (fiscal && fiscal !== legal) out.fiscal_address = fiscal;
  const fiscalState = clean(r.dom_fiscal_estado_domicilio);
  if (/INEXISTENTE|DESCONOCIDO/i.test(fiscalState)) out.fiscal_address_state = fiscalState;
  if (acts.length) out.activities = acts.slice(0, 3).map((a) => [a[0], a[1]]);
  const upd = date(r.fecha_hora_actualizacion); if (upd) out.updated = upd;
  if (/\bEN (LIQUIDACION|LIQUIDACIÓN)\b/i.test(name)) { out.flag = 'stop'; out.flag_label = 'In liquidation'; }
  else if (/\bEN QUIEBRA\b/i.test(name)) { out.flag = 'stop'; out.flag_label = 'In bankruptcy'; }
  return out;
}

// Stream the CSV; rows for one CUIT are consecutive.
async function addFile(chunks, add) {
  let group = []; let n = 0;
  const flush = () => { if (group.length) { const c = company(group); if (c) { add(c); n++; } } group = []; };
  for await (const r of records(chunks)) {
    if (group.length && r.cuit !== group[0].cuit) flush();
    group.push(r);
  }
  flush();
  return n;
}

module.exports = { addFile, company };
