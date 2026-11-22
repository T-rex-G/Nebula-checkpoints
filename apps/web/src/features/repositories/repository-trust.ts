/*
 * A repository's trust summary: its five lines -- the connection, the
 * pipeline, the risk, the most pressing action and the evidence -- read from
 * three readings, each of which may have failed. A reading that failed is
 * said as unavailable; no line ever claims a clean result it did not get.
 */
/*
 * A property read as the summary always read it: what JavaScript gives for
 * `value[name]` -- a string's length and characters included -- and nothing
 * for null or undefined, where the expression would have thrown.
 */
const field = (value: unknown, name: string): unknown => (value === null || value === undefined ? undefined : (Object(value) as Record<string, unknown>)[name]);

export type EvidenceState = 'Inferred' | 'Unavailable' | 'Provider-verified' | 'Deterministic' | 'Stale';
export interface TrustLine { readonly text: string; readonly evidenceState: EvidenceState }
export interface TrustSummary {
  readonly connection: TrustLine;
  readonly pipeline: TrustLine;
  readonly risk: TrustLine;
  readonly action: TrustLine;
  readonly evidence: TrustLine;
  readonly announcement: string;
}

/* Drawn the moment a repository opens, while its readings are asked for. */
export const LOADING_SUMMARY: TrustSummary = Object.freeze<TrustSummary>({
  connection: { text: 'Checking provider and repository freshness\u2026', evidenceState: 'Inferred' },
  pipeline: { text: 'Checking application and evidence health\u2026', evidenceState: 'Inferred' },
  risk: { text: 'Checking access and governance risk\u2026', evidenceState: 'Inferred' },
  action: { text: 'Waiting for verified trust results.', evidenceState: 'Inferred' },
  evidence: { text: 'Loading supporting evidence\u2026', evidenceState: 'Inferred' },
  announcement: 'Repository opened. Trust checks are running.'
});

/* Drawn when the summary itself could not be drawn. */
export const UNAVAILABLE_SUMMARY: TrustSummary = Object.freeze<TrustSummary>({
  connection: { text: 'Repository metadata responded.', evidenceState: 'Provider-verified' },
  pipeline: { text: 'Trust checks could not be completed.', evidenceState: 'Unavailable' },
  risk: { text: 'Risk state is unavailable.', evidenceState: 'Unavailable' },
  action: { text: 'Retry trust checks before making a sensitive change.', evidenceState: 'Unavailable' },
  evidence: { text: 'Supporting evidence is unavailable.', evidenceState: 'Unavailable' },
  announcement: 'Repository trust checks are unavailable.'
});

export type Reading = { readonly status: 'fulfilled'; readonly value: unknown } | { readonly status: 'rejected'; readonly reason: unknown };

const failureText = (result: Reading, label: string): string => (result.status === 'fulfilled' ? '' : `${label} is unavailable. No clean result is claimed.`);
const value = (result: Reading): unknown => (result.status === 'fulfilled' ? result.value : null);

export function trustSummary(liveResult: Reading, accessResult: Reading, evidenceResult: Reading): TrustSummary {
  const live = value(liveResult);
  const access = value(accessResult);
  const evidence = value(evidenceResult);
  const failures = [
    failureText(liveResult, 'Live-event status'),
    failureText(accessResult, 'Access-surface status'),
    failureText(evidenceResult, 'Evidence status')
  ].filter(Boolean);

  const reason = field(live, 'reason');
  const connection: TrustLine = !live
    ? { text: 'Repository metadata responded, but connection freshness could not be verified.', evidenceState: 'Unavailable' }
    : field(live, 'available') === false
      ? { text: `Repository responded; verified live events are unavailable${reason ? `: ${String(reason)}` : '.'}`, evidenceState: 'Unavailable' }
      : field(live, 'connected')
        ? { text: 'Repository is current and verified live events are connected.', evidenceState: 'Provider-verified' }
        : { text: 'Repository is current; verified live events are not connected.', evidenceState: 'Provider-verified' };

  const chain = evidence && field(evidence, 'chain');
  const noChain = !evidence || field(evidence, 'available') === false || !chain || field(chain, 'available') === false;
  const checked = field(chain, 'checked');
  const pipeline: TrustLine = noChain
    ? { text: 'Durable evidence verification is unavailable; no healthy pipeline is claimed.', evidenceState: 'Unavailable' }
    : field(chain, 'valid')
      ? { text: `Evidence chain verified${Number.isFinite(checked) ? ` across ${String(checked)} record(s)` : ''}.`, evidenceState: 'Deterministic' }
      : { text: 'Evidence verification did not pass. Treat the pipeline as stale.', evidenceState: 'Stale' };

  const accessRisk = field(access, 'risk');
  const severity = field(accessRisk, 'severity');
  const reasons = field(accessRisk, 'reasons');
  const first = reasons ? field(reasons, '0') : undefined;
  const risk: TrustLine = !access || field(access, 'available') === false
    ? { text: 'Access and governance risk could not be enumerated.', evidenceState: 'Unavailable' }
    : field(access, 'partial')
      ? { text: 'Access inventory is partial; risk may be understated.', evidenceState: 'Stale' }
      : accessRisk && severity !== 'normal'
        ? { text: `${severity === 'critical' ? 'Critical' : 'Warning'} access risk (${Number(field(accessRisk, 'score')) || 0}/100): ${first ? String(field(first, 'message')) : 'review the access surface.'}`, evidenceState: 'Provider-verified' }
        : { text: 'No issue was found in the provider access inventory.', evidenceState: 'Provider-verified' };

  let action: TrustLine = { text: 'No immediate corrective action is indicated. Continue with the golden path.', evidenceState: 'Inferred' };
  if (failures.length) action = { text: 'Retry unavailable trust checks before making a sensitive change.', evidenceState: 'Unavailable' };
  else if (access && field(access, 'partial')) action = { text: 'Refresh the access inventory with sufficient provider permissions.', evidenceState: 'Stale' };
  else if (access && accessRisk && severity !== 'normal') action = { text: 'Review the access surface and resolve the highest-scoring reason first.', evidenceState: 'Inferred' };
  else if (noChain) action = { text: 'Connect durable evidence storage before relying on audit history.', evidenceState: 'Unavailable' };
  else if (!field(chain, 'valid')) action = { text: 'Re-verify the evidence chain before relying on audit history.', evidenceState: 'Stale' };
  else if (live && !field(live, 'connected')) action = { text: 'Connect verified live events if current event evidence is required.', evidenceState: 'Inferred' };

  const evidenceLine: TrustLine = noChain
    ? { text: 'Supporting evidence is unavailable without durable persistence.', evidenceState: 'Unavailable' }
    : field(chain, 'valid')
      ? { text: `${String(checked || 0)} chained record(s), ${String(field(field(evidence, 'events') || [], 'length'))} event(s), and ${String(field(field(evidence, 'snapshots') || [], 'length'))} snapshot(s) support this summary.`, evidenceState: 'Deterministic' }
      : { text: 'Evidence exists, but its chain is not currently verified.', evidenceState: 'Stale' };

  return {
    connection, pipeline, risk, action, evidence: evidenceLine,
    announcement: failures.length
      ? `Repository trust summary updated with ${failures.length} unavailable check${failures.length === 1 ? '' : 's'}.`
      : 'Repository trust summary updated.'
  };
}
