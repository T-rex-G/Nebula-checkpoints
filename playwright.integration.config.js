'use strict';

const { defineConfig, devices } = require('@playwright/test');

// A small, separate gate: actual application routes and PostgreSQL, with only
// the upstream provider replaced by a disposable HTTP service. Missing
// PostgreSQL or either browser is a failure, never a successful skipped gate.
module.exports = defineConfig({
  testDir: './test/integration',
  testMatch: '**/*.spec.js',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90000,
  expect: { timeout: 10000 },
  outputDir: 'test-results/integration',
  reporter: [['list'], ['json', { outputFile: 'test-results/integration/results.json' }]],
  use: {
    actionTimeout: 15000,
    navigationTimeout: 20000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    serviceWorkers: 'allow'
  },
  projects: [
    { name: 'integration-chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'integration-webkit', use: { ...devices['Desktop Safari'] } }
  ]
});
