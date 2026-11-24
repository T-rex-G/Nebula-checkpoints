/* Browser request boundary: an unsafe API call must be intentional and same-origin. */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { APP_HEADER, APP_HEADER_VALUE } from '../../../../../packages/contracts/src/api-envelope.ts';
import type { Environment } from './environment.ts';

export const SAFE_API_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

export function apiSameOrigin(env: Environment): RequestHandler {
  return function apiSameOriginStep(req: Request, res: Response, next: NextFunction): void {
    if (SAFE_API_METHODS.has(req.method)) return next();
    if (req.headers[APP_HEADER] !== APP_HEADER_VALUE) {
      res.status(403).json({ error: 'Missing app header', code: 'APP_HEADER_REQUIRED' });
      return;
    }
    const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
    if (fetchSite === 'cross-site') {
      res.status(403).json({ error: 'Cross-site API requests are not allowed', code: 'CROSS_SITE_REQUEST' });
      return;
    }
    const origin = String(req.headers.origin || '').trim();
    if (origin) {
      const allowed = new Set([`${req.protocol}://${req.get('host')}`]);
      for (const configured of [env.PUBLIC_BASE_URL, env.RENDER_EXTERNAL_URL]) {
        try { if (configured) allowed.add(new URL(configured).origin); } catch {}
      }
      let parsedOrigin = '';
      try { parsedOrigin = new URL(origin).origin; } catch {}
      if (!parsedOrigin || !allowed.has(parsedOrigin)) {
        res.status(403).json({ error: 'Request origin does not match Nebulaverse-X', code: 'CROSS_SITE_REQUEST' });
        return;
      }
    }
    next();
  };
}
