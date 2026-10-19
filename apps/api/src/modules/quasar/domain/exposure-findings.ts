import { createHmac } from 'node:crypto';
import { inspect } from 'node:util';

import { DETECTION_ENGINE_VERSION, RULES_VERSION, sanitizeCandidate } from './exposure-detection.ts';
import type { DetectedCandidate, Location } from './exposure-detection.ts';

type Fields = Readonly<Record<string, unknown>>;

/* A field of something that may not be an object, read as plain JavaScript would. */
function read(value: unknown, key: string): unknown {
  return value == null ? undefined : (value as Fields)[key];
}

/*
 * What makes two sightings of a credential the same finding.
 *
 * Identity has to survive everything that changes for reasons unrelated to the
 * exposure -- a file reformatted, an import added above, a checkout with
 * different line endings -- and separate everything that is genuinely
 * different, including two tokens that look alike at a glance and the same
 * token in two repositories. Wrong in either direction and the product lies. A
 * finding whose identity changes every commit can never be marked triaged.
 * One that merges two credentials lets a reader revoke a key and believe they
 * are finished.
 *
 * So identity is a keyed MAC over the things that are the exposure: the scope
 * it was found in, the exact Git path, the rule, and the credential bytes. A
 * line number is not in it, because a line number is where something is rather
 * than what it is.
 *
 * Keyed rather than hashed, and this is not defensive habit. The population of
 * a provider's token format is small enough to walk offline, so an unkeyed
 * digest of a credential published on a finding is the credential for anybody
 * with the hardware to spend. The key version travels with every fingerprint
 * for the same reason: rotating a key is allowed, and silently reporting every
 * prior finding as resolved because the fingerprints no longer match is not.
 * `reconcileFindings` refuses to diff across a version change rather than
 * producing a wall of green that means nothing happened.
 *
 * Nothing stored here carries a credential. The bytes travel on a probe built
 * so the accident is impossible rather than forbidden: serialising, printing,
 * interpolating or inspecting one yields a redaction, and `revealForVerification`
 * is the single deliberate exit. What this module does not claim is that the
 * bytes can be erased afterwards -- a JavaScript string is immutable and the
 * engine copies it at will, so the honest claim is the weaker one: as few
 * copies as possible, held for as short a time as possible, and never stored.
 */

export const FINGERPRINT_KEY_VERSION = 1;
const REDACTED = '[redacted]';

function requireKey(hmacKey: unknown): Buffer | string {
  if (!Buffer.isBuffer(hmacKey) && typeof hmacKey !== 'string') {
    throw new TypeError('A finding fingerprint requires a purpose-derived HMAC key');
  }
  return hmacKey;
}

/*
 * Length-prefixed parts, so no rearrangement of one finding's fields can
 * produce another's message: an owner and repository pair must not sign the
 * same bytes as a path that happens to contain the separator.
 *
 * Nothing in here is folded. No case change, no Unicode normalisation, no
 * trimming of the path. `README` and `readme` are two entries in a Git tree
 * even where a filesystem disagrees, and a name written with a combining
 * accent is a different name from the same name written composed. Display
 * normalisation is a rendering decision and identity is not the place for it.
 */
interface FingerprintParts {
  readonly keyVersion: number;
  readonly rulesVersion: number;
  readonly engineVersion: number;
  readonly scope: unknown;
  readonly path: unknown;
  readonly rule: unknown;
  readonly secret: unknown;
}

function fingerprintMessage(input: FingerprintParts): string {
  const parts = [
    'nvexpfp.v1',
    String(input.keyVersion),
    String(input.rulesVersion),
    String(input.engineVersion),
    String(input.scope && read(input.scope, 'provider') || ''),
    String(input.scope && read(input.scope, 'authority') || ''),
    String(input.scope && read(input.scope, 'owner') || ''),
    String(input.scope && read(input.scope, 'repo') || ''),
    String(input.path || ''),
    String(input.rule || ''),
    String(input.secret == null ? '' : input.secret)
  ];
  return parts.map(part => `${Buffer.byteLength(part, 'utf8')}:${part}`).join('|');
}

export interface FingerprintInput {
  readonly hmacKey?: unknown;
  readonly keyVersion?: unknown;
  readonly rulesVersion?: unknown;
  readonly engineVersion?: unknown;
  readonly scope?: unknown;
  readonly path?: unknown;
  readonly rule?: unknown;
  readonly secret?: unknown;
}

function versionOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) ? value : fallback;
}

export function fingerprintFor(input: FingerprintInput = {}): string {
  const hmacKey = requireKey(input.hmacKey);
  const message = fingerprintMessage({
    keyVersion: versionOr(input.keyVersion, FINGERPRINT_KEY_VERSION),
    rulesVersion: versionOr(input.rulesVersion, RULES_VERSION),
    engineVersion: versionOr(input.engineVersion, DETECTION_ENGINE_VERSION),
    scope: input.scope,
    path: input.path,
    rule: input.rule,
    secret: input.secret
  });
  return createHmac('sha256', hmacKey).update(message, 'utf8').digest('hex');
}

/*
 * A wrapper whose job is to fail closed on the ordinary accidents. Two
 * mechanisms, deliberately independent of each other, because the accidents
 * are not all the same shape.
 *
 * The private field covers the accidents that enumerate. A `#field` is not an
 * own property, so a spread, `Object.keys`, `Object.values`, a structured
 * clone and a plain `JSON.stringify` all find nothing -- and no inspect
 * option reveals it, `showHidden` included. Writing the field as a public one
 * would leak through every one of those even with the hooks below intact,
 * which is why this is not a style choice.
 *
 * The `toJSON`, `toString` and inspect hooks cover the accidents that
 * stringify, and they say `[redacted]` rather than rendering an empty object.
 * Empty is safe and tells a reader nothing: `CandidateSecret {}` in a log
 * leaves them unable to tell whether the value was absent, empty or withheld.
 * Saying so is the difference between a redaction and a mystery.
 *
 * Reaching the credential takes `revealForVerification`: one name to audit and
 * one place to put a comment about why.
 */
export class CandidateSecret {
  #bytes: string;

  constructor(bytes: unknown) {
    this.#bytes = String(bytes);
  }

  reveal(): string {
    return this.#bytes;
  }

  get length(): number {
    return this.#bytes.length;
  }

  toJSON(): string {
    return REDACTED;
  }

  toString(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}

/*
 * The single deliberate exit. Returns the shape the verifier consumes, built
 * fresh each time so nothing a caller was handed can be mutated back into a
 * stored finding.
 */
export interface VerificationProbe {
  readonly fingerprint: string;
  readonly rule: string;
  readonly scope: FindingScope;
  readonly commit: string;
  readonly secret: CandidateSecret;
}

export interface RevealedProbe {
  readonly rule: string;
  readonly secret: string;
  readonly fingerprint: string;
  readonly scope: FindingScope;
  readonly commit: string;
}

export function revealForVerification(probe: unknown): RevealedProbe {
  if (!probe || !(read(probe, 'secret') instanceof CandidateSecret)) {
    throw new TypeError('revealForVerification expects a probe produced by buildFindings');
  }
  /* Only buildFindings makes a probe holding a CandidateSecret, as just checked. */
  const made = probe as VerificationProbe;
  return Object.freeze({
    rule: made.rule,
    secret: made.secret.reveal(),
    fingerprint: made.fingerprint,
    scope: made.scope,
    commit: made.commit
  });
}

/*
 * Turns one file's detection into findings and probes. The findings are what
 * gets stored and shown; the probes are what a verification run consumes and
 * discards.
 */
export interface FindingScope {
  readonly provider: string;
  readonly authority: string;
  readonly owner: string;
  readonly repo: string;
}

/* What a scan stores and shows about one credential: never the credential. */
export interface Finding {
  readonly fingerprint: string;
  readonly fingerprintKeyVersion: number;
  readonly rulesVersion: number;
  readonly engineVersion: number;
  readonly rule: string;
  readonly path: string;
  readonly placeholder: string;
  readonly occurrences: readonly Location[];
  readonly occurrenceCount: number;
  readonly truncated: boolean;
  readonly decodedFrom: string | null;
  readonly scope: FindingScope;
  readonly commit: string;
}

export interface BuiltFindings {
  readonly findings: readonly Finding[];
  readonly probes: readonly VerificationProbe[];
  readonly scanned: boolean;
  readonly truncated: boolean;
}

export interface BuildFindingsInput {
  readonly hmacKey?: unknown;
  readonly detection?: unknown;
  readonly path?: unknown;
  readonly commit?: unknown;
  readonly scope?: unknown;
  readonly keyVersion?: unknown;
}

export function buildFindings(input: BuildFindingsInput = {}): BuiltFindings {
  const hmacKey = requireKey(input.hmacKey);
  const detection: Fields = input.detection && typeof input.detection === 'object' ? input.detection as Fields : {};
  /* Detection's own candidates, each carrying the bytes it found. */
  const candidates = (Array.isArray(detection.candidates) ? detection.candidates : []) as readonly DetectedCandidate[];
  const filePath = String(input.path || '');
  const commit = String(input.commit || '');
  const scope = Object.freeze({
    provider: String(input.scope && read(input.scope, 'provider') || ''),
    authority: String(input.scope && read(input.scope, 'authority') || ''),
    owner: String(input.scope && read(input.scope, 'owner') || ''),
    repo: String(input.scope && read(input.scope, 'repo') || '')
  });
  const keyVersion = versionOr(input.keyVersion, FINGERPRINT_KEY_VERSION);

  const findings: Finding[] = [];
  const probes: VerificationProbe[] = [];
  for (const candidate of candidates) {
    const fingerprint = fingerprintFor({
      hmacKey, keyVersion, scope, path: filePath, rule: candidate.rule, secret: candidate.secret
    });
    const sanitized = sanitizeCandidate(candidate);
    findings.push(Object.freeze({
      fingerprint,
      fingerprintKeyVersion: keyVersion,
      rulesVersion: RULES_VERSION,
      engineVersion: DETECTION_ENGINE_VERSION,
      rule: sanitized.rule,
      path: filePath,
      placeholder: sanitized.placeholder,
      occurrences: sanitized.occurrences,
      occurrenceCount: sanitized.occurrenceCount,
      truncated: sanitized.truncated,
      decodedFrom: sanitized.decodedFrom,
      scope,
      commit
    }));
    probes.push(Object.freeze({
      fingerprint,
      rule: candidate.rule,
      scope,
      commit,
      secret: new CandidateSecret(candidate.secret)
    }));
  }

  return Object.freeze({
    findings: Object.freeze(findings),
    probes: Object.freeze(probes),
    scanned: detection.scanned !== false,
    truncated: Boolean(detection.truncated)
  });
}

/*
 * Comparing two scans of the same repository.
 *
 * The failure this guards against is the quiet one. Rotate the fingerprint
 * key, or edit a rule, and every fingerprint changes at once: an ordinary diff
 * then shows every previous finding resolved and every current one new, which
 * reads to a human as "everything was fixed". So versions are checked first
 * and a mismatch refuses, reporting nothing resolved and nothing appeared. A
 * caller that wants to migrate has to say so and do it deliberately.
 *
 * A previous set written under two different versions is refused for the same
 * reason. Choosing the majority version would silently resolve the minority.
 */
function versionsOf(findings: readonly unknown[], field: string): Set<unknown> {
  return new Set(findings.map(finding => finding && read(finding, field)));
}

export interface Reconciliation {
  readonly comparable: boolean;
  readonly reason: string | null;
  readonly resolved: readonly Fields[];
  readonly appeared: readonly Fields[];
  readonly unchanged: readonly Fields[];
}

export function reconcileFindings(input: { readonly previous?: unknown; readonly current?: unknown } = {}): Reconciliation {
  /* Stored or just-built findings: objects keyed by their fingerprint. */
  const previous = (Array.isArray(input.previous) ? input.previous : []) as readonly Fields[];
  const current = (Array.isArray(input.current) ? input.current : []) as readonly Fields[];

  const refusal = Object.freeze({
    comparable: false,
    resolved: Object.freeze([]),
    appeared: Object.freeze([]),
    unchanged: Object.freeze([])
  });

  const versionFields: readonly (readonly [string, string])[] = [
    ['fingerprintKeyVersion', 'fingerprint-key-version-changed'],
    ['rulesVersion', 'rules-version-changed'],
    ['engineVersion', 'engine-version-changed']
  ];
  for (const [field, reason] of versionFields) {
    /*
     * A first scan has nothing to compare against, so a difference cannot be
     * hiding anything: every current finding is new and that is the truth.
     */
    const versions = new Set([...versionsOf(previous, field), ...versionsOf(current, field)]);
    if (previous.length && versions.size > 1) {
      return Object.freeze({ ...refusal, reason });
    }
  }

  const before = new Map(previous.map(finding => [finding.fingerprint, finding]));
  const after = new Map(current.map(finding => [finding.fingerprint, finding]));
  return Object.freeze({
    comparable: true,
    reason: null,
    unchanged: Object.freeze(current.filter(finding => before.has(finding.fingerprint))),
    appeared: Object.freeze(current.filter(finding => !before.has(finding.fingerprint))),
    resolved: Object.freeze(previous.filter(finding => !after.has(finding.fingerprint)))
  });
}

/* A non-secret, domain-separated identifier detects key rotation between
   queuing and executing a scan, even when the numeric key version is unchanged. */
export function fingerprintKeyId(key: unknown): string {
  return createHmac('sha256', requireKey(key)).update('nv-exposure-key-id/v1').digest('hex');
}
