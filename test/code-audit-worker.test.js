'use strict';

/*
 * The analysis on a worker thread: the same result as in-process, the main
 * thread free while it runs, a run stopped by its heap or its time answered
 * by a rules-only run that says so, a failure that never quotes the code it
 * was reading, and one analysis at a time with a short, bounded queue.
 */

const assert = require('assert');
const { EventEmitter } = require('events');
const { analyse } = require('../src/code-audit');
const { analyseOffThread, BUDGET } = require('../src/code-audit-worker');

const I = '$';
const files = [
  { path: 'README.md', text: '# demo\n' },
  { path: 'package.json', text: JSON.stringify({ name: 'demo', dependencies: { express: '^4.0.0' } }) },
  { path: 'server/app.js', text: ["const express = require('express');", 'const app = express();', "app.get('/u/:id', async (req, res) => {", `  await db.query(\`SELECT * FROM users WHERE id = ${I}{req.params.id}\`);`, '});', ''].join('\n') }
];
const input = { files, paths: files.map(file => file.path), registry: new Map(), advisories: new Map() };
const strip = result => JSON.parse(JSON.stringify(result));

/* A stand-in for Worker that fails the way a thread can, without starting one. */
function fakeWorker(behaviour) {
  return class extends EventEmitter {
    constructor() {
      super();
      setImmediate(() => behaviour(this));
    }
    terminate() { return Promise.resolve(0); }
    getHeapStatistics() { return Promise.resolve({ used_heap_size: 1 }); }
  };
}

(async () => {
  assert(BUDGET.heapMb <= 256, 'the worker heap leaves room for the server under a 512 MB instance');
  assert(BUDGET.traceMs < BUDGET.hardMs, 'tracing stops starting files well before the worker is stopped');

  /* ---- The same answer, off the main thread ---------------------------------------------------- */
  {
    const stages = [];
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 5);
    const result = await analyseOffThread(input, { onStage: stage => stages.push(stage) });
    clearInterval(timer);
    assert.deepStrictEqual(strip(result), strip(analyse(input)));
    assert.deepStrictEqual(stages, ['analysing']);
    assert(ticks > 0, 'the main thread kept running while the worker analysed');
    assert.strictEqual(result.engine.traced.cut, 0);
  }

  /* ---- Exploit intelligence crosses to the worker with the advisories ------------------------- */
  {
    const lock = { lockfileVersion: 3, packages: { '': { dependencies: { express: '^4.0.0' } }, 'node_modules/express': { version: '4.17.1' } } };
    const withLock = { ...input, files: [...files, { path: 'package-lock.json', text: JSON.stringify(lock) }] };
    withLock.paths = withLock.files.map(file => file.path);
    withLock.advisories = new Map([['npm:express@4.17.1', { advisories: [{ id: 'GHSA-qw6h-vgh9-j6wx', cve: 'CVE-2024-43796', rated: true, severity: 'warning', cvss: 5, summary: '', fixed: '4.20.0', malicious: false }] }]]);
    withLock.intel = new Map([['CVE-2024-43796', { epss: 0.0012, percentile: 0.31, epssDate: '2026-09-28', kev: null }]]);
    const offThread = await analyseOffThread(withLock);
    assert.deepStrictEqual(strip(offThread), strip(analyse(withLock)));
    const express = offThread.findings.find(finding => finding.detail && finding.detail.package === 'express');
    assert.strictEqual(express.detail.intel.epss.score, 0.0012);
    assert.strictEqual(express.detail.usage.tier, 'imported');
  }

  /* ---- Out of time: the rules-only run answers, and says why ----------------------------------- */
  {
    const stages = [];
    const result = await analyseOffThread(input, { budget: { ...BUDGET, hardMs: 1 }, onStage: (stage, detail) => stages.push([stage, detail && detail.limit]) });
    assert.deepStrictEqual(stages, [['analysing', undefined], ['patterns', 'time']]);
    assert.strictEqual(result.engine.traced.limit, 'time');
    assert.strictEqual(result.engine.traced.cut, 1);
    assert.strictEqual(result.ledger.find(entry => entry.id === 'injection').status, 'patterns');
    assert(result.findings.some(finding => finding.rule === 'SEC-001'), 'the rules still read every file');
  }

  /* ---- Past the heap, twice: the audit is refused in words, never with the code ---------------- */
  {
    const stages = [];
    const refused = await analyseOffThread(input, { budget: { ...BUDGET, heapMb: 1, traceHeapShare: 100, watchMs: 5 }, onStage: stage => stages.push(stage) }).catch(error => error);
    assert.strictEqual(refused.code, 'AUDIT_TOO_LARGE');
    assert.strictEqual(refused.status, 503);
    assert.deepStrictEqual(stages, ['analysing', 'patterns']);
  }

  /* ---- A worker that fails is reported without what it was reading ----------------------------- */
  {
    const leaking = fakeWorker(worker => worker.emit('error', new Error('Unexpected token in JSON at position 3: {"password": "hunter2"}')));
    const failed = await analyseOffThread(input, { spawn: leaking }).catch(error => error);
    assert.strictEqual(failed.code, 'AUDIT_ANALYSIS_FAILED');
    assert(!/hunter2|password|JSON/.test(failed.message), 'the error never quotes the code');
    const outOfMemory = fakeWorker(worker => worker.emit('error', Object.assign(new Error('heap'), { code: 'ERR_WORKER_OUT_OF_MEMORY' })));
    assert.strictEqual((await analyseOffThread(input, { spawn: outOfMemory }).catch(error => error)).code, 'AUDIT_TOO_LARGE');
    const unstartable = class { constructor() { throw new Error('no threads'); } };
    assert.strictEqual((await analyseOffThread(input, { spawn: unstartable }).catch(error => error)).code, 'AUDIT_ANALYSIS_FAILED');
    const exited = fakeWorker(worker => worker.emit('exit', 1));
    assert.strictEqual((await analyseOffThread(input, { spawn: exited }).catch(error => error)).code, 'AUDIT_TOO_LARGE');
  }

  /* ---- One at a time, a short queue, and a full queue refused -------------------------------- */
  {
    let release;
    const holding = fakeWorker(worker => { release = () => worker.emit('message', { result: { held: true } }); });
    const first = analyseOffThread(input, { spawn: holding });
    const queued = [];
    const second = analyseOffThread(input, { spawn: fakeWorker(worker => worker.emit('message', { result: { second: true } })), onStage: (stage, detail) => queued.push([stage, detail && detail.position]) });
    const refused = await analyseOffThread(input, { budget: { ...BUDGET, queue: 1 } }).catch(error => error);
    assert.strictEqual(refused.code, 'AUDIT_BUSY');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepStrictEqual(queued, [['queued', 1]]);
    release();
    assert.deepStrictEqual(await first, { held: true });
    assert.deepStrictEqual(await second, { second: true });
    assert.deepStrictEqual(queued, [['queued', 1], ['analysing', undefined]]);
  }

  /* ---- The whole audit, as the server runs it: stages in order, analysis on the worker ------------ */
  {
    const { auditRepository } = require('../src/code-audit');
    const blobs = new Map(files.map((file, index) => [`sha-${index}`, file.text]));
    const reader = {
      resolveCommit: async () => ({ commitSha: 'c'.repeat(40), ref: 'main' }),
      readTree: async () => ({ truncated: false, skipped: [], entries: files.map((file, index) => ({ path: file.path, sha: `sha-${index}`, size: file.text.length, type: 'blob' })) }),
      readBlob: async ({ sha }) => ({ text: blobs.get(sha) })
    };
    const stages = [];
    const result = await auditRepository({
      reader, scope: { provider: 'github', owner: 'o', repo: 'r' }, ref: 'main', token: 't', transport: () => {},
      analyser: analysed => analyseOffThread(analysed, { onStage: stage => stages.push(`worker:${stage}`) }),
      onProgress: update => stages.push(update.stage === 'reading' ? `reading ${update.done}/${update.total}` : update.stage)
    });
    assert.deepStrictEqual(stages, ['resolving', 'reading 0/2', 'reading 1/2', 'reading 2/2', 'advisories', 'analysing', 'worker:analysing']);
    assert.strictEqual(result.coverage.read, 2, 'the README is listed, not read');
    assert(result.findings.some(finding => finding.rule === 'SEC-001' && finding.evidence === 'traced'));
    /* A listener that throws does not stop the audit. */
    const quiet = await auditRepository({ reader, scope: { provider: 'github', owner: 'o', repo: 'r' }, ref: 'main', token: 't', transport: () => {}, onProgress: () => { throw new Error('listener'); } });
    assert.strictEqual(quiet.grade, result.grade);
  }

  console.log('code audit worker tests passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
