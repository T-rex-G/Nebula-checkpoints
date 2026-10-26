'use strict';
/*
 * Kepler's fifty governance routes, over HTTP (D12), on the real governance
 * service with a store that records what it is asked and answers from a
 * script: templates and baselines, the digital twin, notifications, webhooks
 * and exports, policies and their drafts, versions, reviews, decisions and
 * exceptions, and the rest of a policy's life in the second registration.
 *
 * What each must hold: the chain the route policy records; a call to the
 * service with the server-derived scope and authorization and only what the
 * request names; a role the service refuses before the store is touched; a
 * baseline built from the repository's own facts, sorted, bounded and honest
 * about what it could not list; an export downloaded as its signed envelope;
 * and failures that keep a governance error's words but never a raw one's.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const kepler = require('../apps/api/src/modules/kepler/index.ts');
const { locations } = require('./oracles/route-policy');
const inventory = require('../docs/architecture/mission/ROUTE_INVENTORY.json');

const root = path.resolve(__dirname, '..');
const { assertGovernanceAuthorization, createGovernanceApiService, registerGovernanceRoutes, registerGovernanceLifecycleRoutes } = kepler;

/* ---- The chains, as the baseline inventory recorded them and the route policy reads them now ---- */
{
  const now = new Map(locations(root).filter(entry => entry.kind === 'route').map(entry => [`${entry.method} ${entry.path}`, entry]));
  const owned = inventory.routes.filter(route => route.owner === 'kepler');
  assert.equal(owned.length, 50);
  for (const route of owned) {
    const entry = now.get(`${route.method} ${route.path}`);
    assert(entry, `${route.method} ${route.path} is registered`);
    assert.deepEqual(entry.guards, route.guards, `${route.method} ${route.path} keeps its chain`);
    assert(entry.at.startsWith('apps/api/src/modules/kepler/http/governance-routes.ts:'), `${route.path} is registered by Kepler (${entry.at})`);
  }
}

/* The access projection reads the wall clock, so the evidence is fresh against it. */
const NOW = Date.now();
const ALICE = require('node:crypto').createHash('sha256').update('github:alice').digest('hex');
function snapshot(level) {
  const role = level >= 50 ? 'admin' : level >= 40 ? 'maintain' : level >= 30 ? 'write' : 'read';
  return {
    schemaVersion: 1,
    scope: { provider: 'github', authority: 'github.com', owner: 'Acme', repo: 'Demo', scopeKey: 'github:github.com:acme/demo' },
    executionPrincipal: { kind: 'user', identityKey: ALICE, login: 'alice', authMethod: 'oauth' },
    governanceActor: { kind: 'human', identityKey: ALICE, login: 'alice', verified: true },
    repositoryAccess: { baseRole: role, providerRole: role, level, source: 'github.collaborator.permission', complete: true },
    governanceRoles: { reader: level >= 10, author: level >= 30, reviewer: level >= 40, activator: level >= 50, administrator: level >= 50 },
    installationCapabilities: null,
    evidence: { status: 'resolved', fetchedAt: new Date(NOW - 30_000).toISOString(), expiresAt: new Date(NOW + 120_000).toISOString(), reasonCode: null }
  };
}

async function withServer(state, run) {
  const store = new Proxy({}, {
    get: (_target, name) => {
      if (typeof name !== 'string' || name === 'then') return undefined;
      return async input => {
        state.store.push([name, input]);
        if (state.storeFails) throw state.storeFails;
        return Object.hasOwn(state.answers, name) ? state.answers[name] : { answered: name };
      };
    }
  });
  const service = createGovernanceApiService({ store, now: Date.now });
  const pass = (_req, _res, next) => next();
  const deps = {
    providerSessionAccess: (req, _res, next) => { req.gh = { login: 'alice', provider: 'github' }; next(); },
    alphaRepositoryAccess: pass, capabilityAccess: () => pass, auth: pass,
    /* The server's guard, as it stands: the caller's authorization for this repository, checked for the role, with the service attached. */
    governanceAccess: role => (req, res, next) => {
      res.setHeader('Cache-Control', 'no-store');
      try {
        const context = assertGovernanceAuthorization({
          authorization: state.authorization,
          scope: { provider: 'github', baseUrl: '', owner: req.params.owner, repo: req.params.repo },
          requiredRole: role
        });
        req.governance = { ...context, service };
        next();
      } catch (error) { kepler.governanceFailure(res, error); }
    },
    governanceMutationContext: action => (req, _res, next) => { state.actions.push(action); next(); },
    governance: req => req.governance, account: req => req.gh,
    gh: async (account, apiPath) => {
      state.gh.push([account.login, apiPath]);
      if (apiPath.endsWith('/branches?per_page=100')) {
        if (state.branchesFail) throw Object.assign(new Error('branches hidden'), { status: 403 });
        return state.branches;
      }
      return state.repository;
    }
  };
  const app = express();
  app.use(express.json());
  registerGovernanceRoutes(app, deps);
  registerGovernanceLifecycleRoutes(app, deps);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/repo/Acme/Demo/governance`;
  const call = async (method, route, body, headers = {}) => {
    const response = await fetch(`${base}${route}`, {
      method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: response.status, headers: response.headers, text, json };
  };
  try { await run(call); } finally { await new Promise(resolve => server.close(resolve)); }
}

function freshState(level = 50) {
  return {
    authorization: snapshot(level), store: [], actions: [], gh: [], answers: {}, storeFails: null,
    repository: { default_branch: 'main', visibility: 'internal', archived: false },
    branches: [{ name: 'main', protected: true }], branchesFail: false
  };
}

(async () => {
  /* ---- Templates come from the catalogue, with no store and no provider read ---- */
  {
    const state = freshState(10);
    await withServer(state, async call => {
      const list = await call('GET', '/templates');
      assert.equal(list.status, 200, list.text);
      assert(Array.isArray(list.json.templates) && list.json.templates.length > 0);
      assert.equal(list.headers.get('cache-control'), 'no-store');
      const first = list.json.templates[0];
      const one = await call('GET', `/templates/${encodeURIComponent(first.templateId || first.id)}`);
      assert.equal(one.status, 200, one.text);
      assert(one.json.template);
      const missing = await call('GET', '/templates/no-such-template');
      assert(missing.status >= 400 && missing.status < 500, 'an unknown template is refused');
      assert.deepEqual(state.store, []);
      assert.deepEqual(state.gh, []);
    });
  }

  /* ---- A baseline is built from the repository's own facts ---- */
  {
    const state = freshState(10);
    const templateId = 'protected-default-branch';
    state.branches = [
      ...Array.from({ length: 60 }, (_, i) => ({ name: `release-${String(59 - i).padStart(2, '0')}`, protected: true })),
      { name: 'dev', protected: false }, { name: '', protected: true }, null, { name: 'z', protected: 'true' },
      ...Array.from({ length: 36 }, (_, i) => ({ name: `topic-${i}`, protected: false }))
    ];
    assert.equal(state.branches.length, 100);
    state.repository = { default_branch: 'trunk', private: true, archived: 1 };
    /* Only real protected branches, sorted and no more than fifty; a full page means the list may go on. */
    const facts = {
      schemaVersion: 1, defaultBranch: 'trunk',
      protectedBranches: Array.from({ length: 50 }, (_, i) => `release-${String(i).padStart(2, '0')}`),
      pullRequestsEnabled: true, visibility: 'private', archived: true,
      branchesComplete: false, protectedBranchesTruncated: true, resolvedForScopeKey: 'github:github.com:acme/demo'
    };
    const { scope } = assertGovernanceAuthorization({
      authorization: snapshot(10), scope: { provider: 'github', baseUrl: '', owner: 'Acme', repo: 'Demo' }, requiredRole: 'reader'
    });
    await withServer(state, async call => {
      const answer = await call('POST', '/baselines/generate', { templateId });
      assert.equal(answer.status, 200, answer.text);
      assert.deepEqual(state.gh, [['alice', '/repos/Acme/Demo'], ['alice', '/repos/Acme/Demo/branches?per_page=100']]);
      assert.deepEqual(state.actions, [], 'generating a baseline records no mutation');
      assert.deepEqual(state.store, []);
      assert.deepEqual(answer.json.baseline, JSON.parse(JSON.stringify(kepler.generateRepositoryBaseline({ scope, templateId, facts }))));
      for (const warning of ['branch-facts-incomplete', 'protected-branches-truncated', 'repository-archived']) {
        assert(answer.json.baseline.readiness.warnings.includes(warning), warning);
      }

      state.branchesFail = true;
      const logged = [];
      const errors = console.error;
      console.error = (...args) => logged.push(args.join(' '));
      let hidden;
      try { hidden = await call('POST', '/baselines/generate', { templateId }); } finally { console.error = errors; }
      assert.equal(hidden.status, 500, 'a provider failure is not a governance error');
      assert.deepEqual(hidden.json, { error: 'Governance operation failed', code: 'GOVERNANCE_OPERATION_FAILED' });
      assert.equal(logged.length, 1);
      assert(!logged[0].includes('branches hidden'), 'the log names the code alone');
      state.branchesFail = false;

      const unsupported = await call('POST', '/baselines/generate', { templateId, extra: true });
      assert.equal(unsupported.status, 400);
      assert.equal(unsupported.json.code, 'GOVERNANCE_BASELINE_INPUT_INVALID');
    });
  }

  /* ---- The service refuses a role it needs before the store is touched ---- */
  {
    const state = freshState(10);
    await withServer(state, async call => {
      const create = await call('POST', '/policies', { policyKey: 'p', name: 'P' });
      assert.equal(create.status, 403);
      assert.equal(create.json.code, 'GOVERNANCE_ROLE_REQUIRED');
      assert.equal(typeof create.json.error, 'string');
      const reset = await call('POST', '/reset', {});
      assert.equal(reset.status, 403);
      assert.deepEqual(state.store, []);
      assert.deepEqual(state.actions, [], 'the guard refused before the mutation context');
    });
  }

  /* ---- Each call carries the server's scope and actor, and only what the request names ---- */
  {
    const state = freshState(50);
    state.answers.listPolicyDecisionsInScope = { decisions: [{ seq: 4 }], nextCursor: null };
    await withServer(state, async call => {
      const create = await call('POST', '/policies', { policyKey: 'branch-rules', name: 'Branch rules', governanceRoles: { administrator: true } }, { 'Idempotency-Key': 'create-1' });
      assert.equal(create.status, 201, create.text);
      assert.deepEqual(state.actions, ['governance.policy.create']);
      const [name, input] = state.store.at(-1);
      assert.equal(name, 'createPolicy');
      assert.equal(input.scope.scopeKey, 'github:github.com:acme/demo');
      assert.deepEqual(input.actor, { identityKey: ALICE, login: 'alice' });
      assert.equal(input.policyKey, 'branch-rules');
      assert(!JSON.stringify(input).includes('governanceRoles'), 'roles in the body are never passed on');

      const decisions = await call('GET', '/decisions?limit=5&afterSeq=3&beforeSeq=9');
      assert.equal(decisions.status, 200);
      assert.deepEqual(decisions.json, { decisions: [{ seq: 4 }], nextCursor: null });
      const [, query] = state.store.at(-1);
      assert.deepEqual([query.limit, query.afterSeq, query.beforeSeq], ['5', '3', '9']);

      /* Each write: its gateway action, and what reaches the store from the path, the body and the key. */
      for (const [method, route, body, key, status, wrapper, action, storeCall, expected] of [
        ['GET', '/policies/p1', undefined, undefined, 200, 'policy', null, 'getPolicyStateInScope', { policyId: 'p1' }],
        ['POST', '/exceptions/x1/revoke', { reason: 'tidy' }, 'revoke-1', 201, 'exception', 'governance.exception.revoke', 'revokeException', { exceptionId: 'x1', reason: 'tidy', idempotencyKey: 'revoke-1' }],
        ['POST', '/policies/p1/archive', { expectedRevision: 3, reason: 'tidy' }, 'archive-1', 201, 'archive', 'governance.policy.archive', 'archivePolicy', { policyId: 'p1', expectedRevision: 3, reason: 'tidy', idempotencyKey: 'archive-1' }],
        ['DELETE', '/policies/p1/drafts/d1', { expectedRevision: 2 }, undefined, 200, 'draft', 'governance.draft.discard', 'discardDraft', { policyId: 'p1', draftId: 'd1', expectedRevision: 2, allowOthers: true }]
      ]) {
        state.actions.length = 0;
        const answer = await call(method, route, body, key ? { 'Idempotency-Key': key } : {});
        assert.equal(answer.status, status, `${method} ${route}: ${answer.text}`);
        assert.deepEqual(answer.json, { [wrapper]: { answered: storeCall } });
        assert.deepEqual(state.actions, action ? [action] : [], `${method} ${route} enters the gateway as ${action}`);
        const [name, input] = state.store.at(-1);
        assert.equal(name, storeCall);
        for (const [field, value] of Object.entries(expected)) assert.deepEqual(input[field], value, `${method} ${route} passes ${field}`);
        assert.equal(input.scope.scopeKey, 'github:github.com:acme/demo');
      }

      /* Archiving needs its key: the service refuses before the store. */
      const before = state.store.length;
      const keyless = await call('POST', '/policies/p1/archive', { expectedRevision: 3, reason: 'tidy' });
      assert.equal(keyless.status, 400);
      assert.equal(keyless.json.code, 'GOVERNANCE_IDEMPOTENCY_KEY_REQUIRED');
      assert.equal(state.store.length, before);
    });
  }

  /* ---- An export is downloaded as its envelope; its creation carries its key ---- */
  {
    const state = freshState(10);
    const envelope = { kind: 'nebulaverse-governance-evidence', exportId: 'e1', signature: { keyId: 'k1', value: 'sig' } };
    state.answers.getEvidenceExport = envelope;
    await withServer(state, async call => {
      const answer = await call('GET', '/exports/e1');
      assert.equal(answer.status, 200, answer.text);
      assert.equal(answer.headers.get('content-disposition'), 'attachment; filename="nebulaverse-governance-e1.json"');
      assert.match(answer.headers.get('content-type'), /^application\/vnd\.nebulaverse\.governance-evidence-envelope\+json/);
      assert.equal(answer.text, JSON.stringify(envelope));
      assert.equal(state.store.at(-1)[1].exportId, 'e1');

      const created = await call('POST', '/exports', {}, { 'Idempotency-Key': 'export-7' });
      assert.equal(created.status, 201, created.text);
      assert.deepEqual(created.json, { export: { answered: 'createEvidenceExport' } });
      assert.deepEqual(state.actions, ['governance.audit.export.create']);
      assert.equal(state.store.at(-1)[1].idempotencyKey, 'export-7');
    });
  }

  /* ---- The digital twin answers with what this caller may do ---- */
  {
    for (const level of [10, 50]) {
      const state = freshState(level);
      state.answers.getDigitalTwinReadModelData = {
        asOf: new Date(NOW).toISOString(), policies: [], versions: [], drafts: [], exceptions: [], activations: [], decisions: [],
        completeness: { policies: true, versions: true, drafts: true, exceptions: true, activations: true, decisions: true }, nextDecisionSeq: null
      };
      await withServer(state, async call => {
        const answer = await call('GET', '/digital-twin?historyLimit=5');
        assert.equal(answer.status, 200, answer.text);
        assert(answer.json.digitalTwin && typeof answer.json.digitalTwin === 'object');
        assert.deepEqual(answer.json.access, JSON.parse(JSON.stringify(kepler.projectGovernanceInterfaceAccess(snapshot(level)))));
        assert.equal(answer.json.access.capabilities.read, true);
        assert.equal(answer.json.access.capabilities.administer, level >= 50);
        assert.equal(state.store.at(-1)[0], 'getDigitalTwinReadModelData');
        assert.equal(state.store.at(-1)[1].historyLimit, 5);
      });
    }
    assert.notDeepEqual(kepler.projectGovernanceInterfaceAccess(snapshot(10)), kepler.projectGovernanceInterfaceAccess(snapshot(50)), 'a reader and an administrator are shown different things');
  }

  /* ---- Failures keep a governance error's words, and never a raw one's ---- */
  {
    const state = freshState(10);
    const logged = [];
    const errors = console.error;
    console.error = (...args) => logged.push(args.join(' '));
    try {
      await withServer(state, async call => {
        state.storeFails = new Error('connection to db-internal.example:5432 refused for user nv_admin');
        const raw = await call('GET', '/policies');
        assert.equal(raw.status, 500);
        assert.deepEqual(raw.json, { error: 'Governance operation failed', code: 'GOVERNANCE_OPERATION_FAILED' });
        assert.equal(logged.length, 1);
        assert(!logged[0].includes('db-internal') && logged[0].includes('GOVERNANCE_OPERATION_FAILED'), 'the log names the code alone');

        state.storeFails = Object.assign(new Error(`Policy is stale ${'x'.repeat(400)}`), { code: 'GOVERNANCE_REVISION_CONFLICT', status: 409 });
        const known = await call('GET', '/policies');
        assert.equal(known.status, 409);
        assert.equal(known.json.code, 'GOVERNANCE_REVISION_CONFLICT');
        assert(known.json.error.startsWith('Policy is stale') && known.json.error.length <= 300);

        state.storeFails = Object.assign(new Error('odd status'), { code: 'POLICY_ODD', status: 700 });
        const odd = await call('GET', '/policies');
        assert.equal(odd.status, 500, 'a status outside 4xx and 5xx becomes 500');
        assert.equal(odd.json.code, 'POLICY_ODD');
        assert.equal(logged.length, 1, 'a governance error is not logged as a failure');
      });
    } finally {
      console.error = errors;
    }
  }

  console.log('kepler governance routes passed');
})().catch(error => { console.error(error); process.exit(1); });
