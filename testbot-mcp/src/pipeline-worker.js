/**
 * Pipeline Worker
 * Runs the full Healix pipeline in a background process.
 * Receives config via IPC from the MCP server, runs independently.
 */

const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');

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
const ResultsMerger = require('./results-merger');
const ContextGatherer = require('./context-gatherer');
const AgentContextRequester = require('./agent-context-requester');
let JiraClient;
try { JiraClient = require('./jira/client'); } catch { JiraClient = null; }
const ReportGenerator = require('./report-generator');
const ArtifactUploader = require('./artifact-uploader');
const DashboardLauncher = require('./dashboard-launcher');
const AIAnalyzer = require('./ai-providers/index');
const WebappClient = require('./webapp-client');
const { startSecondaryServices, stopSecondaryServices } = require('./multi-service-starter');
const { runExplorationPhase, EMPTY_ARTIFACT } = require('./exploration-phase');
const { injectCredentials } = require('./credentials-injector');
const Logger = require('./logger');
const MCPTelemetryReporter = require('./mcp-telemetry');

// Initialize logger for the worker process
Logger.initialize();

const DEFAULT_TOTAL_BUDGET_MS = 3600000; // 60 minutes
const DEFAULT_STAGE_CAPS_MS = {
  jira: 45000,
  context: 90000,
  prdParse: 90000,
  generation: 360000,  // 6 minutes
  validation: 90000,
  execution: 2400000,  // 40 minutes
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

const CURSOR_FIXTURE_BASENAME = '__healix-fixture';
const CURSOR_OVERLAY_INIT_SCRIPT = `
(() => {
  if (window.__healixCursorOverlayInstalled) return;
  window.__healixCursorOverlayInstalled = true;

  const ensureCursor = () => {
    const existing = document.getElementById('__healix-cursor-overlay');
    if (existing) return existing;

    const dot = document.createElement('div');
    dot.id = '__healix-cursor-overlay';
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
    const dot = document.getElementById('__healix-cursor-overlay');
    if (dot) dot.style.opacity = '0';
  };

  document.addEventListener('mousemove', move, true);
  document.addEventListener('mouseenter', move, true);
  document.addEventListener('mouseleave', hide, true);
})();
`;

// ── Healix PID-file helpers ────────────────────────────────────────────────
// We write a PID file for every process Healix starts (dev server, worker).
// On the next run startup we read these files and kill only those PIDs —
// never any unrelated user process.

const HEALIX_SERVER_PID_FILENAME  = '.healix-server.pid';
const HEALIX_WORKER_PID_FILENAME  = '.healix-worker.pid';

/**
 * Kill a process tree identified by a PID file Healix previously wrote.
 * Silently no-ops if the file is missing or the process is already gone.
 * Removes the file regardless.
 */
function killOrphanedHealixProcess(pidFile, label) {
  if (!fs.existsSync(pidFile)) return;
  let pid;
  try {
    pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
  } catch { /* unreadable — just delete */ }

  if (pid > 0) {
    try {
      if (process.platform === 'win32') {
        const { spawnSync } = require('child_process');
        spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
      } else {
        try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
      }
      Logger.info('PipelineWorker', `Killed leftover Healix ${label} process`, { pid });
    } catch { /* process already gone — ignore */ }
  }

  try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
}

/**
 * Write a PID to a Healix-owned PID file so it can be cleaned up later.
 */
function writeHealixPidFile(pidFile, pid) {
  try { fs.writeFileSync(pidFile, String(pid)); } catch { /* non-fatal */ }
}

// ────────────────────────────────────────────────────────────────────────────

function toFiniteNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function createRunBudget(config = {}) {
  const totalMs = toFiniteNumber(config.maxRunMs || process.env.HEALIX_RUN_BUDGET_MS, DEFAULT_TOTAL_BUDGET_MS);
  const stageCaps = {};
  for (const [stage, fallback] of Object.entries(DEFAULT_STAGE_CAPS_MS)) {
    const envKey = `HEALIX_STAGE_${stage.toUpperCase()}_MS`;
    stageCaps[stage] = toFiniteNumber(config.stageCaps?.[stage] || process.env[envKey], fallback);
  }

  const strictAI = strictAIEnabled(config);
  const coverageProfile = String(config.coverageProfile || 'qa-max').toLowerCase();
  const twoPhase = String(config.phaseMode || 'two-phase') === 'two-phase';

  const hasExplicitGenerationCap = Boolean(config.stageCaps?.generation) || Boolean(process.env.HEALIX_STAGE_GENERATION_MS);
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
  const hasExplicitExecutionCap = Boolean(config.stageCaps?.execution) || Boolean(process.env.HEALIX_STAGE_EXECUTION_MS);
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

function strictAIEnabled(config = {}) {
  return config.strictAIGeneration !== false;
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

function buildRequirementsCoverage({ prdContent, prdContents, projectPath }) {
  const fallback = {
    totalRequirements: 0,
    mappedRequirements: 0,
    uncoveredRequirements: [],
  };

  const allPrdContent = [];
  if (prdContent && String(prdContent).trim()) {
    allPrdContent.push(String(prdContent));
  }
  if (Array.isArray(prdContents)) {
    for (const content of prdContents) {
      if (content && String(content).trim()) {
        allPrdContent.push(String(content));
      }
    }
  }

  if (allPrdContent.length === 0) {
    return fallback;
  }

  const combinedPrdContent = allPrdContent.join('\n');
  const requirementMatches = combinedPrdContent.match(/\b(?:REQ|AC|US)[-_ ]?\d+\b/gi) || [];
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

  // Log warning if below minimum but don't fail the pipeline
  if (quality.totalTests < minGeneratedTests) {
    Logger.warn('PipelineWorker', `Generated tests ${quality.totalTests} below minimum ${minGeneratedTests}, but continuing pipeline`);
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

// Optional reporter — installed by runPipeline when a HEALIX_API_KEY is present.
// Every stage emits a `stage_budget_consumed` telemetry event through this so
// dashboards can see "parsing took 62s of a 90s cap" without the run ingesting
// first.
let __stageBudgetReporter = null;
function setStageBudgetReporter(fn) {
  __stageBudgetReporter = typeof fn === 'function' ? fn : null;
}

async function withStageBudget(budget, stage, workFn) {
  const remainingMs = getBudgetRemainingMs(budget);
  if (remainingMs <= 0) {
    throw createBudgetError(`No budget left before stage: ${stage}`);
  }

  const capMs = budget.stageCaps[stage] || remainingMs;
  const timeoutMs = Math.max(1000, Math.min(capMs, remainingMs));
  const startedAt = Date.now();

  let timeoutRef;
  let success = false;
  try {
    const result = await Promise.race([
      Promise.resolve().then(workFn),
      new Promise((_, reject) => {
        timeoutRef = setTimeout(() => {
          reject(createBudgetError(`Stage '${stage}' exceeded budget (${timeoutMs}ms)`));
        }, timeoutMs);
      }),
    ]);
    success = true;
    return result;
  } finally {
    if (timeoutRef) {
      clearTimeout(timeoutRef);
    }
    if (__stageBudgetReporter) {
      try {
        __stageBudgetReporter({
          stage,
          consumedMs: Date.now() - startedAt,
          capMs: timeoutMs,
          success,
        });
      } catch { /* non-blocking */ }
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
    toolName: 'healix_test_my_app',
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

// Optional fire-and-forget durable phase reporter. Populates
// `test_runs.current_phase + current_phase_at` so a crashed run's dashboard can
// show "last seen at tier-B auth probe 3 minutes ago".
let __durablePhaseReporter = null;
function setDurablePhaseReporter(fn) {
  __durablePhaseReporter = typeof fn === 'function' ? fn : null;
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
    if (__durablePhaseReporter) {
      try { __durablePhaseReporter(payload); } catch { /* non-blocking */ }
    }
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
  if (message.includes('openai') || message.includes('ai generation')) {
    return 'AI_GENERATION_FAILED';
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
  const normalizedMessage = normalizeErrorText(error?.message) || 'Healix run failed';

  if (errorCode === 'EXPO_DEPENDENCY_VALIDATION_FAILED') {
    return 'Expo blocked server startup due to dependency version validation. Set compatible dependency versions (for example via `npx expo install --check`) or rerun with dependency validation disabled for CI automation.';
  }

  if (errorCode === 'EXPO_NON_INTERACTIVE_PROMPT') {
    return 'Expo requested interactive input while Healix is running headless. Update start command/env to non-interactive mode and fixed port values.';
  }

  if (errorCode === 'PLAYWRIGHT_DEPENDENCY_MISSING') {
    return 'Test runtime could not be resolved while validating generated tests. Healix attempted to auto-link the test runner; install @playwright/test in the target project if this persists.';
  }

  if (errorCode === 'GENERATION_VALIDATION_FAILED') {
    if (/playwright_list_failed/i.test(normalizedMessage)) {
      return 'Generated tests failed pre-run validation. This is usually caused by missing test runner dependencies or invalid generated imports.';
    }
    return `Generated tests did not pass validation gates. ${normalizedMessage}`;
  }

  if (errorCode === 'TIME_BUDGET_EXCEEDED') {
    return 'Healix exceeded the configured time budget before tests could complete. Increase time budget or reduce generation/execution scope.';
  }

  if (errorCode === 'SERVER_START_TIMEOUT') {
    const detail = normalizedMessage ? ` Detail: ${normalizedMessage}` : '';
    return `App server did not become reachable before timeout. Verify start command, base URL, and port settings in the config form.${detail}`;
  }

  if (errorCode === 'MISSING_HEALIX_API_KEY') {
    return 'HEALIX_API_KEY is required for AI test generation. Set it in your MCP config: "HEALIX_API_KEY": "tb_your_key_here".';
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

  const envValue = String(process.env.HEALIX_VIDEO_CURSOR || '').trim().toLowerCase();
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

/**
 * Read the target project's package.json to decide whether Node will treat
 * sibling `.js` files as ESM. An ambiguous `.js` fixture using `module.exports`
 * inside a `"type": "module"` project fails at load with
 *   "The requested module './__healix-fixture' does not provide an export named 'expect'"
 * because Node parses it as ESM and synthesized named exports aren't available.
 * This helper is the source of truth we use to emit the right body.
 */
function detectProjectModuleType(projectPath) {
  if (!projectPath) return 'commonjs';
  try {
    const pkgPath = path.join(projectPath, 'package.json');
    if (!fs.existsSync(pkgPath)) return 'commonjs';
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return pkg?.type === 'module' ? 'module' : 'commonjs';
  } catch {
    return 'commonjs';
  }
}

function getCursorFixtureContent(serializedInitScript, moduleType = 'commonjs') {
  const ts = `import { test as base, expect, request } from '@playwright/test';

const test = base.extend({
  page: async ({ page }, use) => {
    await page.addInitScript(${serializedInitScript});
    await use(page);
  },
});

export { test, expect, request };
`;

  // Body must match the container's module system or Node will blow up at load.
  // ESM projects ("type":"module"): named exports via `export { ... }`.
  // CJS projects: `module.exports = { ... }`, our historical default.
  const jsEsm = `import { test as base, expect, request } from '@playwright/test';

const test = base.extend({
  page: async ({ page }, use) => {
    await page.addInitScript(${serializedInitScript});
    await use(page);
  },
});

export { test, expect, request };
`;

  const jsCjs = `const { test: base, expect, request } = require('@playwright/test');

const test = base.extend({
  page: async ({ page }, use) => {
    await page.addInitScript(${serializedInitScript});
    await use(page);
  },
});

module.exports = { test, expect, request };
`;

  const js = moduleType === 'module' ? jsEsm : jsCjs;
  return { ts, js, moduleType };
}

function ensureCursorFixtureFiles(generatedDir, projectPath = null) {
  const serializedInitScript = JSON.stringify(CURSOR_OVERLAY_INIT_SCRIPT);
  // projectPath can be omitted only in tests; in production the caller passes
  // it so we emit the correct module-system body for this project.
  const resolvedProject = projectPath || path.resolve(generatedDir, '..', '..');
  const moduleType = detectProjectModuleType(resolvedProject);
  const { ts, js } = getCursorFixtureContent(serializedInitScript, moduleType);

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

  const fixtureFiles = ensureCursorFixtureFiles(generatedDir, projectPath);
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

function resolveFailureAnalysisProvider() {
  const healixApiKey = process.env.HEALIX_API_KEY || null;
  if (healixApiKey) {
    return { provider: 'saas', apiKey: healixApiKey };
  }
  return { provider: null, reason: 'HEALIX_API_KEY is required for AI failure analysis' };
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

function ensurePlaywrightConfig(projectPath, projectInfo = {}, roles = []) {
  const candidates = [
    'playwright.config.ts',
    'playwright.config.js',
    'playwright.config.mjs',
    'playwright.config.cjs',
  ];

  // Check if config already exists
  for (const name of candidates) {
    const candidate = path.join(projectPath, name);
    if (fs.existsSync(candidate)) {
      Logger.debug('PipelineWorker', 'Playwright config already exists', { path: candidate });
      return;
    }
  }

  // Generate playwright.config.ts
  const baseURL = projectInfo.baseURL || 'http://localhost:3000';

  // Phase D: emit tier-aware projects.
  //   - tierA-public runs everything not tagged @auth or @api (the legacy default).
  //   - tierB-auth-<role> runs tests tagged @auth under the role's storageState,
  //     one project per verified role. Failed logins drop out here — the user
  //     still gets Tier A + Tier C green.
  //   - tierC-backend runs tests tagged @api (API-only, no browser session).
  // Until the generator tags tests, @grepInvert on tierA-public means all
  // current tests run once under tierA-public — backwards-compatible.
  const verifiedRoles = (roles || []).filter((r) => r && r.loginVerified && r.storageStatePath);

  // Per-tier retries live on the individual project so UI flakes don't get masked
  // as hard failures and so tierC (backend) doesn't waste budget on retryable HTTP
  // assertion bugs that are genuinely deterministic.
  const tierBProjects = verifiedRoles.map((r) => `    {
      name: 'tierB-auth-${String(r.role || 'user').replace(/[^a-zA-Z0-9_-]/g, '_')}',
      grep: /@auth|@tierB/,
      retries: 2,
      use: {
        ...devices['Desktop Chrome'],
        storageState: ${JSON.stringify(r.storageStatePath)},
      },
    }`).join(',\n');

  const projectsBlock = [
    `    {
      name: 'tierA-public',
      grepInvert: /@auth|@tierB|@api|@tierC/,
      retries: 2,
      use: { ...devices['Desktop Chrome'] },
    }`,
    tierBProjects,
    `    {
      name: 'tierC-backend',
      grep: /@api|@tierC/,
      retries: 1,
      use: { ...devices['Desktop Chrome'] },
    }`,
  ].filter(Boolean).join(',\n');

  const config = `import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/generated',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : 2,
  reporter: [
    ['list'],
    ['json', { outputFile: 'healix-reports/results/results.json' }],
    ['html', { open: 'never', outputFolder: 'healix-reports/html-report' }],
  ],
  use: {
    baseURL: '${baseURL}',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
${projectsBlock}
  ],
});
`;

  const configPath = path.join(projectPath, 'playwright.config.ts');
  fs.writeFileSync(configPath, config, 'utf-8');
  Logger.info('PipelineWorker', 'Created playwright.config.ts', {
    path: configPath,
    tierBRoles: verifiedRoles.map((r) => r.role),
  });
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

/**
 * Build a structured diagnostics blob for pipeline-level failures — the things
 * that go wrong BEFORE any test actually runs (validation, quality audit,
 * server-start, etc.). This ends up on `error.diagnostics`, flows through the
 * run report, and is rendered by the dashboard as a proper failure banner with
 * the real stderr + a preview of one of the generated specs. Without this, the
 * user sees only the generic "usually caused by missing test runner
 * dependencies" message with no way to diagnose further.
 */
function buildPipelineDiagnostics({ projectPath, stage, reason, stderr, stdout, qualityAudit } = {}) {
  const generatedDir = path.join(projectPath, 'tests', 'generated');
  let firstSpecPreview = null;
  let generatedSpecCount = 0;

  try {
    if (fs.existsSync(generatedDir)) {
      const files = fs.readdirSync(generatedDir).filter((name) => /\.spec\.(ts|js)$/i.test(name));
      generatedSpecCount = files.length;
      if (files.length > 0) {
        const firstPath = path.join(generatedDir, files[0]);
        const raw = fs.readFileSync(firstPath, 'utf-8');
        const lines = raw.split(/\r?\n/).slice(0, 80);
        firstSpecPreview = { file: files[0], lines: lines.join('\n') };
      }
    }
  } catch { /* best effort */ }

  const truncate = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);

  // Never emit an unknown stage/reason — run it through the stderr classifier
  // so downstream banners always have structured fields the Cursor agent can
  // act on.
  const { classifyPipelineErrorFromStderr } = require('./failure-triage/pipeline-error-classifier');
  const classified = classifyPipelineErrorFromStderr({
    stderr: stderr || '',
    stdout: stdout || '',
    hintedStage: stage || null,
  });

  return {
    kind: 'pipeline',
    stage: stage && stage !== 'unknown' ? stage : classified.stage,
    reason: reason || classified.reason,
    errorCode: classified.errorCode,
    userFacingMessage: classified.userFacingMessage,
    stderr: truncate(stderr, 4000),
    stdout: truncate(stdout, 4000),
    firstSpecPreview,
    generatedSpecCount,
    qualityAuditErrors: qualityAudit?.errors || null,
  };
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
  const enforcePhraseRiskGates = String(process.env.HEALIX_ENFORCE_PHRASE_RISK_GATES || '').toLowerCase() === 'true';
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
      if (/Promise\.all|HEALIX_API_STRESS_BURST|burst|p95|percentile/i.test(content)) {
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

function installMissingDependencies(projectPath, testsDir) {
  const packageJsonPath = path.join(projectPath, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    Logger.warn('PipelineWorker', 'Cannot install dependencies - package.json not found');
    return;
  }

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
  const allDeps = {
    ...(packageJson.dependencies || {}),
    ...(packageJson.devDependencies || {})
  };

  // Scan generated test files for imports
  const testFiles = fs.readdirSync(testsDir).filter(f => /\.spec\.(ts|js)$/i.test(f));
  const missingDeps = new Set();

  testFiles.forEach(file => {
    const content = fs.readFileSync(path.join(testsDir, file), 'utf-8');
    // Match: import ... from 'package' or import('package') or require('package')
    const importMatches = content.matchAll(/(?:import\s+.*?\s+from\s+['"]([^'"./][^'"]*?)['"]|import\(['"]([^'"./][^'"]*?)['"]\)|require\(['"]([^'"./][^'"]*?)['"]\))/g);
    
    for (const match of importMatches) {
      const pkg = match[1] || match[2] || match[3];
      if (pkg && !allDeps[pkg] && !pkg.startsWith('@playwright/')) {
        // Extract base package name (e.g., 'axios/lib/core' -> 'axios')
        const basePkg = pkg.split('/')[0];
        missingDeps.add(basePkg);
      }
    }
  });

  if (missingDeps.size === 0) {
    return;
  }

  const depsToInstall = Array.from(missingDeps);
  Logger.info('PipelineWorker', `Installing missing dependencies for generated tests: ${depsToInstall.join(', ')}`);

  try {
    const installCmd = `npm install --save-dev ${depsToInstall.join(' ')}`;
    execSync(installCmd, { cwd: projectPath, stdio: 'pipe' });
    Logger.info('PipelineWorker', `Successfully installed: ${depsToInstall.join(', ')}`);
  } catch (error) {
    Logger.warn('PipelineWorker', `Failed to install dependencies: ${error.message}`);
  }
}

async function maybeGenerateViaSaaS({ config, context, prdContent, testsDir, projectInfo, parsedPRD, explorationArtifact, roles }) {
  const healixApiKey = process.env.HEALIX_API_KEY;
  if (!healixApiKey) {
    const err = new Error(
      'Healix test generation requires HEALIX_API_KEY.\n' +
      'Please configure it in your MCP settings:\n' +
      '{\n' +
      '  "env": {\n' +
      '    "HEALIX_API_KEY": "tb_your_key_here",\n' +
      '    "HEALIX_DASHBOARD_URL": "https://your-healix-dashboard.com"\n' +
      '  }\n' +
      '}'
    );
    err.code = 'MISSING_HEALIX_API_KEY';
    throw err;
  }

  if (!context) {
    return { generated: 0, files: [], skipped: true, reason: 'missing_context' };
  }

  const strictAI = strictAIEnabled(config);

  const client = new WebappClient({ apiKey: healixApiKey });
  const payload = await client.generateTests({
    context,
    prd: prdContent || '',
    parsedPRD: parsedPRD || null,
    explorationArtifact: explorationArtifact || null,
    roles: roles || [],
    testType: config.testType,
    projectInfo,
    options: {
      includeSmoke: true,
      includeWorkflows: true,
      includeErrorStates: true,
      strictAIGeneration: strictAI,
      coverageProfile: config.coverageProfile || 'qa-max',
      minGeneratedTests: toFiniteNumber(config.minGeneratedTests, 50),
    },
  });

  const tests = Array.isArray(payload.tests) ? payload.tests : [];
  const used = new Set();
  const files = [];

  tests.forEach((test, index) => {
    const written = safeWriteGeneratedTest(testsDir, test, index, 'saas-generated', used);
    files.push({ ...written, type: test.type || 'generated' });
  });

  // Install any missing dependencies (e.g., axios) that generated tests require
  installMissingDependencies(config.projectPath, testsDir);

  return {
    generated: files.length,
    files,
    provider: 'saas',
    generationMeta: payload.generationMeta || null,
  };
}

async function generateWithFallbackChain({ config, context, prdContent, runBudget, projectInfo, parsedPRD, explorationArtifact, roles }) {
  const generationMeta = {
    provider: null,
    selectedGenerator: null,
    fallbackUsed: false,
    aiOnlyEnforced: true,
    templateFallbackEnabled: false,
    attempts: [],
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };

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
      error.diagnostics = buildPipelineDiagnostics({
        projectPath: config.projectPath,
        stage: 'validation',
        reason: validation.reason,
        stderr: validation.stderr,
        stdout: validation.stdout,
      });
      throw error;
    }

    const qualityAudit = auditGeneratedTestQuality({
      projectPath: config.projectPath,
      testType: config.testType,
      context,
    });

    if (!qualityAudit.valid) {
      const error = new Error(`${generator} generation failed quality audit: ${qualityAudit.errors.join(',')}`);
      error.code = 'GENERATION_VALIDATION_FAILED';
      error.validation = {
        ...validation,
        qualityAudit,
      };
      error.diagnostics = buildPipelineDiagnostics({
        projectPath: config.projectPath,
        stage: 'quality_audit',
        reason: qualityAudit.errors.join(',') || 'quality_audit_failed',
        stderr: null,
        stdout: null,
        qualityAudit,
      });
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
      generationMeta.fallbackUsed = false;
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

  const result = await tryGenerator('saas', async () => {
    const testsDir = resetGeneratedTestsDir(config.projectPath);
    const saasResult = await maybeGenerateViaSaaS({
      config,
      context,
      prdContent,
      testsDir,
      projectInfo,
      parsedPRD: parsedPRD || null,
      explorationArtifact: explorationArtifact || null,
      roles: roles || [],
    });

    if (!saasResult.generated) {
      throw new Error(`Backend test generation produced no files (${saasResult.reason || 'unknown'})`);
    }

    return saasResult;
  });

  generationMeta.finishedAt = new Date().toISOString();

  if (!result) {
    const primaryFailure = generationMeta.attempts[generationMeta.attempts.length - 1] || null;
    const errorCode = primaryFailure?.errorCode || 'GENERATION_FAILED';
    const reason = primaryFailure?.reason || null;
    const message = reason
      ? `Backend test generation failed: ${reason}`
      : 'Backend test generation failed. Ensure HEALIX_API_KEY is correctly configured and the backend is reachable.';

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

async function maybeRunFailureTriage({ config, testResults, runBudget, runId }) {
  if (config.aiFailureAnalysis === false) {
    return { analysis: null, evidenceBundles: [], verdicts: [], clusters: [] };
  }

  if (!testResults?.failures?.length) {
    return { analysis: null, evidenceBundles: [], verdicts: [], clusters: [] };
  }

  const limit = toFiniteNumber(config.aiFailureLimit || process.env.HEALIX_AI_TRIAGE_LIMIT, 8);
  const cappedFailures = testResults.failures.slice(0, limit);

  // Build evidence bundles before handing off to classifier + AI.
  let bundleResult = { bundles: [], skipped: 0 };
  try {
    const { bundleFailures } = require('./failure-triage/evidence-bundler');
    bundleResult = await bundleFailures({
      failures: cappedFailures,
      tests: testResults.tests || [],
      projectPath: config.projectPath,
      runId,
    });
  } catch (err) {
    Logger.warn('PipelineWorker', 'Evidence bundler failed — falling back to raw failures', { error: err?.message });
  }

  // Run deterministic classifier first — high-confidence verdicts skip AI
  // entirely, saving tokens and reducing the "blame the test" bias.
  let classifierResult = { verdicts: [], clusters: [], aiEligibleIndexes: [] };
  try {
    const { classifyFailures } = require('./failure-triage/classifier');
    classifierResult = classifyFailures(bundleResult.bundles);
    Logger.info('PipelineWorker', 'Classifier completed', {
      totalFailures: bundleResult.bundles.length,
      aiEligible: classifierResult.aiEligibleIndexes.length,
      clusters: classifierResult.clusters.length,
    });
  } catch (err) {
    Logger.warn('PipelineWorker', 'Classifier failed — all failures will go to AI', { error: err?.message });
    classifierResult.aiEligibleIndexes = bundleResult.bundles.map((_, i) => i);
  }

  // Annotate bundles with verdicts in-place so downstream consumers (report,
  // ingest, dashboard) have them.
  bundleResult.bundles.forEach((bundle, idx) => {
    const verdict = classifierResult.verdicts[idx];
    if (verdict) {
      bundle.classifierVerdict = verdict;
    }
  });

  const providerConfig = resolveFailureAnalysisProvider(config);
  if (providerConfig.reason) {
    Logger.info('PipelineWorker', 'Skipping AI failure triage', {
      reason: providerConfig.reason,
      provider: providerConfig.provider,
    });
    return {
      analysis: null,
      evidenceBundles: bundleResult.bundles,
      verdicts: classifierResult.verdicts,
      clusters: classifierResult.clusters,
    };
  }

  // Only send ambiguous / low-confidence failures to AI. If none remain, skip.
  const aiPayload = classifierResult.aiEligibleIndexes.length > 0
    ? classifierResult.aiEligibleIndexes.map((i) => bundleResult.bundles[i])
    : [];

  if (aiPayload.length === 0) {
    Logger.info('PipelineWorker', 'All failures resolved deterministically — skipping AI call');
    return {
      analysis: null,
      evidenceBundles: bundleResult.bundles,
      verdicts: classifierResult.verdicts,
      clusters: classifierResult.clusters,
    };
  }

  // Fallback: if bundler failed, ship raw failures so the old v1 path keeps working.
  const payload = bundleResult.bundles.length > 0 ? aiPayload : cappedFailures;

  return withStageBudget(runBudget, 'aiTriage', async () => {
    const analyzer = AIAnalyzer.create(providerConfig.provider, providerConfig.apiKey);
    const analysis = await analyzer.analyzeFailures(payload);
    return {
      analysis: Array.isArray(analysis) ? analysis : null,
      evidenceBundles: bundleResult.bundles,
      verdicts: classifierResult.verdicts,
      clusters: classifierResult.clusters,
    };
  });
}

/**
 * Main pipeline function.
 */
async function runPipeline(config, runId) {
  const statusDir = path.join(config.projectPath, 'healix-reports', '.runs', runId);
  ensureDir(statusDir);
  const telemetryReporter = new MCPTelemetryReporter();

  // Install durable-state + stage-budget reporters (fire-and-forget). Both are
  // best-effort: if the webapp is unreachable the pipeline keeps running.
  const durableClient = process.env.HEALIX_API_KEY
    ? new WebappClient({ apiKey: process.env.HEALIX_API_KEY })
    : null;
  if (durableClient) {
    setDurablePhaseReporter((payload) => {
      durableClient.reportPhase({
        runId,
        phase: payload.phase,
        metadata: { message: payload.message, errorCode: payload.errorCode || null },
      }).catch(() => undefined);
    });
    setStageBudgetReporter(({ stage, consumedMs, capMs, success }) => {
      durableClient.reportPhase({
        runId,
        phase: `stage:${stage}`,
        stageBudget: { stage, consumedMs, capMs },
        metadata: { success },
      }).catch(() => undefined);
    });
  } else {
    setDurablePhaseReporter(null);
    setStageBudgetReporter(null);
  }

  // Kill any leftover Healix-started dev server from a previous run.
  // We only kill what Healix wrote into this PID file — nothing else.
  const healixReportsDir = path.join(config.projectPath, 'healix-reports');
  const serverPidFile = path.join(healixReportsDir, HEALIX_SERVER_PID_FILENAME);
  killOrphanedHealixProcess(serverPidFile, 'dev-server');

  const runBudget = createRunBudget(config);
  let generationMeta = null;
  let fallbackUsed = false;
  let generationQuality = null;
  let playwright = null; // declared here so catch can call stopServer() on budget timeout
  let requirementsCoverage = null;
  let phaseResults = null;
  const aiOnlyEnforced = strictAIEnabled(config);

  updateStatus(statusDir, 'started', {
    runId,
    message: 'Healix started',
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
          // Clean up Next.js dev lock file — the existing server holds it and
          // SIGKILL won't release it, so the new instance would fail to start.
          const nextDevLock = path.join(config.projectPath, '.next', 'dev', 'lock');
          try {
            if (fs.existsSync(nextDevLock)) {
              fs.unlinkSync(nextDevLock);
              Logger.info('PipelineWorker', 'Removed stale Next.js dev lock file', { lockFile: nextDevLock });
            }
          } catch {
            // non-fatal — best effort
          }
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
    if (config.jira?.enabled && JiraClient) {
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
    } else if (config.jira?.enabled && !JiraClient) {
      Logger.warn('PipelineWorker', 'Jira integration requested but jira/client module not available');
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
    // 3. Read PRD file(s) if specified
    // -------------------------------------------------------
    let prdContent = null;
    const prdContents = [];
    const prdErrors = [];

    if (config.prdFile) {
      try {
        prdContent = fs.readFileSync(config.prdFile, 'utf-8');
        prdContents.push(prdContent);
        Logger.info('PipelineWorker', 'Read PRD file', { path: config.prdFile, length: prdContent.length });
      } catch (error) {
        Logger.error('PipelineWorker', 'Could not read PRD file', { path: config.prdFile, reason: error.message });
        prdErrors.push({ path: config.prdFile, reason: error.message });
      }
    }

    if (Array.isArray(config.prdFiles) && config.prdFiles.length > 0) {
      for (const prdFilePath of config.prdFiles) {
        if (prdFilePath === config.prdFile) continue;
        try {
          const content = fs.readFileSync(prdFilePath, 'utf-8');
          prdContents.push(content);
          Logger.info('PipelineWorker', 'Read additional PRD file', { path: prdFilePath, length: content.length });
        } catch (error) {
          Logger.error('PipelineWorker', 'Could not read PRD file', { path: prdFilePath, reason: error.message });
          prdErrors.push({ path: prdFilePath, reason: error.message });
        }
      }
    }

    if (prdErrors.length > 0) {
      // Surface PRD-read failures as a run-level warning event instead of silently dropping them.
      updateStatus(statusDir, 'warning', {
        runId,
        message: `Some PRD file(s) could not be read and were skipped (${prdErrors.length}).`,
        prdErrors,
      }, telemetryReporter);
      process.stderr.write(`[HEALIX] PRD read failures for run ${runId}: ${JSON.stringify(prdErrors)}\n`);
    }

    const combinedPrdContent = prdContents.length > 0 ? prdContents.join('\n\n---\n\n') : null;

    // -------------------------------------------------------
    // 3a. Parse PRD into structured acceptance criteria (Phase B).
    //
    // Three paths converge here:
    //   (1) User uploaded a PRD file      → config.prdFile / config.prdFiles → combinedPrdContent
    //   (2) Cursor agent synthesised a PRD → submitted as prd text → persisted to disk upstream → same
    //   (3) No PRD at all                  → combinedPrdContent === null → skip entirely, generator
    //                                        falls back to context + exploration artifacts alone.
    //
    // If the /api/parse-prd call fails we don't kill the run — the raw PRD string is still
    // passed down and the generator degrades to free-form PRD mode.
    // -------------------------------------------------------
    let parsedPRD = null;
    if (combinedPrdContent && config.generateTests) {
      updateStatus(statusDir, 'parsing_prd', {
        runId,
        message: 'Parsing PRD into structured acceptance criteria...',
      }, telemetryReporter);
      try {
        const client = new WebappClient({ apiKey: process.env.HEALIX_API_KEY });
        const parseResponse = await withStageBudget(runBudget, 'prdParse', () =>
          client.parsePRD({ prdContent: combinedPrdContent })
        );
        parsedPRD = parseResponse?.parsedPRD || null;
        if (parsedPRD) {
          try {
            fs.writeFileSync(
              path.join(statusDir, 'parsed-prd.json'),
              JSON.stringify(parsedPRD, null, 2),
              'utf-8'
            );
          } catch (writeErr) {
            Logger.warn('PipelineWorker', 'Failed to cache parsed-prd.json', { reason: writeErr.message });
          }
          const featureCount = Array.isArray(parsedPRD.features) ? parsedPRD.features.length : 0;
          const acCount = Array.isArray(parsedPRD.features)
            ? parsedPRD.features.reduce((sum, f) =>
                sum + (Array.isArray(f.userStories)
                  ? f.userStories.reduce((s, st) =>
                      s + (Array.isArray(st.acceptanceCriteria) ? st.acceptanceCriteria.length : 0), 0)
                  : 0), 0)
            : 0;
          Logger.info('PipelineWorker', 'PRD parsed', { featureCount, acCount, cached: !!parseResponse?.cached });
          updateStatus(statusDir, 'prd_parsed', {
            runId,
            message: `Parsed PRD: ${featureCount} feature(s), ${acCount} acceptance criteria`,
            featureCount,
            acCount,
            cached: !!parseResponse?.cached,
          }, telemetryReporter);
        }
      } catch (parseErr) {
        Logger.warn('PipelineWorker', 'PRD parse failed — falling back to raw PRD text', {
          reason: parseErr.message,
          code: parseErr.code,
        });
        updateStatus(statusDir, 'warning', {
          runId,
          message: `PRD parsing failed — continuing with raw PRD text. (${parseErr.message})`,
        }, telemetryReporter);
        // parsedPRD stays null; generator will fall back to raw prd.
      }
    }

    const projectInfo = {
      name: config.projectName,
      framework: codebaseContext?.projectStructure?.framework || 'Unknown',
      baseURL: config.baseURL,
      startCommand: config.startCommand,
      testCredentials: config.testCredentials,
      services: Array.isArray(config.services) ? config.services : undefined,
      apiOnly: !!config.apiOnly,
    };

    // -------------------------------------------------------
    // 3b. Browser-use exploration (Phase C). Opt-in via config.enableExploration
    // or HEALIX_ENABLE_EXPLORATION=1. Degrades gracefully: if browser-use isn't
    // installed, or exploration fails, we continue with an empty artifact and
    // the generator falls back to PRD + static context alone.
    // -------------------------------------------------------
    let explorationArtifact = { ...EMPTY_ARTIFACT };
    // Exploration is ON by default now that we have a Playwright heuristic
    // fallback — the user can still opt out via config.skipExploration or
    // HEALIX_SKIP_EXPLORATION=1 if, e.g., the dev server doesn't come up.
    const explorationSkipped =
      config.skipExploration === true
      || process.env.HEALIX_SKIP_EXPLORATION === '1';
    if (!explorationSkipped) {
      updateStatus(statusDir, 'exploring', {
        runId,
        message: 'Exploring app with browser-use...',
      }, telemetryReporter);
      try {
        const result = await runExplorationPhase({
          statusDir,
          baseURL: config.baseURL,
          credentials: config.testCredentials,
          skipExploration: explorationSkipped,
          totalTimeoutMs: 120_000,
        });
        explorationArtifact = result.artifact;
        updateStatus(statusDir, 'explored', {
          runId,
          message: `Exploration ${result.source}${result.reason ? ` (${result.reason})` : ''}`,
          source: result.source,
          reason: result.reason || null,
          routeCount: (result.artifact?.routes || []).length,
          keyFlowCount: (result.artifact?.keyFlows || []).length,
        }, telemetryReporter);
      } catch (explErr) {
        Logger.warn('PipelineWorker', 'Exploration phase failed (best-effort)', { reason: explErr.message });
      }
    }

    // -------------------------------------------------------
    // 3c. Credential injection (Phase D). For each testCredentials entry,
    // drive a headless login, persist storageState to .healix/auth-state-<role>.json,
    // and expose the role list to the generator so Tier B tests can run under
    // the right role. Graceful degradation: if login fails for a role, that
    // role is excluded from Tier B (but Tier A + Tier C continue).
    // -------------------------------------------------------
    let roles = [];
    if (Array.isArray(config.testCredentials) && config.testCredentials.length > 0) {
      updateStatus(statusDir, 'auth_injecting', {
        runId,
        message: `Verifying credentials for ${config.testCredentials.length} role(s)...`,
      }, telemetryReporter);
      try {
        roles = await injectCredentials({
          projectPath: config.projectPath,
          baseURL: config.baseURL,
          credentials: config.testCredentials,
          authFlow: explorationArtifact?.authFlow || null,
        });
        const verifiedCount = roles.filter((r) => r.loginVerified).length;
        updateStatus(statusDir, 'auth_injected', {
          runId,
          message: `${verifiedCount}/${roles.length} role login(s) verified`,
          roles: roles.map((r) => ({ role: r.role, loginVerified: !!r.loginVerified, reason: r.reason || null })),
        }, telemetryReporter);
      } catch (credErr) {
        Logger.warn('PipelineWorker', 'Credential injection failed (best-effort)', { reason: credErr.message });
        roles = [];
      }
    }

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
        prdContent: combinedPrdContent,
        parsedPRD,
        explorationArtifact,
        roles,
        runBudget,
        projectInfo,
      });

      generationMeta = generationResult.generationMeta;
      fallbackUsed = !!generationMeta?.fallbackUsed;

      // Ensure playwright.config.ts exists after test generation
      ensurePlaywrightConfig(config.projectPath, projectInfo, roles);

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
        prdContent: combinedPrdContent,
        prdContents,
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

      if (telemetryReporter && telemetryReporter.isEnabled()) {
        const generatedTestFiles = listGeneratedTestFiles(config.projectPath);

        for (const filePath of generatedTestFiles) {
          telemetryReporter.emitBackground({
            toolName: 'healix_test_my_app',
            eventType: 'test_file_generated',
            runId,
            phase: 'generating',
            status: 'info',
            success: true,
            message: path.basename(filePath),
            metadata: {
              project: config.projectName,
              file: path.basename(filePath),
              fileCount: generatedTestFiles.length,
            },
          });
        }

        telemetryReporter.emitBackground({
          toolName: 'healix_test_my_app',
          eventType: 'tests_generated',
          runId,
          phase: 'generating',
          status: 'info',
          success: true,
          message: `Generated ${generationQuality.totalTests} tests across ${generatedTestFiles.length} file(s)`,
          metadata: {
            project: config.projectName,
            files: generatedTestFiles.map(f => path.basename(f)),
            fileCount: generatedTestFiles.length,
            totalTests: generationQuality.totalTests,
            categories: generationQuality.categories,
          },
        });
      }

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
      message: 'Running tests...',
      generationMeta,
      fallbackUsed,
      aiOnlyEnforced,
      generationQuality,
      requirementsCoverage,
    }, telemetryReporter);

    const executionTimeout = Math.max(1000, Math.min(getBudgetRemainingMs(runBudget), runBudget.stageCaps.execution));

    // Throttled real-time test progress: buffer results and flush every 1.5s
    // so each completed test emits a telemetry event without flooding the API.
    const pendingProgress = [];
    let progressFlushTimer = null;
    const flushProgress = () => {
      progressFlushTimer = null;
      const batch = pendingProgress.splice(0);
      if (!batch.length || !telemetryReporter || !telemetryReporter.isEnabled()) return;
      for (const t of batch) {
        telemetryReporter.emitBackground({
          toolName: 'healix_test_my_app',
          eventType: 'test_result',
          runId,
          phase: 'running',
          status: t.status === 'failed' ? 'error' : 'info',
          success: t.status !== 'failed',
          message: t.name,
          metadata: { test: { n: t.name, su: '', f: '', s: t.status, d: t.durationMs } },
        });
      }
    };
    const onTestProgress = (t) => {
      pendingProgress.push(t);
      if (!progressFlushTimer) {
        progressFlushTimer = setTimeout(flushProgress, 1500);
      }
    };

    // Monorepo multi-service startup: if the detector found both a frontend and
    // a backend, start the backend here BEFORE Playwright launches the primary
    // (frontend) server. Secondary service PIDs are tracked in
    // healix-reports/.healix-services.pids and cleaned up on error or on the
    // next pipeline run's boot.
    if (Array.isArray(config.services) && config.services.length > 1) {
      try {
        const started = await startSecondaryServices({
          projectPath: config.projectPath,
          services: config.services,
          waitMs: toFiniteNumber(config.serverStartTimeoutMs, 60_000),
        });
        if (started.length > 0) {
          updateStatus(statusDir, 'secondary_services_started', {
            runId,
            message: `Started ${started.length} secondary service(s)`,
            services: started.map((s) => ({
              role: s.service.role,
              port: s.service.port,
              ready: s.ready,
            })),
          }, telemetryReporter);
        }
      } catch (err) {
        Logger.warn('PipelineWorker', 'Failed to start secondary services — continuing with primary only', { reason: err.message });
      }
    }

    playwright = new PlaywrightIntegration({
      ...config,
      timeout: executionTimeout,
      serverPidFile,
      onTestProgress: telemetryReporter && telemetryReporter.isEnabled() ? onTestProgress : undefined,
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

    let tierResults = null;
    try {
      const tierMerger = new ResultsMerger({ projectPath: config.projectPath });
      tierResults = tierMerger.computeTierResults(testResults.tests || []);
      testResults.tierResults = tierResults;
    } catch (tierErr) {
      Logger.warn('PipelineWorker', 'Failed to compute tier results', { reason: tierErr.message });
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

    if (telemetryReporter && telemetryReporter.isEnabled() && Array.isArray(testResults.tests) && testResults.tests.length > 0) {
      const simplifiedTests = testResults.tests.slice(0, 300).map(t => ({
        n: String(t.title || t.name || ''),
        su: String(t.suite || ''),
        f: String(t.file || ''),
        s: String(t.status || 'unknown'),
        d: Number(t.duration || 0),
      }));

      for (const t of simplifiedTests) {
        telemetryReporter.emitBackground({
          toolName: 'healix_test_my_app',
          eventType: 'test_result',
          runId,
          phase: 'tests_complete',
          status: t.s === 'failed' ? 'error' : 'info',
          success: t.s !== 'failed',
          message: t.n,
          metadata: {
            project: config.projectName,
            test: t,
            total: testResults.total,
            passed: testResults.passed,
            failed: testResults.failed,
            skipped: testResults.skipped,
          },
        });
      }

      telemetryReporter.emitBackground({
        toolName: 'healix_test_my_app',
        eventType: 'test_results',
        runId,
        phase: 'tests_complete',
        status: 'info',
        success: true,
        message: `Test results: ${testResults.passed}/${testResults.total} passed`,
        metadata: {
          project: config.projectName,
          tests: simplifiedTests,
          total: testResults.total,
          passed: testResults.passed,
          failed: testResults.failed,
          skipped: testResults.skipped,
        },
      });
    }

    // -------------------------------------------------------
    // 6. Optional AI failure triage
    // -------------------------------------------------------
    let aiAnalysis = null;
    let evidenceBundles = [];
    let classifierVerdicts = [];
    let failureClusters = [];
    try {
      const triage = await maybeRunFailureTriage({
        config,
        testResults,
        runBudget,
        runId,
      });
      aiAnalysis = triage?.analysis ?? null;
      evidenceBundles = triage?.evidenceBundles ?? [];
      classifierVerdicts = triage?.verdicts ?? [];
      failureClusters = triage?.clusters ?? [];
    } catch (triageError) {
      Logger.warn('PipelineWorker', 'AI failure triage failed', { reason: triageError.message });
      aiAnalysis = null;
      evidenceBundles = [];
      classifierVerdicts = [];
      failureClusters = [];
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
      const healixApiKey = process.env.HEALIX_API_KEY;
      const healixDashboardUrl = process.env.HEALIX_DASHBOARD_URL || 'http://localhost:3000';

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
        tierResults,
        fallbackUsed,
        failures: evidenceBundles,
        flakyCount: testResults.flaky || 0,
        classifierVerdicts,
        failureClusters,
        api_key: healixApiKey,
        dashboard_url: healixDashboardUrl,
      });
    });

    // Use the actual run ID returned from the server (if available)
    const actualRunId = report.actualRunId || runId;
    Logger.info('PipelineWorker', `Using run ID for artifact upload: ${actualRunId}`);

    // -------------------------------------------------------
    // 7. Upload artifacts for failed tests to Supabase Storage
    // -------------------------------------------------------
    // NOTE: This runs AFTER report generation so artifacts are copied to healix-reports/artifacts
    let artifactUploadResult = null;
    if (testResults.failed > 0) {
      try {
        updateStatus(statusDir, 'uploading_artifacts', {
          runId,
          message: 'Uploading failure artifacts to storage...',
          generationMeta,
          fallbackUsed,
          aiOnlyEnforced,
          generationQuality,
          requirementsCoverage,
          phaseResults,
        }, telemetryReporter);

        updateStatus(statusDir, 'uploading_artifacts', {
          runId,
          message: 'Uploading test artifacts to storage...',
          generationMeta,
          fallbackUsed,
          aiOnlyEnforced,
          generationQuality,
          requirementsCoverage,
          phaseResults,
        }, telemetryReporter);

        const artifactUploader = new ArtifactUploader({
          projectPath: config.projectPath,
          dashboardUrl: process.env.HEALIX_DASHBOARD_URL,
          apiKey: process.env.HEALIX_API_KEY,
        });

        artifactUploadResult = await artifactUploader.processAndUpload(actualRunId, testResults);
        
        if (artifactUploadResult.success) {
          const uploadMsg = artifactUploadResult.failed 
            ? `Uploaded ${artifactUploadResult.uploaded || 0} artifacts (${artifactUploadResult.failed} failed)`
            : `Uploaded ${artifactUploadResult.uploaded || 0} artifacts to storage`;
          
          Logger.info('PipelineWorker', uploadMsg);
          updateStatus(statusDir, 'artifacts_uploaded', {
            runId,
            message: uploadMsg,
            artifactsUploaded: artifactUploadResult.uploaded || 0,
            artifactsFailed: artifactUploadResult.failed || 0,
            generationMeta,
            fallbackUsed,
            aiOnlyEnforced,
            generationQuality,
            requirementsCoverage,
            phaseResults,
          }, telemetryReporter);
        } else {
          Logger.warn('PipelineWorker', 'Artifact upload failed', { reason: artifactUploadResult.reason });
          updateStatus(statusDir, 'artifacts_upload_failed', {
            runId,
            message: `Artifact upload failed: ${artifactUploadResult.reason || 'unknown'}`,
            reason: artifactUploadResult.reason,
            error: artifactUploadResult.error,
            generationMeta,
            fallbackUsed,
            aiOnlyEnforced,
            generationQuality,
            requirementsCoverage,
            phaseResults,
          }, telemetryReporter);
        }
      } catch (uploadError) {
        Logger.warn('PipelineWorker', 'Artifact upload error', { error: uploadError.message });
        updateStatus(statusDir, 'artifacts_upload_error', {
          runId,
          message: `Artifact upload error: ${uploadError.message}`,
          error: uploadError.message,
          generationMeta,
          fallbackUsed,
          aiOnlyEnforced,
          generationQuality,
          requirementsCoverage,
          phaseResults,
        }, telemetryReporter);
      }
    } else {
      Logger.info('PipelineWorker', 'No failed tests - skipping artifact upload');
    }

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
      artifactUploadResult: artifactUploadResult ? {
        success: artifactUploadResult.success,
        uploaded: artifactUploadResult.uploaded || 0,
        reason: artifactUploadResult.reason,
      } : null,
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

    // Stop any secondary (monorepo) services we started — primary server is
    // handled by playwright.runTests()'s own teardown.
    try { stopSecondaryServices(config.projectPath); } catch { /* ignore */ }
  } catch (error) {
    // Ensure the dev server is killed immediately even when the budget timeout
    // races ahead of playwright.runTests()'s own finally{stopServer()} block.
    if (playwright) {
      try { playwright.stopServer(); } catch { /* ignore */ }
    }
    try { stopSecondaryServices(config.projectPath); } catch { /* ignore */ }

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
        testName: `[HEALIX_ERROR:${errorCode}] Healix run failed before/while execution`,
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

      const healixApiKey = process.env.HEALIX_API_KEY;
      const healixDashboardUrl = process.env.HEALIX_DASHBOARD_URL || 'http://localhost:3000';

      // Fall back to stderr-pattern classification when the upstream thrower
      // didn't attach diagnostics (e.g. PlaywrightIntegration.runTests throws
      // a plain Error on exit-code !=0 with no diagnostics). Without this the
      // banner used to render `stage: unknown / reason: unknown_reason` — see
      // pm-app regression 2026-04-18.
      const { classifyPipelineErrorFromStderr } = require('./failure-triage/pipeline-error-classifier');
      const stderrForClassifier = error.diagnostics?.stderr || error.message || '';
      const classification = classifyPipelineErrorFromStderr({
        stderr: stderrForClassifier,
        stdout: error.diagnostics?.stdout || '',
        hintedStage: error.diagnostics?.stage
          || (errorCode === 'GENERATION_VALIDATION_FAILED' ? 'validation' : null),
      });

      const pipelineError = {
        errorCode,
        stage: error.diagnostics?.stage && error.diagnostics.stage !== 'unknown'
          ? error.diagnostics.stage
          : classification.stage,
        reason: error.diagnostics?.reason || classification.reason,
        userFacingMessage: userFacingError || classification.userFacingMessage,
        technicalMessage: technicalError,
        stderr: error.diagnostics?.stderr || (typeof error.message === 'string' ? error.message.slice(0, 4000) : null),
        stdout: error.diagnostics?.stdout || null,
        firstSpecPreview: error.diagnostics?.firstSpecPreview || null,
        generatedSpecCount: error.diagnostics?.generatedSpecCount || 0,
        qualityAuditErrors: error.diagnostics?.qualityAuditErrors || null,
      };
      // Mark the synthetic row so the dashboard can hide it when the banner
      // carries full diagnostics — otherwise stats strip double-counts it as
      // a failed test (Total 1 / Failed 1 with zero real runs).
      syntheticFailure.isPipelineSynthetic = true;
      syntheticTestResults.tests[0].isPipelineSynthetic = true;

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
        pipelineError,
        api_key: healixApiKey,
        dashboard_url: healixDashboardUrl,
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
  detectProjectModuleType,
  getCursorFixtureContent,
  ensureCursorFixtureFiles,
};
