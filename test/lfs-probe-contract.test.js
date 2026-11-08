'use strict';
/*
 * The LFS probe earns a Provider-verified claim for `lfs`, and that claim is
 * about the product's path, not about the protocol in general. A probe that
 * reached the store by some other route -- a different host, a different
 * scheme, a different batch body -- would prove GitHub works and leave the
 * product's LFS upload (the workbench's, in application/lfs.ts) unproven,
 * while the registry said otherwise.
 *
 * So the two are held together by what each sends. The workbench's upload
 * runs here over a recording transport and a scripted store; the probe runs
 * a whole qualification against the qualification fixture's store, which
 * offers an upload only for an object it does not hold. Every request either
 * makes to the store is held to one description of the exchange, lfsUpload in
 * test/fixtures/provider-requests.js.
 *
 * What the claim rests on is asked the same way: an object the store already
 * holds is not sent again, and the product commits its pointer all the same;
 * the probe fails a provider that offers the upload again; its object is new
 * to a store with history; and a branch whose head moved across it fails it.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const workbench = require('../apps/api/src/modules/workbench/index.ts');
const { createProviderFetchFixture, FIXTURE_CREDENTIALS } = require('../ci/alpha17-fixtures');
const { runGithubValidation } = require('../ci/run-github-alpha17-validation');
const { PROVIDER_CAPABILITY_REQUIREMENTS } = require('../src/qualification-evidence');
const registry = require('../config/public-alpha-capabilities.json');
const { lfsUpload, lfsRequest } = require('./fixtures/provider-requests');

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

/* ---- The workbench's upload, over a recording transport ---- */

/* The store as the product meets it: the actions it offers for the object, or none for one it holds. */
async function productUpload(actions) {
  const bytes = crypto.randomBytes(3000);
  const oid = sha256(bytes);
  const requests = [];
  const commits = [];
  const fetch = async (url, init = {}) => {
    let body = init.body;
    if (body && typeof body.pipe === 'function') {
      const chunks = [];
      for await (const chunk of body) chunks.push(Buffer.from(chunk));
      body = Buffer.concat(chunks);
    }
    requests.push(lfsRequest({ ...init, url, body }));
    if (String(url).endsWith('.git/info/lfs/objects/batch')) {
      return json({ transfer: 'basic', objects: [{ oid, size: bytes.length, ...(actions ? { actions } : {}) }] });
    }
    return json({});
  };
  const lfs = workbench.createLfsTransfer({
    fetch,
    gh: async () => { throw Object.assign(new Error('Not Found'), { status: 404 }); },
    commits: { commitTree: async (...args) => { commits.push(args); return { sha: 'c'.repeat(40) }; } },
    assertProviderBoundLfs: () => true,
    assertProviderMutation: () => true,
    transferTimeoutMs: 5_000
  });
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-lfs-contract-'));
  const file = path.join(folder, 'object');
  fs.writeFileSync(file, bytes);
  try {
    await lfs.upload({ provider: 'github', login: 'alice', token: 'tok' }, 'acme', 'demo', 'main', 'media/clip.bin', file, oid, bytes.length, 'Add clip', '');
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
  const expected = lfsUpload({
    repository: 'acme/demo', branch: 'main', oid, size: bytes.length, login: 'alice', token: 'tok',
    upload: actions && actions.upload, verify: actions && actions.verify
  });
  return { requests, expected, commits, oid, size: bytes.length };
}

/* ---- The probe, over the qualification fixture ---- */

const RUN_ID = 'run-4096';
const REPOSITORY = `fixture-owner/nvx-alpha17-github-qualification`;
const LOGIN = 'alpha17-fixture-actor';
const environment = () => {
  const env = {
    NV_PUBLIC_ALPHA_SUBJECT_SHA256: 'a'.repeat(64),
    NV_PUBLIC_ALPHA_SOURCE_COMMIT: 'b'.repeat(40),
    NV_ALPHA17_WORKFLOW_RUN_ID: RUN_ID,
    NV_ALPHA17_REPOSITORY: REPOSITORY,
    NV_ALPHA17_BRANCH: `nvx-alpha17-${RUN_ID}-proof`,
    NV_ALPHA17_MUTATION_CREDENTIAL: FIXTURE_CREDENTIALS.mutation,
    NV_ALPHA17_REPOSITORY_ADMIN_CREDENTIAL: FIXTURE_CREDENTIALS.repositoryAdmin,
    NV_ALPHA17_NOTIFICATIONS_CREDENTIAL: FIXTURE_CREDENTIALS.notifications,
    NV_ALPHA17_READ_ONLY_CREDENTIAL: 'fixture-readonly-credential',
    NV_ALPHA17_GITHUB_API_URL: 'https://api.github.com',
    NV_ALPHA17_GITHUB_LFS_URL: 'https://github.com'
  };
  env.NV_ALPHA17_SIGNED_TARGET_SHA256 = sha256(JSON.stringify({ apiUrl: env.NV_ALPHA17_GITHUB_API_URL, jobName: 'github', repository: REPOSITORY }));
  return env;
};
const isBatch = url => new URL(String(url)).pathname === `/${REPOSITORY}.git/info/lfs/objects/batch`;

/*
 * A whole qualification run, every request to the LFS store recorded --
 * everything but the API's host. `answer(url, init, response, batches)` may
 * replace the fixture's answer; `batches` counts the negotiations so far.
 */
async function probeRun({ answer, seed } = {}) {
  const env = environment();
  const fixture = createProviderFetchFixture({
    provider: 'github', repository: REPOSITORY, defaultBranch: 'main', runId: RUN_ID,
    mutationCredential: env.NV_ALPHA17_MUTATION_CREDENTIAL, readOnlyCredential: env.NV_ALPHA17_READ_ONLY_CREDENTIAL
  });
  for (const [oid, size] of seed || []) fixture.state.lfsObjects.set(oid, size);
  const requests = [];
  const offered = [];
  let batches = 0;
  const fetchImpl = async (url, init = {}) => {
    const store = new URL(String(url)).hostname !== 'api.github.com';
    if (store) requests.push(lfsRequest({ ...init, url }));
    if (isBatch(url)) batches += 1;
    const replaced = answer ? await answer(url, init, batches) : null;
    const response = replaced || await fixture.fetch(url, init);
    if (isBatch(url)) {
      const answered = await response.clone().json().catch(() => ({}));
      offered.push(((Array.isArray(answered.objects) && answered.objects[0]) || {}).actions || null);
    }
    return response;
  };
  let result = null;
  let failure = null;
  try { result = await runGithubValidation({ env, fetchImpl, now: () => new Date('2026-07-29T20:00:00.000Z') }); }
  catch (error) { failure = error; }
  const first = requests.find(request => isBatch(request.url));
  const object = first && first.body.objects[0];
  return { env, fixture, result, failure, requests, offered, object };
}
const lfsCheck = run => run.result.checks.find(check => check.key === 'lfs-object-upload');

(async () => {
  /* The product: a negotiation, the bytes to storage with its headers, and GitHub's verification signed as the account. */
  {
    const upload = { href: 'https://lfs-storage.example/objects/1', header: { Authorization: 'RemoteAuth up', 'X-Store': 'one' } };
    const run = await productUpload({ upload, verify: { href: 'https://github.com/acme/demo.git/info/lfs/objects/verify' } });
    assert.deepEqual(run.requests, run.expected);
    assert.equal(run.expected.length, 3);
    assert.equal(run.commits.length, 1, 'the pointer is committed once the object is stored');
  }
  /* A verification elsewhere is sent no credentials of the account's; one that brings its own is sent those alone. */
  {
    const upload = { href: 'https://lfs-storage.example/objects/2', header: { 'content-type': 'application/x-object', 'content-length': '1' } };
    const elsewhere = await productUpload({ upload, verify: { href: 'https://verify.example/objects/2' } });
    assert.deepEqual(elsewhere.requests, elsewhere.expected);
    assert.equal(elsewhere.requests[2].headers.authorization, undefined);
    assert.deepEqual([elsewhere.requests[1].headers['content-type'], elsewhere.requests[1].headers['content-length']], ['application/x-object', '1'],
      'a header storage hands back replaces ours of that name, in any case, rather than joining it');
    const own = await productUpload({ upload, verify: { href: 'https://github.com/acme/demo.git/info/lfs/objects/verify', header: { authorization: 'RemoteAuth verify' } } });
    assert.deepEqual(own.requests, own.expected);
    assert.equal(own.requests[2].headers.authorization, 'RemoteAuth verify');
  }
  /* An object the store already holds: nothing is sent but the negotiation, and the pointer is committed all the same. */
  {
    const held = await productUpload(null);
    assert.deepEqual(held.requests, held.expected);
    assert.equal(held.requests.length, 1);
    const [, owner, repo, branch, message, entries] = held.commits[0];
    assert.deepEqual([owner, repo, branch, message], ['acme', 'demo', 'main', 'Add clip']);
    assert.deepEqual(entries.map(entry => [entry.path, entry.content]), [
      ['media/clip.bin', `version https://git-lfs.github.com/spec/v1\noid sha256:${held.oid}\nsize ${held.size}\n`],
      ['.gitattributes', '/media/clip.bin filter=lfs diff=lfs merge=lfs -text\n']
    ]);
  }

  /* The probe sends the store what the product sends it, and then asks again, unchanged. */
  const first = await probeRun();
  assert.equal(first.failure, null, first.failure && first.failure.message);
  assert(first.object, 'the probe negotiated with the LFS store on the web host');
  assert.equal(first.result.status, 'pass');
  assert.equal(lfsCheck(first).status, 'pass');
  {
    const [actions] = first.offered;
    const expected = lfsUpload({
      repository: REPOSITORY, branch: first.env.NV_ALPHA17_BRANCH, oid: first.object.oid, size: first.object.size,
      login: LOGIN, token: FIXTURE_CREDENTIALS.mutation, upload: actions.upload, verify: actions.verify
    });
    assert.equal(expected.length, 3);
    assert.deepEqual(first.requests, [...expected, expected[0]]);
    assert.deepEqual(first.offered.slice(1), [null], 'the repeat is answered with the object held');
  }
  /* A verification elsewhere, or one that brings its own credentials, is signed as the product signs it. */
  for (const verify of [{ href: 'https://verify.example/objects' }, { href: `https://github.com/${REPOSITORY}.git/info/lfs/objects/verify`, header: { authorization: 'RemoteAuth verify' } }]) {
    let shown = null;
    const run = await probeRun({
      answer: async (url, init, batches) => {
        if (new URL(String(url)).hostname === 'verify.example') {
          const { oid, size } = JSON.parse(String(init.body));
          return json({ oid, size });
        }
        if (!isBatch(url) || batches !== 1) return null;
        const body = JSON.parse(String(init.body));
        const [{ oid }] = body.objects;
        shown = { upload: { href: `https://github.com/lfs-storage/${oid}`, header: { 'content-type': 'application/x-object' } }, verify };
        return json({ transfer: 'basic', objects: [{ ...body.objects[0], actions: shown }] });
      }
    });
    assert.equal(run.failure, null, run.failure && run.failure.message);
    const expected = lfsUpload({
      repository: REPOSITORY, branch: run.env.NV_ALPHA17_BRANCH, oid: run.object.oid, size: run.object.size,
      login: LOGIN, token: FIXTURE_CREDENTIALS.mutation, upload: shown.upload, verify: shown.verify
    });
    assert.deepEqual(run.requests, [...expected, expected[0]], `a verification at ${verify.href}`);
  }
  /* A provider that offers the upload again has not stored the object: the probe fails, naming that. */
  {
    const run = await probeRun({
      answer: async (url, init, batches) => {
        if (!isBatch(url) || batches !== 2) return null;
        const body = JSON.parse(String(init.body));
        const [{ oid }] = body.objects;
        return json({ transfer: 'basic', objects: [{ ...body.objects[0], actions: { upload: { href: `https://github.com/lfs-storage/${oid}` } } }] });
      }
    });
    assert.equal(run.failure && run.failure.code, 'ALPHA17_PROVIDER_PROBE_FAILED');
    assert.equal(run.failure.message, 'provider probe lfs-object-upload did not pass (unmet: deduplicatedOnRepeat)');
  }
  /* Its object is new each run: a store holding the last run's object still offers this one's upload. */
  {
    const again = await probeRun({ seed: [[first.object.oid, first.object.size]] });
    assert.equal(again.failure, null, again.failure && again.failure.message);
    assert.notEqual(again.object.oid, first.object.oid);
    assert.equal(lfsCheck(again).uploadOffered, true);
  }
  /* A branch whose head moved across the probe has had something committed: the probe fails. */
  {
    const head = `/repos/${REPOSITORY}/git/ref/heads/${encodeURIComponent(environment().NV_ALPHA17_BRANCH)}`;
    let moved = false;
    const run = await probeRun({
      answer: async (url, init, batches) => {
        if (moved || batches < 2 || new URL(String(url)).pathname !== head) return null;
        moved = true;
        return json({ ref: `refs/heads/${environment().NV_ALPHA17_BRANCH}`, object: { sha: 'f'.repeat(40), type: 'commit' } });
      }
    });
    assert.equal(moved, true);
    assert.equal(run.failure && run.failure.code, 'ALPHA17_PROVIDER_PROBE_FAILED');
    assert.equal(run.failure.message, 'provider probe lfs-object-upload did not pass (unmet: pointerCommitted)');
  }

  /* The registry may not claim more than the probe proves: a Provider-verified `lfs` requires it. */
  const lfs = registry.providers.github['hosted-alpha'].lfs;
  if (lfs && lfs[1] === 'Provider-verified') {
    assert((PROVIDER_CAPABILITY_REQUIREMENTS.github.lfs || []).includes('lfs-object-upload'),
      'github lfs is Provider-verified but the contract does not require the probe that would earn it');
  }
  console.log('lfs probe contract tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
