'use strict';

/**
 * Port pre-flight check.
 *
 * The pm-app 2026-04-19 regression: the Healix webapp itself was running on
 * localhost:3000, and the target project's detected dev-server port was also
 * 3000. The in-pipeline port-conflict resolver moved the target to a free
 * port, but by then the run had already written status events that confused
 * the UI and — crucially — the config form was launched with the old port in
 * it, so the user and their dev server tooling saw inconsistent state.
 *
 * The fix is to detect this specific collision BEFORE we launch the config
 * UI, and transparently bump the target port so the form the user sees is
 * already correct. If the port is in use by something that isn't the Healix
 * webapp, we still bump it — the in-pipeline resolver would have done the
 * same, we're just doing it earlier.
 *
 * This module is pure logic; callers inject the probe functions (defaults to
 * node:net for the TCP probe, fetch for the webapp-health probe) so tests can
 * stub them without network.
 */

const net = require('node:net');

/**
 * Probe a TCP port. Returns true if something accepts the connection.
 */
function defaultProbeTcpPort(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    if (!host || !port) return resolve(false);
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(v);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/**
 * Probe whether the Healix webapp is serving at a URL. We don't require a
 * specific healthz route — any JSON response from /api/mcp/validate or a
 * 200/401/403 from /api/auth/* is enough to say "the webapp is here". If the
 * port is in use but no Healix API responds, it's some other process.
 */
async function defaultProbeWebappHealth(dashboardUrl, timeoutMs = 1500) {
  if (!dashboardUrl) return false;
  const base = String(dashboardUrl).replace(/\/+$/, '');
  const candidates = [
    `${base}/api/mcp-auth/validate`, // POST-only, but responds 405/400 — still a Healix signal
    `${base}/api/test-runs/phase`,// Healix-specific
    `${base}/`,                    // Next.js serves something here if it's the Healix webapp
  ];
  for (const url of candidates) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(url, { method: 'GET', signal: controller.signal });
      clearTimeout(t);
      if (res.status >= 200 && res.status < 600) {
        const body = await res.text().catch(() => '');
        if (/healix|test-runs|mcp/i.test(body) || res.headers.get('x-powered-by')?.includes('Next')) {
          return true;
        }
      }
    } catch {
      // fall through to next candidate
    }
  }
  return false;
}

async function defaultFindFreePort(startPort, probeTcpPort, maxAttempts = 50) {
  for (let i = 0; i < maxAttempts; i++) {
    const candidate = startPort + i;
    if (candidate > 65535) break;
    const busy = await probeTcpPort('127.0.0.1', candidate, 400)
      || await probeTcpPort('localhost', candidate, 400);
    if (!busy) return candidate;
  }
  return null;
}

/**
 * Extract host + port from a URL string, defaulting missing port to 80/443.
 */
function parseHostPort(urlString) {
  try {
    const u = new URL(urlString);
    const host = u.hostname;
    const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
    return { host, port, protocol: u.protocol };
  } catch {
    return null;
  }
}

function hostsEquivalent(a, b) {
  if (a === b) return true;
  const local = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);
  return local.has(a) && local.has(b);
}

/**
 * Core pre-flight check.
 *
 * @param {object} opts
 * @param {string} opts.dashboardUrl   HEALIX_DASHBOARD_URL (e.g. http://localhost:3000)
 * @param {string} opts.targetBaseUrl  Detected target-project baseURL (e.g. http://localhost:3000)
 * @param {number|string} opts.targetPort  Detected target-project port
 * @param {function} [opts.probeTcpPort]      Dep-injection for tests
 * @param {function} [opts.probeWebappHealth] Dep-injection for tests
 * @param {function} [opts.findFreePort]      Dep-injection for tests
 * @returns {Promise<PreflightResult>}
 *
 * PreflightResult shape:
 *   { conflict: boolean,
 *     detectedAs: 'no_conflict'|'healix_webapp'|'other_process',
 *     originalPort: number|null,
 *     newPort: number|null,
 *     newBaseUrl: string|null,
 *     reason: string }
 */
async function checkDashboardPortConflict({
  dashboardUrl,
  targetBaseUrl,
  targetPort,
  probeTcpPort = defaultProbeTcpPort,
  probeWebappHealth = defaultProbeWebappHealth,
  findFreePort = null,
} = {}) {
  const freePortFinder = findFreePort
    || ((start) => defaultFindFreePort(start, probeTcpPort));

  const result = {
    conflict: false,
    detectedAs: 'no_conflict',
    originalPort: Number(targetPort) || null,
    newPort: null,
    newBaseUrl: null,
    reason: '',
  };

  const dash = parseHostPort(dashboardUrl);
  const target = parseHostPort(targetBaseUrl);
  const tPort = Number(targetPort) || target?.port || null;

  if (!dash || !tPort) {
    result.reason = 'missing_dashboard_or_target_port';
    return result;
  }

  // Only local Healix webapps can conflict with a local dev server. A deployed
  // Healix (e.g. https://healix.example.com) and a local target server can't
  // collide.
  const dashIsLocal = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']).has(dash.host);
  if (!dashIsLocal) {
    result.reason = 'dashboard_is_remote';
    return result;
  }

  // Ports differ? No conflict.
  if (dash.port !== tPort) {
    result.reason = 'ports_differ';
    return result;
  }

  // Target host must be local too (otherwise the dev server isn't binding the
  // same interface as the webapp).
  const targetHost = target?.host || 'localhost';
  if (!hostsEquivalent(dash.host, targetHost)) {
    result.reason = 'hosts_differ';
    return result;
  }

  // Same port, same host — probe to confirm something is actually listening.
  const busy = await probeTcpPort('127.0.0.1', tPort, 800)
    || await probeTcpPort('localhost', tPort, 800);
  if (!busy) {
    result.reason = 'port_free_no_conflict';
    return result;
  }

  // Something IS on the port. Is it the Healix webapp?
  const isWebapp = await probeWebappHealth(dashboardUrl, 1500);
  result.detectedAs = isWebapp ? 'healix_webapp' : 'other_process';

  // Either way, the target project cannot use this port. Find a new one.
  const newPort = await freePortFinder(tPort + 1);
  if (!newPort) {
    result.conflict = true;
    result.reason = 'no_free_port_available';
    return result;
  }

  let newBaseUrl = null;
  try {
    if (targetBaseUrl) {
      const u = new URL(targetBaseUrl);
      u.port = String(newPort);
      newBaseUrl = u.toString().replace(/\/$/, '');
    } else {
      newBaseUrl = `http://${targetHost}:${newPort}`;
    }
  } catch {
    newBaseUrl = `http://${targetHost}:${newPort}`;
  }

  result.conflict = true;
  result.newPort = newPort;
  result.newBaseUrl = newBaseUrl;
  result.reason = isWebapp
    ? 'healix_webapp_holds_target_port'
    : 'other_process_holds_target_port';
  return result;
}

/**
 * Format a user/agent-friendly one-liner describing the pre-flight outcome.
 * Used in status messages + the banner text in the config UI.
 */
function describePreflight(result) {
  if (!result || !result.conflict) return null;
  const who = result.detectedAs === 'healix_webapp'
    ? 'the Healix webapp itself'
    : 'another process';
  if (result.newPort) {
    return `Port ${result.originalPort} is already held by ${who}. Healix moved your target app's dev server to port ${result.newPort} (baseURL: ${result.newBaseUrl}).`;
  }
  return `Port ${result.originalPort} is held by ${who} and no free port is available nearby.`;
}

module.exports = {
  checkDashboardPortConflict,
  describePreflight,
  parseHostPort,
  hostsEquivalent,
  defaultProbeTcpPort,
  defaultProbeWebappHealth,
};
