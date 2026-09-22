'use strict';

const crypto = require('crypto');

const CATALOG_ID = 'nebulaverse-control-catalog';
const CATALOG_VERSION = '1.3.0';
const TASK_19_CATALOG_VERSION = '1.2.0';
const TASK_14_CATALOG_VERSION = '1.1.0';
const LEGACY_CATALOG_VERSION = '1.0.0';
const FRAMEWORK_REVISION = '2017-revised-2022';
const MAX_CONTROL_REFS = 32;
const MAX_MAPPING_CONTROLS = 64;
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SENSITIVE_KEY_RX = /(?:token|secret|password|privatekey|authorization|cookie)/i;

class ControlMappingError extends Error {
  constructor(message, code = 'POLICY_CONTROL_MAPPING_INVALID', status = 400) {
    super(message);
    this.name = 'ControlMappingError';
    this.code = code;
    this.status = status;
  }
}

function fail(message, code = 'POLICY_CONTROL_MAPPING_INVALID', status = 400) {
  throw new ControlMappingError(message, code, status);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : stableJson(value), 'utf8').digest('hex');
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

const CONTROL_DEFINITIONS = Object.freeze({
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

function actionControlRefs(actions) {
  return Object.freeze(Object.fromEntries(actions.map(action => [action, Object.freeze(['SOC2-TSC:CC6.1', 'SOC2-TSC:CC8.1'])])));
}

function createCatalog(version, mappings) {
  const body = {
    schemaVersion: 1,
    id: CATALOG_ID,
    version,
    frameworkRevision: FRAMEWORK_REVISION,
    controls: Object.keys(CONTROL_DEFINITIONS).sort().map(ref => ({ ref, ...CONTROL_DEFINITIONS[ref] })),
    actionMappings: Object.keys(mappings).sort().map(action => ({ action, controlRefs: mappings[action] })),
    intentionallyUnmappedActions: [...ACTIONS_WITHOUT_APPROVED_MAPPING].sort()
  };
  return deepFreeze({ ...body, hash: sha256(body) });
}

const LEGACY_ACTION_CONTROL_REFS = actionControlRefs(BASE_MAPPED_ACTIONS);
const TASK_14_ACTION_CONTROL_REFS = actionControlRefs([...BASE_MAPPED_ACTIONS, ...TASK_14_MAPPED_ACTIONS]);
const TASK_19_ACTION_CONTROL_REFS = actionControlRefs([...BASE_MAPPED_ACTIONS, ...TASK_14_MAPPED_ACTIONS, ...TASK_19_MAPPED_ACTIONS]);
const ACTION_CONTROL_REFS = actionControlRefs([
  ...BASE_MAPPED_ACTIONS, ...TASK_14_MAPPED_ACTIONS, ...TASK_19_MAPPED_ACTIONS, ...TASK_20_MAPPED_ACTIONS
]);
const LEGACY_CONTROL_CATALOG = createCatalog(LEGACY_CATALOG_VERSION, LEGACY_ACTION_CONTROL_REFS);
const TASK_14_CONTROL_CATALOG = createCatalog(TASK_14_CATALOG_VERSION, TASK_14_ACTION_CONTROL_REFS);
const TASK_19_CONTROL_CATALOG = createCatalog(TASK_19_CATALOG_VERSION, TASK_19_ACTION_CONTROL_REFS);
const CONTROL_CATALOG = createCatalog(CATALOG_VERSION, ACTION_CONTROL_REFS);
const CONTROL_CATALOGS = Object.freeze({
  [LEGACY_CONTROL_CATALOG.version]: Object.freeze({ catalog: LEGACY_CONTROL_CATALOG, actionMappings: LEGACY_ACTION_CONTROL_REFS }),
  [TASK_14_CONTROL_CATALOG.version]: Object.freeze({ catalog: TASK_14_CONTROL_CATALOG, actionMappings: TASK_14_ACTION_CONTROL_REFS }),
  [TASK_19_CONTROL_CATALOG.version]: Object.freeze({ catalog: TASK_19_CONTROL_CATALOG, actionMappings: TASK_19_ACTION_CONTROL_REFS }),
  [CONTROL_CATALOG.version]: Object.freeze({ catalog: CONTROL_CATALOG, actionMappings: ACTION_CONTROL_REFS })
});

function catalogDefinitionOf(input) {
  if (!isPlainObject(input) || input.id !== CATALOG_ID) return null;
  const definition = CONTROL_CATALOGS[String(input.version || '')];
  if (!definition || input.frameworkRevision !== definition.catalog.frameworkRevision || input.hash !== definition.catalog.hash) return null;
  return definition;
}

function normalizeControlRef(value) {
  const ref = String(value == null ? '' : value).trim().toUpperCase();
  if (!/^[A-Z0-9-]{2,32}:[A-Z0-9.:-]{2,40}$/.test(ref) || !CONTROL_DEFINITIONS[ref]) {
    fail(`Unknown governance control reference: ${ref || '(empty)'}`, 'GOVERNANCE_CONTROL_UNKNOWN');
  }
  return ref;
}

function normalizeControlRefs(input) {
  if (input == null) return Object.freeze([]);
  if (!Array.isArray(input) || input.length > MAX_CONTROL_REFS) {
    fail('Governance control references must be a bounded array', 'GOVERNANCE_CONTROL_REFS_INVALID');
  }
  return Object.freeze([...new Set(input.map(normalizeControlRef))].sort());
}

function boundedId(value, label, pattern, max = 100) {
  const text = String(value == null ? '' : value).trim().toLowerCase();
  if (!text || text.length > max || !pattern.test(text)) fail(`${label} is invalid`);
  return text;
}

function mappingControl(ref, sources) {
  const definition = CONTROL_DEFINITIONS[ref];
  const normalizedSources = [...sources]
    .sort((a, b) => stableJson(a).localeCompare(stableJson(b)));
  const sourceKinds = [...new Set(normalizedSources.map(item => item.source))];
  return {
    framework: definition.framework,
    frameworkVersion: definition.frameworkVersion,
    controlId: definition.controlId,
    relationship: 'supports',
    source: sourceKinds.length > 1 ? 'action-and-policy' : sourceKinds[0],
    sources: normalizedSources
  };
}

function deriveControlMapping(input = {}) {
  const action = String(input.action || '').trim().toLowerCase();
  const catalogDefinition = CONTROL_CATALOGS[String(input.catalogVersion || CONTROL_CATALOG.version)];
  if (!catalogDefinition) fail('Control mapping catalog version is unsupported');
  const byRef = new Map();
  const add = (ref, source) => {
    if (!CONTROL_DEFINITIONS[ref]) return;
    if (!byRef.has(ref)) byRef.set(ref, []);
    const list = byRef.get(ref);
    const encoded = stableJson(source);
    if (!list.some(item => stableJson(item) === encoded)) list.push(source);
  };

  for (const ref of catalogDefinition.actionMappings[action] || []) add(ref, { source: 'action-catalog', action });
  const evaluations = Array.isArray(input.policyEvaluations) ? input.policyEvaluations : [];
  for (const evaluation of evaluations.slice(0, 100)) {
    if (!isPlainObject(evaluation)) continue;
    const policyId = boundedId(evaluation.policyId, 'Policy id', /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, 36);
    const versionId = boundedId(evaluation.versionId, 'Policy version id', /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, 36);
    const matchedRules = Array.isArray(evaluation.matchedRules) ? evaluation.matchedRules : [];
    for (const rule of matchedRules.slice(0, 200)) {
      if (!isPlainObject(rule)) continue;
      const ruleId = boundedId(rule.id, 'Policy rule id', /^[a-z][a-z0-9._-]{1,63}$/, 64);
      for (const ref of normalizeControlRefs(rule.controlRefs || [])) {
        add(ref, { source: 'policy-rule', policyId, versionId, ruleId });
      }
    }
  }

  const controls = [...byRef.keys()].sort().map(ref => mappingControl(ref, byRef.get(ref)));
  if (controls.length > MAX_MAPPING_CONTROLS) fail('Control mapping contains too many controls');
  let status = controls.length ? 'mapped' : 'unmapped';
  const unmappedReasons = [];
  if (!controls.length) {
    unmappedReasons.push(ACTIONS_WITHOUT_APPROVED_MAPPING.has(action)
      ? 'NO_APPROVED_CONTROL_FOR_ACTION'
      : 'ACTION_NOT_PRESENT_IN_CATALOG');
  }
  const mappingBody = {
    schemaVersion: 1,
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

function assertNoSensitiveKeys(value, path = '$', depth = 0) {
  if (depth > 8) fail('Control mapping is nested too deeply');
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    if (value.length > 250) fail('Control mapping array is too large');
    value.forEach((entry, index) => assertNoSensitiveKeys(entry, `${path}[${index}]`, depth + 1));
    return;
  }
  if (!isPlainObject(value)) fail('Control mapping must be JSON-compatible');
  const keys = Object.keys(value);
  if (keys.length > 100) fail('Control mapping object has too many fields');
  for (const key of keys) {
    if (!key || key.length > 100 || DANGEROUS_KEYS.has(key.toLowerCase()) || SENSITIVE_KEY_RX.test(key.replace(/[^a-z0-9]/gi, ''))) {
      fail(`Sensitive or invalid control mapping field at ${path}.${key}`);
    }
    assertNoSensitiveKeys(value[key], `${path}.${key}`, depth + 1);
  }
}

function normalizeSource(input, catalogDefinition) {
  if (!isPlainObject(input)) fail('Control mapping source is invalid');
  const source = String(input.source || '').trim();
  if (source === 'action-catalog') {
    const action = String(input.action || '').trim().toLowerCase();
    if (!catalogDefinition || !catalogDefinition.actionMappings[action]) fail('Control action source is invalid');
    return { source, action };
  }
  if (source === 'policy-rule') {
    return {
      source,
      policyId: boundedId(input.policyId, 'Policy id', /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, 36),
      versionId: boundedId(input.versionId, 'Policy version id', /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, 36),
      ruleId: boundedId(input.ruleId, 'Policy rule id', /^[a-z][a-z0-9._-]{1,63}$/, 64)
    };
  }
  fail('Control mapping source is unsupported');
}

function normalizeControlMapping(input) {
  if (!isPlainObject(input)) fail('Control mapping must be an object');
  assertNoSensitiveKeys(input);
  if (Number(input.schemaVersion) !== 1 || !['mapped', 'partial', 'unmapped', 'unavailable'].includes(String(input.status || ''))) {
    fail('Control mapping schema or status is invalid');
  }
  const catalog = input.catalog;
  const catalogDefinition = catalogDefinitionOf(catalog);
  if (!catalogDefinition) fail('Control mapping catalog identity is invalid');
  if (!Array.isArray(input.controls) || input.controls.length > MAX_MAPPING_CONTROLS) fail('Control mapping controls are invalid');
  const seen = new Set();
  const controls = input.controls.map(raw => {
    if (!isPlainObject(raw)) fail('Mapped control is invalid');
    let ref;
    try { ref = normalizeControlRef(`${raw.framework}:${raw.controlId}`); }
    catch { fail('Mapped control reference is invalid'); }
    const definition = CONTROL_DEFINITIONS[ref];
    if (raw.frameworkVersion !== definition.frameworkVersion || raw.relationship !== 'supports') fail('Mapped control definition is invalid');
    if (!Array.isArray(raw.sources) || raw.sources.length < 1 || raw.sources.length > 100) fail('Mapped control sources are invalid');
    const sources = raw.sources.map(source => normalizeSource(source, catalogDefinition)).sort((a, b) => stableJson(a).localeCompare(stableJson(b)));
    const expectedSource = [...new Set(sources.map(item => item.source))].length > 1 ? 'action-and-policy' : sources[0].source;
    if (raw.source !== expectedSource || seen.has(ref)) fail('Mapped control source or uniqueness is invalid');
    seen.add(ref);
    return mappingControl(ref, sources);
  }).sort((a, b) => `${a.framework}:${a.controlId}`.localeCompare(`${b.framework}:${b.controlId}`));
  const reasons = Array.isArray(input.unmappedReasons) ? [...new Set(input.unmappedReasons.map(value => String(value || '').trim()))].sort() : [];
  if (reasons.some(value => !/^[A-Z][A-Z0-9_]{2,79}$/.test(value))) fail('Control mapping reason is invalid');
  if (input.status === 'mapped' && !controls.length) fail('Mapped control status requires controls');
  if (input.status === 'unmapped' && controls.length) fail('Unmapped control status cannot contain controls');
  const body = {
    schemaVersion: 1,
    status: input.status,
    catalog: { id: catalog.id, version: catalog.version, frameworkRevision: catalog.frameworkRevision, hash: catalog.hash },
    controls,
    unmappedReasons: reasons
  };
  if (String(input.mappingHash || '').toLowerCase() !== sha256(body)) fail('Control mapping hash is invalid');
  return deepFreeze({ ...body, mappingHash: sha256(body) });
}

module.exports = Object.freeze({
  ControlMappingError,
  CONTROL_CATALOG,
  LEGACY_CONTROL_CATALOG,
  TASK_14_CONTROL_CATALOG,
  TASK_19_CONTROL_CATALOG,
  normalizeControlRefs,
  deriveControlMapping,
  normalizeControlMapping
});
