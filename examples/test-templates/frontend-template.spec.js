// @ts-check
const { test, expect } = require('@playwright/test');

/**
 * Frontend Test Template
 * 
 * This template demonstrates common patterns for frontend testing
 * with Playwright. Use this as a starting point for your tests.
 */

test.describe('Page Tests', () => {
  
  // Run before each test
  test.beforeEach(async ({ page }) => {
    // Navigate to the page before each test
    await page.goto('/');
  });

  test('should load the page successfully', async ({ page }) => {
    // Verify page title
    await expect(page).toHaveTitle(/.*/);
    
    // Verify page is visible
    await expect(page.locator('body')).toBeVisible();
  });

  test('should display navigation elements', async ({ page }) => {
    // Find navigation container
    const nav = page.locator('nav, [role="navigation"], .nav, .navbar');
    
    // Verify navigation exists
    await expect(nav).toBeVisible();
    
    // Verify navigation has links
    const links = nav.locator('a');
    await expect(links).toHaveCountGreaterThan(0);
  });

  test('should have working navigation links', async ({ page }) => {
    // Get all navigation links
    const links = page.locator('nav a');
    const count = await links.count();
    
    // Click each link and verify it navigates
    for (let i = 0; i < Math.min(count, 5); i++) {
      const link = links.nth(i);
      const href = await link.getAttribute('href');
      
      if (href && !href.startsWith('http')) {
        await link.click();
        // Verify URL changed
        await expect(page).not.toHaveURL('/');
        // Go back
        await page.goBack();
      }
    }
  });

});

test.describe('Form Tests', () => {

  test('should validate required fields', async ({ page }) => {
    // Find form
    const form = page.locator('form');
    
    if (await form.count() > 0) {
      // Try to submit empty form
      await form.locator('button[type="submit"]').click();
      
      // Check for validation errors
      const requiredInputs = form.locator('input[required]');
      const count = await requiredInputs.count();
      
      if (count > 0) {
        // Browser should show validation
        const firstInput = requiredInputs.first();
        const isInvalid = await firstInput.evaluate(el => !el.validity.valid);
        expect(isInvalid).toBeTruthy();
      }
    }
  });

  test('should submit form with valid data', async ({ page }) => {
    // Find form
    const form = page.locator('form');
    
    if (await form.count() > 0) {
      // Fill required fields
      const textInputs = form.locator('input[type="text"]');
      const emailInputs = form.locator('input[type="email"]');
      const textareas = form.locator('textarea');
      
      for (let i = 0; i < await textInputs.count(); i++) {
        await textInputs.nth(i).fill('Test Value');
      }
      
      for (let i = 0; i < await emailInputs.count(); i++) {
        await emailInputs.nth(i).fill('test@example.com');
      }
      
      for (let i = 0; i < await textareas.count(); i++) {
        await textareas.nth(i).fill('Test message content');
      }
      
      // Submit form
      await form.locator('button[type="submit"]').click();
      
      // Verify submission (check for success message or redirect)
      // Note: Adjust based on your app's behavior
    }
  });

});

test.describe('Responsive Design', () => {

  test('should display correctly on mobile', async ({ page }) => {
    // Set mobile viewport
    await page.setViewportSize({ width: 375, height: 667 });
    
    await page.goto('/');
    
    // Verify content is visible
    await expect(page.locator('body')).toBeVisible();
    
    // Check for horizontal scroll (should not exist)
    const scrollWidth = await page.evaluate(() => document.body.scrollWidth);
    const clientWidth = await page.evaluate(() => document.body.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 5); // Small tolerance
  });

  test('should display correctly on tablet', async ({ page }) => {
    // Set tablet viewport
    await page.setViewportSize({ width: 768, height: 1024 });
    
    await page.goto('/');
    
    // Verify content is visible
    await expect(page.locator('body')).toBeVisible();
  });

  test('should display correctly on desktop', async ({ page }) => {
    // Set desktop viewport
    await page.setViewportSize({ width: 1280, height: 800 });
    
    await page.goto('/');
    
    // Verify content is visible
    await expect(page.locator('body')).toBeVisible();
  });

});
