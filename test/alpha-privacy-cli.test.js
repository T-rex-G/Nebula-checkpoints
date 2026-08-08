'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  parseArgs,
  hashTaskReference,
  runCli
} = require('../scripts/alpha-privacy');

const CLEANUP_ID = '70000000-0000-4000-8000-000000000001';

assert.deepStrictEqual(parseArgs(['retention']), { command: 'retention' });
assert.deepStrictEqual(parseArgs(['cleanup-status']), { command: 'cleanup-status' });
assert.deepStrictEqual(parseArgs(['retry-cleanup', '--cleanup', CLEANUP_ID]), {
  command: 'retry-cleanup', cleanup: CLEANUP_ID
});
assert.deepStrictEqual(parseArgs(['cohort-close', '--confirm', 'CLOSE-ALPHA']), {
  command: 'cohort-close', confirm: 'CLOSE-ALPHA'
});
assert.throws(() => parseArgs(['cohort-close']), /CLOSE-ALPHA/);
assert.throws(() => parseArgs(['retry-cleanup']), /--cleanup/);
assert.throws(() => parseArgs(['cleanup-status', '--extra', 'x']), /unsupported/i);
assert.match(hashTaskReference(CLEANUP_ID), /^[0-9a-f]{64}$/);
assert(!hashTaskReference(CLEANUP_ID).includes(CLEANUP_ID));

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
assert(server.includes('function startAlphaPrivacyRetention()'));
assert(server.includes('if (!ALPHA_CONFIG.enabled || !alphaPrivacyStore) return;'));
assert(server.includes('await alphaPrivacyStore.runRetention()'));
assert(server.includes('24 * 60 * 60 * 1000'));
assert(server.includes("typeof timer.unref === 'function'"));

(async () => {
  const secret = 'provider-secret-must-not-appear';
  const cleanup = await runCli(['cleanup-status'], {
    cleanupStatus: async () => ({
      counts: { pending: 1, verified: 4 },
      cleanupIds: [CLEANUP_ID],
      token: secret,
      identityKey: 'a'.repeat(64)
    })
  });
  assert.strictEqual(cleanup.exitCode, 0);
  assert.deepStrictEqual(cleanup.report.counts, { pending: 1, verified: 4 });
  assert.deepStrictEqual(cleanup.report.pendingTaskRefs, [hashTaskReference(CLEANUP_ID)]);
  assert(!JSON.stringify(cleanup).includes(secret));
  assert(!JSON.stringify(cleanup).includes(CLEANUP_ID));

  const blocked = await runCli(['cohort-close', '--confirm', 'CLOSE-ALPHA'], {
    cohortClose: async () => ({
      pendingCleanup: 2,
      activeSessions: 1,
      testersRevoked: 3,
      testersPurged: 0,
      completedAt: '2026-08-08T18:00:00.000Z',
      testerLabel: secret
    })
  });
  assert.strictEqual(blocked.exitCode, 1);
  assert.deepStrictEqual(blocked.report, {
    status: 'blocked',
    pendingCleanup: 2,
    activeSessions: 1,
    testersRevoked: 3,
    testersPurged: 0,
    completedAt: '2026-08-08T18:00:00.000Z'
  });
  assert(!JSON.stringify(blocked).includes(secret));

  let credentialSeen = '';
  const retried = await runCli(['retry-cleanup', '--cleanup', CLEANUP_ID], {
    retryCleanup: async cleanupId => {
      credentialSeen = process.env.NV_ALPHA_GITHUB_TOKEN || '';
      return { cleanupId, status: 'verified', verifiedAt: '2026-08-08T18:00:00.000Z' };
    }
  });
  assert.strictEqual(credentialSeen, '');
  assert.deepStrictEqual(retried.report, {
    taskRef: hashTaskReference(CLEANUP_ID),
    status: 'verified',
    verifiedAt: '2026-08-08T18:00:00.000Z'
  });

  console.log('alpha privacy CLI tests passed');
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
