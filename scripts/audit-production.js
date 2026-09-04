'use strict';

/*
 * The production dependency gate.
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

const ATTEMPTS = Number(process.env.NV_AUDIT_ATTEMPTS || 3);
const BACKOFF_MS = Number(process.env.NV_AUDIT_BACKOFF_MS || 5000);
const BLOCKING_SEVERITIES = Object.freeze(['high', 'critical']);

/*
 * Severity is decided here rather than by --audit-level, because this needs to
 * tell three outcomes apart and npm's exit code tells only two. A non-zero exit
 * from npm means "vulnerabilities at or above the level" OR "I could not
 * produce a report at all", and reading the second as the first is how a
 * registry outage would come to look like a security finding.
 */
function runAudit() {
  const result = spawnSync('npm', ['audit', '--omit=dev', '--json'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === 'win32'
  });
  if (result.error) return { ok: false, reason: `npm could not be started: ${result.error.message}` };
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
  if (!counts || typeof counts !== 'object') {
    return { ok: false, reason: 'npm audit returned no vulnerability counts' };
  }
  return { ok: true, counts, advisories: (parsed && parsed.vulnerabilities) || {} };
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function main() {
  const failures = [];
  let report = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    report = runAudit();
    if (report.ok) break;
    failures.push(`attempt ${attempt}: ${report.reason}`);
    if (attempt < ATTEMPTS) sleep(BACKOFF_MS * attempt);
  }

  if (!report || !report.ok) {
    process.stderr.write(
      'production dependency audit UNAVAILABLE — the build fails because the audit could not be '
      + 'obtained, not because a vulnerability was found.\n'
      + failures.map(line => `  ${line}\n`).join('')
      + 'An audit that cannot be read is an unknown, and an unknown is not clean.\n'
    );
    process.exitCode = 1;
    return;
  }

  const blocking = BLOCKING_SEVERITIES
    .map(severity => [severity, Number(report.counts[severity] || 0)])
    .filter(([, count]) => count > 0);

  if (blocking.length) {
    const named = Object.entries(report.advisories)
      .filter(([, entry]) => BLOCKING_SEVERITIES.includes(String(entry && entry.severity)))
      .map(([name, entry]) => `  ${name} (${entry.severity})`)
      .sort();
    process.stderr.write(
      `production dependency audit FAILED — ${blocking.map(([s, c]) => `${c} ${s}`).join(', ')}\n`
      + (named.length ? `${named.join('\n')}\n` : '')
    );
    process.exitCode = 1;
    return;
  }

  const summary = Object.entries(report.counts)
    .filter(([severity, count]) => severity !== 'total' && Number(count) > 0)
    .map(([severity, count]) => `${count} ${severity}`)
    .join(', ');
  process.stdout.write(
    `production dependency audit passed — no high or critical advisories${summary ? ` (${summary})` : ''}\n`
  );
}

if (require.main === module) main();

module.exports = Object.freeze({ runAudit, BLOCKING_SEVERITIES });
