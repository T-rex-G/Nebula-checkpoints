/*
 * Every API answer is no-store, except a private offline read.
 *
 * Private offline reads are opt-in and bound to the authenticated session,
 * provider identity, and repository. The binding is decided when the status
 * line is written, because only then is the answer known to be a 200.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { OFFLINE_REPO_HEADER, OFFLINE_SCOPE_HEADER } from '../../../../../packages/contracts/src/offline-cache-policy.ts';

export interface OfflineBinding {
  readonly scope: string;
  readonly repoKey: string;
}

export function apiNoStore(offlineBinding: (req: Request) => OfflineBinding | null): RequestHandler {
  return function apiNoStoreStep(req: Request, res: Response, next: NextFunction): void {
    res.setHeader('Cache-Control', 'no-store');
    const writeHead = res.writeHead;
    res.writeHead = function writeOfflineCacheHeaders(this: Response, ...args: unknown[]): Response {
      const responseStatus = Number(args[0] || res.statusCode);
      const binding = responseStatus === 200 ? offlineBinding(req) : null;
      if (binding) {
        res.setHeader(OFFLINE_SCOPE_HEADER, binding.scope);
        res.setHeader(OFFLINE_REPO_HEADER, binding.repoKey);
        res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
        for (const name of ['Cookie', OFFLINE_SCOPE_HEADER, OFFLINE_REPO_HEADER]) res.vary(name);
      } else {
        res.removeHeader(OFFLINE_SCOPE_HEADER);
        res.removeHeader(OFFLINE_REPO_HEADER);
        res.setHeader('Cache-Control', 'no-store');
      }
      const written: Response = Reflect.apply(writeHead, this, args);
      return written;
    };
    next();
  };
}
