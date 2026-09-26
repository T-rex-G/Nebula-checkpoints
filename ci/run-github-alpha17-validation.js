#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const {
  assertExpectedHead,
  fail,
  observe,
  requestJson,
  statusClass,
  runProviderQualification
} = require('./provider-alpha17-common');
const exposureReader = require('../src/exposure-reader');

/*
 * The permanent code-search fixture on the target's default branch -- the
 * only branch GitHub indexes -- and the word it carries. See
 * docs/operations/ALPHA17_LIVE_DISPATCH.md.
 */
const SEARCH_FIXTURE_PATH = 'NVX_SEARCH_FIXTURE.md';
const SEARCH_FIXTURE_MARKER = 'nvx-alpha17-search-fixture';
/*
 * A dispatched workflow run waits for a runner and then runs; with the shared
 * backoff thirty attempts allow it about three minutes before the probe says
 * so. The bound is an environment setting only so a test can falsify the wait
 * without spending those minutes; the live workflow never sets it.
 */
const RUN_OBSERVATION_ATTEMPTS = 30;
function runObservationAttempts(env) {
  const value = Number(env.NV_ALPHA17_RUN_OBSERVATION_ATTEMPTS);
  return Number.isSafeInteger(value) && value >= 1 && value <= 60 ? value : RUN_OBSERVATION_ATTEMPTS;
}

/*
 * The identity git itself gives a blob: sha1 over the header "blob <length>\0"
 * and then the bytes. Computed here rather than asked for, because the whole
 * point of the blob proof is to compare what the provider says the object is
 * against what the object actually is.
 */
function gitBlobSha1(bytes) {
  return crypto.createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`, 'utf8'), bytes]))
    .digest('hex');
}

function required(env, name) {
  const value = String(env[name] || '').trim();
  if (!value) throw new TypeError(`${name} is required`);
  return value;
}

function createGithubClient({ env, fetchImpl }) {
  const repository = required(env, 'NV_ALPHA17_REPOSITORY');
  const baseUrl = new URL(String(env.NV_ALPHA17_GITHUB_API_URL || 'https://api.github.com'));
  const mutationCredential = required(env, 'NV_ALPHA17_MUTATION_CREDENTIAL');
  const readOnlyCredential = required(env, 'NV_ALPHA17_READ_ONLY_CREDENTIAL');
  const repositoryPath = repository.split('/').map(encodeURIComponent).join('/');
  const api = pathname => new URL(pathname, `${baseUrl.toString().replace(/\/$/, '')}/`).toString();

  function headers(kind) {
    const credential = kind === 'readOnly' ? readOnlyCredential : mutationCredential;
    return {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${credential}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Nebulaverse-X-alpha17-qualification'
    };
  }

  async function getRepository(credential = 'mutation') {
    const response = await requestJson(fetchImpl, api(`repos/${repositoryPath}`), {
      headers: headers(credential),
      allowedStatuses: [200]
    });
    return Object.freeze({
      fullName: String(response.data.full_name || ''),
      defaultBranch: String(response.data.default_branch || '')
    });
  }

  async function getBranch(branch, credential = 'mutation') {
    const response = await requestJson(fetchImpl, api(`repos/${repositoryPath}/git/ref/heads/${encodeURIComponent(branch)}`), {
      headers: headers(credential),
      allowedStatuses: [200, 404]
    });
    if (response.status === 404) return null;
    return Object.freeze({ sha: String(response.data.object && response.data.object.sha || '').toLowerCase() });
  }

  async function createBranch(branch, sha, credential = 'mutation') {
    return requestJson(fetchImpl, api(`repos/${repositoryPath}/git/refs`), {
      method: 'POST',
      headers: headers(credential),
      body: { ref: `refs/heads/${branch}`, sha },
      allowedStatuses: [201]
    });
  }

  async function writeFile(input) {
    const current = await getBranch(input.branch, input.credential);
    assertExpectedHead(input.expectedHead, current && current.sha);
    const response = await requestJson(fetchImpl, api(`repos/${repositoryPath}/contents/${encodeURIComponent(input.path)}`), {
      method: 'PUT',
      headers: headers(input.credential),
      body: {
        branch: input.branch,
        message: 'test(alpha): qualification proof',
        content: Buffer.from(input.content).toString('base64')
      },
      allowedStatuses: [200, 201]
    });
    return Object.freeze({
      commitSha: String(response.data.commit && response.data.commit.sha || '').toLowerCase(),
      statusClass: response.statusClass
    });
  }

  /*
   * GitHub's own optimistic concurrency: an update carries the blob sha of the
   * file it believes it is replacing, and a mismatch is refused with 409.
   *
   * This exists so the stale-write proof is the PROVIDER refusing rather than
   * this client refusing on its own behalf. The caller hands it a well-formed
   * blob sha that belongs to different content, which is exactly the mistake a
   * stale writer makes. A 2xx here means GitHub accepted a write it should
   * have rejected, and the caller treats that as the proof failing.
   */
  /*
   * The blob sha of the file being replaced is this provider's concurrency
   * token. The caller sends the same one twice: current, which must be
   * accepted, and then superseded, which must be refused with 409.
   */
  async function conditionalUpdate(input) {
    return requestJson(fetchImpl, api(`repos/${repositoryPath}/contents/${encodeURIComponent(input.path)}`), {
      method: 'PUT',
      headers: headers(input.credential),
      body: {
        branch: input.branch,
        message: 'test(alpha): conditional write proof',
        content: Buffer.from(input.content).toString('base64'),
        sha: input.fileSha
      },
      allowedStatuses: [200, 201]
    });
  }

  async function readFile(branch, filePath, credential = 'mutation') {
    const url = new URL(api(`repos/${repositoryPath}/contents/${encodeURIComponent(filePath)}`));
    url.searchParams.set('ref', branch);
    const response = await requestJson(fetchImpl, url.toString(), {
      headers: headers(credential),
      allowedStatuses: [200, 404]
    });
    if (response.status === 404) return null;
    return Object.freeze({
      content: Buffer.from(String(response.data.content || '').replace(/\s+/g, ''), 'base64'),
      sha: String(response.data.sha || '').toLowerCase(),
      statusClass: response.statusClass
    });
  }

  async function deleteFile(input) {
    const current = await getBranch(input.branch, input.credential);
    assertExpectedHead(input.expectedHead, current && current.sha);
    const response = await requestJson(fetchImpl, api(`repos/${repositoryPath}/contents/${encodeURIComponent(input.path)}`), {
      method: 'DELETE',
      headers: headers(input.credential),
      body: {
        branch: input.branch,
        message: 'test(alpha): remove qualification proof',
        sha: input.fileSha
      },
      allowedStatuses: [200]
    });
    return Object.freeze({
      commitSha: String(response.data.commit && response.data.commit.sha || '').toLowerCase(),
      statusClass: response.statusClass
    });
  }

  async function deleteBranch(branch, credential = 'mutation') {
    return requestJson(fetchImpl, api(`repos/${repositoryPath}/git/refs/heads/${encodeURIComponent(branch)}`), {
      method: 'DELETE',
      headers: headers(credential),
      allowedStatuses: [204]
    });
  }

  /*
   * The tree listing for a branch, recursive, so a file written anywhere under
   * it is visible. Bounded by the shared response reader; the disposable
   * qualification repository holds a handful of files, so the truncation flag
   * is reported rather than paged through -- a truncated listing is not proof
   * of anything and fails the probe.
   */
  async function readTree(branch, credential = 'mutation') {
    const url = new URL(api(`repos/${repositoryPath}/git/trees/${encodeURIComponent(branch)}`));
    url.searchParams.set('recursive', '1');
    const response = await requestJson(fetchImpl, url.toString(), {
      headers: headers(credential),
      allowedStatuses: [200]
    });
    const tree = Array.isArray(response.data.tree) ? response.data.tree : [];
    return Object.freeze({
      statusClass: response.statusClass,
      truncated: response.data.truncated === true,
      entries: tree.map(entry => Object.freeze({
        path: String(entry.path || ''),
        sha: String(entry.sha || '').toLowerCase()
      }))
    });
  }

  /*
   * The Git Data API, which is the transport underneath both push capabilities:
   * an object store (blobs), a directory snapshot over it (trees), a commit
   * naming one tree and its parents, and a ref move that publishes the result.
   * commitTree in the server walks exactly this sequence.
   */
  async function createBlob(bytes, credential = 'mutation') {
    const response = await requestJson(fetchImpl, api(`repos/${repositoryPath}/git/blobs`), {
      method: 'POST',
      headers: headers(credential),
      body: { content: Buffer.from(bytes).toString('base64'), encoding: 'base64' },
      allowedStatuses: [201]
    });
    return Object.freeze({
      sha: String(response.data.sha || '').toLowerCase(),
      statusClass: response.statusClass
    });
  }

  async function readBlob(sha, credential = 'mutation') {
    const response = await requestJson(fetchImpl, api(`repos/${repositoryPath}/git/blobs/${encodeURIComponent(sha)}`), {
      headers: headers(credential),
      allowedStatuses: [200]
    });
    return Object.freeze({
      content: Buffer.from(String(response.data.content || '').replace(/\s+/g, ''), 'base64'),
      statusClass: response.statusClass
    });
  }

  async function readCommit(sha, credential = 'mutation') {
    const response = await requestJson(fetchImpl, api(`repos/${repositoryPath}/git/commits/${encodeURIComponent(sha)}`), {
      headers: headers(credential),
      allowedStatuses: [200]
    });
    return Object.freeze({
      sha: String(response.data.sha || '').toLowerCase(),
      treeSha: String(response.data.tree && response.data.tree.sha || '').toLowerCase(),
      parents: (Array.isArray(response.data.parents) ? response.data.parents : [])
        .map(parent => String(parent && parent.sha || '').toLowerCase())
    });
  }

  async function createTree({ baseTree, entries }, credential = 'mutation') {
    const response = await requestJson(fetchImpl, api(`repos/${repositoryPath}/git/trees`), {
      method: 'POST',
      headers: headers(credential),
      body: { base_tree: baseTree, tree: entries },
      allowedStatuses: [201]
    });
    return Object.freeze({
      sha: String(response.data.sha || '').toLowerCase(),
      statusClass: response.statusClass
    });
  }

  async function createCommit({ message, tree, parents }, credential = 'mutation') {
    const response = await requestJson(fetchImpl, api(`repos/${repositoryPath}/git/commits`), {
      method: 'POST',
      headers: headers(credential),
      body: { message, tree, parents },
      allowedStatuses: [201]
    });
    return Object.freeze({
      sha: String(response.data.sha || '').toLowerCase(),
      statusClass: response.statusClass
    });
  }

  /*
   * force is sent explicitly rather than left to the provider's default,
   * because the refusal it produces is the thing being proved. `allowedStatuses`
   * carries 422 so a refused move is an answer this returns rather than a
   * transport failure it throws.
   */
  async function updateRef({ branch, sha, force = false }, credential = 'mutation') {
    const response = await requestJson(fetchImpl, api(`repos/${repositoryPath}/git/refs/heads/${encodeURIComponent(branch)}`), {
      method: 'PATCH',
      headers: headers(credential),
      body: { sha, force },
      allowedStatuses: [200, 409, 422]
    });
    return Object.freeze({ status: response.status, statusClass: response.statusClass });
  }

  async function readRateLimit(credential = 'mutation') {
    const response = await requestJson(fetchImpl, api('rate_limit'), {
      headers: headers(credential),
      allowedStatuses: [200]
    });
    const core = response.data.resources && response.data.resources.core;
    return Object.freeze({
      statusClass: response.statusClass,
      limit: Number(core && core.limit),
      remaining: Number(core && core.remaining)
    });
  }

  /*
   * An identifier no object in a disposable qualification repository can hold.
   * Numbering starts at one and climbs; a target seeded with fixtures for
   * these probes is still nowhere near this.
   */
  const ABSENT_IDENTIFIER = 999999999;

  /*
   * The collection reads, which all have the same shape: a listing and a
   * detail view over the same objects.
   *
   * The proof is that the pair is live, scoped to this repository, and
   * discriminating. Every object the listing names has to be fetchable on its
   * own and agree with the listing, and an identifier that cannot exist has to
   * be refused rather than answered -- an endpoint that returns 200 for
   * anything asked of it passes a reachability ping and fails that.
   *
   * `listed` records how many objects were actually verified, which on an
   * unseeded target is zero. That is the honest number, and it is in the
   * evidence rather than hidden behind a pass.
   */
  async function readCollection({ key, listPath, detailPath, identify, listOf }) {
    const listing = await requestJson(fetchImpl, api(`repos/${repositoryPath}/${listPath}`), {
      headers: headers('mutation'),
      allowedStatuses: [200]
    });
    const items = (listOf ? listOf(listing.data) : listing.data) || [];
    if (!Array.isArray(items)) {
      return { key, status: 'fail', statusClass: listing.statusClass, listed: 0, detailAgreed: false, absentDiscriminated: false };
    }

    let detailAgreed = true;
    for (const item of items) {
      const identifier = identify(item);
      if (!Number.isSafeInteger(identifier) || identifier <= 0) {
        detailAgreed = false;
        break;
      }
      const detail = await requestJson(fetchImpl, api(`repos/${repositoryPath}/${detailPath}/${identifier}`), {
        headers: headers('mutation'),
        allowedStatuses: [200, 404]
      });
      if (detail.status !== 200 || identify(detail.data) !== identifier) {
        detailAgreed = false;
        break;
      }
    }

    const absent = await requestJson(fetchImpl, api(`repos/${repositoryPath}/${detailPath}/${ABSENT_IDENTIFIER}`), {
      headers: headers('mutation'),
      allowedStatuses: [200, 404]
    });
    const absentDiscriminated = absent.status === 404;

    return {
      key,
      status: items.length > 0 && detailAgreed && absentDiscriminated ? 'pass' : 'fail',
      statusClass: listing.statusClass,
      listed: items.length,
      detailAgreed,
      absentDiscriminated
    };
  }

  const COLLECTION_READS = Object.freeze([
    { key: 'pulls-read', listPath: 'pulls?state=all', detailPath: 'pulls', identify: item => Number(item && item.number) },
    { key: 'issues-read', listPath: 'issues?state=all', detailPath: 'issues', identify: item => Number(item && item.number) },
    { key: 'releases-read', listPath: 'releases', detailPath: 'releases', identify: item => Number(item && item.id) },
    {
      key: 'workflows-read',
      listPath: 'actions/runs',
      detailPath: 'actions/runs',
      identify: item => Number(item && item.id),
      listOf: data => data && data.workflow_runs
    }
  ]);

  /*
   * Cross-checks, not reachability pings.
   *
   * The tree probe requires the listing to name the file this run just wrote
   * and to give it the blob identity the contents API already reported for it.
   * An endpoint answering 200 with an unrelated tree satisfies a ping and
   * fails this.
   *
   * The rate probe records comparisons rather than the figures: the ceiling
   * has to be a real positive number and the remaining budget has to sit
   * within it. The account's actual quota is not the evidence's business.
   */
  async function probeChecks({ branch, prefix, proofPath, proofFileSha, proofText }) {
    /*
     * The tree is the one probe that reads something this run just wrote, so
     * it is the one probe exposed to the provider answering before it has
     * finished making the write visible. That is the same lag that failed the
     * delete proof on the first live run, and it failed this probe on the
     * first run that reached it: the tree came back without the proof path,
     * because the commit carrying it was seconds old.
     *
     * Converged rather than loosened. The probe still demands the exact path
     * and the exact blob identity; it just stops insisting the provider be
     * caught up on the first ask. The collection probes below read fixtures
     * that predate the run, so they have nothing to wait for.
     */
    const expectedSha = String(proofFileSha || '').toLowerCase();
    const tree = await observe(
      () => readTree(branch),
      current => Boolean(current) && !current.truncated &&
        current.entries.some(item => item.path === proofPath && item.sha === expectedSha)
    );
    const entry = tree.entries.find(item => item.path === proofPath);
    const treeRead = {
      key: 'tree-read',
      status: 'fail',
      statusClass: tree.statusClass,
      entries: tree.entries.length,
      proofPathPresent: Boolean(entry) && !tree.truncated,
      blobIdentityMatched: Boolean(entry) && entry.sha === expectedSha
    };
    treeRead.status = treeRead.proofPathPresent && treeRead.blobIdentityMatched ? 'pass' : 'fail';

    const rate = await readRateLimit();
    const limitPositive = Number.isSafeInteger(rate.limit) && rate.limit > 0;
    const rateRead = {
      key: 'rate-read',
      status: 'fail',
      statusClass: rate.statusClass,
      limitPositive,
      remainingWithinLimit: limitPositive &&
        Number.isSafeInteger(rate.remaining) &&
        rate.remaining >= 0 &&
        rate.remaining <= rate.limit
    };
    rateRead.status = rateRead.limitPositive && rateRead.remainingWithinLimit ? 'pass' : 'fail';

    const collections = [];
    for (const collection of COLLECTION_READS) collections.push(await readCollection(collection));

    const earlier = [
      treeRead, rateRead, ...collections,
      ...(await pushChecks({ branch, prefix })),
      ...(await lfsChecks({ branch, prefix }))
    ];
    /*
     * The capability probes build on everything above -- the rename re-links
     * a blob the batch committed, the reader is checked against the tree the
     * tree probe bound -- so they run only when all of it held. Otherwise the
     * first broken condition would be buried under a failure it caused
     * further down, which is the ordering the push chain already refuses.
     */
    if (earlier.some(check => check.status !== 'pass')) return [...earlier, ...capabilityChecksNotRun()];
    return [
      ...earlier,
      ...(await capabilityChecks({ branch, prefix, proofPath, proofFileSha: expectedSha, proofText: String(proofText || '') }))
    ];
  }

  /*
   * The push chain. These two probes are one sequence deliberately: the blob
   * the first one creates is the blob the second one commits, so the join
   * between "the provider stored my bytes" and "those bytes are now a file on
   * a branch" is proved rather than assumed.
   *
   * This is the only probe that moves the branch head. Everything after it in
   * the shared sequence reads the head it observes rather than one it
   * remembers from earlier, so the move costs nothing downstream.
   */
  /*
   * Git LFS speaks to a different host from the REST API -- github.com rather
   * than api.github.com -- and authenticates with Basic rather than Bearer.
   * These mirror uploadViaLFS in server.js request for request, because a
   * probe that reached the provider by some other route would prove the
   * provider works and leave the product's own path unproven. The guard in
   * test/lfs-probe-contract.test.js holds the two together.
   */
  const lfsBase = new URL(String(env.NV_ALPHA17_GITHUB_LFS_URL || 'https://github.com'));
  const lfsBatchUrl = () => new URL(`${repository}.git/info/lfs/objects/batch`,
    `${lfsBase.toString().replace(/\/$/, '')}/`).toString();

  function lfsHeaders(login, credential = 'mutation') {
    const token = credential === 'readOnly' ? readOnlyCredential : mutationCredential;
    return {
      Accept: 'application/vnd.git-lfs+json',
      'Content-Type': 'application/vnd.git-lfs+json',
      Authorization: `Basic ${Buffer.from(`${login}:${token}`).toString('base64')}`,
      'User-Agent': 'Nebulaverse-X-alpha17-qualification'
    };
  }

  /*
   * The product signs LFS Basic auth with the session's login, so the probe
   * asks the provider who the credential belongs to rather than assuming the
   * repository owner is the actor.
   */
  async function readViewerLogin(credential = 'mutation') {
    const response = await requestJson(fetchImpl, api('user'), {
      headers: headers(credential),
      allowedStatuses: [200]
    });
    return String(response.data.login || '');
  }

  /* Written out rather than parameterised, so the body is visibly the one
   * uploadViaLFS sends and the contract guard can hold them together. */
  async function lfsBatch({ login, branch, objects }) {
    return requestJson(fetchImpl, lfsBatchUrl(), {
      method: 'POST',
      headers: lfsHeaders(login),
      body: { operation: 'upload', transfers: ['basic'], ref: { name: `refs/heads/${branch}` }, objects },
      allowedStatuses: [200]
    });
  }

  /*
   * The object bytes do not go through requestJson: the upload href is a
   * storage endpoint that answers with an empty body, and the response is not
   * JSON. Sent raw, with the headers the batch response handed back, exactly
   * as the product sends them.
   */
  async function lfsPutObject(action, bytes) {
    const parsed = new URL(String(action.href || ''));
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
      fail('LFS upload href must be HTTPS without embedded credentials', 'ALPHA17_PROVIDER_URL_INVALID');
    }
    const response = await fetchImpl(parsed, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(bytes.length),
        ...(action.header || {})
      },
      body: bytes,
      redirect: 'error'
    });
    return Object.freeze({ status: response.status, statusClass: statusClass(response.status) });
  }

  /*
   * Git LFS, proved without committing anything.
   *
   * The registry has called this Experimental with the reason "implemented,
   * but outside the alpha.17 live-provider harness and golden path", and the
   * only way out of that is to walk it against the real provider.
   *
   * The object is synthetic and random, so its oid cannot already exist in the
   * store -- which is what makes the first batch response meaningful. A fixed
   * payload would be present from the previous run and the probe would report
   * a successful upload it never performed.
   *
   * No pointer file and no .gitattributes are written. The LFS store and the
   * git tree are separate, and the thing under test is the store; committing a
   * pointer would leave the branch carrying a file whose bytes live somewhere
   * this run then has to clean up. The head is read before and after and
   * required to be identical, so "no pointer committed" is a measured fact
   * rather than an intention.
   *
   * The proof that the provider really took the bytes is the second batch
   * call. An LFS server omits the upload action for an object it already
   * holds, so asking again for the same oid and being offered nothing is the
   * provider stating it has them. That is also the branch of uploadViaLFS that
   * has never been observed -- `if (uploadAction)` falling through -- and it
   * is the deduplication the upload page depends on to avoid resending.
   */
  async function lfsChecks({ branch, prefix }) {
    const headBefore = await getBranch(branch, 'mutation');
    const objectBytes = Buffer.concat([
      Buffer.from(`Nebulaverse-X alpha.17 lfs object ${prefix}\n`, 'utf8'),
      crypto.randomBytes(64)
    ]);
    const oid = crypto.createHash('sha256').update(objectBytes).digest('hex');
    const size = objectBytes.length;

    const login = await readViewerLogin('mutation');
    const first = await lfsBatch({ login, branch, objects: [{ oid, size }] });
    const firstObject = (first.data.objects || [])[0] || {};
    const uploadAction = firstObject.actions && firstObject.actions.upload;
    const oidEchoed = String(firstObject.oid || '') === oid && Number(firstObject.size) === size;
    const uploadOffered = Boolean(uploadAction && uploadAction.href);

    /*
     * Short-circuit for the same reason the blob proof does: pressing on with
     * no upload action would fail inside the PUT and report a transport error
     * instead of naming the condition that was actually not met.
     */
    if (!oidEchoed || !uploadOffered) {
      return [{
        key: 'lfs-object-upload',
        status: 'fail',
        statusClass: first.statusClass,
        oidEchoed,
        uploadOffered,
        objectStored: false,
        deduplicatedOnRepeat: false,
        pointerCommitted: false
      }];
    }

    const put = await lfsPutObject(uploadAction, objectBytes);
    const objectStored = put.statusClass === '2xx';

    /*
     * The verify action is optional in the protocol, and whether GitHub offers
     * it is not something this run may assume before it has ever run. So it is
     * called when present -- the product does -- but it carries no field of its
     * own in the artifact: the proof shape admits no optional fields, and a
     * field declared true would fail against a provider that never offers the
     * action, while a field declared false would forbid the provider that does.
     *
     * A verify that is offered and refuses fails the check through `status`.
     * Nothing is lost by leaving it out of the shape, because the stronger
     * statement is the one below: asked again for the object, the provider
     * withholds the upload action, which is it saying it holds the bytes.
     */
    let verifyRefused = false;
    const verifyAction = firstObject.actions && firstObject.actions.verify;
    if (objectStored && verifyAction && verifyAction.href) {
      const verifyHeaders = { ...lfsHeaders(login), ...(verifyAction.header || {}) };
      /*
       * A refusal here is data, not a transport fault. Demanding 200 made a
       * store that had silently dropped the object fail the run with
       * "provider request failed" from the verify call, which is a true
       * sentence about the wrong step -- the condition that was actually not
       * met is the deduplication below, and it should be the one named.
       */
      const verifyResponse = await requestJson(fetchImpl, String(verifyAction.href), {
        method: 'POST',
        headers: verifyHeaders,
        body: { oid, size },
        allowedStatuses: [200, 404, 409, 422]
      });
      verifyRefused = verifyResponse.statusClass !== '2xx';
    }

    /*
     * Asked again, unchanged. The provider is now expected to answer with the
     * object and no upload action.
     */
    let deduplicatedOnRepeat = false;
    if (objectStored) {
      const second = await lfsBatch({ login, branch, objects: [{ oid, size }] });
      const secondObject = (second.data.objects || [])[0] || {};
      const repeatUpload = secondObject.actions && secondObject.actions.upload;
      deduplicatedOnRepeat = String(secondObject.oid || '') === oid
        && !secondObject.error
        && !repeatUpload;
    }

    const headAfter = await getBranch(branch, 'mutation');
    const pointerCommitted = !headBefore || !headAfter || headBefore.sha !== headAfter.sha;

    return [{
      key: 'lfs-object-upload',
      status: oidEchoed && uploadOffered && objectStored && deduplicatedOnRepeat
        && !pointerCommitted && !verifyRefused ? 'pass' : 'fail',
      statusClass: put.statusClass,
      oidEchoed,
      uploadOffered,
      objectStored,
      deduplicatedOnRepeat,
      pointerCommitted
    }];
  }

  async function pushChecks({ branch, prefix }) {
    const blobBytes = Buffer.from('Nebulaverse-X alpha.17 native push object\n', 'utf8');
    const inlineBytes = Buffer.from('Nebulaverse-X alpha.17 batch inline entry\n', 'utf8');
    const blobPath = `${prefix}-push-object.txt`;
    const inlinePath = `${prefix}-batch-inline.txt`;

    /*
     * The provider is handed bytes and asked what object they are. The answer
     * has to be the answer git would give, computed here from the same bytes.
     * A provider returning any well-formed sha passes a reachability check and
     * fails this one.
     */
    const blob = await createBlob(blobBytes);
    const expectedBlobSha = gitBlobSha1(blobBytes);
    const gitObjectIdentityMatched = blob.sha === expectedBlobSha;
    let blobReadBack = false;
    if (gitObjectIdentityMatched) {
      const stored = await readBlob(blob.sha);
      blobReadBack = stored.content.equals(blobBytes);
    }
    const blobCreate = {
      key: 'blob-create',
      status: gitObjectIdentityMatched && blobReadBack ? 'pass' : 'fail',
      statusClass: blob.statusClass,
      gitObjectIdentityMatched,
      blobReadBack
    };

    /*
     * Stop here if the object identity is not sound.
     *
     * Committing a tree that names an unverified sha would put the failure on
     * the tree endpoint -- which refuses an object it has never stored -- and
     * the run would report a transport error from the batch instead of the
     * identity mismatch that actually caused it. The first broken condition
     * should be the one named.
     */
    if (blobCreate.status !== 'pass') {
      return [blobCreate, {
        key: 'batch-commit',
        status: 'fail',
        statusClass: blob.statusClass,
        paths: 2,
        parentIsObservedHead: false,
        pathsLanded: false,
        nonFastForwardRefused: false
      }];
    }

    /*
     * One tree, two paths, one commit, one ref move -- the batch route's whole
     * sequence. One path arrives as inline content and the other as the blob
     * identity just earned, because the route accepts both and only the second
     * proves the two APIs agree about what an object is.
     */
    const observedHead = await getBranch(branch, 'mutation');
    const headCommit = await readCommit(observedHead.sha);
    const tree = await createTree({
      baseTree: headCommit.treeSha,
      entries: [
        { path: inlinePath, mode: '100644', type: 'blob', content: inlineBytes.toString('utf8') },
        { path: blobPath, mode: '100644', type: 'blob', sha: blob.sha }
      ]
    });
    const commit = await createCommit({
      message: 'test(alpha): batch commit proof',
      tree: tree.sha,
      parents: [observedHead.sha]
    });
    const published = await updateRef({ branch, sha: commit.sha, force: false });

    const batchHead = published.status === 200
      ? await observe(() => getBranch(branch, 'mutation'), head => Boolean(head) && head.sha === commit.sha)
      : null;
    const committed = published.status === 200 ? await readCommit(commit.sha) : null;
    const parentIsObservedHead = Boolean(committed) &&
      committed.parents.length === 1 &&
      committed.parents[0] === observedHead.sha &&
      Boolean(batchHead) && batchHead.sha === commit.sha;

    /*
     * Atomic in fact: both paths readable at the new head, with the bytes they
     * were given, and the blob-referenced one carrying the identity the blob
     * API reported. One landing without the other is a pair of writes, not a
     * batch.
     */
    let pathsLanded = false;
    if (parentIsObservedHead) {
      const inlineFile = await observe(
        () => readFile(branch, inlinePath, 'mutation'),
        file => file !== null
      );
      const blobFile = await observe(
        () => readFile(branch, blobPath, 'mutation'),
        file => file !== null
      );
      pathsLanded = Boolean(inlineFile) && Boolean(blobFile) &&
        inlineFile.content.equals(inlineBytes) &&
        blobFile.content.equals(blobBytes) &&
        blobFile.sha === blob.sha;
    }

    /*
     * The refusal commitTree translates into "the branch changed". Moving the
     * ref back to the commit it just descended from is a non-fast-forward, and
     * a provider enforcing ref safety refuses it rather than rewinding the
     * branch. Nothing is destroyed if it is refused, which is the outcome
     * required; a provider that accepted it would have rewound the branch, and
     * the check would say so instead of pretending otherwise.
     */
    const rewind = parentIsObservedHead
      ? await updateRef({ branch, sha: observedHead.sha, force: false })
      : null;
    const nonFastForwardRefused = Boolean(rewind) && rewind.status !== 200;

    const batchCommit = {
      key: 'batch-commit',
      status: 'fail',
      statusClass: tree.statusClass,
      paths: 2,
      parentIsObservedHead,
      pathsLanded,
      nonFastForwardRefused
    };
    batchCommit.status = parentIsObservedHead && pathsLanded && nonFastForwardRefused ? 'pass' : 'fail';

    return [blobCreate, batchCommit];
  }


  /*
   * ----------------------------------------------------------------------
   * The capabilities the registry has been calling Experimental with the
   * reason "implemented, but not exercised by the alpha.17 live-provider
   * harness". That reason was accurate for each of them, and the only way out
   * of it is to exercise them: every probe below sends the requests the
   * product's own route sends, in the order it sends them, and then checks
   * the outcome against something computed or read independently -- never
   * against the answer it is checking.
   * ----------------------------------------------------------------------
   */

  async function getJson(pathname, allowedStatuses = [200], credential = 'mutation') {
    return requestJson(fetchImpl, api(pathname), { headers: headers(credential), allowedStatuses });
  }

  async function sendJson(method, pathname, body, allowedStatuses, credential = 'mutation') {
    return requestJson(fetchImpl, api(pathname), {
      method, headers: headers(credential), body, allowedStatuses
    });
  }

  /* gitTreeEntryByPath in server.js: one level of the tree at a time. */
  async function treeEntryByPath(rootTreeSha, entryPath) {
    const parts = entryPath.split('/');
    let treeSha = rootTreeSha;
    for (let index = 0; index < parts.length; index += 1) {
      const level = await getJson(`repos/${repositoryPath}/git/trees/${encodeURIComponent(treeSha)}`);
      const entry = (Array.isArray(level.data.tree) ? level.data.tree : []).find(item => item.path === parts[index]);
      if (!entry) return null;
      if (index === parts.length - 1) return entry;
      if (entry.type !== 'tree') return null;
      treeSha = entry.sha;
    }
    return null;
  }

  async function recursiveTree(treeish) {
    const url = new URL(api(`repos/${repositoryPath}/git/trees/${encodeURIComponent(treeish)}`));
    url.searchParams.set('recursive', '1');
    const response = await requestJson(fetchImpl, url.toString(), { headers: headers('mutation'), allowedStatuses: [200] });
    return {
      truncated: response.data.truncated === true,
      entries: (Array.isArray(response.data.tree) ? response.data.tree : []).map(entry => ({
        path: String(entry.path || ''), mode: String(entry.mode || ''), type: String(entry.type || ''),
        sha: String(entry.sha || '').toLowerCase()
      }))
    };
  }

  /*
   * commitTree in server.js, request for request: the ref, its commit, the
   * recursive base tree, one tree carrying every entry, one commit on the
   * observed head, and a ref move without force.
   */
  async function commitEntries({ branch, message, entries, expectedHead }) {
    const head = await getBranch(branch, 'mutation');
    assertExpectedHead(expectedHead, head && head.sha);
    const parent = await readCommit(head.sha);
    const base = await recursiveTree(parent.treeSha);
    const existing = new Map(base.entries.map(entry => [entry.path, entry]));
    const normalized = entries.map(entry => {
      const prior = existing.get(entry.preserveFrom || entry.path);
      const mode = entry.forceMode && entry.mode ? entry.mode : (prior && prior.mode) || entry.mode || '100644';
      const type = entry.forceMode && entry.type ? entry.type : (prior && prior.type) || entry.type || 'blob';
      const out = { path: entry.path, mode, type };
      if (Object.prototype.hasOwnProperty.call(entry, 'sha')) out.sha = entry.sha;
      else out.content = entry.content;
      return out;
    });
    const tree = await createTree({ baseTree: parent.treeSha, entries: normalized });
    const commit = await createCommit({ message, tree: tree.sha, parents: [head.sha] });
    const moved = await updateRef({ branch, sha: commit.sha, force: false });
    return { observedHead: head.sha, commitSha: commit.sha, published: moved.status === 200, statusClass: tree.statusClass };
  }

  async function parentIsObserved(branch, commitSha, observedHead) {
    const landed = await observe(() => getBranch(branch, 'mutation'), current => Boolean(current) && current.sha === commitSha);
    if (!landed || landed.sha !== commitSha) return false;
    const committed = await readCommit(commitSha);
    return committed.parents.length === 1 && committed.parents[0] === observedHead;
  }

  /*
   * file.rename. The product finds the source in the tree of the head it
   * observed, one level at a time, and re-links its blob at the new path in
   * one commit on that head -- the bytes are never re-uploaded, which is why
   * a rename works for a file of any size. So the proof is identity: the new
   * path must carry the very object the old one did, the old path must be
   * gone, and the commit must descend from the head that was read.
   */
  async function renameCheck({ branch, prefix }) {
    const from = `${prefix}-batch-inline.txt`;
    const to = `${prefix}-tree/nested/inline.txt`;
    const head = await getBranch(branch, 'mutation');
    const headCommit = await readCommit(head.sha);
    const source = await treeEntryByPath(headCommit.treeSha, from);
    const destinationFree = !(await treeEntryByPath(headCommit.treeSha, to));
    if (!source || source.type !== 'blob' || !destinationFree) {
      return { key: 'file-rename', status: 'fail', statusClass: '2xx', parentIsObservedHead: false, identityPreserved: false, sourceRemoved: false };
    }
    const sourceSha = String(source.sha || '').toLowerCase();
    const result = await commitEntries({
      branch,
      message: `test(alpha): rename ${from} -> ${to}`,
      expectedHead: head.sha,
      entries: [
        { path: to, sha: sourceSha, preserveFrom: from },
        { path: from, sha: null, preserveFrom: from }
      ]
    });
    const parentIsObservedHead = result.published && await parentIsObserved(branch, result.commitSha, head.sha);
    const moved = parentIsObservedHead ? await observe(() => readFile(branch, to, 'mutation'), file => file !== null) : null;
    const identityPreserved = Boolean(moved) && moved.sha === sourceSha;
    const sourceRemoved = parentIsObservedHead && (await readFile(branch, from, 'mutation')) === null;
    return {
      key: 'file-rename',
      status: parentIsObservedHead && identityPreserved && sourceRemoved ? 'pass' : 'fail',
      statusClass: result.statusClass,
      parentIsObservedHead,
      identityPreserved,
      sourceRemoved
    };
  }

  /*
   * folder.move. A second file is put under the folder first, so the move
   * carries more than one path and a nested one -- that is ordinary batch
   * work, already proved, and not the thing under test. Then the product's
   * sequence: the recursive tree of the observed head, every entry under the
   * folder re-linked under the destination and removed from the source, one
   * commit on that head. Every moved path must keep its object identity and
   * nothing may remain under the source.
   */
  async function folderMoveCheck({ branch, prefix }) {
    const folder = `${prefix}-tree`;
    const destination = `${prefix}-moved`;
    const seeded = await commitEntries({
      branch,
      message: 'test(alpha): folder move fixture',
      expectedHead: (await getBranch(branch, 'mutation')).sha,
      entries: [{ path: `${folder}/second.txt`, content: 'Nebulaverse-X alpha.17 folder move entry\n' }]
    });
    await observe(() => getBranch(branch, 'mutation'), current => Boolean(current) && current.sha === seeded.commitSha);

    const head = await getBranch(branch, 'mutation');
    const listing = await recursiveTree(head.sha);
    const inside = listing.entries.filter(entry => (entry.type === 'blob' || entry.type === 'commit') &&
      (entry.path === folder || entry.path.startsWith(`${folder}/`)));
    if (listing.truncated || inside.length < 2) {
      return { key: 'folder-move', status: 'fail', statusClass: '2xx', filesMoved: 0, parentIsObservedHead: false, identitiesPreserved: false, sourceEmptied: false };
    }
    const entries = [];
    for (const entry of inside) {
      const destinationPath = destination + entry.path.slice(folder.length);
      entries.push({ path: destinationPath, mode: entry.mode, type: entry.type, sha: entry.sha, forceMode: true });
      entries.push({ path: entry.path, mode: entry.mode, type: entry.type, sha: null, forceMode: true });
    }
    const result = await commitEntries({ branch, message: `test(alpha): move ${folder} -> ${destination}`, entries, expectedHead: head.sha });
    const parentIsObservedHead = result.published && await parentIsObserved(branch, result.commitSha, head.sha);
    let identitiesPreserved = false;
    let sourceEmptied = false;
    if (parentIsObservedHead) {
      const after = await observe(() => recursiveTree(result.commitSha), tree => !tree.truncated);
      const byPath = new Map(after.entries.map(entry => [entry.path, entry]));
      identitiesPreserved = inside.every(entry => {
        const moved = byPath.get(destination + entry.path.slice(folder.length));
        return Boolean(moved) && moved.sha === entry.sha;
      });
      sourceEmptied = !after.entries.some(entry => entry.path === folder || entry.path.startsWith(`${folder}/`));
    }
    return {
      key: 'folder-move',
      status: parentIsObservedHead && identitiesPreserved && sourceEmptied ? 'pass' : 'fail',
      statusClass: result.statusClass,
      filesMoved: inside.length,
      parentIsObservedHead,
      identitiesPreserved,
      sourceEmptied
    };
  }

  /*
   * issues.write: create, comment and close, each read back from the
   * provider rather than trusted from its own acknowledgement, and the
   * read-only credential refused. GitHub offers no way to delete an issue
   * over REST, so the issue stays -- closed, titled for the run that made it.
   */
  async function issueWriteCheck({ prefix }) {
    const title = `Nebulaverse-X alpha.17 issue ${prefix}`;
    const comment = `Nebulaverse-X alpha.17 comment ${prefix}`;
    const created = await sendJson('POST', `repos/${repositoryPath}/issues`, { title, body: 'Created and closed by the alpha.17 qualification run.' }, [201]);
    const number = Number(created.data.number);
    const read = await getJson(`repos/${repositoryPath}/issues/${number}`);
    const createdReadBack = Number(read.data.number) === number && read.data.title === title && read.data.state === 'open';
    await sendJson('POST', `repos/${repositoryPath}/issues/${number}/comments`, { body: comment }, [201]);
    const comments = await observe(
      () => getJson(`repos/${repositoryPath}/issues/${number}/comments`),
      response => Array.isArray(response.data) && response.data.some(item => item && item.body === comment)
    );
    const commentReadBack = Array.isArray(comments.data) && comments.data.some(item => item && item.body === comment);
    await sendJson('PATCH', `repos/${repositoryPath}/issues/${number}`, { state: 'closed' }, [200]);
    const closed = await observe(() => getJson(`repos/${repositoryPath}/issues/${number}`), response => response.data.state === 'closed');
    const closedReadBack = closed.data.state === 'closed';
    const refused = await sendJson('POST', `repos/${repositoryPath}/issues`, { title: `${title} (read-only)`, body: '' }, [201, 403, 404], 'readOnly');
    const readOnlyRefused = refused.status === 403 || refused.status === 404;
    if (!readOnlyRefused && Number(refused.data && refused.data.number) > 0) {
      await sendJson('PATCH', `repos/${repositoryPath}/issues/${Number(refused.data.number)}`, { state: 'closed' }, [200]);
    }
    return {
      key: 'issue-write',
      status: createdReadBack && commentReadBack && closedReadBack && readOnlyRefused ? 'pass' : 'fail',
      statusClass: created.statusClass,
      createdReadBack,
      commentReadBack,
      closedReadBack,
      readOnlyRefused
    };
  }

  /*
   * pulls.write, against two disposable branches so nothing reaches the
   * default branch: a head cut from this run's branch and a base cut from the
   * default head. Open, review, then merge -- first with a head the provider
   * no longer has, which it must refuse, then with the head it reported, which
   * it must accept. That refusal is the precondition the product now sends so
   * a merge confirmed against one set of commits cannot take another; it is
   * observed here from the provider, not assumed.
   */
  async function pullWriteCheck({ branch, prefix, defaultBranch }) {
    const headBranch = `${branch}-pr-head`;
    const baseBranch = `${branch}-pr-base`;
    const source = await getBranch(branch, 'mutation');
    const defaultHead = await getBranch(defaultBranch, 'mutation');
    await createBranch(headBranch, source.sha);
    await createBranch(baseBranch, defaultHead.sha);
    let createdReadBack = false;
    let reviewRecorded = false;
    let staleHeadRefused = false;
    let mergedIntoBase = false;
    let statusClassValue = '2xx';
    try {
      const title = `Nebulaverse-X alpha.17 pull ${prefix}`;
      const created = await sendJson('POST', `repos/${repositoryPath}/pulls`, {
        title, head: headBranch, base: baseBranch, body: 'Opened and merged by the alpha.17 qualification run.', draft: false
      }, [201]);
      statusClassValue = created.statusClass;
      const number = Number(created.data.number);
      const read = await observe(
        () => getJson(`repos/${repositoryPath}/pulls/${number}`),
        response => response.data.head && String(response.data.head.sha || '').toLowerCase() === source.sha
      );
      const reportedHead = String(read.data.head && read.data.head.sha || '').toLowerCase();
      createdReadBack = Number(read.data.number) === number && read.data.state === 'open' &&
        read.data.head.ref === headBranch && read.data.base.ref === baseBranch && reportedHead === source.sha;
      const review = await sendJson('POST', `repos/${repositoryPath}/pulls/${number}/reviews`, {
        event: 'COMMENT', body: `Nebulaverse-X alpha.17 review ${prefix}`
      }, [200]);
      reviewRecorded = Number(review.data.id) > 0 && review.data.state === 'COMMENTED';
      const stale = await sendJson('PUT', `repos/${repositoryPath}/pulls/${number}/merge`, {
        merge_method: 'merge', sha: defaultHead.sha
      }, [200, 409]);
      staleHeadRefused = stale.status === 409;
      if (createdReadBack && staleHeadRefused) {
        const merged = await sendJson('PUT', `repos/${repositoryPath}/pulls/${number}/merge`, {
          merge_method: 'merge', sha: reportedHead
        }, [200, 405, 409]);
        const mergeSha = String(merged.data && merged.data.sha || '').toLowerCase();
        if (merged.status === 200 && /^[0-9a-f]{40}$/.test(mergeSha)) {
          const landed = await observe(() => getBranch(baseBranch, 'mutation'), current => Boolean(current) && current.sha === mergeSha);
          const commit = landed && landed.sha === mergeSha ? await readCommit(mergeSha) : null;
          mergedIntoBase = Boolean(commit) && commit.parents.length === 2 &&
            commit.parents[0] === defaultHead.sha && commit.parents[1] === source.sha;
        }
      }
    } finally {
      for (const name of [headBranch, baseBranch]) {
        const present = await getBranch(name, 'mutation');
        if (present) await requestJson(fetchImpl, api(`repos/${repositoryPath}/git/refs/heads/${encodeURIComponent(name)}`), {
          method: 'DELETE', headers: headers('mutation'), allowedStatuses: [204, 404, 422]
        });
      }
    }
    const refsRemoved = !(await observe(() => getBranch(headBranch, 'mutation'), current => current === null)) &&
      !(await observe(() => getBranch(baseBranch, 'mutation'), current => current === null));
    return {
      key: 'pull-write',
      status: createdReadBack && reviewRecorded && staleHeadRefused && mergedIntoBase && refsRemoved ? 'pass' : 'fail',
      statusClass: statusClassValue,
      createdReadBack,
      reviewRecorded,
      staleHeadRefused,
      mergedIntoBase,
      refsRemoved
    };
  }

  /*
   * releases.write: the product's create request, a prerelease on this run's
   * branch. Publishing creates the tag at the target, so the proof reads the
   * tag back and requires it at the branch head the release was cut from --
   * and the cleanup removes the release and the tag and reads both as gone.
   */
  async function releaseWriteCheck({ branch, prefix }) {
    const tag = `${prefix}-release`;
    const target = await getBranch(branch, 'mutation');
    const created = await sendJson('POST', `repos/${repositoryPath}/releases`, {
      tag_name: tag, name: tag, body: 'Created and removed by the alpha.17 qualification run.',
      target_commitish: branch, prerelease: true
    }, [201]);
    const id = Number(created.data.id);
    let createdReadBack = false;
    let tagAtTarget = false;
    try {
      const read = await observe(() => getJson(`repos/${repositoryPath}/releases/${id}`, [200, 404]), response => response.status === 200);
      createdReadBack = read.status === 200 && Number(read.data.id) === id && read.data.tag_name === tag &&
        read.data.prerelease === true && read.data.draft !== true;
      const ref = await observe(() => getJson(`repos/${repositoryPath}/git/ref/tags/${encodeURIComponent(tag)}`, [200, 404]), response => response.status === 200);
      tagAtTarget = ref.status === 200 && String(ref.data.object && ref.data.object.sha || '').toLowerCase() === target.sha;
    } finally {
      await requestJson(fetchImpl, api(`repos/${repositoryPath}/releases/${id}`), { method: 'DELETE', headers: headers('mutation'), allowedStatuses: [204, 404] });
      await requestJson(fetchImpl, api(`repos/${repositoryPath}/git/refs/tags/${encodeURIComponent(tag)}`), { method: 'DELETE', headers: headers('mutation'), allowedStatuses: [204, 404, 422] });
    }
    const releaseGone = await observe(() => getJson(`repos/${repositoryPath}/releases/${id}`, [200, 404]), response => response.status === 404);
    const tagGone = await observe(() => getJson(`repos/${repositoryPath}/git/ref/tags/${encodeURIComponent(tag)}`, [200, 404]), response => response.status === 404);
    const cleanupAbsent = releaseGone.status === 404 && tagGone.status === 404;
    return {
      key: 'release-write',
      status: createdReadBack && tagAtTarget && cleanupAbsent ? 'pass' : 'fail',
      statusClass: created.statusClass,
      createdReadBack,
      tagAtTarget,
      cleanupAbsent
    };
  }

  /*
   * stars.read and stars.write: the account's star on the target, read,
   * set, read, cleared, read -- and put back the way it was found, because
   * the account is a person's and not the run's.
   */
  async function starCheck() {
    const starPath = `user/starred/${repositoryPath}`;
    const starred = async () => (await getJson(starPath, [204, 404])).status === 204;
    const initially = await starred();
    const set = await sendJson('PUT', starPath, undefined, [204]);
    const starVisible = await observe(starred, value => value === true);
    await sendJson('DELETE', starPath, undefined, [204]);
    const unstarVisible = (await observe(starred, value => value === false)) === false;
    if (initially) await sendJson('PUT', starPath, undefined, [204]);
    const initialStateRestored = (await observe(starred, value => value === initially)) === initially;
    return {
      key: 'star-toggle',
      status: starVisible && unstarVisible && initialStateRestored ? 'pass' : 'fail',
      statusClass: set.statusClass,
      starVisible,
      unstarVisible,
      initialStateRestored
    };
  }

  /*
   * search: the product's scoped query -- the reader's words, the repository
   * named by the server -- against the permanent search fixture on the
   * default branch, which is the only branch GitHub indexes. Every result has
   * to belong to the target, and a word that exists nowhere has to find
   * nothing: an endpoint that answered every query with the same list would
   * pass a reachability check and fail this.
   */
  async function codeSearchCheck({ prefix }) {
    const search = async words => {
      const url = new URL(api('search/code'));
      url.searchParams.set('q', `${words} repo:${repository}`);
      url.searchParams.set('per_page', '30');
      return requestJson(fetchImpl, url.toString(), { headers: headers('mutation'), allowedStatuses: [200] });
    };
    const found = await search(SEARCH_FIXTURE_MARKER);
    const items = Array.isArray(found.data.items) ? found.data.items : [];
    const fixtureFound = items.some(item => item && item.path === SEARCH_FIXTURE_PATH);
    const resultsScoped = items.length > 0 &&
      items.every(item => String(item && item.repository && item.repository.full_name || '').toLowerCase() === repository.toLowerCase());
    const absent = await search(`nvx-alpha17-absent-${crypto.createHash('sha256').update(prefix).digest('hex').slice(0, 16)}`);
    const absentDiscriminated = Array.isArray(absent.data.items) && absent.data.items.length === 0;
    return {
      key: 'code-search',
      status: fixtureFound && resultsScoped && absentDiscriminated ? 'pass' : 'fail',
      statusClass: found.statusClass,
      fixtureFound,
      resultsScoped,
      absentDiscriminated
    };
  }

  /*
   * workflows.rerun. A run can be re-run only once it has finished and only
   * for thirty days, so the permanent fixture run ages out of being the
   * subject; the probe dispatches the fixture workflow on the default branch,
   * waits for that run to finish, re-runs it through the product's request,
   * and requires the provider to report the next attempt of the same run.
   */
  async function workflowRerunCheck({ defaultBranch }) {
    const listing = await getJson(`repos/${repositoryPath}/actions/runs?per_page=10`);
    const fixtureRun = (Array.isArray(listing.data.workflow_runs) ? listing.data.workflow_runs : [])
      .find(run => run && run.event === 'workflow_dispatch');
    const workflowId = Number(fixtureRun && fixtureRun.workflow_id);
    const failed = extra => ({ key: 'workflow-rerun', status: 'fail', statusClass: listing.statusClass, dispatchedRunCompleted: false, rerunAccepted: false, attemptAdvanced: false, ...extra });
    if (!Number.isSafeInteger(workflowId) || workflowId <= 0) return failed({});
    const runsPath = `repos/${repositoryPath}/actions/workflows/${workflowId}/runs?event=workflow_dispatch&per_page=5`;
    const before = await getJson(runsPath);
    const known = new Set((before.data.workflow_runs || []).map(run => Number(run.id)));
    await sendJson('POST', `repos/${repositoryPath}/actions/workflows/${workflowId}/dispatches`, { ref: defaultBranch }, [204]);
    const appeared = await observe(
      () => getJson(runsPath),
      response => (response.data.workflow_runs || []).some(run => !known.has(Number(run.id))),
      runObservationAttempts(env)
    );
    const dispatched = (appeared.data.workflow_runs || []).find(run => !known.has(Number(run.id)));
    if (!dispatched) return failed({});
    const runPath = `repos/${repositoryPath}/actions/runs/${Number(dispatched.id)}`;
    const finished = await observe(() => getJson(runPath), response => response.data.status === 'completed', runObservationAttempts(env));
    const dispatchedRunCompleted = finished.data.status === 'completed';
    if (!dispatchedRunCompleted) return failed({});
    const attempt = Number(finished.data.run_attempt) || 1;
    /* The product's request exactly: no body. */
    const rerun = await sendJson('POST', `${runPath}/rerun`, undefined, [201, 403, 409]);
    const rerunAccepted = rerun.status === 201;
    const advanced = rerunAccepted
      ? await observe(() => getJson(runPath), response => Number(response.data.run_attempt) === attempt + 1)
      : null;
    const attemptAdvanced = Boolean(advanced) && Number(advanced.data.run_attempt) === attempt + 1;
    return {
      key: 'workflow-rerun',
      status: dispatchedRunCompleted && rerunAccepted && attemptAdvanced ? 'pass' : 'fail',
      statusClass: rerun.statusClass,
      dispatchedRunCompleted,
      rerunAccepted,
      attemptAdvanced
    };
  }

  /*
   * exposure.scan, where it touches the provider: the reader. Detection,
   * identity, storage and verification are the product's own and are proved
   * deterministically; what only a live provider can prove is that the reader
   * understands its answers. So the product's reader module itself is run
   * against this branch -- resolving the ref to the head, listing the tree at
   * that commit and finding the proof file under the identity the contents
   * API gave it, reading that blob back as the exact proof text, and walking
   * history to the commit that added it with the proof line as an added
   * line. That last one is what a history scan reports a leak from.
   */
  async function exposureReadCheck({ branch, proofPath, proofFileSha, proofText }) {
    const scope = { provider: 'github', owner: repository.split('/')[0], repo: repository.split('/')[1] };
    const transport = readerTransport();
    const token = mutationCredential;
    const head = await getBranch(branch, 'mutation');
    let refResolved = false;
    let treeBound = false;
    let blobTextMatched = false;
    let historyReached = false;
    try {
      const resolved = await exposureReader.resolveCommit({ scope, ref: branch, token, transport });
      refResolved = resolved.commitSha === head.sha;
      const tree = await exposureReader.readTree({ scope, commitSha: resolved.commitSha, token, transport });
      const entry = tree.entries.find(item => item.path === proofPath);
      treeBound = !tree.truncated && Boolean(entry) && entry.sha === proofFileSha;
      if (entry) {
        const blob = await exposureReader.readBlob({ scope, sha: entry.sha, token, transport });
        blobTextMatched = blob.text === proofText;
      }
      const log = await exposureReader.listCommits({ scope, commitSha: resolved.commitSha, token, transport, maxCommits: 25 });
      const firstLine = proofText.split('\n')[0];
      for (const commit of log.commits) {
        const changes = await exposureReader.readCommitChanges({ scope, sha: commit.sha, token, transport });
        const file = changes.files.find(item => item.path === proofPath && item.status === 'added');
        if (file && Array.isArray(file.hunks) && file.hunks.some(hunk => Array.isArray(hunk.lines) &&
          hunk.lines.some(line => line.added === true && line.text === firstLine))) {
          historyReached = true;
          break;
        }
      }
    } catch {
      /* A reader error is the probe failing; the fields say which step. */
    }
    return {
      key: 'exposure-read',
      status: refResolved && treeBound && blobTextMatched && historyReached ? 'pass' : 'fail',
      statusClass: '2xx',
      refResolved,
      treeBound,
      blobTextMatched,
      historyReached
    };
  }

  /*
   * The reader's transport, pointed at this run's API origin. The reader
   * names api.github.com itself; the harness may be aimed elsewhere (a
   * fixture, an enterprise host), so the path and query are kept and the
   * origin is this run's.
   */
  function readerTransport() {
    return async ({ url, method, headers: requestHeaders, maxResponseBytes }) => {
      const source = new URL(url);
      const target = api(`${source.pathname.replace(/^\/+/, '')}${source.search}`);
      const response = await fetchImpl(target, { method: method || 'GET', headers: requestHeaders, redirect: 'error' });
      const body = await response.text();
      if (Number.isFinite(maxResponseBytes) && Buffer.byteLength(body) > maxResponseBytes) {
        throw new Error('reader response exceeded its bound');
      }
      return { statusCode: response.status, body };
    };
  }

  function capabilityChecksNotRun() {
    const notRun = (key, extra = {}) => ({ key, status: 'fail', statusClass: '2xx', ...extra });
    return [
      notRun('exposure-read', { refResolved: false, treeBound: false, blobTextMatched: false, historyReached: false }),
      notRun('file-rename', { parentIsObservedHead: false, identityPreserved: false, sourceRemoved: false }),
      notRun('folder-move', { filesMoved: 0, parentIsObservedHead: false, identitiesPreserved: false, sourceEmptied: false }),
      notRun('issue-write', { createdReadBack: false, commentReadBack: false, closedReadBack: false, readOnlyRefused: false }),
      notRun('pull-write', { createdReadBack: false, reviewRecorded: false, staleHeadRefused: false, mergedIntoBase: false, refsRemoved: false }),
      notRun('release-write', { createdReadBack: false, tagAtTarget: false, cleanupAbsent: false }),
      notRun('star-toggle', { starVisible: false, unstarVisible: false, initialStateRestored: false }),
      notRun('code-search', { fixtureFound: false, resultsScoped: false, absentDiscriminated: false }),
      notRun('workflow-rerun', { dispatchedRunCompleted: false, rerunAccepted: false, attemptAdvanced: false })
    ];
  }

  async function capabilityChecks({ branch, prefix, proofPath, proofFileSha, proofText }) {
    const { defaultBranch } = await getRepository('mutation');
    return [
      await exposureReadCheck({ branch, proofPath, proofFileSha, proofText }),
      await renameCheck({ branch, prefix }),
      await folderMoveCheck({ branch, prefix }),
      await issueWriteCheck({ prefix }),
      await pullWriteCheck({ branch, prefix, defaultBranch }),
      await releaseWriteCheck({ branch, prefix }),
      await starCheck(),
      await codeSearchCheck({ prefix }),
      await workflowRerunCheck({ defaultBranch })
    ];
  }

  return Object.freeze({
    getRepository, getBranch, createBranch, writeFile, conditionalUpdate, readFile, deleteFile, deleteBranch,
    readTree, readRateLimit, readCollection, createBlob, readBlob, readCommit, createTree, createCommit,
    updateRef, probeChecks
  });
}

async function runGithubValidation(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  return runProviderQualification({
    provider: 'github',
    client: createGithubClient({ env, fetchImpl }),
    env,
    now: options.now
  });
}

if (require.main === module) {
  runGithubValidation().then(
    result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`),
    error => {
      process.stderr.write(`${error.code ? `${error.code}: ` : ''}${error.message}\n`);
      /*
       * The failing check, when the failure carried one. Runs 63 and 64 both
       * died on a proof that had recorded exactly which condition broke and
       * printed none of it, so the log said only that something changed.
       */
      if (error.check) process.stderr.write(`${JSON.stringify(error.check)}\n`);
      process.exitCode = 1;
    }
  );
}

module.exports = Object.freeze({ createGithubClient, runGithubValidation });
