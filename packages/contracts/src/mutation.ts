/*
 * A governed change to a repository, described before it happens.
 *
 * Every write the server makes on someone's behalf -- a commit, a merge, a
 * branch reset, a policy activated, a finding's risk accepted -- enters the
 * mutation gateway as a descriptor: which registered action it is, the
 * repository, the accountable actor, the route, bounded credential-free
 * metadata, the step-up it consumed, and the authorization evidence it rests
 * on. Policy decisions and control mappings are derived inside the gateway
 * and are refused if a caller supplies them.
 *
 * The action catalogue has no prototype, so a name like `constructor` is not
 * an action. Ported from src/mutation-gateway.js with that one correction and
 * otherwise unchanged behaviour and codes.
 */
import { deepFreeze, refuseWithContractError, utf8ByteLength } from './guards.ts';
import type { JsonObject, Refuse } from './guards.ts';
import { IDENTITY_KEY, MUTATION_ID } from './ids.ts';
import type { IdentityKey, MutationId } from './ids.ts';
import { normalizeAuthorizationSnapshot } from './actor.ts';
import type { AuthorizationSnapshot } from './actor.ts';
import { normalizePolicyScope } from './scope.ts';
import type { Provider, RepositoryScope } from './scope.ts';

export const MUTATION_CONTRACT_VERSION = 3;

export const MUTATING_METHODS = Object.freeze(['POST', 'PUT', 'PATCH', 'DELETE'] as const);
export type MutatingMethod = (typeof MUTATING_METHODS)[number];
export const ASSURANCE_LEVELS = Object.freeze(['credential', 'oauth-session', 'github-app'] as const);
export type AssuranceLevel = (typeof ASSURANCE_LEVELS)[number];
export const MUTATION_RISKS = Object.freeze(['low', 'medium', 'high', 'critical'] as const);
export type MutationRisk = (typeof MUTATION_RISKS)[number];
/* Who an action's authorization must name: whoever executes it, or the person accountable for a governance decision. */
export const ACTOR_BINDINGS = Object.freeze(['execution', 'governance'] as const);
export type ActorBinding = (typeof ACTOR_BINDINGS)[number];
/* The actions that cannot run without a fresh, single-use step-up. */
export const STEP_UP_ACTIONS = Object.freeze(['repository.delete', 'branch.reset', 'pull.merge'] as const);
export type StepUpAction = (typeof STEP_UP_ACTIONS)[number];

export const METADATA_LIMITS = Object.freeze({ bytes: 16 * 1024, depth: 6, keys: 80, arrayItems: 100, stringLength: 2048 });

export interface MutationActionDefinition {
  readonly category: string;
  readonly risk: MutationRisk;
  readonly description: string;
  readonly operations: readonly string[];
  readonly stepUpAction: StepUpAction | null;
  readonly actorBinding: ActorBinding;
}

function defineAction(category: string, risk: MutationRisk, description: string, operations: readonly string[],
  stepUpAction: StepUpAction | null = null, actorBinding: ActorBinding = 'execution'): MutationActionDefinition {
  return Object.freeze({ category, risk, description, operations: Object.freeze([...operations]), stepUpAction, actorBinding });
}

export const CONTENT_OPERATIONS = Object.freeze([
  'git.blob.create', 'git.tree.create', 'git.commit.create', 'git.refs.update',
  'git-receive-pack', 'git-lfs.batch', 'git-lfs.upload', 'git-lfs.verify'
]);

const ACTION_TABLE = {
  'repository.create': defineAction('repository', 'high', 'Create a repository', ['repository.create']),
  'repository.delete': defineAction('repository', 'critical', 'Delete a repository', ['repository.delete'], 'repository.delete'),
  'branch.create': defineAction('branch', 'medium', 'Create a branch', ['git.refs.create']),
  'branch.delete': defineAction('branch', 'high', 'Delete a branch', ['git.refs.delete']),
  'branch.reset': defineAction('branch', 'critical', 'Force a branch reference to a commit', ['git.refs.update'], 'branch.reset'),
  'file.write': defineAction('content', 'high', 'Create or update repository content', CONTENT_OPERATIONS),
  'file.delete': defineAction('content', 'high', 'Delete repository content', CONTENT_OPERATIONS),
  'file.rename': defineAction('content', 'high', 'Rename repository content', CONTENT_OPERATIONS),
  'file.batch': defineAction('content', 'high', 'Apply a batch of content changes', CONTENT_OPERATIONS),
  'file.upload': defineAction('content', 'high', 'Upload repository content', CONTENT_OPERATIONS),
  'directory.move': defineAction('content', 'high', 'Move a repository directory', CONTENT_OPERATIONS),
  'git.blob.create': defineAction('content', 'medium', 'Create a Git object blob', ['git.blob.create']),
  'commit.revert': defineAction('history', 'high', 'Create a revert commit', CONTENT_OPERATIONS),
  'commit.restore': defineAction('history', 'high', 'Restore repository content from history', ['git.commit.create', 'git.refs.update']),
  'commit.restore-paths': defineAction('history', 'high', 'Restore selected paths from history', CONTENT_OPERATIONS),
  'pull.create': defineAction('collaboration', 'medium', 'Create a pull or merge request', ['pull.create']),
  'pull.merge': defineAction('collaboration', 'critical', 'Merge a pull or merge request', ['pull.merge'], 'pull.merge'),
  'pull.review': defineAction('collaboration', 'medium', 'Submit a pull request review', ['pull.review']),
  'issue.create': defineAction('collaboration', 'medium', 'Create an issue', ['issue.create']),
  'issue.comment': defineAction('collaboration', 'medium', 'Comment on an issue', ['issue.comment']),
  'issue.update': defineAction('collaboration', 'medium', 'Update issue state', ['issue.update']),
  'repository.star': defineAction('user-preference', 'low', 'Star a repository', ['repository.star']),
  'repository.unstar': defineAction('user-preference', 'low', 'Unstar a repository', ['repository.unstar']),
  'workflow.rerun': defineAction('automation', 'high', 'Rerun an automation workflow', ['workflow.rerun']),
  'release.create': defineAction('release', 'high', 'Create a release', ['release.create']),
  'recovery.restore-refs': defineAction('recovery', 'critical', 'Restore repository references', ['git.refs.create', 'git.refs.update']),
  'webhook.connect': defineAction('integration', 'high', 'Create a repository webhook', ['webhook.connect', 'webhook.disconnect']),
  'webhook.disconnect': defineAction('integration', 'high', 'Delete a repository webhook', ['webhook.disconnect']),
  'governance.policy.create': defineAction('governance', 'medium', 'Create repository governance policy metadata', [], null, 'governance'),
  'governance.draft.create': defineAction('governance', 'medium', 'Create a repository governance policy draft', [], null, 'governance'),
  'governance.draft.update': defineAction('governance', 'medium', 'Update a repository governance policy draft', [], null, 'governance'),
  'governance.draft.submit': defineAction('governance', 'high', 'Submit a repository governance draft as an immutable version', [], null, 'governance'),
  'governance.reviewer.assign': defineAction('governance', 'medium', 'Claim reviewer assignment for an immutable policy version', [], null, 'governance'),
  'governance.approval.decide': defineAction('governance', 'high', 'Record an immutable governance review decision', [], null, 'governance'),
  'governance.policy.activate': defineAction('governance', 'critical', 'Activate an approved evidence-backed policy version', [], null, 'governance'),
  'governance.policy.rollback': defineAction('governance', 'critical', 'Rollback to a previously evidence-backed active policy version', [], null, 'governance'),
  'governance.exception.request': defineAction('governance', 'high', 'Request a time-bounded policy exception or waiver', [], null, 'governance'),
  'governance.exception.decide': defineAction('governance', 'critical', 'Approve or reject a time-bounded policy exception or waiver', [], null, 'governance'),
  'governance.exception.revoke': defineAction('governance', 'critical', 'Revoke an approved policy exception or waiver', [], null, 'governance'),
  /*
   * The rest of a policy's life. Switching a policy off and archiving it are
   * critical for the same reason activation is: they change what is enforced.
   * Restoring and withdrawing change what can be enforced later; discarding a
   * draft changes nothing anybody relies on yet.
   */
  'governance.policy.deactivate': defineAction('governance', 'critical', 'Switch off the active version of a repository governance policy', [], null, 'governance'),
  'governance.policy.archive': defineAction('governance', 'critical', 'Archive a repository governance policy, switching it off first', [], null, 'governance'),
  'governance.policy.restore': defineAction('governance', 'high', 'Restore an archived repository governance policy, switched off', [], null, 'governance'),
  'governance.draft.discard': defineAction('governance', 'medium', 'Discard a repository governance policy draft', [], null, 'governance'),
  'governance.version.withdraw': defineAction('governance', 'high', 'Withdraw a policy version that never took effect', [], null, 'governance'),
  'governance.reset': defineAction('governance', 'critical', 'Switch off and archive every governance policy in a repository', [], null, 'governance'),
  /*
   * Exposure scanning. None of these performs a provider mutation -- the
   * operations list is empty for every one -- but all of them are governed
   * actions: they read somebody's repository, use a credential found inside
   * it, or decide that a live exposure is acceptable.
   *
   * The bindings are the distinction that matters. Asking for a scan reads a
   * repository the caller can already read, so it binds to whoever executes
   * it. Accepting the risk of a live credential is a governance decision about
   * somebody else's security, so it binds to a governance role -- a repository
   * reader cannot wave away their own finding.
   */
  'exposure.scan.request': defineAction('exposure', 'medium', 'Request an exposure scan of a repository at a commit', []),
  'exposure.scan.cancel': defineAction('exposure', 'low', 'Cancel an exposure scan in progress', []),
  'exposure.credential.verify': defineAction('exposure', 'high', 'Ask the issuing provider whether a discovered credential is live', []),
  'exposure.readability.probe': defineAction('exposure', 'high', 'Establish whether a discovered project is readable anonymously', []),
  'exposure.finding.accept-risk': defineAction('exposure', 'critical', 'Accept the risk of an exposed credential', [], null, 'governance'),
  'exposure.finding.export': defineAction('exposure', 'medium', 'Export exposure findings as evidence', []),
  /*
   * Clearing is the reader's own record, not anybody else's, and it binds to
   * whoever executes it for that reason. It is medium rather than low because
   * it is irreversible: the verification and readability history it removes
   * was evidence, and the ledger entry this action writes is what remains.
   */
  'exposure.history.clear': defineAction('exposure', 'medium', 'Clear an identity\'s exposure history for a repository', []),
  /*
   * The same shape for repository audits: the reader's own record, bound to
   * whoever executes it, and medium because the grades, findings and watch
   * alerts it removes cannot be brought back.
   */
  'code-audit.history.clear': defineAction('code-audit', 'medium', 'Clear an identity\'s repository audit history for a repository', []),
  /*
   * A team's decision about one of its audit findings binds to a governance
   * role, as accepting an exposure's risk does: it takes the finding out of
   * the grade and out of the merge gate for everyone. It is high rather than
   * critical because it can be read and taken back by any reviewer, and a
   * risk accepted is accepted only until a date. Taking a decision back
   * shows the finding again, which is never the dangerous direction.
   */
  'code-audit.finding.triage': defineAction('code-audit', 'high', 'Record a team decision about a repository audit finding', [], null, 'governance'),
  'code-audit.finding.reopen': defineAction('code-audit', 'medium', 'Take back a team decision about a repository audit finding', [], null, 'governance'),
  'governance.notification.preferences.update': defineAction('governance', 'low', 'Update repository governance notification preferences', [], null, 'governance'),
  'governance.notification.read': defineAction('governance', 'low', 'Advance repository governance notification read state', [], null, 'governance'),
  'governance.webhook.create': defineAction('governance', 'high', 'Create a signed governance webhook destination', [], null, 'governance'),
  'governance.webhook.update': defineAction('governance', 'high', 'Update a signed governance webhook destination', [], null, 'governance'),
  'governance.webhook.rotate': defineAction('governance', 'critical', 'Rotate a governance webhook signing secret', [], null, 'governance'),
  'governance.webhook.delete': defineAction('governance', 'critical', 'Disable and delete a governance webhook destination', [], null, 'governance'),
  'governance.audit.export.create': defineAction('governance', 'medium', 'Create a signed governance evidence export', [], null, 'governance')
} as const satisfies Record<string, MutationActionDefinition>;

export type MutationActionName = keyof typeof ACTION_TABLE;
export const MUTATION_ACTIONS: Readonly<Record<MutationActionName, MutationActionDefinition>> =
  Object.freeze(Object.assign(Object.create(null) as Record<MutationActionName, MutationActionDefinition>, ACTION_TABLE));

export const isMutationAction = (value: unknown): value is MutationActionName =>
  typeof value === 'string' && Object.hasOwn(MUTATION_ACTIONS, value);

/* How one action is carried out: what the gateway lets a single descriptor do. */
export interface ExecutionContract {
  readonly mode: string;
  readonly maxItems: number;
  readonly maxProviderWrites: number;
  readonly atomicity: string;
  readonly partialFailure: boolean;
  readonly maxPayloadBytes: number;
}

export interface MutationSecurity {
  readonly stepUpAction: string | null;
  readonly assurance: AssuranceLevel | null;
  readonly authorizedAt: number | null;
}

export interface MutationDescriptor {
  readonly mutationId: MutationId;
  readonly action: MutationActionName;
  readonly category: string;
  readonly risk: MutationRisk;
  readonly provider: Provider;
  readonly authority: RepositoryScope['authority'];
  readonly owner: string;
  readonly repo: string;
  readonly scopeKey: string;
  readonly actorIdentityKey: IdentityKey;
  readonly actorLogin: string;
  readonly method: MutatingMethod;
  readonly route: string;
  readonly metadata: Readonly<JsonObject>;
  readonly execution: ExecutionContract;
  readonly security: MutationSecurity;
  readonly authorization: AuthorizationSnapshot;
}

/*
 * The policy port the gateway is given. The gateway decides nothing about
 * policy: the composition root hands it an evaluator that answers for a
 * descriptor, and a verifier that refuses any answer not well formed or not
 * bound to that very descriptor. The gateway acts only on a verified decision
 * and only on an outcome it knows, so a policy module is something it is
 * handed, never something it imports.
 */
export const POLICY_OUTCOMES = Object.freeze(['allow', 'warn', 'block'] as const);
export type PolicyOutcome = (typeof POLICY_OUTCOMES)[number];

/* What the gateway reads of a verified decision. */
export interface VerifiedPolicyDecision {
  readonly decisionId?: string | null;
  readonly source: string;
  readonly effectiveEffect: string;
  readonly rolloutMode: string;
  readonly enforcementOutcome: PolicyOutcome;
  readonly warningCodes: readonly string[];
  readonly blockCode: string | null;
  readonly controlMapping: { readonly status: string; readonly mappingHash?: string | null };
}

export interface PolicyEvaluator {
  evaluate(descriptor: MutationDescriptor): Promise<unknown>;
  verify(decision: unknown, descriptor: MutationDescriptor): VerifiedPolicyDecision;
}

const SENSITIVE_KEY_RX = /(?:accesstoken|refreshtoken|token|secret|password|privatekey|authorization|cookie)/i;
const includes = <T extends string>(list: readonly T[], value: string): value is T => (list as readonly string[]).includes(value);
/* Stricter than guards.isPlainObject: a descriptor and its metadata are object literals, never prototype-free maps. */
const isObjectLiteral = (value: unknown): value is JsonObject =>
  !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

function cloneMetadata(value: unknown, refuse: Refuse, path = '$', depth = 0): unknown {
  if (depth > METADATA_LIMITS.depth) refuse('Mutation metadata is nested too deeply', 'MUTATION_METADATA_INVALID', 400);
  if (value == null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) refuse(`Mutation metadata at ${path} contains a non-finite number`, 'MUTATION_METADATA_INVALID', 400);
    return value;
  }
  if (typeof value === 'string') {
    if (value.length > METADATA_LIMITS.stringLength || /[\0\r\n]/.test(value)) {
      refuse(`Mutation metadata at ${path} contains an invalid string`, 'MUTATION_METADATA_INVALID', 400);
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > METADATA_LIMITS.arrayItems) refuse('Mutation metadata array is too large', 'MUTATION_METADATA_INVALID', 400);
    return value.map((item, index) => cloneMetadata(item, refuse, `${path}[${index}]`, depth + 1));
  }
  if (!isObjectLiteral(value)) return refuse(`Mutation metadata at ${path} must be JSON-compatible`, 'MUTATION_METADATA_INVALID', 400);
  const keys = Object.keys(value);
  if (keys.length > METADATA_LIMITS.keys) refuse('Mutation metadata object has too many fields', 'MUTATION_METADATA_INVALID', 400);
  const output: JsonObject = {};
  for (const key of keys.sort()) {
    if (!key || key.length > 100 || SENSITIVE_KEY_RX.test(key.replace(/[^a-z0-9]/gi, '').toLowerCase())) {
      refuse(`Sensitive or invalid mutation metadata field: ${key || '(empty)'}`, 'MUTATION_SENSITIVE_FIELD', 400);
    }
    output[key] = cloneMetadata(value[key], refuse, `${path}.${key}`, depth + 1);
  }
  return output;
}

/* Bounded, JSON-shaped and credential-free: what a descriptor may say about its change. */
export function normalizeMutationMetadata(input: unknown, refuse: Refuse = refuseWithContractError): Readonly<JsonObject> {
  if (input == null) return Object.freeze({});
  if (!isObjectLiteral(input)) return refuse('Mutation metadata must be an object', 'MUTATION_METADATA_INVALID', 400);
  const output = cloneMetadata(input, refuse) as JsonObject;
  if (utf8ByteLength(JSON.stringify(output)) > METADATA_LIMITS.bytes) {
    refuse('Mutation metadata exceeds 16 KiB', 'MUTATION_METADATA_TOO_LARGE', 413);
  }
  return deepFreeze(output);
}

/* The step-up an action consumed before it reached the gateway, which an action that needs one cannot lack. */
function normalizeMutationSecurity(input: unknown, definition: MutationActionDefinition, refuse: Refuse = refuseWithContractError): MutationSecurity {
  const security = input == null ? {} : input;
  if (!isObjectLiteral(security)) return refuse('Mutation security context is invalid', 'MUTATION_SECURITY_INVALID', 400);
  const stepUpAction = String(security.stepUpAction || '').trim();
  const assurance = String(security.assurance || '').trim();
  const authorizedAt = security.authorizedAt == null ? null : Number(security.authorizedAt);
  if (definition.stepUpAction) {
    if (stepUpAction !== definition.stepUpAction || !includes(ASSURANCE_LEVELS, assurance) ||
        authorizedAt === null || !Number.isFinite(authorizedAt) || authorizedAt <= 0) {
      return refuse('The required step-up authorization was not consumed before entering the mutation gateway', 'MUTATION_STEP_UP_REQUIRED');
    }
    return Object.freeze({ stepUpAction, assurance, authorizedAt });
  }
  if (stepUpAction || assurance || authorizedAt != null) {
    if (stepUpAction && !isMutationAction(stepUpAction) && !includes(STEP_UP_ACTIONS, stepUpAction)) {
      refuse('Mutation step-up action is invalid', 'MUTATION_SECURITY_INVALID', 400);
    }
    if (assurance && !includes(ASSURANCE_LEVELS, assurance)) refuse('Mutation assurance is invalid', 'MUTATION_SECURITY_INVALID', 400);
    if (authorizedAt != null && (!Number.isFinite(authorizedAt) || authorizedAt <= 0)) {
      refuse('Mutation step-up timestamp is invalid', 'MUTATION_SECURITY_INVALID', 400);
    }
    return Object.freeze({
      stepUpAction: stepUpAction || null,
      assurance: assurance && includes(ASSURANCE_LEVELS, assurance) ? assurance : null,
      authorizedAt
    });
  }
  return Object.freeze({ stepUpAction: null, assurance: null, authorizedAt: null });
}

export interface DescriptorDependencies {
  /* Refuses a malformed descriptor. The server passes its MutationGatewayError, whose status defaults to 403. */
  readonly refuse?: Refuse;
  /* Each of these refuses with its own error, as the server's own module would. */
  readonly normalizeScope?: (input: JsonObject) => RepositoryScope;
  readonly normalizeAuthorization?: (input: unknown) => AuthorizationSnapshot;
  readonly executionContract: (action: MutationActionName) => ExecutionContract;
  /* Mints an id for a descriptor that brings none. */
  readonly newMutationId: () => string;
}

export function normalizeMutationDescriptor(input: unknown, dependencies: DescriptorDependencies): MutationDescriptor {
  const refuse = dependencies.refuse || refuseWithContractError;
  const normalizeScope = dependencies.normalizeScope || ((scopeInput: JsonObject) => normalizePolicyScope(scopeInput));
  const normalizeAuthorization = dependencies.normalizeAuthorization || ((snapshot: unknown) => normalizeAuthorizationSnapshot(snapshot));
  if (!isObjectLiteral(input)) return refuse('Mutation descriptor must be an object', 'MUTATION_DESCRIPTOR_INVALID', 400);
  if (Object.hasOwn(input, 'controlMapping') || Object.hasOwn(input, 'policyDecision') || Object.hasOwn(input, 'enforcementMode')) {
    refuse('Policy decisions and control mappings are derived inside the mutation gateway', 'MUTATION_POLICY_INPUT_FORBIDDEN', 400);
  }
  const action = String(input.action || '').trim().toLowerCase();
  if (!isMutationAction(action)) return refuse('Unknown repository mutation action', 'MUTATION_ACTION_UNKNOWN', 400);
  const definition = MUTATION_ACTIONS[action];
  const scope = normalizeScope({
    provider: input.provider,
    baseUrl: input.baseUrl,
    owner: input.owner,
    repo: input.repo
  });
  const actorIdentityKey = String(input.actorIdentityKey || '').trim().toLowerCase();
  if (!IDENTITY_KEY.test(actorIdentityKey)) refuse('Mutation actor identity is invalid', 'MUTATION_ACTOR_INVALID', 400);
  const actorLogin = String(input.actorLogin || '').trim();
  if (!actorLogin || actorLogin.length > 200 || /[\0\r\n]/.test(actorLogin)) {
    refuse('Mutation actor login is invalid', 'MUTATION_ACTOR_INVALID', 400);
  }
  const method = String(input.method || '').trim().toUpperCase();
  if (!includes(MUTATING_METHODS, method)) return refuse('Mutation route method is invalid', 'MUTATION_METHOD_INVALID', 400);
  const route = String(input.route || '').trim();
  if (!route.startsWith('/api/') || route.length > 500 || /[\0\r\n]/.test(route)) {
    refuse('Mutation route is invalid', 'MUTATION_ROUTE_INVALID', 400);
  }
  const mutationId = String(input.mutationId || dependencies.newMutationId()).trim().toLowerCase();
  if (!MUTATION_ID.test(mutationId)) refuse('Mutation identifier is invalid', 'MUTATION_ID_INVALID', 400);
  const authorization = normalizeAuthorization(input.authorization);
  if (authorization.scope.scopeKey !== scope.scopeKey) {
    refuse('Authorization evidence does not match the mutation repository scope', 'MUTATION_AUTHORIZATION_SCOPE_MISMATCH');
  }
  if (definition.actorBinding === 'governance') {
    if (authorization.governanceActor.login.toLowerCase() !== actorLogin.toLowerCase() ||
        authorization.governanceActor.identityKey !== actorIdentityKey) {
      refuse('Authorization evidence does not match the governance mutation actor', 'MUTATION_AUTHORIZATION_ACTOR_MISMATCH');
    }
  } else if (authorization.executionPrincipal.login.toLowerCase() !== actorLogin.toLowerCase() ||
      (authorization.executionPrincipal.kind === 'user' && authorization.executionPrincipal.identityKey !== actorIdentityKey)) {
    refuse('Authorization evidence does not match the mutation actor', 'MUTATION_AUTHORIZATION_ACTOR_MISMATCH');
  }
  return deepFreeze({
    mutationId: mutationId as MutationId,
    action,
    category: definition.category,
    risk: definition.risk,
    provider: scope.provider,
    authority: scope.authority,
    owner: scope.owner,
    repo: scope.repo,
    scopeKey: scope.scopeKey,
    actorIdentityKey: actorIdentityKey as IdentityKey,
    actorLogin,
    method,
    route,
    metadata: normalizeMutationMetadata(input.metadata, refuse),
    execution: dependencies.executionContract(action),
    security: normalizeMutationSecurity(input.security, definition, refuse),
    authorization
  });
}
