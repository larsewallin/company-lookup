// Offline tests for the MCP endpoint: run with `node --test tests/mcp.test.js`.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMcp, TOOLS } = require('../lib/mcp');

const NOW = new Date('2026-11-09T12:00:00Z');
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
function fakeFetch(routes) {
  return async (url) => {
    for (const [k, v] of Object.entries(routes)) if (url.includes(k)) return typeof v === 'function' ? v(url) : v;
    return json(404, {});
  };
}
const gl = (lei, name, country) => ({ attributes: { lei, entity: { legalName: { name }, legalAddress: { country, city: 'X' }, status: 'ACTIVE' }, registration: { status: 'ISSUED' } } });

let ipCounter = 0;
function mockReq(body, method = 'POST') {
  return { method, body, headers: { 'x-forwarded-for': `10.0.0.${++ipCounter}` }, socket: {} };
}
function mockRes() {
  return { statusCode: 200, headers: {}, text: '', setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(t) { this.text = t || ''; this.body = t ? JSON.parse(t) : undefined; } };
}
async function post(mcp, body) { const res = mockRes(); await mcp.handler(mockReq(body), res); return res; }

test('every tool has a title and all three hints ChatGPT requires, all read-only', () => {
  assert.equal(TOOLS.length, 2);
  for (const t of TOOLS) {
    assert.ok(t.title && t.description && t.inputSchema, t.name);
    for (const k of ['readOnlyHint', 'destructiveHint', 'openWorldHint', 'idempotentHint']) assert.equal(typeof t.annotations[k], 'boolean', `${t.name} ${k}`);
    assert.equal(t.annotations.readOnlyHint, true);
    assert.equal(t.annotations.destructiveHint, false);
  }
});

test('initialize negotiates the protocol version and gives instructions', async () => {
  const mcp = createMcp({ fetchFn: fakeFetch({}), env: {}, now: () => NOW });
  let res = await post(mcp, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result.protocolVersion, '2025-06-18');
  assert.equal(res.body.result.serverInfo.name, 'company-lookup');
  assert.ok(res.body.result.capabilities.tools);
  assert.match(res.body.result.instructions, /never a verdict/);
  res = await post(mcp, { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  assert.equal(res.body.result.protocolVersion, '2025-11-25', 'unknown version falls back to the latest');
});

test('notifications get 202 with no body; unknown methods and bad JSON get errors', async () => {
  const mcp = createMcp({ fetchFn: fakeFetch({}), env: {}, now: () => NOW });
  let res = await post(mcp, { jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(res.statusCode, 202); assert.equal(res.text, '');
  res = await post(mcp, { jsonrpc: '2.0', id: 3, method: 'nope' });
  assert.equal(res.body.error.code, -32601);
  res = await post(mcp, '{not json');
  assert.equal(res.statusCode, 400); assert.equal(res.body.error.code, -32700);
  res = await post(mcp, { id: 4, method: 'ping' });
  assert.equal(res.body.error.code, -32600);
});

test('GET is refused (stateless, no stream); OPTIONS answers CORS', async () => {
  const mcp = createMcp({ fetchFn: fakeFetch({}), env: {}, now: () => NOW });
  let res = mockRes(); await mcp.handler(mockReq(undefined, 'GET'), res);
  assert.equal(res.statusCode, 405);
  res = mockRes(); await mcp.handler(mockReq(undefined, 'OPTIONS'), res);
  assert.equal(res.statusCode, 204); assert.equal(res.headers['access-control-allow-origin'], '*');
});

test('tools/list then search_companies returns structured results with ids', async () => {
  const mcp = createMcp({ fetchFn: fakeFetch({ 'filter%5Bfulltext%5D=siemens': json(200, { data: [gl('W38RGI023J3WT1HWRP32', 'Siemens Aktiengesellschaft', 'DE')] }) }), env: {}, now: () => NOW });
  let res = await post(mcp, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.deepEqual(res.body.result.tools.map((t) => t.name), ['search_companies', 'get_company_card']);
  res = await post(mcp, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_companies', arguments: { query: 'siemens' } } });
  const r = res.body.result;
  assert.equal(r.isError, undefined);
  assert.equal(r.structuredContent.results[0].lei, 'W38RGI023J3WT1HWRP32');
  assert.ok(r.structuredContent.results[0].id);
  assert.deepEqual(JSON.parse(r.content[0].text), r.structuredContent);
});

test('handler errors become tool errors the model can read, not protocol errors', async () => {
  const mcp = createMcp({ fetchFn: fakeFetch({}), env: {}, now: () => NOW });
  let res = await post(mcp, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_companies', arguments: { query: 'a' } } });
  assert.equal(res.body.result.isError, true);
  assert.match(res.body.result.content[0].text, /between 2 and 100/);
  res = await post(mcp, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_company_card', arguments: { id: 'xx:1' } } });
  assert.equal(res.body.result.isError, true);
  assert.match(res.body.result.content[0].text, /Unknown company reference/);
  res = await post(mcp, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'delete_everything', arguments: {} } });
  assert.equal(res.body.error.code, -32602);
});

test('get_company_card returns the card for an LEI', async () => {
  const lei = 'W38RGI023J3WT1HWRP32';
  const record = { data: { ...gl(lei, 'Siemens Aktiengesellschaft', 'DE'), id: lei, relationships: {} } };
  const mcp = createMcp({ fetchFn: fakeFetch({ [`lei-records/${lei}`]: json(200, record) }), env: {}, now: () => NOW });
  const res = await post(mcp, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_company_card', arguments: { id: `lei:${lei}` } } });
  const r = res.body.result;
  assert.equal(r.isError, undefined, r.content && r.content[0].text);
  assert.equal(r.structuredContent.id, `lei:${lei}`);
});

test('batches are answered as arrays', async () => {
  const mcp = createMcp({ fetchFn: fakeFetch({}), env: {}, now: () => NOW });
  const res = await post(mcp, [{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }]);
  assert.ok(Array.isArray(res.body)); assert.equal(res.body.length, 1);
});
