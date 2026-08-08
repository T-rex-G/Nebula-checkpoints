'use strict';
const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const fsp = require('fs/promises');
const { builtinScanBuffer, scannerStatus, scanUploadFile } = require('../src/file-security');

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
const clean = builtinScanBuffer(Buffer.from('hello world'), { repoPath: 'docs/readme.txt' });
assert.deepStrictEqual(clean.matches, []);
const hit = builtinScanBuffer(Buffer.from(EICAR), { repoPath: 'sample.com' });
assert(hit.matches.some(m => m.rule === 'EICAR_TEST_FILE'));
assert.strictEqual(hit.blocked, true);

const status = scannerStatus({});
assert.strictEqual(status.builtin.available, true);
assert.strictEqual(status.yara.configured, false);

(async () => {
  const file = path.join(os.tmpdir(), `nv-security-test-${process.pid}-${Date.now()}`);
  const lateFile = `${file}-late`;
  await fsp.writeFile(file, EICAR, { mode: 0o600 });
  await fsp.writeFile(lateFile, Buffer.concat([Buffer.alloc(2 * 1024 * 1024 + 17, 0x41), Buffer.from(EICAR)]), { mode: 0o600 });
  try {
    const result = await scanUploadFile(file, { repoPath: 'upload.bin', env: {} });
    assert.strictEqual(result.blocked, true);
    assert(result.matches.some(m => m.rule === 'EICAR_TEST_FILE'));
    const lateResult = await scanUploadFile(lateFile, { repoPath: 'late-upload.bin', env: {} });
    assert.strictEqual(lateResult.blocked, true, 'Built-in signatures must scan the entire upload, not only the prefix');
  } finally {
    await Promise.all([fsp.unlink(file).catch(() => {}), fsp.unlink(lateFile).catch(() => {})]);
  }
  console.log('file security tests passed');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
