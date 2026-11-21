'use strict';

/* Verify an exported coverage proof using a separately retained digest and target. */
const fs = require('node:fs');
const { TextDecoder } = require('node:util');
const { stableJson } = require('../packages/contracts/src/canonical-json.ts');
const { verifyCoverageProof } = require('../apps/api/src/modules/uranus/application/coverage-proof.ts');

function verifyFile(file, scope, commitSha, ruleset, digest) {
  const bytes = Buffer.alloc(8193);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
  let length = 0;
  try {
    if (!fs.fstatSync(fd).isFile()) return 'invalid-file';
    while (length < bytes.length) {
      const n = fs.readSync(fd, bytes, length, bytes.length - length, null);
      if (!n) break;
      length += n;
    }
  } finally { fs.closeSync(fd); }
  if (length === bytes.length) return 'invalid-file';
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length));
  const proof = JSON.parse(text);
  const status = verifyCoverageProof(proof, { scope, commitSha, ruleset, digest });
  if (status === 'complete' || status === 'incomplete' || status === 'unrecorded') {
    /* The authorized endpoint emits canonical bytes. Reject ambiguous imports such as duplicate JSON keys. */
    const canonical = stableJson(proof);
    if (text !== canonical && text !== canonical + '\n') return 'invalid-encoding';
  }
  return status;
}

function main(args) {
  const [file, repository, commit, ruleset, digest] = args;
  if (args.length !== 5 || repository.split('/').length !== 2) {
    process.stderr.write('Usage: node scripts/uranus-verify-coverage.js PROOF.json OWNER/REPO COMMIT RULESET TRUSTED_DIGEST\n');
    return 1;
  }
  const [owner, repo] = repository.split('/');
  let status;
  try { status = verifyFile(file, { provider: 'github', owner, repo }, commit, ruleset, digest); }
  catch { status = 'invalid-file'; }
  process.stdout.write(JSON.stringify({ status }) + '\n');
  if (status === 'complete') return 0;
  if (status === 'incomplete' || status === 'unrecorded') return 2;
  return 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
