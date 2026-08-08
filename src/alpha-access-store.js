'use strict';

const crypto = require('crypto');
const {
  AlphaAccessError,
  parseInviteCode,
  digestInviteSecret,
  parseRepositoryScope
} = require('./alpha-access');

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const INVITE_TTL_MS = 7 * DAY_MS;
const SESSION_TTL_MS = 7 * DAY_MS;
const IDLE_TTL_MS = DAY_MS;
const TOUCH_INTERVAL_MS = 5 * MINUTE_MS;
const FAILURE_WINDOW_MS = 15 * MINUTE_MS;
const LOCK_DURATION_MS = 15 * MINUTE_MS;
const LOCK_THRESHOLD = 5;
const LOCK_RETENTION_MS = 30 * MINUTE_MS;
const DEFAULT_PURGE_LIMIT = 500;
const MAX_PURGE_LIMIT = 1000;
const TERMS_VERSION_RX = /^\d{4}-\d{2}-\d{2}(?:\.[1-9]\d*)?$/;
const SESSION_ID_RX = /^[A-Za-z0-9_-]{43}$/;
const TESTER_ID_RX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GENERIC_REDEMPTION_ERROR = 'Invitation could not be redeemed';
const DUMMY_PUBLIC_ID = '0'.repeat(20);
const DUMMY_SECRET = 'A'.repeat(32);
const DUMMY_LOOKUP_ID = '!invalid-invite-lookup!';
const OPERATIONAL_ERROR = 'Alpha access operation could not be completed';

class AlphaAccessOperationalError extends Error {
  constructor() {
    super(OPERATIONAL_ERROR);
    this.name = 'AlphaAccessOperationalError';
  }
}

function requirePlainObject(value, label) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value;
}

function requireDuration(name, value, maximum) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new TypeError(`${name} must be a positive integer no greater than ${maximum}`);
  }
  return value;
}

function requireTermsVersion(value) {
  if (typeof value !== 'string' || !TERMS_VERSION_RX.test(value)) {
    throw new TypeError('terms version must use versioned YYYY-MM-DD format');
  }
  return value;
}

function requireTesterLabel(value) {
  if (typeof value !== 'string') {
    throw new TypeError('tester label must be a string containing 1-120 characters');
  }
  const label = value.trim();
  if (label.length < 1 || label.length > 120) {
    throw new TypeError('tester label must contain 1-120 characters');
  }
  return label;
}

function requireRevocationReason(value) {
  if (typeof value !== 'string') {
    throw new TypeError('revocation reason must be a string containing 1-240 characters');
  }
  const reason = value.trim();
  if (reason.length < 1 || reason.length > 240) {
    throw new TypeError('revocation reason must contain 1-240 characters');
  }
  return reason;
}

function genericRedemptionError(code = 'ALPHA_INVITE_REJECTED') {
  return new AlphaAccessError(GENERIC_REDEMPTION_ERROR, code, 403);
}

function sessionError(message, code, status) {
  return new AlphaAccessError(message, code, status);
}

function toDate(value) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function toIso(value) {
  const date = toDate(value);
  if (!date) throw new TypeError('database returned an invalid timestamp');
  return date.toISOString();
}

function redemptionIpHash(pepper, ip) {
  if (typeof ip !== 'string' || !ip.trim() || ip.length > 256) {
    throw new TypeError('redemption request IP must be a non-empty string');
  }
  return crypto.createHmac('sha256', pepper)
    .update(`alpha-redemption-ip-v1\0${ip.trim()}`, 'utf8')
    .digest('hex');
}

async function persistRedemptionFailure(client, ipHash, now) {
  return client.query(
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
     RETURNING ip_hash, window_started_at, failed_count, locked_until`,
    [
      ipHash,
      now,
      FAILURE_WINDOW_MS,
      LOCK_THRESHOLD,
      LOCK_DURATION_MS
    ]
  );
}

class AlphaAccessStore {
  constructor(options) {
    const input = requirePlainObject(options, 'AlphaAccessStore options');
    if (
      !input.pool
      || typeof input.pool.query !== 'function'
      || typeof input.pool.connect !== 'function'
    ) {
      throw new TypeError('AlphaAccessStore requires a pg-compatible pool');
    }
    if (Buffer.byteLength(String(input.pepper || ''), 'utf8') < 32) {
      throw new TypeError('invite pepper must contain at least 32 bytes');
    }
    if (input.now !== undefined && typeof input.now !== 'function') {
      throw new TypeError('now must be a function');
    }
    if (input.randomUUID !== undefined && typeof input.randomUUID !== 'function') {
      throw new TypeError('randomUUID must be a function');
    }
    if (input.randomBytes !== undefined && typeof input.randomBytes !== 'function') {
      throw new TypeError('randomBytes must be a function');
    }

    this.pool = input.pool;
    this.pepper = String(input.pepper);
    this.now = input.now || (() => new Date());
    this.randomUUID = input.randomUUID || crypto.randomUUID;
    this.randomBytes = input.randomBytes || crypto.randomBytes;
    this.inviteTtlMs = requireDuration(
      'inviteTtlMs',
      input.inviteTtlMs ?? INVITE_TTL_MS,
      INVITE_TTL_MS
    );
    this.sessionTtlMs = requireDuration(
      'sessionTtlMs',
      input.sessionTtlMs ?? SESSION_TTL_MS,
      SESSION_TTL_MS
    );
    this.idleTtlMs = requireDuration(
      'idleTtlMs',
      input.idleTtlMs ?? IDLE_TTL_MS,
      IDLE_TTL_MS
    );
    this.purgeLimit = requireDuration(
      'purgeLimit',
      input.purgeLimit ?? DEFAULT_PURGE_LIMIT,
      MAX_PURGE_LIMIT
    );
    this.dummyDigest = digestInviteSecret(
      this.pepper,
      DUMMY_PUBLIC_ID,
      DUMMY_SECRET
    );
  }

  currentTime() {
    const value = this.now();
    const date = toDate(value);
    if (!date) throw new TypeError('now must return a valid date');
    return date;
  }

  bytes(size, label) {
    const value = this.randomBytes(size);
    if (!Buffer.isBuffer(value) || value.length !== size) {
      throw new TypeError(`randomBytes must return exactly ${size} bytes for ${label}`);
    }
    return value;
  }

  async withTransaction(callback) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const value = await callback(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async operational(callback) {
    try {
      return await callback();
    } catch (error) {
      if (
        error instanceof AlphaAccessError
        || error instanceof AlphaAccessOperationalError
      ) {
        throw error;
      }
      throw new AlphaAccessOperationalError();
    }
  }

  async issueInvite(input) {
    const invitation = requirePlainObject(input, 'issue invite input');
    const testerLabel = requireTesterLabel(invitation.testerLabel);
    const termsVersion = requireTermsVersion(invitation.termsVersion);
    if (
      !Array.isArray(invitation.repositoryScopes)
      || invitation.repositoryScopes.length < 1
      || invitation.repositoryScopes.length > 20
    ) {
      throw new TypeError('invite requires 1-20 repository scopes');
    }
    let repositoryScopes;
    try {
      repositoryScopes = [...new Set(
        invitation.repositoryScopes.map(
          scope => parseRepositoryScope(scope).canonical
        )
      )];
    } catch {
      throw new TypeError('invite requires valid canonical repository scopes');
    }
    if (repositoryScopes.length < 1 || repositoryScopes.length > 20) {
      throw new TypeError('invite requires 1-20 repository scopes');
    }

    const now = this.currentTime();
    const inviteId = this.bytes(16, 'invitation public id')
      .toString('hex')
      .slice(0, 26);
    const secret = this.bytes(32, 'invitation secret').toString('base64url');
    const code = `nvx_alpha_${inviteId}.${secret}`;
    const expiresAt = new Date(now.getTime() + this.inviteTtlMs);
    const secretDigest = digestInviteSecret(
      this.pepper,
      inviteId,
      secret
    );

    await this.operational(
      () => this.pool.query(
        `INSERT INTO nv_alpha_invites(
           invite_id, secret_digest, tester_label, repository_scopes,
           terms_version, created_at, expires_at
         ) VALUES($1, $2, $3, $4::text[], $5, $6, $7)`,
        [
          inviteId,
          secretDigest,
          testerLabel,
          repositoryScopes,
          termsVersion,
          now,
          expiresAt
        ]
      )
    );

    return {
      inviteId,
      code,
      expiresAt: expiresAt.toISOString(),
      repositoryScopes: [...repositoryScopes]
    };
  }

  safeDigestMatches(actualHex, storedHex) {
    const candidate = /^[0-9a-f]{64}$/.test(String(storedHex || ''))
      ? String(storedHex)
      : this.dummyDigest;
    const matches = crypto.timingSafeEqual(
      Buffer.from(actualHex, 'hex'),
      Buffer.from(candidate, 'hex')
    );
    return matches && candidate === storedHex;
  }

  async redeemInvite(input) {
    const redemption = requirePlainObject(input, 'redeem invite input');
    const ipHash = redemptionIpHash(this.pepper, redemption.ip);
    const now = this.currentTime();
    const acceptedTermsVersion =
      typeof redemption.termsVersion === 'string'
        ? redemption.termsVersion
        : '';
    let lookupId = DUMMY_LOOKUP_ID;
    let digestPublicId = DUMMY_PUBLIC_ID;
    let digestSecret = DUMMY_SECRET;
    let malformed = true;
    try {
      const parsed = parseInviteCode(redemption.code);
      lookupId = parsed.publicId;
      digestPublicId = parsed.publicId;
      digestSecret = parsed.secret;
      malformed = false;
    } catch (error) {
      if (!(error instanceof AlphaAccessError)) throw error;
    }
    const actualDigest = digestInviteSecret(
      this.pepper,
      digestPublicId,
      digestSecret
    );

    const outcome = await this.operational(
      () => this.withTransaction(async client => {
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
          [ipHash]
        );
        const admission = await client.query(
          `SELECT ip_hash, window_started_at, failed_count, locked_until
             FROM nv_alpha_redemption_locks
            WHERE ip_hash = $1
            FOR UPDATE`,
          [ipHash]
        );
        const lockedUntil =
          admission.rows[0] && toDate(admission.rows[0].locked_until);
        if (lockedUntil && lockedUntil.getTime() > now.getTime()) {
          return { errorCode: 'ALPHA_REDEMPTION_LOCKED' };
        }

        const found = await client.query(
          `SELECT invite_id, secret_digest, tester_label, repository_scopes,
                  terms_version, expires_at, redeemed_at, revoked_at,
                  metadata_purged_at
             FROM nv_alpha_invites
            WHERE invite_id = $1
            FOR UPDATE`,
          [lookupId]
        );
        const invite = found.rows[0] || null;
        const validDigest = this.safeDigestMatches(
          actualDigest,
          invite && invite.secret_digest
        );
        const expiresAt = invite && toDate(invite.expires_at);
        const valid = Boolean(
          !malformed
          && invite
          && validDigest
          && !invite.redeemed_at
          && !invite.revoked_at
          && !invite.metadata_purged_at
          && expiresAt
          && expiresAt.getTime() > now.getTime()
          && acceptedTermsVersion === invite.terms_version
        );
        if (!valid) {
          await persistRedemptionFailure(client, ipHash, now);
          return { errorCode: 'ALPHA_INVITE_REJECTED' };
        }

        const testerId = this.randomUUID();
        if (typeof testerId !== 'string' || !TESTER_ID_RX.test(testerId)) {
          throw new TypeError('randomUUID must return a valid UUID');
        }
        const sessionId =
          this.bytes(32, 'alpha session id').toString('base64url');
        const sessionExpiresAt =
          new Date(now.getTime() + this.sessionTtlMs);

        await client.query(
          `INSERT INTO nv_alpha_testers(
             tester_id, invite_id, tester_label, repository_scopes,
             terms_version, terms_accepted_at, created_at
           ) VALUES($1, $2, $3, $4::text[], $5, $6, $6)`,
          [
            testerId,
            invite.invite_id,
            invite.tester_label,
            invite.repository_scopes,
            invite.terms_version,
            now
          ]
        );
        const marked = await client.query(
          `UPDATE nv_alpha_invites
              SET redeemed_at = $2
            WHERE invite_id = $1
              AND redeemed_at IS NULL
              AND revoked_at IS NULL
              AND metadata_purged_at IS NULL`,
          [invite.invite_id, now]
        );
        if (marked.rowCount !== 1) {
          throw new Error('conditional invite redemption update failed');
        }
        await client.query(
          `INSERT INTO nv_alpha_sessions(
             session_id, tester_id, created_at, last_seen_at, expires_at
           ) VALUES($1, $2, $3, $3, $4)`,
          [sessionId, testerId, now, sessionExpiresAt]
        );
        await client.query(
          'DELETE FROM nv_alpha_redemption_locks WHERE ip_hash = $1',
          [ipHash]
        );

        return {
          value: {
            tester: {
              testerId,
              testerLabel: invite.tester_label,
              repositoryScopes: [...invite.repository_scopes],
              termsVersion: invite.terms_version
            },
            sessionId,
            expiresAt: sessionExpiresAt.toISOString()
          }
        };
      })
    );
    if (outcome.errorCode) throw genericRedemptionError(outcome.errorCode);
    return outcome.value;
  }

  async readSession(sessionId, options = {}) {
    if (typeof sessionId !== 'string' || !SESSION_ID_RX.test(sessionId)) {
      throw sessionError(
        'Alpha access is required',
        'ALPHA_ACCESS_REQUIRED',
        401
      );
    }
    const now = this.currentTime();

    return this.operational(() => this.withTransaction(async client => {
      const result = await client.query(
        `SELECT s.session_id, s.tester_id, s.created_at, s.last_seen_at,
                s.expires_at, s.revoked_at, t.tester_label,
                t.repository_scopes, t.terms_version,
                t.revoked_at AS tester_revoked_at,
                t.metadata_purged_at AS tester_metadata_purged_at
           FROM nv_alpha_sessions s
           JOIN nv_alpha_testers t ON t.tester_id = s.tester_id
          WHERE s.session_id = $1
          FOR UPDATE OF t, s`,
        [sessionId]
      );
      const row = result.rows[0];
      if (!row) {
        throw sessionError(
          'Alpha access is required',
          'ALPHA_ACCESS_REQUIRED',
          401
        );
      }
      if (
        row.revoked_at
        || row.tester_revoked_at
        || row.tester_metadata_purged_at
      ) {
        throw sessionError(
          'Alpha access was revoked',
          'ALPHA_ACCESS_REVOKED',
          403
        );
      }

      const expiresAt = toDate(row.expires_at);
      const lastSeenAt = toDate(row.last_seen_at);
      if (
        !expiresAt
        || !lastSeenAt
        || expiresAt.getTime() <= now.getTime()
        || lastSeenAt.getTime() + this.idleTtlMs <= now.getTime()
      ) {
        throw sessionError(
          'Alpha session expired',
          'ALPHA_SESSION_EXPIRED',
          401
        );
      }

      if (
        options.touch !== false
        && lastSeenAt.getTime() + TOUCH_INTERVAL_MS <= now.getTime()
      ) {
        await client.query(
          `UPDATE nv_alpha_sessions
              SET last_seen_at = $2
            WHERE session_id = $1
              AND last_seen_at <= $3
              AND revoked_at IS NULL`,
          [
            sessionId,
            now,
            new Date(now.getTime() - TOUCH_INTERVAL_MS)
          ]
        );
      }

      return {
        testerId: row.tester_id,
        testerLabel: row.tester_label,
        repositoryScopes: [...row.repository_scopes],
        termsVersion: row.terms_version,
        expiresAt: toIso(expiresAt)
      };
    }));
  }

  async revokeTester(testerId, reason) {
    if (typeof testerId !== 'string' || !TESTER_ID_RX.test(testerId)) {
      throw new TypeError('tester id must be a valid UUID');
    }
    const revocationReason = requireRevocationReason(reason);
    const now = this.currentTime();

    return this.operational(() => this.withTransaction(async client => {
      const selected = await client.query(
        `SELECT tester_id
           FROM nv_alpha_testers
          WHERE tester_id = $1
            AND metadata_purged_at IS NULL
          FOR UPDATE`,
        [testerId]
      );
      if (!selected.rows[0]) return { sessionsRevoked: 0 };
      await client.query(
        `UPDATE nv_alpha_testers
            SET revoked_at = COALESCE(revoked_at, $2),
                revocation_reason = CASE
                  WHEN revoked_at IS NULL THEN $3
                  ELSE revocation_reason
                END
          WHERE tester_id = $1`,
        [testerId, now, revocationReason]
      );
      const sessions = await client.query(
        `UPDATE nv_alpha_sessions
            SET revoked_at = $2
          WHERE tester_id = $1
            AND revoked_at IS NULL`,
        [testerId, now]
      );
      return { sessionsRevoked: sessions.rowCount };
    }));
  }

  async purgeExpired() {
    const now = this.currentTime();
    const idleBefore = new Date(now.getTime() - this.idleTtlMs);
    const locksBefore = new Date(now.getTime() - LOCK_RETENTION_MS);

    return this.operational(() => this.withTransaction(async client => {
      const sessions = await client.query(
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
          WHERE target.session_id = doomed.session_id`,
        [this.purgeLimit, now, idleBefore]
      );
      const invites = await client.query(
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
          WHERE target.invite_id = doomed.invite_id`,
        [this.purgeLimit, now]
      );
      const locks = await client.query(
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
          WHERE target.ip_hash = doomed.ip_hash`,
        [this.purgeLimit, locksBefore, now]
      );
      return {
        invites: invites.rowCount,
        sessions: sessions.rowCount,
        locks: locks.rowCount
      };
    }));
  }
}

module.exports = Object.freeze({
  AlphaAccessStore,
  GENERIC_REDEMPTION_ERROR
});
