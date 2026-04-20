'use strict';

/**
 * Per-agent fan-out in maybeGenerateViaSaaS (P1-d).
 *
 * The contract under test:
 *   1. maybeGenerateViaSaaS issues one generateTestsForAgent call per agent
 *      in parallel (Promise.allSettled).
 *   2. Each settled agent's tests are written to disk immediately — partials
 *      must survive a later failure.
 *   3. Per-agent rejections collect into `generationMeta.agentFailures[]`.
 *   4. The call hard-fails only when *every* agent rejects (and 0 files
 *      made it to disk).
 *   5. `updateStatus(statusDir, 'generation_partial', ...)` fires after each
 *      agent lands, with a running `{ agentsCompleted, totalAgents }` count.
 *
 * Why a dedicated test: silent regressions here (e.g. one slow agent
 * canceling the others, or zero-file output being reported as success) would
 * look like "Healix is just broken" in customer land. Partial-success is the
 * whole point of the P1 work.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const WebappClient = require('../src/webapp-client');
const {
  maybeGenerateViaSaaS,
  pickAgentsForRun,
} = require('../src/pipeline-worker');

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

function stubGenerateTestsForAgent(perAgentImpl) {
  const original = WebappClient.prototype.generateTestsForAgent;
  WebappClient.prototype.generateTestsForAgent = async function (args) {
    return perAgentImpl(args);
  };
  return () => {
    WebappClient.prototype.generateTestsForAgent = original;
  };
}

function testSpec(agent, indexWithinAgent) {
  return {
    filename: `${agent}-${indexWithinAgent}.spec.ts`,
    content: `import { test } from '@playwright/test';\ntest('${agent}-${indexWithinAgent}', async () => {});`,
    type: agent,
  };
}

test('pickAgentsForRun: apiOnly collapses to ["api"]', () => {
  assert.deepEqual(pickAgentsForRun('both', { apiOnly: true }), ['api']);
  assert.deepEqual(pickAgentsForRun('frontend', { apiOnly: true }), ['api']);
  assert.deepEqual(pickAgentsForRun('backend', { apiOnly: true }), ['api']);
});

test('pickAgentsForRun: frontend testType drops api agent', () => {
  const list = pickAgentsForRun('frontend', {});
  assert.ok(list.includes('smoke'));
  assert.ok(list.includes('frontend'));
  assert.ok(!list.includes('api'));
  assert.ok(list.includes('workflow'));
  assert.ok(list.includes('error'));
});

test('pickAgentsForRun: backend testType keeps api and skips frontend', () => {
  const list = pickAgentsForRun('backend', {});
  assert.ok(list.includes('smoke'));
  assert.ok(!list.includes('frontend'));
  assert.ok(list.includes('api'));
});

test('pickAgentsForRun: both testType includes all five', () => {
  const list = pickAgentsForRun('both', {});
  assert.deepEqual(new Set(list), new Set(['smoke', 'frontend', 'api', 'workflow', 'error']));
});

test('fan-out: 3 agents succeed, 2 reject — partials land, stage succeeds', async () => {
  const projectPath = mkTmpDir('healix-gen-partial-');
  const testsDir = path.join(projectPath, 'tests', 'generated');
  fs.mkdirSync(testsDir, { recursive: true });
  process.env.HEALIX_API_KEY = 'tb_test_fake';

  const statusDir = mkTmpDir('healix-status-');

  const FAILING = new Set(['workflow', 'error']);
  const restore = stubGenerateTestsForAgent(async ({ agent }) => {
    if (FAILING.has(agent)) {
      const err = new Error(`${agent} blew up`);
      err.code = 'OPENAI_RATE_LIMITED';
      throw err;
    }
    return {
      success: true,
      tests: [testSpec(agent, 0), testSpec(agent, 1)],
      generationMeta: { foo: agent },
    };
  });

  try {
    const result = await maybeGenerateViaSaaS({
      config: { projectPath, testType: 'both' },
      context: { pages: [], workflows: [] },
      prdContent: '',
      testsDir,
      projectInfo: {},
      parsedPRD: null,
      explorationArtifact: null,
      roles: [],
      statusDir,
      runId: 'test-run-partial',
    });

    const fulfilledAgents = ['smoke', 'frontend', 'api']; // 3 success
    assert.equal(result.generated, fulfilledAgents.length * 2, 'two tests per successful agent written');
    assert.equal(result.provider, 'saas');

    // Files on disk reflect the 3 fulfilled agents, 2 files each.
    const written = fs.readdirSync(testsDir).sort();
    assert.equal(written.length, 6);
    for (const agent of fulfilledAgents) {
      assert.ok(
        written.some((f) => f.startsWith(`${agent}-`)),
        `expected a file for ${agent} in ${written.join(',')}`,
      );
    }

    // agentFailures must record the 2 rejections with their codes.
    const failures = result.generationMeta.agentFailures;
    assert.equal(failures.length, 2);
    const failureMap = Object.fromEntries(failures.map((f) => [f.agent, f.code]));
    assert.equal(failureMap.workflow, 'OPENAI_RATE_LIMITED');
    assert.equal(failureMap.error, 'OPENAI_RATE_LIMITED');

    // agentsCompleted = the 3 successes (order not guaranteed under parallelism).
    assert.deepEqual(
      [...result.generationMeta.agentsCompleted].sort(),
      [...fulfilledAgents].sort(),
    );

    // chunkingStrategy tag is what dashboard keys off to render the new UI.
    assert.equal(result.generationMeta.chunkingStrategy, 'per_agent_parallel');
    assert.equal(result.generationMeta.partialsWrittenCount, 6);
  } finally {
    restore();
    cleanup(projectPath);
    cleanup(statusDir);
    delete process.env.HEALIX_API_KEY;
  }
});

test('fan-out: ALL agents reject — stage hard-fails with the first code', async () => {
  const projectPath = mkTmpDir('healix-gen-allfail-');
  const testsDir = path.join(projectPath, 'tests', 'generated');
  fs.mkdirSync(testsDir, { recursive: true });
  process.env.HEALIX_API_KEY = 'tb_test_fake';

  const restore = stubGenerateTestsForAgent(async ({ agent }) => {
    const err = new Error(`${agent} always fails`);
    err.code = 'WEBAPP_TIMEOUT';
    throw err;
  });

  try {
    await assert.rejects(
      () =>
        maybeGenerateViaSaaS({
          config: { projectPath, testType: 'both' },
          context: { pages: [] },
          prdContent: '',
          testsDir,
          projectInfo: {},
          parsedPRD: null,
          explorationArtifact: null,
          roles: [],
        }),
      (err) => {
        assert.equal(err.code, 'WEBAPP_TIMEOUT');
        assert.ok(Array.isArray(err.agentFailures));
        assert.ok(err.agentFailures.length >= 3, 'all agent failures recorded');
        return true;
      },
    );

    // Nothing landed on disk — the fallback chain will move on to the next
    // generator (or rethrow if saas is the only one).
    assert.equal(fs.readdirSync(testsDir).length, 0);
  } finally {
    restore();
    cleanup(projectPath);
    delete process.env.HEALIX_API_KEY;
  }
});

test('fan-out: single agent succeeds — stage still succeeds (not hard-fail)', async () => {
  const projectPath = mkTmpDir('healix-gen-lone-survivor-');
  const testsDir = path.join(projectPath, 'tests', 'generated');
  fs.mkdirSync(testsDir, { recursive: true });
  process.env.HEALIX_API_KEY = 'tb_test_fake';

  const restore = stubGenerateTestsForAgent(async ({ agent }) => {
    if (agent !== 'smoke') {
      const err = new Error(`${agent} died`);
      err.code = 'OPENAI_RATE_LIMITED';
      throw err;
    }
    return { success: true, tests: [testSpec('smoke', 0)], generationMeta: {} };
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

    assert.equal(result.generated, 1);
    assert.deepEqual(result.generationMeta.agentsCompleted, ['smoke']);
    assert.ok(result.generationMeta.agentFailures.length >= 3);
  } finally {
    restore();
    cleanup(projectPath);
    delete process.env.HEALIX_API_KEY;
  }
});

test('fan-out: updateStatus emits generation_partial on each agent settlement', async () => {
  const projectPath = mkTmpDir('healix-gen-status-');
  const testsDir = path.join(projectPath, 'tests', 'generated');
  fs.mkdirSync(testsDir, { recursive: true });
  const statusDir = mkTmpDir('healix-status-');
  process.env.HEALIX_API_KEY = 'tb_test_fake';

  const restore = stubGenerateTestsForAgent(async ({ agent }) => ({
    success: true,
    tests: [testSpec(agent, 0)],
    generationMeta: {},
  }));

  try {
    await maybeGenerateViaSaaS({
      config: { projectPath, testType: 'both' },
      context: {},
      prdContent: '',
      testsDir,
      projectInfo: {},
      parsedPRD: null,
      explorationArtifact: null,
      roles: [],
      statusDir,
      runId: 'test-run-progress',
    });

    const statusFile = path.join(statusDir, 'status.json');
    assert.ok(fs.existsSync(statusFile), 'updateStatus should write status.json');
    const parsed = JSON.parse(fs.readFileSync(statusFile, 'utf-8'));
    // updateStatus writes the LAST phase only — by the time all 5 agents have
    // settled, status.json reflects the final generation_partial tick with
    // agentsCompleted === 5. We can't assert intermediate states without a
    // write log, so the end-state assertion is what we have.
    assert.equal(parsed.phase, 'generation_partial');
    assert.equal(parsed.totalAgents, 5);
    assert.equal(parsed.agentsCompleted, 5);
    assert.equal(parsed.generatedCount, 5);
  } finally {
    restore();
    cleanup(projectPath);
    cleanup(statusDir);
    delete process.env.HEALIX_API_KEY;
  }
});

test('fan-out: missing HEALIX_API_KEY throws MISSING_HEALIX_API_KEY before any fetch', async () => {
  const projectPath = mkTmpDir('healix-gen-noapikey-');
  const testsDir = path.join(projectPath, 'tests', 'generated');
  fs.mkdirSync(testsDir, { recursive: true });
  const saved = process.env.HEALIX_API_KEY;
  delete process.env.HEALIX_API_KEY;

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
      (err) => err.code === 'MISSING_HEALIX_API_KEY',
    );
  } finally {
    cleanup(projectPath);
    if (saved) process.env.HEALIX_API_KEY = saved;
  }
});
