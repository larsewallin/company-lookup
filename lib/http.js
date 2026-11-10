// Shared JSON fetch with timeout and source-tagged errors.
'use strict';

const TIMEOUT_MS = 8000;

class SourceError extends Error {
  constructor(source, status, message) {
    super(message || `${source} returned ${status}`);
    this.source = source;
    this.status = status;
  }
}

async function getJson(fetchFn, url, { headers = {}, source, allow404 = false, method = 'GET', body = null, form = null, timeoutMs = TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    const opts = { method, headers: { Accept: 'application/json', ...headers }, signal: ctrl.signal, redirect: 'follow' };
    if (body != null) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
    if (form != null) { opts.body = form; opts.headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
    res = await fetchFn(url, opts);
  } catch (e) {
    throw new SourceError(source, 0, `${source} could not be reached`);
  } finally {
    clearTimeout(timer);
  }
  if ((res.status === 404 || res.status === 410) && allow404) return null;
  if (!res.ok) throw new SourceError(source, res.status);
  return res.json();
}

module.exports = { getJson, SourceError };
