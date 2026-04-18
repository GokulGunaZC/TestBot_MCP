'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { AddressInfo } = require('node:net');

const { driveExploration } = require('../src/browser-use-driver');
const { exploreWithPlaywright } = require('../src/playwright-explorer');
const { runExplorationPhase, EMPTY_ARTIFACT } = require('../src/exploration-phase');

function startTinyServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/login') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(
          '<!doctype html><html><body>' +
            '<h1>Sign in</h1>' +
            '<form>' +
            '<input type="email" name="email" required />' +
            '<input type="password" name="password" required />' +
            '<button type="submit">Log in</button>' +
            '</form>' +
            '<a href="/docs">Docs</a>' +
            '</body></html>'
        );
        return;
      }
      if (req.url === '/docs') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><html><body><h1>Docs</h1><a href="/login">Back</a></body></html>');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        '<!doctype html><html><body>' +
          '<h1>Home</h1>' +
          '<a href="/login">Login</a>' +
          '<a href="/docs">Docs</a>' +
          '</body></html>'
      );
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = /** @type {AddressInfo} */ (server.address());
      resolve({ server, baseURL: `http://127.0.0.1:${addr.port}` });
    });
  });
}

test('runExplorationPhase honors skipExploration and returns empty artifact', async () => {
  const result = await runExplorationPhase({
    statusDir: null,
    baseURL: 'http://example.invalid',
    credentials: null,
    skipExploration: true,
  });
  assert.equal(result.source, 'skipped');
  assert.deepEqual(result.artifact, { ...EMPTY_ARTIFACT });
});

test('runExplorationPhase returns unavailable when baseURL missing', async () => {
  const result = await runExplorationPhase({
    statusDir: null,
    baseURL: '',
    credentials: null,
  });
  assert.equal(result.source, 'unavailable');
  assert.deepEqual(result.artifact, { ...EMPTY_ARTIFACT });
});

test('driveExploration without browser-use returns {available:false} rather than throwing', async () => {
  // No HEALIX_TARGET_URL, no browser-use install required — the driver must
  // never throw. It either returns available:false or available:true.
  const result = await driveExploration({ targetUrl: '' });
  assert.equal(result.available, false);
  assert.ok(typeof result.reason === 'string' && result.reason.length > 0);
});

test('playwright heuristic explorer discovers routes, forms, and authFlow', async () => {
  let playwrightAvailable = true;
  try { require('playwright'); } catch { playwrightAvailable = false; }
  if (!playwrightAvailable) {
    console.warn('[skip] playwright not installed — skipping heuristic explorer smoke test');
    return;
  }

  const { server, baseURL } = await startTinyServer();
  try {
    const result = await exploreWithPlaywright({ baseURL });
    assert.equal(result.available, true, `explorer should have succeeded: ${result.reason || ''}`);
    const art = result.artifact;
    assert.ok(Array.isArray(art.routes) && art.routes.length >= 1, 'should discover at least 1 route');
    const paths = art.routes.map((r) => r.path);
    assert.ok(paths.includes('/') || paths.includes('/login'), 'should include home or login route');
    assert.ok(art.authFlow && art.authFlow.loginUrl, 'should detect authFlow from the login form');
    assert.ok(Array.isArray(art.forms) && art.forms.length >= 1, 'should detect at least the login form');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('runExplorationPhase end-to-end falls back to playwright when browser-use is unavailable', async () => {
  let playwrightAvailable = true;
  try { require('playwright'); } catch { playwrightAvailable = false; }
  if (!playwrightAvailable) {
    console.warn('[skip] playwright not installed — skipping end-to-end exploration test');
    return;
  }

  const { server, baseURL } = await startTinyServer();
  try {
    const result = await runExplorationPhase({
      statusDir: null,
      baseURL,
      credentials: null,
      totalTimeoutMs: 60_000,
    });
    // In CI without browser-use + without OPENAI_API_KEY we expect the
    // Playwright heuristic fallback to pick up the slack.
    assert.ok(
      result.source === 'playwright-heuristic' || result.source === 'browser-use',
      `unexpected source: ${result.source} (reason: ${result.reason || 'n/a'})`
    );
    assert.ok(Array.isArray(result.artifact.routes), 'artifact should include a routes array');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
