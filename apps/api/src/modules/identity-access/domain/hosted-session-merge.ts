/*
 * A hosted provider session written by two requests at once.
 *
 * In the hosted alpha the session lives in the privacy store, and a request
 * reads it, changes it, and writes it back. A second request may have written
 * it in between. Rather than the later write replacing the earlier one, the
 * store hands the write the session as it now is, and this works out what the
 * request meant: the changes it made to the session it read (the base) are
 * applied to the current one, and whatever it left alone keeps the other
 * request's value.
 *
 * Fields merge key by key, objects within objects. Accounts merge by who they
 * are (provider and identity key): an account the request removed is removed,
 * one it added or changed is written, and one the other request added is kept,
 * after the request's own, which keep the request's order. The selected
 * account is the one the request selected, wherever it now sits, or the first.
 */
import { stableJson } from '../../../platform/values/stable-hash.ts';
import { identityKey, type AccountLike } from './account-identity.ts';

type Value = unknown;
type Fields = Record<string, unknown>;
const isFields = (value: Value): value is Fields => !!value && typeof value === 'object' && !Array.isArray(value);

export function mergeHostedSessionValue(base: Value, desired: Value, current: Value): Value {
  if (stableJson(base) === stableJson(desired)) return structuredClone(current);
  if (isFields(base) && isFields(desired) && isFields(current)) {
    const merged: Fields = {};
    for (const key of new Set([...Object.keys(current), ...Object.keys(base), ...Object.keys(desired)])) {
      if (!(key in desired) && key in base) continue;
      if (!(key in desired)) {
        merged[key] = structuredClone(current[key]);
        continue;
      }
      merged[key] = mergeHostedSessionValue(base[key], desired[key], current[key]);
    }
    return merged;
  }
  return structuredClone(desired);
}

/* An account's place in a hosted session: its provider and who it is. */
export function hostedAccountKey(account: AccountLike | null | undefined): string {
  return `${String(account && account.provider || 'github')}\0${identityKey(account)}`;
}

export interface HostedSession {
  readonly accounts?: readonly AccountLike[];
  readonly active?: number;
  readonly [field: string]: unknown;
}

export function recomputeHostedSessionMutation(base: HostedSession | null | undefined, desired: HostedSession, current: HostedSession): HostedSession {
  if (!base || !Array.isArray(base.accounts)) return structuredClone(desired);
  const next = mergeHostedSessionValue(
    { ...base, accounts: undefined, active: undefined },
    { ...desired, accounts: undefined, active: undefined },
    { ...current, accounts: undefined, active: undefined }
  ) as Fields;
  const currentAccounts = new Map((current.accounts || []).map(account => [hostedAccountKey(account), account]));
  const baseAccounts = new Map((base.accounts || []).map(account => [hostedAccountKey(account), account]));
  const desiredAccounts = new Map((desired.accounts || []).map(account => [hostedAccountKey(account), account]));
  for (const key of baseAccounts.keys()) if (!desiredAccounts.has(key)) currentAccounts.delete(key);
  for (const [key, account] of desiredAccounts) {
    if (!baseAccounts.has(key) || stableJson(baseAccounts.get(key)) !== stableJson(account)) {
      currentAccounts.set(key, structuredClone(account));
    }
  }
  const desiredOrder = [...desiredAccounts.keys()];
  const mergedOrder = [
    ...desiredOrder.filter(key => currentAccounts.has(key)),
    ...[...currentAccounts.keys()].filter(key => !desiredAccounts.has(key))
  ];
  next.accounts = mergedOrder.map(key => currentAccounts.get(key));
  const desiredActive = desired.accounts && desired.accounts[desired.active as number];
  const desiredActiveKey = desiredActive ? hostedAccountKey(desiredActive) : '';
  next.active = Math.max(0, mergedOrder.indexOf(desiredActiveKey));
  return next;
}
