import { test, expect } from '../__testbot-fixture';
import type { Page } from '@playwright/test';

const BASE_URL = 'http://localhost:3000';

function getSignupLocators(page: Page) {
  const fullName = page.getByTestId('full-name').or(
    page.getByLabel(/full name|name/i).or(page.getByPlaceholder(/full name|name/i))
  );
  const email = page.getByTestId('email').or(
    page.getByRole('textbox', { name: /email/i }).or(
      page.getByLabel(/email/i).or(page.getByPlaceholder(/email/i))
    )
  );
  const password = page.getByTestId('password').or(
    page.getByLabel(/^password$/i).or(page.getByPlaceholder(/^password$/i))
  );
  const confirmPassword = page.getByTestId('confirm-password').or(
    page.getByLabel(/confirm password/i).or(page.getByPlaceholder(/confirm password/i))
  );

  const submit = page.getByTestId('signup-submit').or(
    page.getByRole('button', { name: /sign\s*up|create\s*account|register/i })
  );

  const loginLink = page.getByTestId('login-link').or(
    page.getByRole('link', { name: /log\s*in|sign\s*in/i }).or(page.getByText(/log\s*in|sign\s*in/i))
  );

  return { fullName, email, password, confirmPassword, submit, loginLink };
}

async function expectFormErrorVisible(page: Page) {
  // Use .first() to avoid strict-mode violation when route announcer + error text both match
  const alert = page.getByRole('alert').filter({ hasNotText: /^$/ });
  const errorText = page.getByText(/mismatch|match|at least|minimum|characters|required|invalid|error/i);
  await expect(alert.or(errorText).first()).toBeVisible();
}

test.describe('Auth - Signup [CAT:workflow_journey]', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${BASE_URL}/signup`, { waitUntil: 'domcontentloaded' });
  });

  test('loads signup page with fields and login link [CAT:ui_flow]', async ({ page }) => {
    await expect(page).toHaveURL(/\/signup(\?|$)/);

    // Accessibility smoke: ensure there is a heading
    await expect(page.getByRole('heading').first()).toBeVisible();

    const { fullName, email, password, confirmPassword, submit, loginLink } = getSignupLocators(page);

    await expect(fullName).toBeVisible();
    await expect(email).toBeVisible();
    await expect(password).toBeVisible();
    await expect(confirmPassword).toBeVisible();

    await expect(submit).toBeVisible();
    await expect(submit).toBeEnabled();

    await expect(loginLink).toBeVisible();
    await expect(loginLink).toHaveAttribute('href', /login/);
  });

  test('navigates back to login via link [CAT:ui_flow]', async ({ page }) => {
    const { loginLink } = getSignupLocators(page);

    await loginLink.click();
    await page.waitForURL(/\/login(\?|$)/, { timeout: 10000 });

    await expect(page.getByRole('heading').first()).toBeVisible();
  });

  test('shows validation error when passwords mismatch [CAT:form_validation] [REQ:User signup]', async ({ page }) => {
    const { fullName, email, password, confirmPassword, submit } = getSignupLocators(page);

    // Route mock can be either client-side validated or server-side.
    // We still mock API to return 400 to cover server validation.
    await page.route('**/api/auth/signup', async (route) => {
      const request = route.request();
      if (request.method().toUpperCase() !== 'POST') return route.fallback();

      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, userId: '' })
      });
    });

    await fullName.fill('Test User');
    await email.fill('test.user@example.com');
    await password.fill('password123');
    await confirmPassword.fill('password124');

    // If the app blocks submit client-side, the response wait may not happen;
    // therefore we click and assert visible error state.
    await submit.click();
    await expectFormErrorVisible(page);
    await expect(page).toHaveURL(/\/signup(\?|$)/);
  });

  test('shows validation error when password is under 8 chars [CAT:form_validation] [REQ:User signup]', async ({ page }) => {
    const { fullName, email, password, confirmPassword, submit } = getSignupLocators(page);

    await page.route('**/api/auth/signup', async (route) => {
      const request = route.request();
      if (request.method().toUpperCase() !== 'POST') return route.fallback();

      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, userId: '' })
      });
    });

    await fullName.fill('Test User');
    await email.fill('short.pass@example.com');
    await password.fill('short7');
    await confirmPassword.fill('short7');

    await submit.click();
    await expectFormErrorVisible(page);
    await expect(page).toHaveURL(/\/signup(\?|$)/);
  });

  test('successful signup shows success state or redirects [CAT:workflow_journey] [REQ:User signup]', async ({ page }) => {
    const { fullName, email, password, confirmPassword, submit } = getSignupLocators(page);

    await page.route('**/api/auth/signup', async (route) => {
      const request = route.request();
      if (request.method().toUpperCase() !== 'POST') return route.fallback();

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, userId: 'user_456' })
      });
    });

    await fullName.fill('New User');
    await email.fill('new.user@example.com');
    await password.fill('password123');
    await confirmPassword.fill('password123');

    await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/auth/signup') && r.status() === 200),
      submit.click()
    ]);

    // After success the component shows the success heading in place of the form.
    const successHeading = page.getByText('Account created successfully!');
    const successAlt = page.getByText(/success|welcome|verify/i).first();
    await expect(successHeading.or(successAlt)).toBeVisible({ timeout: 8000 });
  });
});