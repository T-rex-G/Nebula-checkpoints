/*
 * A merge's facts for the policy: the branch it merges into, the branch it
 * comes from, and what the merging person's latest audit of that head says
 * (the merge gate). The mutation context reads them once, before the change
 * is described, so the policy judges the same facts the ledger records. A
 * pull request that cannot be read leaves the gate unavailable rather than
 * failing the merge here; the provider will say why it cannot merge it.
 */
import type { CodeAuditService, RepositoryTarget } from './code-audit-service.ts';
import { gateAttributes, mergeAttributes, unavailableGate } from './merge-gate.ts';

export async function mergeFactsFor(audit: Pick<CodeAuditService, 'readPullFacts' | 'mergeGateFor'>, target: RepositoryTarget, pullNumber: unknown) {
  const number = Number.parseInt(String(pullNumber || ''), 10);
  let pull;
  try { pull = await audit.readPullFacts(target, number); }
  catch { return { audit: gateAttributes(unavailableGate()) }; }
  const gate = await audit.mergeGateFor(target.account, target.owner, target.repo, pull);
  return mergeAttributes(pull, gate);
}
