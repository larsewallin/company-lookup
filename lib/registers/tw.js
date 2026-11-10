// Taiwan: company registration open data (MOEA, GCIS). Free, no key.
// Name search works with Chinese company names; any company can be looked up by its 8-digit UBN.
'use strict';

const { getJson } = require('../http');
const { record, digits } = require('./_common');

const BASE = 'https://data.gcis.nat.gov.tw/od/data/api';
const BY_NAME = '6BBA2268-1367-4B42-9CCA-BC17499EBE8C';
const BY_UBN = '5F64D864-61CB-4D0D-8AD9-492047CC1EA6';

const normalise = (n) => { const s = digits(n); return /^\d{8}$/.test(s) ? s : null; };
// ROC calendar date "0760221" → 1987-02-21.
const roc = (s) => { const m = String(s || '').match(/^(\d{3})(\d{2})(\d{2})$/); return m ? `${Number(m[1]) + 1911}-${m[2]}-${m[3]}` : null; };
const STATUS = [[/核准設立/, 'Active'], [/停業/, 'Suspended'], [/解散/, 'Dissolved'], [/撤銷/, 'Revoked'], [/廢止/, 'Annulled'], [/破產/, 'Bankrupt'], [/合併/, 'Merged']];
const statusEn = (s) => { for (const [re, en] of STATUS) if (re.test(s || '')) return en; return s || 'Unknown'; };

const odata = (guid, filter, top = 15) => `${BASE}/${guid}?$format=json&$filter=${encodeURIComponent(filter)}&$skip=0&$top=${top}`;

async function search(fetchFn, q) {
  const n = normalise(q);
  if (n && /^\s*\d+\s*$/.test(q)) {
    const r = await get(fetchFn, n);
    return r ? [{ number: n, name: r.legal_name, city: null, status: r.status === 'active' ? 'active' : r.status_label.toLowerCase(), incorporated: r.incorporated }] : [];
  }
  if (!/[一-鿿]/.test(q)) return []; // the register only holds Chinese names
  const d = await getJson(fetchFn, odata(BY_NAME, `Company_Name like ${q.replace(/[^一-鿿\w]/g, '')}`), { source: 'GCIS (Taiwan)' });
  return (Array.isArray(d) ? d : []).map((r) => ({ number: r.Business_Accounting_NO, name: r.Company_Name, city: null,
    status: statusEn(r.Company_Status_Desc) === 'Active' ? 'active' : statusEn(r.Company_Status_Desc).toLowerCase(), incorporated: roc(r.Company_Setup_Date) }));
}

async function get(fetchFn, number) {
  const n = normalise(number);
  if (!n) return null;
  const d = await getJson(fetchFn, odata(BY_UBN, `Business_Accounting_NO eq ${n}`, 1), { source: 'GCIS (Taiwan)' });
  const r = Array.isArray(d) ? d[0] : null;
  if (!r) return null;
  const st = statusEn(r.Company_Status_Desc);
  const situations = [];
  if (st === 'Suspended' || r.Sus_Beg_Date) situations.push({ level: 'stop', label: 'Business suspended', detail: `The register shows a suspension${r.Sus_Beg_Date ? ' from ' + roc(r.Sus_Beg_Date) : ''}${r.Sus_End_Date ? ' to ' + roc(r.Sus_End_Date) : ''}.` });
  if (st === 'Bankrupt') situations.push({ level: 'stop', label: 'Bankruptcy', detail: 'The register shows the company as bankrupt.' });
  return record({
    register: { name: 'Company register (MOEA, Taiwan)', number: n, url: `https://findbiz.nat.gov.tw/fts/query/QueryList/queryList.do?qryCond=${n}` },
    legal_name: r.Company_Name,
    status: ['Active', 'Suspended', 'Bankrupt'].includes(st) ? 'active' : 'inactive',
    status_label: `${st} (${r.Company_Status_Desc})`,
    incorporated: roc(r.Company_Setup_Date),
    ceased: roc(r.Revoke_App_Date),
    registered_address: r.Company_Location ? `${r.Company_Location}, Taiwan` : null,
    officers: r.Responsible_Name ? [{ name: r.Responsible_Name, role: 'Representative' }] : [],
    share_capital: r.Paid_In_Capital_Amount ? `${Number(r.Paid_In_Capital_Amount).toLocaleString('en')} TWD paid-in` : null,
    extra: [r.Register_Organization_Desc ? ['Registered with', r.Register_Organization_Desc] : null, r.Change_Of_Approval_Data ? ['Last change approved', roc(r.Change_Of_Approval_Data)] : null].filter(Boolean),
    situations,
  });
}

module.exports = { country: 'TW', name: 'Company register (Taiwan)', search, get, normalise };
