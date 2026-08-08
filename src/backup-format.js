'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');

const MANIFEST_SCHEMA = '1.0.0';
const ALGORITHM = 'aes-256-gcm';
const SHA256_RX = /^[0-9a-f]{64}$/;
const AUTH_TAG_RX = /^[0-9a-f]{32}$/;
const METADATA_KEYS = new Set(['format', 'schemaVersion', 'createdAt']);

function decodeBackupKey(raw) {
  const encoded = String(raw || '').trim();
  let key;
  try { key = Buffer.from(encoded, 'base64'); }
  catch { key = Buffer.alloc(0); }
  if (!encoded || key.length !== 32 || key.toString('base64') !== encoded) {
    throw new TypeError('NV_BACKUP_KEY_BASE64 must be an exact 32-byte Base64 value');
  }
  return key;
}

function assertKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new TypeError('Backup key must be a 32-byte Buffer from decodeBackupKey()');
  }
}

function normalizeMetadata(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Backup metadata must be an object');
  }
  for (const key of Object.keys(input)) {
    if (!METADATA_KEYS.has(key)) throw new TypeError(`Backup metadata field is not allowed: ${key}`);
  }
  const metadata = {
    format: String(input.format || ''),
    schemaVersion: String(input.schemaVersion || ''),
    createdAt: String(input.createdAt || '')
  };
  if (metadata.format !== 'postgres-custom') {
    throw new TypeError('Backup metadata format must be postgres-custom');
  }
  if (!/^\d{3}_[a-z0-9_-]+$/i.test(metadata.schemaVersion)) {
    throw new TypeError('Backup metadata schemaVersion is invalid');
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(metadata.createdAt) ||
      !Number.isFinite(Date.parse(metadata.createdAt))) {
    throw new TypeError('Backup metadata createdAt must be an ISO timestamp');
  }
  return Object.freeze(metadata);
}

function manifestAad(metadata) {
  return Buffer.from(JSON.stringify({
    schemaVersion: MANIFEST_SCHEMA,
    algorithm: ALGORITHM,
    metadata: {
      createdAt: metadata.createdAt,
      format: metadata.format,
      schemaVersion: metadata.schemaVersion
    }
  }), 'utf8');
}

function strictBase64Bytes(raw, size, label) {
  const value = String(raw || '');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== size || bytes.toString('base64') !== value) {
    throw new TypeError(`${label} is invalid`);
  }
  return bytes;
}

function validateBackupManifest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Backup manifest must be an object');
  }
  if (input.schemaVersion !== MANIFEST_SCHEMA) throw new TypeError('Backup manifest schemaVersion is unsupported');
  if (input.algorithm !== ALGORITHM) throw new TypeError('Backup manifest algorithm is unsupported');
  strictBase64Bytes(input.iv, 12, 'Backup manifest IV');
  if (!AUTH_TAG_RX.test(String(input.authTag || ''))) throw new TypeError('Backup manifest authTag is invalid');
  if (!SHA256_RX.test(String(input.plaintextSha256 || ''))) throw new TypeError('Backup plaintext digest is invalid');
  if (!SHA256_RX.test(String(input.ciphertextSha256 || ''))) throw new TypeError('Backup ciphertext digest is invalid');
  const sizeBytes = Number(input.sizeBytes);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) throw new TypeError('Backup sizeBytes is invalid');
  const metadata = normalizeMetadata(input.metadata);
  return Object.freeze({
    schemaVersion: MANIFEST_SCHEMA,
    algorithm: ALGORITHM,
    iv: String(input.iv),
    authTag: String(input.authTag),
    plaintextSha256: String(input.plaintextSha256),
    ciphertextSha256: String(input.ciphertextSha256),
    sizeBytes,
    metadata
  });
}

async function assertRegularInput(filePath) {
  const stat = await fsp.lstat(filePath);
  if (stat.isSymbolicLink()) throw new TypeError(`Backup input must not be a symlink: ${filePath}`);
  if (!stat.isFile()) throw new TypeError(`Backup input must be a regular file: ${filePath}`);
  return stat;
}

async function assertNewOutput(filePath) {
  const parent = await fsp.lstat(path.dirname(filePath));
  if (parent.isSymbolicLink() || !parent.isDirectory()) {
    throw new TypeError('Backup output parent must be a real directory');
  }
  try {
    const existing = await fsp.lstat(filePath);
    if (existing.isSymbolicLink()) throw new TypeError(`Backup output must not be a symlink: ${filePath}`);
    throw new TypeError(`Backup output already exists: ${filePath}`);
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    throw error;
  }
}

function hashingTransform(hash, onBytes) {
  return new Transform({
    transform(chunk, encoding, callback) {
      hash.update(chunk);
      onBytes(chunk.length);
      callback(null, chunk);
    }
  });
}

async function hashFile(filePath) {
  await assertRegularInput(filePath);
  const hash = crypto.createHash('sha256');
  let sizeBytes = 0;
  await pipeline(
    fs.createReadStream(filePath),
    hashingTransform(hash, size => { sizeBytes += size; }),
    new Transform({ transform(chunk, encoding, callback) { callback(); } })
  );
  return Object.freeze({ digest: hash.digest('hex'), sizeBytes });
}

async function encryptBackupFile({ inputPath, outputPath, key, metadata }) {
  assertKey(key);
  await assertRegularInput(inputPath);
  await assertNewOutput(outputPath);
  const normalizedMetadata = normalizeMetadata(metadata);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(manifestAad(normalizedMetadata));
  const plaintextHash = crypto.createHash('sha256');
  const ciphertextHash = crypto.createHash('sha256');
  let sizeBytes = 0;
  try {
    await pipeline(
      fs.createReadStream(inputPath),
      hashingTransform(plaintextHash, size => { sizeBytes += size; }),
      cipher,
      hashingTransform(ciphertextHash, () => {}),
      fs.createWriteStream(outputPath, { flags: 'wx', mode: 0o600 })
    );
    await fsp.chmod(outputPath, 0o600);
    return Object.freeze({
      schemaVersion: MANIFEST_SCHEMA,
      algorithm: ALGORITHM,
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('hex'),
      plaintextSha256: plaintextHash.digest('hex'),
      ciphertextSha256: ciphertextHash.digest('hex'),
      sizeBytes,
      metadata: normalizedMetadata
    });
  } catch (error) {
    await fsp.rm(outputPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function decryptBackupFile({ inputPath, outputPath, key, manifest }) {
  assertKey(key);
  const normalized = validateBackupManifest(manifest);
  await assertRegularInput(inputPath);
  await assertNewOutput(outputPath);
  const ciphertext = await hashFile(inputPath);
  if (ciphertext.digest !== normalized.ciphertextSha256 || ciphertext.sizeBytes !== normalized.sizeBytes) {
    throw new Error('Backup ciphertext integrity verification failed');
  }

  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    key,
    strictBase64Bytes(normalized.iv, 12, 'Backup manifest IV')
  );
  decipher.setAAD(manifestAad(normalized.metadata));
  decipher.setAuthTag(Buffer.from(normalized.authTag, 'hex'));
  const plaintextHash = crypto.createHash('sha256');
  let sizeBytes = 0;
  try {
    await pipeline(
      fs.createReadStream(inputPath),
      decipher,
      hashingTransform(plaintextHash, size => { sizeBytes += size; }),
      fs.createWriteStream(outputPath, { flags: 'wx', mode: 0o600 })
    );
    const digest = plaintextHash.digest('hex');
    if (digest !== normalized.plaintextSha256 || sizeBytes !== normalized.sizeBytes) {
      throw new Error('Backup plaintext integrity verification failed');
    }
    await fsp.chmod(outputPath, 0o600);
    return Object.freeze({
      plaintextSha256: digest,
      sizeBytes,
      metadata: normalized.metadata
    });
  } catch (error) {
    await fsp.rm(outputPath, { force: true }).catch(() => {});
    throw new Error('Backup authentication or integrity verification failed', { cause: error });
  }
}

module.exports = {
  decodeBackupKey,
  encryptBackupFile,
  decryptBackupFile,
  validateBackupManifest
};
