'use strict';

/* Keep the real SQL regression independent of the retired owner feature. */
const assert = require('assert');
const crypto = require('crypto');
const { Pool } = require('pg');
const { AlphaPrivacyStore } = require('../src/alpha-privacy-store');

async function verifyAlphaPrivacyPurge(connectionString) {
  const pool = new Pool({ connectionString });
  const digest = value => crypto.createHash('sha256').update(value).digest('hex');
  const testerId = crypto.randomUUID();
  const inviteId = crypto.randomBytes(16).toString('hex');
  const identityKey = 'a'.repeat(64);
  const unrelatedKey = 'b'.repeat(64);
  try {
    await pool.query(`INSERT INTO nv_security_state (identity_key, state)
      VALUES ($1, '{"freezeSync":true}'::jsonb), ($2, '{"readOnly":true}'::jsonb)`, [identityKey, unrelatedKey]);
    await pool.query(`INSERT INTO nv_alpha_invites
      (invite_id, secret_digest, tester_label, repository_scopes, terms_version, expires_at)
      VALUES ($1, $2, 'purge-regression', ARRAY['github:github.com:owner/demo'], '2026-08-01', now() + interval '1 day')`,
    [inviteId, digest(inviteId)]);
    await pool.query(`INSERT INTO nv_alpha_testers
      (tester_id, invite_id, tester_label, repository_scopes, terms_version, terms_accepted_at)
      VALUES ($1, $2, 'purge-regression', ARRAY['github:github.com:owner/demo'], '2026-08-01', now())`, [testerId, inviteId]);
    const privacy = new AlphaPrivacyStore({ pool });
    await privacy.bindProviderIdentity({ testerId, identityKey, provider: 'github', authority: 'github.com' });
    const sessionKeyHash = digest('synthetic-purge-test-session');
    await privacy.claimProviderSessionOwnership({ testerId, identityKey, provider: 'github', sessionKeyHash });
    const cleanup = await privacy.createCleanupTask({
      testerId, identityKey, provider: 'github', resourceType: 'provider-session',
      resourceKeyHash: sessionKeyHash, reasonCode: 'PROVIDER_ABSENCE_UNCONFIRMED'
    });
    assert.strictEqual((await pool.query('SELECT 1 FROM nv_sessions WHERE session_key_hash=$1', [sessionKeyHash])).rowCount, 0);
    await privacy.completeCleanupTask({ testerId, cleanupId: cleanup.cleanupId });
    await privacy.createDeletionRequest({ testerId });
    const purged = await privacy.purgeTester({ testerId });
    assert.strictEqual(purged.status, 'complete');
    assert.strictEqual((await pool.query('SELECT 1 FROM nv_security_state WHERE identity_key=$1', [identityKey])).rowCount, 0);
    assert.strictEqual((await pool.query('SELECT 1 FROM nv_security_state WHERE identity_key=$1', [unrelatedKey])).rowCount, 1);
  } finally {
    await pool.end();
  }
}

module.exports = { verifyAlphaPrivacyPurge };
