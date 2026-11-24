/*
 * The kept history, decided: the clocks and the time to fix (Remediation),
 * the score over time, every kept audit of the branch and what each found,
 * as it kept it. Read from the history, so it exists only where the history
 * does. Nothing here draws (AuditHistory.tsx does).
 */
import { field, items } from '../../platform/values.ts';
import { ORDER, RISK_BAND, VERDICT, at, dayWord, entry, plural, severityOf, text } from './audit-terms.ts';
import type { Severity } from './audit-terms.ts';
import { ICON_CHECK, ICON_FLAME, ICON_NEWS, idOf, when } from './audit-screen.ts';
import type { Chip } from './audit-screen.ts';

/* ---- Remediation ---------------------------------------------------------------- */

/*
 * How long a branch gives itself to fix what it finds, where it stands
 * against that, and how long fixing has taken: the clock per severity from
 * the branch's policy, the open findings past or near their deadline, and
 * the time from first seen to gone for every finding the kept audits saw
 * fixed in the last ninety days. Read from the kept history, so it exists
 * only where the history does.
 */
export function fixDays(value: unknown): string {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  const number = Number(value);
  if (number < 1) return number < 1 / 24 ? 'under an hour' : `${Math.max(1, Math.round(number * 24))} h`;
  return `${number >= 10 ? Math.round(number) : number.toFixed(1).replace(/\.0$/, '')} d`;
}
export interface Tile {
  readonly label: string;
  readonly value: string;
  readonly sub: string;
  readonly tone: string | null;
}
export interface RemediationRow {
  readonly severity: Severity;
  readonly cells: readonly { readonly label: string; readonly value: string; readonly alert: boolean }[];
}
export type Remediation =
  | { readonly kind: 'loading'; readonly lede: string }
  | { readonly kind: 'error'; readonly lede: string; readonly error: string }
  | { readonly kind: 'ready'; readonly lede: string; readonly tiles: readonly Tile[]; readonly rows: readonly RemediationRow[];
    readonly notes: readonly { readonly className: string; readonly said: string }[] };
export function remediation(view: unknown): Remediation | null {
  const metrics = field(view, 'metrics');
  const status = field(metrics, 'status');
  if (!metrics || status === 'idle' || status === 'unavailable') return null;
  const history = field(view, 'history');
  const audits = items(field(history, 'audits'));
  if (field(history, 'status') !== 'ready' || !audits.length) return null;
  const lede = `How long ${text(field(audits[0], 'ref'))} gives itself to fix what an audit finds, where its open findings stand against that, and how long fixing has taken.`;
  if (status === 'loading' && !field(metrics, 'data')) return { kind: 'loading', lede };
  if (status === 'error') return { kind: 'error', lede, error: text(field(metrics, 'error')) || 'The clocks could not be read.' };
  const data = field(metrics, 'data') || {};
  const open = field(data, 'open') || null;
  const mttr = field(data, 'mttr') || {};
  const sla = field(data, 'sla') || null;
  const windowDays = text(field(mttr, 'windowDays')) || '90';
  const tiles: Tile[] = [];
  if (open) {
    const overdue = field(open, 'overdue');
    const dueSoon = field(open, 'dueSoon');
    tiles.push(
      { label: 'Overdue', value: text(overdue), sub: overdue ? 'past their deadline' : 'none past due', tone: overdue ? 'critical' : 'good' },
      { label: 'Due soon', value: text(dueSoon), sub: 'in the last stretch', tone: dueSoon ? 'warning' : null },
      { label: 'On track', value: text(field(open, 'onTrack')), sub: `of ${plural(field(open, 'total'), 'open finding', 'open findings')}`, tone: null }
    );
  }
  const all = field(mttr, 'all') || { count: 0 };
  const fixedCount = field(all, 'count');
  tiles.push({ label: 'Median time to fix', value: fixedCount ? fixDays(field(all, 'medianDays')) : '—',
    sub: fixedCount ? `${plural(fixedCount, 'finding', 'findings')} fixed in ${windowDays} days` : `nothing fixed in ${windowDays} days`, tone: null });
  const rows = ORDER.map(severity => {
    const counts = field(field(open, 'bySeverity'), severity) || null;
    const fix = field(mttr, severity) || { count: 0 };
    const clockDays = field(sla, severity);
    return {
      severity,
      cells: [
        { label: 'Clock', value: sla ? dayWord(Number(clockDays) || 0) : '—', alert: false },
        { label: 'Open', value: counts ? text(field(counts, 'open')) : '—', alert: false },
        { label: 'Overdue', value: counts ? text(field(counts, 'overdue')) : '—', alert: Boolean(counts && field(counts, 'overdue')) },
        { label: 'Median fix', value: field(fix, 'count') ? fixDays(field(fix, 'medianDays')) : '—', alert: false },
        { label: 'Fixed', value: text(field(fix, 'count') || 0), alert: false }
      ]
    };
  });
  const notes: { className: string; said: string }[] = [];
  if (sla) {
    const policy = at(view, 'result', 'policy');
    const source = field(sla, 'source') === 'repository' ? 'set in .nebulaverse/audit.json on this branch'
      : field(sla, 'source') === 'invalid' ? 'the defaults: .nebulaverse/audit.json could not be read'
        : 'the defaults; set your own in .nebulaverse/audit.json';
    const days = (severity: Severity): string => dayWord(Number(field(sla, severity)) || 0);
    notes.push({ className: 'audit-coverage', said: `Clock: ${days('critical')} for critical, ${days('serious')} for serious, ${days('warning')} for warnings — ${source}. A vulnerability exploited in the wild runs on the critical clock.` });
    for (const problem of items(field(policy, 'problems'))) notes.push({ className: 'exposure-caveat', said: text(problem) });
  }
  const oldest = field(data, 'oldest');
  if (oldest && open && field(open, 'total')) {
    notes.push({ className: 'audit-coverage', said: `Oldest open finding: ${dayWord(Number(field(oldest, 'days')) || 0)} since it was first seen (${text(field(oldest, 'rule'))}, ${text(field(oldest, 'severity'))}).` });
  }
  const triage = field(data, 'triage');
  if (triage) {
    const parts: string[] = [];
    if (field(triage, 'falsePositive')) parts.push(plural(field(triage, 'falsePositive'), 'false positive', 'false positives'));
    if (field(triage, 'acceptedRisk')) parts.push(`${plural(field(triage, 'acceptedRisk'), 'risk accepted', 'risks accepted')}${field(triage, 'expiringSoon') ? `, ${text(field(triage, 'expiringSoon'))} lapsing within two weeks` : ''}`);
    if (field(triage, 'lapsed')) parts.push(`${plural(field(triage, 'lapsed'), 'acceptance', 'acceptances')} lapsed`);
    notes.push({ className: 'audit-coverage', said: parts.length ? `Team decisions on this repository: ${parts.join(' · ')}.` : 'No team decisions on this repository yet.' });
  } else if (field(data, 'triageUnavailable')) {
    notes.push({ className: 'exposure-caveat', said: 'The team’s decisions could not be read, so findings they cover are counted as open.' });
  }
  notes.push({ className: 'audit-coverage', said: 'Time to fix counts a finding as fixed when the next audit of the branch, by the same engine and reading every file, no longer finds it.' });
  return { kind: 'ready', lede, tiles, rows, notes };
}

/* ---- History ---------------------------------------------------------------------- */

export interface TrendPoint {
  readonly id: string;
  readonly key: string;
  readonly x: number;
  readonly y: number;
  readonly grade: string;
  readonly latest: boolean;
  readonly said: string;
  readonly side: 'start' | 'middle' | 'end';
}
export interface Trend {
  readonly ticks: readonly { readonly grade: string; readonly y: number; readonly title: string }[];
  readonly line: string | null;
  readonly points: readonly TrendPoint[];
  readonly caption: string;
}
/*
 * The score over time: one series, so no legend -- the heading names it.
 * The line is drawn stretched with a stroke that does not stretch; the
 * points are buttons laid over it, each with a name and a tooltip; the list
 * below is the table view.
 */
export function trend(audits: readonly unknown[], now: number): Trend {
  const series = audits.slice(0, 30).reverse();
  const scores = series.map(audit => Number(field(audit, 'score')) || 0);
  const floor = Math.max(0, Math.min(50, Math.floor((Math.min(...scores) - 8) / 10) * 10));
  const y = (score: number): number => 100 - ((score - floor) / (100 - floor)) * 100;
  const x = (index: number): number => (series.length === 1 ? 50 : (index / (series.length - 1)) * 100);
  const describe = (audit: unknown): string => {
    const diff = field(audit, 'diff');
    const change = diff ? ` · ${text(field(diff, 'new'))} new, ${text(field(diff, 'resolved'))} resolved` : '';
    return `${when(field(audit, 'auditedAt'), now).absolute} · Grade ${text(field(audit, 'grade'))}, ${text(field(audit, 'score'))} · ${text(field(audit, 'commitSha')).slice(0, 7)}${change}`;
  };
  const first = series[0];
  const last = series[series.length - 1];
  return {
    ticks: ([['A', 90], ['B', 80], ['C', 70], ['D', 60]] as const).filter(([, threshold]) => threshold > floor)
      .map(([grade, threshold]) => ({ grade, y: y(threshold), title: `${grade}: ${threshold} and above` })),
    line: series.length > 1 ? series.map((_, index) => `${x(index)},${y(scores[index] ?? 0)}`).join(' ') : null,
    points: series.map((audit, index) => ({
      id: idOf(audit),
      key: `trend:${idOf(audit)}`,
      x: x(index),
      y: y(scores[index] ?? 0),
      grade: text(field(audit, 'grade')),
      latest: index === series.length - 1,
      said: describe(audit),
      side: x(index) > 66 ? 'end' : x(index) < 34 ? 'start' : 'middle'
    })),
    caption: series.length > 1
      ? `Score over the last ${series.length} audits, from ${text(field(first, 'score'))} (${text(field(first, 'grade'))}) on ${when(field(first, 'auditedAt'), now).short} to ${text(field(last, 'score'))} (${text(field(last, 'grade'))}) on ${when(field(last, 'auditedAt'), now).short}.`
      : 'The trend appears after the next audit of this branch.'
  };
}

export interface HistoryFinding {
  readonly hiddenUnlessAll: boolean;
  readonly severity: Severity | null;
  readonly title: string;
  readonly where: string;
  readonly whereTitle: string | null;
  readonly tags: readonly Chip[];
}
export type HistoryBody =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly error: string }
  | { readonly kind: 'empty'; readonly said: string; readonly kept: string }
  | { readonly kind: 'ready'; readonly kept: string; readonly label: string; readonly rows: readonly HistoryFinding[]; readonly cut: string | null; readonly waived: string | null };
export const HISTORY_FINDINGS = 40;
/* What a kept audit found, as it kept it: waived rows are kept for their clocks, and the list is what was open. */
export function historyBody(detail: unknown, audit: unknown, now: number): HistoryBody {
  const status = field(detail, 'status');
  if (!detail || status === 'loading') return { kind: 'loading' };
  if (status === 'error') return { kind: 'error', error: text(field(detail, 'error')) || 'This audit could not be read.' };
  const all = items(field(detail, 'findings'));
  const open = all.filter(finding => !field(finding, 'waived'));
  const waivedCount = all.length - open.length;
  const counted = field(audit, 'findings');
  const stored = field(counted, 'stored');
  const total = field(counted, 'total');
  const cut = Boolean(counted) && Number(stored) < Number(total);
  const kept = `This audit · ${text(field(audit, 'commitSha')).slice(0, 7)} · ${cut ? `${text(stored)} of ${text(total)} findings kept` : `${plural(counted ? total : 0, 'finding', 'findings')} kept`}`;
  if (!open.length) {
    return { kind: 'empty', kept, said: waivedCount
      ? `Nothing open: ${plural(waivedCount, 'finding was', 'findings were')} waived in code or triaged by the team.`
      : 'This audit found nothing in what it read.' };
  }
  return {
    kind: 'ready',
    kept,
    label: `What the audit of ${when(field(audit, 'auditedAt'), now).absolute} found`,
    rows: open.map((finding, index) => {
      const pkg = field(finding, 'package');
      const path = text(field(finding, 'path'));
      const line = field(finding, 'line');
      const fixed = text(field(pkg, 'fixed'));
      const advisoryIds = items(field(pkg, 'advisories'));
      const riskOfFinding = field(finding, 'risk');
      const band = entry(RISK_BAND, field(riskOfFinding, 'band'));
      const tags: Chip[] = [];
      if (field(finding, 'verdict') === 'needs-validation') tags.push({ tone: VERDICT['needs-validation'].tone, word: 'To confirm', glyph: VERDICT['needs-validation'].icon });
      if (field(finding, 'exploited')) tags.push({ tone: 'critical', word: 'Exploited', glyph: ICON_FLAME, className: 'audit-kev' });
      if (riskOfFinding && band) tags.push({ tone: band.tone, word: `Risk ${text(field(riskOfFinding, 'score'))}`, className: 'audit-hist-risk' });
      return {
        hiddenUnlessAll: index >= HISTORY_FINDINGS,
        severity: severityOf(finding),
        title: text(field(finding, 'title')),
        where: pkg ? `${text(field(pkg, 'name'))} ${text(field(pkg, 'version'))}${fixed ? ` → ${fixed}` : ''}` : path ? `${path}${line ? `:${text(line)}` : ''}` : '',
        whereTitle: pkg && advisoryIds.length ? advisoryIds.map(text).join(', ') : null,
        tags
      };
    }),
    cut: cut ? `${text(stored)} of ${text(total)} findings were kept, the most severe first.` : null,
    waived: waivedCount ? `${plural(waivedCount, 'more was', 'more were')} waived in code or triaged by the team.` : null
  };
}

export interface HistoryRow {
  readonly id: string;
  readonly open: boolean;
  readonly grade: string;
  readonly score: string;
  readonly at: string;
  readonly absolute: string;
  readonly latest: boolean;
  readonly shown: boolean;
  readonly sub: string;
  readonly tags: readonly Chip[];
  readonly name: string;
  readonly body: HistoryBody | null;
}
export interface History {
  readonly ref: string;
  readonly lede: string;
  readonly trend: Trend;
  readonly rows: readonly HistoryRow[];
  readonly others: string | null;
  readonly clear: { readonly armed: boolean; readonly disabled: boolean };
}
export function history(view: unknown, now: number): History | null {
  const kept = field(view, 'history');
  const audits = items(field(kept, 'audits'));
  if (field(kept, 'status') !== 'ready' || !audits.length) return null;
  const ref = text(field(audits[0], 'ref'));
  const shownId = at(view, 'result', 'history', 'auditId');
  const openIds = field(view, 'historyOpen');
  const details = field(view, 'historyDetail');
  const isOpen = (id: unknown): boolean => openIds instanceof Set && openIds.has(id);
  const detailOf = (id: unknown): unknown => (details instanceof Map ? details.get(id) : undefined);
  const others = items(field(kept, 'branches')).filter(branch => field(branch, 'ref') !== ref);
  return {
    ref,
    lede: `Every audit of ${ref} you ran, newest first. Each keeps its grade, its counts and every finding’s rule, place and package — never any of the code.`,
    trend: trend(audits, now),
    rows: audits.map((audit, index) => {
      const id = field(audit, 'id');
      const counts = field(audit, 'counts');
      const said = ORDER.filter(severity => field(counts, severity)).map(severity => `${text(field(counts, severity))} ${severity}`);
      const diff = field(audit, 'diff');
      const tags: Chip[] = [];
      if (diff) {
        if (field(diff, 'new')) tags.push({ tone: 'info', word: 'new', count: Number(field(diff, 'new')) || 0, glyph: ICON_NEWS, className: 'audit-hist-new' });
        if (field(diff, 'resolved')) tags.push({ tone: 'good', word: 'resolved', count: Number(field(diff, 'resolved')) || 0, glyph: ICON_CHECK, className: 'audit-hist-resolved' });
        if (!field(diff, 'new') && !field(diff, 'resolved')) tags.push({ tone: 'neutral', word: 'No change', className: 'audit-hist-same' });
      }
      if (field(audit, 'exploited')) tags.push({ tone: 'critical', word: 'exploited', count: Number(field(audit, 'exploited')) || 0, glyph: ICON_FLAME });
      const absolute = when(field(audit, 'auditedAt'), now).absolute;
      const commit = text(field(audit, 'commitSha')).slice(0, 7);
      return {
        id: text(id),
        open: isOpen(id),
        grade: text(field(audit, 'grade')),
        score: text(field(audit, 'score')),
        at: text(field(audit, 'auditedAt')),
        absolute,
        latest: index === 0,
        shown: Boolean(shownId) && shownId === id,
        sub: [commit, said.length ? said.join(' · ') : 'nothing found'].join(' · '),
        tags,
        name: `Audit of ${absolute} at ${commit}: grade ${text(field(audit, 'grade'))}, ${text(field(audit, 'score'))} out of 100${diff ? `, ${text(field(diff, 'new'))} new, ${text(field(diff, 'resolved'))} resolved` : ''}`,
        body: isOpen(id) ? historyBody(detailOf(id), audit, now) : null
      };
    }),
    others: others.length ? `Also audited: ${others.map(branch => `${text(field(branch, 'ref'))} (${plural(field(branch, 'audits'), 'audit', 'audits')})`).join(', ')}. Open a branch to see its history.` : null,
    clear: { armed: field(view, 'historyArmed') === true, disabled: field(kept, 'clearing') === true }
  };
}
