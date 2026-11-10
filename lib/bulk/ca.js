// Canada: Corporations Canada federal corporations, open data (Open Government Licence - Canada).
// Four daily CSVs (active/inactive x CBCA/other acts). Layout checked against the files on 2026-11-08:
// Corporation number, Business number (BN), Corporate name - form 1, Corporate name - form 2, Governing legislation,
// Status, Status Detail, Anniversary date, Year of last annual filing, Date of last annual meeting, Street, Street 2,
// City/town, Province/territory, Country, Postal code, Minimum number of directors, Maximum number of directors
'use strict';

const { records } = require('./csv');

const STOP_DETAIL = {
  'active - dissolution pending (non-compliance)': 'Dissolution pending (non-compliance)',
  'active - intent to dissolve filed': 'Intent to dissolve filed',
};

const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const date = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(clean(s)) ? clean(s) : null);

function row(r) {
  const number = clean(r['Corporation number']).replace(/\D/g, '');
  const name = clean(r['Corporate name - form 1']);
  if (!number || !name) return null;
  const st = clean(r.Status).toLowerCase();
  const detail = clean(r['Status Detail']);
  const active = st === 'active';
  const stop = STOP_DETAIL[detail.toLowerCase()] || null;
  const addr = [r.Street, r['Street 2'], r['City/town'], r['Province/territory'], r['Postal code']].map(clean)
    .filter((x) => x && !/^no(address|city)/i.test(x)).join(', ');
  const out = {
    number, name,
    status: active ? 'active' : 'inactive',
    status_label: detail || clean(r.Status) || 'Unknown',
    legal_form: clean(r['Governing legislation']) || null,
    incorporated: date(r['Anniversary date']),
  };
  if (stop) { out.flag = 'stop'; out.status_label = stop; }
  const other = clean(r['Corporate name - form 2']); if (other && other !== name) out.other_name = other;
  const bn = clean(r['Business number (BN)']); if (/^\d{9}$/.test(bn)) out.bn = bn;
  if (addr) out.registered_address = addr;
  const prov = clean(r['Province/territory']); if (prov) out.province = prov;
  const y = Number(clean(r['Year of last annual filing'])); if (y) out.last_filing_year = y;
  const m = date(r['Date of last annual meeting']); if (m) out.last_meeting = m;
  return out;
}

// Parse one CSV (async iterable of text chunks) and pass each record to add().
async function addFile(chunks, add) {
  let n = 0;
  for await (const r of records(chunks)) { const x = row(r); if (x) { add(x); n++; } }
  return n;
}

module.exports = { addFile, row };
