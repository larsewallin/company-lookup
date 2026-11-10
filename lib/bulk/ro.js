// Romania: ONRC "Firme înregistrate la Registrul Comerțului" on data.gov.ro (reachable from fra1, not from iad1).
// '^'-separated UTF-8 CSVs with a BOM. Layout checked on 2026-11-09 (06.10.2025 snapshot):
//   OD_FIRME.CSV (660 MB): DENUMIRE^CUI^COD_INMATRICULARE^DATA_INMATRICULARE (dd/mm/yyyy)^EUID^FORMA_JURIDICA^ADR_TARA^
//     ADR_JUDET^ADR_LOCALITATE^ADR_DEN_STRADA^ADR_NR_STRADA^ADR_BLOC^ADR_SCARA^ADR_ETAJ^ADR_APARTAMENT^ADR_COD_POSTAL^ADR_SECTOR^ADR_COMPLETARE
//   OD_STARE_FIRMA.CSV (88 MB): COD_INMATRICULARE^COD (one row per status; a firm can have several)
//   N_STARE_FIRMA.CSV: COD^DENUMIRE (status names)
// Registration numbers starting with F are natural persons (PFA, II, IF, AF) and are excluded; J (companies) and
// C (cooperatives) are kept.
'use strict';

const { rows } = require('./csv');

const clean = (s) => String(s == null ? '' : s).replace(/^﻿/, '').replace(/\s+/g, ' ').trim();
const date = (s) => { const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(clean(s)); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
const keep = (cod) => /^[JC]/i.test(cod);

// Status name -> [rank, status, flag]; the worst status of a firm wins. Only "radiată" itself means deregistered;
// a deregistration request or court decision is still a Stop.
function classify(name) {
  const n = name.toLowerCase().trim();
  if (n === 'radiată' || n === 'radiata' || n === 'înmatriculare perimată') return [6, 'inactive', null];
  if (/sancțiuni internaționale|sanctiuni internationale|condamnare penal|urmărire penal|raspundere penal|răspundere penal|confiscare specială/.test(n)) return [5, 'active', 'stop'];
  if (/^denumire radiat/.test(n)) return [0, null, null];
  if (/radiere|faliment|insolven|lichidare|lichidator|dizolvare|reorganizare judiciar|redresare financiar|durata societății expirată/.test(n)) return [4, 'active', 'stop'];
  if (/sediu expirat|sediu radiat|valabilitate sediu|act de sediu desființat|nu funcționează la sediul|întrerupere temporară|suspendare activit|nedepus|sechestru|capital (neechilibrat|subscris sub)|mandat .*expirat|art\.237 alin\.1|sub incidența art\.237|perioadă de suspendare/.test(n)) return [2, 'active', 'check'];
  if (/funcțiune|functiune/.test(n)) return [1, 'active', null];
  return [0, null, null];
}

// N_STARE_FIRMA text -> Map(code -> { name, rank, status, flag })
async function codes(chunks) {
  const out = new Map(); let header = true;
  for await (const f of rows(chunks, '^', { quotes: false })) {
    if (header) { header = false; continue; }
    const code = clean(f[0]); const name = clean(f[1]); if (!code || !name) continue;
    const [rank, status, flag] = classify(name);
    out.set(code, { name, rank, status, flag });
  }
  return out;
}

// OD_STARE_FIRMA text -> Map(registration number -> worst status code), companies only.
async function statuses(chunks, codeMap) {
  const out = new Map(); let header = true;
  for await (const f of rows(chunks, '^', { quotes: false })) {
    if (header) { header = false; continue; }
    const cod = clean(f[0]); if (!keep(cod)) continue;
    const code = clean(f[1]); const c = codeMap.get(code); if (!c) continue;
    const prev = out.get(cod); if (!prev || c.rank > codeMap.get(prev).rank) out.set(cod, code);
  }
  return out;
}

function row(f, statusOf, codeMap) {
  const cod = clean(f[2]); if (!keep(cod)) return null;
  const name = clean(f[0]); if (!name) return null;
  const cui = clean(f[1]).replace(/\D/g, '');
  const number = cui && cui !== '0' ? cui : null; if (!number) return null;
  const sc = statusOf.get(cod); const s = sc ? codeMap.get(sc) : null;
  const out = { number, name, reg_no: cod, legal_form: clean(f[5]) || null, incorporated: date(f[3]),
    status: (s && s.status) || 'active', status_label: s ? s.name : 'Registered (no status recorded)' };
  if (s && s.flag) out.flag = s.flag;
  const euid = clean(f[4]); if (euid) out.euid = euid;
  const street = [clean(f[9]), clean(f[10]) && `nr. ${clean(f[10])}`, clean(f[11]) && `bl. ${clean(f[11])}`, clean(f[12]) && `sc. ${clean(f[12])}`,
    clean(f[13]) && `et. ${clean(f[13])}`, clean(f[14]) && `ap. ${clean(f[14])}`].filter(Boolean).join(' ');
  const pc = clean(f[15]).replace(/^0+$/, '');
  const addr = [street, clean(f[17]), [pc, clean(f[8])].filter(Boolean).join(' '), clean(f[7])].filter(Boolean).join(', ');
  if (addr) out.registered_address = addr;
  return out;
}

async function addFirms(chunks, add, statusOf, codeMap) {
  let header = true; let n = 0;
  for await (const f of rows(chunks, '^', { quotes: false })) {
    if (header) { header = false; continue; }
    const x = row(f, statusOf, codeMap); if (x) { add(x); n++; }
  }
  return n;
}

module.exports = { codes, statuses, addFirms, row, classify };
