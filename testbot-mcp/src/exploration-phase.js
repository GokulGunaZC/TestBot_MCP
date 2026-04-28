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
const { exploreWithPlaywright } = require('./playwright-explorer');
const { injectCredentials } = require('./credentials-injector');

const EMPTY_ARTIFACT = Object.freeze({
  routes: [],
  forms: [],
  authFlow: null,
  keyFlows: [],
  observedErrors: [],
});

function primaryCredential(credentials) {
  if (!credentials) return null;
  if (Array.isArray(credentials)) {
    return credentials.find((c) => c?.username && c?.password) || null;
  }
  if (credentials.username && credentials.password) return credentials;
  return null;
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
    credentials: credsForAgent,
    allCredentials: Array.isArray(credentials) ? credentials : (cred ? [cred] : []),
    totalTimeoutMs,
    onHeartbeat: () => { /* noop — heartbeats could be surfaced to status later */ },
  });
  let source = 'browser-use';

  if (!result.available) {
    Logger.info('ExplorationPhase', 'browser-use unavailable — falling back to Playwright heuristic', {
      reason: result.reason,
    });
    const fallback = await exploreWithPlaywright({
      baseURL,
      credentials: credsForAgent,
      storageStatePaths: preAuthRoles,
      onHeartbeat: () => { /* noop */ },
    });
    if (fallback.available) {
      result = fallback;
      source = 'playwright-heuristic';
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

  const artifact = {
    routes: Array.isArray(result.artifact?.routes) ? result.artifact.routes : [],
    forms: Array.isArray(result.artifact?.forms) ? result.artifact.forms : [],
    authFlow: result.artifact?.authFlow || null,
    keyFlows: Array.isArray(result.artifact?.keyFlows) ? result.artifact.keyFlows : [],
    observedErrors: Array.isArray(result.artifact?.observedErrors) ? result.artifact.observedErrors : [],
  };

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
};
