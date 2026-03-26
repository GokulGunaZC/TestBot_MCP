import { test, expect } from '../__testbot-fixture';
import type { Page, APIRequestContext } from '@playwright/test';

const PROTECTED_ROUTES = [
  '/home',
  '/all-tests',
  '/test-lists',
  '/api-keys',
  '/profile',
  '/plan-billing',
  '/monitoring',
  '/create-tests',
  '/mcp-tests'
];

function attachConsoleErrorCollector(page: Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  page.on('console', (msg) => {
    // Fail the test on browser console errors.
    if (msg.type() === 'error') {
      // Include location when available (Chromium typically provides it).
      const location = msg.location();
      const where = location?.url ? ` @ ${location.url}:${location.lineNumber ?? 0}:${location.columnNumber ?? 0}` : '';
      consoleErrors.push(`${msg.text()}${where}`);
    }
  });

  page.on('pageerror', (err) => {
    pageErrors.push(String(err?.message || err));
  });

  return {
    consoleErrors,
    pageErrors,
    assertNoErrors: async () => {
      // Deterministic assertion: must be empty.
      expect(consoleErrors, `Console errors detected:\n${consoleErrors.join('\n')}`).toEqual([]);
      expect(pageErrors, `Page errors detected:\n${pageErrors.join('\n')}`).toEqual([]);
    }
  };
}

async function expectOnLogin(page: Page) {
  await expect(page, 'Expected to be on /login').toHaveURL(/\/login(?:\?|#|$)/);

  // Prefer accessible queries; fall back to placeholders if needed.
  const email = page.getByLabel(/email/i).or(page.getByPlaceholder(/email/i));
  const password = page.getByLabel(/password/i).or(page.getByPlaceholder(/password/i));

  await expect(email, 'Email input should be visible on login page').toBeVisible();
  await expect(password, 'Password input should be visible on login page').toBeVisible();

  // Landmark-ish check: look for a primary action.
  const signInButton = page.getByRole('button', { name: /log in|sign in|continue/i });
  await expect(signInButton, 'Login submit button should be visible').toBeVisible();
}

async function expectOnSignup(page: Page) {
  await expect(page, 'Expected to be on /signup').toHaveURL(/\/signup(?:\?|#|$)/);

  const fullName = page.getByLabel(/full\s*name|name/i).or(page.getByPlaceholder(/full\s*name|name/i));
  const email = page.getByLabel(/email/i).or(page.getByPlaceholder(/email/i));
  const password = page.getByLabel(/^password$/i).or(page.getByPlaceholder(/^password$/i));
  const confirm = page.getByLabel(/confirm\s*password/i).or(page.getByPlaceholder(/confirm\s*password/i));

  await expect(fullName, 'Full name input should be visible on signup page').toBeVisible();
  await expect(email, 'Email input should be visible on signup page').toBeVisible();
  await expect(password, 'Password input should be visible on signup page').toBeVisible();
  await expect(confirm, 'Confirm password input should be visible on signup page').toBeVisible();

  const createAccountButton = page.getByRole('button', { name: /sign\s*up|create\s*account|register/i });
  await expect(createAccountButton, 'Signup submit button should be visible').toBeVisible();
}

async function expectHasBasicLayout(page: Page) {
  // Robust-ish UI landmark: prefer semantic main.
  const main = page.getByRole('main');
  await expect(main, 'App should render a <main> landmark').toBeVisible();

  // Additional basic sanity: the document title should not be empty.
  // Deterministic: ensure length > 0 by asserting non-empty string.
  const title = await page.title();
  expect(title.trim().length, 'Document title should be non-empty').toBeGreaterThan(0);
}

async function expectRedirectedToLoginFromProtectedRoute(page: Page, route: string) {
  await page.goto(route);
  await expectOnLogin(page);

  // Verify a redirectedFrom param is present for protected route redirects.
  // Deterministic: match exact route encoded/appearing.
  await expect(page, `Expected redirectedFrom to include ${route}`).toHaveURL(new RegExp(`\\/login\\?.*redirectedFrom=${encodeURIComponent(route).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:&|$)`));
}

async function expectApiStatus(request: APIRequestContext, method: 'GET' | 'POST', url: string, body?: unknown) {
  const response = method === 'GET'
    ? await request.get(url)
    : await request.post(url, body !== undefined ? { data: body } : undefined);

  return response.status();
}

test.describe('Smoke: core application health and navigation', () => {
  test('App loads login page with required fields and no console/page errors [REQ:app-load] [REQ:login-page]', async ({ page, baseURL }) => {
    const errors = attachConsoleErrorCollector(page);

    await page.goto('/login');

    // Core UI landmarks.
    await expectOnLogin(page);
    await expectHasBasicLayout(page);

    // URL should not be an absolute equality assertion; check only path.
    await expect(page).toHaveURL(/\/login(?:\?|#|$)/);

    await errors.assertNoErrors();
  });

  test('Unauthenticated user is redirected from protected routes to /login with redirectedFrom [REQ:protected-route-redirect]', async ({ page }) => {
    const errors = attachConsoleErrorCollector(page);

    for (const route of PROTECTED_ROUTES) {
      await expectRedirectedToLoginFromProtectedRoute(page, route);
    }

    await errors.assertNoErrors();
  });

  test('Signup page loads and login link navigates back to login [REQ:signup-page] [REQ:main-route-navigation]', async ({ page }) => {
    const errors = attachConsoleErrorCollector(page);

    await page.goto('/signup');
    await expectOnSignup(page);

    // Prefer role-based link navigation to ensure route wiring works.
    const loginLink = page.getByRole('link', { name: /log\s*in|sign\s*in/i });
    await expect(loginLink, 'Login link should be visible on signup page').toBeVisible();
    await loginLink.click();

    await expectOnLogin(page);

    await errors.assertNoErrors();
  });

  test('Mobile viewport renders login form without overflow/regression and no console errors [REQ:responsive-mobile]', async ({ page }) => {
    const errors = attachConsoleErrorCollector(page);

    await page.setViewportSize({ width: 390, height: 844 }); // iPhone 12-ish
    await page.goto('/login');

    await expectOnLogin(page);

    // Deterministic layout sanity: main should be within viewport width.
    const main = page.getByRole('main');
    const box = await main.boundingBox();
    expect(box, 'Main element should have a bounding box').not.toBeNull();
    if (box) {
      expect(box.width, 'Main width should not exceed viewport width significantly').toBeLessThanOrEqual(390);
    }

    await errors.assertNoErrors();
  });

  test('API health: unauthenticated protected API returns 401 and login missing fields returns 400 [REQ:api-validation]', async ({ request }) => {
    // Protected API should reject without auth.
    const testRunsStatus = await expectApiStatus(request, 'GET', '/api/test-runs');
    expect(testRunsStatus, 'GET /api/test-runs should return 401 when unauthenticated').toBe(401);

    // Login API missing fields should return 400.
    const missingFieldsStatus = await expectApiStatus(request, 'POST', '/api/auth/login', { email: '' });
    expect(missingFieldsStatus, 'POST /api/auth/login with missing password should return 400').toBe(400);
  });
});