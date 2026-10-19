/*
 * What the deployment can do, and how it knows.
 *
 * The capability document (config/capabilities.json) states, per provider and
 * deployment profile, each feature's status, the kind of evidence behind that
 * status and the reason. The server resolves it for a session and sends the
 * page the result. Only what is Supported is served.
 *
 * Ported from src/capability-registry.js with its behaviour and messages
 * unchanged. Its refusals are TypeErrors there, because a malformed document
 * is a deployment fault and not a request's.
 */
import { deepFreeze, refuseWithContractError } from './guards.ts';
import type { Refuse } from './guards.ts';

export const CAPABILITY_CONTRACT_VERSION = 1;
export const CAPABILITY_SCHEMA_VERSION = '1.0.0';
export const CAPABILITY_RELEASE = '5.3.0-alpha.17.0';

export const FEATURE_RX = /^[a-z][a-z0-9.-]{1,80}$/;
export const PROVIDER_RX = /^github$/;
export const CAPABILITY_STATUSES = Object.freeze(['Supported', 'Experimental', 'Unavailable'] as const);
export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];
/* The beta profile exists ahead of the rename so that its rule is enforced from the first document that uses it. */
export const DEPLOYMENT_PROFILES = Object.freeze(['hosted-alpha', 'hosted-beta'] as const);
export type DeploymentProfile = (typeof DEPLOYMENT_PROFILES)[number];
export const CAPABILITY_EVIDENCE_STATES = Object.freeze(['Provider-verified', 'Deterministic', 'Inferred', 'Stale', 'Unavailable'] as const);
export type CapabilityEvidenceState = (typeof CAPABILITY_EVIDENCE_STATES)[number];

/* The page's older capability flags and the feature each one reads. */
export const LEGACY_CAPABILITY_FEATURES = Object.freeze({
  prs: 'pulls.read', issues: 'issues.read', releases: 'releases.read',
  actions: 'workflows.read', lfs: 'lfs', tm: 'recovery',
  batch: 'file.batch', search: 'search', notif: 'notifications', compare: 'recovery'
} as const);
export type LegacyCapabilityKey = keyof typeof LEGACY_CAPABILITY_FEATURES;

export type CapabilityTuple = readonly [status: CapabilityStatus, evidenceState: CapabilityEvidenceState, reason: string];

export interface CapabilityDocument {
  readonly schemaVersion: typeof CAPABILITY_SCHEMA_VERSION;
  readonly release: typeof CAPABILITY_RELEASE;
  readonly statuses: readonly CapabilityStatus[];
  readonly evidenceStates: readonly CapabilityEvidenceState[];
  readonly defaults: {
    readonly status: 'Unavailable';
    readonly evidenceState: 'Unavailable';
    readonly reason?: string;
    readonly limits?: Readonly<Record<string, unknown>>;
  };
  readonly providers: Readonly<Record<string, Readonly<Partial<Record<DeploymentProfile, Readonly<Record<string, CapabilityTuple>>>>>>>;
}

/* One feature as a session may use it. A connection restriction makes an implemented feature Unavailable and says so. */
export interface ResolvedCapability {
  readonly feature: string;
  readonly provider: string;
  readonly authority: string;
  readonly deployment: string;
  readonly status: CapabilityStatus;
  readonly evidenceState: CapabilityEvidenceState;
  readonly reason: string;
  readonly availabilityCode?: string;
  readonly implementationStatus?: CapabilityStatus;
  readonly limits: Readonly<Record<string, unknown>>;
}

export interface CapabilityProjection {
  readonly provider: string;
  readonly authority: string;
  readonly deployment: string;
  readonly features: Readonly<Record<string, ResolvedCapability>>;
}

export type LegacyCapabilities = Readonly<Record<LegacyCapabilityKey, boolean>>;

function hasExactVocabulary(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && value.length === expected.length &&
    new Set(value).size === expected.length && expected.every(entry => value.includes(entry));
}

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> => Boolean(value) && typeof value === 'object';

export function validateCapabilityDocument(input: unknown, refuse: Refuse = refuseWithContractError): CapabilityDocument {
  const fail = (message: string): never => refuse(message, 'CAPABILITY_DOCUMENT_INVALID');
  if (!isObject(input) || input.schemaVersion !== CAPABILITY_SCHEMA_VERSION) return fail('capability schemaVersion must be 1.0.0');
  if (input.release !== CAPABILITY_RELEASE) fail('capability release must match 5.3.0-alpha.17.0');
  if (!hasExactVocabulary(input.statuses, CAPABILITY_STATUSES)) {
    fail('capability statuses must be exactly Supported, Experimental, Unavailable');
  }
  if (!hasExactVocabulary(input.evidenceStates, CAPABILITY_EVIDENCE_STATES)) {
    fail('capability evidenceStates must be exactly Provider-verified, Deterministic, Inferred, Stale, Unavailable');
  }
  const defaults = input.defaults;
  if (!isObject(defaults) || defaults.status !== 'Unavailable') fail('default capability status must be Unavailable');
  if (!isObject(defaults) || defaults.evidenceState !== 'Unavailable') fail('default capability evidenceState must be Unavailable');
  const statuses = new Set<unknown>(CAPABILITY_STATUSES);
  const evidence = new Set<unknown>(CAPABILITY_EVIDENCE_STATES);
  const deployments = new Set<string>(DEPLOYMENT_PROFILES);
  /* Object() as the original's `|| {}` read them: whatever stands there is walked for its keys, as Object.keys walks it. */
  const entries = (value: unknown): [string, unknown][] => Object.entries(Object(value || {}) as Record<string, unknown>);
  for (const [provider, profiles] of entries(input.providers)) {
    if (!PROVIDER_RX.test(provider)) fail(`unsupported capability provider: ${provider}`);
    for (const [deployment, features] of entries(profiles)) {
      if (!deployments.has(deployment)) fail(`unsupported deployment profile: ${deployment}`);
      for (const [feature, tuple] of entries(features)) {
        if (!FEATURE_RX.test(feature)) fail(`invalid capability feature: ${feature}`);
        if (!Array.isArray(tuple) || tuple.length !== 3) return fail(`capability ${feature} must be [status,evidenceState,reason]`);
        if (!statuses.has(tuple[0])) fail(`invalid capability status: ${String(tuple[0])}`);
        if (deployment === 'hosted-beta' && tuple[0] === 'Experimental') {
          fail(`hosted-beta cannot carry Experimental capability ${feature}`);
        }
        if (!evidence.has(tuple[1])) fail(`invalid evidence state: ${String(tuple[1])}`);
        if (!String(tuple[2] || '').trim()) fail(`capability ${feature} requires a reason`);
      }
    }
  }
  return deepFreeze(JSON.parse(JSON.stringify(input)) as CapabilityDocument);
}
