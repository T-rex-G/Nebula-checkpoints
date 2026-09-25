'use strict';

const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const { normalizePolicyScope } = require('./governance-model');
const { normalizeAuthorizationSnapshot } = require('./authorization-resolver');
const { executionContractForAction, validateCoverageInventory } = require('./mutation-coverage');

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const ASSURANCE_LEVELS = new Set(['credential', 'oauth-session', 'github-app']);
const SENSITIVE_KEY_RX = /(?:accesstoken|refreshtoken|token|secret|password|privatekey|authorization|cookie)/i;
const MAX_METADATA_BYTES = 16 * 1024;
const MAX_METADATA_DEPTH = 6;
const MAX_METADATA_KEYS = 80;
const MAX_METADATA_ARRAY = 100;
const MAX_METADATA_STRING = 2048;
const OPERATION_ID_DOMAIN = 'nebulaverse-x.provider-write.operation-id.v1';
const MAX_OPERATION_TARGET_BYTES = 64 * 1024;

class MutationGatewayError extends Error {
  constructor(message, code, status = 403) {
    super(message);
    this.name = 'MutationGatewayError';
    this.code = code;
    this.status = status;
  }
}

function defineAction(category, risk, description, operations, stepUpAction = null, actorBinding = 'execution') {
  return Object.freeze({ category, risk, description, operations: Object.freeze([...operations]), stepUpAction, actorBinding });
}

const CONTENT_OPERATIONS = Object.freeze([
  'git.blob.create', 'git.tree.create', 'git.commit.create', 'git.refs.update',
  'gitlab.file.write', 'gitlab.file.delete',
  'gitea.branch.create', 'gitea.file.write', 'gitea.file.delete', 'gitea.branch.cas', 'gitea.branch.delete',
  'git-receive-pack', 'git-lfs.batch', 'git-lfs.upload', 'git-lfs.verify'
]);

const MUTATION_ACTIONS = Object.freeze({
  'repository.create': defineAction('repository', 'high', 'Create a repository', ['repository.create']),
  'repository.delete': defineAction('repository', 'critical', 'Delete a repository', ['repository.delete'], 'repository.delete'),
  'branch.create': defineAction('branch', 'medium', 'Create a branch', ['git.refs.create']),
  'branch.delete': defineAction('branch', 'high', 'Delete a branch', ['git.refs.delete']),
  'branch.reset': defineAction('branch', 'critical', 'Force a branch reference to a commit', ['git.refs.update'], 'branch.reset'),
  'file.write': defineAction('content', 'high', 'Create or update repository content', CONTENT_OPERATIONS),
  'file.delete': defineAction('content', 'high', 'Delete repository content', CONTENT_OPERATIONS),
  'file.rename': defineAction('content', 'high', 'Rename repository content', CONTENT_OPERATIONS),
  'file.batch': defineAction('content', 'high', 'Apply a batch of content changes', CONTENT_OPERATIONS),
  'file.upload': defineAction('content', 'high', 'Upload repository content', CONTENT_OPERATIONS),
  'directory.move': defineAction('content', 'high', 'Move a repository directory', CONTENT_OPERATIONS),
  'git.blob.create': defineAction('content', 'medium', 'Create a Git object blob', ['git.blob.create']),
  'commit.revert': defineAction('history', 'high', 'Create a revert commit', CONTENT_OPERATIONS),
  'commit.restore': defineAction('history', 'high', 'Restore repository content from history', ['git.commit.create', 'git.refs.update']),
  'commit.restore-paths': defineAction('history', 'high', 'Restore selected paths from history', CONTENT_OPERATIONS),
  'pull.create': defineAction('collaboration', 'medium', 'Create a pull or merge request', ['pull.create']),
  'pull.merge': defineAction('collaboration', 'critical', 'Merge a pull or merge request', ['pull.merge'], 'pull.merge'),
  'pull.review': defineAction('collaboration', 'medium', 'Submit a pull request review', ['pull.review']),
  'issue.create': defineAction('collaboration', 'medium', 'Create an issue', ['issue.create']),
  'issue.comment': defineAction('collaboration', 'medium', 'Comment on an issue', ['issue.comment']),
  'issue.update': defineAction('collaboration', 'medium', 'Update issue state', ['issue.update']),
  'repository.star': defineAction('user-preference', 'low', 'Star a repository', ['repository.star']),
  'repository.unstar': defineAction('user-preference', 'low', 'Unstar a repository', ['repository.unstar']),
  'workflow.rerun': defineAction('automation', 'high', 'Rerun an automation workflow', ['workflow.rerun']),
  'release.create': defineAction('release', 'high', 'Create a release', ['release.create']),
  'recovery.restore-refs': defineAction('recovery', 'critical', 'Restore repository references', ['git.refs.create', 'git.refs.update']),
  'webhook.connect': defineAction('integration', 'high', 'Create a repository webhook', ['webhook.connect', 'webhook.disconnect']),
  'webhook.disconnect': defineAction('integration', 'high', 'Delete a repository webhook', ['webhook.disconnect']),
  'governance.policy.create': defineAction('governance', 'medium', 'Create repository governance policy metadata', [], null, 'governance'),
  'governance.draft.create': defineAction('governance', 'medium', 'Create a repository governance policy draft', [], null, 'governance'),
  'governance.draft.update': defineAction('governance', 'medium', 'Update a repository governance policy draft', [], null, 'governance'),
  'governance.draft.submit': defineAction('governance', 'high', 'Submit a repository governance draft as an immutable version', [], null, 'governance'),
  'governance.reviewer.assign': defineAction('governance', 'medium', 'Claim reviewer assignment for an immutable policy version', [], null, 'governance'),
  'governance.approval.decide': defineAction('governance', 'high', 'Record an immutable governance review decision', [], null, 'governance'),
  'governance.policy.activate': defineAction('governance', 'critical', 'Activate an approved evidence-backed policy version', [], null, 'governance'),
  'governance.policy.rollback': defineAction('governance', 'critical', 'Rollback to a previously evidence-backed active policy version', [], null, 'governance'),
  'governance.exception.request': defineAction('governance', 'high', 'Request a time-bounded policy exception or waiver', [], null, 'governance'),
  'governance.exception.decide': defineAction('governance', 'critical', 'Approve or reject a time-bounded policy exception or waiver', [], null, 'governance'),
  'governance.exception.revoke': defineAction('governance', 'critical', 'Revoke an approved policy exception or waiver', [], null, 'governance'),
  /*
   * The rest of a policy's life. Switching a policy off and archiving it are
   * critical for the same reason activation is: they change what is enforced.
   * Restoring and withdrawing change what can be enforced later; discarding a
   * draft changes nothing anybody relies on yet.
   */
  'governance.policy.deactivate': defineAction('governance', 'critical', 'Switch off the active version of a repository governance policy', [], null, 'governance'),
  'governance.policy.archive': defineAction('governance', 'critical', 'Archive a repository governance policy, switching it off first', [], null, 'governance'),
  'governance.policy.restore': defineAction('governance', 'high', 'Restore an archived repository governance policy, switched off', [], null, 'governance'),
  'governance.draft.discard': defineAction('governance', 'medium', 'Discard a repository governance policy draft', [], null, 'governance'),
  'governance.version.withdraw': defineAction('governance', 'high', 'Withdraw a policy version that never took effect', [], null, 'governance'),
  'governance.reset': defineAction('governance', 'critical', 'Switch off and archive every governance policy in a repository', [], null, 'governance'),
  /*
   * Exposure scanning. None of these performs a provider mutation -- the
   * operations list is empty for every one -- but all of them are governed
   * actions: they read somebody's repository, use a credential found inside
   * it, or decide that a live exposure is acceptable.
   *
   * The bindings are the distinction that matters. Asking for a scan reads a
   * repository the caller can already read, so it binds to whoever executes
   * it. Accepting the risk of a live credential is a governance decision about
   * somebody else's security, so it binds to a governance role -- a repository
   * reader cannot wave away their own finding.
   */
  'exposure.scan.request': defineAction('exposure', 'medium', 'Request an exposure scan of a repository at a commit', []),
  'exposure.scan.cancel': defineAction('exposure', 'low', 'Cancel an exposure scan in progress', []),
  'exposure.credential.verify': defineAction('exposure', 'high', 'Ask the issuing provider whether a discovered credential is live', []),
  'exposure.readability.probe': defineAction('exposure', 'high', 'Establish whether a discovered project is readable anonymously', []),
  'exposure.finding.accept-risk': defineAction('exposure', 'critical', 'Accept the risk of an exposed credential', [], null, 'governance'),
  'exposure.finding.export': defineAction('exposure', 'medium', 'Export exposure findings as evidence', []),
  /*
   * Clearing is the reader's own record, not anybody else's, and it binds to
   * whoever executes it for that reason. It is medium rather than low because
   * it is irreversible: the verification and readability history it removes
   * was evidence, and the ledger entry this action writes is what remains.
   */
  'exposure.history.clear': defineAction('exposure', 'medium', 'Clear an identity\'s exposure history for a repository', []),
  'governance.notification.preferences.update': defineAction('governance', 'low', 'Update repository governance notification preferences', [], null, 'governance'),
  'governance.notification.read': defineAction('governance', 'low', 'Advance repository governance notification read state', [], null, 'governance'),
  'governance.webhook.create': defineAction('governance', 'high', 'Create a signed governance webhook destination', [], null, 'governance'),
  'governance.webhook.update': defineAction('governance', 'high', 'Update a signed governance webhook destination', [], null, 'governance'),
  'governance.webhook.rotate': defineAction('governance', 'critical', 'Rotate a governance webhook signing secret', [], null, 'governance'),
  'governance.webhook.delete': defineAction('governance', 'critical', 'Disable and delete a governance webhook destination', [], null, 'governance'),
  'governance.audit.export.create': defineAction('governance', 'medium', 'Create a signed governance evidence export', [], null, 'governance')
});

validateCoverageInventory(MUTATION_ACTIONS);

function fail(message, code, status = 403) {
  throw new MutationGatewayError(message, code, status);
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function cloneMetadata(value, path = '$', depth = 0) {
  if (depth > MAX_METADATA_DEPTH) fail('Mutation metadata is nested too deeply', 'MUTATION_METADATA_INVALID', 400);
  if (value == null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`Mutation metadata at ${path} contains a non-finite number`, 'MUTATION_METADATA_INVALID', 400);
    return value;
  }
  if (typeof value === 'string') {
    if (value.length > MAX_METADATA_STRING || /[\0\r\n]/.test(value)) {
      fail(`Mutation metadata at ${path} contains an invalid string`, 'MUTATION_METADATA_INVALID', 400);
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_METADATA_ARRAY) fail('Mutation metadata array is too large', 'MUTATION_METADATA_INVALID', 400);
    return value.map((item, index) => cloneMetadata(item, `${path}[${index}]`, depth + 1));
  }
  if (!isPlainObject(value)) fail(`Mutation metadata at ${path} must be JSON-compatible`, 'MUTATION_METADATA_INVALID', 400);
  const keys = Object.keys(value);
  if (keys.length > MAX_METADATA_KEYS) fail('Mutation metadata object has too many fields', 'MUTATION_METADATA_INVALID', 400);
  const output = {};
  for (const key of keys.sort()) {
    if (!key || key.length > 100 || SENSITIVE_KEY_RX.test(key.replace(/[^a-z0-9]/gi, '').toLowerCase())) {
      fail(`Sensitive or invalid mutation metadata field: ${key || '(empty)'}`, 'MUTATION_SENSITIVE_FIELD', 400);
    }
    output[key] = cloneMetadata(value[key], `${path}.${key}`, depth + 1);
  }
  return output;
}

function normalizeMetadata(input) {
  if (input == null) return Object.freeze({});
  if (!isPlainObject(input)) fail('Mutation metadata must be an object', 'MUTATION_METADATA_INVALID', 400);
  const output = cloneMetadata(input);
  if (Buffer.byteLength(JSON.stringify(output), 'utf8') > MAX_METADATA_BYTES) {
    fail('Mutation metadata exceeds 16 KiB', 'MUTATION_METADATA_TOO_LARGE', 413);
  }
  return deepFreeze(output);
}

function providerOperationId(input = {}) {
  if (!isPlainObject(input)) fail('Provider operation identity is invalid', 'MUTATION_OPERATION_ID_INVALID', 400);
  const mutationId = String(input.mutationId || '').trim().toLowerCase();
  const providerWriteIndex = Number(input.providerWriteIndex);
  const method = String(input.method || '').trim().toUpperCase();
  const operation = String(input.operation || '').trim().toLowerCase();
  const scopeKey = String(input.scopeKey || '').trim().toLowerCase();
  const transport = String(input.transport || 'api').trim().toLowerCase();
  const apiPath = String(input.apiPath || '').trim();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(mutationId) ||
    !Number.isSafeInteger(providerWriteIndex) ||
    providerWriteIndex < 1 ||
    !MUTATING_METHODS.has(method) ||
    !operation ||
    !scopeKey ||
    !transport ||
    (!apiPath && transport === 'api') ||
    Buffer.byteLength(apiPath, 'utf8') > MAX_OPERATION_TARGET_BYTES ||
    Buffer.byteLength(transport, 'utf8') > 256
  ) {
    fail('Provider operation identity is invalid', 'MUTATION_OPERATION_ID_INVALID', 400);
  }
  const hash = crypto.createHash('sha256');
  for (const [label, value] of [
    ['domain', OPERATION_ID_DOMAIN],
    ['mutationId', mutationId],
    ['providerWriteIndex', String(providerWriteIndex)],
    ['method', method],
    ['operation', operation],
    ['scopeKey', scopeKey],
    ['transport', transport],
    ['apiPath', apiPath]
  ]) {
    const labelBytes = Buffer.from(label, 'utf8');
    const valueBytes = Buffer.from(value, 'utf8');
    const lengths = Buffer.allocUnsafe(8);
    lengths.writeUInt32BE(labelBytes.length, 0);
    lengths.writeUInt32BE(valueBytes.length, 4);
    hash.update(lengths);
    hash.update(labelBytes);
    hash.update(valueBytes);
  }
  return hash.digest('hex');
}

function normalizeSecurity(input, definition) {
  const security = input == null ? {} : input;
  if (!isPlainObject(security)) fail('Mutation security context is invalid', 'MUTATION_SECURITY_INVALID', 400);
  const stepUpAction = String(security.stepUpAction || '').trim();
  const assurance = String(security.assurance || '').trim();
  const authorizedAt = security.authorizedAt == null ? null : Number(security.authorizedAt);
  if (definition.stepUpAction) {
    if (stepUpAction !== definition.stepUpAction || !ASSURANCE_LEVELS.has(assurance) ||
        !Number.isFinite(authorizedAt) || authorizedAt <= 0) {
      fail('The required step-up authorization was not consumed before entering the mutation gateway', 'MUTATION_STEP_UP_REQUIRED');
    }
    return Object.freeze({ stepUpAction, assurance, authorizedAt });
  }
  if (stepUpAction || assurance || authorizedAt != null) {
    if (stepUpAction && !MUTATION_ACTIONS[stepUpAction] && !['repository.delete', 'branch.reset', 'pull.merge'].includes(stepUpAction)) {
      fail('Mutation step-up action is invalid', 'MUTATION_SECURITY_INVALID', 400);
    }
    if (assurance && !ASSURANCE_LEVELS.has(assurance)) fail('Mutation assurance is invalid', 'MUTATION_SECURITY_INVALID', 400);
    if (authorizedAt != null && (!Number.isFinite(authorizedAt) || authorizedAt <= 0)) {
      fail('Mutation step-up timestamp is invalid', 'MUTATION_SECURITY_INVALID', 400);
    }
    return Object.freeze({ stepUpAction: stepUpAction || null, assurance: assurance || null, authorizedAt });
  }
  return Object.freeze({ stepUpAction: null, assurance: null, authorizedAt: null });
}

function normalizeMutationDescriptor(input = {}) {
  if (!isPlainObject(input)) fail('Mutation descriptor must be an object', 'MUTATION_DESCRIPTOR_INVALID', 400);
  if (Object.prototype.hasOwnProperty.call(input, 'controlMapping') ||
      Object.prototype.hasOwnProperty.call(input, 'policyDecision') ||
      Object.prototype.hasOwnProperty.call(input, 'enforcementMode')) {
    fail('Policy decisions and control mappings are derived inside the mutation gateway', 'MUTATION_POLICY_INPUT_FORBIDDEN', 400);
  }
  const action = String(input.action || '').trim().toLowerCase();
  const definition = MUTATION_ACTIONS[action];
  if (!definition) fail('Unknown repository mutation action', 'MUTATION_ACTION_UNKNOWN', 400);
  const scope = normalizePolicyScope({
    provider: input.provider,
    baseUrl: input.baseUrl,
    owner: input.owner,
    repo: input.repo
  });
  const actorIdentityKey = String(input.actorIdentityKey || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(actorIdentityKey)) fail('Mutation actor identity is invalid', 'MUTATION_ACTOR_INVALID', 400);
  const actorLogin = String(input.actorLogin || '').trim();
  if (!actorLogin || actorLogin.length > 200 || /[\0\r\n]/.test(actorLogin)) {
    fail('Mutation actor login is invalid', 'MUTATION_ACTOR_INVALID', 400);
  }
  const method = String(input.method || '').trim().toUpperCase();
  if (!MUTATING_METHODS.has(method)) fail('Mutation route method is invalid', 'MUTATION_METHOD_INVALID', 400);
  const route = String(input.route || '').trim();
  if (!route.startsWith('/api/') || route.length > 500 || /[\0\r\n]/.test(route)) {
    fail('Mutation route is invalid', 'MUTATION_ROUTE_INVALID', 400);
  }
  const mutationId = String(input.mutationId || crypto.randomUUID()).trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(mutationId)) {
    fail('Mutation identifier is invalid', 'MUTATION_ID_INVALID', 400);
  }
  const authorization = normalizeAuthorizationSnapshot(input.authorization);
  if (authorization.scope.scopeKey !== scope.scopeKey) {
    fail('Authorization evidence does not match the mutation repository scope', 'MUTATION_AUTHORIZATION_SCOPE_MISMATCH');
  }
  if (definition.actorBinding === 'governance') {
    if (authorization.governanceActor.login.toLowerCase() !== actorLogin.toLowerCase() ||
        authorization.governanceActor.identityKey !== actorIdentityKey) {
      fail('Authorization evidence does not match the governance mutation actor', 'MUTATION_AUTHORIZATION_ACTOR_MISMATCH');
    }
  } else if (authorization.executionPrincipal.login.toLowerCase() !== actorLogin.toLowerCase() ||
      (authorization.executionPrincipal.kind === 'user' && authorization.executionPrincipal.identityKey !== actorIdentityKey)) {
    fail('Authorization evidence does not match the mutation actor', 'MUTATION_AUTHORIZATION_ACTOR_MISMATCH');
  }
  const descriptor = {
    mutationId,
    action,
    category: definition.category,
    risk: definition.risk,
    provider: scope.provider,
    authority: scope.authority,
    owner: scope.owner,
    repo: scope.repo,
    scopeKey: scope.scopeKey,
    actorIdentityKey,
    actorLogin,
    method,
    route,
    metadata: normalizeMetadata(input.metadata),
    execution: executionContractForAction(action),
    security: normalizeSecurity(input.security, definition),
    authorization
  };
  return deepFreeze(descriptor);
}

function decodePathPiece(value) {
  try { return decodeURIComponent(String(value || '')); }
  catch { fail('Provider mutation target is malformed', 'MUTATION_TARGET_INVALID', 400); }
}

function parseProviderRepositoryTarget(providerInput, apiPathInput) {
  const provider = String(providerInput || '').trim().toLowerCase();
  const apiPath = String(apiPathInput || '').split('?', 1)[0];
  if (provider === 'gitlab') {
    const match = apiPath.match(/^\/projects\/([^/]+)/);
    if (!match) return null;
    const full = decodePathPiece(match[1]).replace(/^\/+|\/+$/g, '');
    const pieces = full.split('/').filter(Boolean);
    if (pieces.length < 2) return null;
    return { owner: pieces.slice(0, -1).join('/'), repo: pieces[pieces.length - 1] };
  }
  if (provider === 'github' || provider === 'gitea') {
    const repo = apiPath.match(/^\/repos\/([^/]+)\/([^/]+)/);
    if (repo) return { owner: decodePathPiece(repo[1]), repo: decodePathPiece(repo[2]) };
    const star = apiPath.match(/^\/user\/starred\/([^/]+)\/([^/]+)/);
    if (star) return { owner: decodePathPiece(star[1]), repo: decodePathPiece(star[2]) };
  }
  return null;
}

function classifyProviderOperation(providerInput, apiPathInput, methodInput, transportInput) {
  const transport = String(transportInput || '').trim();
  if (transport) return transport;
  const provider = String(providerInput || '').trim().toLowerCase();
  const method = String(methodInput || '').trim().toUpperCase();
  const apiPath = String(apiPathInput || '').split('?', 1)[0];
  if (provider === 'gitlab') {
    if (method === 'POST' && apiPath === '/projects') return 'repository.create';
    const project = apiPath.match(/^\/projects\/[^/]+(\/.*)?$/);
    const suffix = project && project[1] || '';
    if (/^\/repository\/files\//.test(suffix)) {
      if (method === 'DELETE') return 'gitlab.file.delete';
      if (method === 'POST' || method === 'PUT') return 'gitlab.file.write';
    }
    if (method === 'POST' && suffix === '/merge_requests') return 'pull.create';
    if (method === 'PUT' && /^\/merge_requests\/\d+\/merge$/.test(suffix)) return 'pull.merge';
    if (method === 'POST' && suffix === '/issues') return 'issue.create';
    if (method === 'POST' && /^\/issues\/\d+\/notes$/.test(suffix)) return 'issue.comment';
    if (method === 'PUT' && /^\/issues\/\d+$/.test(suffix)) return 'issue.update';
    return null;
  }
  if (provider === 'gitea') {
    const repo = apiPath.match(/^\/repos\/[^/]+\/[^/]+(\/.*)?$/);
    if (!repo) return null;
    const suffix = repo[1] || '';
    if (/^\/contents\/.+/.test(suffix)) {
      if (method === 'DELETE') return 'gitea.file.delete';
      if (method === 'POST' || method === 'PUT') return 'gitea.file.write';
    }
    if (suffix === '/branches' && method === 'POST') return 'gitea.branch.create';
    if (/^\/branches\/.+/.test(suffix) && method === 'PUT') return 'gitea.branch.cas';
    if (/^\/branches\/.+/.test(suffix) && method === 'DELETE') return 'gitea.branch.delete';
  }
  if (provider === 'github' || provider === 'gitea') {
    if (method === 'POST' && apiPath === '/user/repos') return 'repository.create';
    const star = apiPath.match(/^\/user\/starred\/[^/]+\/[^/]+$/);
    if (star && method === 'PUT') return 'repository.star';
    if (star && method === 'DELETE') return 'repository.unstar';
    const repo = apiPath.match(/^\/repos\/[^/]+\/[^/]+(\/.*)?$/);
    if (!repo) return null;
    const suffix = repo[1] || '';
    if (!suffix && method === 'DELETE') return 'repository.delete';
    if (suffix === '/git/refs' && method === 'POST') return 'git.refs.create';
    if (/^\/git\/refs\/heads\//.test(suffix) && method === 'DELETE') return 'git.refs.delete';
    if (/^\/git\/refs\/heads\//.test(suffix) && method === 'PATCH') return 'git.refs.update';
    if (suffix === '/git/blobs' && method === 'POST') return 'git.blob.create';
    if (suffix === '/git/trees' && method === 'POST') return 'git.tree.create';
    if (suffix === '/git/commits' && method === 'POST') return 'git.commit.create';
    if (suffix === '/pulls' && method === 'POST') return 'pull.create';
    if (/^\/pulls\/\d+\/merge$/.test(suffix) && method === 'PUT') return 'pull.merge';
    if (/^\/pulls\/\d+\/reviews$/.test(suffix) && method === 'POST') return 'pull.review';
    if (suffix === '/issues' && method === 'POST') return 'issue.create';
    if (/^\/issues\/\d+\/comments$/.test(suffix) && method === 'POST') return 'issue.comment';
    if (/^\/issues\/\d+$/.test(suffix) && method === 'PATCH') return 'issue.update';
    if (/^\/actions\/runs\/[^/]+\/rerun$/.test(suffix) && method === 'POST') return 'workflow.rerun';
    if (suffix === '/releases' && method === 'POST') return 'release.create';
    if (suffix === '/hooks' && method === 'POST') return 'webhook.connect';
    if (/^\/hooks\/[^/]+$/.test(suffix) && method === 'DELETE') return 'webhook.disconnect';
  }
  return null;
}

function publicEvent(type, descriptor, extra = {}) {
  return Object.freeze({
    type,
    mutationId: descriptor.mutationId,
    action: descriptor.action,
    risk: descriptor.risk,
    provider: descriptor.provider,
    authority: descriptor.authority,
    owner: descriptor.owner,
    repo: descriptor.repo,
    scopeKey: descriptor.scopeKey,
    actorIdentityKey: descriptor.actorIdentityKey,
    ...extra
  });
}

function createMutationGateway({ eventSink, policyEvaluator } = {}) {
  if (eventSink != null && typeof eventSink !== 'function') throw new TypeError('Mutation gateway eventSink must be a function');
  if (policyEvaluator != null && typeof policyEvaluator !== 'function') throw new TypeError('Mutation gateway policyEvaluator must be a function');
  const storage = new AsyncLocalStorage();
  const emit = event => {
    if (!eventSink) return;
    try {
      const pending = eventSink(event);
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    } catch {}
  };

  function activeStore() {
    return storage.getStore() || null;
  }

  function current() {
    const active = activeStore();
    return active ? active.descriptor : null;
  }

  function executionSnapshot() {
    const active = activeStore();
    if (!active) return null;
    return Object.freeze({
      providerWriteCount: active.runtime.providerWriteCount,
      operationIds: Object.freeze([...active.runtime.operationIds])
    });
  }

  async function run(input, callback) {
    if (typeof callback !== 'function') throw new TypeError('Mutation gateway run requires a callback');
    if (current()) fail('Nested mutation gateway contexts are not allowed', 'MUTATION_CONTEXT_NESTED', 409);
    const descriptor = normalizeMutationDescriptor(input);
    emit(publicEvent('mutation.entered', descriptor));
    try {
      let context = descriptor;
      if (policyEvaluator) {
        const rawDecision = await policyEvaluator(descriptor);
        const { normalizePolicyDecision } = require('./governance-enforcement');
        const policyDecision = normalizePolicyDecision(rawDecision, descriptor);
        context = deepFreeze({ ...descriptor, policyDecision });
        emit(publicEvent('policy.evaluated', descriptor, {
          decisionId: policyDecision.decisionId || null,
          source: policyDecision.source,
          effectiveEffect: policyDecision.effectiveEffect,
          rolloutMode: policyDecision.rolloutMode,
          enforcementOutcome: policyDecision.enforcementOutcome,
          warningCodes: policyDecision.warningCodes.slice(0, 16),
          controlMappingStatus: policyDecision.controlMapping.status,
          controlMappingHash: policyDecision.controlMapping.mappingHash
        }));
        if (policyDecision.enforcementOutcome === 'block') {
          emit(publicEvent('policy.blocked', descriptor, {
            decisionId: policyDecision.decisionId || null,
            blockCode: policyDecision.blockCode
          }));
          const unavailable = [
            'POLICY_EVALUATION_UNAVAILABLE',
            'POLICY_UNSUPPORTED_ACTIVE_RULES'
          ].includes(policyDecision.blockCode);
          fail(policyDecision.blockCode === 'POLICY_UNSUPPORTED_ACTIVE_RULES'
            ? 'Policy evaluation cannot safely evaluate the active rules'
            : unavailable ? 'Policy evaluation is unavailable' :
            policyDecision.blockCode === 'POLICY_APPROVAL_REQUIRED' ? 'This mutation requires approval under the active policy' :
              'This mutation is blocked by the active policy',
          policyDecision.blockCode, unavailable ? 503 : 403);
        }
      }
      const runtime = { providerWriteCount: 0, operationIds: [] };
      const result = await storage.run({ descriptor: context, runtime }, callback);
      emit(publicEvent('mutation.completed', descriptor, {
        providerWriteCount: runtime.providerWriteCount,
        operationIds: runtime.operationIds.slice(0, descriptor.execution.maxProviderWrites)
      }));
      return result;
    } catch (error) {
      emit(publicEvent('mutation.failed', descriptor, {
        errorCode: String(error && error.code || 'MUTATION_HANDLER_FAILED').slice(0, 100)
      }));
      throw error;
    }
  }

  function assertProviderMutation(target = {}) {
    const active = activeStore();
    const descriptor = active && active.descriptor;
    if (!descriptor) fail('Outbound provider writes must pass through the central mutation gateway', 'MUTATION_GATEWAY_REQUIRED');
    const method = String(target.method || '').trim().toUpperCase();
    if (!MUTATING_METHODS.has(method)) fail('Provider mutation method is invalid', 'MUTATION_METHOD_INVALID', 400);
    const provider = String(target.provider || '').trim().toLowerCase();
    if (provider !== descriptor.provider) fail('Provider write does not match the active mutation context', 'MUTATION_PROVIDER_MISMATCH');
    let parsed = target.owner && target.repo
      ? { owner: target.owner, repo: target.repo }
      : parseProviderRepositoryTarget(provider, target.apiPath);
    if (!parsed && descriptor.action === 'repository.create') {
      const body = isPlainObject(target.body) ? target.body : {};
      const repositoryName = String(body.name || body.path || '').trim();
      if (repositoryName) parsed = { owner: descriptor.owner, repo: repositoryName };
    }
    if (!parsed) {
      fail('Provider write target could not be matched to the active repository scope', 'MUTATION_TARGET_UNRESOLVED');
    }
    const scope = normalizePolicyScope({ provider, baseUrl: target.baseUrl, owner: parsed.owner, repo: parsed.repo });
    if (scope.scopeKey !== descriptor.scopeKey) {
      fail('Provider write target does not match the active mutation repository', 'MUTATION_SCOPE_MISMATCH');
    }
    const operation = classifyProviderOperation(provider, target.apiPath, method, target.transport);
    if (!operation) fail('Provider write operation is not registered in the mutation gateway', 'MUTATION_OPERATION_UNREGISTERED');
    const definition = MUTATION_ACTIONS[descriptor.action];
    if (!definition.operations.includes(operation)) {
      fail('Provider write operation does not match the active mutation action', 'MUTATION_ACTION_MISMATCH');
    }
    const nextIndex = active.runtime.providerWriteCount + 1;
    if (nextIndex > descriptor.execution.maxProviderWrites) {
      fail('Provider write count exceeds the registered mutation execution contract', 'MUTATION_PROVIDER_WRITE_LIMIT', 409);
    }
    const operationId = providerOperationId({
      mutationId: descriptor.mutationId,
      providerWriteIndex: nextIndex,
      method,
      operation,
      scopeKey: scope.scopeKey,
      transport: target.transport || 'api',
      apiPath: target.apiPath || ''
    });
    active.runtime.providerWriteCount = nextIndex;
    active.runtime.operationIds.push(operationId);
    emit(publicEvent('provider.write.authorized', descriptor, {
      method,
      operation,
      operationId,
      providerWriteIndex: nextIndex,
      transport: String(target.transport || 'api').slice(0, 80)
    }));
    return deepFreeze({ ...descriptor, providerWrite: { index: nextIndex, operation, operationId } });
  }

  return Object.freeze({ run, current, executionSnapshot, assertProviderMutation });
}

module.exports = Object.freeze({
  MutationGatewayError,
  MUTATION_ACTIONS,
  normalizeMutationDescriptor,
  normalizeMutationMetadata: normalizeMetadata,
  providerOperationId,
  parseProviderRepositoryTarget,
  classifyProviderOperation,
  createMutationGateway
});
