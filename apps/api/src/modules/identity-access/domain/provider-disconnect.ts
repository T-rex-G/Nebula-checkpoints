import { createHash } from 'node:crypto';
import { providerRevocationGuidance } from './alpha-privacy.ts';
import type { RevocationGuidance } from './alpha-privacy.ts';
import { isSha256Hex } from '../../../../../../packages/contracts/src/ids.ts';
import { property } from '../../../platform/values/fields.ts';

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Historical identifiers are needed to hash retained cleanup evidence.
const HISTORICAL_PROVIDERS = new Set(['github', 'gitlab', 'gitea']);

type Fields = Readonly<Record<string, unknown>>;

function hashDomain(domain: string, parts: readonly unknown[]): string {
  const hash = createHash('sha256');
  hash.update(domain, 'utf8');
  for (const part of parts) hash.update(`\0${String(part)}`, 'utf8');
  return hash.digest('hex');
}

export function providerSessionKeyHash(sessionId: unknown): string {
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 512) {
    throw new TypeError('sessionId is invalid');
  }
  return hashDomain('nv-alpha-provider-session-v1', [sessionId]);
}

export function providerResourceKeyHash(input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('provider resource hash input is invalid');
  }
  const fields = input as Fields;
  const provider = String(fields.provider || '').toLowerCase();
  const authority = String(fields.authority || '').toLowerCase();
  const resourceType = String(fields.resourceType || '');
  const resourceReference = String(fields.resourceReference == null ? '' : fields.resourceReference);
  if (!HISTORICAL_PROVIDERS.has(provider) || !authority || resourceType !== 'provider-webhook') {
    throw new TypeError('provider resource hash context is invalid');
  }
  if (!resourceReference || resourceReference.length > 1024) {
    throw new TypeError('provider resource reference is invalid');
  }
  return hashDomain('nv-alpha-provider-resource-v1', [
    provider, authority, resourceType, resourceReference
  ]);
}

function webhookReference(webhook: unknown): string {
  if (!webhook || typeof webhook !== 'object' || Array.isArray(webhook)) {
    throw new TypeError('provider webhook inventory item is invalid');
  }
  const fields = webhook as Fields;
  const value = fields.providerHookId ?? fields.hookId ?? fields.id ?? fields.resourceReference;
  const reference = String(value == null ? '' : value);
  if (!reference || reference.length > 1024) {
    throw new TypeError('provider webhook inventory item lacks a bounded reference');
  }
  return reference;
}

function isAbsent(value: unknown): boolean {
  return !!value && (
    property(value, 'verifiedAbsent') === true
    || property(value, 'absent') === true
    || Number(property(value, 'status')) === 404
  );
}

function is404(error: unknown): boolean {
  return Number(error && (property(error, 'status') || property(error, 'statusCode'))) === 404;
}

interface CleanupTask {
  readonly cleanupId: string;
  readonly status: 'pending' | 'verified';
}

function cleanupTaskValue(value: unknown): CleanupTask {
  if (typeof value === 'string') return { cleanupId: value, status: 'pending' };
  if (!value || typeof value !== 'object') {
    throw new TypeError('cleanup task registration returned invalid evidence');
  }
  const cleanupId = String(property(value, 'cleanupId') || '');
  if (!UUID_RX.test(cleanupId)) {
    throw new TypeError('cleanup task registration returned an invalid cleanupId');
  }
  const status = property(value, 'status') === 'verified' ? 'verified' : 'pending';
  return { cleanupId: cleanupId.toLowerCase(), status };
}

function requirePreparedHash(value: unknown, label: string): string {
  const hash = String(value && property(value, 'resourceKeyHash') || '');
  if (!isSha256Hex(hash)) {
    throw new TypeError(`${label} preparation returned an invalid resource hash`);
  }
  return hash;
}

/* What a disconnect reports: whether the provider's state is gone, and how to revoke what only the person can. */
export interface DisconnectResult {
  readonly providerStateRemoved: boolean;
  readonly webhookCleanup: 'pending' | 'verified';
  readonly brokerCacheCleared: boolean;
  readonly providerRevoked: false;
  readonly cleanupId?: string;
  readonly reasonCode?: string;
  readonly revocationGuidance: RevocationGuidance;
}

function pendingResult(account: unknown, cleanupIds: readonly string[]): DisconnectResult {
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

function verifiedResult(account: unknown): DisconnectResult {
  return Object.freeze({
    providerStateRemoved: true,
    webhookCleanup: 'verified',
    brokerCacheCleared: true,
    providerRevoked: false,
    revocationGuidance: providerRevocationGuidance(account)
  });
}

type Step = (input: Fields) => unknown;

/*
 * The provider and the store, handed in. Each step is asked for what it must
 * answer; nothing is claimed absent that a step did not verify.
 */
export interface DisconnectOptions {
  readonly account?: unknown;
  readonly tester?: unknown;
  readonly binding?: unknown;
  readonly sessionId?: unknown;
  readonly recordPendingEvidence?: Step;
  readonly enumerateProviderWebhooks?: Step;
  readonly prepareDisconnect?: Step;
  readonly removeProviderWebhook?: Step;
  readonly readProviderWebhook?: Step;
  readonly completeProviderWebhookCleanup?: Step;
  readonly finalizeDisconnect?: Step;
  readonly invalidateBroker?: (account: unknown) => unknown;
}

type RequiredStep = 'enumerateProviderWebhooks' | 'prepareDisconnect' | 'removeProviderWebhook' | 'completeProviderWebhookCleanup' | 'finalizeDisconnect';

/* A required step, called as the method it is, so a store's own `this` still holds. */
function assertFunction(input: DisconnectOptions, name: RequiredStep): (stepInput: Fields) => unknown {
  const step = input[name];
  if (typeof step !== 'function') throw new TypeError(`${name} must be a function`);
  return stepInput => step.call(input, stepInput);
}

interface Binding {
  readonly testerId: string;
  readonly identityKey: string;
  readonly provider: string;
  readonly authority: string;
}

function safeBinding(input: DisconnectOptions, testerId: string): Binding | null {
  const binding = input && input.binding;
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return null;
  const fields = binding as Fields;
  const identityKey = String(fields.identityKey || '');
  const provider = String(fields.provider || '').toLowerCase();
  const authority = String(fields.authority || '').toLowerCase();
  if (
    String(fields.testerId || '').toLowerCase() !== testerId
    || !isSha256Hex(identityKey)
    || provider !== 'github'
    || authority !== 'github.com'
  ) return null;
  return { testerId, identityKey, provider, authority };
}

export async function disconnectProviderAccount(options: DisconnectOptions): Promise<DisconnectResult> {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('disconnect options must be an object');
  }
  const account = options.account;
  const testerId = String(property(options.tester, 'testerId') || '').toLowerCase();
  if (!account || typeof account !== 'object' || !UUID_RX.test(testerId)) {
    throw new TypeError('disconnect account and tester context are required');
  }
  const accountFields = account as Fields;
  const provider = String(accountFields.provider || 'github').toLowerCase();
  if (provider !== 'github') {
    if (!HISTORICAL_PROVIDERS.has(provider)) throw new TypeError('provider is unsupported');
    // Local deletion remains an operator privacy action; external resources must
    // never be claimed absent now that their adapters have been retired.
    if (typeof options.recordPendingEvidence === 'function') {
      await options.recordPendingEvidence({
        testerId,
        resourceKeyHash: hashDomain('nv-alpha-provider-context-v1', [testerId, provider]),
        reasonCode: 'PROVIDER_RETIRED_MANUAL_CLEANUP_REQUIRED'
      });
    }
    return Object.freeze({ ...pendingResult(account, []), reasonCode: 'PROVIDER_RETIRED_MANUAL_CLEANUP_REQUIRED' });
  }
  const binding = safeBinding(options, testerId);
  if (!binding || typeof options.sessionId !== 'string' || !options.sessionId) {
    if (typeof options.recordPendingEvidence === 'function') {
      await options.recordPendingEvidence({
        testerId,
        resourceKeyHash: hashDomain('nv-alpha-provider-context-v1', [
          testerId, String(accountFields.provider || 'github')
        ]),
        reasonCode: binding ? 'PROVIDER_SESSION_CONTEXT_MISSING' : 'PROVIDER_BINDING_CONTEXT_MISSING'
      });
    }
    return pendingResult(account, []);
  }
  const enumerateProviderWebhooks = assertFunction(options, 'enumerateProviderWebhooks');
  const prepareDisconnect = assertFunction(options, 'prepareDisconnect');
  const removeProviderWebhook = assertFunction(options, 'removeProviderWebhook');
  const completeProviderWebhookCleanup = assertFunction(options, 'completeProviderWebhookCleanup');
  const finalizeDisconnect = assertFunction(options, 'finalizeDisconnect');

  const sessionKeyHash = providerSessionKeyHash(options.sessionId);
  let webhooks: readonly unknown[];
  let inventoryFailure = false;
  const credentialUnavailable = accountFields.authMethod !== 'github-app'
    && typeof accountFields.token !== 'string';
  try {
    const listed = await enumerateProviderWebhooks({ account, tester: options.tester });
    if (!Array.isArray(listed)) throw new TypeError('provider webhook inventory must be an array');
    webhooks = listed;
  } catch {
    webhooks = [];
    inventoryFailure = true;
  }

  const inventory: { readonly webhook: Fields; readonly resourceKeyHash: string }[] = [];
  const seenHashes = new Map<string, string>();
  for (const webhook of webhooks) {
    const reference = webhookReference(webhook);
    const item = webhook as Fields;
    const resourceKeyHash = providerResourceKeyHash({
      provider: binding.provider,
      authority: binding.authority,
      resourceType: 'provider-webhook',
      resourceReference: reference
    });
    if (
      item.alphaResourceKeyHash !== undefined
      && item.alphaResourceKeyHash !== null
      && item.alphaResourceKeyHash !== resourceKeyHash
    ) {
      throw new Error('provider webhook inventory hash is inconsistent');
    }
    const prior = seenHashes.get(resourceKeyHash);
    if (prior && prior !== reference) {
      throw new Error('provider resource hash collision');
    }
    if (prior) continue;
    seenHashes.set(resourceKeyHash, reference);
    inventory.push({ webhook: item, resourceKeyHash });
  }

  let prepared: unknown;
  try {
    prepared = await prepareDisconnect({
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
  const preparedFields = prepared as Fields;
  const preparedWebhooks: readonly unknown[] | null = Array.isArray(preparedFields.webhooks) ? preparedFields.webhooks : null;
  const preparedSessions: readonly unknown[] | null = Array.isArray(preparedFields.providerSessions)
    ? preparedFields.providerSessions
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
      requesterOwned: property(item, 'requesterOwned') === true,
      shared: property(item, 'shared') === true,
      webhook: inventoryByHash.get(resourceKeyHash) || null
    };
  });
  const sessionTasks = preparedSessions.map(item => ({
    resourceKeyHash: requirePreparedHash(item, 'provider session'),
    ...cleanupTaskValue(item)
  }));

  const preparedByHash = new Map<string, (typeof webhookTasks)[number]>();
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

  const pendingIds: string[] = [];
  for (const item of webhookTasks) {
    let providerAbsent = false;
    if (item.status !== 'verified' && !item.shared) {
      if (!item.webhook) {
        pendingIds.push(item.cleanupId);
        continue;
      }

      try {
        const deletion = await removeProviderWebhook({
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
      const completion = await completeProviderWebhookCleanup({
        testerId,
        identityKey: binding.identityKey,
        provider: binding.provider,
        cleanupId: item.cleanupId,
        resourceKeyHash: item.resourceKeyHash,
        providerVerifiedAbsent: providerAbsent
      });
      if (!(completion && property(completion, 'verified') === true)) {
        pendingIds.push(item.cleanupId);
      }
    } catch {
      pendingIds.push(item.cleanupId);
    }
  }
  if (pendingIds.length) return pendingResult(account, pendingIds);

  try {
    const finalized = await finalizeDisconnect({
      testerId,
      identityKey: binding.identityKey,
      provider: binding.provider,
      providerSessionTasks: sessionTasks.map(item => ({
        resourceKeyHash: item.resourceKeyHash,
        cleanupId: item.cleanupId
      }))
    });
    if (!(finalized === true || (finalized && property(finalized, 'finalized') === true))) {
      return pendingResult(account, sessionTasks.map(item => item.cleanupId));
    }
    const sharedProviderState = !!(
      finalized && typeof finalized === 'object' && property(finalized, 'sharedProviderState') === true
    );
    if (!sharedProviderState && typeof options.invalidateBroker === 'function') {
      options.invalidateBroker(account);
    }
  } catch {
    return pendingResult(account, sessionTasks.map(item => item.cleanupId));
  }
  return verifiedResult(account);
}
