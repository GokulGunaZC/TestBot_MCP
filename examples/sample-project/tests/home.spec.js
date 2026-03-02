// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('Home Page', () => {
  test('should load the home page successfully', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/Sample App/);
    await expect(page.locator('body')).toBeVisible();
  });

  test('should display navigation elements', async ({ page }) => {
    await page.goto('/');
    const nav = page.locator('nav');
    await expect(nav).toBeVisible();
    
    const links = nav.locator('a');
    const count = await links.count();
    expect(count).toBeGreaterThan(0);
  });

  test('should navigate to users page', async ({ page }) => {
    await page.goto('/');
    await page.click('a[href="/users"]');
    await expect(page).toHaveURL(/.*\/users/);
    await expect(page.locator('h1')).toContainText('Users');
  });

  test('should navigate to about page', async ({ page }) => {
    await page.goto('/');
    await page.click('a[href="/about"]');
    await expect(page).toHaveURL(/.*\/about/);
    await expect(page.locator('h1')).toContainText('About');
  });

  test('should navigate to contact page', async ({ page }) => {
    await page.goto('/');
    await page.click('a[href="/contact"]');
    await expect(page).toHaveURL(/.*\/contact/);
    await expect(page.locator('h1')).toContainText('Contact');
  });
});
