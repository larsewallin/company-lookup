// Israel: Companies Registrar (Ministry of Justice) open data on data.gov.il. Free, no key.
'use strict';

const { record, ckan, digits } = require('./_common');

const BASE = 'https://data.gov.il';
const RES = 'f004176c-b85f-4542-8901-7b3176f9a054';
const F = {
  number: 'מספר חברה', name: 'שם חברה', nameEn: 'שם באנגלית', type: 'סוג תאגיד', status: 'סטטוס חברה', sub: 'תת סטטוס',
  purpose: 'מטרת החברה', date: 'תאריך התאגדות', gov: 'חברה ממשלתית', violator: 'מפרה', lastReport: 'שנה אחרונה של דוח שנתי (שהוגש)',
  city: 'שם עיר', street: 'שם רחוב', house: 'מספר בית', zip: 'מיקוד', country: 'מדינה',
};
const STATUS = { 'פעילה': 'Active', 'מחוסלת': 'Dissolved', 'מחוסלת מרצון': 'Voluntarily liquidated', 'בפירוק': 'In liquidation',
  'בפירוק מרצון': 'In voluntary liquidation', 'בפרוק': 'In liquidation', 'בפרוק מרצון': 'In voluntary liquidation',
  'חיסול ע~י בימ~ש': 'Liquidated by court', 'הוסרה': 'Struck off', 'נמחקה': 'Struck off', 'בהליכי מחיקה': 'Being struck off' };
const TYPES = { 'ישראלית חברה פרטית': 'Israeli private company', 'ישראלית חברה ציבורית': 'Israeli public company', 'חברה זרה': 'Foreign company' };

const normalise = (n) => { const s = digits(n); return /^\d{9}$/.test(s) ? s : null; };
const date = (s) => { const m = String(s || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
const nameOf = (r) => r[F.nameEn] && r[F.nameEn].trim() ? r[F.nameEn].trim() : String(r[F.name] || '').replace(/~/g, '"');

async function search(fetchFn, q) {
  const n = normalise(q);
  const rows = n && /^\s*\d+\s*$/.test(q)
    ? await ckan(fetchFn, BASE, RES, { filters: { [F.number]: Number(n) } }, 'Israeli Companies Registrar')
    : await ckan(fetchFn, BASE, RES, { q }, 'Israeli Companies Registrar');
  return rows.map((r) => ({ number: String(r[F.number]), name: nameOf(r), city: r[F.city] || null,
    status: r[F.status] === 'פעילה' ? 'active' : (STATUS[r[F.status]] || r[F.status] || '').toLowerCase(), incorporated: date(r[F.date]) }));
}

async function get(fetchFn, number, { asOfIso } = {}) {
  const n = normalise(number);
  if (!n) return null;
  const rows = await ckan(fetchFn, BASE, RES, { filters: { [F.number]: Number(n) }, limit: 1 }, 'Israeli Companies Registrar');
  const r = rows[0];
  if (!r) return null;
  const st = r[F.status] || '';
  const situations = [];
  if (st && st !== 'פעילה' && /פירוק|פרוק/.test(st)) situations.push({ level: 'stop', label: 'In liquidation', detail: `The register shows "${STATUS[st] || st}".` });
  if (r[F.violator] && String(r[F.violator]).trim()) situations.push({ level: 'check', label: 'Marked as a violating company', detail: 'The Registrar marks the company as violating, usually for unpaid annual fees or missing annual reports.' });
  const last = r[F.lastReport] ? Number(r[F.lastReport]) : null;
  if (st === 'פעילה' && asOfIso && last && last < Number(asOfIso.slice(0, 4)) - 1) {
    situations.push({ level: 'check', label: 'Annual report overdue', detail: `The last annual report filed with the Registrar is for ${last}.` });
  }
  return record({
    register: { name: 'Israeli Companies Registrar', number: n, url: 'https://ica.justice.gov.il/GenericCorporarionInfo/SearchCorporation?unit=8' },
    legal_name: nameOf(r),
    other_names: r[F.nameEn] && r[F.name] ? [String(r[F.name]).replace(/~/g, '"')] : [],
    legal_form: TYPES[r[F.type]] || r[F.type] || null,
    status: st === 'פעילה' ? 'active' : 'inactive',
    status_label: [STATUS[st] || st, r[F.sub]].filter(Boolean).join(' · '),
    incorporated: date(r[F.date]),
    registered_address: [[r[F.street], r[F.house]].filter(Boolean).join(' '), [r[F.zip], r[F.city]].filter(Boolean).join(' '), r[F.country]].filter(Boolean).join(', ') || null,
    last_accounts: last ? String(last) : null,
    extra: [r[F.gov] === 'כן' ? ['Government company', 'Yes'] : null].filter(Boolean),
    situations,
  });
}

module.exports = { country: 'IL', name: 'Israeli Companies Registrar', search, get, normalise };
