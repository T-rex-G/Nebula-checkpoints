/*
 * The durable stores a request's admission and its single-use grants are
 * kept in, built on first use over the one pool.
 *
 * The API's rate limit is counted in the database where one is configured,
 * and in each process's own memory where none is (http/pipeline/
 * rate-admission.ts falls back when there is no store). The shared single-use
 * guard holds the step-up grants where a database is configured, and the
 * GitHub App's and the recovery's OAuth and authorization claims;
 * identity-access/application/session-security.ts says why the guard is
 * chosen by configuration.
 */
import type { Queryable } from '../persistence/queryable.ts';
import { RateLimitStore } from './rate-limit-store.ts';
import { SingleUseStore } from './single-use-store.ts';

export interface DurableStoresDeps {
  readonly databaseConfigured: boolean;
  readonly pool: () => Queryable;
}

export function createDurableStores(deps: DurableStoresDeps) {
  let rateLimitStore: RateLimitStore | null = null;
  let singleUseStore: SingleUseStore | null = null;

  function apiRateLimitStore(): RateLimitStore | null {
    if (!deps.databaseConfigured) return null;
    if (!rateLimitStore) rateLimitStore = new RateLimitStore({ pool: deps.pool() });
    return rateLimitStore;
  }

  function durableSingleUseStore(): SingleUseStore {
    if (!singleUseStore) singleUseStore = new SingleUseStore({ pool: deps.pool() });
    return singleUseStore;
  }

  return { apiRateLimitStore, durableSingleUseStore };
}

export type DurableStores = ReturnType<typeof createDurableStores>;
