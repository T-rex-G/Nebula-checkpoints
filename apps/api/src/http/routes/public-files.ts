/*
 * The files every visitor may read: where to report a vulnerability (RFC
 * 9116) and what crawlers may index, the home-screen icon iOS asks for at the
 * root, the page and its service worker, and the page again for any route the
 * browser application owns.
 *
 * The page and the service worker are the build's own files, read once at
 * startup; the build has already removed their source comments and named
 * every script and stylesheet by its content.
 */
import path from 'node:path';
import type { Application, Request, Response } from 'express';

export interface WebBuildFiles {
  readonly index: string;
  readonly serviceWorker: string;
}

export interface PublicFileRouteDeps {
  /* The security contact, as configured when the file is asked for. */
  securityContact(): string;
  /* The public origin the deployment was given, if any, as configured when the file is asked for. */
  configuredOrigin(): string;
  /* Where the built browser application is served from. */
  readonly webRoot: string;
}

/* The deployment's own origin when it is configured over HTTPS, and otherwise the one the request arrived on. */
function publicOrigin(req: Request, configuredOrigin: string): string {
  const configured = configuredOrigin.replace(/\/+$/, '');
  return /^https:\/\//.test(configured) ? configured : `${req.protocol}://${String(req.get('host'))}`;
}

/*
 * The contact defaults to the repository's private advisory form and can be
 * pointed elsewhere; Expires is always six months out, so the file never
 * lapses into a stale promise.
 */
export function registerPublicFileRoutes(app: Application, deps: PublicFileRouteDeps): void {
  app.get('/.well-known/security.txt', (req: Request, res: Response) => {
    const contact = deps.securityContact();
    const expires = new Date(Date.now() + 182 * 24 * 60 * 60 * 1000);
    expires.setUTCHours(0, 0, 0, 0);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.type('text/plain').send([
      `Contact: ${contact}`,
      `Expires: ${expires.toISOString()}`,
      'Preferred-Languages: en',
      `Canonical: ${publicOrigin(req, deps.configuredOrigin())}/.well-known/security.txt`,
      ''
    ].join('\n'));
  });
  app.get('/robots.txt', (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.type('text/plain').send('User-agent: *\nAllow: /$\nDisallow: /api/\n');
  });

  /* iOS requests these at the root by convention when adding to home screen. */
  for (const alias of ['/apple-touch-icon.png', '/apple-touch-icon-precomposed.png']) {
    app.get(alias, (req: Request, res: Response) => res.sendFile(path.join(deps.webRoot, 'assets', 'apple-touch-icon.png')));
  }
}

export function registerWebShellRoutes(app: Application, deps: { readonly webBuild: WebBuildFiles }): void {
  app.get(['/','/index.html'], (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(deps.webBuild.index);
  });
  app.get('/sw.js', (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Service-Worker-Allowed', '/');
    res.type('application/javascript').send(deps.webBuild.serviceWorker);
  });
}

/*
 * Last of all routes. An unknown API path is a 404. The page is served for a
 * route, not for a file: a path with a dot segment or an extension that the
 * static server did not find is a file that does not exist -- /.env,
 * /.git/HEAD, /package.json -- and answering it with the app's own page at 200
 * reads, to every scanner, as the file being there.
 */
export function registerShellFallback(app: Application, deps: { readonly webBuild: WebBuildFiles }): void {
  app.get('*', (req: Request, res: Response) => {
    if (req.path.startsWith('/api/')) { res.status(404).json({ error: 'Not found' }); return; }
    if (/(^|\/)\.[^/]*|\.[a-z0-9]{1,8}$/i.test(req.path)) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(404).type('text/plain').send('Not found\n');
      return;
    }
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(deps.webBuild.index);
  });
}
