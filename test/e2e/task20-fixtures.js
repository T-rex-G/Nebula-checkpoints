'use strict';

const capabilityDocument = require('../../config/public-alpha-capabilities.json');
const scope = 'scopeAlice_0123456789abcdefXYZ';

function capabilities() {
  return {
    provider: 'github',
    authority: 'github.com',
    deployment: 'hosted-alpha',
    features: Object.fromEntries(Object.entries(capabilityDocument.providers.github['hosted-alpha']).map(([feature, tuple]) => [feature, {
      feature,
      provider: 'github',
      authority: 'github.com',
      deployment: 'hosted-alpha',
      status: tuple[0],
      evidenceState: tuple[1],
      reason: tuple[2]
    }]))
  };
}

function digitalTwin() {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    scope: { provider: 'github', owner: 'acme', repo: 'demo' },
    freshness: {
      status: 'current',
      asOf: now,
      completeness: { current: true, proposed: true, effective: true, history: true }
    },
    current: { policyCount: 0, activePolicyCount: 0, policies: [] },
    proposed: { draftCount: 0, versionCount: 0, drafts: [], versions: [] },
    effective: { activeExceptionCount: 0, exceptions: [] },
    history: { decisions: [], nextDecisionSeq: null },
    readModelHash: 'a'.repeat(64)
  };
}

function access() {
  return {
    scope: { provider: 'github', owner: 'acme', repo: 'demo' },
    actor: { login: 'alice' },
    execution: { kind: 'user', authMethod: 'token' },
    capabilities: { read: true, author: true, review: true, activate: true, administer: true },
    evidence: { status: 'current', expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() }
  };
}

async function mockTask20Api(page, state = {}) {
  state.governanceRequests = 0;
  await page.route('**/readyz', route => route.fulfill({ json: { ok: true, database: 'ready' } }));
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    if (pathname.includes('/governance/')) state.governanceRequests += 1;

    /*
     * An admitted session: the gate is on and this reader is already through
     * it. It used to say the gate was off, which reached the same place by
     * accident -- gate-off handed straight over to the workspace. It no longer
     * does: with entry open the landing page stays until the reader asks to
     * pass, so saying 'off' here would park every journey below on the front
     * door. Admission is what these tests need; the gate has its own suite.
     */
    if (pathname === '/api/alpha/status') return route.fulfill({ json: { mode: 'invite', authenticated: true, access: 'active' } });
    if (pathname === '/api/config') return route.fulfill({ json: { oauth: false, uploadMaxMb: 2048, gitDataMaxMb: 64, nativePushMaxMb: 64, contentsMaxMb: 40 } });
    // Signed-in sessions request the account projection; both describe this
    // fixture's ordinary GitHub token. Keep unrelated API routes fail-closed.
    if (pathname === '/api/capabilities' || pathname === '/api/account/capabilities') {
      return route.fulfill({ json: capabilities() });
    }
    if (pathname === '/api/me') return route.fulfill({ json: {
      login: 'alice', name: 'Alice', avatar: '', provider: 'github', authMethod: 'token',
      caps: { prs: true, issues: true, releases: true, actions: true, lfs: true, tm: true, batch: true, search: true, notif: true, compare: true },
      offlineCacheScope: scope
    } });
    if (pathname === '/api/security/csrf') return route.fulfill({ json: { token: 'csrf-test-token', expiresAt: new Date(Date.now() + 600000).toISOString() } });
    if (pathname === '/api/repos') return route.fulfill({ json: [{ full_name: 'acme/demo', name: 'demo', owner: 'acme', private: true, description: 'Demo', language: 'JavaScript', stars: 1, forks: 0, pushed_at: new Date().toISOString() }] });
    if (pathname === '/api/repo/acme/demo') return route.fulfill({ json: { full_name: 'acme/demo', private: true, default_branch: 'main', branches: [{ name: 'main', protected: true, sha: 'b'.repeat(40) }] } });
    if (pathname === '/api/repo/acme/demo/tree') return route.fulfill({ json: [] });
    if (pathname === '/api/safety') return route.fulfill({ json: { readOnly: false, freezeSync: false, protected: {} } });
    if (pathname === '/api/github-app/status') return route.fulfill({ json: { configured: false, connected: false } });
    if (pathname === '/api/repo/acme/demo/governance/digital-twin') return route.fulfill({ json: { digitalTwin: digitalTwin(), access: access() } });
    if (pathname === '/api/repo/acme/demo/governance/notifications') return route.fulfill({ json: { events: [], complete: true, nextAfterSeq: null } });
    if (pathname === '/api/repo/acme/demo/governance/notifications/preferences') return route.fulfill({ json: { preferences: { enabled: true, eventTypes: [], lastReadSeq: 0 } } });
    if (pathname === '/api/repo/acme/demo/governance/exports') return route.fulfill({ json: { exports: [] } });
    if (pathname === '/api/repo/acme/demo/governance/webhooks') return route.fulfill({ json: { webhooks: [] } });
    return route.fulfill({ status: 404, json: { error: `Unmocked ${request.method()} ${pathname}` } });
  });
  return state;
}

async function openRepository(page) {
  await page.goto('/');
  /* A signed-in session lands on the overview; the inventory is one step in. */
  await require('./semantic').enterRepositories(page);
  await page.locator('.repo-card').first().click();
  await page.locator('#page-work.active').waitFor();
}

module.exports = { mockTask20Api, openRepository };
