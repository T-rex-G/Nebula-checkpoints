'use strict';

/*
 * Rules over the page's syntax tree: what no browser test can show, held for
 * every line of apps/web/src.
 *
 * The page keeps what it knows in one store (apps/web/src/platform/
 * page-state.ts). A slice is replaced through it, or changed in place inside
 * `pageStore.mutate(slice, ...)`, which announces the change. A slice changed
 * in place anywhere else changes the page without telling anything that
 * shows it: the workbench's own redraws carry on, and a component that reads
 * the store goes stale. So, outside a mutate of that same slice, nothing may
 * assign into a record of a slice, count one up or down, delete from one,
 * call a method that changes one (push, splice, a Map's set...) or
 * Object.assign onto one, and nothing may replace a slice in the store's own
 * record, which the store would not announce.
 *
 * A record of a slice is followed however the page reaches it: through
 * `state` or `pageStore.get()`, a name that holds it, a destructured binding,
 * an item of a loop or of an iteration's callback, an item picked by find or
 * at, a new list or record holding the same items (filter, slice, spread),
 * what a function of the same file returns, and what a function of the same
 * file is handed by its callers. A name is the declaration it resolves to,
 * found by the TypeScript checker, so a local of the same spelling is not
 * the page's. What leaves the file is a slice handed to another module's
 * function; those calls are held to a list below, each read for whether the
 * function changes what it is given.
 *
 * The files are parsed by the TypeScript compiler, so this reads no page
 * text (test/page-reads.test.js).
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const PAGE = path.join(ROOT, 'apps', 'web', 'src');

/* Methods that change the record they are called on. */
const MUTATORS = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin', 'set', 'add', 'delete', 'clear']);
const ASSIGNMENTS = new Set([
  ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken, ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken, ts.SyntaxKind.PercentEqualsToken, ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken, ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken, ts.SyntaxKind.AmpersandEqualsToken, ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken
]);
/* Methods that answer one item of what they are called on. */
const ITEM = new Set(['find', 'findLast', 'at', 'get', 'pop', 'shift']);
/* Methods that answer a new list of the items of what they are called on. */
const ITEMS = new Set(['filter', 'slice', 'concat', 'toSorted', 'toReversed', 'toSpliced', 'flat', 'values']);
/* Iterations that hand each item to a function, and the parameter that receives it. */
const ITERATIONS = new Map([
  ['forEach', 0], ['map', 0], ['flatMap', 0], ['filter', 0], ['find', 0], ['findIndex', 0], ['findLast', 0], ['findLastIndex', 0],
  ['some', 0], ['every', 0], ['reduce', 1], ['reduceRight', 1]
]);
const PAGE_STATE_MODULES = /(?:^|\/)(?:platform\/page-state\.ts|legacy\/app\.js|\.\/app\.js)$/;

const OPTIONS = Object.freeze({
  allowJs: true, checkJs: false, noResolve: true, noLib: true, noEmit: true, types: [],
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.Preserve
});

function pageFiles(directory = PAGE) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return pageFiles(full);
    return /\.(?:js|ts|tsx)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name) ? [full] : [];
  });
}

/* One program over `files`; a file named in `texts` is that text instead of what is on disk. */
function program(files, texts = new Map()) {
  const host = ts.createCompilerHost(OPTIONS, true);
  const fromDisk = host.getSourceFile.bind(host);
  host.getSourceFile = (name, version, onError, fresh) => (texts.has(name)
    ? ts.createSourceFile(name, texts.get(name), version, true)
    : fromDisk(name, version, onError, fresh));
  return ts.createProgram(files, OPTIONS, host);
}

/* Strips parentheses, non-null assertions and casts, which change nothing about what is reached. */
function bare(node) {
  let at = node;
  for (;;) {
    if (ts.isParenthesizedExpression(at) || ts.isNonNullExpression(at) || ts.isAsExpression(at) || ts.isTypeAssertionExpression(at)
      || ts.isSatisfiesExpression(at)) at = at.expression;
    else return at;
  }
}

/*
 * What a value is of the page. The page's `state`, the store, and the store's
 * own record of the slices are roots. Anything else reached from them is a
 * part of one slice, `fresh` levels of new containers above the slice's own
 * records: 0 is a record of the slice itself, 1 a new list or record whose
 * items are, and so on.
 */
const STATE = Object.freeze({ root: 'state' });
const STORE = Object.freeze({ root: 'store' });
const SLICES = Object.freeze({ root: 'slices' });
/* A new record whose properties are the slices themselves: `{ ...state }`. */
const COPIED = Object.freeze({ root: 'copied' });
const part = (slice, fresh) => Object.freeze({ slice, fresh });
/* One step down: a property, or an item. */
function below(of, name) {
  if (!of) return null;
  if (of === STATE || of === SLICES || of === COPIED) return part(name, 0);
  if (of.root) return null;
  return part(of.slice, Math.max(of.fresh - 1, 0));
}
const item = of => (of && !of.root ? part(of.slice, Math.max(of.fresh - 1, 0)) : null);
/* A new container holding `of` as one of its items. */
const holding = of => (of && !of.root ? part(of.slice, of.fresh + 1) : null);
/* A new list or record of the items of `of`. */
const copyOf = of => (of === STATE || of === SLICES ? COPIED : holding(item(of)));
/* Of several possible values, the one nearest a slice's own records. */
function nearest(...owners) {
  const rank = of => (of.root ? -1 : of.fresh);
  return owners.filter(Boolean).sort((a, b) => rank(a) - rank(b))[0] || null;
}

/* Every in-place change of a slice in one parsed file, and every slice it hands to another module. */
function survey(source, checker) {
  const found = [];
  const handed = [];
  const imports = source.statements.some(statement => ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
    && PAGE_STATE_MODULES.test(statement.moduleSpecifier.text));
  if (!imports) return { found, handed };

  const symbolOf = node => (ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
    ? checker.getShorthandAssignmentValueSymbol(node.parent)
    : checker.getSymbolAtLocation(node));
  const declarationOf = node => {
    const symbol = ts.isIdentifier(node) ? symbolOf(node) : null;
    return symbol && symbol.declarations && symbol.declarations.length ? symbol.declarations : [];
  };
  /* What each name is given after it is declared, and where each function of the file is called. */
  const assigned = new Map();
  const callers = new Map();
  const index = node => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(bare(node.left))) {
      const symbol = symbolOf(bare(node.left));
      if (symbol) assigned.set(symbol, [...(assigned.get(symbol) || []), node.right]);
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(bare(node.expression))) {
      const symbol = symbolOf(bare(node.expression));
      if (symbol) callers.set(symbol, [...(callers.get(symbol) || []), node]);
    }
    ts.forEachChild(node, index);
  };
  index(source);

  const functionOf = declarations => {
    for (const declaration of declarations) {
      if (ts.isFunctionDeclaration(declaration)) return declaration;
      if (ts.isVariableDeclaration(declaration) && declaration.initializer
        && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) return declaration.initializer;
    }
    return null;
  };
  const nameOfFunction = fn => {
    if (ts.isFunctionDeclaration(fn) && fn.name) return symbolOf(fn.name);
    if (fn.parent && ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name) && fn.parent.initializer === fn) return symbolOf(fn.parent.name);
    return null;
  };
  const isGlobal = (node, name) => ts.isIdentifier(node) && node.text === name && declarationOf(node).length === 0;

  const memo = new Map();
  const active = new Set();
  /* What `key` is of the page, once worked out; a value that depends on itself is nothing more. */
  function remember(key, work) {
    if (memo.has(key)) return memo.get(key);
    if (active.has(key)) return null;
    active.add(key);
    let result = null;
    try {
      result = work();
    } finally {
      active.delete(key);
    }
    memo.set(key, result);
    return result;
  }
  const owner = node => (node ? remember(bare(node), () => reached(bare(node))) : null);

  function reached(node) {
    if (ts.isIdentifier(node)) return named(node);
    if (ts.isPropertyAccessExpression(node)) return below(owner(node.expression), node.name.text);
    if (ts.isElementAccessExpression(node)) {
      const key = node.argumentExpression;
      return below(owner(node.expression), key && ts.isStringLiteralLike(key) ? key.text : '[]');
    }
    if (ts.isConditionalExpression(node)) return nearest(owner(node.whenTrue), owner(node.whenFalse));
    if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind;
      if (operator === ts.SyntaxKind.AmpersandAmpersandToken || operator === ts.SyntaxKind.CommaToken || operator === ts.SyntaxKind.EqualsToken) {
        return owner(node.right);
      }
      if (operator === ts.SyntaxKind.BarBarToken || operator === ts.SyntaxKind.QuestionQuestionToken) return nearest(owner(node.left), owner(node.right));
      return null;
    }
    if (ts.isArrayLiteralExpression(node)) {
      return nearest(...node.elements.map(element => (ts.isSpreadElement(element) ? copyOf(owner(element.expression)) : holding(owner(element)))));
    }
    if (ts.isObjectLiteralExpression(node)) {
      return nearest(...node.properties.map(property => {
        if (ts.isSpreadAssignment(property)) return copyOf(owner(property.expression));
        if (ts.isPropertyAssignment(property)) return holding(owner(property.initializer));
        if (ts.isShorthandPropertyAssignment(property)) return holding(owner(property.name));
        return null;
      }));
    }
    if (ts.isCallExpression(node)) return called(node);
    return null;
  }

  function called(node) {
    const callee = bare(node.expression);
    if (ts.isPropertyAccessExpression(callee)) {
      const method = callee.name.text;
      const first = node.arguments[0];
      if (isGlobal(callee.expression, 'Array') && method === 'from') return first ? copyOf(owner(first)) : null;
      if (isGlobal(callee.expression, 'Object')) {
        if (method === 'values') return first ? copyOf(owner(first)) : null;
        if (method === 'entries') return first ? holding(copyOf(owner(first))) : null;
        if (method === 'assign') return nearest(owner(first), ...node.arguments.slice(1).map(source => copyOf(owner(source))));
        return null;
      }
      const of = owner(callee.expression);
      if (of === STORE) return method === 'get' ? SLICES : null;
      if (!of || of.root) return null;
      if (ITEM.has(method)) return item(of);
      if (ITEMS.has(method)) return copyOf(of);
      if (method === 'entries') return holding(copyOf(of));
      return null;
    }
    if (ts.isIdentifier(callee)) {
      const fn = functionOf(declarationOf(callee));
      if (fn) return remember(fn, () => returned(fn));
    }
    return null;
  }

  /* What a function of the file returns. */
  function returned(fn) {
    if (!fn.body) return null;
    if (!ts.isBlock(fn.body)) return owner(fn.body);
    const results = [];
    const look = node => {
      if (ts.isFunctionLike(node)) return;
      if (ts.isReturnStatement(node) && node.expression) results.push(owner(node.expression));
      ts.forEachChild(node, look);
    };
    ts.forEachChild(fn.body, look);
    return nearest(...results);
  }

  function named(node) {
    const symbol = symbolOf(node);
    if (!symbol) return null;
    const given = (assigned.get(symbol) || []).map(owner);
    return nearest(...(symbol.declarations || []).map(declared), ...given);
  }

  function declared(declaration) {
    if (ts.isImportSpecifier(declaration)) {
      const from = declaration.parent.parent.parent.moduleSpecifier;
      if (!ts.isStringLiteral(from) || !PAGE_STATE_MODULES.test(from.text)) return null;
      const imported = (declaration.propertyName || declaration.name).text;
      return imported === 'state' ? STATE : imported === 'pageStore' ? STORE : null;
    }
    if (ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)) return holder(declaration);
    if (ts.isBindingElement(declaration)) return remember(declaration, () => bound(declaration));
    if (ts.isParameter(declaration)) return remember(declaration, () => parameter(declaration));
    return null;
  }

  /* What a declaration, parameter or binding hands its names: its value, or the item of the loop it heads. */
  function holder(node) {
    if (ts.isVariableDeclaration(node)) {
      if (node.initializer) return owner(node.initializer);
      const loop = node.parent && node.parent.parent;
      return loop && ts.isForOfStatement(loop) && loop.initializer === node.parent ? item(owner(loop.expression)) : null;
    }
    if (ts.isParameter(node)) return remember(node, () => parameter(node));
    if (ts.isBindingElement(node)) return remember(node, () => bound(node));
    return null;
  }

  function bound(element) {
    const pattern = element.parent;
    const source = holder(pattern.parent);
    if (element.dotDotDotToken) return copyOf(source);
    if (ts.isArrayBindingPattern(pattern)) return below(source, '[]');
    const key = element.propertyName || element.name;
    return below(source, ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : '[]');
  }

  /* The slice a call to the store's mutate announces, when `fn` is the change handed to it. */
  function mutateOf(fn) {
    const call = fn.parent;
    if (!call || !ts.isCallExpression(call) || call.arguments[1] !== fn) return null;
    const callee = bare(call.expression);
    if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'mutate' || owner(callee.expression) !== STORE) return null;
    const key = call.arguments[0];
    return key && ts.isStringLiteralLike(key) ? key.text : null;
  }

  function parameter(param) {
    const fn = param.parent;
    const at = fn.parameters.indexOf(param);
    if (param.dotDotDotToken) return null;
    const call = fn.parent;
    if (call && ts.isCallExpression(call) && call.arguments.includes(fn)) {
      const announced = mutateOf(fn);
      if (announced) return at === 0 ? part(announced, 0) : null;
      const callee = bare(call.expression);
      if (ts.isPropertyAccessExpression(callee) && isGlobal(callee.expression, 'Array') && callee.name.text === 'from') {
        return call.arguments[1] === fn && at === 0 ? item(owner(call.arguments[0])) : null;
      }
      if (ts.isPropertyAccessExpression(callee) && ITERATIONS.has(callee.name.text) && call.arguments[0] === fn) {
        return at === ITERATIONS.get(callee.name.text) ? item(owner(callee.expression)) : null;
      }
      return null;
    }
    /* A function of the file: what its callers hand it. */
    const symbol = nameOfFunction(fn);
    if (!symbol) return null;
    return nearest(...(callers.get(symbol) || []).map(site => owner(site.arguments[at])));
  }

  /* The slices the mutates around `node` announce. */
  function announcedAt(node) {
    const slices = new Set();
    for (let at = node.parent; at; at = at.parent) {
      if (ts.isFunctionLike(at)) {
        const slice = mutateOf(at);
        if (slice) slices.add(slice);
      }
    }
    return slices;
  }

  const line = node => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const report = (node, slice, what) => found.push([line(node), slice, what, node.getStart(source)]);
  /* A change made to whatever `of` is. */
  function into(node, of, what) {
    if (!of) return;
    if (of === SLICES) {
      report(node, '*', 'changes the store\'s record of the slices');
      return;
    }
    if (of.root || of.fresh > 0 || announcedAt(node).has(of.slice)) return;
    report(node, of.slice, what);
  }
  /* An assignment, count or delete of `target`: a change to the record it is a property of. */
  function write(node, target, what) {
    const at = bare(target);
    if (!ts.isPropertyAccessExpression(at) && !ts.isElementAccessExpression(at)) return;
    const of = owner(at.expression);
    if (of === SLICES) {
      const key = ts.isPropertyAccessExpression(at) ? at.name.text : ts.isStringLiteralLike(at.argumentExpression) ? at.argumentExpression.text : '*';
      report(node, key, 'replaces the slice behind the store');
      return;
    }
    into(node, of, what);
  }
  /* The name a call begins with, as `Board` in `Board.pickRepositories(...)`. */
  const rootName = node => {
    let at = bare(node);
    while (ts.isPropertyAccessExpression(at) || ts.isElementAccessExpression(at) || ts.isCallExpression(at)) at = bare(at.expression);
    return ts.isIdentifier(at) ? at : null;
  };
  /* Whether a name is another module's, imported or held under a name of this file's (`const Board = PullBoard`). */
  const importedElsewhere = (name, seen = new Set()) => declarationOf(name).some(declaration => {
    if (seen.has(declaration)) return false;
    seen.add(declaration);
    if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
      const from = rootName(declaration.initializer);
      return Boolean(from) && importedElsewhere(from, seen);
    }
    if (!(ts.isImportSpecifier(declaration) || ts.isNamespaceImport(declaration) || ts.isImportClause(declaration))) return false;
    let at = declaration;
    while (at && !ts.isImportDeclaration(at)) at = at.parent;
    return Boolean(at) && !PAGE_STATE_MODULES.test(at.moduleSpecifier.text);
  });

  const visit = node => {
    if (ts.isBinaryExpression(node) && ASSIGNMENTS.has(node.operatorToken.kind)) write(node, node.left, 'assigns into the slice');
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
      && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) {
      write(node, node.operand, 'counts in the slice');
    }
    if (ts.isDeleteExpression(node)) write(node, node.expression, 'deletes from the slice');
    if (ts.isCallExpression(node)) {
      const callee = bare(node.expression);
      if (ts.isPropertyAccessExpression(callee) && MUTATORS.has(callee.name.text)) into(node, owner(callee.expression), `calls ${callee.name.text} on the slice`);
      if (ts.isPropertyAccessExpression(callee) && isGlobal(callee.expression, 'Object')
        && ['assign', 'defineProperty', 'defineProperties'].includes(callee.name.text) && node.arguments[0]) {
        into(node, owner(node.arguments[0]), `Object.${callee.name.text} onto the slice`);
      }
    }
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.arguments) {
      const root = rootName(node.expression);
      if (root && importedElsewhere(root)) {
        const announced = announcedAt(node);
        for (const argument of node.arguments) {
          const of = owner(argument);
          if (of && !of.root && !announced.has(of.slice)) handed.push([line(node), of.slice, node.expression.getText(source).replace(/\s+/g, '')]);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { found, handed };
}

/* Every in-place change to a slice in one file, as [line, slice, what, start]; `text` stands in for the file's. */
function violations(file, text) {
  const built = program([file], text === undefined ? new Map() : new Map([[file, text]]));
  return survey(built.getSourceFile(file), built.getTypeChecker()).found;
}

/* Every change and every hand-off in the page, over one program. */
function page() {
  const files = pageFiles();
  const built = program(files);
  const checker = built.getTypeChecker();
  const changes = [];
  const handoffs = [];
  for (const file of files) {
    const { found, handed } = survey(built.getSourceFile(file), checker);
    const name = path.relative(ROOT, file);
    for (const [at, slice, what] of found) changes.push(`${name}:${at} ${slice}: ${what}`);
    for (const [at, slice, callee] of handed) handoffs.push({ where: `${name}:${at}`, handoff: `${callee} <- ${slice}` });
  }
  return { changes, handoffs };
}

module.exports = { violations };

/*
 * Each function of another module the page hands a slice to, read for what
 * it does with it. None changes what it is given; one that did would be
 * called inside a mutate of that slice. A hand-off not listed fails below
 * until it is read and added.
 */
const HANDOFFS = Object.freeze({
  'AuditReports.brief <- work': 'writes a report from the repository label, a string',
  'AuditReports.csv <- work': 'writes rows from the audit and site readings; the branch is a string',
  'AuditReports.exposureSarif <- work': 'reads the ref and repository address, strings, into a new document',
  'AuditReports.sarif <- work': 'reads the ref and repository address, strings, into a new document',
  'AuditSbom.cyclonedx <- work': 'reads the name and ref, strings, into a new document',
  'AuditSbom.spdx <- work': 'reads the name and ref, strings, into a new document',
  'AuditScreen.render <- work': 'draws the audit from what it is handed and keeps nothing of it; the repository is read only by the page\'s own handlers, which it calls back',
  'Board.model <- repos': 'lists the repositories anew (inventory), then reads the readings against that list',
  'Board.pickRepositories <- repos': 'lists the repositories anew (inventory), then slices and maps that list',
  'CapabilityUI.load <- me': 'is handed the provider and authority, which are strings',
  'CodeMirror <- settings': 'takes the editor options, strings, numbers and flags, and keeps a copy of its own',
  'CodeMirror.findModeByFileName <- file': 'reads the file\'s path, a string',
  'SecurityPostureModel.model <- repos': 'lists the repositories anew (inventory) and filters that list',
  'SecurityPostureModel.model <- securityPosture': 'reads the summary\'s figures into new records and lists',
  'WorkspacePulseModel.model <- repos': 'measures what it is handed into a new model',
  'addNode <- me': 'takes the reader\'s login, a string, as the label of the demonstration\'s identity node',
  'buildNeuralGraph <- work': 'reads the owner, repository and branch, strings, into nodes of the graph\'s own',
  'defaultGovernanceSimulation <- work': 'reads the default branch, a string, into a new request',
  'drawGovernance <- governance': 'draws the screen from what it is handed and keeps nothing of it',
  'formatRoute <- work': 'writes an address from the route\'s names, strings',
  'renderGalaxyPulseGrid <- repos': 'counts the repositories and their languages into a new view, and draws that',
  'writeRoute <- work': 'writes an address from the route\'s names, strings'
});

if (require.main === module) {
  const { changes, handoffs } = page();
  if (process.argv.includes('--list')) {
    console.log([...changes, ...handoffs.map(({ where, handoff }) => `${where} hands off ${handoff}`)].join('\n'));
    console.log(`${changes.length} in-place changes outside mutate, ${handoffs.length} hand-offs`);
    process.exit(0);
  }

  const cases = [];
  const check = (name, run) => cases.push([name, run]);
  const IMPORTS = "import { pageStore, state } from '../platform/page-state.ts';\nimport * as Other from './other.js';\n";
  const planted = text => violations(path.join(PAGE, 'legacy', 'planted.js'), IMPORTS + text).map(([, slice, what]) => `${slice}: ${what}`);

  check('no slice of the page is changed in place outside a mutate of it', () => {
    assert.deepStrictEqual(changes, []);
  });

  check('each slice handed to another module goes to a function read for what it does with it', () => {
    const seen = [...new Set(handoffs.map(({ handoff }) => handoff))].sort();
    assert.deepStrictEqual(seen, Object.keys(HANDOFFS).sort(),
      `hand-offs not read yet:\n${handoffs.filter(({ handoff }) => !HANDOFFS[handoff]).map(({ where, handoff }) => `${where} ${handoff}`).join('\n')}`);
  });

  check('each form of change is seen, directly and through a held name', () => {
    assert.deepStrictEqual(planted('state.work.branch = b;'), ['work: assigns into the slice']);
    assert.deepStrictEqual(planted('pageStore.get().settings.motion = false;'), ['settings: assigns into the slice']);
    assert.deepStrictEqual(planted('state.governance.loading ||= true;'), ['governance: assigns into the slice']);
    assert.deepStrictEqual(planted('state.work.count++;'), ['work: counts in the slice']);
    assert.deepStrictEqual(planted('delete state.file.sha;'), ['file: deletes from the slice']);
    assert.deepStrictEqual(planted('state.staged.push(op);'), ['staged: calls push on the slice']);
    assert.deepStrictEqual(planted('state.work.branches.splice(0, 1);'), ['work: calls splice on the slice']);
    assert.deepStrictEqual(planted('state.fileIndex.set(k, v);'), ['fileIndex: calls set on the slice']);
    assert.deepStrictEqual(planted('Object.assign(state.settings, s);'), ['settings: Object.assign onto the slice']);
    assert.deepStrictEqual(planted('const w = state.work; w.starred = true;'), ['work: assigns into the slice']);
    assert.deepStrictEqual(planted('const list = state.repos; list.push(...batch);'), ['repos: calls push on the slice']);
    assert.deepStrictEqual(planted('const record = state.work.branches[0]; record.sha = s;'), ['work: assigns into the slice']);
    assert.deepStrictEqual(planted('function f() { const ex = state.exposure; if (x) { ex.loading = true; } }'), ['exposure: assigns into the slice']);
    assert.deepStrictEqual(planted('for (const repo of state.repos) repo.seen = true;'), ['repos: assigns into the slice']);
    assert.deepStrictEqual(planted('const { work, settings: s } = state; work.branch = b; s.wrap = false;'),
      ['work: assigns into the slice', 'settings: assigns into the slice']);
    assert.deepStrictEqual(planted('switch (k) { case 1: { break; } case 2: const f = state.file; f.dirty = true; }'), ['file: assigns into the slice']);
    assert.deepStrictEqual(planted('let w; w = state.work; w.branch = b;'), ['work: assigns into the slice']);
    assert.deepStrictEqual(planted('const { branches: [first] } = state.work; first.sha = s;'), ['work: assigns into the slice']);
  });

  check('a record of a slice is followed through calls, copies and callbacks', () => {
    /* What a function of the file returns, and what it is handed. */
    assert.deepStrictEqual(planted('function record(b) { return state.work.branches.find(x => x.name === b); }\nconst r = record(b); if (r) r.sha = s;'),
      ['work: assigns into the slice']);
    assert.deepStrictEqual(planted('const pick = () => state.work;\npick().branch = b;'), ['work: assigns into the slice']);
    assert.deepStrictEqual(planted('function mark(repo) { repo.seen = true; }\nmark(state.repos[0]);'), ['repos: assigns into the slice']);
    /* Items handed to an iteration's callback, picked out, or listed anew. */
    assert.deepStrictEqual(planted('state.repos.forEach(repo => { repo.seen = true; });'), ['repos: assigns into the slice']);
    assert.deepStrictEqual(planted('state.repos.reduce((n, repo) => { repo.seen = true; return n; }, 0);'), ['repos: assigns into the slice']);
    assert.deepStrictEqual(planted('state.repos.filter(r => r.x)[0].seen = true;'), ['repos: assigns into the slice']);
    assert.deepStrictEqual(planted('const list = [...state.repos]; list.push(x); list[0].seen = true;'), ['repos: assigns into the slice']);
    assert.deepStrictEqual(planted('for (const [, repo] of state.repos.entries()) repo.seen = true;'), ['repos: assigns into the slice']);
    assert.deepStrictEqual(planted('Object.values(state.governance)[0].x = 1;'), ['governance: assigns into the slice']);
    assert.deepStrictEqual(planted('const page = { ...state }; page.work.branch = b;'), ['work: assigns into the slice']);
    /* The store's own record of the slices, changed behind it. */
    assert.deepStrictEqual(planted('pageStore.get().work = w;'), ['work: replaces the slice behind the store']);
    assert.deepStrictEqual(planted('const all = pageStore.get(); Object.assign(all, next);'), ['*: changes the store\'s record of the slices']);
  });

  check('a slice replaced whole, a new record, a read, or a change inside a mutate of it is allowed', () => {
    assert.deepStrictEqual(planted('state.work = { ...state.work, branch: b }; state.uiEpoch++; state.repoPage += 1;'), []);
    assert.deepStrictEqual(planted('const copy = { ...state.settings }; copy.motion = false; const list = [...state.repos]; list.push(x);'), []);
    assert.deepStrictEqual(planted('state.repos.map(r => ({ ...r }))[0].seen = true; JSON.parse(JSON.stringify(state.settings)).motion = false;'), []);
    assert.deepStrictEqual(planted("pageStore.mutate('work', work => { work.branch = b; work.branches.push(x); });"), []);
    assert.deepStrictEqual(planted("pageStore.mutate('work', () => { state.work.branch = b; });"), []);
    assert.deepStrictEqual(planted("pageStore.mutate('settings', settings => { Object.assign(settings, s); });"), []);
    assert.deepStrictEqual(planted("function record() { return state.work.branches[0]; }\npageStore.mutate('work', () => { record().sha = s; });"), []);
    assert.deepStrictEqual(planted('const branch = state.work.branch; local.push(branch); state.cm.setValue("");'), []);
    /* A name that holds no part of a slice, or a parameter that hides one, is not the slice. */
    assert.deepStrictEqual(planted('let w = state.work; { const w = {}; w.x = 1; } function g(w) { w.y = 2; }'), []);
    assert.deepStrictEqual(planted('function mark(repo) { repo.seen = true; }\nmark({ name: "fresh" });'), []);
  });

  check('a state of its own, or one hidden by a local of that name, is not the page\'s', () => {
    assert.deepStrictEqual(violations(path.join(PAGE, 'x.js'), 'const state = el(); state.dataset.state = "on";'), []);
    assert.deepStrictEqual(planted('function f(state) { state.dataset.x = 1; } { const state = {}; state.y = 2; }'), []);
    assert.deepStrictEqual(planted("import { state as page } from './app.js';\npage.work.branch = b;"), ['work: assigns into the slice']);
  });

  check('a mutate announces only the slice it names', () => {
    assert.deepStrictEqual(planted("pageStore.mutate('work', work => { state.file.dirty = true; });"), ['file: assigns into the slice']);
    assert.deepStrictEqual(planted("pageStore.mutate(slice, record => { record.x = 1; });"), []);
    assert.deepStrictEqual(planted("Other.mutate('work', work => { work.branch = b; });"), [], 'a mutate of another module announces nothing, and changes nothing of the page');
    assert.deepStrictEqual(planted("Other.mutate('work', () => { state.work.branch = b; });"), ['work: assigns into the slice']);
  });

  let failed = 0;
  for (const [name, run] of cases) {
    try {
      run();
      console.log(`ok - ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`not ok - ${name}\n${error.stack}`);
    }
  }
  if (failed) {
    console.error(`${failed} of ${cases.length} page rule checks failed`);
    process.exit(1);
  }
  console.log(`page rules: ${cases.length} checks passed`);
}
