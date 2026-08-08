'use strict';

const crypto = require('crypto');
const {
  GovernanceError,
  normalizePolicyScope,
  normalizePolicyDocument,
  normalizeApprovalPolicy,
  policyDocumentHash,
  stableJson
} = require('./governance-model');

const TEMPLATE_CATALOG_ID = 'nebulaverse-policy-template-catalog';
const TEMPLATE_CATALOG_VERSION = '1.0.0';
const MAX_FACTS_BYTES = 16 * 1024;
const MAX_PROTECTED_BRANCHES = 50;
const SAFE_BRANCH_RX = /^[A-Za-z0-9._\/-]{1,255}$/;
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SENSITIVE_RX = /(?:token|secret|password|privatekey|authorization|cookie)/i;
const SENSITIVE_VALUE_RX = /(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----)/i;

class GovernanceTemplateError extends Error {
  constructor(message, code, status = 400, details) {
    super(message);
    this.name = 'GovernanceTemplateError';
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

function fail(message, code, status = 400, details) {
  throw new GovernanceTemplateError(message, code, status, details);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : stableJson(value), 'utf8').digest('hex');
}

function normalizeBranch(value, label) {
  const text = String(value == null ? '' : value).trim().replace(/^refs\/heads\//, '');
  if (!text || !SAFE_BRANCH_RX.test(text) || SENSITIVE_VALUE_RX.test(text) || text.includes('..') || text.startsWith('/') || text.endsWith('/')) {
    fail(`${label} is invalid`, 'GOVERNANCE_BASELINE_FACTS_INVALID');
  }
  return text;
}

function normalizeRepositoryFacts(input, scope) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('Repository facts are required', 'GOVERNANCE_BASELINE_FACTS_INVALID');
  }
  const proto = Object.getPrototypeOf(input);
  if (proto !== Object.prototype && proto !== null) fail('Repository facts must be a plain JSON object', 'GOVERNANCE_BASELINE_FACTS_INVALID');
  const allowed = new Set(['schemaVersion', 'defaultBranch', 'protectedBranches', 'pullRequestsEnabled', 'visibility', 'archived', 'branchesComplete', 'protectedBranchesTruncated', 'resolvedForScopeKey']);
  for (const key of Object.keys(input)) {
    if (DANGEROUS_KEYS.has(key.toLowerCase()) || SENSITIVE_RX.test(key) || !allowed.has(key)) {
      fail('Repository facts contain an unsupported or sensitive field', 'GOVERNANCE_BASELINE_FACTS_INVALID');
    }
    if (typeof input[key] === 'string' && SENSITIVE_VALUE_RX.test(input[key])) {
      fail('Repository facts appear to contain credential material', 'GOVERNANCE_BASELINE_FACTS_INVALID');
    }
  }
  if (Number(input.schemaVersion) !== 1) fail('Only repository facts schema version 1 is supported', 'GOVERNANCE_BASELINE_FACTS_INVALID');
  const defaultBranch = input.defaultBranch == null || input.defaultBranch === '' ? null : normalizeBranch(input.defaultBranch, 'Default branch');
  if (input.protectedBranches != null && !Array.isArray(input.protectedBranches)) {
    fail('Protected branches must be an array', 'GOVERNANCE_BASELINE_FACTS_INVALID');
  }
  if ((input.protectedBranches || []).length > MAX_PROTECTED_BRANCHES) fail('Too many protected branches', 'GOVERNANCE_BASELINE_FACTS_INVALID');
  const protectedBranches = [...new Set((input.protectedBranches || []).map(value => normalizeBranch(value, 'Protected branch')))].sort();
  const pullRequestsEnabled = input.pullRequestsEnabled == null ? null : input.pullRequestsEnabled;
  if (pullRequestsEnabled !== null && typeof pullRequestsEnabled !== 'boolean') fail('Pull request capability is invalid', 'GOVERNANCE_BASELINE_FACTS_INVALID');
  const visibility = input.visibility == null ? null : String(input.visibility).trim().toLowerCase();
  if (visibility !== null && !['private', 'internal', 'public', 'unknown'].includes(visibility)) fail('Repository visibility is invalid', 'GOVERNANCE_BASELINE_FACTS_INVALID');
  const archived = input.archived == null ? false : input.archived;
  if (typeof archived !== 'boolean') fail('Repository archived state is invalid', 'GOVERNANCE_BASELINE_FACTS_INVALID');
  const branchesComplete = input.branchesComplete == null ? false : input.branchesComplete;
  const protectedBranchesTruncated = input.protectedBranchesTruncated == null ? false : input.protectedBranchesTruncated;
  if (typeof branchesComplete !== 'boolean' || typeof protectedBranchesTruncated !== 'boolean') fail('Repository branch fact completeness is invalid', 'GOVERNANCE_BASELINE_FACTS_INVALID');
  const resolvedForScopeKey = input.resolvedForScopeKey == null ? scope.scopeKey : String(input.resolvedForScopeKey).trim();
  if (resolvedForScopeKey !== scope.scopeKey) fail('Repository facts do not match the requested scope', 'GOVERNANCE_BASELINE_SCOPE_MISMATCH', 409);
  const facts = { schemaVersion: 1, defaultBranch, protectedBranches, pullRequestsEnabled, visibility, archived, branchesComplete, protectedBranchesTruncated, resolvedForScopeKey };
  if (Buffer.byteLength(stableJson(facts), 'utf8') > MAX_FACTS_BYTES) fail('Repository facts exceed the configured limit', 'GOVERNANCE_BASELINE_FACTS_TOO_LARGE', 413);
  return deepFreeze(facts);
}

const DEFINITIONS = Object.freeze([
  Object.freeze({
    templateId: 'observe-baseline', version: '1.0.0',
    name: 'Observe-only baseline',
    description: 'A non-blocking starting point that records governance decisions without restrictive rules.',
    approvalPolicy: Object.freeze({ requiredApprovals: 1, disallowAuthorApproval: true }),
    buildDocument() {
      return { schemaVersion: 1, description: 'Observe-only repository governance baseline.', enforcement: { mode: 'observe' }, rules: [] };
    }
  }),
  Object.freeze({
    templateId: 'protected-default-branch', version: '1.0.0',
    name: 'Protected default branch',
    description: 'Observe-only safeguards for destructive repository and default-branch operations.',
    approvalPolicy: Object.freeze({ requiredApprovals: 1, disallowAuthorApproval: true }),
    buildDocument(facts) {
      const rules = [
        { id: 'repository-delete', action: 'repository.delete', effect: 'deny', description: 'Protect repository deletion.' }
      ];
      const protectedBranches = [...new Set([...(facts.protectedBranches || []), ...(facts.defaultBranch ? [facts.defaultBranch] : [])])].sort();
      for (const branch of protectedBranches) {
        const suffix = sha256(branch).slice(0, 12);
        rules.push(
          { id: `protected-branch-${suffix}-delete`, action: 'branch.delete', effect: 'deny', conditions: { branch }, description: `Protect deletion of branch ${branch}.` },
          { id: `protected-branch-${suffix}-reset`, action: 'branch.reset', effect: 'deny', conditions: { branch }, description: `Protect destructive resets of branch ${branch}.` }
        );
      }
      if (facts.pullRequestsEnabled !== false) {
        rules.push({ id: 'pull-merge-approval', action: 'pull.merge', effect: 'require-approval', description: 'Require approval evidence for pull-request merges.' });
      }
      return { schemaVersion: 1, description: 'Repository-specific protected-branch baseline.', enforcement: { mode: 'observe' }, rules };
    }
  }),
  Object.freeze({
    templateId: 'release-change-control', version: '1.0.0',
    name: 'Release change control',
    description: 'Observe-only approval requirements for releases and workflow reruns.',
    approvalPolicy: Object.freeze({ requiredApprovals: 2, disallowAuthorApproval: true }),
    buildDocument() {
      return {
        schemaVersion: 1,
        description: 'Release and automation change-control baseline.',
        enforcement: { mode: 'observe' },
        rules: [
          { id: 'release-create-approval', action: 'release.create', effect: 'require-approval' },
          { id: 'workflow-rerun-approval', action: 'workflow.rerun', effect: 'require-approval' },
          { id: 'repository-delete', action: 'repository.delete', effect: 'deny' }
        ]
      };
    }
  })
]);

const PUBLIC_TEMPLATES = DEFINITIONS.map(definition => {
  const genericFacts = { schemaVersion: 1, defaultBranch: null, protectedBranches: [], pullRequestsEnabled: null, visibility: null, archived: false, branchesComplete: false, protectedBranchesTruncated: false, resolvedForScopeKey: 'template:generic' };
  const document = normalizePolicyDocument(definition.buildDocument(genericFacts));
  const templateHash = sha256({
    catalogId: TEMPLATE_CATALOG_ID,
    catalogVersion: TEMPLATE_CATALOG_VERSION,
    templateId: definition.templateId,
    templateVersion: definition.version,
    document,
    approvalPolicy: normalizeApprovalPolicy(definition.approvalPolicy)
  });
  return deepFreeze({
    templateId: definition.templateId,
    version: definition.version,
    name: definition.name,
    description: definition.description,
    approvalPolicy: normalizeApprovalPolicy(definition.approvalPolicy),
    compatibility: { policySchemaVersions: [1], providers: ['github', 'gitlab', 'gitea'], generatorVersion: 1 },
    templateHash
  });
});

const TEMPLATE_CATALOG = deepFreeze({
  catalogId: TEMPLATE_CATALOG_ID,
  version: TEMPLATE_CATALOG_VERSION,
  templateCount: PUBLIC_TEMPLATES.length,
  catalogHash: sha256(PUBLIC_TEMPLATES)
});

function definitionOf(templateId) {
  const id = String(templateId || '').trim().toLowerCase();
  const definition = DEFINITIONS.find(item => item.templateId === id);
  if (!definition) fail('Policy template was not found', 'GOVERNANCE_TEMPLATE_NOT_FOUND', 404);
  return definition;
}

function listPolicyTemplates() {
  return deepFreeze(PUBLIC_TEMPLATES.map(item => clone(item)).sort((a, b) => a.templateId.localeCompare(b.templateId)));
}

function getPolicyTemplate(templateId) {
  const definition = definitionOf(templateId);
  const summary = PUBLIC_TEMPLATES.find(item => item.templateId === definition.templateId);
  const document = normalizePolicyDocument(definition.buildDocument({ schemaVersion: 1, defaultBranch: null, protectedBranches: [], pullRequestsEnabled: null, visibility: null, archived: false, branchesComplete: false, protectedBranchesTruncated: false, resolvedForScopeKey: 'template:generic' }));
  return deepFreeze({ ...clone(summary), catalog: clone(TEMPLATE_CATALOG), document });
}

function generateRepositoryBaseline(input = {}) {
  const scope = normalizePolicyScope(input.scope);
  const definition = definitionOf(input.templateId);
  const facts = normalizeRepositoryFacts(input.facts, scope);
  const document = normalizePolicyDocument({
    ...definition.buildDocument(facts),
    metadata: {
      template: {
        catalogId: TEMPLATE_CATALOG.catalogId,
        catalogVersion: TEMPLATE_CATALOG.version,
        templateId: definition.templateId,
        templateVersion: definition.version
      },
      baseline: {
        scopeKey: scope.scopeKey,
        factsHash: sha256(facts),
        factsSchemaVersion: facts.schemaVersion
      }
    }
  });
  const approvalPolicy = normalizeApprovalPolicy(definition.approvalPolicy);
  const documentHash = policyDocumentHash(document);
  const provenance = {
    schemaVersion: 1,
    catalogId: TEMPLATE_CATALOG.catalogId,
    catalogVersion: TEMPLATE_CATALOG.version,
    catalogHash: TEMPLATE_CATALOG.catalogHash,
    templateId: definition.templateId,
    templateVersion: definition.version,
    templateHash: PUBLIC_TEMPLATES.find(item => item.templateId === definition.templateId).templateHash,
    factsSource: 'server-resolved',
    factsHash: sha256(facts),
    scopeHash: sha256(scope)
  };
  const warnings = [];
  if (definition.templateId === 'protected-default-branch' && !facts.defaultBranch) warnings.push('default-branch-unresolved');
  if (!facts.branchesComplete) warnings.push('branch-facts-incomplete');
  if (facts.protectedBranchesTruncated) warnings.push('protected-branches-truncated');
  if (facts.archived) warnings.push('repository-archived');
  const readiness = { status: warnings.length ? 'partial' : 'ready', warnings };
  const baselineHash = sha256({ scope, documentHash, approvalPolicy, provenance, readiness });
  return deepFreeze({ schemaVersion: 1, scope, document, documentHash, approvalPolicy, provenance, readiness, baselineHash });
}

module.exports = Object.freeze({
  GovernanceTemplateError,
  TEMPLATE_CATALOG,
  listPolicyTemplates,
  getPolicyTemplate,
  generateRepositoryBaseline,
  normalizeRepositoryFacts
});
