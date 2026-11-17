/*
 * Security headers. The CSP's frame-ancestors is what modern browsers obey;
 * X-Frame-Options says the same to the ones that predate it. The page opens
 * nothing it needs to talk back to, so it keeps a browsing context group of
 * its own (COOP), serves nothing another origin may embed (CORP), and asks
 * for its own agent cluster. Every powerful feature the product never uses
 * is switched off rather than left to a default.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Environment } from './environment.ts';

export const PERMISSIONS_POLICY = [
  'accelerometer=()', 'autoplay=()', 'bluetooth=()', 'browsing-topics=()', 'camera=()', 'display-capture=()',
  'geolocation=()', 'gyroscope=()', 'hid=()', 'magnetometer=()', 'microphone=()', 'midi=()', 'payment=()',
  'publickey-credentials-get=()', 'serial=()', 'usb=()', 'xr-spatial-tracking=()'
].join(', ');

export function contentSecurityPolicy(production: boolean): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data: https://*.githubusercontent.com https://*.gravatar.com",
    "media-src 'self'",
    "connect-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-src 'none'",
    "manifest-src 'self'",
    "frame-ancestors 'none'",
    ...(production ? ['upgrade-insecure-requests'] : [])
  ].join('; ');
}

export function securityHeaders(env: Environment): RequestHandler {
  return function securityHeadersStep(req: Request, res: Response, next: NextFunction): void {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', PERMISSIONS_POLICY);
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Origin-Agent-Cluster', '?1');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    if (env.NODE_ENV === 'production') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('Content-Security-Policy', contentSecurityPolicy(env.NODE_ENV === 'production'));
    next();
  };
}
