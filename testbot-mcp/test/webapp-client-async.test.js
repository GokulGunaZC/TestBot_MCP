'use strict';

/**
 * Unit tests for the P2-g async generation client methods:
 *   - WebappClient#generateTestsAsync  (202 enqueue + sync back-compat)
 *   - WebappClient#pollGenerationJob   (ETag 304, backoff, transient retry,
 *                                       abort, overall timeout, hard 401/403/404)
 *
 * Pattern mirrors webapp-client-plan.test.js: monkey-patch `global.fetch`
 * and assert over the captured requests. No network.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const WebappClient = require('../src/webapp-client');
const { computePollBackoffMs } = WebappClient;

function mockFetch(impl) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return impl({ url, init, callIndex: calls.length - 1 });
  };
  fn.calls = calls;
  return fn;
}

function headersMap(obj = {}) {
  // Minimal Headers-like object with .get() — matches webapp-client's access
  // pattern (`response.headers.get('etag')`).
  const lower = {};
  for (const k of Object.keys(obj)) lower[k.toLowerCase()] = obj[k];
  return {
    get(name) {
      return lower[String(name).toLowerCase()] ?? null;
    },
  };
}

function jsonResponse(body, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: headersMap(headers),
    text: async () => (body == null ? '' : JSON.stringify(body)),
  };
}

// --------------------------------------------------------------------------
// generateTestsAsync
// --------------------------------------------------------------------------

test('generateTestsAsync sends async:true body + x-healix-async header and returns {mode:"async"} on 202', async () => {
  const savedFetch = global.fetch;
  try {
    let captured = null;
    global.fetch = mockFetch(async ({ init, url }) => {
      assert.ok(url.endsWith('/api/generate-tests'));
      assert.equal(init.method, 'POST');
      captured = { headers: init.headers, body: JSON.parse(init.body) };
      return jsonResponse(
        { jobId: 'job_abc', status: 'queued', agentsRequested: ['smoke', 'api'] },
        202,
      );
    });

    const client = new WebappClient({
      apiKey: 'tb_test_key',
      dashboardUrl: 'http://127.0.0.1:3000',
    });

    const result = await client.generateTestsAsync({
      agents: ['smoke', 'api'],
      context: { pages: [] },
      prd: 'PRD',
      projectInfo: {},
      options: {},
    });

    assert.deepEqual(result, {
      mode: 'async',
      jobId: 'job_abc',
      status: 'queued',
      agentsRequested: ['smoke', 'api'],
    });

    assert.equal(captured.body.async, true);
    assert.deepEqual(captured.body.agents, ['smoke', 'api']);
    assert.equal(captured.body.api_key, 'tb_test_key');
    assert.equal(captured.headers['x-healix-async'], '1');
    assert.equal(captured.headers['x-api-key'], 'tb_test_key');
  } finally {
    global.fetch = savedFetch;
  }
});

test('generateTestsAsync returns {mode:"sync", payload} on HTTP 200 (back-compat)', async () => {
  const savedFetch = global.fetch;
  try {
    global.fetch = mockFetch(async () =>
      jsonResponse(
        { success: true, tests: [{ filename: 'a.spec.ts', content: '// ok' }], generationMeta: {} },
        200,
      ),
    );

    const client = new WebappClient({
      apiKey: 'tb_test_key',
      dashboardUrl: 'http://127.0.0.1:3000',
    });

    const result = await client.generateTestsAsync({
      agents: ['smoke'],
      context: {},
      projectInfo: {},
      options: {},
    });

    assert.equal(result.mode, 'sync');
    assert.ok(result.payload);
    assert.equal(result.payload.success, true);
    assert.equal(result.payload.tests.length, 1);
  } finally {
    global.fetch = savedFetch;
  }
});

test('generateTestsAsync throws WEBAPP_TIMEOUT when the enqueue call exceeds 10s', async () => {
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

    const table = require('../src/webapp-client').ENDPOINT_TIMEOUTS_MS;
    const saved = table.generateTestsAsync;
    table.generateTestsAsync = 50;

    try {
      const client = new WebappClient({
        apiKey: 'tb_test_key',
        dashboardUrl: 'http://127.0.0.1:3000',
      });
      await assert.rejects(
        () =>
          client.generateTestsAsync({
            agents: ['smoke'],
            context: {},
            projectInfo: {},
            options: {},
          }),
        (err) => err.code === 'WEBAPP_TIMEOUT',
      );
    } finally {
      table.generateTestsAsync = saved;
    }
  } finally {
    global.fetch = savedFetch;
  }
});

test('generateTestsAsync surfaces 500 as WEBAPP_SERVER_ERROR with the server detail', async () => {
  const savedFetch = global.fetch;
  try {
    global.fetch = mockFetch(async () => jsonResponse({ error: 'boom' }, 500));

    const client = new WebappClient({
      apiKey: 'tb_test_key',
      dashboardUrl: 'http://127.0.0.1:3000',
    });

    await assert.rejects(
      () =>
        client.generateTestsAsync({
          agents: ['smoke'],
          context: {},
          projectInfo: {},
          options: {},
        }),
      (err) => {
        assert.equal(err.status, 500);
        assert.equal(err.code, 'WEBAPP_SERVER_ERROR');
        return true;
      },
    );
  } finally {
    global.fetch = savedFetch;
  }
});

// --------------------------------------------------------------------------
// pollGenerationJob
// --------------------------------------------------------------------------

test('pollGenerationJob calls onProgress each iteration and resolves on succeeded', async () => {
  const savedFetch = global.fetch;
  try {
    const scripted = [
      { status: 'queued', agentsCompleted: 0, agentsRequested: ['smoke', 'api'] },
      { status: 'running', agentsCompleted: 1, agentsRequested: ['smoke', 'api'] },
      {
        status: 'succeeded',
        agentsCompleted: 2,
        agentsRequested: ['smoke', 'api'],
        tests: [{ filename: 'a.spec.ts', content: '// ok' }],
        generationMeta: { totalTests: 1 },
        errors: [],
      },
    ];

    global.fetch = mockFetch(async ({ callIndex }) => jsonResponse(scripted[callIndex], 200));

    const progress = [];
    const client = new WebappClient({
      apiKey: 'tb_test_key',
      dashboardUrl: 'http://127.0.0.1:3000',
    });

    const result = await client.pollGenerationJob({
      jobId: 'job_abc',
      onProgress: (p) => progress.push(p),
      pollIntervalMs: 1, // keep the test fast
      timeoutMs: 10_000,
    });

    assert.equal(result.status, 'succeeded');
    assert.equal(result.tests.length, 1);
    assert.equal(progress.length, 3);
    assert.equal(progress[0].status, 'queued');
    assert.equal(progress[2].status, 'succeeded');
  } finally {
    global.fetch = savedFetch;
  }
});

test('pollGenerationJob sends If-None-Match on subsequent requests; 304 still emits onProgress with prior body', async () => {
  const savedFetch = global.fetch;
  try {
    const firstBody = {
      status: 'running',
      agentsCompleted: 0,
      agentsRequested: ['smoke'],
      tests: [],
      generationMeta: {},
      errors: [],
    };
    const terminalBody = {
      ...firstBody,
      status: 'succeeded',
      agentsCompleted: 1,
      tests: [{ filename: 'a.spec.ts', content: '// ok' }],
    };

    global.fetch = mockFetch(async ({ callIndex }) => {
      if (callIndex === 0) return jsonResponse(firstBody, 200, { ETag: '"v1"' });
      if (callIndex === 1) {
        return {
          ok: false,
          status: 304,
          headers: headersMap({ ETag: '"v1"' }),
          text: async () => '',
        };
      }
      return jsonResponse(terminalBody, 200, { ETag: '"v2"' });
    });

    const progress = [];
    const client = new WebappClient({
      apiKey: 'tb_test_key',
      dashboardUrl: 'http://127.0.0.1:3000',
    });

    const result = await client.pollGenerationJob({
      jobId: 'job_abc',
      onProgress: (p) => progress.push(p),
      pollIntervalMs: 1,
      timeoutMs: 10_000,
    });

    assert.equal(result.status, 'succeeded');
    // 1st call: no If-None-Match. 2nd call: If-None-Match: "v1". 3rd call: same.
    const call0 = global.fetch.calls[0];
    const call1 = global.fetch.calls[1];
    assert.equal(call0.init.headers['If-None-Match'], undefined);
    assert.equal(call1.init.headers['If-None-Match'], '"v1"');
    // onProgress fires for the 304 too, carrying forward the prior body.
    assert.equal(progress.length, 3);
    assert.equal(progress[1].status, 'running'); // same as progress[0]
    assert.equal(progress[1].agentsCompleted, 0);
  } finally {
    global.fetch = savedFetch;
  }
});

test('pollGenerationJob rejects WEBAPP_TIMEOUT when overall elapsed exceeds timeoutMs', async () => {
  const savedFetch = global.fetch;
  try {
    global.fetch = mockFetch(async () =>
      jsonResponse(
        { status: 'running', agentsCompleted: 0, agentsRequested: ['smoke'] },
        200,
      ),
    );

    const client = new WebappClient({
      apiKey: 'tb_test_key',
      dashboardUrl: 'http://127.0.0.1:3000',
    });

    await assert.rejects(
      () =>
        client.pollGenerationJob({
          jobId: 'job_abc',
          pollIntervalMs: 30,
          timeoutMs: 50,
        }),
      (err) => err.code === 'WEBAPP_TIMEOUT',
    );
  } finally {
    global.fetch = savedFetch;
  }
});

test('pollGenerationJob rejects POLL_ABORTED when signal aborts mid-loop and stops fetching', async () => {
  const savedFetch = global.fetch;
  try {
    const controller = new AbortController();
    let callsBeforeAbort = 0;

    global.fetch = mockFetch(async ({ callIndex }) => {
      callsBeforeAbort = callIndex + 1;
      // Abort on the second fetch so we exercise the mid-loop path.
      if (callIndex === 1) {
        queueMicrotask(() => controller.abort());
      }
      return jsonResponse(
        { status: 'running', agentsCompleted: 0, agentsRequested: ['smoke'] },
        200,
      );
    });

    const client = new WebappClient({
      apiKey: 'tb_test_key',
      dashboardUrl: 'http://127.0.0.1:3000',
    });

    await assert.rejects(
      () =>
        client.pollGenerationJob({
          jobId: 'job_abc',
          pollIntervalMs: 50,
          timeoutMs: 10_000,
          signal: controller.signal,
        }),
      (err) => {
        assert.equal(err.code, 'POLL_ABORTED');
        assert.equal(err.name, 'AbortError');
        return true;
      },
    );

    const callsAfterReject = global.fetch.calls.length;
    // Give the event loop a tick to prove no more fetches are scheduled.
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(
      global.fetch.calls.length,
      callsAfterReject,
      'no further fetch calls after abort',
    );
    assert.ok(callsBeforeAbort >= 2);
  } finally {
    global.fetch = savedFetch;
  }
});

test('pollGenerationJob maps 401 → INVALID_API_KEY, 404 → JOB_NOT_FOUND, 403 → JOB_ACCESS_DENIED (no retry)', async () => {
  const cases = [
    { status: 401, code: 'INVALID_API_KEY' },
    { status: 404, code: 'JOB_NOT_FOUND' },
    { status: 403, code: 'JOB_ACCESS_DENIED' },
  ];

  for (const { status, code } of cases) {
    const savedFetch = global.fetch;
    try {
      let callCount = 0;
      global.fetch = mockFetch(async () => {
        callCount += 1;
        return jsonResponse({ error: 'nope' }, status);
      });

      const client = new WebappClient({
        apiKey: 'tb_test_key',
        dashboardUrl: 'http://127.0.0.1:3000',
      });

      await assert.rejects(
        () =>
          client.pollGenerationJob({
            jobId: 'job_abc',
            pollIntervalMs: 1,
            timeoutMs: 10_000,
          }),
        (err) => err.code === code,
      );
      assert.equal(callCount, 1, `${status} should not retry`);
    } finally {
      global.fetch = savedFetch;
    }
  }
});

test('pollGenerationJob retries transient 500s (up to 5) and succeeds on the 4th try', async () => {
  const savedFetch = global.fetch;
  try {
    global.fetch = mockFetch(async ({ callIndex }) => {
      if (callIndex < 3) return jsonResponse({ error: 'srv' }, 500);
      return jsonResponse(
        {
          status: 'succeeded',
          agentsCompleted: 1,
          agentsRequested: ['smoke'],
          tests: [{ filename: 'a.spec.ts', content: '// ok' }],
          generationMeta: {},
          errors: [],
        },
        200,
      );
    });

    const progress = [];
    const client = new WebappClient({
      apiKey: 'tb_test_key',
      dashboardUrl: 'http://127.0.0.1:3000',
    });

    // Shorten the internal 2s transient backoff indirectly via a tiny
    // pollIntervalMs + fast wall time isn't possible (backoff is hard-coded),
    // so this test pays ~6s. Keep it reasonable under node:test's default.
    const result = await client.pollGenerationJob({
      jobId: 'job_abc',
      onProgress: (p) => progress.push(p),
      pollIntervalMs: 1,
      timeoutMs: 30_000,
    });

    assert.equal(result.status, 'succeeded');
    assert.equal(progress.length, 1, 'onProgress fires once — only for the 200');
    assert.equal(progress[0].status, 'succeeded');
    assert.equal(global.fetch.calls.length, 4);
  } finally {
    global.fetch = savedFetch;
  }
});

test('pollGenerationJob rejects WEBAPP_UNREACHABLE after 5 consecutive 500s', async () => {
  const savedFetch = global.fetch;
  try {
    global.fetch = mockFetch(async () => jsonResponse({ error: 'srv' }, 500));

    const client = new WebappClient({
      apiKey: 'tb_test_key',
      dashboardUrl: 'http://127.0.0.1:3000',
    });

    await assert.rejects(
      () =>
        client.pollGenerationJob({
          jobId: 'job_abc',
          pollIntervalMs: 1,
          timeoutMs: 60_000,
        }),
      (err) => {
        assert.equal(err.code, 'WEBAPP_UNREACHABLE');
        return true;
      },
    );
    assert.equal(global.fetch.calls.length, 5);
  } finally {
    global.fetch = savedFetch;
  }
});

test('computePollBackoffMs: first 10 iterations use base; then 5s / 8s / 12s / 15s', () => {
  // Base interval smaller than the step: caller asked for fast polls early,
  // but the schedule stretches once the job is clearly idle.
  assert.equal(computePollBackoffMs(0, 3_000), 3_000);
  assert.equal(computePollBackoffMs(9, 3_000), 3_000);
  assert.equal(computePollBackoffMs(10, 3_000), 5_000);
  assert.equal(computePollBackoffMs(19, 3_000), 5_000);
  assert.equal(computePollBackoffMs(20, 3_000), 8_000);
  assert.equal(computePollBackoffMs(30, 3_000), 12_000);
  assert.equal(computePollBackoffMs(40, 3_000), 15_000);
  assert.equal(computePollBackoffMs(100, 3_000), 15_000);

  // Base interval larger than the step: the floor stays at the caller's base.
  assert.equal(computePollBackoffMs(0, 20_000), 20_000);
  assert.equal(computePollBackoffMs(15, 20_000), 20_000);
  assert.equal(computePollBackoffMs(45, 20_000), 20_000);
});

test('pollGenerationJob: 11th no-change iteration sleeps at least ~5s (synthetic timing)', async () => {
  const savedFetch = global.fetch;
  try {
    // Serve 12 "running, agentsCompleted=0" responses, then a terminal.
    global.fetch = mockFetch(async ({ callIndex }) => {
      if (callIndex < 12) {
        return jsonResponse(
          { status: 'running', agentsCompleted: 0, agentsRequested: ['smoke'] },
          200,
        );
      }
      return jsonResponse(
        {
          status: 'succeeded',
          agentsCompleted: 1,
          agentsRequested: ['smoke'],
          tests: [],
          generationMeta: {},
          errors: [],
        },
        200,
      );
    });

    const client = new WebappClient({
      apiKey: 'tb_test_key',
      dashboardUrl: 'http://127.0.0.1:3000',
    });

    // Track wall-clock gap between the 10th and 11th fetch calls by stamping
    // the fetch mock. We can't patch setTimeout without breaking everything,
    // so instead we bound the test to a tiny pollIntervalMs (no base-level
    // delay) and assert the schedule *kicked in* at the expected iteration.
    // Small fudge factor — different hosts have different scheduler jitter.
    const stamps = [];
    const wrapped = global.fetch;
    global.fetch = mockFetch(async ({ callIndex, url, init }) => {
      stamps.push(Date.now());
      return wrapped(url, init);
    });

    const result = await client.pollGenerationJob({
      jobId: 'job_abc',
      pollIntervalMs: 10, // base is fast
      timeoutMs: 60_000,
    });
    assert.equal(result.status, 'succeeded');

    // Between call #10 (index 10) and call #11 (index 11) — i.e. the gap
    // AFTER the 11th poll has returned and before the 12th — we've seen 10
    // consecutive no-changes, so the schedule should have bumped to ≥5s.
    // Practically: stamps[11] - stamps[10] ≥ 5000.
    assert.ok(stamps.length >= 12);
    const gap = stamps[11] - stamps[10];
    assert.ok(
      gap >= 4_800,
      `expected ≥4800ms between 11th and 12th poll, got ${gap}ms`,
    );
    assert.ok(
      gap < 7_000,
      `expected <7000ms between 11th and 12th poll, got ${gap}ms`,
    );
  } finally {
    global.fetch = savedFetch;
  }
});
