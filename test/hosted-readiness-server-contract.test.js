'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const sessionSecret = ['hosted-startup-test', '0123456789abcdef'].join('-');
const rejected = spawnSync(process.execPath, ['server.js'], {
  cwd: root,
  encoding: 'utf8',
  timeout: 5000,
  env: {
    ...process.env,
    NODE_ENV: 'production',
    NV_DEPLOYMENT_PROFILE: 'hosted-alpha',
    NV_DATABASE_MIGRATION_MODE: 'apply',
    NV_ALPHA_ACCESS_MODE: 'off',
    SESSION_SECRET: sessionSecret,
    DATABASE_URL: '',
    PORT: '28992'
  }
});
assert.strictEqual(rejected.error, undefined, 'hosted apply mode must fail before the timeout');
assert.notStrictEqual(rejected.status, 0);
assert.match(`${rejected.stdout}\n${rejected.stderr}`, /hosted-alpha.*verify|verify.*hosted-alpha/i);

console.log('hosted readiness server contract tests passed');
