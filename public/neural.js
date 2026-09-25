/* ============================================================
   NEBULAVERSE NEURAL COMMAND CENTER — v5.2
   Functional repository topology built on Nebulaverse-X v5 data.
   ============================================================ */
'use strict';
(() => {
  const TYPE_STYLE = {
    repo:          { color: '#9a8cff', mark: 'star', radius: 22, label: 'Repository', plural: 'Repositories' },
    user:          { color: '#f3f5ff', glyph: 'U', radius: 13, label: 'Identity', plural: 'Identities' },
    session:       { color: '#61d8ff', glyph: 'S', radius: 11, label: 'Session', plural: 'Sessions' },
    branch:        { color: '#63a8ff', glyph: 'B', radius: 12, label: 'Branch', plural: 'Branches' },
    tag:           { color: '#ffc96b', glyph: 'T', radius: 10, label: 'Tag', plural: 'Tags' },
    commit:        { color: '#7f90ff', glyph: 'C', radius: 9, label: 'Commit', plural: 'Commits' },
    pull:          { color: '#d582ff', glyph: 'P', radius: 11, label: 'Pull request', plural: 'Pull requests' },
    issue:         { color: '#ff9c66', glyph: 'I', radius: 10, label: 'Issue', plural: 'Issues' },
    release:       { color: '#49d9ad', glyph: 'R', radius: 11, label: 'Release', plural: 'Releases' },
    workflow:      { color: '#55d7f4', glyph: 'W', radius: 11, label: 'Workflow', plural: 'Workflows' },
    package:       { color: '#b795ff', glyph: 'D', radius: 10, label: 'Dependency', plural: 'Dependencies' },
    vulnerability: { color: '#F43F6E', glyph: '!', radius: 13, label: 'Vulnerability', plural: 'Vulnerabilities' },
    protected:     { color: '#22D3EE', glyph: 'L', radius: 12, label: 'Protected asset', plural: 'Protected assets' },
    snapshot:      { color: '#5c9fff', mark: 'restore', radius: 13, label: 'Recovery snapshot', plural: 'Recovery' },
    safety:        { color: '#ff6d8d', mark: 'shield', radius: 13, label: 'Safety control', plural: 'Safety controls' },
    external:      { color: '#ff7469', glyph: 'X', radius: 12, label: 'External destination', plural: 'Destinations' },
    scan:          { color: '#50e6c2', mark: 'check', radius: 12, label: 'Security scan', plural: 'Scans' },
    credential:    { color: '#ffd166', glyph: 'K', radius: 12, label: 'Deploy credential', plural: 'Credentials' },
    integration:   { color: '#ff8fab', glyph: 'H', radius: 12, label: 'Webhook integration', plural: 'Webhooks' }
  };

  /*
   * Four node types are drawn rather than typed.
   *
   * Every other type is a single letter, set in Public Sans. These four were
   * a sparkle, a restoring turn, a diamond and a check -- characters that
   * Public Sans does not carry, so they fell through the stack to whatever
   * font on the machine happened to have them. Two typefaces on one graph, at
   * two optical weights, decided by the viewer's system.
   *
   * Drawn as paths they are the same on every machine, and they still read at
   * these radii (9 to 22) where a detailed icon would not. The letters stay
   * letters: at this size a legible initial beats a smudged picture.
   */
  /*
   * The same four marks for the inspector, which is DOM rather than canvas.
   * Node types that carry a letter keep it; the drawn ones get the drawing,
   * so the panel and the graph agree about what a node looks like.
   */
  const INSPECTOR_MARK = Object.freeze({
    star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" stroke="none" d="M12 3.4c.6 3.6 1.8 5.4 5.4 6.6-3.6 1.2-4.8 3-5.4 6.6-.6-3.6-1.8-5.4-5.4-6.6 3.6-1.2 4.8-3 5.4-6.6z"/></svg>',
    restore: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.8 12a7.2 7.2 0 1 0 2.1-5.1"/><path d="M4.8 6.2v5.1h5.1"/></svg>',
    shield: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.6l7 2.9v5.1c0 4.2-2.9 7.6-7 8.9-4.1-1.3-7-4.7-7-8.9V6.5z"/></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.4 12.4l4.2 4.2 9-9.2"/></svg>'
  });

  function nodeBadge(node) {
    if (node.mark && INSPECTOR_MARK[node.mark]) return INSPECTOR_MARK[node.mark];
    return nEsc(node.glyph || '');
  }

  /*
   * Every type has an icon, drawn from the same 24-unit path in the graph and
   * in its card, so a node and its details are recognisably the same thing.
   *
   * These replaced single letters. The letters were chosen when nodes were 9px
   * spheres, where a legible initial beat a smudged picture; nodes are now drawn
   * at 14 to 26px on a solid disc, where a stroked icon reads and "W" for a
   * workflow never did. The letters and marks stay in TYPE_STYLE as the
   * fallback for a canvas without Path2D.
   */
  const TYPE_ICON = Object.freeze({
    repo: 'M12 3.4c.6 3.6 1.8 5.4 5.4 6.6-3.6 1.2-4.8 3-5.4 6.6-.6-3.6-1.8-5.4-5.4-6.6 3.6-1.2 4.8-3 5.4-6.6z',
    user: 'M12 12.2a3.9 3.9 0 1 0 0-7.8 3.9 3.9 0 0 0 0 7.8zM4.8 20.2a7.2 7.2 0 0 1 14.4 0',
    session: 'M4 5h16v10.5H4zM9 19.5h6M12 15.5v4',
    branch: 'M6.5 4v11M6.5 20a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM17.5 9.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM17.5 9.5c0 4.5-5 5-11 7.5',
    tag: 'M3.8 12.2L12 4h6.8A1.2 1.2 0 0 1 20 5.2V12l-8.2 8.2zM15.8 8.2h.01',
    commit: 'M3 12h5.5M15.5 12H21M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
    pull: 'M6.5 8.5v7M6.5 8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM6.5 20.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM17.5 20.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM17.5 15.5V9a3 3 0 0 0-3-3H11M13 3.8L11 6l2 2.2',
    issue: 'M12 20.2a8.2 8.2 0 1 0 0-16.4 8.2 8.2 0 0 0 0 16.4zM12 13.3a1.3 1.3 0 1 0 0-2.6 1.3 1.3 0 0 0 0 2.6z',
    release: 'M5.5 20.5V4M5.5 4.5h11.8l-2.4 4 2.4 4H5.5',
    workflow: 'M12 20.2a8.2 8.2 0 1 0 0-16.4 8.2 8.2 0 0 0 0 16.4zM10 8.6l5.4 3.4-5.4 3.4z',
    package: 'M12 3.5l7.5 4.1v8.8L12 20.5l-7.5-4.1V7.6zM4.5 7.6l7.5 4.2 7.5-4.2M12 11.8v8.7',
    vulnerability: 'M12 4.2l8.6 15H3.4zM12 10v4.2M12 16.8v.1',
    protected: 'M6.5 3.5h7.5l4 4v13H6.5zM14 3.5v4h4M9.6 14.2h4.8v3.8H9.6zM10.6 14.2V13a1.4 1.4 0 0 1 2.8 0v1.2',
    snapshot: 'M4.8 12a7.2 7.2 0 1 0 2.1-5.1M4.8 6.2v5.1h5.1',
    safety: 'M12 3.6l7 2.9v5.1c0 4.2-2.9 7.6-7 8.9-4.1-1.3-7-4.7-7-8.9V6.5zM9.2 12.1l2 2.1 3.6-3.9',
    external: 'M12 20.2a8.2 8.2 0 1 0 0-16.4 8.2 8.2 0 0 0 0 16.4zM3.8 12h16.4M12 3.8c2.2 2.3 3.2 5 3.2 8.2s-1 5.9-3.2 8.2M12 3.8C9.8 6.1 8.8 8.8 8.8 12s1 5.9 3.2 8.2',
    scan: 'M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16M8.2 12.2l2.6 2.6 5-5.2',
    credential: 'M8 19a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM10.9 12.1L19 4M15.5 7.5l2.5 2.5M13.4 9.6l1.8 1.8',
    integration: 'M10 13.5a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.2 1.2M14 10.5a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.2-1.2'
  });

  function drawNodeMark(ctx, mark, x, y, size) {
    ctx.save();
    ctx.translate(x, y);
    ctx.lineWidth = Math.max(1, size * 0.16);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = ctx.fillStyle;
    const u = size / 2;
    ctx.beginPath();
    if (mark === 'star') {
      /* The brand's four-point mark, filled so the hub reads as solid. */
      ctx.moveTo(0, -u);
      ctx.quadraticCurveTo(u * 0.2, -u * 0.2, u, 0);
      ctx.quadraticCurveTo(u * 0.2, u * 0.2, 0, u);
      ctx.quadraticCurveTo(-u * 0.2, u * 0.2, -u, 0);
      ctx.quadraticCurveTo(-u * 0.2, -u * 0.2, 0, -u);
      ctx.fill();
    } else if (mark === 'restore') {
      ctx.arc(0, 0, u * 0.78, Math.PI * 0.55, Math.PI * 2.15);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-u * 0.78, -u * 0.32);
      ctx.lineTo(-u * 0.78, u * 0.2);
      ctx.lineTo(-u * 0.24, u * 0.2);
      ctx.stroke();
    } else if (mark === 'shield') {
      ctx.moveTo(0, -u);
      ctx.lineTo(u * 0.82, -u * 0.55);
      ctx.lineTo(u * 0.82, u * 0.12);
      ctx.quadraticCurveTo(u * 0.82, u * 0.76, 0, u);
      ctx.quadraticCurveTo(-u * 0.82, u * 0.76, -u * 0.82, u * 0.12);
      ctx.lineTo(-u * 0.82, -u * 0.55);
      ctx.closePath();
      ctx.stroke();
    } else if (mark === 'check') {
      ctx.moveTo(-u * 0.72, 0);
      ctx.lineTo(-u * 0.16, u * 0.56);
      ctx.lineTo(u * 0.76, -u * 0.6);
      ctx.stroke();
    }
    ctx.restore();
  }

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
    panning: false,
    pointerStart: null,
    lastPointer: null,
    filters: { critical: true, warning: true, normal: true },
    timelineIndex: -1,
    raf: 0,
    refreshTimer: 0,
    lastFrame: performance.now(),
    camTarget: null,
    focusGroup: null,
    panels: [],
    expandedGroups: new Set(),
    layoutMode: 'split',
    cardSize: null,
    cardPos: null,
    cardMode: null,
    fitPending: false,
    visibleCount: 0,
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
      color: st.color, glyph: st.glyph, mark: st.mark, r: st.radius,
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

    /* A refresh keeps every node where it was: only what changed moves, and
     * the selection survives as long as its node does. */
    const previous = new Map(NVN.nodes.map(n => [n.id, n]));
    const next = [...nodeMap.values()];
    for (const n of next) {
      const old = previous.get(n.id);
      if (old && old.x != null) { n.x = old.x; n.y = old.y; n.appear = old.appear; n.wasVisible = old.wasVisible; }
    }
    const selectedId = NVN.selected && NVN.selected.id;
    NVN.nodes = next;
    NVN.edges = edges;
    NVN.events = events.sort((a, b) => new Date(a.time) - new Date(b.time)).slice(-80);
    NVN.hover = null;
    NVN.selected = selectedId ? nodeById(selectedId) || null : null;
    if (!NVN.selected) closeCard();
    applyMode({ instant: !previous.size });
  }

  function applyMode(options = {}) {
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
    layoutGraph({ instant: !!options.instant });
    renderLegend();
    updateVisibleCount();
    if (NVN.selected) renderCard(NVN.selected, false);
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
    NVN.visibleCount = count;
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
    bindUI();
    bindCanvas();
    NVN.resizeObserver = new ResizeObserver(() => resize());
    const stage = document.getElementById('neuralStage');
    if (stage) NVN.resizeObserver.observe(stage);
    resize();
  }

  function resize() {
    if (!NVN.canvas) return;
    const rect = NVN.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    NVN.dpr = Math.min(window.devicePixelRatio || 1, 2);
    NVN.width = rect.width; NVN.height = rect.height;
    const w = Math.round(rect.width * NVN.dpr), h = Math.round(rect.height * NVN.dpr);
    if (NVN.canvas.width !== w || NVN.canvas.height !== h) { NVN.canvas.width = w; NVN.canvas.height = h; }
    if (NVN.fitPending) fitGraph(false);
    if (NVN.nodes.length && NVN.layoutAspectUsed && Math.abs(layoutAspect() - NVN.layoutAspectUsed) > .2) {
      clearTimeout(NVN.reshapeTimer);
      NVN.reshapeTimer = setTimeout(() => { layoutGraph(); fitGraph(true); }, 120);
    }
  }

  /*
   * The layout.
   *
   * The repository is the hub in the middle, and every other node belongs to a
   * group drawn as a panel: a header with the group's icon, name and count, and
   * one row per member with its name always printed beside it. On a wide stage
   * the panels form two columns, one each side of the hub, with each member's
   * node on the edge that faces it; on a tall stage they stack in one column
   * beside a spine that runs down from the hub. Either way the picture reads
   * like a table of contents rather than a cloud: a reader finds "workflows" by
   * reading, not by hunting.
   *
   * A group longer than a few rows folds its tail into "+ n more", which opens
   * it; selecting a folded node from anywhere else opens its group too.
   *
   * Positions are targets: the frame loop eases every node toward its row, so
   * changing mode, filtering, searching or opening a group moves the graph
   * instead of cutting to a new one.
   */
  const PANEL_W = 272;
  const HEAD_H = 56;
  const ROW_H = 44;
  const PANEL_PAD = 12;
  const PANEL_GAP = 22;
  const COLUMN_GAP = 300;
  const MAX_ROWS = 6;
  const NODE_R = 16;
  const HUB_R = 58;
  const LEFT_GROUPS = ['user', 'credential', 'session', 'protected', 'safety', 'snapshot', 'scan', 'release', 'tag'];
  const RIGHT_GROUPS = ['branch', 'commit', 'workflow', 'pull', 'issue', 'integration', 'external', 'package', 'vulnerability'];
  const SEVERITY_RANK = { critical: 0, warning: 1, normal: 2 };

  /* The stage's shape: below about 1 the stage is wider than tall. */
  function layoutAspect() {
    return NVN.width && NVN.height ? clamp((NVN.height / NVN.width) * .92, .66, 1.55) : .8;
  }
  function worldRadius(node) { return node.type === 'repo' ? HUB_R : NODE_R; }
  function nodeRadius(node) { return worldRadius(node) * NVN.zoom; }
  function groupOrder(type) {
    const left = LEFT_GROUPS.indexOf(type);
    if (left >= 0) return left;
    const right = RIGHT_GROUPS.indexOf(type);
    return right >= 0 ? 100 + right : 200;
  }
  function stackHeight(list) {
    return list.reduce((sum, panel) => sum + panel.h, 0) + PANEL_GAP * Math.max(0, list.length - 1);
  }

  function layoutGraph(options = {}) {
    const visible = NVN.nodes.filter(n => n.visible);
    const expanded = NVN.expandedGroups || (NVN.expandedGroups = new Set());
    const groups = new Map();
    for (const n of visible) {
      if (n.type === 'repo') continue;
      if (!groups.has(n.type)) groups.set(n.type, []);
      groups.get(n.type).push(n);
    }
    const panels = [...groups.keys()].sort((a, b) => groupOrder(a) - groupOrder(b)).map(type => {
      const members = groups.get(type).slice().sort((a, b) =>
        (SEVERITY_RANK[a.severity] ?? 2) - (SEVERITY_RANK[b.severity] ?? 2) || a.label.localeCompare(b.label));
      const folds = members.length > MAX_ROWS && !expanded.has(type);
      const shown = folds ? members.slice(0, MAX_ROWS - 1) : members;
      const rows = shown.length + (folds || (expanded.has(type) && members.length > MAX_ROWS) ? 1 : 0);
      return {
        type, members, shown, rows, folds,
        hiddenCount: members.length - shown.length,
        collapsible: expanded.has(type) && members.length > MAX_ROWS,
        w: PANEL_W, h: HEAD_H + rows * ROW_H + PANEL_PAD
      };
    });
    const aspect = layoutAspect();
    NVN.layoutAspectUsed = aspect;
    NVN.layoutMode = aspect > 1.05 ? 'stack' : 'split';
    if (NVN.layoutMode === 'stack') {
      let y = HUB_R + 58;
      for (const panel of panels) { panel.side = 'right'; panel.x = 64; panel.y = y; y += panel.h + PANEL_GAP; }
    } else {
      const left = panels.filter(panel => LEFT_GROUPS.includes(panel.type));
      const right = panels.filter(panel => !LEFT_GROUPS.includes(panel.type));
      /* When one column is far longer than the other, groups without a natural
       * side cross over. Groups that belong together -- packages and their
       * advisories, branches, commits and the workflows they run, identities
       * and their credentials -- never do. */
      const FLEX = new Set(['release', 'tag', 'pull', 'issue', 'external', 'scan', 'snapshot', 'safety', 'integration']);
      for (let guard = 0; guard < 16; guard++) {
        const hl = stackHeight(left), hr = stackHeight(right);
        if (Math.max(hl, hr) < Math.min(hl, hr) * 1.35 + 120) break;
        const from = hl > hr ? left : right, to = hl > hr ? right : left;
        const index = from.map(panel => FLEX.has(panel.type)).lastIndexOf(true);
        if (index < 0 || from.length < 2) break;
        const moving = from[index];
        if (Math.abs(Math.abs(hl - hr) - 2 * (moving.h + PANEL_GAP)) >= Math.abs(hl - hr)) break;
        from.splice(index, 1);
        to.push(moving);
      }
      for (const [list, side] of [[left, 'left'], [right, 'right']]) {
        let y = -stackHeight(list) / 2;
        for (const panel of list) {
          panel.side = side;
          panel.x = side === 'left' ? -COLUMN_GAP - PANEL_W : COLUMN_GAP;
          panel.y = y;
          y += panel.h + PANEL_GAP;
        }
      }
    }
    for (const panel of panels) {
      panel.nodeX = panel.side === 'left' ? panel.x + panel.w - 30 : panel.x + 30;
      panel.shown.forEach((n, i) => {
        n.tx = panel.nodeX; n.ty = panel.y + HEAD_H + i * ROW_H + ROW_H / 2; n.folded = false;
      });
      panel.moreY = panel.rows > panel.shown.length ? panel.y + HEAD_H + panel.shown.length * ROW_H + ROW_H / 2 : null;
      for (const n of panel.members.slice(panel.shown.length)) {
        n.tx = panel.nodeX; n.ty = panel.moreY == null ? panel.y + HEAD_H : panel.moreY; n.folded = true;
      }
    }
    for (const n of visible) if (n.type === 'repo') { n.tx = 0; n.ty = 0; n.folded = false; }
    let lane = 0;
    for (const panel of panels) for (const n of panel.shown) n.lane = lane++;
    NVN.laneCount = lane;
    NVN.panels = panels;
    const snap = options.instant || !state.settings.motion;
    for (const n of visible) {
      /* A node arriving in this mode grows out of the hub it belongs to. */
      if (snap || n.x == null || !n.wasVisible) {
        if (snap || n.x == null) { n.x = n.tx; n.y = n.ty; }
        else { n.x = 0; n.y = 0; }
        n.appear = snap ? 1 : 0;
      }
    }
    for (const n of NVN.nodes) n.wasVisible = n.visible;
  }

  /* The whole picture's extent in world units, for fitting it to the stage. */
  function layoutBounds() {
    let minX = -HUB_R - 20, maxX = HUB_R + 20, minY = -HUB_R - 30, maxY = HUB_R + 50;
    for (const panel of NVN.panels || []) {
      minX = Math.min(minX, panel.x); maxX = Math.max(maxX, panel.x + panel.w);
      minY = Math.min(minY, panel.y); maxY = Math.max(maxY, panel.y + panel.h);
    }
    return { minX: minX - 16, minY: minY - 16, maxX: maxX + 16, maxY: maxY + 16 };
  }

  /* A near-white type colour (identities) cannot be darkened into contrast on
   * a white ground, so the light theme draws it in slate instead. */
  function luminanceOf(hex) {
    const h = String(hex).replace('#', '');
    if (!/^[0-9a-f]{6}$/i.test(h)) return 0;
    const v = parseInt(h, 16);
    return (.2126 * (v >> 16) + .7152 * ((v >> 8) & 255) + .0722 * (v & 255)) / 255;
  }
  function isLight() { return document.documentElement.dataset.theme === 'light'; }
  function palette() {
    return isLight() ? {
      surface: '#ffffff', grid: 'rgba(49,46,129,.07)', ring: 'rgba(79,70,229,.2)',
      panel: 'rgba(255,255,255,.9)', panelEdge: .38, text: '#1e1b4b', muted: '#5b5f7a', row: 'rgba(49,46,129,.05)',
      ink: color => (luminanceOf(color) > .78 ? '#475569' : darken(color, .28)), glow: false
    } : {
      surface: '#0e1026', grid: 'rgba(196,203,255,.06)', ring: 'rgba(129,140,248,.24)',
      panel: 'rgba(11,13,34,.78)', panelEdge: .34, text: '#eef0ff', muted: '#9aa0c3', row: 'rgba(255,255,255,.035)',
      ink: color => color, glow: true
    };
  }

  /* Paths are compiled once; a Path2D is reused every frame. */
  const ICON_CACHE = new Map();
  function iconPath(type) {
    if (typeof Path2D !== 'function' || !TYPE_ICON[type]) return null;
    if (!ICON_CACHE.has(type)) ICON_CACHE.set(type, new Path2D(TYPE_ICON[type]));
    return ICON_CACHE.get(type);
  }
  function drawIcon(ctx, type, x, y, size, color) {
    const path = iconPath(type);
    if (!path) return false;
    ctx.save();
    ctx.translate(x - size / 2, y - size / 2);
    ctx.scale(size / 24, size / 24);
    ctx.lineWidth = 1.9;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = color;
    if (type === 'repo') { ctx.fillStyle = color; ctx.fill(path); }
    else ctx.stroke(path);
    ctx.restore();
    return true;
  }

  function worldToScreen(x, y) {
    return { x: NVN.width / 2 + NVN.panX + x * NVN.zoom, y: NVN.height / 2 + NVN.panY + y * NVN.zoom };
  }
  function screenToWorld(x, y) {
    return { x: (x - NVN.width / 2 - NVN.panX) / NVN.zoom, y: (y - NVN.height / 2 - NVN.panY) / NVN.zoom };
  }
  /* Draw in world units: everything scales with the zoom, text included. */
  function worldSpace(ctx) {
    const z = NVN.zoom, d = NVN.dpr;
    ctx.setTransform(d * z, 0, 0, d * z, d * (NVN.width / 2 + NVN.panX), d * (NVN.height / 2 + NVN.panY));
  }
  function screenSpace(ctx) { ctx.setTransform(NVN.dpr, 0, 0, NVN.dpr, 0, 0); }

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

  /* Eases nodes toward their targets and the camera toward where it was sent. */
  function integrate(dt) {
    const motion = state.settings.motion;
    const k = motion ? 1 - Math.exp(-dt / 130) : 1;
    for (const n of NVN.nodes) {
      if (!n.visible) continue;
      if (n.tx == null) { n.tx = n.x; n.ty = n.y; }
      n.x += (n.tx - n.x) * k;
      n.y += (n.ty - n.y) * k;
      n.appear = Math.min(1, (n.appear ?? 1) + (motion ? dt / 280 : 1));
    }
    const cam = NVN.camTarget;
    if (cam) {
      const c = motion ? 1 - Math.exp(-dt / 110) : 1;
      NVN.zoom += (cam.zoom - NVN.zoom) * c;
      NVN.panX += (cam.panX - NVN.panX) * c;
      NVN.panY += (cam.panY - NVN.panY) * c;
      if (Math.abs(cam.zoom - NVN.zoom) < .001 && Math.abs(cam.panX - NVN.panX) < .5 && Math.abs(cam.panY - NVN.panY) < .5) {
        NVN.zoom = cam.zoom; NVN.panX = cam.panX; NVN.panY = cam.panY; NVN.camTarget = null;
      }
    }
  }

  /* Which nodes stay lit: the explained path, else the selection and its
   * neighbours, else the group chosen from the legend, else the hovered node's
   * neighbourhood. Null means nothing is dimmed. */
  function focusSets() {
    if (NVN.highlightNodes.size) return { nodes: NVN.highlightNodes, edges: NVN.highlightEdges };
    const anchor = NVN.selected || (NVN.focusGroup ? null : NVN.hover);
    if (anchor) {
      const nodes = new Set([anchor.id]);
      const edges = new Set();
      for (const e of NVN.edges) {
        if (!e.visible) continue;
        if (e.source === anchor.id || e.target === anchor.id) { nodes.add(e.source); nodes.add(e.target); edges.add(e.id); }
      }
      return { nodes, edges };
    }
    if (NVN.focusGroup) {
      const nodes = new Set(NVN.nodes.filter(n => n.visible && (n.type === NVN.focusGroup || n.type === 'repo')).map(n => n.id));
      const edges = new Set(NVN.edges.filter(e => e.visible && nodes.has(e.source) && nodes.has(e.target)).map(e => e.id));
      return { nodes, edges };
    }
    return null;
  }

  function draw(now, dt = 16) {
    const ctx = NVN.ctx;
    integrate(dt);
    screenSpace(ctx);
    ctx.clearRect(0, 0, NVN.width, NVN.height);
    const colors = palette();
    drawBackdrop(ctx, colors);
    const focus = focusSets();
    const hub = NVN.nodes.find(n => n.type === 'repo' && n.visible);
    worldSpace(ctx);
    drawRings(ctx, now, colors, hub);
    drawPanels(ctx, colors, focus);
    if (hub) drawFibers(ctx, now, colors, focus, hub);
    drawRelations(ctx, now, colors, focus);
    for (const n of NVN.nodes) {
      if (!n.visible || n.folded || n.type === 'repo') continue;
      drawNode(ctx, n, now, !!focus && !focus.nodes.has(n.id), colors);
    }
    if (hub) drawHub(ctx, hub, now, colors, !!focus && !focus.nodes.has(hub.id));
    screenSpace(ctx);
    drawLeader(ctx, colors);
    positionCard();
  }

  function drawBackdrop(ctx, colors) {
    /* A dot grid fixed to the graph rather than the screen, so panning and
     * zooming read as moving over a surface. It thins out as it shrinks. */
    const spacing = 28 * NVN.zoom;
    if (spacing < 9) return;
    const origin = worldToScreen(0, 0);
    const startX = ((origin.x % spacing) + spacing) % spacing;
    const startY = ((origin.y % spacing) + spacing) % spacing;
    const size = clamp(1.1 * NVN.zoom, .7, 1.6);
    ctx.fillStyle = colors.grid;
    for (let x = startX; x < NVN.width; x += spacing) {
      for (let y = startY; y < NVN.height; y += spacing) ctx.fillRect(x - size / 2, y - size / 2, size, size);
    }
  }

  /* Concentric dotted rings around the hub, and two arcs turning slowly on
   * them: the centre of the picture announces itself. */
  function drawRings(ctx, now, colors, hub) {
    if (!hub) return;
    ctx.save();
    ctx.strokeStyle = colors.ring;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 7]);
    for (const r of [HUB_R * 1.7, HUB_R * 2.6, HUB_R * 3.7]) {
      ctx.beginPath(); ctx.arc(hub.x, hub.y, r, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.setLineDash([]);
    if (state.settings.motion) {
      const turn = now * .00012;
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = hexAlpha('#818cf8', isLight() ? .3 : .4);
      ctx.beginPath(); ctx.arc(hub.x, hub.y, HUB_R * 1.7, turn, turn + 1.1); ctx.stroke();
      ctx.beginPath(); ctx.arc(hub.x, hub.y, HUB_R * 1.7, turn + Math.PI, turn + Math.PI + .6); ctx.stroke();
    }
    ctx.restore();
  }

  function roundRect(ctx, x, y, w, h, r) {
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); return; }
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function hexAlpha(hex, alpha) {
    const h = String(hex).replace('#', '');
    if (!/^[0-9a-f]{3}([0-9a-f]{3})?$/i.test(h)) return hex;
    const v = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
    return `rgba(${v >> 16},${(v >> 8) & 255},${v & 255},${alpha})`;
  }
  function darken(hex, amount) {
    const h = String(hex).replace('#', ''); let v = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
    const f = 1 - amount; return `rgb(${Math.round((v >> 16) * f)},${Math.round(((v >> 8) & 255) * f)},${Math.round((v & 255) * f)})`;
  }
  /* Text that fits a width, ellipsised once per label and width rather than
   * measured down character by character every frame. */
  const FIT_CACHE = new Map();
  function fitText(ctx, text, width) {
    const key = `${ctx.font}|${width}|${text}`;
    if (FIT_CACHE.has(key)) return FIT_CACHE.get(key);
    let out = String(text);
    if (ctx.measureText(out).width > width) {
      while (out.length > 1 && ctx.measureText(`${out}…`).width > width) out = out.slice(0, -1);
      out = `${out.trimEnd()}…`;
    }
    if (FIT_CACHE.size > 800) FIT_CACHE.clear();
    FIT_CACHE.set(key, out);
    return out;
  }

  /*
   * A group's panel: a glass card with its icon, name and count in the header,
   * a row per member, and "+ n more" where the group folds. The member's node
   * sits on the edge facing the hub and its name on the other side, so the
   * strands arriving from the hub never cross a word.
   */
  function drawPanels(ctx, colors, focus) {
    const selectedType = NVN.selected && NVN.selected.type;
    for (const panel of NVN.panels || []) {
      const st = TYPE_STYLE[panel.type] || TYPE_STYLE.repo;
      const ink = colors.ink(st.color);
      const lit = NVN.focusGroup === panel.type || selectedType === panel.type;
      const dim = !!focus && !lit && !panel.members.some(n => focus.nodes.has(n.id));
      ctx.save();
      ctx.globalAlpha = dim ? .4 : 1;
      roundRect(ctx, panel.x, panel.y, panel.w, panel.h, 18);
      ctx.fillStyle = colors.panel; ctx.fill();
      const wash = ctx.createLinearGradient(panel.x, panel.y, panel.x + panel.w * .7, panel.y + panel.h);
      wash.addColorStop(0, hexAlpha(st.color, isLight() ? .11 : .16));
      wash.addColorStop(1, hexAlpha(st.color, 0));
      ctx.fillStyle = wash; ctx.fill();
      if (lit && colors.glow) { ctx.shadowColor = hexAlpha(st.color, .55); ctx.shadowBlur = 22; }
      ctx.lineWidth = lit ? 1.6 : 1;
      ctx.strokeStyle = hexAlpha(st.color, lit ? .8 : colors.panelEdge);
      ctx.stroke();
      ctx.shadowBlur = 0;
      /* Header: the group's mark, then its name and count. */
      const hx = panel.x + 30, hy = panel.y + HEAD_H / 2 + 2;
      ctx.beginPath(); ctx.arc(hx, hy, 17, 0, Math.PI * 2);
      ctx.fillStyle = hexAlpha(st.color, isLight() ? .12 : .18); ctx.fill();
      ctx.lineWidth = 1.2; ctx.strokeStyle = hexAlpha(st.color, .7); ctx.stroke();
      if (!drawIcon(ctx, panel.type, hx, hy, 18, ink) && st.glyph) {
        ctx.fillStyle = ink; ctx.font = "700 13px 'Public Sans Variable', system-ui, sans-serif";
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(st.glyph, hx, hy);
      }
      ctx.font = "700 12px 'JetBrains Mono Variable', ui-monospace, monospace";
      if ('letterSpacing' in ctx) ctx.letterSpacing = '1.6px';
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillStyle = ink;
      ctx.fillText(fitText(ctx, `${(st.plural || st.label).toUpperCase()} · ${panel.members.length}`, panel.w - 70), panel.x + 58, hy);
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
      /* Rows. */
      ctx.font = "500 13px 'Public Sans Variable', system-ui, sans-serif";
      const labelWidth = panel.w - 78;
      panel.shown.forEach((n, i) => {
        const rowY = panel.y + HEAD_H + i * ROW_H;
        const selected = NVN.selected && NVN.selected.id === n.id;
        const hover = NVN.hover && NVN.hover.id === n.id;
        if (selected || hover) {
          roundRect(ctx, panel.x + 8, rowY + 3, panel.w - 16, ROW_H - 6, 12);
          ctx.fillStyle = selected ? hexAlpha(st.color, isLight() ? .14 : .2) : colors.row; ctx.fill();
        }
        const rowDim = !!focus && !focus.nodes.has(n.id) && !dim;
        ctx.globalAlpha = (dim ? .4 : 1) * (rowDim ? .45 : 1) * Math.min(1, (n.appear ?? 1) * 1.4);
        ctx.fillStyle = colors.text;
        ctx.font = `${selected ? 700 : 500} 13px 'Public Sans Variable', system-ui, sans-serif`;
        const text = fitText(ctx, n.label, labelWidth);
        if (panel.side === 'left') { ctx.textAlign = 'right'; ctx.fillText(text, panel.x + panel.w - 58, rowY + ROW_H / 2); }
        else { ctx.textAlign = 'left'; ctx.fillText(text, panel.x + 58, rowY + ROW_H / 2); }
        ctx.globalAlpha = dim ? .4 : 1;
      });
      if (panel.moreY != null) {
        const label = panel.folds ? `+ ${panel.hiddenCount} more` : 'Show fewer';
        ctx.font = "600 12px 'Public Sans Variable', system-ui, sans-serif";
        ctx.fillStyle = ink;
        ctx.textAlign = panel.side === 'left' ? 'right' : 'left';
        ctx.fillText(label, panel.side === 'left' ? panel.x + panel.w - 20 : panel.x + 20, panel.moreY);
      }
      ctx.restore();
    }
  }

  /* One strand from the hub to a node: a cubic that leaves the hub level and
   * arrives level, so a column of strands fans out like fibres rather than
   * crossing each other. */
  function fiberCurve(hub, n) {
    if (NVN.layoutMode === 'stack') {
      /* Each strand has its own lane down the spine, so they run as a ribbon
       * instead of piling into one white-hot line. */
      const lane = ((n.lane || 0) - (NVN.laneCount || 1) / 2) * 1.6;
      const start = { x: hub.x + lane, y: hub.y + HUB_R };
      const end = { x: n.x - NODE_R, y: n.y };
      return { start, c1: { x: hub.x + lane, y: start.y + (end.y - start.y) * .72 }, c2: { x: end.x - 64, y: end.y }, end };
    }
    const sign = n.x >= hub.x ? 1 : -1;
    const angle = clamp(Math.atan2(n.y - hub.y, Math.abs(n.x - hub.x)) * .55, -1.05, 1.05);
    const start = { x: hub.x + sign * HUB_R * .96 * Math.cos(angle), y: hub.y + HUB_R * .96 * Math.sin(angle) };
    const end = { x: n.x - sign * NODE_R, y: n.y };
    const dx = Math.abs(end.x - start.x);
    return { start, c1: { x: start.x + sign * dx * .5, y: start.y }, c2: { x: end.x - sign * dx * .5, y: end.y }, end };
  }
  function cubicPoint(c, t) {
    const u = 1 - t;
    return {
      x: u * u * u * c.start.x + 3 * u * u * t * c.c1.x + 3 * u * t * t * c.c2.x + t * t * t * c.end.x,
      y: u * u * u * c.start.y + 3 * u * u * t * c.c1.y + 3 * u * t * t * c.c2.y + t * t * t * c.end.y
    };
  }
  function strokeCubic(ctx, c, offset = 0) {
    ctx.beginPath();
    ctx.moveTo(c.start.x, c.start.y);
    ctx.bezierCurveTo(c.c1.x, c.c1.y + offset, c.c2.x, c.c2.y - offset, c.end.x, c.end.y);
    ctx.stroke();
  }

  /*
   * The strands. Each member of each group is joined to the hub; the strand
   * takes its node's colour, or its severity's when it has one, and carries a
   * signal toward the hub. A selection lights its own strands and dims the
   * rest, and the strands of a critical node run faster.
   */
  function drawFibers(ctx, now, colors, focus, hub) {
    const motion = state.settings.motion && !NVN.paused;
    ctx.save();
    if (colors.glow) ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (const n of NVN.nodes) {
      if (!n.visible || n.folded || n.type === 'repo') continue;
      const curve = fiberCurve(hub, n);
      const lit = !!focus && focus.nodes.has(n.id) && (focus.nodes.has(hub.id) || NVN.focusGroup === n.type);
      const dim = !!focus && !lit;
      /* The strand wears its group's colour, so a column of strands reads as
       * that group from across the stage; only a critical node turns it red.
       * A warning stays on the node's badge. */
      const color = n.severity === 'critical' ? '#F43F6E' : n.color;
      const stroke = colors.ink(color);
      const appear = n.appear ?? 1;
      const stacked = NVN.layoutMode === 'stack';
      const base = appear * (dim ? .2 : 1) * (stacked ? .75 : 1);
      if (colors.glow) {
        ctx.globalAlpha = base * (lit ? .16 : .06);
        ctx.strokeStyle = color; ctx.lineWidth = lit ? 12 : 9;
        strokeCubic(ctx, curve);
        ctx.globalAlpha = base * (lit ? .3 : .12);
        ctx.lineWidth = lit ? 5 : 3.5;
        strokeCubic(ctx, curve);
      }
      ctx.globalAlpha = base * (lit ? 1 : colors.glow ? .62 : .5);
      ctx.strokeStyle = stroke; ctx.lineWidth = lit ? 2 : 1.3;
      strokeCubic(ctx, curve);
      const seed = (hashCode(n.id) % 1000) / 1000;
      ctx.globalAlpha = base * (lit ? .6 : .3);
      ctx.lineWidth = .8;
      strokeCubic(ctx, curve, (seed - .5) * 26);
      ctx.globalAlpha = base * (lit ? .45 : .2);
      strokeCubic(ctx, curve, (.5 - seed) * 18 + 6);
      if (motion && !dim) {
        const speed = n.severity === 'critical' ? .00042 : .00017;
        for (const phase of lit ? [0, .5] : [0]) {
          const t = 1 - ((seed + phase + now * speed) % 1);
          const p = cubicPoint(curve, t);
          ctx.globalAlpha = base * (lit ? 1 : .85);
          const glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, lit ? 7 : 5);
          glow.addColorStop(0, '#ffffff'); glow.addColorStop(.35, color); glow.addColorStop(1, hexAlpha(color, 0));
          ctx.fillStyle = glow;
          ctx.beginPath(); ctx.arc(p.x, p.y, lit ? 7 : 5, 0, Math.PI * 2); ctx.fill();
        }
      }
    }
    ctx.restore();
  }

  /*
   * The relationships between members -- a branch to the workflow it ran, a
   * package to its advisory, one commit to the next -- drawn only for what is
   * in focus. Drawn always, they were the tangle that made the old graph hard
   * to read; drawn on demand, they answer "what is this connected to".
   */
  function drawRelations(ctx, now, colors, focus) {
    if (!focus) return;
    const byId = new Map(NVN.nodes.map(n => [n.id, n]));
    ctx.save();
    ctx.lineCap = 'round';
    for (const e of NVN.edges) {
      if (!e.visible || !focus.edges.has(e.id)) continue;
      const a = byId.get(e.source), b = byId.get(e.target);
      if (!a || !b || a.type === 'repo' || b.type === 'repo' || a.folded || b.folded) continue;
      const bend = Math.max(60, Math.abs(b.x - a.x) * .45);
      const sa = a.x < 0 ? -1 : 1, sb = b.x < 0 ? -1 : 1;
      const curve = {
        start: { x: a.x, y: a.y }, end: { x: b.x, y: b.y },
        c1: { x: a.x - sa * bend, y: a.y }, c2: { x: b.x - sb * bend, y: b.y }
      };
      const color = e.severity === 'critical' ? '#F43F6E' : e.severity === 'warning' ? '#F59E0B' : '#a78bfa';
      ctx.globalAlpha = .9;
      ctx.strokeStyle = colors.ink(color); ctx.lineWidth = 1.6;
      if (state.settings.motion && !NVN.paused) { ctx.setLineDash([6, 7]); ctx.lineDashOffset = -now * .03; }
      strokeCubic(ctx, curve);
      ctx.setLineDash([]);
    }
    ctx.restore();
  }

  function drawNode(ctx, node, now, dim, colors) {
    const selected = (NVN.selected && NVN.selected.id === node.id) || NVN.highlightNodes.has(node.id);
    const hover = NVN.hover && NVN.hover.id === node.id;
    const appear = node.appear ?? 1;
    let radius = NODE_R * (.55 + .45 * appear);
    if (hover || selected) radius *= 1.12;
    const severity = node.severity === 'critical' ? '#F43F6E' : node.severity === 'warning' ? '#F59E0B' : null;
    const ink = colors.ink(node.color);
    const x = node.x, y = node.y;
    ctx.save();
    ctx.globalAlpha = appear * (dim ? .35 : 1);
    /* A critical node breathes: one ring, expanding and fading, in red. */
    if (node.severity === 'critical' && !dim && state.settings.motion) {
      const phase = ((now * .0011) + (hashCode(node.id) % 100) / 100) % 1;
      ctx.strokeStyle = hexAlpha('#F43F6E', .55 * (1 - phase));
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(x, y, radius * (1.2 + phase * .9), 0, Math.PI * 2); ctx.stroke();
    }
    if (colors.glow) { ctx.shadowColor = hexAlpha(severity || node.color, selected ? .9 : .55); ctx.shadowBlur = selected ? 22 : hover ? 16 : 9; }
    ctx.fillStyle = colors.surface;
    ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
    const tint = ctx.createRadialGradient(x - radius * .35, y - radius * .4, radius * .1, x, y, radius);
    tint.addColorStop(0, hexAlpha(node.color, isLight() ? .2 : .34));
    tint.addColorStop(1, hexAlpha(node.color, isLight() ? .08 : .1));
    ctx.fillStyle = tint; ctx.fill();
    ctx.lineWidth = selected ? 2.4 : 1.6;
    ctx.strokeStyle = severity || ink;
    ctx.stroke();
    if (selected) {
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = isLight() ? hexAlpha('#312e81', .5) : 'rgba(255,255,255,.75)';
      ctx.beginPath(); ctx.arc(x, y, radius + 5, 0, Math.PI * 2); ctx.stroke();
    }
    if (drawIcon(ctx, node.type, x, y, radius * 1.08, ink)) { /* drawn */ }
    else if (node.mark) { ctx.fillStyle = ink; drawNodeMark(ctx, node.mark, x, y, radius * 1.02); }
    else if (node.glyph) {
      ctx.fillStyle = ink;
      ctx.font = `600 ${Math.round(radius * .85)}px 'Public Sans Variable', system-ui, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(node.glyph, x, y + .3);
    }
    /* Severity is a badge on the rim as well as a colour, so it survives
     * colour blindness and a glance. */
    if (severity) {
      const bx = x + radius * .72, by = y - radius * .72, br = Math.max(3.8, radius * .28);
      ctx.fillStyle = colors.surface; ctx.beginPath(); ctx.arc(bx, by, br + 2, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = severity; ctx.beginPath(); ctx.arc(bx, by, br, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff';
      if (node.severity === 'critical') { ctx.fillRect(bx - .8, by - br * .55, 1.6, br * .7); ctx.fillRect(bx - .8, by + br * .3, 1.6, 1.6); }
    }
    ctx.restore();
  }

  /* The brand mark, in the hub. The same four triangles as the #nvMark symbol,
   * so the centre of the graph is the product's own mark. */
  const HUB_MARK = [
    { d: 'M79 25 L40 217 L106 116 Z', tone: 'deep' },
    { d: 'M79 25 L106 116 L171 112 Z', tone: 'light' },
    { d: 'M244 23 L178 124 L205 215 Z', tone: 'deep' },
    { d: 'M178 124 L113 128 L205 215 Z', tone: 'light' }
  ];
  let hubMarkPaths = null;
  function drawHub(ctx, node, now, colors, dim) {
    const x = node.x, y = node.y, r = HUB_R;
    const active = (NVN.selected && NVN.selected.id === node.id) || (NVN.hover && NVN.hover.id === node.id);
    ctx.save();
    ctx.globalAlpha = dim ? .55 : 1;
    const halo = ctx.createRadialGradient(x, y, r * .6, x, y, r * 3);
    halo.addColorStop(0, isLight() ? 'rgba(99,102,241,.26)' : 'rgba(99,102,241,.55)');
    halo.addColorStop(.45, isLight() ? 'rgba(59,130,246,.1)' : 'rgba(59,130,246,.18)');
    halo.addColorStop(1, 'rgba(99,102,241,0)');
    ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(x, y, r * 3, 0, Math.PI * 2); ctx.fill();
    const orb = ctx.createRadialGradient(x - r * .32, y - r * .38, r * .08, x, y, r);
    orb.addColorStop(0, '#dbeafe'); orb.addColorStop(.28, '#60a5fa'); orb.addColorStop(.62, '#6d28d9'); orb.addColorStop(1, '#1e1b4b');
    if (colors.glow) { ctx.shadowColor = 'rgba(96,165,250,.8)'; ctx.shadowBlur = active ? 44 : 30; }
    ctx.fillStyle = orb; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = active ? 2.4 : 1.6; ctx.strokeStyle = 'rgba(191,219,254,.75)'; ctx.stroke();
    if (state.settings.motion) {
      const turn = now * .0006;
      ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(147,197,253,.7)';
      ctx.beginPath(); ctx.arc(x, y, r * 1.18, turn, turn + 1.2); ctx.stroke();
      ctx.strokeStyle = 'rgba(196,181,253,.6)';
      ctx.beginPath(); ctx.arc(x, y, r * 1.18, turn + Math.PI, turn + Math.PI + .8); ctx.stroke();
    }
    if (typeof Path2D === 'function') {
      if (!hubMarkPaths) hubMarkPaths = HUB_MARK.map(item => ({ path: new Path2D(item.d), tone: item.tone }));
      const size = r * 1.18, scale = size / 228;
      ctx.save();
      ctx.translate(x - 142 * scale, y - 120 * scale);
      ctx.scale(scale, scale);
      for (const item of hubMarkPaths) {
        ctx.fillStyle = item.tone === 'light' ? '#ffffff' : 'rgba(224,231,255,.72)';
        ctx.fill(item.path);
      }
      ctx.restore();
    }
    /* The repository's name, under the hub -- or above it where the spine of
     * the stacked layout runs down from its bottom. */
    ctx.font = "700 14px 'Public Sans Variable', system-ui, sans-serif";
    const name = fitText(ctx, node.label, 240);
    const w = ctx.measureText(name).width + 22;
    const ly = NVN.layoutMode === 'stack' ? y - r - 30 : y + r + 30;
    roundRect(ctx, x - w / 2, ly - 14, w, 28, 10);
    ctx.fillStyle = isLight() ? 'rgba(255,255,255,.94)' : 'rgba(10,12,30,.9)'; ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = isLight() ? 'rgba(49,46,129,.18)' : 'rgba(191,219,254,.28)'; ctx.stroke();
    ctx.fillStyle = colors.text; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(name, x, ly + .5);
    ctx.restore();
  }

  /*
   * Pointer handling.
   *
   * A press is not yet a click: it becomes a drag or a pan once it moves past a
   * few pixels, and only a press that stayed put selects. Without that, every
   * pan that happened to start on a node picked the node up instead.
   */
  const DRAG_THRESHOLD = 5;
  function bindCanvas() {
    const c = NVN.canvas;
    const pts = new Map();
    let pinchDist = 0, lastTap = 0;
    const twoFinger = () => pts.size >= 2;
    const pair = () => { const [a, b] = [...pts.values()]; return { a, b }; };
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    c.addEventListener('pointerdown', e => {
      c.setPointerCapture(e.pointerId);
      const pos = pointerPos(e);
      pts.set(e.pointerId, pos);
      NVN.camTarget = null;
      if (twoFinger()) {
        const { a, b } = pair(); pinchDist = dist(a, b);
        NVN.panning = false; NVN.pointerStart = null;
        return;
      }
      NVN.pointerStart = { x: pos.x, y: pos.y, panX: NVN.panX, panY: NVN.panY, node: hitNode(pos.x, pos.y), moved: false };
      NVN.lastPointer = pos;
    });
    c.addEventListener('pointermove', e => {
      const pos = pointerPos(e); NVN.lastPointer = pos;
      if (pts.has(e.pointerId)) pts.set(e.pointerId, pos);
      if (twoFinger()) {
        const { a, b } = pair();
        const d = dist(a, b), m = mid(a, b);
        if (pinchDist > 0 && d > 0) zoomAt(m.x, m.y, NVN.zoom * (d / pinchDist));
        pinchDist = d;
        return;
      }
      const start = NVN.pointerStart;
      if (start && pts.has(e.pointerId)) {
        /* A drag always moves the stage, from a row as from empty ground: every
         * node keeps its row, so the panels stay the order the reader learned. */
        if (!start.moved && Math.hypot(pos.x - start.x, pos.y - start.y) > DRAG_THRESHOLD) {
          start.moved = true;
          NVN.panning = true;
        }
        if (NVN.panning) {
          NVN.panX = start.panX + pos.x - start.x;
          NVN.panY = start.panY + pos.y - start.y;
        }
        return;
      }
      const hit = hitNode(pos.x, pos.y);
      if (hit !== NVN.hover) NVN.hover = hit;
      const panelHit = hit ? null : panelHitAt(pos.x, pos.y);
      c.style.cursor = hit || (panelHit && panelHit.kind !== 'body') ? 'pointer' : 'grab';
    });
    c.addEventListener('pointerleave', () => { if (!NVN.pointerStart) NVN.hover = null; });
    const up = e => {
      try { c.releasePointerCapture(e.pointerId); } catch {}
      pts.delete(e.pointerId);
      if (pts.size < 2) pinchDist = 0;
      const start = NVN.pointerStart;
      if (e.type === 'pointerup' && start && !start.moved && pts.size === 0) {
        const panelHit = start.node ? null : panelHitAt(start.x, start.y);
        if (start.node) selectNode(start.node, { fly: true });
        else if (panelHit && panelHit.kind === 'more') toggleGroupRows(panelHit.type);
        else if (panelHit && panelHit.kind === 'header') focusGroup(panelHit.type);
        else {
          if (NVN.selected || NVN.focusGroup) { selectNode(null); NVN.focusGroup = null; renderLegend(); }
          if (e.pointerType !== 'mouse') {
            const now = performance.now();
            if (now - lastTap < 320) { fitGraph(true); lastTap = 0; } else lastTap = now;
          }
        }
      }
      NVN.panning = false; NVN.pointerStart = null;
    };
    c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up);
    c.addEventListener('wheel', e => {
      e.preventDefault();
      NVN.camTarget = null;
      const pos = pointerPos(e);
      zoomAt(pos.x, pos.y, NVN.zoom * Math.exp(-e.deltaY * .0012));
    }, { passive: false });
    c.addEventListener('dblclick', e => {
      const pos = pointerPos(e);
      if (!hitNode(pos.x, pos.y)) fitGraph(true);
    });
    c.addEventListener('keydown', canvasKey);
  }
  function zoomAt(x, y, zoom) {
    const before = screenToWorld(x, y);
    NVN.zoom = clamp(zoom, .35, 2.6);
    const after = worldToScreen(before.x, before.y);
    NVN.panX += x - after.x; NVN.panY += y - after.y;
  }
  function zoomBy(factor) {
    const target = NVN.camTarget || { zoom: NVN.zoom, panX: NVN.panX, panY: NVN.panY };
    const zoom = clamp(target.zoom * factor, .35, 2.6);
    const scale = zoom / target.zoom;
    NVN.camTarget = { zoom, panX: target.panX * scale, panY: target.panY * scale };
  }
  /* What a press on a panel means, away from its rows: the header lights and
   * frames the group, "+ n more" opens it, the rest of the card is ground. */
  function panelHitAt(sx, sy) {
    const w = screenToWorld(sx, sy);
    for (const panel of NVN.panels || []) {
      if (w.x < panel.x || w.x > panel.x + panel.w || w.y < panel.y || w.y > panel.y + panel.h) continue;
      if (w.y < panel.y + HEAD_H) return { kind: 'header', type: panel.type };
      if (panel.moreY != null && Math.abs(w.y - panel.moreY) <= ROW_H / 2) return { kind: 'more', type: panel.type };
      return { kind: 'body', type: panel.type };
    }
    return null;
  }
  function toggleGroupRows(type) {
    const expanded = NVN.expandedGroups || (NVN.expandedGroups = new Set());
    if (expanded.has(type)) expanded.delete(type); else expanded.add(type);
    layoutGraph();
    const panel = (NVN.panels || []).find(item => item.type === type);
    if (panel) fitRect({ minX: panel.x - 30, minY: panel.y - 30, maxX: panel.x + panel.w + 30, maxY: panel.y + panel.h + 30 }, true, 1.25, true);
  }

  function pointerPos(e) { const r = NVN.canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  /* A node is hit on its disc or anywhere on its row, so its name is as good a
   * target as its icon. */
  function hitNode(sx, sy) {
    const w = screenToWorld(sx, sy);
    let best = null, bestD = Infinity;
    for (const n of NVN.nodes) {
      if (!n.visible || n.folded) continue;
      const r = worldRadius(n) + (n.type === 'repo' ? 10 : 7);
      const d = Math.hypot(n.x - w.x, n.y - w.y);
      if (d < r && d < bestD) { best = n; bestD = d; }
    }
    if (best) return best;
    for (const panel of NVN.panels || []) {
      if (w.x < panel.x + 6 || w.x > panel.x + panel.w - 6) continue;
      const row = Math.floor((w.y - panel.y - HEAD_H) / ROW_H);
      if (row >= 0 && row < panel.shown.length) return panel.shown[row];
    }
    return null;
  }


  /*
   * The keyboard walks the graph: arrows move to the nearest node in that
   * direction, Enter opens its card, Escape closes it. Every selection is
   * announced, so the graph is usable without seeing it.
   */
  function canvasKey(e) {
    const key = e.key;
    if (key === 'Escape') {
      if (NVN.selected || NVN.focusGroup) { e.preventDefault(); e.stopPropagation(); NVN.focusGroup = null; selectNode(null); renderLegend(); }
      return;
    }
    if (key === '+' || key === '=') { e.preventDefault(); zoomBy(1.2); return; }
    if (key === '-') { e.preventDefault(); zoomBy(1 / 1.2); return; }
    if (key.toLowerCase() === 'f') { e.preventDefault(); fitGraph(true); return; }
    const dirs = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] };
    if (dirs[key]) {
      e.preventDefault();
      const from = NVN.selected || NVN.nodes.find(n => n.type === 'repo' && n.visible);
      if (!from) return;
      const [dx, dy] = dirs[key];
      let best = null, bestScore = Infinity;
      for (const n of NVN.nodes) {
        if (!n.visible || n.folded || n === from) continue;
        const vx = n.tx - from.tx, vy = n.ty - from.ty;
        const along = vx * dx + vy * dy;
        if (along <= 1) continue;
        const across = Math.abs(vx * dy - vy * dx);
        const score = along + across * 2.2;
        if (score < bestScore) { bestScore = score; best = n; }
      }
      if (best) selectNode(best, { fly: true, announce: true });
      return;
    }
    if ((key === 'Enter' || key === ' ') && !NVN.selected) {
      e.preventDefault();
      const repo = NVN.nodes.find(n => n.type === 'repo' && n.visible);
      if (repo) selectNode(repo, { fly: true, announce: true });
    }
  }

  /*
   * Enlarge the graph.
   *
   * The stage shares its row with a rail and an inspector, and on a phone it is
   * a few hundred pixels tall, so a graph of any size is read through a
   * letterbox. Expanding is done in CSS rather than through the Fullscreen API
   * because element fullscreen does not exist on iOS Safari, and a control that
   * works on three platforms out of four is worse than one that works
   * everywhere.
   *
   * The stage is already watched by a ResizeObserver, so the canvas resizes
   * itself; this only has to re-fit the graph into the space it just gained.
   */
  function stageExpanded() {
    return document.body.classList.contains('neural-stage-expanded');
  }

  /*
   * The modes, filters and response controls live in a rail beside the stage.
   * Enlarging the stage covers that rail, so changing intelligence mode would
   * have meant collapsing, changing, and enlarging again -- three steps to do
   * the thing the enlarged view exists for.
   *
   * The rail is moved into the stage rather than duplicated inside it. One set
   * of controls keeps one set of listeners and one source of truth; a second
   * copy would need its own wiring and would drift out of step with the first.
   */
  let _railHome = null;
  function dockRail(intoStage) {
    const rail = document.getElementById('neuralRail');
    const stage = document.getElementById('neuralStage');
    if (!rail || !stage) return;
    if (intoStage) {
      if (!_railHome) {
        _railHome = document.createComment('neural-rail-home');
        rail.parentNode.insertBefore(_railHome, rail);
      }
      stage.appendChild(rail);
      rail.classList.add('is-docked');
    } else if (_railHome && _railHome.parentNode) {
      _railHome.parentNode.insertBefore(rail, _railHome);
      rail.classList.remove('is-docked');
    }
  }

  function panelOpen() {
    const stage = document.getElementById('neuralStage');
    return !!stage && stage.classList.contains('panel-open');
  }

  function setPanelOpen(open) {
    const stage = document.getElementById('neuralStage');
    const button = document.getElementById('neuralPanelBtn');
    if (!stage) return;
    stage.classList.toggle('panel-open', open);
    if (button) {
      button.setAttribute('aria-pressed', open ? 'true' : 'false');
      const label = open ? 'Hide modes and filters' : 'Modes and filters';
      button.setAttribute('aria-label', label);
      button.setAttribute('title', label);
    }
    /* The graph loses or regains width beside the panel on a wide screen. */
    requestAnimationFrame(() => requestAnimationFrame(() => fitGraph(true)));
  }

  function setStageExpanded(expanded) {
    const stage = document.getElementById('neuralStage');
    const button = document.getElementById('neuralExpandBtn');
    if (!stage || stageExpanded() === expanded) return;
    document.body.classList.toggle('neural-stage-expanded', expanded);
    stage.classList.toggle('is-expanded', expanded);
    dockRail(expanded);
    /* Room decides the default: a wide screen can hold the panel and the graph
     * at once, a phone cannot, and the point of enlarging there was the room. */
    setPanelOpen(expanded && window.matchMedia('(min-width: 900px)').matches);
    if (button) {
      button.setAttribute('aria-pressed', expanded ? 'true' : 'false');
      const label = expanded ? 'Return the graph to the page' : 'Enlarge the graph';
      button.setAttribute('aria-label', label);
      button.setAttribute('title', label);
    }
    /* The canvas is resized by the observer; the graph still has to be re-fitted
     * into the space, and one frame later so the new size is measured. */
    requestAnimationFrame(() => requestAnimationFrame(() => fitGraph(true)));
    if (!expanded && button) button.focus();
  }

  function wireStageExpansion() {
    const button = document.getElementById('neuralExpandBtn');
    if (!button || button.dataset.wired === '1') return;
    button.dataset.wired = '1';
    button.addEventListener('click', () => setStageExpanded(!stageExpanded()));
    document.getElementById('neuralPanelBtn')?.addEventListener('click', () => setPanelOpen(!panelOpen()));
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || !stageExpanded()) return;
      /* A modal opened over the expanded stage owns Escape first. */
      if (document.querySelector('.scrim:not([hidden])')) return;
      event.preventDefault();
      /* Escape backs out one step at a time: the panel, then the enlargement. */
      if (panelOpen()) setPanelOpen(false);
      else setStageExpanded(false);
    });
  }

  /* The part of the canvas nothing is drawn over: the status bar and search
   * above, the tool column on the right, and the modes panel on the left when
   * the enlarged stage has it open. */
  function viewportInsets() {
    const stage = document.getElementById('neuralStage');
    const rail = document.getElementById('neuralRail');
    const panel = stage && stage.classList.contains('panel-open') && rail && rail.classList.contains('is-docked') && window.matchMedia('(min-width: 900px)').matches
      ? rail.getBoundingClientRect().width : 0;
    return { left: panel + 16, right: 64, top: 64, bottom: 20 };
  }
  /*
   * Frames a world rectangle in the part of the stage nothing covers. A tall
   * stacked layout is framed by its width and read from the top down, the way
   * a list is -- fitting all of its height would shrink it past reading.
   */
  function fitRect(b, animateFit = true, maxZoom = 1.35, whole = false) {
    if (!NVN.width || !NVN.height) { NVN.fitPending = true; return; }
    NVN.fitPending = false;
    const inset = viewportInsets();
    const boxW = Math.max(80, NVN.width - inset.left - inset.right);
    const boxH = Math.max(80, NVN.height - inset.top - inset.bottom);
    const byWidth = boxW / Math.max(1, b.maxX - b.minX);
    const byHeight = boxH / Math.max(1, b.maxY - b.minY);
    const tall = NVN.layoutMode === 'stack' && !whole;
    const zoom = clamp(tall ? Math.min(byWidth, 1.1) : Math.min(byWidth, byHeight), .3, maxZoom);
    const offsetX = inset.left + boxW / 2 - NVN.width / 2;
    const panX = offsetX - ((b.minX + b.maxX) / 2) * zoom;
    const panY = tall && (b.maxY - b.minY) * zoom > boxH
      ? inset.top - NVN.height / 2 - b.minY * zoom
      : inset.top + boxH / 2 - NVN.height / 2 - ((b.minY + b.maxY) / 2) * zoom;
    const target = { zoom, panX, panY };
    if (!animateFit || !state.settings.motion) { NVN.zoom = zoom; NVN.panX = panX; NVN.panY = panY; NVN.camTarget = null; return; }
    NVN.camTarget = target;
  }
  function fitGraph(animateFit = true) {
    if (!(NVN.panels || []).length && !visibleNodes().length) return;
    fitRect(layoutBounds(), animateFit);
  }

  /*
   * Selection opens a card beside the node rather than filling a panel off to
   * the side, so what was clicked and what it means are in the same place. The
   * camera moves only when it has to: when the node is off screen, or where the
   * card is about to cover it.
   */
  function selectNode(node, options = {}) {
    const previous = NVN.selected;
    NVN.selected = node;
    if (!node) { closeCard(); return; }
    if (node.folded) {
      (NVN.expandedGroups || (NVN.expandedGroups = new Set())).add(node.type);
      layoutGraph();
    }
    renderCard(node, previous !== node);
    if (options.fly) flyToNode(node);
    if (options.announce) announceNode(node);
  }
  function flyToNode(node) {
    const W = NVN.width, H = NVN.height;
    if (!W || !H) return;
    const zoom = Math.max(NVN.camTarget ? NVN.camTarget.zoom : NVN.zoom, .75);
    const docked = cardDocked();
    const x = node.tx ?? node.x, y = node.ty ?? node.y;
    const current = worldToScreen(x, y);
    const nodePanel = (NVN.panels || []).find(item => item.type === node.type);
    const goalLimit = W - 64 - CARD_WIDTH - 16 - (nodePanel ? (nodePanel.x + nodePanel.w - x) * zoom : 0);
    const comfortable = docked
      ? current.x > W * .15 && current.x < W * .85 && current.y > 70 && current.y < H * .42
      : current.x > viewportInsets().left + 40 && current.x < goalLimit && current.y > H * .18 && current.y < H * .82;
    if (comfortable && zoom === NVN.zoom) return;
    const inset = viewportInsets();
    const panel = (NVN.panels || []).find(item => item.type === node.type);
    /* Where the node must sit for its whole panel, and the card beside it, to
     * fit: the panel's right edge lands just short of the card. */
    const toRight = panel ? (panel.x + panel.w - x) * zoom : worldRadius(node) * zoom;
    const goalX = docked ? W * .5 : clamp(W - 64 - CARD_WIDTH - 16 - toRight, inset.left + 50, Math.max(inset.left + 50, W * .6));
    const goalY = docked ? H * .27 : H * .5;
    NVN.camTarget = { zoom, panX: goalX - W / 2 - x * zoom, panY: goalY - H / 2 - y * zoom };
  }

  function announceNode(node) {
    const live = document.getElementById('neuralLive');
    if (!live || !node) return;
    const count = NVN.edges.filter(e => e.visible && (e.source === node.id || e.target === node.id)).length;
    const severity = node.severity === 'critical' ? 'critical signal' : node.severity === 'warning' ? 'review recommended' : 'normal';
    live.textContent = `${(TYPE_STYLE[node.type] || {}).label || 'Node'}: ${node.label}. ${severity}. ${count} connection${count === 1 ? '' : 's'}.`;
  }

  function iconSvg(type) {
    const d = TYPE_ICON[type];
    if (!d) return '';
    return type === 'repo'
      ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" stroke="none" d="${d}"/></svg>`
      : `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
  }
  function factValue(value) {
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    const text = String(value);
    if (/^\d{4}-\d{2}-\d{2}T/.test(text) && !Number.isNaN(Date.parse(text))) return timeAgoN(text);
    return short(text, 40);
  }
  const FACT_SKIP = new Set(['description', 'summary', 'message', 'title', 'verifiedEvent', 'url']);

  /*
   * Where the card goes. Beside the node when the stage has room for both; along
   * the bottom of the stage when it does not; and on a phone, where the stage is
   * a strip between the header and the bottom navigation, as a sheet over the
   * page, which is the only place with room to read it.
   */
  const CARD_WIDTH = 312;
  let cardHome = null;
  function cardMode() {
    if (window.innerWidth < 720 && !stageExpanded()) return 'sheet';
    return NVN.width < CARD_WIDTH + 300 ? 'docked' : 'float';
  }
  function cardDocked() { return cardMode() !== 'float'; }
  function placeCardElement(card) {
    const mode = cardMode();
    const stage = document.getElementById('neuralStage');
    if (mode === 'sheet' && card.parentNode !== document.body) {
      if (!cardHome) { cardHome = document.createComment('neural-card-home'); card.parentNode.insertBefore(cardHome, card); }
      document.body.appendChild(card);
    } else if (mode !== 'sheet' && card.parentNode === document.body) {
      if (cardHome && cardHome.parentNode) cardHome.parentNode.insertBefore(card, cardHome);
      else if (stage) stage.appendChild(card);
    }
    card.classList.toggle('is-sheet', mode === 'sheet');
    card.classList.toggle('is-docked', mode === 'docked');
    return mode;
  }

  function renderCard(node, fresh) {
    const card = document.getElementById('neuralCard');
    if (!card) return;
    const st = TYPE_STYLE[node.type] || TYPE_STYLE.repo;
    const links = NVN.edges
      .filter(e => e.visible && (e.source === node.id || e.target === node.id))
      .map(e => ({ edge: e, other: nodeById(e.source === node.id ? e.target : e.source) }))
      .filter(item => item.other)
      .sort((a, b) => (SEVERITY_RANK[a.edge.severity] ?? 2) - (SEVERITY_RANK[b.edge.severity] ?? 2) || a.other.label.localeCompare(b.other.label));
    const facts = Object.entries(node.meta || {})
      .filter(([k, v]) => !FACT_SKIP.has(k) && v !== '' && v != null && typeof v !== 'object')
      .slice(0, 6);
    const desc = node.meta.description || inspectorDescription(node);
    const status = node.severity === 'critical' ? 'Critical signal' : node.severity === 'warning' ? 'Review recommended' : 'Normal';
    const shown = links.slice(0, 8);
    card.style.setProperty('--node', node.color);
    card.innerHTML = `
      <header class="neural-card-head">
        <span class="neural-card-icon" aria-hidden="true">${iconSvg(node.type) || nodeBadge(node)}</span>
        <div class="neural-card-title"><span class="neural-card-kicker">${nEsc(st.label)}</span><h3 id="neuralCardTitle">${nEsc(node.label)}</h3></div>
        <button type="button" class="neural-card-close" data-neural-card-close aria-label="Close details"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg></button>
      </header>
      <div class="neural-card-body">
        <span class="neural-card-status" data-severity="${nEsc(node.severity || 'normal')}"><i aria-hidden="true"></i>${status}</span>
        <p class="neural-card-copy">${nEsc(desc)}</p>
        ${facts.length ? `<dl class="neural-card-facts">${facts.map(([k, v]) => `<div><dt>${nEsc(k.replace(/([A-Z])/g, ' $1').toLowerCase())}</dt><dd>${nEsc(factValue(v))}</dd></div>`).join('')}</dl>` : ''}
        <h4 class="neural-card-section">Connected <span>${links.length}</span></h4>
        ${shown.length ? `<ul class="neural-card-links">${shown.map(({ edge, other }) => `<li><button type="button" data-neural-goto="${nEsc(other.id)}" style="--node:${nEsc(other.color)}"><i aria-hidden="true">${iconSvg(other.type)}</i><span><b>${nEsc(short(other.label, 30))}</b><small>${nEsc(edge.type)}</small></span>${edge.severity !== 'normal' ? `<em data-severity="${nEsc(edge.severity)}" aria-label="${edge.severity === 'critical' ? 'critical' : 'warning'}"></em>` : ''}</button></li>`).join('')}</ul>${links.length > shown.length ? `<p class="neural-card-more">${links.length - shown.length} more in the graph</p>` : ''}` : '<p class="neural-card-more">Nothing connected in this mode.</p>'}
        <div class="neural-card-actions">${inspectorActions(node)}</div>
      </div>`;
    card.hidden = false;
    NVN.cardMode = placeCardElement(card);
    if (fresh) {
      card.classList.remove('is-entering');
      void card.offsetWidth;
      card.classList.add('is-entering');
    }
    NVN.cardSize = { w: card.offsetWidth, h: card.offsetHeight };
    NVN.cardPos = null;
    positionCard();
  }
  function renderInspector(node) {
    if (node) renderCard(node, false);
    else closeCard();
  }
  function closeCard() {
    const card = document.getElementById('neuralCard');
    if (!card || card.hidden) return;
    const hadFocus = card.contains(document.activeElement);
    card.hidden = true;
    card.innerHTML = '';
    card.classList.remove('is-sheet', 'is-docked');
    NVN.cardMode = null;
    if (card.parentNode === document.body && cardHome && cardHome.parentNode) cardHome.parentNode.insertBefore(card, cardHome);
    NVN.cardPos = null;
    if (hadFocus && NVN.canvas) NVN.canvas.focus({ preventScroll: true });
  }
  function positionCard() {
    const card = document.getElementById('neuralCard');
    const node = NVN.selected;
    if (!card || card.hidden || !node) return;
    const mode = cardMode();
    if (mode !== NVN.cardMode) {
      NVN.cardMode = placeCardElement(card);
      NVN.cardSize = { w: card.offsetWidth, h: card.offsetHeight };
    }
    if (mode !== 'float') {
      if (NVN.cardPos) { card.style.left = ''; card.style.top = ''; NVN.cardPos = null; }
      return;
    }
    const W = NVN.width, H = NVN.height;
    const size = NVN.cardSize || { w: card.offsetWidth, h: card.offsetHeight };
    const p = worldToScreen(node.x, node.y);
    /* Beside the node's panel, not over it: the rows under the card are the
     * node's own group, and the reader is usually comparing it with them. */
    const panel = (NVN.panels || []).find(item => item.type === node.type);
    const leftEdge0 = panel ? worldToScreen(panel.x, 0).x : p.x - nodeRadius(node) - 12;
    const rightEdge0 = panel ? worldToScreen(panel.x + panel.w, 0).x : p.x + nodeRadius(node) + 12;
    let left = rightEdge0 + 16, side = 'right';
    if (left + size.w > W - 60) { left = leftEdge0 - 16 - size.w; side = 'left'; }
    const leftEdge = viewportInsets().left - 4;
    left = clamp(left, leftEdge, Math.max(leftEdge, W - size.w - 60));
    const top = clamp(p.y - 44, 62, Math.max(62, H - size.h - 12));
    const prev = NVN.cardPos;
    if (!prev || Math.abs(prev.left - left) > .5 || Math.abs(prev.top - top) > .5) {
      card.style.left = `${Math.round(left)}px`;
      card.style.top = `${Math.round(top)}px`;
      card.dataset.side = side;
      NVN.cardPos = { left, top, side, w: size.w, h: size.h };
    }
  }
  /* A thin line from the node to its card, so the card is visibly about that
   * node even after the graph has moved underneath it. */
  function drawLeader(ctx, colors) {
    const node = NVN.selected;
    const pos = NVN.cardPos;
    if (!node || !pos || cardDocked()) return;
    const card = document.getElementById('neuralCard');
    if (!card || card.hidden) return;
    const p = worldToScreen(node.x, node.y);
    const r = node.type === 'repo' ? nodeRadius(node) * 1.1 : nodeRadius(node) * 1.1;
    const ex = pos.side === 'right' ? pos.left : pos.left + pos.w;
    const ey = clamp(p.y, pos.top + 18, pos.top + pos.h - 18);
    /* The line leaves from the row's end, so it runs along the row it names. */
    const panel = (NVN.panels || []).find(item => item.type === node.type);
    const rowEnd = panel ? worldToScreen(pos.side === 'right' ? panel.x + panel.w - 6 : panel.x + 6, node.y) : null;
    const angle = Math.atan2(ey - p.y, ex - p.x);
    const sx = rowEnd ? rowEnd.x : p.x + Math.cos(angle) * (r + 3);
    const sy = rowEnd ? rowEnd.y : p.y + Math.sin(angle) * (r + 3);
    ctx.save();
    ctx.strokeStyle = hexAlpha(node.color, .7);
    ctx.lineWidth = 1.2;
    ctx.setLineDash([3, 4]);
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = colors.ink(node.color);
    ctx.beginPath(); ctx.arc(ex, ey, 3, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  /*
   * The legend is the list of groups actually on screen, with their counts,
   * and each entry is a control: pressing one lights that group and frames it.
   */
  function renderLegend() {
    const host = document.getElementById('neuralLegend');
    if (!host) return;
    const counts = new Map();
    for (const n of NVN.nodes) if (n.visible && n.type !== 'repo') counts.set(n.type, (counts.get(n.type) || 0) + 1);
    const types = [...counts.keys()].sort((a, b) => (CLUSTER_ANGLE[a] ?? 0) - (CLUSTER_ANGLE[b] ?? 0));
    if (NVN.focusGroup && !counts.has(NVN.focusGroup)) NVN.focusGroup = null;
    host.innerHTML = types.map(type => {
      const st = TYPE_STYLE[type] || TYPE_STYLE.repo;
      const on = NVN.focusGroup === type;
      return `<button type="button" class="neural-chip${on ? ' is-on' : ''}" data-neural-group="${nEsc(type)}" aria-pressed="${on}" style="--node:${nEsc(st.color)}"><i aria-hidden="true"></i>${nEsc(st.plural || st.label)}<b>${counts.get(type)}</b></button>`;
    }).join('');
    host.hidden = !types.length;
  }
  function focusGroup(type) {
    NVN.focusGroup = NVN.focusGroup === type ? null : type;
    if (NVN.focusGroup) selectNode(null);
    renderLegend();
    const panel = (NVN.panels || []).find(item => item.type === NVN.focusGroup);
    if (panel) fitRect({ minX: Math.min(panel.x, -HUB_R) - 30, minY: Math.min(panel.y, -HUB_R) - 30, maxX: Math.max(panel.x + panel.w, HUB_R) + 30, maxY: Math.max(panel.y + panel.h, HUB_R) + 30 }, true, 1.2, true);
    else fitGraph(true);
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
      /* On a narrow screen the panel covers most of the graph, so choosing a
       * mode gets out of the way to show its result. */
      if (panelOpen() && !window.matchMedia('(min-width: 900px)').matches) setPanelOpen(false);
      applyMode(); fitGraph(true);
    });
    document.querySelectorAll('[data-neural-filter]').forEach(cb => cb.addEventListener('change', () => { NVN.filters[cb.dataset.neuralFilter] = cb.checked; applyMode(); }));
    document.getElementById('neuralSearch')?.addEventListener('input', e => {
      NVN.search = e.target.value; applyMode();
      const matches = visibleNodes(); if (NVN.search && matches.length) selectNode(matches[0], { fly: true }); else if (!NVN.search) fitGraph(true);
    });
    document.getElementById('neuralLiveBtn')?.addEventListener('click', liveConnectionFlow);
    document.getElementById('neuralRefreshBtn')?.addEventListener('click', () => load(true));
    document.getElementById('neuralFitBtn')?.addEventListener('click', () => fitGraph(true));
    wireStageExpansion();
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
    const card = document.getElementById('neuralCard');
    card?.addEventListener('click', event => {
      if (event.target.closest('[data-neural-card-close]')) { selectNode(null); NVN.canvas?.focus({ preventScroll: true }); return; }
      const goto = event.target.closest('[data-neural-goto]');
      if (goto) { const node = nodeById(goto.dataset.neuralGoto); if (node) selectNode(node, { fly: true, announce: true }); return; }
      inspectorClick(event);
    });
    /* Escape closes an open card from anywhere on the page -- the card may be
     * a sheet appended to the body, far from the canvas that has focus rules
     * of its own. It runs before the enlarged stage's own Escape, so one press
     * closes the card and the next leaves the enlargement. A dialog opened
     * over the graph keeps Escape for itself. */
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || !NVN.selected) return;
      const open = document.getElementById('neuralCard');
      if (!open || open.hidden || document.querySelector('.scrim:not([hidden])')) return;
      event.preventDefault(); event.stopPropagation();
      const hadFocus = open.contains(document.activeElement);
      selectNode(null);
      if (hadFocus) NVN.canvas?.focus({ preventScroll: true });
    }, true);
    document.getElementById('neuralLegend')?.addEventListener('click', event => {
      const chip = event.target.closest('[data-neural-group]'); if (chip) focusGroup(chip.dataset.neuralGroup);
    });
    document.getElementById('neuralZoomInBtn')?.addEventListener('click', () => zoomBy(1.25));
    document.getElementById('neuralZoomOutBtn')?.addEventListener('click', () => zoomBy(1 / 1.25));
  }

  function togglePause() {
    NVN.paused = !NVN.paused;
    const b = document.getElementById('neuralPlayBtn'); if (b) b.innerHTML = NVN.paused
      /* nt-filled: these two are solid shapes, and the tool stylesheet strokes
       * every other icon. Rebuilding this markup without the class is how the
       * play control would quietly become an outline after the first toggle. */
      ? '<svg class="nt-filled" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4l13 8-13 8z" fill="currentColor" stroke="none"/></svg>'
      : '<svg class="nt-filled" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4h3v16H8zM13 4h3v16h-3z" fill="currentColor" stroke="none"/></svg>';
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
    if (node && node.visible) selectNode(node, { fly: true });
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
    applyMode(); updateTimeline(true); fitGraph(true);
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
  function collapseStageOnLeave() {
    /* Leaving the destination while expanded would leave a fixed overlay and a
     * locked page behind it. */
    if (stageExpanded()) setStageExpanded(false);
  }

  function deactivate() {
    NVN.active = false;
    collapseStageOnLeave();
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
