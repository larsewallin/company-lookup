// France: Recherche d'entreprises (data from INSEE SIRENE and the RNE). Free, no key.
// https://recherche-entreprises.api.gouv.fr
'use strict';

const { getJson } = require('../http');

const BASE = 'https://recherche-entreprises.api.gouv.fr/search';

const FORMS = {
  '1000': 'Sole trader (entrepreneur individuel)', '5499': 'SARL', '5498': 'EURL', '5710': 'SAS', '5720': 'SASU',
  '5599': 'SA (board of directors)', '5699': 'SA (management board)', '5306': 'SNC', '5202': 'SNC', '6540': 'SCI (property company)',
  '9220': 'Association', '5785': 'SELAS', '5485': 'SELARL', '6533': 'GAEC', '6316': 'Cooperative (CUMA)',
};
const STAFF = {
  NN: null, '00': '0', '01': '1–2', '02': '3–5', '03': '6–9', '11': '10–19', '12': '20–49', '21': '50–99', '22': '100–199',
  '31': '200–249', '32': '250–499', '41': '500–999', '42': '1,000–1,999', '51': '2,000–4,999', '52': '5,000–9,999', '53': '10,000+',
};
const SIZE = { PME: 'Small or medium (PME)', ETI: 'Mid-sized (ETI)', GE: 'Large (GE)' };

function normalise(n) {
  const s = String(n || '').replace(/\D/g, '');
  if (s.length === 14) return s.slice(0, 9); // SIRET → SIREN
  return /^\d{9}$/.test(s) ? s : null;
}

// French VAT number derives from the SIREN.
function vatFromSiren(siren) {
  const key = (12 + 3 * (Number(siren) % 97)) % 97;
  return `FR${String(key).padStart(2, '0')}${siren}`;
}

async function search(fetchFn, q) {
  const data = await getJson(fetchFn, `${BASE}?q=${encodeURIComponent(q)}&per_page=15`, { source: 'French register' });
  return ((data && data.results) || []).map((r) => ({
    number: r.siren,
    name: r.nom_complet || r.nom_raison_sociale,
    city: r.siege ? r.siege.libelle_commune : null,
    status: r.etat_administratif === 'A' ? 'active' : 'ceased',
    incorporated: r.date_creation || null,
  }));
}

async function get(fetchFn, number) {
  const siren = normalise(number);
  if (!siren) return null;
  const data = await getJson(fetchFn, `${BASE}?q=${siren}&per_page=5`, { source: 'French register' });
  const r = ((data && data.results) || []).find((x) => x.siren === siren);
  if (!r) return null;
  const sole = r.nature_juridique === '1000' || (r.complements && r.complements.est_entrepreneur_individuel);
  const active = r.etat_administratif === 'A';
  let fin = null;
  if (r.finances && typeof r.finances === 'object') {
    const years = Object.keys(r.finances).sort();
    const y = years[years.length - 1];
    if (y) fin = { year: y, revenue: r.finances[y].ca ?? null, net_result: r.finances[y].resultat_net ?? null, currency: 'EUR' };
  }
  return {
    register: { name: 'French business register (SIRENE / RNE)', number: siren, url: `https://annuaire-entreprises.data.gouv.fr/entreprise/${siren}` },
    legal_name: r.nom_raison_sociale || r.nom_complet,
    other_names: [r.sigle, r.siege && r.siege.nom_commercial].filter(Boolean),
    former_names: [],
    legal_form: FORMS[r.nature_juridique] || (r.nature_juridique ? `Legal form code ${r.nature_juridique}` : null),
    status: active ? 'active' : 'inactive',
    status_label: active ? 'Active' : 'Ceased',
    incorporated: r.date_creation || null,
    ceased: r.date_fermeture || null,
    registered_address: r.siege ? r.siege.adresse : null,
    industry: r.activite_principale ? [{ code: r.activite_principale, label: 'NAF' }] : [],
    employees: STAFF[r.tranche_effectif_salarie] || null,
    size: SIZE[r.categorie_entreprise] || null,
    website: null,
    vat: { number: vatFromSiren(siren), registered: null },
    officers: sole ? [] : (r.dirigeants || []).map((d) => ({
      name: d.type_dirigeant === 'personne morale' ? d.denomination : [d.prenoms, d.nom].filter(Boolean).join(' '),
      role: d.qualite || null,
    })),
    auditor: null,
    financials: fin,
    last_accounts: fin ? fin.year : null,
    situations: [],
    is_sole_trader: !!sole,
  };
}

module.exports = { country: 'FR', name: 'French business register', search, get, normalise, vatFromSiren };
