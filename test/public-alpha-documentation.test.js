'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const section = (document, heading) => {
  const marker = `## ${heading}`;
  const start = document.indexOf(marker);
  assert.notStrictEqual(start, -1, `missing section ${marker}`);
  const next = document.indexOf('\n## ', start + marker.length);
  return document.slice(start, next === -1 ? document.length : next);
};

const canonicalFiles = [
  'docs/current/PROJECT_STATE.md',
  'docs/current/ROADMAP.md',
  'docs/current/PROVIDER_CAPABILITIES.md',
  'docs/vision/FOUNDER_VISION.md',
  'docs/vision/PRODUCT_VISION.md',
  'docs/vision/UX_VISION.md',
  'docs/architecture/ARCHITECTURE.md',
  'docs/architecture/ARCHITECTURE_DECISIONS.md',
  'docs/release/PUBLIC_ALPHA.md',
  'docs/release/RELEASE_SECURITY_GATES.md',
  'docs/release/QUALIFICATION_BASELINE.md',
  'docs/release/EVIDENCE_INDEX.md',
  'docs/operations/DEPLOY_RENDER_NEON.md',
  'docs/operations/SECURITY_DEPLOYMENT.md'
];
for (const file of canonicalFiles) {
  assert(fs.existsSync(path.join(root, file)), `missing canonical document ${file}`);
}

const state = read('docs/current/PROJECT_STATE.md');
assert(state.includes('Current authored version: **5.3.0-alpha.17.0**'));
assert(state.includes('Public alpha: **NO-GO**'));
assert(state.includes('The review-remediation successor is **not qualified**'));
assert(state.includes('1a3eba455b23c61d09060749d3041598e332b04bc5bbba9efd23b77ff41e34ed'));
for (const row of [
  '| Automated exact-archive qualification | Passed |',
  '| Independent review | Failed |',
  '| Live-provider qualification | Pending |',
  '| Hosted qualification | Pending |',
  '| Manual accessibility | Pending |',
  '| Final release | Pending |'
]) assert(state.includes(row), `project state missing gate row ${row}`);

const roadmap = read('docs/current/ROADMAP.md');
for (const phase of [
  'Phase 2 — Repository Trust Digital Twin',
  'Phase 3 — Verified Recovery Game Day',
  'Phase 4 — Organization-Wide Intelligence',
  'Phase 5 — Customer-Controlled Evidence Retention'
]) assert(roadmap.includes(phase), `roadmap missing ${phase}`);
assert(roadmap.includes('Public alpha: **NO-GO**'));
assert(roadmap.includes('independent-review remediation successor'));

const productVision = read('docs/vision/PRODUCT_VISION.md');
assert(productVision.includes(
  'Nebulaverse-X is a cross-provider repository security-governance and recovery platform with a capable Git workbench.'
));

const founderVision = read('docs/vision/FOUNDER_VISION.md');
for (const label of ['Implemented', 'Committed roadmap', 'Exploratory', 'Out of current scope']) {
  assert(founderVision.includes(`**${label}**`), `founder vision missing maturity label ${label}`);
}
for (const concept of [
  'Shadow Access Radar',
  'Protected Files',
  'Emergency Shield',
  'session containment',
  'read-only',
  'freeze',
  'recovery snapshots',
  'game day',
  'open-source intelligence',
  'customer-controlled evidence',
  'GitHub',
  'GitLab',
  'Gitea'
]) assert(founderVision.toLowerCase().includes(concept.toLowerCase()), `founder vision missing ${concept}`);
assert(founderVision.includes('Vision is not qualification evidence'));
assert(founderVision.includes('../current/PROJECT_STATE.md'));
assert(founderVision.includes('../current/ROADMAP.md'));
assert(founderVision.includes('../release/RELEASE_SECURITY_GATES.md'));

const capabilities = read('docs/current/PROVIDER_CAPABILITIES.md');
for (const term of ['Supported', 'Experimental', 'Unavailable', 'Provider-verified', 'Deterministic']) {
  assert(capabilities.includes(term), `capability documentation missing ${term}`);
}
for (const provider of ['GitHub', 'GitLab', 'Gitea']) assert(capabilities.includes(provider));

const providerMappings = {
  'GitHub — complete intended golden path': [
    ['Supported', 'repository, commit, branch, and GitHub rate-limit reads; controlled branch writes; tree and file read/write/delete/rename; bounded file batch; pull-request and issue read/write; workflow reads; release reads; bounded search; notifications; star read/write; folder move; live events; access-surface analysis; dependency audit; recovery; governance; upload security'],
    ['Experimental', 'workflow rerun; release write; native push (16 MB on Render Free); Git LFS'],
    ['Unavailable', 'repository create/delete; global search']
  ],
  'GitLab — registry-qualified subset': [
    ['Supported', 'repository, commit, branch, tree, and file reads; bounded file write/delete; merge-request read; issue read; upload security'],
    ['Experimental', 'merge-request write; issue write; dependency audit; read-only recovery comparison; governance views'],
    ['Unavailable', 'repository create/delete; provider rate-limit read; branch write; file rename/batch; workflows; releases; search; notifications; stars; native push; Git LFS; folder move; live events; access-surface analysis']
  ],
  'Gitea — registry-qualified subset': [
    ['Supported', 'repository, commit, branch, tree, and file reads; expected-head single-file write/delete; upload security'],
    ['Experimental', 'dependency audit; read-only recovery comparison; governance views'],
    ['Unavailable', 'repository create/delete; provider rate-limit read; branch write; file rename/batch; pulls; issues; workflows; releases; search; notifications; stars; native push; Git LFS; folder move; live events; access-surface analysis']
  ]
};
for (const [providerHeading, mappings] of Object.entries(providerMappings)) {
  const providerSection = section(capabilities, providerHeading);
  for (const [status, expectedCapabilities] of mappings) {
    assert(
      providerSection.includes(`| ${status} | ${expectedCapabilities} |`),
      `${providerHeading} has an incorrect ${status} mapping`
    );
  }
  assert(providerSection.includes('`Provider-verified` evidence'));
  assert(providerSection.includes('`Deterministic` evidence'));
}
assert(/A `Supported` claim remains release-blocked until the exact\s+candidate has applicable live-provider and hosted evidence\./.test(capabilities));

const alpha = read('docs/release/PUBLIC_ALPHA.md');
assert(alpha.includes('Public alpha: **NO-GO**'));
assert(alpha.includes('5–10'));
assert(alpha.includes('sandbox'));
assert(alpha.includes('Render Free'));
assert(alpha.includes('Neon Free'));
assert(!/push(?:es)? of any size/i.test(alpha));
assert(alpha.includes(
  'The first cohort is invitation-only, limited to 5–10 testers, uses sandbox repositories only, and is not a production service.'
));

const releaseGates = read('docs/release/RELEASE_SECURITY_GATES.md');
assert(releaseGates.includes('Recorded automated baseline: **Passed**'));
assert(releaseGates.includes('Recorded independent review: **Failed**'));
assert(releaseGates.includes('Current review-remediation successor: **Not qualified**'));
assert(releaseGates.includes('141/141'));
assert(releaseGates.includes('56/56'));
assert(releaseGates.includes('zero production and development audit vulnerabilities'));
assert(releaseGates.includes('Live-provider gate: **Pending**'));
assert(releaseGates.includes('Hosted gate: **Pending**'));
assert(releaseGates.includes('Manual accessibility gate: **Pending**'));
assert(releaseGates.includes('Final release gate: **Pending**'));

const qualification = read('docs/release/QUALIFICATION_BASELINE.md');
assert(qualification.startsWith('# Recorded Alpha.17 Automated Qualification Baseline'));
for (const identity of [
  'c67d92edb8c63f11ada74cfdc7835f8a4b387a1c',
  'd6628de48a32c3a2790dabeec60ec7b7b2ebab49',
  '7bcc2c27029cc1013f176d1070e2cd38a8e69811',
  '1a3eba455b23c61d09060749d3041598e332b04bc5bbba9efd23b77ff41e34ed',
  '31494468827',
  '31494468853',
  '912555dd-72ab-4662-9645-2313007eea3d'
]) assert(qualification.includes(identity), `qualification baseline missing ${identity}`);
assert(qualification.includes('141/141 program tests'));
assert(qualification.includes('56/56 browser tests'));
assert(qualification.includes('zero vulnerabilities'));
assert(qualification.includes('16 actionable findings'));
assert(qualification.includes('public alpha are therefore **NO-GO**'));
assert(!qualification.includes('Task 21 is **in progress**'));

const evidence = read('docs/release/EVIDENCE_INDEX.md');
for (const identity of [
  '30464094438',
  '30464096155',
  '330b1b65894d1f63d7f4597cd81370d423fa66b60f69a4bb3a1a88084eca8892',
  'c67d92edb8c63f11ada74cfdc7835f8a4b387a1c',
  'd6628de48a32c3a2790dabeec60ec7b7b2ebab49',
  '1a3eba455b23c61d09060749d3041598e332b04bc5bbba9efd23b77ff41e34ed',
  '31321447041',
  '31494468827',
  '31494468853',
  '912555dd-72ab-4662-9645-2313007eea3d'
]) assert(evidence.includes(identity), `evidence index missing ${identity}`);
assert(evidence.includes('GitHub/GitLab'));
assert(evidence.includes('fresh Gitea'));
assert(evidence.includes('independent review failed'));
assert(evidence.includes('public-alpha NO-GO'));
assert(evidence.includes('prove only Plan 1 successor foundation work'));
assert(evidence.includes('do not prove hosted-public-alpha qualification'));

const deploy = read('docs/operations/DEPLOY_RENDER_NEON.md');
assert(deploy.startsWith('# Deploy Nebulaverse-X 5.3.0-alpha.17.0 Controlled Alpha'));
assert(deploy.includes('{ "version": "5.3.0-alpha.17.0", "product": "Nebulaverse-X", "releaseTreeSha256": "<64 lowercase hex characters>" }'));
for (const limit of [
  'NV_LIVE_CLIENTS_PER_REPO=2',
  'NV_LIVE_CLIENTS_TOTAL=10',
  'NV_SNAPSHOT_RETENTION_COUNT=10',
  'NV_SNAPSHOT_MANIFEST_MAX=5000',
  'NV_GIT_DATA_MAX_MB=16',
  'NV_NATIVE_PUSH_MAX_MB=16',
  'NV_UPLOAD_MAX_MB=25'
]) assert(deploy.includes(limit), `deployment guide missing controlled-alpha limit ${limit}`);

const security = read('docs/operations/SECURITY_DEPLOYMENT.md');
assert(security.includes('Nebulaverse-X 5.3.0-alpha.17.0 controlled alpha'));
assert(security.includes('verifies the expected migration set'));
assert(!security.includes('Task 4 does not yet evaluate governance policy'));
assert(!security.includes('GitHub-only in v5.2'));

const manualAccessibility = read('docs/qualification/accessibility/PUBLIC_ALPHA_MANUAL_AUDIT.md');
assert(manualAccessibility.includes('Start `/api/version` `releaseTreeSha256`'));
assert(manualAccessibility.includes('End `/api/version` `releaseTreeSha256`'));
assert(manualAccessibility.includes('responses are retained externally'));
assert.strictEqual((manualAccessibility.match(/320 CSS-pixel|400%/g) || []).length >= 4, true);

const decisions = read('docs/architecture/ARCHITECTURE_DECISIONS.md');
assert(decisions.includes('## ADR-055 — Controlled hosted alpha access is independent from provider authorization'));
assert(decisions.includes('## ADR-056 — Provider and deployment capability truth is server-owned and release-evidence-bound'));
const adr55 = section(
  decisions,
  'ADR-055 — Controlled hosted alpha access is independent from provider authorization'
);
assert(adr55.includes('**Status:** Accepted'));
assert(adr55.includes('An invitation proves cohort access only. It never grants repository access.'));
assert(adr55.includes('Provider authorization remains a separate boundary'));
assert(adr55.includes("tester's exact canonical repository allowlist"));
const adr56 = section(
  decisions,
  'ADR-056 — Provider and deployment capability truth is server-owned and release-evidence-bound'
);
assert(adr56.includes('**Status:** Accepted'));
assert(adr56.includes('One validated server-owned registry'));
assert(adr56.includes('browser consumes a read-only projection'));
assert(adr56.includes('server rejects unavailable operations before provider transport'));
assert(adr56.includes('A Supported public-alpha claim remains release-blocked'));

const currentTruth = canonicalFiles
  .map(file => `${file}\n${read(file)}`)
  .join('\n');
for (const [label, pattern] of [
  ['stale Task 21 status', /Task 21 is in progress/i],
  ['stale alpha.14 deployment label', /v5\.3\.0-alpha\.14/i],
  ['stale API version', /"version":\s*"5\.2\.2"/i],
  ['unlimited push claim', /push(?:es)? of any size/i],
  ['hosted-qualified claim', /Hosted public-alpha qualification:\s*\*\*(?:Qualified|Complete|Passed)\*\*/i],
  ['provider-parity claim', /(?:full|complete) provider (?:feature )?parity (?:is|has been) (?:available|achieved|complete)/i],
  ['production-readiness claim', /Nebulaverse-X (?:is|has been) (?:a )?production[- ]ready/i],
  ['unfinished marker', /\b(?:TODO|TBD|FIXME|PLACEHOLDER)\b/i]
]) {
  assert(!pattern.test(currentTruth), `current documentation contains ${label}`);
}

const phaseOneRoadmap = read('docs/history/phase-1/ROADMAP.md');
assert(phaseOneRoadmap.includes(
  '| 21 | v5.3 Release Readiness, Migration, Documentation and Packaging | Complete (alpha.16.3 qualified) |'
));

console.log('public alpha documentation tests passed');
