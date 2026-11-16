// GET/POST /v1/sanctions (vercel.json rewrites /v1/* here). Same handler as /api/*, with the v1 contract: docs/api-v1.md
const { createHandlers } = require('../../lib/handlers');
const { sanctions } = createHandlers({ apiVersion: '1' });
module.exports = sanctions;
