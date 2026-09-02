#!/usr/bin/env node
'use strict';

/*
 * Mints the signed activation envelope the alpha.17 live-qualification
 * workflow requires as its `authorization_token` dispatch input.
 *
 * The workflow has never been dispatched, and this is the likely reason: the
 * envelope is canonical JSON over twelve exact fields, carrying a SHA-256 of
 * each authorized target's normalized shape, signed Ed25519, base64url in two
 * parts. Producing one by hand means reimplementing the verifier's own
 * canonicalization and hashing correctly, from the outside, under a
 * thirty-minute expiry. That is not an operator task.
 *
 * So this reuses the verifier's exported encoder and target hasher rather than
 * restating either. An envelope this mints and the envelope that job accepts
 * are canonicalized and hashed by the same code, which is the only way the two
 * cannot drift.
 *
 * The private key never enters the repository, the workflow, or this file's
 * output: it is read from a path the operator names, used once, and the
 * envelope is what comes back.
 *
 *   node scripts/alpha17-authorize.js keygen --out-dir <directory>
 *   node scripts/alpha17-authorize.js sign --key <private-key.pem> \
 *     --repository <owner/repo> --ref refs/heads/<branch> \
 *     --source-commit <sha1> --source-parent <sha1> \
 *     --subject-sha256 <sha256> --jobs github[,hosted] \
 *     --github-repository <owner/nvx-alpha17-...> [--minutes 20]
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  AUTHORIZATION_SCHEMA_VERSION,
  encodeAuthorizationEnvelope,
  hashLiveTarget
} = require('../ci/verify-alpha17-authorization');

const WORKFLOW = '.github/workflows/public-alpha-alpha17.yml';
const ALLOWED_JOBS = Object.freeze(['github', 'gitlab', 'gitea', 'hosted']);
const DEFAULT_LIFETIME_MINUTES = 20;
/* The verifier refuses anything longer; minting one it would reject helps nobody. */
const MAX_LIFETIME_MINUTES = 30;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) fail(`unexpected argument: ${token}`);
    const name = token.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) fail(`--${name} requires a value`);
    options[name] = value;
    index += 1;
  }
  return options;
}

function required(options, name) {
  const value = String(options[name] || '').trim();
  if (!value) fail(`--${name} is required`);
  return value;
}

function requireSha1(options, name) {
  const value = required(options, name);
  if (!/^[0-9a-f]{40}$/.test(value)) fail(`--${name} must be a 40-character commit SHA`);
  return value;
}

function keygen(options) {
  const directory = path.resolve(required(options, 'out-dir'));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const privatePath = path.join(directory, 'alpha17-authorization-key.pem');
  if (fs.existsSync(privatePath)) {
    fail(`${privatePath} already exists; refusing to overwrite an authorization key`);
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(
    privatePath,
    privateKey.export({ format: 'pem', type: 'pkcs8' }),
    { mode: 0o600 }
  );
  /*
   * The public half goes into the repository variable the workflow reads. The
   * private half stays where the operator put it and is never printed: a key
   * echoed into a terminal is a key in a scrollback buffer.
   */
  process.stdout.write(`${JSON.stringify({
    privateKeyPath: privatePath,
    ALPHA17_AUTHORIZATION_PUBLIC_KEY_BASE64:
      publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  }, null, 2)}\n`);
}

function targetsFor(jobs, options) {
  const targets = {};
  for (const job of jobs) {
    if (job === 'github' || job === 'gitlab' || job === 'gitea') {
      targets[job] = {
        repository: required(options, `${job}-repository`),
        apiUrl: options[`${job}-api-url`] || {
          github: 'https://api.github.com',
          gitlab: 'https://gitlab.com/api/v4',
          gitea: ''
        }[job]
      };
      if (!targets[job].apiUrl) fail(`--${job}-api-url is required for ${job}`);
      continue;
    }
    targets.hosted = {
      baseUrl: required(options, 'hosted-base-url'),
      renderServiceId: required(options, 'render-service-id'),
      neonProjectId: required(options, 'neon-project-id'),
      cohortNeonBranchId: required(options, 'cohort-neon-branch-id'),
      restoreNeonProjectId: required(options, 'restore-neon-project-id'),
      restoreNeonBranchId: required(options, 'restore-neon-branch-id'),
      restoreTargetKind: 'isolated-neon-branch',
      restoreTargetFingerprint: required(options, 'restore-target-fingerprint'),
      restoreAppBaseUrl: required(options, 'restore-app-base-url'),
      restoreAppDeployId: required(options, 'restore-app-deploy-id')
    };
  }
  return targets;
}

function sign(options) {
  const keyPath = path.resolve(required(options, 'key'));
  let privateKey;
  try {
    privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath));
  } catch {
    fail(`authorization key at ${keyPath} could not be read`);
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') fail('authorization key must be Ed25519');

  const jobs = required(options, 'jobs').split(',').map(job => job.trim()).filter(Boolean);
  if (!jobs.length) fail('--jobs must name at least one job');
  for (const job of jobs) if (!ALLOWED_JOBS.includes(job)) fail(`unknown job: ${job}`);

  const minutes = Number(options.minutes || DEFAULT_LIFETIME_MINUTES);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_LIFETIME_MINUTES) {
    fail(`--minutes must be between 1 and ${MAX_LIFETIME_MINUTES}`);
  }

  const targets = targetsFor(ALLOWED_JOBS.filter(job => jobs.includes(job)), options);
  const targetHashes = {};
  for (const job of Object.keys(targets)) targetHashes[job] = hashLiveTarget(job, targets[job]);

  const payload = {
    schemaVersion: AUTHORIZATION_SCHEMA_VERSION,
    workflow: WORKFLOW,
    repository: required(options, 'repository'),
    ref: required(options, 'ref'),
    event: 'workflow_dispatch',
    sourceParent: requireSha1(options, 'source-parent'),
    sourceCommit: requireSha1(options, 'source-commit'),
    subjectSha256: required(options, 'subject-sha256'),
    authorizedJobs: ALLOWED_JOBS.filter(job => jobs.includes(job)),
    targetHashes,
    /*
     * The nonce the run spends. Random rather than derived, so re-signing the
     * same approval mints a different identifier and the ledger sees two
     * distinct activations rather than silently accepting a replay.
     */
    authorizationId: `alpha17-${crypto.randomUUID()}`,
    expiresAt: new Date(Date.now() + minutes * 60 * 1000).toISOString()
  };
  if (!/^[0-9a-f]{64}$/.test(payload.subjectSha256)) {
    fail('--subject-sha256 must be a 64-character candidate archive digest');
  }

  process.stdout.write(`${JSON.stringify({
    authorization_token: encodeAuthorizationEnvelope(payload, privateKey),
    expiresAt: payload.expiresAt,
    authorizedJobs: payload.authorizedJobs,
    targetHashes
  }, null, 2)}\n`);
}

function main(argv) {
  const command = argv[0];
  const options = parseArguments(argv.slice(1));
  if (command === 'keygen') return keygen(options);
  if (command === 'sign') return sign(options);
  fail('usage: alpha17-authorize.js <keygen|sign> [options]');
}

if (require.main === module) main(process.argv.slice(2));

module.exports = Object.freeze({ WORKFLOW, ALLOWED_JOBS, MAX_LIFETIME_MINUTES });
