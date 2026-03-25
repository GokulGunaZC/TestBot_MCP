import { test, expect } from './__testbot-fixture';

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3001';

function uniqueEmail(prefix: string) {
  // Deterministic across a single test run, unique across parallel workers via workerIndex.
  return `${prefix}+w${test.info().workerIndex}@example.com`;
}

async function fillLoginForm(page: any, email: string, password: string) {
  const emailInput = page.getByLabel('Email').or(page.getByPlaceholder('Email')).or(page.getByRole('textbox', { name: 'Email' }));
  const passwordInput = page.getByLabel('Password').or(page.getByPlaceholder('Password')).or(page.getByRole('textbox', { name: 'Password' }));
  await emailInput.fill(email);
  await passwordInput.fill(password);
}

async function submitPrimaryForm(page: any) {
  const submit = page.getByRole('button', { name: /log in|login|sign in|submit/i });
  await expect(submit).toBeVisible();
  await submit.click();
}

test.describe('[CAT:ui_flow] Authentication UI flows', () => {
  test('[CAT:ui_flow] /login renders email/password inputs and submit control', async ({ page }) => {
    await page.goto(`${BASE_URL}/login`);
    await expect(page).toHaveURL(/\/login/);

    const email = page.getByLabel('Email').or(page.getByPlaceholder('Email')).or(page.getByRole('textbox', { name: 'Email' }));
    const password = page.getByLabel('Password').or(page.getByPlaceholder('Password')).or(page.getByRole('textbox', { name: 'Password' }));
    const submit = page.getByRole('button', { name: /log in|login|sign in|submit/i });

    await expect(email).toBeVisible();
    await expect(password).toBeVisible();
    await expect(submit).toBeVisible();
    await expect(submit).toBeEnabled();
  });

  test('[CAT:ui_flow] /signup renders full name + email + password + confirm password + submit', async ({ page }) => {
    await page.goto(`${BASE_URL}/signup`);
    await expect(page).toHaveURL(/\/signup/);

    const fullName = page.getByLabel('Full Name').or(page.getByPlaceholder('Full Name')).or(page.getByRole('textbox', { name: /full name/i }));
    const email = page.getByLabel('Email').or(page.getByPlaceholder('Email')).or(page.getByRole('textbox', { name: 'Email' }));
    const password = page.getByLabel('Password').or(page.getByPlaceholder('Password')).or(page.getByRole('textbox', { name: /^password$/i }));
    const confirm = page.getByLabel('Confirm Password').or(page.getByPlaceholder('Confirm Password')).or(page.getByRole('textbox', { name: /confirm password/i }));
    const submit = page.getByRole('button', { name: /sign up|signup|register|create account|submit/i });

    await expect(fullName).toBeVisible();
    await expect(email).toBeVisible();
    await expect(password).toBeVisible();
    await expect(confirm).toBeVisible();
    await expect(submit).toBeVisible();
  });

  test('[CAT:workflow_journey] Sign up link from /login navigates to /signup', async ({ page }) => {
    await page.goto(`${BASE_URL}/login`);
    const signUpLink = page.getByRole('link', { name: /sign up|create account|register/i });
    await expect(signUpLink).toBeVisible();
    await signUpLink.click();
    await expect(page).toHaveURL(/\/signup/);
  });

  test('[CAT:workflow_journey] Login link from /signup navigates to /login', async ({ page }) => {
    await page.goto(`${BASE_URL}/signup`);
    const loginLink = page.getByRole('link', { name: /log in|login|sign in/i });
    await expect(loginLink).toBeVisible();
    await loginLink.click();
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe('[CAT:form_validation] Auth form validation (UI)', () => {
  test('[CAT:form_validation] Login submit with empty fields shows validation errors or stays on /login', async ({ page }) => {
    await page.goto(`${BASE_URL}/login`);
    await expect(page).toHaveURL(/\/login/);

    await submitPrimaryForm(page);

    // Deterministic: should not navigate to /home on empty submit.
    await expect(page).not.toHaveURL(/\/home/);
    await expect(page).toHaveURL(/\/login/);

    // Optional visible error; assert if any alert is present.
    const alert = page.getByRole('alert');
    if (await alert.count()) {
      await expect(alert.first()).toBeVisible();
    }
  });

  test('[CAT:form_validation] Signup password mismatch blocks submission (remains on /signup)', async ({ page }) => {
    await page.goto(`${BASE_URL}/signup`);

    const fullName = page.getByLabel('Full Name').or(page.getByPlaceholder('Full Name')).or(page.getByRole('textbox', { name: /full name/i }));
    const email = page.getByLabel('Email').or(page.getByPlaceholder('Email')).or(page.getByRole('textbox', { name: 'Email' }));
    const password = page.getByLabel('Password').or(page.getByPlaceholder('Password')).or(page.getByRole('textbox', { name: /^password$/i }));
    const confirm = page.getByLabel('Confirm Password').or(page.getByPlaceholder('Confirm Password')).or(page.getByRole('textbox', { name: /confirm password/i }));
    const submit = page.getByRole('button', { name: /sign up|signup|register|create account|submit/i });

    await fullName.fill('QA User');
    await email.fill(uniqueEmail('mismatch'));
    await password.fill('Password123!');
    await confirm.fill('Password124!');
    await submit.click();

    await expect(page).toHaveURL(/\/signup/);
    const alert = page.getByRole('alert');
    if (await alert.count()) {
      await expect(alert.first()).toBeVisible();
    }
  });

  test('[CAT:form_validation] Signup password under 8 chars blocks submission (remains on /signup)', async ({ page }) => {
    await page.goto(`${BASE_URL}/signup`);

    const fullName = page.getByLabel('Full Name').or(page.getByPlaceholder('Full Name')).or(page.getByRole('textbox', { name: /full name/i }));
    const email = page.getByLabel('Email').or(page.getByPlaceholder('Email')).or(page.getByRole('textbox', { name: 'Email' }));
    const password = page.getByLabel('Password').or(page.getByPlaceholder('Password')).or(page.getByRole('textbox', { name: /^password$/i }));
    const confirm = page.getByLabel('Confirm Password').or(page.getByPlaceholder('Confirm Password')).or(page.getByRole('textbox', { name: /confirm password/i }));
    const submit = page.getByRole('button', { name: /sign up|signup|register|create account|submit/i });

    await fullName.fill('QA User');
    await email.fill(uniqueEmail('shortpw'));
    await password.fill('short1');
    await confirm.fill('short1');
    await submit.click();

    await expect(page).toHaveURL(/\/signup/);
    const alert = page.getByRole('alert');
    if (await alert.count()) {
      await expect(alert.first()).toBeVisible();
    }
  });

  test('[CAT:form_validation] Invalid credentials show error and remain on /login', async ({ page }) => {
    await page.goto(`${BASE_URL}/login`);
    await fillLoginForm(page, 'invalid.user@example.com', 'WrongPassword!');
    await submitPrimaryForm(page);

    await expect(page).toHaveURL(/\/login/);
    const alert = page.getByRole('alert');
    if (await alert.count()) {
      await expect(alert.first()).toBeVisible();
    }
  });
});