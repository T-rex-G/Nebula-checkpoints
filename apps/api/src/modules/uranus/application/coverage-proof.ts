import { createHash } from 'node:crypto';
import { AUDIT_COVERAGE_PROOF_CONTRACT_VERSION, type AuditCoverageProof, type AuditCoverageStatement } from '../../../../../../packages/contracts/src/audit-coverage-proof.ts';
import { stableJson } from '../../../../../../packages/contracts/src/canonical-json.ts';
import { isPlainObject } from '../../../../../../packages/contracts/src/guards.ts';
import { COMMIT_SHA, MUTATION_ID, SHA256_HEX } from '../../../../../../packages/contracts/src/ids.ts';
import { normalizePolicyScope } from '../../../../../../packages/contracts/src/scope.ts';
import type { KeptAudit } from '../persistence/audit-history-records.ts';
import { completeAudit } from './kept-coverage.ts';

const hash = (value: unknown): string => createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
const scopeDigest = (scope: unknown): string => hash(['uranus.repository-scope.v1', normalizePolicyScope(scope).scopeKey]);
const matches = (value: unknown, pattern: RegExp): value is string => typeof value === 'string' && pattern.test(value);
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  isPlainObject(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

function instant(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 24) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

/* Validate each scalar before canonicalising. Source text, paths, row details and arbitrary extension fields cannot enter the statement. */
function validStatement(value: unknown): value is AuditCoverageStatement {
  if (!exact(value, ['kind', 'version', 'scopeDigest', 'auditId', 'commitSha', 'engine', 'ruleset', 'auditedAt', 'analysisComplete', 'files', 'findings', 'watch'])) return false;
  const { files, findings, watch } = value;
  return value.kind === 'uranus.kept-audit-coverage' && value.version === AUDIT_COVERAGE_PROOF_CONTRACT_VERSION
    && matches(value.scopeDigest, SHA256_HEX) && matches(value.auditId, MUTATION_ID) && matches(value.commitSha, COMMIT_SHA)
    && matches(value.engine, /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$/) && (value.ruleset === null || matches(value.ruleset, SHA256_HEX))
    && instant(value.auditedAt) && (value.analysisComplete === null || typeof value.analysisComplete === 'boolean')
    && exact(files, ['complete', 'read', 'eligible']) && typeof files.complete === 'boolean'
    && count(files.read) && count(files.eligible) && files.read <= files.eligible && (!files.complete || files.eligible === files.read)
    && exact(findings, ['stored', 'total']) && count(findings.stored) && count(findings.total) && findings.stored <= findings.total
    && (watch === null || (exact(watch, ['state', 'checkedAt']) && instant(watch.checkedAt) && (watch.state === 'ok' || watch.state === 'partial' || watch.state === 'unavailable')));
}

function decide(statement: AuditCoverageStatement): AuditCoverageProof['decision'] {
  if (statement.ruleset === null || statement.analysisComplete === null) return 'unrecorded';
  return completeAudit(statement) ? 'complete' : 'incomplete';
}

export function createCoverageProof(scope: unknown, audit: KeptAudit): AuditCoverageProof {
  const statement = {
    kind: 'uranus.kept-audit-coverage', version: AUDIT_COVERAGE_PROOF_CONTRACT_VERSION,
    scopeDigest: scopeDigest(scope), auditId: audit.id, commitSha: audit.commitSha, engine: audit.engine,
    ruleset: audit.ruleset, auditedAt: audit.auditedAt, analysisComplete: audit.analysisComplete,
    files: { read: audit.files.read, eligible: audit.files.eligible, complete: audit.files.complete },
    findings: { stored: audit.findings.stored, total: audit.findings.total },
    watch: audit.watch ? { checkedAt: audit.watch.checkedAt, state: audit.watch.state } : null
  };
  if (!validStatement(statement)) throw Object.assign(new Error('Stored audit evidence is invalid'), { code: 'CODE_AUDIT_ROW_INVALID', status: 500 });
  const body = { statement, decision: decide(statement) };
  return { ...body, digest: hash(body) };
}

/* The caller supplies independently retained expectations. A successful verification establishes the recorded coverage decision for these inputs. */
export function verifyCoverageProof(proof: unknown, expected: unknown) {
  if (!exact(proof, ['statement', 'decision', 'digest']) || !validStatement(proof.statement) || !matches(proof.digest, SHA256_HEX)) return 'invalid-proof';
  const { statement } = proof;
  if (proof.decision !== decide(statement) || hash({ statement, decision: proof.decision }) !== proof.digest) return 'invalid-proof';
  if (!exact(expected, ['scope', 'commitSha', 'ruleset', 'digest']) || !matches(expected.digest, SHA256_HEX)
    || !matches(expected.commitSha, COMMIT_SHA) || !matches(expected.ruleset, SHA256_HEX)) return 'invalid-expectations';
  if (proof.digest !== expected.digest) return 'untrusted-digest';
  let repository;
  try { repository = scopeDigest(expected.scope); } catch { return 'invalid-expectations'; }
  if (repository !== statement.scopeDigest || statement.commitSha !== expected.commitSha || (statement.ruleset !== null && statement.ruleset !== expected.ruleset)) return 'target-mismatch';
  return decide(statement);
}
