'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const continuityArtifacts = [
  'WORK_CONTINUITY.json',
  'docs/current/PROJECT_STATE.md',
  'docs/history/phase-1/ROADMAP.md',
  'docs/current/CONTINUATION_PROMPT.md',
  'docs/architecture/ARCHITECTURE_DECISIONS.md',
  'docs/history/phase-1/reports/PHASE_1_TASK_20_REPORT.md',
  'docs/history/phase-1/specifications/TASK_20_STAGING_VALIDATION_SPEC.md',
  'docs/history/phase-1/reports/PHASE_1_TASK_21_REPORT.md',
  'docs/release/QUALIFICATION_BASELINE.md'
];
for (const file of continuityArtifacts) {
  assert(fs.existsSync(path.join(root, file)), `missing continuity artifact ${file}`);
}

const state = read('docs/current/PROJECT_STATE.md');
assert(state.includes('Current authored version: **5.3.0-alpha.17.0**'));
assert(state.includes('Public alpha: **NO-GO**'));
assert(state.includes('58adb78f3a5a4e51e65d0d53742a3ec1064cb950b0256d7210aeb2ad8259d711'));
assert(state.includes('The successor now in progress is **not qualified**'));
for (const row of [
  '| Automated exact-archive qualification | Passed |',
  '| Independent review | Passed |',
  '| Live-provider qualification | Pending |',
  '| Hosted qualification | Pending |',
  '| Manual accessibility | Pending |',
  '| Final release | Pending |'
]) assert(state.includes(row), `project state missing gate row ${row}`);

const roadmap = read('docs/history/phase-1/ROADMAP.md');
for (let task = 1; task <= 21; task += 1) {
  assert(new RegExp(`\\| ${task} \\|`).test(roadmap), `roadmap missing task ${task}`);
}
assert(roadmap.includes('| 19 | Governance Notifications, Webhooks and Audit Exports | Complete'));
assert(roadmap.includes('| 20 | End-to-End Staging, Security, Concurrency and Accessibility | Complete (18/19; alpha.16.1 blocked)'));
assert(roadmap.includes('Phase 1 Task 19 (signed evidence export format) must be complete and stable first'));

const decisions = read('docs/architecture/ARCHITECTURE_DECISIONS.md');
const adrNumbers = [...decisions.matchAll(/^## ADR-(\d{3}) —/gm)].map(match => Number(match[1]));
assert.strictEqual(adrNumbers.length, 84);
assert.deepStrictEqual(adrNumbers, Array.from({ length: 84 }, (_, index) => index + 1));
assert(decisions.includes('## ADR-051 — Governance delivery uses an immutable outbox and failure-isolated worker'));
assert(decisions.includes('## ADR-052 — Signed evidence envelopes are the stable boundary before external storage'));
assert(decisions.includes('## ADR-053 — Staging readiness is an expiring evidence gate, not a release assertion'));
assert(decisions.includes('## ADR-054 — Staging evidence is candidate-, catalog-, command-, and artifact-bound'));
assert(decisions.includes('## ADR-057 — Alpha invitation secrets are one-time, digest-only and managed outside the public web surface'));
assert(decisions.includes('## ADR-058 — Provider cleanup is a verified lifecycle and deletion fails closed while cleanup is pending'));
assert(decisions.includes('## ADR-059 — Public-alpha success is verification-gated and every conclusion carries an evidence state'));
assert(decisions.includes('## ADR-060 — Hosted-alpha migrations are backup-gated and verified by the web process'));
assert(decisions.includes('## ADR-061 — Live qualification is exact-job and exact-target authorized'));
for (const title of [
  'ADR-062 — Documentation lifecycle and generated continuity are release contracts',
  'ADR-063 — Release archives cannot self-attest exact candidate identity',
  'ADR-064 — Provider operation IDs use a versioned canonical preimage',
  'ADR-065 — Destructive database restore requires an exact isolated-target fingerprint',
  'ADR-066 — Recovery snapshots use an independently rotatable signing keyring',
  'ADR-067 — Hosted evidence observes the deployed release tree',
  'ADR-068 — Provider delete qualification is negative-and-positive head-bound proof',
  'ADR-069 — Destructive Neon restore requires control-plane and live-session ownership proof',
  'ADR-070 — Production snapshot compatibility is an explicit operator keyring',
  'ADR-071 — Continuity accepts exact transport-specific commits paired to one tree',
  'ADR-072 — Deployed release identity remains runtime-observed and non-circular',
  'ADR-073 — Activation and rollback require idempotency before persistence access',
  'ADR-074 — Unsupported active rules are evaluator failures, never implicit allows',
  'ADR-075 — Governance advisory locks have one nested acquisition order',
  'ADR-076 — Governance webhook delivery is at-least-once and receiver-deduplicated',
  'ADR-077 — Private offline responses require server-confirmed cache bindings',
  'ADR-078 — Exact-archive qualification uses an allowlisted process environment',
  'ADR-079 — Hosted operational claims retain signed-attestation provenance',
  'ADR-080 — Live qualification credentials assume an independently reviewed candidate',
  'ADR-081 — Provider claims equal the proof-bearing qualification subset',
  'ADR-082 — Credential-bearing outbound requests never follow redirects',
  'ADR-083 — Continuity records a state, not one frozen position'
]) assert(decisions.includes(`## ${title}`), `architecture decisions missing ${title}`);

const prompt = read('docs/current/CONTINUATION_PROMPT.md');
assert(prompt.includes('Public alpha: **NO-GO**'));
assert(prompt.includes('docs/current/PROJECT_STATE.md'));
assert(prompt.includes('docs/release/RELEASE_SECURITY_GATES.md'));
assert(prompt.includes('58adb78f3a5a4e51e65d0d53742a3ec1064cb950b0256d7210aeb2ad8259d711'));
assert(!prompt.includes('Task 21 is in progress'));
assert(!prompt.includes('Nebulaverse-X-v5.3.0-alpha.16.3.zip'));

const spec = read('docs/history/phase-1/specifications/TASK_20_STAGING_VALIDATION_SPEC.md');
assert(spec.includes('Evidence schema `1.2.0`'));
assert(spec.includes('NV_STAGING_SUBJECT_SHA256'));
assert(spec.includes('one or more verified non-secret artifact files'));
const report = read('docs/history/phase-1/reports/PHASE_1_TASK_20_REPORT.md');
assert(report.includes('91 top-level test programs'));
assert(report.includes('Task 20 execution completed with 18 of 19 mandatory checks passing'));

console.log('continuity contract tests passed');
