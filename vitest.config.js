import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.js'],
    // Exclude Playwright E2E tests and standalone scripts (run separately)
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'tests/playwright/**',  // Standalone Playwright scripts
      'tests/e2e/**',         // E2E tests requiring browser
      'validation/**'         // Validation E2E tests
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'json-summary'],
      exclude: [
        'node_modules/',
        'tests/',
        'validation/',
        'cli/',
        '*.config.js',
        'scripts/',
        '*.sql',
        'build/',
        'platforms/'
      ],
      // Coverage thresholds - fail if coverage drops below these
      // Start conservative, increase as you add tests
      thresholds: {
        lines: 20,
        functions: 20,
        branches: 20,
        statements: 20
      }
    }
  }
});
