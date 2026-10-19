import { createHash } from 'node:crypto';
import { deepFreeze } from '../../../../../packages/contracts/src/guards.ts';
import type { ExecutionContract } from '../../../../../packages/contracts/src/mutation.ts';

export const MAX_FILE_BATCH_ITEMS = 100;
export const MAX_FILE_BATCH_PAYLOAD_BYTES = 2 * 1024 * 1024;

/* Field order is the order the properties were always set in: name, code, status. */
export class MutationCoverageError extends Error {
  override readonly name = 'MutationCoverageError';
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
/* The module's exports were frozen whole, the class with them. */
Object.freeze(MutationCoverageError);

/*
 * This module's canonical JSON, kept byte for byte: batch ids and hashes are
 * recorded as evidence, so they must not move. Of the server's eight copies of
 * the idea, three variants differ on undefined and on objects with toJSON; they
 * are unified only with proof over every input each one hashes (the mission
 * ledger, D3: carried to Phase G).
 */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hash(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

type ContractMode = ExecutionContract['mode'];

function contract(mode: ContractMode, maxItems: number, maxProviderWrites: number, atomicity: string, partialFailure = false, maxPayloadBytes = 0): ExecutionContract {
  return deepFreeze({ mode, maxItems, maxProviderWrites, atomicity, partialFailure, maxPayloadBytes }) as ExecutionContract;
}

const DEFAULT_SINGLE = contract('single', 1, 1, 'single-side-effect');
const DEFAULT_GOVERNANCE = contract('single', 1, 0, 'application-transaction');

export const ACTION_EXECUTION_CONTRACTS: Readonly<Record<string, ExecutionContract>> = deepFreeze({
  'repository.create': DEFAULT_SINGLE,
  'repository.delete': DEFAULT_SINGLE,
  'branch.create': DEFAULT_SINGLE,
  'branch.delete': DEFAULT_SINGLE,
  'branch.reset': DEFAULT_SINGLE,
  'file.write': contract('composite', 1, 8, 'multi-step'),
  'file.delete': contract('composite', 1, 6, 'multi-step'),
  'file.rename': contract('batch-atomic', 2, 4, 'single-provider-commit'),
  'file.batch': contract('batch-atomic', MAX_FILE_BATCH_ITEMS, 4, 'single-provider-commit', false, MAX_FILE_BATCH_PAYLOAD_BYTES),
  'file.upload': contract('composite', 1, 10, 'multi-step'),
  'directory.move': contract('batch-atomic', 800, 4, 'single-provider-commit'),
  'git.blob.create': DEFAULT_SINGLE,
  'commit.revert': contract('batch-atomic', 500, 4, 'single-provider-commit'),
  'commit.restore': contract('composite', 1, 3, 'single-provider-commit'),
  'commit.restore-paths': contract('batch-atomic', 500, 4, 'single-provider-commit'),
  'pull.create': DEFAULT_SINGLE,
  'pull.merge': DEFAULT_SINGLE,
  'pull.review': DEFAULT_SINGLE,
  'issue.create': DEFAULT_SINGLE,
  'issue.comment': DEFAULT_SINGLE,
  'issue.update': DEFAULT_SINGLE,
  'repository.star': DEFAULT_SINGLE,
  'repository.unstar': DEFAULT_SINGLE,
  'workflow.rerun': DEFAULT_SINGLE,
  'release.create': DEFAULT_SINGLE,
  'recovery.restore-refs': contract('batch-partial', 50, 50, 'best-effort-per-item', true),
  'webhook.connect': contract('composite', 1, 2, 'multi-step'),
  'webhook.disconnect': DEFAULT_SINGLE,
  'governance.policy.create': DEFAULT_GOVERNANCE,
  'governance.draft.create': DEFAULT_GOVERNANCE,
  'governance.draft.update': DEFAULT_GOVERNANCE,
  'governance.draft.submit': DEFAULT_GOVERNANCE,
  'governance.reviewer.assign': DEFAULT_GOVERNANCE,
  'governance.approval.decide': DEFAULT_GOVERNANCE,
  'governance.policy.activate': DEFAULT_GOVERNANCE,
  'governance.policy.rollback': DEFAULT_GOVERNANCE,
  'governance.exception.request': DEFAULT_GOVERNANCE,
  'governance.exception.decide': DEFAULT_GOVERNANCE,
  'governance.exception.revoke': DEFAULT_GOVERNANCE,
  'governance.policy.deactivate': DEFAULT_GOVERNANCE,
  'governance.policy.archive': DEFAULT_GOVERNANCE,
  'governance.policy.restore': DEFAULT_GOVERNANCE,
  'governance.draft.discard': DEFAULT_GOVERNANCE,
  'governance.version.withdraw': DEFAULT_GOVERNANCE,
  'governance.reset': DEFAULT_GOVERNANCE,
  /*
   * Exposure actions are governance-shaped: they record a decision or start a
   * read, and none of them writes to a provider. The contract is the same one
   * every other zero-write governed action uses, which is the point -- an
   * action with its own bespoke contract is an action nobody can reason about
   * alongside the rest.
   */
  'exposure.scan.request': DEFAULT_GOVERNANCE,
  'exposure.scan.cancel': DEFAULT_GOVERNANCE,
  'exposure.credential.verify': DEFAULT_GOVERNANCE,
  'exposure.readability.probe': DEFAULT_GOVERNANCE,
  'exposure.finding.accept-risk': DEFAULT_GOVERNANCE,
  'exposure.finding.export': DEFAULT_GOVERNANCE,
  'exposure.history.clear': DEFAULT_GOVERNANCE,
  'code-audit.history.clear': DEFAULT_GOVERNANCE,
  'code-audit.finding.triage': DEFAULT_GOVERNANCE,
  'code-audit.finding.reopen': DEFAULT_GOVERNANCE,
  'governance.notification.preferences.update': DEFAULT_GOVERNANCE,
  'governance.notification.read': DEFAULT_GOVERNANCE,
  'governance.webhook.create': DEFAULT_GOVERNANCE,
  'governance.webhook.update': DEFAULT_GOVERNANCE,
  'governance.webhook.rotate': DEFAULT_GOVERNANCE,
  'governance.webhook.delete': DEFAULT_GOVERNANCE,
  'governance.audit.export.create': DEFAULT_GOVERNANCE
});

export interface InventoriedRoute {
  readonly method: string;
  readonly route: string;
  readonly action: string;
  readonly execution: ExecutionContract;
}

function route(method: string, routePath: string, action: string): InventoriedRoute {
  const execution = ACTION_EXECUTION_CONTRACTS[action];
  if (!execution) throw new Error(`Missing execution contract for ${action}`);
  return deepFreeze({ method, route: routePath, action, execution });
}

export const MUTATION_ROUTE_INVENTORY: readonly InventoriedRoute[] = deepFreeze([
  route('POST', '/api/repos', 'repository.create'),
  route('DELETE', '/api/repo/:owner/:repo', 'repository.delete'),
  route('POST', '/api/repo/:owner/:repo/branches', 'branch.create'),
  route('DELETE', '/api/repo/:owner/:repo/branches/:name', 'branch.delete'),
  route('PUT', '/api/repo/:owner/:repo/file', 'file.write'),
  route('DELETE', '/api/repo/:owner/:repo/file', 'file.delete'),
  route('POST', '/api/repo/:owner/:repo/rename', 'file.rename'),
  route('POST', '/api/repo/:owner/:repo/batch', 'file.batch'),
  route('POST', '/api/repo/:owner/:repo/revert', 'commit.revert'),
  route('POST', '/api/repo/:owner/:repo/restore', 'commit.restore'),
  route('POST', '/api/repo/:owner/:repo/restore-paths', 'commit.restore-paths'),
  route('POST', '/api/repo/:owner/:repo/reset', 'branch.reset'),
  route('POST', '/api/repo/:owner/:repo/pulls', 'pull.create'),
  route('PUT', '/api/repo/:owner/:repo/pulls/:num/merge', 'pull.merge'),
  route('POST', '/api/repo/:owner/:repo/issues', 'issue.create'),
  route('POST', '/api/repo/:owner/:repo/issues/:num/comments', 'issue.comment'),
  route('PATCH', '/api/repo/:owner/:repo/issues/:num', 'issue.update'),
  route('PUT', '/api/repo/:owner/:repo/star', 'repository.star'),
  route('DELETE', '/api/repo/:owner/:repo/star', 'repository.unstar'),
  route('POST', '/api/repo/:owner/:repo/pulls/:num/reviews', 'pull.review'),
  route('POST', '/api/repo/:owner/:repo/actions/:runId/rerun', 'workflow.rerun'),
  route('POST', '/api/repo/:owner/:repo/releases', 'release.create'),
  route('POST', '/api/repo/:owner/:repo/blob', 'git.blob.create'),
  route('POST', '/api/repo/:owner/:repo/upload', 'file.upload'),
  route('POST', '/api/repo/:owner/:repo/move-dir', 'directory.move'),
  route('POST', '/api/repo/:owner/:repo/restore-refs', 'recovery.restore-refs'),
  route('POST', '/api/repo/:owner/:repo/live-events/connect', 'webhook.connect'),
  route('DELETE', '/api/repo/:owner/:repo/live-events', 'webhook.disconnect'),
  /*
   * Exposure scanning. These are inventoried rather than exempted, so the
   * route, its action and its execution contract are checked together -- an
   * exemption list only records that somebody decided not to look.
   */
  route('POST', '/api/repo/:owner/:repo/exposure/scans', 'exposure.scan.request'),
  route('POST', '/api/repo/:owner/:repo/exposure/scans/:scanId/cancel', 'exposure.scan.cancel'),
  route('POST', '/api/repo/:owner/:repo/exposure/findings/:fingerprint/accept-risk', 'exposure.finding.accept-risk'),
  route('POST', '/api/repo/:owner/:repo/exposure/clear', 'exposure.history.clear'),
  route('POST', '/api/repo/:owner/:repo/code-audit/history/clear', 'code-audit.history.clear'),
  route('POST', '/api/repo/:owner/:repo/code-audit/findings/:findingId/triage', 'code-audit.finding.triage'),
  route('POST', '/api/repo/:owner/:repo/code-audit/findings/:findingId/reopen', 'code-audit.finding.reopen'),
  /*
   * The two that contact somebody else. A verification uses a discovered
   * credential against the service that issued it; a probe asks a project what
   * its anonymous role can read. Both are decisions worth having in the ledger
   * with a name on them, which is the whole reason they are inventoried rather
   * than treated as ordinary reads.
   */
  route('POST', '/api/repo/:owner/:repo/exposure/findings/:fingerprint/verify', 'exposure.credential.verify'),
  route('POST', '/api/repo/:owner/:repo/exposure/findings/:fingerprint/probe-readability', 'exposure.readability.probe'),
  route('POST', '/api/repo/:owner/:repo/governance/policies', 'governance.policy.create'),
  route('POST', '/api/repo/:owner/:repo/governance/policies/:policyId/drafts', 'governance.draft.create'),
  route('PATCH', '/api/repo/:owner/:repo/governance/policies/:policyId/drafts/:draftId', 'governance.draft.update'),
  route('POST', '/api/repo/:owner/:repo/governance/policies/:policyId/drafts/:draftId/submit', 'governance.draft.submit'),
  route('POST', '/api/repo/:owner/:repo/governance/policies/:policyId/versions/:versionId/reviewers/me', 'governance.reviewer.assign'),
  route('POST', '/api/repo/:owner/:repo/governance/policies/:policyId/versions/:versionId/decisions', 'governance.approval.decide'),
  route('POST', '/api/repo/:owner/:repo/governance/policies/:policyId/versions/:versionId/activate', 'governance.policy.activate'),
  route('POST', '/api/repo/:owner/:repo/governance/policies/:policyId/versions/:versionId/rollback', 'governance.policy.rollback'),
  route('POST', '/api/repo/:owner/:repo/governance/policies/:policyId/versions/:versionId/exceptions', 'governance.exception.request'),
  route('POST', '/api/repo/:owner/:repo/governance/exceptions/:exceptionId/decision', 'governance.exception.decide'),
  route('POST', '/api/repo/:owner/:repo/governance/exceptions/:exceptionId/revoke', 'governance.exception.revoke'),
  route('POST', '/api/repo/:owner/:repo/governance/policies/:policyId/deactivate', 'governance.policy.deactivate'),
  route('POST', '/api/repo/:owner/:repo/governance/policies/:policyId/archive', 'governance.policy.archive'),
  route('POST', '/api/repo/:owner/:repo/governance/policies/:policyId/restore', 'governance.policy.restore'),
  route('DELETE', '/api/repo/:owner/:repo/governance/policies/:policyId/drafts/:draftId', 'governance.draft.discard'),
  route('POST', '/api/repo/:owner/:repo/governance/policies/:policyId/versions/:versionId/withdraw', 'governance.version.withdraw'),
  route('POST', '/api/repo/:owner/:repo/governance/reset', 'governance.reset'),
  route('PUT', '/api/repo/:owner/:repo/governance/notifications/preferences', 'governance.notification.preferences.update'),
  route('POST', '/api/repo/:owner/:repo/governance/notifications/read', 'governance.notification.read'),
  route('POST', '/api/repo/:owner/:repo/governance/webhooks', 'governance.webhook.create'),
  route('PATCH', '/api/repo/:owner/:repo/governance/webhooks/:webhookId', 'governance.webhook.update'),
  route('POST', '/api/repo/:owner/:repo/governance/webhooks/:webhookId/rotate-secret', 'governance.webhook.rotate'),
  route('DELETE', '/api/repo/:owner/:repo/governance/webhooks/:webhookId', 'governance.webhook.delete'),
  route('POST', '/api/repo/:owner/:repo/governance/exports', 'governance.audit.export.create')
]);

export function executionContractForAction(action: unknown): ExecutionContract {
  /* Own entries only: an inherited name such as `constructor` is not a registered action. */
  const name = String(action || '');
  const found = Object.hasOwn(ACTION_EXECUTION_CONTRACTS, name) ? ACTION_EXECUTION_CONTRACTS[name] : undefined;
  if (!found) throw new MutationCoverageError('Mutation execution contract is not registered', 'MUTATION_EXECUTION_UNKNOWN');
  return found;
}

function normalizeBatchPath(value: unknown): string {
  const path = String(value || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!path || path.length > 1000 || path.split('/').some(piece => !piece || piece === '.' || piece === '..') || /[\0\r\n]/.test(path)) {
    throw new MutationCoverageError('Batch item path is invalid', 'MUTATION_BATCH_ITEM_INVALID');
  }
  return path;
}

export interface FileBatchItem {
  readonly op: 'put' | 'delete';
  readonly path: string;
  readonly sha?: string;
  readonly content?: string;
}

export interface FileBatch {
  readonly items: readonly FileBatchItem[];
  readonly itemIds: readonly string[];
  readonly batchHash: string;
  readonly payloadBytes: number;
  readonly summary: { readonly itemCount: number; readonly itemIds: readonly string[]; readonly batchHash: string; readonly payloadBytes: number; readonly paths: readonly string[] };
}

export function normalizeFileBatch(input: unknown): FileBatch {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_FILE_BATCH_ITEMS) {
    throw new MutationCoverageError('File batch requires between 1 and 100 operations', 'MUTATION_BATCH_SIZE');
  }
  const paths = new Set<string>();
  const items = input.map((entry: unknown, index): FileBatchItem => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new MutationCoverageError(`Batch item ${index + 1} is invalid`, 'MUTATION_BATCH_ITEM_INVALID');
    }
    const raw = entry as Readonly<Record<string, unknown>>;
    const op = String(raw.op || '').trim().toLowerCase();
    if (op !== 'put' && op !== 'delete') {
      throw new MutationCoverageError(`Batch item ${index + 1} has an unknown operation`, 'MUTATION_BATCH_ITEM_INVALID');
    }
    const path = normalizeBatchPath(raw.path);
    const key = path.toLowerCase();
    if (paths.has(key)) throw new MutationCoverageError('Batch targets must be unique', 'MUTATION_BATCH_DUPLICATE_TARGET');
    paths.add(key);
    const item: { op: 'put' | 'delete'; path: string; sha?: string; content?: string } = { op, path };
    if (op === 'put') {
      if (raw.sha) {
        const sha = String(raw.sha).trim().toLowerCase();
        if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new MutationCoverageError('Batch blob SHA is invalid', 'MUTATION_BATCH_ITEM_INVALID');
        item.sha = sha;
      } else {
        item.content = String(raw.content == null ? '' : raw.content);
      }
    }
    return item;
  });
  const payloadBytes = Buffer.byteLength(stableJson(items), 'utf8');
  if (payloadBytes > MAX_FILE_BATCH_PAYLOAD_BYTES) {
    throw new MutationCoverageError('File batch payload exceeds 2 MiB', 'MUTATION_BATCH_PAYLOAD_TOO_LARGE', 413);
  }
  const evidenceItems = items.map((item, index) => ({
    index,
    op: item.op,
    path: item.path,
    sha: item.sha || null,
    contentHash: Object.prototype.hasOwnProperty.call(item, 'content') ? hash(item.content) : null
  }));
  const itemIds = evidenceItems.map(item => hash(item));
  const batchHash = hash({ action: 'file.batch', items: evidenceItems });
  /* The paths a batch touches travel with the batch: a path-scoped policy rule
   * can only reach the paths the mutation reports. */
  const batchPaths = [...new Set(items.map(item => item.path))].sort();
  return deepFreeze({
    items,
    itemIds,
    batchHash,
    payloadBytes,
    summary: { itemCount: items.length, itemIds, batchHash, payloadBytes, paths: batchPaths }
  });
}

export function summarizeBatchItems(actionInput: unknown, itemsInput: unknown): Readonly<{ itemCount: number; itemIds: readonly string[]; batchHash: string }> {
  const action = String(actionInput || '');
  const contractValue = executionContractForAction(action);
  const items: readonly unknown[] = Array.isArray(itemsInput) ? itemsInput : [];
  if (!items.length || items.length > contractValue.maxItems) {
    throw new MutationCoverageError(`Mutation batch requires between 1 and ${contractValue.maxItems} items`, 'MUTATION_BATCH_SIZE');
  }
  const normalized = items.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new MutationCoverageError(`Mutation batch item ${index + 1} is invalid`, 'MUTATION_BATCH_ITEM_INVALID');
    }
    const copy: Record<string, unknown> = {};
    const record = item as Readonly<Record<string, unknown>>;
    for (const key of Object.keys(record).sort()) {
      const value = record[key];
      if (value == null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') copy[key] = value;
      else throw new MutationCoverageError(`Mutation batch item ${index + 1} is not scalar`, 'MUTATION_BATCH_ITEM_INVALID');
    }
    return copy;
  });
  const itemIds = normalized.map((item, index) => hash({ index, item }));
  return deepFreeze({ itemCount: normalized.length, itemIds, batchHash: hash({ action, items: normalized }) });
}

export function validateCoverageInventory(actions: unknown): true {
  if (!actions || typeof actions !== 'object') throw new MutationCoverageError('Mutation action registry is required', 'MUTATION_COVERAGE_INVALID');
  const routeKeys = new Set();
  for (const item of MUTATION_ROUTE_INVENTORY) {
    if (!(actions as Readonly<Record<string, unknown>>)[item.action]) throw new MutationCoverageError(`Mutation inventory action is missing: ${item.action}`, 'MUTATION_COVERAGE_ACTION_MISSING');
    const key = `${item.method} ${item.route}`;
    if (routeKeys.has(key)) throw new MutationCoverageError(`Duplicate mutation route inventory entry: ${key}`, 'MUTATION_COVERAGE_DUPLICATE');
    routeKeys.add(key);
  }
  for (const action of Object.keys(actions)) {
    if (!Object.hasOwn(ACTION_EXECUTION_CONTRACTS, action)) throw new MutationCoverageError(`Execution contract is missing: ${action}`, 'MUTATION_EXECUTION_MISSING');
  }
  return true;
}

