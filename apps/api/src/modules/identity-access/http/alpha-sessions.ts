/*
 * The hosted alpha's access session as HTTP meets it: the access cookie that
 * carries a sealed session id, the session it names read from the access
 * store, the boundary that admits an API request only with one, and the answer
 * each refusal gets.
 *
 * The boundary lets through only the few API routes a visitor needs before an
 * invitation (the version, configuration and capabilities, and the alpha's
 * own status and redemption). A request to delete one's alpha data is let
 * through on the sealed tester id alone, so a tester whose session has
 * already ended can still remove what is theirs. A store that cannot be read
 * is the database's fault, not the tester's: it answers 503 and keeps the
 * cookie. It used to clear it, and an invitation is redeemed once, so a
 * database waking from idle signed testers out for good. Any other refusal
 * clears the cookie.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { MUTATION_ID } from '../../../../../../packages/contracts/src/ids.ts';
import { member, type Fields } from '../../../platform/values/fields.ts';
import { AlphaAccessOperationalError } from '../persistence/alpha-access-store.ts';

export const ALPHA_COOKIE = 'nv_alpha_access';
const ALPHA_COOKIE_MAX_AGE = 7 * 24 * 60 * 60;
/* A tester id: an RFC 9562 UUID of versions 1 to 5, the format the ids contract names for a governed mutation. */
const TESTER_ID = MUTATION_ID;
const ALPHA_PUBLIC_API: ReadonlySet<string> = new Set([
  'GET /api/version',
  'GET /api/config',
  'GET /api/capabilities',
  'GET /api/alpha/status',
  'POST /api/alpha/redeem'
]);
const ALPHA_SESSION_HTTP_CODES: ReadonlySet<string> = new Set([
  'ALPHA_ACCESS_REQUIRED',
  'ALPHA_SESSION_EXPIRED',
  'ALPHA_ACCESS_REVOKED'
]);
const ALPHA_REDEMPTION_HTTP_CODES: ReadonlySet<string> = new Set([
  'ALPHA_INVITE_REJECTED',
  'ALPHA_REDEMPTION_LOCKED'
]);
const SESSION_REFUSALS: Readonly<Record<string, { readonly status: number; readonly error: string }>> = Object.freeze({
  ALPHA_ACCESS_REQUIRED: { status: 401, error: 'Alpha access is required' },
  ALPHA_SESSION_EXPIRED: { status: 401, error: 'Alpha session expired' },
  ALPHA_ACCESS_REVOKED: { status: 403, error: 'Alpha access was revoked' }
});

export interface AlphaSessionView {
  readonly testerLabel: string;
  readonly repositoryScopes: string[];
  readonly termsVersion: string;
  readonly expiresAt: string;
}

export interface AlphaSessionDeps {
  /* The alpha's configuration: whether it is on, its mode and the terms a tester accepts. */
  readonly config: { readonly enabled: boolean; readonly mode: unknown; readonly termsVersion: unknown };
  /* The access store, when the alpha is on. */
  readonly store: { readSession(sessionId: unknown): Promise<unknown> } | null;
  /* The server's sealed-cookie codec, and its cookie reader. */
  seal(value: unknown): string;
  unseal(text: string): unknown;
  getCookie(req: Request, name: string): string | null | undefined;
  /* Where the boundary leaves the admitted session's id on the request. */
  readonly sessionIdKey: symbol;
  /* Whether cookies are marked Secure: asked each time, as the environment is. */
  production(): boolean;
}

export interface AlphaSessions {
  readonly cookieName: string;
  setCookie(res: Response, value: string, maxAge?: number): void;
  operationalFailure(res: Response): Response;
  storeUnavailable(error: unknown): boolean;
  /* Whether the error is one of the session's own refusals: absent, expired or revoked. */
  sessionRefusal(error: unknown): boolean;
  testerIdValid(testerId: string): boolean;
  unavailableFailure(res: Response): Response;
  sessionFailure(res: Response, error: unknown): Response;
  redemptionFailure(res: Response, error: unknown): Response;
  sessionView(session: unknown): AlphaSessionView;
  requestKey(req: Request): string;
  readRequestSession(req: Request): Promise<{ readonly sessionId: string; readonly session: AlphaSessionView & { readonly testerId: string } }>;
  readDeletionRecovery(req: Request): { readonly testerId: string; readonly deletionRecovery: true } | null;
  readonly alphaAccessBoundary: RequestHandler;
  statusBody(session?: AlphaSessionView | null): Record<string, unknown>;
}

/* `String(error && error.code || '')`, as JavaScript reads it. */
function codeOf(error: unknown): string {
  return String(error && member(error, 'code') || '');
}

export function createAlphaSessions(deps: AlphaSessionDeps): AlphaSessions {
  function setCookie(res: Response, value: string, maxAge = ALPHA_COOKIE_MAX_AGE): void {
    const secure = deps.production() ? '; Secure' : '';
    res.setHeader(
      'Set-Cookie',
      `${ALPHA_COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`
    );
  }

  function operationalFailure(res: Response): Response {
    return res.status(500).json({
      error: 'Alpha access operation could not be completed'
    });
  }

  function storeUnavailable(error: unknown): boolean {
    return error instanceof AlphaAccessOperationalError;
  }

  function sessionRefusal(error: unknown): boolean {
    return ALPHA_SESSION_HTTP_CODES.has(codeOf(error));
  }

  function testerIdValid(testerId: string): boolean {
    return TESTER_ID.test(testerId);
  }

  function unavailableFailure(res: Response): Response {
    res.setHeader('Retry-After', '5');
    return res.status(503).json({
      error: 'Alpha access is temporarily unavailable. Try again in a few seconds.',
      code: 'ALPHA_ACCESS_UNAVAILABLE'
    });
  }

  function sessionFailure(res: Response, error: unknown): Response {
    const code = codeOf(error);
    const refusal = ALPHA_SESSION_HTTP_CODES.has(code) ? SESSION_REFUSALS[code] : undefined;
    if (!refusal) return operationalFailure(res);
    return res.status(refusal.status).json({ error: refusal.error, code });
  }

  function redemptionFailure(res: Response, error: unknown): Response {
    /* Nothing was spent: the redemption is one transaction, and it did not commit. */
    if (storeUnavailable(error)) return unavailableFailure(res);
    const code = codeOf(error);
    if (!ALPHA_REDEMPTION_HTTP_CODES.has(code)) return operationalFailure(res);
    return res.status(code === 'ALPHA_REDEMPTION_LOCKED' ? 429 : 403).json({
      error: 'Invitation could not be redeemed',
      code
    });
  }

  function sessionView(session: unknown): AlphaSessionView {
    if (
      !session
      || typeof session !== 'object'
      || typeof member(session, 'testerLabel') !== 'string'
      || !Array.isArray(member(session, 'repositoryScopes'))
      || typeof member(session, 'termsVersion') !== 'string'
      || typeof member(session, 'expiresAt') !== 'string'
    ) {
      throw new TypeError('alpha access store returned an invalid session');
    }
    const fields = session as Fields;
    return {
      testerLabel: fields.testerLabel as string,
      repositoryScopes: [...(fields.repositoryScopes as string[])],
      termsVersion: fields.termsVersion as string,
      expiresAt: fields.expiresAt as string
    };
  }

  function requestPath(req: Request): string {
    return String(req.originalUrl || req.url || '').split('?', 1)[0] ?? '';
  }

  function requestKey(req: Request): string {
    return `${String(req.method || '').toUpperCase()} ${requestPath(req)}`;
  }

  async function readRequestSession(req: Request): Promise<{ readonly sessionId: string; readonly session: AlphaSessionView & { readonly testerId: string } }> {
    const payload = deps.unseal(deps.getCookie(req, ALPHA_COOKIE) || '');
    const alphaSid = payload ? member(payload, 'alphaSid') : undefined;
    if (!payload || typeof alphaSid !== 'string' || !alphaSid) {
      throw Object.assign(new Error('Alpha access is required'), {
        status: 401,
        code: 'ALPHA_ACCESS_REQUIRED'
      });
    }
    if (!deps.store) throw new TypeError("Cannot read properties of null (reading 'readSession')");
    const stored = await deps.store.readSession(alphaSid);
    const testerId = String(stored && member(stored, 'testerId') || '').toLowerCase();
    if (!testerIdValid(testerId)) {
      throw new TypeError('alpha access store returned an invalid tester id');
    }
    if (
      member(payload, 'testerId') !== undefined
      && String(member(payload, 'testerId') || '').toLowerCase() !== testerId
    ) {
      throw new TypeError('alpha access cookie tester does not match its session');
    }
    return {
      sessionId: alphaSid,
      session: { ...sessionView(stored), testerId }
    };
  }

  function readDeletionRecovery(req: Request): { readonly testerId: string; readonly deletionRecovery: true } | null {
    if (
      requestKey(req) !== 'POST /api/alpha/delete'
      || !req.body
      || member(req.body, 'confirm') !== 'DELETE ALPHA DATA'
    ) return null;
    const payload = deps.unseal(deps.getCookie(req, ALPHA_COOKIE) || '');
    const testerId = String(payload && member(payload, 'testerId') || '').toLowerCase();
    if (!testerIdValid(testerId)) {
      return null;
    }
    return Object.freeze({ testerId, deletionRecovery: true as const });
  }

  async function alphaAccessBoundary(req: Request, res: Response, next: NextFunction): Promise<unknown> {
    if (!deps.config.enabled || ALPHA_PUBLIC_API.has(requestKey(req))) {
      return next();
    }
    try {
      const access = await readRequestSession(req);
      Reflect.set(req, 'alpha', access.session);
      Reflect.set(req, deps.sessionIdKey, access.sessionId);
      return next();
    } catch (error) {
      const recovery = readDeletionRecovery(req);
      if (recovery) {
        Reflect.set(req, 'alpha', recovery);
        return next();
      }
      if (storeUnavailable(error)) return unavailableFailure(res);
      setCookie(res, '', 0);
      return sessionFailure(res, error);
    }
  }

  function statusBody(session: AlphaSessionView | null = null): Record<string, unknown> {
    return {
      mode: deps.config.mode,
      authenticated: !!session,
      termsVersion: deps.config.termsVersion,
      testerLabel: session ? session.testerLabel : null,
      repositoryScopes: session ? [...session.repositoryScopes] : [],
      expiresAt: session ? session.expiresAt : null
    };
  }

  return {
    cookieName: ALPHA_COOKIE, setCookie, operationalFailure, storeUnavailable, sessionRefusal, testerIdValid,
    unavailableFailure, sessionFailure, redemptionFailure, sessionView, requestKey, readRequestSession, readDeletionRecovery, alphaAccessBoundary, statusBody
  };
}
