'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const EICAR = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');
const BUILTIN_CHUNK_SIZE = 64 * 1024;

function boolEnv(value) {
  return /^(1|true|yes|on)$/i.test(String(value || ''));
}

function scannerStatus(env = process.env) {
  const rulesPath = String(env.NV_YARA_RULES_PATH || '').trim();
  return {
    builtin: { available: true, engine: 'bounded-signature-gate', rules: ['EICAR_TEST_FILE'] },
    yara: {
      configured: !!rulesPath,
      required: boolEnv(env.NV_REQUIRE_YARA),
      binary: String(env.NV_YARA_BIN || 'yara'),
      rulesPath: rulesPath ? path.basename(rulesPath) : '',
      timeoutSeconds: Math.min(Math.max(parseInt(env.NV_YARA_TIMEOUT_SECONDS || '5', 10) || 5, 1), 30)
    }
  };
}

function builtinScanBuffer(buffer, context = {}) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer || '');
  const matches = [];
  if (buffer.indexOf(EICAR) >= 0) {
    matches.push({ engine: 'builtin', rule: 'EICAR_TEST_FILE', severity: 'critical', path: String(context.repoPath || '') });
  }
  return { available: true, engine: 'builtin', blocked: matches.length > 0, matches };
}

async function builtinScanFile(filePath, context = {}) {
  const stream = fs.createReadStream(filePath, { highWaterMark: BUILTIN_CHUNK_SIZE });
  let overlap = Buffer.alloc(0);
  for await (const chunk of stream) {
    const candidate = overlap.length ? Buffer.concat([overlap, chunk]) : chunk;
    const result = builtinScanBuffer(candidate, context);
    if (result.blocked) {
      stream.destroy();
      return result;
    }
    const keep = Math.min(EICAR.length - 1, candidate.length);
    overlap = keep ? candidate.subarray(candidate.length - keep) : Buffer.alloc(0);
  }
  return { available: true, engine: 'builtin', blocked: false, matches: [] };
}

async function runYara(filePath, env) {
  const status = scannerStatus(env).yara;
  if (!status.configured) return { available: false, configured: false, matches: [], error: '' };
  const rulesPath = String(env.NV_YARA_RULES_PATH || '');
  let ruleStat;
  try { ruleStat = await fsp.stat(rulesPath); }
  catch { return { available: false, configured: true, matches: [], error: 'Configured YARA rules file is unavailable' }; }
  if (!ruleStat.isFile()) return { available: false, configured: true, matches: [], error: 'Configured YARA rules path is not a file' };
  try {
    const { stdout, stderr } = await execFileAsync(status.binary, [
      '-w', '-a', String(status.timeoutSeconds), '-l', '20', rulesPath, filePath
    ], {
      timeout: (status.timeoutSeconds + 2) * 1000,
      maxBuffer: 256 * 1024,
      windowsHide: true,
      shell: false,
      env: { PATH: process.env.PATH || '', LANG: 'C', LC_ALL: 'C' }
    });
    const matches = String(stdout || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(0, 20).map(line => ({
      engine: 'yara', rule: line.split(/\s+/)[0].slice(0, 128), severity: 'critical'
    }));
    return { available: true, configured: true, matches, blocked: matches.length > 0, warnings: String(stderr || '').trim().slice(0, 500) };
  } catch (error) {
    return {
      available: false,
      configured: true,
      matches: [],
      blocked: false,
      error: String(error && (error.stderr || error.message) || 'YARA execution failed').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500)
    };
  }
}

async function scanUploadFile(filePath, options = {}) {
  const env = options.env || process.env;
  const builtin = await builtinScanFile(filePath, { repoPath: options.repoPath });
  if (builtin.blocked) return { blocked: true, matches: builtin.matches, builtin, yara: { available: false, configured: false, matches: [] } };
  const yara = await runYara(filePath, env);
  if (!yara.available && scannerStatus(env).yara.required) {
    const error = new Error(yara.error || 'YARA scanning is required but unavailable');
    error.status = 503;
    error.code = 'YARA_UNAVAILABLE';
    throw error;
  }
  return { blocked: !!yara.blocked, matches: yara.matches || [], builtin, yara };
}

module.exports = { builtinScanBuffer, builtinScanFile, scannerStatus, scanUploadFile };
