// Norway: Brønnøysund Register Centre (Enhetsregisteret). Free, no key.
// https://data.brreg.no/enhetsregisteret/api
'use strict';

const { getJson } = require('../http');

const BASE = 'https://data.brreg.no/enhetsregisteret/api/enheter';

const ROLES = {
  DAGL: 'CEO', LEDE: 'Chair', NEST: 'Deputy chair', MEDL: 'Board member', VARA: 'Deputy board member', OBS: 'Observer',
  REVI: 'Auditor', REGN: 'Accountant', KONT: 'Contact person', INNH: 'Owner', DTPR: 'Partner', DTSO: 'Partner', KOMP: 'General partner',
  FFØR: 'Business manager', SAM: 'Joint owner', BEST: 'Managing shipowner',
};

function normalise(n) {
  const s = String(n || '').replace(/\D/g, '');
  return /^\d{9}$/.test(s) ? s : null;
}

function addr(a) {
  if (!a) return null;
  return [...(a.adresse || []), [a.postnummer, a.poststed].filter(Boolean).join(' '), a.land].filter(Boolean).join(', ') || null;
}

async function search(fetchFn, q) {
  const data = await getJson(fetchFn, `${BASE}?navn=${encodeURIComponent(q)}&size=15`, { source: 'Brønnøysund' });
  return ((data && data._embedded && data._embedded.enheter) || []).map((e) => ({
    number: e.organisasjonsnummer,
    name: e.navn,
    city: e.forretningsadresse ? e.forretningsadresse.poststed : null,
    status: e.konkurs ? 'bankrupt' : e.underAvvikling || e.underTvangsavviklingEllerTvangsopplosning ? 'being wound up' : e.slettedato ? 'deleted' : 'active',
    incorporated: e.stiftelsesdato || null,
  }));
}

// Norwegian AS/ASA must file annual accounts by 31 July for the previous year.
function accountsExpectedYear(asOfIso) {
  const y = Number(asOfIso.slice(0, 4));
  const m = Number(asOfIso.slice(5, 7));
  return m >= 8 ? y - 1 : y - 2;
}

async function get(fetchFn, number, { asOfIso } = {}) {
  const nr = normalise(number);
  if (!nr) return null;
  const [e, roles] = await Promise.all([
    getJson(fetchFn, `${BASE}/${nr}`, { source: 'Brønnøysund', allow404: true }),
    getJson(fetchFn, `${BASE}/${nr}/roller`, { source: 'Brønnøysund', allow404: true }).catch(() => undefined),
  ]);
  if (!e) return null;

  const situations = [];
  if (e.konkurs) situations.push({ level: 'stop', label: 'Bankruptcy', detail: 'The register shows the company is in bankruptcy (konkurs).' });
  if (e.underAvvikling) situations.push({ level: 'stop', label: 'Being wound up', detail: 'The register shows the company is being wound up (under avvikling).' });
  if (e.underTvangsavviklingEllerTvangsopplosning) situations.push({ level: 'stop', label: 'Compulsory dissolution', detail: 'The register shows compulsory winding up or dissolution.' });
  const form = e.organisasjonsform ? e.organisasjonsform.kode : null;
  if ((form === 'AS' || form === 'ASA') && asOfIso && !e.slettedato) {
    const expected = accountsExpectedYear(asOfIso);
    const last = e.sisteInnsendteAarsregnskap ? Number(e.sisteInnsendteAarsregnskap) : null;
    const created = e.stiftelsesdato ? Number(e.stiftelsesdato.slice(0, 4)) : null;
    if ((last === null && created !== null && created < expected) || (last !== null && last < expected)) {
      situations.push({ level: 'check', label: 'Accounts overdue', detail: `Annual accounts for ${expected} were due by 31 July ${expected + 1}; the latest filed is ${last || 'none'}.` });
    }
  }

  const officers = []; let auditor = null;
  if (roles && roles.rollegrupper) {
    for (const g of roles.rollegrupper) {
      for (const r of g.roller || []) {
        if (r.avregistrert || r.fratraadt) continue;
        const code = r.type && r.type.kode;
        const role = ROLES[code] || (r.type && r.type.beskrivelse) || null;
        const name = r.person && r.person.navn
          ? [r.person.navn.fornavn, r.person.navn.mellomnavn, r.person.navn.etternavn].filter(Boolean).join(' ')
          : r.enhet && r.enhet.navn ? [].concat(r.enhet.navn).join(' ') : null;
        if (!name) continue;
        if (code === 'REVI') auditor = name;
        else officers.push({ name, role });
      }
    }
  }

  const deleted = !!e.slettedato;
  return {
    register: { name: 'Brønnøysund Register Centre (Norway)', number: nr, url: `https://virksomhet.brreg.no/nb/oppslag/enheter/${nr}` },
    legal_name: e.navn,
    other_names: [],
    former_names: (e.historiskeNavn || []).map((n) => ({ name: n.navn, to: n.tilDato ? String(n.tilDato).slice(0, 10) : null })),
    legal_form: e.organisasjonsform ? `${e.organisasjonsform.beskrivelse} (${form})` : null,
    status: deleted ? 'inactive' : 'active',
    status_label: deleted ? `Deleted ${e.slettedato}` : e.konkurs ? 'Bankrupt' : e.underAvvikling ? 'Being wound up' : 'Active',
    incorporated: e.stiftelsesdato || e.registreringsdatoEnhetsregisteret || null,
    ceased: e.slettedato || null,
    registered_address: addr(e.forretningsadresse),
    industry: [e.naeringskode1, e.naeringskode2, e.naeringskode3].filter(Boolean).map((n) => ({ code: n.kode, label: n.beskrivelse })),
    employees: e.harRegistrertAntallAnsatte && e.antallAnsatte != null ? String(e.antallAnsatte) : null,
    size: null,
    website: e.hjemmeside || null,
    vat: { number: e.registrertIMvaregisteret ? `NO${nr}MVA` : null, registered: !!e.registrertIMvaregisteret },
    officers,
    auditor,
    financials: null,
    last_accounts: e.sisteInnsendteAarsregnskap || null,
    situations,
    is_sole_trader: form === 'ENK',
    roles_missing: roles === undefined,
  };
}

module.exports = { country: 'NO', name: 'Brønnøysund (Norway)', search, get, normalise, accountsExpectedYear };
