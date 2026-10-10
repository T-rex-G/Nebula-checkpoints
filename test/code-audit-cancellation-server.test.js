'use strict';

/* Execute the server's actual route and persistence seam with inert provider/worker dependencies. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { assertAuditActive } = require('../src/code-audit');

const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const start = source.indexOf("app.get('/api/repo/:owner/:repo/code-audit',");
const end = source.indexOf('\n});', start) + '\n});'.length;
const recordStart = source.indexOf('async function recordAudit(');
const recordEnd = source.indexOf('\nfunction auditHistoryAvailable(', recordStart);
assert(start >= 0 && end > start && recordStart >= 0 && recordEnd > recordStart, 'the route and persistence seam exist');

async function exercise(cancelAt) {
  const controller = new AbortController();
  let handler;
  let launch;
  let triages = 0;
  let records = 0;
  let analyses = 0;
  let batches = 0;
  let closed = 0;
  const account = { provider: 'github', login: 'fixture' };
  const noop = () => {};
  const context = {
    app: { get: (route, ...handlers) => { handler = handlers.at(-1); } },
    providerSessionAccess: noop, alphaRepositoryAccess: noop, capabilityAccess: () => noop, auth: noop,
    assertAuditActive, identityKey: () => 'a'.repeat(64), normalizePolicyScope: input => input,
    GUARDED_PROFILES: { PROVIDER_READ: 'provider-read' }, exposureReader: {},
    createGuardedSession: () => ({ request: async () => ({}), close: () => { closed += 1; } }),
    guardedFetch: async () => ({}),
    auditJobs: { request: input => { launch = input.launch; return { status: 202, body: {} }; } },
    auditRepository: async input => {
      assert.strictEqual(input.signal, controller.signal, 'the route passes the job signal into repository reads');
      await input.scanner({ files: [] });
      await input.analyser({ files: [] });
      if (cancelAt === 'analysis') controller.abort();
      return { findings: [], commitSha: 'a'.repeat(40), ref: 'main' };
    },
    analyseOffThread: async (input, options) => { analyses += 1; assert.strictEqual(options.signal, controller.signal); return {}; },
    scanOffThread: async (input, options) => { batches += 1; assert.strictEqual(options.signal, controller.signal); return {}; },
    triageForAccount: async () => { triages += 1; if (cancelAt === 'triage') controller.abort(); return null; },
    applyTriage: result => result, withClocks: result => result,
    auditHistory: () => ({ record: async input => {
      records += 1;
      assert.strictEqual(input.signal, controller.signal, 'persistence receives the job signal');
      if (cancelAt === 'record') controller.abort();
      assertAuditActive(input.signal);
      return { auditId: 'fixture', previous: null, firstSeen: null };
    } }),
    console: { warn: () => assert.fail('cancellation must not be swallowed as a history failure') },
    cleanText: value => value,
    fail: () => assert.fail('the fixture starts an accepted job')
  };
  vm.runInNewContext(`${source.slice(start, end)}\n${source.slice(recordStart, recordEnd)}`, context);
  const response = { setHeader: noop, status() { return this; }, json: noop };
  await handler({ query: { ref: 'main' }, params: { owner: 'fixture', repo: 'fixture' }, gh: account }, response);
  const running = launch({ signal: controller.signal, onProgress: noop });
  if (cancelAt) await assert.rejects(running, error => error.code === 'AUDIT_CANCELLED' && error.status === 499);
  else assert.strictEqual((await running).history.saved, true);
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
