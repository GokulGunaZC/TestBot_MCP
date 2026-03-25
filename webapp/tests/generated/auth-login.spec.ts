import { test, expect, type Page } from './__testbot-fixture';

const BASE_URL = 'http://localhost:3001';

type LoginMode = 'success' | 'invalid' | 'missing';

/**
 * Helper to robustly locate the login form fields using accessible selectors.
 * Selector ladder preference: testId -> role/name -> label -> placeholder -> text.
 */
function getLoginLocators(page: Page) {
  const email = page.getByTestId('email').or(
    page.getByRole('textbox', { name: /email/i }).or(
      page.getByLabel(/email/i).or(page.getByPlaceholder(/email/i))
    )
  );

  // Password might be a textbox with type=password; role may still be 'textbox'
  const password = page.getByTestId('password').or(
    page.getByLabel(/^password$/i).or(
      page.getByPlaceholder(/^password$/i).or(page.getByRole('textbox', { name: /^password$/i }))
    )
  );

  const submit = page.getByTestId('login-submit').or(
    page.getByRole('button', { name: /log\s*in|sign\s*in/i }).or(page.getByText(/log\s*in|sign\s*in/i))
  );

  const signupLink = page.getByTestId('signup-link').or(
    page.getByRole('link', { name: /sign\s*up|create\s*account/i }).or(page.getByText(/sign\s*up|create\s*account/i))
  );

  return { email, password, submit, signupLink };
}

async function expectAuthErrorVisible(page: Page) {
  // Common patterns: alert role, inline error text, toast.
  const alert = page.getByRole('alert');
  const errorText = page.getByText(/invalid|incorrect|unauthorized|error|failed|required/i);

  // Deterministic assertion: one of these must become visible.
  await expect(alert.or(errorText)).toBeVisible();
}

test.describe('Auth - Login [CAT:workflow_journey]', () => {
  test.beforeEach(async ({ page }) => {
    // Ensure isolation: start every test from login page.
    await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded' });
  });

  test('loads login page and exposes core controls [CAT:ui_flow]', async ({ page }) => {
    await expect(page).toHaveURL(/\/login(\?|$)/);

    // Validate there is a primary heading (accessibility smoke check)
    const heading = page.getByRole('heading').first();
    await expect(heading).toBeVisible();

    const { email, password, submit, signupLink } = getLoginLocators(page);

    await expect(email).toBeVisible();
    await expect(email).toBeEditable();
    await expect(password).toBeVisible();
    await expect(password).toBeEditable();

    await expect(submit).toBeVisible();
    await expect(submit).toBeEnabled();

    await expect(signupLink).toBeVisible();
    await expect(signupLink).toHaveAttribute('href', /signup/);
  });

  test('navigates to signup via link [CAT:ui_flow]', async ({ page }) => {
    const { signupLink } = getLoginLocators(page);

    await Promise.all([
      page.waitForURL(/\/signup(\?|$)/),
      signupLink.click()
    ]);

    // Basic load assertion for destination page
    await expect(page.getByRole('heading').first()).toBeVisible();
  });

  test('shows validation error when submitting empty form [CAT:form_validation]', async ({ page }) => {
    const { submit } = getLoginLocators(page);

    await submit.click();

    // Depending on implementation, browser native validation may prevent submit.
    // We assert the user receives an accessible error signal.
    await expectAuthErrorVisible(page);

    // Still on login page
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });

  test('shows error on invalid credentials and stays on login [CAT:workflow_journey]', async ({ page }) => {
    const { email, password, submit } = getLoginLocators(page);

    // Mock invalid credential response
    await page.route('**/api/auth/login', async (route) => {
      const request = route.request();
      if (request.method().toUpperCase() !== 'POST') return route.fallback();

      // Return 401 to trigger invalid credentials UX
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, userId: '' })
      });
    });

    await email.fill('user@example.com');
    await password.fill('wrong-password');

    await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/auth/login') && r.status() === 401),
      submit.click()
    ]);

    await expectAuthErrorVisible(page);
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });

  test('successful login redirects to /home [CAT:workflow_journey]', async ({ page }) => {
    const { email, password, submit } = getLoginLocators(page);

    // Mock success response
    await page.route('**/api/auth/login', async (route) => {
      const request = route.request();
      if (request.method().toUpperCase() !== 'POST') return route.fallback();

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, userId: 'user_123' })
      });
    });

    // Home loads additional protected data; mock to keep the journey deterministic.
    await page.route('**/api/test-runs', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([])
      });
    });
    await page.route('**/api/test-lists', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([])
      });
    });
    await page.route('**/api/profile', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({})
      });
    });

    await email.fill('user@example.com');
    await password.fill('correct-password');

    await Promise.all([
      page.waitForURL(/\/home(\?|$)/),
      submit.click()
    ]);

    // Page-load state assertions on /home
    await expect(page).toHaveURL(/\/home(\?|$)/);
    await expect(page.getByRole('heading').first()).toBeVisible();

    // Validate key interactions exist on dashboard (as described)
    const testLocally = page.getByTestId('test-locally-mcp').or(page.getByRole('button', { name: /test locally mcp/i }));
    const viewAll = page.getByTestId('view-all').or(page.getByRole('link', { name: /view all/i }));
    const upgrade = page.getByTestId('upgrade-pro').or(page.getByRole('button', { name: /upgrade to pro/i }));
    const newTestList = page.getByTestId('new-test-list').or(page.getByRole('link', { name: /new test list/i }));

    await expect(testLocally).toBeVisible();
    await expect(viewAll).toBeVisible();
    await expect(upgrade).toBeVisible();
    await expect(newTestList).toBeVisible();
  });

  test('API validation: missing fields returns 400 and surfaces error [CAT:form_validation]', async ({ page }) => {
    const { submit } = getLoginLocators(page);

    await page.route('**/api/auth/login', async (route) => {
      const request = route.request();
      if (request.method().toUpperCase() !== 'POST') return route.fallback();

      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, userId: '' })
      });
    });

    await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/auth/login') && r.status() === 400),
      submit.click()
    ]);

    await expectAuthErrorVisible(page);
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });
});