/**
 * Playwright Configuration for KYT Extension Testing
 * 
 * Configures Playwright to test the Chrome extension with proper timeouts
 * and settings for extension loading.
 */

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './validation',
  testMatch: '**/*.spec.js',
  
  // Timeout settings
  timeout: 60000, // 60 seconds per test
  expect: {
    timeout: 10000 // 10 seconds for expect assertions
  },

  // Reporter settings
  reporter: [
    ['list'],
    ['html', { outputFolder: 'validation/playwright-report' }]
  ],

  // Run tests in serial (extensions don't work well with parallel)
  fullyParallel: false,
  workers: 1,

  // Retry failed tests once
  retries: 1,

  use: {
    // Base settings
    headless: false, // Extensions require headed mode
    viewport: { width: 1280, height: 720 },
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'on-first-retry',

    // Browser launch options
    launchOptions: {
      slowMo: 100 // Slow down operations for better stability
    }
  },

  // Projects
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        channel: 'chrome' // Use actual Chrome (not Chromium)
      }
    }
  ]
});
