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
const COMMON_LOGIN_PATHS = [
  '/login',
  '/signin',
  '/sign-in',
  '/auth/login',
  '/auth/signin',
];

function authDirFor(projectPath) {
  return path.join(projectPath, AUTH_DIR_NAME);
}

function normalizeRoleLabel(role) {
  const raw = String(role || 'user').trim().toLowerCase();
  if (!raw) return 'user';
  if (raw === 'administrator' || raw === 'superadmin' || raw === 'super_admin') return 'admin';
  if (raw === 'customer' || raw === 'member' || raw === 'authed' || raw === 'authenticated') return 'user';
  return raw.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function stateFileFor(projectPath, role) {
  const safeRole = normalizeRoleLabel(role || 'default');
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

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function buildLoginCandidates(baseURL, authFlow = null) {
  const candidates = [];
  const pushUrl = (value) => {
    if (!value) return;
    try {
      candidates.push(new URL(value, baseURL).toString());
    } catch { /* ignore invalid candidate */ }
  };

  if (authFlow?.loginUrl) {
    pushUrl(authFlow.loginUrl);
  } else {
    pushUrl(baseURL);
    for (const loginPath of COMMON_LOGIN_PATHS) pushUrl(loginPath);
  }

  return unique(candidates);
}

async function readVisibleAuthError(page, authFlow = null) {
  const selectors = unique([
    authFlow?.failureIndicator,
    '[role="alert"]',
    '.error',
    '[class*="error"]',
    '[class*="alert"]',
    'text=/invalid api key/i',
    'text=/invalid credentials/i',
    'text=/email.*required/i',
    'text=/password.*required/i',
  ]);

  for (const selector of selectors) {
    try {
      const text = await page.locator(selector).first().textContent({ timeout: 800 });
      const trimmed = String(text || '').replace(/\s+/g, ' ').trim();
      if (trimmed && trimmed.length <= 240) return trimmed;
      if (trimmed) return trimmed.slice(0, 240);
    } catch { /* try next selector */ }
  }
  return null;
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
    const userField = authFlow?.credentialFields?.username || 'input[type="email"], input[name="email"], input[name="username"], input[autocomplete="username"]';
    const passField = authFlow?.credentialFields?.password || 'input[type="password"], input[name="password"]';
    const candidates = buildLoginCandidates(baseURL, authFlow);
    const attempted = [];
    let lastError = null;

    for (const loginUrl of candidates) {
      const candidatePathname = (() => { try { return new URL(loginUrl).pathname; } catch { return loginUrl; } })();
      attempted.push(candidatePathname);

      try {
        // Use `load` not `networkidle` — Next.js/Supabase apps have persistent background
        // fetches that can prevent networkidle from firing within any reasonable timeout.
        await page.goto(loginUrl, { waitUntil: 'load', timeout: 30_000 });
        // Capture the actual rendered login path after redirects. Public roots
        // often redirect to /login; comparing final URL against the original
        // "/" candidate misclassifies successful login redirects back to "/".
        const loginPathname = (() => { try { return new URL(page.url()).pathname; } catch { return candidatePathname; } })();

        // During discovery, do not spend 15s on a public home page that has no login form.
        const fieldTimeout = authFlow?.loginUrl ? 15_000 : 4_000;
        await page.locator(userField).first().waitFor({ state: 'visible', timeout: fieldTimeout });
        await page.fill(userField, credentials.username, { timeout: 10_000 });
        await page.fill(passField, credentials.password, { timeout: 10_000 });

        // Wait for SPA navigation to complete. Supabase fires router.replace() in the
        // .then() of signInWithPassword — this is async and fires AFTER the API response,
        // so networkidle can resolve before the redirect. waitForURL is the only reliable
        // signal that the auth flow has actually completed. Pressing Enter is
        // more reliable than only looking for button[type=submit], because many
        // SPA forms use untyped <button> elements or custom UI wrappers.
        await Promise.all([
          page.waitForURL(
            (url) => { try { return url.pathname !== loginPathname; } catch { return false; } },
            { timeout: 20_000 }
          ).catch(() => null),
          page.locator(passField).first().press('Enter').catch(async () => {
            const submit = page.locator([
              'button[type="submit"]',
              'input[type="submit"]',
              'button:not([type="reset"]):not([type="button"])',
            ].join(', ')).first();
            const count = await submit.count().catch(() => 0);
            if (count > 0) await submit.click({ timeout: 10_000 });
          }),
        ]);

        // Allow middleware chain redirects (e.g. /admin → / for non-admin users) to settle.
        await page.waitForLoadState('domcontentloaded', { timeout: 8_000 }).catch(() => null);

        // Primary signal: URL must have changed away from the login page.
        // A successful Supabase auth always redirects; staying on the same page means failure.
        const finalPathname = (() => { try { return new URL(page.url()).pathname; } catch { return loginPathname; } })();
        let loginVerified = finalPathname !== loginPathname;

        // Secondary signal: if a custom success indicator was provided, that overrides.
        if (authFlow?.successIndicator) {
          loginVerified = await page.locator(authFlow.successIndicator).first().isVisible({ timeout: 5_000 }).catch(() => false);
        } else if (loginVerified && authFlow?.failureIndicator) {
          // URL changed but still check no failure banner appeared (e.g. wrong-role redirect to error page)
          const failureVisible = await page.locator(authFlow.failureIndicator).first().isVisible({ timeout: 1_000 }).catch(() => false);
          if (failureVisible) loginVerified = false;
        }

        if (!loginVerified) {
          const visibleError = await readVisibleAuthError(page, authFlow);
          return {
            ok: false,
            reason: visibleError
              ? `Login failed on ${loginPathname}: ${visibleError}`
              : `Login success indicator not detected after submitting ${loginPathname}`,
          };
        }

        await context.storageState({ path: storageStatePath });
        return { ok: true };
      } catch (err) {
        lastError = err;
      }
    }

    const attemptedText = unique(attempted).join(', ');
    return {
      ok: false,
      reason: lastError
        ? `Login driver error after trying ${attemptedText}: ${lastError.message}`
        : `No login form found after trying ${attemptedText}`,
    };
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
    const role = normalizeRoleLabel(cred.role || cred.name || 'user');
    const storageStatePath = stateFileFor(projectPath, role);

    const result = await driveLogin({ baseURL, authFlow, credentials: cred, storageStatePath });
    if (result.ok) {
      Logger.info('CredentialsInjector', `Login verified for role=${role}`, { storageStatePath });
      roles.push({ role, name: role, storageStatePath, loginVerified: true });
    } else {
      Logger.warn('CredentialsInjector', `Login failed for role=${role}`, { reason: result.reason });
      roles.push({ role, name: role, storageStatePath: null, loginVerified: false, reason: result.reason });
    }
  }
  return roles;
}

module.exports = {
  injectCredentials,
  authDirFor,
  stateFileFor,
  buildLoginCandidates,
  normalizeRoleLabel,
};
