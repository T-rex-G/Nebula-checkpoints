'use strict';

/*
 * The hosted operational drills, driven against the staging deployment of the
 * exact candidate and reported for the operator to review and sign.
 *
 * The hosted gate (ci/run-hosted-alpha17-validation.js) accepts the operational
 * checks only as a record signed by the operator key it trusts. This program
 * produces the evidence behind that record: each drill is driven against the
 * real deployment, its database and its providers, and observed from outside,
 * the way a reader meets it. It prints the unsigned record -- exactly the
 * fields the gate validates -- with what each drill observed. It signs nothing;
 * scripts/alpha17-operator-record.js does that, after a person has read it.
 *
 * What it refuses to touch: a deployment that does not say it is a
 * qualification target (/api/config `qualification`), a Render service that
 * deploys on its own (production deploys from main on every push), and a
 * deployment that is not the candidate this checkout builds.
 *
 * What it never prints: an invitation, a cookie, a token, a database address or
 * a pepper. Those are read into memory where a drill needs them and nowhere else.
 */

const path = require('path');
const { Pool } = require('pg');
const { AlphaAccessStore } = require('../src/alpha-access-store');
const { computeReleaseFingerprint } = require('../src/release-fingerprint');
const { hashJson } = require('../src/intelligence');

const SCHEMA_VERSION = '1.0.0';
const RENDER_API = 'https://api.render.com/v1';
const NEON_API = 'https://console.neon.tech/api/v2';
const GITHUB_API = 'https://api.github.com';
const SEARCH_FIXTURE = 'nvx-alpha17-search-fixture';
const DELETION_CONFIRMATION = 'DELETE ALPHA DATA';

/* The bounds every wait is held to. A drill that needs longer has found something. */
const LIMITS = Object.freeze({
  requestMs: 30000,
  restartMs: 6 * 60 * 1000,
  deployMs: 20 * 60 * 1000,
  suspendMs: 90 * 1000,
  wakeAttempts: 30,
  interruptionMs: 3 * 60 * 1000,
  recoveryMs: 4 * 60 * 1000,
  eventMs: 120 * 1000,
  searchAttempts: 24,
  retryAfterMaxSeconds: 120,
  pollMs: 2000
});

class DrillError extends Error {
  constructor(message, code = 'ALPHA17_DRILL_FAILED') {
    super(message);
    this.name = 'DrillError';
    this.code = code;
  }
}

function fail(message, code) {
  throw new DrillError(message, code);
}

function requireEnv(env, key) {
  const value = String(env[key] || '').trim();
  if (!value) fail(`${key} is required`, 'ALPHA17_DRILL_CONFIGURATION');
  return value;
}

function requirePattern(env, key, pattern) {
  const value = requireEnv(env, key);
  if (!pattern.test(value)) fail(`${key} is malformed`, 'ALPHA17_DRILL_CONFIGURATION');
  return value;
}

/*
 * An HTTPS origin, read as the target verifier reads it: one trailing slash,
 * as a browser's address bar copies it, names the same origin. A path does not.
 */
function requireOrigin(env, key) {
  const value = requireEnv(env, key).replace(/\/$/, '');
  if (!/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(value)) fail(`${key} is malformed`, 'ALPHA17_DRILL_CONFIGURATION');
  return value;
}

/* ---- Transport ------------------------------------------------------------ */

async function request(deps, url, { method = 'GET', headers = {}, body, timeoutMs = LIMITS.requestMs } = {}) {
  const response = await deps.fetch(url, {
    method,
    headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { status: response.status, data, headers: response.headers };
}

/* Names the endpoint without its query: the paths carry identifiers, never credentials. */
function where(method, url) {
  return `${method} ${new URL(url).pathname}`;
}

async function expectStatus(deps, url, options, statuses) {
  const answer = await request(deps, url, options);
  if (!statuses.includes(answer.status)) fail(`${where(options && options.method || 'GET', url)} answered ${answer.status}`);
  return answer;
}

function renderClient(deps, apiKey, serviceId) {
  const auth = { authorization: `Bearer ${apiKey}` };
  const url = suffix => `${RENDER_API}/services/${encodeURIComponent(serviceId)}${suffix}`;
  return Object.freeze({
    async service() { return (await expectStatus(deps, url(''), { headers: auth }, [200])).data; },
    /* The service's own configuration, so a tester is issued against the database and pepper it really uses. */
    async environment() {
      const values = {};
      let cursor = '';
      for (let page = 0; page < 20; page += 1) {
        const answer = await expectStatus(deps, url(`/env-vars?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`), { headers: auth }, [200]);
        const rows = Array.isArray(answer.data) ? answer.data : [];
        for (const row of rows) {
          const entry = row && (row.envVar || row);
          if (entry && typeof entry.key === 'string') values[entry.key] = String(entry.value == null ? '' : entry.value);
        }
        cursor = rows.length === 100 && rows[rows.length - 1] ? String(rows[rows.length - 1].cursor || '') : '';
        if (!cursor) break;
      }
      return values;
    },
    async restart() { await expectStatus(deps, url('/restart'), { method: 'POST', headers: auth }, [200, 202, 204]); },
    async deploy(commitId) {
      const answer = await expectStatus(deps, url('/deploys'), { method: 'POST', headers: auth, body: { commitId, clearCache: 'do_not_clear' } }, [200, 201, 202]);
      const id = answer.data && answer.data.id;
      if (!/^dep-[a-z0-9]+$/i.test(String(id || ''))) fail('Render did not return a deploy identifier');
      return id;
    },
    async deployStatus(id) { return (await expectStatus(deps, url(`/deploys/${encodeURIComponent(id)}`), { headers: auth }, [200])).data; }
  });
}

function neonClient(deps, apiKey, projectId, branchId) {
  const auth = { authorization: `Bearer ${apiKey}` };
  const url = suffix => `${NEON_API}/projects/${encodeURIComponent(projectId)}${suffix}`;
  /* Neon refuses a change while another operation on the endpoint is running; that is a wait, not a failure. */
  async function change(endpointUrl, options) {
    const deadline = deps.now() + LIMITS.suspendMs;
    for (;;) {
      const answer = await request(deps, endpointUrl, { ...options, headers: auth });
      if (answer.status >= 200 && answer.status < 300) return answer;
      if (![409, 423].includes(answer.status) || deps.now() > deadline) fail(`${where(options.method, endpointUrl)} answered ${answer.status}`);
      await deps.sleep(LIMITS.pollMs);
    }
  }
  return Object.freeze({
    async endpoint() {
      const answer = await expectStatus(deps, url('/endpoints'), { headers: auth }, [200]);
      const list = answer.data && Array.isArray(answer.data.endpoints) ? answer.data.endpoints : [];
      const endpoint = list.find(item => item && item.branch_id === branchId && item.type === 'read_write');
      if (!endpoint) fail('the cohort branch has no read-write compute');
      return endpoint;
    },
    async suspend(id) { await change(url(`/endpoints/${encodeURIComponent(id)}/suspend`), { method: 'POST' }); },
    async setDisabled(id, disabled) {
      await change(url(`/endpoints/${encodeURIComponent(id)}`), { method: 'PATCH', body: { endpoint: { disabled } } });
    }
  });
}

function githubClient(deps, token, repository) {
  const headers = { authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28', 'user-agent': 'nebulaverse-x-alpha17-drills' };
  const repo = suffix => `${GITHUB_API}/repos/${repository}${suffix}`;
  return Object.freeze({
    async login() {
      const user = (await expectStatus(deps, `${GITHUB_API}/user`, { headers }, [200])).data;
      if (!user || !user.login) fail('GitHub did not name the credential\'s account');
      return String(user.login);
    },
    async defaultHead() {
      const info = (await expectStatus(deps, repo(''), { headers }, [200])).data;
      const branch = String(info && info.default_branch || '');
      const ref = (await expectStatus(deps, repo(`/git/ref/heads/${encodeURIComponent(branch)}`), { headers }, [200])).data;
      return { branch, sha: String(ref && ref.object && ref.object.sha || '') };
    },
    async createBranch(name, sha) {
      await expectStatus(deps, repo('/git/refs'), { method: 'POST', headers, body: { ref: `refs/heads/${name}`, sha } }, [201]);
    },
    async commitFile(branch, file, text, message) {
      await expectStatus(deps, repo(`/contents/${file}`), {
        method: 'PUT', headers, body: { message, branch, content: Buffer.from(text, 'utf8').toString('base64') }
      }, [200, 201]);
    },
    async deleteBranch(name) {
      const answer = await request(deps, repo(`/git/refs/heads/${encodeURIComponent(name)}`), { method: 'DELETE', headers });
      if (![204, 404, 422].includes(answer.status)) fail(`deleting the drill branch answered ${answer.status}`);
    },
    async hooks() {
      const answer = await expectStatus(deps, repo('/hooks?per_page=100'), { headers }, [200]);
      return Array.isArray(answer.data) ? answer.data : [];
    },
    async hookStatus(id) { return (await request(deps, repo(`/hooks/${id}`), { headers })).status; },
    async deliveries(id) {
      const answer = await expectStatus(deps, repo(`/hooks/${id}/deliveries?per_page=30`), { headers }, [200]);
      return Array.isArray(answer.data) ? answer.data : [];
    }
  });
}

/*
 * One browser, as far as the server can tell: a cookie jar, the headers the
 * interface sends, and a CSRF token fetched when a change asks for one.
 */
function appClient(deps, base) {
  const jar = new Map();
  function absorb(headers) {
    const lines = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
    for (const line of lines) {
      const [pair, ...attributes] = String(line).split(';');
      const at = pair.indexOf('=');
      if (at <= 0) continue;
      const name = pair.slice(0, at).trim();
      const value = pair.slice(at + 1).trim();
      const expired = !value || attributes.some(attribute => /^\s*max-age\s*=\s*0\s*$/i.test(attribute))
        || attributes.some(attribute => /^\s*expires\s*=/i.test(attribute) && Date.parse(attribute.split('=').slice(1).join('=')) <= deps.now());
      if (expired) jar.delete(name);
      else jar.set(name, value);
    }
  }
  const cookieHeader = () => [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
  async function send(method, route, { body, csrf = false, cookie, timeoutMs } = {}) {
    const headers = { 'x-nv': '1' };
    const jarCookie = cookie === undefined ? cookieHeader() : cookie;
    if (jarCookie) headers.cookie = jarCookie;
    if (csrf) {
      const token = await send('GET', '/api/security/csrf');
      if (token.status !== 200 || !token.data || !token.data.token) fail(`a CSRF token was refused (${token.status})`);
      headers['x-nv-csrf'] = token.data.token;
    }
    const started = deps.now();
    const answer = await request(deps, new URL(route, base).toString(), { method, headers, body, timeoutMs });
    if (cookie === undefined) absorb(answer.headers);
    return { ...answer, durationMs: deps.now() - started };
  }
  return Object.freeze({
    send,
    snapshot: () => cookieHeader(),
    has: name => jar.has(name),
    async stream(route, { until, timeoutMs }) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await deps.fetch(new URL(route, base).toString(), {
          headers: { 'x-nv': '1', accept: 'text/event-stream', cookie: cookieHeader() }, signal: controller.signal
        });
        if (response.status !== 200 || !response.body) fail(`the live event stream answered ${response.status}`);
        return { response, controller, timer, until };
      } catch (error) {
        clearTimeout(timer);
        throw error;
      }
    }
  });
}

/* Reads server-sent frames until one satisfies `match`, or the stream ends or times out. */
async function awaitFrame(opened, match) {
  const reader = opened.response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return null;
      buffered += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffered.indexOf('\n\n')) >= 0) {
        const frame = buffered.slice(0, boundary);
        buffered = buffered.slice(boundary + 2);
        const event = (/^event: (.*)$/m.exec(frame) || [])[1] || '';
        const data = frame.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n');
        if (match(event, data)) return { event, data };
      }
    }
  } catch (error) {
    if (error && error.name === 'AbortError') return null;
    throw error;
  } finally {
    clearTimeout(opened.timer);
    opened.controller.abort();
  }
}

async function poll(deps, { timeoutMs, intervalMs = LIMITS.pollMs }, probe) {
  const deadline = deps.now() + timeoutMs;
  let attempts = 0;
  for (;;) {
    attempts += 1;
    let value;
    try { value = await probe(attempts); } catch { value = undefined; }
    if (value) return { value, attempts };
    if (deps.now() >= deadline) return { value: null, attempts };
    await deps.sleep(intervalMs);
  }
}

/* ---- Testers -------------------------------------------------------------- */

/*
 * A disposable tester: an invitation issued for the one sandbox repository,
 * redeemed and signed in through the routes a reader uses. The invitation code
 * exists only in this function.
 */
async function provisionTester(context, role, token) {
  const label = `alpha17 drill ${context.runId} ${role}`;
  const invite = await context.store.issueInvite({
    testerLabel: label, termsVersion: context.termsVersion, repositoryScopes: [`github:github.com/${context.repository}`]
  });
  const app = appClient(context.deps, context.base);
  const redeemed = await app.send('POST', '/api/alpha/redeem', { body: { code: invite.code, acceptedTermsVersion: context.termsVersion } });
  if (redeemed.status !== 200) fail(`the ${role} tester's invitation was not redeemed (${redeemed.status})`);
  const login = await app.send('POST', '/api/login', { body: { provider: 'github', token } });
  if (login.status !== 200) fail(`the ${role} tester could not sign in (${login.status})`);
  const row = await context.pool.query('SELECT tester_id FROM nv_alpha_testers WHERE invite_id=$1', [invite.inviteId]);
  const testerId = row.rows[0] && String(row.rows[0].tester_id);
  if (!testerId) fail(`the ${role} tester was not recorded`);
  const tester = { role, app, testerId, revoked: false };
  context.testers.push(tester);
  return tester;
}

async function revoke(context, tester) {
  if (tester.revoked) return;
  await context.store.revokeTester(tester.testerId, 'alpha17 hosted drill complete');
  tester.revoked = true;
}

async function signedIn(tester) {
  const me = await tester.app.send('GET', '/api/me');
  return me.status === 200 && me.data && typeof me.data.login === 'string' ? me.data.login : null;
}

/* ---- The drills ------------------------------------------------------------ */

async function liveEventsDrill(context) {
  const { deps, repository } = context;
  const tester = await provisionTester(context, 'live-events', context.credentials.mutation);
  const github = context.github.mutation;
  const [owner, repo] = repository.split('/');
  const route = `/api/repo/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/live-events`;
  const branch = `nvx-alpha17-${context.runId}-events`;
  const observation = { branch, hookObserved: false, deliveryStatus: null, eventStreamed: false, removedStatus: null };
  let hookId = null;
  let branchCreated = false;
  try {
    const before = new Set((await github.hooks()).map(hook => hook.id));
    const connected = await tester.app.send('POST', `${route}/connect`, { csrf: true });
    if (![200, 201].includes(connected.status)) fail(`connecting live events answered ${connected.status}${connected.data && connected.data.code ? ` ${connected.data.code}` : ''}`);
    const callback = `${context.base}/hooks/github/`;
    const created = (await github.hooks()).find(hook => !before.has(hook.id) && String(hook.config && hook.config.url || '').startsWith(callback));
    if (!created) fail('GitHub holds no webhook pointing at this deployment after connecting');
    hookId = created.id;
    observation.hookObserved = true;
    const opened = await tester.app.stream(`${route}/stream`, { timeoutMs: LIMITS.eventMs });
    const ready = awaitFrame(opened, (event, data) => event === 'intelligence' && data.includes(branch));
    const head = await github.defaultHead();
    await github.createBranch(branch, head.sha);
    branchCreated = true;
    await github.commitFile(branch, `alpha17-drills/${context.runId}.md`, `Live event drill ${context.runId}\n`, `Live event drill ${context.runId}`);
    const frame = await ready;
    observation.eventStreamed = Boolean(frame);
    const delivered = await poll(deps, { timeoutMs: 60000 }, async () => {
      const list = await github.deliveries(hookId);
      return list.find(item => item && item.event === 'push' && Number(item.status_code) >= 200 && Number(item.status_code) < 300) || null;
    });
    observation.deliveryStatus = delivered.value ? Number(delivered.value.status_code) : null;
    const disconnected = await tester.app.send('DELETE', route, { csrf: true });
    if (disconnected.status !== 200) fail(`disconnecting live events answered ${disconnected.status}`);
    observation.removedStatus = await github.hookStatus(hookId);
    if (observation.removedStatus === 404) hookId = null;
  } finally {
    if (hookId !== null) {
      await tester.app.send('DELETE', route, { csrf: true }).catch(() => {});
    }
    if (branchCreated) await github.deleteBranch(branch);
  }
  return {
    check: {
      webhookRegistered: observation.hookObserved,
      signedDeliveryVerified: observation.deliveryStatus !== null,
      eventStreamed: observation.eventStreamed,
      webhookRemovedAtProvider: observation.removedStatus === 404
    },
    observation
  };
}

async function rateLimitDrill(context) {
  const { deps } = context;
  const tester = await provisionTester(context, 'rate-limit', context.credentials.readOnly);
  /*
   * Each search a different one. The server answers a repeated read from
   * GitHub's ETag, a 304 does not count against GitHub's limit, and the same
   * query asked twenty times would never meet it.
   */
  const route = attempt => `/api/search?q=${encodeURIComponent(`${SEARCH_FIXTURE} drill${context.runId}x${attempt}`)}`;
  const answers = [];
  let limited = null;
  for (let attempt = 1; attempt <= LIMITS.searchAttempts && !limited; attempt += 1) {
    const answer = await tester.app.send('GET', route(attempt));
    answers.push({ status: answer.status, durationMs: answer.durationMs });
    if (answer.status === 429) limited = answer;
    else if (answer.status !== 200) fail(`code search answered ${answer.status} before any limit`);
  }
  if (!limited) fail(`GitHub did not limit ${LIMITS.searchAttempts} code searches in a row`);
  const retryAfter = Number(limited.headers.get('retry-after'));
  const named = Number.isSafeInteger(retryAfter) && retryAfter > 0 && retryAfter <= 3600;
  const code = limited.data && limited.data.code;
  await deps.sleep(Math.min(Math.max(named ? retryAfter : 60, 1), LIMITS.retryAfterMaxSeconds) * 1000 + 2000);
  const recovered = await poll(deps, { timeoutMs: 90000, intervalMs: 10000 }, async attempt => (await tester.app.send('GET', route(`r${attempt}`))).status === 200);
  const slowest = Math.max(...answers.map(answer => answer.durationMs));
  const observation = { searches: answers.length, limitedStatus: limited.status, code, retryAfter: named ? retryAfter : null, slowestMs: slowest, recovered: Boolean(recovered.value) };
  return {
    check: { retryBounded: code === 'PROVIDER_RATE_LIMITED' && named && slowest < LIMITS.requestMs && Boolean(recovered.value) },
    observation
  };
}

async function revocationDrill(context) {
  const tester = await provisionTester(context, 'revocation', context.credentials.readOnly);
  const before = await signedIn(tester);
  await revoke(context, tester);
  const after = await tester.app.send('GET', '/api/me');
  const code = String(after.data && after.data.code || '');
  const observation = { signedInBefore: Boolean(before), statusAfter: after.status, codeAfter: code };
  return {
    check: { deniedAfterRevocation: Boolean(before) && [401, 403].includes(after.status) && /^ALPHA_/.test(code) },
    observation
  };
}

async function disconnectDrill(context) {
  const tester = await provisionTester(context, 'disconnect', context.credentials.readOnly);
  const before = await signedIn(tester);
  const heldCookie = tester.app.snapshot();
  const disconnected = await tester.app.send('POST', '/api/alpha/providers/disconnect-all', { csrf: true, body: {} });
  const cleared = !tester.app.has('nv_session');
  const replay = await tester.app.send('GET', '/api/me', { cookie: heldCookie });
  const observation = { signedInBefore: Boolean(before), disconnectStatus: disconnected.status, cookieCleared: cleared, replayStatus: replay.status };
  return {
    check: { browserStatePurged: Boolean(before) && disconnected.status === 200 && cleared && replay.status === 401 },
    observation
  };
}

/* A restart drill that also proves what survives one: the session lives in the database, not on the instance. */
async function restartDrill(context) {
  const { deps, render, base } = context;
  const tester = await provisionTester(context, 'restart', context.credentials.readOnly);
  const login = await signedIn(tester);
  const health = async () => (await request(deps, `${base}/healthz`, { timeoutMs: 10000 })).data;
  const before = await health();
  const bootBefore = before && before.bootId;
  if (!/^[0-9a-f-]{36}$/.test(String(bootBefore || ''))) fail('the deployment does not name its boot');
  await render.restart();
  const restarted = await poll(deps, { timeoutMs: LIMITS.restartMs, intervalMs: 5000 }, async () => {
    const now = await health();
    return now && now.ok === true && now.bootId && now.bootId !== bootBefore ? now.bootId : null;
  });
  const ready = await poll(deps, { timeoutMs: LIMITS.recoveryMs }, async () => {
    const answer = await request(deps, `${base}/readyz`, { timeoutMs: 15000 });
    return answer.status === 200 && answer.data && answer.data.database === 'connected';
  });
  const after = await signedIn(tester);
  const observation = { bootChanged: Boolean(restarted.value), probesUntilNewBoot: restarted.attempts, ready: Boolean(ready.value), sessionKept: Boolean(login) && after === login };
  return {
    restart: { restartObserved: Boolean(restarted.value) && Boolean(ready.value) },
    filesystem: { stateRecoveredFromDatabase: Boolean(restarted.value) && Boolean(login) && after === login },
    tester,
    observation
  };
}

async function wakeDrill(context, tester) {
  const { deps, neon, base } = context;
  const endpoint = await neon.endpoint();
  await neon.suspend(endpoint.id);
  const idle = await poll(deps, { timeoutMs: LIMITS.suspendMs }, async () => (await neon.endpoint()).current_state === 'idle');
  if (!idle.value) fail('the cohort compute did not suspend');
  let attempts = 0;
  let woke = false;
  while (attempts < LIMITS.wakeAttempts && !woke) {
    attempts += 1;
    const answer = await request(deps, `${base}/readyz`, { timeoutMs: 20000 }).catch(() => null);
    woke = Boolean(answer && answer.status === 200 && answer.data && answer.data.database === 'connected');
    if (!woke) await deps.sleep(LIMITS.pollMs);
  }
  const sessionAfter = woke ? await signedIn(tester) : null;
  return {
    check: { wakeRetries: woke && sessionAfter ? attempts : 0 },
    observation: { suspended: true, readinessProbes: attempts, woke, sessionAfterWake: Boolean(sessionAfter) }
  };
}

async function interruptionDrill(context, tester) {
  const { deps, neon, base } = context;
  const endpoint = await neon.endpoint();
  let disabled = false;
  const observation = { readyDuring: null, sessionDuring: null, readyAfter: false, sessionAfter: false };
  try {
    await neon.setDisabled(endpoint.id, true);
    disabled = true;
    /* The pool may hold a connection for a moment; the interruption is what a request after that meets. */
    const during = await poll(deps, { timeoutMs: LIMITS.interruptionMs, intervalMs: 5000 }, async () => {
      const ready = await request(deps, `${base}/readyz`, { timeoutMs: 20000 });
      return ready.status !== 200 ? ready : null;
    });
    observation.readyDuring = during.value ? during.value.status : 200;
    const session = await tester.app.send('GET', '/api/me', { timeoutMs: 30000 });
    observation.sessionDuring = session.status;
  } finally {
    if (disabled) await neon.setDisabled(endpoint.id, false);
  }
  const recovered = await poll(deps, { timeoutMs: LIMITS.recoveryMs }, async () => {
    const answer = await request(deps, `${base}/readyz`, { timeoutMs: 20000 });
    return answer.status === 200 && answer.data && answer.data.database === 'connected';
  });
  observation.readyAfter = Boolean(recovered.value);
  observation.sessionAfter = Boolean(await signedIn(tester));
  return {
    check: {
      failClosedDuringInterruption: observation.readyDuring === 503 && observation.sessionDuring === 503
        && observation.readyAfter && observation.sessionAfter
    },
    observation
  };
}

async function rollbackDrill(context) {
  const { deps, render, base } = context;
  const fingerprint = async () => {
    const answer = await request(deps, `${base}/api/version`, { timeoutMs: 15000 }).catch(() => null);
    return answer && answer.status === 200 && answer.data ? String(answer.data.releaseTreeSha256 || '') : '';
  };
  async function deployAndWait(commitId) {
    const id = await render.deploy(commitId);
    const settled = await poll(deps, { timeoutMs: LIMITS.deployMs, intervalMs: 10000 }, async () => {
      const deploy = await render.deployStatus(id);
      const status = String(deploy && deploy.status || '');
      if (/failed|canceled|deactivated/.test(status)) fail(`the deploy of ${commitId.slice(0, 7)} ended ${status}`);
      return status === 'live';
    });
    if (!settled.value) fail(`the deploy of ${commitId.slice(0, 7)} did not go live`);
  }
  const observation = { parentServed: false, candidateRestored: false };
  let restored = false;
  try {
    await deployAndWait(context.sourceParent);
    const previous = await poll(deps, { timeoutMs: LIMITS.restartMs, intervalMs: 5000 }, async () => {
      const value = await fingerprint();
      return value && value !== context.candidateFingerprint ? value : null;
    });
    observation.parentServed = Boolean(previous.value);
  } finally {
    await deployAndWait(context.sourceCommit);
    const current = await poll(deps, { timeoutMs: LIMITS.restartMs, intervalMs: 5000 }, async () => (await fingerprint()) === context.candidateFingerprint);
    restored = Boolean(current.value);
    observation.candidateRestored = restored;
  }
  return { check: { candidateRestored: observation.parentServed && restored }, observation };
}

/*
 * Last, and alone. Every CI credential is one GitHub account, so every drill
 * tester shares one identity; the purge removes a token-bearing session only
 * when no active tester still holds that identity. The others are revoked
 * first, which is also how the run cleans up after itself.
 */
async function purgeDrill(context) {
  for (const tester of context.testers) await revoke(context, tester);
  const tester = await provisionTester(context, 'purge', context.credentials.readOnly);
  const login = await signedIn(tester);
  const purged = await tester.app.send('POST', '/api/alpha/delete', { csrf: true, body: { confirm: DELETION_CONFIRMATION } });
  tester.revoked = true;
  const identity = hashJson({ provider: 'github', baseUrl: '', login: login || '' });
  const sessions = await context.pool.query('SELECT count(*)::int AS n FROM nv_sessions WHERE identity_keys && $1::text[]', [[identity]]);
  const alphaSessions = await context.pool.query(
    'SELECT count(*)::int AS n FROM nv_alpha_sessions WHERE tester_id=$1 AND revoked_at IS NULL', [tester.testerId]);
  const report = purged.data || {};
  const observation = {
    deleteStatus: purged.status, purgeStatus: report.status || null, providerCleanupVerified: report.providerCleanupVerified === true,
    providerSessionsRemaining: sessions.rows[0].n, activeAlphaSessions: alphaSessions.rows[0].n
  };
  return {
    check: {
      tokenBearingStateRemoved: Boolean(login) && purged.status === 200 && report.status === 'complete'
        && report.providerCleanupVerified === true && sessions.rows[0].n === 0 && alphaSessions.rows[0].n === 0
    },
    observation
  };
}

/* ---- The run --------------------------------------------------------------- */

/*
 * A free-plan service spins down when idle and takes longer to answer its
 * first request than any drill bound allows, so the target is woken first.
 */
/*
 * A check passes when every claim it makes holds, and its status says so: a
 * line in the log that reads "pass" beside a false claim is a line that lies.
 */
function claimHolds(key, value) {
  return key === 'wakeRetries' ? Number.isSafeInteger(value) && value > 0 : value === true;
}
function judged(claims) {
  const holds = Object.keys(claims).length > 0 && Object.entries(claims).every(([key, value]) => claimHolds(key, value));
  return Object.freeze({ status: holds ? 'pass' : 'fail', ...claims });
}

async function wake(deps, base) {
  const awake = await poll(deps, { timeoutMs: 4 * 60 * 1000, intervalMs: 5000 }, async () => {
    const answer = await request(deps, `${base}/healthz`, { timeoutMs: 60000 });
    return answer.status === 200 && answer.data && answer.data.ok === true;
  });
  if (!awake.value) fail('the target did not answer its health check', 'ALPHA17_DRILL_TARGET_REFUSED');
}

/*
 * A deployment that serves live events: one whose registry calls them
 * Supported, as every deployment's has since the hosted gate proved them, or
 * one that names them as served ahead of their proof (the staging
 * qualification switch, which no capability awaits now). Serving them does
 * not make a deployment a drill target: production serves them too, and is
 * refused because it deploys on its own.
 */
async function servesLiveEvents(deps, base, config) {
  const qualification = config && config.qualification;
  if (qualification && Array.isArray(qualification.capabilities) && qualification.capabilities.includes('live-events')) return true;
  const capabilities = await request(deps, `${base}/api/capabilities?provider=github`);
  const feature = capabilities.data && capabilities.data.features && capabilities.data.features['live-events'];
  return capabilities.status === 200 && Boolean(feature) && feature.status === 'Supported';
}

function readConfiguration(env) {
  return Object.freeze({
    base: requireOrigin(env, 'NV_ALPHA_BASE_URL'),
    renderServiceId: requirePattern(env, 'NV_ALPHA17_RENDER_SERVICE_ID', /^srv-[a-z0-9]+$/),
    renderApiKey: requireEnv(env, 'RENDER_API_KEY'),
    neonProjectId: requirePattern(env, 'NV_ALPHA17_NEON_PROJECT_ID', /^[a-z0-9-]{1,60}$/),
    cohortBranchId: requirePattern(env, 'NV_ALPHA17_COHORT_NEON_BRANCH_ID', /^br-[a-z0-9-]+$/),
    neonApiKey: requireEnv(env, 'NEON_API_KEY'),
    repository: requirePattern(env, 'NV_ALPHA17_REPOSITORY', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    mutation: requireEnv(env, 'NV_ALPHA17_MUTATION_CREDENTIAL'),
    readOnly: requireEnv(env, 'NV_ALPHA17_READ_ONLY_CREDENTIAL'),
    subjectSha256: requirePattern(env, 'NV_PUBLIC_ALPHA_SUBJECT_SHA256', /^[0-9a-f]{64}$/),
    sourceCommit: requirePattern(env, 'NV_PUBLIC_ALPHA_SOURCE_COMMIT', /^[0-9a-f]{40}$/),
    sourceParent: requirePattern(env, 'NV_PUBLIC_ALPHA_SOURCE_PARENT', /^[0-9a-f]{40}$/),
    runId: requirePattern(env, 'NV_ALPHA17_WORKFLOW_RUN_ID', /^\d{1,20}$/)
  });
}

async function runHostedDrills(options = {}) {
  const env = options.env || process.env;
  const deps = Object.freeze({
    fetch: options.fetch || globalThis.fetch,
    sleep: options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms))),
    now: options.now || (() => Date.now()),
    createPool: options.createPool || (connectionString => new Pool({ connectionString, max: 2 })),
    log: options.log || (line => process.stderr.write(`${line}\n`))
  });
  const config = readConfiguration(env);
  const candidateFingerprint = options.candidateFingerprint
    || computeReleaseFingerprint(options.releaseRoot || path.resolve(__dirname, '..'), { requireClean: true });
  const render = renderClient(deps, config.renderApiKey, config.renderServiceId);
  const neon = neonClient(deps, config.neonApiKey, config.neonProjectId, config.cohortBranchId);

  /* The target, before anything is changed on it. */
  const service = await render.service();
  if (!service || service.autoDeploy !== 'no') fail('the target service deploys on its own; drills run only against a staging service', 'ALPHA17_DRILL_TARGET_REFUSED');
  await wake(deps, config.base);
  const served = await request(deps, `${config.base}/api/config`);
  if (served.status !== 200 || !(await servesLiveEvents(deps, config.base, served.data))) {
    fail('the target does not declare itself a qualification deployment', 'ALPHA17_DRILL_TARGET_REFUSED');
  }
  const version = await request(deps, `${config.base}/api/version`);
  if (!version.data || version.data.releaseTreeSha256 !== candidateFingerprint) {
    fail('the target is not serving the candidate this checkout builds', 'ALPHA17_DRILL_TARGET_REFUSED');
  }
  const termsVersion = String(served.data.termsVersion || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(termsVersion)) fail('the target names no terms version');

  const serviceEnv = await render.environment();
  const databaseUrl = String(serviceEnv.DATABASE_URL || '');
  const pepper = String(serviceEnv.NV_ALPHA_INVITE_PEPPER || '');
  if (!databaseUrl || !pepper) fail('the target service names no database or invitation pepper');
  const pool = deps.createPool(databaseUrl);
  const context = {
    deps, base: config.base, repository: config.repository, runId: config.runId, termsVersion,
    render, neon, pool, testers: [], candidateFingerprint,
    sourceCommit: config.sourceCommit, sourceParent: config.sourceParent,
    credentials: { mutation: config.mutation, readOnly: config.readOnly },
    github: { mutation: githubClient(deps, config.mutation, config.repository) },
    store: options.createStore ? options.createStore(pool, pepper) : new AlphaAccessStore({ pool, pepper })
  };

  const checks = {};
  const observations = {};
  const record = (key, result) => { checks[key] = judged(result.check); observations[key] = result.observation; deps.log(`drill ${key}: ${JSON.stringify(checks[key])}`); };
  try {
    record('live-events-delivery', await liveEventsDrill(context));
    record('provider-429-outage', await rateLimitDrill(context));
    record('active-session-revocation', await revocationDrill(context));
    record('provider-disconnect', await disconnectDrill(context));
    const restarted = await restartDrill(context);
    checks['memory-restart-observation'] = judged(restarted.restart);
    checks['ephemeral-filesystem-restart'] = judged(restarted.filesystem);
    observations['memory-restart-observation'] = restarted.observation;
    deps.log(`drill memory-restart-observation: ${JSON.stringify(checks['memory-restart-observation'])}`);
    deps.log(`drill ephemeral-filesystem-restart: ${JSON.stringify(checks['ephemeral-filesystem-restart'])}`);
    record('neon-scale-to-zero-wake', await wakeDrill(context, restarted.tester));
    record('database-interruption-recovery', await interruptionDrill(context, restarted.tester));
    record('application-rollback', await rollbackDrill(context));
    record('disposable-tester-purge', await purgeDrill(context));
  } finally {
    for (const tester of context.testers) await revoke(context, tester).catch(() => {});
  }

  /* Cleanup is a claim the record makes, so it is checked rather than assumed. */
  const endpoint = await neon.endpoint();
  const leftoverHooks = (await context.github.mutation.hooks())
    .filter(hook => String(hook.config && hook.config.url || '').startsWith(`${config.base}/hooks/github/`));
  const finalVersion = await request(deps, `${config.base}/api/version`);
  const activeTesters = await pool.query(
    'SELECT count(*)::int AS n FROM nv_alpha_testers WHERE tester_label LIKE $1 AND revoked_at IS NULL', [`alpha17 drill ${config.runId} %`]);
  await pool.end().catch(() => {});
  const cleanup = {
    computeEnabled: endpoint.disabled === false,
    webhooksLeft: leftoverHooks.length,
    candidateServed: Boolean(finalVersion.data && finalVersion.data.releaseTreeSha256 === candidateFingerprint),
    testersActive: activeTesters.rows[0].n
  };
  const cleanupVerified = cleanup.computeEnabled && cleanup.webhooksLeft === 0 && cleanup.candidateServed && cleanup.testersActive === 0;
  const passed = Object.values(checks).every(check => check.status === 'pass');
  const completedAt = new Date(deps.now()).toISOString();
  return Object.freeze({
    ok: passed && cleanupVerified,
    record: {
      schemaVersion: SCHEMA_VERSION,
      subjectSha256: config.subjectSha256,
      sourceCommit: config.sourceCommit,
      completedAt,
      cleanupVerified,
      checks
    },
    observations,
    cleanup,
    runId: config.runId,
    deploymentSha256: candidateFingerprint
  });
}

if (require.main === module) {
  runHostedDrills().then(result => {
    /* One line the operator copies, between markers a reader can find in the job log. */
    process.stdout.write(`ALPHA17_DRILL_REPORT_BEGIN\n${JSON.stringify(result)}\nALPHA17_DRILL_REPORT_END\n`);
    if (!result.ok) process.exitCode = 1;
  }, error => {
    process.stderr.write(`${error.code ? `${error.code}: ` : ''}${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = Object.freeze({
  runHostedDrills, LIMITS, SCHEMA_VERSION, DrillError,
  /* Shared with ci/run-alpha17-hosted-testers.js, which signs testers in the same way. */
  appClient, awaitFrame, renderClient, request, poll, wake, provisionTester, revoke, signedIn, fail, requireEnv, requirePattern, requireOrigin
});
