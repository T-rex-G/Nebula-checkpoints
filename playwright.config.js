'use strict';
const { defineConfig, devices } = require('@playwright/test');
const localChromium = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;
const launchOptions = localChromium ? {
  executablePath: localChromium,
  args: ['--no-sandbox', '--disable-dev-shm-usage']
} : undefined;

module.exports = defineConfig({
  testDir: './test/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  expect: { timeout: 7000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:21852',
    trace: 'retain-on-failure',
    serviceWorkers: 'allow',
    launchOptions
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], launchOptions } },
    { name: 'mobile', use: { ...devices['Pixel 5'], launchOptions } }
  ],
  webServer: {
    command: 'PORT=21852 NODE_ENV=production SESSION_SECRET=playwright-secret-0123456789abcdef-0123456789abcdef DATABASE_URL= node server.js',
    url: 'http://127.0.0.1:21852/healthz',
    timeout: 30000,
    reuseExistingServer: false
  }
});
