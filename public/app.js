/* ============================================================
   NEBULAVERSE-X — app.js
   ============================================================ */
'use strict';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const isMobile = () => window.matchMedia('(max-width:900px)').matches;
const NV_ASSET_VERSION = document.documentElement.dataset.nvAssetVersion || '';
const NV_PRODUCT_NAME = 'Nebulaverse-X';
let ownerWorkbench = null;
let identityEpoch = 0;
let ownerRequests = 0;

const state = {
  me: null,
  repos: [], repoPage: 1, repoSort: 'pushed',
  work: null, file: null, cm: null,
  commitsPage: 1,
  staged: [],
  fileIndex: null,
  prState: 'open', issueState: 'open',
  settings: { fontSize: 14, wrap: true, motion: true, editorTheme: 'material-ocean', editorFont: 'DM Mono' },
  governance: { digitalTwin: null, access: null, loading: false, error: '', simulation: null, verification: null, scopeKey: '', decisionPages: [], delivery: { notifications: { events: [] }, preferences: {}, exports: [], webhooks: [], error: '' } },
  /*
   * Limits start unknown, not at the self-hosted maxima. These three used to
   * hold 2048/64/64 -- the ceilings of a self-hosted deployment -- so until
   * /api/config answered, and forever if it never did, a hosted alpha enforcing
   * 25/16/16 told its reader the per-file limit was 2048 MB and labelled a
   * 30 MB file as a Git Data API push the server would refuse. A number nobody
   * sent us is not a smaller number; it is no number.
   */
  runtime: { uploadMaxMb: null, gitDataMaxMb: null, nativePushMaxMb: null, contentsMaxMb: null, githubApp: { enabled: false, webhookConfigured: false } }
};

function branchRecord(branch = state.work && state.work.branch) {
  return state.work && Array.isArray(state.work.branches) ? state.work.branches.find(item => item.name === branch) : null;
}
function currentHeadSha(branch = state.work && state.work.branch) {
  const record = branchRecord(branch);
  return record && /^[0-9a-f]{40}$/i.test(record.sha || '') ? record.sha : '';
}
function guardedWrite(extra = {}, branch = state.work && state.work.branch) {
  const expectedHeadSha = currentHeadSha(branch);
  return expectedHeadSha ? { ...extra, expectedHeadSha } : extra;
}
function rememberHead(commit, branch = state.work && state.work.branch) {
  if (!/^[0-9a-f]{40}$/i.test(String(commit || ''))) return;
  const record = branchRecord(branch);
  if (record) record.sha = String(commit);
}

/* ---------------- fetch helper ---------------- */
const _cache = new Map();
function offlineRepoStorageKey() {
  const scope = state.me && state.me.offlineCacheScope;
  return scope ? `nv_offline_repos:${scope}` : '';
}
function offlineRepoList() {
  const key = offlineRepoStorageKey();
  if (!key) return [];
  try {
    const value = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(value) ? value.filter(item => typeof item === 'string').slice(0, 100) : [];
  } catch { return []; }
}
function workOfflineRepoKey() {
  if (!state.work || !state.me) return '';
  return `${state.me.provider || 'github'}:${state.work.owner}/${state.work.repo}`.toLowerCase();
}
function isOfflineRepoEnabled() {
  const key = workOfflineRepoKey();
  return !!key && offlineRepoList().includes(key);
}
async function setOfflineRepoEnabled(enabled) {
  const storageKey = offlineRepoStorageKey();
  const repoKey = workOfflineRepoKey();
  if (!storageKey || !repoKey) throw new Error('Sign in and open a repository first');
  const repos = new Set(offlineRepoList());
  if (enabled) repos.add(repoKey); else repos.delete(repoKey);
  localStorage.setItem(storageKey, JSON.stringify([...repos].slice(0, 100)));
  if (!enabled) await purgePrivateCaches();
}
function offlineHeadersForPath(path, method) {
  if (String(method || 'GET').toUpperCase() !== 'GET') return {};
  const scope = state.me && state.me.offlineCacheScope;
  if (!scope || offlineRepoList().length === 0) return {};
  if (/^\/api\/repos(?:[?\/]|$)/.test(path)) {
    return { 'x-nv-offline-scope': scope, 'x-nv-offline-repo': 'account' };
  }
  const match = /^\/api\/repo\/([^/]+)\/([^/?]+)/.exec(path);
  if (!match) return {};
  const repoKey = `${state.me.provider || 'github'}:${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}`.toLowerCase();
  if (!offlineRepoList().includes(repoKey)) return {};
  return { 'x-nv-offline-scope': scope, 'x-nv-offline-repo': repoKey };
}
let csrfToken = '';
let csrfExpiresAt = 0;
let csrfRequest = null;
function clearCsrfToken() {
  csrfToken = '';
  csrfExpiresAt = 0;
  csrfRequest = null;
}
async function refreshCsrfToken() {
  if (csrfRequest) return csrfRequest;
  csrfRequest = (async () => {
    const response = await fetch('/api/security/csrf', {
      method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { 'x-nv': '1' }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.token) {
      const error = new Error(data.error || 'Unable to establish the request security context');
      error.status = response.status;
      error.code = data.code || '';
      throw error;
    }
    csrfToken = String(data.token);
    csrfExpiresAt = new Date(data.expiresAt || 0).getTime();
    return csrfToken;
  })();
  try { return await csrfRequest; }
  finally { csrfRequest = null; }
}
async function ensureCsrfToken() {
  if (csrfToken && csrfExpiresAt - Date.now() > 30_000) return csrfToken;
  clearCsrfToken();
  return refreshCsrfToken();
}
async function api(path, opts = {}, allowCsrfRetry = true) {
  const epoch = identityEpoch;
  const method = String(opts.method || 'GET').toUpperCase();
  const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  if (ownerWorkbench) {
    const binding = ownerWorkbench;
    if (unsafe) _cache.clear();
    ownerRequests++;
    try {
      const result = await window.NebulaWorkspaceUI.workbench(path, opts, binding);
      if (epoch !== identityEpoch || binding !== ownerWorkbench) throw new Error('Workspace changed; reopen the workbench.');
      return result;
    } catch (error) {
      if (['WORKSPACE_EXECUTION_CHANGED', 'WORKSPACE_SESSION_REQUIRED', 'WORKSPACE_CREDENTIAL_REQUIRED', 'WORKSPACE_CONNECTION_REQUIRED'].includes(error.code)) {
        identityEpoch++;
        await purgeLocalData(true);
        location.reload();
      }
      throw error;
    } finally { ownerRequests--; }
  }
  const needsCsrf = unsafe && path !== '/api/login';
  if (unsafe) _cache.clear();
  if (needsCsrf) await ensureCsrfToken();
  const r = await fetch(path, {
    method,
    credentials: 'same-origin',
    cache: opts.cache || 'no-store',
    headers: {
      ...(opts.headers || {}),
      'x-nv': '1',
      ...(needsCsrf ? { 'x-nv-csrf': csrfToken } : {}),
      ...offlineHeadersForPath(path, method),
      ...(opts.body ? { 'Content-Type': 'application/json' } : {})
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const data = await r.json().catch(() => ({}));
  if (epoch !== identityEpoch) throw new Error('Account changed; reopen the workbench.');
  if (!r.ok) {
    if (allowCsrfRetry && needsCsrf && ['CSRF_REQUIRED', 'CSRF_INVALID', 'CSRF_EXPIRED'].includes(data.code)) {
      clearCsrfToken();
      return api(path, opts, false);
    }
    const error = new Error(data.error || `Request failed (${r.status})`);
    error.status = r.status;
    error.code = data.code || '';
    error.correlationId = data.correlationId || r.headers.get('x-nebulaverse-correlation-id') || '';
    error.providerChanged = data.providerChanged || 'unknown';
    error.safeState = data.safeState || '';
    error.nextAction = data.nextAction || '';
    error.safePassage = data.safePassage && typeof data.safePassage === 'object' ? data.safePassage : null;
    if (error.code === 'BRANCH_CHANGED' && state.work) {
      queueMicrotask(() => refreshRepoMetadata().catch(() => {}));
    }
    if (['ALPHA_SESSION_EXPIRED', 'ALPHA_ACCESS_REVOKED'].includes(error.code)) {
      await purgeLocalData(true);
      broadcastIdentityBoundary();
      alphaBootStarted = false;
      window.NebulaAlphaUI.showExpired(error.code);
      _page = 'alpha-access';
    }
    throw error;
  }
  if (/^\/api\/(?:login|logout|accounts\/(?:switch|switch-idx|remove))$/.test(path)) clearCsrfToken();
  return data;
}
async function apiCached(path, ttl = 45000) {
  const hit = _cache.get(path);
  if (hit && Date.now() - hit.t < ttl) return hit.d;
  const d = await api(path);
  _cache.set(path, { d, t: Date.now() });
  return d;
}

async function requestStepUp(action, scope, label = 'sensitive action') {
  if (!state.me || !state.me.login) throw new Error('Sign in before authorizing a sensitive action');
  const tokenMethod = (state.me.authMethod || 'token') === 'token';
  const login = state.me.login;
  const ok = await modal({
    title: 'Verify sensitive action',
    danger: true,
    okText: 'Authorize once',
    bodyHTML: `<p style="font-size:.9rem;line-height:1.6"><b>${esc(label)}</b> requires a short-lived, single-use authorization bound to this exact operation.</p>
      <label class="field-label" for="stepUpLogin">Type the active account login <b class="mono">${esc(login)}</b></label>
      <input id="stepUpLogin" type="text" autocomplete="off" spellcheck="false">
      ${tokenMethod ? `<label class="field-label" for="stepUpCredential">Re-enter the current provider token</label><input id="stepUpCredential" type="password" autocomplete="off" spellcheck="false">` : `<p class="hint">Your OAuth authorization will be revalidated with the provider. The grant expires in five minutes and can be used only once.</p>`}`
  });
  if (!ok) return '';
  const loginInput = $('#stepUpLogin');
  const credentialInput = tokenMethod ? $('#stepUpCredential') : null;
  const confirm = (loginInput ? loginInput.value : '').trim();
  const credential = credentialInput ? credentialInput.value.trim() : '';
  if (loginInput) loginInput.value = '';
  if (credentialInput) credentialInput.value = '';
  const result = await api('/api/security/step-up', {
    method: 'POST', body: { action, scope, confirm, ...(tokenMethod ? { credential } : {}) }
  });
  return result.grant || '';
}
async function stepUpApi(action, scope, path, opts = {}, label) {
  const grant = await requestStepUp(action, scope, label);
  if (!grant) return null;
  return api(path, {
    ...opts,
    headers: { ...(opts.headers || {}), 'x-nv-step-up': grant }
  });
}

/* ---------------- toasts ---------------- */
function hapt(ms = 8) { try { if (navigator.vibrate) navigator.vibrate(ms); } catch {} }
function escAttr(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[ch]);
}
function safeHexColor(value, fallback = '8a8fa8') {
  const color = String(value || '').replace(/^#/, '');
  return /^[0-9a-f]{6}$/i.test(color) ? color : fallback;
}
const TOAST_TONE = { ok: 'Success', err: 'Error' };
/*
 * A segmented control is a set of choices, and which one is chosen was carried
 * only by an .active class -- visible, but silent. Selection moves through
 * here so the class and the announced state cannot drift apart at any of the
 * places that repaint one.
 */
/*
 * The pulse reports what this session actually loaded. Each measure names its
 * own source, and a measure without one is not rendered: the design shows a
 * trust score, and nothing in this product computes one yet, so that tile is
 * absent rather than invented.
 */
function renderGalaxyPulse(repos) {
  const section = $('#reposPulse');
  const grid = $('#reposPulseGrid');
  if (!section || !grid) return;
  const list = Array.isArray(repos) ? repos : [];
  const languages = new Set(list.map(r => r && r.language).filter(Boolean));
  const measures = [
    { label: 'Galaxies online', value: list.length, note: list.length === 1 ? 'connected system' : 'connected systems' },
    { label: 'Private', value: list.filter(r => r && r.private).length, note: 'of the connected set' },
    { label: 'Languages', value: languages.size, note: languages.size === 1 ? 'in use' : 'across the set' }
  ].filter(measure => Number.isFinite(measure.value));
  grid.innerHTML = '';
  for (const measure of measures) {
    const cell = document.createElement('div');
    cell.className = 'gx-pulse-cell';
    const dt = document.createElement('dt');
    dt.textContent = measure.label;
    const dd = document.createElement('dd');
    const value = document.createElement('span');
    value.className = 'gx-pulse-value';
    value.textContent = String(measure.value);
    const note = document.createElement('span');
    note.className = 'gx-pulse-note';
    note.textContent = measure.note;
    dd.append(value, note);
    cell.append(dt, dd);
    grid.appendChild(cell);
  }
  section.hidden = measures.length === 0;
}

function selectSegment(groupSelector, isChosen) {
  $$(`${groupSelector} .seg-btn`).forEach((button, index) => {
    const chosen = !!isChosen(button, index);
    button.classList.toggle('active', chosen);
    button.setAttribute('aria-checked', String(chosen));
  });
}

function toast(msg, kind = '') {
  if (kind === 'ok') hapt(10);
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  /*
   * Outcome was carried by colour alone: a reader saw green or red, and anyone
   * listening heard only the message. The tone is announced now, as text
   * placed before it and hidden visually, so the same distinction reaches both
   * without changing what the toast looks like.
   */
  const tone = TOAST_TONE[kind];
  if (tone) {
    const label = document.createElement('span');
    label.className = 'sr-only';
    label.textContent = `${tone}: `;
    el.appendChild(label);
  }
  el.appendChild(document.createTextNode(msg));
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .4s'; setTimeout(() => el.remove(), 400); }, 3600);
}
function presentError(error) {
  return window.NebulaTrustUI.presentError(error || new Error('The request could not be completed.'));
}

/*
 * Safe Passage.
 *
 * A write refused because it needs approval comes back with the route to
 * approval attached: a branch derived from the change, and a pull request into
 * the branch that refused it. The server has already checked that policy
 * permits every step, so taking the route uses the ordinary governed endpoints
 * -- there is no separate privileged path to take, which is the point.
 *
 * It is offered, never taken automatically, and the content sent is the same
 * content that was refused.
 */
async function takeSafePassage(error, change) {
  const offer = error && error.safePassage;
  if (!offer || offer.available !== true || !change || typeof change.content !== 'string') return false;
  if (!state.work) return false;

  const accepted = await modal({
    title: 'This change needs approval',
    okText: 'Send for review',
    bodyHTML: `<p class="sp-lead">Writing <b class="mono">${esc(offer.path)}</b> to
        <b class="mono">${esc(offer.baseBranch)}</b> needs approval under the active policy, so it was not committed.</p>
      <p class="sp-lead">Your change can go to a branch of its own and open a pull request for review instead. Nothing is
        changed on <b class="mono">${esc(offer.baseBranch)}</b> until someone approves it.</p>
      <ul class="sp-route">
        <li><span class="sp-step">Branch</span><span class="mono">${esc(offer.branch)}</span></li>
        <li><span class="sp-step">Commit</span><span class="mono">${esc(offer.path)}</span></li>
        <li><span class="sp-step">Pull request</span><span class="mono">${esc(offer.branch)} \u2192 ${esc(offer.baseBranch)}</span></li>
      </ul>
      <p class="hint">The content sent is exactly what you tried to commit.</p>`
  });
  if (!accepted) return false;

  const message = String(change.message || '').trim() || `Update ${offer.path}`;
  try {
    await api(`/api/repo/${wPath()}/branches`, {
      method: 'POST', body: { name: offer.branch, from: offer.baseBranch }
    });
  } catch (branchError) {
    /* The branch already existing is the expected shape of a second attempt at
     * the same change, and is not a failure. */
    if (branchError.status !== 422 && branchError.code !== 'BRANCH_EXISTS') {
      presentError(branchError);
      return true;
    }
  }
  try {
    const written = await api(`/api/repo/${wPath()}/file`, {
      method: 'PUT',
      body: { path: offer.path, content: change.content, message, branch: offer.branch, sha: change.sha }
    });
    const pull = await api(`/api/repo/${wPath()}/pulls`, {
      method: 'POST',
      body: {
        title: message,
        head: offer.branch,
        base: offer.baseBranch,
        body: `Opened by Safe Passage. Writing \`${offer.path}\` to \`${offer.baseBranch}\` requires approval under the active policy, so the change is proposed here for review instead.`
      }
    });
    toast(pull && pull.number ? `Opened pull request #${pull.number} \u2726` : 'Sent for review \u2726', 'ok');
    return { written, pull };
  } catch (routeError) {
    presentError(routeError);
    return true;
  }
}

/* ---------------- modal ---------------- */
let modalResolve = null;
let modalReturnFocus = null;
function modal({ title, bodyHTML, okText = 'Confirm', danger = false, onOpen = null }) {
  return new Promise(resolve => {
    modalResolve = resolve;
    modalReturnFocus = document.activeElement;
    $('#modalTitle').textContent = title;
    $('#modalBody').innerHTML = bodyHTML;
    const ok = $('#modalOk');
    ok.textContent = okText;
    ok.classList.toggle('danger', danger);
    $('#scrim').hidden = false;
    if (typeof onOpen === 'function') onOpen($('#modalBody'));
    const fi = $('#modalBody input:not([disabled]), #modalBody textarea:not([disabled]), #modalBody select:not([disabled])');
    const initialFocus = fi || $('#modalCancel');
    if (initialFocus) setTimeout(() => {
      const scrim = $('#scrim');
      if (!scrim.hidden && !scrim.contains(document.activeElement)) initialFocus.focus();
    }, 60);
  });
}
function closeModal(v) {
  $('#scrim').hidden = true;
  if (modalResolve) { modalResolve(v); modalResolve = null; }
  const restore = modalReturnFocus;
  modalReturnFocus = null;
  if (restore && restore.isConnected && typeof restore.focus === 'function') requestAnimationFrame(() => restore.focus());
}
$('#modalOk').addEventListener('click', () => closeModal(true));
$('#modalCancel').addEventListener('click', () => closeModal(false));
$('#scrim').addEventListener('click', e => { if (e.target === $('#scrim')) closeModal(false); });

/* ---------------- pages ---------------- */
let _page = 'alpha-access';
function withTransition(fn) {
  if (document.startViewTransition && state.settings.motion &&
      !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    document.startViewTransition(fn);
  } else fn();
}
function measureTopbar() {
  requestAnimationFrame(() => {
    const bar = document.querySelector('.page.active .topbar');
    if (bar) document.documentElement.style.setProperty('--tbh', bar.offsetHeight + 'px');
  });
}
window.addEventListener('resize', measureTopbar);
window.addEventListener('orientationchange', measureTopbar);
/*
 * The sidebar's collapsed state. Remembered per reader, because a rail width
 * is a working preference rather than a per-visit decision, and restored
 * before the first paint of any authenticated screen so it does not visibly
 * snap narrower a moment after arriving.
 */
function setRailCollapsed(collapsed) {
  document.body.dataset.rail = collapsed ? 'collapsed' : 'expanded';
  const toggle = $('#railCollapse');
  if (toggle) {
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', collapsed ? 'Expand the sidebar' : 'Collapse the sidebar');
  }
  /*
   * Collapsed entries show only their mark, so the name has to survive
   * somewhere a pointer can reach it as well as in the accessibility tree.
   */
  $$('.nv-rail-item').forEach(item => {
    const name = (item.querySelector('.nv-rail-t') || {}).textContent || '';
    if (collapsed) item.title = name.trim();
    else item.removeAttribute('title');
  });
  try { localStorage.setItem('nv_rail_collapsed', collapsed ? '1' : '0'); } catch {}
}

$('#railCollapse') && $('#railCollapse').addEventListener('click', () => {
  setRailCollapsed(document.body.dataset.rail !== 'collapsed');
});

(function restoreRailPreference() {
  let collapsed = false;
  try { collapsed = localStorage.getItem('nv_rail_collapsed') === '1'; } catch {}
  setRailCollapsed(collapsed);
})();

/*
 * The floating action is not one button that always opens the palette. Each
 * screen has a different next thing a reader reaches for, and below the
 * breakpoint the top bar has no room to offer it -- so the action carries
 * whatever that screen's is, and says so in its own name.
 */
/*
 * The floating action carries the controls this screen could not place.
 *
 * Not a written list. The top bar drops controls below the breakpoint for want
 * of room -- they are marked as dropped in the markup -- and those are exactly
 * the controls that then have nowhere to be. Reading them off the bar means
 * the dock cannot fall out of step with it: a control that stops fitting turns
 * up here without anyone remembering to add it, and one that finds a place of
 * its own stops being offered here without anyone remembering to remove it.
 *
 * Which is why it is empty on the overview and the inventory. Those bars drop
 * nothing a reader cannot otherwise reach, so there is nothing for a floating
 * menu to solve, and a menu that repeats the screen behind it is worse than no
 * menu at all. The workbench drops two, and gets a dock with two entries.
 */
const DOCK_LABELS = Object.freeze({ overview: 'Overview actions', repos: 'Repository actions', work: 'Workspace actions' });

function accessibleName(control) {
  return (control.getAttribute('aria-label') || control.textContent || '').replace(/\s+/g, ' ').trim();
}

function placedElsewhere(page, control, name) {
  /*
   * Same action, somewhere a thumb can already reach. The inventory's bar
   * drops "Sign out" and the inventory's own body offers it as a full-width
   * control, so it is placed -- just not in the bar.
   */
  return [...page.querySelectorAll('button, a[href]')].some(other => other !== control
    && !control.contains(other)
    && other.offsetParent !== null
    && accessibleName(other) === name);
}

function floatingActionsFor(name) {
  const page = $('#page-' + name);
  if (!page) return null;
  const bar = page.querySelector('.topbar');
  if (!bar) return null;
  const dropped = [...bar.querySelectorAll('button.hide-sm')]
    .map(control => ({ control, label: accessibleName(control) }))
    .filter(entry => entry.label && !placedElsewhere(page, entry.control, entry.label));
  if (!dropped.length) return null;
  return { label: DOCK_LABELS[name] || 'Actions', items: dropped };
}

function closeFloatingActions({ restoreFocus = true } = {}) {
  const fab = $('#paletteFab');
  const menu = $('#fabMenu');
  if (!fab || !menu || menu.hidden) return;
  menu.hidden = true;
  fab.setAttribute('aria-expanded', 'false');
  if (restoreFocus && fab.offsetParent !== null) fab.focus();
}

function openFloatingActions() {
  const fab = $('#paletteFab');
  const menu = $('#fabMenu');
  if (!fab || !menu) return;
  menu.hidden = false;
  fab.setAttribute('aria-expanded', 'true');
  /* Whatever the page was doing, the control stays while its menu is open. */
  setFloatingActionRetracted(false);
  const first = menu.querySelector('.nv-fab-item:not([hidden])');
  if (first) first.focus();
}

/*
 * The floating action steps aside while the reader moves down the page.
 *
 * It is anchored above the bottom navigation, which on a narrow screen puts it
 * over whatever sits in the lower right -- the intelligence-mode grid, among
 * others. A floating control overlays content by definition, but standing on a
 * destination while someone is trying to reach it is not the bargain: it holds
 * the controls the top bar had no room for, and that does not require it to be
 * in front of them at every moment.
 *
 * Down the page is reading, so it withdraws. Back up the page is looking for
 * something, so it returns -- as it does near the top, and whenever its own
 * menu is open, and whenever it takes focus. That last one matters most: a
 * control that is focusable while invisible sends the keyboard somewhere the
 * reader cannot see, so the CSS restores it on :focus-within rather than
 * leaving that to a listener that might not run.
 */
let _fabScrollY = 0;

function setFloatingActionRetracted(retracted) {
  const dock = $('.nv-fab-dock');
  if (dock) dock.dataset.retracted = retracted ? 'true' : 'false';
}

function paintFloatingActionRetraction() {
  const dock = $('.nv-fab-dock');
  const fab = $('#paletteFab');
  if (!dock || !fab) return;
  const y = Math.max(0, window.scrollY);
  const open = fab.getAttribute('aria-expanded') === 'true';
  /* A small threshold, so a rubber-band or a one-pixel jitter is not a gesture. */
  const movedDown = y > _fabScrollY + 6;
  const movedUp = y < _fabScrollY - 6;
  if (open || y < 80) setFloatingActionRetracted(false);
  else if (movedDown) setFloatingActionRetracted(true);
  else if (movedUp) setFloatingActionRetracted(false);
  _fabScrollY = y;
}

window.addEventListener('scroll', paintFloatingActionRetraction, { passive: true });

function paintFloatingAction(name) {
  const fab = $('#paletteFab');
  const menu = $('#fabMenu');
  if (!fab || !menu) return;
  closeFloatingActions({ restoreFocus: false });
  menu.innerHTML = '';
  const action = floatingActionsFor(name);
  fab.hidden = !action;
  if (!action) return;
  fab.setAttribute('aria-label', action.label);
  fab.title = action.label;
  fab.setAttribute('aria-expanded', 'false');
  menu.setAttribute('aria-label', action.label);

  for (const item of action.items) {
    const entry = document.createElement('button');
    entry.type = 'button';
    entry.className = 'nv-fab-item';
    /*
     * The gate travels with the control. An action that is refused in the bar
     * and offered here would be an action with no gate at all.
     */
    if (item.control.dataset.feature) entry.dataset.feature = item.control.dataset.feature;
    if (item.control.dataset.allowExperimental) entry.dataset.allowExperimental = item.control.dataset.allowExperimental;
    const mark = item.control.querySelector('svg');
    if (mark) {
      const copy = mark.cloneNode(true);
      copy.setAttribute('class', 'ico');
      copy.removeAttribute('width');
      copy.removeAttribute('height');
      copy.setAttribute('aria-hidden', 'true');
      entry.appendChild(copy);
    }
    const text = document.createElement('span');
    text.textContent = item.label;
    entry.appendChild(text);
    const slot = document.createElement('div');
    slot.className = 'nv-fab-slot';
    slot.appendChild(entry);
    entry.addEventListener('click', () => {
      /*
       * Focus returns to the dock before the action runs, not after. Anything
       * the action opens records what was focused when it opened, and the
       * entry that was pressed is removed with the menu -- so a dialog that
       * restored focus faithfully was handing it to an element that no longer
       * existed, and it landed on the body instead.
       */
      closeFloatingActions();
      item.control.click();
    });
    menu.appendChild(slot);
  }
  fab.dataset.action = name;
  /* Freshly built entries have to be re-read against the session's
     capabilities, or a blocked action arrives looking available. */
  if (window.NebulaCapabilityUI && window.NebulaCapabilityUI.apply) window.NebulaCapabilityUI.apply(menu);
}

$('#paletteFab') && $('#paletteFab').addEventListener('click', () => {
  const menu = $('#fabMenu');
  if (!menu) return;
  if (menu.hidden) openFloatingActions();
  else closeFloatingActions();
});

/*
 * Escape closes it and hands focus back, and a press anywhere outside closes it
 * without stealing focus from wherever the reader chose to go.
 */
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  const menu = $('#fabMenu');
  const fab = $('#paletteFab');
  if (!menu || menu.hidden) return;
  /*
   * Only when the reader is actually in it, and never in the capture phase.
   * Listening first and stopping the event meant that any dialog opened while
   * these actions happened to be showing could no longer be dismissed with
   * Escape: this closed the actions behind it and swallowed the key. Escape
   * belongs to whatever holds focus.
   */
  const active = document.activeElement;
  if (!menu.contains(active) && active !== fab) return;
  closeFloatingActions();
});
document.addEventListener('pointerdown', event => {
  const menu = $('#fabMenu');
  const fab = $('#paletteFab');
  if (!menu || menu.hidden) return;
  if (menu.contains(event.target) || (fab && fab.contains(event.target))) return;
  closeFloatingActions({ restoreFocus: false });
});

/* Which screen owns which piece of the design's artwork. */
const NEBULA_VISUALS = Object.freeze({ overview: ['mark', '#ovCoreArt'], repos: ['galaxy', '#gxHeroArt'] });

function showPage(name) {
  setTimeout(measureTopbar, 30);
  if (_page === name) return;
  _page = name;
  paintRail(name);
  /*
   * Probed on arrival rather than at startup: the answer decides whether a
   * card on this screen exists at all, and asking earlier would spend a
   * request on every load of a deployment that never shows it.
   */
  if (name === 'login') initWorkspaceCard();
  /*
   * Mounted here rather than by each caller. Six paths reach these screens,
   * and a mount attached to one of them would leave the artwork missing from
   * the other five -- the same defect the rail carried when its repaint lived
   * in a click handler.
   */
  const visual = NEBULA_VISUALS[name];
  if (visual) mountNebulaVisual(visual[0], visual[1]);
  withTransition(() => {
    $$('.page').forEach(p => p.classList.remove('active'));
    const shown = $('#page-' + name);
    shown.classList.add('active');
    /*
     * Both, because which one is scrolling depends on the width. Inside the
     * plate the content region is the scroller and the document does not move;
     * below that breakpoint the document is the scroller. Resetting only the
     * window left a desktop reader arriving on a new screen part way down it.
     */
    window.scrollTo(0, 0);
    const region = shown.querySelector('.container');
    if (region) region.scrollTop = 0;
    if (name !== 'work') history.replaceState(null, '', location.pathname);
  });
  /*
   * After the swap has been laid out, not during it.
   *
   * The dock works out which of a screen's controls have nowhere to be by
   * asking what is on screen, so it has to ask once the screen is. Asked
   * before the swap it read the previous screen -- the inventory offered its
   * own bar's "Sign out" because the copy in its body was not up yet, and the
   * workbench offered nothing because the inventory's Settings was still
   * standing in for its own. Asked inside the swap it read a document mid-
   * mutation, with a view transition holding the old frame, and saw nothing at
   * all. Two frames later both are settled.
   */
  requestAnimationFrame(() => requestAnimationFrame(() => {
    paintFloatingAction(name);
  }));
}
function saveRoute() {
  if (ownerWorkbench) return;
  if (_page !== 'work' || !state.work || !state.work.repo) return;
  const h = `#/${encodeURIComponent(state.work.owner)}/${encodeURIComponent(state.work.repo)}` +
    `@${encodeURIComponent(state.work.branch)}/${currentTab()}` +
    (state.file && state.file.path ? '/' + encodeURIComponent(state.file.path) : '');
  history.replaceState(null, '', h);
}
async function restoreRoute() {
  const m = /^#\/([^/]+)\/([^/@]+)@([^/]+)\/([a-z]+)(?:\/(.+))?$/.exec(location.hash);
  if (!m) return false;
  try {
    await openRepo(decodeURIComponent(m[1]), decodeURIComponent(m[2]));
    const br = decodeURIComponent(m[3]);
    if (br && br !== state.work.branch && [...$('#branchSelect').options].some(o => o.value === br)) {
      state.work.branch = br;
      $('#branchSelect').value = br;
      state.fileIndex = null;
      loadTree('', $('#tree'), true);
    }
    if (m[4] && m[4] !== 'editor') switchTab(m[4]);
    if (m[5]) openFile(decodeURIComponent(m[5]));
    return true;
  } catch { return false; }
}

/* ---------------- theme & settings ---------------- */
function loadSettings() {
  try {
    const t = localStorage.getItem('nv_theme');
    if (t) document.documentElement.dataset.theme = t;
    const s = JSON.parse(localStorage.getItem('nv_settings') || 'null');
    if (s) Object.assign(state.settings, s);
    else if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) state.settings.motion = false;
  } catch {}
  applySettings();
}
function applySettings() {
  document.documentElement.style.setProperty('--ed-font', (state.settings.fontSize / 16) + 'rem');
  document.documentElement.style.setProperty('--ed-family', `'${state.settings.editorFont}', ui-monospace, monospace`);
  document.documentElement.dataset.motion = state.settings.motion ? 'on' : 'off';
  const motionOff = !state.settings.motion;
  document.querySelectorAll('.nv-logo svg').forEach(s => {
    try { motionOff ? s.pauseAnimations() : s.unpauseAnimations(); } catch {}
  });
  if (state.cm) {
    state.cm.setOption('lineWrapping', !!state.settings.wrap);
    state.cm.setOption('theme', state.settings.editorTheme);
    state.cm.refresh();
  }
  try { localStorage.setItem('nv_settings', JSON.stringify(state.settings)); } catch {}
}
function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.content = next === 'dark' ? '#070712' : '#e9ecf8';
  try { localStorage.setItem('nv_theme', next); } catch {}
  $$('.theme-toggle').forEach(t => t.setAttribute('aria-checked', String(next === 'dark')));
  /* The artwork has its own palettes; it follows the toggle like everything else. */
  if (window.NebulaVisuals) window.NebulaVisuals.repaint();
}
document.addEventListener('click', e => {
  const t = e.target.closest('.theme-toggle');
  if (t) toggleTheme();
});
$('#settingsBtnRepos').addEventListener('click', openSettings);
$('#settingsBtnOv') && $('#settingsBtnOv').addEventListener('click', openSettings);
$('#settingsBtnWork').addEventListener('click', openSettings);
const ED_THEMES = [
  ['material-ocean', 'Material Ocean'], ['dracula', 'Dracula'], ['monokai', 'Monokai'],
  ['nord', 'Nord'], ['ayu-mirage', 'Ayu Mirage'], ['base16-light', 'Base16 Light'], ['eclipse', 'Eclipse (light)']
];
const ED_FONTS = ['DM Mono', 'JetBrains Mono', 'Fira Code', 'Source Code Pro', 'IBM Plex Mono'];

function githubAppCallbackNotice() {
  const params = new URLSearchParams(location.search);
  const githubAppResult = params.get('githubApp');
  if (!githubAppResult) return;
  const code = params.get('code');
  params.delete('githubApp');
  params.delete('code');
  const query = params.toString();
  history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
  if (githubAppResult === 'connected') {
    toast('GitHub App installation connected securely ✦', 'ok');
  } else {
    const detail = code ? ` (${code.replace(/_/g, ' ').toLowerCase()})` : '';
    toast(`GitHub App connection was not completed${detail}`, 'err');
  }
}

async function loadGithubAppStatus() {
  const configured = state.runtime.githubApp && state.runtime.githubApp.enabled;
  if (!state.me) return { enabled: !!configured, webhookConfigured: false, connections: [] };
  try {
    return await api('/api/github-app/status');
  } catch (error) {
    return { enabled: !!configured, webhookConfigured: false, connections: [], error: error.message };
  }
}

function githubAppRepositoryAccess(connection) {
  return connection.repositorySelection === 'all' ? 'All repositories approved for this installation' : 'Selected repositories only';
}

function renderGithubAppSettings(status) {
  const enabled = !!(status && status.enabled);
  const connections = Array.isArray(status && status.connections) ? status.connections : [];
  if (!enabled) {
    return `<div class="github-app-connection github-app-unavailable">
      <div><b>GitHub App is optional</b><p>It is not configured on this deployment. GitHub PAT, OAuth, GitLab, and Gitea access remain available.</p></div>
    </div>`;
  }
  const currentCanAuthorize = !!(state.me && state.me.provider === 'github' && state.me.authMethod !== 'github-app');
  const connectAction = `<button class="btn btn-ghost small" data-github-app-action="connect" ${currentCanAuthorize ? '' : 'disabled'}>Connect GitHub App</button>`;
  const guide = currentCanAuthorize ? 'GitHub will ask you to authorize your identity and choose repository access.' : 'Switch to a GitHub PAT or OAuth account to authorize or reauthorize an installation.';
  const connectionCards = connections.map(connection => {
    const statusText = connection.status === 'connected' ? 'Healthy' : connection.status || 'Unavailable';
    const verified = connection.lastVerifiedAt ? new Date(connection.lastVerifiedAt).toLocaleString() : 'Not verified yet';
    const installLink = /^https:\/\/github\.com\//i.test(connection.installationUrl || '')
      ? `<a class="btn btn-ghost small" href="${escAttr(connection.installationUrl)}" target="_blank" rel="noopener noreferrer">Manage on GitHub</a>` : '';
    return `<div class="github-app-connection" data-installation-id="${Number(connection.installationId)}">
      <div class="github-app-connection-head">
        <div class="github-app-identity">
          ${connection.avatar ? `<img class="avatar" src="${escAttr(connection.avatar)}" alt="">` : ''}
          <div><b>${esc(connection.accountLogin || 'GitHub installation')}</b><span>${esc(connection.accountType || 'Account')} · Installation #${Number(connection.installationId)}</span></div>
        </div>
        <span class="github-app-health ${connection.status === 'connected' ? 'healthy' : 'warning'}">${esc(statusText)}</span>
      </div>
      <dl class="github-app-meta">
        <div><dt>Repository access</dt><dd>${esc(githubAppRepositoryAccess(connection))}</dd></div>
        <div><dt>Authorized by</dt><dd>${esc(connection.authorizedByLogin || 'Unknown')}</dd></div>
        <div><dt>Last verified</dt><dd>${esc(verified)}</dd></div>
      </dl>
      <div class="github-app-actions">
        <button class="btn btn-ghost small" data-github-app-action="refresh" data-installation-id="${Number(connection.installationId)}">Refresh health</button>
        <button class="btn btn-ghost small" data-github-app-action="reauthorize" ${currentCanAuthorize ? '' : 'disabled'}>Reauthorize</button>
        ${installLink}
        <button class="btn btn-ghost small danger" data-github-app-action="disconnect" data-installation-id="${Number(connection.installationId)}">Disconnect</button>
      </div>
    </div>`;
  }).join('');
  return `${status && status.error ? `<p class="hint github-app-error">⚠ ${esc(status.error)}</p>` : ''}
    ${connectionCards || `<div class="github-app-connection github-app-empty"><div><b>No installation connected</b><p>${esc(guide)}</p></div>${connectAction}</div>`}
    ${connectionCards ? `<p class="hint github-app-guide">${esc(guide)}</p>${currentCanAuthorize ? connectAction : ''}` : ''}`;
}

async function reloadGithubAppSettings() {
  const body = $('#githubAppSettingsBody');
  if (!body) return;
  body.innerHTML = '<div class="skeleton" style="height:72px"></div>';
  const status = await loadGithubAppStatus();
  if (body) body.innerHTML = renderGithubAppSettings(status);
}

async function beginGithubAppConnection() {
  const result = await api('/api/github-app/connect', { method: 'POST', body: {} });
  if (!result.url || !/^https:\/\/github\.com\//i.test(result.url)) throw new Error('GitHub returned an invalid authorization destination');
  location.assign(result.url);
}

document.addEventListener('click', async event => {
  const button = event.target.closest('[data-github-app-action]');
  if (!button || button.disabled) return;
  const action = button.dataset.githubAppAction;
  const installationId = Number(button.dataset.installationId || 0);
  button.disabled = true;
  try {
    if (action === 'connect' || action === 'reauthorize') {
      button.textContent = 'Opening GitHub…';
      await beginGithubAppConnection();
      return;
    }
    if (action === 'refresh') {
      button.textContent = 'Checking…';
      await api('/api/github-app/refresh', { method: 'POST', body: { installationId } });
      toast('GitHub App installation health refreshed ✦', 'ok');
      await reloadGithubAppSettings();
      return;
    }
    if (action === 'disconnect') {
      if (!window.confirm('Disconnect this GitHub App installation from Nebulaverse-X? This does not uninstall it from GitHub.')) return;
      const result = await api('/api/github-app/disconnect', { method: 'POST', body: { installationId } });
      await purgeLocalData(!!result.empty);
      broadcastIdentityBoundary();
      toast('GitHub App installation disconnected ✦', 'ok');
      if (result.empty) {
        state.me = null;
        closeModal(false);
        showPage('login');
      } else {
        try {
          state.me = await api('/api/me');
          state.caps = state.me.caps || null;
          applyCaps();
          setAvatar(state.me.avatar);
        } catch {}
        await reloadGithubAppSettings();
      }
    }
  } catch (error) {
    presentError(error);
  } finally {
    if (document.contains(button)) {
      button.disabled = false;
      if (action === 'refresh') button.textContent = 'Refresh health';
      if (action === 'connect') button.textContent = 'Connect GitHub App';
      if (action === 'reauthorize') button.textContent = 'Reauthorize';
    }
  }
});
async function openSettings() {
  const githubAppStatus = await loadGithubAppStatus();
  setTimeout(() => {
    const cb = $('#clearLocalBtn');
    if (cb) cb.addEventListener('click', async () => {
      await purgeLocalData(true);
      toast('Offline caches and queued commits cleared ✦', 'ok');
    });
  }, 60);
  const s = state.settings;
  const dark = document.documentElement.dataset.theme === 'dark';
  await modal({
    title: 'Settings',
    okText: 'Done',
    bodyHTML: `
      <div class="set-row"><span>Interface theme</span>
        <button class="theme-toggle" type="button" role="switch" aria-checked="${dark}" aria-label="Toggle dark or light theme">
          <svg class="tt-ico tt-sun" width="14" height="14" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.2v2.4M12 19.4v2.4M21.8 12h-2.4M4.6 12H2.2M18.9 5.1l-1.7 1.7M6.8 17.2l-1.7 1.7M18.9 18.9l-1.7-1.7M6.8 6.8L5.1 5.1"/></svg>
          <svg class="tt-ico tt-moon" width="14" height="14" viewBox="0 0 24 24"><path d="M20 13.2A8 8 0 1 1 10.8 4a6.4 6.4 0 0 0 9.2 9.2z"/></svg>
          <span class="tt-knob"></span>
        </button>
      </div>
      <label class="field-label" for="setEdTheme">Editor theme</label>
      <select id="setEdTheme">${ED_THEMES.map(([v, l]) => `<option value="${v}" ${v === s.editorTheme ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <label class="field-label" for="setEdFont">Editor font</label>
      <select id="setEdFont">${ED_FONTS.map(f => `<option ${f === s.editorFont ? 'selected' : ''}>${f}</option>`).join('')}</select>
      <label class="field-label" for="setFs">Editor font size — <span id="setFsVal">${s.fontSize}px</span></label>
      <input type="range" min="11" max="20" value="${s.fontSize}" id="setFs" style="min-height:32px;padding:0">
      <label class="check"><input type="checkbox" id="setWrap" ${s.wrap ? 'checked' : ''}> Wrap long lines in editor</label>
      <label class="check"><input type="checkbox" id="setMotion" ${s.motion ? 'checked' : ''}> Animated nebula background</label>
      ${state.work ? `<label class="check"><input type="checkbox" id="setOfflineRepo" ${isOfflineRepoEnabled() ? 'checked' : ''}> Enable offline access for this repository</label>
      <p class="hint" style="margin:0 0 10px">Opt-in only. Small text/JSON views are cached for 24 hours in an account/session-isolated cache; raw files, ZIPs, notifications and security data remain network-only.</p>` : ''}
      <div class="set-group github-app-panel">
        <div class="set-label">GitHub App <span class="br-tag">optional</span></div>
        <p class="hint">Use short-lived installation credentials with repository-scoped access. Existing PAT and OAuth connections continue to work.</p>
        <div id="githubAppSettingsBody">${renderGithubAppSettings(githubAppStatus)}</div>
      </div>
      ${$('#alphaPrivacyActions').innerHTML}
      <div class="set-group">
        <div class="set-label">About</div>
        <p class="hint" style="margin:4px 0 8px">Nebulaverse-X — GitHub · GitLab · Gitea from your pocket.</p>
        <div class="about-actions">
          <a class="btn btn-ghost small" href="https://t.me/MonteCristo_X" target="_blank" rel="noopener noreferrer">
            <svg class="ico" width="15" height="15" viewBox="0 0 24 24"><path d="M21.5 3.6L2.9 10.8c-1 .4-1 1.4.1 1.7l4.6 1.5 1.8 5.5c.3.9 1 .9 1.5.3l2.5-2.4 4.7 3.5c.8.5 1.5.2 1.7-.8l3-15.1c.3-1.2-.5-1.8-1.3-1.4z"/></svg>
            Support &amp; feedback — Telegram
          </a>
          <button class="btn btn-ghost small" id="clearLocalBtn">Clear offline data</button>
        </div>
      </div>`
  });
  applySettings();
}

function alphaRevocationGuidanceBody(guidance) {
  const items = (Array.isArray(guidance) ? guidance : [])
    .filter(item => item && /^https:\/\//i.test(String(item.url || '')))
    .map(item => `<a class="btn btn-ghost small" href="${escAttr(item.url)}" target="_blank" rel="noopener noreferrer">${esc(item.label || 'Open provider settings')}</a>`)
    .join('');
  return `<p class="hint">Nebulaverse-X removed its token-bearing provider state. Provider revocation is a separate action and is never claimed automatically.</p>
    <div class="about-actions">${items || '<span class="hint">No provider revocation link was returned.</span>'}</div>`;
}

async function disconnectAlphaProviders(openGuidance) {
  const result = await api('/api/alpha/providers/disconnect-all', { method: 'POST', body: {} });
  if (result && result.ok === false && result.status === 'pending') {
    toast('Provider cleanup is pending. Keep this session open and retry shortly.');
    return;
  }
  await purgeLocalData(true);
  broadcastIdentityBoundary();
  ensureAlphaProviderGuidance();
  ensureLoginAlphaSessionControls();
  showPage('login');
  if (openGuidance) {
    await modal({
      title: 'Revoke at provider',
      okText: 'Done',
      bodyHTML: alphaRevocationGuidanceBody(result.revocationGuidance)
    });
  } else {
    toast('Disconnected from Nebulaverse-X. Provider credentials were not claimed as revoked.', 'ok');
  }
}

async function deleteAlphaData() {
  const accepted = await modal({
    title: 'Delete alpha data',
    okText: 'Delete alpha data',
    danger: true,
    bodyHTML: `<p class="hint">This fails closed until provider cleanup is verified. Type <span class="mono">DELETE ALPHA DATA</span> to continue.</p>
      <input id="alphaDeleteConfirm" type="text" autocomplete="off" spellcheck="false" aria-label="Deletion confirmation">`
  });
  if (!accepted) return;
  const confirmation = String($('#alphaDeleteConfirm') && $('#alphaDeleteConfirm').value || '');
  if (confirmation !== 'DELETE ALPHA DATA') {
    toast('Type DELETE ALPHA DATA exactly to confirm deletion.', 'err');
    return;
  }
  const result = await api('/api/alpha/delete', {
    method: 'POST',
    body: { confirm: 'DELETE ALPHA DATA' }
  });
  if (result && result.ok === false && result.status === 'pending') {
    toast('Alpha data deletion is pending provider cleanup. Keep this session open and retry shortly.');
    return;
  }
  await purgeLocalData(true);
  broadcastIdentityBoundary();
  showPage('login');
  toast('Alpha data deletion completed ✦', 'ok');
}

document.addEventListener('click', async event => {
  const button = event.target.closest('[data-alpha-privacy-action]');
  if (!button || button.disabled) return;
  const action = button.dataset.alphaPrivacyAction;
  button.disabled = true;
  closeModal(false);
  try {
    if (action === 'disconnect') await disconnectAlphaProviders(false);
    if (action === 'revoke') await disconnectAlphaProviders(true);
    if (action === 'end') {
      await api('/api/alpha/end', { method: 'POST', body: {} });
      await purgeLocalData(true);
      broadcastIdentityBoundary();
      showPage('login');
      toast('Alpha session ended ✦', 'ok');
    }
    if (action === 'delete') await deleteAlphaData();
  } catch (error) {
    presentError(error);
  } finally {
    if (document.contains(button)) button.disabled = false;
  }
});
document.addEventListener('input', e => {
  if (e.target.id === 'setFs') {
    state.settings.fontSize = +e.target.value;
    const v = $('#setFsVal'); if (v) v.textContent = e.target.value + 'px';
    applySettings();
  }
});
document.addEventListener('change', async e => {
  if (e.target.id === 'setWrap') { state.settings.wrap = e.target.checked; applySettings(); }
  if (e.target.id === 'setMotion') { state.settings.motion = e.target.checked; applySettings(); }
  if (e.target.id === 'setEdTheme') { state.settings.editorTheme = e.target.value; applySettings(); }
  if (e.target.id === 'setEdFont') { state.settings.editorFont = e.target.value; applySettings(); }
  if (e.target.id === 'setOfflineRepo') {
    try {
      await setOfflineRepoEnabled(e.target.checked);
      toast(e.target.checked ? 'Offline access enabled for this repository ✦' : 'Offline repository cache removed ✦', 'ok');
    } catch (error) { e.target.checked = !e.target.checked; toast(error.message, 'err'); }
  }
});

/* ---------------- cursor spotlight (desktop only) ---------------- */
(function () {
  if (!window.matchMedia('(hover:hover) and (pointer:fine)').matches) return;
  function attach(card) {
    if (card.dataset.spot) return;
    card.dataset.spot = '1';
    card.addEventListener('mousemove', e => {
      const r = card.getBoundingClientRect();
      card.style.setProperty('--mx', ((e.clientX - r.left) / r.width * 100).toFixed(1) + '%');
      card.style.setProperty('--my', ((e.clientY - r.top) / r.height * 100).toFixed(1) + '%');
    });
    card.addEventListener('mouseleave', () => { card.style.setProperty('--mx', '50%'); card.style.setProperty('--my', '0%'); });
  }
  $$('.card').forEach(attach);
  new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => {
    if (n.nodeType === 1) {
      if (n.matches && n.matches('.card')) attach(n);
      if (n.querySelectorAll) n.querySelectorAll('.card').forEach(attach);
    }
  }))).observe(document.body, { childList: true, subtree: true });
})();

/* ================= AUTH ================= */
let loginProvider = 'github';
function ensureAlphaProviderGuidance() {
  const card = document.querySelector('.login-card');
  if (!card) return null;
  let panel = $('#alphaProviderGuidance');
  if (!panel) {
    panel = document.createElement('section');
    panel.id = 'alphaProviderGuidance';
    panel.className = 'set-group alpha-provider-guidance';
    const heading = document.createElement('h2');
    heading.textContent = 'Provider permission review';
    const copy = document.createElement('p');
    copy.className = 'hint';
    panel.append(heading, copy);
    card.insertBefore(panel, $('#loginError'));
  }
  const copy = panel.querySelector('p');
  copy.textContent = loginProvider === 'github'
    ? 'Prefer a GitHub App limited to selected repositories. If a token is required, use a short-lived sandbox credential with only the permissions needed for this test; never use a production repository.'
    : `Use a short-lived ${loginProvider === 'gitlab' ? 'GitLab' : 'Gitea'} sandbox credential with only the permissions needed for the advertised capability subset; never use a production repository.`;
  return panel;
}
function ensureLoginAlphaSessionControls() {
  const card = document.querySelector('.login-card');
  if (!card) return null;
  let controls = $('#loginAlphaSessionControls');
  if (controls) return controls;
  controls = document.createElement('section');
  controls.id = 'loginAlphaSessionControls';
  controls.className = 'set-group alpha-privacy-panel';
  const heading = document.createElement('h2');
  heading.textContent = 'Alpha session';
  const copy = document.createElement('p');
  copy.className = 'hint';
  copy.textContent = 'Provider access is separate from the controlled alpha session.';
  const end = document.createElement('button');
  end.type = 'button';
  end.className = 'btn btn-ghost btn-block';
  end.dataset.alphaPrivacyAction = 'end';
  end.textContent = 'End alpha session';
  controls.append(heading, copy, end);
  card.appendChild(controls);
  return controls;
}
$('#provSeg').addEventListener('click', e => {
  const b = e.target.closest('.seg-btn'); if (!b) return;
  selectSegment('#provSeg', x => x === b);
  loginProvider = b.dataset.v;
  $('#oauthBtn').hidden = loginProvider !== 'github' || !window._oauthOn;
  $('#baseUrlWrap').hidden = loginProvider === 'github';
  $('#baseUrl').placeholder = loginProvider === 'gitea' ? 'https://gitea.example.com' : 'https://gitlab.com (default)';
  $('#tokenLabel').textContent = { github: 'GitHub Personal Access Token', gitlab: 'GitLab Personal Access Token (api scope)', gitea: 'Gitea Access Token' }[loginProvider];
  $('#tokenInput').placeholder = { github: 'ghp_…', gitlab: 'glpat-…', gitea: 'token…' }[loginProvider];
  $('#loginHint').innerHTML = {
    github: 'Create one at <span class="mono">github.com → Settings → Developer settings → Tokens (classic)</span> with the <span class="mono">repo</span> scope.',
    gitlab: 'Create one at <span class="mono">GitLab → Preferences → Access tokens</span> with the <span class="mono">api</span> scope. Works with gitlab.com or your self-hosted server.',
    gitea: 'Create one at <span class="mono">your Gitea → Settings → Applications → Generate token</span>. Enter your server URL above.'
  }[loginProvider] + ' Sealed in an encrypted httpOnly cookie — never stored in the browser, never logged.';
  ensureAlphaProviderGuidance();
});

/* ---------------- owner workspace ---------------- */
/*
 * The card is the only way in to the personal-workspace foundation. It stays
 * hidden unless the server reports the foundation enabled, so a deployment
 * with it switched off -- which is every deployment today -- shows exactly the
 * login screen it showed before.
 */
function workspaceInputs() {
  return {
    provider: $('#workspaceProvider').value,
    baseUrl: $('#workspaceBaseUrl').value,
    token: $('#workspaceToken').value
  };
}
/*
 * Prefixed, and not decoratively. The cohort login on this same screen labels
 * its own field "GitHub Personal Access Token"; two controls sharing one
 * accessible name is ambiguous to a screen reader and to anything that selects
 * by name. Twenty end-to-end cases resolved to both at once before this.
 */
const WORKSPACE_TOKEN_LABEL = {
  github: 'Owner GitHub Personal Access Token',
  gitlab: 'Owner GitLab Personal Access Token (api scope)',
  gitea: 'Owner Gitea Access Token'
};
$('#workspaceProvider').addEventListener('change', () => {
  const provider = $('#workspaceProvider').value;
  /*
   * Gitea has no hosted default, so its server URL is required rather than
   * optional -- the server refuses a gitea request that resolves to no base.
   */
  $('#workspaceBaseUrlWrap').hidden = provider === 'github';
  $('#workspaceBaseUrl').placeholder = provider === 'gitea'
    ? 'https://gitea.example.com' : 'https://gitlab.com (default)';
  $('#workspaceTokenLabel').textContent = WORKSPACE_TOKEN_LABEL[provider];
});
/*
 * The invitation gate takes the whole screen, so an owner on an invite
 * deployment never reaches the login page the card normally lives on. The card
 * is hosted on whichever screen is showing rather than duplicated onto both:
 * one element, one set of handlers, no second copy to drift.
 *
 * The workspace routes were always outside the invitation boundary on the
 * server -- they mount ahead of it -- so hosting the card here widens no
 * authorization. It only lets an owner reach an entry point that was already
 * open to them.
 */
function workspaceCardHost() {
  const gate = $('#page-alpha-access');
  if (gate && gate.classList.contains('active')) return gate;
  return document.querySelector('#page-login .login-wrap');
}
function renderWorkspaceCard() {
  const card = $('#workspaceCard');
  if (!card || !window.NebulaWorkspaceUI) return;
  const ws = window.NebulaWorkspaceUI.current();
  card.hidden = ws.available !== true && !ws.outcomeUnknown;
  if (card.hidden) return;
  const host = workspaceCardHost();
  const onGate = host === $('#page-alpha-access');
  if (host && card.parentElement !== host) host.appendChild(card);
  card.classList.toggle('workspace-card-gate', onGate);
  const sessionUnavailable = ws.available !== true;
  $('#workspaceCardNote').textContent = sessionUnavailable
    ? 'Owner session status is unavailable. Reload to check again.' : onGate
    ? 'Own this deployment? Sign in as the owner. No invitation is needed for this.'
    : 'Sign in as the owner of this deployment using the provider and token above.';
  $('#workspaceSignedIn').hidden = !ws.authenticated;
  $('#workspaceSignedOut').hidden = ws.authenticated || sessionUnavailable;
  $('#workspaceCardNote').hidden = ws.authenticated;
  $('#workspaceCredentials').hidden = ws.authenticated || sessionUnavailable;
  if (ws.authenticated && ws.context) {
    const connection = ws.context.connection;
    $('#workspaceIdentity').textContent = connection
      ? `Signed in as workspace owner, using ${connection.login} on ${connection.provider}.`
      : 'Signed in as workspace owner. No Git connection is selected yet.';
    /*
     * Stated only where it is the reader's immediate problem. On the gate they
     * have just signed in and are looking at a screen that still asks for an
     * invitation, and the honest answer is that repository routes have not
     * adopted workspace authority yet.
     */
    const note = $('#workspaceScopeNote');
    note.hidden = !onGate;
    note.textContent = onGate
      ? 'Select a GitHub connection below, then open the owner workbench. Repository creation is experimental; browsing and ordinary text commits are connected.'
      : '';
  }
}
function showWorkspaceError(error) {
  const box = $('#workspaceError');
  if (!box) return;
  /*
   * The module already turns a code into a sentence. Anything without one is
   * a transport fault, and is reported as such rather than as a refusal --
   * the two mean very different things to whoever is reading the screen.
   */
  box.textContent = error && error.code
    ? window.NebulaWorkspaceUI.explain(error.code)
    : window.NebulaWorkspaceUI.explain('WORKSPACE_OUTCOME_UNKNOWN');
  box.hidden = false;
}
let workspaceAttemptBusy = false;
async function workspaceAttempt(button, working, run) {
  if (workspaceAttemptBusy) return;
  workspaceAttemptBusy = true;
  const enabledButtons = [...document.querySelectorAll('#workspaceCard button')].filter(item => !item.disabled);
  enabledButtons.forEach(item => { item.disabled = true; });
  $('#workspaceCard').setAttribute('aria-busy', 'true');
  $('#workspaceGitConnections').replaceChildren();
  $('#workspaceGitRepositories').replaceChildren();
  if (['workspaceSignInBtn', 'workspaceClaimBtn', 'workspaceSignOutBtn'].includes(button.id)) $('#workspaceGitPanel').open = false;
  const box = $('#workspaceError');
  if (box) box.hidden = true;
  const label = button.textContent;
  button.disabled = true;
  button.textContent = working;
  try {
    await run();
    /* Both were only ever function arguments; clear the fields they came from. */
    $('#workspaceSetupSecret').value = '';
    $('#workspaceToken').value = '';
    renderWorkspaceCard();
  } catch (error) {
    if (window.NebulaWorkspaceUI.current().outcomeUnknown) {
      $('#workspaceSetupSecret').value = '';
      $('#workspaceToken').value = '';
    }
    showWorkspaceError(error);
    renderWorkspaceCard();
  } finally {
    $('#workspaceGitToken').value = '';
    $('#workspaceCard').setAttribute('aria-busy', 'false');
    workspaceAttemptBusy = false;
    enabledButtons.forEach(item => { if (item.isConnected) item.disabled = false; });
    button.disabled = false;
    button.textContent = label;
  }
}
async function initWorkspaceCard() {
  if (!window.NebulaWorkspaceUI) return;
  await window.NebulaWorkspaceUI.probe();
  renderWorkspaceCard();
}
$('#workspaceClaimToggle').addEventListener('click', () => {
  const fields = $('#workspaceClaimFields');
  const open = fields.hidden;
  fields.hidden = !open;
  $('#workspaceClaimToggle').setAttribute('aria-expanded', String(open));
  if (open) $('#workspaceSetupSecret').focus();
});
$('#workspaceSignInBtn').addEventListener('click', () => workspaceAttempt(
  $('#workspaceSignInBtn'), 'Signing in…',
  () => window.NebulaWorkspaceUI.signIn(workspaceInputs())
));
$('#workspaceClaimBtn').addEventListener('click', () => workspaceAttempt(
  $('#workspaceClaimBtn'), 'Claiming…',
  () => window.NebulaWorkspaceUI.claim({ ...workspaceInputs(), setupSecret: $('#workspaceSetupSecret').value })
));
$('#workspaceSignOutBtn').addEventListener('click', () => workspaceAttempt(
  $('#workspaceSignOutBtn'), 'Signing out…',
  () => window.NebulaWorkspaceUI.signOut()
));

async function refreshWorkspaceConnections() {
  const rows = await window.NebulaWorkspaceUI.listConnections();
  const list = $('#workspaceGitConnections');
  list.replaceChildren();
  if (!rows.length) list.textContent = 'No Git accounts connected yet.';
  for (const connection of rows) {
    const row = document.createElement('div'); row.className = 'workspace-git-row';
    const label = document.createElement('span');
    label.textContent = `${connection.login} · ${connection.provider} · ${connection.instance} · ${connection.credentialStored ? 'token stored for this session' : 'reconnect for this session'}`;
    const select = document.createElement('button'); select.className = 'btn btn-ghost small';
    select.textContent = connection.selected ? 'Selected' : 'Select'; select.disabled = connection.selected;
    select.setAttribute('aria-label', `${connection.selected ? 'Selected' : 'Select'} ${connection.login} on ${connection.instance}`);
    select.addEventListener('click', () => workspaceAttempt(select, 'Selecting…', async () => {
      await window.NebulaWorkspaceUI.selectConnection(connection.id);
      await refreshWorkspaceConnections();
    }));
    const disconnect = document.createElement('button'); disconnect.className = 'btn btn-ghost small';
    disconnect.textContent = 'Disconnect';
    disconnect.setAttribute('aria-label', `Disconnect ${connection.login} on ${connection.instance}`);
    disconnect.addEventListener('click', () => workspaceAttempt(disconnect, 'Disconnecting…', async () => {
      await window.NebulaWorkspaceUI.disconnect(connection.id);
      await refreshWorkspaceConnections();
    }));
    row.append(label, select, disconnect); list.appendChild(row);
  }
}
$('#workspaceGitProvider').addEventListener('change', () => {
  $('#workspaceGitBaseWrap').hidden = $('#workspaceGitProvider').value === 'github';
  $('#workspaceGitBase').placeholder = $('#workspaceGitProvider').value === 'gitea'
    ? 'https://gitea.example.com' : 'https://gitlab.com (default)';
});
$('#workspaceGitConnect').addEventListener('click', () => workspaceAttempt(
  $('#workspaceGitConnect'), 'Connecting…', async () => {
    await window.NebulaWorkspaceUI.connect({ provider: $('#workspaceGitProvider').value,
      baseUrl: $('#workspaceGitBase').value, token: $('#workspaceGitToken').value });
    await refreshWorkspaceConnections();
  }
));
$('#workspaceGitRefresh').addEventListener('click', () => workspaceAttempt(
  $('#workspaceGitRefresh'), 'Refreshing…', refreshWorkspaceConnections
));
$('#workspaceGitRepos').addEventListener('click', () => workspaceAttempt(
  $('#workspaceGitRepos'), 'Listing…', async () => {
    const result = await window.NebulaWorkspaceUI.repositories();
    const list = $('#workspaceGitRepositories');
    list.replaceChildren();
    if (!result.repositories.length) list.textContent = 'No repositories are visible to this credential.';
    for (const repo of result.repositories) {
      const row = document.createElement('div'); row.className = 'workspace-git-row';
      const name = document.createElement('span');
      name.textContent = `${repo.fullName} · ${repo.private ? 'private' : 'public'}`;
      row.appendChild(name); list.appendChild(row);
    }
    if (result.hasMore) {
      const note = document.createElement('p'); note.className = 'hint';
      note.textContent = 'Showing the first 100 repositories. More may be available on GitHub.';
      list.appendChild(note);
    }
    await refreshWorkspaceConnections();
  }
));
$('#workspaceGitPanel').addEventListener('toggle', () => {
  if ($('#workspaceGitPanel').open && window.NebulaWorkspaceUI.current().authenticated) {
    workspaceAttempt($('#workspaceGitRefresh'), 'Refreshing…', refreshWorkspaceConnections);
  }
});

async function leaveOwnerWorkbench() {
  if (ownerRequests) { toast('Wait for the current owner request to finish before changing connections.', 'err'); return; }
  if ((state.file?.dirty || state.staged.length) && !confirm('Discard unsaved changes and return to owner connections?')) return;
  identityEpoch++;
  await purgeLocalData(true);
  history.replaceState(null, '', location.pathname);
  location.reload();
}

$('#workspaceEnterBtn').addEventListener('click', () => workspaceAttempt(
  $('#workspaceEnterBtn'), 'Opening…', async () => {
    const session = await window.NebulaWorkspaceUI.probe();
    const context = session.context;
    if (!session.authenticated || context?.role !== 'owner' || !context.connection) {
      throw Object.assign(new Error('Select a Git connection first.'), { code: 'WORKSPACE_CONNECTION_REQUIRED' });
    }
    const binding = Object.freeze({ principalId: context.principalId, workspaceId: context.workspaceId, connectionId: context.connection.id });
    const me = await window.NebulaWorkspaceUI.workbench('/api/me', {}, binding);
    if (me.authorityKind !== 'workspace' || me.principalId !== binding.principalId
      || me.workspaceId !== binding.workspaceId || me.connectionId !== binding.connectionId) {
      throw Object.assign(new Error('Workspace changed.'), { code: 'WORKSPACE_EXECUTION_CHANGED' });
    }
    const safety = await window.NebulaWorkspaceUI.workbench('/api/safety', {}, binding);
    identityEpoch++;
    await purgeLocalData(true);
    ownerWorkbench = binding;
    state.me = me;
    state.caps = me.caps;
    state.safety = safety;
    loadSettings();
    $('#newRepoBtn').dataset.allowExperimental = 'true';
    await loadProviderCapabilities();
    applyCaps();
    applySafetyUI();
    setAvatar('');
    for (const header of $$('.topbar')) {
      if (header.querySelector('[data-owner-connections]')) continue;
      const button = document.createElement('button'); button.className = 'btn btn-ghost small';
      button.dataset.ownerConnections = 'true'; button.textContent = 'Owner';
      button.setAttribute('aria-label', 'Owner connections');
      button.title = `Using ${me.login} on GitHub. Return to owner connections.`;
      button.addEventListener('click', leaveOwnerWorkbench);
      header.querySelector('.topbar-actions').prepend(button);
    }
    history.replaceState(null, '', location.pathname);
    showPage('repos');
    await loadRepos(true);
  }
));

const PROV_ICON = {
  github: '<svg class="prov-ico" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 2a10 10 0 0 0-3.16 19.5c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.9-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.52 2.34 1.08 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.56-1.11-4.56-4.94 0-1.1.39-1.99 1.03-2.69-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02a9.56 9.56 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.6 1.03 2.69 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.75c0 .26.18.58.69.48A10 10 0 0 0 12 2z"/></svg>',
  gitlab: '<svg class="prov-ico" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 21.4l3.68-11.3H8.32L12 21.4zM3.7 10.1L2.16 14.8a1 1 0 0 0 .36 1.12L12 21.4 3.7 10.1zM3.7 10.1h4.62L6.34 4.02a.5.5 0 0 0-.95 0L3.7 10.1zM20.3 10.1l1.54 4.7a1 1 0 0 1-.36 1.12L12 21.4l8.3-11.3zM20.3 10.1h-4.62l1.98-6.08a.5.5 0 0 1 .95 0l1.69 6.08z"/></svg>',
  gitea: '<svg class="prov-ico" width="14" height="14" viewBox="0 0 24 24"><path d="M4.5 8h11v6.5a4.5 4.5 0 0 1-4.5 4.5H9a4.5 4.5 0 0 1-4.5-4.5V8z"/><path d="M15.5 9.5h2a2.5 2.5 0 0 1 0 5h-2M8 5.5V4M11.5 5.5V3.5"/></svg>'
};
function applyCaps() {
  const caps = state.caps || { prs: 1, issues: 1, releases: 1, actions: 1, lfs: 1, tm: 1, batch: 1, search: 1, notif: 1, compare: 1 };
  if (!caps.batch && typeof uploadModeV !== 'undefined' && uploadModeV === 'batch') {
    uploadModeV = 'single';
    selectSegment('#uploadMode', b2 => b2.dataset.v === 'single');
  }
  window.NebulaCapabilityUI.apply();
  /*
   * Read after apply(), because apply() is what decides whether Git LFS is
   * reachable here. A blocked choice that stays selected is a choice the
   * upload cannot honour, so it returns to Automatic.
   */
  const lfsChoice = $('#uploadTransport .seg-btn[data-v="lfs"]');
  if (lfsChoice && lfsChoice.dataset.capabilityBlocked === 'true'
    && typeof uploadTransportV !== 'undefined' && uploadTransportV === 'lfs') {
    uploadTransportV = 'auto';
    selectSegment('#uploadTransport', b3 => b3.dataset.v === 'auto');
  }
  refreshQueuedStrategies();
}
async function loadProviderCapabilities() {
  const provider = state.me && state.me.provider || 'github';
  const authority = state.me && (
    state.me.authority || state.me.host || state.me.baseUrl
  ) || (provider === 'github' ? 'github.com' : '');
  await window.NebulaCapabilityUI.load(provider, authority, ownerWorkbench
    ? { request: () => api('/api/capabilities') } : {});
  window.NebulaCapabilityUI.apply();
  applyGovernanceCapabilityBoundary($('#govRoot'));
}
function runCapabilityAction(feature, action, options = {}) {
  if (!feature) {
    action();
    return true;
  }
  const resolved = window.NebulaCapabilityUI.decision(feature);
  const blocked = resolved.status === 'Unavailable'
    || (resolved.status === 'Experimental' && options.allowExperimental !== true);
  if (blocked) {
    toast(window.NebulaCapabilityUI.explain(feature), 'err');
    return false;
  }
  action();
  return true;
}
/*
 * The same answer for a control that is pressed directly rather than chosen
 * from the palette. capability-ui stops the press -- it owns what is refused;
 * the sentence is spoken here, because the toast is this module's.
 */
window.addEventListener('nebula:capability-refused', event => {
  const refused = (event && event.detail) || {};
  toast(window.NebulaCapabilityUI.explain(refused.feature), 'err');
});
/*
 * Unknown means no number, not a small one. Requiring a positive value here
 * also swallowed a deliberate ceiling of zero -- which the server can never
 * send, since its own floor is 1, but which is a legitimate way to say "refuse
 * everything" and is fail-closed either way. A guard that re-fetches on zero
 * turns that refusal into an upload.
 */
function runtimeLimitsKnown() {
  return ['uploadMaxMb', 'gitDataMaxMb', 'nativePushMaxMb', 'contentsMaxMb']
    .every(key => Number.isFinite(state.runtime[key]));
}
async function loadRuntimeConfig(attempt = 0) {
  try {
    const c = await api('/api/config');
    window._oauthOn = !!c.oauth;
    state.runtime = { ...state.runtime, ...c };
    refreshQueuedStrategies();
    $('#oauthBtn').hidden = !c.oauth || loginProvider !== 'github';
  } catch {
    /* One retry: a free instance's first request can arrive while it wakes. */
    if (attempt === 0) return loadRuntimeConfig(1);
  }
}
async function boot() {
  loadSettings();
  githubAppCallbackNotice();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  updateNetBar();
  /*
   * Awaited, and retried once. It was fire-and-forget with a swallowed
   * rejection, so a cold start -- which is the ordinary first request to a free
   * instance -- left every size decision running on the defaults above for the
   * rest of the session, with nothing said.
   */
  await loadRuntimeConfig();
  $('#oauthBtn').addEventListener('click', () => { location.href = '/api/oauth/login'; });
  $('#findBtn').addEventListener('click', () => { if (state.file && !state.file.binary) openFindPanel(); });
  try {
    state.me = await api('/api/me');
    try { sessionStorage.setItem('nv_me', JSON.stringify(state.me)); } catch {}
    refreshSafety();
    state.caps = state.me.caps || null;
    await loadProviderCapabilities();
    applyCaps();
    setAvatar(state.me.avatar);
    flushQueue();
    loadRepos(true);
    if (!(await restoreRoute())) showOverview();
  } catch (e) {
    const cached = (() => { try { return JSON.parse(sessionStorage.getItem('nv_me') || 'null'); } catch { return null; } })();
    if (cached && isOfflineError(e)) {
      /* offline launch: proceed with the last-known identity and cached data */
      state.me = cached;
      state.caps = cached.caps || null;
      await loadProviderCapabilities();
      applyCaps();
      setAvatar(cached.avatar);
      updateNetBar();
      loadRepos(true);
      if (!(await restoreRoute())) showOverview();
      toast('Offline mode — showing cached data ✦', 'ok');
    } else if (!['ALPHA_SESSION_EXPIRED', 'ALPHA_ACCESS_REVOKED'].includes(e.code)) {
      ensureAlphaProviderGuidance();
      ensureLoginAlphaSessionControls();
      showPage('login');
    }
  }
}
$('#loginBackBtn').addEventListener('click', () => {
  $('#loginBackBtn').hidden = true;
  showPage('repos');
});
$('#loginBtn').addEventListener('click', doLogin);
$('#tokenInput').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
function setAvatar(url) {
  /* Both home screens carry an account control, so both carry the avatar. */
  for (const img of [$('#meAvatar'), $('#meAvatarOv')]) {
    if (!img) continue;
    img.hidden = true;
    if (!url) continue;
    img.onload = () => { img.hidden = false; };
    img.onerror = () => { img.hidden = true; };
    img.src = url;
  }
}
async function doLogin() {
  const token = $('#tokenInput').value.trim();
  const err = $('#loginError'); err.hidden = true;
  if (!token) return;
  $('#loginBtn').disabled = true; $('#loginBtn').textContent = 'Docking…';
  try {
    await purgeLocalData(true);
    state.me = await api('/api/login', {
      method: 'POST',
      body: { token, provider: loginProvider, baseUrl: ($('#baseUrl') ? $('#baseUrl').value : '').trim() }
    });
    try {
      const me2 = await api('/api/me');
      state.me = { ...state.me, ...me2 };
      state.caps = me2.caps || null;
      sessionStorage.setItem('nv_me', JSON.stringify(state.me));
      await loadProviderCapabilities();
    } catch {}
    broadcastIdentityBoundary();
    $('#loginBackBtn').hidden = true;
    applyCaps();
    $('#tokenInput').value = '';
    setAvatar(state.me.avatar);
    toast(`Welcome aboard, ${state.me.login} ✦`, 'ok');
    showOverview(); loadRepos(true);
  } catch (e) { err.hidden = true; presentError(e); }
  finally { $('#loginBtn').disabled = false; $('#loginBtn').textContent = 'Enter orbit'; }
}
async function purgePrivateCaches() {
  try {
    for (const key of await caches.keys()) if (key.startsWith('nv-api-')) await caches.delete(key);
  } catch {}
}
async function purgeLocalData(full) {
  identityEpoch++;
  clearCsrfToken();
  clearGovernanceState();
  await purgePrivateCaches();
  try { sessionStorage.clear(); } catch {}
  try {
    if (navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'NV_PURGE_PRIVATE_DATA' });
    }
  } catch {}
  try {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith('nv_snap_') || k.startsWith('nv_incident_') ||
          k.startsWith('nv_draft:') || k.startsWith('nv_recent:') ||
          k.startsWith('nv_offline_repos:')) localStorage.removeItem(k);
    }
  } catch {}
  /* Offline writes are not identity-bound in v5.2. Clearing them on any account
     boundary prevents a queued operation from being replayed with another token. */
  try {
    const db = await idb();
    await new Promise(r => {
      const tx = db.transaction('queue', 'readwrite');
      tx.objectStore('queue').clear();
      tx.oncomplete = r;
      tx.onerror = r;
      tx.onabort = r;
    });
  } catch {}
  /* Remove the pre-alpha.17 shared cache during upgrades; current identity
     fallback is tab-scoped in sessionStorage and was cleared above. */
  try { localStorage.removeItem('nv_me'); } catch {}
  state.file = null;
  if (state.cm) {
    try { state.cm.setValue(''); } catch {}
    try { state.cm.clearHistory(); } catch {}
  }
  state.staged = [];
  state.work = null;
  state.repos = [];
  state.me = null;
  state.caps = null;
  state.safety = null;
  state.fileIndex = null;
  for (const selector of [
    '#repoGrid', '#tree', '#prList', '#issueList', '#releaseList', '#commitList',
    '#cmpResult', '#uploadQueue', '#actionsList', '#stageList', '#paletteList',
    '#filePath', '#fileSize', '#mdPreview', '#binaryPreview', '#editDiffBody',
    '#githubAppSettingsBody', '#tokenInput', '#baseUrl', '#codeSearch', '#findInput',
    '#replaceInput', '#uploadMsg', '#stageMsg', '#paletteInput'
  ]) {
    const element = $(selector);
    if (!element) continue;
    if ('value' in element) element.value = '';
    if (typeof element.replaceChildren === 'function') element.replaceChildren();
    else element.textContent = '';
  }
  if (full) _cache.clear();
}
window.NebulaPwa = Object.freeze({ purgePrivateData: purgeLocalData, purgePrivateCaches, isOfflineRepoEnabled });
const NV_IDENTITY_BOUNDARY_STORAGE_KEY = 'nv_identity_boundary_event';
const identityBoundaryChannel = (() => {
  try { return typeof BroadcastChannel === 'function' ? new BroadcastChannel('nv-identity-boundary-v1') : null; }
  catch { return null; }
})();
let handlingRemoteIdentityBoundary = false;
async function receiveIdentityBoundary() {
  if (handlingRemoteIdentityBoundary) return;
  handlingRemoteIdentityBoundary = true;
  await purgeLocalData(true);
  window.location.reload();
}
function broadcastIdentityBoundary() {
  const marker = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
  try { if (identityBoundaryChannel) identityBoundaryChannel.postMessage({ type: 'NV_IDENTITY_BOUNDARY', marker }); } catch {}
  try { localStorage.setItem(NV_IDENTITY_BOUNDARY_STORAGE_KEY, marker); } catch {}
}
if (identityBoundaryChannel) {
  identityBoundaryChannel.addEventListener('message', event => {
    if (event.data && event.data.type === 'NV_IDENTITY_BOUNDARY') receiveIdentityBoundary().catch(() => {});
  });
}
window.addEventListener('storage', event => {
  if (event.key === NV_IDENTITY_BOUNDARY_STORAGE_KEY && event.newValue) receiveIdentityBoundary().catch(() => {});
});
async function doLogout() {
  let remoteError = null;
  try {
    await api('/api/logout', { method: 'POST' });
  } catch (error) {
    remoteError = error;
  } finally {
    await purgeLocalData(true);
    broadcastIdentityBoundary();
    state.me = null;
    showPage('login');
  }
  if (remoteError) presentError(remoteError);
}
$('#logoutBtn').addEventListener('click', doLogout);
$('#logoutBtnM').addEventListener('click', doLogout);
$('#logoutBtnOv') && $('#logoutBtnOv').addEventListener('click', doLogout);

/* ================= REPOS ================= */
async function loadRepos(reset) {
  const grid = $('#repoGrid');
  if (reset) { state.repoPage = 1; state.repos = []; grid.innerHTML = '<div class="skeleton"></div>'.repeat(6); }
  try {
    const batch = await api(`/api/repos?page=${state.repoPage}&sort=${state.repoSort}`);
    if (reset) grid.innerHTML = '';
    state.repos.push(...batch);
    batch.forEach(r => grid.appendChild(repoCard(r)));
    $('#moreReposBtn').hidden = batch.length < 30;
    if (!state.repos.length) grid.innerHTML = `<div class="card editor-empty"><div class="empty-icon">${EMPTY_ICON.repos}</div><p>No repositories yet.<br>Create one with “＋ New repo”.</p></div>`;
    renderGalaxyPulse(state.repos);
    renderWorkspacePulse();
  } catch (e) {
    toast(e.message, 'err');
    grid.innerHTML = '';
    renderGalaxyPulse([]);
    renderWorkspacePulse([]);
  }
}
const LOCK_SVG = '<svg class="lock-ico" width="13" height="13" viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
function repoCard(r) {
  const el = document.createElement('div');
  el.className = 'card repo-card pressable';
  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  el.setAttribute('aria-label', `Open repository ${r.full_name}`);
  el.innerHTML = `
    <div class="repo-head">
      <span class="repo-sigil-slot"></span>
      <h3>${r.private ? LOCK_SVG : ''}<span class="repo-name"></span>
        <span class="repo-badge ${r.private ? 'repo-badge-private' : 'repo-badge-healthy'}">${r.private ? 'Private' : 'Public'}</span></h3>
    </div>
    <p class="desc"></p>
    <div class="repo-meta">
      ${r.language ? `<span><span class="lang-dot"></span>${esc(r.language)}</span>` : ''}
      <span>${META_ICON.star} ${r.stars}</span><span>${META_ICON.fork} ${r.forks}</span><span>${timeAgo(r.pushed_at)}</span>
    </div>
    <span class="repo-open">Open workspace</span>`;
  el.querySelector('h3 .repo-name').textContent = r.full_name;
  el.querySelector('.desc').textContent = r.description || 'No description';
  /*
   * A mark derived from the repository's own name, so the inventory is
   * something to recognise rather than only to read. Decoration beside the
   * name and never instead of it: it is hidden from assistive technology, and
   * a session that cannot draw it loses nothing but the picture.
   */
  if (window.NebulaRepoSigil) {
    const sigil = window.NebulaRepoSigil.render(r.full_name);
    if (sigil) el.querySelector('.repo-sigil-slot').appendChild(sigil);
  }
  const open = () => openRepo(r.owner, r.name);
  el.addEventListener('click', open);
  el.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    open();
  });
  return el;
}
$('#moreReposBtn').addEventListener('click', () => { state.repoPage++; loadRepos(false); });
$('#repoSort').addEventListener('change', e => { state.repoSort = e.target.value; loadRepos(true); });
async function globalCodeSearch(query) {
  const q = String(query || '').trim();
  if (!q) return;
  const capability = window.NebulaCapabilityUI.decision('global-search');
  if (capability.status === 'Unavailable') {
    toast(window.NebulaCapabilityUI.explain('global-search'), 'err');
    return;
  }
  modal({ title: `Code search — “${q}”`, okText: 'Close', bodyHTML: '<div class="skeleton" style="height:80px"></div>' });
  try {
    const hits = await api(`/api/search?q=${encodeURIComponent(q)}`);
    if ($('#scrim').hidden) return;
    $('#modalBody').innerHTML = hits.length ? '' : '<p class="hint">No matches in your repositories.</p>';
    hits.forEach(hh => {
      const el = document.createElement('div');
      el.className = 'br-row'; el.style.cursor = 'pointer';
      el.innerHTML = `<span class="mono"></span><span class="br-tag">${esc(hh.repo)}</span>`;
      el.querySelector('.mono').textContent = hh.path;
      el.addEventListener('click', async () => {
        closeModal(true);
        const [ow, rp] = hh.repo.split('/');
        await openRepo(ow, rp);
        state.pendingFind = q;
        openFile(hh.path);
      });
      $('#modalBody').appendChild(el);
    });
  } catch (error) {
    if (!$('#scrim').hidden) $('#modalBody').innerHTML = `<p class="hint">⚠ ${esc(error.message)}</p>`;
  }
}
$('#repoFilter').addEventListener('keydown', e => {
  if (e.key === 'Enter') globalCodeSearch(e.target.value);
});
$('#repoGlobalSearchBtn').addEventListener('click', () => globalCodeSearch($('#repoFilter').value));
$('#repoFilter').addEventListener('input', e => {
  const q = e.target.value.toLowerCase();
  $$('#repoGrid .repo-card').forEach(c => { c.style.display = c.textContent.toLowerCase().includes(q) ? '' : 'none'; });
});
/*
 * The brand mark leads to the overview, which is the design's authenticated
 * home. Where a session lands after sign-in is left alone for now: that is a
 * change to the qualified tester journey rather than a change of surface, and
 * it belongs in its own change with its own evidence.
 */
$('#homeBtn').addEventListener('click', () => showOverview());
$('#ovHomeBtn') && $('#ovHomeBtn').addEventListener('click', () => showOverview());
$('#ovGoRepos') && $('#ovGoRepos').addEventListener('click', () => showPage('repos'));
$('#ovOpenBrowser') && $('#ovOpenBrowser').addEventListener('click', () => showPage('repos'));

function showOverview() {
  const who = $('#ovWho');
  if (who) who.textContent = (state.me && (state.me.name || state.me.login)) || 'tester';
  renderWorkspacePulse();
  loadScannerPosture();
  showPage('overview');
}

/*
 * The trust score and live-signal count.
 *
 * Every input is read from what this session already holds -- no measure
 * triggers a request of its own, so opening the overview cannot spend a
 * reader's rate limit to draw a number at them. Anything absent stays absent:
 * the model reports it as unmeasured rather than scoring it zero.
 */
/*
 * Upload-scanning posture, read once per session.
 *
 * A failure here is left as an absent reading rather than a false one: the
 * endpoint is capability-gated, so a provider that does not offer it answers
 * with a refusal, and reporting that as "not scanned" would accuse a
 * deployment of something this client never established.
 */
let scannerPostureAsked = false;
async function loadScannerPosture() {
  /*
   * Asked for once, and only once the overview is actually on screen. Reading
   * it during boot spent a request on every sign-in, sign-out and reconnect
   * cycle -- including the ones that never reach a screen that shows it.
   */
  if (scannerPostureAsked) return;
  scannerPostureAsked = true;
  try {
    const status = await api('/api/security/scanner-status');
    state.scanner = {
      active: !!(status.builtin && status.builtin.available) || !!(status.yara && status.yara.configured),
      rulesConfigured: !!(status.yara && status.yara.configured)
    };
  } catch {
    state.scanner = null;
  }
  renderWorkspacePulse();
}

/*
 * The design's WebGL pieces mount when their screen is shown, never at boot.
 * They pull three.js behind them, so a session that never opens the screen
 * never pays for the download -- and a device that cannot draw them, or a
 * reader on a metered connection, never does either. The loader decides; this
 * only says which host belongs to which screen.
 */
function mountNebulaVisual(kind, selector) {
  const host = $(selector);
  if (!host || !window.NebulaVisuals) return;
  window.NebulaVisuals.mount(kind, host);
}

function renderWorkspacePulse(repos) {
  if (!window.NebulaWorkspacePulse) return;
  const capabilities = window.NebulaCapabilityUI;
  /* The inventory's failure path reports an empty set without discarding what
   * the session still holds, so the caller may override the list it reads. */
  const list = Array.isArray(repos) ? repos : state.repos;
  /*
   * One model, two readings. The summary row and the cards below it used to be
   * computed apart, which let the row say one thing and the card under it say
   * another about the same session. They now share a single measurement.
   */
  const pulse = window.NebulaWorkspacePulse.model({
    repos: list,
    features: capabilities && capabilities.features ? capabilities.features() : null,
    recoveryStatus: capabilities ? capabilities.decision('recovery').status : null,
    scanner: state.scanner,
    identity: state.me
  });
  renderOverviewPulse(list, pulse);
  const roots = { trust: $('#wpTrust'), signals: $('#wpSignals'), activity: $('#wpActivity') };
  if (roots.trust || roots.signals || roots.activity) window.NebulaWorkspacePulse.render(roots, pulse);
}

/*
 * The summary row across the top of the overview. Every figure here is read
 * off the same pulse model the cards below use, so the row can never disagree
 * with the card that explains it -- and a measure without a source shows an em
 * dash and the word "Not measured" rather than a plausible-looking zero.
 */
const PULSE_ICONS = Object.freeze({
  repositories: 'M4 6.5A2.5 2.5 0 0 1 6.5 4H19v13H6.5A2.5 2.5 0 0 0 4 19.5z',
  private: 'M6 10.5h12v9H6zM9 10.5V7.5a3 3 0 0 1 6 0v3',
  trust: 'M12 3.2l7 3v5.3c0 4.2-2.9 7.6-7 9.3-4.1-1.7-7-5.1-7-9.3V6.2z',
  signals: 'M2 12h3.4l2.3-7 3.4 14 2.6-9.4 1.8 5 1.6-2.6H22',
  attention: 'M12 4.4l8.4 15H3.6zM12 10.4v4M12 17.1h.01'
});

function pulseMeasures(list, pulse) {
  const trust = pulse && pulse.trust;
  const signals = pulse && pulse.signals;
  /*
   * "Needs attention" counts the components the model itself scored as warning
   * or critical. Components it could not measure are not counted -- an unknown
   * is not a problem, and reporting it as one would invent a fault.
   */
  const flagged = trust && Array.isArray(trust.components)
    ? trust.components.filter(c => c.status === 'warning' || c.status === 'critical').length
    : null;
  return [
    { icon: 'repositories', label: 'Repositories', value: list.length, note: 'connected' },
    { icon: 'private', label: 'Private', value: list.filter(r => r && r.private).length, note: 'of the connected set' },
    {
      icon: 'trust', label: 'Trust score',
      value: trust && trust.score !== null && trust.score !== undefined ? trust.score : null,
      note: trust && trust.score !== null && trust.score !== undefined
        ? `${trust.measuredCount} of ${trust.componentCount} measured`
        : 'Not measured'
    },
    {
      icon: 'signals', label: 'Live signals',
      value: signals && signals.measured ? signals.live : null,
      note: signals && signals.measured ? `of ${signals.total} verified` : 'Not measured'
    },
    {
      icon: 'attention', label: 'Needs attention',
      value: flagged === null ? null : flagged,
      note: flagged === null ? 'Not measured' : (flagged === 1 ? 'component flagged' : 'components flagged')
    }
  ];
}

function renderOverviewPulse(repos, pulse) {
  const section = $('#ovPulse');
  const grid = $('#ovPulseGrid');
  if (!section || !grid) return;
  const list = Array.isArray(repos) ? repos : [];
  grid.innerHTML = '';
  for (const measure of pulseMeasures(list, pulse)) {
    const cell = document.createElement('div');
    cell.className = 'gx-pulse-cell';
    if (measure.value === null) cell.classList.add('is-unmeasured');
    const dt = document.createElement('dt');
    const mark = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    mark.setAttribute('class', 'gx-pulse-ico');
    mark.setAttribute('viewBox', '0 0 24 24');
    mark.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', PULSE_ICONS[measure.icon]);
    mark.appendChild(path);
    const name = document.createElement('span');
    name.textContent = measure.label;
    dt.append(mark, name);
    const dd = document.createElement('dd');
    const value = document.createElement('span');
    value.className = 'gx-pulse-value';
    value.textContent = measure.value === null ? '\u2014' : String(measure.value);
    const note = document.createElement('span');
    note.className = 'gx-pulse-note';
    note.textContent = measure.note;
    dd.append(value, note);
    cell.append(dt, dd);
    grid.appendChild(cell);
  }
  section.hidden = false;
}
/* Both home screens open the same account sheet. */
async function openAccounts() {
  if (ownerWorkbench) return leaveOwnerWorkbench();
  modal({ title: 'Accounts', okText: 'Done', bodyHTML: '<div class="skeleton" style="height:60px"></div>' });
  try {
    const a = await api('/api/accounts');
    if ($('#scrim').hidden) return;
    $('#modalBody').innerHTML = a.accounts.map((ac, i) => `
      <div class="acct-row ${i === a.active ? 'active' : ''}">
        <img class="avatar" src="${escAttr(ac.avatar || '')}" alt="">
        <div class="acct-meta">
          <div class="acct-login">${esc(ac.login)}</div>
          <div class="acct-host">${PROV_ICON[ac.provider] || ''}<span>${esc(ac.host || { github: 'github.com', gitlab: 'gitlab.com', gitea: 'gitea' }[ac.provider])}</span></div>
        </div>
        ${i === a.active ? '<span class="br-tag">active</span>'
          : `<button class="btn btn-ghost small" data-switch="${i}">Switch</button>`}
        <button class="btn btn-ghost small danger" data-remove="${i}" title="Sign out this account only">Remove</button>
      </div>`).join('') + `
      <div class="detail-actions" style="margin-top:14px">
        <button class="btn btn-ghost small" id="accAdd">Add account</button>
        <button class="btn btn-ghost small danger" id="accOut">Sign out (all)</button>
      </div>`;
    $$('#modalBody [data-switch]').forEach(b => b.addEventListener('click', async () => {
      try {
        await purgeLocalData(false);
        const out = await api('/api/accounts/switch-idx', { method: 'POST', body: { idx: +b.dataset.switch } });
        broadcastIdentityBoundary();
        closeModal(true);
        toast(`Switched to ${out.login} ✦`, 'ok');
        location.hash = '';
        boot(); loadRepos(true);
      } catch (e) { toast(e.message, 'err'); }
    }));
    $$('#modalBody [data-remove]').forEach(b => b.addEventListener('click', async () => {
      try {
        await purgeLocalData(false);
        const out = await api('/api/accounts/remove', { method: 'POST', body: { idx: +b.dataset.remove } });
        await purgeLocalData(!!out.empty);
        broadcastIdentityBoundary();
        closeModal(true);
        toast(`${out.removed} signed out ✦`, 'ok');
        if (out.empty) { sessionStorage.removeItem('nv_me'); showPage('login'); return; }
        location.hash = '';
        boot(); loadRepos(true);
      } catch (e) { toast(e.message, 'err'); }
    }));
    $('#accAdd').addEventListener('click', () => {
      closeModal(true);
      $('#loginBackBtn').hidden = false;
      showPage('login');
    });
    $('#accOut').addEventListener('click', async () => { closeModal(true); doLogout(); });
  } catch (e) { if (!$('#scrim').hidden) $('#modalBody').innerHTML = `<p class="hint">⚠ ${esc(e.message)}</p>`; }
}
$('#accountBtn').addEventListener('click', openAccounts);
$('#accountBtnOv') && $('#accountBtnOv').addEventListener('click', openAccounts);
$('#notifBtn').addEventListener('click', async () => {
  modal({ title: 'Notifications', okText: 'Close', bodyHTML: '<div class="skeleton" style="height:80px"></div>' });
  try {
    const list = await api('/api/notifications');
    if ($('#scrim').hidden) return;
    $('#modalBody').innerHTML = list.length ? '' : '<p class="hint">Inbox zero. ✦</p>';
    list.forEach(n => {
      const el = document.createElement('div');
      el.className = 'comment';
      el.style.cursor = 'pointer';
      el.innerHTML = `<div class="comment-head">${n.unread ? '<span class="notif-unread"></span>' : ''}
          <span class="mono">${esc(n.repo || '')}</span><span>${esc(n.reason)}</span><span>${timeAgo(n.updated_at)}</span></div>
        <div class="comment-body"></div>`;
      el.querySelector('.comment-body').textContent = `${n.type || ''}: ${n.title || ''}`;
      if (n.web) el.addEventListener('click', () => window.open(n.web, '_blank', 'noopener'));
      $('#modalBody').appendChild(el);
    });
  } catch (e) { if (!$('#scrim').hidden) $('#modalBody').innerHTML = `<p class="hint">⚠ ${esc(e.message)}</p>`; }
});
$('#backBtn').addEventListener('click', () => {
  if (state.staged.length && !confirm('You have staged changes that will be lost. Leave anyway?')) return;
  state.staged = []; renderStagedCount();
  showPage('repos');
});
$('#newRepoBtn').addEventListener('click', async () => {
  const ok = await modal({
    title: 'New repository',
    bodyHTML: `
      <label class="field-label" for="nrName">Name</label><input id="nrName" type="text" placeholder="my-nebula" spellcheck="false">
      <label class="field-label" for="nrDesc">Description</label><input id="nrDesc" type="text" placeholder="Optional">
      <label class="check"><input type="checkbox" id="nrPriv" checked> Private</label>`,
    okText: 'Create'
  });
  if (!ok) return;
  const name = $('#nrName').value.trim();
  if (!name) return;
  try {
    const r = await api('/api/repos', { method: 'POST', body: { name, description: $('#nrDesc').value, isPrivate: $('#nrPriv').checked } });
    toast(`Created ${r.full_name} ✦`, 'ok');
    loadRepos(true);
  } catch (e) { presentError(e); }
});

/* ================= WORKSPACE ================= */
function trustFailureText(result, label) {
  if (result.status === 'fulfilled') return '';
  return `${label} is unavailable. No clean result is claimed.`;
}
async function loadRepositoryTrustSummary() {
  const trustKey = wPath();
  const loading = {
    connection: { text: 'Checking provider and repository freshness…', evidenceState: 'Inferred' },
    pipeline: { text: 'Checking application and evidence health…', evidenceState: 'Inferred' },
    risk: { text: 'Checking access and governance risk…', evidenceState: 'Inferred' },
    action: { text: 'Waiting for verified trust results.', evidenceState: 'Inferred' },
    evidence: { text: 'Loading supporting evidence…', evidenceState: 'Inferred' },
    announcement: 'Repository opened. Trust checks are running.'
  };
  NebulaTrustUI.renderSummary(loading);
  const [liveResult, accessResult, evidenceResult] = await Promise.allSettled([
    api(`/api/repo/${wPath()}/live-events/status`),
    api(`/api/repo/${wPath()}/access-surface`),
    api(`/api/repo/${wPath()}/evidence`)
  ]);
  if (!state.work || wPath() !== trustKey) return;
  const live = liveResult.status === 'fulfilled' ? liveResult.value : null;
  const access = accessResult.status === 'fulfilled' ? accessResult.value : null;
  const evidence = evidenceResult.status === 'fulfilled' ? evidenceResult.value : null;
  const failures = [
    trustFailureText(liveResult, 'Live-event status'),
    trustFailureText(accessResult, 'Access-surface status'),
    trustFailureText(evidenceResult, 'Evidence status')
  ].filter(Boolean);

  const connection = !live
    ? { text: 'Repository metadata responded, but connection freshness could not be verified.', evidenceState: 'Unavailable' }
    : live.available === false
      ? { text: `Repository responded; verified live events are unavailable${live.reason ? `: ${live.reason}` : '.'}`, evidenceState: 'Unavailable' }
      : live.connected
        ? { text: 'Repository is current and verified live events are connected.', evidenceState: 'Provider-verified' }
        : { text: 'Repository is current; verified live events are not connected.', evidenceState: 'Provider-verified' };

  const chain = evidence && evidence.chain;
  const pipeline = !evidence || evidence.available === false || !chain || chain.available === false
    ? { text: 'Durable evidence verification is unavailable; no healthy pipeline is claimed.', evidenceState: 'Unavailable' }
    : chain.valid
      ? { text: `Evidence chain verified${Number.isFinite(chain.checked) ? ` across ${chain.checked} record(s)` : ''}.`, evidenceState: 'Deterministic' }
      : { text: 'Evidence verification did not pass. Treat the pipeline as stale.', evidenceState: 'Stale' };

  const risk = !access || access.available === false
    ? { text: 'Access and governance risk could not be enumerated.', evidenceState: 'Unavailable' }
    : access.partial
      ? { text: 'Access inventory is partial; risk may be understated.', evidenceState: 'Stale' }
      : access.risk && access.risk.severity !== 'normal'
        ? { text: `${access.risk.severity === 'critical' ? 'Critical' : 'Warning'} access risk (${Number(access.risk.score) || 0}/100): ${access.risk.reasons && access.risk.reasons[0] ? access.risk.reasons[0].message : 'review the access surface.'}`, evidenceState: 'Provider-verified' }
        : { text: 'No issue was found in the provider access inventory.', evidenceState: 'Provider-verified' };

  let action = { text: 'No immediate corrective action is indicated. Continue with the golden path.', evidenceState: 'Inferred' };
  if (failures.length) action = { text: 'Retry unavailable trust checks before making a sensitive change.', evidenceState: 'Unavailable' };
  else if (access && access.partial) action = { text: 'Refresh the access inventory with sufficient provider permissions.', evidenceState: 'Stale' };
  else if (access && access.risk && access.risk.severity !== 'normal') action = { text: 'Review the access surface and resolve the highest-scoring reason first.', evidenceState: 'Inferred' };
  else if (!evidence || evidence.available === false || !chain || chain.available === false) action = { text: 'Connect durable evidence storage before relying on audit history.', evidenceState: 'Unavailable' };
  else if (!chain.valid) action = { text: 'Re-verify the evidence chain before relying on audit history.', evidenceState: 'Stale' };
  else if (live && !live.connected) action = { text: 'Connect verified live events if current event evidence is required.', evidenceState: 'Inferred' };

  const evidenceSummary = !evidence || evidence.available === false || !chain || chain.available === false
    ? { text: 'Supporting evidence is unavailable without durable persistence.', evidenceState: 'Unavailable' }
    : chain.valid
      ? { text: `${chain.checked || 0} chained record(s), ${(evidence.events || []).length} event(s), and ${(evidence.snapshots || []).length} snapshot(s) support this summary.`, evidenceState: 'Deterministic' }
      : { text: 'Evidence exists, but its chain is not currently verified.', evidenceState: 'Stale' };

  NebulaTrustUI.renderSummary({
    connection, pipeline, risk, action, evidence: evidenceSummary,
    announcement: failures.length
      ? `Repository trust summary updated with ${failures.length} unavailable check${failures.length === 1 ? '' : 's'}.`
      : 'Repository trust summary updated.'
  });
}
async function openRepo(owner, repo) {
  showPage('work');
  clearGovernanceState();
  $('#workRepoName').textContent = `${owner}/${repo}`;
  $('#tree').innerHTML = '<div class="skeleton" style="height:200px"></div>';
  closeFile();
  state.staged = []; renderStagedCount();
  state.fileIndex = null;
  ['#prList', '#issueList', '#releaseList', '#commitList', '#cmpResult', '#uploadQueue', '#actionsList'].forEach(s => { $(s).innerHTML = ''; });
  $('#prDetail').hidden = true; $('#issueDetail').hidden = true;
  try {
    const info = await api(`/api/repo/${owner}/${repo}`);
    state.work = { owner, repo, branch: info.default_branch, ...info };
    $('#workPrivateBadge').hidden = !info.private;
    const names = info.branches.map(b => b.name);
    fillBranchSelect($('#branchSelect'), names, info.default_branch, true);
    fillBranchSelect($('#cmpBase'), names, info.default_branch);
    fillBranchSelect($('#cmpHead'), names, names.find(n => n !== info.default_branch) || info.default_branch);
    refreshShield();
    switchTab('editor');
    loadTree('', $('#tree'), true);
    refreshRate();
    saveRoute();
    loadRepositoryTrustSummary().catch(error => {
      NebulaTrustUI.renderSummary({
        connection: { text: 'Repository metadata responded.', evidenceState: 'Provider-verified' },
        pipeline: { text: 'Trust checks could not be completed.', evidenceState: 'Unavailable' },
        risk: { text: 'Risk state is unavailable.', evidenceState: 'Unavailable' },
        action: { text: 'Retry trust checks before making a sensitive change.', evidenceState: 'Unavailable' },
        evidence: { text: 'Supporting evidence is unavailable.', evidenceState: 'Unavailable' },
        announcement: 'Repository trust checks are unavailable.'
      });
      presentError(error);
    });
    api(`/api/repo/${owner}/${repo}/star`).then(x => { state.work.starred = x.starred; }).catch(() => {});
  } catch (e) { presentError(e); showPage('repos'); }
}
async function refreshRepoMetadata() {
  if (!state.work || !state.work.owner || !state.work.repo) return null;
  const info = await api(`/api/repo/${state.work.owner}/${state.work.repo}`);
  const previousBranch = state.work.branch;
  state.work = { ...state.work, ...info, branch: (info.branches || []).some(b => b.name === previousBranch) ? previousBranch : info.default_branch };
  const names = (state.work.branches || []).map(b => b.name);
  fillBranchSelect($('#branchSelect'), names, state.work.branch, true);
  fillBranchSelect($('#cmpBase'), names, names.includes($('#cmpBase').value) ? $('#cmpBase').value : state.work.default_branch);
  fillBranchSelect($('#cmpHead'), names, names.includes($('#cmpHead').value) ? $('#cmpHead').value : (names.find(n => n !== state.work.default_branch) || state.work.default_branch));
  refreshShield();
  return info;
}

async function toggleStar() {
  try {
    const out = await api(`/api/repo/${wPath()}/star`, { method: state.work.starred ? 'DELETE' : 'PUT' });
    state.work.starred = out.starred;
    toast(out.starred ? '★ Starred' : 'Unstarred', 'ok');
  } catch (e) { presentError(e); }
}
function fillBranchSelect(sel, names, selected, withGlyph) {
  sel.innerHTML = '';
  names.forEach(b => {
    const o = document.createElement('option');
    o.value = b; o.textContent = b;
    if (b === selected) o.selected = true;
    sel.appendChild(o);
  });
}
$('#syncBtn').addEventListener('click', async () => {
  if (!state.work.repo) return;
  hapt();
  await refreshRepoMetadata().catch(e => toast(e.message, 'err'));
  state.fileIndex = null;
  loadTree('', $('#tree'), true);
  const t = currentTab();
  if (t === 'commits') { state.commitsPage = 1; $('#commitList').innerHTML = ''; loadCommits(true); }
  else if (t === 'pulls') loadPRs();
  else if (t === 'issues') loadIssues();
  else if (t === 'releases') loadReleases();
  else if (t === 'actions') loadActions();
  else if (t === 'governance') loadGovernanceTwin(true);
  else if (t === 'editor' && state.file && !state.file.binary && !state.file.dirty) openFile(state.file.path);
  refreshRate();
  toast('Refreshed ✦', 'ok');
});
function branchProtected(name) {
  const b = (state.work.branches || []).find(x => x.name === name);
  return !!(b && b.protected);
}
function refreshShield() {
  const on = branchProtected(state.work.branch);
  $('#branchShield').hidden = !on;
}
$('#branchSelect').addEventListener('change', e => {
  state.work.branch = e.target.value;
  refreshShield();
  closeFile(); state.fileIndex = null;
  loadTree('', $('#tree'), true);
  state.commitsPage = 1; $('#commitList').innerHTML = '';
  if (currentTab() === 'commits') loadCommits(true);
  saveRoute();
});
$('#newBranchBtn').addEventListener('click', async () => {
  const ok = await modal({
    title: 'New branch',
    bodyHTML: `<label class="field-label" for="nbName">Branch name</label><input id="nbName" type="text" placeholder="feature/starlight" spellcheck="false">
      <p class="hint">Created from <b>${esc(state.work.branch)}</b></p>`,
    okText: 'Create branch'
  });
  if (!ok) return;
  const name = $('#nbName').value.trim();
  if (!name) return;
  try {
    const created = await api(`/api/repo/${wPath()}/branches`, { method: 'POST', body: { name, from: state.work.branch } });
    state.work.branches.push({ name, sha: created.sha || '' });
    ['#branchSelect', '#cmpBase', '#cmpHead'].forEach(s => {
      const o = document.createElement('option');
      o.value = name; o.textContent = name;
      $(s).appendChild(o);
    });
    $('#branchSelect').value = name; state.work.branch = name;
    toast(`Branch ${name} created ✦`, 'ok');
    closeDrawer();
  } catch (e) { toast(e.message, 'err'); }
});
$('#refreshTreeBtn').addEventListener('click', () => { state.fileIndex = null; loadTree('', $('#tree'), true); });
$('#zipBtn').addEventListener('click', downloadZip);
function downloadZip() {
  if (ownerWorkbench) { toast('Repository downloads are not connected to the owner workbench yet.', 'err'); return; }
  const a = document.createElement('a');
  a.href = `/api/repo/${wPath()}/zip?ref=${encodeURIComponent(state.work.branch)}`;
  a.download = ''; document.body.appendChild(a); a.click(); a.remove();
  toast('Preparing archive…');
}
const wPath = () => `${state.work.owner}/${state.work.repo}`;

let governanceExpiryTimer = null;
const GOVERNANCE_EXPERIMENTAL_VIEW_ACTIONS = Object.freeze([
  'refresh', 'select-policy', 'view-version', 'view-exception', 'verify-chain',
  'load-more-decisions', 'delivery-refresh', 'download-export', 'verify-export'
]);
function applyGovernanceCapabilityBoundary(root) {
  if (!root) return;
  const banner = root.querySelector('[data-governance-experimental-banner]');
  if (!window.NebulaCapabilityUI ||
      window.NebulaCapabilityUI.decision('governance').status !== 'Experimental') {
    if (banner) banner.remove();
    root.querySelectorAll('[data-governance-experimental-disabled="true"]').forEach(button => {
      button.disabled = button.dataset.governanceOriginalDisabled === 'true';
      const originalTitle = button.dataset.governanceOriginalTitle || '';
      if (originalTitle) button.title = originalTitle;
      else button.removeAttribute('title');
      delete button.dataset.governanceExperimentalDisabled;
      delete button.dataset.governanceOriginalDisabled;
      delete button.dataset.governanceOriginalTitle;
    });
    return;
  }
  const shell = root.querySelector('.gov-shell');
  if (shell && !banner) {
    const notice = document.createElement('div');
    notice.className = 'gov-banner warn';
    notice.setAttribute('role', 'status');
    notice.dataset.governanceExperimentalBanner = 'true';
    notice.textContent = 'Experimental provider governance is view-only; mutations remain unavailable.';
    const hero = shell.querySelector('.gov-hero');
    if (hero) hero.insertAdjacentElement('afterend', notice);
    else shell.prepend(notice);
  }
  root.querySelectorAll('[data-gov-action]').forEach(button => {
    if (GOVERNANCE_EXPERIMENTAL_VIEW_ACTIONS.includes(button.dataset.govAction)) return;
    if (button.dataset.governanceExperimentalDisabled !== 'true') {
      button.dataset.governanceOriginalDisabled = String(button.disabled);
      button.dataset.governanceOriginalTitle = button.getAttribute('title') || '';
    }
    button.dataset.governanceExperimentalDisabled = 'true';
    button.disabled = true;
    button.title = 'Unavailable: experimental governance is view-only for this provider.';
  });
}
function clearGovernanceState() {
  if (governanceExpiryTimer) clearTimeout(governanceExpiryTimer);
  governanceExpiryTimer = null;
  state.governance = { digitalTwin: null, access: null, loading: false, error: '', simulation: null, verification: null, scopeKey: '', decisionPages: [], delivery: { notifications: { events: [] }, preferences: {}, exports: [], webhooks: [], error: '' } };
  const root = $('#govRoot');
  if (root && window.NebulaGovernanceUI) root.innerHTML = window.NebulaGovernanceUI.renderGovernanceInterface({ loading: true });
  const live = $('#govLive');
  if (live) live.textContent = '';
}
function scheduleGovernanceAccessExpiry() {
  if (governanceExpiryTimer) clearTimeout(governanceExpiryTimer);
  governanceExpiryTimer = null;
  const access = state.governance.access;
  const expiresAt = new Date(access && access.evidence && access.evidence.expiresAt || 0).getTime();
  if (!Number.isFinite(expiresAt)) return;
  const delay = Math.max(0, Math.min(expiresAt - Date.now() + 25, 2_147_000_000));
  governanceExpiryTimer = setTimeout(() => {
    if (!state.governance.access) return;
    state.governance.access = {
      ...state.governance.access,
      capabilities: { read: false, author: false, review: false, activate: false, administer: false },
      evidence: { ...state.governance.access.evidence, status: 'stale' }
    };
    renderGovernanceInterface();
    announceGovernance('Repository permission evidence expired. Refresh governance before taking action.');
  }, delay);
}
function announceGovernance(message) {
  const live = $('#govLive');
  if (!live) return;
  live.textContent = '';
  requestAnimationFrame(() => { live.textContent = String(message || ''); });
}
function renderGovernanceInterface() {
  const root = $('#govRoot');
  if (!root || !window.NebulaGovernanceUI) return;
  $('#govRoot').innerHTML = window.NebulaGovernanceUI.renderGovernanceInterface({
    digitalTwin: state.governance.digitalTwin,
    access: state.governance.access,
    loading: state.governance.loading,
    error: state.governance.error,
    simulation: state.governance.simulation,
    verification: state.governance.verification,
    delivery: state.governance.delivery
  });
  applyGovernanceCapabilityBoundary(root);
}
async function loadGovernanceTwin(force = false) {
  if (!state.work || !state.work.owner || !state.work.repo || state.governance.loading) return;
  const expectedScope = `${state.work.owner}/${state.work.repo}`;
  if (!force && state.governance.digitalTwin && state.governance.scopeKey === expectedScope) {
    renderGovernanceInterface();
    return;
  }
  state.governance.loading = true;
  state.governance.error = '';
  renderGovernanceInterface();
  try {
    const response = await api(`/api/repo/${wPath()}/governance/digital-twin?historyLimit=50`);
    if (!state.work || `${state.work.owner}/${state.work.repo}` !== expectedScope) return;
    const previousHash = state.governance.digitalTwin && state.governance.digitalTwin.readModelHash;
    state.governance.digitalTwin = response.digitalTwin || null;
    state.governance.access = response.access || null;
    scheduleGovernanceAccessExpiry();
    state.governance.scopeKey = expectedScope;
    state.governance.error = '';
    if (previousHash && previousHash !== (response.digitalTwin && response.digitalTwin.readModelHash)) {
      state.governance.simulation = null;
      state.governance.verification = null;
      state.governance.decisionPages = [];
    }
    await loadGovernanceDelivery();
    announceGovernance('Policy Digital Twin and delivery evidence refreshed');
  } catch (error) {
    state.governance.error = error.message || 'Policy Digital Twin could not be loaded';
    announceGovernance(state.governance.error);
  } finally {
    state.governance.loading = false;
    renderGovernanceInterface();
  }
}
async function loadGovernanceDelivery() {
  const base = governanceBasePath();
  const requests = [
    api(`${base}/notifications?limit=50&afterSeq=0`),
    api(`${base}/notifications/preferences`),
    api(`${base}/exports?limit=50`)
  ];
  const canAdmin = state.governance.access && state.governance.access.capabilities && state.governance.access.capabilities.administer === true;
  if (canAdmin) requests.push(api(`${base}/webhooks`));
  const settled = await Promise.allSettled(requests);
  const errors = settled.filter(item => item.status === 'rejected').map(item => item.reason && item.reason.message || 'Delivery data unavailable');
  state.governance.delivery = {
    notifications: settled[0].status === 'fulfilled' ? settled[0].value : { events: [] },
    preferences: settled[1].status === 'fulfilled' ? (settled[1].value.preferences || {}) : {},
    exports: settled[2].status === 'fulfilled' ? (settled[2].value.exports || []) : [],
    webhooks: canAdmin && settled[3] && settled[3].status === 'fulfilled' ? (settled[3].value.webhooks || []) : [],
    error: errors.join(' · ')
  };
  renderGovernanceInterface();
}

async function verifyGovernanceDecisionChain() {
  const response = await api(`/api/repo/${wPath()}/governance/decisions/verify?limit=50000`);
  state.governance.verification = response.verification || response;
  renderGovernanceInterface();
  announceGovernance(state.governance.verification.valid === true ? 'Decision chain verified' : 'Decision chain verification failed');
}
async function loadMoreGovernanceDecisions(afterSeq) {
  const cursor = Number(afterSeq);
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('Decision cursor is invalid');
  const response = await api(`/api/repo/${wPath()}/governance/decisions?limit=50&afterSeq=${cursor}`);
  const page = response.decisions ? response : (response.result || response);
  const twin = state.governance.digitalTwin;
  if (!twin || !page || !Array.isArray(page.decisions)) return;
  const existing = Array.isArray(twin.history && twin.history.decisions) ? twin.history.decisions : [];
  const seen = new Set(existing.map(item => Number(item.seq)));
  const merged = existing.concat(page.decisions.filter(item => !seen.has(Number(item.seq))));
  state.governance.digitalTwin = {
    ...twin,
    history: {
      ...twin.history,
      decisions: merged,
      nextDecisionSeq: page.complete ? null : page.nextAfterSeq
    }
  };
  renderGovernanceInterface();
  announceGovernance(`${page.decisions.length} more decisions loaded`);
}


function governanceBasePath() { return `/api/repo/${wPath()}/governance`; }
function governanceIdempotencyKey(action) {
  const random = window.crypto && typeof window.crypto.randomUUID === 'function'
    ? window.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `governance-ui:${String(action || 'write')}:${random}`;
}
function governanceHeaders(action) { return { 'Idempotency-Key': governanceIdempotencyKey(action) }; }
function governancePolicy(policyId) {
  const policies = state.governance.digitalTwin && state.governance.digitalTwin.current && state.governance.digitalTwin.current.policies;
  return Array.isArray(policies) ? policies.find(item => item.policyId === policyId) : null;
}
function governanceDefaultDocument() {
  return { schemaVersion: 1, description: 'Repository governance policy.', enforcement: { mode: 'observe' }, rules: [] };
}
function governanceDefaultApproval() { return { requiredApprovals: 1, disallowAuthorApproval: true }; }
async function showGovernanceJson(title, value) {
  await modal({
    title,
    okText: 'Close',
    bodyHTML: `<pre class="mono gov-json-view">${esc(JSON.stringify(value, null, 2))}</pre>`
  });
}
function governanceReadJson(selector, label) {
  const element = $(selector);
  if (!window.NebulaGovernanceUI || !element) throw new Error(`${label} input is unavailable`);
  return window.NebulaGovernanceUI.parseJsonObject(element.value, label);
}
async function createGovernancePolicy() {
  const ok = await modal({
    title: 'Create governance policy', okText: 'Create policy',
    bodyHTML: `<label class="field-label" for="govPolicyKey">Stable policy key</label><input id="govPolicyKey" type="text" placeholder="release-safety" spellcheck="false">
      <label class="field-label" for="govPolicyName">Name</label><input id="govPolicyName" type="text" placeholder="Release safety">
      <label class="field-label" for="govPolicyDescription">Description</label><textarea id="govPolicyDescription" rows="4" placeholder="What this policy protects"></textarea>
      <p class="hint">Creating a policy does not create, submit or activate a version.</p>`
  });
  if (!ok) return;
  const policyKey = $('#govPolicyKey').value.trim();
  const name = $('#govPolicyName').value.trim();
  if (!policyKey || !name) throw new Error('Policy key and name are required');
  await api(`${governanceBasePath()}/policies`, {
    method: 'POST', headers: governanceHeaders('policy-create'),
    body: { policyKey, name, description: $('#govPolicyDescription').value.trim() }
  });
  toast('Governance policy created', 'ok');
  await loadGovernanceTwin(true);
}
async function createGovernanceDraft(policyId, seed) {
  let document = seed && seed.document ? seed.document : governanceDefaultDocument();
  let approvalPolicy = seed && seed.approvalPolicy ? seed.approvalPolicy : governanceDefaultApproval();
  const ok = await modal({
    title: 'Create policy draft', okText: 'Create draft',
    bodyHTML: `<label class="field-label" for="govDraftDocument">Policy document (JSON)</label><textarea id="govDraftDocument" rows="14" class="mono" spellcheck="false">${esc(JSON.stringify(document, null, 2))}</textarea>
      <label class="field-label" for="govDraftApproval">Approval policy (JSON)</label><textarea id="govDraftApproval" rows="5" class="mono" spellcheck="false">${esc(JSON.stringify(approvalPolicy, null, 2))}</textarea>
      <p class="hint">The draft remains mutable until submission. Nothing is activated automatically.</p>`
  });
  if (!ok) return;
  document = governanceReadJson('#govDraftDocument', 'Policy document');
  approvalPolicy = governanceReadJson('#govDraftApproval', 'Approval policy');
  await api(`${governanceBasePath()}/policies/${encodeURIComponent(policyId)}/drafts`, {
    method: 'POST', headers: governanceHeaders('draft-create'), body: { document, approvalPolicy }
  });
  toast('Draft created', 'ok');
  await loadGovernanceTwin(true);
}
/*
 * What the generated policy says about itself, in prose. A baseline can run to
 * hundreds of rules, and the sentence that matters most -- that it records
 * rather than blocks until it is activated -- should not have to be found
 * inside the JSON below it.
 */
function baselineSummary(baseline) {
  const description = baseline && baseline.document && typeof baseline.document.description === 'string'
    ? baseline.document.description.trim()
    : '';
  const mode = baseline && baseline.document && baseline.document.enforcement
    ? String(baseline.document.enforcement.mode || '')
    : '';
  const ruleCount = baseline && baseline.document && Array.isArray(baseline.document.rules)
    ? baseline.document.rules.length
    : 0;
  if (!description && !mode) return '';
  const counts = [
    ruleCount ? `${ruleCount} rule${ruleCount === 1 ? '' : 's'}` : 'no rules',
    mode ? `${mode} mode` : ''
  ].filter(Boolean).join(' \u00b7 ');
  return `<p class="hint gov-baseline-summary"><strong>${esc(counts)}</strong>${description ? ` \u2014 ${esc(description)}` : ''}</p>`;
}

async function generateGovernanceBaseline() {
  const catalog = await api(`${governanceBasePath()}/templates`);
  const templates = Array.isArray(catalog.templates) ? catalog.templates : (Array.isArray(catalog.templates && catalog.templates.templates) ? catalog.templates.templates : []);
  if (!templates.length) throw new Error('No governance templates are available');
  const options = templates.map(item => `<option value="${escAttr(item.templateId)}">${esc(item.name || item.templateId)}</option>`).join('');
  const ok = await modal({
    title: 'Generate repository baseline', okText: 'Generate',
    bodyHTML: `<label class="field-label" for="govTemplateId">Template</label><select id="govTemplateId">${options}</select>
      <p class="hint">Generation is read-only. The result is not persisted or activated.</p>`
  });
  if (!ok) return;
  const templateId = $('#govTemplateId').value;
  const selectedTemplate = templates.find(item => item.templateId === templateId) || {};
  const response = await api(`${governanceBasePath()}/baselines/generate`, { method: 'POST', body: { templateId } });
  const baseline = response.baseline;
  const accept = await modal({
    title: 'Baseline generated', okText: 'Create policy and draft',
    bodyHTML: `<div class="gov-banner ${baseline && baseline.readiness && baseline.readiness.status === 'ready' ? 'ok' : 'warn'}"><strong>${baseline && baseline.readiness && baseline.readiness.status === 'ready' ? 'Repository facts complete' : 'Review incomplete repository facts'}</strong></div>
      <label class="field-label" for="govBaselineKey">Policy key</label><input id="govBaselineKey" type="text" value="${escAttr((baseline.templateId || 'baseline').replace(/[^a-z0-9._-]+/gi, '-').toLowerCase())}" spellcheck="false">
      <label class="field-label" for="govBaselineName">Policy name</label><input id="govBaselineName" type="text" value="${escAttr(selectedTemplate.name || 'Repository baseline')}">
      ${baselineSummary(baseline)}
      <pre class="mono gov-json-view">${esc(JSON.stringify(baseline, null, 2))}</pre>`
  });
  if (!accept) return;
  const created = await api(`${governanceBasePath()}/policies`, {
    method: 'POST', headers: governanceHeaders('baseline-policy-create'),
    body: { policyKey: $('#govBaselineKey').value.trim(), name: $('#govBaselineName').value.trim(), description: `Generated from ${baseline.templateId}` }
  });
  await api(`${governanceBasePath()}/policies/${encodeURIComponent(created.policy.policyId)}/drafts`, {
    method: 'POST', headers: governanceHeaders('baseline-draft-create'),
    body: { document: baseline.document, approvalPolicy: baseline.approvalPolicy }
  });
  toast('Baseline policy draft created', 'ok');
  await loadGovernanceTwin(true);
}
async function inspectGovernancePolicy(policyId) {
  const [policy, versions] = await Promise.all([
    api(`${governanceBasePath()}/policies/${encodeURIComponent(policyId)}`),
    api(`${governanceBasePath()}/policies/${encodeURIComponent(policyId)}/versions?limit=100`)
  ]);
  await showGovernanceJson('Policy state', { policy: policy.policy, versions: versions.versions });
}
async function editGovernanceDraft(policyId, draftId) {
  const response = await api(`${governanceBasePath()}/policies/${encodeURIComponent(policyId)}/drafts/${encodeURIComponent(draftId)}`);
  const draft = response.draft;
  const approvalPolicy = { requiredApprovals: draft.requiredApprovals, disallowAuthorApproval: draft.disallowAuthorApproval };
  const ok = await modal({
    title: `Edit draft r${draft.revision}`, okText: 'Save draft',
    bodyHTML: `<label class="field-label" for="govEditDocument">Policy document (JSON)</label><textarea id="govEditDocument" rows="14" class="mono" spellcheck="false">${esc(JSON.stringify(draft.document, null, 2))}</textarea>
      <label class="field-label" for="govEditApproval">Approval policy (JSON)</label><textarea id="govEditApproval" rows="5" class="mono" spellcheck="false">${esc(JSON.stringify(approvalPolicy, null, 2))}</textarea>`
  });
  if (!ok) return;
  await api(`${governanceBasePath()}/policies/${encodeURIComponent(policyId)}/drafts/${encodeURIComponent(draftId)}`, {
    method: 'PATCH', headers: governanceHeaders('draft-update'),
    body: { expectedRevision: draft.revision, document: governanceReadJson('#govEditDocument', 'Policy document'), approvalPolicy: governanceReadJson('#govEditApproval', 'Approval policy') }
  });
  toast('Draft saved', 'ok');
  await loadGovernanceTwin(true);
}
async function validateGovernanceDraft(policyId, draftId) {
  const response = await api(`${governanceBasePath()}/policies/${encodeURIComponent(policyId)}/drafts/${encodeURIComponent(draftId)}/validate`, { method: 'POST', body: {} });
  await showGovernanceJson('Draft validation', response.validation);
}
async function submitGovernanceDraft(policyId, draftId, revision) {
  const ok = await modal({ title: 'Submit immutable version?', danger: true, okText: 'Submit version', bodyHTML: '<p>Submission freezes this draft as a new immutable policy version. It does not activate it.</p>' });
  if (!ok) return;
  await api(`${governanceBasePath()}/policies/${encodeURIComponent(policyId)}/drafts/${encodeURIComponent(draftId)}/submit`, {
    method: 'POST', headers: governanceHeaders('draft-submit'), body: { expectedRevision: Number(revision) }
  });
  toast('Immutable policy version submitted', 'ok');
  await loadGovernanceTwin(true);
}
async function viewGovernanceVersion(policyId, versionId) {
  const response = await api(`${governanceBasePath()}/policies/${encodeURIComponent(policyId)}/versions/${encodeURIComponent(versionId)}`);
  await showGovernanceJson('Immutable policy version', response.version);
}
async function simulateGovernanceVersion(policyId, versionId) {
  const previous = state.governance.simulation && state.governance.simulation.policyId === policyId && state.governance.simulation.versionId === versionId
    ? state.governance.simulation.request
    : window.NebulaGovernanceUI.defaultSimulationRequest(state.work.default_branch || state.work.branch || 'main');
  const ok = await modal({
    title: 'Simulate policy version', okText: 'Run simulation',
    bodyHTML: `<label class="field-label" for="govSimulationRequest">Bounded scenario request (JSON)</label><textarea id="govSimulationRequest" rows="16" class="mono" spellcheck="false">${esc(JSON.stringify(previous, null, 2))}</textarea>
      <p class="hint">Simulation is read-only and must exercise every proposed rule before activation.</p>`
  });
  if (!ok) return null;
  const request = governanceReadJson('#govSimulationRequest', 'Simulation request');
  const response = await api(`${governanceBasePath()}/policies/${encodeURIComponent(policyId)}/versions/${encodeURIComponent(versionId)}/simulate`, { method: 'POST', body: request });
  state.governance.simulation = { policyId, versionId, request, report: response.simulation };
  renderGovernanceInterface();
  announceGovernance(response.simulation.activationReadiness && response.simulation.activationReadiness.eligible ? 'Simulation is eligible for activation review' : 'Simulation contains activation blockers');
  await showGovernanceJson('Simulation evidence', response.simulation);
  return state.governance.simulation;
}
async function claimGovernanceReview(policyId, versionId) {
  await api(`${governanceBasePath()}/policies/${encodeURIComponent(policyId)}/versions/${encodeURIComponent(versionId)}/reviewers/me`, { method: 'POST', headers: governanceHeaders('review-claim'), body: {} });
  toast('Review assignment claimed', 'ok');
  await loadGovernanceTwin(true);
}
async function decideGovernanceReview(policyId, versionId, decision) {
  const rejecting = decision === 'reject';
  const ok = await modal({
    title: rejecting ? 'Reject policy version' : 'Approve policy version', danger: rejecting, okText: rejecting ? 'Reject' : 'Approve',
    bodyHTML: `<p>${rejecting ? 'Rejection is terminal for this review.' : 'Your approval becomes immutable governance evidence.'}</p>
      <label class="field-label" for="govReviewRationale">Rationale${rejecting ? ' (required)' : ''}</label><textarea id="govReviewRationale" rows="5"></textarea>`
  });
  if (!ok) return;
  await api(`${governanceBasePath()}/policies/${encodeURIComponent(policyId)}/versions/${encodeURIComponent(versionId)}/decisions`, {
    method: 'POST', headers: governanceHeaders(`review-${decision}`),
    body: { decision, rationale: $('#govReviewRationale').value.trim() }
  });
  toast(`Policy version ${decision === 'approve' ? 'approved' : 'rejected'}`, 'ok');
  await loadGovernanceTwin(true);
}
async function governanceActivateOrRollback(policyId, versionId, operation) {
  let simulation = state.governance.simulation;
  if (!simulation || simulation.policyId !== policyId || simulation.versionId !== versionId || !simulation.report || !simulation.report.activationReadiness || simulation.report.activationReadiness.eligible !== true) {
    simulation = await simulateGovernanceVersion(policyId, versionId);
  }
  if (!simulation || !simulation.report.activationReadiness.eligible) throw new Error('An eligible fresh simulation is required');
  const policy = governancePolicy(policyId) || (await api(`${governanceBasePath()}/policies/${encodeURIComponent(policyId)}`)).policy;
  const ok = await modal({
    title: operation === 'rollback' ? 'Rollback active policy?' : 'Activate policy version?', danger: true,
    okText: operation === 'rollback' ? 'Rollback' : 'Activate',
    bodyHTML: `<p>This changes the authoritative policy head after server-side evidence is recomputed.</p><label class="field-label" for="govActivationReason">Reason</label><textarea id="govActivationReason" rows="5"></textarea>`
  });
  if (!ok) return;
  await api(`${governanceBasePath()}/policies/${encodeURIComponent(policyId)}/versions/${encodeURIComponent(versionId)}/${operation}`, {
    method: 'POST', headers: governanceHeaders(`policy-${operation}`),
    body: { expectedRevision: Number(policy.revision), reason: $('#govActivationReason').value.trim(), simulation: { simulationHash: simulation.report.simulationHash, request: simulation.request } }
  });
  state.governance.simulation = null;
  toast(operation === 'rollback' ? 'Policy rolled back' : 'Policy activated', 'ok');
  await loadGovernanceTwin(true);
}
async function requestGovernanceException(policyId, versionId) {
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  tomorrow.setSeconds(0, 0);
  const local = new Date(tomorrow.getTime() - tomorrow.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const ok = await modal({
    title: 'Request exception or waiver', okText: 'Submit request',
    bodyHTML: `<label class="field-label" for="govExceptionKind">Kind</label><select id="govExceptionKind"><option value="exception">Exception (deny rules)</option><option value="waiver">Waiver (approval rules)</option></select>
      <label class="field-label" for="govExceptionAction">Registered mutation action</label><input id="govExceptionAction" type="text" placeholder="file.write" spellcheck="false">
      <label class="field-label" for="govExceptionRules">Rule IDs (comma separated)</label><input id="govExceptionRules" type="text" placeholder="protected-main-write" spellcheck="false">
      <label class="field-label" for="govExceptionTarget">Exact mutation target (JSON)</label><textarea id="govExceptionTarget" rows="6" class="mono" spellcheck="false">${esc(JSON.stringify({ branch: state.work.branch }, null, 2))}</textarea>
      <label class="field-label" for="govExceptionExpires">Expires</label><input id="govExceptionExpires" type="datetime-local" value="${escAttr(local)}">
      <label class="field-label" for="govExceptionReason">Reason</label><textarea id="govExceptionReason" rows="5"></textarea>
      <p class="hint">The request is bound to your verified human identity and this exact target.</p>`
  });
  if (!ok) return;
  const expiresAt = new Date($('#govExceptionExpires').value).toISOString();
  const ruleIds = $('#govExceptionRules').value.split(',').map(value => value.trim()).filter(Boolean);
  await api(`${governanceBasePath()}/policies/${encodeURIComponent(policyId)}/versions/${encodeURIComponent(versionId)}/exceptions`, {
    method: 'POST', headers: governanceHeaders('exception-request'),
    body: { kind: $('#govExceptionKind').value, action: $('#govExceptionAction').value.trim(), ruleIds, target: governanceReadJson('#govExceptionTarget', 'Mutation target'), reason: $('#govExceptionReason').value.trim(), expiresAt }
  });
  toast('Exception request submitted', 'ok');
  await loadGovernanceTwin(true);
}
async function viewGovernanceException(exceptionId) {
  const response = await api(`${governanceBasePath()}/exceptions/${encodeURIComponent(exceptionId)}`);
  await showGovernanceJson('Exception evidence', response.exception);
}
async function decideGovernanceException(exceptionId) {
  const ok = await modal({
    title: 'Decide exception request', okText: 'Record decision', danger: true,
    bodyHTML: `<label class="field-label" for="govExceptionDecision">Decision</label><select id="govExceptionDecision"><option value="approve">Approve</option><option value="reject">Reject</option></select>
      <label class="field-label" for="govExceptionDecisionReason">Reason</label><textarea id="govExceptionDecisionReason" rows="5"></textarea>
      <p class="hint">The requester cannot approve their own request.</p>`
  });
  if (!ok) return;
  await api(`${governanceBasePath()}/exceptions/${encodeURIComponent(exceptionId)}/decision`, {
    method: 'POST', headers: governanceHeaders('exception-decision'),
    body: { decision: $('#govExceptionDecision').value, reason: $('#govExceptionDecisionReason').value.trim() }
  });
  toast('Exception decision recorded', 'ok');
  await loadGovernanceTwin(true);
}
async function revokeGovernanceException(exceptionId) {
  const ok = await modal({ title: 'Revoke exception?', danger: true, okText: 'Revoke', bodyHTML: '<label class="field-label" for="govExceptionRevokeReason">Reason</label><textarea id="govExceptionRevokeReason" rows="5"></textarea>' });
  if (!ok) return;
  await api(`${governanceBasePath()}/exceptions/${encodeURIComponent(exceptionId)}/revoke`, {
    method: 'POST', headers: governanceHeaders('exception-revoke'), body: { reason: $('#govExceptionRevokeReason').value.trim() }
  });
  toast('Exception revoked', 'ok');
  await loadGovernanceTwin(true);
}

async function editGovernanceNotificationPreferences() {
  const current = state.governance.delivery.preferences || {};
  const enabled = current.enabled !== false;
  const types = Array.isArray(current.eventTypes) ? current.eventTypes.join('\n') : '';
  const ok = await modal({ title: 'Notification preferences', okText: 'Save preferences', bodyHTML: `<label class="field-label"><input id="govNotificationEnabled" type="checkbox" ${enabled ? 'checked' : ''}> Enable notifications</label><label class="field-label" for="govNotificationTypes">Event types, one per line</label><textarea id="govNotificationTypes" rows="10">${esc(types)}</textarea>` });
  if (!ok) return;
  const eventTypes = $('#govNotificationTypes').value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  await api(`${governanceBasePath()}/notifications/preferences`, { method: 'PUT', headers: governanceHeaders('notification-preferences'), body: { enabled: $('#govNotificationEnabled').checked, eventTypes } });
  await loadGovernanceDelivery();
}
async function markGovernanceNotificationsRead(throughSeq) {
  await api(`${governanceBasePath()}/notifications/read`, { method: 'POST', headers: governanceHeaders('notification-read'), body: { throughSeq: Number(throughSeq) } });
  await loadGovernanceDelivery();
}
async function createGovernanceEvidenceExport() {
  const ok = await modal({ title: 'Create signed evidence export', okText: 'Create export', bodyHTML: '<label class="field-label" for="govExportFormat">Format</label><select id="govExportFormat"><option value="json">JSON</option><option value="csv">CSV</option></select><label class="field-label" for="govExportLimit">Maximum events (1–1000)</label><input id="govExportLimit" type="number" min="1" max="1000" value="1000">' });
  if (!ok) return;
  await api(`${governanceBasePath()}/exports`, { method: 'POST', headers: governanceHeaders('audit-export'), body: { format: $('#govExportFormat').value, afterEventSeq: 0, limit: Number($('#govExportLimit').value) } });
  await loadGovernanceDelivery();
}
function downloadGovernanceExport(exportId) {
  const a = document.createElement('a');
  a.href = `${governanceBasePath()}/exports/${encodeURIComponent(exportId)}`;
  document.body.appendChild(a); a.click(); a.remove();
}
async function verifyGovernanceExport(exportId) {
  const result = await api(`${governanceBasePath()}/exports/${encodeURIComponent(exportId)}/verify`);
  await showGovernanceJson('Evidence export verification', result.verification || result);
}
async function createGovernanceWebhook() {
  const ok = await modal({ title: 'Add governance webhook', okText: 'Create webhook', bodyHTML: '<label class="field-label" for="govWebhookName">Name</label><input id="govWebhookName" maxlength="120"><label class="field-label" for="govWebhookUrl">HTTPS URL</label><input id="govWebhookUrl" type="url" placeholder="https://hooks.example.com/governance"><label class="field-label" for="govWebhookTypes">Event types, one per line</label><textarea id="govWebhookTypes" rows="8">policy.activated\npolicy.decision.block</textarea>' });
  if (!ok) return;
  const result = await api(`${governanceBasePath()}/webhooks`, { method: 'POST', headers: governanceHeaders('webhook-create'), body: { name: $('#govWebhookName').value.trim(), url: $('#govWebhookUrl').value.trim(), eventTypes: $('#govWebhookTypes').value.split(/\r?\n/).map(v => v.trim()).filter(Boolean), enabled: true } });
  await showGovernanceJson('Webhook signing secret — save now', { signingSecret: result.signingSecret, warning: 'This secret is shown once and cannot be recovered.' });
  await loadGovernanceDelivery();
}
async function rotateGovernanceWebhook(webhookId) {
  const ok = await modal({ title: 'Rotate webhook secret?', danger: true, okText: 'Rotate secret', bodyHTML: '<p>The previous secret will stop signing future deliveries. Update the receiver immediately.</p>' });
  if (!ok) return;
  const result = await api(`${governanceBasePath()}/webhooks/${encodeURIComponent(webhookId)}/rotate-secret`, { method: 'POST', headers: governanceHeaders('webhook-rotate'), body: {} });
  await showGovernanceJson('Rotated webhook secret — save now', { signingSecret: result.signingSecret, warning: 'This secret is shown once and cannot be recovered.' });
  await loadGovernanceDelivery();
}
async function deleteGovernanceWebhook(webhookId) {
  const ok = await modal({ title: 'Delete webhook?', danger: true, okText: 'Delete webhook', bodyHTML: '<p>Future deliveries to this endpoint will stop.</p>' });
  if (!ok) return;
  await api(`${governanceBasePath()}/webhooks/${encodeURIComponent(webhookId)}`, { method: 'DELETE', headers: governanceHeaders('webhook-delete'), body: {} });
  await loadGovernanceDelivery();
}

const governanceActionHandlers = Object.freeze({
  refresh: () => loadGovernanceTwin(true),
  'create-policy': () => createGovernancePolicy(),
  'generate-baseline': () => generateGovernanceBaseline(),
  'select-policy': button => inspectGovernancePolicy(button.dataset.policyId),
  'new-draft': button => createGovernanceDraft(button.dataset.policyId),
  'edit-draft': button => editGovernanceDraft(button.dataset.policyId, button.dataset.draftId),
  'validate-draft': button => validateGovernanceDraft(button.dataset.policyId, button.dataset.draftId),
  'submit-draft': button => submitGovernanceDraft(button.dataset.policyId, button.dataset.draftId, button.dataset.revision),
  'view-version': button => viewGovernanceVersion(button.dataset.policyId, button.dataset.versionId),
  simulate: button => simulateGovernanceVersion(button.dataset.policyId, button.dataset.versionId),
  'claim-review': button => claimGovernanceReview(button.dataset.policyId, button.dataset.versionId),
  approve: button => decideGovernanceReview(button.dataset.policyId, button.dataset.versionId, 'approve'),
  reject: button => decideGovernanceReview(button.dataset.policyId, button.dataset.versionId, 'reject'),
  activate: button => governanceActivateOrRollback(button.dataset.policyId, button.dataset.versionId, 'activate'),
  rollback: button => governanceActivateOrRollback(button.dataset.policyId, button.dataset.versionId, 'rollback'),
  'request-exception': button => requestGovernanceException(button.dataset.policyId, button.dataset.versionId),
  'view-exception': button => viewGovernanceException(button.dataset.exceptionId),
  'decide-exception': button => decideGovernanceException(button.dataset.exceptionId),
  'revoke-exception': button => revokeGovernanceException(button.dataset.exceptionId),
  'verify-chain': () => verifyGovernanceDecisionChain(),
  'load-more-decisions': button => loadMoreGovernanceDecisions(button.dataset.afterSeq),
  'delivery-refresh': () => loadGovernanceDelivery(),
  'edit-notification-preferences': () => editGovernanceNotificationPreferences(),
  'mark-notifications-read': button => markGovernanceNotificationsRead(button.dataset.throughSeq),
  'create-export': () => createGovernanceEvidenceExport(),
  'download-export': button => downloadGovernanceExport(button.dataset.exportId),
  'verify-export': button => verifyGovernanceExport(button.dataset.exportId),
  'create-webhook': () => createGovernanceWebhook(),
  'rotate-webhook': button => rotateGovernanceWebhook(button.dataset.webhookId),
  'delete-webhook': button => deleteGovernanceWebhook(button.dataset.webhookId)
});
const governanceRoot = $('#govRoot');
if (governanceRoot) governanceRoot.addEventListener('click', async event => {
  const button = event.target.closest('[data-gov-action]');
  if (!button || button.disabled) return;
  const handler = governanceActionHandlers[button.dataset.govAction];
  if (!handler) return;
  const previousFocus = document.activeElement;
  button.disabled = true;
  try { await handler(button); }
  catch (error) { toast(error.message || 'Governance action failed', 'err'); announceGovernance(error.message || 'Governance action failed'); }
  finally { if (button.isConnected) button.disabled = false; if (previousFocus && previousFocus.isConnected) previousFocus.focus(); }
});

async function refreshRate() {
  try {
    const r = await api('/api/rate');
    $('#rateChip').hidden = false;
    $('#rateVal').textContent = `${r.remaining}/${r.limit}`;
    $('#rateChip').style.color = r.remaining < 200 ? 'var(--amber)' : '';
  } catch {}
}

/* ---------------- tree ---------------- */
/*
 * Which of the editor's two resting states applies. Kept beside the tree load
 * because the tree is the only thing that knows whether there is anything to
 * pick.
 */
function markEmptyRepository(bare) {
  const pick = $('.editor-empty-pick');
  const empty = $('.editor-empty-bare');
  if (!pick || !empty) return;
  pick.hidden = bare;
  empty.hidden = !bare;
}

/*
 * The tree's marks, drawn rather than typed.
 *
 * A directory used to be U+25B8 and a file U+00B7 -- a period, set at 15px in
 * the muted colour, against a column of filenames. It read as nothing, and
 * this is the control the workbench is navigated with. These follow the same
 * geometry as every other icon in the product: a 24 box, stroked, no fill.
 *
 * The directory chevron points right and is rotated by CSS when the row opens,
 * so the open and closed states are one mark in two positions rather than two
 * marks that have to be kept in agreement.
 */
/*
 * The marks for a screen with nothing on it.
 *
 * Six empty states shared four Unicode glyphs between them -- a sparkle stood
 * for an unopened file, an untagged release and a workflow that has never run,
 * which tells a reader nothing about which screen they are on. Each one now
 * draws the thing it is the absence of.
 */
const EMPTY_ICON = Object.freeze({
  file: '<svg class="empty-mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M13.5 3.5H7a1.5 1.5 0 0 0-1.5 1.5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8.5z"/><path d="M13.5 3.5V8.5h5"/></svg>',
  repos: '<svg class="empty-mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5.5A1.5 1.5 0 0 1 6.5 4H19v16H6.5A1.5 1.5 0 0 1 5 18.5z"/><path d="M8.5 4v16"/></svg>',
  pulls: '<svg class="empty-mark" viewBox="0 0 24 24" aria-hidden="true"><circle cx="7" cy="6.5" r="2.3"/><circle cx="7" cy="17.5" r="2.3"/><circle cx="17" cy="12" r="2.3"/><path d="M7 8.8v6.4M9.3 6.5H13a1.7 1.7 0 0 1 1.7 1.7v2.1"/></svg>',
  issues: '<svg class="empty-mark" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.2"/></svg>',
  releases: '<svg class="empty-mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M11 3.5h8.5V12l-7.9 7.9a1.6 1.6 0 0 1-2.3 0l-5.2-5.2a1.6 1.6 0 0 1 0-2.3z"/><circle cx="15.6" cy="7.9" r="1.4"/></svg>',
  actions: '<svg class="empty-mark" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M10.4 9.3l4.6 2.7-4.6 2.7z"/></svg>'
});

/*
 * Marks that sit beside a number or inside a small control.
 *
 * The last of the typed glyphs: a star, a fork, a speech bubble and a close
 * cross, all standing where the rest of the product draws. The fork also
 * appears in the branch <select>, and stays typed there -- a native option
 * element holds text and nothing else, so that one is a real constraint rather
 * than an oversight.
 */
const META_ICON = Object.freeze({
  star: '<svg class="meta-mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.8l2.6 5.2 5.8.9-4.2 4 1 5.7-5.2-2.7-5.2 2.7 1-5.7-4.2-4 5.8-.9z"/></svg>',
  fork: '<svg class="meta-mark" viewBox="0 0 24 24" aria-hidden="true"><circle cx="7" cy="6.2" r="2.2"/><circle cx="17" cy="6.2" r="2.2"/><circle cx="12" cy="18" r="2.2"/><path d="M7 8.4v1.2a3 3 0 0 0 3 3h4a3 3 0 0 0 3-3V8.4M12 12.6v3.2"/></svg>',
  comments: '<svg class="meta-mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M20.4 12.2a6.8 6.8 0 0 1-6.8 6.8H8.9L4.6 21.4v-4.5a6.8 6.8 0 0 1 4.3-11.7h4.7a6.8 6.8 0 0 1 6.8 6.8z"/></svg>',
  close: '<svg class="ico" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>'
});

const TREE_ICON = Object.freeze({
  dir: '<svg class="ti-mark ti-mark-dir" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>',
  file: '<svg class="ti-mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M13.5 3.5H7a1.5 1.5 0 0 0-1.5 1.5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8.5z"/><path d="M13.5 3.5V8.5h5"/></svg>',
  hit: '<svg class="ti-mark" viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/></svg>'
});

async function loadTree(dirPath, host, isRoot) {
  if (isRoot) host.innerHTML = '<div class="skeleton" style="height:160px"></div>';
  try {
    const items = await api(`/api/repo/${wPath()}/tree?ref=${encodeURIComponent(state.work.branch)}&path=${encodeURIComponent(dirPath)}`);
    const frag = document.createDocumentFragment();
    items.forEach((it, idx) => {
      const row = document.createElement('div');
      row.className = 'tree-item' + (it.type === 'dir' ? ' dir' : '');
      row.style.animationDelay = Math.min(idx * 20, 240) + 'ms';
      row.innerHTML = `<span class="ti-icon">${it.type === 'dir' ? TREE_ICON.dir : TREE_ICON.file}</span><span class="ti-name"></span>
        ${it.type === 'file' ? `<span class="tree-size">${fmtSize(it.size)}</span>` : ''}`;
      row.querySelector('.ti-name').textContent = it.name;
      attachItemMenu(row, it);
      if (it.type === 'dir') {
        let open = false, sub = null;
        row.addEventListener('click', async () => {
          open = !open;
          row.classList.toggle('open', open);
          if (open && !sub) {
            sub = document.createElement('div'); sub.className = 'tree-indent'; row.after(sub);
            await loadTree(it.path, sub, false);
          } else if (sub) sub.style.display = open ? '' : 'none';
        });
      } else {
        row.addEventListener('click', () => {
          $$('.tree-item').forEach(t => t.classList.remove('active'));
          row.classList.add('active');
          openFile(it.path);
          closeDrawer();
        });
      }
      frag.appendChild(row);
    });
    if (isRoot) host.innerHTML = '';
    host.appendChild(frag);
    if (isRoot && !items.length) host.innerHTML = '<div class="tree-item">Empty repository</div>';
    /*
     * The editor's resting state follows the tree. It reads "Pick a file from
     * the constellation on the left" -- true with files, and an instruction
     * that cannot be carried out without them, printed alongside a tree
     * already saying the repository is empty.
     */
    if (isRoot) markEmptyRepository(!items.length);
  } catch (e) { if (isRoot) host.innerHTML = `<div class="tree-item">⚠ ${esc(e.message)}</div>`; }
}

/* ---- item context menu (long-press on touch, right-click on desktop) ---- */
let _lpTimer = null, _lpFired = false;
function attachItemMenu(row, it) {
  row.addEventListener('click', e => {
    if (_lpFired) { e.stopImmediatePropagation(); e.preventDefault(); _lpFired = false; }
  });
  row.addEventListener('contextmenu', e => { e.preventDefault(); openItemMenu(it); });
  row.addEventListener('touchstart', () => {
    _lpFired = false;
    _lpTimer = setTimeout(() => { _lpFired = true; hapt(14); openItemMenu(it); }, 520);
  }, { passive: true });
  ['touchend', 'touchmove', 'touchcancel'].forEach(ev =>
    row.addEventListener(ev, () => clearTimeout(_lpTimer), { passive: true }));
}
function openItemMenu(it) {
  const isDir = it.type === 'dir';
  modal({
    title: it.name + (isDir ? '/' : ''), okText: 'Close',
    bodyHTML: `
      ${isDir ? '' : `<button class="btn btn-ghost btn-block" data-mi="open" style="margin-top:0">Open in editor</button>
      <button class="btn btn-ghost btn-block" data-mi="rename" data-feature="file.rename" data-allow-experimental="true">Rename / move</button>
      <button class="btn btn-ghost btn-block" data-mi="download">Download</button>`}
      ${isDir ? '<button class="btn btn-ghost btn-block" data-mi="movedir" data-feature="folder.move" data-allow-experimental="true">Rename / move folder…</button>'
        : `<button class="btn btn-ghost btn-block" data-mi="protect">${isProtectedPath(it.path) ? 'Unprotect file' : 'Protect file'}</button>`}
      <button class="btn btn-ghost btn-block danger" data-mi="delete" ${isDir ? 'style="margin-top:0"' : ''}>${isDir ? 'Delete folder…' : 'Delete file…'}</button>`
  });
  if (window.NebulaCapabilityUI) NebulaCapabilityUI.apply($('#modalBody'));
  $('#modalBody').addEventListener('click', async e => {
    const b = e.target.closest('[data-mi]');
    if (!b) return;
    const act = b.dataset.mi;
    closeModal(false);
    if (act === 'open') openFile(it.path);
    else if (act === 'download') {
      if (ownerWorkbench) { toast('File downloads are not connected to the owner workbench yet.', 'err'); return; }
      const a = document.createElement('a');
      a.href = `/api/repo/${wPath()}/raw?ref=${encodeURIComponent(state.work.branch)}&path=${encodeURIComponent(it.path)}`;
      a.download = it.name; document.body.appendChild(a); a.click(); a.remove();
    }
    else if (act === 'rename') {
      const ok = await modal({
        title: 'Rename / move',
        bodyHTML: `<label class="field-label" for="rnTo2">New path</label><input id="rnTo2" type="text" value="${esc(it.path)}" spellcheck="false">`,
        okText: 'Rename ✦'
      });
      if (!ok) return;
      const to = $('#rnTo2').value.trim().replace(/^\/+/, '');
      if (!to || to === it.path) return;
      try {
        const out = await api(`/api/repo/${wPath()}/rename`, { method: 'POST', body: guardedWrite({ from: it.path, to, branch: state.work.branch }) });
        rememberHead(out.commit);
        toast(`Renamed to ${to} ✦`, 'ok');
        state.fileIndex = null; loadTree('', $('#tree'), true);
      } catch (e2) { toast(e2.message, 'err'); }
    }
    else if (act === 'delete' && !isDir) {
      const ok = await modal({
        title: 'Delete file',
        bodyHTML: `<p style="font-size:.9rem;line-height:1.5">Delete <b class="mono">${esc(it.path)}</b> from <b>${esc(state.work.branch)}</b>?</p>`,
        okText: 'Delete', danger: true
      });
      if (!ok) return;
      try {
        const out = await api(`/api/repo/${wPath()}/file`, { method: 'DELETE', body: guardedWrite({ path: it.path, branch: state.work.branch, sha: it.sha }) });
        rememberHead(out.commit);
        toast('File deleted', 'ok');
        if (state.file && state.file.path === it.path) closeFile();
        state.fileIndex = null; loadTree('', $('#tree'), true);
      } catch (e2) { toast(e2.message, 'err'); }
    }
    else if (act === 'delete' && isDir) deleteFolderFlow(it.path);
    else if (act === 'movedir') moveFolderFlow(it.path);
    else if (act === 'protect') toggleProtect(it.path);
  }, { once: false });
}
/* ================= SAFEGUARDS ================= */
function safetyKey() { return (state.work && state.work.owner) ? `${state.work.owner}/${state.work.repo}` : ''; }
function protectedList() { return ((state.safety && state.safety.protected) || {})[ownerWorkbench ? safetyKey().toLowerCase() : safetyKey()] || []; }
function protectedPatternMatch(pattern, value) {
  const p = String(pattern || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const v = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!/[?*]/.test(p)) return v === p || v.startsWith(p + '/');
  let rx = '^';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') { if (p[i + 1] === '*') { i++; rx += '.*'; } else rx += '[^/]*'; }
    else if (c === '?') rx += '[^/]';
    else rx += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  try { return new RegExp(rx + '$').test(v); } catch { return false; }
}
function isProtectedPath(p) { return protectedList().some(pattern => protectedPatternMatch(pattern, p)); }
function isExactProtectedPath(p) { return protectedList().includes(String(p).replace(/^\/+/, '')); }
async function refreshSafety() {
  try { state.safety = await api('/api/safety'); }
  catch { state.safety = state.safety || { readOnly: !!ownerWorkbench, freezeSync: false, protected: {} }; }
  applySafetyUI();
}
async function setSafety(patch) {
  try { state.safety = await api('/api/safety', { method: 'POST', body: patch }); applySafetyUI(); return true; }
  catch (e) { toast(e.message, 'err'); return false; }
}
function applySafetyUI() {
  const ro = !!(state.safety && state.safety.readOnly);
  document.body.classList.toggle('read-only', ro);
  const chip = $('#roChip'); if (chip) chip.hidden = !ro;
  const fz = $('#freezeChip'); if (fz) fz.hidden = !(state.safety && state.safety.freezeSync);
  if (ro) ['commitFileBtn', 'newFileBtn'].forEach(id => { const el = $('#' + id); if (el) el.disabled = true; });
}
function dlFile(name, text, type) {
  const a = document.createElement('a');
  a.setAttribute('aria-hidden', 'true');
  a.tabIndex = -1;
  a.href = URL.createObjectURL(new Blob([text], { type: type || 'application/json' }));
  a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
async function toggleProtect(p) {
  if (isProtectedPath(p) && !isExactProtectedPath(p)) {
    toast(`${p} is protected by a wildcard or folder policy. Remove that policy in Safeguards.`, 'err');
    return openSafeguards();
  }
  const on = !isExactProtectedPath(p);
  if (await setSafety({ protect: { repo: safetyKey(), path: p, on } }))
    toast(on ? `${p} is now protected` : `${p} unlocked`, 'ok');
}
async function snapshotFlow() {
  try {
    toast('Capturing recovery snapshot…', 'ok');
    let signed = null;
    try { signed = await api(`/api/repo/${wPath()}/signed-snapshot`, { method: 'POST', body: { manifest: true } }); } catch {}
    const snap = signed && signed.snapshot ? signed.snapshot : await api(`/api/repo/${wPath()}/refs-snapshot?manifest=1`);
    try { localStorage.setItem('nv_snap_' + safetyKey(), JSON.stringify(snap)); } catch {}
    dlFile(`${snap.repo}-${snap.capturedAt.slice(0, 10)}.nvsnap.json`, JSON.stringify(snap, null, 2));
    await modal({
      title: 'Recovery snapshot captured', okText: 'Done',
      bodyHTML: `<p class="hint">${snap.refs.length} branch${snap.refs.length > 1 ? 'es' : ''}, ${snap.tags.length} tag(s)${snap.manifest ? `, ${snap.manifest.files.length} files indexed` : ''}. ${signed ? `Signed and retained in Neon as <span class="mono">${esc(signed.snapshotId)}</span>.` : 'Saved locally because durable Neon evidence was unavailable.'} A portable copy was downloaded.</p>
        <div style="max-height:34vh;overflow-y:auto;margin-top:8px">${snap.refs.map(r =>
          `<p class="hint" style="margin:2px 0"><span class="mono">${esc(r.name)}</span> — <span class="mono">${esc(r.sha.slice(0, 8))}</span>${r.protected ? ' (protected)' : ''}</p>`).join('')}</div>`
    });
  } catch (e) { toast(e.message, 'err'); }
}
function activityCsv(activity) {
  if (!globalThis.NebulaExportSafety || typeof globalThis.NebulaExportSafety.activityCsv !== 'function')
    throw new Error('Secure CSV exporter is unavailable');
  return globalThis.NebulaExportSafety.activityCsv(activity);
}

async function fetchIntelligenceEventsForExport() {
  const events = new Map();
  let after = '';
  let available = true;
  let truncatedBefore = false;
  for (let pageIndex = 0; pageIndex < 5; pageIndex += 1) {
    const suffix = after ? `&after=${encodeURIComponent(after)}` : '';
    const page = await api(`/api/repo/${wPath()}/intelligence/events?limit=500${suffix}`);
    available = page.available !== false;
    truncatedBefore = truncatedBefore || !!page.truncatedBefore;
    for (const event of page.events || []) if (event && event.id) events.set(event.id, event);
    const next = String(page.cursor || '');
    if (!page.hasMore || !next) break;
    after = next;
  }
  return { available, truncatedBefore, events: [...events.values()].sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0) || String(a.id).localeCompare(String(b.id))) };
}

async function exportActivityFlow() {
  try {
    toast('Collecting activity and verified events…', 'ok');
    const [activityResult, intelligenceResult] = await Promise.allSettled([
      api(`/api/repo/${wPath()}/activity?days=30`),
      fetchIntelligenceEventsForExport()
    ]);
    if (activityResult.status !== 'fulfilled') throw activityResult.reason;
    const base = activityResult.value;
    const intelligence = intelligenceResult.status === 'fulfilled' ? intelligenceResult.value : { available: false, truncatedBefore: false, events: [], error: intelligenceResult.reason && intelligenceResult.reason.message };
    const a = { ...base, intelligenceAvailable: !!intelligence.available, intelligenceHistoryTruncated: !!intelligence.truncatedBefore, intelligenceEvents: intelligence.events || [], intelligenceError: intelligence.error || '' };
    const md = [`# ${a.owner}/${a.repo} — last ${a.days} days`, '',
      `## Commits (${a.commits.length})`, ...a.commits.map(c => `- \`${(c.sha || '').slice(0, 8)}\` ${c.message} — ${c.author}`), '',
      `## Pull requests (${a.pulls.length})`, ...a.pulls.map(p => `- #${p.number} ${p.title} (${p.state})`), '',
      `## Issues (${a.issues.length})`, ...a.issues.map(i => `- #${i.number} ${i.title} (${i.state})`), '',
      `## Releases (${a.releases.length})`, ...a.releases.map(r => `- ${r.tag} ${r.name || ''}`), '',
      `## Verified intelligence events (${a.intelligenceEvents.length})`,
      ...(a.intelligenceAvailable ? a.intelligenceEvents.map(event => `- ${event.createdAt || ''} [${event.severity || 'normal'} · ${event.score || 0}] ${event.summary || event.eventType || 'event'} — ${event.actor || 'unknown actor'}`) : [`- Unavailable${a.intelligenceError ? `: ${a.intelligenceError}` : ' because Neon-backed live intelligence is not enabled.'}`])
    ].join('\n');
    const stamp = new Date(a.generatedAt || Date.now()).toISOString().slice(0, 10);
    setTimeout(() => {
      const bind = (id, fn) => { const el = $('#' + id); if (el) el.addEventListener('click', fn); };
      bind('actMd', () => dlFile(`${a.repo}-activity-${stamp}.md`, md, 'text/markdown'));
      bind('actJson', () => dlFile(`${a.repo}-activity-${stamp}.json`, JSON.stringify(a, null, 2)));
      bind('actCsv', () => dlFile(`${a.repo}-activity-${stamp}.csv`, activityCsv(a), 'text/csv'));
    }, 0);
    await modal({
      title: 'Activity export ready', okText: 'Close',
      bodyHTML: `<p class="hint">${a.commits.length} commits · ${a.pulls.length} PRs · ${a.issues.length} issues · ${a.releases.length} releases · ${a.intelligenceEvents.length} verified event(s).</p>
        ${a.intelligenceHistoryTruncated ? '<p class="hint">Verified-event export contains the latest 500 retained events; older retained history is not included in this browser export.</p>' : ''}${a.intelligenceAvailable ? '' : '<p class="hint">Verified-event history is unavailable without Neon-backed live intelligence; the provider activity export is still complete for the selected period.</p>'}
        <div class="btn-row" style="margin-top:10px"><button class="btn btn-ghost small" id="actMd">Download Markdown</button><button class="btn btn-ghost small" id="actJson">Download JSON</button><button class="btn btn-ghost small" id="actCsv">Download CSV</button></div>`
    });
  } catch (e) { toast(e.message, 'err'); }
}

async function exportEvidenceFlow() {
  try {
    toast('Building verifiable evidence package…', 'ok');
    const evidence = await api(`/api/repo/${wPath()}/evidence`);
    const stamp = new Date(evidence.generatedAt || Date.now()).toISOString().slice(0, 10);
    dlFile(`${state.work.repo}-evidence-${stamp}.json`, JSON.stringify(evidence, null, 2));
    await modal({ title: 'Evidence package exported', okText: 'Done', bodyHTML: `<p class="hint">${(evidence.events || []).length} verified event(s), ${(evidence.snapshots || []).length} signed snapshot(s). Evidence chain: <b>${evidence.chain && evidence.chain.valid ? 'valid' : evidence.chain && evidence.chain.available ? 'verification failed' : 'unavailable without Neon'}</b>.</p>` });
  } catch (e) { presentError(e); }
}
async function recoveryFlow() {
  const stored = localStorage.getItem('nv_snap_' + safetyKey());
  const ok = await modal({
    title: 'Verified recovery workflow', okText: 'Analyze snapshot', danger: true,
    bodyHTML: `<p class="hint">Nebulaverse-X first compares the snapshot with the live repository and creates a non-mutating restore preview. No branch is changed during analysis.</p>
      <textarea id="recJson" rows="4" placeholder="Paste a .nvsnap.json file…" style="width:100%;margin-top:8px"></textarea>
      ${stored ? '<p class="hint" style="margin-top:6px">Leave empty to use the last snapshot captured on this device.</p>' : ''}`
  });
  if (!ok) return;
  let snap = null;
  const typed = $('#recJson') ? $('#recJson').value.trim() : '';
  try { snap = JSON.parse(typed || stored || 'null'); } catch { return toast('That snapshot could not be read', 'err'); }
  if (!snap || (snap.kind !== 'nebulaverse-snapshot' && snap.kind !== 'nebulaverse-emergency-manifest') || !Array.isArray(snap.refs)) return toast('Not a Nebulaverse-X snapshot or emergency manifest', 'err');
  try {
    toast('Comparing recovery snapshot with the live repository…', 'ok');
    const [comparison, preview] = await Promise.all([
      api(`/api/repo/${wPath()}/snapshot-compare`, { method: 'POST', body: { snapshot: snap } }),
      api(`/api/repo/${wPath()}/restore-preview`, { method: 'POST', body: { snapshot: snap } })
    ]);
    const c = comparison.comparison && comparison.comparison.counts || preview.counts || {};
    const actions = preview.actions || [];
    const warnings = preview.warnings || [];
    const actionRows = actions.slice(0, 50).map(action =>
      `<p class="hint" style="margin:3px 0"><span class="mono">${esc(action.name)}</span> — ${action.action === 'recreate' ? 'recreate' : 'move'} to <span class="mono">${esc(String(action.to || '').slice(0, 12))}</span>${action.protected ? ' · provider protected' : ''}</p>`
    ).join('');
    const proceed = await modal({
      title: 'Recovery impact preview', okText: preview.canRestore ? 'Continue to confirmation' : 'Close', danger: true,
      bodyHTML: `<div class="neural-report-banner"><b>No repository changes have been made.</b><p>${c.refsToMove || 0} branch(es) would move, ${c.refsToRecreate || 0} would be recreated, and ${c.newerRefsPreserved || 0} newer branch(es) would be preserved.</p></div>
        <p class="hint">File comparison: ${c.filesModified || 0} modified, ${c.filesToRestore || 0} absent from the current tree, ${c.newerFilesPreserved || 0} newer file(s) preserved. Reference restore changes branch pointers only.</p>
        ${warnings.map(warning => `<p class="hint">⚠ ${esc(warning)}</p>`).join('')}
        <div style="max-height:26vh;overflow-y:auto;margin-top:8px">${actionRows || '<p class="hint">All recorded branch references already match.</p>'}</div>`
    });
    if (!proceed || !preview.canRestore || !actions.length) return;
    const confirm = await modal({
      title: 'Confirm branch reference recovery', okText: 'Restore refs', danger: true,
      bodyHTML: `<p class="hint">This force-updates or recreates <b>${actions.length}</b> branch reference(s). Commits created after the snapshot are not deleted, but these branches will no longer point to them.</p>
        <label class="field-label" for="recConfirm">Type <span class="mono">RESTORE</span> to confirm</label>
        <input id="recConfirm" type="text" autocomplete="off" spellcheck="false" placeholder="RESTORE">`
    });
    if (!confirm) return;
    const confirmation = $('#recConfirm');
    if (!confirmation || confirmation.value.trim().toUpperCase() !== 'RESTORE') return toast('Recovery confirmation did not match', 'err');
    const out = await api(`/api/repo/${wPath()}/restore-refs`, { method: 'POST', body: { confirm: 'RESTORE', authorization: preview.authorization } });
    const okN = out.report.filter(r => r.ok).length;
    await modal({
      title: `Recovery complete — ${okN}/${out.report.length}`, okText: 'Done',
      bodyHTML: `<div style="max-height:40vh;overflow-y:auto">${out.report.map(r =>
        `<p class="hint" style="margin:2px 0"><span class="mono">${esc(r.name)}</span> — ${r.ok ? r.action : 'failed: ' + esc(r.error || '')}</p>`).join('')}</div>`
    });
    loadTree('', $('#tree'), true);
  } catch (e) { toast(e.message, 'err'); }
}

async function securityScanFlow() {
  try {
    toast('Scanning dependencies and checking upload defenses…', 'ok');
    const [a, scanner] = await Promise.all([
      api(`/api/repo/${wPath()}/audit-deps?ref=${encodeURIComponent(state.work.branch)}`),
      api('/api/security/scanner-status').catch(error => ({ builtin: { available: false }, yara: { configured: false, required: false }, error: error.message }))
    ]);
    const rows = a.vulnerable.map(v => {
      const d = v.ids.map(id => a.details[id]).filter(Boolean)[0];
      return `<div class="glass" style="padding:8px;margin:6px 0">
        <p style="margin:0"><span class="mono">${esc(v.name)}@${esc(v.version)}</span> <span class="hint">(${esc(v.ecosystem)})</span></p>
        <p class="hint" style="margin:4px 0 0">${esc(v.ids.join(', '))}${d && d.severity ? ` — ${esc(d.severity)}` : ''}</p>
        ${d && d.summary ? `<p class="hint" style="margin:4px 0 0">${esc(d.summary)}</p>` : ''}</div>`;
    }).join('');
    const db = a.dependabot;
    const osvUnavailable = !!(a.scanned && (!a.osv || a.osv.available === false));
    await modal({
      title: osvUnavailable ? 'Dependency scan incomplete' : (a.vulnerable.length ? `${a.vulnerable.length} vulnerable package(s)` : 'No known vulnerabilities'), okText: 'Done',
      bodyHTML: `${osvUnavailable ? `<div class="neural-report-banner"><b>OSV could not be reached.</b><p>${esc((a.osv && a.osv.error) || 'The vulnerability database did not return a usable response.')} No clean result is claimed; retry the scan later.</p></div>` : ''}<p class="hint">${a.scanned} package(s) ${osvUnavailable ? 'resolved from manifests' : 'checked against the OSV database'}${a.sources.length ? ' from ' + esc(a.sources.map(s => s.file).join(', ')) : ''}.</p>
        ${a.approximate ? '<p class="hint">Versions came from package.json ranges — commit a lockfile for exact results.</p>' : ''}
        ${!a.scanned ? '<p class="hint">No supported manifest found (package-lock.json, package.json, requirements.txt, go.mod, Cargo.lock, Gemfile.lock).</p>' : ''}
        <div class="neural-report-banner"><b>Upload malware gate</b><p>Built-in whole-file signature scan: <b>${scanner.builtin && scanner.builtin.available ? 'active' : 'unavailable'}</b>. Optional YARA adapter: <b>${scanner.yara && scanner.yara.configured ? (scanner.yara.required ? 'configured and required' : 'configured') : 'not configured'}</b>${scanner.error ? ` — ${esc(scanner.error)}` : ''}.</p></div>
        <div style="max-height:44vh;overflow-y:auto">${rows}</div>
        ${db.available ? `<p class="hint" style="margin-top:8px">Dependabot: ${db.alerts.length} open alert(s).</p>` : (db.note ? `<p class="hint" style="margin-top:8px">Dependabot unavailable — ${esc(db.note)}.</p>` : '')}`
    });
  } catch (e) { toast(e.message, 'err'); }
}
async function openSafeguards() {
  await refreshSafety();
  const sf = state.safety;
  const prot = protectedList();
  await modal({
    title: 'Safeguards', okText: 'Done',
    bodyHTML: `
      <label class="check"><input type="checkbox" id="sgReadOnly" ${sf.readOnly ? 'checked' : ''}> Read-only mode — block every write</label>
      <p class="hint" style="margin:2px 0 10px">Enforced on the server: commits, uploads, deletes, merges and resets are refused while this is on.</p>
      <label class="check"><input type="checkbox" id="sgFreeze" ${sf.freezeSync ? 'checked' : ''}> Freeze scheduled synchronization</label>
      <p class="hint" style="margin:2px 0 10px">Pauses background queue flushing and auto-sync on reconnect. Manual sync still works.</p>
      <div class="set-label">Repository safety</div>
      <div class="about-actions">
        <button class="btn btn-ghost small" id="sgSnap" data-feature="recovery">Emergency snapshot</button>
        <button class="btn btn-ghost small" id="sgRecover" data-feature="recovery">Disaster recovery…</button>
        <button class="btn btn-ghost small" id="sgActivity" data-feature="governance" data-allow-experimental="true">Export activity</button>
        <button class="btn btn-ghost small" id="sgScan" data-feature="dependency-audit" data-allow-experimental="true">Security scan</button>
        <button class="btn btn-ghost small" id="sgEvidence" data-feature="governance" data-allow-experimental="true">Export evidence</button>
      </div>
      <div class="set-label" style="margin-top:12px">Protected files, folders and patterns ${prot.length ? `(${prot.length})` : ''}</div>
      <div style="display:flex;gap:6px;margin:6px 0 10px"><input id="sgProtectPattern" type="text" placeholder="e.g. .github/workflows/**" autocomplete="off" spellcheck="false" style="flex:1"><button class="btn btn-ghost small" id="sgAddProtect">Protect</button></div>
      ${prot.length
        ? prot.map(p => `<p class="hint" style="margin:3px 0"><span class="mono">${esc(p)}</span> <button class="btn btn-ghost small" data-unprot="${esc(p)}">Unlock</button></p>`).join('')
        : '<p class="hint">None yet — protect a file from the tree or add a folder/wildcard pattern above.</p>'}`,
    onOpen: () => {
      if (window.NebulaCapabilityUI) NebulaCapabilityUI.apply($('#modalBody'));
      const bind = (id, fn) => { const el = $('#' + id); if (el) el.addEventListener('click', fn); };
      const ro = $('#sgReadOnly'), fz = $('#sgFreeze');
      if (ro) ro.addEventListener('change', () => setSafety({ readOnly: ro.checked }));
      if (fz) fz.addEventListener('change', () => setSafety({ freezeSync: fz.checked }));
      bind('sgSnap', () => { closeModal(false); snapshotFlow(); });
      bind('sgActivity', () => { closeModal(false); exportActivityFlow(); });
      bind('sgRecover', () => { closeModal(false); recoveryFlow(); });
      bind('sgScan', () => { closeModal(false); securityScanFlow(); });
      bind('sgEvidence', () => { closeModal(false); exportEvidenceFlow(); });
      bind('sgAddProtect', async () => {
        const input = $('#sgProtectPattern'); const pattern = input && input.value.trim().replace(/^\/+/, '');
        if (!pattern) return toast('Enter a file, folder or wildcard pattern', 'err');
        if (await setSafety({ protect: { repo: safetyKey(), path: pattern, on: true } })) { toast(`${pattern} protected`, 'ok'); closeModal(false); openSafeguards(); }
      });
      $$('#modalBody [data-unprot]').forEach(b => b.addEventListener('click', async () => {
        await setSafety({ protect: { repo: safetyKey(), path: b.dataset.unprot, on: false } });
        b.closest('p').remove();
      }));
    }
  });
}
async function moveFolderFlow(dirPath) {
  const ok = await modal({
    title: 'Rename / move folder',
    bodyHTML: `<p class="hint">Every file under <b class="mono">${esc(dirPath)}/</b> moves in one atomic commit.</p>
      <label class="set-label" for="mvDirTo" style="margin-top:8px">New path</label>
      <input id="mvDirTo" type="text" value="${esc(dirPath)}" autocomplete="off" spellcheck="false" style="width:100%">
      <p class="hint" style="margin-top:6px">Rename in place (<span class="mono">docs</span> → <span class="mono">guides</span>) or move deeper (<span class="mono">assets/logos</span>).</p>`,
    okText: 'Move ✦'
  });
  if (!ok) return;
  const to = $('#mvDirTo') ? $('#mvDirTo').value.trim().replace(/^\/+|\/+$/g, '') : '';
  if (!to || to === dirPath) return;
  try {
    const out = await api(`/api/repo/${wPath()}/move-dir`, {
      method: 'POST',
      body: guardedWrite({ from: dirPath, to, branch: state.work.branch, message: `Move ${dirPath} -> ${to}` })
    });
    rememberHead(out.commit);
    toast(`${out.moved} file${out.moved > 1 ? 's' : ''} moved to ${to}/ ✦`, 'ok');
    loadTree('', $('#tree'), true);
  } catch (e) { toast(e.message, 'err'); }
}
async function deleteFolderFlow(dirPath) {
  let victims = [];
  try {
    const out = await api(`/api/repo/${wPath()}/files?ref=${encodeURIComponent(state.work.branch)}`);
    victims = out.files.filter(p => p.startsWith(dirPath + '/'));
  } catch (e) { return toast(e.message, 'err'); }
  if (!victims.length) return toast('That folder has no files', 'err');
  const leaf = dirPath.split('/').pop();
  const ok = await modal({
    title: 'Delete folder',
    bodyHTML: `<p style="font-size:.9rem;line-height:1.6">This deletes <b>${victims.length} file${victims.length > 1 ? 's' : ''}</b> under <b class="mono">${esc(dirPath)}/</b> from <b>${esc(state.work.branch)}</b> in ${Math.ceil(victims.length / 100)} commit${victims.length > 100 ? 's' : ''}.</p>
      <label class="field-label" for="delFolderName">Type <b class="mono">${esc(leaf)}</b> to confirm</label><input id="delFolderName" type="text" autocomplete="off" spellcheck="false">`,
    okText: 'Delete folder', danger: true
  });
  if (!ok) return;
  if (($('#delFolderName') ? $('#delFolderName').value : '').trim() !== leaf) return toast('Name mismatch — aborted', 'err');
  try {
    for (let i = 0; i < victims.length; i += 100) {
      const out = await api(`/api/repo/${wPath()}/batch`, {
        method: 'POST',
        body: guardedWrite({ branch: state.work.branch, message: `Delete ${dirPath}/ via ${NV_PRODUCT_NAME}`, ops: victims.slice(i, i + 100).map(p => ({ op: 'delete', path: p })) })
      });
      rememberHead(out.commit);
    }
    toast(`Folder ${leaf}/ deleted ✦`, 'ok');
    state.fileIndex = null; loadTree('', $('#tree'), true);
  } catch (e) { toast(e.message, 'err'); }
}
async function deleteRepoFlow() {
  const ok = await modal({
    title: 'Delete repository',
    bodyHTML: `<p style="font-size:.9rem;line-height:1.6"><b>${esc(wPath())}</b> will be permanently deleted on GitHub — code, history, issues, releases. <b>This cannot be undone.</b></p>
      <label class="field-label" for="drName">Type <b class="mono">${esc(state.work.repo)}</b> to confirm</label><input id="drName" type="text" autocomplete="off" spellcheck="false">`,
    okText: 'Delete forever', danger: true
  });
  if (!ok) return;
  if (($('#drName') ? $('#drName').value : '').trim() !== state.work.repo) return toast('Name mismatch — aborted', 'err');
  try {
    const deleted = await stepUpApi('repository.delete', {
      owner: state.work.owner, repo: state.work.repo
    }, `/api/repo/${wPath()}`, { method: 'DELETE' }, `Delete repository ${wPath()}`);
    if (!deleted) return;
    toast('Repository deleted', 'ok');
    showPage('repos'); loadRepos(true);
  } catch (e) {
    if (e.message && /403|admin|delete_repo|forbidden/i.test(e.message) && !e.nextAction)
      e.nextAction = 'Regenerate the provider token with repository deletion permission, then retry.';
    presentError(e);
  }
}

/* ---------------- code search ---------------- */
$('#codeSearch').addEventListener('keydown', async e => {
  if (e.key !== 'Enter') return;
  const q = e.target.value.trim();
  const host = $('#tree');
  if (!q) return loadTree('', host, true);
  host.innerHTML = '<div class="skeleton" style="height:120px"></div>';
  try {
    const hits = await api(`/api/repo/${wPath()}/search?q=${encodeURIComponent(q)}`);
    host.innerHTML = hits.length ? '' : '<div class="tree-item">No matches — use Refresh to restore the tree</div>';
    hits.forEach(h => {
      const row = document.createElement('div');
      row.className = 'tree-item';
      row.innerHTML = `<span class="ti-icon">${TREE_ICON.hit}</span><span class="ti-name"></span>`;
      row.querySelector('.ti-name').textContent = h.path;
      row.addEventListener('click', () => { state.pendingFind = q; openFile(h.path); closeDrawer(); });
      host.appendChild(row);
    });
  } catch (e2) { host.innerHTML = `<div class="tree-item">⚠ ${esc(e2.message)}</div>`; }
});

/* ---------------- editor ---------------- */
const IMG_EXT = ['png','jpg','jpeg','gif','webp','svg','ico'];
const VID_EXT = ['mp4','webm'];
const extOf = p => (p.split('.').pop() || '').toLowerCase();

function ensureCM() {
  if (typeof window.CodeMirror === 'undefined') {
    toast('Editor engine could not load — refresh once while online to repair', 'err');
    throw new Error('CodeMirror unavailable');
  }
  if (state.cm) return state.cm;
  state.cm = CodeMirror($('#editorHost'), {
    value: '', lineNumbers: true, theme: state.settings.editorTheme,
    lineWrapping: !!state.settings.wrap, viewportMargin: 50
  });
  state.cm.on('change', () => {
    if (state.file && !state.file.binary && !state.file._loading) {
      state.file.dirty = true;
      $('#commitFileBtn').disabled = false;
      $('#stageFileBtn').disabled = false;
      $('#diffBtn').disabled = false;
      saveDraft();
    }
  });
  return state.cm;
}

async function openFile(p) {
  const w = state.work;
  $('#editorEmpty').hidden = true;
  $('#editorShell').hidden = false;
  $('#filePath').textContent = p;
  $('#fileSize').textContent = '';
  $('#mdPreview').hidden = true; $('#binaryPreview').hidden = true;
  $('#editDiff').hidden = true; $('#diffBtn').disabled = true;
  closeFindPanel();
  removeDraftBar();
  $('#editorHost').style.display = '';
  $('#mdPreviewBtn').hidden = extOf(p) !== 'md';
  $('#mdPreviewBtn').textContent = 'Preview';
  switchTab('editor');

  const ext = extOf(p);
  if (IMG_EXT.includes(ext) || VID_EXT.includes(ext) || ext === 'pdf') {
    if (ownerWorkbench) { closeFile(); toast('Binary preview is not connected to the owner workbench yet.', 'err'); return; }
    state.file = { path: p, sha: null, binary: true };
    $('#editorHost').style.display = 'none';
    $('#commitFileBtn').disabled = true; $('#stageFileBtn').disabled = true;
    const bp = $('#binaryPreview'); bp.hidden = false;
    const url = `/api/repo/${wPath()}/raw?ref=${encodeURIComponent(w.branch)}&path=${encodeURIComponent(p)}`;
    if (IMG_EXT.includes(ext)) bp.innerHTML = `<img src="${url}" alt="">`;
    else if (VID_EXT.includes(ext)) bp.innerHTML = `<video src="${url}" controls playsinline></video>`;
    else bp.innerHTML = `<p>Binary file.</p><a class="btn btn-ghost" href="${url}" download>Download</a>`;
    try {
      const meta = await api(`/api/repo/${wPath()}/file?ref=${encodeURIComponent(w.branch)}&path=${encodeURIComponent(p)}`);
      state.file.sha = meta.sha; $('#fileSize').textContent = fmtSize(meta.size);
    } catch {}
    return;
  }

  const cm = ensureCM();
  cm.setValue('Loading…');
  try {
    const f = await api(`/api/repo/${wPath()}/file?ref=${encodeURIComponent(w.branch)}&path=${encodeURIComponent(p)}`);
    if (ownerWorkbench && (f.lfs || f.tooLarge || f.binary)) {
      closeFile(); toast('Owner editing supports ordinary text files up to 1 MiB. This file is not editable here.', 'err'); return;
    }
    if (f.lfs) {
      state.file = { path: p, sha: f.sha, binary: true };
      $('#editorHost').style.display = 'none';
      const bp = $('#binaryPreview'); bp.hidden = false;
      const raw = `/api/repo/${wPath()}/raw?ref=${encodeURIComponent(w.branch)}&path=${encodeURIComponent(p)}`;
      bp.innerHTML = `<span class="lfs-pill">✦ Git LFS object</span>
        <p>Stored in Large File Storage — real size <b>${fmtSize(f.size)}</b>.<br>Nebulaverse-X resolves the pointer automatically: download streams the actual file.</p>
        <a class="btn btn-primary" href="${raw}" download>Download ${fmtSize(f.size)}</a>`;
      $('#commitFileBtn').disabled = true; $('#stageFileBtn').disabled = true;
      $('#fileSize').textContent = fmtSize(f.size) + ' · LFS';
      return;
    }
    if (f.tooLarge) {
      state.file = { path: p, sha: f.sha, binary: true };
      $('#editorHost').style.display = 'none';
      const bp = $('#binaryPreview'); bp.hidden = false;
      bp.innerHTML = `<p>This file is ${fmtSize(f.size)} — too large for the in-browser editor.<br>Use <b>Push</b> to replace it, or download it.</p>
        <a class="btn btn-ghost" href="/api/repo/${wPath()}/raw?ref=${encodeURIComponent(w.branch)}&path=${encodeURIComponent(p)}" download>Download</a>`;
      $('#commitFileBtn').disabled = true; $('#stageFileBtn').disabled = true;
      $('#fileSize').textContent = fmtSize(f.size);
      return;
    }
    const text = b64ToUtf8(f.content || '');
    state.file = { path: p, sha: f.sha, dirty: false, original: text, _loading: true };
    $('#fileSize').textContent = fmtSize(f.size);
    const info = CodeMirror.findModeByFileName ? CodeMirror.findModeByFileName(p) : null;
    cm.setOption('mode', info ? (info.mime || info.mode) : null);
    cm.setValue(text);
    state.file._loading = false;
    state.file.dirty = false;
    rememberRecent(p);
    saveRoute();
    offerDraft(p, text);
    if (state.pendingFind) { const q = state.pendingFind; state.pendingFind = null; setTimeout(() => openFindPanel(q), 120); }
    $('#commitFileBtn').disabled = true; $('#stageFileBtn').disabled = true;
    setTimeout(() => cm.refresh(), 30);
  } catch (e) { cm.setValue(''); toast(e.message, 'err'); }
}
function closeFile() {
  setTimeout(saveRoute, 0); state.file = null; $('#editorShell').hidden = true; $('#editorEmpty').hidden = false; }

$('#mdPreviewBtn').addEventListener('click', () => {
  const pv = $('#mdPreview');
  const showing = !pv.hidden;
  pv.hidden = showing;
  $('#editorHost').style.display = showing ? '' : 'none';
  $('#mdPreviewBtn').textContent = showing ? 'Preview' : 'Edit';
  if (!showing) {
    const source = state.cm.getValue();
    if (!window.DOMPurify || !window.marked) {
      pv.textContent = source;
      toast('Secure Markdown renderer is unavailable; showing plain text.', 'err');
      return;
    }
    const html = marked.parse(source);
    pv.innerHTML = DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['form', 'iframe', 'object', 'embed'],
      FORBID_ATTR: ['srcdoc']
    });
  }
  else setTimeout(() => state.cm.refresh(), 30);
});

const _protWarned = new Set();
async function protectedCommitGate() {
  if (!branchProtected(state.work.branch)) return true;
  const key = `${state.work.owner}/${state.work.repo}@${state.work.branch}`;
  if (_protWarned.has(key)) return true;
  const ok = await modal({
    title: 'Protected branch',
    okText: 'Commit anyway',
    danger: true,
    bodyHTML: `<p class="hint"><b>${esc(state.work.branch)}</b> is protected. Direct commits may be rejected by the server — the safer path is a new branch + pull request.</p>`
  });
  if (ok) _protWarned.add(key);
  return !!ok;
}
$('#commitFileBtn').addEventListener('click', async () => {
  if (!(await protectedCommitGate())) return;
  if (!state.file || state.file.binary) return;
  const ok = await modal({
    title: 'Commit changes',
    bodyHTML: `<label class="field-label" for="cmMsg">Commit message</label>
      <input id="cmMsg" type="text" value="Update ${esc(state.file.path)}" spellcheck="false">
      <p class="hint">Committing directly to <b>${esc(state.work.branch)}</b></p>`,
    okText: 'Commit ✦'
  });
  if (!ok) return;
  try {
    /* conflict check: has the file changed on GitHub since we loaded it? */
    try {
      const remote = await api(`/api/repo/${wPath()}/file?ref=${encodeURIComponent(state.work.branch)}&path=${encodeURIComponent(state.file.path)}`);
      if (remote.sha && state.file.sha && remote.sha !== state.file.sha) {
        const overwrite = await modal({
          title: 'File changed on GitHub',
          bodyHTML: `<p style="font-size:.9rem;line-height:1.6">Someone (or another session) committed a newer version of <b class="mono">${esc(state.file.path)}</b> after you opened it.<br><br>Overwrite it with your version, or cancel and reload the latest first?</p>`,
          okText: 'Overwrite anyway', danger: true
        });
        if (!overwrite) return;
        state.file.sha = remote.sha;
        await refreshRepoMetadata();
      }
    } catch {}
    const out = await api(`/api/repo/${wPath()}/file`, {
      method: 'PUT',
      body: guardedWrite({ path: state.file.path, content: state.cm.getValue(), message: $('#cmMsg').value || undefined, branch: state.work.branch, sha: state.file.sha })
    });
    rememberHead(out.commit);
    state.file.sha = out.sha; state.file.dirty = false;
    $('#commitFileBtn').disabled = true; $('#stageFileBtn').disabled = true;
    state.file.original = state.cm.getValue();
    clearDraft(state.file.path);
    removeDraftBar();
    toast('Committed ✦', 'ok');
    refreshRate();
  } catch (e) {
    /* A refusal that needs approval carries the route to approval. Taking it
     * puts the change on a branch of its own, so the editor is left exactly as
     * it is: this file on this branch still differs from what is committed
     * here, and saying otherwise would be a comfortable lie. */
    const routed = await takeSafePassage(e, {
      content: state.cm.getValue(),
      message: $('#cmMsg') ? $('#cmMsg').value : undefined,
      sha: state.file.sha
    });
    if (routed) return;
    const queued = await queueCommit({
      kind: 'put', owner: state.work.owner, repo: state.work.repo, branch: state.work.branch,
      path: state.file.path, content: state.cm.getValue(),
      message: $('#cmMsg') ? $('#cmMsg').value : undefined, sha: state.file.sha,
      expectedHeadSha: currentHeadSha()
    }, e);
    if (queued) { state.file.dirty = false; $('#commitFileBtn').disabled = true; }
    else presentError(e);
  }
});

$('#stageFileBtn').addEventListener('click', () => {
  if (!state.file || state.file.binary) return;
  addStaged({ op: 'put', path: state.file.path, content: state.cm.getValue() });
  state.file.dirty = false;
  $('#stageFileBtn').disabled = true;
  clearDraft(state.file.path);
  removeDraftBar();
  toast(`Staged ${state.file.path}`, 'ok');
});

$('#deleteFileBtn').addEventListener('click', async () => {
  if (!state.file || !state.file.sha) return toast('Cannot delete: metadata unavailable', 'err');
  const choice = await modal({
    title: 'Delete file',
    bodyHTML: `<p style="font-size:.9rem;line-height:1.5">Delete <b class="mono">${esc(state.file.path)}</b> from <b>${esc(state.work.branch)}</b>?</p>
      <label class="check"><input type="checkbox" id="delStage"> Stage the deletion instead of committing now</label>`,
    okText: 'Delete', danger: true
  });
  if (!choice) return;
  const stageIt = $('#delStage') && $('#delStage').checked;
  if (stageIt) {
    addStaged({ op: 'delete', path: state.file.path });
    toast(`Deletion of ${state.file.path} staged`, 'ok');
    return;
  }
  try {
    const out = await api(`/api/repo/${wPath()}/file`, {
      method: 'DELETE', body: guardedWrite({ path: state.file.path, branch: state.work.branch, sha: state.file.sha })
    });
    rememberHead(out.commit);
    toast('File deleted', 'ok');
    closeFile(); loadTree('', $('#tree'), true);
  } catch (e) { presentError(e); }
});

$('#renameFileBtn').addEventListener('click', async () => {
  if (!state.file) return;
  const ok = await modal({
    title: 'Rename / move file',
    bodyHTML: `<label class="field-label" for="rnTo">New path</label>
      <input id="rnTo" type="text" value="${esc(state.file.path)}" spellcheck="false">
      <p class="hint">Works for files of any size — the blob is re-linked, not re-uploaded.</p>`,
    okText: 'Rename ✦'
  });
  if (!ok) return;
  const to = $('#rnTo').value.trim().replace(/^\/+/, '');
  if (!to || to === state.file.path) return;
  try {
    const out = await api(`/api/repo/${wPath()}/rename`, {
      method: 'POST', body: guardedWrite({ from: state.file.path, to, branch: state.work.branch })
    });
    rememberHead(out.commit);
    toast(`Renamed to ${to} ✦`, 'ok');
    state.fileIndex = null;
    loadTree('', $('#tree'), true);
    openFile(to);
  } catch (e) { toast(e.message, 'err'); }
});

$('#fileHistoryBtn').addEventListener('click', async () => {
  if (!state.file) return;
  const p = state.file.path;
  modal({ title: `History — ${p.split('/').pop()}`, okText: 'Close',
    bodyHTML: '<div class="skeleton" style="height:80px"></div>' });
  try {
    const commits = await api(`/api/repo/${wPath()}/commits?ref=${encodeURIComponent(state.work.branch)}&path=${encodeURIComponent(p)}`);
    if ($('#scrim').hidden) return;
    $('#modalBody').innerHTML = commits.length ? commits.map(c => `
      <div class="comment">
        <div class="comment-head"><span class="mono commit-sha">${c.sha.slice(0, 7)}</span><span>${esc(c.author)}</span><span>${timeAgo(c.date)}</span></div>
        <div class="comment-body">${esc(c.message.split('\n')[0])}</div>
      </div>`).join('') : '<p class="hint">No history found for this path.</p>';
  } catch (e) { if (!$('#scrim').hidden) $('#modalBody').innerHTML = `<p class="hint">⚠ ${esc(e.message)}</p>`; }
});

$('#newFileBtn').addEventListener('click', async () => {
  const ok = await modal({
    title: 'New file',
    bodyHTML: `<label class="field-label" for="nfPath">Path</label><input id="nfPath" type="text" placeholder="docs/notes.md" spellcheck="false">
      <label class="check"><input type="checkbox" id="nfStage"> Stage instead of committing now</label>`,
    okText: 'Create'
  });
  if (!ok) return;
  const p = $('#nfPath').value.trim().replace(/^\/+/, '');
  if (!p) return;
  const stageIt = $('#nfStage') && $('#nfStage').checked;
  if (stageIt) {
    addStaged({ op: 'put', path: p, content: '' });
    toast(`New file ${p} staged`, 'ok');
    closeDrawer();
    return;
  }
  try {
    const out = await api(`/api/repo/${wPath()}/file`, {
      method: 'PUT', body: guardedWrite({ path: p, content: '', message: `Create ${p} via ${NV_PRODUCT_NAME}`, branch: state.work.branch })
    });
    rememberHead(out.commit);
    toast(`Created ${p} ✦`, 'ok');
    state.fileIndex = null;
    loadTree('', $('#tree'), true);
    openFile(p); closeDrawer();
  } catch (e) { presentError(e); }
});

/* ================= STAGED CHANGES ================= */
function addStaged(op) {
  state.staged = state.staged.filter(s => s.path !== op.path);
  state.staged.push(op);
  renderStagedCount();
}
function renderStagedCount() {
  const n = state.staged.length;
  $('#stagedCount').hidden = !n;
  $('#stagedCount').textContent = n;
}
function renderStagedPanel() {
  const host = $('#stageList');
  if (!state.staged.length) {
    host.innerHTML = `<div class="stage-empty">Nothing staged yet.<br><br>Use <b>Stage</b> in the editor (or stage new files & deletions) to build up a set of changes, then commit them all here as <b>one atomic commit</b>.</div>`;
    return;
  }
  host.innerHTML = '';
  state.staged.forEach((s, i) => {
    const el = document.createElement('div');
    el.className = 'stage-item';
    el.innerHTML = `<span class="stage-op ${s.op === 'put' ? 'op-put' : 'op-del'}">${s.op === 'put' ? 'PUT' : 'DEL'}</span>
      <span class="stage-path mono"></span>
      <button class="stage-x" aria-label="Unstage">${META_ICON.close}</button>`;
    el.querySelector('.stage-path').textContent = s.path;
    el.querySelector('.stage-x').addEventListener('click', () => {
      state.staged.splice(i, 1); renderStagedCount(); renderStagedPanel();
    });
    host.appendChild(el);
  });
}
function openStagePanel() { renderStagedPanel(); $('#stageScrim').hidden = false; }
function closeStagePanel() { $('#stageScrim').hidden = true; }
$('#stagedBtn').addEventListener('click', openStagePanel);
$('#stageClose').addEventListener('click', closeStagePanel);
$('#stageScrim').addEventListener('click', e => { if (e.target === $('#stageScrim')) closeStagePanel(); });
$('#stageCommitBtn').addEventListener('click', async () => {
  if (!state.staged.length) return toast('Nothing staged', 'err');
  const msg = $('#stageMsg').value.trim() || `Batch commit (${state.staged.length} changes) via ${NV_PRODUCT_NAME}`;
  $('#stageCommitBtn').disabled = true;
  try {
    const out = await api(`/api/repo/${wPath()}/batch`, {
      method: 'POST',
      body: guardedWrite({ branch: state.work.branch, message: msg, ops: state.staged.map(s => s.op === 'put' ? { op: 'put', path: s.path, content: s.content } : { op: 'delete', path: s.path }) })
    });
    rememberHead(out.commit);
    toast(`✦ ${out.count} changes committed as ${String(out.commit).slice(0, 7)}`, 'ok');
    state.staged = []; $('#stageMsg').value = '';
    renderStagedCount(); closeStagePanel();
    state.fileIndex = null;
    loadTree('', $('#tree'), true);
    refreshRate();
  } catch (e) {
    const queued = await queueCommit({
      kind: 'batch', owner: state.work.owner, repo: state.work.repo, branch: state.work.branch,
      message: msg, ops: state.staged.slice(), expectedHeadSha: currentHeadSha()
    }, e);
    if (queued) { state.staged = []; renderStagedCount(); renderStagedPanel(); }
    else presentError(e);
  }
  finally { $('#stageCommitBtn').disabled = false; }
});

/* ================= NAVIGATION (adaptive) ================= */
function currentTab() { const t = $('.tab.active'); return t ? t.dataset.tab : 'editor'; }
/* the Neural module is 60 KB — it loads the first time you open the tab, not on every visit.
   The service worker precaches it, so that first open is instant and works offline too. */
let _neuralLoad = null;
function ensureNeural() {
  if (window.NebulaNeural) { window.NebulaNeural.activate(); return; }
  if (!_neuralLoad) {
    _neuralLoad = new Promise((res, rej) => {
      const sc = document.createElement('script');
      sc.src = `/neural.js?v=${encodeURIComponent(NV_ASSET_VERSION)}`;
      sc.async = true;
      sc.onload = () => res(window.NebulaNeural);
      sc.onerror = () => { _neuralLoad = null; rej(new Error('Neural module could not load')); };
      document.head.appendChild(sc);
    });
  }
  _neuralLoad.then(nn => { if (nn && currentTab() === 'neural') nn.activate(); })
    .catch(e => toast(e.message, 'err'));
}
function switchTab(name) {
  const tab = $$('.tab').find(candidate => candidate.dataset.tab === name);
  /*
   * A name that matches no tab leaves the workbench exactly as it was.
   *
   * Selection here is a toggle evaluated against every tab and every pane, so
   * an unknown name did not select nothing -- it deselected everything, and
   * the workbench kept its chrome around an empty hole. Deep links carry this
   * name straight from the URL, so any typed or stale link could empty the
   * screen; /files, the form this project's own tests use, did exactly that.
   */
  if (!tab) return;
  const tabCapability = tab.dataset.feature;
  if (tabCapability && !runCapabilityAction(tabCapability, () => {}, {
    allowExperimental: tab.dataset.allowExperimental === 'true'
  })) return;
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  $$('.tabpane').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name));
  /*
   * Repainted here rather than by the click handler, so a tab reached from the
   * command palette marks the rail exactly as a pointer click does.
   */
  paintRail('work');
  $$('#bottomNav button').forEach(b => b.classList.toggle('active', b.dataset.nav === name));
  if (name === 'commits' && !$('#commitList').children.length) loadCommits(true);
  if (name === 'pulls' && !$('#prList').children.length) loadPRs();
  if (name === 'issues' && !$('#issueList').children.length) loadIssues();
  if (name === 'releases' && !$('#releaseList').children.length) loadReleases();
  if (name === 'actions' && !$('#actionsList').children.length) loadActions();
  if (name === 'governance') loadGovernanceTwin();
  if (name === 'neural') ensureNeural();
  else if (window.NebulaNeural) window.NebulaNeural.deactivate();
  if (name === 'editor' && state.cm) setTimeout(() => state.cm.refresh(), 30);
  saveRoute();
}
$$('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));

$('#bottomNav').addEventListener('click', e => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const nav = btn.dataset.nav;
  if (nav === 'files') return openDrawer();
  if (nav === 'more') return openSheet();
  switchTab(nav);
});
function openDrawer() { $('#side').classList.add('open'); $('#sideScrim').hidden = false; }
function closeDrawer() { if (isMobile()) { $('#side').classList.remove('open'); $('#sideScrim').hidden = true; } }
$('#sideScrim').addEventListener('click', closeDrawer);

function openSheet() { $('#sheetScrim').hidden = false; }
function closeSheet() { $('#sheetScrim').hidden = true; }
$('#sheetScrim').addEventListener('click', e => { if (e.target === $('#sheetScrim')) closeSheet(); });
$('#sheet').addEventListener('click', e => {
  const item = e.target.closest('.sheet-item');
  if (!item) return;
  runCapabilityAction(item.dataset.feature, () => {
    closeSheet();
    const act = item.dataset.act;
    if (['pulls', 'issues', 'releases', 'compare', 'actions', 'neural', 'governance'].includes(act)) switchTab(act);
    else if (act === 'palette') openPalette();
    else if (act === 'zip') downloadZip();
    else if (act === 'branches') openBranchManager();
    else if (act === 'delrepo') deleteRepoFlow();
    else if (act === 'theme') toggleTheme();
    else if (act === 'settings') openSettings();
    else if (act === 'safeguards') openSafeguards();
  }, { allowExperimental: item.dataset.allowExperimental === 'true' });
});

/* ================= COMMAND PALETTE ================= */
let palSel = 0, palItems = [];
const COMMANDS = [
  { label: 'New file', kind: 'action', feature: 'file.write', run: () => $('#newFileBtn').click() },
  { label: 'New branch', kind: 'action', feature: 'branches.write', run: () => $('#newBranchBtn').click() },
  { label: 'Push files (upload)', kind: 'view', feature: 'native-push', allowExperimental: true, run: () => switchTab('upload') },
  { label: 'Pull requests', kind: 'view', feature: 'pulls.read', allowExperimental: true, run: () => switchTab('pulls') },
  { label: 'Issues', kind: 'view', feature: 'issues.read', allowExperimental: true, run: () => switchTab('issues') },
  { label: 'Releases', kind: 'view', feature: 'releases.read', allowExperimental: true, run: () => switchTab('releases') },
  { label: 'Compare branches', kind: 'view', feature: 'recovery', allowExperimental: true, run: () => switchTab('compare') },
  { label: 'Commits', kind: 'view', feature: 'repository.read', run: () => switchTab('commits') },
  { label: 'Staged changes', kind: 'view', feature: 'file.batch', allowExperimental: true, run: () => openStagePanel() },
  { label: 'Download repo as zip', kind: 'action', feature: 'repository.read', run: () => downloadZip() },
  { label: 'Settings', kind: 'action', run: () => openSettings() },
  { label: 'Safeguards (read-only, protection, recovery)', kind: 'action', feature: 'recovery', run: () => openSafeguards() },
  { label: 'Emergency recovery snapshot', kind: 'action', feature: 'recovery', run: () => snapshotFlow() },
  { label: 'Security scan — vulnerable dependencies', kind: 'action', feature: 'dependency-audit', allowExperimental: true, run: () => securityScanFlow() },
  { label: 'Export recent activity', kind: 'action', feature: 'repository.read', run: () => exportActivityFlow() },
  { label: 'Toggle theme', kind: 'action', run: () => toggleTheme() },
  { label: 'Actions (CI)', kind: 'view', feature: 'workflows.read', allowExperimental: true, run: () => switchTab('actions') },
  { label: 'Neural', kind: 'view', feature: 'access-surface', run: () => switchTab('neural') },
  /*
   * Governance had no palette entry at all, while every other destination in
   * the workbench had one -- so the one surface that is also hardest to see in
   * the tab strip was the one a reader could not jump to by name either.
   */
  { label: 'Governance', kind: 'view', feature: 'governance', allowExperimental: true, run: () => switchTab('governance') },
  { label: 'Manage branches', kind: 'action', feature: 'branches.write', run: () => openBranchManager() },
  { label: 'Star / unstar this repo', kind: 'action', feature: 'stars.write', allowExperimental: true, run: () => toggleStar() },
  { label: 'Open the Time Machine', kind: 'action', feature: 'recovery', run: () => openTimeMachine() },
  { label: 'Delete this repository…', kind: 'danger', feature: 'repository.delete', run: () => deleteRepoFlow() },
  { label: 'Back to repositories', kind: 'view', run: () => $('#backBtn').click() }
];
/*
 * Where focus goes when the palette closes.
 *
 * The palette takes focus into a layer it then hides, so every exit -- Escape,
 * a click on the backdrop, or picking a row -- left focus on the document
 * body. Picking a row was the worst of the three: the command that opens a
 * dialog ran with nothing focused, so the dialog recorded nothing to return
 * to, and closing it stranded a keyboard reader at the top of the page.
 */
let paletteReturnFocus = null;
async function openPalette() {
  if (_page !== 'work') return;
  paletteReturnFocus = document.activeElement;
  $('#paletteScrim').hidden = false;
  const inp = $('#paletteInput');
  inp.value = ''; renderPalette('');
  setTimeout(() => inp.focus(), 50);
  if (!state.fileIndex) {
    try {
      const out = await api(`/api/repo/${wPath()}/files?ref=${encodeURIComponent(state.work.branch)}`);
      state.fileIndex = out.files;
      if (!$('#paletteScrim').hidden) renderPalette(inp.value);
    } catch { state.fileIndex = []; }
  }
}
function closePalette() {
  const scrim = $('#paletteScrim');
  /*
   * Pressing a row blurs the input before the handler runs -- the rows are
   * options, not focusable elements -- so by the time this is reached focus is
   * already on the body. Both that and focus still inside the layer mean the
   * reader has nowhere to return to; anything else is a deliberate target and
   * is left alone.
   */
  const active = document.activeElement;
  const strayed = !active || active === document.body || scrim.contains(active);
  scrim.hidden = true;
  /*
   * The input keeps combobox state, and hiding the scrim does not clear it, so
   * a reader who closed the palette was still told it was expanded and still
   * pointed at a row that is no longer shown.
   */
  const input = $('#paletteInput');
  if (input) {
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }
  const restore = paletteReturnFocus;
  paletteReturnFocus = null;
  if (strayed && restore && restore.isConnected && typeof restore.focus === 'function') restore.focus();
}
$('#paletteBtn').addEventListener('click', openPalette);
$('#paletteScrim').addEventListener('click', e => { if (e.target === $('#paletteScrim')) closePalette(); });
function fuzzy(q, s) {
  q = q.toLowerCase(); s = s.toLowerCase();
  let i = 0;
  for (const ch of s) { if (ch === q[i]) i++; if (i === q.length) return true; }
  return q.length === 0;
}
function renderPalette(q) {
  const host = $('#paletteList');
  const cmds = COMMANDS.filter(c => fuzzy(q, c.label));
  const files = (state.fileIndex || []).filter(p => fuzzy(q, p)).slice(0, 14)
    .map(p => ({ label: p, kind: 'file', run: () => openFile(p) }));
  const recents = q ? [] : getRecents().filter(p => (state.fileIndex || []).includes(p) || !state.fileIndex)
    .map(p => ({ label: p, kind: 'recent', run: () => openFile(p) }));
  palItems = q ? [...files, ...cmds.slice(0, 6)] : [...recents.slice(0, 5), ...cmds, ...files.slice(0, 6)];
  palSel = 0;
  host.innerHTML = '';
  /*
   * The results are a listbox and each row an option, so the selection a
   * reader sees highlighted is the one a screen reader announces. Before this
   * the rows were plain divs: the arrow keys moved a class nobody could hear,
   * and no automated rule could report it, because a div list is not incorrect
   * markup -- it is merely silent.
   */
  const input = $('#paletteInput');
  if (!palItems.length) {
    host.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'pal-item';
    empty.setAttribute('role', 'option');
    empty.setAttribute('aria-selected', 'false');
    empty.setAttribute('aria-disabled', 'true');
    empty.textContent = 'No matches';
    host.appendChild(empty);
    input.setAttribute('aria-expanded', 'true');
    input.removeAttribute('aria-activedescendant');
    return;
  }
  palItems.forEach((it, i) => {
    const el = document.createElement('div');
    el.className = 'pal-item' + (i === palSel ? ' sel' : '');
    el.id = `pal-option-${i}`;
    el.setAttribute('role', 'option');
    el.setAttribute('aria-selected', i === palSel ? 'true' : 'false');
    el.innerHTML = `<span class="${it.kind === 'file' ? 'mono' : ''}"></span><span class="pal-kind">${it.kind}</span>`;
    el.querySelector('span').textContent = it.label;
    if (it.feature) el.dataset.feature = it.feature;
    if (it.allowExperimental) el.dataset.allowExperimental = 'true';
    el.addEventListener('click', () => runPaletteItem(it));
    host.appendChild(el);
  });
  input.setAttribute('aria-expanded', 'true');
  input.setAttribute('aria-activedescendant', `pal-option-${palSel}`);
  window.NebulaCapabilityUI.apply(host);
}
function runPaletteItem(item) {
  return runCapabilityAction(item && item.feature, () => {
    closePalette();
    item.run();
  }, { allowExperimental: !!(item && item.allowExperimental) });
}
$('#reposRefreshBtn') && $('#reposRefreshBtn').addEventListener('click', () => loadRepos(true));

/*
 * The rail is chrome around the screens, so it follows them rather than each
 * screen carrying a copy. It appears once a session is authenticated and marks
 * the screen in view as current, which is what a reader navigating by landmark
 * relies on to know where they are.
 */
const RAIL_SCREENS = new Set(['overview', 'repos', 'work']);
function paintRail(name) {
  const rail = $('#navRail');
  if (!rail) return;
  rail.hidden = !RAIL_SCREENS.has(name);
  const activeTab = ($('.tabpane.active') || {}).id || '';
  /*
   * Two of the workbench's tabs are destinations in their own right rather
   * than views of the file it has open, and the rail offers them as such -- so
   * when one of them is what the reader is looking at, the rail marks that
   * entry rather than the workbench it technically sits inside.
   */
  const promoted = { 'tab-neural': 'neural', 'tab-governance': 'governance' };
  const shown = name === 'work' && promoted[activeTab] ? promoted[activeTab] : name;
  $$('.nv-rail-item').forEach(item => {
    const current = item.dataset.rail === shown;
    if (current) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  });
  const user = $('#navUser');
  const me = state.me;
  if (user) {
    const label = me && (me.name || me.login);
    user.hidden = !label;
    if (label) {
      $('#navUserInitial').textContent = String(label).trim().charAt(0).toUpperCase();
      $('#navUserName').textContent = label;
      $('#navUserSub').textContent = (me && me.login) ? `@${me.login}` : '';
    }
  }
}
/*
 * Neural and the workbench are views of an open repository rather than places
 * of their own, so the rail offers them as destinations and refuses when there
 * is no repository to show, instead of opening an empty one.
 */
/*
 * Below the wide breakpoint the rail is a drawer rather than standing chrome,
 * so something has to open it. Three top bars carry the control -- overview,
 * inventory and workspace -- because each screen draws its own bar.
 *
 * Focus returns to whichever bar opened it: a reader dismissed back to the top
 * of the document has lost their place.
 */
let navMenuOpener = null;
function navMenuOpen() { return document.body.classList.contains('nav-open'); }
function setNavMenu(open, opener) {
  document.body.classList.toggle('nav-open', open);
  const scrim = $('#navScrim');
  if (scrim) scrim.hidden = !open;
  $$('.nav-menu-btn').forEach(button => button.setAttribute('aria-expanded', String(open)));
  if (open) {
    navMenuOpener = opener || null;
    const first = $('#navRail .nv-rail-item');
    if (first) first.focus();
    return;
  }
  const restore = navMenuOpener;
  navMenuOpener = null;
  if (restore && document.contains(restore)) restore.focus();
}
function closeNavMenu() { if (navMenuOpen()) setNavMenu(false); }
$$('.nav-menu-btn').forEach(button => button.addEventListener('click', () => {
  setNavMenu(!navMenuOpen(), button);
}));
$('#navScrim') && $('#navScrim').addEventListener('click', closeNavMenu);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && navMenuOpen()) { event.preventDefault(); closeNavMenu(); }
});
/* A drawer is a narrow-screen affordance; widening the window makes the rail
   standing chrome again, and a scrim over it would be stranded. */
window.addEventListener('resize', () => {
  if (window.innerWidth >= 1140) closeNavMenu();
});

$$('.nv-rail-item').forEach(item => item.addEventListener('click', () => {
  const target = item.dataset.rail;
  closeNavMenu();
  if (target === 'overview') return showOverview();
  if (target === 'repos') return showPage('repos');
  if (!state.work) return toast('Open a repository first.', 'err');
  showPage('work');
  if (target === 'neural' || target === 'governance') switchTab(target);
  else paintRail('work');
}));
$('#paletteInput').addEventListener('input', e => renderPalette(e.target.value));
$('#paletteInput').addEventListener('keydown', e => {
  if (e.key === 'ArrowDown') { palSel = Math.min(palSel + 1, palItems.length - 1); paintSel(); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { palSel = Math.max(palSel - 1, 0); paintSel(); e.preventDefault(); }
  else if (e.key === 'Enter') { const it = palItems[palSel]; if (it) runPaletteItem(it); }
  else if (e.key === 'Escape') closePalette();
});
function paintSel() {
  $$('#paletteList .pal-item').forEach((el, i) => {
    el.classList.toggle('sel', i === palSel);
    el.setAttribute('aria-selected', i === palSel ? 'true' : 'false');
  });
  const sel = $('#paletteList .pal-item.sel');
  if (sel) sel.scrollIntoView({ block: 'nearest' });
  /* The input keeps focus, so the moved selection is announced through it. */
  const input = $('#paletteInput');
  if (sel && sel.id) input.setAttribute('aria-activedescendant', sel.id);
}

/* global shortcuts */
document.addEventListener('keydown', e => {
  if (!$('#scrim').hidden && e.key === 'Tab') {
    const focusable = $$('#modal button:not([disabled]), #modal input:not([disabled]), #modal textarea:not([disabled]), #modal select:not([disabled]), #modal [tabindex]:not([tabindex="-1"])')
      .filter(element => !element.hidden && element.offsetParent !== null);
    if (focusable.length) {
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && _page === 'work' && state.file && !state.file.binary && currentTab() === 'editor') {
    e.preventDefault(); openFindPanel();
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && _page === 'work' && state.file && !state.file.binary) {
    e.preventDefault();
    if (!$('#stageFileBtn').disabled) $('#stageFileBtn').click();
  }
  if (e.key === 'Escape') {
    if (!$('#paletteScrim').hidden) closePalette();
    else if (!$('#stageScrim').hidden) closeStagePanel();
    else if (!$('#sheetScrim').hidden) closeSheet();
    else if (!$('#scrim').hidden) closeModal(false);
    else closeDrawer();
  }
});

/* ================= UPLOAD ================= */
const dz = $('#dropzone');
dz.addEventListener('click', e => { if (e.target.tagName !== 'LABEL') $('#filePicker').click(); });
;['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('drag'); }));
;['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('drag'); }));
dz.addEventListener('drop', async e => {
  const items = [...(e.dataTransfer.items || [])];
  const entries = items.map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
  if (entries.length && entries.some(en => en.isDirectory)) {
    const out = [];
    for (const en of entries) await traverseEntry(en, '', out);
    queueEntries(out);
  } else queueFiles(e.dataTransfer.files);
});
$('#filePicker').addEventListener('change', e => { queueFiles(e.target.files); e.target.value = ''; });
/*
 * The label on a queued file is the server's own decision, not a second copy of
 * it. Both call planUploadTransport, so what the reader is shown before the
 * upload and what actually carries it cannot disagree.
 */
function transportPlanFor(size, transport) {
  return NebulaUploadPlanning.planUploadTransport({
    size,
    requested: transport,
    lfsAvailable: (state.me && state.me.provider ? state.me.provider : 'github') === 'github',
    gitPushMaxBytes: state.runtime.nativePushMaxMb * 1048576,
    gitDataMaxBytes: state.runtime.contentsMaxMb * 1048576
  });
}
/*
 * Each queued file keeps the choice it was queued with, so this re-reads that
 * choice rather than the control's current position: changing the control must
 * not rewrite the label of a file already on its way.
 */
function refreshQueuedStrategies() {
  for (const el of $$('#uploadQueue .uq-strategy')) {
    const size = Number(el.dataset.size);
    if (!Number.isFinite(size)) continue;
    el.textContent = strategyFor(size, el.dataset.transport || 'auto');
  }
}
const ROUTE_LABEL = { 'git-data': 'Git Data API', 'git-push': 'native git push', lfs: 'Git LFS ✦' };
function strategyFor(size, transport) {
  let plan;
  try { plan = transportPlanFor(size, transport); }
  catch { return 'checking limits…'; }
  if (plan.refusal) return 'too large for this deployment';
  const label = ROUTE_LABEL[plan.route] || plan.route;
  /* A swap the reader did not ask for is said on the file, not discovered
   * afterwards in the landed line. */
  return plan.fallback ? `${label} — ${plan.fallback.to === 'lfs' ? 'Git' : 'Git LFS'} cannot carry this` : label;
}
const _dirIndex = new Map();
let uploadModeV = 'single';
let uploadTransportV = 'auto';
$('#uploadTransport').addEventListener('click', e => {
  const b = e.target.closest('.seg-btn');
  if (!b || b.dataset.capabilityBlocked === 'true') return;
  selectSegment('#uploadTransport', x => x === b);
  uploadTransportV = NebulaUploadPlanning.normalizeTransportChoice(b.dataset.v);
});
const batchQueue = []; // { file, targetPath, item }
$('#uploadMode').addEventListener('click', e => {
  const b = e.target.closest('.seg-btn'); if (!b) return;
  selectSegment('#uploadMode', x => x === b);
  uploadModeV = b.dataset.v;
});
$('#folderPickBtn').addEventListener('click', () => $('#folderPicker').click());
$('#folderPicker').addEventListener('change', e => {
  const entries = [...e.target.files].map(f => ({ file: f, rel: f.webkitRelativePath || f.name }));
  queueEntries(entries);
  e.target.value = '';
});
async function traverseEntry(entry, prefix, out) {
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    out.push({ file, rel: prefix + entry.name });
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    let batch;
    do {
      batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      for (const ch of batch) await traverseEntry(ch, prefix + entry.name + '/', out);
    } while (batch.length);
  }
}
function queueFiles(files) {
  const arr = [...files];
  if (arr.length === 1 && /\.zip$/i.test(arr[0].name)) return handleZip(arr[0]);
  queueEntries(arr.map(f => ({ file: f, rel: f.name })));
}
const _loadedScripts = new Map();
function loadScript(src) {
  if (_loadedScripts.has(src)) return _loadedScripts.get(src);
  const p = new Promise((res, rej) => {
    const sc = document.createElement('script');
    sc.src = src;
    sc.onload = res;
    sc.onerror = () => { _loadedScripts.delete(src); rej(new Error('Could not load extraction library — check your connection')); };
    document.head.appendChild(sc);
  });
  _loadedScripts.set(src, p);
  return p;
}
async function unzipNative(buf) {
  if (!window.DecompressionStream) throw new Error('This browser lacks built-in decompression (needs iOS 16.4+/modern Chrome)');
  const guard = window.NebulaArchiveSafety;
  if (!guard || typeof guard.validateArchiveEntries !== 'function') throw new Error('Archive safety guard is unavailable — extraction is blocked');
  const dv = new DataView(buf), u8 = new Uint8Array(buf);
  if (buf.byteLength < 22) throw new Error('Not a valid zip file');
  /* Locate End Of Central Directory. ZIP64 and split archives are rejected to keep browser extraction bounded. */
  let eocd = -1;
  const stop = Math.max(0, buf.byteLength - 22 - 65535);
  for (let i = buf.byteLength - 22; i >= stop; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0 || eocd + 22 > buf.byteLength) throw new Error('Not a valid zip file');
  const diskNumber = dv.getUint16(eocd + 4, true);
  const centralDisk = dv.getUint16(eocd + 6, true);
  const entriesOnDisk = dv.getUint16(eocd + 8, true);
  const count = dv.getUint16(eocd + 10, true);
  const centralSize = dv.getUint32(eocd + 12, true);
  let off = dv.getUint32(eocd + 16, true);
  if (diskNumber || centralDisk || entriesOnDisk !== count) throw new Error('Split zip archives are not supported');
  if (count === 0xffff || centralSize === 0xffffffff || off === 0xffffffff) throw new Error('ZIP64 extraction is not supported in the browser');
  if (count > 2000) throw new Error('Archive contains too many directory records');
  if (off + centralSize > eocd || off < 0) throw new Error('Corrupt zip central directory bounds');
  const rawEntries = [];
  const td = new TextDecoder('utf-8', { fatal: false });
  for (let n = 0; n < count; n++) {
    if (off + 46 > eocd || dv.getUint32(off, true) !== 0x02014b50) throw new Error('Corrupt zip central directory');
    const flags = dv.getUint16(off + 8, true);
    if (flags & 0x41) throw new Error('Password-protected zips are not supported');
    const method = dv.getUint16(off + 10, true);
    const crc = dv.getUint32(off + 16, true);
    const compressedSize = dv.getUint32(off + 20, true);
    const uncompressedSize = dv.getUint32(off + 24, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    const localOff = dv.getUint32(off + 42, true);
    const end = off + 46 + nameLen + extraLen + commentLen;
    if (end > eocd) throw new Error('Corrupt zip central directory entry bounds');
    const nameBytes = u8.subarray(off + 46, off + 46 + nameLen);
    if (!(flags & 0x800) && nameBytes.some(byte => byte > 0x7f)) throw new Error('Legacy non-UTF-8 zip filenames are not supported');
    const rawName = td.decode(nameBytes);
    if (!rawName.endsWith('/')) rawEntries.push({ name: rawName, method, compressedSize, uncompressedSize, localOff, crc });
    off = end;
  }
  const validated = guard.validateArchiveEntries(rawEntries);
  const out = Object.create(null);
  let actualTotal = 0;
  for (const e of validated.entries) {
    if (e.localOff + 30 > buf.byteLength || dv.getUint32(e.localOff, true) !== 0x04034b50) throw new Error('Corrupt zip local header');
    const localFlags = dv.getUint16(e.localOff + 6, true);
    const localMethod = dv.getUint16(e.localOff + 8, true);
    const lNameLen = dv.getUint16(e.localOff + 26, true);
    const lExtraLen = dv.getUint16(e.localOff + 28, true);
    const nameStart = e.localOff + 30;
    const dataStart = nameStart + lNameLen + lExtraLen;
    const dataEnd = dataStart + e.compressedSize;
    if ((localFlags & 0x41) || localMethod !== e.method || dataStart > buf.byteLength || dataEnd > buf.byteLength) {
      throw new Error(`Corrupt zip entry metadata: ${e.name}`);
    }
    const localName = td.decode(u8.subarray(nameStart, nameStart + lNameLen));
    if (guard.normalizeZipPath(localName) !== e.name) throw new Error(`Zip entry name mismatch: ${e.name}`);
    const comp = u8.subarray(dataStart, dataEnd);
    let data;
    if (e.method === 0) data = new Uint8Array(comp);
    else {
      const resp = new Response(new Blob([comp]).stream().pipeThrough(new DecompressionStream('deflate-raw')));
      data = new Uint8Array(await resp.arrayBuffer());
    }
    if (data.byteLength !== e.uncompressedSize) throw new Error(`Zip entry size mismatch: ${e.name}`);
    actualTotal += data.byteLength;
    if (actualTotal > validated.limits.maxTotalUncompressed) throw new Error('Archive exceeds the total extracted-size ceiling');
    if (guard.crc32(data) !== e.crc) throw new Error(`Zip entry integrity check failed: ${e.name}`);
    out[e.name] = data;
  }
  return out;
}

async function handleZip(zipFile) {
  if (zipFile.size > 120 * 1048576) return toast('Zip over 120 MB — push it as a plain file instead (mobile memory limits)', 'err');
  const ok = await modal({
    title: 'Zip archive',
    bodyHTML: `<p style="font-size:.9rem;line-height:1.6"><b class="mono">${esc(zipFile.name)}</b> (${fmtSize(zipFile.size)})</p>
      <label class="check"><input type="checkbox" id="zipExtract" checked> <b>Extract</b> it and commit the files inside <span class="muted">(uncheck to push the .zip itself as a single file)</span></label>`,
    okText: 'Continue'
  });
  if (!ok) return;
  if (!($('#zipExtract') && $('#zipExtract').checked)) return queueEntries([{ file: zipFile, rel: zipFile.name }]);
  try {
    toast('Extracting archive…');
    const out = await unzipNative(await zipFile.arrayBuffer());
    const entries = [];
    for (const [name, data] of Object.entries(out)) {
      if (name.endsWith('/')) continue;
      entries.push({ file: new File([data], name.split('/').pop() || 'file'), rel: name });
    }
    if (!entries.length) return toast('The zip appears to be empty', 'err');
    if (entries.length > 500) return toast(`Zip has ${entries.length} files — at most 500 can be extracted at once`, 'err');
    if (uploadModeV !== 'batch') {
      uploadModeV = 'batch';
      selectSegment('#uploadMode', b => b.dataset.v === 'batch');
      toast('Batch mode selected — preparing the upload plan…');
    }
    queueEntries(entries);
  } catch (e) { toast('Extraction failed: ' + e.message, 'err'); }
}
$('#zipUploadBtn').addEventListener('click', () => $('#zipPicker').click());
$('#zipPicker').addEventListener('change', e => { if (e.target.files[0]) handleZip(e.target.files[0]); e.target.value = ''; });
async function queueEntries(entries, retrying = false) {
  entries = entries.filter(en => !/(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$)/.test(en.rel));
  if (!entries.length) return;
  /* if everything sits inside one wrapper folder, offer to strip it (recommended) */
  const tops = new Set(entries.map(en => en.rel.split('/')[0]));
  if (!retrying && tops.size === 1 && entries.some(en => en.rel.includes('/'))) {
    const top = [...tops][0];
    const ok = await modal({
      title: 'Wrapper folder detected',
      bodyHTML: `<p style="font-size:.9rem;line-height:1.6">Everything you selected lives inside <b class="mono">${esc(top)}/</b>.</p>
        <label class="check"><input type="checkbox" id="stripTop" checked> Upload its <b>contents</b> directly — don't create a <span class="mono">${esc(top)}/</span> folder in the repo <span class="muted">(recommended)</span></label>`,
      okText: 'Continue'
    });
    if (!ok) return;
    if ($('#stripTop') && $('#stripTop').checked) {
      entries = entries
        .map(en => ({ file: en.file, rel: en.rel.split('/').slice(1).join('/') }))
        .filter(en => en.rel);
    }
  }
  // Resolve destinations once, after the user's wrapper-folder choice. Retries
  // reuse these settings even if the form has since changed.
  entries = entries.map(en => ({ ...en, upload: en.upload || uploadSettings(en.file, en.rel) }));
  const forcedBatch = entries.filter(en => en.upload.transport === 'lfs' && en.upload.mode === 'batch');
  if (forcedBatch.length) {
    const count = forcedBatch.length;
    const approved = await modal({
      title: 'Git LFS uses separate commits',
      okText: 'Upload with LFS',
      bodyHTML: `<p class="sp-lead">Choosing Git LFS cannot currently use the ordinary batch-commit route.</p>
        <p class="sp-lead">This selection will upload one file at a time using Git LFS, creating up to <b>${count} separate commit${count === 1 ? '' : 's'}</b>. These files will not be added to an ordinary batch.</p>
        <p class="hint">Existing queued batches are unchanged. Cancel to adjust your choices; no files from this selection have been sent.</p>`
    });
    if (!approved) return;
    // The approval applies to this selection, not to other queued files or
    // future selections. Retries keep the explicitly approved mode.
    entries = entries.map(en => en.upload.transport === 'lfs' && en.upload.mode === 'batch'
      ? { ...en, upload: Object.freeze({ ...en.upload, mode: 'single' }) }
      : en);
  }
  _dirIndex.clear();
  const failed = [];
  const counts = { uploaded: 0, queued: 0, skipped: 0 };
  for (const en of entries) {
    try {
      const result = await uploadOne(en.file, en.rel, en.upload);
      if (result.status === 'failed') failed.push({ en, msg: result.message, item: result.item });
      else counts[result.status] += 1;
    }
    catch (err) { failed.push({ en, msg: (err && err.message) || 'failed' }); }
  }
  updateBatchBar();
  if (failed.length) {
    const retry = await modal({
      title: `${failed.length} of ${entries.length} didn't upload`,
      okText: 'Retry failed',
      bodyHTML: `<div style="max-height:40vh;overflow-y:auto">${failed.slice(0, 30).map(f =>
        `<p class="hint" style="margin:3px 0"><span class="mono">${esc(f.en.rel)}</span> — ${esc(f.msg)}</p>`).join('')}
        ${failed.length > 30 ? `<p class="hint">…and ${failed.length - 30} more</p>` : ''}</div>`
    });
    if (retry) {
      failed.forEach(f => { if (f.item) f.item.remove(); });
      return queueEntries(failed.map(f => f.en), true);
    }
  } else if (entries.length > 1) {
    const labels = { uploaded: 'uploaded', queued: 'queued — commit pending', skipped: 'unchanged — skipped' };
    const summary = Object.entries(counts).filter(([, count]) => count)
      .map(([outcome, count]) => `${count} file${count === 1 ? '' : 's'} ${labels[outcome]}`).join('; ');
    toast(summary, counts.queued ? '' : 'ok');
  }
}
async function getDirIndex(dir) {
  const key = `${state.me && state.me.offlineCacheScope}:${wPath()}:${state.work.branch}:${dir}`;
  if (_dirIndex.has(key)) return _dirIndex.get(key);
  const p = (async () => {
    const map = new Map();
    try {
      const items = await api(`/api/repo/${wPath()}/tree?ref=${encodeURIComponent(state.work.branch)}&path=${encodeURIComponent(dir)}`);
      items.forEach(i => { if (i.type === 'file') map.set(i.name, i.sha); });
    } catch {} /* 404 → folder doesn't exist yet, everything is new */
    return map;
  })();
  _dirIndex.set(key, p);
  return p;
}
async function gitBlobSha(file) {
  const buf = await file.arrayBuffer();
  const header = new TextEncoder().encode(`blob ${buf.byteLength}\u0000`);
  const full = new Uint8Array(header.length + buf.byteLength);
  full.set(header); full.set(new Uint8Array(buf), header.length);
  const d = await crypto.subtle.digest('SHA-1', full);
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function uploadSettings(file, rel) {
  const dir = $('#uploadDir').value.trim().replace(/^\/+|\/+$/g, '');
  const targetPath = (dir ? dir + '/' : '') + (rel || file.name);
  return Object.freeze({
    owner: state.work.owner, repo: state.work.repo, branch: state.work.branch,
    provider: state.me && state.me.provider,
    account: state.me && state.me.offlineCacheScope,
    login: state.me && state.me.login,
    targetPath,
    message: $('#uploadMsg').value.trim() || `Sync ${targetPath} via ${NV_PRODUCT_NAME}`,
    transport: uploadTransportV, mode: uploadModeV
  });
}
function uploadContextMatches(settings) {
  return state.work && state.me
    && settings.owner === state.work.owner && settings.repo === state.work.repo
    && settings.branch === state.work.branch && settings.provider === state.me.provider
    && settings.account === state.me.offlineCacheScope && settings.login === state.me.login;
}
async function uploadOne(file, rel, settings = uploadSettings(file, rel)) {
  if (ownerWorkbench) throw new Error('Uploads are not connected to the owner workbench yet.');
  const { targetPath, message, transport, mode } = settings;
  const w = settings;

  const item = document.createElement('div');
  item.className = 'uq-item';
  item.innerHTML = `
    <div class="uq-top">
      <span class="uq-name"></span><span class="uq-size">${fmtSize(file.size)}</span>
      <span class="uq-verdict" hidden></span>
      <span class="uq-strategy" data-size="${file.size}" data-transport="${transport}">${strategyFor(file.size, transport)}</span>
    </div>
    <div class="uq-bar"><div class="uq-fill"></div></div>
    <div class="uq-status">Comparing with repo…</div>`;
  item.querySelector('.uq-name').textContent = targetPath;
  $('#uploadQueue').prepend(item);
  const fill = item.querySelector('.uq-fill');
  const status = item.querySelector('.uq-status');
  const verdictEl = item.querySelector('.uq-verdict');
  const fail = message => {
    item.classList.add('error');
    status.textContent = '✗ ' + message;
    addRetry(item, file, rel, settings);
    return { status: 'failed', message, item };
  };
  const checkContext = () => {
    if (!uploadContextMatches(settings)) {
      throw new Error(`Return to the original account and ${w.owner}/${w.repo} on ${w.branch} before retrying this upload.`);
    }
  };

  try {
    checkContext();
    /*
     * Refused rather than guessed. Sending a file against an assumed ceiling
     * spends the whole transfer before the server refuses it, and names a limit
     * that is not the one being enforced.
     */
    if (!runtimeLimitsKnown()) {
      await loadRuntimeConfig();
      if (!runtimeLimitsKnown()) {
        return fail(`${file.name}: upload limits are unavailable, so the size cannot be checked. Retry once the service responds.`);
      }
    }
    if (file.size > state.runtime.uploadMaxMb * 1048576) {
      return fail(`${file.name}: exceeds the ${state.runtime.uploadMaxMb} MB per-file limit`);
    }
    if (mode === 'batch' && transport === 'lfs') {
      return fail('Select the files again and confirm separate LFS commits before uploading.');
    }

    /* --- smart sync precheck --- */
    try {
      const fullDir = targetPath.includes('/') ? targetPath.slice(0, targetPath.lastIndexOf('/')) : '';
      const baseName = targetPath.split('/').pop();
      const dirMap = await getDirIndex(fullDir);
      checkContext();
      const existingSha = dirMap.get(baseName);
      // Equal raw Git bytes do not satisfy a request to convert the file to LFS.
      if (transport !== 'lfs' && existingSha && file.size <= 32 * 1048576) {
        const localSha = await gitBlobSha(file);
        if (localSha === existingSha) {
          item.classList.add('done');
          fill.style.width = '100%';
          verdictEl.hidden = false; verdictEl.textContent = 'unchanged'; verdictEl.classList.add('v-skip');
          status.textContent = '✓ Identical to the repo version — skipped, nothing to commit.';
          return { status: 'skipped', item };
        }
      }
      verdictEl.hidden = false;
      if (existingSha) { verdictEl.textContent = 'update'; verdictEl.classList.add('v-update'); }
      else { verdictEl.textContent = 'new'; verdictEl.classList.add('v-new'); }
    } catch {}
    checkContext();
    if (mode === 'batch') {
      /*
       * This is the ordinary raw-blob batch route. An explicit Git LFS choice
       * needs approval before using individual commits and cannot enter it.
       * Oversized ordinary files still use the existing smart upload router.
       *
       * "Oversized" is the boundary the server publishes, read through the same
       * plan the upload itself is routed by. It used to be a 40 written here,
       * which is the server's number only for as long as nobody moves it.
       */
      let needsIndividual = true;
      try { needsIndividual = transportPlanFor(file.size, transport).route !== 'git-data'; }
      catch { /* Limits not known yet: let the server's own router decide. */ }
      if (!needsIndividual) {
        status.textContent = 'Queued for the batch commit.';
        batchQueue.push({ file, targetPath, item, fill, status });
        return { status: 'queued', item };
      }
      status.textContent = 'Big file — pushing individually via the smart router (GitHub cannot batch blobs this large)…';
    }
    if (mode !== 'batch') status.textContent = 'Launching…';


    await ensureCsrfToken();
    checkContext();
    const xhr = new XMLHttpRequest();
    let outcome;
    const qs = new URLSearchParams({ path: targetPath, branch: w.branch, message, lfs: transport });
    const expectedHeadSha = currentHeadSha(w.branch);
    if (expectedHeadSha) qs.set('expectedHeadSha', expectedHeadSha);
    xhr.open('POST', `/api/repo/${w.owner}/${w.repo}/upload?${qs}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('x-nv', '1');
    xhr.setRequestHeader('x-nv-csrf', csrfToken);
    xhr.upload.onprogress = e => {
      if (e.lengthComputable) {
        const pct = Math.round(e.loaded / e.total * 100);
        fill.style.width = Math.min(pct, 92) + '%';
        status.textContent = pct < 100 ? `Transmitting… ${pct}%` : 'Relay received — pushing to GitHub…';
      }
    };
    xhr.onload = () => {
      let res = {};
      try { res = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 200 && xhr.status < 300 && res && res.ok) {
        fill.style.width = '100%'; item.classList.add('done');
        const strat = { 'contents-api': 'Git Data API', 'git-data-api': 'Git Data API', 'git-push': 'native git push ⟴', 'git-data-blob': 'Git Data API', 'lfs': 'Git LFS' }[res.strategy] || res.strategy;
        /*
         * A transport the reader did not choose is named on the file that got
         * it. Landing "via Git LFS" after asking for Git, with no reason given,
         * is how the old force-only behaviour felt from the outside.
         */
        const swap = res.transport && res.transport.fallback;
        const because = swap ? ` — asked for ${swap.from === 'git' ? 'Git' : 'Git LFS'}, but ${swap.reason}` : '';
        status.textContent = `✦ Landed on ${w.branch} via ${strat}${because} — commit ${String(res.commit || '').slice(0, 7)}`;
        if (swap) item.classList.add('fell-back');
        outcome = { status: 'uploaded', item };
        toast(`${file.name} pushed ✦`, 'ok');
        if (uploadContextMatches(settings)) {
          rememberHead(res.commit, w.branch);
          state.fileIndex = null;
          loadTree('', $('#tree'), true);
          refreshRate();
        }
      } else {
        outcome = fail((res && res.error) || `Upload failed (${xhr.status})`);
      }
    };
    xhr.onerror = () => { outcome = fail('Network error during upload'); };
    xhr.onabort = () => { outcome = fail('Upload cancelled'); };
    xhr.ontimeout = () => { outcome = fail('Upload timed out'); };
    /*
     * Awaited, because it was not.
     *
     * uploadOne is an async function and the queue awaits it, but the function
     * used to end at xhr.send() -- so the await resolved when the request was
     * SENT, not when it completed. The loop looked sequential and was not: every
     * file in the queue went out before the first reply came back, each carrying
     * the expectedHeadSha read before any of them landed. One commit moved the
     * head and the provider refused all the others as stale, which is why a zip
     * landed one file and offered a Retry on the rest.
     *
     * Settling on loadend rather than load so a network failure releases the
     * queue too. Return the actual outcome as well as updating the card so the
     * queue cannot count failed or cancelled transfers as successful uploads.
     */
    await new Promise(resolve => { xhr.addEventListener('loadend', resolve, { once: true }); xhr.send(file); });
    return outcome || fail('Upload ended without a confirmed result');
  } catch (error) {
    return fail((error && error.message) || 'Upload failed');
  }
}

/* ================= COMMITS ================= */
async function loadCommits(reset) {
  const host = $('#commitList');
  if (reset) { state.commitsPage = 1; host.innerHTML = '<div class="skeleton" style="height:70px"></div>'.repeat(4); }
  try {
    const commits = await api(`/api/repo/${wPath()}/commits?ref=${encodeURIComponent(state.work.branch)}&page=${state.commitsPage}`);
    if (reset) host.innerHTML = '';
    commits.forEach((c, i) => {
      const el = document.createElement('div');
      el.className = 'card commit-item pressable';
      el.style.animationDelay = Math.min(i * 40, 400) + 'ms';
      el.innerHTML = `
        <div class="commit-head">
          ${c.avatar ? `<img class="commit-avatar" src="${escAttr(c.avatar)}" alt="">` : ''}
          <span class="commit-msg"></span>
        </div>
        <div class="commit-meta"><span></span><span class="mono commit-sha">${c.sha.slice(0, 7)}</span><span>${timeAgo(c.date)}</span></div>
        <div class="commit-diff"></div>`;
      el.querySelector('.commit-msg').textContent = c.message.split('\n')[0];
      el.querySelector('.commit-meta span').textContent = c.author;
      el.addEventListener('click', () => toggleDiff(el, c.sha));
      host.appendChild(el);
    });
    $('#moreCommitsBtn').hidden = commits.length < 25;
  } catch (e) { toast(e.message, 'err'); if (reset) host.innerHTML = ''; }
}
$('#moreCommitsBtn').addEventListener('click', () => { state.commitsPage++; loadCommits(false); });
async function toggleDiff(el, sha) {
  const box = el.querySelector('.commit-diff');
  if (el.classList.contains('open')) return el.classList.remove('open');
  el.classList.add('open');
  if (box.dataset.loaded) return;
  box.innerHTML = '<div class="skeleton" style="height:60px"></div>';
  try {
    const d = await api(`/api/repo/${wPath()}/commit/${sha}`);
    box.innerHTML = ''; box.dataset.loaded = '1';
    const capsTm = !state.caps || state.caps.tm;
    const tm = document.createElement('div');
    tm.className = 'detail-actions';
    tm.style.marginTop = '4px';
    tm.innerHTML = `
      <button class="btn btn-ghost small" data-tm="revert"><svg class="ico" width="15" height="15" viewBox="0 0 24 24"><path d="M9.5 14.5L4 9l5.5-5.5M4 9h10a6.5 6.5 0 0 1 0 13h-3.5"/></svg>Revert this commit</button>
      <button class="btn btn-ghost small" data-tm="restore">Restore repo to here</button>
      <button class="btn btn-ghost small" data-tm="paths">Restore a file/folder from here…</button>
      <button class="btn btn-ghost small danger" data-tm="reset" ${branchProtected(state.work.branch) ? 'disabled title="Branch is protected — hard reset blocked"' : ''}>Hard reset…</button>`;
    tm.addEventListener('click', e => {
      const b = e.target.closest('[data-tm]');
      if (!b) return;
      e.stopPropagation();
      timeMachine(b.dataset.tm, sha, d.message);
    });
    if (capsTm) box.appendChild(tm);
    renderDiffFiles(box, d.files);
    if (!d.files.length) box.insertAdjacentHTML('beforeend', '<p class="hint">No file changes reported.</p>');
  } catch (e) { box.innerHTML = `<p class="hint">⚠ ${esc(e.message)}</p>`; }
}
function renderDiffFiles(host, files) {
  files.forEach(f => {
    const df = document.createElement('div');
    df.className = 'diff-file';
    df.innerHTML = `
      <div class="diff-file-head mono">
        <span></span>
        <span class="diff-adds">+${f.additions}</span><span class="diff-dels">−${f.deletions}</span>
        <span style="margin-left:auto;color:var(--muted)">${f.status}</span>
      </div>
      ${f.patch ? '<div class="diff-patch mono"></div>' : ''}`;
    df.querySelector('.diff-file-head span').textContent = f.filename;
    if (f.patch) {
      const pv = df.querySelector('.diff-patch');
      const lines = f.patch.split('\n');
      for (let li = 0; li < lines.length; li++) {
        const line = lines[li];
        const span = document.createElement('span');
        if (line.startsWith('-') && lines[li + 1] && lines[li + 1].startsWith('+')) {
          /* paired change → word-level highlight */
          const a = line.slice(1), b = lines[li + 1].slice(1);
          let p = 0; while (p < a.length && p < b.length && a[p] === b[p]) p++;
          let sA = a.length, sB = b.length;
          while (sA > p && sB > p && a[sA - 1] === b[sB - 1]) { sA--; sB--; }
          span.className = 'del';
          span.append('-' + a.slice(0, p));
          const mA = document.createElement('mark'); mA.textContent = a.slice(p, sA); span.appendChild(mA);
          span.append(a.slice(sA));
          pv.appendChild(span);
          const span2 = document.createElement('span');
          span2.className = 'add';
          span2.append('+' + b.slice(0, p));
          const mB = document.createElement('mark'); mB.textContent = b.slice(p, sB); span2.appendChild(mB);
          span2.append(b.slice(sB));
          pv.appendChild(span2);
          li++;
          continue;
        }
        span.textContent = line;
        if (line.startsWith('+')) span.className = 'add';
        else if (line.startsWith('-')) span.className = 'del';
        else if (line.startsWith('@@')) span.className = 'hunk';
        pv.appendChild(span);
      }
    }
    host.appendChild(df);
  });
}

/* ================= PULL REQUESTS ================= */
$('#prState').addEventListener('click', e => {
  const b = e.target.closest('.seg-btn'); if (!b) return;
  selectSegment('#prState', x => x === b);
  state.prState = b.dataset.v;
  loadPRs();
});
async function loadPRs() {
  const host = $('#prList');
  $('#prDetail').hidden = true;
  host.innerHTML = '<div class="skeleton" style="height:66px"></div>'.repeat(3);
  try {
    const prs = await apiCached(`/api/repo/${wPath()}/pulls?state=${state.prState}`);
    host.innerHTML = '';
    if (!prs.length) {
      host.innerHTML = `<div class="card editor-empty"><div class="empty-icon">${EMPTY_ICON.pulls}</div><p>No ${state.prState === 'all' ? '' : state.prState + ' '}pull requests.</p></div>`;
      return;
    }
    prs.forEach((p, i) => {
      const el = document.createElement('div');
      el.className = 'card list-item pressable';
      el.style.animationDelay = Math.min(i * 40, 360) + 'ms';
      const st = p.merged ? ['merged', 'state-merged'] : p.draft ? ['draft', 'state-draft'] : p.state === 'open' ? ['open', 'state-open'] : ['closed', 'state-closed'];
      el.innerHTML = `
        <div class="li-head"><span class="state-pill ${st[1]}">${st[0]}</span><span class="li-title"></span></div>
        <div class="li-meta"><span>#${p.number}</span><span></span><span class="mono">${esc(p.head)} → ${esc(p.base)}</span><span>${timeAgo(p.updated_at)}</span></div>`;
      el.querySelector('.li-title').textContent = p.title;
      el.querySelector('.li-meta span:nth-child(2)').textContent = p.user || '';
      el.addEventListener('click', () => openPR(p.number));
      host.appendChild(el);
    });
  } catch (e) { host.innerHTML = ''; toast(e.message, 'err'); }
}
async function openPR(num) {
  const box = $('#prDetail');
  box.hidden = false;
  box.innerHTML = '<div class="skeleton" style="height:120px"></div>';
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  try {
    const p = await api(`/api/repo/${wPath()}/pulls/${num}`);
    const st = p.merged ? ['merged', 'state-merged'] : p.draft ? ['draft', 'state-draft'] : p.state === 'open' ? ['open', 'state-open'] : ['closed', 'state-closed'];
    box.innerHTML = `
      <div class="detail-head">
        <span class="state-pill ${st[1]}">${st[0]}</span>
        <span class="detail-title"></span>
        <button class="btn btn-ghost small" id="prCloseDetail" aria-label="Close">${META_ICON.close}</button>
      </div>
      <div class="detail-meta">
        <span>#${p.number} by ${esc(p.user || '')}</span>
        <span class="mono">${esc(p.head)} → ${esc(p.base)}</span>
        <span class="diff-adds">+${p.additions}</span><span class="diff-dels">−${p.deletions}</span>
        <span>${p.changed_files} files</span>
      </div>
      <div class="detail-body" id="prBody" hidden></div>
      <div class="detail-actions" id="prActions"></div>
      <div id="prFiles" style="margin-top:14px"></div>
      <div id="prComments" style="margin-top:14px"></div>
      <label class="field-label" for="prNewComment">Add a comment</label>
      <textarea id="prNewComment" placeholder="Write a comment…"></textarea>
      <div class="detail-actions"><button class="btn btn-primary small" id="prCommentBtn">Comment ✦</button></div>`;
    box.querySelector('.detail-title').textContent = p.title;
    if (p.body) { $('#prBody').hidden = false; $('#prBody').textContent = p.body; }
    $('#prCloseDetail').addEventListener('click', () => { box.hidden = true; });
    if (p.state === 'open' && !p.draft) {
      const act = $('#prActions');
      [['merge', 'Merge'], ['squash', 'Squash & merge'], ['rebase', 'Rebase & merge']].forEach(([m, label]) => {
        const b = document.createElement('button');
        b.className = m === 'merge' ? 'btn btn-primary small' : 'btn btn-ghost small';
        b.textContent = label;
        b.addEventListener('click', async () => {
          const sure = await modal({ title: label,
            bodyHTML: `<p style="font-size:.9rem;line-height:1.5">${label} PR #${p.number} <b class="mono">${esc(p.head)}</b> into <b class="mono">${esc(p.base)}</b>?</p>`,
            okText: label });
          if (!sure) return;
          try {
            const merged = await stepUpApi('pull.merge', {
              owner: state.work.owner, repo: state.work.repo, pullNumber: p.number, method: m
            }, `/api/repo/${wPath()}/pulls/${p.number}/merge`, { method: 'PUT', body: { method: m } }, `${label} PR #${p.number}`);
            if (!merged) return;
            if (p.base === state.work.branch) rememberHead(merged.sha, p.base);
            await refreshRepoMetadata().catch(() => {});
            toast(`PR #${p.number} merged ✦`, 'ok');
            loadPRs();
          } catch (e) { toast(e.message, 'err'); }
        });
        act.appendChild(b);
      });
      if (p.mergeable === false) act.insertAdjacentHTML('beforeend',
        `<span class="hint" style="margin:0;align-self:center">⚠ Conflicts with base — resolve before merging.</span>`);
    }
    if (p.state === 'open') {
      const act = $('#prActions');
      [['APPROVE', '✓ Approve'], ['REQUEST_CHANGES', 'Request changes']].forEach(([ev, label]) => {
        const b = document.createElement('button');
        b.className = 'btn btn-ghost small';
        b.textContent = label;
        b.addEventListener('click', async () => {
          const ok = await modal({
            title: label,
            bodyHTML: `<label class="field-label" for="rvBody">Review comment ${ev === 'REQUEST_CHANGES' ? '(required)' : '(optional)'}</label>
              <textarea id="rvBody" placeholder="Feedback for the author…"></textarea>`,
            okText: label
          });
          if (!ok) return;
          const body = $('#rvBody').value.trim();
          if (ev === 'REQUEST_CHANGES' && !body) return toast('A comment is required to request changes', 'err');
          try {
            await api(`/api/repo/${wPath()}/pulls/${p.number}/reviews`, { method: 'POST', body: { event: ev, body } });
            toast(`Review submitted ✦`, 'ok');
            loadPRComments(p.number);
          } catch (e) { toast(e.message, 'err'); }
        });
        act.appendChild(b);
      });
    }
    renderDiffFiles($('#prFiles'), p.files || []);
    loadPRComments(num);
    $('#prCommentBtn').addEventListener('click', async () => {
      const body = $('#prNewComment').value.trim();
      if (!body) return;
      try {
        await api(`/api/repo/${wPath()}/issues/${num}/comments`, { method: 'POST', body: { body } });
        $('#prNewComment').value = '';
        toast('Comment posted ✦', 'ok');
        loadPRComments(num);
      } catch (e) { toast(e.message, 'err'); }
    });
  } catch (e) { box.innerHTML = `<p class="hint">⚠ ${esc(e.message)}</p>`; }
}
async function loadPRComments(num) {
  const host = $('#prComments');
  if (!host) return;
  try {
    const i = await api(`/api/repo/${wPath()}/issues/${num}`);
    host.innerHTML = '';
    i.comments.forEach(c => {
      const el = document.createElement('div');
      el.className = 'comment';
      el.innerHTML = `<div class="comment-head">${c.avatar ? `<img src="${escAttr(c.avatar)}" alt="">` : ''}<span>${esc(c.user || '')}</span><span>${timeAgo(c.created_at)}</span></div>
        <div class="comment-body"></div>`;
      el.querySelector('.comment-body').textContent = c.body || '';
      host.appendChild(el);
    });
  } catch {}
}
$('#newPrBtn').addEventListener('click', async () => {
  const names = state.work.branches.map(b => b.name);
  const ok = await modal({
    title: 'New pull request',
    bodyHTML: `
      <label class="field-label" for="prTitle">Title</label><input id="prTitle" type="text" spellcheck="false">
      <label class="field-label" for="prHead">Head (your changes)</label>
      <select id="prHead">${names.map(n => `<option ${n === state.work.branch ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>
      <label class="field-label" for="prBase">Base (merge into)</label>
      <select id="prBase">${names.map(n => `<option ${n === state.work.default_branch ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>
      <label class="field-label" for="prDesc">Description</label><textarea id="prDesc" placeholder="Optional"></textarea>
      <label class="check"><input type="checkbox" id="prDraft"> Draft</label>`,
    okText: 'Open PR ✦'
  });
  if (!ok) return;
  const title = $('#prTitle').value.trim();
  if (!title) return toast('Title required', 'err');
  try {
    const r = await api(`/api/repo/${wPath()}/pulls`, {
      method: 'POST',
      body: { title, head: $('#prHead').value, base: $('#prBase').value, body: $('#prDesc').value, draft: $('#prDraft').checked }
    });
    toast(`PR #${r.number} opened ✦`, 'ok');
    loadPRs();
  } catch (e) { toast(e.message, 'err'); }
});

/* ================= ISSUES ================= */
$('#issueState').addEventListener('click', e => {
  const b = e.target.closest('.seg-btn'); if (!b) return;
  selectSegment('#issueState', x => x === b);
  state.issueState = b.dataset.v;
  loadIssues();
});
async function loadIssues() {
  const host = $('#issueList');
  $('#issueDetail').hidden = true;
  host.innerHTML = '<div class="skeleton" style="height:66px"></div>'.repeat(3);
  try {
    const issues = await apiCached(`/api/repo/${wPath()}/issues?state=${state.issueState}`);
    host.innerHTML = '';
    if (!issues.length) {
      host.innerHTML = `<div class="card editor-empty"><div class="empty-icon">${EMPTY_ICON.issues}</div><p>No ${state.issueState} issues. Peace in the galaxy.</p></div>`;
      return;
    }
    issues.forEach((it, i) => {
      const el = document.createElement('div');
      el.className = 'card list-item pressable';
      el.style.animationDelay = Math.min(i * 40, 360) + 'ms';
      el.innerHTML = `
        <div class="li-head">
          <span class="state-pill ${it.state === 'open' ? 'state-open' : 'state-closed'}">${it.state}</span>
          <span class="li-title"></span>
        </div>
        <div class="li-meta">
          <span>#${it.number}</span><span></span>
          ${it.labels.map(l => { const color = safeHexColor(l.color); return `<span class="label-pill" style="border-color:#${color}88;color:#${color}">${esc(l.name)}</span>`; }).join('')}
          <span>${META_ICON.comments} ${it.comments}</span><span>${timeAgo(it.updated_at)}</span>
        </div>`;
      el.querySelector('.li-title').textContent = it.title;
      el.querySelector('.li-meta span:nth-child(2)').textContent = it.user || '';
      el.addEventListener('click', () => openIssue(it.number));
      host.appendChild(el);
    });
  } catch (e) { host.innerHTML = ''; toast(e.message, 'err'); }
}
async function openIssue(num) {
  const box = $('#issueDetail');
  box.hidden = false;
  box.innerHTML = '<div class="skeleton" style="height:120px"></div>';
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  try {
    const i = await api(`/api/repo/${wPath()}/issues/${num}`);
    box.innerHTML = `
      <div class="detail-head">
        <span class="state-pill ${i.state === 'open' ? 'state-open' : 'state-closed'}">${i.state}</span>
        <span class="detail-title"></span>
        <button class="btn btn-ghost small" id="issCloseDetail" aria-label="Close">${META_ICON.close}</button>
      </div>
      <div class="detail-meta"><span>#${i.number} by ${esc(i.user || '')}</span><span>${timeAgo(i.created_at)}</span></div>
      <div class="detail-body" id="issBody" hidden></div>
      <div id="issComments"></div>
      <label class="field-label" for="issNewComment">Add a comment</label>
      <textarea id="issNewComment" placeholder="Write a comment…"></textarea>
      <div class="detail-actions">
        <button class="btn btn-primary small" id="issCommentBtn">Comment ✦</button>
        <button class="btn btn-ghost small" id="issToggleBtn">${i.state === 'open' ? 'Close issue' : 'Reopen issue'}</button>
      </div>`;
    box.querySelector('.detail-title').textContent = i.title;
    if (i.body) { $('#issBody').hidden = false; $('#issBody').textContent = i.body; }
    const ch = $('#issComments');
    i.comments.forEach(c => {
      const el = document.createElement('div');
      el.className = 'comment';
      el.innerHTML = `<div class="comment-head">${c.avatar ? `<img src="${escAttr(c.avatar)}" alt="">` : ''}<span>${esc(c.user || '')}</span><span>${timeAgo(c.created_at)}</span></div>
        <div class="comment-body"></div>`;
      el.querySelector('.comment-body').textContent = c.body || '';
      ch.appendChild(el);
    });
    $('#issCloseDetail').addEventListener('click', () => { box.hidden = true; });
    $('#issCommentBtn').addEventListener('click', async () => {
      const body = $('#issNewComment').value.trim();
      if (!body) return;
      try {
        await api(`/api/repo/${wPath()}/issues/${num}/comments`, { method: 'POST', body: { body } });
        toast('Comment posted ✦', 'ok');
        openIssue(num);
      } catch (e) { toast(e.message, 'err'); }
    });
    $('#issToggleBtn').addEventListener('click', async () => {
      try {
        await api(`/api/repo/${wPath()}/issues/${num}`, { method: 'PATCH', body: { state: i.state === 'open' ? 'closed' : 'open' } });
        toast(i.state === 'open' ? 'Issue closed' : 'Issue reopened', 'ok');
        loadIssues();
      } catch (e) { toast(e.message, 'err'); }
    });
  } catch (e) { box.innerHTML = `<p class="hint">⚠ ${esc(e.message)}</p>`; }
}
$('#newIssueBtn').addEventListener('click', async () => {
  const ok = await modal({
    title: 'New issue',
    bodyHTML: `<label class="field-label" for="niTitle">Title</label><input id="niTitle" type="text" spellcheck="false">
      <label class="field-label" for="niBody">Description</label><textarea id="niBody" placeholder="Optional"></textarea>`,
    okText: 'Open issue ✦'
  });
  if (!ok) return;
  const title = $('#niTitle').value.trim();
  if (!title) return toast('Title required', 'err');
  try {
    const r = await api(`/api/repo/${wPath()}/issues`, { method: 'POST', body: { title, body: $('#niBody').value } });
    toast(`Issue #${r.number} opened ✦`, 'ok');
    loadIssues();
  } catch (e) { toast(e.message, 'err'); }
});

/* ================= RELEASES ================= */
async function loadReleases() {
  const host = $('#releaseList');
  host.innerHTML = '<div class="skeleton" style="height:80px"></div>'.repeat(2);
  try {
    const rels = await apiCached(`/api/repo/${wPath()}/releases`);
    host.innerHTML = '';
    if (!rels.length) {
      host.innerHTML = `<div class="card editor-empty"><div class="empty-icon">${EMPTY_ICON.releases}</div><p>No releases yet.<br>Tag your first launch with “New release”.</p></div>`;
      return;
    }
    rels.forEach((r, i) => {
      const el = document.createElement('div');
      el.className = 'card list-item';
      el.style.animationDelay = Math.min(i * 40, 360) + 'ms';
      el.innerHTML = `
        <div class="li-head">
          <span class="state-pill ${r.prerelease ? 'state-draft' : 'state-open'}">${r.draft ? 'draft' : r.prerelease ? 'pre' : 'release'}</span>
          <span class="li-title"></span>
          <span class="mono" style="color:var(--teal);font-size:.76rem">${esc(r.tag)}</span>
        </div>
        <div class="li-meta"><span>${timeAgo(r.created_at)}</span>
          ${r.assets.length ? `<span>${r.assets.length} asset${r.assets.length > 1 ? 's' : ''}</span>` : ''}</div>
        ${r.body ? '<div class="detail-body rel-body"></div>' : ''}`;
      el.querySelector('.li-title').textContent = r.name || r.tag;
      if (r.body) el.querySelector('.rel-body').textContent = r.body.slice(0, 400);
      host.appendChild(el);
    });
  } catch (e) { host.innerHTML = ''; toast(e.message, 'err'); }
}
$('#newReleaseBtn').addEventListener('click', async () => {
  const ok = await modal({
    title: 'New release',
    bodyHTML: `
      <label class="field-label" for="relTag">Tag</label><input id="relTag" type="text" placeholder="v1.0.0" spellcheck="false">
      <label class="field-label" for="relName">Title</label><input id="relName" type="text" placeholder="Defaults to tag" spellcheck="false">
      <label class="field-label" for="relBody">Notes</label><textarea id="relBody" placeholder="What changed?"></textarea>
      <label class="check"><input type="checkbox" id="relPre"> Pre-release</label>
      <p class="hint">Tag will be created from <b>${esc(state.work.branch)}</b> if it doesn't exist.</p>`,
    okText: 'Publish ✦'
  });
  if (!ok) return;
  const tag = $('#relTag').value.trim();
  if (!tag) return toast('Tag required', 'err');
  try {
    await api(`/api/repo/${wPath()}/releases`, {
      method: 'POST',
      body: { tag, name: $('#relName').value.trim(), body: $('#relBody').value, target: state.work.branch, prerelease: $('#relPre').checked }
    });
    toast(`Release ${tag} published ✦`, 'ok');
    loadReleases();
  } catch (e) { toast(e.message, 'err'); }
});

/* ================= COMPARE ================= */
$('#cmpGo').addEventListener('click', async () => {
  const base = $('#cmpBase').value, head = $('#cmpHead').value;
  const host = $('#cmpResult');
  host.innerHTML = '<div class="skeleton" style="height:90px;margin-top:14px"></div>';
  try {
    const c = await api(`/api/repo/${wPath()}/compare?base=${encodeURIComponent(base)}&head=${encodeURIComponent(head)}`);
    host.innerHTML = `
      <div class="cmp-stats">
        <span><b>${c.ahead_by}</b> ahead</span>
        <span><b>${c.behind_by}</b> behind</span>
        <span><b>${c.files.length}</b> files changed</span>
        <span class="mono" style="color:var(--teal)">${esc(head)} vs ${esc(base)}</span>
      </div>
      ${c.ahead_by > 0 ? `<button class="btn btn-primary small" id="cmpPrBtn" style="margin:4px 0 10px">Open PR from this diff ✦</button>` : ''}
      <div id="cmpFiles"></div>`;
    renderDiffFiles($('#cmpFiles'), c.files);
    if (!c.files.length) $('#cmpFiles').innerHTML = '<p class="hint">Branches are identical.</p>';
    const prBtn = $('#cmpPrBtn');
    if (prBtn) prBtn.addEventListener('click', () => {
      switchTab('pulls');
      setTimeout(() => $('#newPrBtn').click(), 100);
    });
  } catch (e) { host.innerHTML = `<p class="hint" style="margin-top:14px">⚠ ${esc(e.message)}</p>`; }
});

/* ================= OFFLINE QUEUE (PWA) ================= */
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('nebulaverse', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('queue', { keyPath: 'id', autoIncrement: true });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function qAdd(op) {
  const db = await idb();
  await new Promise((res, rej) => {
    const tx = db.transaction('queue', 'readwrite');
    tx.objectStore('queue').add({ ...op, ts: Date.now() });
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
  updateNetBar();
}
async function qAll() {
  const db = await idb();
  return new Promise((res, rej) => {
    const rq = db.transaction('queue').objectStore('queue').getAll();
    rq.onsuccess = () => res(rq.result || []); rq.onerror = () => rej(rq.error);
  });
}
async function qDel(id) {
  const db = await idb();
  await new Promise((res, rej) => {
    const tx = db.transaction('queue', 'readwrite');
    tx.objectStore('queue').delete(id);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
  updateNetBar();
}
function isOfflineError(e) {
  return !navigator.onLine || /failed to fetch|networkerror|load failed|offline/i.test((e && e.message) || '');
}
async function queueCommit(op, e) {
  if (ownerWorkbench) return false;
  if (!isOfflineError(e)) return false;
  await qAdd(op);
  toast('No connection — commit saved to the offline queue ✦', 'ok');
  return true;
}
let _flushing = false;
async function flushQueue(manual) {
  if (ownerWorkbench) return;
  if (!manual && state.safety && state.safety.freezeSync) return;
  if (_flushing || !navigator.onLine) return;
  const items = (await qAll().catch(() => [])).filter(x => !x.err);
  if (!items.length) return updateNetBar();
  _flushing = true;
  updateNetBar('sync');
  let done = 0;
  for (const it of items) {
    try {
      if (it.kind === 'put') {
        const out = await api(`/api/repo/${it.owner}/${it.repo}/file`, {
          method: 'PUT',
          body: { path: it.path, content: it.content, message: it.message, branch: it.branch, sha: it.sha, expectedHeadSha: it.expectedHeadSha || '' }
        });
        if (state.work && state.work.owner === it.owner && state.work.repo === it.repo) rememberHead(out.commit, it.branch);
      } else if (it.kind === 'batch') {
        const out = await api(`/api/repo/${it.owner}/${it.repo}/batch`, {
          method: 'POST', body: { branch: it.branch, message: it.message, ops: it.ops, expectedHeadSha: it.expectedHeadSha || '' }
        });
        if (state.work && state.work.owner === it.owner && state.work.repo === it.repo) rememberHead(out.commit, it.branch);
      }
      await qDel(it.id);
      done++;
    } catch (e) {
      if (isOfflineError(e)) break;
      if (/not signed in|401|403/i.test(e.message || '')) break;
      it.err = e.message || 'failed';
      const db = await idb();
      await new Promise(r => { const tx = db.transaction('queue', 'readwrite'); tx.objectStore('queue').put(it); tx.oncomplete = r; });
    }
  }
  _flushing = false;
  updateNetBar();
  if (done) {
    toast(`✦ Synced ${done} queued commit${done > 1 ? 's' : ''}`, 'ok');
    if (state.work.repo) { state.fileIndex = null; loadTree('', $('#tree'), true); }
  }
}
async function updateNetBar(mode) {
  const bar = $('#netBar');
  const items = await qAll().catch(() => []);
  const n = items.length;
  const offline = !navigator.onLine;
  bar.hidden = !offline && n === 0;
  bar.classList.toggle('sync', mode === 'sync');
  $('#netBarText').textContent = mode === 'sync' ? 'Back online — syncing queue…'
    : offline ? 'Offline — commits will be queued ✦'
    : `${n} queued commit${n > 1 ? 's' : ''} pending`;
  $('#queueOpenBtn').hidden = n === 0;
  $('#queueCount').textContent = n;
}
window.addEventListener('online', () => { updateNetBar(); flushQueue(); });
window.addEventListener('offline', () => updateNetBar());
$('#queueOpenBtn').addEventListener('click', async () => {
  const items = await qAll().catch(() => []);
  modal({ title: 'Offline commit queue', okText: 'Close', bodyHTML: items.length ? '' : '<p class="hint">Queue is empty.</p>' });
  items.forEach(it => {
    const el = document.createElement('div');
    el.className = 'br-row';
    el.innerHTML = `<span class="mono" style="flex:1"></span>
      ${it.err ? `<span class="br-tag" style="color:var(--red)">failed</span>` : '<span class="br-tag">pending</span>'}
      <button class="btn btn-ghost small danger">Discard</button>`;
    el.querySelector('.mono').textContent = it.kind === 'batch' ? `${it.ops.length} files → ${it.owner}/${it.repo}@${it.branch}` : `${it.path} → ${it.branch}`;
    if (it.err) el.title = it.err;
    el.querySelector('button').addEventListener('click', async () => { await qDel(it.id); el.remove(); });
    $('#modalBody').appendChild(el);
  });
  if (items.some(x => !x.err)) {
    const b = document.createElement('button');
    b.className = 'btn btn-primary small'; b.style.marginTop = '12px'; b.textContent = 'Sync now';
    b.addEventListener('click', () => { closeModal(false); flushQueue(true); });
    $('#modalBody').appendChild(b);
  }
});

/* ================= VISUAL TIME MACHINE ================= */
const tmv = { commits: [], idx: 0, snaps: new Map(), headSha: null, playing: false, fetching: 0 };
$('#tmOpenBtn').addEventListener('click', () => openTimeMachine());
$('#tmClose').addEventListener('click', closeTimeMachine);
async function openTimeMachine() {
  if (state.caps && !state.caps.tm) return toast('The Time Machine currently supports GitHub repos', 'err');
  if (!state.work.repo) return;
  $('#tmOverlay').hidden = false;
  $('#tmSub').textContent = `${wPath()} @ ${state.work.branch} — last commits, oldest → newest`;
  $('#tmMsg').textContent = 'Charting the timeline…';
  $('#tmMeta').textContent = ''; $('#tmStats').innerHTML = ''; $('#tmFiles').innerHTML = '';
  try {
    const list = await api(`/api/repo/${wPath()}/commits?ref=${encodeURIComponent(state.work.branch)}`);
    if (!list.length) { toast('No commits on this branch yet', 'err'); return closeTimeMachine(); }
    tmv.commits = list.slice().reverse();          /* oldest → newest */
    tmv.headSha = list[0].sha;
    tmv.snaps.clear();
    const r = $('#tmRange');
    r.max = String(tmv.commits.length - 1);
    r.value = r.max;                                /* start at "now" */
    tmSelect(tmv.commits.length - 1);
  } catch (e) { toast(e.message, 'err'); closeTimeMachine(); }
}
function closeTimeMachine() { tmv.playing = false; $('#tmOverlay').hidden = true; }
async function tmSnapshot(sha) {
  if (tmv.snaps.has(sha)) return tmv.snaps.get(sha);
  const p = api(`/api/repo/${wPath()}/snapshot?sha=${sha}`).then(s => {
    const map = new Map(s.files.map(f => [f.path, f.sha]));
    return { map, count: s.count, truncated: s.truncated };
  });
  tmv.snaps.set(sha, p);
  return p;
}
let _tmToken = 0;
async function tmSelect(i) {
  tmv.idx = Math.max(0, Math.min(i, tmv.commits.length - 1));
  const c = tmv.commits[tmv.idx];
  const r = $('#tmRange');
  r.value = String(tmv.idx);
  r.style.setProperty('--tmfill', (tmv.idx / Math.max(1, tmv.commits.length - 1) * 100) + '%');
  $('#tmMsg').textContent = (c.message || '').split('\n')[0];
  const isHead = c.sha === tmv.headSha;
  $('#tmMeta').textContent = `${c.sha.slice(0, 7)} · ${(c.author && c.author.name) || '?'} · ${timeAgo(c.author && c.author.date)} · ${tmv.idx + 1}/${tmv.commits.length}${isHead ? ' · NOW' : ''}`;
  $('#tmRevertBtn').disabled = false;
  $('#tmRestoreBtn').disabled = isHead;
  const my = ++_tmToken;
  $('#tmStats').innerHTML = '<span class="tm-stat same">comparing with now…</span>';
  $('#tmFiles').innerHTML = '';
  try {
    const [head, snap] = await Promise.all([tmSnapshot(tmv.headSha), tmSnapshot(c.sha)]);
    if (my !== _tmToken) return;                    /* stale scrub */
    if (isHead) {
      $('#tmStats').innerHTML = `<span class="tm-stat same">You are at the present — ${snap.count} files</span>`;
      return;
    }
    const added = [], removed = [], modified = [];
    head.map.forEach((sha, p2) => { if (!snap.map.has(p2)) added.push(p2); else if (snap.map.get(p2) !== sha) modified.push(p2); });
    snap.map.forEach((sha, p2) => { if (!head.map.has(p2)) removed.push(p2); });
    $('#tmStats').innerHTML =
      `<span class="tm-stat add">+${added.length} since here</span>` +
      `<span class="tm-stat del">−${removed.length} deleted after</span>` +
      `<span class="tm-stat mod">~${modified.length} changed after</span>` +
      ((head.truncated || snap.truncated) ? '<span class="tm-stat same">large repo — partial</span>' : '');
    const rows = [
      ...removed.map(p2 => ({ p: p2, k: 'v-skip', label: 'existed here', restorable: true })),
      ...modified.map(p2 => ({ p: p2, k: 'v-update', label: 'was different', restorable: true })),
      ...added.map(p2 => ({ p: p2, k: 'v-new', label: 'not yet born', restorable: false }))
    ].slice(0, 60);
    const host = $('#tmFiles');
    rows.forEach(row => {
      const el = document.createElement('div');
      el.className = 'tm-file';
      el.innerHTML = `<span class="mono"></span><span class="uq-verdict ${row.k}">${row.label}</span>` +
        (row.restorable ? '<button class="btn btn-ghost small">Restore</button>' : '');
      el.querySelector('.mono').textContent = row.p;
      if (row.restorable) el.querySelector('button').addEventListener('click', async () => {
        try {
          const out = await api(`/api/repo/${wPath()}/restore-paths`, {
            method: 'POST', body: guardedWrite({ sha: c.sha, branch: state.work.branch, prefix: row.p })
          });
          rememberHead(out.commit);
          toast(`Restored ${row.p} from ${c.sha.slice(0, 7)} ✦`, 'ok');
          tmv.snaps.delete(tmv.headSha);
          state.fileIndex = null; loadTree('', $('#tree'), true);
        } catch (e2) { toast(e2.message, 'err'); }
      });
      host.appendChild(el);
    });
  } catch (e) {
    if (my === _tmToken) $('#tmStats').innerHTML = `<span class="tm-stat same">⚠ ${esc(e.message)}</span>`;
  }
}
let _tmDeb = null;
$('#tmRange').addEventListener('input', e => {
  tmv.playing = false;
  const i = +e.target.value;
  const c = tmv.commits[i];
  if (c) { $('#tmMsg').textContent = (c.message || '').split('\n')[0]; }
  e.target.style.setProperty('--tmfill', (i / Math.max(1, tmv.commits.length - 1) * 100) + '%');
  clearTimeout(_tmDeb);
  _tmDeb = setTimeout(() => tmSelect(i), 220);
});
$('#tmPrev').addEventListener('click', () => { tmv.playing = false; tmSelect(tmv.idx - 1); });
$('#tmNext').addEventListener('click', () => { tmv.playing = false; tmSelect(tmv.idx + 1); });
$('#tmPlay').addEventListener('click', async () => {
  if (tmv.playing) { tmv.playing = false; $('#tmPlay').textContent = 'Play history'; return; }
  tmv.playing = true;
  $('#tmPlay').textContent = 'Stop';
  for (let i = 0; i < tmv.commits.length; i++) {
    if (!tmv.playing || $('#tmOverlay').hidden) break;
    await tmSelect(i);
    await new Promise(r2 => setTimeout(r2, 650));
  }
  tmv.playing = false;
  $('#tmPlay').textContent = 'Play history';
});
$('#tmRevertBtn').addEventListener('click', () => {
  const c = tmv.commits[tmv.idx];
  closeTimeMachine();
  timeMachine('revert', c.sha, c.message);
});
$('#tmRestoreBtn').addEventListener('click', () => {
  const c = tmv.commits[tmv.idx];
  closeTimeMachine();
  timeMachine('restore', c.sha, c.message);
});

/* ================= FIND & REPLACE ================= */
const find = { q: '', cs: false, re: false, matches: [], idx: -1, marks: [] };
function openFindPanel(prefill) {
  try {
    const bar = document.querySelector('.editor-bar');
    const topOff = (parseFloat(getComputedStyle(bar).top) || 74) + bar.offsetHeight;
    $('#findBar').style.setProperty('--findtop', topOff + 'px');
  } catch {}
  switchTab('editor');
  $('#findBar').hidden = false;
  const inp = $('#findInput');
  if (prefill != null) inp.value = prefill;
  else if (state.cm && state.cm.somethingSelected()) inp.value = state.cm.getSelection().slice(0, 120);
  inp.focus(); inp.select();
  runFind();
}
function closeFindPanel() {
  $('#findBar').hidden = true;
  clearFindMarks();
  find.matches = []; find.idx = -1;
}
function clearFindMarks() { find.marks.forEach(m => m.clear()); find.marks = []; }
function findPattern() {
  find.q = $('#findInput').value;
  if (!find.q) return null;
  if (find.re) { try { return new RegExp(find.q, find.cs ? 'g' : 'gi'); } catch { return null; } }
  return find.q;
}
function runFind(keepNear) {
  if (!state.cm) return;
  clearFindMarks();
  const prevPos = keepNear && find.matches[find.idx] ? find.matches[find.idx].from : null;
  find.matches = []; find.idx = -1;
  const pat = findPattern();
  if (pat) {
    const cur = state.cm.getSearchCursor(pat, CodeMirror.Pos(0, 0), { caseFold: !find.cs });
    while (cur.findNext()) {
      find.matches.push({ from: cur.from(), to: cur.to() });
      if (find.matches.length > 9999) break;
    }
    find.matches.forEach(m => find.marks.push(state.cm.markText(m.from, m.to, { className: 'cm-find-match' })));
    if (find.matches.length) {
      find.idx = 0;
      if (prevPos) {
        const i = find.matches.findIndex(m => m.from.line > prevPos.line || (m.from.line === prevPos.line && m.from.ch >= prevPos.ch));
        if (i >= 0) find.idx = i;
      }
      focusMatch();
    }
  }
  updateFindCount();
}
function focusMatch() {
  const m = find.matches[find.idx];
  if (!m) return;
  state.cm.setSelection(m.from, m.to);
  state.cm.scrollIntoView({ from: m.from, to: m.to }, 90);
  updateFindCount();
}
function updateFindCount() {
  $('#findCount').textContent = find.matches.length ? `${find.idx + 1}/${find.matches.length}` : '0/0';
}
function stepFind(dir) {
  if (!find.matches.length) return;
  find.idx = (find.idx + dir + find.matches.length) % find.matches.length;
  focusMatch();
}
let _findDeb = null;
$('#findInput').addEventListener('input', () => { clearTimeout(_findDeb); _findDeb = setTimeout(() => runFind(), 180); });
$('#findInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1); }
  if (e.key === 'Escape') closeFindPanel();
});
$('#replaceInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); doReplaceOne(); }
  if (e.key === 'Escape') closeFindPanel();
});
$('#findNext').addEventListener('click', () => stepFind(1));
$('#findPrev').addEventListener('click', () => stepFind(-1));
$('#findClose').addEventListener('click', closeFindPanel);
$('#findCase').addEventListener('click', function () { find.cs = !find.cs; this.classList.toggle('on', find.cs); runFind(); });
$('#findRegex').addEventListener('click', function () { find.re = !find.re; this.classList.toggle('on', find.re); runFind(); });
function replacementFor(matchText) {
  const r = $('#replaceInput').value;
  if (!find.re) return r;
  try { return matchText.replace(new RegExp(find.q, find.cs ? '' : 'i'), r); } catch { return r; }
}
function doReplaceOne() {
  const m = find.matches[find.idx];
  if (!m) return;
  const txt = state.cm.getRange(m.from, m.to);
  state.cm.replaceRange(replacementFor(txt), m.from, m.to);
  runFind(true);
}
$('#replaceOne').addEventListener('click', doReplaceOne);
$('#replaceAll').addEventListener('click', () => {
  if (!find.matches.length) return;
  const n = find.matches.length;
  state.cm.operation(() => {
    for (let i = find.matches.length - 1; i >= 0; i--) {
      const m = find.matches[i];
      const txt = state.cm.getRange(m.from, m.to);
      state.cm.replaceRange(replacementFor(txt), m.from, m.to);
    }
  });
  runFind();
  toast(`Replaced ${n} occurrence${n > 1 ? 's' : ''} — remember to commit or stage`, 'ok');
});

/* ================= TIME MACHINE ================= */
async function timeMachine(kind, sha, msg) {
  const short = sha.slice(0, 7);
  const first = (msg || '').split('\n')[0];
  const br = state.work.branch;
  try {
    if (kind === 'revert') {
      const ok = await modal({
        title: 'Revert commit',
        bodyHTML: `<p style="font-size:.9rem;line-height:1.6">Creates a <b>new commit</b> on <b>${esc(br)}</b> that undoes <b class="mono">${short}</b> — “${esc(first)}”.<br><br>Files it touched go back to how they were just before it. History stays intact. If later commits changed the same files, those changes are rolled back too.</p>`,
        okText: 'Revert ✦'
      });
      if (!ok) return;
      const out = await api(`/api/repo/${wPath()}/revert`, { method: 'POST', body: guardedWrite({ sha, branch: br }, br) });
      rememberHead(out.commit, br);
      toast(`Reverted — ${out.changed} path${out.changed > 1 ? 's' : ''} restored in ${String(out.commit).slice(0, 7)}`, 'ok');
    }
    else if (kind === 'restore') {
      const ok = await modal({
        title: 'Restore repository to this point',
        bodyHTML: `<p style="font-size:.9rem;line-height:1.6">Makes the <b>entire repo</b> on <b>${esc(br)}</b> exactly as it was at <b class="mono">${short}</b> — “${esc(first)}” — via a <b>new commit</b>.<br><br>Everything committed after that point is undone in content, but <b>history is fully preserved</b>: you can always come back forward.</p>`,
        okText: 'Restore ✦'
      });
      if (!ok) return;
      const out = await api(`/api/repo/${wPath()}/restore`, { method: 'POST', body: guardedWrite({ sha, branch: br }, br) });
      rememberHead(out.commit, br);
      toast(`Repository restored to ${short} in ${String(out.commit).slice(0, 7)} ✦`, 'ok');
    }
    else if (kind === 'paths') {
      const ok = await modal({
        title: 'Restore from this commit',
        bodyHTML: `<p style="font-size:.9rem;line-height:1.6">Bring back a file or a whole folder <b>as it was at</b> <b class="mono">${short}</b>, without touching anything else. Perfect for un-deleting.</p>
          <label class="field-label" for="tmPath">Path to restore <span class="muted">(e.g. <span class="mono">public</span> or <span class="mono">src/app.js</span>)</span></label>
          <input id="tmPath" type="text" spellcheck="false" autocomplete="off">`,
        okText: 'Restore path ✦'
      });
      if (!ok) return;
      const prefix = ($('#tmPath') ? $('#tmPath').value : '').trim().replace(/^\/+|\/+$/g, '');
      if (!prefix) return;
      const out = await api(`/api/repo/${wPath()}/restore-paths`, { method: 'POST', body: guardedWrite({ sha, branch: br, prefix }, br) });
      rememberHead(out.commit, br);
      toast(`Restored ${out.restored} file${out.restored > 1 ? 's' : ''} from ${short} ✦`, 'ok');
    }
    else if (kind === 'reset') {
      const ok = await modal({
        title: 'Hard reset — destructive',
        bodyHTML: `<p style="font-size:.9rem;line-height:1.6">Moves <b>${esc(br)}</b> back to <b class="mono">${short}</b> and <b style="color:var(--red)">erases every later commit from this branch</b> — they vanish from its history. Use Revert or Restore instead unless you truly need history rewritten.</p>
          <label class="field-label" for="tmReset">Type the branch name <b class="mono">${esc(br)}</b> to confirm</label>
          <input id="tmReset" type="text" spellcheck="false" autocomplete="off">`,
        okText: 'Hard reset', danger: true
      });
      if (!ok) return;
      if (($('#tmReset') ? $('#tmReset').value : '').trim() !== br) return toast('Branch name mismatch — aborted', 'err');
      const resetBody = guardedWrite({ sha, branch: br }, br);
      const reset = await stepUpApi('branch.reset', {
        owner: state.work.owner, repo: state.work.repo, branch: br,
        targetSha: sha, expectedHeadSha: resetBody.expectedHeadSha || ''
      }, `/api/repo/${wPath()}/reset`, { method: 'POST', body: resetBody }, `Hard reset ${br} to ${short}`);
      if (!reset) return;
      rememberHead(sha, br);
      toast(`Branch ${br} hard-reset to ${short}`, 'ok');
    }
    state.fileIndex = null;
    loadTree('', $('#tree'), true);
    loadCommits(true);
    refreshRate();
  } catch (e) { toast(e.message, 'err'); }
}

/* ---------------- utils ---------------- */
function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
function b64ToUtf8(b64) {
  const bin = atob((b64 || '').replace(/\n/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}
function fmtSize(b) {
  if (b == null) return '';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
  return (b / 1073741824).toFixed(2) + ' GB';
}
function timeAgo(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 2592000) return Math.floor(s / 86400) + 'd ago';
  return new Date(iso).toLocaleDateString();
}
/* ---- batch commit: blobs first, then ONE atomic commit ---- */
function batchPlan(count = batchQueue.length) {
  return window.NebulaUploadPlanning.planBatchCommits(count);
}
function updateBatchBar() {
  const bar = $('#batchBar');
  bar.hidden = uploadModeV !== 'batch' || !batchQueue.length;
  if (bar.hidden) return;
  const plan = batchPlan();
  const files = `${plan.total} file${plan.total > 1 ? 's' : ''}`;
  /* One commit is what the control promises; more than one is what the queue
   * has outgrown, and saying so here is cheaper than saying it after the
   * upload. */
  $('#batchInfo').textContent = plan.atomic
    ? `${files} ready — will land as one commit on ${state.work.branch}`
    : `${files} ready — more than ${plan.limit} per commit, so this will land as ${plan.commits} commits on ${state.work.branch}`;
  const button = $('#batchCommitBtn');
  if (button) button.textContent = plan.atomic ? 'Commit all as one ✦' : `Commit in ${plan.commits} parts ✦`;
}
function uploadBlob(q) {
  if (ownerWorkbench) return Promise.reject(new Error('Uploads are not connected to the owner workbench yet.'));
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/repo/${wPath()}/blob?path=${encodeURIComponent(q.targetPath)}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('x-nv', '1');
    xhr.setRequestHeader('x-nv-csrf', csrfToken);
    xhr.upload.onprogress = ev => { if (ev.lengthComputable) q.fill.style.width = Math.min(Math.round(ev.loaded / ev.total * 100), 90) + '%'; };
    xhr.onload = () => {
      try { const r = JSON.parse(xhr.responseText); r.ok ? resolve(r.sha) : reject(new Error(r.error || 'blob failed')); }
      catch { reject(new Error('blob failed')); }
    };
    xhr.onerror = () => reject(new Error('network error'));
    xhr.send(q.file);
  });
}
$('#batchCommitBtn').addEventListener('click', async () => {
  if (!batchQueue.length) return;
  const plan = batchPlan();
  /*
   * Plan before a single blob leaves the browser. A queue past the server's
   * batch limit used to upload every blob and only then be refused by the
   * commit, so the whole wait was spent earning an error.
   */
  if (!plan.atomic) {
    const proceed = await modal({
      title: 'More than one commit',
      okText: `Commit in ${plan.commits} parts`,
      bodyHTML: `<p class="sp-lead">A single commit carries at most <b>${plan.limit}</b> files, and this queue holds <b>${plan.total}</b>.</p>
        <p class="sp-lead">It can go as <b>${plan.commits} commits</b> on <b class="mono">${esc(state.work.branch)}</b> instead — each one atomic, in queue order. Nothing is uploaded until you choose.</p>
        <p class="hint">To keep it to one commit, cancel and push fewer files at a time.</p>`
    });
    if (!proceed) return;
  }
  const btn = $('#batchCommitBtn');
  btn.disabled = true;
  const committed = [];
  try {
    await ensureCsrfToken();
    for (const [index, group] of plan.groups.entries()) {
      const part = batchQueue.slice(group.start, group.end);
      const partLabel = plan.atomic ? '' : ` (part ${index + 1} of ${plan.commits})`;
      const message = ($('#uploadMsg').value.trim() || `Sync ${plan.total} files via ${NV_PRODUCT_NAME}`) + partLabel;
      const ops = [];
      for (const q of part) {
        q.status.textContent = `Uploading blob…${partLabel}`;
        ops.push({ op: 'put', path: q.targetPath, sha: await uploadBlob(q) });
        q.status.textContent = 'Blob stored — waiting for the commit…';
      }
      const out = await api(`/api/repo/${wPath()}/batch`, {
        method: 'POST', body: guardedWrite({ branch: state.work.branch, message, ops })
      });
      rememberHead(out.commit);
      committed.push(out.commit);
      part.forEach(q => {
        q.item.classList.add('done'); q.fill.style.width = '100%';
        q.status.textContent = `✦ Committed in ${String(out.commit).slice(0, 7)}${partLabel || ' (one atomic commit)'}`;
      });
    }
    toast(plan.atomic
      ? `✦ ${plan.total} files landed as one commit`
      : `✦ ${plan.total} files landed as ${committed.length} commits`, 'ok');
    batchQueue.length = 0;
    updateBatchBar();
    state.fileIndex = null;
    loadTree('', $('#tree'), true);
    refreshRate();
  } catch (e) {
    /* Report what did land. A part that committed is on the branch whatever
     * happens next, and leaving that unsaid would send someone looking for
     * files that are already there. */
    toast(committed.length
      ? `Batch stopped after ${committed.length} of ${plan.commits} commits: ${e.message}`
      : 'Batch failed: ' + e.message, 'err');
    if (committed.length) {
      batchQueue.splice(0, plan.groups[committed.length - 1].end);
      updateBatchBar();
      state.fileIndex = null;
      loadTree('', $('#tree'), true);
    }
  } finally { btn.disabled = false; }
});

window.addEventListener('beforeunload', e => {
  if ((state.file && state.file.dirty) || state.staged.length) { e.preventDefault(); e.returnValue = ''; }
});
window.addEventListener('resize', () => { if (!isMobile()) { $('#side').classList.remove('open'); $('#sideScrim').hidden = true; } });

/* ================= v3 MODULES ================= */

/* ---- unsaved drafts (localStorage, per repo@branch:path) ---- */
let _draftTimer = null;
const draftKey = p => `nv_draft:${wPath()}@${state.work.branch}:${p}`;
function saveDraft() {
  clearTimeout(_draftTimer);
  if (ownerWorkbench) return;
  _draftTimer = setTimeout(() => {
    if (!state.file || state.file.binary) return;
    try {
      const content = state.cm.getValue();
      if (content === state.file.original) { clearDraft(state.file.path); return; }
      localStorage.setItem(draftKey(state.file.path), JSON.stringify({ content, t: Date.now() }));
    } catch {}
  }, 600);
}
function clearDraft(p) { try { localStorage.removeItem(draftKey(p)); } catch {} }
function removeDraftBar() { const b = $('#draftBar'); if (b) b.remove(); }
function offerDraft(p, loadedText) {
  if (ownerWorkbench) return;
  let d = null;
  try { d = JSON.parse(localStorage.getItem(draftKey(p)) || 'null'); } catch {}
  if (!d || d.content === loadedText) { if (d) clearDraft(p); return; }
  removeDraftBar();
  const bar = document.createElement('div');
  bar.className = 'draft-bar'; bar.id = 'draftBar';
  bar.innerHTML = `<span>Unsaved draft from ${timeAgo(new Date(d.t).toISOString())}</span>
    <button class="btn btn-ghost" id="draftRestore">Restore</button>
    <button class="btn btn-ghost" id="draftDiscard">Discard</button>`;
  $('.editor-bar').after(bar);
  $('#draftRestore').addEventListener('click', () => {
    state.cm.setValue(d.content);
    state.file.dirty = true;
    $('#commitFileBtn').disabled = false; $('#stageFileBtn').disabled = false; $('#diffBtn').disabled = false;
    removeDraftBar();
    toast('Draft restored', 'ok');
  });
  $('#draftDiscard').addEventListener('click', () => { clearDraft(p); removeDraftBar(); });
}

/* ---- recent files ---- */
function getRecents() {
  if (ownerWorkbench) return [];
  try { return JSON.parse(localStorage.getItem(`nv_recent:${wPath()}`) || '[]'); } catch { return []; }
}
function rememberRecent(p) {
  if (ownerWorkbench) return;
  try {
    const list = getRecents().filter(x => x !== p);
    list.unshift(p);
    localStorage.setItem(`nv_recent:${wPath()}`, JSON.stringify(list.slice(0, 8)));
  } catch {}
}

/* ---- live diff of unsaved edits ---- */
$('#diffBtn').addEventListener('click', () => {
  const panel = $('#editDiff');
  const showing = !panel.hidden;
  panel.hidden = showing;
  $('#editorHost').style.display = showing ? '' : 'none';
  if (showing) { setTimeout(() => state.cm.refresh(), 30); return; }
  const body = $('#editDiffBody');
  body.innerHTML = '';
  const lines = lineDiff((state.file.original || '').split('\n'), state.cm.getValue().split('\n'));
  if (!lines.some(l => l[0] !== ' ')) { body.innerHTML = '<span style="color:var(--muted)">No changes vs the loaded version.</span>'; return; }
  lines.forEach(([tag, text]) => {
    if (tag === ' ') return; // only show changed lines with light context handling below
  });
  /* render with 2 lines of context around changes */
  const keep = new Set();
  lines.forEach((l, i) => { if (l[0] !== ' ') for (let k = i - 2; k <= i + 2; k++) keep.add(k); });
  let lastShown = -2;
  lines.forEach((l, i) => {
    if (!keep.has(i)) return;
    if (i > lastShown + 1) {
      const gap = document.createElement('span');
      gap.className = 'hunk'; gap.textContent = '···';
      body.appendChild(gap);
    }
    lastShown = i;
    const span = document.createElement('span');
    span.textContent = (l[0] === '+' ? '+ ' : l[0] === '-' ? '− ' : '  ') + l[1];
    if (l[0] === '+') span.className = 'add';
    else if (l[0] === '-') span.className = 'del';
    body.appendChild(span);
  });
});
function lineDiff(a, b) {
  /* Myers-lite LCS diff with size guard */
  if (a.length * b.length > 4_000_000) {
    return [...a.map(x => ['-', x]), ...b.map(x => ['+', x])];
  }
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let k = m - 1; k >= 0; k--)
      dp[i][k] = a[i] === b[k] ? dp[i + 1][k + 1] + 1 : Math.max(dp[i + 1][k], dp[i][k + 1]);
  const out = [];
  let i = 0, k = 0;
  while (i < n && k < m) {
    if (a[i] === b[k]) { out.push([' ', a[i]]); i++; k++; }
    else if (dp[i + 1][k] >= dp[i][k + 1]) { out.push(['-', a[i]]); i++; }
    else { out.push(['+', b[k]]); k++; }
  }
  while (i < n) out.push(['-', a[i++]]);
  while (k < m) out.push(['+', b[k++]]);
  return out;
}

/* ---- Actions (CI) ---- */
async function loadActions() {
  const host = $('#actionsList');
  host.innerHTML = '<div class="skeleton" style="height:64px"></div>'.repeat(3);
  try {
    const runs = await apiCached(`/api/repo/${wPath()}/actions`, 30000);
    host.innerHTML = '';
    if (!runs.length) {
      host.innerHTML = `<div class="card editor-empty"><div class="empty-icon">${EMPTY_ICON.actions}</div><p>No workflow runs yet.<br>Add a workflow under <span class="mono">.github/workflows/</span> to light up CI.</p></div>`;
      return;
    }
    runs.forEach((r, i) => {
      const el = document.createElement('div');
      el.className = 'card list-item pressable';
      el.style.animationDelay = Math.min(i * 40, 360) + 'ms';
      const cls = r.status !== 'completed' ? 'running' : r.conclusion === 'success' ? 'success' : r.conclusion === 'failure' ? 'failure' : 'neutral';
      const label = r.status !== 'completed' ? r.status.replace('_', ' ') : (r.conclusion || 'done');
      el.innerHTML = `
        <div class="li-head">
          <span class="run-status"><span class="run-dot ${cls}"></span></span>
          <span class="li-title"></span>
          <span class="badge">${label}</span>
        </div>
        <div class="li-meta"><span>#${r.number}</span><span class="mono">${esc(r.branch || '')}</span>
          <span>${esc(r.event)}</span><span class="mono commit-sha">${(r.sha || '').slice(0, 7)}</span><span>${timeAgo(r.created_at)}</span></div>`;
      el.querySelector('.li-title').textContent = r.name || 'workflow';
      const jobsBox = document.createElement('div');
      jobsBox.style.display = 'none';
      el.appendChild(jobsBox);
      el.addEventListener('click', async () => {
        const open = jobsBox.style.display !== 'none';
        jobsBox.style.display = open ? 'none' : 'block';
        if (open || jobsBox.dataset.loaded) return;
        jobsBox.innerHTML = '<div class="skeleton" style="height:44px;margin-top:10px"></div>';
        try {
          const jobs = await api(`/api/repo/${wPath()}/actions/${r.id}/jobs`);
          jobsBox.dataset.loaded = '1';
          jobsBox.innerHTML = '';
          jobs.forEach(jb => {
            const jc = jb.status !== 'completed' ? 'running' : jb.conclusion === 'success' ? 'success' : jb.conclusion === 'failure' ? 'failure' : 'neutral';
            const jd = document.createElement('div');
            jd.style.marginTop = '10px';
            jd.innerHTML = `<div class="li-head" style="font-size:.82rem"><span class="run-dot ${jc}"></span><b></b></div>`;
            jd.querySelector('b').textContent = jb.name;
            jb.steps.forEach(st => {
              const sc = st.status !== 'completed' ? 'running' : st.conclusion === 'success' ? 'success' : st.conclusion === 'failure' ? 'failure' : 'neutral';
              const sr = document.createElement('div');
              sr.className = 'step-row';
              sr.innerHTML = `<span class="run-dot ${sc}" style="width:7px;height:7px"></span><span></span>`;
              sr.querySelector('span:last-child').textContent = st.name;
              jd.appendChild(sr);
            });
            jobsBox.appendChild(jd);
          });
          const acts = document.createElement('div');
          acts.className = 'detail-actions';
          acts.innerHTML = `<button class="btn btn-ghost small" data-rerun data-feature="workflows.rerun" data-allow-experimental="true">Re-run</button>
            <button class="btn btn-ghost small" data-open>Open on GitHub</button>`;
          if (window.NebulaCapabilityUI) NebulaCapabilityUI.apply(acts);
          acts.querySelector('[data-rerun]').addEventListener('click', async e2 => {
            e2.stopPropagation();
            try { await api(`/api/repo/${wPath()}/actions/${r.id}/rerun`, { method: 'POST' }); toast('Re-run requested ✦', 'ok'); }
            catch (e3) { toast(e3.message, 'err'); }
          });
          acts.querySelector('[data-open]').addEventListener('click', e2 => { e2.stopPropagation(); window.open(r.html_url, '_blank', 'noopener'); });
          jobsBox.appendChild(acts);
        } catch (e4) { jobsBox.innerHTML = `<p class="hint">⚠ ${esc(e4.message)}</p>`; }
      });
      host.appendChild(el);
    });
  } catch (e) { host.innerHTML = ''; toast(e.message, 'err'); }
}
$('#actionsRefreshBtn').addEventListener('click', () => { _cache.clear(); loadActions(); });

/* ---- branch manager ---- */
async function openBranchManager() {
  modal({ title: 'Branches', okText: 'Done', bodyHTML: '<div class="skeleton" style="height:80px"></div>' });
  try {
    const info = await api(`/api/repo/${wPath()}`);
    state.work.branches = info.branches;
    if ($('#scrim').hidden) return;
    const host = $('#modalBody');
    host.innerHTML = '';
    info.branches.forEach(b => {
      const row = document.createElement('div');
      row.className = 'br-row';
      const isDefault = b.name === info.default_branch;
      const isCurrent = b.name === state.work.branch;
      row.innerHTML = `<span class="mono"></span>
        ${isDefault ? '<span class="br-tag">default</span>' : ''}
        ${isCurrent ? '<span class="br-tag">current</span>' : ''}
        ${b.protected ? '<span class="br-tag">protected</span>' : ''}
        ${!isDefault && !isCurrent && !b.protected ? '<button class="btn btn-ghost small danger">Delete</button>' : ''}`;
      row.querySelector('.mono').textContent = b.name;
      const del = row.querySelector('button');
      if (del) del.addEventListener('click', async () => {
        del.disabled = true;
        try {
          await api(`/api/repo/${wPath()}/branches/${encodeURIComponent(b.name)}`, { method: 'DELETE' });
          row.remove();
          ['#branchSelect', '#cmpBase', '#cmpHead'].forEach(s => {
            const o = [...$(s).options].find(o => o.value === b.name);
            if (o) o.remove();
          });
          toast(`Branch ${b.name} deleted`, 'ok');
        } catch (e) { del.disabled = false; toast(e.message, 'err'); }
      });
      host.appendChild(row);
    });
  } catch (e) { if (!$('#scrim').hidden) $('#modalBody').innerHTML = `<p class="hint">⚠ ${esc(e.message)}</p>`; }
}

/* ---- upload retry ---- */
function addRetry(item, file, rel, settings) {
  const b = document.createElement('button');
  b.className = 'btn btn-ghost small';
  b.textContent = 'Retry';
  b.style.marginTop = '8px';
  b.addEventListener('click', async () => {
    b.disabled = true;
    item.remove();
    _dirIndex.clear();
    await uploadOne(file, rel, settings);
    updateBatchBar();
  });
  item.appendChild(b);
}


let alphaBootStarted = false;
function startAuthorizedApp() {
  if (alphaBootStarted) return;
  alphaBootStarted = true;
  boot();
}
window.addEventListener('nebula:alpha-access-granted', startAuthorizedApp);
/*
 * The chrome belongs to the screens, and the gate replaces them. Assigning
 * _page does not repaint it: showPage returns early when handed the screen
 * that is already current, which the gate paths have just made true. So an
 * expired session left the workbench's floating action over the gate's own
 * Continue, offering an action against a workspace that was already gone.
 */
window.addEventListener('nebula:alpha-access-gated', () => {
  paintRail('alpha-access');
  paintFloatingAction('alpha-access');
  closeNavMenu();
  /*
   * The gate is where an owner on an invite deployment actually lands, so the
   * card has to be offered here too -- otherwise the only route to owner setup
   * is a screen the gate never lets them see.
   */
  initWorkspaceCard();
});
window.NebulaAlphaUI.boot().then(result => {
  if (result.allowed) startAuthorizedApp();
}).catch(() => {
  window.NebulaAlphaUI.showWaking('Temporarily unavailable');
});
