// Brazil: CNPJ register (Receita Federal) through BrasilAPI. Free, no key. Lookup by CNPJ only.
'use strict';
const { userAgent } = require('../ua');

const { getJson } = require('../http');
const { record } = require('./_common');
const index = require('../bulk/index');
const { publicBase } = require('../blob');

// BrasilAPI first; minhareceita.org (same open-source data and schema) if BrasilAPI refuses the request.
const SOURCES = ['https://brasilapi.com.br/api/cnpj/v1/', 'https://minhareceita.org/'];
const HEADERS = { 'User-Agent': userAgent() };
const title = (s) => (s ? String(s).toLowerCase().replace(/(^|\s)(\p{L})/gu, (m, a, b) => a + b.toUpperCase()) : s);

// 14 characters: 12 digits or letters (alphanumeric CNPJ from July 2026) and 2 check digits.
function normalise(n) {
  const s = String(n || '').toUpperCase().replace(/[\s./-]/g, '');
  return /^[0-9A-Z]{12}\d{2}$/.test(s) ? s : null;
}

// Name search across the ten Receita Federal index shards (BR0 ... BR9). Status is not in the index.
const SHARDS = [...Array(10).keys()].map((i) => `BR${i}`);
async function searchNames(fetchFn, q, env = process.env) {
  const b = publicBase(env.BLOB_READ_WRITE_TOKEN || '');
  if (!b) return [];
  const parts = await Promise.all(SHARDS.map((cc) => index.search(fetchFn, b, cc, q, 15).catch(() => null)));
  const hits = parts.filter(Boolean).flat();
  hits.sort((a, x) => a.name.length - x.name.length);
  return hits.slice(0, 20).map((h) => ({ number: h.number, name: h.name, status: null }));
}

async function fetchCnpj(fetchFn, cnpj) {
  let lastError = null;
  for (const base of SOURCES) {
    try {
      return await getJson(fetchFn, base + cnpj, { source: 'CNPJ (Brazil)', allow404: true, headers: HEADERS });
    } catch (e) { lastError = e; }
  }
  throw lastError;
}

async function search(fetchFn, q) {
  const cnpj = normalise(q);
  if (!cnpj) return /[a-z]/i.test(String(q)) ? searchNames(fetchFn, q) : [];
  const d = await fetchCnpj(fetchFn, cnpj);
  if (!d || !d.cnpj) return [];
  return [{ number: cnpj, name: d.razao_social, city: title(d.municipio), status: String(d.descricao_situacao_cadastral || '').toLowerCase(), incorporated: d.data_inicio_atividade || null }];
}

async function get(fetchFn, number) {
  const cnpj = normalise(number);
  if (!cnpj) return null;
  const d = await fetchCnpj(fetchFn, cnpj);
  if (!d || !d.cnpj) return null;
  const sit = String(d.descricao_situacao_cadastral || '').toUpperCase();
  const situations = [];
  if (d.situacao_especial && d.situacao_especial.trim()) {
    situations.push({ level: 'stop', label: title(d.situacao_especial.trim()), detail: `Special status on the CNPJ register: ${d.situacao_especial.trim()}${d.data_situacao_especial ? ' since ' + d.data_situacao_especial : ''}.` });
  }
  if (sit && sit !== 'ATIVA' && sit !== 'BAIXADA') {
    situations.push({ level: 'stop', label: `CNPJ status: ${title(sit)}`, detail: `The register shows "${sit}"${d.descricao_motivo_situacao_cadastral ? ' (' + d.descricao_motivo_situacao_cadastral + ')' : ''}.` });
  }
  const formatted = cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  return record({
    register: { name: 'CNPJ register (Receita Federal, Brazil)', number: formatted, url: 'https://solucoes.receita.fazenda.gov.br/servicos/cnpjreva/cnpjreva_solicitacao.asp' },
    legal_name: d.razao_social,
    other_names: d.nome_fantasia ? [d.nome_fantasia] : [],
    legal_form: d.natureza_juridica || null,
    status: sit === 'BAIXADA' ? 'inactive' : 'active',
    status_label: title(sit) + (d.data_situacao_cadastral ? ` since ${d.data_situacao_cadastral}` : ''),
    incorporated: d.data_inicio_atividade || null,
    registered_address: [[d.descricao_tipo_de_logradouro, d.logradouro, d.numero].filter(Boolean).join(' '), d.complemento, d.bairro, [d.cep, d.municipio].filter(Boolean).join(' '), d.uf, 'Brazil'].filter((x) => x && String(x).trim()).join(', '),
    industry: d.cnae_fiscal ? [{ code: String(d.cnae_fiscal), label: d.cnae_fiscal_descricao || 'CNAE' }] : [],
    size: d.porte || null,
    officers: (d.qsa || []).map((s) => ({ name: s.nome_socio, role: s.qualificacao_socio || null })),
    share_capital: d.capital_social ? `${Number(d.capital_social).toLocaleString('en')} BRL` : null,
    situations,
  });
}

module.exports = { country: 'BR', name: 'CNPJ (Brazil)', search, get, normalise };
