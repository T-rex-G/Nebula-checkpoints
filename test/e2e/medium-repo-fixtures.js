'use strict';

/*
 * A medium repository, the size of this project: a few hundred files in
 * nested folders, a four-thousand-line script, three pages of commits,
 * twenty-five workflow runs of eight jobs and fifteen steps, thirty pull
 * requests and issues with long Markdown bodies. The bugs this finds only
 * appear when a list is longer than the screen, so every list here is.
 *
 * Deterministic: nothing is read from the checkout, so the fixture is the
 * same on every machine and every commit.
 */

const DIRS = {
  '': ['README.md', 'CHANGELOG.md', 'package.json', 'server.js', 'render.yaml', 'eslint.config.js'],
  public: ['app.js', 'style.css', 'index.html', 'neural.js', 'code-audit-ui.js', 'governance-ui.js', 'apple-touch-icon.png', 'manifest.json'],
  src: ['code-audit.js', 'site-check.js', 'branch-protection.js', 'public-assets.js', 'mapper.js', 'guarded-fetch.js'],
  docs: ['app-architecture.md', 'security.md', 'governance.md'],
  test: ['app.test.js', 'code-audit.test.js', 'test-matrix.test.js'],
  'test/e2e': ['routing.spec.js', 'safeguards.spec.js', 'code-audit.spec.js'],
  scripts: ['verify.js', 'test-matrix.js']
};
for (let i = 0; i < 60; i += 1) DIRS.src.push(`module-${String(i).padStart(2, '0')}.js`);
for (let i = 0; i < 120; i += 1) DIRS.test.push(`area-${String(i).padStart(3, '0')}.test.js`);
for (let i = 0; i < 80; i += 1) DIRS.docs.push(`note-${String(i).padStart(2, '0')}.md`);
for (let i = 0; i < 60; i += 1) DIRS['test/e2e'].push(`flow-${String(i).padStart(2, '0')}.spec.js`);
for (let i = 0; i < 30; i += 1) DIRS.scripts.push(`task-${String(i).padStart(2, '0')}.js`);

const FILES = Object.entries(DIRS).flatMap(([dir, names]) => names.map(name => (dir ? `${dir}/${name}` : name)));
const LONG_FILE = 'public/app.js';
const LONG_FILE_LINES = 4000;

const iso = hours => new Date(Date.UTC(2026, 8, 20) - hours * 3600e3).toISOString();
const sha = n => n.toString(16).padStart(8, '0').repeat(5);

function contentOf(file) {
  if (file === LONG_FILE) return Array.from({ length: LONG_FILE_LINES }, (_, i) => `const line${i} = ${i}; // line ${i + 1}`).join('\n');
  return `// ${file}\n${Array.from({ length: 40 }, (_, i) => `export const value${i} = ${i};`).join('\n')}\n`;
}

function treeFor(dir) {
  const prefix = dir ? `${dir}/` : '';
  const seen = new Map();
  for (const file of FILES) {
    if (!file.startsWith(prefix)) continue;
    const [head, ...more] = file.slice(prefix.length).split('/');
    const full = prefix + head;
    seen.set(full, more.length
      ? { name: head, path: full, type: 'dir', sha: sha(full.length), size: 0 }
      : { name: head, path: full, type: 'file', sha: sha(full.length + 7), size: contentOf(full).length });
  }
  return [...seen.values()].sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
}

/*
 * The description every pull request and issue carries: Markdown a reader
 * should see rendered, and markup a hostile author could write, which must
 * arrive inert.
 */
const HOSTILE = [
  '<script>window.__mdPwned = "script"</script>',
  '<img src="x" onerror="window.__mdPwned = \'onerror\'">',
  '<iframe src="https://example.com/frame"></iframe>',
  '<form action="https://example.com/steal"><input name="q"></form>',
  '<style>body { display: none }</style>',
  '<p style="position:fixed;inset:0">overlay</p>',
  '[a script link](javascript:window.__mdPwned="link")',
  '<a href="https://example.com/ok" onclick="window.__mdPwned=\'click\'">a plain link</a>'
].join('\n\n');
const LONG_BODY = [
  ...Array.from({ length: 30 }, (_, i) => `### Section ${i + 1}\n\nA paragraph long enough to wrap on a phone and run long on a desktop, with \`inline code\` and a [link](https://example.com/section-${i + 1}).\n\n\`\`\`js\nconst aVeryLongLineThatMustScrollInsideItsOwnBoxRatherThanWideningThePage = compute(argumentOne, argumentTwo, argumentThree);\n\`\`\``),
  HOSTILE
].join('\n\n');

async function mockMediumRepo(page) {
  await page.route('**/api/repo/sandbox/demo/**', async route => {
    const url = new URL(route.request().url());
    const p = url.pathname.replace('/api/repo/sandbox/demo', '');
    const json = body => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (p === '/tree') return json(treeFor(url.searchParams.get('path') || ''));
    if (p === '/files') return json({ truncated: false, files: FILES });
    if (p === '/file' && route.request().method() === 'GET') {
      const file = url.searchParams.get('path');
      if (!FILES.includes(file)) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Not found"}' });
      if (/\.png$/.test(file)) return json({ name: file.split('/').pop(), path: file, sha: sha(3), size: 2048, binary: true });
      const content = contentOf(file);
      return json({ name: file.split('/').pop(), path: file, sha: sha(content.length), size: content.length, content: Buffer.from(content).toString('base64'), encoding: 'base64' });
    }
    if (p === '/commits') {
      const pg = Number(url.searchParams.get('page') || 1);
      if (pg > 3) return json([]);
      return json(Array.from({ length: 25 }, (_, i) => {
        const n = (pg - 1) * 25 + i;
        return { sha: sha(n + 1), message: `Change ${n + 1}: ${['the audit engine', 'the safeguards panel', 'the tab strip', 'exposure filters', 'the governance lifecycle'][n % 5]}\n\nA longer body.`, author: ['maya', 'alpha-tester', 'dependabot[bot]'][n % 3], avatar: null, date: iso(n * 5) };
      }));
    }
    if (/^\/commit\/[0-9a-f]+$/.test(p)) {
      const patch = Array.from({ length: 180 }, (_, i) => `${i % 3 ? '+' : '-'}  line ${i} of a change that runs well past the edge of a phone screen, to prove the patch scrolls inside its own box`).join('\n');
      return json({ sha: p.slice(8), message: 'A change', stats: {}, files: Array.from({ length: 6 }, (_, i) => ({ filename: `public/file-${i}.js`, status: 'modified', additions: 120, deletions: 60, patch: `@@ -1,60 +1,120 @@\n${patch}` })) });
    }
    if (p === '/actions') {
      return json(Array.from({ length: 25 }, (_, i) => ({
        id: 1000 + i, name: ['CI', 'Deploy production', 'CodeQL', 'Release'][i % 4], status: i === 0 ? 'in_progress' : 'completed',
        conclusion: i === 0 ? null : i % 5 === 2 ? 'failure' : 'success', branch: i % 3 ? 'main' : 'feature/long-running',
        event: i % 2 ? 'push' : 'pull_request', sha: sha(i + 40), created_at: iso(i * 3), html_url: `https://github.com/sandbox/demo/actions/runs/${1000 + i}`, attempt: 1, number: 500 - i
      })));
    }
    if (/^\/actions\/\d+\/jobs$/.test(p)) {
      return json(Array.from({ length: 8 }, (_, j) => ({
        name: ['lint', 'typecheck', 'unit (node 22)', 'unit (node 20)', 'e2e desktop', 'e2e mobile', 'package', 'publish'][j],
        status: 'completed', conclusion: j === 4 ? 'failure' : 'success',
        steps: Array.from({ length: 15 }, (_, k) => ({
          name: ['Set up job', 'Checkout', 'Setup Node', 'Install dependencies', 'Cache', 'Build', 'Run tests', 'Upload artifacts', 'Post Setup Node', 'Post Checkout', 'Complete job', 'Report', 'Lint', 'Typecheck', 'Coverage'][k],
          status: 'completed', conclusion: j === 4 && k === 6 ? 'failure' : k > 12 ? 'skipped' : 'success'
        }))
      })));
    }
    if (p === '/pulls') {
      return json(Array.from({ length: 30 }, (_, i) => ({ number: 90 - i, title: `Pull request ${90 - i}: ${['Standards and waivers', 'Safeguards read the provider', 'A harder host'][i % 3]}`, state: i % 4 ? 'open' : 'closed', draft: false, merged: i % 4 === 0, head: `feature/branch-${i}`, base: 'main', updated_at: iso(i * 7), user: 'maya' })));
    }
    if (p === '/issues') {
      return json(Array.from({ length: 30 }, (_, i) => ({ number: 300 - i, title: `Issue ${300 - i}: reading a long list`, state: i % 3 ? 'open' : 'closed', labels: [{ name: 'bug', color: 'd73a4a' }], comments: i, updated_at: iso(i * 9), user: 'maya' })));
    }
    if (/^\/pulls\/\d+$/.test(p)) {
      const n = Number(p.split('/')[2]);
      return json({ number: n, title: `Pull request ${n}`, body: LONG_BODY, state: 'open', draft: false, merged: false, head: 'feature/long', base: 'main', user: 'maya', additions: 1200, deletions: 300, changed_files: 42 });
    }
    if (/^\/pulls\/\d+\/(files|comments|reviews)$/.test(p)) return json([]);
    if (/^\/issues\/\d+$/.test(p)) {
      const n = Number(p.split('/')[2]);
      return json({ number: n, title: `Issue ${n}`, body: LONG_BODY, state: 'open', user: 'maya', created_at: iso(30), labels: [], comments: Array.from({ length: 12 }, (_, i) => ({ user: i % 2 ? 'maya' : 'alpha-tester', created_at: iso(i), body: i === 0 ? HOSTILE : `Comment ${i + 1} with **bold** text and \`code\`.`, avatar: null })) });
    }
    return route.fallback();
  });
}

module.exports = { mockMediumRepo, FILES, LONG_FILE, LONG_FILE_LINES };
