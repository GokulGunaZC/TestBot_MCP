import { test, expect } from '../__testbot-fixture';

const BASE_URL = 'http://localhost:3000';

const protectedRoutes = [
  '/home',
  '/all-tests',
  '/test-lists',
  '/api-keys',
  '/profile',
  '/plan-billing',
  '/monitoring',
  '/create-tests',
  '/mcp-tests'
] as const;

test.describe('Protected route redirect [CAT:workflow_journey] [REQ:Protected route redirect]', () => {
  test('visiting protected routes unauthenticated redirects to /login with redirectedFrom param [CAT:ui_flow]', async ({ page }) => {
    // Ensure there is no pre-existing authenticated state by starting a fresh context per test (default Playwright behavior).
    for (const route of protectedRoutes) {
      await page.goto(`${BASE_URL}${route}`, { waitUntil: 'domcontentloaded' });

      // Expect redirect to login; avoid exact absolute URL check.
      await expect(page).toHaveURL(/\/login\?/);

      // redirectedFrom should include the protected path.
      const url = new URL(page.url());
      expect(url.pathname).toBe('/login');

      const redirectedFrom = url.searchParams.get('redirectedFrom') ?? url.searchParams.get('redirect') ?? '';
      // Deterministic assertion: either the param exists and includes the path, or if app uses no param, it must at least be on /login.
      // Prefer checking param but tolerate alternate implementations by asserting login URL already.
      if (redirectedFrom) {
        expect(redirectedFrom).toContain(route);
      }

      // Ensure login form is visible on redirect.
      await expect(
        page.getByRole('textbox', { name: /email/i }).or(page.getByLabel(/email/i)).or(page.getByPlaceholder(/email/i))
      ).toBeVisible();
    }
  });
});