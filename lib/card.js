// Builds the company card and its warning flags from source data.
// Pure and deterministic: the same inputs and as-of date give the same card.
// Sources: GLEIF (global base) and, where connected, a national register (UK: Companies House).
'use strict';

const RULES = { youngCompanyMonths: 24, newDomainMonths: 12, recentChangeMonths: 12 };
const ACTIVE_STATUSES = new Set(['active', 'registered', 'open']);

// ---------- dates ----------

function parseDate(s) {
  if (!s || !/^\d{4}-\d{2}-\d{2}/.test(s)) return null;
  const [y, m, d] = s.slice(0, 10).split('-').map(Number);
  return { y, m, d, iso: s.slice(0, 10) };
}

// Whole calendar months from a to b (b >= a).
function monthsBetween(a, b) {
  let n = (b.y - a.y) * 12 + (b.m - a.m);
  if (b.d < a.d) n -= 1;
  return n;
}

function within(dateStr, asOf, months) {
  const d = parseDate(dateStr);
  if (!d) return false;
  if (d.iso > asOf.iso) return true;
  return monthsBetween(d, asOf) < months;
}

function ageText(dateStr, asOf) {
  const d = parseDate(dateStr);
  if (!d || d.iso > asOf.iso) return null;
  const m = monthsBetween(d, asOf);
  const y = Math.floor(m / 12);
  const r = m % 12;
  const pl = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (y === 0) return pl(m, 'month');
  return r === 0 ? pl(y, 'year') : `${pl(y, 'year')}, ${pl(r, 'month')}`;
}

// ---------- labels ----------

function pretty(s) {
  if (!s) return null;
  const t = String(s).replace(/[-_]/g, ' ').toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function ownershipBands(natures) {
  const out = [];
  for (const n of natures || []) {
    let m = n.match(/^ownership-of-shares-(\d+)-to-(\d+)-percent/);
    if (m) { out.push(`Shares ${m[1]}–${m[2]}%`); continue; }
    m = n.match(/^voting-rights-(\d+)-to-(\d+)-percent/);
    if (m) { out.push(`Votes ${m[1]}–${m[2]}%`); continue; }
    if (n.startsWith('right-to-appoint-and-remove')) { out.push('Appoints directors'); continue; }
    if (n.startsWith('significant-influence-or-control')) { out.push('Significant influence'); continue; }
  }
  return [...new Set(out)];
}

function chAddress(a) {
  if (!a) return null;
  return [a.care_of, a.po_box, a.premises, a.address_line_1, a.address_line_2, a.locality, a.region, a.postal_code, a.country]
    .filter(Boolean).join(', ') || null;
}

// ---------- card ----------

/**
 * @param g         normalised GLEIF record (lib/gleif.record) or null
 * @param gleifState 'ok' | 'none' (no LEI) | 'error'
 * @param ch        raw Companies House bundle (lib/sources.chCompany) or null
 * @param chState   'ok' | 'error' | 'not-connected' | 'not-applicable'
 * @param nat       normalised national register record (lib/registers/*.get) or null
 * @param natState  'ok' | 'error' | 'not-applicable'
 * @param natName   name of the national register (for gaps)
 * @param domain    { input, ok, data } or null
 */
function buildCard({ viesResult = null, viesState = 'not-applicable', wiki = null, wikiState = 'none', g = null, gleifState = 'none', ch = null, chState = 'not-applicable', nat = null, natState = 'not-applicable', natName = null, natCountry = null, domain = null, asOfIso }) {
  const asOf = parseDate(asOfIso);
  const p = ch ? ch.profile : null;
  const n = nat;
  const flags = [];
  const gaps = [];
  const sources = [];
  const flag = (level, label, detail, source) => flags.push({ level, label, detail, source });

  const country = (g && g.country) || (p ? 'GB' : natCountry) || null;
  const number = p ? p.company_number : n ? n.register.number : (g && g.registered_as) || null;

  // ---- identity: the national register wins on legal facts ----
  const previousNames = p ? (p.previous_company_names || []).map((x) => ({ name: x.name, from: x.effective_from || null, to: x.ceased_on || null })) : n ? n.former_names : [];
  const incorporated = (p && p.date_of_creation) || (n && n.incorporated) || (g && g.created) || null;
  const identity = {
    legal_name: (p && p.company_name) || (n && n.legal_name) || (g && g.legal_name),
    country,
    legal_form: p ? pretty(p.type) : (n && n.legal_form) || (g && g.legal_form) || null,
    status: p ? pretty(p.company_status) : n ? n.status_label : g ? pretty(g.status) : null,
    status_detail: p ? pretty(p.company_status_detail) : null,
    incorporated,
    incorporated_source: (p && p.date_of_creation) ? 'Companies House' : (n && n.incorporated) ? n.register.name : incorporated ? 'GLEIF' : null,
    age: ageText(incorporated, asOf),
    ceased: (p && p.date_of_cessation) || (n && n.ceased) || (g && g.expiration && g.expiration.date) || null,
    registered_address: (p && chAddress(p.registered_office_address)) || (n && n.registered_address) || (g && g.legal_address) || null,
    hq_address: g && g.hq_address && g.hq_address !== g.legal_address ? g.hq_address : null,
    sic_codes: p ? p.sic_codes || [] : [],
    industry: n ? n.industry.map((i) => (!i.code ? i.label : i.label && !/^(NAF|CZ-NACE)$/.test(i.label) ? `${i.code} ${i.label}` : `${i.code}${i.label ? ' (' + i.label + ')' : ''}`)) : [],
    other_names: [...new Set([...(g ? g.other_names : []), ...(n ? n.other_names : [])])],
    employees: n ? n.employees : null,
    size: n ? n.size : null,
    website: n ? n.website : null,
    vat: n ? n.vat : null,
    auditor: n ? n.auditor : null,
    share_capital: n && n.share_capital ? n.share_capital : null,
    extra: n && n.extra ? n.extra : [],
    sole_trader: !!(n && n.is_sole_trader),
    former_names: previousNames,
    register: p
      ? { name: 'Companies House (UK)', number, url: `https://find-and-update.company-information.service.gov.uk/company/${number}` }
      : n ? n.register
      : g && g.registered_as ? { name: g.registered_at ? `Registration authority ${g.registered_at}` : 'National register', number: g.registered_as, url: null } : null,
  };
  const ids = {
    lei: g ? g.lei : null,
    national: number,
    opencorporates: g && g.ocid ? `https://opencorporates.com/companies/${g.ocid}` : null,
    // Shares and bonds GLEIF links to the LEI (an issuer of listed or traded securities).
    isins: g && g.securities ? g.securities : null,
  };

  // ---- GLEIF section and flags ----
  if (gleifState === 'ok' && g) {
    sources.push({ name: 'GLEIF', result: `LEI ${g.lei}`, url: `https://search.gleif.org/#/record/${g.lei}` });
    if (!p && !n && g.status === 'INACTIVE') {
      const why = g.expiration && g.expiration.reason ? ` (${pretty(g.expiration.reason)}${g.expiration.date ? ', ' + g.expiration.date : ''})` : '';
      flag('stop', 'Not active', `GLEIF lists the entity as inactive${why}.`, 'GLEIF');
    }
    if (g.successor) {
      flag('check', 'Succeeded by another entity', `GLEIF names ${g.successor.name || g.successor.lei} as its successor, for example after a merger.`, 'GLEIF');
    }
    if (g.lei_status === 'LAPSED') {
      flag('note', 'LEI not renewed', `The LEI lapsed${g.lei_next_renewal ? ' after ' + g.lei_next_renewal : ''}, so GLEIF details may be out of date.`, 'GLEIF');
    }
    if (g.hq_country && g.country && g.hq_country !== g.country) {
      flag('note', 'Headquartered in another country', `Registered in ${g.country}, headquartered in ${g.hq_country}.`, 'GLEIF');
    }
    if (g.parent_errors) gaps.push('GLEIF parent links could not all be read.');
  } else if (gleifState === 'none') {
    sources.push({ name: 'GLEIF', result: 'No LEI (common for small companies)', url: 'https://search.gleif.org/' });
  } else if (gleifState === 'error') {
    gaps.push('GLEIF (global LEI register) could not be reached.');
  }
  let group = null;
  if (g) {
    const ex = g.direct_parent_exception || g.ultimate_parent_exception || null;
    group = {
      lei: g.lei, direct_parent: g.direct_parent, ultimate_parent: g.ultimate_parent,
      no_parent_reason: !g.direct_parent && ex ? ex.label : null,
      subsidiaries: g.direct_children && g.direct_children.total != null ? g.direct_children : null,
      all_subsidiaries_total: g.ultimate_children_total != null ? g.ultimate_children_total : null,
      group_size: g.group_size || null,
    };
    for (const [p, label] of [[g.direct_parent, 'Direct parent'], [g.ultimate_parent, 'Ultimate parent']]) {
      if (p && p.status && p.status !== 'active') flag('check', 'Parent company not active', `${label} ${p.name} is listed by GLEIF as ${p.status}.`, 'GLEIF');
    }
    if (!g.direct_parent && ex && ex.undisclosed) flag('note', 'Parent not disclosed', `GLEIF: ${ex.label.toLowerCase()}.`, 'GLEIF');
    if (g.direct_children && g.direct_children.error) gaps.push('GLEIF subsidiary links could not be read.');
  } else if (gleifState === 'none') {
    group = { lei: null };
  }

  // ---- national register (generic) ----
  let natFinancials = null;
  let natPeople = null;
  let natFilings = null;
  if (n) {
    const src = n.register.name;
    sources.push({ name: src, result: 'Found', url: n.register.url });
    if (n.status === 'inactive') flag('stop', 'Not active', `Status on the register is "${n.status_label}".`, src);
    for (const s of n.situations || []) flag(s.level, s.label, s.detail, src);
    const recent = (n.former_names || []).find((x) => x.to && within(x.to, asOf, RULES.recentChangeMonths));
    if (recent) flag('check', 'Recent name change', `Was "${recent.name}" until ${recent.to}.`, src);
    if (n.is_sole_trader) flag('note', 'Sole trader', 'This is a person trading in their own name. Only the register record is shown.', src);
    if (n.officers && !n.is_sole_trader) natPeople = { officers: n.officers, owners: null };
    if (n.officers === null && !n.is_sole_trader) gaps.push(`Officers are not published by the ${src} API.`);
    if (n.roles_missing) gaps.push(`Roles could not be read from ${src}.`);
    natFinancials = n.financials || null;
    if (n.last_accounts) natFilings = { last_accounts_year: n.last_accounts };
  } else if (natState === 'error') {
    gaps.push(`${natName || 'The national register'} could not be reached, so register details are missing.`);
  }

  // ---- national register (UK) ----
  if (chState === 'not-connected' && !n) {
    gaps.push(`The national register for ${country || 'this country'} is not connected yet, so filings, officers and owners are not shown.`);
  } else if (chState === 'error') {
    gaps.push('Companies House could not be reached, so UK register details are missing.');
  }

  let people = null; let filings = null; let charges = null;
  if (p) {
    sources.push({ name: 'Companies House', result: 'Found', url: identity.register.url });
    const status = p.company_status || null;
    if (status && !ACTIVE_STATUSES.has(status)) {
      flag('stop', 'Not active', `Status on the register is "${pretty(status)}".`, 'Companies House');
    } else if (p.company_status_detail && /strike-off/.test(p.company_status_detail)) {
      flag('stop', 'Strike-off proposed', `The register shows "${pretty(p.company_status_detail)}".`, 'Companies House');
    }
    if (p.has_insolvency_history) {
      const cases = ch.insolvency && ch.insolvency.ok && ch.insolvency.data ? ch.insolvency.data.cases || [] : [];
      const types = [...new Set(cases.map((c) => pretty(c.type)).filter(Boolean))];
      flag('stop', 'Insolvency history', types.length ? `Insolvency case on the register: ${types.join(', ')}.` : 'The register shows an insolvency history.', 'Companies House');
    }
    const recentName = previousNames.find((n) => n.to && within(n.to, asOf, RULES.recentChangeMonths));
    if (recentName) flag('check', 'Recent name change', `Was "${recentName.name}" until ${recentName.to}.`, 'Companies House');

    const acc = p.accounts || {};
    const cs = p.confirmation_statement || {};
    const accountsOverdue = acc.overdue === true || (acc.next_due && acc.next_due < asOf.iso);
    const csOverdue = cs.overdue === true || (cs.next_due && cs.next_due < asOf.iso);
    filings = {
      last_accounts_made_up_to: acc.last_accounts && acc.last_accounts.made_up_to ? acc.last_accounts.made_up_to : null,
      last_accounts_type: acc.last_accounts ? pretty(acc.last_accounts.type) : null,
      next_accounts_due: acc.next_due || null,
      accounts_overdue: !!accountsOverdue,
      next_confirmation_statement_due: cs.next_due || null,
      confirmation_statement_overdue: !!csOverdue,
    };
    if (accountsOverdue) flag('check', 'Accounts overdue', `Accounts were due by ${acc.next_due || 'an earlier date'}.`, 'Companies House');
    if (csOverdue) flag('check', 'Confirmation statement overdue', `It was due by ${cs.next_due || 'an earlier date'}.`, 'Companies House');

    if (ch.officers && ch.officers.ok) {
      const items = (ch.officers.data && ch.officers.data.items) || [];
      people = { officers: items.filter((o) => !o.resigned_on).map((o) => ({ name: o.name, role: pretty(o.officer_role), appointed: o.appointed_on || null })), owners: null };
    } else {
      gaps.push('Officers could not be read from Companies House.');
    }
    if (ch.psc && ch.psc.ok) {
      const items = (ch.psc.data && ch.psc.data.items) || [];
      const owners = items.filter((o) => !o.ceased_on && !/statement/.test(o.kind || ''))
        .map((o) => ({ name: o.name, kind: /corporate|legal-person/.test(o.kind || '') ? 'Company' : 'Person', control: ownershipBands(o.natures_of_control) }));
      if (people) people.owners = owners; else people = { officers: null, owners };
    } else {
      gaps.push('Owners (people with significant control) could not be read from Companies House.');
    }

    charges = { outstanding: 0, total: 0, recent: [], lenders: [] };
    if (p.has_charges) {
      if (ch.charges && ch.charges.ok && ch.charges.data) {
        const items = ch.charges.data.items || [];
        const outstanding = items.filter((c) => c.status === 'outstanding' || c.status === 'part-satisfied');
        const recent = outstanding.filter((c) => within(c.created_on || c.delivered_on, asOf, RULES.recentChangeMonths))
          .map((c) => ({ created: c.created_on || c.delivered_on, lender: (c.persons_entitled || []).map((x) => x.name).join(', ') || null }));
        charges = { outstanding: outstanding.length, total: items.length, recent,
          lenders: [...new Set(outstanding.flatMap((c) => (c.persons_entitled || []).map((x) => x.name)))] };
        if (recent.length) flag('note', 'New secured lending', `${recent.length} charge${recent.length === 1 ? '' : 's'} registered in the last ${RULES.recentChangeMonths} months.`, 'Companies House');
      } else {
        charges = null;
        gaps.push('Charges (secured lending) could not be read from Companies House.');
      }
    }
  }

  if (!p) {
    people = natPeople;
    filings = natFilings;
  }

  // ---- shared rules ----
  if (incorporated && within(incorporated, asOf, RULES.youngCompanyMonths)) {
    flag('check', 'Young company', `Incorporated ${incorporated}, less than ${RULES.youngCompanyMonths} months ago.`, p ? 'Companies House' : 'GLEIF');
  }
  if (!incorporated) gaps.push('Incorporation date not available, so company age was not checked.');

  // ---- EU VAT check (VIES) ----
  if (viesState === 'ok' && viesResult) {
    identity.vat = { ...(identity.vat || {}), number: viesResult.vat, vies: { valid: viesResult.valid, name: viesResult.name, checked: viesResult.checked } };
    sources.push({ name: 'VIES (EU VAT check)', result: viesResult.valid ? 'Valid' : 'Not valid', url: 'https://ec.europa.eu/taxation_customs/vies/' });
    if (viesResult.valid === false) flag('check', 'VAT number not valid', `VIES reports ${viesResult.vat} as not valid on ${viesResult.checked || asOf.iso}.`, 'VIES');
  } else if (viesState === 'unavailable' || viesState === 'error') {
    gaps.push('The EU VAT check (VIES) was unavailable for this country, so the VAT number was not confirmed.');
  }

  // ---- Wikidata (enrichment only; never decides a flag) ----
  let about = null;
  if (wiki) {
    sources.push({ name: 'Wikidata', result: wiki.label || wiki.qid, url: wiki.url });
    about = {
      wikipedia: wiki.wikipedia, founded: wiki.founded, hq: wiki.hq, industries: wiki.industries,
      employees: wiki.employees, listings: wiki.listings, parents: wiki.parents, subsidiaries: wiki.subsidiaries || [], website: wiki.website,
    };
    if (!identity.website && wiki.website) identity.website = wiki.website;
    // An English name from Wikidata helps with registers in other scripts (e.g. Taiwan, Israel).
    if (wiki.label && identity.legal_name && wiki.label !== identity.legal_name && !identity.other_names.includes(wiki.label)) identity.other_names.push(wiki.label);
  } else if (wikiState === 'error') {
    gaps.push('Wikidata could not be reached, so website, listing and headquarters details may be missing.');
  }

  // ---- web ----
  let web = null;
  if (domain && domain.input) {
    if (!domain.ok) {
      gaps.push(`Domain records for ${domain.input} could not be checked.`);
    } else if (!domain.data.found) {
      web = { domain: domain.input, from: domain.from || 'entered', registered: null };
      gaps.push(domain.data.no_rdap
        ? `The registry for .${domain.input.split('.').pop()} domains publishes no registration dates (RDAP), so the age of ${domain.input} was not checked.`
        : `No domain record found for ${domain.input}.`);
    } else {
      web = { domain: domain.input, from: domain.from || 'entered', registered: domain.data.registered, age: ageText(domain.data.registered, asOf) };
      sources.push({ name: 'RDAP domain records', result: 'Found', url: `https://rdap.org/domain/${domain.input}` });
      if (domain.data.registered && within(domain.data.registered, asOf, RULES.newDomainMonths)) {
        flag('check', 'New website domain', `${domain.input} was registered ${domain.data.registered}, less than ${RULES.newDomainMonths} months ago.`, 'RDAP');
      }
    }
  } else {
    gaps.push('No website entered or found, so domain age was not checked.');
  }
  gaps.push('News and web presence are not checked yet.');

  // One flag per label; Stop before Check before Note.
  const order = { stop: 0, check: 1, note: 2 };
  const seen = new Set();
  const uniq = flags.filter((f) => (seen.has(f.label) ? false : seen.add(f.label)));
  uniq.sort((a, b) => order[a.level] - order[b.level]);

  const nextStep = filings && filings.last_accounts_made_up_to
    ? `Accounts made up to ${filings.last_accounts_made_up_to} are on file at Companies House, so a financial summary is possible.`
    : filings && filings.last_accounts_year
      ? `Annual accounts for ${filings.last_accounts_year} are filed with the ${n.register.name}, so a financial summary is possible.`
      : 'Ask the company for its latest filed or management accounts before setting a limit.';
  const parentForGuarantee = group && group.direct_parent && group.direct_parent.status !== 'inactive' ? group.direct_parent : null;
  const groupStep = parentForGuarantee
    ? ` It belongs to a group (direct parent: ${parentForGuarantee.name}); for a larger limit, consider asking the parent for a guarantee or comfort letter, and check the parent too.`
    : '';

  return {
    as_of: asOf.iso,
    identity, ids, group, people, filings, charges, web,
    financials: natFinancials,
    about,
    flags: uniq,
    verdict: uniq.some((f) => f.level === 'stop') ? 'stop' : uniq.some((f) => f.level === 'check') ? 'check' : 'clear',
    sources, gaps,
    next_step: nextStep + groupStep,
    rules: RULES,
  };
}

module.exports = { buildCard, monthsBetween, parseDate, within, ownershipBands, RULES };
