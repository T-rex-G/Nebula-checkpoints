/* One structured line per API request, written once its answer has gone. */
import type { NextFunction, Request, RequestHandler, Response } from 'express';

export function structuredLogging(write: (line: string) => void = line => { console.log(line); }): RequestHandler {
  return function structuredLoggingStep(req: Request, res: Response, next: NextFunction): void {
    const t0 = Date.now();
    res.on('finish', () => {
      if (req.path.startsWith('/api/')) write(JSON.stringify({
        t: new Date().toISOString(), correlationId: res.locals.correlationId,
        m: req.method, p: req.path, s: res.statusCode, ms: Date.now() - t0
      }));
    });
    next();
  };
}
