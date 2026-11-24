'use strict';
/*
 * Uranus's twelve code-audit routes, over HTTP (D12), answering from the
 * code-audit service with its run and store ports stood in: the audit, the
 * worker and the provider pool are fakes, the jobs, the triage rules, the
 * clocks and the merge gate are real.
 *
 * What each route must hold: the chain the route policy records; a kept
 * audit read for this person's identity, and refused for a missing or
 * overlong ref; no history without a database, said rather than shown empty;
 * the explicit word before a clear; decisions read by a collaborator and made
 * by a reviewer, in that reviewer's name; a public reader's audit and metrics
 * carrying nobody's decisions; a fork's head never described by this
 * repository's audits; and failures through the public error body.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const { createCodeAuditService, registerCodeAuditRoutes, auditTriage } = require('../apps/api/src/modules/uranus/index.ts');
const { publicErrorBody } = require('../apps/api/src/http/errors.ts');
const { locations } = require('./oracles/route-policy');

const root = path.resolve(__dirname, '..');

/* ---- The chain in front of each route, as the route policy reads it ---- */
{
  const routes = locations(root).filter(entry => entry.kind === 'route' && entry.path.includes('code-audit'));
  assert.equal(routes.length, 12);
  for (const route of routes) assert(route.at.startsWith('apps/api/src/modules/uranus/http/code-audit-routes.ts:'), `${route.path} is registered by Uranus (${route.at})`);
  const chain = (method, tail) => routes.find(route => route.method === method && route.path === tail).guards.join(', ');
  const repo = '/api/repo/:owner/:repo/code-audit';
  const base = "providerSessionAccess, alphaRepositoryAccess, capabilityAccess('code-audit'), auth";
  assert.equal(chain('GET', repo), base);
  for (const tail of ['/history', '/history/:auditId', '/watch', '/metrics']) {
    assert.equal(chain('GET', repo + tail), `${base}, auditHistoryAvailable, governanceAccess('reader', OWN_WORK)`, tail);
  }
  assert.equal(chain('POST', `${repo}/history/clear`), `${base}, auditHistoryAvailable, governanceAccess('reader', OWN_WORK), governanceMutationContext('code-audit.history.clear')`);
  assert.equal(chain('GET', `${repo}/triage`), `${base}, auditHistoryAvailable, governanceAccess('reader')`);
  assert.equal(chain('GET', `${repo}/findings/:findingId/triage-events`), `${base}, auditHistoryAvailable, governanceAccess('reader')`);
  assert.equal(chain('POST', `${repo}/findings/:findingId/triage`), `${base}, auditHistoryAvailable, governanceAccess('reviewer'), governanceMutationContext('code-audit.finding.triage')`);
  assert.equal(chain('POST', `${repo}/findings/:findingId/reopen`), `${base}, auditHistoryAvailable, governanceAccess('reviewer'), governanceMutationContext('code-audit.finding.reopen')`);
  assert.equal(chain('POST', '/api/code-audit/score'), "providerSessionAccess, capabilityAccess('code-audit'), accountAuth");
  assert.equal(chain('GET', `${repo}/gate`), `${base}, governanceAccess('reader')`, 'the gate answers without a history, as unavailable');
}

const IDENTITY = 'a'.repeat(64);
const SCOPE = Object.freeze({ provider: 'github', authority: 'github.com', owner: 'acme', repo: 'demo' });
const FINDING = '0123456789abcdef01234567';
const NOW = Date.now();
const iso = offset => new Date(NOW + offset).toISOString();
const collaborator = (source = 'github.collaborator.permission') => ({
  schemaVersion: 1,
  scope: { provider: 'github', authority: 'github.com', owner: 'Acme', repo: 'Demo', scopeKey: 'github:github.com:acme/demo' },
  executionPrincipal: { kind: 'user', identityKey: IDENTITY, login: 'alice', authMethod: 'oauth' },
  governanceActor: { kind: 'human', identityKey: IDENTITY, login: 'alice', verified: true },
  repositoryAccess: { baseRole: 'maintain', providerRole: 'maintain', level: 40, source, complete: true },
  governanceRoles: { reader: true, author: true, reviewer: true, activator: false, administrator: false },
  installationCapabilities: null,
  evidence: { status: 'resolved', fetchedAt: iso(-1000), expiresAt: iso(60_000), reasonCode: null }
});

async function harness({ database = true } = {}) {
  const calls = [];
  const state = { authorization: collaborator(), recordFails: false, policiesFail: false, pull: null, latest: null };
  const decisions = new Map([[FINDING, { findingId: FINDING, rule: 'hardcoded-secret', disposition: 'false-positive', reason: 'test-fixture', decidedBy: 'carol', decidedAt: iso(-5000), expiresAt: null }]]);
  const store = name => new Proxy({}, {
    get: (_target, method) => async input => {
      calls.push([`${name}.${String(method)}`, input]);
      if (state.failing === `${name}.${String(method)}`) throw new Error('store failed with a secret ghp_' + 'x'.repeat(36));
      if (name === 'history' && method === 'record') return { auditId: 'a2', previous: null, newIds: [], resolved: 0, resolutions: 0, firstSeen: { [FINDING]: iso(-40 * 86_400_000), fedcba9876543210fedcba98: iso(-40 * 86_400_000) } };
      if (name === 'history' && method === 'list') return { audits: [{ id: 'a1' }], branches: ['main'] };
      if (name === 'history' && method === 'read') return null;
      if (name === 'history' && method === 'watched') return null;
      if (name === 'history' && method === 'clear') return 2;
      if (name === 'history' && method === 'latest') return state.latest;
      if (name === 'history' && method === 'metrics') return { overdue: 0, triaged: [input.isTriaged({ id: FINDING, rule: 'hardcoded-secret' }), input.isTriaged({ id: FINDING, rule: 'other' })] };
      if (name === 'triage' && method === 'decisions') return decisions;
      if (name === 'triage' && method === 'list') return [...decisions.values()];
      if (name === 'triage' && method === 'decide') return { findingId: input.findingId };
      if (name === 'triage' && method === 'reopen') return null;
      return [];
    }
  });
  let closed = 0;
  const service = createCodeAuditService({
    databaseConfigured: database,
    pool: () => ({}),
    identityKey: account => `key:${account.login}`,
    gh: async (account, apiPath) => { calls.push(['gh', apiPath]); return state.pull; },
    dbReady: async () => true,
    governanceStore: () => ({ resolveActivePolicySetInScope: async input => { calls.push(['policies', input.action]); if (state.policiesFail) throw new Error('down'); return { activePolicies: [] }; } }),
    resolveAuthorization: async input => { calls.push(['authorization', input.owner, input.repo]); return state.authorization; },
    reader: {},
    ports: {
      openSession: () => ({ request: async () => ({}), close: () => { closed += 1; } }),
      fetch: async () => ({ statusCode: 503, body: '' }),
      auditRepository: async input => {
        calls.push(['audit', { ref: input.ref, token: input.token, scope: input.scope }]);
        await input.analyser({ files: [] });
        return {
          findings: [
            { id: FINDING, rule: 'hardcoded-secret', severity: 'critical', category: 'secrets', verdict: 'confirmed' },
            { id: 'fedcba9876543210fedcba98', rule: 'weak-hash', severity: 'serious', category: 'security', verdict: 'confirmed' }
          ],
          policy: { sla: { critical: 7, serious: 30, warning: 90 } }, commitSha: 'c'.repeat(40), ref: input.ref
        };
      },
      analyseOffThread: async () => ({ components: [], dependencyStatus: {}, advisoryStatus: {} }),
      scanOffThread: async () => ({ raw: [], packages: [] })
    },
    stores: { history: () => store('history'), triage: () => store('triage') }
  });
  const app = express();
  app.use(express.json());
  const pass = (_req, _res, next) => next();
  registerCodeAuditRoutes(app, {
    providerSessionAccess: (req, _res, next) => { req.gh = { login: 'alice', token: 'gho_reader', provider: 'github' }; next(); },
    alphaRepositoryAccess: pass, capabilityAccess: () => pass, auth: pass, accountAuth: pass,
    governanceAccess: role => (req, _res, next) => {
      req.governance = {
        scope: SCOPE, actor: { identityKey: IDENTITY }, publicReader: req.headers['x-public-reader'] === '1',
        authorization: { governanceRoles: { reviewer: req.headers['x-reviewer'] === '1' ? true : req.headers['x-reviewer'] || false } }
      };
      req.governanceRole = role;
      next();
    },
    OWN_WORK: Object.freeze({ publicRepositories: true }),
    governanceMutationContext: () => pass,
    governance: req => req.governance, account: req => req.gh,
    fail: (res, error) => res.status(error && error.status >= 400 && error.status < 600 ? error.status : 500).json(publicErrorBody(error)),
    publicErrorBody, retainedActor: req => req.gh.login, identityKey: account => `key:${account.login}`,
    service
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, route, body, headers = {}) => {
    calls.length = 0;
    const response = await fetch(base + route, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, body: text ? JSON.parse(text) : null };
  };
  return { call, calls, state, service, closed: () => closed, close: () => new Promise(resolve => server.close(resolve)) };
}

(async () => {
  const repo = '/api/repo/acme/demo/code-audit';

  /* Without a database: no history, said rather than shown empty; the gate is unavailable rather than failing. */
  {
    const h = await harness({ database: false });
    try {
      const listed = await h.call('GET', `${repo}/history?ref=main`);
      assert.deepEqual(listed.body, { available: false });
      assert.equal(listed.headers.get('cache-control'), 'no-store');
      const cleared = await h.call('POST', `${repo}/history/clear`, { confirm: 'clear-audit-history' });
      assert.equal(cleared.status, 503);
      assert.equal(cleared.body.code, 'CODE_AUDIT_HISTORY_UNAVAILABLE');
      h.state.pull = { number: 5, state: 'open', head: { ref: 'f', sha: 'AB', repo: { full_name: 'acme/demo' } }, base: { ref: 'main', repo: { full_name: 'acme/demo' } } };
      const gate = await h.call('GET', `${repo}/gate?pull=5`);
      assert.equal(gate.status, 200);
      assert.equal(gate.body.available, false);
      assert.equal(gate.body.gate.state, 'unavailable');
    } finally { await h.close(); }
  }

  const h = await harness();
  try {
    /* The audit: a ref is required, the first request starts it and the page asks again for the result. */
    {
      assert.equal((await h.call('GET', repo)).body.code, 'AUDIT_REF_REQUIRED');
      const started = await h.call('GET', `${repo}?ref=main`);
      assert.equal(started.status, 202);
      assert.equal(started.headers.get('retry-after'), '2');
      assert.equal(started.headers.get('cache-control'), 'no-store');
      assert.equal(started.body.state, 'running');
      let polled = null;
      for (let attempt = 0; attempt < 50; attempt++) {
        polled = await h.call('GET', `${repo}?ref=main&run=${encodeURIComponent(started.body.run)}`);
        if (polled.status !== 202) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(polled.status, 200, `the audit finishes and its result is answered: ${polled.text}`);
      const finished = polled.body;
      assert.deepEqual(h.calls.length, 0, 'asking for the result runs nothing again');
      assert.equal(finished.history.saved, true, 'and kept');
      assert.equal(finished.findings.length, 1, 'the team\'s decision takes the decided finding out of the open ones');
      assert.equal(finished.suppressed[0].suppression.triage.decidedBy, 'carol');
      assert.equal(finished.findings[0].clock.days, 30, 'each open finding carries its clock, from the date the history first saw it');
      assert.equal(finished.findings[0].clock.state, 'overdue', 'forty days past a thirty-day clock');
      assert(h.closed() > 0, 'the provider pool closes');
    }

    /* A kept audit is read for this person, and only for a ref that names one. */
    {
      for (const ref of ['', ' ', 'x'.repeat(256)]) assert.equal((await h.call('GET', `${repo}/history?ref=${ref}`)).body.code, 'AUDIT_REF_REQUIRED');
      const listed = await h.call('GET', `${repo}/history?ref=main`);
      assert.deepEqual(listed.body, { available: true, ref: 'main', audits: [{ id: 'a1' }], branches: ['main'] });
      assert.deepEqual(h.calls[0], ['history.list', { scope: SCOPE, identityKey: IDENTITY, ref: 'main' }]);
      assert.equal((await h.call('GET', `${repo}/history/a9`)).body.code, 'CODE_AUDIT_NOT_FOUND');
      const watched = await h.call('GET', `${repo}/watch?ref=main&refresh=1`);
      assert.deepEqual(watched.body, { available: true, ref: 'main', audit: null, alerts: [], components: 0, fresh: false, checkableAt: null }, 'a branch with no kept audit has nothing to watch');
      assert.deepEqual(h.calls[0], ['history.watched', { scope: SCOPE, identityKey: IDENTITY, ref: 'main' }]);
    }

    /* Clearing: the explicit word, before the store is touched. */
    {
      const refused = await h.call('POST', `${repo}/history/clear`, { confirm: 'clear' });
      assert.equal(refused.body.code, 'CODE_AUDIT_CLEAR_UNCONFIRMED');
      assert.deepEqual(h.calls, []);
      const cleared = await h.call('POST', `${repo}/history/clear`, { confirm: 'clear-audit-history' });
      assert.deepEqual([cleared.status, cleared.body], [201, { cleared: 2 }]);
      assert.deepEqual(h.calls[0], ['history.clear', { scope: SCOPE, identityKey: IDENTITY }]);
    }

    /* The team's decisions: who may decide is a literal true, and a decision is made in the reviewer's name. */
    {
      assert.equal((await h.call('GET', `${repo}/triage`, undefined, { 'x-reviewer': '1' })).body.canDecide, true);
      assert.equal((await h.call('GET', `${repo}/triage`, undefined, { 'x-reviewer': 'yes' })).body.canDecide, false);
      const listed = await h.call('GET', `${repo}/triage`);
      assert.deepEqual(listed.body.vocabulary, JSON.parse(JSON.stringify(auditTriage.VOCABULARY)));
      const invalid = await h.call('POST', `${repo}/findings/nope/triage`, { rule: 'r' });
      assert.equal(invalid.body.code, 'CODE_AUDIT_FINDING_INVALID');
      assert.deepEqual(h.calls, [], 'refused before the store');
      const decided = await h.call('POST', `${repo}/findings/${FINDING.toUpperCase()}/triage`, { rule: 'hardcoded-secret', disposition: 'false-positive', reason: 'test-fixture' });
      assert.equal(decided.status, 201);
      const [, input] = h.calls[0];
      assert.equal(input.findingId, FINDING);
      assert.equal(input.actor, 'alice');
      assert.equal(input.actorKey, IDENTITY);
      assert.deepEqual(input.input, { disposition: 'false-positive', reason: 'test-fixture', expiresInDays: undefined });
      assert.equal((await h.call('POST', `${repo}/findings/${FINDING}/reopen`)).body.code, 'CODE_AUDIT_TRIAGE_NOT_FOUND');
      assert.equal((await h.call('GET', `${repo}/findings/${FINDING}/triage-events`)).status, 200);
    }

    /* The grade for what the page holds: pure, and only for a list. */
    {
      assert.equal((await h.call('POST', '/api/code-audit/score', { findings: 'x' })).body.code, 'CODE_AUDIT_SCORE_INVALID');
      const scored = await h.call('POST', '/api/code-audit/score', { findings: [{ id: FINDING, rule: 'hardcoded-secret', severity: 'critical', category: 'secrets' }] });
      assert.equal(scored.status, 200);
      assert.deepEqual(scored.body, JSON.parse(JSON.stringify(auditTriage.rescore([{ id: FINDING, rule: 'hardcoded-secret', severity: 'critical', category: 'secrets' }]))));
      assert.deepEqual(h.calls, [], 'it reads nothing');
    }

    /* Metrics: a collaborator's count leaves the decided finding out; a public reader's asks nobody. */
    {
      const team = await h.call('GET', `${repo}/metrics?ref=main`);
      assert.deepEqual(team.body.triaged, [true, false], 'a decision counts for its own rule only');
      assert.equal(team.body.triage.falsePositive, 1);
      assert.equal(team.body.triageUnavailable, false);
      const outsider = await h.call('GET', `${repo}/metrics?ref=main`, undefined, { 'x-public-reader': '1' });
      assert.deepEqual(outsider.body.triaged, [false, false]);
      assert.equal(outsider.body.triage, null);
      assert(!h.calls.some(([name]) => name === 'authorization'), 'a public reader\'s metrics resolve no collaborator access');
      h.state.authorization = collaborator('github.repository.public');
      assert.equal((await h.call('GET', `${repo}/metrics?ref=main`)).body.triage, null, 'nor does an account the provider calls a public reader');
      h.state.authorization = collaborator();
    }

    /* The gate: a pull request is required; a fork's head is never described by this repository's audits; a policy store that fails leaves enforcement unavailable. */
    {
      for (const pull of ['', '0', 'x', '2147483648']) assert.equal((await h.call('GET', `${repo}/gate?pull=${pull}`)).body.code, 'AUDIT_GATE_PULL_REQUIRED');
      h.state.pull = { number: 7, state: 'open', head: { ref: 'feature', sha: 'ABC', repo: { full_name: 'Fork/Demo' } }, base: { ref: 'main', repo: { full_name: 'Acme/Demo' } } };
      h.state.policiesFail = true;
      const gate = await h.call('GET', `${repo}/gate?pull=7`);
      assert.equal(gate.status, 200);
      assert.deepEqual(gate.body.pull, { number: 7, head: 'feature', base: 'main', headSha: 'abc', fork: true, open: true });
      assert.deepEqual(gate.body.enforcement, { available: false, policies: [] });
      assert.deepEqual(h.calls.filter(([name]) => name === 'history.latest').map(([, input]) => input.ref), ['main'], 'only the base branch is read for a fork');
      assert.deepEqual(h.calls.find(([name]) => name === 'gh'), ['gh', '/repos/acme/demo/pulls/7']);
      h.state.policiesFail = false;
      h.state.pull = { ...h.state.pull, head: { ...h.state.pull.head, repo: { full_name: 'ACME/demo' } } };
      const own = await h.call('GET', `${repo}/gate?pull=7`);
      assert.equal(own.body.pull.fork, false, 'the same repository in another case is no fork');
      assert.deepEqual(h.calls.filter(([name]) => name === 'history.latest').map(([, input]) => input.ref), ['feature', 'main']);
    }

    /* Failures: the public error body, never the message. */
    {
      h.state.failing = 'history.list';
      const failed = await h.call('GET', `${repo}/history?ref=main`);
      assert.equal(failed.status, 500);
      assert.equal(failed.body.code, 'OPERATION_FAILED');
      assert(!failed.text.includes('ghp_'));
      h.state.failing = null;
    }
  } finally {
    await h.close();
  }
  console.log('uranus code-audit routes tests passed');
})().catch(error => { console.error(error); process.exit(1); });
