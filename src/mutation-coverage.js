'use strict';

const crypto = require('crypto');

const MAX_FILE_BATCH_ITEMS = 100;
const MAX_FILE_BATCH_PAYLOAD_BYTES = 2 * 1024 * 1024;

class MutationCoverageError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.name = 'MutationCoverageError';
    this.code = code;
    this.status = status;
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hash(value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

function contract(mode, maxItems, maxProviderWrites, atomicity, partialFailure = false, maxPayloadBytes = 0) {
  return deepFreeze({ mode, maxItems, maxProviderWrites, atomicity, partialFailure, maxPayloadBytes });
}

const DEFAULT_SINGLE = contract('single', 1, 1, 'single-side-effect');
const DEFAULT_GOVERNANCE = contract('single', 1, 0, 'application-transaction');

const ACTION_EXECUTION_CONTRACTS = deepFreeze({
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
  'governance.notification.preferences.update': DEFAULT_GOVERNANCE,
  'governance.notification.read': DEFAULT_GOVERNANCE,
  'governance.webhook.create': DEFAULT_GOVERNANCE,
  'governance.webhook.update': DEFAULT_GOVERNANCE,
  'governance.webhook.rotate': DEFAULT_GOVERNANCE,
  'governance.webhook.delete': DEFAULT_GOVERNANCE,
  'governance.audit.export.create': DEFAULT_GOVERNANCE
});

function route(method, routePath, action) {
  const execution = ACTION_EXECUTION_CONTRACTS[action];
  if (!execution) throw new Error(`Missing execution contract for ${action}`);
  return deepFreeze({ method, route: routePath, action, execution });
}

const MUTATION_ROUTE_INVENTORY = deepFreeze([
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
  route('PUT', '/api/repo/:owner/:repo/governance/notifications/preferences', 'governance.notification.preferences.update'),
  route('POST', '/api/repo/:owner/:repo/governance/notifications/read', 'governance.notification.read'),
  route('POST', '/api/repo/:owner/:repo/governance/webhooks', 'governance.webhook.create'),
  route('PATCH', '/api/repo/:owner/:repo/governance/webhooks/:webhookId', 'governance.webhook.update'),
  route('POST', '/api/repo/:owner/:repo/governance/webhooks/:webhookId/rotate-secret', 'governance.webhook.rotate'),
  route('DELETE', '/api/repo/:owner/:repo/governance/webhooks/:webhookId', 'governance.webhook.delete'),
  route('POST', '/api/repo/:owner/:repo/governance/exports', 'governance.audit.export.create')
]);

function executionContractForAction(action) {
  const found = ACTION_EXECUTION_CONTRACTS[String(action || '')];
  if (!found) throw new MutationCoverageError('Mutation execution contract is not registered', 'MUTATION_EXECUTION_UNKNOWN');
  return found;
}

function normalizeBatchPath(value) {
  const path = String(value || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!path || path.length > 1000 || path.split('/').some(piece => !piece || piece === '.' || piece === '..') || /[\0\r\n]/.test(path)) {
    throw new MutationCoverageError('Batch item path is invalid', 'MUTATION_BATCH_ITEM_INVALID');
  }
  return path;
}

function normalizeFileBatch(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_FILE_BATCH_ITEMS) {
    throw new MutationCoverageError('File batch requires between 1 and 100 operations', 'MUTATION_BATCH_SIZE');
  }
  const paths = new Set();
  const items = input.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new MutationCoverageError(`Batch item ${index + 1} is invalid`, 'MUTATION_BATCH_ITEM_INVALID');
    }
    const op = String(raw.op || '').trim().toLowerCase();
    if (op !== 'put' && op !== 'delete') {
      throw new MutationCoverageError(`Batch item ${index + 1} has an unknown operation`, 'MUTATION_BATCH_ITEM_INVALID');
    }
    const path = normalizeBatchPath(raw.path);
    const key = path.toLowerCase();
    if (paths.has(key)) throw new MutationCoverageError('Batch targets must be unique', 'MUTATION_BATCH_DUPLICATE_TARGET');
    paths.add(key);
    const item = { op, path };
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

function summarizeBatchItems(actionInput, itemsInput) {
  const action = String(actionInput || '');
  const contractValue = executionContractForAction(action);
  const items = Array.isArray(itemsInput) ? itemsInput : [];
  if (!items.length || items.length > contractValue.maxItems) {
    throw new MutationCoverageError(`Mutation batch requires between 1 and ${contractValue.maxItems} items`, 'MUTATION_BATCH_SIZE');
  }
  const normalized = items.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new MutationCoverageError(`Mutation batch item ${index + 1} is invalid`, 'MUTATION_BATCH_ITEM_INVALID');
    }
    const copy = {};
    for (const key of Object.keys(item).sort()) {
      const value = item[key];
      if (value == null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') copy[key] = value;
      else throw new MutationCoverageError(`Mutation batch item ${index + 1} is not scalar`, 'MUTATION_BATCH_ITEM_INVALID');
    }
    return copy;
  });
  const itemIds = normalized.map((item, index) => hash({ index, item }));
  return deepFreeze({ itemCount: normalized.length, itemIds, batchHash: hash({ action, items: normalized }) });
}

function validateCoverageInventory(actions) {
  if (!actions || typeof actions !== 'object') throw new MutationCoverageError('Mutation action registry is required', 'MUTATION_COVERAGE_INVALID');
  const routeKeys = new Set();
  for (const item of MUTATION_ROUTE_INVENTORY) {
    if (!actions[item.action]) throw new MutationCoverageError(`Mutation inventory action is missing: ${item.action}`, 'MUTATION_COVERAGE_ACTION_MISSING');
    const key = `${item.method} ${item.route}`;
    if (routeKeys.has(key)) throw new MutationCoverageError(`Duplicate mutation route inventory entry: ${key}`, 'MUTATION_COVERAGE_DUPLICATE');
    routeKeys.add(key);
  }
  for (const action of Object.keys(actions)) {
    if (!ACTION_EXECUTION_CONTRACTS[action]) throw new MutationCoverageError(`Execution contract is missing: ${action}`, 'MUTATION_EXECUTION_MISSING');
  }
  return true;
}

module.exports = deepFreeze({
  MutationCoverageError,
  MAX_FILE_BATCH_ITEMS,
  MAX_FILE_BATCH_PAYLOAD_BYTES,
  MUTATION_ROUTE_INVENTORY,
  ACTION_EXECUTION_CONTRACTS,
  executionContractForAction,
  normalizeFileBatch,
  summarizeBatchItems,
  validateCoverageInventory,
  stableJson
});
