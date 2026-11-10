// National registers connected so far (no key needed). The UK (Companies House) is handled separately.
'use strict';

const list = [require('./fr'), require('./no'), require('./fi'), require('./ee'), require('./cz'), require('./pl'),
  require('./us'), require('./sk'), require('./br'), require('./il'), require('./lv'), require('./tw'), require('./sg'), require('./ch'), require('./ie'), require('./au'), require('./co'), require('./cy'), require('./ca'), require('./ar'), require('./si'), require('./cl'), require('./pe'), require('./ua'), require('./hk'), require('./in'), require('./do'), require('./ec'), require('./py'), require('./ru'), require('./md'), require('./nc'), require('./ro'), require('./lu')];
const byCountry = Object.fromEntries(list.map((r) => [r.country, r]));

module.exports = { byCountry, countries: list.map((r) => r.country) };
