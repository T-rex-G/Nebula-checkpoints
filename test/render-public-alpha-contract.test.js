'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const render = fs.readFileSync(path.join(__dirname, '..', 'render.yaml'), 'utf8');
const envExample = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
const deploymentGuide = fs.readFileSync(path.join(__dirname, '..', 'docs', 'operations', 'DEPLOY_RENDER_NEON.md'), 'utf8');

function yamlEnvironmentEntry(source, key) {
  assert.match(key, /^[A-Z][A-Z0-9_]*$/, `invalid environment key fixture: ${key}`);
  const lines = source.split(/\r?\n/);
  let start = -1;
  let indentation = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)-\s+key:\s*([A-Z][A-Z0-9_]*)\s*$/.exec(lines[index]);
    if (match && match[2] === key) {
      start = index;
      indentation = match[1].length;
      break;
    }
  }
  assert(start >= 0, `${key} is missing`);
  let end = start + 1;
  while (end < lines.length) {
    if (lines[end].trim()) {
      const nextIndentation = /^(\s*)/.exec(lines[end])[1].length;
      if (nextIndentation <= indentation) break;
    }
    end += 1;
  }
  return lines.slice(start, end).join('\n');
}

const boundedEntryFixture = [
  'envVars:',
  '  - key: FIRST_SECRET',
  '    generateValue: true',
  'nextSection:',
  '  - key: SHADOW_SECRET',
  '    value: must-not-be-included'
].join('\n');
assert(!yamlEnvironmentEntry(boundedEntryFixture, 'FIRST_SECRET').includes('SHADOW_SECRET'));
assert.throws(() => yamlEnvironmentEntry(boundedEntryFixture, 'MISSING_SECRET'), /is missing/);

assert.strictEqual((render.match(/^\s*- type:\s*web\s*$/gm) || []).length, 1);
assert.match(render, /name:\s*nebulaverse-x-public-alpha/);
assert.match(render, /plan:\s*free/);
assert.match(render, /buildCommand:\s*npm ci --omit=dev\s*$/m);
assert.match(render, /startCommand:\s*npm start/);
assert.match(render, /healthCheckPath:\s*\/healthz/);
assert(!/^databases:/m.test(render));
assert(!/^\s+disk:/m.test(render));

const exactValues = {
  NV_DEPLOYMENT_PROFILE: 'hosted-alpha',
  NV_ALPHA_ACCESS_MODE: 'invite',
  NV_DATABASE_MIGRATION_MODE: 'verify',
  NV_EVENT_RETENTION_DAYS: '30',
  NV_SESSION_RETENTION_DAYS: '7',
  NV_LIVE_CLIENTS_PER_REPO: '2',
  NV_LIVE_CLIENTS_TOTAL: '10',
  NV_SNAPSHOT_RETENTION_COUNT: '10',
  NV_SNAPSHOT_MANIFEST_MAX: '5000',
  NV_SNAPSHOT_SIGNING_KEY_ID: 'alpha17-snapshot-2026-08',
  NV_GIT_DATA_MAX_MB: '16',
  NV_NATIVE_PUSH_MAX_MB: '16',
  NV_UPLOAD_MAX_MB: '25',
  NV_UPLOAD_CONCURRENCY: '1',
  NV_UPLOAD_TIMEOUT_MINUTES: '10',
  NV_STALE_UPLOAD_HOURS: '2',
  NV_MAINTENANCE_MODE: '0'
};

for (const generatedSecret of ['SESSION_SECRET', 'NV_SNAPSHOT_SIGNING_SECRET']) {
  const block = yamlEnvironmentEntry(render, generatedSecret);
  assert(block.includes('generateValue: true'), `${generatedSecret} must be generated independently`);
  assert(!block.includes('value:'), `${generatedSecret} must not have a blueprint value`);
}
for (const [key, value] of Object.entries(exactValues)) {
  const block = render.match(new RegExp(`- key: ${key}\\n\\s+value: ([^\\n]+)`));
  assert(block, `render.yaml missing ${key}`);
  assert.strictEqual(block[1].trim(), value, `${key} has the wrong hosted value`);
}

for (const secret of [
  'DATABASE_URL',
  'NV_ALPHA_INVITE_PEPPER',
  'NV_GOVERNANCE_AUDIT_SECRET'
]) {
  const block = yamlEnvironmentEntry(render, secret);
  assert(block.includes('sync: false'), `${secret} must be entered manually`);
  assert(!block.includes('value:'), `${secret} must not have a blueprint value`);
}

const envExampleLines = envExample.split(/\r?\n/);
for (const [key, value] of Object.entries({
  ...exactValues,
  NV_ALPHA_ACCESS_MODE: 'off',
  NV_DATABASE_MIGRATION_MODE: 'apply',
  NV_SNAPSHOT_SIGNING_KEY_ID: ''
})) {
  /*
   * Match the whole line. A substring check cannot express an empty value:
   * `NV_SNAPSHOT_SIGNING_KEY_ID=` is a prefix of every non-empty setting of the
   * same key, so the one entry that must ship blank is the one the assertion
   * could not have caught.
   */
  assert(
    envExampleLines.includes(`${key}=${value}`),
    `.env.example missing ${key}=${value}`
  );
}
for (const key of [
  'NV_BACKUP_KEY_BASE64',
  'NV_RESTORE_DATABASE_URL',
  'PGSSLROOTCERT',
  'NEON_API_KEY',
  'NV_COHORT_NEON_PROJECT_ID',
  'NV_COHORT_NEON_BRANCH_ID',
  'NV_RESTORE_NEON_PROJECT_ID',
  'NV_RESTORE_NEON_BRANCH_ID',
  'NV_RESTORE_TARGET_FINGERPRINT',
  'NV_SNAPSHOT_SIGNING_SECRET',
  'NV_SNAPSHOT_RETIRED_KEYS_JSON',
  'NV_SNAPSHOT_LEGACY_KEYS_JSON'
]) {
  assert(envExample.includes(`${key}=`), `.env.example missing ${key}`);
}
assert(!render.includes('NEON_API_KEY'), 'the operator-only Neon API key must never enter Render');
for (const requirement of [
  'NV_ALPHA_ACCESS_MODE=invite',
  'NV_ALPHA_INVITE_PEPPER=<independent random value of at least 32 UTF-8 bytes>',
  'NV_ALPHA_TERMS_VERSION=2026-07-29',
  'NV_UPLOAD_TIMEOUT_MINUTES=10',
  'NV_STALE_UPLOAD_HOURS=2',
  'Before opening the cohort, verify the deployed environment still reports'
]) {
  assert(deploymentGuide.includes(requirement), `deployment guide missing invite boundary: ${requirement}`);
}

console.log('Render public alpha contract tests passed');
