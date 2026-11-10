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
];

// Run an existing handler with a fake response object and return { status, body }.
function callHandler(handler, req, query) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      setHeader() {},
      end(text) { try { resolve({ status: this.statusCode, body: JSON.parse(text) }); } catch (e) { reject(e); } },
    };
    Promise.resolve(handler({ method: 'GET', query, headers: req.headers || {}, socket: req.socket }, res)).catch(reject);
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
