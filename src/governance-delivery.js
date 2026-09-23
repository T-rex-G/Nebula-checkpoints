'use strict';

const crypto = require('crypto');
const net = require('net');
const { normalizePolicyScope, stableJson } = require('./governance-model');

const SUPPORTED_EVENT_TYPES = Object.freeze([
  'policy.created', 'draft.created', 'draft.updated', 'version.created',
  'reviewer.assigned', 'approval.recorded', 'policy.activated', 'policy.rolled-back',
  'exception.requested', 'exception.approved', 'exception.rejected', 'exception.revoked',
  'policy.decision.allow', 'policy.decision.warn', 'policy.decision.block'
]);
const EVENT_TYPE_SET = new Set(SUPPORTED_EVENT_TYPES);
const DEFAULT_NOTIFICATION_EVENT_TYPES = Object.freeze(SUPPORTED_EVENT_TYPES.filter(type => type !== 'policy.decision.allow'));
const SUBJECT_FIELDS = new Set([
  'policyId', 'versionId', 'draftId', 'assignmentId', 'approvalId', 'activationId',
  'exceptionId', 'mutationId', 'action', 'decision', 'reviewStatus', 'enforcementOutcome',
  'effectiveEffect', 'rolloutMode', 'previousVersionId', 'rollbackSourceActivationId'
]);
const EVIDENCE_FIELDS = new Set([
  'lifecycleRecordHash', 'detailsHash', 'decisionHash', 'descriptorHash', 'documentHash',
  'simulationHash', 'scenarioSetHash', 'resultHash', 'controlMappingHash', 'policySetHash',
  'targetHash', 'sourceRecordHash'
]);
const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_RX = /^[0-9a-f]{64}$/i;
const EVENT_ID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SENSITIVE_RX = /(?:token|secret|password|private.?key|authorization|cookie|payload|patch|diff|content|body)/i;
const MAX_EXPORT_EVENTS = 1000;
const MAX_EXPORT_BYTES = 4 * 1024 * 1024;

class GovernanceDeliveryError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.name = 'GovernanceDeliveryError';
    this.code = code;
    this.status = status;
  }
}
function fail(message, code, status = 400) { throw new GovernanceDeliveryError(message, code, status); }
function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
function hashText(value) { return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex'); }
function normalizeInteger(value, label, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) fail(`${label} is invalid`, 'GOVERNANCE_DELIVERY_INPUT_INVALID');
  return number;
}
function normalizeIso(value, label) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) fail(`${label} is invalid`, 'GOVERNANCE_DELIVERY_INPUT_INVALID');
  return date.toISOString();
}
function normalizeText(value, label, max = 200) {
  const text = String(value == null ? '' : value).trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) fail(`${label} is invalid`, 'GOVERNANCE_DELIVERY_INPUT_INVALID');
  return text;
}
function normalizeOptionalText(value, label, max = 200) {
  const text = String(value == null ? '' : value).trim();
  if (text.length > max || /[\u0000-\u001f\u007f]/.test(text)) fail(`${label} is invalid`, 'GOVERNANCE_DELIVERY_INPUT_INVALID');
  return text || null;
}
function normalizeUuid(value, label) {
  const text = String(value || '').trim().toLowerCase();
  if (!UUID_RX.test(text)) fail(`${label} is invalid`, 'GOVERNANCE_DELIVERY_INPUT_INVALID');
  return text;
}
function normalizeHash(value, label, nullable = true) {
  if (value == null || value === '') {
    if (nullable) return null;
    fail(`${label} is required`, 'GOVERNANCE_DELIVERY_INPUT_INVALID');
  }
  const text = String(value).trim().toLowerCase();
  if (!HASH_RX.test(text)) fail(`${label} is invalid`, 'GOVERNANCE_DELIVERY_INPUT_INVALID');
  return text;
}
function normalizeEventTypes(value, options = {}) {
  const source = value == null ? (options.defaults || []) : value;
  if (!Array.isArray(source) || source.length > SUPPORTED_EVENT_TYPES.length) fail('Governance event types are invalid', 'GOVERNANCE_EVENT_TYPES_INVALID');
  const types = [...new Set(source.map(item => String(item || '').trim().toLowerCase()))].sort();
  if ((!types.length && options.allowEmpty !== true) || types.some(type => !EVENT_TYPE_SET.has(type))) {
    fail('Governance event type is unsupported', 'GOVERNANCE_EVENT_TYPE_UNSUPPORTED');
  }
  return types;
}
function normalizeNotificationPreferences(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Notification preferences are invalid', 'GOVERNANCE_NOTIFICATION_PREFERENCES_INVALID');
  const enabled = input.enabled == null ? true : input.enabled;
  if (typeof enabled !== 'boolean') fail('Notification enabled state is invalid', 'GOVERNANCE_NOTIFICATION_PREFERENCES_INVALID');
  return deepFreeze({
    schemaVersion: 1,
    enabled,
    eventTypes: normalizeEventTypes(input.eventTypes, { defaults: DEFAULT_NOTIFICATION_EVENT_TYPES, allowEmpty: true })
  });
}
function normalizeWebhookUrl(raw) {
  let parsed;
  try { parsed = new URL(String(raw || '').trim()); }
  catch { fail('Webhook destination must be a valid absolute URL', 'GOVERNANCE_WEBHOOK_URL_INVALID'); }
  if (parsed.protocol !== 'https:') fail('Webhook destination must use HTTPS', 'GOVERNANCE_WEBHOOK_URL_INVALID');
  if (parsed.username || parsed.password) fail('Webhook destination must not contain credentials', 'GOVERNANCE_WEBHOOK_URL_INVALID');
  if (parsed.hash || parsed.search) fail('Webhook destination must not contain a query string or fragment', 'GOVERNANCE_WEBHOOK_URL_INVALID');
  if (parsed.port && parsed.port !== '443') fail('Webhook destination must use HTTPS port 443', 'GOVERNANCE_WEBHOOK_URL_INVALID');
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    fail('Webhook destination hostname is not allowed', 'GOVERNANCE_WEBHOOK_SSRF_BLOCKED');
  }
  parsed.hostname = hostname;
  parsed.port = '';
  return parsed;
}
function normalizeWebhookDefinition(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Webhook definition is invalid', 'GOVERNANCE_WEBHOOK_INVALID');
  const name = normalizeText(input.name, 'Webhook name', 120);
  const url = normalizeWebhookUrl(input.url).toString();
  const enabled = input.enabled == null ? true : input.enabled;
  if (typeof enabled !== 'boolean') fail('Webhook enabled state is invalid', 'GOVERNANCE_WEBHOOK_INVALID');
  return deepFreeze({ schemaVersion: 1, name, url, eventTypes: normalizeEventTypes(input.eventTypes), enabled });
}
function ipv4Number(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0;
}
function inV4(value, base, prefix) {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (ipv4Number(base) & mask);
}
function expandIpv6(address) {
  let text = String(address || '').toLowerCase();
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);
  if (text.includes('.')) {
    const last = text.lastIndexOf(':');
    const v4 = ipv4Number(text.slice(last + 1));
    if (v4 == null) return null;
    text = `${text.slice(0, last)}:${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const pieces = [...left, ...Array(missing).fill('0'), ...right];
  if (pieces.length !== 8 || pieces.some(piece => !/^[0-9a-f]{1,4}$/.test(piece))) return null;
  return pieces.map(piece => parseInt(piece, 16));
}
function isPublicAddress(addressInput) {
  const address = String(addressInput || '').trim();
  const family = net.isIP(address);
  if (family === 4) {
    const value = ipv4Number(address);
    if (value == null) return false;
    const blocked = [
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
      ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
      ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
      ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
    ];
    return !blocked.some(([base, prefix]) => inV4(value, base, prefix));
  }
  if (family === 6) {
    const parts = expandIpv6(address);
    if (!parts) return false;
    const allZero = parts.every(part => part === 0);
    if (allZero || (parts.slice(0, 7).every(part => part === 0) && parts[7] === 1)) return false;
    if ((parts[0] & 0xfe00) === 0xfc00) return false;
    if ((parts[0] & 0xffc0) === 0xfe80) return false;
    if ((parts[0] & 0xff00) === 0xff00) return false;
    if (parts[0] === 0x2001 && parts[1] === 0x0db8) return false;
    if (parts.slice(0, 5).every(part => part === 0) && parts[5] === 0xffff) {
      const v4 = `${parts[6] >> 8}.${parts[6] & 255}.${parts[7] >> 8}.${parts[7] & 255}`;
      return isPublicAddress(v4);
    }
    return true;
  }
  return false;
}
function normalizeWebhookDestination(rawUrl, addressesInput) {
  const parsed = normalizeWebhookUrl(rawUrl);
  const addresses = Array.isArray(addressesInput) ? addressesInput : [];
  if (!addresses.length || addresses.length > 8) fail('Webhook destination DNS result is unavailable', 'GOVERNANCE_WEBHOOK_DNS_INVALID', 422);
  const normalized = addresses.map(item => {
    const address = String(item && item.address || '').trim();
    const family = Number(item && item.family) || net.isIP(address);
    if (![4, 6].includes(family) || net.isIP(address) !== family || !isPublicAddress(address)) {
      fail('Webhook destination must resolve only to public addresses', 'GOVERNANCE_WEBHOOK_SSRF_BLOCKED', 422);
    }
    return { address, family };
  });
  return deepFreeze({ url: parsed.toString(), hostname: parsed.hostname, path: `${parsed.pathname || '/'}${parsed.search || ''}`, addresses: normalized });
}
function deriveWebhookSigningSecret(masterSecret, scopeKey, webhookId, salt, version = 1) {
  if (Buffer.byteLength(String(masterSecret || ''), 'utf8') < 32) fail('Webhook master secret is invalid', 'GOVERNANCE_WEBHOOK_SECRET_INVALID', 500);
  const id = normalizeUuid(webhookId, 'Webhook id');
  const saltText = String(salt || '').trim().toLowerCase();
  if (!HASH_RX.test(saltText)) fail('Webhook secret salt is invalid', 'GOVERNANCE_WEBHOOK_SECRET_INVALID', 500);
  const v = normalizeInteger(version, 'Webhook secret version', 1, 1_000_000);
  const material = crypto.createHmac('sha256', String(masterSecret)).update(`webhook:v${v}:${scopeKey}:${id}:${saltText}`).digest('base64url');
  return `nvwhsec_${material}`;
}
function signatureInput(deliveryId, timestamp, body) {
  return `${normalizeUuid(deliveryId, 'Webhook delivery id')}.${normalizeIso(timestamp, 'Webhook timestamp')}.${String(body)}`;
}
function signWebhookPayload(secret, deliveryId, timestamp, body) {
  if (Buffer.byteLength(String(secret || ''), 'utf8') < 32) fail('Webhook signing secret is invalid', 'GOVERNANCE_WEBHOOK_SECRET_INVALID', 500);
  return `v1=${crypto.createHmac('sha256', String(secret)).update(signatureInput(deliveryId, timestamp, body)).digest('hex')}`;
}
function verifyWebhookSignature(secret, deliveryId, timestamp, body, signature) {
  let expected;
  try { expected = signWebhookPayload(secret, deliveryId, timestamp, body); }
  catch { return false; }
  const actual = String(signature || '');
  const a = Buffer.from(actual, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function normalizeStructuredFields(input, allowed, kind) {
  if (input == null) return {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(`Governance event ${kind} is invalid`, 'GOVERNANCE_EVENT_INVALID');
  const output = {};
  for (const key of Object.keys(input).sort()) {
    if (!allowed.has(key) || SENSITIVE_RX.test(key)) fail(`Governance event ${kind} contains an unsupported or sensitive field`, 'GOVERNANCE_EVENT_INVALID');
    const value = input[key];
    if (value == null || value === '') continue;
    if (/Id$/.test(key)) output[key] = normalizeUuid(value, key);
    else if (/Hash$/.test(key)) output[key] = normalizeHash(value, key, false);
    else output[key] = normalizeText(value, key, 120);
  }
  return output;
}
function buildGovernanceEvent(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Governance event is invalid', 'GOVERNANCE_EVENT_INVALID');
  const eventSeq = normalizeInteger(input.eventSeq, 'Governance event sequence', 1);
  const sourceKind = String(input.sourceKind || '').trim().toLowerCase();
  if (!['lifecycle', 'runtime-decision'].includes(sourceKind)) fail('Governance event source is invalid', 'GOVERNANCE_EVENT_INVALID');
  const sourceSeq = normalizeInteger(input.sourceSeq, 'Governance source sequence', 1);
  const sourceId = normalizeUuid(input.sourceId, 'Governance source id');
  const eventType = String(input.eventType || '').trim().toLowerCase();
  if (!EVENT_TYPE_SET.has(eventType)) fail('Governance event type is unsupported', 'GOVERNANCE_EVENT_TYPE_UNSUPPORTED');
  const scope = normalizePolicyScope(input.scope);
  if (input.scope.scopeKey && input.scope.scopeKey !== scope.scopeKey) fail('Governance event scope does not match its canonical key', 'GOVERNANCE_EVENT_SCOPE_INVALID');
  const event = {
    schemaVersion: 1,
    eventId: `nvgevt_1_${sourceKind}_${sourceId}`,
    eventSeq,
    type: eventType,
    occurredAt: normalizeIso(input.occurredAt, 'Governance event timestamp'),
    scope,
    actor: { login: normalizeText(input.actorLogin, 'Governance event actor login', 200) },
    subject: normalizeStructuredFields({ policyId: input.policyId, versionId: input.versionId, ...(input.subject || {}) }, SUBJECT_FIELDS, 'subject'),
    evidence: {
      sourceKind,
      sourceSeq,
      sourceId,
      ...normalizeStructuredFields(input.evidence || {}, EVIDENCE_FIELDS, 'evidence')
    }
  };
  const eventHash = hashText(stableJson(event));
  return deepFreeze({ ...event, eventHash });
}
function normalizeGovernanceEvent(value) {
  if (value && value.schemaVersion === 1 && value.eventHash && value.evidence && value.actor && value.scope) {
    const { sourceKind, sourceSeq, sourceId, ...evidence } = value.evidence;
    const rebuilt = buildGovernanceEvent({
      eventSeq: value.eventSeq,
      sourceKind,
      sourceSeq,
      sourceId,
      eventType: value.type,
      occurredAt: value.occurredAt,
      scope: value.scope,
      actorLogin: value.actor.login,
      subject: value.subject,
      evidence
    });
    if (rebuilt.eventId !== value.eventId || rebuilt.eventHash !== value.eventHash) {
      fail('Governance event integrity check failed', 'GOVERNANCE_EVENT_HASH_MISMATCH');
    }
    return rebuilt;
  }
  return buildGovernanceEvent(value);
}
function csvFormulaSafe(value) {
  let text = String(value == null ? '' : value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}
/*
 * Each column is a name and a reader. The pair is annotated as a tuple
 * rather than left to inference: without it a checker widens the inner
 * array to `string | reader` and the reader stops being callable.
 */
/** @type {ReadonlyArray<readonly [string, (event: any) => unknown]>} */
const CSV_COLUMNS = Object.freeze([
  ['event_seq', e => e.eventSeq], ['event_id', e => e.eventId], ['event_type', e => e.type],
  ['occurred_at', e => e.occurredAt], ['provider', e => e.scope.provider], ['authority', e => e.scope.authority],
  ['owner', e => e.scope.owner], ['repo', e => e.scope.repo], ['actor_login', e => e.actor.login],
  ['policy_id', e => e.subject.policyId], ['version_id', e => e.subject.versionId], ['activation_id', e => e.subject.activationId],
  ['exception_id', e => e.subject.exceptionId], ['mutation_id', e => e.subject.mutationId], ['action', e => e.subject.action],
  ['decision', e => e.subject.decision], ['enforcement_outcome', e => e.subject.enforcementOutcome],
  ['source_kind', e => e.evidence.sourceKind], ['source_seq', e => e.evidence.sourceSeq], ['source_id', e => e.evidence.sourceId],
  ['lifecycle_record_hash', e => e.evidence.lifecycleRecordHash], ['details_hash', e => e.evidence.detailsHash],
  ['decision_hash', e => e.evidence.decisionHash], ['descriptor_hash', e => e.evidence.descriptorHash],
  ['document_hash', e => e.evidence.documentHash], ['simulation_hash', e => e.evidence.simulationHash],
  ['scenario_set_hash', e => e.evidence.scenarioSetHash], ['result_hash', e => e.evidence.resultHash],
  ['control_mapping_hash', e => e.evidence.controlMappingHash], ['event_hash', e => e.eventHash]
]);
function buildExportContent(events, format) {
  if (format === 'json') return stableJson({ schemaVersion: 1, events });
  const lines = [CSV_COLUMNS.map(([name]) => name).join(',')];
  for (const event of events) lines.push(CSV_COLUMNS.map(([, read]) => csvFormulaSafe(read(event))).join(','));
  return `${lines.join('\r\n')}\r\n`;
}
function buildSignedEvidenceExport(input = {}) {
  const exportId = normalizeUuid(input.exportId, 'Export id');
  const generatedAt = normalizeIso(input.generatedAt, 'Export timestamp');
  const scope = normalizePolicyScope(input.scope);
  const actorLogin = normalizeText(input.actorLogin, 'Export actor login', 200);
  const format = String(input.format || '').trim().toLowerCase();
  if (!['json', 'csv'].includes(format)) fail('Evidence export format must be json or csv', 'GOVERNANCE_EXPORT_FORMAT_INVALID');
  if (!Array.isArray(input.events) || input.events.length > MAX_EXPORT_EVENTS) fail('Evidence export contains too many events', 'GOVERNANCE_EXPORT_LIMIT', 413);
  const events = input.events.map(normalizeGovernanceEvent);
  for (let index = 1; index < events.length; index += 1) {
    if (events[index].eventSeq <= events[index - 1].eventSeq) fail('Evidence export events must be strictly ordered', 'GOVERNANCE_EXPORT_ORDER_INVALID');
  }
  const content = buildExportContent(events, format);
  const contentBytes = Buffer.byteLength(content, 'utf8');
  if (contentBytes > MAX_EXPORT_BYTES) fail('Evidence export exceeds 4 MiB', 'GOVERNANCE_EXPORT_TOO_LARGE', 413);
  const manifest = {
    schemaVersion: 1,
    format: 'nebulaverse-governance-evidence-export',
    exportId,
    generatedAt,
    scope,
    actor: { login: actorLogin },
    contentType: format === 'json' ? 'application/vnd.nebulaverse.governance+json' : 'text/csv; charset=utf-8',
    encoding: 'utf-8',
    recordCount: events.length,
    firstEventSeq: events.length ? events[0].eventSeq : null,
    lastEventSeq: events.length ? events[events.length - 1].eventSeq : null,
    recordsHash: hashText(stableJson(events.map(event => event.eventHash))),
    contentHash: hashText(content),
    contentBytes
  };
  const manifestHash = hashText(stableJson(manifest));
  const keyId = hashText(`export-key:${String(input.secret || '')}`).slice(0, 24);
  const value = crypto.createHmac('sha256', String(input.secret || '')).update(stableJson(manifest)).digest('hex');
  if (Buffer.byteLength(String(input.secret || ''), 'utf8') < 32) fail('Evidence export signing secret is invalid', 'GOVERNANCE_EXPORT_SECRET_INVALID', 500);
  return deepFreeze({
    schemaVersion: 1,
    format: 'nebulaverse-governance-evidence-envelope',
    manifest: { ...manifest, manifestHash },
    content,
    signature: { schemaVersion: 1, algorithm: 'hmac-sha256', keyId, signedObject: 'manifest', value }
  });
}
function verifySignedEvidenceExport(envelope, secret) {
  try {
    if (!envelope || envelope.schemaVersion !== 1 || envelope.format !== 'nebulaverse-governance-evidence-envelope') return { valid: false, reasonCode: 'EXPORT_ENVELOPE_INVALID' };
    const manifest = envelope.manifest;
    const signature = envelope.signature;
    if (!manifest || !signature || signature.algorithm !== 'hmac-sha256') return { valid: false, reasonCode: 'EXPORT_SIGNATURE_INVALID' };
    const { manifestHash, ...unsignedManifest } = manifest;
    if (hashText(stableJson(unsignedManifest)) !== manifestHash) return { valid: false, reasonCode: 'EXPORT_MANIFEST_HASH_MISMATCH' };
    if (hashText(String(envelope.content)) !== manifest.contentHash || Buffer.byteLength(String(envelope.content), 'utf8') !== Number(manifest.contentBytes)) {
      return { valid: false, reasonCode: 'EXPORT_CONTENT_HASH_MISMATCH' };
    }
    const expected = crypto.createHmac('sha256', String(secret || '')).update(stableJson(unsignedManifest)).digest('hex');
    const a = Buffer.from(String(signature.value || ''), 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { valid: false, reasonCode: 'EXPORT_SIGNATURE_MISMATCH' };
    return { valid: true, reasonCode: null, manifestHash };
  } catch { return { valid: false, reasonCode: 'EXPORT_VERIFICATION_FAILED' }; }
}

module.exports = Object.freeze({
  GovernanceDeliveryError,
  SUPPORTED_EVENT_TYPES,
  DEFAULT_NOTIFICATION_EVENT_TYPES,
  MAX_EXPORT_EVENTS,
  MAX_EXPORT_BYTES,
  normalizeEventTypes,
  normalizeNotificationPreferences,
  normalizeWebhookDefinition,
  normalizeWebhookDestination,
  isPublicAddress,
  deriveWebhookSigningSecret,
  signWebhookPayload,
  verifyWebhookSignature,
  buildGovernanceEvent,
  normalizeGovernanceEvent,
  buildSignedEvidenceExport,
  verifySignedEvidenceExport,
  csvFormulaSafe
});
