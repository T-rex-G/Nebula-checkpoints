import { ContractError } from '../../../../../packages/contracts/src/guards.ts';
import type { Refuse } from '../../../../../packages/contracts/src/guards.ts';
import { normalizePolicyScope } from '../../../../../packages/contracts/src/scope.ts';
import type { RepositoryScope } from '../../../../../packages/contracts/src/scope.ts';

/*
 * The repository a request names, read by the scope contract's rules. A
 * malformed scope is the caller's mistake, so it answers 400 under the
 * contract's codes, as it did when the platform borrowed governance's reader;
 * the platform no longer depends on the governance module to say so.
 */
export const refuseScope: Refuse = (message, code) => {
  throw new ContractError(message, code, 400);
};

export function normalizeRepositoryScope(input: unknown): RepositoryScope {
  return normalizePolicyScope(input, refuseScope);
}
