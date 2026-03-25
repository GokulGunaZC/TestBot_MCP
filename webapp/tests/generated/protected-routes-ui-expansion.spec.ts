import { test, expect } from './__testbot-fixture';

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3001';

const protectedPaths = ['/home', '/all-tests', '/test-lists', '/api-keys', '/profile', '/plan-billing', '/monitoring'];

test.describe('[CAT:workflow_journey] Protected route redirects (unauthenticated)', () => {
  for (const path of protectedPaths) {
    test(`[CAT:workflow_journey] Unauthenticated visit to ${path} redirects to /login with redirectedFrom`, async ({ page }) => {
      await page.goto(`${BASE_URL}${path}`);
      await expect(page).toHaveURL(/\/login/);
      await expect(page).toHaveURL(/redirectedFrom=/);

      const url = page.url();
      expect(url).toContain('redirectedFrom=');
    });
  }

  test('[CAT:ui_flow] /home is not directly reachable when unauthenticated', async ({ page }) => {
    await page.goto(`${BASE_URL}/home`);
    await expect(page).not.toHaveURL(/\/home/);
    await expect(page).toHaveURL(/\/login/);
  });
});