'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  parseArgs,
  hashTaskReference,
  runCli,
  createPostgresOperator,
  verifyProviderWebhookAbsent
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
  // Retired cleanup records remain pending; no credential or external adapter
  // may be used to turn their historical state into a verified deletion.
  for (const provider of ['gitlab', 'gitea', 'unknown']) {
    let effects = 0;
    const task = { provider, status: 'pending', resource_type: 'provider-webhook',
      owner: 'acme', repo: 'demo', provider_hook_id: 1, authority: 'retired.example' };
    const env = new Proxy({ DATABASE_URL: 'postgres://fixture.invalid/test' }, {
      get(target, name) {
        if (name !== 'DATABASE_URL') { effects += 1; throw new Error('credential read'); }
        return target[name];
      }
    });
    const operator = createPostgresOperator({ env,
      pool: { query: async () => ({ rows: [task] }) },
      store: { inspectProviderWebhookCleanup: async () => { effects += 1; },
        completeProviderWebhookCleanup: async () => { effects += 1; } },
      fetch: async () => { effects += 1; }
    });
    await assert.rejects(operator.retryCleanup(CLEANUP_ID), { code: 'ALPHA_PROVIDER_UNSUPPORTED' });
    await assert.rejects(verifyProviderWebhookAbsent(task, 'fixture', async () => { effects += 1; }),
      { code: 'ALPHA_PROVIDER_UNSUPPORTED' });
    assert.strictEqual(effects, 0, 'retired cleanup must stop before credentials, state changes or egress');
    assert.strictEqual(task.status, 'pending');
  }
  const requests = [];
  assert.strictEqual(await verifyProviderWebhookAbsent({ provider: 'github', owner: 'acme',
    repo: 'demo', provider_hook_id: 42 }, 'fixture', async (url, options) => {
    requests.push({ url, ...options });
    return { ok: true, status: requests.length === 1 ? 204 : 404 };
  }), true);
  assert.deepStrictEqual(requests.map(({ url, method, redirect, headers }) =>
    [url, method, redirect, headers.Authorization]), [
    ['https://api.github.com/repos/acme/demo/hooks/42', 'DELETE', 'error', 'Bearer fixture'],
    ['https://api.github.com/repos/acme/demo/hooks/42', 'GET', 'error', 'Bearer fixture']
  ]);
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
