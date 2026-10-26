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

const { KEY_PURPOSES, deriveKey } = require('../apps/api/src/platform/crypto/key-derivation.ts');
const { SKIP_REASONS } = require('../apps/api/src/modules/quasar/index.ts').exposureReader;
const { fingerprintFor, fingerprintKeyId } = require('../apps/api/src/modules/quasar/index.ts');
const { RULES_VERSION, DETECTION_ENGINE_VERSION } = require('../apps/api/src/modules/quasar/index.ts');
const { EXPOSURE_CONFIG_VERSION } = require('../apps/api/src/modules/quasar/index.ts');
const {
  DEFAULT_BUDGETS,
  EXPOSURE_BUDGET_VERSION,
  createExposureRunner,
  startExposureWorker
} = require('../apps/api/src/modules/quasar/index.ts');

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
      engineVersion: DETECTION_ENGINE_VERSION,
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
    const source = fs.readFileSync(path.join(__dirname, '..', 'apps', 'api', 'src', 'modules', 'quasar', 'application', 'exposure-worker.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert(source.includes('function createExposureRunner'), 'the comment strip must leave the code behind');
    for (const forbidden of [
      /require\('child_process'\)/, /require\('fs'\)/, /require\('https'\)/,
      /from '(?:node:)?(?:child_process|fs|fs\/promises|https?)'/,
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
   * A renewed session is held to the test the first one passed: its token is a
   * string or there is none. A session answering with something else is not a
   * session, and the reader is never handed it as a credential.
   */
  {
    for (const renewed of [{ token: 12345 }, { token: { value: TOKEN } }, { token: true }]) {
      const store = fakeStore();
      const reader = fakeReader({ 'a.js': 'x\n', 'b.js': 'y\n' });
      let asked = 0;
      const sessionResolver = async () => (asked++ === 0 ? { token: TOKEN } : renewed);
      await runnerFor(store, reader, { sessionResolver }).runOnce();
      assert.strictEqual(store.finalized.state, 'failed', JSON.stringify(renewed));
      assert.strictEqual(store.finalized.skippedReason, 'authorization-revoked');
      assert.strictEqual(reader.treeCalls.length + reader.blobCalls.length, 0, 'and nothing was read with it');
    }
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
    const source = fs.readFileSync(path.join(__dirname, '..', 'apps', 'api', 'src', 'modules', 'quasar', 'application', 'exposure-worker.ts'), 'utf8');
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
  for (const provider of ['gitlab', 'gitea']) {
    const store = fakeStore();
    store.scan = { ...store.scan, scope: { ...scope, provider } };
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

  const quasar = server.match(/const \{([^}]*)\} = require\('\.\/apps\/api\/src\/modules\/quasar\/index\.ts'\)/);
  assert(quasar && /\bstartExposureWorker\b/.test(quasar[1]), 'the worker must be wired in');
  assert(/\bexposureReader\b/.test(quasar[1]), 'with the reader it reads through');

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
  const resolver = fs.readFileSync(path.join(__dirname, '..', 'apps', 'api', 'src', 'modules', 'quasar', 'application', 'exposure-session.ts'), 'utf8')
    .match(/async function resolveExposureSession[<(][\s\S]*?\n}/);
  assert(resolver, 'the session resolver must exist');
  assert(resolver[0].includes('nv_sessions'), 'it must read a live session');
  assert(
    resolver[0].includes("read(account, 'login')") && resolver[0].includes('requestedBy'),
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

/* ---- The routes ----------------------------------------------------- */

/*
 * The twelve exposure routes are Quasar's (apps/api/src/modules/quasar/http/
 * exposure-routes.ts), exercised over HTTP in
 * test/quasar-exposure-routes.test.js: their chains as the route policy reads
 * them, the identity in every store call, the explicit words checked before
 * anything is read, the credential recovered from the file and matched by
 * fingerprint, and grants the real verifier and prober accept. What stays
 * here is how the server hands them what they use.
 */
{
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert(server.includes('registerExposureRoutes(app, {'), 'the server mounts the exposure routes');
  /*
   * Each grant has its own key, derived for its own purpose rather than
   * reused: a grant to ask a provider "is this credential yours" is not a
   * grant to ask a project "may the public read this table", and a shared key
   * would let one signature satisfy both checks.
   */
  for (const [name, purpose] of [
    ['EXPOSURE_VERIFICATION_KEY', 'EXPOSURE_VERIFICATION_AUTHORIZATION'],
    ['EXPOSURE_VERIFICATION_SUBJECT_KEY', 'EXPOSURE_VERIFICATION_SUBJECT'],
    ['EXPOSURE_READABILITY_KEY', 'EXPOSURE_READABILITY_AUTHORIZATION']
  ]) {
    assert(server.includes(`const ${name} = deriveKey(SECRET, KEY_PURPOSES.${purpose});`), `${name} is derived for its own purpose`);
  }
  assert(
    /keys: \{\s*fingerprint: EXPOSURE_FINGERPRINT_KEY, verification: EXPOSURE_VERIFICATION_KEY,\s*verificationSubject: EXPOSURE_VERIFICATION_SUBJECT_KEY, readability: EXPOSURE_READABILITY_KEY\s*\}/.test(server),
    'and each reaches the routes under its own name'
  );
  assert(/reader: exposureReader, verifyCredential, probeReadability: probeAnonymousReadability/.test(server),
    'the routes reach the provider through the module\'s own reader, verifier and prober');
  assert(server.includes('createTransport: () => createGuardedSession({'), 'and each scan reads through a pinned connection pool');
}

  /* ---- History ------------------------------------------------------------ */

  /*
   * A history scan reads the tree, then every commit's changes oldest first.
   * A credential a commit added and a later commit deleted is still in the
   * repository, and is reported against the commit that introduced it, as
   * not in the tree.
   */
  {
    const sha = n => String(n).repeat(40).slice(0, 40);
    const added = sha(1);
    const deleted = sha(2);
    const merge = sha(3);
    const patchAdding = `@@ -1,2 +1,3 @@\n const a = 1;\n+const token = "${SECRET}";\n const b = 2;`;
    const patchDeleting = `@@ -1,3 +1,2 @@\n const a = 1;\n-const token = "${SECRET}";\n const b = 2;`;
    const historyReader = (files, changes, options = {}) => {
      const reader = fakeReader(files, options);
      reader.listCalls = [];
      reader.changeCalls = [];
      reader.listCommits = async input => {
        reader.listCalls.push(input);
        if (options.listError) throw options.listError;
        return options.listing || {
          commits: [
            { sha: merge, committedAt: '2026-09-03T00:00:00.000Z', parents: 2 },
            { sha: deleted, committedAt: '2026-09-02T00:00:00.000Z', parents: 1 },
            { sha: added, committedAt: '2026-09-01T00:00:00.000Z', parents: 1 }
          ],
          truncated: false
        };
      };
      reader.readCommitChanges = async input => {
        reader.changeCalls.push(input.sha);
        if (options.changeError && options.changeError.sha === input.sha) throw options.changeError.error;
        return changes[input.sha] || { sha: input.sha, skip: SKIP_REASONS.UNREADABLE, files: [] };
      };
      return reader;
    };
    const changeSet = {
      [added]: { sha: added, skip: null, committedAt: '2026-09-01T00:00:00.000Z', parents: 1, unsafePaths: 0, truncated: false,
        files: [{ path: 'app/config.js', status: 'modified', blobSha: 'e'.repeat(40), hunks: require('../apps/api/src/modules/quasar/index.ts').exposureReader.parsePatch(patchAdding) }] },
      [merge]: { sha: merge, skip: null, files: [], parents: 2 },
      [deleted]: { sha: deleted, skip: null, committedAt: '2026-09-02T00:00:00.000Z', parents: 1, unsafePaths: 0, truncated: false,
        files: [{ path: 'app/config.js', status: 'modified', blobSha: 'f'.repeat(40), hunks: require('../apps/api/src/modules/quasar/index.ts').exposureReader.parsePatch(patchDeleting) }] }
    };

    const store = fakeStore();
    store.scan = { ...store.scan, scanMode: 'history', historyBaseCommit: null };
    const reader = historyReader({ 'app/config.js': 'const a = 1;\nconst b = 2;\n' }, changeSet);
    const result = await runnerFor(store, reader).runOnce();
    assert.strictEqual(result.state, 'complete');
    assert.deepStrictEqual(reader.changeCalls, [added, deleted, merge], 'oldest first, including merge resolutions');
    assert.strictEqual(reader.listCalls[0].commitSha, COMMIT, 'history is read from the scan commit, never a ref');
    assert.strictEqual(store.recorded.length, 1);
    const [found] = store.recorded;
    assert.strictEqual(found.inTree, false);
    assert.strictEqual(found.introducedCommit, added);
    assert.strictEqual(found.introducedAt, '2026-09-01T00:00:00.000Z');
    assert.deepStrictEqual({ ...found.occurrences[0] }, { line: 2, column: 16 });
    assert.strictEqual(found.commit, added, 'it can be read back at the commit that added it');
    assert.strictEqual(store.finalized.commitsTotal, 3);
    assert.strictEqual(store.finalized.commitsScanned, 3);
    assert.strictEqual(store.finalized.commitsSkipped, 0);

    /* Commit reads overlap; when the access check falls due, they share one check rather than each running its own. */
    {
      const shared = fakeStore();
      shared.scan = { ...shared.scan, scanMode: 'history', historyBaseCommit: null };
      const paging = historyReader({ 'app/config.js': 'const a = 1;\nconst b = 2;\n' }, changeSet);
      const read = paging.readCommitChanges;
      paging.readCommitChanges = async input => { await input.beforePage(); return read(input); };
      const renew = shared.renewClaim.bind(shared);
      let active = 0;
      let peak = 0;
      shared.renewClaim = async input => {
        active += 1; peak = Math.max(peak, active);
        try { await new Promise(setImmediate); return await renew(input); } finally { active -= 1; }
      };
      let clock = T0;
      const outcome = await runnerFor(shared, paging, {
        budgets: { renewEveryFiles: 1000, accessCheckIntervalMs: 1000, maxWallClockMs: 10 * 60 * 1000 },
        now: () => (clock += 400)
      }).runOnce();
      assert.strictEqual(outcome.state, 'complete');
      assert.strictEqual(peak, 1, `one access check at a time, however many reads are waiting on it: ${peak}`);
    }

    /* In the tree as well: two sightings of one credential, one against the ceiling. */
    const both = fakeStore();
    both.scan = { ...both.scan, scanMode: 'history' };
    const bothReader = historyReader({ 'app/config.js': `const a = 1;\nconst token = "${SECRET}";\n` }, changeSet);
    await runnerFor(both, bothReader).runOnce();
    assert.deepStrictEqual(both.recorded.map(item => item.inTree), [true, false]);
    assert.strictEqual(new Set(both.recorded.map(item => item.fingerprint)).size, 1);

    /* A tree scan reads no history at all. */
    const plain = fakeStore();
    const plainReader = historyReader({ 'README.md': 'hello\n' }, changeSet);
    await runnerFor(plain, plainReader).runOnce();
    assert.strictEqual(plainReader.listCalls.length, 0);
    assert.strictEqual(plain.finalized.commitsTotal, null);

    /* Prior tips cannot be used as date-order stopping points. */
    const again = fakeStore();
    again.scan = { ...again.scan, scanMode: 'history', historyBaseCommit: deleted };
    const againReader = historyReader({ 'README.md': 'hello\n' }, changeSet);
    await runnerFor(again, againReader).runOnce();
    assert.strictEqual(againReader.listCalls[0].stopAt, undefined);

    /* The provider asking for fewer requests stops history, keeps what was read, and says so. */
    const throttled = fakeStore();
    throttled.scan = { ...throttled.scan, scanMode: 'history' };
    const throttledReader = historyReader({ 'app/config.js': `k = "${SECRET}"\n` }, changeSet, {
      changeError: { sha: deleted, error: Object.assign(new Error('slow down'), { code: 'EXPOSURE_RATE_LIMITED' }) }
    });
    const throttledResult = await runnerFor(throttled, throttledReader).runOnce();
    assert.strictEqual(throttledResult.state, 'partial');
    assert.strictEqual(throttled.finalized.skippedReason, 'rate-limited');
    assert(throttled.recorded.some(item => item.inTree), 'the tree findings are kept');

    /* A commit ceiling is partial coverage that names itself. */
    const capped = fakeStore();
    capped.scan = { ...capped.scan, scanMode: 'history' };
    const cappedReader = historyReader({ 'README.md': 'x\n' }, changeSet, {
      listing: { commits: [{ sha: added, committedAt: null, parents: 1 }], truncated: true }
    });
    await runnerFor(capped, cappedReader, { budgets: { maxCommits: 1 } }).runOnce();
    assert.strictEqual(capped.finalized.skippedReason, 'commit-limit');
    assert.strictEqual(cappedReader.listCalls[0].maxCommits, 1);

    /* An unreadable commit is counted and makes the scan partial, not failed. */
    const gap = fakeStore();
    gap.scan = { ...gap.scan, scanMode: 'history' };
    const gapReader = historyReader({ 'README.md': 'x\n' }, { [added]: changeSet[added] });
    const gapResult = await runnerFor(gap, gapReader).runOnce();
    assert.strictEqual(gapResult.state, 'partial');
    assert.strictEqual(gap.finalized.commitsSkipped, 2, 'both the unreadable regular and merge commits count');

    /* A change sent without a patch is read from its blob, within its own ceiling. */
    const patchless = fakeStore();
    patchless.scan = { ...patchless.scan, scanMode: 'history' };
    const bigFile = 'big/generated.json';
    const patchlessReader = historyReader({ [bigFile]: `{"token":"${SECRET}"}` }, {
      [added]: { sha: added, skip: null, committedAt: null, parents: 1, unsafePaths: 0, truncated: false,
        files: [{ path: bigFile, status: 'added', blobSha: crypto.createHash('sha1').update(bigFile).digest('hex'), hunks: null }] }
    }, { listing: { commits: [{ sha: added, committedAt: null, parents: 1 }], truncated: false } });
    await runnerFor(patchless, patchlessReader).runOnce();
    assert(patchless.recorded.some(item => item.inTree === false && item.path === bigFile));
    const starved = fakeStore();
    starved.scan = { ...starved.scan, scanMode: 'history' };
    const starvedReader = historyReader({ 'README.md': 'x\n' }, {
      [added]: { sha: added, skip: null, committedAt: null, parents: 1, unsafePaths: 0, truncated: false,
        files: [{ path: bigFile, status: 'added', blobSha: 'a'.repeat(40), hunks: null }] }
    }, { listing: { commits: [{ sha: added, committedAt: null, parents: 1 }], truncated: false } });
    const starvedResult = await runnerFor(starved, starvedReader, { budgets: { maxHistoryBlobReads: 0 } }).runOnce();
    assert.strictEqual(starvedResult.state, 'partial', 'a change nobody read is not a clean history');
  }

  /* ---- Archives in the tree ------------------------------------------------ */
  {
    const store = fakeStore();
    const reader = fakeReader({ 'README.md': 'x\n' });
    const baseTree = reader.readTree;
    reader.readTree = async input => {
      const tree = await baseTree(input);
      return { ...tree, entries: [...tree.entries, { path: 'dist/app.zip', sha: 'd'.repeat(40), size: 2048, archive: 'zip' }] };
    };
    reader.archiveCalls = [];
    reader.readArchive = async input => {
      reader.archiveCalls.push(input.path);
      return {
        skip: null,
        members: [{ path: 'dist/app.zip!/config/.env', text: `TOKEN=${SECRET}\n` }, { path: 'dist/app.zip!/README', text: 'hi' }],
        named: [{ path: 'dist/app.zip!/keys/release.jks', sha: 'b'.repeat(64) }],
        examined: 4, membersSkipped: 1, membersSkippedBinary: 1, truncated: false
      };
    };
    const result = await runnerFor(store, reader).runOnce();
    assert.deepStrictEqual(reader.archiveCalls, ['dist/app.zip']);
    assert(!reader.blobCalls.some(call => call.path === 'dist/app.zip'), 'an archive is opened, not read as a blob');
    assert.deepStrictEqual(store.recorded.map(item => [item.rule, item.path]).sort(), [
      ['github-token', 'dist/app.zip!/config/.env'],
      ['keystore-file', 'dist/app.zip!/keys/release.jks']
    ]);
    assert.strictEqual(store.finalized.archivesScanned, 1);
    assert.strictEqual(store.finalized.archiveMembersScanned, 2);
    assert.strictEqual(store.finalized.filesScanned, 2, 'the archive is one file read; its members are counted separately');
    assert.strictEqual(result.state, 'partial', 'a member that was not read makes the scan partial');
  }

  /* No more than two archives are open at once, and none is skipped for it. */
  {
    const store = fakeStore();
    const reader = fakeReader({ 'README.md': 'x\n' });
    const baseTree = reader.readTree;
    reader.readTree = async input => {
      const tree = await baseTree(input);
      const archives = Array.from({ length: 6 }, (_, index) => ({ path: `dist/a${index}.zip`, sha: String(index).repeat(40), size: 1024, archive: 'zip' }));
      return { ...tree, entries: [...archives, ...tree.entries] };
    };
    let open = 0;
    let peak = 0;
    const opened = [];
    reader.readArchive = async input => {
      open += 1;
      peak = Math.max(peak, open);
      await new Promise(resolve => setImmediate(resolve));
      open -= 1;
      opened.push(input.path);
      return { skip: null, members: [], named: [], examined: 0, membersSkipped: 0, membersSkippedBinary: 0, truncated: false };
    };
    await runnerFor(store, reader).runOnce();
    assert(peak <= 2, `at most two archives in flight, saw ${peak}`);
    assert.strictEqual(opened.length, 6);
    assert.strictEqual(store.finalized.archivesScanned, 6);
  }

  /* A previous tip is not an ancestry boundary in GitHub's date-ordered
     listing. A merged branch can have introduced and deleted a secret before
     that tip's date, leaving no trace in the merge's first-parent diff. */
  {
    const providerReader = require('../apps/api/src/modules/quasar/index.ts').exposureReader;
    const sha = n => n.toString(16).padStart(40, '0');
    const items = [5, 4, 3, 2, 1].map(n => ({ sha: sha(n), parents: n === 5 ? [{ sha: sha(4) }, { sha: sha(3) }] : [] }));
    const transport = async input => {
      const url = new URL(input.url);
      if (url.pathname.endsWith('/commits')) return { statusCode: 200, body: JSON.stringify(items) };
      const id = url.pathname.split('/').pop();
      return { statusCode: 200, body: JSON.stringify({ sha: id, files: id === sha(2) ? [{
        filename: '.env', status: 'added', sha: sha(9), patch: `@@ -0,0 +1 @@\n+${SECRET}`
      }] : [] }) };
    };
    const store = fakeStore();
    store.scan = { ...store.scan, commitSha: sha(5), scanMode: 'history', historyBaseCommit: sha(4) };
    const reader = { ...fakeReader({}),
      listCommits: input => providerReader.listCommits({ ...input, transport }),
      readCommitChanges: input => providerReader.readCommitChanges({ ...input, transport })
    };
    await runnerFor(store, reader).runOnce();
    assert.strictEqual(store.recorded.length, 1, 'a merged side branch is scanned beyond the previous tip');
    assert.strictEqual(store.finalized.coverage, 'complete');
    assert.strictEqual(store.finalized.commitsScanned, 5);
  }

  /* Pagination is real reader code under a virtual clock: slow history must
     renew the claim, notice cancellation, and obey the scan deadline between
     requests, including pagination hidden inside one commit's file list. */
  for (const stage of ['listing', 'changes']) {
    for (const stop of ['cancel', 'deadline', 'renew']) {
      const providerReader = require('../apps/api/src/modules/quasar/index.ts').exposureReader;
      const sha = n => n.toString(16).padStart(40, '0');
      let clock = T0;
      let requests = 0;
      let canceled = false;
      let expiresAt = T0 + 60_000;
      const store = fakeStore({
        async renewClaim(input) {
          this.calls.push(['renewClaim', input]);
          if (canceled || clock >= expiresAt) return false;
          expiresAt = clock + 60_000;
          return true;
        }
      });
      store.scan = { ...store.scan, scanMode: 'history' };
      const transport = async input => {
        requests += 1;
        clock += 31_000;
        if (stop === 'cancel') canceled = true;
        const page = Number(new URL(input.url).searchParams.get('page'));
        return { statusCode: 200, body: JSON.stringify(stage === 'listing'
          ? page < 4 ? Array.from({ length: 100 }, (_, i) => ({ sha: sha(page * 100 + i), parents: [] })) : []
          : { sha: COMMIT, files: page < 4 ? Array.from({ length: 100 }, (_, i) => ({ filename: `${page}-${i}.txt`, status: 'removed' })) : [] }) };
      };
      const reader = { ...fakeReader({}),
        listCommits: stage === 'listing'
          ? input => providerReader.listCommits({ ...input, transport })
          : async () => ({ commits: [{ sha: COMMIT, parents: 0 }], truncated: false }),
        readCommitChanges: stage === 'changes'
          ? input => providerReader.readCommitChanges({ ...input, transport })
          : async input => ({ sha: input.sha, files: [] })
      };
      const result = await runnerFor(store, reader, { now: () => clock,
        budgets: { maxWallClockMs: stop === 'deadline' ? 30_000 : 480_000 } }).runOnce();
      if (stop === 'cancel') {
        assert.strictEqual(requests, 1, `${stage}: cancellation prevents page two`);
        assert.strictEqual(result.stopped, 'claim-lost');
        assert.strictEqual(store.finalized, null);
      } else if (stop === 'deadline') {
        assert.strictEqual(requests, 1, `${stage}: deadline prevents page two`);
        assert.strictEqual(store.finalized.coverage, 'partial');
        assert.strictEqual(store.finalized.skippedReason, 'time-limit');
      } else {
        assert.strictEqual(requests, 4, `${stage}: live lease permits all pages`);
        assert.strictEqual(store.finalized.coverage, 'complete', `${stage}: pagination must renew the lease`);
      }
    }
  }

  console.log('exposure worker tests passed');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
