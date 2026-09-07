'use strict';

/*
 * The reader chooses the transport; the deployment only decides what it cannot
 * carry.
 *
 * Before this, the upload route read `lfs=auto|force`. `force` could insist on
 * Git LFS and nothing could insist on ordinary Git, because one line settled it
 * by size:
 *
 *   const useLfs = (lfsMode === 'force' || size > GIT_PUSH_MAX) && provider === 'github';
 *
 * So a file above the native push ceiling went to LFS whatever was asked for.
 * Someone who had been pushing 60-80 MB videos through ordinary Git had no way
 * left to say so.
 *
 * These assertions hold three things:
 *   1. the plan honours the request whenever the deployment can honour it;
 *   2. an impossible request falls back to the other transport and says so,
 *      rather than throwing away a transfer that already completed;
 *   3. the server and the browser both route through this one planner, so the
 *      label shown on a queued file and the transport actually used are one
 *      decision rather than two that agree by luck.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const planning = require('../public/upload-planning');
for (const name of ['TRANSPORT_CHOICES', 'normalizeTransportChoice', 'planUploadTransport']) {
  assert(planning[name], `${name} must be implemented`);
}
const { TRANSPORT_CHOICES, normalizeTransportChoice, planUploadTransport } = planning;

const MB = 1048576;
const GIT_PUSH_MAX = 64 * MB;
const GIT_DATA_MAX = 40 * MB;
const plan = (size, requested, lfsAvailable = true) => planUploadTransport({
  size, requested, lfsAvailable, gitPushMaxBytes: GIT_PUSH_MAX, gitDataMaxBytes: GIT_DATA_MAX
});

/* ---- 1. the three choices, and only those three ---- */

assert.deepStrictEqual([...TRANSPORT_CHOICES], ['auto', 'git', 'lfs']);
for (const choice of TRANSPORT_CHOICES) {
  assert.strictEqual(normalizeTransportChoice(choice), choice);
}
/* Anything unrecognised is automatic, never an accidental LFS conversion. */
for (const junk of ['', null, undefined, 'yes', 'true', 'LFS ', 'git-push', 42, {}]) {
  const normalized = normalizeTransportChoice(junk);
  assert(TRANSPORT_CHOICES.includes(normalized), `${String(junk)} must normalize to a real choice`);
}
assert.strictEqual(normalizeTransportChoice('nonsense'), 'auto');
/* The old wire value keeps working for callers that still send it. */
assert.strictEqual(normalizeTransportChoice('force'), 'lfs');
assert.strictEqual(normalizeTransportChoice('FORCE'), 'lfs');

/* ---- 2. the defect itself: a large file can be asked for over Git ---- */

/* The 80 MB video, under a ceiling raised to carry it. */
const raised = planUploadTransport({
  size: 80 * MB, requested: 'git', lfsAvailable: true,
  gitPushMaxBytes: 95 * MB, gitDataMaxBytes: GIT_DATA_MAX
});
assert.strictEqual(raised.route, 'git-push',
  'a large file asked for over ordinary Git must go over ordinary Git when the deployment can carry it');
assert.strictEqual(raised.fallback, null);
assert.strictEqual(raised.refusal, null);

/* And the same file under the old size rule is no longer silently converted. */
const small = plan(10 * MB, 'git');
assert.strictEqual(small.route, 'git-data');
const midsize = plan(50 * MB, 'git');
assert.strictEqual(midsize.route, 'git-push',
  'above the Git Data ceiling and below the push ceiling is a native push, not LFS');

/* ---- 3. the safe fallback, in both directions, always named ---- */

/* Asked for Git above what this deployment will push: LFS carries it and the
 * swap is reported. The bytes are already here; refusing would discard them. */
const overCeiling = plan(80 * MB, 'git');
assert.strictEqual(overCeiling.route, 'lfs');
assert(overCeiling.fallback, 'a transport swap must be reported, not performed quietly');
assert.strictEqual(overCeiling.fallback.from, 'git');
assert.strictEqual(overCeiling.fallback.to, 'lfs');
assert(/64 MB/.test(overCeiling.fallback.reason),
  'the reason must name the ceiling that caused the swap');
assert.strictEqual(overCeiling.refusal, null);

/* The reason quotes the ceiling it was given, not a number written down here. */
const otherCeiling = planUploadTransport({
  size: 200 * MB, requested: 'git', lfsAvailable: true,
  gitPushMaxBytes: 95 * MB, gitDataMaxBytes: GIT_DATA_MAX
});
assert(/95 MB/.test(otherCeiling.fallback.reason) && !/64 MB/.test(otherCeiling.fallback.reason),
  'the ceiling in the sentence must be the ceiling being enforced');

/* Asked for LFS where there is none, on a file Git can carry: Git carries it
 * and the swap is reported. */
const noLfs = plan(10 * MB, 'lfs', false);
assert.strictEqual(noLfs.route, 'git-data');
assert(noLfs.fallback && noLfs.fallback.from === 'lfs' && noLfs.fallback.to === 'git');
assert.strictEqual(noLfs.refusal, null);

/* ---- 4. a refusal only when neither transport can carry the file ---- */

const impossible = plan(80 * MB, 'git', false);
assert.strictEqual(impossible.route, null);
assert(impossible.refusal, 'nothing can carry this file, so it must be refused');
assert.strictEqual(impossible.refusal.status, 413);
assert(/64 MB/.test(impossible.refusal.message));
assert.strictEqual(plan(80 * MB, 'auto', false).refusal.status, 413);
assert.strictEqual(plan(80 * MB, 'lfs', false).refusal.status, 413);

/* An explicit choice is never refused for being merely inconvenient. */
for (const requested of TRANSPORT_CHOICES) {
  for (const size of [0, 1, MB, 39 * MB, 41 * MB, 63 * MB, 100 * MB, 900 * MB]) {
    const result = plan(size, requested, true);
    assert.strictEqual(result.refusal, null,
      `${requested} at ${size} bytes must not be refused while GitHub LFS is available`);
    assert(['git-data', 'git-push', 'lfs'].includes(result.route));
    assert.strictEqual(result.requested, requested);
  }
}

/* ---- 5. automatic still behaves as it always did ---- */

assert.strictEqual(plan(10 * MB, 'auto').route, 'git-data');
assert.strictEqual(plan(50 * MB, 'auto').route, 'git-push');
assert.strictEqual(plan(80 * MB, 'auto').route, 'lfs');
/* Automatic reaching LFS by the size rule is the plan, not a fallback. */
assert.strictEqual(plan(80 * MB, 'auto').fallback, null);

/* Exactly at a boundary is below it, not above it. */
assert.strictEqual(plan(GIT_DATA_MAX, 'auto').route, 'git-data');
assert.strictEqual(plan(GIT_DATA_MAX + 1, 'auto').route, 'git-push');
assert.strictEqual(plan(GIT_PUSH_MAX, 'auto').route, 'git-push');
assert.strictEqual(plan(GIT_PUSH_MAX + 1, 'auto').route, 'lfs');

/* ---- 6. a size the planner cannot reason about is an error, not a guess ---- */

for (const size of [-1, NaN, Infinity, 'big', null, undefined]) {
  assert.throws(() => plan(size, 'auto'), TypeError, `size ${String(size)} must be rejected`);
}
assert.throws(() => planUploadTransport({ size: MB, requested: 'auto', gitPushMaxBytes: 0, gitDataMaxBytes: GIT_DATA_MAX }), TypeError);
assert.throws(() => planUploadTransport({ size: MB, requested: 'auto', gitPushMaxBytes: GIT_PUSH_MAX, gitDataMaxBytes: 0 }), TypeError);

/* ---- 7. the server routes through the planner ---- */

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
assert(server.includes("require('./public/upload-planning')"), 'the server must load the shared planner');

const routeStart = server.indexOf("app.post('/api/repo/:owner/:repo/upload'");
const routeEnd = server.indexOf('async function uploadViaContents');
assert(routeStart > 0 && routeEnd > routeStart, 'the upload route must be locatable');
const route = server.slice(routeStart, routeEnd);

/* The choice arrives normalized, so an unknown value can never mean LFS. */
assert(route.includes('const transportChoice = normalizeTransportChoice(req.query.lfs);'),
  'the requested transport must be normalized by the shared planner');

/* One plan, made once, from this deployment's real ceilings. */
assert(route.includes('const plan = planUploadTransport({'), 'the route must plan the transport');
assert(/gitPushMaxBytes:\s*GIT_PUSH_MAX/.test(route), 'the plan must be made against the real native push ceiling');
assert(/gitDataMaxBytes:\s*CONTENTS_MAX/.test(route), 'the plan must be made against the real Git Data boundary');
assert(route.includes('if (plan.refusal) throw Object.assign(new Error(plan.refusal.message), { status: plan.refusal.status });'),
  'a refusal the plan names must be the refusal the reader is given');

/*
 * And that plan is the ONLY place in the route where a ceiling is consulted.
 *
 * This is the assertion that matters. Naming the old expression would only
 * forbid the old spelling; a second size comparison written any other way is
 * the same defect -- a decision made behind the reader's request. So the
 * ceilings may appear in the route once, as arguments to the planner, and
 * nowhere else.
 */
const planCall = route.slice(route.indexOf('const plan = planUploadTransport({'), route.indexOf('if (plan.refusal)'));
assert(planCall.length > 0);
const outsideThePlan = route.replace(planCall, '');
for (const ceiling of ['GIT_PUSH_MAX', 'CONTENTS_MAX', 'NATIVE_PUSH_MAX_MB']) {
  assert(!outsideThePlan.includes(ceiling),
    `the upload route must consult ${ceiling} only through the shared planner, never a second time on its own`);
}

/* Every transport the route can take is the one the plan chose. */
for (const selection of [
  "if (plan.route === 'git-push') {",
  "if (plan.route === 'lfs') { enforceProtectedPaths",
  "else if (plan.route === 'git-push') {"
]) {
  assert(route.includes(selection), `the route must select its transport with: ${selection}`);
}

/* And every upload that lands says how it was carried, on every provider path,
 * so a swap is never something the reader has to infer. */
const landings = route.match(/res\.json\(\{ ok: true[^\n]*\)/g) || [];
assert(landings.length >= 3, 'the upload route must have its success responses locatable');
for (const landing of landings) {
  assert(/\btransport\b/.test(landing), `a successful upload must report its transport: ${landing}`);
}

/* A swap the provider forces at run time is reported too, not only one the
 * plan predicted. */
assert(/transport\.fallback = transport\.fallback \|\|/.test(route),
  'the run-time ladder to LFS must report itself as a fallback');

/* ---- 8. the browser routes through the same planner ---- */

const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

/*
 * The label on a queued file is the server's decision read early, not a second
 * copy of it. Pinned to the exact call, because "the module is mentioned
 * somewhere in this file" is satisfied by a file that mentions it and then
 * decides for itself anyway.
 */
assert(app.includes('return NebulaUploadPlanning.planUploadTransport({'),
  'the browser must label a queued file with the shared planner');
assert(app.includes('gitPushMaxBytes: state.runtime.nativePushMaxMb * 1048576'),
  'the browser must plan against the ceiling the server publishes');
assert(app.includes('gitDataMaxBytes: state.runtime.contentsMaxMb * 1048576'),
  'the browser must plan against the Git Data boundary the server publishes');
assert(/function strategyFor\([\s\S]{0,500}?transportPlanFor\(size, transport\)/.test(app),
  'the queued-file label must be read from the plan');

/* The boundary it plans against is published, not written down twice. */
assert(/contentsMaxMb: CONTENTS_MAX \/ MB/.test(server),
  'the Git Data boundary must be published from the constant itself');

/* The old copies of the size rule are gone from the browser. */
assert(!/size > 40 \* 1048576/.test(app),
  'the browser must not keep its own copy of the Git Data boundary');
assert(!/#forceLfs/.test(app),
  'the one-way force checkbox must be replaced by the three-way transport choice');

/* The choice reaches the server as the choice, not as a boolean. */
assert(app.includes('message, lfs: transport })'),
  'the upload request must carry the chosen transport');
assert(app.includes('transport: uploadTransportV, mode: uploadModeV'),
  'a queued file must freeze the transport it was queued with');

/* A swap is said on the file that got it. */
assert(app.includes('const swap = res.transport && res.transport.fallback;'),
  'the landed line must read the fallback the server reported');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
assert(!/id="forceLfs"/.test(html), 'the force checkbox must be gone from the markup');
assert(/id="uploadTransport"/.test(html), 'the markup must offer the transport choice');
const control = html.slice(html.indexOf('id="uploadTransport"'), html.indexOf('id="uploadTransportHint"'));
for (const value of TRANSPORT_CHOICES) {
  assert(control.includes(`data-v="${value}"`), `the transport control must offer ${value}`);
}
/* Exactly the three choices the planner accepts -- no more, no fewer. */
assert((control.match(/data-v="/g) || []).length === TRANSPORT_CHOICES.length,
  'the control must offer exactly the transports the planner accepts');
/*
 * Git LFS is a provider capability, so the control asks about it rather than
 * offering a transport this provider may not have.
 *
 * And it opts in to Experimental, as the other upload controls on this page
 * do. Without that the gate disables the button outright: on this deployment
 * `lfs` is Experimental, so a bare data-feature would have quietly taken away
 * the choice this whole change exists to give.
 */
assert(/data-v="lfs"[^>]*data-feature="lfs"/.test(control),
  'the Git LFS choice must be gated on the provider capability');
assert(/data-v="lfs"[^>]*data-allow-experimental="true"/.test(control),
  'the Git LFS choice must allow the Experimental status it actually has here');
const { loadCapabilityDocument, projectCapabilities } = require('../src/capability-registry');
const projected = projectCapabilities(
  loadCapabilityDocument(path.join(__dirname, '..', 'config', 'public-alpha-capabilities.json')),
  { provider: 'github', authority: 'github.com', deployment: 'hosted-alpha' }
);
assert(projected.features.lfs, 'the lfs capability must exist for GitHub');
assert(projected.features.lfs.status !== 'Unavailable',
  'the transport choice may only offer Git LFS while GitHub actually has it');

console.log('upload transport choice: ok');
