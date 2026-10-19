import { promises as dnsPromises } from 'node:dns';
import {
  normalizePolicyScope,
  normalizePolicyDocument,
  normalizeApprovalPolicy,
  policyDocumentHash
} from '../domain/governance-model.ts';
import type { ApprovalPolicy, PolicyDocument } from '../domain/governance-model.ts';
import {
  GOVERNANCE_ROLE_NAMES,
  normalizeAuthorizationSnapshot
} from '../../../platform/authorization/authorization-resolver.ts';
import type { AuthorizationSnapshot, GovernanceRoleName } from '../../../../../../packages/contracts/src/actor.ts';
import { isSha256Hex } from '../../../../../../packages/contracts/src/ids.ts';
import type { RepositoryScope } from '../../../../../../packages/contracts/src/scope.ts';
import { simulatePolicyImpact, normalizeSimulationRequest } from '../domain/governance-simulation.ts';
import type { SimulationRequest } from '../domain/governance-simulation.ts';
import { listPolicyTemplates, getPolicyTemplate, generateRepositoryBaseline } from '../domain/governance-templates.ts';
import { buildPolicyDigitalTwinReadModel, normalizeDigitalTwinOptions } from '../domain/governance-digital-twin.ts';
import {
  normalizeNotificationPreferences,
  normalizeWebhookDefinition,
  normalizeWebhookDestination
} from '../delivery/governance-delivery.ts';

type Fields = Readonly<Record<string, unknown>>;

const ROLE_SET: ReadonlySet<string> = new Set(GOVERNANCE_ROLE_NAMES);

export class GovernanceApiError extends Error {
  override readonly name = 'GovernanceApiError';
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function fail(message: string, code: string, status = 400): never {
  throw new GovernanceApiError(message, code, status);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

/* A field of something that may not be an object, read as plain JavaScript would. */
function read(value: unknown, key: string): unknown {
  return value == null ? undefined : (value as Fields)[key];
}

function isRoleName(value: string): value is GovernanceRoleName {
  return ROLE_SET.has(value);
}

export type GovernanceClock = (() => number) | number;

function normalizeNow(now: GovernanceClock | undefined): number {
  const timestamp = Number(typeof now === 'function' ? now() : Date.now());
  if (!Number.isFinite(timestamp)) fail('Governance authorization clock is invalid', 'GOVERNANCE_AUTHORIZATION_INVALID', 500);
  return timestamp;
}

export interface GovernanceActorRef {
  readonly identityKey: string;
  readonly login: string;
}

/* Who is asking, on which repository, with the authority the provider confirmed. */
export interface GovernanceContext {
  readonly scope: RepositoryScope;
  readonly authorization: AuthorizationSnapshot;
  readonly actor: GovernanceActorRef;
}

export interface AuthorizationCheck {
  readonly requiredRole?: unknown;
  readonly scope?: unknown;
  readonly authorization?: unknown;
  readonly now?: GovernanceClock;
}

export function assertGovernanceAuthorization(input: AuthorizationCheck = {}): GovernanceContext {
  const requiredRole = String(input.requiredRole || '').trim().toLowerCase();
  if (!isRoleName(requiredRole)) fail('Governance role requirement is invalid', 'GOVERNANCE_ROLE_INVALID', 500);
  const scope = normalizePolicyScope(input.scope);
  const authorization = normalizeAuthorizationSnapshot(input.authorization);
  if (authorization.scope.scopeKey !== scope.scopeKey) {
    fail('Governance authorization does not match the repository scope', 'GOVERNANCE_SCOPE_MISMATCH', 403);
  }
  if (authorization.evidence.status !== 'resolved' ||
      !authorization.repositoryAccess.complete ||
      !authorization.governanceActor.verified) {
    fail('Verified repository authorization is required for governance operations', 'GOVERNANCE_AUTHORIZATION_REQUIRED', 403);
  }
  const currentTime = normalizeNow(input.now);
  const fetchedAt = new Date(authorization.evidence.fetchedAt).getTime();
  const expiresAt = new Date(authorization.evidence.expiresAt).getTime();
  if (expiresAt <= currentTime || fetchedAt > currentTime + 30 * 1000) {
    fail('Repository authorization evidence is stale', 'GOVERNANCE_AUTHORIZATION_STALE', 403);
  }
  if (authorization.governanceRoles[requiredRole] !== true) {
    fail(`The ${requiredRole} governance role is required`, 'GOVERNANCE_ROLE_REQUIRED', 403);
  }
  return deepFreeze({
    scope,
    authorization,
    actor: {
      identityKey: authorization.governanceActor.identityKey,
      login: authorization.governanceActor.login
    }
  });
}


function bodyObject(value: unknown): Fields {
  if (value == null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('Governance review input must be a JSON object', 'GOVERNANCE_REVIEW_INPUT_INVALID', 400);
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    fail('Governance review input must be a plain JSON object', 'GOVERNANCE_REVIEW_INPUT_INVALID', 400);
  }
  return value as Fields;
}

/* The request body when it is an object of any kind, and nothing otherwise. */
function bodyOrEmpty(value: unknown): Fields {
  return value && typeof value === 'object' ? value as Fields : {};
}

function assertReviewInputFields(input: unknown, allowed: ReadonlySet<string>): Fields {
  const body = bodyObject(input);
  const forbiddenIdentity = new Set([
    'reviewer', 'reviewerIdentityKey', 'reviewerLogin', 'actor', 'actorIdentityKey', 'actorLogin',
    'role', 'roles', 'accessLevel', 'permissions', 'installationPermissions'
  ]);
  for (const key of Object.keys(body)) {
    if (forbiddenIdentity.has(key)) {
      fail('Reviewer identity and authority are derived by the server', 'GOVERNANCE_REVIEWER_IDENTITY_FORBIDDEN', 400);
    }
    if (!allowed.has(key)) fail('Governance review input contains an unsupported field', 'GOVERNANCE_REVIEW_INPUT_INVALID', 400);
  }
  return body;
}

/* The provider's confirmation of a person's access, as a review, activation or exception records it. */
export interface AuthorizationEvidence {
  readonly accessLevel: number;
  readonly providerRole: string | null;
  readonly source: string;
  readonly fetchedAt: string;
  readonly expiresAt: string;
}

function authorizationEvidence(authorization: AuthorizationSnapshot): AuthorizationEvidence {
  return deepFreeze({
    accessLevel: authorization.repositoryAccess.level,
    providerRole: authorization.repositoryAccess.providerRole,
    source: authorization.repositoryAccess.source,
    fetchedAt: authorization.evidence.fetchedAt,
    expiresAt: authorization.evidence.expiresAt
  });
}

const reviewerAuthorizationEvidence = authorizationEvidence;
const activatorAuthorizationEvidence = authorizationEvidence;
const exceptionAuthorizationEvidence = authorizationEvidence;

interface ActivationInput {
  readonly expectedRevision: number;
  readonly reason: string;
  readonly simulationHash: string;
  readonly simulationRequest: SimulationRequest;
}

function assertActivationInput(input: unknown): ActivationInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('Governance activation input must be a JSON object', 'GOVERNANCE_ACTIVATION_INPUT_INVALID', 400);
  }
  const proto: unknown = Object.getPrototypeOf(input);
  if (proto !== Object.prototype && proto !== null) {
    fail('Governance activation input must be a plain JSON object', 'GOVERNANCE_ACTIVATION_INPUT_INVALID', 400);
  }
  const body = input as Fields;
  const allowed = new Set(['expectedRevision', 'reason', 'simulation']);
  const forbidden = new Set([
    'actor', 'actorIdentityKey', 'actorLogin', 'role', 'roles', 'accessLevel',
    'permissions', 'installationPermissions', 'authorization', 'authorizationEvidence'
  ]);
  for (const key of Object.keys(body)) {
    if (forbidden.has(key)) fail('Activation identity and authority are derived by the server', 'GOVERNANCE_ACTIVATOR_IDENTITY_FORBIDDEN', 400);
    if (!allowed.has(key)) fail('Governance activation input contains an unsupported field', 'GOVERNANCE_ACTIVATION_INPUT_INVALID', 400);
  }
  const expectedRevision = Number(body.expectedRevision);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    fail('Expected policy revision is invalid', 'GOVERNANCE_REVISION_INVALID', 400);
  }
  const reason = String(body.reason == null ? '' : body.reason).trim();
  if (!reason || reason.length > 4000 || /[\x00-\x1f\x7f]/.test(reason)) {
    fail('Activation reason is invalid', 'GOVERNANCE_ACTIVATION_REASON_INVALID', 400);
  }
  const simulation = body.simulation;
  if (!simulation || typeof simulation !== 'object' || Array.isArray(simulation)) {
    fail('Simulation evidence is required', 'GOVERNANCE_SIMULATION_REQUIRED', 400);
  }
  const evidence = simulation as Fields;
  const simulationKeys = Object.keys(evidence);
  if (simulationKeys.some(key => !['simulationHash', 'request'].includes(key))) {
    fail('Simulation evidence contains an unsupported field', 'GOVERNANCE_SIMULATION_INPUT_INVALID', 400);
  }
  const simulationHash = String(evidence.simulationHash || '').trim().toLowerCase();
  if (!isSha256Hex(simulationHash)) {
    fail('Simulation hash is invalid', 'GOVERNANCE_SIMULATION_HASH_INVALID', 400);
  }
  if (!evidence.request || typeof evidence.request !== 'object' || Array.isArray(evidence.request)) {
    fail('Simulation request is required', 'GOVERNANCE_SIMULATION_INPUT_INVALID', 400);
  }
  return deepFreeze({ expectedRevision, reason, simulationHash, simulationRequest: normalizeSimulationRequest(evidence.request) });
}

function assertRequiredIdempotencyKey(value: unknown, label = 'Activation and rollback'): string {
  const key = String(value == null ? '' : value).trim();
  if (!key) {
    fail(`${label} require an Idempotency-Key`, 'GOVERNANCE_IDEMPOTENCY_KEY_REQUIRED', 400);
  }
  if (key.length < 8 || key.length > 200 || /[\u0000-\u001f\u007f]/.test(key)) {
    fail('Idempotency-Key must contain 8 to 200 printable characters', 'GOVERNANCE_IDEMPOTENCY_KEY_INVALID', 400);
  }
  return key;
}

interface LifecycleInput {
  expectedRevision?: number;
  reason?: string;
  confirm?: string;
}

/*
 * Input for the lifecycle operations. Same rule as activation: the body says
 * what to do and why; who is doing it, and with what authority, comes from the
 * verified session and is refused if the body tries to say it.
 */
function assertLifecycleInput(input: unknown, allowedFields: readonly string[]): Readonly<LifecycleInput> {
  const body = input == null ? {} : input;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    fail('Governance lifecycle input must be a JSON object', 'GOVERNANCE_LIFECYCLE_INPUT_INVALID', 400);
  }
  const proto: unknown = Object.getPrototypeOf(body);
  if (proto !== Object.prototype && proto !== null) {
    fail('Governance lifecycle input must be a plain JSON object', 'GOVERNANCE_LIFECYCLE_INPUT_INVALID', 400);
  }
  const fields = body as Fields;
  const allowed = new Set(allowedFields);
  const forbidden = new Set([
    'actor', 'actorIdentityKey', 'actorLogin', 'role', 'roles', 'accessLevel',
    'permissions', 'installationPermissions', 'authorization', 'authorizationEvidence', 'allowOthers'
  ]);
  for (const key of Object.keys(fields)) {
    if (forbidden.has(key)) fail('Governance identity and authority are derived by the server', 'GOVERNANCE_LIFECYCLE_IDENTITY_FORBIDDEN', 400);
    if (!allowed.has(key)) fail('Governance lifecycle input contains an unsupported field', 'GOVERNANCE_LIFECYCLE_INPUT_INVALID', 400);
  }
  const result: LifecycleInput = {};
  if (allowed.has('expectedRevision')) {
    const expectedRevision = Number(fields.expectedRevision);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) fail('Expected revision is invalid', 'GOVERNANCE_REVISION_INVALID', 400);
    result.expectedRevision = expectedRevision;
  }
  if (allowed.has('reason')) {
    const reason = String(fields.reason == null ? '' : fields.reason).trim();
    if (!reason || reason.length > 4000 || /[\x00-\x1f\x7f]/.test(reason)) fail('A reason is required', 'GOVERNANCE_LIFECYCLE_REASON_INVALID', 400);
    result.reason = reason;
  }
  if (allowed.has('confirm')) result.confirm = String(fields.confirm == null ? '' : fields.confirm).trim();
  return deepFreeze(result);
}

function assertExceptionInputFields(input: unknown, allowed: ReadonlySet<string>): Fields {
  const body = bodyObject(input);
  const forbidden = new Set([
    'actor', 'actorIdentityKey', 'actorLogin', 'requester', 'requesterIdentityKey', 'approver',
    'role', 'roles', 'accessLevel', 'permissions', 'installationPermissions', 'authorization',
    'authorizationEvidence', 'approved', 'status', 'active'
  ]);
  for (const key of Object.keys(body)) {
    if (forbidden.has(key)) fail('Exception identity and authority are derived by the server', 'GOVERNANCE_EXCEPTION_IDENTITY_FORBIDDEN', 400);
    if (!allowed.has(key)) fail('Exception input contains an unsupported field', 'GOVERNANCE_EXCEPTION_INPUT_INVALID', 400);
  }
  return body;
}

function assertDeliveryInputFields(input: unknown, allowed: ReadonlySet<string>): Fields {
  const body = bodyObject(input);
  const forbiddenIdentity = new Set([
    'actor', 'actorIdentityKey', 'actorLogin', 'identityKey', 'login', 'role', 'roles',
    'accessLevel', 'permissions', 'installationPermissions', 'authorization', 'authorizationEvidence'
  ]);
  const forbiddenSecrets = new Set([
    'secret', 'signingSecret', 'secretSalt', 'secretVersion', 'masterSecret', 'token', 'password',
    'privateKey', 'authorizationHeader', 'cookie'
  ]);
  for (const key of Object.keys(body)) {
    if (forbiddenIdentity.has(key)) fail('Delivery identity and authority are derived by the server', 'GOVERNANCE_DELIVERY_IDENTITY_FORBIDDEN', 400);
    if (forbiddenSecrets.has(key)) fail('Delivery secrets are generated and retained by the server', 'GOVERNANCE_DELIVERY_SECRET_FORBIDDEN', 400);
    if (!allowed.has(key)) fail('Governance delivery input contains an unsupported field', 'GOVERNANCE_DELIVERY_INPUT_INVALID', 400);
  }
  return body;
}

interface IntegerOptions {
  readonly minimum?: number;
  readonly maximum?: number;
  readonly defaultValue?: number;
}

function integerInput(value: unknown, label: string, options: IntegerOptions = {}): number | null {
  if (value == null || String(value).trim() === '') return options.defaultValue == null ? null : options.defaultValue;
  const number = Number(value);
  const minimum = options.minimum == null ? 0 : options.minimum;
  const maximum = options.maximum == null ? Number.MAX_SAFE_INTEGER : options.maximum;
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    fail(`${label} is invalid`, 'GOVERNANCE_DELIVERY_INPUT_INVALID', 400);
  }
  return number;
}

interface VersionInput {
  readonly document: PolicyDocument;
  readonly documentHash: string;
  readonly approvalPolicy: ApprovalPolicy;
}

function normalizedVersionInput(input: unknown = {}): VersionInput {
  const document = normalizePolicyDocument(read(input, 'document'));
  const approvalPolicy = normalizeApprovalPolicy(read(input, 'approvalPolicy'));
  return deepFreeze({ document, documentHash: policyDocumentHash(document), approvalPolicy });
}

type StoreCall = (input: Fields) => Promise<unknown>;

/* The governance store as this service uses it. The store's own module defines what each call answers. */
export interface GovernanceApiStore {
  readonly listPolicies: StoreCall;
  readonly createPolicy: StoreCall;
  getPolicyStateInScope(input: Fields): Promise<{ readonly activeVersionId?: unknown }>;
  readonly createDraft: StoreCall;
  getDraft(input: Fields): Promise<{ readonly document?: unknown; readonly requiredApprovals?: unknown; readonly disallowAuthorApproval?: unknown }>;
  readonly updateDraft: StoreCall;
  readonly submitDraft: StoreCall;
  readonly listVersions: StoreCall;
  getVersionInScope(input: Fields): Promise<{ readonly versionId?: unknown }>;
  readonly getReviewState: StoreCall;
  readonly claimReviewer: StoreCall;
  readonly recordReviewDecision: StoreCall;
  readonly activateVersion: StoreCall;
  readonly rollbackVersion: StoreCall;
  readonly listActivationHistory: StoreCall;
  readonly createExceptionRequest: StoreCall;
  readonly getException: StoreCall;
  readonly listExceptions: StoreCall;
  readonly decideException: StoreCall;
  readonly revokeException: StoreCall;
  readonly listPolicyDecisionsInScope: StoreCall;
  readonly verifyPolicyDecisionChainInScope: StoreCall;
  readonly getNotificationPreferences: StoreCall;
  readonly updateNotificationPreferences: StoreCall;
  readonly markNotificationsRead: StoreCall;
  readonly listNotifications: StoreCall;
  readonly createWebhook: StoreCall;
  readonly listWebhooks: StoreCall;
  readonly updateWebhook: StoreCall;
  readonly rotateWebhookSecret: StoreCall;
  readonly deleteWebhook: StoreCall;
  readonly listWebhookDeliveries: StoreCall;
  readonly createEvidenceExport: StoreCall;
  readonly listEvidenceExports: StoreCall;
  readonly getEvidenceExport: StoreCall;
  readonly verifyEvidenceExport: StoreCall;
  /* Optional: the read model's data, and the lifecycle a store written before them may lack. */
  readonly getDigitalTwinReadModelData?: StoreCall;
  readonly deactivatePolicy?: StoreCall;
  readonly archivePolicy?: StoreCall;
  readonly restorePolicy?: StoreCall;
  readonly listArchivedPolicies?: StoreCall;
  readonly discardDraft?: StoreCall;
  readonly withdrawVersion?: StoreCall;
  readonly resetGovernance?: StoreCall;
}

type LifecycleCall = 'deactivatePolicy' | 'archivePolicy' | 'restorePolicy' | 'listArchivedPolicies' | 'discardDraft' | 'withdrawVersion' | 'resetGovernance';

const REQUIRED_STORE_METHODS = [
  'listPolicies', 'createPolicy', 'getPolicyStateInScope',
  'createDraft', 'getDraft', 'updateDraft', 'submitDraft',
  'listVersions', 'getVersionInScope', 'getReviewState', 'claimReviewer', 'recordReviewDecision',
  'activateVersion', 'rollbackVersion', 'listActivationHistory',
  'createExceptionRequest', 'getException', 'listExceptions', 'decideException', 'revokeException',
  'listPolicyDecisionsInScope', 'verifyPolicyDecisionChainInScope',
  'getNotificationPreferences', 'updateNotificationPreferences', 'markNotificationsRead', 'listNotifications',
  'createWebhook', 'listWebhooks', 'updateWebhook', 'rotateWebhookSecret', 'deleteWebhook', 'listWebhookDeliveries',
  'createEvidenceExport', 'listEvidenceExports', 'getEvidenceExport', 'verifyEvidenceExport'
];

function requireStore(store: unknown): GovernanceApiStore {
  const candidate = store as Fields | null | undefined;
  if (!candidate || REQUIRED_STORE_METHODS.some(method => typeof candidate[method] !== 'function')) {
    throw new TypeError('Governance API service requires a complete governance store');
  }
  /* Every method the service calls unconditionally is present and callable; what each answers is the store's contract. */
  return candidate as unknown as GovernanceApiStore;
}

/* One call into the service: who is asking, on which repository, and what the request carried. */
export type ServiceInput = Fields;

export interface RepositoryFactsRequest {
  readonly scope: RepositoryScope;
  readonly authorization: AuthorizationSnapshot;
  readonly actor: GovernanceActorRef;
}

export interface GovernanceApiOptions {
  readonly store?: unknown;
  readonly now?: () => number;
  readonly resolveRepositoryFacts?: (request: RepositoryFactsRequest) => Promise<unknown>;
  readonly resolveWebhookAddresses?: (hostname: string) => Promise<unknown>;
}

export function createGovernanceApiService(options: GovernanceApiOptions = {}) {
  const store = requireStore(options.store);
  /* The lifecycle methods are looked up when used rather than demanded up
   * front, so a store written before them still builds a service for
   * everything else. */
  const lifecycleStore = (name: LifecycleCall): StoreCall => {
    const call = store[name];
    if (typeof call !== 'function') fail('This governance operation is not available', 'GOVERNANCE_OPERATION_UNAVAILABLE', 501);
    return input => call.call(store, input);
  };
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const resolveRepositoryFacts = typeof options.resolveRepositoryFacts === 'function'
    ? options.resolveRepositoryFacts
    : async ({ scope }: RepositoryFactsRequest) => ({ schemaVersion: 1, defaultBranch: null, protectedBranches: [], pullRequestsEnabled: null, visibility: null, archived: false, resolvedForScopeKey: scope.scopeKey });
  const resolveWebhookAddresses = typeof options.resolveWebhookAddresses === 'function'
    ? options.resolveWebhookAddresses
    : async (hostname: string) => dnsPromises.lookup(hostname, { all: true, verbatim: true });
  const authorize = (input: ServiceInput, requiredRole: GovernanceRoleName): GovernanceContext => assertGovernanceAuthorization({
    authorization: input.authorization,
    scope: input.scope,
    requiredRole,
    now
  });

  return Object.freeze({
    async getNotificationPreferences(input: ServiceInput = {}) {
      const context = authorize(input, 'reader');
      return store.getNotificationPreferences({ scope: context.scope, actor: context.actor });
    },

    async updateNotificationPreferences(input: ServiceInput = {}) {
      const context = authorize(input, 'reader');
      const body = assertDeliveryInputFields(input.input, new Set(['enabled', 'eventTypes']));
      return store.updateNotificationPreferences({
        scope: context.scope,
        actor: context.actor,
        preferences: normalizeNotificationPreferences(body),
        idempotencyKey: input.idempotencyKey
      });
    },

    async markNotificationsRead(input: ServiceInput = {}) {
      const context = authorize(input, 'reader');
      const body = assertDeliveryInputFields(input.input, new Set(['throughSeq']));
      return store.markNotificationsRead({
        scope: context.scope,
        actor: context.actor,
        throughSeq: integerInput(body.throughSeq, 'Notification read cursor', { minimum: 0 }),
        idempotencyKey: input.idempotencyKey
      });
    },

    async listNotifications(input: ServiceInput = {}) {
      const context = authorize(input, 'reader');
      return store.listNotifications({
        scope: context.scope,
        actor: context.actor,
        limit: integerInput(input.limit, 'Notification limit', { minimum: 1, maximum: 200, defaultValue: 50 }),
        afterSeq: integerInput(input.afterSeq, 'Notification cursor', { minimum: 0, defaultValue: 0 })
      });
    },

    async createWebhook(input: ServiceInput = {}) {
      const context = authorize(input, 'administrator');
      const body = assertDeliveryInputFields(input.input, new Set(['name', 'url', 'eventTypes', 'enabled']));
      const definition = normalizeWebhookDefinition(body);
      const parsed = new URL(definition.url);
      const addresses = await resolveWebhookAddresses(parsed.hostname);
      normalizeWebhookDestination(definition.url, addresses);
      return store.createWebhook({ scope: context.scope, actor: context.actor, definition, idempotencyKey: input.idempotencyKey });
    },

    async listWebhooks(input: ServiceInput = {}) {
      const context = authorize(input, 'administrator');
      return store.listWebhooks({ scope: context.scope });
    },

    async updateWebhook(input: ServiceInput = {}) {
      const context = authorize(input, 'administrator');
      const body = assertDeliveryInputFields(input.input, new Set(['name', 'url', 'eventTypes', 'enabled']));
      const definition = normalizeWebhookDefinition(body);
      const parsed = new URL(definition.url);
      const addresses = await resolveWebhookAddresses(parsed.hostname);
      normalizeWebhookDestination(definition.url, addresses);
      return store.updateWebhook({ scope: context.scope, actor: context.actor, webhookId: input.webhookId, definition, idempotencyKey: input.idempotencyKey });
    },

    async rotateWebhookSecret(input: ServiceInput = {}) {
      const context = authorize(input, 'administrator');
      assertDeliveryInputFields(input.input, new Set());
      return store.rotateWebhookSecret({ scope: context.scope, actor: context.actor, webhookId: input.webhookId, idempotencyKey: input.idempotencyKey });
    },

    async deleteWebhook(input: ServiceInput = {}) {
      const context = authorize(input, 'administrator');
      assertDeliveryInputFields(input.input, new Set());
      return store.deleteWebhook({ scope: context.scope, actor: context.actor, webhookId: input.webhookId, idempotencyKey: input.idempotencyKey });
    },

    async listWebhookDeliveries(input: ServiceInput = {}) {
      const context = authorize(input, 'administrator');
      return store.listWebhookDeliveries({
        scope: context.scope,
        webhookId: input.webhookId,
        limit: integerInput(input.limit, 'Webhook delivery limit', { minimum: 1, maximum: 200, defaultValue: 100 })
      });
    },

    async createEvidenceExport(input: ServiceInput = {}) {
      const context = authorize(input, 'reader');
      const body = assertDeliveryInputFields(input.input, new Set(['format', 'afterEventSeq', 'throughEventSeq', 'limit']));
      return store.createEvidenceExport({
        scope: context.scope,
        actor: context.actor,
        format: body.format,
        afterEventSeq: integerInput(body.afterEventSeq, 'Evidence export lower cursor', { minimum: 0, defaultValue: 0 }),
        throughEventSeq: integerInput(body.throughEventSeq, 'Evidence export upper cursor', { minimum: 0 }),
        limit: integerInput(body.limit, 'Evidence export limit', { minimum: 1, maximum: 1000, defaultValue: 1000 }),
        idempotencyKey: input.idempotencyKey
      });
    },

    async listEvidenceExports(input: ServiceInput = {}) {
      const context = authorize(input, 'reader');
      return store.listEvidenceExports({
        scope: context.scope,
        limit: integerInput(input.limit, 'Evidence export list limit', { minimum: 1, maximum: 200, defaultValue: 100 })
      });
    },

    async getEvidenceExport(input: ServiceInput = {}) {
      const context = authorize(input, 'reader');
      return store.getEvidenceExport({ scope: context.scope, exportId: input.exportId });
    },

    async verifyEvidenceExport(input: ServiceInput = {}) {
      const context = authorize(input, 'reader');
      return store.verifyEvidenceExport({ scope: context.scope, exportId: input.exportId });
    },

    async listPolicyTemplates(input: ServiceInput = {}) {
      authorize(input, 'reader');
      return listPolicyTemplates();
    },

    async getPolicyTemplate(input: ServiceInput = {}) {
      authorize(input, 'reader');
      return getPolicyTemplate(input.templateId);
    },

    async generateRepositoryBaseline(input: ServiceInput = {}) {
      const context = authorize(input, 'reader');
      const body = bodyObject(input.input);
      const allowed = new Set(['templateId']);
      for (const key of Object.keys(body)) {
        if (!allowed.has(key)) fail('Baseline input contains an unsupported field', 'GOVERNANCE_BASELINE_INPUT_INVALID', 400);
      }
      const templateId = String(body.templateId || '').trim().toLowerCase();
      if (!templateId) fail('Baseline template is required', 'GOVERNANCE_BASELINE_INPUT_INVALID', 400);
      const facts = input.repositoryFacts === undefined
        ? await resolveRepositoryFacts({ scope: context.scope, authorization: context.authorization, actor: context.actor })
        : input.repositoryFacts;
      return generateRepositoryBaseline({ scope: context.scope, templateId, facts });
    },

    async getPolicyDigitalTwin(input: ServiceInput = {}) {
      const context = authorize(input, 'reader');
      if (typeof store.getDigitalTwinReadModelData !== 'function') {
        fail('Digital Twin read model storage is unavailable', 'GOVERNANCE_DIGITAL_TWIN_UNAVAILABLE', 503);
      }
      const pagination = normalizeDigitalTwinOptions({ historyLimit: input.historyLimit, afterDecisionSeq: input.afterDecisionSeq, beforeDecisionSeq: input.beforeDecisionSeq });
      const data = await store.getDigitalTwinReadModelData({ scope: context.scope, ...pagination });
      return buildPolicyDigitalTwinReadModel({ scope: context.scope, data, options: pagination });
    },
    async listPolicies(input: ServiceInput = {}) {
      const context = authorize(input, 'reader');
      return store.listPolicies({ scope: context.scope, limit: input.limit });
    },

    async listPolicyDecisions(input: ServiceInput = {}) {
      const context = authorize(input, 'reader');
      return store.listPolicyDecisionsInScope({ scope: context.scope, limit: input.limit, afterSeq: input.afterSeq, beforeSeq: input.beforeSeq });
    },

    async verifyPolicyDecisionChain(input: ServiceInput = {}) {
      const context = authorize(input, 'reader');
      return store.verifyPolicyDecisionChainInScope({ scope: context.scope, limit: input.limit });
    },

    async createPolicy(input: ServiceInput = {}) {
      const context = authorize(input, 'author');
      const body = bodyOrEmpty(input.input);
      return store.createPolicy({
        scope: context.scope,
        actor: context.actor,
        policyKey: body.policyKey,
        name: body.name,
        description: body.description,
        idempotencyKey: input.idempotencyKey
      });
    },

    async getPolicy(input: ServiceInput = {}) {
      const context = authorize(input, 'reader');
      return store.getPolicyStateInScope({ policyId: input.policyId, scope: context.scope });
    },

    async validatePolicyVersion(input: ServiceInput = {}) {
      const context = authorize(input, 'author');
      await store.getPolicyStateInScope({ policyId: input.policyId, scope: context.scope });
      return normalizedVersionInput(input.input || {});
    },

    async createDraft(input: ServiceInput = {}) {
      const context = authorize(input, 'author');
      const version = normalizedVersionInput(input.input || {});
      return store.createDraft({
        policyId: input.policyId,
        scope: context.scope,
        actor: context.actor,
        idempotencyKey: input.idempotencyKey,
        ...version
      });
    },

    async getDraft(input: ServiceInput = {}) {
      const context = authorize(input, 'author');
      return store.getDraft({
        policyId: input.policyId,
        draftId: input.draftId,
        scope: context.scope,
        actor: context.actor
      });
    },

    async updateDraft(input: ServiceInput = {}) {
      const context = authorize(input, 'author');
      const body = bodyOrEmpty(input.input);
      const version = normalizedVersionInput(body);
      return store.updateDraft({
        policyId: input.policyId,
        draftId: input.draftId,
        scope: context.scope,
        actor: context.actor,
        expectedRevision: body.expectedRevision,
        idempotencyKey: input.idempotencyKey,
        ...version
      });
    },

    async validateDraft(input: ServiceInput = {}) {
      const context = authorize(input, 'author');
      const draft = await store.getDraft({
        policyId: input.policyId,
        draftId: input.draftId,
        scope: context.scope,
        actor: context.actor
      });
      return normalizedVersionInput({
        document: draft.document,
        approvalPolicy: {
          requiredApprovals: draft.requiredApprovals,
          disallowAuthorApproval: draft.disallowAuthorApproval
        }
      });
    },

    async submitDraft(input: ServiceInput = {}) {
      const context = authorize(input, 'author');
      const body = bodyOrEmpty(input.input);
      return store.submitDraft({
        policyId: input.policyId,
        draftId: input.draftId,
        scope: context.scope,
        actor: context.actor,
        expectedRevision: body.expectedRevision,
        idempotencyKey: input.idempotencyKey
      });
    },

    async listVersions(input: ServiceInput = {}) {
      const context = authorize(input, 'reader');
      await store.getPolicyStateInScope({ policyId: input.policyId, scope: context.scope });
      return store.listVersions({
        policyId: input.policyId,
        scope: context.scope,
        limit: input.limit
      });
    },

    async getVersion(input: ServiceInput = {}) {
      const context = authorize(input, 'reader');
      return store.getVersionInScope({
        policyId: input.policyId,
        versionId: input.versionId,
        scope: context.scope
      });
    },

    async simulateVersion(input: ServiceInput = {}) {
      const context = authorize(input, 'reader');
      const policy = await store.getPolicyStateInScope({
        policyId: input.policyId,
        scope: context.scope
      });
      const proposedVersion = await store.getVersionInScope({
        policyId: input.policyId,
        versionId: input.versionId,
        scope: context.scope
      });
      let baselineVersion = null;
      if (policy.activeVersionId) {
        baselineVersion = policy.activeVersionId === proposedVersion.versionId
          ? proposedVersion
          : await store.getVersionInScope({
              policyId: input.policyId,
              versionId: policy.activeVersionId,
              scope: context.scope
            });
      }
      return simulatePolicyImpact({
        scope: context.scope,
        proposedVersion,
        baselineVersion,
        request: input.input
      });
    },

    async getReviewState(input: ServiceInput = {}) {
      const context = authorize(input, 'reader');
      return store.getReviewState({
        policyId: input.policyId,
        versionId: input.versionId,
        scope: context.scope
      });
    },

    async claimReviewer(input: ServiceInput = {}) {
      const context = authorize(input, 'reviewer');
      assertReviewInputFields(input.input, new Set());
      return store.claimReviewer({
        policyId: input.policyId,
        versionId: input.versionId,
        scope: context.scope,
        actor: context.actor,
        authorizationEvidence: reviewerAuthorizationEvidence(context.authorization),
        idempotencyKey: input.idempotencyKey
      });
    },

    async recordReviewDecision(input: ServiceInput = {}) {
      const context = authorize(input, 'reviewer');
      const body = assertReviewInputFields(input.input, new Set(['decision', 'rationale']));
      return store.recordReviewDecision({
        policyId: input.policyId,
        versionId: input.versionId,
        scope: context.scope,
        actor: context.actor,
        authorizationEvidence: reviewerAuthorizationEvidence(context.authorization),
        decision: body.decision,
        rationale: body.rationale,
        idempotencyKey: input.idempotencyKey
      });
    },

    async listExceptions(input: ServiceInput = {}) {
      const context = authorize(input, 'reader');
      return store.listExceptions({
        policyId: input.policyId,
        versionId: input.versionId,
        scope: context.scope,
        limit: input.limit
      });
    },

    async getException(input: ServiceInput = {}) {
      const context = authorize(input, 'reader');
      return store.getException({ exceptionId: input.exceptionId, scope: context.scope });
    },

    async createException(input: ServiceInput = {}) {
      const context = authorize(input, 'author');
      const body = assertExceptionInputFields(input.input, new Set(['kind', 'action', 'ruleIds', 'target', 'reason', 'expiresAt']));
      return store.createExceptionRequest({
        policyId: input.policyId,
        versionId: input.versionId,
        scope: context.scope,
        actor: context.actor,
        authorizationEvidence: exceptionAuthorizationEvidence(context.authorization),
        request: body,
        idempotencyKey: input.idempotencyKey
      });
    },

    async decideException(input: ServiceInput = {}) {
      const context = authorize(input, 'administrator');
      const body = assertExceptionInputFields(input.input, new Set(['decision', 'reason']));
      return store.decideException({
        exceptionId: input.exceptionId,
        scope: context.scope,
        actor: context.actor,
        authorizationEvidence: exceptionAuthorizationEvidence(context.authorization),
        decision: body.decision,
        reason: body.reason,
        idempotencyKey: input.idempotencyKey
      });
    },

    async revokeException(input: ServiceInput = {}) {
      const context = authorize(input, 'administrator');
      const body = assertExceptionInputFields(input.input, new Set(['reason']));
      return store.revokeException({
        exceptionId: input.exceptionId,
        scope: context.scope,
        actor: context.actor,
        authorizationEvidence: exceptionAuthorizationEvidence(context.authorization),
        reason: body.reason,
        idempotencyKey: input.idempotencyKey
      });
    },

    async activateVersion(input: ServiceInput = {}) {
      const context = authorize(input, 'activator');
      const body = assertActivationInput(input.input);
      const idempotencyKey = assertRequiredIdempotencyKey(input.idempotencyKey);
      return store.activateVersion({
        policyId: input.policyId,
        versionId: input.versionId,
        scope: context.scope,
        actor: context.actor,
        authorizationEvidence: activatorAuthorizationEvidence(context.authorization),
        expectedRevision: body.expectedRevision,
        reason: body.reason,
        expectedSimulationHash: body.simulationHash,
        simulationRequest: body.simulationRequest,
        idempotencyKey
      });
    },

    async rollbackVersion(input: ServiceInput = {}) {
      const context = authorize(input, 'activator');
      const body = assertActivationInput(input.input);
      const idempotencyKey = assertRequiredIdempotencyKey(input.idempotencyKey);
      return store.rollbackVersion({
        policyId: input.policyId,
        versionId: input.versionId,
        scope: context.scope,
        actor: context.actor,
        authorizationEvidence: activatorAuthorizationEvidence(context.authorization),
        expectedRevision: body.expectedRevision,
        reason: body.reason,
        expectedSimulationHash: body.simulationHash,
        simulationRequest: body.simulationRequest,
        idempotencyKey
      });
    },

    async listActivationHistory(input: ServiceInput = {}) {
      const context = authorize(input, 'reader');
      return store.listActivationHistory({ policyId: input.policyId, scope: context.scope, limit: input.limit });
    },

    /*
     * The lifecycle. Switching a policy off takes the activator role, like
     * switching one on; setting policies aside, bringing them back and clearing
     * a repository take the administrator role. Authors can throw away their
     * own drafts and take back their own versions; an administrator can do
     * either for anybody, which is how stale work gets cleaned up.
     */
    async deactivatePolicy(input: ServiceInput = {}) {
      const context = authorize(input, 'activator');
      const body = assertLifecycleInput(input.input, ['expectedRevision', 'reason']);
      const idempotencyKey = assertRequiredIdempotencyKey(input.idempotencyKey, 'Switching a policy off and archiving it');
      return lifecycleStore('deactivatePolicy')({
        policyId: input.policyId, scope: context.scope, actor: context.actor,
        authorizationEvidence: activatorAuthorizationEvidence(context.authorization),
        expectedRevision: body.expectedRevision, reason: body.reason, idempotencyKey
      });
    },

    async archivePolicy(input: ServiceInput = {}) {
      const context = authorize(input, 'administrator');
      const body = assertLifecycleInput(input.input, ['expectedRevision', 'reason']);
      const idempotencyKey = assertRequiredIdempotencyKey(input.idempotencyKey, 'Switching a policy off and archiving it');
      return lifecycleStore('archivePolicy')({
        policyId: input.policyId, scope: context.scope, actor: context.actor,
        authorizationEvidence: activatorAuthorizationEvidence(context.authorization),
        expectedRevision: body.expectedRevision, reason: body.reason, idempotencyKey
      });
    },

    async restorePolicy(input: ServiceInput = {}) {
      const context = authorize(input, 'administrator');
      const body = assertLifecycleInput(input.input, ['reason']);
      return lifecycleStore('restorePolicy')({
        policyId: input.policyId, scope: context.scope, actor: context.actor,
        reason: body.reason, idempotencyKey: input.idempotencyKey
      });
    },

    async listArchivedPolicies(input: ServiceInput = {}) {
      const context = authorize(input, 'reader');
      return lifecycleStore('listArchivedPolicies')({ scope: context.scope, limit: input.limit });
    },

    async discardDraft(input: ServiceInput = {}) {
      const context = authorize(input, 'author');
      const body = assertLifecycleInput(input.input, ['expectedRevision']);
      return lifecycleStore('discardDraft')({
        policyId: input.policyId, draftId: input.draftId, scope: context.scope, actor: context.actor,
        expectedRevision: body.expectedRevision, idempotencyKey: input.idempotencyKey,
        allowOthers: context.authorization.governanceRoles.administrator === true
      });
    },

    async withdrawVersion(input: ServiceInput = {}) {
      const context = authorize(input, 'author');
      const body = assertLifecycleInput(input.input, ['reason']);
      return lifecycleStore('withdrawVersion')({
        policyId: input.policyId, versionId: input.versionId, scope: context.scope, actor: context.actor,
        reason: body.reason, idempotencyKey: input.idempotencyKey,
        allowOthers: context.authorization.governanceRoles.administrator === true
      });
    },

    async resetGovernance(input: ServiceInput = {}) {
      const context = authorize(input, 'administrator');
      const body = assertLifecycleInput(input.input, ['reason', 'confirm']);
      const idempotencyKey = assertRequiredIdempotencyKey(input.idempotencyKey, 'A governance reset and its confirmation');
      /* Typed, not clicked: the repository's own name, the same confirmation
       * deleting the repository asks for. */
      const expected = `${context.scope.owner}/${context.scope.repo}`.toLowerCase();
      if ((body.confirm || '').toLowerCase() !== expected) {
        fail('Type the repository name exactly to reset its governance', 'GOVERNANCE_RESET_CONFIRMATION_REQUIRED', 400);
      }
      return lifecycleStore('resetGovernance')({
        scope: context.scope, actor: context.actor,
        authorizationEvidence: activatorAuthorizationEvidence(context.authorization),
        reason: body.reason, idempotencyKey
      });
    }
  });
}
