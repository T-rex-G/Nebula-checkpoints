'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const phaseOneGovernanceHistory = [
  'docs/history/phase-1/reports/PHASE_1_TASK_12_13_REPORT.md',
  'docs/history/phase-1/specifications/TASK_12_13_GATEWAY_POLICY_ENFORCEMENT_SPEC.md',
  'docs/history/phase-1/reports/PHASE_1_TASK_14_REPORT.md',
  'docs/history/phase-1/specifications/TASK_14_EXCEPTION_WAIVER_EXPIRY_SPEC.md',
  'docs/history/phase-1/reports/PHASE_1_TASK_15_16_REPORT.md',
  'docs/history/phase-1/specifications/TASK_15_16_POLICY_TEMPLATES_DIGITAL_TWIN_SPEC.md',
  'docs/history/phase-1/reports/PHASE_1_TASK_17_REPORT.md',
  'docs/history/phase-1/specifications/TASK_17_POLICY_DIGITAL_TWIN_INTERFACE_SPEC.md',
  'docs/history/phase-1/reports/PHASE_1_TASK_18_REPORT.md',
  'docs/history/phase-1/specifications/TASK_18_FULL_MUTATION_COVERAGE_BULK_GOVERNANCE_SPEC.md',
  'docs/history/phase-1/reports/PHASE_1_TASK_19_REPORT.md',
  'docs/history/phase-1/specifications/TASK_19_GOVERNANCE_DELIVERY_SIGNED_EXPORTS_SPEC.md'
];

const required = [
  'config/historical-document-integrity.json',
  'src/alpha-access.js', 'src/alpha-access-store.js', 'scripts/alpha-invites.js',
  'db/migrations/014_alpha_access.sql', 'test/alpha-access.test.js',
  'test/alpha-access-persistence-contract.test.js', 'test/alpha-access-store.test.js',
  'test/alpha-access-server-contract.test.js', 'test/alpha-repository-boundary.test.js',
  'test/alpha-invite-cli.test.js',
  '.gitignore', '.nvmrc', '.env.example', 'CHANGELOG.md',
  'docs/operations/DEPLOY_RENDER_NEON.md', 'docs/release/QUALIFICATION_BASELINE.md',
  'docs/history/upgrades/UPGRADE_FROM_V5_2_1.md', 'docs/history/phase-0/PHASE_0_COVERAGE.md',
  'docs/history/phase-1/reports/PHASE_1_TASK_1_REPORT.md',
  'docs/history/phase-1/reports/PHASE_1_TASK_2_REPORT.md',
  'docs/history/phase-1/reports/PHASE_1_TASK_3_REPORT.md',
  'docs/history/phase-1/reports/PHASE_1_TASK_4_REPORT.md',
  'docs/history/phase-1/reports/PHASE_1_TASK_5_REPORT.md',
  'docs/history/phase-1/reports/PHASE_1_TASK_6_7_REPORT.md',
  'docs/history/phase-1/specifications/TASK_6_7_GOVERNANCE_API_DRAFT_WORKFLOW_SPEC.md',
  'docs/history/phase-1/reports/PHASE_1_TASK_8_REPORT.md',
  'docs/history/phase-1/specifications/TASK_8_REVIEWER_ASSIGNMENT_APPROVAL_SPEC.md',
  'docs/history/phase-1/reports/PHASE_1_TASK_9_10_REPORT.md',
  'docs/history/phase-1/specifications/TASK_9_10_POLICY_SIMULATION_SPEC.md',
  'docs/history/phase-1/reports/PHASE_1_TASK_11_REPORT.md',
  'docs/history/phase-1/specifications/TASK_11_POLICY_ACTIVATION_ROLLBACK_SPEC.md',
  ...phaseOneGovernanceHistory,
  'docs/history/phase-1/reports/PHASE_1_TASK_20_REPORT.md',
  'docs/history/phase-1/specifications/TASK_20_STAGING_VALIDATION_SPEC.md',
  'docs/history/phase-1/reports/PHASE_1_TASK_21_REPORT.md',
  'PUBLIC_ALPHA_PROVENANCE.json', 'config/public-alpha-capabilities.json', 'src/capability-registry.js',
  'docs/current/ROADMAP.md', 'docs/vision/PRODUCT_VISION.md',
  'docs/current/PROVIDER_CAPABILITIES.md', 'docs/architecture/ARCHITECTURE.md',
  'docs/release/RELEASE_SECURITY_GATES.md', 'docs/release/PUBLIC_ALPHA.md',
  'docs/vision/UX_VISION.md', 'docs/release/EVIDENCE_INDEX.md',
  'test/public-alpha-provenance.test.js', 'test/capability-registry.test.js',
  'test/capability-registry-server-contract.test.js', 'test/public-alpha-documentation.test.js',
  'src/public-errors.js', 'public/alpha-ui.js', 'public/capability-ui.js', 'public/trust-ui.js',
  'test/public-errors.test.js', 'test/public-errors-server-contract.test.js',
  'test/alpha-ui-contract.test.js', 'test/capability-ui-contract.test.js', 'test/trust-ui-contract.test.js',
  'test/e2e/public-alpha-fixtures.js', 'test/e2e/public-alpha-golden-path.spec.js',
  'test/e2e/public-alpha-states.spec.js', 'test/e2e/public-alpha-accessibility.spec.js',
  'docs/qualification/accessibility/PUBLIC_ALPHA_MANUAL_AUDIT.md',
  'src/staging-validation.js', 'src/test-matrix.js', 'scripts/staging-gate.js', 'scripts/test-matrix.js',
  'staging/TASK_20_EVIDENCE_TEMPLATE.json', 'playwright.config.js',
  'src/governance-templates.js', 'src/governance-digital-twin.js', 'src/governance-interface.js', 'src/mutation-coverage.js', 'src/governance-delivery.js', 'src/governance-webhook-worker.js', 'public/governance-ui.js',
  'docs/current/PROJECT_STATE.md', 'docs/history/phase-1/ROADMAP.md',
  'docs/architecture/ARCHITECTURE_DECISIONS.md', 'docs/current/CONTINUATION_PROMPT.md',
  'src/authorization-resolver.js', 'src/mutation-gateway.js', 'src/provider-file-mutations.js', 'src/governance-model.js',
  'src/governance-store.js', 'src/governance-api.js', 'src/governance-simulation.js',
  'src/control-catalog.js', 'src/governance-enforcement.js', 'src/governance-exceptions.js',
  'src/governance-templates.js', 'src/governance-digital-twin.js', 'db/migrations/007_governance.sql',
  'db/migrations/008_governance_drafts.sql', 'db/migrations/009_governance_reviews.sql',
  'db/migrations/010_governance_activation_evidence.sql', 'db/migrations/011_governance_policy_decisions.sql',
  'db/migrations/012_governance_exceptions.sql', 'db/migrations/013_governance_notifications_exports.sql', 'scripts/package-release.js', 'scripts/foundation-gate.js'
];
for (const file of required) assert(fs.existsSync(path.join(root, file)), `missing ${file}`);

const ignore = read('.gitignore');
for (const value of ['node_modules/', '.env', '*.log', '.DS_Store', '__MACOSX/', 'coverage/', 'tmp/', 'staging/evidence/']) {
  assert(ignore.includes(value), `.gitignore missing ${value}`);
}

const render = read('render.yaml');
assert.match(render, /name:\s*nebulaverse-x-public-alpha/);
assert.match(render, /plan:\s*free/);
assert.match(render, /buildCommand:\s*npm ci --omit=dev\s*$/m);
assert(!/^databases:/m.test(render));
assert(!render.includes('fromDatabase:'));
assert(render.includes('NV_GOVERNANCE_AUDIT_SECRET'));

const pkg = JSON.parse(read('package.json'));
const syntaxGate = [
  pkg.scripts['precheck:syntax'],
  pkg.scripts['check:syntax'],
  pkg.scripts['postcheck:syntax']
].filter(Boolean).join(' && ');
const syntaxChecks = source => syntaxGate.split(/\s*&&\s*/).includes(`node --check ${source}`);
const dependencyLock = JSON.parse(read('package-lock.json'));
assert.strictEqual(pkg.dependencies.dompurify, '3.4.13', 'DOMPurify must include the alpha.17 XSS fix');
assert.strictEqual(dependencyLock.packages['node_modules/dompurify'].version, '3.4.13');
assert.strictEqual(dependencyLock.packages['node_modules/brace-expansion'].version, '5.0.9',
  'the release packager dependency chain must include the brace-expansion DoS fixes');
for (const source of ['public/index.html', 'public/sw.js', 'server.js', 'scripts/copy-vendor.js', 'scripts/verify.js']) {
  assert(read(source).includes('dompurify/3.4.13/purify.min.js'), `${source} has a stale DOMPurify asset path`);
}
assert(fs.existsSync(path.join(root, 'public/vendor/dompurify/3.4.13/purify.min.js')));
assert(!fs.existsSync(path.join(root, 'public/vendor/dompurify/3.4.12')),
  'the vulnerable DOMPurify browser asset must not remain releasable');
const task6Artifacts = [
  'src/alpha-access.js',
  'src/alpha-access-store.js',
  'scripts/alpha-invites.js',
  'db/migrations/014_alpha_access.sql',
  'test/alpha-access.test.js',
  'test/alpha-access-persistence-contract.test.js',
  'test/alpha-access-store.test.js',
  'test/alpha-access-server-contract.test.js',
  'test/alpha-repository-boundary.test.js',
  'test/alpha-invite-cli.test.js'
];
const task6Programs = [
  'test/alpha-access.test.js',
  'test/alpha-access-persistence-contract.test.js',
  'test/alpha-access-store.test.js',
  'test/alpha-access-server-contract.test.js',
  'test/alpha-repository-boundary.test.js',
  'test/alpha-invite-cli.test.js'
];
const task6SyntaxSources = [
  'src/alpha-access.js',
  'src/alpha-access-store.js',
  'scripts/alpha-invites.js'
];
const task6Omissions = [];
const verifySource = read('scripts/verify.js');
for (const artifact of task6Artifacts) {
  if (!verifySource.includes(`'${artifact}'`)) {
    task6Omissions.push(`build gate does not require ${artifact}`);
  }
}
let previousTask6Program = -1;
for (const program of task6Programs) {
  const programIndex = pkg.scripts['test:unit'].indexOf(`node ${program}`);
  if (programIndex === -1) {
    task6Omissions.push(`unit gate does not execute ${program}`);
  } else if (programIndex <= previousTask6Program) {
    task6Omissions.push(`unit gate does not execute ${program} in deterministic access order`);
  }
  previousTask6Program = programIndex;
}
for (const source of task6SyntaxSources) {
  if (!syntaxChecks(source)) {
    task6Omissions.push(`syntax gate does not parse ${source}`);
  }
}
const envExample = read('.env.example');
for (const [key, value] of [
  ['NV_ALPHA_ACCESS_MODE', 'off'],
  ['NV_ALPHA_INVITE_PEPPER', ''],
  ['NV_ALPHA_TERMS_VERSION', '2026-07-29']
]) {
  if (!new RegExp(`^${key}=${value}$`, 'm').test(envExample)) {
    task6Omissions.push(`local configuration does not set ${key}=${value}`);
  }
}
for (const [key, value] of [
  ['NV_ALPHA_ACCESS_MODE', 'value: invite'],
  ['NV_ALPHA_INVITE_PEPPER', 'sync: false'],
  ['NV_ALPHA_TERMS_VERSION', 'value: 2026-07-29']
]) {
  const block = new RegExp(`- key: ${key}\\n\\s+${value.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}`);
  if (!block.test(render)) task6Omissions.push(`hosted configuration does not bind ${key} with ${value}`);
}
const alphaDocumentation = `${read('docs/release/PUBLIC_ALPHA.md')}\n${read('docs/architecture/ARCHITECTURE.md')}`;
for (const [label, pattern] of [
  ['controlled invitation access', /controlled invitation access/i],
  ['exact repository allowlists', /exact canonical (?:sandbox-)?repository allowlists?/i],
  ['root-host-only GitLab and Gitea cohort restriction', /root-host-only GitLab and Gitea/i],
  ['disabled global notifications', /global notifications[^\n]*(?:disabled|unavailable)/i],
  ['disabled repository creation and deletion', /repository creation[\s\S]{0,80}deletion[\s\S]{0,80}(?:disabled|unavailable)/i],
  ['disabled global search', /global search[^\n]*(?:disabled|unavailable)/i],
  ['local-only invite CLI', /local-only invite CLI/i],
  ['digest-only invite persistence', /no[\s\S]{0,80}plaintext invitation[\s\S]{0,80}persisted/i],
  ['pending Plan 2 final branch review', /Plan 2[^\n]*final branch review[^\n]*pending/i],
  ['deferred Unicode count mismatch', /UTF-16 code-unit[^\n]*Unicode code point/i]
]) {
  if (!pattern.test(alphaDocumentation)) task6Omissions.push(`documentation omits ${label}`);
}
const adr57 = `## ADR-057 — Alpha invitation secrets are one-time, digest-only and managed outside the public web surface

**Status:** Accepted

The first cohort uses operator-issued high-entropy invitation codes. PostgreSQL stores only a keyed digest. Redemptions are single-use, transactional, rate-limited and enumeration-resistant. Cohort administration remains a local CLI so privileged invite operations do not enlarge the hosted web attack surface.`;
if (!read('docs/architecture/ARCHITECTURE_DECISIONS.md').includes(adr57)) {
  task6Omissions.push('architecture decisions omit the exact ADR-057 decision');
}
assert.deepStrictEqual(task6Omissions, [], `Task 6 binding omissions:\n- ${task6Omissions.join('\n- ')}`);

const uxArtifacts = [
  'src/public-errors.js', 'public/alpha-ui.js', 'public/capability-ui.js', 'public/trust-ui.js',
  'test/public-errors.test.js', 'test/public-errors-server-contract.test.js',
  'test/alpha-ui-contract.test.js', 'test/capability-ui-contract.test.js', 'test/trust-ui-contract.test.js',
  'test/e2e/public-alpha-fixtures.js', 'test/e2e/public-alpha-golden-path.spec.js',
  'test/e2e/public-alpha-states.spec.js', 'test/e2e/public-alpha-accessibility.spec.js',
  'docs/qualification/accessibility/PUBLIC_ALPHA_MANUAL_AUDIT.md'
];
const uxPrograms = [
  'test/public-errors.test.js', 'test/public-errors-server-contract.test.js',
  'test/alpha-ui-contract.test.js', 'test/capability-ui-contract.test.js', 'test/trust-ui-contract.test.js'
];
const uxSyntaxSources = [
  'src/public-errors.js', 'public/alpha-ui.js', 'public/capability-ui.js', 'public/trust-ui.js',
  'test/e2e/public-alpha-fixtures.js', 'test/e2e/public-alpha-golden-path.spec.js',
  'test/e2e/public-alpha-states.spec.js', 'test/e2e/public-alpha-accessibility.spec.js'
];
const uxOmissions = [];
const uxUnitGate = `${pkg.scripts['pretest:unit'] || ''} ${pkg.scripts['test:unit'] || ''}`;
for (const artifact of uxArtifacts) {
  if (!verifySource.includes(`'${artifact}'`)) uxOmissions.push(`build gate does not require ${artifact}`);
}
let previousUxProgram = -1;
for (const program of uxPrograms) {
  const programIndex = uxUnitGate.indexOf(`node ${program}`);
  if (programIndex === -1) uxOmissions.push(`unit gate does not execute ${program}`);
  else if (programIndex <= previousUxProgram) uxOmissions.push(`unit gate does not execute ${program} in UX contract order`);
  previousUxProgram = programIndex;
}
for (const source of uxSyntaxSources) {
  if (!syntaxChecks(source)) uxOmissions.push(`syntax gate does not parse ${source}`);
}
const manualAudit = read('docs/qualification/accessibility/PUBLIC_ALPHA_MANUAL_AUDIT.md');
if (!/Status:\s*\*\*Not executed\*\*/.test(manualAudit)) uxOmissions.push('manual accessibility record does not remain explicitly Not executed');
if (!read('docs/vision/UX_VISION.md').includes('Automated public-alpha accessibility qualification passes')) uxOmissions.push('UX vision omits automated accessibility qualification status');
if (!read('docs/release/PUBLIC_ALPHA.md').includes('Manual VoiceOver on iOS and one desktop screen-reader pass remain required')) uxOmissions.push('public-alpha guide omits remaining manual accessibility gates');
const adr59 = `## ADR-059 — Public-alpha success is verification-gated and every conclusion carries an evidence state

**Status:** Accepted

The interface distinguishes provider-verified, deterministic, inferred, stale and unavailable evidence. A mutation does not display success until readback and required cleanup are complete. Tester-facing failures describe provider-change uncertainty, current safe state, next action and a correlation ID without exposing credentials or payloads.`;
if (!read('docs/architecture/ARCHITECTURE_DECISIONS.md').includes(adr59)) uxOmissions.push('architecture decisions omit the exact ADR-059 decision');
assert.deepStrictEqual(uxOmissions, [], `UX accessibility binding omissions:\n- ${uxOmissions.join('\n- ')}`);

const privacyArtifacts = [
  'src/alpha-privacy.js',
  'src/alpha-privacy-store.js',
  'src/provider-disconnect.js',
  'scripts/alpha-privacy.js',
  'db/migrations/015_alpha_privacy.sql',
  'test/alpha-privacy.test.js',
  'test/alpha-privacy-persistence-contract.test.js',
  'test/alpha-privacy-store.test.js',
  'test/provider-disconnect.test.js',
  'test/provider-disconnect-server-contract.test.js',
  'test/alpha-provider-session-lifecycle.test.js',
  'test/alpha-provider-webhook-lifecycle.test.js',
  'test/alpha-privacy-server-contract.test.js',
  'test/alpha-browser-purge.test.js',
  'test/alpha-privacy-cli.test.js'
];
const privacyPrograms = privacyArtifacts.filter(file => file.startsWith('test/'));
const privacySyntaxSources = [
  'src/alpha-privacy.js',
  'src/alpha-privacy-store.js',
  'src/provider-disconnect.js',
  'scripts/alpha-privacy.js'
];
const privacyOmissions = [];
for (const artifact of privacyArtifacts) {
  if (!verifySource.includes(`'${artifact}'`)) {
    privacyOmissions.push(`build gate does not require ${artifact}`);
  }
}
let previousPrivacyProgram = -1;
for (const program of privacyPrograms) {
  const programIndex = pkg.scripts['test:unit'].indexOf(`node ${program}`);
  if (programIndex === -1) {
    privacyOmissions.push(`unit gate does not execute ${program}`);
  } else if (programIndex <= previousPrivacyProgram) {
    privacyOmissions.push(`unit gate does not execute ${program} in privacy lifecycle order`);
  }
  previousPrivacyProgram = programIndex;
}
for (const source of privacySyntaxSources) {
  if (!syntaxChecks(source)) {
    privacyOmissions.push(`syntax gate does not parse ${source}`);
  }
}
const privacyDocumentation = `${read('docs/release/PUBLIC_ALPHA.md')}\n${read('docs/architecture/ARCHITECTURE.md')}`;
for (const [label, pattern] of [
  ['local disconnect action', /Disconnect from Nebulaverse-X/],
  ['provider revocation action', /Revoke at provider/],
  ['alpha-session action', /End alpha session/],
  ['alpha deletion action', /Delete alpha data/],
  ['seven-day session retention', /7 days[^\n]*(?:alpha|provider) sessions/i],
  ['fourteen-day operational retention', /14 days[^\n]*operational/i],
  ['thirty-day event retention', /30 days[^\n]*(?:events|verified events)/i],
  ['thirty-day snapshot retention', /30 days[^\n]*snapshots/i],
  ['thirty-day evidence retention', /30 days[^\n]*(?:evidence|exports)/i],
  ['thirty-day cohort metadata retention', /30 days[^\n]*(?:invite|revocation) metadata/i],
  ['pseudonymous integrity metadata disclosure', /retained pseudonymous integrity metadata/i]
]) {
  if (!pattern.test(privacyDocumentation)) privacyOmissions.push(`documentation omits ${label}`);
}
const adr58 = `## ADR-058 — Provider cleanup is a verified lifecycle and deletion fails closed while cleanup is pending

**Status:** Accepted

Provider disconnect removes token-bearing application state, but it does not falsely claim provider-side PAT/OAuth/App revocation. Alpha-created webhooks and temporary resources must be deleted or verified absent. A failed cleanup creates a non-secret pending task and blocks completed data deletion and cohort close.`;
if (!read('docs/architecture/ARCHITECTURE_DECISIONS.md').includes(adr58)) {
  privacyOmissions.push('architecture decisions omit the exact ADR-058 decision');
}
assert.deepStrictEqual(privacyOmissions, [], `Privacy lifecycle binding omissions:\n- ${privacyOmissions.join('\n- ')}`);
assert.strictEqual(pkg.name, 'nebulaverse-x');
assert.strictEqual(pkg.version, '5.3.0-alpha.17.0');
assert.strictEqual(pkg.engines.node, '22.23.1');
assert.strictEqual(read('.nvmrc'), '22.23.1\n');
assert.strictEqual(pkg.scripts['package:release'], 'node scripts/package-release.js');
assert.strictEqual(pkg.scripts['foundation:gate'], 'node scripts/foundation-gate.js');
assert.strictEqual(pkg.scripts['test:e2e:evidence'], 'playwright test --reporter=json');
for (const source of [
  'src/work-continuity.js',
  'scripts/generate-continuity-docs.js',
  'scripts/package-release.js'
]) {
  assert(
    syntaxChecks(source),
    `syntax gate missing release-gate source ${source}`
  );
}
const lock = JSON.parse(read('package-lock.json'));
assert.strictEqual(lock.version, pkg.version);
assert.strictEqual(lock.packages[''].version, pkg.version);
for (const [packagePath, entry] of Object.entries(lock.packages || {})) {
  if (!entry || !entry.resolved) continue;
  assert(String(entry.resolved).startsWith('https://registry.npmjs.org/'), `non-public registry URL for ${packagePath}: ${entry.resolved}`);
}
assert(read('CHANGELOG.md').includes('## 5.3.0-alpha.17.0'));
const currentState = read('docs/current/PROJECT_STATE.md');
const phase1Roadmap = read('docs/history/phase-1/ROADMAP.md');
const architectureDecisions = read('docs/architecture/ARCHITECTURE_DECISIONS.md');
assert(currentState.includes('Current authored version: **5.3.0-alpha.17.0**'));
assert(phase1Roadmap.includes('| 6 | Governance API and Authorization Boundary | Complete'));
assert(phase1Roadmap.includes('| 7 | Policy Draft and Immutable Version Workflow | Complete'));
assert(phase1Roadmap.includes('| 8 | Reviewer Assignment and Approval Workflow | Complete'));
assert(phase1Roadmap.includes('| 9 | Policy Simulation Engine | Complete'));
assert(phase1Roadmap.includes('| 10 | Simulation Evidence and Impact Diff | Complete'));
assert(phase1Roadmap.includes('| 11 | Policy Activation and Rollback Service | Complete'));
assert(phase1Roadmap.includes('| 12 | Gateway Policy Evaluation Integration | Complete'));
assert(phase1Roadmap.includes('| 13 | Observe, Warn and Block Enforcement Modes | Complete'));
assert(phase1Roadmap.includes('| 14 | Exceptions, Waivers and Expiry Workflow | Complete'));
assert(phase1Roadmap.includes('| 15 | Policy Templates and Repository Baselines | Complete'));
assert(phase1Roadmap.includes('| 16 | Policy Digital Twin Read Model | Complete'));
assert(phase1Roadmap.includes('| 17 | Policy Digital Twin Interface | Complete'));
assert(phase1Roadmap.includes('| 18 | Full Mutation Coverage and Bulk Operation Governance | Complete'));
assert(phase1Roadmap.includes('| 19 | Governance Notifications, Webhooks and Audit Exports | Complete'));
assert(phase1Roadmap.includes('| 20 | End-to-End Staging, Security, Concurrency and Accessibility | Complete (18/19; alpha.16.1 blocked)'));
assert(phase1Roadmap.includes('| 21 | v5.3 Release Readiness, Migration, Documentation and Packaging | Complete (alpha.16.3 qualified)'));
assert(phase1Roadmap.includes('### Phase 5 — Customer-Controlled Evidence Retention'));
assert(phase1Roadmap.includes('Phase 1 Task 19 (signed evidence export format) must be complete and stable first'));
assert(architectureDecisions.includes('## ADR-041 — Customer-controlled evidence storage is S3-compatible and integrity-preserving'));
assert(architectureDecisions.includes('## ADR-042 — Bitbucket is intentionally out of scope pending demand'));
assert(architectureDecisions.includes('## ADR-046 — Policy templates and baselines are immutable, provenance-bound and non-activating'));
assert(architectureDecisions.includes('## ADR-047 — The Policy Digital Twin is a repeatable-read derived projection'));
assert(architectureDecisions.includes('## ADR-048 — The governance interface is live, permission-projected and non-persistent'));
assert(architectureDecisions.includes('## ADR-049 — Mutation coverage is machine-verifiable and execution-bounded'));
assert(architectureDecisions.includes('## ADR-050 — Aggregate mutations are exact-item-bound and explicit about atomicity'));
assert(architectureDecisions.includes('## ADR-051 — Governance delivery uses an immutable outbox and failure-isolated worker'));
assert(architectureDecisions.includes('## ADR-052 — Signed evidence envelopes are the stable boundary before external storage'));
assert(architectureDecisions.includes('## ADR-053 — Staging readiness is an expiring evidence gate, not a release assertion'));
assert(architectureDecisions.includes('## ADR-054 — Staging evidence is candidate-, catalog-, command-, and artifact-bound'));
for (const variable of ['GITHUB_APP_ID', 'GITHUB_APP_SLUG', 'GITHUB_APP_CLIENT_ID', 'GITHUB_APP_CLIENT_SECRET', 'GITHUB_APP_PRIVATE_KEY_BASE64', 'GITHUB_APP_CALLBACK_URL']) {
  assert(read('.env.example').includes(variable), `.env.example missing ${variable}`);
  assert(render.includes(variable), `render.yaml missing ${variable}`);
}
assert(read('.env.example').includes('NV_GOVERNANCE_AUDIT_SECRET'));
assert(read('.env.example').includes('NV_GOVERNANCE_RUNTIME_FAILURE_MODE=warn'));
assert(render.includes('NV_GOVERNANCE_RUNTIME_FAILURE_MODE'));
assert(read('.env.example').includes('NV_DEPLOYMENT_PROFILE=hosted-alpha'));
assert(read('.env.example').includes('NV_ALPHA_ACCESS_MODE=off'));
assert(render.includes('NV_DEPLOYMENT_PROFILE') && render.includes('value: hosted-alpha'));
assert(render.includes('NV_ALPHA_ACCESS_MODE') && render.includes('value: invite'));
for (const testFile of [
  'authorization-resolver.test.js', 'authorization-resolver-server-contract.test.js',
  'mutation-gateway.test.js', 'mutation-gateway-server-contract.test.js', 'continuity-contract.test.js',
  'governance-model.test.js', 'governance-persistence-contract.test.js', 'governance-store.test.js',
  'governance-api.test.js', 'governance-api-server-contract.test.js',
  'governance-draft-persistence-contract.test.js', 'governance-draft-store.test.js', 'governance-idempotency.test.js',
  'governance-review-model.test.js', 'governance-review-persistence-contract.test.js',
  'governance-review-store.test.js', 'governance-review-api.test.js',
  'governance-simulation.test.js', 'governance-simulation-api.test.js', 'governance-simulation-server-contract.test.js',
  'governance-activation-api.test.js', 'governance-activation-store.test.js',
  'governance-activation-server-contract.test.js', 'governance-activation-persistence-contract.test.js',
  'control-mapping.test.js', 'governance-enforcement.test.js', 'governance-enforcement-store.test.js',
  'governance-enforcement-observability.test.js', 'governance-enforcement-persistence-contract.test.js',
  'governance-enforcement-server-contract.test.js', 'governance-enforcement-deployment-contract.test.js',
  'mutation-gateway-policy.test.js',
  'governance-exception-model.test.js', 'governance-exception-persistence-contract.test.js',
  'governance-exception-store.test.js', 'governance-exception-api.test.js',
  'governance-exception-server-contract.test.js', 'governance-exception-enforcement.test.js',
  'governance-exception-runtime-limit.test.js', 'governance-exception-approval-limit.test.js',
  'governance-policy-decision-v1-compatibility.test.js', 'governance-policy-decision-v1-chain.test.js',
  'governance-templates.test.js', 'governance-digital-twin.test.js',
  'governance-digital-twin-store.test.js', 'governance-template-digital-twin-api.test.js',
  'governance-template-digital-twin-server-contract.test.js',
  'governance-interface-access.test.js', 'governance-interface-server-contract.test.js',
  'governance-interface-renderer.test.js', 'governance-interface-client-contract.test.js',
  'governance-interface-workflow-contract.test.js', 'governance-interface-ui-contract.test.js',
  'mutation-coverage.test.js', 'mutation-coverage-server-contract.test.js', 'mutation-gateway-execution.test.js',
  'github-app.test.js', 'provider-credentials.test.js', 'github-app-persistence-contract.test.js',
  'github-app-server-contract.test.js', 'github-app-disabled-server.test.js',
  'github-app-configured-server.test.js', 'github-app-ui-contract.test.js',
  'package-release.test.js',
  'governance-delivery-model.test.js', 'governance-delivery-persistence-contract.test.js', 'governance-delivery-store.test.js',
  'governance-delivery-api.test.js', 'governance-delivery-server-contract.test.js', 'governance-webhook-worker.test.js', 'governance-delivery-interface.test.js',
  'staging-validation.test.js', 'staging-validation-contract.test.js', 'staging-validation-cli.test.js', 'test-matrix.test.js'
]) {
  assert(pkg.scripts['test:unit'].includes(testFile), `test:unit missing ${testFile}`);
}
const publicAlphaPrograms = [
  'test/public-alpha-provenance.test.js', 'test/capability-registry.test.js',
  'test/capability-registry-server-contract.test.js', 'test/public-alpha-documentation.test.js'
];
const releaseProgram = 'test/release-contract.test.js';
let previousProgramIndex = pkg.scripts['test:unit'].indexOf(releaseProgram);
assert(previousProgramIndex >= 0, `test:unit missing ${releaseProgram}`);
for (const program of publicAlphaPrograms) {
  const programIndex = pkg.scripts['test:unit'].indexOf(program);
  assert(programIndex > previousProgramIndex, `test:unit must run ${program} after ${releaseProgram}`);
  previousProgramIndex = programIndex;
}
for (const testFile of ['gitea-file-mutations.test.js', 'gitea-file-mutation-server.test.js']) {
  assert(pkg.scripts.posttest.includes(testFile), `posttest missing ${testFile}`);
}
for (const source of ['src/authorization-resolver.js', 'src/mutation-gateway.js', 'src/governance-model.js', 'src/governance-store.js', 'src/governance-api.js', 'src/governance-simulation.js', 'src/control-catalog.js', 'src/governance-enforcement.js', 'src/governance-exceptions.js', 'src/governance-templates.js', 'src/governance-digital-twin.js', 'src/governance-interface.js', 'src/mutation-coverage.js', 'src/governance-delivery.js', 'src/governance-webhook-worker.js', 'src/staging-validation.js', 'src/test-matrix.js', 'scripts/staging-gate.js', 'scripts/test-matrix.js', 'scripts/foundation-gate.js', 'test/e2e/task20-fixtures.js', 'test/e2e/task20-accessibility.spec.js', 'playwright.config.js', 'public/governance-ui.js', 'src/capability-registry.js']) {
  assert(syntaxGate.includes(source), `syntax gate missing ${source}`);
}
for (const source of ['src/provider-file-mutations.js', 'test/gitea-file-mutations.test.js', 'test/gitea-file-mutation-server.test.js', 'test/fixtures/gitea-provider-fetch.js']) {
  assert(syntaxGate.includes(source), `syntax gate missing ${source}`);
}
const verifyScript = read('scripts/verify.js');
for (const artifact of [
  ...phaseOneGovernanceHistory,
  'docs/history/phase-1/reports/PHASE_1_TASK_21_REPORT.md',
  'PUBLIC_ALPHA_PROVENANCE.json', 'config/public-alpha-capabilities.json', 'src/capability-registry.js',
  'docs/current/ROADMAP.md', 'docs/vision/PRODUCT_VISION.md',
  'docs/current/PROVIDER_CAPABILITIES.md', 'docs/architecture/ARCHITECTURE.md',
  'docs/release/RELEASE_SECURITY_GATES.md', 'docs/release/PUBLIC_ALPHA.md',
  'docs/vision/UX_VISION.md', 'docs/release/EVIDENCE_INDEX.md',
  'test/public-alpha-provenance.test.js', 'test/capability-registry.test.js',
  'test/capability-registry-server-contract.test.js', 'test/public-alpha-documentation.test.js',
  'src/governance-templates.js', 'src/governance-digital-twin.js', 'src/governance-interface.js', 'src/mutation-coverage.js', 'src/governance-delivery.js', 'src/governance-webhook-worker.js', 'public/governance-ui.js',
  'src/control-catalog.js', 'src/governance-enforcement.js',
  'db/migrations/010_governance_activation_evidence.sql', 'db/migrations/011_governance_policy_decisions.sql'
]) {
  assert(verifyScript.includes(artifact), `build verification missing ${artifact}`);
}
const stagingValidation = read('src/staging-validation.js');
assert(stagingValidation.includes("const EVIDENCE_SCHEMA_VERSION = '1.2.0'"));
assert(stagingValidation.includes('expectedSubjectHash is required'));
assert(stagingValidation.includes('evidence requires at least one artifact file'));
assert(stagingValidation.includes('verifyArtifact is required when evidence contains artifacts'));
assert(stagingValidation.includes('commandHash does not match the prescribed command'));
const stagingCli = read('scripts/staging-gate.js');
assert(stagingCli.includes('NV_STAGING_SUBJECT_SHA256'));
assert(stagingCli.includes('evidence subjectHash does not match NV_STAGING_SUBJECT_SHA256'));
assert(stagingCli.includes('artifact hash mismatch'));
assert(stagingCli.includes('regular non-symlink file'));
assert.strictEqual(pkg.scripts['test:matrix'], 'node scripts/test-matrix.js --allow-missing-dependencies');
assert.strictEqual(pkg.scripts['test:runtime:matrix'], 'node scripts/test-matrix.js --require-all');
assert.strictEqual(
  pkg.scripts['test:public-alpha:matrix'],
  'node scripts/test-matrix.js --require-all --require-subject --report staging/evidence/public-alpha-matrix.json'
);
const publicAlphaQualificationArtifacts = [
  'src/secret-scanner.js',
  'scripts/check-secrets.js',
  'src/qualification-evidence.js',
  'src/public-alpha-qualification.js',
  'scripts/public-alpha-gate.js',
  'scripts/qualify-candidate-archive.js',
  'staging/PUBLIC_ALPHA_EVIDENCE_TEMPLATE.json',
  'test/helpers/public-alpha-pass-fixture.js',
  'ci/provider-alpha17-common.js',
  'ci/alpha17-fixtures.js',
  'ci/run-github-alpha17-validation.js',
  'ci/run-gitlab-alpha17-validation.js',
  'ci/run-gitea-alpha17-validation.js',
  'ci/run-hosted-alpha17-validation.js',
  'ci/run-alpha17-restore-validation.js',
  'ci/verify-alpha17-authorization.js',
  '.github/workflows/public-alpha-alpha17.yml',
  'docs/qualification/PUBLIC_ALPHA_KNOWN_LIMITATIONS.md',
  'docs/qualification/PUBLIC_ALPHA_COHORT_CHECKLIST.md'
];
const publicAlphaQualificationTests = [
  'test/secret-scanner.test.js',
  'test/qualify-candidate-archive.test.js',
  'test/public-alpha-qualification.test.js',
  'test/public-alpha-qualification-contract.test.js',
  'test/public-alpha-gate-cli.test.js',
  'test/alpha17-provider-harness.test.js',
  'test/alpha17-hosted-harness.test.js',
  'test/public-alpha-workflow-contract.test.js',
  'test/alpha17-restore-runner.test.js'
];
const publicAlphaQualificationSyntax = publicAlphaQualificationArtifacts.filter(
  artifact => artifact.endsWith('.js') && !artifact.startsWith('test/')
);
for (const artifact of [...publicAlphaQualificationArtifacts, ...publicAlphaQualificationTests]) {
  assert(fs.existsSync(path.join(root, artifact)), `public-alpha qualification artifact missing ${artifact}`);
  assert(verifyScript.includes(`'${artifact}'`), `build verification missing ${artifact}`);
}
let previousQualificationProgram = -1;
const qualificationUnitGate = `${pkg.scripts['test:unit']} ${pkg.scripts['posttest:unit'] || ''}`;
for (const program of publicAlphaQualificationTests) {
  const programIndex = qualificationUnitGate.indexOf(`node ${program}`);
  assert(programIndex > previousQualificationProgram, `test:unit missing or misorders ${program}`);
  previousQualificationProgram = programIndex;
}
for (const source of publicAlphaQualificationSyntax) {
  assert(syntaxChecks(source), `syntax gate missing ${source}`);
}
const alpha17Workflow = read('.github/workflows/public-alpha-alpha17.yml');
assert(alpha17Workflow.includes('node scripts/qualify-candidate-archive.js'));
assert(alpha17Workflow.includes('${RUNNER_TEMP}/automated-evidence/public-alpha-matrix.json'));
assert(
  pkg.scripts['test:unit'].includes('node test/provider-route-inventory.test.js'),
  'full unit gate must run the exhaustive provider route inventory'
);
assert(read('docs/operations/DEPLOY_RENDER_NEON.md').includes('Nebulaverse-X'));
assert(read('docs/operations/DEPLOY_RENDER_NEON.md').includes('NV_GOVERNANCE_AUDIT_SECRET'));
const { shouldInclude } = require('../scripts/package-release');
for (const forbidden of [
  '.env', '.env.production', 'config/.env.example',
  '.git/config', '.hg/store/x', '.svn/wc.db', '.superpowers/review.md',
  '.agents/state.json', '.codex/state.json', '.cache/tool.bin', '.npm/cache.bin',
  '.yarn/cache/pkg.zip', '.pnpm-store/pkg', '.turbo/state', '.next/server.js',
  'node_modules/x.js', 'bower_components/x.js', 'coverage/index.html',
  'dist/server.js', 'build/server.js', 'out/server.js', 'tmp/upload.bin',
  '.tmp/upload.bin', 'temp/upload.bin', '.temp/upload.bin',
  'playwright-report/index.html', 'test-results/result.json',
  'debug.log', 'release.zip', 'release.zip.sha256',
  '.DS_Store', 'assets/._server.js', '__MACOSX/x',
  'staging/evidence/runtime.json',
  'evidence/Nebulaverse-X-v5.3.0-alpha.17.0-Public-Alpha-Qualification.json',
  'reports/Nebulaverse-X-v5.3.0-alpha.17.0-Public-Alpha-Closeout.md',
  'logs/provider-credential.log',
  'backups/db-backup-manifest.json'
]) assert.strictEqual(shouldInclude(forbidden), false, forbidden);
for (const allowed of [
  'server.js', '.env.example', '.gitignore', '.github/workflows/ci.yml',
  'public/app.js', 'public/vendor/marked/15.0.12/marked.min.js',
  ...task6Artifacts
]) assert.strictEqual(shouldInclude(allowed), true, allowed);

const hostedOperationsSources = [
  'src/hosted-readiness.js',
  'src/backup-format.js',
  'scripts/alpha-db.js',
  'scripts/alpha-smoke.js',
  'scripts/alpha-load.js'
];
const hostedOperationsTests = [
  'test/hosted-readiness.test.js',
  'test/hosted-readiness-server-contract.test.js',
  'test/backup-format.test.js',
  'test/alpha-db-cli.test.js',
  'test/alpha-smoke.test.js',
  'test/alpha-load.test.js',
  'test/render-public-alpha-contract.test.js',
  'test/runbook-contract.test.js'
];
const hostedOperationsRunbooks = [
  'docs/operations/runbooks/01-service-cold-start-outage.md',
  'docs/operations/runbooks/02-neon-outage-quota.md',
  'docs/operations/runbooks/03-provider-outage-rate-limit.md',
  'docs/operations/runbooks/04-credential-exposure.md',
  'docs/operations/runbooks/05-orphan-cleanup.md',
  'docs/operations/runbooks/06-failed-deploy-rollback.md',
  'docs/operations/runbooks/07-database-backup-restore.md',
  'docs/operations/runbooks/08-tester-revocation-deletion.md',
  'docs/operations/runbooks/09-capacity-saturation.md',
  'docs/operations/runbooks/10-alpha-shutdown.md',
  'docs/operations/runbooks/OPERATOR_CHECKLIST.md'
];
for (const artifact of [...hostedOperationsSources, ...hostedOperationsTests, ...hostedOperationsRunbooks]) {
  assert(fs.existsSync(path.join(root, artifact)), `hosted operations artifact missing ${artifact}`);
  assert(verifyScript.includes(artifact), `build verification missing ${artifact}`);
}
for (const program of hostedOperationsTests) {
  assert(pkg.scripts['test:unit'].includes(`node ${program}`), `test:unit missing ${program}`);
}
for (const source of hostedOperationsSources) {
  assert(syntaxChecks(source), `syntax gate missing ${source}`);
}

const publicAlpha = read('docs/release/PUBLIC_ALPHA.md');
assert(publicAlpha.includes('Local hosted-operations qualification'));
assert(publicAlpha.includes('Live Render/Neon qualification remains pending'));
assert(publicAlpha.includes('encrypted backup'));
assert(publicAlpha.includes('isolated restore'));
assert(publicAlpha.includes('/healthz') && publicAlpha.includes('/readyz'));
const architecture = read('docs/architecture/ARCHITECTURE.md');
assert(architecture.includes('verify-only hosted startup'));
assert(architecture.includes('external encrypted backup'));
assert(architecture.includes('isolated restore'));
const releaseSecurityGates = read('docs/release/RELEASE_SECURITY_GATES.md');
assert(releaseSecurityGates.includes('Local hosted-operations gate: passed'));
assert(releaseSecurityGates.includes('Live Render/Neon gate: pending'));
assert(read('docs/architecture/ARCHITECTURE_DECISIONS.md').includes(
  '## ADR-060 — Hosted-alpha migrations are backup-gated and verified by the web process'
));
console.log('package contract tests passed');
