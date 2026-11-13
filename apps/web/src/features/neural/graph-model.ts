/*
 * The Neural map's graph: what the repository's readings say, as nodes,
 * the relations between them, and the events in their history.
 *
 * Built from the readings as they arrived -- each is read through
 * platform/values.ts, so a reading that is missing, or not the shape it was
 * promised, contributes nothing rather than stopping the map -- and from the
 * reader, the repository open and the time, which the caller gives. Nothing
 * here draws, reads the page or keeps state between builds: where a node sits
 * and which one is selected belong to the map that shows it.
 */
import { field, items } from '../../platform/values.ts';

export type Severity = 'normal' | 'warning' | 'critical';

export type NodeType =
  | 'repo' | 'user' | 'session' | 'branch' | 'tag' | 'commit' | 'pull' | 'issue' | 'release' | 'workflow'
  | 'package' | 'vulnerability' | 'protected' | 'snapshot' | 'safety' | 'external' | 'scan' | 'credential'
  | 'leak' | 'integration';

/* A drawn mark, for the four types no letter in the page's typeface stands for. */
export type NodeMark = 'star' | 'restore' | 'shield' | 'check';

export interface TypeStyle {
  readonly color: string;
  readonly glyph?: string;
  readonly mark?: NodeMark;
  readonly radius: number;
  readonly label: string;
  readonly plural: string;
  readonly short?: string;
}

export const TYPE_STYLE: Readonly<Record<NodeType, TypeStyle>> = Object.freeze({
  repo: { color: '#9a8cff', mark: 'star', radius: 22, label: 'Repository', plural: 'Repositories' },
  user: { color: '#f3f5ff', glyph: 'U', radius: 13, label: 'Identity', plural: 'Identities' },
  session: { color: '#61d8ff', glyph: 'S', radius: 11, label: 'Session', plural: 'Sessions' },
  branch: { color: '#63a8ff', glyph: 'B', radius: 12, label: 'Branch', plural: 'Branches' },
  tag: { color: '#ffc96b', glyph: 'T', radius: 10, label: 'Tag', plural: 'Tags' },
  commit: { color: '#7f90ff', glyph: 'C', radius: 9, label: 'Commit', plural: 'Commits' },
  pull: { color: '#d582ff', glyph: 'P', radius: 11, label: 'Pull request', plural: 'Pull requests' },
  issue: { color: '#ff9c66', glyph: 'I', radius: 10, label: 'Issue', plural: 'Issues' },
  release: { color: '#49d9ad', glyph: 'R', radius: 11, label: 'Release', plural: 'Releases' },
  workflow: { color: '#55d7f4', glyph: 'W', radius: 11, label: 'Workflow', plural: 'Workflows' },
  package: { color: '#b795ff', glyph: 'D', radius: 10, label: 'Dependency', plural: 'Dependencies' },
  vulnerability: { color: '#F43F6E', glyph: '!', radius: 13, label: 'Vulnerability', plural: 'Vulnerabilities' },
  protected: { color: '#22D3EE', glyph: 'L', radius: 12, label: 'Protected asset', plural: 'Protected assets' },
  snapshot: { color: '#5c9fff', mark: 'restore', radius: 13, label: 'Recovery snapshot', plural: 'Recovery' },
  safety: { color: '#ff6d8d', mark: 'shield', radius: 13, label: 'Safety control', plural: 'Safety controls' },
  external: { color: '#ff7469', glyph: 'X', radius: 12, label: 'External destination', plural: 'Destinations' },
  scan: { color: '#50e6c2', mark: 'check', radius: 12, label: 'Security scan', plural: 'Scans' },
  credential: { color: '#ffd166', glyph: 'K', radius: 12, label: 'Deploy credential', plural: 'Credentials' },
  leak: { color: '#ff8a5c', glyph: '!', radius: 12, label: 'Leaked credential', plural: 'Leaked credentials', short: 'Leaked keys' },
  integration: { color: '#ff8fab', glyph: 'H', radius: 12, label: 'Webhook integration', plural: 'Webhooks' }
});

export type Mode = 'security' | 'recovery' | 'dependencies' | 'governance' | 'activity';

/* The types each of the map's modes shows. */
export const MODE_TYPES: Readonly<Record<Mode, ReadonlySet<NodeType>>> = Object.freeze({
  security: new Set<NodeType>(['repo', 'user', 'session', 'branch', 'commit', 'workflow', 'protected', 'package', 'vulnerability', 'safety', 'snapshot', 'external', 'credential', 'leak', 'integration']),
  recovery: new Set<NodeType>(['repo', 'branch', 'tag', 'commit', 'release', 'snapshot', 'safety', 'protected']),
  dependencies: new Set<NodeType>(['repo', 'package', 'vulnerability', 'workflow', 'protected', 'scan']),
  governance: new Set<NodeType>(['repo', 'user', 'session', 'branch', 'protected', 'safety', 'pull', 'workflow', 'snapshot', 'credential', 'leak', 'integration']),
  activity: new Set<NodeType>(['repo', 'user', 'branch', 'commit', 'pull', 'issue', 'release', 'workflow', 'protected'])
});

/* What a node's details hold: the reading it came from, as the server said it. */
export type Meta = Record<string, unknown>;

export interface GraphNode {
  readonly id: string;
  readonly type: NodeType;
  label: string;
  meta: Meta;
  severity: Severity;
  readonly color: string;
  readonly glyph: string | undefined;
  readonly mark: NodeMark | undefined;
  readonly r: number;
  /* Where the map has placed it, and how it is moving there. */
  x: number;
  y: number;
  vx: number;
  vy: number;
  readonly fixed: boolean;
  visible: boolean;
  match: boolean;
  activity: number;
  /* Its place among its own kind, where the reading gives one. */
  order?: number;
  appear?: number;
  wasVisible?: boolean;
}

export interface GraphEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly type: string;
  readonly severity: Severity;
  readonly meta: Meta;
  activity: number;
}

export interface GraphEvent {
  readonly id: string;
  readonly type: string;
  readonly label: unknown;
  readonly detail: string;
  readonly time: string;
  readonly nodeId: string;
  readonly edgeId: string;
  readonly severity: Severity;
}

/* What the map is built for: the repository open, who is reading, and when. */
export interface GraphContext {
  readonly work: { readonly owner: unknown; readonly repo: unknown; readonly branch: unknown };
  readonly me: unknown;
  readonly now: number;
  /* How the Exposure screen names a detection rule, and a finding's disposition. */
  readonly ruleLabel: (rule: unknown) => string;
  readonly dispositionWords: Readonly<Record<string, string>>;
}

export interface Graph {
  readonly nodes: GraphNode[];
  readonly edges: GraphEdge[];
  readonly events: GraphEvent[];
  /* For each type the graph holds fewer of than there are, how many there are. */
  readonly totals: Record<string, number>;
}

/* A severity as a reading gives it: one of the three, or nothing. */
function severityOf(value: unknown, fallback: Severity = 'normal'): Severity {
  return value === 'critical' || value === 'warning' || value === 'normal' ? value : fallback;
}

/* A severity a reading names, kept as the original builder kept it: whatever the reading said, when it said anything. */
function named(value: unknown): Severity {
  return severityOf(value, value ? 'warning' : 'normal');
}

export function short(value: unknown, n = 44): string {
  const s = String(value || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

const isNodeType = (type: string): type is NodeType => Object.prototype.hasOwnProperty.call(TYPE_STYLE, type);

export function addNode(map: Map<string, GraphNode>, id: string, type: NodeType, label: unknown, meta: Meta = {}, severity: Severity = 'normal'): GraphNode | undefined {
  if (!id || map.has(id)) return map.get(id);
  const st = TYPE_STYLE[isNodeType(type) ? type : 'repo'];
  const node: GraphNode = {
    id, type, label: String(label || id), meta, severity,
    color: st.color, glyph: st.glyph, mark: st.mark, r: st.radius,
    x: 0, y: 0, vx: 0, vy: 0, fixed: type === 'repo',
    visible: true, match: false, activity: 0
  };
  map.set(id, node);
  return node;
}

export function addEdge(edges: GraphEdge[], source: string, target: string, type = 'relation', severity: Severity = 'normal', meta: Meta = {}): void {
  if (!source || !target || source === target) return;
  const id = `${source}>${target}:${type}`;
  if (edges.some(e => e.id === id)) return;
  edges.push({ id, source, target, type, severity, meta, activity: 0 });
}

export function addEvent(events: GraphEvent[], type: string, label: unknown, detail: string, time: unknown, nodeId: string, edgeId = '', severity: Severity = 'normal'): void {
  if (time == null || time === '') return;
  const d = new Date(time instanceof Date || typeof time === 'number' || typeof time === 'string' ? time : String(time));
  if (!Number.isFinite(d.getTime())) return;
  events.push({ id: `${type}:${nodeId}:${d.getTime()}:${events.length}`, type, label, detail, time: d.toISOString(), nodeId, edgeId, severity });
}

const text = (value: unknown): string => String(value);
const truthy = (value: unknown): boolean => Boolean(value);

/*
 * The graph of one set of readings. `data` holds them as the map fetched
 * them: safety, refs, activity, deps, actions, sessions, intelligence,
 * signedSnapshots, access, scanner, exposure, and the browser's own
 * storedSnapshot.
 */
export function buildGraph(data: unknown, context: GraphContext): Graph {
  const nodeMap = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const events: GraphEvent[] = [];
  /* A large repository has more of most things than a graph can show. The
   * inventories keep their most telling members -- a branch list starts
   * with the default, the working and the protected branches -- and record
   * how many there were, so a panel says "60 of 312" instead of letting the
   * reader believe 60 is all there is. */
  const totals: Record<string, number> = {};
  const keep = (type: string, list: unknown, max: number): readonly unknown[] => {
    const all = items(list);
    if (all.length > max) totals[type] = (totals[type] || 0) + all.length;
    return all.slice(0, max);
  };
  const ordered = (node: GraphNode | undefined, order: number): void => { if (node && node.order == null) node.order = order; };
  const w = context.work;
  const me = context.me;
  const safety = field(data, 'safety');
  const refs = field(data, 'refs');
  const activity = field(data, 'activity');
  const deps = field(data, 'deps');
  const repoId = 'repo:current';
  addNode(nodeMap, repoId, 'repo', `${text(w.owner)}/${text(w.repo)}`, {
    owner: w.owner, repository: w.repo, branch: w.branch, provider: (me && field(me, 'provider')) || 'github',
    description: 'Central repository intelligence node.'
  }, items(field(deps, 'vulnerable')).length ? 'warning' : 'normal');

  const login: unknown = (me && (field(me, 'login') || field(me, 'name'))) || 'Current user';
  addNode(nodeMap, 'user:current', 'user', login, {
    provider: (me && field(me, 'provider')) || 'github', role: 'Authenticated operator',
    description: 'The identity currently controlling this Nebulaverse-X session.'
  });
  addEdge(edges, 'user:current', repoId, 'authenticated access');

  const sessionList = field(field(data, 'sessions'), 'sessions');
  keep('session', sessionList, 12).forEach((s, i) => {
    const id = `session:${i}`;
    const current = truthy(field(s, 'current'));
    addNode(nodeMap, id, 'session', current ? 'Current session' : `Active session ${i + 1}`, {
      current, updated: field(s, 'updated') || '', provider: field(s, 'provider') || '',
      description: current ? 'This browser session.' : 'Another active Nebulaverse-X session for this identity.'
    }, current ? 'normal' : 'warning');
    addEdge(edges, 'user:current', id, 'owns session', current ? 'normal' : 'warning');
    addEdge(edges, id, repoId, 'repository access', current ? 'normal' : 'warning');
  });

  const defaultBranch = field(refs, 'defaultBranch');
  const branchRank = (b: unknown): number => (field(b, 'name') === defaultBranch ? 0 : field(b, 'name') === w.branch ? 1 : field(b, 'protected') ? 2 : 3);
  const branches = keep('branch', [...items(field(refs, 'refs'))].sort((a, b) =>
    branchRank(a) - branchRank(b) || text(field(a, 'name')).localeCompare(text(field(b, 'name')))), 60);
  branches.forEach((b, i) => {
    const name = field(b, 'name');
    const isProtected = field(b, 'protected');
    const id = `branch:${text(name)}`;
    const sev: Severity = isProtected ? 'normal' : (name === defaultBranch ? 'warning' : 'normal');
    ordered(addNode(nodeMap, id, 'branch', name, {
      sha: field(b, 'sha'), protected: truthy(isProtected), default: name === defaultBranch,
      description: isProtected ? 'Provider-protected branch.' : 'Repository branch reference.'
    }, sev), i);
    addEdge(edges, repoId, id, isProtected ? 'protected ref' : 'branch ref', sev);
  });
  keep('tag', field(refs, 'tags'), 24).forEach(t => {
    const id = `tag:${text(field(t, 'name'))}`;
    addNode(nodeMap, id, 'tag', field(t, 'name'), { sha: field(t, 'sha'), description: 'Immutable release or version marker.' });
    addEdge(edges, repoId, id, 'tag ref');
  });

  const currentBranch = nodeMap.get(`branch:${text(w.branch)}`);
  const commits = items(field(activity, 'commits')).slice(0, 22);
  commits.forEach((c, i) => {
    const sha = text(field(c, 'sha'));
    const message = field(c, 'message');
    const id = `commit:${sha}`;
    const suspicious = /force|secret|password|disable|bypass|hotfix/i.test(`${text(message || '')}`);
    const severity: Severity = suspicious ? 'warning' : 'normal';
    ordered(addNode(nodeMap, id, 'commit', short(message || sha.slice(0, 8), 34), {
      sha: field(c, 'sha'), author: field(c, 'author'), date: field(c, 'date'), message,
      description: 'Recent commit observed in repository activity.'
    }, severity), i);
    if (currentBranch && currentBranch.meta.sha === field(c, 'sha')) {
      addEdge(edges, currentBranch.id, id, 'head commit', severity, { time: field(c, 'date') });
    } else addEdge(edges, repoId, id, 'observed commit', severity, { time: field(c, 'date') });
    addEvent(events, 'commit', message || 'Commit', `${text(field(c, 'author') || 'Unknown author')} · ${sha.slice(0, 8)}`, field(c, 'date'), id, '', severity);
  });
  // Provider list order is not Git ancestry (merges may interleave histories).
  for (const c of commits) {
    for (const parent of items(field(c, 'parentShas'))) {
      if (nodeMap.has(`commit:${text(parent)}`)) addEdge(edges, `commit:${text(field(c, 'sha'))}`, `commit:${text(parent)}`, 'parent commit');
    }
  }

  items(field(activity, 'pulls')).slice(0, 10).forEach((p, order) => {
    const number = field(p, 'number');
    const state = field(p, 'state');
    const id = `pull:${text(number)}`;
    const severity: Severity = state === 'open' ? 'warning' : 'normal';
    ordered(addNode(nodeMap, id, 'pull', `#${text(number)} ${short(field(p, 'title'), 30)}`, {
      number, state, updated: field(p, 'updated'), title: field(p, 'title'),
      description: `Pull request currently ${text(state)}.`
    }, severity), order);
    addEdge(edges, repoId, id, 'pull request', severity, { time: field(p, 'updated') });
    addEvent(events, 'pull', field(p, 'title'), `Pull request #${text(number)} · ${text(state)}`, field(p, 'updated'), id, '', severity);
  });
  items(field(activity, 'issues')).slice(0, 8).forEach((issue, order) => {
    const number = field(issue, 'number');
    const state = field(issue, 'state');
    const id = `issue:${text(number)}`;
    const severity: Severity = state === 'open' ? 'warning' : 'normal';
    ordered(addNode(nodeMap, id, 'issue', `#${text(number)} ${short(field(issue, 'title'), 30)}`, {
      number, state, updated: field(issue, 'updated'), title: field(issue, 'title'),
      description: `Issue currently ${text(state)}.`
    }, severity), order);
    addEdge(edges, repoId, id, 'issue', severity, { time: field(issue, 'updated') });
    addEvent(events, 'issue', field(issue, 'title'), `Issue #${text(number)} · ${text(state)}`, field(issue, 'updated'), id, '', severity);
  });
  items(field(activity, 'releases')).slice(0, 7).forEach((r, order) => {
    const tag = field(r, 'tag');
    const id = `release:${text(tag)}`;
    ordered(addNode(nodeMap, id, 'release', field(r, 'name') || tag, { tag, published: field(r, 'published'), description: 'Published repository release.' }), order);
    addEdge(edges, repoId, id, 'release', 'normal', { time: field(r, 'published') });
    addEvent(events, 'release', field(r, 'name') || tag, `Release ${text(tag)}`, field(r, 'published'), id);
  });

  items(field(data, 'actions')).slice(0, 14).forEach((a, order) => {
    const runId = field(a, 'id');
    const conclusion = field(a, 'conclusion');
    const status = field(a, 'status');
    const branch = field(a, 'branch');
    const id = `workflow:${text(runId)}`;
    const failed = conclusion === 'failure' || conclusion === 'cancelled';
    const running = status !== 'completed';
    const sev: Severity = failed ? 'critical' : running ? 'warning' : 'normal';
    ordered(addNode(nodeMap, id, 'workflow', short(field(a, 'name') || `Workflow #${text(field(a, 'number'))}`, 31), {
      status, conclusion: conclusion || 'running', branch, event: field(a, 'event'),
      created: field(a, 'created_at'), url: field(a, 'html_url'), runId,
      description: failed ? 'A recent workflow did not complete successfully.' : 'Recent GitHub Actions workflow run.'
    }, sev), order);
    addEdge(edges, nodeMap.has(`branch:${text(branch)}`) ? `branch:${text(branch)}` : repoId, id, 'triggered workflow', sev, { time: field(a, 'created_at') });
    addEvent(events, 'workflow', field(a, 'name') || 'Workflow', `${text(conclusion || status)} · ${text(field(a, 'event') || 'event')}`, field(a, 'created_at'), id, '', sev);
  });

  const verifiedEvents = items(field(field(data, 'intelligence'), 'events')).slice(-120);
  verifiedEvents.forEach(ev => {
    const actor = field(ev, 'actor');
    const severity = named(field(ev, 'severity'));
    const kept = severityOf(field(ev, 'severity'), severity);
    const createdAt = field(ev, 'createdAt');
    const targetType = field(ev, 'targetType');
    const targetKey = field(ev, 'targetId');
    const metadata = field(ev, 'metadata');
    const summary = field(ev, 'summary');
    const score = field(ev, 'score');
    const extra: Meta = { ...(metadata && typeof metadata === 'object' ? metadata : {}) };
    const actorId = actor && actor !== login ? `actor:${text(actor)}` : 'user:current';
    if (actorId !== 'user:current') {
      addNode(nodeMap, actorId, 'user', actor, { role: 'Verified webhook actor', description: 'Identity observed in a signature-verified GitHub event.' }, severity);
      addEdge(edges, actorId, repoId, 'provider activity', severity, { time: createdAt });
    }
    let targetId = repoId;
    if (targetType === 'branch') {
      const ref = targetKey || field(ev, 'ref');
      targetId = `branch:${text(ref)}`;
      addNode(nodeMap, targetId, 'branch', ref || 'branch', { sha: field(ev, 'afterSha'), verifiedEvent: true, description: 'Branch observed through a signature-verified GitHub webhook.' }, kept);
      addEdge(edges, repoId, targetId, 'branch ref', kept, { time: createdAt });
    } else if (targetType === 'workflow') {
      targetId = `workflow:live:${text(targetKey)}`;
      addNode(nodeMap, targetId, 'workflow', short(field(metadata, 'name') || summary || 'Workflow', 32), { ...extra, verifiedEvent: true, riskScore: score, description: summary }, kept);
      const ref = field(ev, 'ref');
      addEdge(edges, nodeMap.has(`branch:${text(ref)}`) ? `branch:${text(ref)}` : repoId, targetId, 'verified workflow event', kept, { time: createdAt });
    } else if (targetType === 'pull_request') {
      targetId = `pull:${text(targetKey)}`;
      addNode(nodeMap, targetId, 'pull', `#${text(targetKey)} ${short(field(metadata, 'title') || '', 26)}`, { ...extra, verifiedEvent: true, riskScore: score, description: summary }, kept);
      addEdge(edges, repoId, targetId, 'verified pull request event', kept, { time: createdAt });
    } else if (targetType === 'issue') {
      targetId = `issue:${text(targetKey)}`;
      addNode(nodeMap, targetId, 'issue', `#${text(targetKey)} ${short(field(metadata, 'title') || '', 26)}`, { ...extra, verifiedEvent: true, riskScore: score, description: summary }, kept);
      addEdge(edges, repoId, targetId, 'verified issue event', kept, { time: createdAt });
    } else if (targetType === 'release') {
      targetId = `release:${text(targetKey)}`;
      addNode(nodeMap, targetId, 'release', targetKey || 'Release', { ...extra, verifiedEvent: true, riskScore: score, description: summary }, kept);
      addEdge(edges, repoId, targetId, 'verified release event', kept, { time: createdAt });
    } else if (targetType === 'deployment') {
      targetId = `external:deployment:${text(targetKey)}`;
      addNode(nodeMap, targetId, 'external', short(field(metadata, 'environment') || 'Deployment target', 32), { ...extra, verifiedEvent: true, riskScore: score, description: summary }, kept);
      addEdge(edges, repoId, targetId, 'deployment activity', kept, { time: createdAt });
    } else if (targetType === 'vulnerability') {
      targetId = `vulnerability:live:${text(targetKey)}`;
      addNode(nodeMap, targetId, 'vulnerability', `Security alert ${text(targetKey)}`, { ...extra, verifiedEvent: true, riskScore: score, description: summary }, kept);
      addEdge(edges, repoId, targetId, 'verified security alert', kept, { time: createdAt });
    }
    const action = field(ev, 'action');
    const edgeType = `${text(field(ev, 'eventType'))}${action ? ` · ${text(action)}` : ''}`;
    addEdge(edges, actorId, targetId, edgeType, severity, { time: createdAt, verified: true, eventId: field(ev, 'id') });
    const afterSha = field(ev, 'afterSha');
    const reasons = items(field(ev, 'reasons'));
    if (field(ev, 'eventType') === 'push' && afterSha && !/^0+$/.test(text(afterSha))) {
      const commitId = `commit:${text(afterSha)}`;
      addNode(nodeMap, commitId, 'commit', short(field(metadata, 'headMessage') || text(afterSha).slice(0, 8), 34), {
        sha: afterSha, actor, verifiedEvent: true, riskScore: score, riskReasons: reasons.map(r => field(r, 'message')).join(' · '), description: summary
      }, kept);
      addEdge(edges, actorId, commitId, 'verified push', kept, { time: createdAt, eventId: field(ev, 'id') });
      addEdge(edges, commitId, targetId, 'updated ref', kept, { time: createdAt, eventId: field(ev, 'id') });
      targetId = commitId;
    }
    addEvent(events, 'verified', summary || field(ev, 'eventType'), `${text(actor || 'unknown')} · risk ${text(score || 0)}${reasons.length ? ` · ${text(field(reasons[0], 'message'))}` : ''}`, createdAt, targetId, '', severity);
  });

  const access = field(data, 'access') || { collaborators: [], deployKeys: [], webhooks: [], risk: { score: 0, severity: 'normal', reasons: [] } };
  keep('user', field(access, 'collaborators'), 60).forEach(collaborator => {
    const collaboratorLogin = field(collaborator, 'login');
    const permission = field(collaborator, 'permission');
    const id = collaboratorLogin === login ? 'user:current' : `access:user:${text(collaboratorLogin)}`;
    const privileged = ['admin', 'maintain', 'write'].includes(String(permission || '').toLowerCase());
    addNode(nodeMap, id, 'user', collaboratorLogin, {
      permission: permission || 'unknown', accountType: field(collaborator, 'type') || 'User',
      description: `Repository collaborator with ${text(permission || 'unknown')} permission.`
    }, String(permission || '').toLowerCase() === 'admin' ? 'warning' : 'normal');
    addEdge(edges, id, repoId, privileged ? 'can modify repository' : 'can read repository', privileged ? 'warning' : 'normal');
  });
  keep('credential', field(access, 'deployKeys'), 30).forEach(key => {
    const keyId = field(key, 'id');
    const readOnly = field(key, 'readOnly');
    const verified = field(key, 'verified');
    const id = `credential:${text(keyId)}`;
    const severity: Severity = readOnly === false ? 'critical' : verified === false ? 'warning' : 'normal';
    addNode(nodeMap, id, 'credential', field(key, 'title') || `Deploy key ${text(keyId)}`, {
      readOnly: readOnly !== false, verified: verified !== false, createdAt: field(key, 'createdAt') || '',
      description: readOnly === false ? 'A deploy key with repository write access.' : 'A read-only repository deploy key.'
    }, severity);
    addEdge(edges, id, repoId, readOnly === false ? 'write credential' : 'read credential', severity);
  });
  /*
   * Credentials an Exposure scan found, including those that survive only in
   * history. Each is shown by what it is and where, as the Exposure screen
   * shows it: the rule, the masked path and line, whether deleting the file
   * helped. The secret itself never reaches the browser. How loud a finding
   * is follows what is known about it: one the provider confirmed live, or
   * of a critical kind, is critical; one refused by its provider no longer
   * works and is quiet.
   */
  const exposure = field(data, 'exposure') || { findings: [], verifications: {} };
  const verifications = field(exposure, 'verifications') || {};
  keep('leak', items(field(exposure, 'findings')).filter(finding => finding && field(finding, 'fingerprint')), 60).forEach(finding => {
    const fingerprint = field(finding, 'fingerprint');
    const id = `leak:${text(fingerprint)}`;
    const disposition = field(finding, 'disposition') || 'open';
    const verification = field(verifications, text(fingerprint)) || null;
    const kind = field(field(finding, 'narration'), 'severity');
    const state = field(verification, 'state');
    const severity: Severity = disposition === 'credential-rejected' || (verification && state === 'rejected') ? 'normal'
      : disposition === 'open' && ((verification && state === 'verified') || kind === 'critical') ? 'critical'
        : 'warning';
    const occurrences = field(finding, 'occurrences');
    const occurrence = Array.isArray(occurrences) ? occurrences[0] : null;
    const lineValue = field(occurrence, 'line');
    const line = occurrence && Number.isInteger(lineValue) ? lineValue : null;
    const displayPath = field(finding, 'displayPath');
    const where = `${text(displayPath || 'a file')}${line ? `:${text(line)}` : ''}`;
    const file = String(displayPath || '').split('/').filter(Boolean).pop() || '';
    const introduced = String(field(finding, 'introducedCommit') || '');
    const commit = /^[0-9a-f]{7,40}$/i.test(introduced) ? introduced : '';
    const words = context.dispositionWords;
    const status = (Object.prototype.hasOwnProperty.call(words, text(disposition)) && words[text(disposition)]) || disposition;
    addNode(nodeMap, id, 'leak', file ? `${context.ruleLabel(field(finding, 'rule'))} · ${file}` : context.ruleLabel(field(finding, 'rule')), {
      where,
      foundIn: field(finding, 'inTree') === false ? `History only${commit ? ` · ${commit.slice(0, 7)}` : ''}` : 'Current tree',
      encoding: field(finding, 'decodedFrom') === 'base64' ? 'Base64-encoded' : '',
      status,
      providerCheck: verification ? (field(verification, 'narration') || state || '') : '',
      description: field(field(finding, 'narration'), 'what') || 'A credential an Exposure scan found in this repository.'
    }, severity);
    addEdge(edges, id, repoId, 'exposed in repository', severity);
    if (commit) {
      const commitId = [...nodeMap.keys()].find(key => key.startsWith('commit:') && key.slice(7).startsWith(commit.toLowerCase()));
      if (commitId) addEdge(edges, commitId, id, 'introduced credential', severity);
    }
  });
  keep('integration', field(access, 'webhooks'), 30).forEach(hook => {
    const hookId = field(hook, 'id');
    const insecure = field(hook, 'insecureSsl');
    const active = field(hook, 'active');
    const id = `integration:${text(hookId)}`;
    const severity: Severity = insecure ? 'critical' : active === false ? 'warning' : 'normal';
    addNode(nodeMap, id, 'integration', field(hook, 'host') || field(hook, 'name') || `Webhook ${text(hookId)}`, {
      active: active !== false, insecureTls: truthy(insecure), events: items(field(hook, 'events')).join(', '), updatedAt: field(hook, 'updatedAt') || '',
      description: insecure ? 'Webhook TLS certificate verification is disabled.' : 'Repository webhook destination.'
    }, severity);
    addEdge(edges, repoId, id, 'delivers events to', severity);
  });
  const risk = field(access, 'risk');
  const riskScore = field(risk, 'score');
  if (field(access, 'available') && risk && typeof riskScore === 'number' && riskScore > 0) {
    const severity = severityOf(field(risk, 'severity'), 'warning');
    addNode(nodeMap, 'safety:access-risk', 'safety', `Access risk ${riskScore}/100`, {
      reasons: items(field(risk, 'reasons')).map(reason => field(reason, 'message')).join(' · '),
      partial: truthy(field(access, 'partial')),
      description: 'Deterministic score from collaborators, deploy keys and repository webhooks.'
    }, severity);
    addEdge(edges, 'safety:access-risk', repoId, 'access posture', severity);
  }

  const protectedMap = field(safety, 'protected') || {};
  const requestedProtectedKey = `${text(w.owner)}/${text(w.repo)}`.toLowerCase();
  const protectedRepoKey = (protectedMap && typeof protectedMap === 'object' ? Object.keys(protectedMap) : []).find(key => key.toLowerCase() === requestedProtectedKey);
  const repoProtected = keep('protected', protectedRepoKey ? field(protectedMap, protectedRepoKey) : [], 60);
  repoProtected.forEach(p => {
    const id = `protected:${text(p)}`;
    addNode(nodeMap, id, 'protected', short(p, 36), {
      path: p, enforcement: 'Nebulaverse-X server', description: 'Writes through Nebulaverse-X are blocked until this asset is unlocked.'
    });
    addEdge(edges, repoId, id, 'protected by policy');
  });

  if (field(safety, 'readOnly')) {
    addNode(nodeMap, 'safety:readonly', 'safety', 'Read-only mode', { enabled: true, description: 'All mutating Nebulaverse-X API requests are blocked.' }, 'critical');
    addEdge(edges, 'safety:readonly', repoId, 'write containment', 'critical');
    addEvent(events, 'safety', 'Read-only containment active', 'Nebulaverse-X writes are blocked', context.now, 'safety:readonly', '', 'critical');
  }
  if (field(safety, 'freezeSync')) {
    addNode(nodeMap, 'safety:freeze', 'safety', 'Synchronization frozen', { enabled: true, description: 'Background offline queue synchronization is paused.' }, 'warning');
    addEdge(edges, 'safety:freeze', repoId, 'automation containment', 'warning');
    addEvent(events, 'safety', 'Synchronization frozen', 'Background synchronization is paused', context.now, 'safety:freeze', '', 'warning');
  }

  const allVulnerable = items(field(deps, 'vulnerable'));
  const vulnerable = keep('package', allVulnerable, 40);
  const allAlerts = items(field(field(deps, 'dependabot'), 'alerts'));
  const advisoryCount = new Set(allVulnerable.flatMap(p => [...items(field(p, 'ids'))])).size + allAlerts.length;
  const sources = items(field(deps, 'sources')).map(s => field(s, 'file')).join(', ');
  const details = field(deps, 'details');
  vulnerable.forEach((p, idx) => {
    const name = field(p, 'name');
    const version = field(p, 'version');
    const pkgId = `package:${text(field(p, 'ecosystem'))}:${text(name)}@${text(version)}`;
    addNode(nodeMap, pkgId, 'package', `${text(name)}@${text(version)}`, {
      ecosystem: field(p, 'ecosystem'), version, sources,
      description: 'Dependency version resolved from a supported project manifest.'
    }, 'warning');
    addEdge(edges, repoId, pkgId, 'uses dependency', 'warning');
    items(field(p, 'ids')).slice(0, 4).forEach(vId => {
      const detail = (details && field(details, text(vId))) || {};
      const sevText = String(field(detail, 'severity') || '').toLowerCase();
      const sev: Severity = /critical|9\.|10\./.test(sevText) ? 'critical' : 'warning';
      const vulnId = `vulnerability:${text(vId)}`;
      addNode(nodeMap, vulnId, 'vulnerability', vId, {
        package: `${text(name)}@${text(version)}`, summary: field(detail, 'summary') || 'Known vulnerability reported by OSV.',
        severity: field(detail, 'severity') || 'See advisory', aliases: items(field(detail, 'aliases')).join(', '),
        description: field(detail, 'summary') || 'Known vulnerability affecting a resolved dependency.'
      }, sev);
      addEdge(edges, pkgId, vulnId, 'affected by', sev);
      addEvent(events, 'vulnerability', vId, `${text(name)}@${text(version)} · ${text(field(detail, 'summary') || 'Known vulnerability')}`, context.now - idx * 1200, vulnId, `${pkgId}>${vulnId}:affected by`, sev);
    });
  });
  allAlerts.slice(0, 12).forEach((a, i) => {
    const id = `vulnerability:dependabot:${i}`;
    const severity = field(a, 'severity');
    const sev: Severity = /critical|high/i.test(text(severity || '')) ? 'critical' : 'warning';
    addNode(nodeMap, id, 'vulnerability', `${text(field(a, 'package') || 'package')} alert`, {
      package: field(a, 'package'), severity, summary: field(a, 'summary'),
      description: field(a, 'summary') || 'Open Dependabot security alert.'
    }, sev);
    addEdge(edges, repoId, id, 'Dependabot alert', sev);
  });
  const scanned = field(deps, 'scanned');
  const osv = field(deps, 'osv') || { available: false, error: 'OSV scan status unavailable' };
  if (scanned && osv && field(deps, 'osv') && field(field(deps, 'osv'), 'available') === false) {
    const error = field(osv, 'error');
    addNode(nodeMap, 'scan:unavailable', 'scan', 'Dependency scan incomplete', {
      sources,
      error: error || 'OSV did not return a usable response.',
      description: 'Dependencies were resolved, but the vulnerability database could not be verified. This is not a clean scan.'
    }, 'warning');
    addEdge(edges, repoId, 'scan:unavailable', 'scan unavailable', 'warning');
    addEvent(events, 'scan', 'Dependency scan incomplete', text(error || 'OSV unavailable'), context.now, 'scan:unavailable', '', 'warning');
  } else if (!vulnerable.length && scanned) {
    addNode(nodeMap, 'scan:clean', 'scan', `${text(scanned)} packages checked`, {
      sources,
      description: 'No matching OSV vulnerabilities were returned for the scanned dependency versions.'
    });
    addEdge(edges, repoId, 'scan:clean', 'security scan');
  }

  const uploadScanner = field(data, 'scanner') || { builtin: { available: false }, yara: { configured: false, required: false } };
  const builtin = field(uploadScanner, 'builtin');
  const yara = field(uploadScanner, 'yara');
  const scannerWarning = !builtin || !field(builtin, 'available') || truthy(yara && field(yara, 'required') && !field(yara, 'configured'));
  addNode(nodeMap, 'scan:upload-gate', 'scan', scannerWarning ? 'Upload malware gate incomplete' : 'Upload malware gate active', {
    builtin: truthy(builtin && field(builtin, 'available')),
    yaraConfigured: truthy(yara && field(yara, 'configured')),
    yaraRequired: truthy(yara && field(yara, 'required')),
    rules: (yara && field(yara, 'rulesPath')) || '',
    description: scannerWarning
      ? 'Upload signature scanning is not fully available for the configured policy.'
      : `Whole-file built-in signature scanning is active${yara && field(yara, 'configured') ? ' with an administrator-managed YARA adapter.' : '; YARA is optional and not configured.'}`
  }, scannerWarning ? 'warning' : 'normal');
  addEdge(edges, repoId, 'scan:upload-gate', 'screens uploaded content', scannerWarning ? 'warning' : 'normal');

  const signedSnapshot: unknown = items(field(field(data, 'signedSnapshots'), 'snapshots'))[0];
  const signatureValid = truthy(signedSnapshot && field(signedSnapshot, 'signatureValid') === true);
  const recoverySnapshot = (signedSnapshot && field(signedSnapshot, 'snapshot')) || field(data, 'storedSnapshot');
  if (recoverySnapshot) {
    const s = recoverySnapshot;
    const refCount = items(field(s, 'refs')).length;
    const signature = signedSnapshot ? field(signedSnapshot, 'signature') : undefined;
    const manifestFiles = field(field(s, 'manifest'), 'files');
    addNode(nodeMap, 'snapshot:stored', 'snapshot', signedSnapshot ? (signatureValid ? 'Signed recovery evidence' : 'Unverified recovery evidence') : 'Emergency reference snapshot', {
      capturedAt: signedSnapshot ? field(signedSnapshot, 'createdAt') : field(s, 'capturedAt'), refs: refCount, tags: items(field(s, 'tags')).length,
      files: field(s, 'manifest') && manifestFiles ? items(manifestFiles).length : 0,
      snapshotId: (signedSnapshot && field(signedSnapshot, 'snapshotId')) || '', signatureValid: signedSnapshot ? truthy(field(signedSnapshot, 'signatureValid')) : false,
      signature: signature ? text(signature).slice(0, 16) + '…' : 'local-only',
      description: signedSnapshot ? (signatureValid ? 'A server-persisted, signature-verified reference and file manifest retained in Neon.' : 'The retained snapshot signature could not be verified. It is not verified recovery protection.') : 'A locally retained manifest of repository refs and optional file hashes.'
    }, signedSnapshot && !signatureValid ? 'warning' : 'normal');
    addEdge(edges, 'snapshot:stored', repoId, signedSnapshot ? (signatureValid ? 'cryptographically protects' : 'unverified recovery evidence') : 'local recovery reference', signedSnapshot && !signatureValid ? 'warning' : 'normal');
    addEvent(events, 'snapshot', signedSnapshot ? (signatureValid ? 'Signed recovery evidence captured' : 'Unverified recovery evidence retained') : 'Recovery reference captured', `${refCount} branch refs preserved`, signedSnapshot ? field(signedSnapshot, 'createdAt') : field(s, 'capturedAt'), 'snapshot:stored');
  } else {
    addNode(nodeMap, 'snapshot:missing', 'snapshot', 'No retained snapshot', {
      description: 'Capture repository refs before an incident. This is not a complete off-platform backup.'
    }, 'warning');
    addEdge(edges, repoId, 'snapshot:missing', 'recovery gap', 'warning');
  }

  const nodes = [...nodeMap.values()];
  /* A total is only worth printing where it is more than the graph holds. */
  const inGraph: Record<string, number> = {};
  for (const n of nodes) inGraph[n.type] = (inGraph[n.type] || 0) + 1;
  if (advisoryCount > (inGraph.vulnerability || 0)) totals.vulnerability = advisoryCount;
  for (const type of Object.keys(totals)) if (!((totals[type] ?? 0) > (inGraph[type] || 0))) delete totals[type];
  const sorted = events.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime()).slice(-80);
  return { nodes, edges, events: sorted, totals };
}
