'use strict';

/*
 * Signing in and out, and the account boundary, asked directly: who an answer
 * names (features/access/session.ts); everything this browser holds for a
 * reader let go of in its order, and the other tabs told and heard
 * (features/access/account-boundary.ts).
 */

const assert = require('assert');
const {
  createAccountBoundary, isPrivateStorageKey, PRIVATE_STORAGE_PREFIXES, PURGED_FIELDS,
  IDENTITY_BOUNDARY_CHANNEL, IDENTITY_BOUNDARY_STORAGE_KEY
} = require('../apps/web/src/features/access/account-boundary.ts');
const { createSession, githubIdentity, requireGithubIdentity } = require('../apps/web/src/features/access/session.ts');

const checks = [];
const check = (name, run) => checks.push([name, run]);

/* ---- The account boundary ------------------------------------------------------------ */

function boundaryWorld(over = {}) {
  const log = [];
  const editor = { value: 'private source', history: ['private source'],
    setValue(value) { log.push(['editor-value', value, state.file]); this.value = value; },
    clearHistory() { log.push(['editor-history']); this.history = []; } };
  const state = {
    uiEpoch: 4, file: { path: 'private.txt' }, cm: 'cm' in over ? over.cm : editor, staged: [{ path: 'a' }],
    work: { owner: 'o', repo: 'r' }, repos: [{ full_name: 'o/r' }], me: { login: 'leaving' }, caps: { search: 1 }, fileIndex: ['a.js']
  };
  const fields = new Map(PURGED_FIELDS.map(selector => [selector, selector === '#repoGrid'
    ? { textContent: 'cards', replaceChildren() { log.push(['children', selector]); this.textContent = ''; } }
    : selector === '#mdPreview' ? { textContent: 'preview' } : { value: 'typed', textContent: 'typed', replaceChildren() { this.textContent = ''; } }]));
  const local = {
    nv_snap_1: 's', nv_incident_x: 'i', 'nv_draft:o/r:a': 'd', 'nv_recent:o/r': 'r', 'nv_offline_repos:scope': 'o', nv_neural_layout_v2: 'n',
    'nv_audit:o/r': 'a', 'nv_view:o/r': 'v', nv_me: 'shared', nv_theme: 'dark', nv_settings: '{}', nv_identity_boundary_event: 'old',
    removeItem(key) { log.push(['local-remove', key]); delete this[key]; }
  };
  let channelListener = null;
  const storageListeners = [];
  const posted = [];
  const deps = {
    state,
    discardHeldRepaints: () => log.push(['held']),
    clearActivityFeed: () => log.push(['activity']),
    clearPosture: () => log.push(['posture']),
    paintUnread: list => log.push(['unread', list.length]),
    clearCsrfToken: () => log.push(['csrf']),
    clearGovernanceState: () => log.push(['governance']),
    clearExposureState: () => log.push(['exposure']),
    clearAuditState: () => log.push(['audit']),
    clearSiteScanState: () => log.push(['site']),
    forgetRepositoryWork: () => log.push(['work', state.work !== null]),
    cacheNames: async () => { log.push(['caches', state.uiEpoch]); if (over.caches === 'throw') throw new Error('no caches'); return ['nv-api-v3', 'nv-static-v3', 'other', 'nv-api-old']; },
    deleteCache: async name => log.push(['cache-delete', name]),
    sessionStorage: () => { if (over.session === 'throw') throw new Error('blocked'); return { clear: () => log.push(['session-clear']) }; },
    localStorage: () => { if (over.local === 'throw') throw new Error('blocked'); return local; },
    serviceWorker: () => (over.worker === 'none' ? null : { postMessage: message => log.push(['worker', message.type]) }),
    openQueue: async () => {
      if (over.queue === 'throw') throw new Error('no idb');
      return { transaction(store, mode) {
        log.push(['queue-open', store, mode]);
        const tx = { objectStore: name => ({ clear: () => log.push(['queue-clear', name]) }), oncomplete: null, onerror: null, onabort: null };
        queueMicrotask(() => (over.queue === 'abort' ? tx.onabort() : over.queue === 'error' ? tx.onerror() : tx.oncomplete()));
        return tx;
      } };
    },
    find: selector => fields.get(selector) || null,
    forgetReads: () => log.push(['reads']),
    channel: () => {
      if (over.channel === 'none') return null;
      if (over.channel === 'throw') throw new Error('no channel');
      return { postMessage: message => { if (over.post === 'throw') throw new Error('closed'); posted.push(message); },
        addEventListener: (type, listener) => { log.push(['channel-listen', type]); channelListener = listener; } };
    },
    writeStorage: (key, value) => { if (over.write === 'throw') throw new Error('blocked'); log.push(['storage-write', key, value]); },
    onStorage: listener => storageListeners.push(listener),
    marker: () => 'marker-1',
    reload: () => log.push(['reload'])
  };
  const boundary = createAccountBoundary(deps);
  return { boundary, log, state, local, fields, editor, posted, hear: data => channelListener({ data }), storage: event => storageListeners.forEach(l => l(event)), storageListeners };
}

check('a reader\'s storage is known by its keys; nothing of the page\'s own look is', () => {
  for (const key of ['nv_snap_x', 'nv_incident_y', 'nv_draft:o/r:f', 'nv_recent:o/r', 'nv_offline_repos:s', 'nv_neural_layout', 'nv_neural_layout_v2', 'nv_audit:o/r', 'nv_view:o/r']) {
    assert.strictEqual(isPrivateStorageKey(key), true, key);
  }
  for (const key of ['nv_theme', 'nv_settings', 'nv_me', 'nv_identity_boundary_event', 'snap_nv_', 'NV_DRAFT:x', 'nv_draft', 'old_nv_draft:o/r', 'x-nv_view:y']) {
    assert.strictEqual(isPrivateStorageKey(key), false, key);
  }
  assert.strictEqual(PRIVATE_STORAGE_PREFIXES.length, 8);
  /* Every field and list that holds what a reader typed or was shown, the token field among them. */
  assert.deepStrictEqual([...PURGED_FIELDS], [
    '#repoGrid', '#tree', '#prList', '#issueList', '#releaseList', '#commitList', '#cmpResult', '#uploadQueue', '#actionsList', '#stageList', '#paletteList',
    '#filePath', '#fileSize', '#mdPreview', '#binaryPreview', '#editDiffBody', '#githubAppSettingsBody', '#tokenInput', '#codeSearch', '#findInput',
    '#replaceInput', '#uploadMsg', '#stageMsg', '#paletteInput'
  ]);
  assert.ok(Object.isFrozen(PRIVATE_STORAGE_PREFIXES) && Object.isFrozen(PURGED_FIELDS));
});

check('a purge lets go of everything in its order: the epoch and the held repaints first, the file before the editor, the reads last', async () => {
  const { boundary, log, state, local, fields } = boundaryWorld();
  const purging = boundary.purge(true);
  assert.strictEqual(state.uiEpoch, 5, 'the epoch moves before the first await, so a reading in flight lands in a page that has moved on');
  assert.deepStrictEqual(log.slice(0, 9).map(entry => entry[0]), ['held', 'activity', 'posture', 'unread', 'csrf', 'governance', 'exposure', 'audit', 'site'],
    'the repaints a press was holding go before anything else is cleared');
  await purging;
  const kinds = log.map(entry => entry[0]);
  assert.deepStrictEqual(log.filter(entry => entry[0] === 'cache-delete'), [['cache-delete', 'nv-api-v3'], ['cache-delete', 'nv-api-old']], 'only the API\'s caches; the shell stays');
  assert.ok(kinds.indexOf('session-clear') > kinds.indexOf('cache-delete'));
  assert.deepStrictEqual(log.find(entry => entry[0] === 'worker'), ['worker', 'NV_PURGE_PRIVATE_DATA']);
  for (const key of ['nv_snap_1', 'nv_incident_x', 'nv_draft:o/r:a', 'nv_recent:o/r', 'nv_offline_repos:scope', 'nv_neural_layout_v2', 'nv_audit:o/r', 'nv_view:o/r', 'nv_me']) {
    assert.ok(!(key in local), `${key} is let go`);
  }
  assert.deepStrictEqual(['nv_theme', 'nv_settings', 'nv_identity_boundary_event'].map(key => key in local), [true, true, true], 'the page\'s look and the boundary\'s own word stay');
  assert.ok(kinds.indexOf('queue-clear') > kinds.indexOf('local-remove') && kinds.lastIndexOf('local-remove') > kinds.indexOf('queue-clear'), 'the queue, then the shared identity of old');
  assert.deepStrictEqual(log.find(entry => entry[0] === 'editor-value'), ['editor-value', '', null], 'the file is let go before the editor is emptied, so the emptying is no draft of it');
  assert.ok(kinds.indexOf('editor-history') > kinds.indexOf('editor-value'));
  assert.deepStrictEqual(log.find(entry => entry[0] === 'work'), ['work', true], 'a repository still opening is abandoned before the open one is let go');
  assert.deepStrictEqual({ file: state.file, staged: state.staged, work: state.work, repos: state.repos, me: state.me, caps: state.caps, fileIndex: state.fileIndex },
    { file: null, staged: [], work: null, repos: [], me: null, caps: null, fileIndex: null });
  assert.deepStrictEqual(log.filter(entry => entry[0] === 'unread'), [['unread', 0], ['unread', 0]], 'the marker is cleared, and cleared again once the reader is gone');
  for (const [selector, field] of fields) {
    assert.strictEqual(field.textContent, '', selector);
    if ('value' in field) assert.strictEqual(field.value, '', selector);
  }
  assert.ok(log.some(entry => entry[0] === 'children' && entry[1] === '#repoGrid'), 'a list is emptied of its children');
  assert.deepStrictEqual(log[log.length - 1], ['reads'], 'a full purge forgets the page\'s memory of reads, last');
});

check('a switch keeps the page\'s memory of reads, but lets go of the offline queue all the same', async () => {
  const { boundary, log } = boundaryWorld();
  await boundary.purge(false);
  assert.ok(!log.some(entry => entry[0] === 'reads'));
  assert.deepStrictEqual(log.filter(entry => entry[0].startsWith('queue')), [['queue-open', 'queue', 'readwrite'], ['queue-clear', 'queue']],
    'a write queued for one account is never replayed with another\'s credentials');
});

check('whatever the browser refuses, the rest of the purge goes on', async () => {
  for (const over of [{ caches: 'throw' }, { session: 'throw' }, { local: 'throw' }, { worker: 'none' }, { queue: 'throw' }, { queue: 'abort' }, { queue: 'error' }, { cm: null }]) {
    const { boundary, state, log } = boundaryWorld(over);
    await boundary.purge(true);
    assert.deepStrictEqual([state.me, state.work, state.file], [null, null, null], JSON.stringify(over));
    assert.deepStrictEqual(log[log.length - 1], ['reads'], JSON.stringify(over));
  }
});

check('taking a repository out of offline use deletes the private caches and nothing else, and a browser that refuses stops nothing', async () => {
  const { boundary, log, state } = boundaryWorld();
  await boundary.purgePrivateCaches();
  assert.deepStrictEqual(log.filter(entry => entry[0] === 'cache-delete'), [['cache-delete', 'nv-api-v3'], ['cache-delete', 'nv-api-old']]);
  assert.strictEqual(state.uiEpoch, 4, 'only the caches: the page and its reader are as they were');
  assert.deepStrictEqual(log.map(entry => entry[0]), ['caches', 'cache-delete', 'cache-delete']);
  const refused = boundaryWorld({ caches: 'throw' });
  await refused.boundary.purgePrivateCaches();
  assert.deepStrictEqual(refused.log.filter(entry => entry[0] === 'cache-delete'), []);
});

check('the other tabs are told on the channel and through storage, and a tab that cannot is not stopped', () => {
  const told = boundaryWorld();
  told.boundary.broadcast();
  assert.deepStrictEqual(told.posted, [{ type: 'NV_IDENTITY_BOUNDARY', marker: 'marker-1' }]);
  assert.deepStrictEqual(told.log.filter(entry => entry[0] === 'storage-write'), [['storage-write', 'nv_identity_boundary_event', 'marker-1']]);
  for (const over of [{ channel: 'none' }, { channel: 'throw' }, { post: 'throw' }, { write: 'throw' }]) {
    const world = boundaryWorld(over);
    world.boundary.broadcast();
    assert.strictEqual(world.log.filter(entry => entry[0] === 'storage-write').length, over.write ? 0 : 1, JSON.stringify(over));
  }
  assert.strictEqual(IDENTITY_BOUNDARY_CHANNEL, 'nv-identity-boundary-v1');
  assert.strictEqual(IDENTITY_BOUNDARY_STORAGE_KEY, 'nv_identity_boundary_event');
});

check('told by another tab, a tab purges and starts again, once, and hears nothing else', async () => {
  const world = boundaryWorld();
  world.boundary.listen();
  assert.deepStrictEqual(world.log.filter(entry => entry[0] === 'channel-listen'), [['channel-listen', 'message']]);
  world.hear({ type: 'SOMETHING_ELSE' });
  world.hear(null);
  world.storage({ key: 'nv_theme', newValue: 'light' });
  world.storage({ key: 'nv_identity_boundary_event', newValue: null });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(!world.log.some(entry => entry[0] === 'reload' || entry[0] === 'held'), 'nothing heard is a boundary');
  world.hear({ type: 'NV_IDENTITY_BOUNDARY', marker: 'x' });
  world.storage({ key: 'nv_identity_boundary_event', newValue: 'y' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepStrictEqual(world.log.filter(entry => entry[0] === 'reload'), [['reload']], 'told twice, it purges and reloads once');
  const forgotReads = world.log.findIndex(entry => entry[0] === 'reads');
  assert.ok(forgotReads !== -1 && forgotReads < world.log.findIndex(entry => entry[0] === 'reload'), 'purged before the reload, fully');
  assert.strictEqual(world.state.me, null);

  const quiet = boundaryWorld({ channel: 'none' });
  quiet.boundary.listen();
  assert.strictEqual(quiet.storageListeners.length, 1, 'with no channel, storage still carries it');
  quiet.storage({ key: 'nv_identity_boundary_event', newValue: 'z' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepStrictEqual(quiet.log.filter(entry => entry[0] === 'reload'), [['reload']]);
});

/* ---- Who an answer names ------------------------------------------------------------- */

check('only a GitHub account is a reader; anything else is refused as unauthorized', () => {
  assert.strictEqual(githubIdentity({ provider: 'github', login: 'a' }), true);
  for (const other of [null, undefined, 'github', { provider: 'gitlab' }, { login: 'a' }, { provider: 'GitHub' }]) assert.strictEqual(githubIdentity(other), false, String(other));
  const account = { provider: 'github', login: 'a' };
  assert.strictEqual(requireGithubIdentity(account), account);
  assert.throws(() => requireGithubIdentity({ provider: 'gitlab' }), error => error.message === 'Connect a GitHub account to continue.' && error.status === 401);
});

/* ---- Signing in and out -------------------------------------------------------------- */

function sessionWorld(over = {}) {
  const log = [];
  const view = { token: 'token' in over ? over.token : ' github_pat_x ', back: !!over.back, busy: false };
  const answers = {
    '/api/login': { provider: 'github', login: 'arriving', avatar: 'https://avatars.example/a', name: 'A' },
    '/api/me': { provider: 'github', login: 'arriving', caps: { search: 1 }, offlineCacheScope: 's' },
    '/api/logout': { ok: true, revocationGuidance: [{ label: 'Revoke', url: 'https://github.com/settings/tokens' }] },
    ...(over.answers || {})
  };
  let release = () => {};
  const deps = {
    api: async (path, options) => {
      log.push(['api', path, options ? JSON.stringify(options) : '']);
      if (over.hold === path) await new Promise(resolve => { release = resolve; });
      const answer = answers[path];
      if (answer instanceof Error) throw answer;
      return answer;
    },
    purge: async full => log.push(['purge', full]),
    broadcast: () => log.push(['broadcast']),
    token: () => view.token.trim(),
    clearToken: () => { view.token = ''; log.push(['clear-token']); },
    hideError: () => log.push(['hide-error']),
    setBusy: busy => { view.busy = busy; log.push(['busy', busy]); },
    backShown: () => view.back,
    showBack: shown => { view.back = shown; log.push(['back', shown]); },
    adopt: me => log.push(['adopt', me && JSON.stringify(me)]),
    adoptCapabilities: caps => log.push(['caps', JSON.stringify(caps)]),
    remember: me => { if (over.remember === 'throw') throw new Error('storage'); log.push(['remember', me.login]); },
    loadProviderCapabilities: async () => log.push(['provider-caps']),
    applyCaps: () => log.push(['apply-caps']),
    setAvatar: url => log.push(['avatar', url]),
    toast: (message, kind) => log.push(['toast', message, kind || '']),
    presentError: error => log.push(['error', error.message]),
    showRevocationGuidance: guidance => log.push(['guidance', JSON.stringify(guidance)]),
    arrive: () => log.push(['arrive']),
    showSignIn: () => log.push(['sign-in']),
    showWorkspace: () => log.push(['workspace']),
    restart: () => log.push(['restart'])
  };
  return { session: createSession(deps), log, view, release: () => release() };
}

check('a sign-in crosses the boundary before the server is asked, and arrives as who the server answers for', async () => {
  const { session, log, view } = sessionWorld({ back: true });
  await session.signIn();
  assert.deepStrictEqual(log, [
    ['hide-error'], ['busy', true], ['purge', true],
    ['api', '/api/login', JSON.stringify({ method: 'POST', body: { token: 'github_pat_x', provider: 'github' } })],
    ['adopt', JSON.stringify({ provider: 'github', login: 'arriving', avatar: 'https://avatars.example/a', name: 'A' })],
    ['api', '/api/me', ''],
    ['adopt', JSON.stringify({ provider: 'github', login: 'arriving', avatar: 'https://avatars.example/a', name: 'A', caps: { search: 1 }, offlineCacheScope: 's' })],
    ['caps', JSON.stringify({ search: 1 })], ['remember', 'arriving'], ['provider-caps'],
    ['broadcast'], ['back', false], ['apply-caps'], ['clear-token'], ['avatar', 'https://avatars.example/a'],
    ['toast', 'Welcome aboard, arriving ✦', 'ok'], ['arrive'], ['busy', false]
  ]);
  assert.strictEqual(view.token, '');
});

check('no token, no request; a /api/me that fails still signs in; a non-GitHub answer is refused', async () => {
  const empty = sessionWorld({ token: '   ' });
  await empty.session.signIn();
  assert.deepStrictEqual(empty.log, [['hide-error']]);

  const meFails = sessionWorld({ answers: { '/api/me': new Error('Service waking') } });
  await meFails.session.signIn();
  assert.ok(!meFails.log.some(entry => entry[0] === 'caps' || entry[0] === 'remember' || entry[0] === 'error'));
  assert.deepStrictEqual(meFails.log.slice(-3), [['toast', 'Welcome aboard, arriving ✦', 'ok'], ['arrive'], ['busy', false]]);
  assert.ok(meFails.log.some(entry => entry[0] === 'broadcast'));

  const storageRefuses = sessionWorld({ remember: 'throw' });
  await storageRefuses.session.signIn();
  assert.ok(!storageRefuses.log.some(entry => entry[0] === 'provider-caps'), 'as it always was: the rest of what /api/me adds waits for the next start');
  assert.ok(storageRefuses.log.some(entry => entry[0] === 'arrive'));

  const gitlab = sessionWorld({ answers: { '/api/login': { provider: 'gitlab', login: 'x' } } });
  await gitlab.session.signIn();
  assert.deepStrictEqual(gitlab.log.slice(-3), [['hide-error'], ['error', 'Connect a GitHub account to continue.'], ['busy', false]]);
  assert.ok(!gitlab.log.some(entry => entry[0] === 'broadcast' || entry[0] === 'adopt'), 'nobody adopted, no other tab told');
});

check('a failed attempt to add an account sends the reader back to a workspace started again, not an empty one', async () => {
  const adding = sessionWorld({ back: true, answers: { '/api/login': Object.assign(new Error('Bad credentials'), { status: 401 }) } });
  await adding.session.signIn();
  assert.deepStrictEqual(adding.log.slice(-3), [['hide-error'], ['error', 'Bad credentials'], ['busy', false]]);
  adding.session.back();
  assert.deepStrictEqual(adding.log.slice(-2), [['back', false], ['restart']], 'the page let go of the workspace; going back starts it again as whoever the server answers for');
  adding.view.back = true;
  adding.session.back();
  assert.deepStrictEqual(adding.log.slice(-2), [['back', false], ['workspace']], 'once started again, back is back');

  const first = sessionWorld({ answers: { '/api/login': new Error('Bad credentials') } });
  await first.session.signIn();
  first.session.back();
  assert.deepStrictEqual(first.log.slice(-2), [['back', false], ['workspace']], 'nobody was signed in: there was no workspace to let go of');

  const succeeded = sessionWorld({ back: true });
  await succeeded.session.signIn();
  succeeded.view.back = true;
  succeeded.session.back();
  assert.deepStrictEqual(succeeded.log.slice(-1), [['workspace']], 'a sign-in that succeeded let go of nothing the reader goes back to');
});

check('signed in after a failed attempt, the workspace is the new reader\'s and back is back', async () => {
  let fail = true;
  const log = [];
  /* The same session, first refused, then let in. */
  const answers = { '/api/login': () => (fail ? Promise.reject(new Error('Bad credentials')) : Promise.resolve({ provider: 'github', login: 'second', avatar: '' })), '/api/me': () => Promise.resolve({ provider: 'github', login: 'second' }) };
  const session = createSession({
    api: async path => { log.push(['api', path]); return answers[path](); },
    purge: async () => {}, broadcast: () => log.push(['broadcast']), token: () => 'github_pat_z', clearToken: () => {}, hideError: () => {}, setBusy: () => {},
    backShown: () => true, showBack: shown => log.push(['back', shown]), adopt: () => {}, adoptCapabilities: () => {}, remember: () => {},
    loadProviderCapabilities: async () => {}, applyCaps: () => {}, setAvatar: () => {}, toast: () => {}, presentError: () => {}, showRevocationGuidance: () => {},
    arrive: () => log.push(['arrive']), showSignIn: () => {}, showWorkspace: () => log.push(['workspace']), restart: () => log.push(['restart'])
  });
  await session.signIn();
  fail = false;
  await session.signIn();
  session.back();
  assert.deepStrictEqual(log.slice(-2), [['back', false], ['workspace']], 'the reader who arrived has their own workspace; nothing to start again');
});

check('a sign-out lets go of this browser\'s data, tells the other tabs, and shows what to revoke by hand', async () => {
  const { session, log } = sessionWorld();
  await session.signOut();
  assert.deepStrictEqual(log, [
    ['api', '/api/logout', JSON.stringify({ method: 'POST' })], ['purge', true], ['broadcast'], ['adopt', null], ['sign-in'],
    ['guidance', JSON.stringify([{ label: 'Revoke', url: 'https://github.com/settings/tokens' }])]
  ]);
});

check('a sign-out the server could not take still lets go of this browser\'s data, and says what failed', async () => {
  const { session, log } = sessionWorld({ answers: { '/api/logout': new Error('Network unavailable') } });
  await session.signOut();
  assert.deepStrictEqual(log.slice(1), [['purge', true], ['broadcast'], ['adopt', null], ['sign-in'], ['error', 'Network unavailable']]);
});

check('a sign-out still in progress at the provider leaves the reader signed in, everything as it was, and says so', async () => {
  const { session, log } = sessionWorld({ answers: { '/api/logout': { ok: false, status: 'pending', results: [] } } });
  await session.signOut();
  assert.deepStrictEqual(log, [
    ['api', '/api/logout', JSON.stringify({ method: 'POST' })],
    ['toast', 'Sign-out is waiting on the provider\'s clean-up. You are still signed in; keep this page open and sign out again shortly.', '']
  ], 'no purge, no other tab told, no sign-in screen over a session that is still there');
  const done = sessionWorld({ answers: { '/api/logout': { ok: false, status: 'refused' } } });
  await done.session.signOut();
  assert.ok(done.log.some(entry => entry[0] === 'purge'), 'only "pending" holds the sign-out back');
});

check('a second press while a sign-out is on its way is the same sign-out', async () => {
  const world = sessionWorld({ hold: '/api/logout' });
  const first = world.session.signOut();
  const second = world.session.signOut();
  assert.strictEqual(first, second);
  world.release();
  await first;
  assert.deepStrictEqual(world.log.filter(entry => entry[0] === 'api'), [['api', '/api/logout', JSON.stringify({ method: 'POST' })]], 'one request, never a second that comes back "not signed in"');
  assert.strictEqual(world.log.filter(entry => entry[0] === 'purge').length, 1);
  const again = world.session.signOut();
  assert.notStrictEqual(again, first);
  world.release();
  await again;
  assert.strictEqual(world.log.filter(entry => entry[0] === 'api').length, 2, 'once it has ended, a press is a new sign-out');
});

/* A check that never settles would let the process end quietly: unfinished counts as failed. */
process.exitCode = 1;
(async () => {
  let failed = 0;
  for (const [name, run] of checks) {
    try { await run(); console.log(`  ok  ${name}`); } catch (error) { failed += 1; console.error(`  FAIL ${name}\n       ${error.message}`); }
  }
  if (failed) { console.error(`${failed} of ${checks.length} session checks failed`); return; }
  console.log(`page session tests passed (${checks.length} checks)`);
  process.exitCode = 0;
})();
