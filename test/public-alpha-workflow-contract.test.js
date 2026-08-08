'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  encodeAuthorizationEnvelope,
  verifyAuthorizationEnvelope
} = require('../ci/verify-alpha17-authorization');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const publicKeyBase64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const now = new Date('2026-07-29T20:00:00.000Z');
const payload = {
  schemaVersion: '1.0.0',
  workflow: '.github/workflows/public-alpha-alpha17.yml',
  repository: 'fixture-owner/fixture-repository',
  event: 'workflow_dispatch',
  sourceParent: 'c'.repeat(40),
  sourceCommit: 'b'.repeat(40),
  subjectSha256: 'a'.repeat(64),
  authorizedJobs: ['github', 'gitlab'],
  authorizationId: 'approval-2048',
  expiresAt: '2026-07-29T20:15:00.000Z'
};
const token = encodeAuthorizationEnvelope(payload, privateKey);
const verified = verifyAuthorizationEnvelope(token, {
  publicKeyBase64,
  expectedWorkflow: payload.workflow,
  expectedRepository: payload.repository,
  expectedEvent: payload.event,
  expectedSourceParent: payload.sourceParent,
  expectedSourceCommit: payload.sourceCommit,
  expectedSubjectHash: payload.subjectSha256,
  requestedJobs: ['github', 'gitlab'],
  now
});
assert.deepStrictEqual(verified.authorizedJobs, ['github', 'gitlab']);
assert.match(verified.envelopeHash, /^[0-9a-f]{64}$/);
assert(!JSON.stringify(verified).includes(token));

assert.throws(
  () => verifyAuthorizationEnvelope(token, {
    publicKeyBase64,
    expectedWorkflow: payload.workflow,
    expectedRepository: payload.repository,
    expectedEvent: payload.event,
    expectedSourceParent: payload.sourceParent,
    expectedSourceCommit: payload.sourceCommit,
    expectedSubjectHash: 'd'.repeat(64),
    requestedJobs: ['github'],
    now
  }),
  error => error && error.code === 'ALPHA17_AUTHORIZATION_SUBJECT_MISMATCH'
);
assert.throws(
  () => verifyAuthorizationEnvelope(token, {
    publicKeyBase64,
    expectedWorkflow: payload.workflow,
    expectedRepository: payload.repository,
    expectedEvent: payload.event,
    expectedSourceParent: payload.sourceParent,
    expectedSourceCommit: payload.sourceCommit,
    expectedSubjectHash: payload.subjectSha256,
    requestedJobs: ['github'],
    now: new Date('2026-07-29T20:16:00.000Z')
  }),
  error => error && error.code === 'ALPHA17_AUTHORIZATION_EXPIRED'
);

const workflowPath = path.join(__dirname, '..', '.github', 'workflows', 'public-alpha-alpha17.yml');
const workflow = fs.readFileSync(workflowPath, 'utf8');
assert(/^on:\n(?:[\s\S]*\n)?  pull_request:/m.test(workflow), 'pull_request trigger is required');
assert(/^  workflow_dispatch:/m.test(workflow), 'workflow_dispatch trigger is required');
assert(!/^\s{2}push:/m.test(workflow), 'qualification must not run on push');
assert(/^permissions:\n  contents: read$/m.test(workflow), 'default permissions must be contents: read');
assert(/node-version:\s*['"]?22['"]?/m.test(workflow), 'Node 22 setup is required');
for (const input of [
  'subject_sha256', 'source_commit', 'run_github', 'run_gitlab',
  'run_gitea', 'run_hosted', 'authorization_token'
]) {
  assert(new RegExp(`^      ${input}:`, 'm').test(workflow), `missing dispatch input ${input}`);
}

function job(name) {
  const marker = `\n  ${name}:\n`;
  const start = workflow.indexOf(marker);
  assert(start >= 0, `missing workflow job ${name}`);
  const contentStart = start + marker.length;
  const remainder = workflow.slice(contentStart);
  const next = remainder.search(/^  [a-zA-Z0-9_-]+:\n/m);
  return next < 0 ? remainder : remainder.slice(0, next);
}

const automated = job('automated');
assert(!automated.includes('${{ secrets.'), 'credential-free job must not reference secrets');
for (const command of [
  'npm ci',
  'npm run check:syntax',
  'npm run check:secrets',
  'npm audit --omit=dev --audit-level=high',
  'npm audit --json',
  'npm run test:runtime:matrix',
  'npm run test:e2e'
]) assert(automated.includes(command), `automated job omits ${command}`);
assert((automated.match(/npm run package:release/g) || []).length >= 2, 'candidate must be built twice');
assert(automated.includes('cmp '), 'double package bytes must be compared');

const authorization = job('authorize-live');
assert(authorization.includes("github.event_name == 'workflow_dispatch'"));
assert(authorization.includes('ci/verify-alpha17-authorization.js'));
assert(!authorization.includes('${{ secrets.'), 'authorization job must verify before secrets are read');

for (const name of ['github-live', 'gitlab-live', 'gitea-live', 'hosted-live']) {
  const block = job(name);
  assert(block.includes("github.event_name == 'workflow_dispatch'"), `${name} must be dispatch-only`);
  assert(block.includes('needs: [automated, authorize-live]'), `${name} must depend on automated and authorization gates`);
  assert(block.includes('inputs.subject_sha256'), `${name} must bind the subject hash`);
  assert(block.includes('inputs.source_commit'), `${name} must bind the source commit`);
  const hashIndex = block.indexOf('sha256sum -c');
  const extractIndex = block.indexOf('unzip ');
  assert(hashIndex >= 0 && extractIndex > hashIndex, `${name} must verify the archive before extraction`);
}

for (const artifact of [
  'alpha17-automated-evidence',
  'alpha17-github-evidence',
  'alpha17-gitlab-evidence',
  'alpha17-gitea-evidence',
  'alpha17-hosted-evidence'
]) assert(workflow.includes(`name: ${artifact}`), `missing sanitized artifact ${artifact}`);
assert(workflow.includes('scripts/check-secrets.js'));

console.log('public alpha workflow contract tests passed');
