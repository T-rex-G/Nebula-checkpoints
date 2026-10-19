import { createHash } from 'node:crypto';
import { MUTATION_ID, POLICY_KEY } from '../../../../../../packages/contracts/src/ids.ts';

const CATALOG_ID = 'nebulaverse-control-catalog';
const CATALOG_VERSION = '1.7.0';
const TASK_23_CATALOG_VERSION = '1.6.0';
const TASK_22_CATALOG_VERSION = '1.5.0';
const TASK_21_CATALOG_VERSION = '1.4.0';
const TASK_20_CATALOG_VERSION = '1.3.0';
const TASK_19_CATALOG_VERSION = '1.2.0';
const TASK_14_CATALOG_VERSION = '1.1.0';
const LEGACY_CATALOG_VERSION = '1.0.0';
const FRAMEWORK_REVISION = '2017-revised-2022';
const MAX_CONTROL_REFS = 32;
const MAX_MAPPING_CONTROLS = 64;
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SENSITIVE_KEY_RX = /(?:token|secret|password|privatekey|authorization|cookie)/i;
/* A policy and its version are named by UUIDs of the form a mutation id has (versions 1 to 5); a rule by an id of the form a policy key has. */
const POLICY_RECORD_ID = MUTATION_ID;
const POLICY_RULE_ID = POLICY_KEY;

export class ControlMappingError extends Error {
  override readonly name = 'ControlMappingError';
  readonly code: string;
  readonly status: number;

  constructor(message: string, code = 'POLICY_CONTROL_MAPPING_INVALID', status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function fail(message: string, code = 'POLICY_CONTROL_MAPPING_INVALID', status = 400): never {
  throw new ControlMappingError(message, code, status);
}

type Fields = Readonly<Record<string, unknown>>;

function isPlainObject(value: unknown): value is Fields {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/* Own entries only: an inherited name such as `constructor` is not a catalogue entry. */
function own<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/*
 * The catalogue's canonical JSON: catalogue and mapping hashes are recorded
 * evidence, so this stays byte for byte (one of the server's eight copies,
 * unified only with proof in Phase G).
 */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Fields;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : stableJson(value), 'utf8').digest('hex');
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

interface ControlDefinition {
  readonly framework: string;
  readonly frameworkVersion: string;
  readonly controlId: string;
  readonly title: string;
}

const CONTROL_DEFINITIONS: Readonly<Record<string, ControlDefinition>> = Object.freeze({
  'SOC2-TSC:CC6.1': Object.freeze({
    framework: 'SOC2-TSC', frameworkVersion: FRAMEWORK_REVISION, controlId: 'CC6.1',
    title: 'Logical access security evidence'
  }),
  'SOC2-TSC:CC8.1': Object.freeze({
    framework: 'SOC2-TSC', frameworkVersion: FRAMEWORK_REVISION, controlId: 'CC8.1',
    title: 'Change management evidence'
  })
});

const ACTIONS_WITHOUT_APPROVED_MAPPING = new Set(['repository.star', 'repository.unstar']);
const BASE_MAPPED_ACTIONS = Object.freeze([
  'repository.create', 'repository.delete', 'branch.create', 'branch.delete', 'branch.reset',
  'file.write', 'file.delete', 'file.rename', 'file.batch', 'file.upload', 'directory.move',
  'git.blob.create', 'commit.revert', 'commit.restore', 'commit.restore-paths',
  'pull.create', 'pull.merge', 'pull.review', 'issue.create', 'issue.comment', 'issue.update',
  'workflow.rerun', 'release.create', 'recovery.restore-refs', 'webhook.connect', 'webhook.disconnect',
  'governance.policy.create', 'governance.draft.create', 'governance.draft.update',
  'governance.draft.submit', 'governance.reviewer.assign', 'governance.approval.decide',
  'governance.policy.activate', 'governance.policy.rollback'
]);
const TASK_14_MAPPED_ACTIONS = Object.freeze([
  'governance.exception.request', 'governance.exception.decide', 'governance.exception.revoke'
]);
const TASK_19_MAPPED_ACTIONS = Object.freeze([
  'governance.notification.preferences.update', 'governance.notification.read',
  'governance.webhook.create', 'governance.webhook.update', 'governance.webhook.rotate', 'governance.webhook.delete',
  'governance.audit.export.create'
]);

/*
 * Exposure scanning. A revision is append-only because a stored policy names a
 * catalog version and hash: editing 1.2.0 to add these would change what an
 * already-approved policy covers without anybody approving it.
 */
const TASK_20_MAPPED_ACTIONS = Object.freeze([
  'exposure.scan.request', 'exposure.scan.cancel',
  'exposure.credential.verify', 'exposure.readability.probe',
  'exposure.finding.accept-risk', 'exposure.finding.export'
]);

/*
 * Clearing an identity's exposure history. A new revision rather than an edit
 * to 1.3.0, for the same reason 1.3.0 was not an edit to 1.2.0: a stored
 * policy names the version and hash it was approved against.
 */
const TASK_21_MAPPED_ACTIONS = Object.freeze(['exposure.history.clear']);

/*
 * The governance lifecycle: switching off, archiving, restoring, discarding,
 * withdrawing and resetting. 1.4.0 stays exactly as it was approved.
 */
const TASK_22_MAPPED_ACTIONS = Object.freeze([
  'governance.policy.deactivate', 'governance.policy.archive', 'governance.policy.restore',
  'governance.draft.discard', 'governance.version.withdraw', 'governance.reset'
]);

/*
 * Clearing an identity's repository audit history. A revision of its own,
 * for the reason every revision is one: 1.5.0 stays exactly as approved.
 */
const TASK_23_MAPPED_ACTIONS = Object.freeze(['code-audit.history.clear']);

/*
 * A team's decisions about its audit findings: recording one, and taking it
 * back. 1.6.0 stays exactly as approved, and does not cover them.
 */
const TASK_24_MAPPED_ACTIONS = Object.freeze(['code-audit.finding.triage', 'code-audit.finding.reopen']);

type ActionMappings = Readonly<Record<string, readonly string[]>>;

function actionControlRefs(actions: readonly string[]): ActionMappings {
  return Object.freeze(Object.fromEntries(actions.map(action => [action, Object.freeze(['SOC2-TSC:CC6.1', 'SOC2-TSC:CC8.1'])])));
}

/* A published catalogue: what each action is mapped to, and the hash a stored policy cites. */
export interface ControlCatalog {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly frameworkRevision: string;
  readonly controls: readonly ({ readonly ref: string } & ControlDefinition)[];
  readonly actionMappings: readonly { readonly action: string; readonly controlRefs: readonly string[] }[];
  readonly intentionallyUnmappedActions: readonly string[];
  readonly hash: string;
}

function createCatalog(version: string, mappings: ActionMappings): ControlCatalog {
  const body = {
    schemaVersion: 1 as const,
    id: CATALOG_ID,
    version,
    frameworkRevision: FRAMEWORK_REVISION,
    controls: Object.keys(CONTROL_DEFINITIONS).sort().map(ref => ({ ref, ...CONTROL_DEFINITIONS[ref] as ControlDefinition })),
    actionMappings: Object.keys(mappings).sort().map(action => ({ action, controlRefs: mappings[action] as readonly string[] })),
    intentionallyUnmappedActions: [...ACTIONS_WITHOUT_APPROVED_MAPPING].sort()
  };
  return deepFreeze({ ...body, hash: sha256(body) });
}

const LEGACY_ACTION_CONTROL_REFS = actionControlRefs(BASE_MAPPED_ACTIONS);
const TASK_14_ACTION_CONTROL_REFS = actionControlRefs([...BASE_MAPPED_ACTIONS, ...TASK_14_MAPPED_ACTIONS]);
const TASK_19_ACTION_CONTROL_REFS = actionControlRefs([...BASE_MAPPED_ACTIONS, ...TASK_14_MAPPED_ACTIONS, ...TASK_19_MAPPED_ACTIONS]);
const TASK_20_ACTION_CONTROL_REFS = actionControlRefs([
  ...BASE_MAPPED_ACTIONS, ...TASK_14_MAPPED_ACTIONS, ...TASK_19_MAPPED_ACTIONS, ...TASK_20_MAPPED_ACTIONS
]);
const TASK_21_ACTION_CONTROL_REFS = actionControlRefs([
  ...BASE_MAPPED_ACTIONS, ...TASK_14_MAPPED_ACTIONS, ...TASK_19_MAPPED_ACTIONS, ...TASK_20_MAPPED_ACTIONS,
  ...TASK_21_MAPPED_ACTIONS
]);
const TASK_22_ACTION_CONTROL_REFS = actionControlRefs([
  ...BASE_MAPPED_ACTIONS, ...TASK_14_MAPPED_ACTIONS, ...TASK_19_MAPPED_ACTIONS, ...TASK_20_MAPPED_ACTIONS,
  ...TASK_21_MAPPED_ACTIONS, ...TASK_22_MAPPED_ACTIONS
]);
const TASK_23_ACTION_CONTROL_REFS = actionControlRefs([
  ...BASE_MAPPED_ACTIONS, ...TASK_14_MAPPED_ACTIONS, ...TASK_19_MAPPED_ACTIONS, ...TASK_20_MAPPED_ACTIONS,
  ...TASK_21_MAPPED_ACTIONS, ...TASK_22_MAPPED_ACTIONS, ...TASK_23_MAPPED_ACTIONS
]);
const ACTION_CONTROL_REFS = actionControlRefs([
  ...BASE_MAPPED_ACTIONS, ...TASK_14_MAPPED_ACTIONS, ...TASK_19_MAPPED_ACTIONS, ...TASK_20_MAPPED_ACTIONS,
  ...TASK_21_MAPPED_ACTIONS, ...TASK_22_MAPPED_ACTIONS, ...TASK_23_MAPPED_ACTIONS, ...TASK_24_MAPPED_ACTIONS
]);
export const LEGACY_CONTROL_CATALOG = createCatalog(LEGACY_CATALOG_VERSION, LEGACY_ACTION_CONTROL_REFS);
export const TASK_14_CONTROL_CATALOG = createCatalog(TASK_14_CATALOG_VERSION, TASK_14_ACTION_CONTROL_REFS);
export const TASK_19_CONTROL_CATALOG = createCatalog(TASK_19_CATALOG_VERSION, TASK_19_ACTION_CONTROL_REFS);
export const TASK_20_CONTROL_CATALOG = createCatalog(TASK_20_CATALOG_VERSION, TASK_20_ACTION_CONTROL_REFS);
export const TASK_21_CONTROL_CATALOG = createCatalog(TASK_21_CATALOG_VERSION, TASK_21_ACTION_CONTROL_REFS);
export const TASK_22_CONTROL_CATALOG = createCatalog(TASK_22_CATALOG_VERSION, TASK_22_ACTION_CONTROL_REFS);
export const TASK_23_CONTROL_CATALOG = createCatalog(TASK_23_CATALOG_VERSION, TASK_23_ACTION_CONTROL_REFS);
export const CONTROL_CATALOG = createCatalog(CATALOG_VERSION, ACTION_CONTROL_REFS);

interface CatalogDefinition {
  readonly catalog: ControlCatalog;
  readonly actionMappings: ActionMappings;
}

const CONTROL_CATALOGS: Readonly<Record<string, CatalogDefinition>> = Object.freeze({
  [LEGACY_CONTROL_CATALOG.version]: Object.freeze({ catalog: LEGACY_CONTROL_CATALOG, actionMappings: LEGACY_ACTION_CONTROL_REFS }),
  [TASK_14_CONTROL_CATALOG.version]: Object.freeze({ catalog: TASK_14_CONTROL_CATALOG, actionMappings: TASK_14_ACTION_CONTROL_REFS }),
  [TASK_19_CONTROL_CATALOG.version]: Object.freeze({ catalog: TASK_19_CONTROL_CATALOG, actionMappings: TASK_19_ACTION_CONTROL_REFS }),
  [TASK_20_CONTROL_CATALOG.version]: Object.freeze({ catalog: TASK_20_CONTROL_CATALOG, actionMappings: TASK_20_ACTION_CONTROL_REFS }),
  [TASK_21_CONTROL_CATALOG.version]: Object.freeze({ catalog: TASK_21_CONTROL_CATALOG, actionMappings: TASK_21_ACTION_CONTROL_REFS }),
  [TASK_22_CONTROL_CATALOG.version]: Object.freeze({ catalog: TASK_22_CONTROL_CATALOG, actionMappings: TASK_22_ACTION_CONTROL_REFS }),
  [TASK_23_CONTROL_CATALOG.version]: Object.freeze({ catalog: TASK_23_CONTROL_CATALOG, actionMappings: TASK_23_ACTION_CONTROL_REFS }),
  [CONTROL_CATALOG.version]: Object.freeze({ catalog: CONTROL_CATALOG, actionMappings: ACTION_CONTROL_REFS })
});

function catalogDefinitionOf(input: unknown): CatalogDefinition | null {
  if (!isPlainObject(input) || input.id !== CATALOG_ID) return null;
  const definition = own(CONTROL_CATALOGS, String(input.version || ''));
  if (!definition || input.frameworkRevision !== definition.catalog.frameworkRevision || input.hash !== definition.catalog.hash) return null;
  return definition;
}

function normalizeControlRef(value: unknown): string {
  const ref = String(value == null ? '' : value).trim().toUpperCase();
  if (!/^[A-Z0-9-]{2,32}:[A-Z0-9.:-]{2,40}$/.test(ref) || !own(CONTROL_DEFINITIONS, ref)) {
    fail(`Unknown governance control reference: ${ref || '(empty)'}`, 'GOVERNANCE_CONTROL_UNKNOWN');
  }
  return ref;
}

export function normalizeControlRefs(input: unknown): readonly string[] {
  if (input == null) return Object.freeze([]);
  if (!Array.isArray(input) || input.length > MAX_CONTROL_REFS) {
    fail('Governance control references must be a bounded array', 'GOVERNANCE_CONTROL_REFS_INVALID');
  }
  return Object.freeze([...new Set((input as readonly unknown[]).map(normalizeControlRef))].sort());
}

function boundedId(value: unknown, label: string, pattern: RegExp, max = 100): string {
  const text = String(value == null ? '' : value).trim().toLowerCase();
  if (!text || text.length > max || !pattern.test(text)) fail(`${label} is invalid`);
  return text;
}

/* Why a control is in a mapping: the action's own catalogue entry, or a policy rule that cites it. */
export type MappingSource =
  | { readonly source: 'action-catalog'; readonly action: string }
  | { readonly source: 'policy-rule'; readonly policyId: string; readonly versionId: string; readonly ruleId: string };

export interface MappedControl {
  readonly framework: string;
  readonly frameworkVersion: string;
  readonly controlId: string;
  readonly relationship: 'supports';
  readonly source: string;
  readonly sources: readonly MappingSource[];
}

function mappingControl(ref: string, sources: readonly MappingSource[]): MappedControl {
  const definition = CONTROL_DEFINITIONS[ref] as ControlDefinition;
  const normalizedSources = [...sources]
    .sort((a, b) => stableJson(a).localeCompare(stableJson(b)));
  const sourceKinds = [...new Set(normalizedSources.map(item => item.source))];
  return {
    framework: definition.framework,
    frameworkVersion: definition.frameworkVersion,
    controlId: definition.controlId,
    relationship: 'supports',
    source: sourceKinds.length > 1 ? 'action-and-policy' : sourceKinds[0] as string,
    sources: normalizedSources
  };
}

/* The controls a mutation's evidence supports, and the hash that binds the answer. */
export interface ControlMapping {
  readonly schemaVersion: 1;
  readonly status: string;
  readonly catalog: Readonly<{ id: unknown; version: unknown; frameworkRevision: unknown; hash: unknown }>;
  readonly controls: readonly MappedControl[];
  readonly unmappedReasons: readonly string[];
  readonly mappingHash: string;
}

export function deriveControlMapping(input: Fields = {}): ControlMapping {
  const action = String(input.action || '').trim().toLowerCase();
  const catalogDefinition = own(CONTROL_CATALOGS, String(input.catalogVersion || CONTROL_CATALOG.version));
  if (!catalogDefinition) return fail('Control mapping catalog version is unsupported');
  const byRef = new Map<string, MappingSource[]>();
  const add = (ref: string, source: MappingSource): void => {
    if (!own(CONTROL_DEFINITIONS, ref)) return;
    if (!byRef.has(ref)) byRef.set(ref, []);
    const list = byRef.get(ref) as MappingSource[];
    const encoded = stableJson(source);
    if (!list.some(item => stableJson(item) === encoded)) list.push(source);
  };

  for (const ref of own(catalogDefinition.actionMappings, action) || []) add(ref, { source: 'action-catalog', action });
  const evaluations: readonly unknown[] = Array.isArray(input.policyEvaluations) ? input.policyEvaluations : [];
  for (const evaluation of evaluations.slice(0, 100)) {
    if (!isPlainObject(evaluation)) continue;
    const policyId = boundedId(evaluation.policyId, 'Policy id', POLICY_RECORD_ID, 36);
    const versionId = boundedId(evaluation.versionId, 'Policy version id', POLICY_RECORD_ID, 36);
    const matchedRules: readonly unknown[] = Array.isArray(evaluation.matchedRules) ? evaluation.matchedRules : [];
    for (const rule of matchedRules.slice(0, 200)) {
      if (!isPlainObject(rule)) continue;
      const ruleId = boundedId(rule.id, 'Policy rule id', POLICY_RULE_ID, 64);
      for (const ref of normalizeControlRefs(rule.controlRefs || [])) {
        add(ref, { source: 'policy-rule', policyId, versionId, ruleId });
      }
    }
  }

  const controls = [...byRef.keys()].sort().map(ref => mappingControl(ref, byRef.get(ref) as MappingSource[]));
  if (controls.length > MAX_MAPPING_CONTROLS) fail('Control mapping contains too many controls');
  const status = controls.length ? 'mapped' : 'unmapped';
  const unmappedReasons: string[] = [];
  if (!controls.length) {
    unmappedReasons.push(ACTIONS_WITHOUT_APPROVED_MAPPING.has(action)
      ? 'NO_APPROVED_CONTROL_FOR_ACTION'
      : 'ACTION_NOT_PRESENT_IN_CATALOG');
  }
  const mappingBody = {
    schemaVersion: 1 as const,
    status,
    catalog: {
      id: catalogDefinition.catalog.id,
      version: catalogDefinition.catalog.version,
      frameworkRevision: catalogDefinition.catalog.frameworkRevision,
      hash: catalogDefinition.catalog.hash
    },
    controls,
    unmappedReasons
  };
  return deepFreeze({ ...mappingBody, mappingHash: sha256(mappingBody) });
}

function assertNoSensitiveKeys(value: unknown, path = '$', depth = 0): void {
  if (depth > 8) fail('Control mapping is nested too deeply');
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    if (value.length > 250) fail('Control mapping array is too large');
    (value as readonly unknown[]).forEach((entry, index) => assertNoSensitiveKeys(entry, `${path}[${index}]`, depth + 1));
    return;
  }
  if (!isPlainObject(value)) return fail('Control mapping must be JSON-compatible');
  const keys = Object.keys(value);
  if (keys.length > 100) fail('Control mapping object has too many fields');
  for (const key of keys) {
    if (!key || key.length > 100 || DANGEROUS_KEYS.has(key.toLowerCase()) || SENSITIVE_KEY_RX.test(key.replace(/[^a-z0-9]/gi, ''))) {
      fail(`Sensitive or invalid control mapping field at ${path}.${key}`);
    }
    assertNoSensitiveKeys(value[key], `${path}.${key}`, depth + 1);
  }
}

function normalizeSource(input: unknown, catalogDefinition: CatalogDefinition): MappingSource {
  if (!isPlainObject(input)) return fail('Control mapping source is invalid');
  const source = String(input.source || '').trim();
  if (source === 'action-catalog') {
    const action = String(input.action || '').trim().toLowerCase();
    if (!catalogDefinition || !own(catalogDefinition.actionMappings, action)) fail('Control action source is invalid');
    return { source, action };
  }
  if (source === 'policy-rule') {
    return {
      source,
      policyId: boundedId(input.policyId, 'Policy id', POLICY_RECORD_ID, 36),
      versionId: boundedId(input.versionId, 'Policy version id', POLICY_RECORD_ID, 36),
      ruleId: boundedId(input.ruleId, 'Policy rule id', POLICY_RULE_ID, 64)
    };
  }
  return fail('Control mapping source is unsupported');
}

export function normalizeControlMapping(input: unknown): ControlMapping {
  if (!isPlainObject(input)) return fail('Control mapping must be an object');
  assertNoSensitiveKeys(input);
  if (Number(input.schemaVersion) !== 1 || !['mapped', 'partial', 'unmapped', 'unavailable'].includes(String(input.status || ''))) {
    fail('Control mapping schema or status is invalid');
  }
  const catalog = input.catalog as Fields;
  const catalogDefinition = catalogDefinitionOf(catalog);
  if (!catalogDefinition) return fail('Control mapping catalog identity is invalid');
  const rawControls = input.controls;
  if (!Array.isArray(rawControls) || rawControls.length > MAX_MAPPING_CONTROLS) fail('Control mapping controls are invalid');
  const seen = new Set<string>();
  const controls = (rawControls as readonly unknown[]).map(raw => {
    if (!isPlainObject(raw)) return fail('Mapped control is invalid');
    let ref: string;
    try { ref = normalizeControlRef(`${String(raw.framework)}:${String(raw.controlId)}`); }
    catch { return fail('Mapped control reference is invalid'); }
    const definition = CONTROL_DEFINITIONS[ref] as ControlDefinition;
    if (raw.frameworkVersion !== definition.frameworkVersion || raw.relationship !== 'supports') fail('Mapped control definition is invalid');
    const rawSources = raw.sources;
    if (!Array.isArray(rawSources) || rawSources.length < 1 || rawSources.length > 100) return fail('Mapped control sources are invalid');
    const sources = (rawSources as readonly unknown[]).map(source => normalizeSource(source, catalogDefinition)).sort((a, b) => stableJson(a).localeCompare(stableJson(b)));
    const expectedSource = [...new Set(sources.map(item => item.source))].length > 1 ? 'action-and-policy' : (sources[0] as MappingSource).source;
    if (raw.source !== expectedSource || seen.has(ref)) fail('Mapped control source or uniqueness is invalid');
    seen.add(ref);
    return mappingControl(ref, sources);
  }).sort((a, b) => `${a.framework}:${a.controlId}`.localeCompare(`${b.framework}:${b.controlId}`));
  const reasons = Array.isArray(input.unmappedReasons) ? [...new Set((input.unmappedReasons as readonly unknown[]).map(value => String(value || '').trim()))].sort() : [];
  if (reasons.some(value => !/^[A-Z][A-Z0-9_]{2,79}$/.test(value))) fail('Control mapping reason is invalid');
  if (input.status === 'mapped' && !controls.length) fail('Mapped control status requires controls');
  if (input.status === 'unmapped' && controls.length) fail('Unmapped control status cannot contain controls');
  const body = {
    schemaVersion: 1 as const,
    status: input.status as string,
    catalog: { id: catalog.id, version: catalog.version, frameworkRevision: catalog.frameworkRevision, hash: catalog.hash },
    controls,
    unmappedReasons: reasons
  };
  if (String(input.mappingHash || '').toLowerCase() !== sha256(body)) fail('Control mapping hash is invalid');
  return deepFreeze({ ...body, mappingHash: sha256(body) });
}
