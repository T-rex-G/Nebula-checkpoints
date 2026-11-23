/* ============================================================
   NEBULAVERSE-X — app.js
   ============================================================ */
'use strict';
import * as codeowners from '../../../../packages/contracts/src/codeowners.ts';
import * as uploadPlanning from '../../../../packages/contracts/src/upload-planning.ts';
import * as findingsInbox from '../features/findings/findings-model.ts';
import { renderFindingsInbox } from '../features/findings/FindingsInbox.tsx';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import CodeMirror from '../components/code-editor.ts';
import OverlayMotion from '../components/overlay-motion.ts';
import { anchorOverlayOrigin } from '../components/overlay-origin.ts';
import { createModal } from '../components/modal.ts';
import { createToasts } from '../components/toasts.ts';
import { createStepUp } from '../features/security/step-up.ts';
import { createSafePassage } from '../features/governance/safe-passage.ts';
import { createGithubApp } from '../features/settings/github-app-controller.ts';
import { createSettingsPanel } from '../features/settings/settings-panel.ts';
import { createAppearance } from '../features/shell/appearance-controller.ts';
import { watchSpotlights } from '../components/spotlight.ts';
import { isRepositoryTool } from '../features/shell/rail.ts';
import { createRail } from '../features/shell/rail-controller.ts';
import { createFloatingActions } from '../features/shell/floating-actions-controller.ts';
import { createPages, watchLean } from '../features/shell/pages-controller.ts';
import { createRouteSync } from '../features/shell/route-sync.ts';
import { createLoginChrome, limitsText, loginGuidanceHtml, runtimeLimitsKnown as limitsKnown } from '../features/access/login-screen.ts';
import { createAlphaPrivacy } from '../features/access/alpha-privacy.ts';
import { createAccountBoundary, IDENTITY_BOUNDARY_CHANNEL } from '../features/access/account-boundary.ts';
import { createSession, githubIdentity, requireGithubIdentity } from '../features/access/session.ts';
import { createAccountsDialog } from '../features/access/accounts-dialog.ts';
import AlphaUI from '../features/access/alpha-ui.ts';
import CapabilityUI from '../features/capabilities/capability-ui.ts';
import { createGovernance } from '../features/governance/governance-actions.ts';
import { render as drawGovernance } from '../features/governance/GovernanceView.tsx';
import { createOverview } from '../features/overview/overview-controller.ts';
import { coreLineText, greeting, localSnapshotKeys, paintCoreLine, paintCoreState, wireCorePointer } from '../features/overview/overview-core.ts';
import { render as drawOverviewPulse } from '../features/overview/OverviewPulse.tsx';
import { clearActivityFeed as clearActivityFeedCard, render as renderWorkspacePulseCards, renderActivityFeed } from '../features/overview/WorkspacePulse.tsx';
import { render as renderGalaxyPulseGrid } from '../features/repositories/GalaxyPulse.tsx';
import RenderedAudit from '../features/parallax/RenderedAudit.tsx';
import { createPullBoard } from '../features/posture/pull-board-controller.ts';
import { render as renderPullBoardCard } from '../features/posture/PullBoard.tsx';
import { POSTURE_TTL_MS, createPosture } from '../features/posture/posture-controller.ts';
import { render as renderSecurityPostureCard } from '../features/posture/SecurityPosture.tsx';
import RepoSigil from '../features/repositories/repo-sigil.ts';
import TrustUI from '../features/trust/TrustViews.tsx';
import * as AuditScreen from '../features/uranus/AuditScreen.tsx';
import * as AuditMemory from '../features/uranus/audit-memory.ts';
import * as AuditReports from '../features/uranus/audit-reports.ts';
import * as AuditSbom from '../features/uranus/audit-sbom.ts';
import ArchiveSafety from '../features/workbench/archive-safety.ts';
import ExportSafety from '../features/workbench/export-safety.ts';
import { discardHeldRepaints, repaintCard } from '../components/held-repaint.ts';
import { probeSource } from '../platform/probe.ts';
import { NO_ROUTE, currentRoute, formatRoute, onRouteChange, parseRoute, writeRoute } from '../platform/router.ts';
import { pageStore, state } from '../platform/page-state.ts';
import { offlineRepoKey, offlineRepoList as readOfflineRepos, offlineRepoStorageKey, withOfflineRepo } from '../platform/offline-repos.ts';
import { createTransport } from '../platform/transport.ts';
import Visuals from '../visualizations/nebula-visuals.ts';
import { EMPTY_ICON, META_ICON } from '../components/icons.ts';
import { repositoryReference, sessionHost } from '../features/repositories/repository-reference.ts';
import { createRepositoryList } from '../features/repositories/repository-list-controller.ts';
import { createRepositoryOpener } from '../features/repositories/repository-opener.ts';
import { createRepositoryPicker } from '../features/repositories/repository-picker-controller.ts';
import { pickTool } from '../features/repositories/repository-picker.ts';
import { createRepositoryHeader } from '../features/repositories/repository-header-controller.ts';
import { branchProtected as isProtectedBranch, fillBranchSelect as fillBranches } from '../features/repositories/repository-branches.ts';
import { createFilesPanel } from '../features/workbench/files-panel.ts';
import { DISPOSITION_WORDS as EXPOSURE_DISPOSITION_WORDS, historyPreferred, ruleLabel as exposureRuleLabel } from '../features/exposure/exposure-words.ts';
import { createExposure } from '../features/exposure/exposure-controller.ts';
import { createExposureView } from '../features/exposure/exposure-view.ts';
import { bindExposureControls } from '../features/exposure/exposure-controls.ts';
import { createFileTree } from '../features/workbench/file-tree.ts';
import { createItemMenu } from '../features/workbench/item-menu.ts';
import { createSafety } from '../features/safeguards/safety-controller.ts';
import { createSafeguards } from '../features/safeguards/safeguards-screen.ts';
import { createFileIndex } from '../features/workbench/file-index.ts';
import { createFolderFlows } from '../features/workbench/folder-flows.ts';
import { createRepositoryDeletion } from '../features/repositories/repository-deletion.ts';
import { createSnapshotRecovery } from '../features/safeguards/snapshot-recovery.ts';
import { createRepositoryExports } from '../features/safeguards/repository-exports.ts';
import { createSecurityScan } from '../features/safeguards/security-scan.ts';
import { createWorkspace } from '../features/workbench/workspace.ts';
import { createSiteCheck } from '../features/parallax/site-check.ts';
import { AUDIT_POLL, createAuditController, transientAuditError as isTransientAudit } from '../features/uranus/audit-controller.ts';
import { createAuditHistory } from '../features/uranus/audit-history-controller.ts';
import { TRIAGE_EVENT_WORD, auditDay, auditMoment, createAuditTriage } from '../features/uranus/audit-triage-controller.ts';
import { nameRepository } from '../features/repositories/repository-header.ts';
import { VISITOR_TABS, forgetRepository, recentRepositories as readRecentRepositories } from '../features/repositories/recent-repositories.ts';
import { createActivityFeed } from '../features/overview/activity-feed-controller.ts';
import { paintBoundary } from '../features/overview/boundary-line.ts';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const isMobile = () => window.matchMedia('(max-width:900px)').matches;
const NV_PRODUCT_NAME = 'Nebulaverse-X';


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
  if (record) pageStore.mutate('work', () => { record.sha = String(commit); });
}

/* ---------------- fetch helper (platform/transport.ts) ---------------- */
/* The repositories kept for offline use, under the reader's cache scope (platform/offline-repos.ts). */
function offlineStorage() { try { return localStorage; } catch { return null; } }
function offlineRepoList() { return readOfflineRepos(state.me, offlineStorage()); }
function workOfflineRepoKey() {
  if (!state.work || !state.me) return '';
  return offlineRepoKey(state.me, state.work.owner, state.work.repo);
}
function isOfflineRepoEnabled() {
  const key = workOfflineRepoKey();
  return !!key && offlineRepoList().includes(key);
}
async function setOfflineRepoEnabled(enabled) {
  const storageKey = offlineRepoStorageKey(state.me);
  const repoKey = workOfflineRepoKey();
  if (!storageKey || !repoKey) throw new Error('Sign in and open a repository first');
  localStorage.setItem(storageKey, JSON.stringify(withOfflineRepo(offlineRepoList(), repoKey, enabled)));
  if (!enabled) await accountBoundary.purgePrivateCaches();
}
/*
 * Every request the page makes. A write refused because its branch moved
 * reads the repository again; an alpha session that ended or was revoked
 * clears the page and shows why before the refusal reaches the caller.
 */
const transport = createTransport({
  fetch: (input, init) => fetch(input, init),
  identity: () => state.me,
  storage: () => localStorage,
  now: () => Date.now(),
  onBranchChanged: () => { if (state.work) queueMicrotask(() => refreshRepoMetadata().catch(() => {})); },
  onAlphaEnded: async code => {
    await purgeLocalData(true);
    broadcastIdentityBoundary();
    alphaBootStarted = false;
    AlphaUI.showExpired(code);
    pages.setCurrent('alpha-access');
  }
});
const { api, apiCached, ensureCsrfToken, clearCsrfToken } = transport;

/* Step-up: a sensitive action authorized once, now (features/security/step-up.ts). */
const stepUp = createStepUp({ modal: request => modal(request), api, toast: (message, kind) => toast(message, kind), identity: () => state.me, field: id => document.getElementById(id) });
function requestStepUp(action, scope, label) { return stepUp.request(action, scope, label); }
function stepUpApi(action, scope, path, opts, label) { return stepUp.send(action, scope, path, opts, label); }

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
/*
 * The pulse over the repository list (features/repositories/GalaxyPulse.tsx):
 * what this session actually loaded, each measure with its own source.
 */
function renderGalaxyPulse(repos) {
  const section = $('#reposPulse');
  const grid = $('#reposPulseGrid');
  if (!section || !grid) return;
  section.hidden = !renderGalaxyPulseGrid(grid, Array.isArray(repos) ? repos : []);
}

/*
 * A segmented control is a set of choices, and which one is chosen was carried
 * only by an .active class -- visible, but silent. Selection moves through
 * here so the class and the announced state cannot drift apart at any of the
 * places that repaint one.
 */
function selectSegment(groupSelector, isChosen) {
  $$(`${groupSelector} .seg-btn`).forEach((button, index) => {
    const chosen = !!isChosen(button, index);
    button.classList.toggle('active', chosen);
    button.setAttribute('aria-checked', String(chosen));
  });
}

/* The page's short notices (components/toasts.ts): shown, said with their tone, and gone. */
const showToast = createToasts({
  document,
  stack: () => $('#toasts'),
  setTimeout: (run, ms) => setTimeout(run, ms),
  vibrate: ms => { if (navigator.vibrate) navigator.vibrate(ms); }
});
function toast(msg, kind = '') { return showToast(msg, kind); }
function presentError(error) {
  return TrustUI.presentError(error || new Error('The request could not be completed.'));
}

/* Safe Passage, as the page offers it (features/governance/safe-passage.ts). */
const takeSafePassage = createSafePassage({ modal: request => modal(request), api, toast: (message, kind) => toast(message, kind), presentError: error => presentError(error), repository: () => (state.work ? wPath() : null) });

/* ---------------- overlay motion ---------------- */
/*
 * Every overlay here opened with an animation and closed with none, a cut. The
 * rules that fixed that live in components/overlay-motion.ts, next to a test that can
 * drive the timer fallback without a browser: the safety of a deferred hide is
 * entirely in what happens when the animation never ends, and that case cannot
 * be reached from the page.
 */
const { overlayOpen, openOverlay, closeOverlay, anyOverlayClosing } = OverlayMotion.createOverlayMotion();

/* ---------------- modal ---------------- */
/* The page's one dialog (components/modal.ts). */
const dialog = createModal({
  elements: () => ({ scrim: $('#scrim'), modal: $('#modal'), title: $('#modalTitle'), body: $('#modalBody'), ok: $('#modalOk'), cancel: $('#modalCancel'), close: $('#modalClose') }),
  overlay: { openOverlay, closeOverlay, overlayOpen },
  anchor: anchorOverlayOrigin,
  epoch: () => state.uiEpoch,
  identity: () => state.me,
  activeElement: () => document.activeElement,
  setTimeout: (run, ms) => setTimeout(run, ms),
  requestAnimationFrame: run => requestAnimationFrame(run),
  /*
   * A dialog just finished is a reader between actions, not one reading down
   * the page: the floating actions come back, wherever the page is scrolled.
   */
  onClosed: () => floatingActions.settle()
});
dialog.wire();
/* A shared scrim being open does not mean it still belongs to this request. */
function modalOwner() { return dialog.owner(); }
function modal(request) { return dialog.open(request); }
function closeModal(confirmed) { dialog.close(confirmed); }

/* ---------------- pages ---------------- */
/* The screens: one in view, the next brought in, the top bar measured (features/shell/pages-controller.ts). */
const pages = createPages({
  screens: () => $$('.page'),
  screen: name => $('#page-' + name),
  activeTopbar: () => document.querySelector('.page.active .topbar'),
  setRootProperty: (name, value) => document.documentElement.style.setProperty(name, value),
  startViewTransition: typeof document.startViewTransition === 'function' ? change => document.startViewTransition(change) : null,
  motion: () => !!state.settings.motion,
  layerLeaving: () => anyOverlayClosing(),
  reducedMotion: () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  scrollToTop: () => window.scrollTo(0, 0),
  setTimeout: (run, ms) => setTimeout(run, ms),
  requestAnimationFrame: run => requestAnimationFrame(run),
  paintRail: name => paintRail(name),
  mountVisual: (kind, selector) => mountNebulaVisual(kind, selector),
  clearAddress: () => writeRoute(NO_ROUTE),
  paintDock: name => paintFloatingAction(name)
});
function measureTopbar() { pages.measureTopbar(); }
window.addEventListener('resize', measureTopbar);
window.addEventListener('orientationchange', measureTopbar);
/* The rail: narrowed or not, Magnetar Sec folded or open, the screen marked, the drawer (features/shell/rail-controller.ts). */
const rail = createRail({
  body: document.body,
  collapseToggle: () => $('#railCollapse'),
  entries: () => $$('#navRail .nv-rail-item'),
  securityEntries: () => $$('#railSecurityFold .nv-rail-item'),
  fold: () => $('#railSecurityFold'),
  foldHead: () => $('#railSecurityLabel'),
  rail: () => $('#navRail'),
  scrim: () => $('#navScrim'),
  menuButtons: () => $$('.nav-menu-btn'),
  user: () => $('#navUser'),
  userText: part => $(part === 'initial' ? '#navUserInitial' : part === 'name' ? '#navUserName' : '#navUserSub'),
  storage: () => localStorage,
  viewportWidth: () => window.innerWidth,
  openOverlay: element => openOverlay(element),
  closeOverlay: (element, settled) => closeOverlay(element, settled),
  activeTab: () => ($('.tabpane.active') || {}).id || '',
  me: () => state.me,
  now: () => Date.now(),
  attached: node => document.contains(node),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: timer => clearTimeout(timer)
});
$('#railSecurityFold') && $('#railSecurityFold').addEventListener('transitionend', event => rail.foldSettled(event));
$('#railSecurityLabel') && $('#railSecurityLabel').addEventListener('click', () => rail.toggleSecurityFold());
$('#railCollapse') && $('#railCollapse').addEventListener('click', () => rail.toggleCollapsed());
rail.restore();

/* The floating action: the controls a screen's top bar had no room for (features/shell/floating-actions-controller.ts). */
const floatingActions = createFloatingActions({
  dock: () => $('#paletteFab'),
  menu: () => $('#fabMenu'),
  stand: () => $('.nv-fab-dock'),
  screen: name => $('#page-' + name),
  create: tag => document.createElement(tag),
  openOverlay: element => openOverlay(element),
  closeOverlay: element => closeOverlay(element),
  overlayOpen: element => overlayOpen(element),
  anchor: (overlay, origin) => anchorOverlayOrigin(overlay, origin),
  applyCapabilities: root => CapabilityUI.apply(root),
  activeElement: () => document.activeElement,
  scrollY: () => window.scrollY
});
function paintFloatingAction(name) { floatingActions.paint(name); }
window.addEventListener('scroll', () => floatingActions.onScroll(), { passive: true });
$('#paletteFab') && $('#paletteFab').addEventListener('click', () => floatingActions.toggle());
/* Escape closes it and hands focus back; a press outside closes it without taking focus from where the reader went. */
document.addEventListener('keydown', event => { floatingActions.onKey(event.key); });
document.addEventListener('pointerdown', event => floatingActions.onPointerDown(event.target));

/* The galaxy leans a few degrees toward the pointer on a desk; never on a touch screen (features/shell/pages-controller.ts). */
if ($('.gx-hero') && $('#gxHeroArt') && window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
  watchLean({ hero: $('.gx-hero'), art: $('#gxHeroArt'), motionOff: () => document.documentElement.dataset.motion === 'off', requestAnimationFrame: run => requestAnimationFrame(run) });
}

/* Settles once the screen is the one showing. */
function showPage(name) { return pages.show(name); }
/* The address and the workbench, kept in step (features/shell/route-sync.ts). */
const routes = createRouteSync({
  page: () => pages.current(),
  work: () => state.work,
  tab: () => currentTab(),
  file: () => (state.file && state.file.path ? state.file.path : null),
  signedIn: () => !!state.me,
  hash: () => location.hash,
  currentRoute: () => currentRoute(),
  parseRoute: hash => parseRoute(hash),
  formatRoute: route => formatRoute(route),
  writeRoute: (route, options) => writeRoute(route, options),
  findingsOffered: () => findingsOffered(),
  showFindings: query => showFindings(findingsInbox.parseFilters(query)),
  openRepo: (owner, repo) => openRepo(owner, repo),
  branches: () => { const select = $('#branchSelect'); return select ? [...select.options].map(option => option.value) : []; },
  selectBranch: branch => {
    const select = $('#branchSelect');
    select.value = branch;
    select.dispatchEvent(new Event('change'));
  },
  startOnBranch: branch => {
    pageStore.mutate('work', work => { work.branch = branch; });
    $('#branchSelect').value = branch;
    state.fileIndex = null;
    loadTree('', $('#tree'), true);
  },
  switchTab: tab => switchTab(tab),
  openFile: path => openFile(path)
});
function saveRoute(push = false) { routes.save(push); }
onRouteChange(() => { void routes.apply(); });
function restoreRoute() { return routes.restore(); }

/* ---------------- theme & settings ---------------- */
/* How the page looks: the theme, the design, motion and the editor (features/shell/appearance-controller.ts). */
const look = createAppearance({
  root: document.documentElement,
  themeMeta: () => document.querySelector('meta[name=theme-color]'),
  designChoices: () => $$('[data-design-choice]'),
  themeSwitches: () => $$('.theme-toggle'),
  logos: () => [...document.querySelectorAll('.nv-logo svg')],
  storage: () => localStorage,
  settings: () => state.settings,
  mutateSettings: change => pageStore.mutate('settings', change),
  prefersReducedMotion: () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  anyOverlayClosing,
  viewport: () => ({ width: window.innerWidth, height: window.innerHeight }),
  startViewTransition: typeof document.startViewTransition === 'function' ? change => document.startViewTransition(change) : null,
  repaintVisuals: () => Visuals.repaint(),
  editor: () => state.cm || null
});
function loadSettings() { look.load(); }
function applySettings() { look.apply(); }
function toggleTheme(origin) { look.toggleTheme(origin); }
document.addEventListener('click', e => look.onClick(e.target && typeof e.target.closest === 'function' ? e.target : null));
/* The Design choices are a radio group: the arrows move the choice, and the group is one tab stop. */
document.addEventListener('keydown', e => { if (look.onKey(e.target, e.key)) e.preventDefault(); });
$('#settingsBtnRepos').addEventListener('click', openSettings);
$('#settingsBtnOv') && $('#settingsBtnOv').addEventListener('click', openSettings);
$('#settingsBtnWork').addEventListener('click', openSettings);

/*
 * A sign-in that did not finish, said once. The alpha's door takes the marker
 * out of the address before this page runs, and says it itself to a reader
 * it keeps; one it lets straight through is handed the words instead
 * (features/access/alpha-ui.ts), and they are said here.
 */
let handedSignInNotice = '';
function oauthCallbackNotice() {
  const notice = handedSignInNotice;
  handedSignInNotice = '';
  if (notice) toast(notice, 'err');
}

/* The GitHub App's part of Settings (features/settings/github-app-controller.ts). */
const githubApp = createGithubApp({
  api, toast: (message, kind) => toast(message, kind), presentError: error => presentError(error),
  confirm: question => window.confirm(question),
  configured: () => !!(state.runtime.githubApp && state.runtime.githubApp.enabled),
  me: () => state.me,
  body: () => $('#githubAppSettingsBody'),
  formatDate: date => date.toLocaleString(),
  navigate: url => location.assign(url),
  attached: node => document.contains(node),
  purgeLocalData: full => purgeLocalData(full),
  broadcastIdentityBoundary: () => broadcastIdentityBoundary(),
  signedOut: () => { state.me = null; closeModal(false); showSignIn(); },
  identityChanged: async () => {
    state.me = requireGithubIdentity(await api('/api/me'));
    state.caps = state.me.caps || null;
    applyCaps();
    setAvatar(state.me.avatar);
  },
  address: () => location,
  replaceAddress: url => history.replaceState(null, '', url)
});
function githubAppCallbackNotice() { githubApp.notice(); }
document.addEventListener('click', event => {
  githubApp.onClick(event.target && typeof event.target.closest === 'function' ? event.target : null);
});
/* Settings (features/settings/settings-panel.ts). */
const settingsPanel = createSettingsPanel({
  modal: request => modal(request),
  modalOwner: () => modalOwner(),
  view: () => ({
    settings: state.settings,
    dark: document.documentElement.dataset.theme === 'dark',
    offline: state.work ? isOfflineRepoEnabled() : null,
    alphaActions: AlphaUI.gateEnabled() ? $('#alphaPrivacyActions').innerHTML : '',
    release: state.me && state.me.release ? String(state.me.release) : ''
  }),
  mutateSettings: change => pageStore.mutate('settings', change),
  apply: () => applySettings(),
  element: selector => $(selector),
  setOffline: enabled => setOfflineRepoEnabled(enabled),
  purgeLocalData: full => purgeLocalData(full),
  toast: (message, kind) => toast(message, kind),
  githubApp
});
function openSettings() { return settingsPanel.open(); }

/* The alpha's privacy actions (features/access/alpha-privacy.ts). */
const alphaPrivacy = createAlphaPrivacy({
  api,
  modal: request => modal(request),
  closeModal: confirmed => closeModal(confirmed),
  toast: (message, kind) => toast(message, kind),
  presentError: error => presentError(error),
  purgeLocalData: full => purgeLocalData(full),
  broadcastIdentityBoundary: () => broadcastIdentityBoundary(),
  restoreLoginChrome: () => { loginChrome.ensureGuidance(); loginChrome.ensureSessionControls(); },
  showSignIn: () => showPage('login'),
  typedConfirmation: () => String($('#alphaDeleteConfirm') && $('#alphaDeleteConfirm').value || ''),
  attached: node => document.contains(node)
});
/* What to revoke by hand, after an account left the session. */
function showRevocationGuidance(guidance) { return alphaPrivacy.showRevocationGuidance(guidance); }
document.addEventListener('click', event => {
  alphaPrivacy.onClick(event.target && typeof event.target.closest === 'function' ? event.target : null);
});
document.addEventListener('input', e => settingsPanel.onInput(e.target));
document.addEventListener('change', e => { settingsPanel.onChange(e.target); });

/* ---------------- cursor spotlight (components/spotlight.ts) ---------------- */
watchSpotlights(document, window);

/* ================= AUTH ================= */
/* The sign-in screen's alpha panels and its words (features/access/login-screen.ts). */
const loginChrome = createLoginChrome({
  gateEnabled: () => AlphaUI.gateEnabled(),
  card: () => document.querySelector('.login-card'),
  find: selector => $(selector),
  create: tag => document.createElement(tag)
});
/*
 * The sign-in screen, with the controlled alpha's two panels where its gate is
 * on. Built whichever way the reader arrives: one signed in when the page
 * opened never saw the sign-in screen the start builds, so signing out showed
 * it with no word on provider permissions and no way to end the alpha session.
 */
function showSignIn() {
  loginChrome.ensureGuidance();
  loginChrome.ensureSessionControls();
  showPage('login');
}
function renderLoginGuidance() {
  $('#loginHint').innerHTML = loginGuidanceHtml(!!(state.runtime.githubApp && state.runtime.githubApp.enabled));
  $('#loginLimits').textContent = limitsText(state.runtime);
}

function applyCaps() {
  const caps = state.caps || { prs: 1, issues: 1, releases: 1, actions: 1, lfs: 1, tm: 1, batch: 1, search: 1, notif: 1, compare: 1 };
  if (!caps.batch && typeof uploadModeV !== 'undefined' && uploadModeV === 'batch') {
    uploadModeV = 'single';
    selectSegment('#uploadMode', b2 => b2.dataset.v === 'single');
  }
  CapabilityUI.apply();
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
  await CapabilityUI.load(provider, authority, { connected: !!state.me });
  CapabilityUI.apply();
}
function runCapabilityAction(feature, action) {
  if (!feature) {
    action();
    return true;
  }
  const resolved = CapabilityUI.decision(feature);
  /* Only what is Supported runs. There is no opt-in for anything less. */
  const blocked = resolved.status !== 'Supported';
  if (blocked) {
    toast(CapabilityUI.explain(feature), 'err');
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
  toast(CapabilityUI.explain(refused.feature), 'err');
});
/* Unknown means no number, not a small one (features/access/login-screen.ts). */
function runtimeLimitsKnown() { return limitsKnown(state.runtime); }
/* The limits as the browser suite may read them, under the test harness only. */
probeSource('runtime', () => ({ ...state.runtime, known: runtimeLimitsKnown() }));
/* Whether the deployment offers GitHub sign-in, as /api/config last said. */
let oauthOn = false;
async function loadRuntimeConfig(attempt = 0) {
  try {
    const c = await api('/api/config');
    oauthOn = !!c.oauth;
    state.runtime = { ...state.runtime, ...c };
    refreshQueuedStrategies();
    $('#oauthBtn').hidden = !c.oauth;
    renderLoginGuidance();
  } catch {
    /* One retry: a free instance's first request can arrive while it wakes. */
    if (attempt === 0) return loadRuntimeConfig(1);
    renderLoginGuidance();
  }
}
$('#oauthBtn').addEventListener('click', () => { location.href = '/api/oauth/login'; });
$('#findBtn').addEventListener('click', () => { if (state.file && !state.file.binary) openFindPanel(); });
/*
 * A start in flight, until it has learned who is signed in or that nobody
 * is. The page starts once when it is opened and again at every change of
 * account, and until a start knows its reader nothing may be opened for them.
 */
let sessionArriving = null;
async function boot() {
  let sessionKnown = () => {};
  const arriving = new Promise(resolve => { sessionKnown = resolve; });
  sessionArriving = arriving;
  /*
   * Where a start ends: at the address the page was opened on, or the
   * overview. A reader who has gone to another screen since the start began
   * is left on it -- a start that ended late used to send them back -- and
   * the overview is drawn behind them for whoever is now signed in.
   */
  const arrivals = pages.arrivals();
  const land = async () => { if (!(await restoreRoute())) showOverview(arrivals === pages.arrivals()); };
  loadSettings();
  githubAppCallbackNotice();
  oauthCallbackNotice();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  updateNetBar();
  /*
   * Awaited, and retried once. It was fire-and-forget with a swallowed
   * rejection, so a cold start -- which is the ordinary first request to a free
   * instance -- left every size decision running on the defaults above for the
   * rest of the session, with nothing said.
   */
  await loadRuntimeConfig();
  try {
    state.me = requireGithubIdentity(await api('/api/me'));
    try { sessionStorage.setItem('nv_me', JSON.stringify(state.me)); } catch {}
    refreshSafety();
    state.caps = state.me.caps || null;
    await loadProviderCapabilities();
    applyCaps();
    sessionKnown();
    setAvatar(state.me.avatar);
    flushQueue();
    /* After capabilities, so a deployment that refuses notifications is not
       asked; not awaited, so the marker never delays the first screen. */
    refreshUnread();
    loadPosture();
    loadSecurityPosture();
    loadRepos(true);
    await land();
  } catch (e) {
    const cached = (() => { try { return JSON.parse(sessionStorage.getItem('nv_me') || 'null'); } catch { return null; } })();
    if (githubIdentity(cached) && isOfflineError(e)) {
      /* offline launch: proceed with the last-known identity and cached data */
      state.me = cached;
      state.caps = cached.caps || null;
      await loadProviderCapabilities();
      applyCaps();
      sessionKnown();
      setAvatar(cached.avatar);
      updateNetBar();
      loadRepos(true);
      await land();
      toast('Offline mode — showing cached data ✦', 'ok');
    } else if (e.code === 'ACCOUNT_SELECTION_REQUIRED') {
      /* A retired account is still the selected one: the person chooses a GitHub
         account or removes it; nothing acts as another account meanwhile. */
      await purgeLocalData(false);
      state.me = null;
      showSignIn();
      openAccounts();
    } else if (!['ALPHA_SESSION_EXPIRED', 'ALPHA_ACCESS_REVOKED'].includes(e.code)) {
      if (cached && !githubIdentity(cached)) await purgeLocalData(true);
      state.me = null;
      showSignIn();
    }
  } finally {
    /* Known, or known to be nobody's: whatever waited on this start goes on, and finds out which. */
    sessionKnown();
    if (sessionArriving === arriving) sessionArriving = null;
  }
}
$('#loginBackBtn').addEventListener('click', () => session.back());
$('#loginBtn').addEventListener('click', () => { session.signIn(); });
$('#tokenInput').addEventListener('keydown', e => { if (e.key === 'Enter') session.signIn(); });
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
/*
 * The account boundary (features/access/account-boundary.ts): what this
 * browser holds for a reader, let go of when the reader changes, and the
 * other tabs told.
 */
const accountBoundary = createAccountBoundary({
  state,
  discardHeldRepaints: () => discardHeldRepaints(),
  clearActivityFeed: () => clearActivityFeed(),
  clearPosture: () => clearPosture(),
  paintUnread: list => paintUnread(list),
  clearCsrfToken: () => clearCsrfToken(),
  clearGovernanceState: () => clearGovernanceState(),
  clearExposureState: () => clearExposureState(),
  clearAuditState: () => clearAuditState(),
  clearSiteScanState: () => clearSiteScanState(),
  forgetRepositoryWork: () => forgetRepositoryWork(),
  cacheNames: () => caches.keys(),
  deleteCache: name => caches.delete(name),
  sessionStorage: () => sessionStorage,
  localStorage: () => localStorage,
  serviceWorker: () => navigator.serviceWorker.controller,
  openQueue: () => idb(),
  find: selector => $(selector),
  forgetReads: () => transport.cache.clear(),
  channel: () => (typeof BroadcastChannel === 'function' ? new BroadcastChannel(IDENTITY_BOUNDARY_CHANNEL) : null),
  writeStorage: (key, value) => localStorage.setItem(key, value),
  onStorage: listener => window.addEventListener('storage', listener),
  marker: () => `${Date.now()}:${Math.random().toString(36).slice(2)}`,
  reload: () => window.location.reload()
});
accountBoundary.listen();
function purgeLocalData(full) { return accountBoundary.purge(full); }
function broadcastIdentityBoundary() { accountBoundary.broadcast(); }

/* Signing in with a token and signing out (features/access/session.ts). */
const session = createSession({
  api,
  purge: full => purgeLocalData(full),
  broadcast: () => broadcastIdentityBoundary(),
  token: () => $('#tokenInput').value.trim(),
  clearToken: () => { $('#tokenInput').value = ''; },
  hideError: () => { $('#loginError').hidden = true; },
  setBusy: busy => { $('#loginBtn').disabled = busy; $('#loginBtn').textContent = busy ? 'Docking…' : 'Enter orbit'; },
  backShown: () => !$('#loginBackBtn').hidden,
  showBack: shown => { $('#loginBackBtn').hidden = !shown; },
  adopt: me => { state.me = me; },
  adoptCapabilities: caps => { state.caps = caps; },
  remember: me => sessionStorage.setItem('nv_me', JSON.stringify(me)),
  loadProviderCapabilities: () => loadProviderCapabilities(),
  applyCaps: () => applyCaps(),
  setAvatar: url => setAvatar(url),
  toast: (message, kind) => toast(message, kind),
  presentError: error => presentError(error),
  showRevocationGuidance: guidance => showRevocationGuidance(guidance),
  arrive: () => { showOverview(); loadRepos(true); refreshUnread(); },
  showSignIn: () => showSignIn(),
  showWorkspace: () => showPage('repos'),
  restart: () => boot()
});
function doLogout() { return session.signOut(); }
$('#logoutBtn').addEventListener('click', doLogout);
$('#logoutBtnM').addEventListener('click', doLogout);
$('#logoutBtnOv') && $('#logoutBtnOv').addEventListener('click', doLogout);

/* ================= REPOS ================= */
/* The repository list (features/repositories/repository-list-controller.ts). */
const repositoryList = createRepositoryList({
  api,
  state,
  appendRepos: batch => pageStore.mutate('repos', repos => { repos.push(...batch); }),
  grid: () => $('#repoGrid'),
  moreButton: () => $('#moreReposBtn'),
  cards: () => [...$$('#repoGrid .repo-card')],
  createCard: () => document.createElement('div'),
  sigil: fullName => RepoSigil.render(fullName),
  timeAgo: iso => timeAgo(iso),
  open: (owner, name) => openRepo(owner, name),
  filterText: () => String($('#repoFilter') ? $('#repoFilter').value : ''),
  openAny: () => ({
    input: $('#repoFilter'), card: $('#repoOpenAny'), hint: $('#repoOpenAnyHint'),
    title: $('#repoOpenAnyName'), sub: $('#repoOpenAnySub'), button: $('#repoOpenAnyBtn')
  }),
  renderGalaxyPulse: repos => renderGalaxyPulse(repos),
  renderWorkspacePulse: repos => renderWorkspacePulse(repos),
  toast: (message, kind) => toast(message, kind)
});
function loadRepos(reset) { return repositoryList.load(reset); }
function paintRepoOpenAny() { repositoryList.paintOpenAny(); }
$('#moreReposBtn').addEventListener('click', () => { repositoryList.more(); });
$('#repoSort').addEventListener('change', e => { repositoryList.sort(e.target.value); });
/* One control, on the screen the action belongs to. */
$('#newRepoBtnRepos') && $('#newRepoBtnRepos').addEventListener('click', createRepositoryFlow);
$('#repoFilter').addEventListener('input', e => repositoryList.filter(e.target.value));
$('#repoFilter').addEventListener('keydown', event => {
  if (event.key !== 'Enter' || !repositoryList.enter()) return;
  event.preventDefault();
  $('#repoOpenAnyBtn').click();
});
$('#repoOpenAnyBtn').addEventListener('click', event => {
  const { owner, name } = event.currentTarget.dataset;
  return repositoryList.openAny(owner, name);
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

/*
 * The overview (features/overview/overview-controller.ts): shown for whoever
 * is signed in, its readings asked for, and its pulse -- the summary row
 * (overview-pulse.ts, OverviewPulse.tsx), the core's rail and line
 * (overview-core.ts) and the cards -- drawn from one measurement of what the
 * session holds.
 */
const overview = createOverview({
  state,
  capabilities: CapabilityUI,
  localSnapshots: () => localSnapshotKeys(() => localStorage),
  greet: () => { const who = $('#ovWho'); if (who) who.textContent = greeting(state.me); },
  paintCoreState: () => paintCoreState($('#ovCoreScope'), $('#ovCoreLive'), state.me),
  paintCoreLine: pulse => paintCoreLine($('#ovCoreLine'), pulse, state.me, (line, draw) => repaintCard(line, draw)),
  row: () => ({ section: $('#ovPulse'), grid: $('#ovPulseGrid') }),
  drawRow: (section, grid, measures) => drawOverviewPulse(section, grid, measures),
  cards: () => ({ trust: $('#wpTrust'), signals: $('#wpSignals'), activity: $('#wpActivity') }),
  drawCards: (hosts, pulse) => renderWorkspacePulseCards(hosts, pulse),
  readings: {
    scanner: () => loadScannerPosture(),
    posture: () => loadPosture(),
    security: () => loadSecurityPosture(),
    feed: () => loadActivityFeed(),
    renderSecurity: () => renderSecurityPosture()
  },
  board: { watch: () => pullBoard.watch(), visible: () => pullBoard.visible(), load: () => pullBoard.load(), render: () => pullBoard.render() },
  showPage: name => showPage(name)
});
function showOverview(arrive = true) { overview.show(arrive); }
function renderWorkspacePulse(repos) { overview.renderPulse(repos); }
wireCorePointer($('#ovCore'), window.matchMedia ? query => window.matchMedia(query) : null, () => state.settings.motion);

/*
 * The recent-activity feed (features/overview/activity-feed-controller.ts):
 * read once per identity and again on Refresh, every failure drawn.
 */
const activityFeed = createActivityFeed({
  state,
  api: path => api(path),
  root: () => $('#wpFeed'),
  refresh: () => $('#wpFeedRefresh'),
  draw: (root, current) => renderActivityFeed(root, current),
  erase: root => clearActivityFeedCard(root),
  now: () => Date.now()
});
function clearActivityFeed() { activityFeed.clear(); }
function loadActivityFeed(force) { return activityFeed.load(force); }

$('#wpFeedRefresh')?.addEventListener('click', () => loadActivityFeed(true));

/*
 * The workspace posture, the security posture card and upload scanning
 * (features/posture/posture-controller.ts), the open pull requests across the
 * workspace (features/posture/pull-board-controller.ts), and the rail's
 * boundary line (features/overview/boundary-line.ts): each read for the
 * identity that asked, and dropped when another is here.
 */
const posture = createPosture({
  state,
  api: path => api(path),
  now: () => Date.now(),
  isOffline: error => isOfflineError(error),
  capability: name => CapabilityUI.decision(name).status,
  paintBoundary: boundary => paintBoundary($('#navBoundary'), boundary),
  renderPulse: () => renderWorkspacePulse(),
  clearFindings: () => clearFindings(),
  invalidateFindings: () => { findingsState.at = 0; },
  clearPullBoard: () => pullBoard.clear(),
  section: () => $('#wpPostureSection'),
  host: () => $('#wpPosture .wp-body'),
  draw: (host, view, actions) => renderSecurityPostureCard(host, view, actions),
  openTool: (owner, repo, tab) => openRepositoryTool(owner, repo, tab),
  inbox: () => (findingsOffered() ? filters => showFindings(findingsInbox.parseFilters(filters || '')) : null)
});
function invalidatePosture() { posture.invalidate(); }
function clearPosture() { posture.clear(); }
function loadPosture(force) { return posture.load(force); }
function renderSecurityPosture() { posture.renderSecurity(); }
function loadSecurityPosture(force) { return posture.loadSecurity(force); }
async function openRepositoryTool(owner, repo, tab) {
  const opened = await openRepo(owner, repo);
  if (opened) switchTab(tab);
}
const pullBoard = createPullBoard({
  state,
  api: path => api(path),
  cached: (path, ttl) => apiCached(path, ttl),
  keep: (path, value) => transport.cache.set(path, value),
  isOffline: error => isOfflineError(error),
  now: () => Date.now(),
  capability: name => CapabilityUI.decision(name).status,
  section: () => $('#wpPullsSection'),
  host: () => $('#wpPulls .wp-body'),
  draw: (host, view, actions) => renderPullBoardCard(host, view, actions),
  intersection: typeof IntersectionObserver === 'function' ? (seen, options) => new IntersectionObserver(seen, options) : null,
  chooseOpenList: () => selectSegment('#prState', button => button.dataset.v === 'open'),
  openTool: (owner, repo, tab) => openRepositoryTool(owner, repo, tab),
  listDrawn: () => !$('#prList .skeleton'),
  loadPulls: () => loadPRs()
});
function renderPullBoard() { pullBoard.render(); }

/* Upload scanning, asked once the overview is shown (features/posture/posture-controller.ts). */
function loadScannerPosture() { return posture.loadScanner(); }

/*
 * The design's WebGL pieces mount when their screen is shown, never at boot.
 * They pull three.js behind them, so a session that never opens the screen
 * never pays for the download -- and a device that cannot draw them, or a
 * reader on a metered connection, never does either. The loader decides; this
 * only says which host belongs to which screen.
 */
function mountNebulaVisual(kind, selector) {
  const host = $(selector);
  if (!host) return;
  Visuals.mount(kind, host);
}

/* Both home screens open the same account sheet (features/access/accounts-dialog.ts). */
const accountsDialog = createAccountsDialog({
  api,
  modal: request => modal(request),
  owner: () => modalOwner(),
  generation: () => dialog.generation(),
  closeModal: confirmed => closeModal(confirmed),
  setBody: html => { $('#modalBody').innerHTML = html; },
  controls: selector => [...$$(selector)],
  oauthOn: () => oauthOn,
  purge: full => purgeLocalData(full),
  broadcast: () => broadcastIdentityBoundary(),
  clearAddress: () => { location.hash = ''; },
  restart: () => boot(),
  forgetRemembered: () => sessionStorage.removeItem('nv_me'),
  showSignIn: () => showSignIn(),
  addAccount: () => { $('#loginBackBtn').hidden = false; showSignIn(); },
  signOut: () => doLogout(),
  toast: (message, kind) => toast(message, kind),
  showRevocationGuidance: guidance => showRevocationGuidance(guidance)
});
function openAccounts() { return accountsDialog.open(); }
$('#accountBtn').addEventListener('click', openAccounts);
$('#accountBtnOv') && $('#accountBtnOv').addEventListener('click', openAccounts);
/*
 * The unread marker reports what this session loaded, and nothing when it has
 * loaded nothing. The count comes from the same list the dialog renders --
 * there is no separate unread endpoint to consult, so asking for one would be
 * inventing a second source that could disagree with what the reader then
 * sees. A refusal leaves the marker exactly as it was rather than clearing it,
 * because "we could not ask" is not "there is nothing".
 */
function paintUnread(list) {
  const marker = $('#notifUnread');
  if (!marker) return;
  const unread = Array.isArray(list) ? list.filter(entry => entry && entry.unread).length : 0;
  marker.hidden = unread === 0;
  marker.textContent = unread > 9 ? '9+' : (unread > 1 ? String(unread) : '');
  const bell = $('#notifBtn');
  if (bell) {
    bell.setAttribute('aria-label', unread
      ? `Notifications, ${unread} unread`
      : 'Notifications');
  }
}
let unreadRequest = 0;
async function loadNotifications() {
  const identity = state.me;
  const epoch = state.uiEpoch;
  const request = ++unreadRequest;
  const list = await api('/api/notifications');
  if (!identity || identity !== state.me || epoch !== state.uiEpoch) return null;
  // A background refresh must not replace a more recently requested inbox.
  if (request === unreadRequest) paintUnread(list);
  return list;
}
async function refreshUnread() {
  /* Both directions through one door. Returning early on a session with no
     identity left whatever the last session lit still lit, so a reader who
     signed out kept someone else's count over a bell they could not open. */
  if (!state.me) { paintUnread([]); return; }
  const capabilities = CapabilityUI;
  if (capabilities && capabilities.decision) {
    const decision = capabilities.decision('notifications');
    /* Asking through a capability the deployment has refused would spend a
       request to be told no, and would light nothing either way. */
    if (decision && decision.blocked) return;
  }
  try { await loadNotifications(); } catch { /* left as it was */ }
}

$('#notifBtn').addEventListener('click', async () => {
  modal({ title: 'Notifications', okText: 'Close', bodyHTML: '<div class="skeleton" style="height:80px"></div>' });
  const ownsModal = modalOwner();
  try {
    const list = await loadNotifications();
    if (!list || !ownsModal()) return;
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
  } catch (e) { if (ownsModal()) $('#modalBody').innerHTML = `<p class="hint">⚠ ${esc(e.message)}</p>`; }
});
$('#backBtn').addEventListener('click', () => {
  if (state.staged.length && !confirm('You have staged changes that will be lost. Leave anyway?')) return;
  state.staged = []; renderStagedCount();
  showPage('repos');
});
/*
 * One handler, two controls. The top bar carries this above the breakpoint and
 * the repositories filter row carries it below, because the bar had no room
 * for it on a phone -- but they are the same action, so they share the same
 * function rather than growing a second copy that can drift from it.
 */
async function createRepositoryFlow() {
  const accountScope = state.me && state.me.offlineCacheScope;
  const ok = await modal({
    title: 'New repository',
    bodyHTML: `
      <label class="field-label" for="nrName">Name</label><input id="nrName" type="text" placeholder="my-nebula" autocapitalize="off" autocorrect="off" spellcheck="false">
      <label class="field-label" for="nrDesc">Description</label><input id="nrDesc" type="text" placeholder="Optional">
      <label class="check"><input type="checkbox" id="nrPriv" checked> Private</label>`,
    okText: 'Create'
  });
  if (!ok) return;
  const name = $('#nrName').value.trim();
  if (!name) return;
  if (!state.me || state.me.offlineCacheScope !== accountScope) return toast('Account changed — reopen repository creation.', 'err');
  try {
    const r = await api('/api/repos', { method: 'POST', body: { name, description: $('#nrDesc').value, isPrivate: $('#nrPriv').checked } });
    toast(`Created and verified ${r.full_name} ✦`, 'ok');
    if (!state.me || state.me.offlineCacheScope !== accountScope) return;
    const [owner, repository] = r.full_name.split('/');
    await openRepo(owner, repository);
  } catch (e) { presentError(e); }
}

/* ================= WORKSPACE ================= */
/*
 * The workspace (features/workbench/workspace.ts). Everything on screen that
 * belongs to one repository is cleared together when another is opened --
 * before the first await, so no section is drawn with the last repository's
 * findings under the new one's name, and every request still in flight for
 * it (an audit poll, a scan status, a graph load, a branch-rule read) lands
 * on a view that is no longer its own and is dropped. Refresh reads the tool
 * open again, and another branch draws again the tools that belong to one.
 */
const workspace = createWorkspace({
  tab: () => currentTab(),
  views: [
    () => clearGovernanceState(),
    () => clearExposureState(),
    () => clearAuditState(),
    () => safeguards.reset(),
    () => { if (neural) neural.reset(); }
  ],
  tree: { forgetIndex: () => { state.fileIndex = null; }, load: () => loadTree('', $('#tree'), true) },
  commits: { reset: () => { state.commitsPage = 1; $('#commitList').innerHTML = ''; }, load: () => loadCommits(true) },
  reread: {
    pulls: () => loadPRs(),
    issues: () => loadIssues(),
    releases: () => loadReleases(),
    actions: () => loadActions(),
    governance: () => loadGovernanceTwin(true),
    safeguards: () => renderSafeguards({ fresh: true }),
    exposure: () => loadExposure(),
    audit: () => rereadAudit(),
    neural: () => { if (neural) neural.refresh(); }
  },
  redraw: {
    safeguards: () => renderSafeguards(),
    audit: () => paintAudit(),
    neural: () => { if (neural) neural.refresh(); }
  },
  file: () => state.file,
  openFile: path => openFile(path)
});
function resetRepositoryViews() { workspace.resetViews(); }
/*
 * A repository opened into the workbench (features/repositories/repository-opener.ts):
 * the last one let go of first, named as typed then as the provider spells it,
 * read-only when it is somebody else's, its trust summary drawn for it alone
 * (repository-trust.ts), and a failure back to the list with focus on what
 * was pressed. Resolves true when this repository is the one open at the end,
 * false when it could not be opened, and null when another was opened
 * meanwhile -- that open owns the workbench.
 */
const repositoryOpener = createRepositoryOpener({
  state,
  api: path => api(path),
  arriving: () => sessionArriving,
  pressed: () => {
    const active = document.activeElement;
    return active instanceof HTMLElement && active !== document.body ? active : null;
  },
  showPage: name => showPage(name),
  resetViews: () => resetRepositoryViews(),
  emptyWorkbench: () => {
    $('#tree').innerHTML = '<div class="skeleton" style="height:200px"></div>';
    closeFile();
    state.staged = []; renderStagedCount();
    state.fileIndex = null;
    ['#prList', '#issueList', '#releaseList', '#commitList', '#cmpResult', '#uploadQueue', '#actionsList'].forEach(s => { $(s).innerHTML = ''; });
    $('#prDetail').hidden = true; $('#issueDetail').hidden = true;
  },
  name: (owner, repo) => nameRepository($('#workRepoName'), document, owner, repo),
  badges: (privateRepo, visitor) => {
    $('#workPrivateBadge').hidden = !privateRepo;
    $('#workVisitorBadge').hidden = !visitor;
    document.body.classList.toggle('repo-visitor', visitor);
  },
  readOnly: visitor => { if (state.cm) state.cm.setOption('readOnly', visitor); },
  branches: (names, defaultBranch) => {
    fillBranchSelect($('#branchSelect'), names, defaultBranch);
    fillBranchSelect($('#cmpBase'), names, defaultBranch);
    fillBranchSelect($('#cmpHead'), names, names.find(n => n !== defaultBranch) || defaultBranch);
  },
  arrive: () => {
    refreshShield();
    switchTab('editor');
    loadTree('', $('#tree'), true);
    refreshRate();
    saveRoute();
  },
  drawTrust: summary => TrustUI.renderSummary(summary),
  presentError: error => presentError(error),
  star: (work, starred) => pageStore.mutate('work', () => { work.starred = starred; }),
  storage: () => localStorage
});
/* The account is leaving: a repository still opening for it never finishes opening, and its graph goes. */
function forgetRepositoryWork() {
  repositoryOpener.forget();
  if (neural) neural.reset();
}
function openRepo(owner, repo) { return repositoryOpener.open(owner, repo); }

/*
 * A security tool chosen before a repository is: rather than refusing, it
 * asks which one, and lands in the tool (features/repositories/repository-picker.ts
 * and repository-picker-controller.ts). The recent list is names only, under
 * the nv_recent: prefix the account-boundary purge removes.
 */
/* The recent list and who is visiting (features/repositories/recent-repositories.ts). */
function recentRepositories() { return readRecentRepositories(() => localStorage); }
function visitingRepository() { return Boolean(state.work && state.work.visitor); }
const repositoryPicker = createRepositoryPicker({
  state,
  api: path => api(path),
  modal: request => modal(request),
  owner: () => modalOwner(),
  closeModal: confirmed => closeModal(confirmed),
  okButton: () => $('#modalOk'),
  railMark: target => {
    const mark = document.querySelector(`.nv-rail-item[data-rail="${target}"] .nv-rail-i`);
    return mark ? mark.outerHTML : '';
  },
  coarse: () => Boolean(window.matchMedia && window.matchMedia('(pointer: coarse)').matches),
  doc: document,
  sigil: fullName => RepoSigil.render(fullName),
  timeAgo: iso => timeAgo(iso),
  host: () => sessionHost(),
  recent: () => recentRepositories(),
  reference: text => repositoryReference(text),
  append: fresh => pageStore.mutate('repos', repos => { repos.push(...fresh); }),
  open: (owner, name) => openRepo(owner, name),
  switchTab: tool => switchTab(tool)
});
function pickRepository(target, pickOptions = {}) { return repositoryPicker.pick(target, pickOptions); }
/*
 * The repository header's controls (features/repositories/repository-header-controller.ts
 * and repository-branches.ts): the repository read again and laid over the
 * one open in place, the branch chosen and its shield, a branch created and
 * switched to, the star and the archive.
 */
const repositoryHeader = createRepositoryHeader({
  state,
  api: (path, options) => api(path, options),
  mutateWork: change => pageStore.mutate('work', change),
  doc: document,
  branchSelect: () => $('#branchSelect'),
  compareBase: () => $('#cmpBase'),
  compareHead: () => $('#cmpHead'),
  shield: () => $('#branchShield'),
  modal: request => modal(request),
  newBranchName: () => $('#nbName').value,
  toast: (message, kind) => toast(message, kind),
  presentError: error => presentError(error),
  haptic: () => hapt(),
  closeDrawer: () => closeDrawer(),
  closeFile: () => closeFile(),
  reloadTree: () => reloadTree(),
  reloadView: () => reloadView(),
  resetCommits: () => resetCommits(),
  branchChanged: () => workspace.branchChanged(),
  refreshRate: () => refreshRate(),
  saveRoute: () => saveRoute()
});
function refreshRepoMetadata() { return repositoryHeader.refresh(); }
function toggleStar() { return repositoryHeader.toggleStar(); }
function refreshShield() { repositoryHeader.refreshShield(); }
function downloadZip() { repositoryHeader.downloadZip(); }
function fillBranchSelect(select, names, selected) { fillBranches(document, select, names, selected); }
function branchProtected(name) { return isProtectedBranch(state.work, name); }
function reloadTree() { workspace.reloadTree(); }
function resetCommits() { workspace.resetCommits(); }
function reloadView() { workspace.reloadView(); }
$('#syncBtn').addEventListener('click', () => repositoryHeader.sync());
$('#branchSelect').addEventListener('change', e => repositoryHeader.changeBranch(e.target.value));
$('#newBranchBtn').addEventListener('click', () => repositoryHeader.createBranch());
$('#refreshTreeBtn').addEventListener('click', () => reloadTree());
$('#zipBtn').addEventListener('click', () => downloadZip());

/* The files card stepping aside on a desk (features/workbench/files-panel.ts). */
const filesPanel = createFilesPanel({
  storage: () => localStorage,
  workspace: () => $('#page-work .workspace'),
  side: () => $('#side'),
  toggle: () => $('#filesToggle'),
  mobile: () => isMobile(),
  onWork: () => Boolean($('#page-work')?.classList.contains('active')),
  active: () => document.activeElement
});
$('#filesToggle')?.addEventListener('click', () => filesPanel.set(!filesPanel.hidden()));
$('#filesCollapse')?.addEventListener('click', () => filesPanel.set(true));
document.addEventListener('keydown', event => filesPanel.shortcut(event));
window.addEventListener('resize', () => filesPanel.apply());
filesPanel.apply();
const wPath = () => `${state.work.owner}/${state.work.repo}`;

/*
 * Governance at work (features/governance/governance-actions.ts): the Policy
 * Digital Twin read with its delivery evidence and archive, and everything
 * done to a policy's life, its exceptions, notifications, exports and
 * webhooks. An answer for a repository no longer open is dropped.
 */
const governance = createGovernance({
  state,
  mutate: change => pageStore.mutate('governance', change),
  api: (path, init) => api(path, init),
  modal: request => modal(request),
  toast: (message, kind) => toast(message, kind),
  stepUp: (action, scope, path, init, label) => stepUpApi(action, scope, path, init, label),
  $: selector => $(selector),
  doc: document,
  storage: () => localStorage,
  draw: (root, input) => drawGovernance(root, input),
  requestAnimationFrame: run => requestAnimationFrame(run),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: timer => clearTimeout(timer),
  now: () => Date.now(),
  randomId: () => (window.crypto && typeof window.crypto.randomUUID === 'function'
    ? window.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`),
  cssEscape: value => CSS.escape(value)
});
function clearGovernanceState() { governance.clear(); }
function loadGovernanceTwin(force = false) { return governance.load(force); }
/* ---- Exposure ------------------------------------------------------- */

/*
 * The screen leads with what was proven, not with a list.
 *
 * A findings list on its own invites one reading -- "nothing here, so nothing
 * is wrong" -- and that is exactly the conclusion a partial scan does not
 * support. So the proof line and the coverage come first, a partial scan says
 * so in the same breath, and an empty list under partial coverage never reads
 * as an all-clear.
 *
 * Nothing rendered here is built from a credential. The server sends a
 * placeholder, bounded locations and a narration drawn from a lookup table;
 * this file inserts all of it as text, never as markup, because a path is
 * bytes a repository chose and a finding should be safe to put on a screen.
 */

/*
 * The Exposure screen at work (features/exposure/exposure-controller.ts): its
 * findings, history and reports read, a running scan followed, a scan
 * requested and canceled, the two-press checks, the history cleared and an
 * export collected whole. What is drawn stays here until it moves.
 */
const exposureScreen = createExposure({
  state,
  api: (path, options) => api(path, options),
  mutate: change => pageStore.mutate('exposure', change),
  render: () => renderExposure(),
  announce: message => announceExposure(message),
  invalidatePosture: () => invalidatePosture(),
  scopeKey: () => exposureScopeKey(),
  path: () => wPath(),
  shown: () => Boolean($('#tab-exposure')?.classList.contains('active')),
  hidden: () => document.hidden,
  readsHistory: () => { const depth = $('#exposureHistoryToggle'); return depth ? depth.checked : exposureHistoryPreferred(); },
  timers: { set: (run, ms) => setTimeout(run, ms), clear: handle => clearTimeout(handle) },
  now: () => Date.now(),
  download: (name, text, type) => dlFile(name, text, type),
  reports: AuditReports
});
/* The screen's state, made when there is none, read as the page's own slice so the page rules follow it through what is drawn. */
function exposureState() {
  exposureScreen.current();
  return state.exposure;
}

/*
 * The Exposure screen drawn (features/exposure/exposure-view.ts): the proof
 * card and its facts, the history, the toolbar and the findings, and what is
 * said aloud.
 */
const exposureView = createExposureView({
  doc: document,
  $: selector => $(selector),
  current: () => exposureState(),
  work: () => state.work,
  visiting: () => visitingRepository(),
  mutate: change => pageStore.mutate('exposure', change),
  filter: () => filterExposure(),
  loadMore: () => void loadExposure({ append: true, filterOnly: true }),
  historyPreferred: () => exposureHistoryPreferred(),
  timeAgo: iso => timeAgo(iso),
  now: () => Date.now(),
  option: (word, value) => new Option(word, value),
  exportMenu: (run, className, kinds) => AuditScreen.exportMenu(run, className, kinds),
  exportFindings: kind => exportExposure(kind),
  frame: run => requestAnimationFrame(run),
  timers: { set: (run, ms) => setTimeout(run, ms), clear: handle => clearTimeout(handle) }
});
function renderExposure() { exposureView.render(); }
function announceExposure(message) { exposureView.announce(message); }
function exposureScopeKey() { return exposureView.scopeKey(); }

function clearExposureState() { exposureScreen.clear(); }

function exposureHistoryPreferred() { return historyPreferred(() => localStorage); }

function exportExposure(kind) { return exposureScreen.exportFindings(kind); }
function filterExposure() { exposureScreen.filter(); }
function loadExposure(options) { return exposureScreen.load(options); }

governance.wire($('#govRoot'));

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
 * The file tree (features/workbench/file-tree.ts): a folder read and drawn, a
 * folder opened in place, a file opened, the editor told whether there is
 * anything to pick; a reading for another repository, branch or a later read
 * dropped. An entry's menu (features/workbench/item-menu.ts): open, rename,
 * download, protect and delete, heard by that menu alone and carried out on
 * the repository it was opened on.
 */
const itemMenu = createItemMenu({
  doc: document,
  body: () => $('#modalBody'),
  renameTo: () => $('#rnTo2').value,
  modal: request => modal(request),
  closeModal: confirmed => closeModal(confirmed),
  capabilities: body => CapabilityUI.apply(body),
  isProtected: path => isProtectedPath(path),
  work: () => state.work,
  api: (path, options) => api(path, options),
  guardedWrite: extra => guardedWrite(extra),
  rememberHead: commit => rememberHead(commit),
  toast: (message, kind) => toast(message, kind),
  openFile: path => openFile(path),
  fileOpen: () => state.file,
  closeFile: () => closeFile(),
  reloadTree: () => reloadTree(),
  deleteFolder: path => deleteFolderFlow(path),
  moveFolder: path => moveFolderFlow(path),
  toggleProtect: path => toggleProtect(path),
  haptic: ms => hapt(ms),
  timers: { set: (run, ms) => setTimeout(run, ms), clear: handle => clearTimeout(handle) }
});
const fileTree = createFileTree({
  doc: document,
  $: selector => $(selector),
  rows: () => $$('.tree-item'),
  api: path => api(path),
  work: () => state.work,
  visiting: () => visitingRepository(),
  size: bytes => fmtSize(bytes),
  attachMenu: (row, entry) => itemMenu.attach(row, entry),
  openFile: path => openFile(path),
  find: words => { state.pendingFind = words; },
  closeDrawer: () => closeDrawer()
});
function loadTree(dirPath, host, isRoot) { return fileTree.load(dirPath, host, isRoot); }

/* ================= SAFEGUARDS ================= */
/*
 * The safety record and the locked paths (features/safeguards/safety-controller.ts,
 * features/safeguards/protected-paths.ts): read from the server and shown, read
 * as the server reads a lock, and changed through it.
 */
const safety = createSafety({
  api: (path, options) => api(path, options),
  safety: () => state.safety,
  setSafety: value => { state.safety = value; },
  work: () => state.work,
  toast: (message, kind) => toast(message, kind),
  body: () => document.body,
  $: selector => $(selector),
  fileChanged: () => Boolean(state.file && state.file.dirty && !state.file.binary),
  openSafeguards: () => openSafeguards()
});
function safetyKey() { return safety.key(); }
function protectedList() { return safety.list(); }
function isProtectedPath(p) { return safety.isProtected(p); }
function isExactProtectedPath(p) { return safety.isExactProtected(p); }
function refreshSafety() { return safety.refresh(); }
function setSafety(patch) { return safety.set(patch); }
function applySafetyUI() { safety.apply(); }
function dlFile(name, text, type) {
  const a = document.createElement('a');
  a.setAttribute('aria-hidden', 'true');
  a.tabIndex = -1;
  a.href = URL.createObjectURL(new Blob([text], { type: type || 'application/json' }));
  a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
function toggleProtect(p) { return safety.toggleProtect(p); }
/*
 * The repository audit. One result per repository in memory, bound to the
 * identity and branch it was taken for; a result for another repository or a
 * previous session never paints this one. The comparison with the last audit
 * keeps fingerprints only, and the account-boundary purge removes them.
 */
/*
 * The deployed-site check sits beside it, bound to the repository rather than
 * the branch: the address typed (or the repository's declared homepage) is
 * remembered per repository as an origin, and the last check's fingerprints
 * per origin, both under the audit prefix the account purge removes.
 */
function auditKey() { return audit.key(); }
/*
 * The deployed-site check (features/parallax/site-check.ts): the Website
 * page for any address, and the link to it on a repository's audit, drawn
 * again when a check ends.
 */
const siteCheck = createSiteCheck({
  api: path => api(path),
  work: () => state.work,
  epoch: () => state.uiEpoch,
  stored: name => { try { return localStorage.getItem(name); } catch { return null; } },
  store: (name, value) => localStorage.setItem(name, value),
  memory: {
    prefix: AuditMemory.STORE_PREFIX,
    readPrevious: key => AuditMemory.readPrevious(key),
    remember: (key, value) => AuditMemory.remember(key, value),
    diff: (result, previous) => AuditMemory.diff(result, previous)
  },
  decision: () => CapabilityUI.decision('site-check'),
  screen: {
    render: (view, handlers) => AuditScreen.renderSiteScan($('#siteRoot'), view, handlers),
    refuse: reason => {
      const root = $('#siteRoot');
      if (!root) return;
      AuditScreen.clear(root);
      const note = document.createElement('p');
      note.className = 'audit-lede audit-muted';
      note.textContent = reason;
      root.appendChild(note);
    },
    clear: () => AuditScreen.clear($('#siteRoot'))
  },
  rendered: { mount: () => RenderedAudit.mount($('#renderedAuditRoot'), { api, download: dlFile }), dispose: () => RenderedAudit.dispose($('#renderedAuditRoot')) },
  page: () => pages.current(),
  showPage: name => showPage(name),
  showAudit: () => { showPage('work'); switchTab('audit'); },
  repaintAudit: () => repaintAudit(),
  copyPrompt: text => copyPrompt(text),
  copyText: text => navigator.clipboard.writeText(text),
  prompts: result => AuditReports.allPrompts(result),
  toast: (message, kind) => toast(message, kind),
  download: (name, text, type) => dlFile(name, text, type),
  reports: {
    sarif: (result, site, meta) => AuditReports.sarif(result, site, meta),
    csv: (result, site, diff) => AuditReports.csv(result, site, diff),
    brief: (result, label, site) => AuditReports.brief(result, label, site)
  },
  transient: error => transientAuditError(error),
  transientTries: () => AUDIT_POLL.transientTries,
  pause: ms => new Promise(resolve => setTimeout(resolve, ms)),
  now: () => Date.now()
});
function auditSiteLink() { return siteCheck.link(); }
function openParallax(options) { siteCheck.open(options); }
function clearAuditState() { audit.clear(); }
/* A fix prompt onto the clipboard; true once it is there, so the button that asked can say so. */
async function copyPrompt(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    toast('The clipboard is not available here', 'err');
    return false;
  }
}
/*
 * The repository audit's page (features/uranus/audit-controller.ts): its view
 * for the branch open, which it holds, its controls and exports, and an audit
 * run. The kept history and the team's decisions ride on the same view: the
 * audits this identity ran of the branch, which of them is open and what each
 * kept, what has been published about the branch's packages since the latest,
 * and what the team decided.
 */
const audit = createAuditController({
  api: path => api(path),
  work: () => state.work,
  epoch: () => state.uiEpoch,
  provider: () => (state.me && state.me.provider) || 'github',
  forgetHistory: () => auditHistory.forget(),
  forgetWatch: () => auditHistory.forgetWatch(),
  decision: feature => CapabilityUI.decision(feature),
  screen: {
    render: (view, handlers) => AuditScreen.render($('#auditRoot'), view, handlers),
    clear: () => AuditScreen.clear($('#auditRoot')),
    present: () => Boolean($('#auditRoot'))
  },
  shown: () => Boolean($('#tab-audit')?.classList.contains('active')),
  site: { link: () => auditSiteLink(), open: options => openParallax(options) },
  history: {
    load: () => auditHistory.load(),
    watch: options => auditHistory.watch(options),
    detail: id => auditHistory.detail(id),
    clear: () => auditHistory.clear(),
    reveal: id => {
      const details = document.querySelector(`#auditRoot details[data-audit-id="${CSS.escape(id)}"]`);
      if (details) details.scrollIntoView({ block: 'center', behavior: document.documentElement.dataset.motion === 'off' ? 'auto' : 'smooth' });
    }
  },
  triage: { decide: finding => auditTriage.decide(finding), reopen: finding => auditTriage.reopen(finding), history: finding => auditTriage.history(finding) },
  openFinding: finding => auditTriage.open(finding),
  copyPrompt: text => copyPrompt(text),
  copyText: text => navigator.clipboard.writeText(text),
  toast: (message, kind) => toast(message, kind),
  download: (name, text, type) => dlFile(name, text, type),
  reports: AuditReports,
  sbom: AuditSbom,
  memory: AuditMemory,
  offline: error => isOfflineError(error),
  pause: ms => new Promise(resolve => setTimeout(resolve, ms)),
  now: () => Date.now()
});
function rereadAudit() { audit.reread(); }
function paintAudit() { audit.paint(); }
function clearSiteScanState() { siteCheck.clear(); }
function showSiteScan() { siteCheck.show(); }
$('#siteHomeBtn') && $('#siteHomeBtn').addEventListener('click', () => showOverview());
$('#findingsHomeBtn') && $('#findingsHomeBtn').addEventListener('click', () => showOverview());
$('#settingsBtnFindings') && $('#settingsBtnFindings').addEventListener('click', openSettings);
$('#findingsRefresh') && $('#findingsRefresh').addEventListener('click', () => { void loadFindings(true); });

/* ================= FINDINGS INBOX =================
 * Every open finding across the workspace (features/findings), read
 * from GET /api/workspace/findings. Owners come from each repository's
 * CODEOWNERS file, read once per repository and only for the repositories on
 * screen. Decisions go through each repository's own triage route, one finding
 * at a time, so the permissions are the audit screen's own.
 */
const findingsState = {
  inbox: null, filters: null, selected: new Map(), expanded: new Set(), owners: new Map(),
  disposition: 'accepted-risk', progress: '', request: 0, at: 0, deciding: false
};
function findingsOffered() {
  return CapabilityUI.decision('findings.inbox').status === 'Supported';
}
function findingsFiltersFromHash() {
  const route = currentRoute();
  return findingsInbox.parseFilters(route.kind === 'findings' ? route.query : '');
}
function writeFindingsHash() {
  const route = { kind: 'findings', query: findingsInbox.serializeFilters(findingsState.filters) };
  routes.wrote(route);
  writeRoute(route);
}
function clearFindings() {
  findingsState.request++;
  findingsState.inbox = null;
  findingsState.selected.clear();
  findingsState.expanded.clear();
  findingsState.owners.clear();
  findingsState.at = 0;
  findingsState.progress = '';
}
function findingOwners(item) {
  const rules = findingsState.owners.get(`${item.owner}/${item.repo}`.toLowerCase());
  return Array.isArray(rules) ? codeowners.ownersOf(rules, item.path) : [];
}
function loadFindingOwners(items) {
  const wanted = new Map();
  for (const item of items) {
    const key = `${item.owner}/${item.repo}`.toLowerCase();
    if (!findingsState.owners.has(key) && !wanted.has(key)) wanted.set(key, item);
  }
  for (const [key, item] of wanted) {
    findingsState.owners.set(key, 'pending');
    const request = findingsState.request;
    api(`/api/repo/${encodeURIComponent(item.owner)}/${encodeURIComponent(item.repo)}/codeowners`)
      .then(answer => codeowners.revive(answer && answer.rules), () => [])
      .then(rules => {
        if (request !== findingsState.request) return;
        findingsState.owners.set(key, rules);
        if (pages.current() === 'findings') paintFindings();
      });
  }
}
function paintFindings(options = {}) {
  const root = $('#findingsRoot');
  if (!root) return;
  const focused = document.activeElement;
  const keepSearch = options.keepFocus && focused && focused.classList && focused.classList.contains('fi-search');
  const caret = keepSearch ? focused.selectionStart : null;
  const view = findingsInbox.model(findingsState.inbox, findingsState.filters, {
    labelOf: item => (item.source === 'exposure' ? exposureRuleLabel(item.rule) : item.rule),
    ownersOf: findingOwners
  });
  renderFindingsInbox(root, view, findingsState, {
    filter: (patch, opts = {}) => {
      findingsState.filters = { ...findingsState.filters, ...patch };
      writeFindingsHash();
      paintFindings(opts);
    },
    select: (item, on) => {
      if (on) findingsState.selected.set(item.key, item);
      else findingsState.selected.delete(item.key);
      paintFindings();
    },
    clearSelection: () => { findingsState.selected.clear(); findingsState.progress = ''; paintFindings(); },
    expand: (item, open) => { if (open) findingsState.expanded.add(item.key); else findingsState.expanded.delete(item.key); },
    events: (item, host) => { void showFindingDecisions(item, host); },
    open: item => { void openRepositoryTool(item.owner, item.repo, item.source === 'exposure' ? 'exposure' : 'audit'); },
    decide: decision => { void decideFindings(decision); }
  });
  if (keepSearch) {
    const search = root.querySelector('.fi-search');
    if (search) { search.focus(); if (caret !== null) search.setSelectionRange(caret, caret); }
  }
  if (view.state === 'ready') loadFindingOwners(view.shown);
}
async function showFindingDecisions(item, host) {
  if (!host || host.dataset.loaded === 'true') return;
  host.dataset.loaded = 'true';
  try {
    const answer = await api(`/api/repo/${encodeURIComponent(item.owner)}/${encodeURIComponent(item.repo)}/code-audit/findings/${encodeURIComponent(item.id)}/triage-events`);
    const events = Array.isArray(answer.events) ? answer.events : [];
    host.textContent = '';
    if (!events.length) {
      host.appendChild(Object.assign(document.createElement('p'), { textContent: 'Nobody has decided anything about this finding.' }));
      return;
    }
    const list = document.createElement('ol');
    list.className = 'fi-timeline';
    for (const event of events) {
      const entry = document.createElement('li');
      const when = document.createElement('time');
      when.className = 'fi-when';
      when.dateTime = event.at || '';
      when.textContent = auditDay(event.at);
      const what = document.createElement('span');
      what.textContent = `${event.event === 'reopened' ? 'Reopened' : (TRIAGE_EVENT_WORD[event.disposition] || 'Decided')} by ${event.actor}${event.reason ? ` — ${String(event.reason).replace(/-/g, ' ')}` : ''}`;
      entry.append(when, what);
      list.appendChild(entry);
    }
    host.appendChild(list);
  } catch {
    host.dataset.loaded = '';
    host.textContent = '';
    host.appendChild(Object.assign(document.createElement('p'), { textContent: 'The team\u2019s decisions about this finding could not be read here.' }));
  }
}
async function decideFindings(decision) {
  if (findingsState.deciding || !findingsState.selected.size) return;
  findingsState.deciding = true;
  const items = [...findingsState.selected.values()];
  let done = 0;
  const failed = [];
  for (const item of items) {
    findingsState.progress = `Deciding ${done + 1} of ${items.length}…`;
    paintFindings();
    try {
      await api(`/api/repo/${encodeURIComponent(item.owner)}/${encodeURIComponent(item.repo)}/code-audit/findings/${encodeURIComponent(item.id)}/triage`, {
        method: 'POST',
        body: { rule: item.rule, disposition: decision.disposition, reason: decision.reason, ...(decision.expiresInDays ? { expiresInDays: decision.expiresInDays } : {}) }
      });
      done += 1;
      findingsState.selected.delete(item.key);
    } catch (error) {
      failed.push(`${item.owner}/${item.repo}: ${error.message || 'refused'}`);
    }
  }
  findingsState.deciding = false;
  findingsState.progress = failed.length
    ? `${done} decided; ${failed.length} could not be: ${failed.slice(0, 3).join('; ')}${failed.length > 3 ? '…' : ''}`
    : `${done} decided.`;
  if (done) {
    toast(`${done} ${done === 1 ? 'finding' : 'findings'} decided`, 'ok');
    invalidatePosture();
    await loadFindings(true);
  } else paintFindings();
}
async function loadFindings(force) {
  if (!state.me || !findingsOffered()) return;
  if (!force && findingsState.inbox && Date.now() - findingsState.at < POSTURE_TTL_MS) { paintFindings(); return; }
  const request = ++findingsState.request;
  const epoch = state.uiEpoch;
  const identity = state.me;
  const stale = () => request !== findingsState.request || epoch !== state.uiEpoch || identity !== state.me;
  findingsState.at = Date.now();
  if (!findingsState.inbox) paintFindings();
  try {
    const inbox = await api('/api/workspace/findings');
    if (stale()) return;
    findingsState.inbox = inbox && typeof inbox === 'object' ? inbox : { available: false, reason: 'unreadable' };
    /* What was decided elsewhere, or is no longer listed, cannot stay selected. */
    const keys = new Set((findingsState.inbox.findings || []).filter(item => !item.decision).map(item => item.key));
    for (const key of [...findingsState.selected.keys()]) if (!keys.has(key)) findingsState.selected.delete(key);
  } catch (error) {
    if (stale()) return;
    findingsState.at = 0;
    findingsState.inbox = { available: false, reason: isOfflineError(error) ? 'offline' : 'unreadable' };
  }
  paintFindings();
}
function showFindings(filters) {
  if (!findingsOffered()) return toast(CapabilityUI.explain('findings.inbox'), 'err');
  findingsState.filters = filters || findingsState.filters || findingsInbox.parseFilters('');
  showPage('findings');
  writeFindingsHash();
  paintFindings();
  void loadFindings();
}
$('#settingsBtnSite') && $('#settingsBtnSite').addEventListener('click', openSettings);
/*
 * An audit is a job on the server: the first request starts it and answers
 * with a run id, and this asks after it until the result is there, backing
 * off as it goes. A poll lost to the network or to the edge is asked again
 * -- the audit carries on server-side meanwhile -- and a run the server no
 * longer holds (it restarted) is started once more before giving up.
 */
function transientAuditError(error) { return isTransientAudit(error, isOfflineError); }
function runAudit() { return audit.run(); }
/*
 * The kept audits of the branch open, read with the team's decisions, the
 * clocks and the watch over the latest; a kept audit's findings; and the
 * history cleared on a second press (features/uranus/audit-history-controller.ts).
 * Every answer lands in the view drawn for the repository, branch and session
 * it was asked in, and a read let go of never leaves the page waiting on it.
 */
const auditHistory = createAuditHistory({
  api: (path, options) => api(path, options),
  work: () => state.work,
  epoch: () => state.uiEpoch,
  key: () => audit.key(),
  view: () => audit.view(),
  repaint: () => repaintAudit(),
  toast: (message, kind) => toast(message, kind),
  later: (run, ms) => setTimeout(run, ms),
  cancel: timer => clearTimeout(timer),
  now: () => Date.now()
});
function repaintAudit() { audit.repaint(); }
/*
 * The team's decisions about the audit's findings, made from the audit, the
 * audit re-scored after each, and a finding opened in the editor
 * (features/uranus/audit-triage-controller.ts): each for the audit it was
 * made from.
 */
const auditTriage = createAuditTriage({
  api: (path, options) => api(path, options),
  work: () => state.work,
  view: () => audit.view(),
  modal: request => modal(request),
  chosen: () => {
    const picked = document.querySelector('#modalBody input[name="triageDisposition"]:checked');
    return { disposition: picked ? picked.value : '', reason: ($('#triageReason') || {}).value || '', days: ($('#triageDays') || {}).value || '' };
  },
  paint: () => paintAudit(),
  metrics: () => auditHistory.metrics(),
  toast: (message, kind) => toast(message, kind),
  now: () => Date.now(),
  showEditor: () => switchTab('editor'),
  openFile: path => openFile(path),
  editor: () => state.cm || null
});
/*
 * A recovery snapshot taken, and branches restored from one
 * (features/safeguards/snapshot-recovery.ts): each for the repository it was
 * started on.
 */
const snapshotRecovery = createSnapshotRecovery({
  api: (path, options) => api(path, options),
  work: () => state.work,
  stored: name => { try { return localStorage.getItem(name); } catch { return null; } },
  store: (name, value) => { try { localStorage.setItem(name, value); } catch {} },
  modal: options => modal(options),
  value: selector => { const input = $(selector); return input ? input.value : null; },
  toast: (message, kind) => toast(message, kind),
  download: (name, text, type) => dlFile(name, text, type),
  snapshotTaken: () => { invalidatePosture(); if (currentTab() === 'safeguards') renderSafeguards(); },
  restored: () => { repositoryHeader.refresh().catch(() => {}); reloadTree(); }
});
function snapshotFlow() { return snapshotRecovery.snapshot(); }
/*
 * A repository's activity and its evidence package exported
 * (features/safeguards/repository-exports.ts): each for the repository it was
 * asked of, its files named for it.
 */
const repositoryExports = createRepositoryExports({
  api: path => api(path),
  work: () => state.work,
  modal: options => modal(options),
  toast: (message, kind) => toast(message, kind),
  present: error => presentError(error),
  download: (name, text, type) => dlFile(name, text, type),
  csv: activity => ExportSafety.activityCsv(activity),
  now: () => Date.now()
});
function exportActivityFlow() { return repositoryExports.activity(); }
function exportEvidenceFlow() { return repositoryExports.evidence(); }
function recoveryFlow() { return snapshotRecovery.recover(); }

/*
 * The security scan (features/safeguards/security-scan.ts): a branch's
 * dependencies and the upload gate, reported on the branch it was asked of.
 */
const securityScan = createSecurityScan({
  api: path => api(path),
  work: () => state.work,
  modal: options => modal(options),
  toast: (message, kind) => toast(message, kind)
});
function securityScanFlow() { return securityScan.scan(); }
/*
 * Every file path of the open branch, read once for the palette and Safeguards
 * (features/workbench/file-index.ts).
 */
const fileIndex = createFileIndex({
  api: path => api(path),
  work: () => state.work,
  held: () => state.fileIndex,
  hold: files => { state.fileIndex = files; }
});
/*
 * Safeguards (features/safeguards/safeguards-screen.ts, safeguards-view.ts): the
 * posture, this app's switches beside the provider's rules, the locked paths
 * with their presets, and the recovery tools, drawn for the repository open.
 */
const safeguards = createSafeguards({
  root: () => $('#safeguardsRoot'),
  work: () => state.work,
  record: () => state.safety,
  safety,
  files: () => fileIndex.load(),
  api: path => api(path),
  toast: (message, kind) => toast(message, kind),
  ago: iso => timeAgo(iso),
  stored: name => { try { return localStorage.getItem(name); } catch { return null; } },
  capabilities: root => CapabilityUI.apply(root),
  flows: {
    snapshot: () => snapshotFlow(),
    recover: () => recoveryFlow(),
    scan: () => securityScanFlow(),
    activity: () => exportActivityFlow(),
    evidence: () => exportEvidenceFlow()
  },
  activeElement: () => document.activeElement,
  focusFree: () => !document.activeElement || document.activeElement === document.body,
  escapeSelector: value => CSS.escape(value),
  now: () => Date.now()
});
/*
 * Safeguards is a section of the workbench, not a dialog over it: a reader
 * working through Audit and Exposure reaches it the same way, its address is
 * a place Back returns to, and changing a lock redraws it in place rather
 * than closing and reopening a window. Every entry point lands here.
 */
function openSafeguards() {
  if (!state.work || visitingRepository()) return pickRepository('safeguards', { own: true });
  if (pages.current() !== 'work') showPage('work');
  switchTab('safeguards');
}
function renderSafeguards(options) { return safeguards.render(options); }
/*
 * A folder moved or deleted from its menu (features/workbench/folder-flows.ts),
 * and the repository deleted (features/repositories/repository-deletion.ts):
 * each for the repository and branch it was asked on.
 */
const folderFlows = createFolderFlows({
  api: (path, options) => api(path, options),
  work: () => state.work,
  modal: options => modal(options),
  value: selector => { const input = $(selector); return input ? input.value : null; },
  toast: (message, kind) => toast(message, kind),
  remember: (work, branch, commit) => { if (state.work === work) rememberHead(commit, branch); },
  reloadTree: () => reloadTree(),
  productName: NV_PRODUCT_NAME
});
const repositoryDeletion = createRepositoryDeletion({
  work: () => state.work,
  me: () => state.me,
  modal: options => modal(options),
  value: selector => { const input = $(selector); return input ? input.value : null; },
  toast: (message, kind) => toast(message, kind),
  stepUp: (action, scope, path, options, label) => stepUpApi(action, scope, path, options, label),
  present: error => presentError(error),
  forget: (owner, repo) => forgetRepository(() => localStorage, owner, repo),
  showRepositories: () => showPage('repos'),
  loadRepositories: () => loadRepos(true)
});
function moveFolderFlow(dirPath) { return folderFlows.move(dirPath); }
function deleteFolderFlow(dirPath) { return folderFlows.remove(dirPath); }
function deleteRepoFlow() { return repositoryDeletion.remove(); }

/*
 * Code search (features/workbench/file-tree.ts): the paths whose contents
 * match, in the tree's place, each opening its file with the words to find.
 */
$('#codeSearch').addEventListener('keydown', e => {
  if (e.key === 'Enter') fileTree.search(e.target.value, $('#tree'));
});

/* ---------------- editor ---------------- */
const IMG_EXT = ['png','jpg','jpeg','gif','webp','svg','ico'];
const VID_EXT = ['mp4','webm'];
const extOf = p => (p.split('.').pop() || '').toLowerCase();

function ensureCM() {
  if (state.cm) return state.cm;
  state.cm = CodeMirror($('#editorHost'), {
    value: '', lineNumbers: true, theme: state.settings.editorTheme,
    lineWrapping: !!state.settings.wrap, viewportMargin: 50,
    readOnly: visitingRepository()
  });
  /*
   * On a phone the editor runs down behind the bottom navigation until the
   * page is scrolled to its end, and CodeMirror only knows its own box: a
   * cursor moved to the last line, a search hit or a jump to a line landed
   * under the navigation, where it could not be seen or tapped. After any
   * cursor move, a cursor that sits under the navigation is scrolled clear
   * of it, inside the editor.
   */
  state.cm.on('cursorActivity', cm => requestAnimationFrame(() => keepCursorClearOfNav(cm)));
  state.cm.on('change', () => {
    if (state.file && !state.file.binary && !state.file._loading) {
      pageStore.mutate('file', file => { file.dirty = true; });
      $('#commitFileBtn').disabled = false;
      $('#stageFileBtn').disabled = false;
      $('#diffBtn').disabled = false;
      saveDraft();
    }
  });
  // A restored route can open its file while the view transition still hides
  // the workspace. Refresh when its host actually acquires a laid-out size;
  // a fixed 30 ms delay can leave CodeMirror blank in WebKit after reload.
  const editor = state.cm;
  let measuredWidth = 0, measuredHeight = 0, refreshFrame = 0;
  const editorSize = new ResizeObserver(entries => {
    const { width, height } = entries[0].contentRect;
    if (width === measuredWidth && height === measuredHeight) return;
    measuredWidth = width; measuredHeight = height;
    cancelAnimationFrame(refreshFrame);
    if (width > 0 && height > 0) refreshFrame = requestAnimationFrame(() => editor.refresh());
  });
  editorSize.observe($('#editorHost'));
  return state.cm;
}

function keepCursorClearOfNav(cm) {
  const nav = $('#bottomNav');
  /* offsetParent is always null for a fixed element; a laid-out box is the test. */
  if (!nav || !nav.getClientRects().length) return;
  const limit = nav.getBoundingClientRect().top - 12;
  const cursor = cm.cursorCoords(null, 'window');
  if (cursor.bottom <= limit) return;
  const info = cm.getScrollInfo();
  cm.scrollTo(null, Math.min(info.height - info.clientHeight, info.top + (cursor.bottom - limit)));
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
      pageStore.mutate('file', file => { file.sha = meta.sha; }); $('#fileSize').textContent = fmtSize(meta.size);
    } catch {}
    return;
  }

  const cm = ensureCM();
  cm.setValue('Loading…');
  try {
    const f = await api(`/api/repo/${wPath()}/file?ref=${encodeURIComponent(w.branch)}&path=${encodeURIComponent(p)}`);
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
    pageStore.mutate('file', file => {
      file._loading = false;
      file.dirty = false;
    });
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

/*
 * Markdown a provider sends -- a pull request's description, an issue, a
 * comment, release notes -- rendered the way the file preview renders it:
 * parsed by marked, then sanitised by DOMPurify with forms, frames and
 * embeds forbidden. Links open in a new tab without an opener. Both libraries
 * are imported by this module, so no page draws Markdown without them.
 */
const MD_SANITIZE = Object.freeze({ USE_PROFILES: { html: true }, FORBID_TAGS: ['form', 'iframe', 'object', 'embed', 'style'], FORBID_ATTR: ['srcdoc', 'style'] });
function renderMarkdownInto(el, source) {
  el.classList.add('md-body');
  const text = String(source || '');
  el.innerHTML = DOMPurify.sanitize(marked.parse(text), MD_SANITIZE);
  el.querySelectorAll('a[href]').forEach(a => { a.target = '_blank'; a.rel = 'noopener noreferrer nofollow'; });
}
$('#mdPreviewBtn').addEventListener('click', () => {
  const pv = $('#mdPreview');
  const showing = !pv.hidden;
  pv.hidden = showing;
  $('#editorHost').style.display = showing ? '' : 'none';
  $('#mdPreviewBtn').textContent = showing ? 'Preview' : 'Edit';
  if (!showing) {
    const source = state.cm.getValue();
    /* The same rules as provider text: a file's <style> or inline style would restyle the workbench around it. */
    pv.innerHTML = DOMPurify.sanitize(marked.parse(source), MD_SANITIZE);
    pv.querySelectorAll('a[href]').forEach(a => { a.target = '_blank'; a.rel = 'noopener noreferrer nofollow'; });
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
  /* Read while the dialog that holds it is the one on the page: the overwrite question and Safe Passage each replace it. */
  const typedMessage = $('#cmMsg') ? $('#cmMsg').value : undefined;
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
        pageStore.mutate('file', file => { file.sha = remote.sha; });
        await refreshRepoMetadata();
      }
    } catch {}
    const out = await api(`/api/repo/${wPath()}/file`, {
      method: 'PUT',
      body: guardedWrite({ path: state.file.path, content: state.cm.getValue(), message: typedMessage || undefined, branch: state.work.branch, sha: state.file.sha })
    });
    rememberHead(out.commit);
    pageStore.mutate('file', file => {
      file.sha = out.sha;
      file.dirty = false;
    });
    $('#commitFileBtn').disabled = true; $('#stageFileBtn').disabled = true;
    pageStore.mutate('file', file => { file.original = state.cm.getValue(); });
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
      message: typedMessage,
      sha: state.file.sha
    });
    if (routed) return;
    const queued = await queueCommit({
      kind: 'put', owner: state.work.owner, repo: state.work.repo, branch: state.work.branch,
      path: state.file.path, content: state.cm.getValue(),
      message: typedMessage, sha: state.file.sha,
      expectedHeadSha: currentHeadSha()
    }, e);
    if (queued) { pageStore.mutate('file', file => { file.dirty = false; }); $('#commitFileBtn').disabled = true; }
    else presentError(e);
  }
});

$('#stageFileBtn').addEventListener('click', () => {
  if (!state.file || state.file.binary) return;
  addStaged({ op: 'put', path: state.file.path, content: state.cm.getValue() });
  pageStore.mutate('file', file => { file.dirty = false; });
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
      <input id="rnTo" type="text" value="${escAttr(state.file.path)}" autocapitalize="off" autocorrect="off" spellcheck="false">
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
  const ownsModal = modalOwner();
  try {
    const commits = await api(`/api/repo/${wPath()}/commits?ref=${encodeURIComponent(state.work.branch)}&path=${encodeURIComponent(p)}`);
    if (!ownsModal()) return;
    $('#modalBody').innerHTML = commits.length ? commits.map(c => `
      <div class="comment">
        <div class="comment-head"><span class="mono commit-sha">${esc(String(c.sha || '').slice(0, 7))}</span><span>${esc(c.author)}</span><span>${timeAgo(c.date)}</span></div>
        <div class="comment-body">${esc(c.message.split('\n')[0])}</div>
      </div>`).join('') : '<p class="hint">No history found for this path.</p>';
  } catch (e) { if (ownsModal()) $('#modalBody').innerHTML = `<p class="hint">⚠ ${esc(e.message)}</p>`; }
});

$('#newFileBtn').addEventListener('click', async () => {
  if (!state.work) return;
  const scope = `${wPath()}@${state.work.branch}`;
  const epoch = state.uiEpoch;
  const ok = await modal({
    title: 'New file',
    bodyHTML: `<label class="field-label" for="nfPath">Path</label><input id="nfPath" type="text" placeholder="docs/notes.md" autocapitalize="off" autocorrect="off" spellcheck="false">
      <p class="hint">Creates an empty file in your staged changes. Review the diff, repository and branch before committing; nothing is sent yet.</p>`,
    okText: 'Stage file'
  });
  if (!ok) return;
  if (!state.work || epoch !== state.uiEpoch || scope !== `${wPath()}@${state.work.branch}`) {
    return toast('The repository changed. Open New file again for the intended branch.', 'err');
  }
  const p = $('#nfPath').value.trim().replace(/^\/+/, '');
  if (!p) return;
  addStaged({ op: 'put', path: p, content: '', newFile: true });
  toast(`New file ${p} staged for review`);
  closeDrawer();
  openStagePanel();
});

/* ================= STAGED CHANGES ================= */
function addStaged(op) {
  state.staged = state.staged.filter(s => s.path !== op.path);
  pageStore.mutate('staged', staged => { staged.push(op); });
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
      pageStore.mutate('staged', staged => { staged.splice(i, 1); }); renderStagedCount(); renderStagedPanel();
    });
    host.appendChild(el);
  });
}
/*
 * The panel takes keyboard focus when it opens -- on its commit control when
 * there is something to review, else on its close control -- and hands it
 * back when it closes, so Tab never walks the page hidden behind it.
 */
let stageReturnFocus = null;
function openStagePanel() {
  const panel = $('#stageScrim');
  if (!overlayOpen(panel)) {
    const active = document.activeElement;
    stageReturnFocus = active && active !== document.body && !$('#scrim').contains(active) ? active : null;
  }
  renderStagedPanel();
  openOverlay(panel);
  (state.staged.length ? $('#stageCommitBtn') : $('#stageClose')).focus({ preventScroll: true });
}
function closeStagePanel() {
  const panel = $('#stageScrim');
  const held = panel.contains(document.activeElement);
  closeOverlay(panel);
  const restore = stageReturnFocus;
  stageReturnFocus = null;
  if (held && restore && restore.isConnected && !restore.closest('[hidden], [inert]')) restore.focus({ preventScroll: true });
}
$('#stagedBtn').addEventListener('click', openStagePanel);
$('#stageClose').addEventListener('click', closeStagePanel);
$('#stageScrim').addEventListener('click', e => { if (e.target === $('#stageScrim')) closeStagePanel(); });
/* The preview reads the exact expected commit, never a moving branch name.
 * Missing files are allowed only for puts; failures and unrenderable content
 * stop review rather than being presented as an empty original. */
async function previewStagedChanges(scope, ops) {
  const previews = [];
  let previewBytes = 0;
  let previewLines = 0;
  for (const op of ops) {
    let remote = null;
    try {
      remote = await api(`/api/repo/${scope.path}/file?ref=${encodeURIComponent(scope.head)}&path=${encodeURIComponent(op.path)}`);
    } catch (error) {
      if (error.status !== 404 || op.op !== 'put') throw error;
    }
    if (op.newFile && remote) throw new Error(`${op.path} already exists. Open it in the editor to stage an update instead.`);
    if (remote && (remote.tooLarge || remote.lfs || remote.binary || typeof remote.content !== 'string')) {
      throw new Error(`${op.path} cannot be previewed as text here. Review it with a tool that supports this file before committing.`);
    }
    const before = remote ? b64ToUtf8(remote.content) : '';
    const after = op.op === 'delete' ? '' : op.content;
    previewBytes += before.length + after.length;
    if (previewBytes > 2 * 1024 * 1024 || before.includes('\0') || after.includes('\0')) {
      throw new Error('This staged diff is too large or contains binary content. Split it into smaller text changes for review.');
    }
    const beforeLines = before ? before.split('\n') : [];
    const afterLines = after ? after.split('\n') : [];
    previewLines += beforeLines.length + afterLines.length;
    if (previewLines > 10000) throw new Error('This staged diff has too many lines to review here. Split it into smaller changes.');
    const lines = lineDiff(beforeLines, afterLines);
    const changed = lines.some(line => line[0] !== ' ');
    const description = !remote ? (after ? 'Create file' : 'Create empty file')
      : op.op === 'delete' ? 'Delete file' : changed ? 'Update file' : 'No content changes';
    /* A file with no lines to show is described once, not again as an empty patch. */
    const patch = changed ? `<pre class="diff-patch mono">${lines.map(([tag, line]) =>
      `<span class="${tag === '+' ? 'add' : tag === '-' ? 'del' : ''}">${esc(tag + ' ' + line)}</span>`).join('')}</pre>` : '';
    previews.push({ op, sha: remote && remote.sha,
      html: `<section class="stage-preview-file"><h3 class="mono">${esc(op.path)}</h3><p class="stage-preview-kind">${description}</p>${patch}</section>` });
  }
  return previews;
}

$('#stageCommitBtn').addEventListener('click', async () => {
  if (!state.work || !state.staged.length) return toast('Nothing staged', 'err');
  const scope = { path: wPath(), owner: state.work.owner, repo: state.work.repo,
    branch: state.work.branch, head: currentHeadSha(), epoch: state.uiEpoch, identity: state.me };
  if (!scope.head) return toast('Refresh repository metadata before reviewing changes; the expected commit is unavailable.', 'err');
  const staged = JSON.stringify(state.staged);
  const ops = state.staged.map(op => ({ ...op }));
  const current = () => state.work && scope.path === wPath() && scope.branch === state.work.branch &&
    scope.head === currentHeadSha() && scope.epoch === state.uiEpoch && scope.identity === state.me && staged === JSON.stringify(state.staged);
  const msg = $('#stageMsg').value.trim() || (ops.length === 1 && ops[0].newFile
    ? `Create ${ops[0].path} via ${NV_PRODUCT_NAME}` : `Batch commit (${ops.length} changes) via ${NV_PRODUCT_NAME}`);
  const button = $('#stageCommitBtn');
  button.disabled = true;
  button.textContent = 'Preparing review…';
  let queuedOperation = null;
  try {
    const preview = await previewStagedChanges(scope, ops);
    if (!current()) throw new Error('The staged changes or repository changed. Review the current changes again.');
    const ok = await modal({
      title: 'Review staged changes', wide: true,
      bodyHTML: `<dl class="stage-review-facts">
          <dt>Repository</dt><dd>${esc(scope.owner)}/${esc(scope.repo)}</dd>
          <dt>Branch</dt><dd>${esc(scope.branch)}</dd>
          <dt>Expected commit</dt><dd><code class="stage-preview-head mono">${esc(scope.head)}</code></dd>
          <dt>Message</dt><dd>${esc(msg)}</dd>
        </dl>${preview.map(item => item.html).join('')}
        <p class="hint">Commit only if these changes match your intent. A moved branch head is refused by the server.</p>`,
      okText: `Commit ${ops.length} ${ops.length === 1 ? 'change' : 'changes'}`
    });
    if (!ok) return;
    await ensureCsrfToken();
    if (!current()) throw new Error('The reviewed repository, head or staged changes changed. Review again before committing.');
    const common = { branch: scope.branch, message: msg, expectedHeadSha: scope.head };
    let out;
    if (ops.length === 1 && ops[0].op === 'put') {
      const op = ops[0];
      const body = { ...common, path: op.path, content: op.content, ...(preview[0].sha ? { sha: preview[0].sha } : {}) };
      queuedOperation = { kind: 'put', owner: scope.owner, repo: scope.repo, ...body };
      out = await api(`/api/repo/${scope.path}/file`, { method: 'PUT', body });
    } else {
      const body = { ...common, ops: ops.map(op => op.op === 'put'
        ? { op: 'put', path: op.path, content: op.content } : { op: 'delete', path: op.path }) };
      queuedOperation = { kind: 'batch', owner: scope.owner, repo: scope.repo, ...body };
      out = await api(`/api/repo/${scope.path}/batch`, { method: 'POST', body });
    }
    if (!current()) return;
    rememberHead(out.commit, scope.branch);
    toast(ops.length === 1 && ops[0].newFile ? `Created ${ops[0].path} ✦`
      : `✦ ${ops.length} changes committed as ${String(out.commit).slice(0, 7)}`, 'ok');
    state.staged = []; $('#stageMsg').value = '';
    renderStagedCount(); closeStagePanel();
    state.fileIndex = null;
    loadTree('', $('#tree'), true);
    refreshRate();
  } catch (error) {
    const queued = queuedOperation && current() && await queueCommit(queuedOperation, error);
    if (queued) { state.staged = []; renderStagedCount(); renderStagedPanel(); }
    else presentError(error);
  } finally {
    button.disabled = false;
    button.textContent = 'Review staged changes';
  }
});

/* ================= NAVIGATION (adaptive) ================= */
function currentTab() { const t = $('.tab.active'); return t ? t.dataset.tab : 'editor'; }
/* the Neural module is 60 KB — it loads the first time you open the tab, not on every visit.
   It is its own chunk of the build, which the service worker precaches, so that first open
   is instant and works offline too. */
/* The loaded module, once the tab has asked for it. */
let neural = null;
let _neuralLoad = null;
function ensureNeural() {
  if (neural) { neural.activate(); return; }
  if (!_neuralLoad) {
    _neuralLoad = import('../visualizations/neural.js').then(module => { neural = module.default; return neural; }, () => {
      _neuralLoad = null;
      throw new Error('Neural module could not load');
    });
  }
  _neuralLoad.then(nn => { if (nn && currentTab() === 'neural') nn.activate(); })
    .catch(e => toast(e.message, 'err'));
}
/*
 * On a phone the document scrolls, not the pane, so a tab change kept the
 * last tab's offset and dropped the reader into the middle of the next list.
 * Each tab of each repository keeps its own offset instead, as the panes do
 * on a wider screen.
 */
const tabScroll = new Map();
const tabScrollKey = name => `${state.work ? `${state.work.owner}/${state.work.repo}@${state.work.branch}` : ''}:${name}`;
function switchTab(name) {
  const tab = $$('.tab').find(candidate => candidate.dataset.tab === name);
  const previousTab = currentTab();
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
  /* A deep link to a collaborator's tab on a repository opened read-only lands in the editor instead of on a hidden pane. */
  if (visitingRepository() && VISITOR_TABS.has(name)) return switchTab('editor');
  const tabCapability = tab.dataset.feature;
  if (tabCapability && !runCapabilityAction(tabCapability, () => {})) return;
  const doc = document.scrollingElement;
  const moving = previousTab !== name && doc;
  if (moving) tabScroll.set(tabScrollKey(previousTab), doc.scrollTop);
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  $$('.tabpane').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name));
  if (moving) doc.scrollTop = tabScroll.get(tabScrollKey(name)) || 0;
  /*
   * The pane knows which tab it holds, so chrome that belongs to some tabs and
   * not others -- the repository trust bar is the workbench's, and the Neural
   * view carries the same reading in its own header -- is decided by the
   * stylesheet rather than toggled element by element here.
   */
  const pane = $('.main-pane');
  if (pane) pane.dataset.tab = name;
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
  if (name === 'exposure') loadExposure();
  else exposureScreen.stopPoll();
  if (name === 'audit') paintAudit();
  if (name === 'safeguards') renderSafeguards();
  if (name === 'neural') ensureNeural();
  else if (neural) neural.deactivate();
  if (name === 'editor' && state.cm) setTimeout(() => state.cm.refresh(), 30);
  saveRoute(previousTab !== name);
}
$$('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));

/*
 * The Exposure screen's controls (features/exposure/exposure-controls.ts):
 * scan, retry, cancel, open all, clear and older scans, the history-depth
 * preference, and the lists' disclosures, presses and typed questions.
 */
bindExposureControls({
  $: selector => $(selector),
  current: () => exposureState(),
  mutate: change => pageStore.mutate('exposure', change),
  tally: current => exposureView.tally(current),
  request: () => exposureScreen.request(),
  refreshScan: () => exposureScreen.refreshScan(),
  load: options => loadExposure(options),
  cancel: () => exposureScreen.cancel(),
  toggleAll: () => exposureScreen.toggleAll(),
  clearHistory: () => exposureScreen.clearHistory(),
  loadHistory: options => exposureScreen.loadHistory(options),
  loadReport: scanId => exposureScreen.loadReport(scanId),
  verify: fingerprint => exposureScreen.verify(fingerprint),
  accept: fingerprint => exposureScreen.accept(fingerprint),
  probe: fingerprint => exposureScreen.probe(fingerprint),
  remember: (key, value) => localStorage.setItem(key, value),
  isDisclosure: target => target instanceof HTMLDetailsElement
});

$('#bottomNav').addEventListener('click', e => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const nav = btn.dataset.nav;
  if (nav === 'files') return openDrawer();
  if (nav === 'more') return openSheet();
  switchTab(nav);
});
function openDrawer() { $('#side').classList.add('open'); openOverlay($('#sideScrim')); }
function closeDrawer() { if (isMobile()) { $('#side').classList.remove('open'); closeOverlay($('#sideScrim')); } }
$('#sideScrim').addEventListener('click', closeDrawer);

function openSheet() { openOverlay($('#sheetScrim')); }
function closeSheet() { closeOverlay($('#sheetScrim')); }
$('#sheetScrim').addEventListener('click', e => { if (e.target === $('#sheetScrim')) closeSheet(); });
$('#sheetClose') && $('#sheetClose').addEventListener('click', closeSheet);
$('#sheet').addEventListener('click', e => {
  const item = e.target.closest('.sheet-item');
  if (!item) return;
  runCapabilityAction(item.dataset.feature, () => {
    closeSheet();
    const act = item.dataset.act;
    if (['pulls', 'issues', 'releases', 'compare', 'actions', 'neural', 'governance', 'exposure', 'audit', 'safeguards'].includes(act)) switchTab(act);
    else if (act === 'site') showSiteScan();
    else if (act === 'palette') openPalette();
    else if (act === 'zip') downloadZip();
    else if (act === 'branches') openBranchManager();
    else if (act === 'delrepo') deleteRepoFlow();
    else if (act === 'theme') toggleTheme();
    else if (act === 'settings') openSettings();
  });
});

/* ================= COMMAND PALETTE ================= */
let palSel = 0, palItems = [];
const COMMANDS = [
  { label: 'New file', kind: 'action', feature: 'file.write', run: () => $('#newFileBtn').click() },
  { label: 'New branch', kind: 'action', feature: 'branches.write', run: () => $('#newBranchBtn').click() },
  { label: 'Push files (upload)', kind: 'view', feature: 'native-push', run: () => switchTab('upload') },
  { label: 'Pull requests', kind: 'view', feature: 'pulls.read', run: () => switchTab('pulls') },
  { label: 'Issues', kind: 'view', feature: 'issues.read', run: () => switchTab('issues') },
  { label: 'Releases', kind: 'view', feature: 'releases.read', run: () => switchTab('releases') },
  { label: 'Compare branches', kind: 'view', feature: 'recovery', run: () => switchTab('compare') },
  { label: 'Commits', kind: 'view', feature: 'repository.read', run: () => switchTab('commits') },
  { label: 'Staged changes', kind: 'view', feature: 'file.batch', run: () => openStagePanel() },
  { label: 'Download repo as zip', kind: 'action', feature: 'repository.read', run: () => downloadZip() },
  { label: 'Settings', kind: 'action', run: () => openSettings() },
  { label: 'Safeguards (read-only, protection, recovery)', kind: 'action', feature: 'recovery', run: () => openSafeguards() },
  { label: 'Emergency recovery snapshot', kind: 'action', feature: 'recovery', run: () => snapshotFlow() },
  { label: 'Security scan — vulnerable dependencies', kind: 'action', feature: 'dependency-audit', run: () => securityScanFlow() },
  { label: 'Export recent activity', kind: 'action', feature: 'repository.read', run: () => exportActivityFlow() },
  { label: 'Toggle theme', kind: 'action', run: () => toggleTheme() },
  { label: 'Actions (CI)', kind: 'view', feature: 'workflows.read', run: () => switchTab('actions') },
  { label: 'Neural', kind: 'view', feature: 'access-surface', run: () => switchTab('neural') },
  /*
   * Governance had no palette entry at all, while every other destination in
   * the workbench had one -- so the one surface that is also hardest to see in
   * the tab strip was the one a reader could not jump to by name either.
   */
  { label: 'Governance', kind: 'view', feature: 'governance', run: () => switchTab('governance') },
  { label: 'Exposure', kind: 'view', feature: 'exposure.scan', run: () => switchTab('exposure') },
  { label: 'Audit — code and site scanner', kind: 'view', feature: 'site-check', run: () => switchTab('audit') },
  { label: 'Manage branches', kind: 'action', feature: 'branches.write', run: () => openBranchManager() },
  { label: 'Star / unstar this repo', kind: 'action', feature: 'stars.write', run: () => toggleStar() },
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
  if (pages.current() !== 'work') return;
  paletteReturnFocus = document.activeElement;
  openOverlay($('#paletteScrim'));
  anchorOverlayOrigin($('#palette'), paletteReturnFocus);
  const inp = $('#paletteInput');
  inp.value = ''; renderPalette('');
  setTimeout(() => inp.focus({ preventScroll: true }), 50);
  if (!state.fileIndex && (await fileIndex.load()) && overlayOpen($('#paletteScrim'))) renderPalette(inp.value);
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
  closeOverlay(scrim);
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
/*
 * How well a query names a path: the file's own name before its folders, a
 * run of the query before scattered letters, the start of a word before its
 * middle, and a short path before a long one. -1 when it does not match.
 */
function fuzzyScore(q, s) {
  const query = String(q || '').toLowerCase();
  const text = String(s || '').toLowerCase();
  if (!query) return 0;
  const base = text.slice(text.lastIndexOf('/') + 1);
  let score = -1;
  if (base === query) score = 1000;
  else if (base.startsWith(query)) score = 800;
  else if (base.includes(query)) score = 650;
  else if (text.startsWith(query) || text.includes(`/${query}`)) score = 520;
  else if (text.includes(query)) score = 420;
  else {
    /* Letters in order: fewer, shorter gaps score higher. */
    let at = -1; let gaps = 0;
    for (const ch of query) {
      const next = text.indexOf(ch, at + 1);
      if (next === -1) return -1;
      if (at !== -1 && next > at + 1) gaps += Math.min(8, next - at - 1);
      at = next;
    }
    score = 200 - gaps * 4;
  }
  return score - Math.min(60, text.length / 4);
}
function renderPalette(q) {
  const host = $('#paletteList');
  /* A command for something that is not Supported is not offered, so the selection never lands on what is not drawn. */
  const cmds = COMMANDS.filter(c => fuzzy(q, c.label) && !(c.feature && CapabilityUI.withheld(c.feature)));
  const files = (state.fileIndex || [])
    .map(p => [p, fuzzyScore(q, p)]).filter(([, score]) => score > -1)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, q ? 30 : 14)
    .map(([p]) => ({ label: p, kind: 'file', run: () => openFile(p) }));
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
    el.innerHTML = `<span class="${it.kind === 'file' ? 'mono' : ''}"></span><span class="pal-kind">${esc(it.kind)}</span>`;
    el.querySelector('span').textContent = it.label;
    if (it.feature) el.dataset.feature = it.feature;
    el.addEventListener('click', () => runPaletteItem(it));
    host.appendChild(el);
  });
  input.setAttribute('aria-expanded', 'true');
  input.setAttribute('aria-activedescendant', `pal-option-${palSel}`);
  CapabilityUI.apply(host);
}
function runPaletteItem(item) {
  return runCapabilityAction(item && item.feature, () => {
    closePalette();
    item.run();
  });
}
$('#reposSummaryToggle').addEventListener('click', () => {
  const expanded = $('#reposSummaryToggle').getAttribute('aria-expanded') !== 'true';
  $('#reposSummaryToggle').setAttribute('aria-expanded', String(expanded));
  $('#reposPulse').dataset.expanded = String(expanded);
});
$('#reposRefreshBtn').addEventListener('click', () => loadRepos(true));

/*
 * The rail is chrome around the screens, so it follows them rather than each
 * screen carrying a copy. It appears once a session is authenticated and marks
 * the screen in view as current, which is what a reader navigating by landmark
 * relies on to know where they are.
 */
function paintRail(name) { rail.paint(name); }
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
function closeNavMenu() { rail.closeMenu(); }
$$('.nav-menu-btn').forEach(button => button.addEventListener('click', () => {
  rail.setMenu(!rail.menuOpen(), button);
}));
$('#navScrim') && $('#navScrim').addEventListener('click', closeNavMenu);
$('#navClose') && $('#navClose').addEventListener('click', closeNavMenu);
/* A drawer follows the finger that closes it (features/shell/rail.ts). */
(function drawerSwipe() {
  const drawer = $('#navRail');
  if (!drawer) return;
  drawer.addEventListener('touchstart', event => rail.dragStart([...event.touches]), { passive: true });
  drawer.addEventListener('touchmove', event => { if (event.touches[0]) rail.dragMove(event.touches[0]); }, { passive: true });
  drawer.addEventListener('touchend', () => rail.dragEnd());
  drawer.addEventListener('touchcancel', () => rail.dragEnd());
})();
document.addEventListener('keydown', event => { if (rail.onKey(event.key)) event.preventDefault(); });
window.addEventListener('resize', () => rail.onResize());

$$('.nv-rail-item').forEach(item => item.addEventListener('click', () => {
  const target = item.dataset.rail;
  closeNavMenu();
  if (target === 'overview') return showOverview();
  if (target === 'repos') return showPage('repos');
  if (target === 'findings') return showFindings();
  if (target === 'site') return siteCheck.openFromRail();
  /* A repository still opening is the one the tool is for: it lands there once it answers. */
  if (!state.work && state.opening) {
    const opening = repositoryOpener.generation();
    return state.opening.then(() => {
      if (opening !== repositoryOpener.generation() || !state.work) return;
      if (isRepositoryTool(target)) switchTab(target);
    });
  }
  if (!state.work) return pickTool(target) ? pickRepository(target) : toast('Open a repository first.', 'err');
  /* Governance and Safeguards belong to a repository's collaborators: with somebody else's open, they ask which of yours. */
  if (visitingRepository() && VISITOR_TABS.has(target)) return pickRepository(target, { own: true });
  showPage('work');
  if (isRepositoryTool(target)) switchTab(target);
  else paintRail('work');
}));
$('#paletteInput').addEventListener('input', e => renderPalette(e.target.value));
$('#paletteInput').addEventListener('keydown', e => {
  if (e.key === 'ArrowDown') { palSel = Math.min(palSel + 1, palItems.length - 1); paintSel(); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { palSel = Math.max(palSel - 1, 0); paintSel(); e.preventDefault(); }
  else if (e.key === 'Enter') {
    // Selecting a command restores focus to the opener. Consume Enter before
    // that handoff so its native activation cannot reopen the palette behind
    // the command's dialog and steal focus with a second autofocus timer.
    e.preventDefault();
    const it = palItems[palSel];
    if (it) runPaletteItem(it);
  }
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
  if (overlayOpen($('#scrim')) && e.key === 'Tab') {
    const focusable = $$('#modal button:not([disabled]), #modal input:not([disabled]), #modal textarea:not([disabled]), #modal select:not([disabled]), #modal [tabindex]:not([tabindex="-1"])')
      .filter(element => !element.hidden && element.offsetParent !== null);
    if (focusable.length) {
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    // Do not navigate away from an open confirmation or Settings dialog.
    if (overlayOpen($('#scrim'))) return;
    if (pages.current() === 'overview') { e.preventDefault(); showPage('repos'); }
    else if (pages.current() === 'work') { e.preventDefault(); openPalette(); }
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && pages.current() === 'work' && state.file && !state.file.binary && currentTab() === 'editor') {
    e.preventDefault(); openFindPanel();
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && pages.current() === 'work' && state.file && !state.file.binary) {
    e.preventDefault();
    if (!$('#stageFileBtn').disabled) $('#stageFileBtn').click();
  }
  if (e.key === 'Escape') {
    if (overlayOpen($('#paletteScrim'))) closePalette();
    else if (overlayOpen($('#stageScrim'))) closeStagePanel();
    else if (overlayOpen($('#sheetScrim'))) closeSheet();
    else if (overlayOpen($('#scrim'))) closeModal(false);
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
  return uploadPlanning.planUploadTransport({
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
  uploadTransportV = uploadPlanning.normalizeTransportChoice(b.dataset.v);
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
  const guard = ArchiveSafety;
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


    const csrf = await ensureCsrfToken();
    checkContext();
    const xhr = new XMLHttpRequest();
    let outcome;
    const qs = new URLSearchParams({ path: targetPath, branch: w.branch, message, lfs: transport });
    const expectedHeadSha = currentHeadSha(w.branch);
    if (expectedHeadSha) qs.set('expectedHeadSha', expectedHeadSha);
    xhr.open('POST', `/api/repo/${w.owner}/${w.repo}/upload?${qs}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('x-nv', '1');
    xhr.setRequestHeader('x-nv-csrf', csrf);
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
        <div class="commit-meta"><span></span><span class="mono commit-sha">${esc(String(c.sha || '').slice(0, 7))}</span><span>${timeAgo(c.date)}</span></div>
        <div class="commit-diff"></div>`;
      el.querySelector('.commit-msg').textContent = c.message.split('\n')[0];
      el.querySelector('.commit-meta span').textContent = c.author;
      /* The row opens and closes the diff; a tap, a selection or a sideways scroll inside the diff is reading it. */
      el.addEventListener('click', event => {
        if (event.target.closest('.commit-diff')) return;
        if (String(window.getSelection && window.getSelection()).length) return;
        toggleDiff(el, c.sha);
      });
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
        <span class="diff-adds">+${Number(f.additions) || 0}</span><span class="diff-dels">−${Number(f.deletions) || 0}</span>
        <span style="margin-left:auto;color:var(--muted)">${esc(f.status)}</span>
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
/*
 * A detail opens directly under the row it belongs to, rather than after the
 * whole list: from the thirtieth pull request the reader used to land at the
 * bottom of the page with the detail half off screen and the list behind
 * them. A reload parks it back after the list first, so clearing the list
 * never takes the detail's element with it.
 */
function parkDetail(box, host) {
  box.hidden = true;
  if (host.contains(box)) host.after(box);
}
function placeDetail(box, anchor) {
  if (anchor && anchor.isConnected) anchor.after(box);
  box.hidden = false;
}
function revealDetail(box) {
  /* Its head is what the reader needs first: a detail taller than the screen starts at its top, a short one just comes into view. */
  requestAnimationFrame(() => {
    const tall = box.getBoundingClientRect().height > window.innerHeight * 0.6;
    box.scrollIntoView({ behavior: state.settings.motion === false ? 'auto' : 'smooth', block: tall ? 'start' : 'nearest' });
  });
}
async function loadPRs() {
  const host = $('#prList');
  parkDetail($('#prDetail'), host);
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
        <div class="li-meta"><span>#${Number(p.number) || 0}</span><span></span><span class="mono">${esc(p.head)} → ${esc(p.base)}</span><span>${timeAgo(p.updated_at)}</span></div>`;
      el.querySelector('.li-title').textContent = p.title;
      el.querySelector('.li-meta span:nth-child(2)').textContent = p.user || '';
      el.addEventListener('click', () => openPR(p.number, el));
      host.appendChild(el);
    });
    /* A card on the Overview's board asked for this pull request: open it under its row. */
    const pending = state.pendingPull;
    if (pending && pending.key === String(wPath() || '').toLowerCase()) {
      state.pendingPull = null;
      const index = prs.findIndex(p => Number(p.number) === pending.number);
      if (index >= 0) openPR(pending.number, host.children[index]);
      else toast(`Pull request #${pending.number} is no longer in this list`, 'err');
    }
  } catch (e) { host.innerHTML = ''; toast(e.message, 'err'); }
}
/*
 * The audit gate on a pull request: what your latest audit of its head says
 * about merging it, after the team's decisions, and what the repository's
 * active policies will do with that when Merge is pressed. The same facts
 * travel inside the merge itself, where the policy is applied; this only
 * shows them first, so a refusal is never the first the reader hears of it.
 */
let pullGateRequest = 0;
const GATE_REASON = Object.freeze({
  critical: () => 'An open confirmed critical finding',
  serious: () => 'Open confirmed serious findings',
  exploited: gate => `${gate.exploited === 1 ? 'A dependency' : `${gate.exploited} dependencies`} exploited in the wild, in code that ships`,
  secret: () => 'A credential in the code',
  overdue: gate => `${gate.overdue} ${gate.overdue === 1 ? 'finding' : 'findings'} past ${gate.overdue === 1 ? 'its' : 'their'} deadline`,
  introduced: gate => `${gate.introduced} serious or critical ${gate.introduced === 1 ? 'finding' : 'findings'} not on the base branch`
});
const GATE_EFFECT = Object.freeze({
  deny: mode => (mode === 'block' ? 'refuses this merge' : mode === 'warn' ? 'warns against this merge and records it' : 'records that it would refuse this merge'),
  'require-approval': mode => (mode === 'block' ? 'holds this merge for approval' : mode === 'warn' ? 'warns that this merge needs approval' : 'records that this merge would need approval'),
  allow: () => 'allows this merge'
});
async function paintPullGate(p, box) {
  const host = box.querySelector('#prGate');
  if (!host || CapabilityUI.decision('code-audit').status !== 'Supported') return;
  const token = ++pullGateRequest;
  const repoPath = wPath();
  try {
    const answer = await api(`/api/repo/${repoPath}/code-audit/gate?pull=${encodeURIComponent(p.number)}`);
    if (token !== pullGateRequest || !host.isConnected || repoPath !== wPath()) return;
    renderPullGate(host, p, answer);
  } catch (error) {
    if (token !== pullGateRequest || !host.isConnected) return;
    /* A reader who is not a collaborator cannot merge either: there is nothing to show them. */
    if (error.status === 403) return;
    renderPullGate(host, p, null);
  }
}
function renderPullGate(host, p, answer) {
  const node = (tag, className, text) => {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  };
  host.replaceChildren();
  const gate = answer && answer.gate;
  const head = node('div', 'pr-gate-head');
  head.appendChild(node('span', 'pr-gate-title', 'Audit gate'));
  let state = 'unavailable';
  let word = 'Not read';
  if (answer && answer.available === false) { state = 'unavailable'; word = 'No history'; }
  else if (gate && gate.state === 'current') { state = gate.blocking.length ? 'hold' : 'pass'; word = gate.blocking.length ? `${gate.blocking.length} ${gate.blocking.length === 1 ? 'reason' : 'reasons'} to hold` : 'Passes'; }
  else if (gate && gate.state === 'stale') { state = 'stale'; word = 'Audit is behind the head'; }
  else if (gate && gate.state === 'missing') { state = 'missing'; word = 'Not audited'; }
  else if (gate && gate.state === 'unavailable' && gate.complete === false) { state = 'incomplete'; word = 'Audit incomplete'; }
  const badge = node('span', 'nv-chip pr-gate-chip');
  badge.dataset.tone = state === 'pass' ? 'good' : state === 'hold' ? 'critical' : 'pending';
  badge.appendChild(node('span', null, word));
  head.appendChild(badge);
  host.dataset.state = state;
  host.appendChild(head);
  const line = (text, className = 'pr-gate-line') => host.appendChild(node('p', className, text));
  if (!answer) line('The audit gate could not be read just now. The merge is still judged by any active policy when it runs.');
  else if (answer.available === false) line('This server keeps no audit history, so there is no audit of this head to judge it by.');
  else if (gate.state === 'missing') {
    line(answer.pull && answer.pull.fork
      ? 'This pull request comes from a fork, so no audit of this repository describes its head.'
      : `You have not audited ${p.head}. Audit it before merging, so the merge is judged by what it brings in.`);
  } else if (gate.state === 'stale') {
    line(`Your latest audit of ${p.head} is of ${String(gate.commitSha || '').slice(0, 7)}; the head is now ${String(answer.pull.headSha || '').slice(0, 7)}. Audit it again before merging.`);
  } else if (gate.state === 'unavailable' && gate.complete === false) {
    /*
     * The kept audit was read; it is the evidence in it that falls short. An
     * audit kept before audits recorded their own completeness is cured by
     * auditing again; a recorded gap waits on an approval.
     */
    const sha = String(gate.commitSha || '').slice(0, 7);
    line(gate.evidence === 'unrecorded'
      ? `Your audit of ${p.head} at ${sha} was kept before audits recorded how complete they were. Audit it again so the gate can judge it; until then the merge waits on an approval.`
      : `Part of your audit of ${p.head} at ${sha} could not be completed: some files, findings or dependency answers are missing. The gate cannot clear this head on its own, so the merge waits on an approval.`);
  } else if (gate.state === 'unavailable') {
    line('The kept audits could not be read just now.');
  } else {
    const open = gate.open || {};
    const counts = ['critical', 'serious', 'warning'].filter(severity => open[severity]).map(severity => `${open[severity]} ${severity}`);
    /* When, as long ago as it was, with the moment on hover; which commit, as code. */
    const facts = node('p', 'pr-gate-line');
    const when = node('time', null, timeAgo(gate.auditedAt));
    when.dateTime = String(gate.auditedAt || '');
    when.title = auditMoment(gate.auditedAt);
    facts.append(`Grade ${gate.grade} · audited `, when, ' at ', node('code', 'pr-gate-sha', String(gate.commitSha || '').slice(0, 7)),
      ` · ${counts.length ? `${counts.join(', ')} open` : 'nothing open'}${gate.base === 'missing' ? ` · ${p.base} not audited, so nothing is compared with it` : ''}`);
    host.appendChild(facts);
    if (gate.blocking.length) {
      const list = node('ul', 'pr-gate-reasons');
      for (const reason of gate.blocking) if (GATE_REASON[reason]) list.appendChild(node('li', null, GATE_REASON[reason](gate)));
      host.appendChild(list);
    }
    if (gate.complete === false) line('Part of this audit could not be completed, so there may be more than this.', 'pr-gate-line pr-gate-muted');
  }
  const policies = answer && answer.enforcement && Array.isArray(answer.enforcement.policies) ? answer.enforcement.policies : [];
  const acting = policies.filter(policy => policy.effect !== 'allow');
  if (acting.length) {
    for (const policy of acting) {
      const effect = (GATE_EFFECT[policy.effect] || GATE_EFFECT.allow)(policy.mode);
      const sentence = node('p', 'pr-gate-policy');
      sentence.dataset.mode = policy.mode;
      sentence.dataset.effect = policy.effect;
      const rule = policy.rules.find(item => item.description);
      sentence.textContent = `Policy ${policy.policyKey} (${policy.mode}) ${effect}${rule ? `: ${rule.description}` : '.'}`;
      host.appendChild(sentence);
    }
  } else if (gate && (state === 'hold' || state === 'missing' || state === 'stale' || state === 'incomplete') && answer.enforcement && answer.enforcement.available) {
    line('No active policy acts on the gate yet. The Audit merge gate template in Governance does.', 'pr-gate-line pr-gate-muted');
  }
  if (gate && (gate.state === 'missing' || gate.state === 'stale' || gate.evidence === 'unrecorded') && !(answer.pull && answer.pull.fork)) {
    const branchKnown = [...$('#branchSelect').options].some(option => option.value === p.head);
    if (branchKnown) {
      const go = node('button', 'btn btn-ghost small pr-gate-audit', 'Audit this head');
      go.type = 'button';
      go.addEventListener('click', () => {
        $('#branchSelect').value = p.head;
        $('#branchSelect').dispatchEvent(new Event('change'));
        switchTab('audit');
        runAudit();
      });
      host.appendChild(go);
    }
  }
  host.hidden = false;
}
async function openPR(num, anchor) {
  const box = $('#prDetail');
  placeDetail(box, anchor);
  box.innerHTML = '<div class="skeleton" style="height:120px"></div>';
  revealDetail(box);
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
        <span>#${Number(p.number) || 0} by ${esc(p.user || '')}</span>
        <span class="mono">${esc(p.head)} → ${esc(p.base)}</span>
        <span class="diff-adds">+${Number(p.additions) || 0}</span><span class="diff-dels">−${Number(p.deletions) || 0}</span>
        <span>${Number(p.changed_files) || 0} files</span>
      </div>
      <div class="detail-body" id="prBody" hidden></div>
      <div class="pr-gate" id="prGate" hidden></div>
      <div class="detail-actions" id="prActions"></div>
      <div id="prFiles" style="margin-top:14px"></div>
      <div id="prComments" style="margin-top:14px"></div>
      <label class="field-label" for="prNewComment">Add a comment</label>
      <textarea id="prNewComment" placeholder="Write a comment…"></textarea>
      <div class="detail-actions"><button class="btn btn-primary small" id="prCommentBtn">Comment ✦</button></div>`;
    box.querySelector('.detail-title').textContent = p.title;
    if (p.body) { $('#prBody').hidden = false; renderMarkdownInto($('#prBody'), p.body); }
    $('#prCloseDetail').addEventListener('click', () => { box.hidden = true; });
    revealDetail(box);
    if (p.state === 'open') paintPullGate(p, box);
    if (p.state === 'open' && !p.draft) {
      const act = $('#prActions');
      [['merge', 'Merge'], ['squash', 'Squash & merge'], ['rebase', 'Rebase & merge']].forEach(([m, label]) => {
        const b = document.createElement('button');
        b.className = m === 'merge' ? 'btn btn-primary small' : 'btn btn-ghost small';
        b.textContent = label;
        b.addEventListener('click', async () => {
          const sure = await modal({ title: label,
            bodyHTML: `<p style="font-size:.9rem;line-height:1.5">${label} PR #${Number(p.number) || 0} <b class="mono">${esc(p.head)}</b> into <b class="mono">${esc(p.base)}</b>?</p>`,
            okText: label });
          if (!sure) return;
          try {
            const merged = await stepUpApi('pull.merge', {
              owner: state.work.owner, repo: state.work.repo, pullNumber: p.number, method: m
            }, `/api/repo/${wPath()}/pulls/${p.number}/merge`, {
              method: 'PUT',
              /* The head on screen is the head that merges; the server
                 refuses the merge if the branch has moved since. */
              body: p.headSha ? { method: m, expectedHeadSha: p.headSha } : { method: m }
            }, `${label} PR #${p.number}`);
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
      renderMarkdownInto(el.querySelector('.comment-body'), c.body || '');
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
  parkDetail($('#issueDetail'), host);
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
          <span class="state-pill ${it.state === 'open' ? 'state-open' : 'state-closed'}">${esc(it.state)}</span>
          <span class="li-title"></span>
        </div>
        <div class="li-meta">
          <span>#${Number(it.number) || 0}</span><span></span>
          ${it.labels.map(l => { const color = safeHexColor(l.color); return `<span class="label-pill" style="border-color:#${color}88;color:#${color}">${esc(l.name)}</span>`; }).join('')}
          <span>${META_ICON.comments} ${Number(it.comments) || 0}</span><span>${timeAgo(it.updated_at)}</span>
        </div>`;
      el.querySelector('.li-title').textContent = it.title;
      el.querySelector('.li-meta span:nth-child(2)').textContent = it.user || '';
      el.addEventListener('click', () => openIssue(it.number, el));
      host.appendChild(el);
    });
  } catch (e) { host.innerHTML = ''; toast(e.message, 'err'); }
}
async function openIssue(num, anchor) {
  const box = $('#issueDetail');
  placeDetail(box, anchor);
  box.innerHTML = '<div class="skeleton" style="height:120px"></div>';
  revealDetail(box);
  try {
    const i = await api(`/api/repo/${wPath()}/issues/${num}`);
    box.innerHTML = `
      <div class="detail-head">
        <span class="state-pill ${i.state === 'open' ? 'state-open' : 'state-closed'}">${esc(i.state)}</span>
        <span class="detail-title"></span>
        <button class="btn btn-ghost small" id="issCloseDetail" aria-label="Close">${META_ICON.close}</button>
      </div>
      <div class="detail-meta"><span>#${Number(i.number) || 0} by ${esc(i.user || '')}</span><span>${timeAgo(i.created_at)}</span></div>
      <div class="detail-body" id="issBody" hidden></div>
      <div id="issComments"></div>
      <label class="field-label" for="issNewComment">Add a comment</label>
      <textarea id="issNewComment" placeholder="Write a comment…"></textarea>
      <div class="detail-actions">
        <button class="btn btn-primary small" id="issCommentBtn">Comment ✦</button>
        <button class="btn btn-ghost small" id="issToggleBtn">${i.state === 'open' ? 'Close issue' : 'Reopen issue'}</button>
      </div>`;
    box.querySelector('.detail-title').textContent = i.title;
    if (i.body) { $('#issBody').hidden = false; renderMarkdownInto($('#issBody'), i.body); }
    const ch = $('#issComments');
    i.comments.forEach(c => {
      const el = document.createElement('div');
      el.className = 'comment';
      el.innerHTML = `<div class="comment-head">${c.avatar ? `<img src="${escAttr(c.avatar)}" alt="">` : ''}<span>${esc(c.user || '')}</span><span>${timeAgo(c.created_at)}</span></div>
        <div class="comment-body"></div>`;
      renderMarkdownInto(el.querySelector('.comment-body'), c.body || '');
      ch.appendChild(el);
    });
    $('#issCloseDetail').addEventListener('click', () => { box.hidden = true; });
    revealDetail(box);
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
      if (r.body) renderMarkdownInto(el.querySelector('.rel-body'), r.body.length > 1200 ? `${r.body.slice(0, 1200)}…` : r.body);
      host.appendChild(el);
    });
  } catch (e) { host.innerHTML = ''; toast(e.message, 'err'); }
}
$('#newReleaseBtn').addEventListener('click', async () => {
  const ok = await modal({
    title: 'New release',
    bodyHTML: `
      <label class="field-label" for="relTag">Tag</label><input id="relTag" type="text" placeholder="v1.0.0" autocapitalize="off" autocorrect="off" spellcheck="false">
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
        <span><b>${Number(c.ahead_by) || 0}</b> ahead</span>
        <span><b>${Number(c.behind_by) || 0}</b> behind</span>
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
  if (!isOfflineError(e)) return false;
  await qAdd(op);
  toast('No connection — commit saved to the offline queue ✦', 'ok');
  return true;
}
let _flushing = false;
async function flushQueue(manual) {
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
          <input id="tmPath" type="text" autocapitalize="off" autocorrect="off" spellcheck="false" autocomplete="off">`,
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
          <input id="tmReset" type="text" autocapitalize="off" autocorrect="off" spellcheck="false" autocomplete="off">`,
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
  return uploadPlanning.planBatchCommits(count);
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
/* `csrf` is the request-security token, asked for each blob so a long batch never sends one that has lapsed. */
function uploadBlob(q, csrf) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/repo/${wPath()}/blob?path=${encodeURIComponent(q.targetPath)}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('x-nv', '1');
    xhr.setRequestHeader('x-nv-csrf', csrf);
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
        ops.push({ op: 'put', path: q.targetPath, sha: await uploadBlob(q, await ensureCsrfToken()) });
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
window.addEventListener('resize', () => { if (!isMobile()) { $('#side').classList.remove('open'); closeOverlay($('#sideScrim')); } });

/* ================= v3 MODULES ================= */

/* ---- unsaved drafts (localStorage, per repo@branch:path) ---- */
let _draftTimer = null;
const draftKey = p => `nv_draft:${wPath()}@${state.work.branch}:${p}`;
function saveDraft() {
  clearTimeout(_draftTimer);
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
    pageStore.mutate('file', file => { file.dirty = true; });
    $('#commitFileBtn').disabled = false; $('#stageFileBtn').disabled = false; $('#diffBtn').disabled = false;
    removeDraftBar();
    toast('Draft restored', 'ok');
  });
  $('#draftDiscard').addEventListener('click', () => { clearDraft(p); removeDraftBar(); });
}

/* ---- recent files ---- */
function getRecents() {
  try { return JSON.parse(localStorage.getItem(`nv_recent:${wPath()}`) || '[]'); } catch { return []; }
}
function rememberRecent(p) {
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
    const tone = item => item.status !== 'completed' ? 'running' : item.conclusion === 'success' ? 'success' : item.conclusion === 'failure' ? 'failure' : 'neutral';
    const word = item => item.status !== 'completed' ? String(item.status || 'queued').replace('_', ' ') : (item.conclusion || 'done');
    runs.forEach((r, i) => {
      /*
       * A run is a card with one toggle, its header. Everything that opens
       * under it -- the jobs, their steps, the actions -- is for reading, so a
       * tap there, a selection or a scroll never closes the run under the
       * reader. Jobs are disclosures of their own: the failed ones open, the
       * rest fold to one line, so a run of eight jobs is eight lines, not a
       * hundred and twenty.
       */
      const el = document.createElement('div');
      el.className = 'card list-item run-item';
      el.style.animationDelay = Math.min(i * 40, 360) + 'ms';
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'run-toggle';
      toggle.setAttribute('aria-expanded', 'false');
      toggle.innerHTML = `
        <span class="li-head">
          <span class="run-status"><span class="run-dot ${tone(r)}"></span></span>
          <span class="li-title"></span>
          <span class="badge">${esc(word(r))}</span>
          <svg class="run-chev" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
        </span>
        <span class="li-meta"><span>#${Number(r.number) || 0}</span><span class="mono">${esc(r.branch || '')}</span>
          <span>${esc(r.event)}</span><span class="mono commit-sha">${esc(String(r.sha || '').slice(0, 7))}</span><span>${timeAgo(r.created_at)}</span></span>`;
      toggle.querySelector('.li-title').textContent = r.name || 'workflow';
      const jobsBox = document.createElement('div');
      jobsBox.className = 'run-jobs';
      jobsBox.hidden = true;
      jobsBox.id = `runJobs${Number(r.id) || i}`;
      toggle.setAttribute('aria-controls', jobsBox.id);
      el.append(toggle, jobsBox);
      toggle.addEventListener('click', async () => {
        const open = !jobsBox.hidden;
        jobsBox.hidden = open;
        toggle.setAttribute('aria-expanded', String(!open));
        el.classList.toggle('open', !open);
        if (open || jobsBox.dataset.loaded) { if (!open) revealDetail(jobsBox); return; }
        jobsBox.innerHTML = '<div class="skeleton" style="height:44px;margin-top:10px"></div>';
        try {
          const jobs = await api(`/api/repo/${wPath()}/actions/${r.id}/jobs`);
          jobsBox.dataset.loaded = '1';
          jobsBox.innerHTML = '';
          if (!jobs.length) jobsBox.innerHTML = '<p class="hint">This run reported no jobs.</p>';
          jobs.forEach(jb => {
            const job = document.createElement('details');
            job.className = 'run-job';
            job.dataset.state = tone(jb);
            if (tone(jb) === 'failure' || tone(jb) === 'running') job.open = true;
            const steps = jb.steps || [];
            const failedSteps = steps.filter(st => tone(st) === 'failure').length;
            job.innerHTML = `<summary class="run-job-head"><span class="run-dot ${tone(jb)}"></span><b></b>
              <span class="run-job-word">${esc(word(jb))}</span><span class="run-job-n">${steps.length} step${steps.length === 1 ? '' : 's'}${failedSteps ? ` · ${failedSteps} failed` : ''}</span></summary>`;
            job.querySelector('b').textContent = jb.name;
            const list = document.createElement('ol');
            list.className = 'run-steps';
            steps.forEach(st => {
              const sr = document.createElement('li');
              sr.className = 'step-row';
              sr.dataset.state = tone(st);
              sr.innerHTML = `<span class="run-dot ${tone(st)}"></span><span class="step-name"></span><span class="step-word">${esc(word(st))}</span>`;
              sr.querySelector('.step-name').textContent = st.name;
              list.appendChild(sr);
            });
            job.appendChild(list);
            jobsBox.appendChild(job);
          });
          const acts = document.createElement('div');
          acts.className = 'detail-actions';
          acts.innerHTML = `<button class="btn btn-ghost small" data-rerun data-feature="workflows.rerun">Re-run</button>
            <button class="btn btn-ghost small" data-open>Open on the provider</button>`;
          CapabilityUI.apply(acts);
          acts.querySelector('[data-rerun]').addEventListener('click', async () => {
            try { await api(`/api/repo/${wPath()}/actions/${r.id}/rerun`, { method: 'POST' }); toast('Re-run requested ✦', 'ok'); }
            catch (e3) { toast(e3.message, 'err'); }
          });
          /* Only a web address leaves the app; anything else a provider sends is not followed. */
          const openButton = acts.querySelector('[data-open]');
          if (/^https:\/\//i.test(String(r.html_url || ''))) openButton.addEventListener('click', () => window.open(r.html_url, '_blank', 'noopener'));
          else openButton.hidden = true;
          jobsBox.appendChild(acts);
          revealDetail(jobsBox);
        } catch (e4) { jobsBox.innerHTML = `<p class="hint">⚠ ${esc(e4.message)}</p>`; }
      });
      host.appendChild(el);
    });
  } catch (e) { host.innerHTML = ''; toast(e.message, 'err'); }
}
$('#actionsRefreshBtn').addEventListener('click', () => { transport.cache.clear(); loadActions(); });

/* ---- branch manager ---- */
async function openBranchManager() {
  modal({ title: 'Branches', okText: 'Done', bodyHTML: '<div class="skeleton" style="height:80px"></div>' });
  const ownsModal = modalOwner();
  const work = state.work;
  try {
    const info = await api(`/api/repo/${wPath()}`);
    if (!ownsModal() || state.work !== work) return;
    pageStore.mutate('work', () => { work.branches = info.branches; });
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
  } catch (e) { if (ownsModal()) $('#modalBody').innerHTML = `<p class="hint">⚠ ${esc(e.message)}</p>`; }
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
 * The chrome belongs to the screens, and the gate replaces them. Naming the
 * screen in view does not repaint it: showPage returns early when handed the screen
 * that is already current, which the gate paths have just made true. So an
 * expired session left the workbench's floating action over the gate's own
 * Continue, offering an action against a workspace that was already gone.
 */
window.addEventListener('nebula:alpha-access-gated', () => {
  paintRail('alpha-access');
  paintFloatingAction('alpha-access');
  closeNavMenu();
});
AlphaUI.boot().then(result => {
  if (result.allowed) {
    handedSignInNotice = result.notice || '';
    startAuthorizedApp();
  }
}).catch(() => {
  AlphaUI.showWaking('Temporarily unavailable');
});

/*
 * What the Neural module, loaded on demand, uses of the workbench. A classic
 * script shared every top-level name with every other script on the page;
 * a module shares only what it names here.
 */
export {
  state, api, toast, exposureRuleLabel, EXPOSURE_DISPOSITION_WORDS, modal, securityScanFlow,
  exportActivityFlow, openFile, switchTab, recoveryFlow, openSafeguards, setSafety, stepUpApi,
  dlFile, currentTab, purgeLocalData
};

