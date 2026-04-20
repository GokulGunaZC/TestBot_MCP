'use strict';

/**
 * Unit tests for src/webapp-client.js. Focus: per-agent chunked calls
 * (`generateTestsForAgent`) that the pipeline-worker uses to fan out 5
 * parallel requests under Vercel Hobby's 60s ceiling.
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

test('generateTestsForAgent sends agents:[agent] and uses a 55s timeout', async () => {
  const savedFetch = global.fetch;
  try {
    let observedSignal = null;
    global.fetch = mockFetch(async ({ init }) => {
      observedSignal = init.signal;
      assert.equal(init.method, 'POST');
      const body = JSON.parse(init.body);
      assert.deepEqual(body.agents, ['smoke']);
      assert.equal(body.api_key, 'tb_test_key');
      return jsonResponse({ success: true, tests: [], generationMeta: {}, agentRuns: [] });
    });

    const client = new WebappClient({
      apiKey: 'tb_test_key',
      dashboardUrl: 'http://127.0.0.1:3000',
    });

    const startedAt = Date.now();
    const result = await client.generateTestsForAgent({
      agent: 'smoke',
      context: {},
      prd: 'x',
      parsedPRD: null,
      explorationArtifact: null,
      roles: [],
      testType: 'both',
      projectInfo: {},
      options: {},
    });

    assert.ok(result.success);
    assert.ok(observedSignal, 'AbortController signal must be threaded to fetch');
    // sanity: call returns well under 55s
    assert.ok(Date.now() - startedAt < 5_000);
  } finally {
    global.fetch = savedFetch;
  }
});

test('generateTestsForAgent rejects unknown agent names client-side without fetching', async () => {
  const savedFetch = global.fetch;
  try {
    let called = false;
    global.fetch = mockFetch(async () => {
      called = true;
      return jsonResponse({ success: true });
    });

    const client = new WebappClient({ apiKey: 'tb_test_key', dashboardUrl: 'http://127.0.0.1:3000' });

    await assert.rejects(
      () => client.generateTestsForAgent({ agent: 'bogus' }),
      (err) => err.code === 'INVALID_AGENT'
    );
    assert.equal(called, false, 'no HTTP call should be made for an invalid agent');
  } finally {
    global.fetch = savedFetch;
  }
});

test('generateTestsForAgent surfaces HTTP 400 INVALID_AGENTS from webapp as WEBAPP_ERROR', async () => {
  const savedFetch = global.fetch;
  try {
    global.fetch = mockFetch(async () =>
      jsonResponse({ error: 'INVALID_AGENTS', allowed: ['smoke'], unknown: ['smokey'] }, 400)
    );

    const client = new WebappClient({ apiKey: 'tb_test_key', dashboardUrl: 'http://127.0.0.1:3000' });

    await assert.rejects(
      () => client.generateTestsForAgent({ agent: 'smoke' }),
      (err) => {
        assert.equal(err.status, 400);
        // 400 is not one of the special-cased status codes → generic WEBAPP_ERROR
        assert.equal(err.code, 'WEBAPP_ERROR');
        return true;
      }
    );
  } finally {
    global.fetch = savedFetch;
  }
});

test('generateTestsForAgent propagates WEBAPP_TIMEOUT when AbortController fires', async () => {
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
        })
    );

    // Construct with an absurdly low timeout so we hit the abort branch quickly.
    const client = new WebappClient({ apiKey: 'tb_test_key', dashboardUrl: 'http://127.0.0.1:3000' });
    // Force a short timeout on this one call by monkey-patching endpoint table
    // via private field access — cleaner than a full re-wire.
    const origTable = require('../src/webapp-client').ENDPOINT_TIMEOUTS_MS;
    const originalValue = origTable.generateTestsForAgent;
    origTable.generateTestsForAgent = 50;

    try {
      await assert.rejects(
        () => client.generateTestsForAgent({ agent: 'smoke' }),
        (err) => err.code === 'WEBAPP_TIMEOUT'
      );
    } finally {
      origTable.generateTestsForAgent = originalValue;
    }
  } finally {
    global.fetch = savedFetch;
  }
});

test('legacy generateTests still works unchanged (back-compat)', async () => {
  const savedFetch = global.fetch;
  try {
    global.fetch = mockFetch(async ({ init }) => {
      const body = JSON.parse(init.body);
      assert.equal(body.agents, undefined, 'legacy path does not send agents[]');
      return jsonResponse({ success: true, tests: [{ filename: 'x.spec.ts', content: '// ok' }] });
    });

    const client = new WebappClient({ apiKey: 'tb_test_key', dashboardUrl: 'http://127.0.0.1:3000' });
    const result = await client.generateTests({
      context: {}, testType: 'both', projectInfo: {}, options: {},
    });
    assert.equal(result.tests.length, 1);
  } finally {
    global.fetch = savedFetch;
  }
});
