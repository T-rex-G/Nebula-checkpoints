/*
 * Canonical JSON: the exact bytes a hash or a signature is taken over.
 *
 * The keys of a plain object are sorted at every depth, arrays keep their
 * order, and anything else, a Date included, is left to JSON.stringify.
 * Policy hashes, the governance audit chain, the decision ledger and the
 * qualification evidence are signed over these bytes, so the text this
 * produces must never change. Other canonical forms in the server differ on
 * undefined and on objects with toJSON; they are not this one.
 *
 * Platform-free, so any part of the system can load it.
 */

import { isPlainObject } from './guards.ts';

export const CANONICAL_JSON_CONTRACT_VERSION = 1;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
  }
  return value;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}
