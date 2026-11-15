// Overture Maps places: read one place by its GERS ID straight from the public GeoParquet release,
// using HTTP range requests (no database, no download). The current release is found from Overture's
// STAC catalog every hour, never hard-coded: releases are removed after about 60 days.
//
// How a lookup works:
//   1. With lon/lat: the release's place files each cover a bounding box (STAC items), and every row group
//      inside a file carries min/max bbox statistics. Only row groups around the point are read.
//   2. Without lon/lat, or if the point misses: the GERS registry (about 50 Parquet files sorted by ID,
//      listed in the STAC catalog with each file's last ID) gives the place's file and bounding box.
// Parquet is read with hyparquet (pure JavaScript, no native code); zstd pages use Node's built-in zlib.
'use strict';

const zlib = require('zlib');
const { SourceError } = require('./http');

const STAC = 'https://stac.overturemaps.org';
const S3 = 'https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com';
const SOURCE = 'Overture Maps';
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EPS = 0.001; // degrees (about 100 m) around a clicked point
const MAX_ROW_GROUPS = 12;
// Everything except geometry (the bbox centre gives the point) and names' rules (translations).
const COLUMNS = ['id', 'names', 'basic_category', 'taxonomy', 'confidence', 'websites', 'socials', 'phones', 'brand', 'addresses', 'sources', 'version', 'bbox'];

let hyparquetModule = null;
const hyparquet = () => (hyparquetModule = hyparquetModule || import('hyparquet'));
function zstd(input) {
  if (typeof zlib.zstdDecompressSync !== 'function') throw new Error('Overture presence data needs Node 22.15 or later (zstd support).');
  return new Uint8Array(zlib.zstdDecompressSync(input));
}
const compressors = { ZSTD: zstd };

/** Accepts a bare GERS ID or "overture:<id>"; returns the bare lower-case ID or null. */
function parseId(input) {
  const s = String(input || '').trim().toLowerCase().replace(/^overture:/, '');
  return ID_RE.test(s) ? s : null;
}

// Small caches with time limits; each serverless instance keeps its own.
function cache(max, ttlMs, nowMs) {
  const m = new Map();
  return {
    get(k) { const e = m.get(k); if (!e) return undefined; if (nowMs() - e.at > ttlMs) { m.delete(k); return undefined; } return e.v; },
    set(k, v) { if (m.size >= max) m.delete(m.keys().next().value); m.set(k, { v, at: nowMs() }); return v; },
  };
}

function createOverture({ fetchFn = fetch, nowMs = () => Date.now() } = {}) {
  const catalogs = cache(4, 60 * 60 * 1000, nowMs); // STAC catalog (latest release + registry manifest)
  const placeItems = cache(4, 24 * 60 * 60 * 1000, nowMs); // per release: [{ bbox, url }]
  const files = cache(24, 6 * 60 * 60 * 1000, nowMs); // per URL: { file, metadata }

  async function json(url) {
    let res;
    try { res = await fetchFn(url, { headers: { Accept: 'application/json' } }); } catch (e) { throw new SourceError(SOURCE, 0, 'Overture Maps could not be reached'); }
    if (!res.ok) throw new SourceError(SOURCE, res.status);
    return res.json();
  }

  async function catalog() {
    const hit = catalogs.get('root');
    if (hit) return hit;
    const c = await json(`${STAC}/catalog.json`);
    if (!c || !c.latest) throw new SourceError(SOURCE, 502, 'Overture catalog has no latest release');
    return catalogs.set('root', { release: c.latest, manifest: (c.registry && c.registry.manifest) || [] });
  }

  /** The release currently served, e.g. "2026-10-21.0". */
  async function latestRelease() { return (await catalog()).release; }

  async function items(release) {
    const hit = placeItems.get(release);
    if (hit) return hit;
    const col = await json(`${STAC}/${release}/places/place/collection.json`);
    const links = (col.links || []).filter((l) => l.rel === 'item');
    const its = await Promise.all(links.map((l) => json(new URL(l.href, `${STAC}/${release}/places/place/`).href)));
    const out = its.map((i) => ({ bbox: i.bbox, url: i.assets && i.assets.aws && i.assets.aws.href })).filter((i) => i.url && i.bbox);
    return placeItems.set(release, out);
  }

  // A fetch-backed byte range reader in the shape hyparquet expects.
  async function open(url) {
    const hit = files.get(url);
    if (hit) return hit;
    let head;
    try { head = await fetchFn(url, { method: 'HEAD' }); } catch (e) { throw new SourceError(SOURCE, 0, 'Overture Maps could not be reached'); }
    if (!head.ok) throw new SourceError(SOURCE, head.status);
    const byteLength = Number(head.headers.get('content-length'));
    const file = {
      byteLength,
      async slice(start, end = byteLength) {
        let res;
        try { res = await fetchFn(url, { headers: { Range: `bytes=${start}-${end - 1}` } }); } catch (e) { throw new SourceError(SOURCE, 0, 'Overture Maps could not be reached'); }
        if (!res.ok) throw new SourceError(SOURCE, res.status);
        return res.arrayBuffer();
      },
    };
    const { parquetMetadataAsync } = await hyparquet();
    const metadata = await parquetMetadataAsync(file, 1 << 20);
    return files.set(url, { file, metadata });
  }

  const stat = (rg, path) => {
    const c = rg.columns.find((x) => x.meta_data && x.meta_data.path_in_schema.join('.') === path);
    const s = c && c.meta_data.statistics;
    if (!s) return null;
    return { min: s.min_value !== undefined ? s.min_value : s.min, max: s.max_value !== undefined ? s.max_value : s.max };
  };
  // Row groups with their first row number.
  const groups = (metadata) => {
    let start = 0;
    return metadata.row_groups.map((rg) => { const g = { rg, start, end: start + Number(rg.num_rows) }; start = g.end; return g; });
  };

  async function read(f, { columns, rowStart, rowEnd }) {
    const { parquetReadObjects } = await hyparquet();
    return parquetReadObjects({ file: f.file, metadata: f.metadata, columns, rowStart, rowEnd, compressors, utf8: true });
  }

  // Find a row by ID among the row groups whose bbox statistics contain the box.
  async function findInFile(url, id, box) {
    const f = await open(url);
    const cands = groups(f.metadata).filter(({ rg }) => {
      const xmin = stat(rg, 'bbox.xmin'); const xmax = stat(rg, 'bbox.xmax');
      const ymin = stat(rg, 'bbox.ymin'); const ymax = stat(rg, 'bbox.ymax');
      if (!xmin || !xmax || !ymin || !ymax) return true;
      return xmin.min <= box.xmax && xmax.max >= box.xmin && ymin.min <= box.ymax && ymax.max >= box.ymin;
    }).filter(({ rg }) => {
      const s = stat(rg, 'id');
      return !s || (s.min <= id && s.max >= id);
    }).slice(0, MAX_ROW_GROUPS);
    for (const g of cands) {
      const ids = await read(f, { columns: ['id'], rowStart: g.start, rowEnd: g.end });
      const i = ids.findIndex((r) => r.id === id);
      if (i >= 0) {
        const [row] = await read(f, { columns: COLUMNS, rowStart: g.start + i, rowEnd: g.start + i + 1 });
        return row;
      }
    }
    return null;
  }

  // GERS registry: which file of the current release holds the ID, and its bounding box.
  async function registry(id) {
    const { manifest } = await catalog();
    const entry = manifest.find(([, lastId]) => id <= lastId);
    if (!entry) return null;
    const f = await open(`${S3}/registry/${entry[0]}`);
    for (const g of groups(f.metadata)) {
      const s = stat(g.rg, 'id');
      if (s && (id < s.min || id > s.max)) continue;
      const rows = await read(f, { columns: ['id', 'path', 'bbox'], rowStart: g.start, rowEnd: g.end });
      const row = rows.find((r) => r.id === id);
      if (row) return row;
      if (s) break;
    }
    return null;
  }

  /**
   * One place by GERS ID. Returns { row, release } or null when the ID is not a place in the current release.
   * lon/lat (optional) make the lookup faster; a wrong point falls back to the registry.
   */
  async function place(id, { lon, lat } = {}) {
    const release = await latestRelease();
    const point = Number.isFinite(lon) && Number.isFinite(lat) ? { x: lon, y: lat } : null;
    if (point) {
      const box = { xmin: point.x - EPS, xmax: point.x + EPS, ymin: point.y - EPS, ymax: point.y + EPS };
      const its = (await items(release)).filter((i) => i.bbox[0] <= box.xmax && i.bbox[2] >= box.xmin && i.bbox[1] <= box.ymax && i.bbox[3] >= box.ymin);
      for (const it of its) {
        const row = await findInFile(it.url, id, box);
        if (row) return { row, release };
      }
    }
    const reg = await registry(id);
    if (!reg || !reg.path || !/theme=places\/type=place\//.test(reg.path)) return null;
    const url = `${S3}/release/${release}/${String(reg.path).replace(/^\/+/, '')}`;
    const b = reg.bbox || {};
    const box = { xmin: b.xmin - EPS, xmax: b.xmax + EPS, ymin: b.ymin - EPS, ymax: b.ymax + EPS };
    const row = await findInFile(url, id, box);
    return row ? { row, release } : null;
  }

  return { place, latestRelease, items, registry };
}

module.exports = { createOverture, parseId, SOURCE };
