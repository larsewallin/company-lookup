// Use Company Lookup as a library in your own Node.js application.
//
//   const { createLookup } = require('company-lookup');
//   const lookup = createLookup();
//   const { results } = await lookup.search('Siemens', { country: 'DE' });
//   const card = await lookup.company(results[0].id, { website: 'siemens.com' });
//
// Results are the same JSON the HTTP API returns (see README). No dependencies; Node 20 or later.
'use strict';

const { createHandlers } = require('./handlers');
const { buildCard, RULES } = require('./card');
const { coverage } = require('./coverage');

class LookupError extends Error {
  constructor(status, message) { super(message); this.name = 'LookupError'; this.status = status; }
}

// Run one of the HTTP handlers in memory and return its JSON body.
function run(handler, query) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      setHeader() {},
      end(text) {
        let body;
        try { body = JSON.parse(text); } catch (e) { return reject(e); }
        if (this.statusCode >= 400) return reject(new LookupError(this.statusCode, body.error || `HTTP ${this.statusCode}`));
        resolve(body);
      },
    };
    Promise.resolve(handler({ method: 'GET', query, headers: {}, socket: {} }, res)).catch(reject);
  });
}

/**
 * @param {object} [options]
 * @param {Function} [options.fetchFn] fetch implementation (default: global fetch)
 * @param {object} [options.env] where API keys are read from (default: process.env)
 */
function createLookup(options = {}) {
  // No rate limit inside your own process: limits exist to protect the public website.
  const h = createHandlers({ limit: Number.POSITIVE_INFINITY, ...options });
  return {
    /** Search by name, registration number, LEI, ISIN or ticker. Returns { query, country, results, warnings }. */
    search(query, { country } = {}) {
      const q = { q: String(query || '') };
      if (country) q.country = String(country);
      return run(h.search, q);
    },
    /** Full company card for an id from search(), e.g. "lei:…", "gb:00445790", "fr:552120222". */
    company(id, { website } = {}) {
      const q = { id: String(id || '') };
      if (website) q.website = String(website);
      return run(h.company, q);
    },
    /** Company counts each source reports about itself. */
    coverage() { return coverage(options.fetchFn || fetch); },
  };
}

module.exports = { createLookup, LookupError, buildCard, RULES };
