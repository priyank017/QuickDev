#!/usr/bin/env node
/**
 * Wire relay — a tiny local companion for wire.html.
 *
 * Why this exists:
 * Browsers block cross-origin requests (CORS) and never let JavaScript attach
 * a client certificate to a request — both are enforced below the page, and
 * no browser-based tool can override either one. This relay is a plain
 * Node.js process that makes the real HTTP call itself, outside the browser,
 * where neither restriction applies (CORS is a browser rule, not an HTTP
 * rule — servers talking to servers were never subject to it).
 *
 * It stores nothing. Every request is forwarded and forgotten — nothing is
 * written to disk, nothing is cached, nothing is logged except a one-line
 * "method + url + status" note to your own terminal so you can see it working.
 *
 * Usage:
 *   node relay.js            # listens on http://localhost:7890
 *   PORT=8080 node relay.js  # or pick your own port
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const PORT = process.env.PORT || 7890;

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function relayRequest(payload) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(payload.url);
    } catch (e) {
      return resolve({ error: 'Invalid URL: ' + payload.url });
    }

    const isHttps = target.protocol === 'https:';
    const lib = isHttps ? https : http;

    const options = {
      method: payload.method || 'GET',
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: target.pathname + target.search,
      headers: Object.assign({}, payload.headers || {}),
      // Reasonable ceiling so a hung server can't block the relay forever.
      timeout: 30000,
    };

    // Real mutual TLS: attach the client cert/key directly to this outbound
    // TLS connection. This is exactly what a browser can never do from JS.
    if (isHttps && (payload.cert || payload.key)) {
      options.cert = payload.cert || undefined;
      options.key = payload.key || undefined;
      if (payload.passphrase) options.passphrase = payload.passphrase;
      // Still verifies the server's certificate normally (secure by default).
    }

    const outReq = lib.request(options, (outRes) => {
      let chunks = [];
      outRes.on('data', c => chunks.push(c));
      outRes.on('end', () => {
        const buf = Buffer.concat(chunks);
        const contentType = outRes.headers['content-type'] || '';
        const isText = /json|text|xml|html|javascript|urlencoded/.test(contentType) || buf.length === 0;
        resolve({
          status: outRes.statusCode,
          statusText: outRes.statusMessage || '',
          headers: outRes.headers,
          bodyIsBase64: !isText,
          body: isText ? buf.toString('utf8') : buf.toString('base64'),
        });
      });
    });

    outReq.on('timeout', () => {
      outReq.destroy();
      resolve({ error: 'Timed out waiting for the target server.' });
    });

    outReq.on('error', (err) => {
      resolve({ error: err.message });
    });

    if (payload.body && !['GET', 'HEAD'].includes((payload.method || 'GET').toUpperCase())) {
      outReq.write(payload.body);
    }
    outReq.end();
  });
}

const server = http.createServer(async (req, res) => {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  if (req.method === 'POST' && req.url === '/relay') {
    try {
      const raw = await readBody(req);
      const payload = JSON.parse(raw);
      const result = await relayRequest(payload);
      console.log(`[relay] ${payload.method || 'GET'} ${payload.url} -> ${result.status || 'ERROR: ' + result.error}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Bad request: ' + e.message }));
    }
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found. POST to /relay or GET /health.' }));
});

server.listen(PORT, () => {
  console.log(`Wire relay listening on http://localhost:${PORT}`);
  console.log('Nothing is logged except method + URL + status. Ctrl+C to stop.');
});
