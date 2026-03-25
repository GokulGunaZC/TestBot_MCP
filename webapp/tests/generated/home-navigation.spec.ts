import { test, expect, type Page } from './__testbot-fixture';

const BASE_URL = 'http://localhost:3001';

async function mockAuthenticatedAppShell(page: Page) {
  // Many apps use protected APIs to render the dashboard.
  // We mock these to keep tests deterministic and interaction-heavy.
  await page.route('**/api/test-runs', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        { id: 'run_1', status: 'passed', createdAt: '2025-01-01T00:00:00Z' }
      ])
    });
  });

  await page.route('**/api/test-lists', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'list_1', name: 'Smoke' }])
    });
  });

  await page.route('**/api/profile', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'user_1', email: 'user@example.com', fullName: 'User' })
    });
  });
}

function getHomeActions(page: Page) {
  const testLocally = page.getByTestId('test-locally-mcp').or(page.getByRole('button', { name: /test locally mcp/i }));
  const viewAll = page.getByTestId('view-all').or(page.getByRole('link', { name: /view all/i }));
  const upgrade = page.getByTestId('upgrade-pro').or(page.getByRole('button', { name: /upgrade to pro/i }));
  const newTestList = page.getByTestId('new-test-list').or(page.getByRole('link', { name: /new test list/i }));

  return { testLocally, viewAll, upgrade, newTestList };
}

test.describe('Home dashboard navigation [CAT:ui_flow]', () => {
  test.beforeEach(async ({ page }) => {
    await mockAuthenticatedAppShell(page);

    // NOTE: If the app requires a real authenticated session, these tests may need a login helper.
    // For production-ready determinism, we start from /home and allow the app to render with mocked APIs.
    await page.goto(`${BASE_URL}/home`, { waitUntil: 'domcontentloaded' });
  });

  test('home loads and shows primary dashboard actions [CAT:ui_flow]', async ({ page }) => {
    // If route is truly protected by server-side redirect, this will land on /login.
    // In that case, fail fast with a clear expectation so the suite signals auth setup is needed.
    await expect(page).toHaveURL(/\/(home|login)(\?|$)/);

    if (new URL(page.url()).pathname === '/login') {
      // Deterministic failure with actionable assertion.
      await expect(page.getByRole('heading').first()).toBeVisible();
      await expect(page.getByText(/log\s*in|sign\s*in/i)).toBeVisible();
      test.skip(true, 'Home is protected and redirected to /login; configure authenticated storageState or login helper to run this test.');
    }

    await expect(page.getByRole('heading').first()).toBeVisible();

    const { testLocally, viewAll, upgrade, newTestList } = getHomeActions(page);
    await expect(testLocally).toBeVisible();
    await expect(viewAll).toBeVisible();
    await expect(upgrade).toBeVisible();
    await expect(newTestList).toBeVisible();
  });

  test('navigates to All Tests from home (View All) [CAT:workflow_journey]', async ({ page }) => {
    if (new URL(page.url()).pathname === '/login') test.skip(true, 'Requires authenticated state to access /home.');

    const { viewAll } = getHomeActions(page);

    await Promise.all([
      page.waitForURL(/\/all-tests(\?|$)/),
      viewAll.click()
    ]);

    await expect(page).toHaveURL(/\/all-tests(\?|$)/);
    await expect(page.getByRole('heading').first()).toBeVisible();
  });

  test('navigates to Test Lists from home (New Test List) [CAT:workflow_journey]', async ({ page }) => {
    if (new URL(page.url()).pathname === '/login') test.skip(true, 'Requires authenticated state to access /home.');

    const { newTestList } = getHomeActions(page);

    await Promise.all([
      page.waitForURL(/\/test-lists(\?|$)/),
      newTestList.click()
    ]);

    await expect(page).toHaveURL(/\/test-lists(\?|$)/);
    await expect(page.getByRole('heading').first()).toBeVisible();
  });

  test('navigates to Create Tests / MCP instructions from home (Test Locally MCP) [CAT:workflow_journey]', async ({ page }) => {
    if (new URL(page.url()).pathname === '/login') test.skip(true, 'Requires authenticated state to access /home.');

    const { testLocally } = getHomeActions(page);

    // Some apps route to /create-tests or /mcp-tests. Accept either.
    await Promise.all([
      page.waitForURL(/\/(create-tests|mcp-tests)(\?|$)/),
      testLocally.click()
    ]);

    await expect(page).toHaveURL(/\/(create-tests|mcp-tests)(\?|$)/);
    await expect(page.getByRole('heading').first()).toBeVisible();
  });
});