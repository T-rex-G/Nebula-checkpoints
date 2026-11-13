/*
 * The code audit as a service: running one, keeping it, watching what it
 * found, the team's decisions about it, and what it says about a merge. The
 * code-audit routes (http/code-audit-routes.ts) answer from it, and the
 * governed merge, sign-out and shutdown reach it too, so the server builds it
 * once and hands it to each.
 *
 * An audit reads through the same guarded reader Exposure uses, one
 * connection pool per audit, asks the package registries through the guarded
 * transport with HEAD, and asks OSV -- anonymously, through the advisory
 * profile bound to that one host -- which of the installed versions have
 * published advisories. The analysis runs on a worker thread with a heap cap
 * and a time limit (audit-worker.ts), so the server keeps answering the
 * platform's health check while it works. One audit per identity at a time
 * (apps/api/src/platform/jobs/audit-jobs.ts): it reads up to a few hundred
 * files, and a second click resumes the first instead of doubling it.
 *
 * Audits, kept. A finished audit is recorded for the identity that ran it --
 * reduced by the audit history to what can be stored without storing the
 * repository. Without a database there is no history, and no watch.
 */
import { createAuditJobs } from '../../../platform/jobs/audit-jobs.ts';
import type { AuditJobs, JobUpdate } from '../../../platform/jobs/audit-jobs.ts';
import { PROFILES, createGuardedSession, guardedFetch } from '../../../platform/network/guarded-fetch.ts';
import type { GuardedFetchInput, GuardedResponse, GuardedSession } from '../../../platform/network/guarded-fetch.ts';
import { isPublicReaderAccess } from '../../../platform/authorization/authorization-resolver.ts';
import type { TransactionalPool } from '../../../platform/persistence/queryable.ts';
import { cleanText } from '../../../platform/values/text.ts';
import { isFields, member, read } from '../../../platform/values/fields.ts';
import { assertGovernanceAuthorization, clockOf, normalizePolicyScope } from '../../kepler/index.ts';
import { assertAuditActive } from '../domain/audit-cancellation.ts';
import { applyTriage } from '../domain/audit-triage.ts';
import type { Decision } from '../domain/audit-triage.ts';
import { exploitedInProduction } from '../domain/uranus-reach.ts';
import { auditRepository } from './audit-repository.ts';
import type { analyse } from './audit-engine.ts';
import type { Scan } from '../domain/code-audit.ts';
import type { Sla } from '../../kepler/index.ts';
import type { AuditReader } from './audit-repository.ts';
import { analyseOffThread, scanOffThread } from './audit-worker.ts';
import { createAuditWatch, watchComponents } from './audit-watch.ts';
import { evaluateMergeGate, previewMergePolicies, unavailableGate } from './merge-gate.ts';
import type { Gate } from './merge-gate.ts';
import { CodeAuditHistory } from '../persistence/audit-history-store.ts';
import { CodeAuditTriage } from '../persistence/audit-triage-store.ts';

/* What an audit run reaches past the reader: the per-audit pool, the guarded transport, and the off-thread analysis. */
export interface AuditRunPorts {
  openSession(): Pick<GuardedSession, 'request' | 'close'>;
  fetch(input: GuardedFetchInput): Promise<GuardedResponse>;
  readonly auditRepository: typeof auditRepository;
  readonly analyseOffThread: typeof analyseOffThread;
  readonly scanOffThread: typeof scanOffThread;
}

/* The real ones: one pool of eight provider-read sockets per audit, and every other request through the guarded transport. */
export const AUDIT_RUN_PORTS: AuditRunPorts = Object.freeze({
  openSession: () => createGuardedSession({ profile: PROFILES.PROVIDER_READ, maxSockets: 8 }),
  fetch: (input: GuardedFetchInput) => guardedFetch(input),
  auditRepository, analyseOffThread, scanOffThread
});

/* Where kept audits and the team's decisions are stored: the real stores over the server's pool. */
export interface CodeAuditStores {
  history(pool: TransactionalPool): CodeAuditHistory;
  triage(pool: TransactionalPool): CodeAuditTriage;
}
export const CODE_AUDIT_STORES: CodeAuditStores = Object.freeze({
  history: (pool: TransactionalPool) => new CodeAuditHistory({ pool }),
  triage: (pool: TransactionalPool) => new CodeAuditTriage({ pool })
});

export interface CodeAuditDeps {
  readonly databaseConfigured: boolean;
  pool(): TransactionalPool;
  identityKey(account: unknown): string;
  /* The provider transport, for the pull request a gate is read for. */
  gh(account: unknown, apiPath: string): Promise<unknown>;
  dbReady(): Promise<unknown>;
  /* Kepler's governance store, for the policies a merge would meet. */
  governanceStore(): { resolveActivePolicySetInScope(input: { readonly scope: unknown; readonly action: string }): Promise<{ readonly activePolicies: unknown }> };
  /* The repository's authorization, as the server's resolver reads it. */
  resolveAuthorization(input: { readonly account: unknown; readonly owner: unknown; readonly repo: unknown; readonly actorIdentityKey: unknown }): Promise<unknown>;
  /* The repository reader every audit reads through: Quasar's. */
  readonly reader: AuditReader;
  readonly ports?: AuditRunPorts;
  readonly stores?: CodeAuditStores;
}

/* A repository on the provider, as a request names it. */
export interface RepositoryTarget {
  readonly account: unknown;
  readonly owner: unknown;
  readonly repo: unknown;
}

/* A pull request's facts, as a merge gate reads them. */
export interface PullFacts {
  readonly number: number;
  readonly head: string;
  readonly base: string;
  readonly headSha: string;
  readonly fork: boolean;
  readonly open: boolean;
}

/* The team's decisions an audit is read with, or that they could not be read. */
export type AccountTriage = { readonly decisions: Map<string, Decision> } | { readonly unavailable: true } | null;

/* What a recorded audit says about its history. */
export interface RecordedHistory {
  readonly saved: boolean;
  readonly auditId?: string;
  readonly previousAt?: string | null;
  readonly newIds?: string[] | null;
  readonly resolved?: number | null;
  readonly resolutions?: number;
  readonly firstSeen?: Record<string, string>;
}

export interface RunAuditInput extends RepositoryTarget {
  readonly ref: string;
  readonly token: unknown;
  readonly onProgress: (update: JobUpdate | null | undefined) => void;
  readonly signal: AbortSignal;
}

export interface CodeAuditService {
  readonly jobs: AuditJobs<unknown>;
  history(): CodeAuditHistory | null;
  watch(): ReturnType<typeof createAuditWatch> | null;
  triage(): CodeAuditTriage | null;
  runAudit(input: RunAuditInput): Promise<Record<string, unknown>>;
  recordAudit(account: unknown, owner: unknown, repo: unknown, result: unknown, options?: { readonly signal?: AbortSignal | null }): Promise<RecordedHistory | null>;
  triageForAccount(account: unknown, owner: unknown, repo: unknown): Promise<AccountTriage>;
  readPullFacts(target: RepositoryTarget, number: number): Promise<PullFacts>;
  mergeGateFor(account: unknown, owner: unknown, repo: unknown, pull: PullFacts, now?: number): Promise<Gate>;
  gatePolicies(scope: unknown, attributes: unknown): Promise<{ readonly available: boolean; readonly policies: unknown }>;
}

/* An account's provider and address, as a policy scope names them. */
function scopeFor(account: unknown, owner: unknown, repo: unknown): ReturnType<typeof normalizePolicyScope> {
  return normalizePolicyScope({ provider: member(account, 'provider') || 'github', baseUrl: member(account, 'baseUrl') || '', owner, repo });
}

/* `value.toLowerCase()`, as JavaScript calls it: a TypeError on anything without the method. */
function lowerCase(value: unknown): unknown {
  const method: unknown = member(value, 'toLowerCase');
  if (typeof method !== 'function') throw new TypeError('toLowerCase is not a function');
  return Reflect.apply(method, value, []);
}

/*
 * What a worker posted, read as what it ran. It crosses the thread boundary by
 * structured clone from this module's own engine, so what is checked is the
 * protocol, not the engine: the parts the audit reads before it passes the
 * rest through. Anything else fails the audit, as reading those parts of it
 * would have.
 */
type Analysis = ReturnType<typeof analyse>;
function isAnalysis(value: unknown): value is Analysis {
  return isFields(value) && Array.isArray(value.components) && isFields(value.dependencyStatus) && isFields(value.advisoryStatus);
}
function isScan(value: unknown): value is Scan {
  return isFields(value) && Array.isArray(value.raw) && Array.isArray(value.packages);
}
function posted<T>(value: unknown, accept: (candidate: unknown) => candidate is T): T {
  if (!accept(value)) throw new TypeError('The audit worker answered something that is not what it was asked for');
  return value;
}

/* A branch's clocks as the audit's policy states them: days by severity. A severity it does not name draws no clock, as clockOf reads it. */
function isSla(value: unknown): value is Sla {
  return isFields(value);
}

/* A failure's code, bounded, for a warning that names what failed and nothing it carried. */
function codeOf(error: unknown): string {
  return cleanText(String((error && member(error, 'code')) || 'error'), 60);
}

/*
 * Each open finding's clock (Kepler's domain/code-audit-policy.ts): the days
 * the audited branch gives its severity, from the date the kept history first
 * saw it. A server without a history has no such date and draws no clocks,
 * rather than starting every clock again at each audit.
 */
function withClocks(result: Record<string, unknown>, firstSeen: Readonly<Record<string, string>>): Record<string, unknown> {
  const sla = result.policy && member(result.policy, 'sla');
  if (!sla || !isSla(sla) || !Array.isArray(result.findings)) return result;
  const now = Date.now();
  return {
    ...result,
    findings: result.findings.map((finding: unknown) => {
      const clock = clockOf({ severity: member(finding, 'severity'), exploited: exploitedInProduction(finding) }, { firstSeenAt: member(firstSeen, String(member(finding, 'id'))), sla, now });
      return clock ? { ...Object(finding), clock } : finding;
    })
  };
}

export function createCodeAuditService(deps: CodeAuditDeps): CodeAuditService {
  const ports = deps.ports || AUDIT_RUN_PORTS;
  const stores = deps.stores || CODE_AUDIT_STORES;
  const jobs = createAuditJobs<unknown>();
  let history: CodeAuditHistory | null = null;
  let watch: ReturnType<typeof createAuditWatch> | null = null;
  let triage: CodeAuditTriage | null = null;

  const auditHistory = (): CodeAuditHistory | null => {
    if (!deps.databaseConfigured) return null;
    if (!history) history = stores.history(deps.pool());
    return history;
  };
  const auditWatch = (): ReturnType<typeof createAuditWatch> | null => {
    const kept = auditHistory();
    if (!kept) return null;
    if (!watch) {
      watch = createAuditWatch({
        history: kept,
        check: ({ components }) => watchComponents({
          components,
          advisoryTransport: input => ports.fetch(input),
          intelTransport: input => ports.fetch(input)
        })
      });
    }
    return watch;
  };
  const auditTriage = (): CodeAuditTriage | null => {
    if (!deps.databaseConfigured) return null;
    if (!triage) triage = stores.triage(deps.pool());
    return triage;
  };

  /* A history that could not be written never fails the audit it would have recorded. */
  const recordAudit: CodeAuditService['recordAudit'] = async (account, owner, repo, result, { signal } = {}) => {
    assertAuditActive(signal);
    const kept = auditHistory();
    if (!kept) return null;
    try {
      const scope = scopeFor(account, owner, repo);
      const recorded = await kept.record({ scope, identityKey: deps.identityKey(account), result, signal });
      return {
        saved: true,
        auditId: recorded.auditId,
        previousAt: recorded.previous ? recorded.previous.auditedAt : null,
        newIds: recorded.newIds,
        resolved: recorded.resolved,
        resolutions: recorded.resolutions,
        firstSeen: recorded.firstSeen
      };
    } catch (error) {
      assertAuditActive(signal);
      if (error && member(error, 'code') === 'AUDIT_CANCELLED') throw error;
      console.warn(`[code-audit] history not recorded (${codeOf(error)})`);
      return { saved: false };
    }
  };

  /*
   * The decisions an audit is read with: a collaborator's audit carries the
   * team's, anyone else's is the engine's own. A collaborator whose decisions
   * could not be read is told so, rather than shown the findings as if nobody
   * had decided anything.
   */
  const triageForAccount: CodeAuditService['triageForAccount'] = async (account, owner, repo) => {
    const decisions = auditTriage();
    if (!decisions) return null;
    let scope: unknown;
    try {
      const authorization = await deps.resolveAuthorization({ account, owner, repo, actorIdentityKey: deps.identityKey(account) });
      const context = assertGovernanceAuthorization({
        authorization,
        scope: { provider: member(account, 'provider') || 'github', baseUrl: member(account, 'baseUrl') || '', owner, repo },
        requiredRole: 'reader'
      });
      if (isPublicReaderAccess(context.authorization)) return null;
      scope = context.scope;
    } catch {
      return null;
    }
    try {
      return { decisions: await decisions.decisions({ scope }) };
    } catch (error) {
      console.warn(`[code-audit] triage not read (${codeOf(error)})`);
      return { unavailable: true };
    }
  };

  /*
   * One audit, start to finish: read and analyse the repository, then the
   * team's decisions, so the grade and the kept history are the ones the
   * decisions make; then the clocks, which need the dates the history carries
   * for each finding. An abandoned audit stops reading: closing the pool fails
   * what is still in flight.
   */
  const runAudit: CodeAuditService['runAudit'] = async ({ account, owner, repo, ref, token, onProgress, signal }) => {
    const session = ports.openSession();
    signal.addEventListener('abort', () => session.close(), { once: true });
    try {
      const result = await ports.auditRepository({
        reader: deps.reader,
        scope: { provider: 'github', owner, repo },
        ref,
        token,
        signal,
        transport: input => session.request(input),
        /* The files past the traced set, many to a request, through the query profile bound to GitHub's GraphQL endpoint. */
        queryTransport: input => ports.fetch(input),
        registryTransport: input => ports.fetch(input),
        advisoryTransport: input => ports.fetch(input),
        licenceTransport: input => ports.fetch(input),
        intelTransport: input => ports.fetch(input),
        analyser: async input => posted(await ports.analyseOffThread(input, { signal, onStage: (stage, detail) => onProgress({ stage, ...(detail || {}) }) }), isAnalysis),
        scanner: async input => posted(await ports.scanOffThread(input, { signal }), isScan),
        onProgress
      });
      assertAuditActive(signal);
      const finished = { ...result, auditedAt: new Date().toISOString() };
      const team = await triageForAccount(account, owner, repo);
      assertAuditActive(signal);
      const triaged: Record<string, unknown> = team && read(team, 'decisions') ? applyTriage(finished, read(team, 'decisions')) : finished;
      /* Marked, rather than shown as if nobody had decided anything. */
      const decided = team && read(team, 'unavailable') ? { ...triaged, triage: { unavailable: true } } : triaged;
      const recorded = await recordAudit(account, owner, repo, decided, { signal });
      const { firstSeen = null, ...kept } = recorded || {};
      const clocked = firstSeen ? withClocks(decided, firstSeen) : decided;
      return { ...clocked, history: recorded ? kept : recorded };
    } finally {
      session.close();
    }
  };

  const readPullFacts: CodeAuditService['readPullFacts'] = async ({ account, owner, repo }, number) => {
    const pull = await deps.gh(account, `/repos/${owner}/${repo}/pulls/${encodeURIComponent(number)}`);
    const head = member(pull, 'head');
    const base = member(pull, 'base');
    const headRepo = head && member(head, 'repo') && member(member(head, 'repo'), 'full_name');
    const baseRepo = base && member(base, 'repo') && member(member(base, 'repo'), 'full_name');
    return {
      number, head: String(head && member(head, 'ref') || ''), base: String(base && member(base, 'ref') || ''), headSha: String(head && member(head, 'sha') || '').toLowerCase(),
      fork: Boolean(headRepo && baseRepo && lowerCase(headRepo) !== lowerCase(baseRepo)),
      open: member(pull, 'state') === 'open'
    };
  };

  const mergeGateFor: CodeAuditService['mergeGateFor'] = async (account, owner, repo, pull, now = Date.now()) => {
    const kept = auditHistory();
    if (!kept) return unavailableGate();
    try {
      const scope = scopeFor(account, owner, repo);
      const identity = deps.identityKey(account);
      /* A fork's head branch is a branch of the fork: no audit of this repository describes it. */
      const [head, base, team] = await Promise.all([
        pull.head && !pull.fork ? kept.latest({ scope, identityKey: identity, ref: pull.head }) : null,
        pull.base ? kept.latest({ scope, identityKey: identity, ref: pull.base }) : null,
        triageForAccount(account, owner, repo)
      ]);
      return evaluateMergeGate({ headSha: pull.headSha, head, base, decisions: team && read(team, 'decisions'), now });
    } catch (error) {
      console.warn(`[code-audit] merge gate not evaluated (${codeOf(error)})`);
      return unavailableGate();
    }
  };

  /* The active policies' answer for a merge, read without writing, so no decision is recorded for a merge nobody asked for. */
  const gatePolicies: CodeAuditService['gatePolicies'] = async (scope, attributes) => {
    if (!(await deps.dbReady())) return { available: false, policies: [] };
    const resolved = await deps.governanceStore().resolveActivePolicySetInScope({ scope, action: 'pull.merge' });
    return { available: true, policies: previewMergePolicies(resolved.activePolicies, attributes) };
  };

  return {
    jobs, history: auditHistory, watch: auditWatch, triage: auditTriage,
    runAudit, recordAudit, triageForAccount, readPullFacts, mergeGateFor, gatePolicies
  };
}
