'use strict';
/*
 * What a person's safety controls refuse (Corona's safety guard), and the key
 * a repository's evidence is kept under.
 */
const assert = require('assert');
const {
  SAFETY_EXEMPT, candidatePaths, enforceProtectedPaths, guardSafety, isCurrentGovernanceControlPlaneRequest,
  protectedPathError, protectedPathHit, protectedPatternsForReq, safetyOf, repoKey, scopedEvidenceKey
} = require('../apps/api/src/modules/corona/index.ts');

const repoPath = '/api/repo/alice/demo';
const PROTECTED = { protected: { 'Alice/Demo': ['src', 'docs/*.md', '**/secret*'] } };
const request = (method, path, extra = {}) => ({ method, path, params: { owner: 'alice', repo: 'demo' }, effectiveSafety: PROTECTED, ...extra });
const READ_ONLY = 'Read-only mode is on — writes are disabled. Turn it off in Safeguards.';
const WIDE = 'This repository contains protected paths. Unlock them before a repository-wide restore, reset, branch/reference deletion, or repository deletion.';
const hitMessage = path => `${path} is a protected file — unlock it in Safeguards to change it.`;

/* ---- Whose controls ---------------------------------------------------------------- */
assert.deepStrictEqual(SAFETY_EXEMPT, ['/api/safety', '/api/security', '/api/logout', '/api/accounts', '/api/github-app']);
assert.deepStrictEqual(safetyOf({ effectiveSafety: { readOnly: true }, session: { safety: { freezeSync: true } } }), { readOnly: true, freezeSync: false, protected: {} }, 'the loaded controls win over the session\'s copy');
assert.deepStrictEqual(safetyOf({ session: { safety: { freezeSync: true } } }), { readOnly: false, freezeSync: true, protected: {} });
assert.deepStrictEqual(safetyOf({ session: null }), { readOnly: false, freezeSync: false, protected: {} });

/* ---- The paths a request names ------------------------------------------------------- */
assert.deepStrictEqual(candidatePaths({
  body: { path: '/a', from: 'b', to: '//c', newPath: 'd', oldPath: 'e', prefix: 'f', paths: ['g', 3, '/h'], files: [{ path: 'i' }, null, { path: 2 }], ops: [{ path: 'j' }, 'k'] },
  query: { path: 'l', p: '/m' }
}), ['a', 'b', 'c', 'd', 'e', 'f', 'l', 'm', 'g', 'h', 'i', 'j']);
assert.deepStrictEqual(candidatePaths({ body: { path: '', paths: 'x', files: 'y', ops: null }, query: { p: 5 } }), []);
assert.deepStrictEqual(candidatePaths({}), []);

/* ---- The patterns and the hits --------------------------------------------------------- */
assert.deepStrictEqual(protectedPatternsForReq(request('POST', repoPath)), ['src', 'docs/*.md', '**/secret*'], 'the repository is matched without regard to case');
assert.deepStrictEqual(protectedPatternsForReq({ effectiveSafety: PROTECTED, params: { owner: 'alice' } }), []);
assert.deepStrictEqual(protectedPatternsForReq({ effectiveSafety: PROTECTED, params: { repo: 'demo' } }), []);
assert.deepStrictEqual(protectedPatternsForReq({ effectiveSafety: PROTECTED, params: null }), []);
assert.deepStrictEqual(protectedPatternsForReq({ effectiveSafety: PROTECTED, params: { owner: 'bob', repo: 'demo' } }), []);
const malformed = { protected: { '/demo': ['src'], 'alice/': ['src'], '/': ['src'] } };
for (const params of [{ repo: 'demo' }, { owner: 'alice' }, { owner: '', repo: '' }, {}]) {
  assert.deepStrictEqual(protectedPatternsForReq({ effectiveSafety: malformed, params }), [], `a request that does not name both is never protected, even by a malformed stored key: ${JSON.stringify(params)}`);
}
const req = request('POST', `${repoPath}/contents`);
assert.strictEqual(protectedPathHit(req, ['README.md', 'src/a.js', 'docs/x.md']), 'src/a.js', 'the first path a pattern covers');
assert.strictEqual(protectedPathHit(req, ['docs/sub/x.md', 'deep/q/secret.txt']), 'deep/q/secret.txt', '* stays within a segment, ** crosses them');
assert.strictEqual(protectedPathHit(req, ['srcx', 'docs/x.txt']), '');
assert.strictEqual(protectedPathHit(req, null), '');
assert.strictEqual(protectedPathError(req, ['src']), hitMessage('src'));
assert.strictEqual(protectedPathError(req, ['README.md']), '');
assert.throws(() => enforceProtectedPaths(req, ['lib/secret.key']), error => {
  assert.deepStrictEqual([error.message, error.status, error.code], [hitMessage('lib/secret.key'), 423, 'PROTECTED_PATH']);
  return true;
});
assert.strictEqual(enforceProtectedPaths(req, ['README.md']), undefined);

/* ---- The governance control plane --------------------------------------------------------- */
const governance = `${repoPath}/governance`;
const policy = `${governance}/policies/p1`;
const plane = [
  ['PATCH', `${policy}/drafts/d1`], ['DELETE', `${policy}/drafts/d1`], ['patch', `${policy}/drafts/d1`],
  ...[
    `${governance}/policies`, `${policy}/validate`, `${policy}/drafts`, `${policy}/drafts/d1/validate`, `${policy}/drafts/d1/submit`,
    `${policy}/versions/v1/simulate`, `${policy}/versions/v1/reviewers/me`, `${policy}/versions/v1/decisions`, `${policy}/versions/v1/activate`,
    `${policy}/versions/v1/rollback`, `${policy}/versions/v1/exceptions`, `${governance}/baselines/generate`, `${governance}/exceptions/e1/decision`,
    `${governance}/exceptions/e1/revoke`, `${policy}/deactivate`, `${policy}/archive`, `${policy}/restore`, `${policy}/versions/v1/withdraw`, `${governance}/reset`
  ].map(path => ['POST', path])
];
for (const [method, path] of plane) assert.strictEqual(isCurrentGovernanceControlPlaneRequest({ method, path }), true, `${method} ${path}`);
for (const [method, path] of [
  ['POST', `${policy}/drafts/d1`], ['PUT', `${policy}/drafts/d1`], ['GET', `${governance}/policies`], ['PATCH', `${policy}/versions/v1`],
  ['DELETE', `${policy}`], ['POST', `${policy}/versions/v1/withdraw/now`], ['POST', `${governance}/policies/`], ['POST', `${governance}/other`],
  ['POST', `${governance}/baselines`], [undefined, `${governance}/reset`], ['POST', `/x${governance}/reset`], ['POST', undefined]
]) assert.strictEqual(isCurrentGovernanceControlPlaneRequest({ method, path }), false, `${method} ${path}`);

/* ---- What the guard refuses ------------------------------------------------------------------ */
for (const method of ['GET', 'HEAD', 'OPTIONS', 'post', undefined]) assert.strictEqual(guardSafety(request(method, `${repoPath}/reset`, { effectiveSafety: { readOnly: true } })), null, `${method} is not a write`);
for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.strictEqual(guardSafety(request(method, `${repoPath}/contents`, { effectiveSafety: { readOnly: true } })), READ_ONLY, method);
for (const path of ['/api/safety', '/api/security/step-up', '/api/logout', '/api/accounts/switch', '/api/github-app/connect', `${repoPath}/snapshot-compare`, `${repoPath}/restore-preview`, `${repoPath}/emergency-manifest`]) {
  assert.strictEqual(guardSafety(request('POST', path, { effectiveSafety: { readOnly: true } })), null, `${path} stays reachable`);
}
assert.strictEqual(guardSafety(request('POST', '/api/repo/a/api/safety', { effectiveSafety: { readOnly: true } })), READ_ONLY, 'an exemption is a prefix, not a substring');
assert.strictEqual(guardSafety(request('POST', `${policy}/restore`, { effectiveSafety: { readOnly: true, ...PROTECTED } })), null, 'governance is not the repository');
assert.strictEqual(guardSafety(request('POST', `${governance}/reset`, { effectiveSafety: PROTECTED })), null);
assert.strictEqual(guardSafety(request('POST', `${governance}/baselines/generate`, { effectiveSafety: { readOnly: true } })), null);
assert.strictEqual(guardSafety(request('PUT', `${policy}/drafts/d1`, { effectiveSafety: { readOnly: true } })), READ_ONLY);

assert.strictEqual(guardSafety(request('PUT', `${repoPath}/contents`, { body: { path: 'src/a.js' } })), hitMessage('src/a.js'));
assert.strictEqual(guardSafety(request('POST', `${repoPath}/files/move`, { body: { from: 'README.md', to: 'docs/x.md' } })), hitMessage('docs/x.md'));
assert.strictEqual(guardSafety(request('POST', `${repoPath}/contents`, { query: { p: '/src' } })), hitMessage('src'));
assert.strictEqual(guardSafety(request('POST', `${repoPath}/contents`, { body: { path: 'README.md' } })), null);
for (const path of [`${repoPath}/restore`, `${repoPath}/reset`, `${repoPath}/restore-refs`]) assert.strictEqual(guardSafety(request('POST', path)), WIDE, path);
assert.strictEqual(guardSafety(request('DELETE', repoPath)), WIDE, 'a repository deletion is repository-wide');
assert.strictEqual(guardSafety(request('DELETE', `${repoPath}/branches/main`)), WIDE, 'a branch deletion is repository-wide');
assert.strictEqual(guardSafety(request('POST', `${repoPath}/branches/main`)), null, 'creating a branch is not');
assert.strictEqual(guardSafety(request('DELETE', `${repoPath}/tags/v1`)), null, 'a deeper deletion is not the repository\'s');
assert.strictEqual(guardSafety(request('POST', `${repoPath}/restore`, { effectiveSafety: {} })), null, 'with nothing protected, a restore is allowed');
assert.strictEqual(guardSafety(request('DELETE', repoPath, { effectiveSafety: {} })), null);
assert.strictEqual(guardSafety(request('POST', `${repoPath}/reset`, { params: {} })), null, 'no repository, no protected paths');
assert.strictEqual(guardSafety(request('POST', `${repoPath}/reset`, { effectiveSafety: { readOnly: true, ...PROTECTED } })), READ_ONLY, 'read-only is said first');
assert.strictEqual(guardSafety(request('POST', `${repoPath}/restore`, { body: { path: 'src/x' } })), hitMessage('src/x'), 'a named path is said before the repository-wide refusal');
assert.throws(() => guardSafety({ method: 'POST' }), TypeError, 'a write without a path is a programming error, as it always was');

/* ---- The evidence key ---------------------------------------------------------------------------- */
assert.strictEqual(repoKey('github', 'Alice', 'Demo'), 'github:alice/demo');
assert.strictEqual(repoKey('', 'a', 'b'), 'github:a/b');
assert.strictEqual(repoKey(undefined, null, undefined), 'github:null/undefined');
assert.strictEqual(scopedEvidenceKey('github', 'Alice', 'Demo', 'github:alice'), 'github:alice/demo:github:alice');
assert.strictEqual(scopedEvidenceKey('github', 'a', 'b', ''), 'github:a/b:anonymous');
assert.strictEqual(scopedEvidenceKey('github', 'a', 'b', 0), 'github:a/b:anonymous');
assert.strictEqual(scopedEvidenceKey('github', 'a', 'b', 'x'.repeat(100)), `github:a/b:${'x'.repeat(80)}`);

console.log('Corona safety guard tests passed');
