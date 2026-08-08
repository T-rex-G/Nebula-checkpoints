'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

assert(server.includes("require('./src/mutation-gateway')"), 'server must load the central mutation gateway');
assert(server.includes('mutationGateway.assertProviderMutation'), 'provider writes must be checked by the gateway');
assert(server.includes('function mutationContext('), 'server must expose one mutation route context middleware');
assert(!server.includes("case 'issue.create': return { title:"), 'mutation descriptors must not retain issue titles or other free-form content');

const routes = new Map([
  ["app.post('/api/repos'", 'repository.create'],
  ["app.delete('/api/repo/:owner/:repo'", 'repository.delete'],
  ["app.post('/api/repo/:owner/:repo/branches'", 'branch.create'],
  ["app.delete('/api/repo/:owner/:repo/branches/:name'", 'branch.delete'],
  ["app.put('/api/repo/:owner/:repo/file'", 'file.write'],
  ["app.delete('/api/repo/:owner/:repo/file'", 'file.delete'],
  ["app.post('/api/repo/:owner/:repo/rename'", 'file.rename'],
  ["app.post('/api/repo/:owner/:repo/batch'", 'file.batch'],
  ["app.post('/api/repo/:owner/:repo/revert'", 'commit.revert'],
  ["app.post('/api/repo/:owner/:repo/restore'", 'commit.restore'],
  ["app.post('/api/repo/:owner/:repo/restore-paths'", 'commit.restore-paths'],
  ["app.post('/api/repo/:owner/:repo/reset'", 'branch.reset'],
  ["app.post('/api/repo/:owner/:repo/pulls'", 'pull.create'],
  ["app.put('/api/repo/:owner/:repo/pulls/:num/merge'", 'pull.merge'],
  ["app.post('/api/repo/:owner/:repo/issues'", 'issue.create'],
  ["app.post('/api/repo/:owner/:repo/issues/:num/comments'", 'issue.comment'],
  ["app.patch('/api/repo/:owner/:repo/issues/:num'", 'issue.update'],
  ["app.put('/api/repo/:owner/:repo/star'", 'repository.star'],
  ["app.delete('/api/repo/:owner/:repo/star'", 'repository.unstar'],
  ["app.post('/api/repo/:owner/:repo/pulls/:num/reviews'", 'pull.review'],
  ["app.post('/api/repo/:owner/:repo/actions/:runId/rerun'", 'workflow.rerun'],
  ["app.post('/api/repo/:owner/:repo/releases'", 'release.create'],
  ["app.post('/api/repo/:owner/:repo/blob'", 'git.blob.create'],
  ["app.post('/api/repo/:owner/:repo/upload'", 'file.upload'],
  ["app.post('/api/repo/:owner/:repo/move-dir'", 'directory.move'],
  ["app.post('/api/repo/:owner/:repo/restore-refs'", 'recovery.restore-refs'],
  ["app.post('/api/repo/:owner/:repo/live-events/connect'", 'webhook.connect'],
  ["app.delete('/api/repo/:owner/:repo/live-events'", 'webhook.disconnect']
]);
for (const [route, action] of routes) {
  const index = server.indexOf(route);
  assert(index >= 0, `missing route ${route}`);
  const declaration = server.slice(index, server.indexOf('\n', index));
  assert(
    declaration.includes(`mutationContext('${action}')`),
    `${route} must use mutationContext('${action}')`
  );
}

for (const helper of ['uploadViaGitPush', 'uploadViaLFS']) {
  const index = server.indexOf(`async function ${helper}`);
  assert(index >= 0, `missing ${helper}`);
  const body = server.slice(index, server.indexOf('\n}', index) + 2);
  assert(body.includes('mutationGateway.assertProviderMutation'), `${helper} must assert the active gateway context`);
}

console.log('mutation gateway server contract tests passed');
