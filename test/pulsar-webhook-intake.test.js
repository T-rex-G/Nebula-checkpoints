'use strict';
/*
 * A GitHub webhook delivery, received (Pulsar): the sender's rate, every
 * check a delivery passes or fails, what is stored, recorded and broadcast,
 * and the address GitHub is given to deliver to.
 */
const assert = require('assert');
const crypto = require('crypto');
const {
  WEBHOOK_RATE_LIMIT, WEBHOOK_RATE_WINDOW_MS, createWebhookIntake, createWebhookLimiter, publicCallbackBase
} = require('../apps/api/src/modules/pulsar/index.ts');
const { scopedEvidenceKey } = require('../apps/api/src/modules/corona/index.ts');
const { hashJson } = require('../apps/api/src/platform/values/stable-hash.ts');

let finished = false;
process.on('exit', code => { if (!finished && code === 0) { console.error('the webhook intake tests did not finish'); process.exitCode = 1; } });

/* ---- The sender's rate ----------------------------------------------------------- */
async function limiterTests() {
  assert.deepStrictEqual([WEBHOOK_RATE_LIMIT, WEBHOOK_RATE_WINDOW_MS], [120, 60000]);
  let clock = 1_000_000;
  const now = () => clock;
  const answers = [];
  const counted = [];
  let shared = null;
  const store = { async count(request) { counted.push(request); const answer = answers.shift(); if (answer instanceof Error) throw answer; return answer; } };
  const limiter = createWebhookLimiter({ counter: () => shared, now });
  const allow = (ip, hook = 'h1') => limiter.allowWebhookRequest({ ip }, hook);

  /* Alone: 120 a minute for one sender and hook. */
  const results = [];
  for (let i = 0; i < 121; i += 1) results.push(await allow('1.1.1.1'));
  assert.deepStrictEqual([results.slice(0, 120).every(Boolean), results[120]], [true, false]);
  assert.strictEqual(await allow('1.1.1.1', 'h2'), true, 'each hook has its own bucket');
  assert.strictEqual(await allow('2.2.2.2'), true, 'and each sender');
  clock += WEBHOOK_RATE_WINDOW_MS - 1;
  assert.strictEqual(await allow('1.1.1.1'), false, 'the window has not passed');
  clock += 1;
  assert.strictEqual(await allow('1.1.1.1'), true, 'it reopens once sixty seconds have passed');

  /* With the shared counter. */
  shared = store;
  clock += 2 * WEBHOOK_RATE_WINDOW_MS;
  answers.push({ allowed: true });
  assert.strictEqual(await allow('x'.repeat(100), 'h9'), true);
  assert.deepStrictEqual(counted.at(-1), { namespace: 'webhook', key: `${'x'.repeat(80)}|h9`, windowMs: 60000, limit: 120, inclusiveReset: true });
  answers.push({ allowed: true });
  await allow(undefined, 'h9');
  assert.strictEqual(counted.at(-1).key, 'unknown|h9');
  answers.push({ allowed: false });
  assert.strictEqual(await allow('3.3.3.3'), false, 'the shared counter refuses');
  const asked = counted.length;
  answers.push({ allowed: true });
  assert.strictEqual(await allow('3.3.3.3'), false, 'a refusal holds for the rest of the window without asking again');
  assert.strictEqual(counted.length, asked);
  answers.length = 0;
  clock += WEBHOOK_RATE_WINDOW_MS;
  answers.push({ allowed: true });
  assert.strictEqual(await allow('3.3.3.3'), true, 'and lifts with it');
  answers.push(new Error('counter down'));
  assert.strictEqual(await allow('4.4.4.4'), false, 'an unanswerable counter is not permission');
  answers.push({ allowed: true });
  assert.strictEqual(await allow('4.4.4.4'), true, 'nor is it held as a refusal');

  /* Past the limit and thirty more, the local bucket refuses without asking. */
  clock += WEBHOOK_RATE_WINDOW_MS;
  for (let i = 0; i < 150; i += 1) answers.push({ allowed: true });
  for (let i = 0; i < 150; i += 1) assert.strictEqual(await allow('5.5.5.5'), true, `delivery ${i + 1}`);
  const before = counted.length;
  answers.push({ allowed: true });
  assert.strictEqual(await allow('5.5.5.5'), false);
  assert.strictEqual(counted.length, before, 'the 151st is refused before the counter');
  answers.length = 0;

  /* The sweep: past 2,000 senders, those two windows old go, and only those. */
  shared = null;
  clock += 10 * WEBHOOK_RATE_WINDOW_MS;
  const sweep = createWebhookLimiter({ counter: () => null, now });
  for (let i = 0; i < 120; i += 1) await sweep.allowWebhookRequest({ ip: 'busy' }, 'h');
  for (let i = 0; i < 1999; i += 1) await sweep.allowWebhookRequest({ ip: `old-${i}` }, 'h');
  assert.strictEqual(sweep.tracked(), 2000);
  clock += 2 * WEBHOOK_RATE_WINDOW_MS - 1;
  await sweep.allowWebhookRequest({ ip: 'new-1' }, 'h');
  assert.strictEqual(sweep.tracked(), 2001, 'nothing is two windows old yet');
  clock += 1;
  await sweep.allowWebhookRequest({ ip: 'new-2' }, 'h');
  assert.strictEqual(sweep.tracked(), 2, 'the old ones are swept; the fresh ones stay');
  const fresh = createWebhookLimiter({ counter: () => null, now });
  for (let i = 0; i < 120; i += 1) await fresh.allowWebhookRequest({ ip: 'busy' }, 'h');
  for (let i = 0; i < 2000; i += 1) await fresh.allowWebhookRequest({ ip: `s-${i}` }, 'h');
  assert.strictEqual(await fresh.allowWebhookRequest({ ip: 'busy' }, 'h'), false, 'a fresh bucket survives the sweep');
  assert.strictEqual(createWebhookLimiter({ counter: () => null }).tracked(), 0);
  assert.strictEqual(await createWebhookLimiter({ counter: () => null }).allowWebhookRequest({ ip: 'a' }, 'h'), true, 'the real clock by default');
}

/* ---- A delivery ------------------------------------------------------------------- */
const HOOK = 'ab'.repeat(16);
const SECRET = 'hook-secret';
const IDENTITY = 'github:alice';

function world(options = {}) {
  const calls = [];
  const settings = {
    allow: true, ready: true, hook: { hook_id: HOOK, owner: 'alice', repo: 'demo', identity_key: IDENTITY, secret_enc: 'sealed', active: true },
    unsealed: { secret: SECRET }, patterns: [], insert: { rowCount: 1, rows: [{ created_at: 'stored-at' }] }, evidence: { deduplicated: false },
    ...options
  };
  const intake = createWebhookIntake({
    allow: async (req, hookId) => { calls.push(['allow', req.ip, hookId]); return settings.allow; },
    ready: async () => { calls.push(['ready']); return settings.ready; },
    pool: () => ({
      async query(text, values) {
        const sql = text.replace(/\s+/g, ' ').trim();
        calls.push(['query', sql, values]);
        if (sql.startsWith('SELECT hook_id')) return { rows: settings.hook ? [settings.hook] : [] };
        if (sql.startsWith('INSERT INTO nv_intelligence_events')) {
          if (settings.insert instanceof Error) throw settings.insert;
          return settings.insert;
        }
        throw new Error(`unexpected ${sql}`);
      }
    }),
    unseal: sealed => { calls.push(['unseal', sealed]); return settings.unsealed; },
    protectedPatternsForIdentity: async (identity, owner, repo) => {
      calls.push(['patterns', identity, owner, repo]);
      if (settings.patterns instanceof Error) throw settings.patterns;
      return settings.patterns;
    },
    evidenceKey: scopedEvidenceKey,
    appendEvidence: async (key, kind, id, payload) => {
      calls.push(['append', key, kind, id, payload]);
      if (settings.evidence instanceof Error) throw settings.evidence;
      return settings.evidence;
    },
    liveHub: { broadcast(key, payload) { calls.push(['broadcast', key, payload]); } }
  });
  return { intake, calls, settings };
}

const PUSH = {
  ref: 'refs/heads/main', before: 'a'.repeat(40), after: 'b'.repeat(40),
  repository: { name: 'demo', full_name: 'alice/demo', owner: { login: 'alice' }, default_branch: 'main' },
  sender: { login: 'carol' }, commits: [{ added: ['src/a.js'], modified: [], removed: [] }]
};

async function deliver(w, { event = 'push', payload = PUSH, raw, sign = SECRET, signature, delivery = 'd-1', hookId = HOOK, bodyAs = 'buffer', ip = '9.9.9.9' } = {}) {
  const bytes = Buffer.from(raw === undefined ? JSON.stringify(payload) : raw);
  const headers = {};
  if (signature !== null) headers['x-hub-signature-256'] = signature || `sha256=${crypto.createHmac('sha256', sign).update(bytes).digest('hex')}`;
  if (delivery) headers['x-github-delivery'] = delivery;
  if (event) headers['x-github-event'] = event;
  const answer = {};
  const res = {
    status(code) { answer.status = code; return res; },
    json(body) { answer.body = body; return res; },
    end() { answer.ended = true; return res; }
  };
  const returned = await w.intake.receiveGithubWebhook({ params: { hookId }, headers, body: bodyAs === 'buffer' ? bytes : bytes.toString('utf8'), ip }, res);
  return { ...answer, returned };
}

async function intakeTests() {
  /* A delivery that passes every check. */
  {
    const w = world({ patterns: ['src'] });
    const answer = await deliver(w);
    assert.deepStrictEqual(answer, { status: 202, body: { ok: true, accepted: true, event: 'push' }, returned: undefined });
    const stored = hashJson({ identityKey: IDENTITY, deliveryId: 'd-1' });
    const insert = w.calls.find(call => call[0] === 'query' && call[1].startsWith('INSERT'));
    assert.deepStrictEqual(w.calls.slice(0, 5), [
      ['allow', '9.9.9.9', HOOK], ['ready'],
      ['query', 'SELECT hook_id,owner,repo,identity_key,secret_enc,active FROM nv_webhooks WHERE hook_id=$1 AND provider=$2', [HOOK, 'github']],
      ['unseal', 'sealed'], ['patterns', IDENTITY, 'alice', 'demo']
    ]);
    const values = insert[2];
    assert.deepStrictEqual(values.slice(0, 13), [stored, 'github', 'alice', 'demo', IDENTITY, 'push', '', 'carol', 'branch', 'main', 'main', 'a'.repeat(40), 'b'.repeat(40)]);
    assert.strictEqual(values[19], 'd-1');
    const metadata = JSON.parse(values[18]);
    assert.deepStrictEqual([metadata.providerEventId, metadata.rawPayloadHash], ['d-1', crypto.createHash('sha256').update(JSON.stringify(PUSH)).digest('hex')]);
    const reasons = JSON.parse(values[15]).map(reason => reason.code);
    assert(reasons.includes('DEFAULT_BRANCH_WRITE'), 'the default branch is the event\'s');
    assert(reasons.some(code => /PROTECTED/.test(code)), 'the identity\'s protected paths score the event');
    const append = w.calls.find(call => call[0] === 'append');
    assert.deepStrictEqual(append.slice(1, 4), ['github:alice/demo:github:alice', 'webhook', stored]);
    assert.deepStrictEqual([append[4].id, append[4].providerEventId, append[4].createdAt, append[4].owner, append[4].repo], [stored, 'd-1', 'stored-at', 'alice', 'demo']);
    const broadcast = w.calls.find(call => call[0] === 'broadcast');
    assert.strictEqual(broadcast[1], 'github:alice/demo:github:alice', 'the event reaches the identity\'s own streams');
    assert.strictEqual(broadcast[2], `id: ${stored}\nevent: intelligence\ndata: ${JSON.stringify(append[4])}\n\n`);

    const unprotected = world({ patterns: [] });
    await deliver(unprotected);
    const plain = unprotected.calls.find(call => call[0] === 'query' && call[1].startsWith('INSERT'))[2];
    assert(plain[14] < values[14], 'the protected path raised the score');
  }
  {
    const w = world();
    const ping = await deliver(w, { event: 'ping', payload: { zen: 'z', hook_id: 1, repository: { name: 'Demo', owner: { login: 'ALICE' } } } });
    assert.deepStrictEqual([ping.status, ping.body], [200, { ok: true, accepted: true, event: 'ping' }], 'a ping is answered 200, and the repository is matched without regard to case');
    const asString = await deliver(world(), { bodyAs: 'string' });
    assert.strictEqual(asString.status, 202, 'a body that arrived as text is read as its bytes');
    const upper = await deliver(world(), { hookId: HOOK.toUpperCase() });
    assert.strictEqual(upper.status, 202);
    const longest = world({ hook: null });
    assert.strictEqual((await deliver(longest, { hookId: 'a'.repeat(64) })).status, 404);
    assert.deepStrictEqual(longest.calls[0], ['allow', '9.9.9.9', 'a'.repeat(64)], 'a 64-character id is looked up');
  }
  {
    /* A redelivery: stored already, its evidence recorded already. */
    const again = world({ insert: { rowCount: 0, rows: [] }, evidence: { deduplicated: true } });
    const answer = await deliver(again);
    assert.deepStrictEqual(answer.body, { ok: true, accepted: false, event: 'push' });
    assert(!again.calls.some(call => call[0] === 'broadcast'), 'a redelivery is not broadcast again');
    assert.strictEqual(again.calls.find(call => call[0] === 'append')[4].createdAt, new Date(again.calls.find(call => call[0] === 'append')[4].createdAt).toISOString(), 'with nothing stored, the time is now');
    /* Stored, but its evidence failed before: the retry completes the chain and broadcasts. */
    const completing = world({ insert: { rowCount: 0, rows: [] }, evidence: { deduplicated: false } });
    await deliver(completing);
    assert(completing.calls.some(call => call[0] === 'broadcast'));
  }

  /* Every refusal, and what it does not reach. */
  const refused = async (options, delivery, status, body) => {
    const w = world(options);
    const answer = await deliver(w, delivery);
    assert.strictEqual(answer.status, status, JSON.stringify(delivery));
    if (body === 'end') assert.strictEqual(answer.ended, true);
    else assert.deepStrictEqual(answer.body, body);
    assert(!w.calls.some(call => call[0] === 'append' || call[0] === 'broadcast'), 'a refused delivery records nothing');
    return w;
  };
  for (const hookId of ['ab'.repeat(15), 'a'.repeat(65), 'g'.repeat(32), '']) {
    const w = await refused({}, { hookId }, 404, 'end');
    assert.deepStrictEqual(w.calls, [], 'a malformed hook id is refused before anything is asked');
  }
  const limited = await refused({ allow: false }, {}, 429, { error: 'Webhook delivery rate exceeded' });
  assert.deepStrictEqual(limited.calls, [['allow', '9.9.9.9', HOOK]]);
  const down = await refused({ ready: false }, {}, 503, { error: 'Live events require the existing Neon DATABASE_URL' });
  assert(!down.calls.some(call => call[0] === 'query'));
  await refused({ hook: null }, {}, 404, 'end');
  await refused({ hook: { hook_id: HOOK, owner: 'alice', repo: 'demo', identity_key: IDENTITY, secret_enc: 's', active: false } }, {}, 404, 'end');
  await refused({ unsealed: null }, {}, 401, { error: 'Invalid webhook signature' });
  await refused({}, { sign: 'another secret' }, 401, { error: 'Invalid webhook signature' });
  await refused({}, { signature: null }, 401, { error: 'Invalid webhook signature' });
  await refused({}, { delivery: '' }, 400, { error: 'Missing GitHub delivery headers' });
  await refused({}, { event: '' }, 400, { error: 'Missing GitHub delivery headers' });
  await refused({}, { raw: '{not json' }, 400, { error: 'Invalid JSON payload' });
  await refused({}, { payload: { ...PUSH, repository: { ...PUSH.repository, name: 'other' } } }, 409, { error: 'Webhook repository mismatch' });
  await refused({}, { payload: { ...PUSH, repository: { ...PUSH.repository, owner: { login: 'mallory' } } } }, 409, { error: 'Webhook repository mismatch' });
  {
    const w = world();
    const long = await deliver(w, { event: 'x'.repeat(90) });
    assert.strictEqual(long.body.event, 'x'.repeat(80), 'the event name is bounded');
  }

  /* A failure past the checks: answered without detail, logged by message only. */
  const logged = [];
  const saved = console.error;
  console.error = (...args) => logged.push(args.map(String));
  try {
    for (const options of [{ patterns: new Error('safety read failed') }, { insert: new Error('insert failed') }, { evidence: new Error('append failed') }, { evidence: null, insert: { rowCount: 0, rows: [] } }]) {
      const w = world(options);
      const answer = await deliver(w);
      assert.deepStrictEqual([answer.status, answer.body], [500, { error: 'Webhook intake failed' }]);
      assert(!w.calls.some(call => call[0] === 'broadcast'));
    }
  } finally { console.error = saved; }
  assert.deepStrictEqual(logged.map(line => line[0]), Array(4).fill('Webhook intake failed:'));
  assert.deepStrictEqual(logged.slice(0, 3).map(line => line[1]), ['safety read failed', 'insert failed', 'append failed']);
}

/* ---- The address GitHub delivers to ---------------------------------------------------- */
function callbackTests() {
  const local = { protocol: 'http', get: name => (name === 'host' ? 'localhost:3000' : undefined) };
  const refusal = message => error => { assert.deepStrictEqual([error.message, error.status], [message, 400]); return true; };
  assert.strictEqual(publicCallbackBase(local, {}), 'http://localhost:3000');
  assert.strictEqual(publicCallbackBase(local, { PUBLIC_BASE_URL: 'https://x.example//' }), 'https://x.example');
  assert.strictEqual(publicCallbackBase(local, { RENDER_EXTERNAL_URL: 'https://r.example/' }), 'https://r.example');
  assert.strictEqual(publicCallbackBase(local, { PUBLIC_BASE_URL: 'https://x.example', RENDER_EXTERNAL_URL: 'https://r.example' }), 'https://x.example');
  assert.strictEqual(publicCallbackBase(local, { PUBLIC_BASE_URL: 'https://X.example/a/', NODE_ENV: 'production' }), 'https://X.example/a', 'the address is given as configured');
  assert.throws(() => publicCallbackBase(local, { NODE_ENV: 'production' }), refusal('Set PUBLIC_BASE_URL for verified live events on non-Render production hosts'));
  assert.throws(() => publicCallbackBase(local, { NODE_ENV: 'production', PUBLIC_BASE_URL: 'http://x.example' }), refusal('Live events require an HTTPS public URL'));
  assert.strictEqual(publicCallbackBase(local, { PUBLIC_BASE_URL: 'http://x.example' }), 'http://x.example', 'plain HTTP outside production');
  assert.throws(() => publicCallbackBase(local, { PUBLIC_BASE_URL: 'https://user:pw@x.example' }), refusal('Invalid public callback URL'));
  assert.throws(() => publicCallbackBase(local, { PUBLIC_BASE_URL: 'https://:pw@x.example' }), refusal('Invalid public callback URL'));
  assert.throws(() => publicCallbackBase(local, { PUBLIC_BASE_URL: 'ftp://x.example' }), refusal('Invalid public callback URL'));
  assert.throws(() => publicCallbackBase({ protocol: 'gopher', get: () => 'h' }, {}), refusal('Invalid public callback URL'));
  assert.throws(() => publicCallbackBase(local, { PUBLIC_BASE_URL: 'not a url' }), TypeError);
}

(async () => {
  await limiterTests();
  await intakeTests();
  callbackTests();
  finished = true;
  console.log('Pulsar webhook intake tests passed');
})().catch(error => { finished = true; console.error(error); process.exit(1); });
