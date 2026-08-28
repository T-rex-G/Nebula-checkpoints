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
 * this file asserts rather than trusts.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { ENTRIES, GROUPS } = require('../src/config-registry');

const root = path.join(__dirname, '..');
const SCANNED_ROOTS = ['src', 'scripts', 'ci', 'db', 'server.js'];

const READ_PATTERNS = [
  /process\.env\.([A-Z][A-Z0-9_]{2,})/g,
  /process\.env\[['"]([A-Z][A-Z0-9_]{2,})['"]\]/g,
  /\benv\.([A-Z][A-Z0-9_]{2,})/g,
  /\benv\[['"]([A-Z][A-Z0-9_]{2,})['"]\]/g
];

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
    if (!/\.(js|cjs|mjs)$/.test(target)) return;
    const source = fs.readFileSync(target, 'utf8');
    for (const pattern of READ_PATTERNS) {
      for (const match of source.matchAll(pattern)) {
        const name = match[1];
        if (NOT_CONFIGURATION.has(name)) continue;
        if (!found.has(name)) found.set(name, new Set());
        found.get(name).add(path.relative(root, target));
      }
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

console.log(`configuration registry tests passed (${ENTRIES.length} variables across ${Object.keys(GROUPS).length} groups)`);
