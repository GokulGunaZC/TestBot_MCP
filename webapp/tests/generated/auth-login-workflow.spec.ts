import { test, expect } from './__testbot-fixture';

const BASE_URL = 'http://localhost:3001';

test.describe('[CAT:workflow_journey] User login workflow', () => {
  test.afterEach(async ({ page }) => {
    // Cleanup: attempt to log out if a session exists.
    // We do not assert on logout because this is best-effort cleanup.
    await page.request.post(`${BASE_URL}/api/auth/logout`).catch(() => undefined);
  });

  test('happy path: login redirects to /home and persists across navigation [REQ:user-login]', async ({ page }) => {
    // Step 1: Navigate to login
    await page.goto(`${BASE_URL}/login`);
    await expect(page).toHaveURL(/\/login(?:\?.*)?$/);

    // Step 2: Fill email + password using accessible selectors
    const email = page.getByLabel(/email/i).or(page.getByPlaceholder(/email/i));
    const password = page.getByLabel(/password/i).or(page.getByPlaceholder(/password/i));

    await expect(email).toBeVisible();
    await expect(password).toBeVisible();

    await email.fill('e2e.user@example.com');
    await password.fill('CorrectHorseBatteryStaple!');

    // Step 3: Submit
    const submit = page.getByRole('button', { name: /log in|sign in|submit/i });
    await expect(submit).toBeEnabled();

    // Step 4: Verify redirect to /home
    await Promise.all([
      page.waitForURL(/\/home(?:\?.*)?$/),
      submit.click()
    ]);
    await expect(page).toHaveURL(/\/home(?:\?.*)?$/);

    // End-state assertion: home content should be present (dashboard-like cues from context)
    // We keep this resilient: check for at least one known interaction element.
    const locallyButton = page.getByRole('button', { name: /test locally mcp/i });
    const viewAllLink = page.getByRole('link', { name: /view all/i });
    await expect(locallyButton.or(viewAllLink)).toBeVisible();

    // Persistence assertion: navigating to another protected page should not redirect back to login
    await page.goto(`${BASE_URL}/profile`);
    await expect(page).toHaveURL(/\/profile(?:\?.*)?$/);
  });

  test('error path: invalid credentials show an error and remain on /login [REQ:user-login]', async ({ page }) => {
    // Step 1: Navigate to login
    await page.goto(`${BASE_URL}/login`);
    await expect(page).toHaveURL(/\/login(?:\?.*)?$/);

    // Step 2: Fill invalid credentials
    const email = page.getByLabel(/email/i).or(page.getByPlaceholder(/email/i));
    const password = page.getByLabel(/password/i).or(page.getByPlaceholder(/password/i));

    await email.fill('nonexistent.user@example.com');
    await password.fill('wrong-password');

    // Step 3: Submit and expect to remain on login
    const submit = page.getByRole('button', { name: /log in|sign in|submit/i });
    await submit.click();

    // Step 4: Deterministic assertions
    // - should remain on /login
    await expect(page).toHaveURL(/\/login(?:\?.*)?$/);

    // - should show an error message (use common accessible alerts)
    const alert = page.getByRole('alert').or(page.getByText(/invalid|incorrect|unauthorized|wrong credentials/i));
    await expect(alert).toBeVisible();
  });
});