'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const serviceWorker = fs.readFileSync(path.join(root, 'public', 'sw.js'), 'utf8');

for (const label of [
  'Disconnect from Nebulaverse-X',
  'Revoke at provider',
  'End alpha session',
  'Delete alpha data'
]) assert(html.includes(label), `missing distinct privacy action: ${label}`);

const start = app.indexOf('async function purgeLocalData');
const end = app.indexOf('async function doLogout', start);
const block = app.slice(start, end);
assert(start >= 0 && end > start, 'purgeLocalData must remain a discrete account-boundary function');
assert(block.includes("tx.objectStore('queue').clear()"));
assert(block.includes('sessionStorage.clear()'));
assert(block.includes("localStorage.removeItem('nv_me')"));
assert(block.includes('purgePrivateCaches'));
assert(block.includes('state.staged = []'));
assert(block.includes('state.file = null'));
assert(block.includes('state.work = null'));
assert(block.includes('state.repos = []'));
assert(block.includes('state.me = null'));
assert(block.includes('paintUnread([])'),
  'the purge must clear the notification unread marker at the account boundary');
assert(block.includes('clearCsrfToken'));
assert(block.includes("postMessage({ type: 'NV_PURGE_PRIVATE_DATA' })"));
assert(app.includes('/api/alpha/providers/disconnect-all'));
assert(app.includes('/api/alpha/delete'));
assert(app.includes("confirm: 'DELETE ALPHA DATA'"));
assert(serviceWorker.includes("event.data.type !== 'NV_PURGE_PRIVATE_DATA'"));
assert(serviceWorker.includes("key.startsWith('nv-api-')"));
assert(!/NV_PURGE_PRIVATE_DATA[\s\S]{0,500}nv-static-/.test(serviceWorker),
  'identity purge must preserve the static shell cache');

function functionSource(name) {
  const marker = `async function ${name}`;
  const start = app.indexOf(marker);
  assert(start >= 0, `missing browser function ${name}`);
  const end = app.indexOf('\n}\n', start);
  assert(end > start, `browser function ${name} is not a discrete declaration`);
  return app.slice(start, end + 2);
}

function browserFunction(name, sandbox) {
  vm.runInNewContext(`${functionSource(name)}\nthis.target = ${name};`, sandbox, {
    filename: 'public/app.js'
  });
  return sandbox.target;
}

async function assertPendingPrivacyActionsPreserveRetryState() {
  for (const action of ['disconnectAlphaProviders', 'deleteAlphaData']) {
    const effects = [];
    const sandbox = {
      api: async path => {
        effects.push(['api', path]);
        return { ok: false, status: 'pending', results: [] };
      },
      purgeLocalData: async () => effects.push(['purge']),
      showPage: page => effects.push(['page', page]),
      toast: (message, kind) => effects.push(['toast', message, kind]),
      modal: async () => true,
      $: () => ({ value: 'DELETE ALPHA DATA' }),
      alphaRevocationGuidanceBody: () => 'provider guidance'
    };
    const fn = browserFunction(action, sandbox);
    await fn(false);
    assert.deepStrictEqual(
      effects.filter(([kind]) => ['purge', 'page'].includes(kind)),
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
    clearActivityFeed: () => operations.push(['activity-feed']),
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
    _cache: { clear: () => operations.push(['memory-cache']) },
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
  const purge = browserFunction('purgeLocalData', sandbox);
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
}

(async () => {
  await assertPendingPrivacyActionsPreserveRetryState();
  await assertPurgeClearsRuntimeAndVisibleIdentityState();
  console.log('alpha browser purge tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
