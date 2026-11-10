// Minimal streaming CSV parser (RFC 4180: quoted fields, doubled quotes, newlines inside quotes).
// Works across chunk boundaries, including a doubled quote split between two chunks.
'use strict';

// quotes: false for formats without quoting (e.g. SUNAT's pipe files, where names may contain a lone ").
async function* rows(chunks, delim = ',', { quotes = true } = {}) {
  let field = ''; let row = []; let q = false; let quoteSeen = false;
  for await (const chunk of chunks) {
    const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (quoteSeen) { // previous char was a quote inside a quoted field
        quoteSeen = false;
        if (c === '"') { field += '"'; continue; }
        q = false; // it closed the field; fall through to handle c normally
      }
      if (q) {
        if (c === '"') quoteSeen = true; else { field += c; if (c === '\n' && field.length > 1e6) throw new Error('CSV field over 1 MB (an unbalanced quote?)'); }
      } else if (c === '"' && quotes) q = true;
      else if (c === delim) { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field.replace(/\r$/, '')); yield row; row = []; field = ''; }
      else field += c;
    }
  }
  if (field || row.length) { row.push(field.replace(/\r$/, '')); yield row; }
}

// Rows as objects keyed by the header line.
async function* records(chunks, delim = ',') {
  let header = null;
  for await (const r of rows(chunks, delim)) {
    if (!header) { header = r.map((h) => h.replace(/^﻿/, '').trim()); continue; }
    if (r.length === 1 && r[0] === '') continue;
    yield Object.fromEntries(header.map((h, i) => [h, r[i] == null ? '' : r[i]]));
  }
}

module.exports = { rows, records };
