'use strict';

/*
 * The exposure store against a real PostgreSQL server.
 *
 * Almost every property this store depends on belongs to the database rather
 * than to JavaScript: idempotency is a unique index, single-ownership is a
 * partial unique index, the fencing token is a conditional UPDATE matching zero
 * rows, and the guarantee that no row can carry a credential is a set of CHECK
 * constraints and two integer arrays. A fake database is the wrong instrument
 * for all of it -- a fake that decides a conflict atomically does so because it
 * was written to, so a store that read and then wrote would pass against it and
 * race against a real server.
 *
 * So this gate needs a server and refuses without one, for the same reason the
 * migration gate does: a gate that quietly passes when its dependency is
 * missing is the same as not having the gate.
 */

const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const { Client, Pool } = require('pg');

const { loadMigrations, runMigrations } = require('../src/migrations');
const {
  EXPOSURE_CONFIG_VERSION,
  ExposureStore,
  ExposureStoreError,
  MAX_OCCURRENCES
} = require('../src/exposure-store');

const DIRECTORY = path.join(__dirname, '..', 'db', 'migrations');
const ADMIN_URL = String(process.env.NV_TEST_DATABASE_URL || '').trim();

if (!ADMIN_URL) {
  throw new Error(
    'NV_TEST_DATABASE_URL is required: this gate runs the exposure store against a real PostgreSQL server'
  );
}

/* A synthetic credential, so the leak sweep at the end has something real to
   look for. Split prefix, because this file is scanned by the release gate. */
const SECRET = `gh${'p'}_${'Z'.repeat(36)}`;

const scope = Object.freeze({
  provider: 'github', authority: 'github.com', owner: 'Acme', repo: 'Demo'
});
const otherScope = Object.freeze({ ...scope, repo: 'Elsewhere' });
const IDENTITY = 'a'.repeat(64);
const OTHER_IDENTITY = 'b'.repeat(64);
const COMMIT = 'c'.repeat(40);
const SECOND_COMMIT = 'd'.repeat(40);
const REF = 'refs/heads/main';
const T0 = Date.parse('2026-09-22T10:00:00.000Z');

function fingerprint(seed) {
  return crypto.createHash('sha256').update(`fixture:${seed}`).digest('hex');
}

function findingFixture(seed, overrides = {}) {
  return {
    fingerprint: fingerprint(seed),
    fingerprintKeyVersion: 1,
    rulesVersion: 1,
    engineVersion: 1,
    rule: 'github-token',
    path: `app/${seed}.js`,
    placeholder: '<github-token #1>',
    occurrences: [{ line: 4, column: 11 }],
    occurrenceCount: 1,
    truncated: false,
    ...overrides
  };
}

function scanRequest(overrides = {}) {
  return {
    scope, identityKey: IDENTITY, requestedBy: 'alice', refName: REF, commitSha: COMMIT,
    rulesVersion: 1, engineVersion: 1, fingerprintKeyVersion: 1, configVersion: EXPOSURE_CONFIG_VERSION,
    idempotencyKey: 'idem-00000001', now: T0,
    ...overrides
  };
}

function scratchName() {
  return `nvx_exposure_gate_${crypto.randomBytes(6).toString('hex')}`;
}

function urlForDatabase(base, databaseName) {
  const url = new URL(base);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function withClient(connectionString, run) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

/* Every claim needs a token, and a claim is how a worker gets one. */
async function claim(store, now = T0) {
  const claimed = await store.claimScan({ now });
  assert(claimed, 'a queued scan must be claimable');
  return claimed;
}

(async () => {
  const databaseName = scratchName();
  await withClient(ADMIN_URL, client => client.query(`CREATE DATABASE ${databaseName}`));
  const scratchUrl = urlForDatabase(ADMIN_URL, databaseName);

  const pool = new Pool({ connectionString: scratchUrl, max: 4 });
  try {
    await withClient(scratchUrl, async client => {
      await runMigrations(client, loadMigrations(DIRECTORY));
    });
    const store = new ExposureStore({ pool });

    /* ---- Idempotency, and the difference from a conflicting scan --------- */

    {
      const first = await store.requestScan(scanRequest());
      assert.strictEqual(first.created, true);
      assert.strictEqual(first.scan.state, 'queued');
      assert.strictEqual(first.scan.coverage, 'unknown');
      assert.strictEqual(first.scan.commitSha, COMMIT);
      assert.strictEqual(first.scan.finishedAt, null);

      /* The same key is the same scan, not a second one. */
      const repeat = await store.requestScan(scanRequest());
      assert.strictEqual(repeat.created, false);
      assert.strictEqual(repeat.scan.scanId, first.scan.scanId);

      /*
       * Concurrently, too. Ten simultaneous requests carrying one key must
       * produce one scan -- which is the property a fake database cannot
       * test, because it decides the conflict in one thread either way.
       */
      const racers = await Promise.all(
        Array.from({ length: 10 }, () => store.requestScan(scanRequest()))
      );
      assert.strictEqual(new Set(racers.map(item => item.scan.scanId)).size, 1);
      assert.strictEqual(racers.filter(item => item.created).length, 0);

      /* A different key while one is live is a conflict, not a second scan. */
      await assert.rejects(
        store.requestScan(scanRequest({ idempotencyKey: 'idem-00000002' })),
        error => error instanceof ExposureStoreError && error.code === 'EXPOSURE_SCAN_ALREADY_ACTIVE'
          && error.status === 409,
        'one repository has one live scan'
      );

      /* Another repository is unaffected. */
      const elsewhere = await store.requestScan(scanRequest({
        scope: otherScope, idempotencyKey: 'idem-00000003'
      }));
      assert.strictEqual(elsewhere.created, true);
      const elsewhereClaim = await claim(store);
      await store.finalizeScan({
        scanId: elsewhereClaim.scan.scanId, claimOwner: elsewhereClaim.claimOwner,
        state: 'canceled', coverage: 'unknown', skippedReason: 'canceled', now: T0 + 1000
      });
    }

    /* ---- Claims and fencing --------------------------------------------- */

    let firstScanId = null;
    {
      const claimed = await claim(store, T0 + 2000);
      firstScanId = claimed.scan.scanId;
      assert.strictEqual(claimed.scan.state, 'running');
      assert.match(claimed.claimOwner, /^[0-9a-f]{32}$/);

      /* Nothing else is claimable: the only live scan is now held. */
      assert.strictEqual(await store.claimScan({ now: T0 + 2500 }), null);

      /* A stale token cannot write. */
      await assert.rejects(
        store.recordObservations({
          scanId: firstScanId, claimOwner: 'f'.repeat(32), findings: [findingFixture('one')], now: T0 + 3000
        }),
        error => error instanceof ExposureStoreError && error.code === 'EXPOSURE_SCAN_NOT_OWNED'
      );
      await assert.rejects(
        store.finalizeScan({
          scanId: firstScanId, claimOwner: 'f'.repeat(32), state: 'complete', coverage: 'complete', now: T0 + 3000
        }),
        error => error instanceof ExposureStoreError && error.code === 'EXPOSURE_SCAN_NOT_OWNED'
      );

      /* The holder can renew; nobody else can. */
      assert.strictEqual(await store.renewClaim({
        scanId: firstScanId, claimOwner: claimed.claimOwner, leaseMs: 60_000, now: T0 + 3000
      }), true);
      assert.strictEqual(await store.renewClaim({
        scanId: firstScanId, claimOwner: 'f'.repeat(32), leaseMs: 60_000, now: T0 + 3000
      }), false);

      /*
       * And a lease that has run out is reclaimable, which is what makes a
       * killed worker's job recoverable without anything noticing it died. The
       * reclaim issues a new token, so the original holder is fenced out --
       * tested by having it try to finalize afterwards.
       */
      const reclaimed = await store.claimScan({ now: T0 + 3000 + 61_000 });
      assert(reclaimed, 'an expired lease must be reclaimable');
      assert.strictEqual(reclaimed.scan.scanId, firstScanId);
      assert.notStrictEqual(reclaimed.claimOwner, claimed.claimOwner);
      await assert.rejects(
        store.finalizeScan({
          scanId: firstScanId, claimOwner: claimed.claimOwner,
          state: 'complete', coverage: 'complete', now: T0 + 65_000
        }),
        error => error.code === 'EXPOSURE_SCAN_NOT_OWNED',
        'a worker whose lease expired cannot finalize a job somebody else owns'
      );

      /* Two workers claiming at once get at most one scan between them. */
      await store.finalizeScan({
        scanId: firstScanId, claimOwner: reclaimed.claimOwner,
        state: 'canceled', coverage: 'unknown', skippedReason: 'canceled', now: T0 + 66_000
      });
      await store.requestScan(scanRequest({ idempotencyKey: 'idem-00000004', now: T0 + 67_000 }));
      const contenders = await Promise.all([
        store.claimScan({ now: T0 + 68_000 }),
        store.claimScan({ now: T0 + 68_000 }),
        store.claimScan({ now: T0 + 68_000 })
      ]);
      const winners = contenders.filter(Boolean);
      /*
       * One winner, and the reason is the predicate rather than the lock hint.
       * A second claimer that blocks on the row re-evaluates the qualifying
       * conditions when the first commits, and by then the scan is running
       * with a live lease -- so it no longer qualifies. `SKIP LOCKED` only
       * decides whether that claimer waits to be told no or moves on
       * immediately, which is why removing it does not make this fail.
       */
      assert.strictEqual(winners.length, 1, 'two processes must not own the same repository scan');
      assert.strictEqual(
        new Set(winners.map(item => item.claimOwner)).size, 1,
        'and one token, so there is one writer'
      );
      await store.finalizeScan({
        scanId: winners[0].scan.scanId, claimOwner: winners[0].claimOwner,
        state: 'canceled', coverage: 'unknown', skippedReason: 'canceled', now: T0 + 69_000
      });
    }

    /* ---- Observations are append-only ----------------------------------- */

    let baselineScanId = null;
    {
      const requested = await store.requestScan(scanRequest({
        idempotencyKey: 'idem-baseline-1', now: T0 + 100_000
      }));
      baselineScanId = requested.scan.scanId;
      const held = await claim(store, T0 + 101_000);

      const findings = [
        findingFixture('one', {
          occurrences: [{ line: 4, column: 11 }, { line: 9, column: 3 }],
          occurrenceCount: 2,
          verification: {
            state: 'verified', reason: 'identity-confirmed', adapter: 'github-user-token',
            subjectDigest: '0'.repeat(32),
            observedAt: new Date(T0 + 101_500).toISOString(),
            freshnessDeadline: new Date(T0 + 101_500 + 86_400_000).toISOString(),
            retryAfterMs: null
          }
        }),
        findingFixture('two', { rule: 'slack-token', placeholder: '<slack-token #1>' }),
        findingFixture('three', {
          occurrences: Array.from({ length: MAX_OCCURRENCES }, (_value, index) => ({ line: index + 1, column: 2 })),
          occurrenceCount: 400
        })
      ];
      const written = await store.recordObservations({
        scanId: baselineScanId, claimOwner: held.claimOwner, findings, now: T0 + 102_000
      });
      assert.deepStrictEqual({ ...written }, { recorded: 3, submitted: 3 });

      /* A retry writes nothing further and does not fail. */
      const retried = await store.recordObservations({
        scanId: baselineScanId, claimOwner: held.claimOwner, findings, now: T0 + 102_500
      });
      assert.strictEqual(retried.recorded, 0, 'an observation is written once');
      assert.strictEqual(retried.submitted, 3);

      const observations = await store.listObservations({
        scanId: baselineScanId, identityKey: IDENTITY, limit: 10
      });
      assert.strictEqual(observations.length, 3);
      const capped = observations.find(item => item.occurrenceCount === 400);
      assert.strictEqual(capped.occurrences.length, MAX_OCCURRENCES, 'the locations are bounded');
      assert.strictEqual(capped.truncated, true, 'and the row says the list was cut');

      const verified = observations.find(item => item.verification);
      assert.strictEqual(verified.verification.state, 'verified');
      assert.strictEqual(verified.verification.reason, 'identity-confirmed');
      assert.deepStrictEqual(
        verified.occurrences.map(item => [item.line, item.column]), [[4, 11], [9, 3]]
      );

      /* A finding must carry the versions its scan ran under. */
      await assert.rejects(
        store.recordObservations({
          scanId: baselineScanId, claimOwner: held.claimOwner,
          findings: [findingFixture('four', { rulesVersion: 2 })], now: T0 + 103_000
        }),
        error => error.code === 'EXPOSURE_FINDING_VERSION_MISMATCH'
      );

      /* A partially redacted placeholder is refused before it reaches SQL. */
      await assert.rejects(
        store.recordObservations({
          scanId: baselineScanId, claimOwner: held.claimOwner,
          findings: [findingFixture('five', { placeholder: `<${SECRET.slice(0, 8)}...>` })],
          now: T0 + 103_000
        }),
        /generated label/
      );

      /*
       * A count below its own list of locations. The schema refuses it too,
       * but refusing here says which field is wrong -- and a count that can
       * disagree with its locations is a count nothing downstream can read.
       */
      await assert.rejects(
        store.recordObservations({
          scanId: baselineScanId, claimOwner: held.claimOwner,
          findings: [findingFixture('seven', {
            occurrences: [{ line: 1, column: 1 }, { line: 2, column: 1 }], occurrenceCount: 1
          })],
          now: T0 + 103_000
        }),
        /count cannot be smaller/
      );

      /*
       * And the truncation flag is derived rather than accepted. A caller that
       * claimed a complete list while handing over a cut one would be telling
       * a reader they had seen everything.
       */
      {
        const lying = await store.recordObservations({
          scanId: baselineScanId, claimOwner: held.claimOwner,
          findings: [findingFixture('eight', {
            occurrences: [{ line: 1, column: 1 }], occurrenceCount: 9, truncated: false
          })],
          now: T0 + 103_500
        });
        assert.strictEqual(lying.recorded, 1);
        const written = (await store.listObservations({
          scanId: baselineScanId, identityKey: IDENTITY, limit: 50
        })).find(item => item.occurrenceCount === 9);
        assert.strictEqual(written.truncated, true, 'the store decides this, not the caller');
      }

      /* A location that is not a location is refused too. */
      for (const occurrences of [
        [{ line: 'const token = x', column: 1 }],
        [{ line: 0, column: 1 }],
        [{ line: 1, column: -4 }],
        []
      ]) {
        await assert.rejects(
          store.recordObservations({
            scanId: baselineScanId, claimOwner: held.claimOwner,
            findings: [findingFixture('six', { occurrences, occurrenceCount: occurrences.length || 1 })],
            now: T0 + 103_000
          }),
          error => error instanceof TypeError,
          JSON.stringify(occurrences)
        );
      }

      await store.finalizeScan({
        scanId: baselineScanId, claimOwner: held.claimOwner,
        state: 'complete', coverage: 'complete', filesScanned: 120, bytesScanned: 4096, now: T0 + 104_000
      });
    }

    /* ---- Nothing concludes a credential is gone without the evidence ---- */

    /*
     * Each of these runs a scan that is missing one of the three findings and
     * then asks for a conclusion. Every one must refuse with its own reason:
     * absence in a scan that was canceled, that was truncated, that ran under
     * different versions, or that looked at a different ref is an artefact of
     * the scan and not a fact about the repository.
     */
    async function scanMissingOne(overrides, finalize) {
      const requested = await store.requestScan(scanRequest({
        idempotencyKey: `idem-${crypto.randomBytes(5).toString('hex')}`,
        commitSha: SECOND_COMMIT,
        now: overrides.now,
        ...overrides.request
      }));
      const held = await claim(store, overrides.now + 100);
      const versions = {
        rulesVersion: (overrides.request && overrides.request.rulesVersion) || 1,
        engineVersion: (overrides.request && overrides.request.engineVersion) || 1,
        fingerprintKeyVersion: (overrides.request && overrides.request.fingerprintKeyVersion) || 1
      };
      await store.recordObservations({
        scanId: requested.scan.scanId,
        claimOwner: held.claimOwner,
        findings: ['one', 'two'].map(seed => findingFixture(seed, {
          ...versions,
          fingerprint: fingerprint(overrides.reseed ? `${seed}-v2` : seed),
          placeholder: seed === 'two' ? '<slack-token #1>' : '<github-token #1>',
          rule: seed === 'two' ? 'slack-token' : 'github-token'
        })),
        now: overrides.now + 200
      });
      await finalize(requested.scan.scanId, held.claimOwner);
      return requested.scan.scanId;
    }

    {
      let clock = T0 + 200_000;
      const refusals = [];

      /* Canceled. */
      const canceled = await scanMissingOne({ now: clock }, async (scanId, owner) => {
        await store.finalizeScan({
          scanId, claimOwner: owner, state: 'canceled', coverage: 'partial',
          skippedReason: 'canceled', parentScanId: baselineScanId, now: clock + 300
        });
      });
      refusals.push(['canceled', await store.concludeRemovedFromTree({
        scanId: canceled, identityKey: IDENTITY, now: clock + 400
      })]);
      clock += 10_000;

      /* Failed. */
      const failed = await scanMissingOne({ now: clock }, async (scanId, owner) => {
        await store.finalizeScan({
          scanId, claimOwner: owner, state: 'failed', coverage: 'unknown',
          skippedReason: 'transport-refused', parentScanId: baselineScanId, now: clock + 300
        });
      });
      refusals.push(['failed', await store.concludeRemovedFromTree({
        scanId: failed, identityKey: IDENTITY, now: clock + 400
      })]);
      clock += 10_000;

      /* Truncated: it finished, but it did not read everything. */
      const truncated = await scanMissingOne({ now: clock }, async (scanId, owner) => {
        await store.finalizeScan({
          scanId, claimOwner: owner, state: 'partial', coverage: 'partial',
          skippedReason: 'file-count-limit', parentScanId: baselineScanId, now: clock + 300
        });
      });
      refusals.push(['truncated', await store.concludeRemovedFromTree({
        scanId: truncated, identityKey: IDENTITY, now: clock + 400
      })]);
      clock += 10_000;

      /*
       * Finished cleanly, and still did not read everything.
       *
       * This is the combination worth a case of its own: state says how the
       * run ended and coverage says what it actually read, and they are
       * independent. A scan that walked the whole tree it was given but could
       * not decode nine files ended fine and saw less than all of it -- so it
       * is `complete` with `partial` coverage, and it is exactly as unable to
       * conclude that a credential is gone as a scan that crashed.
       */
      const incompleteCoverage = await scanMissingOne({ now: clock }, async (scanId, owner) => {
        await store.finalizeScan({
          scanId, claimOwner: owner, state: 'complete', coverage: 'partial',
          skippedReason: 'unreadable-files', parentScanId: baselineScanId, now: clock + 300
        });
      });
      refusals.push(['incomplete coverage', await store.concludeRemovedFromTree({
        scanId: incompleteCoverage, identityKey: IDENTITY, now: clock + 400
      })]);
      clock += 10_000;

      /* Complete, but with no recorded predecessor to compare against. */
      const orphan = await scanMissingOne({ now: clock }, async (scanId, owner) => {
        await store.finalizeScan({
          scanId, claimOwner: owner, state: 'complete', coverage: 'complete', now: clock + 300
        });
      });
      refusals.push(['no predecessor', await store.concludeRemovedFromTree({
        scanId: orphan, identityKey: IDENTITY, now: clock + 400
      })]);
      clock += 10_000;

      /* Complete, but a different ref: the comparison would be meaningless. */
      const otherRef = await scanMissingOne({
        now: clock, request: { refName: 'refs/heads/release' }
      }, async (scanId, owner) => {
        await store.finalizeScan({
          scanId, claimOwner: owner, state: 'complete', coverage: 'complete',
          parentScanId: baselineScanId, now: clock + 300
        });
      });
      refusals.push(['other ref', await store.concludeRemovedFromTree({
        scanId: otherRef, identityKey: IDENTITY, now: clock + 400
      })]);
      clock += 10_000;

      /*
       * Complete, same ref, but a rotated fingerprint key. This is the one
       * that matters most: every fingerprint changed, so every previous
       * finding is missing from this scan for a reason that has nothing to do
       * with the repository, and a diff would mark all of them resolved.
       */
      const rotated = await scanMissingOne({
        now: clock, reseed: true, request: { fingerprintKeyVersion: 2 }
      }, async (scanId, owner) => {
        await store.finalizeScan({
          scanId, claimOwner: owner, state: 'complete', coverage: 'complete',
          parentScanId: baselineScanId, now: clock + 300
        });
      });
      refusals.push(['rotated key', await store.concludeRemovedFromTree({
        scanId: rotated, identityKey: IDENTITY, now: clock + 400
      })]);
      clock += 10_000;

      assert.deepStrictEqual(refusals.map(([label, result]) => [label, result.concluded, result.removed]), [
        ['canceled', false, 0],
        ['failed', false, 0],
        ['truncated', false, 0],
        ['incomplete coverage', false, 0],
        ['no predecessor', false, 0],
        ['other ref', false, 0],
        ['rotated key', false, 0]
      ]);
      assert.deepStrictEqual(refusals.map(([, result]) => result.reason), [
        'scan-not-complete', 'scan-not-complete', 'scan-not-complete',
        'coverage-not-complete', 'no-comparable-predecessor', 'ref-lineage-mismatch',
        'incompatible-versions'
      ]);

      /* And nothing was touched by any of them. */
      const stillOpen = await store.listFindings({
        scope, identityKey: IDENTITY, dispositions: ['open'], limit: 50
      });
      assert.strictEqual(
        stillOpen.filter(item => item.fingerprintKeyVersion === 1).length, 4,
        'a refused conclusion must leave every finding exactly as it was'
      );

      /* Another identity cannot ask at all. */
      const denied = await store.concludeRemovedFromTree({
        scanId: baselineScanId, identityKey: OTHER_IDENTITY, now: clock
      });
      assert.deepStrictEqual({ ...denied }, { concluded: false, reason: 'scan-not-found', removed: 0 });
    }

    /* ---- The conclusion, when it is earned ------------------------------ */

    {
      const clock = T0 + 400_000;
      const complete = await scanMissingOne({ now: clock }, async (scanId, owner) => {
        await store.finalizeScan({
          scanId, claimOwner: owner, state: 'complete', coverage: 'complete',
          filesScanned: 120, bytesScanned: 4096, parentScanId: baselineScanId, now: clock + 300
        });
      });
      const concluded = await store.concludeRemovedFromTree({
        scanId: complete, identityKey: IDENTITY, now: clock + 400
      });
      assert.strictEqual(concluded.concluded, true);
      /*
       * Exactly the findings the baseline saw and this scan did not -- and no
       * others. `one` and `two` are in both trees and must be untouched, which
       * is the half of this that a conclusion marking everything resolved
       * would also satisfy if it were only counted.
       */
      assert.deepStrictEqual(
        [...concluded.fingerprints].sort(),
        [fingerprint('three'), fingerprint('eight')].sort()
      );
      assert.strictEqual(concluded.removed, 2);

      const removed = await store.listFindings({
        scope, identityKey: IDENTITY, dispositions: ['removed-from-tree'], limit: 50
      });
      assert.deepStrictEqual(
        removed.map(item => item.fingerprint).sort(),
        [fingerprint('three'), fingerprint('eight')].sort()
      );
      const stillThere = await store.listFindings({
        scope, identityKey: IDENTITY, dispositions: ['open'], limit: 50
      });
      assert.deepStrictEqual(
        stillThere.filter(item => item.fingerprintKeyVersion === 1).map(item => item.fingerprint).sort(),
        [fingerprint('one'), fingerprint('two')].sort(),
        'a credential still in the tree is still open'
      );
      for (const finding of removed) {
        assert.strictEqual(
          finding.dispositionBy, null,
          'a tree comparison has no actor, and recording one would invent an approval'
        );
      }
      /*
       * And the word is not "resolved". A credential absent from HEAD is still
       * in the repository's history, reachable by anybody with a clone -- which
       * is why no disposition in this schema says the exposure is over on the
       * strength of a tree comparison.
       */
      for (const finding of removed) assert.strictEqual(finding.disposition, 'removed-from-tree');

      /* Seeing it again is a statement that the removal claim was wrong, so it
         goes back to open rather than staying quietly removed. */
      const seenAgain = await store.requestScan(scanRequest({
        idempotencyKey: 'idem-seen-again', now: clock + 500_000
      }));
      const held = await claim(store, clock + 500_100);
      await store.recordObservations({
        scanId: seenAgain.scan.scanId, claimOwner: held.claimOwner,
        findings: [findingFixture('three')], now: clock + 500_200
      });
      await store.finalizeScan({
        scanId: seenAgain.scan.scanId, claimOwner: held.claimOwner,
        state: 'complete', coverage: 'complete', now: clock + 500_300
      });
      const reopened = await store.listFindings({
        scope, identityKey: IDENTITY, dispositions: ['open'], limit: 50
      });
      assert(
        reopened.some(item => item.fingerprint === fingerprint('three')),
        'a credential that is back in the tree is open again'
      );
    }

    /* ---- Dispositions a person or a provider set ------------------------ */

    {
      const now = T0 + 900_000;
      const rejected = await store.markCredentialRejected({
        scope, fingerprint: fingerprint('one'), identityKey: IDENTITY, now
      });
      assert.strictEqual(rejected.disposition, 'credential-rejected');
      assert.strictEqual(rejected.dispositionBy, null, 'the provider said no, not a person');

      const accepted = await store.acceptRisk({
        scope, fingerprint: fingerprint('two'), identityKey: IDENTITY, actor: 'alice', now
      });
      assert.strictEqual(accepted.disposition, 'accepted-risk');
      assert.strictEqual(accepted.dispositionBy, 'alice');

      /* A provider refusal does not overturn a person's decision. */
      const unchanged = await store.markCredentialRejected({
        scope, fingerprint: fingerprint('two'), identityKey: IDENTITY, now: now + 1000
      });
      assert.strictEqual(unchanged, null);
      const stillAccepted = await store.listFindings({
        scope, identityKey: IDENTITY, dispositions: ['accepted-risk'], limit: 10
      });
      assert.strictEqual(stillAccepted.length, 1);

      /* Neither reaches another identity's findings. */
      assert.strictEqual(await store.markCredentialRejected({
        scope, fingerprint: fingerprint('one'), identityKey: OTHER_IDENTITY, now
      }), null);
      assert.strictEqual(await store.acceptRisk({
        scope, fingerprint: fingerprint('one'), identityKey: OTHER_IDENTITY, actor: 'mallory', now
      }), null);
    }

    /* ---- The identity boundary is in the query, not after it ------------ */

    {
      assert.strictEqual(await store.getScan({ scanId: baselineScanId, identityKey: OTHER_IDENTITY }), null);
      assert(await store.getScan({ scanId: baselineScanId, identityKey: IDENTITY }));
      assert.deepStrictEqual(
        await store.listObservations({ scanId: baselineScanId, identityKey: OTHER_IDENTITY, limit: 10 }),
        []
      );
      assert.deepStrictEqual(
        await store.listFindings({ scope, identityKey: OTHER_IDENTITY, limit: 10 }), []
      );
      /* Another repository under the same identity is a different list. */
      assert.deepStrictEqual(
        await store.listFindings({ scope: otherScope, identityKey: IDENTITY, limit: 10 }), []
      );
    }

    /* ---- Retention keeps the finding and ages out the measurement ------- */

    {
      const expiring = await store.requestScan(scanRequest({
        scope: otherScope, identityKey: IDENTITY, idempotencyKey: 'idem-expiring-1',
        now: T0 + 1_000_000, retainUntil: T0 + 1_000_500
      }));
      const held = await claim(store, T0 + 1_000_100);
      await store.recordObservations({
        scanId: expiring.scan.scanId, claimOwner: held.claimOwner,
        findings: [findingFixture('elsewhere')], now: T0 + 1_000_200
      });
      await store.finalizeScan({
        scanId: expiring.scan.scanId, claimOwner: held.claimOwner,
        state: 'complete', coverage: 'complete', now: T0 + 1_000_300
      });

      /* Not yet due: a sweep must not take an unexpired scan. */
      assert.strictEqual(await store.sweepExpiredScans({ now: T0 + 1_000_400, limit: 100 }), 0);

      const swept = await store.sweepExpiredScans({ now: T0 + 1_000_600, limit: 100 });
      assert.strictEqual(swept, 1);
      assert.strictEqual(
        await store.getScan({ scanId: expiring.scan.scanId, identityKey: IDENTITY }), null
      );
      const survived = await store.listFindings({
        scope: otherScope, identityKey: IDENTITY, limit: 10
      });
      assert.strictEqual(
        survived.length, 1,
        'retention ages out what was seen where; that a credential was exposed is not forgotten'
      );
      /* Its observations went with the scan, by cascade. */
      const orphans = await pool.query(
        'SELECT count(*)::int AS total FROM nv_exposure_observations WHERE scan_id=$1',
        [expiring.scan.scanId]
      );
      assert.strictEqual(orphans.rows[0].total, 0);
    }

    /* ---- Verification attempts are history, not a column ---------------- */

    /*
     * The sequence is the point. "Verified live on Tuesday, rejected on
     * Friday" is what proves somebody's revocation worked; a single mutable
     * column would keep only the last answer and throw that away.
     */
    {
      const target = fingerprint('one');
      const base = T0 + 2_000_000;

      const live = await store.recordVerification({
        scope, identityKey: IDENTITY, fingerprint: target, requestedBy: 'alice',
        adapterVersion: 1, targetId: 'api.github.com', authorizationId: 'grant-1',
        record: {
          state: 'verified', reason: 'identity-confirmed', adapter: 'github-user-token',
          subjectDigest: '1'.repeat(32),
          observedAt: new Date(base).toISOString(),
          freshnessDeadline: new Date(base + 86_400_000).toISOString(),
          retryAfterMs: null
        }
      });
      assert.strictEqual(live.verification.state, 'verified');
      assert.strictEqual(live.verification.adapter, 'github-user-token');
      assert.strictEqual(live.verification.subjectDigest, '1'.repeat(32));
      assert.strictEqual(live.verification.requestedBy, 'alice');
      assert.strictEqual(
        live.finding, null,
        'a live credential does not move the finding: it was already open'
      );

      /* An unverifiable attempt never reached an account, so it names none. */
      const couldNotTell = await store.recordVerification({
        scope, identityKey: IDENTITY, fingerprint: target, requestedBy: 'alice',
        record: {
          state: 'unverifiable', reason: 'provider-throttled', adapter: 'github-user-token',
          subjectDigest: '2'.repeat(32),
          observedAt: new Date(base + 1000).toISOString(),
          retryAfterMs: 60_000
        }
      });
      assert.strictEqual(couldNotTell.verification.state, 'unverifiable');
      assert.strictEqual(
        couldNotTell.verification.subjectDigest, null,
        'an attempt that reached no account must not record one'
      );
      assert.strictEqual(couldNotTell.verification.retryAfterMs, 60_000);

      /*
       * And the provider saying no is the one answer that ends an exposure, so
       * it moves the finding in the same transaction that records it.
       */
      const refused = await store.recordVerification({
        scope, identityKey: IDENTITY, fingerprint: target, requestedBy: 'alice',
        record: {
          state: 'rejected', reason: 'credential-refused', adapter: 'github-user-token',
          observedAt: new Date(base + 2000).toISOString()
        }
      });
      assert.strictEqual(refused.verification.state, 'rejected');
      assert.strictEqual(refused.finding.disposition, 'credential-rejected');
      assert.strictEqual(
        refused.finding.dispositionBy, null,
        'the provider said no, not a person'
      );

      /* All three kept, newest first. */
      const history = await store.listVerifications({
        scope, identityKey: IDENTITY, fingerprint: target, limit: 10
      });
      assert.deepStrictEqual(
        history.map(item => item.state), ['rejected', 'unverifiable', 'verified'],
        'every attempt is kept, and the order is the story'
      );

      /* A default deadline is supplied rather than left open: an attempt that
         never goes stale would read as current forever. */
      assert(Date.parse(history[0].freshnessDeadline) > Date.parse(history[0].observedAt));
    }

    /* A person's decision is not overturned by a later provider answer. */
    {
      const target = fingerprint('two');
      const accepted = await store.listFindings({
        scope, identityKey: IDENTITY, dispositions: ['accepted-risk'], limit: 10
      });
      assert.strictEqual(accepted[0].fingerprint, target, 'the fixture must already be accepted');

      const refused = await store.recordVerification({
        scope, identityKey: IDENTITY, fingerprint: target, requestedBy: 'alice',
        record: {
          state: 'rejected', reason: 'credential-refused', adapter: 'slack-user-token',
          observedAt: new Date(T0 + 2_100_000).toISOString()
        }
      });
      assert.strictEqual(refused.verification.state, 'rejected', 'the attempt is still recorded');
      assert.strictEqual(
        refused.finding, null,
        'but an accepted risk is a person\'s decision and a provider does not overturn it'
      );
      const stillAccepted = await store.listFindings({
        scope, identityKey: IDENTITY, dispositions: ['accepted-risk'], limit: 10
      });
      assert.strictEqual(stillAccepted.length, 1);
    }

    /* The identity boundary, here as everywhere. */
    {
      const target = fingerprint('one');
      await assert.rejects(
        store.recordVerification({
          scope, identityKey: OTHER_IDENTITY, fingerprint: target, requestedBy: 'mallory',
          record: { state: 'verified', reason: 'identity-confirmed', adapter: 'github-user-token', observedAt: new Date(T0).toISOString() }
        }),
        error => error.code === 'EXPOSURE_FINDING_NOT_FOUND' && error.status === 404,
        'another identity cannot record an attempt against this finding'
      );
      assert.deepStrictEqual(
        await store.listVerifications({ scope, identityKey: OTHER_IDENTITY, fingerprint: target, limit: 10 }),
        []
      );
    }

    /* ---- Readability probes are history too ----------------------------- */

    /*
     * The same shape and one crucial difference: a probe never moves a
     * finding. "The anonymous role can read this table" and "this key still
     * works" are different facts, and a probe that changed a disposition would
     * be reporting the second on the evidence of the first.
     */
    {
      const target = fingerprint('one');
      const base = T0 + 2_200_000;
      const project = 'q'.repeat(20);

      const readable = await store.recordReadabilityProbe({
        scope, identityKey: IDENTITY, fingerprint: target, requestedBy: 'alice',
        authorizationId: 'probe-grant-1',
        record: {
          state: 'readable', reason: 'rows-visible',
          projectRef: project, relation: 'profiles', projection: ['id', 'email'],
          testedRole: 'anon', rowCount: 1,
          observedAt: new Date(base).toISOString()
        }
      });
      assert.strictEqual(readable.probe.state, 'readable');
      assert.strictEqual(readable.probe.rowCount, 1);
      assert.strictEqual(readable.probe.relation, 'profiles');
      assert.deepStrictEqual(
        readable.probe.projection, ['id', 'email'],
        'the question comes back in the order it was asked, because the grant was signed over that order'
      );
      /* A default deadline, and a shorter one than a verification's: a policy
         is a far more ordinary thing to change in an afternoon than a key. */
      assert(Date.parse(readable.probe.freshnessDeadline) > Date.parse(readable.probe.observedAt));
      assert(
        Date.parse(readable.probe.freshnessDeadline) - Date.parse(readable.probe.observedAt) <= 24 * 60 * 60 * 1000,
        'a readability answer goes stale sooner than a credential answer'
      );

      /* A refused shape never reached the network and is recorded anyway: it
         says this server was asked to probe something it will not probe. */
      const refusedShape = await store.recordReadabilityProbe({
        scope, identityKey: IDENTITY, fingerprint: target, requestedBy: 'alice',
        record: {
          state: 'unverifiable', reason: 'relation-refused',
          projectRef: project, relation: 'auth.users', projection: ['*'],
          rowCount: 0,
          observedAt: new Date(base + 1000).toISOString()
        }
      });
      assert.strictEqual(refusedShape.probe.state, 'unverifiable');
      assert.strictEqual(
        refusedShape.probe.relation, null,
        'a relation this server refuses to ask about is not stored as though it had been asked'
      );
      assert.deepStrictEqual(refusedShape.probe.projection, []);

      const denied = await store.recordReadabilityProbe({
        scope, identityKey: IDENTITY, fingerprint: target, requestedBy: 'alice',
        record: {
          state: 'denied', reason: 'access-denied-for-tested-request',
          projectRef: project, relation: 'profiles', projection: ['id'],
          testedRole: 'publishable', rowCount: 0,
          observedAt: new Date(base + 2000).toISOString()
        }
      });
      assert.strictEqual(denied.probe.testedRole, 'publishable');

      const history = await store.listReadabilityProbes({
        scope, identityKey: IDENTITY, fingerprint: target, limit: 10
      });
      assert.deepStrictEqual(
        history.map(item => item.state), ['denied', 'unverifiable', 'readable'],
        'every probe is kept, and the order is the story'
      );

      /* And the finding is exactly where it was. */
      const untouched = await store.listFindings({ scope, identityKey: IDENTITY, limit: 20 });
      assert.strictEqual(
        untouched.find(item => item.fingerprint === target).disposition, 'credential-rejected',
        'a probe moves no disposition: the provider answer above is still the only thing that did'
      );

      /* A record disagreeing with itself is refused here, not at the database:
         the constraint violation would be unreadable. */
      await assert.rejects(
        store.recordReadabilityProbe({
          scope, identityKey: IDENTITY, fingerprint: target, requestedBy: 'alice',
          record: {
            state: 'denied', reason: 'access-denied-for-tested-request',
            projectRef: project, relation: 'profiles', projection: ['id'],
            testedRole: 'anon', rowCount: 1,
            observedAt: new Date(base + 3000).toISOString()
          }
        }),
        /row count must agree with its state/
      );

      /* A service-role answer is not the anonymous role's and is not storable
         as one. */
      await assert.rejects(
        store.recordReadabilityProbe({
          scope, identityKey: IDENTITY, fingerprint: target, requestedBy: 'alice',
          record: {
            state: 'denied', reason: 'key-not-anonymous',
            projectRef: project, relation: 'profiles', projection: ['id'],
            testedRole: 'service-role', rowCount: 0,
            observedAt: new Date(base + 4000).toISOString()
          }
        }),
        /tested role must be the anonymous role/
      );

      /* The identity boundary, here as everywhere. */
      await assert.rejects(
        store.recordReadabilityProbe({
          scope, identityKey: OTHER_IDENTITY, fingerprint: target, requestedBy: 'mallory',
          record: {
            state: 'denied', reason: 'access-denied-for-tested-request',
            projectRef: project, relation: 'profiles', projection: ['id'],
            testedRole: 'anon', rowCount: 0,
            observedAt: new Date(base + 5000).toISOString()
          }
        }),
        error => error.code === 'EXPOSURE_FINDING_NOT_FOUND' && error.status === 404
      );
      assert.deepStrictEqual(
        await store.listReadabilityProbes({ scope, identityKey: OTHER_IDENTITY, fingerprint: target, limit: 10 }),
        []
      );
    }

    /* ---- The latest answers, for a list that does not forget ------------ */

    /*
     * A screen showing only what was asked in this session is a screen that
     * forgets, and making a week-old answer reappear by asking again would
     * mean using somebody's credential a second time to redisplay a fact
     * already recorded. So the list carries the latest of each kind, in two
     * queries rather than two per finding.
     */
    {
      const one = fingerprint('one');
      const two = fingerprint('two');
      const answers = await store.latestAnswers({
        scope, identityKey: IDENTITY, fingerprints: [one, two, fingerprint('three')]
      });

      /* The latest, not the first: three verifications were recorded against
         `one` above and the newest is the rejection. */
      assert.strictEqual(answers.verifications[one].state, 'rejected');
      assert.strictEqual(answers.verifications[two].state, 'rejected');
      /* And the latest probe, which was the denial rather than the readable
         answer that preceded it. */
      assert.strictEqual(answers.probes[one].state, 'denied');
      assert.strictEqual(
        answers.probes[two], undefined,
        'a finding nobody probed has no probe, rather than an invented one'
      );
      assert.strictEqual(
        answers.verifications[fingerprint('three')], undefined,
        'and a finding nobody asked about has neither'
      );

      /* The identity boundary is in the query, as everywhere else here. */
      const stranger = await store.latestAnswers({
        scope, identityKey: OTHER_IDENTITY, fingerprints: [one, two]
      });
      assert.deepStrictEqual(stranger.verifications, {});
      assert.deepStrictEqual(stranger.probes, {});

      /* An empty or unusable list asks nothing rather than asking for
         everything. */
      assert.deepStrictEqual(
        await store.latestAnswers({ scope, identityKey: IDENTITY, fingerprints: [] }),
        { verifications: {}, probes: {} }
      );
      assert.deepStrictEqual(
        await store.latestAnswers({ scope, identityKey: IDENTITY, fingerprints: ['not-a-digest', ''] }),
        { verifications: {}, probes: {} }
      );
    }

    /* ---- The attempt table holds no credential either ------------------- */

    /* ---- No row, anywhere, can carry a credential ----------------------- */

    /*
     * The strong version of the claim: every value in every column of every
     * one of the three tables, dumped as text, searched for the synthetic
     * credential and for slices of it. Column names prove nothing -- this is
     * the whole table.
     */
    {
      const tables = ['nv_exposure_scans', 'nv_exposure_findings', 'nv_exposure_observations', 'nv_exposure_verifications', 'nv_exposure_readability_probes'];
      let cellsExamined = 0;
      for (const table of tables) {
        const dumped = await pool.query(`SELECT to_jsonb(row) AS row FROM ${table} AS row`);
        assert(dumped.rows.length > 0, `${table} must have rows for this sweep to mean anything`);
        for (const { row } of dumped.rows) {
          for (const [column, value] of Object.entries(row)) {
            cellsExamined += 1;
            const rendered = value == null ? '' : String(value);
            for (const probe of [SECRET, SECRET.slice(0, 12), SECRET.slice(4, 24), 'BEGIN PRIVATE KEY']) {
              assert.strictEqual(
                rendered.includes(probe), false,
                `${table}.${column} carries credential material: ${rendered.slice(0, 80)}`
              );
            }
          }
        }
      }
      assert(cellsExamined > 100, `the sweep must actually have examined rows: ${cellsExamined}`);

      /*
       * And the columns that could hold one are typed so that they cannot.
       * An integer array is the claim the schema makes rather than the
       * serializer -- so it is asserted as a type, against the live catalog.
       */
      const types = await pool.query(
        `SELECT table_name, column_name, data_type
           FROM information_schema.columns
          WHERE table_name LIKE 'nv_exposure%'
          ORDER BY table_name, column_name`
      );
      const typeOf = new Map(types.rows.map(row => [`${row.table_name}.${row.column_name}`, row.data_type]));
      assert.strictEqual(typeOf.get('nv_exposure_observations.occurrence_lines'), 'ARRAY');
      assert.strictEqual(typeOf.get('nv_exposure_observations.occurrence_columns'), 'ARRAY');
      const elements = await pool.query(
        `SELECT column_name, element_types.data_type AS element_type
           FROM information_schema.columns AS columns
           JOIN information_schema.element_types
             ON columns.dtd_identifier = element_types.collection_type_identifier
            AND element_types.object_name = columns.table_name
          WHERE columns.table_name='nv_exposure_observations'`
      );
      for (const row of elements.rows) {
        assert.strictEqual(row.element_type, 'integer', `${row.column_name} must be integers`);
      }

      /* No text column exists that a file's contents could be written to. */
      const textColumns = types.rows
        .filter(row => row.data_type === 'text')
        .map(row => `${row.table_name}.${row.column_name}`);
      const unbounded = [];
      /*
       * Every migration that defines one of these tables, not just the first.
       * The column list comes from the live catalog and spans all of them, so
       * reading one file made a column added later look unconstrained -- which
       * is how this check would have decayed into noise the moment somebody
       * added a table.
       */
      const sql = ['022_exposure_scans.sql', '023_exposure_verifications.sql', '024_exposure_readability_probes.sql']
        .map(file => require('fs').readFileSync(path.join(DIRECTORY, file), 'utf8'))
        .join('\n');
      for (const column of textColumns) {
        const name = column.split('.')[1];
        const constrained = new RegExp(`${name} text[^,]*CHECK`, 's').test(sql)
          || new RegExp(`CHECK \\(${name} `, 's').test(sql)
          || new RegExp(`CHECK \\(length\\(${name}\\)`, 's').test(sql)
          || new RegExp(`${name} IS NULL OR`, 's').test(sql);
        if (!constrained) unbounded.push(column);
      }
      assert.deepStrictEqual(
        unbounded, [],
        'every text column must be bounded or shape-constrained, or it is somewhere a file could be stored'
      );
    }

    console.log('exposure store tests passed');
  } finally {
    await pool.end();
    await withClient(ADMIN_URL, client => client.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`));
  }
})().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
