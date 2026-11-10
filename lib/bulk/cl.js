// Chile: Registro de Empresas y Sociedades ("Empresa en un Día", Ministerio de Economía) on datos.gob.cl:
// one semicolon-separated CSV per year of actions since 2013. Layout checked on 2026-11-08:
// ID; RUT; Razon Social; Fecha de actuacion (1era firma); Fecha de registro (ultima firma); Fecha de aprobacion x SII;
// Anio; Mes; Comuna Tributaria; Region Tributaria; Codigo de sociedad; Tipo de actuacion; Capital; Comuna Social; Region Social
// Covers companies formed through the online register only (not those formed before 2013 or through notaries).
// A later action of type DISOLUCIÓN marks the company dissolved.
'use strict';

const { records } = require('./csv');

const FORMS = { SRL: 'Sociedad de responsabilidad limitada', SpA: 'Sociedad por acciones', EIRL: 'Empresa individual de responsabilidad limitada',
  SA: 'Sociedad anónima', SCS: 'Sociedad en comandita simple', SCPA: 'Sociedad en comandita por acciones', SC: 'Sociedad colectiva', COOP: 'Cooperativa' };
const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const date = (s) => { const m = /^(\d{2})-(\d{2})-(\d{4})/.exec(clean(s)); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
const rutDigits = (s) => clean(s).toUpperCase().replace(/[^0-9K]/g, '');

// Collects all files, then emits one record per RUT (later actions update earlier ones).
function createCollector() {
  const byRut = new Map();
  return {
    async addFile(chunks) {
      let n = 0;
      for await (const r of records(chunks, ';')) {
        const rut = rutDigits(r.RUT); if (rut.length < 8) continue;
        const action = clean(r['Tipo de actuacion']).toUpperCase();
        const when = date(r['Fecha de registro (ultima firma)']) || date(r['Fecha de actuacion (1era firma)']);
        let c = byRut.get(rut);
        if (!c) { c = { rut }; byRut.set(rut, c); }
        if (action.startsWith('CONSTITU')) {
          c.name = clean(r['Razon Social']) || c.name; c.form = clean(r['Codigo de sociedad']) || c.form; c.formed = when || c.formed;
          c.capital = clean(r.Capital) || c.capital; c.comuna = clean(r['Comuna Social']) || clean(r['Comuna Tributaria']) || c.comuna;
        } else if (action.startsWith('DISOLU')) { c.dissolved = when || 'yes'; }
        else if (action.startsWith('MODIFIC') && clean(r['Razon Social'])) { c.name = clean(r['Razon Social']); c.modified = when; }
        n++;
      }
      return n;
    },
    * records() {
      for (const c of byRut.values()) {
        if (!c.name) continue;
        const rut = `${c.rut.slice(0, -1)}-${c.rut.slice(-1)}`;
        const out = { number: rut, name: c.name, status: c.dissolved ? 'inactive' : 'active',
          status_label: c.dissolved ? 'Dissolved (Registro de Empresas y Sociedades)' : 'Registered (Registro de Empresas y Sociedades)',
          legal_form: FORMS[c.form] || c.form || null, incorporated: c.formed || null };
        if (c.dissolved && c.dissolved !== 'yes') out.status_date = c.dissolved;
        if (c.comuna) out.registered_address = `${c.comuna}, Chile`;
        if (c.capital && /^\d+$/.test(c.capital)) out.capital = Number(c.capital);
        yield out;
      }
    },
    get size() { return byRut.size; },
  };
}

module.exports = { createCollector, rutDigits };
