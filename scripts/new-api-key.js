#!/usr/bin/env node
// Makes a new API key for a trusted caller of the /v1/ routes.
//
//   node scripts/new-api-key.js <name>
//
// Prints two things:
//   1. the key: give it to the caller (e.g. as their COMPANY_LOOKUP_API_KEY). It is shown only once.
//   2. the `name:hash` line: add it to COMPANY_LOOKUP_API_KEYS on the Company Lookup deployment,
//      separated from other entries by a comma. Only the hash is stored there, never the key.
//
// Never commit a key, paste it in chat or tickets, or log it.
'use strict';
const crypto = require('crypto');

const name = process.argv[2];
if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
  console.error('Usage: node scripts/new-api-key.js <name>   (letters, digits, . _ -; e.g. trade-credit-monitor)');
  process.exit(1);
}
const key = 'cl_' + crypto.randomBytes(32).toString('base64url');
const hash = crypto.createHash('sha256').update(key, 'utf8').digest('hex');
console.log(`Key for ${name} (give it to the caller; shown only once):`);
console.log(key);
console.log('');
console.log('Add this to COMPANY_LOOKUP_API_KEYS:');
console.log(`${name}:${hash}`);
