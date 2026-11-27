'use strict';

// Obtain labelled inputs from immutable Git blobs. Upstream tests and application code are data.
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const ts = require('typescript');

const CORPORA = {
  'juice-shop': {
    origin: 'https://github.com/juice-shop/juice-shop', revision: '266448aba68cd8ba5915f526a128da4fa7bc3f9f', license: 'MIT'
  },
  'dom-policy': {
    origin: 'https://github.com/mozilla/eslint-plugin-no-unsanitized', revision: '7eb1c8ae4179da3bc3916ece1818cc493f026764', license: 'MPL-2.0'
  }
};
const PROPERTY_TEST = 'tests/rules/property.js';
const FIX_DIR = 'data/static/codefixes';
const APPLICATION_CASES = [
  ['loginAdminChallenge', 'routes/login.ts', 'SEC-001', 89],
  ['unionSqlInjectionChallenge', 'routes/search.ts', 'SEC-001', 89],
  ['noSqlReviewsChallenge', 'routes/updateProductReviews.ts', 'SEC-029', 943],
  ['localXssChallenge', 'frontend/src/app/search-result/search-result.component.ts', 'SEC-002', 79],
  ['restfulXssChallenge', 'frontend/src/app/search-result/search-result.component.ts', 'SEC-002', 79],
  ['redirectChallenge', 'lib/insecurity.ts', 'SEC-020', 601]
];

const sha256 = value => createHash('sha256').update(value).digest('hex');
function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1' }
  });
}

function applicationCases(root) {
  const { revision } = CORPORA['juice-shop'];
  const read = file => git(root, 'cat-file', 'blob', revision + ':' + file);
  const names = git(root, 'ls-tree', '--name-only', revision + ':' + FIX_DIR).trimEnd().split('\n');
  const cases = [];
  for (const [key, path, rule, cwe] of APPLICATION_CASES) {
    const source = read(path).split('\n');
    const marker = kind => source.flatMap((line, i) => {
      const at = line.indexOf('// vuln-code-snippet ' + kind + ' ');
      return at >= 0 && line.slice(at).split(/\s+/).includes(key) ? [i] : [];
    });
    const starts = marker('start'), ends = marker('end');
    const locations = marker('vuln-line').map(i => i + 1);
    if (starts.length !== 1 || ends.length !== 1 || !locations.length ||
        !locations.every(line => line > starts[0] + 1 && line < ends[0] + 1)) {
      throw new Error('Invalid upstream markers for ' + key);
    }
    const fixes = names.filter(name => name.startsWith(key + '_') && name.endsWith('_correct.ts'));
    if (fixes.length !== 1) throw new Error('Expected one upstream accepted TypeScript fix for ' + key);
    const fixPath = FIX_DIR + '/' + fixes[0];
    const fix = read(fixPath).trimEnd().split('\n');
    const clean = source.map(line => line.replace(/\s*\/\/ vuln-code-snippet .*$/, ''));
    const start = starts[0] + 2;
    const common = { path, rule, cwe, language: 'typescript' };
    cases.push({ ...common, id: key + '/original', positive: true, locations, start, end: ends[0], text: clean.join('\n') });
    cases.push({ ...common, id: key + '/accepted', positive: false, locations: [], start,
      end: start + fix.length - 1, acceptedFix: fixPath,
      text: [...clean.slice(0, starts[0] + 1), ...fix, ...clean.slice(ends[0])].join('\n') });
  }
  const selected = new Set(APPLICATION_CASES.map(row => row[0]));
  const omitted = names.filter(name => name.endsWith('.info.yml') && !selected.has(name.split('.')[0]));
  return { cases, excluded: omitted.map(id => ({ id, reason: 'outside the six preregistered file/rule intervals' })) };
}

function member(node, name) {
  return node.properties?.find(p => ts.isPropertyAssignment(p) && p.name.text === name)?.initializer;
}

// Read string literals from the tests' AST. Computed expressions are never evaluated.
function literal(node) {
  if (!node) return null;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.PlusToken) return null;
  const left = literal(node.left), right = literal(node.right);
  return left === null || right === null ? null : left + right;
}

function policyCases(root) {
  const source = git(root, 'cat-file', 'blob', CORPORA['dom-policy'].revision + ':' + PROPERTY_TEST);
  if (sha256(source) !== '7f34e295f0ee1299289097576e4e386e2599f0e89d2988db306ed3c2399100c8') {
    throw new Error('Unexpected upstream property test content');
  }
  return readPropertyTests(source);
}

function readPropertyTests(source) {
  const file = ts.createSourceFile(PROPERTY_TEST, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const suites = file.statements.filter(ts.isExpressionStatement).map(s => s.expression)
    .filter(call => ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression) &&
      call.expression.name.text === 'run' && literal(call.arguments[0]) === 'property');
  if (file.parseDiagnostics.length || suites.length !== 1) throw new Error('Unexpected upstream RuleTester structure');
  const cases = [], excluded = [], seen = new Map();
  for (const label of ['valid', 'invalid']) {
    const entries = member(suites[0].arguments[2], label);
    if (!entries || !ts.isArrayLiteralExpression(entries)) throw new Error('Missing upstream ' + label + ' cases');
    for (const [i, entry] of entries.elements.entries()) {
      const id = label + '/' + (i + 1), positive = label === 'invalid';
      const props = ts.isObjectLiteralExpression(entry) ? entry.properties : [];
      const spreads = props.filter(ts.isSpreadAssignment).map(p => p.expression.getText(file));
      const text = literal(member(entry, 'code') || entry);
      const otherOptions = props.some(p => !ts.isSpreadAssignment(p) && !['code', 'errors'].includes(p.name?.text));
      let reason;
      if (otherOptions || spreads.some(name => !['ECMA_VERSION_6_ONLY_OPTIONS', 'TYPESCRIPT_OPTIONS'].includes(name))) reason = 'custom configuration or parser';
      else if (text === null) reason = 'computed source';
      else if (!/\b(?:innerHTML|outerHTML)\b/.test(text)) reason = 'outside the property target';
      const language = spreads.includes('TYPESCRIPT_OPTIONS') ? 'typescript' : 'javascript';
      const identity = language + ':' + text;
      if (!reason && seen.has(identity)) {
        if (seen.get(identity) !== label) throw new Error('Conflicting upstream labels for ' + id);
        reason = 'duplicate labelled source';
      }
      if (reason) {
        excluded.push({ id, reason });
        continue;
      }
      seen.set(identity, label);
      const lines = text.split('\n');
      const errors = member(entry, 'errors');
      const explicit = errors && ts.isArrayLiteralExpression(errors)
        ? errors.elements.map(e => member(e, 'line')).filter(n => n && ts.isNumericLiteral(n)).map(n => Number(n.text)) : [];
      const nonempty = lines.flatMap((line, index) => line.trim() ? [index + 1] : []);
      const locations = positive ? [...new Set(explicit.length ? explicit : nonempty.length === 1 ? nonempty : [])] : [];
      cases.push({ id, path: language === 'typescript' ? 'src/sample.ts' : 'src/sample.js', language,
        rule: 'SEC-002', cwe: 79, positive, start: 1, end: lines.length, locations, text });
    }
  }
  return { cases, excluded };
}

module.exports = { CORPORA, applicationCases, policyCases, readPropertyTests, sha256, git };
