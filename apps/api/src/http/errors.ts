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
