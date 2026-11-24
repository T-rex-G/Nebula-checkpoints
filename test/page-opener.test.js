'use strict';

/*
 * Opening a repository, asked directly: the recent list and who is visiting
 * (features/repositories/recent-repositories.ts), the header's name
 * (repository-header.ts), the trust summary's lines (repository-trust.ts),
 * and the open itself (repository-opener.ts).
 */

const assert = require('assert');
const { RECENT_REPOSITORIES, RECENT_LIMIT, recentRepositories, rememberRepository, repositoryVisitor, VISITOR_TABS } = require('../apps/web/src/features/repositories/recent-repositories.ts');
const { nameRepository } = require('../apps/web/src/features/repositories/repository-header.ts');
const { LOADING_SUMMARY, UNAVAILABLE_SUMMARY, trustSummary } = require('../apps/web/src/features/repositories/repository-trust.ts');
const { createRepositoryOpener } = require('../apps/web/src/features/repositories/repository-opener.ts');

const checks = [];
const check = (name, run) => checks.push([name, run]);
const flush = () => new Promise(resolve => setImmediate(resolve));

function storage(initial = {}) {
  const held = { ...initial };
  const writes = [];
  return { held, writes, store: { getItem: key => (key in held ? held[key] : null), setItem: (key, value) => { writes.push(key); held[key] = value; } } };
}

/* ---- The recent list and who is visiting ---------------------------------------------------- */

check('the recent list is read back as names, kept to five, and a visitor marked', () => {
  const s = storage({ [RECENT_REPOSITORIES]: JSON.stringify([
    { owner: 'a', name: 'one' }, { owner: 'b', name: 'two', visitor: true }, { owner: 'c', name: 'three', visitor: 'yes', extra: 1 },
    null, 'x', { owner: 'bad owner', name: 'x' }, { owner: 'd', name: 4 }, { owner: 'd', name: 'four' }, { owner: 'e', name: 'five' }, { owner: 'f', name: 'six' }
  ]) });
  assert.deepStrictEqual(recentRepositories(() => s.store), [
    { owner: 'a', name: 'one' }, { owner: 'b', name: 'two', visitor: true }, { owner: 'c', name: 'three' }, { owner: 'd', name: 'four' }, { owner: 'e', name: 'five' }
  ]);
  assert.strictEqual(RECENT_LIMIT, 5);
  assert.strictEqual(RECENT_REPOSITORIES, 'nv_recent:repositories');
  for (const bad of ['not json', '{"a":1}', '7']) assert.deepStrictEqual(recentRepositories(() => storage({ [RECENT_REPOSITORIES]: bad }).store), [], bad);
  assert.deepStrictEqual(recentRepositories(() => storage().store), []);
  assert.deepStrictEqual(recentRepositories(() => { throw new Error('denied'); }), []);
});

check('a repository is remembered first, once whatever its case, the list kept to five; a refusing storage keeps none', () => {
  const s = storage({ [RECENT_REPOSITORIES]: JSON.stringify([{ owner: 'a', name: 'one' }, { owner: 'Octo', name: 'Repo' }, { owner: 'c', name: 'three' }, { owner: 'd', name: 'four' }, { owner: 'e', name: 'five' }]) });
  rememberRepository(() => s.store, 'octo', 'repo', true);
  assert.deepStrictEqual(JSON.parse(s.held[RECENT_REPOSITORIES]), [{ owner: 'octo', name: 'repo', visitor: true }, { owner: 'a', name: 'one' }, { owner: 'c', name: 'three' }, { owner: 'd', name: 'four' }, { owner: 'e', name: 'five' }]);
  rememberRepository(() => s.store, 'new', 'one');
  assert.deepStrictEqual(JSON.parse(s.held[RECENT_REPOSITORIES]).map(r => `${r.owner}/${r.name}`), ['new/one', 'octo/repo', 'a/one', 'c/three', 'd/four']);
  assert.strictEqual(s.writes.length, 2, 'written once each');
  assert.doesNotThrow(() => rememberRepository(() => { throw new Error('denied'); }, 'a', 'b'));
  const refusing = { getItem: () => '[]', setItem: () => { throw new Error('quota'); } };
  assert.doesNotThrow(() => rememberRepository(() => refusing, 'a', 'b'));
});

check('who is visiting, and what a visitor is not offered', () => {
  for (const permission of ['read', 'triage', 'none']) assert.strictEqual(repositoryVisitor(permission), true, permission);
  for (const permission of ['write', 'maintain', 'admin', undefined, null, 'READ', 'toString']) assert.strictEqual(repositoryVisitor(permission), false, String(permission));
  assert.deepStrictEqual([...VISITOR_TABS].sort(), ['governance', 'safeguards', 'upload']);
});

check('the header names the owner apart from the repository, as text, with the full name as its title', () => {
  const made = [];
  const doc = { createElement: tag => { const el = { tag, className: '', textContent: '' }; made.push(el); return el; }, createTextNode: text => ({ text }) };
  const host = { title: '', children: [], replaceChildren(...nodes) { this.children = nodes; } };
  nameRepository(host, doc, '<b>octo</b>', 're<po>');
  assert.deepStrictEqual(host.children, [{ tag: 'span', className: 'repo-owner', textContent: '<b>octo</b>/' }, { text: 're<po>' }]);
  assert.strictEqual(host.title, '<b>octo</b>/re<po>');
  assert.doesNotThrow(() => nameRepository(null, doc, 'a', 'b'));
});

/* ---- The trust summary ---------------------------------------------------------------------- */

const ok = value => ({ status: 'fulfilled', value });
const no = () => ({ status: 'rejected', reason: new Error('x') });
const chain = (over = {}) => ({ available: true, chain: { available: true, valid: true, checked: 4, ...over }, events: [1, 2], snapshots: [1] });

check('the trust summary says each line from its reading, and never claims a clean result it did not get', () => {
  const clean = trustSummary(ok({ connected: true }), ok({ risk: { severity: 'normal' } }), ok(chain()));
  assert.deepStrictEqual(clean, {
    connection: { text: 'Repository is current and verified live events are connected.', evidenceState: 'Provider-verified' },
    pipeline: { text: 'Evidence chain verified across 4 record(s).', evidenceState: 'Deterministic' },
    risk: { text: 'No issue was found in the provider access inventory.', evidenceState: 'Provider-verified' },
    action: { text: 'No immediate corrective action is indicated. Continue with the golden path.', evidenceState: 'Inferred' },
    evidence: { text: '4 chained record(s), 2 event(s), and 1 snapshot(s) support this summary.', evidenceState: 'Deterministic' },
    announcement: 'Repository trust summary updated.'
  });
  const failed = trustSummary(no(), no(), no());
  assert.deepStrictEqual([failed.connection.evidenceState, failed.pipeline.evidenceState, failed.risk.evidenceState, failed.action.text, failed.evidence.evidenceState, failed.announcement],
    ['Unavailable', 'Unavailable', 'Unavailable', 'Retry unavailable trust checks before making a sensitive change.', 'Unavailable', 'Repository trust summary updated with 3 unavailable checks.']);
  assert.strictEqual(trustSummary(no(), ok({}), ok(chain())).announcement, 'Repository trust summary updated with 1 unavailable check.');
  assert.strictEqual(trustSummary(ok({ available: false, reason: 'no webhook' }), ok({}), ok(chain())).connection.text, 'Repository responded; verified live events are unavailable: no webhook');
  assert.strictEqual(trustSummary(ok({ available: false }), ok({}), ok(chain())).connection.text, 'Repository responded; verified live events are unavailable.');
  assert.strictEqual(trustSummary(ok({ connected: false }), ok({}), ok(chain())).connection.text, 'Repository is current; verified live events are not connected.');
});

check('the most pressing action is the first that applies, in order', () => {
  const action = (live, access, evidence) => trustSummary(ok(live), ok(access), ok(evidence)).action.text;
  assert.strictEqual(action({ connected: true }, { partial: true, risk: { severity: 'critical' } }, chain()), 'Refresh the access inventory with sufficient provider permissions.');
  assert.strictEqual(action({ connected: true }, { risk: { severity: 'warning', score: 40, reasons: [{ message: 'Too many admins' }] } }, chain()), 'Review the access surface and resolve the highest-scoring reason first.');
  assert.strictEqual(action({ connected: true }, {}, { available: false }), 'Connect durable evidence storage before relying on audit history.');
  assert.strictEqual(action({ connected: true }, {}, chain({ valid: false })), 'Re-verify the evidence chain before relying on audit history.');
  assert.strictEqual(action({ connected: false }, {}, chain()), 'Connect verified live events if current event evidence is required.');
  const risky = trustSummary(ok({ connected: true }), ok({ risk: { severity: 'critical', score: '91', reasons: [{ message: 'Admin token in CI' }] } }), ok(chain()));
  assert.strictEqual(risky.risk.text, 'Critical access risk (91/100): Admin token in CI');
  assert.strictEqual(trustSummary(ok({}), ok({ risk: { severity: 'warning' } }), ok(chain())).risk.text, 'Warning access risk (0/100): review the access surface.');
  assert.strictEqual(trustSummary(ok({}), ok({ partial: true }), ok(chain())).risk.text, 'Access inventory is partial; risk may be understated.');
  assert.strictEqual(trustSummary(ok({}), ok({}), ok(chain({ valid: false }))).pipeline.text, 'Evidence verification did not pass. Treat the pipeline as stale.');
  assert.strictEqual(trustSummary(ok({}), ok({}), ok(chain({ checked: 'x' }))).pipeline.text, 'Evidence chain verified.');
  assert.strictEqual(trustSummary(ok({}), ok({}), ok({ available: true, chain: { available: true, valid: true } })).evidence.text, '0 chained record(s), 0 event(s), and 0 snapshot(s) support this summary.');
  assert.ok(LOADING_SUMMARY.announcement === 'Repository opened. Trust checks are running.' && UNAVAILABLE_SUMMARY.pipeline.evidenceState === 'Unavailable');
});

/* ---- The open ------------------------------------------------------------------------------- */

function world(over = {}) {
  const log = [];
  const pending = [];
  const state = { me: 'me' in over ? over.me : { login: 'ada' }, work: { owner: 'last', repo: 'one' }, opening: null };
  const s = storage();
  let arriving = over.arriving || null;
  const pressed = 'pressed' in over ? over.pressed : { isConnected: true, focus: options => log.push(['focus', options]) };
  const opener = createRepositoryOpener({
    state,
    api: path => new Promise((resolve, reject) => { log.push(['api', path]); pending.push({ path, resolve, reject }); }),
    arriving: () => arriving,
    pressed: () => pressed,
    showPage: name => { log.push(['page', name]); return Promise.resolve(); },
    resetViews: () => log.push(['reset', state.work]),
    emptyWorkbench: () => log.push(['empty']),
    name: (owner, repo) => log.push(['name', owner, repo]),
    badges: (p, v) => log.push(['badges', p, v]),
    readOnly: v => log.push(['readOnly', v]),
    branches: (names, def) => log.push(['branches', names, def]),
    arrive: () => log.push(['arrive', state.work && state.work.repo]),
    drawTrust: summary => log.push(['trust', summary.announcement]),
    presentError: error => log.push(['error', error && error.message]),
    star: (work, starred) => log.push(['star', work.repo, starred]),
    storage: () => s.store
  });
  const take = path => { const i = pending.findIndex(p => p.path === path); assert.ok(i !== -1, `nothing asked of ${path}: ${pending.map(p => p.path)}`); return pending.splice(i, 1)[0]; };
  return {
    log, state, opener, s, pending,
    async answer(path, value) { take(path).resolve(value); await flush(); },
    async refuse(path, error) { take(path).reject(error); await flush(); },
    arrive: promise => { arriving = promise; }
  };
}
const INFO = { full_name: 'Octo/Repo', default_branch: 'main', private: true, permission: 'write', branches: [{ name: 'main' }, { name: 'dev' }] };

check('an open lets the last repository go at once, names it as typed, then as the provider spells it', async () => {
  const w = world();
  const run = w.opener.open('octo', 'repo');
  await flush();
  assert.deepStrictEqual(w.log.slice(0, 6), [['page', 'work'], ['reset', null], ['name', 'octo', 'repo'], ['badges', false, false], ['empty'], ['api', '/api/repo/octo/repo']]);
  assert.strictEqual(w.state.work, null, 'nothing may act on the last repository meanwhile');
  assert.ok(w.state.opening, 'the open is held while it is on its way');
  await w.answer('/api/repo/octo/repo', INFO);
  assert.strictEqual(await run, true);
  assert.strictEqual(w.state.opening, null);
  assert.deepStrictEqual(w.state.work, { owner: 'Octo', repo: 'Repo', branch: 'main', ...INFO, visitor: false });
  const after = w.log.slice(6).filter(e => e[0] !== 'api');
  assert.deepStrictEqual(after.slice(0, 5), [['name', 'Octo', 'Repo'], ['badges', true, false], ['readOnly', false], ['branches', ['main', 'dev'], 'main'], ['arrive', 'Repo']]);
  assert.deepStrictEqual(w.log.filter(e => e[0] === 'api').map(e => e[1]).slice(1), ['/api/repo/Octo/Repo/live-events/status', '/api/repo/Octo/Repo/access-surface', '/api/repo/Octo/Repo/evidence', '/api/repo/Octo/Repo/star']);
  assert.deepStrictEqual(JSON.parse(w.s.held['nv_recent:repositories']), [{ owner: 'Octo', name: 'Repo' }]);
  await w.answer('/api/repo/Octo/Repo/star', { starred: true });
  assert.deepStrictEqual(w.log.at(-1), ['star', 'Repo', true]);
});

check('a name the provider spells for another repository is not taken; somebody else\'s opens read-only', async () => {
  const w = world();
  const run = w.opener.open('octo', 'repo');
  await w.answer('/api/repo/octo/repo', { ...INFO, full_name: 'someone/else', private: false, permission: 'read' });
  assert.strictEqual(await run, true);
  assert.deepStrictEqual([w.state.work.owner, w.state.work.repo, w.state.work.visitor], ['octo', 'repo', true]);
  assert.ok(!w.log.slice(6).some(e => e[0] === 'name'), 'named once, as typed');
  assert.ok(w.log.some(e => e[0] === 'badges' && e[1] === false && e[2] === true) && w.log.some(e => e[0] === 'readOnly' && e[1] === true));
  assert.deepStrictEqual(JSON.parse(w.s.held['nv_recent:repositories']), [{ owner: 'octo', name: 'repo', visitor: true }]);
  const nested = world();
  const deep = nested.opener.open('group/sub', 'repo');
  await nested.answer('/api/repo/group/sub/repo', { ...INFO, full_name: 'Group/Sub/Repo' });
  await deep;
  assert.deepStrictEqual([nested.state.work.owner, nested.state.work.repo], ['Group/Sub', 'Repo']);
});

check('an open that fails goes back to the list, gives focus back to what was pressed, and says why', async () => {
  const w = world();
  const run = w.opener.open('octo', 'repo');
  await w.refuse('/api/repo/octo/repo', new Error('Not found'));
  assert.strictEqual(await run, false);
  assert.deepStrictEqual(w.log.slice(-3), [['page', 'repos'], ['focus', { preventScroll: true }], ['error', 'Not found']]);
  assert.strictEqual(w.state.work, null);
  for (const pressed of [null, { isConnected: false, focus: () => assert.fail('a control no longer on the page is not focused') }]) {
    const v = world({ pressed });
    const r = v.opener.open('octo', 'repo');
    await v.refuse('/api/repo/octo/repo', new Error('x'));
    assert.strictEqual(await r, false);
    assert.ok(!v.log.some(e => e[0] === 'focus'));
  }
});

check('an answer without its branches is refused before anything is marked open', async () => {
  for (const branches of [undefined, null, 'main', [{ name: 'main' }, null], [7]]) {
    const w = world();
    const run = w.opener.open('octo', 'repo');
    await w.answer('/api/repo/octo/repo', { ...INFO, branches });
    assert.strictEqual(await run, false, JSON.stringify(branches));
    assert.strictEqual(w.state.work, null, 'the workbench holds nothing');
    assert.ok(!w.log.some(e => e[0] === 'badges' && (e[1] || e[2])) && !w.log.some(e => e[0] === 'arrive'));
    assert.deepStrictEqual(w.log.at(-1), ['error', 'The repository answered without its branches, so it was not opened.']);
    assert.strictEqual(w.s.held['nv_recent:repositories'], undefined);
  }
  for (const info of [null, 'text']) {
    const w = world();
    const run = w.opener.open('octo', 'repo');
    await w.answer('/api/repo/octo/repo', info);
    assert.strictEqual(await run, false);
    assert.strictEqual(w.state.work, null);
  }
});

check('an open overtaken by another, or by one while the list comes back, or let go of, leaves the workbench alone', async () => {
  const w = world();
  const first = w.opener.open('a', 'one');
  const second = w.opener.open('b', 'two');
  await w.answer('/api/repo/a/one', INFO);
  assert.strictEqual(await first, null);
  assert.strictEqual(w.state.work, null, 'the overtaken answer opens nothing');
  await w.answer('/api/repo/b/two', { ...INFO, full_name: 'b/two' });
  assert.strictEqual(await second, true);
  assert.strictEqual(w.opener.generation(), 2);
  const overtakenFailure = world();
  const run = overtakenFailure.opener.open('a', 'one');
  overtakenFailure.pending[0].reject(new Error('gone'));
  await Promise.resolve(); await Promise.resolve();
  void overtakenFailure.opener.open('b', 'two');
  assert.strictEqual(await run, null, 'a failure overtaken while the list comes back says nothing');
  assert.ok(!overtakenFailure.log.some(e => e[0] === 'error' || e[0] === 'focus'));
  const forgotten = world();
  const gone = forgotten.opener.open('a', 'one');
  forgotten.opener.forget();
  assert.strictEqual(forgotten.state.opening, null);
  await forgotten.answer('/api/repo/a/one', INFO);
  assert.strictEqual(await gone, null);
  assert.strictEqual(forgotten.state.work, null);
});

check('nothing opens for nobody, and a start-up on its way is waited for', async () => {
  const nobody = world({ me: null });
  assert.strictEqual(await nobody.opener.open('a', 'b'), false);
  assert.deepStrictEqual(nobody.log, []);
  let start;
  const w = world({ me: null, arriving: new Promise(resolve => { start = resolve; }) });
  const run = w.opener.open('a', 'b');
  await flush();
  assert.deepStrictEqual(w.log, [], 'nothing before the start-up lands');
  w.state.me = { login: 'ada' };
  start();
  await flush();
  assert.deepStrictEqual(w.log[0], ['page', 'work']);
  await w.answer('/api/repo/a/b', { ...INFO, full_name: 'a/b' });
  assert.strictEqual(await run, true);
});

check('the trust summary is drawn for the repository open, a late one dropped, and one that cannot be drawn said so', async () => {
  const w = world();
  const run = w.opener.open('octo', 'repo');
  await w.answer('/api/repo/octo/repo', INFO);
  await run;
  assert.deepStrictEqual(w.log.filter(e => e[0] === 'trust').map(e => e[1]), ['Repository opened. Trust checks are running.']);
  await w.answer('/api/repo/Octo/Repo/live-events/status', { connected: true });
  await w.answer('/api/repo/Octo/Repo/access-surface', {});
  await w.answer('/api/repo/Octo/Repo/evidence', chain());
  assert.deepStrictEqual(w.log.filter(e => e[0] === 'trust').map(e => e[1]).at(-1), 'Repository trust summary updated.');
  const late = world();
  const r = late.opener.open('octo', 'repo');
  await late.answer('/api/repo/octo/repo', INFO);
  await r;
  late.state.work = { owner: 'other', repo: 'one' };
  await late.answer('/api/repo/Octo/Repo/live-events/status', {});
  await late.answer('/api/repo/Octo/Repo/access-surface', {});
  await late.answer('/api/repo/Octo/Repo/evidence', {});
  assert.strictEqual(late.log.filter(e => e[0] === 'trust').length, 1, 'a summary for a repository no longer open is dropped');
  const broken = world();
  let calls = 0;
  const opener = createRepositoryOpener({
    state: broken.state, api: path => Promise.resolve(path === '/api/repo/octo/repo' ? INFO : {}), arriving: () => null, pressed: () => null, showPage: () => Promise.resolve(),
    resetViews() {}, emptyWorkbench() {}, name() {}, badges() {}, readOnly() {}, branches() {}, arrive() {},
    drawTrust: summary => { calls += 1; if (calls === 1) throw new Error('cannot draw'); broken.log.push(['trust', summary.announcement]); },
    presentError: error => broken.log.push(['error', error.message]), star() {}, storage: () => broken.s.store
  });
  assert.strictEqual(await opener.open('octo', 'repo'), true);
  await flush();
  assert.deepStrictEqual(broken.log.slice(-2), [['trust', 'Repository trust checks are unavailable.'], ['error', 'cannot draw']]);
  const starless = world();
  const s1 = starless.opener.open('octo', 'repo');
  await starless.answer('/api/repo/octo/repo', INFO);
  await s1;
  starless.state.work = { owner: 'x' };
  await starless.answer('/api/repo/Octo/Repo/star', { starred: true });
  assert.ok(!starless.log.some(e => e[0] === 'star'), 'a star read for a repository no longer open is dropped');
});

(async () => {
  let failed = 0;
  let finished = false;
  process.on('exit', () => { if (!finished) { console.error('not ok - a check never settled'); process.exitCode = 1; } });
  for (const [name, run] of checks) {
    try {
      await run();
      console.log(`ok - ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`not ok - ${name}`);
      console.error(error);
    }
  }
  finished = true;
  if (failed) process.exit(1);
  console.log(`page opener: ${checks.length} checks passed`);
})();
