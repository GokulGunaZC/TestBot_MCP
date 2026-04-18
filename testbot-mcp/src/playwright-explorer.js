'use strict';

/**
 * Playwright-driven heuristic exploration. The fallback for when `browser-use`
 * (or its LLM key) isn't available — this path works out of the box because
 * Playwright is already an MCP dependency.
 *
 * Contract matches `browser-use-driver.driveExploration`:
 *     { available: true, artifact, source: 'playwright-heuristic' }
 * or
 *     { available: false, reason }
 *
 * Strategy:
 *   1. Open baseURL in headless chromium.
 *   2. Enumerate up to N same-origin anchors, visit each, classify requiresAuth
 *      by the presence of a login form OR a 401/403 response.
 *   3. Detect a login form on whichever route exposes one. Seed authFlow with
 *      the field selectors so `credentials-injector.js` can drive it later.
 *   4. Capture any console errors observed during the walk.
 *
 * Output is an ExplorationArtifact that matches the browser-use runner's shape.
 */

const MAX_ROUTES = 10;
const GOTO_TIMEOUT_MS = 15_000;
const EXPLORE_WAIT_MS = 1500;

function sameOrigin(hrefAbs, originAbs) {
  try {
    return new URL(hrefAbs).origin === new URL(originAbs).origin;
  } catch {
    return false;
  }
}

async function _collectRouteSignals(page) {
  // Pull everything we need for one route in a single DOM scrape so we avoid
  // round-trips.
  return page.evaluate(() => {
    const safeText = (el) => (el?.textContent || '').trim().slice(0, 80);
    const anchors = Array.from(document.querySelectorAll('a[href]'))
      .map((a) => ({ href: a.href, text: safeText(a) }))
      .filter((a) => a.href && !a.href.startsWith('javascript:'))
      .slice(0, 50);

    const forms = Array.from(document.querySelectorAll('form')).map((form) => {
      const fields = Array.from(form.querySelectorAll('input, textarea, select')).map((el) => ({
        name: el.getAttribute('name') || el.getAttribute('id') || '',
        type: el.getAttribute('type') || el.tagName.toLowerCase(),
        required: el.hasAttribute('required'),
      }));
      const submit = form.querySelector('button[type="submit"], input[type="submit"], button');
      return {
        fields,
        submitLabel: safeText(submit) || 'Submit',
      };
    });

    const hasPasswordField = !!document.querySelector('input[type="password"]');
    const usernameGuess = document.querySelector(
      'input[type="email"], input[name="email"], input[name="username"], input[autocomplete="username"]'
    );
    const passwordGuess = document.querySelector('input[type="password"]');

    const authElements = hasPasswordField
      ? {
          usernameSelector:
            usernameGuess?.getAttribute('id')
              ? `#${usernameGuess.getAttribute('id')}`
              : usernameGuess?.getAttribute('name')
                ? `input[name="${usernameGuess.getAttribute('name')}"]`
                : 'input[type="email"], input[name="email"], input[name="username"]',
          passwordSelector:
            passwordGuess?.getAttribute('id')
              ? `#${passwordGuess.getAttribute('id')}`
              : passwordGuess?.getAttribute('name')
                ? `input[name="${passwordGuess.getAttribute('name')}"]`
                : 'input[type="password"]',
        }
      : null;

    const landmarks = Array.from(document.querySelectorAll('button, [role="button"]'))
      .slice(0, 10)
      .map((el) => ({
        role: el.getAttribute('role') || el.tagName.toLowerCase(),
        name: safeText(el),
        selector:
          el.getAttribute('id')
            ? `#${el.getAttribute('id')}`
            : `${el.tagName.toLowerCase()}:has-text("${safeText(el).replace(/"/g, '')}")`,
      }))
      .filter((e) => e.name);

    return { anchors, forms, authElements, landmarks };
  });
}

async function exploreWithPlaywright({ baseURL, credentials, onHeartbeat } = {}) {
  if (!baseURL) {
    return { available: false, reason: 'No baseURL provided to playwright-explorer' };
  }

  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    return { available: false, reason: 'playwright not installed — cannot run heuristic exploration' };
  }

  const origin = (() => {
    try { return new URL(baseURL).origin; } catch { return null; }
  })();
  if (!origin) {
    return { available: false, reason: `Invalid baseURL: ${baseURL}` };
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const observedErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') observedErrors.push(`console: ${msg.text().slice(0, 200)}`);
  });
  page.on('pageerror', (err) => observedErrors.push(`pageerror: ${err.message.slice(0, 200)}`));

  const visitedPaths = new Set();
  const routes = [];
  const formsOut = [];
  let authFlow = null;

  const queue = [baseURL];
  try {
    while (queue.length && routes.length < MAX_ROUTES) {
      const url = queue.shift();
      const parsed = (() => { try { return new URL(url); } catch { return null; } })();
      if (!parsed) continue;
      const pathKey = parsed.pathname;
      if (visitedPaths.has(pathKey)) continue;
      visitedPaths.add(pathKey);

      let response = null;
      try {
        response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS });
      } catch (err) {
        observedErrors.push(`goto(${pathKey}): ${err.message.slice(0, 200)}`);
        continue;
      }
      await page.waitForTimeout(EXPLORE_WAIT_MS);
      if (typeof onHeartbeat === 'function') {
        try { onHeartbeat({ type: 'heartbeat', path: pathKey }); } catch { /* ignore */ }
      }

      const signals = await _collectRouteSignals(page).catch(() => null);
      if (!signals) continue;

      const status = response?.status() ?? 0;
      const requiresAuth =
        status === 401 ||
        status === 403 ||
        (!!signals.authElements && pathKey !== (new URL(baseURL).pathname));

      routes.push({
        path: pathKey,
        requiresAuth,
        elements: signals.landmarks || [],
      });

      for (const form of signals.forms || []) {
        formsOut.push({
          route: pathKey,
          fields: form.fields,
          submitLabel: form.submitLabel,
        });
      }

      if (!authFlow && signals.authElements) {
        authFlow = {
          loginUrl: pathKey,
          credentialFields: {
            username: signals.authElements.usernameSelector,
            password: signals.authElements.passwordSelector,
          },
          successIndicator: '',
          failureIndicator: '[role="alert"], .error, .alert-danger',
        };
      }

      for (const a of signals.anchors || []) {
        if (queue.length + routes.length >= MAX_ROUTES) break;
        if (!sameOrigin(a.href, origin)) continue;
        const aPath = (() => { try { return new URL(a.href).pathname; } catch { return null; } })();
        if (!aPath || visitedPaths.has(aPath)) continue;
        queue.push(a.href);
      }
    }

    const keyFlows = [];
    if (authFlow && credentials?.username) {
      keyFlows.push({
        name: 'login',
        steps: [
          { action: 'goto', target: authFlow.loginUrl },
          { action: 'fill', target: authFlow.credentialFields.username, value: credentials.username },
          { action: 'fill', target: authFlow.credentialFields.password, value: '***' },
          { action: 'click', target: 'button[type="submit"]' },
        ],
        endCondition: 'authenticated session established',
      });
    }
    for (const form of formsOut.slice(0, 3)) {
      if (form.route === authFlow?.loginUrl) continue;
      keyFlows.push({
        name: `submit-form-${form.route.replace(/\//g, '_') || 'root'}`,
        steps: [
          { action: 'goto', target: form.route },
          { action: 'click', target: `text="${form.submitLabel}"` },
        ],
        endCondition: `form at ${form.route} submits`,
      });
    }

    return {
      available: true,
      source: 'playwright-heuristic',
      artifact: {
        routes,
        forms: formsOut,
        authFlow,
        keyFlows,
        observedErrors: observedErrors.slice(0, 20),
      },
    };
  } catch (err) {
    return { available: false, reason: `Playwright explorer error: ${err.message}` };
  } finally {
    try { await browser.close(); } catch { /* ignore */ }
  }
}

module.exports = {
  exploreWithPlaywright,
};
