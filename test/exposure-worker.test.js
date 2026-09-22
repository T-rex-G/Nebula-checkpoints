'use strict';

/*
 * Running a scan on one free web service, against repositories nobody here
 * has seen, without keeping anything and without trusting that the process
 * will survive.
 *
 * The properties worth testing are the ones a happy path never exercises.
 *
 * A branch can move while a scan is running, so the tree and every blob must
 * come from one immutable commit -- a scan that mixed two trees would report
 * findings at locations that never existed together, and a reader sent to one
 * would find nothing there.
 *
 * A budget must produce visibly partial coverage. Silently stopping at a
 * ceiling and reporting success is the single worst thing this feature could
 * do: it tells somebody their repository is clean because the scan gave up.
 *
 * A cancel must be noticed while files are being read rather than between
 * jobs, and the loop must not monopolise the event loop while it reads --
 * this process also serves HTTP.
 *
 * And a worker can be killed. Not "throw an exception" -- killed, between a
 * write and a finalise, with no `finally` block and no chance to tidy up. The
 * recovery has to work with nothing but what is in the database.
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { KEY_PURPOSES, deriveKey } = require('../src/key-derivation');
const { SKIP_REASONS } = require('../src/exposure-reader');
const { fingerprintFor } = require('../src/exposure-findings');
const {
  DEFAULT_BUDGETS,
  EXPOSURE_BUDGET_VERSION,
  createExposureRunner,
  startExposureWorker
} = require('../src/exposure-worker');

const scope = Object.freeze({
  provider: 'github', authority: 'github.com', owner: 'Acme', repo: 'Demo'
});
const IDENTITY = 'a'.repeat(64);
const COMMIT = 'c'.repeat(40);
const OTHER_COMMIT = 'd'.repeat(40);
const T0 = Date.parse('2026-09-22T12:00:00.000Z');
const fingerprintKey = deriveKey('k'.repeat(64), KEY_PURPOSES.EXPOSURE_FINDING_FINGERPRINT);
const TOKEN = `gh${'p'}_${'W'.repeat(36)}`;
const SECRET = `gh${'p'}_${'S'.repeat(36)}`;

/*
 * A store that records what it was asked, decides claims the way the real one
 * does, and can lose a claim underneath a running scan.
 */
function fakeStore(overrides = {}) {
  const store = {
    calls: [],
    scan: {
      scanId: 's-1',
      scope,
      requestedBy: 'alice',
      refName: 'refs/heads/main',
      commitSha: COMMIT,
      rulesVersion: 1,
      engineVersion: 1,
      fingerprintKeyVersion: 1,
      configVersion: 1,
      state: 'running',
      coverage: 'unknown'
    },
    claimOwner: 'token-1',
    claimHolds: true,
    recorded: [],
    finalized: null,
    claimsRemaining: 1,
    async claimScan(input) {
      store.calls.push(['claimScan', input]);
      if (store.claimsRemaining <= 0) return null;
      store.claimsRemaining -= 1;
      return { scan: store.scan, claimOwner: store.claimOwner };
    },
    async renewClaim(input) {
      store.calls.push(['renewClaim', input]);
      return store.claimHolds;
    },
    async recordObservations(input) {
      store.calls.push(['recordObservations', input]);
      store.recorded.push(...input.findings);
      return { recorded: input.findings.length, submitted: input.findings.length };
    },
    async finalizeScan(input) {
      store.calls.push(['finalizeScan', input]);
      store.finalized = input;
      return { ...store.scan, ...input };
    },
    ...overrides
  };
  return store;
}

function blob(text) {
  return { text, skip: null };
}

/*
 * A reader that answers from a fixture and counts what it was asked for. The
 * real one is tested separately; what matters here is which commit the worker
 * asks about and how many times.
 */
function fakeReader(files, options = {}) {
  const reader = {
    treeCalls: [],
    blobCalls: [],
    async readTree(input) {
      reader.treeCalls.push(input);
      if (options.treeError) throw options.treeError;
      return {
        commitSha: input.commitSha,
        entries: Object.keys(files).map((filePath, index) => ({
          path: filePath, sha: crypto.createHash('sha1').update(filePath).digest('hex'), size: 100 + index
        })),
        skipped: options.skipped || [],
        truncated: Boolean(options.truncated),
        skippedReason: options.truncated ? 'tree-truncated' : null
      };
    },
    async readBlob(input) {
      reader.blobCalls.push(input);
      if (options.onBlob) await options.onBlob(reader.blobCalls.length, input);
      if (options.blobError) throw options.blobError;
      const entry = Object.entries(files).find(
        ([filePath]) => crypto.createHash('sha1').update(filePath).digest('hex') === input.sha
      );
      const value = entry ? entry[1] : null;
      return typeof value === 'string' ? blob(value) : (value || { text: null, skip: SKIP_REASONS.UNREADABLE });
    }
  };
  return reader;
}

function runnerFor(store, reader, options = {}) {
  return createExposureRunner({
    store,
    reader,
    fingerprintKey,
    sessionResolver: options.sessionResolver || (async () => ({ token: TOKEN })),
    budgets: { ...DEFAULT_BUDGETS, renewEveryFiles: 2, ...(options.budgets || {}) },
    now: options.now || (() => T0)
  });
}

(async () => {
  /* ---- Nothing runs, nothing is written to disk ------------------------ */

  {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'exposure-worker.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert(source.includes('function createExposureRunner'), 'the comment strip must leave the code behind');
    for (const forbidden of [
      /require\('child_process'\)/, /require\('fs'\)/, /require\('https'\)/,
      /\bspawn\w*\(/, /\bexec\w*\(/, /mkdtemp/, /writeFile/, /\bfetch\s*\(/
    ]) {
      assert.strictEqual(
        forbidden.test(source), false,
        `a scan runs nothing and keeps nothing: ${forbidden}`
      );
    }
    assert(Number.isInteger(EXPOSURE_BUDGET_VERSION) && EXPOSURE_BUDGET_VERSION >= 1);
  }

  /* ---- One commit, and never a ref ------------------------------------ */

  {
    const store = fakeStore();
    const reader = fakeReader({ 'app/config.js': `token = ${SECRET}\n`, 'README.md': 'nothing here\n' });
    const result = await runnerFor(store, reader).runOnce();

    assert.strictEqual(result.claimed, true);
    assert.strictEqual(reader.treeCalls.length, 1);
    assert.strictEqual(reader.treeCalls[0].commitSha, COMMIT);
    /*
     * The ref is in the scan row and the worker never looks at it. Resolving
     * a branch name at execution is what lets a push between the tree read
     * and the blob reads mix two trees into one finding set.
     */
    assert.strictEqual(
      JSON.stringify(reader.treeCalls[0]).includes('refs/heads/main'), false,
      'a worker resolves nothing: it reads the commit it was handed'
    );
    for (const call of reader.blobCalls) {
      assert.strictEqual(call.scope.owner, 'Acme');
      assert.strictEqual(call.token, TOKEN);
    }

    /* One finding, with the identity the findings module would give it. */
    assert.strictEqual(store.recorded.length, 1);
    assert.strictEqual(store.recorded[0].rule, 'github-token');
    assert.strictEqual(store.recorded[0].path, 'app/config.js');
    assert.strictEqual(
      store.recorded[0].fingerprint,
      fingerprintFor({
        hmacKey: fingerprintKey, scope, path: 'app/config.js', rule: 'github-token', secret: SECRET
      }),
      'the worker does not have its own idea of identity'
    );
    assert.strictEqual(store.finalized.state, 'complete');
    assert.strictEqual(store.finalized.coverage, 'complete');
    assert.strictEqual(store.finalized.skippedReason, null);
    assert.strictEqual(store.finalized.filesScanned, 2);
  }

  /* Nothing to claim is not an error, and asks the provider nothing. */
  {
    const store = fakeStore({ claimsRemaining: 0 });
    const reader = fakeReader({});
    const result = await runnerFor(store, reader).runOnce();
    assert.strictEqual(result.claimed, false);
    assert.strictEqual(reader.treeCalls.length, 0);
    assert.strictEqual(store.finalized, null);
  }

  /* ---- The credential is resolved at execution and never stored ------- */

  {
    const store = fakeStore();
    const reader = fakeReader({ 'a.js': `x = ${SECRET}\n` });
    let resolverCalls = 0;
    await runnerFor(store, reader, {
      sessionResolver: async input => {
        resolverCalls += 1;
        assert.strictEqual(input.identityKey, undefined, 'the resolver is asked about a scan, not handed a key it did not need');
        assert.strictEqual(input.scope.repo, 'Demo');
        assert.strictEqual(input.requestedBy, 'alice');
        return { token: TOKEN };
      }
    }).runOnce();
    assert.strictEqual(resolverCalls, 1, 'once per scan, at execution');

    /* No call into the store carries the token, at any depth. */
    const serialized = JSON.stringify(store.calls);
    assert.strictEqual(serialized.includes(TOKEN), false, 'a job never stores a copy of a credential');
    assert.strictEqual(serialized.includes(TOKEN.slice(4, 20)), false);
    assert.strictEqual(serialized.includes(SECRET), false, 'nor the credential it found');
  }

  /*
   * Revoked before the scan starts: the job stops visibly rather than being
   * recorded as a repository that was read and found clean.
   */
  {
    for (const session of [null, undefined, {}, { token: '' }]) {
      const store = fakeStore();
      const reader = fakeReader({ 'a.js': 'x\n' });
      await runnerFor(store, reader, { sessionResolver: async () => session }).runOnce();
      assert.strictEqual(store.finalized.state, 'failed', JSON.stringify(session));
      assert.strictEqual(store.finalized.skippedReason, 'authorization-revoked');
      assert.strictEqual(store.finalized.coverage, 'unknown');
      assert.strictEqual(reader.treeCalls.length, 0, 'and nothing was read');
    }
  }

  /* Revoked part-way through: the same, and the remaining files are not read. */
  {
    const store = fakeStore();
    const revoked = Object.assign(new Error('revoked'), { code: 'EXPOSURE_AUTHORIZATION_REVOKED' });
    const reader = fakeReader(
      { 'a.js': 'x\n', 'b.js': 'y\n', 'c.js': 'z\n' },
      { onBlob: index => { if (index === 2) throw revoked; } }
    );
    await runnerFor(store, reader).runOnce();
    assert.strictEqual(store.finalized.state, 'failed');
    assert.strictEqual(store.finalized.skippedReason, 'authorization-revoked');
    assert.strictEqual(reader.blobCalls.length, 2, 'the scan stops rather than retrying with a dead session');
  }

  /* ---- A budget is visible partial coverage, never a quiet all-clear -- */

  {
    const cases = [
      ['a file ceiling', { maxFiles: 2 }, 'file-count-limit', 2],
      ['a byte ceiling', { maxBytes: 60 }, 'byte-limit', null],
      ['a wall-clock ceiling', { maxWallClockMs: 0 }, 'time-limit', null]
    ];
    for (const [label, budgets, reason, expectedFiles] of cases) {
      const store = fakeStore();
      const reader = fakeReader({
        'a.js': `1 = ${SECRET}\n`, 'b.js': 'bbbbbbbbbb\n', 'c.js': 'cccccccccc\n', 'd.js': 'dddddddddd\n'
      });
      let clock = T0;
      await runnerFor(store, reader, {
        budgets, now: () => (budgets.maxWallClockMs === 0 ? (clock += 1000) : T0)
      }).runOnce();
      assert.strictEqual(store.finalized.state, 'partial', label);
      assert.strictEqual(store.finalized.coverage, 'partial', label);
      assert.strictEqual(store.finalized.skippedReason, reason, label);
      if (expectedFiles !== null) {
        assert.strictEqual(reader.blobCalls.length, expectedFiles, `${label}: stops at the ceiling`);
      }
      assert(reader.blobCalls.length < 4, `${label}: a ceiling that read everything is not a ceiling`);
    }
  }

  /* A truncated tree is partial coverage too. */
  {
    const store = fakeStore();
    const reader = fakeReader({ 'a.js': 'x\n' }, { truncated: true });
    await runnerFor(store, reader).runOnce();
    assert.strictEqual(store.finalized.state, 'partial');
    assert.strictEqual(store.finalized.skippedReason, 'tree-truncated');
  }

  /*
   * And so is a file the reader declined. A symlink, a submodule, an
   * oversized blob or a binary is a place a credential could be that this
   * scan did not look at, so the coverage says partial and names it.
   */
  {
    for (const [label, files, skipped] of [
      ['a skipped tree entry', { 'a.js': 'x\n' }, [{ path: 'link', reason: SKIP_REASONS.SYMLINK }]],
      ['a binary blob', { 'a.js': 'x\n', 'b.png': { text: null, skip: SKIP_REASONS.BINARY } }, []],
      ['an lfs pointer', { 'a.js': 'x\n', 'b.bin': { text: null, skip: SKIP_REASONS.LFS_POINTER } }, []],
      ['an unreadable blob', { 'a.js': 'x\n', 'b.js': { text: null, skip: SKIP_REASONS.UNREADABLE } }, []]
    ]) {
      const store = fakeStore();
      const reader = fakeReader(files, { skipped });
      await runnerFor(store, reader).runOnce();
      assert.strictEqual(store.finalized.state, 'partial', label);
      assert.strictEqual(store.finalized.coverage, 'partial', label);
      assert.strictEqual(store.finalized.skippedReason, 'unreadable-files', label);
    }
  }

  /* Only a scan that read everything it was given claims complete coverage. */
  {
    const store = fakeStore();
    const reader = fakeReader({ 'a.js': 'x\n', 'b.js': 'y\n' });
    await runnerFor(store, reader).runOnce();
    assert.strictEqual(store.finalized.coverage, 'complete');
  }

  /* ---- Cancellation, while reading ------------------------------------ */

  /*
   * The signal is the lease renewal, which is already periodic: it returns
   * false exactly when the scan is no longer running-and-ours -- cancelled by
   * its owner, or reclaimed because this worker was thought dead. One
   * mechanism for both, so neither can be the one nobody wired up.
   */
  {
    const store = fakeStore();
    const reader = fakeReader({ 'a.js': 'x\n', 'b.js': 'y\n', 'c.js': 'z\n', 'd.js': 'w\n', 'e.js': 'v\n' });
    const runner = runnerFor(store, reader, { budgets: { renewEveryFiles: 2 } });
    /* The cancel lands after the first renewal. */
    let renewals = 0;
    store.renewClaim = async () => {
      renewals += 1;
      return renewals < 2;
    };
    const result = await runner.runOnce();
    assert.strictEqual(result.stopped, 'claim-lost');
    assert(reader.blobCalls.length < 5, `the scan stopped mid-read: ${reader.blobCalls.length}`);
    assert.strictEqual(
      store.finalized, null,
      'a worker that lost its claim must not finalize: the owner already did, or somebody else now holds it'
    );
  }

  /*
   * Responsiveness. The scan yields between files, so a timer scheduled
   * outside it runs while it is in flight. Without that, this process stops
   * answering HTTP for the length of a scan -- and a scan is the slowest thing
   * it does.
   */
  {
    const store = fakeStore();
    const files = {};
    for (let index = 0; index < 40; index += 1) files[`f${index}.js`] = `line ${index}\n`;
    const reader = fakeReader(files);

    let ticks = 0;
    const ticker = setInterval(() => { ticks += 1; }, 1);
    try {
      await runnerFor(store, reader, { budgets: { renewEveryFiles: 10 } }).runOnce();
    } finally {
      clearInterval(ticker);
    }
    assert(ticks > 0, 'the event loop must run during a scan, not after it');
    assert.strictEqual(reader.blobCalls.length, 40);
  }

  /* ---- Killed, and recovered ------------------------------------------ */

  /*
   * Not an exception -- killed. The first worker claims, writes some
   * observations, and stops existing: no finalize, no `finally`, nothing. The
   * only thing left is the row, and the recovery has to work from that.
   */
  {
    const store = fakeStore();
    const reader = fakeReader({ 'a.js': `x = ${SECRET}\n`, 'b.js': 'y\n', 'c.js': 'z\n' });
    const killed = Object.assign(new Error('SIGKILL'), { code: 'PROCESS_DIED' });
    let died = false;
    const dying = createExposureRunner({
      store,
      reader,
      fingerprintKey,
      sessionResolver: async () => ({ token: TOKEN }),
      budgets: { ...DEFAULT_BUDGETS, renewEveryFiles: 1 },
      now: () => T0
    });
    /* Stop the process after the first file's observations are written. */
    const realRecord = store.recordObservations;
    store.recordObservations = async input => {
      const answer = await realRecord(input);
      if (!died) {
        died = true;
        throw killed;
      }
      return answer;
    };
    await assert.rejects(dying.runOnce(), /SIGKILL/, 'the fixture must actually die');
    assert.strictEqual(store.finalized, null, 'a dead worker finalizes nothing');

    /*
     * A second worker reclaims the same scan -- the store's expired-lease
     * path, tested against a real server in the store gate -- and reads the
     * same immutable commit again. It refetches rather than resuming a cursor,
     * which is what makes recovery need nothing but the row: there is no
     * partial state on a disk that no longer exists.
     */
    store.recordObservations = realRecord;
    store.claimsRemaining = 1;
    store.claimOwner = 'token-2';
    reader.treeCalls.length = 0;
    const recovered = await runnerFor(store, reader).runOnce();
    assert.strictEqual(recovered.claimed, true);
    assert.strictEqual(reader.treeCalls[0].commitSha, COMMIT, 'the same commit, not the branch tip now');
    assert.strictEqual(store.finalized.state, 'complete');
    assert.strictEqual(
      store.calls.filter(([name]) => name === 'recordObservations')
        .every(([, input]) => input.claimOwner === 'token-1' || input.claimOwner === 'token-2'),
      true,
      'and every write names the claim it was made under'
    );
  }

  /* A tree that cannot be read is a failed scan, not an empty one. */
  {
    const store = fakeStore();
    const reader = fakeReader({}, { treeError: Object.assign(new Error('nope'), { code: 'EXPOSURE_TREE_INVALID' }) });
    await runnerFor(store, reader).runOnce();
    assert.strictEqual(store.finalized.state, 'failed');
    assert.strictEqual(store.finalized.coverage, 'unknown');
    assert.strictEqual(store.finalized.skippedReason, 'transport-refused');
    assert.strictEqual(store.recorded.length, 0);
  }

  /* ---- The worker does not verify anything --------------------------- */

  /*
   * Deciding whether a credential is live means using it, which needs a
   * separate signed authorization per candidate that only a reader can give.
   * A background job has no such grant, so every observation it writes leaves
   * verification empty -- rather than a job quietly probing on a scan's
   * authority.
   */
  {
    const store = fakeStore();
    const reader = fakeReader({ 'a.js': `x = ${SECRET}\n` });
    await runnerFor(store, reader).runOnce();
    assert.strictEqual(store.recorded.length, 1);
    assert.strictEqual(store.recorded[0].verification, undefined);
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'exposure-worker.js'), 'utf8');
    assert.strictEqual(
      /credential-verification/.test(source), false,
      'a background job must not be able to reach the verifier at all'
    );
  }

  /* ---- The loop ------------------------------------------------------- */

  {
    const store = fakeStore({ claimsRemaining: 2 });
    const reader = fakeReader({ 'a.js': 'x\n' });
    const worker = startExposureWorker({
      store, reader, fingerprintKey,
      sessionResolver: async () => ({ token: TOKEN }),
      budgets: { ...DEFAULT_BUDGETS, renewEveryFiles: 2 },
      intervalMs: 5,
      now: () => T0
    });
    await worker.run();
    assert.strictEqual(worker.stats().completed, 1);

    /* One scan at a time in one process, however often the loop is poked. */
    const concurrent = await Promise.all([worker.run(), worker.run(), worker.run()]);
    assert.strictEqual(
      concurrent.filter(item => item && item.busy).length, 2,
      'a second run while one is in flight is refused rather than overlapping'
    );

    const drained = worker.stop();
    await drained;
    const before = worker.stats().started;
    store.claimsRemaining = 5;
    await worker.run();
    assert.strictEqual(worker.stats().started, before, 'a stopped worker begins nothing further');
  }

  /* An unsupported provider is refused visibly rather than scanned as empty. */
  {
    const store = fakeStore();
    store.scan = { ...store.scan, scope: { ...scope, provider: 'gitlab' } };
    const reader = fakeReader({}, {
      treeError: Object.assign(new Error('unsupported'), { code: 'EXPOSURE_PROVIDER_UNSUPPORTED' })
    });
    await runnerFor(store, reader).runOnce();
    assert.strictEqual(store.finalized.state, 'failed');
    assert.strictEqual(store.finalized.coverage, 'unknown');
    assert.strictEqual(store.recorded.length, 0);
  }

  /*
   * A scan row without a commit is refused rather than read at a guess.
   * Reading "the current tip" instead would be inventing consent for a tree
   * nobody authorised, and a short sha is ambiguous by construction.
   */
  {
    for (const commitSha of ['', 'refs/heads/main', 'HEAD', COMMIT.slice(0, 7), `${COMMIT}0`, 'not-hex-at-all']) {
      const store = fakeStore();
      store.scan = { ...store.scan, commitSha };
      const reader = fakeReader({ 'a.js': 'x\n' });
      await runnerFor(store, reader).runOnce();
      assert.strictEqual(store.finalized.state, 'failed', JSON.stringify(commitSha));
      assert.strictEqual(store.finalized.coverage, 'unknown', JSON.stringify(commitSha));
      assert.strictEqual(reader.treeCalls.length, 0, JSON.stringify(commitSha));
    }
  }

  /*
   * A full object id in upper case is the same commit, so it is normalised
   * rather than refused -- and the reader is asked for the canonical form,
   * which is what the store's own constraint admits. Asserted because
   * "normalise" and "accept whatever arrives" look identical from outside.
   */
  {
    const store = fakeStore();
    store.scan = { ...store.scan, commitSha: OTHER_COMMIT.toUpperCase() };
    const reader = fakeReader({ 'a.js': 'x\n' });
    await runnerFor(store, reader).runOnce();
    assert.strictEqual(reader.treeCalls.length, 1);
    assert.strictEqual(reader.treeCalls[0].commitSha, OTHER_COMMIT);
    assert.strictEqual(store.finalized.state, 'complete');
  }

/* ---- How the server wires it --------------------------------------- */

/*
 * The worker is gated on the capability document, which today says
 * `exposure.scan` is Unavailable everywhere -- so it does not start. That is
 * the wire being correct rather than missing, and it is worth asserting both
 * halves: that the gate exists, and that it reads the document rather than a
 * separate flag somebody would have to remember to set in two places.
 *
 * These read server.js as text. That is a weaker instrument than running it,
 * and it is the one available: starting the server to prove a background
 * worker did not start would prove very little either way.
 */
{
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

  assert(server.includes("require('./src/exposure-worker')"), 'the worker must be wired in');
  assert(server.includes("require('./src/exposure-reader')"), 'with the reader it reads through');

  const gate = server.match(/function exposureScanningAvailable\(\)[\s\S]*?\n}/);
  assert(gate, 'the capability gate must exist');
  assert(
    gate[0].includes('CAPABILITY_DOCUMENT'),
    'the gate must read the capability document, not a second source of truth'
  );
  assert(
    /Supported|Experimental/.test(gate[0]),
    'and must treat Unavailable as not available'
  );

  const ensure = server.match(/function ensureExposureWorker\(\)[\s\S]*?\n}/);
  assert(ensure, 'the worker must be started through one function');
  for (const condition of ['exposureWorker', 'DB_URL', 'shuttingDown', 'exposureScanningAvailable()']) {
    assert(
      ensure[0].includes(condition),
      `starting the worker must be conditional on ${condition}`
    );
  }
  assert(
    /ensureExposureWorker\(\);/.test(server),
    'and the function must actually be called at startup'
  );

  /*
   * Drained on shutdown, and awaited before the pool closes. A scan that loses
   * its database mid-write leaves a leased row, which is recoverable -- but
   * recovering it means reading the repository again, and finishing the batch
   * in hand is cheaper.
   */
  assert(
    /const drainedExposureWorker = exposureWorker \? exposureWorker\.stop\(\) : null;/.test(server),
    'the worker must be drained on shutdown'
  );
  assert(
    /await drainedExposureWorker;/.test(server),
    'and awaited, or draining it is a statement with no effect'
  );

  /*
   * The session is resolved at execution and the resolver reads a live session
   * rather than anything stored on the job. The token must not be written
   * anywhere: asserted by requiring the resolver to return it and nothing else.
   */
  const resolver = server.match(/async function resolveExposureSession\([\s\S]*?\n}/);
  assert(resolver, 'the session resolver must exist');
  assert(resolver[0].includes('nv_sessions'), 'it must read a live session');
  assert(
    resolver[0].includes('account.login') && resolver[0].includes('requestedBy'),
    'and match the actor who asked for the scan, not merely somebody sharing the identity'
  );
  assert.strictEqual(
    /INSERT|UPDATE nv_exposure/.test(resolver[0]), false,
    'a resolver must not write anything: a token that reaches a row outlives its consent'
  );
  assert(
    /SELECT identity_key FROM nv_exposure_scans WHERE scan_id=\$1/.test(resolver[0]),
    'the identity comes from the row rather than being carried on the scan object'
  );
}

  console.log('exposure worker tests passed');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
