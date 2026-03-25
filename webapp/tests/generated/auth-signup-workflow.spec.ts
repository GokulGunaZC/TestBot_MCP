import { test, expect } from './__testbot-fixture';

const BASE_URL = 'http://localhost:3001';

test.describe('[CAT:workflow_journey] User signup workflow', () => {
  test.afterEach(async ({ page }) => {
    // Cleanup: attempt to log out in case signup also logs the user in.
    await page.request.post(`${BASE_URL}/api/auth/logout`).catch(() => undefined);
  });

  test('error path: password mismatch shows validation error and does not complete signup [REQ:user-signup]', async ({ page }) => {
    // Step 1: Navigate to signup
    await page.goto(`${BASE_URL}/signup`);
    await expect(page).toHaveURL(/\/signup(?:\?.*)?$/);

    // Step 2: Fill fields with mismatched passwords
    const fullName = page.getByLabel(/full name|name/i).or(page.getByPlaceholder(/full name|name/i));
    const email = page.getByLabel(/email/i).or(page.getByPlaceholder(/email/i));
    const password = page.getByLabel(/^password$/i).or(page.getByPlaceholder(/^password$/i));
    const confirmPassword = page.getByLabel(/confirm password/i).or(page.getByPlaceholder(/confirm password/i));

    await fullName.fill('E2E Signup User');
    await email.fill('e2e.signup.user@example.com');
    await password.fill('Password123!');
    await confirmPassword.fill('Password123!!');

    // Step 3: Submit
    const submit = page.getByRole('button', { name: /sign up|create account|submit/i });
    await expect(submit).toBeEnabled();
    await submit.click();

    // Step 4: Assert we are still on signup and error is displayed
    await expect(page).toHaveURL(/\/signup(?:\?.*)?$/);
    const error = page.getByRole('alert').or(page.getByText(/passwords? (do not|don't) match|mismatch/i));
    await expect(error).toBeVisible();
  });

  test('error path: password under 8 characters shows validation error [REQ:user-signup]', async ({ page }) => {
    // Step 1: Navigate to signup
    await page.goto(`${BASE_URL}/signup`);
    await expect(page).toHaveURL(/\/signup(?:\?.*)?$/);

    // Step 2: Fill fields with too-short password
    const fullName = page.getByLabel(/full name|name/i).or(page.getByPlaceholder(/full name|name/i));
    const email = page.getByLabel(/email/i).or(page.getByPlaceholder(/email/i));
    const password = page.getByLabel(/^password$/i).or(page.getByPlaceholder(/^password$/i));
    const confirmPassword = page.getByLabel(/confirm password/i).or(page.getByPlaceholder(/confirm password/i));

    await fullName.fill('E2E Short Password');
    await email.fill('e2e.shortpw@example.com');
    await password.fill('short7');
    await confirmPassword.fill('short7');

    // Step 3: Submit
    const submit = page.getByRole('button', { name: /sign up|create account|submit/i });
    await submit.click();

    // Step 4: Assertions
    await expect(page).toHaveURL(/\/signup(?:\?.*)?$/);
    const error = page.getByRole('alert').or(page.getByText(/8\s*chars|at least\s*8|minimum\s*8/i));
    await expect(error).toBeVisible();
  });

  test('@phase2 deep path: signup -> success -> navigate to /home and verify session works on protected page [REQ:user-signup]', async ({ page }) => {
    // NOTE: This deep-path test attempts a full signup. If the backend rejects duplicate emails,
    // the test may require a test environment seeded to accept this deterministic account.

    // Step 1: Go to signup
    await page.goto(`${BASE_URL}/signup`);
    await expect(page).toHaveURL(/\/signup(?:\?.*)?$/);

    // Step 2: Fill valid fields
    const fullName = page.getByLabel(/full name|name/i).or(page.getByPlaceholder(/full name|name/i));
    const email = page.getByLabel(/email/i).or(page.getByPlaceholder(/email/i));
    const password = page.getByLabel(/^password$/i).or(page.getByPlaceholder(/^password$/i));
    const confirmPassword = page.getByLabel(/confirm password/i).or(page.getByPlaceholder(/confirm password/i));

    await fullName.fill('E2E Phase2 User');
    await email.fill('e2e.phase2.user@example.com');
    await password.fill('LongEnoughPassword!');
    await confirmPassword.fill('LongEnoughPassword!');

    // Step 3: Submit and verify a success state (either route changes or a success indicator)
    const submit = page.getByRole('button', { name: /sign up|create account|submit/i });

    await submit.click();

    // Step 4: Determine success by either redirecting to /home OR showing a success message.
    // We assert deterministically that we do NOT remain stuck with validation errors.
    const anyAlert = page.getByRole('alert');
    await expect(anyAlert).not.toContainText(/passwords? (do not|don't) match|mismatch|minimum|at least\s*8/i);

    // Step 5: Navigate to /home to ensure session allows access
    await page.goto(`${BASE_URL}/home`);
    await expect(page).toHaveURL(/\/home(?:\?.*)?$/);

    // End-state: dashboard element visible
    await expect(
      page.getByRole('button', { name: /test locally mcp/i }).or(page.getByRole('link', { name: /view all/i }))
    ).toBeVisible();

    // Additional persistence: /api-keys should be reachable when authenticated
    await page.goto(`${BASE_URL}/api-keys`);
    await expect(page).toHaveURL(/\/api-keys(?:\?.*)?$/);
  });
});