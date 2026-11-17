/*
 * An HMAC-SHA256 keyed with whatever a caller holds. `crypto` decides what a
 * key may be, and refuses anything else with its own TypeError; this does not
 * narrow that first, so a caller fails exactly as it would calling `crypto`
 * itself.
 */
import crypto from 'node:crypto';

export function sha256Hmac(secret: unknown): crypto.Hmac {
  const hmac: crypto.Hmac = Reflect.apply(crypto.createHmac, crypto, ['sha256', secret]);
  return hmac;
}
