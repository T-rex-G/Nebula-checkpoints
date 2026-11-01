/*
 * Where a person's safety controls are kept, and how a change to them is
 * written.
 *
 * With a database the controls belong to the identity, in nv_security_state,
 * and the session holds a copy; without one the session holds them. A store
 * that cannot answer is unavailable, never "all controls off": an outage must
 * not quietly lift a read-only mode. A change takes the identity's advisory
 * lock and the row, so two changes at once are applied one after the other to
 * the latest controls, an absent row included, and never to the snapshot the
 * request's middleware read.
 */
import { applySafetyPatch, defaultSafety, type SafetyControls, type SafetyPatch } from '../domain/safety-controls.ts';
import { protectedPatternsForRepository } from '../domain/safeguards.ts';

interface Client {
  query(text: string, values?: readonly unknown[]): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
  release(): void;
}

interface SafetyRequest {
  session?: { safety?: unknown; [field: string]: unknown } | null;
  gh?: unknown;
}

export interface SafetyStateDeps {
  /* Whether the deployment keeps the controls in a database; fixed at startup. */
  readonly databaseConfigured: boolean;
  readonly ready: () => Promise<boolean>;
  readonly pool: () => {
    query(text: string, values?: readonly unknown[]): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
    connect(): Promise<Client>;
  };
  readonly identityKey: (account: unknown) => string;
  readonly setSession: (req: never, res: unknown, data: unknown) => Promise<void>;
}

export function safetyUnavailable(): Error & { status: number; code: string; providerChanged: boolean } {
  return Object.assign(new Error('Safety controls could not be loaded or saved. Try again when the database is available.'), {
    status: 503, code: 'SAFETY_STATE_UNAVAILABLE', providerChanged: false
  });
}

export function createSafetyState(deps: SafetyStateDeps) {
  const setSession = deps.setSession as (req: SafetyRequest, res: unknown, data: unknown) => Promise<void>;

  /* The identity's controls, or the session's where there is no database. */
  async function loadPersistentSafety(req: SafetyRequest): Promise<SafetyControls> {
    const fallback = defaultSafety(req.session && req.session.safety);
    if (!deps.databaseConfigured) return fallback;
    if (!(await deps.ready())) throw safetyUnavailable();
    try {
      const r = await deps.pool().query('SELECT state FROM nv_security_state WHERE identity_key=$1', [deps.identityKey(req.gh)]);
      return r.rows.length ? defaultSafety(r.rows[0]!.state) : fallback;
    } catch { throw safetyUnavailable(); }
  }

  async function savePersistentSafety(req: SafetyRequest, patch: SafetyPatch): Promise<SafetyControls> {
    let clean: SafetyControls;
    if (deps.databaseConfigured && !(await deps.ready())) throw safetyUnavailable();
    if (deps.databaseConfigured) {
      let client: Client;
      try { client = await deps.pool().connect(); } catch { throw safetyUnavailable(); }
      try {
        await client.query('BEGIN');
        const key = deps.identityKey(req.gh);
        // Serialize absent rows too. Apply only the requested changes to the
        // latest controls, never the snapshot captured by request middleware.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`safety:${key}`]);
        const current = await client.query('SELECT state FROM nv_security_state WHERE identity_key=$1 FOR UPDATE', [key]);
        clean = applySafetyPatch(current.rows.length ? current.rows[0]!.state : req.session!.safety, patch);
        await client.query(
          `INSERT INTO nv_security_state(identity_key,state,updated) VALUES($1,$2::jsonb,now())
         ON CONFLICT(identity_key) DO UPDATE SET state=EXCLUDED.state, updated=now()`,
          [key, JSON.stringify(clean)]
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        /* A refused change says why; whatever the database did instead is "unavailable", never an unexplained failure. */
        if (error && Number((error as { readonly status?: unknown }).status) >= 400 && Number((error as { readonly status?: unknown }).status) < 500) throw error;
        throw safetyUnavailable();
      } finally { client.release(); }
    } else clean = applySafetyPatch(req.session!.safety, patch);
    req.session!.safety = clean;
    return clean;
  }

  /*
   * With a database the identity's controls live in nv_security_state and the
   * session holds a copy. A copy that cannot be written because the session
   * ended meanwhile does not undo a change that has already committed.
   */
  async function saveSessionSafetyCopy(req: SafetyRequest, res: unknown): Promise<boolean> {
    if (!deps.databaseConfigured) { await setSession(req, res, req.session); return true; }
    try { await setSession(req, res, req.session); return true; }
    catch (error) {
      const status = Number(error && (error as { readonly status?: unknown }).status);
      const code = error && (error as { readonly code?: unknown }).code;
      const ended = error && (status === 401 || status === 503
        || ['SESSION_REVOKED', 'ALPHA_PROVIDER_SESSION_UNAVAILABLE', 'ALPHA_SESSION_REVISION_CONFLICT'].includes(code as string));
      if (!ended) throw error;
      return false;
    }
  }

  /*
   * The paths an identity protects in one repository, read from its stored
   * controls for a request that has no session (a webhook delivery). A read
   * that fails is the caller's failure: scoring an event without the policy
   * would quietly drop the protected paths from its risk.
   */
  async function protectedPatternsForIdentity(identity: string, owner: string, repo: string): Promise<string[]> {
    const sf = await deps.pool().query('SELECT state FROM nv_security_state WHERE identity_key=$1', [identity]);
    const state = defaultSafety(sf.rows[0] && sf.rows[0].state);
    return protectedPatternsForRepository(state.protected, owner, repo);
  }

  return { loadPersistentSafety, savePersistentSafety, saveSessionSafetyCopy, protectedPatternsForIdentity };
}

export type SafetyStore = ReturnType<typeof createSafetyState>;
