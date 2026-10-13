'use strict';
// Every provider read terminates here; these tests never contact GitHub.
const fs = require('node:fs');
function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}
global.fetch = async input => {
  const url = new URL(input);
  if (url.hostname !== 'api.github.com') throw new Error('Unexpected provider host in activity fixture');
  if (process.env.NV_PULSAR_REQUEST_LOG) fs.appendFileSync(process.env.NV_PULSAR_REQUEST_LOG, JSON.stringify({ path: url.pathname, query: url.search }) + '\n');
  const [, , owner, repo, resource] = url.pathname.split('/');
  if (url.pathname === '/user') return json({ id: 41, login: 'operator' });
  if (resource === 'permission') return json({ permission: 'admin', user: { login: 'operator' } });
  if (owner !== 'acme') throw new Error('Unexpected repository owner');
  const at = new Date().toISOString();
  if (repo === 'unavailable' || (repo === 'partial' && resource === 'issues')) return json({ message: 'Fixture provider unavailable' }, 503);
  if (resource === 'commits') {
    const selected = url.searchParams.get('sha') === 'feature/nested';
    const commit = { sha: (selected ? 'b' : 'a').repeat(40), parents: [{ sha: 'c'.repeat(40) }], commit: { message: selected ? 'Feature HEAD' : 'Default HEAD', author: { name: 'Author', date: at }, committer: { date: at } } };
    return json(repo === 'bounded' ? Array.from({ length: 100 }, (_, i) => ({ ...commit, sha: i.toString(16).padStart(40, '0') })) : [commit]);
  }
  if (resource === 'pulls') return json([{ number: 9, title: 'Pull', state: 'open', updated_at: at }]);
  if (resource === 'issues') return json([{ number: 8, title: 'Issue', state: 'open', updated_at: at }]);
  if (resource === 'releases') return json([{ tag_name: 'v1', name: 'Release', published_at: at }]);
  throw new Error('Unexpected provider activity read');
};
