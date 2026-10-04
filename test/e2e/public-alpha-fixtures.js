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
      { policy_id: '20000000-0000-4000-8000-000000000002', policy_key: 'zeta', name: 'Upload security', description: '', revision: 2, active_version_id: null, updated_at: earlier,
        last_activation_action: 'deactivate', last_activation_version_id: '90000000-0000-4000-8000-000000000009', last_activation_version_number: 1 }
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
  governance: new Set(['unavailable', 'populated']),
  /*
   * Triage: 'reviewer' may decide about findings, 'reader' sees the team's
   * decisions and may not make one. And the clocks: 'fresh' findings were
   * first seen by the audit that reports them, 'aged' ones forty days earlier,
   * so the critical and serious ones are past their deadline.
   */
  triage: new Set(['reviewer', 'reader']),
  auditClock: new Set(['fresh', 'aged']),
  /*
   * The gate's own setting, in the words the server uses for it: 'off' or
   * 'invite', straight from NV_ALPHA_ACCESS_MODE. It was spelled 'on' here,
   * which no deployment ever sends -- so a client branching on the real value
   * could be wrong in production while every test agreed with it.
   */
  mode: new Set(['off', 'invite']),
  /*
   * The four shapes the activity feed draws differently, named so a test can
   * ask for one rather than construct it. 'normal' is a read that worked;
   * 'quiet' is a workspace that answered and had nothing to say; 'partial' is
   * one repository lost out of several; 'unreadable' is none of them readable.
   *
   * The last three are the states that matter and the ones that never happen
   * by accident, which is the whole reason they are expressible here: a feed
   * that cannot be read and a feed that is empty look identical if nobody ever
   * renders both.
   */
  activityState: new Set(['normal', 'quiet', 'partial', 'unreadable']),
  postureState: new Set(['clean', 'critical-leak']),
  /* Whether the server keeps audits: 'kept' as with a database, 'unavailable' as without one. */
  auditHistory: new Set(['kept', 'unavailable']),
  /* What deps.dev answers for the audited dependencies: 'permissive' for what ships, or 'copyleft' making lodash AGPL. */
  licences: new Set(['permissive', 'copyleft']),
  /* What the audited branch is written in: 'node' alone, or 'polyglot' with a Go service, a Spring controller and a Laravel app beside it. */
  auditStack: new Set(['node', 'polyglot'])
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
    mode: input.mode || 'invite',
    ready: input.ready || 'ready',
    provider: input.provider || 'github',
    authMethod: input.authMethod || 'token',
    login: input.login || 'alpha-tester',
    repositoryState: input.repositoryState || 'current',
    mutation: input.mutation || 'verified',
    cleanup: input.cleanup || 'verified',
    trust: input.trust || 'settled',
    governance: input.governance || 'unavailable',
    activityState: input.activityState || 'normal',
    postureState: input.postureState || 'clean',
    auditHistory: input.auditHistory || 'kept',
    triage: input.triage || 'reviewer',
    auditClock: input.auditClock || 'fresh',
    licences: input.licences || 'permissive',
    auditStack: input.auditStack || 'node',
    /* Audit results kept before the page opened, oldest first, and what the watch will find since the latest. */
    auditHistorySeed: Array.isArray(input.auditHistorySeed) ? input.auditHistorySeed : [],
    auditWatchAlerts: Array.isArray(input.auditWatchAlerts) ? input.auditWatchAlerts : []
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
    visitRequests: [],
    disconnected: false,
    alphaEnded: false
  };
  /*
   * The audits the server keeps, newest first, reduced by the same function
   * the server uses (src/code-audit-history.js) and answered in the same
   * shapes, so the page is tested against what a database would give it.
   */
  const { compactAudit, serialize } = require('../../src/code-audit-history');
  state.auditHistory = [];
  const recordAudit = result => {
    const compact = compactAudit(result);
    const previous = state.auditHistory.find(entry => entry.row.ref_name === compact.audit.ref_name);
    let diff = null;
    if (previous) {
      const before = new Set(previous.findings.map(row => row.finding_id));
      const current = new Set(compact.findings.map(row => row.finding_id));
      diff = { newIds: [...current].filter(id => !before.has(id)), resolved: [...before].filter(id => !current.has(id)).length };
    }
    const row = { ...compact.audit, audit_id: crypto.randomUUID(), new_count: diff ? diff.newIds.length : null, resolved_count: diff ? diff.resolved : null };
    /* Each finding's clock: when any kept audit first saw it, as the server carries it -- forty days back when aged. */
    const shift = scenario.auditClock === 'aged' ? 40 * 24 * 60 * 60 * 1000 : 0;
    const firstSeen = {};
    for (const finding of [...compact.findings, ...(compact.waived || [])]) {
      const seen = state.auditHistory.filter(entry => entry.findings.some(kept => kept.finding_id === finding.finding_id))
        .map(entry => Date.parse(entry.row.audited_at));
      const at = Math.min(Date.parse(row.audited_at), ...seen) - shift;
      finding.first_seen_at = new Date(at).toISOString();
      firstSeen[finding.finding_id] = finding.first_seen_at;
    }
    state.auditHistory.unshift({ row, findings: compact.findings, components: compact.components, alerts: [], watched: false });
    return { saved: true, auditId: row.audit_id, previousAt: previous ? previous.row.audited_at : null, newIds: diff ? diff.newIds : null, resolved: diff ? diff.resolved : null, firstSeen };
  };
  /* The team's decisions about the repository's findings, and every step of them, as the triage store keeps them. */
  const triageModule = require('../../src/code-audit-triage');
  const { clockOf } = require('../../src/code-audit-policy');
  const { exploitedInProduction } = require('../../src/uranus-reach');
  state.triage = new Map();
  state.triageEvents = [];
  for (const seeded of scenario.auditHistorySeed) recordAudit(seeded);

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
    /*
     * Somebody else's public repository, answered by the sandbox's routes:
     * any path under octo/spoon-knife (in any letter case) is the sandbox's,
     * and its own record says it is public and this account may only read it.
     */
    const visiting = /^\/api\/repo\/octo\/spoon-knife(?=\/|$)/i.test(url.pathname);
    if (visiting) state.visitRequests.push(`${request.method()} ${url.pathname}`);
    const pathname = visiting ? url.pathname.replace(/^\/api\/repo\/octo\/spoon-knife/i, '/api/repo/sandbox/demo') : url.pathname;
    const method = request.method();
    if (visiting && pathname === '/api/repo/sandbox/demo' && method === 'GET') {
      return route.fulfill({ status: 200, json: sanitized({ full_name: 'Octo/Spoon-Knife', private: false, default_branch: 'main', permission: 'read', homepage: null, branches: [{ name: 'main', protected: true, sha: HEAD_SHA }] }) });
    }
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
      /* One archived policy, so the archive section is drawn with content. */
      if (/\/governance\/archive$/.test(pathname) && method === 'GET') {
        return fulfill({ policies: [{
          policyId: '80000000-0000-4000-8000-000000000008', policyKey: 'legacy-release',
          name: 'Legacy release rules', description: '', createdAt: new Date(Date.now() - 86_400_000 * 9).toISOString(),
          archivedAt: new Date(Date.now() - 86_400_000 * 2).toISOString(), versionCount: 3, keyInUse: false
        }] });
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
    /*
     * The safety state as the hosted alpha answers it: repository-scoped
     * locks that change, global switches that belong to the deployment.
     */
    if (pathname === '/api/safety') {
      state.safety = state.safety || { readOnly: false, freezeSync: false, protected: {}, globalControls: false };
      if (method === 'POST') {
        const body = request.postDataJSON() || {};
        if (typeof body.readOnly === 'boolean' || typeof body.freezeSync === 'boolean') {
          return fulfill({ error: 'Global safety changes require an unscoped deployment', code: 'ALPHA_REPOSITORY_SCOPE_REQUIRED' }, 403);
        }
        if (body.protect && body.protect.repo && body.protect.path) {
          const list = new Set(state.safety.protected[body.protect.repo] || []);
          if (body.protect.on === false) list.delete(body.protect.path); else list.add(body.protect.path);
          if (list.size) state.safety.protected[body.protect.repo] = [...list].sort(); else delete state.safety.protected[body.protect.repo];
        }
      }
      return fulfill(state.safety);
    }
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
    /*
     * The overview's posture read: what the credential can reach, which
     * repositories have a recovery point, which leaked credentials are still
     * open, and whether the server's boundary is up. `postureState` selects a
     * workspace with an open critical leak, so the cap can be seen on screen.
     */
    if (pathname === '/api/workspace/posture') {
      const leaked = scenario.postureState === 'critical-leak';
      return fulfill({
        credential: {
          kind: 'fine-grained', rating: 0.9, scopes: [], expiresAt: '2026-12-31T00:00:00.000Z',
          detail: 'Fine-grained token limited to the repositories chosen for it, expiring 2026-12-31.'
        },
        recovery: { available: true, repositories: [{ owner: 'sandbox', repo: 'demo', latestAt: new Date(Date.now() - 86400000).toISOString(), points: 1 }] },
        exposure: {
          available: true,
          repositories: [{
            owner: 'sandbox', repo: 'demo', scannedAt: new Date(Date.now() - 3600000).toISOString(), partial: false,
            open: { critical: leaked ? 1 : 0, serious: 0, warning: 0 }
          }]
        },
        boundary: { state: 'online', database: 'ready', maintenance: false }
      });
    }
    if (pathname === '/api/github-app/status') return fulfill({ enabled: true, webhookConfigured: true, connections: [] });
    if (pathname === '/api/repos') {
      if (method === 'POST') return fulfill({ id: 12, full_name: 'sandbox/demo', default_branch: 'main', verified: true }, 201);
      if (scenario.repositoryState === 'empty') return fulfill([]);
      return fulfill([{ full_name: 'sandbox/demo', name: 'demo', owner: 'sandbox', private: true, description: 'Disposable alpha sandbox', language: 'JavaScript', stars: 0, forks: 0, pushed_at: new Date().toISOString() }]);
    }
    /*
     * The overview's activity feed. Every signed-in test lands on the overview,
     * so an unmocked route here is a failed request on the way into every one
     * of them -- the fixture answers it whether or not the test is about it.
     *
     * activityState selects the shape: a normal read, a workspace where nothing
     * happened, one where a repository could not be read, and one where none
     * could. Those are the four the card draws differently, and three of them
     * are exactly the ones that never occur by accident.
     */
    if (pathname === '/api/activity/recent') {
      const at = offset => new Date(Date.now() - offset).toISOString();
      const base = {
        kind: 'nebulaverse-activity-feed', version: 1, generatedAt: at(0),
        days: 14, since: at(14 * 86400000), kinds: ['commit'], inventoryCount: 1,
        undated: 0, truncated: false
      };
      if (scenario.activityState === 'unreadable') {
        return fulfill({
          ...base, measured: false, events: [], totalEvents: 0, repositories: [],
          failed: [{ repo: 'sandbox/demo', reason: 'rate limit exceeded' }]
        });
      }
      if (scenario.activityState === 'quiet') {
        return fulfill({
          ...base, measured: true, events: [], totalEvents: 0,
          repositories: ['sandbox/demo'], failed: []
        });
      }
      if (scenario.activityState === 'partial') {
        return fulfill({
          ...base, inventoryCount: 2, measured: true, totalEvents: 1,
          events: [{ kind: 'commit', repo: 'sandbox/demo', title: 'Add a bounded signature gate', detail: 'a1b2c3d', actor: 'Ada Lovelace', at: Date.parse(at(3600000)), ref: 'a1b2c3d4e5' }],
          repositories: ['sandbox/demo'],
          failed: [{ repo: 'sandbox/other', reason: 'not found' }]
        });
      }
      return fulfill({
        ...base, measured: true, totalEvents: 2,
        events: [
          { kind: 'commit', repo: 'sandbox/demo', title: 'Add a bounded signature gate', detail: 'a1b2c3d', actor: 'Ada Lovelace', at: Date.parse(at(3600000)), ref: 'a1b2c3d4e5' },
          { kind: 'commit', repo: 'sandbox/demo', title: 'Tighten the upload timeout', detail: 'f6e5d4c', actor: 'Lin Zhou', at: Date.parse(at(90000000)), ref: 'f6e5d4c3b2' }
        ],
        repositories: ['sandbox/demo'], failed: []
      });
    }
    if (pathname === '/api/search') return fulfill([{ repo: 'sandbox/demo', path: 'README.md' }]);
    if (pathname === '/api/notifications') return fulfill([{ id: 'n1', repo: 'sandbox/demo', title: 'Review requested', type: 'PullRequest', reason: 'mention', unread: true }]);
    if (pathname === '/api/repo/sandbox/demo' && method === 'GET') {
      if (scenario.repositoryState === 'error') return fulfill(publicError('REPOSITORY_TEMPORARILY_UNAVAILABLE', 'The sandbox repository could not be opened.', {
        nextAction: 'Retry opening the allowlisted sandbox repository.'
      }), 503);
      return fulfill({ full_name: 'sandbox/demo', private: true, default_branch: 'main', homepage: 'https://demo.example.com', branches: [{ name: 'main', protected: false, sha: HEAD_SHA }] });
    }
    if (pathname === '/api/repo/sandbox/demo/tree') return fulfill([]);
    if (pathname === '/api/repo/sandbox/demo/files') {
      return fulfill({ files: scenario.files || ['README.md', '.env.example', '.github/workflows/ci.yml', '.github/workflows/deploy.yml', 'package.json', 'package-lock.json', 'src/app.js'] });
    }
    if (pathname === '/api/repo/sandbox/demo/file' && method === 'GET') {
      const requestedPath = url.searchParams.get('path');
      const existing = scenario.files || ['README.md', '.env.example', '.github/workflows/ci.yml', '.github/workflows/deploy.yml', 'package.json', 'package-lock.json', 'src/app.js'];
      if (!existing.includes(requestedPath) && !state.mutationRequests.some(body => body.path === requestedPath)) {
        return fulfill(publicError('NOT_FOUND', 'File not found at the requested commit.'), 404);
      }
      return fulfill({ path: url.searchParams.get('path') || 'alpha-proof.txt', sha: 'c'.repeat(40), size: 0, content: '', binary: false });
    }
    /*
     * The repository audit, computed by the real engine over a small flawed
     * project, so the screen is tested against the shape the server returns
     * rather than a hand-written approximation of it. The second audit of a
     * session finds the SQL fixed, so the comparison with the last one has
     * something to say. As on the server, the first request starts a run and
     * answers 202 with its stage; the page asks again with the run id.
     */
    if (pathname.startsWith('/api/repo/sandbox/demo/code-audit/')) {
      const rest = pathname.slice('/api/repo/sandbox/demo/code-audit/'.length);
      if (scenario.auditHistory === 'unavailable') {
        return method === 'GET' ? fulfill({ available: false }) : fulfill(publicError('CODE_AUDIT_HISTORY_UNAVAILABLE', 'Audit history requires the configured PostgreSQL DATABASE_URL'), 503);
      }
      const ref = url.searchParams.get('ref') || 'main';
      if (rest === 'triage' && method === 'GET') {
        return fulfill({ available: true, canDecide: scenario.triage === 'reviewer', vocabulary: triageModule.VOCABULARY,
          decisions: [...state.triage.values()].sort((a, b) => b.decidedAt.localeCompare(a.decidedAt)) });
      }
      const decided = /^findings\/([0-9a-f]{24})\/(triage|reopen|triage-events)$/.exec(rest);
      if (decided) {
        const [, findingId, verb] = decided;
        if (verb === 'triage-events' && method === 'GET') {
          return fulfill({ events: state.triageEvents.filter(event => event.findingId === findingId).slice().reverse() });
        }
        if (method !== 'POST') return fulfill(publicError('NOT_FOUND', 'Not found'), 404);
        if (scenario.triage !== 'reviewer') return fulfill(publicError('GOV_ROLE_REQUIRED', 'A reviewer must decide about findings'), 403);
        const at = new Date().toISOString();
        if (verb === 'reopen') {
          const removed = state.triage.get(findingId);
          if (!removed) return fulfill(publicError('CODE_AUDIT_TRIAGE_NOT_FOUND', 'Nobody has decided anything about that finding'), 404);
          state.triage.delete(findingId);
          state.triageEvents.push({ id: crypto.randomUUID(), findingId, rule: removed.rule, event: 'reopened', disposition: null, reason: null, expiresAt: null, actor: scenario.login, at });
          return fulfill({ reopened: removed }, 201);
        }
        const body = JSON.parse(request.postData() || '{}');
        let input;
        try { input = triageModule.normalizeDecision({ disposition: body.disposition, reason: body.reason, expiresInDays: body.expiresInDays }); }
        catch (error) { return fulfill(publicError(error.code || 'CODE_AUDIT_TRIAGE_INVALID', error.message), 400); }
        const expiresAt = input.days ? new Date(Date.parse(at) + input.days * 24 * 60 * 60 * 1000).toISOString() : null;
        const decision = { findingId, rule: String(body.rule || ''), disposition: input.disposition, reason: input.reason, decidedBy: scenario.login, decidedAt: at, expiresAt };
        state.triage.set(findingId, decision);
        state.triageEvents.push({ id: crypto.randomUUID(), findingId, rule: decision.rule, event: 'decided', disposition: decision.disposition, reason: decision.reason, expiresAt, actor: scenario.login, at });
        return fulfill({ decision }, 201);
      }
      if (rest === 'metrics' && method === 'GET') {
        /* Where the branch stands against its clocks, worked out as the history does it, over the latest kept audit. */
        const latest = state.auditHistory.find(entry => entry.row.ref_name === ref);
        const now = Date.now();
        const empty = () => ({ count: 0, medianDays: null, meanDays: null });
        const mttr = { windowDays: 90, all: empty(), critical: empty(), serious: empty(), warning: empty() };
        const triage = { summary: triageModule.summarizeDecisions(state.triage, now) };
        if (!latest) return fulfill({ available: true, ref, audit: null, sla: null, open: null, oldest: null, mttr, triage: triage.summary, triageUnavailable: false });
        const sla = { critical: latest.row.sla_critical || 7, serious: latest.row.sla_serious || 30, warning: latest.row.sla_warning || 90 };
        const bySeverity = { critical: { open: 0, overdue: 0, dueSoon: 0 }, serious: { open: 0, overdue: 0, dueSoon: 0 }, warning: { open: 0, overdue: 0, dueSoon: 0 } };
        const open = { total: 0, overdue: 0, dueSoon: 0, onTrack: 0, unclocked: 0, bySeverity };
        let oldest = null;
        for (const finding of latest.findings) {
          const decision = state.triage.get(finding.finding_id);
          if (decision && decision.rule === finding.rule && triageModule.inForce(decision, now)) continue;
          const clock = clockOf({ severity: finding.severity, exploited: false }, { firstSeenAt: finding.first_seen_at, sla, now });
          if (!bySeverity[finding.severity]) continue;
          open.total += 1;
          bySeverity[finding.severity].open += 1;
          if (!clock) { open.unclocked += 1; continue; }
          if (clock.state === 'overdue') { open.overdue += 1; bySeverity[finding.severity].overdue += 1; }
          else if (clock.state === 'due-soon') { open.dueSoon += 1; bySeverity[finding.severity].dueSoon += 1; }
          else open.onTrack += 1;
          const days = Math.floor((now - Date.parse(finding.first_seen_at)) / (24 * 60 * 60 * 1000));
          if (!oldest || days > oldest.days) oldest = { days, findingId: finding.finding_id, rule: finding.rule, severity: finding.severity };
        }
        /* A branch audited twice resolved what the first saw and the second did not: one fix, timed. */
        const kept = state.auditHistory.filter(entry => entry.row.ref_name === ref);
        if (kept.length > 1) {
          const [current, before] = kept;
          const gone = before.findings.filter(row => !current.findings.some(still => still.finding_id === row.finding_id) && mttr[row.severity]);
          for (const row of gone) {
            const days = Math.round((Date.parse(current.row.audited_at) - Date.parse(row.first_seen_at)) / 864e5 * 10) / 10;
            for (const key of [row.severity, 'all']) {
              const entry = mttr[key];
              entry.meanDays = Math.round((((entry.meanDays || 0) * entry.count) + days) / (entry.count + 1) * 10) / 10;
              entry.medianDays = entry.meanDays;
              entry.count += 1;
            }
          }
        }
        return fulfill({ available: true, ref, audit: { id: latest.row.audit_id, auditedAt: latest.row.audited_at, commitSha: latest.row.commit_sha },
          sla: { ...sla, source: latest.row.policy_source || 'default' }, open, oldest, mttr, triage: triage.summary, triageUnavailable: false });
      }
      if (rest === 'history' && method === 'GET') {
        const kept = state.auditHistory.filter(entry => entry.row.ref_name === ref);
        const branches = [...new Set(state.auditHistory.map(entry => entry.row.ref_name))].map(name => {
          const of = state.auditHistory.filter(entry => entry.row.ref_name === name);
          return { ref: name, audits: of.length, lastAt: of[0].row.audited_at };
        });
        return fulfill({ available: true, ref, audits: kept.map(entry => serialize.audit(entry.row)), branches });
      }
      if (rest === 'watch' && method === 'GET') {
        const latest = state.auditHistory.find(entry => entry.row.ref_name === ref);
        if (!latest) return fulfill({ available: true, ref, audit: null, alerts: [], components: 0, fresh: false, checkableAt: null });
        const force = url.searchParams.get('refresh') === '1';
        const fresh = force || !latest.watched;
        if (fresh) {
          await new Promise(resolve => setTimeout(resolve, 250));
          Object.assign(latest.row, { watch_checked_at: new Date().toISOString(), watch_state: 'ok', watch_checked: latest.components.length, watch_total: latest.components.length, watch_kev: 'ok' });
          latest.alerts = scenario.auditWatchAlerts.map(alert => ({ ...alert, firstSeenAt: alert.firstSeenAt || new Date().toISOString() }));
          latest.watched = true;
        }
        state.watchChecks = (state.watchChecks || 0) + (fresh ? 1 : 0);
        return fulfill({
          available: true, ref, audit: serialize.audit(latest.row), alerts: latest.alerts, components: latest.components.length, fresh,
          // Match the production cooldown; a one-second fixture expires while
          // the page is being inspected and makes this assertion race the CPU.
          checkableAt: new Date(Date.parse(latest.row.watch_checked_at) + 10 * 60 * 1000).toISOString()
        });
      }
      if (rest === 'history/clear' && method === 'POST') {
        const body = JSON.parse(request.postData() || '{}');
        if (body.confirm !== 'clear-audit-history') return fulfill(publicError('CODE_AUDIT_CLEAR_UNCONFIRMED', 'Clearing audit history requires an explicit confirmation'), 400);
        const cleared = state.auditHistory.length;
        state.auditHistory = [];
        return fulfill({ cleared }, 201);
      }
      const one = /^history\/([0-9a-f-]{36})$/.exec(rest);
      if (one && method === 'GET') {
        const entry = state.auditHistory.find(item => item.row.audit_id === one[1]);
        if (!entry) return fulfill(publicError('CODE_AUDIT_NOT_FOUND', 'That audit is not kept for this repository'), 404);
        const order = { critical: 0, serious: 1, warning: 2 };
        return fulfill({ audit: serialize.audit(entry.row), findings: entry.findings.map(serialize.finding).sort((a, b) => order[a.severity] - order[b.severity]) });
      }
    }
    if (pathname === '/api/code-audit/score' && method === 'POST') {
      const body = JSON.parse(request.postData() || '{}');
      if (!Array.isArray(body.findings)) return fulfill(publicError('CODE_AUDIT_SCORE_INVALID', 'findings are required'), 400);
      return fulfill(triageModule.rescore(body.findings));
    }
    if (pathname === '/api/repo/sandbox/demo/code-audit' && method === 'GET' && !url.searchParams.get('run')) {
      state.auditRun = `run-${(state.audits || 0) + 1}`;
      return fulfill({ state: 'running', run: state.auditRun, stage: 'reading', done: 3, total: 7, position: null, limit: null, elapsedMs: 40 }, 202);
    }
    if (pathname === '/api/repo/sandbox/demo/code-audit' && method === 'GET') {
      if (url.searchParams.get('run') !== state.auditRun) {
        return fulfill({ error: 'This audit is no longer held by the server. It may have restarted. Run the audit again.', code: 'AUDIT_RUN_GONE' }, 404);
      }
      state.audits = (state.audits || 0) + 1;
      const { analyse } = require('../../src/code-audit');
      /* A remote database password, built in pieces so no scanner mistakes the fixture for a leak. */
      const databaseUrl = ['postgres://app:', 'Tr0ub4dor-and-3', '@db.demo-prod.example.com:5432/app'].join('');
      /*
       * An Express router: a read behind a sign-in whose SQL splices the id
       * (parameterised by the second audit), and a write nobody guards.
       */
      const query = state.audits === 1
        ? 'db.query(`SELECT * FROM users WHERE id = ${req.params.id}`)'
        : "db.query('SELECT * FROM users WHERE id = $1', [req.params.id])";
      const usersRouter = [
        "const express = require('express');",
        'const router = express.Router();',
        "router.get('/users/:id', requireAuth, async (req, res) => {",
        `  const rows = await ${query};`,
        '  res.json(rows);',
        '});',
        "router.post('/users', async (req, res) => {",
        '  const user = await User.create(req.body);',
        '  res.json(user);',
        '});',
        'module.exports = router;',
        ''
      ].join('\n');
      const files = [
        { path: 'README.md', text: '# demo\n' },
        { path: 'package.json', text: JSON.stringify({ name: 'demo', scripts: { build: 'vite build' }, dependencies: { react: '*', lodash: '^4.17.0' }, devDependencies: { crossenv: '^1.0.0' } }, null, 2) },
        { path: 'package-lock.json', text: JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'demo' }, 'node_modules/react': { version: '18.2.0' }, 'node_modules/lodash': { version: '4.17.15' }, 'node_modules/crossenv': { version: '1.0.0', dev: true } } }, null, 2) },
        { path: 'server.js', text: 'app.post("/api/login", handler);\napp.use(cors({ origin: true, credentials: true }));\n' },
        { path: 'deploy/production.yml', text: `env:\n  DATABASE_URL: ${databaseUrl}\n` },
        { path: 'supabase/migrations/20260101000000_init.sql', text: 'create table public.profiles (\n  id uuid primary key,\n  bio text\n);\n' },
        { path: 'api/users.js', text: usersRouter }
      ];
      if (scenario.auditStack === 'polyglot') {
        /* A Go service, a Spring controller and a Laravel app, each with a flaw the tracer follows and endpoints of its own. */
        files.push(
          { path: 'services/files/main.go', text: [
            'package main', '', 'import (', '\t"net/http"', '\t"os"', '\t"github.com/gin-gonic/gin"', ')', '',
            'func main() {', '\tr := gin.Default()', '\tadmin := r.Group("/admin", AuthRequired())',
            '\tadmin.DELETE("/files/:name", removeFile)', '\tr.GET("/files/download", download)', '\tr.Run()', '}', '',
            'func download(c *gin.Context) {', '\tname := c.Query("name")', '\tdata, _ := os.ReadFile("/srv/files/" + name)', '\tc.Data(200, "application/octet-stream", data)', '}', '',
            'func removeFile(c *gin.Context) {', '\tos.Remove("/srv/files/" + c.Param("name"))', '}', ''
          ].join('\n') },
          { path: 'services/accounts/src/main/java/com/demo/AccountController.java', text: [
            'package com.demo;', '', 'import org.springframework.web.bind.annotation.*;', '',
            '@RestController', '@RequestMapping("/api/accounts")', 'public class AccountController {',
            '  @GetMapping("/search")', '  public List<Account> search(@RequestParam String name) {',
            '    return jdbcTemplate.query("SELECT * FROM accounts WHERE name = \'" + name + "\'", mapper);', '  }', '',
            '  @PreAuthorize("hasRole(\'ADMIN\')")', '  @DeleteMapping("/{id}")', '  public void remove(@PathVariable Long id) {', '    repository.deleteById(id);', '  }', '}', ''
          ].join('\n') },
          { path: 'web/routes/web.php', text: [
            '<?php', 'use App\\Http\\Controllers\\PostController;', 'use Illuminate\\Support\\Facades\\Route;', '',
            "Route::match(['post', 'put'], '/posts', [PostController::class, 'save']);",
            "Route::middleware('auth')->group(function () {", "    Route::delete('/posts/{id}', [PostController::class, 'destroy']);", '});', ''
          ].join('\n') },
          { path: 'web/app/Http/Controllers/PostController.php', text: [
            '<?php', 'namespace App\\Http\\Controllers;', '', 'class PostController extends Controller', '{',
            '    public function save(Request $request)', '    {', '        return Post::create($request->all());', '    }', '',
            '    public function destroy($id)', '    {', '        return Post::where(\'user_id\', auth()->id())->findOrFail($id)->delete();', '    }', '}', ''
          ].join('\n') }
        );
      }
      const advisories = new Map([
        ['npm:react@18.2.0', { advisories: [] }],
        ['npm:crossenv@1.0.0', { advisories: [] }],
        ['npm:lodash@4.17.15', { advisories: [
          { id: 'GHSA-35jh-r3h4-6jhm', cve: 'CVE-2021-23337', rated: true, severity: 'serious', summary: 'Command Injection in lodash', fixed: '4.17.21', malicious: false },
          { id: 'GHSA-p6mc-m468-83gw', cve: 'CVE-2020-8203', rated: true, severity: 'serious', summary: 'Prototype Pollution in lodash', fixed: '4.17.19', malicious: false }
        ] }]
      ]);
      /* What FIRST and CISA answered for those CVEs: scored, and neither in the exploited catalog. */
      const intel = new Map([
        ['CVE-2021-23337', { epss: 0.21333, percentile: 0.97527, epssDate: '2026-09-28', kev: null }],
        ['CVE-2020-8203', { epss: 0.05213, percentile: 0.92215, epssDate: '2026-09-28', kev: null }]
      ]);
      /*
       * What deps.dev answered for each version's licence: permissive for
       * what ships and a copyleft development tool, which is listed but never
       * reported; the copyleft scenario makes lodash network copyleft.
       */
      const licences = new Map([
        ['npm:react@18.2.0', { value: 'MIT', source: 'deps.dev' }],
        ['npm:lodash@4.17.15', { value: scenario.licences === 'copyleft' ? 'AGPL-3.0-only' : 'MIT', source: 'deps.dev' }],
        ['npm:crossenv@1.0.0', { value: 'GPL-3.0-only', source: 'deps.dev' }]
      ]);
      const result = analyse({ files, paths: files.map(file => file.path), advisories, licences, intel });
      const finished = {
        ...result,
        commitSha: HEAD_SHA,
        ref: 'main',
        auditedAt: new Date().toISOString(),
        coverage: {
          treeTruncated: false, filesInTree: files.length, eligible: files.length - 1, read: files.length - 1, unreadable: 0,
          skipped: { excluded: 0, oversize: 0, budget: 0 }, complete: true,
          packages: { declared: 3, checked: 3, unknown: 0, notChecked: 0 },
          advisories: { versions: 3, checked: 3, unknown: 0, notChecked: 0, vulnerable: 1, malicious: 0, lockfiles: 1, lockfilesRead: 1 },
          exploit: { cves: 2, asked: 2, kev: 'ok', kevVersion: '2026.09.27', kevCount: 1728, kevStale: false, epss: 'ok', scored: 2, unscored: 0 },
          licences: { versions: 3, fromLock: 0, asked: 3, answered: 3 }
        }
      };
      const decided = triageModule.applyTriage(finished, state.triage);
      if (scenario.auditHistory !== 'kept') return fulfill(decided);
      const { firstSeen, ...history } = recordAudit(decided);
      const sla = decided.policy && decided.policy.sla;
      const now = Date.now();
      const clocked = sla ? { ...decided, findings: decided.findings.map(finding => {
        const clock = clockOf({ severity: finding.severity, exploited: exploitedInProduction(finding) }, { firstSeenAt: firstSeen[finding.id], sla, now });
        return clock ? { ...finding, clock } : finding;
      }) } : decided;
      clocked.history = history;
      return fulfill(clocked);
    }
    /*
     * The provider's branch rules, read by the real module from the JSON
     * GitHub answers with for a reader without administration access: the
     * summary and a ruleset, the classic details hidden.
     */
    if (pathname === '/api/repo/sandbox/demo/branch-protection' && method === 'GET') {
      const { readBranchProtection } = require('../../src/branch-protection');
      const routes = {
        '': { default_branch: 'main' },
        '/branches/main': { protected: true, protection: { required_status_checks: { contexts: ['ci'] } } },
        '/rules/branches/main': [
          { type: 'pull_request', ruleset_id: 3, parameters: { required_approving_review_count: 1 } },
          { type: 'non_fast_forward', ruleset_id: 3 },
          { type: 'deletion', ruleset_id: 3 }
        ]
      };
      const read = async apiPath => {
        if (apiPath in routes) return routes[apiPath];
        throw Object.assign(new Error('Not Found'), { status: apiPath.endsWith('/protection') ? 403 : 404 });
      };
      return fulfill(await readBranchProtection({ provider: 'github', owner: 'sandbox', repo: 'demo', branch: url.searchParams.get('branch') || '', read, webBase: 'https://github.com' }));
    }
    /*
     * The deployed-site check, by the real rules over a modelled site: the
     * first check finds a bare site serving its .env; by the second the
     * headers are sent, the file is gone, and / redirects to the app.
     */
    /*
     * The site check, as the server runs it: a job the page starts and then
     * asks after, and a result computed by the real engine over a small
     * flawed site that is fixed by the second check. The same answer serves
     * the repository's Audit tab and the Website page.
     */
    if ((pathname === '/api/repo/sandbox/demo/site-check' || pathname === '/api/site-check') && method === 'GET') {
      const { checkSite, siteOrigin } = require('../../src/site-check');
      const run = url.searchParams.get('run');
      if (!run) {
        try { siteOrigin(url.searchParams.get('url')); }
        catch (error) { return fulfill({ error: error.message, code: error.code }, error.status || 400); }
        state.siteChecks = (state.siteChecks || 0) + 1;
        state.siteRun = `site-${state.siteChecks}`;
        state.sitePolls = 0;
        state.siteAsked = url.searchParams.get('url');
        return fulfill({ state: 'running', run: state.siteRun, stage: 'page', done: 0, total: 0, position: null, limit: null, elapsedMs: 10 }, 202);
      }
      if (run !== state.siteRun) return fulfill({ error: 'This site check is no longer held by the server. It may have restarted. Check the site again.', code: 'SITE_CHECK_RUN_GONE' }, 404);
      state.sitePolls += 1;
      if (state.sitePolls === 1) return fulfill({ state: 'running', run, stage: 'scripts', done: 2, total: 5, position: null, limit: null, elapsedMs: 1800 }, 202);
      const fixed = state.siteChecks > 1;
      const headers = fixed ? {
        'content-type': 'text/html',
        'strict-transport-security': 'max-age=31536000; includeSubDomains',
        'content-security-policy': "default-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'",
        'cross-origin-opener-policy': 'same-origin',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'strict-origin-when-cross-origin'
      } : { 'content-type': 'text/html', 'x-powered-by': 'Express', 'set-cookie': ['sid=x; Path=/'] };
      const landing = fixed
        ? '<!doctype html><html><body><a href="/pricing">Pricing</a><script src="/assets/app.js"></script></body></html>'
        : '<!doctype html><html><body><a href="/pricing">Pricing</a><script src="/assets/app.js"></script><script src="https://code.jquery.com/jquery-1.12.4.min.js"></script></body></html>';
      const transport = async input => {
        const target = new URL(input.url);
        if (input.plainHttp) return { statusCode: 301, headers: { location: `https://${target.host}/` }, body: '' };
        const path = target.pathname;
        if (path === '/' && fixed) return { statusCode: 302, headers: { location: '/app' }, body: '' };
        if (path === '/' || path === '/app') {
          return { statusCode: 200, headers, body: landing, tls: { protocol: 'TLSv1.3', validTo: new Date(Date.now() + 74.5 * 86_400_000).toISOString(), issuer: 'Let’s Encrypt' } };
        }
        if (path === '/pricing') return { statusCode: 200, headers: { 'content-type': 'text/html' }, body: '<!doctype html><html><body>Plans</body></html>' };
        if (path === '/assets/app.js') return { statusCode: 200, headers: { 'content-type': 'application/javascript' }, body: `console.log("app");\n${fixed ? '' : '//# sourceMappingURL=app.js.map'}` };
        if (path === '/assets/app.js.map' && !fixed) return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: '{"version":3,"sources":["src/app.ts"],"mappings":"AAAA"}' };
        if (path === '/.env' && !fixed) return { statusCode: 200, headers: { 'content-type': 'text/plain' }, body: 'SECRET_KEY=x\n' };
        if (path === '/.well-known/security.txt' && fixed) return { statusCode: 200, headers: { 'content-type': 'text/plain' }, body: 'Contact: mailto:security@example.com\nExpires: 2099-01-01T00:00:00Z\n' };
        return { statusCode: 404, headers: { 'content-type': 'text/html' }, body: '<h1>Not found</h1>' };
      };
      const advisoryTransport = async input => {
        if (input.method === 'POST') {
          const queries = JSON.parse(input.body).queries;
          return { statusCode: 200, body: JSON.stringify({ results: queries.map(query => ({ vulns: query.package.name === 'jquery' ? [{ id: 'GHSA-gxr4-xjj5-5px2' }, { id: 'GHSA-rmxg-73gg-4p98' }] : [] })) }) };
        }
        const id = decodeURIComponent(new URL(input.url).pathname.split('/').pop());
        return { statusCode: 200, body: JSON.stringify({ id, aliases: [id === 'GHSA-gxr4-xjj5-5px2' ? 'CVE-2020-11022' : 'CVE-2015-9251'], database_specific: { severity: 'MODERATE' }, affected: [{ package: { ecosystem: 'npm', name: 'jquery' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: id === 'GHSA-gxr4-xjj5-5px2' ? '3.5.0' : '3.0.0' }] }] }] }) };
      };
      const txt = async name => (name.startsWith('_dmarc.') ? (fixed ? ['v=DMARC1; p=reject'] : []) : ['v=spf1 include:_spf.example.net -all']);
      try {
        return fulfill({ ...(await checkSite({ url: state.siteAsked, transport, advisoryTransport, txt })), checkedAt: new Date().toISOString() });
      } catch (error) {
        return fulfill({ error: error.message, code: error.code }, error.status || 400);
      }
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
  await page.locator('#stageCommitBtn').click();
  await page.getByRole('dialog', { name: 'Review staged changes', exact: true }).getByRole('button', { name: 'Commit 1 change', exact: true }).click();
}

module.exports = {
  HEAD_SHA,
  mockPublicAlphaApi,
  openConnectedRepository,
  startNewFileAction
};
