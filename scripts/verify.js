'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const { PRODUCT_NAME, APP_VERSION, ASSET_VERSION } = require('../src/version');
const renderReleaseTemplate = value => value
  .replaceAll('__NV_PRODUCT_NAME__', PRODUCT_NAME)
  .replaceAll('__NV_VERSION__', APP_VERSION)
  .replaceAll('__NV_ASSET_VERSION__', ASSET_VERSION);
const must = (cond, msg) => { if (!cond) throw new Error(msg); };

const required = [
  'src/work-continuity.js', 'scripts/generate-continuity-docs.js', 'scripts/resume-work.js',
  'test/continuity-generation.test.js',
  'src/alpha-access.js', 'src/alpha-access-store.js', 'scripts/alpha-invites.js',
  'db/migrations/014_alpha_access.sql', 'test/alpha-access.test.js',
  'test/alpha-access-persistence-contract.test.js', 'test/alpha-access-store.test.js',
  'test/alpha-access-server-contract.test.js', 'test/alpha-repository-boundary.test.js',
  'test/alpha-invite-cli.test.js',
  'src/alpha-privacy.js', 'src/alpha-privacy-store.js', 'src/provider-disconnect.js',
  'scripts/alpha-privacy.js', 'db/migrations/015_alpha_privacy.sql',
  'test/alpha-privacy.test.js', 'test/alpha-privacy-persistence-contract.test.js',
  'test/alpha-privacy-store.test.js', 'test/provider-disconnect.test.js',
  'test/provider-disconnect-server-contract.test.js',
  'test/alpha-provider-session-lifecycle.test.js',
  'test/alpha-provider-webhook-lifecycle.test.js',
  'test/alpha-privacy-server-contract.test.js', 'test/alpha-browser-purge.test.js',
  'test/alpha-privacy-cli.test.js',
  'src/public-errors.js', 'public/alpha-ui.js', 'public/capability-ui.js', 'public/trust-ui.js',
  'test/public-errors.test.js', 'test/public-errors-server-contract.test.js',
  'test/alpha-ui-contract.test.js', 'test/capability-ui-contract.test.js', 'test/trust-ui-contract.test.js',
  'test/e2e/public-alpha-fixtures.js', 'test/e2e/public-alpha-golden-path.spec.js',
  'test/e2e/public-alpha-states.spec.js', 'test/e2e/public-alpha-accessibility.spec.js',
  'docs/qualification/accessibility/PUBLIC_ALPHA_MANUAL_AUDIT.md',
  'src/secret-scanner.js', 'scripts/check-secrets.js',
  'src/qualification-evidence.js', 'src/public-alpha-qualification.js',
  'scripts/public-alpha-gate.js', 'scripts/qualify-candidate-archive.js',
  'staging/PUBLIC_ALPHA_EVIDENCE_TEMPLATE.json',
  'test/helpers/public-alpha-pass-fixture.js',
  'test/public-alpha-qualification.test.js',
  'test/public-alpha-qualification-contract.test.js',
  'test/public-alpha-gate-cli.test.js',
  'test/secret-scanner.test.js', 'test/qualify-candidate-archive.test.js',
  'ci/provider-alpha17-common.js', 'ci/alpha17-fixtures.js',
  'ci/run-github-alpha17-validation.js',
  'ci/run-gitlab-alpha17-validation.js',
  'ci/run-gitea-alpha17-validation.js',
  'ci/run-hosted-alpha17-validation.js',
  'ci/verify-alpha17-authorization.js',
  'test/alpha17-provider-harness.test.js',
  'test/alpha17-hosted-harness.test.js',
  'test/public-alpha-workflow-contract.test.js',
  '.github/workflows/public-alpha-alpha17.yml',
  'docs/qualification/PUBLIC_ALPHA_KNOWN_LIMITATIONS.md',
  'docs/qualification/PUBLIC_ALPHA_COHORT_CHECKLIST.md',
  'src/hosted-readiness.js', 'src/backup-format.js',
  'scripts/alpha-db.js', 'scripts/alpha-smoke.js', 'scripts/alpha-load.js',
  'test/hosted-readiness.test.js', 'test/hosted-readiness-server-contract.test.js',
  'test/backup-format.test.js', 'test/alpha-db-cli.test.js',
  'test/alpha-smoke.test.js', 'test/alpha-load.test.js',
  'test/render-public-alpha-contract.test.js', 'test/runbook-contract.test.js',
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
  'docs/operations/runbooks/OPERATOR_CHECKLIST.md',
  'src/provider-file-mutations.js', 'PUBLIC_ALPHA_PROVENANCE.json', 'config/public-alpha-capabilities.json', 'src/capability-registry.js', 'docs/current/ROADMAP.md', 'docs/vision/PRODUCT_VISION.md', 'docs/current/PROVIDER_CAPABILITIES.md', 'docs/architecture/ARCHITECTURE.md', 'docs/release/RELEASE_SECURITY_GATES.md', 'docs/release/PUBLIC_ALPHA.md', 'docs/vision/UX_VISION.md', 'docs/release/EVIDENCE_INDEX.md', 'test/public-alpha-provenance.test.js', 'test/capability-registry.test.js', 'test/capability-registry-server-contract.test.js', 'test/public-alpha-documentation.test.js',
  'server.js', 'package.json', 'package-lock.json', 'render.yaml', 'README.md', 'docs/README.md', 'docs/DOCUMENTATION_MANIFEST.json', 'docs/current/PROJECT_STATE.md', 'docs/history/phase-1/ROADMAP.md', 'docs/architecture/ARCHITECTURE_DECISIONS.md', 'docs/current/CONTINUATION_PROMPT.md', 'docs/history/phase-1/reports/PHASE_1_TASK_5_REPORT.md', 'docs/history/phase-1/reports/PHASE_1_TASK_6_7_REPORT.md', 'docs/history/phase-1/reports/PHASE_1_TASK_8_REPORT.md', 'docs/history/phase-1/specifications/TASK_8_REVIEWER_ASSIGNMENT_APPROVAL_SPEC.md', 'docs/history/phase-1/reports/PHASE_1_TASK_9_10_REPORT.md', 'docs/history/phase-1/specifications/TASK_9_10_POLICY_SIMULATION_SPEC.md', 'docs/history/phase-1/reports/PHASE_1_TASK_11_REPORT.md', 'docs/history/phase-1/specifications/TASK_11_POLICY_ACTIVATION_ROLLBACK_SPEC.md', 'docs/history/phase-1/reports/PHASE_1_TASK_12_13_REPORT.md', 'docs/history/phase-1/specifications/TASK_12_13_GATEWAY_POLICY_ENFORCEMENT_SPEC.md', 'docs/history/phase-1/reports/PHASE_1_TASK_14_REPORT.md', 'docs/history/phase-1/specifications/TASK_14_EXCEPTION_WAIVER_EXPIRY_SPEC.md', 'docs/history/phase-1/reports/PHASE_1_TASK_15_16_REPORT.md', 'docs/history/phase-1/specifications/TASK_15_16_POLICY_TEMPLATES_DIGITAL_TWIN_SPEC.md', 'docs/history/phase-1/reports/PHASE_1_TASK_17_REPORT.md', 'docs/history/phase-1/specifications/TASK_17_POLICY_DIGITAL_TWIN_INTERFACE_SPEC.md', 'docs/history/phase-1/reports/PHASE_1_TASK_18_REPORT.md', 'docs/history/phase-1/specifications/TASK_18_FULL_MUTATION_COVERAGE_BULK_GOVERNANCE_SPEC.md', 'docs/history/phase-1/reports/PHASE_1_TASK_19_REPORT.md', 'docs/history/phase-1/specifications/TASK_19_GOVERNANCE_DELIVERY_SIGNED_EXPORTS_SPEC.md', 'docs/history/phase-1/reports/PHASE_1_TASK_20_REPORT.md', 'docs/history/phase-1/specifications/TASK_20_STAGING_VALIDATION_SPEC.md', 'docs/history/phase-1/reports/PHASE_1_TASK_21_REPORT.md', 'docs/superpowers/specs/2026-07-22-provider-authorization-resolver-design.md', 'docs/superpowers/plans/2026-07-22-provider-authorization-resolver.md',
  'public/index.html', 'public/governance-ui.js', 'public/offline-cache-policy.js', 'public/archive-safety.js', 'public/export-safety.js', 'public/app.js', 'public/neural.js', 'public/style.css', 'public/sw.js',
  'src/intelligence.js', 'src/file-security.js', 'src/config.js', 'src/version.js', 'src/migrations.js', 'src/security-foundation.js', 'src/authorization-resolver.js', 'src/github-app.js', 'src/provider-credentials.js', 'src/governance-model.js', 'src/governance-store.js', 'src/governance-api.js', 'src/governance-simulation.js', 'src/control-catalog.js', 'src/governance-enforcement.js', 'src/governance-exceptions.js', 'src/governance-templates.js', 'src/governance-digital-twin.js', 'src/governance-interface.js', 'src/mutation-coverage.js', 'src/staging-validation.js', 'src/test-matrix.js', 'db/migrations/001_sessions.sql', 'db/migrations/002_security.sql', 'db/migrations/003_intelligence.sql', 'db/migrations/004_recovery.sql', 'db/migrations/005_evidence.sql', 'db/migrations/006_github_app.sql', 'db/migrations/007_governance.sql', 'db/migrations/008_governance_drafts.sql', 'db/migrations/009_governance_reviews.sql', 'db/migrations/010_governance_activation_evidence.sql', 'db/migrations/011_governance_policy_decisions.sql', 'db/migrations/013_governance_notifications_exports.sql', 'db/migrations/012_governance_exceptions.sql', 'scripts/copy-vendor.js', 'scripts/staging-gate.js', 'scripts/test-matrix.js', 'staging/TASK_20_EVIDENCE_TEMPLATE.json', 'playwright.config.js', 'test/e2e/task20-fixtures.js', 'test/e2e/task20-accessibility.spec.js', 'test/staging-validation.test.js', 'test/staging-validation-contract.test.js', 'test/staging-validation-cli.test.js', 'test/test-matrix.test.js', 'test/intelligence.test.js', 'test/config-startup.test.js', 'test/archive-safety.test.js', 'test/export-safety.test.js', 'test/file-security.test.js', 'test/hardening-contract.test.js', 'test/security-foundation.test.js', 'test/security-foundation-contract.test.js', 'test/security-foundation-server.test.js', 'test/authorization-resolver.test.js', 'test/authorization-resolver-server-contract.test.js', 'test/governance-model.test.js', 'test/governance-persistence-contract.test.js', 'test/governance-store.test.js', 'test/governance-review-model.test.js', 'test/governance-review-persistence-contract.test.js', 'test/governance-review-store.test.js', 'test/governance-review-api.test.js', 'test/governance-templates.test.js', 'test/governance-digital-twin.test.js', 'test/governance-digital-twin-store.test.js', 'test/governance-template-digital-twin-api.test.js', 'test/governance-template-digital-twin-server-contract.test.js', 'test/governance-interface-access.test.js', 'test/governance-interface-server-contract.test.js', 'test/governance-interface-renderer.test.js', 'test/governance-interface-client-contract.test.js', 'test/governance-interface-workflow-contract.test.js', 'test/governance-interface-ui-contract.test.js', 'test/mutation-coverage.test.js', 'test/mutation-coverage-server-contract.test.js', 'test/mutation-gateway-execution.test.js', 'test/server-smoke.test.js',
  'public/vendor/codemirror/5.65.16/codemirror.min.js', 'public/vendor/marked/15.0.12/marked.min.js', 'public/vendor/dompurify/3.4.13/purify.min.js'
];
for (const file of required) must(fs.existsSync(path.join(root, file)), `Missing ${file}`);

for (const file of [
  'server.js', 'src/work-continuity.js', 'scripts/generate-continuity-docs.js',
  'scripts/resume-work.js', 'src/alpha-access.js', 'src/alpha-access-store.js', 'scripts/alpha-invites.js',
  'src/alpha-privacy.js', 'src/alpha-privacy-store.js', 'src/provider-disconnect.js',
  'scripts/alpha-privacy.js', 'src/public-errors.js',
  'src/hosted-readiness.js', 'src/backup-format.js',
  'scripts/alpha-db.js', 'scripts/alpha-smoke.js', 'scripts/alpha-load.js',
  'src/secret-scanner.js', 'scripts/check-secrets.js',
  'src/qualification-evidence.js', 'src/public-alpha-qualification.js',
  'scripts/public-alpha-gate.js', 'scripts/qualify-candidate-archive.js',
  'ci/provider-alpha17-common.js', 'ci/alpha17-fixtures.js',
  'ci/run-github-alpha17-validation.js', 'ci/run-gitlab-alpha17-validation.js',
  'ci/run-gitea-alpha17-validation.js', 'ci/run-hosted-alpha17-validation.js',
  'ci/verify-alpha17-authorization.js',
  'public/offline-cache-policy.js', 'public/archive-safety.js', 'public/export-safety.js',
  'public/alpha-ui.js', 'public/capability-ui.js', 'public/trust-ui.js',
  'public/app.js', 'public/governance-ui.js', 'public/neural.js'
]) {
  new vm.Script(read(file), { filename: file });
}
new vm.Script(renderReleaseTemplate(read('public/sw.js')), { filename: 'public/sw.js' });

const htmlSource = read('public/index.html');
const html = renderReleaseTemplate(htmlSource);
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
must(!duplicates.length, `Duplicate HTML IDs: ${[...new Set(duplicates)].join(', ')}`);
for (const id of [
  'tab-neural', 'neuralCanvas', 'neuralInspector', 'neuralTimeline',
  'neuralEmergencyBtn', 'neuralModeList', 'neuralRiskScore', 'neuralLiveBtn', 'neuralExplainBtn'
]) must(ids.includes(id), `Missing #${id}`);
must(/ensureNeural\(\)/.test(read('public/app.js')) && /neural\.js\?v=/.test(read('public/app.js')),
  'Neural module is not wired for lazy loading in app.js');
must(/\/neural\.js\?v=/.test(read('public/sw.js')), 'Neural module is not precached by the service worker');
must(html.includes('data-tab="neural"'), 'Desktop Neural tab missing');
must(html.includes('data-act="neural"'), 'Mobile Neural entry missing');


for (const id of ['tab-governance', 'govRoot', 'govLive']) must(ids.includes(id), `Missing #${id}`);
must(html.includes('data-tab="governance"') && html.includes('data-act="governance"'), 'Governance desktop/mobile navigation missing');
must(html.includes('/governance-ui.js?v=') && read('public/sw.js').includes('/governance-ui.js?v='), 'Governance renderer must be loaded and precached');
must(/\/governance/.test(read('public/offline-cache-policy.js')), 'Governance APIs must remain network-only');
must(read('server.js').includes('projectGovernanceInterfaceAccess') && read('server.js').includes('res.json({ digitalTwin, access })'), 'Digital Twin access projection is not wired');


const pkg = JSON.parse(read('package.json'));
const accessPrograms = [
  'test/alpha-access.test.js',
  'test/alpha-access-persistence-contract.test.js',
  'test/alpha-access-store.test.js',
  'test/alpha-access-server-contract.test.js',
  'test/alpha-repository-boundary.test.js',
  'test/alpha-invite-cli.test.js'
];
let previousAccessProgram = -1;
for (const program of accessPrograms) {
  const programIndex = pkg.scripts?.['test:unit']?.indexOf(`node ${program}`) ?? -1;
  must(programIndex > previousAccessProgram, `Unit gate must execute ${program} in deterministic access order`);
  previousAccessProgram = programIndex;
}
for (const source of ['src/alpha-access.js', 'src/alpha-access-store.js', 'scripts/alpha-invites.js']) {
  must(pkg.scripts?.['check:syntax']?.includes(`node --check ${source}`), `Syntax gate missing ${source}`);
}
const qualificationTests = [
  'test/public-alpha-qualification.test.js',
  'test/public-alpha-qualification-contract.test.js',
  'test/public-alpha-gate-cli.test.js',
  'test/alpha17-provider-harness.test.js',
  'test/alpha17-hosted-harness.test.js',
  'test/public-alpha-workflow-contract.test.js'
];
let previousQualificationTest = -1;
for (const program of qualificationTests) {
  const index = pkg.scripts?.['test:unit']?.indexOf(`node ${program}`) ?? -1;
  must(index > previousQualificationTest, `Unit gate missing or misorders ${program}`);
  previousQualificationTest = index;
}
must(
  pkg.scripts?.['test:public-alpha:matrix'] ===
    'node scripts/test-matrix.js --require-all --require-subject --report staging/evidence/public-alpha-matrix.json',
  'Subject-bound public-alpha matrix script is missing'
);
must(pkg.dependencies?.codemirror === '5.65.16', 'CodeMirror must be pinned and bundled');
must(pkg.dependencies?.marked === '15.0.12', 'Marked must be pinned to the Node 18-compatible browser build');
must(pkg.dependencies?.dompurify === '3.4.13', 'DOMPurify must be pinned to the patched browser build');
must(pkg.scripts?.postinstall === 'node scripts/copy-vendor.js', 'Vendor assets must be generated during deployment');
must(html.includes('/vendor/marked/15.0.12/marked.min.js'), 'Pinned Marked browser asset is not loaded');
must(html.includes('/vendor/dompurify/3.4.13/purify.min.js'), 'Pinned DOMPurify browser asset is not loaded');
/* version-agnostic: a stamp bump must never break the build contract */
const at = name => html.indexOf(name);
must(/\/archive-safety\.js\?v=\d+/.test(html), 'Secure archive validator is not loaded');
must(/\/export-safety\.js\?v=\d+/.test(html), 'Secure export helper is not loaded');
must(at('/archive-safety.js?v=') > -1 && at('/archive-safety.js?v=') < at('/app.js?v='), 'Archive validator must load before app.js');
must(at('/export-safety.js?v=') > -1 && at('/export-safety.js?v=') < at('/app.js?v='), 'Export safety helper must load before app.js');
const stamps = [...html.matchAll(/\?v=(\d+)/g)].map(m => m[1]);
must(new Set(stamps).size === 1, `All asset stamps must match, found: ${[...new Set(stamps)].join(', ')}`);
const renderedSw = renderReleaseTemplate(read('public/sw.js'));
must(renderedSw.includes(stamps[0]), 'Service worker version must match the HTML asset stamp');

const app = read('public/app.js');
must(app.includes("name === 'neural'"), 'Neural tab activation hook missing');
must(app.includes('window.NebulaNeural.deactivate'), 'Neural deactivation hook missing');
must(app.includes("label: 'Neural Command Center'"), 'Command palette entry missing');

const server = read('server.js');
must(server.includes("/api/security/sessions"), 'Session inventory endpoint missing');
must(server.includes("/api/security/revoke-others"), 'Session revocation endpoint missing');
must(server.includes("/api/security/csrf"), 'CSRF security-context endpoint missing');
must(server.includes("/api/security/step-up"), 'Step-up authorization endpoint missing');
must(server.includes('consumePendingStepUp') && server.includes('USED_STEP_UP_GRANTS'), 'Single-use step-up replay prevention missing');
must(server.includes("require('./src/version')"), 'server must import the package-backed version module');

const render = read('render.yaml');
must(/\bplan:\s*free\b/.test(render), 'Render web service is not on the free plan');
must(!/^databases:/m.test(render), 'A Render-managed database must not be added');
must(!/fromDatabase:/.test(render), 'Blueprint must continue using the existing optional Neon DATABASE_URL');
const envExample = read('.env.example');
must(/^NV_ALPHA_ACCESS_MODE=off$/m.test(envExample), '.env.example must default alpha access off');
must(/^NV_ALPHA_INVITE_PEPPER=$/m.test(envExample), '.env.example must keep the invite pepper empty');
must(/^NV_ALPHA_TERMS_VERSION=2026-07-29$/m.test(envExample), '.env.example has a stale alpha terms version');
must(/- key: NV_ALPHA_ACCESS_MODE\n\s+value: invite/.test(render), 'Render must enable invitation access');
must(/- key: NV_ALPHA_INVITE_PEPPER\n\s+sync: false/.test(render), 'Render must require an operator-supplied invite pepper');
must(/- key: NV_ALPHA_TERMS_VERSION\n\s+value: 2026-07-29/.test(render), 'Render has a stale alpha terms version');
must(/- key: DATABASE_URL\n\s+sync: false/.test(render), 'Render must require an operator-supplied DATABASE_URL');
must(!/fromDatabase:/.test(render), 'Render must not provision or bind a managed database');

const sw = renderedSw;
must(/\/neural\.js\?v=\d+/.test(sw), 'Neural script is not precached');
must(/\/archive-safety\.js\?v=\d+/.test(sw), 'Secure archive validator is not precached');
must(/\/export-safety\.js\?v=\d+/.test(sw), 'Secure export helper is not precached');
/* Optional private repository caching must be explicit, scoped and bounded. */
const offlinePolicy = read('public/offline-cache-policy.js');
must(sw.includes("importScripts('/offline-cache-policy.js?v="), 'Service worker must load the audited offline cache policy');
must(sw.includes('POLICY.classifyApiRequest') && sw.includes('privateNetworkFirst'), 'Service worker must use the scoped cache classifier');
must(offlinePolicy.includes('MAX_ENTRIES = 100') && offlinePolicy.includes('MAX_RESPONSE_BYTES = 1024 * 1024') && offlinePolicy.includes('MAX_TOTAL_BYTES = 25 * 1024 * 1024'), 'Private cache limits are missing');
must(offlinePolicy.includes('TTL_MS = 24 * 60 * 60 * 1000'), 'Private cache TTL is missing');
must(/startsWith\('nv-api-'\)/.test(read('public/app.js')), 'Identity boundaries must purge scoped API caches');
must(sw.includes("cache: 'no-store'"), 'Network-only API responses must not use browser HTTP caches');
must(!sw.includes("const API = 'nv-api-perm'"), 'A shared persistent API cache must not exist');
must(offlinePolicy.includes("const CACHE_SCHEMA = 'v1'") && offlinePolicy.includes('nv-api-${CACHE_SCHEMA}-${scope}'), 'Private cache namespaces must be schema-versioned');
must(sw.includes("key === 'nv-api-perm'") && sw.includes("key === 'nv-api'"), 'Service worker upgrades must delete legacy shared API caches');
must(server.includes('/hooks/github/:hookId') && server.includes('verifyGithubSignature'), 'Verified GitHub webhook intake is missing');
must(server.includes("object-src 'none'") && server.includes("base-uri 'none'"), 'CSP active-content restrictions are incomplete');
must(server.includes('VENDOR_ALLOWLIST') && server.includes('GFONTS_ALLOWLIST'), 'Vendor proxy allowlists are missing');
must(server.includes("path.join(__dirname, 'public', 'vendor')") && server.includes('Exact allowlisted CDN fallback only'), 'Pinned local vendor assets are not served first');
must(server.includes('allowWebhookRequest') && server.includes('Webhook delivery rate exceeded'), 'Webhook abuse limiter is missing');
must(server.includes('/readyz'), 'Readiness endpoint is missing');
must(server.includes('normalizeDatabaseUrl') && server.includes('enableChannelBinding: true'), 'Strict database transport configuration is missing');
must(app.includes('Secure Markdown renderer is unavailable') && app.includes('DOMPurify.sanitize'), 'Markdown preview must fail closed and sanitize HTML');
must(app.includes('NebulaArchiveSafety') && app.includes('validateArchiveEntries(rawEntries)'), 'ZIP extraction must validate the central directory before decompression');
must(app.includes('actualTotal > validated.limits.maxTotalUncompressed'), 'ZIP extraction must enforce the actual extracted-size ceiling');
must(server.includes('/live-events/connect') && server.includes('/live-events/stream'), 'Live event registration or SSE streaming is missing');
const migrationSql = fs.readdirSync(path.join(root, 'db', 'migrations')).filter(name => name.endsWith('.sql')).sort().map(name => read('db/migrations/' + name)).join('\n');
must(migrationSql.includes('nv_evidence_chain') && server.includes('/evidence'), 'Tamper-evident export is missing');

must(migrationSql.includes('nv_governance_policies') && migrationSql.includes('nv_governance_policy_versions'), 'Governance persistence schema is missing');
must(migrationSql.includes('nv_governance_reject_history_mutation') && migrationSql.includes('BEFORE TRUNCATE'), 'Governance history must be append-only at the database layer');
const governanceStore = read('src/governance-store.js');
must(governanceStore.includes('GOVERNANCE_APPROVALS_REQUIRED') && governanceStore.includes('GOVERNANCE_REVISION_CONFLICT'), 'Governance activation gates are missing');
must(governanceStore.includes('pg_advisory_xact_lock') && governanceStore.includes('verifyGovernanceAuditChain'), 'Governance concurrency or audit-chain controls are missing');

must(migrationSql.includes('nv_security_state') && server.includes('loadPersistentSafety'), 'Persistent safety state is missing');
must(server.includes('runMigrations') && migrationSql.includes('nv_schema_migrations') === false, 'Server must use the numbered migration runner');
must(app.includes('Secure CSV exporter is unavailable') && app.includes('NebulaExportSafety.activityCsv'), 'CSV export must fail closed through the formula-safe helper');
must(app.includes('protectedPatternMatch') && app.includes('sgProtectPattern'), 'Wildcard protected-path UI is missing');
const neural = read('public/neural.js');
must(neural.includes('graphShortestPath') && neural.includes('Explain this connection'), 'Deterministic connection explanation is missing');
must(neural.includes('EventSource') && neural.includes('VERIFIED LIVE'), 'Neural verified live stream is missing');
must(neural.includes('catchUpIntelligence') && neural.includes('after=${encodeURIComponent(after)}'), 'Cursor-based Neural event catch-up is missing');
must(neural.includes('/emergency-manifest'), 'Signed Emergency Shield transaction is missing from the Neural client');
must(server.includes('/access-surface') && server.includes('riskForAccessSurface'), 'Shadow Access Radar is missing');
must(server.includes('/snapshot-compare') && server.includes('/restore-preview'), 'Snapshot comparison or restore preview is missing');
must(server.includes('scanUploadFile') && server.includes('MALWARE_DETECTED'), 'Upload malware gate is missing');
must(server.includes('normalizeFileBatch') && server.includes('summarizeBatchItems'), 'Task 18 aggregate mutation evidence is not wired');
const mutationCoverage = read('src/mutation-coverage.js');
must(mutationCoverage.includes('MUTATION_ROUTE_INVENTORY') && mutationCoverage.includes('ACTION_EXECUTION_CONTRACTS'), 'Task 18 mutation coverage inventory is missing');
must(read('src/governance-delivery.js').includes('MAX_EXPORT_EVENTS') && read('src/governance-webhook-worker.js').includes('startWebhookWorker'), 'Task 19 governance delivery foundation is missing');
must(read('public/governance-ui.js').includes('Notifications and signed evidence'), 'Task 19 governance delivery interface is missing');
must(read('src/mutation-gateway.js').includes('MUTATION_PROVIDER_WRITE_LIMIT') && read('src/mutation-gateway.js').includes('operationId'), 'Task 18 provider-write bounds or operation IDs are missing');
must(read('src/provider-file-mutations.js').includes('old_commit_id') &&
  read('src/provider-file-mutations.js').includes('/contents/'),
'Gitea file mutations must use the Contents API with expected-head compare-and-swap protection');

const stagingValidation = read('src/staging-validation.js');
must(stagingValidation.includes("EVIDENCE_SCHEMA_VERSION = '1.2.0'"), 'Task 20 evidence schema 1.2.0 is missing');
must(stagingValidation.includes('CATALOG_HASH') && stagingValidation.includes('expectedSubjectHash is required'), 'Task 20 evidence must bind to the exact catalog and release subject');
must(stagingValidation.includes('evidence requires at least one artifact file') && stagingValidation.includes('commandHash does not match the prescribed command'), 'Task 20 evidence is not command/file-artifact bound');
must(read('scripts/staging-gate.js').includes('NV_STAGING_SUBJECT_SHA256') && read('scripts/staging-gate.js').includes('versioned object envelope') && read('scripts/staging-gate.js').includes('artifact hash mismatch'), 'Task 20 staging CLI is not fail-closed');
must(read('scripts/test-matrix.js').includes('--allow-missing-dependencies') && read('src/test-matrix.js').includes('runTestMatrix'), 'Task 20 independent test matrix is missing');
const task20Browser = read('test/e2e/task20-accessibility.spec.js');
for (const signal of ['Shift+Tab', 'toBeFocused', 'setOffline(true)', "unroute('**/api/**')", 'data-act="governance"']) must(task20Browser.includes(signal), `Task 20 browser behavior missing: ${signal}`);

console.log('Nebulaverse-X build verification passed.');
