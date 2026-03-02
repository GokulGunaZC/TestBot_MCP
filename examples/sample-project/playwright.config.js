// @ts-check
const { defineConfig, devices } = require('@playwright/test');

/**
 * Playwright Configuration
 * Enhanced for maximum artifact capture with TestBot MCP integration
 */
module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  
  // Multiple reporters for comprehensive coverage
  reporter: [
    ['list'],  // Console output
    ['json', { outputFile: 'test-results.json' }],  // For TestBot dashboard integration
    ['html', { outputFolder: 'playwright-report', open: 'never' }],  // HTML report for detailed view
  ],
  
  use: {
    baseURL: 'http://localhost:3000',
    
    // Maximum artifact capture for comprehensive debugging
    // Traces capture every action, network request, and console log
    trace: 'on',              // Always capture traces (options: 'on', 'off', 'on-first-retry', 'retain-on-failure')
    
    // Screenshots help visualize test state at failure
    screenshot: 'on',         // Always capture screenshots (options: 'on', 'off', 'only-on-failure')
    
    // Video recording shows the complete test execution flow
    video: 'on',              // Always capture videos (options: 'on', 'off', 'on-first-retry', 'retain-on-failure')
    
    // Additional useful settings for artifact quality
    viewport: { width: 1280, height: 720 },
    
    // Capture console logs and network activity for debugging
    launchOptions: {
      slowMo: 50,  // Slight delay makes videos easier to follow
    },
  },

  projects: [
    {
      name: 'frontend',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    command: 'npm start',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
  
  // Output directory for test artifacts
  outputDir: 'test-results',
});
