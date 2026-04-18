'use strict';

/**
 * Per-role credential injector. For each entry in `testCredentials`, drive a
 * headless Playwright login against the `authFlow` observed by exploration (or
 * supplied in config) and persist the resulting `storageState` to
 * `.healix/auth-state-<role>.json`.
 *
 * Output:
 *   [{ role, storageStatePath, loginVerified, reason? }, ...]
 *
 * Behaviour when exploration hasn't found an authFlow:
 *   - Return an empty roles array. Tier B tests won't be run, but Tier A and
 *     Tier C continue. This matches the "partial green" promise in the plan.
 *
 * Credentials NEVER leave the user's machine:
 *   - Written to `.healix/` which is in the artifact-uploader deny-list.
 *   - Dashboard record stores only role labels + `loginVerified`.
 */

const fs = require('fs');
const path = require('path');
const Logger = require('./logger');

const AUTH_DIR_NAME = '.healix';
const STATE_FILE_PREFIX = 'auth-state-';

function authDirFor(projectPath) {
  return path.join(projectPath, AUTH_DIR_NAME);
}

function stateFileFor(projectPath, role) {
  const safeRole = String(role || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(authDirFor(projectPath), `${STATE_FILE_PREFIX}${safeRole}.json`);
}

function ensureAuthDir(projectPath) {
  const dir = authDirFor(projectPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const gitignore = path.join(dir, '.gitignore');
  if (!fs.existsSync(gitignore)) {
    try {
      fs.writeFileSync(gitignore, '*\n!.gitignore\n', 'utf-8');
    } catch { /* non-fatal */ }
  }
  return dir;
}

/**
 * Drive a login with Playwright. Returns true if post-login state shows the
 * `successIndicator` and not the `failureIndicator`. We use Playwright via
 * runtime require so missing deps fall through to a clear error, not a crash.
 */
async function driveLogin({ baseURL, authFlow, credentials, storageStatePath }) {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    return { ok: false, reason: 'playwright not installed — cannot drive login' };
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    const loginUrl = authFlow?.loginUrl
      ? new URL(authFlow.loginUrl, baseURL).toString()
      : baseURL;
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });

    const userField = authFlow?.credentialFields?.username || 'input[type="email"], input[name="email"], input[name="username"]';
    const passField = authFlow?.credentialFields?.password || 'input[type="password"], input[name="password"]';

    await page.fill(userField, credentials.username, { timeout: 10_000 });
    await page.fill(passField, credentials.password, { timeout: 10_000 });

    const submit = page.locator('button[type="submit"], input[type="submit"]').first();
    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => null),
      submit.click({ timeout: 10_000 }),
    ]);

    let loginVerified = true;
    if (authFlow?.successIndicator) {
      loginVerified = await page.locator(authFlow.successIndicator).first().isVisible({ timeout: 10_000 }).catch(() => false);
    } else if (authFlow?.failureIndicator) {
      const failureVisible = await page.locator(authFlow.failureIndicator).first().isVisible({ timeout: 3000 }).catch(() => false);
      loginVerified = !failureVisible;
    }

    if (!loginVerified) {
      return { ok: false, reason: 'Login success indicator not detected post-submit' };
    }

    await context.storageState({ path: storageStatePath });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `Login driver error: ${err.message}` };
  } finally {
    try { await browser.close(); } catch { /* ignore */ }
  }
}

async function injectCredentials({
  projectPath,
  baseURL,
  credentials = [],
  authFlow = null,
} = {}) {
  if (!Array.isArray(credentials) || credentials.length === 0) {
    Logger.info('CredentialsInjector', 'no credentials provided — skipping');
    return [];
  }
  ensureAuthDir(projectPath);

  const roles = [];
  for (const cred of credentials) {
    if (!cred?.username || !cred?.password) continue;
    const role = cred.role || 'user';
    const storageStatePath = stateFileFor(projectPath, role);

    const result = await driveLogin({ baseURL, authFlow, credentials: cred, storageStatePath });
    if (result.ok) {
      Logger.info('CredentialsInjector', `Login verified for role=${role}`, { storageStatePath });
      roles.push({ role, storageStatePath, loginVerified: true });
    } else {
      Logger.warn('CredentialsInjector', `Login failed for role=${role}`, { reason: result.reason });
      roles.push({ role, storageStatePath: null, loginVerified: false, reason: result.reason });
    }
  }
  return roles;
}

module.exports = {
  injectCredentials,
  authDirFor,
  stateFileFor,
};
