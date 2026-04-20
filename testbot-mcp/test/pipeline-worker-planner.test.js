'use strict';

/**
 * P1.5 — planner pre-pass wiring inside maybeGenerateViaSaaS.
 *
 * Contract under test:
 *   1. When client.planGeneration returns a plan, each generateTestsForAgent
 *      call receives the projected slice for its agent.
 *      - smoke → { smokeTargets, plannedTests }
 *      - frontend → { pages, workflows }
 *      - api → { endpoints, apiFlows }
 *      - workflow → { workflows }
 *      - error → { negativeAssertions, errorCases }
 *   2. When planGeneration throws WEBAPP_TIMEOUT, fan-out continues without
 *      a plan, no `plan` body field is sent, and generationMeta.planStatus
 *      === 'plan_skipped_timeout'.
 *   3. When planGeneration returns { fallback: 'endpoint_absent' }, same as
 *      (2) but planStatus === 'plan_skipped_endpoint_absent'.
 *   4. When HEALIX_SKIP_PLANNER === '1', planGeneration is never invoked.
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

function stubBoth({ plan, perAgentImpl }) {
  const origPlan = WebappClient.prototype.planGeneration;
  const origGen = WebappClient.prototype.generateTestsForAgent;
  const planCalls = [];
  const agentCalls = [];

  WebappClient.prototype.planGeneration = async function (args) {
    planCalls.push(args);
    if (typeof plan === 'function') return plan(args);
    return plan;
  };
  WebappClient.prototype.generateTestsForAgent = async function (args) {
    agentCalls.push(args);
    return perAgentImpl(args);
  };
  return {
    planCalls,
    agentCalls,
    restore: () => {
      WebappClient.prototype.planGeneration = origPlan;
      WebappClient.prototype.generateTestsForAgent = origGen;
    },
  };
}

function okAgent({ agent }) {
  return {
    success: true,
    tests: [
      {
        filename: `${agent}-0.spec.ts`,
        content: `import { test } from '@playwright/test';\ntest('${agent}-0', async () => {});`,
        type: agent,
      },
    ],
    generationMeta: {},
  };
}

const CANNED_PLAN = {
  planVersion: 1,
  planHash: 'hash-abc',
  frontendPlan: {
    pages: [
      {
        path: '/',
        role: 'public',
        criticalFlows: ['load homepage'],
        assertions: ['heading is visible', 'logo is not broken'],
        acIds: ['F1.S1.AC1'],
      },
      {
        path: '/dashboard',
        role: 'authed',
        criticalFlows: ['view dashboard'],
        assertions: ['dashboard renders', 'invalid state fails gracefully'],
        acIds: [],
      },
    ],
    workflows: [
      { name: 'signup-and-onboard', steps: ['signup', 'verify', 'onboard'], acIds: [] },
    ],
    smokeTargets: ['/', '/dashboard', '/login'],
    plannedTests: 8,
  },
  backendPlan: {
    endpoints: [
      {
        method: 'GET',
        path: '/api/me',
        authRequired: true,
        happyPathCases: ['returns current user'],
        errorCases: ['401 on missing token', '403 on revoked token'],
        acIds: [],
      },
    ],
    apiFlows: [
      {
        name: 'auth-then-fetch',
        steps: [
          { method: 'POST', path: '/api/auth/login', rationale: 'establish session' },
          { method: 'GET', path: '/api/me', rationale: 'verify session' },
        ],
        acIds: [],
      },
    ],
    plannedTests: 4,
  },
  totalPlannedTests: 12,
  warnings: [],
  generatedAt: new Date().toISOString(),
};

test('per-agent slice: each agent receives its projection of the plan', async () => {
  const projectPath = mkTmpDir('healix-plan-slice-');
  const testsDir = path.join(projectPath, 'tests', 'generated');
  fs.mkdirSync(testsDir, { recursive: true });
  process.env.HEALIX_API_KEY = 'tb_test_fake';
  delete process.env.HEALIX_SKIP_PLANNER;

  const { agentCalls, restore } = stubBoth({
    plan: { plan: CANNED_PLAN, cache: 'miss' },
    perAgentImpl: okAgent,
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
      statusDir: null,
      runId: 'test-run-slice',
    });

    assert.equal(result.generationMeta.planStatus, 'plan_generated');
    assert.equal(result.generationMeta.plannedTests, 12);

    const byAgent = Object.fromEntries(agentCalls.map((c) => [c.agent, c]));

    // smoke slice: smokeTargets + plannedTests only
    assert.ok(byAgent.smoke, 'smoke agent should have been called');
    assert.deepEqual(byAgent.smoke.plan, {
      slice: { smokeTargets: ['/', '/dashboard', '/login'], plannedTests: 8 },
      planVersion: 1,
    });

    // frontend slice: pages + workflows
    assert.ok(byAgent.frontend);
    assert.deepEqual(byAgent.frontend.plan.slice.pages, CANNED_PLAN.frontendPlan.pages);
    assert.deepEqual(byAgent.frontend.plan.slice.workflows, CANNED_PLAN.frontendPlan.workflows);
    assert.equal(byAgent.frontend.plan.slice.endpoints, undefined);

    // api slice: endpoints + apiFlows
    assert.ok(byAgent.api);
    assert.deepEqual(byAgent.api.plan.slice.endpoints, CANNED_PLAN.backendPlan.endpoints);
    assert.deepEqual(byAgent.api.plan.slice.apiFlows, CANNED_PLAN.backendPlan.apiFlows);
    assert.equal(byAgent.api.plan.slice.pages, undefined);

    // workflow slice: workflows only
    assert.ok(byAgent.workflow);
    assert.deepEqual(byAgent.workflow.plan.slice, {
      workflows: CANNED_PLAN.frontendPlan.workflows,
    });

    // error slice: derived from frontend assertions + backend errorCases
    assert.ok(byAgent.error);
    const errSlice = byAgent.error.plan.slice;
    // "logo is not broken" and "invalid state fails gracefully" both match /not |fail|error|invalid/
    assert.ok(Array.isArray(errSlice.negativeAssertions));
    assert.ok(errSlice.negativeAssertions.includes('logo is not broken'));
    assert.ok(errSlice.negativeAssertions.includes('invalid state fails gracefully'));
    assert.deepEqual(errSlice.errorCases, ['401 on missing token', '403 on revoked token']);
  } finally {
    restore();
    cleanup(projectPath);
    delete process.env.HEALIX_API_KEY;
  }
});

test('planGeneration WEBAPP_TIMEOUT: fan-out continues with no plan, planStatus=plan_skipped_timeout', async () => {
  const projectPath = mkTmpDir('healix-plan-timeout-');
  const testsDir = path.join(projectPath, 'tests', 'generated');
  fs.mkdirSync(testsDir, { recursive: true });
  process.env.HEALIX_API_KEY = 'tb_test_fake';
  delete process.env.HEALIX_SKIP_PLANNER;

  const { agentCalls, restore } = stubBoth({
    plan: async () => {
      const err = new Error('timed out');
      err.code = 'WEBAPP_TIMEOUT';
      throw err;
    },
    perAgentImpl: okAgent,
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
    });

    assert.equal(result.generationMeta.planStatus, 'plan_skipped_timeout');
    assert.equal(result.generationMeta.plannedTests, 0);
    // All agents still fanned out; no `plan` field was sent with the calls.
    assert.ok(agentCalls.length >= 3, 'fan-out must still run after planner timeout');
    for (const call of agentCalls) {
      assert.equal(call.plan, undefined, `no plan body field expected for ${call.agent}`);
    }
  } finally {
    restore();
    cleanup(projectPath);
    delete process.env.HEALIX_API_KEY;
  }
});

test('planGeneration fallback:endpoint_absent: planStatus=plan_skipped_endpoint_absent', async () => {
  const projectPath = mkTmpDir('healix-plan-absent-');
  const testsDir = path.join(projectPath, 'tests', 'generated');
  fs.mkdirSync(testsDir, { recursive: true });
  process.env.HEALIX_API_KEY = 'tb_test_fake';
  delete process.env.HEALIX_SKIP_PLANNER;

  const { agentCalls, restore } = stubBoth({
    plan: { fallback: 'endpoint_absent' },
    perAgentImpl: okAgent,
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

    assert.equal(result.generationMeta.planStatus, 'plan_skipped_endpoint_absent');
    assert.equal(result.generationMeta.plannedTests, 0);
    assert.ok(agentCalls.length >= 3, 'fan-out must still run when endpoint is absent');
    for (const call of agentCalls) {
      assert.equal(call.plan, undefined);
    }
  } finally {
    restore();
    cleanup(projectPath);
    delete process.env.HEALIX_API_KEY;
  }
});

test('HEALIX_SKIP_PLANNER=1: planGeneration is never invoked', async () => {
  const projectPath = mkTmpDir('healix-plan-skip-');
  const testsDir = path.join(projectPath, 'tests', 'generated');
  fs.mkdirSync(testsDir, { recursive: true });
  process.env.HEALIX_API_KEY = 'tb_test_fake';
  process.env.HEALIX_SKIP_PLANNER = '1';

  const { planCalls, restore } = stubBoth({
    plan: { plan: CANNED_PLAN, cache: 'miss' },
    perAgentImpl: okAgent,
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

    assert.equal(planCalls.length, 0, 'planGeneration must NOT be called when HEALIX_SKIP_PLANNER=1');
    assert.equal(result.generationMeta.planStatus, 'plan_skipped_env_flag');
    assert.equal(result.generationMeta.plannedTests, 0);
  } finally {
    restore();
    cleanup(projectPath);
    delete process.env.HEALIX_API_KEY;
    delete process.env.HEALIX_SKIP_PLANNER;
  }
});
