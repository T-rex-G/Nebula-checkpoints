/*
 * A session's own security: the upload scanner's state, the CSRF token every
 * mutation carries, a step-up grant for a sensitive action, and the sessions
 * an identity holds elsewhere, which can be ended.
 *
 * A step-up asks for proof made now, not proof the session already holds: the
 * active login typed exactly, and for a token account the token entered
 * again, checked with the provider. An App connection is checked against its
 * installation, and an OAuth session against the provider's current answer.
 * The grant names one action on one scope, is bound to the session and the
 * identity, and is spent on first use. Ending the other sessions closes their
 * live streams too.
 *
 * The guards are handed in under the names the route policy records.
 */
import { randomUUID } from 'node:crypto';
import type { Application, Request, RequestHandler, Response } from 'express';
import { member, type Fields } from '../../../platform/values/fields.ts';
import { createCsrfToken, createStepUpGrant, normalizeStepUpRequest, scopeHash } from '../../../platform/authorization/security-foundation.ts';
import type { ProviderSession } from './disconnect-answers.ts';

type Fail = (res: Response, error: unknown) => unknown;

export interface SecurityRouteDeps {
  readonly auth: RequestHandler;
  readonly accountAuth: RequestHandler;
  readonly providerSessionAccess: RequestHandler;
  readonly capabilityAccess: (feature: string) => RequestHandler;
  /* A hosted alpha's step-up names one repository the tester may use, and leaves the operation on the request. */
  readonly alphaStepUpRepositoryAccess: RequestHandler;
  readonly fail: Fail;
  /* The upload scanner's state. Handed in: it reads the file system, and domain code elsewhere loads this module's index. */
  scannerStatus(): Fields;
  /* The keys and lifetimes of the CSRF token and the step-up grant. */
  readonly csrf: { readonly secret: unknown; readonly ttlMs: number };
  readonly stepUp: { readonly secret: unknown; readonly ttlMs: number };
  requestSecurityContext(req: Request): Fields;
  sessionSecurityState(session: ProviderSession): Fields;
  setSession(req: Request, res: Response, session: ProviderSession): Promise<unknown>;
  providerIdentity(account: Fields): Promise<unknown>;
  /* The App installation behind a connection, from the broker. */
  getInstallation(installationId: unknown): Promise<unknown>;
  identityKey(account: unknown): string;
}

export interface SessionContainmentRouteDeps {
  readonly auth: RequestHandler;
  readonly fail: Fail;
  /* The sessions holding the same identity, when a database can list them. */
  sessionsForIdentity(req: Request): Promise<{ available: boolean; login?: unknown; rows?: readonly Fields[] }>;
  revokeContainedSessions(req: Request, sessionIds: readonly unknown[]): Promise<readonly unknown[]>;
  closeLiveSessions(sessionIds: readonly unknown[], reason: string): unknown;
}

const sessionOn = (req: Request): ProviderSession => Reflect.get(req, 'session') as ProviderSession;
const credentialOn = (req: Request): Fields => Reflect.get(req, 'gh') as Fields;
const sameLogin = (left: unknown, right: unknown): boolean => String(left || '').toLowerCase() === String(right || '').toLowerCase();

export function registerSecurityRoutes(app: Application, deps: SecurityRouteDeps): void {
  const { auth, accountAuth, providerSessionAccess, capabilityAccess, alphaStepUpRepositoryAccess, fail } = deps;

  app.get('/api/security/scanner-status', auth, capabilityAccess('upload-security'), (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const status = deps.scannerStatus();
    res.json({ ...status, note: member(member(status, 'yara'), 'configured') ? 'Configured YARA rules are applied to raw uploads before provider writes.' : 'Built-in bounded signatures are active. Configure NV_YARA_RULES_PATH and a trusted YARA binary to enable optional YARA rules.' });
  });

  app.get('/api/security/csrf', accountAuth, (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const now = Date.now();
    const token = createCsrfToken(deps.csrf.secret, deps.requestSecurityContext(req), { now, ttlMs: deps.csrf.ttlMs });
    res.json({ token, expiresAt: new Date(now + deps.csrf.ttlMs).toISOString() });
  });

  app.post('/api/security/step-up', providerSessionAccess, alphaStepUpRepositoryAccess, auth, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const body = (req.body || {}) as unknown;
      const action = member(body, 'action');
      const scope = member(body, 'scope');
      const confirm = member(body, 'confirm');
      const credential = member(body, 'credential');
      const account = credentialOn(req);
      if (String(confirm || '').trim() !== String(account.login || '')) {
        return res.status(400).json({ error: 'Type the active account login exactly to continue', code: 'STEP_UP_CONFIRMATION_REQUIRED' });
      }
      const authMethod = account.authMethod || 'token';
      let assurance;
      if (authMethod === 'token') {
        const freshCredential = String(credential || '').trim();
        if (!freshCredential || freshCredential.length > 1024) {
          return res.status(400).json({ error: 'Re-enter the active provider token', code: 'STEP_UP_CREDENTIAL_REQUIRED' });
        }
        let verified;
        try { verified = await deps.providerIdentity({ ...account, token: freshCredential }); }
        catch (error) {
          if (error && member(error, 'status') === 401) return res.status(401).json({ error: 'The provider token could not re-authenticate this account', code: 'STEP_UP_CREDENTIAL_INVALID' });
          throw error;
        }
        if (!sameLogin(member(verified, 'login'), account.login)) {
          return res.status(403).json({ error: 'The credential belongs to a different provider identity', code: 'STEP_UP_IDENTITY_MISMATCH' });
        }
        assurance = 'credential';
      } else if (authMethod === 'github-app') {
        const installation = await deps.getInstallation(account.installationId);
        if (!sameLogin(member(member(installation, 'account'), 'login'), account.login)) {
          return res.status(403).json({ error: 'The GitHub App installation no longer matches this identity', code: 'STEP_UP_IDENTITY_MISMATCH' });
        }
        assurance = 'github-app';
      } else {
        const verified = await deps.providerIdentity(account);
        if (!sameLogin(member(verified, 'login'), account.login)) {
          return res.status(403).json({ error: 'The active provider authorization no longer matches this identity', code: 'STEP_UP_IDENTITY_MISMATCH' });
        }
        assurance = 'oauth-session';
      }
      const operation = (Reflect.get(req, 'alphaStepUpOperation') as { action: string; scope: unknown } | undefined) || normalizeStepUpRequest(action, scope, {
        provider: account.provider || 'github', identityKey: deps.identityKey(account)
      });
      const now = Date.now();
      const expiresAt = now + deps.stepUp.ttlMs;
      const jti = randomUUID();
      const grant = createStepUpGrant(deps.stepUp.secret, {
        ...deps.requestSecurityContext(req), action: operation.action, scope: operation.scope, assurance
      }, { now, ttlMs: deps.stepUp.ttlMs, jti });
      (deps.sessionSecurityState(sessionOn(req)) as Record<string, unknown>).stepUp = {
        jti, action: operation.action, scopeHash: scopeHash(operation.scope), expiresAt, assurance
      };
      await deps.setSession(req, res, sessionOn(req));
      return res.json({ grant, action: operation.action, assurance, expiresAt: new Date(expiresAt).toISOString() });
    } catch (error) { return fail(res, error); }
  });
}

/* The sessions an identity holds elsewhere, and ending all of them but this one. */
export function registerSessionContainmentRoutes(app: Application, deps: SessionContainmentRouteDeps): void {
  const { auth, fail } = deps;

  app.get('/api/security/sessions', auth, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const inv = await deps.sessionsForIdentity(req);
      const account = credentialOn(req);
      if (!inv.available) return res.json({ available: false, login: account.login, sessions: [{ current: true, updated: new Date().toISOString(), provider: account.provider || 'github' }] });
      return res.json({
        available: true, login: inv.login,
        sessions: (inv.rows as readonly Fields[]).map(r => ({ current: r.current, updated: r.updated, provider: r.provider }))
      });
    } catch (e) { return fail(res, e); }
  });

  app.post('/api/security/revoke-others', auth, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (!(req.body && member(req.body, 'confirm'))) return res.status(400).json({ error: 'Confirmation required' });
      const inv = await deps.sessionsForIdentity(req);
      if (!inv.available) return res.json({ available: false, login: credentialOn(req).login, revoked: 0 });
      const ids = await deps.revokeContainedSessions(
        req,
        (inv.rows as readonly Fields[]).filter(r => !r.current).map(r => r.sid)
      );
      const streamsClosed = deps.closeLiveSessions(ids, 'session-revoked');
      return res.json({ available: true, login: inv.login, revoked: ids.length, streamsClosed });
    } catch (e) { return fail(res, e); }
  });
}
