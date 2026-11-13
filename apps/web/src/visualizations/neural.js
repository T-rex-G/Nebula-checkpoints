/* ============================================================
   NEBULAVERSE NEURAL COMMAND CENTER — v5.2
   Functional repository topology built on Nebulaverse-X v5 data.
   ============================================================ */
import {
  state, api, toast, exposureRuleLabel, EXPOSURE_DISPOSITION_WORDS, modal, securityScanFlow,
  exportActivityFlow, openFile, switchTab, recoveryFlow, openSafeguards, setSafety, stepUpApi,
  dlFile, currentTab, purgeLocalData
} from '../legacy/app.js';
import { probeSource } from '../platform/probe.ts';
import { TYPE_STYLE, MODE_TYPES, short, addNode, addEdge, addEvent, buildGraph as buildNeuralGraph } from '../features/neural/graph-model.ts';
import {
  HEAD_H, ROW_H, MAX_ROWS, PAGE_ROWS, HUB_R, SEVERITY_RANK,
  layoutAspect, layoutModeOf, worldRadius, placeGraph, layoutBounds
} from '../features/neural/graph-layout.ts';
import { TYPE_ICON, inspectorMark } from '../features/neural/graph-marks.ts';
import { paletteFor, hexAlpha } from '../features/neural/graph-paint.ts';
import {
  worldToScreen as sceneToScreen, screenToWorld as sceneToWorld, worldSpace, screenSpace, worldView, focusSets
} from '../features/neural/graph-scene.ts';
import { drawField as paintField, addRipple } from '../features/neural/graph-field.ts';
import { drawStatic, drawAnimated, drawMinimap as paintMinimap, overflows, forgetFittedText, FOOTER } from '../features/neural/graph-renderer.ts';

const neuralGraph = (() => {

  /* The inspector's mark for a node: the drawn mark for the four drawn types (graph-marks.ts), its letter for the rest. */
  function nodeBadge(node) {
    return inspectorMark(node.mark) ?? nEsc(node.glyph || '');
  }


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
    field: null,
    fieldCtx: null,
    fieldState: { pointer: null, px: 0, py: 0, light: 0, ripples: [], sig: '' },
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
    catchUpBusy: false,
    catchUpPending: false,
    reloadPending: false,
    catchUpError: '',
    catchUpRetries: 0,
    loadController: null,
    catchUpController: null,
    liveStatus: 'disconnected'
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
  function workPath() {
    const w = state && state.work;
    return w ? `${encodeURIComponent(w.owner)}/${encodeURIComponent(w.repo)}` : '';
  }
  function repoKey() {
    const w = state && state.work;
    return w ? `${w.owner}/${w.repo}@${w.branch || ''}` : '';
  }
  function settledValue(result, fallback) { return result && result.status === 'fulfilled' ? result.value : fallback; }


  /*
   * Which repository the graph belongs to. Opening another bumps it (see
   * reset), and a load or a catch-up that was in flight for the last one
   * lands on nothing: it may not draw one repository's map under another's
   * name.
   */
  let generation = 0;

  async function load(force = false) {
    if (!state || !state.work || NVN.loading) return;
    /* Catching up defers a reload; a catch-up that has failed does not, so Refresh still reads the map again. */
    if (NVN.catchUpBusy || (NVN.active && !NVN.catchUpError && NVN.data && NVN.data.intelligence && NVN.data.intelligence.hasMore)) {
      NVN.reloadPending = true;
      if (!NVN.catchUpBusy) catchUpIntelligence();
      return;
    }
    const key = repoKey();
    if (!force && NVN.loadedKey === key && NVN.nodes.length) {
      resize(); renderInspector(NVN.selected); ensureLiveStream();
      catchUpIntelligence(); updateVisibleCount(); return;
    }
    /* Another repository, or another branch: the last map goes before this one is drawn. */
    if (NVN.loadedKey && NVN.loadedKey !== key) reset();
    const mine = generation;
    const controller = new AbortController();
    NVN.loadController = controller;
    const read = path => api(path, { signal: controller.signal });
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
      /* Without a selected branch, every read asks for the default branch rather than an empty name. */
      const requests = await Promise.allSettled([
        read('/api/safety'),
        read(`${base}/refs-snapshot`),
        read(`${base}/activity?days=30${branch ? `&ref=${branch}` : ''}`),
        read(`${base}/audit-deps${branch ? `?ref=${branch}` : ''}`),
        read(`${base}/actions${branch ? `?branch=${branch}` : ''}`),
        read('/api/security/sessions'),
        read(`${base}/live-events/status`),
        read(`${base}/intelligence/events?limit=500`),
        read(`${base}/signed-snapshots`),
        read(`${base}/access-surface`),
        read('/api/security/scanner-status'),
        /* What the Exposure scans found -- in the tree and in history --
         * already masked by the server: never the secret, and a path only as
         * a screen may show it. */
        read(`${base}/exposure/findings?limit=60`)
      ]);
      if (mine !== generation || repoKey() !== key) return;
      const safety = settledValue(requests[0], { readOnly: false, freezeSync: false, protected: {} });
      const refs = settledValue(requests[1], { refs: [], tags: [], defaultBranch: state.work.branch });
      const activity = settledValue(requests[2], { commits: [], pulls: [], issues: [], releases: [] });
      const deps = settledValue(requests[3], { scanned: 0, sources: [], vulnerable: [], details: {}, osv: { available: false, error: 'Dependency scan unavailable' }, dependabot: { available: false, alerts: [] } });
      const actions = settledValue(requests[4], []);
      const sessions = settledValue(requests[5], { available: false, sessions: [] });
      const live = settledValue(requests[6], { available: false, connected: false });
      const intelligence = settledValue(requests[7], { available: false, events: [] });
      const signedSnapshots = settledValue(requests[8], { available: false, snapshots: [] });
      const access = settledValue(requests[9], { available: false, partial: true, collaborators: [], deployKeys: [], webhooks: [], risk: { score: 0, severity: 'normal', reasons: [] } });
      const scanner = settledValue(requests[10], { builtin: { available: false }, yara: { configured: false, required: false } });
      const exposure = settledValue(requests[11], { findings: [], verifications: {} });
      const storedSnapshot = readStoredSnapshot();
      NVN.data = { safety, refs, activity, deps, actions, sessions, live, intelligence, signedSnapshots, access, scanner, exposure, storedSnapshot, errors: requests.map(r => r.status === 'rejected' ? r.reason && r.reason.message : '').filter(Boolean) };
      const sourceNames = ['Safety', 'References', 'Activity', 'Dependencies', 'Workflows', 'Sessions', 'Live events', 'Event history', 'Recovery', 'Access', 'Upload scanner', 'Exposure'];
      NVN.data.unavailable = requests.flatMap((result, index) => result.status === 'rejected' ? [sourceNames[index]] : []);
      NVN.catchUpError = '';
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
      setStream(streamLabel(), !NVN.paused && !NVN.data.unavailable.length);
      const sync = document.getElementById('neuralLastSync');
      if (sync) sync.textContent = `${dataGaps(NVN.data).length ? 'Partial read' : 'Polled'} · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    } catch (error) {
      if (mine !== generation) return;
      console.error('Neural graph load failed', error);
      if (typeof toast === 'function') toast(`Neural map: ${error.message}`, 'err');
      setStream('MAP UNAVAILABLE', false);
    } finally {
      if (mine === generation) {
        NVN.loading = false;
        NVN.loadController = null;
        if (loading) loading.hidden = true;
        if (empty) empty.hidden = !!NVN.nodes.length;
        resize();
        if (NVN.catchUpPending) { NVN.catchUpPending = false; catchUpIntelligence(); }
      }
    }
  }

  /*
   * Another repository was opened. The graph, its figures, its selection and
   * its live stream go at once; the next activation maps the new one from
   * nothing, behind the loading cover, rather than refreshing the old map in
   * place.
   */
  function reset() {
    cancelReads();
    closeLiveStream();
    clearTimeout(NVN.liveReloadTimer);
    NVN.loading = false;
    NVN.catchUpBusy = false;
    NVN.loadedKey = '';
    NVN.nodes = []; NVN.edges = []; NVN.events = [];
    NVN.data = null; NVN.totals = {};
    NVN.selected = null; NVN.hover = null;
    NVN.intelligenceCursor = '';
    NVN.timelineIndex = -1;
    NVN.userCamera = false;
    NVN.emergency = false;
    document.body.classList.remove('neural-emergency-active');
    closeCard();
    for (const id of ['neuralRiskScore', 'neuralSignalCount', 'neuralProtectedCount', 'neuralRecoveryState']) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.textContent = '—';
      const card = el.closest('.neural-kpi');
      if (card) delete card.dataset.level;
    }
    for (const id of ['neuralRiskHint', 'neuralRecoveryHint', 'neuralLastSync']) {
      const el = document.getElementById(id);
      if (el) el.textContent = '';
    }
    renderLegend();
    updateVisibleCount();
    updateTimeline(true);
  }

  function readStoredSnapshot() {
    try {
      const key = state && state.work ? `nv_snap_${state.work.owner}/${state.work.repo}` : '';
      return key ? JSON.parse(localStorage.getItem(key) || 'null') : null;
    } catch { return null; }
  }

  /*
   * The graph of the readings is features/neural/graph-model.ts's; where each
   * node sits and which one is selected stay the map's. A refresh keeps every
   * node where it was: only what changed moves, and the selection survives as
   * long as its node does.
   */
  function buildGraph(data) {
    const graph = buildNeuralGraph(data, {
      work: state.work,
      me: state.me,
      now: Date.now(),
      ruleLabel: rule => (typeof exposureRuleLabel === 'function' ? exposureRuleLabel(rule) : String(rule || 'Credential')),
      dispositionWords: EXPOSURE_DISPOSITION_WORDS && typeof EXPOSURE_DISPOSITION_WORDS === 'object' ? EXPOSURE_DISPOSITION_WORDS : {}
    });
    const previous = new Map(NVN.nodes.map(n => [n.id, n]));
    for (const n of graph.nodes) {
      const old = previous.get(n.id);
      if (old && old.x != null) { n.x = old.x; n.y = old.y; n.appear = old.appear; n.wasVisible = old.wasVisible; }
    }
    const selectedId = NVN.selected && NVN.selected.id;
    NVN.totals = graph.totals;
    NVN.nodes = graph.nodes;
    NVN.edges = graph.edges;
    NVN.events = graph.events;
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

  function dataGaps(data) {
    if (!data) return ['Map data'];
    const gaps = new Set(data.unavailable || []);
    for (const [name, value] of [['Activity', data.activity], ['References', data.refs], ['Dependencies', data.deps], ['Sessions', data.sessions], ['Live events', data.live], ['Event history', data.intelligence], ['Recovery', data.signedSnapshots], ['Access', data.access], ['Exposure', data.exposure]]) {
      if (value && (value.available === false || value.partial || value.truncated || value.hasMore || value.truncatedBefore)) gaps.add(name);
    }
    if (data.deps && data.deps.osv && data.deps.osv.available === false) gaps.add('Dependencies');
    if (data.activity && Object.values(data.activity.sources || {}).some(source => source && source.requested !== false && (source.available === false || source.truncated))) gaps.add('Activity');
    if (data.activity && [['commits', 'date'], ['pulls', 'updated'], ['issues', 'updated'], ['releases', 'published']].some(([kind, field]) => (data.activity[kind] || []).some(item => !item[field] || !Number.isFinite(Date.parse(item[field]))))) gaps.add('Activity timestamps');
    if (NVN.catchUpError) gaps.add('Event history');
    return [...gaps];
  }

  function updateSummary() {
    if (!NVN.data) return;
    const d = NVN.data;
    const vulnCritical = NVN.nodes.filter(n => n.type === 'vulnerability' && n.severity === 'critical').length;
    const vulnWarnings = NVN.nodes.filter(n => n.type === 'vulnerability' && n.severity === 'warning').length;
    const criticalLeaks = NVN.nodes.filter(n => n.type === 'leak' && n.severity === 'critical').length;
    const failedRuns = (d.actions || []).filter(a => a.conclusion === 'failure' || a.conclusion === 'cancelled').length;
    const protectedN = ((((d.safety || {}).protected || {})[`${state.work.owner}/${state.work.repo}`]) || []).length;
    const protectedBranches = (d.refs.refs || []).filter(r => r.protected).length;
    const latestSigned = d.signedSnapshots && d.signedSnapshots.snapshots && d.signedSnapshots.snapshots[0];
    const hasSnapshot = !!((latestSigned && latestSigned.signatureValid === true) || d.storedSnapshot);
    const invalidSnapshot = !!(latestSigned && latestSigned.signatureValid !== true);
    const recoveryUnknown = d.signedSnapshots && d.signedSnapshots.available === false && !d.storedSnapshot;
    const otherSessions = ((d.sessions && d.sessions.sessions) || []).filter(s => !s.current).length;
    const verified = ((d.intelligence || {}).events || []);
    const highestVerified = verified.reduce((m, e) => Math.max(m, Number(e.score || 0)), 0);
    const accessRisk = Number(d.access && d.access.risk && d.access.risk.score || 0);
    let risk = Math.max(12 + vulnCritical * 22 + vulnWarnings * 9 + failedRuns * 6 + otherSessions * 3, highestVerified, accessRisk);
    if (!hasSnapshot) risk += 9;
    if (!protectedN && !protectedBranches) risk += 7;
    if (d.safety.readOnly) risk -= 10;
    if (criticalLeaks) risk = Math.max(75, risk);
    risk = clamp(Math.round(risk), 0, 100);
    const gaps = dataGaps(d);
    const label = risk >= 75 ? 'Critical' : risk >= 50 ? 'Elevated' : risk >= 28 ? 'Guarded' : 'Low';
    const level = risk >= 75 ? 'critical' : risk >= 40 ? 'warning' : 'good';
    const riskEl = document.getElementById('neuralRiskScore');
    if (riskEl) { riskEl.textContent = gaps.length ? `${risk >= 75 ? 'Critical · ' : ''}Incomplete` : `${label} · ${risk}`; const card = riskEl.closest('.neural-kpi'); if (card) card.dataset.level = gaps.length && risk < 75 ? 'warning' : level; }
    const hint = document.getElementById('neuralRiskHint');
    const latestCritical = [...verified].reverse().find(e => e.severity === 'critical');
    const accessReason = d.access && d.access.risk && d.access.risk.reasons && d.access.risk.reasons[0];
    if (hint) hint.textContent = criticalLeaks ? `${criticalLeaks} critical exposed credential signal(s)` : latestCritical
      ? `${latestCritical.summary} · ${latestCritical.reasons && latestCritical.reasons[0] ? latestCritical.reasons[0].message : `risk ${latestCritical.score}`}`
      : accessRisk >= 70 ? `Critical access path · ${accessReason ? accessReason.message : `risk ${accessRisk}`}`
      : vulnCritical ? `${vulnCritical} critical vulnerability signal(s)`
      : failedRuns ? `${failedRuns} failed workflow run(s)`
      : accessRisk >= 35 ? `Access posture warning · ${accessReason ? accessReason.message : `risk ${accessRisk}`}`
      : gaps.length ? `Incomplete sources: ${gaps.join(', ')}` : 'No critical signals in the observed data';
    if (hint && gaps.length && (criticalLeaks || latestCritical || accessRisk >= 35 || vulnCritical || failedRuns)) hint.textContent += ` · Incomplete: ${gaps.join(', ')}`;
    const signals = document.getElementById('neuralSignalCount'); if (signals) signals.textContent = String(NVN.events.length);
    const protectedEl = document.getElementById('neuralProtectedCount'); if (protectedEl) protectedEl.textContent = String(protectedN + protectedBranches);
    const recovery = document.getElementById('neuralRecoveryState');
    const recoveryHint = document.getElementById('neuralRecoveryHint');
    if (recovery) { recovery.textContent = invalidSnapshot ? 'Unverified' : hasSnapshot ? 'Captured' : recoveryUnknown ? 'Unknown' : 'Gap'; const card = recovery.closest('.neural-kpi'); if (card) card.dataset.level = hasSnapshot && !invalidSnapshot ? 'good' : 'warning'; }
    if (recoveryHint) recoveryHint.textContent = invalidSnapshot ? 'Retained snapshot signature could not be verified' : hasSnapshot ? `${latestSigned ? 'Verified' : 'Local'} snapshot ${timeAgoN(latestSigned ? latestSigned.createdAt : d.storedSnapshot.capturedAt)}` : recoveryUnknown ? 'Recovery evidence could not be read' : 'Capture refs before an incident';
    document.body.classList.toggle('neural-emergency-active', !!(d.safety.readOnly && d.safety.freezeSync));
    NVN.emergency = !!(d.safety.readOnly && d.safety.freezeSync);
    const roBtn = document.getElementById('neuralReadOnlyBtn');
    if (roBtn) roBtn.textContent = d.safety.readOnly ? 'Disable read-only' : 'Enable read-only';
    const liveBtn = document.getElementById('neuralLiveBtn');
    if (liveBtn) {
      liveBtn.disabled = !d.live.available;
      /* The control carries a full label and a short one for narrow widths;
         both change together, and the icon beside them stays. */
      const long = liveBtn.querySelector('.nh-long');
      const short = liveBtn.querySelector('.nh-short');
      const full = d.live.connected ? 'Disconnect verified live events' : 'Connect verified live events';
      if (long) long.textContent = full; else liveBtn.textContent = full;
      if (short) short.textContent = d.live.connected ? 'Disconnect' : 'Live events';
      liveBtn.title = d.live.available ? '' : (d.live.reason || 'Neon and GitHub are required');
    }
  }

  function updateVisibleCount() {
    const count = visibleNodes().length;
    NVN.visibleCount = count;
    const label = document.getElementById('neuralStreamLabel');
    if (label && !NVN.loading) label.textContent = `${streamLabel()} · ${count} NODES`;
  }

  function streamLabel() {
    if (NVN.paused) return 'PAUSED';
    if (NVN.catchUpError) return 'EVENT HISTORY UNAVAILABLE';
    if (NVN.data && NVN.data.intelligence && NVN.data.intelligence.hasMore) return 'LIVE CATCHING UP';
    if (NVN.liveStatus === 'live') return 'VERIFIED LIVE';
    if (NVN.liveStatus === 'connecting') return 'LIVE CONNECTING';
    if (NVN.liveStatus === 'reconnecting') return 'LIVE RECONNECTING';
    return dataGaps(NVN.data).length ? 'PARTIAL TOPOLOGY' : 'POLLING TOPOLOGY';
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
    NVN.field = document.getElementById('neuralField');
    NVN.fieldCtx = NVN.field ? NVN.field.getContext('2d', { alpha: true }) : null;
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
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { forgetFittedText(); invalidate(); }).catch(() => {});
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
    if (NVN.field && (NVN.field.width !== w || NVN.field.height !== h)) { NVN.field.width = w; NVN.field.height = h; NVN.fieldState.sig = ''; }
    if (NVN.fitPending) fitGraph(false);
    /* A rotation or a resize that changes the stage's shape re-lays the
     * graph for it -- including every time the shape crosses from wide to
     * tall, however small the change. */
    const nextMode = layoutModeOf(stageAspect());
    if (NVN.nodes.length && NVN.layoutAspectUsed && (nextMode !== NVN.layoutMode || Math.abs(stageAspect() - NVN.layoutAspectUsed) > .2)) {
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
   * The layout (features/neural/graph-layout.ts) decides where each panel
   * stands and where each node belongs; the map hands it what the reader has
   * opened, paged and moved, and keeps what it answers. Positions are
   * targets: the frame loop eases every node toward its row, so changing
   * mode, filtering, searching or opening a group moves the graph instead of
   * cutting to a new one.
   */
  function stageAspect() { return layoutAspect(NVN.width, NVN.height); }
  function nodeRadius(node) { return worldRadius(node) * NVN.zoom; }

  function layoutGraph(options = {}) {
    const expanded = NVN.expandedGroups || (NVN.expandedGroups = new Set());
    const aspect = stageAspect();
    NVN.layoutAspectUsed = aspect;
    /* Set before the placements are read: they are kept for each mode. */
    NVN.layoutMode = layoutModeOf(aspect);
    const layout = placeGraph({ nodes: NVN.nodes, expanded, pages: NVN.groupPages, totals: NVN.totals || {}, aspect, placed: savedPlacements() });
    for (const [type, page] of layout.pages) NVN.groupPages.set(type, page);
    for (const [n, target] of layout.targets) { n.tx = target.x; n.ty = target.y; n.folded = target.folded; }
    NVN.panelByType = layout.byType;
    NVN.panels = layout.panels;
    invalidate();
    const snap = options.instant || !state.settings.motion;
    for (const n of NVN.nodes) {
      if (!n.visible) continue;
      /* A node arriving in this mode grows out of the hub it belongs to. */
      if (snap || !n.wasVisible) {
        if (snap) { n.x = n.tx; n.y = n.ty; } else { n.x = 0; n.y = 0; }
        n.appear = snap ? 1 : 0;
      }
    }
    for (const n of NVN.nodes) n.wasVisible = n.visible;
  }

  /* The palette for the page's design preset and theme (graph-paint.ts). */
  function palette() {
    const root = document.documentElement.dataset;
    return paletteFor(root.design === 'obsidian' ? 'obsidian' : 'nebula', root.theme === 'light' ? 'light' : 'dark');
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
    /* A short stage -- a phone held sideways -- keeps the minimap for the full
     * view, where it is drawn smaller; on the page it would cover half the
     * graph it maps. */
    const room = H >= 440 || (H >= 300 && stageExpanded());
    const show = overflows(NVN) && W >= 600 && room && (NVN.panels || []).length > 0 && !(NVN.selected && cardDocked());
    if (mini.hidden === show) mini.hidden = !show;
    if (!show) { NVN.miniKey = ''; return; }
    const key = `${NVN.frameKeyStatic}|${W}|${H}`;
    if (key === NVN.miniKey) return;
    NVN.miniKey = key;
    const cw = mini.clientWidth || 156, ch = mini.clientHeight || 108, dpr = NVN.dpr;
    if (mini.width !== Math.round(cw * dpr) || mini.height !== Math.round(ch * dpr)) { mini.width = Math.round(cw * dpr); mini.height = Math.round(ch * dpr); }
    NVN.miniMap = paintMinimap(mini.getContext('2d'), NVN, colors, cw, ch);
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

  function worldToScreen(x, y) { return sceneToScreen(NVN, x, y); }
  function screenToWorld(x, y) { return sceneToWorld(NVN, x, y); }

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
    /* The ground keeps its own clock: it redraws when the camera or the layout
     * changes or while its light or a ripple moves, and not otherwise. */
    if (NVN.fieldCtx) paintField(NVN.fieldCtx, NVN, NVN.fieldState, colors, now, dt, fieldMotion());
    /* Nothing moved and nothing animates: the last frame is still right. */
    if (!dirty && !animated && NVN.frameKey === key) return;
    /* At rest, the signals run at half rate. */
    if (!dirty && animated && now - NVN.lastDraw < 31) return;
    NVN.lastDraw = now;
    const focus = focusSets(NVN);
    const hub = NVN.nodes.find(n => n.type === 'repo' && n.visible);
    const view = worldView(NVN);
    if (dirty) {
      screenSpace(ctx, NVN);
      ctx.clearRect(0, 0, NVN.width, NVN.height);
      drawStatic(ctx, NVN, colors, focus, hub, view, !NVN.fieldCtx);
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
    if (fx !== ctx) { screenSpace(fx, NVN); fx.clearRect(0, 0, NVN.width, NVN.height); }
    worldSpace(fx, NVN);
    drawAnimated(fx, NVN, now, colors, focus, hub, view, animated);
    screenSpace(fx, NVN);
    drawLeader(fx, colors);
    positionCard();
    NVN.frameKeyStatic = moving || NVN.panning ? `${now}` : key;
    drawMinimap(colors);
    NVN.frameKey = key;
  }

  /*
   * The ground is a field (graph-field.ts). With motion off, or where the
   * system asks for reduced motion, the bends and the well stay and the light
   * and the ripples do not.
   */
  const REDUCED_MOTION = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  function fieldMotion() {
    return !!state.settings.motion && !(REDUCED_MOTION && REDUCED_MOTION.matches);
  }
  function fieldRipple(sx, sy) {
    if (!NVN.fieldCtx || !fieldMotion() || !NVN.zoom) return;
    addRipple(NVN.fieldState, NVN, sx, sy, performance.now());
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
      /* A press drops a ripple into the ground under the graph. */
      NVN.fieldState.pointer = pos;
      fieldRipple(pos.x, pos.y);
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
      NVN.fieldState.pointer = pos;
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
    c.addEventListener('pointerleave', () => { NVN.fieldState.pointer = null; if (!NVN.pointerStart) NVN.hover = null; });
    const up = e => {
      try { c.releasePointerCapture(e.pointerId); } catch {}
      pts.delete(e.pointerId);
      /* A finger lifted is a hand gone: the light fades after it. */
      if (e.pointerType !== 'mouse' && !pts.size) NVN.fieldState.pointer = null;
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
    fitRect(layoutBounds(NVN.panels || []), animateFit);
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
    /* Chosen from the keyboard, the node sends its own ripple through the
     * ground -- the press that would have made one never happened. */
    if (options.announce) { const at = worldToScreen(node.tx ?? node.x, node.ty ?? node.y); fieldRipple(at.x, at.y); }
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
    NVN.liveStatus = 'disconnected';
  }

  function cancelReads() {
    generation += 1;
    if (NVN.loadController) NVN.loadController.abort();
    if (NVN.catchUpController) NVN.catchUpController.abort();
    NVN.loadController = null; NVN.catchUpController = null;
    NVN.loading = false; NVN.catchUpBusy = false;
    NVN.catchUpPending = false; NVN.reloadPending = false;
    NVN.catchUpError = ''; NVN.catchUpRetries = 0;
    clearTimeout(NVN.liveReloadTimer);
  }

  function scheduleCatchUp(delay = 250) {
    clearTimeout(NVN.liveReloadTimer);
    if (!NVN.active) return;
    NVN.liveReloadTimer = setTimeout(() => catchUpIntelligence(), delay);
  }

  async function catchUpIntelligence() {
    if (!NVN.active || !state || !state.work || !NVN.data) return;
    if (NVN.loading || NVN.catchUpBusy) { NVN.catchUpPending = true; return; }
    const mine = generation;
    const key = repoKey();
    const base = workPath();
    const controller = new AbortController();
    NVN.catchUpController = controller;
    NVN.catchUpBusy = true;
    NVN.catchUpPending = false;
    let hasMore = false;
    try {
      const existing = ((NVN.data.intelligence || {}).events || []);
      const merged = new Map(existing.filter(event => event && event.id).map(event => [event.id, event]));
      let after = NVN.intelligenceCursor || (NVN.data.intelligence && NVN.data.intelligence.cursor) || '';
      let truncatedBefore = !!(NVN.data.intelligence && NVN.data.intelligence.truncatedBefore);
      let pages = 0;
      while (pages < 5) {
        const query = after ? `&after=${encodeURIComponent(after)}` : '';
        const page = await api(`/api/repo/${base}/intelligence/events?limit=500${query}`, { signal: controller.signal });
        if (mine !== generation || key !== repoKey()) return;
        if (page.available === false) throw new Error('Persisted event history is unavailable');
        truncatedBefore = truncatedBefore || !!page.truncatedBefore;
        for (const event of page.events || []) if (event && event.id) merged.set(event.id, event);
        const next = String(page.cursor || '');
        hasMore = !!page.hasMore;
        if (hasMore && (!next || next === after)) throw new Error('Event history cursor did not advance');
        if (next) after = next;
        pages += 1;
        if (!hasMore) break;
      }
      if (mine !== generation || key !== repoKey() || !NVN.data) return;
      const events = [...merged.values()]
        .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0) || String(a.id).localeCompare(String(b.id)))
        .slice(-1500);
      // The cursor and the events it acknowledges are accepted together.
      NVN.intelligenceCursor = after;
      NVN.data.intelligence = { available: true, events, cursor: after, hasMore, truncatedBefore: truncatedBefore || merged.size > events.length };
      NVN.catchUpError = ''; NVN.catchUpRetries = 0;
      buildGraph(NVN.data);
      updateSummary();
      updateTimeline(true);
      applyMode();
    } catch (error) {
      if (mine !== generation || controller.signal.aborted) return;
      NVN.catchUpError = error && error.message || 'Event history unavailable';
      NVN.catchUpRetries += 1;
      console.warn('Neural intelligence catch-up failed', error && error.message);
      updateSummary(); updateVisibleCount();
    } finally {
      if (mine === generation) {
        NVN.catchUpBusy = false; NVN.catchUpController = null;
        /* A Refresh pressed while an attempt was in flight is read as soon as
         * the attempt fails, not after every retry: the reload reads the
         * history afresh. One that succeeds still finishes catching up first. */
        if (NVN.catchUpError && NVN.reloadPending) { NVN.reloadPending = false; load(true); }
        else if (NVN.catchUpError) {
          if (NVN.catchUpRetries <= 3) scheduleCatchUp(Math.min(30000, 1000 * 2 ** NVN.catchUpRetries));
        } else if (hasMore || NVN.catchUpPending) scheduleCatchUp();
        else if (NVN.reloadPending) { NVN.reloadPending = false; load(true); }
      }
    }
  }

  function ensureLiveStream() {
    const connected = !!(NVN.data && NVN.data.live && NVN.data.live.connected);
    const key = `${workPath()}:${connected}`;
    if (!NVN.active || !connected || typeof EventSource === 'undefined') { closeLiveStream(); return; }
    if (NVN.eventSource && NVN.eventSourceKey === key) return;
    closeLiveStream();
    const source = new EventSource(`/api/repo/${workPath()}/live-events/stream`);
    NVN.eventSource = source; NVN.eventSourceKey = key;
    NVN.liveStatus = 'connecting';
    source.addEventListener('ready', () => {
      if (NVN.eventSource !== source || !NVN.active) return;
      NVN.liveStatus = 'live'; setStream(streamLabel(), true); catchUpIntelligence();
    });
    source.addEventListener('session-revoked', async () => {
      if (NVN.eventSource !== source || !NVN.active) return;
      try { await purgeLocalData(true); } catch {}
      closeLiveStream();
      location.reload();
    });
    source.addEventListener('intelligence', e => {
      if (NVN.eventSource !== source || !NVN.active) return;
      let event = null; try { event = JSON.parse(e.data); } catch {}
      if (event && event.severity === 'critical' && typeof toast === 'function') toast(`Critical verified event: ${event.summary}`, 'err');
      scheduleCatchUp();
    });
    source.onerror = () => {
      if (NVN.eventSource !== source || !NVN.active) return;
      NVN.liveStatus = 'reconnecting';
      setStream('LIVE RECONNECTING', false);
      scheduleCatchUp(1200);
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
    if (NVN.data?.safety?.globalControls === false) {
      if (typeof toast === 'function') toast('Identity-wide Emergency Shield is unavailable in hosted alpha. Use repository Safeguards and session revocation.', 'err');
      return;
    }
    const operation = Object.freeze({
      owner: state.work.owner, repo: state.work.repo, branch: state.work.branch,
      path: workPath(), epoch: state.uiEpoch
    });
    const repository = `${operation.owner}/${operation.repo}`;
    const ok = await modal({
      title: 'Activate Emergency Shield', danger: true, okText: 'Contain incident',
      bodyHTML: `<div class="neural-report-banner"><b>Activate containment for ${nEsc(repository)}.</b><p>Nebulaverse-X captures repository references and a file manifest, enables read-only mode, freezes synchronization, revokes other database-backed sessions and records tamper-evident evidence. These steps can complete separately; an interrupted request may leave controls active.</p></div>
        <label class="field-label">Type <span class="mono">FREEZE</span> to confirm</label><input id="neuralEmergencyConfirm" type="text" autocomplete="off" spellcheck="false" placeholder="FREEZE">
        <p class="hint">This is a Recovery Snapshot Lite and incident manifest. It is not a complete off-platform mirror of Git and LFS objects.</p>`
    });
    if (!ok || state.uiEpoch !== operation.epoch) return;
    const confirm = document.getElementById('neuralEmergencyConfirm');
    if (!confirm || confirm.value.trim().toUpperCase() !== 'FREEZE') { if (typeof toast === 'function') toast('Emergency confirmation did not match', 'err'); return; }
    const button = document.getElementById('neuralEmergencyBtn'); if (button) button.disabled = true;
    setStream('CONTAINING INCIDENT', false);
    let confirmed = false;
    try {
      const [containment, activityResult] = await Promise.all([
        stepUpApi('sessions.revoke-others', {}, `/api/repo/${operation.path}/emergency-manifest`, {
          method: 'POST', body: { confirm: 'FREEZE' }
        }, 'Activate Emergency Shield and revoke other sessions'),
        api(`/api/repo/${operation.path}/activity?days=30`).catch(error => ({ error: error.message }))
      ]);
      if (state.uiEpoch !== operation.epoch) return;
      if (!containment) {
        setStream('AUTHORIZATION CANCELLED', false);
        return;
      }
      confirmed = true;
      const manifest = containment.manifest || {};
      /* The privacy purge clears state.work and the displayed identity. Keep
         the incident bound to its original repository, and never restore the
         cleared identity from a response that may predate an account change. */
      let purgeFailed = false;
      try { await purgeLocalData(false); } catch { purgeFailed = true; }
      const epochAfterPurge = operation.epoch + 1;
      if (state.uiEpoch !== epochAfterPurge) return;
      const report = {
        kind: 'nebulaverse-emergency-containment-report', version: 2, generatedAt: new Date().toISOString(),
        repository, branch: operation.branch,
        manifestId: containment.manifestId || '', signature: containment.signature || '',
        persisted: !!containment.persisted, evidence: containment.evidence || null,
        controls: manifest.controls || {}, snapshot: manifest, activity: activityResult
      };
      let stored = false;
      try {
        localStorage.setItem(`nv_incident_${repository}`, JSON.stringify(report));
        localStorage.setItem(`nv_snap_${repository}`, JSON.stringify(manifest));
        stored = true;
      } catch {
        const compact = { ...report, snapshot: { ...manifest, manifest: manifest.manifest ? { branch: manifest.manifest.branch, fileCount: (manifest.manifest.files || []).length, truncated: !!manifest.manifest.truncated } : null } };
        try { localStorage.setItem(`nv_incident_${repository}`, JSON.stringify(compact)); } catch {}
      }
      let downloaded = false;
      try {
        if (typeof dlFile === 'function') {
          dlFile(`nebulaverse-emergency-${operation.owner}-${operation.repo}-${Date.now()}.json`, JSON.stringify(report, null, 2), 'application/json');
          downloaded = true;
        }
      } catch { /* Evidence delivery cannot undo confirmed server controls. */ }
      const controls = manifest.controls || {};
      const active = controls.readOnly === true && controls.freezeSync === true;
      document.body.classList.toggle('neural-emergency-active', active);
      const refs = Array.isArray(manifest.refs) ? manifest.refs.length : 0;
      await modal({
        title: active ? 'Emergency containment active' : 'Containment status needs review', okText: 'Reload current session',
        bodyHTML: `<div class="neural-report-banner"><b>${nEsc(repository)}</b><p>${active ? 'Read-only mode and synchronization freeze are active.' : 'The response did not confirm both containment controls. Check Safeguards before retrying.'} ${controls.sessionRevocationAvailable ? `${nNum(controls.sessionsRevoked)} other session(s) were revoked.` : 'Cross-device session revocation was unavailable.'}</p></div>
          <p class="hint">Reference snapshot: ${refs} branch ref(s) captured · ${containment.persisted ? 'stored in Neon' : stored ? 'saved in this browser' : 'not saved in this browser'} · ${downloaded ? 'download requested' : 'download unavailable'} · evidence ${containment.evidence ? 'recorded' : 'unavailable'}.</p>
          ${purgeFailed ? '<p class="hint">Private browser data cleanup could not be completed. Reload the current session before continuing.</p>' : ''}
          <p class="hint">Review the downloaded JSON evidence, protected files and recovery preview before making restore decisions.</p>`
      });
      if (state.uiEpoch === epochAfterPurge) location.reload();
    } catch (e) {
      if (typeof toast === 'function') toast(confirmed
        ? `Containment responded, but its report could not be displayed: ${e.message}. Reload Safeguards to check the controls.`
        : `Emergency Shield completion could not be confirmed: ${e.message}. Controls may already be active; check Safeguards before retrying.`, 'err');
    }
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
    cancelReads();
    collapseStageOnLeave();
    stopLoop();
    clearInterval(NVN.refreshTimer);
    NVN.refreshTimer = 0;
    closeLiveStream();
  }

  document.addEventListener('visibilitychange', () => {
    NVN.active = document.visibilityState === 'visible' && typeof currentTab === 'function' && currentTab() === 'neural';
    if (NVN.active) { startLoop(); load(false); }
    else { stopLoop(); closeLiveStream(); cancelReads(); }
  });
  window.addEventListener('resize', resize);
  /* What the browser suite may read of the graph: copies, and only under the test harness. */
  probeSource('neural', () => NVN);
  return { activate, deactivate, reset, refresh: () => load(true), emergencyShield, injectDemo, state: NVN };
})();

export default neuralGraph;
