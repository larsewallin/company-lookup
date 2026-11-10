// User-Agent sent to every source. Registers ask automated clients to identify themselves:
// set COMPANY_LOOKUP_USER_AGENT to your own app name and a contact (SEC EDGAR requires an e-mail address).
'use strict';
const DEFAULT = 'company-lookup/1.0 (+https://github.com/larsewallin/company-lookup)';
const userAgent = () => process.env.COMPANY_LOOKUP_USER_AGENT || DEFAULT;
module.exports = { userAgent, DEFAULT };
