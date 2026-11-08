/*
 * Pulsar's live-event routes: whether a repository's verified live events are
 * connected, connecting and disconnecting the provider webhook that feeds them,
 * reading the stored events a page at a time, and the stream that carries new
 * ones as they are verified.
 *
 * A connection is a provider webhook with a secret only this server holds,
 * recorded against the identity that connected it. In the invite-only alpha a
 * webhook is also claimed by the tester, so deleting the tester's data can find
 * and remove it; disconnecting then runs through the alpha cleanup record and
 * answers 202 until the provider confirms the webhook is gone, rather than
 * forgetting a webhook that may still be delivering.
 *
 * The guards are handed in under the names the route policy records, and the
 * routes are registered in its order (test/oracles/route-policy.json).
 */
import crypto from 'node:crypto';
import type { Application, Request, RequestHandler, Response } from 'express';
import type { Queryable } from '../../../platform/persistence/queryable.ts';
import { member, read } from '../../../platform/values/fields.ts';
import { decodeEventCursor, encodeEventCursor } from '../domain/event-cursor.ts';
import { writeLiveClient } from '../application/live-stream.ts';
import type { LiveHub } from '../application/live-hub.ts';

/* The invite-only alpha's records of a tester's provider webhooks. */
export interface AlphaWebhookRecords {
  claimProviderWebhookOwnership(input: { testerId: unknown; identityKey: string; provider: 'github'; resourceKeyHash: unknown }): Promise<unknown>;
  createCleanupTask(input: { testerId: unknown; identityKey: string; provider: 'github'; resourceType: 'provider-webhook'; resourceKeyHash: string; reasonCode: '' }): Promise<unknown>;
  inspectProviderWebhookCleanup(input: { testerId: unknown; identityKey: string; provider: 'github'; cleanupId: unknown; resourceKeyHash: string }): Promise<unknown>;
  completeProviderWebhookCleanup(input: { testerId: unknown; identityKey: string; provider: 'github'; cleanupId: unknown; resourceKeyHash: string; providerVerifiedAbsent: boolean }): Promise<unknown>;
}

export interface LiveEventRouteDeps {
  readonly providerSessionAccess: RequestHandler;
  readonly alphaRepositoryAccess: RequestHandler;
  readonly capabilityAccess: (feature: string) => RequestHandler;
  readonly auth: RequestHandler;
  readonly mutationContext: (action: string) => RequestHandler;
  /* The provider account the session is acting as. */
  readonly account: (req: Request) => unknown;
  readonly fail: (res: Response, error: unknown) => unknown;
  gh(account: unknown, apiPath: string, options?: { readonly method?: string; readonly body?: unknown }): Promise<unknown>;
  dbReady(): Promise<unknown>;
  pool(): Queryable;
  identityKey(account: unknown): string;
  /* Whether a database is configured at all. */
  readonly databaseConfigured: boolean;
  /* This deployment's public address, for the provider to deliver to. */
  publicBase(req: Request): string;
  /* Seals a secret for storage under the server's session key. */
  seal(value: unknown): string;
  /* The evidence ledger: a repository's key, its append, and the actor a record retains. */
  scopedEvidenceKey(provider: unknown, owner: unknown, repo: unknown, identity: unknown): string;
  appendEvidence(key: string, kind: string, subject: unknown, payload: unknown): Promise<unknown>;
  retainedActor(req: Request): unknown;
  /* The provider resource key the alpha records a webhook by, and the provider authority it is under. */
  providerResourceKeyHash(input: { provider: 'github'; authority: unknown; resourceType: 'provider-webhook'; resourceReference: unknown }): string;
  providerAuthority(account: unknown): unknown;
  /* The invite-only alpha: whether it is on, the tester and alpha session a request carries, and its records. */
  readonly alphaEnabled: boolean;
  alphaTesterId(req: Request): unknown;
  alphaSessionId(req: Request): unknown;
  readAlphaSession(sessionId: unknown, options: { readonly touch: false }): Promise<unknown>;
  readonly alphaWebhooks: AlphaWebhookRecords | null;
  /* The provider session a request belongs to, if it is stored. */
  sessionSid(req: Request): unknown;
  /* The open streams. */
  readonly hub: LiveHub;
}

const WEBHOOK_EVENTS = ['push', 'pull_request', 'workflow_run', 'issues', 'release', 'create', 'delete', 'deployment', 'deployment_status', 'repository_vulnerability_alert'];

/* A row of a query's answer, read as `r.rows[0]` was. */
function firstRow(result: unknown): unknown {
  return member(member(result, 'rows'), '0');
}

export function registerLiveEventRoutes(app: Application, deps: LiveEventRouteDeps): void {
  const { providerSessionAccess, alphaRepositoryAccess, capabilityAccess, auth, mutationContext, account, fail } = deps;
  const repository = (req: Request): string => `/repos/${req.params.owner}/${req.params.repo}`;
  const alphaRecords = (): AlphaWebhookRecords => {
    const records = deps.alphaWebhooks;
    if (!records) throw new TypeError('the alpha records are not configured');
    return records;
  };

  app.get('/api/repo/:owner/:repo/live-events/status', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('live-events'), auth, async (req: Request, res: Response) => {
    try {
      const session = account(req);
      if ((member(session, 'provider') || 'github') !== 'github') { res.json({ available: false, connected: false, reason: 'GitHub-only in v5.2' }); return; }
      if (!(await deps.dbReady())) { res.json({ available: false, connected: false, reason: 'Connect the existing Neon DATABASE_URL to persist verified events' }); return; }
      const r = await deps.pool().query(
        `SELECT hook_id,provider_hook_id,active,created_at,updated_at FROM nv_webhooks
       WHERE provider='github' AND lower(owner)=lower($1) AND lower(repo)=lower($2) AND identity_key=$3 LIMIT 1`,
        [req.params.owner, req.params.repo, deps.identityKey(session)]
      );
      const row = firstRow(r);
      res.json({ available: true, connected: !!(row && member(row, 'active')), createdAt: row && member(row, 'created_at') });
    } catch (e) { fail(res, e); }
  });

  /* A webhook the provider created that the server could not record is removed, so nothing delivers to a hook id nobody holds. */
  async function removeOrphanedProviderHook(acct: unknown, req: Request, providerHookId: unknown): Promise<void> {
    if (!providerHookId) return;
    try {
      await deps.gh(acct, `${repository(req)}/hooks/${String(providerHookId)}`, { method: 'DELETE' });
    } catch (cleanupError) {
      if (member(cleanupError, 'status') !== 404) console.error(JSON.stringify({
        t: new Date().toISOString(), warn: 'orphaned GitHub webhook cleanup failed', providerHookId, error: member(cleanupError, 'message')
      }));
    }
  }

  app.post('/api/repo/:owner/:repo/live-events/connect', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('live-events'), auth, mutationContext('webhook.connect'), async (req: Request, res: Response) => {
    try {
      const session = account(req);
      if ((member(session, 'provider') || 'github') !== 'github') { res.status(501).json({ error: 'Verified live events are GitHub-only in v5.2' }); return; }
      if (!(await deps.dbReady())) { res.status(503).json({ error: 'Live events require the existing Neon DATABASE_URL' }); return; }
      const key = deps.identityKey(session);
      const existing = await deps.pool().query(
        `SELECT hook_id,provider_hook_id,active,alpha_resource_key_hash FROM nv_webhooks
       WHERE provider='github' AND lower(owner)=lower($1) AND lower(repo)=lower($2) AND identity_key=$3 LIMIT 1`,
        [req.params.owner, req.params.repo, key]
      );
      const found = firstRow(existing);
      if (found && member(found, 'active')) {
        if (deps.alphaEnabled && member(found, 'provider_hook_id')) {
          const resourceKeyHash = deps.providerResourceKeyHash({
            provider: 'github',
            authority: deps.providerAuthority(session),
            resourceType: 'provider-webhook',
            resourceReference: member(found, 'provider_hook_id')
          });
          if (!member(found, 'alpha_resource_key_hash')) {
            await deps.pool().query(
              'UPDATE nv_webhooks SET alpha_resource_key_hash=$1,updated_at=now() WHERE hook_id=$2',
              [resourceKeyHash, member(found, 'hook_id')]
            );
          }
          await alphaRecords().claimProviderWebhookOwnership({
            testerId: deps.alphaTesterId(req),
            identityKey: key,
            provider: 'github',
            resourceKeyHash
          });
        }
        res.status(409).json({ error: 'Verified live events are already connected for this repository' });
        return;
      }
      if (found && !member(found, 'active')) await deps.pool().query('DELETE FROM nv_webhooks WHERE hook_id=$1', [member(found, 'hook_id')]);
      const hookId = crypto.randomBytes(24).toString('hex');
      const secret = crypto.randomBytes(32).toString('base64url');
      const callback = `${deps.publicBase(req)}/hooks/github/${hookId}`;
      await deps.pool().query(
        `INSERT INTO nv_webhooks(hook_id,provider,owner,repo,identity_key,secret_enc,active)
       VALUES($1,'github',$2,$3,$4,$5,true)
       ON CONFLICT(provider,owner,repo,identity_key) DO UPDATE SET hook_id=EXCLUDED.hook_id,secret_enc=EXCLUDED.secret_enc,active=true,provider_hook_id=NULL,updated_at=now()`,
        [hookId, String(req.params.owner).toLowerCase(), String(req.params.repo).toLowerCase(), key, deps.seal({ secret })]
      );
      let providerHookId: unknown = null;
      try {
        const hook = await deps.gh(session, `${repository(req)}/hooks`, {
          method: 'POST',
          body: {
            name: 'web', active: true,
            events: WEBHOOK_EVENTS,
            config: { url: callback, content_type: 'json', insecure_ssl: '0', secret }
          }
        });
        providerHookId = member(hook, 'id');
        const alphaResourceKeyHash = deps.alphaEnabled
          ? deps.providerResourceKeyHash({
            provider: 'github',
            authority: deps.providerAuthority(session),
            resourceType: 'provider-webhook',
            resourceReference: providerHookId
          })
          : null;
        await deps.pool().query(
          `UPDATE nv_webhooks
            SET provider_hook_id=$1,alpha_resource_key_hash=$2,updated_at=now()
          WHERE hook_id=$3`,
          [providerHookId, alphaResourceKeyHash, hookId]
        );
        if (deps.alphaEnabled) {
          await alphaRecords().claimProviderWebhookOwnership({
            testerId: deps.alphaTesterId(req),
            identityKey: key,
            provider: 'github',
            resourceKeyHash: alphaResourceKeyHash
          });
        }
        await deps.appendEvidence(deps.scopedEvidenceKey('github', req.params.owner, req.params.repo, key), 'live-events-connected', hookId, {
          repository: `${req.params.owner}/${req.params.repo}`, actor: deps.retainedActor(req), connectedAt: new Date().toISOString()
        }).catch((error: unknown) => console.error('Evidence append failed after webhook connection:', member(error, 'message')));
        res.status(201).json({ available: true, connected: true });
      } catch (error) {
        await removeOrphanedProviderHook(session, req, providerHookId);
        await deps.pool().query('DELETE FROM nv_webhooks WHERE hook_id=$1', [hookId]).catch(() => {});
        const status = member(error, 'status');
        if ((status === 403 || status === 404) && error && typeof error === 'object') {
          Reflect.set(error, 'message', 'GitHub refused webhook creation. The token needs repository Webhooks: write permission and repository administration access.');
        }
        throw error;
      }
    } catch (e) { fail(res, e); }
  });

  app.delete('/api/repo/:owner/:repo/live-events', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('live-events'), auth, mutationContext('webhook.disconnect'), async (req: Request, res: Response) => {
    try {
      if (!(await deps.dbReady())) { res.status(503).json({ error: 'Live event storage is unavailable' }); return; }
      const session = account(req);
      const key = deps.identityKey(session);
      const r = await deps.pool().query(
        `SELECT hook_id,provider_hook_id,alpha_resource_key_hash FROM nv_webhooks
       WHERE provider='github' AND lower(owner)=lower($1) AND lower(repo)=lower($2) AND identity_key=$3 LIMIT 1`,
        [req.params.owner, req.params.repo, key]
      );
      const row = firstRow(r);
      if (!row) { res.json({ ok: true, disconnected: false }); return; }
      let evidenceSubject: unknown = member(row, 'hook_id');
      if (deps.alphaEnabled) {
        const pending = (cleanupId: unknown): void => {
          res.status(202).json({
            ok: false,
            status: 'pending',
            ...(cleanupId ? { cleanupId } : {})
          });
        };
        const resourceKeyHash = deps.providerResourceKeyHash({
          provider: 'github',
          authority: deps.providerAuthority(session),
          resourceType: 'provider-webhook',
          resourceReference: member(row, 'provider_hook_id') ?? member(row, 'hook_id')
        });
        const storedResourceKeyHash = String(member(row, 'alpha_resource_key_hash') || '');
        if (storedResourceKeyHash && storedResourceKeyHash !== resourceKeyHash) {
          pending('');
          return;
        }
        if (!storedResourceKeyHash) {
          try {
            const backfill = await deps.pool().query(
              `UPDATE nv_webhooks
                SET alpha_resource_key_hash=$1,updated_at=now()
              WHERE hook_id=$2 AND alpha_resource_key_hash IS NULL
              RETURNING alpha_resource_key_hash`,
              [resourceKeyHash, member(row, 'hook_id')]
            );
            const rows = member(backfill, 'rows');
            if (member(rows, 'length') !== 1
                || member(member(rows, '0'), 'alpha_resource_key_hash') !== resourceKeyHash) {
              pending('');
              return;
            }
          } catch {
            pending('');
            return;
          }
        }
        let cleanupTask: unknown;
        try {
          cleanupTask = await alphaRecords().createCleanupTask({
            testerId: deps.alphaTesterId(req),
            identityKey: key,
            provider: 'github',
            resourceType: 'provider-webhook',
            resourceKeyHash,
            reasonCode: ''
          });
        } catch {
          pending('');
          return;
        }
        let inspection: unknown;
        try {
          inspection = await alphaRecords().inspectProviderWebhookCleanup({
            testerId: deps.alphaTesterId(req),
            identityKey: key,
            provider: 'github',
            cleanupId: member(cleanupTask, 'cleanupId'),
            resourceKeyHash
          });
        } catch {
          pending(member(cleanupTask, 'cleanupId'));
          return;
        }
        let verifiedAbsent = false;
        if (!member(inspection, 'verified') && !member(inspection, 'shared') && member(row, 'provider_hook_id')) {
          const hookPath = `${repository(req)}/hooks/${String(member(row, 'provider_hook_id'))}`;
          try {
            await deps.gh(session, hookPath, { method: 'DELETE' });
          } catch (error) {
            if (member(error, 'status') === 404) verifiedAbsent = true;
            else { pending(member(cleanupTask, 'cleanupId')); return; }
          }
          if (!verifiedAbsent) {
            try {
              await deps.gh(session, hookPath);
            } catch (error) {
              if (member(error, 'status') === 404) verifiedAbsent = true;
              else { pending(member(cleanupTask, 'cleanupId')); return; }
            }
          }
          if (!verifiedAbsent) {
            pending(member(cleanupTask, 'cleanupId'));
            return;
          }
        }
        let completion: unknown;
        try {
          completion = await alphaRecords().completeProviderWebhookCleanup({
            testerId: deps.alphaTesterId(req),
            identityKey: key,
            provider: 'github',
            cleanupId: member(cleanupTask, 'cleanupId'),
            resourceKeyHash,
            providerVerifiedAbsent: verifiedAbsent
          });
        } catch {
          pending(member(cleanupTask, 'cleanupId'));
          return;
        }
        if (!member(completion, 'verified')) {
          pending(member(cleanupTask, 'cleanupId'));
          return;
        }
        evidenceSubject = resourceKeyHash;
      } else {
        if (member(row, 'provider_hook_id')) {
          try { await deps.gh(session, `${repository(req)}/hooks/${String(member(row, 'provider_hook_id'))}`, { method: 'DELETE' }); }
          catch (error) { if (member(error, 'status') !== 404) throw error; }
        }
        await deps.pool().query('DELETE FROM nv_webhooks WHERE hook_id=$1', [member(row, 'hook_id')]);
      }
      await deps.appendEvidence(deps.scopedEvidenceKey('github', req.params.owner, req.params.repo, key), 'live-events-disconnected', evidenceSubject, {
        actor: deps.retainedActor(req), disconnectedAt: new Date().toISOString()
      }).catch(() => {});
      res.json({ ok: true, disconnected: true });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/repo/:owner/:repo/intelligence/events', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('governance'), auth, async (req: Request, res: Response) => {
    try {
      if (!(await deps.dbReady())) { res.json({ available: false, events: [], hasMore: false, truncatedBefore: false, cursor: '' }); return; }
      const limit = Math.min(Math.max(parseInt(String(req.query.limit || '200'), 10) || 200, 1), 500);
      const after = decodeEventCursor(req.query.after);
      const session = account(req);
      const values: unknown[] = [member(session, 'provider') || 'github', req.params.owner, req.params.repo, deps.identityKey(session), limit + 1];
      /*
       * An event is stored to the microsecond, and a cursor names it to the
       * millisecond, as its time is given to the reader. Pages are ordered and
       * continued by that millisecond and then the event's id -- the order the
       * page sorts them in -- so a page starts after its cursor's event, never on it.
       */
      const at = "date_trunc('milliseconds', created_at)";
      let where = 'provider=$1 AND lower(owner)=lower($2) AND lower(repo)=lower($3) AND identity_key=$4';
      if (after) {
        values.push(after.createdAt, after.eventId);
        where += ` AND (${at} > $${values.length - 1} OR (${at} = $${values.length - 1} AND event_id > $${values.length}))`;
      }
      const order = after ? 'ASC' : 'DESC';
      const r = await deps.pool().query(
        `SELECT event_id,event_type,action,actor,target_type,target_id,ref,before_sha,after_sha,severity,risk_score,reasons,summary,paths,metadata,delivery_id,created_at
       FROM nv_intelligence_events WHERE ${where} ORDER BY ${at} ${order}, event_id ${order} LIMIT $5`, values
      );
      const found = rowsOf(r);
      const hasMore = !!after && found.length > limit;
      const truncatedBefore = !after && found.length > limit;
      let rows = found.slice(0, limit);
      if (!after) rows = rows.reverse();
      const events = rows.map(row => ({
        id: member(row, 'event_id'), eventType: member(row, 'event_type'), action: member(row, 'action'), actor: member(row, 'actor'),
        targetType: member(row, 'target_type'), targetId: member(row, 'target_id'), ref: member(row, 'ref'), beforeSha: member(row, 'before_sha'),
        afterSha: member(row, 'after_sha'), severity: member(row, 'severity'), score: member(row, 'risk_score'), reasons: member(row, 'reasons') || [],
        summary: member(row, 'summary'), paths: member(row, 'paths') || [], metadata: member(row, 'metadata') || {}, deliveryId: member(row, 'delivery_id'), createdAt: member(row, 'created_at')
      }));
      const lastRow = rows[rows.length - 1];
      res.json({ available: true, events, hasMore, truncatedBefore, cursor: lastRow ? encodeEventCursor(member(lastRow, 'created_at'), member(lastRow, 'event_id')) : String(req.query.after || '') });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/repo/:owner/:repo/live-events/stream', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('live-events'), auth, async (req: Request, res: Response) => {
    const session = account(req);
    const key = deps.scopedEvidenceKey(member(session, 'provider') || 'github', req.params.owner, req.params.repo, deps.identityKey(session));
    if (!deps.hub.admits(key)) {
      res.status(429).json({ error: 'Too many live event streams are open. Close another Neural tab and retry.' });
      return;
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const sessionSid = deps.sessionSid(req);
    const alphaSessionId = deps.alphaSessionId(req);
    res.write(`event: ready
data: ${JSON.stringify({ repository: `${req.params.owner}/${req.params.repo}`, at: new Date().toISOString() })}

`);
    deps.hub.add(key, res, sessionSid);
    let keepAliveTicks = 0;
    let sessionCheckBusy = false;
    const keepAlive = setInterval(() => {
      /*
       * The keepalive is the canary. A reader that has stopped reading takes no
       * events -- it may be subscribed to a quiet repository -- but it still
       * takes one of these every fifteen seconds, so this is what notices a
       * stalled socket on a stream that is otherwise idle.
       */
      writeLiveClient(res, `: keepalive ${Date.now()}

`);
      keepAliveTicks += 1;
      /* revocation check runs every 20th tick (~5 min), not every minute: a 60s poll would
         keep a free-tier Neon compute instance from ever auto-suspending. */
      if (keepAliveTicks % 20 !== 0 || sessionCheckBusy) return;
      const checks: Promise<unknown>[] = [];
      if (sessionSid && deps.databaseConfigured) {
        checks.push(
          deps.pool().query('SELECT 1 FROM nv_sessions WHERE sid=$1', [sessionSid])
            .then(result => {
              if (!read(result, 'rowCount')) {
                deps.hub.closeSessions([sessionSid], 'session-revoked');
              }
            })
            .catch(() => {})
        );
      }
      if (deps.alphaEnabled) {
        checks.push(
          deps.readAlphaSession(alphaSessionId, { touch: false })
            .catch(() => deps.hub.closeAlpha(key, res))
        );
      }
      if (!checks.length) return;
      sessionCheckBusy = true;
      /*
       * Settled, not all: a check whose own handler throws -- the stream it
       * closes already gone -- must not become a rejection nothing handles,
       * which would end the process, nor leave the next check never run.
       */
      void Promise.allSettled(checks).then(() => { sessionCheckBusy = false; });
    }, 15000);
    req.on('close', () => {
      clearInterval(keepAlive);
      deps.hub.remove(key, res);
    });
  });
}

/* The rows of a query's answer, read as `r.rows` was. */
function rowsOf(result: unknown): readonly unknown[] {
  const rows = member(result, 'rows');
  if (!Array.isArray(rows)) throw new TypeError('the query answered no rows');
  return rows;
}
