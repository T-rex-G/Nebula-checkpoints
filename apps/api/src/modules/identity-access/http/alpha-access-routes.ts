/*
 * The hosted alpha's front door: the boundary every API request after it
 * passes, the status a visitor's page reads, an invitation redeemed for an
 * access session, and the session ended.
 *
 * The status says whether the alpha is on and, for a valid session, whose it
 * is and when it ends; an unreadable store answers 503 and keeps the cookie,
 * and any other trouble with the cookie clears it and answers as signed out.
 * A redemption is one transaction in the store: it either issues a session,
 * sealed into the cookie with the tester it belongs to, or spends nothing.
 */
import type { Application, Request, Response } from 'express';
import { member } from '../../../platform/values/fields.ts';
import type { AlphaSessions } from './alpha-sessions.ts';

export interface AlphaAccessRouteDeps {
  readonly sessions: AlphaSessions;
  readonly config: { readonly enabled: boolean };
  /* The access store, when the alpha is on. */
  readonly store: { redeemInvite(input: unknown): Promise<unknown> } | null;
  /* The server's sealed-cookie codec and its cookie reader. */
  seal(value: unknown): string;
  getCookie(req: Request, name: string): string | null | undefined;
}

export function registerAlphaAccessRoutes(app: Application, deps: AlphaAccessRouteDeps): void {
  const { sessions } = deps;
  const { alphaAccessBoundary } = sessions;

  app.use('/api', alphaAccessBoundary);

  app.get('/api/alpha/status', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!deps.config.enabled || !deps.getCookie(req, sessions.cookieName)) {
      return res.json(sessions.statusBody());
    }
    try {
      const access = await sessions.readRequestSession(req);
      return res.json(sessions.statusBody(access.session));
    } catch (error) {
      if (sessions.storeUnavailable(error)) return sessions.unavailableFailure(res);
      sessions.setCookie(res, '', 0);
      if (!sessions.sessionRefusal(error)) {
        return sessions.operationalFailure(res);
      }
      return res.json(sessions.statusBody());
    }
  });

  app.post('/api/alpha/redeem', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!deps.config.enabled || !deps.store) {
      return res.status(404).json({ error: 'Not found' });
    }
    try {
      const redeemed = await deps.store.redeemInvite({
        code: req.body && member(req.body, 'code'),
        termsVersion: req.body && member(req.body, 'acceptedTermsVersion'),
        ip: req.ip
      });
      const session = sessions.sessionView({
        ...Object(member(redeemed, 'tester')),
        expiresAt: member(redeemed, 'expiresAt')
      });
      const sessionId = member(redeemed, 'sessionId');
      if (typeof sessionId !== 'string' || !sessionId) {
        throw new TypeError('alpha access store returned an invalid session id');
      }
      const tester = member(redeemed, 'tester');
      const testerId = String(tester && member(tester, 'testerId') || '').toLowerCase();
      if (!sessions.testerIdValid(testerId)) {
        throw new TypeError('alpha access store returned an invalid tester id');
      }
      sessions.setCookie(res, deps.seal({ alphaSid: sessionId, testerId }));
      return res.json({
        ok: true,
        testerLabel: session.testerLabel,
        repositoryScopes: session.repositoryScopes,
        expiresAt: session.expiresAt
      });
    } catch (error) {
      return sessions.redemptionFailure(res, error);
    }
  });

  app.post('/api/alpha/end', (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    sessions.setCookie(res, '', 0);
    res.json({ ok: true });
  });
}
