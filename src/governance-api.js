'use strict';

const dns = require('dns');
const {
  normalizePolicyScope,
  normalizePolicyDocument,
  normalizeApprovalPolicy,
  policyDocumentHash
} = require('./governance-model');
const {
  GOVERNANCE_ROLE_NAMES,
  normalizeAuthorizationSnapshot
} = require('./authorization-resolver');
const { simulatePolicyImpact } = require('./governance-simulation');
const { listPolicyTemplates, getPolicyTemplate, generateRepositoryBaseline } = require('./governance-templates');
const { buildPolicyDigitalTwinReadModel, normalizeDigitalTwinOptions } = require('./governance-digital-twin');
const {
  normalizeNotificationPreferences,
  normalizeWebhookDefinition,
  normalizeWebhookDestination
} = require('./governance-delivery');

const ROLE_SET = new Set(GOVERNANCE_ROLE_NAMES);

class GovernanceApiError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.name = 'GovernanceApiError';
    this.code = code;
    this.status = status;
  }
}

function fail(message, code, status = 400) {
  throw new GovernanceApiError(message, code, status);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function normalizeNow(now) {
  const timestamp = Number(typeof now === 'function' ? now() : Date.now());
  if (!Number.isFinite(timestamp)) fail('Governance authorization clock is invalid', 'GOVERNANCE_AUTHORIZATION_INVALID', 500);
  return timestamp;
}

function assertGovernanceAuthorization(input = {}) {
  const requiredRole = String(input.requiredRole || '').trim().toLowerCase();
  if (!ROLE_SET.has(requiredRole)) fail('Governance role requirement is invalid', 'GOVERNANCE_ROLE_INVALID', 500);
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


function bodyObject(value) {
  if (value == null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('Governance review input must be a JSON object', 'GOVERNANCE_REVIEW_INPUT_INVALID', 400);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    fail('Governance review input must be a plain JSON object', 'GOVERNANCE_REVIEW_INPUT_INVALID', 400);
  }
  return value;
}

function assertReviewInputFields(input, allowed) {
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

function reviewerAuthorizationEvidence(authorization) {
  return deepFreeze({
    accessLevel: authorization.repositoryAccess.level,
    providerRole: authorization.repositoryAccess.providerRole,
    source: authorization.repositoryAccess.source,
    fetchedAt: authorization.evidence.fetchedAt,
    expiresAt: authorization.evidence.expiresAt
  });
}

function activatorAuthorizationEvidence(authorization) {
  return deepFreeze({
    accessLevel: authorization.repositoryAccess.level,
    providerRole: authorization.repositoryAccess.providerRole,
    source: authorization.repositoryAccess.source,
    fetchedAt: authorization.evidence.fetchedAt,
    expiresAt: authorization.evidence.expiresAt
  });
}

function assertActivationInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('Governance activation input must be a JSON object', 'GOVERNANCE_ACTIVATION_INPUT_INVALID', 400);
  }
  const proto = Object.getPrototypeOf(input);
  if (proto !== Object.prototype && proto !== null) {
    fail('Governance activation input must be a plain JSON object', 'GOVERNANCE_ACTIVATION_INPUT_INVALID', 400);
  }
  const body = input;
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
  const simulationKeys = Object.keys(simulation);
  if (simulationKeys.some(key => !['simulationHash', 'request'].includes(key))) {
    fail('Simulation evidence contains an unsupported field', 'GOVERNANCE_SIMULATION_INPUT_INVALID', 400);
  }
  const simulationHash = String(simulation.simulationHash || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(simulationHash)) {
    fail('Simulation hash is invalid', 'GOVERNANCE_SIMULATION_HASH_INVALID', 400);
  }
  if (!simulation.request || typeof simulation.request !== 'object' || Array.isArray(simulation.request)) {
    fail('Simulation request is required', 'GOVERNANCE_SIMULATION_INPUT_INVALID', 400);
  }
  return deepFreeze({ expectedRevision, reason, simulationHash, simulationRequest: simulation.request });
}

function assertRequiredIdempotencyKey(value) {
  const key = String(value == null ? '' : value).trim();
  if (!key) {
    fail('Activation and rollback require an Idempotency-Key', 'GOVERNANCE_IDEMPOTENCY_KEY_REQUIRED', 400);
  }
  if (key.length < 8 || key.length > 200 || /[\u0000-\u001f\u007f]/.test(key)) {
    fail('Idempotency-Key must contain 8 to 200 printable characters', 'GOVERNANCE_IDEMPOTENCY_KEY_INVALID', 400);
  }
  return key;
}

function exceptionAuthorizationEvidence(authorization) {
  return deepFreeze({
    accessLevel: authorization.repositoryAccess.level,
    providerRole: authorization.repositoryAccess.providerRole,
    source: authorization.repositoryAccess.source,
    fetchedAt: authorization.evidence.fetchedAt,
    expiresAt: authorization.evidence.expiresAt
  });
}

function assertExceptionInputFields(input, allowed) {
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

function assertDeliveryInputFields(input, allowed) {
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

function integerInput(value, label, options = {}) {
  if (value == null || String(value).trim() === '') return options.defaultValue == null ? null : options.defaultValue;
  const number = Number(value);
  const minimum = options.minimum == null ? 0 : options.minimum;
  const maximum = options.maximum == null ? Number.MAX_SAFE_INTEGER : options.maximum;
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    fail(`${label} is invalid`, 'GOVERNANCE_DELIVERY_INPUT_INVALID', 400);
  }
  return number;
}

function normalizedVersionInput(input = {}) {
  const document = normalizePolicyDocument(input.document);
  const approvalPolicy = normalizeApprovalPolicy(input.approvalPolicy);
  return deepFreeze({ document, documentHash: policyDocumentHash(document), approvalPolicy });
}

function requireStore(store) {
  const methods = [
    'listPolicies', 'createPolicy', 'getPolicyStateInScope',
    'createDraft', 'getDraft', 'updateDraft', 'submitDraft',
    'listVersions', 'getVersionInScope', 'getReviewState', 'claimReviewer', 'recordReviewDecision',
    'activateVersion', 'rollbackVersion', 'listActivationHistory',
    'createExceptionRequest', 'getException', 'listExceptions', 'decideException', 'revokeException',
    'listPolicyDecisionsInScope', 'verifyPolicyDecisionChainInScope',
    'getNotificationPreferences', 'updateNotificationPreferences', 'markNotificationsRead', 'listNotifications',
    'createWebhook', 'listWebhooks', 'updateWebhook', 'rotateWebhookSecret', 'deleteWebhook', 'listWebhookDeliveries',
    'createEvidenceExport', 'listEvidenceExports', 'getEvidenceExport', 'verifyEvidenceExport'
  ];
  if (!store || methods.some(method => typeof store[method] !== 'function')) {
    throw new TypeError('Governance API service requires a complete governance store');
  }
  return store;
}

function createGovernanceApiService(options = {}) {
  const store = requireStore(options.store);
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const resolveRepositoryFacts = typeof options.resolveRepositoryFacts === 'function'
    ? options.resolveRepositoryFacts
    : async ({ scope }) => ({ schemaVersion: 1, defaultBranch: null, protectedBranches: [], pullRequestsEnabled: null, visibility: null, archived: false, resolvedForScopeKey: scope.scopeKey });
  const resolveWebhookAddresses = typeof options.resolveWebhookAddresses === 'function'
    ? options.resolveWebhookAddresses
    : async hostname => dns.promises.lookup(hostname, { all: true, verbatim: true });
  const authorize = (input, requiredRole) => assertGovernanceAuthorization({
    authorization: input.authorization,
    scope: input.scope,
    requiredRole,
    now
  });

  return Object.freeze({
    async getNotificationPreferences(input = {}) {
      const context = authorize(input, 'reader');
      return store.getNotificationPreferences({ scope: context.scope, actor: context.actor });
    },

    async updateNotificationPreferences(input = {}) {
      const context = authorize(input, 'reader');
      const body = assertDeliveryInputFields(input.input, new Set(['enabled', 'eventTypes']));
      return store.updateNotificationPreferences({
        scope: context.scope,
        actor: context.actor,
        preferences: normalizeNotificationPreferences(body),
        idempotencyKey: input.idempotencyKey
      });
    },

    async markNotificationsRead(input = {}) {
      const context = authorize(input, 'reader');
      const body = assertDeliveryInputFields(input.input, new Set(['throughSeq']));
      return store.markNotificationsRead({
        scope: context.scope,
        actor: context.actor,
        throughSeq: integerInput(body.throughSeq, 'Notification read cursor', { minimum: 0 }),
        idempotencyKey: input.idempotencyKey
      });
    },

    async listNotifications(input = {}) {
      const context = authorize(input, 'reader');
      return store.listNotifications({
        scope: context.scope,
        actor: context.actor,
        limit: integerInput(input.limit, 'Notification limit', { minimum: 1, maximum: 200, defaultValue: 50 }),
        afterSeq: integerInput(input.afterSeq, 'Notification cursor', { minimum: 0, defaultValue: 0 })
      });
    },

    async createWebhook(input = {}) {
      const context = authorize(input, 'administrator');
      const body = assertDeliveryInputFields(input.input, new Set(['name', 'url', 'eventTypes', 'enabled']));
      const definition = normalizeWebhookDefinition(body);
      const parsed = new URL(definition.url);
      const addresses = await resolveWebhookAddresses(parsed.hostname);
      normalizeWebhookDestination(definition.url, addresses);
      return store.createWebhook({ scope: context.scope, actor: context.actor, definition, idempotencyKey: input.idempotencyKey });
    },

    async listWebhooks(input = {}) {
      const context = authorize(input, 'administrator');
      return store.listWebhooks({ scope: context.scope });
    },

    async updateWebhook(input = {}) {
      const context = authorize(input, 'administrator');
      const body = assertDeliveryInputFields(input.input, new Set(['name', 'url', 'eventTypes', 'enabled']));
      const definition = normalizeWebhookDefinition(body);
      const parsed = new URL(definition.url);
      const addresses = await resolveWebhookAddresses(parsed.hostname);
      normalizeWebhookDestination(definition.url, addresses);
      return store.updateWebhook({ scope: context.scope, actor: context.actor, webhookId: input.webhookId, definition, idempotencyKey: input.idempotencyKey });
    },

    async rotateWebhookSecret(input = {}) {
      const context = authorize(input, 'administrator');
      assertDeliveryInputFields(input.input, new Set());
      return store.rotateWebhookSecret({ scope: context.scope, actor: context.actor, webhookId: input.webhookId, idempotencyKey: input.idempotencyKey });
    },

    async deleteWebhook(input = {}) {
      const context = authorize(input, 'administrator');
      assertDeliveryInputFields(input.input, new Set());
      return store.deleteWebhook({ scope: context.scope, actor: context.actor, webhookId: input.webhookId, idempotencyKey: input.idempotencyKey });
    },

    async listWebhookDeliveries(input = {}) {
      const context = authorize(input, 'administrator');
      return store.listWebhookDeliveries({
        scope: context.scope,
        webhookId: input.webhookId,
        limit: integerInput(input.limit, 'Webhook delivery limit', { minimum: 1, maximum: 200, defaultValue: 100 })
      });
    },

    async createEvidenceExport(input = {}) {
      const context = authorize(input, 'reader');
      const body = assertDeliveryInputFields(input.input, new Set(['format', 'afterEventSeq', 'throughEventSeq', 'limit']));
      return store.createEvidenceExport({
        scope: context.scope,
        actor: context.actor,
        format: body.format,
        afterEventSeq: integerInput(body.afterEventSeq, 'Evidence export lower cursor', { minimum: 0, defaultValue: 0 }),
        throughEventSeq: integerInput(body.throughEventSeq, 'Evidence export upper cursor', { minimum: 0 }),
        limit: integerInput(body.limit, 'Evidence export limit', { minimum: 1, maximum: 1000, defaultValue: 1000 }),
        idempotencyKey: input.idempotencyKey
      });
    },

    async listEvidenceExports(input = {}) {
      const context = authorize(input, 'reader');
      return store.listEvidenceExports({
        scope: context.scope,
        limit: integerInput(input.limit, 'Evidence export list limit', { minimum: 1, maximum: 200, defaultValue: 100 })
      });
    },

    async getEvidenceExport(input = {}) {
      const context = authorize(input, 'reader');
      return store.getEvidenceExport({ scope: context.scope, exportId: input.exportId });
    },

    async verifyEvidenceExport(input = {}) {
      const context = authorize(input, 'reader');
      return store.verifyEvidenceExport({ scope: context.scope, exportId: input.exportId });
    },

    async listPolicyTemplates(input = {}) {
      authorize(input, 'reader');
      return listPolicyTemplates();
    },

    async getPolicyTemplate(input = {}) {
      authorize(input, 'reader');
      return getPolicyTemplate(input.templateId);
    },

    async generateRepositoryBaseline(input = {}) {
      const context = authorize(input, 'reader');
      const body = bodyObject(input.input);
      const allowed = new Set(['templateId']);
      for (const key of Object.keys(body)) {
        if (!allowed.has(key)) fail('Baseline input contains an unsupported field', 'GOVERNANCE_BASELINE_INPUT_INVALID', 400);
      }
      const templateId = String(body.templateId || '').trim().toLowerCase();
      if (!templateId) fail('Baseline template is required', 'GOVERNANCE_BASELINE_INPUT_INVALID', 400);
      const facts = input.repositoryFacts === undefined
        ? await resolveRepositoryFacts({ scope: context.scope, authorization: context.authorization, actor: context.actor })
        : input.repositoryFacts;
      return generateRepositoryBaseline({ scope: context.scope, templateId, facts });
    },

    async getPolicyDigitalTwin(input = {}) {
      const context = authorize(input, 'reader');
      if (typeof store.getDigitalTwinReadModelData !== 'function') {
        fail('Digital Twin read model storage is unavailable', 'GOVERNANCE_DIGITAL_TWIN_UNAVAILABLE', 503);
      }
      const pagination = normalizeDigitalTwinOptions({ historyLimit: input.historyLimit, afterDecisionSeq: input.afterDecisionSeq });
      const data = await store.getDigitalTwinReadModelData({ scope: context.scope, ...pagination });
      return buildPolicyDigitalTwinReadModel({ scope: context.scope, data, options: pagination });
    },
    async listPolicies(input = {}) {
      const context = authorize(input, 'reader');
      return store.listPolicies({ scope: context.scope, limit: input.limit });
    },

    async listPolicyDecisions(input = {}) {
      const context = authorize(input, 'reader');
      return store.listPolicyDecisionsInScope({ scope: context.scope, limit: input.limit, afterSeq: input.afterSeq });
    },

    async verifyPolicyDecisionChain(input = {}) {
      const context = authorize(input, 'reader');
      return store.verifyPolicyDecisionChainInScope({ scope: context.scope, limit: input.limit });
    },

    async createPolicy(input = {}) {
      const context = authorize(input, 'author');
      const body = input.input && typeof input.input === 'object' ? input.input : {};
      return store.createPolicy({
        scope: context.scope,
        actor: context.actor,
        policyKey: body.policyKey,
        name: body.name,
        description: body.description,
        idempotencyKey: input.idempotencyKey
      });
    },

    async getPolicy(input = {}) {
      const context = authorize(input, 'reader');
      return store.getPolicyStateInScope({ policyId: input.policyId, scope: context.scope });
    },

    async validatePolicyVersion(input = {}) {
      const context = authorize(input, 'author');
      await store.getPolicyStateInScope({ policyId: input.policyId, scope: context.scope });
      return normalizedVersionInput(input.input || {});
    },

    async createDraft(input = {}) {
      const context = authorize(input, 'author');
      const version = normalizedVersionInput(input.input || {});
      return store.createDraft({
        policyId: input.policyId,
        scope: context.scope,
        actor: context.actor,
        idempotencyKey: input.idempotencyKey,
        ...version
      });
    },

    async getDraft(input = {}) {
      const context = authorize(input, 'author');
      return store.getDraft({
        policyId: input.policyId,
        draftId: input.draftId,
        scope: context.scope,
        actor: context.actor
      });
    },

    async updateDraft(input = {}) {
      const context = authorize(input, 'author');
      const body = input.input && typeof input.input === 'object' ? input.input : {};
      const version = normalizedVersionInput(body);
      return store.updateDraft({
        policyId: input.policyId,
        draftId: input.draftId,
        scope: context.scope,
        actor: context.actor,
        expectedRevision: body.expectedRevision,
        idempotencyKey: input.idempotencyKey,
        ...version
      });
    },

    async validateDraft(input = {}) {
      const context = authorize(input, 'author');
      const draft = await store.getDraft({
        policyId: input.policyId,
        draftId: input.draftId,
        scope: context.scope,
        actor: context.actor
      });
      return normalizedVersionInput({
        document: draft.document,
        approvalPolicy: {
          requiredApprovals: draft.requiredApprovals,
          disallowAuthorApproval: draft.disallowAuthorApproval
        }
      });
    },

    async submitDraft(input = {}) {
      const context = authorize(input, 'author');
      const body = input.input && typeof input.input === 'object' ? input.input : {};
      return store.submitDraft({
        policyId: input.policyId,
        draftId: input.draftId,
        scope: context.scope,
        actor: context.actor,
        expectedRevision: body.expectedRevision,
        idempotencyKey: input.idempotencyKey
      });
    },

    async listVersions(input = {}) {
      const context = authorize(input, 'reader');
      await store.getPolicyStateInScope({ policyId: input.policyId, scope: context.scope });
      return store.listVersions({
        policyId: input.policyId,
        scope: context.scope,
        limit: input.limit
      });
    },

    async getVersion(input = {}) {
      const context = authorize(input, 'reader');
      return store.getVersionInScope({
        policyId: input.policyId,
        versionId: input.versionId,
        scope: context.scope
      });
    },

    async simulateVersion(input = {}) {
      const context = authorize(input, 'reader');
      const policy = await store.getPolicyStateInScope({
        policyId: input.policyId,
        scope: context.scope
      });
      const proposedVersion = await store.getVersionInScope({
        policyId: input.policyId,
        versionId: input.versionId,
        scope: context.scope
      });
      let baselineVersion = null;
      if (policy.activeVersionId) {
        baselineVersion = policy.activeVersionId === proposedVersion.versionId
          ? proposedVersion
          : await store.getVersionInScope({
              policyId: input.policyId,
              versionId: policy.activeVersionId,
              scope: context.scope
            });
      }
      return simulatePolicyImpact({
        scope: context.scope,
        proposedVersion,
        baselineVersion,
        request: input.input
      });
    },

    async getReviewState(input = {}) {
      const context = authorize(input, 'reader');
      return store.getReviewState({
        policyId: input.policyId,
        versionId: input.versionId,
        scope: context.scope
      });
    },

    async claimReviewer(input = {}) {
      const context = authorize(input, 'reviewer');
      assertReviewInputFields(input.input, new Set());
      return store.claimReviewer({
        policyId: input.policyId,
        versionId: input.versionId,
        scope: context.scope,
        actor: context.actor,
        authorizationEvidence: reviewerAuthorizationEvidence(context.authorization),
        idempotencyKey: input.idempotencyKey
      });
    },

    async recordReviewDecision(input = {}) {
      const context = authorize(input, 'reviewer');
      const body = assertReviewInputFields(input.input, new Set(['decision', 'rationale']));
      return store.recordReviewDecision({
        policyId: input.policyId,
        versionId: input.versionId,
        scope: context.scope,
        actor: context.actor,
        authorizationEvidence: reviewerAuthorizationEvidence(context.authorization),
        decision: body.decision,
        rationale: body.rationale,
        idempotencyKey: input.idempotencyKey
      });
    },

    async listExceptions(input = {}) {
      const context = authorize(input, 'reader');
      return store.listExceptions({
        policyId: input.policyId,
        versionId: input.versionId,
        scope: context.scope,
        limit: input.limit
      });
    },

    async getException(input = {}) {
      const context = authorize(input, 'reader');
      return store.getException({ exceptionId: input.exceptionId, scope: context.scope });
    },

    async createException(input = {}) {
      const context = authorize(input, 'author');
      const body = assertExceptionInputFields(input.input, new Set(['kind', 'action', 'ruleIds', 'target', 'reason', 'expiresAt']));
      return store.createExceptionRequest({
        policyId: input.policyId,
        versionId: input.versionId,
        scope: context.scope,
        actor: context.actor,
        authorizationEvidence: exceptionAuthorizationEvidence(context.authorization),
        request: body,
        idempotencyKey: input.idempotencyKey
      });
    },

    async decideException(input = {}) {
      const context = authorize(input, 'administrator');
      const body = assertExceptionInputFields(input.input, new Set(['decision', 'reason']));
      return store.decideException({
        exceptionId: input.exceptionId,
        scope: context.scope,
        actor: context.actor,
        authorizationEvidence: exceptionAuthorizationEvidence(context.authorization),
        decision: body.decision,
        reason: body.reason,
        idempotencyKey: input.idempotencyKey
      });
    },

    async revokeException(input = {}) {
      const context = authorize(input, 'administrator');
      const body = assertExceptionInputFields(input.input, new Set(['reason']));
      return store.revokeException({
        exceptionId: input.exceptionId,
        scope: context.scope,
        actor: context.actor,
        authorizationEvidence: exceptionAuthorizationEvidence(context.authorization),
        reason: body.reason,
        idempotencyKey: input.idempotencyKey
      });
    },

    async activateVersion(input = {}) {
      const context = authorize(input, 'activator');
      const body = assertActivationInput(input.input);
      const idempotencyKey = assertRequiredIdempotencyKey(input.idempotencyKey);
      const policy = await store.getPolicyStateInScope({ policyId: input.policyId, scope: context.scope });
      const proposedVersion = await store.getVersionInScope({ policyId: input.policyId, versionId: input.versionId, scope: context.scope });
      const baselineVersion = policy.activeVersionId
        ? (policy.activeVersionId === proposedVersion.versionId ? proposedVersion : await store.getVersionInScope({ policyId: input.policyId, versionId: policy.activeVersionId, scope: context.scope }))
        : null;
      const simulationEvidence = simulatePolicyImpact({ scope: context.scope, proposedVersion, baselineVersion, request: body.simulationRequest });
      if (simulationEvidence.simulationHash !== body.simulationHash) {
        fail('Simulation evidence does not match the current policy state', 'GOVERNANCE_SIMULATION_MISMATCH', 409);
      }
      if (!simulationEvidence.activationReadiness.eligible) {
        const error = new GovernanceApiError('Simulation evidence contains activation blockers', 'GOVERNANCE_SIMULATION_BLOCKED', 409);
        error.details = { blockers: simulationEvidence.activationReadiness.blockers };
        throw error;
      }
      return store.activateVersion({
        policyId: input.policyId,
        versionId: input.versionId,
        scope: context.scope,
        actor: context.actor,
        authorizationEvidence: activatorAuthorizationEvidence(context.authorization),
        expectedRevision: body.expectedRevision,
        reason: body.reason,
        expectedSimulationHash: body.simulationHash,
        simulationEvidence,
        idempotencyKey
      });
    },

    async rollbackVersion(input = {}) {
      const context = authorize(input, 'activator');
      const body = assertActivationInput(input.input);
      const idempotencyKey = assertRequiredIdempotencyKey(input.idempotencyKey);
      const policy = await store.getPolicyStateInScope({ policyId: input.policyId, scope: context.scope });
      const proposedVersion = await store.getVersionInScope({ policyId: input.policyId, versionId: input.versionId, scope: context.scope });
      const baselineVersion = policy.activeVersionId
        ? (policy.activeVersionId === proposedVersion.versionId ? proposedVersion : await store.getVersionInScope({ policyId: input.policyId, versionId: policy.activeVersionId, scope: context.scope }))
        : null;
      const simulationEvidence = simulatePolicyImpact({ scope: context.scope, proposedVersion, baselineVersion, request: body.simulationRequest });
      if (simulationEvidence.simulationHash !== body.simulationHash) {
        fail('Simulation evidence does not match the current policy state', 'GOVERNANCE_SIMULATION_MISMATCH', 409);
      }
      if (!simulationEvidence.activationReadiness.eligible) {
        const error = new GovernanceApiError('Simulation evidence contains activation blockers', 'GOVERNANCE_SIMULATION_BLOCKED', 409);
        error.details = { blockers: simulationEvidence.activationReadiness.blockers };
        throw error;
      }
      return store.rollbackVersion({
        policyId: input.policyId,
        versionId: input.versionId,
        scope: context.scope,
        actor: context.actor,
        authorizationEvidence: activatorAuthorizationEvidence(context.authorization),
        expectedRevision: body.expectedRevision,
        reason: body.reason,
        expectedSimulationHash: body.simulationHash,
        simulationEvidence,
        idempotencyKey
      });
    },

    async listActivationHistory(input = {}) {
      const context = authorize(input, 'reader');
      return store.listActivationHistory({ policyId: input.policyId, scope: context.scope, limit: input.limit });
    }
  });
}

module.exports = Object.freeze({
  GovernanceApiError,
  assertGovernanceAuthorization,
  createGovernanceApiService
});
