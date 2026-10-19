/*
 * The identifier formats that cross a trust boundary, each written once.
 *
 * A format is a shape, not a meaning: a SHA-256 digest and the identity key
 * derived from one share a shape, and say different things. Each meaning has
 * its own name here so a reader of the caller knows which one it holds.
 *
 * test/contracts.test.js counts the copies of these patterns still written
 * out elsewhere. The count may only fall: the server's reach zero as Phase D
 * dissolves server.js, and the page's as Phase E dissolves the classic page.
 */

export const IDS_CONTRACT_VERSION = 1;

/* Lower-case hexadecimal SHA-256, as the server writes digests and fingerprints. */
export const SHA256_HEX = /^[0-9a-f]{64}$/;
/* The server's name for a person or installation: the SHA-256 of what identifies it. Never the login itself. */
export const IDENTITY_KEY = SHA256_HEX;
/* A full Git commit identifier. */
export const COMMIT_SHA = /^[0-9a-f]{40}$/;
/* A governance record: an RFC 9562 UUID of versions 1 to 8. */
export const RECORD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/* A governed mutation: the server mints these as version 4; versions 1 to 5 are accepted, as they always were. */
export const MUTATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/* The support reference a public error carries, and the header that echoes it. */
export const CORRELATION_ID = /^nvx-[0-9a-f]{16}$/;
/* A governance policy's stable key. */
export const POLICY_KEY = /^[a-z][a-z0-9._-]{1,63}$/;
/* One segment of a repository's owner or name. `.` and `..` are refused separately. */
export const REPOSITORY_SEGMENT = /^[A-Za-z0-9_.-]+$/;

declare const brand: unique symbol;
type Branded<T, Name extends string> = T & { readonly [brand]: Name };

export type IdentityKey = Branded<string, 'IdentityKey'>;
export type CommitSha = Branded<string, 'CommitSha'>;
export type RecordId = Branded<string, 'RecordId'>;
export type MutationId = Branded<string, 'MutationId'>;
export type CorrelationId = Branded<string, 'CorrelationId'>;
export type PolicyKey = Branded<string, 'PolicyKey'>;

export const isSha256Hex = (value: string): boolean => SHA256_HEX.test(value);
export const isIdentityKey = (value: string): value is IdentityKey => IDENTITY_KEY.test(value);
export const isCommitSha = (value: string): value is CommitSha => COMMIT_SHA.test(value);
export const isRecordId = (value: string): value is RecordId => RECORD_ID.test(value);
export const isMutationId = (value: string): value is MutationId => MUTATION_ID.test(value);
export const isCorrelationId = (value: string): value is CorrelationId => CORRELATION_ID.test(value);
export const isPolicyKey = (value: string): value is PolicyKey => POLICY_KEY.test(value);

/* Every format above, by name: what the copy count in test/contracts.test.js looks for. */
export const ID_FORMATS: Readonly<Record<string, RegExp>> = Object.freeze({
  SHA256_HEX, COMMIT_SHA, RECORD_ID, MUTATION_ID, CORRELATION_ID, POLICY_KEY, REPOSITORY_SEGMENT
});
