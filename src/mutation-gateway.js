'use strict';

const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const { normalizePolicyScope } = require('./governance-model');
const { normalizeAuthorizationSnapshot } = require('./authorization-resolver');
const { executionContractForAction, validateCoverageInventory } = require('./mutation-coverage');

/* What a descriptor is, the action catalogue and the descriptor's guard are the mutation contract. */
const mutation = require('../packages/contracts/src/mutation.ts');
const { deepFreeze } = require('../packages/contracts/src/guards.ts');

const { MUTATION_ACTIONS } = mutation;
const MUTATING_METHODS = new Set(mutation.MUTATING_METHODS);
const OPERATION_ID_DOMAIN = 'nebulaverse-x.provider-write.operation-id.v1';
const MAX_OPERATION_TARGET_BYTES = 64 * 1024;

class MutationGatewayError extends Error {
  constructor(message, code, status = 403) {
    super(message);
    this.name = 'MutationGatewayError';
    this.code = code;
    this.status = status;
  }
}

validateCoverageInventory(MUTATION_ACTIONS);

function fail(message, code, status = 403) {
  throw new MutationGatewayError(message, code, status);
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function normalizeMetadata(input) {
  return mutation.normalizeMutationMetadata(input, fail);
}

function providerOperationId(input = {}) {
  if (!isPlainObject(input)) fail('Provider operation identity is invalid', 'MUTATION_OPERATION_ID_INVALID', 400);
  const mutationId = String(input.mutationId || '').trim().toLowerCase();
  const providerWriteIndex = Number(input.providerWriteIndex);
  const method = String(input.method || '').trim().toUpperCase();
  const operation = String(input.operation || '').trim().toLowerCase();
  const scopeKey = String(input.scopeKey || '').trim().toLowerCase();
  const transport = String(input.transport || 'api').trim().toLowerCase();
  const apiPath = String(input.apiPath || '').trim();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(mutationId) ||
    !Number.isSafeInteger(providerWriteIndex) ||
    providerWriteIndex < 1 ||
    !MUTATING_METHODS.has(method) ||
    !operation ||
    !scopeKey ||
    !transport ||
    (!apiPath && transport === 'api') ||
    Buffer.byteLength(apiPath, 'utf8') > MAX_OPERATION_TARGET_BYTES ||
    Buffer.byteLength(transport, 'utf8') > 256
  ) {
    fail('Provider operation identity is invalid', 'MUTATION_OPERATION_ID_INVALID', 400);
  }
  const hash = crypto.createHash('sha256');
  for (const [label, value] of [
    ['domain', OPERATION_ID_DOMAIN],
    ['mutationId', mutationId],
    ['providerWriteIndex', String(providerWriteIndex)],
    ['method', method],
    ['operation', operation],
    ['scopeKey', scopeKey],
    ['transport', transport],
    ['apiPath', apiPath]
  ]) {
    const labelBytes = Buffer.from(label, 'utf8');
    const valueBytes = Buffer.from(value, 'utf8');
    const lengths = Buffer.allocUnsafe(8);
    lengths.writeUInt32BE(labelBytes.length, 0);
    lengths.writeUInt32BE(valueBytes.length, 4);
    hash.update(lengths);
    hash.update(labelBytes);
    hash.update(valueBytes);
  }
  return hash.digest('hex');
}

/*
 * The descriptor's guard, refusing with this module's error. The scope, the
 * authorization snapshot and the execution contract each keep their own.
 */
function normalizeMutationDescriptor(input = {}) {
  return mutation.normalizeMutationDescriptor(input, {
    refuse: fail,
    normalizeScope: normalizePolicyScope,
    normalizeAuthorization: normalizeAuthorizationSnapshot,
    executionContract: executionContractForAction,
    newMutationId: () => crypto.randomUUID()
  });
}

function decodePathPiece(value) {
  try { return decodeURIComponent(String(value || '')); }
  catch { fail('Provider mutation target is malformed', 'MUTATION_TARGET_INVALID', 400); }
}

function parseProviderRepositoryTarget(providerInput, apiPathInput) {
  const provider = String(providerInput || '').trim().toLowerCase();
  const apiPath = String(apiPathInput || '').split('?', 1)[0];
  if (provider === 'github') {
    const repo = apiPath.match(/^\/repos\/([^/]+)\/([^/]+)/);
    if (repo) return { owner: decodePathPiece(repo[1]), repo: decodePathPiece(repo[2]) };
    const star = apiPath.match(/^\/user\/starred\/([^/]+)\/([^/]+)/);
    if (star) return { owner: decodePathPiece(star[1]), repo: decodePathPiece(star[2]) };
  }
  return null;
}

function classifyProviderOperation(providerInput, apiPathInput, methodInput, transportInput) {
  const transport = String(transportInput || '').trim();
  const provider = String(providerInput || '').trim().toLowerCase();
  if (provider !== 'github') return null;
  if (transport) return transport;
  const method = String(methodInput || '').trim().toUpperCase();
  const apiPath = String(apiPathInput || '').split('?', 1)[0];
  if (provider === 'github') {
    if (method === 'POST' && apiPath === '/user/repos') return 'repository.create';
    const star = apiPath.match(/^\/user\/starred\/[^/]+\/[^/]+$/);
    if (star && method === 'PUT') return 'repository.star';
    if (star && method === 'DELETE') return 'repository.unstar';
    const repo = apiPath.match(/^\/repos\/[^/]+\/[^/]+(\/.*)?$/);
    if (!repo) return null;
    const suffix = repo[1] || '';
    if (!suffix && method === 'DELETE') return 'repository.delete';
    if (suffix === '/git/refs' && method === 'POST') return 'git.refs.create';
    if (/^\/git\/refs\/heads\//.test(suffix) && method === 'DELETE') return 'git.refs.delete';
    if (/^\/git\/refs\/heads\//.test(suffix) && method === 'PATCH') return 'git.refs.update';
    if (suffix === '/git/blobs' && method === 'POST') return 'git.blob.create';
    if (suffix === '/git/trees' && method === 'POST') return 'git.tree.create';
    if (suffix === '/git/commits' && method === 'POST') return 'git.commit.create';
    if (suffix === '/pulls' && method === 'POST') return 'pull.create';
    if (/^\/pulls\/\d+\/merge$/.test(suffix) && method === 'PUT') return 'pull.merge';
    if (/^\/pulls\/\d+\/reviews$/.test(suffix) && method === 'POST') return 'pull.review';
    if (suffix === '/issues' && method === 'POST') return 'issue.create';
    if (/^\/issues\/\d+\/comments$/.test(suffix) && method === 'POST') return 'issue.comment';
    if (/^\/issues\/\d+$/.test(suffix) && method === 'PATCH') return 'issue.update';
    if (/^\/actions\/runs\/[^/]+\/rerun$/.test(suffix) && method === 'POST') return 'workflow.rerun';
    if (suffix === '/releases' && method === 'POST') return 'release.create';
    if (suffix === '/hooks' && method === 'POST') return 'webhook.connect';
    if (/^\/hooks\/[^/]+$/.test(suffix) && method === 'DELETE') return 'webhook.disconnect';
  }
  return null;
}

function publicEvent(type, descriptor, extra = {}) {
  return Object.freeze({
    type,
    mutationId: descriptor.mutationId,
    action: descriptor.action,
    risk: descriptor.risk,
    provider: descriptor.provider,
    authority: descriptor.authority,
    owner: descriptor.owner,
    repo: descriptor.repo,
    scopeKey: descriptor.scopeKey,
    actorIdentityKey: descriptor.actorIdentityKey,
    ...extra
  });
}

function createMutationGateway({ eventSink, policyEvaluator } = {}) {
  if (eventSink != null && typeof eventSink !== 'function') throw new TypeError('Mutation gateway eventSink must be a function');
  if (policyEvaluator != null && typeof policyEvaluator !== 'function') throw new TypeError('Mutation gateway policyEvaluator must be a function');
  const storage = new AsyncLocalStorage();
  const emit = event => {
    if (!eventSink) return;
    try {
      const pending = eventSink(event);
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    } catch {}
  };

  function activeStore() {
    return storage.getStore() || null;
  }

  function current() {
    const active = activeStore();
    return active ? active.descriptor : null;
  }

  function executionSnapshot() {
    const active = activeStore();
    if (!active) return null;
    return Object.freeze({
      providerWriteCount: active.runtime.providerWriteCount,
      operationIds: Object.freeze([...active.runtime.operationIds])
    });
  }

  async function run(input, callback) {
    if (typeof callback !== 'function') throw new TypeError('Mutation gateway run requires a callback');
    if (current()) fail('Nested mutation gateway contexts are not allowed', 'MUTATION_CONTEXT_NESTED', 409);
    const descriptor = normalizeMutationDescriptor(input);
    emit(publicEvent('mutation.entered', descriptor));
    try {
      let context = descriptor;
      if (policyEvaluator) {
        const rawDecision = await policyEvaluator(descriptor);
        const { normalizePolicyDecision } = require('./governance-enforcement');
        const policyDecision = normalizePolicyDecision(rawDecision, descriptor);
        context = deepFreeze({ ...descriptor, policyDecision });
        emit(publicEvent('policy.evaluated', descriptor, {
          decisionId: policyDecision.decisionId || null,
          source: policyDecision.source,
          effectiveEffect: policyDecision.effectiveEffect,
          rolloutMode: policyDecision.rolloutMode,
          enforcementOutcome: policyDecision.enforcementOutcome,
          warningCodes: policyDecision.warningCodes.slice(0, 16),
          controlMappingStatus: policyDecision.controlMapping.status,
          controlMappingHash: policyDecision.controlMapping.mappingHash
        }));
        if (policyDecision.enforcementOutcome === 'block') {
          emit(publicEvent('policy.blocked', descriptor, {
            decisionId: policyDecision.decisionId || null,
            blockCode: policyDecision.blockCode
          }));
          const unavailable = [
            'POLICY_EVALUATION_UNAVAILABLE',
            'POLICY_UNSUPPORTED_ACTIVE_RULES'
          ].includes(policyDecision.blockCode);
          fail(policyDecision.blockCode === 'POLICY_UNSUPPORTED_ACTIVE_RULES'
            ? 'Policy evaluation cannot safely evaluate the active rules'
            : unavailable ? 'Policy evaluation is unavailable' :
            policyDecision.blockCode === 'POLICY_APPROVAL_REQUIRED' ? 'This mutation requires approval under the active policy' :
              'This mutation is blocked by the active policy',
          policyDecision.blockCode, unavailable ? 503 : 403);
        }
      }
      const runtime = { providerWriteCount: 0, operationIds: [] };
      const result = await storage.run({ descriptor: context, runtime }, callback);
      emit(publicEvent('mutation.completed', descriptor, {
        providerWriteCount: runtime.providerWriteCount,
        operationIds: runtime.operationIds.slice(0, descriptor.execution.maxProviderWrites)
      }));
      return result;
    } catch (error) {
      emit(publicEvent('mutation.failed', descriptor, {
        errorCode: String(error && error.code || 'MUTATION_HANDLER_FAILED').slice(0, 100)
      }));
      throw error;
    }
  }

  function assertProviderMutation(target = {}) {
    const active = activeStore();
    const descriptor = active && active.descriptor;
    if (!descriptor) fail('Outbound provider writes must pass through the central mutation gateway', 'MUTATION_GATEWAY_REQUIRED');
    const method = String(target.method || '').trim().toUpperCase();
    if (!MUTATING_METHODS.has(method)) fail('Provider mutation method is invalid', 'MUTATION_METHOD_INVALID', 400);
    const provider = String(target.provider || '').trim().toLowerCase();
    if (provider !== descriptor.provider) fail('Provider write does not match the active mutation context', 'MUTATION_PROVIDER_MISMATCH');
    let parsed = target.owner && target.repo
      ? { owner: target.owner, repo: target.repo }
      : parseProviderRepositoryTarget(provider, target.apiPath);
    if (!parsed && descriptor.action === 'repository.create') {
      const body = isPlainObject(target.body) ? target.body : {};
      const repositoryName = String(body.name || body.path || '').trim();
      if (repositoryName) parsed = { owner: descriptor.owner, repo: repositoryName };
    }
    if (!parsed) {
      fail('Provider write target could not be matched to the active repository scope', 'MUTATION_TARGET_UNRESOLVED');
    }
    const scope = normalizePolicyScope({ provider, baseUrl: target.baseUrl, owner: parsed.owner, repo: parsed.repo });
    if (scope.scopeKey !== descriptor.scopeKey) {
      fail('Provider write target does not match the active mutation repository', 'MUTATION_SCOPE_MISMATCH');
    }
    const operation = classifyProviderOperation(provider, target.apiPath, method, target.transport);
    if (!operation) fail('Provider write operation is not registered in the mutation gateway', 'MUTATION_OPERATION_UNREGISTERED');
    const definition = MUTATION_ACTIONS[descriptor.action];
    if (!definition.operations.includes(operation)) {
      fail('Provider write operation does not match the active mutation action', 'MUTATION_ACTION_MISMATCH');
    }
    const nextIndex = active.runtime.providerWriteCount + 1;
    if (nextIndex > descriptor.execution.maxProviderWrites) {
      fail('Provider write count exceeds the registered mutation execution contract', 'MUTATION_PROVIDER_WRITE_LIMIT', 409);
    }
    const operationId = providerOperationId({
      mutationId: descriptor.mutationId,
      providerWriteIndex: nextIndex,
      method,
      operation,
      scopeKey: scope.scopeKey,
      transport: target.transport || 'api',
      apiPath: target.apiPath || ''
    });
    active.runtime.providerWriteCount = nextIndex;
    active.runtime.operationIds.push(operationId);
    emit(publicEvent('provider.write.authorized', descriptor, {
      method,
      operation,
      operationId,
      providerWriteIndex: nextIndex,
      transport: String(target.transport || 'api').slice(0, 80)
    }));
    return deepFreeze({ ...descriptor, providerWrite: { index: nextIndex, operation, operationId } });
  }

  return Object.freeze({ run, current, executionSnapshot, assertProviderMutation });
}

module.exports = Object.freeze({
  MutationGatewayError,
  MUTATION_ACTIONS,
  normalizeMutationDescriptor,
  normalizeMutationMetadata: normalizeMetadata,
  providerOperationId,
  parseProviderRepositoryTarget,
  classifyProviderOperation,
  createMutationGateway
});
