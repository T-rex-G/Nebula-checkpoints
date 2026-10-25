/*
 * Whether a delivery was signed with the repository's webhook secret: the
 * `X-Hub-Signature-256` header, compared with the HMAC of the exact bytes
 * received, in constant time.
 */
import crypto from 'node:crypto';
import { types } from 'node:util';

/* What an HMAC can be keyed with. Anything else is refused as `crypto` refuses it: by throwing. */
function hmacKey(value: unknown): crypto.BinaryLike | crypto.KeyObject {
  if (typeof value === 'string' || types.isTypedArray(value) || value instanceof DataView || value instanceof crypto.KeyObject) return value;
  throw new TypeError('The webhook secret must be a string, a buffer or a key');
}

export function verifyGithubSignature(secret: unknown, rawBody: unknown, signature: unknown): boolean {
  if (!secret || !Buffer.isBuffer(rawBody) || typeof signature !== 'string' || !signature.startsWith('sha256=')) return false;
  const expected = Buffer.from(`sha256=${crypto.createHmac('sha256', hmacKey(secret)).update(rawBody).digest('hex')}`);
  const supplied = Buffer.from(signature);
  return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
}
