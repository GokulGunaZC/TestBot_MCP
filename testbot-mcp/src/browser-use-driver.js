'use strict';

/**
 * Thin Node wrapper around the Python browser-use runner. The contract:
 *
 *   const result = await driveExploration({ targetUrl, credentials, totalTimeoutMs });
 *   // result === { available: boolean, artifact?: ExplorationArtifact, reason?: string }
 *
 * Behaviour:
 *   - Resolve a Python interpreter (python3 / python / py).
 *   - Invoke `scripts/browser_use_runner.py`. The runner itself handles the
 *     "is browser-use installed" decision. If the runner exits 2 we mark the
 *     exploration as unavailable and return `reason` — the caller (pipeline
 *     worker) degrades gracefully to Playwright-only exploration.
 *   - Never throw. Every failure mode returns `{ available: false, reason }`.
 *
 * We intentionally do NOT auto-install browser-use from JS. Auto-install has to
 * happen through the config UI with the user's explicit consent (so that e.g.
 * corp-managed machines without `pipx` can opt out) — see
 * `config-ui-launcher.js` for the consent prompt.
 */

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const Logger = require('./logger');

const RUNNER_SCRIPT = path.join(__dirname, '..', 'scripts', 'browser_use_runner.py');
const DEFAULT_TIMEOUT_MS = 180_000;

function resolvePython() {
  const candidates = process.platform === 'win32'
    ? ['py', 'python', 'python3']
    : ['python3', 'python'];
  for (const cmd of candidates) {
    try {
      const res = spawnSync(cmd, ['--version'], { stdio: 'ignore' });
      if (res.status === 0) return cmd;
    } catch { /* try next */ }
  }
  return null;
}

function isBrowserUseInstalled(pythonCmd) {
  try {
    const res = spawnSync(pythonCmd, ['-c', 'import browser_use; print("ok")'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return res.status === 0;
  } catch {
    return false;
  }
}

/**
 * Drive the runner. `targetUrl` must be an http(s) URL.
 * Returns the raw ExplorationArtifact when the runner succeeds.
 */
function driveExploration({
  targetUrl,
  credentials,
  allCredentials,
  totalTimeoutMs = DEFAULT_TIMEOUT_MS,
  onHeartbeat,
} = {}) {
  return new Promise((resolve) => {
    if (!targetUrl) {
      resolve({ available: false, reason: 'No targetUrl provided to browser-use driver' });
      return;
    }
    if (!fs.existsSync(RUNNER_SCRIPT)) {
      resolve({ available: false, reason: `Runner script missing at ${RUNNER_SCRIPT}` });
      return;
    }

    const pythonCmd = resolvePython();
    if (!pythonCmd) {
      resolve({ available: false, reason: 'No Python interpreter on PATH' });
      return;
    }

    if (!isBrowserUseInstalled(pythonCmd)) {
      resolve({
        available: false,
        reason: 'browser-use package not installed',
        pythonCmd,
      });
      return;
    }

    // Derive the LLM proxy URL from the dashboard URL so the Python runner
    // can route LLM calls through the Healix webapp — no local OPENAI_API_KEY
    // needed on the user's machine.
    const dashboardUrl = (process.env.HEALIX_DASHBOARD_URL || 'http://localhost:3000').replace(/\/+$/, '');
    const llmProxyUrl = `${dashboardUrl}/api/llm-proxy`;

    // Build a comma-separated role list so the Python runner can inform the
    // LLM that multiple roles exist (admin, user, super_admin, etc.).
    const allRoles = Array.isArray(allCredentials) && allCredentials.length > 0
      ? allCredentials.map((c) => c.role || 'user').join(', ')
      : (credentials?.role || '');

    const env = {
      ...process.env,
      HEALIX_TARGET_URL: targetUrl,
      HEALIX_LOGIN_USERNAME: credentials?.username || '',
      HEALIX_LOGIN_PASSWORD: credentials?.password || '',
      HEALIX_TOTAL_TIMEOUT_S: String(Math.max(10, Math.round(totalTimeoutMs / 1000))),
      HEALIX_ALL_ROLES: allRoles,
      // Proxy-mode credentials — forwarded to browser_use_runner.py so it
      // authenticates LLM calls via the Healix webapp rather than a local key.
      HEALIX_LLM_PROXY_URL: llmProxyUrl,
      // HEALIX_API_KEY is already in process.env; include it explicitly so it
      // is never accidentally shadowed by a dotenv override.
      HEALIX_API_KEY: process.env.HEALIX_API_KEY || '',
    };

    let settled = false;
    let artifact = null;
    let errorReason = null;
    let buffer = '';

    const proc = spawn(pythonCmd, [RUNNER_SCRIPT], { env, stdio: ['ignore', 'pipe', 'pipe'] });

    const killTimer = setTimeout(() => {
      if (settled) return;
      errorReason = `Exploration timed out after ${totalTimeoutMs}ms`;
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    }, totalTimeoutMs);

    const settle = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve(payload);
    };

    proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf-8');
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event?.type === 'heartbeat' && typeof onHeartbeat === 'function') {
          try { onHeartbeat(event); } catch { /* ignore */ }
        }
        if (event?.type === 'artifact' && event.data) {
          artifact = event.data;
        }
        if (event?.type === 'error' && event.reason) {
          errorReason = event.reason;
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      Logger.warn('BrowserUseDriver', 'runner stderr', { line: chunk.toString('utf-8').slice(0, 400) });
    });

    proc.on('close', (code) => {
      if (artifact) {
        settle({ available: true, artifact });
        return;
      }
      const reason = errorReason
        || (code === 2 ? 'browser-use not available' : `runner exited with code ${code}`);
      settle({ available: false, reason });
    });

    proc.on('error', (err) => {
      settle({ available: false, reason: `Failed to spawn runner: ${err.message}` });
    });
  });
}

module.exports = {
  driveExploration,
  resolvePython,
  isBrowserUseInstalled,
  RUNNER_SCRIPT,
};
