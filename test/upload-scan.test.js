'use strict';
/*
 * The scan every uploaded file passes, and the upkeep of the files an upload
 * leaves behind (the workbench's upload scan and upload upkeep): what a clean
 * file answers, how a blocked one is refused and recorded, and which
 * temporary files are removed, when -- against a scripted scanner, evidence
 * chain, temporary directory and timer.
 */
const assert = require('assert');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { syncBuiltinESMExports } = require('module');
const { createUploadScan, createUploadUpkeep } = require('../apps/api/src/modules/workbench/index.ts');

function scanner(result, options = {}) {
  const calls = [];
  const scan = createUploadScan({
    scan: async (file, opts) => { calls.push(['scan', file, opts]); return result; },
    evidenceKey: req => `evidence:${req.params.owner}/${req.params.repo}`,
    appendEvidence: (key, type, id, details) => {
      calls.push(['evidence', key, type, id, details]);
      return options.appendFails ? Promise.reject(new Error('evidence unavailable')) : Promise.resolve();
    },
    retainedActor: req => `actor:${req.gh.login}`
  });
  return { scan, calls };
}
const REQ = { params: { owner: 'alice', repo: 'demo' }, gh: { login: 'alice' } };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let finished = false;
process.on('exit', code => { if (!finished && code === 0) { console.error('the upload scan tests did not finish'); process.exitCode = 1; } });

(async () => {
  /* ---- A clean file --------------------------------------------------------------------- */
  {
    const { scan, calls } = scanner({ blocked: false, builtin: { matches: [1, 2] }, yara: { configured: 1, available: 0, matches: [1], error: `bad\n${'e'.repeat(300)}` } });
    const answer = await scan(REQ, '/tmp/nv-0123456789abcdef', 'src/a.js', 12);
    assert.deepStrictEqual(calls, [['scan', '/tmp/nv-0123456789abcdef', { repoPath: 'src/a.js', size: 12 }]], 'the file is scanned with its path and size');
    assert.deepStrictEqual(answer.builtin, { available: true, matches: 2 }, 'the built-in signatures always answer');
    assert.deepStrictEqual([answer.yara.configured, answer.yara.available, answer.yara.matches], [true, false, 1], 'YARA as it is configured and available');
    assert.strictEqual(answer.yara.error, `bad ${'e'.repeat(236)}`, 'with its error, bounded');
    for (const result of [{}, { builtin: null, yara: null }, { yara: { error: '' } }]) {
      const quiet = await scanner(result).scan(REQ, '/tmp/x', 'a', 1);
      assert.deepStrictEqual(quiet, { builtin: { available: true, matches: 0 }, yara: { configured: false, available: false, matches: 0 } }, JSON.stringify(result));
    }
  }

  /* ---- A blocked file ---------------------------------------------------------------------- */
  {
    const { scan, calls } = scanner({ blocked: 1, matches: [{ engine: 'yara', rule: 'EICAR', severity: 'high' }, {}, { engine: 'e'.repeat(60), rule: 'r'.repeat(200), severity: 's'.repeat(30) }] });
    await assert.rejects(scan(REQ, '/tmp/nv-0123456789abcdef', `dir/\u0001${'p'.repeat(600)}`, '34'), error => {
      assert.strictEqual(error.message, `Upload blocked by malware signature rule: EICAR, MATCH, ${'r'.repeat(128)}`, 'refused naming each rule');
      assert.deepStrictEqual([error.status, error.code], [422, 'MALWARE_DETECTED']);
      return true;
    });
    const [, [, key, type, id, details]] = calls;
    assert.deepStrictEqual([key, type], ['evidence:alice/demo', 'malware-blocked'], 'and recorded on the repository\'s evidence chain');
    assert.match(id, UUID);
    assert.deepStrictEqual(details.matches, [
      { engine: 'yara', rule: 'EICAR', severity: 'high' },
      { engine: 'signature', rule: 'MATCH', severity: 'critical' },
      { engine: 'e'.repeat(40), rule: 'r'.repeat(128), severity: 's'.repeat(20) }
    ], 'each match bounded, a missing one named as a signature match of critical severity');
    assert.strictEqual(details.actor, 'actor:alice');
    assert.strictEqual(details.path, `dir/ ${'p'.repeat(495)}`, 'the path bounded');
    assert.strictEqual(details.size, 34, 'the size as a number');
    assert.match(details.blockedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  }
  {
    /* The refusal waits for its record: a reader told of it finds it on the chain. */
    let recorded = null;
    const held = createUploadScan({
      scan: async () => ({ blocked: true, matches: [{ rule: 'EICAR' }] }),
      evidenceKey: () => 'evidence:alice/demo',
      appendEvidence: () => new Promise(resolve => { recorded = resolve; }),
      retainedActor: () => 'actor:alice'
    });
    let settled = false;
    const refusal = held(REQ, '/tmp/x', 'a', 1).then(() => { settled = true; }, error => { settled = true; return error; });
    for (let turn = 0; turn < 20 && !recorded; turn += 1) await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(typeof recorded, 'function', 'the record is being appended');
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(settled, false, 'and the refusal is not answered until it is');
    recorded();
    assert.strictEqual((await refusal).code, 'MALWARE_DETECTED', 'then it is');
  }
  {
    const { scan, calls } = scanner({ blocked: true }, { appendFails: true });
    await assert.rejects(scan({ params: { owner: 'alice', repo: 'demo' }, gh: { login: 'alice' } }, '/tmp/x', '', undefined), error => error.code === 'MALWARE_DETECTED' && error.message === 'Upload blocked by malware signature rule: ', 'a record that cannot be appended does not change the refusal');
    assert.deepStrictEqual([calls[1][4].path, calls[1][4].size, calls[1][4].matches], ['batch blob', 0, []], 'a batch blob, without a size or matches');
    for (const req of [{ params: { owner: 'alice' }, gh: { login: 'a' } }, { params: null, gh: { login: 'a' } }, { gh: { login: 'a' } }]) {
      const quiet = scanner({ blocked: true, matches: [{ rule: 'R' }] });
      await assert.rejects(quiet.scan(req, '/tmp/x', 'a', 1), /malware signature rule: R/);
      assert.strictEqual(quiet.calls.length, 1, 'an upload for no repository has no chain to record on');
    }
  }

  /* ---- The upkeep of an upload's temporary files ----------------------------------------------- */
  const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
  const HOUR = 3600e3;
  async function upkeep(staleHours, entries, faults = {}) {
    const calls = [];
    const saved = { readdir: fsp.readdir, lstat: fsp.lstat, unlink: fsp.unlink, tmpdir: os.tmpdir, setInterval: global.setInterval, now: Date.now };
    let tick = null;
    try {
      os.tmpdir = () => '/scratch/tmp';
      Date.now = () => NOW;
      fsp.readdir = async dir => { calls.push(['readdir', dir]); if (faults.readdir) throw new Error('EACCES'); return Object.keys(entries); };
      fsp.lstat = async file => {
        const entry = entries[path.basename(file)];
        if (entry === 'gone') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return { isFile: () => entry.kind === 'file', mtimeMs: NOW - entry.age };
      };
      fsp.unlink = async file => { calls.push(['unlink', file]); if (faults.unlink) throw new Error('EPERM'); };
      global.setInterval = (fn, ms) => { calls.push(['every', ms]); tick = fn; return { unref() { calls.push(['unref']); } }; };
      syncBuiltinESMExports();
      const life = createUploadUpkeep({ staleHours });
      const outcome = await life.cleanupStaleUploads().then(() => 'done', error => `failed: ${error.message}`);
      calls.push(['cleanup', outcome]);
      life.startTempMaintenance();
      for (let i = 0; i < 4; i += 1) await new Promise(resolve => setImmediate(resolve));
      calls.push(['tick']);
      tick();
      for (let i = 0; i < 4; i += 1) await new Promise(resolve => setImmediate(resolve));
    } finally {
      Object.assign(fsp, { readdir: saved.readdir, lstat: saved.lstat, unlink: saved.unlink });
      os.tmpdir = saved.tmpdir;
      global.setInterval = saved.setInterval;
      Date.now = saved.now;
      syncBuiltinESMExports();
    }
    return calls;
  }
  {
    const calls = await upkeep(6, {
      'nv-0123456789abcdef': { kind: 'file', age: 7 * HOUR },
      'nv-fedcba9876543210': { kind: 'file', age: 5 * HOUR },
      'nv-aaaaaaaaaaaaaaaa': { kind: 'file', age: 6 * HOUR },
      'nv-bbbbbbbbbbbbbbbb': { kind: 'dir', age: 9 * HOUR },
      'nv-cccccccccccccccc': { kind: 'link', age: 9 * HOUR },
      'nv-dddddddddddddddd': 'gone',
      'nv-eeeeeeeeeeeeeeee': { kind: 'file', age: 8 * HOUR },
      'nv-0123456789ABCDEF': { kind: 'file', age: 9 * HOUR },
      'nv-0123456789abcde': { kind: 'file', age: 9 * HOUR },
      'nv-0123456789abcdef.part': { kind: 'file', age: 9 * HOUR },
      'other-upload': { kind: 'file', age: 9 * HOUR }
    });
    const first = calls.slice(0, calls.findIndex(call => call[0] === 'cleanup') + 1);
    assert.deepStrictEqual(first, [
      ['readdir', '/scratch/tmp'],
      ['unlink', path.join('/scratch/tmp', 'nv-0123456789abcdef')],
      ['unlink', path.join('/scratch/tmp', 'nv-eeeeeeeeeeeeeeee')],
      ['cleanup', 'done']
    ], 'only an upload\'s own files, regular, and older than the stale age; one that went away is skipped');
    const startup = calls.slice(first.length);
    assert.deepStrictEqual(startup.slice(0, 3), [['readdir', '/scratch/tmp'], ['every', 6 * HOUR], ['unref']], 'upkeep runs at startup, then every stale age, without keeping the process alive');
    assert.deepStrictEqual(startup.slice(startup.findIndex(call => call[0] === 'tick')).filter(call => call[0] === 'readdir').length, 1, 'and on each tick');
  }
  {
    const quick = await upkeep(0.5, { 'nv-0123456789abcdef': { kind: 'file', age: 31 * 60e3 } });
    assert(quick.some(call => call[0] === 'unlink'), 'a half-hour age removes a file older than half an hour');
    assert(quick.some(call => call[0] === 'every' && call[1] === HOUR), 'but upkeep runs at most hourly');
    const unreadable = await upkeep(6, {}, { readdir: true });
    assert.deepStrictEqual(unreadable.find(call => call[0] === 'cleanup'), ['cleanup', 'done'], 'a directory that cannot be read is left for the next run');
    const stuck = await upkeep(6, { 'nv-0123456789abcdef': { kind: 'file', age: 9 * HOUR }, 'nv-fedcba9876543210': { kind: 'file', age: 9 * HOUR } }, { unlink: true });
    assert.deepStrictEqual(stuck.filter(call => call[0] === 'unlink').length >= 2 && stuck.find(call => call[0] === 'cleanup'), ['cleanup', 'done'], 'a file that cannot be removed does not stop the others');
  }

  finished = true;
  console.log('Upload scan tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
