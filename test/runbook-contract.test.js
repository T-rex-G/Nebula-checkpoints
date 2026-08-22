'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { AUTHORIZATION_SCHEMA_VERSION } = require('../ci/verify-alpha17-authorization');

const root = path.join(__dirname, '..', 'docs', 'operations', 'runbooks');
const required = [
  '01-service-cold-start-outage.md',
  '02-neon-outage-quota.md',
  '03-provider-outage-rate-limit.md',
  '04-credential-exposure.md',
  '05-orphan-cleanup.md',
  '06-failed-deploy-rollback.md',
  '07-database-backup-restore.md',
  '08-tester-revocation-deletion.md',
  '09-capacity-saturation.md',
  '10-alpha-shutdown.md',
  'OPERATOR_CHECKLIST.md'
];

for (const file of required) {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  if (file !== 'OPERATOR_CHECKLIST.md') {
    for (const heading of ['## Trigger', '## Containment', '## Verification', '## Recovery', '## Evidence']) {
      assert(text.includes(heading), `${file} missing ${heading}`);
    }
    assert(text.includes('```bash'), `${file} must include a copyable command block`);
  }
  for (const block of text.matchAll(/^[ \t]*```bash[ \t]*\r?\n([\s\S]*?)^[ \t]*```[ \t]*$/gm)) {
    assert.match(block[1], /^[ \t]*set -euo pipefail\r?\n/, `${file} command blocks must fail fast`);
  }
  assert(!/TB[D]|TO[D]O|fill in|implement\s+later/i.test(text), `${file} contains an unfinished marker`);
  assert(!/postgres(?:ql)?:\/\/[^\s`]+/i.test(text), `${file} contains a literal database URL`);
  assert(!/(?:password|token|secret|key)\s*=\s*[^$\s`][^\s`]*/i.test(text), `${file} contains a literal secret-like value`);
}

function logicalShellLines(text) {
  return text.replace(/\\\r?\n[ \t]*/g, ' ')
    .split(/\r?\n/)
    .map(value => value.trimStart());
}

/*
 * Curl lines are found by scope, not by grammar.
 *
 * The previous matcher recognised curl only at a boundary it enumerated -- line
 * start, `;&|`, `$(` -- and so skipped `( curl ... )`, `if curl ...; then` and
 * `while curl ...`, silently exempting them from the --fail contract. Adding a
 * fourth alternative would invite a fifth; the same mistake in the workflow
 * contract took three rounds to stop making.
 *
 * So the question changes from "is this line a curl command?", which needs a
 * shell grammar, to "is this line inside a runbook's copyable command block?",
 * which is a heading scan. Inside such a block every line naming curl is held
 * to the contract, whatever its shell construct.
 *
 * That is deliberately over-strict: a comment or an echo mentioning curl inside
 * a command block must satisfy the contract or be reworded. Over-strict fails
 * loudly at authoring time. The previous under-strict version failed silently,
 * in production runbooks, for as long as nobody looked.
 */
function commandBlockLines(text) {
  const lines = [];
  for (const block of text.matchAll(/^[ \t]*```bash[ \t]*\r?\n([\s\S]*?)^[ \t]*```[ \t]*$/gm)) {
    lines.push(...logicalShellLines(block[1]));
  }
  return lines;
}

function namesCurl(value) {
  return /\bcurl\b/.test(value);
}

/*
 * Probes that must record a degraded response rather than abort on it.
 *
 * Scoped per file and per endpoint, because a runbook can need both kinds. Neon
 * outage containment runs while readiness reports waking, unavailable or
 * migration-mismatch -- the very states that bring an operator here -- so its
 * readiness probe records them, while its liveness probe still requires 200
 * because the application being reachable is a precondition for that block.
 */
const DEGRADED_EVIDENCE_PROBES = Object.freeze({
  '06-failed-deploy-rollback.md': /\$NV_ALPHA_BASE_URL\/(?:healthz|readyz|api\/config)/,
  '09-capacity-saturation.md': /\$NV_ALPHA_BASE_URL\/(?:healthz|readyz|api\/config)/,
  '02-neon-outage-quota.md': /\$NV_ALPHA_BASE_URL\/readyz/
});

function assertCurlContract(file, line) {
  const degradedPattern = Object.prototype.hasOwnProperty.call(DEGRADED_EVIDENCE_PROBES, file)
    ? DEGRADED_EVIDENCE_PROBES[file]
    : null;
  const degradedEvidenceProbe = !!degradedPattern && degradedPattern.test(line);
  if (degradedEvidenceProbe) {
    assert(!line.includes('--fail'), `${file} degraded-state probe must preserve non-2xx evidence`);
    assert(line.includes('--max-time 10'), `${file} degraded-state probe must remain bounded`);
    assert(line.includes("--write-out '%{http_code}'"), `${file} degraded-state probe must record HTTP status`);
    assert(/--output "\$NV_[A-Z_]+"/.test(line), `${file} degraded-state probe must capture the response body`);
    return;
  }
  assert(line.includes('--fail'), `${file} verification probe must fail on HTTP errors`);
  if (/\$NV_ALPHA_BASE_URL\/(?:healthz|readyz|api\/capabilities)/.test(line)) {
    assert(line.includes("--write-out '%{http_code}\\n'"), `${file} service probe must expose its HTTP status`);
    assert(/--output (?:\/dev\/null|"\$NV_[A-Z_]+")/.test(line),
      `${file} service probe must keep its response body separate from the status check`);
    assert(line.includes("| grep -qx '200'"), `${file} service probe must accept only HTTP 200`);
  }
}

for (const line of [
  'status=$(curl --fail https://example.test)',
  'status=$( curl --fail https://example.test)',
  'status=$(curl\t--fail https://example.test)',
  'status=ready; curl --fail https://example.test',
  'true && curl --fail https://example.test',
  'false || curl --fail https://example.test',
  'printf ready | curl --fail https://example.test',
  'sleep 1 & curl --fail https://example.test',
  '! curl --fail https://example.test',
  'false || ! curl --fail https://example.test',
  'status=$( !\tcurl --fail https://example.test)'
]) {
  assert(namesCurl(line), `curl contract must inspect command form: ${line}`);
  assert.doesNotThrow(() => assertCurlContract('synthetic-runbook.md', line));
}
for (const [line, description] of [
  ['status=$(curl\t--proto =https https://example.test)', 'tab-separated command'],
  ['status=ready; curl --proto =https https://example.test', 'semicolon-delimited command'],
  ['true && curl --proto =https https://example.test', 'AND-list command'],
  ['false || curl --proto =https https://example.test', 'OR-list command'],
  ['printf ready | curl --proto =https https://example.test', 'pipeline command'],
  ['sleep 1 & curl --proto =https https://example.test', 'background-list command'],
  ['! curl --proto =https https://example.test', 'negated command'],
  ['true && ! curl --proto =https https://example.test', 'negated AND-list command'],
  ['status=$( !\tcurl --proto =https https://example.test)', 'negated command substitution']
]) {
  assert(namesCurl(line), `curl contract must inspect ${description}`);
  assert.throws(
    () => assertCurlContract('synthetic-runbook.md', line),
    /verification probe must fail on HTTP errors/,
    `a ${description} must not bypass the --fail requirement`
  );
}
/*
 * Shell constructs the enumerated-boundary matcher skipped entirely. Each is a
 * real way to run curl, and each previously escaped the --fail requirement.
 */
for (const [line, description] of [
  ['( curl --proto =https https://example.test )', 'grouped command'],
  ['if curl --proto =https https://example.test; then', 'conditional command'],
  ['while curl --proto =https https://example.test; do', 'loop command'],
  ['until curl --proto =https https://example.test; do', 'until-loop command'],
  ['for host in a b; do curl --proto =https https://example.test; done', 'loop body command']
]) {
  assert(namesCurl(line), `curl contract must inspect ${description}`);
  assert.throws(
    () => assertCurlContract('synthetic-runbook.md', line),
    /verification probe must fail on HTTP errors/,
    `a ${description} must not bypass the --fail requirement`
  );
}

/* Prose outside a command block is not a command, and is not scanned. */
const proseOnly = [
  '# Notes',
  'Explain why `curl` alone would pass silently here.',
  '```bash',
  'set -euo pipefail',
  'curl --proto =https --fail https://example.test',
  '```',
  'A trailing paragraph mentioning curl again.'
].join('\n');
assert.deepStrictEqual(
  commandBlockLines(proseOnly).filter(namesCurl),
  ['curl --proto =https --fail https://example.test'],
  'only command-block lines are held to the curl contract'
);

for (const file of required) {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  for (const line of commandBlockLines(text).filter(namesCurl)) assertCurlContract(file, line);
}

const credentialExposure = fs.readFileSync(path.join(root, '04-credential-exposure.md'), 'utf8');
assert.match(credentialExposure, /SESSION_SECRET.*reconnect.*verified-live-events.*webhook delivery health/is);
/*
 * Slice at the heading only once it is known to exist. On a miss indexOf gives
 * -1, slice(0, -1) keeps all but the last character, and the containment
 * assertion below would then be satisfied by text from the verification
 * section -- passing while proving the opposite of what it claims.
 */
const credentialVerificationHeading = credentialExposure.indexOf('## Verification');
assert(credentialVerificationHeading > 0,
  '04-credential-exposure.md must define a Verification section to bound containment');
const credentialContainment = credentialExposure.slice(0, credentialVerificationHeading);
assert.match(
  credentialContainment,
  /GITHUB_APP_PRIVATE_KEY_BASE64.*delete the exposed private key in GitHub App settings/is,
  'an exposed GitHub App private key must be revoked at GitHub during containment'
);

/*
 * An exposed invitation nobody redeemed has no tester behind it, so tester
 * revocation cannot reach it and the code stays redeemable for its whole
 * lifetime. Containment must revoke the code itself, and must do so by
 * identifier: passing the code would put the secret into shell history and
 * process listings at the moment it is known to have leaked.
 */
assert.match(
  credentialContainment,
  /alpha-invites\.js revoke-invite --invite "\$NV_INVITE_ID"/,
  'containment must revoke an exposed invitation by identifier'
);
assert.doesNotMatch(
  credentialContainment,
  /revoke-invite[^\n]*NV_INVITE_CODE/,
  'the invitation secret must never be placed on a command line'
);

/*
 * Revoking a tester revokes every session it owns, so the access boundary
 * refuses a subsequent session-end request. Under `set -euo pipefail` a
 * `--fail` probe of it therefore aborts containment at the moment containment
 * succeeded, which is the worst time to report a false failure. Verification
 * confirms the session is dead; containment must not re-prove it.
 */
const testerRevocation = fs.readFileSync(path.join(root, '08-tester-revocation-deletion.md'), 'utf8');
const revocationVerification = testerRevocation.indexOf('## Verification');
assert(revocationVerification > 0,
  '08-tester-revocation-deletion.md must define a Verification section to bound containment');
const testerRevocationContainment = testerRevocation.slice(0, revocationVerification);
assert.doesNotMatch(
  testerRevocationContainment,
  /api\/alpha\/end/,
  'containment must not probe a session its own revocation step has just revoked'
);

/*
 * Compromised access covers an invitation that leaked before anyone redeemed
 * it, which has no tester behind it. Containment must offer that branch, or the
 * runbook reads as complete while leaving the exposed code redeemable.
 */
assert.match(
  testerRevocationContainment,
  /alpha-invites\.js revoke-invite --invite "\$NV_INVITE_ID"/,
  'containment must offer the unredeemed-invitation branch'
);
assert.match(
  testerRevocationContainment,
  /alpha-invites\.js revoke --tester "\$NV_TESTER_ID"/,
  'containment must keep the redeemed-invitation branch'
);

/*
 * Verification must not claim a check it does not perform. cleanup-status and
 * retention do not touch session access, and proving a specific session is dead
 * would need the tester's cookie -- which containment has just said never to
 * handle. The revocation transaction's own sessionsRevoked count is the
 * evidence, so the document must cite that rather than assert the check.
 */
const testerRevocationVerification = testerRevocation.slice(revocationVerification);
assert.doesNotMatch(
  testerRevocationVerification,
  /the alpha session no longer works/,
  'verification must not claim a session check these commands do not perform'
);
assert.match(
  testerRevocationVerification,
  /sessionsRevoked/,
  'verification must name the evidence that sessions actually ended'
);


/*
 * The checklist tells the operator which envelope schema to sign. A literal
 * copied into prose drifts silently the next time the verifier's schema moves,
 * and the operator only learns of it when a signed envelope is refused at
 * dispatch, so the number is read back from the verifier rather than trusted.
 */
const operatorChecklist = fs.readFileSync(path.join(root, 'OPERATOR_CHECKLIST.md'), 'utf8');
const schemaMentions = [...operatorChecklist.matchAll(/envelope using schema `([^`]+)`/g)].map(match => match[1]);
assert.strictEqual(schemaMentions.length, 1, 'the checklist must name the envelope schema exactly once');
assert.strictEqual(
  schemaMentions[0], AUTHORIZATION_SCHEMA_VERSION,
  'the checklist must name the schema the verifier actually accepts'
);
assert.match(
  operatorChecklist, /Allocate a new `authorizationId` for every dispatch/,
  'the checklist must tell the operator that an approval identifier is single-use'
);

for (const file of ['10-alpha-shutdown.md', 'OPERATOR_CHECKLIST.md']) {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  assert.match(text, /NV_BACKUP_RESULT="\$\(node scripts\/alpha-db\.js backup/,
    `${file} must capture the exact backup result`);
  assert.match(text, /readonly NV_BACKUP_FILE NV_BACKUP_MANIFEST/,
    `${file} must bind immutable paths from the backup result`);
  assert.match(text, /alpha-db\.js verify --backup "\$NV_BACKUP_FILE" --manifest "\$NV_BACKUP_MANIFEST"/,
    `${file} must verify the captured backup paths`);
}
const rollback = fs.readFileSync(path.join(root, '06-failed-deploy-rollback.md'), 'utf8');
assert.match(rollback, /test "\$\{#NV_FAILED_RENDER_SOURCE_COMMIT\}" -eq 40/);
assert.match(rollback, /grep -qxE '\[0-9a-f\]\{40\}'/);
const deployIdentityCheck = rollback.indexOf('test -n "$NV_FAILED_RENDER_DEPLOY_ID"');
const degradedProbe = rollback.indexOf('curl --proto');
assert(deployIdentityCheck >= 0 && degradedProbe >= 0 && deployIdentityCheck < degradedProbe,
  'failed deploy identity must be captured before degraded probes run');

const databaseRestore = fs.readFileSync(path.join(root, '07-database-backup-restore.md'), 'utf8');
assert.match(databaseRestore, /NV_BACKUP_RESULT="\$\(node scripts\/alpha-db\.js backup/);
assert.match(databaseRestore, /readonly NV_BACKUP_FILE NV_BACKUP_MANIFEST/);
assert.match(databaseRestore, /continue every remaining phase in this same trusted shell/i);
assert.match(databaseRestore, /NV_ALPHA_BASE_URL="\$NV_RESTORE_APP_BASE_URL"/);
assert.match(databaseRestore, /NV_RESTORE_APP_DEPLOY_ID/);

const securityDeployment = fs.readFileSync(path.join(root, '..', 'SECURITY_DEPLOYMENT.md'), 'utf8');
const compatibilityStep = securityDeployment.indexOf('NV_SNAPSHOT_LEGACY_KEYS_JSON` compatibility keyring');
const rotationStep = securityDeployment.indexOf('Rotate the value in Render');
assert(compatibilityStep >= 0 && rotationStep > compatibilityStep,
  'legacy snapshot compatibility must be staged before SESSION_SECRET rotation');

const deploymentGuide = fs.readFileSync(path.join(root, '..', 'DEPLOY_RENDER_NEON.md'), 'utf8');
assert.match(deploymentGuide, /NV_SNAPSHOT_SIGNING_KEY_ID=<new unique snapshot-signing key ID>/);
assert.match(deploymentGuide, /NV_SNAPSHOT_SIGNING_SECRET=<independent random value of at least 32 bytes>/);

console.log('runbook contract tests passed');
