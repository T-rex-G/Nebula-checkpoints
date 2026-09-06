#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const {
  assertExpectedHead,
  observe,
  requestJson,
  runProviderQualification
} = require('./provider-alpha17-common');

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
  async function probeChecks({ branch, prefix, proofPath, proofFileSha }) {
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

    return [treeRead, rateRead, ...collections, ...(await pushChecks({ branch, prefix }))];
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
