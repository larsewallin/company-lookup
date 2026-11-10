// The same import endpoint, deployed in Frankfurt (fra1, see vercel.json) for registers that refuse or time out
// from the US region (e.g. data.gov.ro). Writes to the same Blob store.
'use strict';

module.exports = require('./bulk-import');
