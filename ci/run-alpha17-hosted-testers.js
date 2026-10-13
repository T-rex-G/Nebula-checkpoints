'use strict';

/*
 * The hosted gate's five testers, made in the job that uses them.
 *
 * The bounded load needs five signed-in sessions and one mutation with its
 * cleanup. Those used to be secrets someone had to mint by hand and paste into
 * the environment: sign in five times, copy cookies out of a browser, build a
 * CSRF-bearing request -- a laptop procedure, with live session cookies passed
 * through a settings page. Here each tester is an invitation issued for the
 * sandbox repository and redeemed and signed in through the routes a reader
 * uses, exactly as the drills do, and released when the gate is done.
 *
 *   provision <file>   Five testers; the first signs in with the mutation
 *                      credential, the rest read-only. Writes the cookies, the
 *                      branch-create mutation and its cleanup to <file>
 *                      (mode 0600) in the shapes scripts/alpha-load.js reads.
 *   release <file>     Revokes the testers and deletes the last one's data
 *                      through /api/alpha/delete, which removes every session
 *                      that still carries the shared GitHub identity, then
 *                      removes <file>.
 *
 * It prints nothing it holds: no invitation, cookie or token.
 */

const fs = require('fs');
const { Pool } = require('pg');
const { AlphaAccessStore } = require('../src/alpha-access-store');
const drills = require('./run-alpha17-hosted-drills');

const TESTERS = 5;
const DELETION_CONFIRMATION = 'DELETE ALPHA DATA';

function configuration(env) {
  return Object.freeze({
    base: drills.requireOrigin(env, 'NV_ALPHA_BASE_URL'),
    renderServiceId: drills.requirePattern(env, 'NV_ALPHA17_RENDER_SERVICE_ID', /^srv-[a-z0-9]+$/),
    renderApiKey: drills.requireEnv(env, 'RENDER_API_KEY'),
    repository: drills.requirePattern(env, 'NV_ALPHA17_REPOSITORY', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    mutation: drills.requireEnv(env, 'NV_ALPHA17_MUTATION_CREDENTIAL'),
    readOnly: drills.requireEnv(env, 'NV_ALPHA17_READ_ONLY_CREDENTIAL'),
    runId: drills.requirePattern(env, 'NV_ALPHA17_WORKFLOW_RUN_ID', /^\d{1,20}$/)
  });
}

function dependencies(options) {
  return Object.freeze({
    fetch: options.fetch || globalThis.fetch,
    sleep: options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms))),
    now: options.now || (() => Date.now()),
    createPool: options.createPool || (connectionString => new Pool({ connectionString, max: 2 }))
  });
}

/* The staging service's own database and pepper, read the way the drills read them, and its terms. */
async function stagingContext(config, deps, options) {
  const render = drills.renderClient(deps, config.renderApiKey, config.renderServiceId);
  const service = await render.service();
  if (!service || service.autoDeploy !== 'no') drills.fail('the target service deploys on its own; testers are made only on a staging service', 'ALPHA17_DRILL_TARGET_REFUSED');
  await drills.wake(deps, config.base);
  const served = await drills.request(deps, `${config.base}/api/config`);
  const termsVersion = String(served.data && served.data.termsVersion || '');
  if (served.status !== 200 || !/^\d{4}-\d{2}-\d{2}$/.test(termsVersion)) drills.fail('the target names no terms version');
  const serviceEnv = await render.environment();
  if (!serviceEnv.DATABASE_URL || !serviceEnv.NV_ALPHA_INVITE_PEPPER) drills.fail('the target service names no database or invitation pepper');
  const pool = deps.createPool(serviceEnv.DATABASE_URL);
  return {
    deps, base: config.base, repository: config.repository, runId: `${config.runId}-load`, termsVersion, pool, testers: [],
    store: options.createStore ? options.createStore(pool, serviceEnv.NV_ALPHA_INVITE_PEPPER)
      : new AlphaAccessStore({ pool, pepper: serviceEnv.NV_ALPHA_INVITE_PEPPER })
  };
}

async function provision(file, options = {}) {
  const config = configuration(options.env || process.env);
  const deps = dependencies(options);
  const context = await stagingContext(config, deps, options);
  try {
    const testers = [];
    for (let index = 0; index < TESTERS; index += 1) {
      testers.push(await drills.provisionTester(context, `load-${index}`, index === 0 ? config.mutation : config.readOnly));
    }
    for (const tester of testers) {
      if (!(await drills.signedIn(tester))) drills.fail(`the ${tester.role} tester is not signed in`);
    }
    const [owner, repo] = config.repository.split('/');
    const repoRoute = `/api/repo/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const info = await testers[0].app.send('GET', repoRoute);
    const from = String(info.data && info.data.default_branch || '');
    if (info.status !== 200 || !from) drills.fail(`the sandbox repository could not be read (${info.status})`);
    const csrf = await testers[0].app.send('GET', '/api/security/csrf');
    if (csrf.status !== 200 || !csrf.data || !csrf.data.token) drills.fail('the mutation tester was refused a CSRF token');
    const headers = { 'x-nv': '1', 'x-nv-csrf': csrf.data.token, 'content-type': 'application/json' };
    const branch = `nvx-alpha17-${config.runId}-load`;
    const plan = {
      runId: config.runId,
      testerIds: testers.map(tester => tester.testerId),
      cookies: testers.map(tester => tester.app.snapshot()),
      mutation: { method: 'POST', path: `${repoRoute}/branches`, headers, body: { name: branch, from }, expectedStatus: 200 },
      cleanup: { method: 'DELETE', path: `${repoRoute}/branches/${encodeURIComponent(branch)}`, headers, expectedStatus: 200 }
    };
    fs.writeFileSync(file, JSON.stringify(plan), { mode: 0o600 });
    return { testers: testers.length, branch };
  } catch (error) {
    for (const tester of context.testers) await drills.revoke(context, tester).catch(() => {});
    throw error;
  } finally {
    await context.pool.end().catch(() => {});
  }
}

async function release(file, options = {}) {
  const config = configuration(options.env || process.env);
  const deps = dependencies(options);
  const plan = JSON.parse(fs.readFileSync(file, 'utf8'));
  const context = await stagingContext(config, deps, options);
  try {
    const ids = Array.isArray(plan.testerIds) ? plan.testerIds : [];
    const cookies = Array.isArray(plan.cookies) ? plan.cookies : [];
    /* All but the last are revoked, so the last one's deletion is the only claim on the identity. */
    for (const id of ids.slice(0, -1)) await context.store.revokeTester(id, 'alpha17 hosted gate complete');
    const last = cookies[cookies.length - 1];
    const app = drills.appClient(deps, config.base);
    const csrf = await app.send('GET', '/api/security/csrf', { cookie: last });
    if (csrf.status !== 200 || !csrf.data || !csrf.data.token) drills.fail('the last tester could not be released: no CSRF token');
    const deleted = await deps.fetch(`${config.base}/api/alpha/delete`, {
      method: 'POST',
      headers: { 'x-nv': '1', 'x-nv-csrf': csrf.data.token, 'content-type': 'application/json', cookie: last },
      body: JSON.stringify({ confirm: DELETION_CONFIRMATION }),
      signal: AbortSignal.timeout(30000)
    });
    const report = await deleted.json().catch(() => ({}));
    if (deleted.status !== 200 || report.status !== 'complete') drills.fail(`the last tester's data was not deleted (${deleted.status})`);
    return { released: ids.length };
  } finally {
    await context.pool.end().catch(() => {});
    fs.rmSync(file, { force: true });
  }
}

if (require.main === module) {
  const [command, file] = process.argv.slice(2);
  const run = command === 'provision' ? provision : command === 'release' ? release : null;
  if (!run || !file) {
    process.stderr.write('usage: run-alpha17-hosted-testers.js provision|release <file>\n');
    process.exitCode = 2;
  } else {
    run(file).then(result => process.stdout.write(`${JSON.stringify(result)}\n`), error => {
      process.stderr.write(`${error.code ? `${error.code}: ` : ''}${error.message}\n`);
      process.exitCode = 1;
    });
  }
}

module.exports = Object.freeze({ provision, release, TESTERS });
