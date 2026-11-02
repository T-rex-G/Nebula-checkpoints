import { randomBytes as cryptoRandomBytes } from 'node:crypto';
import { publicErrorBody as envelopeBody, type PublicErrorBody } from '../../../../packages/contracts/src/api-envelope.ts';
import { member } from '../platform/values/fields.ts';

type RandomBytes = (size: number) => Buffer;

/* The body every refusal is sent as is the API envelope contract; minting its support reference is this platform's part. */
export function createCorrelationId(randomBytes: RandomBytes = cryptoRandomBytes): string {
  return `nvx-${randomBytes(8).toString('hex')}`;
}

export function publicErrorBody(error: unknown, context: Parameters<typeof envelopeBody>[1] = {}): PublicErrorBody {
  return envelopeBody(error, context, createCorrelationId);
}

interface FailureResponse {
  readonly headersSent: boolean;
  readonly destroyed: boolean;
  readonly locals: { readonly correlationId?: string };
  destroy(): void;
  setHeader(name: string, value: string): unknown;
  status(code: number): { json(body: unknown): unknown };
}

/*
 * Answers a request that failed: its status when it carries one a client can
 * be given (4xx or 5xx), else 500, with the public error body. Whatever a
 * route caught is handed in, and read as JavaScript reads a member of it.
 */
export function sendFailure(res: FailureResponse, error: unknown): unknown {
  // Once a download starts, a second JSON response cannot be sent. End the
  // broken transfer without letting ERR_HTTP_HEADERS_SENT escape the handler.
  if (res.headersSent || res.destroyed) {
    if (!res.destroyed) res.destroy();
    return undefined;
  }
  /* Compared as it came, so a status written as text is read as it always was. */
  const raw = (error ? member(error, 'status') : undefined) as number;
  const status = error && raw >= 400 && raw < 600 ? raw : 500;
  const body = publicErrorBody(error, { correlationId: res.locals.correlationId });
  /* A limit that named its own wait passes it on, so a client waits that long and no longer. */
  const wait = status === 429 ? member(error, 'retryAfterSeconds') : undefined;
  if (Number.isSafeInteger(wait) && (wait as number) > 0) res.setHeader('Retry-After', String(wait));
  /* A refusal that has a compliant route carries it alongside the refusal. The
   * public error body itself is left exactly as it was. */
  const passage = error && member(error, 'safePassage');
  return res.status(status).json(passage ? { ...body, safePassage: passage } : body);
}
