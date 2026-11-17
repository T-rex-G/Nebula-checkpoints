/*
 * How long a team gives itself to act on a finding.
 *
 * Every open finding has a clock. It starts the first time an audit kept by
 * this server saw the finding -- on any branch of the repository, by the
 * identity that ran the audit -- and runs for the days the repository allows
 * a finding of that severity. A vulnerability CISA lists as exploited, in
 * something that ships, runs on the critical clock whatever its severity:
 * somebody is already using it.
 *
 * The days are the repository's own, from `.nebulaverse/audit.json` on the
 * branch that was audited:
 *
 *   { "sla": { "critical": 7, "serious": 30, "warning": 90 } }
 *
 * "high" and "medium" are read as serious and warning, the words most
 * programmes use for them. A value that is not a whole number of days from 1
 * to 365 is refused and the default kept, and the audit says so rather than
 * quietly running a clock nobody set. Nothing in the file is echoed back:
 * the problems are described in this server's words, never the file's.
 *
 * Pure: no clock here reads the time unless it is given one.
 */

export const POLICY_PATH = '.nebulaverse/audit.json';
const SEVERITIES = Object.freeze(['critical', 'serious', 'warning'] as const);
export type SlaSeverity = (typeof SEVERITIES)[number];
export type Sla = Readonly<Record<SlaSeverity, number>>;
export const DEFAULT_SLA: Sla = Object.freeze({ critical: 7, serious: 30, warning: 90 });
export const SLA_DAYS = Object.freeze({ min: 1, max: 365 });
const ALIASES: Readonly<Record<string, SlaSeverity>> = Object.freeze({ high: 'serious', medium: 'warning' });
export const CLOCK_STATES = Object.freeze(['overdue', 'due-soon', 'on-track'] as const);
export const DAY_MS = 24 * 60 * 60 * 1000;
const own = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key);
const isSeverity = (value: unknown): value is SlaSeverity => (SEVERITIES as readonly unknown[]).includes(value);

/* The clock a repository set, where it came from, and what was wrong with what it wrote. */
export interface AuditPolicy {
  readonly path: string | null;
  readonly source: 'default' | 'invalid' | 'repository';
  readonly sla: Sla;
  readonly problems: readonly string[];
}

function policy(source: AuditPolicy['source'], sla: Sla, problems: readonly string[]): AuditPolicy {
  return Object.freeze({
    path: source === 'default' ? null : POLICY_PATH,
    source,
    sla: Object.freeze({ critical: sla.critical, serious: sla.serious, warning: sla.warning }),
    problems: Object.freeze([...problems])
  });
}

/* The repository's clock, or the defaults when it set none. */
export function readAuditPolicy(files: unknown): AuditPolicy {
  const file = (Array.isArray(files) ? files as readonly unknown[] : []).find(candidate => {
    const entry = candidate as { readonly path?: unknown; readonly text?: unknown } | null | undefined;
    return entry && entry.path === POLICY_PATH && typeof entry.text === 'string';
  }) as { readonly text: string } | undefined;
  if (!file) return policy('default', DEFAULT_SLA, []);
  let json: unknown;
  try { json = JSON.parse(file.text); } catch { return policy('invalid', DEFAULT_SLA, ['The file is not valid JSON, so the default days apply.']); }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return policy('invalid', DEFAULT_SLA, ['The file must hold a JSON object, so the default days apply.']);
  const sla: Record<SlaSeverity, number> = { ...DEFAULT_SLA };
  const problems: string[] = [];
  if (own(json, 'sla')) {
    const given = (json as { readonly sla?: unknown }).sla;
    if (!given || typeof given !== 'object' || Array.isArray(given)) {
      problems.push('"sla" must be an object of days by severity; the default days apply.');
    } else {
      let unknown = false;
      const set = new Set<SlaSeverity>();
      const entries = given as Readonly<Record<string, unknown>>;
      for (const key of Object.keys(entries)) {
        const severity = isSeverity(key) ? key : own(ALIASES, key) ? ALIASES[key] as SlaSeverity : null;
        if (!severity) { unknown = true; continue; }
        /* The engine's own word wins over an alias for the same severity. */
        if (set.has(severity) && !isSeverity(key)) continue;
        const days = entries[key];
        if (Number.isInteger(days) && (days as number) >= SLA_DAYS.min && (days as number) <= SLA_DAYS.max) {
          sla[severity] = days as number;
          set.add(severity);
        } else {
          problems.push(`The ${severity} days must be a whole number from ${SLA_DAYS.min} to ${SLA_DAYS.max}; the default of ${DEFAULT_SLA[severity]} applies.`);
        }
      }
      if (unknown) problems.push('Keys that are not a severity were ignored: use critical, serious and warning.');
    }
  }
  return policy('repository', sla, problems);
}

/* What the clock reads of a finding. */
export interface ClockedFinding {
  readonly severity?: unknown;
  readonly exploited?: unknown;
}

/* The days a finding has: its severity's, or the critical clock for one being exploited. */
export function daysFor(finding: ClockedFinding | null | undefined, sla?: Sla | null): number | null {
  const days = sla || DEFAULT_SLA;
  if (finding && finding.exploited === true) return days.critical;
  return finding && isSeverity(finding.severity) ? days[finding.severity] : null;
}

export interface FindingClock {
  readonly days: number;
  readonly firstSeenAt: string;
  readonly dueAt: string;
  readonly state: (typeof CLOCK_STATES)[number];
  readonly daysLeft: number;
  readonly clock: 'exploited' | 'severity';
}

/*
 * Where a finding stands against its clock. Due soon is the last quarter of
 * the window, never more than a week and never less than a day, so a
 * ninety-day warning is not "due soon" for three weeks.
 */
export function clockOf(finding: ClockedFinding | null | undefined, { firstSeenAt, sla, now = Date.now() }: { readonly firstSeenAt?: unknown; readonly sla?: Sla | null; readonly now?: number } = {}): FindingClock | null {
  const days = daysFor(finding, sla);
  const start = Date.parse(firstSeenAt as string);
  if (!days || !Number.isFinite(start) || !Number.isFinite(now)) return null;
  const dueAt = start + days * DAY_MS;
  const left = dueAt - now;
  const soon = Math.min(7, Math.max(1, Math.ceil(days / 4))) * DAY_MS;
  const state = left < 0 ? 'overdue' : left <= soon ? 'due-soon' : 'on-track';
  return Object.freeze({
    days,
    firstSeenAt: new Date(start).toISOString(),
    dueAt: new Date(dueAt).toISOString(),
    state,
    /* Whole days, rounded away from now: due in a day and a half reads as two; overdue by an hour reads as one. */
    daysLeft: left >= 0 ? Math.ceil(left / DAY_MS) : -Math.ceil(-left / DAY_MS),
    clock: finding && finding.exploited === true && finding.severity !== 'critical' ? 'exploited' : 'severity'
  });
}

/* The days an audit's stored policy gives, or null when it was kept before clocks were. */
export function slaOf(row: { readonly sla?: unknown } | null | undefined): Sla | null {
  if (!row || !row.sla) return null;
  const { critical, serious, warning } = row.sla as Readonly<Record<string, unknown>>;
  const valid = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= SLA_DAYS.min && (value as number) <= SLA_DAYS.max;
  return valid(critical) && valid(serious) && valid(warning) ? Object.freeze({ critical, serious, warning }) : null;
}
