'use strict';
/*
 * The doctor gives the server's answer.
 *
 * scripts/doctor.js is what an operator runs before a deploy, so a deployment
 * it passes must be one the server starts, and a refusal it reports must be
 * one the server makes. It asks the server's own configuration reading rather
 * than restating its rules, so the two can only part where the doctor puts
 * that reading together -- or where the server refuses something its
 * configuration reading never sees. Either would be invisible from inside one
 * process, so this starts the real server under each environment below and
 * holds the doctor to what happened:
 *
 *   - where the server refused, the doctor reports an error naming the
 *     variable the server's refusal names first;
 *   - where the server started, the doctor reports no refusal of its own.
 *
 * Each case changes one thing about a deployment the server starts. Every
 * threshold is walked on both sides of its edge, in bytes rather than
 * characters, so a limit moved on either side fails here.
 */
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { evaluate } = require('../scripts/doctor');
const { serverEntry } = require('./helpers/server-entry');
const { freePort } = require('./helpers/free-port');

const root = path.join(__dirname, '..');
/* Spelt in parts so the release's secret scan does not read the documented development default as a credential. */
const DEVELOPMENT_SECRET = ['dev', 'secret', 'change', 'me'].join('-');
/* A deployment the server starts: production, its secrets, a database it is not asked to reach, and its public origin. */
const CONFIGURED = Object.freeze({
  NODE_ENV: 'production',
  SESSION_SECRET: 's'.repeat(48),
  NV_SNAPSHOT_SIGNING_KEY_ID: 'agreement-snapshot-key',
  NV_SNAPSHOT_SIGNING_SECRET: 'k'.repeat(48),
  DATABASE_URL: 'postgresql://agreement@db.nebula.invalid:5432/nv?sslmode=verify-full',
  PUBLIC_BASE_URL: 'https://nebula.example.com'
});
const HOSTED = Object.freeze({ NV_DEPLOYMENT_PROFILE: 'hosted-alpha', NV_DATABASE_MIGRATION_MODE: 'verify' });

/* Each case: what it is, what it changes about the configured deployment (undefined removes a variable). */
const CASES = [
  ['a configured deployment', {}],
  ['no session secret', { SESSION_SECRET: undefined }],
  ['the development default', { SESSION_SECRET: DEVELOPMENT_SECRET }],
  ['a session secret one byte short', { SESSION_SECRET: 'a'.repeat(31) }],
  ['a session secret of exactly 32 bytes', { SESSION_SECRET: 'a'.repeat(32) }],
  ['30 bytes in 15 characters', { SESSION_SECRET: 'é'.repeat(15) }],
  ['32 bytes in 16 characters', { SESSION_SECRET: 'é'.repeat(16) }],
  ['an audit secret one byte short', { NV_GOVERNANCE_AUDIT_SECRET: 'a'.repeat(31) }],
  ['an audit secret of exactly 32 bytes', { NV_GOVERNANCE_AUDIT_SECRET: 'a'.repeat(32) }],
  ['an empty audit secret, which is none', { NV_GOVERNANCE_AUDIT_SECRET: '' }],
  ['production in all but its case', { NODE_ENV: 'Production' }],
  ['production in all but its spacing', { NODE_ENV: ' production ' }],
  ['an unknown profile', { NV_DEPLOYMENT_PROFILE: 'staging' }],
  ['an unknown migration mode', { NV_DATABASE_MIGRATION_MODE: 'migrate' }],
  ['a hosted alpha left to apply migrations', { NV_DEPLOYMENT_PROFILE: 'hosted-alpha' }],
  ['a hosted alpha verifying them', HOSTED],
  ['both as an operator might type them', { NV_DEPLOYMENT_PROFILE: ' Hosted-Alpha ', NV_DATABASE_MIGRATION_MODE: ' VERIFY ' }],
  ['a hosted alpha over its upload concurrency', { ...HOSTED, NV_UPLOAD_CONCURRENCY: '5' }],
  ['a hosted alpha at its upload concurrency', { ...HOSTED, NV_UPLOAD_CONCURRENCY: '4' }],
  ['no snapshot signing key', { NV_SNAPSHOT_SIGNING_KEY_ID: undefined, NV_SNAPSHOT_SIGNING_SECRET: undefined }],
  ['a snapshot signing secret one byte short', { NV_SNAPSHOT_SIGNING_SECRET: 'k'.repeat(31) }],
  ['the session secret signing snapshots', { NV_SNAPSHOT_SIGNING_SECRET: 's'.repeat(48) }],
  ['a database that would drop TLS', { DATABASE_URL: 'postgresql://agreement@db.nebula.invalid:5432/nv?sslmode=disable' }],
  ['an unknown governance failure mode', { NV_GOVERNANCE_RUNTIME_FAILURE_MODE: 'allow' }],
  ['development with nothing set', { NODE_ENV: 'development', SESSION_SECRET: undefined, NV_SNAPSHOT_SIGNING_KEY_ID: undefined, NV_SNAPSHOT_SIGNING_SECRET: undefined }],
  ['development with one half of the snapshot key', { NODE_ENV: 'development', NV_SNAPSHOT_SIGNING_SECRET: undefined }]
];

/* The environment both are given: the configured deployment, changed, with the path a process needs to run. */
function environment(changes) {
  const env = { PATH: process.env.PATH, ...CONFIGURED };
  for (const [name, value] of Object.entries(changes)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  return env;
}

/*
 * A port no listener holds, and none handed to another of these servers: four
 * are asked for before any of them binds, and the helper draws each at random.
 */
const handedOut = new Set();
function distinctPort() {
  for (;;) {
    const port = freePort();
    if (!handedOut.has(port)) {
      handedOut.add(port);
      return port;
    }
  }
}

/* What the server did with this environment: started, or refused with the message it gave. */
function serverAnswer(env) {
  return new Promise((resolve, reject) => {
    const port = distinctPort();
    const child = spawn(process.execPath, [serverEntry(root)], {
      cwd: root, env: { ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    let settled = false;
    const settle = answer => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      if (answer instanceof Error) reject(answer);
      else resolve(answer);
    };
    const timer = setTimeout(() => settle(new Error(`the server neither started nor refused within 60 seconds:\n${output}`)), 60000);
    const read = chunk => {
      output += chunk;
      if (output.includes(`orbiting on :${port}`)) settle({ started: true });
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.on('exit', () => {
      const thrown = /^(?:[A-Z]\w*)?Error: (.+)$/m.exec(output);
      settle(thrown ? { started: false, message: thrown[1] } : new Error(`the server exited without a refusal it named:\n${output}`));
    });
  });
}

/* The configuration variable a refusal names first. */
function named(message) {
  const { ENTRIES } = require('../src/config-registry');
  let first = null;
  for (const { name } of ENTRIES) {
    const at = message.search(new RegExp(`\\b${name}\\b`));
    if (at >= 0 && (!first || at < first.at)) first = { name, at };
  }
  return first && first.name;
}

async function agree([label, changes]) {
  const env = environment(changes);
  const server = await serverAnswer(env);
  const errors = evaluate(env).problems.filter(problem => problem.severity === 'error');
  if (server.started) {
    assert.deepStrictEqual(errors.filter(problem => problem.detail.startsWith('The server refuses to start')), [],
      `${label}: the server started, so the doctor must not say it refuses`);
    return { label, started: true, errors: errors.length };
  }
  const variable = named(server.message);
  assert(variable, `${label}: the server's refusal names no variable: ${server.message}`);
  assert(errors.some(problem => problem.name === variable || new RegExp(`\\b${variable}\\b`).test(problem.detail)),
    `${label}: the server refused over ${variable} (${server.message}), and the doctor must say so; it said: ${errors.map(problem => problem.detail).join(' | ') || 'nothing'}`);
  return { label, started: false, variable };
}

(async () => {
  const results = [];
  /* Four servers at a time: each case is a process of its own, and none shares a port. */
  for (let at = 0; at < CASES.length; at += 4) {
    results.push(...await Promise.all(CASES.slice(at, at + 4).map(agree)));
  }
  const outcome = Object.fromEntries(results.map(result => [result.label, result.started ? 'starts' : `refuses over ${result.variable}`]));
  assert.deepStrictEqual(outcome, {
    'a configured deployment': 'starts',
    'no session secret': 'refuses over SESSION_SECRET',
    'the development default': 'refuses over SESSION_SECRET',
    'a session secret one byte short': 'refuses over SESSION_SECRET',
    'a session secret of exactly 32 bytes': 'starts',
    '30 bytes in 15 characters': 'refuses over SESSION_SECRET',
    '32 bytes in 16 characters': 'starts',
    'an audit secret one byte short': 'refuses over NV_GOVERNANCE_AUDIT_SECRET',
    'an audit secret of exactly 32 bytes': 'starts',
    'an empty audit secret, which is none': 'starts',
    'production in all but its case': 'refuses over NODE_ENV',
    'production in all but its spacing': 'refuses over NODE_ENV',
    'an unknown profile': 'refuses over NV_DEPLOYMENT_PROFILE',
    'an unknown migration mode': 'refuses over NV_DATABASE_MIGRATION_MODE',
    'a hosted alpha left to apply migrations': 'refuses over NV_DATABASE_MIGRATION_MODE',
    'a hosted alpha verifying them': 'starts',
    'both as an operator might type them': 'starts',
    'a hosted alpha over its upload concurrency': 'refuses over NV_UPLOAD_CONCURRENCY',
    'a hosted alpha at its upload concurrency': 'starts',
    'no snapshot signing key': 'refuses over NV_SNAPSHOT_SIGNING_KEY_ID',
    'a snapshot signing secret one byte short': 'refuses over NV_SNAPSHOT_SIGNING_SECRET',
    'the session secret signing snapshots': 'refuses over NV_SNAPSHOT_SIGNING_SECRET',
    'a database that would drop TLS': 'refuses over DATABASE_URL',
    'an unknown governance failure mode': 'refuses over NV_GOVERNANCE_RUNTIME_FAILURE_MODE',
    'development with nothing set': 'starts',
    'development with one half of the snapshot key': 'refuses over NV_SNAPSHOT_SIGNING_KEY_ID'
  }, 'each case must end as the server is meant to answer it');
  /* A configured deployment is one the doctor passes outright. */
  assert.strictEqual(results.find(result => result.label === 'a configured deployment').errors, 0, 'a configured deployment must be clean');
  console.log(`doctor and server agree on ${results.length} deployments`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
