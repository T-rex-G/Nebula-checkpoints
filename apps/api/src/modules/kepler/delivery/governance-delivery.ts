import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { normalizePolicyScope } from '../domain/governance-model.ts';
import { stableJson } from '../../../../../../packages/contracts/src/canonical-json.ts';
import { isRecordId, isSha256Hex } from '../../../../../../packages/contracts/src/ids.ts';
import type { RepositoryScope } from '../../../../../../packages/contracts/src/scope.ts';
import { isPublicAddress } from '../../../platform/network/public-address.ts';

type Fields = Readonly<Record<string, unknown>>;

export const SUPPORTED_EVENT_TYPES: readonly string[] = Object.freeze([
  'policy.created', 'draft.created', 'draft.updated', 'version.created',
  'reviewer.assigned', 'approval.recorded', 'policy.activated', 'policy.rolled-back',
  'exception.requested', 'exception.approved', 'exception.rejected', 'exception.revoked',
  'policy.decision.allow', 'policy.decision.warn', 'policy.decision.block',
  'policy.deactivated', 'policy.archived', 'policy.restored', 'draft.discarded', 'version.withdrawn'
]);
const EVENT_TYPE_SET: ReadonlySet<string> = new Set(SUPPORTED_EVENT_TYPES);
export const DEFAULT_NOTIFICATION_EVENT_TYPES: readonly string[] = Object.freeze(SUPPORTED_EVENT_TYPES.filter(type => type !== 'policy.decision.allow'));
const SUBJECT_FIELDS: ReadonlySet<string> = new Set([
  'policyId', 'versionId', 'draftId', 'assignmentId', 'approvalId', 'activationId',
  'exceptionId', 'mutationId', 'action', 'decision', 'reviewStatus', 'enforcementOutcome',
  'effectiveEffect', 'rolloutMode', 'previousVersionId', 'rollbackSourceActivationId'
]);
const EVIDENCE_FIELDS: ReadonlySet<string> = new Set([
  'lifecycleRecordHash', 'detailsHash', 'decisionHash', 'descriptorHash', 'documentHash',
  'simulationHash', 'scenarioSetHash', 'resultHash', 'controlMappingHash', 'policySetHash',
  'targetHash', 'sourceRecordHash'
]);
const SENSITIVE_RX = /(?:token|secret|password|private.?key|authorization|cookie|payload|patch|diff|content|body)/i;
export const MAX_EXPORT_EVENTS = 1000;
export const MAX_EXPORT_BYTES = 4 * 1024 * 1024;

export class GovernanceDeliveryError extends Error {
  override readonly name = 'GovernanceDeliveryError';
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
function fail(message: string, code: string, status = 400): never { throw new GovernanceDeliveryError(message, code, status); }
function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
function hashText(value: unknown): string { return createHash('sha256').update(String(value), 'utf8').digest('hex'); }
function normalizeInteger(value: unknown, label: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) fail(`${label} is invalid`, 'GOVERNANCE_DELIVERY_INPUT_INVALID');
  return number;
}
function normalizeIso(value: unknown, label: string): string {
  const date = new Date(value as string | number | Date);
  if (!Number.isFinite(date.getTime())) fail(`${label} is invalid`, 'GOVERNANCE_DELIVERY_INPUT_INVALID');
  return date.toISOString();
}
function normalizeText(value: unknown, label: string, max = 200): string {
  const text = String(value == null ? '' : value).trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) fail(`${label} is invalid`, 'GOVERNANCE_DELIVERY_INPUT_INVALID');
  return text;
}
function normalizeUuid(value: unknown, label: string): string {
  const text = String(value || '').trim().toLowerCase();
  if (!isRecordId(text)) fail(`${label} is invalid`, 'GOVERNANCE_DELIVERY_INPUT_INVALID');
  return text;
}
function requireHash(value: unknown, label: string): string {
  if (value == null || value === '') fail(`${label} is required`, 'GOVERNANCE_DELIVERY_INPUT_INVALID');
  const text = String(value).trim().toLowerCase();
  if (!isSha256Hex(text)) fail(`${label} is invalid`, 'GOVERNANCE_DELIVERY_INPUT_INVALID');
  return text;
}

export interface EventTypeOptions {
  readonly defaults?: readonly string[];
  readonly allowEmpty?: boolean;
}

export function normalizeEventTypes(value: unknown, options: EventTypeOptions = {}): string[] {
  const source = value == null ? (options.defaults || []) : value;
  if (!Array.isArray(source) || source.length > SUPPORTED_EVENT_TYPES.length) fail('Governance event types are invalid', 'GOVERNANCE_EVENT_TYPES_INVALID');
  const types = [...new Set((source as readonly unknown[]).map(item => String(item || '').trim().toLowerCase()))].sort();
  if ((!types.length && options.allowEmpty !== true) || types.some(type => !EVENT_TYPE_SET.has(type))) {
    fail('Governance event type is unsupported', 'GOVERNANCE_EVENT_TYPE_UNSUPPORTED');
  }
  return types;
}

export interface NotificationPreferences {
  readonly schemaVersion: 1;
  readonly enabled: boolean;
  readonly eventTypes: readonly string[];
}

export function normalizeNotificationPreferences(input: unknown = {}): NotificationPreferences {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Notification preferences are invalid', 'GOVERNANCE_NOTIFICATION_PREFERENCES_INVALID');
  const fields = input as Fields;
  const enabled = fields.enabled == null ? true : fields.enabled;
  if (typeof enabled !== 'boolean') fail('Notification enabled state is invalid', 'GOVERNANCE_NOTIFICATION_PREFERENCES_INVALID');
  return deepFreeze({
    schemaVersion: 1,
    enabled,
    eventTypes: normalizeEventTypes(fields.eventTypes, { defaults: DEFAULT_NOTIFICATION_EVENT_TYPES, allowEmpty: true })
  });
}
function normalizeWebhookUrl(raw: unknown): URL {
  let parsed: URL;
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

export interface WebhookDefinition {
  readonly schemaVersion: 1;
  readonly name: string;
  readonly url: string;
  readonly eventTypes: readonly string[];
  readonly enabled: boolean;
}

export function normalizeWebhookDefinition(input: unknown = {}): WebhookDefinition {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Webhook definition is invalid', 'GOVERNANCE_WEBHOOK_INVALID');
  const fields = input as Fields;
  const name = normalizeText(fields.name, 'Webhook name', 120);
  const url = normalizeWebhookUrl(fields.url).toString();
  const enabled = fields.enabled == null ? true : fields.enabled;
  if (typeof enabled !== 'boolean') fail('Webhook enabled state is invalid', 'GOVERNANCE_WEBHOOK_INVALID');
  return deepFreeze({ schemaVersion: 1, name, url, eventTypes: normalizeEventTypes(fields.eventTypes), enabled });
}

export interface ResolvedAddress {
  readonly address: string;
  readonly family: number;
}

export interface WebhookDestination {
  readonly url: string;
  readonly hostname: string;
  readonly path: string;
  readonly addresses: readonly ResolvedAddress[];
}

export function normalizeWebhookDestination(rawUrl: unknown, addressesInput: unknown): WebhookDestination {
  const parsed = normalizeWebhookUrl(rawUrl);
  const addresses: readonly unknown[] = Array.isArray(addressesInput) ? addressesInput : [];
  if (!addresses.length || addresses.length > 8) fail('Webhook destination DNS result is unavailable', 'GOVERNANCE_WEBHOOK_DNS_INVALID', 422);
  const normalized = addresses.map(item => {
    const entry = item as Fields | null | undefined;
    const address = String(entry && entry.address || '').trim();
    const family = Number(entry && entry.family) || isIP(address);
    if (![4, 6].includes(family) || isIP(address) !== family || !isPublicAddress(address)) {
      fail('Webhook destination must resolve only to public addresses', 'GOVERNANCE_WEBHOOK_SSRF_BLOCKED', 422);
    }
    return { address, family };
  });
  return deepFreeze({ url: parsed.toString(), hostname: parsed.hostname, path: `${parsed.pathname || '/'}${parsed.search || ''}`, addresses: normalized });
}
export function deriveWebhookSigningSecret(masterSecret: unknown, scopeKey: unknown, webhookId: unknown, salt: unknown, version: unknown = 1): string {
  if (Buffer.byteLength(String(masterSecret || ''), 'utf8') < 32) fail('Webhook master secret is invalid', 'GOVERNANCE_WEBHOOK_SECRET_INVALID', 500);
  const id = normalizeUuid(webhookId, 'Webhook id');
  const saltText = String(salt || '').trim().toLowerCase();
  if (!isSha256Hex(saltText)) fail('Webhook secret salt is invalid', 'GOVERNANCE_WEBHOOK_SECRET_INVALID', 500);
  const v = normalizeInteger(version, 'Webhook secret version', 1, 1_000_000);
  const material = createHmac('sha256', String(masterSecret)).update(`webhook:v${v}:${String(scopeKey)}:${id}:${saltText}`).digest('base64url');
  return `nvwhsec_${material}`;
}
function signatureInput(deliveryId: unknown, timestamp: unknown, body: unknown): string {
  return `${normalizeUuid(deliveryId, 'Webhook delivery id')}.${normalizeIso(timestamp, 'Webhook timestamp')}.${String(body)}`;
}
export function signWebhookPayload(secret: unknown, deliveryId: unknown, timestamp: unknown, body: unknown): string {
  if (Buffer.byteLength(String(secret || ''), 'utf8') < 32) fail('Webhook signing secret is invalid', 'GOVERNANCE_WEBHOOK_SECRET_INVALID', 500);
  return `v1=${createHmac('sha256', String(secret)).update(signatureInput(deliveryId, timestamp, body)).digest('hex')}`;
}
export function verifyWebhookSignature(secret: unknown, deliveryId: unknown, timestamp: unknown, body: unknown, signature: unknown): boolean {
  let expected: string;
  try { expected = signWebhookPayload(secret, deliveryId, timestamp, body); }
  catch { return false; }
  const actual = String(signature || '');
  const a = Buffer.from(actual, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
function normalizeStructuredFields(input: unknown, allowed: ReadonlySet<string>, kind: string): Record<string, string> {
  if (input == null) return {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(`Governance event ${kind} is invalid`, 'GOVERNANCE_EVENT_INVALID');
  const fields = input as Fields;
  const output: Record<string, string> = {};
  for (const key of Object.keys(fields).sort()) {
    if (!allowed.has(key) || SENSITIVE_RX.test(key)) fail(`Governance event ${kind} contains an unsupported or sensitive field`, 'GOVERNANCE_EVENT_INVALID');
    const value = fields[key];
    if (value == null || value === '') continue;
    if (/Id$/.test(key)) output[key] = normalizeUuid(value, key);
    else if (/Hash$/.test(key)) output[key] = requireHash(value, key);
    else output[key] = normalizeText(value, key, 120);
  }
  return output;
}

/* The named fields a subject carries; each is present only when it had a value. */
export type GovernanceEventSubject = Readonly<Record<string, string | undefined>>;

/* Where the event came from, and the named hashes it binds; each hash is present only when it had a value. */
export interface GovernanceEventEvidence {
  readonly sourceKind: string;
  readonly sourceSeq: number;
  readonly sourceId: string;
  readonly [field: string]: string | number | undefined;
}

export interface GovernanceEvent {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly eventSeq: number;
  readonly type: string;
  readonly occurredAt: string;
  readonly scope: RepositoryScope;
  readonly actor: { readonly login: string };
  readonly subject: GovernanceEventSubject;
  readonly evidence: GovernanceEventEvidence;
  readonly eventHash: string;
}

export function buildGovernanceEvent(input: unknown = {}): GovernanceEvent {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Governance event is invalid', 'GOVERNANCE_EVENT_INVALID');
  const fields = input as Fields;
  const eventSeq = normalizeInteger(fields.eventSeq, 'Governance event sequence', 1);
  const sourceKind = String(fields.sourceKind || '').trim().toLowerCase();
  if (!['lifecycle', 'runtime-decision'].includes(sourceKind)) fail('Governance event source is invalid', 'GOVERNANCE_EVENT_INVALID');
  const sourceSeq = normalizeInteger(fields.sourceSeq, 'Governance source sequence', 1);
  const sourceId = normalizeUuid(fields.sourceId, 'Governance source id');
  const eventType = String(fields.eventType || '').trim().toLowerCase();
  if (!EVENT_TYPE_SET.has(eventType)) fail('Governance event type is unsupported', 'GOVERNANCE_EVENT_TYPE_UNSUPPORTED');
  const scope = normalizePolicyScope(fields.scope);
  const claimedKey = (fields.scope as Fields).scopeKey;
  if (claimedKey && claimedKey !== scope.scopeKey) fail('Governance event scope does not match its canonical key', 'GOVERNANCE_EVENT_SCOPE_INVALID');
  const event = {
    schemaVersion: 1 as const,
    eventId: `nvgevt_1_${sourceKind}_${sourceId}`,
    eventSeq,
    type: eventType,
    occurredAt: normalizeIso(fields.occurredAt, 'Governance event timestamp'),
    scope,
    actor: { login: normalizeText(fields.actorLogin, 'Governance event actor login', 200) },
    subject: normalizeStructuredFields({ policyId: fields.policyId, versionId: fields.versionId, ...((fields.subject || {}) as Fields) }, SUBJECT_FIELDS, 'subject'),
    evidence: {
      sourceKind,
      sourceSeq,
      sourceId,
      ...normalizeStructuredFields(fields.evidence || {}, EVIDENCE_FIELDS, 'evidence')
    }
  };
  const eventHash = hashText(stableJson(event));
  return deepFreeze({ ...event, eventHash });
}
export function normalizeGovernanceEvent(value: unknown): GovernanceEvent {
  const claimed = value as Fields | null | undefined;
  if (claimed && claimed.schemaVersion === 1 && claimed.eventHash && claimed.evidence && claimed.actor && claimed.scope) {
    const { sourceKind, sourceSeq, sourceId, ...evidence } = claimed.evidence as Fields;
    const rebuilt = buildGovernanceEvent({
      eventSeq: claimed.eventSeq,
      sourceKind,
      sourceSeq,
      sourceId,
      eventType: claimed.type,
      occurredAt: claimed.occurredAt,
      scope: claimed.scope,
      actorLogin: (claimed.actor as Fields).login,
      subject: claimed.subject,
      evidence
    });
    if (rebuilt.eventId !== claimed.eventId || rebuilt.eventHash !== claimed.eventHash) {
      fail('Governance event integrity check failed', 'GOVERNANCE_EVENT_HASH_MISMATCH');
    }
    return rebuilt;
  }
  return buildGovernanceEvent(value);
}
export function csvFormulaSafe(value: unknown): string {
  let text = String(value == null ? '' : value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}
/* Each column is a name and a reader of the event. */
const CSV_COLUMNS: readonly (readonly [string, (event: GovernanceEvent) => unknown])[] = Object.freeze([
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
function buildExportContent(events: readonly GovernanceEvent[], format: string): string {
  if (format === 'json') return stableJson({ schemaVersion: 1, events });
  const lines = [CSV_COLUMNS.map(([name]) => name).join(',')];
  for (const event of events) lines.push(CSV_COLUMNS.map(([, read]) => csvFormulaSafe(read(event))).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

export interface EvidenceManifest {
  readonly schemaVersion: 1;
  readonly format: 'nebulaverse-governance-evidence-export';
  readonly exportId: string;
  readonly generatedAt: string;
  readonly scope: RepositoryScope;
  readonly actor: { readonly login: string };
  readonly contentType: string;
  readonly encoding: 'utf-8';
  readonly recordCount: number;
  readonly firstEventSeq: number | null;
  readonly lastEventSeq: number | null;
  readonly recordsHash: string;
  readonly contentHash: string;
  readonly contentBytes: number;
  readonly manifestHash: string;
}

export interface SignedEvidenceExport {
  readonly schemaVersion: 1;
  readonly format: 'nebulaverse-governance-evidence-envelope';
  readonly manifest: EvidenceManifest;
  readonly content: string;
  readonly signature: { readonly schemaVersion: 1; readonly algorithm: 'hmac-sha256'; readonly keyId: string; readonly signedObject: 'manifest'; readonly value: string };
}

export function buildSignedEvidenceExport(input: unknown = {}): SignedEvidenceExport {
  const fields = input as Fields;
  const exportId = normalizeUuid(fields.exportId, 'Export id');
  const generatedAt = normalizeIso(fields.generatedAt, 'Export timestamp');
  const scope = normalizePolicyScope(fields.scope);
  const actorLogin = normalizeText(fields.actorLogin, 'Export actor login', 200);
  const format = String(fields.format || '').trim().toLowerCase();
  if (!['json', 'csv'].includes(format)) fail('Evidence export format must be json or csv', 'GOVERNANCE_EXPORT_FORMAT_INVALID');
  if (!Array.isArray(fields.events) || fields.events.length > MAX_EXPORT_EVENTS) fail('Evidence export contains too many events', 'GOVERNANCE_EXPORT_LIMIT', 413);
  const events = (fields.events as readonly unknown[]).map(normalizeGovernanceEvent);
  for (let index = 1; index < events.length; index += 1) {
    if (events[index]!.eventSeq <= events[index - 1]!.eventSeq) fail('Evidence export events must be strictly ordered', 'GOVERNANCE_EXPORT_ORDER_INVALID');
  }
  const content = buildExportContent(events, format);
  const contentBytes = Buffer.byteLength(content, 'utf8');
  if (contentBytes > MAX_EXPORT_BYTES) fail('Evidence export exceeds 4 MiB', 'GOVERNANCE_EXPORT_TOO_LARGE', 413);
  const first = events[0];
  const last = events[events.length - 1];
  const manifest = {
    schemaVersion: 1 as const,
    format: 'nebulaverse-governance-evidence-export' as const,
    exportId,
    generatedAt,
    scope,
    actor: { login: actorLogin },
    contentType: format === 'json' ? 'application/vnd.nebulaverse.governance+json' : 'text/csv; charset=utf-8',
    encoding: 'utf-8' as const,
    recordCount: events.length,
    firstEventSeq: first ? first.eventSeq : null,
    lastEventSeq: last ? last.eventSeq : null,
    recordsHash: hashText(stableJson(events.map(event => event.eventHash))),
    contentHash: hashText(content),
    contentBytes
  };
  const manifestHash = hashText(stableJson(manifest));
  const keyId = hashText(`export-key:${String(fields.secret || '')}`).slice(0, 24);
  const value = createHmac('sha256', String(fields.secret || '')).update(stableJson(manifest)).digest('hex');
  if (Buffer.byteLength(String(fields.secret || ''), 'utf8') < 32) fail('Evidence export signing secret is invalid', 'GOVERNANCE_EXPORT_SECRET_INVALID', 500);
  return deepFreeze({
    schemaVersion: 1,
    format: 'nebulaverse-governance-evidence-envelope',
    manifest: { ...manifest, manifestHash },
    content,
    signature: { schemaVersion: 1, algorithm: 'hmac-sha256', keyId, signedObject: 'manifest', value }
  });
}

export type ExportVerdict =
  | { readonly valid: true; readonly reasonCode: null; readonly manifestHash: unknown }
  | { readonly valid: false; readonly reasonCode: string };

export function verifySignedEvidenceExport(envelope: unknown, secret: unknown): ExportVerdict {
  try {
    const claimed = envelope as Fields | null | undefined;
    if (!claimed || claimed.schemaVersion !== 1 || claimed.format !== 'nebulaverse-governance-evidence-envelope') return { valid: false, reasonCode: 'EXPORT_ENVELOPE_INVALID' };
    const manifest = claimed.manifest as Fields | null | undefined;
    const signature = claimed.signature as Fields | null | undefined;
    if (!manifest || !signature || signature.algorithm !== 'hmac-sha256') return { valid: false, reasonCode: 'EXPORT_SIGNATURE_INVALID' };
    const { manifestHash, ...unsignedManifest } = manifest;
    if (hashText(stableJson(unsignedManifest)) !== manifestHash) return { valid: false, reasonCode: 'EXPORT_MANIFEST_HASH_MISMATCH' };
    if (hashText(String(claimed.content)) !== manifest.contentHash || Buffer.byteLength(String(claimed.content), 'utf8') !== Number(manifest.contentBytes)) {
      return { valid: false, reasonCode: 'EXPORT_CONTENT_HASH_MISMATCH' };
    }
    const expected = createHmac('sha256', String(secret || '')).update(stableJson(unsignedManifest)).digest('hex');
    const a = Buffer.from(String(signature.value || ''), 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return { valid: false, reasonCode: 'EXPORT_SIGNATURE_MISMATCH' };
    return { valid: true, reasonCode: null, manifestHash };
  } catch { return { valid: false, reasonCode: 'EXPORT_VERIFICATION_FAILED' }; }
}
