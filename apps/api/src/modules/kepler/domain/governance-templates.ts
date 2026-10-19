import { createHash } from 'node:crypto';
import {
  normalizePolicyScope,
  normalizePolicyDocument,
  normalizeApprovalPolicy,
  policyDocumentHash
} from './governance-model.ts';
import { stableJson } from '../../../../../../packages/contracts/src/canonical-json.ts';
import type { ApprovalPolicy, PolicyDocument } from './governance-model.ts';
import type { RepositoryScope } from '../../../../../../packages/contracts/src/scope.ts';
import { expandProtectedPaths } from '../../../platform/mutation-gateway/protected-paths.ts';

type Fields = Readonly<Record<string, unknown>>;

const TEMPLATE_CATALOG_ID = 'nebulaverse-policy-template-catalog';
const TEMPLATE_CATALOG_VERSION = '1.3.0';
const MAX_FACTS_BYTES = 16 * 1024;
const MAX_PROTECTED_BRANCHES = 50;
const SAFE_BRANCH_RX = /^[A-Za-z0-9._/-]{1,255}$/;
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SENSITIVE_RX = /(?:token|secret|password|privatekey|authorization|cookie)/i;
const SENSITIVE_VALUE_RX = /(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----)/i;

/* Set only when the refusal carries details of its own, so it is typed here rather than declared as a field that would always exist. */
export interface GovernanceTemplateError {
  readonly details?: unknown;
}

export class GovernanceTemplateError extends Error {
  override readonly name = 'GovernanceTemplateError';
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status = 400, details: unknown = undefined) {
    super(message);
    this.code = code;
    this.status = status;
    if (details !== undefined) (this as { details?: unknown }).details = details;
  }
}

function fail(message: string, code: string, status = 400, details: unknown = undefined): never {
  throw new GovernanceTemplateError(message, code, status, details);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

/* A detached copy of catalogue data, which is JSON throughout. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : stableJson(value), 'utf8').digest('hex');
}

function normalizeBranch(value: unknown, label: string): string {
  const text = String(value == null ? '' : value).trim().replace(/^refs\/heads\//, '');
  if (!text || !SAFE_BRANCH_RX.test(text) || SENSITIVE_VALUE_RX.test(text) || text.includes('..') || text.startsWith('/') || text.endsWith('/')) {
    fail(`${label} is invalid`, 'GOVERNANCE_BASELINE_FACTS_INVALID');
  }
  return text;
}

/* What the server resolved about a repository, and how complete that is. */
export interface RepositoryFacts {
  readonly schemaVersion: 1;
  readonly defaultBranch: string | null;
  readonly protectedBranches: readonly string[];
  readonly pullRequestsEnabled: boolean | null;
  readonly visibility: string | null;
  readonly archived: boolean;
  readonly branchesComplete: boolean;
  readonly protectedBranchesTruncated: boolean;
  readonly resolvedForScopeKey: string;
}

export function normalizeRepositoryFacts(input: unknown, scope: RepositoryScope): RepositoryFacts {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('Repository facts are required', 'GOVERNANCE_BASELINE_FACTS_INVALID');
  }
  const proto: unknown = Object.getPrototypeOf(input);
  if (proto !== Object.prototype && proto !== null) fail('Repository facts must be a plain JSON object', 'GOVERNANCE_BASELINE_FACTS_INVALID');
  const fields = input as Fields;
  const allowed = new Set(['schemaVersion', 'defaultBranch', 'protectedBranches', 'pullRequestsEnabled', 'visibility', 'archived', 'branchesComplete', 'protectedBranchesTruncated', 'resolvedForScopeKey']);
  for (const key of Object.keys(fields)) {
    if (DANGEROUS_KEYS.has(key.toLowerCase()) || SENSITIVE_RX.test(key) || !allowed.has(key)) {
      fail('Repository facts contain an unsupported or sensitive field', 'GOVERNANCE_BASELINE_FACTS_INVALID');
    }
    const value = fields[key];
    if (typeof value === 'string' && SENSITIVE_VALUE_RX.test(value)) {
      fail('Repository facts appear to contain credential material', 'GOVERNANCE_BASELINE_FACTS_INVALID');
    }
  }
  if (Number(fields.schemaVersion) !== 1) fail('Only repository facts schema version 1 is supported', 'GOVERNANCE_BASELINE_FACTS_INVALID');
  const defaultBranch = fields.defaultBranch == null || fields.defaultBranch === '' ? null : normalizeBranch(fields.defaultBranch, 'Default branch');
  if (fields.protectedBranches != null && !Array.isArray(fields.protectedBranches)) {
    fail('Protected branches must be an array', 'GOVERNANCE_BASELINE_FACTS_INVALID');
  }
  const listed = (fields.protectedBranches || []) as readonly unknown[];
  if (listed.length > MAX_PROTECTED_BRANCHES) fail('Too many protected branches', 'GOVERNANCE_BASELINE_FACTS_INVALID');
  const protectedBranches = [...new Set(listed.map(value => normalizeBranch(value, 'Protected branch')))].sort();
  const pullRequestsEnabled = fields.pullRequestsEnabled == null ? null : fields.pullRequestsEnabled;
  if (pullRequestsEnabled !== null && typeof pullRequestsEnabled !== 'boolean') fail('Pull request capability is invalid', 'GOVERNANCE_BASELINE_FACTS_INVALID');
  const visibility = fields.visibility == null ? null : String(fields.visibility).trim().toLowerCase();
  if (visibility !== null && !['private', 'internal', 'public', 'unknown'].includes(visibility)) fail('Repository visibility is invalid', 'GOVERNANCE_BASELINE_FACTS_INVALID');
  const archived = fields.archived == null ? false : fields.archived;
  if (typeof archived !== 'boolean') fail('Repository archived state is invalid', 'GOVERNANCE_BASELINE_FACTS_INVALID');
  const branchesComplete = fields.branchesComplete == null ? false : fields.branchesComplete;
  const protectedBranchesTruncated = fields.protectedBranchesTruncated == null ? false : fields.protectedBranchesTruncated;
  if (typeof branchesComplete !== 'boolean' || typeof protectedBranchesTruncated !== 'boolean') fail('Repository branch fact completeness is invalid', 'GOVERNANCE_BASELINE_FACTS_INVALID');
  const resolvedForScopeKey = fields.resolvedForScopeKey == null ? scope.scopeKey : String(fields.resolvedForScopeKey).trim();
  if (resolvedForScopeKey !== scope.scopeKey) fail('Repository facts do not match the requested scope', 'GOVERNANCE_BASELINE_SCOPE_MISMATCH', 409);
  const facts: RepositoryFacts = { schemaVersion: 1, defaultBranch, protectedBranches, pullRequestsEnabled, visibility, archived, branchesComplete, protectedBranchesTruncated, resolvedForScopeKey };
  if (Buffer.byteLength(stableJson(facts), 'utf8') > MAX_FACTS_BYTES) fail('Repository facts exceed the configured limit', 'GOVERNANCE_BASELINE_FACTS_TOO_LARGE', 413);
  return deepFreeze(facts);
}

/* A template: what it is called, how many must approve it, and the document it builds from a repository's facts. */
interface TemplateDefinition {
  readonly templateId: string;
  readonly version: string;
  readonly name: string;
  readonly description: string;
  readonly approvalPolicy: ApprovalPolicy;
  buildDocument(facts: RepositoryFacts): Readonly<Record<string, unknown>>;
}

/*
 * The paths whose contents decide what the repository is allowed to do to
 * itself. Each one is here because changing it changes an enforcement decision
 * somewhere else, not because it is merely important.
 */
const DEFAULT_PROTECTED_PATHS: readonly { readonly pattern: string; readonly effect: string }[] = Object.freeze([
  Object.freeze({ pattern: '.github/workflows/**', effect: 'deny' }),
  Object.freeze({ pattern: '.github/actions/**', effect: 'deny' }),
  Object.freeze({ pattern: '.github/CODEOWNERS', effect: 'deny' }),
  Object.freeze({ pattern: 'CODEOWNERS', effect: 'deny' }),
  Object.freeze({ pattern: 'docs/CODEOWNERS', effect: 'deny' }),
  Object.freeze({ pattern: '.github/dependabot.yml', effect: 'deny' }),
  Object.freeze({ pattern: '.gitattributes', effect: 'deny' })
]);

function reviewDeclarations(defaultBranch: string): { pattern: string; effect: string; branch: string }[] {
  return DEFAULT_PROTECTED_PATHS.map(entry => ({
    pattern: entry.pattern,
    effect: 'require-approval',
    branch: defaultBranch
  }));
}

function protectedPathsDescription(expansion: ReturnType<typeof expandProtectedPaths>): string {
  const patterns = expansion.coverage.map(entry => entry.pattern).join(', ');
  const ancestors = [...new Set(expansion.coverage.flatMap(entry => entry.ancestorPaths))].sort();
  const wholeGuards = [...new Set(expansion.coverage.flatMap(entry => entry.wholeActionGuards))].sort();
  return [
    `Protected sensitive paths: ${patterns}.`,
    'Every action that can change a repository path is covered, including renames, batches, directory moves and restores from history.',
    ancestors.length
      ? `Moving ${ancestors.join(', ')} as a directory is covered too, because a protected file travels with the directory holding it.`
      : '',
    wholeGuards.length
      ? `${wholeGuards.join(', ')} are covered as whole actions: they can change any path, so they cannot be narrowed to one.`
      : '',
    'Generated in observe mode: decisions are recorded and nothing is blocked until this policy is activated in warn or block mode.'
  ].filter(Boolean).join(' ');
}

const DEFINITIONS: readonly TemplateDefinition[] = Object.freeze([
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
    buildDocument(facts: RepositoryFacts) {
      const rules: Record<string, unknown>[] = [
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
    templateId: 'protected-paths', version: '1.0.0',
    name: 'Protected sensitive paths',
    description: 'Observe-only protection for the paths that decide what the repository can do to itself, covering every action that can change a path.',
    approvalPolicy: Object.freeze({ requiredApprovals: 2, disallowAuthorApproval: true }),
    buildDocument() {
      const expansion = expandProtectedPaths(DEFAULT_PROTECTED_PATHS);
      return {
        schemaVersion: 1,
        description: protectedPathsDescription(expansion),
        enforcement: { mode: 'observe' },
        rules: expansion.rules
      };
    }
  }),
  Object.freeze({
    templateId: 'protected-paths-review', version: '1.0.0',
    name: 'Protected sensitive paths (review required)',
    description: 'Observe-only review requirement for sensitive paths on the default branch, leaving the change a route to a pull request.',
    approvalPolicy: Object.freeze({ requiredApprovals: 2, disallowAuthorApproval: true }),
    buildDocument(facts: RepositoryFacts) {
      const defaultBranch = facts && facts.defaultBranch ? String(facts.defaultBranch) : '';
      /*
       * Merging has to be held as well. The point of this posture is that a
       * change to a sensitive path reaches the default branch through review,
       * and a pull request anyone can merge themselves is not review. Without
       * this rule the route out of a refusal would walk straight around the
       * refusal.
       */
      const mergeRule = {
        id: 'pull-merge-approval',
        action: 'pull.merge',
        effect: 'require-approval',
        description: 'Merging into a protected branch needs approval, so a pull request cannot approve itself.'
      };
      if (!defaultBranch) {
        /*
         * Without a resolved default branch the scope cannot be expressed. An
         * unscoped requirement would hold the same paths on every branch, which
         * reads like stronger protection and quietly removes the route to
         * review, so the paths are left out and the baseline reports itself
         * incomplete instead.
         */
        return {
          schemaVersion: 1,
          description: 'Sensitive-path review baseline. The default branch could not be resolved, so no path rules were generated; only merges are held for approval.',
          enforcement: { mode: 'observe' },
          rules: [mergeRule]
        };
      }
      const expansion = expandProtectedPaths(reviewDeclarations(defaultBranch));
      return {
        schemaVersion: 1,
        description: `${protectedPathsDescription(expansion)} Merging into ${defaultBranch} needs approval too, so the pull request this leaves open cannot approve itself.`,
        enforcement: { mode: 'observe' },
        rules: [...expansion.rules, mergeRule]
      };
    }
  }),
  /*
   * Merging held to the audit of what merges. Every governed merge carries
   * what the merging person's latest audit of the pull request's head says
   * (src/code-audit-triage.js): whether it is of the commit being merged,
   * and what is still open there after the team's decisions. A head with an
   * open confirmed critical, a credential, a vulnerability being exploited
   * in something that ships, or a finding past the base branch's clock is
   * not merged; a head nobody has audited at this commit needs approval.
   * Serious findings and ones the change introduces are named by the gate
   * too, for a stricter policy to add.
   */
  Object.freeze({
    templateId: 'audit-merge-gate', version: '1.0.0',
    name: 'Audit merge gate',
    description: 'Observe-only gate on merges: refuse a head whose audit has open criticals, credentials, exploited vulnerabilities or overdue findings, and hold a head that was not audited at the commit being merged.',
    approvalPolicy: Object.freeze({ requiredApprovals: 1, disallowAuthorApproval: true }),
    buildDocument() {
      return {
        schemaVersion: 1,
        description: 'Merges are judged by the Uranus audit of the commit being merged, after the team\u2019s triage, against the base branch\u2019s clock. Generated in observe mode: decisions are recorded and nothing is blocked until this policy is activated in warn or block mode.',
        enforcement: { mode: 'observe' },
        rules: [
          {
            id: 'audit-gate-findings',
            action: 'pull.merge',
            effect: 'deny',
            conditions: { audit: { state: 'current', blocking: ['critical', 'secret', 'exploited', 'overdue'] } },
            description: 'The audit of this head has an open confirmed critical, a credential, a vulnerability exploited in the wild, or a finding past its deadline.'
          },
          {
            id: 'audit-gate-unaudited',
            action: 'pull.merge',
            effect: 'require-approval',
            conditions: { audit: { state: ['missing', 'stale', 'unavailable'] } },
            description: 'Nobody merging has audited this head at the commit being merged.'
          }
        ]
      };
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

export interface TemplateSummary {
  readonly templateId: string;
  readonly version: string;
  readonly name: string;
  readonly description: string;
  readonly approvalPolicy: ApprovalPolicy;
  readonly compatibility: { readonly policySchemaVersions: readonly number[]; readonly providers: readonly string[]; readonly generatorVersion: number };
  readonly templateHash: string;
}

const GENERIC_FACTS: RepositoryFacts = Object.freeze({ schemaVersion: 1, defaultBranch: null, protectedBranches: [], pullRequestsEnabled: null, visibility: null, archived: false, branchesComplete: false, protectedBranchesTruncated: false, resolvedForScopeKey: 'template:generic' });

const PUBLIC_TEMPLATES: readonly TemplateSummary[] = DEFINITIONS.map(definition => {
  const document = normalizePolicyDocument(definition.buildDocument(GENERIC_FACTS));
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
    compatibility: { policySchemaVersions: [1], providers: ['github'], generatorVersion: 1 },
    templateHash
  });
});

export interface TemplateCatalog {
  readonly catalogId: string;
  readonly version: string;
  readonly templateCount: number;
  readonly catalogHash: string;
}

export const TEMPLATE_CATALOG: TemplateCatalog = deepFreeze({
  catalogId: TEMPLATE_CATALOG_ID,
  version: TEMPLATE_CATALOG_VERSION,
  templateCount: PUBLIC_TEMPLATES.length,
  catalogHash: sha256(PUBLIC_TEMPLATES)
});

function definitionOf(templateId: unknown): TemplateDefinition {
  const id = String(templateId || '').trim().toLowerCase();
  const definition = DEFINITIONS.find(item => item.templateId === id);
  if (!definition) fail('Policy template was not found', 'GOVERNANCE_TEMPLATE_NOT_FOUND', 404);
  return definition;
}

/* Every definition has its summary, built from the same list. */
function summaryOf(definition: TemplateDefinition): TemplateSummary {
  const summary = PUBLIC_TEMPLATES.find(item => item.templateId === definition.templateId);
  if (!summary) throw new TypeError(`Policy template ${definition.templateId} has no catalogue summary`);
  return summary;
}

export function listPolicyTemplates(): readonly TemplateSummary[] {
  return deepFreeze(PUBLIC_TEMPLATES.map(item => clone(item)).sort((a, b) => a.templateId.localeCompare(b.templateId)));
}

export interface PolicyTemplate extends TemplateSummary {
  readonly catalog: TemplateCatalog;
  readonly document: PolicyDocument;
}

export function getPolicyTemplate(templateId: unknown): PolicyTemplate {
  const definition = definitionOf(templateId);
  const summary = summaryOf(definition);
  const document = normalizePolicyDocument(definition.buildDocument(GENERIC_FACTS));
  return deepFreeze({ ...clone(summary), catalog: clone(TEMPLATE_CATALOG), document });
}

export interface RepositoryBaseline {
  readonly schemaVersion: 1;
  readonly scope: RepositoryScope;
  readonly document: PolicyDocument;
  readonly documentHash: string;
  readonly approvalPolicy: ApprovalPolicy;
  readonly provenance: {
    readonly schemaVersion: 1;
    readonly catalogId: string;
    readonly catalogVersion: string;
    readonly catalogHash: string;
    readonly templateId: string;
    readonly templateVersion: string;
    readonly templateHash: string;
    readonly factsSource: 'server-resolved';
    readonly factsHash: string;
    readonly scopeHash: string;
  };
  readonly readiness: { readonly status: 'partial' | 'ready'; readonly warnings: readonly string[] };
  readonly baselineHash: string;
}

export function generateRepositoryBaseline(input: unknown = {}): RepositoryBaseline {
  const fields = input as Fields;
  const scope = normalizePolicyScope(fields.scope);
  const definition = definitionOf(fields.templateId);
  const facts = normalizeRepositoryFacts(fields.facts, scope);
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
    schemaVersion: 1 as const,
    catalogId: TEMPLATE_CATALOG.catalogId,
    catalogVersion: TEMPLATE_CATALOG.version,
    catalogHash: TEMPLATE_CATALOG.catalogHash,
    templateId: definition.templateId,
    templateVersion: definition.version,
    templateHash: summaryOf(definition).templateHash,
    factsSource: 'server-resolved' as const,
    factsHash: sha256(facts),
    scopeHash: sha256(scope)
  };
  const warnings: string[] = [];
  if (['protected-default-branch', 'protected-paths-review'].includes(definition.templateId) && !facts.defaultBranch) warnings.push('default-branch-unresolved');
  if (!facts.branchesComplete) warnings.push('branch-facts-incomplete');
  if (facts.protectedBranchesTruncated) warnings.push('protected-branches-truncated');
  if (facts.archived) warnings.push('repository-archived');
  const readiness = { status: warnings.length ? 'partial' as const : 'ready' as const, warnings };
  const baselineHash = sha256({ scope, documentHash, approvalPolicy, provenance, readiness });
  return deepFreeze({ schemaVersion: 1, scope, document, documentHash, approvalPolicy, provenance, readiness, baselineHash });
}
