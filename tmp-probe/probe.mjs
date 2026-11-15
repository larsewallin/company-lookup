// Temporary: used during development to capture fixtures. Removed before merge.
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { createOverture } = require('../lib/overture.js');
const [mode, ...args] = process.argv.slice(2);
const strip = (r) => { const o = { ...r }; if (o.names) o.names = { primary: o.names.primary, common: null, rules: null }; return o; };
const big = (k, v) => (typeof v === 'bigint' ? Number(v) : v);
if (mode === 'rows') {
  const ov = createOverture();
  const out = [];
  for (const a of args) {
    const [id, lon, lat] = a.split(',');
    const t = Date.now();
    const r = await ov.place(id, lon ? { lon: Number(lon), lat: Number(lat) } : {});
    console.error(id, r ? 'found' : 'MISSING', Date.now() - t, 'ms');
    if (r) out.push({ release: r.release, row: strip(r.row) });
  }
  fs.writeFileSync('/vercel/probe/rows.json', JSON.stringify(out, big));
} else if (mode === 'show') {
  const out = JSON.parse(fs.readFileSync('/vercel/probe/rows.json', 'utf8'));
  console.log(JSON.stringify(out[Number(args[0])]));
}
