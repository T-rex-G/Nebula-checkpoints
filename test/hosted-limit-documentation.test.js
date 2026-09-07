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
const { loadHostedAlphaLimits } = require('../src/hosted-readiness');
const { ENTRIES } = require('../src/config-registry');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

/*
 * The ceilings, taken from the module that enforces them by asking it what it
 * accepts rather than by re-reading its table. A copy of the numbers here would
 * be the same second source of truth that caused this.
 */
const ceilings = loadHostedAlphaLimits({});
const KEYS = Object.freeze({
  eventRetentionDays: 'NV_EVENT_RETENTION_DAYS',
  sessionRetentionDays: 'NV_SESSION_RETENTION_DAYS',
  liveClientsPerRepo: 'NV_LIVE_CLIENTS_PER_REPO',
  liveClientsTotal: 'NV_LIVE_CLIENTS_TOTAL',
  snapshotRetentionCount: 'NV_SNAPSHOT_RETENTION_COUNT',
  snapshotManifestMax: 'NV_SNAPSHOT_MANIFEST_MAX',
  gitDataMaxMb: 'NV_GIT_DATA_MAX_MB',
  nativePushMaxMb: 'NV_NATIVE_PUSH_MAX_MB',
  uploadMaxMb: 'NV_UPLOAD_MAX_MB',
  uploadConcurrency: 'NV_UPLOAD_CONCURRENCY',
  uploadTimeoutMinutes: 'NV_UPLOAD_TIMEOUT_MINUTES',
  staleUploadHours: 'NV_STALE_UPLOAD_HOURS'
});

/* The property list is derived too, so a limit added later cannot slip past. */
assert.deepStrictEqual(Object.keys(ceilings).sort(), Object.keys(KEYS).sort(),
  'a hosted limit exists that this guard does not know the environment name of');

/*
 * The ceiling is the default, which is the whole trap: a limit can be lowered
 * and never raised. If that ever stops being true the warning below is wrong
 * and must be rewritten, so it fails here rather than misleading a reader.
 */
for (const [property, key] of Object.entries(KEYS)) {
  const ceiling = ceilings[property];
  assert(Number.isSafeInteger(ceiling) && ceiling >= 1, `${key} has no usable ceiling`);
  assert.throws(() => loadHostedAlphaLimits({ [key]: String(ceiling + 1) }),
    error => error instanceof RangeError && error.message.includes(key),
    `${key} must refuse a value above its ceiling, naming itself`);
  assert.doesNotThrow(() => loadHostedAlphaLimits({ [key]: String(ceiling) }),
    `${key} must accept its own ceiling`);
  assert.throws(() => loadHostedAlphaLimits({ [key]: '0' }), RangeError, `${key} must refuse zero`);
}

/*
 * Every documented default is checked against the ceiling that would actually
 * be enforced. This is the assertion that would have caught the defect: eleven
 * of the twelve documented defaults are refused by the hosted profile, and the
 * README must warn about that rather than presenting them as safe values.
 */
const readme = read('README.md');
const documented = new Map();
for (const match of readme.matchAll(/^\| `(NV_[A-Z_]+)` \| Optional \| ([^|]+)\|$/gm)) {
  const stated = /default ([\d,]+)/.exec(match[2]);
  if (stated) documented.set(match[1], Number(stated[1].replace(/,/g, '')));
}
const names = new Set(Object.values(KEYS));
const covered = [...documented.keys()].filter(key => names.has(key));
assert.strictEqual(covered.length, names.size,
  `README documents ${covered.length} of the ${names.size} bounded limits; every one needs a row`);

const aboveCeiling = [];
for (const [property, key] of Object.entries(KEYS)) {
  if (documented.get(key) > ceilings[property]) aboveCeiling.push(key);
}
assert(aboveCeiling.length > 0,
  'no documented default exceeds a hosted ceiling any more -- rewrite the README warning, it is now false');

/*
 * The warning has to be adjacent to the table it qualifies. A true sentence
 * elsewhere in a long README is not a warning, and the operator who set the
 * value that broke five deploys was reading this table.
 */
const tableStart = readme.indexOf('| `NV_EVENT_RETENTION_DAYS` |');
assert(tableStart > 0, 'the bounded-limit table has moved');
const preamble = readme.slice(Math.max(0, tableStart - 1200), tableStart);
for (const required of [/hosted profile/i, /refused at startup|refused at start/i, /self-hosted default/i]) {
  assert(required.test(preamble),
    `the limits table needs a warning matching ${required} immediately above it`);
}
assert(/only be lowered/i.test(preamble), 'the warning must say the direction the cap allows');

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
for (const [property, key] of Object.entries(KEYS)) {
  const stated = new RegExp(`^${key}=(\\d+)$`, 'm').exec(runbook);
  if (!stated) continue;
  const value = Number(stated[1]);
  assert.doesNotThrow(() => loadHostedAlphaLimits({ [key]: String(value) }),
    `the runbook tells an operator to set ${key}=${value}, which the hosted profile refuses`);
}

console.log(`hosted limit documentation tests passed (${names.size} limits, ${aboveCeiling.length} documented defaults above their ceiling)`);
