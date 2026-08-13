'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const manifestPath = path.join(root, 'docs', 'DOCUMENTATION_MANIFEST.json');
const HISTORY_INTEGRITY_BASELINE = 'config/historical-document-integrity.json';
const ROOT_MARKDOWN = ['CHANGELOG.md', 'README.md'];
const LIFECYCLES = new Set([
  'entrypoint',
  'current',
  'vision',
  'architecture',
  'operational',
  'qualification',
  'historical',
  'development-record'
]);
const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.cache',
  'node_modules',
  'playwright-report',
  'test-results'
]);
function discoverMarkdown(directory, prefix = '') {
  const discovered = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) discovered.push(...discoverMarkdown(absolute, relative));
    else if (entry.isFile() && entry.name.endsWith('.md')) discovered.push(relative);
  }
  return discovered.sort();
}

function expectedLifecycle(documentPath) {
  if (['README.md', 'CHANGELOG.md', 'docs/README.md'].includes(documentPath)) return 'entrypoint';
  if (documentPath.startsWith('docs/current/') || documentPath.startsWith('docs/reference/')) return 'current';
  if (documentPath.startsWith('docs/vision/')) return 'vision';
  if (documentPath.startsWith('docs/architecture/')) return 'architecture';
  if (documentPath.startsWith('docs/operations/')) return 'operational';
  if (documentPath.startsWith('docs/qualification/') || documentPath.startsWith('docs/release/')) {
    return 'qualification';
  }
  if (documentPath.startsWith('docs/history/')) return 'historical';
  if (documentPath.startsWith('docs/superpowers/')) return 'development-record';
  return null;
}

function repositoryRelativeLinksFromSource(source) {
  const links = [];
  const patterns = [
    /!?\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+[^)]*)?\)/g,
    /^\s{0,3}\[[^\]\n]+\]:\s*(?:<([^>\n]+)>|([^\s]+))(?:\s+.*)?$/gm
  ];
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) {
    const target = (match[1] || match[2] || '').trim();
    if (
      !target ||
      target.startsWith('#') ||
      target.startsWith('/') ||
      /^[a-z][a-z0-9+.-]*:/i.test(target)
    ) continue;
    links.push(target);
  }
  return links;
}

function repositoryRelativeLinks(documentPath) {
  return repositoryRelativeLinksFromSource(
    fs.readFileSync(path.join(root, documentPath), 'utf8')
  );
}

assert.deepStrictEqual(
  repositoryRelativeLinksFromSource([
    'Read the [architecture][architecture-ref].',
    '[architecture-ref]: ../architecture/ARCHITECTURE.md "Architecture"',
    '[external-ref]: https://example.invalid/reference'
  ].join('\n')),
  ['../architecture/ARCHITECTURE.md'],
  'reference-style Markdown link definitions must pass through repository link validation'
);

function resolveRepositoryLink(documentPath, target) {
  const withoutFragment = target.split('#', 1)[0].split('?', 1)[0];
  let decoded = withoutFragment;
  try {
    decoded = decodeURIComponent(withoutFragment);
  } catch {
    // The existence assertion below reports the original malformed target.
  }
  return path.resolve(root, path.dirname(documentPath), decoded);
}

const markdown = discoverMarkdown(root);
assert.deepStrictEqual(
  markdown.filter(file => !file.includes('/')),
  ROOT_MARKDOWN,
  'root Markdown must contain only README.md and CHANGELOG.md'
);

assert(fs.existsSync(manifestPath), 'missing docs/DOCUMENTATION_MANIFEST.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
assert.deepStrictEqual(Object.keys(manifest).sort(), [
  'documents', 'historicalIntegrityBaseline', 'project', 'schemaVersion'
]);
assert.strictEqual(manifest.schemaVersion, 1);
assert.strictEqual(manifest.project, 'Nebulaverse-X');
assert.strictEqual(manifest.historicalIntegrityBaseline, HISTORY_INTEGRITY_BASELINE,
  'documentation manifest must reference the reviewed historical integrity baseline');
assert(Array.isArray(manifest.documents), 'documentation manifest must contain a documents array');

const manifestPaths = manifest.documents.map(record => record.path);
assert.strictEqual(new Set(manifestPaths).size, manifestPaths.length, 'manifest paths must be unique');
assert.deepStrictEqual([...manifestPaths].sort(), markdown, 'manifest must cover every Markdown file exactly once');

for (const record of manifest.documents) {
  assert.deepStrictEqual(
    Object.keys(record).sort(),
    ['authority', 'immutableHistory', 'lifecycle', 'path', 'releaseIncluded'],
    `${record.path} has an invalid manifest shape`
  );
  assert(LIFECYCLES.has(record.lifecycle), `${record.path} has unknown lifecycle ${record.lifecycle}`);
  assert.strictEqual(record.lifecycle, expectedLifecycle(record.path), `${record.path} is in the wrong lifecycle`);
  assert.strictEqual(record.releaseIncluded, true, `${record.path} must be included in the release archive`);
  assert.strictEqual(record.immutableHistory, record.lifecycle === 'historical', `${record.path} history flag is wrong`);
  assert.strictEqual(typeof record.authority, 'string', `${record.path} authority must be a string`);
  assert(record.authority.length > 0, `${record.path} authority must not be empty`);
  assert(fs.existsSync(path.join(root, record.path)), `manifest target does not exist: ${record.path}`);
}

const historyIntegrityPath = path.join(root, manifest.historicalIntegrityBaseline);
assert(fs.existsSync(historyIntegrityPath), 'missing historical-document integrity baseline');
const historyIntegrity = JSON.parse(fs.readFileSync(historyIntegrityPath, 'utf8'));
assert.deepStrictEqual(Object.keys(historyIntegrity).sort(), ['algorithm', 'records', 'schemaVersion']);
assert.strictEqual(historyIntegrity.schemaVersion, 1);
assert.strictEqual(historyIntegrity.algorithm, 'sha256');
assert(historyIntegrity.records && typeof historyIntegrity.records === 'object' && !Array.isArray(historyIntegrity.records));
const historicalPaths = manifest.documents
  .filter(record => record.immutableHistory)
  .map(record => record.path)
  .sort();
assert.deepStrictEqual(Object.keys(historyIntegrity.records).sort(), historicalPaths,
  'historical integrity baseline must bind every immutable manifest record exactly once');
for (const [relative, expectedHash] of Object.entries(historyIntegrity.records)) {
  assert.match(expectedHash, /^[0-9a-f]{64}$/, `${relative} has an invalid historical digest`);
  const actualHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, relative))).digest('hex');
  assert.strictEqual(actualHash, expectedHash, `${relative} does not match its immutable historical baseline`);
}

const linkFailures = [];
for (const documentPath of markdown) {
  for (const target of repositoryRelativeLinks(documentPath)) {
    const resolved = resolveRepositoryLink(documentPath, target);
    if (!(resolved === root || resolved.startsWith(`${root}${path.sep}`))) {
      linkFailures.push(`${documentPath} links outside the repository: ${target}`);
    } else if (!fs.existsSync(resolved)) {
      linkFailures.push(`${documentPath} has an unresolved repository link: ${target}`);
    }
  }
}
assert.deepStrictEqual(linkFailures, [], `documentation link failures:\n- ${linkFailures.join('\n- ')}`);

const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
for (const canonicalPath of [
  'docs/README.md',
  'docs/current/PROJECT_STATE.md',
  'docs/current/ROADMAP.md',
  'docs/vision/FOUNDER_VISION.md',
  'docs/architecture/ARCHITECTURE.md',
  'docs/architecture/ARCHITECTURE_DECISIONS.md',
  'docs/release/PUBLIC_ALPHA.md',
  'docs/release/RELEASE_SECURITY_GATES.md'
]) {
  assert(readme.includes(`](${canonicalPath})`), `README missing canonical link ${canonicalPath}`);
}

const CURRENT_TRUTH_PREFIXES = [
  'docs/current/',
  'docs/reference/',
  'docs/release/',
  'docs/operations/'
];
const STALE_CURRENT_MARKERS = [
  /Task 21 is in progress/i,
  /Current successor version:[^\n]*5\.3\.0-alpha\.16\.3/i,
  /In progress \(alpha\.16\.3\)/i,
  /^# Deploy Nebulaverse-X 5\.2\.1$/im,
  /migrations are applied automatically/i
];
for (const documentPath of markdown.filter(file =>
  CURRENT_TRUTH_PREFIXES.some(prefix => file.startsWith(prefix)))) {
  const source = fs.readFileSync(path.join(root, documentPath), 'utf8');
  for (const marker of STALE_CURRENT_MARKERS) {
    assert(!marker.test(source), `${documentPath} contains stale current-release marker ${marker}`);
  }
}

console.log('documentation architecture tests passed');
