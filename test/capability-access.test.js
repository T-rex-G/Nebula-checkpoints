'use strict';
/*
 * What the account can do here (the platform's capability access): the
 * context a feature is resolved in, the capability map the page reads, the
 * route guards and their refusals, and LFS's own rule -- against a scripted
 * registry that answers as each case needs, and once against the real one.
 */
const assert = require('assert');
const path = require('path');
const { createCapabilityAccess } = require('../apps/api/src/platform/authorization/capability-access.ts');
const registry = require('../src/capability-registry.js');
const { providerAuthority } = require('../apps/api/src/modules/identity-access/index.ts');
const { githubTokenKind } = require('../apps/api/src/modules/github-provider/index.ts');

class CapabilityError extends Error {
  constructor(message, code, status = 409) { super(message); this.code = code; this.status = status; }
}

function harness(answers = {}) {
  const calls = [];
  const access = createCapabilityAccess({
    document: { id: 'document' }, qualification: ['lfs'], deployment: 'hosted-alpha',
    registry: {
      resolveCapability(document, context) { calls.push(['resolve', document, context]); return { status: (answers.status && answers.status(context)) || 'Supported' }; },
      assertCapabilityAvailable(...args) { calls.push(['assert', ...args]); if (answers.refuse) throw answers.refuse(args[1]); return { granted: args[1].feature }; },
      legacyCapsFor(document, context) { calls.push(['legacy', document, context]); return { repos: true }; },
      CapabilityError
    },
    providerAuthority: account => (account && account.baseUrl ? 'ghe.example' : 'github.com'),
    githubTokenKind: account => (account && account.token ? 'classic' : 'none')
  });
  return { ...access, calls };
}
const ALICE = { provider: 'github', login: 'alice', token: 't', authMethod: 'token' };
function guard(fn, req) {
  const answer = { next: 0 };
  const res = { status(code) { answer.status = code; return res; }, json(body) { answer.body = body; } };
  fn(req, res, () => { answer.next += 1; });
  return answer;
}

/* ---- The context ------------------------------------------------------------------- */
{
  const h = harness();
  assert.deepStrictEqual(h.providerCapabilityContext(ALICE, 'search'), { provider: 'github', authority: 'github.com', deployment: 'hosted-alpha', feature: 'search', authMethod: 'token', tokenKind: 'classic' });
  assert.deepStrictEqual(h.providerCapabilityContext({ login: 'x' }, 'lfs'), { provider: 'github', authority: 'github.com', deployment: 'hosted-alpha', feature: 'lfs', authMethod: undefined, tokenKind: 'none' }, 'an account without a provider is GitHub\'s');
  assert.deepStrictEqual(h.providerCapabilityContext(null, 'lfs').tokenKind, 'none');
  assert.strictEqual(h.providerCapabilityContext({ provider: 'gitlab' }, 'x').provider, 'gitlab');
}

/* ---- The map the page reads ------------------------------------------------------------ */
{
  const h = harness({ status: context => (context.feature === 'notifications' ? 'Planned' : 'Supported') });
  assert.deepStrictEqual(h.providerCapabilities(ALICE), { repos: true, notif: true }, 'notifications unless they are unavailable');
  assert.deepStrictEqual(h.calls[0], ['legacy', { id: 'document' }, { provider: 'github', authority: 'github.com', deployment: 'hosted-alpha', authMethod: 'token', tokenKind: 'classic' }]);
  assert.deepStrictEqual(h.calls[1][2].feature, 'notifications');
  const off = harness({ status: () => 'Unavailable' });
  assert.deepStrictEqual(off.providerCapabilities(ALICE), { repos: true, notif: false });
  const app = harness();
  assert.deepStrictEqual(app.providerCapabilities({ ...ALICE, authMethod: 'github-app' }), { repos: true, notif: false }, 'an installation has no notification inbox');
  assert.strictEqual(app.calls.length, 1, 'and is not asked about one');
  const retired = harness();
  assert.strictEqual(retired.providerCapabilities({ provider: 'gitlab', authMethod: 'github-app' }).notif, true, 'only a GitHub installation');
  assert.strictEqual(retired.calls[0][2].provider, 'gitlab');
  assert.strictEqual(harness().providerCapabilities(null).notif, true);
}

/* ---- The route guards -------------------------------------------------------------------- */
{
  const h = harness();
  const req = { gh: ALICE };
  assert.strictEqual(guard(h.capabilityAccess('search'), req).next, 1);
  assert.deepStrictEqual(req.capability, { granted: 'search' }, 'the capability is kept on the request');
  assert.deepStrictEqual(h.calls[0], ['assert', { id: 'document' }, h.providerCapabilityContext(ALICE, 'search'), { qualification: ['lfs'] }], 'a staging deployment\'s qualification is passed on');

  const refusing = harness({ refuse: context => new CapabilityError(`${context.feature} is unavailable`, 'PROVIDER_CAPABILITY_UNAVAILABLE') });
  assert.deepStrictEqual(guard(refusing.capabilityAccess('search'), { gh: ALICE }), { next: 0, status: 409, body: { error: 'search is unavailable', code: 'PROVIDER_CAPABILITY_UNAVAILABLE', feature: 'search' } });
  const own = harness({ refuse: () => new CapabilityError('not here', 'CAPABILITY_REGION', 451) });
  assert.deepStrictEqual(guard(own.capabilityAccess('lfs'), { gh: ALICE }), { next: 0, status: 451, body: { error: 'not here', code: 'CAPABILITY_REGION', feature: 'lfs' } }, 'a refusal keeps its own status and code');
  const malformed = harness({ refuse: () => new TypeError('document is malformed') });
  assert.deepStrictEqual(guard(malformed.capabilityAccess('lfs'), { gh: ALICE }), { next: 0, status: 409, body: { error: 'document is malformed', code: 'PROVIDER_CAPABILITY_UNAVAILABLE', feature: 'lfs' } });

  const when = harness({ refuse: () => new CapabilityError('no', 'X') });
  assert.strictEqual(guard(when.capabilityAccessWhen('lfs', () => false), { gh: ALICE }).next, 1, 'a request that does not need it is not checked');
  assert.strictEqual(when.calls.length, 0);
  assert.strictEqual(guard(when.capabilityAccessWhen('lfs', () => true), { gh: ALICE }).next, 0);

  const supported = harness({ status: context => (context.feature === 'lfs' ? 'Supported' : 'Planned') });
  assert.strictEqual(supported.requestSupportsCapability({ gh: ALICE }, 'lfs'), true);
  assert.strictEqual(supported.requestSupportsCapability({ gh: ALICE }, 'search'), false, 'only what is supported');
  assert.strictEqual(supported.assertProviderCapability(ALICE, 'search').granted, 'search');
}

/* ---- LFS ------------------------------------------------------------------------------------ */
{
  const h = harness();
  assert.deepStrictEqual(h.assertProviderBoundLfs(ALICE), { granted: 'lfs' });
  assert.deepStrictEqual(h.calls[0], ['assert', { id: 'document' }, h.providerCapabilityContext(ALICE, 'lfs')], 'checked by the document too');
  for (const account of [{ provider: 'github', baseUrl: 'https://ghe.example' }, { provider: 'gitea' }]) {
    assert.throws(() => h.assertProviderBoundLfs(account), error => error instanceof CapabilityError && error.message === 'LFS is not qualified for this provider and deployment.' && error.code === 'PROVIDER_CAPABILITY_UNAVAILABLE' && error.status === 409, JSON.stringify(account));
  }
}

/* ---- Against the real document -------------------------------------------------------------- */
{
  const document = registry.loadCapabilityDocument(path.join(__dirname, '..', 'config', 'public-alpha-capabilities.json'));
  const real = createCapabilityAccess({
    document, qualification: [], deployment: 'hosted-alpha',
    registry: { resolveCapability: registry.resolveCapability, assertCapabilityAvailable: registry.assertCapabilityAvailable, legacyCapsFor: registry.legacyCapsFor, CapabilityError: registry.CapabilityError },
    providerAuthority, githubTokenKind
  });
  const caps = real.providerCapabilities(ALICE);
  assert.strictEqual(typeof caps.notif, 'boolean');
  assert.strictEqual(guard(real.capabilityAccess('search'), { gh: ALICE }).next, 1);
  const gitlab = guard(real.capabilityAccess('search'), { gh: { provider: 'gitlab', baseUrl: 'https://gitlab.com' } });
  assert.strictEqual(gitlab.next, 0, 'a retired provider has no capabilities here');
  assert.strictEqual(gitlab.body.feature, 'search');
}

console.log('Capability access tests passed');
