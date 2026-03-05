const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const {
  generateWithFallbackChain,
  evaluateGenerationQualityGates,
  collectGenerationQuality,
  auditGeneratedTestQuality,
  classifyErrorCode,
  buildUserFacingPipelineError,
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

test('generation quality gates adapt to API-only context even when testType is both', () => {
  const gate = evaluateGenerationQualityGates({
    config: {
      testType: 'both',
      minGeneratedTests: 30,
      coverageProfile: 'qa-max',
    },
    context: {
      pages: [],
      forms: [],
      workflows: [],
      apiEndpoints: [
        { method: 'GET', path: '/api/health' },
        { method: 'POST', path: '/api/items' },
      ],
    },
    quality: {
      totalFiles: 8,
      totalTests: 40,
      selectorQuality: 1,
      categories: {
        ui_flow: 0,
        form_validation: 0,
        workflow_journey: 0,
        api_contract: 2,
        api_auth: 0,
        api_negative: 2,
        api_stress: 1,
      },
    },
  });

  assert.equal(gate.ok, true);
});

test('collectGenerationQuality detects API categories from explicit CAT tags', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'testbot-pipeline-quality-tags-'));

  try {
    const generatedDir = path.join(tempDir, 'tests', 'generated');
    fs.mkdirSync(generatedDir, { recursive: true });
    fs.writeFileSync(path.join(generatedDir, 'api-contract-tags.spec.ts'), `import { test, expect } from '@playwright/test';

test('[CAT:api_contract] [CAT:api_negative] [CAT:api_stress] tagged api checks', async ({ request }) => {
  const response = await request.get('/api/health');
  const status = response.status();
  expect([200, 400, 404]).toContain(status);
  expect(status).toBeLessThan(500);
});
`, 'utf8');

    const quality = collectGenerationQuality(tempDir);
    assert.equal(quality.totalTests, 1);
    assert.equal(quality.categories.api_contract > 0, true);
    assert.equal(quality.categories.api_negative > 0, true);
    assert.equal(quality.categories.api_stress > 0, true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('auditGeneratedTestQuality treats page.route mocks as warning (not hard failure)', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'testbot-pipeline-audit-route-'));

  try {
    const generatedDir = path.join(tempDir, 'tests', 'generated');
    fs.mkdirSync(generatedDir, { recursive: true });
    fs.writeFileSync(path.join(generatedDir, 'workflow.spec.ts'), `import { test, expect } from '@playwright/test';
test('workflow route mock', async ({ page }) => {
  await page.route('**/api/customer/**', (route) => route.fulfill({ status: 200, body: '{}' }));
  await page.goto('/');
  await expect(page.getByRole('main').first()).toBeVisible();
});
`, 'utf8');

    const audit = auditGeneratedTestQuality({
      projectPath: tempDir,
      testType: 'frontend',
      context: { pages: [{ path: '/' }], forms: [], workflows: [] },
    });

    assert.equal(audit.valid, true);
    assert.equal(audit.riskyPatternHits, 0);
    assert.equal(audit.warnings.some((warning) => warning.startsWith('uses_route_mocking:')), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('auditGeneratedTestQuality treats ungrounded generic error phrases as warnings by default', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'testbot-pipeline-audit-phrase-'));
  const priorEnv = process.env.TESTBOT_ENFORCE_PHRASE_RISK_GATES;
  delete process.env.TESTBOT_ENFORCE_PHRASE_RISK_GATES;

  try {
    const generatedDir = path.join(tempDir, 'tests', 'generated');
    fs.mkdirSync(generatedDir, { recursive: true });
    fs.writeFileSync(path.join(generatedDir, 'workflow-phrase.spec.ts'), `import { test, expect } from '@playwright/test';
test('workflow generic error phrase', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText(/try again/i).first()).toBeVisible();
});
`, 'utf8');

    const audit = auditGeneratedTestQuality({
      projectPath: tempDir,
      testType: 'frontend',
      context: { pages: [{ path: '/' }], forms: [], workflows: [] },
    });

    assert.equal(audit.valid, true);
    assert.equal(audit.riskyPatternHits, 0);
    assert.equal(audit.warnings.some((warning) => warning.startsWith('ungrounded_error_phrase:')), true);
  } finally {
    if (priorEnv === undefined) {
      delete process.env.TESTBOT_ENFORCE_PHRASE_RISK_GATES;
    } else {
      process.env.TESTBOT_ENFORCE_PHRASE_RISK_GATES = priorEnv;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('auditGeneratedTestQuality treats checkValidity assertions as warning (not hard failure)', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'testbot-pipeline-audit-check-validity-'));

  try {
    const generatedDir = path.join(tempDir, 'tests', 'generated');
    fs.mkdirSync(generatedDir, { recursive: true });
    fs.writeFileSync(path.join(generatedDir, 'form-validation.spec.ts'), `import { test, expect } from '@playwright/test';
test('form validation', async ({ page }) => {
  await page.goto('/');
  const input = page.getByRole('textbox').first();
  const isInvalid = await input.evaluate((el) => !el.checkValidity());
  expect(typeof isInvalid).toBe('boolean');
});
`, 'utf8');

    const audit = auditGeneratedTestQuality({
      projectPath: tempDir,
      testType: 'frontend',
      context: { pages: [{ path: '/' }], forms: [{ fields: [{ label: 'Email' }] }], workflows: [] },
    });

    assert.equal(audit.valid, true);
    assert.equal(audit.riskyPatternHits, 0);
    assert.equal(audit.warnings.some((warning) => warning.startsWith('uses_check_validity:')), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('generation quality gates do not force workflow category for single inferred workflow without form context', () => {
  const gate = evaluateGenerationQualityGates({
    config: {
      testType: 'both',
      minGeneratedTests: 30,
      coverageProfile: 'qa-max',
    },
    context: {
      pages: [{ path: '/', components: [], interactions: ['navigation'] }],
      forms: [],
      workflows: [{ name: 'Dashboard Navigation', steps: ['navigate', 'assert'] }],
      navigationGraph: [],
      apiEndpoints: [{ method: 'GET', path: '/api/health' }],
      authPatterns: [{ type: 'session' }],
    },
    quality: {
      totalFiles: 10,
      totalTests: 45,
      selectorQuality: 0.8,
      categories: {
        ui_flow: 2,
        form_validation: 0,
        workflow_journey: 0,
        api_contract: 2,
        api_auth: 1,
        api_negative: 2,
        api_stress: 1,
      },
    },
  });

  assert.equal(gate.ok, true);
});

test('classifyErrorCode maps Expo dependency validation startup failures', () => {
  const error = new Error('Playwright execution failed with exit code 1: [WebServer] The following packages should be updated for best compatibility with the installed expo version');
  assert.equal(classifyErrorCode(error), 'EXPO_DEPENDENCY_VALIDATION_FAILED');
});

test('buildUserFacingPipelineError returns actionable Expo dependency guidance', () => {
  const message = buildUserFacingPipelineError('EXPO_DEPENDENCY_VALIDATION_FAILED', new Error('expo dependency validation failed'));
  assert.match(message, /Expo blocked server startup/i);
  assert.match(message, /expo install --check/i);
});
