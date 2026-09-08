'use strict';

const assert = require('assert');
const crypto = require('crypto');
const express = require('express');
const { createWorkspaceRouter } = require('../src/workspace-api');
const { createWorkspaceWorkbenchRouter, workspaceCapabilities } = require('../src/workspace-workbench');
const { createWorkspaceMutationRunner } = require('../src/workspace-mutation');
const { workspaceExecutionAuthority } = require('../src/workspace-authority');
const { createMutationGateway } = require('../src/mutation-gateway');
const { evaluateActivePolicySet } = require('../src/governance-enforcement');
const { policyDocumentHash } = require('../src/governance-model');
const { normalizeRepoPath, normalizeBranchName, normalizeProviderBranches } = require('../src/intelligence');
const { publicErrorBody } = require('../src/public-errors');
const { loadCapabilityDocument, projectCapabilities, assertCapabilityAvailable } = require('../src/capability-registry');

async function main() {
  const document = loadCapabilityDocument(require('path').join(__dirname, '../config/public-alpha-capabilities.json'));
  const capabilityContext = { provider: 'github', authority: 'github.com', deployment: 'hosted-alpha' };
  const projection = projectCapabilities(document, capabilityContext);
  assert.strictEqual(projection.features['repository.create'].status, 'Unavailable');
  assert.strictEqual(workspaceCapabilities(projection).features['repository.create'].status, 'Experimental');
  assert.strictEqual(workspaceCapabilities(projection).features['lfs'].status, 'Unavailable');
  assert.strictEqual(projection.features['repository.create'].status, 'Unavailable', 'owner projection must not mutate cohort capabilities');

  let context = { role: 'owner', principalId: crypto.randomUUID(), workspaceId: crypto.randomUUID(),
    connection: { id: crypto.randomUUID(), provider: 'github', login: 'old-login' } };
  const original = structuredClone(context), key = workspaceExecutionAuthority(context).identityKey;
  const token = crypto.randomBytes(32).toString('base64url');
  const account = { provider: 'github', providerAccountId: 99, login: 'old-login', token: 'synthetic-owner-credential', authMethod: 'token' };
  let reads = 0, writes = 0, legacy = 0, authenticated = true, dbFailed = false, safetyFailed = false;
  let readOnly = false, protectedFile = false, denyPolicy = false, permission = 'write', unknown = false, fileMode = '100644';
  let currentHead = 'a'.repeat(40), created = false, humanId = 99;
  const events = [];
  const policy = { schemaVersion: 1, enforcement: { mode: 'block' },
    rules: [{ id: 'deny-owner-write', action: 'file.write', effect: 'deny' }] };
  const gateway = createMutationGateway({ eventSink: event => events.push(event), policyEvaluator: descriptor => {
    assert.strictEqual(descriptor.actorIdentityKey, key);
    assert(descriptor.route.startsWith('/api/workspace/workbench/'));
    assert(!JSON.stringify(descriptor).includes(account.token));
    return evaluateActivePolicySet({ scope: descriptor.authorization.scope, descriptor,
      activePolicies: denyPolicy ? [{ policyId: crypto.randomUUID(), policyKey: 'owner-deny', versionId: crypto.randomUUID(),
        versionNumber: 1, headRevision: 1, document: policy, documentHash: policyDocumentHash(policy) }] : [],
      evaluatedAt: new Date().toISOString() });
  } });
  const store = {
    async readContext() { if (dbFailed) throw new Error('private database detail'); return authenticated ? context : null; },
    async executionContext(value) { assert.strictEqual(value, token); return { context, account }; }
  };
  const repoInfo = () => ({ id: 123, full_name: 'renamed/demo', name: 'demo', owner: { login: 'renamed' }, private: true, default_branch: 'main' });
  async function request(acct, path, options = {}) {
    assert.strictEqual(acct.token, account.token);
    assert.strictEqual(acct.identityKey, key);
    const method = options.method || 'GET';
    if (method !== 'GET') {
      gateway.assertProviderMutation({ provider: 'github', method, apiPath: path, body: options.body }); writes++;
      if (unknown) throw new Error('lost provider response containing private details');
      if (path === '/user/repos') { assert.strictEqual(options.body.private, true); assert.strictEqual(options.body.auto_init, true); created = true; return repoInfo(); }
      if (path.endsWith('/git/blobs')) return { sha: 'b'.repeat(40) };
      if (path.includes('/git/refs/heads/')) { currentHead = options.body.sha; return {}; }
      throw new Error('Unexpected provider mutation');
    }
    reads++;
    if (path === '/user') return { id: humanId, login: 'renamed', type: 'User' };
    if (path.includes('/collaborators/renamed/permission')) return { permission, role_name: permission, user: { login: 'renamed' } };
    if (path.startsWith('/user/repos?')) return created ? [repoInfo()] : [];
    if (path === '/repos/renamed/demo') return repoInfo();
    if (path.includes('/branches?')) return [{ name: 'main', commit: { sha: currentHead }, protected: false }];
    if (path.includes('/git/ref/heads/')) return { object: { sha: currentHead } };
    if (path.includes('/contents/README.md')) return { type: 'file', name: 'README.md', path: 'README.md', size: 6,
      sha: 'd'.repeat(40), encoding: 'base64', content: Buffer.from('hello\n').toString('base64') };
    if (path.includes('/contents/?')) return [{ type: 'file', name: 'README.md', path: 'README.md', sha: 'd'.repeat(40), size: 6 }];
    throw new Error(`Unexpected provider read: ${path}`);
  }
  const descriptorFor = (req, action) => {
    assert.strictEqual(req.alpha, undefined); assert.strictEqual(req.session, undefined);
    return { action, provider: 'github', owner: action === 'repository.create' ? req.gh.login : req.params.owner,
      repo: action === 'repository.create' ? req.body.name : req.params.repo,
      actorIdentityKey: req.gh.identityKey, actorLogin: req.gh.login, method: req.method,
      metadata: action === 'file.write' ? { path: req.body.path, branch: req.body.branch } : {}, authorization: req.authorization };
  };
  const workbench = createWorkspaceWorkbenchRouter({ store, request,
    commitTree: async (acct, owner, repo, branch, message, entries, expected) => {
      assert.strictEqual(expected, 'a'.repeat(40)); assert.strictEqual(entries[0].path, 'README.md');
      await request(acct, `/repos/${owner}/${repo}/git/refs/heads/${branch}`, { method: 'PATCH', body: { sha: 'c'.repeat(40), force: false } });
      return 'c'.repeat(40);
    },
    fileEntryAtHead: async () => ({ type: 'blob', mode: fileMode }),
    assertCapability: (acct, feature) => assertCapabilityAvailable(document, { ...capabilityContext, feature }),
    projectCapabilities: () => projection,
    loadSafety: async actualKey => { assert.strictEqual(actualKey, key); if (safetyFailed) throw new Error('private safety DB detail'); return { readOnly }; },
    updateSafety: async () => ({ readOnly: true, freezeSync: false, protected: {} }),
    guardSafety: req => req.effectiveSafety.readOnly ? 'Read-only mode is on' : protectedFile ? 'README.md is protected' : null,
    runMutation: createWorkspaceMutationRunner({ gateway, request, descriptorFor }),
    requireRepoPath: normalizeRepoPath, requireBranchName: normalizeBranchName, normalizeBranches: normalizeProviderBranches,
    failure: (res, error) => res.status(error.status || 503).json(publicErrorBody(error))
  });
  const seal = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unseal = value => { try { return JSON.parse(Buffer.from(value, 'base64url')); } catch { return null; } };
  const app = express(); app.use(express.json({ limit: '3mb' }));
  app.use('/api/workspace', createWorkspaceRouter({ enabled: true, store, workbench, seal, unseal,
    getCookie: req => req.headers.cookie, csrfSecret: crypto.randomBytes(32).toString('hex') }));
  app.use('/api', (req, res) => { legacy++; res.status(403).json({ code: 'ALPHA_ACCESS_REQUIRED' }); });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  let csrf = '';
  async function call(path, method = 'GET', body, headers = {}) {
    const response = await fetch(origin + '/api/workspace' + path, { method, headers: {
      origin, 'x-nv': '1', 'content-type': 'application/json', cookie: seal({ kind: 'workspace-session/v1', token }),
      'x-nv-csrf': csrf, 'x-nv-workspace': original.workspaceId, 'x-nv-connection': original.connection.id, ...headers
    }, body: body ? JSON.stringify(body) : undefined });
    assert.strictEqual(response.headers.get('cache-control'), 'no-store');
    const result = { status: response.status, body: await response.json() };
    assert(!JSON.stringify(result).includes(account.token));
    return result;
  }
  try {
    csrf = (await call('/session')).body.csrfToken;
    assert.strictEqual((await call('/workbench/me')).body.login, 'renamed');
    const before = reads;
    assert.strictEqual((await call('/workbench/repos', 'POST', { name: 'demo' }, { 'x-nv-csrf': '' })).status, 403);
    assert.strictEqual((await call('/workbench/repos', 'POST', { name: 'demo' }, { origin: 'https://other.invalid' })).status, 403);
    assert.strictEqual((await call('/workbench/me', 'GET', null, { 'x-nv-connection': crypto.randomUUID() })).status, 409);
    assert.strictEqual(reads, before, 'CSRF, origin and pin rejection precede provider requests');
    assert.strictEqual(writes, 0);
    const creation = await call('/workbench/repos', 'POST', { name: 'demo' });
    assert.strictEqual(creation.status, 201, JSON.stringify(creation)); assert.strictEqual(creation.body.verified, true);
    assert.strictEqual((await call('/workbench/repos')).body[0].full_name, 'renamed/demo');
    assert.strictEqual((await call('/workbench/repo/renamed/demo')).body.branches[0].sha, currentHead);
    assert.strictEqual((await call('/workbench/repo/renamed/demo/tree?ref=main')).body[0].path, 'README.md');
    assert.strictEqual((await call('/workbench/repo/renamed/demo/file?ref=main&path=README.md')).body.encoding, 'base64');
    const change = { path: 'README.md', branch: 'main', content: 'updated\n', expectedHeadSha: 'a'.repeat(40) };
    const fileRoute = '/workbench/repo/renamed/demo/file';
    const writeCount = writes;
    assert.strictEqual((await call(fileRoute, 'PUT', { ...change, expectedHeadSha: undefined })).status, 400);
    assert.strictEqual((await call(fileRoute, 'PUT', { ...change, expectedHeadSha: 'f'.repeat(40) })).body.code, 'BRANCH_CHANGED');
    assert.strictEqual((await call(fileRoute, 'PUT', { ...change, principalId: original.principalId })).status, 400);
    assert.strictEqual((await call(fileRoute, 'PUT', { ...change, content: 'binary\0text' })).status, 400);
    fileMode = '120000'; assert.strictEqual((await call(fileRoute, 'PUT', change)).body.code, 'WORKSPACE_FILE_TYPE_UNSUPPORTED'); fileMode = '100644';
    readOnly = true; assert.strictEqual((await call(fileRoute, 'PUT', change)).status, 423); readOnly = false;
    protectedFile = true; assert.strictEqual((await call(fileRoute, 'PUT', change)).status, 423); protectedFile = false;
    safetyFailed = true; assert.strictEqual((await call(fileRoute, 'PUT', change)).status, 503); safetyFailed = false;
    permission = 'read'; assert.strictEqual((await call(fileRoute, 'PUT', change)).body.code, 'WORKSPACE_WRITE_PERMISSION_REQUIRED'); permission = 'write';
    denyPolicy = true; assert.strictEqual((await call(fileRoute, 'PUT', change)).body.code, 'POLICY_MUTATION_BLOCKED'); denyPolicy = false;
    assert.strictEqual(writes, writeCount, 'all preflight refusals prevent every provider mutation');
    const committed = await call(fileRoute, 'PUT', change);
    assert.strictEqual(committed.status, 200, JSON.stringify(committed)); assert.strictEqual(committed.body.verified, true);
    assert.strictEqual(committed.body.commit, currentHead);
    assert(events.some(e => e.type === 'provider.write.authorized'), 'provider writes pass through the real gateway');
    permission = 'read'; assert.strictEqual((await call(fileRoute, 'PUT', { ...change, expectedHeadSha: currentHead })).status, 403,
      'permission is rechecked after a successful write using the same stable owner key'); permission = 'write';
    unknown = true;
    const uncertain = await call('/workbench/repos', 'POST', { name: 'another' });
    assert.strictEqual(uncertain.body.code, 'WORKSPACE_WRITE_UNCERTAIN');
    assert.match(uncertain.body.nextAction, /inspect/); assert(!JSON.stringify(uncertain).includes('private details'));
    const finalWrites = writes;
    context = { ...original, connection: { ...original.connection, id: crypto.randomUUID() } };
    assert.strictEqual((await call('/workbench/repos', 'POST', { name: 'another' })).body.code, 'WORKSPACE_EXECUTION_CHANGED');
    context = { ...original, role: 'tester' };
    assert.strictEqual((await call('/workbench/me')).status, 401);
    context = original; humanId = 100;
    assert.strictEqual((await call('/workbench/me')).body.code, 'WORKSPACE_CONNECTION_REJECTED');
    dbFailed = true; assert.strictEqual((await call('/workbench/me')).status, 503); dbFailed = false;
    authenticated = false; assert.strictEqual((await call('/workbench/me')).status, 401);
    assert.strictEqual(writes, finalWrites);
    assert.strictEqual((await call('/workbench/unsupported')).status, 404);
    assert.strictEqual(legacy, 0, 'owner routes never fall through to the cohort');
  } finally { await new Promise(resolve => server.close(resolve)); }
  console.log('owner workbench HTTP tests passed (gateway, permissions, pins, safety, verified writes and uncertain outcomes)');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
