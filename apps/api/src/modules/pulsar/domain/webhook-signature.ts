/*
 * Whether a delivery was signed with the repository's webhook secret: the
 * `X-Hub-Signature-256` header, compared with the HMAC of the exact bytes
 * received, in constant time.
 */
import crypto from 'node:crypto';
import { sha256Hmac } from '../../../platform/crypto/hmac.ts';

export function verifyGithubSignature(secret: unknown, rawBody: unknown, signature: unknown): boolean {
  if (!secret || !Buffer.isBuffer(rawBody) || typeof signature !== 'string' || !signature.startsWith('sha256=')) return false;
  const expected = Buffer.from(`sha256=${sha256Hmac(secret).update(rawBody).digest('hex')}`);
  const supplied = Buffer.from(signature);
  return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
}
