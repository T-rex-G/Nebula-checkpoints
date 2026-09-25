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
    leak:          { color: '#ff8a5c', glyph: '!', radius: 12, label: 'Leaked credential', plural: 'Leaked credentials', short: 'Leaked keys' },
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
    /* The key, with the warning stroke where its teeth were: a credential that
     * is out in the open. */
    leak: 'M7.5 19.8a3.9 3.9 0 1 0 0-7.8 3.9 3.9 0 0 0 0 7.8zM10.3 13.2l5.6-5.6M13 10.5l1.7 1.7M19.5 3.6v5.2M19.5 11.6v.1',
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
    security: new Set(['repo', 'user', 'session', 'branch', 'commit', 'workflow', 'protected', 'package', 'vulnerability', 'safety', 'snapshot', 'external', 'credential', 'leak', 'integration']),
    recovery: new Set(['repo', 'branch', 'tag', 'commit', 'release', 'snapshot', 'safety', 'protected']),
    dependencies: new Set(['repo', 'package', 'vulnerability', 'workflow', 'protected', 'scan']),
    governance: new Set(['repo', 'user', 'session', 'branch', 'protected', 'safety', 'pull', 'workflow', 'snapshot', 'credential', 'leak', 'integration']),
    activity: new Set(['repo', 'user', 'branch', 'commit', 'pull', 'issue', 'release', 'workflow', 'protected'])
  };

  const NVN = {
    active: false,
    loadedKey: '',
    loading: false,
    mode: 'security',
    paused: false,
    /* Whether the reader has moved the camera since the graph was last
     * framed; an unmoved graph re-frames itself when the stage changes size. */
    userCamera: false,
    insets: null,
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
    groupPages: new Map(),
    hiddenGroups: new Set(),
    totals: {},
    layoutMode: 'split',
    version: 0,
    fx: null,
    fxCtx: null,
    staticKey: '',
    frameKey: '',
    lastDraw: 0,
    onScreen: true,
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
  /* A count from a server response, as it may appear in markup: a number,
   * whatever the response held. */
  function nNum(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n) : 0;
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
    /* The full-stage "Mapping…" cover is for the first load only. A refresh
     * -- every two minutes, or after an action -- used to raise it over the
     * whole graph, so the strands and their signals vanished each time the
     * map was polled; now the graph stays up and the status says it is
     * syncing. */
    const refreshing = NVN.nodes.length > 0;
    if (loading) loading.hidden = refreshing;
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
        api('/api/security/scanner-status'),
        /* What the Exposure scans found -- in the tree and in history --
         * already masked by the server: never the secret, and a path only as
         * a screen may show it. */
        api(`${base}/exposure/findings?limit=60`)
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
      const exposure = settledValue(requests[11], { findings: [], verifications: {} });
      const storedSnapshot = readStoredSnapshot();
      NVN.data = { safety, refs, activity, deps, actions, sessions, live, intelligence, signedSnapshots, access, scanner, exposure, storedSnapshot, errors: requests.map(r => r.status === 'rejected' ? r.reason && r.reason.message : '').filter(Boolean) };
      NVN.intelligenceCursor = intelligence && intelligence.cursor ? intelligence.cursor : '';
      buildGraph(NVN.data);
      NVN.loadedKey = key;
      NVN.demo = false;
      updateSummary();
      updateTimeline(true);
      /* A refresh leaves the camera where the reader put it; it re-frames
       * only a graph the reader has not moved. */
      if (!refreshing) fitGraph(false);
      else if (!NVN.userCamera) fitGraph(true);
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
    /* A large repository has more of most things than a graph can show. The
     * inventories keep their most telling members -- a branch list starts
     * with the default, the working and the protected branches -- and record
     * how many there were, so a panel says "60 of 312" instead of letting the
     * reader believe 60 is all there is. */
    const totals = {};
    const keep = (type, list, max) => {
      const all = list || [];
      if (all.length > max) totals[type] = (totals[type] || 0) + all.length;
      return all.slice(0, max);
    };
    const ordered = (node, order) => { if (node && node.order == null) node.order = order; return node; };
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
    keep('session', sessionList, 12).forEach((s, i) => {
      const id = `session:${i}`;
      addNode(nodeMap, id, 'session', s.current ? 'Current session' : `Active session ${i + 1}`, {
        current: !!s.current, updated: s.updated || '', provider: s.provider || '',
        description: s.current ? 'This browser session.' : 'Another active Nebulaverse-X session for this identity.'
      }, s.current ? 'normal' : 'warning');
      addEdge(edges, 'user:current', id, 'owns session', s.current ? 'normal' : 'warning');
      addEdge(edges, id, repoId, 'repository access', s.current ? 'normal' : 'warning');
    });

    const branchRank = b => (b.name === data.refs.defaultBranch ? 0 : b.name === w.branch ? 1 : b.protected ? 2 : 3);
    const branches = keep('branch', (data.refs.refs || []).slice().sort((a, b) =>
      branchRank(a) - branchRank(b) || String(a.name).localeCompare(String(b.name))), 60);
    branches.forEach((b, i) => {
      const id = `branch:${b.name}`;
      const sev = b.protected ? 'normal' : (b.name === data.refs.defaultBranch ? 'warning' : 'normal');
      ordered(addNode(nodeMap, id, 'branch', b.name, {
        sha: b.sha, protected: !!b.protected, default: b.name === data.refs.defaultBranch,
        description: b.protected ? 'Provider-protected branch.' : 'Repository branch reference.'
      }, sev), i);
      addEdge(edges, repoId, id, b.protected ? 'protected ref' : 'branch ref', sev);
    });
    keep('tag', data.refs.tags, 24).forEach(t => {
      const id = `tag:${t.name}`;
      addNode(nodeMap, id, 'tag', t.name, { sha: t.sha, description: 'Immutable release or version marker.' });
      addEdge(edges, repoId, id, 'tag ref');
    });

    const currentBranchId = nodeMap.has(`branch:${w.branch}`) ? `branch:${w.branch}` : repoId;
    let previousCommit = currentBranchId;
    (data.activity.commits || []).slice(0, 22).forEach((c, i) => {
      const id = `commit:${c.sha}`;
      const suspicious = /force|secret|password|disable|bypass|hotfix/i.test(`${c.message || ''}`);
      ordered(addNode(nodeMap, id, 'commit', short(c.message || c.sha.slice(0, 8), 34), {
        sha: c.sha, author: c.author, date: c.date, message: c.message,
        description: 'Recent commit observed in repository activity.'
      }, suspicious ? 'warning' : 'normal'), i);
      addEdge(edges, previousCommit, id, i ? 'previous commit' : 'head commit', suspicious ? 'warning' : 'normal', { time: c.date });
      addEvent(events, 'commit', c.message || 'Commit', `${c.author || 'Unknown author'} · ${c.sha.slice(0, 8)}`, c.date, id, `${previousCommit}>${id}:${i ? 'previous commit' : 'head commit'}`, suspicious ? 'warning' : 'normal');
      previousCommit = id;
    });

    (data.activity.pulls || []).slice(0, 10).forEach((p, order) => {
      const id = `pull:${p.number}`;
      ordered(addNode(nodeMap, id, 'pull', `#${p.number} ${short(p.title, 30)}`, {
        number: p.number, state: p.state, updated: p.updated, title: p.title,
        description: `Pull request currently ${p.state}.`
      }, p.state === 'open' ? 'warning' : 'normal'), order);
      addEdge(edges, repoId, id, 'pull request', p.state === 'open' ? 'warning' : 'normal', { time: p.updated });
      addEvent(events, 'pull', p.title, `Pull request #${p.number} · ${p.state}`, p.updated, id, '', p.state === 'open' ? 'warning' : 'normal');
    });
    (data.activity.issues || []).slice(0, 8).forEach((i, order) => {
      const id = `issue:${i.number}`;
      ordered(addNode(nodeMap, id, 'issue', `#${i.number} ${short(i.title, 30)}`, {
        number: i.number, state: i.state, updated: i.updated, title: i.title,
        description: `Issue currently ${i.state}.`
      }, i.state === 'open' ? 'warning' : 'normal'), order);
      addEdge(edges, repoId, id, 'issue', i.state === 'open' ? 'warning' : 'normal', { time: i.updated });
      addEvent(events, 'issue', i.title, `Issue #${i.number} · ${i.state}`, i.updated, id, '', i.state === 'open' ? 'warning' : 'normal');
    });
    (data.activity.releases || []).slice(0, 7).forEach((r, order) => {
      const id = `release:${r.tag}`;
      ordered(addNode(nodeMap, id, 'release', r.name || r.tag, { tag: r.tag, published: r.published, description: 'Published repository release.' }), order);
      addEdge(edges, repoId, id, 'release', 'normal', { time: r.published });
      addEvent(events, 'release', r.name || r.tag, `Release ${r.tag}`, r.published, id);
    });

    (data.actions || []).slice(0, 14).forEach((a, order) => {
      const id = `workflow:${a.id}`;
      const failed = a.conclusion === 'failure' || a.conclusion === 'cancelled';
      const running = a.status !== 'completed';
      const sev = failed ? 'critical' : running ? 'warning' : 'normal';
      ordered(addNode(nodeMap, id, 'workflow', short(a.name || `Workflow #${a.number}`, 31), {
        status: a.status, conclusion: a.conclusion || 'running', branch: a.branch, event: a.event,
        created: a.created_at, url: a.html_url, runId: a.id,
        description: failed ? 'A recent workflow did not complete successfully.' : 'Recent GitHub Actions workflow run.'
      }, sev), order);
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
    keep('user', access.collaborators, 60).forEach(collaborator => {
      const id = collaborator.login === login ? 'user:current' : `access:user:${collaborator.login}`;
      const privileged = ['admin', 'maintain', 'write'].includes(String(collaborator.permission || '').toLowerCase());
      addNode(nodeMap, id, 'user', collaborator.login, {
        permission: collaborator.permission || 'unknown', accountType: collaborator.type || 'User',
        description: `Repository collaborator with ${collaborator.permission || 'unknown'} permission.`
      }, String(collaborator.permission || '').toLowerCase() === 'admin' ? 'warning' : 'normal');
      addEdge(edges, id, repoId, privileged ? 'can modify repository' : 'can read repository', privileged ? 'warning' : 'normal');
    });
    keep('credential', access.deployKeys, 30).forEach(key => {
      const id = `credential:${key.id}`;
      const severity = key.readOnly === false ? 'critical' : key.verified === false ? 'warning' : 'normal';
      addNode(nodeMap, id, 'credential', key.title || `Deploy key ${key.id}`, {
        readOnly: key.readOnly !== false, verified: key.verified !== false, createdAt: key.createdAt || '',
        description: key.readOnly === false ? 'A deploy key with repository write access.' : 'A read-only repository deploy key.'
      }, severity);
      addEdge(edges, id, repoId, key.readOnly === false ? 'write credential' : 'read credential', severity);
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
    const exposure = data.exposure || { findings: [], verifications: {} };
    const verifications = exposure.verifications || {};
    const ruleLabel = rule => (typeof exposureRuleLabel === 'function' ? exposureRuleLabel(rule) : String(rule || 'Credential'));
    keep('leak', (exposure.findings || []).filter(finding => finding && finding.fingerprint), 60).forEach(finding => {
      const id = `leak:${finding.fingerprint}`;
      const disposition = finding.disposition || 'open';
      const verification = verifications[finding.fingerprint] || null;
      const kind = finding.narration && finding.narration.severity;
      const severity = disposition === 'credential-rejected' || (verification && verification.state === 'rejected') ? 'normal'
        : disposition === 'open' && ((verification && verification.state === 'verified') || kind === 'critical') ? 'critical'
          : 'warning';
      const occurrence = Array.isArray(finding.occurrences) ? finding.occurrences[0] : null;
      const line = occurrence && Number.isInteger(occurrence.line) ? occurrence.line : null;
      const where = `${finding.displayPath || 'a file'}${line ? `:${line}` : ''}`;
      const file = String(finding.displayPath || '').split('/').filter(Boolean).pop() || '';
      const commit = /^[0-9a-f]{7,40}$/i.test(String(finding.introducedCommit || '')) ? String(finding.introducedCommit) : '';
      addNode(nodeMap, id, 'leak', file ? `${ruleLabel(finding.rule)} · ${file}` : ruleLabel(finding.rule), {
        where,
        foundIn: finding.inTree === false ? `History only${commit ? ` · ${commit.slice(0, 7)}` : ''}` : 'Current tree',
        encoding: finding.decodedFrom === 'base64' ? 'Base64-encoded' : '',
        status: (typeof EXPOSURE_DISPOSITION_WORDS === 'object' && EXPOSURE_DISPOSITION_WORDS[disposition]) || disposition,
        providerCheck: verification ? (verification.narration || verification.state || '') : '',
        description: (finding.narration && finding.narration.what) || 'A credential an Exposure scan found in this repository.'
      }, severity);
      addEdge(edges, id, repoId, 'exposed in repository', severity);
      if (commit) {
        const commitId = [...nodeMap.keys()].find(key => key.startsWith('commit:') && key.slice(7).startsWith(commit.toLowerCase()));
        if (commitId) addEdge(edges, commitId, id, 'introduced credential', severity);
      }
    });
    keep('integration', access.webhooks, 30).forEach(hook => {
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
    const repoProtected = keep('protected', protectedRepoKey ? protectedMap[protectedRepoKey] : [], 60);
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

    const allVulnerable = data.deps.vulnerable || [];
    const vulnerable = keep('package', allVulnerable, 40);
    const allAlerts = (data.deps.dependabot || {}).alerts || [];
    const advisoryCount = new Set(allVulnerable.flatMap(p => p.ids || [])).size + allAlerts.length;
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
    const depAlerts = allAlerts.slice(0, 12);
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
    /* A total is only worth printing where it is more than the graph holds. */
    const inGraph = {};
    for (const n of next) inGraph[n.type] = (inGraph[n.type] || 0) + 1;
    if (advisoryCount > (inGraph.vulnerability || 0)) totals.vulnerability = advisoryCount;
    for (const type of Object.keys(totals)) if (!(totals[type] > (inGraph[type] || 0))) delete totals[type];
    NVN.totals = totals;
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
      /* In scope is what the mode, the filters and the search admit; visible
       * is that less any group the reader has hidden from the sidebar. */
      n.inScope = allowed.has(n.type) && !!NVN.filters[n.severity || 'normal'] && (!q || n.match || n.type === 'repo');
      n.visible = n.inScope && (n.type === 'repo' || !NVN.hiddenGroups.has(n.type));
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
    NVN.fx = document.getElementById('neuralFx');
    NVN.fxCtx = NVN.fx ? NVN.fx.getContext('2d', { alpha: true }) : null;
    bindUI();
    bindCanvas();
    NVN.resizeObserver = new ResizeObserver(() => resize());
    const stage = document.getElementById('neuralStage');
    if (stage) NVN.resizeObserver.observe(stage);
    /* Scrolled out of view, the graph stops drawing until it comes back. */
    if (stage && typeof IntersectionObserver === 'function') {
      NVN.viewObserver = new IntersectionObserver(entries => {
        NVN.onScreen = entries.some(entry => entry.isIntersecting);
        if (NVN.onScreen) startLoop();
      });
      NVN.viewObserver.observe(stage);
    }
    /* Labels were measured in the fallback font until the web fonts arrived. */
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { FIT_CACHE.clear(); invalidate(); }).catch(() => {});
    loadHiddenGroups();
    bindMinimap();
    bindLight();
    resize();
  }
  /* The stage's light follows the pointer: one style write a frame at most,
   * on an element with no children, and none at all with motion off. */
  function bindLight() {
    const stage = document.getElementById('neuralStage');
    const light = document.getElementById('neuralLight');
    if (!stage || !light) return;
    let frame = 0, at = null;
    stage.addEventListener('pointermove', e => {
      if (!state.settings.motion) return;
      at = e;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const r = stage.getBoundingClientRect();
        light.style.setProperty('--nv-mx', `${Math.round(at.clientX - r.left)}px`);
        light.style.setProperty('--nv-my', `${Math.round(at.clientY - r.top)}px`);
      });
    }, { passive: true });
    stage.addEventListener('pointerleave', () => {
      light.style.removeProperty('--nv-mx');
      light.style.removeProperty('--nv-my');
    });
  }

  /*
   * On a desktop the Neural tab scrolls inside its own pane. A stage taller
   * than that pane could never be seen whole: the reader scrolled the pane to
   * see the bottom of a graph whose top had just left. The stage is sized to
   * the pane instead (within the design's 420 to 860 pixels), so scrolling to
   * it shows all of it. Where the page itself scrolls -- a phone -- the
   * stylesheet's own height stands.
   */
  function fitStageHeight() {
    const pane = document.getElementById('tab-neural');
    const workspace = document.querySelector('.neural-workspace');
    if (!pane || !workspace || !pane.clientHeight) return;
    const scrolls = /(auto|scroll)/.test(getComputedStyle(pane).overflowY);
    if (!scrolls || stageExpanded()) { workspace.style.removeProperty('--neural-stage-h'); return; }
    const height = Math.round(clamp(pane.clientHeight - 20, 420, 860));
    if (workspace.style.getPropertyValue('--neural-stage-h') !== `${height}px`) workspace.style.setProperty('--neural-stage-h', `${height}px`);
  }
  function resize() {
    if (!NVN.canvas) return;
    fitStageHeight();
    const rect = NVN.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    NVN.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const resized = Math.abs(rect.width - NVN.width) > 1 || Math.abs(rect.height - NVN.height) > 1;
    NVN.width = rect.width; NVN.height = rect.height;
    NVN.insets = null;
    const w = Math.round(rect.width * NVN.dpr), h = Math.round(rect.height * NVN.dpr);
    if (NVN.canvas.width !== w || NVN.canvas.height !== h) { NVN.canvas.width = w; NVN.canvas.height = h; NVN.staticKey = ''; }
    if (NVN.fx && (NVN.fx.width !== w || NVN.fx.height !== h)) { NVN.fx.width = w; NVN.fx.height = h; }
    if (NVN.fitPending) fitGraph(false);
    /* A rotation or a resize that changes the stage's shape re-lays the
     * graph for it -- including every time the shape crosses from wide to
     * tall, however small the change. */
    const nextMode = layoutAspect() > 1.05 ? 'stack' : 'split';
    if (NVN.nodes.length && NVN.layoutAspectUsed && (nextMode !== NVN.layoutMode || Math.abs(layoutAspect() - NVN.layoutAspectUsed) > .2)) {
      clearTimeout(NVN.reshapeTimer);
      NVN.reshapeTimer = setTimeout(() => { layoutGraph(); renderLegend(); fitGraph(true); }, 120);
    } else if (resized && NVN.nodes.length && !NVN.userCamera && !NVN.fitPending) {
      /* Any other change of size -- a window dragged wider, the browser's
       * bars coming and going, a split screen -- re-frames the graph for the
       * room it now has, unless the reader has moved it themselves. */
      clearTimeout(NVN.refitTimer);
      NVN.refitTimer = setTimeout(() => { if (!NVN.userCamera) fitGraph(true); }, 90);
    }
    /* Whether the stage is on screen is re-read here rather than left to the
     * observer alone: during a phone's rotation the observer can report the
     * stage gone and not report it back. */
    const onScreen = stageExpanded() || (rect.bottom > 0 && rect.top < (window.innerHeight || 0) && rect.right > 0 && rect.left < (window.innerWidth || 0));
    NVN.onScreen = onScreen;
    NVN.staticKey = '';
    invalidate();
    if (onScreen) startLoop();
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
  /* An opened group shows this many rows at a time and pages through the
   * rest, so no panel becomes a column taller than the stage. */
  const PAGE_ROWS = 10;
  const NODE_R = 16;
  const HUB_R = 58;
  /* On a tall stage the spine every row branches from: straight down from
   * the bottom of the hub, on its centre line. */
  const SPINE_X = 0;
  const LEFT_GROUPS = ['user', 'credential', 'leak', 'session', 'protected', 'safety', 'snapshot', 'scan', 'release', 'tag'];
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
      /* Critical first, then in the source's own order where it has one --
       * newest commit, default branch -- then by name. */
      const members = groups.get(type).slice().sort((a, b) =>
        (SEVERITY_RANK[a.severity] ?? 2) - (SEVERITY_RANK[b.severity] ?? 2)
        || (a.order ?? 1e9) - (b.order ?? 1e9)
        || a.label.localeCompare(b.label));
      let shown = members, footer = null, page = 0, pages = 1, slots = members.length;
      if (members.length > MAX_ROWS && !expanded.has(type)) {
        shown = members.slice(0, MAX_ROWS - 1); footer = 'more'; slots = shown.length;
      } else if (members.length > MAX_ROWS) {
        pages = Math.ceil(members.length / PAGE_ROWS);
        page = clamp(NVN.groupPages.get(type) || 0, 0, pages - 1);
        NVN.groupPages.set(type, page);
        shown = members.slice(page * PAGE_ROWS, (page + 1) * PAGE_ROWS);
        footer = 'pager';
        /* Every page is as tall as the first, so paging never moves the
         * panels below. */
        slots = pages > 1 ? PAGE_ROWS : shown.length;
      }
      const rows = slots + (footer ? 1 : 0);
      return {
        type, members, shown, rows, footer, page, pages, slots,
        hiddenCount: members.length - shown.length,
        total: Math.max(members.length, (NVN.totals || {})[type] || 0),
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
        if (Math.max(hl, hr) < Math.min(hl, hr) * 1.12 + 60) break;
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
    /* A panel the reader has moved keeps where they put it, in this browser,
     * for this repository, mode and shape of stage. Its rows face the hub from
     * whichever side of it the panel now stands. */
    const placed = savedPlacements();
    for (const panel of panels) {
      const at = placed[panel.type];
      if (at && Number.isFinite(at.x) && Number.isFinite(at.y)) { panel.x = at.x; panel.y = at.y; panel.placed = true; }
    }
    /* A moved panel's rows face whatever they are wired to: the hub on a wide
     * stage, the spine on a tall one. */
    for (const panel of panels) {
      if (!panel.placed) continue;
      const toward = NVN.layoutMode === 'stack' ? SPINE_X : 0;
      panel.side = panel.x + panel.w / 2 < toward ? 'left' : 'right';
    }
    NVN.panelByType = new Map(panels.map(panel => [panel.type, panel]));
    for (const panel of panels) {
      panel.nodeX = panel.side === 'left' ? panel.x + panel.w - 30 : panel.x + 30;
      panel.shown.forEach((n, i) => {
        n.tx = panel.nodeX; n.ty = panel.y + HEAD_H + i * ROW_H + ROW_H / 2; n.folded = false;
      });
      panel.moreY = panel.footer ? panel.y + HEAD_H + panel.slots * ROW_H + ROW_H / 2 : null;
      /* Everything not on the panel's current page waits behind its footer. */
      const onPage = new Set(panel.shown);
      for (const n of panel.members) {
        if (onPage.has(n)) continue;
        n.tx = panel.nodeX; n.ty = panel.moreY == null ? panel.y + HEAD_H : panel.moreY; n.folded = true;
      }
    }
    for (const n of visible) if (n.type === 'repo') { n.tx = 0; n.ty = 0; n.folded = false; }
    NVN.panels = panels;
    invalidate();
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
  function obsidian() { return document.documentElement.dataset.design === 'obsidian'; }
  function palette() {
    /* Two design presets. Nebula's panels are indigo glass with indigo ink;
     * Obsidian's are the stone's own surface -- warm charcoal ink on quartz,
     * cool ivory on obsidian. The theme key names both, so switching either
     * redraws the graph. */
    if (!obsidian()) {
      return isLight() ? {
        theme: 'nebula-light', surface: '#ffffff', grid: 'rgba(49,46,129,.07)', ring: 'rgba(79,70,229,.2)',
        panel: 'rgba(255,255,255,.9)', panelEdge: .38, text: '#1e1b4b', muted: '#5b5f7a', row: 'rgba(49,46,129,.05)',
        ink: color => (luminanceOf(color) > .78 ? '#475569' : darken(color, .28)), glow: false
      } : {
        theme: 'nebula-dark', surface: '#0e1026', grid: 'rgba(196,203,255,.07)', ring: 'rgba(129,140,248,.24)',
        panel: 'rgba(11,13,34,.78)', panelEdge: .34, text: '#eef0ff', muted: '#9aa0c3', row: 'rgba(255,255,255,.035)',
        ink: color => color, glow: true
      };
    }
    return isLight() ? {
      theme: 'obsidian-light', surface: '#fbfaf8', grid: 'rgba(41,37,36,.07)', ring: 'rgba(120,108,98,.22)',
      panel: 'rgba(255,255,255,.9)', panelEdge: .34, text: '#1c1917', muted: '#6b645d', row: 'rgba(41,37,36,.045)',
      ink: color => (luminanceOf(color) > .78 ? '#57534e' : darken(color, .3)), glow: false
    } : {
      theme: 'obsidian-dark', surface: '#0c0d10', grid: 'rgba(226,232,240,.055)', ring: 'rgba(203,213,225,.17)',
      panel: 'rgba(14,15,19,.84)', panelEdge: .3, text: '#eceef1', muted: '#9aa1ab', row: 'rgba(255,255,255,.04)',
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

  /*
   * The minimap: the whole topology in miniature, with the part on screen
   * outlined. It appears only when the graph is larger than the stage, and a
   * press or drag on it moves the stage there.
   */
  function drawMinimap(colors) {
    const mini = NVN.minimap;
    if (!mini) return;
    const W = NVN.width, H = NVN.height;
    const b = layoutBounds();
    const a = screenToWorld(0, 0), c = screenToWorld(W, H);
    const overflow = b.minX < a.x - 4 || b.maxX > c.x + 4 || b.minY < a.y - 4 || b.maxY > c.y + 4;
    /* A short stage -- a phone held sideways -- keeps the minimap for the full
     * view, where it is drawn smaller; on the page it would cover half the
     * graph it maps. */
    const room = H >= 440 || (H >= 300 && stageExpanded());
    const show = overflow && W >= 600 && room && (NVN.panels || []).length > 0 && !(NVN.selected && cardDocked());
    if (mini.hidden === show) mini.hidden = !show;
    if (!show) { NVN.miniKey = ''; return; }
    const key = `${NVN.frameKeyStatic}|${W}|${H}`;
    if (key === NVN.miniKey) return;
    NVN.miniKey = key;
    const cw = mini.clientWidth || 156, ch = mini.clientHeight || 108, dpr = NVN.dpr;
    if (mini.width !== Math.round(cw * dpr) || mini.height !== Math.round(ch * dpr)) { mini.width = Math.round(cw * dpr); mini.height = Math.round(ch * dpr); }
    const g = mini.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cw, ch);
    const pad = 10;
    const scale = Math.min((cw - pad * 2) / (b.maxX - b.minX), (ch - pad * 2) / (b.maxY - b.minY));
    const ox = (cw - (b.maxX - b.minX) * scale) / 2 - b.minX * scale;
    const oy = (ch - (b.maxY - b.minY) * scale) / 2 - b.minY * scale;
    NVN.miniMap = { scale, ox, oy };
    for (const panel of NVN.panels) {
      const st = TYPE_STYLE[panel.type] || TYPE_STYLE.repo;
      const lit = NVN.focusGroup === panel.type || (NVN.selected && NVN.selected.type === panel.type);
      roundRect(g, ox + panel.x * scale, oy + panel.y * scale, panel.w * scale, panel.h * scale, 3);
      g.fillStyle = hexAlpha(colors.ink(st.color), lit ? .6 : .3); g.fill();
      g.lineWidth = 1; g.strokeStyle = hexAlpha(colors.ink(st.color), lit ? .95 : .6); g.stroke();
    }
    g.beginPath(); g.arc(ox, oy, Math.max(3, HUB_R * scale), 0, Math.PI * 2);
    g.fillStyle = '#818cf8'; g.fill();
    const vx = ox + a.x * scale, vy = oy + a.y * scale, vw = (c.x - a.x) * scale, vh = (c.y - a.y) * scale;
    g.fillStyle = colors.glow ? 'rgba(255,255,255,.07)' : 'rgba(49,46,129,.07)';
    g.fillRect(vx, vy, vw, vh);
    g.lineWidth = 1.5; g.strokeStyle = colors.glow ? 'rgba(255,255,255,.9)' : 'rgba(49,46,129,.8)';
    g.strokeRect(vx, vy, vw, vh);
  }
  function bindMinimap() {
    const mini = document.getElementById('neuralMinimap');
    if (!mini) return;
    NVN.minimap = mini;
    let dragging = false;
    const moveTo = e => {
      const map = NVN.miniMap;
      if (!map) return;
      const r = mini.getBoundingClientRect();
      const wx = (e.clientX - r.left - map.ox) / map.scale, wy = (e.clientY - r.top - map.oy) / map.scale;
      NVN.camTarget = null; NVN.userCamera = true;
      NVN.panX = -wx * NVN.zoom; NVN.panY = -wy * NVN.zoom;
    };
    mini.addEventListener('pointerdown', e => { dragging = true; mini.setPointerCapture(e.pointerId); moveTo(e); e.preventDefault(); });
    mini.addEventListener('pointermove', e => { if (dragging) moveTo(e); });
    const end = e => { dragging = false; try { mini.releasePointerCapture(e.pointerId); } catch {} };
    mini.addEventListener('pointerup', end); mini.addEventListener('pointercancel', end);
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
       idling at 60fps for the rest of the session (battery + iOS renderer pressure).
       Scrolled out of view counts as not visible. */
    if (!NVN.active || !NVN.ctx || !NVN.canvas || !NVN.onScreen || document.visibilityState !== 'visible') { NVN.raf = 0; return; }
    NVN.raf = requestAnimationFrame(animate);
    const dt = Math.min(40, now - NVN.lastFrame); NVN.lastFrame = now;
    draw(now, dt);
  }
  /* Something the static layer draws has changed: redraw it on the next frame. */
  function invalidate() { NVN.version++; }
  function startLoop() {
    if (NVN.raf || !NVN.active || !NVN.onScreen || document.visibilityState !== 'visible') return;
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
    let moving = false;
    for (const n of NVN.nodes) {
      if (!n.visible) continue;
      if (n.tx == null) { n.tx = n.x; n.ty = n.y; }
      const dx = n.tx - n.x, dy = n.ty - n.y;
      if (Math.abs(dx) > .25 || Math.abs(dy) > .25) { n.x += dx * k; n.y += dy * k; moving = true; }
      else if (dx || dy) { n.x = n.tx; n.y = n.ty; moving = true; }
      if ((n.appear ?? 1) < 1) { n.appear = Math.min(1, n.appear + (motion ? dt / 280 : 1)); moving = true; }
    }
    const cam = NVN.camTarget;
    if (cam) moving = true;
    if (cam) {
      const c = motion ? 1 - Math.exp(-dt / 110) : 1;
      NVN.zoom += (cam.zoom - NVN.zoom) * c;
      NVN.panX += (cam.panX - NVN.panX) * c;
      NVN.panY += (cam.panY - NVN.panY) * c;
      if (Math.abs(cam.zoom - NVN.zoom) < .001 && Math.abs(cam.panX - NVN.panX) < .5 && Math.abs(cam.panY - NVN.panY) < .5) {
        NVN.zoom = cam.zoom; NVN.panX = cam.panX; NVN.panY = cam.panY; NVN.camTarget = null;
      }
    }
    return moving;
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

  /*
   * Drawing is two canvases.
   *
   * The graph canvas holds everything that only changes when the reader does
   * something -- the panels, the strands, the nodes, the hub. It is redrawn
   * while something moves and once when it settles, and then left alone. The
   * effects canvas above it (it takes no pointer events) holds what really
   * animates: the signals on the strands, the breathing ring of a critical
   * node, the hub's turning arcs, the relationship dashes and the card's
   * leader line. A resting graph therefore redraws only a few dozen small
   * sprites, at half rate; paused, hidden, or scrolled out of view it draws
   * nothing. The ground itself (the navy, the clouds, the vignette) is CSS,
   * painted once by the browser rather than on every frame.
   */
  function staticKey(colors) {
    return [NVN.width, NVN.height, NVN.dpr, NVN.zoom.toFixed(4), NVN.panX.toFixed(2), NVN.panY.toFixed(2),
      colors.theme, NVN.version, NVN.hover ? NVN.hover.id : '', NVN.selected ? NVN.selected.id : '',
      NVN.focusGroup || '', NVN.highlightNodes.size, state.settings.motion ? 1 : 0].join('|');
  }
  function draw(now, dt = 16) {
    const ctx = NVN.ctx;
    /* Before the stage has a size there is nothing to draw into. */
    if (!NVN.width || !NVN.height) return;
    const moving = integrate(dt);
    const colors = palette();
    const key = staticKey(colors);
    const animated = state.settings.motion && !NVN.paused;
    const dirty = !NVN.fxCtx || moving || NVN.panning || !!NVN.draggingPanel || key !== NVN.staticKey;
    NVN.interacting = moving || NVN.panning || !!NVN.draggingPanel;
    /* Nothing moved and nothing animates: the last frame is still right. */
    if (!dirty && !animated && NVN.frameKey === key) return;
    /* At rest, the signals run at half rate. */
    if (!dirty && animated && now - NVN.lastDraw < 31) return;
    NVN.lastDraw = now;
    const focus = focusSets();
    const hub = NVN.nodes.find(n => n.type === 'repo' && n.visible);
    const view = worldView();
    if (dirty) {
      screenSpace(ctx);
      ctx.clearRect(0, 0, NVN.width, NVN.height);
      drawStatic(ctx, colors, focus, hub, view);
      NVN.staticKey = NVN.interacting ? '' : key;
      NVN.frames = (NVN.frames || 0) + 1;
    }
    /* While the graph moves it is redrawn every frame anyway, so the effects
     * go onto the same canvas and the effects canvas steps out: one layer to
     * composite instead of two. */
    const together = !NVN.fxCtx || NVN.interacting;
    const fx = together ? ctx : NVN.fxCtx;
    if (NVN.fx) {
      const hide = together && !!NVN.fxCtx;
      if (hide !== !!NVN.fxHidden) { NVN.fx.style.visibility = hide ? 'hidden' : ''; NVN.fxHidden = hide; }
    }
    if (fx !== ctx) { screenSpace(fx); fx.clearRect(0, 0, NVN.width, NVN.height); }
    worldSpace(fx);
    drawAnimated(fx, now, colors, focus, hub, view, animated);
    screenSpace(fx);
    drawLeader(fx, colors);
    positionCard();
    NVN.frameKeyStatic = moving || NVN.panning ? `${now}` : key;
    drawMinimap(colors);
    NVN.frameKey = key;
  }
  /* The part of the world on screen, with a margin, for skipping what is not. */
  function worldView() {
    const a = screenToWorld(-40, -40), b = screenToWorld(NVN.width + 40, NVN.height + 40);
    return { minX: a.x, minY: a.y, maxX: b.x, maxY: b.y };
  }
  function inView(view, minX, minY, maxX, maxY) {
    return maxX >= view.minX && minX <= view.maxX && maxY >= view.minY && minY <= view.maxY;
  }
  function curveInView(view, c) {
    return inView(view,
      Math.min(c.start.x, c.c1.x, c.c2.x, c.end.x) - 14, Math.min(c.start.y, c.c1.y, c.c2.y, c.end.y) - 14,
      Math.max(c.start.x, c.c1.x, c.c2.x, c.end.x) + 14, Math.max(c.start.y, c.c1.y, c.c2.y, c.end.y) + 14);
  }
  function drawStatic(ctx, colors, focus, hub, view) {
    screenSpace(ctx);
    drawBackdrop(ctx, colors);
    worldSpace(ctx);
    drawRings(ctx, colors, hub);
    drawPanels(ctx, colors, focus, view);
    if (hub) drawFibers(ctx, colors, focus, hub, view);
    for (const n of NVN.nodes) {
      if (!n.visible || n.folded || n.type === 'repo') continue;
      if (!inView(view, n.x - 30, n.y - 30, n.x + 30, n.y + 30)) continue;
      drawNode(ctx, n, !!focus && !focus.nodes.has(n.id), colors);
    }
    if (hub) drawHub(ctx, hub, colors, !!focus && !focus.nodes.has(hub.id));
  }
  function drawAnimated(ctx, now, colors, focus, hub, view, animated) {
    drawRelations(ctx, now, colors, focus, animated);
    if (!animated) return;
    if (hub) drawSignals(ctx, now, colors, focus, hub, view);
    for (const n of NVN.nodes) {
      if (!n.visible || n.folded || n.severity !== 'critical' || n.type === 'repo') continue;
      if (focus && !focus.nodes.has(n.id)) continue;
      if (!inView(view, n.x - 40, n.y - 40, n.x + 40, n.y + 40)) continue;
      /* A critical node breathes: one ring, expanding and fading, in red. */
      const phase = ((now * .0011) + (hashCode(n.id) % 100) / 100) % 1;
      ctx.strokeStyle = hexAlpha('#F43F6E', .55 * (1 - phase) * (n.appear ?? 1));
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(n.x, n.y, NODE_R * (1.2 + phase * .9), 0, Math.PI * 2); ctx.stroke();
    }
    if (hub) {
      const turn = now * .0006, r = HUB_R;
      ctx.save();
      ctx.globalAlpha = focus && !focus.nodes.has(hub.id) ? .55 : 1;
      ctx.lineWidth = 2; ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(167,139,250,.6)';
      ctx.beginPath(); ctx.arc(hub.x, hub.y, r * 1.18, turn, turn + 1.2); ctx.stroke();
      ctx.beginPath(); ctx.arc(hub.x, hub.y, r * 1.18, turn + Math.PI, turn + Math.PI + .8); ctx.stroke();
      const slow = now * .00012;
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = hexAlpha('#a78bfa', isLight() ? .3 : .4);
      ctx.beginPath(); ctx.arc(hub.x, hub.y, r * 1.7, slow, slow + 1.1); ctx.stroke();
      ctx.beginPath(); ctx.arc(hub.x, hub.y, r * 1.7, slow + Math.PI, slow + Math.PI + .6); ctx.stroke();
      ctx.restore();
    }
  }

  /* A dot grid fixed to the graph rather than the screen, so panning and
   * zooming read as moving over a surface. It thins out as it shrinks. The
   * ground under it is the stage's CSS background. */
  function drawBackdrop(ctx, colors) {
    const W = NVN.width, H = NVN.height;
    const spacing = 28 * NVN.zoom;
    if (spacing < 9) return;
    const origin = worldToScreen(0, 0);
    const startX = ((origin.x % spacing) + spacing) % spacing;
    const startY = ((origin.y % spacing) + spacing) % spacing;
    const dot = clamp(1.1 * NVN.zoom, .7, 1.6);
    ctx.fillStyle = colors.grid;
    for (let x = startX; x < W; x += spacing) {
      for (let y = startY; y < H; y += spacing) ctx.fillRect(x - dot / 2, y - dot / 2, dot, dot);
    }
  }

  /* Concentric dotted rings around the hub: the centre of the picture
   * announces itself. Two arcs turn on the inner ring in the animated layer. */
  function drawRings(ctx, colors, hub) {
    if (!hub) return;
    ctx.save();
    ctx.strokeStyle = colors.ring;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 7]);
    for (const r of [HUB_R * 1.7, HUB_R * 2.6, HUB_R * 3.7]) {
      ctx.beginPath(); ctx.arc(hub.x, hub.y, r, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();
  }

  function roundRect(ctx, x, y, w, h, r) {
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); return; }
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function hexAlpha(hex, alpha) {
    /* Ink can arrive as rgb() -- the light palettes darken a group's colour --
     * and returning it unchanged painted a pager button solid in its own
     * chevron's colour, so the chevron vanished into a filled disc. */
    const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(String(hex));
    if (rgb) return `rgba(${rgb[1]},${rgb[2]},${rgb[3]},${alpha})`;
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
  function drawPanels(ctx, colors, focus, view) {
    const selectedType = NVN.selected && NVN.selected.type;
    for (const panel of NVN.panels || []) {
      if (!inView(view, panel.x - 24, panel.y - 24, panel.x + panel.w + 24, panel.y + panel.h + 24)) continue;
      const st = TYPE_STYLE[panel.type] || TYPE_STYLE.repo;
      const ink = colors.ink(st.color);
      const lit = NVN.focusGroup === panel.type || selectedType === panel.type;
      const dim = !!focus && !lit && !panel.members.some(n => focus.nodes.has(n.id));
      ctx.save();
      ctx.globalAlpha = dim ? .4 : 1;
      roundRect(ctx, panel.x, panel.y, panel.w, panel.h, 18);
      ctx.fillStyle = colors.panel; ctx.fill();
      const wash = ctx.createLinearGradient(panel.x, panel.y, panel.x + panel.w * .7, panel.y + panel.h);
      wash.addColorStop(0, hexAlpha(st.color, isLight() ? .11 : .15));
      wash.addColorStop(1, hexAlpha(st.color, 0));
      ctx.fillStyle = wash; ctx.fill();
      if (lit && colors.glow) { ctx.shadowColor = hexAlpha(st.color, .55); ctx.shadowBlur = 22; }
      ctx.lineWidth = lit ? 1.6 : 1;
      ctx.strokeStyle = hexAlpha(st.color, lit ? .8 : colors.panelEdge);
      ctx.stroke();
      ctx.shadowBlur = 0;
      /* Where the light catches the glass: a bright hairline along the top
       * edge, fading out toward the corners. */
      const edge = ctx.createLinearGradient(panel.x, 0, panel.x + panel.w, 0);
      const shine = colors.glow ? .2 : .95;
      edge.addColorStop(0, `rgba(255,255,255,0)`);
      edge.addColorStop(.5, `rgba(255,255,255,${shine})`);
      edge.addColorStop(1, `rgba(255,255,255,0)`);
      ctx.beginPath(); ctx.moveTo(panel.x + 18, panel.y + 1); ctx.lineTo(panel.x + panel.w - 18, panel.y + 1);
      ctx.lineWidth = 1; ctx.strokeStyle = edge; ctx.stroke();
      /* Header: the group's mark and name, and its count in a pill -- "60 of
       * 312" (60/312) where the repository has more than the graph holds. */
      const hx = panel.x + 30, hy = panel.y + HEAD_H / 2 + 2;
      ctx.beginPath(); ctx.arc(hx, hy, 17, 0, Math.PI * 2);
      ctx.fillStyle = hexAlpha(st.color, isLight() ? .12 : .18); ctx.fill();
      ctx.lineWidth = 1.2; ctx.strokeStyle = hexAlpha(st.color, .7); ctx.stroke();
      if (!drawIcon(ctx, panel.type, hx, hy, 18, ink) && st.glyph) {
        ctx.fillStyle = ink; ctx.font = "700 13px 'Public Sans Variable', system-ui, sans-serif";
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(st.glyph, hx, hy);
      }
      ctx.textBaseline = 'middle';
      ctx.font = "600 11px 'JetBrains Mono Variable', ui-monospace, monospace";
      const count = panel.total > panel.members.length ? `${panel.members.length}/${panel.total}` : String(panel.members.length);
      const pillW = ctx.measureText(count).width + 16;
      const pillX = panel.x + panel.w - 16 - pillW;
      roundRect(ctx, pillX, hy - 11, pillW, 22, 11);
      ctx.fillStyle = hexAlpha(st.color, isLight() ? .12 : .16); ctx.fill();
      ctx.fillStyle = isLight() ? ink : colors.text;
      ctx.textAlign = 'center';
      ctx.fillText(count, pillX + pillW / 2, hy + .5);
      ctx.font = "700 12px 'JetBrains Mono Variable', ui-monospace, monospace";
      if ('letterSpacing' in ctx) ctx.letterSpacing = '1.6px';
      ctx.textAlign = 'left';
      ctx.fillStyle = ink;
      ctx.fillText(fitText(ctx, (st.plural || st.label).toUpperCase(), pillX - panel.x - 66), panel.x + 58, hy);
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
      /* Rows. */
      const labelWidth = panel.w - 78;
      ctx.font = ROW_FONT;
      panel.shown.forEach((n, i) => {
        const rowY = panel.y + HEAD_H + i * ROW_H;
        if (!inView(view, panel.x, rowY, panel.x + panel.w, rowY + ROW_H)) return;
        const selected = NVN.selected && NVN.selected.id === n.id;
        const hover = NVN.hover && NVN.hover.id === n.id;
        if (selected || hover) {
          roundRect(ctx, panel.x + 8, rowY + 3, panel.w - 16, ROW_H - 6, 12);
          ctx.fillStyle = selected ? hexAlpha(st.color, isLight() ? .14 : .2) : colors.row; ctx.fill();
        }
        const rowDim = !!focus && !focus.nodes.has(n.id) && !dim;
        ctx.globalAlpha = (dim ? .4 : 1) * (rowDim ? .45 : 1) * Math.min(1, (n.appear ?? 1) * 1.4);
        ctx.fillStyle = colors.text;
        const font = selected ? ROW_FONT_BOLD : ROW_FONT;
        if (ctx.font !== font) ctx.font = font;
        const text = fitText(ctx, n.label, labelWidth);
        if (panel.side === 'left') { ctx.textAlign = 'right'; ctx.fillText(text, panel.x + panel.w - 58, rowY + ROW_H / 2); }
        else { ctx.textAlign = 'left'; ctx.fillText(text, panel.x + 58, rowY + ROW_H / 2); }
        ctx.globalAlpha = dim ? .4 : 1;
      });
      if (panel.moreY != null) drawPanelFooter(ctx, panel, colors, ink);
      ctx.restore();
    }
  }
  const ROW_FONT = "500 13px 'Public Sans Variable', system-ui, sans-serif";
  const ROW_FONT_BOLD = "700 13px 'Public Sans Variable', system-ui, sans-serif";
  /* Where the footer's controls sit, in world units from the panel's left. */
  const FOOTER = { lessEnd: 118, prevX: -140, nextX: -26, rangeX: -83, hit: 15 };
  function drawPanelFooter(ctx, panel, colors, ink) {
    const y = panel.moreY;
    ctx.beginPath();
    ctx.moveTo(panel.x + 16, y - ROW_H / 2); ctx.lineTo(panel.x + panel.w - 16, y - ROW_H / 2);
    ctx.lineWidth = 1; ctx.strokeStyle = hexAlpha(panel.members[0] ? panel.members[0].color : '#818cf8', .18); ctx.stroke();
    ctx.textBaseline = 'middle';
    ctx.font = "600 12px 'Public Sans Variable', system-ui, sans-serif";
    ctx.fillStyle = ink;
    if (panel.footer === 'more') {
      ctx.textAlign = 'left';
      ctx.fillText(`+ ${panel.hiddenCount} more`, panel.x + 20, y);
      chevron(ctx, panel.x + panel.w - 26, y, 'down', ink, 1);
      return;
    }
    ctx.textAlign = 'left';
    ctx.fillText('Show fewer', panel.x + 20, y);
    if (panel.pages <= 1) return;
    const first = panel.page * PAGE_ROWS + 1;
    const last = Math.min(panel.members.length, first + PAGE_ROWS - 1);
    ctx.font = "600 11px 'JetBrains Mono Variable', ui-monospace, monospace";
    ctx.fillStyle = colors.muted;
    ctx.textAlign = 'center';
    ctx.fillText(`${first}–${last} of ${panel.members.length}`, panel.x + panel.w + FOOTER.rangeX, y + .5);
    chevron(ctx, panel.x + panel.w + FOOTER.prevX, y, 'left', ink, panel.page > 0 ? 1 : .3);
    chevron(ctx, panel.x + panel.w + FOOTER.nextX, y, 'right', ink, panel.page < panel.pages - 1 ? 1 : .3);
  }
  function chevron(ctx, x, y, direction, color, alpha) {
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.beginPath(); ctx.arc(x, y, 12, 0, Math.PI * 2);
    ctx.fillStyle = hexAlpha(color, .12); ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = hexAlpha(color, .45); ctx.stroke();
    ctx.beginPath();
    const d = 3.6;
    if (direction === 'down') { ctx.moveTo(x - d, y - d / 2); ctx.lineTo(x, y + d / 2); ctx.lineTo(x + d, y - d / 2); }
    else if (direction === 'left') { ctx.moveTo(x + d / 2, y - d); ctx.lineTo(x - d / 2, y); ctx.lineTo(x + d / 2, y + d); }
    else { ctx.moveTo(x - d / 2, y - d); ctx.lineTo(x + d / 2, y); ctx.lineTo(x - d / 2, y + d); }
    ctx.lineWidth = 1.8; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = color; ctx.stroke();
    ctx.restore();
  }

  /*
   * One strand from the hub to a node.
   *
   * On a wide stage it is a cubic that leaves the hub's rim level and arrives
   * level, so a column of strands fans out like fibres rather than crossing.
   * On a tall stage every group has a single trunk down from the rim, and each
   * row takes a short branch off its group's trunk: as many wires as there are
   * groups run the length of the stage, not one per row.
   *
   * The strand is returned as the segments a signal travels along -- the
   * trunk's run and the branch -- and as the branch drawn for this row.
   */
  function fiberGeometry(hub, n) {
    if (NVN.layoutMode === 'stack') {
      const tx = hub.x + SPINE_X;
      const reach = Math.sqrt(Math.max(0, HUB_R * HUB_R - (tx - hub.x) ** 2));
      const below = n.y >= hub.y;
      const rim = { x: tx, y: hub.y + (below ? reach : -reach) * .98 };
      const sign = n.x >= tx ? 1 : -1;
      const end = { x: n.x - sign * NODE_R, y: n.y };
      const bendY = below ? Math.max(rim.y + 8, n.y - 26) : Math.min(rim.y - 8, n.y + 26);
      const branch = {
        start: { x: tx, y: bendY }, c1: { x: tx, y: n.y + (below ? -4 : 4) },
        c2: { x: tx + (end.x - tx) * .45, y: n.y }, end
      };
      return { branch, rim, bendY, segs: [{ line: [rim, branch.start] }, { cubic: branch }], tail: [{ cubic: branch }] };
    }
    const panel = NVN.panelByType && NVN.panelByType.get(n.type);
    if (panel && panel.placed) {
      /* A panel the reader moved can be anywhere, even under the hub: the
       * strand leaves the rim toward it and arrives from outside the panel,
       * on the side its rows face, so it never crosses a label. */
      const approach = panel.side === 'left' ? 1 : -1;
      const end = { x: n.x + approach * NODE_R, y: n.y };
      const toward = Math.atan2(end.y - hub.y, end.x - hub.x);
      const start = { x: hub.x + Math.cos(toward) * HUB_R * .96, y: hub.y + Math.sin(toward) * HUB_R * .96 };
      const d = Math.hypot(end.x - start.x, end.y - start.y);
      const branch = {
        start, c1: { x: start.x + Math.cos(toward) * d * .35, y: start.y + Math.sin(toward) * d * .35 },
        c2: { x: end.x + approach * Math.max(50, d * .35), y: end.y }, end
      };
      return { branch, segs: [{ cubic: branch }] };
    }
    const sign = n.x >= hub.x ? 1 : -1;
    const angle = clamp(Math.atan2(n.y - hub.y, Math.abs(n.x - hub.x)) * .55, -1.05, 1.05);
    const start = { x: hub.x + sign * HUB_R * .96 * Math.cos(angle), y: hub.y + HUB_R * .96 * Math.sin(angle) };
    const end = { x: n.x - sign * NODE_R, y: n.y };
    const dx = Math.abs(end.x - start.x);
    const branch = { start, c1: { x: start.x + sign * dx * .5, y: start.y }, c2: { x: end.x - sign * dx * .5, y: end.y }, end };
    return { branch, segs: [{ cubic: branch }] };
  }
  /* The length of each segment, measured once, so a signal moves at an even
   * pace along a trunk and its branch. */
  function measurePath(segs) {
    let total = 0;
    for (const seg of segs) {
      if (seg.line) seg.len = Math.hypot(seg.line[1].x - seg.line[0].x, seg.line[1].y - seg.line[0].y);
      else {
        const c = seg.cubic;
        const chord = Math.hypot(c.end.x - c.start.x, c.end.y - c.start.y);
        const poly = Math.hypot(c.c1.x - c.start.x, c.c1.y - c.start.y) + Math.hypot(c.c2.x - c.c1.x, c.c2.y - c.c1.y) + Math.hypot(c.end.x - c.c2.x, c.end.y - c.c2.y);
        seg.len = (chord + poly) / 2;
      }
      total += seg.len;
    }
    return { segs, total: Math.max(1, total) };
  }
  function pathPoint(path, t) {
    let d = clamp(t, 0, 1) * path.total;
    for (const seg of path.segs) {
      if (d <= seg.len || seg === path.segs[path.segs.length - 1]) {
        const f = seg.len ? clamp(d / seg.len, 0, 1) : 0;
        if (seg.line) return { x: seg.line[0].x + (seg.line[1].x - seg.line[0].x) * f, y: seg.line[0].y + (seg.line[1].y - seg.line[0].y) * f };
        return cubicPoint(seg.cubic, f);
      }
      d -= seg.len;
    }
    return path.segs.length ? cubicPoint(path.segs[path.segs.length - 1].cubic, 1) : { x: 0, y: 0 };
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
   * wears its group's colour, or red for a critical node. A selection lights
   * its own strands and dims the rest. The signals that run along them are
   * the animated layer's (drawSignals).
   */
  function fiberStyle(n, focus, hub, colors) {
    const lit = !!focus && focus.nodes.has(n.id) && (focus.nodes.has(hub.id) || NVN.focusGroup === n.type);
    const dim = !!focus && !lit;
    /* The strand wears its group's colour, so a column of strands reads as
     * that group from across the stage; only a critical node turns it red.
     * A warning stays on the node's badge. */
    const color = n.severity === 'critical' ? '#F43F6E' : n.color;
    const base = (n.appear ?? 1) * (dim ? .2 : 1);
    return { lit, dim, color, stroke: colors.ink(color), base };
  }
  function drawFibers(ctx, colors, focus, hub, view) {
    ctx.save();
    if (colors.glow) ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    /* The strands' fine offset threads are invisible past a certain distance
     * and while the graph is moving; they are drawn only when they can be
     * seen, which is most of the cost of a frame spent dragging. */
    const fine = NVN.zoom > .45 && !NVN.interacting;
    const stack = NVN.layoutMode === 'stack';
    /* On a tall stage: one spine each way from the rim, as far as its furthest
     * branch; a band in each group's colour where its rows branch off; and
     * the stretch to a lit node drawn lit. */
    const spine = { reaches: new Map(), bands: new Map() };
    for (const n of NVN.nodes) {
      if (!n.visible || n.folded || n.type === 'repo') continue;
      const geo = fiberGeometry(hub, n);
      n.curve = geo.branch;
      n.path = measurePath(geo.segs);
      n.tail = geo.tail ? measurePath(geo.tail) : null;
      n.onView = geo.segs.some(seg => seg.line
        ? inView(view, Math.min(seg.line[0].x, seg.line[1].x) - 14, Math.min(seg.line[0].y, seg.line[1].y), Math.max(seg.line[0].x, seg.line[1].x) + 14, Math.max(seg.line[0].y, seg.line[1].y))
        : curveInView(view, seg.cubic));
      const style = fiberStyle(n, focus, hub, colors);
      if (stack) {
        const way = geo.bendY < geo.rim.y ? -1 : 1;
        const reach = spine.reaches.get(way) || { x: geo.rim.x, from: geo.rim.y, to: geo.rim.y, lit: null, base: 0 };
        if (Math.abs(geo.bendY - reach.from) > Math.abs(reach.to - reach.from)) reach.to = geo.bendY;
        if (style.lit && (!reach.lit || Math.abs(geo.bendY - reach.from) > Math.abs(reach.lit.to - reach.from))) reach.lit = { to: geo.bendY, color: style.color };
        reach.base = Math.max(reach.base, n.appear ?? 1);
        spine.reaches.set(way, reach);
        const key = `${n.type}:${way}`;
        const band = spine.bands.get(key) || { x: geo.rim.x, from: geo.bendY, to: geo.bendY, color: n.color, dim: true, base: 0 };
        band.from = Math.min(band.from, geo.bendY); band.to = Math.max(band.to, geo.bendY);
        band.dim = band.dim && style.dim;
        band.base = Math.max(band.base, n.appear ?? 1);
        spine.bands.set(key, band);
      }
      if (!curveInView(view, geo.branch)) continue;
      const { lit, color, stroke, base } = style;
      if (colors.glow) {
        ctx.globalAlpha = base * (lit ? .24 : .1);
        ctx.strokeStyle = color; ctx.lineWidth = lit ? 8 : 5.5;
        strokeCubic(ctx, geo.branch);
      }
      ctx.globalAlpha = base * (lit ? 1 : colors.glow ? .62 : .5);
      ctx.strokeStyle = stroke; ctx.lineWidth = lit ? 2 : 1.3;
      strokeCubic(ctx, geo.branch);
      if (!fine || stack) continue;
      const seed = (hashCode(n.id) % 1000) / 1000;
      ctx.globalAlpha = base * (lit ? .6 : .3);
      ctx.lineWidth = .8;
      strokeCubic(ctx, geo.branch, (seed - .5) * 26);
      ctx.globalAlpha = base * (lit ? .45 : .2);
      strokeCubic(ctx, geo.branch, (.5 - seed) * 18 + 6);
    }
    const run = (x, from, to, color, alpha, width, glow) => {
      if (!inView(view, x - 14, Math.min(from, to), x + 14, Math.max(from, to))) return;
      ctx.beginPath(); ctx.moveTo(x, from); ctx.lineTo(x, to);
      if (colors.glow && glow) {
        ctx.globalAlpha = alpha * glow;
        ctx.strokeStyle = color; ctx.lineWidth = width * 3.6;
        ctx.stroke();
      }
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = colors.ink(color); ctx.lineWidth = width;
      ctx.stroke();
    };
    const spineColor = colors.glow ? '#818CF8' : '#6366F1';
    for (const reach of spine.reaches.values()) {
      run(reach.x, reach.from, reach.to, spineColor, reach.base * (focus ? .45 : colors.glow ? .78 : .6), 2.4, .16);
    }
    for (const band of spine.bands.values()) {
      /* A group's band covers the stretch its rows branch from, and a little
       * either side so a single row's is still seen. */
      run(band.x, band.from - 9, band.to + 9, band.color, band.base * (band.dim && focus ? .2 : colors.glow ? .9 : .75), 3, .22);
    }
    for (const reach of spine.reaches.values()) {
      if (reach.lit) run(reach.x, reach.from, reach.lit.to, reach.lit.color, reach.base, 2.6, .3);
    }
    ctx.restore();
  }
  /* A glowing dot, drawn once per colour and size and stamped from then on:
   * a radial gradient per signal per frame was most of the frame's cost. */
  const SPRITES = new Map();
  function signalSprite(color) {
    if (SPRITES.has(color)) return SPRITES.get(color);
    const size = 64;
    const sprite = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(size, size) : document.createElement('canvas');
    sprite.width = size; sprite.height = size;
    const g = sprite.getContext('2d');
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, '#ffffff'); grad.addColorStop(.35, color); grad.addColorStop(1, hexAlpha(color, 0));
    g.fillStyle = grad; g.fillRect(0, 0, size, size);
    SPRITES.set(color, sprite);
    return sprite;
  }
  function drawSignals(ctx, now, colors, focus, hub, view) {
    ctx.save();
    if (colors.glow) ctx.globalCompositeOperation = 'lighter';
    for (const n of NVN.nodes) {
      if (!n.visible || n.folded || n.type === 'repo' || !n.path || n.onView === false) continue;
      const { lit, dim, color, base } = fiberStyle(n, focus, hub, colors);
      if (dim) continue;
      const seed = (hashCode(n.id) % 1000) / 1000;
      /* On the spine, only what matters travels all the way to the hub -- a
       * critical node's signal, or the lit node's; the rest pulse along their
       * own branch at the same pace, so the spine stays readable however
       * many rows hang from it. */
      const full = !n.tail || lit || n.severity === 'critical';
      const path = full ? n.path : n.tail;
      const speed = (n.severity === 'critical' ? .00042 : .00017) * Math.min(4, n.path.total / path.total);
      const r = lit ? 7 : 5;
      const sprite = signalSprite(color);
      for (const phase of lit ? [0, .5] : [0]) {
        const t = 1 - ((seed + phase + now * speed) % 1);
        /* Signals fade in and out at the ends rather than popping over the
         * hub and the node they run between. */
        const edge = Math.min(1, t / .08, (1 - t) / .08);
        const p = pathPoint(path, t);
        ctx.globalAlpha = base * (lit ? 1 : .85) * edge;
        ctx.drawImage(sprite, p.x - r, p.y - r, r * 2, r * 2);
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
  function drawRelations(ctx, now, colors, focus, animated) {
    if (!focus) return;
    const byId = new Map(NVN.nodes.map(n => [n.id, n]));
    ctx.save();
    ctx.lineCap = 'round';
    for (const e of NVN.edges) {
      if (!e.visible || !focus.edges.has(e.id)) continue;
      const a = byId.get(e.source), b = byId.get(e.target);
      if (!a || !b || a.type === 'repo' || b.type === 'repo' || a.folded || b.folded) continue;
      const bend = Math.max(60, Math.abs(b.x - a.x) * .45);
      /* Each end leaves its disc on the side facing the hub -- the side the
       * strands arrive on -- so the dashes never cross an icon. */
      const sa = NVN.layoutMode === 'stack' || a.x >= 0 ? 1 : -1, sb = NVN.layoutMode === 'stack' || b.x >= 0 ? 1 : -1;
      const curve = {
        start: { x: a.x - sa * (NODE_R + 2), y: a.y }, end: { x: b.x - sb * (NODE_R + 2), y: b.y },
        c1: { x: a.x - sa * bend, y: a.y }, c2: { x: b.x - sb * bend, y: b.y }
      };
      const color = e.severity === 'critical' ? '#F43F6E' : e.severity === 'warning' ? '#F59E0B' : '#a78bfa';
      ctx.globalAlpha = .9;
      ctx.strokeStyle = colors.ink(color); ctx.lineWidth = 1.6;
      if (animated) { ctx.setLineDash([6, 7]); ctx.lineDashOffset = -now * .03; }
      strokeCubic(ctx, curve);
      ctx.setLineDash([]);
    }
    ctx.restore();
  }

  function drawNode(ctx, node, dim, colors) {
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
  function drawHub(ctx, node, colors, dim) {
    const x = node.x, y = node.y, r = HUB_R;
    const active = (NVN.selected && NVN.selected.id === node.id) || (NVN.hover && NVN.hover.id === node.id);
    ctx.save();
    ctx.globalAlpha = dim ? .55 : 1;
    /* One violet: the orb, its glow and its edge are the product's colour and
     * nothing else -- the blue halo, the white highlight and the pale blue
     * rim read as layers stacked on the mark rather than as the mark. */
    const halo = ctx.createRadialGradient(x, y, r * .6, x, y, r * 2.6);
    halo.addColorStop(0, isLight() ? 'rgba(124,58,237,.2)' : 'rgba(124,58,237,.42)');
    halo.addColorStop(1, 'rgba(124,58,237,0)');
    ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(x, y, r * 2.6, 0, Math.PI * 2); ctx.fill();
    /* The orb is the app icon's own ground -- a deep violet bloom -- so the
     * mark on it can be the icon's violet plates rather than white on blue. */
    const orb = ctx.createRadialGradient(x + r * .34, y - r * .5, r * .08, x, y, r * 1.05);
    orb.addColorStop(0, '#5b3fd0'); orb.addColorStop(.5, '#2e1878'); orb.addColorStop(1, '#0f0830');
    if (colors.glow) { ctx.shadowColor = 'rgba(124,58,237,.7)'; ctx.shadowBlur = active ? 40 : 26; }
    ctx.fillStyle = orb; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = active ? 2.2 : 1.4; ctx.strokeStyle = active ? 'rgba(196,181,253,.8)' : 'rgba(167,139,250,.45)'; ctx.stroke();
    if (typeof Path2D === 'function') {
      if (!hubMarkPaths) hubMarkPaths = HUB_MARK.map(item => ({ path: new Path2D(item.d), tone: item.tone }));
      const size = r * 1.18, scale = size / 228;
      ctx.save();
      ctx.translate(x - 142 * scale, y - 120 * scale);
      ctx.scale(scale, scale);
      const light = ctx.createLinearGradient(40, 23, 244, 217);
      light.addColorStop(0, '#d9ceff'); light.addColorStop(1, '#8b74ff');
      const deep = ctx.createLinearGradient(244, 23, 40, 217);
      deep.addColorStop(0, '#7a5cff'); deep.addColorStop(1, '#3a23a8');
      for (const item of hubMarkPaths) {
        ctx.fillStyle = item.tone === 'light' ? light : deep;
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
    ctx.lineWidth = 1; ctx.strokeStyle = isLight() ? 'rgba(91,33,182,.18)' : 'rgba(196,181,253,.3)'; ctx.stroke();
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
  /*
   * A short note over the stage when a gesture did not do what the reader
   * may have meant: a wheel over the graph on the page scrolls the page, and
   * a finger scrolls the page too; zooming and moving the graph need Ctrl (or
   * the full view), or two fingers. Shown at most once every few seconds.
   */
  function gestureHint(kind) {
    const hint = document.getElementById('neuralGestureHint');
    const now = performance.now();
    if (!hint || now - (NVN.hintAt || -1e9) < 6000) return;
    NVN.hintAt = now;
    const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
    hint.textContent = kind === 'wheel'
      ? `${mac ? '⌘' : 'Ctrl'} + scroll to zoom · or open the full view`
      : 'Two fingers move the graph · or open the full view';
    hint.hidden = false;
    hint.classList.remove('is-leaving');
    clearTimeout(NVN.hintTimer);
    NVN.hintTimer = setTimeout(() => {
      hint.classList.add('is-leaving');
      NVN.hintTimer = setTimeout(() => { hint.hidden = true; hint.classList.remove('is-leaving'); }, 260);
    }, 2200);
  }

  function bindCanvas() {
    const c = NVN.canvas;
    const pts = new Map();
    let pinchDist = 0, pinchMid = null, lastTap = 0;
    const twoFinger = () => pts.size >= 2;
    const pair = () => { const [a, b] = [...pts.values()]; return { a, b }; };
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    /* On the page (not the full view) one finger belongs to the page: it
     * scrolls past the graph, and a tap still opens a card. */
    const pageTouch = e => e.pointerType === 'touch' && !stageExpanded();
    c.addEventListener('pointerdown', e => {
      try { c.setPointerCapture(e.pointerId); } catch {}
      const pos = pointerPos(e);
      pts.set(e.pointerId, pos);
      NVN.camTarget = null;
      if (twoFinger()) {
        const { a, b } = pair(); pinchDist = dist(a, b); pinchMid = mid(a, b);
        NVN.panning = false; NVN.draggingPanel = null; NVN.dragPlacement = null; NVN.pointerStart = null;
        return;
      }
      const node = hitNode(pos.x, pos.y);
      const panelHit = node ? null : panelHitAt(pos.x, pos.y);
      NVN.pointerStart = {
        x: pos.x, y: pos.y, panX: NVN.panX, panY: NVN.panY, node, moved: false,
        header: panelHit && panelHit.kind === 'header' ? panelHit.type : null,
        pageTouch: pageTouch(e)
      };
      NVN.lastPointer = pos;
    });
    c.addEventListener('pointermove', e => {
      const pos = pointerPos(e); NVN.lastPointer = pos;
      if (pts.has(e.pointerId)) pts.set(e.pointerId, pos);
      if (twoFinger()) {
        /* Two fingers pinch to zoom and move together to pan. */
        const { a, b } = pair();
        const d = dist(a, b), m = mid(a, b);
        if (pinchDist > 0 && d > 0) zoomAt(m.x, m.y, NVN.zoom * (d / pinchDist));
        if (pinchMid) { NVN.panX += m.x - pinchMid.x; NVN.panY += m.y - pinchMid.y; NVN.userCamera = true; }
        pinchDist = d; pinchMid = m;
        return;
      }
      const start = NVN.pointerStart;
      if (start && pts.has(e.pointerId)) {
        if (!start.moved && Math.hypot(pos.x - start.x, pos.y - start.y) > DRAG_THRESHOLD) {
          start.moved = true;
          if (start.pageTouch) gestureHint('touch');
          else if (start.header) {
            /* A panel's header is its handle: dragging it moves the panel. */
            const panel = NVN.panelByType && NVN.panelByType.get(start.header);
            if (panel) {
              const w = screenToWorld(start.x, start.y);
              NVN.draggingPanel = { type: panel.type, dx: w.x - panel.x, dy: w.y - panel.y };
              c.style.cursor = 'grabbing';
            }
          } else { NVN.panning = true; NVN.userCamera = true; }
        }
        if (NVN.draggingPanel) {
          const w = screenToWorld(pos.x, pos.y);
          movePanel(NVN.draggingPanel.type, w.x - NVN.draggingPanel.dx, w.y - NVN.draggingPanel.dy);
        } else if (NVN.panning) {
          NVN.panX = start.panX + pos.x - start.x;
          NVN.panY = start.panY + pos.y - start.y;
        }
        return;
      }
      const hit = hitNode(pos.x, pos.y);
      if (hit !== NVN.hover) NVN.hover = hit;
      const panelHit = hit ? null : panelHitAt(pos.x, pos.y);
      c.style.cursor = hit || (panelHit && panelHit.kind !== 'body' && panelHit.kind !== 'header') ? 'pointer'
        : panelHit && panelHit.kind === 'header' ? 'move' : 'grab';
    });
    c.addEventListener('pointerleave', () => { if (!NVN.pointerStart) NVN.hover = null; });
    const up = e => {
      try { c.releasePointerCapture(e.pointerId); } catch {}
      pts.delete(e.pointerId);
      if (pts.size < 2) { pinchDist = 0; pinchMid = null; }
      const start = NVN.pointerStart;
      if (NVN.draggingPanel) {
        const placed = NVN.dragPlacement;
        NVN.draggingPanel = null; NVN.dragPlacement = null;
        if (placed && e.type === 'pointerup') commitPlacement(placed.type, placed.x, placed.y);
        layoutGraph();
        renderLegend();
      } else if (e.type === 'pointerup' && start && !start.moved && pts.size === 0) {
        const panelHit = start.node ? null : panelHitAt(start.x, start.y);
        if (start.node) selectNode(start.node, { fly: true });
        else if (panelHit && panelHit.kind === 'more') toggleGroupRows(panelHit.type, true);
        else if (panelHit && panelHit.kind === 'less') toggleGroupRows(panelHit.type, false);
        else if (panelHit && (panelHit.kind === 'prev' || panelHit.kind === 'next')) pageGroup(panelHit.type, panelHit.kind === 'next' ? 1 : -1);
        else if (panelHit && panelHit.kind === 'header') focusGroup(panelHit.type);
        else {
          if (NVN.selected || NVN.focusGroup) { selectNode(null); NVN.focusGroup = null; renderLegend(); }
          if (e.pointerType !== 'mouse') {
            const now = performance.now();
            if (now - lastTap < 320) { fitGraph(true); lastTap = 0; } else lastTap = now;
          }
        }
      } else if (e.type === 'pointercancel' && start && start.pageTouch) gestureHint('touch');
      NVN.panning = false; NVN.pointerStart = null;
      c.style.cursor = '';
    };
    c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up);
    c.addEventListener('wheel', e => {
      /* On the page the wheel scrolls the page, as everywhere else on it;
       * Ctrl or Cmd with the wheel -- which is also what a trackpad pinch
       * sends -- zooms the graph. In the full view the wheel always zooms. */
      if (!stageExpanded() && !e.ctrlKey && !e.metaKey) { gestureHint('wheel'); return; }
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
    /* A lost drawing context (a phone reclaiming memory during a rotation)
     * comes back blank; the next frame redraws everything. */
    for (const canvas of [c, NVN.fx]) {
      if (!canvas) continue;
      canvas.addEventListener('contextlost', () => { NVN.staticKey = ''; });
      canvas.addEventListener('contextrestored', () => { NVN.staticKey = ''; invalidate(); startLoop(); });
    }
  }
  function zoomAt(x, y, zoom) {
    NVN.userCamera = true;
    const before = screenToWorld(x, y);
    NVN.zoom = clamp(zoom, .35, 2.6);
    const after = worldToScreen(before.x, before.y);
    NVN.panX += x - after.x; NVN.panY += y - after.y;
  }
  function zoomBy(factor) {
    NVN.userCamera = true;
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
      if (panel.moreY != null && Math.abs(w.y - panel.moreY) <= ROW_H / 2) {
        if (panel.footer === 'more') return { kind: 'more', type: panel.type };
        if (w.x - panel.x < FOOTER.lessEnd) return { kind: 'less', type: panel.type };
        const right = panel.x + panel.w;
        if (panel.pages > 1 && Math.abs(w.x - (right + FOOTER.prevX)) <= FOOTER.hit) return { kind: 'prev', type: panel.type };
        if (panel.pages > 1 && Math.abs(w.x - (right + FOOTER.nextX)) <= FOOTER.hit) return { kind: 'next', type: panel.type };
      }
      return { kind: 'body', type: panel.type };
    }
    return null;
  }
  function toggleGroupRows(type, open) {
    const expanded = NVN.expandedGroups;
    const opening = open == null ? !expanded.has(type) : open;
    if (opening) expanded.add(type); else { expanded.delete(type); NVN.groupPages.delete(type); }
    layoutGraph();
    if (NVN.selected && NVN.selected.folded) selectNode(null);
    renderLegend();
    const panel = (NVN.panels || []).find(item => item.type === type);
    if (panel) fitRect({ minX: panel.x - 30, minY: panel.y - 30, maxX: panel.x + panel.w + 30, maxY: panel.y + panel.h + 30 }, true, 1.25, true);
  }
  /* The next or previous page of an opened group. Pages are the same height,
   * so nothing else on the stage moves. */
  function pageGroup(type, step) {
    const panel = (NVN.panels || []).find(item => item.type === type);
    if (!panel || panel.pages <= 1) return false;
    const page = clamp(panel.page + step, 0, panel.pages - 1);
    if (page === panel.page) return false;
    NVN.groupPages.set(type, page);
    layoutGraph();
    if (NVN.selected && NVN.selected.folded) selectNode(null);
    const next = NVN.panels.find(item => item.type === type);
    const live = document.getElementById('neuralLive');
    if (live && next) {
      const first = next.page * PAGE_ROWS + 1;
      live.textContent = `${(TYPE_STYLE[type] || {}).plural || type}: ${first} to ${Math.min(next.members.length, first + PAGE_ROWS - 1)} of ${next.members.length}.`;
    }
    return true;
  }
  /* Opens every group that folds, or folds them all again. */
  function setAllGroupsOpen(open) {
    for (const panel of NVN.panels || []) {
      if (panel.members.length <= MAX_ROWS) continue;
      if (open) NVN.expandedGroups.add(panel.type);
      else { NVN.expandedGroups.delete(panel.type); NVN.groupPages.delete(panel.type); }
    }
    layoutGraph();
    if (NVN.selected && NVN.selected.folded) selectNode(null);
    renderLegend();
    fitGraph(true);
  }
  /*
   * Where the reader has put each panel, per repository, mode and shape of
   * stage (a phone's column and a desktop's two columns are different
   * arrangements). Kept in this browser only, and cleared with the rest of
   * the repository-scoped data when the account changes.
   */
  const PLACEMENT_KEY = 'nv_neural_layout';
  function placementKey() {
    const w = state && state.work;
    return w ? `${w.owner}/${w.repo}|${NVN.mode}|${NVN.layoutMode}` : '';
  }
  function placementStore() {
    if (NVN.placementStore) return NVN.placementStore;
    try {
      const saved = JSON.parse(localStorage.getItem(PLACEMENT_KEY) || '{}');
      NVN.placementStore = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
    } catch { NVN.placementStore = {}; }
    return NVN.placementStore;
  }
  function savedPlacements() {
    const key = placementKey();
    const saved = (key && placementStore()[key]) || {};
    const live = NVN.dragPlacement;
    return live ? { ...saved, [live.type]: { x: live.x, y: live.y } } : saved;
  }
  function persistPlacements() {
    const store = placementStore();
    /* Bounded: the arrangements of the 40 most recently arranged views. */
    const keys = Object.keys(store);
    if (keys.length > 40) for (const key of keys.slice(0, keys.length - 40)) delete store[key];
    try { localStorage.setItem(PLACEMENT_KEY, JSON.stringify(store)); } catch { /* not remembered */ }
  }
  function commitPlacement(type, x, y) {
    const key = placementKey();
    if (!key) return;
    const store = placementStore();
    const entry = { ...(store[key] || {}), [type]: { x: Math.round(x), y: Math.round(y) } };
    delete store[key];
    store[key] = entry;
    persistPlacements();
  }
  function hasPlacements() {
    const key = placementKey();
    return !!(key && placementStore()[key] && Object.keys(placementStore()[key]).length);
  }
  function resetPlacements() {
    const key = placementKey();
    if (key) { delete placementStore()[key]; persistPlacements(); }
    layoutGraph();
    renderLegend();
    fitGraph(true);
  }
  /* Moves a panel while it is dragged: its rows follow at once rather than
   * easing, so the panel is under the pointer the whole way. */
  function movePanel(type, x, y) {
    NVN.dragPlacement = { type, x, y };
    layoutGraph();
    const panel = NVN.panelByType && NVN.panelByType.get(type);
    if (panel) for (const n of panel.members) { n.x = n.tx; n.y = n.ty; n.appear = 1; }
  }

  /* A group hidden from the sidebar leaves the graph until it is shown again;
   * the choice is this viewer's and is remembered in this browser. */
  const HIDDEN_KEY = 'nv_neural_hidden_groups';
  function loadHiddenGroups() {
    try {
      const saved = JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]');
      if (Array.isArray(saved)) NVN.hiddenGroups = new Set(saved.filter(type => typeof type === 'string' && TYPE_STYLE[type] && type !== 'repo'));
    } catch { /* storage unavailable: nothing hidden */ }
  }
  function setGroupHidden(type, hidden) {
    if (!TYPE_STYLE[type] || type === 'repo') return;
    if (hidden) NVN.hiddenGroups.add(type); else NVN.hiddenGroups.delete(type);
    if (hidden && NVN.focusGroup === type) NVN.focusGroup = null;
    try { localStorage.setItem(HIDDEN_KEY, JSON.stringify([...NVN.hiddenGroups])); } catch { /* not remembered */ }
    applyMode();
    fitGraph(true);
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
    /* Page Down and Page Up page the selected node's group, or the lit one;
     * the selection follows to the same row on the new page. */
    if (key === 'PageDown' || key === 'PageUp') {
      const type = (NVN.selected && NVN.selected.type !== 'repo' && NVN.selected.type) || NVN.focusGroup;
      const panel = type && (NVN.panels || []).find(item => item.type === type);
      if (!panel) return;
      e.preventDefault();
      if (panel.footer === 'more') { toggleGroupRows(type, true); return; }
      const row = NVN.selected ? panel.shown.indexOf(NVN.selected) : -1;
      if (!pageGroup(type, key === 'PageDown' ? 1 : -1)) return;
      const next = NVN.panels.find(item => item.type === type);
      if (row >= 0 && next.shown.length) selectNode(next.shown[Math.min(row, next.shown.length - 1)], { fly: true, announce: true });
      return;
    }
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
    NVN.insets = null;
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
    if (NVN.insets) return NVN.insets;
    const stage = document.getElementById('neuralStage');
    const rail = document.getElementById('neuralRail');
    const rect = NVN.canvas ? NVN.canvas.getBoundingClientRect() : null;
    const inset = { left: 16, right: 64, top: 64, bottom: 20 };
    if (!stage || !rect || !rect.width) return inset;
    /* Measured, not assumed: the status and search may sit below a phone's
     * clock, the tools may have wrapped into a second column on a short
     * stage, and the edges may be clear of a notch -- the fit frames the
     * graph in whatever is actually left. */
    const top = stage.querySelector('.neural-stage-top');
    const topRect = top ? top.getBoundingClientRect() : null;
    if (topRect && topRect.height) {
      inset.top = Math.max(24, topRect.bottom - rect.top + 10);
      inset.left = Math.max(16, topRect.left - rect.left + 3);
    }
    const tools = stage.querySelector('.neural-stage-tools');
    const toolRect = tools ? tools.getBoundingClientRect() : null;
    if (toolRect && toolRect.width) {
      inset.right = Math.max(16, rect.right - toolRect.left + 10);
      inset.bottom = Math.max(16, rect.bottom - toolRect.bottom + 6);
    }
    if (stage.classList.contains('panel-open') && rail && rail.classList.contains('is-docked') && window.matchMedia('(min-width: 900px)').matches) {
      inset.left = Math.max(inset.left, rail.getBoundingClientRect().right - rect.left + 16);
    }
    NVN.insets = inset;
    return inset;
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
    let zoom = clamp(tall ? Math.min(byWidth, 1.1) : Math.min(byWidth, byHeight), .3, maxZoom);
    /* A large topology fitted whole would shrink every label past reading.
     * The fit stops at a zoom where a row can still be read, centred on the
     * hub; the minimap shows what lies beyond. */
    if (!tall && !whole && zoom < READABLE_ZOOM) zoom = Math.min(maxZoom, Math.max(zoom, Math.min(byWidth, READABLE_ZOOM)));
    const offsetX = inset.left + boxW / 2 - NVN.width / 2;
    const panX = offsetX - ((b.minX + b.maxX) / 2) * zoom;
    const panY = tall && (b.maxY - b.minY) * zoom > boxH
      ? inset.top - NVN.height / 2 - b.minY * zoom
      : inset.top + boxH / 2 - NVN.height / 2 - ((b.minY + b.maxY) / 2) * zoom;
    const target = { zoom, panX, panY };
    NVN.userCamera = false;
    if (!animateFit || !state.settings.motion) { NVN.zoom = zoom; NVN.panX = panX; NVN.panY = panY; NVN.camTarget = null; return; }
    NVN.camTarget = target;
  }
  const READABLE_ZOOM = .78;
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
      /* A node from a folded group, or from another page of an opened one,
       * opens its group at the page it is on. */
      NVN.expandedGroups.add(node.type);
      layoutGraph();
      const panel = (NVN.panels || []).find(item => item.type === node.type);
      const index = panel ? panel.members.indexOf(node) : -1;
      if (panel && panel.pages > 1 && index >= 0) { NVN.groupPages.set(node.type, Math.floor(index / PAGE_ROWS)); layoutGraph(); }
      renderLegend();
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
    NVN.userCamera = true;
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
    const inset = viewportInsets();
    const top = clamp(p.y - 44, inset.top - 2, Math.max(inset.top - 2, H - size.h - inset.bottom + 8));
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
  /*
   * The groups, organised by what they are about -- who can reach the
   * repository, its code, how it ships, what it depends on, what protects
   * it -- each with its count (and the repository's total where the graph
   * holds fewer), its critical and warning counts, a press that lights and
   * frames it, and an eye that hides it from the graph. For a large
   * repository this is where the picture is managed: hide what is not the
   * question, open or fold every group at once.
   */
  const GROUP_CATEGORIES = [
    ['Access', ['user', 'credential', 'leak', 'session', 'integration']],
    ['Code', ['branch', 'commit', 'tag', 'pull', 'issue', 'release']],
    ['Delivery', ['workflow', 'external']],
    ['Supply chain', ['package', 'vulnerability', 'scan']],
    ['Protection', ['protected', 'safety', 'snapshot']]
  ];
  const EYE_OPEN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/></svg>';
  const EYE_SHUT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4l16 16M9.9 5.8A9.8 9.8 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.9 3.7M6.1 7.4C3.8 9.1 2.5 12 2.5 12s3.5 6.5 9.5 6.5a9.6 9.6 0 0 0 4.2-.9"/></svg>';
  /* The stage's own Reset layout: shown while this repository, mode and
   * shape have panels the reader moved. */
  function syncResetChip() {
    const chip = document.getElementById('neuralResetLayout');
    const stage = document.getElementById('neuralStage');
    const moved = hasPlacements();
    if (chip) chip.hidden = !moved;
    if (stage) stage.classList.toggle('has-placements', moved);
  }
  function renderLegend() {
    syncResetChip();
    const host = document.getElementById('neuralLegend');
    if (!host) return;
    const stats = new Map();
    for (const n of NVN.nodes) {
      if (!n.inScope || n.type === 'repo') continue;
      const entry = stats.get(n.type) || { count: 0, critical: 0, warning: 0 };
      entry.count++;
      if (n.severity === 'critical') entry.critical++;
      else if (n.severity === 'warning') entry.warning++;
      stats.set(n.type, entry);
    }
    if (NVN.focusGroup && (!stats.has(NVN.focusGroup) || NVN.hiddenGroups.has(NVN.focusGroup))) NVN.focusGroup = null;
    const known = new Set(GROUP_CATEGORIES.flatMap(([, types]) => types));
    const categories = GROUP_CATEGORIES.map(([name, types]) => [name, types.filter(type => stats.has(type))]);
    const other = [...stats.keys()].filter(type => !known.has(type));
    if (other.length) categories.push(['Other', other]);
    const foldable = (NVN.panels || []).filter(panel => panel.members.length > MAX_ROWS);
    const allOpen = foldable.length && foldable.every(panel => NVN.expandedGroups.has(panel.type));
    const hiddenHere = [...NVN.hiddenGroups].filter(type => stats.has(type));
    const tools = [
      foldable.length ? `<button type="button" class="neural-groups-tool" data-neural-groups="${allOpen ? 'fold' : 'open'}">${allOpen ? 'Fold all' : 'Open all'}</button>` : '',
      hiddenHere.length ? `<button type="button" class="neural-groups-tool" data-neural-groups="show">Show all (${hiddenHere.length} hidden)</button>` : '',
      hasPlacements() ? '<button type="button" class="neural-groups-tool" data-neural-groups="reset-layout">Reset layout</button>' : ''
    ].join('');
    host.innerHTML = (tools ? `<div class="neural-groups-tools">${tools}</div>` : '') + categories.filter(([, types]) => types.length).map(([name, types]) => {
      const rows = types.map(type => {
        const st = TYPE_STYLE[type] || TYPE_STYLE.repo;
        const entry = stats.get(type);
        const hidden = NVN.hiddenGroups.has(type);
        const on = NVN.focusGroup === type;
        const total = (NVN.totals || {})[type];
        const plural = st.plural || st.label;
        /* A name too long for the row beside its counts is shortened there;
         * the whole name is the row's tooltip and the panel's header. */
        const name = st.short || plural;
        const pips = [
          entry.critical ? `<i class="ng-pip is-critical" title="${entry.critical} critical">${entry.critical}</i>` : '',
          entry.warning ? `<i class="ng-pip is-warning" title="${entry.warning} to review">${entry.warning}</i>` : ''
        ].join('');
        return `<div class="neural-group-row${hidden ? ' is-hidden' : ''}" style="--node:${nEsc(st.color)}">`
          + `<button type="button" class="neural-chip${on ? ' is-on' : ''}" data-neural-group="${nEsc(type)}" aria-pressed="${on}"${hidden ? ' aria-disabled="true"' : ''}>`
          + `<span class="ng-icon" aria-hidden="true">${iconSvg(type)}</span><span class="ng-name" title="${nEsc(plural)}">${nEsc(name)}</span>${pips}`
          + `<b>${entry.count}</b>${total > entry.count ? `<small>of ${total}</small>` : ''}</button>`
          + `<button type="button" class="neural-eye" data-neural-toggle="${nEsc(type)}" aria-pressed="${!hidden}" aria-label="${hidden ? 'Show' : 'Hide'} ${nEsc(plural.toLowerCase())}" title="${hidden ? 'Show' : 'Hide'} ${nEsc(plural.toLowerCase())}">${hidden ? EYE_SHUT : EYE_OPEN}</button>`
          + '</div>';
      }).join('');
      return `<section class="neural-group-cat" aria-label="${nEsc(name)}"><h4>${nEsc(name)}</h4>${rows}</section>`;
    }).join('');
    host.hidden = !stats.size;
  }
  function focusGroup(type) {
    NVN.focusGroup = NVN.focusGroup === type ? null : type;
    if (NVN.focusGroup) selectNode(null);
    renderLegend();
    const panel = (NVN.panels || []).find(item => item.type === NVN.focusGroup);
    if (panel) {
      fitRect({ minX: Math.min(panel.x, -HUB_R) - 30, minY: Math.min(panel.y, -HUB_R) - 30, maxX: Math.max(panel.x + panel.w, HUB_R) + 30, maxY: Math.max(panel.y + panel.h, HUB_R) + 30 }, true, 1.2, true);
      /* A framed group stays framed through a resize. */
      NVN.userCamera = true;
    } else fitGraph(true);
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
      leak: 'A credential an Exposure scan found in the repository or its history. The secret itself is never stored or shown.',
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
    if (node.type === 'leak') buttons.push('<button class="btn btn-ghost small" data-neural-action="exposure">Open in Exposure</button>');
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
      NVN.highlightNodes = new Set([node.id]); NVN.highlightEdges = new Set(); invalidate();
      if (typeof toast === 'function') toast(`Connection start: ${node.label}. Select another node and press Explain.`, 'ok');
      renderInspector(node); return;
    }
    if (NVN.explainStart === node.id) {
      NVN.explainStart = null; NVN.highlightNodes.clear(); NVN.highlightEdges.clear(); invalidate();
      if (typeof toast === 'function') toast('Connection selection cleared', 'ok');
      renderInspector(node); return;
    }
    const result = graphShortestPath(NVN.explainStart, node.id);
    const startNode = nodeById(NVN.explainStart);
    if (!result) { if (typeof toast === 'function') toast('No relationship path was found in the current graph', 'err'); return; }
    NVN.highlightNodes = new Set(result.nodeIds);
    NVN.highlightEdges = new Set(result.edges.map(e => e.id));
    invalidate();
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
      /* The hub stays in view while searching, as the anchor; the first
       * match is what gets selected. */
      const matches = visibleNodes().filter(n => n.match); if (NVN.search && matches.length) selectNode(matches[0], { fly: true }); else if (!NVN.search) fitGraph(true);
    });
    document.getElementById('neuralLiveBtn')?.addEventListener('click', liveConnectionFlow);
    document.getElementById('neuralRefreshBtn')?.addEventListener('click', () => load(true));
    document.getElementById('neuralFitBtn')?.addEventListener('click', () => fitGraph(true));
    document.getElementById('neuralResetLayout')?.addEventListener('click', () => resetPlacements());
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
      const eye = event.target.closest('[data-neural-toggle]');
      if (eye) { setGroupHidden(eye.dataset.neuralToggle, !NVN.hiddenGroups.has(eye.dataset.neuralToggle)); return; }
      const tool = event.target.closest('[data-neural-groups]');
      if (tool) {
        const action = tool.dataset.neuralGroups;
        if (action === 'show') { NVN.hiddenGroups.clear(); try { localStorage.removeItem(HIDDEN_KEY); } catch {} applyMode(); fitGraph(true); }
        else if (action === 'reset-layout') resetPlacements();
        else setAllGroupsOpen(action === 'open');
        return;
      }
      const chip = event.target.closest('[data-neural-group]');
      if (!chip) return;
      /* A hidden group's name brings it back, lit. */
      if (NVN.hiddenGroups.has(chip.dataset.neuralGroup)) setGroupHidden(chip.dataset.neuralGroup, false);
      focusGroup(chip.dataset.neuralGroup);
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
    else if (action === 'exposure' && typeof switchTab === 'function') { if (stageExpanded()) setStageExpanded(false); switchTab('exposure'); }
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
        bodyHTML: `<div class="neural-report-banner"><b>No repository changes were made.</b><p>${nNum(c.refsToMove)} branch(es) would move, ${nNum(c.refsToRecreate)} would be recreated and ${nNum(c.newerRefsPreserved)} newer branch(es) would be preserved.</p></div>
          <p class="hint">Files changed since the snapshot: ${nNum(c.filesModified)} modified, ${nNum(c.filesToRestore)} missing from the current tree, ${nNum(c.newerFilesPreserved)} newer file(s) preserved.</p>
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
      if (showResult && typeof modal === 'function') await modal({ title: 'Session containment', okText: 'Done', bodyHTML: `<p class="hint">${out.available ? `<b>${nNum(out.revoked)}</b> other session(s) revoked for <span class="mono">${nEsc(out.login || '')}</span>.` : `Session inventory is unavailable because this deployment is using cookie-only sessions. Connect Neon to enable cross-device revocation.`}</p>` });
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
        bodyHTML: `<div class="neural-report-banner"><b>Containment was recorded as a signed emergency manifest.</b><p>Read-only mode and synchronization freeze are active. ${controls.sessionRevocationAvailable ? `${nNum(controls.sessionsRevoked)} other session(s) were revoked.` : 'Cross-device session revocation was unavailable in cookie-only mode.'}</p></div>
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
        if (typeof toast === 'function') toast('Two fingers zoom and move the graph · double-tap to fit', 'ok');
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
