/*
 * Governance's life in this process.
 *
 * The store is built on first need, over the configured database, with the
 * API service on it and the webhook delivery worker started beside it -- one
 * of each for the process. A route asks for the service only once the
 * database answers, and is refused with 503 GOVERNANCE_DATABASE_REQUIRED
 * until then; so is a policy decision the runtime asks the store to record.
 * The runtime is the mutation gateway's policy port; when it cannot evaluate,
 * it says so in a log line and acts as the deployment's failure mode says.
 *
 * At boot, delivery starts as soon as the database answers, and is tried
 * again every thirty seconds until it does, on a timer that does not keep the
 * process alive. Nothing is started without a configured database, or once
 * shutdown has begun. Stopping clears that timer and hands back the batch the
 * worker has in flight, so shutdown can let it record what it has sent before
 * the pool closes.
 */
import { cleanText } from '../../../platform/values/text.ts';
import { startWebhookWorker, type WebhookWorker } from '../delivery/governance-webhook-worker.ts';
import { createGovernanceRuntime } from '../domain/governance-enforcement.ts';
import { GovernanceStore } from '../persistence/governance-store.ts';
import { createGovernanceApiService } from './governance-api.ts';

const DELIVERY_RETRY_MS = 30_000;

type GovernanceApiService = ReturnType<typeof createGovernanceApiService>;
type DecisionInput = Parameters<GovernanceStore['evaluateAndAppendPolicyDecision']>[0];

export interface GovernanceHostDeps {
  readonly databaseConfigured: boolean;
  readonly ready: () => Promise<boolean>;
  readonly pool: () => unknown;
  readonly auditSecret: string;
  /* What the runtime does when a policy cannot be evaluated: warn or block. */
  readonly runtimeFailureMode: string;
  readonly shuttingDown: () => boolean;
}

function governanceDatabaseRequired(message: string): Error {
  return Object.assign(new Error(message), { status: 503, code: 'GOVERNANCE_DATABASE_REQUIRED' });
}

export function createGovernanceHost(deps: GovernanceHostDeps) {
  let store: GovernanceStore | null = null;
  let service: GovernanceApiService | null = null;
  let worker: WebhookWorker | null = null;
  let deliveryTimer: ReturnType<typeof setTimeout> | null = null;

  function ensureGovernanceStore(): GovernanceStore {
    if (!store) {
      store = new GovernanceStore(deps.pool(), { secret: deps.auditSecret });
      service = createGovernanceApiService({ store });
      worker = startWebhookWorker({
        store,
        masterSecret: deps.auditSecret,
        onError(error) {
          console.error(JSON.stringify({
            t: new Date().toISOString(), warn: 'governance webhook delivery worker failed',
            code: cleanText(String(error && (error as { readonly code?: unknown }).code || 'GOVERNANCE_WEBHOOK_WORKER_FAILED'), 100)
          }));
        }
      });
    }
    return store;
  }

  const runtime = createGovernanceRuntime({
    failureMode: deps.runtimeFailureMode,
    onError(event) {
      console.error(JSON.stringify({
        t: new Date().toISOString(), warn: 'runtime policy evaluation unavailable',
        code: event && event.code || 'POLICY_EVALUATION_FAILED',
        action: event && event.action || 'unknown',
        scopeKey: event && event.scopeKey || 'unknown',
        failureMode: deps.runtimeFailureMode
      }));
    },
    store: {
      async evaluateAndAppendPolicyDecision(input: DecisionInput) {
        if (!(await deps.ready())) throw governanceDatabaseRequired('Governance runtime requires PostgreSQL');
        return ensureGovernanceStore().evaluateAndAppendPolicyDecision(input);
      }
    }
  });

  async function bootstrapGovernanceDelivery(): Promise<void> {
    if (!deps.databaseConfigured || deps.shuttingDown() || worker) return;
    if (await deps.ready()) {
      ensureGovernanceStore();
      return;
    }
    deliveryTimer = setTimeout(() => { void bootstrapGovernanceDelivery(); }, DELIVERY_RETRY_MS);
    if (typeof deliveryTimer.unref === 'function') deliveryTimer.unref();
  }

  async function governanceService(): Promise<GovernanceApiService | null> {
    if (!(await deps.ready())) throw governanceDatabaseRequired('Governance requires the configured PostgreSQL DATABASE_URL');
    ensureGovernanceStore();
    return service;
  }

  /* The delivery batch in flight, for shutdown to wait on; nothing when delivery never started. */
  function stop(): Promise<void> | null {
    if (deliveryTimer) clearTimeout(deliveryTimer);
    return worker ? worker.stop() : null;
  }

  return { runtime, ensureGovernanceStore, governanceService, bootstrapGovernanceDelivery, stop };
}

export type GovernanceHost = ReturnType<typeof createGovernanceHost>;
