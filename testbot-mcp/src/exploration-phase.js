'use strict';

/**
 * Exploration-phase orchestrator.
 *
 *   1. If `skipExploration` is set, or `browser-use` isn't available, return a
 *      minimal artifact so the downstream generator can still run in PRD-only
 *      mode. This is important: exploration MUST NOT be a blocker for the
 *      happy path on a fresh install.
 *   2. Otherwise invoke `browser-use-driver.driveExploration` against the
 *      already-running app (the multi-service starter + Playwright's
 *      startServer have brought it up) and write `exploration-artifact.json`
 *      into the run's status dir.
 *
 * The artifact shape matches `ExplorationArtifact` in
 * `webapp/src/lib/test-generation/types.ts` so the webapp's generator prompt
 * can read it without a schema adapter.
 */

const fs = require('fs');
const path = require('path');
const Logger = require('./logger');
const { driveExploration } = require('./browser-use-driver');
const { exploreWithPlaywright, enrichRoutesWithDOM } = require('./playwright-explorer');
const { injectCredentials } = require('./credentials-injector');
const { isUnsafeAuthFlow, sanitizeAuthFlow } = require('./auth-flow-utils');

const EMPTY_ARTIFACT = Object.freeze({
  routes: [],
  forms: [],
  authFlow: null,
  keyFlows: [],
  observedErrors: [],
});

async function _applyDOMEnrichment(artifact, { baseURL, preAuthRoles }) {
  if (!artifact.routes || artifact.routes.length === 0) return artifact;
  Logger.info('ExplorationPhase', 'Running Playwright DOM enrichment pass', {
    routeCount: artifact.routes.length,
  });
  try {
    const { enrichments, errorProbe } = await enrichRoutesWithDOM({
      baseURL,
      routes: artifact.routes,
      storageStatePaths: preAuthRoles || [],
      onHeartbeat: () => {},
    });
    const enrichedRoutes = artifact.routes.map((r) => ({
      ...r,
      ...(enrichments[r.path] || {}),
    }));
    return { ...artifact, routes: enrichedRoutes, errorProbe: errorProbe || null };
  } catch (err) {
    Logger.warn('ExplorationPhase', 'DOM enrichment pass failed (non-fatal)', { reason: err.message });
    return artifact;
  }
}

function primaryCredential(credentials) {
  if (!credentials) return null;
  if (Array.isArray(credentials)) {
    return credentials.find((c) => c?.username && c?.password) || null;
  }
  if (credentials.username && credentials.password) return credentials;
  return null;
}

function normalizeExplorationArtifact(rawArtifact = {}, source = 'unknown') {
  const rawAuthFlow = rawArtifact?.authFlow || null;
  const authFlow = sanitizeAuthFlow(rawAuthFlow);
  const authFlowRejected = !!rawAuthFlow && !authFlow;
  const observedErrors = Array.isArray(rawArtifact?.observedErrors) ? [...rawArtifact.observedErrors] : [];
  if (authFlowRejected) {
    const reason = isUnsafeAuthFlow(rawAuthFlow)
      ? `Rejected non-login authFlow from ${source}: ${rawAuthFlow.loginUrl}`
      : `Rejected low-confidence authFlow from ${source}: ${rawAuthFlow.loginUrl || 'unknown'}`;
    observedErrors.push(reason);
  }
  return {
    routes: Array.isArray(rawArtifact?.routes) ? rawArtifact.routes : [],
    forms: Array.isArray(rawArtifact?.forms) ? rawArtifact.forms : [],
    authFlow,
    keyFlows: Array.isArray(rawArtifact?.keyFlows) ? rawArtifact.keyFlows : [],
    observedErrors,
    errorProbe: rawArtifact?.errorProbe || null,
    authFlowRejected: authFlowRejected
      ? {
          loginUrl: rawAuthFlow.loginUrl || null,
          reason: isUnsafeAuthFlow(rawAuthFlow) ? 'registration_or_signup_flow' : 'low_confidence_login_flow',
          source,
        }
      : null,
  };
}

function artifactHasUsefulContext(artifact = {}) {
  if (!artifact || typeof artifact !== 'object') return false;
  const routes = Array.isArray(artifact.routes) ? artifact.routes : [];
  const usefulRouteCount = routes.filter((route) => {
    const pathValue = String(route?.path || route?.url || '').toLowerCase();
    return (
      pathValue &&
      pathValue !== '/' &&
      pathValue !== '/#' &&
      !/(^|\/|#)(login|sign-in|signin|auth|register|signup|sign-up)(\/|$|\?)/.test(pathValue)
    );
  }).length;
  const formCount = Array.isArray(artifact.forms) ? artifact.forms.length : 0;
  const keyFlowCount = Array.isArray(artifact.keyFlows) ? artifact.keyFlows.length : 0;
  // An authFlow, login-only route, or homepage-only route is not enough; that
  // is exactly the failure mode where browser-use stalled before mapping the app.
  return Boolean(usefulRouteCount > 0 || formCount > 0 || keyFlowCount > 0);
}

async function runPlaywrightFallback({ baseURL, credsForAgent, preAuthRoles }) {
  const fallback = await exploreWithPlaywright({
    baseURL,
    credentials: credsForAgent,
    storageStatePaths: preAuthRoles,
    onHeartbeat: () => { /* noop */ },
  });
  if (!fallback.available) return fallback;
  return {
    ...fallback,
    artifact: await _applyDOMEnrichment(fallback.artifact, { baseURL, preAuthRoles }),
  };
}

async function runExplorationPhase({
  statusDir,
  baseURL,
  credentials,
  projectPath,
  skipExploration = false,
  totalTimeoutMs = 120_000,
}) {
  if (skipExploration) {
    Logger.info('ExplorationPhase', 'skipExploration=true — using empty artifact');
    return { artifact: { ...EMPTY_ARTIFACT }, source: 'skipped', reason: 'user opt-out' };
  }

  if (!baseURL) {
    return { artifact: { ...EMPTY_ARTIFACT }, source: 'unavailable', reason: 'no baseURL' };
  }

  const cred = primaryCredential(credentials);
  const credsForAgent = cred ? { username: cred.username, password: cred.password } : undefined;

  // Pre-authenticate ALL roles before exploration so every role's protected
  // routes are reachable. We use fallback selectors (no authFlow yet) for a
  // best-effort login. The resulting storageState files are passed to the
  // Playwright heuristic explorer which runs one walk per role and merges the
  // results. browser-use handles its own login via the improved task prompt.
  let preAuthRoles = [];
  if (cred && projectPath) {
    try {
      const allCreds = Array.isArray(credentials) ? credentials : [cred];
      const injected = await injectCredentials({
        projectPath,
        baseURL,
        credentials: allCreds,
        authFlow: null,
      });
      preAuthRoles = injected.filter((r) => r.loginVerified && r.storageStatePath);
      if (preAuthRoles.length > 0) {
        Logger.info('ExplorationPhase', `Pre-auth login succeeded for ${preAuthRoles.length} role(s) — explorer will start authenticated`, {
          roles: preAuthRoles.map((r) => r.role),
        });
      } else {
        Logger.info('ExplorationPhase', 'Pre-auth login could not be verified for any role — exploring as unauthenticated');
      }
    } catch (preAuthErr) {
      Logger.warn('ExplorationPhase', 'Pre-auth attempt failed (best-effort)', { reason: preAuthErr.message });
    }
  }

  // Prefer browser-use when its deps are in place; fall back to heuristic
  // Playwright exploration so the MCP works out of the box without requiring
  // an OPENAI_API_KEY on the user's machine.
  let result = await driveExploration({
    targetUrl: baseURL,
    credentials: preAuthRoles.length > 0 ? undefined : credsForAgent,
    allCredentials: Array.isArray(credentials) ? credentials : (cred ? [cred] : []),
    preAuthRoleCount: preAuthRoles.length,
    totalTimeoutMs,
    onHeartbeat: () => { /* noop — heartbeats could be surfaced to status later */ },
  });
  let source = 'browser-use';

  if (result.available) {
    if (artifactHasUsefulContext(result.artifact)) {
      // Playwright DOM enrichment runs after browser-use to capture labels,
      // select options, button disabled state, headings, and error probe text.
      result = {
        ...result,
        artifact: await _applyDOMEnrichment(result.artifact, { baseURL, preAuthRoles }),
      };
      source = 'browser-use+playwright-enrichment';
    } else {
      Logger.warn('ExplorationPhase', 'browser-use returned no usable context — falling back to Playwright heuristic', {
        observedErrors: result.artifact?.observedErrors || [],
      });
      const fallback = await runPlaywrightFallback({ baseURL, credsForAgent, preAuthRoles });
      if (fallback.available) {
        const fallbackArtifact = fallback.artifact || {};
        const browserAuthFlow = result.artifact?.authFlow || null;
        const observedErrors = [
          ...(Array.isArray(result.artifact?.observedErrors) ? result.artifact.observedErrors : []),
          'browser-use returned no usable context; used Playwright heuristic fallback',
          ...(Array.isArray(fallbackArtifact.observedErrors) ? fallbackArtifact.observedErrors : []),
        ];
        result = {
          ...fallback,
          artifact: {
            ...fallbackArtifact,
            authFlow: fallbackArtifact.authFlow || browserAuthFlow,
            observedErrors,
          },
        };
        source = 'browser-use-empty+playwright-heuristic+enrichment';
      } else {
        Logger.warn('ExplorationPhase', 'No exploration available after empty browser-use result — degrading to empty artifact', {
          fallbackReason: fallback.reason,
        });
        return {
          artifact: {
            ...EMPTY_ARTIFACT,
            observedErrors: [
              ...(Array.isArray(result.artifact?.observedErrors) ? result.artifact.observedErrors : []),
              `Playwright fallback unavailable after empty browser-use result: ${fallback.reason || 'unknown'}`,
            ],
          },
          source: 'unavailable',
          reason: fallback.reason || 'browser-use returned no usable context',
          preAuthRoles,
        };
      }
    }
  } else {
    Logger.info('ExplorationPhase', 'browser-use unavailable — falling back to Playwright heuristic', {
      reason: result.reason,
    });
    const fallback = await runPlaywrightFallback({ baseURL, credsForAgent, preAuthRoles });
    if (fallback.available) {
      result = fallback;
      source = 'playwright-heuristic+enrichment';
    } else {
      Logger.warn('ExplorationPhase', 'No exploration available — degrading to empty artifact', {
        browserUseReason: result.reason,
        fallbackReason: fallback.reason,
      });
      return {
        artifact: { ...EMPTY_ARTIFACT },
        source: 'unavailable',
        reason: fallback.reason || result.reason,
      };
    }
  }

  const artifact = normalizeExplorationArtifact(result.artifact, source);

  if (statusDir) {
    try {
      fs.writeFileSync(
        path.join(statusDir, 'exploration-artifact.json'),
        JSON.stringify(artifact, null, 2),
        'utf-8'
      );
    } catch (err) {
      Logger.warn('ExplorationPhase', 'Failed to cache exploration-artifact.json', { reason: err.message });
    }
  }

  return { artifact, source, preAuthRoles };
}

module.exports = {
  runExplorationPhase,
  EMPTY_ARTIFACT,
  normalizeExplorationArtifact,
  artifactHasUsefulContext,
};
