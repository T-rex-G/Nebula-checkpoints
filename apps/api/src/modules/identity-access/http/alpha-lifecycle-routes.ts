/*
 * A tester's own data in the hosted alpha: the privacy notice, the feedback
 * they send, every provider disconnected at once, and everything deleted.
 *
 * Feedback carries only the fields the notice names; anything else is
 * refused, never stripped, so nothing a tester typed is kept by accident.
 * Deletion needs the exact confirmation, and a tester whose session has
 * already ended is let through on the sealed tester id alone, so they can
 * still remove what is theirs. Providers are disconnected and the deletion
 * request recorded first; the store then purges and scrubs, and only when it
 * has verified the provider cleanup are both cookies cleared. Anything the
 * store could not verify answers 409 with the blocks by code and count.
 *
 * The guards are handed in under the names the route policy records.
 */
import type { Application, NextFunction, Request, RequestHandler, Response } from 'express';
import { member, type Fields } from '../../../platform/values/fields.ts';
import { alphaRetentionPolicy, sanitizeFeedback } from '../domain/alpha-privacy.ts';
import type { AlphaSessions } from './alpha-sessions.ts';
import { providerDisconnectPending, type DisconnectProviderAccounts, type ProviderSession } from './disconnect-answers.ts';

type Fail = (res: Response, error: unknown) => unknown;

/* The privacy store's operations these routes use. */
export interface AlphaPrivacyOperations {
  recordFeedback(input: Fields): Promise<unknown>;
  createDeletionRequest(input: { testerId: unknown }): Promise<unknown>;
  purgeTester(input: { testerId: unknown }): Promise<unknown>;
}

export interface AlphaPrivacyRouteDeps {
  readonly config: { readonly enabled: boolean; readonly termsVersion: unknown };
  /* The privacy store, when the alpha is on. */
  readonly privacyStore: AlphaPrivacyOperations | null;
}

export interface AlphaFeedbackRouteDeps extends AlphaPrivacyRouteDeps {
  /* The build's version, as the server names it: feedback is recorded against it. */
  readonly releaseVersion: string;
}

export interface AlphaDisconnectRouteDeps extends AlphaPrivacyRouteDeps {
  readonly accountAuth: RequestHandler;
  readonly fail: Fail;
  readonly sessions: AlphaSessions;
  readonly disconnectProviderAccounts: DisconnectProviderAccounts;
  clearProviderSessionCookie(req: Request, res: Response): void;
}

const ALPHA_FEEDBACK_FIELDS: ReadonlySet<string> = new Set([
  'feature', 'correlationId', 'provider', 'capabilityStatus', 'errorCode', 'runtime'
]);
const FEEDBACK_UNAVAILABLE: ReadonlySet<string> = new Set(['ALPHA_TESTER_DELETING', 'ALPHA_TESTER_REVOKED', 'ALPHA_TESTER_UNAVAILABLE']);
const CLEANUP_BLOCK_CODE = /^[A-Z][A-Z0-9_]{1,79}$/;

/* The tester the alpha boundary admitted, and the session the account guard attached. */
const testerOf = (req: Request): unknown => member(Reflect.get(req, 'alpha'), 'testerId');
const sessionOn = (req: Request): ProviderSession => Reflect.get(req, 'session') as ProviderSession;
/* `String(error && error.code || '')`, as JavaScript reads it. */
const codeOf = (error: unknown): string => String(error && member(error, 'code') || '');

function alphaFeedbackInput(value: unknown): Fields {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).some(key => !ALPHA_FEEDBACK_FIELDS.has(key))
  ) {
    throw Object.assign(new Error('Feedback contains unsupported fields'), {
      status: 400,
      code: 'ALPHA_FEEDBACK_FIELDS_REJECTED'
    });
  }
  return value as Fields;
}

function alphaFeedbackFailure(res: Response, error: unknown): Response {
  const code = codeOf(error);
  if (code === 'ALPHA_FEEDBACK_FIELDS_REJECTED') {
    return res.status(400).json({
      error: 'Feedback contains unsupported fields',
      code
    });
  }
  if (FEEDBACK_UNAVAILABLE.has(code)) {
    return res.status(409).json({
      error: 'Feedback is unavailable for this alpha session',
      code: 'ALPHA_FEEDBACK_UNAVAILABLE'
    });
  }
  if (error instanceof TypeError) {
    return res.status(400).json({
      error: 'Feedback fields are invalid',
      code: 'ALPHA_FEEDBACK_INVALID'
    });
  }
  return res.status(500).json({ error: 'Feedback could not be recorded' });
}

function alphaDeletionBlocked(res: Response, result: unknown): Response {
  const blocks = result && member(result, 'cleanupBlocks');
  const cleanupBlocks = (Array.isArray(blocks) ? blocks : [])
    .filter(item => item && CLEANUP_BLOCK_CODE.test(String(member(item, 'code') || '')))
    .slice(0, 20)
    .map(item => Object.freeze({
      code: String(member(item, 'code')),
      count: Math.max(0, Math.min(Number(member(item, 'count')) || 0, 1000))
    }));
  return res.status(409).json({
    error: 'Alpha deletion is blocked until provider cleanup is verified',
    code: 'ALPHA_DELETION_BLOCKED',
    cleanupBlocks
  });
}

/* The privacy notice and the feedback a tester sends, both only while the alpha is on. */
export function registerAlphaPrivacyRoutes(app: Application, deps: AlphaFeedbackRouteDeps): void {
  app.get('/api/alpha/privacy', (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!deps.config.enabled) return res.status(404).json({ error: 'Not found' });
    return res.json({
      termsVersion: deps.config.termsVersion,
      retention: alphaRetentionPolicy(),
      retainedIntegrityMetadata: true,
      sourceContentUsedForAnalytics: false
    });
  });

  app.post('/api/alpha/feedback', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!deps.config.enabled) return res.status(404).json({ error: 'Not found' });
    try {
      const input = alphaFeedbackInput(req.body);
      const sanitized = sanitizeFeedback(
        { feature: input.feature },
        {
          releaseVersion: deps.releaseVersion,
          correlationId: input.correlationId,
          provider: input.provider,
          capabilityStatus: input.capabilityStatus,
          errorCode: input.errorCode,
          runtime: input.runtime,
          timestamp: new Date()
        }
      );
      if (!deps.privacyStore) throw new TypeError("Cannot read properties of null (reading 'recordFeedback')");
      const recorded = await deps.privacyStore.recordFeedback({
        testerId: testerOf(req),
        releaseVersion: deps.releaseVersion,
        correlationId: sanitized.correlationId,
        provider: sanitized.provider,
        feature: sanitized.feature,
        capabilityStatus: sanitized.capabilityStatus,
        errorCode: sanitized.errorCode,
        runtime: sanitized.runtime,
        occurredAt: sanitized.timestamp
      });
      return res.status(201).json({
        ok: member(recorded, 'recorded') === true,
        createdAt: member(recorded, 'createdAt')
      });
    } catch (error) {
      return alphaFeedbackFailure(res, error);
    }
  });
}

/* Every provider disconnected at once, and everything the tester left deleted. */
export function registerAlphaDisconnectRoutes(app: Application, deps: AlphaDisconnectRouteDeps): void {
  const { accountAuth, fail } = deps;
  const privacyStore = (): AlphaPrivacyOperations => {
    if (!deps.privacyStore) throw new TypeError("Cannot read properties of null (reading 'createDeletionRequest')");
    return deps.privacyStore;
  };

  function alphaDeletionConfirmation(req: Request, res: Response, next: NextFunction): unknown {
    if (!deps.config.enabled) return next();
    if (!req.body || member(req.body, 'confirm') !== 'DELETE ALPHA DATA') {
      return res.status(400).json({
        error: 'Exact deletion confirmation is required',
        code: 'ALPHA_DELETION_CONFIRMATION_REQUIRED'
      });
    }
    return next();
  }

  function alphaDeletionAuthentication(req: Request, res: Response, next: NextFunction): unknown {
    const alpha = Reflect.get(req, 'alpha');
    if (!deps.config.enabled || (alpha && member(alpha, 'deletionRecovery') === true)) {
      return next();
    }
    return accountAuth(req, res, next);
  }

  app.post('/api/alpha/providers/disconnect-all', accountAuth, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (!deps.config.enabled) return res.status(404).json({ error: 'Not found' });
      const cleanup = await deps.disconnectProviderAccounts(req, sessionOn(req).accounts);
      if (!cleanup.supportedComplete) return providerDisconnectPending(res, cleanup);
      const revocationGuidance = cleanup.results.map(result => result.revocationGuidance);
      deps.clearProviderSessionCookie(req, res);
      return res.json({ ok: true, revocationGuidance });
    } catch (error) { return fail(res, error); }
  });

  app.post('/api/alpha/delete', alphaDeletionConfirmation, alphaDeletionAuthentication, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (!deps.config.enabled) return res.status(404).json({ error: 'Not found' });
      const recovery = member(Reflect.get(req, 'alpha'), 'deletionRecovery') === true;
      if (!recovery) {
        const cleanup = await deps.disconnectProviderAccounts(req, sessionOn(req).accounts);
        if (!cleanup.complete) return providerDisconnectPending(res, cleanup);
        const deletion = await privacyStore().createDeletionRequest({
          testerId: testerOf(req)
        });
        if (member(deletion, 'status') === 'blocked') return alphaDeletionBlocked(res, deletion);
      }
      if (!deps.privacyStore) throw new TypeError("Cannot read properties of null (reading 'purgeTester')");
      const purge = await deps.privacyStore.purgeTester({ testerId: testerOf(req) });
      if (member(purge, 'status') !== 'complete' || !member(purge, 'providerCleanupVerified')) {
        return alphaDeletionBlocked(res, purge);
      }
      deps.clearProviderSessionCookie(req, res);
      const providerCookie = res.getHeader('Set-Cookie');
      deps.sessions.setCookie(res, '', 0);
      const alphaCookie = res.getHeader('Set-Cookie');
      res.setHeader('Set-Cookie', [providerCookie, alphaCookie] as string[]);
      return res.json({
        ok: true,
        ...Object(purge)
      });
    } catch (error) { return fail(res, error); }
  });
}
