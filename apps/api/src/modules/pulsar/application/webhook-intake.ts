/*
 * A GitHub webhook delivery, received.
 *
 * The hook is looked up by its id, and the delivery is checked against the
 * hook's own secret before anything else is read from it. A sender over its
 * rate is refused before the database is asked. The event must be for the
 * hook's repository. It is scored against the paths the hook's identity
 * protects there, stored once (a redelivery is not stored twice), recorded in
 * the identity's evidence chain, and written to the identity's live streams.
 *
 * A delivery GitHub retries after the evidence append failed completes the
 * chain, and is broadcast then, since the first attempt never was. Any failure
 * past the checks is answered 500 without detail, and logged by message only.
 */
import crypto from 'node:crypto';
import { member } from '../../../platform/values/fields.ts';
import { cleanText } from '../../../platform/values/text.ts';
import { hashJson } from '../../../platform/values/stable-hash.ts';
import { normalizeGithubWebhook, riskForEvent } from '../domain/webhook-events.ts';
import { verifyGithubSignature } from '../domain/webhook-signature.ts';

type Rows = { readonly rows: readonly Record<string, unknown>[]; readonly rowCount?: number | null };

interface HookRow {
  readonly hook_id: string;
  readonly owner: string;
  readonly repo: string;
  readonly identity_key: string;
  readonly secret_enc: string;
  readonly active: boolean;
}

interface WebhookRequest {
  readonly params: { readonly hookId?: unknown };
  readonly headers: Readonly<Record<string, unknown>>;
  readonly body?: unknown;
  readonly ip?: unknown;
}

interface WebhookResponse {
  status(code: number): WebhookResponse;
  json(body: unknown): unknown;
  end(): unknown;
}

export interface WebhookIntakeDeps {
  /* The sender's rate (application/webhook-limiter.ts). */
  readonly allow: (req: WebhookRequest, hookId: string) => Promise<boolean>;
  readonly ready: () => Promise<boolean>;
  readonly pool: () => { query(text: string, values?: readonly unknown[]): Promise<Rows> };
  /* Opens the hook's sealed secret. */
  readonly unseal: (sealed: unknown) => unknown;
  /* The paths an identity protects in a repository (Corona). */
  readonly protectedPatternsForIdentity: (identity: string, owner: string, repo: string) => Promise<readonly string[]>;
  /* The key an identity's evidence and live streams for a repository are kept under (Corona). */
  readonly evidenceKey: (provider: string, owner: string, repo: string, identity: string) => string;
  readonly appendEvidence: (key: string, kind: string, recordId: string, payload: unknown) => Promise<Readonly<Record<string, unknown>> | null>;
  readonly liveHub: { broadcast(key: string, payload: string): unknown };
}

export function createWebhookIntake(deps: WebhookIntakeDeps) {
  function broadcastLive(provider: string, owner: string, repo: string, identity: string, event: { readonly id?: unknown }) {
    const payload = `id: ${String(event.id || '').replace(/[^0-9a-f-]/gi, '')}\nevent: intelligence\ndata: ${JSON.stringify(event)}\n\n`;
    deps.liveHub.broadcast(deps.evidenceKey(provider, owner, repo, identity), payload);
  }

  async function receiveGithubWebhook(req: WebhookRequest, res: WebhookResponse) {
    try {
      const hookId = String(req.params.hookId || '');
      if (!/^[0-9a-f]{32,64}$/i.test(hookId)) return res.status(404).end();
      if (!(await deps.allow(req, hookId))) return res.status(429).json({ error: 'Webhook delivery rate exceeded' });
      if (!(await deps.ready())) return res.status(503).json({ error: 'Live events require the existing Neon DATABASE_URL' });
      const found = await deps.pool().query(
        'SELECT hook_id,owner,repo,identity_key,secret_enc,active FROM nv_webhooks WHERE hook_id=$1 AND provider=$2',
        [hookId, 'github']
      );
      const hook = found.rows[0] as HookRow | undefined;
      if (!hook || !hook.active) return res.status(404).end();
      const sealed = deps.unseal(hook.secret_enc);
      const secret = sealed && member(sealed, 'secret');
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from((req.body || '') as string);
      if (!verifyGithubSignature(secret, raw, String(req.headers['x-hub-signature-256'] || ''))) {
        return res.status(401).json({ error: 'Invalid webhook signature' });
      }
      const deliveryId = cleanText(req.headers['x-github-delivery'] || '', 100);
      const eventName = cleanText(req.headers['x-github-event'] || '', 80);
      if (!deliveryId || !eventName) return res.status(400).json({ error: 'Missing GitHub delivery headers' });
      let payload;
      try { payload = JSON.parse(raw.toString('utf8')); }
      catch { return res.status(400).json({ error: 'Invalid JSON payload' }); }
      const event = normalizeGithubWebhook(eventName, payload, deliveryId);
      event.metadata = { ...(event.metadata || {}), rawPayloadHash: crypto.createHash('sha256').update(raw).digest('hex') };
      if (String(event.owner).toLowerCase() !== String(hook.owner).toLowerCase() || String(event.repo).toLowerCase() !== String(hook.repo).toLowerCase()) {
        return res.status(409).json({ error: 'Webhook repository mismatch' });
      }
      const patterns = await deps.protectedPatternsForIdentity(hook.identity_key, hook.owner, hook.repo);
      const risk = riskForEvent(event, { protectedPatterns: patterns, defaultBranch: event.defaultBranch });
      const providerEventId = event.id;
      const storedEventId = hashJson({ identityKey: hook.identity_key, deliveryId: providerEventId });
      const stored = await deps.pool().query(
        `INSERT INTO nv_intelligence_events(
        event_id,provider,owner,repo,identity_key,event_type,action,actor,target_type,target_id,ref,before_sha,after_sha,
        severity,risk_score,reasons,summary,paths,metadata,delivery_id,created_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18::jsonb,$19::jsonb,$20,now())
      ON CONFLICT(event_id) DO NOTHING RETURNING created_at`,
        [storedEventId, event.provider, hook.owner, hook.repo, hook.identity_key, event.eventType, event.action, event.actor,
          event.targetType, event.targetId, event.ref, event.beforeSha, event.afterSha, risk.severity, risk.score,
          JSON.stringify(risk.reasons), event.summary, JSON.stringify(event.paths || []), JSON.stringify({ ...(event.metadata || {}), providerEventId }), deliveryId]
      );
      const enriched = {
        ...event, id: storedEventId, providerEventId, owner: hook.owner, repo: hook.repo, ...risk,
        createdAt: stored.rows[0] && stored.rows[0].created_at || new Date().toISOString()
      };
      /* Evidence is idempotent by repository/kind/record ID. If an append fails after
         event persistence, GitHub can retry the delivery and complete the chain. */
      const evidence = await deps.appendEvidence(deps.evidenceKey('github', hook.owner, hook.repo, hook.identity_key), 'webhook', storedEventId, enriched);
      if (stored.rowCount || !evidence!.deduplicated) broadcastLive('github', hook.owner, hook.repo, hook.identity_key, enriched);
      res.status(eventName === 'ping' ? 200 : 202).json({ ok: true, accepted: !!stored.rowCount, event: eventName });
    } catch (error) {
      console.error('Webhook intake failed:', (error as { readonly message?: unknown }).message);
      res.status(500).json({ error: 'Webhook intake failed' });
    }
    return undefined;
  }

  return { receiveGithubWebhook };
}

export type WebhookIntake = ReturnType<typeof createWebhookIntake>;
