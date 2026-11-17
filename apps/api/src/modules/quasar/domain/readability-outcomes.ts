/*
 * What a readability probe can conclude. There is no word for "protected":
 * a refused request says only that the request was refused.
 */

export const PROBE_STATES = Object.freeze({
  READABLE: 'readable',
  DENIED: 'denied',
  UNVERIFIABLE: 'unverifiable'
} as const);
export type ProbeState = (typeof PROBE_STATES)[keyof typeof PROBE_STATES];

export const REASONS = Object.freeze({
  AUTHORIZATION_MISSING: 'authorization-missing',
  AUTHORIZATION_INVALID: 'authorization-invalid',
  AUTHORIZATION_EXPIRED: 'authorization-expired',
  AUTHORIZATION_MISMATCH: 'authorization-mismatch',
  KEY_NOT_ANONYMOUS: 'key-not-anonymous',
  PROJECT_REFUSED: 'project-refused',
  RELATION_REFUSED: 'relation-refused',
  PROJECTION_REFUSED: 'projection-refused',
  ROWS_VISIBLE: 'rows-visible',
  NO_VISIBLE_ROWS: 'no-visible-rows',
  ACCESS_DENIED_FOR_TESTED_REQUEST: 'access-denied-for-tested-request',
  PROVIDER_THROTTLED: 'provider-throttled',
  PROVIDER_UNEXPECTED_RESPONSE: 'provider-unexpected-response',
  TRANSPORT_REFUSED: 'transport-refused'
} as const);
export type ProbeReason = (typeof REASONS)[keyof typeof REASONS];
