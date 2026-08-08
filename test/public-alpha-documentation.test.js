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
  'PROJECT_STATE.md', 'ROADMAP.md', 'PRODUCT_VISION.md', 'PROVIDER_CAPABILITIES.md',
  'ARCHITECTURE.md', 'RELEASE_SECURITY_GATES.md', 'PUBLIC_ALPHA.md', 'UX_VISION.md',
  'EVIDENCE_INDEX.md', 'ARCHITECTURE_DECISIONS.md'
];
for (const file of canonicalFiles) {
  assert(fs.existsSync(path.join(root, file)), `missing canonical document ${file}`);
}

const state = read('PROJECT_STATE.md');
assert(state.includes('Current successor version: **5.3.0-alpha.17.0**'));
assert(state.includes('Qualified predecessor: **5.3.0-alpha.16.3**'));
assert(state.includes('Task 21: **Qualified**'));
assert(state.includes('Hosted public-alpha qualification: **Pending**'));
assert(!state.includes('Task 21 is in progress'));

const statusMarkers = [
  'Current successor version: **5.3.0-alpha.17.0**',
  'Qualified predecessor: **5.3.0-alpha.16.3**',
  'Task 21: **Qualified**',
  'Hosted public-alpha qualification: **Pending**'
];
for (const file of [
  ...canonicalFiles.filter(file => file !== 'PROJECT_STATE.md'),
  'README.md'
]) {
  const document = read(file);
  for (const marker of statusMarkers) {
    assert(!document.includes(marker), `${file} duplicates current status marker ${marker}`);
  }
}

const readme = read('README.md');
assert.strictEqual(readme.match(/^# .+$/m)[0], '# ✦ Nebulaverse-X');
assert(
  /For current version and qualification status, see\s+\[`PROJECT_STATE\.md`\]\(PROJECT_STATE\.md\)\./.test(readme)
);
assert(!readme.includes('5.3.0-alpha.17.0'));
assert(!/qualified predecessor is\s+`?5\.3\.0-alpha\.16\.3/i.test(readme));
assert(!/Task 21 qualified/i.test(readme));
assert(!/qualified alpha checkpoint/i.test(readme));
assert(!/hosted public-alpha qualification for this successor is\s+pending/i.test(readme));

const currentDocumentation = section(readme, 'Current documentation');
const currentLinks = [...currentDocumentation.matchAll(/\]\(([^)]+)\)/g)].map(match => match[1]);
assert.deepStrictEqual(currentLinks, [
  'PROJECT_STATE.md',
  'ROADMAP.md',
  'PRODUCT_VISION.md',
  'PROVIDER_CAPABILITIES.md',
  'ARCHITECTURE.md',
  'RELEASE_SECURITY_GATES.md',
  'PUBLIC_ALPHA.md',
  'UX_VISION.md',
  'ARCHITECTURE_DECISIONS.md'
]);
const historicalEvidence = section(readme, 'Historical evidence');
assert.deepStrictEqual(
  [...historicalEvidence.matchAll(/\]\(([^)]+)\)/g)].map(match => match[1]),
  ['EVIDENCE_INDEX.md']
);

const roadmap = read('ROADMAP.md');
for (const phase of [
  'Phase 2 — Repository Trust Digital Twin',
  'Phase 3 — Verified Recovery Game Day',
  'Phase 4 — Organization-Wide Intelligence',
  'Phase 5 — Customer-Controlled Evidence Retention'
]) assert(roadmap.includes(phase), `roadmap missing ${phase}`);

const vision = read('PRODUCT_VISION.md');
assert(vision.includes(
  'Nebulaverse-X is a cross-provider repository security-governance and recovery platform with a capable Git workbench.'
));

const capabilities = read('PROVIDER_CAPABILITIES.md');
for (const term of ['Supported', 'Experimental', 'Unavailable', 'Provider-verified', 'Deterministic']) {
  assert(capabilities.includes(term), `capability documentation missing ${term}`);
}
assert(capabilities.includes('GitHub'));
assert(capabilities.includes('GitLab'));
assert(capabilities.includes('Gitea'));

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

const alpha = read('PUBLIC_ALPHA.md');
assert(alpha.includes('5–10'));
assert(alpha.includes('sandbox'));
assert(alpha.includes('Render Free'));
assert(alpha.includes('Neon Free'));
assert(!/push(?:es)? of any size/i.test(alpha));
assert(alpha.includes(
  'The first cohort is invitation-only, limited to 5–10 testers, uses sandbox repositories only, and is not a production service.'
));

const evidence = read('EVIDENCE_INDEX.md');
assert(evidence.includes('30464094438'));
assert(evidence.includes('30464096155'));
assert(evidence.includes('330b1b65894d1f63d7f4597cd81370d423fa66b60f69a4bb3a1a88084eca8892'));
assert(evidence.includes('GitHub/GitLab'));
assert(evidence.includes('fresh Gitea'));
for (const commit of [
  '0a26401e499c3d031b8af15dec6cfa286b8aa25b',
  '24d29c9100beb01263219afc2c4298d56ecc97fa',
  'a0bb77c7d08e0446eb849cd99f735e716be6535b',
  '5c96315b31222d99b242851b8a2ba13da7b635f1'
]) assert(evidence.includes(commit), `evidence index missing bounded foundation commit ${commit}`);
assert(evidence.includes('Task 4 report; commits'));
assert(evidence.includes('Task 5 report; commits'));
assert(evidence.includes('prove only Plan 1 successor foundation work'));
assert(evidence.includes('do not prove hosted-public-alpha qualification'));

const decisions = read('ARCHITECTURE_DECISIONS.md');
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

const currentTruth = [...canonicalFiles, 'README.md']
  .map(file => `${file}\n${read(file)}`)
  .join('\n');
for (const [label, pattern] of [
  ['stale Task 21 status', /Task 21 is in progress/i],
  ['unlimited push claim', /push(?:es)? of any size/i],
  ['hosted-qualified claim', /Hosted public-alpha qualification:\s*\*\*(?:Qualified|Complete|Passed)\*\*/i],
  ['hosted-qualified prose claim', /hosted public-alpha (?:is|has been) (?:qualified|complete|ready)/i],
  ['provider-parity status claim', /(?:Full )?Provider parity:\s*\*\*(?:Complete|Achieved|Supported)\*\*/i],
  ['provider-parity claim', /(?:full|complete) provider (?:feature )?parity (?:is|has been) (?:available|achieved|complete)/i],
  ['production-readiness claim', /(?:Production readiness|Production-ready):\s*\*\*(?:Qualified|Complete|Passed|Ready)\*\*/i],
  ['production-readiness prose claim', /Nebulaverse-X (?:is|has been) (?:a )?production[- ]ready/i],
  ['placeholder', /\b(?:TODO|TBD|FIXME|PLACEHOLDER)\b/i]
]) {
  assert(!pattern.test(currentTruth), `current documentation contains ${label}`);
}
console.log('public alpha documentation tests passed');
