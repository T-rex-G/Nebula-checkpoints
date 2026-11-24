/*
 * What travels between the page and the server around every answer.
 *
 * A request carries the application header (cross-site requests carry none)
 * and, when it changes anything, the session's CSRF token. A refused request
 * is answered with an error body. Its message is safe to show and never
 * echoes a credential, and its code is one the catalogue names. The support
 * reference also comes back as a header, so an answer the edge produced
 * without a body still has one when the server saw the request.
 *
 * publicErrorBody is ported from apps/api/src/http/errors.ts with its behaviour
 * unchanged; minting a reference is left to the caller's platform.
 */
import { CORRELATION_ID } from './ids.ts';
import type { CorrelationId } from './ids.ts';

export const API_ENVELOPE_CONTRACT_VERSION = 2;

export const APP_HEADER = 'x-nv';
export const APP_HEADER_VALUE = '1';
export const CSRF_HEADER = 'x-nv-csrf';
/* A single-use step-up grant, presented with the one sensitive request it was minted for. */
export const STEP_UP_HEADER = 'x-nv-step-up';
export const CORRELATION_HEADER = 'x-nebulaverse-correlation-id';

/* The shape a code must have before an error body repeats it. */
export const ERROR_CODE_FORMAT = /^[A-Z][A-Z0-9_]{2,80}$/;
/* A message that looks like it carries a credential is replaced, whatever its code. */
export const SECRET_SIGNAL = /(?:gh[pousr]_|glpat-|(?:access[_ -]?)?token\s*[=:]|authorization\s*:|bearer\s+|pass(?:word)?\s*[=:]|private[_ -]?key|client[_ -]?secret|session[_ -]?cookie|postgres(?:ql)?:\/\/)/i;

export type ProviderChanged = 'yes' | 'no' | 'unknown';

/* The refusal the generic failure path sends: every field present. */
export interface PublicErrorBody {
  readonly error: string;
  readonly code: string;
  readonly correlationId: CorrelationId;
  readonly providerChanged: ProviderChanged;
  readonly safeState: string;
  readonly nextAction: string;
}

/* Any refusal the page may receive. Older routes send only a message and a code; a refusal with a compliant route carries it. */
export interface ApiErrorBody {
  readonly error: string;
  readonly code?: string;
  readonly correlationId?: string;
  readonly providerChanged?: ProviderChanged;
  readonly safeState?: string;
  readonly nextAction?: string;
  readonly safePassage?: Readonly<Record<string, unknown>>;
  readonly locked?: boolean;
}

/* What the server reads from a failure when it answers; anything thrown may be handed in. */
export interface FailureFacts {
  readonly message?: unknown;
  readonly code?: unknown;
  readonly providerChanged?: unknown;
  readonly safeState?: unknown;
  readonly nextAction?: unknown;
}

function clean(value: unknown, max: number): string {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, max);
}

/*
 * `error && error[key]`, as JavaScript reads it from whatever was thrown: a
 * falsy value is its own answer, and anything else is read as an object, so a
 * text or a number thrown has none of these facts.
 */
function fact(error: unknown, key: keyof FailureFacts): unknown {
  return error ? Reflect.get(Object(error), key) : error;
}

export function publicErrorBody(error: unknown, context: { readonly correlationId?: unknown }, mintCorrelationId: () => string): PublicErrorBody {
  const correlationId = CORRELATION_ID.test(String(context.correlationId || ''))
    ? String(context.correlationId)
    : mintCorrelationId();
  const raw = clean(fact(error, 'message'), 300);
  const known = ERROR_CODE_FORMAT.test(String(fact(error, 'code') || ''));
  const safeMessage = raw && !SECRET_SIGNAL.test(raw) && known
    ? raw
    : 'Operation could not be completed';
  const changed = fact(error, 'providerChanged');
  return Object.freeze({
    error: safeMessage,
    code: known ? String(fact(error, 'code')) : 'OPERATION_FAILED',
    correlationId: correlationId as CorrelationId,
    providerChanged: changed === true ? 'yes' : changed === false ? 'no' : 'unknown',
    safeState: clean(fact(error, 'safeState'), 300) || (
      changed === false
        ? 'No provider change was confirmed.'
        : 'The final provider state is not yet confirmed.'
    ),
    nextAction: clean(fact(error, 'nextAction'), 300)
      || 'Retry once. If the problem remains, copy the support correlation ID.'
  });
}
