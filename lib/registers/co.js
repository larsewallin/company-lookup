// Colombia: RUES (the chambers of commerce's single business register) on datos.gov.co (Socrata). Free, no key.
// Only legal entities are used: rows for natural persons (sole traders) are excluded for privacy.
'use strict';

const { record, socrata, digits } = require('./_common');

const DOMAIN = 'www.datos.gov.co';
const DS = 'c82u-588k';
const SRC = 'RUES (Colombia)';
const ENTITY = "codigo_categoria_matricula='01'";

// NIT is 8-9 digits plus a check digit (GLEIF writes "899999068-1"); keep the NIT without the check digit.
const normalise = (n) => {
  const t = String(n || '').trim(); const base = /-\s*\d$/.test(t) ? t.replace(/-\s*\d$/, '') : t;
  const s = digits(base); return s.length === 10 ? s.slice(0, 9) : s.length >= 8 && s.length <= 9 ? s : null;
};
const coDate = (s) => { const m = /^(\d{4})(\d{2})(\d{2})/.exec(String(s || '')); return m ? `${m[1]}-${m[2]}-${m[3]}` : null; };
const isActive = (r) => r.codigo_estado_matricula === '01';

// Several rows can share a NIT (e.g. a move to another chamber); prefer the active one, then the latest.
const best = (rows) => rows.slice().sort((a, b) => (isActive(b) - isActive(a)) || String(b.fecha_matricula).localeCompare(String(a.fecha_matricula)))[0];

const nitWhere = (n) => `${ENTITY} AND nit='${n}'`;

async function search(fetchFn, q) {
  const n = /^[\d\s.\-]+$/.test(String(q).trim()) ? normalise(q) : null;
  const rows = n
    ? await socrata(fetchFn, DOMAIN, DS, nitWhere(n), { limit: 10 }, SRC)
    : await socrata(fetchFn, DOMAIN, DS, ENTITY, { q, limit: 30 }, SRC);
  const byNit = new Map();
  for (const r of rows) { if (r.nit) byNit.set(r.nit, (byNit.get(r.nit) || []).concat(r)); }
  return [...byNit.entries()].map(([nit, rs]) => { const r = best(rs); return { number: nit, name: r.razon_social, city: r.camara_comercio || null, status: isActive(r) ? 'active' : 'inactive', incorporated: coDate(r.fecha_matricula) }; });
}

async function get(fetchFn, number, { asOfIso } = {}) {
  const n = normalise(number);
  if (!n) return null;
  const rows = await socrata(fetchFn, DOMAIN, DS, nitWhere(n), { limit: 10 }, SRC);
  if (!rows.length) return null;
  const r = best(rows);
  const active = isActive(r);
  const situations = [];
  // Registrations must be renewed by 31 March each year.
  const year = asOfIso ? Number(asOfIso.slice(0, 4)) : null;
  const renewed = Number(r.ultimo_ano_renovado) || null;
  if (active && year && renewed) {
    const due = asOfIso.slice(5) > '04-30' ? year : year - 1;
    if (renewed < due) situations.push({ level: 'check', label: 'Registration not renewed', detail: `The last renewal on the commercial register was for ${renewed}; renewal is due by 31 March each year.` });
  }
  const ciiu = [r.cod_ciiu_act_econ_pri, r.cod_ciiu_act_econ_sec].filter(Boolean);
  return record({
    register: { name: 'RUES (Colombia)', number: r.nit, url: 'https://www.rues.org.co/', gleif_as: r.digito_verificacion ? `${r.nit}-${r.digito_verificacion}` : null },
    legal_name: r.razon_social,
    legal_form: [r.organizacion_juridica, r.tipo_sociedad].filter(Boolean).join(' · ') || null,
    status: active ? 'active' : 'inactive',
    status_label: r.estado_matricula ? r.estado_matricula.charAt(0) + r.estado_matricula.slice(1).toLowerCase() : 'Unknown',
    incorporated: coDate(r.fecha_matricula),
    industry: ciiu.map((c) => ({ code: c, label: 'CIIU' })),
    officers: r.representante_legal ? [{ name: r.representante_legal, role: 'Legal representative' }] : [],
    extra: [
      r.nit ? ['NIT', r.digito_verificacion ? `${r.nit}-${r.digito_verificacion}` : r.nit] : null,
      r.camara_comercio ? ['Chamber of commerce', `${r.camara_comercio} (registration ${r.matricula})`] : null,
      renewed ? ['Last renewed', String(renewed)] : null,
      coDate(r.fecha_vigencia) ? ['Company term ends', coDate(r.fecha_vigencia)] : null,
    ].filter(Boolean),
    situations,
  });
}

module.exports = { country: 'CO', name: 'RUES (Colombia)', search, get, normalise };
