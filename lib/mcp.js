// Remote MCP server for Company Lookup (Streamable HTTP, stateless, JSON responses).
// Used by ChatGPT apps and Claude connectors. No SDK: the protocol surface we need is small.
// It wraps the same handlers as /api/search and /api/company, so results match the website.
'use strict';

const { createHandlers } = require('./handlers');

const SERVER_INFO = { name: 'company-lookup', title: 'Company Lookup', version: '1.0.0' };
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MCP_LIMIT = 300; // lookups per 5 minutes per calling address (shared by a platform's users)

const INSTRUCTIONS = [
  'Company Lookup checks whether a business is real and in good standing, using official company registers,',
  'GLEIF (legal entity identifiers and parent companies), EU VAT (VIES), Wikidata and domain age.',
  'Call search_companies first, then get_company_card with the id of the right result.',
  'Every fact on a card carries its source and the date it was checked; show these to the user.',
  'Flags are prompts to review, never a verdict: do not call a company fraudulent or say to decline it.',
  'get_presence_card returns one place from Overture Maps by its GERS ID (presence data): it is not an official record',
  'and not a legal identifier, so always show its notice and sources, and prefer legal entities from search_companies.',
  'screen_sanctions checks company names against the US OFAC, EU, UN and UK sanctions lists (entities only). A match is a',
  'possible match to review on other details, never a finding that a company is sanctioned; show the notice and list dates.',
  'Company cards already include a sanctions screening of the company and its parents.',
  'The tools cover companies only, not private individuals.',
].join(' ');

const ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

const TOOLS = [
  {
    name: 'search_companies',
    title: 'Search companies',
    description: 'Find companies by name, registration number, LEI, ISIN or stock ticker across official registers and GLEIF. '
      + 'Returns up to 20 matches, each with an id to pass to get_company_card. '
      + 'Give a country code when you know it: it adds that country\'s national register and gives better results.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 2, maxLength: 100, description: 'Company name, registration number, LEI, ISIN or ticker.' },
        country: { type: 'string', pattern: '^[A-Za-z]{2}$', description: 'Optional ISO 3166-1 alpha-2 country code, e.g. GB, FR, US.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: { title: 'Search companies', ...ANNOTATIONS },
  },
  {
    name: 'get_company_card',
    title: 'Get company card',
    description: 'Get the full company card for one result from search_companies: legal name, register status, address, '
      + 'incorporation date, officers where the register publishes them, LEI and parent companies, VAT validity, '
      + 'website domain age, warning flags (Stop, Check, Note) and the sources checked, each with its date.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', maxLength: 80, description: 'The id from search_companies, e.g. "lei:5493001KJTIIGC8Y1R12", "gb:00445790" or "fr:552120222".' },
        website: { type: 'string', maxLength: 300, description: 'Optional website the company gave you; its domain age is checked.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: { title: 'Get company card', ...ANNOTATIONS },
  },
  {
    name: 'get_presence_card',
    title: 'Get presence card',
    description: 'Get one place from Overture Maps by its GERS ID: name, categories, address, location, websites, phones, '
      + 'socials, brand, Overture\'s confidence score and each source with its licence. This is presence data: it shows a '
      + 'business appears to exist at an address, and is not an official record or a legal identifier. No verdict or flags. '
      + 'Where the place is linked to a legal entity, linked_entity names it; possible_matches are not confirmed.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', maxLength: 50, description: 'Overture GERS ID, e.g. "6f8bce4f-a274-4494-9f2c-dd051bca0bb4" (an "overture:" prefix is fine).' },
        lon: { type: 'number', minimum: -180, maximum: 180, description: 'Optional longitude of the place (from the map); makes the lookup faster.' },
        lat: { type: 'number', minimum: -90, maximum: 90, description: 'Optional latitude of the place.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: { title: 'Get presence card', ...ANNOTATIONS },
  },
  {
    name: 'screen_sanctions',
    title: 'Screen sanctions lists',
    description: 'Screen one or more company names against the official US OFAC (SDN and non-SDN), EU, UN and UK sanctions lists, '
      + 'refreshed daily. Entities only, not individuals. Returns possible matches (exact, strong or possible) with the list, '
      + 'programme, listing date and a link, plus each list\'s download date. A match is a prompt to review, not a determination.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', maxLength: 200, description: 'Company name to screen.' },
        country: { type: 'string', maxLength: 2, description: 'Optional ISO country code of the company (ranks same-country matches first).' },
        names: {
          type: 'array', maxItems: 50, description: 'Several companies at once, instead of name.',
          items: { type: 'object', properties: { name: { type: 'string', maxLength: 200 }, country: { type: 'string', maxLength: 2 } }, required: ['name'] },
        },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Screen sanctions lists', ...ANNOTATIONS },
  },
];

// Run an existing handler with a fake response object and return { status, body }.
function callHandler(handler, req, query, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      setHeader() {},
      end(text) { try { resolve({ status: this.statusCode, body: JSON.parse(text) }); } catch (e) { reject(e); } },
    };
    Promise.resolve(handler({ method, query, body, headers: req.headers || {}, socket: req.socket }, res)).catch(reject);
  });
}

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } });
const toolError = (text) => ({ content: [{ type: 'text', text }], isError: true });

function createMcp(deps = {}) {
  const h = createHandlers({ limit: MCP_LIMIT, keyPrefix: 'mcp:', ...deps });

  async function callTool(name, args, req) {
    args = args && typeof args === 'object' ? args : {};
    let r;
    if (name === 'search_companies') {
      const query = { q: String(args.query || '') };
      if (args.country) query.country = String(args.country);
      r = await callHandler(h.search, req, query);
    } else if (name === 'get_company_card') {
      const query = { id: String(args.id || '') };
      if (args.website) query.website = String(args.website);
      r = await callHandler(h.company, req, query);
    } else if (name === 'get_presence_card') {
      const query = { id: String(args.id || '') };
      if (args.lon != null && args.lat != null) { query.lon = String(args.lon); query.lat = String(args.lat); }
      r = await callHandler(h.presence, req, query);
    } else if (name === 'screen_sanctions') {
      const names = Array.isArray(args.names) && args.names.length ? args.names : args.name ? [{ name: args.name, country: args.country }] : [];
      r = await callHandler(h.sanctions, req, {}, { method: 'POST', body: { names } });
    } else {
      return null;
    }
    if (r.status !== 200) return toolError(r.body && r.body.error ? r.body.error : `Lookup failed (HTTP ${r.status}).`);
    return { content: [{ type: 'text', text: JSON.stringify(r.body) }], structuredContent: r.body };
  }

  // Returns a JSON-RPC response object, or null for notifications.
  async function handleMessage(msg, req) {
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return rpcError(msg && msg.id, -32600, 'Invalid request');
    }
    const isNotification = !('id' in msg);
    if (isNotification) return null;
    const { id, method, params = {} } = msg;
    switch (method) {
      case 'initialize': {
        const asked = params && params.protocolVersion;
        const protocolVersion = PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0];
        return rpcResult(id, { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
      }
      case 'ping':
        return rpcResult(id, {});
      case 'tools/list':
        return rpcResult(id, { tools: TOOLS });
      case 'tools/call': {
        try {
          const out = await callTool(params && params.name, params && params.arguments, req);
          if (!out) return rpcError(id, -32602, `Unknown tool: ${params && params.name}`);
          return rpcResult(id, out);
        } catch (e) {
          return rpcResult(id, toolError('The lookup failed unexpectedly. Try again shortly.'));
        }
      }
      case 'resources/list': return rpcResult(id, { resources: [] });
      case 'prompts/list': return rpcResult(id, { prompts: [] });
      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  }

  async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Authorization');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
    if (req.method !== 'POST') {
      // Stateless server: no server-to-client stream.
      res.statusCode = 405; res.setHeader('Allow', 'POST, OPTIONS'); return res.end();
    }
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = undefined; } }
    if (body === undefined || body === null) {
      res.statusCode = 400; res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify(rpcError(null, -32700, 'Parse error')));
    }
    const batch = Array.isArray(body);
    const replies = (await Promise.all((batch ? body : [body]).map((m) => handleMessage(m, req)))).filter(Boolean);
    if (!replies.length) { res.statusCode = 202; return res.end(); }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify(batch ? replies : replies[0]));
  }

  return { handler, handleMessage, TOOLS };
}

module.exports = { createMcp, TOOLS, PROTOCOL_VERSIONS };
