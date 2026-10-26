'use strict';
/*
 * Corona's fifteen routes, over HTTP (D12), on the recovery service with a
 * scripted provider: the commit recoveries, the safeguards, snapshots of the
 * references and signed snapshots, emergency containment, the access surface
 * and the evidence export. Reference restores and their grants are held by
 * test/corona-recovery.test.js.
 *
 * What each must hold: the chain the route policy records; a restore that
 * writes a new commit on the head it read and never forces the branch; a path
 * restore that refuses a protected path before anything is written; a reset
 * that checks the head it was given; a safety change committed before its
 * evidence and the session's copy, and not undone by a ledger that fails; a
 * snapshot that discloses what it could not read; containment that refuses a
 * hosted alpha before anything changes; an access surface that says when it
 * is partial; and evidence whose snapshots are verified as they are read.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const corona = require('../apps/api/src/modules/corona/index.ts');
const { locations } = require('./oracles/route-policy');
const inventory = require('../docs/architecture/mission/ROUTE_INVENTORY.json');

const root = path.resolve(__dirname, '..');
const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);

/* ---- The chains, as the baseline inventory recorded them and the route policy reads them now ---- */
{
  const now = new Map(locations(root).filter(entry => entry.kind === 'route').map(entry => [`${entry.method} ${entry.path}`, entry]));
  const owned = inventory.routes.filter(route => route.owner === 'corona');
  assert.equal(owned.length, 15);
  for (const route of owned) {
    const entry = now.get(`${route.method} ${route.path}`);
    assert(entry, `${route.method} ${route.path} is registered`);
    assert.deepEqual(entry.guards, route.guards, `${route.method} ${route.path} keeps its chain`);
    assert(entry.at.startsWith('apps/api/src/modules/corona/http/'), `${route.path} is registered by Corona (${entry.at})`);
  }
}

function harness(options = {}) {
  const calls = [];
  const heads = new Map([['main', A]]);
  const state = {
    patch: 'ok', protectedPaths: [], alpha: false, ready: true, evidenceFails: false, tagsFail: false,
    branches: [{ name: 'main', commit: { sha: A }, protected: true }, { name: 'gitea', id: B }, { name: '' }],
    tree: { tree: [{ path: 'a.js', type: 'blob', sha: A, size: 2, mode: '100644' }, { path: 'lib', type: 'tree', sha: B }, { path: 'docs/x.md', type: 'blob', sha: C }], truncated: false },
    surfaceFails: null
  };
  const gh = async (account, apiPath, input = {}) => {
    const method = input.method || 'GET';
    calls.push(['gh', method, apiPath, input.body]);
    if (/\/branches\?/.test(apiPath)) return apiPath.includes('page=1') ? state.branches : [];
    if (/\/tags\?/.test(apiPath)) { if (state.tagsFail) throw Object.assign(new Error('tags need a scope'), { status: 403 }); return []; }
    if (/\/(collaborators|keys|hooks)\?/.test(apiPath)) {
      const kind = apiPath.match(/\/(collaborators|keys|hooks)\?/)[1];
      if (state.surfaceFails === kind) throw Object.assign(new Error(`${kind} need admin`), { status: 403 });
      return {
        collaborators: [{ login: 'alice', permissions: { admin: true } }, { login: 'bob', role_name: 'Maintain' }, { login: 'eve', permissions: { push: true } }],
        keys: [{ id: 9, title: 'deploy', read_only: false }],
        hooks: [{ id: 3, active: true, events: ['push'], config: { url: 'https://user:secret@hooks.example/path?token=x', insecure_ssl: '1' } }]
      }[kind];
    }
    if (/\/git\/trees\//.test(apiPath)) return state.tree;
    if (/\/commits\/[0-9a-f]{40}$/.test(apiPath)) return { commit: { message: 'fix: things\nmore', tree: { sha: B } } };
    if (/\/git\/ref\/heads\//.test(apiPath)) {
      const name = decodeURIComponent(apiPath.split('/git/ref/heads/')[1]);
      if (!heads.has(name)) throw Object.assign(new Error('Not Found'), { status: 404 });
      return { object: { sha: heads.get(name) } };
    }
    if (/\/git\/commits$/.test(apiPath)) return { sha: C };
    if (/\/git\/refs\/heads\//.test(apiPath)) {
      if (state.patch !== 'ok') throw Object.assign(new Error('not a fast forward'), { status: state.patch });
      heads.set(decodeURIComponent(apiPath.split('/git/refs/heads/')[1]), input.body.sha);
      return {};
    }
    if (/^\/repos\/[^/]+\/[^/]+$/.test(apiPath)) {
      if (state.surfaceFails === 'repository') throw Object.assign(new Error('repo hidden'), { status: 404 });
      return { default_branch: 'main', permissions: { push: true } };
    }
    throw Object.assign(new Error(`unscripted ${apiPath}`), { status: 404 });
  };
  const fail = (res, error) => res.status(error && error.status >= 400 && error.status < 600 ? error.status : 500).json({ code: error && error.code, error: error && error.message });
  const pass = (_req, _res, next) => next();
  const account = { login: options.provider === 'gitea' ? 'bob' : 'alice', provider: options.provider || 'github' };
  const guards = {
    providerSessionAccess: (req, _res, next) => { req.gh = { ...account }; next(); },
    alphaRepositoryAccess: pass, capabilityAccess: () => pass, auth: pass, mutationContext: () => pass, account: req => req.gh, fail, gh
  };
  const signatures = {
    sign: (id, value) => `sig:${id}:${Object.keys(value).length}`,
    verify: (signature, id) => ({ valid: String(signature).startsWith(`sig:${id}:`), keyId: 'k1', legacy: false }),
    activeKeyId: 'k1'
  };
  const app = express();
  app.use(express.json());
  const assertExpectedHead = (expected, actual) => {
    if (!expected) return;
    if (!/^[0-9a-f]{40}$/i.test(String(expected))) throw Object.assign(new Error('expectedHeadSha must be a 40-character commit SHA'), { status: 400, code: 'INVALID_EXPECTED_HEAD' });
    if (String(expected).toLowerCase() !== String(actual || '').toLowerCase()) throw Object.assign(new Error('The branch changed'), { status: 409, code: 'BRANCH_CHANGED' });
  };
  corona.registerCommitRecoveryRoutes(app, {
    ...guards,
    commitTree: async (...args) => { calls.push(['commitTree', args.slice(1)]); return 'commit-1'; },
    enforceProtectedPaths: (_req, paths) => {
      calls.push(['protected', paths]);
      const hit = paths.find(item => state.protectedPaths.includes(item));
      if (hit) throw Object.assign(new Error(`${hit} is a protected file`), { status: 423, code: 'PROTECTED_PATH' });
    },
    assertExpectedHead,
    branchChangedError: () => Object.assign(new Error('The branch changed'), { status: 409, code: 'BRANCH_CHANGED' }),
    requireAggregateExpectedHead: value => {
      if (!/^[0-9a-f]{40}$/i.test(String(value || ''))) throw Object.assign(new Error('Aggregate mutations require expectedHeadSha'), { status: 409, code: 'AGGREGATE_EXPECTED_HEAD_REQUIRED' });
      return String(value).toLowerCase();
    }
  });
  let safety = { readOnly: false, freezeSync: false, protected: { 'alice/demo': ['a.js'], 'other/repo': ['x'] } };
  const safetyDeps = {
    safetyOf: () => safety,
    savePersistentSafety: async (req, patch) => {
      calls.push(['saveSafety', patch]);
      safety = { ...safety, ...(typeof patch.readOnly === 'boolean' ? { readOnly: patch.readOnly } : {}), ...(typeof patch.freezeSync === 'boolean' ? { freezeSync: patch.freezeSync } : {}) };
      return safety;
    },
    saveSessionSafetyCopy: async req => { calls.push(['saveSession', req.effectiveSafety]); return true; },
    appendEvidence: async (key, kind, id, payload) => { calls.push(['evidence', key, kind, payload]); if (state.evidenceFails) throw new Error('ledger down'); return { seq: 1 }; },
    retainedActor: req => req.gh.login,
    identityKey: acct => `key:${acct.login}`
  };
  corona.registerSafeguardRoutes(app, {
    providerSessionAccess: guards.providerSessionAccess, alphaSafetyMutationAccess: pass, accountAuth: pass, account: req => req.gh, fail,
    alphaSafetyView: (req, view) => ({ ...view, protected: { 'alice/demo': view.protected['alice/demo'] || [] }, globalControls: true }),
    ...safetyDeps
  });
  const recovery = corona.createRecovery({
    gh, seal: value => JSON.stringify(value), unseal: value => { try { return JSON.parse(value); } catch { return null; } },
    identityKey: acct => `key:${acct.login}`, databaseConfigured: false, durableSingleUse: () => assert.fail('no database'), manifestMax: options.manifestMax || 10000
  });
  const rows = [];
  const pool = () => ({
    query: async (sql, params) => {
      calls.push(['sql', sql.trim().split(/\s+/)[0], params]);
      if (/^INSERT INTO nv_recovery_snapshots/.test(sql.trim())) rows.push({ snapshot_id: params[0], snapshot: JSON.parse(params[5]), signature: params[6], created_at: 'now' });
      if (/^SELECT snapshot_id/.test(sql.trim())) return { rows: rows.map(row => ({ ...row })) };
      if (/^SELECT event_id/.test(sql.trim())) return { rows: [{ event_id: 'e1' }] };
      return { rows: [] };
    }
  });
  corona.registerSnapshotRoutes(app, {
    ...guards, recovery, dbReady: async () => state.ready, pool, identityKey: acct => `key:${acct.login}`,
    scopedEvidenceKey: (provider, owner, repo, identity) => `${provider}:${owner}/${repo}:${identity}`,
    appendEvidence: safetyDeps.appendEvidence, signatures, retentionCount: 5, safetyOf: safetyDeps.safetyOf,
    protectedPatternsForReq: () => state.protectedPaths, alphaEnabled: options.alpha === true,
    savePersistentSafety: safetyDeps.savePersistentSafety, saveSessionSafetyCopy: safetyDeps.saveSessionSafetyCopy,
    sessionsForIdentity: async () => ({ available: true, rows: [{ sid: 's1', current: true }, { sid: 's2', current: false }] }),
    revokeContainedSessions: async (_req, ids) => { calls.push(['revoke', ids]); return ids; },
    closeLiveSessions: (ids, reason) => { calls.push(['closeLive', ids, reason]); return ids.length; },
    retainedActor: safetyDeps.retainedActor, executionSnapshot: () => null
  });
  corona.registerAccessSurfaceRoutes(app, { ...guards });
  corona.registerEvidenceRoutes(app, {
    ...guards, identityKey: acct => `key:${acct.login}`,
    scopedEvidenceKey: (provider, owner, repo, identity) => `${provider}:${owner}/${repo}:${identity}`,
    verifyEvidenceChain: async (key, limit) => { calls.push(['chain', key, limit]); return { available: true, valid: true, records: [{ seq: 1 }], total: 1 }; },
    dbReady: async () => state.ready, pool, signatures
  });
  const server = app.listen(0, '127.0.0.1');
  const ready = new Promise(resolve => server.once('listening', resolve));
  const call = async (method, route, body) => {
    await ready;
    calls.length = 0;
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, body: text ? JSON.parse(text) : null };
  };
  return { call, calls, heads, state, rows, close: () => new Promise(resolve => server.close(resolve)) };
}

(async () => {
  const repo = '/api/repo/alice/demo';
  const h = harness();
  try {
    /* Restoring a whole repository: a new commit with the old tree on the head it read, never a forced branch. */
    {
      assert.equal((await h.call('POST', `${repo}/restore`, { branch: 'main' })).status, 400);
      const restored = await h.call('POST', `${repo}/restore`, { sha: C, branch: 'main', expectedHeadSha: A });
      assert.deepEqual(restored.body, { ok: true, commit: C });
      const created = h.calls.find(([kind, method, apiPath]) => kind === 'gh' && method === 'POST' && apiPath.endsWith('/git/commits'));
      assert.deepEqual(created[3], { message: `Restore repository to ${C.slice(0, 7)} ("fix: things") via Nebulaverse-X`, tree: B, parents: [A] });
      const moved = h.calls.find(([kind, method]) => kind === 'gh' && method === 'PATCH');
      assert.deepEqual(moved[3], { sha: C, force: false });
      h.heads.set('main', A);
      const stale = await h.call('POST', `${repo}/restore`, { sha: C, branch: 'main', expectedHeadSha: B });
      assert.equal(stale.body.code, 'BRANCH_CHANGED');
      assert(!h.calls.some(([kind, method]) => kind === 'gh' && method !== 'GET'), 'nothing is written on a head that moved');
      h.state.patch = 422;
      assert.equal((await h.call('POST', `${repo}/restore`, { sha: C, branch: 'main' })).body.code, 'BRANCH_CHANGED', 'a branch that moved under the write is told so');
      h.state.patch = 'ok';
    }

    /* Restoring some paths: every restored path checked against the safeguards before anything is written. */
    {
      assert.equal((await h.call('POST', `${repo}/restore-paths`, { sha: C, branch: 'main', prefix: 'docs' })).body.code, 'AGGREGATE_EXPECTED_HEAD_REQUIRED');
      assert.equal((await h.call('POST', `${repo}/restore-paths`, { sha: C, branch: 'main', prefix: 'missing', expectedHeadSha: A })).status, 404);
      h.state.protectedPaths = ['docs/x.md'];
      const refused = await h.call('POST', `${repo}/restore-paths`, { sha: C, branch: 'main', prefix: 'docs', expectedHeadSha: A });
      assert.equal(refused.body.code, 'PROTECTED_PATH');
      assert(!h.calls.some(([kind]) => kind === 'commitTree'));
      h.state.protectedPaths = [];
      const restored = await h.call('POST', `${repo}/restore-paths`, { sha: C, branch: 'main', prefix: 'docs', expectedHeadSha: A });
      assert.deepEqual(restored.body, { ok: true, commit: 'commit-1', restored: 1 });
      const [, args] = h.calls.find(([kind]) => kind === 'commitTree');
      assert.deepEqual(args.slice(2), ['main', `Restore docs from ${C.slice(0, 7)} via Nebulaverse-X`, [{ path: 'docs/x.md', mode: undefined, type: 'blob', sha: C, forceMode: true }], A]);
    }

    /* A commit's listing, and a reset that checks the head it was given. */
    {
      const listing = await h.call('GET', `${repo}/snapshot?sha=${C}`);
      assert.deepEqual(listing.body.files.map(file => file.path), ['a.js', 'docs/x.md'], 'files and submodules only');
      assert.equal((await h.call('POST', `${repo}/reset`, { sha: B, branch: 'main', expectedHeadSha: C })).body.code, 'BRANCH_CHANGED');
      const reset = await h.call('POST', `${repo}/reset`, { sha: B, branch: 'main', expectedHeadSha: A });
      assert.deepEqual(reset.body, { ok: true });
      assert.deepEqual(h.calls.find(([kind, method]) => kind === 'gh' && method === 'PATCH')[3], { sha: B, force: true });
      h.heads.set('main', A);
    }

    /* The safeguards: committed, then evidenced, then copied to the session; a ledger that fails does not undo the change. */
    {
      const read = await h.call('GET', '/api/safety');
      assert.deepEqual(read.body.protected, { 'alice/demo': ['a.js'] }, 'only this scope\'s protected paths come back');
      h.state.evidenceFails = true;
      const changed = await h.call('POST', '/api/safety', { readOnly: true, protect: { repo: 'alice/demo', path: 'b.js' } });
      assert.equal(changed.status, 200);
      assert.equal(changed.body.readOnly, true);
      assert.deepEqual(h.calls.map(([kind]) => kind), ['saveSafety', 'evidence', 'saveSession']);
      const [, key, kind, payload] = h.calls[1];
      assert.deepEqual([key, kind, payload.repository, payload.protectedCount, payload.actor], ['safety:key:alice', 'safety-change', 'alice/demo', 2, 'alice']);
      h.state.evidenceFails = false;
    }

    /* A snapshot of the references: both providers' reference shapes, what could not be read disclosed, the manifest from the default branch. */
    {
      h.state.tagsFail = true;
      const snapshot = await h.call('GET', `${repo}/refs-snapshot?manifest=1`);
      assert.deepEqual(snapshot.body.refs, [{ name: 'main', sha: A, protected: true }, { name: 'gitea', sha: B, protected: false }]);
      assert.equal(snapshot.body.tagsAvailable, false);
      assert.equal(snapshot.body.tagsError, 'tags need a scope');
      assert.equal(snapshot.body.manifest.branch, 'main');
      assert.deepEqual(snapshot.body.manifest.files.map(file => file.path), ['a.js', 'docs/x.md']);
      h.state.tagsFail = false;
    }

    /* Signed snapshots: kept for this identity, pruned to the newest few, evidenced, and verified as they are read back. */
    {
      h.state.ready = false;
      assert.equal((await h.call('POST', `${repo}/signed-snapshot`, {})).status, 503);
      h.state.ready = true;
      const signed = await h.call('POST', `${repo}/signed-snapshot`, { manifest: false });
      assert.equal(signed.status, 201);
      assert.equal(signed.body.snapshot.manifest, null);
      const prune = h.calls.find(([kind, word, params]) => kind === 'sql' && word === 'DELETE' && params);
      assert.deepEqual(prune[2], ['github', 'alice', 'demo', 'key:alice', 5]);
      assert(h.calls.some(([kind, , evidenceKind]) => kind === 'evidence' && evidenceKind === 'recovery-snapshot'));
      const listed = await h.call('GET', `${repo}/signed-snapshots`);
      assert.equal(listed.body.snapshots[0].signatureValid, true);
    }

    /* Emergency containment: the word, then read-only and frozen, the other sessions revoked and their streams closed, signed. */
    {
      assert.equal((await h.call('POST', `${repo}/emergency-manifest`, { confirm: 'freeze?' })).status, 400);
      const contained = await h.call('POST', `${repo}/emergency-manifest`, { confirm: 'freeze' });
      assert.equal(contained.status, 201);
      assert.deepEqual(contained.body.manifest.controls, { readOnly: true, freezeSync: true, sessionsRevoked: 1, streamsClosed: 1, sessionRevocationAvailable: true });
      assert.equal(contained.body.signatureValid, true);
      assert.deepEqual(h.calls.find(([kind]) => kind === 'revoke')[1], ['s2'], 'only the other sessions');
      assert.deepEqual(h.calls.find(([kind]) => kind === 'closeLive').slice(1), [['s2'], 'emergency-containment']);
      assert.equal(contained.body.persisted, true);
    }

    /* The access surface: permissions read, only a webhook's host kept, and partial when a list could not be read. */
    {
      const surface = await h.call('GET', `${repo}/access-surface`);
      assert.equal(surface.headers.get('cache-control'), 'no-store');
      assert.deepEqual(surface.body.collaborators.map(item => item.permission), ['admin', 'maintain', 'write']);
      assert.equal(surface.body.currentPermission, 'write');
      assert.deepEqual(surface.body.webhooks[0], { id: 3, name: 'web', active: true, events: ['push'], host: 'hooks.example', insecureSsl: true, updatedAt: null });
      assert(!surface.text.includes('secret') && !surface.text.includes('token=x'), 'nothing of a webhook\'s address but its host');
      assert.equal(surface.body.partial, false);
      assert.equal(typeof surface.body.risk, 'object');
      h.state.surfaceFails = 'keys';
      const partial = await h.call('GET', `${repo}/access-surface`);
      assert.equal(partial.body.partial, true);
      assert.deepEqual(partial.body.errors, ['deploy keys: keys need admin']);
      h.state.surfaceFails = null;
    }

    /* Evidence: the chain verified, the events, and each kept snapshot's signature checked again. */
    {
      const evidence = await h.call('GET', `${repo}/evidence`);
      assert.equal(evidence.body.kind, 'nebulaverse-evidence');
      assert.deepEqual(evidence.body.records, [{ seq: 1 }]);
      assert.equal(evidence.body.chain.records, undefined, 'the records travel beside the summary, not inside it');
      assert(evidence.body.snapshots.length >= 2);
      assert(evidence.body.snapshots.every(row => row.signature_valid === true));
      assert.deepEqual(h.calls[0], ['chain', 'github:alice/demo:key:alice', 5000]);
      h.state.ready = false;
      const offline = await h.call('GET', `${repo}/evidence`);
      assert.deepEqual(offline.body, { available: false, chain: { available: true, valid: true, records: [{ seq: 1 }], total: 1 }, events: [], snapshots: [] });
    }
  } finally {
    await h.close();
  }

  /* A hosted alpha refuses identity-wide containment before anything is captured or changed; another provider has no access surface. */
  {
    const alpha = harness({ alpha: true });
    try {
      const refused = await alpha.call('POST', `${repo}/emergency-manifest`, { confirm: 'FREEZE' });
      assert.equal(refused.body.code, 'ALPHA_REPOSITORY_SCOPE_REQUIRED');
      assert.deepEqual(alpha.calls, []);
    } finally { await alpha.close(); }
    const gitea = harness({ provider: 'gitea' });
    try {
      const surface = await gitea.call('GET', `${repo}/access-surface`);
      assert.equal(surface.body.available, false);
      assert.deepEqual(gitea.calls, [], 'nothing is asked of a provider without the administration APIs');
    } finally { await gitea.close(); }
    const narrow = harness({ manifestMax: 1 });
    try {
      const snapshot = await narrow.call('GET', `${repo}/refs-snapshot?manifest=1`);
      assert.equal(snapshot.body.manifest.truncated, true);
      assert.equal(snapshot.body.manifest.totalFiles, 2);
      assert.equal(snapshot.body.manifest.files.length, 1);
    } finally { await narrow.close(); }
  }
  console.log('corona routes tests passed');
})().catch(error => { console.error(error); process.exit(1); });
