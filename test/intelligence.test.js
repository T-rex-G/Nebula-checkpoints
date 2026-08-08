'use strict';
const assert = require('assert');
const crypto = require('crypto');
const {
  stableJson, hashJson, hmacJson, evidenceRecordHash, verifyGithubSignature, normalizeGithubWebhook,
  riskForEvent, pathMatches, protectedPatternsForRepository, referenceSha, canAcceptLiveClient,
  normalizeRepoPath, normalizeBranchName, normalizeCommitSha, lfsAttributePattern, shortestPath,
  compareSnapshots, riskForAccessSurface, normalizeProviderBranches
} = require('../src/intelligence');
const { normalizeDatabaseUrl } = require('../src/config');

assert.strictEqual(stableJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
assert.strictEqual(stableJson({ z: [2, { b: true, a: false }], a: null }), '{"a":null,"z":[2,{"a":false,"b":true}]}');
assert.strictEqual(hashJson({ a: 1 }), hashJson({ a: 1 }));
assert.notStrictEqual(hashJson({ a: 1 }), hashJson({ a: 2 }));
assert.strictEqual(hmacJson('secret', { b: 2, a: 1 }), hmacJson('secret', { a: 1, b: 2 }));
assert.strictEqual(evidenceRecordHash('key', 'prev', 'github:a/b', 'webhook', 'id', 'payload'), evidenceRecordHash('key', 'prev', 'github:a/b', 'webhook', 'id', 'payload'));
assert.notStrictEqual(evidenceRecordHash('key', 'prev', 'github:a/b', 'webhook', 'id', 'payload'), evidenceRecordHash('other', 'prev', 'github:a/b', 'webhook', 'id', 'payload'));

const normalizedDb = normalizeDatabaseUrl('postgresql://u:p@example.com/db?sslmode=require&channel_binding=require', { production: true });
assert.match(normalizedDb, /sslmode=verify-full/);
assert.match(normalizedDb, /channel_binding=require/);
assert.throws(() => normalizeDatabaseUrl('http://example.com/db', { production: true }), /postgres/);
assert.throws(() => normalizeDatabaseUrl('postgresql://u:p@example.com/db?sslmode=disable', { production: true }), /cannot disable TLS/);
assert.match(normalizeDatabaseUrl('postgresql://u:p@localhost/db?sslmode=disable', { production: false, insecure: true }), /sslmode=disable/);


assert.deepStrictEqual(
  protectedPatternsForRepository({ 'Acme/Demo': ['.github/workflows/**'] }, 'acme', 'demo'),
  ['.github/workflows/**']
);
assert.deepStrictEqual(protectedPatternsForRepository({}, 'acme', 'demo'), []);
assert.strictEqual(referenceSha({ commit: { sha: 'a'.repeat(40) } }), 'a'.repeat(40));
assert.strictEqual(referenceSha({ commit: { id: 'b'.repeat(40) } }), 'b'.repeat(40));
assert.strictEqual(referenceSha({ target: { sha: 'c'.repeat(40) } }), 'c'.repeat(40));
assert.strictEqual(referenceSha({ object: { sha: 'd'.repeat(40) } }), 'd'.repeat(40));
assert.strictEqual(referenceSha({}), '');

assert.strictEqual(typeof normalizeProviderBranches, 'function', 'provider branch normalization must be exported');
assert.deepStrictEqual(normalizeProviderBranches('gitea', [
  { name: 'main', protected: true, commit: { id: '1'.repeat(40) } }
]), [
  { name: 'main', protected: true, sha: '1'.repeat(40) }
]);
assert.deepStrictEqual(normalizeProviderBranches('github', [
  { name: 'main', protected: false, commit: { sha: '2'.repeat(40), id: '3'.repeat(40) } }
]), [
  { name: 'main', protected: false, sha: '2'.repeat(40) }
]);
assert.deepStrictEqual(normalizeProviderBranches('gitlab', [
  { name: 'release', protected: true, commit: { id: '4'.repeat(40), sha: '5'.repeat(40) } }
]), [
  { name: 'release', protected: true, sha: '4'.repeat(40) }
]);
assert.deepStrictEqual(normalizeProviderBranches('gitea', [
  { name: 'empty', protected: false, commit: null }
]), [
  { name: 'empty', protected: false, sha: '' }
]);

assert.strictEqual(canAcceptLiveClient(0, 0), true);
assert.strictEqual(canAcceptLiveClient(99, 4), true);
assert.strictEqual(canAcceptLiveClient(100, 0), false);
assert.strictEqual(canAcceptLiveClient(4, 5), false);


assert(pathMatches('.github/workflows/**', '.github/workflows/deploy.yml'));
assert(pathMatches('infra', 'infra/prod/main.tf'));
assert(pathMatches('src/*.js', 'src/app.js'));
assert(pathMatches('docs/??.md', 'docs/en.md'));
assert(!pathMatches('src/*.js', 'src/lib/a.js'));
assert(!pathMatches('../secret', 'secret'));
assert(!pathMatches('', 'src/a.js'));


assert.strictEqual(normalizeRepoPath('\\assets\\release file.zip'), 'assets/release file.zip');
assert.strictEqual(normalizeRepoPath('/docs//guide.md'), 'docs/guide.md');
assert.throws(() => normalizeRepoPath(''), /Invalid repository path/);
assert.throws(() => normalizeRepoPath('../secret.txt'), /Invalid repository path/);
assert.throws(() => normalizeRepoPath('docs/../secret.txt'), /Invalid repository path/);
assert.throws(() => normalizeRepoPath('docs/'), /Invalid repository path/);
assert.throws(() => normalizeRepoPath('bad\npath'), /Invalid repository path/);
assert.strictEqual(normalizeBranchName('feature/neural-live'), 'feature/neural-live');
assert.strictEqual(normalizeBranchName('release-5.2.0'), 'release-5.2.0');
assert.strictEqual(normalizeCommitSha('A'.repeat(40)), 'a'.repeat(40));
assert.throws(() => normalizeCommitSha('abc123'), /Invalid commit SHA/);
for (const bad of ['', 'bad name', 'a..b', '.hidden/x', 'x.lock', 'feature//x', 'x[1]', '@']) {
  assert.throws(() => normalizeBranchName(bad), /Invalid branch name/);
}
assert.strictEqual(lfsAttributePattern('assets/release file.zip'), '/assets/release\\ file.zip');
assert.strictEqual(lfsAttributePattern('assets/[final]*.zip'), '/assets/\\[final\\]\\*.zip');

const raw = Buffer.from('{"hello":"world"}');
const secret = 'test-secret';
const sig = `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
assert(verifyGithubSignature(secret, raw, sig));
assert(!verifyGithubSignature(secret, raw, sig.slice(0, -1) + '0'));
assert(!verifyGithubSignature('', raw, sig));
assert(!verifyGithubSignature(secret, 'not-a-buffer', sig));

const evt = normalizeGithubWebhook('push', {
  ref: 'refs/heads/main', forced: true, before: 'a'.repeat(40), after: 'b'.repeat(40),
  repository: { name: 'demo', full_name: 'acme/demo', default_branch: 'main', owner: { login: 'acme' } },
  sender: { login: 'alice' }, commits: [{ modified: ['.github/workflows/deploy.yml', 'src/app.js'], added: [], removed: [] }]
}, 'delivery-1');
assert.strictEqual(evt.ref, 'main');
assert.deepStrictEqual(evt.paths, ['.github/workflows/deploy.yml', 'src/app.js']);
const risk = riskForEvent(evt, { protectedPatterns: ['.github/workflows/**'], defaultBranch: 'main' });
assert.strictEqual(risk.severity, 'critical');
assert(risk.score <= 100);
assert(risk.reasons.some(r => r.code === 'FORCE_PUSH'));
assert(risk.reasons.some(r => r.code === 'PROTECTED_PATH_CHANGED'));
assert(risk.reasons.some(r => r.code === 'WORKFLOW_CHANGED'));


const largeCommits = Array.from({ length: 101 }, (_, i) => ({ modified: [`src/file-${i}.js`], added: [], removed: [] }));
const truncatedPush = normalizeGithubWebhook('push', {
  ref: 'refs/heads/main',
  repository: { name: 'demo', full_name: 'acme/demo', default_branch: 'main', owner: { login: 'acme' } },
  sender: { login: 'alice' }, commits: largeCommits
}, 'delivery-truncated');
assert.strictEqual(truncatedPush.metadata.pathsTruncated, true);
assert.strictEqual(truncatedPush.metadata.commitsInspected, 100);
assert(riskForEvent(truncatedPush).reasons.some(r => r.code === 'CHANGESET_TRUNCATED'));

const providerTruncatedPush = normalizeGithubWebhook('push', {
  ref: 'refs/heads/main', size: 250, distinct_size: 200,
  repository: { name: 'demo', full_name: 'acme/demo', default_branch: 'main', owner: { login: 'acme' } },
  sender: { login: 'alice' }, commits: [{ modified: ['src/only-visible-file.js'], added: [], removed: [] }]
}, 'delivery-provider-truncated');
assert.strictEqual(providerTruncatedPush.metadata.commitCount, 250);
assert.strictEqual(providerTruncatedPush.metadata.distinctCommitCount, 200);
assert.strictEqual(providerTruncatedPush.metadata.pathsTruncated, true);

const deleted = normalizeGithubWebhook('delete', {
  ref: 'production', ref_type: 'branch',
  repository: { name: 'demo', full_name: 'acme/demo', owner: { login: 'acme' } },
  sender: { login: 'bob' }
}, 'delivery-2');
assert.strictEqual(riskForEvent(deleted).severity, 'warning');

const failedWorkflow = normalizeGithubWebhook('workflow_run', {
  action: 'completed', repository: { name: 'demo', full_name: 'acme/demo', owner: { login: 'acme' } },
  sender: { login: 'ci' }, workflow_run: { id: 99, name: 'Deploy', status: 'completed', conclusion: 'failure', head_branch: 'main' }
}, 'delivery-3');
assert(riskForEvent(failedWorkflow).reasons.some(r => r.code === 'WORKFLOW_FAILED'));

const graph = shortestPath(
  [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'isolated' }],
  [{ source: 'a', target: 'b', type: 'x' }, { source: 'b', target: 'c', type: 'y' }],
  'a', 'c'
);
assert.deepStrictEqual(graph.nodeIds, ['a', 'b', 'c']);
assert.strictEqual(graph.edges.length, 2);
assert.strictEqual(shortestPath([{ id: 'a' }], [], 'a', 'missing'), null);
assert.strictEqual(shortestPath([{ id: 'a' }, { id: 'b' }], [], 'a', 'b'), null);
assert.deepStrictEqual(shortestPath([{ id: 'a' }], [], 'a', 'a'), { nodeIds: ['a'], edges: [] });


const snapshotComparison = compareSnapshots(
  {
    kind: 'nebulaverse-snapshot', owner: 'acme', repo: 'demo', capturedAt: '2026-07-20T00:00:00Z',
    refs: [{ name: 'main', sha: 'a'.repeat(40) }, { name: 'release', sha: 'b'.repeat(40) }],
    tags: [{ name: 'v1', sha: 'c'.repeat(40) }],
    manifest: { truncated: false, files: [
      { path: 'src/app.js', sha: 'd'.repeat(40), mode: '100644', type: 'blob' },
      { path: 'README.md', sha: 'e'.repeat(40), mode: '100644', type: 'blob' }
    ] }
  },
  {
    kind: 'nebulaverse-snapshot', owner: 'acme', repo: 'demo', capturedAt: '2026-07-21T00:00:00Z',
    refs: [{ name: 'main', sha: 'f'.repeat(40) }, { name: 'feature', sha: '1'.repeat(40) }],
    tags: [{ name: 'v1', sha: 'c'.repeat(40) }, { name: 'v2', sha: '2'.repeat(40) }],
    manifest: { truncated: false, files: [
      { path: 'src/app.js', sha: '3'.repeat(40), mode: '100644', type: 'blob' },
      { path: 'docs/guide.md', sha: '4'.repeat(40), mode: '100644', type: 'blob' }
    ] }
  }
);
assert.deepStrictEqual(snapshotComparison.refs.move.map(x => x.name), ['main']);
assert.deepStrictEqual(snapshotComparison.refs.recreate.map(x => x.name), ['release']);
assert.deepStrictEqual(snapshotComparison.refs.preserve.map(x => x.name), ['feature']);
assert.deepStrictEqual(snapshotComparison.files.modified.map(x => x.path), ['src/app.js']);
assert.deepStrictEqual(snapshotComparison.files.restore.map(x => x.path), ['README.md']);
assert.deepStrictEqual(snapshotComparison.files.preserve.map(x => x.path), ['docs/guide.md']);
assert.strictEqual(snapshotComparison.compatible, true);
assert.strictEqual(compareSnapshots({ owner: 'a', repo: 'x' }, { owner: 'b', repo: 'x' }).compatible, false);
assert.strictEqual(compareSnapshots({ provider: 'github', owner: 'a', repo: 'x' }, { provider: 'gitea', owner: 'a', repo: 'x' }).compatible, false);

const accessRisk = riskForAccessSurface({
  collaborators: [{ login: 'alice', permission: 'admin' }],
  deployKeys: [{ id: 1, title: 'prod', readOnly: false, verified: true }],
  webhooks: [{ id: 2, active: true, insecureSsl: true, host: 'example.net' }],
  partial: false
});
assert.strictEqual(accessRisk.severity, 'critical');
assert(accessRisk.reasons.some(r => r.code === 'WRITABLE_DEPLOY_KEY'));
assert(accessRisk.reasons.some(r => r.code === 'INSECURE_WEBHOOK_TLS'));
assert.strictEqual(riskForAccessSurface({ collaborators: [], deployKeys: [], webhooks: [], partial: true }).reasons.some(r => r.code === 'ACCESS_INVENTORY_PARTIAL'), true);

console.log('intelligence tests passed');
