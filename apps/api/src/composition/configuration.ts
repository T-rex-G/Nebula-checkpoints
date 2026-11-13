/*
 * What the server is configured with: everything the tree it runs from and
 * the environment decide at startup, each read once, before anything is built.
 *
 * Two reads, in the order the server has always made them, so a deployment
 * with more than one thing wrong is refused for the same one first: the tree
 * (the capability document, the release's identity and the built page), then
 * -- once the proxies to trust are read -- the secrets, the keys derived from
 * them and the rest of the settings.
 */
import * as path from 'node:path';
import { loadCapabilityDocument } from './commonjs.ts';
import { loadQualificationCapabilities } from './commonjs.ts';
import { createSnapshotSignatures, evidenceKeyrings, loadSnapshotSigningConfig } from '../modules/corona/index.ts';
import { loadServerSecrets, loadServerSettings } from '../platform/config/server-settings.ts';
import { computeReleaseFingerprint } from '../platform/release/release-fingerprint.ts';
import { describeServerRuntime } from '../platform/release/server-runtime.ts';
import { loadWebBuild } from '../platform/release/web-build.ts';

export const DEPLOYMENT_PROFILE = 'hosted-alpha';
const MB = 1024 * 1024;

/*
 * The tree: where the server runs from, what it may offer, and what it is.
 *
 * `root` is the checkout natively and dist/server in the compiled runtime
 * (ADR-088), laid out alike, so every file read beside it resolves in both.
 * ADR-067/ADR-072 bind /api/version to bytes observed at startup: an embedded
 * build-time digest would be circular and could attest different bytes. The
 * compiled server still names the source it was built from, and its own tree
 * beside it. The page is read once; the server will not start without it.
 */
export function loadRelease(root: string, env: NodeJS.ProcessEnv) {
  const { capabilityDocument, qualificationCapabilities } = loadCapabilities(root, env);
  const runtime = describeServerRuntime(root);
  const releaseTreeSha256 = computeReleaseFingerprint(runtime.sourceRoot);
  const webRoot = path.join(root, 'dist', 'web');
  const webBuild = loadWebBuild(webRoot);
  return Object.freeze({ root, capabilityDocument, qualificationCapabilities, runtime, releaseTreeSha256, webRoot, webBuild });
}

/*
 * What the deployment may offer: the capability document, and a staging
 * deployment's capabilities awaiting the proof only it can give (empty
 * everywhere else). Part of the release, and the part of it the environment
 * decides, so scripts/doctor.js asks it too.
 */
export function loadCapabilities(root: string, env: NodeJS.ProcessEnv) {
  const capabilityDocument = loadCapabilityDocument(path.join(root, 'config', 'public-alpha-capabilities.json'));
  const qualificationCapabilities = loadQualificationCapabilities(env, capabilityDocument, { deployment: DEPLOYMENT_PROFILE });
  return { capabilityDocument, qualificationCapabilities };
}

/*
 * The secrets, the keys derived from them, and everything else the
 * environment sets (platform/config/server-settings.ts).
 *
 * Evidence verification holds two keyrings, assembled together in Corona's
 * evidence ledger so their retired lists cannot drift apart. Rows written
 * before key separation were hashed with the raw session secret, and rows
 * written before a SESSION_SECRET rotation with a key derived from the
 * previous secret. Accepting the raw secret unconditionally would undo half
 * the point of separating the keys -- a leaked SESSION_SECRET could forge
 * records that verify, permanently -- so production accepts it only on an
 * explicit opt-in, the rule Corona's snapshot signatures already apply to
 * legacy snapshot keys. Development keeps the compatibility path. A deployment
 * that declines the opt-in is not left guessing: the probe reports
 * legacyKeyRequired, so the operator can tell an unmigrated chain from real
 * tampering without having to accept the key to find out.
 */
export function loadSettings(env: NodeJS.ProcessEnv) {
  const secrets = loadServerSecrets(env);
  const evidence = evidenceKeyrings(env, { sessionSecret: secrets.secret, ledgerSecret: secrets.keys.evidenceLedger });
  const snapshotSignatures = createSnapshotSignatures(loadSnapshotSigningConfig(env, {
    production: env.NODE_ENV === 'production',
    // Production uses this only to reject active-key reuse. Legacy verification
    // requires the explicit NV_SNAPSHOT_LEGACY_KEYS_JSON operator keyring.
    sessionSecret: secrets.secret
  }));
  const settings = loadServerSettings(env, { secret: secrets.secret, hostingProfile: secrets.hostingProfile });
  /* The transfer limits, in bytes; a native push's is a memory-safe ceiling under GitHub's absolute 100 MB for a non-LFS object. */
  const limits = Object.freeze({
    contentsMax: 40 * MB,
    blobMax: settings.gitDataMaxMb * MB,
    gitPushMax: settings.nativePushMaxMb * MB,
    uploadMax: settings.uploadMaxMb * MB,
    uploadTimeoutMs: settings.uploadTimeoutMinutes * 60 * 1000
  });
  return Object.freeze({ secrets, evidence, snapshotSignatures, settings, limits, databaseConfigured: Boolean(settings.databaseUrl) });
}

export type Release = ReturnType<typeof loadRelease>;
export type Settings = ReturnType<typeof loadSettings>;
export const BYTES_PER_MB = MB;
