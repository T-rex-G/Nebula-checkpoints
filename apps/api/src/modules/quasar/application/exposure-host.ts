/*
 * Exposure scanning's life in this process.
 *
 * The worker starts only when the capability document says the feature is
 * available for some provider in this deployment, and today it says
 * Unavailable everywhere. That is deliberate rather than a missing wire: a
 * poller asking the database for work that no route can create would spend a
 * query every fifteen seconds of a free service's budget for nothing. Raising
 * the capability starts it, and nothing else has to change -- which is the
 * point of gating on the document rather than on a flag somebody would have
 * to remember to set in two places. Nothing starts without a configured
 * database, or once shutdown has begun.
 *
 * A scan holds no credential. It holds the identity the work belongs to, and
 * the token is resolved from a session that is still signed in at the moment
 * the scan runs (application/exposure-session.ts) -- so a disconnect, a
 * sign-out or a revocation simply stops the next read, rather than leaving a
 * copied token in a job row for something to remember to clean up.
 *
 * Each scan reads through one connection pool, pinned to validated
 * addresses. Without it every file costs a DNS lookup and a TLS handshake,
 * which for a scan of small files is most of the time the scan takes.
 *
 * A nudge starts the scan now rather than at the worker's next tick. The
 * worker is already one-at-a-time -- a run while one is in flight is refused
 * -- so a nudge can never overlap two scans; it only stops a reader waiting up
 * to a poll interval for work that was ready.
 *
 * The routes read the scans through the store the worker writes; without the
 * configured database there is none, and each route says so with 503
 * EXPOSURE_DATABASE_REQUIRED. Stopping hands back the scan in flight: it has
 * sent nothing irreversible, and an abandoned scan is recovered when its lease
 * expires, but finishing the one in hand is cheaper than reading the
 * repository again.
 */
import { createGuardedSession, PROFILES as GUARDED_PROFILES } from '../../../platform/network/guarded-fetch.ts';
import * as exposureReader from '../client/exposure-reader.ts';
import { ExposureStore, type ExposureStoreOptions } from '../persistence/exposure-store.ts';
import { resolveExposureSession as resolveStoredExposureSession, type ExposureSessionDependencies, type ExposureSessionInput } from './exposure-session.ts';
import { DEFAULT_BUDGETS, startExposureWorker } from './exposure-worker.ts';

type ExposureWorker = ReturnType<typeof startExposureWorker>;
/* A tester's alpha access, as a scan's session reads it. */
type Access = { readonly testerId?: unknown; readonly repositoryScopes?: unknown };
/* An account with its credential resolved: its fields, the token a scan reads with among them. */
type ResolvedAccount = Readonly<Record<string, unknown>>;

export interface ExposureHostDeps {
  readonly databaseConfigured: boolean;
  readonly pool: () => NonNullable<ExposureStoreOptions['pool']>;
  /* The deployment's capability document, and which of its deployments this is. */
  readonly capabilityDocument: unknown;
  readonly deployment: string;
  readonly fingerprintKey: string | Buffer;
  readonly shuttingDown: () => boolean;
  /* How a scan finds a session still signed in, less the pool, which is this host's. */
  readonly session: Omit<ExposureSessionDependencies<Access, ResolvedAccount>, 'pool'>;
}

export function createExposureHost(deps: ExposureHostDeps) {
  let worker: ExposureWorker | null = null;
  let store: ExposureStore | null = null;

  function exposureScanningAvailable(): boolean {
    const document = deps.capabilityDocument as { readonly providers?: Readonly<Record<string, unknown>> } | null | undefined;
    const providers = (document && document.providers) || {};
    for (const deployments of Object.values(providers)) {
      const features = ((deployments && (deployments as Readonly<Record<string, unknown>>)[deps.deployment]) || {}) as Readonly<Record<string, unknown>>;
      const tuple = features['exposure.scan'];
      if (Array.isArray(tuple) && (tuple[0] === 'Supported' || tuple[0] === 'Experimental')) return true;
    }
    return false;
  }

  async function resolveExposureSession(input: ExposureSessionInput) {
    if (!deps.databaseConfigured) return null;
    return resolveStoredExposureSession(input, { ...deps.session, pool: deps.pool() });
  }

  function ensureExposureWorker(): ExposureWorker | null {
    if (worker || !deps.databaseConfigured || deps.shuttingDown() || !exposureScanningAvailable()) return worker;
    store = new ExposureStore({ pool: deps.pool(), cursorKey: deps.fingerprintKey });
    worker = startExposureWorker({
      store,
      reader: exposureReader,
      fingerprintKey: deps.fingerprintKey,
      sessionResolver: resolveExposureSession,
      createTransport: () => createGuardedSession({
        profile: GUARDED_PROFILES.PROVIDER_READ,
        maxSockets: DEFAULT_BUDGETS.readConcurrency
      })
    });
    return worker;
  }

  function nudgeExposureWorker(): void {
    const started = ensureExposureWorker();
    if (started && typeof started.run === 'function') {
      Promise.resolve().then(() => started.run()).catch(() => { /* the next tick tries again */ });
    }
  }

  function exposureService(): ExposureStore {
    if (!deps.databaseConfigured) {
      throw Object.assign(new Error('Exposure scanning requires the configured PostgreSQL DATABASE_URL'), {
        status: 503, code: 'EXPOSURE_DATABASE_REQUIRED'
      });
    }
    if (!store) store = new ExposureStore({ pool: deps.pool(), cursorKey: deps.fingerprintKey });
    return store;
  }

  /* The scan in flight, for shutdown to wait on; nothing when no worker started. */
  function stop(): Promise<unknown> | null {
    return worker ? worker.stop() : null;
  }

  return { exposureScanningAvailable, resolveExposureSession, ensureExposureWorker, nudgeExposureWorker, exposureService, stop };
}

export type ExposureHost = ReturnType<typeof createExposureHost>;
