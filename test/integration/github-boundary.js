'use strict';

const http = require('http');
const crypto = require('crypto');
const { createProviderFetchFixture } = require('../../ci/alpha17-fixtures');

const REPOSITORY = 'integration-sandbox/browser-journey';
const ORIGINAL_TEXT = '# Disposable integration repository\n\nRead through the real server.\n';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function startGithubBoundary() {
  const token = `integration-only-${crypto.randomBytes(24).toString('hex')}`;
  const model = createProviderFetchFixture({
    provider: 'github', repository: REPOSITORY, defaultBranch: 'main',
    mutationCredential: token, readOnlyCredential: 'integration-only-read'
  });
  await model.fetch(`https://api.github.com/repos/${REPOSITORY}/contents/README.md`, {
    method: 'PUT', headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ branch: 'main', message: 'Seed disposable repository', content: Buffer.from(ORIGINAL_TEXT).toString('base64') })
  });
  const requests = [];
  const descriptor = {
    id: 41001, name: 'browser-journey', full_name: REPOSITORY,
    owner: { login: 'integration-sandbox' }, default_branch: 'main', private: true,
    archived: false, description: 'Disposable integration fixture', language: 'Markdown',
    pushed_at: new Date().toISOString(), stargazers_count: 0, forks_count: 0, open_issues_count: 0,
    permissions: { admin: true, maintain: true, push: true, pull: true }
  };

  async function responseFor(url, method, headers, body) {
    if (headers.authorization !== `Bearer ${token}`) return json({ message: 'Bad credentials' }, 401);
    const base = `/repos/${REPOSITORY}`;
    if (method === 'GET') {
      if (url.pathname === '/user') return json({ id: 41002, login: 'integration-tester', name: 'Integration Tester', avatar_url: '' });
      if (url.pathname === '/user/repos') return json([descriptor]);
      if (url.pathname === base) return json(descriptor);
      if (url.pathname === `${base}/branches`) return json([...model.state.branches].map(([name, branch]) => ({ name, protected: false, commit: { sha: branch.sha } })));
      if (url.pathname === `${base}/collaborators/integration-tester/permission`) return json({ permission: 'admin', role_name: 'admin', user: { login: 'integration-tester', id: 41002 } });
      if (url.pathname === '/notifications' || url.pathname === `${base}/events` || url.pathname === `${base}/rulesets`) return json([]);
      if (url.pathname.startsWith(`${base}/contents/`)) {
        const requested = decodeURIComponent(url.pathname.slice(`${base}/contents/`.length));
        const ref = url.searchParams.get('ref') || 'main';
        const files = model.state.branches.get(ref)?.files || model.state.commits.get(ref)?.files;
        if (!files) return json({ message: 'Ref not found' }, 404);
        const view = (filePath, file) => ({
          name: filePath.split('/').at(-1), path: filePath, type: 'file', sha: file.sha,
          size: file.content.length, content: file.content.toString('base64'), encoding: 'base64'
        });
        if (!requested) return json([...files].map(([filePath, file]) => view(filePath, file)));
        return files.has(requested) ? json(view(requested, files.get(requested))) : json({ message: 'Not Found' }, 404);
      }
    }
    return model.fetch(`https://api.github.com${url.pathname}${url.search}`, { method, headers, body: body || undefined });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) throw new Error('Fixture request exceeds the limit');
        chunks.push(chunk);
      }
      const url = new URL(req.url, 'http://127.0.0.1');
      const response = await responseFor(url, req.method, req.headers, Buffer.concat(chunks).toString('utf8'));
      requests.push({ method: req.method, path: url.pathname, status: response.status });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: error.message }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin, token, repository: REPOSITORY, originalText: ORIGINAL_TEXT, requests,
    async readFile(filePath) {
      const response = await fetch(`${origin}/repos/${REPOSITORY}/contents/${encodeURIComponent(filePath)}?ref=main`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!response.ok) throw new Error(`Provider readback failed: ${response.status}`);
      const result = await response.json();
      return { ...result, text: Buffer.from(result.content, 'base64').toString('utf8') };
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  };
}

module.exports = { startGithubBoundary };
