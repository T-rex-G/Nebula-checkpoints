'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const neural = fs.readFileSync(path.join(root, 'public/neural.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');

function declaration(source, name, indent = '') {
  const start = source.indexOf(`${indent}async function ${name}(`);
  const end = source.indexOf(`\n${indent}}\n`, start);
  assert(start >= 0 && end > start, `${name} must be an executable function declaration`);
  return source.slice(start, end + indent.length + 2);
}

function browser(options = {}) {
  const effects = [];
  const state = {
    work: { owner: 'incident-owner', repo: 'incident-repo', branch: 'incident-branch' },
    me: { login: 'incident-operator' }, uiEpoch: 0
  };
  const stored = new Map();
  const button = { disabled: false };
  const containment = {
    manifestId: 'incident-id', signature: 'synthetic-signature', signatureValid: true,
    persisted: false, evidence: null,
    manifest: {
      kind: 'nebulaverse-emergency-manifest', owner: 'incident-owner', repo: 'incident-repo',
      refs: [{ name: 'incident-branch', sha: 'a'.repeat(40) }],
      controls: { readOnly: true, freezeSync: true, sessionsRevoked: 2, sessionRevocationAvailable: true }
    }
  };
  const sandbox = {
    state,
    NVN: { data: { safety: { globalControls: options.globalControls !== false } } },
    window: { NebulaPwa: {} },
    workPath: () => `${state.work.owner}/${state.work.repo}`,
    modal: async input => {
      effects.push(['modal', input]);
      if (input.title === 'Activate Emergency Shield') {
        if (options.beforeConfirmation) options.beforeConfirmation(state);
        return options.cancelConfirmation !== true;
      }
      return true;
    },
    document: {
      getElementById: id => id === 'neuralEmergencyConfirm' ? { value: 'FREEZE' } : button,
      body: { classList: { toggle: (...args) => effects.push(['class', ...args]) } }
    },
    stepUpApi: async (...args) => {
      effects.push(['contain', ...args]);
      if (options.containmentError) throw options.containmentError;
      if (options.afterContainment) options.afterContainment(state);
      return options.cancelStepUp ? null : options.containment || containment;
    },
    api: async url => { effects.push(['activity', url]); return { commits: [] }; },
    setStream: (...args) => effects.push(['stream', ...args]),
    toast: (...args) => effects.push(['toast', ...args]),
    nEsc: value => String(value),
    nNum: value => Number(value),
    localStorage: {
      setItem(key, value) {
        if (options.storageError) throw new Error('Browser storage is full');
        stored.set(key, JSON.parse(value));
      },
      removeItem: key => stored.delete(key)
    },
    dlFile: (...args) => {
      if (options.downloadError) throw new Error('Download unavailable');
      effects.push(['download', ...args]);
    },
    location: { reload: () => effects.push(['reload']) },
    clearActivityFeed() {}, clearPosture() {}, paintUnread() {}, clearCsrfToken() {},
    clearGovernanceState() {}, clearExposureState() {}, clearAuditState() {}, clearSiteScanState() {},
    purgePrivateCaches: async () => {
      effects.push(['purge']);
      if (options.duringPurge) options.duringPurge(state);
    },
    sessionStorage: { clear() {} },
    navigator: { serviceWorker: {} },
    idb: async () => ({
      transaction() {
        const tx = { objectStore: () => ({ clear() {} }) };
        queueMicrotask(() => tx.oncomplete());
        return tx;
      }
    }),
    forgetRepositoryWork() {},
    $: () => null,
    _cache: { clear() {} }
  };
  vm.createContext(sandbox);
  vm.runInContext(`${declaration(app, 'purgeLocalData')}\nwindow.NebulaPwa.purgePrivateData = purgeLocalData;`, sandbox);
  vm.runInContext(`${declaration(neural, 'emergencyShield', '  ')}\nthis.run = emergencyShield;`, sandbox);
  return { run: sandbox.run, state, effects, stored, button };
}

(async () => {
  const hosted = browser({ globalControls: false });
  await hosted.run();
  assert(!hosted.effects.some(([kind]) => ['modal', 'contain', 'activity', 'purge'].includes(kind)),
    'hosted alpha must refuse identity-wide containment before confirmation or side effects');
  assert(hosted.effects.some(([kind, message]) => kind === 'toast' && message.includes('Safeguards')));

  const success = browser();
  await success.run();
  assert.strictEqual(success.state.work, null, 'the real privacy purge must clear the open repository');
  assert.strictEqual(success.state.me, null, 'the incident response must not resurrect the purged identity');
  assert.strictEqual(success.state.uiEpoch, 1);
  assert(!success.effects.some(([kind]) => kind === 'toast'), 'successful containment must not be reported as failure');
  const incident = success.stored.get('nv_incident_incident-owner/incident-repo');
  assert.strictEqual(incident.repository, 'incident-owner/incident-repo');
  assert.strictEqual(incident.branch, 'incident-branch');
  assert.strictEqual(incident.manifestId, 'incident-id');
  assert.strictEqual(incident.snapshot.owner, 'incident-owner');
  assert(success.effects.some(([kind, filename]) => kind === 'download' && filename.startsWith('nebulaverse-emergency-incident-owner-incident-repo-')));
  assert(success.effects.some(([kind, dialog]) => kind === 'modal' && dialog.title === 'Emergency containment active'));
  assert(success.effects.some(([kind]) => kind === 'reload'), 'reload reconstructs the current authorized session after the purge');
  assert.strictEqual(success.button.disabled, false);

  const switchedRepo = browser({ beforeConfirmation(state) {
    state.work = { owner: 'later-owner', repo: 'later-repo', branch: 'later-branch' };
  } });
  await switchedRepo.run();
  const request = switchedRepo.effects.find(([kind]) => kind === 'contain');
  assert.strictEqual(request[3], '/api/repo/incident-owner/incident-repo/emergency-manifest');
  assert.strictEqual(switchedRepo.stored.get('nv_incident_incident-owner/incident-repo').branch, 'incident-branch');
  assert(!switchedRepo.stored.has('nv_incident_later-owner/later-repo'));

  for (const phase of ['beforeConfirmation', 'afterContainment', 'duringPurge']) {
    const changed = browser({ [phase](state) { state.uiEpoch++; } });
    await changed.run();
    assert.strictEqual(changed.stored.size, 0, `${phase}: never persist an old identity's incident after an account boundary`);
    assert(!changed.effects.some(([kind]) => ['download', 'reload'].includes(kind)), `${phase}: never deliver a stale incident to the next session`);
  }

  for (const flag of ['cancelConfirmation', 'cancelStepUp']) {
    const cancelled = browser({ [flag]: true });
    await cancelled.run();
    assert(cancelled.state.work, 'cancelling must not purge repository state');
    assert(!cancelled.effects.some(([kind]) => ['purge', 'download', 'reload'].includes(kind)));
  }

  const unavailableDelivery = browser({ storageError: true, downloadError: true });
  await unavailableDelivery.run();
  const deliveryDialog = unavailableDelivery.effects.filter(([kind]) => kind === 'modal').at(-1)[1];
  assert.strictEqual(deliveryDialog.title, 'Emergency containment active');
  assert(deliveryDialog.bodyHTML.includes('not saved in this browser'));
  assert(deliveryDialog.bodyHTML.includes('download unavailable'));
  assert(!unavailableDelivery.effects.some(([kind]) => kind === 'toast'), 'a local evidence delivery failure must not claim server controls failed');

  const interrupted = browser({ containmentError: new Error('Response lost after safety save') });
  await interrupted.run();
  const notice = interrupted.effects.find(([kind]) => kind === 'toast')[1];
  assert(notice.includes('completion could not be confirmed'));
  assert(notice.includes('Controls may already be active'));
  assert(interrupted.state.work, 'an unconfirmed response must preserve recovery context');
  assert.strictEqual(interrupted.button.disabled, false);

  console.log('Corona emergency containment regressions passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
