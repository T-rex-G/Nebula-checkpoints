/* ============================================================
   NEBULAVERSE NEURAL COMMAND CENTER — v5.2
   Functional repository topology built on Nebulaverse-X v5 data.
   ============================================================ */
'use strict';
(() => {
  const TYPE_STYLE = {
    repo:          { color: '#9a8cff', glyph: '✦', radius: 22, label: 'Repository' },
    user:          { color: '#f3f5ff', glyph: 'U', radius: 13, label: 'Identity' },
    session:       { color: '#61d8ff', glyph: 'S', radius: 11, label: 'Session' },
    branch:        { color: '#63a8ff', glyph: 'B', radius: 12, label: 'Branch' },
    tag:           { color: '#ffc96b', glyph: 'T', radius: 10, label: 'Tag' },
    commit:        { color: '#7f90ff', glyph: 'C', radius: 9, label: 'Commit' },
    pull:          { color: '#d582ff', glyph: 'P', radius: 11, label: 'Pull request' },
    issue:         { color: '#ff9c66', glyph: 'I', radius: 10, label: 'Issue' },
    release:       { color: '#49d9ad', glyph: 'R', radius: 11, label: 'Release' },
    workflow:      { color: '#55d7f4', glyph: 'W', radius: 11, label: 'Workflow' },
    package:       { color: '#b795ff', glyph: 'D', radius: 10, label: 'Dependency' },
    vulnerability: { color: '#ff5470', glyph: '!', radius: 13, label: 'Vulnerability' },
    protected:     { color: '#38e0c8', glyph: 'L', radius: 12, label: 'Protected asset' },
    snapshot:      { color: '#5c9fff', glyph: '↺', radius: 13, label: 'Recovery snapshot' },
    safety:        { color: '#ff6d8d', glyph: '◆', radius: 13, label: 'Safety control' },
    external:      { color: '#ff7469', glyph: 'X', radius: 12, label: 'External destination' },
    scan:          { color: '#50e6c2', glyph: '✓', radius: 12, label: 'Security scan' },
    credential:    { color: '#ffd166', glyph: 'K', radius: 12, label: 'Deploy credential' },
    integration:   { color: '#ff8fab', glyph: 'H', radius: 12, label: 'Webhook integration' }
  };

  const MODE_TYPES = {
    security: new Set(['repo', 'user', 'session', 'branch', 'commit', 'workflow', 'protected', 'package', 'vulnerability', 'safety', 'snapshot', 'external', 'credential', 'integration']),
    recovery: new Set(['repo', 'branch', 'tag', 'commit', 'release', 'snapshot', 'safety', 'protected']),
    dependencies: new Set(['repo', 'package', 'vulnerability', 'workflow', 'protected', 'scan']),
    governance: new Set(['repo', 'user', 'session', 'branch', 'protected', 'safety', 'pull', 'workflow', 'snapshot', 'credential', 'integration']),
    activity: new Set(['repo', 'user', 'branch', 'commit', 'pull', 'issue', 'release', 'workflow', 'protected'])
  };

  const CLUSTER_ANGLE = {
    user: -2.82, session: -2.54, branch: -2.05, tag: -1.75, commit: -1.35,
    workflow: -.75, external: -.32, vulnerability: .08, package: .48, scan: .72,
    protected: 1.08, safety: 1.48, snapshot: 1.95, release: 2.28, pull: 2.67, issue: 2.98, credential: -3.02, integration: -.08
  };

  const NVN = {
    active: false,
    loadedKey: '',
    loading: false,
    mode: 'security',
    paused: false,
    canvas: null,
    ctx: null,
    dpr: 1,
    width: 0,
    height: 0,
    zoom: 1,
    panX: 0,
    panY: 0,
    nodes: [],
    edges: [],
    events: [],
    data: null,
    selected: null,
    hover: null,
    dragging: null,
    panning: false,
    pointerStart: null,
    lastPointer: null,
    filters: { critical: true, warning: true, normal: true },
    timelineIndex: -1,
    raf: 0,
    refreshTimer: 0,
    lastFrame: performance.now(),
    stars: [],
    pulseSeed: 0,
    demo: false,
    emergency: false,
    search: '',
    resizeObserver: null,
    eventSource: null,
    eventSourceKey: '',
    liveReloadTimer: 0,
    explainStart: null,
    highlightNodes: new Set(),
    highlightEdges: new Set(),
    intelligenceCursor: '',
    catchUpBusy: false
  };

  function nEsc(value) {
    return String(value == null ? '' : value).replace(/[&<>'"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[ch]);
  }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function hashCode(s) {
    let h = 2166136261;
    for (let i = 0; i < String(s).length; i++) { h ^= String(s).charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function timeAgoN(date) {
    if (!date) return 'unknown time';
    const d = new Date(date); if (!Number.isFinite(d.getTime())) return String(date);
    const sec = Math.max(0, (Date.now() - d.getTime()) / 1000);
    if (sec < 60) return `${Math.floor(sec)}s ago`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
    if (sec < 2592000) return `${Math.floor(sec / 86400)}d ago`;
    return d.toLocaleDateString();
  }
  function short(s, n = 44) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function workPath() {
    const w = state && state.work;
    return w ? `${encodeURIComponent(w.owner)}/${encodeURIComponent(w.repo)}` : '';
  }
  function repoKey() {
    const w = state && state.work;
    return w ? `${w.owner}/${w.repo}@${w.branch || ''}` : '';
  }
  function settledValue(result, fallback) { return result && result.status === 'fulfilled' ? result.value : fallback; }

  function addNode(map, id, type, label, meta = {}, severity = 'normal') {
    if (!id || map.has(id)) return map.get(id);
    const st = TYPE_STYLE[type] || TYPE_STYLE.repo;
    const node = {
      id, type, label: String(label || id), meta, severity,
      color: st.color, glyph: st.glyph, r: st.radius,
      x: 0, y: 0, vx: 0, vy: 0, fixed: type === 'repo',
      visible: true, match: false, activity: 0
    };
    map.set(id, node);
    return node;
  }
  function addEdge(edges, source, target, type = 'relation', severity = 'normal', meta = {}) {
    if (!source || !target || source === target) return;
    const id = `${source}>${target}:${type}`;
    if (edges.some(e => e.id === id)) return;
    edges.push({ id, source, target, type, severity, meta, activity: 0 });
  }
  function addEvent(events, type, label, detail, time, nodeId, edgeId = '', severity = 'normal') {
    const d = new Date(time || Date.now());
    events.push({ id: `${type}:${nodeId}:${d.getTime()}:${events.length}`, type, label, detail, time: d.toISOString(), nodeId, edgeId, severity });
  }

  async function load(force = false) {
    if (!state || !state.work || NVN.loading) return;
    const key = repoKey();
    if (!force && NVN.loadedKey === key && NVN.nodes.length) { resize(); renderInspector(NVN.selected); return; }
    NVN.loading = true;
    const loading = document.getElementById('neuralLoading');
    const empty = document.getElementById('neuralEmpty');
    if (loading) loading.hidden = false;
    if (empty) empty.hidden = true;
    setStream('SYNCING', false);
    try {
      const base = `/api/repo/${workPath()}`;
      const branch = encodeURIComponent(state.work.branch || '');
      const requests = await Promise.allSettled([
        api('/api/safety'),
        api(`${base}/refs-snapshot`),
        api(`${base}/activity?days=30`),
        api(`${base}/audit-deps?ref=${branch}`),
        api(`${base}/actions?branch=${branch}`),
        api('/api/security/sessions'),
        api(`${base}/live-events/status`),
        api(`${base}/intelligence/events?limit=500`),
        api(`${base}/signed-snapshots`),
        api(`${base}/access-surface`),
        api('/api/security/scanner-status')
      ]);
      const safety = settledValue(requests[0], { readOnly: false, freezeSync: false, protected: {} });
      const refs = settledValue(requests[1], { refs: [], tags: [], defaultBranch: state.work.branch });
      const activity = settledValue(requests[2], { commits: [], pulls: [], issues: [], releases: [] });
      const deps = settledValue(requests[3], { scanned: 0, sources: [], vulnerable: [], details: {}, osv: { available: false, error: 'Dependency scan unavailable' }, dependabot: { available: false, alerts: [] } });
      const actions = settledValue(requests[4], []);
      const sessions = settledValue(requests[5], { available: false, sessions: [{ current: true, updated: new Date().toISOString() }] });
      const live = settledValue(requests[6], { available: false, connected: false });
      const intelligence = settledValue(requests[7], { available: false, events: [] });
      const signedSnapshots = settledValue(requests[8], { available: false, snapshots: [] });
      const access = settledValue(requests[9], { available: false, partial: true, collaborators: [], deployKeys: [], webhooks: [], risk: { score: 0, severity: 'normal', reasons: [] } });
      const scanner = settledValue(requests[10], { builtin: { available: false }, yara: { configured: false, required: false } });
      const storedSnapshot = readStoredSnapshot();
      NVN.data = { safety, refs, activity, deps, actions, sessions, live, intelligence, signedSnapshots, access, scanner, storedSnapshot, errors: requests.map(r => r.status === 'rejected' ? r.reason && r.reason.message : '').filter(Boolean) };
      NVN.intelligenceCursor = intelligence && intelligence.cursor ? intelligence.cursor : '';
      buildGraph(NVN.data);
      NVN.loadedKey = key;
      NVN.demo = false;
      updateSummary();
      updateTimeline(true);
      fitGraph(false);
      ensureLiveStream();
      setStream(NVN.paused ? 'PAUSED' : (live.connected ? 'VERIFIED LIVE' : 'POLLING TOPOLOGY'), !NVN.paused);
      const sync = document.getElementById('neuralLastSync');
      if (sync) sync.textContent = `${live.connected ? 'Webhook verified' : 'Polled'} · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    } catch (error) {
      console.error('Neural graph load failed', error);
      if (typeof toast === 'function') toast(`Neural map: ${error.message}`, 'err');
      if (!NVN.nodes.length) injectDemo(true);
    } finally {
      NVN.loading = false;
      if (loading) loading.hidden = true;
      if (empty) empty.hidden = !!NVN.nodes.length;
      resize();
    }
  }

  function readStoredSnapshot() {
    try {
      const key = state && state.work ? `nv_snap_${state.work.owner}/${state.work.repo}` : '';
      return key ? JSON.parse(localStorage.getItem(key) || 'null') : null;
    } catch { return null; }
  }

  function buildGraph(data) {
    const nodeMap = new Map();
    const edges = [];
    const events = [];
    const w = state.work;
    const repoId = 'repo:current';
    addNode(nodeMap, repoId, 'repo', `${w.owner}/${w.repo}`, {
      owner: w.owner, repository: w.repo, branch: w.branch, provider: (state.me && state.me.provider) || 'github',
      description: 'Central repository intelligence node.'
    }, data.deps.vulnerable && data.deps.vulnerable.length ? 'warning' : 'normal');

    const login = (state.me && (state.me.login || state.me.name)) || 'Current user';
    addNode(nodeMap, 'user:current', 'user', login, {
      provider: (state.me && state.me.provider) || 'github', role: 'Authenticated operator',
      description: 'The identity currently controlling this Nebulaverse-X session.'
    });
    addEdge(edges, 'user:current', repoId, 'authenticated access');

    const sessionList = (data.sessions && data.sessions.sessions) || [];
    sessionList.slice(0, 8).forEach((s, i) => {
      const id = `session:${i}`;
      addNode(nodeMap, id, 'session', s.current ? 'Current session' : `Active session ${i + 1}`, {
        current: !!s.current, updated: s.updated || '', provider: s.provider || '',
        description: s.current ? 'This browser session.' : 'Another active Nebulaverse-X session for this identity.'
      }, s.current ? 'normal' : 'warning');
      addEdge(edges, 'user:current', id, 'owns session', s.current ? 'normal' : 'warning');
      addEdge(edges, id, repoId, 'repository access', s.current ? 'normal' : 'warning');
    });

    const branches = (data.refs.refs || []).slice(0, 24);
    branches.forEach((b, i) => {
      const id = `branch:${b.name}`;
      const sev = b.protected ? 'normal' : (b.name === data.refs.defaultBranch ? 'warning' : 'normal');
      addNode(nodeMap, id, 'branch', b.name, {
        sha: b.sha, protected: !!b.protected, default: b.name === data.refs.defaultBranch,
        description: b.protected ? 'Provider-protected branch.' : 'Repository branch reference.'
      }, sev);
      addEdge(edges, repoId, id, b.protected ? 'protected ref' : 'branch ref', sev);
    });
    (data.refs.tags || []).slice(0, 10).forEach(t => {
      const id = `tag:${t.name}`;
      addNode(nodeMap, id, 'tag', t.name, { sha: t.sha, description: 'Immutable release or version marker.' });
      addEdge(edges, repoId, id, 'tag ref');
    });

    const currentBranchId = nodeMap.has(`branch:${w.branch}`) ? `branch:${w.branch}` : repoId;
    let previousCommit = currentBranchId;
    (data.activity.commits || []).slice(0, 22).forEach((c, i) => {
      const id = `commit:${c.sha}`;
      const suspicious = /force|secret|password|disable|bypass|hotfix/i.test(`${c.message || ''}`);
      addNode(nodeMap, id, 'commit', short(c.message || c.sha.slice(0, 8), 34), {
        sha: c.sha, author: c.author, date: c.date, message: c.message,
        description: 'Recent commit observed in repository activity.'
      }, suspicious ? 'warning' : 'normal');
      addEdge(edges, previousCommit, id, i ? 'previous commit' : 'head commit', suspicious ? 'warning' : 'normal', { time: c.date });
      addEvent(events, 'commit', c.message || 'Commit', `${c.author || 'Unknown author'} · ${c.sha.slice(0, 8)}`, c.date, id, `${previousCommit}>${id}:${i ? 'previous commit' : 'head commit'}`, suspicious ? 'warning' : 'normal');
      previousCommit = id;
    });

    (data.activity.pulls || []).slice(0, 10).forEach(p => {
      const id = `pull:${p.number}`;
      addNode(nodeMap, id, 'pull', `#${p.number} ${short(p.title, 30)}`, {
        number: p.number, state: p.state, updated: p.updated, title: p.title,
        description: `Pull request currently ${p.state}.`
      }, p.state === 'open' ? 'warning' : 'normal');
      addEdge(edges, repoId, id, 'pull request', p.state === 'open' ? 'warning' : 'normal', { time: p.updated });
      addEvent(events, 'pull', p.title, `Pull request #${p.number} · ${p.state}`, p.updated, id, '', p.state === 'open' ? 'warning' : 'normal');
    });
    (data.activity.issues || []).slice(0, 8).forEach(i => {
      const id = `issue:${i.number}`;
      addNode(nodeMap, id, 'issue', `#${i.number} ${short(i.title, 30)}`, {
        number: i.number, state: i.state, updated: i.updated, title: i.title,
        description: `Issue currently ${i.state}.`
      }, i.state === 'open' ? 'warning' : 'normal');
      addEdge(edges, repoId, id, 'issue', i.state === 'open' ? 'warning' : 'normal', { time: i.updated });
      addEvent(events, 'issue', i.title, `Issue #${i.number} · ${i.state}`, i.updated, id, '', i.state === 'open' ? 'warning' : 'normal');
    });
    (data.activity.releases || []).slice(0, 7).forEach(r => {
      const id = `release:${r.tag}`;
      addNode(nodeMap, id, 'release', r.name || r.tag, { tag: r.tag, published: r.published, description: 'Published repository release.' });
      addEdge(edges, repoId, id, 'release', 'normal', { time: r.published });
      addEvent(events, 'release', r.name || r.tag, `Release ${r.tag}`, r.published, id);
    });

    (data.actions || []).slice(0, 14).forEach(a => {
      const id = `workflow:${a.id}`;
      const failed = a.conclusion === 'failure' || a.conclusion === 'cancelled';
      const running = a.status !== 'completed';
      const sev = failed ? 'critical' : running ? 'warning' : 'normal';
      addNode(nodeMap, id, 'workflow', short(a.name || `Workflow #${a.number}`, 31), {
        status: a.status, conclusion: a.conclusion || 'running', branch: a.branch, event: a.event,
        created: a.created_at, url: a.html_url, runId: a.id,
        description: failed ? 'A recent workflow did not complete successfully.' : 'Recent GitHub Actions workflow run.'
      }, sev);
      addEdge(edges, nodeMap.has(`branch:${a.branch}`) ? `branch:${a.branch}` : repoId, id, 'triggered workflow', sev, { time: a.created_at });
      addEvent(events, 'workflow', a.name || 'Workflow', `${a.conclusion || a.status} · ${a.event || 'event'}`, a.created_at, id, '', sev);
    });

    const verifiedEvents = ((data.intelligence || {}).events || []).slice(-120);
    verifiedEvents.forEach(ev => {
      const actorId = ev.actor && ev.actor !== login ? `actor:${ev.actor}` : 'user:current';
      if (actorId !== 'user:current') {
        addNode(nodeMap, actorId, 'user', ev.actor, { role: 'Verified webhook actor', description: 'Identity observed in a signature-verified GitHub event.' }, ev.severity || 'normal');
        addEdge(edges, actorId, repoId, 'provider activity', ev.severity || 'normal', { time: ev.createdAt });
      }
      let targetId = repoId;
      if (ev.targetType === 'branch') {
        targetId = `branch:${ev.targetId || ev.ref}`;
        addNode(nodeMap, targetId, 'branch', ev.targetId || ev.ref || 'branch', { sha: ev.afterSha, verifiedEvent: true, description: 'Branch observed through a signature-verified GitHub webhook.' }, ev.severity);
        addEdge(edges, repoId, targetId, 'branch ref', ev.severity, { time: ev.createdAt });
      } else if (ev.targetType === 'workflow') {
        targetId = `workflow:live:${ev.targetId}`;
        addNode(nodeMap, targetId, 'workflow', short((ev.metadata && ev.metadata.name) || ev.summary || 'Workflow', 32), { ...(ev.metadata || {}), verifiedEvent: true, riskScore: ev.score, description: ev.summary }, ev.severity);
        addEdge(edges, nodeMap.has(`branch:${ev.ref}`) ? `branch:${ev.ref}` : repoId, targetId, 'verified workflow event', ev.severity, { time: ev.createdAt });
      } else if (ev.targetType === 'pull_request') {
        targetId = `pull:${ev.targetId}`;
        addNode(nodeMap, targetId, 'pull', `#${ev.targetId} ${short(ev.metadata && ev.metadata.title || '', 26)}`, { ...(ev.metadata || {}), verifiedEvent: true, riskScore: ev.score, description: ev.summary }, ev.severity);
        addEdge(edges, repoId, targetId, 'verified pull request event', ev.severity, { time: ev.createdAt });
      } else if (ev.targetType === 'issue') {
        targetId = `issue:${ev.targetId}`;
        addNode(nodeMap, targetId, 'issue', `#${ev.targetId} ${short(ev.metadata && ev.metadata.title || '', 26)}`, { ...(ev.metadata || {}), verifiedEvent: true, riskScore: ev.score, description: ev.summary }, ev.severity);
        addEdge(edges, repoId, targetId, 'verified issue event', ev.severity, { time: ev.createdAt });
      } else if (ev.targetType === 'release') {
        targetId = `release:${ev.targetId}`;
        addNode(nodeMap, targetId, 'release', ev.targetId || 'Release', { ...(ev.metadata || {}), verifiedEvent: true, riskScore: ev.score, description: ev.summary }, ev.severity);
        addEdge(edges, repoId, targetId, 'verified release event', ev.severity, { time: ev.createdAt });
      } else if (ev.targetType === 'deployment') {
        targetId = `external:deployment:${ev.targetId}`;
        addNode(nodeMap, targetId, 'external', short((ev.metadata && ev.metadata.environment) || 'Deployment target', 32), { ...(ev.metadata || {}), verifiedEvent: true, riskScore: ev.score, description: ev.summary }, ev.severity);
        addEdge(edges, repoId, targetId, 'deployment activity', ev.severity, { time: ev.createdAt });
      } else if (ev.targetType === 'vulnerability') {
        targetId = `vulnerability:live:${ev.targetId}`;
        addNode(nodeMap, targetId, 'vulnerability', `Security alert ${ev.targetId}`, { ...(ev.metadata || {}), verifiedEvent: true, riskScore: ev.score, description: ev.summary }, ev.severity);
        addEdge(edges, repoId, targetId, 'verified security alert', ev.severity, { time: ev.createdAt });
      }
      const edgeType = `${ev.eventType}${ev.action ? ` · ${ev.action}` : ''}`;
      addEdge(edges, actorId, targetId, edgeType, ev.severity || 'normal', { time: ev.createdAt, verified: true, eventId: ev.id });
      if (ev.eventType === 'push' && ev.afterSha && !/^0+$/.test(ev.afterSha)) {
        const commitId = `commit:${ev.afterSha}`;
        addNode(nodeMap, commitId, 'commit', short((ev.metadata && ev.metadata.headMessage) || ev.afterSha.slice(0, 8), 34), {
          sha: ev.afterSha, actor: ev.actor, verifiedEvent: true, riskScore: ev.score, riskReasons: (ev.reasons || []).map(r => r.message).join(' · '), description: ev.summary
        }, ev.severity);
        addEdge(edges, actorId, commitId, 'verified push', ev.severity, { time: ev.createdAt, eventId: ev.id });
        addEdge(edges, commitId, targetId, 'updated ref', ev.severity, { time: ev.createdAt, eventId: ev.id });
        targetId = commitId;
      }
      addEvent(events, 'verified', ev.summary || ev.eventType, `${ev.actor || 'unknown'} · risk ${ev.score || 0}${ev.reasons && ev.reasons.length ? ` · ${ev.reasons[0].message}` : ''}`, ev.createdAt, targetId, '', ev.severity || 'normal');
    });

    const access = data.access || { collaborators: [], deployKeys: [], webhooks: [], risk: { score: 0, severity: 'normal', reasons: [] } };
    (access.collaborators || []).slice(0, 24).forEach(collaborator => {
      const id = collaborator.login === login ? 'user:current' : `access:user:${collaborator.login}`;
      const privileged = ['admin', 'maintain', 'write'].includes(String(collaborator.permission || '').toLowerCase());
      addNode(nodeMap, id, 'user', collaborator.login, {
        permission: collaborator.permission || 'unknown', accountType: collaborator.type || 'User',
        description: `Repository collaborator with ${collaborator.permission || 'unknown'} permission.`
      }, String(collaborator.permission || '').toLowerCase() === 'admin' ? 'warning' : 'normal');
      addEdge(edges, id, repoId, privileged ? 'can modify repository' : 'can read repository', privileged ? 'warning' : 'normal');
    });
    (access.deployKeys || []).slice(0, 20).forEach(key => {
      const id = `credential:${key.id}`;
      const severity = key.readOnly === false ? 'critical' : key.verified === false ? 'warning' : 'normal';
      addNode(nodeMap, id, 'credential', key.title || `Deploy key ${key.id}`, {
        readOnly: key.readOnly !== false, verified: key.verified !== false, createdAt: key.createdAt || '',
        description: key.readOnly === false ? 'A deploy key with repository write access.' : 'A read-only repository deploy key.'
      }, severity);
      addEdge(edges, id, repoId, key.readOnly === false ? 'write credential' : 'read credential', severity);
    });
    (access.webhooks || []).slice(0, 20).forEach(hook => {
      const id = `integration:${hook.id}`;
      const severity = hook.insecureSsl ? 'critical' : hook.active === false ? 'warning' : 'normal';
      addNode(nodeMap, id, 'integration', hook.host || hook.name || `Webhook ${hook.id}`, {
        active: hook.active !== false, insecureTls: !!hook.insecureSsl, events: (hook.events || []).join(', '), updatedAt: hook.updatedAt || '',
        description: hook.insecureSsl ? 'Webhook TLS certificate verification is disabled.' : 'Repository webhook destination.'
      }, severity);
      addEdge(edges, repoId, id, 'delivers events to', severity);
    });
    if (access.available && access.risk && access.risk.score > 0) {
      const severity = access.risk.severity || 'warning';
      addNode(nodeMap, 'safety:access-risk', 'safety', `Access risk ${access.risk.score}/100`, {
        reasons: (access.risk.reasons || []).map(reason => reason.message).join(' · '),
        partial: !!access.partial,
        description: 'Deterministic score from collaborators, deploy keys and repository webhooks.'
      }, severity);
      addEdge(edges, 'safety:access-risk', repoId, 'access posture', severity);
    }

    const protectedMap = ((data.safety || {}).protected || {});
    const requestedProtectedKey = `${w.owner}/${w.repo}`.toLowerCase();
    const protectedRepoKey = Object.keys(protectedMap).find(key => key.toLowerCase() === requestedProtectedKey);
    const repoProtected = (protectedRepoKey ? protectedMap[protectedRepoKey] : []).slice(0, 28);
    repoProtected.forEach(p => {
      const id = `protected:${p}`;
      addNode(nodeMap, id, 'protected', short(p, 36), {
        path: p, enforcement: 'Nebulaverse-X server', description: 'Writes through Nebulaverse-X are blocked until this asset is unlocked.'
      });
      addEdge(edges, repoId, id, 'protected by policy');
    });

    if (data.safety.readOnly) {
      addNode(nodeMap, 'safety:readonly', 'safety', 'Read-only mode', { enabled: true, description: 'All mutating Nebulaverse-X API requests are blocked.' }, 'critical');
      addEdge(edges, 'safety:readonly', repoId, 'write containment', 'critical');
      addEvent(events, 'safety', 'Read-only containment active', 'Nebulaverse-X writes are blocked', Date.now(), 'safety:readonly', '', 'critical');
    }
    if (data.safety.freezeSync) {
      addNode(nodeMap, 'safety:freeze', 'safety', 'Synchronization frozen', { enabled: true, description: 'Background offline queue synchronization is paused.' }, 'warning');
      addEdge(edges, 'safety:freeze', repoId, 'automation containment', 'warning');
      addEvent(events, 'safety', 'Synchronization frozen', 'Background synchronization is paused', Date.now(), 'safety:freeze', '', 'warning');
    }

    const vulnerable = (data.deps.vulnerable || []).slice(0, 22);
    vulnerable.forEach((p, idx) => {
      const pkgId = `package:${p.ecosystem}:${p.name}@${p.version}`;
      addNode(nodeMap, pkgId, 'package', `${p.name}@${p.version}`, {
        ecosystem: p.ecosystem, version: p.version, sources: (data.deps.sources || []).map(s => s.file).join(', '),
        description: 'Dependency version resolved from a supported project manifest.'
      }, 'warning');
      addEdge(edges, repoId, pkgId, 'uses dependency', 'warning');
      (p.ids || []).slice(0, 4).forEach(vId => {
        const detail = data.deps.details && data.deps.details[vId] || {};
        const sevText = String(detail.severity || '').toLowerCase();
        const sev = /critical|9\.|10\./.test(sevText) ? 'critical' : 'warning';
        const vulnId = `vulnerability:${vId}`;
        addNode(nodeMap, vulnId, 'vulnerability', vId, {
          package: `${p.name}@${p.version}`, summary: detail.summary || 'Known vulnerability reported by OSV.',
          severity: detail.severity || 'See advisory', aliases: (detail.aliases || []).join(', '),
          description: detail.summary || 'Known vulnerability affecting a resolved dependency.'
        }, sev);
        addEdge(edges, pkgId, vulnId, 'affected by', sev);
        addEvent(events, 'vulnerability', vId, `${p.name}@${p.version} · ${detail.summary || 'Known vulnerability'}`, Date.now() - idx * 1200, vulnId, `${pkgId}>${vulnId}:affected by`, sev);
      });
    });
    const depAlerts = ((data.deps.dependabot || {}).alerts || []).slice(0, 8);
    depAlerts.forEach((a, i) => {
      const id = `vulnerability:dependabot:${i}`;
      const sev = /critical|high/i.test(a.severity || '') ? 'critical' : 'warning';
      addNode(nodeMap, id, 'vulnerability', `${a.package || 'package'} alert`, {
        package: a.package, severity: a.severity, summary: a.summary,
        description: a.summary || 'Open Dependabot security alert.'
      }, sev);
      addEdge(edges, repoId, id, 'Dependabot alert', sev);
    });
    const osv = data.deps.osv || { available: false, error: 'OSV scan status unavailable' };
    if (data.deps.scanned && osv && data.deps.osv.available === false) {
      addNode(nodeMap, 'scan:unavailable', 'scan', 'Dependency scan incomplete', {
        sources: (data.deps.sources || []).map(s => s.file).join(', '),
        error: osv.error || 'OSV did not return a usable response.',
        description: 'Dependencies were resolved, but the vulnerability database could not be verified. This is not a clean scan.'
      }, 'warning');
      addEdge(edges, repoId, 'scan:unavailable', 'scan unavailable', 'warning');
      addEvent(events, 'scan', 'Dependency scan incomplete', osv.error || 'OSV unavailable', Date.now(), 'scan:unavailable', '', 'warning');
    } else if (!vulnerable.length && data.deps.scanned) {
      addNode(nodeMap, 'scan:clean', 'scan', `${data.deps.scanned} packages checked`, {
        sources: (data.deps.sources || []).map(s => s.file).join(', '),
        description: 'No matching OSV vulnerabilities were returned for the scanned dependency versions.'
      });
      addEdge(edges, repoId, 'scan:clean', 'security scan');
    }

    const uploadScanner = data.scanner || { builtin: { available: false }, yara: { configured: false, required: false } };
    const scannerWarning = !uploadScanner.builtin || !uploadScanner.builtin.available || (uploadScanner.yara && uploadScanner.yara.required && !uploadScanner.yara.configured);
    addNode(nodeMap, 'scan:upload-gate', 'scan', scannerWarning ? 'Upload malware gate incomplete' : 'Upload malware gate active', {
      builtin: !!(uploadScanner.builtin && uploadScanner.builtin.available),
      yaraConfigured: !!(uploadScanner.yara && uploadScanner.yara.configured),
      yaraRequired: !!(uploadScanner.yara && uploadScanner.yara.required),
      rules: uploadScanner.yara && uploadScanner.yara.rulesPath || '',
      description: scannerWarning
        ? 'Upload signature scanning is not fully available for the configured policy.'
        : `Whole-file built-in signature scanning is active${uploadScanner.yara && uploadScanner.yara.configured ? ' with an administrator-managed YARA adapter.' : '; YARA is optional and not configured.'}`
    }, scannerWarning ? 'warning' : 'normal');
    addEdge(edges, repoId, 'scan:upload-gate', 'screens uploaded content', scannerWarning ? 'warning' : 'normal');

    const signedSnapshot = data.signedSnapshots && data.signedSnapshots.snapshots && data.signedSnapshots.snapshots[0];
    const recoverySnapshot = signedSnapshot && signedSnapshot.snapshot || data.storedSnapshot;
    if (recoverySnapshot) {
      const s = recoverySnapshot;
      addNode(nodeMap, 'snapshot:stored', 'snapshot', signedSnapshot ? 'Signed recovery evidence' : 'Emergency reference snapshot', {
        capturedAt: signedSnapshot ? signedSnapshot.createdAt : s.capturedAt, refs: (s.refs || []).length, tags: (s.tags || []).length,
        files: s.manifest && s.manifest.files ? s.manifest.files.length : 0,
        snapshotId: signedSnapshot && signedSnapshot.snapshotId || '', signatureValid: signedSnapshot ? !!signedSnapshot.signatureValid : false,
        signature: signedSnapshot && signedSnapshot.signature ? signedSnapshot.signature.slice(0, 16) + '…' : 'local-only',
        description: signedSnapshot ? 'A server-persisted, HMAC-signed reference and file manifest retained in Neon.' : 'A locally retained manifest of repository refs and optional file hashes.'
      });
      addEdge(edges, 'snapshot:stored', repoId, signedSnapshot ? 'cryptographically protects' : 'protects repository');
      addEvent(events, 'snapshot', signedSnapshot ? 'Signed recovery evidence captured' : 'Recovery reference captured', `${(s.refs || []).length} branch refs preserved`, signedSnapshot ? signedSnapshot.createdAt : s.capturedAt, 'snapshot:stored');
    } else {
      addNode(nodeMap, 'snapshot:missing', 'snapshot', 'No retained snapshot', {
        description: 'Capture repository refs before an incident. This is not a complete off-platform backup.'
      }, 'warning');
      addEdge(edges, repoId, 'snapshot:missing', 'recovery gap', 'warning');
    }

    NVN.nodes = [...nodeMap.values()];
    NVN.edges = edges;
    NVN.events = events.sort((a, b) => new Date(a.time) - new Date(b.time)).slice(-80);
    assignLayout();
    simulateLayout(110);
    applyMode();
  }

  function assignLayout() {
    const groups = new Map();
    for (const n of NVN.nodes) {
      if (n.type === 'repo') { n.x = 0; n.y = 0; continue; }
      if (!groups.has(n.type)) groups.set(n.type, []);
      groups.get(n.type).push(n);
    }
    for (const [type, nodes] of groups) {
      const angle = CLUSTER_ANGLE[type] == null ? 0 : CLUSTER_ANGLE[type];
      const baseR = type === 'commit' ? 220 : type === 'branch' ? 170 : 245;
      nodes.forEach((n, i) => {
        const ring = Math.floor(i / 7);
        const offset = (i % 7) - Math.min(nodes.length - 1, 6) / 2;
        const a = angle + offset * .13 + ring * .055;
        const radius = baseR + ring * 56 + (i % 2) * 18;
        n.x = Math.cos(a) * radius;
        n.y = Math.sin(a) * radius * .76;
        n.vx = n.vy = 0;
      });
    }
  }

  function simulateLayout(iterations) {
    const nodes = NVN.nodes;
    const byId = new Map(nodes.map(n => [n.id, n]));
    for (let step = 0; step < iterations; step++) {
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        if (a.fixed) continue;
        let fx = -a.x * .0014, fy = -a.y * .0014;
        for (let j = 0; j < nodes.length; j++) {
          if (i === j) continue;
          const b = nodes[j];
          let dx = a.x - b.x, dy = a.y - b.y;
          let d2 = dx * dx + dy * dy + 12;
          if (d2 > 30000) continue;
          const rep = 620 / d2;
          fx += dx * rep; fy += dy * rep;
        }
        a.vx = (a.vx + fx) * .82;
        a.vy = (a.vy + fy) * .82;
      }
      for (const e of NVN.edges) {
        const a = byId.get(e.source), b = byId.get(e.target); if (!a || !b) continue;
        let dx = b.x - a.x, dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const desired = (a.type === 'repo' || b.type === 'repo') ? 175 : 95;
        const force = (dist - desired) * .0026;
        dx /= dist; dy /= dist;
        if (!a.fixed) { a.vx += dx * force; a.vy += dy * force; }
        if (!b.fixed) { b.vx -= dx * force; b.vy -= dy * force; }
      }
      for (const n of nodes) if (!n.fixed) { n.x += n.vx; n.y += n.vy; }
    }
  }

  function applyMode() {
    const allowed = MODE_TYPES[NVN.mode] || MODE_TYPES.security;
    const q = NVN.search.trim().toLowerCase();
    for (const n of NVN.nodes) {
      n.match = !!q && (`${n.label} ${JSON.stringify(n.meta)}`).toLowerCase().includes(q);
      n.visible = allowed.has(n.type) && !!NVN.filters[n.severity || 'normal'];
      if (q) n.visible = n.visible && n.match;
    }
    for (const e of NVN.edges) {
      const a = nodeById(e.source), b = nodeById(e.target);
      e.visible = !!(a && b && a.visible && b.visible && NVN.filters[e.severity || 'normal']);
    }
    if (NVN.selected && !NVN.selected.visible) selectNode(null);
    updateVisibleCount();
  }

  function nodeById(id) { return NVN.nodes.find(n => n.id === id); }
  function edgeById(id) { return NVN.edges.find(e => e.id === id); }
  function visibleNodes() { return NVN.nodes.filter(n => n.visible); }

  function updateSummary() {
    if (!NVN.data) return;
    const d = NVN.data;
    const vulnCritical = NVN.nodes.filter(n => n.type === 'vulnerability' && n.severity === 'critical').length;
    const vulnWarnings = NVN.nodes.filter(n => n.type === 'vulnerability' && n.severity === 'warning').length;
    const failedRuns = (d.actions || []).filter(a => a.conclusion === 'failure' || a.conclusion === 'cancelled').length;
    const protectedN = ((((d.safety || {}).protected || {})[`${state.work.owner}/${state.work.repo}`]) || []).length;
    const protectedBranches = (d.refs.refs || []).filter(r => r.protected).length;
    const latestSigned = d.signedSnapshots && d.signedSnapshots.snapshots && d.signedSnapshots.snapshots[0];
    const hasSnapshot = !!(latestSigned || d.storedSnapshot);
    const otherSessions = ((d.sessions && d.sessions.sessions) || []).filter(s => !s.current).length;
    const verified = ((d.intelligence || {}).events || []);
    const highestVerified = verified.reduce((m, e) => Math.max(m, Number(e.score || 0)), 0);
    const accessRisk = Number(d.access && d.access.risk && d.access.risk.score || 0);
    let risk = Math.max(12 + vulnCritical * 22 + vulnWarnings * 9 + failedRuns * 6 + otherSessions * 3, highestVerified, accessRisk);
    if (!hasSnapshot) risk += 9;
    if (!protectedN && !protectedBranches) risk += 7;
    if (d.safety.readOnly) risk -= 10;
    risk = clamp(Math.round(risk), 0, 100);
    const label = risk >= 75 ? 'Critical' : risk >= 50 ? 'Elevated' : risk >= 28 ? 'Guarded' : 'Low';
    const level = risk >= 75 ? 'critical' : risk >= 40 ? 'warning' : 'good';
    const riskEl = document.getElementById('neuralRiskScore');
    if (riskEl) { riskEl.textContent = `${label} · ${risk}`; const card = riskEl.closest('.neural-kpi'); if (card) card.dataset.level = level; }
    const hint = document.getElementById('neuralRiskHint');
    const latestCritical = [...verified].reverse().find(e => e.severity === 'critical');
    const accessReason = d.access && d.access.risk && d.access.risk.reasons && d.access.risk.reasons[0];
    if (hint) hint.textContent = latestCritical
      ? `${latestCritical.summary} · ${latestCritical.reasons && latestCritical.reasons[0] ? latestCritical.reasons[0].message : `risk ${latestCritical.score}`}`
      : accessRisk >= 70 ? `Critical access path · ${accessReason ? accessReason.message : `risk ${accessRisk}`}`
      : vulnCritical ? `${vulnCritical} critical vulnerability signal(s)`
      : failedRuns ? `${failedRuns} failed workflow run(s)`
      : accessRisk >= 35 ? `Access posture warning · ${accessReason ? accessReason.message : `risk ${accessRisk}`}`
      : 'No critical signals in the current scan';
    const signals = document.getElementById('neuralSignalCount'); if (signals) signals.textContent = String(NVN.events.length);
    const protectedEl = document.getElementById('neuralProtectedCount'); if (protectedEl) protectedEl.textContent = String(protectedN + protectedBranches);
    const recovery = document.getElementById('neuralRecoveryState');
    const recoveryHint = document.getElementById('neuralRecoveryHint');
    if (recovery) { recovery.textContent = hasSnapshot ? 'Reference captured' : 'Recovery gap'; const card = recovery.closest('.neural-kpi'); if (card) card.dataset.level = hasSnapshot ? 'good' : 'warning'; }
    if (recoveryHint) recoveryHint.textContent = hasSnapshot ? `${latestSigned ? 'Signed' : 'Local'} snapshot ${timeAgoN(latestSigned ? latestSigned.createdAt : d.storedSnapshot.capturedAt)}` : 'Capture refs before an incident';
    document.body.classList.toggle('neural-emergency-active', !!(d.safety.readOnly && d.safety.freezeSync));
    NVN.emergency = !!(d.safety.readOnly && d.safety.freezeSync);
    const roBtn = document.getElementById('neuralReadOnlyBtn');
    if (roBtn) roBtn.textContent = d.safety.readOnly ? 'Disable read-only' : 'Enable read-only';
    const liveBtn = document.getElementById('neuralLiveBtn');
    if (liveBtn) { liveBtn.disabled = !d.live.available; liveBtn.textContent = d.live.connected ? 'Disconnect verified live events' : 'Connect verified live events'; liveBtn.title = d.live.available ? '' : (d.live.reason || 'Neon and GitHub are required'); }
  }

  function updateVisibleCount() {
    const count = visibleNodes().length;
    const label = document.getElementById('neuralStreamLabel');
    if (label && !NVN.loading) label.textContent = NVN.paused ? `PAUSED · ${count} NODES` : `${NVN.data && NVN.data.live && NVN.data.live.connected ? 'VERIFIED LIVE' : 'POLLING'} · ${count} NODES`;
  }

  function setStream(label, live) {
    const wrap = document.querySelector('.neural-stream-state');
    const txt = document.getElementById('neuralStreamLabel');
    if (txt) txt.textContent = label;
    if (wrap) wrap.classList.toggle('paused', !live);
  }

  function setup() {
    if (NVN.canvas) return;
    NVN.canvas = document.getElementById('neuralCanvas');
    if (!NVN.canvas) return;
    NVN.ctx = NVN.canvas.getContext('2d', { alpha: true });
    makeStars();
    bindUI();
    bindCanvas();
    NVN.resizeObserver = new ResizeObserver(() => resize());
    const stage = document.getElementById('neuralStage');
    if (stage) NVN.resizeObserver.observe(stage);
    resize();
  }

  function makeStars() {
    const rng = mulberry32(0x4e564e);
    NVN.stars = Array.from({ length: 90 }, () => ({ x: rng(), y: rng(), r: .3 + rng() * 1.1, a: .12 + rng() * .38, phase: rng() * Math.PI * 2 }));
  }
  function mulberry32(seed) { return function () { let t = seed += 0x6D2B79F5; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

  function resize() {
    if (!NVN.canvas) return;
    const rect = NVN.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    NVN.dpr = Math.min(window.devicePixelRatio || 1, 2);
    NVN.width = rect.width; NVN.height = rect.height;
    const w = Math.round(rect.width * NVN.dpr), h = Math.round(rect.height * NVN.dpr);
    if (NVN.canvas.width !== w || NVN.canvas.height !== h) { NVN.canvas.width = w; NVN.canvas.height = h; }
  }

  function worldToScreen(x, y) {
    return { x: NVN.width / 2 + NVN.panX + x * NVN.zoom, y: NVN.height / 2 + NVN.panY + y * NVN.zoom };
  }
  function screenToWorld(x, y) {
    return { x: (x - NVN.width / 2 - NVN.panX) / NVN.zoom, y: (y - NVN.height / 2 - NVN.panY) / NVN.zoom };
  }

  function animate(now = performance.now()) {
    /* the loop owns its own life: when the panel is not visible it ends rather than
       idling at 60fps for the rest of the session (battery + iOS renderer pressure) */
    if (!NVN.active || !NVN.ctx || !NVN.canvas || document.visibilityState !== 'visible') { NVN.raf = 0; return; }
    NVN.raf = requestAnimationFrame(animate);
    const dt = Math.min(40, now - NVN.lastFrame); NVN.lastFrame = now;
    draw(now, dt);
  }
  function startLoop() {
    if (NVN.raf || !NVN.active || document.visibilityState !== 'visible') return;
    NVN.lastFrame = performance.now();
    NVN.raf = requestAnimationFrame(animate);
  }
  function stopLoop() {
    if (NVN.raf) cancelAnimationFrame(NVN.raf);
    NVN.raf = 0;
  }

  function draw(now) {
    const ctx = NVN.ctx, dpr = NVN.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, NVN.width, NVN.height);
    drawBackdrop(ctx, now);
    const byId = new Map(NVN.nodes.map(n => [n.id, n]));
    const selectedRelated = NVN.selected ? new Set(NVN.edges.filter(e => e.source === NVN.selected.id || e.target === NVN.selected.id).flatMap(e => [e.source, e.target])) : null;
    const related = NVN.highlightNodes.size ? NVN.highlightNodes : selectedRelated;

    for (const e of NVN.edges) {
      if (!e.visible) continue;
      const a = byId.get(e.source), b = byId.get(e.target); if (!a || !b) continue;
      const p1 = worldToScreen(a.x, a.y), p2 = worldToScreen(b.x, b.y);
      const selectedEdge = NVN.highlightEdges.has(e.id) || (NVN.selected && (e.source === NVN.selected.id || e.target === NVN.selected.id));
      const dim = related && !selectedEdge;
      drawEdge(ctx, e, p1, p2, now, selectedEdge, dim);
    }
    for (const n of NVN.nodes) {
      if (!n.visible) continue;
      const p = worldToScreen(n.x, n.y);
      if (p.x < -80 || p.x > NVN.width + 80 || p.y < -80 || p.y > NVN.height + 80) continue;
      const dim = related && !related.has(n.id);
      drawNode(ctx, n, p, now, dim);
    }
  }

  function drawBackdrop(ctx, now) {
    const grad = ctx.createRadialGradient(NVN.width * .5, NVN.height * .47, 0, NVN.width * .5, NVN.height * .47, Math.max(NVN.width, NVN.height) * .65);
    grad.addColorStop(0, 'rgba(105,82,255,.075)'); grad.addColorStop(.45, 'rgba(24,24,66,.035)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad; ctx.fillRect(0, 0, NVN.width, NVN.height);
    for (const s of NVN.stars) {
      const alpha = s.a * (.72 + Math.sin(now * .0007 + s.phase) * .28);
      ctx.beginPath(); ctx.fillStyle = `rgba(218,224,255,${alpha})`; ctx.arc(s.x * NVN.width, s.y * NVN.height, s.r, 0, Math.PI * 2); ctx.fill();
    }
  }

  function drawEdge(ctx, edge, p1, p2, now, selected, dim) {
    const sevColor = edge.severity === 'critical' ? '#ff5470' : edge.severity === 'warning' ? '#ffbd59' : '#7c8fbf';
    const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const curve = Math.min(34, len * .12) * (((hashCode(edge.id) & 1) ? 1 : -1));
    const cx = mx - dy / len * curve, cy = my + dx / len * curve;
    ctx.save();
    ctx.globalAlpha = dim ? .08 : selected ? .86 : .24;
    ctx.lineWidth = selected ? 1.7 : .75;
    ctx.strokeStyle = sevColor;
    ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.quadraticCurveTo(cx, cy, p2.x, p2.y); ctx.stroke();
    if (!NVN.paused && !dim) {
      const base = (hashCode(edge.id) % 1000) / 1000;
      const speed = edge.severity === 'critical' ? .00023 : .00012;
      const t = (base + now * speed) % 1;
      const one = 1 - t;
      const x = one * one * p1.x + 2 * one * t * cx + t * t * p2.x;
      const y = one * one * p1.y + 2 * one * t * cy + t * t * p2.y;
      const pulse = ctx.createRadialGradient(x, y, 0, x, y, selected ? 9 : 6);
      pulse.addColorStop(0, '#fff'); pulse.addColorStop(.28, sevColor); pulse.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.globalAlpha = selected ? .95 : .72; ctx.fillStyle = pulse; ctx.beginPath(); ctx.arc(x, y, selected ? 9 : 6, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  function drawNode(ctx, node, p, now, dim) {
    const selected = NVN.highlightNodes.has(node.id) || (NVN.selected && NVN.selected.id === node.id);
    const hover = NVN.hover && NVN.hover.id === node.id;
    const eventHot = NVN.timelineIndex >= 0 && NVN.events[NVN.timelineIndex] && NVN.events[NVN.timelineIndex].nodeId === node.id;
    let radius = node.r * NVN.zoom;
    radius = clamp(radius, node.type === 'repo' ? 16 : 7, node.type === 'repo' ? 31 : 19);
    if (hover || selected || eventHot) radius *= 1.14;
    const severityColor = node.severity === 'critical' ? '#ff5470' : node.severity === 'warning' ? '#ffbd59' : node.color;
    ctx.save();
    ctx.globalAlpha = dim ? .14 : 1;
    const auraR = radius * (selected ? 3.0 : node.severity === 'critical' ? 2.5 : 2.0);
    const aura = ctx.createRadialGradient(p.x, p.y, radius * .2, p.x, p.y, auraR);
    aura.addColorStop(0, hexAlpha(severityColor, selected ? .38 : .23)); aura.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = aura; ctx.beginPath(); ctx.arc(p.x, p.y, auraR, 0, Math.PI * 2); ctx.fill();
    if (node.severity === 'critical' || eventHot || selected) {
      const wave = radius * (1.42 + (.5 + Math.sin(now * .004 + hashCode(node.id)) * .5) * .55);
      ctx.strokeStyle = hexAlpha(severityColor, selected ? .5 : .26); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(p.x, p.y, wave, 0, Math.PI * 2); ctx.stroke();
    }
    const fill = ctx.createRadialGradient(p.x - radius * .28, p.y - radius * .3, radius * .08, p.x, p.y, radius);
    fill.addColorStop(0, '#ffffff'); fill.addColorStop(.13, node.color); fill.addColorStop(.54, darken(node.color, .38)); fill.addColorStop(1, darken(node.color, .68));
    ctx.shadowColor = severityColor; ctx.shadowBlur = selected ? 24 : 12;
    ctx.fillStyle = fill; ctx.beginPath(); ctx.arc(p.x, p.y, radius, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0; ctx.strokeStyle = selected ? '#fff' : hexAlpha(severityColor, .62); ctx.lineWidth = selected ? 1.8 : .75; ctx.stroke();
    ctx.fillStyle = node.type === 'repo' ? '#fff' : 'rgba(255,255,255,.9)';
    ctx.font = `${Math.max(7, radius * .57)}px 'Public Sans Variable', system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(node.glyph, p.x, p.y + .3);
    const shouldLabel = selected || hover || eventHot || node.type === 'repo' || node.match || (NVN.zoom > 1.18 && radius > 8);
    if (shouldLabel) drawNodeLabel(ctx, node, p, radius, dim);
    ctx.restore();
  }

  function drawNodeLabel(ctx, node, p, radius, dim) {
    const text = short(node.label, node.type === 'repo' ? 36 : 28);
    ctx.font = `${node.type === 'repo' ? '600 11px' : '500 9px'} 'Public Sans Variable', system-ui, sans-serif`;
    const width = ctx.measureText(text).width + 13;
    const y = p.y + radius + 9;
    ctx.globalAlpha = dim ? .12 : .92;
    ctx.fillStyle = 'rgba(8,8,24,.78)';
    roundRect(ctx, p.x - width / 2, y - 8, width, 16, 6); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.09)'; ctx.lineWidth = .7; ctx.stroke();
    ctx.fillStyle = '#f0f2ff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, p.x, y);
  }

  function roundRect(ctx, x, y, w, h, r) {
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); return; }
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function hexAlpha(hex, alpha) {
    const h = hex.replace('#', ''); const v = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
    return `rgba(${v >> 16},${(v >> 8) & 255},${v & 255},${alpha})`;
  }
  function darken(hex, amount) {
    const h = hex.replace('#', ''); let v = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
    const f = 1 - amount; return `rgb(${Math.round((v >> 16) * f)},${Math.round(((v >> 8) & 255) * f)},${Math.round((v & 255) * f)})`;
  }

  function bindCanvas() {
    const c = NVN.canvas;
    const pts = new Map();            /* live pointers → pinch / two-finger pan */
    let pinchDist = 0, lastTap = 0;
    const twoFinger = () => pts.size >= 2;
    const pair = () => { const [a, b] = [...pts.values()]; return { a, b }; };
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    c.addEventListener('pointerdown', e => {
      c.setPointerCapture(e.pointerId);
      const pos = pointerPos(e);
      pts.set(e.pointerId, pos);
      if (twoFinger()) {
        /* second finger down: hand over to pinch, cancel any drag/pan in progress */
        const { a, b } = pair(); pinchDist = dist(a, b);
        NVN.dragging = null; NVN.panning = false; NVN.pointerStart = null;
        return;
      }
      const hit = hitNode(pos.x, pos.y);
      NVN.pointerStart = { x: pos.x, y: pos.y, panX: NVN.panX, panY: NVN.panY };
      NVN.lastPointer = pos;
      if (hit) { NVN.dragging = hit; selectNode(hit); }
      else { NVN.panning = true; selectNode(null); }
    });
    c.addEventListener('pointermove', e => {
      const pos = pointerPos(e); NVN.lastPointer = pos;
      if (pts.has(e.pointerId)) pts.set(e.pointerId, pos);
      if (twoFinger()) {
        const { a, b } = pair();
        const d = dist(a, b), m = mid(a, b);
        if (pinchDist > 0 && d > 0) {
          const before = screenToWorld(m.x, m.y);
          NVN.zoom = clamp(NVN.zoom * (d / pinchDist), .42, 2.6);
          const after = worldToScreen(before.x, before.y);
          NVN.panX += m.x - after.x; NVN.panY += m.y - after.y;   /* keeps the pinch centre pinned */
        }
        pinchDist = d;
        return;
      }
      if (NVN.dragging) {
        const w = screenToWorld(pos.x, pos.y); NVN.dragging.x = w.x; NVN.dragging.y = w.y; NVN.dragging.vx = NVN.dragging.vy = 0;
      } else if (NVN.panning && NVN.pointerStart) {
        NVN.panX = NVN.pointerStart.panX + pos.x - NVN.pointerStart.x;
        NVN.panY = NVN.pointerStart.panY + pos.y - NVN.pointerStart.y;
      } else {
        const hit = hitNode(pos.x, pos.y); NVN.hover = hit; c.style.cursor = hit ? 'pointer' : 'grab';
      }
    });
    const up = e => {
      try { c.releasePointerCapture(e.pointerId); } catch {}
      pts.delete(e.pointerId);
      if (pts.size < 2) pinchDist = 0;
      if (e.type === 'pointerup' && e.pointerType !== 'mouse' && !NVN.dragging && pts.size === 0) {
        const now = performance.now();
        if (now - lastTap < 320) { fitGraph(true); lastTap = 0; } else lastTap = now;   /* double-tap to fit */
      }
      NVN.dragging = null; NVN.panning = false; NVN.pointerStart = null;
    };
    c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up);
    c.addEventListener('wheel', e => {
      e.preventDefault();
      const pos = pointerPos(e); const before = screenToWorld(pos.x, pos.y);
      NVN.zoom = clamp(NVN.zoom * Math.exp(-e.deltaY * .0012), .42, 2.6);
      const after = worldToScreen(before.x, before.y);
      NVN.panX += pos.x - after.x; NVN.panY += pos.y - after.y;
    }, { passive: false });
    c.addEventListener('dblclick', () => fitGraph(true));
    c.addEventListener('keydown', e => {
      if (e.key === 'Escape') selectNode(null);
      if (e.key === '+' || e.key === '=') NVN.zoom = clamp(NVN.zoom * 1.15, .42, 2.6);
      if (e.key === '-') NVN.zoom = clamp(NVN.zoom / 1.15, .42, 2.6);
      if (e.key.toLowerCase() === 'f') fitGraph(true);
    });
  }
  function pointerPos(e) { const r = NVN.canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  function hitNode(sx, sy) {
    let best = null, bestD = Infinity;
    for (const n of NVN.nodes) {
      if (!n.visible) continue;
      const p = worldToScreen(n.x, n.y); const dx = p.x - sx, dy = p.y - sy;
      const r = clamp(n.r * NVN.zoom, 9, 30) + 7; const d = dx * dx + dy * dy;
      if (d < r * r && d < bestD) { best = n; bestD = d; }
    }
    return best;
  }

  function fitGraph(animateFit = true) {
    const nodes = visibleNodes(); if (!nodes.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) { minX = Math.min(minX, n.x - 30); maxX = Math.max(maxX, n.x + 30); minY = Math.min(minY, n.y - 30); maxY = Math.max(maxY, n.y + 30); }
    const targetZoom = clamp(Math.min((NVN.width - 70) / Math.max(1, maxX - minX), (NVN.height - 100) / Math.max(1, maxY - minY)), .48, 1.45);
    const targetPanX = -((minX + maxX) / 2) * targetZoom;
    const targetPanY = -((minY + maxY) / 2) * targetZoom + 10;
    if (!animateFit || !state.settings.motion) { NVN.zoom = targetZoom; NVN.panX = targetPanX; NVN.panY = targetPanY; return; }
    const start = { z: NVN.zoom, x: NVN.panX, y: NVN.panY }, t0 = performance.now();
    const tick = now => { const t = clamp((now - t0) / 320, 0, 1); const e = 1 - Math.pow(1 - t, 3); NVN.zoom = start.z + (targetZoom - start.z) * e; NVN.panX = start.x + (targetPanX - start.x) * e; NVN.panY = start.y + (targetPanY - start.y) * e; if (t < 1) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }

  function selectNode(node) {
    NVN.selected = node;
    renderInspector(node);
  }

  function renderInspector(node) {
    const host = document.getElementById('neuralInspectorBody'); if (!host) return;
    if (!node) {
      host.className = 'neural-inspector-empty';
      host.innerHTML = '<div class="neural-inspector-orb"></div><strong>Select a node</strong><p>Inspect relationships, evidence, risk and available response actions.</p>';
      return;
    }
    host.className = '';
    const st = TYPE_STYLE[node.type] || TYPE_STYLE.repo;
    const rels = NVN.edges.filter(e => e.source === node.id || e.target === node.id).map(e => {
      const other = nodeById(e.source === node.id ? e.target : e.source);
      return other ? `<div class="neural-rel"><b>${nEsc(e.type)}</b> · ${nEsc(other.label)}</div>` : '';
    }).filter(Boolean).slice(0, 12).join('');
    const metaPairs = Object.entries(node.meta || {}).filter(([k, v]) => v !== '' && v != null && typeof v !== 'object').slice(0, 6);
    const desc = node.meta.description || inspectorDescription(node);
    host.innerHTML = `
      ${node.severity === 'critical' ? '<div class="neural-report-banner"><b>Immediate attention recommended</b><p>This node participates in a critical security or operational signal.</p></div>' : ''}
      <div class="neural-inspector-head"><div class="neural-node-icon" style="color:${nEsc(node.color)}">${nEsc(node.glyph)}</div><div><h3>${nEsc(node.label)}</h3><p>${nEsc(st.label)}</p></div></div>
      <span class="neural-risk-pill ${nEsc(node.severity)}">${node.severity === 'critical' ? '● Critical signal' : node.severity === 'warning' ? '● Review recommended' : '● Normal signal'}</span>
      <p class="neural-inspector-copy">${nEsc(desc)}</p>
      <div class="neural-inspector-grid">${metaPairs.map(([k, v]) => `<div class="neural-inspector-stat"><span>${nEsc(k.replace(/([A-Z])/g, ' $1'))}</span><b>${nEsc(short(v, 34))}</b></div>`).join('')}</div>
      <div class="neural-panel-title">Relationships · ${NVN.edges.filter(e => e.source === node.id || e.target === node.id).length}</div>
      <div class="neural-rel-list">${rels || '<div class="neural-rel">No visible relationships in this mode.</div>'}</div>
      <div class="neural-panel-title">Available actions</div>
      <div class="neural-inspector-actions">${inspectorActions(node)}</div>`;
  }

  function inspectorDescription(node) {
    return {
      repo: 'Central node connecting repository activity, protection, dependencies and recovery state.',
      branch: 'A mutable Git reference. Protected branches reduce the risk of destructive direct changes.',
      commit: 'A historical repository change observed during the selected activity window.',
      workflow: 'A CI/CD execution connected to a branch or commit.',
      vulnerability: 'A known advisory affecting a dependency version found in the repository manifest.',
      protected: 'A path guarded by the Nebulaverse-X protected-file policy.',
      snapshot: 'A retained reference manifest used for rapid repository-state recovery.',
      session: 'An authenticated Nebulaverse-X session associated with this identity.',
      credential: 'A repository deploy key. Writable keys represent a direct non-human modification path.',
      integration: 'A repository webhook integration and its destination security posture.'
    }[node.type] || 'Repository intelligence object correlated by the Neural Command Center.';
  }

  function inspectorActions(node) {
    const buttons = [];
    if (node.type === 'protected' && node.meta.path) buttons.push(`<button class="btn btn-ghost small" data-neural-action="open-file" data-path="${nEsc(node.meta.path)}">Open protected file</button>`);
    if (node.type === 'branch') buttons.push(`<button class="btn btn-ghost small" data-neural-action="branch" data-branch="${nEsc(node.label)}">Switch to this branch</button>`);
    if (node.type === 'commit') buttons.push('<button class="btn btn-ghost small" data-neural-action="commits">Open commit history</button>');
    if (node.type === 'pull') buttons.push('<button class="btn btn-ghost small" data-neural-action="pulls">Open pull requests</button>');
    if (node.type === 'issue') buttons.push('<button class="btn btn-ghost small" data-neural-action="issues">Open issues</button>');
    if (node.type === 'workflow') {
      buttons.push('<button class="btn btn-ghost small" data-neural-action="actions">Open workflow runs</button>');
      if (node.meta.url) buttons.push(`<button class="btn btn-ghost small" data-neural-action="external-url" data-url="${nEsc(node.meta.url)}">Open on provider</button>`);
    }
    if (node.type === 'package' || node.type === 'vulnerability' || node.type === 'scan') buttons.push('<button class="btn btn-ghost small" data-neural-action="security-scan">Run full dependency scan</button>');
    if (node.type === 'snapshot') buttons.push('<button class="btn btn-ghost small" data-neural-action="snapshot">Capture fresh references</button><button class="btn btn-ghost small" data-neural-action="recovery-preview">Preview recovery impact</button><button class="btn btn-ghost small" data-neural-action="recovery">Open recovery workflow</button>');
    if (node.type === 'safety' || node.type === 'repo' || node.type === 'protected') buttons.push('<button class="btn btn-ghost small" data-neural-action="safeguards">Open safeguards</button>');
    if (node.type === 'session' || node.type === 'user') buttons.push('<button class="btn btn-ghost small" data-neural-action="revoke">Revoke other sessions</button>');
    buttons.push(`<button class="btn btn-ghost small" data-neural-action="explain">${NVN.explainStart ? 'Explain from selected start' : 'Use for connection path'}</button>`);
    if (!buttons.length) buttons.push('<button class="btn btn-ghost small" data-neural-action="refresh">Refresh intelligence</button>');
    return buttons.join('');
  }

  function closeLiveStream() {
    if (NVN.eventSource) { try { NVN.eventSource.close(); } catch {} }
    NVN.eventSource = null; NVN.eventSourceKey = '';
  }

  async function catchUpIntelligence() {
    if (!NVN.active || !state || !state.work || !NVN.data || NVN.catchUpBusy) return;
    NVN.catchUpBusy = true;
    try {
      const existing = ((NVN.data.intelligence || {}).events || []);
      const merged = new Map(existing.filter(event => event && event.id).map(event => [event.id, event]));
      let after = NVN.intelligenceCursor || (NVN.data.intelligence && NVN.data.intelligence.cursor) || '';
      let available = true;
      let pages = 0;
      while (pages < 5) {
        const query = after ? `&after=${encodeURIComponent(after)}` : '';
        const page = await api(`/api/repo/${workPath()}/intelligence/events?limit=500${query}`);
        available = page.available !== false;
        for (const event of page.events || []) if (event && event.id) merged.set(event.id, event);
        const next = String(page.cursor || '');
        if (next) { after = next; NVN.intelligenceCursor = next; }
        pages += 1;
        if (!page.hasMore || !next) break;
      }
      const events = [...merged.values()]
        .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0) || String(a.id).localeCompare(String(b.id)))
        .slice(-1500);
      NVN.data.intelligence = { available, events, cursor: NVN.intelligenceCursor, hasMore: false };
      buildGraph(NVN.data);
      updateSummary();
      updateTimeline(true);
      applyMode();
    } catch (error) {
      console.warn('Neural intelligence catch-up failed', error && error.message);
    } finally { NVN.catchUpBusy = false; }
  }

  function ensureLiveStream() {
    const connected = !!(NVN.data && NVN.data.live && NVN.data.live.connected);
    const key = `${workPath()}:${connected}`;
    if (!NVN.active || !connected || typeof EventSource === 'undefined') { closeLiveStream(); return; }
    if (NVN.eventSource && NVN.eventSourceKey === key) return;
    closeLiveStream();
    const source = new EventSource(`/api/repo/${workPath()}/live-events/stream`);
    NVN.eventSource = source; NVN.eventSourceKey = key;
    source.addEventListener('ready', () => { setStream('VERIFIED LIVE', true); catchUpIntelligence(); });
    source.addEventListener('session-revoked', async () => {
      try { await window.NebulaPwa?.purgePrivateData(true); } catch {}
      closeLiveStream();
      location.reload();
    });
    source.addEventListener('intelligence', e => {
      let event = null; try { event = JSON.parse(e.data); } catch {}
      if (event && event.severity === 'critical' && typeof toast === 'function') toast(`Critical verified event: ${event.summary}`, 'err');
      clearTimeout(NVN.liveReloadTimer);
      NVN.liveReloadTimer = setTimeout(() => { if (NVN.active) catchUpIntelligence(); }, 250);
    });
    source.onerror = () => {
      setStream('LIVE RECONNECTING', false);
      clearTimeout(NVN.liveReloadTimer);
      NVN.liveReloadTimer = setTimeout(() => catchUpIntelligence(), 1200);
    };
  }

  async function liveConnectionFlow() {
    if (!NVN.data || !NVN.data.live || !NVN.data.live.available) {
      if (typeof toast === 'function') toast((NVN.data && NVN.data.live && NVN.data.live.reason) || 'Verified live events require Neon and a GitHub repository', 'err');
      return;
    }
    if (NVN.data.live.connected) {
      const ok = await modal({ title: 'Disconnect verified live events?', danger: true, okText: 'Disconnect', bodyHTML: '<p class="hint">Nebulaverse-X will remove its repository webhook. Existing evidence events remain in Neon.</p>' });
      if (!ok) return;
      await api(`/api/repo/${workPath()}/live-events`, { method: 'DELETE' });
      closeLiveStream();
      if (typeof toast === 'function') toast('Verified live events disconnected', 'ok');
      return load(true);
    }
    const ok = await modal({
      title: 'Connect verified live events', okText: 'Create GitHub webhook',
      bodyHTML: '<div class="neural-report-banner"><b>Signature-verified event stream</b><p>Nebulaverse-X creates a repository webhook for pushes, pull requests, workflows, issues, releases, references and deployments. Payloads are authenticated with HMAC-SHA256 and only a minimized event record is stored.</p></div><p class="hint">Your GitHub token needs repository administration access and <b>Webhooks: write</b>. No Render database or paid AI service is added.</p>'
    });
    if (!ok) return;
    try {
      await api(`/api/repo/${workPath()}/live-events/connect`, { method: 'POST', body: {} });
      if (typeof toast === 'function') toast('Verified live events connected', 'ok');
      await load(true);
    } catch (e) { if (typeof toast === 'function') toast(e.message, 'err'); }
  }

  function graphShortestPath(startId, endId) {
    const ids = new Set(NVN.nodes.map(n => n.id));
    if (!ids.has(startId) || !ids.has(endId)) return null;
    const adjacency = new Map([...ids].map(id => [id, []]));
    NVN.edges.forEach(edge => {
      if (!ids.has(edge.source) || !ids.has(edge.target)) return;
      adjacency.get(edge.source).push({ next: edge.target, edge });
      adjacency.get(edge.target).push({ next: edge.source, edge: { ...edge, reversed: true } });
    });
    const queue = [startId], previous = new Map([[startId, null]]);
    while (queue.length) {
      const current = queue.shift();
      for (const step of adjacency.get(current) || []) {
        if (previous.has(step.next)) continue;
        previous.set(step.next, { node: current, edge: step.edge });
        if (step.next === endId) {
          const nodeIds = [endId], pathEdges = []; let at = endId;
          while (at !== startId) { const p = previous.get(at); pathEdges.unshift(p.edge); at = p.node; nodeIds.unshift(at); }
          return { nodeIds, edges: pathEdges };
        }
        queue.push(step.next);
      }
    }
    return null;
  }

  async function explainFromSelected() {
    const node = NVN.selected;
    if (!node) { if (typeof toast === 'function') toast('Select a node first', 'err'); return; }
    if (!NVN.explainStart) {
      NVN.explainStart = node.id;
      NVN.highlightNodes = new Set([node.id]); NVN.highlightEdges = new Set();
      if (typeof toast === 'function') toast(`Connection start: ${node.label}. Select another node and press Explain.`, 'ok');
      renderInspector(node); return;
    }
    if (NVN.explainStart === node.id) {
      NVN.explainStart = null; NVN.highlightNodes.clear(); NVN.highlightEdges.clear();
      if (typeof toast === 'function') toast('Connection selection cleared', 'ok');
      renderInspector(node); return;
    }
    const result = graphShortestPath(NVN.explainStart, node.id);
    const startNode = nodeById(NVN.explainStart);
    if (!result) { if (typeof toast === 'function') toast('No relationship path was found in the current graph', 'err'); return; }
    NVN.highlightNodes = new Set(result.nodeIds);
    NVN.highlightEdges = new Set(result.edges.map(e => e.id));
    const steps = result.edges.map((edge, i) => {
      const from = nodeById(result.nodeIds[i]), to = nodeById(result.nodeIds[i + 1]);
      const direction = edge.reversed ? `${to && to.label} ← ${edge.type} ← ${from && from.label}` : `${from && from.label} → ${edge.type} → ${to && to.label}`;
      return `<div class="neural-rel"><b>${i + 1}.</b> ${nEsc(direction)}${edge.meta && edge.meta.verified ? ' <span class="neural-risk-pill normal">verified</span>' : ''}</div>`;
    }).join('');
    const critical = result.edges.filter(e => e.severity === 'critical').length;
    await modal({
      title: 'Explain this connection', okText: 'Keep path highlighted',
      bodyHTML: `<div class="neural-report-banner"><b>${nEsc(startNode && startNode.label)} → ${nEsc(node.label)}</b><p>${result.edges.length} relationship step(s) · ${critical} critical edge(s). This explanation is deterministic and uses the graph evidence—no AI API.</p></div><div class="neural-rel-list" style="margin-top:10px">${steps}</div>`
    });
    NVN.explainStart = null;
    renderInspector(node);
  }

  function bindUI() {
    document.getElementById('neuralModeList')?.addEventListener('click', e => {
      const b = e.target.closest('[data-neural-mode]'); if (!b) return;
      NVN.mode = b.dataset.neuralMode;
      document.querySelectorAll('[data-neural-mode]').forEach(x => x.classList.toggle('active', x === b));
      applyMode(); fitGraph(true);
    });
    document.querySelectorAll('[data-neural-filter]').forEach(cb => cb.addEventListener('change', () => { NVN.filters[cb.dataset.neuralFilter] = cb.checked; applyMode(); }));
    document.getElementById('neuralSearch')?.addEventListener('input', e => {
      NVN.search = e.target.value; applyMode();
      const matches = visibleNodes(); if (NVN.search && matches.length) { selectNode(matches[0]); centerNode(matches[0]); }
    });
    document.getElementById('neuralLiveBtn')?.addEventListener('click', liveConnectionFlow);
    document.getElementById('neuralRefreshBtn')?.addEventListener('click', () => load(true));
    document.getElementById('neuralFitBtn')?.addEventListener('click', () => fitGraph(true));
    document.getElementById('neuralPlayBtn')?.addEventListener('click', togglePause);
    document.getElementById('neuralExplainBtn')?.addEventListener('click', explainFromSelected);
    document.getElementById('neuralDemoBtn')?.addEventListener('click', () => injectDemo(false));
    document.getElementById('neuralEmergencyBtn')?.addEventListener('click', emergencyShield);
    document.getElementById('neuralReadOnlyBtn')?.addEventListener('click', toggleReadOnly);
    document.getElementById('neuralSnapshotBtn')?.addEventListener('click', async () => { await captureSnapshot(false); await load(true); });
    document.getElementById('neuralSecurityScanBtn')?.addEventListener('click', () => typeof securityScanFlow === 'function' && securityScanFlow());
    document.getElementById('neuralExportBtn')?.addEventListener('click', () => typeof exportActivityFlow === 'function' && exportActivityFlow());
    document.getElementById('neuralTimeline')?.addEventListener('input', e => setTimeline(+e.target.value));
    document.getElementById('neuralPrevEvent')?.addEventListener('click', () => setTimeline(Math.max(0, NVN.timelineIndex - 1)));
    document.getElementById('neuralNextEvent')?.addEventListener('click', () => setTimeline(Math.min(NVN.events.length - 1, NVN.timelineIndex + 1)));
    document.getElementById('neuralEventStrip')?.addEventListener('click', e => { const c = e.target.closest('[data-event-index]'); if (c) setTimeline(+c.dataset.eventIndex); });
    document.getElementById('neuralInspector')?.addEventListener('click', inspectorClick);
  }

  function centerNode(node) {
    if (!node) return;
    NVN.panX = -node.x * NVN.zoom; NVN.panY = -node.y * NVN.zoom;
  }
  function togglePause() {
    NVN.paused = !NVN.paused;
    const b = document.getElementById('neuralPlayBtn'); if (b) b.innerHTML = NVN.paused
      ? '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4l13 8-13 8z" fill="currentColor" stroke="none"/></svg>'
      : '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4h3v16H8zM13 4h3v16h-3z" fill="currentColor" stroke="none"/></svg>';
    setStream(NVN.paused ? 'PAUSED' : 'LIVE TOPOLOGY', !NVN.paused); updateVisibleCount();
  }

  async function inspectorClick(e) {
    const b = e.target.closest('[data-neural-action]'); if (!b) return;
    const action = b.dataset.neuralAction;
    if (action === 'open-file' && typeof openFile === 'function') { switchTab('editor'); openFile(b.dataset.path); }
    else if (action === 'branch') switchBranchFromGraph(b.dataset.branch);
    else if (['commits', 'pulls', 'issues', 'actions'].includes(action)) switchTab(action);
    else if (action === 'security-scan' && typeof securityScanFlow === 'function') securityScanFlow();
    else if (action === 'snapshot') { await captureSnapshot(false); await load(true); }
    else if (action === 'recovery-preview') previewSelectedRecovery();
    else if (action === 'recovery' && typeof recoveryFlow === 'function') recoveryFlow();
    else if (action === 'safeguards' && typeof openSafeguards === 'function') openSafeguards();
    else if (action === 'revoke') revokeOtherSessions(true);
    else if (action === 'external-url' && /^https:\/\//.test(b.dataset.url || '')) window.open(b.dataset.url, '_blank', 'noopener');
    else if (action === 'explain') explainFromSelected();
    else if (action === 'refresh') load(true);
  }

  function switchBranchFromGraph(name) {
    const select = document.getElementById('branchSelect');
    if (!select || ![...select.options].some(o => o.value === name)) { if (typeof toast === 'function') toast('Branch is not available in the current selector', 'err'); return; }
    select.value = name; select.dispatchEvent(new Event('change', { bubbles: true })); switchTab('editor');
  }

  function updateTimeline(toLatest) {
    const range = document.getElementById('neuralTimeline');
    if (!range) return;
    range.max = Math.max(0, NVN.events.length - 1);
    if (toLatest) NVN.timelineIndex = NVN.events.length - 1;
    NVN.timelineIndex = clamp(NVN.timelineIndex, NVN.events.length ? 0 : -1, NVN.events.length - 1);
    range.value = Math.max(0, NVN.timelineIndex);
    renderEventStrip(); updateTimelineCaption();
  }
  function setTimeline(index) {
    if (!NVN.events.length) return;
    NVN.timelineIndex = clamp(index, 0, NVN.events.length - 1);
    const range = document.getElementById('neuralTimeline'); if (range) range.value = NVN.timelineIndex;
    const ev = NVN.events[NVN.timelineIndex], node = nodeById(ev.nodeId);
    if (node && node.visible) { selectNode(node); centerNode(node); }
    renderEventStrip(); updateTimelineCaption();
  }
  function updateTimelineCaption() {
    const cap = document.getElementById('neuralTimelineCaption');
    if (!cap) return;
    const ev = NVN.events[NVN.timelineIndex];
    cap.textContent = ev ? `${ev.label} · ${timeAgoN(ev.time)}` : 'No activity events available';
  }
  function renderEventStrip() {
    const host = document.getElementById('neuralEventStrip'); if (!host) return;
    if (!NVN.events.length) { host.innerHTML = '<div class="neural-event-card"><b>No events</b><small>Refresh or use demo mode</small></div>'; return; }
    const start = clamp(NVN.timelineIndex - 3, 0, Math.max(0, NVN.events.length - 6));
    const slice = NVN.events.slice(start, start + 6);
    host.innerHTML = slice.map((ev, i) => `<button class="neural-event-card ${start + i === NVN.timelineIndex ? 'active' : ''}" data-event-index="${start + i}"><b>${nEsc(ev.label)}</b><small>${nEsc(ev.type)} · ${nEsc(timeAgoN(ev.time))}</small></button>`).join('');
  }

  async function toggleReadOnly() {
    if (!NVN.data) return;
    const next = !NVN.data.safety.readOnly;
    try {
      await setSafety({ readOnly: next });
      if (typeof toast === 'function') toast(next ? 'Read-only containment enabled' : 'Read-only mode disabled', 'ok');
      await load(true);
    } catch (e) { if (typeof toast === 'function') toast(e.message, 'err'); }
  }

  async function previewSelectedRecovery() {
    const signed = NVN.data && NVN.data.signedSnapshots && NVN.data.signedSnapshots.snapshots && NVN.data.signedSnapshots.snapshots[0];
    const snapshot = signed && signed.snapshot || (NVN.data && NVN.data.storedSnapshot);
    if (!snapshot) { if (typeof toast === 'function') toast('Capture a recovery snapshot first', 'err'); return; }
    try {
      const preview = await api(`/api/repo/${workPath()}/restore-preview`, { method: 'POST', body: { snapshot } });
      const c = preview.counts || {};
      await modal({
        title: 'Recovery impact preview', okText: 'Close',
        bodyHTML: `<div class="neural-report-banner"><b>No repository changes were made.</b><p>${c.refsToMove || 0} branch(es) would move, ${c.refsToRecreate || 0} would be recreated and ${c.newerRefsPreserved || 0} newer branch(es) would be preserved.</p></div>
          <p class="hint">Files changed since the snapshot: ${c.filesModified || 0} modified, ${c.filesToRestore || 0} missing from the current tree, ${c.newerFilesPreserved || 0} newer file(s) preserved.</p>
          ${(preview.warnings || []).map(warning => `<p class="hint">⚠ ${nEsc(warning)}</p>`).join('')}`
      });
    } catch (error) { if (typeof toast === 'function') toast(error.message, 'err'); }
  }

  async function captureSnapshot(silent) {
    if (!state.work) return null;
    try {
      if (!silent && typeof toast === 'function') toast('Capturing branch refs and repository manifest…', 'ok');
      let signed = null;
      try { signed = await api(`/api/repo/${workPath()}/signed-snapshot`, { method: 'POST', body: { manifest: true } }); } catch {}
      const snap = signed && signed.snapshot ? signed.snapshot : await api(`/api/repo/${workPath()}/refs-snapshot?manifest=1`);
      const storageKey = `nv_snap_${state.work.owner}/${state.work.repo}`;
      try {
        localStorage.setItem(storageKey, JSON.stringify(snap));
      } catch {
        const compact = { ...snap, manifest: snap.manifest ? { branch: snap.manifest.branch, truncated: snap.manifest.truncated, fileCount: (snap.manifest.files || []).length } : null };
        try { localStorage.setItem(storageKey, JSON.stringify(compact)); } catch {}
      }
      if (!silent && typeof toast === 'function') toast(`${snap.refs.length} refs captured${signed ? ' and cryptographically signed' : ''} for recovery`, 'ok');
      return snap;
    } catch (e) { if (!silent && typeof toast === 'function') toast(e.message, 'err'); throw e; }
  }

  async function revokeOtherSessions(showResult) {
    try {
      const out = await stepUpApi('sessions.revoke-others', {}, '/api/security/revoke-others', {
        method: 'POST', body: { confirm: true }
      }, 'Revoke every other active session');
      if (!out) return { available: false, revoked: 0, cancelled: true };
      if (showResult && typeof modal === 'function') await modal({ title: 'Session containment', okText: 'Done', bodyHTML: `<p class="hint">${out.available ? `<b>${out.revoked}</b> other session(s) revoked for <span class="mono">${nEsc(out.login || '')}</span>.` : `Session inventory is unavailable because this deployment is using cookie-only sessions. Connect Neon to enable cross-device revocation.`}</p>` });
      return out;
    } catch (e) { if (showResult && typeof toast === 'function') toast(e.message, 'err'); return { available: false, revoked: 0, error: e.message }; }
  }

  async function emergencyShield() {
    if (!state.work || typeof modal !== 'function') return;
    const ok = await modal({
      title: 'Activate Emergency Shield', danger: true, okText: 'Contain incident',
      bodyHTML: `<div class="neural-report-banner"><b>This activates a signed server-side containment transaction.</b><p>Nebulaverse-X captures repository references and a file manifest, enables read-only mode, freezes synchronization, revokes other database-backed sessions and records tamper-evident evidence.</p></div>
        <label class="field-label">Type <span class="mono">FREEZE</span> to confirm</label><input id="neuralEmergencyConfirm" type="text" autocomplete="off" spellcheck="false" placeholder="FREEZE">
        <p class="hint">This is a Recovery Snapshot Lite and incident manifest. It is not a complete off-platform mirror of Git and LFS objects.</p>`
    });
    if (!ok) return;
    const confirm = document.getElementById('neuralEmergencyConfirm');
    if (!confirm || confirm.value.trim().toUpperCase() !== 'FREEZE') { if (typeof toast === 'function') toast('Emergency confirmation did not match', 'err'); return; }
    const button = document.getElementById('neuralEmergencyBtn'); if (button) button.disabled = true;
    setStream('CONTAINING INCIDENT', false);
    try {
      const [containment, activityResult] = await Promise.all([
        stepUpApi('sessions.revoke-others', {}, `/api/repo/${workPath()}/emergency-manifest`, {
          method: 'POST', body: { confirm: 'FREEZE' }
        }, 'Activate Emergency Shield and revoke other sessions'),
        api(`/api/repo/${workPath()}/activity?days=30`).catch(error => ({ error: error.message }))
      ]);
      if (!containment) {
        setStream('AUTHORIZATION CANCELLED', false);
        return;
      }
      const manifest = containment.manifest || {};
      try { await window.NebulaPwa?.purgePrivateData(false); } catch {}
      const report = {
        kind: 'nebulaverse-emergency-containment-report', version: 2, generatedAt: new Date().toISOString(),
        repository: `${state.work.owner}/${state.work.repo}`, branch: state.work.branch,
        manifestId: containment.manifestId || '', signature: containment.signature || '',
        persisted: !!containment.persisted, evidence: containment.evidence || null,
        controls: manifest.controls || {}, snapshot: manifest, activity: activityResult
      };
      try {
        localStorage.setItem(`nv_incident_${state.work.owner}/${state.work.repo}`, JSON.stringify(report));
        localStorage.setItem(`nv_snap_${state.work.owner}/${state.work.repo}`, JSON.stringify(manifest));
      } catch {
        const compact = { ...report, snapshot: { ...manifest, manifest: manifest.manifest ? { branch: manifest.manifest.branch, fileCount: (manifest.manifest.files || []).length, truncated: !!manifest.manifest.truncated } : null } };
        try { localStorage.setItem(`nv_incident_${state.work.owner}/${state.work.repo}`, JSON.stringify(compact)); } catch {}
      }
      if (typeof dlFile === 'function') {
        dlFile(`nebulaverse-emergency-${state.work.owner}-${state.work.repo}-${Date.now()}.json`, JSON.stringify(report, null, 2), 'application/json');
      }
      document.body.classList.add('neural-emergency-active');
      await load(true);
      const controls = manifest.controls || {};
      const refs = Array.isArray(manifest.refs) ? manifest.refs.length : 0;
      await modal({
        title: 'Emergency containment active', okText: 'Continue in read-only mode',
        bodyHTML: `<div class="neural-report-banner"><b>Containment was recorded as a signed emergency manifest.</b><p>Read-only mode and synchronization freeze are active. ${controls.sessionRevocationAvailable ? `${Number(controls.sessionsRevoked || 0)} other session(s) were revoked.` : 'Cross-device session revocation was unavailable in cookie-only mode.'}</p></div>
          <p class="hint">Reference snapshot: ${refs} branch ref(s) captured · ${containment.persisted ? 'stored in Neon' : 'downloaded locally'} · evidence ${containment.evidence ? 'recorded' : 'unavailable'}.</p>
          <p class="hint">Review the downloaded JSON evidence, protected files and recovery preview before making restore decisions.</p>`
      });
    } catch (e) { if (typeof toast === 'function') toast(`Emergency Shield failed: ${e.message}`, 'err'); }
    finally { if (button) button.disabled = false; }
  }

  function injectDemo(initialFallback) {
    if (!NVN.nodes.length || initialFallback) {
      NVN.data = { safety: { readOnly: false, freezeSync: false, protected: {} }, refs: { refs: [], tags: [] }, activity: { commits: [], pulls: [], issues: [], releases: [] }, deps: { scanned: 0, vulnerable: [], details: {}, sources: [], dependabot: { alerts: [] } }, actions: [], sessions: { sessions: [] }, scanner: { builtin: { available: true }, yara: { configured: false, required: false } }, storedSnapshot: null, errors: [] };
      const map = new Map(), edges = [], events = [];
      addNode(map, 'repo:current', 'repo', state.work ? `${state.work.owner}/${state.work.repo}` : 'nebulaverse/demo', { description: 'Demonstration repository topology.' });
      addNode(map, 'user:current', 'user', (state.me && state.me.login) || 'Operator', { description: 'Demonstration identity.' });
      addEdge(edges, 'user:current', 'repo:current', 'authenticated access');
      NVN.nodes = [...map.values()]; NVN.edges = edges; NVN.events = events;
    }
    const map = new Map(NVN.nodes.map(n => [n.id, n]));
    addNode(map, 'demo:session', 'session', 'Unrecognized session', { ip: '203.0.113.42', device: 'Unknown browser', description: 'Demonstration signal only — not a real session.' }, 'critical');
    addNode(map, 'demo:file', 'protected', '.github/workflows/deploy.yml', { path: '.github/workflows/deploy.yml', description: 'Demonstration protected workflow modification.' }, 'critical');
    addNode(map, 'demo:workflow', 'workflow', 'Production deploy', { status: 'in_progress', event: 'push', description: 'Demonstration workflow triggered by the protected-file change.' }, 'critical');
    addNode(map, 'demo:external', 'external', 'External production target', { destination: 'production', description: 'Demonstration external deployment destination.' }, 'critical');
    addEdge(NVN.edges, 'user:current', 'demo:session', 'opened suspicious session', 'critical');
    addEdge(NVN.edges, 'demo:session', 'repo:current', 'accessed repository', 'critical');
    addEdge(NVN.edges, 'repo:current', 'demo:file', 'modified protected asset', 'critical');
    addEdge(NVN.edges, 'demo:file', 'demo:workflow', 'triggered workflow', 'critical');
    addEdge(NVN.edges, 'demo:workflow', 'demo:external', 'deployed to', 'critical');
    NVN.nodes = [...map.values()];
    const t = Date.now();
    addEvent(NVN.events, 'demo', 'Unrecognized session', 'Demonstration incident injected', t - 5000, 'demo:session', '', 'critical');
    addEvent(NVN.events, 'demo', 'Protected workflow modified', '.github/workflows/deploy.yml', t - 3500, 'demo:file', '', 'critical');
    addEvent(NVN.events, 'demo', 'Production workflow triggered', 'Deployment path activated', t - 2000, 'demo:workflow', '', 'critical');
    addEvent(NVN.events, 'demo', 'External target contacted', 'Demonstration propagation path', t - 500, 'demo:external', '', 'critical');
    NVN.events.sort((a, b) => new Date(a.time) - new Date(b.time));
    NVN.demo = true; NVN.mode = 'security';
    document.querySelectorAll('[data-neural-mode]').forEach(x => x.classList.toggle('active', x.dataset.neuralMode === 'security'));
    assignLayout(); simulateLayout(90); applyMode(); updateTimeline(true); fitGraph(true);
    const sync = document.getElementById('neuralLastSync'); if (sync) sync.textContent = 'Demonstration incident · no provider changes';
    if (!initialFallback && typeof toast === 'function') toast('Demonstration incident injected — no repository was changed', 'ok');
  }

  function activate() {
    setup();
    NVN.active = true;
    startLoop();
    try {
      if (matchMedia('(pointer:coarse)').matches && !localStorage.getItem('nv_neural_hint')) {
        localStorage.setItem('nv_neural_hint', '1');
        if (typeof toast === 'function') toast('Pinch to zoom · drag to pan · double-tap to fit', 'ok');
      }
    } catch {}
    resize();
    load(false);
    clearInterval(NVN.refreshTimer);
    NVN.refreshTimer = setInterval(() => {
      if (NVN.active && !NVN.paused && document.visibilityState === 'visible' && typeof currentTab === 'function' && currentTab() === 'neural') load(true);
    }, 120000);
  }
  function deactivate() {
    NVN.active = false;
    stopLoop();
    clearInterval(NVN.refreshTimer);
    NVN.refreshTimer = 0;
    closeLiveStream();
  }

  document.addEventListener('visibilitychange', () => {
    NVN.active = document.visibilityState === 'visible' && typeof currentTab === 'function' && currentTab() === 'neural';
    if (NVN.active) { startLoop(); ensureLiveStream(); }
    else { stopLoop(); closeLiveStream(); }
  });
  window.addEventListener('resize', resize);
  window.NebulaNeural = { activate, deactivate, refresh: () => load(true), emergencyShield, injectDemo, state: NVN };
})();
