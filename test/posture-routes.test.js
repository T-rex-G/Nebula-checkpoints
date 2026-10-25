'use strict';
/*
 * Posture's four routes, over HTTP (D12): registered by the module with the
 * guards and stores handed in, so what the routes decide is read without a
 * database or a provider. The readings behind them are tested on their own
 * (workspace-posture, posture-summary, findings-inbox and the branch rules);
 * the stores' queries against a real database.
 *
 * Each route is gated as the route policy records, never cached, and the two
 * workspace readings neither touch the session's credential nor ask the
 * provider anything: everything they draw is already in the database, keyed
 * by the identity. Without a database the page is told so, rather than shown
 * a clean workspace, and a store that fails leaves only its own part
 * unmeasured.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { registerWorkspacePostureRoutes, registerBranchProtectionRoutes } = require('../apps/api/src/modules/posture/index.ts');
const { locations } = require('./oracles/route-policy');

const root = path.resolve(__dirname, '..');

/* The guard chains, as the route policy reads them from wherever the routes are registered. */
{
  const guards = new Map(locations(root).filter(entry => entry.kind === 'route').map(entry => [`${entry.method} ${entry.path}`, entry.guards.join(', ')]));
  assert.equal(guards.get('GET /api/workspace/posture'), 'providerSessionAccess, auth');
  assert.equal(guards.get('GET /api/workspace/security-posture'), "providerSessionAccess, capabilityAccess('workspace.posture'), auth");
  assert.equal(guards.get('GET /api/workspace/findings'), "providerSessionAccess, capabilityAccess('findings.inbox'), auth");
  assert.equal(guards.get('GET /api/repo/:owner/:repo/branch-protection'),
    "providerSessionAccess, alphaRepositoryAccess, capabilityAccess('recovery'), capabilityAccess('branches.read'), auth");
}

/* The posture route hands the account to the reader; its own body never reads the credential. */
{
  const source = fs.readFileSync(path.join(root, 'apps/api/src/modules/posture/http/posture-routes.ts'), 'utf8');
  const start = source.indexOf("app.get('/api/workspace/posture'");
  assert(start > 0);
  assert.doesNotMatch(source.slice(start, source.indexOf('\n  });', start)), /token/, 'the route body never touches the token itself');
}

(async () => {
  const touched = [];
  /* An account whose credential reports being read. */
  const account = (provider = 'github') => {
    const value = { provider, login: 'alice', baseUrl: '' };
    Object.defineProperty(value, 'token', { enumerable: true, get() { touched.push('token'); return 'ghp_' + 'x'.repeat(36); } });
    return value;
  };
  const calls = [];
  let configured = true;
  let ready = true;
  const failing = new Set();
  const store = (name, value) => (...args) => {
    calls.push([name, ...args.map(arg => JSON.stringify(arg))]);
    return failing.has(name) ? Promise.reject(new Error(`${name} failed`)) : Promise.resolve(value);
  };
  const deps = {
    providerSessionAccess: (req, res, next) => {
      if (!req.headers['x-test-provider']) return res.status(401).json({ code: 'AUTH_REQUIRED' });
      req.gh = account(req.headers['x-test-provider']);
      return next();
    },
    alphaRepositoryAccess: (req, res, next) => req.params.repo === 'private' ? res.status(403).json({ code: 'ALPHA_REPOSITORY_DENIED' }) : next(),
    capabilityAccess: feature => (req, res, next) => req.headers['x-test-deny'] === feature ? res.status(403).json({ code: 'CAPABILITY_DENIED' }) : next(),
    auth: (_req, _res, next) => next(),
    account: req => req.gh,
    fail: (res, error) => res.status(error.status || 500).json({ code: error.code || 'FAILED', error: error.message }),
    gh: async (acct, apiPath, options) => {
      calls.push(['gh', apiPath]);
      if (options && options.raw) return { ok: true, headers: { get: () => null }, body: { cancel: async () => {} } };
      if (apiPath.endsWith('/demo')) return { default_branch: 'main' };
      if (apiPath.endsWith('/branches/main')) return { name: 'main', protected: true };
      if (apiPath.endsWith('/branches/main/protection')) return { required_pull_request_reviews: { required_approving_review_count: 2 } };
      throw Object.assign(new Error('Not found'), { status: 404 });
    },
    dbReady: async () => ready,
    pool: () => ({ query: async () => ({ rows: [] }) }),
    identityKey: acct => `github:${acct.login}`,
    normalizePolicyScope: scope => ({ authority: `github.com${scope.baseUrl ? `|${scope.baseUrl}` : ''}` }),
    get databaseConfigured() { return configured; },
    maintenance: false,
    hostedAlpha: false,
    auditHistory: () => configured ? {
      workspace: store('audit.workspace', { repositories: [], opened: [], fixed: [] }),
      workspaceFindings: store('audit.findings', { findings: [] })
    } : null,
    exposureService: () => ({
      workspaceSummary: store('exposure.summary', [{ owner: 'Acme', repo: 'Demo', scannedAt: '2026-09-25T00:00:00.000Z', partial: false, rule: 'aws-key', count: 1 }]),
      workspaceTrend: store('exposure.trend', []),
      workspaceFindings: store('exposure.findings', { findings: [{ scope: { owner: 'acme', repo: 'demo' }, fingerprint: 'f1', rule: 'aws-key', path: 'secrets/prod.env', firstObservedAt: '2026-09-01T00:00:00.000Z' }] })
    }),
    governanceStore: () => ({ countMergeOutcomes: store('governance.merges', { allowed: 1, blocked: 0 }) }),
    severityOf: () => 'critical',
    displayPath: filePath => `masked:${filePath}`,
    triageVocabulary: { states: ['open'] }
  };
  const app = express();
  registerWorkspacePostureRoutes(app, deps);
  registerBranchProtectionRoutes(app, deps);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const ask = async (route, headers = { 'x-test-provider': 'github' }) => {
    const response = await fetch(base + route, { headers });
    return { status: response.status, cache: response.headers.get('cache-control'), body: await response.json() };
  };
  try {
    for (const route of ['/api/workspace/posture', '/api/workspace/security-posture', '/api/workspace/findings', '/api/repo/acme/demo/branch-protection']) {
      assert.equal((await ask(route, {})).status, 401, route);
    }
    assert.equal((await ask('/api/workspace/security-posture', { 'x-test-provider': 'github', 'x-test-deny': 'workspace.posture' })).status, 403);
    assert.equal((await ask('/api/workspace/findings', { 'x-test-provider': 'github', 'x-test-deny': 'findings.inbox' })).status, 403);
    assert.equal((await ask('/api/repo/acme/private/branch-protection')).status, 403);

    /* The security posture and the inbox: GitHub only, read from the stores, nothing from the provider or the credential. */
    for (const route of ['/api/workspace/security-posture', '/api/workspace/findings']) {
      calls.length = 0;
      touched.length = 0;
      const answer = await ask(route);
      assert.equal(answer.status, 200, route);
      assert.equal(answer.cache, 'no-store');
      assert.equal(answer.body.available, true);
      assert(!calls.some(([name]) => name === 'gh'), `${route} asks the provider nothing`);
      assert.deepEqual(touched, [], `${route} never reads the credential`);
      assert(calls.every(([, argument]) => !argument || JSON.parse(argument).identityKey === 'github:alice' || JSON.parse(argument).actorIdentityKey === 'github:alice'),
        'every store is asked for this identity only');
      const other = await ask(route, { 'x-test-provider': 'gitlab' });
      assert.deepEqual([other.status, other.body.code], [401, 'PROVIDER_ACCOUNT_INVALID'], `${route} requires GitHub`);
    }
    const inbox = await ask('/api/workspace/findings');
    assert.deepEqual(inbox.body.vocabulary, { states: ['open'] });
    assert.equal(inbox.body.findings.find(item => item.source === 'exposure').path, 'masked:secrets/prod.env', 'exposure paths are masked on the server');

    /* A store that fails leaves only its own part unmeasured. */
    failing.add('exposure.summary');
    failing.add('audit.findings');
    assert.equal((await ask('/api/workspace/security-posture')).body.available, true);
    assert.equal((await ask('/api/workspace/findings')).body.available, true);
    failing.clear();

    /* Without a database, or with one that does not answer, the page is told so, and nothing is asked. */
    ready = false;
    calls.length = 0;
    assert.deepEqual((await ask('/api/workspace/security-posture')).body, { available: false, reason: 'database-unavailable' });
    assert.deepEqual((await ask('/api/workspace/findings')).body, { available: false, reason: 'database-unavailable' });
    configured = false;
    assert.deepEqual((await ask('/api/workspace/security-posture')).body, { available: false, reason: 'not-configured' });
    assert.deepEqual((await ask('/api/workspace/findings')).body, { available: false, reason: 'not-configured' });
    assert.deepEqual(calls, [], 'no store is asked without a database');
    ready = true;
    configured = true;

    /* The overview's posture: the reader's four readings, uncached. */
    const posture = await ask('/api/workspace/posture');
    assert.equal(posture.status, 200);
    assert.equal(posture.cache, 'no-store');
    assert.deepEqual(Object.keys(posture.body).sort(), ['boundary', 'credential', 'exposure', 'recovery']);

    /* A branch's provider rules: the open repository, its default branch unless one is named, and a name that is not one refused. */
    calls.length = 0;
    const rules = await ask('/api/repo/acme/demo/branch-protection');
    assert.equal(rules.status, 200);
    assert.equal(rules.cache, 'no-store');
    assert.equal(rules.body.branch, 'main');
    assert(calls.every(([name, apiPath]) => name === 'gh' && apiPath.startsWith('/repos/acme/demo')), 'only the open repository is read');
    assert.equal((await ask('/api/repo/acme/demo/branch-protection?branch=..%2Fmain')).status, 400);
    console.log('posture route tests passed');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
