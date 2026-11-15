// Links between presence records (Overture GERS IDs) and legal entities, kept in the project's Blob store
// as one small JSON index: presence/index.json. Keyed on the GERS ID, so links survive Overture releases.
//
// Each record: { summary, norm, country, checked, link, probable, rejected }
//   link      { entity_id, entity_ids, entity_name, register, number, level: 'strong', evidence, date, status }
//             status is 'active', or 'reported' (held out until reviewed). A reviewer sets it back to
//             'active', or deletes the link and adds the entity id to `rejected` so it is never linked again.
//   probable  [{ entity_id, entity_name, register, number, evidence, date, status }] shown as "possibly the same as…"
// Without a Blob store (local use, tests) the store is a no-op and links are worked out on each lookup.
'use strict';

const blob = require('./blob');

const PATH = 'presence/index.json';
const TTL_MS = 60 * 1000;

function createStore({ fetchFn = fetch, env = process.env, nowMs = () => Date.now() } = {}) {
  const base = blob.storeBase(env);
  let cached = null; let at = 0;

  async function load({ fresh = false } = {}) {
    if (!base) return { records: {} };
    if (!fresh && cached && nowMs() - at < TTL_MS) return cached;
    let idx = { records: {} };
    try {
      // The minute stamp gets past the CDN cache without fetching on every request.
      const res = await fetchFn(`${base}/${PATH}?v=${fresh ? nowMs() : Math.floor(nowMs() / TTL_MS)}`);
      if (res.ok) { const j = await res.json(); if (j && typeof j.records === 'object') idx = j; }
      else if (res.status !== 404) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      if (cached) return cached;
      return { records: {} };
    }
    cached = idx; at = nowMs();
    return idx;
  }

  // Read, change and write the index. Returns false when there is no Blob store or no write access.
  async function update(req, mutate) {
    const auth = base ? blob.auth(env, req) : null;
    if (!auth) return false;
    const idx = await load({ fresh: true });
    if (mutate(idx) === false) return true;
    idx.updated = new Date(nowMs()).toISOString();
    await blob.put(fetchFn, auth, PATH, JSON.stringify(idx), { cacheSeconds: 60 });
    cached = idx; at = nowMs();
    return true;
  }

  return { enabled: !!base, load, update };
}

// Active strong links for an entity, by any of its ids (search result id, card id, LEI).
function locationsFor(idx, ids) {
  const want = new Set(ids.filter(Boolean));
  if (!want.size) return [];
  return Object.values(idx.records || {})
    .filter((r) => r.link && r.link.status === 'active' && r.link.level === 'strong' && (r.link.entity_ids || [r.link.entity_id]).some((i) => want.has(i)))
    .map((r) => ({ ...r.summary, match: { level: 'strong', evidence: r.link.evidence, linked_on: r.link.date } }));
}

module.exports = { createStore, locationsFor, PATH };
