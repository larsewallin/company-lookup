#!/usr/bin/env node
// Builds the presence-data word index for one country from scripts/places/extract.sql output, as packs:
//   node scripts/places/build.js <CC> <extract dir> <out dir> <overture release>
// Writes <out>/<cc>-<n>.ndjson.gz (each line: [path, json text]) and <out>/<cc>-meta.json.
// Large countries are built in several passes over the input, each covering a slice of the word buckets,
// so memory stays bounded (see createBuilder in lib/bulk/index.js).
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const index = require('../../lib/bulk/index');
const places = require('../../lib/places');

async function main() {
  const [cc, dir, out, release] = process.argv.slice(2);
  if (!places.PILOT.includes(cc) || !dir || !out || !release) {
    console.error('Usage: node scripts/places/build.js <CC> <extract dir> <out dir> <release>'); process.exit(1);
  }
  const inDir = path.join(dir, `cc=${cc}`);
  const inputs = fs.readdirSync(inDir).filter((f) => f.endsWith('.json')).map((f) => path.join(inDir, f));
  const bytes = inputs.reduce((a, f) => a + fs.statSync(f).size, 0);
  // About 1.25x the extract ends up in the index; aim for s/ files under ~700 KB.
  const sBuckets = Math.min(8192, Math.max(64, 2 ** Math.ceil(Math.log2((bytes * 1.25) / 700e3))));
  const passes = Math.max(1, Math.ceil(bytes / 500e6));
  fs.mkdirSync(out, { recursive: true });
  console.log(`${cc}: ${(bytes / 1e6).toFixed(0)} MB extract, ${sBuckets} word buckets, ${passes} pass(es)`);

  let count = 0; let nFiles = 0; let nPack = 0; const split = new Set();
  let cur = []; let curBytes = 0;
  const flush = () => {
    if (!cur.length) return;
    fs.writeFileSync(path.join(out, `${cc.toLowerCase()}-${nPack++}.ndjson.gz`), places.encodePack(cur));
    cur = []; curBytes = 0;
  };
  for (let p = 0; p < passes; p++) {
    const from = Math.floor((sBuckets * p) / passes); const to = Math.floor((sBuckets * (p + 1)) / passes);
    const b = index.createBuilder({ sBuckets, only: 's', sRange: [from, to], rowOf: places.rowOf });
    for (const f of inputs) {
      const rl = readline.createInterface({ input: fs.createReadStream(f), crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line) continue;
        const o = JSON.parse(line);
        if (!o.id || !o.name) continue;
        b.add(places.toRecord(o));
      }
    }
    count = b.count;
    for (const file of b.files()) {
      if (file[1] === '{}') continue;
      cur.push(file); curBytes += file[1].length; nFiles++;
      if (curBytes >= 40e6) flush();
    }
    b.split.forEach((k) => split.add(k));
    console.log(`${cc}: pass ${p + 1}/${passes} done, ${nFiles} files so far, heap ${(process.memoryUsage().heapUsed / 1e9).toFixed(1)} GB`);
  }
  flush();
  const meta = { country: cc, release, count, s_buckets: sBuckets, split: [...split].sort(), files: nFiles, packs: nPack };
  fs.writeFileSync(path.join(out, `${cc.toLowerCase()}-meta.json`), JSON.stringify(meta));
  console.log(`${cc}: ${count} places, ${nFiles} files in ${nPack} packs`);
}

main().catch((e) => { console.error(e); process.exit(1); });
