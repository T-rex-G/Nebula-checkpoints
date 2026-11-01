import { randomBytes as cryptoRandomBytes } from 'node:crypto';
import { publicErrorBody as envelopeBody, type PublicErrorBody } from '../../../../packages/contracts/src/api-envelope.ts';

type RandomBytes = (size: number) => Buffer;

/* The body every refusal is sent as is the API envelope contract; minting its support reference is this platform's part. */
export function createCorrelationId(randomBytes: RandomBytes = cryptoRandomBytes): string {
  return `nvx-${randomBytes(8).toString('hex')}`;
}

export function publicErrorBody(error: Parameters<typeof envelopeBody>[0], context: Parameters<typeof envelopeBody>[1] = {}): PublicErrorBody {
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

type Failure = Parameters<typeof envelopeBody>[0] & { readonly status?: number; readonly retryAfterSeconds?: number; readonly safePassage?: unknown };

/*
 * Answers a request that failed: its status when it carries one a client can
 * be given (4xx or 5xx), else 500, with the public error body.
 */
export function sendFailure(res: FailureResponse, error: Failure | null | undefined): unknown {
  // Once a download starts, a second JSON response cannot be sent. End the
  // broken transfer without letting ERR_HTTP_HEADERS_SENT escape the handler.
  if (res.headersSent || res.destroyed) {
    if (!res.destroyed) res.destroy();
    return undefined;
  }
  /* Compared as it came, so a status written as text is read as it always was. */
  const raw = (error ? error.status : undefined) as unknown as number;
  const status = error && raw >= 400 && raw < 600 ? raw : 500;
  const body = publicErrorBody(error as Parameters<typeof envelopeBody>[0], { correlationId: res.locals.correlationId });
  /* A limit that named its own wait passes it on, so a client waits that long and no longer. */
  if (status === 429 && Number.isSafeInteger(error!.retryAfterSeconds) && error!.retryAfterSeconds! > 0) {
    res.setHeader('Retry-After', String(error!.retryAfterSeconds));
  }
  /* A refusal that has a compliant route carries it alongside the refusal. The
   * public error body itself is left exactly as it was. */
  const passage = error && error.safePassage;
  return res.status(status).json(passage ? { ...body, safePassage: passage } : body);
}
