'use strict';

/*
 * The signing tool exists so that an operator does not have to reimplement the
 * verifier from the outside. That is only true if what it mints is what the
 * verifier accepts, so this drives both ends: mint an envelope with the CLI,
 * then hand it to the real verifier with the environment the workflow sets.
 *
 * A round trip that only calls the exported encoder would prove nothing about
 * the tool -- the tool's job is to assemble the payload correctly, and that is
 * exactly where a hand-written envelope goes wrong.
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const {
  verifyAuthorizationEnvelope,
  fileClaimLedger
} = require('../ci/verify-alpha17-authorization');

const REPOSITORY = 'T-rex-G/Nebula-checkpoints';
const REF = 'refs/heads/agent/alpha17-provider-reads';
const SOURCE_COMMIT = 'a'.repeat(40);
const SOURCE_PARENT = 'b'.repeat(40);
const SUBJECT = 'c'.repeat(64);
const TARGET_REPOSITORY = 'T-rex-G/nvx-alpha17-github-qualification';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nvx-alpha17-authorize-'));

function cli(args) {
  return JSON.parse(execFileSync(
    process.execPath,
    [path.join(root, 'scripts', 'alpha17-authorize.js'), ...args],
    { cwd: root, encoding: 'utf8' }
  ));
}

function cliFails(args, expected) {
  assert.throws(
    () => execFileSync(
      process.execPath,
      [path.join(root, 'scripts', 'alpha17-authorize.js'), ...args],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    ),
    error => expected.test(String(error.stderr || '')),
    `expected ${expected} from ${args[0]}`
  );
}

const keys = cli(['keygen', '--out-dir', path.join(workspace, 'keys')]);
assert.match(keys.ALPHA17_AUTHORIZATION_PUBLIC_KEY_BASE64, /^[A-Za-z0-9+/]+={0,2}$/);
assert(fs.existsSync(keys.privateKeyPath));
assert.strictEqual(fs.statSync(keys.privateKeyPath).mode & 0o077, 0,
  'an authorization key must not be readable by anyone else');
/* A second keygen must not silently replace a key already trusted by a run. */
cliFails(['keygen', '--out-dir', path.join(workspace, 'keys')], /already exists/);

const signArguments = [
  'sign',
  '--key', keys.privateKeyPath,
  '--repository', REPOSITORY,
  '--ref', REF,
  '--source-commit', SOURCE_COMMIT,
  '--source-parent', SOURCE_PARENT,
  '--subject-sha256', SUBJECT,
  '--jobs', 'github',
  '--github-repository', TARGET_REPOSITORY
];
const minted = cli(signArguments);
assert.deepStrictEqual(minted.authorizedJobs, ['github']);
assert.match(minted.targetHashes.github, /^[0-9a-f]{64}$/);

function verify(token, override = {}) {
  return verifyAuthorizationEnvelope(token, {
    publicKeyBase64: keys.ALPHA17_AUTHORIZATION_PUBLIC_KEY_BASE64,
    claims: fileClaimLedger(fs.mkdtempSync(path.join(workspace, 'ledger-'))),
    expectedWorkflow: '.github/workflows/public-alpha-alpha17.yml',
    expectedRepository: REPOSITORY,
    expectedRef: REF,
    expectedEvent: 'workflow_dispatch',
    expectedSourceParent: SOURCE_PARENT,
    expectedSourceCommit: SOURCE_COMMIT,
    expectedSubjectHash: SUBJECT,
    requestedJobs: ['github'],
    expectedTargets: {
      github: { repository: TARGET_REPOSITORY, apiUrl: 'https://api.github.com' }
    },
    now: new Date(),
    ...override
  });
}

const accepted = verify(minted.authorization_token);
assert.strictEqual(accepted.ok, true);
assert.deepStrictEqual(accepted.authorizedJobs, ['github']);
assert.strictEqual(accepted.targetHashes.github, minted.targetHashes.github,
  'the target the verifier binds must be the one the tool hashed');
assert.match(accepted.envelopeHash, /^[0-9a-f]{64}$/);

/*
 * The envelope binds a target, not merely a job. A run pointed at a different
 * repository than the one approved must be refused, or the signature is only
 * approving that something happened somewhere.
 */
assert.throws(
  () => verify(minted.authorization_token, {
    expectedTargets: {
      github: { repository: 'T-rex-G/nvx-alpha17-somewhere-else', apiUrl: 'https://api.github.com' }
    }
  }),
  error => error && error.code === 'ALPHA17_AUTHORIZATION_TARGET_MISMATCH'
);

/* And a candidate other than the one approved. */
assert.throws(
  () => verify(minted.authorization_token, { expectedSubjectHash: 'd'.repeat(64) }),
  error => error && /^ALPHA17_AUTHORIZATION_/.test(String(error.code || ''))
);

/*
 * Each signing mints a fresh nonce. Re-signing the same approval must not
 * produce an envelope the ledger cannot tell from the first one.
 */
const second = cli(signArguments);
assert.notStrictEqual(second.authorization_token, minted.authorization_token,
  're-signing must mint a distinct activation');

/* A single ledger must refuse the same envelope twice. */
const sharedLedger = fileClaimLedger(fs.mkdtempSync(path.join(workspace, 'ledger-shared-')));
verify(minted.authorization_token, { claims: sharedLedger });
assert.throws(
  () => verify(minted.authorization_token, { claims: sharedLedger }),
  error => error && /ALPHA17_AUTHORIZATION/.test(String(error.code || '')),
  'a spent activation must not be accepted again'
);

/* Lifetimes the verifier would reject are refused at minting instead. */
cliFails([...signArguments, '--minutes', '45'], /--minutes must be between/);
/* An incomplete approval is refused rather than signed with a blank in it. */
cliFails(['sign', '--key', keys.privateKeyPath, '--repository', REPOSITORY], /is required/);
/* Naming a job without naming its target would sign an approval for nothing. */
cliFails(signArguments.slice(0, -2), /--github-repository is required/);

const wrongKey = path.join(workspace, 'wrong-key.pem');
fs.writeFileSync(wrongKey, crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ format: 'pem', type: 'pkcs8' }));
cliFails(
  signArguments.map((value, index) => (index === 2 ? wrongKey : value)),
  /must be Ed25519/
);

fs.rmSync(workspace, { recursive: true, force: true });
console.log('alpha17 authorization CLI tests passed');
