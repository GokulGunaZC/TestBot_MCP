'use strict';

/**
 * Healix webapp client — the single entry point for every AI/billing call the
 * MCP server makes. All requests authenticate with `HEALIX_API_KEY` via the
 * `x-api-key` header. OpenAI keys never touch the user's machine.
 *
 * Endpoints:
 *   POST /api/generate-tests     — AC-traced test generation (bills tokens)
 *   POST /api/parse-prd          — Structured AC extraction  (bills tokens, cached by PRD hash)
 *   POST /api/exploration/plan   — Rank browser-use flows, suggest AC
 *   POST /api/analyze-failures   — AI failure triage
 *   POST /api/test-runs/ingest   — Upload run summary + artifacts manifest
 *   POST /api/mcp-auth/validate  — API-key validation
 */

const Logger = require('./logger');

// Heavy AI endpoints (generate-tests, parse-prd, exploration/plan, analyze-failures)
// can legitimately take 10-20 minutes for non-trivial projects — gpt-5.4 runs on
// the Responses API with `reasoning: { effort: "high" }`, which trades latency
// for quality. Default is intentionally long; lightweight endpoints pass their
// own short timeoutMs explicitly.
const ENV_OVERRIDE = Number(process.env.HEALIX_WEBAPP_TIMEOUT_MS);
const DEFAULT_TIMEOUT_MS = Number.isFinite(ENV_OVERRIDE) && ENV_OVERRIDE > 0
  ? ENV_OVERRIDE
  : 1_200_000; // 20 min

// Per-endpoint ceilings — each call inherits these unless the caller passes an
// explicit override. Kept distinct from DEFAULT_TIMEOUT_MS so tightening the
// validate / phase endpoints (which MUST stay fast) doesn't accidentally
// tighten generation.
const ENDPOINT_TIMEOUTS_MS = {
  validate: 6_000,
  phase: 4_000,
  ingest: 60_000,
  analyze: 600_000,          // 10 min — gpt-5.4 high-reasoning triage
  planExploration: 600_000,  // 10 min
  parsePRD: 600_000,         // 10 min
  generateTests: 1_200_000,  // 20 min — parallel gpt-5.4 code-gen
};

function getFetch() {
  return global.fetch || require('node-fetch');
}

class WebappClient {
  constructor({ apiKey, dashboardUrl, timeoutMs } = {}) {
    this.apiKey = apiKey || process.env.HEALIX_API_KEY || null;
    this.dashboardUrl = (dashboardUrl || process.env.HEALIX_DASHBOARD_URL || 'http://localhost:3000').replace(/\/+$/, '');
    this.timeoutMs = Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS;
  }

  _assertKey(endpoint) {
    if (!this.apiKey) {
      const err = new Error(`HEALIX_API_KEY is required for ${endpoint}. Set it in your MCP config's "env" block.`);
      err.code = 'MISSING_HEALIX_API_KEY';
      throw err;
    }
  }

  async _post(path, body, { timeoutMs } = {}) {
    const url = `${this.dashboardUrl}${path}`;
    const fetchFn = getFetch();
    const controller = new AbortController();
    const limit = Number.isFinite(timeoutMs) ? timeoutMs : this.timeoutMs;
    const timer = setTimeout(() => controller.abort(), limit);

    let response;
    try {
      response = await fetchFn(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey || '',
        },
        body: JSON.stringify(body || {}),
        signal: controller.signal,
      });
    } catch (networkErr) {
      clearTimeout(timer);
      if (networkErr.name === 'AbortError') {
        const err = new Error(`Healix webapp call timed out after ${limit}ms: ${path}`);
        err.code = 'WEBAPP_TIMEOUT';
        throw err;
      }
      const err = new Error(`Cannot reach Healix webapp at ${url}: ${networkErr.message}`);
      err.code = 'WEBAPP_UNREACHABLE';
      throw err;
    }
    clearTimeout(timer);

    let payload = null;
    const rawText = await response.text().catch(() => '');
    try { payload = rawText ? JSON.parse(rawText) : null; } catch { payload = null; }

    if (!response.ok) {
      const detail = payload?.error || rawText.slice(0, 400) || `HTTP ${response.status}`;
      const err = new Error(`Healix webapp ${path} failed (${response.status}): ${detail}`);
      err.code =
        response.status === 401 ? 'INVALID_API_KEY' :
        response.status === 402 ? 'INSUFFICIENT_CREDITS' :
        response.status === 429 ? 'RATE_LIMITED' :
        response.status >= 500 ? 'WEBAPP_SERVER_ERROR' : 'WEBAPP_ERROR';
      err.status = response.status;
      err.payload = payload;
      throw err;
    }

    return payload;
  }

  async validateKey() {
    this._assertKey('/api/mcp-auth/validate');
    return this._post(
      '/api/mcp-auth/validate',
      { api_key: this.apiKey },
      { timeoutMs: ENDPOINT_TIMEOUTS_MS.validate }
    );
  }

  async generateTests({ context, prd, parsedPRD, explorationArtifact, roles, testType, projectInfo, options }) {
    this._assertKey('/api/generate-tests');
    return this._post(
      '/api/generate-tests',
      {
        api_key: this.apiKey,
        context,
        prd: prd || '',
        parsedPRD: parsedPRD || null,
        explorationArtifact: explorationArtifact || null,
        roles: roles || [],
        testType,
        projectInfo,
        options,
      },
      { timeoutMs: ENDPOINT_TIMEOUTS_MS.generateTests }
    );
  }

  async parsePRD({ prdContent, prdHash }) {
    this._assertKey('/api/parse-prd');
    return this._post(
      '/api/parse-prd',
      {
        api_key: this.apiKey,
        prd: prdContent,
        prdHash: prdHash || null,
      },
      { timeoutMs: ENDPOINT_TIMEOUTS_MS.parsePRD }
    );
  }

  async planExploration({ explorationArtifact, parsedPRD }) {
    this._assertKey('/api/exploration/plan');
    return this._post(
      '/api/exploration/plan',
      {
        api_key: this.apiKey,
        explorationArtifact,
        parsedPRD: parsedPRD || null,
      },
      { timeoutMs: ENDPOINT_TIMEOUTS_MS.planExploration }
    );
  }

  async analyzeFailures(failures) {
    this._assertKey('/api/analyze-failures');
    if (!Array.isArray(failures) || failures.length === 0) return { analyses: [] };
    return this._post(
      '/api/analyze-failures',
      {
        api_key: this.apiKey,
        failures: failures.slice(0, 8),
      },
      { timeoutMs: ENDPOINT_TIMEOUTS_MS.analyze }
    );
  }

  async ingestTestRun(runPayload) {
    this._assertKey('/api/test-runs/ingest');
    return this._post('/api/test-runs/ingest', runPayload, {
      timeoutMs: ENDPOINT_TIMEOUTS_MS.ingest,
    });
  }

  /**
   * Fire-and-forget durable phase write. If the webapp is unreachable, the call
   * fails silently — the pipeline must never block on this best-effort state.
   * Used to populate `test_runs.current_phase + current_phase_at` so a crashed
   * run's dashboard can show "last seen at tier-B auth probe 3 minutes ago".
   */
  async reportPhase({ runId, testRunId, phase, stageBudget, metadata } = {}) {
    if (!this.apiKey || !phase) return null;
    try {
      return await this._post(
        '/api/test-runs/phase',
        {
          api_key: this.apiKey,
          run_id: runId || null,
          test_run_id: testRunId || null,
          phase,
          stage_budget: stageBudget || null,
          metadata: metadata || null,
        },
        { timeoutMs: ENDPOINT_TIMEOUTS_MS.phase }
      );
    } catch (err) {
      Logger.warn('WebappClient', 'reportPhase failed (non-blocking)', {
        phase,
        code: err?.code,
        message: err?.message,
      });
      return null;
    }
  }
}

module.exports = WebappClient;
