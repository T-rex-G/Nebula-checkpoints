'use strict';

const assert = require('assert');
const {
  disconnectProviderAccount,
  providerResourceKeyHash,
  providerSessionKeyHash
} = require('../src/provider-disconnect');

const TESTER_ID = '12345678-1234-4234-9234-123456789abc';
const IDENTITY_KEY = 'a'.repeat(64);
const SESSION_ID = 'sid-alpha-owned';
const SESSION_KEY_HASH = providerSessionKeyHash(SESSION_ID);
const OTHER_SESSION_KEY_HASH = providerSessionKeyHash('sid-alpha-owned-second');
const SESSION_TASK = '10000000-0000-4000-8000-000000000001';
const OTHER_SESSION_TASK = '10000000-0000-4000-8000-000000000003';
const WEBHOOK_TASK = '10000000-0000-4000-8000-000000000002';

function baseOptions(overrides = {}) {
  const options = {
    account: {
      provider: 'github',
      authMethod: 'token',
      token: 'ghp_private_credential',
      login: 'private-login'
    },
    tester: { testerId: TESTER_ID },
    binding: {
      testerId: TESTER_ID,
      identityKey: IDENTITY_KEY,
      provider: 'github',
      authority: 'github.com'
    },
    sessionId: SESSION_ID,
    enumerateProviderWebhooks: async () => [],
    createCleanupTask: async input => ({
      cleanupId: input.resourceType === 'provider-session'
        ? '10000000-0000-4000-8000-000000000001'
        : '10000000-0000-4000-8000-000000000002',
      status: 'pending'
    }),
    completeCleanupTask: async () => ({ status: 'verified' }),
    removeProviderWebhook: async () => ({ verifiedAbsent: true }),
    removeLocalWebhookRecord: async () => true,
    invalidateBroker: () => {},
    finalizeDisconnect: async () => ({ finalized: true }),
    ...overrides
  };
  if (!overrides.prepareDisconnect) {
    options.prepareDisconnect = async input => ({
      webhooks: await Promise.all(input.webhookResourceKeyHashes.map(async resourceKeyHash => ({
        resourceKeyHash,
        requesterOwned: true,
        ...await options.createCleanupTask({
          testerId: input.testerId,
          identityKey: input.identityKey,
          provider: input.provider,
          resourceType: 'provider-webhook',
          resourceKeyHash,
          reasonCode: input.reasonCode
        })
      }))),
      providerSessions: [{
        resourceKeyHash: input.currentSessionKeyHash,
        ...await options.createCleanupTask({
          testerId: input.testerId,
          identityKey: input.identityKey,
          provider: input.provider,
          resourceType: 'provider-session',
          resourceKeyHash: input.currentSessionKeyHash,
          reasonCode: input.reasonCode
        })
      }]
    });
  }
  if (!overrides.completeProviderWebhookCleanup) {
    options.completeProviderWebhookCleanup = async input => {
      const completion = await options.completeCleanupTask({
        testerId: input.testerId,
        cleanupId: input.cleanupId
      });
      return {
        verified: completion === true || (completion && completion.status === 'verified'),
        shared: false,
        localRemoved: true
      };
    };
  }
  return options;
}

async function testInventoryPrecedesDeletionAndRawRefsNeverReachEvidence() {
  const calls = [];
  const rawHook = { providerHookId: 'raw-provider-hook-91', localRecordKey: 'local-row-7' };
  const taskInputs = [];
  const result = await disconnectProviderAccount(baseOptions({
    enumerateProviderWebhooks: async input => {
      calls.push('enumerate');
      assert.strictEqual(input.account.token, 'ghp_private_credential');
      return [rawHook];
    },
    createCleanupTask: async input => {
      calls.push(`task:${input.resourceType}`);
      taskInputs.push(input);
      return {
        cleanupId: input.resourceType === 'provider-session'
          ? '10000000-0000-4000-8000-000000000001'
          : '10000000-0000-4000-8000-000000000002',
        status: 'pending'
      };
    },
    removeProviderWebhook: async input => {
      calls.push('delete');
      assert.strictEqual(input.webhook, rawHook);
      return { verifiedAbsent: true };
    },
    completeProviderWebhookCleanup: async input => {
      calls.push('local');
      calls.push(`verify:${input.cleanupId}`);
      return { verified: true, shared: false, localRemoved: true };
    },
    invalidateBroker: () => calls.push('broker'),
    finalizeDisconnect: async input => {
      calls.push('finalize');
      assert.deepStrictEqual(input, {
        testerId: TESTER_ID,
        identityKey: IDENTITY_KEY,
        provider: 'github',
        providerSessionTasks: [{
          resourceKeyHash: SESSION_KEY_HASH,
          cleanupId: '10000000-0000-4000-8000-000000000001'
        }]
      });
      return { finalized: true };
    }
  }));

  assert.deepStrictEqual(calls.slice(0, 3), [
    'enumerate', 'task:provider-webhook', 'task:provider-session'
  ], 'the complete expected manifest must be registered before deletion starts');
  assert(calls.indexOf('delete') > calls.indexOf('task:provider-session'));
  assert(calls.indexOf('local') > calls.indexOf('delete'));
  assert(calls.indexOf('finalize') > calls.indexOf('local'));
  assert.strictEqual(taskInputs.length, 2);
  assert.deepStrictEqual(taskInputs.map(item => item.resourceType).sort(), [
    'provider-session', 'provider-webhook'
  ]);
  assert.strictEqual(
    taskInputs.find(item => item.resourceType === 'provider-webhook').resourceKeyHash,
    providerResourceKeyHash({
      provider: 'github', authority: 'github.com', resourceType: 'provider-webhook',
      resourceReference: 'raw-provider-hook-91'
    })
  );
  assert.strictEqual(
    taskInputs.find(item => item.resourceType === 'provider-session').resourceKeyHash,
    SESSION_KEY_HASH
  );
  const serializedEvidence = JSON.stringify(taskInputs);
  for (const forbidden of ['raw-provider-hook-91', 'local-row-7', 'ghp_private_credential', 'private-login']) {
    assert(!serializedEvidence.includes(forbidden), `persistent cleanup evidence leaked ${forbidden}`);
  }
  assert.deepStrictEqual(result, {
    providerStateRemoved: true,
    webhookCleanup: 'verified',
    brokerCacheCleared: true,
    providerRevoked: false,
    revocationGuidance: {
      label: 'Revoke the token on GitHub',
      url: 'https://github.com/settings/tokens',
      automatic: false
    }
  });
  const serializedResult = JSON.stringify(result);
  for (const forbidden of ['raw-provider-hook-91', 'local-row-7', 'ghp_private_credential', 'private-login']) {
    assert(!serializedResult.includes(forbidden), `disconnect result leaked ${forbidden}`);
  }
}

async function testZeroWebhooksStillRegistersAndVerifiesProviderSession() {
  const tasks = [];
  let finalized = 0;
  const result = await disconnectProviderAccount(baseOptions({
    createCleanupTask: async input => {
      tasks.push(input);
      return { cleanupId: '10000000-0000-4000-8000-000000000001', status: 'pending' };
    },
    finalizeDisconnect: async () => {
      finalized += 1;
      return { finalized: true };
    }
  }));
  assert.deepStrictEqual(tasks.map(item => item.resourceType), ['provider-session']);
  assert.strictEqual(finalized, 1);
  assert.strictEqual(result.webhookCleanup, 'verified');
  assert.strictEqual(result.providerStateRemoved, true);
}

async function test404AndPositiveReadbackAreTheOnlyVerifiedDeletionPaths() {
  for (const variant of ['delete-404', 'readback-absent']) {
    const verified = [];
    let localRemoved = 0;
    const result = await disconnectProviderAccount(baseOptions({
      enumerateProviderWebhooks: async () => [{ providerHookId: `hook-${variant}` }],
      removeProviderWebhook: async () => {
        if (variant === 'delete-404') {
          throw Object.assign(new Error('not found'), { status: 404 });
        }
        return { verifiedAbsent: false };
      },
      readProviderWebhook: async () => {
        assert.strictEqual(variant, 'readback-absent');
        return { absent: true };
      },
      completeProviderWebhookCleanup: async input => {
        localRemoved += 1;
        verified.push(input.cleanupId);
        return { verified: true, shared: false, localRemoved: true };
      }
    }));
    assert.strictEqual(result.webhookCleanup, 'verified');
    assert.strictEqual(result.providerStateRemoved, true);
    assert.strictEqual(localRemoved, 1);
    assert.deepStrictEqual(verified, ['10000000-0000-4000-8000-000000000002']);
  }
}

async function testAmbiguityStaysPendingAndCannotFinalize() {
  let localRemoved = 0;
  let finalized = 0;
  const result = await disconnectProviderAccount(baseOptions({
    enumerateProviderWebhooks: async () => [{ providerHookId: 'private-hook-pending' }],
    removeProviderWebhook: async () => {
      throw Object.assign(new Error('rate limited'), { status: 429 });
    },
    readProviderWebhook: async () => {
      throw Object.assign(new Error('transport ambiguous'), { code: 'ETIMEDOUT' });
    },
    completeProviderWebhookCleanup: async () => {
      localRemoved += 1;
      return { verified: true, shared: false, localRemoved: true };
    },
    finalizeDisconnect: async () => { finalized += 1; return { finalized: true }; }
  }));
  assert.strictEqual(result.providerStateRemoved, false);
  assert.strictEqual(result.webhookCleanup, 'pending');
  assert.strictEqual(result.cleanupId, '10000000-0000-4000-8000-000000000002');
  assert.strictEqual(localRemoved, 0);
  assert.strictEqual(finalized, 0);
  const serialized = JSON.stringify(result);
  assert(!serialized.includes('private-hook-pending'));
  assert(!serialized.includes('rate limited'));
  assert(!serialized.includes('transport ambiguous'));
}

async function testInventoryFailureCreatesHashedPendingEvidence() {
  const tasks = [];
  let finalized = 0;
  const result = await disconnectProviderAccount(baseOptions({
    enumerateProviderWebhooks: async () => {
      throw Object.assign(new Error('credential unavailable'), { code: 'CREDENTIAL_UNAVAILABLE' });
    },
    createCleanupTask: async input => {
      tasks.push(input);
      return {
        cleanupId: input.resourceType === 'provider-session'
          ? '10000000-0000-4000-8000-000000000001'
          : '10000000-0000-4000-8000-000000000003',
        status: 'pending'
      };
    },
    finalizeDisconnect: async () => { finalized += 1; return { finalized: true }; }
  }));
  assert.deepStrictEqual(tasks.map(item => item.resourceType), ['provider-session']);
  assert(tasks.every(item => /^[0-9a-f]{64}$/.test(item.resourceKeyHash)));
  assert(tasks.every(item => !JSON.stringify(item).includes('credential unavailable')));
  assert.strictEqual(result.webhookCleanup, 'pending');
  assert.strictEqual(result.cleanupId, '10000000-0000-4000-8000-000000000001');
  assert.strictEqual(finalized, 0);
}

async function testVerifiedTasksNeverDowngradeAndRetryScrubsLocalRow() {
  let providerDeletes = 0;
  let atomicCompletions = 0;
  const result = await disconnectProviderAccount(baseOptions({
    enumerateProviderWebhooks: async () => [{ providerHookId: 'already-gone' }],
    createCleanupTask: async input => ({
      cleanupId: input.resourceType === 'provider-session'
        ? '10000000-0000-4000-8000-000000000001'
        : '10000000-0000-4000-8000-000000000002',
      status: input.resourceType === 'provider-webhook' ? 'verified' : 'pending'
    }),
    removeProviderWebhook: async () => { providerDeletes += 1; return { verifiedAbsent: false }; },
    completeProviderWebhookCleanup: async input => {
      atomicCompletions += 1;
      assert.strictEqual(input.providerVerifiedAbsent, false);
      return { verified: true, shared: false, localRemoved: true };
    }
  }));
  assert.strictEqual(providerDeletes, 0);
  assert.strictEqual(atomicCompletions, 1,
    'terminal retry must atomically scrub a reintroduced local webhook row');
  assert.strictEqual(result.providerStateRemoved, true);
}

async function testSharedProviderStateSkipsBrokerInvalidationAfterFinalization() {
  const calls = [];
  const result = await disconnectProviderAccount(baseOptions({
    account: {
      provider: 'github', authMethod: 'github-app', installationId: 91,
      login: 'private-installation-login'
    },
    invalidateBroker: () => calls.push('broker'),
    finalizeDisconnect: async () => {
      calls.push('finalize');
      return { finalized: true, sharedProviderState: true };
    }
  }));
  assert.deepStrictEqual(calls, ['finalize'], 'a shared installation must stay usable by the other tester');
  assert.strictEqual(result.providerStateRemoved, true);
  assert.strictEqual(result.brokerCacheCleared, true);
}

async function testMissingLifecycleContextRecordsOnlyHashedPendingEvidence() {
  const evidence = [];
  const result = await disconnectProviderAccount(baseOptions({
    binding: null,
    recordPendingEvidence: async item => evidence.push(item)
  }));
  assert.strictEqual(result.providerStateRemoved, false);
  assert.strictEqual(result.webhookCleanup, 'pending');
  assert.strictEqual(evidence.length, 1);
  assert.strictEqual(evidence[0].reasonCode, 'PROVIDER_BINDING_CONTEXT_MISSING');
  assert(/^[0-9a-f]{64}$/.test(evidence[0].resourceKeyHash));
  const serialized = JSON.stringify(evidence);
  for (const forbidden of ['ghp_private_credential', 'private-login', SESSION_ID]) {
    assert(!serialized.includes(forbidden));
  }
}

async function testSharedWebhookReleasesOnlyRequesterOwnership() {
  const webhook = { providerHookId: 'shared-provider-hook' };
  const resourceKeyHash = providerResourceKeyHash({
    provider: 'github', authority: 'github.com', resourceType: 'provider-webhook',
    resourceReference: webhook.providerHookId
  });
  let providerDeletes = 0;
  let legacyLocalDeletes = 0;
  const completions = [];
  const result = await disconnectProviderAccount(baseOptions({
    enumerateProviderWebhooks: async () => [webhook],
    prepareDisconnect: async () => ({
      webhooks: [{ resourceKeyHash, cleanupId: WEBHOOK_TASK, status: 'pending', requesterOwned: true, shared: true }],
      providerSessions: [{ resourceKeyHash: SESSION_KEY_HASH, cleanupId: SESSION_TASK, status: 'pending' }]
    }),
    removeProviderWebhook: async () => {
      providerDeletes += 1;
      return { verifiedAbsent: true };
    },
    removeLocalWebhookRecord: async () => {
      legacyLocalDeletes += 1;
      return true;
    },
    completeProviderWebhookCleanup: async input => {
      completions.push(input);
      return { verified: true, shared: true, localRemoved: false };
    }
  }));
  assert.strictEqual(result.providerStateRemoved, true);
  assert.strictEqual(providerDeletes, 0,
    'a tester must not delete a provider webhook still owned by another tester');
  assert.strictEqual(legacyLocalDeletes, 0,
    'a tester must not delete the shared local webhook row');
  assert.deepStrictEqual(completions, [{
    testerId: TESTER_ID,
    identityKey: IDENTITY_KEY,
    provider: 'github',
    cleanupId: WEBHOOK_TASK,
    resourceKeyHash,
    providerVerifiedAbsent: false
  }]);
}

async function testProviderProofAndLocalCompletionUseOneAtomicBoundary() {
  const webhook = { providerHookId: 'exclusive-provider-hook' };
  const resourceKeyHash = providerResourceKeyHash({
    provider: 'github', authority: 'github.com', resourceType: 'provider-webhook',
    resourceReference: webhook.providerHookId
  });
  let atomicCompletions = 0;
  const result = await disconnectProviderAccount(baseOptions({
    enumerateProviderWebhooks: async () => [webhook],
    prepareDisconnect: async () => ({
      webhooks: [{ resourceKeyHash, cleanupId: WEBHOOK_TASK, status: 'pending', requesterOwned: true, shared: false }],
      providerSessions: [{ resourceKeyHash: SESSION_KEY_HASH, cleanupId: SESSION_TASK, status: 'pending' }]
    }),
    removeProviderWebhook: async () => ({ verifiedAbsent: true }),
    removeLocalWebhookRecord: async () => {
      throw new Error('split local deletion must not be reachable');
    },
    completeCleanupTask: async () => {
      throw new Error('split evidence completion must not be reachable');
    },
    completeProviderWebhookCleanup: async input => {
      atomicCompletions += 1;
      assert.strictEqual(input.providerVerifiedAbsent, true);
      return { verified: true, shared: false, localRemoved: true };
    }
  }));
  assert.strictEqual(result.providerStateRemoved, true);
  assert.strictEqual(atomicCompletions, 1,
    'local row removal and exact task verification must share one store transaction');
}

async function testEveryOwnedProviderSessionFinalizesTogether() {
  let finalizationInput = null;
  const result = await disconnectProviderAccount(baseOptions({
    prepareDisconnect: async () => ({
      webhooks: [],
      providerSessions: [
        { resourceKeyHash: SESSION_KEY_HASH, cleanupId: SESSION_TASK, status: 'pending' },
        { resourceKeyHash: OTHER_SESSION_KEY_HASH, cleanupId: OTHER_SESSION_TASK, status: 'pending' }
      ]
    }),
    finalizeDisconnect: async input => {
      finalizationInput = input;
      return { finalized: true };
    }
  }));
  assert.strictEqual(result.providerStateRemoved, true);
  assert.deepStrictEqual(finalizationInput.providerSessionTasks, [
    { resourceKeyHash: SESSION_KEY_HASH, cleanupId: SESSION_TASK },
    { resourceKeyHash: OTHER_SESSION_KEY_HASH, cleanupId: OTHER_SESSION_TASK }
  ], 'all active same-tester provider sessions must finalize in one transaction');
  assert.strictEqual(Object.hasOwn(finalizationInput, 'sessionId'), false,
    'global finalization must not depend on one raw SID');
}

async function testProductionRetryUsesExistingEvidenceAfterDisconnect() {
  let obsoleteCreates = 0;
  let finalizations = 0;
  const result = await disconnectProviderAccount(baseOptions({
    prepareDisconnect: async () => ({
      webhooks: [],
      providerSessions: [
        { resourceKeyHash: SESSION_KEY_HASH, cleanupId: SESSION_TASK, status: 'verified' }
      ]
    }),
    createCleanupTask: async () => {
      obsoleteCreates += 1;
      throw Object.assign(new Error('binding inactive'), { code: 'ALPHA_PROVIDER_BINDING_INACTIVE' });
    },
    finalizeDisconnect: async () => {
      finalizations += 1;
      return { finalized: true };
    }
  }));
  assert.strictEqual(result.providerStateRemoved, true,
    'a lost-response retry must reach terminal finalization through the production service');
  assert.strictEqual(obsoleteCreates, 0,
    'terminal retries must reuse exact immutable evidence before any active-binding creation guard');
  assert.strictEqual(finalizations, 1);
}

async function testInventoriedWebhookWithoutPreparedCoverageFailsClosed() {
  let providerDeletes = 0;
  let atomicCompletions = 0;
  let finalizations = 0;
  const coveredHash = providerResourceKeyHash({
    provider: 'github', authority: 'github.com', resourceType: 'provider-webhook',
    resourceReference: 'covered-provider-hook'
  });
  const result = await disconnectProviderAccount(baseOptions({
    enumerateProviderWebhooks: async () => [
      { providerHookId: 'covered-provider-hook' },
      { providerHookId: 'uncovered-provider-hook' }
    ],
    prepareDisconnect: async () => ({
      webhooks: [{
        resourceKeyHash: coveredHash,
        cleanupId: WEBHOOK_TASK,
        status: 'pending',
        requesterOwned: true,
        shared: false
      }],
      providerSessions: [
        { resourceKeyHash: SESSION_KEY_HASH, cleanupId: SESSION_TASK, status: 'pending' }
      ]
    }),
    removeProviderWebhook: async () => {
      providerDeletes += 1;
      return { verifiedAbsent: true };
    },
    completeProviderWebhookCleanup: async () => {
      atomicCompletions += 1;
      return { verified: true, shared: false, localRemoved: true };
    },
    finalizeDisconnect: async () => {
      finalizations += 1;
      return { finalized: true };
    }
  }));
  assert.strictEqual(result.providerStateRemoved, false,
    'missing exact lifecycle coverage for an inventoried hook must remain pending');
  assert.strictEqual(result.webhookCleanup, 'pending');
  assert(/^[0-9a-f-]{36}$/.test(result.cleanupId),
    'pending output must expose only retained task identity, never the provider reference');
  assert.strictEqual(providerDeletes, 0);
  assert.strictEqual(atomicCompletions, 0);
  assert.strictEqual(finalizations, 0);
  assert(!JSON.stringify(result).includes('uncovered-provider-hook'));
}

async function run() {
  await testInventoryPrecedesDeletionAndRawRefsNeverReachEvidence();
  await testZeroWebhooksStillRegistersAndVerifiesProviderSession();
  await test404AndPositiveReadbackAreTheOnlyVerifiedDeletionPaths();
  await testAmbiguityStaysPendingAndCannotFinalize();
  await testInventoryFailureCreatesHashedPendingEvidence();
  await testVerifiedTasksNeverDowngradeAndRetryScrubsLocalRow();
  await testSharedProviderStateSkipsBrokerInvalidationAfterFinalization();
  await testMissingLifecycleContextRecordsOnlyHashedPendingEvidence();
  await testSharedWebhookReleasesOnlyRequesterOwnership();
  await testProviderProofAndLocalCompletionUseOneAtomicBoundary();
  await testEveryOwnedProviderSessionFinalizesTogether();
  await testProductionRetryUsesExistingEvidenceAfterDisconnect();
  await testInventoriedWebhookWithoutPreparedCoverageFailsClosed();
  console.log('provider disconnect tests passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
