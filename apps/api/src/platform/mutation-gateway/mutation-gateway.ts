import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { normalizeAuthorizationSnapshot } from '../authorization/authorization-resolver.ts';
import { normalizeRepositoryScope } from '../authorization/repository-scope.ts';
import { executionContractForAction, validateCoverageInventory } from './mutation-coverage.ts';

/* What a descriptor is, the action catalogue and the descriptor's guard are the mutation contract. */
import * as mutation from '../../../../../packages/contracts/src/mutation.ts';
import type {
  MutationDescriptor,
  PolicyEvaluator,
  VerifiedPolicyDecision
} from '../../../../../packages/contracts/src/mutation.ts';
import { deepFreeze } from '../../../../../packages/contracts/src/guards.ts';
import { isMutationId } from '../../../../../packages/contracts/src/ids.ts';
import type { JsonObject } from '../../../../../packages/contracts/src/guards.ts';

export { MUTATION_ACTIONS } from '../../../../../packages/contracts/src/mutation.ts';

const { MUTATION_ACTIONS, POLICY_OUTCOMES } = mutation;
const MUTATING_METHODS = new Set<string>(mutation.MUTATING_METHODS);
const OPERATION_ID_DOMAIN = 'nebulaverse-x.provider-write.operation-id.v1';
const MAX_OPERATION_TARGET_BYTES = 64 * 1024;

export class MutationGatewayError extends Error {
  override readonly name = 'MutationGatewayError';
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status = 403) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

validateCoverageInventory(MUTATION_ACTIONS);

function fail(message: string, code: string, status = 403): never {
  throw new MutationGatewayError(message, code, status);
}

function isPlainObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function normalizeMetadata(input: unknown): Readonly<JsonObject> {
  return mutation.normalizeMutationMetadata(input, fail);
}
export { normalizeMetadata as normalizeMutationMetadata };

export function providerOperationId(input: unknown = {}): string {
  if (!isPlainObject(input)) fail('Provider operation identity is invalid', 'MUTATION_OPERATION_ID_INVALID', 400);
  const mutationId = String(input.mutationId || '').trim().toLowerCase();
  const providerWriteIndex = Number(input.providerWriteIndex);
  const method = String(input.method || '').trim().toUpperCase();
  const operation = String(input.operation || '').trim().toLowerCase();
  const scopeKey = String(input.scopeKey || '').trim().toLowerCase();
  const transport = String(input.transport || 'api').trim().toLowerCase();
  const apiPath = String(input.apiPath || '').trim();
  if (
    !isMutationId(mutationId) ||
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
  const hash = createHash('sha256');
  for (const [label, value] of [
    ['domain', OPERATION_ID_DOMAIN],
    ['mutationId', mutationId],
    ['providerWriteIndex', String(providerWriteIndex)],
    ['method', method],
    ['operation', operation],
    ['scopeKey', scopeKey],
    ['transport', transport],
    ['apiPath', apiPath]
  ] as const) {
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
export function normalizeMutationDescriptor(input: unknown = {}): MutationDescriptor {
  return mutation.normalizeMutationDescriptor(input, {
    refuse: fail,
    normalizeScope: normalizeRepositoryScope,
    normalizeAuthorization: normalizeAuthorizationSnapshot,
    executionContract: executionContractForAction,
    newMutationId: () => randomUUID()
  });
}

function decodePathPiece(value: unknown): string {
  try { return decodeURIComponent(String(value || '')); }
  catch { return fail('Provider mutation target is malformed', 'MUTATION_TARGET_INVALID', 400); }
}

export interface RepositoryTarget {
  readonly owner: unknown;
  readonly repo: unknown;
}

export function parseProviderRepositoryTarget(providerInput: unknown, apiPathInput: unknown): RepositoryTarget | null {
  const provider = String(providerInput || '').trim().toLowerCase();
  const apiPath = String(apiPathInput || '').split('?', 1)[0] ?? '';
  if (provider === 'github') {
    const repo = apiPath.match(/^\/repos\/([^/]+)\/([^/]+)/);
    if (repo) return { owner: decodePathPiece(repo[1]), repo: decodePathPiece(repo[2]) };
    const star = apiPath.match(/^\/user\/starred\/([^/]+)\/([^/]+)/);
    if (star) return { owner: decodePathPiece(star[1]), repo: decodePathPiece(star[2]) };
  }
  return null;
}

export function classifyProviderOperation(providerInput: unknown, apiPathInput: unknown, methodInput: unknown, transportInput: unknown): string | null {
  const transport = String(transportInput || '').trim();
  const provider = String(providerInput || '').trim().toLowerCase();
  if (provider !== 'github') return null;
  if (transport) return transport;
  const method = String(methodInput || '').trim().toUpperCase();
  const apiPath = String(apiPathInput || '').split('?', 1)[0] ?? '';
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

/* What the gateway tells the event sink: the descriptor's public facts and the step's own. */
export type GatewayEvent = Readonly<Record<string, unknown>> & { readonly type: string };

function publicEvent(type: string, descriptor: MutationDescriptor, extra: Readonly<Record<string, unknown>> = {}): GatewayEvent {
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

/*
 * The policy port (packages/contracts/src/mutation.ts, PolicyEvaluator): an
 * evaluator and the verifier of what it answers, handed in by the composition
 * root. The gateway imports no policy module, so the security core is not part
 * of a dependency cycle with the policy engine it consults.
 */
function requirePolicyEvaluator(policyEvaluator: unknown): PolicyEvaluator | null {
  if (policyEvaluator == null) return null;
  const port = policyEvaluator as Partial<PolicyEvaluator>;
  if (typeof policyEvaluator !== 'object' || typeof port.evaluate !== 'function' || typeof port.verify !== 'function') {
    throw new TypeError('Mutation gateway policyEvaluator must provide evaluate(descriptor) and verify(decision, descriptor)');
  }
  return port as PolicyEvaluator;
}

/* The descriptor a handler runs under, with the policy decision when one was asked for. */
export type MutationContext = MutationDescriptor & { readonly policyDecision?: VerifiedPolicyDecision };

/* A provider write as the transport is about to send it. */
export interface ProviderWriteTarget {
  readonly method?: unknown;
  readonly provider?: unknown;
  readonly owner?: unknown;
  readonly repo?: unknown;
  readonly apiPath?: unknown;
  readonly baseUrl?: unknown;
  readonly transport?: unknown;
  readonly body?: unknown;
}

export interface AuthorizedProviderWrite extends MutationContext {
  readonly providerWrite: { readonly index: number; readonly operation: string; readonly operationId: string };
}

export interface ExecutionSnapshot {
  readonly providerWriteCount: number;
  readonly operationIds: readonly string[];
}

export interface MutationGateway {
  run<T>(input: unknown, callback: () => T | Promise<T>): Promise<T>;
  current(): MutationContext | null;
  executionSnapshot(): ExecutionSnapshot | null;
  assertProviderMutation(target?: ProviderWriteTarget): AuthorizedProviderWrite;
}

export interface MutationGatewayOptions {
  /* Told of each mutation's entry, policy decision and completion; a promise it returns is not awaited. */
  readonly eventSink?: ((event: GatewayEvent) => unknown) | null;
  readonly policyEvaluator?: unknown;
}

interface ActiveMutation {
  readonly descriptor: MutationContext;
  readonly runtime: { providerWriteCount: number; readonly operationIds: string[] };
}

export function createMutationGateway({ eventSink, policyEvaluator: evaluatorInput }: MutationGatewayOptions = {}): MutationGateway {
  if (eventSink != null && typeof eventSink !== 'function') throw new TypeError('Mutation gateway eventSink must be a function');
  const sink = eventSink as ((event: GatewayEvent) => unknown) | null | undefined;
  const policyEvaluator = requirePolicyEvaluator(evaluatorInput);
  const storage = new AsyncLocalStorage<ActiveMutation>();
  const emit = (event: GatewayEvent): void => {
    if (!sink) return;
    try {
      const pending = sink(event) as { readonly catch?: unknown } | null | undefined;
      if (pending && typeof pending.catch === 'function') (pending as Promise<unknown>).catch(() => {});
    } catch {}
  };

  function activeStore(): ActiveMutation | null {
    return storage.getStore() || null;
  }

  function current(): MutationContext | null {
    const active = activeStore();
    return active ? active.descriptor : null;
  }

  function executionSnapshot(): ExecutionSnapshot | null {
    const active = activeStore();
    if (!active) return null;
    return Object.freeze({
      providerWriteCount: active.runtime.providerWriteCount,
      operationIds: Object.freeze([...active.runtime.operationIds])
    });
  }

  async function run<T>(input: unknown, callback: () => T | Promise<T>): Promise<T> {
    if (typeof callback !== 'function') throw new TypeError('Mutation gateway run requires a callback');
    if (current()) fail('Nested mutation gateway contexts are not allowed', 'MUTATION_CONTEXT_NESTED', 409);
    const descriptor = normalizeMutationDescriptor(input);
    emit(publicEvent('mutation.entered', descriptor));
    try {
      let context: MutationContext = descriptor;
      if (policyEvaluator) {
        const rawDecision = await policyEvaluator.evaluate(descriptor);
        const policyDecision = policyEvaluator.verify(rawDecision, descriptor) as VerifiedPolicyDecision | null | undefined;
        /* An outcome the gateway does not know is not permission: it is refused, never read as "not block". */
        if (!policyDecision || typeof policyDecision !== 'object' || !(POLICY_OUTCOMES as readonly unknown[]).includes(policyDecision.enforcementOutcome)) {
          fail('Policy evaluation is unavailable', 'POLICY_EVALUATION_UNAVAILABLE', 503);
        }
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
          ].includes(policyDecision.blockCode as string);
          fail(policyDecision.blockCode === 'POLICY_UNSUPPORTED_ACTIVE_RULES'
            ? 'Policy evaluation cannot safely evaluate the active rules'
            : unavailable ? 'Policy evaluation is unavailable' :
            policyDecision.blockCode === 'POLICY_APPROVAL_REQUIRED' ? 'This mutation requires approval under the active policy' :
              'This mutation is blocked by the active policy',
          policyDecision.blockCode as string, unavailable ? 503 : 403);
        }
      }
      const runtime = { providerWriteCount: 0, operationIds: [] as string[] };
      const result = await storage.run({ descriptor: context, runtime }, callback);
      emit(publicEvent('mutation.completed', descriptor, {
        providerWriteCount: runtime.providerWriteCount,
        operationIds: runtime.operationIds.slice(0, descriptor.execution.maxProviderWrites)
      }));
      return result;
    } catch (error) {
      const code = error && (error as { readonly code?: unknown }).code;
      emit(publicEvent('mutation.failed', descriptor, {
        errorCode: String(code || 'MUTATION_HANDLER_FAILED').slice(0, 100)
      }));
      throw error;
    }
  }

  function assertProviderMutation(target: ProviderWriteTarget = {}): AuthorizedProviderWrite {
    const active = activeStore();
    const descriptor = active && active.descriptor;
    if (!active || !descriptor) return fail('Outbound provider writes must pass through the central mutation gateway', 'MUTATION_GATEWAY_REQUIRED');
    const method = String(target.method || '').trim().toUpperCase();
    if (!MUTATING_METHODS.has(method)) fail('Provider mutation method is invalid', 'MUTATION_METHOD_INVALID', 400);
    const provider = String(target.provider || '').trim().toLowerCase();
    if (provider !== descriptor.provider) fail('Provider write does not match the active mutation context', 'MUTATION_PROVIDER_MISMATCH');
    let parsed: RepositoryTarget | null = target.owner && target.repo
      ? { owner: target.owner, repo: target.repo }
      : parseProviderRepositoryTarget(provider, target.apiPath);
    if (!parsed && descriptor.action === 'repository.create') {
      const body = isPlainObject(target.body) ? target.body : {};
      const repositoryName = String(body.name || body.path || '').trim();
      if (repositoryName) parsed = { owner: descriptor.owner, repo: repositoryName };
    }
    if (!parsed) {
      return fail('Provider write target could not be matched to the active repository scope', 'MUTATION_TARGET_UNRESOLVED');
    }
    const scope = normalizeRepositoryScope({ provider, baseUrl: target.baseUrl, owner: parsed.owner, repo: parsed.repo });
    if (scope.scopeKey !== descriptor.scopeKey) {
      fail('Provider write target does not match the active mutation repository', 'MUTATION_SCOPE_MISMATCH');
    }
    const operation = classifyProviderOperation(provider, target.apiPath, method, target.transport);
    if (!operation) return fail('Provider write operation is not registered in the mutation gateway', 'MUTATION_OPERATION_UNREGISTERED');
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
