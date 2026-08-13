'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 100_000;
const MAX_DIRECTORY_DEPTH = 64;
const EXCLUDED_DIRECTORIES = Object.freeze([
  '.git', '.hg', '.svn', 'node_modules', 'dist', 'build', 'out',
  'coverage', 'playwright-report', 'test-results', '.cache', '.npm'
]);
const RULES = Object.freeze([
  Object.freeze({
    rule: 'private-key',
    regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/
  }),
  Object.freeze({
    rule: 'github-token',
    regex: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/
  }),
  Object.freeze({
    rule: 'gitlab-token',
    regex: /\b(?:glpat|gloas|gldt|glrt|glrtr|glcbt|glptt|glft|glimt|glagent|glwt|glsoat|glffct)-[A-Za-z0-9_-]{12,}\b/
  }),
  Object.freeze({
    rule: 'aws-access-key',
    regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/
  }),
  Object.freeze({
    rule: 'slack-token',
    regex: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/
  }),
  Object.freeze({
    rule: 'authenticated-url',
    regex: /\b(?:https?|postgres(?:ql)?):\/\/[^\s/:@]+:[^\s@/]{16,}@[^\s]+/i
  }),
  Object.freeze({
    rule: 'contextual-provider-secret',
    regex: /\b(?:GITEA_(?:TOKEN|API_KEY)|GITHUB_APP_(?:CLIENT_SECRET|PRIVATE_KEY_BASE64|WEBHOOK_SECRET)|NPM_TOKEN|NEON_(?:API_KEY|TOKEN)|NV_SNAPSHOT_(?:SIGNING_SECRET|RETIRED_KEYS_JSON|LEGACY_KEYS_JSON)|OAUTH_(?:CLIENT_)?SECRET|SESSION_SECRET)\b[ \t]*[:=][ \t]*["']?(?!process\.env\b|\$\{|JSON\.stringify\b)(?:[A-Za-z0-9_~.+\/-]{20,}|[\[{][^\r\n]{20,})["']?/i
  })
]);

function fail(message) {
  throw new TypeError(message);
}

function normalizeRelative(relative) {
  const value = String(relative || '').replace(/\\/g, '/');
  if (
    !value ||
    path.posix.isAbsolute(value) ||
    path.posix.normalize(value) !== value ||
    value.split('/').some(part => part === '' || part === '.' || part === '..')
  ) fail('secret scan received an unsafe file path');
  return value;
}

function gitTrackedFiles(root) {
  const topLevel = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: root,
    encoding: 'utf8'
  });
  if (topLevel.error || topLevel.status !== 0) return null;
  if (fs.realpathSync(topLevel.stdout.trim()) !== fs.realpathSync(root)) return null;
  const result = spawnSync('git', ['ls-files', '--cached', '-z'], {
    cwd: root,
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    fail('tracked-file discovery failed');
  }
  if (result.stdout.length > 0 && result.stdout.at(-1) !== 0) fail('tracked-file inventory is unterminated');
  const files = result.stdout.length
    ? result.stdout.toString('utf8').split('\0').filter(Boolean).map(normalizeRelative)
    : [];
  if (files.length > MAX_FILES || new Set(files).size !== files.length) fail('tracked-file inventory is invalid');
  return files.sort();
}

function walkArchiveFiles(root) {
  const files = [];
  function visit(directory, prefix = '', depth = 0) {
    if (depth > MAX_DIRECTORY_DEPTH) fail('archive directory nesting exceeds the safe limit');
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('._')) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.includes(entry.name)) {
          visit(path.join(directory, entry.name), relative, depth + 1);
        }
      } else if (entry.isFile()) {
        files.push(normalizeRelative(relative));
        if (files.length > MAX_FILES) fail('archive file inventory exceeds the safe limit');
      }
    }
  }
  visit(root);
  return files.sort();
}

function discoverReleasableTextFiles(rootDirectory) {
  const root = fs.realpathSync(path.resolve(rootDirectory));
  return gitTrackedFiles(root) || walkArchiveFiles(root);
}

function decodeText(buffer) {
  if (buffer.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}

function scanFiles(options = {}) {
  const root = fs.realpathSync(path.resolve(options.root || process.cwd()));
  const files = Array.isArray(options.files)
    ? options.files.map(normalizeRelative)
    : discoverReleasableTextFiles(root);
  if (files.length > MAX_FILES || new Set(files).size !== files.length) fail('secret scan file inventory is invalid');
  const findings = [];
  for (const relative of [...files].sort()) {
    const absolute = path.join(root, relative);
    let metadata;
    try {
      metadata = fs.lstatSync(absolute);
    } catch (error) {
      fail(`secret scan cannot read tracked file metadata: ${relative}: ${error.code || 'unknown error'}`);
    }
    if (metadata.isSymbolicLink() || !metadata.isFile()) continue;
    if (metadata.size > MAX_FILE_BYTES) fail(`secret scan file exceeds the safe size limit: ${relative}`);
    const text = decodeText(fs.readFileSync(absolute));
    if (text === null) continue;
    for (const { rule, regex } of RULES) {
      if (regex.test(text)) findings.push(Object.freeze({ path: relative, rule }));
    }
  }
  return Object.freeze(findings.sort((left, right) =>
    left.path.localeCompare(right.path) || left.rule.localeCompare(right.rule)));
}

module.exports = Object.freeze({
  MAX_FILE_BYTES,
  MAX_DIRECTORY_DEPTH,
  RULES,
  discoverReleasableTextFiles,
  scanFiles
});
