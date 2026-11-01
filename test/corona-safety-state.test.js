'use strict';
/*
 * A person's safety controls (Corona's domain) and where they are kept
 * (Corona's application): what a stored record reads as, how a change is
 * applied, and the transaction a change runs in, with every statement and its
 * values, against a scripted database.
 */
const assert = require('assert');
const { applySafetyPatch, defaultSafety, createSafetyState, safetyUnavailable } = require('../apps/api/src/modules/corona/index.ts');

let finished = false;
process.on('exit', code => { if (!finished && code === 0) { console.error('the safety state tests did not finish'); process.exitCode = 1; } });

const refusal = (status, message) => error => {
  assert(error instanceof Error);
  assert.deepStrictEqual([error.status, error.code, error.providerChanged, error.message], [status, 'SAFETY_INPUT_INVALID', false, message]);
  return true;
};
const unavailable = error => {
  assert.deepStrictEqual([error.status, error.code, error.providerChanged], [503, 'SAFETY_STATE_UNAVAILABLE', false]);
  assert.strictEqual(error.message, 'Safety controls could not be loaded or saved. Try again when the database is available.');
  return true;
};

/* ---- What a stored record reads as ------------------------------------------------ */
{
  const off = { readOnly: false, freezeSync: false, protected: {} };
  for (const value of [null, undefined, 'text', 5, true, {}]) assert.deepStrictEqual(defaultSafety(value), off);
  assert.deepStrictEqual(defaultSafety({ readOnly: 1, freezeSync: 'yes' }), { readOnly: true, freezeSync: true, protected: {} });
  assert.deepStrictEqual(defaultSafety({ readOnly: 0, freezeSync: '' }), off);
  assert.deepStrictEqual(defaultSafety({ protected: 'text' }), off);
  assert.deepStrictEqual(defaultSafety({ protected: null }), off);
  const kept = { 'a/b': ['x'] };
  assert.strictEqual(defaultSafety({ protected: kept }).protected, kept, 'the stored paths are read, not copied');
  assert.deepStrictEqual(defaultSafety({ readOnly: true, extra: 1 }), { readOnly: true, freezeSync: false, protected: {} }, 'only the three controls are kept');
}

/* ---- How a change is applied ------------------------------------------------------- */
{
  const stored = { readOnly: true, freezeSync: false, protected: { 'a/b': ['x'] } };
  const before = JSON.stringify(stored);
  const changed = applySafetyPatch(stored, { protect: { repo: 'a/b', path: 'y' } });
  assert.deepStrictEqual(changed, { readOnly: true, freezeSync: false, protected: { 'a/b': ['x', 'y'] } });
  assert.strictEqual(JSON.stringify(stored), before, 'the stored controls are never changed in place');
  assert.notStrictEqual(changed.protected, stored.protected);
  const released = applySafetyPatch(stored, { protect: { repo: 'a/b', path: 'x', on: false } });
  assert.deepStrictEqual(released.protected, {}, 'a repository whose last path is released is removed');
  assert.deepStrictEqual(stored.protected, { 'a/b': ['x'] });

  assert.deepStrictEqual(applySafetyPatch(null, null), { readOnly: false, freezeSync: false, protected: {} });
  assert.deepStrictEqual(applySafetyPatch(null, undefined), { readOnly: false, freezeSync: false, protected: {} });
  assert.deepStrictEqual(applySafetyPatch({ readOnly: true, freezeSync: true }, { readOnly: 'false', freezeSync: 0 }), { readOnly: true, freezeSync: true, protected: {} }, 'only a boolean switches a control');
  assert.deepStrictEqual(applySafetyPatch({ readOnly: true }, { readOnly: 0 }), { readOnly: true, freezeSync: false, protected: {} });
  assert.deepStrictEqual(applySafetyPatch({ readOnly: false }, { readOnly: 'true' }), { readOnly: false, freezeSync: false, protected: {} });
  assert.deepStrictEqual(applySafetyPatch({ readOnly: true, freezeSync: true }, { readOnly: false }), { readOnly: false, freezeSync: true, protected: {} });
  assert.deepStrictEqual(applySafetyPatch({ readOnly: true }, { freezeSync: true }), { readOnly: true, freezeSync: true, protected: {} });
  assert.deepStrictEqual(applySafetyPatch({ freezeSync: true }, { freezeSync: false }), { readOnly: false, freezeSync: false, protected: {} });

  const pathOf = (raw, repo = 'a/b') => applySafetyPatch(null, { protect: { repo, path: raw } }).protected[repo.trim()];
  assert.deepStrictEqual(applySafetyPatch(null, { protect: { path: 'x' } }).protected, {}, 'a path needs its repository');
  assert.deepStrictEqual(applySafetyPatch(null, { protect: { repo: 'a/b' } }).protected, {}, 'a repository needs its path');
  assert.deepStrictEqual(applySafetyPatch(null, { protect: { repo: 'a/b', path: 0 } }).protected, {});
  assert.deepStrictEqual(pathOf('x', ' a/b '), ['x'], 'the repository key is trimmed');
  assert.deepStrictEqual(pathOf('\\src\\a'), ['src/a']);
  assert.deepStrictEqual(pathOf('//x//y'), ['x/y']);
  assert.deepStrictEqual(pathOf('/lead'), ['lead']);
  assert.deepStrictEqual(pathOf('   x   '), ['x']);
  assert.deepStrictEqual(pathOf('x'.repeat(512)), ['x'.repeat(512)]);
  assert.deepStrictEqual(pathOf('/' + 'x'.repeat(512)), ['x'.repeat(512)], 'the length is the cleaned path\'s');
  for (const key of ['a/b/c', 'a b/c', 'ab', 'a/', '/b']) {
    assert.throws(() => applySafetyPatch(null, { protect: { repo: key, path: 'x' } }), refusal(400, 'Invalid repository key'), key);
  }
  for (const bad of ['../x', 'a..b', ' ', '/', 'x'.repeat(513)]) {
    assert.throws(() => applySafetyPatch(null, { protect: { repo: 'a/b', path: bad } }), refusal(400, 'Invalid protected path or pattern'), bad);
  }
  const twice = applySafetyPatch(applySafetyPatch(null, { protect: { repo: 'a/b', path: 'z' } }), { protect: { repo: 'a/b', path: 'a', on: 0 } });
  assert.deepStrictEqual(twice.protected['a/b'], ['a', 'z'], 'paths are kept sorted, and only on: false releases one');
  assert.deepStrictEqual(applySafetyPatch(twice, { protect: { repo: 'a/b', path: 'q', on: 'false' } }).protected['a/b'], ['a', 'q', 'z']);
  assert.deepStrictEqual(applySafetyPatch(twice, { protect: { repo: 'a/b', path: 'q', on: null } }).protected['a/b'], ['a', 'q', 'z']);

  const ninetyNine = { protected: { 'a/b': Array.from({ length: 99 }, (_, i) => `f${i}`) } };
  assert.strictEqual(applySafetyPatch(ninetyNine, { protect: { repo: 'a/b', path: 'more' } }).protected['a/b'].length, 100);
  const hundred = applySafetyPatch(ninetyNine, { protect: { repo: 'a/b', path: 'more' } });
  assert.throws(() => applySafetyPatch(hundred, { protect: { repo: 'a/b', path: 'one-more' } }), refusal(413, 'Up to 100 protected paths or patterns per repository'));
  assert.strictEqual(applySafetyPatch(hundred, { protect: { repo: 'a/b', path: 'f0' } }).protected['a/b'].length, 100, 'a path already protected is not counted twice');
  const repositories = n => ({ protected: Object.fromEntries(Array.from({ length: n }, (_, i) => [`o${i}/r`, ['p']])) });
  assert.strictEqual(Object.keys(applySafetyPatch(repositories(29), { protect: { repo: 'new/one', path: 'p' } }).protected).length, 30);
  assert.throws(() => applySafetyPatch(repositories(30), { protect: { repo: 'new/one', path: 'p' } }), refusal(413, 'Up to 30 repositories with protected paths'));
  assert.strictEqual(Object.keys(applySafetyPatch(repositories(30), { protect: { repo: 'o1/r', path: 'q' } }).protected).length, 30);
}

{
  const one = safetyUnavailable();
  assert(unavailable(one));
  assert.notStrictEqual(one, safetyUnavailable(), 'each refusal is its own error');
}

/* ---- Where the controls are kept --------------------------------------------------- */

/* A scripted database: every statement is recorded, and answered by the script. */
function database(script = {}) {
  const calls = [];
  let clients = 0;
  const pool = {
    async query(text, values) {
      calls.push(['pool', text, values]);
      if (script.read) return script.read(text, values);
      return { rows: [] };
    },
    async connect() {
      calls.push(['connect']);
      if (script.connect) await script.connect();
      const id = ++clients;
      return {
        async query(text, values) {
          calls.push([id, text.replace(/\s+/g, ' ').trim(), values]);
          if (script.statement) {
            const answer = await script.statement(text, values);
            if (answer !== undefined) return answer;
          }
          if (text.startsWith('SELECT state FROM nv_security_state')) return { rows: script.row === undefined ? [] : [{ state: script.row }] };
          return { rows: [] };
        },
        release() { calls.push(['release', id]); }
      };
    }
  };
  return { calls, pool };
}

function store({ configured = true, ready = true, db = database(), session } = {}) {
  const readiness = [];
  const sessions = [];
  const state = createSafetyState({
    databaseConfigured: configured,
    ready: async () => { readiness.push('ready'); if (ready instanceof Error) throw ready; return ready; },
    pool: () => db.pool,
    identityKey: account => `github:${account.login}`,
    setSession: async (req, res, data) => { sessions.push([req, res, data]); if (session) await session(); }
  });
  return { ...state, db, readiness, sessions };
}

const request = safety => ({ gh: { login: 'alice' }, session: { safety, user: 'u' } });
const UPSERT = 'INSERT INTO nv_security_state(identity_key,state,updated) VALUES($1,$2::jsonb,now()) ON CONFLICT(identity_key) DO UPDATE SET state=EXCLUDED.state, updated=now()';

(async () => {
  /* Reading. */
  {
    const local = store({ configured: false });
    assert.deepStrictEqual(await local.loadPersistentSafety(request({ readOnly: 1, protected: 'x' })), { readOnly: true, freezeSync: false, protected: {} });
    assert.deepStrictEqual(await local.loadPersistentSafety({ session: null }), { readOnly: false, freezeSync: false, protected: {} });
    assert.deepStrictEqual([local.readiness, local.db.calls], [[], []], 'without a database the session holds the controls');

    await assert.rejects(store({ ready: false }).loadPersistentSafety(request({ readOnly: true })), unavailable, 'a database that is not ready is unavailable, never "all off"');
    const stored = store({ db: database({ read: async () => ({ rows: [{ state: { freezeSync: 'yes', protected: 'x' } }] }) }) });
    assert.deepStrictEqual(await stored.loadPersistentSafety(request({ readOnly: true })), { readOnly: false, freezeSync: true, protected: {} }, 'the identity\'s row wins over the session');
    assert.deepStrictEqual(stored.db.calls, [['pool', 'SELECT state FROM nv_security_state WHERE identity_key=$1', ['github:alice']]]);
    const absent = store();
    assert.deepStrictEqual(await absent.loadPersistentSafety(request({ readOnly: true, protected: { 'a/b': ['x'] } })), { readOnly: true, freezeSync: false, protected: { 'a/b': ['x'] } }, 'no row yet: the session\'s copy');
    await assert.rejects(store({ db: database({ read: async () => { throw new Error('gone'); } }) }).loadPersistentSafety(request({})), unavailable);
  }

  /* A change, with a database. */
  {
    const s = store({ db: database({ row: { readOnly: false, freezeSync: true, protected: { 'a/b': ['x'] } } }) });
    const req = request({ readOnly: false, freezeSync: false, protected: {} });
    const saved = await s.savePersistentSafety(req, { readOnly: true, protect: { repo: 'a/b', path: 'y' } });
    const expected = { readOnly: true, freezeSync: true, protected: { 'a/b': ['x', 'y'] } };
    assert.deepStrictEqual(saved, expected, 'the change is applied to the stored controls, not the request\'s snapshot');
    assert.strictEqual(req.session.safety, saved, 'the session holds the committed controls');
    assert.deepStrictEqual(s.db.calls, [
      ['connect'],
      [1, 'BEGIN', undefined],
      [1, 'SELECT pg_advisory_xact_lock(hashtext($1))', ['safety:github:alice']],
      [1, 'SELECT state FROM nv_security_state WHERE identity_key=$1 FOR UPDATE', ['github:alice']],
      [1, UPSERT, ['github:alice', JSON.stringify(expected)]],
      [1, 'COMMIT', undefined],
      ['release', 1]
    ]);
    assert.deepStrictEqual(s.readiness, ['ready']);

    const first = store();
    const fresh = request({ readOnly: true, freezeSync: false, protected: {} });
    assert.deepStrictEqual(await first.savePersistentSafety(fresh, { freezeSync: true }), { readOnly: true, freezeSync: true, protected: {} }, 'no row yet: applied to the session\'s copy');

    const notReady = store({ ready: false });
    await assert.rejects(notReady.savePersistentSafety(request({}), { readOnly: true }), unavailable);
    assert.deepStrictEqual(notReady.db.calls, [], 'nothing is written while the database is not ready');

    const refused = store({ db: database({ connect: async () => { throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }); } }) });
    await assert.rejects(refused.savePersistentSafety(request({}), { readOnly: true }), unavailable);

    const keep = request({ readOnly: true, freezeSync: false, protected: {} });
    const invalid = store();
    await assert.rejects(invalid.savePersistentSafety(keep, { protect: { repo: 'a/b', path: '../x' } }), refusal(400, 'Invalid protected path or pattern'));
    assert.deepStrictEqual(invalid.db.calls.map(call => call[1]).slice(-3), ['SELECT state FROM nv_security_state WHERE identity_key=$1 FOR UPDATE', 'ROLLBACK', 1]);
    assert.deepStrictEqual(invalid.db.calls.at(-1), ['release', 1]);
    assert.deepStrictEqual(keep.session.safety, { readOnly: true, freezeSync: false, protected: {} }, 'a refused change leaves the session alone');

    for (const [status, rethrown] of [[399, false], [400, true], [409, true], [499, true], [500, false], ['422', true], [undefined, false]]) {
      const failing = store({ db: database({ statement: async text => {
        if (text.startsWith('INSERT')) throw Object.assign(new Error('insert failed'), status === undefined ? {} : { status });
        if (text === 'ROLLBACK') throw new Error('rollback failed too');
        return undefined;
      } }) });
      await assert.rejects(failing.savePersistentSafety(request({}), { readOnly: true }), error => {
        if (rethrown) assert.deepStrictEqual([error.message, error.status], ['insert failed', status]);
        else unavailable(error);
        return true;
      }, `status ${status}`);
      assert.deepStrictEqual(failing.db.calls.slice(-2), [[1, 'ROLLBACK', undefined], ['release', 1]], 'a failed rollback does not hide the failure, and the client goes back');
    }
    const nullError = store({ db: database({ statement: async text => { if (text === 'COMMIT') throw null; return undefined; } }) });
    await assert.rejects(nullError.savePersistentSafety(request({}), { readOnly: true }), unavailable);
  }

  /* A change, without a database. */
  {
    const local = store({ configured: false });
    const req = request({ readOnly: true, freezeSync: false, protected: {} });
    assert.deepStrictEqual(await local.savePersistentSafety(req, { protect: { repo: 'a/b', path: 'x' } }), { readOnly: true, freezeSync: false, protected: { 'a/b': ['x'] } });
    assert.deepStrictEqual(req.session.safety, { readOnly: true, freezeSync: false, protected: { 'a/b': ['x'] } });
    assert.deepStrictEqual([local.readiness, local.db.calls], [[], []]);
  }

  /* The session's copy. */
  {
    const res = { id: 'res' };
    const ok = store();
    const req = request({ readOnly: true });
    assert.strictEqual(await ok.saveSessionSafetyCopy(req, res), true);
    assert.deepStrictEqual(ok.sessions, [[req, res, req.session]]);
    assert.strictEqual(ok.sessions[0][2], req.session);

    const ended = [
      Object.assign(new Error('expired'), { status: 401 }), Object.assign(new Error('down'), { status: 503 }),
      Object.assign(new Error('text'), { status: '401' }), Object.assign(new Error('r'), { code: 'SESSION_REVOKED' }),
      Object.assign(new Error('a'), { code: 'ALPHA_PROVIDER_SESSION_UNAVAILABLE' }), Object.assign(new Error('c'), { code: 'ALPHA_SESSION_REVISION_CONFLICT' })
    ];
    for (const error of ended) {
      assert.strictEqual(await store({ session: async () => { throw error; } }).saveSessionSafetyCopy(request({}), res), false, `${error.message}: an ended session does not undo a committed change`);
      await assert.rejects(store({ configured: false, session: async () => { throw error; } }).saveSessionSafetyCopy(request({}), res), same => same === error, 'without a database the session is the only copy');
    }
    for (const error of [Object.assign(new Error('other'), { status: 500 }), Object.assign(new Error('other'), { code: 'SESSION_OTHER' }), new Error('plain')]) {
      await assert.rejects(store({ session: async () => { throw error; } }).saveSessionSafetyCopy(request({}), res), same => same === error);
    }
    await assert.rejects(store({ session: async () => { throw null; } }).saveSessionSafetyCopy(request({}), res), value => value === null);
    assert.strictEqual(await store({ configured: false }).saveSessionSafetyCopy(request({}), res), true);
  }

  finished = true;
  console.log('Corona safety state tests passed');
})().catch(error => { finished = true; console.error(error); process.exit(1); });
