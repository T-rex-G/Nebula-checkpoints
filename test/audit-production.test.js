'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/*
 * The gate has three outcomes and npm's exit code carries only two, so the
 * distinction this asserts is the whole point of the script existing: an audit
 * that could not be obtained must fail the build AND must not be reported as a
 * vulnerability, and must never, under any transport failure, come back clean.
 *
 * The registry is stubbed rather than called. A test that needed the real
 * registry would be flaky for exactly the reason the script was written.
 */
const script = path.join(__dirname, '..', 'scripts', 'audit-production.js');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-audit-gate-'));
const binDir = path.join(workspace, 'bin');
fs.mkdirSync(binDir);
fs.writeFileSync(path.join(binDir, 'npm'), '#!/usr/bin/env bash\ncat "$NV_FAKE_AUDIT_JSON"\n');
fs.chmodSync(path.join(binDir, 'npm'), 0o755);

function runGate(payload) {
  const file = path.join(workspace, `${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, typeof payload === 'string' ? payload : JSON.stringify(payload));
  try {
    const stdout = execFileSync(process.execPath, [script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
        NV_FAKE_AUDIT_JSON: file,
        NV_AUDIT_ATTEMPTS: '2',
        NV_AUDIT_BACKOFF_MS: '1'
      }
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return { code: error.status, stdout: String(error.stdout || ''), stderr: String(error.stderr || '') };
  }
}

function counts(extra) {
  return { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0, ...extra };
}

/* A tree with nothing at or above high passes, and still names what it found. */
{
  const result = runGate({ vulnerabilities: {}, metadata: { vulnerabilities: counts({ moderate: 3, total: 3 }) } });
  assert.equal(result.code, 0, 'a tree with no high or critical advisories must pass');
  assert.match(result.stdout, /no high or critical advisories/);
  assert.match(result.stdout, /3 moderate/, 'the moderates it did find must still be reported');
}

/* High and critical fail, and are named rather than merely counted. */
for (const severity of ['high', 'critical']) {
  const result = runGate({
    vulnerabilities: { 'some-package': { name: 'some-package', severity } },
    metadata: { vulnerabilities: counts({ [severity]: 1, total: 1 }) }
  });
  assert.equal(result.code, 1, `a ${severity} advisory must fail the build`);
  assert.match(result.stderr, /audit FAILED/);
  assert.match(result.stderr, /some-package/, 'the failing package must be named');
}

/*
 * The failure the script was written for. npm answers with an error envelope
 * and empty summary/detail; the reason lives in `message`, which is the line
 * that says which endpoint refused.
 */
{
  const result = runGate({
    message: 'request to https://registry.npmjs.org/-/npm/v1/security/audits/quick failed, reason: socket hang up',
    error: { summary: '', detail: '' }
  });
  assert.equal(result.code, 1, 'an unreachable registry must fail the build');
  assert.match(result.stderr, /UNAVAILABLE/);
  assert.match(result.stderr, /not because a vulnerability was found/,
    'an outage must not be reported as a security finding');
  assert.match(result.stderr, /security\/audits\/quick/,
    'the endpoint that refused must survive into the message');
  assert.doesNotMatch(result.stderr, /unspecified/,
    'npm puts the reason in message; reading summary first threw it away');
}

/* Output that is not JSON at all is an unknown, not a clean tree. */
{
  const result = runGate('<html>502 Bad Gateway</html>');
  assert.equal(result.code, 1, 'a non-JSON response must fail the build');
  assert.match(result.stderr, /UNAVAILABLE/);
}

/*
 * The one that matters most. A report with no metadata is missing the counts,
 * and an absent count must never be read as a zero count -- that is precisely
 * how a broken audit would come back green.
 */
{
  const result = runGate({ vulnerabilities: {} });
  assert.equal(result.code, 1, 'a report with no vulnerability counts must not pass');
  assert.match(result.stderr, /UNAVAILABLE/);
}

fs.rmSync(workspace, { recursive: true, force: true });
process.stdout.write('production audit gate tests passed\n');
