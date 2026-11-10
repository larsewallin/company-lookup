// Brazil: Receita Federal CNPJ open data, "Empresas" files (Empresas0.zip ... Empresas9.zip in the monthly folder of the
// public share arquivos.receitafederal.gov.br, WebDAV token gn672Ad4CF8N6TK). Latin-1, ';'-separated, every field quoted,
// no header. Layout checked on 2026-11-08 (2026-10 folder, Empresas0 = 2.35 GB):
// CNPJ_BASICO;RAZAO_SOCIAL;NATUREZA_JURIDICA;QUALIFICACAO_RESPONSAVEL;CAPITAL_SOCIAL ("5000,00");PORTE;ENTE_FEDERATIVO
// The status and address are in the separate Estabelecimentos files (7 GB each), so the index holds names only and the
// card comes from the live CNPJ lookup. Individuals are excluded: natureza 2135 (empresário individual, including MEI)
// and the 4xxx natures (pessoas físicas). Each Empresas file becomes its own index shard (BR0 ... BR9).
'use strict';

// Check digits for a CNPJ base (8 chars) + order (4 chars). Works for the alphanumeric CNPJ (from July 2026):
// each character counts as its char code minus 48.
function checkDigits(first12) {
  const v = [...first12].map((c) => c.charCodeAt(0) - 48);
  const dv = (vals, w) => { const s = vals.reduce((a, x, i) => a + x * w[i], 0) % 11; return s < 2 ? 0 : 11 - s; };
  const d1 = dv(v, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = dv([...v, d1], [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return `${d1}${d2}`;
}
const headOffice = (base) => `${base}0001${checkDigits(`${base}0001`)}`;

const PORTE = { '01': 'Micro company (ME)', '03': 'Small company (EPP)', '05': 'Other (not ME/EPP)' };
const individual = (nat) => nat === '2135' || /^4\d{3}$/.test(nat);

// One line of the Empresas file -> record, or null (individuals, malformed lines).
function row(line) {
  const t = line.replace(/\r$/, '');
  if (t.length < 10 || t[0] !== '"') return null;
  const f = t.slice(1, -1).split('";"');
  if (f.length < 6) return null;
  const base = f[0].trim().toUpperCase(); const nat = f[2].trim();
  if (!/^[0-9A-Z]{8}$/.test(base) || individual(nat)) return null;
  const name = f[1].replace(/\s+/g, ' ').trim(); if (!name) return null;
  const out = { number: headOffice(base), name, nature: nat };
  const cap = Number(String(f[4]).replace(/\./g, '').replace(',', '.')); if (Number.isFinite(cap) && cap > 0) out.capital = Math.round(cap);
  if (PORTE[f[5]]) out.size = f[5];
  return out;
}

// Lines are split cheaply; individuals (most rows) are dropped before anything else is built.
async function addFile(chunks, add) {
  let buf = ''; let n = 0;
  for await (const c of chunks) {
    buf += c; let i; let start = 0;
    while ((i = buf.indexOf('\n', start)) >= 0) {
      const line = buf.slice(start, i); start = i + 1;
      if (line.includes('";"2135";"')) continue;
      const x = row(line); if (x) { add(x); n++; }
    }
    buf = buf.slice(start);
    if (buf.length > 1e6) throw new Error('Brazil Empresas line over 1 MB (unexpected layout)');
  }
  if (buf) { const x = row(buf); if (x) { add(x); n++; } }
  return n;
}

module.exports = { addFile, row, checkDigits, headOffice, PORTE };
