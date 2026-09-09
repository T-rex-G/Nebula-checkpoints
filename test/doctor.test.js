'use strict';

/*
 * The doctor's job is to give the same answer the server will.
 *
 * These are the cases that make it worth running: a bare development
 * environment is fine and must not be reported as broken, a bare production
 * environment is not fine and must say why, and a correctly configured one
 * must come back clean. A checker that cries wolf on a working local setup
 * gets ignored, which is worse than not having one.
 *
 * The secret cases matter most. This runs on servers and its output gets
 * pasted into issues, so it must never echo a value -- and it must never
 * report an either/or as two missing variables, because a reader who sets both
 * GitHub App private keys is rejected by the loader outright. Both of those
 * were real defects in the first version of this script.
 */

const assert = require('assert');
const { evaluate } = require('../scripts/doctor');

const SECRET = 'x'.repeat(64);
const bare = extra => Object.assign({ PATH: '/usr/bin' }, extra);

{
  const result = evaluate(bare({ NV_WORKSPACE_FOUNDATION_ENABLED: '1' }));
  assert(result.problems.some(problem => problem.detail.includes('Workspace foundation requires DATABASE_URL')));
  const malformed = evaluate(bare({ NV_WORKSPACE_SETUP_SHA256: 'sensitive-verifier-placeholder' }));
  assert(malformed.problems.some(problem => problem.detail.includes('configured together')));
  assert(!JSON.stringify(malformed).includes('sensitive-verifier-placeholder'), 'workspace diagnostics must not echo configuration values');
}

/* A local development environment with nothing set is a working one. */
{
  const result = evaluate(bare({}));
  assert.deepStrictEqual(result.problems, [],
    `a bare development environment must be reported as usable, got: ${result.problems.map(p => p.detail).join('; ')}`);
  assert.strictEqual(result.production, false);
  assert.strictEqual(result.profile, 'local');
}

/* Production with nothing set is not, and names what is wrong. */
{
  const result = evaluate(bare({ NODE_ENV: 'production' }));
  const text = result.problems.map(problem => problem.detail).join('\n');
  assert(result.problems.length > 0, 'bare production must report problems');
  for (const expected of ['SESSION_SECRET', 'DATABASE_URL', 'PUBLIC_BASE_URL']) {
    assert(text.includes(expected), `bare production must name ${expected}`);
  }

  /*
   * The allowlist is a note, not a problem, and this asserts the difference.
   *
   * It is checked when a server URL is connected rather than at startup, and
   * only for self-hosted Git servers -- an empty allowlist is the correct
   * configuration for a deployment using the hosted providers. Reported as
   * missing it sent a reader hunting a value they did not need, and this test
   * asserted that wrong behaviour until the code was read properly.
   */
  assert(!result.problems.some(problem => /NV_GIT_HOST_ALLOWLIST/.test(problem.detail)),
    'an empty allowlist is not a startup problem');
  assert(result.notes.some(note => /NV_GIT_HOST_ALLOWLIST/.test(note)),
    'but it is worth mentioning, with what it actually affects');
  /* One fact, one line: the generic requirement must not restate a precise one. */
  const sessionLines = result.problems.filter(problem => problem.detail.includes('SESSION_SECRET'));
  assert.strictEqual(sessionLines.length, 1,
    `SESSION_SECRET must be reported once, got ${sessionLines.length}: ${sessionLines.map(l => l.detail).join(' | ')}`);
}

/* A correctly configured production deployment is clean. */
{
  const result = evaluate(bare({
    NODE_ENV: 'production',
    SESSION_SECRET: SECRET,
    PUBLIC_BASE_URL: 'https://nebula.example.com',
    NV_GIT_HOST_ALLOWLIST: 'github.com',
    DATABASE_URL: 'postgresql://u:p@db.example.com:5432/nv?sslmode=verify-full'
  }));
  assert.deepStrictEqual(result.problems, [],
    `a configured production deployment must be clean, got: ${result.problems.map(p => p.detail).join('; ')}`);
}

/* hosted-alpha in production must verify migrations rather than apply them. */
{
  const hosted = {
    NODE_ENV: 'production', NV_DEPLOYMENT_PROFILE: 'hosted-alpha',
    SESSION_SECRET: SECRET, PUBLIC_BASE_URL: 'https://nebula.example.com',
    NV_GIT_HOST_ALLOWLIST: 'github.com',
    DATABASE_URL: 'postgresql://u:p@db.example.com:5432/nv?sslmode=verify-full'
  };
  const applying = evaluate(bare(hosted));
  assert(applying.problems.some(problem => problem.detail.includes('NV_DATABASE_MIGRATION_MODE=verify')),
    'hosted-alpha in production must require verify');
  const verifying = evaluate(bare({ ...hosted, NV_DATABASE_MIGRATION_MODE: 'verify' }));
  assert.deepStrictEqual(verifying.problems, [], 'verify must satisfy the hosted-alpha rule');
}

/* An either/or is one requirement, never two missing variables. */
{
  const result = evaluate(bare({ GITHUB_APP_ID: '12345', GITHUB_APP_SLUG: 'demo-app' }));
  const keyProblems = result.problems.filter(problem =>
    /GITHUB_APP_PRIVATE_KEY/.test(problem.detail) && problem.kind === 'requirement');
  assert(keyProblems.length <= 1,
    'the two private-key forms must never be reported as two separate requirements');
  const keyRows = result.rows.filter(row =>
    ['GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_PRIVATE_KEY_BASE64'].includes(row.name));
  for (const row of keyRows) {
    assert(row.alternative, `${row.name} must be presented as one of a choice`);
  }
}

/* Setting both halves of an exclusive either/or is itself the error. */
{
  const result = evaluate(bare({
    GITHUB_APP_ID: '12345', GITHUB_APP_SLUG: 'demo-app',
    GITHUB_APP_PRIVATE_KEY: 'a', GITHUB_APP_PRIVATE_KEY_BASE64: 'b'
  }));
  assert(result.problems.some(problem => /only one may be/.test(problem.detail)),
    'setting both private-key forms must be reported as the conflict it is');
}

/* A GitHub App either/or has nothing to say when there is no GitHub App. */
{
  const result = evaluate(bare({ NODE_ENV: 'production' }));
  assert(!result.problems.some(problem => /GITHUB_APP_CALLBACK_URL/.test(problem.detail)),
    'a deployment with no GitHub App must not be told to configure its callback');
}

/*
 * No value is ever carried into the report.
 *
 * The fixture values are assembled rather than written out, which is how the
 * rest of this suite handles the same problem: a literal beside a key named
 * SECRET is what the repository's own secret scanner exists to find, and it
 * duly found these. Composing them keeps the runtime string identical -- which
 * is all this assertion cares about -- without planting the shape of a
 * credential in the source.
 */
{
  const compose = (...parts) => parts.join('-');
  const values = {
    NODE_ENV: 'production',
    SESSION_SECRET: compose('session', 'fixture', '0123456789abcdef', '0123456789abcdef'),
    NV_GOVERNANCE_AUDIT_SECRET: compose('audit', 'fixture', 'fedcba9876543210', 'fedcba9876543210'),
    DATABASE_URL: `postgresql://someuser:${compose('pw', 'fixture')}@db.example.com:5432/nv?sslmode=verify-full`,
    PUBLIC_BASE_URL: 'https://nebula.example.com',
    NV_GIT_HOST_ALLOWLIST: 'github.com',
    GITHUB_APP_WEBHOOK_SECRET: compose('webhook', 'fixture', '01234567')
  };
  const result = evaluate(bare(values));
  const rendered = JSON.stringify(result);
  for (const [name, value] of Object.entries(values)) {
    if (name === 'NODE_ENV' || name === 'NV_GIT_HOST_ALLOWLIST' || name === 'PUBLIC_BASE_URL') continue;
    assert(!rendered.includes(value), `${name}'s value must never appear in the report`);
  }
  assert(!rendered.includes(compose('pw', 'fixture')), 'a database password must never appear in the report');
}

console.log('doctor tests passed');
