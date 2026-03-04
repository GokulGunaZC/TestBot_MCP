const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const {
  generateWithFallbackChain,
  evaluateGenerationQualityGates,
} = require('../src/pipeline-worker');

function createRunBudget() {
  return {
    startedAt: Date.now(),
    totalMs: 120000,
    stageCaps: {
      generation: 30000,
      validation: 30000,
    },
  };
}

test('strict AI mode fails fast when OPENAI_API_KEY is missing', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'testbot-pipeline-strict-key-'));
  const previousKey = process.env.OPENAI_API_KEY;

  try {
    delete process.env.OPENAI_API_KEY;

    await assert.rejects(
      () => generateWithFallbackChain({
        config: {
          projectPath: tempDir,
          testType: 'both',
          strictAIGeneration: true,
          generationMode: 'openai-only',
          validateGeneratedTests: false,
        },
        context: { pages: [], apiEndpoints: [], workflows: [] },
        prdContent: null,
        runBudget: createRunBudget(),
        projectInfo: { name: 'demo', baseURL: 'http://localhost:3000' },
      }),
      (error) => error && error.code === 'OPENAI_KEY_MISSING'
    );
  } finally {
    if (previousKey) {
      process.env.OPENAI_API_KEY = previousKey;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('generation quality gates fail when min test count is not met', () => {
  const gate = evaluateGenerationQualityGates({
    config: {
      testType: 'both',
      minGeneratedTests: 50,
      coverageProfile: 'qa-max',
    },
    context: {
      apiEndpoints: [{ method: 'GET', path: '/api/health' }],
    },
    quality: {
      totalFiles: 8,
      totalTests: 18,
      selectorQuality: 0.9,
      categories: {
        ui_flow: 2,
        form_validation: 2,
        workflow_journey: 1,
        api_contract: 2,
        api_auth: 1,
        api_negative: 2,
        api_stress: 1,
      },
    },
  });

  assert.equal(gate.ok, false);
  assert.equal(gate.error.code, 'MIN_TEST_COUNT_NOT_MET');
});

test('generation quality gates fail when required API category is missing', () => {
  const gate = evaluateGenerationQualityGates({
    config: {
      testType: 'both',
      minGeneratedTests: 50,
      coverageProfile: 'qa-max',
    },
    context: {
      apiEndpoints: [{ method: 'GET', path: '/api/health' }],
    },
    quality: {
      totalFiles: 14,
      totalTests: 66,
      selectorQuality: 0.8,
      categories: {
        ui_flow: 4,
        form_validation: 4,
        workflow_journey: 3,
        api_contract: 3,
        api_auth: 2,
        api_negative: 3,
        api_stress: 0,
      },
    },
  });

  assert.equal(gate.ok, false);
  assert.equal(gate.error.code, 'COVERAGE_GATES_FAILED');
  assert.match(gate.error.message, /api_stress/i);
});
