import { createHash } from 'node:crypto';
import { normalizePolicyScope, normalizeUuid } from './governance-model.ts';
import { stableJson } from '../../../../../../packages/contracts/src/canonical-json.ts';
import { isSha256Hex } from '../../../../../../packages/contracts/src/ids.ts';
import type { RepositoryScope } from '../../../../../../packages/contracts/src/scope.ts';
import type { Row } from '../../../platform/persistence/queryable.ts';

export const MAX_HISTORY_LIMIT = 200;

type Fields = Readonly<Record<string, unknown>>;

export class GovernanceDigitalTwinError extends Error {
  override readonly name = 'GovernanceDigitalTwinError';
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function fail(message: string, code = 'GOVERNANCE_DIGITAL_TWIN_INVALID', status = 400): never {
  throw new GovernanceDigitalTwinError(message, code, status);
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

/* The rows the store read for one part of the twin; anything that is not a list is no rows. */
function rowsIn(value: unknown): readonly Row[] {
  return Array.isArray(value) ? value as readonly Row[] : [];
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
  if (value == null || value === '') return fallback;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) fail('Digital Twin pagination input is invalid', 'GOVERNANCE_DIGITAL_TWIN_INPUT_INVALID');
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number < min || number > max) fail('Digital Twin pagination input is invalid', 'GOVERNANCE_DIGITAL_TWIN_INPUT_INVALID');
  return number;
}

export interface DigitalTwinOptions {
  readonly historyLimit: number;
  readonly afterDecisionSeq: number | null;
  readonly beforeDecisionSeq: number | null;
}

export function normalizeDigitalTwinOptions(input: unknown = {}): DigitalTwinOptions {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Digital Twin options are invalid', 'GOVERNANCE_DIGITAL_TWIN_INPUT_INVALID');
  const fields = input as Fields;
  if (fields.afterDecisionSeq != null && fields.beforeDecisionSeq != null) fail('Choose one Digital Twin decision cursor', 'GOVERNANCE_DIGITAL_TWIN_INPUT_INVALID');
  return deepFreeze({
    historyLimit: integer(fields.historyLimit, 50, 1, MAX_HISTORY_LIMIT),
    afterDecisionSeq: fields.afterDecisionSeq == null ? null : integer(fields.afterDecisionSeq, 0, 0, Number.MAX_SAFE_INTEGER),
    beforeDecisionSeq: fields.beforeDecisionSeq == null ? null : integer(fields.beforeDecisionSeq, 0, 0, Number.MAX_SAFE_INTEGER)
  });
}

function date(value: unknown, label: string): string {
  const parsed = new Date(value as string | number | Date);
  if (!Number.isFinite(parsed.getTime())) fail(`${label} is invalid`, 'GOVERNANCE_DIGITAL_TWIN_DATA_INVALID', 500);
  return parsed.toISOString();
}

function count(value: unknown): number {
  const number = Number(value || 0);
  if (!Number.isSafeInteger(number) || number < 0) fail('Digital Twin count is invalid', 'GOVERNANCE_DIGITAL_TWIN_DATA_INVALID', 500);
  return number;
}


function hash(value: unknown, label: string): string {
  const text = String(value || '').trim().toLowerCase();
  if (!isSha256Hex(text)) fail(`${label} is invalid`, 'GOVERNANCE_DIGITAL_TWIN_DATA_INVALID', 500);
  return text;
}

function uuid(value: unknown, label: string): string {
  try { return normalizeUuid(value, label); }
  catch { fail(`${label} is invalid`, 'GOVERNANCE_DIGITAL_TWIN_DATA_INVALID', 500); }
}

export interface VersionReview {
  readonly status: 'rejected' | 'approved' | 'pending';
  readonly requiredApprovals: number;
  readonly assignedCount: number;
  readonly approvalCount: number;
  readonly rejectionCount: number;
  readonly terminal: boolean;
}

function reviewState(row: Row): VersionReview {
  const requiredApprovals = count(row.required_approvals || 1);
  const assignedCount = count(row.assignment_count);
  const approvalCount = count(row.approval_count);
  const rejectionCount = count(row.rejection_count);
  const status = rejectionCount > 0 ? 'rejected' : approvalCount >= requiredApprovals ? 'approved' : 'pending';
  return { status, requiredApprovals, assignedCount, approvalCount, rejectionCount, terminal: status !== 'pending' };
}

export type SimulationEvidence =
  | { readonly status: 'recorded-activation-evidence'; readonly simulationHash: string; readonly scenarioSetHash: string; readonly resultHash: string; readonly recordedAt: string }
  | { readonly status: 'fresh-simulation-required' };

export interface TwinVersion {
  readonly versionId: string;
  readonly versionNumber: number;
  readonly documentHash: string;
  readonly createdAt: string;
  readonly review: VersionReview;
  readonly withdrawn: boolean;
  readonly previouslyActive: boolean;
  readonly simulationEvidence: SimulationEvidence;
}

export interface TwinPolicy {
  readonly policyId: string;
  readonly policyKey: string;
  readonly name: string;
  readonly description: string;
  readonly revision: number;
  readonly updatedAt: string;
  readonly active: { readonly versionId: string; readonly versionNumber: number; readonly documentHash: string; readonly enforcementMode: unknown } | null;
  readonly latestVersion: TwinVersion | null;
  readonly versionCount: number;
  readonly switchedOff: { readonly versionId: string; readonly versionNumber: number } | null;
}

export interface TwinDraft {
  readonly draftId: string;
  readonly policyId: string;
  readonly revision: number;
  readonly documentHash: string;
  readonly authoredByLogin: string;
  readonly requiredApprovals: number;
  readonly disallowAuthorApproval: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TwinProposedVersion extends TwinVersion {
  readonly policyId: unknown;
  readonly policyKey: string;
  readonly activationReadiness: { readonly eligible: false; readonly blockers: readonly string[] };
}

export interface TwinException {
  readonly exceptionId: string;
  readonly policyId: string;
  readonly versionId: string;
  readonly kind: unknown;
  readonly action: unknown;
  readonly state: unknown;
  readonly expiresAt: string;
  readonly createdAt: string;
}

export interface TwinActivation {
  readonly seq: number;
  readonly policyId: string;
  readonly versionId: string;
  readonly action: unknown;
  readonly actorLogin: unknown;
  readonly createdAt: string;
  readonly evidence: { readonly simulationHash: string; readonly scenarioSetHash: string; readonly resultHash: string } | null;
}

export interface TwinDecision {
  readonly seq: number;
  readonly action: unknown;
  readonly enforcementOutcome: unknown;
  readonly effectiveEffect: unknown;
  readonly evaluatedAt: string;
  readonly decisionHash: string;
}

/* Each part is true only when the store read all of it; anything else (absent included) is carried as read. */
export interface TwinCompleteness {
  readonly policies: unknown;
  readonly versions: unknown;
  readonly drafts: unknown;
  readonly exceptions: unknown;
  readonly activations: unknown;
  readonly decisions: unknown;
}

/* The repository's governance as it stands, as it is proposed to change, and as it has been decided. */
export interface DigitalTwinReadModel {
  readonly schemaVersion: 1;
  readonly scope: RepositoryScope;
  readonly current: { readonly policies: readonly TwinPolicy[]; readonly policyCount: number; readonly returnedPolicyCount: number; readonly activePolicyCount: number };
  readonly proposed: { readonly drafts: readonly TwinDraft[]; readonly draftCount: number; readonly versions: readonly TwinProposedVersion[]; readonly versionCount: number };
  readonly effective: {
    readonly activePolicyCount: number;
    readonly activeExceptionCount: number;
    readonly activeExceptionsByAction: readonly { readonly action: unknown; readonly count: number }[];
    readonly exceptionReferences: readonly TwinException[];
  };
  readonly history: {
    readonly activations: readonly TwinActivation[];
    readonly decisions: readonly TwinDecision[];
    readonly exceptions: readonly TwinException[];
    readonly nextDecisionSeq: number | null;
    readonly nextBeforeDecisionSeq: number | null;
    readonly decisionOrder: 'desc' | 'asc';
    readonly requestedAfterDecisionSeq: number | null;
    readonly requestedBeforeDecisionSeq: number | null;
    readonly limit: number;
  };
  readonly freshness: { readonly status: 'current' | 'partial'; readonly asOf: string; readonly completeness: TwinCompleteness };
  readonly readModelHash: string;
}

const ENFORCEMENT_MODES: readonly unknown[] = ['observe', 'warn', 'block'];

export function buildPolicyDigitalTwinReadModel(input: unknown = {}): DigitalTwinReadModel {
  const fields = input as Fields;
  const scope = normalizePolicyScope(fields.scope);
  const options = normalizeDigitalTwinOptions(fields.options || {});
  const data = fields.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail('Digital Twin source data is invalid', 'GOVERNANCE_DIGITAL_TWIN_DATA_INVALID', 500);
  const source = data as Fields;
  const asOf = date(source.asOf, 'Digital Twin snapshot time');
  const policyRows = rowsIn(source.policies);
  const versionRows = rowsIn(source.versions);
  const draftRows = rowsIn(source.drafts);
  const exceptionRows = rowsIn(source.exceptions);
  const activationRows = rowsIn(source.activations);
  const decisionRows = rowsIn(source.decisions);
  /* Keyed by the policy id exactly as the row carries it, which is how proposals are matched back to their policy. */
  const versionsByPolicy = new Map<unknown, TwinVersion[]>();
  for (const row of versionRows) {
    const simulationHash = row.simulation_hash == null ? null : String(row.simulation_hash);
    const entry: TwinVersion = {
      versionId: uuid(row.version_id, 'Policy version id'),
      versionNumber: count(row.version_number),
      documentHash: hash(row.document_hash, 'Policy document hash'),
      createdAt: date(row.created_at, 'Policy version time'),
      review: reviewState(row),
      withdrawn: row.withdrawn === true,
      previouslyActive: row.previously_active === true,
      simulationEvidence: simulationHash ? {
        status: 'recorded-activation-evidence',
        simulationHash: hash(simulationHash, 'Simulation hash'),
        scenarioSetHash: hash(row.scenario_set_hash, 'Scenario-set hash'),
        resultHash: hash(row.simulation_result_hash, 'Simulation result hash'),
        recordedAt: date(row.simulation_evidence_created_at, 'Simulation evidence time')
      } : { status: 'fresh-simulation-required' }
    };
    let list = versionsByPolicy.get(row.policy_id);
    if (!list) versionsByPolicy.set(row.policy_id, list = []);
    list.push(entry);
  }
  for (const values of versionsByPolicy.values()) values.sort((a, b) => b.versionNumber - a.versionNumber || a.versionId.localeCompare(b.versionId));

  const policies: TwinPolicy[] = policyRows.map(row => {
    const versions = versionsByPolicy.get(row.policy_id) || [];
    const activeVersionId = row.active_version_id || null;
    return {
      policyId: uuid(row.policy_id, 'Policy id'),
      policyKey: String(row.policy_key || ''),
      name: String(row.name || ''),
      description: String(row.description || ''),
      revision: count(row.revision),
      updatedAt: date(row.updated_at, 'Policy update time'),
      active: activeVersionId ? {
        versionId: uuid(activeVersionId, 'Active version id'),
        versionNumber: count(row.active_version_number),
        documentHash: hash(row.active_document_hash, 'Active document hash'),
        enforcementMode: ENFORCEMENT_MODES.includes(row.active_enforcement_mode) ? row.active_enforcement_mode : 'observe'
      } : null,
      latestVersion: versions[0] || null,
      versionCount: versions.length,
      /* Switched off rather than never switched on: the version it was running
       * when it was turned off, which is the one "turn it back on" offers. */
      switchedOff: !activeVersionId && row.last_activation_action === 'deactivate' && row.last_activation_version_id ? {
        versionId: uuid(row.last_activation_version_id, 'Switched-off version id'),
        versionNumber: count(row.last_activation_version_number)
      } : null
    };
  }).sort((a, b) => a.policyKey.localeCompare(b.policyKey) || a.policyId.localeCompare(b.policyId));

  const drafts: TwinDraft[] = draftRows.map(row => ({
    draftId: uuid(row.draft_id, 'Draft id'),
    policyId: uuid(row.policy_id, 'Draft policy id'),
    revision: count(row.revision),
    documentHash: hash(row.document_hash, 'Draft document hash'),
    authoredByLogin: String(row.authored_by_login || ''),
    requiredApprovals: count(row.required_approvals),
    disallowAuthorApproval: row.disallow_author_approval !== false,
    createdAt: date(row.created_at, 'Draft creation time'),
    updatedAt: date(row.updated_at, 'Draft update time')
  })).sort((a, b) => a.policyId.localeCompare(b.policyId) || b.updatedAt.localeCompare(a.updatedAt) || a.draftId.localeCompare(b.draftId));

  const proposedVersions: TwinProposedVersion[] = [];
  for (const [policyId, versions] of versionsByPolicy.entries()) {
    const policy = policies.find(item => item.policyId === policyId);
    if (!policy || !versions.length) continue;
    /* Proposed means still on its way in: never run, not taken back, and newer
     * than whatever is running now. */
    const pending = versions.filter(version => !version.withdrawn && !version.previouslyActive);
    const active = policy.active;
    const candidates = active
      ? pending.filter(version => version.versionNumber > active.versionNumber)
      : pending.slice(0, 1);
    for (const version of candidates) {
      const blockers: string[] = [];
      if (version.review.status !== 'approved') blockers.push(`review-${version.review.status}`);
      blockers.push('fresh-simulation-required');
      proposedVersions.push({
        policyId,
        policyKey: policy.policyKey,
        ...version,
        activationReadiness: { eligible: false, blockers }
      });
    }
  }
  proposedVersions.sort((a, b) => a.policyKey.localeCompare(b.policyKey) || b.versionNumber - a.versionNumber || a.versionId.localeCompare(b.versionId));

  const exceptions: TwinException[] = exceptionRows.map(row => ({
    exceptionId: uuid(row.exception_id, 'Exception id'),
    policyId: uuid(row.policy_id, 'Exception policy id'),
    versionId: uuid(row.version_id, 'Exception version id'),
    kind: row.kind,
    action: row.action,
    state: row.state,
    expiresAt: date(row.expires_at, 'Exception expiry'),
    createdAt: date(row.created_at, 'Exception creation time')
  })).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.exceptionId.localeCompare(b.exceptionId));
  const effectiveExceptions = exceptions.filter(item => item.state === 'approved' && new Date(item.expiresAt).getTime() > new Date(asOf).getTime());
  const summaryRows = rowsIn(source.activeExceptionSummary);
  const activeExceptionsByAction: readonly { readonly action: unknown; readonly count: number }[] = summaryRows.length
    ? summaryRows.map(row => ({ action: String(row.action || ''), count: count(row.active_count) })).sort((a, b) => a.action.localeCompare(b.action))
    : [...new Map(effectiveExceptions.map(item => [item.action, 0])).keys()].sort().map(action => ({ action, count: effectiveExceptions.filter(item => item.action === action).length }));
  const activeExceptionCount = activeExceptionsByAction.reduce((total, item) => total + item.count, 0);

  const activations: TwinActivation[] = activationRows.map(row => ({
    seq: count(row.seq), policyId: uuid(row.policy_id, 'Activation policy id'), versionId: uuid(row.version_id, 'Activation version id'),
    action: row.action, actorLogin: row.actor_login, createdAt: date(row.created_at, 'Activation time'),
    evidence: row.simulation_hash ? {
      simulationHash: hash(row.simulation_hash, 'Activation simulation hash'),
      scenarioSetHash: hash(row.scenario_set_hash, 'Activation scenario-set hash'),
      resultHash: hash(row.simulation_result_hash, 'Activation result hash')
    } : null
  }));
  const decisions: TwinDecision[] = decisionRows.map(row => ({
    seq: count(row.seq), action: row.action, enforcementOutcome: row.enforcement_outcome,
    effectiveEffect: row.effective_effect, evaluatedAt: date(row.evaluated_at || row.created_at, 'Decision time'),
    decisionHash: hash(row.decision_hash, 'Decision hash')
  }));
  const reported = source.completeness;
  const completeness: TwinCompleteness = {
    policies: reported && read(reported, 'policies') === true,
    versions: reported && read(reported, 'versions') === true,
    drafts: reported && read(reported, 'drafts') === true,
    exceptions: reported && read(reported, 'exceptions') === true,
    activations: reported && read(reported, 'activations') === true,
    decisions: reported && read(reported, 'decisions') === true
  };
  const complete = Object.values(completeness).every(Boolean);
  const totals: Fields = source.totals && typeof source.totals === 'object' ? source.totals as Fields : {};
  const totalPolicyCount = totals.policies == null ? policies.length : count(totals.policies);
  const totalActivePolicyCount = totals.activePolicies == null ? policies.filter(item => item.active).length : count(totals.activePolicies);
  const body = {
    schemaVersion: 1 as const,
    scope,
    current: {
      policies,
      policyCount: totalPolicyCount,
      returnedPolicyCount: policies.length,
      activePolicyCount: totalActivePolicyCount
    },
    proposed: { drafts, draftCount: drafts.length, versions: proposedVersions, versionCount: proposedVersions.length },
    effective: {
      activePolicyCount: totalActivePolicyCount,
      activeExceptionCount,
      activeExceptionsByAction,
      exceptionReferences: effectiveExceptions
    },
    history: {
      activations,
      decisions,
      exceptions,
      nextDecisionSeq: source.nextDecisionSeq == null ? null : count(source.nextDecisionSeq),
      nextBeforeDecisionSeq: source.nextBeforeDecisionSeq == null ? null : count(source.nextBeforeDecisionSeq),
      decisionOrder: source.decisionOrder === 'desc' || options.afterDecisionSeq == null ? 'desc' as const : 'asc' as const,
      requestedAfterDecisionSeq: options.afterDecisionSeq,
      requestedBeforeDecisionSeq: options.beforeDecisionSeq,
      limit: options.historyLimit
    },
    freshness: { status: complete ? 'current' as const : 'partial' as const, asOf, completeness }
  };
  return deepFreeze({ ...body, readModelHash: createHash('sha256').update(stableJson(body), 'utf8').digest('hex') });
}
