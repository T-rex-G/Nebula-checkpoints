'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { PRODUCT_NAME, APP_VERSION } = require('../src/version');
const { runFoundationGate } = require('./foundation-gate');

const root = path.resolve(__dirname, '..');
const outputDir = path.resolve(process.argv[2] || path.join(root, 'dist'));
const basename = `${PRODUCT_NAME}-v${APP_VERSION}`;
const zipPath = path.join(outputDir, `${basename}.zip`);
const checksumPath = `${zipPath}.sha256`;
const forbiddenSegments = new Set([
  '.git', '.hg', '.svn', '.superpowers', '.agents', '.codex',
  '.cache', '.npm', '.yarn', '.pnpm-store', '.turbo', '.next',
  'node_modules', 'bower_components', '__MACOSX', 'coverage',
  'playwright-report', 'test-results', '.tmp', 'tmp', '.temp', 'temp',
  'dist', 'build', 'out'
]);
const forbiddenNames = new Set(['.DS_Store', '.eslintcache']);

function shouldInclude(relative) {
  const normalized = String(relative || '').replace(/\\/g, '/');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    path.posix.normalize(normalized) !== normalized
  ) return false;
  const parts = normalized.split('/');
  if (parts.some(part => forbiddenSegments.has(part))) return false;
  if (normalized !== '.env.example' && parts.some(part => part.startsWith('.env'))) return false;
  if (normalized === 'staging/evidence' || normalized.startsWith('staging/evidence/')) return false;
  const name = parts[parts.length - 1];
  if (forbiddenNames.has(name) || name.startsWith('._')) return false;
  if (/\.(?:log|zip|sha256)$/i.test(name)) return false;
  return true;
}


function createZipArchive() {
  const { ZipArchive } = require('archiver');
  if (typeof ZipArchive !== 'function') throw new TypeError('Archiver ZipArchive export is unavailable');
  return new ZipArchive({ zlib: { level: 9 } });
}

function resolveProspectivePath(target) {
  let existing = target;
  const missing = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(fs.realpathSync(existing), ...missing);
}

function assertExternalOutputDirectory() {
  const source = fs.realpathSync(root);
  const target = resolveProspectivePath(outputDir);
  const relative = path.relative(source, target);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
    throw new Error('Release output directory must be outside the source root');
  }
}

function discoverReleaseManifest() {
  const result = spawnSync('git', ['ls-files', '--cached', '-z'], {
    cwd: root,
    encoding: 'buffer',
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.error) {
    if (result.error.code === 'ENOENT') {
      throw new Error('Release manifest discovery failed: git is unavailable');
    }
    throw new Error(`Release manifest discovery failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `Release manifest discovery failed: git ls-files exited ${result.status}: ${String(result.stderr || '').trim()}`
    );
  }
  if (!Buffer.isBuffer(result.stdout) || result.stdout.length === 0 || result.stdout.at(-1) !== 0) {
    throw new Error('Release manifest is inconsistent: git returned an empty or unterminated manifest');
  }
  const tracked = result.stdout.toString('utf8').split('\0');
  tracked.pop();
  if (!tracked.length) throw new Error('Release manifest is inconsistent: git returned no tracked files');
  if (new Set(tracked).size !== tracked.length) {
    throw new Error('Release manifest is inconsistent: duplicate tracked paths');
  }
  for (const relative of tracked) {
    if (
      !relative ||
      relative.includes('\\') ||
      path.posix.isAbsolute(relative) ||
      path.posix.normalize(relative) !== relative
    ) {
      throw new Error(`Release manifest is inconsistent: invalid tracked path: ${relative}`);
    }
  }
  const untrackedResult = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'buffer',
    maxBuffer: 16 * 1024 * 1024
  });
  if (untrackedResult.error) {
    if (untrackedResult.error.code === 'ENOENT') {
      throw new Error('Release manifest discovery failed: git is unavailable');
    }
    throw new Error(`Release manifest discovery failed: ${untrackedResult.error.message}`);
  }
  if (untrackedResult.status !== 0) {
    throw new Error(
      `Release manifest discovery failed: git ls-files exited ${untrackedResult.status}: ${String(untrackedResult.stderr || '').trim()}`
    );
  }
  if (
    !Buffer.isBuffer(untrackedResult.stdout) ||
    (untrackedResult.stdout.length > 0 && untrackedResult.stdout.at(-1) !== 0)
  ) {
    throw new Error('Release manifest is inconsistent: git returned an unterminated untracked-path inventory');
  }
  const untracked = untrackedResult.stdout.length
    ? untrackedResult.stdout.toString('utf8').split('\0').filter(Boolean)
    : [];
  const untrackedReleasable = untracked.filter(shouldInclude).sort();
  if (untrackedReleasable.length) {
    throw new Error(`Release manifest is inconsistent: untracked releasable path: ${untrackedReleasable[0]}`);
  }
  tracked.sort();
  return tracked.filter(shouldInclude).map(relative => {
    const absolute = path.join(root, relative);
    let stat;
    try {
      stat = fs.lstatSync(absolute);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error(`Release manifest is inconsistent: tracked file is missing: ${relative}`);
      }
      throw error;
    }
    if (!stat.isFile()) {
      throw new Error(`Release manifest is inconsistent: tracked path is not a regular file: ${relative}`);
    }
    return { absolute, relative };
  });
}

async function main() {
  runFoundationGate();
  assertExternalOutputDirectory();
  const files = discoverReleaseManifest();
  fs.mkdirSync(outputDir, { recursive: true });
  fs.rmSync(zipPath, { force: true });
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath, { mode: 0o600 });
    const archive = createZipArchive();
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('warning', warning => warning.code === 'ENOENT' ? undefined : reject(warning));
    archive.on('error', reject);
    archive.pipe(output);
    for (const file of files) {
      archive.append(fs.readFileSync(file.absolute), { name: `${basename}/${file.relative}`, date: new Date('2026-01-01T00:00:00Z'), mode: 0o644 });
    }
    archive.finalize();
  });
  const digest = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex');
  fs.writeFileSync(checksumPath, `${digest}  ${path.basename(zipPath)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ zipPath, checksumPath, sha256: digest, files: files.length }, null, 2));
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
}

module.exports = {
  shouldInclude,
  assertExternalOutputDirectory,
  discoverReleaseManifest,
  createZipArchive,
  main
};
