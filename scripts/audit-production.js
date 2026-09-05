'use strict';

/*
 * The dependency audit gate. Production dependencies are the default; the
 * candidate qualifier can explicitly include development dependencies and
 * request a sanitized JSON count report.
 *
 * CI ran `npm audit --omit=dev --audit-level=high` directly, and it went red on
 * runs where nothing about the dependencies had changed. The log says what
 * happened: the step spent 6m51s before failing, which is npm exhausting its
 * retries against the bulk advisory endpoint and then falling back to
 * /-/npm/v1/security/audits/quick -- an endpoint the registry is retiring and
 * now answers with 400.
 *
 * The 400's body reads "Invalid package tree, run npm install to rebuild your
 * package-lock.json", which sounds like a statement about this repository and
 * is not one: it is that endpoint's generic refusal. The same lockfile audits
 * clean on the same npm and the same node locally, and a sibling pull request
 * passed the identical step inside the same window. What varies is whether the
 * runner can reach the bulk endpoint, not what is in the tree.
 *
 * So the gate retries instead of trusting one attempt. What it must never do
 * is pass because the audit could not be obtained. An unreachable registry is
 * an unknown, and an unknown is not a clean bill of health -- this project
 * already refuses that reading elsewhere, in the dependency-audit capability
 * whose stated reason is "OSV unavailability is reported as incomplete, never
 * clean". An audit that never arrives fails the build, and says that is what
 * happened rather than implying a vulnerability that was never found.
 */

const { spawnSync } = require('child_process');

const BLOCKING_SEVERITIES = Object.freeze(['high', 'critical']);
const VULNERABILITY_COUNT_KEYS = Object.freeze([
  'info', 'low', 'moderate', 'high', 'critical', 'total'
]);
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = 5000;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 75 * 1000;
const MAX_TOTAL_BUDGET_MS = 270 * 1000;

/*
 * Severity is decided here rather than by --audit-level, because this needs to
 * tell three outcomes apart and npm's exit code tells only two. A non-zero exit
 * from npm means "vulnerabilities at or above the level" OR "I could not
 * produce a report at all", and reading the second as the first is how a
 * registry outage would come to look like a security finding.
 */
function runAudit(options = {}) {
  const timeoutMs = options.timeoutMs == null
    ? DEFAULT_ATTEMPT_TIMEOUT_MS
    : options.timeoutMs;
  const args = ['audit'];
  if (options.includeDev !== true) args.push('--omit=dev');
  args.push('--json');
  const result = spawnSync('npm', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === 'win32',
    timeout: timeoutMs
  });
  if (result.error && result.error.code === 'ETIMEDOUT') {
    return { ok: false, reason: `npm audit timed out after ${timeoutMs} ms` };
  }
  if (result.error) return { ok: false, reason: `npm could not be started: ${result.error.message}` };
  if (result.status !== 0 && result.status !== 1) {
    const reason = result.signal
      ? `npm audit terminated by signal ${result.signal}`
      : `npm audit exited with unexpected status ${String(result.status)}`;
    return { ok: false, reason };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(String(result.stdout || ''));
  } catch {
    return { ok: false, reason: 'npm audit did not return JSON' };
  }
  /*
   * A report npm could not build carries an error object instead of the
   * metadata counts. That is the registry-unreachable case, and it is the one
   * that must not be mistaken for a clean tree: an audit with no advisories
   * still reports metadata.vulnerabilities with zeroes in it.
   */
  if (parsed && parsed.error) {
    /*
     * `message` first, because that is where npm actually puts the reason --
     * it names the endpoint and the transport failure. error.summary and
     * error.detail are present but empty on a registry failure, so reading
     * them first produced "unspecified" and threw away the one line that says
     * which endpoint refused and why.
     */
    const detail = parsed.message
      || parsed.error.summary || parsed.error.detail || parsed.error.code || 'unspecified';
    return { ok: false, reason: `the registry refused the audit request: ${String(detail).slice(0, 300)}` };
  }
  const counts = parsed && parsed.metadata && parsed.metadata.vulnerabilities;
  if (
    !counts || typeof counts !== 'object' ||
    !VULNERABILITY_COUNT_KEYS.every(key => Number.isInteger(counts[key]) && counts[key] >= 0) ||
    VULNERABILITY_COUNT_KEYS
      .filter(key => key !== 'total')
      .reduce((total, key) => total + counts[key], 0) !== counts.total
  ) {
    return { ok: false, reason: 'npm audit returned no vulnerability counts' };
  }
  return { ok: true, counts, advisories: (parsed && parsed.vulnerabilities) || {} };
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readBoundedInteger(raw, name, fallback, minimum, maximum) {
  if (raw == null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function auditSettings(env = process.env) {
  const attempts = readBoundedInteger(env.NV_AUDIT_ATTEMPTS, 'NV_AUDIT_ATTEMPTS', DEFAULT_ATTEMPTS, 1, 5);
  const backoffMs = readBoundedInteger(
    env.NV_AUDIT_BACKOFF_MS,
    'NV_AUDIT_BACKOFF_MS',
    DEFAULT_BACKOFF_MS,
    0,
    60 * 1000
  );
  const attemptTimeoutMs = readBoundedInteger(
    env.NV_AUDIT_ATTEMPT_TIMEOUT_MS,
    'NV_AUDIT_ATTEMPT_TIMEOUT_MS',
    DEFAULT_ATTEMPT_TIMEOUT_MS,
    1,
    4 * 60 * 1000
  );
  const totalBudgetMs = attempts * attemptTimeoutMs
    + backoffMs * ((attempts - 1) * attempts / 2);
  if (totalBudgetMs > MAX_TOTAL_BUDGET_MS) {
    throw new TypeError(`audit retry budget must not exceed ${MAX_TOTAL_BUDGET_MS} ms`);
  }
  return Object.freeze({ attempts, backoffMs, attemptTimeoutMs });
}

function parseOptions(args) {
  const allowed = new Set(['--include-dev', '--json']);
  const unknown = args.filter(arg => !allowed.has(arg));
  if (unknown.length || new Set(args).size !== args.length) {
    throw new TypeError(`unsupported audit option${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ') || 'duplicate option'}`);
  }
  return Object.freeze({
    includeDev: args.includes('--include-dev'),
    json: args.includes('--json')
  });
}

function main(args = process.argv.slice(2), environment = process.env) {
  let options;
  let settings;
  try {
    options = parseOptions(args);
    settings = auditSettings(environment);
  } catch (error) {
    process.stderr.write(`dependency audit CONFIGURATION ERROR — ${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  const scope = options.includeDev ? 'development' : 'production';
  const failures = [];
  let report = null;
  for (let attempt = 1; attempt <= settings.attempts; attempt += 1) {
    report = runAudit({ includeDev: options.includeDev, timeoutMs: settings.attemptTimeoutMs });
    if (report.ok) break;
    failures.push(`attempt ${attempt}: ${report.reason}`);
    if (attempt < settings.attempts) sleep(settings.backoffMs * attempt);
  }

  if (!report || !report.ok) {
    process.stderr.write(
      `${scope} dependency audit UNAVAILABLE — the build fails because the audit could not be `
      + 'obtained, not because a vulnerability was found.\n'
      + failures.map(line => `  ${line}\n`).join('')
      + 'An audit that cannot be read is an unknown, and an unknown is not clean.\n'
    );
    process.exitCode = 2;
    return;
  }

  const blocking = BLOCKING_SEVERITIES
    .map(severity => [severity, Number(report.counts[severity] || 0)])
    .filter(([, count]) => count > 0);

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ metadata: { vulnerabilities: report.counts } })}\n`);
  }

  if (blocking.length) {
    const named = Object.entries(report.advisories)
      .filter(([, entry]) => BLOCKING_SEVERITIES.includes(String(entry && entry.severity)))
      .map(([name, entry]) => `  ${name} (${entry.severity})`)
      .sort();
    if (!options.json) {
      process.stderr.write(
        `${scope} dependency audit FAILED — ${blocking.map(([s, c]) => `${c} ${s}`).join(', ')}\n`
        + (named.length ? `${named.join('\n')}\n` : '')
      );
    }
    process.exitCode = 1;
    return;
  }

  if (!options.json) {
    const summary = Object.entries(report.counts)
      .filter(([severity, count]) => severity !== 'total' && Number(count) > 0)
      .map(([severity, count]) => `${count} ${severity}`)
      .join(', ');
    process.stdout.write(
      `${scope} dependency audit passed — no high or critical advisories${summary ? ` (${summary})` : ''}\n`
    );
  }
}

if (require.main === module) main();

module.exports = Object.freeze({
  runAudit,
  parseOptions,
  auditSettings,
  BLOCKING_SEVERITIES,
  VULNERABILITY_COUNT_KEYS
});
