/*
 * The repository audit's screen, decided: what each card says about the
 * view the page holds -- the result, the kept history and its watch, the
 * clocks, the team's decisions, the filters the reader chose -- and which
 * controls it offers. Every value is read as it arrived (platform/values.ts)
 * and every word is the audit's own (audit-terms.ts). Nothing here draws:
 * AuditScreen.tsx and its parts do.
 */
import { field, items } from '../../platform/values.ts';
import {
  CLOCK, DISPOSITION, ORDER, REACH, REACH_TIER, SEVERITY, VERDICT,
  at, capNote, clockWords, coverageCaveat, coverageLine, dayWord, entry, exploited, finite, headline, intelOf,
  isKey, percent, plural, rank, resultId, severityCounts, text, tierSentence, tierWord, verbs, verdictOf
} from './audit-terms.ts';
import type { ClockState, Severity, Tone } from './audit-terms.ts';
import { diffSentence } from './audit-memory.ts';
import type { AuditChanges } from './audit-memory.ts';

/* The marks the model names; the view draws them. */
export const ICON_FLAME = 'M12 3c.8 3.3 5.5 5.4 5.5 10.2A5.5 5.5 0 0 1 6.5 13.2c0-2.3 1.1-3.9 2.5-5.1.2 1.8 1 2.9 2.4 3.4C10.8 8.9 11.2 5.9 12 3z';
export const ICON_GAUGE = 'M4 17.5a8 8 0 1 1 16 0M12 17.5l4.2-5.3M12 17.6v.1';
export const ICON_CLOCK = 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM12 7.4V12l3.1 2';
export const ICON_NEWS = 'M12 3.5l2.2 5.3 5.3 2.2-5.3 2.2L12 18.5l-2.2-5.3L4.5 11l5.3-2.2z';
export const ICON_RANSOM = 'M6.5 10.8h11v9.2h-11zM8.8 10.8V8.2a3.2 3.2 0 0 1 6.4 0v2.6M12 13.6v2.6M12 18.4v.1';
export const ICON_FLAG = 'M5.5 20.5V4M5.5 4.5h11l-2.2 4 2.2 4h-11';
export const ICON_CHECK = 'M5 12.5l4.2 4.2L19 7';

/* ---- Time ----------------------------------------------------------------- */

export interface When {
  readonly relative: string;
  readonly absolute: string;
  readonly short: string;
}
const UNITS: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
/* A moment as a reader says it: "12 minutes ago", and in full for a title or a sentence. */
export function when(iso: unknown, now: number): When {
  const at = typeof iso === 'string' || typeof iso === 'number' ? Date.parse(String(iso)) : Number.NaN;
  if (!Number.isFinite(at)) return { relative: 'at an unknown time', absolute: 'an unknown time', short: '—' };
  const seconds = Math.round((at - now) / 1000);
  let relative = 'just now';
  const unit = UNITS.find(([, span]) => Math.abs(seconds) >= span);
  if (Math.abs(seconds) >= 60 && unit) {
    const [name, size] = unit;
    try { relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(Math.round(seconds / size), name); }
    catch { relative = `${Math.abs(Math.round(seconds / size))} ${name}s ago`; }
  }
  const date = new Date(at);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  const absolute = date.toLocaleString(undefined, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }), hour: '2-digit', minute: '2-digit' });
  const short = date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return { relative, absolute, short };
}

/* ---- What a view holds ------------------------------------------------------ */

export type Status = 'idle' | 'running' | 'done' | 'error';
export const statusOf = (view: unknown): Status => {
  const status = field(view, 'status');
  return status === 'running' || status === 'done' || status === 'error' ? status : 'idle';
};
/* The last kept audit, which stands in for a result until this page runs one: its grade and counts, never its report. */
export function latestStored(view: unknown): unknown {
  const history = field(view, 'history');
  const audits = items(field(history, 'audits'));
  return field(history, 'status') === 'ready' && audits.length ? audits[0] : null;
}
export const findingsOf = (result: unknown): readonly unknown[] => items(field(result, 'findings'));
export const idOf = (value: unknown): string => text(field(value, 'id'));

/* ---- Counts ------------------------------------------------------------------ */

export interface TallyItem {
  readonly severity: Severity;
  readonly count: number;
}
export interface Tally {
  readonly label: string;
  readonly items: readonly TallyItem[];
  /* A critical count lights its chip. */
  readonly beam: boolean;
}
/* Findings counted by severity, the way the tally says them. */
export function findingTally(findings: readonly unknown[]): Tally {
  const counts = severityCounts(findings);
  return {
    label: `${plural(findings.length, 'finding', 'findings')}: ${ORDER.map(severity => `${counts[severity]} ${severity}`).join(', ')}`,
    items: ORDER.map(severity => ({ severity, count: counts[severity] })),
    beam: counts.critical > 0
  };
}
/* A kept audit's counts, which arrive as numbers or not at all. */
export function countTally(counts: unknown): Tally {
  const count = (severity: Severity): number => Number(field(counts, severity)) || 0;
  const total = ORDER.reduce((sum, severity) => sum + count(severity), 0);
  return {
    label: `${plural(total, 'finding', 'findings')}: ${ORDER.map(severity => `${count(severity)} ${severity}`).join(', ')}`,
    items: ORDER.map(severity => ({ severity, count: count(severity) })),
    beam: false
  };
}
export interface Split {
  readonly label: string;
  readonly confirmed: number;
  readonly leads: number;
}
/* Confirmed against to confirm, for a result that carries verdicts. */
export function verdictSplit(findings: readonly unknown[]): Split | null {
  if (!findings.length) return null;
  const leads = findings.filter(finding => verdictOf(finding) === 'needs-validation').length;
  return { label: `${findings.length - leads} confirmed, ${leads} to confirm`, confirmed: findings.length - leads, leads };
}

/* ---- The score -------------------------------------------------------------- */

export interface Ring {
  readonly grade: string;
  readonly label: string;
  readonly running: boolean;
  readonly score: number;
  readonly empty: boolean;
  readonly letter: string;
  readonly said: string;
}
/* The score as a ring: the arc is the score, the letter the grade. */
export function ring(result: unknown, status: Status, label: string): Ring {
  const score = finite(field(result, 'score'));
  const grade = field(result, 'grade');
  const graded = Boolean(result) && score !== null && typeof grade === 'string';
  const drawn = graded && score !== null ? Math.max(0, Math.min(100, score)) : status === 'running' ? 28 : 0;
  return {
    grade: graded ? text(grade) : 'none',
    label,
    running: status === 'running',
    score: drawn,
    /* A round cap on a zero-length arc is a dot, which reads as a score. */
    empty: drawn === 0 && status !== 'running',
    letter: graded ? text(grade) : '—',
    said: graded ? `${text(score)}/100` : status === 'running' ? 'reading' : result ? 'incomplete' : 'not audited'
  };
}

/* ---- The running audit -------------------------------------------------------- */

export interface Step {
  readonly id: string;
  readonly label: string;
  readonly state: 'done' | 'active' | 'next';
}
export interface Progress {
  readonly stage: string;
  readonly steps: readonly Step[];
  readonly line: string;
  readonly fraction: number;
  readonly busy: boolean;
  /* The bar's numbers, when there is a count to give. */
  readonly value: { readonly max: number; readonly now: number; readonly said: string } | null;
  /* What is announced: only a change of step, never the running count. */
  readonly announce: { readonly key: string; readonly said: string };
}
const STAGE_STEPS = Object.freeze([
  { id: 'resolve', label: 'Resolve', stages: ['resolving'] },
  { id: 'read', label: 'Read', stages: ['reading', 'rules'] },
  { id: 'ask', label: 'Check', stages: ['advisories', 'intel'] },
  { id: 'trace', label: 'Trace', stages: ['queued', 'analysing', 'patterns'] }
]);
/* Where a running audit is, in words: numbers and stage names only, the server sends nothing else while it works. */
function stageLine(stage: string, done: number, total: number, progress: unknown): string {
  switch (stage) {
    case 'reading': return total ? `Reading files · ${done} of ${total}` : 'Listing the files to read';
    case 'rules': return `Reading the rest of the branch against the rules · ${done} of ${total}`;
    case 'advisories': return 'Asking the package registries and OSV about each dependency';
    case 'intel': return 'Checking each CVE against CISA’s exploited-vulnerability catalog and its EPSS score';
    case 'queued': return Number(field(progress, 'position')) > 1 ? `Waiting for ${text(field(progress, 'position'))} audits ahead of this one` : 'Waiting for another audit to finish';
    case 'analysing': return 'Mapping endpoints and tracing each value to what uses it';
    case 'patterns': return `Tracing needed more ${field(progress, 'limit') === 'time' ? 'time' : 'memory'} than this server gives one audit, so every file is being checked against the rules instead`;
    default: return 'Resolving the branch to a commit';
  }
}
export function auditProgress(progress: unknown): Progress {
  const asked = field(progress, 'stage');
  const stage = typeof asked === 'string' && asked ? asked : 'resolving';
  const current = Math.max(0, STAGE_STEPS.findIndex(step => step.stages.includes(stage)));
  const total = Math.max(0, Number(field(progress, 'total')) || 0);
  const done = Math.min(total, Math.max(0, Number(field(progress, 'done')) || 0));
  const line = stageLine(stage, Number(field(progress, 'done')) || 0, Number(field(progress, 'total')) || 0, progress);
  const step = STAGE_STEPS[current] ?? STAGE_STEPS[0];
  return {
    stage,
    steps: STAGE_STEPS.map((item, index) => ({ id: item.id, label: item.label, state: index < current ? 'done' : index === current ? 'active' : 'next' })),
    line,
    fraction: current > 1 ? 1 : current === 1 && total ? done / total : 0,
    busy: current > 1,
    value: total ? { max: total, now: current > 1 ? total : done, said: stage === 'rules' ? `${done} of ${total} more files read for the rules` : `${current > 1 ? total : done} of ${total} files read` } : null,
    announce: { key: `${step?.label ?? 'Resolve'}:${stage}`, said: stage === 'reading' ? 'Reading files' : line }
  };
}

/* ---- The summary ---------------------------------------------------------------- */

export type ExportKind = 'brief' | 'sarif' | 'csv' | 'cyclonedx' | 'spdx';
export const REPORT_EXPORTS: readonly ExportKind[] = Object.freeze(['brief', 'sarif', 'csv'] as const);
export interface EvidenceItem {
  readonly icon: 'file' | 'route' | 'box' | 'shield' | 'commit';
  readonly term: string;
  readonly value: string;
  readonly title: string;
}
export interface Engine {
  readonly name: string;
  readonly parts: string;
}
export type SummaryBody =
  | { readonly kind: 'progress'; readonly progress: Progress }
  | { readonly kind: 'stored'; readonly tally: Tally; readonly cap: string | null; readonly note: string }
  | { readonly kind: 'scope' }
  | { readonly kind: 'result'; readonly tally: Tally; readonly split: Split | null; readonly cap: string | null; readonly diff: string | null;
    readonly waived: string | null; readonly clocks: { readonly state: 'overdue' | 'due-soon'; readonly said: string } | null };
export interface Summary {
  readonly scanning: boolean;
  readonly ring: Ring;
  /* Which reading the ring shows, so it grows only for one it has not drawn before. */
  readonly ringId: string | null;
  readonly stored: boolean;
  readonly ref: string;
  readonly verdict: string;
  readonly error: string | null;
  readonly body: SummaryBody;
  readonly evidence: { readonly label: string; readonly items: readonly EvidenceItem[] } | null;
  readonly engine: Engine | null;
  readonly caveat: string;
  readonly run: { readonly label: string; readonly disabled: boolean };
  /* The export menu, with every format when there is a bill of materials and the three reports when there is not. */
  readonly exports: { readonly kinds: readonly ExportKind[] | null } | null;
  readonly prompts: boolean;
}
/* What the audit reads, for the moment before it has read anything. */
export const SCOPE: readonly string[] = Object.freeze(['Traced injection', 'Endpoint access', 'SSRF & redirects', 'AI output', 'Committed secrets', 'Advisories in 8 ecosystems', 'Exploited CVEs (KEV, EPSS)', 'Dependency reach', 'SBOM (CycloneDX, SPDX)', 'Malicious packages', 'CI workflows', 'Supabase RLS', 'Firebase rules', 'Infrastructure', 'Hygiene']);

/* The evidence as figures a reader takes in at a glance; the sentence is the strip's name. */
function evidence(result: unknown): { readonly label: string; readonly items: readonly EvidenceItem[] } {
  const coverage = field(result, 'coverage') || {};
  const read = finite(field(coverage, 'read'));
  const eligible = finite(field(coverage, 'eligible'));
  const list: EvidenceItem[] = [{ icon: 'file', term: 'Files', value: read !== null && eligible !== null ? `${read} of ${eligible}` : 'Not recorded', title: 'Files read of the files the audit reads' }];
  const surface = at(result, 'surface', 'counts');
  if (surface) {
    const reached = (Number(field(surface, 'endpoints')) || 0) + (Number(field(surface, 'actions')) || 0);
    list.push({ icon: 'route', term: 'Endpoints', value: reached ? `${reached} mapped` : 'None found', title: 'Endpoints and server actions a caller can reach, each with the guard in front of it' });
  }
  const packages = field(coverage, 'packages') || {};
  list.push({ icon: 'box', term: 'Registry', value: field(packages, 'declared') ? `${text(field(packages, 'checked'))} of ${text(field(packages, 'declared'))}` : 'None declared', title: 'Declared packages the public registry answered for' });
  const advisories = field(coverage, 'advisories') || {};
  list.push({ icon: 'shield', term: 'Advisories', value: field(advisories, 'versions') ? `${text(field(advisories, 'checked'))} versions` : 'Not asked', title: 'Package versions checked against the OSV vulnerability database' });
  list.push({ icon: 'commit', term: 'Commit', value: text(field(result, 'commitSha')).slice(0, 7) || '—', title: 'The commit this audit read' });
  return { label: coverageLine(result), items: list };
}

/* Which engine read the branch, and how far it followed values. */
function engineLine(result: unknown): Engine | null {
  const engine = field(result, 'engine');
  const traced = field(engine, 'traced');
  if (!engine || !traced) return null;
  const count = (name: string): number => Number(field(traced, name)) || 0;
  const files = ['javascript', 'python', 'go', 'java', 'php'].reduce((sum, language) => sum + count(language), 0);
  const parts = [`${plural(files, 'file', 'files')} traced`];
  if (count('functions')) parts.push(`${plural(count('functions'), 'helper', 'helpers')} summarised`);
  parts.push(`${plural(count('endpoints') + count('actions'), 'entry point', 'entry points')} mapped`);
  if (count('flows')) parts.push(`${plural(count('flows'), 'path', 'paths')} to a sink${count('crossFile') ? `, ${count('crossFile')} across files` : ''}`);
  if (count('failed')) parts.push(`${plural(count('failed'), 'file', 'files')} it could not follow`);
  if (count('cut')) parts.push(`${plural(count('cut'), 'file', 'files')} left to the rules (${field(traced, 'limit') === 'memory' ? 'memory' : 'time'} limit)`);
  if (count('rulesOnly')) parts.push(`${plural(count('rulesOnly'), 'more file', 'more files')} checked against the rules`);
  return { name: `${text(field(engine, 'name'))} ${text(field(engine, 'version')).replace(/\.0$/, '')}`, parts: parts.join(' · ') };
}

export function summary(view: unknown, now: number, offered: { readonly export: boolean; readonly prompts: boolean } = { export: true, prompts: true }): Summary {
  const result = field(view, 'result') || null;
  const status = statusOf(view);
  const stored = !result && status !== 'running' ? latestStored(view) : null;
  const findings = findingsOf(result);
  const label = result ? `Grade ${text(field(result, 'grade'))}, ${text(field(result, 'score'))} out of 100`
    : stored ? `Grade ${text(field(stored, 'grade'))}, ${text(field(stored, 'score'))} out of 100, from the last audit`
      : status === 'running' ? 'Auditing' : 'Not audited';
  let body: SummaryBody;
  if (status === 'running') body = { kind: 'progress', progress: auditProgress(field(view, 'progress')) };
  else if (stored) {
    body = {
      kind: 'stored', tally: countTally(field(stored, 'counts')), cap: capNote(field(stored, 'capReason'), field(stored, 'counts'), true),
      note: `Kept from the audit of ${when(field(stored, 'auditedAt'), now).absolute} at ${text(field(stored, 'commitSha')).slice(0, 7)}. Audit again for the full report: traces, reach and fix prompts are worked out from the code each time and never stored.`
    };
  } else if (!result) body = { kind: 'scope' };
  else {
    /* Counted as the engine counts them: confirmed, and in a category the grade weighs. */
    const unweighed = new Set(items(field(result, 'categories')).filter(category => field(category, 'weight') === 0).map(category => field(category, 'id')));
    const cap = field(result, 'capped')
      ? capNote(field(result, 'capReason'), severityCounts(findings.filter(finding => verdictOf(finding) === 'confirmed' && !unweighed.has(field(finding, 'category')))), false)
      : null;
    const changes = changesOf(field(view, 'diff'));
    const suppressed = items(field(result, 'suppressed'));
    const triaged = suppressed.filter(finding => at(finding, 'suppression', 'triage')).length;
    const waived = suppressed.length - triaged;
    const parts: string[] = [];
    if (waived) parts.push(`${plural(waived, 'finding', 'findings')} waived in code`);
    if (triaged) parts.push(`${plural(triaged, 'finding', 'findings')} triaged by the team`);
    const overdue = findings.filter(finding => at(finding, 'clock', 'state') === 'overdue').length;
    const dueSoon = findings.filter(finding => at(finding, 'clock', 'state') === 'due-soon').length;
    body = {
      kind: 'result', tally: findingTally(findings), split: field(result, 'engine') ? verdictSplit(findings) : null, cap,
      diff: changes ? diffSentence(changes) : null,
      waived: parts.length ? `${parts.join(' and ')}, listed below and not scored.` : null,
      clocks: overdue || dueSoon ? {
        state: overdue ? 'overdue' : 'due-soon',
        said: [overdue ? `${plural(overdue, 'finding', 'findings')} past ${overdue === 1 ? 'its' : 'their'} deadline` : '', dueSoon ? `${dueSoon} due within days` : ''].filter(Boolean).join(', ') + '.'
      } : null
    };
  }
  const shown = result && status !== 'running' ? result : null;
  const components = items(field(result, 'components'));
  return {
    scanning: status === 'running',
    ring: ring(result || stored, status, label),
    ringId: result ? resultId(result) : null,
    stored: Boolean(stored),
    ref: text(field(result, 'ref')) || text(field(stored, 'ref')),
    verdict: stored && status !== 'error' ? `Last audited ${when(field(stored, 'auditedAt'), now).relative}` : headline(result, status),
    error: status === 'error' ? text(field(view, 'error')) || 'The audit could not be completed.' : null,
    body,
    evidence: shown ? evidence(shown) : null,
    engine: shown ? engineLine(shown) : null,
    caveat: shown ? coverageCaveat(shown) : '',
    run: { label: status === 'running' ? 'Auditing…' : result || stored ? 'Audit again' : 'Audit this branch', disabled: status === 'running' },
    exports: result && offered.export ? { kinds: components.length ? null : REPORT_EXPORTS } : null,
    prompts: Boolean(result) && findings.length > 0 && offered.prompts
  };
}

/* The changes the page holds, when it holds some: what is new, and how many are gone. */
export function changesOf(value: unknown): AuditChanges | null {
  const newIds = field(value, 'newIds');
  if (!(newIds instanceof Set)) return null;
  const resolved = field(value, 'resolved');
  return { previousAt: field(value, 'previousAt'), newIds, resolved: typeof resolved === 'number' ? resolved : null };
}

/* ---- Chips a finding carries ------------------------------------------------- */

export interface Chip {
  readonly tone: Tone;
  readonly word: string;
  readonly glyph?: string;
  readonly beam?: boolean;
  readonly className?: string;
  readonly title?: string;
  readonly count?: number;
  readonly zero?: boolean;
  readonly large?: boolean;
}
export const severityChip = (severity: Severity, extra: Omit<Chip, 'tone' | 'word'> = {}): Chip => ({ tone: severity, word: SEVERITY[severity].word, glyph: SEVERITY[severity].icon, ...extra });
export function verdictChip(finding: unknown): Chip {
  const verdict = VERDICT[verdictOf(finding)];
  return { tone: verdict.tone, word: verdict.word, glyph: verdict.icon, className: 'audit-verdict-chip' };
}
export function reachChip(reach: unknown): Chip | null {
  const guard = entry(REACH, field(reach, 'auth'));
  if (!reach || !guard) return null;
  const route = text(field(reach, 'route'));
  const where = route ? `${verbs(field(reach, 'method'))} ${route}` : field(reach, 'method') === 'ACTION' ? 'a server action' : 'this endpoint';
  return { tone: guard.tone, word: guard.word, glyph: guard.icon, className: 'audit-reach', title: `Reached through ${where}` };
}
export function kevChip(finding: unknown, short: boolean): Chip | null {
  const intel = intelOf(finding);
  if (!intel || !field(intel, 'exploited')) return null;
  const kev = field(intel, 'kev');
  const added = text(field(kev, 'added'));
  const title = kev ? `CISA lists ${text(field(kev, 'cve'))} as exploited in the wild${added ? ` since ${added}` : ''}` : 'Exploited in the wild';
  return { tone: 'critical', word: short ? 'Exploited' : 'Exploited in the wild', glyph: ICON_FLAME, beam: exploited(finding), className: 'audit-kev', title };
}
export function epssChip(score: unknown, percentile: unknown, cve: unknown): Chip | null {
  const value = finite(score);
  if (value === null) return null;
  const tone: Tone = value >= 0.1 ? 'serious' : value >= 0.01 ? 'warning' : 'neutral';
  const above = finite(percentile);
  const beyond = above !== null ? `, higher than ${rank(above)} of scored CVEs` : '';
  return { tone, word: `EPSS ${percent(value)}`, glyph: ICON_GAUGE, className: 'audit-epss', title: `${percent(value)} chance ${text(cve)} is exploited in the next 30 days${beyond}` };
}
export function tierChip(usage: unknown): Chip | null {
  const tier = entry(REACH_TIER, field(usage, 'tier'));
  if (!usage || !tier) return null;
  return { tone: tier.tone, word: tierWord(usage), glyph: tier.icon, className: 'audit-tier', title: tierSentence(usage) };
}
export function clockChip(finding: unknown, now: number): Chip | null {
  const clock = field(finding, 'clock');
  const state = field(clock, 'state');
  if (!clock || !isKey(CLOCK, state) || state === 'on-track') return null;
  return {
    tone: CLOCK[state].tone, word: clockWords(clock), glyph: ICON_CLOCK, className: 'audit-clock-chip', beam: state === 'overdue',
    title: `Fix by ${when(field(clock, 'dueAt'), now).short}: ${dayWord(Number(field(clock, 'days')) || 0)} from ${when(field(clock, 'firstSeenAt'), now).short}, when it was first seen`
  };
}

/* A finding's clock in a sentence, for its body. */
export interface ClockLine {
  readonly state: ClockState;
  readonly strong: string;
  readonly rest: string;
}
export function clockLine(finding: unknown, now: number): ClockLine | null {
  const clock = field(finding, 'clock');
  const state = field(clock, 'state');
  if (!clock || !isKey(CLOCK, state)) return null;
  const days = Number(field(clock, 'days')) || 0;
  const why = field(clock, 'clock') === 'exploited'
    ? `${dayWord(days)}, the critical clock, because it is exploited in the wild`
    : `${dayWord(days)} for a ${text(field(finding, 'severity'))} finding`;
  return {
    state,
    strong: state === 'on-track' ? `Fix by ${when(field(clock, 'dueAt'), now).short}` : clockWords(clock),
    rest: ` · first seen ${when(field(clock, 'firstSeenAt'), now).short}${state === 'on-track' ? '' : `, due ${when(field(clock, 'dueAt'), now).short}`} · ${why}`
  };
}

/* ---- The team's decisions ------------------------------------------------------- */

/* A decision's reason in the words the server sent. */
export function reasonLabel(view: unknown, decision: unknown): string {
  const reason = field(decision, 'reason');
  const found = items(at(view, 'triage', 'vocabulary', 'reasons')).find(item => field(item, 'id') === reason);
  return found ? text(field(found, 'label')) : text(field(decision, 'reasonLabel')) || text(reason).replace(/-/g, ' ');
}
export function decisionSentence(decision: unknown, view: unknown, now: number): string {
  const decidedBy = text(field(decision, 'decidedBy'));
  const by = decidedBy ? ` by ${decidedBy}` : '';
  const on = field(decision, 'decidedAt') ? ` on ${when(field(decision, 'decidedAt'), now).short}` : '';
  const expiresAt = field(decision, 'expiresAt');
  const until = field(decision, 'disposition') === 'accepted-risk' && expiresAt
    ? field(decision, 'lapsed') ? `; lapsed ${when(expiresAt, now).short}` : `, until ${when(expiresAt, now).short}` : '';
  return `${entry(DISPOSITION, field(decision, 'disposition'))?.word ?? 'Decided'}${by}${on}${until} — ${reasonLabel(view, decision)}.`;
}
/* Whether the reader may decide: the team's decisions are open to them and the page can take one. */
export const canTriage = (view: unknown, offered: boolean): boolean =>
  offered && at(view, 'triage', 'status') === 'ready' && Boolean(at(view, 'triage', 'canDecide'));
