import { normalizePolicyScope, normalizePolicyDocument, normalizeApprovalPolicy, policyDocumentHash } from '../domain/governance-model.ts';
import type { ApprovalPolicy, PolicyDocument } from '../domain/governance-model.ts';
import { GOVERNANCE_ROLE_NAMES, normalizeAuthorizationSnapshot } from '../../../platform/authorization/authorization-resolver.ts';
import type { AuthorizationSnapshot, GovernanceRoleName } from '../../../../../../packages/contracts/src/actor.ts';
import { isSha256Hex } from '../../../../../../packages/contracts/src/ids.ts';
import type { RepositoryScope } from '../../../../../../packages/contracts/src/scope.ts';
import { normalizeSimulationRequest } from '../domain/governance-simulation.ts';
import type { SimulationRequest } from '../domain/governance-simulation.ts';
import { property } from '../../../platform/values/fields.ts';

/*
 * What a governance request must carry before the service acts on it.
 *
 * The caller's authorization for the repository, held to the role an
 * operation needs, and the checks each operation's input passes: a review,
 * an activation and a lifecycle change, an exception, a delivery, a version
 * and its numbers. A refusal is a GovernanceApiError with its own code and
 * status. governance-api.ts runs the operations; this is what they ask first.
 */

export type Fields = Readonly<Record<string, unknown>>;

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

export function fail(message: string, code: string, status = 400): never {
  throw new GovernanceApiError(message, code, status);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
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


export function bodyObject(value: unknown): Fields {
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
export function bodyOrEmpty(value: unknown): Fields {
  return value && typeof value === 'object' ? value as Fields : {};
}

export function assertReviewInputFields(input: unknown, allowed: ReadonlySet<string>): Fields {
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

export const reviewerAuthorizationEvidence = authorizationEvidence;
export const activatorAuthorizationEvidence = authorizationEvidence;
export const exceptionAuthorizationEvidence = authorizationEvidence;

interface ActivationInput {
  readonly expectedRevision: number;
  readonly reason: string;
  readonly simulationHash: string;
  readonly simulationRequest: SimulationRequest;
}

export function assertActivationInput(input: unknown): ActivationInput {
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

export function assertRequiredIdempotencyKey(value: unknown, label = 'Activation and rollback'): string {
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
export function assertLifecycleInput(input: unknown, allowedFields: readonly string[]): Readonly<LifecycleInput> {
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

export function assertExceptionInputFields(input: unknown, allowed: ReadonlySet<string>): Fields {
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

export function assertDeliveryInputFields(input: unknown, allowed: ReadonlySet<string>): Fields {
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

export function integerInput(value: unknown, label: string, options: IntegerOptions = {}): number | null {
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

export function normalizedVersionInput(input: unknown = {}): VersionInput {
  const document = normalizePolicyDocument(property(input, 'document'));
  const approvalPolicy = normalizeApprovalPolicy(property(input, 'approvalPolicy'));
  return deepFreeze({ document, documentHash: policyDocumentHash(document), approvalPolicy });
}
