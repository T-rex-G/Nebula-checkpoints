'use strict';

// Replay the normal repository reader and workers against one published Git tree.
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { CORPORA, git } = require('./uranus-framework-inputs');

const corpus = CORPORA['juice-shop'];
const scope = { provider: 'github', owner: 'benchmark', repo: 'benchmark' };
const sites = [
  ['routes/login.ts', 'SEC-001', 34],
  ['routes/search.ts', 'SEC-001', 23],
  ['routes/profileImageUrlUpload.ts', 'SEC-021', 24],
  ['routes/updateProductReviews.ts', 'SEC-029', 18]
];

function transportFor(checkout, reader) {
  const tree = git(checkout, 'ls-tree', '-r', '-l', '-z', corpus.revision).split('\0').filter(Boolean).map(row => {
    const tab = row.indexOf('\t');
    const [mode, type, sha, size] = row.slice(0, tab).trim().split(/\s+/);
    return { mode, type, sha, size: Number(size), path: row.slice(tab + 1) };
  });
  const byHash = new Map(tree.map(row => [row.sha, row]));
  const byPath = new Map(tree.map(row => [row.path, row]));
  function contents(row) {
    if (!row || row.type !== 'blob' || !['100644', '100755'].includes(row.mode)) throw new Error('Expected a regular benchmark blob');
    return execFileSync('git', ['-C', checkout, 'cat-file', 'blob', row.sha], {
      maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1' }
    });
  }
  const json = value => ({ statusCode: 200, body: JSON.stringify(value) });
  const prefix = '/repos/benchmark/benchmark/';
  return async ({ url, body }) => {
    const endpoint = new URL(url);
    if (endpoint.origin !== 'https://api.github.com') throw new Error('Unexpected benchmark origin');
    if (endpoint.pathname === prefix + 'commits/' + corpus.revision) return { statusCode: 200, body: corpus.revision };
    if (endpoint.pathname === prefix + 'git/trees/' + corpus.revision) return json({ tree, truncated: false });
    if (endpoint.pathname.startsWith(prefix + 'git/blobs/')) {
      const bytes = contents(byHash.get(endpoint.pathname.slice((prefix + 'git/blobs/').length)));
      return json({ encoding: 'base64', content: bytes.toString('base64') });
    }
    if (endpoint.pathname !== '/graphql') throw new Error('Unexpected request in offline benchmark');
    const repository = {};
    for (const [key, expression] of Object.entries(JSON.parse(body).variables)) {
      if (!/^e\d+$/.test(key)) continue;
      if (!expression.startsWith(corpus.revision + ':')) throw new Error('Unexpected corpus revision');
      const bytes = contents(byPath.get(expression.slice(corpus.revision.length + 1)));
      const { text } = reader.textFromBytes(bytes);
      repository['f' + key.slice(1)] = { text, isBinary: text === null, isTruncated: false, byteSize: bytes.length };
    }
    return json({ data: { repository } });
  };
}

async function main() {
  const [checkout, flag, selectedEngine, ...extra] = process.argv.slice(2);
  if (!checkout || extra.length || (flag !== undefined && (flag !== '--trusted-engine' || !selectedEngine))) {
    throw new Error('Usage: node scripts/uranus-repository-benchmark.js <juice-shop-checkout> [--trusted-engine <engine-checkout>]');
  }
  const engine = path.resolve(selectedEngine || path.join(__dirname, '..'));
  const { auditRepository, auditWorker } = require(path.join(engine, 'apps/api/src/modules/uranus/index.ts'));
  const reader = require(path.join(engine, 'apps/api/src/modules/quasar/client/exposure-reader.ts'));
  const transport = transportFor(checkout, reader);
  const audit = await auditRepository({
    reader, scope, token: 'offline-fixture', ref: corpus.revision, transport, queryTransport: transport,
    scanner: input => auditWorker.scanOffThread(input), analyser: input => auditWorker.analyseOffThread(input)
  });
  const verdicts = {};
  for (const finding of audit.findings) verdicts[finding.verdict] = (verdicts[finding.verdict] || 0) + 1;
  const spots = sites.map(([file, rule, labelledLine]) => ({
    path: file, rule, labelledLine,
    sameFileMatches: audit.findings.filter(f => f.path === file && f.rule === rule).map(({ line, verdict }) => ({ line, verdict }))
  }));
  console.log(JSON.stringify({ corpus, engineCommit: git(engine, 'rev-parse', 'HEAD').trim(), engine: audit.engine,
    coverage: audit.coverage, analysisComplete: audit.analysisComplete, findings: audit.findings.length, verdicts, spots }, null, 2));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
