'use strict';
/*
 * The code catalogue (packages/contracts/src/codes.ts) is every
 * machine-readable code the system speaks -- the code of a refusal, of a
 * reason behind a score or a decision, of a warning -- and nothing else.
 *
 * Read from the source, not from a list someone keeps. A code is found where
 * the syntax says it is one:
 *
 *  - a property, variable or parameter named `code` or `…Code(s)`, and the
 *    names written in capitals, `…_CODE(S)`;
 *  - the argument a call passes to a parameter named so, resolved against the
 *    function or class declared in the same file; a refusal defined in
 *    another file (`fail`, `refuse`, `…Error`) has every code-shaped
 *    argument read;
 *  - a value pushed onto such a list, and what a function named `…Code`
 *    returns.
 *
 * Then three promises are checked:
 *
 *  - the page and the server never wait for a code that nothing produces (a
 *    branch for such a code is dead, and the reader gets the generic answer);
 *  - a code built from parts is declared, with every code it can become;
 *  - the browser suite's mocks speak codes the server really sends, so no
 *    test passes against an answer production cannot give.
 *
 * NV_CODES_WRITE=1 rewrites the catalogue from the source.
 */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { serverFiles } = require('./helpers/server-source');
const ts = require('typescript');
const { ERROR_CODE_FORMAT } = require('../packages/contracts/src/api-envelope.ts');

const root = path.resolve(__dirname, '..');
const rel = file => path.relative(root, file).split(path.sep).join('/');
const CATALOGUE = path.join(root, 'packages/contracts/src/codes.ts');

/* Codes composed from parts: each with every code it can become, or the family it belongs to. */
const COMPOSED = Object.freeze({
  'apps/api/src/platform/authorization/security-foundation.ts `${codePrefix}_INVALID`': { codes: ['CSRF_INVALID', 'STEP_UP_INVALID'] },
  'apps/api/src/platform/authorization/security-foundation.ts `${codePrefix}_EXPIRED`': { codes: ['CSRF_EXPIRED', 'STEP_UP_EXPIRED'] },
  /* The status a webhook destination answered with, when it was not a success. */
  'apps/api/src/modules/kepler/delivery/governance-webhook-worker.ts `WEBHOOK_HTTP_${statusCode}`': { family: 'WEBHOOK_HTTP', pattern: '^WEBHOOK_HTTP_[1-5][0-9]{2}$' }
});
const FAMILIES = Object.fromEntries(Object.values(COMPOSED).filter(entry => entry.family).map(entry => [entry.family, entry.pattern]));

/* The platform's own codes: compared against, never sent. */
/* The resolver's answers for a name with no record (ENODATA, ENOTFOUND, NXDOMAIN) are among them. */
const PLATFORM_CODES = Object.freeze(['ABORT_ERR', 'ECONNREFUSED', 'ENODATA', 'ENOENT', 'ENOTFOUND', 'ERR_BUFFER_TOO_LARGE', 'ERR_WORKER_OUT_OF_MEMORY', 'ETIMEDOUT', 'MODULE_NOT_FOUND', 'NXDOMAIN']);

/* Codes only a browser mock sends, each with its reason. */
const MOCK_ONLY_CODES = Object.freeze({
  /* The fixture's own answer to a request it has no fixture for: it fails the test loudly instead of passing it on to nothing. */
  FIXTURE_ROUTE_UNMATCHED: 'test/e2e/public-alpha-fixtures.js'
});

const CODE_NAME = /^code$|Code$|CODES?$|Codes$/;
const FOREIGN_REFUSAL = /^(?:fail|refuse|reject)$|Error$/;
const CODE_FUNCTION = /Code$/;

function walk(directory, out = []) {
  if (!fs.existsSync(directory)) return out;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') walk(full, out);
    } else if (/\.(?:js|ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

function parse(file) {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  return ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, kind);
}

const nameOf = node => node && (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isPrivateIdentifier(node)) ? node.text : '';
const calleeName = expression => ts.isIdentifier(expression) ? expression.text
  : ts.isPropertyAccessExpression(expression) ? expression.name.text : '';
const isCodeRead = node => (ts.isPropertyAccessExpression(node) && CODE_NAME.test(node.name.text)) ||
  (ts.isIdentifier(node) && CODE_NAME.test(node.text));

/* The parameter names of every function and class constructor declared in a file, by the name it is called by. */
function signatures(source) {
  const found = new Map();
  const params = list => list.map(param => ts.isIdentifier(param.name) ? param.name.text : '');
  const visit = node => {
    if (ts.isFunctionDeclaration(node) && node.name) found.set(node.name.text, params(node.parameters));
    else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      found.set(node.name.text, params(node.initializer.parameters));
    } else if (ts.isClassDeclaration(node) && node.name) {
      const constructor = node.members.find(member => ts.isConstructorDeclaration(member));
      if (constructor) found.set(node.name.text, params(constructor.parameters));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/* Every code written in one file, as produced (sent, thrown or listed) or consumed (compared against). */
function scan(file) {
  const where = rel(file);
  const produced = new Set();
  const consumed = new Set();
  const composed = new Set();
  const source = parse(file);
  const known = signatures(source);
  const take = (node, into) => {
    if (!node) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (ERROR_CODE_FORMAT.test(node.text)) into.add(node.text);
    } else if (ts.isTemplateExpression(node)) {
      const literal = [node.head.text, ...node.templateSpans.map(span => span.literal.text)].join('');
      if (/^[A-Z0-9_]+$/.test(literal)) composed.add(`${where} ${node.getText()}`);
    } else if (ts.isConditionalExpression(node)) {
      take(node.whenTrue, into);
      take(node.whenFalse, into);
    } else if (ts.isBinaryExpression(node) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) {
      take(node.left, into);
      take(node.right, into);
    } else if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) {
      take(node.expression, into);
    } else if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) take(element, into);
    }
  };
  const every = (node, into) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) take(node, into);
    ts.forEachChild(node, child => every(child, into));
  };
  const visit = node => {
    if (ts.isPropertyAssignment(node) && CODE_NAME.test(nameOf(node.name))) {
      take(node.initializer, produced);
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && CODE_NAME.test(node.name.text) && node.initializer) {
      every(node.initializer, produced);
    } else if (ts.isParameter(node) && ts.isIdentifier(node.name) && CODE_NAME.test(node.name.text) && node.initializer) {
      take(node.initializer, produced);
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && isCodeRead(node.left)) {
      take(node.right, produced);
    } else if (ts.isBinaryExpression(node) &&
        [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(node.operatorToken.kind)) {
      if (isCodeRead(node.left)) take(node.right, consumed);
      else if (isCodeRead(node.right)) take(node.left, consumed);
    } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        ['includes', 'has'].includes(node.expression.name.text) && node.arguments[0] && isCodeRead(node.arguments[0])) {
      take(node.expression.expression, consumed);
    } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        ['push', 'add', 'unshift'].includes(node.expression.name.text) && isCodeRead(node.expression.expression)) {
      for (const argument of node.arguments) take(argument, produced);
    } else if (ts.isCaseClause(node) && ts.isSwitchStatement(node.parent.parent) && isCodeRead(node.parent.parent.expression)) {
      take(node.expression, consumed);
    } else if (ts.isReturnStatement(node) && node.expression) {
      let owner = node.parent;
      while (owner && !ts.isFunctionLike(owner)) owner = owner.parent;
      if (CODE_FUNCTION.test(nameOf(owner && owner.name))) take(node.expression, produced);
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const name = calleeName(node.expression);
      const params = known.get(name);
      const args = node.arguments || [];
      if (params) args.forEach((argument, index) => { if (CODE_NAME.test(params[index] || '')) take(argument, produced); });
      else if (FOREIGN_REFUSAL.test(name)) for (const argument of args) take(argument, produced);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { produced, consumed, composed };
}

function gather(files) {
  const produced = new Map();
  const consumed = new Map();
  const composed = new Set();
  const note = (map, code, where) => {
    if (!map.has(code)) map.set(code, new Set());
    map.get(code).add(where);
  };
  for (const file of files) {
    const found = scan(file);
    for (const code of found.produced) note(produced, code, rel(file));
    for (const code of found.consumed) note(consumed, code, rel(file));
    for (const site of found.composed) composed.add(site);
  }
  return { produced, consumed, composed };
}

const sources = [...new Set([...serverFiles(root).map(file => path.join(root, file)), ...walk(path.join(root, 'src')), ...walk(path.join(root, 'apps')),
  ...walk(path.join(root, 'packages', 'contracts', 'src')).filter(file => file !== CATALOGUE)])];
const system = gather(sources);

/* Composed codes are declared, and declared ones still exist. */
assert.deepEqual([...system.composed].sort(), Object.keys(COMPOSED).sort(),
  'a code built from parts must be declared in COMPOSED with every code it can become');
for (const entry of Object.values(COMPOSED)) for (const code of entry.codes || []) system.produced.set(code, new Set(['composed']));
const inFamily = code => Object.values(FAMILIES).some(pattern => new RegExp(pattern).test(code));

const platform = new Set(PLATFORM_CODES);
const spoken = new Set([...system.produced.keys()].filter(code => !platform.has(code)));

if (process.env.NV_CODES_WRITE === '1') {
  const list = [...spoken].sort();
  /* The version is the catalogue's own: a new code changes its shape, and test/contracts.test.js asks for the bump, which a rewrite keeps. */
  const version = require(CATALOGUE).CODES_CONTRACT_VERSION || 1;
  fs.writeFileSync(CATALOGUE, `/*
 * Every machine-readable code the system speaks: the code of a refusal, of a
 * reason behind a score or a decision, and of a warning, each once.
 * test/codes.test.js reads the source and holds this list equal to it, so a
 * new code is added here deliberately or the test names it.
 *
 * A code is an identifier, never a sentence. The message beside it is what a
 * reader sees; a client branches on the code alone.
 */

export const CODES_CONTRACT_VERSION = ${version};

export const CODES = Object.freeze([
${list.map(code => `  '${code}'`).join(',\n')}
] as const);

/* Codes made from a value, one per value: matched by pattern rather than listed. */
export const CODE_FAMILIES: Readonly<Record<string, RegExp>> = Object.freeze({
${Object.entries(FAMILIES).map(([family, pattern]) => `  ${family}: /${pattern}/`).join(',\n')}
});

export type Code = (typeof CODES)[number];

const KNOWN: ReadonlySet<string> = new Set(CODES);

export const isCode = (value: unknown): value is Code | string =>
  typeof value === 'string' && (KNOWN.has(value) || Object.values(CODE_FAMILIES).some(pattern => pattern.test(value)));
`);
  console.log(`wrote ${list.length} codes to ${rel(CATALOGUE)}`);
}

const { CODES, CODE_FAMILIES, isCode } = require('../packages/contracts/src/codes.ts');
const catalogue = new Set(CODES);
assert.deepEqual(Object.fromEntries(Object.entries(CODE_FAMILIES).map(([family, pattern]) => [family, pattern.source])), FAMILIES,
  'the catalogue names exactly the families declared in COMPOSED');
for (const code of catalogue) assert(!inFamily(code), `${code} belongs to a family; it is not listed on its own`);
assert.deepEqual([...CODES], [...CODES].sort(), 'the catalogue is kept sorted');
assert.equal(catalogue.size, CODES.length, 'the catalogue names each code once');
assert.deepEqual({ missing: [...spoken].filter(code => !catalogue.has(code)).sort(), unused: [...catalogue].filter(code => !spoken.has(code)).sort() },
  { missing: [], unused: [] }, 'the catalogue must hold exactly the codes the source writes');

/* A code the page or the server waits for has a producer. */
const waitedFor = [...system.consumed.entries()]
  .filter(([code]) => !platform.has(code) && !spoken.has(code) && !inFamily(code))
  .map(([code, where]) => `${code} (${[...where].join(', ')})`);
assert.deepEqual(waitedFor, [], 'nothing sends these codes, so the branches that wait for them never run');

/* The browser suite's mocks speak the server's codes. */
const mocks = gather(walk(path.join(root, 'test', 'e2e')));
const invented = [...mocks.produced.entries()]
  .filter(([code, where]) => !isCode(code) && !(Object.hasOwn(MOCK_ONLY_CODES, code) && [...where].every(file => file === MOCK_ONLY_CODES[code])))
  .map(([code, where]) => `${code} (${[...where].join(', ')})`);
assert.deepEqual(invented, [], 'a mock that answers with a code the server never sends tests an answer production cannot give');
for (const code of Object.keys(MOCK_ONLY_CODES)) {
  assert(!catalogue.has(code), `${code} is a real code now; take it off MOCK_ONLY_CODES`);
  assert(mocks.produced.has(code), `${code} is no longer sent by any mock; take it off MOCK_ONLY_CODES`);
}

console.log(`code catalogue tests passed (${CODES.length} codes)`);
