'use strict';

// Qualification tool. Read regular TypeScript blobs directly from Git, without loading the project's configuration.
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { LIMITS } = require('../apps/api/src/modules/uranus/domain/audit-files.ts');

function readCorpus(checkout, directory) {
  const git = (...args) => execFileSync('git', ['--no-replace-objects', '-C', checkout, ...args], {
    encoding: 'utf8', maxBuffer: LIMITS.maxTotalBytes, env: { ...process.env, GIT_NO_LAZY_FETCH: '1' }
  });
  const commit = git('rev-parse', '--verify', 'HEAD^{commit}').trim();
  const listing = git('ls-tree', '-r', '-l', '-z', commit, '--', directory);
  const files = [];
  let bytes = 0;
  let excluded = 0;
  for (const entry of listing.split('\0')) {
    const match = /^(100644|100755) blob ([0-9a-f]{40,64}) +([0-9]+)\t([\s\S]+\.tsx?)$/.exec(entry);
    if (!match) continue;
    const size = Number(match[3]);
    if (size > LIMITS.maxFileBytes || files.length >= LIMITS.maxFiles || bytes + size > LIMITS.maxTotalBytes) {
      excluded++;
      continue;
    }
    files.push({ name: match[4], text: git('cat-file', 'blob', match[2]) });
    bytes += size;
  }
  if (!files.length) throw new Error('The selected tree contains no eligible TypeScript files.');
  return { commit, files, bytes, excluded };
}

function run(mode, checkout, directory) {
  const { commit, files, bytes, excluded } = readCorpus(checkout, directory);
  const startLoad = performance.now();
  let parse;
  let compilerVersion = null;
  if (mode === 'syntax') {
    const ts = require('typescript');
    compilerVersion = ts.version;
    parse = ({ name, text }) => {
      const tree = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, false);
      return tree.parseDiagnostics.length;
    };
  } else {
    const { lexJs, partners } = require('../apps/api/src/modules/uranus/domain/uranus-lex.ts');
    parse = ({ text }) => { partners(lexJs(text)); return 0; };
  }
  const loadMs = performance.now() - startLoad;
  parse(files[0]);
  const startCpu = process.cpuUsage();
  const start = performance.now();
  let diagnostics = 0;
  for (const file of files) diagnostics += parse(file);
  const wallMs = performance.now() - start;
  const cpu = process.cpuUsage(startCpu);
  return { mode, node: process.version, compilerVersion, commit, directory, files: files.length,
    bytes, excluded, loadMs, wallMs, cpuMs: (cpu.user + cpu.system) / 1000,
    processPeakRssKiB: process.resourceUsage().maxRSS, syntaxDiagnostics: mode === 'syntax' ? diagnostics : null };
}

if (require.main === module) {
  const [mode, checkout, directory] = process.argv.slice(2);
  if (!['tokens', 'syntax'].includes(mode) || !checkout || !directory) {
    process.stderr.write('Usage: node scripts/uranus-frontend-probe.js tokens|syntax CHECKOUT DIRECTORY\n');
    process.exitCode = 2;
  } else {
    process.stdout.write(JSON.stringify(run(mode, checkout, directory)) + '\n');
  }
}
