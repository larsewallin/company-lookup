// POST /api/places-import: copies the monthly presence-data index (GitHub release packs) into Blob. See lib/places.js.
const { createPlacesImport } = require('../lib/places');
module.exports = createPlacesImport();
