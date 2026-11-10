// Run Company Lookup on your own computer: `node server.js`, then open http://localhost:3000
// No dependencies. Serves the demo page and the same /api routes as the Vercel deployment.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

// Load a .env file if there is one (KEY=value lines), without overriding real environment variables.
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch (e) { /* no .env file */ }

const ROUTES = {
  '/api/search': () => require('./api/search'),
  '/api/company': () => require('./api/company'),
  '/api/coverage': () => require('./api/coverage'),
  '/api/mcp': () => require('./api/mcp'),
  '/api/bulk-import': () => require('./api/bulk-import'),
};

const PORT = Number(process.env.PORT) || 3000;

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
    }
    const route = ROUTES[url.pathname];
    if (!route) { res.statusCode = 404; return res.end('Not found'); }
    // The handlers expect Vercel's req.query and req.body.
    req.query = Object.fromEntries(url.searchParams);
    if (req.method === 'POST') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const text = Buffer.concat(chunks).toString('utf8');
      try { req.body = JSON.parse(text); } catch (e) { req.body = text; }
    }
    await route()(req, res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) { res.statusCode = 500; res.end(JSON.stringify({ error: 'Internal error' })); }
  }
}).listen(PORT, () => {
  console.log(`Company Lookup running at http://localhost:${PORT}`);
  console.log(`MCP server for AI assistants: http://localhost:${PORT}/api/mcp`);
});
