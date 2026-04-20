'use strict';

/**
 * Unit tests for WebappClient.planGeneration — the P1.5 planner pre-pass
 * client. Same shape as webapp-client.test.js: monkey-patch global.fetch
 * and assert over the captured request.
 *
 * Contracts under test:
 *   1. Request body carries the structured planner inputs.
 *   2. 55s endpoint timeout (AbortController signal threaded to fetch).
 *   3. HTTP 404 returns { fallback: 'endpoint_absent' } without throwing
 *      (feature-detection for older webapps).
 *   4. AbortError → err.code === 'WEBAPP_TIMEOUT'.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const WebappClient = require('../src/webapp-client');

function mockFetch(impl) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return impl({ url, init, callIndex: calls.length - 1 });
  };
  fn.calls = calls;
  return fn;
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map(),
    text: async () => JSON.stringify(body),
  };
}

test('planGeneration body contains the expected fields', async () => {
  const savedFetch = global.fetch;
  try {
    let capturedBody = null;
    global.fetch = mockFetch(async ({ init, url }) => {
      assert.ok(url.endsWith('/api/generate-tests/plan'));
      assert.equal(init.method, 'POST');
      capturedBody = JSON.parse(init.body);
      return jsonResponse({
        success: true,
        plan: {
          planVersion: 1,
          planHash: 'abc',
          frontendPlan: null,
          backendPlan: null,
          totalPlannedTests: 0,
          warnings: [],
          generatedAt: new Date().toISOString(),
        },
        cache: 'miss',
      });
    });

    const client = new WebappClient({
      apiKey: 'tb_test_key',
      dashboardUrl: 'http://127.0.0.1:3000',
    });

    const result = await client.planGeneration({
      context: { pages: [{ path: '/' }] },
      prd: 'PRD content',
      parsedPRD: { features: [] },
      explorationArtifact: { routes: [] },
      roles: [{ name: 'admin' }],
      projectInfo: { name: 'demo', apiOnly: false },
      options: { coverageProfile: 'qa-max' },
    });

    assert.ok(result.plan, 'returns plan on success');
    assert.equal(result.cache, 'miss');

    // All structured planner inputs must be present on the wire.
    assert.equal(capturedBody.api_key, 'tb_test_key');
    assert.deepEqual(capturedBody.context, { pages: [{ path: '/' }] });
    assert.equal(capturedBody.prd, 'PRD content');
    assert.deepEqual(capturedBody.parsedPRD, { features: [] });
    assert.deepEqual(capturedBody.explorationArtifact, { routes: [] });
    assert.deepEqual(capturedBody.roles, [{ name: 'admin' }]);
    assert.deepEqual(capturedBody.projectInfo, { name: 'demo', apiOnly: false });
    assert.equal(capturedBody.apiOnly, false);
  } finally {
    global.fetch = savedFetch;
  }
});

test('planGeneration threads AbortController signal (55s timeout)', async () => {
  const savedFetch = global.fetch;
  try {
    let observedSignal = null;
    global.fetch = mockFetch(async ({ init }) => {
      observedSignal = init.signal;
      return jsonResponse({ success: true, plan: { planVersion: 1, planHash: 'x', frontendPlan: null, backendPlan: null, totalPlannedTests: 0, warnings: [], generatedAt: 'now' }, cache: 'miss' });
    });

    const client = new WebappClient({
      apiKey: 'tb_test_key',
      dashboardUrl: 'http://127.0.0.1:3000',
    });

    await client.planGeneration({ context: {}, projectInfo: {} });

    assert.ok(observedSignal, 'AbortController signal must be threaded to fetch');
    // Sanity: the endpoint-timeouts table declares planGeneration === 55_000.
    const { ENDPOINT_TIMEOUTS_MS } = require('../src/webapp-client');
    assert.equal(ENDPOINT_TIMEOUTS_MS.planGeneration, 55_000);
  } finally {
    global.fetch = savedFetch;
  }
});

test('planGeneration returns { fallback: "endpoint_absent" } on HTTP 404 (no throw)', async () => {
  const savedFetch = global.fetch;
  try {
    global.fetch = mockFetch(async () => jsonResponse({ error: 'Not Found' }, 404));

    const client = new WebappClient({
      apiKey: 'tb_test_key',
      dashboardUrl: 'http://127.0.0.1:3000',
    });

    const result = await client.planGeneration({ context: {}, projectInfo: {} });
    assert.deepEqual(result, { fallback: 'endpoint_absent' });
  } finally {
    global.fetch = savedFetch;
  }
});

test('planGeneration throws WEBAPP_TIMEOUT on AbortError', async () => {
  const savedFetch = global.fetch;
  try {
    global.fetch = mockFetch(
      ({ init }) =>
        new Promise((_resolve, reject) => {
          const signal = init.signal;
          if (signal.aborted) {
            const err = new Error('aborted');
            err.name = 'AbortError';
            return reject(err);
          }
          signal.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );

    const client = new WebappClient({
      apiKey: 'tb_test_key',
      dashboardUrl: 'http://127.0.0.1:3000',
    });

    const table = require('../src/webapp-client').ENDPOINT_TIMEOUTS_MS;
    const saved = table.planGeneration;
    table.planGeneration = 50;

    try {
      await assert.rejects(
        () => client.planGeneration({ context: {}, projectInfo: {} }),
        (err) => err.code === 'WEBAPP_TIMEOUT',
      );
    } finally {
      table.planGeneration = saved;
    }
  } finally {
    global.fetch = savedFetch;
  }
});

test('planGeneration passes through HTTP 200 { success: false } without transforming', async () => {
  const savedFetch = global.fetch;
  try {
    global.fetch = mockFetch(async () =>
      jsonResponse({ success: false, fallback: 'rule_based', reason: 'OPENAI_KEY_MISSING' }, 200),
    );

    const client = new WebappClient({
      apiKey: 'tb_test_key',
      dashboardUrl: 'http://127.0.0.1:3000',
    });

    const result = await client.planGeneration({ context: {}, projectInfo: {} });
    assert.equal(result.success, false);
    assert.equal(result.fallback, 'rule_based');
    assert.equal(result.reason, 'OPENAI_KEY_MISSING');
  } finally {
    global.fetch = savedFetch;
  }
});
