'use strict';
const { defineConfig, devices } = require('@playwright/test');
const localChromium = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;
const launchOptions = localChromium ? {
  executablePath: localChromium,
  args: ['--no-sandbox', '--disable-dev-shm-usage']
} : undefined;
const playwrightSessionSecret = ['playwright', '0123456789abcdef', '0123456789abcdef'].join('-');
const playwrightSnapshotSecret = ['playwright-snapshot', 'fedcba9876543210', 'fedcba9876543210'].join('-');
/*
 * CI runs the suite as parallel jobs, each naming its slice (NV_E2E_SHARD=2/4).
 * Unset, the whole suite runs, which is what a local run wants. A malformed
 * value stops the run: a slice that silently became the whole suite, or none
 * of it, would report a pass for tests that never ran.
 */
function shardFrom(value) {
  if (!value) return null;
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(value);
  if (!match || Number(match[1]) > Number(match[2])) {
    throw new Error(`NV_E2E_SHARD must read current/total, such as 2/4; got ${JSON.stringify(value)}`);
  }
  return { current: Number(match[1]), total: Number(match[2]) };
}

module.exports = defineConfig({
  testDir: './test/e2e',
  fullyParallel: false,
  workers: 1,
  shard: shardFrom(process.env.NV_E2E_SHARD),
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
    command: `PORT=21852 NODE_ENV=production SESSION_SECRET=${playwrightSessionSecret} NV_SNAPSHOT_SIGNING_KEY_ID=playwright-snapshot-key NV_SNAPSHOT_SIGNING_SECRET=${playwrightSnapshotSecret} DATABASE_URL= node server.js`,
    url: 'http://127.0.0.1:21852/healthz',
    timeout: 30000,
    reuseExistingServer: false
  }
});
