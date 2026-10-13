#!/usr/bin/env node
'use strict';

/*
 * The operator's half of the hosted drills: a key, and a signature over a
 * drill report a person has read.
 *
 *   keygen --out <dir>
 *     Writes an ed25519 private key to <dir>/operator.pem (mode 0600) and
 *     prints the key ID and the public key in the form the hosted gate trusts
 *     (ALPHA17_OPERATOR_KEY_ID, ALPHA17_OPERATOR_PUBLIC_KEY_BASE64). The
 *     private key is printed nowhere.
 *
 *   sign --report <file> --key <pem> --key-id <id> [--now <iso>]
 *     Reads the drill report from <file> -- the report JSON itself, or a job
 *     log holding it between ALPHA17_DRILL_REPORT_BEGIN and _END -- refuses a
 *     report whose run did not pass or did not clean up, signs exactly the
 *     fields the hosted gate validates, checks the result with the gate's own
 *     validator, and prints it as the base64 value of
 *     ALPHA17_OPERATIONAL_RECORD_BASE64.
 *
 * Signing is the operator saying they read the observations and they say
 * what the checks claim. This program cannot read for them: it refuses what
 * it can see is wrong, and no more.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { stableJson } = require('../ci/alpha17-json');
const { validateOperationalRecord } = require('../ci/run-hosted-alpha17-validation');

const KEY_ID_RX = /^[a-zA-Z0-9._-]{3,80}$/;
const BEGIN = 'ALPHA17_DRILL_REPORT_BEGIN';
const END = 'ALPHA17_DRILL_REPORT_END';

function fail(message) {
  const error = new Error(message);
  error.code = 'ALPHA17_OPERATOR_RECORD_INVALID';
  throw error;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!/^--[a-z-]+$/.test(String(flag || '')) || value === undefined || value.startsWith('--')) fail(`${flag || 'an option'} needs a value`);
    options[flag.slice(2)] = value;
  }
  return { command, options };
}

function publicKeyBase64(key) {
  return crypto.createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64');
}

function keygen({ out }) {
  if (!out) fail('keygen needs --out');
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  const target = path.join(out, 'operator.pem');
  if (fs.existsSync(target)) fail(`${target} already exists; a key is never overwritten`);
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(target, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600, flag: 'wx' });
  const publicKey = publicKeyBase64(privateKey);
  const keyId = `nvx-operator-${crypto.createHash('sha256').update(publicKey).digest('hex').slice(0, 16)}`;
  return { keyId, publicKeyBase64: publicKey, privateKeyPath: target };
}

/* The report as the drills printed it, whether handed the JSON or the log around it. */
function readReport(text) {
  const source = String(text || '');
  const begin = source.lastIndexOf(BEGIN);
  let body = source.trim();
  if (begin >= 0) {
    const end = source.indexOf(END, begin);
    if (end < 0) fail('the report has a beginning and no end');
    /* A job log prefixes every line with a timestamp; the report is the one line between the markers. */
    const lines = source.slice(begin + BEGIN.length, end).split('\n').map(line => line.replace(/^\S*Z\s/, '').trim()).filter(Boolean);
    if (lines.length !== 1) fail('the report between the markers is not one line');
    body = lines[0];
  }
  try { return JSON.parse(body); } catch { fail('the report is not JSON'); }
}

function sign({ report: reportPath, key: keyPath, 'key-id': keyId, now }) {
  if (!reportPath || !keyPath || !keyId) fail('sign needs --report, --key and --key-id');
  if (!KEY_ID_RX.test(keyId)) fail('the key ID is malformed');
  const report = readReport(fs.readFileSync(reportPath, 'utf8'));
  if (!report || report.ok !== true) fail('the drill run did not pass; a failed run is not signed');
  const record = report.record;
  if (!record || record.cleanupVerified !== true) fail('the drill run did not verify its cleanup; it is not signed');
  const privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath));
  if (privateKey.asymmetricKeyType !== 'ed25519') fail('the operator key is not ed25519');
  const unsigned = {
    schemaVersion: record.schemaVersion,
    subjectSha256: record.subjectSha256,
    sourceCommit: record.sourceCommit,
    completedAt: record.completedAt,
    cleanupVerified: record.cleanupVerified,
    checks: record.checks
  };
  const signed = {
    ...unsigned,
    signature: {
      algorithm: 'ed25519',
      keyId,
      value: crypto.sign(null, Buffer.from(stableJson(unsigned), 'utf8'), privateKey).toString('base64')
    }
  };
  /* The gate's own validator, so a record that would be refused is refused here instead. */
  validateOperationalRecord(signed, {
    expectedSubjectHash: record.subjectSha256,
    expectedSourceCommit: record.sourceCommit,
    publicKeyBase64: publicKeyBase64(privateKey),
    now: now ? new Date(now) : new Date()
  });
  return {
    keyId,
    subjectSha256: record.subjectSha256,
    sourceCommit: record.sourceCommit,
    completedAt: record.completedAt,
    recordBase64: Buffer.from(JSON.stringify(signed), 'utf8').toString('base64')
  };
}

function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArgs(argv);
  if (command === 'keygen') return keygen(options);
  if (command === 'sign') return sign(options);
  fail('usage: alpha17-operator-record.js keygen --out <dir> | sign --report <file> --key <pem> --key-id <id>');
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(main(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.code ? `${error.code}: ` : ''}${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({ keygen, sign, readReport, main });
