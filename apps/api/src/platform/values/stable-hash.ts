/*
 * The server's stable JSON, and the hashes taken over it.
 *
 * Object keys are sorted at every depth and arrays keep their order. This is
 * not the shared contracts' canonical JSON (packages/contracts/src/
 * canonical-json.ts): it writes an `undefined` member as `undefined`, and
 * reads a value with `toJSON` as the object it is, not the value it turns
 * into. Stored event ids, evidence payload hashes and the session's
 * account merge were all taken over these bytes, so they must never change.
 */
import crypto from 'node:crypto';
import { isFields } from './fields.ts';

export function stableJson(value: unknown): string {
  /* As JSON.stringify answers: nothing at all for `undefined`, which a caller hashing it is told about by `crypto`. */
  if (!isFields(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

export function hashJson(value: unknown): string {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

export function hmacJson(secret: crypto.BinaryLike | crypto.KeyObject, value: unknown): string {
  return crypto.createHmac('sha256', secret).update(stableJson(value)).digest('hex');
}
