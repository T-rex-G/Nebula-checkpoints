'use strict';

const crypto = require('crypto');
const { providerRevocationGuidance } = require('./alpha-privacy');

const HASH_RX = /^[0-9a-f]{64}$/;
const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVIDERS = new Set(['github', 'gitlab', 'gitea']);

function hashDomain(domain, parts) {
  const hash = crypto.createHash('sha256');
  hash.update(domain, 'utf8');
  for (const part of parts) hash.update(`\0${String(part)}`, 'utf8');
  return hash.digest('hex');
}

function providerSessionKeyHash(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 512) {
    throw new TypeError('sessionId is invalid');
  }
  return hashDomain('nv-alpha-provider-session-v1', [sessionId]);
}

function providerResourceKeyHash(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('provider resource hash input is invalid');
  }
  const provider = String(input.provider || '').toLowerCase();
  const authority = String(input.authority || '').toLowerCase();
  const resourceType = String(input.resourceType || '');
  const resourceReference = String(input.resourceReference == null ? '' : input.resourceReference);
  if (!PROVIDERS.has(provider) || !authority || resourceType !== 'provider-webhook') {
    throw new TypeError('provider resource hash context is invalid');
  }
  if (!resourceReference || resourceReference.length > 1024) {
    throw new TypeError('provider resource reference is invalid');
  }
  return hashDomain('nv-alpha-provider-resource-v1', [
    provider, authority, resourceType, resourceReference
  ]);
}

function webhookReference(webhook) {
  if (!webhook || typeof webhook !== 'object' || Array.isArray(webhook)) {
    throw new TypeError('provider webhook inventory item is invalid');
  }
  const value = webhook.providerHookId ?? webhook.hookId ?? webhook.id ?? webhook.resourceReference;
  const reference = String(value == null ? '' : value);
  if (!reference || reference.length > 1024) {
    throw new TypeError('provider webhook inventory item lacks a bounded reference');
  }
  return reference;
}

function isAbsent(value) {
  return !!value && (
    value.verifiedAbsent === true
    || value.absent === true
    || Number(value.status) === 404
  );
}

function is404(error) {
  return Number(error && (error.status || error.statusCode)) === 404;
}

function cleanupTaskValue(value) {
  if (typeof value === 'string') return { cleanupId: value, status: 'pending' };
  if (!value || typeof value !== 'object') {
    throw new TypeError('cleanup task registration returned invalid evidence');
  }
  const cleanupId = String(value.cleanupId || '');
  if (!UUID_RX.test(cleanupId)) {
    throw new TypeError('cleanup task registration returned an invalid cleanupId');
  }
  const status = value.status === 'verified' ? 'verified' : 'pending';
  return { cleanupId: cleanupId.toLowerCase(), status };
}

function requirePreparedHash(value, label) {
  const hash = String(value && value.resourceKeyHash || '');
  if (!HASH_RX.test(hash)) {
    throw new TypeError(`${label} preparation returned an invalid resource hash`);
  }
  return hash;
}

function pendingResult(account, cleanupIds) {
  const ids = [...new Set(cleanupIds.filter(Boolean))].sort();
  return Object.freeze({
    providerStateRemoved: false,
    webhookCleanup: 'pending',
    brokerCacheCleared: false,
    providerRevoked: false,
    ...(ids.length ? { cleanupId: ids[0] } : {}),
    revocationGuidance: providerRevocationGuidance(account)
  });
}

function verifiedResult(account) {
  return Object.freeze({
    providerStateRemoved: true,
    webhookCleanup: 'verified',
    brokerCacheCleared: true,
    providerRevoked: false,
    revocationGuidance: providerRevocationGuidance(account)
  });
}

function assertFunction(input, name) {
  if (typeof input[name] !== 'function') throw new TypeError(`${name} must be a function`);
}

function safeBinding(input, testerId) {
  const binding = input && input.binding;
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return null;
  const identityKey = String(binding.identityKey || '');
  const provider = String(binding.provider || '').toLowerCase();
  const authority = String(binding.authority || '').toLowerCase();
  if (
    String(binding.testerId || '').toLowerCase() !== testerId
    || !HASH_RX.test(identityKey)
    || !PROVIDERS.has(provider)
    || !authority
  ) return null;
  return { testerId, identityKey, provider, authority };
}

async function disconnectProviderAccount(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('disconnect options must be an object');
  }
  const account = options.account;
  const testerId = String(options.tester && options.tester.testerId || '').toLowerCase();
  if (!account || typeof account !== 'object' || !UUID_RX.test(testerId)) {
    throw new TypeError('disconnect account and tester context are required');
  }
  const binding = safeBinding(options, testerId);
  if (!binding || typeof options.sessionId !== 'string' || !options.sessionId) {
    if (typeof options.recordPendingEvidence === 'function') {
      await options.recordPendingEvidence({
        testerId,
        resourceKeyHash: hashDomain('nv-alpha-provider-context-v1', [
          testerId, String(account.provider || 'github')
        ]),
        reasonCode: binding ? 'PROVIDER_SESSION_CONTEXT_MISSING' : 'PROVIDER_BINDING_CONTEXT_MISSING'
      });
    }
    return pendingResult(account, []);
  }
  assertFunction(options, 'enumerateProviderWebhooks');
  assertFunction(options, 'prepareDisconnect');
  assertFunction(options, 'removeProviderWebhook');
  assertFunction(options, 'completeProviderWebhookCleanup');
  assertFunction(options, 'finalizeDisconnect');

  const sessionKeyHash = providerSessionKeyHash(options.sessionId);
  let webhooks;
  let inventoryFailure = false;
  const credentialUnavailable = account.authMethod !== 'github-app'
    && typeof account.token !== 'string';
  try {
    webhooks = await options.enumerateProviderWebhooks({ account, tester: options.tester });
    if (!Array.isArray(webhooks)) throw new TypeError('provider webhook inventory must be an array');
  } catch {
    webhooks = [];
    inventoryFailure = true;
  }

  const inventory = [];
  const seenHashes = new Map();
  for (const webhook of webhooks) {
    const reference = webhookReference(webhook);
    const resourceKeyHash = providerResourceKeyHash({
      provider: binding.provider,
      authority: binding.authority,
      resourceType: 'provider-webhook',
      resourceReference: reference
    });
    if (
      webhook.alphaResourceKeyHash !== undefined
      && webhook.alphaResourceKeyHash !== null
      && webhook.alphaResourceKeyHash !== resourceKeyHash
    ) {
      throw new Error('provider webhook inventory hash is inconsistent');
    }
    const prior = seenHashes.get(resourceKeyHash);
    if (prior && prior !== reference) {
      throw new Error('provider resource hash collision');
    }
    if (prior) continue;
    seenHashes.set(resourceKeyHash, reference);
    inventory.push({ webhook, resourceKeyHash });
  }

  let prepared;
  try {
    prepared = await options.prepareDisconnect({
      testerId,
      identityKey: binding.identityKey,
      provider: binding.provider,
      currentSessionKeyHash: sessionKeyHash,
      webhookResourceKeyHashes: inventory.map(item => item.resourceKeyHash),
      inventoryAvailable: !inventoryFailure,
      reasonCode: inventoryFailure || credentialUnavailable
        ? 'PROVIDER_INVENTORY_UNAVAILABLE'
        : ''
    });
  } catch {
    return pendingResult(account, []);
  }
  if (!prepared || typeof prepared !== 'object' || Array.isArray(prepared)) {
    throw new TypeError('disconnect preparation returned invalid evidence');
  }
  const preparedWebhooks = Array.isArray(prepared.webhooks) ? prepared.webhooks : null;
  const preparedSessions = Array.isArray(prepared.providerSessions)
    ? prepared.providerSessions
    : null;
  if (!preparedWebhooks || !preparedSessions || !preparedSessions.length) {
    return pendingResult(account, []);
  }
  const inventoryByHash = new Map(inventory.map(item => [item.resourceKeyHash, item.webhook]));
  const webhookTasks = preparedWebhooks.map(item => {
    const resourceKeyHash = requirePreparedHash(item, 'provider webhook');
    const task = cleanupTaskValue(item);
    return {
      resourceKeyHash,
      cleanupId: task.cleanupId,
      status: task.status,
      requesterOwned: item.requesterOwned === true,
      shared: item.shared === true,
      webhook: inventoryByHash.get(resourceKeyHash) || null
    };
  });
  const sessionTasks = preparedSessions.map(item => ({
    resourceKeyHash: requirePreparedHash(item, 'provider session'),
    ...cleanupTaskValue(item)
  }));

  const preparedByHash = new Map();
  let exactCoverage = true;
  for (const item of webhookTasks) {
    if (preparedByHash.has(item.resourceKeyHash)) exactCoverage = false;
    preparedByHash.set(item.resourceKeyHash, item);
  }
  for (const item of inventory) {
    const task = preparedByHash.get(item.resourceKeyHash);
    if (!task || task.requesterOwned !== true) exactCoverage = false;
  }
  if (!exactCoverage) {
    return pendingResult(account, [
      ...webhookTasks.map(item => item.cleanupId),
      ...sessionTasks.map(item => item.cleanupId)
    ]);
  }

  if (inventoryFailure || credentialUnavailable) {
    return pendingResult(account, [
      ...webhookTasks.map(item => item.cleanupId),
      ...sessionTasks.map(item => item.cleanupId)
    ]);
  }

  const pendingIds = [];
  for (const item of webhookTasks) {
    let providerAbsent = false;
    if (item.status !== 'verified' && !item.shared) {
      if (!item.webhook) {
        pendingIds.push(item.cleanupId);
        continue;
      }

      try {
        const deletion = await options.removeProviderWebhook({
          account,
          webhook: item.webhook,
          tester: options.tester
        });
        providerAbsent = isAbsent(deletion);
      } catch (error) {
        providerAbsent = is404(error);
      }
      if (!providerAbsent && typeof options.readProviderWebhook === 'function') {
        try {
          const readback = await options.readProviderWebhook({
            account,
            webhook: item.webhook,
            tester: options.tester
          });
          providerAbsent = isAbsent(readback);
        } catch (error) {
          providerAbsent = is404(error);
        }
      }
      if (!providerAbsent) {
        pendingIds.push(item.cleanupId);
        continue;
      }
    }
    try {
      const completion = await options.completeProviderWebhookCleanup({
        testerId,
        identityKey: binding.identityKey,
        provider: binding.provider,
        cleanupId: item.cleanupId,
        resourceKeyHash: item.resourceKeyHash,
        providerVerifiedAbsent: providerAbsent
      });
      if (!(completion && completion.verified === true)) {
        pendingIds.push(item.cleanupId);
      }
    } catch {
      pendingIds.push(item.cleanupId);
    }
  }
  if (pendingIds.length) return pendingResult(account, pendingIds);

  try {
    const finalized = await options.finalizeDisconnect({
      testerId,
      identityKey: binding.identityKey,
      provider: binding.provider,
      providerSessionTasks: sessionTasks.map(item => ({
        resourceKeyHash: item.resourceKeyHash,
        cleanupId: item.cleanupId
      }))
    });
    if (!(finalized === true || (finalized && finalized.finalized === true))) {
      return pendingResult(account, sessionTasks.map(item => item.cleanupId));
    }
    const sharedProviderState = !!(
      finalized && typeof finalized === 'object' && finalized.sharedProviderState === true
    );
    if (!sharedProviderState && typeof options.invalidateBroker === 'function') {
      options.invalidateBroker(account);
    }
  } catch {
    return pendingResult(account, sessionTasks.map(item => item.cleanupId));
  }
  return verifiedResult(account);
}

module.exports = Object.freeze({
  disconnectProviderAccount,
  providerResourceKeyHash,
  providerSessionKeyHash
});
