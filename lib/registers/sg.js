// Singapore: ACRA corporate entities open data on data.gov.sg. Free, no key.
// ACRA publishes one dataset per first letter of the entity name, so IDs carry the letter: sg:D-196800306E.
'use strict';
const { userAgent } = require('../ua');

const { record, ckan, isoDate } = require('./_common');

const BASE = 'https://data.gov.sg';
// Dataset per first letter (from data.gov.sg collection 2, checked 2026-11-08).
const BY_LETTER = {
  A: 'd_8575e84912df3c28995b8e6e0e05205a', B: 'd_3a3807c023c61ddfba947dc069eb53f2', C: 'd_c0650f23e94c42e7a20921f4c5b75c24',
  D: 'd_acbc938ec77af18f94cecc4a7c9ec720', E: 'd_124a9bd407c7a25f8335b93b86e50fdd', F: 'd_4526d47d6714d3b052eed4a30b8b1ed6',
  G: 'd_b58303c68e9cf0d2ae93b73ffdbfbfa1', H: 'd_fa2ed456cf2b8597bb7e064b08fc3c7c', I: 'd_85518d970b8178975850457f60f1e738',
  J: 'd_478f45a9c541cbe679ca55d1cd2b970b', K: 'd_5573b0db0575db32190a2ad27919a7aa', L: 'd_a2141adf93ec2a3c2ec2837b78d6d46e',
  M: 'd_9af9317c646a1c881bb5591c91817cc6', N: 'd_67e99e6eabc4aad9b5d48663b579746a', O: 'd_5c4ef48b025fdfbc80056401f06e3df9',
  P: 'd_181005ca270b45408b4cdfc954980ca2', Q: 'd_4130f1d9d365d9f1633536e959f62bb7', R: 'd_2b8c54b2a490d2fa36b925289e5d9572',
  S: 'd_df7d2d661c0c11a7c367c9ee4bf896c1', T: 'd_72f37e5c5d192951ddc5513c2b134482', U: 'd_0cc5f52a1f298b916f317800251057f3',
  V: 'd_e97e8e7fc55b85a38babf66b0fa46b73', W: 'd_af2042c77ffaf0db5d75561ce9ef5688', X: 'd_1cd970d8351b42be4a308d628a6dd9d3',
  Y: 'd_31af23fdb79119ed185c256f03cb5773', Z: 'd_4e3db8955fdcda6f9944097bef3d2724', '0': 'd_300ddc8da4e8f7bdc1bfc62d0d99e2e7',
};
const letterOf = (name) => { const c = String(name || '').trim().toUpperCase().charAt(0); return BY_LETTER[c] ? c : '0'; };
// Optional key (free from data.gov.sg) raises rate limits for server requests.
const headers = () => (process.env.DATA_GOV_SG_API_KEY ? { 'x-api-key': process.env.DATA_GOV_SG_API_KEY } : { 'User-Agent': userAgent() });
const na = (v) => (v && v !== 'na' ? v : null);
const UEN_RE = /^[0-9A-Z]{9,10}$/;

function normalise(n) {
  const s = String(n || '').trim().toUpperCase();
  const m = s.match(/^([A-Z0]?)-?([0-9A-Z]{9,10})$/);
  if (!m) return null;
  return m[1] ? `${m[1]}-${m[2]}` : m[2];
}

async function search(fetchFn, q) {
  const L = letterOf(q);
  const rows = await ckan(fetchFn, BASE, BY_LETTER[L], { q, headers: headers() }, 'ACRA (Singapore)');
  return rows.map((r) => ({ number: `${letterOf(r.entity_name)}-${r.uen}`, name: r.entity_name, city: 'Singapore',
    status: /^live/i.test(r.entity_status_description || '') ? 'active' : String(r.entity_status_description || '').toLowerCase(),
    incorporated: isoDate(r.registration_incorporation_date) }));
}

async function get(fetchFn, number, { asOfIso, nameHint } = {}) {
  const id = normalise(number);
  if (!id) return null;
  const [L, uen] = id.includes('-') ? id.split('-') : [nameHint ? letterOf(nameHint) : null, id];
  if (!L || !UEN_RE.test(uen)) return null;
  const r = (await ckan(fetchFn, BASE, BY_LETTER[L], { filters: { uen }, limit: 1, headers: headers() }, 'ACRA (Singapore)'))[0];
  if (!r) return null;
  const st = r.entity_status_description || '';
  const live = /^live/i.test(st);
  const situations = [];
  if (/liquidat|winding|judicial management|receivership/i.test(st)) situations.push({ level: 'stop', label: st, detail: `ACRA status: "${st}".` });
  else if (/gazetted|struck off/i.test(st) && /gazett/i.test(st)) situations.push({ level: 'stop', label: 'Being struck off', detail: `ACRA status: "${st}".` });
  const due = isoDate(na(r.account_due_date));
  if (live && due && asOfIso && due < asOfIso) situations.push({ level: 'check', label: 'Accounts overdue', detail: `ACRA lists accounts as due ${due}.` });
  const former = [];
  for (let i = 1; i <= 15; i++) if (na(r[`former_entity_name${i}`])) former.push({ name: r[`former_entity_name${i}`], to: null });
  const auditors = [1, 2, 3, 4, 5].map((i) => na(r[`name_of_audit_firm${i}`])).filter(Boolean);
  return record({
    register: { name: 'ACRA (Singapore)', number: uen, url: `https://www.bizfile.gov.sg/` },
    legal_name: r.entity_name,
    former_names: former,
    legal_form: [na(r.company_type_description), na(r.business_constitution_description), r.entity_type_description].filter(Boolean)[0] || null,
    status: live ? 'active' : 'inactive',
    status_label: st || 'Unknown',
    incorporated: isoDate(r.registration_incorporation_date),
    registered_address: [[na(r.block), na(r.street_name)].filter(Boolean).join(' '), na(r.level_no) && na(r.unit_no) ? `#${r.level_no}-${r.unit_no}` : null, na(r.building_name),
      na(r.other_address_line1), na(r.other_address_line2), na(r.postal_code) ? `Singapore ${r.postal_code}` : 'Singapore'].filter(Boolean).join(', '),
    industry: na(r.primary_ssic_code) ? [{ code: r.primary_ssic_code, label: na(r.primary_ssic_description) || na(r.primary_user_described_activity) || 'SSIC' }] : [],
    auditor: auditors.join('; ') || null,
    extra: [na(r.annual_return_date) ? ['Last annual return', isoDate(r.annual_return_date)] : null, due ? ['Accounts due', due] : null,
      na(r.no_of_officers) ? ['Number of officers', r.no_of_officers] : null].filter(Boolean),
    situations,
    is_sole_trader: /sole proprietorship/i.test(r.business_constitution_description || ''),
  });
}

module.exports = { country: 'SG', name: 'ACRA (Singapore)', search, get, normalise, BY_LETTER };
