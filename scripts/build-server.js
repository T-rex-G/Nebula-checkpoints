'use strict';
/*
 * Builds the compiled server into dist/server: the fallback runtime of
 * ADR-088, proven on every commit by the `server-compiled` CI job.
 *
 * The tree is the release tree, laid out as the source is, so every file a
 * module reads beside itself -- migrations, configuration, the built page --
 * is where it looks:
 *
 *  1. the server's module graph (server.js, src/, apps/api/src/ and the
 *     shared contracts) is emitted by tsc, TypeScript as JavaScript and every
 *     relative `.ts` specifier rewritten to `.js`;
 *  2. every other releasable file is copied as it is, except TypeScript
 *     source, which the compiled tree replaces;
 *  3. the built page (dist/web) is copied in, so the compiled server serves
 *     the same bytes under the same servedAssetsSha256.
 *
 * Worker and child-process entries resolve their own extension through
 * apps/api/src/entrypoint.ts, so they start the emitted files.
 *
 * dist/ is never committed and never part of the release fingerprint. What
 * runs is named by serverBuildSha256, read by the server at startup, so the
 * build must be deterministic. `--check-determinism` builds twice and fails if
 * the digests differ.
 */
const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const { discoverReleaseFiles } = require('../apps/api/src/platform/release/release-fingerprint.ts');
const { COMPILED_DIRECTORY, serverBuildDigest } = require('../apps/api/src/platform/release/server-runtime.ts');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, COMPILED_DIRECTORY);
const WEB = path.join(ROOT, 'dist', 'web');

/* The server's module graph: what it requires, and what that requires. */
const COMPILED = /^(?:server\.js|src\/.+\.js|apps\/api\/src\/.+\.ts|packages\/contracts\/src\/.+\.ts)$/;
const TYPESCRIPT = /\.(?:ts|tsx|mts|cts)$/;

const COMPILER_OPTIONS = Object.freeze({
  allowJs: true,
  checkJs: false,
  /* Types are proven by `npm run typecheck`; this build only emits. */
  noCheck: true,
  noEmitOnError: true,
  rootDir: ROOT,
  outDir: OUT,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  target: ts.ScriptTarget.ES2023,
  rewriteRelativeImportExtensions: true,
  resolveJsonModule: true,
  /* JavaScript is emitted as it was written: no added "use strict", comments kept. */
  alwaysStrict: false,
  strict: false,
  removeComments: false,
  newLine: ts.NewLineKind.LineFeed,
  sourceMap: false,
  declaration: false,
  skipLibCheck: true,
  types: []
});

function emit(files) {
  const program = ts.createProgram(files.map(file => file.absolute), COMPILER_OPTIONS);
  const result = program.emit();
  const problems = ts.getPreEmitDiagnostics(program).concat(result.diagnostics)
    .filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error);
  if (problems.length || result.emitSkipped) {
    const text = ts.formatDiagnostics(problems, {
      getCanonicalFileName: name => name, getCurrentDirectory: () => ROOT, getNewLine: () => '\n'
    });
    throw new Error(`the server did not compile:\n${text}`);
  }
}

function copy(relative, from = path.join(ROOT, relative)) {
  const to = path.join(OUT, relative);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function copyDirectory(from, relative) {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const child = path.join(from, entry.name);
    if (entry.isDirectory()) copyDirectory(child, `${relative}/${entry.name}`);
    else if (entry.isFile()) copy(`${relative}/${entry.name}`, child);
    else throw new Error(`unexpected entry in the browser build: ${relative}/${entry.name}`);
  }
}

function build() {
  if (!fs.existsSync(path.join(WEB, 'index.html'))) {
    throw new Error('The browser application is not built (dist/web); run npm run build:web first');
  }
  fs.rmSync(OUT, { recursive: true, force: true });
  const release = discoverReleaseFiles(ROOT);
  const compiled = release.filter(file => COMPILED.test(file.relative));
  emit(compiled);
  for (const file of release) {
    if (COMPILED.test(file.relative) || TYPESCRIPT.test(file.relative)) continue;
    copy(file.relative, file.absolute);
  }
  copyDirectory(WEB, 'dist/web');
  for (const file of compiled) {
    const emitted = path.join(OUT, file.relative.replace(TYPESCRIPT, '.js'));
    if (!fs.existsSync(emitted)) throw new Error(`tsc emitted nothing for ${file.relative}`);
  }
  return serverBuildDigest(OUT);
}

function main() {
  const first = build();
  if (process.argv.includes('--check-determinism')) {
    const second = build();
    if (second !== first) {
      console.error(`the server build is not deterministic: ${first} then ${second}`);
      process.exit(1);
    }
    console.log(`server build is deterministic: serverBuildSha256 ${first}`);
    return;
  }
  console.log(`built ${COMPILED_DIRECTORY.split(path.sep).join('/')}: serverBuildSha256 ${first}`);
}

if (require.main === module) {
  try { main(); } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = Object.freeze({ COMPILED, COMPILER_OPTIONS, build });
