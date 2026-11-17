'use strict';
/*
 * Which repositories a request may reach, and the guards around a
 * repository's own lifecycle (identity and access's repository access): the
 * alpha's invitation scope for a route, a list, a new repository, a step-up
 * grant and a safety change; the deletion confirmation; the code search; the
 * safety controls a tester sees; and the actor the ledger keeps.
 */
const assert = require('assert');
const { createRepositoryAccess, alphaActorLabel } = require('../apps/api/src/modules/identity-access/index.ts');
const github = require('../apps/api/src/modules/github-provider/index.ts');
const { defaultSafety } = require('../apps/api/src/modules/corona/index.ts');

const TESTER = 'ab'.repeat(16);
const ALICE = { provider: 'github', login: 'alice', token: 't' };
const DENIED = { error: 'This repository is not allowed for this alpha invitation', code: 'ALPHA_REPOSITORY_NOT_ALLOWED' };

function access(alphaEnabled) {
  const fails = [];
  const guards = createRepositoryAccess({
    alphaEnabled, fail: (res, error) => { fails.push(error); return 'failed'; }, defaultSafety,
    validateRepositoryCreation: github.validateRepositoryCreation, validateCodeQuery: github.validateCodeQuery,
    githubRepositoryScopes: github.githubRepositoryScopes, scopedCodeQuery: github.scopedCodeQuery
  });
  return { ...guards, fails };
}
const alpha = (scopes = ['github:github.com/alice/demo']) => ({ testerId: TESTER, repositoryScopes: scopes });
const request = (extra = {}) => ({ alpha: alpha(), gh: { ...ALICE }, params: { owner: 'alice', repo: 'demo' }, body: {}, query: {}, ...extra });
function call(guard, req) {
  const answer = { next: 0 };
  const res = { status(code) { answer.status = code; return res; }, json(body) { answer.body = body; return 'json'; } };
  answer.returned = guard(req, res, () => { answer.next += 1; });
  return answer;
}

/* ---- The ledger's actor --------------------------------------------------------------- */
{
  assert.strictEqual(access(true).retainedActor(request()), alphaActorLabel({ testerId: TESTER }), 'the tester\'s label in the alpha');
  assert.strictEqual(access(false).retainedActor(request()), 'alice', 'the login outside it');
  assert.strictEqual(access(true).retainedActor(request({ alpha: undefined })), 'alice');
  assert.strictEqual(access(false).retainedActor({ gh: null }), 'unknown');
  assert.strictEqual(access(false).retainedActor({ gh: { provider: 'github' } }), 'unknown');
}

/* ---- A route's repository ------------------------------------------------------------- */
{
  const on = access(true);
  const req = request();
  assert.deepStrictEqual(call(on.alphaRepositoryAccess, req).next, 1);
  assert.deepStrictEqual(req.alphaRepository, { allowed: true, canonical: 'github:github.com/alice/demo' }, 'the grant, by its canonical scope, is kept on the request');
  const cased = request({ params: { owner: 'Alice', repo: 'Demo' } });
  assert.strictEqual(call(on.alphaRepositoryAccess, cased).next, 1, 'a repository is matched without regard to case');
  for (const [label, extra] of [
    ['another repository', { params: { owner: 'alice', repo: 'other' } }],
    ['no invitation', { alpha: undefined }],
    ['a retired provider', { gh: { provider: 'gitlab', login: 'old', baseUrl: 'https://gitlab.com' } }],
    ['no repository', { params: {} }]
  ]) {
    const refused = request(extra);
    const answer = call(on.alphaRepositoryAccess, refused);
    assert.deepStrictEqual([answer.next, answer.status, answer.body], [0, 403, DENIED], label);
    assert.strictEqual(refused.alphaRepository, undefined);
  }
  assert.strictEqual(call(on.alphaRepositoryAccess, request({ alpha: alpha([]) })).next, 1, 'an invitation that names no repository reaches every one');
  const unnamed = request({ gh: { login: 'alice', token: 't' } });
  assert.strictEqual(call(on.alphaRepositoryAccess, unnamed).next, 1, 'an account without a provider is GitHub\'s');
  const enterprise = request({ gh: { provider: 'github', login: 'alice', baseUrl: 'https://ghe.example' } });
  call(on.alphaRepositoryAccess, enterprise);
  assert.strictEqual(enterprise.alphaRepository.canonical, 'github:github.com/alice/demo', 'a GitHub account is on github.com');
  const off = access(false);
  const outside = request({ params: { owner: 'bob', repo: 'x' }, alpha: undefined });
  assert.strictEqual(call(off.alphaRepositoryAccess, outside).next, 1, 'outside the alpha every repository is in scope');
  assert.strictEqual(outside.alphaRepository, undefined);
}

/* ---- A list ------------------------------------------------------------------------ */
{
  const on = access(true);
  assert.strictEqual(on.alphaRepositoryListAllowed(request(), 'alice', 'demo'), true);
  assert.strictEqual(on.alphaRepositoryListAllowed(request(), 'alice', 'other'), false, 'a list is filtered, not refused');
  assert.strictEqual(on.alphaRepositoryListAllowed(request({ gh: { provider: 'gitlab', login: 'x' } }), 'alice', 'demo'), false, 'an entry that does not fit is left out');
  assert.strictEqual(access(false).alphaRepositoryListAllowed(request({ gh: { provider: 'gitlab' } }), 'x', 'y'), true);
  assert.strictEqual(call(on.alphaRepositoryListAccess, request()).next, 1);
  assert.deepStrictEqual(call(on.alphaRepositoryListAccess, request({ gh: { provider: 'gitlab', login: 'x', baseUrl: 'https://gitlab.com' } })), { next: 0, status: 403, body: DENIED, returned: 'json' });
  assert.strictEqual(call(access(false).alphaRepositoryListAccess, request({ gh: { provider: 'gitlab' } })).next, 1);
}

/* ---- A new repository ------------------------------------------------------------------ */
{
  const on = access(true);
  assert.strictEqual(call(on.repositoryCreationAccess, request({ body: { name: 'demo' } })).next, 1, 'a name the invitation pre-authorized');
  assert.strictEqual(call(on.repositoryCreationAccess, request({ body: { name: 'other' } })).next, 0);
  assert.deepStrictEqual([on.fails.at(-1).status, on.fails.at(-1).code], [403, 'ALPHA_REPOSITORY_NOT_ALLOWED'], 'an invitation never gains a repository it did not name');
  assert.strictEqual(call(on.repositoryCreationAccess, request({ body: { name: 'demo', private: true } })).next, 0);
  assert.strictEqual(on.fails.at(-1).message, 'Use a valid repository name, description, and boolean privacy/initialization choices.', 'GitHub\'s own rules first');
  assert.strictEqual(call(on.repositoryCreationAccess, request({ body: { name: 'demo' }, gh: { provider: 'gitlab', login: 'alice', baseUrl: 'https://gitlab.com' } })).next, 0);
  assert.deepStrictEqual([on.fails.at(-1).status, on.fails.at(-1).code], [403, 'ALPHA_REPOSITORY_NOT_ALLOWED'], 'a scope that cannot be read is refused as not allowed, never as its own error');
  const off = access(false);
  assert.strictEqual(call(off.repositoryCreationAccess, request({ body: { name: 'other' }, alpha: undefined })).next, 1);
  assert.strictEqual(call(off.repositoryCreationAccess, request({ body: { name: 'demo' }, alpha: undefined, gh: { provider: 'gitlab', login: 'alice', baseUrl: 'https://gitlab.com' } })).next, 1, 'outside the alpha no scope is read');
}

/* ---- A deletion ------------------------------------------------------------------------- */
{
  const guards = access(false);
  assert.strictEqual(call(guards.repositoryDeletionConfirmation, request({ body: { confirmation: 'alice/demo' } })).next, 1);
  for (const body of [{ confirmation: 'Alice/Demo' }, { confirmation: 'alice/' }, {}, undefined]) {
    assert.strictEqual(call(guards.repositoryDeletionConfirmation, request({ body })).next, 0, JSON.stringify(body));
    const error = guards.fails.at(-1);
    assert.deepStrictEqual([error.message, error.status, error.code, error.providerChanged], ['Type the full owner/repository name to confirm deletion.', 400, 'REPOSITORY_DELETE_CONFIRMATION_REQUIRED', false]);
  }
}

/* ---- A code search ----------------------------------------------------------------------- */
{
  const on = access(true);
  assert.strictEqual(call(on.githubSearchAccess, request({ query: { q: 'secret' } })).next, 1);
  assert.strictEqual(call(on.githubSearchAccess, request({ query: { q: '' } })).next, 0, 'the query is validated');
  assert.strictEqual(on.fails.at(-1).code, 'SEARCH_QUERY_INVALID');
  assert.strictEqual(call(on.githubSearchAccess, request({ query: { q: 'repo:bob/x secret' } })).next, 0, 'held to the invitation\'s repositories');
  assert.strictEqual(call(access(false).githubSearchAccess, request({ query: { q: 'repo:bob/x secret' } })).next, 1);
  const off = access(false);
  assert.strictEqual(call(off.githubSearchAccess, request({ query: { q: '' } })).next, 0, 'validated outside the alpha too');
  assert.strictEqual(off.fails.at(-1).code, 'SEARCH_QUERY_INVALID');
}

/* ---- A step-up grant's repository ---------------------------------------------------------- */
{
  const on = access(true);
  const req = request({ body: { action: 'repository.delete', scope: { owner: 'alice', repo: 'demo' } } });
  assert.strictEqual(call(on.alphaStepUpRepositoryAccess, req).next, 1);
  assert.deepStrictEqual(req.alphaStepUpOperation, { action: 'repository.delete', scope: { provider: 'github', owner: 'alice', repo: 'demo' } });
  assert.deepStrictEqual(req.alphaRepository, { allowed: true, canonical: 'github:github.com/alice/demo' });
  assert.strictEqual(call(on.alphaStepUpRepositoryAccess, request({ body: { action: 'repository.delete', scope: { owner: 'alice', repo: 'other' } } })).next, 0);
  assert.strictEqual(on.fails.at(-1).code, 'ALPHA_REPOSITORY_NOT_ALLOWED');
  const global = request({ body: { action: 'sessions.revoke-others', scope: {} } });
  assert.strictEqual(call(on.alphaStepUpRepositoryAccess, global).next, 1, 'a grant for no repository needs no scope');
  assert.strictEqual(global.alphaRepository, undefined);
  assert.strictEqual(call(on.alphaStepUpRepositoryAccess, request({ gh: { provider: 'gitea', login: 'x' }, body: { action: 'sessions.revoke-others', scope: {} } })).next, 0, 'a grant names the account\'s own provider');
  assert.strictEqual(on.fails.at(-1).code, 'STEP_UP_SCOPE_INVALID');
  const off = access(false);
  const outside = request({ body: { action: 'repository.delete', scope: { owner: 'bob', repo: 'x' } } });
  assert.strictEqual(call(off.alphaStepUpRepositoryAccess, outside).next, 1);
  assert.strictEqual(outside.alphaRepository, undefined);
}

/* ---- The safety controls a tester sees, and may change ---------------------------------------- */
{
  const state = { readOnly: true, protected: { 'alice/demo': ['src'], 'Alice/Other': ['x'], 'bad key': ['y'], 'bob/x': ['z'] } };
  assert.deepStrictEqual(access(false).alphaSafetyView(request(), state), { readOnly: true, freezeSync: false, protected: state.protected, globalControls: true });
  assert.deepStrictEqual(access(true).alphaSafetyView(request({ alpha: alpha(['github:github.com/alice/demo', 'github:github.com/alice/other']) }), state),
    { readOnly: true, freezeSync: false, protected: { 'alice/demo': ['src'], 'Alice/Other': ['x'] }, globalControls: false }, 'only the invitation\'s repositories, and the switches are the deployment\'s');

  const on = access(true);
  for (const body of [{ readOnly: true }, { freezeSync: false }]) {
    assert.deepStrictEqual(call(on.alphaSafetyMutationAccess, request({ body })), { next: 0, status: 403, body: { error: 'Global safety changes require an unscoped deployment', code: 'ALPHA_REPOSITORY_SCOPE_REQUIRED' }, returned: 'json' });
  }
  const padded = request({ body: { protect: { repo: ' alice/demo ', path: 'src' } } });
  assert.strictEqual(call(on.alphaSafetyMutationAccess, padded).next, 1);
  assert.deepStrictEqual(padded.alphaRepository, { allowed: true, canonical: 'github:github.com/alice/demo' });
  assert.deepStrictEqual(call(on.alphaSafetyMutationAccess, request({ body: { protect: { repo: 'bad', path: 'x' } } })), { next: 0, status: 400, body: { error: 'Invalid repository key' }, returned: 'json' });
  assert.deepStrictEqual(call(on.alphaSafetyMutationAccess, request({ body: {} })), { next: 0, status: 403, body: { error: 'A repository scope is required for hosted-alpha safety changes', code: 'ALPHA_REPOSITORY_SCOPE_REQUIRED' }, returned: 'json' });
  assert.strictEqual(call(on.alphaSafetyMutationAccess, request({ body: { protect: { repo: 'bob/x', path: 'x' } } })).next, 0);
  assert.strictEqual(on.fails.at(-1).code, 'ALPHA_REPOSITORY_NOT_ALLOWED');
  assert.strictEqual(call(access(false).alphaSafetyMutationAccess, request({ body: { readOnly: true } })).next, 1);
}

console.log('Repository access tests passed');
