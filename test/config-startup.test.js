'use strict';
const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');

const {
  normalizeDatabaseUrl,
  normalizeGovernanceRuntimeFailureMode,
  loadGithubAppConfig,
  loadAlphaAccessConfig
} = require('../src/config');

assert.strictEqual(typeof normalizeDatabaseUrl, 'function');
assert.strictEqual(typeof normalizeGovernanceRuntimeFailureMode, 'function');
assert.strictEqual(typeof loadGithubAppConfig, 'function');
assert.strictEqual(typeof loadAlphaAccessConfig, 'function');
assert.strictEqual(normalizeGovernanceRuntimeFailureMode(''), 'warn');
assert.strictEqual(normalizeGovernanceRuntimeFailureMode('block'), 'block');
assert.throws(() => normalizeGovernanceRuntimeFailureMode('allow'), /warn or block/);
assert.strictEqual(normalizeDatabaseUrl(''), '');
assert.throws(() => normalizeDatabaseUrl('https://example.com/db'), /postgres/);
assert.throws(() => normalizeDatabaseUrl('not-a-url'), /valid PostgreSQL URL/);
assert.throws(() => normalizeDatabaseUrl('postgresql://u:p@example.com/db?sslmode=disable', { production: true }), /cannot disable TLS/);
const strictUrl = new URL(normalizeDatabaseUrl('postgresql://u:p@example.com/db?sslmode=require', { production: true }));
assert.strictEqual(strictUrl.searchParams.get('sslmode'), 'verify-full');

assert.deepStrictEqual(loadAlphaAccessConfig({}, { production: false, databaseUrl: '' }), {
  mode: 'off',
  enabled: false,
  pepper: '',
  termsVersion: '',
  inviteTtlMs: 7 * 24 * 60 * 60 * 1000,
  sessionAbsoluteTtlMs: 7 * 24 * 60 * 60 * 1000,
  sessionIdleTtlMs: 24 * 60 * 60 * 1000
});
assert.deepStrictEqual(loadAlphaAccessConfig({
  NV_ALPHA_ACCESS_MODE: 'off',
  NV_ALPHA_INVITE_PEPPER: 'must-not-survive-disabled-mode',
  NV_ALPHA_TERMS_VERSION: '2026-07-29'
}, { production: true, databaseUrl: '' }), {
  mode: 'off',
  enabled: false,
  pepper: '',
  termsVersion: '',
  inviteTtlMs: 7 * 24 * 60 * 60 * 1000,
  sessionAbsoluteTtlMs: 7 * 24 * 60 * 60 * 1000,
  sessionIdleTtlMs: 24 * 60 * 60 * 1000
});
assert.throws(
  () => loadAlphaAccessConfig({ NV_ALPHA_ACCESS_MODE: 'public' }, {
    production: true,
    databaseUrl: 'postgresql://u:p@example.com/db'
  }),
  /must be off or invite/
);
assert.throws(
  () => loadAlphaAccessConfig({ NV_ALPHA_ACCESS_MODE: 'invite' }, { production: true, databaseUrl: '' }),
  /requires PostgreSQL/
);
assert.throws(
  () => loadAlphaAccessConfig({
    NV_ALPHA_ACCESS_MODE: 'invite',
    NV_ALPHA_INVITE_PEPPER: 'short',
    NV_ALPHA_TERMS_VERSION: '2026-07-29'
  }, { production: true, databaseUrl: 'postgresql://u:p@example.com/db' }),
  /at least 32 bytes/
);
const belowPepperBoundary = `${'é'.repeat(15)}a`;
const atPepperBoundary = 'é'.repeat(16);
assert.strictEqual(Buffer.byteLength(belowPepperBoundary, 'utf8'), 31);
assert.strictEqual(Buffer.byteLength(atPepperBoundary, 'utf8'), 32);
assert.throws(
  () => loadAlphaAccessConfig({
    NV_ALPHA_ACCESS_MODE: 'invite',
    NV_ALPHA_INVITE_PEPPER: belowPepperBoundary,
    NV_ALPHA_TERMS_VERSION: '2026-07-29'
  }, { production: true, databaseUrl: 'postgresql://u:p@example.com/db' }),
  /at least 32 bytes/
);
assert.strictEqual(loadAlphaAccessConfig({
  NV_ALPHA_ACCESS_MODE: 'invite',
  NV_ALPHA_INVITE_PEPPER: atPepperBoundary,
  NV_ALPHA_TERMS_VERSION: '2026-07-29'
}, { production: true, databaseUrl: 'postgresql://u:p@example.com/db' }).pepper, atPepperBoundary);

for (const invalidTermsVersion of [
  '',
  '2026-7-29',
  '2026-07-29.0',
  '2026-07-29.01',
  '2026-07-29-beta'
]) {
  assert.throws(
    () => loadAlphaAccessConfig({
      NV_ALPHA_ACCESS_MODE: 'invite',
      NV_ALPHA_INVITE_PEPPER: '0123456789abcdef0123456789abcdef',
      NV_ALPHA_TERMS_VERSION: invalidTermsVersion
    }, { production: true, databaseUrl: 'postgresql://u:p@example.com/db' }),
    /versioned YYYY-MM-DD value/
  );
}
const revisionedTermsConfig = loadAlphaAccessConfig({
  NV_ALPHA_ACCESS_MODE: 'invite',
  NV_ALPHA_INVITE_PEPPER: '0123456789abcdef0123456789abcdef',
  NV_ALPHA_TERMS_VERSION: '2026-07-29.2'
}, { production: true, databaseUrl: 'postgresql://u:p@example.com/db' });
assert.strictEqual(revisionedTermsConfig.termsVersion, '2026-07-29.2');

const alphaConfig = loadAlphaAccessConfig({
  NV_ALPHA_ACCESS_MODE: 'invite',
  NV_ALPHA_INVITE_PEPPER: '0123456789abcdef0123456789abcdef',
  NV_ALPHA_TERMS_VERSION: '2026-07-29'
}, { production: true, databaseUrl: 'postgresql://u:p@example.com/db' });
assert.strictEqual(alphaConfig.enabled, true);
assert.strictEqual(alphaConfig.inviteTtlMs, 7 * 24 * 60 * 60 * 1000);
assert.strictEqual(alphaConfig.sessionAbsoluteTtlMs, 7 * 24 * 60 * 60 * 1000);
assert.strictEqual(alphaConfig.sessionIdleTtlMs, 24 * 60 * 60 * 1000);
assert.strictEqual(Object.isFrozen(alphaConfig), true);

const child = spawn(process.execPath, ['server.js'], {
  cwd: path.resolve(__dirname, '..'),
  env: { ...process.env, NODE_ENV: 'production', SESSION_SECRET: 'short', DATABASE_URL: '', PORT: '28991' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let output = '';
child.stdout.on('data', c => { output += c.toString(); });
child.stderr.on('data', c => { output += c.toString(); });
const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
child.on('exit', code => {
  clearTimeout(timer);
  try {
    assert.notStrictEqual(code, 0);
    assert.match(output, /at least 32 bytes/);
    console.log('production configuration tests passed');
  } catch (error) {
    console.error(error.stack || error);
    process.exitCode = 1;
  }
});
