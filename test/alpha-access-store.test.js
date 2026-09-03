'use strict';

const assert = require('assert');
const {
  AlphaAccessStore,
  GENERIC_REDEMPTION_ERROR
} = require('../src/alpha-access-store');

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const PEPPER = '0123456789abcdef0123456789abcdef';
const SCOPE = 'github:github.com/acme/demo';
const TERMS = '2026-07-29';
const ALLOWED_ERROR_CODES = new Set([
  'ALPHA_ACCESS_REQUIRED',
  'ALPHA_SESSION_EXPIRED',
  'ALPHA_ACCESS_REVOKED',
  'ALPHA_INVITE_REJECTED',
  'ALPHA_REDEMPTION_LOCKED'
]);

function cloneState(state) {
  return structuredClone(state);
}

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

function pgFailure(message = 'terminating connection due to administrator command') {
  return Object.assign(new Error(message), { code: '57P01' });
}

class FakeDatabase {
  constructor() {
    this.state = {
      invites: new Map(),
      testers: new Map(),
      sessions: new Map(),
      locks: new Map()
    };
    this.calls = [];
    this.releaseCount = 0;
    this.failure = null;
    this.zeroResult = null;
    this.advisoryLocks = new Map();
    this.pool = {
      query: (sql, params = []) => this.query(sql, params, 'pool'),
      connect: async () => this.connect()
    };
  }

  failNext(pattern, error = pgFailure()) {
    this.failure = {
      pattern,
      error: typeof error === 'string' ? new Error(error) : error
    };
  }

  returnZeroNext(pattern) {
    this.zeroResult = pattern;
  }

  async acquireAdvisory(key) {
    let entry = this.advisoryLocks.get(key);
    if (!entry) {
      entry = { held: false, waiters: [] };
      this.advisoryLocks.set(key, entry);
    }
    if (entry.held) {
      await new Promise(resolve => entry.waiters.push(resolve));
    } else {
      entry.held = true;
    }
    let released = false;
    return () => {
      assert.strictEqual(released, false, 'advisory lock must release once');
      released = true;
      const next = entry.waiters.shift();
      if (next) {
        next();
      } else {
        entry.held = false;
        this.advisoryLocks.delete(key);
      }
    };
  }

  connect() {
    let snapshot = null;
    let released = false;
    const heldAdvisoryLocks = [];
    const releaseAdvisoryLocks = () => {
      while (heldAdvisoryLocks.length) heldAdvisoryLocks.pop()();
    };
    return {
      query: async (sql, params = []) => {
        const text = String(sql).trim();
        if (text === 'BEGIN') snapshot = cloneState(this.state);
        if (normalizeSql(sql) ===
          'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))') {
          heldAdvisoryLocks.push(
            await this.acquireAdvisory(`admission:${params[0]}`)
          );
          snapshot = cloneState(this.state);
        }
        if (
          normalizeSql(sql).startsWith('SELECT invite_id, secret_digest')
          && normalizeSql(sql).endsWith('FOR UPDATE')
        ) {
          heldAdvisoryLocks.push(
            await this.acquireAdvisory(`invite:${params[0]}`)
          );
          snapshot = cloneState(this.state);
        }
        try {
          const result = await this.query(sql, params, 'client');
          if (text === 'COMMIT') {
            snapshot = null;
            releaseAdvisoryLocks();
          }
          if (text === 'ROLLBACK' && snapshot) {
            this.state = snapshot;
            snapshot = null;
            releaseAdvisoryLocks();
          }
          return result;
        } catch (error) {
          throw error;
        }
      },
      release: () => {
        assert.strictEqual(released, false, 'transaction client must release exactly once');
        assert.strictEqual(
          heldAdvisoryLocks.length,
          0,
          'transaction-scoped advisory locks must release before the client'
        );
        released = true;
        this.releaseCount += 1;
      }
    };
  }

  async query(sql, params = [], channel = 'pool') {
    const text = String(sql);
    const normalized = normalizeSql(text);
    this.calls.push({ sql: text, params: [...params], channel });

    if (
      this.failure
      && (
        typeof this.failure.pattern === 'string'
          ? normalized.includes(this.failure.pattern)
          : this.failure.pattern.test(normalized)
      )
    ) {
      const { error } = this.failure;
      this.failure = null;
      throw error;
    }
    if (
      this.zeroResult
      && (
        typeof this.zeroResult === 'string'
          ? normalized.includes(this.zeroResult)
          : this.zeroResult.test(normalized)
      )
    ) {
      this.zeroResult = null;
      return { rows: [], rowCount: 0 };
    }

    if (normalized === 'BEGIN' || normalized === 'COMMIT' || normalized === 'ROLLBACK') {
      return { rows: [], rowCount: 0 };
    }

    if (normalized ===
      'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))') {
      return { rows: [{ pg_advisory_xact_lock: null }], rowCount: 1 };
    }

    if (normalized.startsWith('INSERT INTO nv_alpha_invites')) {
      const [
        inviteId,
        secretDigest,
        testerLabel,
        repositoryScopes,
        termsVersion,
        createdAt,
        expiresAt
      ] = params;
      if (this.state.invites.has(inviteId)) {
        const error = new Error('duplicate invite id');
        error.code = '23505';
        throw error;
      }
      this.state.invites.set(inviteId, {
        invite_id: inviteId,
        secret_digest: secretDigest,
        tester_label: testerLabel,
        repository_scopes: [...repositoryScopes],
        terms_version: termsVersion,
        created_at: createdAt,
        expires_at: expiresAt,
        redeemed_at: null,
        revoked_at: null,
        metadata_purged_at: null
      });
      return { rows: [], rowCount: 1 };
    }

    if (
      normalized.startsWith('SELECT invite_id, secret_digest')
      && normalized.includes('FROM nv_alpha_invites')
    ) {
      const row = this.state.invites.get(params[0]);
      return { rows: row ? [cloneState(row)] : [], rowCount: row ? 1 : 0 };
    }

    if (normalized.startsWith('INSERT INTO nv_alpha_testers')) {
      const [
        testerId,
        inviteId,
        testerLabel,
        repositoryScopes,
        termsVersion,
        acceptedAt
      ] = params;
      this.state.testers.set(testerId, {
        tester_id: testerId,
        invite_id: inviteId,
        tester_label: testerLabel,
        repository_scopes: [...repositoryScopes],
        terms_version: termsVersion,
        terms_accepted_at: acceptedAt,
        created_at: acceptedAt,
        revoked_at: null,
        revocation_reason: '',
        metadata_purged_at: null
      });
      return { rows: [], rowCount: 1 };
    }

    if (
      normalized.startsWith('SELECT invite_id, redeemed_at')
      && normalized.includes('FROM nv_alpha_invites')
    ) {
      const row = this.state.invites.get(params[0]);
      return { rows: row ? [cloneState(row)] : [], rowCount: row ? 1 : 0 };
    }

    if (normalized.startsWith('UPDATE nv_alpha_invites SET revoked_at')) {
      const invite = this.state.invites.get(params[0]);
      if (!invite) return { rows: [], rowCount: 0 };
      invite.revoked_at = params[1];
      return { rows: [], rowCount: 1 };
    }

    if (normalized.startsWith('UPDATE nv_alpha_invites SET redeemed_at')) {
      const invite = this.state.invites.get(params[0]);
      if (
        !invite
        || invite.redeemed_at
        || invite.revoked_at
        || (normalized.includes('metadata_purged_at IS NULL') && invite.metadata_purged_at)
      ) return { rows: [], rowCount: 0 };
      invite.redeemed_at = params[1];
      return { rows: [], rowCount: 1 };
    }

    if (normalized.startsWith('INSERT INTO nv_alpha_sessions')) {
      const [sessionId, testerId, createdAt, expiresAt] = params;
      this.state.sessions.set(sessionId, {
        session_id: sessionId,
        tester_id: testerId,
        created_at: createdAt,
        last_seen_at: createdAt,
        expires_at: expiresAt,
        revoked_at: null
      });
      return { rows: [], rowCount: 1 };
    }

    if (
      normalized.startsWith('SELECT s.session_id')
      && normalized.includes('FROM nv_alpha_sessions s')
    ) {
      const session = this.state.sessions.get(params[0]);
      const tester = session && this.state.testers.get(session.tester_id);
      if (!session || !tester) return { rows: [], rowCount: 0 };
      return {
        rows: [{
          ...cloneState(session),
          tester_label: tester.tester_label,
          repository_scopes: tester.repository_scopes && [...tester.repository_scopes],
          terms_version: tester.terms_version,
          tester_revoked_at: tester.revoked_at,
          tester_metadata_purged_at: tester.metadata_purged_at
        }],
        rowCount: 1
      };
    }

    if (normalized.startsWith('UPDATE nv_alpha_sessions SET last_seen_at')) {
      const session = this.state.sessions.get(params[0]);
      if (!session || session.last_seen_at > params[2]) return { rows: [], rowCount: 0 };
      session.last_seen_at = params[1];
      return { rows: [], rowCount: 1 };
    }

    if (
      normalized.startsWith('SELECT ip_hash, window_started_at')
      && normalized.includes('FROM nv_alpha_redemption_locks')
    ) {
      const lock = this.state.locks.get(params[0]);
      return { rows: lock ? [cloneState(lock)] : [], rowCount: lock ? 1 : 0 };
    }

    if (normalized.startsWith('INSERT INTO nv_alpha_redemption_locks')) {
      const [ipHash, now, windowMs, threshold, lockMs] = params;
      const existing = this.state.locks.get(ipHash);
      const windowExpired = existing
        && now.getTime() - existing.window_started_at.getTime() >= windowMs;
      let row;
      if (!existing || windowExpired) {
        row = {
          ip_hash: ipHash,
          window_started_at: now,
          failed_count: 1,
          locked_until: null
        };
      } else {
        const failedCount = Math.min(existing.failed_count + 1, 1000);
        row = {
          ...existing,
          failed_count: failedCount,
          locked_until: existing.locked_until && existing.locked_until > now
            ? existing.locked_until
            : failedCount >= threshold
              ? new Date(now.getTime() + lockMs)
              : null
        };
      }
      this.state.locks.set(ipHash, row);
      return { rows: [cloneState(row)], rowCount: 1 };
    }

    if (normalized.startsWith('DELETE FROM nv_alpha_redemption_locks WHERE ip_hash')) {
      const deleted = this.state.locks.delete(params[0]);
      return { rows: [], rowCount: deleted ? 1 : 0 };
    }

    if (normalized.startsWith('SELECT tester_id FROM nv_alpha_testers')) {
      const tester = this.state.testers.get(params[0]);
      if (
        tester
        && tester.metadata_purged_at
        && normalized.includes('metadata_purged_at IS NULL')
      ) return { rows: [], rowCount: 0 };
      return { rows: tester ? [{ tester_id: tester.tester_id }] : [], rowCount: tester ? 1 : 0 };
    }

    if (normalized.startsWith('UPDATE nv_alpha_testers SET revoked_at')) {
      const tester = this.state.testers.get(params[0]);
      if (!tester || tester.revoked_at) return { rows: [], rowCount: 0 };
      tester.revoked_at = params[1];
      tester.revocation_reason = params[2];
      return { rows: [], rowCount: 1 };
    }

    if (normalized.startsWith('UPDATE nv_alpha_sessions SET revoked_at')) {
      let count = 0;
      for (const session of this.state.sessions.values()) {
        if (session.tester_id === params[0] && !session.revoked_at) {
          session.revoked_at = params[1];
          count += 1;
        }
      }
      return { rows: [], rowCount: count };
    }

    if (normalized.includes('DELETE FROM nv_alpha_sessions target')) {
      return this.deleteBounded(
        'sessions',
        params[0],
        row => row.expires_at <= params[1]
          || row.last_seen_at <= params[2]
      );
    }

    if (normalized.includes('DELETE FROM nv_alpha_invites target')) {
      return this.deleteBounded(
        'invites',
        params[0],
        row => !row.redeemed_at && row.expires_at <= params[1]
      );
    }

    if (normalized.includes('DELETE FROM nv_alpha_redemption_locks target')) {
      return this.deleteBounded(
        'locks',
        params[0],
        row => row.window_started_at <= params[1]
          && (!row.locked_until || row.locked_until <= params[2])
      );
    }

    throw new Error(`FakeDatabase received unexpected SQL: ${normalized}`);
  }

  deleteBounded(collection, limit, predicate) {
    const rows = this.state[collection];
    let count = 0;
    for (const [key, row] of rows) {
      if (count >= limit) break;
      if (predicate(row)) {
        rows.delete(key);
        count += 1;
      }
    }
    return { rows: [], rowCount: count };
  }
}

function fixedRandomBytes() {
  let call = 0;
  return size => {
    call += 1;
    return Buffer.alloc(size, call);
  };
}

function fixedRandomUUID() {
  let call = 0;
  return () => {
    call += 1;
    return `00000000-0000-4000-8000-${String(call).padStart(12, '0')}`;
  };
}

function createFixture(options = {}) {
  const fake = new FakeDatabase();
  const clock = {
    value: new Date('2026-07-29T12:00:00.000Z')
  };
  const store = new AlphaAccessStore({
    pool: fake.pool,
    pepper: PEPPER,
    now: () => new Date(clock.value),
    randomBytes: fixedRandomBytes(),
    randomUUID: fixedRandomUUID(),
    ...options
  });
  return { fake, clock, store };
}

function advance(clock, milliseconds) {
  clock.value = new Date(clock.value.getTime() + milliseconds);
}

function errorShape(error) {
  assert(ALLOWED_ERROR_CODES.has(error.code), `unexpected alpha error code: ${error.code}`);
  return { message: error.message, code: error.code, status: error.status };
}

async function rejectionShape(callback) {
  try {
    await callback();
    assert.fail('expected rejection');
  } catch (error) {
    if (error.code === 'ERR_ASSERTION') throw error;
    return errorShape(error);
  }
}

async function issue(store, overrides = {}) {
  return store.issueInvite({
    testerLabel: 'Tester 01',
    repositoryScopes: [SCOPE, SCOPE],
    termsVersion: TERMS,
    ...overrides
  });
}

async function redeem(store, invitation, overrides = {}) {
  return store.redeemInvite({
    code: invitation.code,
    termsVersion: TERMS,
    ip: '203.0.113.10',
    ...overrides
  });
}

async function infrastructureRejection(callback, forbiddenFragments = []) {
  try {
    await callback();
    assert.fail('expected infrastructure rejection');
  } catch (error) {
    if (error.code === 'ERR_ASSERTION') throw error;
    assert.strictEqual(error.name, 'AlphaAccessOperationalError');
    assert.strictEqual(error.message, 'Alpha access operation could not be completed');
    assert.strictEqual(error.code, undefined, 'raw pg code must not be public');
    assert(!/terminating connection|administrator|synthetic/i.test(error.message));
    for (const fragment of forbiddenFragments) {
      assert(
        !error.message.includes(fragment),
        'operational message must not expose dependency detail'
      );
      assert(
        !String(error.stack || '').includes(fragment),
        'operational stack must not expose dependency detail'
      );
    }
    return error;
  }
}

async function main() {
  const { fake, clock, store } = createFixture();

  const invitation = await issue(store);
  assert.strictEqual(invitation.code.startsWith('nvx_alpha_'), true);
  assert.strictEqual(invitation.repositoryScopes[0], SCOPE);
  assert.strictEqual(invitation.repositoryScopes.length, 1, 'canonical scopes must be de-duplicated');
  assert.strictEqual(
    invitation.expiresAt,
    '2026-08-05T12:00:00.000Z',
    'default invitation TTL must be seven days'
  );
  const secret = invitation.code.slice(invitation.code.indexOf('.') + 1);
  assert(!JSON.stringify([...fake.state.invites.values()]).includes(invitation.code), 'plaintext code must not be persisted');
  assert(!JSON.stringify([...fake.state.invites.values()]).includes(secret), 'plaintext secret must not be persisted');
  assert(!JSON.stringify(fake.calls).includes(invitation.code), 'plaintext code must not appear in SQL calls');
  assert(!JSON.stringify(fake.calls).includes(secret), 'plaintext secret must not appear in SQL calls');
  assert.match([...fake.state.invites.values()][0].secret_digest, /^[0-9a-f]{64}$/);
  assert(fake.calls.every(call => !call.sql.includes(invitation.inviteId)), 'SQL must use parameters, not interpolated identifiers');

  await assert.rejects(
    () => issue(store, { testerLabel: '  ' }),
    error => error instanceof TypeError && /tester label/i.test(error.message)
  );
  await assert.rejects(
    () => issue(store, { repositoryScopes: [] }),
    error => error instanceof TypeError && /1-20 repository scopes/i.test(error.message)
  );
  await assert.rejects(
    () => issue(store, {
      repositoryScopes: ['github:evil.example/acme/demo']
    }),
    error => error instanceof TypeError
      && error.code === undefined
      && /valid canonical repository scopes/i.test(error.message),
    'operator input validation must not expand the public access error vocabulary'
  );
  await assert.rejects(
    () => issue(store, { termsVersion: 'latest' }),
    error => error instanceof TypeError && /terms version/i.test(error.message)
  );
  assert.throws(
    () => createFixture({ sessionTtlMs: 7 * DAY_MS + 1 }),
    /sessionTtlMs/
  );
  assert.throws(
    () => createFixture({ idleTtlMs: DAY_MS + 1 }),
    /idleTtlMs/
  );
  const directFailureFixture = createFixture();
  directFailureFixture.fake.failNext(
    'INSERT INTO nv_alpha_invites',
    pgFailure('direct query leaked administrator shutdown detail')
  );
  await infrastructureRejection(() => issue(directFailureFixture.store));
  const directTypeFixture = createFixture();
  const directTypeSecret = 'nvx_alpha_direct_driver_secret';
  directTypeFixture.fake.failNext(
    'INSERT INTO nv_alpha_invites',
    new TypeError(`driver coercion leaked ${directTypeSecret}`)
  );
  await infrastructureRejection(
    () => issue(directTypeFixture.store),
    [directTypeSecret]
  );
  await assert.rejects(
    () => issue(store, { testerLabel: '' }),
    error => error instanceof TypeError
      && error.name === 'TypeError'
      && error.message === 'tester label must contain 1-120 characters',
    'validated operator input TypeErrors must remain specific'
  );

  const redeemed = await redeem(store, invitation);
  assert.strictEqual(redeemed.tester.repositoryScopes[0], SCOPE);
  assert.strictEqual(redeemed.tester.termsVersion, TERMS);
  assert.strictEqual(redeemed.expiresAt, '2026-08-05T12:00:00.000Z');
  assert(fake.calls.some(call => /FOR UPDATE/.test(call.sql)), 'redemption must lock invite state');
  assert(fake.calls.some(call => call.sql.trim() === 'BEGIN'));
  assert(fake.calls.some(call => call.sql.trim() === 'COMMIT'));

  const generic = {
    message: GENERIC_REDEMPTION_ERROR,
    code: 'ALPHA_INVITE_REJECTED',
    status: 403
  };
  assert.deepStrictEqual(await rejectionShape(() => redeem(store, invitation)), generic, 'replay must be generic');
  assert.deepStrictEqual(
    await rejectionShape(() => store.redeemInvite({
      code: 'malformed',
      termsVersion: TERMS,
      ip: '203.0.113.10'
    })),
    generic,
    'malformed invitation must be indistinguishable'
  );
  assert.deepStrictEqual(
    await rejectionShape(() => store.redeemInvite({
      code: `nvx_alpha_${'a'.repeat(26)}.${'B'.repeat(43)}`,
      termsVersion: TERMS,
      ip: '203.0.113.10'
    })),
    generic,
    'unknown invitation must be indistinguishable'
  );

  const expiredFixture = createFixture();
  const expiredInvite = await issue(expiredFixture.store);
  advance(expiredFixture.clock, 7 * DAY_MS + 1);
  assert.deepStrictEqual(
    await rejectionShape(() => redeem(expiredFixture.store, expiredInvite)),
    generic,
    'expired invitation must be indistinguishable'
  );

  const revokedFixture = createFixture();
  const revokedInvite = await issue(revokedFixture.store);
  revokedFixture.fake.state.invites.get(revokedInvite.inviteId).revoked_at =
    new Date(revokedFixture.clock.value);
  assert.deepStrictEqual(
    await rejectionShape(() => redeem(revokedFixture.store, revokedInvite)),
    generic,
    'revoked invitation must be indistinguishable'
  );

  const termsFixture = createFixture();
  const termsInvite = await issue(termsFixture.store);
  assert.deepStrictEqual(
    await rejectionShape(() => redeem(termsFixture.store, termsInvite, {
      termsVersion: '2026-07-29.2'
    })),
    generic,
    'terms mismatch must be indistinguishable'
  );

  const rollbackFixture = createFixture();
  const rollbackInvite = await issue(rollbackFixture.store);
  rollbackFixture.fake.failNext('INSERT INTO nv_alpha_sessions');
  await infrastructureRejection(
    () => redeem(rollbackFixture.store, rollbackInvite)
  );
  assert.strictEqual(
    rollbackFixture.fake.state.invites.get(rollbackInvite.inviteId).redeemed_at,
    null,
    'failed redemption must roll back the invite'
  );
  assert.strictEqual(rollbackFixture.fake.state.testers.size, 0, 'failed redemption must roll back tester creation');
  assert(rollbackFixture.fake.calls.some(call => call.sql.trim() === 'ROLLBACK'));
  assert.strictEqual(rollbackFixture.fake.releaseCount, 1, 'failed transaction must release its client');
  const redeemedAfterRollback = await redeem(rollbackFixture.store, rollbackInvite);
  assert(redeemedAfterRollback.sessionId, 'rolled-back invitation must remain redeemable');

  const transactionTypeFixture = createFixture();
  const transactionTypeInvite = await issue(transactionTypeFixture.store);
  const transactionTypeSecret = 'nvx_alpha_transaction_driver_secret';
  transactionTypeFixture.fake.failNext(
    'INSERT INTO nv_alpha_sessions',
    new TypeError(`client decoder leaked ${transactionTypeSecret}`)
  );
  await infrastructureRejection(
    () => redeem(transactionTypeFixture.store, transactionTypeInvite),
    [transactionTypeSecret]
  );
  assert.strictEqual(
    transactionTypeFixture.fake.state.invites
      .get(transactionTypeInvite.inviteId).redeemed_at,
    null,
    'transactional driver TypeError must roll back invite redemption'
  );
  assert.strictEqual(
    transactionTypeFixture.fake.state.testers.size,
    0,
    'transactional driver TypeError must roll back tester creation'
  );
  assert(
    transactionTypeFixture.fake.calls.some(
      call => call.sql.trim() === 'ROLLBACK'
    )
  );

  const conditionalFixture = createFixture();
  const conditionalInvite = await issue(conditionalFixture.store);
  conditionalFixture.fake.returnZeroNext(
    'UPDATE nv_alpha_invites SET redeemed_at'
  );
  await infrastructureRejection(
    () => redeem(conditionalFixture.store, conditionalInvite)
  );
  assert.strictEqual(
    conditionalFixture.fake.state.invites
      .get(conditionalInvite.inviteId).redeemed_at,
    null,
    'a failed conditional invite update must roll back'
  );
  assert.strictEqual(
    conditionalFixture.fake.state.testers.size,
    0,
    'a failed conditional invite update must not commit a tester'
  );

  const session = await store.readSession(redeemed.sessionId);
  assert.deepStrictEqual(session, {
    testerId: redeemed.tester.testerId,
    testerLabel: 'Tester 01',
    repositoryScopes: [SCOPE],
    termsVersion: TERMS,
    expiresAt: '2026-08-05T12:00:00.000Z'
  });
  const touchesBefore = fake.calls.filter(call => /SET last_seen_at/.test(call.sql)).length;
  advance(clock, 4 * MINUTE_MS);
  await store.readSession(redeemed.sessionId);
  assert.strictEqual(
    fake.calls.filter(call => /SET last_seen_at/.test(call.sql)).length,
    touchesBefore,
    'session must not be touched before five minutes'
  );
  advance(clock, MINUTE_MS);
  await store.readSession(redeemed.sessionId);
  assert.strictEqual(
    fake.calls.filter(call => /SET last_seen_at/.test(call.sql)).length,
    touchesBefore + 1,
    'session must touch at the five-minute boundary'
  );

  const nonTouchFixture = createFixture();
  const nonTouchInvite = await issue(nonTouchFixture.store);
  const nonTouchRedemption = await redeem(
    nonTouchFixture.store,
    nonTouchInvite
  );
  const nonTouchCreatedAt = new Date(nonTouchFixture.clock.value);
  advance(nonTouchFixture.clock, 5 * MINUTE_MS);
  await nonTouchFixture.store.readSession(
    nonTouchRedemption.sessionId,
    { touch: false }
  );
  assert.strictEqual(
    nonTouchFixture.fake.calls.filter(
      call => /SET last_seen_at/.test(call.sql)
    ).length,
    0,
    'non-touch session validation must not issue the last-seen UPDATE'
  );
  assert.strictEqual(
    nonTouchFixture.fake.state.sessions
      .get(nonTouchRedemption.sessionId).last_seen_at.toISOString(),
    nonTouchCreatedAt.toISOString(),
    'non-touch validation must not extend the idle-expiry boundary'
  );
  await nonTouchFixture.store.readSession(nonTouchRedemption.sessionId);
  assert.strictEqual(
    nonTouchFixture.fake.calls.filter(
      call => /SET last_seen_at/.test(call.sql)
    ).length,
    1,
    'ordinary request validation must still touch at the same timing boundary'
  );
  assert.strictEqual(
    nonTouchFixture.fake.state.sessions
      .get(nonTouchRedemption.sessionId).last_seen_at.toISOString(),
    nonTouchFixture.clock.value.toISOString(),
    'ordinary request validation must extend the idle-expiry boundary'
  );

  const idleFixture = createFixture();
  const idleInvite = await issue(idleFixture.store);
  const idleRedemption = await redeem(idleFixture.store, idleInvite);
  advance(idleFixture.clock, DAY_MS);
  assert.deepStrictEqual(
    await rejectionShape(() => idleFixture.store.readSession(idleRedemption.sessionId)),
    {
      message: 'Alpha session expired',
      code: 'ALPHA_SESSION_EXPIRED',
      status: 401
    },
    'idle expiry must apply at 24 hours'
  );

  const absoluteFixture = createFixture();
  const absoluteInvite = await issue(absoluteFixture.store);
  const absoluteRedemption = await redeem(absoluteFixture.store, absoluteInvite);
  const absoluteRow = absoluteFixture.fake.state.sessions.get(absoluteRedemption.sessionId);
  absoluteRow.last_seen_at = new Date(
    absoluteFixture.clock.value.getTime() + 7 * DAY_MS - MINUTE_MS
  );
  advance(absoluteFixture.clock, 7 * DAY_MS);
  assert.deepStrictEqual(
    await rejectionShape(() => absoluteFixture.store.readSession(absoluteRedemption.sessionId)),
    {
      message: 'Alpha session expired',
      code: 'ALPHA_SESSION_EXPIRED',
      status: 401
    },
    'absolute expiry must not be extended by activity'
  );

  assert.deepStrictEqual(
    await rejectionShape(() => store.readSession('not-a-session')),
    {
      message: 'Alpha access is required',
      code: 'ALPHA_ACCESS_REQUIRED',
      status: 401
    }
  );

  const revokeFixture = createFixture();
  const revokeInvite = await issue(revokeFixture.store);
  const revokeRedemption = await redeem(revokeFixture.store, revokeInvite);
  const revoked = await revokeFixture.store.revokeTester(
    revokeRedemption.tester.testerId,
    'cohort access ended'
  );
  assert.strictEqual(revoked.sessionsRevoked, 1);
  assert.deepStrictEqual(
    await rejectionShape(() => revokeFixture.store.readSession(revokeRedemption.sessionId)),
    {
      message: 'Alpha access was revoked',
      code: 'ALPHA_ACCESS_REVOKED',
      status: 403
    }
  );

  const revokeRollbackFixture = createFixture();
  const revokeRollbackInvite = await issue(revokeRollbackFixture.store);
  const revokeRollbackRedemption = await redeem(
    revokeRollbackFixture.store,
    revokeRollbackInvite
  );
  revokeRollbackFixture.fake.failNext('UPDATE nv_alpha_sessions SET revoked_at');
  await infrastructureRejection(
    () => revokeRollbackFixture.store.revokeTester(
      revokeRollbackRedemption.tester.testerId,
      'synthetic rollback'
    )
  );
  assert.strictEqual(
    revokeRollbackFixture.fake.state.testers
      .get(revokeRollbackRedemption.tester.testerId).revoked_at,
    null,
    'tester revocation must roll back with session revocation'
  );
  assert.strictEqual(revokeRollbackFixture.fake.releaseCount, 2);

  const tombstoneFixture = createFixture();
  const tombstoneInvite = await issue(tombstoneFixture.store);
  const tombstoneRedemption = await redeem(tombstoneFixture.store, tombstoneInvite);
  const tombstoneTester = tombstoneFixture.fake.state.testers
    .get(tombstoneRedemption.tester.testerId);
  const tombstoneInviteRow = tombstoneFixture.fake.state.invites
    .get(tombstoneInvite.inviteId);
  tombstoneTester.revoked_at = null;
  tombstoneTester.metadata_purged_at = new Date(tombstoneFixture.clock.value);
  tombstoneInviteRow.redeemed_at = null;
  tombstoneInviteRow.revoked_at = null;
  tombstoneInviteRow.metadata_purged_at = new Date(tombstoneFixture.clock.value);
  const testerCountBefore = tombstoneFixture.fake.state.testers.size;
  const sessionCountBefore = tombstoneFixture.fake.state.sessions.size;
  assert.deepStrictEqual(
    await rejectionShape(() => redeem(tombstoneFixture.store, tombstoneInvite, {
      ip: '203.0.113.77'
    })),
    {
      message: GENERIC_REDEMPTION_ERROR,
      code: 'ALPHA_INVITE_REJECTED',
      status: 403
    },
    'a purged invite tombstone must not start another tester or session lifecycle'
  );
  assert.strictEqual(tombstoneFixture.fake.state.testers.size, testerCountBefore);
  assert.strictEqual(tombstoneFixture.fake.state.sessions.size, sessionCountBefore);

  for (const key of [
    'tester_label', 'repository_scopes', 'terms_version', 'terms_accepted_at',
    'created_at', 'revoked_at', 'revocation_reason'
  ]) tombstoneTester[key] = null;
  const tombstoneSession = tombstoneFixture.fake.state.sessions
    .get(tombstoneRedemption.sessionId);
  const tombstoneLastSeenAt = new Date(tombstoneSession.last_seen_at);
  advance(tombstoneFixture.clock, 5 * MINUTE_MS);
  const revokedPublicError = {
    message: 'Alpha access was revoked',
    code: 'ALPHA_ACCESS_REVOKED',
    status: 403
  };
  assert.deepStrictEqual(
    await rejectionShape(() => tombstoneFixture.store.readSession(
      tombstoneRedemption.sessionId,
      { touch: false }
    )),
    revokedPublicError,
    'a purged tester cannot validate or read an alpha session'
  );
  assert.deepStrictEqual(
    await rejectionShape(() => tombstoneFixture.store.readSession(
      tombstoneRedemption.sessionId
    )),
    revokedPublicError,
    'a purged tester cannot refresh or touch an alpha session'
  );
  assert.strictEqual(
    tombstoneSession.last_seen_at.getTime(),
    tombstoneLastSeenAt.getTime(),
    'a purged tester session must not reach the touch writer'
  );
  assert.deepStrictEqual(
    await tombstoneFixture.store.revokeTester(
      tombstoneRedemption.tester.testerId,
      'repeat revocation'
    ),
    { sessionsRevoked: 0 },
    'a purged tester must not re-enter the revocation writer path'
  );
  assert.strictEqual(tombstoneSession.revoked_at, null);

  const lifecycleSql = tombstoneFixture.fake.calls.map(call => normalizeSql(call.sql));
  assert(lifecycleSql.some(sql => (
    sql.startsWith('SELECT invite_id, secret_digest')
    && sql.includes('metadata_purged_at')
  )));
  assert(lifecycleSql.some(sql => (
    sql.startsWith('SELECT s.session_id')
    && sql.includes('t.metadata_purged_at AS tester_metadata_purged_at')
  )));
  assert(lifecycleSql.some(sql => (
    sql.startsWith('SELECT tester_id FROM nv_alpha_testers')
    && sql.includes('metadata_purged_at IS NULL')
  )));
  assert(lifecycleSql.some(sql => (
    sql.startsWith('UPDATE nv_alpha_invites SET redeemed_at')
    && sql.includes('metadata_purged_at IS NULL')
  )));

  assert.strictEqual(
    store.assertRedemptionAllowed,
    undefined,
    'unlocked admission checks must not remain callable'
  );
  assert.strictEqual(
    store.recordRedemptionFailure,
    undefined,
    'failure accounting must not remain separable from redemption'
  );
  await assert.rejects(
    () => store.redeemInvite({
      code: 'malformed',
      termsVersion: TERMS
    }),
    error => error instanceof TypeError
      && error.code === undefined
      && /request IP/i.test(error.message)
  );

  const lockFixture = createFixture();
  const ip = '203.0.113.42';
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    assert.deepStrictEqual(
      await rejectionShape(() => lockFixture.store.redeemInvite({
        code: 'malformed',
        termsVersion: TERMS,
        ip
      })),
      generic,
      `failure ${attempt} must remain a generic allowed failure`
    );
  }
  const lockRow = [...lockFixture.fake.state.locks.values()][0];
  assert.strictEqual(lockRow.failed_count, 5);
  assert.strictEqual(
    lockRow.locked_until.toISOString(),
    '2026-07-29T12:15:00.000Z',
    'the fifth failed redemption must establish the 15-minute lock'
  );
  assert.deepStrictEqual(
    await rejectionShape(() => lockFixture.store.redeemInvite({
      code: 'malformed',
      termsVersion: TERMS,
      ip
    })),
    {
      message: GENERIC_REDEMPTION_ERROR,
      code: 'ALPHA_REDEMPTION_LOCKED',
      status: 403
    },
    'the serialized sixth attempt must observe the lock'
  );
  assert(!JSON.stringify(lockFixture.fake.calls).includes(ip), 'raw IP must not enter SQL calls');
  assert.match([...lockFixture.fake.state.locks.keys()][0], /^[0-9a-f]{64}$/);
  advance(lockFixture.clock, 15 * MINUTE_MS);
  assert.deepStrictEqual(
    await rejectionShape(() => lockFixture.store.redeemInvite({
      code: 'malformed',
      termsVersion: TERMS,
      ip
    })),
    generic
  );
  assert.deepStrictEqual(
    {
      failedCount: [...lockFixture.fake.state.locks.values()][0].failed_count,
      lockedUntil: [...lockFixture.fake.state.locks.values()][0].locked_until
    },
    { failedCount: 1, lockedUntil: null },
    'a completed failure window must restart at one'
  );

  const burstFixture = createFixture();
  const burstIp = '198.51.100.17';
  const burst = await Promise.allSettled(
    Array.from({ length: 6 }, () => burstFixture.store.redeemInvite({
      code: 'malformed',
      termsVersion: TERMS,
      ip: burstIp
    }))
  );
  assert.strictEqual(
    burst.filter(result =>
      result.status === 'rejected'
      && result.reason.code === 'ALPHA_INVITE_REJECTED'
    ).length,
    5,
    'a concurrent burst must admit exactly five failed attempts'
  );
  assert.strictEqual(
    burst.filter(result =>
      result.status === 'rejected'
      && result.reason.code === 'ALPHA_REDEMPTION_LOCKED'
    ).length,
    1,
    'the concurrent sixth attempt must be locked'
  );
  assert.strictEqual([...burstFixture.fake.state.locks.values()][0].failed_count, 5);

  const replayFixture = createFixture();
  const replayInvite = await issue(replayFixture.store);
  const concurrentReplay = await Promise.allSettled([
    redeem(replayFixture.store, replayInvite, { ip: '192.0.2.44' }),
    redeem(replayFixture.store, replayInvite, { ip: '192.0.2.45' })
  ]);
  assert.strictEqual(
    concurrentReplay.filter(result => result.status === 'fulfilled').length,
    1,
    'a serialized concurrent replay must produce one session'
  );
  assert.strictEqual(
    concurrentReplay.filter(result =>
      result.status === 'rejected'
      && result.reason.code === 'ALPHA_INVITE_REJECTED'
    ).length,
    1,
    'the losing concurrent replay must be a generic failed attempt'
  );
  assert.strictEqual(replayFixture.fake.state.sessions.size, 1);
  assert.strictEqual(
    replayFixture.fake.state.testers.size,
    1,
    'the invite row lock must prevent a losing replay from creating a tester'
  );

  const successResetFixture = createFixture();
  const successResetIp = '192.0.2.45';
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await rejectionShape(() => successResetFixture.store.redeemInvite({
      code: 'malformed',
      termsVersion: TERMS,
      ip: successResetIp
    }));
  }
  const successResetInvite = await issue(successResetFixture.store);
  await redeem(successResetFixture.store, successResetInvite, {
    ip: successResetIp
  });
  assert.strictEqual(
    successResetFixture.fake.state.locks.size,
    0,
    'successful redemption must clear prior failure state atomically'
  );

  const purgeFixture = createFixture({ purgeLimit: 2 });
  const purgeNow = purgeFixture.clock.value;
  for (let index = 0; index < 3; index += 1) {
    purgeFixture.fake.state.sessions.set(`session-${index}`, {
      session_id: `session-${index}`,
      tester_id: `tester-${index}`,
      created_at: new Date(purgeNow.getTime() - 8 * DAY_MS),
      last_seen_at: new Date(purgeNow.getTime() - 2 * DAY_MS),
      expires_at: new Date(purgeNow.getTime() - DAY_MS),
      revoked_at: null
    });
    purgeFixture.fake.state.invites.set(`invite-${index}`, {
      invite_id: `invite-${index}`,
      expires_at: new Date(purgeNow.getTime() - DAY_MS),
      redeemed_at: null
    });
    purgeFixture.fake.state.locks.set(`lock-${index}`, {
      ip_hash: `lock-${index}`,
      window_started_at: new Date(purgeNow.getTime() - 31 * MINUTE_MS),
      failed_count: 1,
      locked_until: null
    });
  }
  purgeFixture.fake.state.sessions.set('active-revoked-session', {
    session_id: 'active-revoked-session',
    tester_id: 'revoked-tester',
    created_at: new Date(purgeNow.getTime() - DAY_MS),
    last_seen_at: new Date(purgeNow.getTime() - MINUTE_MS),
    expires_at: new Date(purgeNow.getTime() + DAY_MS),
    revoked_at: new Date(purgeNow.getTime() - MINUTE_MS)
  });
  const purged = await purgeFixture.store.purgeExpired();
  assert.deepStrictEqual(purged, { invites: 2, sessions: 2, locks: 2 });
  assert.deepStrictEqual(
    {
      invites: purgeFixture.fake.state.invites.size,
      sessions: purgeFixture.fake.state.sessions.size,
      locks: purgeFixture.fake.state.locks.size
    },
    { invites: 1, sessions: 2, locks: 1 },
    'purge counts must be bounded per table'
  );
  assert(
    purgeFixture.fake.state.sessions.has('active-revoked-session'),
    'fake and production purge must retain a revoked session until it expires'
  );

  const purgeRollbackFixture = createFixture({ purgeLimit: 2 });
  purgeRollbackFixture.fake.state.sessions.set('expired-session', {
    session_id: 'expired-session',
    tester_id: 'tester',
    created_at: new Date('2026-07-20T00:00:00.000Z'),
    last_seen_at: new Date('2026-07-20T00:00:00.000Z'),
    expires_at: new Date('2026-07-21T00:00:00.000Z'),
    revoked_at: null
  });
  purgeRollbackFixture.fake.state.invites.set('expired-invite', {
    invite_id: 'expired-invite',
    expires_at: new Date('2026-07-21T00:00:00.000Z'),
    redeemed_at: null
  });
  purgeRollbackFixture.fake.failNext('DELETE FROM nv_alpha_invites target');
  await infrastructureRejection(() => purgeRollbackFixture.store.purgeExpired());
  assert.strictEqual(purgeRollbackFixture.fake.state.sessions.size, 1, 'purge failure must roll back prior deletion');
  assert.strictEqual(purgeRollbackFixture.fake.releaseCount, 1);
  assert(purgeRollbackFixture.fake.calls.some(call => call.sql.trim() === 'ROLLBACK'));

  for (const call of fake.calls) {
    if (call.params.length) {
      assert(
        /\$1/.test(call.sql),
        `parameterized query must contain placeholders: ${call.sql}`
      );
    }
  }
  assert(
    fake.calls.some(call => /FOR UPDATE/.test(call.sql)),
    'redemption state must be serialized'
  );

  const exactSql = (database, startsWith, expected) => {
    const call = database.calls.find(item =>
      normalizeSql(item.sql).startsWith(startsWith)
    );
    assert(call, `missing production SQL contract: ${startsWith}`);
    assert.strictEqual(normalizeSql(call.sql), normalizeSql(expected));
    return call;
  };

  exactSql(
    lockFixture.fake,
    'SELECT pg_advisory_xact_lock',
    `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`
  );
  exactSql(
    lockFixture.fake,
    'SELECT ip_hash, window_started_at',
    `SELECT ip_hash, window_started_at, failed_count, locked_until
       FROM nv_alpha_redemption_locks
      WHERE ip_hash = $1
      FOR UPDATE`
  );
  exactSql(
    lockFixture.fake,
    'SELECT invite_id, secret_digest',
    `SELECT invite_id, secret_digest, tester_label, repository_scopes,
            terms_version, expires_at, redeemed_at, revoked_at,
            metadata_purged_at
       FROM nv_alpha_invites
      WHERE invite_id = $1
      FOR UPDATE`
  );
  const failureUpsert = exactSql(
    lockFixture.fake,
    'INSERT INTO nv_alpha_redemption_locks',
    `INSERT INTO nv_alpha_redemption_locks(
       ip_hash, window_started_at, failed_count, locked_until
     ) VALUES($1, $2, 1, NULL)
     ON CONFLICT (ip_hash) DO UPDATE SET
       window_started_at = CASE
         WHEN nv_alpha_redemption_locks.window_started_at
              <= $2 - ($3::double precision * interval '1 millisecond')
           THEN $2
         ELSE nv_alpha_redemption_locks.window_started_at
       END,
       failed_count = CASE
         WHEN nv_alpha_redemption_locks.window_started_at
              <= $2 - ($3::double precision * interval '1 millisecond')
           THEN 1
         ELSE LEAST(nv_alpha_redemption_locks.failed_count + 1, 1000)
       END,
       locked_until = CASE
         WHEN nv_alpha_redemption_locks.window_started_at
              <= $2 - ($3::double precision * interval '1 millisecond')
           THEN NULL
         WHEN nv_alpha_redemption_locks.locked_until > $2
           THEN nv_alpha_redemption_locks.locked_until
         WHEN nv_alpha_redemption_locks.failed_count + 1 >= $4
           THEN $2 + ($5::double precision * interval '1 millisecond')
         ELSE NULL
       END
     RETURNING ip_hash, window_started_at, failed_count, locked_until`
  );
  assert.deepStrictEqual(
    failureUpsert.params.slice(2),
    [15 * MINUTE_MS, 5, 15 * MINUTE_MS],
    'failure window, threshold, and lock duration must remain exact'
  );
  exactSql(
    successResetFixture.fake,
    'DELETE FROM nv_alpha_redemption_locks WHERE ip_hash',
    `DELETE FROM nv_alpha_redemption_locks WHERE ip_hash = $1`
  );
  const touch = exactSql(
    fake,
    'UPDATE nv_alpha_sessions SET last_seen_at',
    `UPDATE nv_alpha_sessions
        SET last_seen_at = $2
      WHERE session_id = $1
        AND last_seen_at <= $3
        AND revoked_at IS NULL`
  );
  assert.strictEqual(
    touch.params[1].getTime() - touch.params[2].getTime(),
    5 * MINUTE_MS,
    'session touch threshold must stay at five minutes'
  );
  const purgeSessions = exactSql(
    purgeFixture.fake,
    'WITH doomed AS ( SELECT session_id',
    `WITH doomed AS (
       SELECT session_id
         FROM nv_alpha_sessions
        WHERE expires_at <= $2
           OR last_seen_at <= $3
        ORDER BY expires_at, session_id
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     DELETE FROM nv_alpha_sessions target
      USING doomed
      WHERE target.session_id = doomed.session_id`
  );
  assert.strictEqual(purgeSessions.params[0], 2, 'session purge must use the configured bound');
  const purgeInvites = exactSql(
    purgeFixture.fake,
    'WITH doomed AS ( SELECT invite_id',
    `WITH doomed AS (
       SELECT invite_id
         FROM nv_alpha_invites
        WHERE expires_at <= $2
          AND redeemed_at IS NULL
        ORDER BY expires_at, invite_id
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     DELETE FROM nv_alpha_invites target
      USING doomed
      WHERE target.invite_id = doomed.invite_id`
  );
  assert.strictEqual(purgeInvites.params[0], 2, 'invite purge must use the configured bound');
  const purgeLocks = exactSql(
    purgeFixture.fake,
    'WITH doomed AS ( SELECT ip_hash',
    `WITH doomed AS (
       SELECT ip_hash
         FROM nv_alpha_redemption_locks
        WHERE window_started_at <= $2
          AND (locked_until IS NULL OR locked_until <= $3)
        ORDER BY window_started_at, ip_hash
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     DELETE FROM nv_alpha_redemption_locks target
      USING doomed
      WHERE target.ip_hash = doomed.ip_hash`
  );
  assert.strictEqual(purgeLocks.params[0], 2, 'lock purge must use the configured bound');

  /*
 * An exposed invitation that nobody has redeemed has no tester behind it, so
 * revoking the tester cannot reach it. Until the code itself can be revoked, a
 * leaked invitation stays redeemable for its whole lifetime and the operator's
 * only options are to wait it out or purge the cohort.
 *
 * Redemption already refuses a revoked invite, so this closes the gap by giving
 * the operator a way to set that flag rather than by changing redemption.
 */
const inviteRevocationFixture = createFixture();
const exposedInvite = await issue(inviteRevocationFixture.store);
const exposedRevocation = await inviteRevocationFixture.store.revokeInvite(exposedInvite.inviteId);
assert.deepStrictEqual(exposedRevocation, { inviteId: exposedInvite.inviteId, state: 'revoked', revoked: true });

/* The point of the whole exercise: the leaked code no longer works. */
assert.deepStrictEqual(
  await rejectionShape(() => redeem(inviteRevocationFixture.store, exposedInvite)),
  { message: GENERIC_REDEMPTION_ERROR, code: 'ALPHA_INVITE_REJECTED', status: 403 },
  'a revoked invitation must no longer be redeemable'
);

/* Repeating the command during an incident must be safe and truthful. */
assert.deepStrictEqual(
  await inviteRevocationFixture.store.revokeInvite(exposedInvite.inviteId),
  { inviteId: exposedInvite.inviteId, state: 'already-revoked', revoked: false }
);

/*
 * A redeemed invitation is a tester's, and revoking the code would not end the
 * session it produced. Say so rather than reporting a revocation that leaves
 * the tester active.
 */
const redeemedInviteFixture = createFixture();
const redeemedInvite = await issue(redeemedInviteFixture.store);
await redeem(redeemedInviteFixture.store, redeemedInvite);
assert.deepStrictEqual(
  await redeemedInviteFixture.store.revokeInvite(redeemedInvite.inviteId),
  { inviteId: redeemedInvite.inviteId, state: 'redeemed', revoked: false },
  'a redeemed invitation must direct the operator to tester revocation'
);

/* An unknown id is reported, not silently treated as success. */
assert.deepStrictEqual(
  await inviteRevocationFixture.store.revokeInvite('a'.repeat(24)),
  { inviteId: 'a'.repeat(24), state: 'unknown', revoked: false }
);

/* Purged cohort metadata is immutable; the database trigger would refuse. */
const purgedInviteFixture = createFixture();
const purgedInvite = await issue(purgedInviteFixture.store);
purgedInviteFixture.fake.state.invites.get(purgedInvite.inviteId).metadata_purged_at =
  new Date().toISOString();
assert.deepStrictEqual(
  await purgedInviteFixture.store.revokeInvite(purgedInvite.inviteId),
  { inviteId: purgedInvite.inviteId, state: 'purged', revoked: false }
);

for (const bad of ['', 'SHORT', 'x'.repeat(41), 'Uppercase0123456789012', null, 42, {}]) {
  await assert.rejects(
    () => inviteRevocationFixture.store.revokeInvite(bad),
    /invitation id/,
    `invite id ${JSON.stringify(bad)} must be rejected before any query runs`
  );
}

console.log('alpha access store tests passed');
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
