'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ExposureStore } = require('../../src/exposure-store');

async function checkStoreBoundaries(pool) {
  const store = new ExposureStore({ pool });
  const scope = { provider: 'github', authority: 'github.com', owner: 'review-fixture', repo: 'boundaries' };
  const identityKey = '1'.repeat(64);
  const otherIdentity = '2'.repeat(64);
  const fingerprint = '3'.repeat(64);
  const now = Date.parse('2026-09-23T12:00:00Z');
  const request = {
    scope, identityKey, requestedBy: 'first-owner', refName: 'main', commitSha: 'a'.repeat(40),
    rulesVersion: 1, engineVersion: 1, fingerprintKeyVersion: 1, configVersion: 1,
    fingerprintKeyId: 'b'.repeat(64), idempotencyKey: 'review-first-0001', now
  };
  const finding = {
    fingerprint, fingerprintKeyVersion: 1, rulesVersion: 1, engineVersion: 1,
    rule: 'github-token', path: ' spaced file.js ', placeholder: '<github-token #1>',
    occurrences: [{ line: 1, column: 1 }], occurrenceCount: 1
  };
  const first = await store.requestScan(request);
  const claims = await Promise.all([store.claimScan({ now }), store.claimScan({ now })]);
  assert.equal(claims.filter(Boolean).length, 1, 'one queued scan has exactly one claimant');
  const claim = claims.find(Boolean);
  const owned = { scanId: first.scan.scanId, claimOwner: claim.claimOwner, now };
  await store.recordObservations({ ...owned, findings: [finding] });
  const query = { scope, identityKey, fingerprint };
  assert.equal((await store.getFinding(query)).commit, request.commitSha);
  assert.equal((await store.getFinding(query)).path, ' spaced file.js ');
  const wrongScope = { scope: { ...scope, repo: 'different' }, identityKey, scanId: first.scan.scanId, now };
  assert.equal(await store.getScan(wrongScope), null);
  assert.equal(await store.cancelScan(wrongScope), null);
  assert.deepEqual(await store.listObservations(wrongScope), []);
  await store.finalizeScan({ ...owned, state: 'complete', coverage: 'complete' });
  await store.acceptRisk({ ...query, actor: 'first-owner', now });

  const second = await store.requestScan({
    ...request, identityKey: otherIdentity, requestedBy: 'second-owner',
    commitSha: 'c'.repeat(40), idempotencyKey: 'review-second-0002'
  });
  const secondClaim = await store.claimScan({ now });
  const secondOwned = { scanId: second.scan.scanId, claimOwner: secondClaim.claimOwner, now };
  await store.recordObservations({ ...secondOwned, findings: [finding] });
  const secondQuery = { ...query, identityKey: otherIdentity };
  assert.equal((await store.getFinding(secondQuery)).disposition, 'open');
  assert.equal((await store.getFinding(query)).disposition, 'accepted-risk');
  assert.equal((await store.getFinding(query)).commit, request.commitSha);
  await store.recordVerification({
    ...secondQuery, requestedBy: 'second-owner',
    record: { state: 'rejected', reason: 'credential-rejected', adapter: 'github', observedAt: now }
  });
  assert.equal((await store.getFinding(query)).disposition, 'accepted-risk');
  assert.equal((await store.getFinding(secondQuery)).disposition, 'credential-rejected');
  const expired = { ...secondOwned, now: now + 60_000 };
  assert.equal(await store.renewClaim(expired), false, 'an expired worker cannot renew itself');
  await assert.rejects(store.recordObservations({ ...expired, findings: [finding] }), {
    code: 'EXPOSURE_SCAN_NOT_OWNED'
  });
  await assert.rejects(store.finalizeScan({ ...expired, state: 'complete', coverage: 'complete' }), {
    code: 'EXPOSURE_SCAN_NOT_OWNED'
  });
}

async function checkLegacyUpgrade(client) {
  const directory = path.join(__dirname, '..', '..', 'db', 'migrations');
  await client.query('CREATE SCHEMA exposure_upgrade_fixture');
  await client.query('SET search_path TO exposure_upgrade_fixture');
  try {
    for (const file of ['022_exposure_scans.sql', '023_exposure_verifications.sql', '024_exposure_readability_probes.sql']) {
      await client.query(fs.readFileSync(path.join(directory, file), 'utf8'));
    }
    const fingerprint = '3'.repeat(64);
    for (let index = 1; index <= 2; index += 1) {
      const scanId = '00000000-0000-4000-8000-00000000000' + index;
      const identity = String(index).repeat(64);
      const commit = (index === 1 ? 'a' : 'b').repeat(40);
      await client.query(
        `INSERT INTO nv_exposure_scans (
          scan_id, provider, authority, owner_login, repo_name, identity_key, requested_by,
          ref_name, commit_sha, rules_version, engine_version, fingerprint_key_version,
          config_version, state, coverage, idempotency_key, retain_until, finished_at
        ) VALUES ($1,'github','github.com','legacy','repo',$2,'fixture','main',$3,
          1,1,1,1,'complete','complete',$4,now()+interval '1 day',now())`,
        [scanId, identity, commit, 'legacy-scan-' + index]
      );
      if (index === 1) {
        await client.query(
          `INSERT INTO nv_exposure_findings (
            provider,authority,owner_login,repo_name,fingerprint,identity_key,
            fingerprint_key_version,rules_version,engine_version,rule,file_path,placeholder,
            disposition,disposition_at,disposition_by
          ) VALUES ('github','github.com','legacy','repo',$1,$2,1,1,1,'github-token',
            'legacy.js','<github-token #1>','accepted-risk',now(),'first-owner')`,
          [fingerprint, identity]
        );
      }
      await client.query(
        `INSERT INTO nv_exposure_observations (
          scan_id,fingerprint,occurrence_count,occurrence_lines,occurrence_columns,truncated
        ) VALUES ($1,$2,1,ARRAY[1],ARRAY[1],false)`, [scanId, fingerprint]
      );
    }
    await client.query('BEGIN');
    await client.query(fs.readFileSync(path.join(directory, '025_exposure_identity_provenance.sql'), 'utf8'));
    await client.query('COMMIT');
    const result = await client.query('SELECT * FROM nv_exposure_findings ORDER BY identity_key');
    assert.equal(result.rows.length, 2);
    assert.equal(result.rows[0].disposition, 'accepted-risk');
    assert.equal(result.rows[0].disposition_by, 'first-owner');
    assert.equal(result.rows[0].commit_sha, 'a'.repeat(40));
    assert.equal(result.rows[1].disposition, 'open');
    assert.equal(result.rows[1].disposition_by, null);
    assert.equal(result.rows[1].commit_sha, 'b'.repeat(40));
  } finally {
    await client.query('ROLLBACK');
    await client.query('SET search_path TO public');
    await client.query('DROP SCHEMA exposure_upgrade_fixture CASCADE');
  }
}

module.exports = { checkStoreBoundaries, checkLegacyUpgrade };
