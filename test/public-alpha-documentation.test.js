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
assert(state.includes('is **not qualified**'));
assert(state.includes('58adb78f3a5a4e51e65d0d53742a3ec1064cb950b0256d7210aeb2ad8259d711'));
for (const row of [
  '| Automated exact-archive qualification | Passed |',
  '| Independent review | Passed |',
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
  'GitHub — evidence-bounded alpha subset': [
    ['Supported', 'repository reads; branch reads and controlled writes; bounded file read/write/delete; provider rate-limit and tree reads; access-surface analysis; dependency audit; recovery; governance; upload security'],
    ['Experimental', 'file rename/batch; pull-request and issue read/write; workflow read/rerun; release read/write; bounded search; star read/write; native push (16 MB on Render Free); Git LFS; folder move; live events'],
    ['Unavailable', 'repository create/delete; global search; notifications']
  ],
  'GitLab — registry-qualified subset': [
    ['Supported', 'repository and branch reads; bounded file read/write/delete; upload security'],
    ['Experimental', 'tree read; merge-request and issue read/write; dependency audit; read-only recovery comparison; governance views'],
    ['Unavailable', 'repository create/delete; provider rate-limit read; branch write; file rename/batch; workflows; releases; search; notifications; stars; native push; Git LFS; folder move; live events; access-surface analysis']
  ],
  'Gitea — registry-qualified subset': [
    ['Supported', 'repository and branch reads; bounded file read/write/delete; upload security'],
    ['Experimental', 'tree read; dependency audit; read-only recovery comparison; governance views'],
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
assert(capabilities.includes('Every `Experimental` path requires an explicit UI and server-route opt-in.'));
assert(/recovery and governance\s+mutations remain blocked\./.test(capabilities));

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
/*
 * The bare phrase was the whole ambiguity: it read as Passed here and as failed
 * in ROADMAP, for the same words. "The recorded independent review" means the
 * review of the recorded baseline, which failed; a review that passed against a
 * later successor qualifies different bytes and is named as remediation. Both
 * halves are pinned so the two documents cannot drift apart again.
 */
assert(releaseGates.includes(
  "Recorded baseline's independent review: **Failed** — `912555dd-72ab-4662-9645-2313007eea3d`"
));
assert(releaseGates.includes(
  'Latest remediation review: **Passed** — `4d47a6a5-e9d9-4a92-8a59-3883615069e8`'
));
assert.doesNotMatch(releaseGates, /Recorded independent review: \*\*Passed\*\*/,
  'the bare phrase must not return: it contradicted ROADMAP for the same words');

const currentRoadmap = read('docs/current/ROADMAP.md');
assert(currentRoadmap.includes('912555dd-72ab-4662-9645-2313007eea3d'),
  'ROADMAP must name the baseline review it reports as failed');
assert.doesNotMatch(currentRoadmap, /independent review failed(?![\s\S]{0,200}912555dd)/,
  'ROADMAP must not report a failed review without naming which one');
assert(releaseGates.includes('Current successor: **Not qualified**'));
assert(releaseGates.includes('142/142'));
assert(releaseGates.includes('60/60'));
assert(releaseGates.includes('zero production and development audit vulnerabilities'));
assert(releaseGates.includes('Live-provider gate: **Pending**'));
assert(releaseGates.includes('Hosted gate: **Pending**'));
assert(releaseGates.includes('Manual accessibility gate: **Pending**'));
assert(releaseGates.includes('Final release gate: **Pending**'));
assert(releaseGates.includes('04b93d36-47ea-402d-abda-ca6dfb2a9290'));
assert(releaseGates.includes('30 actionable findings'));
assert(/18 inline actions plus 12\s+summary\/failed-post actions/.test(releaseGates));
assert(releaseGates.includes('4ae300c4-410c-4ae7-89cc-b7e15767d22e'));
assert(releaseGates.includes('4d47a6a5-e9d9-4a92-8a59-3883615069e8'));
assert(releaseGates.includes('15 actionable findings and 10 nitpicks'));

const qualification = read('docs/release/QUALIFICATION_BASELINE.md');
assert(qualification.startsWith('# Recorded Alpha.17 Automated Qualification Baseline'));
for (const identity of [
  '3995a81e64ced1011f7e5c0662307f270c67e2b8',
  '379f96daa85709bbc4c002f60501819690b00de2',
  'b0945a403beaa4c4242a1d6526aa7c3d80d48f08',
  '58adb78f3a5a4e51e65d0d53742a3ec1064cb950b0256d7210aeb2ad8259d711',
  '32540542681',
  '32540542682',
  '912555dd-72ab-4662-9645-2313007eea3d'
]) assert(qualification.includes(identity), `qualification baseline missing ${identity}`);
assert(qualification.includes('142/142 program tests'));
assert(qualification.includes('60/60 browser tests'));
assert(qualification.includes('zero vulnerabilities'));
assert(qualification.includes('16 actionable findings'));
assert(qualification.includes('**NO-GO**'), 'the recorded baseline must state the public-alpha position');
assert(!qualification.includes('Task 21 is **in progress**'));

const evidence = read('docs/release/EVIDENCE_INDEX.md');
for (const identity of [
  '30464094438',
  '30464096155',
  '330b1b65894d1f63d7f4597cd81370d423fa66b60f69a4bb3a1a88084eca8892',
  '3995a81e64ced1011f7e5c0662307f270c67e2b8',
  '379f96daa85709bbc4c002f60501819690b00de2',
  '58adb78f3a5a4e51e65d0d53742a3ec1064cb950b0256d7210aeb2ad8259d711',
  '31321447041',
  '32540542681',
  '32540542682',
  '912555dd-72ab-4662-9645-2313007eea3d'
]) assert(evidence.includes(identity), `evidence index missing ${identity}`);
assert(evidence.includes('GitHub/GitLab'));
assert(evidence.includes('fresh Gitea'));
/*
 * The baseline's own review failed; the remediation review passed. Pinning the
 * bare phrase "independent review passed" let the decision row read as though
 * the baseline itself had passed, and the test enforced that reading rather
 * than catching it. Assert both halves so neither can be dropped.
 */
/*
 * Release documents must cite the recorded baseline, not a string that once
 * looked like it. The prose carried `1a3eba45…` for some time; that prefix
 * resolves to no object in this repository, so the claim it anchored could not
 * be checked by a reader.
 *
 * Cross-checked against WORK_CONTINUITY.json rather than resolved through git,
 * because these tests also run inside the extracted candidate archive, which
 * has no repository metadata.
 */
const recordedCommits = JSON.parse(
  fs.readFileSync(path.join(root, 'WORK_CONTINUITY.json'), 'utf8')
).recordedBaseline.commits.map(entry => entry.commit);
const publicAlpha = read('docs/release/PUBLIC_ALPHA.md');
assert(
  recordedCommits.some(commit => publicAlpha.includes(commit)),
  'the public alpha document must cite a recorded baseline commit'
);
for (const candidate of publicAlpha.match(/`[0-9a-f]{8,40}…?`/g) || []) {
  const identifier = candidate.replace(/[`…]/g, '');
  assert(
    recordedCommits.some(commit => commit.startsWith(identifier)),
    `public alpha document cites an identifier that is not a recorded baseline: ${identifier}`
  );
}

assert(evidence.includes("this baseline's own independent review failed"));
assert(evidence.includes('the later remediation review passed'));
assert(evidence.includes('public-alpha NO-GO'));
assert(evidence.includes('prove only Plan 1 successor foundation work'));
assert(evidence.includes('do not prove hosted-public-alpha qualification'));
assert(evidence.includes('04b93d36-47ea-402d-abda-ca6dfb2a9290'));
assert(evidence.includes('4ae300c4-410c-4ae7-89cc-b7e15767d22e'));
assert(evidence.includes('4d47a6a5-e9d9-4a92-8a59-3883615069e8'));

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
assert(security.includes('server recomputes the authenticated session/account/repository scope'));
assert(security.includes('reviewed restore runner'));
assert(security.includes('forbidden from claiming `isolated-database-restore`'));

const reviewDispositions = read('docs/architecture/ALPHA17_REVIEW_DISPOSITIONS.md');
assert(/30\s+actionable findings and 9 nitpicks/.test(reviewDispositions));
assert(reviewDispositions.includes('15 actionable findings and 10 nitpicks'));
assert.strictEqual(
  (reviewDispositions.match(/^\| `PRRT_[^`]+` \|/gm) || []).length,
  15,
  'review ledger must retain every inline GitHub thread'
);
for (const finding of [
  'M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9', 'M10', 'F1', 'F2'
]) assert(reviewDispositions.includes(`| R3-${finding} |`), `review ledger missing ${finding}`);

const manualAccessibility = read('docs/qualification/accessibility/PUBLIC_ALPHA_MANUAL_AUDIT.md');
assert(manualAccessibility.includes('Start `/api/version` `releaseTreeSha256`'));
assert(manualAccessibility.includes('End `/api/version` `releaseTreeSha256`'));
assert(manualAccessibility.includes('responses are retained externally'));
const narrowViewportRequirementCount = (manualAccessibility.match(/320 CSS-pixel/g) || []).length;
const zoomRequirementCount = (manualAccessibility.match(/400%/g) || []).length;
assert(narrowViewportRequirementCount >= 4,
  `manual accessibility audit must state the 320 CSS-pixel boundary in setup, execution, and evidence; observed ${narrowViewportRequirementCount}`);
assert(zoomRequirementCount >= 4,
  `manual accessibility audit must state the 400% zoom boundary in setup, execution, and evidence; observed ${zoomRequirementCount}`);

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
  for (const file of canonicalFiles) {
    assert(!pattern.test(read(file)), `${file} contains ${label}`);
  }
}

const phaseOneRoadmap = read('docs/history/phase-1/ROADMAP.md');
assert(phaseOneRoadmap.includes(
  '| 21 | v5.3 Release Readiness, Migration, Documentation and Packaging | Complete (alpha.16.3 qualified) |'
));

console.log('public alpha documentation tests passed');
