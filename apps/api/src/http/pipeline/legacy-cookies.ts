/*
 * Owner cookies from before provider authentication, retired on sight.
 *
 * Each is cleared wherever it still arrives and never adopted: a session the
 * product no longer issues says nothing about who is asking.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Environment } from './environment.ts';

const RETIRED_COOKIES: readonly (readonly [name: string, scope: string])[] = [
  ['nv_workspace_session', '/api/workspace'],
  ['nv_workspace_challenge', '/api/workspace'],
  ['nv_workspace_oauth', '/api/workspace'],
  ['nv_workspace_oauth_intent', '/']
];

export function retireLegacyCookies(env: Environment): RequestHandler {
  return function retireLegacyCookiesStep(req: Request, res: Response, next: NextFunction): void {
    const cookies = String(req.headers.cookie || '').split(';').map(item => item.trim());
    for (const [name, scope] of RETIRED_COOKIES) {
      if (cookies.some(item => item.startsWith(`${name}=`))) {
        res.clearCookie(name, { path: scope, httpOnly: true, secure: env.NODE_ENV === 'production' });
      }
    }
    next();
  };
}
