import { test, expect } from './__testbot-fixture';

const BASE_URL = 'http://localhost:3001';

const protectedPaths = ['/home', '/all-tests', '/test-lists', '/api-keys', '/profile', '/plan-billing', '/monitoring', '/mcp-tests', '/create-tests'];

test.describe('[CAT:workflow_journey] Protected route redirect workflow', () => {
  test.beforeEach(async ({ page }) => {
    // Ensure test isolation: clear cookies/storage and ensure server session is cleared.
    await page.context().clearCookies();
    await page.goto('about:blank');
  });

  test('unauthenticated visit to /home redirects to /login with redirectedFrom param [REQ:protected-route-redirect]', async ({ page }) => {
    // Step 1: Visit /home while unauthenticated
    await page.goto(`${BASE_URL}/home`);

    // Step 2: Verify redirect to /login
    await expect(page).toHaveURL(/\/login\?(?:.*&)?redirectedFrom=%2Fhome(?:&.*)?$/);

    // Step 3: Ensure login form is visible (completion indicator)
    await expect(page.getByLabel(/email/i).or(page.getByPlaceholder(/email/i))).toBeVisible();
    await expect(page.getByLabel(/password/i).or(page.getByPlaceholder(/password/i))).toBeVisible();
  });

  test('all protected routes redirect to /login when unauthenticated [REQ:protected-route-redirect]', async ({ page }) => {
    // Step through each protected route to validate redirect behavior.
    for (const path of protectedPaths) {
      // Isolate each navigation by clearing cookies (server might set a transient cookie)
      await page.context().clearCookies();

      await page.goto(`${BASE_URL}${path}`);

      // Assert we end on login and redirectedFrom matches the attempted path
      const encoded = encodeURIComponent(path);
      await expect(page).toHaveURL(new RegExp(`\\/login\\?(?:.*&)?redirectedFrom=${encoded}(?:&.*)?$`));

      // Assert login CTA is present
      await expect(page.getByRole('button', { name: /log in|sign in|submit/i })).toBeVisible();
    }
  });
});