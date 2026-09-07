'use strict';

/*
 * The hosted profile's ceilings and the documentation that tells an operator
 * what to set must agree, and the agreement has to be derived rather than
 * maintained by hand.
 *
 * What happened without this: the README described NV_UPLOAD_MAX_MB as
 * "25-2,048 MB; default 2,048" and the config registry said the variable was
 * "ignored when a hosted profile sets its own ceiling". On hosted-alpha it is
 * capped at 25 and is not ignored -- a larger value throws at startup. Someone
 * set it from the documented range, the value sat there harmlessly until the
 * next deploy, and then five consecutive deploys of unrelated commits died at
 * boot on `NV_UPLOAD_MAX_MB must be between 1 and 25`. The build succeeded
 * every time, the previous instance kept serving, and nothing said a word.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { loadHostedAlphaLimits, hostedAlphaLimitBounds } = require('../src/hosted-readiness');
const { ENTRIES } = require('../src/config-registry');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

/*
 * The ceilings, taken from the module that enforces them by asking it what it
 * accepts rather than by re-reading its table. A copy of the numbers here would
 * be the same second source of truth that caused this.
 */
const bounds = hostedAlphaLimitBounds();
const defaults = loadHostedAlphaLimits({});

/*
 * Nothing is enumerated here. A limit added to the table is covered the moment
 * it exists, which is the only way this stays true without being maintained.
 */
assert(bounds.length >= 12, `expected the hosted profile to bound many limits, found ${bounds.length}`);
assert.deepStrictEqual(bounds.map(b => b.property).sort(), Object.keys(defaults).sort(),
  'the exported bounds and the loaded limits disagree about which limits exist');

/*
 * The contract each limit keeps. The default must be reachable and the maximum
 * must be higher than it, or the limit cannot be raised -- which is the defect
 * this file exists for. Above the maximum the profile refuses and names itself,
 * so the reason reaches the deploy log instead of a bare stack trace.
 */
let raisable = 0;
for (const { property, key, fallback, maximum } of bounds) {
  assert.strictEqual(defaults[property], fallback, `${key} does not default to its declared fallback`);
  assert(Number.isSafeInteger(maximum) && maximum >= fallback,
    `${key} has a maximum below its own default`);
  if (maximum > fallback) raisable += 1;

  assert.doesNotThrow(() => loadHostedAlphaLimits({ [key]: String(maximum) }),
    `${key} must accept its own maximum`);
  assert.strictEqual(loadHostedAlphaLimits({ [key]: String(maximum) })[property], maximum,
    `${key} must honour a raised value rather than clamping it back`);
  assert.throws(() => loadHostedAlphaLimits({ [key]: String(maximum + 1) }),
    error => error instanceof RangeError && error.message.includes(key),
    `${key} must refuse a value above its maximum, naming itself`);
  assert.throws(() => loadHostedAlphaLimits({ [key]: '0' }), RangeError, `${key} must refuse zero`);
  assert.throws(() => loadHostedAlphaLimits({ [key]: '1.5' }), TypeError, `${key} must refuse a fraction`);
}
assert.strictEqual(raisable, bounds.length,
  'every hosted limit must be raisable; one whose maximum equals its default can only be lowered');

/*
 * The assertion that makes the documentation safe to follow: every value the
 * README prints for these limits must be one the hosted profile accepts. It
 * printed "default 2,048" for an upload ceiling that refused anything over 25,
 * and the reader who followed it took the service down on the next deploy.
 */
const readme = read('README.md');
const documented = new Map();
for (const match of readme.matchAll(/^\| `(NV_[A-Z_]+)` \| Optional \| ([^|]+)\|$/gm)) {
  const stated = /default ([\d,]+)/.exec(match[2]);
  if (stated) documented.set(match[1], Number(stated[1].replace(/,/g, '')));
}
const names = new Set(bounds.map(b => b.key));
const covered = [...documented.keys()].filter(key => names.has(key));
assert.strictEqual(covered.length, names.size,
  `README documents ${covered.length} of the ${names.size} bounded limits; every one needs a row`);

for (const { key } of bounds) {
  const value = documented.get(key);
  assert.doesNotThrow(() => loadHostedAlphaLimits({ [key]: String(value) }),
    `the README prints ${key} default ${value}, which the hosted profile refuses`);
}

/*
 * The warning has to be adjacent to the table it qualifies. A true sentence
 * elsewhere in a long README is not a warning, and the operator who set the
 * value that broke five deploys was reading this table.
 */
const tableStart = readme.indexOf('| `NV_EVENT_RETENTION_DAYS` |');
assert(tableStart > 0, 'the bounded-limit table has moved');
const preamble = readme.slice(Math.max(0, tableStart - 1200), tableStart);
for (const required of [/hosted profile/i, /refused at startup/i, /maximum/i, /default/i]) {
  assert(required.test(preamble),
    `the limits table needs a warning matching ${required} immediately above it`);
}
assert(!/only be lowered/i.test(preamble),
  'the warning still says a hosted limit can only be lowered; it can be raised to the maximum now');

/*
 * And the registry may not tell an operator the variable is ignored. It is
 * read, validated, and fatal when out of range -- the opposite of ignored.
 */
const upload = ENTRIES.find(entry => entry.name === 'NV_UPLOAD_MAX_MB');
assert(upload, 'NV_UPLOAD_MAX_MB is missing from the configuration registry');
assert(!/ignored/i.test(upload.summary),
  'the registry must not describe a fatal setting as ignored');
assert(/refus|caps? it lower|startup/i.test(upload.summary),
  'the registry summary must say what a hosted profile actually does with it');

/*
 * The deployment runbook is where the hosted values are copied from, so every
 * value it prints must be one the hosted profile accepts.
 */
const runbook = read('docs/operations/DEPLOY_RENDER_NEON.md');
for (const { key } of bounds) {
  const stated = new RegExp(`^${key}=(\\d+)$`, 'm').exec(runbook);
  if (!stated) continue;
  assert.doesNotThrow(() => loadHostedAlphaLimits({ [key]: stated[1] }),
    `the runbook tells an operator to set ${key}=${stated[1]}, which the hosted profile refuses`);
}

console.log(`hosted limit documentation tests passed (${bounds.length} limits, all raisable, every documented value accepted)`);
