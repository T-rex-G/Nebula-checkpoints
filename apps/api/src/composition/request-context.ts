/*
 * What the guards attached to a request, as the routes they guard read it.
 *
 * Express knows nothing of these fields, so a request is read here as any
 * object carrying them. Each is attached by a guard that runs first on every
 * route reading it: the session guards attach the account, the alpha boundary
 * the tester's access and its session id, Kepler's guards a governed route's
 * context. Read as the server has always read them -- an account no guard
 * attached is handed on as it is.
 */
import { identityKey } from '../modules/identity-access/index.ts';
import type { GovernanceRequest } from '../modules/kepler/index.ts';
import type { Fields } from '../platform/values/fields.ts';

/* The alpha's own session id on a request, kept under a key only this server holds. */
export const ALPHA_SESSION_ID: unique symbol = Symbol('alpha session id');

export type GuardedRequest = object & {
  readonly params: Readonly<Record<string, string | undefined>>;
  readonly gh?: Fields;
  readonly alpha?: { readonly testerId?: unknown; readonly repositoryScopes?: unknown } | null;
  readonly governance?: GovernanceRequest;
  readonly [ALPHA_SESSION_ID]?: unknown;
};

/* The provider account the request acts as. */
export const accountOf = (req: GuardedRequest): Fields => req.gh!;
/* Whose request this is, as an identity key. */
export const viewerOf = (req: GuardedRequest): string => identityKey(req.gh);
/* A governed route's context. */
export const governanceOf = (req: GuardedRequest): GovernanceRequest => req.governance!;
/* The alpha tester, and the alpha session the request came in on. */
export const alphaTesterOf = (req: GuardedRequest): unknown => req.alpha!.testerId;
export const alphaSessionOf = (req: GuardedRequest): unknown => req[ALPHA_SESSION_ID];
