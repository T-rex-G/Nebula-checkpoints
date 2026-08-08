'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { hashJson } = require('../src/intelligence');
const {
  createCsrfToken,
  createStepUpGrant,
  normalizeStepUpRequest,
  scopeHash
} = require('../src/security-foundation');

const root = path.resolve(__dirname, '..');
const port = 31800 + Math.floor(Math.random() * 800);
const secret = 'alpha-boundary-test-secret-0123456789abcdef-0123456789abcdef';
const key = crypto.createHash('sha256').update(secret).digest();
const termsVersion = '2026-07-30';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-alpha-server-boundary-'));
const fixture = path.join(tmp, 'fixture.js');
const eventLog = path.join(tmp, 'events.log');
const alphaStateFile = path.join(tmp, 'alpha-state.json');
const sessionNonce = 'a'.repeat(48);
const webhookId = 'b'.repeat(32);
const webhookSecret = 'alpha-live-stream-webhook-secret';

function seal(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(value), 'utf8'),
    cipher.final()
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}

function account(provider, baseUrl) {
  return {
    provider,
    baseUrl,
    login: 'fixture-user',
    avatar: '',
    authMethod: 'token',
    token: `fixture-${provider}-token`
  };
}

function githubAppAccount() {
  return {
    ...account('github', ''),
    authMethod: 'github-app',
    token: '',
    installationId: 4242,
    installationAccountId: 4343
  };
}

const accounts = Object.freeze({
  github: account('github', ''),
  gitlab: account('gitlab', 'https://gitlab.com'),
  gitlabPath: account('gitlab', 'https://gitlab.com/root'),
  gitea: account('gitea', 'https://gitea.example'),
  giteaPath: account('gitea', 'https://gitea.example/root'),
  githubApp: githubAppAccount()
});

function identityKey(selectedAccount) {
  return hashJson({
    provider: selectedAccount.provider,
    baseUrl: selectedAccount.baseUrl,
    login: selectedAccount.login
  });
}

function providerSession(selectedAccount, stepUp = null) {
  return seal({
    accounts: [selectedAccount],
    active: 0,
    security: { sessionNonce, stepUp },
    safety: {
      readOnly: false,
      freezeSync: false,
      protected: {
        'Acme/Demo': ['allowed.txt'],
        'Acme/Production': ['private.txt']
      }
    }
  });
}

const appDeleteOperation = normalizeStepUpRequest(
  'repository.delete',
  { owner: 'acme', repo: 'demo' },
  { provider: 'github', identityKey: identityKey(accounts.githubApp) }
);
const appDeleteJti = crypto.randomUUID();
const appDeleteStepUp = {
  jti: appDeleteJti,
  action: appDeleteOperation.action,
  scopeHash: scopeHash(appDeleteOperation.scope),
  expiresAt: Date.now() + 300000,
  assurance: 'github-app'
};
const appDeleteGrant = createStepUpGrant(secret, {
  sessionBinding: sessionNonce,
  identityKey: identityKey(accounts.githubApp),
  action: appDeleteOperation.action,
  scope: appDeleteOperation.scope,
  assurance: 'github-app'
}, { jti: appDeleteJti, ttlMs: 300000 });

const providerSessions = {
  'provider-github': providerSession(accounts.github),
  'provider-gitlab': providerSession(accounts.gitlab),
  'provider-gitlab-path': providerSession(accounts.gitlabPath),
  'provider-gitea': providerSession(accounts.gitea),
  'provider-gitea-path': providerSession(accounts.giteaPath),
  'provider-app': providerSession(accounts.githubApp),
  'provider-app-delete': providerSession(accounts.githubApp, appDeleteStepUp)
};

const fixtureSource = String.raw`
'use strict';
const fs = require('fs');
const Module = require('module');
const originalLoad = Module._load;
const originalSetInterval = global.setInterval;
const eventLog = process.env.NV_ALPHA_TEST_EVENT_LOG;
const alphaStateFile = process.env.NV_ALPHA_TEST_STATE_FILE;
const sessions = new Map(Object.entries(JSON.parse(process.env.NV_ALPHA_TEST_PROVIDER_SESSIONS || '{}')));
const sessionRevisions = new Map([...sessions.keys()].map(sid => [sid, 0]));

global.setInterval = function acceleratedLiveValidation(callback, delay, ...args) {
  return originalSetInterval(callback, delay === 15000 ? 5 : delay, ...args);
};

function record(event) {
  fs.appendFileSync(eventLog, JSON.stringify(event) + '\n');
}

function accessError(message, code, status) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function alphaState(letter) {
  const state = JSON.parse(fs.readFileSync(alphaStateFile, 'utf8'));
  return state[letter] || 'active';
}

function activeSession(letter) {
  const scopes = {
    A: ['github:github.com/acme/demo'],
    E: ['gitlab:gitlab.com/acme/demo'],
    F: ['gitea:gitea.example/acme/demo'],
    P: ['gitea:gitea.example/acme/demo'],
    Q: ['gitlab:gitlab.com/acme/demo']
  }[letter];
  if (!scopes) throw accessError('Alpha access is required', 'ALPHA_ACCESS_REQUIRED', 401);
  return {
    testerId: '10000000-0000-4000-8000-000000000001',
    testerLabel: 'Invited tester',
    repositoryScopes: scopes,
    termsVersion: process.env.NV_ALPHA_TERMS_VERSION,
    expiresAt: '2026-08-05T12:00:00.000Z'
  };
}

class AlphaAccessStore {
  constructor() {}

  async redeemInvite(input) {
    record({ kind: 'alpha.redeem', input });
    if (input.code === 'valid-invitation' && input.termsVersion === process.env.NV_ALPHA_TERMS_VERSION) {
      return {
        tester: activeSession('A'),
        sessionId: 'A'.repeat(43),
        expiresAt: '2026-08-05T12:00:00.000Z'
      };
    }
    if (input.code === 'locked-invitation') {
      throw accessError('raw lock detail must stay private', 'ALPHA_REDEMPTION_LOCKED', 403);
    }
    if (input.code === 'operational-invitation') {
      throw new Error('raw database detail and secret nvx_alpha_private');
    }
    throw accessError('generic store rejection', 'ALPHA_INVITE_REJECTED', 403);
  }

  async readSession(sessionId, options = {}) {
    const letter = String(sessionId || '').slice(0, 1);
    const state = alphaState(letter);
    record({
      kind: 'alpha.read',
      sessionId,
      touch: options.touch !== false,
      state
    });
    if (letter === 'B' || state === 'expired') {
      throw accessError('raw expiry detail', 'ALPHA_SESSION_EXPIRED', 401);
    }
    if (letter === 'C' || state === 'revoked') {
      throw accessError('raw revocation detail', 'ALPHA_ACCESS_REVOKED', 403);
    }
    if (letter === 'D' || state === 'operational') {
      const error = new Error('raw driver failure with secret');
      error.code = 'RAW_DATABASE_SECRET';
      error.status = 418;
      throw error;
    }
    return activeSession(letter);
  }
}

class AlphaPrivacyStore {
  constructor(options) {
    this.sessionCodec = options.sessionCodec;
  }

  async readHostedProviderSession(input) {
    record({ kind: 'privacy.read', testerId: input.testerId, sessionId: input.sessionId });
    const data = sessions.get(String(input.sessionId));
    if (!data) throw accessError('Provider session unavailable', 'ALPHA_PROVIDER_SESSION_UNAVAILABLE', 401);
    return {
      session: this.sessionCodec.decode(data),
      revision: sessionRevisions.get(String(input.sessionId)) || 0
    };
  }

  async mutateHostedProviderSession(input) {
    const sid = String(input.sessionId);
    const data = sessions.get(sid);
    if (!data) throw accessError('Provider session unavailable', 'ALPHA_PROVIDER_SESSION_UNAVAILABLE', 401);
    const revision = sessionRevisions.get(sid) || 0;
    const next = await input.mutate(this.sessionCodec.decode(data), { revision, attempt: 0 });
    sessions.set(sid, this.sessionCodec.encode(next));
    sessionRevisions.set(sid, revision + 1);
    return { session: next, revision: revision + 1 };
  }

  async connectHostedProviderAccount(input) {
    const sid = String(input.sessionId);
    const session = { accounts: [input.account], active: 0 };
    sessions.set(sid, this.sessionCodec.encode(session));
    sessionRevisions.set(sid, 0);
    return { session, revision: 0 };
  }

  async createCleanupTask(input) {
    record({ kind: 'privacy.cleanup.create', input });
    return {
      cleanupId: '70000000-0000-4000-8000-000000000001',
      status: 'pending'
    };
  }

  async inspectProviderWebhookCleanup(input) {
    record({ kind: 'privacy.cleanup.inspect', input });
    throw accessError(
      'Provider webhook ownership could not be verified',
      'ALPHA_PROVIDER_WEBHOOK_OWNERSHIP_CONFLICT',
      409
    );
  }

  async completeProviderWebhookCleanup(input) {
    record({ kind: 'privacy.cleanup.complete', input });
    return { verified: true, shared: false, localRemoved: true };
  }
}

class Pool {
  async connect() {
    return {
      query: this.query.bind(this),
      release() {}
    };
  }

  async query(sql, params = []) {
    const normalized = String(sql).replace(/\s+/g, ' ').trim();
    if (normalized.startsWith('SELECT 1 FROM nv_sessions WHERE sid=')) {
      const data = sessions.get(String(params[0]));
      return { rows: data ? [{ ok: 1 }] : [], rowCount: data ? 1 : 0 };
    }
    if (normalized.startsWith('SELECT data FROM nv_sessions WHERE sid=')) {
      const data = sessions.get(String(params[0]));
      return { rows: data ? [{ data }] : [], rowCount: data ? 1 : 0 };
    }
    if (normalized.startsWith('INSERT INTO nv_sessions')) {
      record({ kind: 'session.write', sid: String(params[0]) });
      sessions.set(String(params[0]), String(params[1]));
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith('INSERT INTO nv_security_state')) {
      record({ kind: 'safety.write' });
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith('INSERT INTO nv_evidence_chain')) {
      record({ kind: 'evidence.write' });
      return { rows: [{ seq: 1, created_at: new Date().toISOString() }], rowCount: 1 };
    }
    if (normalized.startsWith('SELECT hook_id,owner,repo,identity_key,secret_enc,active FROM nv_webhooks')) {
      return {
        rows: [{
          hook_id: process.env.NV_ALPHA_TEST_WEBHOOK_ID,
          owner: 'Acme',
          repo: 'Demo',
          identity_key: process.env.NV_ALPHA_TEST_WEBHOOK_IDENTITY,
          secret_enc: process.env.NV_ALPHA_TEST_WEBHOOK_SECRET_ENC,
          active: true
        }],
        rowCount: 1
      };
    }
    if (normalized.startsWith('SELECT hook_id,provider_hook_id,alpha_resource_key_hash FROM nv_webhooks')) {
      return {
        rows: [{
          hook_id: process.env.NV_ALPHA_TEST_WEBHOOK_ID,
          provider_hook_id: 'upgrade-provider-hook-91',
          alpha_resource_key_hash: null
        }],
        rowCount: 1
      };
    }
    if (normalized.startsWith('UPDATE nv_webhooks SET alpha_resource_key_hash=')) {
      record({
        kind: 'webhook.hash.backfill',
        resourceKeyHash: String(params[0]),
        hookId: String(params[1])
      });
      return { rows: [{ alpha_resource_key_hash: params[0] }], rowCount: 1 };
    }
    if (normalized.startsWith('DELETE FROM nv_webhooks WHERE hook_id=')) {
      record({ kind: 'webhook.local.delete', hookId: String(params[0]) });
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith('SELECT state FROM nv_security_state')) {
      return { rows: [], rowCount: 0 };
    }
    if (normalized.startsWith('INSERT INTO nv_intelligence_events')) {
      record({ kind: 'repository.event', eventId: String(params[0]) });
      return {
        rows: [{ created_at: new Date().toISOString() }],
        rowCount: 1
      };
    }
    if (normalized.startsWith('DELETE FROM nv_sessions WHERE sid=')) {
      return { rows: [], rowCount: sessions.delete(String(params[0])) ? 1 : 0 };
    }
    if (normalized === 'SELECT 1') return { rows: [{ ok: 1 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }

  async end() {}
}

Module._load = function load(request, parent, isMain) {
  if (request === './src/alpha-access-store' && parent && /server\.js$/.test(parent.filename)) {
    return { AlphaAccessStore };
  }
  if (request === './src/alpha-privacy-store' && parent && /server\.js$/.test(parent.filename)) {
    return { AlphaPrivacyStore };
  }
  if (request === './src/provider-credentials' && parent && /server\.js$/.test(parent.filename)) {
    return {
      async resolveProviderAccount(account) {
        record({ kind: 'credential.resolve', authMethod: account && account.authMethod });
        if (account && account.authMethod === 'github-app') {
          record({ kind: 'installation.lookup', installationId: account.installationId });
          record({ kind: 'token.mint', installationId: account.installationId });
          return { ...account, token: 'uncached-fixture-installation-token' };
        }
        return { ...account };
      }
    };
  }
  if (request === './src/migrations' && parent && /server\.js$/.test(parent.filename)) {
    return { runMigrations: async () => ({ applied: [], total: 0 }) };
  }
  if (request === './src/governance-webhook-worker' && parent && /server\.js$/.test(parent.filename)) {
    return { startWebhookWorker: () => ({ stop() {} }) };
  }
  if (request === 'pg') return { Pool };
  if (request === 'dns') {
    return { promises: { lookup: async () => [{ address: '93.184.216.34', family: 4 }] } };
  }
  return originalLoad.call(this, request, parent, isMain);
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

global.fetch = async function providerFetch(url, options = {}) {
  const href = String(url);
  record({ kind: 'provider.fetch', method: options.method || 'GET', url: href });
  if (/\/api\/v4\/user$/.test(href)) {
    return jsonResponse({ username: 'fixture-user', name: 'Fixture', avatar_url: '' });
  }
  if (/\/api\/v4\/projects\?/.test(href)) {
    return jsonResponse([
      {
        path_with_namespace: 'Acme/Demo',
        path: 'Demo',
        namespace: { full_path: 'Acme' },
        visibility: 'private',
        default_branch: 'main',
        last_activity_at: '2026-07-30T00:00:00.000Z',
        description: 'allowed',
        star_count: 1
      },
      {
        path_with_namespace: 'Acme/Production',
        path: 'Production',
        namespace: { full_path: 'Acme' },
        visibility: 'private',
        default_branch: 'main',
        last_activity_at: '2026-07-30T00:00:00.000Z',
        description: 'not allowed',
        star_count: 2
      }
    ]);
  }
  if (/\/api\/v1\/user\/repos\?/.test(href)) {
    return jsonResponse([
      {
        full_name: 'Acme/Demo',
        name: 'Demo',
        owner: { login: 'Acme' },
        private: true,
        default_branch: 'main'
      },
      {
        full_name: 'Acme/Production',
        name: 'Production',
        owner: { login: 'Acme' },
        private: true,
        default_branch: 'main'
      }
    ]);
  }
  if (/api\.github\.com\/user$/.test(href)) {
    return jsonResponse({ login: 'fixture-user', name: 'Fixture', avatar_url: '' });
  }
  if (/api\.github\.com\/user\/repos\?/.test(href)) {
    return jsonResponse([
      {
        full_name: 'Acme/Demo',
        name: 'Demo',
        owner: { login: 'Acme' },
        private: true,
        default_branch: 'main'
      },
      {
        full_name: 'Acme/Production',
        name: 'Production',
        owner: { login: 'Acme' },
        private: true,
        default_branch: 'main'
      }
    ]);
  }
  if (/api\.github\.com\/notifications\?/.test(href)) {
    return jsonResponse([{
      id: 'notification-1',
      reason: 'security_alert',
      unread: true,
      updated_at: '2026-07-30T00:00:00.000Z',
      subject: { title: 'Private production incident', type: 'Issue' },
      repository: {
        full_name: 'Acme/Production',
        html_url: 'https://github.com/Acme/Production'
      }
    }]);
  }
  if (/api\.github\.com\/search\/code\?/.test(href)) {
    return jsonResponse({
      items: [{ name: 'README.md', path: 'README.md', repository: { full_name: 'Acme/Demo' } }]
    });
  }
  return jsonResponse({ message: 'unexpected provider fixture URL: ' + href }, 500);
};
`;

fs.writeFileSync(fixture, fixtureSource, { mode: 0o600 });
fs.writeFileSync(eventLog, '', { mode: 0o600 });
fs.writeFileSync(alphaStateFile, JSON.stringify({ A: 'active' }), { mode: 0o600 });

const child = spawn(process.execPath, ['-r', fixture, 'server.js'], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    NODE_ENV: 'production',
    SESSION_SECRET: secret,
    DATABASE_URL: 'postgresql://alpha:test@db.example.test/alpha?sslmode=verify-full',
    NV_ALPHA_ACCESS_MODE: 'invite',
    NV_ALPHA_INVITE_PEPPER: 'alpha-test-pepper-0123456789abcdef-0123456789abcdef',
    NV_ALPHA_TERMS_VERSION: termsVersion,
    NV_GIT_HOST_ALLOWLIST: 'gitlab.com,gitea.example',
    NV_ALPHA_TEST_EVENT_LOG: eventLog,
    NV_ALPHA_TEST_STATE_FILE: alphaStateFile,
    NV_ALPHA_TEST_WEBHOOK_ID: webhookId,
    NV_ALPHA_TEST_WEBHOOK_IDENTITY: identityKey(accounts.github),
    NV_ALPHA_TEST_WEBHOOK_SECRET_ENC: seal({ secret: webhookSecret }),
    NV_ALPHA_TEST_PROVIDER_SESSIONS: JSON.stringify(providerSessions)
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let logs = '';
child.stdout.on('data', chunk => { logs += chunk.toString(); });
child.stderr.on('data', chunk => { logs += chunk.toString(); });

function alphaCookie(letter) {
  return `nv_alpha_access=${seal({ alphaSid: letter.repeat(43) })}`;
}

function providerCookie(sid) {
  return `nv_session=${seal({ sid })}`;
}

function combinedCookie(letter, sid) {
  return `${alphaCookie(letter)}; ${providerCookie(sid)}`;
}

function events(kind) {
  const text = fs.readFileSync(eventLog, 'utf8').trim();
  if (!text) return [];
  return text.split('\n').map(line => JSON.parse(line)).filter(event => event.kind === kind);
}

function transportEvents() {
  return [
    ...events('credential.resolve'),
    ...events('installation.lookup'),
    ...events('token.mint'),
    ...events('provider.fetch')
  ];
}

function setAlphaState(state) {
  fs.writeFileSync(alphaStateFile, JSON.stringify({ A: state }), { mode: 0o600 });
}

async function waitForCondition(predicate, description, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited while waiting for ${description}\n${logs}`);
    }
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${description}\n${logs}`);
}

function collectEventStream(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const stream = { text: '', done: false };

  return {
    stream,
    async waitFor(predicate, description, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      while (!predicate(stream)) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new Error(
            `Timed out waiting for ${description}; stream so far:\n${stream.text}\n${logs}`
          );
        }
        let timer;
        const result = await Promise.race([
          reader.read(),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`Timed out reading ${description}`)),
              remaining
            );
          })
        ]).finally(() => clearTimeout(timer));
        stream.done = result.done;
        if (result.value) stream.text += decoder.decode(result.value, { stream: true });
        if (result.done) stream.text += decoder.decode();
      }
      return stream.text;
    },
    async cancel() {
      if (!stream.done) await reader.cancel().catch(() => {});
    }
  };
}

async function sendRepositoryEvent(marker) {
  const body = JSON.stringify({
    ref: 'refs/heads/main',
    before: '0'.repeat(40),
    after: '1'.repeat(40),
    size: 1,
    distinct_size: 1,
    repository: {
      name: 'Demo',
      full_name: 'Acme/Demo',
      default_branch: 'main',
      owner: { login: 'Acme' }
    },
    sender: { login: 'fixture-sender' },
    commits: [{ added: [`${marker}.txt`], modified: [], removed: [] }]
  });
  const signature = crypto.createHmac('sha256', webhookSecret)
    .update(body)
    .digest('hex');
  return request(`/hooks/github/${webhookId}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': `sha256=${signature}`,
      'x-github-delivery': crypto.randomUUID(),
      'x-github-event': 'push'
    },
    body
  });
}

async function request(pathname, options = {}) {
  return fetch(`http://127.0.0.1:${port}${pathname}`, options);
}

async function json(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function waitForServer() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited early\n${logs}`);
    try {
      const response = await request('/healthz');
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not become ready\n${logs}`);
}

function postJson(body, headers = {}) {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-nv': '1',
      ...headers
    },
    body: JSON.stringify(body)
  };
}

function csrfFor(selectedAccount) {
  return createCsrfToken(secret, {
    sessionBinding: sessionNonce,
    identityKey: identityKey(selectedAccount)
  });
}

async function assertAlphaStreamTermination(state) {
  setAlphaState('active');
  const response = await request(
    '/api/repo/acme/demo/live-events/stream',
    { headers: { cookie: combinedCookie('A', 'provider-github') } }
  );
  const rejection = response.status === 200 ? '' : await response.clone().text();
  assert.strictEqual(response.status, 200, `SSE must open before ${state}: ${rejection}\n${logs}\n${fs.readFileSync(eventLog, 'utf8')}`);
  const collector = collectEventStream(response);
  try {
    await collector.waitFor(
      stream => stream.text.includes('event: ready'),
      `${state} stream readiness`
    );
    const activeMarker = `before-alpha-${state}`;
    const activeWebhook = await sendRepositoryEvent(activeMarker);
    assert.strictEqual(
      activeWebhook.status,
      202,
      `repository event before alpha ${state} must be accepted`
    );
    await collector.waitFor(
      stream => stream.text.includes(activeMarker),
      `${state} stream active repository event`
    );
    const liveEventsBeforeValidation = (
      collector.stream.text.match(/event: intelligence\n/g) || []
    ).length;
    assert.strictEqual(
      liveEventsBeforeValidation,
      1,
      'the open stream must receive the active-state repository event'
    );
    const readsBefore = events('alpha.read').length;
    setAlphaState(state);
    await waitForCondition(
      () => events('alpha.read').slice(readsBefore).some(event =>
        event.touch === false && event.state === state
      ),
      `non-touch alpha ${state} stream validation`
    );

    const marker = `after-alpha-${state}`;
    const webhook = await sendRepositoryEvent(marker);
    assert.strictEqual(
      webhook.status,
      202,
      `repository event after alpha ${state} validation must be accepted`
    );
    await collector.waitFor(
      stream => stream.done,
      `${state} stream closure`
    );
    assert.match(
      collector.stream.text,
      /event: alpha-access-ended\n/,
      `${state} must produce the safe alpha terminal event`
    );
    assert.strictEqual(
      (collector.stream.text.match(/event: intelligence\n/g) || []).length,
      liveEventsBeforeValidation,
      `${state} stream must not receive another repository event`
    );
    assert(
      !collector.stream.text.includes(marker),
      `${state} stream must not receive the post-validation marker`
    );
    assert(
      !collector.stream.text.includes('A'.repeat(43)),
      'the alpha session ID must not be exposed in SSE output'
    );
    const terminalEvent = collector.stream.text.slice(
      collector.stream.text.indexOf('event: alpha-access-ended')
    );
    assert(
      !/raw|secret|ALPHA_/i.test(terminalEvent),
      'the safe alpha terminal event must not expose store failure detail'
    );
  } finally {
    setAlphaState('active');
    await collector.cancel();
  }
}

(async () => {
  try {
    await waitForServer();

    for (const pathname of ['/healthz', '/readyz']) {
      const response = await request(pathname);
      assert.strictEqual(response.status, 200, `${pathname} must remain public`);
    }
    for (const pathname of [
      '/api/version',
      '/api/config',
      '/api/capabilities',
      '/api/alpha/status'
    ]) {
      const response = await request(pathname);
      assert.strictEqual(response.status, 200, `${pathname} must remain public`);
    }

    for (const pathname of [
      '/api/version',
      '/api/config',
      '/api/capabilities',
      '/api/alpha/status'
    ]) {
      const head = await request(pathname, { method: 'HEAD' });
      assert.strictEqual(head.status, 401, `HEAD ${pathname} must not inherit the GET alpha exemption`);
      const options = await request(pathname, { method: 'OPTIONS' });
      assert.strictEqual(options.status, 401, `OPTIONS ${pathname} must not inherit the alpha exemption`);
      assert.strictEqual((await json(options)).code, 'ALPHA_ACCESS_REQUIRED');
      const wrongMethod = await request(pathname, postJson({}));
      assert.strictEqual(wrongMethod.status, 401, `POST ${pathname} must not inherit the GET alpha exemption`);
      assert.strictEqual((await json(wrongMethod)).code, 'ALPHA_ACCESS_REQUIRED');
    }
    for (const [method, options] of [
      ['GET', {}],
      ['HEAD', { method: 'HEAD' }],
      ['OPTIONS', { method: 'OPTIONS' }]
    ]) {
      const response = await request('/api/alpha/redeem', options);
      assert.strictEqual(response.status, 401, `${method} /api/alpha/redeem must not inherit the POST exemption`);
      if (method !== 'HEAD') assert.strictEqual((await json(response)).code, 'ALPHA_ACCESS_REQUIRED');
    }

    const initialStatus = await request('/api/alpha/status');
    assert.deepStrictEqual(await json(initialStatus), {
      mode: 'invite',
      authenticated: false,
      termsVersion,
      testerLabel: null,
      repositoryScopes: [],
      expiresAt: null
    });

    const providerFetchesBeforeBlockedLogin = events('provider.fetch');
    const blockedLogin = await request('/api/login', postJson({
      token: 'fixture-login-token',
      provider: 'github'
    }));
    assert.strictEqual(blockedLogin.status, 401);
    assert.deepStrictEqual(await json(blockedLogin), {
      error: 'Alpha access is required',
      code: 'ALPHA_ACCESS_REQUIRED'
    });
    assert.deepStrictEqual(
      events('provider.fetch'),
      providerFetchesBeforeBlockedLogin,
      'provider login must not run before alpha admission'
    );

    const providerOnly = await request('/api/me', {
      headers: { cookie: providerCookie('provider-github') }
    });
    assert.strictEqual(providerOnly.status, 401);
    assert.strictEqual((await json(providerOnly)).code, 'ALPHA_ACCESS_REQUIRED');

    const alphaOnly = await request('/api/me', {
      headers: { cookie: alphaCookie('A') }
    });
    assert.strictEqual(alphaOnly.status, 401);
    assert.strictEqual((await json(alphaOnly)).code, 'AUTH_REQUIRED');

    const redeem = await request('/api/alpha/redeem', postJson({
      code: 'valid-invitation',
      acceptedTermsVersion: termsVersion
    }, { 'x-forwarded-for': '203.0.113.7' }));
    assert.strictEqual(redeem.status, 200);
    assert.deepStrictEqual(await json(redeem), {
      ok: true,
      testerLabel: 'Invited tester',
      repositoryScopes: ['github:github.com/acme/demo'],
      expiresAt: '2026-08-05T12:00:00.000Z'
    });
    const redeemCookie = redeem.headers.get('set-cookie') || '';
    for (const attribute of [
      /^nv_alpha_access=/,
      /;\s*HttpOnly/i,
      /;\s*Secure/i,
      /;\s*SameSite=Lax/i,
      /;\s*Path=\//i,
      /;\s*Max-Age=604800/i
    ]) {
      assert.match(redeemCookie, attribute, `alpha cookie missing ${attribute}`);
    }
    const redeemCalls = events('alpha.redeem');
    assert.deepStrictEqual(redeemCalls.at(-1).input, {
      code: 'valid-invitation',
      termsVersion,
      ip: '203.0.113.7'
    }, 'redeem must call the atomic store API directly with the accepted terms and request IP');

    const genericFailures = [
      { code: 'malformed', acceptedTermsVersion: termsVersion },
      { code: 'unknown-invitation', acceptedTermsVersion: termsVersion },
      { code: 'used-invitation', acceptedTermsVersion: termsVersion },
      { code: 'expired-invitation', acceptedTermsVersion: termsVersion },
      { code: 'revoked-invitation', acceptedTermsVersion: termsVersion },
      { code: 'valid-invitation', acceptedTermsVersion: '2026-07-29' }
    ];
    const genericBodies = [];
    for (const body of genericFailures) {
      const response = await request('/api/alpha/redeem', postJson(body));
      assert.strictEqual(response.status, 403);
      genericBodies.push(await json(response));
    }
    for (const body of genericBodies) {
      assert.deepStrictEqual(body, {
        error: 'Invitation could not be redeemed',
        code: 'ALPHA_INVITE_REJECTED'
      });
    }

    const locked = await request('/api/alpha/redeem', postJson({
      code: 'locked-invitation',
      acceptedTermsVersion: termsVersion
    }));
    assert.strictEqual(locked.status, 429);
    assert.deepStrictEqual(await json(locked), {
      error: 'Invitation could not be redeemed',
      code: 'ALPHA_REDEMPTION_LOCKED'
    });

    const operational = await request('/api/alpha/redeem', postJson({
      code: 'operational-invitation',
      acceptedTermsVersion: termsVersion
    }));
    assert.strictEqual(operational.status, 500);
    const operationalBody = await json(operational);
    assert.deepStrictEqual(operationalBody, {
      error: 'Alpha access operation could not be completed'
    });

    for (const [letter, status, code] of [
      ['B', 401, 'ALPHA_SESSION_EXPIRED'],
      ['C', 403, 'ALPHA_ACCESS_REVOKED']
    ]) {
      const response = await request('/api/me', {
        headers: { cookie: alphaCookie(letter) }
      });
      assert.strictEqual(response.status, status);
      assert.strictEqual((await json(response)).code, code);
      assert.match(response.headers.get('set-cookie') || '', /^nv_alpha_access=;/);
      assert.match(response.headers.get('set-cookie') || '', /Max-Age=0/i);
    }
    const boundaryOperational = await request('/api/me', {
      headers: { cookie: alphaCookie('D') }
    });
    assert.strictEqual(boundaryOperational.status, 500);
    assert.deepStrictEqual(await json(boundaryOperational), {
      error: 'Alpha access operation could not be completed'
    });
    const statusOperational = await request('/api/alpha/status', {
      headers: { cookie: alphaCookie('D') }
    });
    assert.strictEqual(statusOperational.status, 500);
    assert.deepStrictEqual(await json(statusOperational), {
      error: 'Alpha access operation could not be completed'
    });
    assert(!JSON.stringify(await json(
      await request('/api/alpha/status', {
        headers: { cookie: 'nv_alpha_access=not-a-sealed-cookie' }
      })
    )).match(/raw|secret|stack/i));

    for (const state of ['revoked', 'expired', 'operational']) {
      await assertAlphaStreamTermination(state);
    }

    const loginWithAlpha = await request('/api/login', postJson({
      token: 'fixture-login-token',
      provider: 'github'
    }, { cookie: alphaCookie('A') }));
    assert.strictEqual(loginWithAlpha.status, 200);
    assert.strictEqual((await json(loginWithAlpha)).login, 'fixture-user');

    const providerMutationsBeforeUnownedDelete = events('provider.fetch')
      .filter(event => event.method === 'DELETE').length;
    const unownedDelete = await request('/api/repo/acme/demo/live-events', {
      method: 'DELETE',
      headers: {
        cookie: combinedCookie('A', 'provider-github'),
        'x-nv': '1',
        'x-nv-csrf': csrfFor(accounts.github)
      }
    });
    assert.strictEqual(unownedDelete.status, 202,
      `an upgrade webhook without requester ownership must remain pending: ${await unownedDelete.clone().text()}`);
    assert.deepStrictEqual(await json(unownedDelete), {
      ok: false,
      status: 'pending',
      cleanupId: '70000000-0000-4000-8000-000000000001'
    });
    assert.deepStrictEqual(events('webhook.hash.backfill'), [{
      kind: 'webhook.hash.backfill',
      resourceKeyHash: 'b93bc739b72fb5f4349ee9c9fe0bef45e328ed04219bc605ae1d96fb5dac6e6d',
      hookId: webhookId
    }], 'direct deletion must compute and backfill the exact domain-separated provider hash');
    assert.strictEqual(events('privacy.cleanup.create').at(-1).input.resourceKeyHash,
      'b93bc739b72fb5f4349ee9c9fe0bef45e328ed04219bc605ae1d96fb5dac6e6d');
    assert.strictEqual(events('privacy.cleanup.inspect').length, 1);
    assert.strictEqual(events('privacy.cleanup.complete').length, 0,
      'unowned direct deletion must not complete local or retained cleanup state');
    assert.strictEqual(events('webhook.local.delete').length, 0,
      'unowned direct deletion must preserve the local webhook row');
    assert.strictEqual(
      events('provider.fetch').filter(event => event.method === 'DELETE').length,
      providerMutationsBeforeUnownedDelete,
      'unowned direct deletion must not issue a provider mutation');

    const unknownProtected = await request('/api/does-not-exist');
    assert.strictEqual(unknownProtected.status, 401);
    assert.strictEqual((await json(unknownProtected)).code, 'ALPHA_ACCESS_REQUIRED');
    const unknownAdmitted = await request('/api/does-not-exist', {
      headers: { cookie: alphaCookie('A') }
    });
    assert.strictEqual(unknownAdmitted.status, 404);

    const endWithoutAlpha = await request('/api/alpha/end', postJson({}));
    assert.strictEqual(endWithoutAlpha.status, 401);
    const end = await request('/api/alpha/end', postJson({}, {
      cookie: alphaCookie('A')
    }));
    assert.strictEqual(end.status, 200);
    assert.deepStrictEqual(await json(end), { ok: true });
    assert.match(end.headers.get('set-cookie') || '', /^nv_alpha_access=;/);
    assert.match(end.headers.get('set-cookie') || '', /Max-Age=0/i);

    for (const [letter, sid] of [
      ['A', 'provider-github'],
      ['E', 'provider-gitlab'],
      ['F', 'provider-gitea']
    ]) {
      const response = await request('/api/repos', {
        headers: { cookie: combinedCookie(letter, sid) }
      });
      const repositories = await json(response);
      assert.strictEqual(
        response.status,
        200,
        `${sid} repository list: ${JSON.stringify(repositories)}\n${logs}`
      );
      assert.deepStrictEqual(
        repositories.map(repository => repository.full_name),
        ['Acme/Demo'],
        `${sid} list must contain only the exact invitation scope`
      );
    }

    const transportBeforeDeniedRepository = transportEvents();
    const deniedRepository = await request('/api/repo/acme/production', {
      headers: { cookie: combinedCookie('A', 'provider-app') }
    });
    assert.strictEqual(deniedRepository.status, 403);
    assert.deepStrictEqual(await json(deniedRepository), {
      error: 'This repository is not allowed for this alpha invitation',
      code: 'ALPHA_REPOSITORY_NOT_ALLOWED'
    });
    assert.deepStrictEqual(
      transportEvents(),
      transportBeforeDeniedRepository,
      'an uncached GitHub App denied repository must perform zero credential, installation, token, or provider calls'
    );

    for (const [provider, letter, sid] of [
      ['GitLab', 'Q', 'provider-gitlab-path'],
      ['Gitea', 'P', 'provider-gitea-path']
    ]) {
      const transportBeforePathRoot = transportEvents();
      const pathRoot = await request('/api/repo/acme/demo', {
        headers: { cookie: combinedCookie(letter, sid) }
      });
      assert.strictEqual(pathRoot.status, 403);
      assert.strictEqual((await json(pathRoot)).code, 'ALPHA_REPOSITORY_NOT_ALLOWED');
      assert.deepStrictEqual(
        transportEvents(),
        transportBeforePathRoot,
        `${provider} path-root repository access must fail before credential or provider transport`
      );
      const pathRootList = await request('/api/repos', {
        headers: { cookie: combinedCookie(letter, sid) }
      });
      assert.strictEqual(pathRootList.status, 403);
      assert.strictEqual((await json(pathRootList)).code, 'ALPHA_REPOSITORY_NOT_ALLOWED');
      assert.deepStrictEqual(
        transportEvents(),
        transportBeforePathRoot,
        `${provider} path-root repository listing must fail before capability, credential, or provider transport`
      );
    }

    const fetchesBeforeAllowedSearch = events('provider.fetch').length;
    const allowedSearch = await request('/api/repo/acme/demo/search?q=readme', {
      headers: { cookie: combinedCookie('A', 'provider-github') }
    });
    assert.strictEqual(allowedSearch.status, 200);
    assert.deepStrictEqual(await json(allowedSearch), [{ name: 'README.md', path: 'README.md' }]);
    assert.strictEqual(
      events('provider.fetch').length,
      fetchesBeforeAllowedSearch + 1,
      'repository-scoped search must remain available after the repository boundary'
    );

    const transportBeforeDisabled = transportEvents();
    const writesBeforeDisabled = events('session.write');
    const create = await request('/api/repos', postJson({
      name: 'new-repository'
    }, {
      cookie: combinedCookie('A', 'provider-app'),
      'x-nv-csrf': csrfFor(accounts.githubApp)
    }));
    assert.strictEqual(create.status, 409);
    assert.strictEqual((await json(create)).code, 'PROVIDER_CAPABILITY_UNAVAILABLE');

    const remove = await request('/api/repo/acme/demo', {
      method: 'DELETE',
      headers: {
        cookie: combinedCookie('A', 'provider-app-delete'),
        'x-nv': '1',
        'x-nv-csrf': csrfFor(accounts.githubApp),
        'x-nv-step-up': appDeleteGrant
      }
    });
    assert.strictEqual(remove.status, 409);
    assert.strictEqual((await json(remove)).code, 'PROVIDER_CAPABILITY_UNAVAILABLE');

    const globalSearch = await request('/api/search?q=secret', {
      headers: { cookie: combinedCookie('A', 'provider-app') }
    });
    assert.strictEqual(globalSearch.status, 409);
    assert.strictEqual((await json(globalSearch)).code, 'PROVIDER_CAPABILITY_UNAVAILABLE');
    assert.deepStrictEqual(
      transportEvents(),
      transportBeforeDisabled,
      'repository create/delete and global search must perform zero broker or provider calls'
    );

    const appNotificationTransport = transportEvents();
    const appNotifications = await request('/api/notifications', {
      headers: { cookie: combinedCookie('A', 'provider-app') }
    });
    assert.strictEqual(appNotifications.status, 409);
    assert.deepStrictEqual(await json(appNotifications), {
      error: 'Global notifications cannot satisfy exact invitation repository allowlists.',
      code: 'PROVIDER_CAPABILITY_UNAVAILABLE',
      feature: 'notifications'
    }, 'GitHub App notification denial must contain only safe capability metadata');
    assert.deepStrictEqual(
      transportEvents(),
      appNotificationTransport,
      'GitHub App notifications must be denied before broker or provider transport'
    );

    const patNotificationTransport = transportEvents();
    const patNotifications = await request('/api/notifications', {
      headers: { cookie: combinedCookie('A', 'provider-github') }
    });
    assert.strictEqual(patNotifications.status, 409);
    assert.deepStrictEqual(await json(patNotifications), {
      error: 'Global notifications cannot satisfy exact invitation repository allowlists.',
      code: 'PROVIDER_CAPABILITY_UNAVAILABLE',
      feature: 'notifications'
    }, 'PAT notification denial must not expose repository, subject, URL, array, or provider details');
    assert.deepStrictEqual(
      transportEvents(),
      patNotificationTransport,
      'PAT notifications must be denied before credential resolution or provider transport'
    );
    assert.deepStrictEqual(
      events('session.write'),
      writesBeforeDisabled,
      'pre-transport capability denials must not consume step-up state or rewrite the session'
    );

    const stepUpCsrf = csrfFor(accounts.github);
    const disallowedStepUpBaseline = {
      transport: transportEvents(),
      session: events('session.write'),
      safety: events('safety.write'),
      evidence: events('evidence.write')
    };
    for (const [action, scope] of [
      ['repository.delete', { owner: 'acme', repo: 'production' }],
      ['branch.reset', {
        owner: 'acme', repo: 'production', branch: 'main',
        targetSha: '1'.repeat(40), expectedHeadSha: '2'.repeat(40)
      }],
      ['pull.merge', { owner: 'acme', repo: 'production', pullNumber: 7, method: 'squash' }]
    ]) {
      const deniedStepUp = await request('/api/security/step-up', postJson({
        action,
        scope,
        confirm: accounts.github.login,
        credential: 'fresh-fixture-token'
      }, {
        cookie: combinedCookie('A', 'provider-github'),
        'x-nv-csrf': stepUpCsrf
      }));
      assert.strictEqual(deniedStepUp.status, 403, `${action} step-up must reject a disallowed repository`);
      assert.strictEqual((await json(deniedStepUp)).code, 'ALPHA_REPOSITORY_NOT_ALLOWED');
    }
    assert.deepStrictEqual(transportEvents(), disallowedStepUpBaseline.transport, 'denied step-up must not resolve or verify provider credentials');
    assert.deepStrictEqual(events('session.write'), disallowedStepUpBaseline.session, 'denied step-up must not issue grants or mutate the session');
    assert.deepStrictEqual(events('safety.write'), disallowedStepUpBaseline.safety, 'denied step-up must not mutate safety state');
    assert.deepStrictEqual(events('evidence.write'), disallowedStepUpBaseline.evidence, 'denied step-up must not append evidence');

    const allowedIdentityStepUp = await request('/api/security/step-up', postJson({
      action: 'sessions.revoke-others',
      scope: {},
      confirm: accounts.github.login,
      credential: 'fresh-fixture-token'
    }, {
      cookie: combinedCookie('A', 'provider-github'),
      'x-nv-csrf': stepUpCsrf
    }));
    assert.strictEqual(allowedIdentityStepUp.status, 200, 'non-repository step-up must remain deliberately available');
    const allowedIdentityBody = await json(allowedIdentityStepUp);
    assert.strictEqual(allowedIdentityBody.action, 'sessions.revoke-others');
    assert.strictEqual(allowedIdentityBody.assurance, 'credential');

    const safety = await request('/api/safety', {
      headers: { cookie: combinedCookie('A', 'provider-github') }
    });
    assert.strictEqual(safety.status, 200);
    assert.deepStrictEqual((await json(safety)).protected, {
      'Acme/Demo': ['allowed.txt']
    }, 'safety aggregate must not disclose protected-path metadata for disallowed repositories');

    const safetyMutationBaseline = {
      session: events('session.write'),
      safety: events('safety.write'),
      evidence: events('evidence.write')
    };
    const deniedSafety = await request('/api/safety', postJson({
      protect: { repo: 'Acme/Production', path: 'new-private.txt', on: true }
    }, {
      cookie: combinedCookie('A', 'provider-github'),
      'x-nv-csrf': stepUpCsrf
    }));
    assert.strictEqual(deniedSafety.status, 403);
    assert.strictEqual((await json(deniedSafety)).code, 'ALPHA_REPOSITORY_NOT_ALLOWED');
    const deniedGlobalSafety = await request('/api/safety', postJson({
      readOnly: true
    }, {
      cookie: combinedCookie('A', 'provider-github'),
      'x-nv-csrf': stepUpCsrf
    }));
    assert.strictEqual(deniedGlobalSafety.status, 403);
    assert.strictEqual((await json(deniedGlobalSafety)).code, 'ALPHA_REPOSITORY_SCOPE_REQUIRED');
    assert.deepStrictEqual(events('session.write'), safetyMutationBaseline.session, 'denied safety changes must not mutate the session');
    assert.deepStrictEqual(events('safety.write'), safetyMutationBaseline.safety, 'denied safety changes must not persist state');
    assert.deepStrictEqual(events('evidence.write'), safetyMutationBaseline.evidence, 'denied safety changes must not append evidence');

    const serializedLogs = `${logs}\n${JSON.stringify(operationalBody)}`;
    assert(!serializedLogs.includes('raw database detail'));
    assert(!serializedLogs.includes('nvx_alpha_private'));

    console.log('alpha repository boundary integration tests passed');
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 2000).unref();
    });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
