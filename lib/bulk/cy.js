// Cyprus: Department of Registrar of Companies and Intellectual Property, monthly open data (CC BY 4.0).
// data.gov.cy dataset 1026: organisations_*.csv, registered_office_*.csv, organisation_officials_*.csv.
// Field layout and status values checked against the files on 2026-11-08.
// Turns the three files into one normalised record per company, ready to load into a search index.
// Business names (type B) are excluded: many belong to individuals.
'use strict';

const { records } = require('./csv');

// Organisation status (Greek) -> [status, English label, flag level or null]
const STATUS = {
  'Εγγεγραμμένη': ['active', 'Registered', null],
  'Διαγραμμένη': ['inactive', 'Struck off', null],
  'Στάληκε επιστολή Υπενθύμισης': ['active', 'Reminder letter sent (before strike-off)', 'check'],
  'Δημοσιεύτηκε η Τρίμηνη': ['active', 'Three-month strike-off notice published', 'stop'],
  'Διάλυση λόγω Ολοκλήρωσης Εκκαθάρισης': ['inactive', 'Dissolved after liquidation', null],
  'Διάλυση λόγω Ολοκλήρωσης Εκούσιας Εκκαθάρισης': ['inactive', 'Dissolved after voluntary liquidation', null],
  'Διαλύθηκε λόγω συγχώνευσης': ['inactive', 'Dissolved by merger', null],
  'Εκκαθάριση με Διάταγμα Δικαστηρίου': ['active', 'Compulsory liquidation (court order)', 'stop'],
  'Εκούσια Εκκαθάριση από Μετόχους': ['active', "Members' voluntary liquidation", 'stop'],
  'Εκούσια Εκκαθάριση από Πιστωτές': ['active', "Creditors' voluntary liquidation", 'stop'],
  'Υπο Διαχείριση': ['active', 'Under administration', 'stop'],
  'Υπο Εκκαθάριση': ['active', 'In liquidation', 'stop'],
  'Υπο Διαχείριση & Υπο Εκκαθάριση': ['active', 'Under administration and in liquidation', 'stop'],
  'Διορισμός Προσωρινού Εκκαθαριστή': ['active', 'Provisional liquidator appointed', 'stop'],
};
const TYPE = { C: 'Company', O: 'Foreign company (branch)' };
const SUB = { 'Ιδιωτική': 'private', 'Δημόσια': 'public', 'Δι΄ Εγγυήσεως': 'limited by guarantee', 'Δι΄ Εγγυήσεως Χωρίς Κεφάλαιο': 'limited by guarantee without share capital' };
const ROLE = { 'Διευθυντής': 'Director', 'Γραμματέας': 'Secretary', 'Διευθύντρια': 'Director' };

const date = (s) => { const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(s || '').trim()); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
const clean = (s) => String(s || '').replace(/,\s*$/, '').trim();

function organisation(r) {
  if (!TYPE[r.ORGANISATION_TYPE_CODE] || !/^\d+$/.test(String(r.REGISTRATION_NO).trim())) return null;
  if (r.NAME_STATUS_CODE && r.NAME_STATUS_CODE !== 'ACR') return null; // keep the current name only
  const st = STATUS[String(r.ORGANISATION_STATUS).trim()] || ['active', String(r.ORGANISATION_STATUS).trim() || 'Unknown', null];
  return {
    country: 'CY',
    number: `${r.ORGANISATION_TYPE_CODE === 'O' ? 'AE' : 'HE'}${String(r.REGISTRATION_NO).trim()}`,
    name: clean(r.ORGANISATION_NAME),
    legal_form: [TYPE[r.ORGANISATION_TYPE_CODE], SUB[String(r.ORGANISATION_SUB_TYPE).trim()]].filter(Boolean).join(', '),
    status: st[0], status_label: st[1], flag: st[2],
    incorporated: date(r.REGISTRATION_DATE),
    status_date: date(r.ORGANISATION_STATUS_DATE),
    address_seq: String(r.ADDRESS_SEQ_NO || '').trim() || null,
  };
}

// Build everything in memory (the files total about 240 MB; the result is much smaller).
async function build({ organisations, offices, officials }) {
  const addr = new Map();
  for await (const r of records(offices)) {
    const a = [clean(r.STREET), clean(r.BUILDING), clean(r.TERRITORY)].filter(Boolean).join(', ');
    if (r.ADDRESS_SEQ_NO && a) addr.set(String(r.ADDRESS_SEQ_NO).trim(), a);
  }
  const out = new Map();
  for await (const r of records(organisations)) {
    const o = organisation(r);
    if (!o) continue;
    o.registered_address = o.address_seq ? addr.get(o.address_seq) || null : null;
    delete o.address_seq;
    o.officers = [];
    out.set(o.number, o);
  }
  if (officials) {
    for await (const r of records(officials)) {
      const key = `${r.ORGANISATION_TYPE_CODE === 'O' ? 'AE' : 'HE'}${String(r.REGISTRATION_NO).trim()}`;
      const o = out.get(key);
      if (o && r.PERSON_OR_ORGANISATION_NAME && o.officers.length < 25) o.officers.push({ name: clean(r.PERSON_OR_ORGANISATION_NAME), role: ROLE[String(r.OFFICIAL_POSITION).trim()] || clean(r.OFFICIAL_POSITION) });
    }
  }
  return [...out.values()];
}

module.exports = { build, organisation, STATUS };
