'use strict';

const assert = require('assert');
const path = require('path');
const { locations } = require('./oracles/route-policy');

const root = path.join(__dirname, '..');

/*
 * The repository mutation context is the platform's (mutation-context.ts): the
 * metadata it records for an issue is its path facts alone, never its title or
 * any free-form content (test/mutation-context.test.js). That the composed
 * server's writes pass through it, and through the gateway's policy, and that
 * its provider writes are checked by the central gateway, is
 * test/composition.test.js's.
 */

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
/* Each route's guard chain, as the route policy reads it from wherever the route is registered. */
const guardChains = new Map(locations(root).filter(entry => entry.kind === 'route')
  .map(entry => [`app.${entry.method.toLowerCase()}('${entry.path}'`, entry.guards]));
for (const [route, action] of routes) {
  const guards = guardChains.get(route);
  assert(guards, `missing route ${route}`);
  assert(
    guards.includes(`mutationContext('${action}')`),
    `${route} must use mutationContext('${action}')`
  );
}

/*
 * The native push and the LFS upload write to the provider outside the API
 * client, so each asks the active gateway context itself, before it writes,
 * naming its transport (test/workbench-collaboration-routes.test.js). That the
 * server hands both the gateway's check -- so that, as composed, each is
 * refused outside a mutation before GitHub is asked anything -- is
 * test/composition.test.js's.
 */

console.log('mutation gateway server contract tests passed');
