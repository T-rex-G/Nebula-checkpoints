'use strict';
/*
 * The evidence chain (Corona's application): a record appended under the
 * repository's lock, chained onto the last one with the ledger's key, a
 * record already written answered as it was, and the chain walked from its
 * genesis -- a broken link, a hash that does not reproduce, a record under a
 * retired key, an unmigrated chain, and a walk cut short -- against an
 * in-memory table that answers the statements the chain sends.
 */
const assert = require('assert');
const { EVIDENCE_GENESIS, EVIDENCE_VERIFY_LIMIT, createEvidenceChain, evidenceRecordHash } = require('../apps/api/src/modules/corona/index.ts');
const { hashJson } = require('../apps/api/src/platform/values/stable-hash.ts');

let finished = false;
process.on('exit', code => { if (!finished && code === 0) { console.error('the evidence chain tests did not finish'); process.exitCode = 1; } });

const LEDGER = `ledger-${'l'.repeat(40)}`;
const SESSION = `session-${'s'.repeat(40)}`;
const RETIRED = `retired-${'r'.repeat(40)}`;
const FORGER = `forger-${'f'.repeat(40)}`;
assert.strictEqual(EVIDENCE_GENESIS, 'NEBULAVERSE-EVIDENCE-GENESIS-V2');
assert.strictEqual(EVIDENCE_VERIFY_LIMIT, 5000);

function table(options = {}) {
  const rows = [];
  const calls = [];
  let seq = 0;
  let clients = 0;
  const clean = text => text.replace(/\s+/g, ' ').trim();
  const pool = {
    async query(text, values) {
      calls.push(['pool', clean(text), values]);
      if (text.startsWith('SELECT seq,kind,record_id')) {
        return { rows: rows.filter(row => row.repo_key === values[0]).slice(0, values[1]).map(({ repo_key: _, ...row }) => row) };
      }
      if (text.startsWith('SELECT count(*)::int')) {
        if (options.count) return options.count();
        return { rows: [{ total: rows.filter(row => row.repo_key === values[0]).length }] };
      }
      throw new Error(`unexpected ${text}`);
    },
    async connect() {
      calls.push(['connect']);
      const id = ++clients;
      return {
        async query(text, values) {
          calls.push([id, clean(text), values]);
          if (options.fail && options.fail(text)) throw new Error(`failed: ${clean(text).split(' ')[0]}`);
          if (text.includes('WHERE repo_key=$1 AND kind=$2 AND record_id=$3')) {
            const found = rows.find(row => row.repo_key === values[0] && row.kind === values[1] && row.record_id === values[2]);
            return { rows: found ? [{ seq: found.seq, created_at: found.created_at, previous_hash: found.previous_hash, record_hash: found.record_hash, payload_hash: found.payload_hash }] : [] };
          }
          if (text.startsWith('SELECT record_hash FROM nv_evidence_chain')) {
            const mine = rows.filter(row => row.repo_key === values[0]);
            return { rows: mine.length ? [{ record_hash: mine.at(-1).record_hash }] : [] };
          }
          if (text.startsWith('INSERT INTO nv_evidence_chain')) {
            const [repo_key, kind, record_id, previous_hash, record_hash, payload_hash] = values;
            seq += 1;
            rows.push({ seq, repo_key, kind, record_id, previous_hash, record_hash, payload_hash, created_at: `t${seq}` });
            return { rows: [{ seq, created_at: `t${seq}` }] };
          }
          return { rows: [] };
        },
        release() { calls.push(['release', id]); }
      };
    }
  };
  return { rows, calls, pool };
}

function chain({ ready = true, db = table(), keyring = { active: LEDGER, retired: [RETIRED] }, legacyProbe = { active: SESSION, retired: [] }, legacyAccepted = false } = {}) {
  let readiness = 0;
  const api = createEvidenceChain({
    ready: async () => { readiness += 1; return ready; },
    pool: () => db.pool,
    ledgerSecret: LEDGER, keyring, legacyProbe, legacyAccepted
  });
  return { ...api, db, readiness: () => readiness };
}

/* A record written directly, under any key, to build the chains verification reads. */
function write(db, repoKey, key, { kind = 'webhook', id, payload = { id }, previous, link } = {}) {
  const mine = db.rows.filter(row => row.repo_key === repoKey);
  const previousHash = previous === undefined ? (mine.length ? mine.at(-1).record_hash : EVIDENCE_GENESIS) : previous;
  const payloadHash = hashJson(payload);
  const seq = db.rows.length + 100;
  const row = {
    seq, repo_key: repoKey, kind, record_id: id, previous_hash: link === undefined ? previousHash : link,
    record_hash: evidenceRecordHash(key, previousHash, repoKey, kind, id, payloadHash), payload_hash: payloadHash, created_at: `w${seq}`
  };
  db.rows.push(row);
  return row;
}

(async () => {
  /* ---- Appending ------------------------------------------------------------------ */
  {
    const c = chain();
    const first = await c.appendEvidence('github:o/r:id', 'webhook', 'e1', { a: 1 });
    const payloadHash = hashJson({ a: 1 });
    const recordHash = evidenceRecordHash(LEDGER, EVIDENCE_GENESIS, 'github:o/r:id', 'webhook', 'e1', payloadHash);
    assert.deepStrictEqual(first, { seq: 1, created_at: 't1', previousHash: EVIDENCE_GENESIS, recordHash, payloadHash });
    assert.deepStrictEqual(c.db.calls, [
      ['connect'],
      [1, 'BEGIN', undefined],
      [1, 'SELECT pg_advisory_xact_lock(hashtext($1))', ['github:o/r:id']],
      [1, 'SELECT seq,created_at,previous_hash,record_hash,payload_hash FROM nv_evidence_chain WHERE repo_key=$1 AND kind=$2 AND record_id=$3 ORDER BY seq ASC LIMIT 1', ['github:o/r:id', 'webhook', 'e1']],
      [1, 'SELECT record_hash FROM nv_evidence_chain WHERE repo_key=$1 ORDER BY seq DESC LIMIT 1', ['github:o/r:id']],
      [1, 'INSERT INTO nv_evidence_chain(repo_key,kind,record_id,previous_hash,record_hash,payload_hash) VALUES($1,$2,$3,$4,$5,$6) RETURNING seq,created_at', ['github:o/r:id', 'webhook', 'e1', EVIDENCE_GENESIS, recordHash, payloadHash]],
      [1, 'COMMIT', undefined],
      ['release', 1]
    ]);
    const second = await c.appendEvidence('github:o/r:id', 'malware-blocked', 'e2', null);
    assert.strictEqual(second.previousHash, recordHash, 'each record chains onto the last');
    assert.strictEqual(second.payloadHash, hashJson(null));
    await c.appendEvidence('github:other/r:id', 'webhook', 'e1', { a: 1 });
    assert.strictEqual(c.db.rows[2].previous_hash, EVIDENCE_GENESIS, 'each repository has its own chain');

    const calls = c.db.calls.length;
    const again = await c.appendEvidence('github:o/r:id', 'webhook', 'e1', { a: 'changed' });
    assert.deepStrictEqual(again, { seq: 1, created_at: 't1', previous_hash: EVIDENCE_GENESIS, record_hash: recordHash, payload_hash: payloadHash, deduplicated: true }, 'a record already written is answered as written');
    assert.deepStrictEqual(c.db.calls.slice(calls), [['connect'], [4, 'BEGIN', undefined], [4, 'SELECT pg_advisory_xact_lock(hashtext($1))', ['github:o/r:id']], [4, c.db.calls[3][1], ['github:o/r:id', 'webhook', 'e1']], [4, 'COMMIT', undefined], ['release', 4]]);
    assert.strictEqual(c.db.rows.length, 3);

    const verified = await c.verifyEvidenceChain('github:o/r:id');
    assert.deepStrictEqual([verified.valid, verified.checked, verified.total, verified.complete, verified.head], [true, 2, 2, true, second.recordHash]);
  }
  {
    const off = chain({ ready: false });
    assert.strictEqual(await off.appendEvidence('k', 'webhook', 'e', {}), null);
    assert.deepStrictEqual(off.db.calls, [], 'no chain without a database');

    const failing = chain({ db: table({ fail: text => text.startsWith('INSERT') }) });
    await assert.rejects(failing.appendEvidence('k', 'webhook', 'e', {}), /failed: INSERT/);
    assert.deepStrictEqual(failing.db.calls.slice(-2), [[1, 'ROLLBACK', undefined], ['release', 1]]);
    const rollbackFails = chain({ db: table({ fail: text => text.startsWith('INSERT') || text === 'ROLLBACK' }) });
    await assert.rejects(rollbackFails.appendEvidence('k', 'webhook', 'e', {}), /failed: INSERT/, 'a failed rollback does not hide the failure');
    assert.deepStrictEqual(rollbackFails.db.calls.at(-1), ['release', 1]);
  }

  /* ---- Verifying ------------------------------------------------------------------ */
  {
    const off = chain({ ready: false });
    assert.deepStrictEqual(await off.verifyEvidenceChain('k'), { available: false, valid: false, complete: false, checked: 0, total: 0 });
    assert.deepStrictEqual(off.db.calls, []);

    const db = table();
    for (const id of ['a', 'b', 'c']) write(db, 'k', LEDGER, { id });
    const c = chain({ db });
    const whole = await c.verifyEvidenceChain('k');
    assert.deepStrictEqual(whole, {
      available: true, valid: true, complete: true, checked: 3, total: 3, head: db.rows[2].record_hash,
      legacyRecords: 0, legacyKeyRequired: false, records: db.rows.map(({ repo_key: _, ...row }) => row)
    });
    assert.deepStrictEqual(c.db.calls.slice(0, 2), [
      ['pool', 'SELECT seq,kind,record_id,previous_hash,record_hash,payload_hash,created_at FROM nv_evidence_chain WHERE repo_key=$1 ORDER BY seq ASC LIMIT $2', ['k', 1000]],
      ['pool', 'SELECT count(*)::int AS total FROM nv_evidence_chain WHERE repo_key=$1', ['k']]
    ]);
    const limits = [];
    for (const limit of [0, -3, 1, 2.5, 4999, 5000, 5001, 1e9]) {
      const before = c.db.calls.length;
      await c.verifyEvidenceChain('k', limit);
      limits.push(c.db.calls[before][2][1]);
    }
    assert.deepStrictEqual(limits, [1, 1, 1, 2.5, 4999, 5000, 5000, 5000], 'the walk reads 1 to 5,000 records');

    const partial = await c.verifyEvidenceChain('k', 2);
    assert.deepStrictEqual([partial.valid, partial.complete, partial.checked, partial.total, partial.head], [true, false, 2, 3, db.rows[1].record_hash], 'a walk cut short says so');

    const empty = await chain({ db: table() }).verifyEvidenceChain('k');
    assert.deepStrictEqual([empty.valid, empty.complete, empty.checked, empty.total, empty.head], [true, true, 0, 0, EVIDENCE_GENESIS]);
    for (const [answer, total] of [[{ rows: [{}] }, 0], [{ rows: [] }, 0], [{ rows: [{ total: null }] }, 0], [{ rows: [{ total: '2' }] }, 2]]) {
      const counted = await chain({ db: table({ count: async () => answer }) }).verifyEvidenceChain('k');
      assert.deepStrictEqual([counted.total, counted.complete], [total, total === 0], JSON.stringify(answer));
    }
  }
  {
    /* A record whose hash does not reproduce, its link intact. */
    const db = table();
    write(db, 'k', LEDGER, { id: 'a' });
    const bad = write(db, 'k', LEDGER, { id: 'b' });
    write(db, 'k', LEDGER, { id: 'c' });
    bad.payload_hash = hashJson({ changed: true });
    const result = await chain({ db }).verifyEvidenceChain('k');
    assert.deepStrictEqual(
      [result.valid, result.complete, result.checked, result.total, result.failedAt, result.legacyRecords, result.legacyKeyRequired, result.records.length, 'head' in result],
      [false, true, 2, 3, bad.seq, 0, false, 3, false]
    );
  }
  {
    /* A link that does not match, the hash reproducing over the walk. */
    const db = table();
    write(db, 'k', LEDGER, { id: 'a' });
    const broken = write(db, 'k', LEDGER, { id: 'b', link: 'f'.repeat(64) });
    const result = await chain({ db }).verifyEvidenceChain('k');
    assert.deepStrictEqual([result.valid, result.checked, result.failedAt, result.legacyKeyRequired], [false, 2, broken.seq, false]);
  }
  {
    /* Records under a retired key verify, and are counted. */
    const db = table();
    write(db, 'k', RETIRED, { id: 'a' });
    write(db, 'k', LEDGER, { id: 'b' });
    write(db, 'k', RETIRED, { id: 'c' });
    const result = await chain({ db }).verifyEvidenceChain('k');
    assert.deepStrictEqual([result.valid, result.legacyRecords, result.checked], [true, 2, 3]);
    const forged = table();
    write(forged, 'k', LEDGER, { id: 'a' });
    write(forged, 'k', FORGER, { id: 'b' });
    const refused = await chain({ db: forged }).verifyEvidenceChain('k');
    assert.deepStrictEqual([refused.valid, refused.checked, refused.legacyKeyRequired], [false, 2, false], 'a key nobody holds is tampering');
  }
  {
    /* A chain written under the session key, before the ledger had its own. */
    const db = table();
    write(db, 'k', LEDGER, { id: 'a' });
    const old = write(db, 'k', SESSION, { id: 'b' });
    const result = await chain({ db }).verifyEvidenceChain('k');
    assert.deepStrictEqual([result.valid, result.checked, result.failedAt, result.legacyKeyRequired, result.legacyRecords], [false, 2, old.seq, true, 0], 'an unmigrated chain says so');
    const accepted = await chain({ db, legacyAccepted: true }).verifyEvidenceChain('k');
    assert.deepStrictEqual([accepted.valid, accepted.legacyKeyRequired], [false, false], 'with the legacy key accepted, a failure is not blamed on migration');
    const acceptedInRing = await chain({ db, legacyAccepted: true, keyring: { active: LEDGER, retired: [RETIRED, SESSION] } }).verifyEvidenceChain('k');
    assert.deepStrictEqual([acceptedInRing.valid, acceptedInRing.legacyRecords], [true, 1]);

    const unlinked = table();
    write(unlinked, 'k', LEDGER, { id: 'a' });
    write(unlinked, 'k', SESSION, { id: 'b', link: 'e'.repeat(64) });
    const tampered = await chain({ db: unlinked }).verifyEvidenceChain('k');
    assert.deepStrictEqual([tampered.valid, tampered.legacyKeyRequired], [false, false], 'a broken link is tampering, whatever key the hash is under');
  }

  finished = true;
  console.log('Corona evidence chain tests passed');
})().catch(error => { finished = true; console.error(error); process.exit(1); });
