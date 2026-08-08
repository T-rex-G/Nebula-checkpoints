'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  decodeBackupKey,
  encryptBackupFile,
  decryptBackupFile,
  validateBackupManifest
} = require('../src/backup-format');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nvx-backup-format-'));
  try {
    const input = path.join(root, 'input.dump');
    const encrypted = path.join(root, 'backup.nvxenc');
    const restored = path.join(root, 'restored.dump');
    const bytes = crypto.randomBytes(1024 * 1024 + 17);
    fs.writeFileSync(input, bytes, { mode: 0o600 });

    assert.throws(() => decodeBackupKey('not-base64'), /32-byte Base64/);
    assert.throws(() => decodeBackupKey(Buffer.alloc(31).toString('base64')), /32-byte Base64/);
    const key = decodeBackupKey(Buffer.alloc(32, 7).toString('base64'));

    const manifest = await encryptBackupFile({
      inputPath: input,
      outputPath: encrypted,
      key,
      metadata: {
        format: 'postgres-custom',
        schemaVersion: '015_alpha_privacy',
        createdAt: '2026-07-29T18:00:00.000Z'
      }
    });
    assert.strictEqual(manifest.schemaVersion, '1.0.0');
    assert.strictEqual(manifest.algorithm, 'aes-256-gcm');
    assert.strictEqual(manifest.sizeBytes, bytes.length);
    assert.match(manifest.ciphertextSha256, /^[0-9a-f]{64}$/);
    assert.match(manifest.plaintextSha256, /^[0-9a-f]{64}$/);
    assert.strictEqual(Object.isFrozen(validateBackupManifest(manifest)), true);
    assert.strictEqual(fs.statSync(encrypted).mode & 0o777, 0o600);

    const restoredMetadata = await decryptBackupFile({
      inputPath: encrypted,
      outputPath: restored,
      key,
      manifest
    });
    assert.deepStrictEqual(fs.readFileSync(restored), bytes);
    assert.strictEqual(restoredMetadata.plaintextSha256, manifest.plaintextSha256);
    assert.strictEqual(fs.statSync(restored).mode & 0o777, 0o600);

    fs.rmSync(restored);
    const tamperedTag = { ...manifest, authTag: '0'.repeat(32) };
    await assert.rejects(
      () => decryptBackupFile({ inputPath: encrypted, outputPath: restored, key, manifest: tamperedTag }),
      /authentication|integrity/i
    );
    assert.strictEqual(fs.existsSync(restored), false, 'authentication failure must remove partial plaintext');

    const tamperedMetadata = {
      ...manifest,
      metadata: { ...manifest.metadata, schemaVersion: '999_tampered' }
    };
    await assert.rejects(
      () => decryptBackupFile({ inputPath: encrypted, outputPath: restored, key, manifest: tamperedMetadata }),
      /authentication|integrity/i
    );
    assert.strictEqual(fs.existsSync(restored), false, 'metadata authentication failure must remove plaintext');

    const symlinkInput = path.join(root, 'input-link.dump');
    fs.symlinkSync(input, symlinkInput);
    await assert.rejects(
      () => encryptBackupFile({
        inputPath: symlinkInput,
        outputPath: path.join(root, 'linked-input.nvxenc'),
        key,
        metadata: manifest.metadata
      }),
      /symlink|regular file/i
    );

    const symlinkOutput = path.join(root, 'output-link.nvxenc');
    fs.symlinkSync(encrypted, symlinkOutput);
    await assert.rejects(
      () => encryptBackupFile({ inputPath: input, outputPath: symlinkOutput, key, metadata: manifest.metadata }),
      /symlink|already exists/i
    );

    console.log('backup format tests passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
