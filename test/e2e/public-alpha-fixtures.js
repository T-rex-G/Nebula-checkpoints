'use strict';

const crypto = require('crypto');
const ui = require('./semantic');

const capabilityDocument = require('../../config/public-alpha-capabilities.json');
const { projectCapabilities } = require('../../src/capability-registry');

const { buildPolicyDigitalTwinReadModel } = require('../../src/governance-digital-twin');
const { projectGovernanceInterfaceAccess } = require('../../src/governance-interface');

const HEAD_SHA = 'a'.repeat(40);

/*
 * A populated governance digital twin, and the reason it is built rather than
 * written down.
 *
 * There was no fixture for GET .../governance/digital-twin at all, so every
 * test that opened the governance pane got its "Governance evidence
 * unavailable" state -- which is why the one guard on that pane is named for
 * fitting a 320px screen "while reporting a failure". The populated page, the
 * one with the policy rows, the timeline, the exports and the webhooks, had
 * never been rendered by a test at any width. It reached a phone screenshot
 * with two pieces of its own content hidden under fixed chrome, and nothing in
 * the suite could have seen that.
 *
 * The read model is produced by the production builder from the same seed the
 * unit test uses, and the access projection by the production projector, so
 * this fixture cannot be shaped differently from what the server sends. A
 * hand-written twin would have been a fourth invented payload this release,
 * after GitLab's create response, Gitea's branch ref and the three providers'
 * concurrency tokens.
 */
const GOVERNANCE_SCOPE = Object.freeze({
  provider: 'github', authority: 'github.com', owner: 'sandbox', repo: 'demo',
  scopeKey: 'github:github.com:sandbox/demo'
});

function governanceTwinPayload(now = new Date()) {
  const asOf = now.toISOString();
  const later = new Date(now.getTime() + 86_400_000).toISOString();
  const earlier = new Date(now.getTime() - 3_600_000).toISOString();
  const policyId = '10000000-0000-4000-8000-000000000001';
  const versionId = '30000000-0000-4000-8000-000000000003';
  const data = {
    asOf,
    totals: { policies: 2, activePolicies: 1, versions: 2 },
    policies: [
      { policy_id: policyId, policy_key: 'alpha', name: 'Protected paths', description: 'Bounded write policy for release branches.', revision: 3, active_version_id: versionId, active_version_number: 2, active_document_hash: 'a'.repeat(64), active_enforcement_mode: 'warn', updated_at: earlier },
      { policy_id: '20000000-0000-4000-8000-000000000002', policy_key: 'zeta', name: 'Upload security', description: '', revision: 2, active_version_id: null, updated_at: earlier }
    ],
    versions: [
      { policy_id: policyId, version_id: versionId, version_number: 2, document_hash: 'a'.repeat(64), required_approvals: 1, assignment_count: 1, approval_count: 1, rejection_count: 0, created_at: earlier },
      { policy_id: policyId, version_id: '40000000-0000-4000-8000-000000000004', version_number: 3, document_hash: 'b'.repeat(64), required_approvals: 2, assignment_count: 1, approval_count: 1, rejection_count: 0, created_at: earlier }
    ],
    drafts: [{ draft_id: '60000000-0000-4000-8000-000000000006', policy_id: policyId, revision: 1, document_hash: 'd'.repeat(64), authored_by_login: 'alpha-tester', required_approvals: 1, disallow_author_approval: true, created_at: earlier, updated_at: earlier }],
    exceptions: [{ exception_id: '50000000-0000-4000-8000-000000000005', policy_id: policyId, version_id: versionId, kind: 'exception', action: 'branch.reset', state: 'approved', expires_at: later, created_at: earlier }],
    activations: [{ seq: 4, policy_id: policyId, version_id: versionId, action: 'activate', actor_login: 'alpha-tester', created_at: earlier }],
    decisions: [{ seq: 7, action: 'branch.reset', enforcement_outcome: 'warn', effective_effect: 'deny', evaluated_at: earlier, decision_hash: 'c'.repeat(64) }],
    completeness: { policies: true, versions: true, drafts: true, exceptions: true, activations: true, decisions: true },
    nextDecisionSeq: 8
  };
  const digitalTwin = buildPolicyDigitalTwinReadModel({
    scope: GOVERNANCE_SCOPE, data, options: { historyLimit: 25, afterDecisionSeq: 0 }
  });
  /*
   * Every governance role granted, because the roles gate which controls are
   * drawn and the densest page -- the one the reader reported -- is the one
   * where all of them are.
   */
  /*
   * admin, because the governance roles are DERIVED from the access level and
   * the normalizer refuses a snapshot whose roles disagree with it. That is the
   * whole benefit of going through production code: the first version of this
   * fixture simply asserted all five roles and was rejected, rather than
   * quietly serving a combination the server can never produce.
   */
  const identityKey = crypto.createHash('sha256').update('alpha-tester@fixture', 'utf8').digest('hex');
  const access = projectGovernanceInterfaceAccess({
    schemaVersion: 1,
    scope: GOVERNANCE_SCOPE,
    evidence: {
      status: 'resolved',
      fetchedAt: new Date(now.getTime() - 60_000).toISOString(),
      expiresAt: new Date(now.getTime() + 1_800_000).toISOString()
    },
    repositoryAccess: {
      baseRole: 'admin', providerRole: 'admin', level: 50,
      source: 'fixture', complete: true
    },
    governanceActor: { kind: 'human', identityKey, login: 'alpha-tester', verified: true },
    executionPrincipal: { kind: 'user', identityKey, login: 'alpha-tester', authMethod: 'token' },
    governanceRoles: { reader: true, author: true, reviewer: true, activator: true, administrator: true }
  }, () => now.getTime());
  return { digitalTwin, access };
}
const SCOPE = 'alphaFixtureScope_0123456789abcdef';
const VALID = Object.freeze({
  access: new Set(['required', 'active', 'expired', 'revoked']),
  ready: new Set(['waking', 'ready', 'database-unavailable']),
  provider: new Set(['github', 'gitlab', 'gitea']),
  authMethod: new Set(['token', 'oauth', 'github-app']),
  repositoryState: new Set(['empty', 'current', 'stale', 'partial', 'degraded', 'error']),
  mutation: new Set(['verified', 'blocked', 'failed-unchanged', 'unknown']),
  cleanup: new Set(['verified', 'pending']),
  /*
   * How long the trust endpoints stay unanswered. 'settled' keeps the short
   * delay the other scenarios rely on; 'pending' holds them open so the
   * loading state can be asserted deliberately rather than raced against the
   * verdict that replaces it about a tenth of a second later.
   */
  trust: new Set(['settled', 'pending']),
  /*
   * 'unavailable' is the default and the state every existing guard was
   * written against: no digital-twin fixture, so the pane renders its evidence
   * failure. 'populated' serves a real read model, which is the surface the
   * reader actually uses and which nothing had ever drawn.
   */
  governance: new Set(['unavailable', 'populated'])
});

function normalizedScenario(input = {}) {
  const scenario = {
    access: input.access || 'active',
    /*
     * The gate itself, as distinct from one visitor's standing in it. It was
     * hardcoded on, so the screen a visitor meets when the operator turns the
     * gate off could not be expressed here at all -- which is why the landing
     * page being replaced a beat after it painted went unnoticed.
     */
    mode: input.mode || 'on',
    ready: input.ready || 'ready',
    provider: input.provider || 'github',
    authMethod: input.authMethod || 'token',
    login: input.login || 'alpha-tester',
    repositoryState: input.repositoryState || 'current',
    mutation: input.mutation || 'verified',
    cleanup: input.cleanup || 'verified',
    trust: input.trust || 'settled',
    governance: input.governance || 'unavailable'
  };
  for (const [key, values] of Object.entries(VALID)) {
    if (!values.has(scenario[key])) throw new TypeError(`Unsupported public-alpha fixture ${key}: ${scenario[key]}`);
  }
  return Object.freeze(scenario);
}

function sanitized(payload) {
  const serialized = JSON.stringify(payload);
  if (/(?:gh[pousr]_|github_pat_|glpat-|postgres(?:ql)?:\/\/|password\s*[=:]|token\s*[=:])/i.test(serialized)) {
    throw new Error('Public-alpha fixture payload contains credential-like material');
  }
  return payload;
}

function capabilityProjection(provider, authMethod = 'token') {
  return sanitized(projectCapabilities(capabilityDocument, {
    provider,
    authority: provider === 'github' ? 'github.com' : `${provider}.example.test`,
    deployment: 'hosted-alpha',
    authMethod
  }));
}

function publicError(code, message, overrides = {}) {
  return sanitized({
    error: message,
    code,
    correlationId: `fixture-${code.toLowerCase().replace(/_/g, '-')}`,
    providerChanged: 'no',
    safeState: 'The sandbox repository remains at the previously verified head.',
    nextAction: 'Review the safe state and retry the action.',
    ...overrides
  });
}

async function mockPublicAlphaApi(page, inputScenario = {}) {
  const scenario = normalizedScenario(inputScenario);
  const state = {
    scenario,
    readyChecks: 0,
    accessGranted: scenario.access === 'active',
    providerConnected: scenario.access === 'active',
    mutationRequests: [],
    disconnected: false,
    alphaEnded: false
  };

  await page.route('**/readyz', async route => {
    state.readyChecks += 1;
    if (scenario.ready === 'database-unavailable') {
      return route.fulfill({ status: 503, json: sanitized({ ok: false, database: 'unavailable' }) });
    }
    if (scenario.ready === 'waking' && state.readyChecks === 1) {
      return route.fulfill({ status: 503, json: sanitized({ ok: false, database: 'unavailable' }) });
    }
    return route.fulfill({ json: sanitized({ ok: true, database: 'ready' }) });
  });

  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    const method = request.method();
    const fulfill = (json, status = 200) => route.fulfill({ status, json: sanitized(json) });
    if (/\/api\/repo\/sandbox\/demo\/(?:live-events\/status|access-surface|evidence)$/.test(pathname)) {
      await new Promise(resolve => setTimeout(resolve, scenario.trust === 'pending' ? 2500 : 120));
    }

    if (pathname === '/api/alpha/status') {
      return fulfill({
        mode: scenario.mode,
        authenticated: state.accessGranted,
        access: scenario.access,
        termsVersion: 'alpha-terms-v1'
      });
    }
    if (pathname === '/api/alpha/redeem' && method === 'POST') {
      state.accessGranted = true;
      return fulfill({ ok: true, termsVersion: 'alpha-terms-v1' });
    }
    /*
     * Opt-in, keyed off the scenario, because the pane's existing guard is
     * about how the FAILURE state lays out and must keep getting the failure.
     */
    if (/\/governance\/digital-twin$/.test(pathname) && scenario.governance === 'populated') {
      return fulfill(governanceTwinPayload());
    }
    /*
     * The four delivery endpoints the pane fans out to after the twin loads.
     * Without them the page renders its densest cards -- notifications, signed
     * audit exports and administrative webhooks -- around an error string
     * instead of around content, which is not the layout anybody sees.
     */
    if (scenario.governance === 'populated') {
      if (/\/governance\/notifications$/.test(pathname)) {
        return fulfill({ events: [], unreadCount: 0, nextSeq: 1 });
      }
      if (/\/governance\/notifications\/preferences$/.test(pathname) && method === 'GET') {
        return fulfill({ preferences: { enabled: true, eventTypes: ['policy.activated', 'exception.approved'] } });
      }
      if (/\/governance\/exports$/.test(pathname) && method === 'GET') {
        return fulfill({ exports: [{
          exportId: '70000000-0000-4000-8000-000000000007',
          format: 'json', eventCount: 0, recorded: false,
          createdAt: new Date(Date.now() - 7_200_000).toISOString()
        }] });
      }
      if (/\/governance\/webhooks$/.test(pathname) && method === 'GET') {
        return fulfill({ webhooks: [] });
      }
    }
    if (pathname === '/api/config') return fulfill({ oauth: false, uploadMaxMb: 2048, gitDataMaxMb: 64, nativePushMaxMb: 64, contentsMaxMb: 40, githubApp: { enabled: true, webhookConfigured: true } });
    if (pathname === '/api/security/csrf') return fulfill({ token: 'fixture-csrf-value', expiresAt: new Date(Date.now() + 600000).toISOString() });
    if (pathname === '/api/login' && method === 'POST') {
      state.providerConnected = true;
      return fulfill({ login: 'alpha-tester', name: 'Alpha Tester', avatar: '', provider: scenario.provider, authMethod: 'token', offlineCacheScope: SCOPE });
    }
    if (pathname === '/api/me') {
      if (!state.providerConnected) return fulfill(publicError('PROVIDER_CONNECTION_REQUIRED', 'Connect a sandbox provider account to continue.', {
        safeState: 'Alpha access is active; no provider account is connected.',
        nextAction: 'Review provider permissions, then connect the sandbox account.'
      }), 401);
      return fulfill({
        login: scenario.login || 'alpha-tester', name: 'Alpha Tester', avatar: '', provider: scenario.provider,
        authMethod: scenario.authMethod || 'token', offlineCacheScope: SCOPE,
        caps: { prs: true, issues: true, releases: true, actions: true, lfs: true, tm: true, batch: true, search: true, notif: true, compare: true }
      });
    }
    if (pathname === '/api/capabilities' || pathname === '/api/account/capabilities') return fulfill(capabilityProjection(scenario.provider, scenario.authMethod));
    if (pathname === '/api/safety') return fulfill({ readOnly: false, freezeSync: false, protected: {} });
    /*
     * The overview asks for this once it is on screen, so every fixture that
     * reaches the overview needs it. Without it the request fell through to
     * the unmatched-route 404 and the workspace pulse reported the scanner as
     * unknown -- a missing fixture reading as a product posture.
     */
    if (pathname === '/api/security/scanner-status') return fulfill({
      builtin: { available: true, engine: 'bounded-signature-gate', rules: ['EICAR_TEST_FILE'] },
      yara: { configured: false, required: false, binary: 'yara', rulesPath: '', timeoutSeconds: 5 },
      note: 'Built-in bounded signatures are active.'
    });
    if (pathname === '/api/github-app/status') return fulfill({ enabled: true, webhookConfigured: true, connections: [] });
    if (pathname === '/api/repos') {
      if (method === 'POST') return fulfill({ id: 12, full_name: 'sandbox/demo', default_branch: 'main', verified: true }, 201);
      if (scenario.repositoryState === 'empty') return fulfill([]);
      return fulfill([{ full_name: 'sandbox/demo', name: 'demo', owner: 'sandbox', private: true, description: 'Disposable alpha sandbox', language: 'JavaScript', stars: 0, forks: 0, pushed_at: new Date().toISOString() }]);
    }
    if (pathname === '/api/search') return fulfill([{ repo: 'sandbox/demo', path: 'README.md' }]);
    if (pathname === '/api/notifications') return fulfill([{ id: 'n1', repo: 'sandbox/demo', title: 'Review requested', type: 'PullRequest', reason: 'mention', unread: true }]);
    if (pathname === '/api/repo/sandbox/demo' && method === 'GET') {
      if (scenario.repositoryState === 'error') return fulfill(publicError('REPOSITORY_TEMPORARILY_UNAVAILABLE', 'The sandbox repository could not be opened.', {
        nextAction: 'Retry opening the allowlisted sandbox repository.'
      }), 503);
      return fulfill({ full_name: 'sandbox/demo', private: true, default_branch: 'main', branches: [{ name: 'main', protected: false, sha: HEAD_SHA }] });
    }
    if (pathname === '/api/repo/sandbox/demo/tree') return fulfill([]);
    if (pathname === '/api/repo/sandbox/demo/files') return fulfill({ files: [] });
    if (pathname === '/api/repo/sandbox/demo/file' && method === 'GET') {
      return fulfill({ path: url.searchParams.get('path') || 'alpha-proof.txt', sha: 'c'.repeat(40), size: 0, content: '', binary: false });
    }
    if (pathname === '/api/repo/sandbox/demo/star') return fulfill({ starred: false });
    if (pathname === '/api/repo/sandbox/demo/live-events/status') {
      if (scenario.repositoryState === 'degraded') return fulfill({ available: false, connected: false, reason: 'The evidence pipeline is degraded.' });
      return fulfill({ available: true, connected: true, createdAt: new Date().toISOString() });
    }
    if (pathname === '/api/repo/sandbox/demo/access-surface') {
      return fulfill({
        available: true,
        partial: scenario.repositoryState === 'partial',
        currentIdentity: 'alpha-tester', currentPermission: 'write',
        collaborators: [], deployKeys: [], webhooks: [],
        risk: scenario.repositoryState === 'partial'
          ? { score: 12, severity: 'normal', reasons: [{ code: 'ACCESS_INVENTORY_PARTIAL', message: 'Access inventory is partial.' }] }
          : { score: 0, severity: 'normal', reasons: [] }
      });
    }
    if (pathname === '/api/repo/sandbox/demo/evidence') {
      if (scenario.repositoryState === 'degraded') return fulfill({ available: false, chain: { available: false, valid: false, checked: 0 }, events: [], snapshots: [] });
      return fulfill({
        available: true,
        generatedAt: new Date().toISOString(),
        repository: 'sandbox/demo',
        chain: { available: true, valid: scenario.repositoryState !== 'stale', complete: true, checked: 1, total: 1 },
        events: [{ event_id: 'event-1', event_type: 'sandbox.verified', severity: 'normal', summary: 'Sandbox evidence verified.' }],
        snapshots: []
      });
    }
    if (pathname === '/api/repo/sandbox/demo/file' && method === 'PUT') {
      const body = request.postDataJSON();
      state.mutationRequests.push(body);
      if (scenario.mutation === 'blocked') return fulfill(publicError('MUTATION_BLOCKED', 'The controlled action was blocked by policy.', {
        nextAction: 'Review the policy decision before retrying.'
      }), 409);
      if (scenario.mutation === 'failed-unchanged') return fulfill(publicError('PROVIDER_UNAVAILABLE', 'The provider did not complete the action.', {
        providerChanged: 'no',
        nextAction: 'Wait for provider recovery and retry with the same expected head.'
      }), 503);
      if (scenario.mutation === 'unknown') return fulfill(publicError('MUTATION_OUTCOME_UNKNOWN', 'The provider outcome could not be verified.', {
        providerChanged: 'unknown',
        safeState: 'Do not retry until the repository head is refreshed.',
        nextAction: 'Refresh repository metadata and compare the expected head.'
      }), 502);
      return fulfill({ ok: true, commit: 'b'.repeat(40), sha: 'c'.repeat(40), verified: true });
    }
    if (pathname === '/api/alpha/providers/disconnect-all' && method === 'POST') {
      if (scenario.cleanup === 'pending') return fulfill({ ok: false, status: 'pending', revocationGuidance: [] });
      state.disconnected = true;
      state.providerConnected = false;
      return fulfill({ ok: true, status: 'verified', providerRevoked: false, revocationGuidance: [] });
    }
    if (pathname === '/api/alpha/end' && method === 'POST') {
      state.alphaEnded = true;
      return fulfill({ ok: true, status: 'verified' });
    }
    if (pathname === '/api/logout' && method === 'POST') return fulfill({ ok: true });
    return fulfill(publicError('FIXTURE_ROUTE_UNMATCHED', `No sanitized fixture exists for ${method} ${pathname}.`), 404);
  });

  return state;
}

async function openConnectedRepository(page, scenario = {}) {
  const state = await mockPublicAlphaApi(page, { access: 'active', ...scenario });
  await page.goto('/');
  /* A signed-in session lands on the overview; the inventory is one step in. */
  await require('./semantic').enterRepositories(page);
  await page.locator('.repo-card').first().click();
  await page.locator('#page-work.active').waitFor();
  return state;
}

async function startNewFileAction(page, path = 'alpha-proof.txt') {
  /* Reached by name, so it follows the control between the bar and the floating action. */
  await (await ui.action(page, 'Command palette')).click();
  await page.locator('#paletteInput').fill('New file');
  await page.locator('.pal-item', { hasText: 'New file' }).first().click();
  await page.locator('#nfPath').fill(path);
  await page.locator('#modalOk').click();
}

module.exports = {
  HEAD_SHA,
  mockPublicAlphaApi,
  openConnectedRepository,
  startNewFileAction
};
