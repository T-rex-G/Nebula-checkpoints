'use strict';

/*
 * Triage against a real PostgreSQL server: a decision per finding of a
 * repository, replaced and taken back, every step kept as an event, and the
 * database refusing what the store would never write -- a note, a reason
 * off the list, an accepted risk without a date.
 */

const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const { Client, Pool } = require('pg');

const { loadMigrations, runMigrations } = require('../src/migrations');
const { CodeAuditTriage, LIMITS } = require('../src/code-audit-triage');

const DIRECTORY = path.join(__dirname, '..', 'db', 'migrations');
const ADMIN_URL = String(process.env.NV_TEST_DATABASE_URL || '').trim();
if (!ADMIN_URL) throw new Error('NV_TEST_DATABASE_URL is required: this gate runs triage against a real PostgreSQL server');

const scope = Object.freeze({ provider: 'github', authority: 'github.com', owner: 'Acme', repo: 'Shop' });
const other = Object.freeze({ ...scope, repo: 'Other' });
const ALICE = 'a'.repeat(64);
const BOB = 'b'.repeat(64);
const T0 = Date.parse('2026-09-20T10:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const id = seed => crypto.createHash('sha256').update(String(seed)).digest('hex').slice(0, 24);

async function withClient(connectionString, run) {
  const client = new Client({ connectionString });
  await client.connect();
  try { return await run(client); } finally { await client.end(); }
}

(async () => {
  const databaseName = `nvx_audit_triage_${crypto.randomBytes(6).toString('hex')}`;
  await withClient(ADMIN_URL, client => client.query(`CREATE DATABASE ${databaseName}`));
  const url = new URL(ADMIN_URL);
  url.pathname = `/${databaseName}`;
  const pool = new Pool({ connectionString: url.toString(), max: 4 });
  try {
    await withClient(url.toString(), client => runMigrations(client, loadMigrations(DIRECTORY)));
    const triage = new CodeAuditTriage({ pool });

    /* ---- A decision, with who and when, and its event ----------------------- */
    const fp = await triage.decide({
      scope, findingId: id('a'), rule: 'SEC-001', actor: 'alice', actorKey: ALICE, now: T0,
      input: { disposition: 'false-positive', reason: 'validated' }
    });
    assert.deepStrictEqual(fp, {
      findingId: id('a'), rule: 'SEC-001', disposition: 'false-positive', reason: 'validated',
      decidedBy: 'alice', decidedAt: new Date(T0).toISOString(), expiresAt: null
    });
    const accepted = await triage.decide({
      scope, findingId: id('b'), rule: 'DEP-003', actor: 'alpha:0123456789ab', actorKey: BOB, now: T0 + DAY,
      input: { disposition: 'accepted-risk', reason: 'fix-scheduled', expiresInDays: 30 }
    });
    assert.strictEqual(accepted.expiresAt, new Date(T0 + 31 * DAY).toISOString(), 'accepted for the days asked, from the day decided');
    assert.deepStrictEqual((await triage.list({ scope })).map(item => item.findingId), [id('b'), id('a')], 'newest first');
    assert.deepStrictEqual(await triage.list({ scope: other }), [], 'a decision belongs to its repository');
    const map = await triage.decisions({ scope });
    assert(map instanceof Map && map.get(id('a')).reason === 'validated');

    /* ---- What is refused before the database is asked ----------------------- */
    const refused = async (input, code, extra = {}) => assert.rejects(
      triage.decide({ scope, findingId: id('c'), rule: 'SEC-001', actor: 'alice', actorKey: ALICE, now: T0, input, ...extra }),
      error => error.code === code
    );
    await refused({ disposition: 'ignored', reason: 'validated' }, 'CODE_AUDIT_DISPOSITION_INVALID');
    await refused({ disposition: 'false-positive', reason: 'fix-scheduled' }, 'CODE_AUDIT_REASON_INVALID');
    await refused({ disposition: 'false-positive', reason: 'Because the code on line 3 says so' }, 'CODE_AUDIT_REASON_INVALID');
    await refused({ disposition: 'accepted-risk', reason: 'low-impact' }, 'CODE_AUDIT_EXPIRY_INVALID');
    await refused({ disposition: 'accepted-risk', reason: 'low-impact', expiresInDays: 400 }, 'CODE_AUDIT_EXPIRY_INVALID');
    await refused({ disposition: 'accepted-risk', reason: 'low-impact', expiresInDays: 3 }, 'CODE_AUDIT_EXPIRY_INVALID');
    await refused({ disposition: 'false-positive', reason: 'validated' }, 'CODE_AUDIT_FINDING_INVALID', { findingId: 'not-a-finding' });
    await refused({ disposition: 'false-positive', reason: 'validated' }, 'CODE_AUDIT_RULE_INVALID', { rule: 'sec-1' });
    await refused({ disposition: 'false-positive', reason: 'validated' }, 'CODE_AUDIT_ACTOR_INVALID', { actor: 'Robert"); DROP TABLE' });
    await assert.rejects(
      triage.decide({ scope, findingId: id('a'), rule: 'SEC-011', actor: 'alice', actorKey: ALICE, now: T0, input: { disposition: 'false-positive', reason: 'validated' } }),
      error => error.code === 'CODE_AUDIT_RULE_MISMATCH', 'an id is about one rule'
    );

    /* ---- Replacing a decision keeps one row and adds an event ---------------- */
    const changed = await triage.decide({
      scope, findingId: id('a'), rule: 'SEC-001', actor: 'bob', actorKey: BOB, now: T0 + 2 * DAY,
      input: { disposition: 'accepted-risk', reason: 'compensating-control', expiresInDays: 90 }
    });
    assert.deepStrictEqual([changed.disposition, changed.decidedBy], ['accepted-risk', 'bob']);
    assert.strictEqual((await triage.list({ scope })).length, 2);

    /* ---- Reopening takes it back, and says so -------------------------------- */
    const removed = await triage.reopen({ scope, findingId: id('a'), actor: 'alice', actorKey: ALICE, now: T0 + 3 * DAY });
    assert.strictEqual(removed.disposition, 'accepted-risk');
    assert.strictEqual(await triage.reopen({ scope, findingId: id('a'), actor: 'alice', actorKey: ALICE, now: T0 + 3 * DAY }), null, 'nothing to take back twice');
    const events = await triage.events({ scope, findingId: id('a') });
    assert.deepStrictEqual(events.map(event => [event.event, event.disposition, event.reason, event.actor]), [
      ['reopened', null, null, 'alice'],
      ['decided', 'accepted-risk', 'compensating-control', 'bob'],
      ['decided', 'false-positive', 'validated', 'alice']
    ]);
    assert.strictEqual(events[1].expiresAt, new Date(T0 + 92 * DAY).toISOString());
    assert(events.every(event => !('actorKey' in event) && !('actor_key' in event)), 'an event never carries the identity key');
    assert.deepStrictEqual(await triage.events({ scope: other, findingId: id('a') }), [], 'nor is it read through another repository');
    assert.deepStrictEqual(await triage.events({ scope, findingId: 'nonsense' }), []);

    /* ---- Lapsed acceptances and old events leave after the keeping window ---- */
    await triage.decide({ scope, findingId: id('z'), rule: 'SEC-001', actor: 'alice', actorKey: ALICE, now: T0 + 500 * DAY, input: { disposition: 'false-positive', reason: 'test-code' } });
    assert.deepStrictEqual((await triage.list({ scope })).map(item => item.findingId), [id('z')],
      'the acceptance that lapsed over a year ago is gone; a false positive stays');
    assert.deepStrictEqual(await triage.events({ scope, findingId: id('a') }), [], 'so are events past the window');
    assert.strictEqual(LIMITS.keepMs, 400 * DAY);

    /* ---- A repository holds a bounded number of decisions --------------------- */
    {
      const tight = new CodeAuditTriage({ pool, limits: { maxDecisions: 2 } });
      const small = { ...scope, repo: 'Small' };
      for (const seed of ['p', 'q']) {
        await tight.decide({ scope: small, findingId: id(seed), rule: 'SEC-001', actor: 'alice', actorKey: ALICE, now: T0, input: { disposition: 'false-positive', reason: 'misread' } });
      }
      await assert.rejects(
        tight.decide({ scope: small, findingId: id('r'), rule: 'SEC-001', actor: 'alice', actorKey: ALICE, now: T0, input: { disposition: 'false-positive', reason: 'misread' } }),
        error => error.code === 'CODE_AUDIT_TRIAGE_LIMIT'
      );
      /* Changing one of them is still allowed at the limit. */
      await tight.decide({ scope: small, findingId: id('p'), rule: 'SEC-001', actor: 'bob', actorKey: BOB, now: T0, input: { disposition: 'false-positive', reason: 'not-reachable' } });
    }

    /* ---- The database refuses what the store would never write ------------- */
    const insert = (values) => pool.query(
      `INSERT INTO nv_code_audit_triage (provider, authority, owner_login, repo_name, finding_id, rule, disposition, reason, decided_by, decided_by_key, decided_at, expires_at)
       VALUES ('github', 'github.com', 'Acme', 'Raw', $1, $2, $3, $4, $5, $6, $7, $8)`, values);
    const now = new Date(T0).toISOString();
    await assert.rejects(insert([id('x'), 'SEC-001', 'false-positive', 'the code on line 3 is fine', 'alice', ALICE, now, null]), /check constraint/, 'no free text');
    await assert.rejects(insert([id('x'), 'SEC-001', 'false-positive', 'fix-scheduled', 'alice', ALICE, now, null]), /check constraint/, 'a reason belongs to its disposition');
    await assert.rejects(insert([id('x'), 'SEC-001', 'accepted-risk', 'low-impact', 'alice', ALICE, now, null]), /check constraint/, 'an accepted risk has a date');
    await assert.rejects(insert([id('x'), 'SEC-001', 'false-positive', 'misread', 'alice', ALICE, now, now]), /check constraint/, 'a false positive does not');
    await assert.rejects(insert([id('x'), 'SEC-001', 'false-positive', 'misread', 'a name with spaces', ALICE, now, null]), /check constraint/, 'the actor is a login');
    await assert.rejects(insert(['short', 'SEC-001', 'false-positive', 'misread', 'alice', ALICE, now, null]), /check constraint/);

    /* ---- Account purge: the statements the privacy store runs ---------------- */
    await pool.query('DELETE FROM nv_code_audit_triage WHERE decided_by_key=ANY($1::text[])', [[ALICE]]);
    await pool.query('DELETE FROM nv_code_audit_triage_events WHERE actor_key=ANY($1::text[])', [[ALICE]]);
    const left = await pool.query('SELECT decided_by FROM nv_code_audit_triage ORDER BY decided_by');
    assert(left.rows.every(row => row.decided_by !== 'alice'), 'a purged tester\'s decisions leave with them');
    assert.strictEqual((await pool.query(`SELECT count(*)::int AS n FROM nv_code_audit_triage_events WHERE actor='alice'`)).rows[0].n, 0);
    assert((await pool.query(`SELECT count(*)::int AS n FROM nv_code_audit_triage WHERE decided_by='bob'`)).rows[0].n > 0, 'another tester\'s stay');

    console.log('code audit triage store tests passed');
  } finally {
    await pool.end();
    await withClient(ADMIN_URL, client => client.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`));
  }
})().catch(error => { console.error(error); process.exit(1); });
