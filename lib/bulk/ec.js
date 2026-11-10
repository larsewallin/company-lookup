// Ecuador: SRI catastro del RUC (descargas.sri.gob.ec/download/datosAbiertos/SRI_RUC_<Provincia>.zip, one per province),
// pipe-separated UTF-8 CSV with one row per establishment. Layout checked on 2026-11-08:
// NUMERO_RUC|RAZON_SOCIAL|CODIGO_JURISDICCION|ESTADO_CONTRIBUYENTE|CLASE_CONTRIBUYENTE|FECHA_INICIO_ACTIVIDADES|
// FECHA_ACTUALIZACION|FECHA_SUSPENSION_DEFINITIVA|FECHA_REINICIO_ACTIVIDADES|OBLIGADO|TIPO_CONTRIBUYENTE|
// NUMERO_ESTABLECIMIENTO|NOMBRE_FANTASIA_COMERCIAL|ESTADO_ESTABLECIMIENTO|DESCRIPCION_PROVINCIA_EST|DESCRIPCION_CANTON_EST|
// DESCRIPCION_PARROQUIA_EST|CODIGO_CIIU|ACTIVIDAD_ECONOMICA|AGENTE_RETENCION|ESPECIAL
// Only TIPO_CONTRIBUYENTE = SOCIEDAD is kept (individuals excluded). One record per RUC, taken from establishment 1
// (the head office) when it exists. The SRI list of shell companies ("empresas fantasmas", Latin-1 CSV) adds a Stop.
'use strict';

const { rows } = require('./csv');

const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const day = (s) => { const m = /^(\d{4}-\d{2}-\d{2})/.exec(clean(s)); return m ? m[1] : null; };
const COL = ['NUMERO_RUC', 'RAZON_SOCIAL', 'CODIGO_JURISDICCION', 'ESTADO_CONTRIBUYENTE', 'CLASE_CONTRIBUYENTE', 'FECHA_INICIO_ACTIVIDADES',
  'FECHA_ACTUALIZACION', 'FECHA_SUSPENSION_DEFINITIVA', 'FECHA_REINICIO_ACTIVIDADES', 'OBLIGADO', 'TIPO_CONTRIBUYENTE', 'NUMERO_ESTABLECIMIENTO',
  'NOMBRE_FANTASIA_COMERCIAL', 'ESTADO_ESTABLECIMIENTO', 'DESCRIPCION_PROVINCIA_EST', 'DESCRIPCION_CANTON_EST', 'DESCRIPCION_PARROQUIA_EST',
  'CODIGO_CIIU', 'ACTIVIDAD_ECONOMICA', 'AGENTE_RETENCION', 'ESPECIAL'];

function status(estado, suspended, restarted) {
  const e = clean(estado).toUpperCase();
  if (e === 'ACTIVO') return ['active', 'Active taxpayer', null];
  if (e === 'PASIVO') return ['inactive', 'No longer trading (RUC pasivo)', null];
  if (e === 'SUSPENDIDO') {
    if (suspended && !(restarted && restarted > suspended)) return ['inactive', `RUC suspended permanently on ${suspended} (suspensión definitiva)`, null];
    return ['active', 'RUC suspended (suspendido)', 'check'];
  }
  return ['active', e || 'Unknown', null];
}

// f: array of fields; idx: column positions from the header. Returns null for non-companies.
function row(f, idx) {
  const g = (name) => clean(f[idx[name]]);
  if (g('TIPO_CONTRIBUYENTE').toUpperCase() !== 'SOCIEDAD') return null;
  const ruc = g('NUMERO_RUC'); const name = g('RAZON_SOCIAL');
  if (!/^\d{13}$/.test(ruc) || !name) return null;
  const [st, label, flag] = status(g('ESTADO_CONTRIBUYENTE'), day(g('FECHA_SUSPENSION_DEFINITIVA')), day(g('FECHA_REINICIO_ACTIVIDADES')));
  const out = { number: ruc, name, status: st, status_label: label, incorporated: day(g('FECHA_INICIO_ACTIVIDADES')) };
  if (flag) out.flag = flag;
  const trade = g('NOMBRE_FANTASIA_COMERCIAL'); if (trade && trade !== name) out.other_name = trade;
  const place = [g('DESCRIPCION_PARROQUIA_EST'), g('DESCRIPCION_CANTON_EST'), g('DESCRIPCION_PROVINCIA_EST')].filter(Boolean);
  if (place.length) out.location = [...new Set(place)].join(', ');
  const ciiu = g('CODIGO_CIIU'); const act = g('ACTIVIDAD_ECONOMICA');
  if (ciiu || act) out.activity = { code: ciiu || null, label: act.length > 140 ? `${act.slice(0, 137)}...` : act };
  if (g('CLASE_CONTRIBUYENTE') === 'ESP' || g('ESPECIAL') === 'S') out.special = true;
  return out;
}

// SRI_Catastro_Empresas_Fantasmas.csv -> Map(ruc -> { detail, ended })
async function shells(chunks) {
  const out = new Map(); let header = null;
  for await (const f of rows(chunks, '|', { quotes: false })) {
    if (!header) { header = f.map((h) => clean(h).toUpperCase()); continue; }
    const v = (n) => clean(f[header.indexOf(n)]);
    if (v('TIPO_CONTRIBUYENTE').toUpperCase() !== 'SOCIEDAD') continue;
    const ruc = v('NUMERO_RUC'); if (!/^\d{13}$/.test(ruc)) continue;
    const reactivated = !!v('FECHA_REACTIVACION_RUC');
    out.set(ruc, { detail: v('DETALLE_CALIFICACION') || 'Empresa inexistente / fantasma', reactivated });
  }
  return out;
}

// Streams one province file. state = { done: Set, pending: Map, shells: Map } shared across all province files;
// call finish(state, add) after the last file to add companies whose head office row never appeared.
// Fast line splitter: most rows are individuals, so lines without "|SOCIEDAD|" are skipped before splitting.
async function* lines(chunks) {
  let buf = '';
  for await (const c of chunks) {
    buf += c; let i; let start = 0;
    while ((i = buf.indexOf('\n', start)) >= 0) { yield buf.slice(start, i).replace(/\r$/, ''); start = i + 1; }
    buf = buf.slice(start);
    if (buf.length > 1e6) throw new Error('Ecuador RUC line over 1 MB (unexpected layout)');
  }
  if (buf) yield buf.replace(/\r$/, '');
}

async function addFile(chunks, add, state) {
  let idx = null; let n = 0;
  for await (const line of lines(chunks)) {
    if (!idx) { idx = {}; line.split('|').forEach((h, i) => { idx[clean(h).replace(/^\uFEFF/, '').toUpperCase()] = i; }); for (const c of COL) if (idx[c] == null) throw new Error(`Ecuador RUC file is missing column ${c}`); continue; }
    if (!line.includes('|SOCIEDAD|')) continue;
    const f = line.split('|');
    if (clean(f[idx.TIPO_CONTRIBUYENTE]).toUpperCase() !== 'SOCIEDAD') continue;
    const ruc = clean(f[idx.NUMERO_RUC]);
    if (state.done.has(ruc)) continue;
    const x = row(f, idx); if (!x) continue;
    if (Number(clean(f[idx.NUMERO_ESTABLECIMIENTO])) === 1) { state.pending.delete(ruc); state.done.add(ruc); add(withShell(x, state)); n++; }
    else if (!state.pending.has(ruc)) state.pending.set(ruc, x);
  }
  return n;
}

function finish(state, add) {
  let n = 0;
  for (const [ruc, x] of state.pending) { if (!state.done.has(ruc)) { add(withShell(x, state)); n++; } }
  state.pending.clear();
  return n;
}

function withShell(x, state) {
  const s = state.shells && state.shells.get(x.number);
  if (s) { x.shell = s.detail; if (!s.reactivated) x.flag = 'stop'; }
  return x;
}

const newState = (shellMap = new Map()) => ({ done: new Set(), pending: new Map(), shells: shellMap });

module.exports = { addFile, finish, shells, newState, row, status, COL };
