/* One safe request identity, shared by the logs and the errors a tester sees. */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { CORRELATION_HEADER } from '../../../../../packages/contracts/src/api-envelope.ts';
import { isCorrelationId } from '../../../../../packages/contracts/src/ids.ts';
import { createCorrelationId } from '../errors.ts';

export function correlationId(): RequestHandler {
  return function correlationIdStep(req: Request, res: Response, next: NextFunction): void {
    const supplied = String(req.headers[CORRELATION_HEADER] || '');
    const id = isCorrelationId(supplied) ? supplied : createCorrelationId();
    res.locals.correlationId = id;
    res.setHeader(CORRELATION_HEADER, id);
    next();
  };
}
