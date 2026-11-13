/*
 * Signing in with GitHub's OAuth app: away to GitHub with a state held in a
 * short-lived cookie, and back with a code exchanged for a token.
 *
 * The routes exist only when the deployment names an OAuth client. The
 * exchange goes through the guarded transport and refuses a redirect, so the
 * client secret is only ever sent to GitHub. Every failure returns to the
 * application with a reason it can show, and clears the state cookie, because
 * an authorization code is single-use and a second attempt must start a fresh
 * exchange.
 */
import { randomBytes } from 'node:crypto';
import type { Application, Request, Response } from 'express';
import { member } from '../../../platform/values/fields.ts';

export interface OAuthRouteDeps {
  /* The deployment's OAuth client; an empty id means OAuth is not configured. */
  readonly oauth: { readonly clientId: string; readonly clientSecret: string };
  /* Whether cookies are marked Secure: asked each time, as the environment is. */
  production(): boolean;
  getCookie(req: Request, name: string): string | null | undefined;
  /* The guarded outbound transport. */
  fetch(url: string, init: RequestInit): Promise<globalThis.Response>;
  gh(account: unknown, path: string): Promise<unknown>;
  addAccount(req: Request, res: Response, token: string, user: unknown, provider: string, baseUrl: string, options: { authMethod: string }): Promise<unknown>;
}

export function registerOAuthRoutes(app: Application, deps: OAuthRouteDeps): void {
  const secure = (): string => (deps.production() ? '; Secure' : '');

  app.get('/api/oauth/login', (req: Request, res: Response) => {
    if (!deps.oauth.clientId) return res.status(404).json({ error: 'OAuth not configured' });
    const stateVal = randomBytes(16).toString('hex');
    res.setHeader('Set-Cookie', `nv_oauth=${stateVal}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600${secure()}`);
    const scope = req.query.permission === 'repository-delete' ? 'repo delete_repo' : 'repo';
    return res.redirect(`https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(deps.oauth.clientId)}&scope=${encodeURIComponent(scope)}&state=${stateVal}`);
  });

  app.get('/api/oauth/callback', async (req: Request, res: Response) => {
    /*
     * Every failure here used to end on a bare page: a sentence of unstyled text
     * on white, no navigation, nothing to press. The only way back into the
     * application was to edit the address bar by hand, which is not a recovery
     * a reader on a phone should be asked to perform.
     *
     * So a failed sign-in returns to the application and says what happened. The
     * state cookie is cleared on the way out, because a second attempt must start
     * a fresh exchange: an authorization code is single-use, and retrying with a
     * spent one is itself one of the failures being reported.
     */
    const abandon = (reason: unknown): void => {
      res.append('Set-Cookie', `nv_oauth=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure()}`);
      return res.redirect(`/?oauth=${encodeURIComponent(String(reason || 'failed').slice(0, 64))}`);
    };
    try {
      const state = deps.getCookie(req, 'nv_oauth');
      if (!req.query.code || !state || req.query.state !== state) return abandon('state_mismatch');
      const tr = await deps.fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ client_id: deps.oauth.clientId, client_secret: deps.oauth.clientSecret, code: req.query.code }),
        redirect: 'error'
      });
      /*
       * Read the body once, as text, and parse it here. The provider answers this
       * endpoint with an HTML page when it refuses the request outright rather
       * than the exchange -- a rate limit, an unrecognised client, an outage --
       * and handing that to a JSON parser throws "Unexpected token '<'", which
       * then surfaced as the literal text of the failure page.
       */
      const raw = await tr.text();
      let td: unknown;
      try { td = JSON.parse(raw); }
      catch { return abandon('provider_unreadable'); }
      /* The provider names its own refusal; an expired or already-spent code
         arrives here as bad_verification_code rather than as a bare failure. */
      const token = member(td, 'access_token');
      if (!token) return abandon(member(td, 'error') || 'exchange_failed');
      const user = await deps.gh(token, '/user');
      await deps.addAccount(req, res, member(td, 'access_token') as string, user, 'github', '', { authMethod: 'oauth' });
      /*
       * Marked as entered. Signing in with the provider is a full page trip --
       * away to GitHub and back to a fresh load -- and the front door is where a
       * fresh load begins. With entry open the door stays put by design, so a
       * reader who had just finished signing in was returned to it and asked to
       * continue to sign in. The marker says this load is the far side of a
       * completed sign-in, not a new arrival, and carries no identity of its
       * own: the session cookie is what admits anyone.
       */
      return res.redirect('/?entered=1');
    } catch { return abandon('unexpected'); }
  });
}
