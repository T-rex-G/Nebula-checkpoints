'use strict';

const capabilityDocument = require('../../config/public-alpha-capabilities.json');

const HEAD_SHA = 'a'.repeat(40);
const SCOPE = 'alphaFixtureScope_0123456789abcdef';
const VALID = Object.freeze({
  access: new Set(['required', 'active', 'expired', 'revoked']),
  ready: new Set(['waking', 'ready', 'database-unavailable']),
  provider: new Set(['github', 'gitlab', 'gitea']),
  repositoryState: new Set(['empty', 'current', 'stale', 'partial', 'degraded', 'error']),
  mutation: new Set(['verified', 'blocked', 'failed-unchanged', 'unknown']),
  cleanup: new Set(['verified', 'pending'])
});

function normalizedScenario(input = {}) {
  const scenario = {
    access: input.access || 'active',
    ready: input.ready || 'ready',
    provider: input.provider || 'github',
    repositoryState: input.repositoryState || 'current',
    mutation: input.mutation || 'verified',
    cleanup: input.cleanup || 'verified'
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

function capabilityProjection(provider) {
  const tuples = capabilityDocument.providers[provider]['hosted-alpha'];
  return sanitized({
    provider,
    authority: provider === 'github' ? 'github.com' : `${provider}.example.test`,
    deployment: 'hosted-alpha',
    features: Object.fromEntries(Object.entries(tuples).map(([feature, tuple]) => [feature, {
      feature,
      provider,
      authority: provider === 'github' ? 'github.com' : `${provider}.example.test`,
      deployment: 'hosted-alpha',
      status: tuple[0],
      evidenceState: tuple[1],
      reason: tuple[2]
    }]))
  });
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
      await new Promise(resolve => setTimeout(resolve, 120));
    }

    if (pathname === '/api/alpha/status') {
      return fulfill({
        mode: 'on',
        authenticated: state.accessGranted,
        access: scenario.access,
        termsVersion: 'alpha-terms-v1'
      });
    }
    if (pathname === '/api/alpha/redeem' && method === 'POST') {
      state.accessGranted = true;
      return fulfill({ ok: true, termsVersion: 'alpha-terms-v1' });
    }
    if (pathname === '/api/config') return fulfill({ oauth: false, uploadMaxMb: 2048, gitDataMaxMb: 64, nativePushMaxMb: 64, githubApp: { enabled: true, webhookConfigured: true } });
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
        login: 'alpha-tester', name: 'Alpha Tester', avatar: '', provider: scenario.provider,
        authMethod: 'token', offlineCacheScope: SCOPE,
        caps: { prs: true, issues: true, releases: true, actions: true, lfs: true, tm: true, batch: true, search: true, notif: true, compare: true }
      });
    }
    if (pathname === '/api/capabilities') return fulfill(capabilityProjection(scenario.provider));
    if (pathname === '/api/safety') return fulfill({ readOnly: false, freezeSync: false, protected: {} });
    if (pathname === '/api/github-app/status') return fulfill({ enabled: true, webhookConfigured: true, connections: [] });
    if (pathname === '/api/repos') {
      if (scenario.repositoryState === 'empty') return fulfill([]);
      return fulfill([{ full_name: 'sandbox/demo', name: 'demo', owner: 'sandbox', private: true, description: 'Disposable alpha sandbox', language: 'JavaScript', stars: 0, forks: 0, pushed_at: new Date().toISOString() }]);
    }
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
  await page.locator('.repo-card').first().click();
  await page.locator('#page-work.active').waitFor();
  return state;
}

async function startNewFileAction(page, path = 'alpha-proof.txt') {
  await page.locator('#paletteBtn').click();
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
