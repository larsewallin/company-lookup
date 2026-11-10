#!/usr/bin/env node
// Usage: node lib/bulk/build-cy.js organisations.csv registered_office.csv organisation_officials.csv > cy.ndjson
// Files: https://www.data.gov.cy/en/dataset/1026 (monthly). Writes one JSON record per line.
'use strict';
const fs = require('fs');
const cy = require('./cy');

const [org, ro, off] = process.argv.slice(2);
if (!org || !ro) { console.error('Usage: build-cy.js organisations.csv registered_office.csv [organisation_officials.csv]'); process.exit(2); }
const open = (p) => fs.createReadStream(p, { encoding: 'utf8', highWaterMark: 1 << 20 });
cy.build({ organisations: open(org), offices: open(ro), officials: off ? open(off) : null }).then((list) => {
  for (const r of list) process.stdout.write(JSON.stringify(r) + '\n');
  const active = list.filter((r) => r.status === 'active').length;
  console.error(`Cyprus: ${list.length} companies (${active} active)`);
}).catch((e) => { console.error(e); process.exit(1); });
