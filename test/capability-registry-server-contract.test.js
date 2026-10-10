'use strict';
const { withLifetime } = require('./fixtures/local-session');

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { hashJson } = require('../src/intelligence');
const { KEY_PURPOSES, deriveKey, deriveSecret } = require('../src/key-derivation');
const { createCsrfToken } = require('../src/security-foundation');

const root = path.resolve(__dirname, '..');
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const fixture = path.join(__dirname, 'fixtures', 'capability-provider-fetch.js');
const port = 31000 + Math.floor(Math.random() * 1000);
const secret = 'capability-server-test-secret-0123456789abcdef-0123456789abcdef';
/* The server derives a purpose-specific key per construction; mirror those
   derivations rather than the single raw secret they replaced. */
const key = deriveKey(secret, KEY_PURPOSES.SESSION_CONTENT);
const csrfSecret = deriveSecret(secret, KEY_PURPOSES.CSRF_TOKEN);
const fixtureLog = path.join(os.tmpdir(), `nv-capability-provider-${process.pid}-${port}.log`);
const focus = process.argv[2] || 'all';
const sessionNonce = 'a'.repeat(48);
assert.match(
  serverSource,
  /if \(initial\.body\) await initial\.body\.cancel\(\);\s+const location/,
  'GitHub archive redirects must release the authenticated response body before validation and codeload'
);
const account = {
  provider: 'gitea',
  authMethod: 'token',
  login: 'fixture-user',
  token: 'fixture-provider-token',
  baseUrl: 'https://gitea.example'
};

function routeRegistration(method, routePath) {
  const prefix = `app.${method}('${routePath}'`;
  const line = serverSource.split('\n').find(candidate => candidate.startsWith(prefix));
  assert(line, `missing route registration: ${method.toUpperCase()} ${routePath}`);
  return line;
}

for (const [method, routePath, feature] of [
  ['get', '/api/rate', 'rate.read'],
  ['get', '/api/repo/:owner/:repo/tree', 'tree.read'],
  ['get', '/api/repo/:owner/:repo/files', 'tree.read'],
  ['post', '/api/repo/:owner/:repo/rename', 'file.rename'],
  ['post', '/api/repo/:owner/:repo/batch', 'file.batch'],
  ['get', '/api/repo/:owner/:repo/pulls', 'pulls.read'],
  ['get', '/api/repo/:owner/:repo/pulls/:num', 'pulls.read'],
  ['post', '/api/repo/:owner/:repo/pulls', 'pulls.write'],
  ['put', '/api/repo/:owner/:repo/pulls/:num/merge', 'pulls.write'],
  ['post', '/api/repo/:owner/:repo/pulls/:num/reviews', 'pulls.write'],
  ['get', '/api/repo/:owner/:repo/issues', 'issues.read'],
  ['get', '/api/repo/:owner/:repo/issues/:num', 'issues.read'],
  ['post', '/api/repo/:owner/:repo/issues', 'issues.write'],
  ['post', '/api/repo/:owner/:repo/issues/:num/comments', 'issues.write'],
  ['patch', '/api/repo/:owner/:repo/issues/:num', 'issues.write'],
  ['get', '/api/repo/:owner/:repo/star', 'stars.read'],
  ['put', '/api/repo/:owner/:repo/star', 'stars.write'],
  ['delete', '/api/repo/:owner/:repo/star', 'stars.write'],
  ['get', '/api/repo/:owner/:repo/actions/:runId/jobs', 'workflows.read'],
  ['post', '/api/repo/:owner/:repo/actions/:runId/rerun', 'workflows.rerun'],
  ['get', '/api/repo/:owner/:repo/actions', 'workflows.read'],
  ['get', '/api/repo/:owner/:repo/releases', 'releases.read'],
  ['post', '/api/repo/:owner/:repo/releases', 'releases.write'],
  ['post', '/api/repo/:owner/:repo/move-dir', 'folder.move'],
  ['get', '/api/repo/:owner/:repo/audit-deps', 'dependency-audit']
]) {
  assert(
    routeRegistration(method, routePath).includes(`capabilityAccess('${feature}', { allowExperimental: true })`),
    `${method.toUpperCase()} ${routePath} must explicitly opt in to evidence-bounded ${feature}`
  );
}

for (const [method, routePath] of [
  ['get', '/api/repo/:owner/:repo/compare'],
  ['get', '/api/repo/:owner/:repo/snapshot'],
  ['get', '/api/repo/:owner/:repo/refs-snapshot'],
  ['post', '/api/repo/:owner/:repo/snapshot-compare'],
  ['post', '/api/repo/:owner/:repo/restore-preview'],
  ['get', '/api/repo/:owner/:repo/signed-snapshots']
]) {
  assert(
    routeRegistration(method, routePath).includes("capabilityAccess('recovery', { allowExperimental: true })"),
    `${method.toUpperCase()} ${routePath} must opt in to read-only experimental recovery`
  );
}
for (const [method, routePath] of [
  ['post', '/api/repo/:owner/:repo/revert'],
  ['post', '/api/repo/:owner/:repo/restore'],
  ['post', '/api/repo/:owner/:repo/restore-paths'],
  ['post', '/api/repo/:owner/:repo/reset'],
  ['post', '/api/repo/:owner/:repo/signed-snapshot'],
  ['post', '/api/repo/:owner/:repo/emergency-manifest'],
  ['post', '/api/repo/:owner/:repo/restore-refs']
]) {
  assert(
    !routeRegistration(method, routePath).includes('allowExperimental: true'),
    `${method.toUpperCase()} ${routePath} must remain blocked for experimental recovery providers`
  );
}

function governanceRegistrations(methods) {
  const pattern = new RegExp(
    `\\b(?:app|router)\\s*\\.\\s*(${methods})\\s*\\(\\s*(['"])` +
      '(\\/api\\/repo\\/:owner\\/:repo\\/governance\\/[^\'"]+)\\2',
    'g'
  );
  return [...serverSource.matchAll(pattern)];
}

const governanceReadRoutes = governanceRegistrations('get');
assert(governanceReadRoutes.length >= 15, 'governance read-route inventory unexpectedly shrank');
function registrationHeader(match) {
  const remainder = serverSource.slice(match.index);
  const handlerIndex = remainder.search(/(?:async\s*)?\(\s*req\s*,\s*res\s*\)\s*=>/);
  assert(handlerIndex >= 0, `governance route ${match[1].toUpperCase()} ${match[3]} is missing its handler`);
  return remainder.slice(0, handlerIndex);
}

const experimentalGovernanceAccess =
  /capabilityAccess\(\s*'governance'\s*,\s*\{\s*allowExperimental:\s*true\s*\}\s*\)/;
assert(
  governanceReadRoutes.every(match => experimentalGovernanceAccess.test(registrationHeader(match))),
  'every governance GET route must explicitly opt in to experimental provider views'
);
const governanceMutationRoutes = governanceRegistrations('post|put|patch|delete');
assert(governanceMutationRoutes.length >= 15, 'governance mutation-route inventory unexpectedly shrank');
assert(
  governanceMutationRoutes.every(match => !experimentalGovernanceAccess.test(registrationHeader(match))),
  'governance mutations must remain blocked for providers with view-only experimental coverage'
);
const activeIdentityKey = hashJson({
  provider: account.provider,
  baseUrl: account.baseUrl,
  login: account.login
});
const csrf = createCsrfToken(csrfSecret, {
  sessionBinding: sessionNonce,
  identityKey: activeIdentityKey
});

function seal(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(withLifetime(value)), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}

function sessionCookie(stepUp, selectedAccount = account) {
  return `nv_session=${seal({
    accounts: [selectedAccount],
    active: 0,
    security: { sessionNonce, stepUp: stepUp || null }
  })}`;
}

function fixtureRequests() {
  if (!fs.existsSync(fixtureLog)) return [];
  return fs.readFileSync(fixtureLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function mutationOptions(method, cookie, body, extraHeaders = {}) {
  return {
    method,
    headers: {
      cookie,
      'content-type': 'application/json',
      'x-nv': '1',
      'x-nv-csrf': csrf,
      ...extraHeaders
    },
    body: JSON.stringify(body || {})
  };
}

const child = spawn(process.execPath, ['-r', fixture, 'server.js'], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    NODE_ENV: 'test',
    SESSION_SECRET: secret,
    DATABASE_URL: '',
    NV_GOVERNANCE_RUNTIME_FAILURE_MODE: 'warn',
    NV_CAPABILITY_FIXTURE_LOG: fixtureLog
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let logs = '';
child.stdout.on('data', chunk => { logs += chunk.toString(); });
child.stderr.on('data', chunk => { logs += chunk.toString(); });

async function request(pathname, options = {}) {
  return fetch(`http://127.0.0.1:${port}${pathname}`, options);
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

async function expectRetiredSessionRejection(entry, cookie = sessionCookie()) {
  const before = fixtureRequests();
  const response = await request(entry.path, entry.options(cookie));
  const body = await response.json();
  assert.strictEqual(response.status, 401, `${entry.label}: ${JSON.stringify(body)}`);
  assert.strictEqual(body.code, 'AUTH_REQUIRED');
  assert.deepStrictEqual(
    fixtureRequests(),
    before,
    `${entry.label} must reject before mutation authorization or provider transport`
  );
}

(async () => {
  try {
    fs.writeFileSync(fixtureLog, '');
    await waitForServer();

    if (focus === 'all' || focus === 'routes') {
      const projection = await request('/api/capabilities?provider=gitea&authority=gitea.example');
      assert.strictEqual(projection.status, 400);
      assert.strictEqual((await projection.json()).code, 'PROVIDER_UNSUPPORTED');
      const githubProjection = await request('/api/capabilities?provider=github');
      assert.strictEqual(githubProjection.status, 200);
      const github = await githubProjection.json();
      assert.strictEqual(github.features['branches.write'].status, 'Supported');
      assert.strictEqual(github.features['branches.write'].evidenceState, 'Provider-verified');
      /*
       * Earned by the live-provider harness, each through the probe that walks
       * its route -- and nothing the harness cannot reach is claimed with them.
       */
      for (const feature of [
        'file.rename', 'folder.move', 'stars.read', 'stars.write', 'issues.write', 'pulls.write',
        'releases.write', 'search', 'global-search', 'workflows.rerun', 'exposure.scan'
      ]) {
        assert.strictEqual(github.features[feature].status, 'Supported', `${feature} is provider-verified for GitHub`);
        assert.strictEqual(github.features[feature].evidenceState, 'Provider-verified');
      }
      for (const feature of ['live-events', 'notifications', 'repository.create', 'repository.delete']) {
        assert.strictEqual(github.features[feature].status, 'Experimental', `${feature} must remain evidence-bounded for GitHub`);
        assert.match(github.features[feature].reason, /Not provider-verified/);
      }

      const routeCases = [
      {
        label: 'Gitea rate-limit read',
        feature: 'rate.read',
        path: '/api/rate',
        options: cookie => ({ headers: { cookie } })
      },
      {
        label: 'Gitea batch mutation',
        feature: 'file.batch',
        path: '/api/repo/Acme/Demo/batch',
        options: cookie => mutationOptions('POST', cookie, {
          branch: 'main',
          message: 'Attempt unqualified Gitea batch mutation',
          expectedHeadSha: '1'.repeat(40),
          ops: [{ op: 'put', path: 'batch.txt', content: 'blocked' }]
        })
      },
      {
        label: 'branch create',
        feature: 'branches.write',
        path: '/api/repo/Acme/Demo/branches',
        options: cookie => mutationOptions('POST', cookie, { name: 'topic', from: 'main' })
      },
      {
        label: 'branch delete',
        feature: 'branches.write',
        path: '/api/repo/Acme/Demo/branches/topic',
        options: cookie => mutationOptions('DELETE', cookie)
      },
      {
        label: 'file rename',
        feature: 'file.rename',
        path: '/api/repo/Acme/Demo/rename',
        options: cookie => mutationOptions('POST', cookie, { from: 'a.txt', to: 'b.txt', branch: 'main' })
      },
      {
        label: 'commit revert',
        feature: 'recovery',
        path: '/api/repo/Acme/Demo/revert',
        options: cookie => mutationOptions('POST', cookie, { sha: '1'.repeat(40), branch: 'main' })
      },
      {
        label: 'star read',
        feature: 'stars.read',
        path: '/api/repo/Acme/Demo/star',
        options: cookie => ({ headers: { cookie } })
      },
      {
        label: 'star',
        feature: 'stars.write',
        path: '/api/repo/Acme/Demo/star',
        options: cookie => mutationOptions('PUT', cookie)
      },
      {
        label: 'unstar',
        feature: 'stars.write',
        path: '/api/repo/Acme/Demo/star',
        options: cookie => mutationOptions('DELETE', cookie)
      }
      ];
      for (const entry of routeCases) await expectRetiredSessionRejection(entry);

      const resetBody = {
        branch: 'main',
        sha: '2'.repeat(40),
        expectedHeadSha: '1'.repeat(40)
      };
      await expectRetiredSessionRejection({
        label: 'branch reset',
        feature: 'recovery',
        path: '/api/repo/Acme/Demo/reset',
        options: cookie => mutationOptions('POST', cookie, resetBody, { 'x-nv-step-up': 'retired-session-grant' })
      }, sessionCookie());
    }

    for (const [caseFocus, pathname] of [
      ['activity', '/api/repo/Acme/Demo/activity'],
      ['commits', '/api/repo/Acme/Demo/commits?ref=main'],
      ['commits', `/api/repo/Acme/Demo/commit/${'1'.repeat(40)}`]
    ]) {
      if (focus !== 'all' && focus !== caseFocus) continue;
      await expectRetiredSessionRejection({ label: `retired session ${pathname}`, path: pathname,
        options: cookie => ({ headers: { cookie } }) });
    }

    if (focus === 'all' || focus === 'lfs') {
      const before = fixtureRequests();
      const raw = await request('/api/repo/Acme/Demo/raw?path=large.bin&ref=main', {
        headers: { cookie: sessionCookie() }
      });
      const rawText = await raw.text();
      let rawBody = {};
      try { rawBody = JSON.parse(rawText); } catch {}
      assert.strictEqual(raw.status, 401, rawText);
      assert.strictEqual(rawBody.code, 'AUTH_REQUIRED');
      assert.deepStrictEqual(fixtureRequests(), before, 'retired credentials must not reach any provider, including GitHub LFS');

      const githubAccount = {
        provider: 'github',
        authMethod: 'token',
        login: 'fixture-user',
        token: 'fixture-github-token',
        baseUrl: ''
      };
      const githubRaw = await request('/api/repo/Acme/Demo/raw?path=large.bin&ref=main', {
        headers: { cookie: sessionCookie(null, githubAccount) }
      });
      assert.strictEqual(githubRaw.status, 200);
      assert.strictEqual(await githubRaw.text(), 'fixture bytes');
    }

    if (focus === 'all' || focus === 'redirects') {
      const before = fixtureRequests();
      const githubAccount = {
        provider: 'github',
        authMethod: 'token',
        login: 'fixture-user',
        token: 'fixture-github-token',
        baseUrl: ''
      };
      const archive = await request('/api/repo/Acme/Demo/zip?ref=main', {
        headers: { cookie: sessionCookie(null, githubAccount) }
      });
      assert.strictEqual(archive.status, 200);
      assert.strictEqual(await archive.text(), 'zip-fixture');
      assert.deepStrictEqual(
        fixtureRequests().slice(before.length),
        [
          {
            method: 'GET',
            url: 'https://api.github.com/repos/Acme/Demo/zipball/main',
            hasAuthorization: true
          },
          {
            method: 'GET',
            url: 'https://codeload.github.com/Acme/Demo/legacy.zip/refs/heads/main',
            hasAuthorization: false
          }
        ],
        'archive download must use one validated credential-free codeload hop'
      );
    }

    assert(serverSource.includes("require('./src/capability-registry')"));
    assert(!/const CAPS\s*=/.test(serverSource), 'legacy CAPS table must not remain an independent truth source');
    console.log('capability registry server contract tests passed');
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2000).unref();
    });
    try { fs.unlinkSync(fixtureLog); } catch {}
  }
})().catch(error => {
  console.error(error.stack || error);
  console.error(logs);
  process.exitCode = 1;
});
