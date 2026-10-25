/*
 * A GitHub webhook delivery, as one event in one shape, and how much it
 * should worry the people watching the repository.
 *
 * Every value taken from the payload is cleaned and bounded: one line, no
 * control characters. A push names at most 500 paths from at most 100
 * commits, and says when GitHub sent more than that, because a changeset the
 * reader cannot see in full is itself a reason for attention.
 */
import crypto from 'node:crypto';
import { member } from '../../../platform/values/fields.ts';
import { pathMatches } from '../../../platform/values/path-patterns.ts';
import { cleanPath, cleanText } from '../../../platform/values/text.ts';

const MAX_REASON_COUNT = 12;

export interface WebhookEvent {
  id: string;
  provider: 'github';
  owner: string;
  repo: string;
  eventType: string;
  action: string;
  actor: string;
  targetType: string;
  targetId: string;
  ref: string;
  beforeSha: string;
  afterSha: string;
  paths: string[];
  forced: boolean;
  defaultBranch: string;
  timestamp: string;
  summary: string;
  metadata: Record<string, unknown>;
}

export function normalizeGithubWebhook(eventName: unknown, payload: unknown = {}, deliveryId: unknown = ''): WebhookEvent {
  const of = (key: string): unknown => member(payload, key);
  const repo = of('repository') || {};
  const repoOwner = member(repo, 'owner');
  const deployment = of('deployment');
  const pusher = of('pusher');
  const actorObj = of('sender') || pusher || deployment && member(deployment, 'creator') || {};
  const actor = cleanText(member(actorObj, 'login') || member(actorObj, 'name') || pusher && member(pusher, 'name') || 'unknown', 100);
  const base: WebhookEvent = {
    id: cleanText(deliveryId || crypto.randomUUID(), 100),
    provider: 'github',
    owner: cleanText(repoOwner && (member(repoOwner, 'login') || member(repoOwner, 'name')) || '', 100),
    repo: cleanText(member(repo, 'name') || '', 100),
    eventType: cleanText(eventName || 'unknown', 80),
    action: cleanText(of('action') || '', 80),
    actor,
    targetType: 'repository',
    targetId: cleanText(member(repo, 'full_name') || '', 220),
    ref: '',
    beforeSha: '',
    afterSha: '',
    paths: [],
    forced: false,
    defaultBranch: cleanText(member(repo, 'default_branch') || '', 200),
    timestamp: new Date().toISOString(),
    summary: '',
    metadata: {}
  };

  if (eventName === 'ping') {
    base.targetType = 'webhook';
    base.targetId = cleanText(of('hook_id') || of('zen') || 'ping');
    base.summary = 'GitHub webhook connection verified';
  } else if (eventName === 'push') {
    base.targetType = 'branch';
    base.ref = cleanText(of('ref') || '', 300).replace(/^refs\/heads\//, '');
    base.targetId = base.ref || 'unknown branch';
    base.beforeSha = cleanText(of('before') || '', 80);
    base.afterSha = cleanText(of('after') || '', 80);
    base.forced = !!of('forced');
    const listed = of('commits');
    const commits: readonly unknown[] = Array.isArray(listed) ? listed : [];
    const providerCommitCount = Number.isFinite(Number(of('size'))) ? Math.max(0, Number(of('size'))) : commits.length;
    const distinctCommitCount = Number.isFinite(Number(of('distinct_size'))) ? Math.max(0, Number(of('distinct_size'))) : providerCommitCount;
    const inspectedCommits = commits.slice(0, 100);
    const paths: string[] = [];
    let pathsTruncated = commits.length > inspectedCommits.length || providerCommitCount > commits.length;
    for (const commit of inspectedCommits) {
      for (const key of ['added', 'modified', 'removed']) {
        const field = member(commit, key);
        const changed: readonly unknown[] = Array.isArray(field) ? field : [];
        if (changed.length > 300) pathsTruncated = true;
        for (const p of changed.slice(0, 300)) paths.push(cleanPath(p));
      }
    }
    const uniquePaths = [...new Set(paths.filter(Boolean))];
    if (uniquePaths.length > 500) pathsTruncated = true;
    base.paths = uniquePaths.slice(0, 500);
    base.summary = `${actor} pushed ${providerCommitCount} commit(s) to ${base.ref || 'a branch'}`;
    const headCommit = of('head_commit');
    base.metadata = {
      compare: cleanText(of('compare') || '', 500),
      created: !!of('created'),
      deleted: !!of('deleted'),
      headMessage: cleanText(headCommit && member(headCommit, 'message') || '', 500),
      commitCount: providerCommitCount,
      distinctCommitCount,
      commitsIncluded: commits.length,
      commitsInspected: inspectedCommits.length,
      pathsTruncated
    };
  } else if (eventName === 'pull_request') {
    const pr = of('pull_request') || {};
    const head = member(pr, 'head');
    const baseRef = member(pr, 'base');
    base.targetType = 'pull_request';
    base.targetId = String(member(pr, 'number') || of('number') || '');
    base.ref = cleanText(head && member(head, 'ref') || '', 300);
    base.afterSha = cleanText(head && member(head, 'sha') || '', 80);
    base.summary = `${actor} ${base.action || 'updated'} pull request #${base.targetId}`;
    base.metadata = {
      title: cleanText(member(pr, 'title') || '', 500),
      baseRef: cleanText(baseRef && member(baseRef, 'ref') || '', 300),
      merged: !!member(pr, 'merged'),
      draft: !!member(pr, 'draft'),
      changedFiles: Number(member(pr, 'changed_files') || 0)
    };
  } else if (eventName === 'workflow_run') {
    const run = of('workflow_run') || {};
    base.targetType = 'workflow';
    base.targetId = String(member(run, 'id') || '');
    base.ref = cleanText(member(run, 'head_branch') || '', 300);
    base.afterSha = cleanText(member(run, 'head_sha') || '', 80);
    base.summary = `${cleanText(member(run, 'name') || 'Workflow', 180)} ${cleanText(member(run, 'conclusion') || member(run, 'status') || base.action || 'updated', 80)}`;
    base.metadata = {
      name: cleanText(member(run, 'name') || '', 200),
      status: cleanText(member(run, 'status') || '', 80),
      conclusion: cleanText(member(run, 'conclusion') || '', 80),
      event: cleanText(member(run, 'event') || '', 80),
      url: cleanText(member(run, 'html_url') || '', 500)
    };
  } else if (eventName === 'issues') {
    const issue = of('issue') || {};
    base.targetType = 'issue';
    base.targetId = String(member(issue, 'number') || '');
    base.summary = `${actor} ${base.action || 'updated'} issue #${base.targetId}`;
    base.metadata = { title: cleanText(member(issue, 'title') || '', 500), state: cleanText(member(issue, 'state') || '', 50) };
  } else if (eventName === 'release') {
    const release = of('release') || {};
    base.targetType = 'release';
    base.targetId = cleanText(member(release, 'tag_name') || member(release, 'id') || '', 200);
    base.summary = `${actor} ${base.action || 'updated'} release ${base.targetId}`;
    base.metadata = { name: cleanText(member(release, 'name') || '', 300), draft: !!member(release, 'draft'), prerelease: !!member(release, 'prerelease') };
  } else if (eventName === 'create' || eventName === 'delete') {
    base.targetType = cleanText(of('ref_type') || 'reference', 80);
    base.targetId = cleanText(of('ref') || '', 300);
    base.ref = base.targetId;
    base.summary = `${actor} ${eventName}d ${base.targetType} ${base.targetId}`;
  } else if (eventName === 'deployment' || eventName === 'deployment_status') {
    const shipped = of('deployment') || {};
    const status = of('deployment_status') || {};
    base.targetType = 'deployment';
    base.targetId = String(member(shipped, 'id') || member(status, 'id') || '');
    base.ref = cleanText(member(shipped, 'ref') || '', 300);
    base.afterSha = cleanText(member(shipped, 'sha') || '', 80);
    base.summary = `${actor} ${eventName === 'deployment' ? 'created deployment' : `reported deployment ${String(member(status, 'state') || 'status')}`}`;
    base.metadata = { environment: cleanText(member(shipped, 'environment') || member(status, 'environment') || '', 200), state: cleanText(member(status, 'state') || '', 80) };
  } else if (eventName === 'repository_vulnerability_alert') {
    const alert = of('alert') || {};
    base.targetType = 'vulnerability';
    base.targetId = String(member(alert, 'id') || of('action') || 'alert');
    base.summary = `Repository vulnerability alert ${base.action || 'updated'}`;
    base.metadata = { affectedRange: cleanText(member(alert, 'affected_range') || '', 300), externalIdentifier: cleanText(member(alert, 'external_identifier') || '', 200) };
  } else {
    base.targetType = cleanText(eventName || 'event', 80);
    base.targetId = cleanText(of('action') || member(repo, 'full_name') || deliveryId || 'event', 220);
    base.summary = `${actor} triggered ${String(eventName)}${base.action ? `:${base.action}` : ''}`;
  }

  return base;
}

/* The parts of an event its risk is read from: a stored event read back, or one just normalised. */
export interface RiskEvent {
  readonly eventType?: unknown;
  readonly forced?: unknown;
  readonly ref?: unknown;
  readonly defaultBranch?: unknown;
  readonly targetType?: unknown;
  readonly actor?: unknown;
  readonly paths?: readonly string[] | null;
  readonly metadata?: unknown;
}
export interface RiskContext {
  readonly protectedPatterns?: unknown;
  readonly defaultBranch?: unknown;
}
export interface RiskReason {
  readonly points: number;
  readonly code: string;
  readonly message: string;
}
export interface Risk {
  readonly score: number;
  readonly severity: 'critical' | 'warning' | 'normal';
  readonly reasons: RiskReason[];
}

export function riskForEvent(event: RiskEvent, context: RiskContext = {}): Risk {
  let score = 0;
  const reasons: RiskReason[] = [];
  const add = (points: number, code: string, message: string): void => {
    score += points;
    if (reasons.length < MAX_REASON_COUNT) reasons.push({ points, code, message });
  };
  const patterns = context.protectedPatterns;
  const protectedPatterns: readonly unknown[] = Array.isArray(patterns) ? patterns : [];
  const defaultBranch = cleanText(context.defaultBranch || event.defaultBranch || '', 200);
  const metadata = (key: string): unknown => event.metadata && member(event.metadata, key);

  if (event.eventType === 'push') {
    if (event.forced) add(45, 'FORCE_PUSH', 'A force push rewrote branch history.');
    if (metadata('deleted')) add(50, 'BRANCH_DELETED', 'A branch reference was deleted.');
    if (defaultBranch && event.ref === defaultBranch && metadata('deleted')) add(35, 'DEFAULT_BRANCH_DELETED', 'The repository default branch was deleted.');
    if (defaultBranch && event.ref === defaultBranch) add(10, 'DEFAULT_BRANCH_WRITE', 'The change directly affected the default branch.');
    const protectedHits = (event.paths || []).filter(p => protectedPatterns.some(pattern => pathMatches(pattern, p))).slice(0, 12);
    if (protectedHits.length) add(45, 'PROTECTED_PATH_CHANGED', `Protected path change detected: ${protectedHits.slice(0, 3).join(', ')}${protectedHits.length > 3 ? '…' : ''}`);
    const workflowHits = (event.paths || []).filter(p => p === '.github/workflows' || p.startsWith('.github/workflows/'));
    if (workflowHits.length) add(35, 'WORKFLOW_CHANGED', 'A GitHub Actions workflow file changed.');
    const secretHits = (event.paths || []).filter(p => /(^|\/)(\.env|id_rsa|id_ed25519|.*\.pem|.*\.p12|.*\.key)$/i.test(p));
    if (secretHits.length) add(50, 'SENSITIVE_FILE_PATH', 'A commonly sensitive credential or environment file path changed.');
    if (metadata('pathsTruncated')) add(25, 'CHANGESET_TRUNCATED', 'The push contained more commits or file paths than the webhook payload could safely inspect.');
  }
  if (event.eventType === 'delete') add(event.targetType === 'branch' ? 35 : 20, 'REFERENCE_DELETED', `A ${String(event.targetType || 'reference')} was deleted.`);
  if (event.eventType === 'workflow_run') {
    const conclusion = String(metadata('conclusion') || '').toLowerCase();
    if (['failure', 'cancelled', 'timed_out', 'startup_failure', 'action_required'].includes(conclusion)) add(30, 'WORKFLOW_FAILED', `Workflow ended with ${conclusion}.`);
  }
  if (event.eventType === 'deployment_status') {
    const state = String(metadata('state') || '').toLowerCase();
    if (['failure', 'error', 'inactive'].includes(state)) add(30, 'DEPLOYMENT_FAILED', `Deployment state is ${state}.`);
  }
  if (event.eventType === 'repository_vulnerability_alert') add(45, 'VULNERABILITY_ALERT', 'GitHub reported a repository vulnerability alert.');
  if (event.actor === 'unknown') add(15, 'UNKNOWN_ACTOR', 'The event did not include a recognized actor.');
  if (event.eventType === 'pull_request' && metadata('merged') && metadata('draft')) add(20, 'DRAFT_MERGED', 'A draft pull request appears to have been merged.');

  score = Math.min(100, score);
  const severity = score >= 70 ? 'critical' : score >= 35 ? 'warning' : 'normal';
  return { score, severity, reasons };
}
