// GET /api/sanctions?name=&country= or POST { names: [{ name, country }] }: screen company names against
// the OFAC, EU, UN and UK sanctions lists (index built daily by api/sanctions-import.js).
const { createHandlers } = require('../lib/handlers');
const { sanctions } = createHandlers();
module.exports = sanctions;
