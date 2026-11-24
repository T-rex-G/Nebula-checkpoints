'use strict';
/*
 * The context a repository change runs in (the platform's mutation context),
 * and a merge's facts for the policy (Uranus): the policy headers, the run
 * and when it ends, the metadata and the descriptor of every action, the
 * authorization and its alpha relabelling, the safe passage, and the context
 * itself when it runs, refuses or fails.
 */
const assert = require('assert');
const {
  applyPolicyDecisionHeaders, createRepositoryMutationContext, runInMutationContext
} = require('../apps/api/src/platform/mutation-gateway/mutation-context.ts');
const { normalizeFileBatch } = require('../apps/api/src/platform/mutation-gateway/mutation-coverage.ts');
const { pathFactsForAction } = require('../apps/api/src/platform/mutation-gateway/protected-paths.ts');
/* An action's metadata with the repository paths it touches (protected-paths.ts). */
const withPaths = (action, base) => ({ ...base, ...pathFactsForAction(action, base) });
const { identityKey, alphaActorLabel } = require('../apps/api/src/modules/identity-access/index.ts');
const { activePolicySetStepEvaluator } = require('../apps/api/src/modules/kepler/index.ts');
const { auditTriage, mergeFactsFor } = require('../apps/api/src/modules/uranus/index.ts');

let finished = false;
process.on('exit', code => { if (!finished && code === 0) { console.error('the mutation context tests did not finish'); process.exitCode = 1; } });

const ACCOUNT = { provider: 'github', login: 'alice', token: 't' };
const TESTER = 'ab'.repeat(16);
const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise(resolve => setImmediate(resolve)); };

function response() {
  const listeners = { finish: [], close: [] };
  const headers = {};
  const res = {
    headersSent: false, headers, listeners,
    setHeader(name, value) { headers[name] = value; },
    once(event, listener) { listeners[event].push(listener); },
    removeListener(event, listener) { listeners[event] = listeners[event].filter(l => l !== listener); },
    emit(event) { for (const listener of [...listeners[event]]) listener(); }
  };
  return res;
}

function gatewayOf(options = {}) {
  const runs = [];
  let current = null;
  return {
    runs,
    async run(descriptor, callback) {
      runs.push(descriptor);
      if (options.refuse) throw options.refuse;
      current = { action: descriptor.action, ...(options.decision ? { policyDecision: options.decision } : {}) };
      try {
        const out = await callback();
        if (options.after) throw options.after;
        return out;
      } finally { current = null; }
    },
    current() { return current; }
  };
}

/* A resolved repository authorization, as the resolver gives it, for a writer. */
function snapshotFor(owner = 'alice', repo = 'demo') {
  const key = identityKey(ACCOUNT);
  return {
    schemaVersion: 1,
    scope: { provider: 'github', authority: 'github.com', owner, repo, scopeKey: `github:github.com:${owner}/${repo}`.toLowerCase() },
    executionPrincipal: { kind: 'user', identityKey: key, login: 'alice', authMethod: 'oauth' },
    governanceActor: { kind: 'human', identityKey: key, login: 'alice', verified: true },
    repositoryAccess: { baseRole: 'write', providerRole: 'write', level: 30, source: 'github.collaborator.permission', complete: true },
    governanceRoles: { reader: true, author: true, reviewer: false, activator: false, administrator: false },
    installationCapabilities: null,
    evidence: { status: 'resolved', fetchedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(), reasonCode: null }
  };
}

function context(options = {}) {
  const calls = [];
  const gateway = options.gateway || gatewayOf();
  const deps = {
    gateway, identityKey, retainedActor: req => { calls.push(['retainedActor']); return req.alpha ? 'alpha-actor' : req.gh.login; },
    resolveAuthorization: async input => { calls.push(['resolve', input]); if (options.authFails) throw options.authFails; return snapshotFor(input.owner, input.repo); },
    alphaEnabled: options.alphaEnabled === true, alphaActorLabel,
    mergeFacts: async req => { calls.push(['mergeFacts', req.params.num]); return { branch: 'main', head: 'feature', audit: { state: 'clear' } }; },
    inspectRestoreAuthorization: (target, authorization) => { calls.push(['inspect', target, authorization]); return { actions: options.actions || [{ ref: 'refs/heads/main', action: 'update' }] }; },
    ready: async () => { calls.push(['ready']); return options.ready !== false; },
    resolveActivePolicySet: async input => { calls.push(['policySet', input]); return { activePolicies: [], activeExceptions: [], resolvedAt: new Date().toISOString() }; },
    stepEvaluator: options.stepEvaluator || (input => { calls.push(['stepEvaluator', input]); return activePolicySetStepEvaluator(input); }),
    fail: (res, error) => { calls.push(['fail', error]); return 'failed'; }
  };
  return { ...createRepositoryMutationContext(deps), calls, gateway };
}

const request = (extra = {}) => ({
  method: 'PUT', path: '/api/repo/alice/demo/file', route: { path: '/api/repo/:owner/:repo/file' },
  params: { owner: 'alice', repo: 'demo' }, query: {}, body: {}, gh: { ...ACCOUNT }, ...extra
});

(async () => {
  /* ---- The policy headers ---------------------------------------------------------- */
  {
    const res = response();
    applyPolicyDecisionHeaders(res, null);
    assert.deepStrictEqual(res.headers, {});
    applyPolicyDecisionHeaders(res, { enforcementOutcome: 'warn', rolloutMode: 'observe', decisionId: 'd-1', warningCodes: Array.from({ length: 10 }, (_, i) => `W${i}`) });
    assert.deepStrictEqual(res.headers, {
      'X-Nebulaverse-Policy-Outcome': 'warn', 'X-Nebulaverse-Policy-Mode': 'observe', 'X-Nebulaverse-Policy-Decision': 'd-1',
      'X-Nebulaverse-Policy-Warning': 'W0,W1,W2,W3,W4,W5,W6,W7'
    });
    const quiet = response();
    applyPolicyDecisionHeaders(quiet, { enforcementOutcome: 'allow', rolloutMode: 'enforce', warningCodes: [] });
    assert.deepStrictEqual(quiet.headers, { 'X-Nebulaverse-Policy-Outcome': 'allow', 'X-Nebulaverse-Policy-Mode': 'enforce' });
  }

  /* ---- The run ------------------------------------------------------------------- */
  for (const event of ['finish', 'close']) {
    const gateway = gatewayOf({ decision: { enforcementOutcome: 'allow', rolloutMode: 'enforce', decisionId: 'd-2' } });
    const res = response();
    const req = request();
    let ended = false;
    const run = runInMutationContext(gateway, { action: 'file.write' }, req, res, () => {
      assert.deepStrictEqual(req.mutation, { action: 'file.write', policyDecision: { enforcementOutcome: 'allow', rolloutMode: 'enforce', decisionId: 'd-2' } }, 'the route sees the context');
    }).then(() => { ended = true; });
    await settle();
    assert.strictEqual(ended, false, 'the run lasts until the answer');
    assert.strictEqual(res.headers['X-Nebulaverse-Policy-Decision'], 'd-2');
    res.emit(event);
    await run;
    assert.strictEqual(ended, true, `${event} ends the run`);
    assert.deepStrictEqual([res.listeners.finish.length, res.listeners.close.length], [0, 0], 'and leaves no listener behind');
  }
  {
    const res = response();
    const thrown = new Error('route threw');
    await assert.rejects(runInMutationContext(gatewayOf(), { action: 'x' }, request(), res, () => { throw thrown; }), error => error === thrown);
    assert.deepStrictEqual([res.listeners.finish.length, res.listeners.close.length], [0, 0], 'a throwing route leaves no listener behind');
  }

  /* ---- The metadata of every action ------------------------------------------------- */
  {
    const c = context();
    const meta = (action, extra) => c.mutationMetadataFor(request(extra), action);
    const long = 'x'.repeat(2000);
    assert.deepStrictEqual(meta('repository.create', { body: { name: long } }), withPaths('repository.create', { name: 'x'.repeat(100), private: true, autoInit: true }));
    assert.deepStrictEqual(meta('repository.create', { body: { name: 'r', isPrivate: false, autoInit: false } }), withPaths('repository.create', { name: 'r', private: false, autoInit: false }));
    assert.deepStrictEqual(meta('repository.create', { body: { name: 'r', isPrivate: 0, autoInit: 0 } }), withPaths('repository.create', { name: 'r', private: true, autoInit: true }), 'only false turns them off');
    assert.deepStrictEqual(meta('branch.create', { body: { name: 'b', from: 'main' } }), withPaths('branch.create', { branch: 'b', sourceBranch: 'main' }));
    assert.deepStrictEqual(meta('branch.delete', { params: { owner: 'alice', repo: 'demo', name: 'old' } }), withPaths('branch.delete', { branch: 'old' }));
    assert.deepStrictEqual(meta('branch.reset', { body: { branch: 'main', sha: 'a'.repeat(50), expectedHeadSha: 'b'.repeat(40) } }), withPaths('branch.reset', { branch: 'main', targetSha: 'a'.repeat(40), expectedHeadSha: 'b'.repeat(40) }));
    assert.deepStrictEqual(meta('file.write', { body: { branch: 'main', path: 'src/a.js', expectedHeadSha: 'c' } }), { branch: 'main', path: 'src/a.js', expectedHeadSha: 'c', paths: ['src/a.js'], pathCoverage: 'exact' });
    assert.deepStrictEqual(meta('file.delete', { body: { branch: 'main', path: 'b\nc' } }).path, 'b c', 'control characters become spaces');
    assert.deepStrictEqual(meta('file.rename', { body: { branch: 'm', from: 'a', to: 'b', expectedHeadSha: 'h' } }), { branch: 'm', from: 'a', to: 'b', expectedHeadSha: 'h', paths: ['a', 'b'], pathCoverage: 'exact' });
    const ops = [{ op: 'put', path: 'a.js', content: 'eA==' }, { op: 'delete', path: 'b.js', sha: 'a'.repeat(40) }];
    const batch = meta('file.batch', { body: { branch: 'm', ops, expectedHeadSha: 'h' } });
    const summary = normalizeFileBatch(ops).summary;
    assert.deepStrictEqual([batch.itemCount, batch.itemIds, batch.batchHash, batch.payloadBytes], [summary.itemCount, summary.itemIds, summary.batchHash, summary.payloadBytes]);
    assert.deepStrictEqual([batch.branch, batch.expectedHeadSha], ['m', 'h']);
    assert.throws(() => meta('file.batch', { body: { ops: 'bad' } }), /File batch requires/);
    assert.deepStrictEqual(meta('commit.revert', { body: { branch: 'm', sha: 's', expectedHeadSha: 'h' } }), withPaths('commit.revert', { branch: 'm', commitSha: 's', expectedHeadSha: 'h' }));
    assert.deepStrictEqual(meta('commit.restore', { body: { branch: 'm', sha: 's' } }), withPaths('commit.restore', { branch: 'm', commitSha: 's', expectedHeadSha: '' }));
    assert.deepStrictEqual(meta('commit.restore-paths', { body: { branch: 'm', sha: 's', prefix: 'docs' } }).pathPrefix, 'docs');
    assert.deepStrictEqual(meta('pull.create', { body: { head: 'f', base: 'main', draft: 1 } }), withPaths('pull.create', { head: 'f', base: 'main', draft: true }));
    const merge = c.mutationMetadataFor({ ...request({ params: { owner: 'alice', repo: 'demo', num: '7' } }), mergeFacts: { branch: 'main', head: 'f', audit: { state: 'clear' } } }, 'pull.merge');
    assert.deepStrictEqual(merge, withPaths('pull.merge', { pullNumber: 7, mergeMethod: 'merge', branch: 'main', head: 'f', audit: { state: 'clear' } }), 'a merge carries its facts, and merges by default');
    assert.deepStrictEqual(meta('pull.merge', { params: { owner: 'a', repo: 'b' }, body: { method: 'squash' } }), withPaths('pull.merge', { pullNumber: 0, mergeMethod: 'squash' }));
    assert.deepStrictEqual(meta('pull.review', { params: { owner: 'a', repo: 'b', num: '2' }, body: { event: 'APPROVE' } }), withPaths('pull.review', { pullNumber: 2, event: 'APPROVE' }));
    assert.deepStrictEqual(meta('issue.create'), withPaths('issue.create', {}));
    assert.deepStrictEqual(meta('issue.comment', { params: { owner: 'a', repo: 'b', num: '4' } }), withPaths('issue.comment', { issueNumber: 4 }));
    assert.deepStrictEqual(meta('issue.update', { params: { owner: 'a', repo: 'b', num: '4' }, body: { state: 'closed' } }), withPaths('issue.update', { issueNumber: 4, state: 'closed' }));
    assert.deepStrictEqual(meta('workflow.rerun', { params: { owner: 'a', repo: 'b', runId: '99' } }), withPaths('workflow.rerun', { runId: '99' }));
    assert.deepStrictEqual(meta('release.create', { body: { tag_name: 'v1', target_commitish: 'main' } }), withPaths('release.create', { tag: 'v1', target: 'main' }), 'GitHub\'s own field names are read too');
    assert.deepStrictEqual(meta('git.blob.create', { query: { path: 'a.bin' } }), { path: 'a.bin', paths: ['a.bin'], pathCoverage: 'exact' });
    assert.deepStrictEqual(meta('file.upload', { query: { path: 'a.bin', branch: 'main' } }).lfsMode, 'auto', 'an upload decides LFS itself unless told');
    assert.deepStrictEqual(meta('directory.move', { body: { branch: 'm', from: 'a', to: 'b' } }).from, 'a');
    const restore = meta('recovery.restore-refs', { body: { confirm: 'RESTORE-THE-REFERENCES-NOW', authorization: 'grant' } });
    assert.strictEqual(restore.confirmation, 'RESTORE-THE-REFERENC', 'the confirmation is bounded to 20 characters');
    assert.deepStrictEqual(c.calls.at(-1), ['inspect', { account: ACCOUNT, owner: 'alice', repo: 'demo' }, 'grant'], 'the preview is inspected, never spent');
    assert(restore.itemCount === 1 && Array.isArray(restore.itemIds), 'the restore is summarised from what it would do');
    assert.deepStrictEqual(meta('something.else', { body: { name: 'x' } }), withPaths('something.else', {}));
    assert.deepStrictEqual(c.mutationMetadataFor(request({ body: Buffer.from('{"name":"x"}') }), 'repository.create'), withPaths('repository.create', { name: '', private: true, autoInit: true }), 'a raw body is not read');
  }

  /* ---- The descriptor ------------------------------------------------------------------ */
  {
    const c = context();
    const created = c.mutationDescriptorFor(request({ body: { name: 'fresh' }, params: { owner: 'bob', repo: 'other' }, gh: { login: 'alice', token: 't' }, route: null, path: '/api/repos', method: 'POST', authorization: { a: 1 } }), 'repository.create');
    assert.deepStrictEqual(
      [created.provider, created.baseUrl, created.owner, created.repo, created.actorLogin, created.route, created.security, created.authorization],
      ['github', '', 'alice', 'fresh', 'alice', '/api/repos', {}, { a: 1 }], 'a new repository is the account\'s own, named by the body'
    );
    assert.strictEqual(created.actorIdentityKey, identityKey({ login: 'alice' }));
    const write = c.mutationDescriptorFor(request({ alpha: { testerId: TESTER }, stepUp: { action: 'pull.merge', assurance: 'credential', authorizedAt: 5 } }), 'file.write');
    assert.deepStrictEqual([write.owner, write.repo, write.actorLogin, write.route, write.method], ['alice', 'demo', 'alpha-actor', '/api/repo/:owner/:repo/file', 'PUT']);
    assert.deepStrictEqual(write.security, { stepUpAction: 'pull.merge', assurance: 'credential', authorizedAt: 5 });
    assert.deepStrictEqual(write.metadata.paths, [], 'the metadata is the action\'s');
  }

  /* ---- The authorization and the context ------------------------------------------------- */
  {
    const c = context();
    const req = request({ method: 'POST', path: '/api/repos', body: { name: 'fresh' } });
    const res = response();
    let ran = false;
    await c.mutationContext('repository.create')(req, res, () => { ran = true; res.emit('finish'); });
    await settle();
    assert(ran);
    assert(!c.calls.some(call => call[0] === 'resolve'), 'a repository that does not exist yet has no authorization to resolve');
    assert.deepStrictEqual([req.authorization.evidence.status, req.authorization.evidence.reasonCode], ['unavailable', 'AUTHORIZATION_SCOPE_NOT_APPLICABLE']);
    assert.strictEqual(c.gateway.runs[0].authorization, req.authorization);
  }
  for (const [alphaEnabled, alpha, relabelled] of [[true, { testerId: TESTER }, true], [false, { testerId: TESTER }, false], [true, undefined, false]]) {
    const c = context({ alphaEnabled });
    const req = request({ alpha });
    await c.mutationContext('file.write')(req, response(), () => {});
    const label = alphaActorLabel({ testerId: TESTER });
    assert.deepStrictEqual(c.calls[0], ['resolve', { account: ACCOUNT, owner: 'alice', repo: 'demo', actorIdentityKey: identityKey(ACCOUNT) }]);
    assert.deepStrictEqual(
      [req.authorization.executionPrincipal.login, req.authorization.governanceActor.login],
      relabelled ? [label, label] : ['alice', 'alice'], `alpha ${alphaEnabled} ${!!alpha}`
    );
    assert.strictEqual(req.authorization.executionPrincipal.kind, 'user', 'the rest of the principal is kept');
  }
  {
    const c = context();
    const req = request({ params: { owner: 'alice', repo: 'demo', num: '9' }, body: { method: 'squash' } });
    await c.mutationContext('pull.merge')(req, response(), () => {});
    assert.deepStrictEqual(c.calls.find(call => call[0] === 'mergeFacts'), ['mergeFacts', '9']);
    assert.deepStrictEqual(req.mergeFacts, { branch: 'main', head: 'feature', audit: { state: 'clear' } });
    assert.deepStrictEqual(c.gateway.runs[0].metadata, withPaths('pull.merge', { pullNumber: 9, mergeMethod: 'squash', branch: 'main', head: 'feature', audit: { state: 'clear' } }));
    const other = context();
    await other.mutationContext('file.write')(request(), response(), () => {});
    assert(!other.calls.some(call => call[0] === 'mergeFacts'), 'only a merge reads merge facts');
  }
  {
    const refused = Object.assign(new Error('Authorization unavailable'), { status: 503, code: 'AUTHORIZATION_UNAVAILABLE' });
    const c = context({ authFails: refused });
    const returned = await c.mutationContext('file.write')(request(), response(), () => assert.fail('the route must not run'));
    assert.strictEqual(returned, 'failed');
    assert.deepStrictEqual(c.calls.at(-1), ['fail', refused]);
    assert.strictEqual(c.gateway.runs.length, 0);
  }

  /* ---- The safe passage ------------------------------------------------------------------- */
  const write = (extra = {}) => request({ body: { branch: 'main', path: 'src/a.js', content: 'hello', expectedHeadSha: 'a'.repeat(40) }, ...extra });
  const approval = () => Object.assign(new Error('Approval required'), { status: 403, code: 'POLICY_APPROVAL_REQUIRED' });
  {
    const c = context({ gateway: gatewayOf({ refuse: approval() }) });
    const req = write();
    await c.mutationContext('file.write')(req, response(), () => assert.fail('a refused change does not run'));
    await settle();
    const failed = c.calls.find(call => call[0] === 'fail')[1];
    assert.strictEqual(failed.code, 'POLICY_APPROVAL_REQUIRED');
    assert.strictEqual(failed.safePassage.available, true, 'an approval refusal offers the route to approval');
    assert.strictEqual(failed.safePassage.kind, 'pull-request');
    const evaluated = c.calls.find(call => call[0] === 'stepEvaluator')[1];
    assert.deepStrictEqual([evaluated.activePolicies, evaluated.activeExceptions], [[], []], 'judged by the active policy set it read');
    const asked = c.calls.find(call => call[0] === 'policySet')[1];
    assert.strictEqual(asked.action, 'file.write');
  }
  {
    const listed = context();
    listed.calls.length = 0;
    const deps = { activePolicies: [{ policyId: 'p' }], activeExceptions: [{ exceptionId: 'e' }] };
    const c = createRepositoryMutationContext({
      gateway: gatewayOf(), identityKey, retainedActor: () => 'alice', resolveAuthorization: async () => snapshotFor(),
      alphaEnabled: false, alphaActorLabel, mergeFacts: async () => ({}), inspectRestoreAuthorization: () => ({ actions: [] }),
      ready: async () => true, resolveActivePolicySet: async () => ({ ...deps, resolvedAt: 'then' }),
      stepEvaluator: input => { listed.calls.push(input); return () => ({ effectiveEffect: 'deny', enforcementOutcome: 'block' }); },
      fail: () => {}
    });
    const req = write();
    const descriptor = c.mutationDescriptorFor({ ...req, authorization: snapshotFor() }, 'file.write');
    const saved = console.error;
    const logged = [];
    console.error = line => logged.push(line);
    let offer;
    try { offer = await c.safePassageFor(req, 'file.write', descriptor, approval()); }
    finally { console.error = saved; }
    assert.deepStrictEqual([listed.calls[0].activePolicies, listed.calls[0].activeExceptions, listed.calls[0].evaluatedAt], [deps.activePolicies, deps.activeExceptions, 'then']);
    assert.strictEqual(offer, null, 'a route the policy would also refuse is no offer');
  }
  {
    const c = context();
    const req = write();
    const descriptor = c.mutationDescriptorFor({ ...req, authorization: snapshotFor() }, 'file.write');
    c.calls.length = 0;
    assert.strictEqual(await c.safePassageFor(req, 'file.write', descriptor, Object.assign(new Error('no'), { code: 'POLICY_BLOCKED' })), null, 'only an approval refusal');
    assert.strictEqual(await c.safePassageFor(req, 'file.delete', descriptor, approval()), null, 'only for a write');
    assert.strictEqual(await c.safePassageFor(write({ body: { branch: 'main', path: 'a', content: 5 } }), 'file.write', descriptor, approval()), null, 'only with the content in hand');
    assert.strictEqual(await c.safePassageFor(req, 'file.write', null, approval()), null);
    assert.deepStrictEqual(c.calls, [], 'none of them reads the database or the policy set');
    const down = context({ ready: false });
    assert.strictEqual(await down.safePassageFor(req, 'file.write', descriptor, approval()), null, 'not without a database');
    assert(!down.calls.some(call => call[0] === 'policySet'));
    const logged = [];
    const saved = console.error;
    console.error = line => logged.push(line);
    try {
      const broken = context({ stepEvaluator: () => { throw Object.assign(new Error('bad'), { code: 'POLICY_SET_INVALID' }); } });
      assert.strictEqual(await broken.safePassageFor(req, 'file.write', descriptor, approval()), null);
    } finally { console.error = saved; }
    assert.deepStrictEqual(JSON.parse(logged[0]).warn, 'safe passage offer could not be built');
    assert.deepStrictEqual(JSON.parse(logged[0]).code, 'POLICY_SET_INVALID');
  }
  {
    const blocked = Object.assign(new Error('Blocked'), { status: 403, code: 'POLICY_BLOCKED' });
    const c = context({ gateway: gatewayOf({ refuse: blocked }) });
    await c.mutationContext('file.write')(write(), response(), () => {});
    await settle();
    assert.strictEqual(c.calls.find(call => call[0] === 'fail')[1].safePassage, undefined, 'another refusal is answered as it is');
  }

  /* ---- A failure after the answer has begun ------------------------------------------------- */
  for (const [error, code] of [[Object.assign(new Error('ledger'), { code: 'MUTATION_EVIDENCE_FAILED' }), 'MUTATION_EVIDENCE_FAILED'], [new Error('plain'), 'MUTATION_GATEWAY_FAILED']]) {
    const c = context({ gateway: gatewayOf({ after: error }) });
    const res = response();
    const logged = [];
    const saved = console.error;
    console.error = line => logged.push(line);
    try {
      await c.mutationContext('file.write')(request(), res, () => { res.headersSent = true; res.emit('finish'); });
      await settle();
    } finally { console.error = saved; }
    assert(!c.calls.some(call => call[0] === 'fail'), 'an answer already sent is not answered again');
    assert.deepStrictEqual(JSON.parse(logged[0]), { t: JSON.parse(logged[0]).t, warn: 'mutation gateway context failed after headers', action: 'file.write', code });
  }
  {
    const c = context({ gateway: gatewayOf({ after: Object.assign(new Error('ledger'), { code: 'MUTATION_EVIDENCE_FAILED' }) }) });
    const res = response();
    await c.mutationContext('file.write')(request(), res, () => { res.emit('finish'); });
    await settle();
    assert.strictEqual(c.calls.find(call => call[0] === 'fail')[1].code, 'MUTATION_EVIDENCE_FAILED', 'before the answer, a failure is answered');
  }

  /* ---- A provider change made for an account, beyond a route's own repository --------------- */
  {
    const c = context();
    const disconnecting = request({ method: 'POST', path: '/api/alpha/providers/disconnect-all', route: { path: '/api/alpha/providers/disconnect-all' }, params: {} });
    const account = { provider: 'github', login: 'alice', token: 'resolved' };
    let inside = null;
    const answer = await c.runProviderMutation(disconnecting, { account, action: 'webhook.disconnect', owner: 'acme', repo: 'demo', method: 'DELETE' }, async () => {
      inside = c.gateway.current();
      return 'removed';
    });
    assert.strictEqual(answer, 'removed', 'the write runs, and its answer is returned');
    assert.deepStrictEqual(inside, { action: 'webhook.disconnect' }, 'inside the gateway, as the action named');
    assert.deepStrictEqual(c.calls.find(call => call[0] === 'resolve')[1], { account, owner: 'acme', repo: 'demo', actorIdentityKey: identityKey(account) },
      'the account\'s authorization on that repository is resolved');
    const [descriptor] = c.gateway.runs;
    assert.deepStrictEqual(
      [descriptor.action, descriptor.provider, descriptor.owner, descriptor.repo, descriptor.method, descriptor.route, descriptor.actorLogin, descriptor.authorization.scope.scopeKey],
      ['webhook.disconnect', 'github', 'acme', 'demo', 'DELETE', '/api/alpha/providers/disconnect-all', 'alice', 'github:github.com:acme/demo'],
      'and the change is described as a route\'s is, under the route that made it'
    );
  }
  {
    const c = context({ alphaEnabled: true });
    const tester = request({ alpha: { testerId: TESTER }, route: { path: '/api/alpha/providers/disconnect-all' }, params: {} });
    await c.runProviderMutation(tester, { account: ACCOUNT, action: 'webhook.disconnect', owner: 'acme', repo: 'demo', method: 'DELETE' }, async () => {});
    const [descriptor] = c.gateway.runs;
    assert.deepStrictEqual([descriptor.actorLogin, descriptor.authorization.executionPrincipal.login], ['alpha-actor', alphaActorLabel({ testerId: TESTER })],
      'in the alpha, the principal is recorded under the tester\'s label');
  }
  {
    const unavailable = Object.assign(new Error('Not Found'), { status: 404 });
    const c = context({ authFails: unavailable });
    let ran = false;
    await assert.rejects(
      c.runProviderMutation(request(), { account: ACCOUNT, action: 'webhook.disconnect', owner: 'acme', repo: 'demo', method: 'DELETE' }, async () => { ran = true; }),
      error => error === unavailable
    );
    assert.deepStrictEqual([ran, c.gateway.runs.length], [false, 0], 'an authorization that cannot be resolved stops the change before the gateway');
  }

  /* ---- A merge's facts (Uranus) --------------------------------------------------------------- */
  {
    const calls = [];
    const pull = { number: 7, head: 'feature', base: 'main', headSha: 'a'.repeat(40), fork: false, open: true };
    const gate = { ...auditTriage.unavailableGate(), state: 'blocked', grade: 'C' };
    const audit = {
      async readPullFacts(target, number) { calls.push(['read', target, number]); return pull; },
      async mergeGateFor(account, owner, repo, given) { calls.push(['gate', account, owner, repo, given]); return gate; }
    };
    const target = { account: ACCOUNT, owner: 'alice', repo: 'demo' };
    assert.deepStrictEqual(await mergeFactsFor(audit, target, '7'), auditTriage.mergeAttributes(pull, gate));
    assert.deepStrictEqual(calls, [['read', target, 7], ['gate', ACCOUNT, 'alice', 'demo', pull]]);
    assert.strictEqual(typeof calls[0][2], 'number', 'the number is read as a number');
    const unreadable = { async readPullFacts() { throw new Error('gone'); }, async mergeGateFor() { assert.fail('no gate without a pull request'); } };
    assert.deepStrictEqual(await mergeFactsFor(unreadable, target, 'x'), { audit: auditTriage.gateAttributes(auditTriage.unavailableGate()) }, 'an unreadable pull request leaves the gate unavailable');
  }

  finished = true;
  console.log('Mutation context tests passed');
})().catch(error => { finished = true; console.error(error); process.exit(1); });
