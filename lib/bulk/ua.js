// Ukraine: Unified State Register of legal entities (ЄДР, Ministry of Justice open data on data.gov.ua), UO.zip
// with one XML file (3.2 GB, windows-1251). Layout checked on 2026-11-08: <SUBJECT> with NAME, SHORT_NAME, OPF
// (legal form), EDRPOU, STAN (status), AUTHORIZED_CAPITAL, REGISTRATION ("dd.mm.yyyy; dd.mm.yyyy; record no"),
// TERMINATION_STARTED_INFO, BANKRUPTCY_READJUSTMENT_INFO, TERMINATED_INFO ("dd.mm.yyyy; record; reason"), FOUNDERS,
// SIGNERS, BENEFICIARIES. The open file has no addresses. Founders, signers and beneficiaries are left out (mostly
// private individuals). Entities terminated more than 10 years ago are skipped.
'use strict';

const KEEP_TERMINATED_YEARS = 10;
const ENT = { quot: '"', apos: "'", amp: '&', lt: '<', gt: '>' };
const unescape = (s) => s.replace(/&(quot|apos|amp|lt|gt);|&#(\d+);/g, (m, n, d) => (n ? ENT[n] : String.fromCharCode(Number(d))));
const tag = (block, name) => { const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(block); return m ? unescape(m[1]).replace(/\s+/g, ' ').trim() : ''; };
const date = (s) => { const m = /(\d{2})\.(\d{2})\.(\d{4})/.exec(s || ''); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
const has = (block, name) => new RegExp(`<${name}>[\\s\\S]*?</${name}>`).test(block);

function status(stan) {
  const s = stan.toLowerCase();
  if (s.includes('банкрут')) return ['active', `Bankruptcy case opened (${stan})`, 'stop'];
  if (s.includes('в стані припинення')) return ['active', 'Being wound up (в стані припинення)', 'stop'];
  if (s.includes('припинено')) return ['inactive', 'Terminated (припинено)', null];
  if (s.includes('недійсн')) return ['active', 'Registered; registration certificate invalid', 'check'];
  if (s.includes('зареєстровано')) return ['active', 'Registered (зареєстровано)', null];
  return ['active', stan || 'Unknown', null];
}

function subject(block, cutoff) {
  const code = tag(block, 'EDRPOU').replace(/\D/g, '');
  const name = tag(block, 'NAME');
  if (!/^\d{8}$/.test(code) || !name) return null;
  const [st, label, flag] = status(tag(block, 'STAN'));
  const terminated = date(tag(block, 'TERMINATED_INFO'));
  if (st === 'inactive' && terminated && terminated < cutoff) return null;
  const out = { number: code, name, status: st, status_label: label, legal_form: tag(block, 'OPF') || null, incorporated: date(tag(block, 'REGISTRATION')) };
  if (flag) out.flag = flag;
  const short = tag(block, 'SHORT_NAME'); if (short && short !== name) out.other_name = short;
  if (terminated) out.status_date = terminated;
  const cap = tag(block, 'AUTHORIZED_CAPITAL'); if (cap && /^[\d\s,.]+$/.test(cap)) out.capital = cap;
  if (has(block, 'BANKRUPTCY_READJUSTMENT_INFO') && !out.flag) { out.flag = 'stop'; out.status_label += '; bankruptcy proceedings recorded'; }
  return out;
}

// chunks: async iterable of decoded text. Streams <SUBJECT> blocks.
async function addFile(chunks, add, asOfIso) {
  const cutoff = `${Number(asOfIso.slice(0, 4)) - KEEP_TERMINATED_YEARS}${asOfIso.slice(4, 10)}`;
  let buf = ''; let n = 0;
  for await (const chunk of chunks) {
    buf += chunk;
    let end = buf.indexOf('</SUBJECT>');
    let start = 0;
    while (end >= 0) {
      const s = buf.lastIndexOf('<SUBJECT>', end);
      if (s >= start) { const x = subject(buf.slice(s, end), cutoff); if (x) { add(x); n++; } }
      start = end + 10;
      end = buf.indexOf('</SUBJECT>', start);
    }
    buf = buf.slice(start);
    if (buf.length > 5e6) throw new Error('XML record over 5 MB (unexpected layout)');
  }
  return n;
}

module.exports = { addFile, subject, status };
