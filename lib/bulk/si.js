// Slovenia: AJPES business register (Poslovni register Slovenije), open data on podatki.gov.si (ZIP, UTF-16 CSV).
// Columns checked on 2026-11-08: "Matična številka", "Popolno ime", "HSEID", "Pravnoorganizacijska oblika",
// "Registrski organ", "Ulica", "Hišna št.", "Hišna št. dodatek", "Naselje", "Poštna št.", "Pošta", "Država".
// The register lists entities currently registered (no status column). Sole traders (s.p., "samostojni
// podjetnik") are excluded for privacy.
'use strict';

const { records } = require('./csv');

const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const pick = (r, ...names) => { for (const n of names) if (r[n] != null) return r[n]; return ''; };

function row(r) {
  const number = clean(pick(r, 'Matična številka', 'Maticna stevilka')).replace(/\D/g, '');
  const name = clean(pick(r, 'Popolno ime'));
  const form = clean(pick(r, 'Pravnoorganizacijska oblika'));
  if (!number || !name) return null;
  if (/samostojn|s\.p\.$/i.test(form) || /\bs\.\s?p\.$/i.test(name)) return null;
  const street = [clean(pick(r, 'Ulica')), clean(pick(r, 'Hišna št.')) + clean(pick(r, 'Hišna št. dodatek'))].filter(Boolean).join(' ');
  const addr = [street, clean(pick(r, 'Naselje')), [clean(pick(r, 'Poštna št.')), clean(pick(r, 'Pošta'))].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const out = { number, name, status: 'active', status_label: 'Registered (AJPES business register)', legal_form: form || null };
  if (addr) out.registered_address = addr;
  const org = clean(pick(r, 'Registrski organ')); if (org) out.registry = org;
  return out;
}

async function addFile(chunks, add) {
  let n = 0;
  for await (const r of records(chunks)) { const x = row(r); if (x) { add(x); n++; } }
  return n;
}

module.exports = { addFile, row };
