'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createAlphaPrivacy, DELETE_PHRASE } = require('../apps/web/src/features/access/alpha-privacy.ts');
const { createAccountBoundary } = require('../apps/web/src/features/access/account-boundary.ts');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'apps', 'web', 'index.html'), 'utf8');
const serviceWorker = fs.readFileSync(path.join(root, 'apps', 'web', 'src', 'offline', 'sw.js'), 'utf8');

for (const label of [
  'Disconnect from Nebulaverse-X',
  'Revoke at provider',
  'End alpha session',
  'Delete alpha data'
]) assert(html.includes(label), `missing distinct privacy action: ${label}`);

/* What the purge lets go of, and in what order, is asked of features/access/account-boundary.ts below and in test/page-session.test.js. */
assert(serviceWorker.includes("event.data.type !== 'NV_PURGE_PRIVATE_DATA'"));
assert(serviceWorker.includes("key.startsWith('nv-api-')"));
assert(!/NV_PURGE_PRIVATE_DATA[\s\S]{0,500}nv-static-/.test(serviceWorker),
  'identity purge must preserve the static shell cache');

/* The alpha's privacy actions, asked directly (features/access/alpha-privacy.ts). */
async function assertPendingPrivacyActionsPreserveRetryState() {
  for (const action of ['disconnect', 'delete']) {
    const effects = [];
    const privacy = createAlphaPrivacy({
      api: async (path, options) => {
        effects.push(['api', path, options && options.body]);
        return { ok: false, status: 'pending', results: [] };
      },
      modal: async () => true,
      closeModal: () => {},
      toast: (message, kind) => effects.push(['toast', message, kind]),
      presentError: error => effects.push(['error', error]),
      purgeLocalData: async () => effects.push(['purge']),
      broadcastIdentityBoundary: () => effects.push(['broadcast']),
      restoreLoginChrome: () => effects.push(['chrome']),
      showSignIn: () => effects.push(['page', 'login']),
      typedConfirmation: () => DELETE_PHRASE,
      attached: () => true
    });
    if (action === 'disconnect') await privacy.disconnectProviders(false);
    else await privacy.deleteData();
    assert.deepStrictEqual(effects.filter(([kind]) => kind === 'api'),
      [action === 'disconnect' ? ['api', '/api/alpha/providers/disconnect-all', {}] : ['api', '/api/alpha/delete', { confirm: 'DELETE ALPHA DATA' }]],
      `${action} asks the alpha's own route, the deletion with its phrase typed out in full`);
    assert.deepStrictEqual(
      effects.filter(([kind]) => ['purge', 'page', 'broadcast', 'chrome'].includes(kind)),
      [],
      `${action} must preserve local and visible retry state while cleanup is pending`
    );
    assert(!effects.some(([kind, message, toastKind]) => (
      kind === 'toast'
      && (toastKind === 'ok' || /completed|disconnected/i.test(String(message)))
    )), `${action} must not claim pending cleanup completed`);
  }
}

async function assertPurgeClearsRuntimeAndVisibleIdentityState() {
  const operations = [];
  const state = {
    uiEpoch: 0,
    staged: [{ path: 'private.txt', content: 'private source' }],
    file: { path: 'private.txt', original: 'private source' },
    work: { owner: 'private-owner', repo: 'private-repo' },
    repos: [{ full_name: 'private-owner/private-repo' }],
    me: { login: 'private-login' },
    caps: { search: 1 },
    fileIndex: ['private/path.js'],
    cm: {
      value: 'private source',
      history: ['private source'],
      setValue(value) {
        operations.push(['editor-value', value, state.file]);
        this.value = value;
      },
      clearHistory() {
        operations.push(['editor-history']);
        this.history = [];
      }
    }
  };
  const buffers = new Map([
    '#repoGrid', '#tree', '#commitList', '#stageList', '#paletteList',
    '#filePath', '#fileSize', '#mdPreview', '#binaryPreview', '#editDiffBody',
    '#codeSearch', '#findInput', '#replaceInput', '#uploadMsg', '#stageMsg', '#paletteInput'
  ].map(selector => [selector, {
    textContent: 'private visible data',
    value: 'private visible data',
    replaceChildren() { this.textContent = ''; }
  }]));
  const localValues = {
    nv_me: 'private-login',
    'nv_draft:private': 'private source',
    nv_theme: 'dark'
  };
  const localStorage = {
    ...localValues,
    removeItem(key) { delete this[key]; }
  };
  const sandbox = {
    state,
    clearCsrfToken: () => operations.push(['csrf']),
    clearGovernanceState: () => operations.push(['governance']),
    /*
     * Exposure findings are per repository and per identity, and they carry a
     * placeholder, a path and bounded locations for somebody's credentials.
     * A purge that left them on screen would show the next session what the
     * previous one found, so the call is stubbed like its peers and recorded
     * so the assertion can prove it happened.
     */
    clearExposureState: () => operations.push(['exposure']),
    /*
     * A repaint the overview held for a press was read for the leaving
     * account; drawn after the purge it would put that reader's feed back on
     * screen, so it is dropped before anything is cleared.
     */
    discardHeldRepaints: () => operations.push(['held-repaints']),
    clearActivityFeed: () => operations.push(['activity-feed']),
    clearPosture: () => operations.push(['posture']),
    clearAuditState: () => operations.push(['audit']),
    /* The standalone site check names the address one account checked and what it found there. */
    clearSiteScanState: () => operations.push(['site-scan']),
    /* A repository still opening for the leaving account must never finish opening for the next one. */
    forgetRepositoryWork: () => operations.push(['repository-work']),
    purgePrivateCaches: async () => {
      assert.strictEqual(state.uiEpoch, 1, 'invalidate pending UI responses before asynchronous cache cleanup');
      assert(operations.some(([kind]) => kind === 'activity-feed'),
        'clear private activity before asynchronous cache cleanup');
      operations.push(['cache']);
    },
    sessionStorage: { clear: () => operations.push(['session-storage']) },
    navigator: { serviceWorker: { controller: { postMessage: message => operations.push(['sw', message.type]) } } },
    localStorage,
    idb: async () => ({
      transaction() {
        const tx = {
          objectStore: () => ({ clear: () => operations.push(['idb-queue']) })
        };
        queueMicrotask(() => tx.oncomplete());
        return tx;
      }
    }),
    /* The page's memory of reads, kept by its transport (platform/transport.ts). */
    transport: { cache: { clear: () => operations.push(['memory-cache']) } },
    /*
     * The unread marker is neither a value nor a child list, so the sweep
     * below cannot reach it: hiding it is what clearing it means, and the
     * painter that owns that decision is the only thing that can do it. It is
     * stubbed here like the other peer functions the purge calls out to, and
     * the call is recorded so the assertion can prove the marker was cleared
     * rather than merely that the purge did not throw.
     */
    paintUnread: list => operations.push(['unread', Array.isArray(list) ? list.length : null]),
    $: selector => buffers.get(selector) || null,
    Object,
    queueMicrotask
  };
  /* The account boundary (features/access/account-boundary.ts), on the same stand-ins. */
  const purge = full => createAccountBoundary({
    state: sandbox.state, discardHeldRepaints: sandbox.discardHeldRepaints, clearActivityFeed: sandbox.clearActivityFeed, clearPosture: sandbox.clearPosture,
    paintUnread: sandbox.paintUnread, clearCsrfToken: sandbox.clearCsrfToken, clearGovernanceState: sandbox.clearGovernanceState,
    clearExposureState: sandbox.clearExposureState, clearAuditState: sandbox.clearAuditState, clearSiteScanState: sandbox.clearSiteScanState,
    forgetRepositoryWork: sandbox.forgetRepositoryWork,
    cacheNames: async () => { await sandbox.purgePrivateCaches(); return []; }, deleteCache: async () => {},
    sessionStorage: () => sandbox.sessionStorage, localStorage: () => sandbox.localStorage, serviceWorker: () => sandbox.navigator.serviceWorker.controller,
    openQueue: () => sandbox.idb(), find: selector => sandbox.$(selector), forgetReads: () => sandbox.transport.cache.clear(),
    channel: () => null, writeStorage: () => {}, onStorage: () => {}, marker: () => '', reload: () => {}
  }).purge(full);
  await purge(true);

  assert.strictEqual(state.file, null);
  assert.strictEqual(state.work, null);
  assert.strictEqual(state.me, null);
  assert.strictEqual(state.caps, null);
  assert.strictEqual(state.fileIndex, null);
  assert(Array.isArray(state.staged) && state.staged.length === 0);
  assert(Array.isArray(state.repos) && state.repos.length === 0);
  assert.strictEqual(state.cm.value, '');
  assert.deepStrictEqual(state.cm.history, []);
  assert.strictEqual(operations.find(([kind]) => kind === 'editor-value')[2], null,
    'state.file must be cleared before CodeMirror changes can trigger draft persistence');
  for (const [selector, buffer] of buffers) {
    assert.strictEqual(buffer.textContent, '', `${selector} must not retain visible private data`);
    assert.strictEqual(buffer.value, '', `${selector} must not retain an identity-bound input value`);
  }
  assert.deepStrictEqual(operations.find(([kind]) => kind === 'unread'), ['unread', 0],
    'the purge must clear the notification unread marker, or one session\'s count stays lit over the next');
  assert.deepStrictEqual(operations.find(([kind]) => kind === 'exposure'), ['exposure'],
    'the purge must clear exposure findings, or the next session sees what the previous one found');
  assert.deepStrictEqual(operations.find(([kind]) => kind === 'audit'), ['audit'],
    'the purge must clear the repository audit, or the next session sees the previous one\'s findings');
  assert.deepStrictEqual(operations.find(([kind]) => kind === 'site-scan'), ['site-scan'],
    'the purge must clear the standalone site check, or the next session sees which site the previous one checked');
  assert.deepStrictEqual(operations.find(([kind]) => kind === 'repository-work'), ['repository-work'],
    'the purge must abandon a repository still opening, or it lands in the next session\'s workbench');
  assert.deepStrictEqual(operations.find(([kind]) => kind === 'posture'), ['posture'],
    'the purge must clear the workspace posture, or the next session is scored with the previous one\'s credential and leaks');
  assert.strictEqual(operations.findIndex(([kind]) => kind === 'held-repaints'), 0,
    'the purge must drop the repaints a press was holding before it clears anything, or one drawn afterwards brings the previous reader back');
  assert.deepStrictEqual(operations.filter(([kind]) => kind === 'memory-cache'), [['memory-cache']],
    'a full purge forgets the page\'s memory of reads, or the next session is answered from the previous one\'s');
  for (const [kind, why] of [
    ['cache', 'the service worker\'s API caches'], ['session-storage', 'this tab\'s storage'], ['idb-queue', 'the offline write queue'], ['csrf', 'the request token']
  ]) assert.strictEqual(operations.filter(entry => entry[0] === kind).length, 1, `the purge must let go of ${why}`);
  assert.deepStrictEqual(operations.find(([kind]) => kind === 'sw'), ['sw', 'NV_PURGE_PRIVATE_DATA'], 'the service worker is told to drop its private cache');
  assert.deepStrictEqual(['nv_me', 'nv_draft:private', 'nv_theme'].map(key => key in localStorage), [false, false, true],
    'the identity of old and the drafts go; the page\'s look stays');
}

(async () => {
  await assertPendingPrivacyActionsPreserveRetryState();
  await assertPurgeClearsRuntimeAndVisibleIdentityState();
  console.log('alpha browser purge tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
