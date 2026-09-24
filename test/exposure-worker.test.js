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
const { fingerprintFor, fingerprintKeyId } = require('../src/exposure-findings');
const { RULES_VERSION } = require('../src/exposure-detection');
const { EXPOSURE_CONFIG_VERSION } = require('../src/exposure-store');
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
      rulesVersion: RULES_VERSION,
      engineVersion: 1,
      fingerprintKeyVersion: 1,
      fingerprintKeyId: fingerprintKeyId(fingerprintKey),
      configVersion: EXPOSURE_CONFIG_VERSION,
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
    assert(resolverCalls >= 3, 'authorization is rechecked during execution');

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
    /* One read at a time, so "the next file" is well defined. */
    await runnerFor(store, reader, { budgets: { readConcurrency: 1 } }).runOnce();
    assert.strictEqual(store.finalized.state, 'failed');
    assert.strictEqual(store.finalized.skippedReason, 'authorization-revoked');
    assert.strictEqual(reader.blobCalls.length, 2, 'the scan stops rather than retrying with a dead session');
  }

  /*
   * And with reads in flight at once, the property is the one that matters: no
   * read is started after the revocation has been seen. Reads already on the
   * wire when it arrived finish into nothing; nothing new is sent.
   */
  {
    const files = {};
    for (let index = 0; index < 12; index += 1) files[`f${index}.js`] = `line ${index}\n`;
    const store = fakeStore();
    const revoked = Object.assign(new Error('revoked'), { code: 'EXPOSURE_AUTHORIZATION_REVOKED' });
    /* The worker's first act on seeing the revocation is to record it, so
       that is the moment after which nothing may be sent. */
    let observed = false;
    let startedAfter = 0;
    const record = store.finalizeScan;
    store.finalizeScan = async input => { observed = true; return record(input); };
    const reader = fakeReader(files, {
      onBlob: async index => {
        if (observed) startedAfter += 1;
        if (index === 2) {
          await new Promise(resolve => setImmediate(resolve));
          throw revoked;
        }
        /* The others stay in flight a little longer, so some are still
           outstanding when the revocation lands. */
        await new Promise(resolve => setImmediate(resolve));
        await new Promise(resolve => setImmediate(resolve));
      }
    });
    await runnerFor(store, reader, { budgets: { readConcurrency: 3, renewEveryFiles: 100 } }).runOnce();
    assert.strictEqual(store.finalized.skippedReason, 'authorization-revoked');
    assert.strictEqual(startedAfter, 0, 'no read begins once the revocation is known');
    assert(reader.blobCalls.length <= 4, `only reads already in flight ran: ${reader.blobCalls.length}`);
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

  /* ---- Fast without being careless ----------------------------------- */

  /*
   * The access check -- a lease write and a full session resolution -- used to
   * run before and after every file, which was most of what a scan spent its
   * time on. It is now due every `renewEveryFiles` reads or every
   * `accessCheckIntervalMs`, and unconditionally before every write and at the
   * end. Sixty files is a handful of checks, not a hundred and twenty.
   */
  {
    const files = {};
    for (let index = 0; index < 60; index += 1) files[`f${index}.js`] = `line ${index}\n`;
    const store = fakeStore();
    let resolutions = 0;
    await runnerFor(store, fakeReader(files), {
      budgets: { renewEveryFiles: 25, accessCheckIntervalMs: 60_000 },
      sessionResolver: async () => { resolutions += 1; return { token: TOKEN }; }
    }).runOnce();
    const renewals = store.calls.filter(([name]) => name === 'renewClaim').length;
    assert.strictEqual(store.finalized.state, 'complete');
    assert(renewals >= 3 && renewals <= 6, `a handful of checks for sixty files, not one per file: ${renewals}`);
    assert(resolutions <= renewals + 1, 'and a session resolution only with each check');
  }

  /* On a clock as well: a slow scan still notices within the interval. */
  {
    const files = {};
    for (let index = 0; index < 6; index += 1) files[`f${index}.js`] = `line ${index}\n`;
    const store = fakeStore();
    let clock = T0;
    await runnerFor(store, fakeReader(files), {
      budgets: { renewEveryFiles: 1000, accessCheckIntervalMs: 1000, maxWallClockMs: 10 * 60 * 1000 },
      now: () => (clock += 700)
    }).runOnce();
    const renewals = store.calls.filter(([name]) => name === 'renewClaim').length;
    assert(renewals >= 4, `time alone makes the check due: ${renewals}`);
  }

  /*
   * Reads overlap, up to the configured number, and are consumed in tree
   * order whatever order they finish in -- so a scan with the same inputs
   * records the same findings in the same order however the network behaves.
   */
  {
    const files = {};
    for (let index = 0; index < 12; index += 1) {
      files[`f${String(index).padStart(2, '0')}.js`] = index % 3 === 0 ? `k = ${SECRET.slice(0, -2)}${String(index).padStart(2, '0')}\n` : 'x\n';
    }
    let inFlight = 0;
    let peak = 0;
    const reader = fakeReader(files, {
      onBlob: async index => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        /* Later files finish first. */
        for (let spin = 0; spin < 13 - index; spin += 1) await new Promise(resolve => setImmediate(resolve));
        inFlight -= 1;
      }
    });
    const store = fakeStore();
    await runnerFor(store, reader, { budgets: { readConcurrency: 4, renewEveryFiles: 100 } }).runOnce();
    assert.strictEqual(store.finalized.state, 'complete');
    assert(peak > 1, `reads actually overlap: ${peak}`);
    assert(peak <= 4, `and never beyond the limit: ${peak}`);
    assert.deepStrictEqual(
      store.recorded.map(item => item.path),
      ['f00.js', 'f03.js', 'f06.js', 'f09.js'],
      'findings are recorded in tree order, not arrival order'
    );
  }

  /*
   * One connection pool per scan: opened when the scan starts, handed to every
   * read, and closed when it ends -- including when it ends badly, so no
   * socket outlives the scan that opened it.
   */
  {
    for (const [label, readerOptions, expectedState] of [
      ['a scan that completes', {}, 'complete'],
      ['a scan whose tree read fails', { treeError: Object.assign(new Error('x'), { code: 'EXPOSURE_TREE_INVALID' }) }, 'failed']
    ]) {
      const store = fakeStore();
      const reader = fakeReader({ 'a.js': 'x\n', 'b.js': 'y\n' }, readerOptions);
      const opened = [];
      const runner = createExposureRunner({
        store, reader, fingerprintKey,
        sessionResolver: async () => ({ token: TOKEN }),
        budgets: DEFAULT_BUDGETS,
        now: () => T0,
        createTransport: () => {
          const pool = { closed: 0, request: async () => ({ statusCode: 200 }), close() { pool.closed += 1; } };
          opened.push(pool);
          return pool;
        }
      });
      await runner.runOnce();
      assert.strictEqual(store.finalized.state, expectedState, label);
      assert.strictEqual(opened.length, 1, `${label}: one pool per scan`);
      assert.strictEqual(opened[0].closed, 1, `${label}: and it is closed exactly once`);
      assert.strictEqual(reader.treeCalls[0].transport, opened[0].request, `${label}: the tree read uses it`);
      for (const call of reader.blobCalls) assert.strictEqual(call.transport, opened[0].request, label);
    }
  }

  /*
   * A file can be an exposure without being read. A committed keystore is one
   * whatever its bytes say, so it is found from the tree -- by its name, with
   * the blob as its identity -- and no request is spent fetching it.
   */
  {
    const store = fakeStore();
    const keystoreSha = crypto.createHash('sha1').update('release.jks').digest('hex');
    const reader = fakeReader({ 'a.js': 'x\n' }, {
      skipped: [
        { path: 'android/release.jks', reason: SKIP_REASONS.BINARY, sha: keystoreSha },
        { path: 'logo.png', reason: SKIP_REASONS.BINARY, sha: 'e'.repeat(40) },
        { path: 'link', reason: SKIP_REASONS.SYMLINK, sha: null },
        { path: 'vendor/lib', reason: SKIP_REASONS.SUBMODULE, sha: null }
      ]
    });
    await runnerFor(store, reader).runOnce();
    assert.deepStrictEqual(store.recorded.map(item => [item.rule, item.path]), [['keystore-file', 'android/release.jks']]);
    assert.strictEqual(reader.blobCalls.length, 1, 'only the text file was fetched');
    /*
     * And the report can say what was not read, in numbers: one text file
     * read of five, two binary files not scanned, two others not read.
     */
    assert.strictEqual(store.finalized.filesTotal, 5);
    assert.strictEqual(store.finalized.filesSkippedBinary, 2);
    assert.strictEqual(store.finalized.filesSkippedOther, 2);
    assert.strictEqual(store.finalized.coverage, 'partial', 'files not read still mean partial coverage');
  }

  /* A binary discovered only after fetching is counted as binary too. */
  {
    const store = fakeStore();
    const reader = fakeReader({ 'a.js': 'x\n', 'blob': { text: null, skip: SKIP_REASONS.BINARY }, 'odd': { text: null, skip: SKIP_REASONS.UNREADABLE } });
    await runnerFor(store, reader).runOnce();
    assert.strictEqual(store.finalized.filesTotal, 3);
    assert.strictEqual(store.finalized.filesSkippedBinary, 1);
    assert.strictEqual(store.finalized.filesSkippedOther, 1);
  }

  /*
   * The byte ceiling is charged at the size the tree declares, when a read is
   * started -- so it falls on the same file however the reads interleave.
   */
  {
    const outcomes = new Set();
    for (const readConcurrency of [1, 2, 6]) {
      const store = fakeStore();
      const reader = fakeReader({ 'a.js': 'a\n', 'b.js': 'b\n', 'c.js': 'c\n', 'd.js': 'd\n' });
      /* Declared sizes are 100, 101, 102, 103: three fit in 305 bytes. */
      await runnerFor(store, reader, { budgets: { maxBytes: 305, readConcurrency } }).runOnce();
      outcomes.add(`${store.finalized.skippedReason}:${reader.blobCalls.length}`);
    }
    assert.deepStrictEqual([...outcomes], ['byte-limit:3'], 'the same ceiling on the same file at every concurrency');
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
  assert(server.includes('resolveStoredExposureSession(input'), 'the server uses the owned-session resolver');
  const resolver = fs.readFileSync(path.join(__dirname, '..', 'src', 'exposure-session.js'), 'utf8')
    .match(/async function resolveExposureSession\([\s\S]*?\n}/);
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
    /SELECT identity_key FROM nv_exposure_scans\s+WHERE scan_id=\$1/.test(resolver[0]),
    'the identity comes from the row rather than being carried on the scan object'
  );
}

/* ---- The routes, and the boundaries every one of them carries ------- */

/*
 * Twelve routes, and what matters about each is the chain in front of it.
 * Reading these as text is a weaker instrument than exercising them, and it is
 * the one that catches the mistake that actually happens: a route added later
 * copying the line above it and losing a middleware in the process.
 */
{
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const routeLines = server.split('\n').filter(line => /^app\.(get|post)\('\/api\/repo\/:owner\/:repo\/exposure\//.test(line));
  assert.strictEqual(routeLines.length, 12, `expected twelve exposure routes, found ${routeLines.length}`);

  for (const line of routeLines) {
    for (const middleware of ['providerSessionAccess', 'alphaRepositoryAccess', 'capabilityAccess(', 'auth', 'governanceAccess(']) {
      assert(
        line.includes(middleware),
        `an exposure route is missing ${middleware}: ${line.slice(0, 80)}`
      );
    }
    assert(
      line.includes("capabilityAccess('exposure.scan'"),
      `an exposure route must be gated on its own capability: ${line.slice(0, 80)}`
    );
  }

  /*
   * Accepting the risk of a live credential requires an administrator, and it
   * is the only one that does. A repository reader can ask for a scan of a
   * repository they can already read; deciding that what it found is
   * acceptable is a decision about somebody else's security.
   */
  const acceptLine = routeLines.find(line => line.includes('/accept-risk'));
  assert(acceptLine, 'the accept-risk route must exist');
  assert(acceptLine.includes("governanceAccess('administrator')"), acceptLine.slice(0, 100));
  /*
   * The role is the control here, not the capability status. Accepting a risk
   * performs no outbound request and uses no credential -- it records that a
   * named person decided -- so gating it on the capability being Supported
   * only produced readers who could not triage a false positive, and a screen
   * that cannot be cleared is one people stop reading.
   */
  assert(
    acceptLine.includes('allowExperimental'),
    'accepting a risk is available while the capability is experimental'
  );
  assert.strictEqual(
    routeLines.filter(line => line.includes("governanceAccess('administrator')")).length, 3,
    'risk acceptance and external credential use require an administrator'
  );
  for (const line of routeLines.filter(item => item !== acceptLine
    && !item.includes("/verify'") && !item.includes('/probe-readability'))) {
    assert(
      line.includes("governanceAccess('reader')"),
      `every other exposure route is a reader route: ${line.slice(0, 80)}`
    );
  }

  /* Everything that decides something records it; the two reads do not. */
  for (const [fragment, action] of [
    ["app.post('/api/repo/:owner/:repo/exposure/scans'", 'exposure.scan.request'],
    ['/cancel', 'exposure.scan.cancel'],
    ['/accept-risk', 'exposure.finding.accept-risk'],
    ['/verify', 'exposure.credential.verify'],
    ['/probe-readability', 'exposure.readability.probe'],
    ['/exposure/clear', 'exposure.history.clear']
  ]) {
    const line = routeLines.find(item => item.includes(fragment));
    assert(line, fragment);
    assert(
      line.includes(`governanceMutationContext('${action}')`),
      `${fragment} must record ${action}`
    );
  }
  for (const line of routeLines.filter(item => item.startsWith("app.get('"))) {
    assert.strictEqual(
      line.includes('governanceMutationContext'), false,
      `a read must not record a mutation: ${line.slice(0, 80)}`
    );
  }

  /*
   * A finding never leaves the server as a bare row. Two sentences travel with
   * it: what the credential is, and what this repository has since decided
   * about it. Both come from one reviewed lookup table, so a screen cannot
   * drift into printing `accepted-risk` as a slug and making a decision a
   * named person made look like machine bookkeeping.
   *
   * Checked per response rather than by counting one spelling, because the
   * failure mode is a new route that forgets, not an existing one that
   * changes.
   */
  const findingResponses = server.match(/res\.(?:status\([0-9]+\)\.)?json\(\{[^;]*?\bfinding[s]?\b[^;]*?\}\);/g) || [];
  const exposureFindingResponses = findingResponses.filter(body => (
    /exposureFindingPayload|stored\.finding|\bfindings\.map\b/.test(body)
  ));
  assert(
    exposureFindingResponses.length >= 3,
    `the exposure routes must return findings: ${exposureFindingResponses.length}`
  );
  for (const body of exposureFindingResponses) {
    assert(
      body.includes('exposureFindingPayload'),
      `a finding left the server undescribed: ${body.slice(0, 90)}`
    );
  }
  assert(
    /function exposureFindingPayload\(finding\)[\s\S]{0,400}dispositionNarration: describeDisposition\(finding\.disposition\)/.test(server),
    'and the payload is where both sentences are attached'
  );
  assert(
    /const \{[^}]*describeDisposition[^}]*\} = require\('\.\/src\/exposure-narration'\)/.test(server),
    'the disposition sentence comes from the reviewed table, not from this file'
  );

  /*
   * The identity boundary is passed into the store on every call rather than
   * compared afterwards, and the ref is resolved once on the request path.
   */
  const handlers = server.slice(
    server.indexOf("app.post('/api/repo/:owner/:repo/exposure/scans'"),
    server.indexOf("app.post('/api/repo/:owner/:repo/governance/exceptions/:exceptionId/revoke'")
  );
  assert(handlers.length > 1000, 'the handler slice must cover the routes');
  /*
   * Every store call carries the identity, checked per call site rather than
   * by counting one spelling of it. A handler that binds
   * `const identityKey = req.governance.actor.identityKey` and then passes the
   * shorthand is doing the right thing, and a check that only matched the long
   * form would have failed on correct code -- which is how a guard gets
   * relaxed rather than fixed.
   */
  const storeCallRx = /(?:exposureService\(\)|store)\.[a-zA-Z]+\(/g;
  const storeCalls = [];
  let call;
  while ((call = storeCallRx.exec(handlers))) storeCalls.push(call.index);
  assert(storeCalls.length >= 8, `the handlers must call the store: ${storeCalls.length}`);
  for (const index of storeCalls) {
    const args = handlers.slice(index, index + 320);
    assert(
      /\bidentityKey\b/.test(args),
      `a store call does not carry the identity: ${handlers.slice(index, index + 70)}`
    );
  }
  /* And the shorthand is genuinely that value, not some other local. */
  assert(
    handlers.includes('const identityKey = req.governance.actor.identityKey;'),
    'a handler binding identityKey must bind it from the governance actor'
  );
  assert(
    handlers.includes('exposureReader.resolveCommit('),
    'the request path resolves the ref once, here'
  );
  assert.strictEqual(
    /resolveCommit/.test(fs.readFileSync(path.join(__dirname, '..', 'src', 'exposure-worker.js'), 'utf8')), false,
    'and the worker cannot reach the resolver at all'
  );

  /*
   * No handler returns a provider error message or a raw store error. Every
   * one routes failures through a single helper that uses the public error
   * body -- the one that already refuses to echo a message carrying a secret
   * signal, which matters more on this path than anywhere else: an error here
   * can be raised while a request carrying a discovered credential is in
   * flight.
   */
  const failureHelper = server.match(/function exposureFailure\(res, error\)[\s\S]*?\n}/);
  assert(failureHelper, 'the exposure failure helper must exist');
  assert(failureHelper[0].includes('publicErrorBody(error)'), failureHelper[0]);
  assert.strictEqual(
    (handlers.match(/catch \(error\) \{ exposureFailure\(res, error\); \}/g) || []).length, 12,
    'every exposure handler must fail through that helper'
  );
  assert.strictEqual(
    /error\.message|String\(error\)/.test(handlers), false,
    'and none of them may put an error message into a response itself'
  );
}

/* ---- Verification: the one route that uses somebody's credential ---- */

/*
 * The properties that matter here are different from the other routes'. This
 * one takes a credential found in a repository and sends it to a third party,
 * so what is checked is that it cannot happen by accident, cannot happen
 * without a fresh bound grant, and cannot happen from anything the store kept.
 */
{
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const start = server.indexOf("app.post('/api/repo/:owner/:repo/exposure/findings/:fingerprint/verify'");
  assert(start > 0, 'the verify route must exist');
  const handler = server.slice(start, server.indexOf("app.get('/api/repo/:owner/:repo/exposure/findings/:fingerprint/verifications'", start));
  assert(handler.length > 800, 'the handler slice must cover the route');

  /*
   * An explicit word, checked before anything is read. A button that says
   * "check this" and a request that says so are not the same thing, and the
   * confirmation is what the plan requires an operator to give.
   */
  assert(
    handler.includes("'use-this-credential'"),
    'verifying must require an explicit confirmation'
  );
  const confirmAt = handler.indexOf("'use-this-credential'");
  const readAt = handler.indexOf('exposureReader.readTree(');
  assert(
    confirmAt > 0 && readAt > confirmAt,
    'the confirmation must be checked before the repository is read, not after'
  );

  /*
   * The bytes are recovered, never retrieved. Nothing stored them, so the
   * handler re-reads the blob at the recorded commit and re-detects; a file
   * that changed yields no match and nothing is sent.
   */
  assert(handler.includes('exposureReader.readBlob('), 'the blob is re-read');
  assert(handler.includes('detectInText('), 'and re-detected');
  assert(
    handler.includes('EXPOSURE_CANDIDATE_GONE'),
    'a candidate that is no longer there must be reported, not guessed at'
  );
  assert(
    handler.includes('built.probes.find'),
    'the candidate is matched by fingerprint rather than by position'
  );

  /* A fresh grant per attempt, bound to this candidate and this adapter. */
  assert(handler.includes('signVerificationAuthorization('), 'a grant is minted');
  assert(handler.includes('candidateFingerprint: fingerprint'), 'bound to this candidate');
  assert(handler.includes('commit: finding.commit'), 'and this commit');
  assert(
    /expiresAt: new Date\(issuedAt\.getTime\(\) \+ 60_000\)/.test(handler),
    'and it expires in a minute: it is spent immediately or not at all'
  );

  /* Recorded whatever the answer, because the history is the evidence. */
  assert(handler.includes('store.recordVerification('), 'every attempt is recorded');
  assert(
    handler.includes('identityKey') && handler.includes('requestedBy'),
    'with the identity it belongs to and the person who asked'
  );

  /* ---- History, report and clear ------------------------------------ */
  {
    const clearStart = server.indexOf("app.post('/api/repo/:owner/:repo/exposure/clear'");
    assert(clearStart >= 0, 'the clear route must exist');
    const clearHandler = server.slice(clearStart, server.indexOf('\n});', clearStart));
    /* The explicit word, refused before the store is touched. */
    const confirmAt = clearHandler.indexOf("!== 'clear-exposure-history'");
    assert(confirmAt > 0, 'clearing requires an explicit confirmation');
    assert(confirmAt < clearHandler.indexOf('clearHistory('), 'and it is checked before anything is removed');
    assert(clearHandler.includes('identityKey: req.governance.actor.identityKey'), 'a clear is this person\'s own record');

    const historyStart = server.indexOf("app.get('/api/repo/:owner/:repo/exposure/scans',");
    assert(historyStart >= 0, 'the history route must exist');
    const historyHandler = server.slice(historyStart, server.indexOf('\n});', historyStart));
    assert(historyHandler.includes('store.listScans('), 'the history is a page of scans');
    assert(historyHandler.includes('store.scanRuleCounts('), 'with rule counts in one query');
    assert(historyHandler.includes('exposureSeverityOf('), 'summed by the narration table\'s severity, not a second copy of it');

    const reportStart = server.indexOf("app.get('/api/repo/:owner/:repo/exposure/scans/:scanId/observations'");
    const reportHandler = server.slice(reportStart, server.indexOf('\n});', reportStart));
    assert(reportHandler.includes('scanReport('), 'a scan\'s report joins each observation to its finding');
    assert(reportHandler.includes('exposureFindingPayload('), 'and describes the finding the same way the list does');
    const listStart = server.indexOf("app.get('/api/repo/:owner/:repo/exposure/findings',");
    const listHandler = server.slice(listStart, server.indexOf('\n});', listStart));
    assert(listHandler.includes('latestLocations('), 'the list says which line each finding was last seen on');
    assert(/locations\[finding\.fingerprint\]/.test(listHandler), 'and describes each finding with those lines');

    /* A finding says which questions it can be asked. */
    assert(/verifiable: EXPOSURE_VERIFIABLE_RULES\.has\(finding\.rule\)/.test(server), 'verification is offered only where a verifier exists');
    assert(/probeable: finding\.rule === 'supabase-anon-key'/.test(server), 'and a readability probe only for an anonymous key');

    /* A scan starts now, not at the next tick. */
    const requestStart = server.indexOf("app.post('/api/repo/:owner/:repo/exposure/scans',");
    const requestHandler = server.slice(requestStart, server.indexOf('\n});', requestStart));
    assert(requestHandler.includes('nudgeExposureWorker()'), 'requesting a scan starts the worker');
    assert(server.includes('createTransport: () => createGuardedSession({'), 'and each scan reads through a pinned connection pool');
  }

  /* ---- The readability probe route ----------------------------------- */

  /*
   * The prober was written in Task 6 and, until this, nothing could call it.
   * What these assert is the shape that makes it safe to call: the operator
   * supplies the confirmation, the relation and the columns; the route
   * supplies the project only from the file's own text; and the grant is
   * signed over all of it so the prober cannot be asked for anything else.
   */
  {
    const start = server.indexOf("app.post('/api/repo/:owner/:repo/exposure/findings/:fingerprint/probe-readability'");
    assert(start >= 0, 'the probe route must exist');
    const probeHandler = server.slice(start, server.indexOf("app.get('/api/repo/:owner/:repo/exposure/findings/:fingerprint/readability-probes'"));
    assert(probeHandler.length > 800, 'the probe handler slice must cover the handler');

    /* The confirmation, refused before anything is read. */
    const confirmAt = probeHandler.indexOf("!== 'contact-this-project'");
    assert(confirmAt > 0, 'a probe requires an explicit confirmation');
    assert(
      confirmAt < probeHandler.indexOf('readTree('),
      'and it is refused before the repository is read, not after'
    );

    /*
     * Only the anonymous key. A service-role key is the same shape and
     * bypasses every policy, so probing with one comes back readable whatever
     * the project permits.
     */
    assert(
      probeHandler.includes("finding.rule !== 'supabase-anon-key'"),
      'only an anonymous key may be used to ask what the public can read'
    );
    assert(
      probeHandler.indexOf("finding.rule !== 'supabase-anon-key'") < probeHandler.indexOf('readTree('),
      'and that is decided before the file is read'
    );

    /* The project comes from the file, through the module that rebuilds an
       origin rather than trusting a URL a repository chose. */
    assert(probeHandler.includes('discoverProject(blob.text)'), 'the project is discovered from the file');
    assert.strictEqual(
      /https:\/\/\$\{|\.supabase\.co/.test(probeHandler), false,
      'this file must not build a provider address itself'
    );

    /* The relation and the columns are the operator's, never this route's. */
    assert(probeHandler.includes('const relation = String(body.relation'), 'the relation arrives from the request');
    assert(probeHandler.includes('Array.isArray(body.projection)'), 'and so do the columns');
    assert.strictEqual(
      /relation = '|relation: '[a-z_]/.test(probeHandler), false,
      'a probe against a table nobody named would be this server choosing what to read'
    );

    /* A grant bound to all of it, spent immediately. */
    assert(probeHandler.includes('signReadabilityAuthorization('), 'a grant is minted');
    assert(probeHandler.includes('candidateFingerprint: fingerprint'), 'bound to this candidate');
    assert(probeHandler.includes('projectRef: project.projectRef'), 'and this project');
    assert(probeHandler.includes('relation,') && probeHandler.includes('projection,'), 'and this exact question');
    assert(
      /expiresAt: new Date\(issuedAt\.getTime\(\) \+ 60_000\)/.test(probeHandler),
      'and it expires in a minute: it is spent immediately or not at all'
    );
    /*
     * Its own key. A grant to ask a provider "is this credential yours" is not
     * a grant to ask a project "may the public read this table", and a shared
     * key would let one signature satisfy both checks.
     */
    assert(probeHandler.includes('EXPOSURE_READABILITY_KEY'), 'the probe grant has its own key');
    assert.strictEqual(
      /EXPOSURE_VERIFICATION_KEY/.test(probeHandler), false,
      'and it is not the verification key'
    );
    assert(
      server.includes('const EXPOSURE_READABILITY_KEY = deriveKey(SECRET, KEY_PURPOSES.EXPOSURE_READABILITY_AUTHORIZATION);'),
      'derived for its own purpose rather than reused'
    );

    /* Recorded whatever the answer, including the ones that never went out. */
    assert(probeHandler.includes('store.recordReadabilityProbe('), 'every probe is recorded');

    /* And nothing from the key or the rows reaches the response. */
    assert.strictEqual(
      /res\.(json|status\([0-9]+\)\.json)\([^)]*candidate/.test(probeHandler), false,
      'the candidate must not reach a response body'
    );
    assert.strictEqual(
      /probe\.secret|\.reveal\(\)/.test(probeHandler.replace('revealForVerification(found)', '')), false,
      'and the bytes leave the wrapper exactly once, through the one documented exit'
    );
  }

  /*
   * And the credential does not reach the response. The route returns the
   * stored attempt and a narration drawn from a lookup table, both of which
   * are checked elsewhere to carry nothing.
   */
  assert.strictEqual(
    /res\.(json|status\([0-9]+\)\.json)\([^)]*candidate/.test(handler), false,
    'the candidate must not reach a response body'
  );
  assert.strictEqual(
    /probe\.secret|\.reveal\(\)/.test(handler.replace('revealForVerification(probe)', '')), false,
    'and the bytes leave the wrapper exactly once, through the one documented exit'
  );
}

  console.log('exposure worker tests passed');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
