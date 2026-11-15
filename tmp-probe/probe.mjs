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
if (mode === 'find') {
  // find <lon> <lat> <field-regex-json>: rows near a point whose brand or source dataset matches
  const { asyncBufferFromUrl, parquetMetadataAsync, parquetReadObjects } = await import('hyparquet');
  const zlib = await import('node:zlib');
  const compressors = { ZSTD: (i) => new Uint8Array(zlib.zstdDecompressSync(i)) };
  const ov = createOverture();
  const R = await ov.latestRelease();
  const x = Number(args[0]); const y = Number(args[1]); const want = args[2];
  const it = (await ov.items(R)).find((i) => i.bbox[0] <= x && i.bbox[2] >= x && i.bbox[1] <= y && i.bbox[3] >= y);
  const file = await asyncBufferFromUrl({ url: it.url });
  const md = await parquetMetadataAsync(file);
  let start = 0; let n = 0;
  for (const rg of md.row_groups) {
    const cnt = Number(rg.num_rows);
    const st = (p) => rg.columns.find((c) => c.meta_data.path_in_schema.join('.') === p).meta_data.statistics;
    if (st('bbox.xmin').min_value <= x + 0.02 && st('bbox.xmax').max_value >= x - 0.02 && st('bbox.ymin').min_value <= y + 0.02 && st('bbox.ymax').max_value >= y - 0.02 && n < 3) {
      n++;
      const rows = await parquetReadObjects({ file, metadata: md, compressors, rowStart: start, rowEnd: start + cnt, columns: ['id', 'names', 'websites', 'brand', 'bbox', 'sources'] });
      for (const r of rows.filter((r) => (want === 'brand' ? r.brand && r.brand.names : r.sources.some((s) => new RegExp(want, 'i').test(s.dataset)))).slice(0, 4)) {
        console.log(r.id, r.names && r.names.primary, (r.websites || [])[0], r.brand && r.brand.names && r.brand.names.primary, r.bbox.xmin.toFixed(5), r.bbox.ymin.toFixed(5), [...new Set(r.sources.map((s) => s.dataset + '/' + s.license))].join('+'));
      }
    }
    start += cnt;
  }
}
if (mode === 'compact') {
  const out = JSON.parse(fs.readFileSync('/vercel/probe/rows.json', 'utf8'));
  const keep = ['property', 'dataset', 'license', 'record_id', 'update_time', 'confidence'];
  const c = out.map(({ release, row }) => ({ release, row: { ...row, sources: row.sources.map((s) => Object.fromEntries(keep.map((k) => [k, s[k]]))) } }));
  fs.writeFileSync('/vercel/probe/compact.json', JSON.stringify(c));
  console.log(c.map((x) => JSON.stringify(x).length).join(' '));
}
if (mode === 'c') console.log(JSON.stringify(JSON.parse(fs.readFileSync('/vercel/probe/compact.json', 'utf8'))[Number(args[0])]));
if (mode === 'countries') {
  // Estimate place counts per country by sampling every Nth row group of every file.
  const { parquetMetadataAsync, parquetReadObjects, asyncBufferFromUrl } = await import('hyparquet');
  const zlib = await import('node:zlib');
  const compressors = { ZSTD: (i) => new Uint8Array(zlib.zstdDecompressSync(i)) };
  const ov = createOverture();
  const R = await ov.latestRelease();
  const step = Number(args[0] || 20);
  const counts = {}; let total = 0; let sampledRows = 0; const t = Date.now();
  await Promise.all((await ov.items(R)).map(async (it) => {
    const file = await asyncBufferFromUrl({ url: it.url });
    const md = await parquetMetadataAsync(file);
    let start = 0;
    for (let i = 0; i < md.row_groups.length; i++) {
      const n = Number(md.row_groups[i].num_rows); total += n;
      if (i % step === 0) {
        const rows = await parquetReadObjects({ file, metadata: md, compressors, rowStart: start, rowEnd: start + n, columns: ['addresses'] });
        sampledRows += rows.length;
        for (const r of rows) { const c = (r.addresses && r.addresses[0] && r.addresses[0].country) || '??'; counts[c] = (counts[c] || 0) + 1; }
      }
      start += n;
    }
  }));
  const scale = total / sampledRows;
  const est = Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Math.round(v * scale)]).sort((a, b) => b[1] - a[1]));
  fs.writeFileSync('/vercel/probe/countries.json', JSON.stringify({ release: R, total, sampledRows, est }));
  console.log('total', total, 'sampled', sampledRows, 'secs', Math.round((Date.now() - t) / 1000));
}
if (mode === 'cshow') {
  const o = JSON.parse(fs.readFileSync('/vercel/probe/countries.json', 'utf8'));
  console.log(o.release, o.total, o.sampledRows, Object.entries(o.est).slice(0, Number(args[0] || 70)).map(([k, v]) => `${k}:${Math.round(v / 1000)}k`).join(' '));
}
