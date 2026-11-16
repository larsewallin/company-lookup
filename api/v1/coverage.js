// GET /v1/coverage: the same counts as /api/coverage, with the v1 contract (docs/api-v1.md).
'use strict';
const { coverage } = require('../../lib/coverage');
const { sendV1, API_VERSION } = require('../../lib/handlers');

module.exports = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendV1(res, 405, { error: 'GET only' });
  let body;
  try {
    body = { api_version: API_VERSION, as_of: new Date().toISOString().slice(0, 10), ...(await coverage(fetch)) };
  } catch (e) {
    console.error(`Coverage failed: ${e && e.message}`);
    return sendV1(res, 500, { error: 'Coverage could not be worked out. Try again shortly.' });
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400');
  res.end(JSON.stringify(body));
};
