// Search index for bulk-file countries, stored as static JSON files in Vercel Blob.
//
// Layout for one country and version:   bulk/<cc>/<version>/s/<bucket>.json   word index (512 buckets)
//                                         bulk/<cc>/<version>/d/<nnn>.json      full records (1000 buckets, by last 3 digits)
//                                         bulk/<cc>/manifest.json               points at the live version
// Search matches whole words by prefix: "bank cyp" finds "BANK OF CYPRUS PUBLIC COMPANY LIMITED".
'use strict';

const { getJson } = require('../http');

const S_BUCKETS = 512;
const D_BUCKETS = 1000;
// Words too common to search on (legal forms and fillers).
const STOP = new Set(['limited', 'ltd', 'plc', 'llc', 'inc', 'co', 'company', 'the', 'and', 'of', 'public', 'holdings', 'group',
  'incorporated', 'corp', 'corporation', 'canada', 'ltee', 'limitee', 'cie', 'compagnie', 'de', 'du', 'des', 'la', 'le', 'les', 'et',
  'λτδ', 'λιμιτεδ', 'εταιρεια', 'δημοσια', 'και', 'της', 'του',
  // Russian and Ukrainian legal forms ("limited liability company", "joint-stock company"), spelled out in full names.
  'общество', 'ограниченной', 'ответственностью', 'акционерное', 'публичное', 'непубличное', 'товариство', 'обмеженою', 'відповідальністю']);
// A 3-letter word prefix shared by more companies than this is split into longer prefixes ("man" ->
// "manu", "mana", ...; up to 6 letters), stored in a second set of files (t/). Split keys are listed in
// the manifest. A query word too short for its split level falls back to the query's other words.
const MAX_ROWS_PER_KEY = 15000;
const T_BUCKETS = 1024;
const MAX_KEY = 6;

const norm = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const words = (s) => norm(s).split(' ').filter((w) => w.length >= 2);
const keyOf = (w) => w.slice(0, 3);
function hash(s, n) { let h = 2166136261; for (const ch of s) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; } return h % n; }
const dBucket = (number) => String(number).replace(/\D/g, '').slice(-3).padStart(3, '0');

// Streaming builder: records are serialised as they arrive, so millions fit in a function's memory
// (compact strings, no record objects kept). sBuckets can vary per country; it is saved in the manifest.
// only: 's' builds just the word index, 'd' just the records (two passes over a file halve peak memory).
// sRange / dRange ([from, to)) limit a pass to some word buckets or record buckets, so a very large country
// can be built in slices. Split-prefix files are named after their root's word bucket (t/<s>-<n>.json),
// so slices never write the same file.
const T_SUB = 16;
const tFile = (k, sBuckets) => `${hash(k.slice(0, 3), sBuckets)}-${hash(k, T_SUB)}`;
function createBuilder({ sBuckets = S_BUCKETS, only = null, sRange = null, dRange = null } = {}) {
  const inS = (i) => !sRange || (i >= sRange[0] && i < sRange[1]);
  const inD = (i) => !dRange || (i >= dRange[0] && i < dRange[1]);
  const s = Array.from({ length: sBuckets }, () => new Map());
  const d = Array.from({ length: D_BUCKETS }, () => []);
  let count = 0; let active = 0; const split = [];
  const t = new Map(); // file name -> Map(key -> rows)
  // Store rows under key k, splitting k into longer prefixes while it is too crowded.
  function place(k, rows) {
    if (rows.length <= MAX_ROWS_PER_KEY || k.length >= MAX_KEY) {
      // Still very crowded at full length: leave it out (listed as split, so searches skip this word).
      if (k.length >= MAX_KEY && rows.length > 3 * MAX_ROWS_PER_KEY) { split.push(k); return false; }
      if (k.length > 3) { const f = tFile(k, sBuckets); let b = t.get(f); if (!b) { b = new Map(); t.set(f, b); } b.set(k, rows); }
      return k.length === 3; // caller keeps 3-letter keys in s/
    }
    split.push(k);
    const groups = new Map();
    for (const row of rows) {
      const name = JSON.parse(row)[1];
      const subs = new Set(words(name).filter((w) => w.startsWith(k) && w.length > k.length).map((w) => w.slice(0, k.length + 1)));
      for (const sub of subs) { const g = groups.get(sub); if (g) g.push(row); else groups.set(sub, [row]); }
    }
    for (const [sub, g] of groups) place(sub, g);
    return false;
  }
  return {
    add(r) {
      count++; if (r.status === 'active') active++;
      if (only !== 's') { const di = Number(dBucket(r.number)); if (inD(di)) d[di].push(JSON.stringify(String(r.number)) + ':' + JSON.stringify(r)); }
      if (only === 'd') return;
      const row = JSON.stringify([r.number, r.name, r.status === 'active' ? 1 : 0, r.incorporated || null]);
      const keys = new Set(words(r.name).filter((w) => !STOP.has(w)).map(keyOf));
      if (!keys.size) words(r.name).forEach((w) => keys.add(keyOf(w)));
      for (const k of keys) { const si = hash(k, sBuckets); if (!inS(si)) continue; const b = s[si]; const list = b.get(k); if (list) list.push(row); else b.set(k, [row]); }
    },
    get count() { return count; },
    get active() { return active; },
    get split() { return split.slice().sort(); }, // complete once files() has been consumed
    sBuckets,
    tLayout: 2,
    // Yields [relativePath, jsonText] one file at a time, freeing memory as it goes.
    * files() {
      for (let i = 0; only !== 'd' && i < sBuckets; i++) {
        if (!inS(i)) continue;
        const parts = [];
        for (const [k, rows] of s[i]) { if (k.length !== 3 || place(k, rows)) parts.push(JSON.stringify(k) + ':[' + rows.join(',') + ']'); }
        s[i] = null; yield [`s/${i}.json`, '{' + parts.join(',') + '}'];
      }
      for (const [f, b] of t) {
        const parts = []; for (const [k, rows] of b) parts.push(JSON.stringify(k) + ':[' + rows.join(',') + ']');
        t.delete(f); yield [`t/${f}.json`, '{' + parts.join(',') + '}'];
      }
      for (let i = 0; i < D_BUCKETS; i++) {
        if (!inD(i) || !d[i].length) continue;
        const text = '{' + d[i].join(',') + '}'; d[i] = null; yield [`d/${String(i).padStart(3, '0')}.json`, text];
      }
    },
  };
}

// records: [{ number, name, status, incorporated, ...full card fields }]
// Returns { files: { relativePath: object }, count } (used by tests and small countries).
function build(records, opts) {
  const b = createBuilder(opts);
  records.forEach((r) => b.add(r));
  const files = {};
  for (const [p, t] of b.files()) files[p] = JSON.parse(t);
  return { files, count: b.count };
}

// Manifest per country, cached in memory for 10 minutes.
const manifests = new Map();
async function manifest(fetchFn, base, cc) {
  const hit = manifests.get(cc);
  if (hit && hit.until > Date.now()) return hit.m;
  const m = await getJson(fetchFn, `${base}/bulk/${cc.toLowerCase()}/manifest.json`, { source: `${cc} index`, allow404: true });
  manifests.set(cc, { m, until: Date.now() + (m ? 600000 : 60000) }); // a missing index is re-checked after a minute
  return m;
}
const _resetManifests = () => manifests.clear();

async function search(fetchFn, base, cc, q, limit = 30) {
  const m = await manifest(fetchFn, base, cc);
  if (!m) return null; // not built yet
  const qw = words(q).filter((w) => !STOP.has(w));
  const terms = qw.length ? qw : words(q);
  if (!terms.length) return [];
  // The key for a word: its first 3 letters, lengthened while that prefix was split (null if the word is too short).
  const split = new Set(m.split || []);
  const keyFor = (w) => { let k = w.slice(0, 3); while (split.has(k)) { if (w.length <= k.length || k.length >= MAX_KEY) return null; k = w.slice(0, k.length + 1); } return k; };
  const usable = terms.map((w) => [w, keyFor(w)]).filter(([, k]) => k).sort((a, b) => b[1].length - a[1].length || b[0].length - a[0].length);
  if (!usable.length) return [];
  const k = usable[0][1];
  const sb = m.s_buckets || S_BUCKETS;
  const file = k.length === 3 ? `s/${hash(k, sb)}` : m.t_layout === 2 ? `t/${tFile(k, sb)}` : `t/${hash(k, m.t_buckets || T_BUCKETS)}`;
  const bucket = await getJson(fetchFn, `${m.base}/${file}.json`, { source: `${cc} index`, allow404: true });
  const rows = (bucket && bucket[k]) || [];
  const hits = rows.filter((row) => { const nw = words(row[1]); return terms.every((t) => nw.some((w) => w.startsWith(t))); });
  // Whole-word matches of every query word first, then active, then names with fewer other words (closer matches).
  const keyed = hits.map((row) => { const nw = words(row[1]); const set = new Set(nw); return { row, exact: terms.every((t) => set.has(t)) ? 1 : 0, extra: nw.filter((w) => !STOP.has(w)).length }; });
  keyed.sort((a, b) => b.exact - a.exact || b.row[2] - a.row[2] || a.extra - b.extra || a.row[1].length - b.row[1].length);
  return keyed.slice(0, limit).map((k) => k.row).map(([number, name, active, incorporated]) => ({ number, name, status: active ? 'active' : 'inactive', incorporated }));
}

async function get(fetchFn, base, cc, number) {
  const m = await manifest(fetchFn, base, cc);
  if (!m) return null;
  const d = await getJson(fetchFn, `${m.base}/d/${dBucket(number)}.json`, { source: `${cc} index`, allow404: true });
  return (d && d[number]) || null;
}

module.exports = { build, createBuilder, search, get, words, hash, dBucket, S_BUCKETS, _resetManifests };
