'use strict';

/*
 * An audit abandoned at any stage stops there: the route hands the job's
 * signal to the run, the run hands it to every read, the analysis, the
 * team's decisions and the history, and a cancellation is never swallowed as
 * a history that could not be written. Exercised through Uranus's route and
 * the code-audit service with inert provider, worker and store ports.
 */
const assert = require('assert');
const { assertAuditActive, createCodeAuditService, registerCodeAuditRoutes } = require('../apps/api/src/modules/uranus/index.ts');

async function exercise(cancelAt) {
  const controller = new AbortController();
  let launch;
  let triages = 0;
  let records = 0;
  let analyses = 0;
  let batches = 0;
  let closed = 0;
  const account = { provider: 'github', login: 'fixture', token: 'gho_fixture' };
  const service = createCodeAuditService({
    databaseConfigured: true,
    pool: () => ({}),
    identityKey: () => 'a'.repeat(64),
    gh: async () => assert.fail('an audit run reads nothing through the session transport here'),
    dbReady: async () => true,
    governanceStore: () => assert.fail('no gate is asked for'),
    /* Asked once per audit, for the team's decisions; this account is no collaborator. */
    resolveAuthorization: async () => {
      triages += 1;
      if (cancelAt === 'triage') controller.abort();
      throw new Error('not a collaborator');
    },
    reader: {},
    ports: {
      openSession: () => ({ request: async () => ({}), close: () => { closed += 1; } }),
      fetch: async () => ({}),
      auditRepository: async input => {
        assert.strictEqual(input.signal, controller.signal, 'the run passes the job signal into repository reads');
        assert.strictEqual(input.token, 'gho_fixture', 'and reads with the session\'s token');
        await input.scanner({ files: [] });
        await input.analyser({ files: [] });
        if (cancelAt === 'analysis') controller.abort();
        return { findings: [], commitSha: 'a'.repeat(40), ref: 'main' };
      },
      analyseOffThread: async (input, options) => {
        analyses += 1;
        assert.strictEqual(options.signal, controller.signal);
        return { components: [], dependencyStatus: {}, advisoryStatus: {} };
      },
      scanOffThread: async (input, options) => {
        batches += 1;
        assert.strictEqual(options.signal, controller.signal);
        return { raw: [], packages: [] };
      }
    },
    stores: {
      history: () => ({
        record: async input => {
          records += 1;
          assert.strictEqual(input.signal, controller.signal, 'persistence receives the job signal');
          if (cancelAt === 'record') controller.abort();
          assertAuditActive(input.signal);
          return { auditId: 'fixture', previous: null, firstSeen: null };
        }
      }),
      triage: () => ({ decisions: async () => assert.fail('a non-collaborator\'s audit reads no decisions') })
    }
  });
  /* The route's part: the job it asks for runs this account's audit of this ref. */
  let handler;
  const noop = () => {};
  registerCodeAuditRoutes({ get: (route, ...handlers) => { if (route === '/api/repo/:owner/:repo/code-audit') handler = handlers.at(-1); }, post: noop }, {
    providerSessionAccess: noop, alphaRepositoryAccess: noop, capabilityAccess: () => noop, auth: noop, accountAuth: noop,
    governanceAccess: () => noop, OWN_WORK: {}, governanceMutationContext: () => noop,
    governance: req => req.governance, account: req => req.gh,
    fail: () => assert.fail('the fixture starts an accepted job'), publicErrorBody: () => ({}), retainedActor: () => 'fixture',
    identityKey: () => 'a'.repeat(64),
    service: { ...service, jobs: { request: input => { launch = input.launch; return { status: 202, body: {} }; } } }
  });
  const response = { setHeader: noop, status() { return this; }, json: noop };
  const warn = console.warn;
  console.warn = () => assert.fail('cancellation must not be swallowed as a history failure');
  try {
    await handler({ query: { ref: 'main' }, params: { owner: 'fixture', repo: 'fixture' }, gh: account }, response);
    const running = launch({ signal: controller.signal, onProgress: noop });
    if (cancelAt) await assert.rejects(running, error => error.code === 'AUDIT_CANCELLED' && error.status === 499);
    else assert.strictEqual((await running).history.saved, true);
  } finally {
    console.warn = warn;
  }
  assert.strictEqual(analyses, 1);
  assert.strictEqual(batches, 1);
  assert.strictEqual(triages, cancelAt === 'analysis' ? 0 : 1);
  assert.strictEqual(records, ['analysis', 'triage'].includes(cancelAt) ? 0 : 1);
  assert(closed > 0, 'the provider session always closes');
}

(async () => {
  for (const cancelAt of [null, 'analysis', 'triage', 'record']) await exercise(cancelAt);
  console.log('code audit cancellation server tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
