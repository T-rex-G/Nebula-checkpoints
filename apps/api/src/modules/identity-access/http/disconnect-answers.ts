/*
 * What a provider disconnect answers, wherever one is asked for: removing an
 * account, signing out, disconnecting every provider, deleting one's alpha
 * data or a GitHub App connection.
 *
 * A cleanup still in progress is 202 with each account's result, so the
 * browser can say what is left. A retired account's credentials cannot be
 * revoked by the server, and the person is told how to revoke them, once per
 * distinct step.
 */
import type { Request, Response } from 'express';
import type { Fields } from '../../../platform/values/fields.ts';

/* The provider session the account guard attached: the accounts signed in and which one acts. */
export interface ProviderSession {
  accounts: Fields[];
  active?: unknown;
  [key: string]: unknown;
}

/* One account's disconnect, as the cleanup reports it; the routes read only how its credentials are revoked. */
export interface DisconnectOutcome { readonly revocationGuidance?: unknown }

/* A disconnect's outcome, as the server's provider cleanup reports it. */
export interface ProviderCleanup {
  readonly complete: boolean;
  readonly supportedComplete: boolean;
  readonly results: readonly DisconnectOutcome[];
  readonly manualCleanup: readonly unknown[];
}

export type DisconnectProviderAccounts = (req: Request, accountOrAccounts: unknown) => Promise<ProviderCleanup>;

export interface RevocationStep {
  readonly label: unknown;
  readonly url: unknown;
  readonly automatic: false;
}

/* One instruction per distinct step, in the same {label, url} shape with or without alpha. */
export function uniqueGuidance(items: Iterable<unknown>): RevocationStep[] {
  const seen = new Map<string, RevocationStep>();
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const step = item as Fields;
    if (step.label) seen.set(`${String(step.label)}\0${String(step.url || '')}`, { label: step.label, url: step.url || null, automatic: false });
  }
  return [...seen.values()];
}

export function providerDisconnectPending(res: Response, cleanup: ProviderCleanup): Response {
  return res.status(202).json({
    ok: false,
    status: 'pending',
    results: cleanup.results
  });
}
