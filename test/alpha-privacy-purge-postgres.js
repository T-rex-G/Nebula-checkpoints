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
    /*
     * An exposure scan, its finding and its observation, seeded against the
     * real schema. The observation is the one row nothing deletes by name: it
     * references its scan with ON DELETE CASCADE, and a cascade is exactly the
     * kind of thing that looks right in a migration and does not happen. Only
     * a real server can say whether it does.
     */
    const scanId = crypto.randomUUID();
    const fingerprint = digest('purge-regression-fingerprint');
    await pool.query(`INSERT INTO nv_exposure_scans
      (scan_id, provider, authority, owner_login, repo_name, identity_key, requested_by,
       ref_name, commit_sha, rules_version, engine_version, fingerprint_key_version,
       config_version, state, coverage, idempotency_key, retain_until, finished_at)
      VALUES ($1,'github','github.com','owner','demo',$2,'purge-regression','refs/heads/main',
              $3,1,1,1,1,'complete','complete','purge-regression-1',now() + interval '30 days', now())`,
    [scanId, identityKey, 'c'.repeat(40)]);
    await pool.query(`INSERT INTO nv_exposure_findings
      (provider, authority, owner_login, repo_name, fingerprint, identity_key,
       fingerprint_key_version, rules_version, engine_version, rule, file_path, placeholder)
      VALUES ('github','github.com','owner','demo',$1,$2,1,1,1,'github-token','app/config.js','<github-token #1>')`,
    [fingerprint, identityKey]);
    await pool.query(`INSERT INTO nv_exposure_observations
      (scan_id, fingerprint, occurrence_count, occurrence_lines, occurrence_columns)
      VALUES ($1,$2,1,ARRAY[4],ARRAY[11])`, [scanId, fingerprint]);
    /* And an unrelated identity's rows, so the purge has to be selective
       rather than simply emptying the tables. */
    const unrelatedScanId = crypto.randomUUID();
    await pool.query(`INSERT INTO nv_exposure_scans
      (scan_id, provider, authority, owner_login, repo_name, identity_key, requested_by,
       ref_name, commit_sha, rules_version, engine_version, fingerprint_key_version,
       config_version, state, coverage, idempotency_key, retain_until, finished_at)
      VALUES ($1,'github','github.com','other','demo',$2,'unrelated','refs/heads/main',
              $3,1,1,1,1,'complete','complete','purge-regression-2',now() + interval '30 days', now())`,
    [unrelatedScanId, unrelatedKey, 'd'.repeat(40)]);
    /*
     * A repository audit with a finding and a component. Only the audit is
     * deleted by name; the other two leave through their cascade, which only
     * a real server can show.
     */
    const auditId = crypto.randomUUID();
    const auditColumns = `(audit_id, provider, authority, owner_login, repo_name, identity_key, ref_name, commit_sha, engine_version,
       audited_at, score, grade, category_ids, category_scores, critical_count, serious_count, warning_count, to_confirm_count,
       waived_count, exploited_count, risk_urgent, risk_high, risk_moderate, risk_low, files_read, files_eligible,
       coverage_complete, components_total, findings_total, findings_stored)`;
    await pool.query(`INSERT INTO nv_code_audits ${auditColumns}
      VALUES ($1,'github','github.com','owner','demo',$2,'main',$3,'2.0.0',now(),71,'C','{}','{}',0,1,0,0,0,0,0,0,0,0,3,3,true,1,1,1)`,
    [auditId, identityKey, 'c'.repeat(40)]);
    await pool.query(`INSERT INTO nv_code_audit_findings (audit_id, finding_id, rule, category, severity, verdict, file_path, line_number)
      VALUES ($1,$2,'SEC-011','code','serious','confirmed','routes/run.js',4)`, [auditId, 'a'.repeat(24)]);
    await pool.query(`INSERT INTO nv_code_audit_components (audit_id, ecosystem, package_name, package_version, direct, dev)
      VALUES ($1,'npm','express','4.17.1',true,false)`, [auditId]);
    await pool.query(`INSERT INTO nv_code_audits ${auditColumns}
      VALUES ($1,'github','github.com','other','demo',$2,'main',$3,'2.0.0',now(),71,'C','{}','{}',0,0,0,0,0,0,0,0,0,0,3,3,true,0,0,0)`,
    [crypto.randomUUID(), unrelatedKey, 'd'.repeat(40)]);
    assert.strictEqual((await pool.query('SELECT 1 FROM nv_sessions WHERE session_key_hash=$1', [sessionKeyHash])).rowCount, 0);
    await privacy.completeCleanupTask({ testerId, cleanupId: cleanup.cleanupId });
    await privacy.createDeletionRequest({ testerId });
    const purged = await privacy.purgeTester({ testerId });
    assert.strictEqual(purged.status, 'complete');
    assert.strictEqual((await pool.query('SELECT 1 FROM nv_security_state WHERE identity_key=$1', [identityKey])).rowCount, 0);
    assert.strictEqual((await pool.query('SELECT 1 FROM nv_security_state WHERE identity_key=$1', [unrelatedKey])).rowCount, 1);
    assert.strictEqual(
      (await pool.query('SELECT 1 FROM nv_exposure_scans WHERE identity_key=$1', [identityKey])).rowCount, 0,
      'a purged tester keeps no scans'
    );
    assert.strictEqual(
      (await pool.query('SELECT 1 FROM nv_exposure_findings WHERE identity_key=$1', [identityKey])).rowCount, 0,
      'nor the findings, which carry the placeholder and the locations'
    );
    assert.strictEqual(
      (await pool.query('SELECT 1 FROM nv_exposure_observations WHERE scan_id=$1', [scanId])).rowCount, 0,
      'and the observations went with the scan: the cascade is real, not just written down'
    );
    assert.strictEqual(
      (await pool.query('SELECT 1 FROM nv_exposure_scans WHERE identity_key=$1', [unrelatedKey])).rowCount, 1,
      'while another identity keeps everything'
    );
    assert.strictEqual((await pool.query('SELECT 1 FROM nv_code_audits WHERE identity_key=$1', [identityKey])).rowCount, 0, 'a purged tester keeps no audits');
    assert.strictEqual((await pool.query('SELECT 1 FROM nv_code_audit_findings WHERE audit_id=$1', [auditId])).rowCount, 0, 'their findings went with them');
    assert.strictEqual((await pool.query('SELECT 1 FROM nv_code_audit_components WHERE audit_id=$1', [auditId])).rowCount, 0, 'and their components');
    assert.strictEqual((await pool.query('SELECT 1 FROM nv_code_audits WHERE identity_key=$1', [unrelatedKey])).rowCount, 1, 'another identity keeps its audits');
  } finally {
    await pool.end();
  }
}

module.exports = { verifyAlphaPrivacyPurge };
