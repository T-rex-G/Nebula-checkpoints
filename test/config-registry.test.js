'use strict';

/*
 * The configuration registry has to agree with the code, in both directions.
 *
 * A hand-written list of 111 environment variables is worth very little on its
 * own: the moment one is added, renamed or dropped, the list becomes a
 * confident description of a system that no longer exists, and the reader has
 * no way to tell. That is the failure mode of every configuration document
 * this project could have written instead.
 *
 * So the list is checked against the source. Every variable the code reads
 * must have an entry, and every entry must name a variable the code actually
 * reads. Both halves matter: the first keeps the registry complete, the second
 * keeps it from accumulating ghosts.
 *
 * The scan deliberately understands two shapes. Most reads are process.env.X,
 * but the config modules take `env` as a parameter and read env.X so they can
 * be tested against a fixture -- and a scan that only knew the first shape
 * reported 35 variables when there were 111. That undercount is the reason
 * this file asserts rather than trusts. Both are read from the syntax tree, so
 * a comment or a string that only names a setting is not a read of it.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const { ENTRIES, GROUPS } = require('../src/config-registry');

const root = path.join(__dirname, '..');
const SCANNED_ROOTS = ['src', 'apps/api/src', 'scripts', 'ci', 'db'];

/*
 * A read of configuration, as the syntax tree has it: a name of capitals,
 * taken from \`env\` or from anything's \`.env\` -- process.env, a settings
 * object's -- by property or by a quoted key. A comment or a string that only
 * names a setting reads nothing.
 */
const CONFIGURATION_NAME = /^[A-Z][A-Z0-9_]{2,}$/;
const isEnvironment = node => (ts.isIdentifier(node) && node.text === 'env') || (ts.isPropertyAccessExpression(node) && node.name.text === 'env');
function configurationReads(file) {
  const kind = file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const found = [];
  const visit = node => {
    if (ts.isPropertyAccessExpression(node) && isEnvironment(node.expression) && CONFIGURATION_NAME.test(node.name.text)) found.push(node.name.text);
    if (ts.isElementAccessExpression(node) && isEnvironment(node.expression) && ts.isStringLiteralLike(node.argumentExpression)
      && CONFIGURATION_NAME.test(node.argumentExpression.text)) found.push(node.argumentExpression.text);
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, kind));
  return found;
}

/* The registry describes configuration, not the registry's own machinery. */
const NOT_CONFIGURATION = new Set(['ENTRIES', 'GROUPS']);

function readsInSource() {
  const found = new Map();
  const visit = target => {
    const stat = fs.statSync(target);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(target)) {
        if (entry === 'node_modules') continue;
        visit(path.join(target, entry));
      }
      return;
    }
    if (!/\.(?:[cm]?js|ts)$/.test(target)) return;
    for (const name of configurationReads(target)) {
      if (NOT_CONFIGURATION.has(name)) continue;
      if (!found.has(name)) found.set(name, new Set());
      found.get(name).add(path.relative(root, target));
    }
  };
  for (const entry of SCANNED_ROOTS) {
    const target = path.join(root, entry);
    if (fs.existsSync(target)) visit(target);
  }
  return found;
}

const reads = readsInSource();
const registered = new Map(ENTRIES.map(entry => [entry.name, entry]));

/* Every entry is well formed, so the doctor can rely on the shape. */
const REQUIREMENTS = new Set(['always', 'production', 'hosted-alpha', 'group', 'optional']);
for (const entry of ENTRIES) {
  assert(entry.name && /^[A-Z][A-Z0-9_]*$/.test(entry.name), `bad name: ${entry.name}`);
  assert(Object.hasOwn(GROUPS, entry.group), `${entry.name}: unknown group ${entry.group}`);
  assert(REQUIREMENTS.has(entry.requirement), `${entry.name}: unknown requirement ${entry.requirement}`);
  assert(typeof entry.format === 'string' && entry.format.length > 2, `${entry.name}: needs a format`);
  assert(typeof entry.summary === 'string' && entry.summary.length > 20,
    `${entry.name}: needs a summary that says what it does`);
  assert(Object.hasOwn(entry, 'fallback'), `${entry.name}: must state its fallback, even if null`);
}

assert.strictEqual(registered.size, ENTRIES.length, 'the registry must not list a variable twice');

/* Nothing the code reads may be missing from the registry. */
const undocumented = [...reads.keys()].filter(name => !registered.has(name)).sort();
assert.deepStrictEqual(undocumented, [],
  `these variables are read but not registered: ${undocumented.map(name => `${name} (${[...reads.get(name)][0]})`).join(', ')}`);

/* And nothing in the registry may describe a variable the code stopped reading. */
const ghosts = ENTRIES.map(entry => entry.name).filter(name => !reads.has(name)).sort();
assert.deepStrictEqual(ghosts, [],
  `these entries no longer match any read in the source: ${ghosts.join(', ')}`);

/*
 * The deployment blueprint counts as a reader too.
 *
 * render.yaml set NV_MAINTENANCE_MODE=0 from the day it was written, and a
 * contract test asserted it was present -- while no application code read it.
 * A blueprint that configures something the code ignores is worse than one
 * that omits it: it tells an operator a control exists. Scanning only source
 * could not see that, so the blueprint is checked against the registry too.
 */
const blueprintPath = path.join(root, 'render.yaml');
if (fs.existsSync(blueprintPath)) {
  const blueprint = fs.readFileSync(blueprintPath, 'utf8');
  const declared = [...blueprint.matchAll(/^\s*-\s*key:\s*([A-Z][A-Z0-9_]*)\s*$/gm)].map(match => match[1]);
  assert(declared.length > 5, 'the blueprint should declare environment variables');

  const unregistered = declared.filter(name => !registered.has(name)).sort();
  assert.deepStrictEqual(unregistered, [],
    `render.yaml sets variables that are not in the registry: ${unregistered.join(', ')}`);

  const inert = declared.filter(name => !reads.has(name)).sort();
  assert.deepStrictEqual(inert, [],
    `render.yaml sets variables no code reads, so they do nothing: ${inert.join(', ')}`);
}

console.log(`configuration registry tests passed (${ENTRIES.length} variables across ${Object.keys(GROUPS).length} groups)`);
