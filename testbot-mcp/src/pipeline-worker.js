/**
 * Pipeline Worker
 * Runs the full TestBot pipeline in a background process.
 * Receives config via IPC from the MCP server, runs independently.
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// Load environment variables from multiple paths
const dotenvPaths = [
  path.join(__dirname, '.env'),
  path.join(__dirname, '..', '.env'),
  path.join(__dirname, '..', '..', '.env'),
];
for (const envPath of dotenvPaths) {
  const { error } = require('dotenv').config({ path: envPath });
  if (!error) break;
}

const PlaywrightIntegration = require('./playwright-integration');
const PlaywrightMCPClient = require('./playwright-mcp-client');
const PlaywrightMCPIntegration = require('./playwright-mcp-integration');
const OpenAITestGenerator = require('./test-generator-openai');
const ResultsMerger = require('./results-merger');
const ContextGatherer = require('./context-gatherer');
const AgentContextRequester = require('./agent-context-requester');
const JiraClient = require('./jira/client');
const ReportGenerator = require('./report-generator');
const DashboardLauncher = require('./dashboard-launcher');
const AIAnalyzer = require('./ai-providers/index');
const Logger = require('./logger');
const MCPTelemetryReporter = require('./mcp-telemetry');

// Initialize logger for the worker process
Logger.initialize();

const DEFAULT_TOTAL_BUDGET_MS = 1800000;
const DEFAULT_STAGE_CAPS_MS = {
  jira: 45000,
  context: 90000,
  generation: 180000,
  validation: 90000,
  execution: 1200000,
  aiTriage: 60000,
  reporting: 30000,
  dashboard: 30000,
};

const STRICT_AI_REQUIRED_CATEGORIES = [
  'ui_flow',
  'form_validation',
  'workflow_journey',
  'api_contract',
  'api_auth',
  'api_negative',
  'api_stress',
];

const CURSOR_FIXTURE_BASENAME = '__testbot-fixture';
const CURSOR_OVERLAY_INIT_SCRIPT = `
(() => {
  if (window.__testbotCursorOverlayInstalled) return;
  window.__testbotCursorOverlayInstalled = true;

  const ensureCursor = () => {
    const existing = document.getElementById('__testbot-cursor-overlay');
    if (existing) return existing;

    const dot = document.createElement('div');
    dot.id = '__testbot-cursor-overlay';
    dot.setAttribute('aria-hidden', 'true');
    dot.style.cssText = [
      'position:fixed',
      'left:0',
      'top:0',
      'width:16px',
      'height:16px',
      'margin-left:-8px',
      'margin-top:-8px',
      'border-radius:9999px',
      'background:rgba(255,82,82,0.95)',
      'border:2px solid rgba(255,255,255,0.95)',
      'box-shadow:0 0 0 1px rgba(0,0,0,0.35)',
      'z-index:2147483647',
      'pointer-events:none',
      'opacity:0',
      'transform:translate(-100px,-100px)',
      'transition:opacity 80ms linear, transform 16ms linear'
    ].join(';');
    document.documentElement.appendChild(dot);
    return dot;
  };

  const move = (event) => {
    const dot = ensureCursor();
    dot.style.opacity = '1';
    dot.style.transform = 'translate(' + event.clientX + 'px,' + event.clientY + 'px)';
  };

  const hide = () => {
    const dot = document.getElementById('__testbot-cursor-overlay');
    if (dot) dot.style.opacity = '0';
  };

  document.addEventListener('mousemove', move, true);
  document.addEventListener('mouseenter', move, true);
  document.addEventListener('mouseleave', hide, true);
})();
`;

function toFiniteNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function createRunBudget(config = {}) {
  const totalMs = toFiniteNumber(config.maxRunMs || process.env.TESTBOT_RUN_BUDGET_MS, DEFAULT_TOTAL_BUDGET_MS);
  const stageCaps = {};
  for (const [stage, fallback] of Object.entries(DEFAULT_STAGE_CAPS_MS)) {
    const envKey = `TESTBOT_STAGE_${stage.toUpperCase()}_MS`;
    stageCaps[stage] = toFiniteNumber(config.stageCaps?.[stage] || process.env[envKey], fallback);
  }

  const strictAI = strictAIEnabled(config);
  const coverageProfile = String(config.coverageProfile || 'qa-max').toLowerCase();
  const twoPhase = String(config.phaseMode || 'two-phase') === 'two-phase';

  const hasExplicitGenerationCap = Boolean(config.stageCaps?.generation) || Boolean(process.env.TESTBOT_STAGE_GENERATION_MS);
  if (strictAI && !hasExplicitGenerationCap) {
    const requestedMinTests = toFiniteNumber(config.minGeneratedTests, 50);
    const adaptiveGenerationCap = coverageProfile === 'exhaustive' || requestedMinTests >= 75
      ? 600000
      : requestedMinTests >= 50
        ? 480000
        : stageCaps.generation;
    stageCaps.generation = Math.max(stageCaps.generation, adaptiveGenerationCap);
  }

  // Scale execution cap for heavier profiles / two-phase mode
  const hasExplicitExecutionCap = Boolean(config.stageCaps?.execution) || Boolean(process.env.TESTBOT_STAGE_EXECUTION_MS);
  if (!hasExplicitExecutionCap) {
    const adaptiveExecutionCap = coverageProfile === 'exhaustive'
      ? 2400000
      : twoPhase
        ? 1200000
        : 900000;
    stageCaps.execution = Math.max(stageCaps.execution, adaptiveExecutionCap);
  }

  return {
    startedAt: Date.now(),
    totalMs,
    stageCaps,
  };
}

function getBudgetElapsedMs(budget) {
  return Date.now() - budget.startedAt;
}

function getBudgetRemainingMs(budget) {
  return Math.max(0, budget.totalMs - getBudgetElapsedMs(budget));
}

function createBudgetError(message, code = 'TIME_BUDGET_EXCEEDED') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function computePassRatePercent(results) {
  if (!results || !Number.isFinite(results.total) || results.total <= 0) {
    return 0;
  }
  return (Number(results.passed || 0) / Number(results.total)) * 100;
}

function modeAllowsTemplateFallback(generationMode) {
  const normalized = String(generationMode || 'openai-first').toLowerCase();
  return normalized !== 'openai-only' && normalized !== 'saas-only';
}

function strictAIEnabled(config = {}) {
  return config.strictAIGeneration !== false;
}

function templatesEmergencyEnabled() {
  return String(process.env.TESTBOT_ENABLE_TEMPLATES || '').toLowerCase() === 'true';
}

function countTestsInContent(content) {
  if (!content) return 0;
  const matches = String(content).match(/\b(?:test|it)(?:\.(?:only|skip|fixme|fail|slow|todo))?\s*\(\s*(['"`])/g);
  return matches ? matches.length : 0;
}

function listGeneratedTestFiles(projectPath) {
  const generatedDir = path.join(projectPath, 'tests', 'generated');
  if (!fs.existsSync(generatedDir)) {
    return [];
  }

  return fs.readdirSync(generatedDir)
    .filter((name) => /\.spec\.(ts|js)$/i.test(name))
    .map((name) => path.join(generatedDir, name));
}

function toCoverageProfile(value) {
  const normalized = String(value || 'qa-max').toLowerCase();
  if (normalized === 'balanced' || normalized === 'exhaustive') {
    return normalized;
  }
  return 'qa-max';
}

function extractCategoryTags(content) {
  const text = String(content || '');
  const categories = new Set();
  const aliases = {
    ui: 'ui_flow',
    uiflow: 'ui_flow',
    ui_flow: 'ui_flow',
    form: 'form_validation',
    form_validation: 'form_validation',
    workflow: 'workflow_journey',
    workflow_journey: 'workflow_journey',
    journey: 'workflow_journey',
    api: 'api_contract',
    api_contract: 'api_contract',
    contract: 'api_contract',
    api_auth: 'api_auth',
    auth: 'api_auth',
    api_negative: 'api_negative',
    negative: 'api_negative',
    error: 'api_negative',
    api_stress: 'api_stress',
    stress: 'api_stress',
    load: 'api_stress',
  };

  const matches = text.matchAll(/\[CAT:([^\]\r\n]+)\]/gi);
  for (const match of matches) {
    const raw = String(match?.[1] || '')
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, '_')
      .replace(/[^a-z0-9_]/g, '');
    if (!raw) continue;
    categories.add(aliases[raw] || raw);
  }

  return categories;
}

function detectCoverageCategoriesFromContent(content, filename) {
  const text = String(content || '');
  const fileLabel = String(filename || '').toLowerCase();
  const categories = extractCategoryTags(text);
  const taggedApiSignals = ['api_contract', 'api_auth', 'api_negative', 'api_stress'].some((name) => categories.has(name));
  const isApiSuite = taggedApiSignals || /request\.(get|post|put|patch|delete|fetch)\(/i.test(text) || /api/.test(fileLabel);

  if (!isApiSuite) {
    if (
      /page\.(goto|click|fill|check|selectOption|press)\(/i.test(text) ||
      /getBy(Role|Label|Placeholder|TestId|Text|AltText)\(/.test(text) ||
      /toHaveURL\(|toBeVisible\(/.test(text)
    ) {
      categories.add('ui_flow');
    }

    if (
      /fill\(|getBy(Label|Placeholder)\(|required|validation|invalid|error message|toBeDisabled\(/i.test(text)
    ) {
      categories.add('form_validation');
    }

    if (
      /workflow|journey|onboarding|checkout|multi-step|end-to-end|critical path/i.test(fileLabel) ||
      /step\s*\d+|complete flow|end-to-end|journey/i.test(text)
    ) {
      categories.add('workflow_journey');
    }
  } else {
    if (
      /response\.status\(\)|toBe\(\s*\d{3}\s*\)|toContain\(\s*response\.status\(\)\s*\)|toHaveProperty\(/i.test(text)
    ) {
      categories.add('api_contract');
    }

    if (/authorization|bearer|unauth|401|403|auth required|test_auth_token/i.test(text)) {
      categories.add('api_auth');
    }

    if (/malformed|invalid|negative|error|expect\(response\.status\(\)\)\.toBeGreaterThanOrEqual\(\s*400/i.test(text) ||
      /\b(400|404|409|422|429)\b/.test(text)
    ) {
      categories.add('api_negative');
    }

    if (/promise\.all|burst|stress|load|p95|percentile|concurrent/i.test(text)) {
      categories.add('api_stress');
    }
  }

  return categories;
}

function collectGenerationQuality(projectPath) {
  const files = listGeneratedTestFiles(projectPath);
  const categories = Object.fromEntries(STRICT_AI_REQUIRED_CATEGORIES.map((name) => [name, 0]));
  let totalTests = 0;
  let filesWithPreferredSelectors = 0;
  let uiFiles = 0;

  for (const filePath of files) {
    let content = '';
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    totalTests += countTestsInContent(content);
    const detected = detectCoverageCategoriesFromContent(content, path.basename(filePath));
    for (const category of detected) {
      categories[category] = (categories[category] || 0) + 1;
    }

    const isApiSuite = /request\.(get|post|put|patch|delete|fetch)\(/i.test(content) || /api/i.test(path.basename(filePath));
    if (!isApiSuite) {
      uiFiles += 1;
      if (/getByRole|getByLabel|getByPlaceholder|getByTestId|getByText|getByAltText/.test(content)) {
        filesWithPreferredSelectors += 1;
      }
    }
  }

  const selectorQuality = uiFiles > 0
    ? Number((filesWithPreferredSelectors / uiFiles).toFixed(2))
    : 1;

  return {
    totalFiles: files.length,
    totalTests,
    categories,
    selectorQuality,
  };
}

function buildRequirementsCoverage({ prdContent, projectPath }) {
  const fallback = {
    totalRequirements: 0,
    mappedRequirements: 0,
    uncoveredRequirements: [],
  };

  if (!prdContent || !String(prdContent).trim()) {
    return fallback;
  }

  const requirementMatches = String(prdContent).match(/\b(?:REQ|AC|US)[-_ ]?\d+\b/gi) || [];
  const normalizedRequirements = [...new Set(requirementMatches.map((item) => item.toUpperCase().replace(/\s+/g, '-')))];
  if (normalizedRequirements.length === 0) {
    return fallback;
  }

  const filePaths = listGeneratedTestFiles(projectPath);
  const corpus = [];
  for (const filePath of filePaths) {
    try {
      corpus.push(fs.readFileSync(filePath, 'utf-8').toUpperCase());
    } catch {
      // ignore
    }
  }
  const allContent = corpus.join('\n');

  const uncoveredRequirements = normalizedRequirements.filter((requirement) =>
    !allContent.includes(requirement) &&
    !allContent.includes(`[REQ:${requirement}]`) &&
    !allContent.includes(`[REQ-${requirement}]`)
  );

  return {
    totalRequirements: normalizedRequirements.length,
    mappedRequirements: normalizedRequirements.length - uncoveredRequirements.length,
    uncoveredRequirements,
  };
}

function requiredCategoriesForRun({ testType, context = {} }) {
  const normalizedType = String(testType || 'both').toLowerCase();
  const pageCount = (context.pages || []).length;
  const formCount = (context.forms || []).length;
  const workflowCount = (context.workflows || []).length;
  const navEdgeCount = (context.navigationGraph || []).length;
  const apiCount = (context.apiEndpoints || []).length;
  const authPatternCount = (context.authPatterns || []).length;
  const apiAuthSignals = (context.apiEndpoints || []).filter((endpoint) =>
    endpoint?.authRequired === true ||
    /auth|token|login|logout|session|bearer/i.test(String(endpoint?.path || ''))
  ).length;

  const explicitFrontend = normalizedType === 'frontend';
  const explicitBackend = normalizedType === 'backend';

  const hasUiSurface = !explicitBackend && (
    pageCount > 0 ||
    formCount > 0 ||
    workflowCount > 0 ||
    navEdgeCount > 0
  );
  const hasApiSurface = !explicitFrontend && (
    apiCount > 0 ||
    normalizedType === 'backend'
  );

  const required = [];
  if (hasUiSurface) {
    required.push('ui_flow');
    if (formCount > 0) {
      required.push('form_validation');
    }
    if (navEdgeCount > 1 || workflowCount > 1 || (workflowCount > 0 && formCount > 0)) {
      required.push('workflow_journey');
    }
  }
  if (hasApiSurface) {
    required.push('api_contract', 'api_negative', 'api_stress');
    if (apiAuthSignals > 0 || authPatternCount > 0) {
      required.push('api_auth');
    }
  }

  if (required.length === 0) {
    if (explicitFrontend) {
      return ['ui_flow'];
    }
    if (explicitBackend) {
      return ['api_contract', 'api_negative', 'api_stress'];
    }
    return ['ui_flow', 'api_contract', 'api_negative'];
  }

  return required;
}

function minimumCategoryHitsByProfile(profile) {
  if (profile === 'exhaustive') return 2;
  return 1;
}

function evaluateGenerationQualityGates({ config, context, quality }) {
  const requiredCategories = requiredCategoriesForRun({
    testType: config.testType,
    context,
  });
  const profile = toCoverageProfile(config.coverageProfile);
  const minHits = minimumCategoryHitsByProfile(profile);
  const missingCategories = requiredCategories.filter((category) => (quality.categories[category] || 0) < minHits);

  const minGeneratedTests = toFiniteNumber(config.minGeneratedTests, 50);
  const minSelectorQuality = profile === 'balanced' ? 0.35 : (profile === 'exhaustive' ? 0.6 : 0.5);

  if (quality.totalTests < minGeneratedTests) {
    const error = new Error(`Generated tests ${quality.totalTests} below minimum ${minGeneratedTests}`);
    error.code = 'MIN_TEST_COUNT_NOT_MET';
    error.generationQuality = {
      ...quality,
      minGeneratedTests,
      requiredCategories,
      missingCategories,
      coverageProfile: profile,
    };
    return { ok: false, error };
  }

  if (missingCategories.length > 0 || quality.selectorQuality < minSelectorQuality) {
    const error = new Error(`Coverage gates failed. Missing categories: ${missingCategories.join(', ') || 'none'}, selectorQuality=${quality.selectorQuality}`);
    error.code = 'COVERAGE_GATES_FAILED';
    error.generationQuality = {
      ...quality,
      minGeneratedTests,
      requiredCategories,
      missingCategories,
      minSelectorQuality,
      coverageProfile: profile,
    };
    return { ok: false, error };
  }

  return {
    ok: true,
    result: {
      ...quality,
      minGeneratedTests,
      requiredCategories,
      missingCategories: [],
      minSelectorQuality,
      coverageProfile: profile,
    },
  };
}

async function withStageBudget(budget, stage, workFn) {
  const remainingMs = getBudgetRemainingMs(budget);
  if (remainingMs <= 0) {
    throw createBudgetError(`No budget left before stage: ${stage}`);
  }

  const capMs = budget.stageCaps[stage] || remainingMs;
  const timeoutMs = Math.max(1000, Math.min(capMs, remainingMs));

  let timeoutRef;
  try {
    return await Promise.race([
      Promise.resolve().then(workFn),
      new Promise((_, reject) => {
        timeoutRef = setTimeout(() => {
          reject(createBudgetError(`Stage '${stage}' exceeded budget (${timeoutMs}ms)`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutRef) {
      clearTimeout(timeoutRef);
    }
  }
}

function phaseToTelemetryStatus(phase) {
  const normalized = String(phase || '').toLowerCase();
  if (normalized === 'completed') {
    return 'success';
  }
  if (normalized === 'error' || normalized === 'error_reported') {
    return 'error';
  }
  return 'info';
}

function emitPipelineTelemetry(reporter, payload) {
  if (!reporter || !reporter.isEnabled() || !payload?.runId) {
    return;
  }

  const status = phaseToTelemetryStatus(payload.phase);
  reporter.emitBackground({
    toolName: 'testbot_test_my_app',
    eventType: 'pipeline_status',
    runId: payload.runId,
    phase: payload.phase,
    status,
    success: status === 'success',
    errorCode: payload.errorCode,
    reason: payload.error || undefined,
    message: payload.message,
    durationMs: Number(payload?.results?.duration || payload?.budget?.consumedMs || 0) || undefined,
    metadata: {
      project: payload.project,
      aiOnlyEnforced: payload.aiOnlyEnforced,
      fallbackUsed: payload.fallbackUsed,
      total: payload?.results?.total,
      passed: payload?.results?.passed,
      failed: payload?.results?.failed,
      skipped: payload?.results?.skipped,
      passRate: payload?.results?.passRate,
      generationProvider: payload?.generationMeta?.selectedGenerator || payload?.generationMeta?.provider || null,
    },
  });
}

/**
 * Write status update to disk so the caller can track progress.
 */
function updateStatus(statusDir, phase, data, telemetryReporter = null) {
  try {
    const payload = {
      phase,
      timestamp: new Date().toISOString(),
      ...data,
    };
    fs.writeFileSync(
      path.join(statusDir, 'status.json'),
      JSON.stringify(payload, null, 2)
    );
    emitPipelineTelemetry(telemetryReporter, payload);
  } catch (e) {
    Logger.error('PipelineWorker', 'Failed to write status', e);
  }
}

function classifyErrorCode(error) {
  if (error?.code) {
    return String(error.code);
  }

  const message = String(error?.message || '').toLowerCase();
  if (
    message.includes('expo dependency validation failed') ||
    message.includes('best compatibility with the installed expo version') ||
    (message.includes('expo version') && message.includes('expected version')) ||
    (message.includes('dependency validation') && message.includes('expo'))
  ) {
    return 'EXPO_DEPENDENCY_VALIDATION_FAILED';
  }
  if (
    message.includes('requested interactive input') ||
    (message.includes('input is required') && (message.includes('non-interactive') || message.includes('expo'))) ||
    (message.includes('cannot prompt') && message.includes('non-interactive'))
  ) {
    return 'EXPO_NON_INTERACTIVE_PROMPT';
  }
  if (
    message.includes("cannot find module '@playwright/test'") ||
    message.includes("cannot find module \"@playwright/test\"") ||
    message.includes("package subpath './cli.js' is not defined by \"exports\" in") ||
    message.includes("package subpath './cli.js' is not defined by 'exports' in")
  ) {
    return 'PLAYWRIGHT_DEPENDENCY_MISSING';
  }
  if (message.includes('server failed to start') || message.includes('process exited before becoming ready')) {
    return 'SERVER_START_TIMEOUT';
  }
  if (message.includes('exceeded budget') || message.includes('no budget left') || message.includes('time_budget_exceeded')) {
    return 'TIME_BUDGET_EXCEEDED';
  }
  if (message.includes('timed out')) {
    return 'PIPELINE_TIMEOUT';
  }
  if (message.includes('validation')) {
    return 'GENERATION_VALIDATION_FAILED';
  }
  if (message.includes('openai')) {
    return 'OPENAI_GENERATION_FAILED';
  }
  if (message.includes('minimum') && message.includes('generated')) {
    return 'MIN_TEST_COUNT_NOT_MET';
  }
  if (message.includes('coverage gates')) {
    return 'COVERAGE_GATES_FAILED';
  }
  if (message.includes('pipeline')) {
    return 'PIPELINE_FAILED';
  }
  return 'PIPELINE_ERROR';
}

function normalizeErrorText(value) {
  return String(value || '')
    .replace(/[\u001b\u009b][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function summarizeGenerationAttemptError(error) {
  const base = normalizeErrorText(error?.message) || 'generation attempt failed';
  const validation = error?.validation;
  if (!validation) {
    return base;
  }

  const details = [];
  if (validation.reason) {
    details.push(`validation=${normalizeErrorText(validation.reason)}`);
  }

  if (typeof validation.stderr === 'string' && validation.stderr.trim()) {
    const lines = validation.stderr
      .split('\n')
      .map((line) => normalizeErrorText(line))
      .filter(Boolean);
    const actionable = lines.find((line) =>
      /cannot find module ['"]@playwright\/test['"]|package subpath ['"]\.?\/cli\.js['"] is not defined by ["']exports["']|module_not_found|error:/i.test(line)
    ) || lines[0];
    if (actionable) {
      details.push(actionable.slice(0, 220));
    }
  }

  if (validation.qualityAudit?.errors?.length) {
    details.push(`quality=${validation.qualityAudit.errors.join(',')}`);
  }

  return details.length > 0
    ? `${base} (${details.join('; ')})`
    : base;
}

function buildUserFacingPipelineError(errorCode, error) {
  const normalizedMessage = normalizeErrorText(error?.message) || 'Pipeline execution failed';

  if (errorCode === 'EXPO_DEPENDENCY_VALIDATION_FAILED') {
    return 'Expo blocked server startup due to dependency version validation. Set compatible dependency versions (for example via `npx expo install --check`) or rerun with dependency validation disabled for CI automation.';
  }

  if (errorCode === 'EXPO_NON_INTERACTIVE_PROMPT') {
    return 'Expo requested interactive input while TestBot is running headless. Update start command/env to non-interactive mode and fixed port values.';
  }

  if (errorCode === 'PLAYWRIGHT_DEPENDENCY_MISSING') {
    return 'Playwright test runtime could not be resolved while validating generated tests. TestBot attempted to auto-link @playwright/test; install it in the target project if this persists.';
  }

  if (errorCode === 'GENERATION_VALIDATION_FAILED') {
    if (/playwright_list_failed/i.test(normalizedMessage)) {
      return 'Generated tests failed pre-run validation (`playwright test --list`). This is usually caused by missing Playwright runtime dependencies or invalid generated imports.';
    }
    return `Generated tests did not pass validation gates. ${normalizedMessage}`;
  }

  if (errorCode === 'TIME_BUDGET_EXCEEDED') {
    return 'Pipeline exceeded the configured time budget before tests could complete. Increase time budget or reduce generation/execution scope.';
  }

  if (errorCode === 'SERVER_START_TIMEOUT') {
    const detail = normalizedMessage ? ` Detail: ${normalizedMessage}` : '';
    return `App server did not become reachable before timeout. Verify start command, base URL, and port settings in the config form.${detail}`;
  }

  if (errorCode === 'OPENAI_KEY_MISSING') {
    return 'OPENAI_API_KEY is missing for strict AI generation mode.';
  }

  return normalizedMessage;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function isVideoCursorEnabled(config = {}) {
  if (config.showMouseCursorInVideo === false) {
    return false;
  }

  const envValue = String(process.env.TESTBOT_VIDEO_CURSOR || '').trim().toLowerCase();
  if (!envValue) {
    return true;
  }

  return !['0', 'false', 'off', 'no'].includes(envValue);
}

function toImportPath(relativePath) {
  const normalized = String(relativePath || '').replace(/\\/g, '/');
  if (!normalized || normalized === '.') {
    return './';
  }
  return normalized.startsWith('.') ? normalized : `./${normalized}`;
}

function getCursorFixtureContent(serializedInitScript) {
  const ts = `import { test as base, expect, request } from '@playwright/test';

const test = base.extend({
  page: async ({ page }, use) => {
    await page.addInitScript(${serializedInitScript});
    await use(page);
  },
});

export { test, expect, request };
`;

  const js = `const { test: base, expect, request } = require('@playwright/test');

const test = base.extend({
  page: async ({ page }, use) => {
    await page.addInitScript(${serializedInitScript});
    await use(page);
  },
});

module.exports = { test, expect, request };
`;

  return { ts, js };
}

function ensureCursorFixtureFiles(generatedDir) {
  const serializedInitScript = JSON.stringify(CURSOR_OVERLAY_INIT_SCRIPT);
  const { ts, js } = getCursorFixtureContent(serializedInitScript);

  const fixtureTs = path.join(generatedDir, `${CURSOR_FIXTURE_BASENAME}.ts`);
  const fixtureJs = path.join(generatedDir, `${CURSOR_FIXTURE_BASENAME}.js`);

  fs.writeFileSync(fixtureTs, ts, 'utf-8');
  fs.writeFileSync(fixtureJs, js, 'utf-8');

  return [fixtureTs, fixtureJs];
}

function rewritePlaywrightImportForCursor(content, fixtureImportPath) {
  let rewritten = String(content || '');
  const importPattern = /from\s+(['"])@playwright\/test\1/g;
  const requirePattern = /require\((['"])@playwright\/test\1\)/g;

  rewritten = rewritten.replace(importPattern, (_match, quote) => `from ${quote}${fixtureImportPath}${quote}`);
  rewritten = rewritten.replace(requirePattern, (_match, quote) => `require(${quote}${fixtureImportPath}${quote})`);

  return rewritten;
}

function applyMouseCursorOverlayToGeneratedTests({ projectPath, enabled }) {
  if (!enabled) {
    return { enabled: false, reason: 'disabled' };
  }

  const generatedDir = path.join(projectPath, 'tests', 'generated');
  if (!fs.existsSync(generatedDir)) {
    return { enabled: false, reason: 'generated_dir_missing' };
  }

  const testFiles = fs.readdirSync(generatedDir)
    .filter((name) => /\.spec\.(ts|js)$/i.test(name))
    .map((name) => path.join(generatedDir, name));

  if (testFiles.length === 0) {
    return { enabled: false, reason: 'no_generated_test_files' };
  }

  const fixtureFiles = ensureCursorFixtureFiles(generatedDir);
  let patchedFiles = 0;
  let skippedFiles = 0;

  for (const testFile of testFiles) {
    const raw = fs.readFileSync(testFile, 'utf-8');
    if (!raw.includes('@playwright/test')) {
      skippedFiles += 1;
      continue;
    }

    const fixtureBasePath = path.join(generatedDir, CURSOR_FIXTURE_BASENAME);
    const relativeFixturePath = path.relative(path.dirname(testFile), fixtureBasePath);
    const fixtureImportPath = toImportPath(relativeFixturePath);
    const rewritten = rewritePlaywrightImportForCursor(raw, fixtureImportPath);

    if (rewritten !== raw) {
      fs.writeFileSync(testFile, rewritten, 'utf-8');
      patchedFiles += 1;
    } else {
      skippedFiles += 1;
    }
  }

  return {
    enabled: true,
    patchedFiles,
    skippedFiles,
    fixtureFiles: fixtureFiles.map((filePath) => path.basename(filePath)),
  };
}

function resolveFailureAnalysisProvider(config = {}) {
  const requestedProvider = String(config.aiProvider || process.env.AI_PROVIDER || '').trim().toLowerCase();
  const openaiKey = process.env.OPENAI_API_KEY || null;
  const sarvamKey = process.env.SARVAM_API_KEY || process.env.AI_API_KEY || null;

  if (!requestedProvider) {
    if (openaiKey) {
      return { provider: 'openai', apiKey: openaiKey };
    }
    if (sarvamKey) {
      return { provider: 'sarvam', apiKey: sarvamKey };
    }
    return { provider: 'openai', apiKey: null, reason: 'missing_openai_and_sarvam_keys' };
  }

  if (requestedProvider === 'openai') {
    return {
      provider: 'openai',
      apiKey: openaiKey,
      reason: openaiKey ? null : 'missing_openai_key',
    };
  }

  if (requestedProvider === 'sarvam') {
    return {
      provider: 'sarvam',
      apiKey: sarvamKey,
      reason: sarvamKey ? null : 'missing_sarvam_key',
    };
  }

  if (requestedProvider === 'cascade' || requestedProvider === 'windsurf') {
    return { provider: requestedProvider, apiKey: null };
  }

  return {
    provider: requestedProvider,
    apiKey: openaiKey || sarvamKey,
    reason: (openaiKey || sarvamKey) ? null : 'missing_provider_key',
  };
}

function resetGeneratedTestsDir(projectPath) {
  const testsDir = path.join(projectPath, 'tests', 'generated');
  fs.rmSync(testsDir, { recursive: true, force: true });
  ensureDir(testsDir);
  return testsDir;
}

function sanitizeGeneratedFilename(rawFilename, fallbackPrefix, index) {
  const defaultName = `${fallbackPrefix}-${index + 1}.spec.ts`;
  if (!rawFilename || typeof rawFilename !== 'string') {
    return defaultName;
  }

  let base = path.basename(rawFilename.trim());
  base = base.replace(/[^a-zA-Z0-9_.-]/g, '-');
  base = base.replace(/-+/g, '-').replace(/^\.+/, '').replace(/^\-+/, '');

  if (!base) {
    return defaultName;
  }

  if (!/\.spec\.(ts|js)$/i.test(base)) {
    if (/\.(ts|js)$/i.test(base)) {
      base = base.replace(/\.(ts|js)$/i, '.spec.ts');
    } else {
      base = `${base}.spec.ts`;
    }
  }

  return base;
}

function safeWriteGeneratedTest(testsDir, test, index, fallbackPrefix, usedFilenames) {
  const filename = sanitizeGeneratedFilename(test?.filename, fallbackPrefix, index);
  const content = String(test?.content || '').trim();

  if (!content) {
    throw new Error(`Generated file '${filename}' is empty`);
  }
  if (content.length > 300000) {
    throw new Error(`Generated file '${filename}' exceeds size limit`);
  }

  let safeFilename = filename;
  let suffix = 1;
  while (usedFilenames.has(safeFilename.toLowerCase())) {
    safeFilename = filename.replace(/\.spec\.(ts|js)$/i, `-${suffix}.spec.ts`);
    suffix += 1;
  }
  usedFilenames.add(safeFilename.toLowerCase());

  const targetPath = path.resolve(testsDir, safeFilename);
  const resolvedTestsDir = path.resolve(testsDir);
  if (!targetPath.startsWith(`${resolvedTestsDir}${path.sep}`)) {
    throw new Error(`Unsafe generated filename rejected: ${safeFilename}`);
  }

  fs.writeFileSync(targetPath, content, 'utf-8');
  return {
    path: targetPath,
    filename: safeFilename,
  };
}

function resolvePlaywrightConfig(projectPath) {
  const candidates = [
    'playwright.config.ts',
    'playwright.config.js',
    'playwright.config.mjs',
    'playwright.config.cjs',
  ];

  for (const name of candidates) {
    const candidate = path.join(projectPath, name);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function getBundledPlaywrightPackageDir() {
  try {
    return path.dirname(require.resolve('@playwright/test/package.json'));
  } catch {
    return null;
  }
}

function ensureProjectPlaywrightBridge(projectPath) {
  const localPackageDir = path.join(projectPath, 'node_modules', '@playwright', 'test');
  if (fs.existsSync(localPackageDir)) {
    return { ok: true, bridged: false, packageDir: localPackageDir };
  }

  const bundledPackageDir = getBundledPlaywrightPackageDir();
  if (!bundledPackageDir) {
    return { ok: false, bridged: false, reason: 'bundled_playwright_missing' };
  }

  try {
    fs.mkdirSync(path.dirname(localPackageDir), { recursive: true });
    fs.symlinkSync(bundledPackageDir, localPackageDir, 'dir');
    return { ok: true, bridged: true, packageDir: localPackageDir };
  } catch (error) {
    if (fs.existsSync(localPackageDir)) {
      return { ok: true, bridged: false, packageDir: localPackageDir };
    }

    return {
      ok: false,
      bridged: false,
      reason: 'bridge_symlink_failed',
      error: error.message,
    };
  }
}

function resolvePlaywrightCliPath(projectPath) {
  try {
    return require.resolve('@playwright/test/cli', { paths: [projectPath] });
  } catch {
    // ignore and try package fallback
  }

  try {
    const packagePath = require.resolve('@playwright/test/package.json', { paths: [projectPath] });
    const cliPath = path.join(path.dirname(packagePath), 'cli.js');
    if (fs.existsSync(cliPath)) {
      return cliPath;
    }
  } catch {
    // ignore and try bridge/fallback
  }

  ensureProjectPlaywrightBridge(projectPath);

  try {
    return require.resolve('@playwright/test/cli', { paths: [projectPath] });
  } catch {
    // ignore and fallback to bundled resolution
  }

  try {
    const packagePath = require.resolve('@playwright/test/package.json', { paths: [projectPath] });
    const cliPath = path.join(path.dirname(packagePath), 'cli.js');
    if (fs.existsSync(cliPath)) {
      return cliPath;
    }
  } catch {
    // ignore and fallback to bundled resolution
  }

  try {
    return require.resolve('@playwright/test/cli');
  } catch {
    // ignore and fallback
  }

  try {
    const packagePath = require.resolve('@playwright/test/package.json');
    const cliPath = path.join(path.dirname(packagePath), 'cli.js');
    if (fs.existsSync(cliPath)) {
      return cliPath;
    }
  } catch {
    // ignore and fallback
  }

  const bundledBin = path.resolve(__dirname, '..', 'node_modules', '.bin', 'playwright');
  if (fs.existsSync(bundledBin)) {
    return bundledBin;
  }

  const projectBin = path.join(projectPath, 'node_modules', '.bin', 'playwright');
  if (fs.existsSync(projectBin)) {
    return projectBin;
  }

  return null;
}

function buildPlaywrightCommand(projectPath, testArgs) {
  const cliPath = resolvePlaywrightCliPath(projectPath);
  if (cliPath) {
    const isJsCli = cliPath.endsWith('.js');
    return {
      command: isJsCli ? process.execPath : cliPath,
      args: isJsCli ? [cliPath, ...testArgs] : testArgs,
      cliPath,
    };
  }

  return {
    command: 'npx',
    args: ['--yes', '@playwright/test', ...testArgs],
    cliPath: null,
  };
}

function buildPlaywrightEnv(projectPath, cliPath = null) {
  const currentNodePath = String(process.env.NODE_PATH || '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);

  const extraNodePaths = [path.join(projectPath, 'node_modules')];
  if (cliPath && cliPath.endsWith('.js')) {
    const cliNodeModules = path.resolve(path.dirname(cliPath), '..', '..');
    extraNodePaths.push(cliNodeModules);
  }

  const mergedNodePath = [...new Set([...extraNodePaths, ...currentNodePath])];

  return {
    ...process.env,
    NODE_PATH: mergedNodePath.join(path.delimiter),
  };
}

async function validateGeneratedTestsWithList({ projectPath, validateGeneratedTests = true, timeoutMs = 90000 }) {
  if (!validateGeneratedTests) {
    return { valid: true, skipped: true, listedCount: 0 };
  }

  const generatedDir = path.join(projectPath, 'tests', 'generated');
  if (!fs.existsSync(generatedDir)) {
    return { valid: false, reason: 'generated_tests_missing' };
  }

  const testFiles = fs.readdirSync(generatedDir)
    .filter((name) => /\.spec\.(ts|js)$/i.test(name));

  if (testFiles.length === 0) {
    return { valid: false, reason: 'no_generated_tests' };
  }

  return new Promise((resolve) => {
    const testArgs = ['test', 'tests/generated', '--list'];
    const configPath = resolvePlaywrightConfig(projectPath);
    if (configPath) {
      testArgs.push('--config', configPath);
    }
    const command = buildPlaywrightCommand(projectPath, testArgs);

    const child = spawn(command.command, command.args, {
      cwd: projectPath,
      env: buildPlaywrightEnv(projectPath, command.cliPath),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({ valid: false, reason: 'validation_timeout', stderr: stderr.slice(0, 2000) });
    }, Math.max(1000, timeoutMs));

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const normalizedStdout = stdout.replace(/\u001b\[[0-9;]*m/g, '');
      const listLineMatches = normalizedStdout.match(/^[\s\S]*?$/gm) || [];
      const listedCount = listLineMatches.filter((line) => /\b›\b|\b\.spec\.(ts|js)\b|\btest\(/i.test(line)).length;

      if (code === 0 && listedCount > 0) {
        resolve({ valid: true, listedCount });
        return;
      }

      resolve({
        valid: false,
        reason: code !== 0 ? 'playwright_list_failed' : 'no_tests_listed',
        stdout: normalizedStdout.slice(0, 4000),
        stderr: stderr.replace(/\u001b\[[0-9;]*m/g, '').slice(0, 4000),
      });
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ valid: false, reason: 'validation_spawn_failed', stderr: error.message });
    });
  });
}

function auditGeneratedTestQuality({ projectPath, testType, context }) {
  const generatedDir = path.join(projectPath, 'tests', 'generated');
  const summary = {
    totalFiles: 0,
    apiFiles: 0,
    uiFiles: 0,
    hasApiBurstCoverage: false,
    selectorCoverageRatio: 0,
    riskyPatternHits: 0,
    riskyFiles: [],
    errors: [],
    warnings: [],
  };

  if (!fs.existsSync(generatedDir)) {
    summary.errors.push('generated_tests_missing');
    return { valid: false, ...summary };
  }

  const files = fs.readdirSync(generatedDir).filter((name) => /\.spec\.(ts|js)$/i.test(name));
  summary.totalFiles = files.length;

  if (files.length === 0) {
    summary.errors.push('no_generated_tests');
    return { valid: false, ...summary };
  }

  const preferredSelectorPattern = /getByRole|getByLabel|getByPlaceholder|getByTestId|getByText|getByAltText/;
  const routeMockPattern = /page\.route\(/i;
  const checkValidityPattern = /\.checkValidity\(/i;
  const riskyUiPattern = /page\.pause\(/i;
  const riskyPhrasesPattern = /(invalid credentials|email is required|password is required|network error|try again|not found|does not exist|cannot find)/gi;
  const enforcePhraseRiskGates = String(process.env.TESTBOT_ENFORCE_PHRASE_RISK_GATES || '').toLowerCase() === 'true';
  const knownCorpus = new Set();

  const collectKnownText = (value) => {
    if (!value) return;
    const normalized = String(value)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (normalized) {
      knownCorpus.add(normalized);
    }
  };

  for (const page of context?.pages || []) {
    collectKnownText(page.path);
    collectKnownText(page.description);
    (page.components || []).forEach(collectKnownText);
    (page.interactions || []).forEach(collectKnownText);
    (page.selectorHints || []).forEach(collectKnownText);
  }

  for (const form of context?.forms || []) {
    (form.validationPatterns || []).forEach(collectKnownText);
    (form.submitButtons || []).forEach(collectKnownText);
    (form.selectorHints || []).forEach(collectKnownText);
    for (const field of form.fields || []) {
      collectKnownText(field.label);
      collectKnownText(field.placeholder);
      collectKnownText(field.name);
    }
  }

  for (const workflow of context?.workflows || []) {
    if (typeof workflow === 'string') {
      collectKnownText(workflow);
      continue;
    }
    collectKnownText(workflow.name);
    collectKnownText(workflow.description);
  }

  (context?.selectorHints || []).forEach(collectKnownText);

  let uiFilesWithPreferredSelectors = 0;

  for (const name of files) {
    const fullPath = path.join(generatedDir, name);
    let content = '';
    try {
      content = fs.readFileSync(fullPath, 'utf-8');
    } catch {
      summary.warnings.push(`failed_to_read:${name}`);
      continue;
    }

    const isApiFile = /request\.(get|post|put|patch|delete|fetch)\(/i.test(content) || /api/i.test(name);
    if (isApiFile) {
      summary.apiFiles += 1;
      if (/Promise\.all|TESTBOT_API_STRESS_BURST|burst|p95|percentile/i.test(content)) {
        summary.hasApiBurstCoverage = true;
      }
    } else {
      summary.uiFiles += 1;
      if (preferredSelectorPattern.test(content)) {
        uiFilesWithPreferredSelectors += 1;
      }

      if (routeMockPattern.test(content)) {
        summary.warnings.push(`uses_route_mocking:${name}`);
      }

      if (checkValidityPattern.test(content)) {
        summary.warnings.push(`uses_check_validity:${name}`);
      }

      if (riskyUiPattern.test(content)) {
        summary.riskyPatternHits += 1;
        summary.riskyFiles.push(name);
      }

      const phraseMatches = content.match(riskyPhrasesPattern) || [];
      for (const phrase of phraseMatches) {
        const normalizedPhrase = String(phrase)
          .toLowerCase()
          .replace(/[^a-z0-9\s]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        const grounded = Array.from(knownCorpus).some((known) =>
          known.includes(normalizedPhrase) || normalizedPhrase.includes(known)
        );
        if (!grounded) {
          if (enforcePhraseRiskGates) {
            summary.riskyPatternHits += 1;
            summary.riskyFiles.push(name);
          } else {
            summary.warnings.push(`ungrounded_error_phrase:${name}`);
          }
          break;
        }
      }
    }
  }

  summary.selectorCoverageRatio = summary.uiFiles > 0
    ? Number((uiFilesWithPreferredSelectors / summary.uiFiles).toFixed(2))
    : 1;

  if ((testType === 'backend' || testType === 'both') && (context?.apiEndpoints || []).length > 0) {
    if (summary.apiFiles === 0) {
      summary.errors.push('missing_api_test_files');
    }
    if (!summary.hasApiBurstCoverage) {
      summary.errors.push('missing_api_burst_coverage');
    }
  }

  if ((testType === 'frontend' || testType === 'both') && summary.uiFiles > 0 && summary.selectorCoverageRatio < 0.5) {
    summary.warnings.push('low_preferred_selector_coverage');
  }

  summary.riskyFiles = [...new Set(summary.riskyFiles)];

  return {
    valid: summary.errors.length === 0,
    ...summary,
  };
}

async function maybeGenerateViaSaaS({ config, context, prdContent, testsDir, projectInfo }) {
  const testbotApiKey = process.env.TESTBOT_API_KEY;
  if (!testbotApiKey || !context) {
    return { generated: 0, files: [], skipped: true, reason: !testbotApiKey ? 'missing_testbot_api_key' : 'missing_context' };
  }

  const dashboardUrl = process.env.TESTBOT_DASHBOARD_URL || 'http://localhost:3000';
  const fetchFn = global.fetch || require('node-fetch');

  const response = await fetchFn(`${dashboardUrl}/api/generate-tests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: testbotApiKey,
      context,
      testType: config.testType,
      prd: prdContent || '',
      projectInfo,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`SaaS generation failed (${response.status}): ${text.slice(0, 300)}`);
  }

  const payload = await response.json();
  const tests = Array.isArray(payload.tests) ? payload.tests : [];
  const used = new Set();
  const files = [];

  tests.forEach((test, index) => {
    const written = safeWriteGeneratedTest(testsDir, test, index, 'saas-generated', used);
    files.push({ ...written, type: test.type || 'generated' });
  });

  return {
    generated: files.length,
    files,
    provider: 'saas',
  };
}

async function generateWithFallbackChain({ config, context, prdContent, runBudget, projectInfo }) {
  const strictAI = strictAIEnabled(config);
  const emergencyTemplates = templatesEmergencyEnabled();
  const generationMeta = {
    provider: null,
    selectedGenerator: null,
    fallbackUsed: false,
    aiOnlyEnforced: strictAI,
    templateFallbackEnabled: emergencyTemplates,
    attempts: [],
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };

  const generationMode = strictAI
    ? 'openai-only'
    : String(config.generationMode || 'openai-first').toLowerCase();
  const allowOpenAI = !['template-only', 'saas-only'].includes(generationMode);
  const allowTemplateByMode = !['openai-only', 'saas-only'].includes(generationMode);
  const allowTemplate = allowTemplateByMode && emergencyTemplates;
  const allowSaaS = !strictAI && !['openai-only', 'template-only'].includes(generationMode);

  const validateGeneratedTests = config.validateGeneratedTests !== false;

  const runValidation = async (generator) => withStageBudget(runBudget, 'validation', async () => {
    const validation = await validateGeneratedTestsWithList({
      projectPath: config.projectPath,
      validateGeneratedTests,
      timeoutMs: Math.min(getBudgetRemainingMs(runBudget), runBudget.stageCaps.validation),
    });

    if (!validation.valid) {
      const error = new Error(`${generator} generation failed validation: ${validation.reason || 'unknown'}`);
      error.code = 'GENERATION_VALIDATION_FAILED';
      error.validation = validation;
      throw error;
    }

    const qualityAudit = auditGeneratedTestQuality({
      projectPath: config.projectPath,
      testType: config.testType,
      context,
    });

    if (generator === 'openai' && qualityAudit.riskyPatternHits > 0) {
      qualityAudit.errors.push('openai_risky_assertions_detected');
      qualityAudit.valid = false;
    }

    if (!qualityAudit.valid) {
      const error = new Error(`${generator} generation failed quality audit: ${qualityAudit.errors.join(',')}`);
      error.code = 'GENERATION_VALIDATION_FAILED';
      error.validation = {
        ...validation,
        qualityAudit,
      };
      throw error;
    }

    return {
      ...validation,
      qualityAudit,
    };
  });

  const tryGenerator = async (generatorName, runFn) => {
    const startedAt = Date.now();

    try {
      const result = await withStageBudget(runBudget, 'generation', runFn);
      let cursorOverlay = null;
      if (config.generateTests) {
        try {
          cursorOverlay = applyMouseCursorOverlayToGeneratedTests({
            projectPath: config.projectPath,
            enabled: isVideoCursorEnabled(config),
          });
        } catch (cursorError) {
          cursorOverlay = {
            enabled: false,
            reason: 'patch_failed',
            error: cursorError.message,
          };
          Logger.warn('PipelineWorker', 'Failed to apply cursor overlay patch', {
            generator: generatorName,
            reason: cursorError.message,
          });
        }
      }
      const validation = await runValidation(generatorName);

      generationMeta.provider = generatorName;
      generationMeta.selectedGenerator = generatorName;
      generationMeta.fallbackUsed = generationMeta.attempts.length > 0;
      generationMeta.videoCursor = cursorOverlay;
      generationMeta.attempts.push({
        generator: generatorName,
        status: 'success',
        generated: result.generated || result.files?.length || 0,
        durationMs: Date.now() - startedAt,
        validation,
        videoCursor: cursorOverlay,
      });

      return result;
    } catch (error) {
      const summarizedReason = summarizeGenerationAttemptError(error);
      const errorCode = error?.code ? String(error.code) : classifyErrorCode(error);
      generationMeta.attempts.push({
        generator: generatorName,
        status: 'failed',
        reason: summarizedReason,
        rawReason: normalizeErrorText(error?.message),
        errorCode,
        validation: error.validation,
        durationMs: Date.now() - startedAt,
      });
      return null;
    }
  };

  let result = null;

  if (allowOpenAI) {
    if (!process.env.OPENAI_API_KEY) {
      if (strictAI) {
        const error = new Error('OpenAI API key is required in strict AI generation mode');
        error.code = 'OPENAI_KEY_MISSING';
        generationMeta.finishedAt = new Date().toISOString();
        error.generationMeta = generationMeta;
        throw error;
      }
      generationMeta.attempts.push({
        generator: 'openai',
        status: 'skipped',
        reason: 'missing_api_key',
      });
    } else {
      result = await tryGenerator('openai', async () => {
        const testsDir = resetGeneratedTestsDir(config.projectPath);
        const generationStageCapMs = toFiniteNumber(runBudget?.stageCaps?.generation, DEFAULT_STAGE_CAPS_MS.generation);
        const explicitOpenAITimeoutMs = toFiniteNumber(
          config.openaiTimeoutMs || process.env.OPENAI_TIMEOUT_MS,
          0
        );
        const openAITimeoutMs = explicitOpenAITimeoutMs > 0
          ? explicitOpenAITimeoutMs
          : Math.max(30000, Math.min(90000, Math.floor(generationStageCapMs / 4)));
        const openAIMaxRetries = Number.isFinite(Number(config.openaiMaxRetries))
          ? Math.max(0, Math.floor(Number(config.openaiMaxRetries)))
          : strictAI
            ? 1
            : 2;
        const openAIRetryBackoffMs = Number.isFinite(Number(config.openaiRetryBackoffMs))
          ? Math.max(100, Math.floor(Number(config.openaiRetryBackoffMs)))
          : 750;

        const openaiGenerator = new OpenAITestGenerator({
          projectPath: config.projectPath,
          outputDir: 'tests/generated',
          fallbackOnFailure: strictAI ? false : config.enableGeneratorFallback === true,
          enforceValidation: config.validateGeneratedTests !== false,
          syntaxValidationMode: config.syntaxValidationMode || 'fail-closed',
          temperature: Number.isFinite(config.openaiTemperature) ? config.openaiTemperature : undefined,
          timeout: openAITimeoutMs,
          maxRetries: openAIMaxRetries,
          retryBackoffMs: openAIRetryBackoffMs,
        });

        const files = await openaiGenerator.generateTests({
          context: context || { pages: [], apiEndpoints: [], workflows: [] },
          prd: prdContent || '',
          testType: config.testType,
          projectInfo,
          options: {
            includeSmoke: true,
            includeWorkflows: true,
            includeErrorStates: true,
            coverageProfile: config.coverageProfile || 'qa-max',
            minGeneratedTests: toFiniteNumber(config.minGeneratedTests, 50),
            strictAIGeneration: strictAI,
          },
        });

        if (!Array.isArray(files) || files.length === 0) {
          const emptyError = new Error('OpenAI generated no files');
          emptyError.code = 'AI_GENERATION_INSUFFICIENT';
          throw emptyError;
        }

        if (strictAI) {
          const nonAIFile = files.find((file) => {
            const source = String(file.source || '').toLowerCase();
            return source.includes('template') || source.includes('fallback');
          });
          if (nonAIFile) {
            const sourceError = new Error(`Strict AI mode rejected non-AI source file: ${nonAIFile.filename}`);
            sourceError.code = 'AI_GENERATION_INSUFFICIENT';
            throw sourceError;
          }
        }

        const summary = openaiGenerator.getSummary();
        generationMeta.openai = summary;
        return { generated: files.length, files };
      });
    }
  }

  if (!result && allowTemplateByMode && !allowTemplate) {
    generationMeta.attempts.push({
      generator: 'template',
      status: 'skipped',
      reason: 'template_fallback_disabled_without_TESTBOT_ENABLE_TEMPLATES',
    });
  }

  if (!result && allowTemplate) {
    result = await tryGenerator('template', async () => {
      resetGeneratedTestsDir(config.projectPath);
      const templateGenerator = new PlaywrightMCPClient(config);
      const generationResult = await templateGenerator.generateTests({
        context: context || { pages: [], apiEndpoints: [], workflows: [] },
        testType: config.testType,
        projectPath: config.projectPath,
        prdFile: config.prdFile,
      });

      if (!generationResult?.generated) {
        throw new Error('Template generator returned no files');
      }

      return generationResult;
    });
  }

  if (!result && allowSaaS) {
    result = await tryGenerator('saas', async () => {
      const testsDir = resetGeneratedTestsDir(config.projectPath);
      const saasResult = await maybeGenerateViaSaaS({
        config,
        context,
        prdContent,
        testsDir,
        projectInfo,
      });

      if (!saasResult.generated) {
        throw new Error(`SaaS generator produced no files (${saasResult.reason || 'unknown'})`);
      }

      return saasResult;
    });
  }

  generationMeta.finishedAt = new Date().toISOString();

  if (!result) {
    const failedAttempts = generationMeta.attempts.filter((attempt) => attempt.status === 'failed');
    const primaryFailure = failedAttempts[failedAttempts.length - 1] || null;
    const errorCode = primaryFailure?.errorCode || (strictAI ? 'AI_GENERATION_INSUFFICIENT' : 'GENERATION_FAILED');
    const reason = primaryFailure?.reason || null;
    const message = strictAI
      ? (reason ? `Strict AI generation failed: ${reason}` : 'Strict AI generation failed to produce valid tests')
      : (reason ? `All test generation strategies failed: ${reason}` : 'All test generation strategies failed');

    const error = new Error(message);
    error.code = errorCode;
    error.generationMeta = generationMeta;
    error.primaryFailure = primaryFailure;
    throw error;
  }

  return {
    ...result,
    generationMeta,
  };
}

async function maybeRunFailureTriage({ config, testResults, runBudget }) {
  if (config.aiFailureAnalysis === false) {
    return null;
  }

  if (!testResults?.failures?.length) {
    return null;
  }

  const providerConfig = resolveFailureAnalysisProvider(config);
  if (providerConfig.reason) {
    Logger.info('PipelineWorker', 'Skipping AI failure triage', {
      reason: providerConfig.reason,
      provider: providerConfig.provider,
    });
    return null;
  }

  const limit = toFiniteNumber(config.aiFailureLimit || process.env.TESTBOT_AI_TRIAGE_LIMIT, 8);
  const failures = testResults.failures.slice(0, limit);

  return withStageBudget(runBudget, 'aiTriage', async () => {
    const analyzer = AIAnalyzer.create(providerConfig.provider, providerConfig.apiKey);
    const analysis = await analyzer.analyzeFailures(failures);
    return Array.isArray(analysis) ? analysis : null;
  });
}

/**
 * Main pipeline function.
 */
async function runPipeline(config, runId) {
  const statusDir = path.join(config.projectPath, 'testbot-reports', '.runs', runId);
  ensureDir(statusDir);
  const telemetryReporter = new MCPTelemetryReporter();

  const runBudget = createRunBudget(config);
  let generationMeta = null;
  let fallbackUsed = false;
  let generationQuality = null;
  let requirementsCoverage = null;
  let phaseResults = null;
  const aiOnlyEnforced = strictAIEnabled(config);

  updateStatus(statusDir, 'started', {
    runId,
    message: 'Pipeline started',
    project: config.projectName,
    budgetMs: runBudget.totalMs,
    aiOnlyEnforced,
  }, telemetryReporter);
  Logger.info('PipelineWorker', 'Pipeline started', {
    runId,
    project: config.projectName,
    budgetMs: runBudget.totalMs,
  });

  try {
    // -------------------------------------------------------
    // 0. Port pre-flight check (must run before test generation)
    // -------------------------------------------------------
    // If another process is already listening on the configured port, find a
    // free one NOW — before AI generates tests — so that test files are written
    // with the correct baseURL from the start.
    if (config.startCommand) {
      const configuredPort = Number(config.port || 0);
      if (configuredPort > 0) {
        const _tempPI = new PlaywrightIntegration(config);
        const portInUse = await _tempPI.probeTcpPort('127.0.0.1', configuredPort, 500)
          || await _tempPI.probeTcpPort('localhost', configuredPort, 500);
        if (portInUse) {
          const freePort = await _tempPI.findFreePort(configuredPort + 1);
          Logger.warn('PipelineWorker', `Port ${configuredPort} is already in use — switching dev server to port ${freePort}`, {
            originalPort: configuredPort,
            newPort: freePort,
          });
          try {
            const parsedBase = new URL(config.baseURL);
            parsedBase.port = String(freePort);
            config = { ...config, port: freePort, baseURL: parsedBase.toString().replace(/\/$/, '') };
          } catch {
            config = { ...config, port: freePort, baseURL: `http://localhost:${freePort}` };
          }
          updateStatus(statusDir, 'port_conflict', {
            runId,
            message: `Port ${configuredPort} is already in use. Dev server will start on port ${freePort} instead.`,
            project: config.projectName,
            originalPort: configuredPort,
            newPort: freePort,
            aiOnlyEnforced,
          }, telemetryReporter);
        }
      }
    }

    // -------------------------------------------------------
    // 1. Jira integration (optional)
    // -------------------------------------------------------
    let jiraStories = null;
    if (config.jira?.enabled) {
      updateStatus(statusDir, 'jira', {
        runId,
        message: 'Fetching Jira stories...',
        aiOnlyEnforced,
      }, telemetryReporter);

      jiraStories = await withStageBudget(runBudget, 'jira', async () => {
        const jiraClient = new JiraClient(config.jira);
        const stories = await jiraClient.fetchActiveStories();
        Logger.info('PipelineWorker', 'Fetched Jira stories', { count: stories.length });
        return stories;
      });
    }

    // -------------------------------------------------------
    // 2. Gather codebase context
    // -------------------------------------------------------
    let codebaseContext = config.codebaseContext;
    if (config.generateTests && !codebaseContext) {
      updateStatus(statusDir, 'context', {
        runId,
        message: 'Gathering codebase context...',
        aiOnlyEnforced,
      }, telemetryReporter);

      codebaseContext = await withStageBudget(runBudget, 'context', async () => {
        const contextGatherer = new ContextGatherer({
          projectPath: config.projectPath,
          language: config.language,
        });
        return contextGatherer.gatherRichContext();
      });

      Logger.info('PipelineWorker', 'Codebase context gathered', {
        pages: codebaseContext.pages?.length || 0,
        endpoints: codebaseContext.apiEndpoints?.length || 0,
        workflows: codebaseContext.workflows?.length || 0,
      });

      if (config.ideContextMode !== 'off') {
        updateStatus(statusDir, 'context_enrichment', {
          runId,
          message: 'Requesting optional IDE context enrichment...',
          aiOnlyEnforced,
        }, telemetryReporter);

        try {
          const requester = new AgentContextRequester({
            projectPath: config.projectPath,
            responseTimeout: toFiniteNumber(config.ideContextTimeoutMs, 2500),
          });

          const agentContext = await withStageBudget(runBudget, 'context', async () =>
            requester.requestContext(codebaseContext, toFiniteNumber(config.ideContextTimeoutMs, 2500))
          );

          if (agentContext && typeof agentContext === 'object' && Object.keys(agentContext).length > 0) {
            codebaseContext = requester.mergeContexts(codebaseContext, agentContext);
            const summary = requester.summarizeContext(codebaseContext);
            Logger.info('PipelineWorker', 'IDE context enrichment applied', summary);
          } else {
            Logger.info('PipelineWorker', 'IDE context enrichment not provided; continuing with auto-gathered context');
          }
        } catch (error) {
          Logger.warn('PipelineWorker', 'IDE context enrichment failed (best-effort)', { reason: error.message });
        }
      }
    }

    // -------------------------------------------------------
    // 3. Read PRD file if specified
    // -------------------------------------------------------
    let prdContent = null;
    if (config.prdFile) {
      try {
        prdContent = fs.readFileSync(config.prdFile, 'utf-8');
        Logger.info('PipelineWorker', 'Read PRD file', { path: config.prdFile, length: prdContent.length });
      } catch (error) {
        Logger.warn('PipelineWorker', 'Could not read PRD file', { path: config.prdFile, reason: error.message });
      }
    }

    const projectInfo = {
      name: config.projectName,
      framework: codebaseContext?.projectStructure?.framework || 'Unknown',
      baseURL: config.baseURL,
      startCommand: config.startCommand,
    };

    // -------------------------------------------------------
    // 4. Generate tests
    // -------------------------------------------------------
    if (config.generateTests) {
      updateStatus(statusDir, 'generating', {
        runId,
        message: 'Generating tests...',
        aiOnlyEnforced,
      }, telemetryReporter);

      const generationResult = await generateWithFallbackChain({
        config,
        context: codebaseContext,
        prdContent,
        runBudget,
        projectInfo,
      });

      generationMeta = generationResult.generationMeta;
      fallbackUsed = !!generationMeta?.fallbackUsed;

      if (aiOnlyEnforced && generationMeta?.selectedGenerator !== 'openai') {
        const sourceError = new Error(`Strict AI mode requires OpenAI generator, received '${generationMeta?.selectedGenerator || 'unknown'}'`);
        sourceError.code = 'AI_GENERATION_INSUFFICIENT';
        sourceError.generationMeta = generationMeta;
        throw sourceError;
      }

      const qualityScan = collectGenerationQuality(config.projectPath);
      const qualityGate = evaluateGenerationQualityGates({
        config,
        context: codebaseContext || {},
        quality: qualityScan,
      });
      if (!qualityGate.ok) {
        qualityGate.error.generationMeta = generationMeta;
        throw qualityGate.error;
      }
      generationQuality = qualityGate.result;
      requirementsCoverage = buildRequirementsCoverage({
        prdContent,
        projectPath: config.projectPath,
      });

      if (aiOnlyEnforced && requirementsCoverage.totalRequirements > 0 && requirementsCoverage.mappedRequirements === 0) {
        const requirementsError = new Error('BRD requirement trace coverage is zero in generated suite');
        requirementsError.code = 'COVERAGE_GATES_FAILED';
        requirementsError.generationMeta = generationMeta;
        requirementsError.generationQuality = generationQuality;
        throw requirementsError;
      }

      Logger.info('PipelineWorker', 'Generated tests', {
        selectedGenerator: generationMeta?.selectedGenerator,
        generated: generationResult.generated || generationResult.files?.length || 0,
        fallbackUsed,
        totalTests: generationQuality.totalTests,
        categories: generationQuality.categories,
      });

      if (jiraStories?.length) {
        await withStageBudget(runBudget, 'generation', async () => {
          const playwright = new PlaywrightIntegration(config);
          await playwright.generateTests({
            prdFile: config.prdFile,
            jiraStories,
            testType: config.testType,
          });
        });
      }
    }

    // -------------------------------------------------------
    // 5. Run tests
    // -------------------------------------------------------
    updateStatus(statusDir, 'running', {
      runId,
      message: 'Running Playwright tests...',
      generationMeta,
      fallbackUsed,
      aiOnlyEnforced,
      generationQuality,
      requirementsCoverage,
    }, telemetryReporter);

    const executionTimeout = Math.max(1000, Math.min(getBudgetRemainingMs(runBudget), runBudget.stageCaps.execution));
    const playwright = new PlaywrightIntegration({
      ...config,
      timeout: executionTimeout,
    });

    const mcpParallelEnabled =
      process.env.PLAYWRIGHT_MCP_PARALLEL === 'true' ||
      process.env.PLAYWRIGHT_MCP_ENABLED === 'true';

    let testResults;

    testResults = await withStageBudget(runBudget, 'execution', async () => {
      if (!mcpParallelEnabled) {
        return playwright.runTests();
      }

      Logger.info('PipelineWorker', 'Parallel execution enabled: direct + Playwright MCP');
      const playwrightMCPIntegration = new PlaywrightMCPIntegration({
        projectPath: config.projectPath,
        baseURL: config.baseURL,
        mcpPackageName: config.playwrightMcp?.mcpPackageName,
        mcpVersion: config.playwrightMcp?.mcpVersion,
        noInstall: config.playwrightMcp?.noInstall,
      });

      const [directOutcome, mcpOutcome] = await Promise.allSettled([
        playwright.runTests(),
        playwrightMCPIntegration.runTests(),
      ]);

      if (directOutcome.status === 'rejected' && mcpOutcome.status === 'rejected') {
        throw new Error(`Both test runners failed: direct=${directOutcome.reason?.message} mcp=${mcpOutcome.reason?.message}`);
      }

      if (directOutcome.status === 'fulfilled' && mcpOutcome.status === 'fulfilled') {
        const merger = new ResultsMerger({
          projectPath: config.projectPath,
          dedupeStrategy: config.resultMerge?.dedupeStrategy,
        });
        return merger.mergeResults(directOutcome.value, mcpOutcome.value);
      }

      if (directOutcome.status === 'fulfilled') {
        Logger.warn('PipelineWorker', 'Playwright MCP execution failed; using direct results only', {
          reason: mcpOutcome.reason?.message,
        });
        return directOutcome.value;
      }

      Logger.warn('PipelineWorker', 'Direct execution failed; using Playwright MCP results only', {
        reason: directOutcome.reason?.message,
      });
      return mcpOutcome.value;
    });

    Logger.info('PipelineWorker', 'Tests completed', {
      total: testResults.total,
      passed: testResults.passed,
      failed: testResults.failed,
    });
    phaseResults = testResults.phaseResults || null;

    const initialPassRate = computePassRatePercent(testResults);
    const minOpenAIPassRate = toFiniteNumber(config.openaiMinPassRate || process.env.TESTBOT_OPENAI_MIN_PASS_RATE, 70);
    const shouldRetryWithTemplate = (
      generationMeta?.selectedGenerator === 'openai' &&
      !strictAIEnabled(config) &&
      templatesEmergencyEnabled() &&
      modeAllowsTemplateFallback(config.generationMode) &&
      initialPassRate < minOpenAIPassRate &&
      getBudgetRemainingMs(runBudget) > 30000
    );

    if (shouldRetryWithTemplate) {
      updateStatus(statusDir, 'rerun_template', {
        runId,
        message: `OpenAI suite pass rate ${initialPassRate.toFixed(2)}% is below threshold ${minOpenAIPassRate}%. Regenerating deterministic template suite.`,
        generationMeta,
        fallbackUsed,
        aiOnlyEnforced,
      }, telemetryReporter);

      Logger.warn('PipelineWorker', 'OpenAI suite below pass-rate threshold; retrying with template fallback', {
        initialPassRate: Number(initialPassRate.toFixed(2)),
        minOpenAIPassRate,
      });

      const templateGenerationResult = await generateWithFallbackChain({
        config: {
          ...config,
          generationMode: 'template-only',
        },
        context: codebaseContext,
        prdContent,
        runBudget,
        projectInfo,
      });

      const retryExecutionTimeout = Math.max(1000, Math.min(getBudgetRemainingMs(runBudget), runBudget.stageCaps.execution));
      const retryPlaywright = new PlaywrightIntegration({
        ...config,
        timeout: retryExecutionTimeout,
      });
      const retryResults = await withStageBudget(runBudget, 'execution', async () => retryPlaywright.runTests());
      const retryPassRate = computePassRatePercent(retryResults);

      generationMeta = {
        ...generationMeta,
        rerun: {
          reason: 'low_openai_pass_rate',
          threshold: minOpenAIPassRate,
          initialPassRate: Number(initialPassRate.toFixed(2)),
          templatePassRate: Number(retryPassRate.toFixed(2)),
          templateGenerationMeta: templateGenerationResult.generationMeta,
        },
      };

      if (retryPassRate >= initialPassRate) {
        testResults = retryResults;
        phaseResults = retryResults.phaseResults || phaseResults;
        fallbackUsed = true;
        generationMeta.selectedGenerator = 'template-after-openai';
        generationMeta.fallbackUsed = true;
        Logger.warn('PipelineWorker', 'Template fallback adopted after low OpenAI pass rate', {
          initialPassRate: Number(initialPassRate.toFixed(2)),
          templatePassRate: Number(retryPassRate.toFixed(2)),
        });
      } else {
        Logger.warn('PipelineWorker', 'Template fallback retry produced lower pass rate; keeping OpenAI execution results', {
          initialPassRate: Number(initialPassRate.toFixed(2)),
          templatePassRate: Number(retryPassRate.toFixed(2)),
        });
      }
    }

    updateStatus(statusDir, 'tests_complete', {
      runId,
      message: `Tests completed: ${testResults.passed}/${testResults.total} passed`,
      results: {
        total: testResults.total,
        passed: testResults.passed,
        failed: testResults.failed,
        skipped: testResults.skipped,
        duration: testResults.duration,
      },
      generationMeta,
      fallbackUsed,
      aiOnlyEnforced,
      generationQuality,
      requirementsCoverage,
      phaseResults,
    }, telemetryReporter);

    // -------------------------------------------------------
    // 6. Optional AI failure triage
    // -------------------------------------------------------
    let aiAnalysis = null;
    try {
      aiAnalysis = await maybeRunFailureTriage({
        config,
        testResults,
        runBudget,
      });
    } catch (triageError) {
      Logger.warn('PipelineWorker', 'AI failure triage failed', { reason: triageError.message });
      aiAnalysis = null;
    }

    // -------------------------------------------------------
    // 7. Generate report
    // -------------------------------------------------------
    updateStatus(statusDir, 'reporting', {
      runId,
      message: 'Generating report...',
      generationMeta,
      fallbackUsed,
      aiOnlyEnforced,
      generationQuality,
      requirementsCoverage,
      phaseResults,
    }, telemetryReporter);

    const report = await withStageBudget(runBudget, 'reporting', async () => {
      const reportGen = new ReportGenerator();
      const testbotApiKey = process.env.TESTBOT_API_KEY;
      const testbotDashboardUrl = process.env.TESTBOT_DASHBOARD_URL || 'http://localhost:3000';

      return reportGen.generate({
        projectPath: config.projectPath,
        projectName: config.projectName,
        runId,
        testResults,
        aiAnalysis,
        jiraData: jiraStories,
        generationMeta,
        generationQuality,
        requirementsCoverage,
        phaseResults,
        fallbackUsed,
        api_key: testbotApiKey,
        dashboard_url: testbotDashboardUrl,
      });
    });

    // -------------------------------------------------------
    // 8. Open dashboard
    // -------------------------------------------------------
    let dashboardUrl = null;
    if (config.openDashboard) {
      try {
        dashboardUrl = await withStageBudget(runBudget, 'dashboard', async () => DashboardLauncher.open(report.path, {
          headless: config.headless,
          openBrowser: config.autoOpenBrowser,
        }));
      } catch (error) {
        Logger.warn('PipelineWorker', 'Dashboard open failed', { reason: error.message });
        dashboardUrl = report.url || `file://${report.path}`;
      }
    }

    // -------------------------------------------------------
    // 9. Final status
    // -------------------------------------------------------
    const passRate = testResults.total > 0
      ? `${Math.round((testResults.passed / testResults.total) * 100)}%`
      : '0%';

    updateStatus(statusDir, 'completed', {
      runId,
      message: `Pipeline complete — ${passRate} pass rate`,
      results: {
        total: testResults.total,
        passed: testResults.passed,
        failed: testResults.failed,
        skipped: testResults.skipped,
        duration: `${testResults.duration}ms`,
        passRate,
      },
      reportPath: report.path,
      dashboardUrl: dashboardUrl || report.url,
      generationMeta,
      fallbackUsed,
      aiOnlyEnforced,
      generationQuality,
      requirementsCoverage,
      phaseResults,
      budget: {
        totalMs: runBudget.totalMs,
        consumedMs: getBudgetElapsedMs(runBudget),
        remainingMs: getBudgetRemainingMs(runBudget),
      },
    }, telemetryReporter);

    Logger.info('PipelineWorker', 'Pipeline complete', {
      report: report.path,
      dashboard: dashboardUrl || report.url,
      runId,
    });
  } catch (error) {
    const errorCode = classifyErrorCode(error);
    const userFacingError = buildUserFacingPipelineError(errorCode, error);
    const technicalError = normalizeErrorText(error?.message);
    Logger.error('PipelineWorker', 'Pipeline error', error, { errorCode, runId });
    const errorGenerationMeta = error.generationMeta || generationMeta || {
      provider: null,
      selectedGenerator: null,
      fallbackUsed: false,
      aiOnlyEnforced,
      attempts: [],
      startedAt: null,
      finishedAt: new Date().toISOString(),
      reason: config.generateTests === false ? 'generation_skipped_use_existing_tests' : 'generation_not_started',
    };
    const errorGenerationQuality = error.generationQuality || generationQuality;

    updateStatus(statusDir, 'error', {
      runId,
      message: `Pipeline failed: ${userFacingError}`,
      error: userFacingError,
      errorDetail: technicalError,
      stack: error.stack,
      errorCode,
      generationMeta: errorGenerationMeta,
      fallbackUsed,
      aiOnlyEnforced,
      generationQuality: errorGenerationQuality,
      requirementsCoverage,
      phaseResults,
      budget: {
        totalMs: runBudget.totalMs,
        consumedMs: getBudgetElapsedMs(runBudget),
        remainingMs: getBudgetRemainingMs(runBudget),
      },
    }, telemetryReporter);

    try {
      const reportGen = new ReportGenerator();
      const syntheticFailure = {
        testName: `[PIPELINE_ERROR:${errorCode}] TestBot pipeline failed before/while execution`,
        file: 'pipeline-worker.js',
        status: 'failed',
        duration: 0,
        error: {
          message: userFacingError,
          detail: technicalError,
        },
        artifacts: {
          screenshots: [],
          videos: [],
          traces: [],
          other: [],
        },
      };

      const syntheticTestResults = {
        total: 1,
        passed: 0,
        failed: 1,
        skipped: 0,
        duration: 0,
        tests: [
          {
            id: `pipeline-error-${runId}`,
            title: syntheticFailure.testName,
            suite: 'pipeline',
            file: syntheticFailure.file,
            status: 'failed',
            duration: 0,
            retries: 0,
            error: syntheticFailure.error,
            artifacts: syntheticFailure.artifacts,
          },
        ],
        failures: [syntheticFailure],
      };

      const testbotApiKey = process.env.TESTBOT_API_KEY;
      const testbotDashboardUrl = process.env.TESTBOT_DASHBOARD_URL || 'http://localhost:3000';
      const errorReport = await reportGen.generate({
        projectPath: config.projectPath,
        projectName: config.projectName,
        runId,
        testResults: syntheticTestResults,
        aiAnalysis: null,
        jiraData: null,
        generationMeta: errorGenerationMeta,
        generationQuality: errorGenerationQuality,
        requirementsCoverage,
        phaseResults,
        fallbackUsed,
        api_key: testbotApiKey,
        dashboard_url: testbotDashboardUrl,
      });

      updateStatus(statusDir, 'error_reported', {
        runId,
        message: 'Pipeline failed and error report was generated.',
        errorCode,
        reportPath: errorReport.path,
        dashboardUrl: errorReport.url,
        generationMeta: errorGenerationMeta,
        generationQuality: errorGenerationQuality,
        requirementsCoverage,
        phaseResults,
      }, telemetryReporter);
    } catch (reportError) {
      Logger.warn('PipelineWorker', 'Failed to generate/sync error report', {
        runId,
        reason: reportError.message,
      });
    }
  }
}

// -------------------------------------------------------
// Entry point: receive config via IPC from parent
// -------------------------------------------------------
if (require.main === module) {
  process.on('message', (msg) => {
    // Disconnect IPC so parent is free
    try {
      process.disconnect();
    } catch (e) {
      // already disconnected
    }

    let config;
    let runId;

    // Config may be passed via a temp file (to avoid large IPC pipe-buffer deadlock on Windows)
    if (msg.configFile) {
      try {
        const raw = fs.readFileSync(msg.configFile, 'utf-8');
        const parsed = JSON.parse(raw);
        config = parsed.config;
        runId = parsed.runId || msg.runId;
      } catch (readErr) {
        Logger.error('PipelineWorker', 'Failed to read config temp file', readErr, { configFile: msg.configFile });
        process.exit(1);
        return;
      }
    } else {
      config = msg.config;
      runId = msg.runId;
    }

    // Run pipeline
    runPipeline(config, runId)
      .then(() => process.exit(0))
      .catch((err) => {
        Logger.error('PipelineWorker', 'Fatal error', err);
        process.exit(1);
      });
  });
}

module.exports = {
  runPipeline,
  generateWithFallbackChain,
  collectGenerationQuality,
  evaluateGenerationQualityGates,
  buildRequirementsCoverage,
  auditGeneratedTestQuality,
  strictAIEnabled,
  classifyErrorCode,
  buildUserFacingPipelineError,
};
