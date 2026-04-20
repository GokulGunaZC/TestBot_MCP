'use strict';

/**
 * P2-h — async generation path wiring inside maybeGenerateViaSaaS.
 *
 * Contract under test:
 *   1. HEALIX_GEN_ASYNC=true routes through client.generateTestsAsync +
 *      client.pollGenerationJob (NOT the per-agent parallel fan-out).
 *   2. onProgress partials are written to disk progressively; each new
 *      test file is deduped by filename so repeated onProgress payloads
 *      don't double-write.
 *   3. The final response's `tests` array is folded in — tests surfaced
 *      only in the terminal payload still land on disk.
 *   4. `generationMeta.chunkingStrategy === 'async_inngest'` and `jobId`
 *      is threaded through.
 *   5. `status==='partial'` with errors returns successfully with
 *      `agentFailures[]` populated.
 *   6. `status==='failed'` with zero tests on disk throws
 *      ALL_AGENTS_FAILED carrying `err.agentFailures`.
 *   7. Sync-mode back-compat: when the webapp returns `{mode:'sync'}`,
 *      the payload's tests are written directly — no second round-trip.
 *   8. With HEALIX_GEN_ASYNC unset/off, generateTestsAsync is never
 *      called; the Phase-1 generateTestsForAgent fan-out runs instead.
 *   9. statusDir/status.json ends with the final generation_async_progress
 *      tick (matches the shape consumers rely on).
 *
 * Why a dedicated test: regressions here would silently flip customers
 * between two very different codepaths (per-agent HTTP fan-out vs
 * Inngest orchestrator job). The env-flag gate is the ONLY guard, so it
 * has to be pinned by tests.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const WebappClient = require('../src/webapp-client');
const { maybeGenerateViaSaaS } = require('../src/pipeline-worker');

function mkTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* noop */
  }
}

function spec(filename, agent = 'smoke') {
  return {
    filename,
    content: `import { test } from '@playwright/test';\ntest('${filename}', async () => {});`,
    type: agent,
    agent,
  };
}

/**
 * Monkey-patch both async entry points. Returns a restore() + captured
 * invocations so tests can assert over them without a network round-trip.
 *
 * @param {object} opts
 * @param {(args) => object} opts.generateTestsAsyncImpl
 * @param {(args) => Promise<object>} [opts.pollGenerationJobImpl]
 * @param {(args) => object} [opts.generateTestsForAgentImpl]
 */
function patchClient({
  generateTestsAsyncImpl,
  pollGenerationJobImpl,
  generateTestsForAgentImpl,
} = {}) {
  const origAsync = WebappClient.prototype.generateTestsAsync;
  const origPoll = WebappClient.prototype.pollGenerationJob;
  const origPerAgent = WebappClient.prototype.generateTestsForAgent;
  const origPlan = WebappClient.prototype.planGeneration;

  const asyncCalls = [];
  const pollCalls = [];
  const perAgentCalls = [];

  if (generateTestsAsyncImpl) {
    WebappClient.prototype.generateTestsAsync = async function (args) {
      asyncCalls.push(args);
      return generateTestsAsyncImpl(args);
    };
  }

  if (pollGenerationJobImpl) {
    WebappClient.prototype.pollGenerationJob = async function (args) {
      pollCalls.push(args);
      return pollGenerationJobImpl(args);
    };
  }

  if (generateTestsForAgentImpl) {
    WebappClient.prototype.generateTestsForAgent = async function (args) {
      perAgentCalls.push(args);
      return generateTestsForAgentImpl(args);
    };
  }

  // Keep the planner predictable — always return "plan skipped" so the
  // pre-pass doesn't try to hit the real network during tests.
  WebappClient.prototype.planGeneration = async function () {
    return { fallback: 'endpoint_absent' };
  };

  return {
    asyncCalls,
    pollCalls,
    perAgentCalls,
    restore: () => {
      WebappClient.prototype.generateTestsAsync = origAsync;
      WebappClient.prototype.pollGenerationJob = origPoll;
      WebappClient.prototype.generateTestsForAgent = origPerAgent;
      WebappClient.prototype.planGeneration = origPlan;
    },
  };
}

/**
 * Build a pollGenerationJob stub that invokes onProgress for each scripted
 * tick, then resolves with the final payload. All calls are synchronous-ish
 * (microtask chain) so tests finish fast.
 */
function scriptedPoll({ progressTicks, finalResponse }) {
  return async ({ onProgress }) => {
    for (const tick of progressTicks || []) {
      try { if (typeof onProgress === 'function') onProgress(tick); } catch { /* noop */ }
      // Yield to the microtask queue so writes can interleave naturally.
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve();
    }
    return finalResponse;
  };
}

function setEnvForAsync() {
  const saved = {
    HEALIX_API_KEY: process.env.HEALIX_API_KEY,
    HEALIX_GEN_ASYNC: process.env.HEALIX_GEN_ASYNC,
    HEALIX_SKIP_PLANNER: process.env.HEALIX_SKIP_PLANNER,
  };
  process.env.HEALIX_API_KEY = 'tb_test_fake';
  process.env.HEALIX_GEN_ASYNC = 'true';
  process.env.HEALIX_SKIP_PLANNER = '1'; // belt-and-suspenders; stub also covers it
  return () => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
}

// ── 1. Progressive partials ─────────────────────────────────────────────────

test('async path: progressive partials are written + deduped as onProgress fires', async () => {
  const projectPath = mkTmpDir('healix-async-prog-');
  const testsDir = path.join(projectPath, 'tests', 'generated');
  fs.mkdirSync(testsDir, { recursive: true });
  const statusDir = mkTmpDir('healix-async-status-');
  const restoreEnv = setEnvForAsync();

  const progressTicks = [
    { status: 'running', agentsCompleted: ['smoke'], tests: [spec('smoke-a.spec.ts', 'smoke')] },
    {
      status: 'running',
      agentsCompleted: ['smoke', 'api'],
      tests: [
        spec('smoke-a.spec.ts', 'smoke'),      // duplicate filename — must not write twice
        spec('api-b.spec.ts', 'api'),
      ],
    },
    {
      status: 'running',
      agentsCompleted: ['smoke', 'api', 'frontend'],
      tests: [
        spec('smoke-a.spec.ts', 'smoke'),
        spec('api-b.spec.ts', 'api'),
        spec('fe-c.spec.ts', 'frontend'),
      ],
    },
  ];
  const finalResponse = {
    status: 'succeeded',
    agentsCompleted: ['smoke', 'api', 'frontend', 'workflow', 'error'],
    tests: [
      spec('smoke-a.spec.ts', 'smoke'),
      spec('api-b.spec.ts', 'api'),
      spec('fe-c.spec.ts', 'frontend'),
    ],
    errors: [],
    generationMeta: { totalTestsFromServer: 3 },
  };

  const patch = patchClient({
    generateTestsAsyncImpl: () => ({
      mode: 'async',
      jobId: 'job-abc',
      status: 'queued',
      agentsRequested: ['smoke', 'api', 'frontend', 'workflow', 'error'],
    }),
    pollGenerationJobImpl: scriptedPoll({ progressTicks, finalResponse }),
  });

  try {
    const result = await maybeGenerateViaSaaS({
      config: { projectPath, testType: 'both' },
      context: { pages: [] },
      prdContent: '',
      testsDir,
      projectInfo: {},
      parsedPRD: null,
      explorationArtifact: null,
      roles: [],
      statusDir,
      runId: 'run-async-1',
    });

    // Three unique files — filename dedupe means the repeated 'smoke-a'
    // across ticks is written exactly once.
    assert.equal(result.generated, 3);
    assert.equal(result.provider, 'saas');

    const written = fs.readdirSync(testsDir).sort();
    assert.deepEqual(written, ['api-b.spec.ts', 'fe-c.spec.ts', 'smoke-a.spec.ts']);

    // generationMeta shape pins the dashboard contract.
    assert.equal(result.generationMeta.chunkingStrategy, 'async_inngest');
    assert.equal(result.generationMeta.jobId, 'job-abc');
    assert.equal(result.generationMeta.status, 'succeeded');
    assert.equal(result.generationMeta.partialsWrittenCount, 3);
    assert.deepEqual(result.generationMeta.agentFailures, []);
    assert.equal(result.generationMeta.totalTestsFromServer, 3);

    // We should have invoked generateTestsAsync exactly once with
    // async-mode plumbing, and NEVER fanned out per-agent.
    assert.equal(patch.asyncCalls.length, 1);
    assert.equal(patch.pollCalls.length, 1);
    assert.equal(patch.pollCalls[0].jobId, 'job-abc');
    assert.equal(patch.perAgentCalls.length, 0);

    // status.json final tick ends on generation_async_progress.
    const statusPath = path.join(statusDir, 'status.json');
    const parsed = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
    assert.equal(parsed.phase, 'generation_async_progress');
    assert.equal(parsed.jobId, 'job-abc');
    assert.equal(parsed.generatedCount, 3);
  } finally {
    patch.restore();
    cleanup(projectPath);
    cleanup(statusDir);
    restoreEnv();
  }
});

// ── 2. Dedupe ────────────────────────────────────────────────────────────────

test('async path: repeated filename in successive ticks is written once only', async () => {
  const projectPath = mkTmpDir('healix-async-dedupe-');
  const testsDir = path.join(projectPath, 'tests', 'generated');
  fs.mkdirSync(testsDir, { recursive: true });
  const restoreEnv = setEnvForAsync();

  const progressTicks = [
    { status: 'running', agentsCompleted: ['smoke'], tests: [spec('dup.spec.ts', 'smoke')] },
    { status: 'running', agentsCompleted: ['smoke'], tests: [spec('dup.spec.ts', 'smoke')] },
    { status: 'running', agentsCompleted: ['smoke'], tests: [spec('dup.spec.ts', 'smoke')] },
  ];
  const finalResponse = {
    status: 'succeeded',
    agentsCompleted: ['smoke'],
    tests: [spec('dup.spec.ts', 'smoke')],
    errors: [],
    generationMeta: {},
  };

  const patch = patchClient({
    generateTestsAsyncImpl: () => ({ mode: 'async', jobId: 'job-dup', status: 'queued', agentsRequested: ['smoke'] }),
    pollGenerationJobImpl: scriptedPoll({ progressTicks, finalResponse }),
  });

  try {
    const result = await maybeGenerateViaSaaS({
      config: { projectPath, testType: 'both' },
      context: {},
      prdContent: '',
      testsDir,
      projectInfo: {},
      parsedPRD: null,
      explorationArtifact: null,
      roles: [],
    });

    assert.equal(result.generated, 1, 'single dedupe — exactly one file on disk');
    const written = fs.readdirSync(testsDir);
    assert.equal(written.length, 1);
    assert.equal(written[0], 'dup.spec.ts');
  } finally {
    patch.restore();
    cleanup(projectPath);
    restoreEnv();
  }
});

// ── 3. Status partial + errors → returns successfully ────────────────────────

test('async path: final status=partial with errors returns normally, agentFailures populated', async () => {
  const projectPath = mkTmpDir('healix-async-partial-');
  const testsDir = path.join(projectPath, 'tests', 'generated');
  fs.mkdirSync(testsDir, { recursive: true });
  const restoreEnv = setEnvForAsync();

  const finalResponse = {
    status: 'partial',
    agentsCompleted: ['smoke', 'api', 'frontend'],
    tests: [
      spec('a.spec.ts', 'smoke'),
      spec('b.spec.ts', 'api'),
      spec('c.spec.ts', 'frontend'),
    ],
    errors: [
      { agent: 'workflow', code: 'OPENAI_RATE_LIMITED', message: 'rate limited' },
      { agent: 'error', code: 'AGENT_TIMEOUT', message: 'timed out' },
    ],
    generationMeta: {},
  };

  const patch = patchClient({
    generateTestsAsyncImpl: () => ({
      mode: 'async',
      jobId: 'job-part',
      status: 'queued',
      agentsRequested: ['smoke', 'api', 'frontend', 'workflow', 'error'],
    }),
    pollGenerationJobImpl: scriptedPoll({ progressTicks: [], finalResponse }),
  });

  try {
    const result = await maybeGenerateViaSaaS({
      config: { projectPath, testType: 'both' },
      context: {},
      prdContent: '',
      testsDir,
      projectInfo: {},
      parsedPRD: null,
      explorationArtifact: null,
      roles: [],
    });

    assert.equal(result.generated, 3);
    assert.equal(result.generationMeta.status, 'partial');
    assert.equal(result.generationMeta.agentFailures.length, 2);
    const failureMap = Object.fromEntries(
      result.generationMeta.agentFailures.map((f) => [f.agent, f.code]),
    );
    assert.equal(failureMap.workflow, 'OPENAI_RATE_LIMITED');
    assert.equal(failureMap.error, 'AGENT_TIMEOUT');
    assert.deepEqual(
      [...result.generationMeta.agentsCompleted].sort(),
      ['api', 'frontend', 'smoke'],
    );
  } finally {
    patch.restore();
    cleanup(projectPath);
    restoreEnv();
  }
});

// ── 4. Status failed with 0 tests → throws ALL_AGENTS_FAILED ─────────────────

test('async path: status=failed with zero tests throws ALL_AGENTS_FAILED with agentFailures', async () => {
  const projectPath = mkTmpDir('healix-async-allfail-');
  const testsDir = path.join(projectPath, 'tests', 'generated');
  fs.mkdirSync(testsDir, { recursive: true });
  const restoreEnv = setEnvForAsync();

  const finalResponse = {
    status: 'failed',
    agentsCompleted: [],
    tests: [],
    errors: [
      { agent: 'smoke', code: 'OPENAI_RATE_LIMITED', message: 'rate limited' },
      { agent: 'api', code: 'OPENAI_RATE_LIMITED', message: 'rate limited' },
    ],
    generationMeta: {},
  };

  const patch = patchClient({
    generateTestsAsyncImpl: () => ({
      mode: 'async',
      jobId: 'job-fail',
      status: 'queued',
      agentsRequested: ['smoke', 'api'],
    }),
    pollGenerationJobImpl: scriptedPoll({ progressTicks: [], finalResponse }),
  });

  try {
    await assert.rejects(
      () =>
        maybeGenerateViaSaaS({
          config: { projectPath, testType: 'both' },
          context: {},
          prdContent: '',
          testsDir,
          projectInfo: {},
          parsedPRD: null,
          explorationArtifact: null,
          roles: [],
        }),
      (err) => {
        assert.equal(err.code, 'ALL_AGENTS_FAILED');
        assert.ok(Array.isArray(err.agentFailures));
        assert.ok(err.agentFailures.length > 0);
        assert.equal(err.jobId, 'job-fail');
        return true;
      },
    );

    // No partials on disk — hard-fail branch.
    assert.equal(fs.readdirSync(testsDir).length, 0);
  } finally {
    patch.restore();
    cleanup(projectPath);
    restoreEnv();
  }
});

// ── 5. Sync fallback ─────────────────────────────────────────────────────────

test('async path: {mode:"sync"} back-compat writes payload.tests directly + returns saas result', async () => {
  const projectPath = mkTmpDir('healix-async-sync-');
  const testsDir = path.join(projectPath, 'tests', 'generated');
  fs.mkdirSync(testsDir, { recursive: true });
  const restoreEnv = setEnvForAsync();

  const patch = patchClient({
    generateTestsAsyncImpl: () => ({
      mode: 'sync',
      payload: {
        success: true,
        tests: [
          spec('sync-a.spec.ts', 'smoke'),
          spec('sync-b.spec.ts', 'api'),
        ],
        generationMeta: { legacyServer: true },
      },
    }),
    // pollGenerationJob should NEVER be hit on the sync-fallback path.
    pollGenerationJobImpl: async () => {
      throw new Error('pollGenerationJob must not be called on sync fallback');
    },
  });

  try {
    const result = await maybeGenerateViaSaaS({
      config: { projectPath, testType: 'both' },
      context: {},
      prdContent: '',
      testsDir,
      projectInfo: {},
      parsedPRD: null,
      explorationArtifact: null,
      roles: [],
    });

    assert.equal(result.provider, 'saas');
    assert.equal(result.generated, 2);
    const written = fs.readdirSync(testsDir).sort();
    assert.deepEqual(written, ['sync-a.spec.ts', 'sync-b.spec.ts']);

    // The sync fallback emits its own strategy tag so dashboard can tell
    // it apart from the fully async path. legacyServer key should bleed
    // through from the legacy generationMeta.
    assert.equal(result.generationMeta.chunkingStrategy, 'async_sync_fallback');
    assert.equal(result.generationMeta.legacyServer, true);

    assert.equal(patch.asyncCalls.length, 1);
    assert.equal(patch.pollCalls.length, 0, 'poll must NOT run on sync fallback');
  } finally {
    patch.restore();
    cleanup(projectPath);
    restoreEnv();
  }
});

// ── 6. Env flag OFF → Phase-1 fan-out ────────────────────────────────────────

test('env flag off: HEALIX_GEN_ASYNC=false → generateTestsAsync NEVER called; Phase-1 fan-out runs', async () => {
  const projectPath = mkTmpDir('healix-async-flagoff-');
  const testsDir = path.join(projectPath, 'tests', 'generated');
  fs.mkdirSync(testsDir, { recursive: true });

  const savedKey = process.env.HEALIX_API_KEY;
  const savedFlag = process.env.HEALIX_GEN_ASYNC;
  const savedSkip = process.env.HEALIX_SKIP_PLANNER;
  process.env.HEALIX_API_KEY = 'tb_test_fake';
  process.env.HEALIX_GEN_ASYNC = 'false';
  process.env.HEALIX_SKIP_PLANNER = '1';

  const patch = patchClient({
    // If the code wrongly hits async, this stub records the call so we can fail.
    generateTestsAsyncImpl: () => ({
      mode: 'async',
      jobId: 'job-should-not-fire',
      status: 'queued',
      agentsRequested: [],
    }),
    generateTestsForAgentImpl: ({ agent }) => ({
      success: true,
      tests: [spec(`${agent}-0.spec.ts`, agent)],
      generationMeta: {},
    }),
  });

  try {
    const result = await maybeGenerateViaSaaS({
      config: { projectPath, testType: 'both' },
      context: {},
      prdContent: '',
      testsDir,
      projectInfo: {},
      parsedPRD: null,
      explorationArtifact: null,
      roles: [],
    });

    // Phase-1 fan-out path returns the OLD strategy tag.
    assert.equal(result.generationMeta.chunkingStrategy, 'per_agent_parallel');
    // All 5 agents should have been called.
    assert.equal(patch.perAgentCalls.length, 5);
    // And the async enqueue path must NOT have fired.
    assert.equal(patch.asyncCalls.length, 0, 'async enqueue forbidden when flag is off');
  } finally {
    patch.restore();
    cleanup(projectPath);
    if (savedKey === undefined) delete process.env.HEALIX_API_KEY;
    else process.env.HEALIX_API_KEY = savedKey;
    if (savedFlag === undefined) delete process.env.HEALIX_GEN_ASYNC;
    else process.env.HEALIX_GEN_ASYNC = savedFlag;
    if (savedSkip === undefined) delete process.env.HEALIX_SKIP_PLANNER;
    else process.env.HEALIX_SKIP_PLANNER = savedSkip;
  }
});
