// Company counts per source for the lookup page. Cached for a day at the edge.
'use strict';
const { coverage } = require('../lib/coverage');

module.exports = async (req, res) => {
  const body = { as_of: new Date().toISOString().slice(0, 10), ...(await coverage(fetch)) };
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400');
  res.end(JSON.stringify(body));
};
