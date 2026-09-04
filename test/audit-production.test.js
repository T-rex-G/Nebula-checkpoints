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
fs.writeFileSync(path.join(binDir, 'npm'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$NV_FAKE_AUDIT_ARGS_FILE"
if [ "$NV_FAKE_AUDIT_HANG" = "1" ]; then
  end=$((SECONDS + 3))
  while (( SECONDS < end )); do :; done
fi
cat "$NV_FAKE_AUDIT_JSON"
exit "\${NV_FAKE_AUDIT_EXIT:-0}"
`);
fs.chmodSync(path.join(binDir, 'npm'), 0o755);

function runGate(payload, options = {}) {
  const file = path.join(workspace, `${Math.random().toString(36).slice(2)}.json`);
  const argsFile = path.join(workspace, `${Math.random().toString(36).slice(2)}.args`);
  fs.writeFileSync(file, typeof payload === 'string' ? payload : JSON.stringify(payload));
  fs.writeFileSync(argsFile, '');
  try {
    const stdout = execFileSync(process.execPath, [script, ...(options.args || [])], {
      encoding: 'utf8',
      timeout: options.outerTimeoutMs || 5000,
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
        NV_FAKE_AUDIT_JSON: file,
        NV_FAKE_AUDIT_ARGS_FILE: argsFile,
        NV_FAKE_AUDIT_HANG: options.hang ? '1' : '0',
        NV_FAKE_AUDIT_EXIT: String(options.npmExitCode || 0),
        NV_AUDIT_ATTEMPTS: String(options.attempts || 2),
        NV_AUDIT_BACKOFF_MS: String(options.backoffMs || 1),
        NV_AUDIT_ATTEMPT_TIMEOUT_MS: String(options.attemptTimeoutMs || 1000)
      }
    });
    return {
      code: 0,
      stdout,
      stderr: '',
      invocations: fs.readFileSync(argsFile, 'utf8').trim().split('\n').filter(Boolean)
    };
  } catch (error) {
    return {
      code: error.status,
      stdout: String(error.stdout || ''),
      stderr: String(error.stderr || ''),
      invocations: fs.readFileSync(argsFile, 'utf8').trim().split('\n').filter(Boolean)
    };
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
  assert.deepEqual(result.invocations, ['audit --omit=dev --json'],
    'the default gate must remain production-only');
}

/* The candidate can request the same three-state gate for all dependencies. */
{
  const expected = counts({ moderate: 3, total: 3 });
  const result = runGate(
    { vulnerabilities: {}, metadata: { vulnerabilities: expected } },
    { args: ['--include-dev', '--json'] }
  );
  assert.equal(result.code, 0, 'a development tree with no high or critical advisories must pass');
  assert.deepEqual(JSON.parse(result.stdout), { metadata: { vulnerabilities: expected } });
  assert.deepEqual(result.invocations, ['audit --json'],
    'the development gate must include development dependencies');
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
  assert.equal(result.code, 2, 'an unreachable registry must fail with the unavailable status');
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
  assert.equal(result.code, 2, 'a non-JSON response must fail with the unavailable status');
  assert.match(result.stderr, /UNAVAILABLE/);
}

/*
 * The one that matters most. A report with no metadata is missing the counts,
 * and an absent count must never be read as a zero count -- that is precisely
 * how a broken audit would come back green.
 */
{
  const result = runGate({ vulnerabilities: {} });
  assert.equal(result.code, 2, 'a report with no vulnerability counts must not pass');
  assert.match(result.stderr, /UNAVAILABLE/);
}

/* A hung npm process must be cut off, retried, and classified as unavailable. */
{
  const startedAt = Date.now();
  const result = runGate(
    { vulnerabilities: {}, metadata: { vulnerabilities: counts({}) } },
    { hang: true, attempts: 2, attemptTimeoutMs: 100, outerTimeoutMs: 1500 }
  );
  assert.equal(result.code, 2, 'a timed-out registry must fail as unavailable');
  assert.match(result.stderr, /UNAVAILABLE/);
  assert.match(result.stderr, /timed out after 100 ms/);
  assert.equal(result.invocations.length, 2, 'a timed-out audit must consume the bounded retry count');
  assert(Date.now() - startedAt < 1500, 'the gate must finish before its parent timeout');
}

/* Valid-looking output from an abnormally exited npm process is still unknown. */
{
  const result = runGate(
    { vulnerabilities: {}, metadata: { vulnerabilities: counts({}) } },
    { npmExitCode: 42, attempts: 1 }
  );
  assert.equal(result.code, 2, 'an unexpected npm exit must fail as unavailable');
  assert.match(result.stderr, /UNAVAILABLE/);
  assert.match(result.stderr, /unexpected status 42/);
}

fs.rmSync(workspace, { recursive: true, force: true });
process.stdout.write('production audit gate tests passed\n');
