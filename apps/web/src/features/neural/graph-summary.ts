/*
 * What the Neural command center says about the repository at a glance: the
 * readings it could not take whole, the risk it scores from what it did read,
 * the four summary cards above the stage, the state of its stream, and how
 * long ago a thing happened.
 *
 * Every reading is the server's answer as it came, read through
 * platform/values.ts: one missing, or not the shape promised, says nothing
 * rather than stopping the summary half drawn.
 */
import { field, items } from '../../platform/values.ts';

/* How long ago, in the largest whole unit, and a date past a month. */
export function timeAgo(date: unknown, now: number): string {
  if (!date) return 'unknown time';
  const d = typeof date === 'number' ? new Date(date) : date instanceof Date ? date : new Date(String(date));
  if (!Number.isFinite(d.getTime())) return String(date);
  const sec = Math.max(0, (now - d.getTime()) / 1000);
  if (sec < 60) return `${Math.floor(sec)}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  if (sec < 2592000) return `${Math.floor(sec / 86400)}d ago`;
  return d.toLocaleDateString();
}

const truthy = (value: unknown): boolean => Boolean(value);
/* A score as a number: one that is none counts nothing (the classic page scored the repository NaN). */
const scoreOf = (value: unknown): number => {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
};

/* The readings, by the name the map gives each, that a gap is looked for in. */
const READINGS: readonly (readonly [string, string])[] = [
  ['Activity', 'activity'], ['References', 'refs'], ['Dependencies', 'deps'], ['Sessions', 'sessions'], ['Live events', 'live'],
  ['Event history', 'intelligence'], ['Recovery', 'signedSnapshots'], ['Access', 'access'], ['Exposure', 'exposure']
];
const DATED: readonly (readonly [string, string])[] = [['commits', 'date'], ['pulls', 'updated'], ['issues', 'updated'], ['releases', 'published']];

/*
 * What the map could not read whole: a source that failed, or answered that
 * it was unavailable, partial, truncated or had more; dependencies whose
 * advisory database was out of reach; activity some source of which was cut
 * short, or which carries a time that is no time; and an event history whose
 * catch-up failed. Nothing read at all is one gap, the map's data.
 */
export function dataGaps(data: unknown, catchUpError: boolean): string[] {
  if (!data) return ['Map data'];
  const gaps = new Set<string>();
  for (const name of items(field(data, 'unavailable'))) gaps.add(String(name));
  for (const [name, key] of READINGS) {
    const value = field(data, key);
    if (value && (field(value, 'available') === false || field(value, 'partial') || field(value, 'truncated') || field(value, 'hasMore') || field(value, 'truncatedBefore'))) gaps.add(name);
  }
  const deps = field(data, 'deps');
  if (deps && field(field(deps, 'osv'), 'available') === false) gaps.add('Dependencies');
  const activity = field(data, 'activity');
  if (activity) {
    const sources = field(activity, 'sources');
    if (Object.values(sources && typeof sources === 'object' ? sources : {}).some(source => source && field(source, 'requested') !== false && (field(source, 'available') === false || field(source, 'truncated')))) gaps.add('Activity');
    if (DATED.some(([kind, at]) => items(field(activity, kind)).some(item => !field(item, at) || !Number.isFinite(Date.parse(String(field(item, at))))))) gaps.add('Activity timestamps');
  }
  if (catchUpError) gaps.add('Event history');
  return [...gaps];
}

export type Level = 'critical' | 'warning' | 'good';

/* The four summary cards, the read-only and live controls, and whether the emergency containment is on. */
export interface Summary {
  readonly risk: { readonly text: string; readonly level: Level; readonly hint: string; readonly score: number };
  readonly signals: string;
  readonly protectedCount: string;
  readonly recovery: { readonly text: string; readonly level: Level; readonly hint: string };
  readonly emergency: boolean;
  readonly readOnlyLabel: string;
  readonly live: { readonly disabled: boolean; readonly label: string; readonly short: string; readonly title: string };
}

export interface SummaryInput {
  readonly data: unknown;
  readonly nodes: readonly { readonly type: string; readonly severity: string }[];
  readonly events: number;
  readonly work: { readonly owner: string; readonly repo: string };
  readonly catchUpError: boolean;
  readonly now: number;
}

/*
 * The risk is the worst of three readings -- what the graph shows (critical
 * and warning advisories, failed runs, other sessions), the highest verified
 * event, and the access surface's own score -- nudged up for no snapshot and
 * nothing protected, down for read-only, and never below critical while a
 * credential is exposed. Where the readings were incomplete the card says so
 * rather than scoring what it could not see.
 */
export function summarize(input: SummaryInput): Summary {
  const { data: d, nodes } = input;
  const of = (type: string, severity: string): number => nodes.filter(n => n.type === type && n.severity === severity).length;
  const vulnCritical = of('vulnerability', 'critical');
  const vulnWarnings = of('vulnerability', 'warning');
  const criticalLeaks = of('leak', 'critical');
  const failedRuns = items(field(d, 'actions')).filter(a => field(a, 'conclusion') === 'failure' || field(a, 'conclusion') === 'cancelled').length;
  const safety = field(d, 'safety');
  /* The repository's protected files: a reading that is not a list protects none (the classic page showed its length, or NaN). */
  const protectedN = items(field(field(safety, 'protected'), `${input.work.owner}/${input.work.repo}`)).length;
  const protectedBranches = items(field(field(d, 'refs'), 'refs')).filter(r => field(r, 'protected')).length;
  const signed = field(d, 'signedSnapshots');
  const latestSigned = signed && items(field(signed, 'snapshots'))[0];
  const stored = field(d, 'storedSnapshot');
  const hasSnapshot = truthy((latestSigned && field(latestSigned, 'signatureValid') === true) || stored);
  const invalidSnapshot = truthy(latestSigned && field(latestSigned, 'signatureValid') !== true);
  /* Asked only where there is no snapshot, local or signed. */
  const recoveryUnknown = truthy(signed && field(signed, 'available') === false);
  const otherSessions = items(field(field(d, 'sessions'), 'sessions')).filter(s => !field(s, 'current')).length;
  const verified = items(field(field(d, 'intelligence'), 'events'));
  const highestVerified = verified.reduce<number>((m, e) => Math.max(m, scoreOf(field(e, 'score'))), 0);
  const accessRiskOf = field(field(d, 'access'), 'risk');
  const accessRisk = scoreOf(field(accessRiskOf, 'score'));
  let risk = Math.max(12 + vulnCritical * 22 + vulnWarnings * 9 + failedRuns * 6 + otherSessions * 3, highestVerified, accessRisk);
  if (!hasSnapshot) risk += 9;
  if (!protectedN && !protectedBranches) risk += 7;
  if (field(safety, 'readOnly')) risk -= 10;
  if (criticalLeaks) risk = Math.max(75, risk);
  risk = Math.max(0, Math.min(100, Math.round(risk)));
  const gaps = dataGaps(d, input.catchUpError);
  const label = risk >= 75 ? 'Critical' : risk >= 50 ? 'Elevated' : risk >= 28 ? 'Guarded' : 'Low';
  const level: Level = risk >= 75 ? 'critical' : risk >= 40 ? 'warning' : 'good';
  const latestCritical = [...verified].reverse().find(e => field(e, 'severity') === 'critical');
  const accessReason = items(field(accessRiskOf, 'reasons'))[0];
  const reasonOf = (reason: unknown, fallback: string): string => (reason ? String(field(reason, 'message')) : fallback);
  let hint = criticalLeaks ? `${criticalLeaks} critical exposed credential signal(s)`
    : latestCritical ? `${String(field(latestCritical, 'summary'))} · ${reasonOf(items(field(latestCritical, 'reasons'))[0], `risk ${String(field(latestCritical, 'score'))}`)}`
    : accessRisk >= 70 ? `Critical access path · ${reasonOf(accessReason, `risk ${accessRisk}`)}`
    : vulnCritical ? `${vulnCritical} critical vulnerability signal(s)`
    : failedRuns ? `${failedRuns} failed workflow run(s)`
    : accessRisk >= 35 ? `Access posture warning · ${reasonOf(accessReason, `risk ${accessRisk}`)}`
    : gaps.length ? `Incomplete sources: ${gaps.join(', ')}` : 'No critical signals in the observed data';
  if (gaps.length && (criticalLeaks || latestCritical || accessRisk >= 35 || vulnCritical || failedRuns)) hint += ` · Incomplete: ${gaps.join(', ')}`;
  const recoveryText = invalidSnapshot ? 'Unverified' : hasSnapshot ? 'Captured' : recoveryUnknown ? 'Unknown' : 'Gap';
  const recoveryHint = invalidSnapshot ? 'Retained snapshot signature could not be verified'
    : hasSnapshot ? `${latestSigned ? 'Verified' : 'Local'} snapshot ${timeAgo(latestSigned ? field(latestSigned, 'createdAt') : field(stored, 'capturedAt'), input.now)}`
    : recoveryUnknown ? 'Recovery evidence could not be read' : 'Capture refs before an incident';
  const live = field(d, 'live');
  const connected = truthy(field(live, 'connected'));
  const available = truthy(field(live, 'available'));
  return {
    risk: { text: gaps.length ? `${risk >= 75 ? 'Critical · ' : ''}Incomplete` : `${label} · ${risk}`, level: gaps.length && risk < 75 ? 'warning' : level, hint, score: risk },
    signals: String(input.events),
    protectedCount: String(protectedN + protectedBranches),
    recovery: { text: recoveryText, level: hasSnapshot && !invalidSnapshot ? 'good' : 'warning', hint: recoveryHint },
    emergency: truthy(field(safety, 'readOnly') && field(safety, 'freezeSync')),
    readOnlyLabel: field(safety, 'readOnly') ? 'Disable read-only' : 'Enable read-only',
    live: {
      disabled: !available,
      label: connected ? 'Disconnect verified live events' : 'Connect verified live events',
      short: connected ? 'Disconnect' : 'Live events',
      title: available ? '' : String(field(live, 'reason') || 'Neon and GitHub are required')
    }
  };
}

export type LiveStatus = 'disconnected' | 'connecting' | 'live' | 'reconnecting' | string;

/* What the stream says it is doing: paused, behind, live, or polling what it could read. */
export function streamLabel(state: { readonly paused: boolean; readonly catchUpError: boolean; readonly data: unknown; readonly liveStatus: LiveStatus }): string {
  if (state.paused) return 'PAUSED';
  if (state.catchUpError) return 'EVENT HISTORY UNAVAILABLE';
  if (field(field(state.data, 'intelligence'), 'hasMore')) return 'LIVE CATCHING UP';
  if (state.liveStatus === 'live') return 'VERIFIED LIVE';
  if (state.liveStatus === 'connecting') return 'LIVE CONNECTING';
  if (state.liveStatus === 'reconnecting') return 'LIVE RECONNECTING';
  return dataGaps(state.data, false).length ? 'PARTIAL TOPOLOGY' : 'POLLING TOPOLOGY';
}
