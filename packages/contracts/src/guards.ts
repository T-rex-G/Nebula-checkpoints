/*
 * What every contract's guard is built from.
 *
 * A guard answers with the value it accepted or refuses through the caller's
 * own `refuse`, so each boundary keeps the error class, code and status its
 * clients already assert. A caller that passes none gets a ContractError
 * carrying the same code and status.
 *
 * Platform-free: the server, the page and the service worker all load this.
 */

export const GUARDS_CONTRACT_VERSION = 1;

export type Refuse = (message: string, code: string, status?: number) => never;

export class ContractError extends Error {
  readonly code: string;
  readonly status: number | undefined;

  constructor(message: string, code: string, status?: number) {
    super(message);
    this.name = 'ContractError';
    this.code = code;
    this.status = status;
  }
}

export const refuseWithContractError: Refuse = (message, code, status) => {
  throw new ContractError(message, code, status);
};

export type JsonObject = Record<string, unknown>;

/* A plain JSON-shaped object: made by a literal or with no prototype at all. */
export function isPlainObject(value: unknown): value is JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

/* The bytes a string takes as UTF-8, as the server's Buffer.byteLength counts them: a lone surrogate is written as U+FFFD. */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { bytes += 4; index += 1; }
      else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}
