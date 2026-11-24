'use strict';
/*
 * What the Policy Digital Twin screen says, decided apart from drawing it
 * (apps/web/src/features/governance/governance.ts): who may act, the
 * pipeline, the bars, the ledger a page at a time, the inbox and the exports,
 * and the words for a time. The markup it is drawn as is checked by the
 * governance interface tests.
 */
const assert = require('assert');
const { model, plain } = require('./helpers/governance-view');

/* What the module makes is made in its own context: compared as plain values, since deepStrictEqual also compares prototypes. */
const same = (actual, expected, message) => assert.deepStrictEqual(plain(actual), plain(expected), message);

let failures = 0;
function check(name, run) {
  try { run(); console.log(`ok - ${name}`); } catch (error) { failures += 1; console.error(`not ok - ${name}\n${error.stack}`); }
}

const NOW = Date.parse('2026-09-25T12:00:00.000Z');
const ALL = { read: true, author: true, review: true, activate: true, administer: true };
const reader = (capabilities = ALL, evidence = { status: 'current', expiresAt: '2099-01-01T00:00:00.000Z' }) => model.normalizeInterfaceAccess({
  actor: { login: 'ada' }, execution: { kind: 'user', authMethod: 'oauth' }, capabilities, evidence
}, NOW);
const POLICY = '10000000-0000-4000-8000-000000000001';
const ACTIVE = '20000000-0000-4000-8000-000000000002';
const PENDING = '30000000-0000-4000-8000-000000000003';
const policy = (overrides = {}) => ({
  policyId: POLICY, policyKey: 'release-safety', name: 'Release safety', revision: 4, versionCount: 2,
  active: { versionId: ACTIVE, versionNumber: 1, documentHash: 'a'.repeat(64), enforcementMode: 'warn' }, ...overrides
});
const decisions = n => Array.from({ length: n }, (_, index) => ({
  seq: n - index, action: 'file.write', enforcementOutcome: index % 3 === 0 ? 'block' : 'allow', effectiveEffect: 'deny',
  evaluatedAt: new Date(NOW - index * 60000).toISOString(), decisionHash: 'd'.repeat(64)
}));

check('a time that is missing is unknown, not the first of January 1970', () => {
  for (const missing of [undefined, null, '', 'not a date', {}, true]) {
    assert.strictEqual(model.formatTime(missing), 'Unknown time', `${JSON.stringify(missing)} read as a time`);
    assert.strictEqual(model.ago(missing, NOW), 'unknown time', `${JSON.stringify(missing)} read as an age`);
  }
  assert.match(model.formatTime('2026-09-25T12:00:00.000Z'), /Sep 25, 2026/);
  assert.match(model.formatTime(NOW), /2026/);
});

check('an age is said in minutes, then hours, then days', () => {
  const at = minutes => new Date(NOW - minutes * 60000).toISOString();
  assert.strictEqual(model.ago(at(0.2), NOW), 'just now');
  assert.strictEqual(model.ago(at(59), NOW), '59 min ago');
  assert.strictEqual(model.ago(at(60), NOW), '1 h ago');
  assert.strictEqual(model.ago(at(47 * 60), NOW), '47 h ago');
  assert.strictEqual(model.ago(at(48 * 60), NOW), '2 d ago');
  assert.strictEqual(model.ago(new Date(NOW + 3600000).toISOString(), NOW), 'just now', 'a time ahead of the clock is now, not negative');
});

check('a word is toned by what it means, and anything else is neutral', () => {
  same(['approved', 'allow', 'current', 'valid', 'observe'].map(model.tone), ['ok', 'ok', 'ok', 'ok', 'ok']);
  same(['pending', 'warn', 'partial', 'require-approval'].map(model.tone), ['warn', 'warn', 'warn', 'warn']);
  same(['rejected', 'deny', 'block', 'invalid', 'stale', 'unavailable', 'revoked', 'expired', 'superseded'].map(model.tone),
    ['danger', 'danger', 'danger', 'danger', 'danger', 'danger', 'danger', 'danger', 'danger']);
  same(['weird', '', null, 'APPROVED'].map(model.tone), ['neutral', 'neutral', 'neutral', 'ok']);
  assert.strictEqual(model.human('policy.activated'), 'Policy Activated');
  assert.strictEqual(model.hashShort('a'.repeat(64)), 'aaaaaaaa…aaaaaa');
  assert.strictEqual(model.hashShort('short'), 'not recorded');
  assert.strictEqual(model.hashShort('z'.repeat(64)), 'not recorded', 'sixty-four characters that are not hex are no hash');
  same([3, '4', -1, 2.5, 'x', null].map(model.count), [3, 4, 0, 0, 0, 0]);
});

check('capabilities hold only while their evidence is current, and only when granted as true', () => {
  const current = reader({ read: true, author: 'yes', review: 1, activate: true, administer: false });
  same(plain(current.capabilities), { read: true, author: false, review: false, activate: true, administer: false });
  assert.strictEqual(current.evidence.status, 'current');
  const expired = reader(ALL, { status: 'current', expiresAt: '2020-01-01T00:00:00.000Z' });
  assert.strictEqual(expired.evidence.status, 'stale');
  assert.ok(Object.values(expired.capabilities).every(granted => granted === false), 'expired evidence grants nothing');
  assert.strictEqual(reader(ALL, { status: 'unavailable' }).evidence.status, 'unavailable');
  assert.strictEqual(reader(ALL, { status: 'current' }).evidence.status, 'stale', 'evidence without an expiry is not current');
  assert.strictEqual(reader(ALL, { status: 'current', expiresAt: 'not a date' }).evidence.status, 'stale', 'nor with an expiry that is not a time');
  assert.strictEqual(model.normalizeInterfaceAccess({ execution: { kind: 'installation' } }, NOW).execution.kind, 'installation');
  assert.strictEqual(model.normalizeInterfaceAccess({ execution: { kind: 'root' } }, NOW).execution.kind, 'user');
  assert.ok(Object.isFrozen(current) && Object.isFrozen(current.capabilities));
});

check('a typed value is a JSON object or the reason it is not', () => {
  same(plain(model.parseJsonObject(' {"a":1} ', 'Target')), { a: 1 });
  assert.throws(() => model.parseJsonObject('', 'Target'), /Target must be a JSON object/);
  assert.throws(() => model.parseJsonObject('[1]', 'Target'), /Target must be a JSON object/);
  assert.throws(() => model.parseJsonObject('{', 'Target'), /Target must contain valid JSON/);
  assert.throws(() => model.parseJsonObject(`{"a":"${'x'.repeat(64 * 1024)}"}`, 'Target'), /Target is too large/);
  const request = model.defaultSimulationRequest('');
  assert.ok(request.scenarios.every(scenario => scenario.attributes.branch === 'main'), 'no branch named is main');
  same(request.scenarios.map(scenario => scenario.id),
    ['write-file', 'reset-protected-branch', 'merge-pull-request', 'merge-failing-audit', 'merge-unaudited-head', 'create-release']);
  assert.strictEqual(model.defaultSimulationRequest('x'.repeat(300)).scenarios[0].attributes.branch.length, 200);
});

check('the pipeline lights the first stage holding work, and never the running one', () => {
  const twin = (draftCount, versions, active) => ({ proposed: { draftCount, versions }, current: { activePolicyCount: active } });
  const states = value => plain(model.lifecycle(value)).map(stage => `${stage.id}:${stage.n}:${stage.state}`);
  same(states(twin(0, [{ review: { status: 'pending' } }, { activationReadiness: { eligible: true } }], 2)),
    ['draft:0:empty', 'review:1:work', 'ready:1:held', 'active:2:held']);
  same(states(twin(0, [], 3)), ['draft:0:empty', 'review:0:empty', 'ready:0:empty', 'active:3:held']);
  same(states(twin(0, [{ review: { status: 'approved' } }], 0)), ['draft:0:empty', 'review:0:empty', 'ready:1:work', 'active:0:empty']);
});

check('the bars count modes and outcomes, and say them in words', () => {
  const [modes, outcomes] = plain(model.enforcement({
    current: { policies: [
      policy({ active: { versionId: 'a', enforcementMode: 'enforce' } }), policy({ active: { versionId: 'b', enforcementMode: 'block' } }),
      policy({ active: { versionId: 'c', enforcementMode: 'warn' } }), policy({ active: { versionId: 'd', enforcementMode: 'toString' } }),
      policy({ active: { versionId: 'e' } }), policy({ active: null })
    ] },
    history: { decisions: [{ enforcementOutcome: 'block' }, { enforcementOutcome: 'warn' }, { enforcementOutcome: 'constructor' }, {}] }
  }));
  same(modes.parts.map(part => part.n), [2, 1, 2], 'observe, warn, block');
  assert.strictEqual(modes.said, 'Active policies by mode: 2 observe, 1 warn, 2 block');
  same(outcomes.parts.map(part => part.n), [2, 1, 1]);
  assert.strictEqual(model.bar('Nothing', [{ tone: 'a', word: 'a', n: 0 }]).said, 'Nothing: none');
});

check('the summary counts what the twin holds, and says when more decisions wait', () => {
  const twin = { current: { activePolicyCount: 1, policyCount: 3 }, proposed: { versionCount: 2, draftCount: 1 }, effective: { activeExceptionCount: 4 }, history: { decisions: [{}, {}], nextBeforeDecisionSeq: 0 } };
  same(plain(model.summary(twin)).map(metric => [metric.value, metric.sub]),
    [[1, '3 total'], [2, '1 drafts'], [4, 'actor + target bound'], [2, 'more available']]);
  assert.strictEqual(model.summary({ history: { nextDecisionSeq: null } })[3].sub, 'latest page');
});

check('each role is offered the policy controls it can use', () => {
  const twin = { current: { policies: [policy(), policy({ policyId: 'p2', active: null, switchedOff: { versionId: 'v9', versionNumber: 3 } })] } };
  const actions = cards => cards.map(card => [...card.actions, ...card.lifecycle].map(action => action.action));
  same(actions(model.policyCards(twin, reader({ read: true }))), [['select-policy'], ['select-policy']]);
  const admin = model.policyCards(twin, reader());
  same(actions(admin), [
    ['select-policy', 'new-draft', 'request-exception', 'deactivate-policy', 'archive-policy'],
    ['select-policy', 'new-draft', 'reactivate-policy', 'archive-policy']
  ]);
  assert.strictEqual(admin[1].lifecycle[0].label, 'Turn v3 back on');
  /* Archiving is an administrator's; switching off and back on is an activator's. */
  const activator = model.policyCards(twin, reader({ read: true, activate: true }));
  same(activator.map(card => card.lifecycle.map(action => action.action)), [['deactivate-policy'], ['reactivate-policy']]);
  /* A policy running a newer version, with an older one switched off, offers to switch off, not to come back. */
  const both = model.policyCards({ current: { policies: [policy({ switchedOff: { versionId: 'v0', versionNumber: 1 } })] } }, reader());
  same(both[0].lifecycle.map(action => action.action), ['deactivate-policy', 'archive-policy']);
  same(plain(admin[1].lifecycle[0].data), { 'policy-id': 'p2', revision: 4, 'version-id': 'v9' });
  same(plain(admin[0].facts), [['Revision', '4'], ['Versions', '2'], ['Active', 'v1'], ['Latest review', 'No version']]);
  same(plain(admin[1].badge), { value: 'neutral', label: 'Switched off' });
  same(plain(admin[0].badge), { value: 'warn', label: 'Warn' });
  assert.strictEqual(model.policyCards({ current: { policies: [{ policyKey: '' }] } }, reader())[0].name, 'Unnamed policy');
});

check('a draft is the author\'s to discard, or an administrator\'s', () => {
  const twin = { proposed: { drafts: [{ draftId: 'd1', policyId: POLICY, revision: 2, authoredByLogin: 'alice', updatedAt: '2026-09-25T00:00:00.000Z' }] } };
  const offered = access => model.draftRows(twin, access)[0].actions.map(action => action.action);
  const author = login => model.normalizeInterfaceAccess({ actor: { login }, capabilities: { author: true }, evidence: { status: 'current', expiresAt: '2099-01-01T00:00:00.000Z' } }, NOW);
  same(offered(author('alice')), ['edit-draft', 'validate-draft', 'submit-draft', 'discard-draft']);
  same(offered(author('bob')), ['edit-draft', 'validate-draft', 'submit-draft']);
  assert.strictEqual(model.draftRows(twin, author('alice'))[0].policy, '10000000');
});

check('a version is activated only after a simulation of it that was eligible', () => {
  const twin = { proposed: { versions: [{ policyId: POLICY, policyKey: 'release-safety', versionId: PENDING, versionNumber: 2, review: { status: 'pending', requiredApprovals: 1 } }, { policyKey: 'nameless' }] } };
  const activate = simulation => model.versionRows(twin, reader(), simulation)[0].actions.find(action => action.action === 'activate');
  same(plain(activate(null)), { action: 'activate', label: 'Activate', data: { 'policy-id': POLICY, 'version-id': PENDING }, kind: 'primary', disabled: true, title: 'Run an eligible fresh simulation first' });
  const eligible = { policyId: POLICY, versionId: PENDING, report: { activationReadiness: { eligible: true }, simulationHash: 'e'.repeat(64) } };
  assert.strictEqual(activate(eligible).disabled, false);
  assert.strictEqual(activate({ ...eligible, versionId: 'another' }).disabled, true);
  assert.strictEqual(activate({ ...eligible, report: { activationReadiness: { eligible: 'yes' } } }).disabled, true);
  const rows = model.versionRows(twin, reader(), eligible);
  same(plain(rows[0].simulation), { eligible: true, hash: 'eeeeeeee…eeeeee' });
  assert.strictEqual(rows[0].title, 'release-safety v2');
  assert.strictEqual(rows[0].review, '0/1 approvals · 0 assigned');
  /* A version with no ids is nobody's simulation; an empty one used to match it. */
  assert.strictEqual(model.versionRows(twin, reader(), {})[1].simulation, null);
  same(model.versionRows(twin, reader({ read: true }), null)[0].actions.map(action => action.action), ['view-version', 'simulate']);
  /* A version already decided is not offered for review again. */
  const decided = { proposed: { versions: [{ policyId: POLICY, versionId: PENDING, versionNumber: 2, review: { status: 'approved' } }] } };
  same(model.versionRows(decided, reader(), null)[0].actions.map(action => action.action), ['view-version', 'simulate', 'activate', 'withdraw-version']);
});

check('an exception is decided while pending and revoked once approved, by an administrator', () => {
  const twin = state => ({ history: { exceptions: [{ exceptionId: 'x1', kind: 'temporary_waiver', action: 'file.write', state, expiresAt: '2026-09-26T00:00:00.000Z' }] } });
  const offered = (state, access = reader()) => model.exceptionRows(twin(state), access)[0].actions.map(action => action.action);
  same(offered('pending'), ['view-exception', 'decide-exception']);
  same(offered('approved'), ['view-exception', 'revoke-exception']);
  same(offered('pending', reader({ read: true })), ['view-exception']);
  assert.strictEqual(model.exceptionRows(twin('pending'), reader())[0].title, 'Temporary Waiver · file.write');
});

check('the ledger reads a page at a time, filters by outcome, and clears from view without losing anything', () => {
  const twin = { history: { decisions: decisions(20), activations: [], nextBeforeDecisionSeq: 1 } };
  const first = model.ledger(twin, reader(), null, {}, NOW);
  assert.strictEqual(first.rows.length, 8);
  assert.strictEqual(first.shown, 'Showing 8 of 20');
  same(first.foot.map(action => action.label), ['Show 8 more', 'Load older decisions', 'Clear from view']);
  same(plain(first.foot[1].data), { 'before-seq': '1' });
  same(plain(first.foot[2].data), { through: 20, 'focus-key': 'ledger-clear' });
  same(first.chips.map(chip => `${chip.id}:${chip.n}:${chip.pressed}:${chip.disabled}`), ['all:20:true:false', 'block:7:false:false', 'warn:0:false:true', 'allow:13:false:false']);
  assert.strictEqual(first.tabs[0].more, true);
  const blocked = model.ledger(twin, reader(), null, { filter: 'block', limit: 16 }, NOW);
  assert.ok(blocked.rows.every(row => row.state === 'Blocked') && blocked.rows.length === 7);
  assert.strictEqual(model.ledger(twin, reader(), null, { filter: 'constructor' }, NOW).chips[0].pressed, true, 'a filter not on offer is all');
  assert.strictEqual(model.ledger(twin, reader(), null, { limit: 3 }, NOW).rows.length, 8, 'a page is never smaller than the page size');
  const cleared = model.ledger(twin, reader(), null, { cleared: { decisions: 20 } }, NOW);
  assert.strictEqual(cleared.empty, 'All 20 cleared from view. They are still in the ledger.');
  same(cleared.foot.map(action => action.label), ['Load older decisions', 'Show 20 cleared']);
  assert.strictEqual(cleared.clearedNote, true);
  const shownAgain = model.ledger(twin, reader(), null, { cleared: { decisions: 15 }, showCleared: true }, NOW);
  assert.strictEqual(shownAgain.rows.filter(row => row.cleared).length, 3, 'of the first eight, those through 15 are marked cleared');
  assert.strictEqual(model.ledger({ history: { nextDecisionSeq: 9 } }, reader(), null, {}, NOW).foot[0].data['after-seq'], '9');
  assert.strictEqual(model.ledger({ history: {} }, reader(), null, {}, NOW).empty, 'No runtime decisions yet.');
});

check('an outcome named like the object prototype is read as allowed, not drawn as a function', () => {
  const book = model.ledger({ history: { decisions: [{ seq: 1, enforcementOutcome: 'toString' }] } }, reader(), null, {}, NOW);
  assert.strictEqual(book.rows[0].state, 'Allowed');
  assert.strictEqual(book.rows[0].tone, 'allow');
});

check('an activation offers a way back to it, unless it is the version running', () => {
  const twin = {
    current: { policies: [policy()] },
    history: { activations: [
      { seq: 3, policyId: POLICY, versionId: ACTIVE, action: 'activate', actorLogin: 'admin', createdAt: '2026-09-25T11:00:00.000Z' },
      { seq: 2, policyId: POLICY, versionId: 'older-version-id', action: 'rollback', actorLogin: 'admin' },
      { seq: 1, policyId: 'gone-policy-id', versionId: ACTIVE, action: 'deactivate', actorLogin: 'admin' },
      { seq: 4, policyId: POLICY, versionId: ACTIVE, action: 'deactivate', actorLogin: 'admin' }
    ] }
  };
  const book = model.ledger(twin, reader(), null, { tab: 'activations' }, NOW);
  assert.strictEqual(book.rows[0].restore, 'current');
  same(plain(book.rows[1].restore), { label: 'Roll back to release-safety version older-ve', data: { 'policy-id': POLICY, 'version-id': 'older-version-id' } });
  assert.strictEqual(book.rows[2].restore.label, 'Turn back on gone-pol version 20000000');
  /* Switching off the version that runs now is not the version running: it offers to turn it back on. */
  assert.strictEqual(book.rows[3].restore.label, 'Turn back on release-safety version 20000000');
  same(book.rows.map(row => row.tone), ['allow', 'info', 'warn', 'warn']);
  assert.strictEqual(book.rows[0].when, '1 h ago');
  assert.strictEqual(model.ledger(twin, reader({ read: true }), null, { tab: 'activations' }, NOW).rows[1].restore, null);
  assert.strictEqual(book.chipsLabel, 'Filter activations by kind');
});

check('the chain is said as verified only when it was verified completely', () => {
  const verify = verification => plain(model.ledger({}, reader(), verification, {}, NOW).verify);
  same(verify(null), { label: 'Verify chain', banner: null });
  same(verify({ valid: true, complete: true, checked: 12 }), { label: 'Chain verified', banner: { valid: true, words: 'Decision chain verified · 12 records checked' } });
  same(verify({ valid: true, complete: false }), { label: 'Verify chain', banner: { valid: true, words: 'Decision chain valid through the configured verification limit' } });
  assert.strictEqual(verify({ valid: false, checked: 3 }).banner.words, 'Decision chain verification failed · 3 records checked');
});

check('the inbox shows what is unread a page at a time, and clears through the newest', () => {
  const events = Array.from({ length: 9 }, (_, index) => ({ seq: index + 1, eventType: 'policy.activated', eventHash: 'f'.repeat(64), createdAt: new Date(NOW - index * 60000).toISOString() }));
  const box = model.delivery({ preferences: { lastReadSeq: 2 }, notifications: { events } }, reader(), {}, NOW);
  assert.strictEqual(box.unread, 7);
  assert.strictEqual(box.inbox.length, 6);
  same(box.inboxFoot.map(action => action.label), ['Show 1 more', 'Clear 7', 'Show 2 read']);
  same(plain(box.inboxFoot[1].data), { 'through-seq': 9 });
  assert.strictEqual(box.inbox[0].event, 'Policy Activated');
  const all = model.delivery({ preferences: { lastReadSeq: 2 }, notifications: { events } }, reader(), { showRead: true, inboxLimit: 12 }, NOW);
  assert.strictEqual(all.inbox.length, 9);
  assert.strictEqual(all.inbox.filter(row => row.read).length, 2);
  assert.strictEqual(model.delivery({ notifications: { events: [] } }, reader(), {}, NOW).inboxEmpty, 'No governance notifications.');
  assert.strictEqual(model.delivery({ preferences: { enabled: false } }, reader(), {}, NOW).enabled, false);
});

check('signed exports show the latest four until asked, and webhooks are an administrator\'s', () => {
  const exportsList = Array.from({ length: 6 }, (_, index) => ({ exportId: `e${index}`, format: 'csv', eventCount: index, envelopeHash: 'c'.repeat(64) }));
  const box = model.delivery({ exports: exportsList, webhooks: [{ webhookId: 'w1', name: 'hook', url: 'https://hooks.example.com', eventTypes: 'policy.activated', enabled: false }] }, reader(), {}, NOW);
  assert.strictEqual(box.exports.length, 4);
  same(plain(box.exportsFoot), { shown: 'Showing 4 of 6', toggle: { action: 'exports-all', label: 'Show all 6', data: { 'focus-key': 'exports-all' }, kind: 'ghost', disabled: false, title: '' } });
  assert.strictEqual(box.exports[1].what, 'CSV · 1 events');
  assert.strictEqual(box.webhooks[0].detail, 'Disabled · ', 'event types that are not a list are none, not a crash');
  assert.strictEqual(model.delivery({ webhooks: [{}] }, reader({ read: true, author: true }), {}, NOW).webhooks, null);
  assert.strictEqual(model.delivery({ exports: exportsList }, reader(), { exportsAll: true }, NOW).exportsFoot.toggle.label, 'Show latest only');
});

check('an archived policy comes back only when its key is free, and the reset is spelled out first', () => {
  const rows = model.archivedRows([{ policyId: 'a1', policyKey: 'old', versionCount: 1, keyInUse: true }, { policyId: 'a2', policyKey: 'older', name: 'Older', versionCount: 3 }], reader());
  same(plain(rows[0].restore), { action: 'restore-policy', label: 'Restore', data: { 'policy-id': 'a1', name: 'old' }, kind: 'ghost', disabled: true, title: 'Archive or rename the current policy with this key first' });
  assert.match(rows[0].detail, /· 1 version · a current policy uses this key$/);
  assert.match(rows[1].detail, /· 3 versions$/);
  assert.strictEqual(rows[1].restore.disabled, false);
  assert.strictEqual(model.archivedRows([{}], reader({ read: true }))[0].restore, null);
  const zone = model.dangerZone({ current: { policyCount: 2, activePolicyCount: 1 } }, reader());
  assert.match(zone.words, /^Switches off and archives all 2 policies \(1 running now\)\./);
  same(plain(zone.reset.data), { total: 2, running: 1 });
  assert.strictEqual(model.dangerZone({ current: { policyCount: 0 } }, reader()), null);
  assert.match(model.dangerZone({ current: { policyCount: 1 } }, reader()).words, /^Switches off and archives all 1 policy\. Enforcement stops at once\./);
  assert.strictEqual(model.dangerZone({ current: { policyCount: 2 } }, reader({ read: true, author: true, review: true, activate: true })), null);
});

check('the screen is loading, failed, or ready with what its banners say', () => {
  assert.strictEqual(model.screen({ loading: true, error: 'x' }).kind, 'loading');
  same(plain(model.screen({ error: 'Database <offline>' })), { kind: 'error', message: 'Database <offline>' });
  assert.strictEqual(model.screen({ digitalTwin: {} }).message, 'The Policy Digital Twin response is unavailable or invalid.');
  const ready = model.screen({
    digitalTwin: { schemaVersion: 1, scope: { owner: 'Acme', repo: 'Demo' }, freshness: { completeness: { decisions: false, policy_versions: false, drafts: true } }, current: { policyCount: 0 } },
    access: { execution: { kind: 'installation' } }, archived: [{}, {}], now: NOW
  });
  assert.strictEqual(ready.scope, 'Acme/Demo');
  assert.strictEqual(ready.freshness, 'partial');
  same(plain(ready.incomplete), ['Decisions', 'Policy Versions']);
  assert.strictEqual(ready.snapshot, 'Unknown time');
  assert.strictEqual(ready.noPolicies, true);
  assert.strictEqual(ready.archivedCount, 2);
  assert.strictEqual(ready.executor, 'GitHub App execution · human governance actor');
  assert.strictEqual(ready.access.evidence.status, 'stale');
  assert.strictEqual(model.screen({ digitalTwin: { schemaVersion: 1 }, access: { execution: { authMethod: 'personal_token' } } }).executor, 'Personal Token');
  same(model.screen({ digitalTwin: { schemaVersion: 1, freshness: { completeness: [false, true] } } }).incomplete, [], 'completeness sent as a list names nothing');
});

if (failures) {
  console.error(`${failures} governance interface model check(s) failed`);
  process.exit(1);
}
console.log('governance interface model tests passed');
