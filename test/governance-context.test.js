'use strict';
/*
 * Who may read and change a repository's governance, the context a
 * governance change runs in (Kepler's governance context), and what the
 * ledger records about each governance-shaped change (Kepler's governance
 * mutation metadata).
 */
const assert = require('assert');
const crypto = require('crypto');
const { OWN_WORK, createGovernanceContext, governanceMutationMetadata } = require('../apps/api/src/modules/kepler/index.ts');
const { identityKey } = require('../apps/api/src/modules/identity-access/index.ts');

let finished = false;
process.on('exit', code => { if (!finished && code === 0) { console.error('the governance context tests did not finish'); process.exitCode = 1; } });

const ACCOUNT = { provider: 'github', login: 'alice', token: 't' };
const KEY = identityKey(ACCOUNT);
const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise(resolve => setImmediate(resolve)); };

function snapshot(level, { publicRead = false, owner = 'alice', repo = 'demo' } = {}) {
  const baseRole = level >= 50 ? 'admin' : level >= 40 ? 'maintain' : level >= 30 ? 'write' : level >= 10 ? 'read' : 'none';
  return {
    schemaVersion: 1,
    scope: { provider: 'github', authority: 'github.com', owner, repo, scopeKey: `github:github.com:${owner}/${repo}`.toLowerCase() },
    executionPrincipal: { kind: 'user', identityKey: KEY, login: 'alice', authMethod: 'oauth' },
    governanceActor: { kind: 'human', identityKey: KEY, login: 'alice', verified: true },
    repositoryAccess: { baseRole, providerRole: baseRole, level, source: publicRead ? 'github.repository.public' : 'github.collaborator.permission', complete: true },
    governanceRoles: { reader: level >= 10, author: level >= 30, reviewer: level >= 40, activator: level >= 50, administrator: level >= 50 },
    installationCapabilities: null,
    evidence: { status: 'resolved', fetchedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(), reasonCode: null }
  };
}

function response() {
  const listeners = { finish: [], close: [] };
  const res = {
    headersSent: false, headers: {}, answer: null, listeners,
    setHeader(name, value) { res.headers[name] = value; },
    status(code) { res.answer = { status: code }; return res; },
    json(body) { res.answer.body = body; return res; },
    once(event, listener) { listeners[event].push(listener); },
    removeListener(event, listener) { listeners[event] = listeners[event].filter(l => l !== listener); },
    emit(event) { for (const listener of [...listeners[event]]) listener(); }
  };
  return res;
}

function harness(options = {}) {
  const calls = [];
  const runs = [];
  const gateway = {
    async run(descriptor, callback) {
      runs.push(descriptor);
      if (options.refuse) throw options.refuse;
      const out = await callback();
      if (options.after) throw options.after;
      return out;
    },
    current() { return { governance: true }; }
  };
  const guards = createGovernanceContext({
    gateway,
    governanceService: async () => { calls.push(['service']); if (options.serviceFails) throw new Error('store down'); return { service: 'governance' }; },
    resolveAuthorization: async input => { calls.push(['resolve', input]); return snapshot(options.level === undefined ? 50 : options.level, options); },
    identityKey,
    retainedActor: req => (req.alpha ? 'alpha-actor' : req.gh.login)
  });
  return { ...guards, calls, runs };
}
const request = (extra = {}) => ({
  method: 'POST', path: '/api/repo/alice/demo/governance/policies', route: { path: '/api/repo/:owner/:repo/governance/policies' },
  params: { owner: 'alice', repo: 'demo' }, body: {}, gh: { ...ACCOUNT }, ...extra
});
async function access(h, role, options, req = request()) {
  const res = response();
  let passed = false;
  await h.governanceAccess(role, options)(req, res, () => { passed = true; });
  return { req, res, passed };
}

(async () => {
  /* ---- Access ----------------------------------------------------------------------- */
  assert.deepStrictEqual(OWN_WORK, { publicRepositories: true });
  assert(Object.isFrozen(OWN_WORK));
  {
    const h = harness();
    const { req, res, passed } = await access(h, 'administrator');
    assert(passed);
    assert.strictEqual(res.headers['Cache-Control'], 'no-store', 'governance answers are never cached');
    assert.deepStrictEqual(h.calls, [['service'], ['resolve', { account: ACCOUNT, owner: 'alice', repo: 'demo', actorIdentityKey: KEY }]]);
    assert.deepStrictEqual([req.governance.service, req.governance.publicReader, req.governance.actor], [{ service: 'governance' }, false, { identityKey: KEY, login: 'alice' }]);
    assert.strictEqual(req.governance.scope.scopeKey, 'github:github.com:alice/demo');
  }
  {
    const { res, passed } = await access(harness({ level: 30 }), 'reviewer');
    assert.strictEqual(passed, false);
    assert.deepStrictEqual(res.answer, { status: 403, body: { error: 'The reviewer governance role is required', code: 'GOVERNANCE_ROLE_REQUIRED' } }, 'the role the route needs');
    assert.strictEqual((await access(harness({ level: 30 }), 'author')).passed, true);
  }
  {
    const refused = await access(harness({ level: 10, publicRead: true }), 'reader');
    assert.deepStrictEqual(refused.res.answer, { status: 403, body: { error: 'This is shared by the repository’s collaborators, and reading a public repository does not make you one', code: 'GOVERNANCE_COLLABORATORS_ONLY' } });
    const own = await access(harness({ level: 10, publicRead: true }), 'reader', OWN_WORK);
    assert.strictEqual(own.passed, true, 'a reader\'s own work is open to public readers');
    assert.strictEqual(own.req.governance.publicReader, true);
    const collaborator = await access(harness({ level: 10 }), 'reader');
    assert.strictEqual(collaborator.passed, true);
  }
  {
    const unnamed = await access(harness(), 'reader', undefined, request({ gh: { login: 'alice', token: 't' } }));
    assert.strictEqual(unnamed.passed, true, 'an account without a provider is GitHub\'s');
    const failed = await access(harness({ serviceFails: true }), 'reader');
    assert.deepStrictEqual(failed.res.answer, { status: 500, body: { error: 'Governance operation failed', code: 'GOVERNANCE_OPERATION_FAILED' } });
    const elsewhere = await access(harness({ owner: 'mallory' }), 'reader');
    assert.strictEqual(elsewhere.res.answer.body.code, 'GOVERNANCE_SCOPE_MISMATCH');
  }

  /* ---- The governance context --------------------------------------------------------- */
  {
    const h = harness();
    const { req } = await access(h, 'author', undefined, request({ gh: { provider: 'GitHub', login: 'alice', token: 't' }, body: { policyKey: 'Main-Branch' } }));
    const res = response();
    let ran = false;
    await h.governanceMutationContext('governance.policy.create')(req, res, () => { ran = true; assert.deepStrictEqual(req.mutation, { governance: true }); res.emit('finish'); });
    await settle();
    assert(ran);
    const descriptor = h.runs[0];
    assert.deepStrictEqual(
      [descriptor.action, descriptor.provider, descriptor.baseUrl, descriptor.owner, descriptor.repo, descriptor.actorIdentityKey, descriptor.actorLogin, descriptor.method, descriptor.route, descriptor.security],
      ['governance.policy.create', 'github', '', 'alice', 'demo', KEY, 'alice', 'POST', '/api/repo/:owner/:repo/governance/policies', {}],
      'described from the governance authorization, never the session\'s account'
    );
    assert.strictEqual(descriptor.authorization, req.governance.authorization);
    assert.deepStrictEqual(descriptor.metadata, { policyKey: 'Main-Branch' });
  }
  {
    const h = harness();
    const res = response();
    await h.governanceMutationContext('governance.reset')(request(), res, () => assert.fail('no route without governance access'));
    assert.deepStrictEqual(res.answer, { status: 403, body: { error: 'Governance authorization is required', code: 'GOVERNANCE_AUTHORIZATION_REQUIRED' } });
    assert.strictEqual(h.runs.length, 0);
  }
  {
    const refusal = Object.assign(new Error('Approval required'), { status: 403, code: 'POLICY_APPROVAL_REQUIRED' });
    const h = harness({ refuse: refusal });
    const { req } = await access(h, 'administrator');
    const res = response();
    await h.governanceMutationContext('governance.reset')(req, res, () => {});
    await settle();
    assert.deepStrictEqual(res.answer, { status: 403, body: { error: 'Approval required', code: 'POLICY_APPROVAL_REQUIRED' } }, 'a refusal is answered as governance\'s own');
  }
  {
    const late = Object.assign(new Error('ledger'), { code: 'GOVERNANCE_AUDIT_FAILED' });
    const h = harness({ after: late });
    const { req } = await access(h, 'administrator');
    const res = response();
    const logged = [];
    const saved = console.error;
    console.error = line => logged.push(line);
    try {
      await h.governanceMutationContext('governance.reset')(req, res, () => { res.headersSent = true; res.emit('finish'); });
      await settle();
    } finally { console.error = saved; }
    assert.strictEqual(res.answer, null, 'an answer already sent is not answered again');
    assert.deepStrictEqual(JSON.parse(logged[0]), { t: JSON.parse(logged[0]).t, warn: 'governance mutation context failed after headers', action: 'governance.reset', code: 'GOVERNANCE_AUDIT_FAILED' });
  }

  /* ---- What the ledger records -------------------------------------------------------- */
  {
    const meta = (action, body = {}, params = {}) => governanceMutationMetadata({ body, params: { owner: 'alice', repo: 'demo', ...params } }, action);
    const long = 'x'.repeat(300);
    assert.deepStrictEqual(meta('governance.policy.create', { policyKey: long }), { policyKey: 'x'.repeat(64) });
    assert.deepStrictEqual(meta('governance.draft.create', {}, { policyId: long }), { policyId: 'x'.repeat(80) });
    for (const action of ['governance.draft.update', 'governance.draft.submit', 'governance.draft.discard']) {
      assert.deepStrictEqual(meta(action, { expectedRevision: '3' }, { policyId: 'p', draftId: 'd' }), { policyId: 'p', draftId: 'd', expectedRevision: 3 }, action);
      assert.strictEqual(meta(action, { expectedRevision: -1 }, {}).expectedRevision, null, `${action}: a negative revision is no revision`);
      assert.strictEqual(meta(action, { expectedRevision: 1.5 }, {}).expectedRevision, null);
    }
    assert.deepStrictEqual(meta('governance.reviewer.assign', {}, { policyId: 'p', versionId: 'v' }), { policyId: 'p', versionId: 'v' });
    assert.deepStrictEqual(meta('governance.approval.decide', { decision: 'APPROVE-WITH-A-LONG-TAIL' }, { policyId: 'p', versionId: 'v' }), { policyId: 'p', versionId: 'v', decision: 'approve-with-a-l' });
    const ruleIds = ['B', 'a', ...Array.from({ length: 60 }, (_, i) => `r${String(i).padStart(2, '0')}`)];
    const request = meta('governance.exception.request', { ruleIds, kind: 'WAIVER', action: 'FILE.WRITE', target: { path: 'x' }, expiresAt: '2026-12-01' }, { policyId: 'p', versionId: 'v' });
    assert.strictEqual(request.ruleIds.length, 51, 'at most 51 rule ids are kept');
    assert.deepStrictEqual(request.ruleIds.slice(0, 3), ['a', 'b', 'r00'], 'lower case and sorted');
    assert.deepStrictEqual([request.kind, request.action, request.target, request.ruleCount, request.expiresAt], ['waiver', 'file.write', { path: 'x' }, 62, '2026-12-01'], 'the count is of what was asked');
    assert.strictEqual(meta('governance.exception.request', { target: ['x'] }).target, null, 'a target is an object, never a list');
    assert.deepStrictEqual(meta('governance.exception.request', { ruleIds: 'x' }).ruleIds, []);
    assert.deepStrictEqual(meta('governance.exception.decide', { decision: 'DENY' }, { exceptionId: 'e' }), { exceptionId: 'e', decision: 'deny' });
    assert.deepStrictEqual(meta('governance.exception.revoke', {}, { exceptionId: 'e' }), { exceptionId: 'e' });
    for (const action of ['governance.policy.deactivate', 'governance.policy.archive']) {
      assert.deepStrictEqual(meta(action, { expectedRevision: 0 }, { policyId: 'p' }), { policyId: 'p', expectedRevision: 0 });
    }
    assert.deepStrictEqual(meta('governance.policy.restore', {}, { policyId: 'p' }), { policyId: 'p' });
    assert.deepStrictEqual(meta('governance.version.withdraw', {}, { policyId: 'p', versionId: 'v' }), { policyId: 'p', versionId: 'v' });
    assert.deepStrictEqual(meta('governance.reset', { confirm: 'Alice/Demo' }), { confirmed: true }, 'whether the typed confirmation matched, without regard to case');
    assert.deepStrictEqual(meta('governance.reset', { confirm: 'alice/other' }), { confirmed: false }, 'never what was typed');
    for (const action of ['governance.policy.activate', 'governance.policy.rollback']) {
      assert.deepStrictEqual(meta(action, { expectedRevision: 2, simulation: { simulationHash: 'ABC' } }, { policyId: 'p', versionId: 'v' }), { policyId: 'p', versionId: 'v', expectedRevision: 2, simulationHash: 'abc' });
      assert.strictEqual(meta(action, { simulation: 'x' }).simulationHash, '');
    }
    assert.deepStrictEqual(meta('exposure.credential.verify', {}, { fingerprint: 'f' }), { fingerprint: 'f' });
    assert.deepStrictEqual(meta('code-audit.finding.triage', { rule: 'R'.repeat(30), disposition: 'ACCEPTED', reason: 'FALSE-POSITIVE', expiresInDays: 3650 }, { findingId: 'x' }),
      { findingId: 'x', rule: 'R'.repeat(16), disposition: 'accepted', reason: 'false-positive', expiresInDays: 3650 });
    for (const days of [0, 3651, 1.5, 'x']) assert.strictEqual(meta('code-audit.finding.triage', { expiresInDays: days }).expiresInDays, null, `${days} days`);
    assert.deepStrictEqual(meta('code-audit.finding.reopen', {}, { findingId: 'x' }), { findingId: 'x' });
    assert.deepStrictEqual(meta('exposure.readability.probe', { relation: 'public.users', projection: Array(150).fill('c') }, { fingerprint: 'f' }), { fingerprint: 'f', relation: 'public.users', columnCount: 100 });
    assert.deepStrictEqual(meta('governance.notification.preferences.update', { enabled: 'true', eventTypes: Array(120).fill('e') }), { enabled: false, eventCount: 100 }, 'only true enables');
    assert.deepStrictEqual(meta('governance.notification.read', { throughSeq: 9 }), { throughSeq: 9 });
    for (const action of ['governance.webhook.create', 'governance.webhook.update']) {
      assert.deepStrictEqual(meta(action, { url: 'https://hooks.example/x', eventTypes: ['a'] }, { webhookId: 'w' }), {
        webhookId: 'w', destinationHash: crypto.createHash('sha256').update('https://hooks.example/x').digest('hex'), eventCount: 1, enabled: true
      }, 'the address is recorded by its digest only, and a hook is enabled unless turned off');
      assert.strictEqual(meta(action, { enabled: false }).enabled, false);
    }
    for (const action of ['governance.webhook.rotate', 'governance.webhook.delete']) assert.deepStrictEqual(meta(action, {}, { webhookId: 'w' }), { webhookId: 'w' });
    assert.deepStrictEqual(meta('governance.audit.export.create', { format: 'JSONL-EXTRA', afterEventSeq: -1, throughEventSeq: 5 }), { format: 'jsonl-ex', afterEventSeq: null, throughEventSeq: 5 });
    assert.deepStrictEqual(meta('governance.unknown', { a: 1 }), {});
    assert.deepStrictEqual(governanceMutationMetadata({ body: Buffer.from('{"policyKey":"x"}'), params: {} }, 'governance.policy.create'), { policyKey: '' }, 'a raw body is not read');
  }

  finished = true;
  console.log('Governance context tests passed');
})().catch(error => { finished = true; console.error(error); process.exit(1); });
