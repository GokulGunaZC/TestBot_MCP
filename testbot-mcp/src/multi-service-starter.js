'use strict';

/**
 * Multi-service starter — for monorepos that split frontend + backend.
 *
 * The `PlaywrightIntegration.startServer()` path only starts the primary service
 * (the one whose `startCommand` + `baseURL` + `port` are on `config`). When the
 * auto-detector returns two services (e.g. apps/web + apps/api), the NON-primary
 * services need to be spawned here, BEFORE the primary starts — so that by the
 * time Playwright begins exploring routes or hitting API endpoints, both halves
 * of the stack are running.
 *
 * PIDs are recorded into `healix-reports/.healix-services.pids` so that the
 * next pipeline run can clean them up even if this run crashes.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');
const Logger = require('./logger');

const PID_FILENAME = '.healix-services.pids';

function pidFilePath(projectPath) {
  return path.join(projectPath, 'healix-reports', PID_FILENAME);
}

function readPidFile(projectPath) {
  const p = pidFilePath(projectPath);
  try {
    if (!fs.existsSync(p)) return [];
    return fs
      .readFileSync(p, 'utf-8')
      .split('\n')
      .map((line) => parseInt(line.trim(), 10))
      .filter((pid) => Number.isFinite(pid) && pid > 0);
  } catch {
    return [];
  }
}

function writePidFile(projectPath, pids) {
  const p = pidFilePath(projectPath);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, pids.join('\n'));
  } catch { /* non-fatal */ }
}

function killPid(pid, label = 'service') {
  try {
    if (process.platform === 'win32') {
      const { spawnSync } = require('child_process');
      spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
    } else {
      try { process.kill(-pid, 'SIGKILL'); } catch {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      }
    }
    Logger.info('MultiServiceStarter', `Killed leftover ${label} process`, { pid });
  } catch { /* ignore */ }
}

function cleanupLeftoverServices(projectPath) {
  const pids = readPidFile(projectPath);
  pids.forEach((pid) => killPid(pid, 'previous secondary service'));
  try { fs.unlinkSync(pidFilePath(projectPath)); } catch { /* ignore */ }
}

async function isPortOpen(host, port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, host);
  });
}

/**
 * HTTP readiness probe — any 2xx/3xx means "alive enough to hit with Playwright".
 *
 * Cold Vite / Next dev servers accept TCP connections before their module graph
 * has compiled, so a plain port check returns true too early and the first wave
 * of Playwright specs hits ECONNREFUSED or 404 flakes. Probing HTTP closes that
 * window. Redirects are left unfollowed so a 302 to /login still counts as ready.
 */
async function probeHttpReady(probeUrl, { controllerTimeoutMs = 1500 } = {}) {
  const fetchFn = global.fetch || ((url, opts) => import('node-fetch').then((m) => m.default(url, opts)));
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), controllerTimeoutMs);
    const response = await fetchFn(probeUrl, { signal: controller.signal, redirect: 'manual' });
    clearTimeout(timer);
    if (response.status >= 200 && response.status < 400) {
      return true;
    }
  } catch {
    // connection refused / aborted / DNS error — caller will retry
  }
  return false;
}

/**
 * Wait until a service answers HTTP (or TCP if no URL is known) with exponential
 * backoff: 250 ms → 500 → 1000 → 2000 (capped). Default budget is 30 s to cover
 * cold Vite / Next first-compile. Returns true on success, false on timeout.
 *
 * `onReady({ elapsedMs, url })` fires once — the caller uses it to emit the
 * `dev_server_ready` telemetry event.
 *
 * Timeouts are NON-fatal: some services legitimately don't serve `GET /` but
 * still answer test routes, so callers should log a warning and let Playwright
 * attempt the run anyway.
 */
async function waitForServiceReady({
  host,
  port,
  baseURL,
  totalTimeoutMs = 30_000,
  onReady,
  label = 'service',
}) {
  const startedAt = Date.now();

  let primaryUrl = null;
  if (baseURL) {
    primaryUrl = String(baseURL).replace(/\/+$/, '') + '/';
  } else if (host && port) {
    primaryUrl = `http://${host}:${port}/`;
  }
  const healthUrl = primaryUrl ? primaryUrl.replace(/\/+$/, '') + '/api/health' : null;

  let backoffMs = 250;
  const BACKOFF_CAP_MS = 2000;

  const announce = (url) => {
    const elapsedMs = Date.now() - startedAt;
    if (typeof onReady === 'function') {
      try { onReady({ elapsedMs, url }); } catch { /* non-fatal */ }
    }
    Logger.info('MultiServiceStarter', `${label} ready`, { url, elapsedMs });
  };

  while (Date.now() - startedAt < totalTimeoutMs) {
    if (primaryUrl) {
      if (await probeHttpReady(primaryUrl)) { announce(primaryUrl); return true; }
      if (healthUrl && await probeHttpReady(healthUrl)) { announce(healthUrl); return true; }
    } else if (host && port && await isPortOpen(host, port)) {
      announce(`tcp://${host}:${port}`);
      return true;
    }

    await new Promise((r) => setTimeout(r, backoffMs));
    backoffMs = Math.min(BACKOFF_CAP_MS, backoffMs * 2);
  }
  return false;
}

/**
 * Decide which service is "primary" (left to PlaywrightIntegration.startServer)
 * and which are "secondaries" (started here). Rules:
 *  - Exactly one service: nothing to do.
 *  - Frontend + backend: frontend is primary (the one users hit in the browser),
 *    backend is secondary.
 *  - Multiple services with no clear frontend: first one is primary.
 *
 * The primary's startCommand/baseURL/port should already be set on `config` by
 * the caller before we get here; this function touches only the secondaries.
 */
function splitServices(services) {
  if (!Array.isArray(services) || services.length < 2) {
    return { primary: services?.[0] || null, secondaries: [] };
  }
  const frontend = services.find((s) => s.role === 'frontend');
  const backend = services.find((s) => s.role === 'backend');
  if (frontend && backend) {
    return { primary: frontend, secondaries: [backend] };
  }
  return { primary: services[0], secondaries: services.slice(1) };
}

/**
 * Spawn every secondary service. Returns an array of `{ service, pid, ready }`.
 * Silently skips a service when its `startCommand` is empty (e.g., a pure API
 * that the user runs outside of Healix).
 */
async function startSecondaryServices({ projectPath, services, waitMs = 30_000, onReady }) {
  cleanupLeftoverServices(projectPath);

  const { secondaries } = splitServices(services);
  if (secondaries.length === 0) return [];

  const started = [];
  const pids = [];

  for (const svc of secondaries) {
    if (!svc?.startCommand) {
      Logger.warn('MultiServiceStarter', 'Skipping service with no startCommand', {
        role: svc?.role,
        path: svc?.path,
      });
      continue;
    }
    const cwd = svc.path && svc.path !== '.' ? path.join(projectPath, svc.path) : projectPath;
    const detached = process.platform !== 'win32';
    Logger.info('MultiServiceStarter', `Starting ${svc.role} service`, {
      cmd: svc.startCommand,
      cwd,
      port: svc.port,
    });
    const proc = spawn(svc.startCommand, {
      cwd,
      shell: true,
      detached,
      env: { ...process.env, PORT: String(svc.port || '') },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    if (!proc.pid) {
      Logger.warn('MultiServiceStarter', `Failed to spawn ${svc.role} service`);
      continue;
    }
    pids.push(proc.pid);
    const ready = (svc.port || svc.baseURL)
      ? await waitForServiceReady({
        host: '127.0.0.1',
        port: svc.port,
        baseURL: svc.baseURL,
        totalTimeoutMs: waitMs,
        label: `${svc.role} service`,
        onReady: typeof onReady === 'function'
          ? ({ elapsedMs, url }) => onReady({ elapsedMs, url, service: svc })
          : undefined,
      })
      : false;
    if (!ready) {
      // Timeout is a warning, NOT a hard failure — some services legitimately
      // don't answer GET / but serve test routes. Let Playwright try.
      Logger.warn('MultiServiceStarter', `${svc.role} service at :${svc.port} did not become ready within ${waitMs}ms — continuing anyway (Playwright will probe routes directly)`);
    }
    started.push({ service: svc, pid: proc.pid, ready });
  }

  writePidFile(projectPath, pids);
  return started;
}

function stopSecondaryServices(projectPath) {
  cleanupLeftoverServices(projectPath);
}

module.exports = {
  startSecondaryServices,
  stopSecondaryServices,
  splitServices,
  cleanupLeftoverServices,
  waitForServiceReady,
  probeHttpReady,
};
