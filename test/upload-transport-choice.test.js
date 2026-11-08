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

const planning = require('../packages/contracts/src/upload-planning.ts');
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

/* ---- 8. the browser routes through the same planner ---- */

const app = fs.readFileSync(path.join(__dirname, '..', 'apps', 'web', 'src', 'legacy', 'app.js'), 'utf8');

/*
 * The label on a queued file is the server's decision read early, not a second
 * copy of it. Pinned to the exact call, because "the module is mentioned
 * somewhere in this file" is satisfied by a file that mentions it and then
 * decides for itself anyway.
 */
assert(app.includes('return uploadPlanning.planUploadTransport({'),
  'the browser must label a queued file with the shared planner');
assert(app.includes('gitPushMaxBytes: state.runtime.nativePushMaxMb * 1048576'),
  'the browser must plan against the ceiling the server publishes');
assert(app.includes('gitDataMaxBytes: state.runtime.contentsMaxMb * 1048576'),
  'the browser must plan against the Git Data boundary the server publishes');
assert(/function strategyFor\([\s\S]{0,500}?transportPlanFor\(size, transport\)/.test(app),
  'the queued-file label must be read from the plan');

/* The boundary it plans against is published, not written down twice: test/composition.test.js asks the composed server what it publishes. */

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

const html = fs.readFileSync(path.join(__dirname, '..', 'apps', 'web', 'index.html'), 'utf8');
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
 * It names the capability and nothing more: only what is Supported is
 * offered, so the choice is shown exactly when Git LFS is Supported here.
 */
assert(/data-v="lfs"[^>]*data-feature="lfs"/.test(control),
  'the Git LFS choice must be gated on the provider capability');
assert(!/data-allow-experimental/.test(control),
  'the Git LFS choice carries no experimental opt-in');
const { loadCapabilityDocument, projectCapabilities } = require('../src/capability-registry');
const projected = projectCapabilities(
  loadCapabilityDocument(path.join(__dirname, '..', 'config', 'public-alpha-capabilities.json')),
  { provider: 'github', authority: 'github.com', deployment: 'hosted-alpha' }
);
assert(projected.features.lfs, 'the lfs capability must exist for GitHub');
assert(projected.features.lfs.status !== 'Unavailable',
  'the transport choice may only offer Git LFS while GitHub actually has it');

/* ---- 7. the server routes through the planner ---- */

/*
 * The route is the workbench's (apps/api/src/modules/workbench/http/upload-routes.ts),
 * asked here over HTTP with its transports recorded. For every size around
 * the two ceilings it is handed, every choice a reader can send and either
 * provider, it answers what the plan says: the refusal the plan names, or the
 * transport the plan chose and the swap it reports, the Git LFS capability
 * required exactly when LFS was asked for. A swap the provider forces at run
 * time -- a push refused, then a blob too large -- is reported too. Which
 * ceilings the composed server hands it, test/composition.test.js asks the
 * server itself.
 */
const express = require('express');
const workbench = require('../apps/api/src/modules/workbench/index.ts');

const LIMITS = Object.freeze({ blobMaxBytes: 3000, uploadMaxBytes: 9000, gitPushMaxBytes: 5000, gitDataMaxBytes: 2000 });

async function askRoute() {
  const state = { provider: 'github', pushRefused: false, blobTooLarge: false };
  const used = [];
  const ran = [];
  const guard = name => (req, res, next) => { ran.push(name); next(); };
  const app = express();
  workbench.registerUploadRoutes(app, {
    providerSessionAccess: guard('providerSessionAccess'),
    alphaRepositoryAccess: guard('alphaRepositoryAccess'),
    capabilityAccess: feature => guard(`capabilityAccess('${feature}')`),
    capabilityAccessWhen: (feature, applies) => (req, res, next) => { if (applies(req)) ran.push(`capabilityAccess('${feature}')`); next(); },
    auth: guard('auth'),
    mutationContext: action => guard(`mutationContext('${action}')`),
    account: () => ({ provider: state.provider, login: 'maya', token: 'tok' }),
    fail: (res, error) => res.status(error.status >= 400 && error.status < 600 ? error.status : 500).json({ error: error.message }),
    gh: async (account, apiPath) => {
      used.push('git-data');
      if (state.blobTooLarge) throw Object.assign(new Error('Blob too large'), { status: 422 });
      return { sha: 'b'.repeat(40) };
    },
    commits: { commitTree: async () => ({ sha: 'c'.repeat(40) }) },
    intake: workbench.createUploadIntake({ concurrency: 1, timeoutMs: 60_000 }),
    nativePush: { push: async () => { used.push('git-push'); if (state.pushRefused) throw Object.assign(new Error('git push rejected'), { status: 502 }); return { commit: 'd'.repeat(40) }; } },
    lfs: { upload: async (account, owner, repo, branch, repoPath, tmp, oid) => { used.push('lfs'); return { commit: 'e'.repeat(40), oid }; }, downloadStream: async () => null },
    limits: LIMITS,
    scanUpload: async () => ({ builtin: { available: true, matches: 0 } }),
    enforceProtectedPaths: () => {}
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const upload = async (size, choice) => {
    used.length = 0;
    ran.length = 0;
    const query = new URLSearchParams({ path: 'media/clip.bin', branch: 'main', ...(choice === undefined ? {} : { lfs: choice }) });
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/repo/acme/demo/upload?${query}`, {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.alloc(size, 'x')
    });
    return { status: response.status, body: await response.json() };
  };
  const STRATEGY = { lfs: 'lfs', 'git-push': 'git-push', 'git-data': 'git-data-api' };
  try {
    const sizes = [1, 1999, 2000, 2001, 4999, 5000, 5001, 9000];
    const choices = [undefined, 'auto', 'git', 'lfs', 'force', ' LFS ', 'nonsense'];
    for (const provider of ['github', 'gitea']) {
      state.provider = provider;
      for (const size of sizes) {
        for (const choice of choices) {
          const planned = planUploadTransport({
            size, requested: normalizeTransportChoice(choice), lfsAvailable: provider === 'github',
            gitPushMaxBytes: LIMITS.gitPushMaxBytes, gitDataMaxBytes: LIMITS.gitDataMaxBytes
          });
          const answered = await upload(size, choice);
          const label = `${provider}, ${size} bytes, lfs=${String(choice)}`;
          assert.deepStrictEqual(ran, [
            'providerSessionAccess', 'alphaRepositoryAccess', "capabilityAccess('native-push')", "capabilityAccess('upload-security')",
            ...(normalizeTransportChoice(choice) === 'lfs' ? ["capabilityAccess('lfs')"] : []), 'auth', "mutationContext('file.upload')"
          ], label);
          if (planned.refusal) {
            assert.deepStrictEqual([answered.status, answered.body.error, used], [planned.refusal.status, planned.refusal.message, []], label);
            continue;
          }
          assert.strictEqual(answered.status, 200, label);
          assert.deepStrictEqual([answered.body.strategy, used], [STRATEGY[planned.route], [planned.route]], label);
          assert.deepStrictEqual(answered.body.transport, JSON.parse(JSON.stringify({ requested: planned.requested, fallback: planned.fallback })), label);
          assert.strictEqual(answered.body.size, size, label);
        }
      }
    }
    /* The provider refuses the push, then the blob as too large: the file goes by LFS, and the swap is said. */
    const warnings = [];
    const consoleError = console.error;
    console.error = line => warnings.push(JSON.parse(line));
    try {
      state.provider = 'github';
      state.pushRefused = true;
      state.blobTooLarge = true;
      const laddered = await upload(4000, 'git');
      assert.deepStrictEqual([laddered.status, laddered.body.strategy, used], [200, 'lfs (auto-fallback)', ['git-push', 'git-data', 'lfs']]);
      assert.deepStrictEqual(laddered.body.transport, {
        requested: 'git', fallback: { from: 'git', to: 'lfs', reason: 'the provider refused the object as too large for an ordinary Git push' }
      });
      /* A push refused while the blob is taken is carried by the Git Data API, as asked: no swap of transport to report. */
      state.blobTooLarge = false;
      const carried = await upload(4000, 'git');
      assert.deepStrictEqual([carried.body.strategy, used, carried.body.transport], ['git-data-blob', ['git-push', 'git-data'], { requested: 'git', fallback: null }]);
    } finally { console.error = consoleError; }
    assert.deepStrictEqual(warnings.map(warning => [warning.warn, warning.status, warning.err]), [
      ['native push failed, laddering', 502, 'git push rejected'], ['native push failed, laddering', 502, 'git push rejected']
    ]);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

askRoute().then(() => console.log('upload transport choice: ok'), error => {
  console.error(error);
  process.exitCode = 1;
});
