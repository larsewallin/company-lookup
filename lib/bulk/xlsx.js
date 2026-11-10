// Minimal streaming .xlsx reader (no dependencies). An .xlsx file is a ZIP; this reads xl/sharedStrings.xml into
// memory and streams the rows of one worksheet. read(name) must return an async iterable of text chunks for a ZIP
// entry (e.g. zip.text bound to a URL and its entry list).
'use strict';

const ENT = { quot: '"', apos: "'", amp: '&', lt: '<', gt: '>' };
const unescape = (s) => s.replace(/&(quot|apos|amp|lt|gt);|&#(\d+);|&#x([0-9a-f]+);/gi, (m, n, d, h) => (n ? ENT[n] : String.fromCodePoint(d ? Number(d) : parseInt(h, 16))));
const textOf = (xml) => { let out = ''; const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g; let m; while ((m = re.exec(xml))) out += m[1]; return unescape(out); };

// Yields the inner text of each <tag ...>...</tag> element in a stream.
async function* elements(chunks, tag) {
  const open = `<${tag}`; const close = `</${tag}>`;
  let buf = '';
  for await (const chunk of chunks) {
    buf += chunk;
    let start = 0;
    for (;;) {
      const s = buf.indexOf(open, start);
      if (s < 0) { start = Math.max(start, buf.length - (open.length - 1)); break; } // keep a partial "<tag" at the end
      // The tag name may end exactly at the chunk boundary: wait for more text instead of skipping it.
      if (s + open.length >= buf.length) { start = s; break; }
      const after = buf[s + open.length];
      if (after !== '>' && after !== ' ' && after !== '/') { start = s + open.length; continue; }
      const selfClose = buf.indexOf('/>', s); const gt = buf.indexOf('>', s);
      if (gt < 0) { start = s; break; }
      if (selfClose >= 0 && selfClose + 1 === gt) { yield ''; start = gt + 1; continue; }
      const e = buf.indexOf(close, gt);
      if (e < 0) { start = s; break; }
      yield buf.slice(s, e + close.length);
      start = e + close.length;
    }
    buf = buf.slice(start);
    if (buf.length > 5e6) throw new Error(`XLSX element over 5 MB (${tag})`);
  }
}

const colIndex = (ref) => { const letters = /^[A-Z]+/.exec(ref)[0]; let n = 0; for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

async function sharedStrings(read) {
  const out = [];
  try { for await (const si of elements(read('xl/sharedStrings.xml'), 'si')) out.push(textOf(si)); } catch (e) { if (!/missing/i.test(e.message)) throw e; }
  return out;
}

// Yields each row as an array of cell strings (by column position).
async function* rows(read, sheet = 'xl/worksheets/sheet1.xml', strings = null) {
  const ss = strings || (await sharedStrings(read));
  for await (const row of elements(read(sheet), 'row')) {
    const out = [];
    const re = /<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g; let m;
    while ((m = re.exec(row))) {
      const attrs = m[1]; const inner = m[2] || '';
      const ref = /\br="([A-Z]+)\d+"/.exec(attrs); const type = /\bt="(\w+)"/.exec(attrs);
      const i = ref ? colIndex(ref[1]) : out.length;
      let v = '';
      if (type && type[1] === 's') { const x = /<v>([\s\S]*?)<\/v>/.exec(inner); v = x ? ss[Number(x[1])] || '' : ''; }
      else if (type && type[1] === 'inlineStr') v = textOf(inner);
      else { const x = /<v>([\s\S]*?)<\/v>/.exec(inner); v = x ? unescape(x[1]) : ''; }
      out[i] = v;
    }
    for (let i = 0; i < out.length; i++) if (out[i] === undefined) out[i] = '';
    yield out;
  }
}

// Rows as objects keyed by the first row's headers.
async function* records(read, sheet) {
  let header = null;
  for await (const r of rows(read, sheet)) {
    if (!header) { header = r.map((h) => String(h).trim()); continue; }
    if (!r.length) continue;
    yield Object.fromEntries(header.map((h, i) => [h, r[i] == null ? '' : r[i]]));
  }
}

// Excel serial date (days since 1899-12-30) -> ISO date.
const excelDate = (v) => { const n = Number(v); if (!Number.isFinite(n) || n < 1000 || n > 100000) return null; return new Date(Date.UTC(1899, 11, 30) + n * 86400000).toISOString().slice(0, 10); };

module.exports = { rows, records, sharedStrings, excelDate, elements };
