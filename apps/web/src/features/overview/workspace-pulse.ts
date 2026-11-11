/*
 * The workspace pulse: trust score, capabilities, and activity.
 *
 * The reference design shows "Trust Score 92" and "48 Live signals". Nothing
 * computed either, so shipping those numbers would have meant printing a
 * constant that reads as measured -- the one thing a security product cannot
 * do. This module computes them from signals the session actually holds, and
 * is built so the figures stay honest under every partial state:
 *
 *   - A component with no input is `unknown`. It is shown as unknown and left
 *     out of the mean rather than counted as zero, because "not measured" and
 *     "measured and failing" are different claims.
 *   - With nothing measured at all the score is null and the tile says so. It
 *     never falls back to 0, which would read as a catastrophic result.
 *   - The score is never shown alone. Every component that produced it is on
 *     screen with its own reading, so the number can be argued with.
 *
 * Decided here, drawn by WorkspacePulse.tsx; the charts' geometry is
 * pulse-charts.ts's.
 */
import { field, hasFields, items } from '../../platform/values.ts';

const DAY = 86400000;

export type Status = 'good' | 'warning' | 'critical' | 'unknown' | 'muted';
export type ComponentId = 'exposure' | 'capabilities' | 'scanning' | 'recovery' | 'authentication' | 'visibility';

export interface ComponentDefinition {
  readonly id: ComponentId;
  readonly label: string;
  readonly weight: number;
}

/*
 * Weights sum to 1 across the measured set; unknown components renormalise.
 *
 * Leaked credentials carry the most weight because they are the one reading
 * here that is an incident rather than a posture: a live key in a public
 * tree is being used by somebody else today, whatever else is configured.
 */
export const COMPONENTS: readonly ComponentDefinition[] = Object.freeze([
  Object.freeze({ id: 'exposure', label: 'Leaked credentials', weight: 0.25 }),
  Object.freeze({ id: 'capabilities', label: 'Provider evidence', weight: 0.15 }),
  Object.freeze({ id: 'scanning', label: 'Upload scanning', weight: 0.15 }),
  Object.freeze({ id: 'recovery', label: 'Recovery points', weight: 0.15 }),
  Object.freeze({ id: 'authentication', label: 'Credential reach', weight: 0.15 }),
  Object.freeze({ id: 'visibility', label: 'Private repositories', weight: 0.15 })
] as const);

/*
 * An open critical finding holds the score below this, however well the
 * rest reads. Averaging let five healthy components outvote a leaked
 * production key and print a reassuring number over an active incident.
 */
export const CRITICAL_CAP = 49;

export const GRADES: readonly { readonly grade: string; readonly min: number }[] = Object.freeze([
  Object.freeze({ grade: 'A', min: 90 }),
  Object.freeze({ grade: 'B', min: 80 }),
  Object.freeze({ grade: 'C', min: 70 }),
  Object.freeze({ grade: 'D', min: 60 }),
  Object.freeze({ grade: 'F', min: 0 })
]);

export function gradeOf(score: unknown): string | null {
  if (typeof score !== 'number' || !Number.isFinite(score)) return null;
  const band = GRADES.find(entry => score >= entry.min);
  return band ? band.grade : null;
}

export interface ActivityBucket {
  readonly id: string;
  readonly label: string;
  readonly within: number;
}

export const ACTIVITY_BUCKETS: readonly ActivityBucket[] = Object.freeze([
  Object.freeze({ id: 'day', label: 'Today', within: 1 }),
  Object.freeze({ id: 'week', label: 'This week', within: 7 }),
  Object.freeze({ id: 'month', label: 'This month', within: 30 }),
  Object.freeze({ id: 'quarter', label: 'This quarter', within: 90 }),
  Object.freeze({ id: 'older', label: 'Older', within: Infinity })
]);

function ratioStatus(ratio: number): Status {
  if (ratio >= 0.85) return 'good';
  if (ratio >= 0.6) return 'warning';
  return 'critical';
}

export interface OpenLeaks {
  readonly critical: number;
  readonly serious: number;
  readonly warning: number;
}

export interface Reading extends ComponentDefinition {
  readonly ratio: number | null;
  readonly status: Status;
  readonly detail: string;
  readonly open?: OpenLeaks;
}

function unknown(component: ComponentDefinition, detail: string): Reading {
  return Object.freeze({ ...component, ratio: null, status: 'unknown', detail });
}

function measured(component: ComponentDefinition, ratio: number, detail: string): Reading {
  const bounded = Math.min(1, Math.max(0, ratio));
  return Object.freeze({ ...component, ratio: bounded, status: ratioStatus(bounded), detail });
}

function componentById(id: ComponentId): ComponentDefinition {
  const found = COMPONENTS.find(component => component.id === id);
  if (!found) throw new Error(`no trust component ${id}`);
  return found;
}

export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/* owner/name, lower-cased: how every per-repository reading is matched. */
function repoKey(owner: unknown, name: unknown): string {
  return `${String(owner || '')}/${String(name || '')}`.toLowerCase();
}

function connectedKeys(repos: unknown): Set<string> {
  const keys = new Set<string>();
  for (const repo of items(repos)) {
    if (!repo) continue;
    const listed = field(repo, 'owner');
    const owner = hasFields(listed) ? field(listed, 'login') : listed;
    const name = field(repo, 'name');
    const fullName = field(repo, 'full_name');
    if (owner && name) keys.add(repoKey(owner, name));
    else if (fullName) keys.add(String(fullName).toLowerCase());
  }
  return keys;
}

const EVIDENCE_STATES = Object.freeze(['Provider-verified', 'Deterministic', 'Inferred', 'Stale', 'Unavailable']);

export interface EvidenceCount {
  readonly label: string;
  readonly count: number;
}

interface CapabilitySignals {
  readonly projected: number;
  readonly total: number;
  readonly supported: number;
  readonly providerVerified: number;
  readonly deterministic: number;
  readonly offeredProviderVerified: number;
  readonly offeredEvidenceKnown: number;
  readonly evidence: readonly EvidenceCount[];
}

function capabilitySignals(features: unknown): CapabilitySignals | null {
  if (!features || typeof features !== 'object') return null;
  const values: unknown[] = Object.values(features);
  if (!values.length) return null;
  /* What is not Supported is not offered, so it is neither drawn nor counted. */
  const offered = values.filter(entry => field(entry, 'status') === 'Supported');
  const stateOf = (entry: unknown): unknown => field(entry, 'evidenceState');
  const known = (entry: unknown): boolean => EVIDENCE_STATES.some(state => state === stateOf(entry));
  const evidence: EvidenceCount[] = EVIDENCE_STATES.map(label => Object.freeze({
    label, count: offered.filter(entry => stateOf(entry) === label).length
  }));
  evidence.push(Object.freeze({ label: 'Unknown', count: offered.filter(entry => !known(entry)).length }));
  const verified = evidence[0]?.count ?? 0;
  return Object.freeze({
    projected: values.length,
    total: offered.length,
    supported: offered.length,
    providerVerified: verified,
    deterministic: evidence[1]?.count ?? 0,
    offeredProviderVerified: verified,
    offeredEvidenceKnown: offered.filter(known).length,
    evidence: Object.freeze(evidence)
  });
}

/* Availability is not evidence. Only offered capabilities whose registry
 * evidence is Provider-verified earn credit; stale, inferred and missing
 * evidence do not. This is registry maturity, not a live workspace check or
 * qualification of the current candidate. */
function capabilityComponent(signals: CapabilitySignals | null): Reading {
  const component = componentById('capabilities');
  if (!signals || !signals.projected) return unknown(component, 'Capability projection has not loaded.');
  /* Only what is Supported is offered; nothing else is shown, counted or named. */
  const offered = signals.supported;
  if (!offered) return measured(component, 0, 'This provider offers none of the projected capabilities.');
  if (!signals.offeredEvidenceKnown) return unknown(component, 'Evidence maturity is unknown for the offered capabilities.');
  return measured(component, signals.offeredProviderVerified / offered,
    `${signals.offeredProviderVerified} of ${offered} offered capabilities provider-verified. Based on registry evidence, not a live workspace check or current release qualification.`);
}

function scanningComponent(scanner: unknown): Reading {
  const component = componentById('scanning');
  const active = field(scanner, 'active');
  if (typeof active !== 'boolean') return unknown(component, 'Scanner status has not loaded.');
  if (!active) return measured(component, 0, 'Uploads are not scanned before provider writes.');
  return field(scanner, 'rulesConfigured')
    ? measured(component, 1, 'Configured rules are applied to raw uploads.')
    : measured(component, 0.7, 'Built-in signatures are active; no custom rules are configured.');
}

/*
 * Leaked credentials, from this person's newest finished scan of each
 * connected repository. Severity decides the reading; coverage bounds it --
 * one clean repository out of thirty is not a clean workspace, and saying
 * "healthy" over twenty-nine unread trees would be the score making a claim
 * the scanner never made.
 */
function exposureComponent(posture: unknown, repos: unknown): Reading {
  const component = componentById('exposure');
  const exposure = field(posture, 'exposure');
  if (!exposure) return unknown(component, 'The exposure summary has not loaded.');
  if (!field(exposure, 'available')) {
    return unknown(component, 'Exposure scanning needs the server database, so nothing has been scanned here.');
  }
  const keys = connectedKeys(repos);
  const all = items(field(exposure, 'repositories'));
  const scanned = keys.size ? all.filter(entry => keys.has(repoKey(field(entry, 'owner'), field(entry, 'repo')))) : all;
  if (!scanned.length) {
    return unknown(component, 'No connected repository has been scanned for leaked credentials yet.');
  }
  const open = { critical: 0, serious: 0, warning: 0 };
  const severities = ['critical', 'serious', 'warning'] as const;
  let partial = 0;
  for (const entry of scanned) {
    const counts = field(entry, 'open');
    for (const severity of severities) {
      const count = Math.floor(Number(field(counts, severity)));
      if (Number.isFinite(count) && count > 0) open[severity] += count;
    }
    if (field(entry, 'partial')) partial += 1;
  }
  const total = open.critical + open.serious + open.warning;
  const connected = keys.size || scanned.length;
  const coverage = Math.min(1, scanned.length / connected);
  const read = scanned.length === connected
    ? (connected === 1 ? 'the connected repository was scanned' : `all ${connected} connected repositories scanned`)
    : `${scanned.length} of ${connected} repositories scanned`;
  const partialNote = partial ? `, ${plural(partial, 'scan', 'scans')} partial` : '';
  if (total) {
    const worst = open.critical ? 'critical' : open.serious ? 'serious' : 'warning';
    const counts = severities
      .filter(severity => open[severity])
      .map(severity => `${open[severity]} ${severity}`)
      .join(', ');
    const ratio = worst === 'critical' ? 0 : worst === 'serious' ? 0.4 : 0.75;
    return Object.freeze({
      ...measured(component, ratio, `${plural(total, 'leaked credential', 'leaked credentials')} still exposed (${counts}); ${read}${partialNote}.`),
      open: Object.freeze(open)
    });
  }
  return Object.freeze({
    ...measured(component, 0.6 + (0.4 * coverage), `No open leaked credentials; ${read}${partialNote}.`),
    open: Object.freeze(open)
  });
}

/*
 * Recovery points that exist, not recovery the provider could offer. The
 * old reading was the capability alone, which let the overview print
 * "healthy" beside a topology that said Gap for the same repository.
 */
function recoveryComponent(recoveryStatus: unknown, posture: unknown, repos: unknown, localSnapshots: unknown): Reading {
  const component = componentById('recovery');
  if (!recoveryStatus) return unknown(component, 'Recovery capability has not loaded.');
  if (recoveryStatus === 'Unavailable') return measured(component, 0, 'Recovery is not offered for this provider.');
  const keys = connectedKeys(repos);
  if (!keys.size) return unknown(component, 'No repositories have loaded.');
  const local: ReadonlySet<unknown> = localSnapshots instanceof Set ? localSnapshots : new Set();
  const recovery = field(posture, 'recovery');
  const server = items(field(recovery, 'repositories'));
  if (!posture && !local.size) return unknown(component, 'Recovery points have not loaded.');
  const serverKeys = new Set(server.map(entry => repoKey(field(entry, 'owner'), field(entry, 'repo'))));
  let signed = 0;
  let covered = 0;
  for (const key of keys) {
    if (serverKeys.has(key)) { signed += 1; covered += 1; }
    else if (local.has(key)) covered += 1;
  }
  const parts = [keys.size === 1
    ? (covered ? 'The connected repository has a recovery point' : 'The connected repository has no recovery point')
    : `${covered} of ${keys.size} repositories have a recovery point`];
  if (covered && signed < covered) parts.push(`${covered - signed} held only in this browser`);
  if (field(recovery, 'available') === false) parts.push('signed snapshots need the server database');
  return measured(component, covered / keys.size, `${parts.join('; ')}.`);
}

/*
 * The credential's reach, as the provider reported it for the token that is
 * signed in: its kind, its scopes and its expiry. An installation is scored
 * from the identity alone when the posture has not loaded, because an
 * installation is limited by construction; a token is not scored until its
 * report arrives, because a guess is how every token came to be described as
 * "broader scope" whatever it actually was.
 */
function authenticationComponent(identity: unknown, posture: unknown): Reading {
  const component = componentById('authentication');
  if (!identity) return unknown(component, 'Identity has not loaded.');
  const credential = field(posture, 'credential');
  const detail = field(credential, 'detail');
  if (typeof detail === 'string') {
    const rating = field(credential, 'rating');
    return typeof rating === 'number' && Number.isFinite(rating) ? measured(component, rating, detail) : unknown(component, detail);
  }
  if (field(identity, 'installationId') || field(identity, 'authMethod') === 'github-app') {
    return measured(component, 1, 'GitHub App installation: short-lived tokens, limited to the repositories the installation was given.');
  }
  return unknown(component, 'The credential’s scopes and expiry have not loaded.');
}

function visibilityComponent(repos: unknown): Reading {
  const component = componentById('visibility');
  const list = items(repos);
  if (!list.length) return unknown(component, 'No repositories have loaded.');
  const priv = list.filter(repo => field(repo, 'private')).length;
  return measured(component, priv / list.length, `${priv} of ${list.length} connected repositories are private.`);
}

/*
 * A daily series over the trailing window, for the area chart the design
 * draws across the card. The buckets below still carry the same repositories
 * -- they are the same measurement read at two grains, so the summary and the
 * plot can never disagree.
 */
export const SERIES_DAYS = 60;

export const ROLLING_DAYS = 7;

function dailySeries(stamps: readonly number[], now: number): { rolling: number[]; total: number } {
  const counts = new Array<number>(SERIES_DAYS).fill(0);
  for (const stamp of stamps) {
    const age = Math.floor((now - stamp) / DAY);
    if (age >= 0 && age < SERIES_DAYS) counts[SERIES_DAYS - 1 - age] = (counts[SERIES_DAYS - 1 - age] ?? 0) + 1;
  }
  /*
   * Read as a trailing seven-day count rather than a raw daily one. Pushes
   * are bursty, so the raw series is a flat line with a few spikes, which
   * says less about activity than it appears to. The window is named in the
   * caption and in the chart's description -- a smoothed series presented as
   * a raw one would be the chart lying about its own grain.
   */
  const rolling = counts.map((_, index) => {
    let total = 0;
    for (let back = 0; back < ROLLING_DAYS; back += 1) {
      const at = index - back;
      if (at >= 0) total += counts[at] ?? 0;
    }
    return total;
  });
  /*
   * The window total counts repositories, not plotted points. Summing the
   * rolling series instead would count each push once per day it stays in
   * the window -- which is how a card ends up claiming more repositories
   * than the workspace has.
   */
  return { rolling, total: counts.reduce((sum, value) => sum + value, 0) };
}

export interface CountedBucket extends ActivityBucket {
  readonly count: number;
}

export interface ActivityView {
  readonly measured: boolean;
  readonly total: number;
  readonly unknownCount: number;
  readonly windowDays: number;
  readonly rollingDays: number;
  readonly windowTotal: number;
  readonly series: readonly number[];
  readonly buckets: readonly CountedBucket[];
}

function activity(repos: unknown, now: number): ActivityView {
  const list = items(repos);
  const stamps = list
    .map(repo => Date.parse(String(field(repo, 'pushed_at') || field(repo, 'pushedAt') || '')))
    .filter(value => Number.isFinite(value));
  const counts = ACTIVITY_BUCKETS.map(() => 0);
  for (const stamp of stamps) {
    const age = (now - stamp) / DAY;
    const index = ACTIVITY_BUCKETS.findIndex(entry => age < entry.within);
    const at = index === -1 ? counts.length - 1 : index;
    counts[at] = (counts[at] ?? 0) + 1;
  }
  const daily = dailySeries(stamps, now);
  return Object.freeze({
    measured: stamps.length > 0,
    total: stamps.length,
    unknownCount: list.length - stamps.length,
    windowDays: SERIES_DAYS,
    rollingDays: ROLLING_DAYS,
    windowTotal: daily.total,
    series: Object.freeze(daily.rolling),
    buckets: Object.freeze(ACTIVITY_BUCKETS.map((bucket, index) => Object.freeze({ ...bucket, count: counts[index] ?? 0 })))
  });
}

export interface TrustView {
  readonly score: number | null;
  readonly grade: string | null;
  readonly capped: boolean;
  readonly status: Status;
  readonly measuredCount: number;
  readonly componentCount: number;
  readonly attention: number;
  readonly components: readonly Reading[];
}

export interface BreakdownPart {
  readonly id: 'provider-verified' | 'deterministic' | 'other';
  readonly label: string;
  readonly count: number;
  readonly status: Status;
}

export interface SignalsView {
  readonly measured: boolean;
  readonly live: number;
  readonly total: number;
  readonly providerVerified: number;
  readonly evidence: readonly EvidenceCount[];
  readonly breakdown: readonly BreakdownPart[];
}

export interface PulseView {
  readonly trust: TrustView;
  readonly signals: SignalsView;
  readonly activity: ActivityView;
}

export interface PulseInput {
  readonly now?: unknown;
  readonly features?: unknown;
  readonly scanner?: unknown;
  readonly recoveryStatus?: unknown;
  readonly identity?: unknown;
  readonly posture?: unknown;
  readonly repos?: unknown;
  readonly localSnapshots?: unknown;
}

export function model(input: PulseInput = {}): PulseView {
  const now = typeof input.now === 'number' && Number.isFinite(input.now) ? input.now : Date.now();
  const signals = capabilitySignals(input.features);
  const exposure = exposureComponent(input.posture, input.repos);
  const components: readonly Reading[] = Object.freeze([
    exposure,
    capabilityComponent(signals),
    scanningComponent(input.scanner),
    recoveryComponent(input.recoveryStatus, input.posture, input.repos, input.localSnapshots),
    authenticationComponent(input.identity, input.posture),
    visibilityComponent(input.repos)
  ]);

  const known = components.filter(component => component.status !== 'unknown');
  const weight = known.reduce((total, component) => total + component.weight, 0);
  const mean = weight > 0
    ? Math.round((known.reduce((total, c) => total + ((c.ratio ?? 0) * c.weight), 0) / weight) * 100)
    : null;
  const capped = mean !== null && !!(exposure.open && exposure.open.critical) && mean > CRITICAL_CAP;
  const score = capped ? CRITICAL_CAP : mean;

  return Object.freeze({
    trust: Object.freeze({
      score,
      grade: gradeOf(score),
      capped,
      status: score === null ? 'unknown' : ratioStatus(score / 100),
      measuredCount: known.length,
      componentCount: components.length,
      attention: components.filter(c => c.status === 'warning' || c.status === 'critical').length,
      components
    }),
    signals: Object.freeze({
      measured: !!signals,
      live: signals ? signals.supported : 0,
      total: signals ? signals.total : 0,
      providerVerified: signals ? signals.providerVerified : 0,
      evidence: signals ? signals.evidence : Object.freeze([]),
      /* Offered capabilities by the strength of the evidence behind them, strongest first. */
      breakdown: Object.freeze(signals ? ([
        Object.freeze({ id: 'provider-verified', label: 'Provider-verified', count: signals.providerVerified, status: 'good' }),
        Object.freeze({ id: 'deterministic', label: 'Deterministic', count: signals.deterministic, status: 'warning' }),
        Object.freeze({ id: 'other', label: 'Other evidence', count: signals.total - signals.providerVerified - signals.deterministic, status: 'muted' })
      ] as const).filter(part => part.id !== 'other' || part.count > 0) : [])
    }),
    activity: activity(input.repos, now)
  });
}

/*
 * Languages across the connected set, as a radar.
 *
 * This replaced a tile that read "Languages 7". Seven is true and it is not
 * an answer: it cannot say which seven, nor that one of them is nearly the
 * whole estate and the rest are a file each. A radar puts every language on
 * its own spoke against a shared scale, so the shape of the estate is the
 * thing you see rather than a number you have to go and expand.
 *
 * Three spokes minimum, because a polygon needs three corners: with one or
 * two languages the chart is a line or a dot pretending to be a shape, and
 * the caller is told to keep its tile instead. Eight maximum, because past
 * that the labels collide and every extra spoke is a slice of angle nobody
 * can measure -- the tail folds into one "Other" spoke that says how many
 * it stands for.
 */
export const RADAR_MIN_AXES = 3;
export const RADAR_MAX_AXES = 8;

export interface LanguageAxis {
  readonly label: string;
  readonly count: number;
  /* On the "Other" spoke: how many languages it stands for. */
  readonly folded?: number;
}

export function languageSpread(repos: unknown): LanguageAxis[] {
  const counts = new Map<string, number>();
  for (const repo of items(repos)) {
    const language = field(repo, 'language');
    const name = typeof language === 'string' ? language.trim() : '';
    if (!name) continue;
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  const ranked = [...counts].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  if (ranked.length <= RADAR_MAX_AXES) {
    return ranked.map(([label, count]) => ({ label, count }));
  }
  const kept: LanguageAxis[] = ranked.slice(0, RADAR_MAX_AXES - 1).map(([label, count]) => ({ label, count }));
  const rest = ranked.slice(RADAR_MAX_AXES - 1);
  kept.push({
    label: 'Other',
    count: rest.reduce((total, entry) => total + entry[1], 0),
    folded: rest.length
  });
  return kept;
}

/* --------------------------------------------------------------- the feed */

/*
 * How long ago, in words. Absolute dates past a month: "63d ago" is
 * arithmetic the reader has to do, and by then the exact day is the more
 * useful fact anyway.
 */
export function since(at: number, now: number): string {
  if (!Number.isFinite(at)) return '';
  const seconds = Math.max(0, (now - at) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 2592000) return `${Math.floor(seconds / 86400)}d ago`;
  return new Date(at).toLocaleDateString();
}

export const KIND_LABEL: Readonly<Record<string, string>> = Object.freeze({
  commit: 'Commit', pull: 'Pull request', issue: 'Issue', release: 'Release'
});

export interface FeedEvent {
  readonly kind: string;
  readonly repo: string;
  readonly at: number;
  readonly title: string;
  readonly ref: string;
  readonly detail: string;
  readonly actor: string;
}

/* One event of the feed, read as text. Its time is a number, as the server sends it, or a date in words; anything else is no time. */
export function feedEvent(value: unknown): FeedEvent {
  const text = (name: string): string => {
    const read = field(value, name);
    return read === null || read === undefined ? '' : String(read);
  };
  const at = field(value, 'at');
  return {
    kind: text('kind'),
    repo: text('repo'),
    at: typeof at === 'number' ? at : typeof at === 'string' ? Date.parse(at) : Number.NaN,
    title: text('title'),
    ref: text('ref'),
    detail: text('detail'),
    actor: text('actor')
  };
}

/*
 * The evidence line: which commit, which number, who. Without it the row is
 * a claim the reader cannot go and check, which is the one thing this
 * surface is not allowed to be. The reference is deduplicated, never the
 * actor: a user's name can happen to be a prefix of a hash and remains a
 * different fact.
 */
export function feedMarks(event: FeedEvent): string[] {
  const ref = event.ref.trim();
  const detail = event.detail.trim();
  return [ref, detail && !ref.startsWith(detail) ? detail : '', event.actor].filter(Boolean);
}

export interface DayCount {
  readonly at: number;
  readonly count: number;
  readonly partial: boolean;
  readonly label: string;
}

/*
 * The feed's own events, counted into days.
 *
 * Derived rather than requested: a second read would be a second set of
 * provider round trips for numbers this card already holds, and two reads
 * of a moving target disagree. Days are walked backwards from now so the
 * last slot is today whatever hour it is, and an event with no usable time
 * is left out of the count rather than dropped into the nearest day -- the
 * feed reports those separately and this chart must not quietly absorb them.
 */
export function dailyCommits(events: unknown, now: number, days: unknown): DayCount[] {
  const span = Math.max(1, Math.min(Number(days) || 7, 60));
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const today = midnight.getTime();
  const slots: { at: number; count: number; partial: boolean; label: string }[] = [];
  for (let back = span - 1; back >= 0; back -= 1) {
    const at = today - back * DAY;
    slots.push({
      at,
      count: 0,
      partial: back === 0,
      label: back === 0 ? 'today' : new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    });
  }
  for (const event of items(events)) {
    const stamp = field(event, 'at');
    const at = typeof stamp === 'number' && Number.isFinite(stamp) ? stamp : Date.parse(String(stamp || ''));
    if (!Number.isFinite(at)) continue;
    const age = Math.floor((today - new Date(at).setHours(0, 0, 0, 0)) / DAY);
    const slot = slots[span - 1 - age];
    if (age >= 0 && age < span && slot) slot.count += 1;
  }
  return slots;
}

export interface FeedFailure {
  readonly repo: string;
  readonly reason: string;
}

/* What the feed has read, as the page holds it, read once into what the card says. */
export interface FeedReading {
  readonly state: 'read';
  /* Which of the four answers the body gives: nothing to read, nothing readable, nothing happened, or what happened. */
  readonly body: 'no-repositories' | 'unmeasured' | 'quiet' | 'events';
  readonly events: readonly FeedEvent[];
  readonly days: number;
  readonly repositories: number;
  readonly inventoryCount: number;
  readonly perRepositoryLimit: number;
  readonly truncated: boolean;
  readonly totalEvents: number;
  readonly generatedAt: number | null;
  readonly undated: number;
  readonly failed: readonly FeedFailure[];
  readonly now: number;
}

/*
 * The feed is fetched, not computed, so unlike the cards above it has a state
 * before it has an answer. All four are drawn rather than left blank: loading,
 * nothing readable, nothing happened, and something happened.
 */
export type FeedView =
  | { readonly state: 'loading' }
  | { readonly state: 'error'; readonly message: string }
  | FeedReading;

export function feedView(current: unknown): FeedView {
  if (!current || field(current, 'loading')) return { state: 'loading' };
  const error = field(current, 'error');
  if (error) return { state: 'error', message: String(error) };
  const failed = items(field(current, 'failed')).map(entry => ({ repo: String(field(entry, 'repo') ?? ''), reason: String(field(entry, 'reason') ?? '') }));
  const inventoryCount = Number(field(current, 'inventoryCount')) || 0;
  const events = items(field(current, 'events')).map(feedEvent);
  const now = field(current, 'now');
  const generated = Date.parse(String(field(current, 'generatedAt') ?? ''));
  const body: FeedReading['body'] = !inventoryCount && !failed.length ? 'no-repositories'
    : !field(current, 'measured') ? 'unmeasured'
      : !events.length ? 'quiet' : 'events';
  return {
    state: 'read',
    body,
    events,
    days: Number(field(current, 'days')) || 0,
    repositories: items(field(current, 'repositories')).length,
    inventoryCount,
    perRepositoryLimit: Number(field(current, 'perRepositoryLimit')) || 20,
    truncated: !!field(current, 'truncated'),
    totalEvents: Number(field(current, 'totalEvents')) || 0,
    generatedAt: Number.isFinite(generated) ? generated : null,
    undated: Number(field(current, 'undated')) || 0,
    failed,
    now: typeof now === 'number' && Number.isFinite(now) ? now : Date.now()
  };
}

/* "repository" or "repositories", as the count it follows. */
export function repositories(count: number): string {
  return `repositor${count === 1 ? 'y' : 'ies'}`;
}
