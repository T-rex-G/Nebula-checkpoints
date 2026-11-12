/*
 * The audit's words: what Uranus calls each thing it found, how sure it is
 * and how far it read, said once for the screen (AuditScreen.tsx and its
 * models) and for every export (audit-reports.ts, audit-sbom.ts), so a
 * brief, a SARIF file and the screen never disagree about a finding.
 *
 * Every value is read from the result as it arrived: a field of something
 * that has fields, or nothing (platform/values.ts). A name is looked up in
 * a table only when the table has it as its own, so a severity, a band or a
 * state named like a property of every object (`toString`) is no entry.
 * Nothing here draws.
 */
import { field, items } from '../../platform/values.ts';

export type Severity = 'critical' | 'serious' | 'warning';
export type Tone = 'critical' | 'serious' | 'warning' | 'neutral' | 'pending' | 'good' | 'info';
export type Verdict = 'confirmed' | 'needs-validation';

/* A word and the mark drawn with it. */
export interface Mark {
  readonly word: string;
  readonly icon: string;
}
export interface ToneMark extends Mark {
  readonly tone: Tone;
}
export interface Word {
  readonly word: string;
  readonly tone: Tone;
}

/* ---- Reading -------------------------------------------------------------- */

/* The value at a path of fields: what `a.b.c` read where every step had fields, and undefined where one did not. */
export function at(value: unknown, ...names: readonly string[]): unknown {
  let current = value;
  for (const name of names) current = field(current, name);
  return current;
}

/* A field's value as text, or nothing. */
export const text = (value: unknown): string => (value === null || value === undefined ? '' : String(value));

/* A number that is one, or null: a count sent as text is not a count. */
export const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/* Whether `key` names an entry of `table` itself, and not one every object inherits. */
export function isKey<K extends string>(table: Readonly<Record<K, unknown>>, key: unknown): key is K {
  return typeof key === 'string' && Object.hasOwn(table, key);
}

/* The entry `key` names, or none. */
export function entry<K extends string, T>(table: Readonly<Record<K, T>>, key: unknown): T | undefined {
  return isKey(table, key) ? table[key] : undefined;
}

/* ---- Words ---------------------------------------------------------------- */

export const ORDER: readonly Severity[] = Object.freeze(['critical', 'serious', 'warning'] as const);
export const SEVERITY: Readonly<Record<Severity, Mark & { readonly glyph: string }>> = Object.freeze({
  critical: Object.freeze({ glyph: '✕', word: 'Critical', icon: 'M8.6 3.5h6.8l5.1 5.1v6.8l-5.1 5.1H8.6l-5.1-5.1V8.6zM9.4 9.4l5.2 5.2M14.6 9.4l-5.2 5.2' }),
  serious: Object.freeze({ glyph: '△', word: 'Serious', icon: 'M12 4l9 15.5H3zM12 10v4.2M12 16.9v.1' }),
  warning: Object.freeze({ glyph: '○', word: 'Warning', icon: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM12 11v5M12 7.9v.1' })
});
/* A finding's severity, when it is one of the three. */
export const severityOf = (finding: unknown): Severity | null => {
  const severity = field(finding, 'severity');
  return isKey(SEVERITY, severity) ? severity : null;
};

/*
 * How sure a finding is, as Uranus says it: confirmed when the file states
 * it or the whole path was traced, to confirm when the pattern is there and
 * one decisive fact is not. A result from before Uranus carries no verdict
 * and reads as confirmed, which is what it was presented as then.
 */
export const VERDICT: Readonly<Record<Verdict, ToneMark>> = Object.freeze({
  confirmed: Object.freeze({ word: 'Confirmed', tone: 'info', icon: 'M12 3.3l7.2 3v5.3c0 4.3-3 7.9-7.2 9.4-4.2-1.5-7.2-5.1-7.2-9.4V6.3zM9.3 12l2 2 3.5-3.8' }),
  'needs-validation': Object.freeze({ word: 'To confirm', tone: 'pending', icon: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM9.7 9.7a2.4 2.4 0 1 1 3.3 2.2c-.7.3-1 .8-1 1.4v.5M12 16.6v.1' })
});
export const verdictOf = (finding: unknown): Verdict => (field(finding, 'verdict') === 'needs-validation' ? 'needs-validation' : 'confirmed');

/* How the evidence for a finding was had, in the brief's words. */
export const EVIDENCE_WORD: Readonly<Record<string, string>> = Object.freeze({ traced: 'path traced', surface: 'endpoint map', fact: 'stated in the file', pattern: 'pattern only' });

/* Who can reach the line a traced value entered on. */
export const LOCK = 'M6.5 10.8h11v9.2h-11zM8.8 10.8V8.2a3.2 3.2 0 0 1 6.4 0v2.6';
export const REACH: Readonly<Record<'open' | 'guarded' | 'unknown' | 'platform', ToneMark>> = Object.freeze({
  open: Object.freeze({ word: 'Open to anyone', tone: 'critical', icon: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM3.5 12h17M12 3.5c2.6 2.4 3.8 5.3 3.8 8.5s-1.2 6.1-3.8 8.5c-2.6-2.4-3.8-5.3-3.8-8.5S9.4 5.9 12 3.5z' }),
  guarded: Object.freeze({ word: 'After sign-in', tone: 'neutral', icon: LOCK }),
  unknown: Object.freeze({ word: 'Guard to confirm', tone: 'pending', icon: LOCK }),
  platform: Object.freeze({ word: 'Platform-guarded', tone: 'neutral', icon: LOCK })
});

/* A traced path's steps, in the words each role is said with. */
export const STEP_ROLE: Readonly<Record<'entrypoint' | 'propagation' | 'sink', string>> = Object.freeze({ entrypoint: 'Enters', propagation: 'Passes', sink: 'Reaches' });

export type LedgerStatus = 'covered' | 'traced' | 'mapped' | 'partial' | 'patterns' | 'not-applicable' | 'not-assessed';
export const LEDGER_STATUS: Readonly<Record<LedgerStatus, ToneMark>> = Object.freeze({
  covered: Object.freeze({ word: 'Checked', tone: 'good', icon: 'M5 12.5l4.2 4.2L19 7' }),
  traced: Object.freeze({ word: 'Traced', tone: 'good', icon: 'M5 6.5h4a3 3 0 0 1 3 3v5a3 3 0 0 0 3 3h4M17 15.5l2 2-2 2M4.5 6.5h.1' }),
  mapped: Object.freeze({ word: 'Mapped', tone: 'good', icon: 'M5 5h5a3 3 0 0 1 0 6H8a3 3 0 0 0 0 6h11M16 14l3 3-3 3' }),
  partial: Object.freeze({ word: 'Partly traced', tone: 'warning', icon: 'M12 3.5a8.5 8.5 0 1 0 0 17V3.5z' }),
  patterns: Object.freeze({ word: 'Patterns only', tone: 'pending', icon: 'M4 7h16M4 12h10M4 17h6' }),
  'not-applicable': Object.freeze({ word: 'Nothing to check', tone: 'neutral', icon: 'M6 12h12' }),
  'not-assessed': Object.freeze({ word: 'Not assessed', tone: 'pending', icon: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM9.7 9.7a2.4 2.4 0 1 1 3.3 2.2c-.7.3-1 .8-1 1.4v.5M12 16.6v.1' })
});
/* The classes Uranus follows values through, as opposed to checking files for. */
export const TRACED_CLASSES: ReadonlySet<string> = new Set(['injection', 'requests', 'browser', 'objects', 'ai']);
/* A coverage line's status: a covered class Uranus traces says so, and the endpoint map says it mapped. */
export function ledgerStatus(line: unknown): LedgerStatus {
  const status = field(line, 'status');
  const id = field(line, 'id');
  if (status === 'covered' && typeof id === 'string' && TRACED_CLASSES.has(id)) return 'traced';
  if (status === 'covered' && id === 'access') return 'mapped';
  return isKey(LEDGER_STATUS, status) ? status : 'not-assessed';
}

/*
 * How close a vulnerable package is to the running code, as Uranus placed
 * it. None of these words says "unused": a package with no import found is
 * "installed", because frameworks load packages by convention.
 */
export type ReachTier = 'imported' | 'named' | 'bundled' | 'transitive' | 'installed' | 'unknown' | 'build' | 'test' | 'dev';
const CODE = 'M9 7.5L4.5 12 9 16.5M15 7.5l4.5 4.5-4.5 4.5';
const TOOL = 'M14.7 6.3a4 4 0 0 0-5.2 5.2L4 17v3h3l5.5-5.5a4 4 0 0 0 5.2-5.2l-2.6 2.6-2.4-.6-.6-2.4z';
export const UNKNOWN_ICON = 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM9.7 9.7a2.4 2.4 0 1 1 3.3 2.2c-.7.3-1 .8-1 1.4v.5M12 16.6v.1';
export const REACH_TIER: Readonly<Record<ReachTier, ToneMark>> = Object.freeze({
  imported: Object.freeze({ word: 'Imported', icon: CODE, tone: 'neutral' }),
  named: Object.freeze({ word: 'Named in code', icon: CODE, tone: 'neutral' }),
  bundled: Object.freeze({ word: 'Bundled', icon: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9M8 5.3l8 4.4', tone: 'neutral' }),
  transitive: Object.freeze({ word: 'Via a dependency', icon: 'M12 4l8 4-8 4-8-4zM4 12l8 4 8-4M4 16l8 4 8-4', tone: 'neutral' }),
  installed: Object.freeze({ word: 'Installed', icon: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9', tone: 'neutral' }),
  unknown: Object.freeze({ word: 'Reach unknown', icon: UNKNOWN_ICON, tone: 'pending' }),
  build: Object.freeze({ word: 'Build only', icon: TOOL, tone: 'neutral' }),
  test: Object.freeze({ word: 'Tests only', icon: 'M9.5 3.5h5M10.5 3.5v6L5.3 18.4a1.4 1.4 0 0 0 1.2 2.1h11a1.4 1.4 0 0 0 1.2-2.1L13.5 9.5v-6M8 15h8', tone: 'neutral' }),
  dev: Object.freeze({ word: 'Dev only', icon: TOOL, tone: 'neutral' })
});
/* The tiers that ship: a vulnerability exploited in one of these holds the grade. */
export const PRODUCTION_TIERS: ReadonlySet<string> = new Set(['imported', 'named', 'bundled', 'transitive', 'installed', 'unknown']);

/* Risk bands in the status tones, each with its word: never colour alone. */
export type RiskBand = 'urgent' | 'high' | 'moderate' | 'low';
export const RISK_BAND: Readonly<Record<RiskBand, Word>> = Object.freeze({
  urgent: Object.freeze({ word: 'Urgent', tone: 'critical' }),
  high: Object.freeze({ word: 'High', tone: 'serious' }),
  moderate: Object.freeze({ word: 'Moderate', tone: 'warning' }),
  low: Object.freeze({ word: 'Low', tone: 'neutral' })
});
export const RISK_ORDER: readonly RiskBand[] = Object.freeze(['urgent', 'high', 'moderate', 'low'] as const);
export const ECOSYSTEM_NAME: Readonly<Record<string, string>> = Object.freeze({ npm: 'npm', pypi: 'PyPI', go: 'Go', maven: 'Maven', packagist: 'Composer', rubygems: 'RubyGems', cargo: 'Cargo', nuget: 'NuGet' });

export type LicenceFamily = 'public-domain' | 'permissive' | 'weak-copyleft' | 'strong-copyleft' | 'network-copyleft' | 'restricted' | 'none' | 'unknown';
export const LICENCE_FAMILY: Readonly<Record<LicenceFamily, Word>> = Object.freeze({
  'public-domain': Object.freeze({ word: 'Public domain', tone: 'good' }),
  permissive: Object.freeze({ word: 'Permissive', tone: 'good' }),
  'weak-copyleft': Object.freeze({ word: 'Weak copyleft', tone: 'neutral' }),
  'strong-copyleft': Object.freeze({ word: 'Strong copyleft', tone: 'warning' }),
  'network-copyleft': Object.freeze({ word: 'Network copyleft', tone: 'serious' }),
  restricted: Object.freeze({ word: 'Restricted use', tone: 'serious' }),
  none: Object.freeze({ word: 'No licence', tone: 'critical' }),
  unknown: Object.freeze({ word: 'Unknown', tone: 'pending' })
});
export const LICENCE_ORDER: readonly LicenceFamily[] = Object.freeze(['none', 'restricted', 'network-copyleft', 'strong-copyleft', 'weak-copyleft', 'unknown', 'permissive', 'public-domain'] as const);

/* When a finding is due, as its clock says. */
export type ClockState = 'overdue' | 'due-soon' | 'on-track';
export const CLOCK: Readonly<Record<ClockState, Word>> = Object.freeze({
  overdue: Object.freeze({ tone: 'critical', word: 'Overdue' }),
  'due-soon': Object.freeze({ tone: 'warning', word: 'Due soon' }),
  'on-track': Object.freeze({ tone: 'neutral', word: 'On track' })
});
export const DISPOSITION: Readonly<Record<'false-positive' | 'accepted-risk', Word>> = Object.freeze({
  'false-positive': Object.freeze({ word: 'False positive', tone: 'neutral' }),
  'accepted-risk': Object.freeze({ word: 'Risk accepted', tone: 'pending' })
});

/* The deployed site's headers and checks, in the names a reader knows them by. */
export const HEADER_NAMES: Readonly<Record<string, string>> = Object.freeze({
  'strict-transport-security': 'Strict-Transport-Security',
  'content-security-policy': 'Content-Security-Policy',
  'x-frame-options': 'X-Frame-Options',
  'x-content-type-options': 'X-Content-Type-Options',
  'referrer-policy': 'Referrer-Policy',
  'permissions-policy': 'Permissions-Policy',
  'cross-origin-opener-policy': 'Cross-Origin-Opener-Policy',
  'cross-origin-resource-policy': 'Cross-Origin-Resource-Policy'
});
/* A header's job in three words, under its name on the tile. */
export const HEADER_JOBS: Readonly<Record<string, string>> = Object.freeze({
  'strict-transport-security': 'HTTPS only',
  'content-security-policy': 'Script sources',
  'x-frame-options': 'No framing',
  'x-content-type-options': 'No sniffing',
  'referrer-policy': 'Leaks no URLs',
  'permissions-policy': 'Device features',
  'cross-origin-opener-policy': 'Window isolation',
  'cross-origin-resource-policy': 'Resource isolation'
});
export const LEDGER_NAMES: Readonly<Record<string, string>> = Object.freeze({
  certificate: 'Certificate', protocol: 'TLS', 'plain-http': 'Plain HTTP', hsts: 'HSTS', headers: 'Security headers', cookies: 'Cookies',
  cors: 'Cross-origin reads', paths: 'Exposed files', errors: 'Error pages', robots: 'Crawler instructions', pages: 'Pages read', scripts: 'JavaScript', maps: 'Source maps',
  libraries: 'Libraries', contact: 'Security contact', email: 'Email spoofing'
});
export type CheckState = 'pass' | 'fail' | 'warn' | 'skip' | 'unknown';
export const LEDGER_GLYPH: Readonly<Record<CheckState, string>> = Object.freeze({ pass: '✓', fail: '✕', warn: '!', skip: '–', unknown: '?' });
export const LEDGER_STATE: Readonly<Record<CheckState, string>> = Object.freeze({ pass: 'Passed', fail: 'Failed', warn: 'Worth a look', skip: 'Skipped', unknown: 'Not answered' });

/* ---- Sentences ------------------------------------------------------------ */

export function plural(count: unknown, one: string, many: string): string {
  return `${text(count)} ${count === 1 ? one : many}`;
}

/* Where a finding is: a file and line, a file, or the whole repository. */
export function location(finding: unknown): string {
  const path = text(field(finding, 'path'));
  if (!path) return 'Whole repository';
  const line = field(finding, 'line');
  return line ? `${path}:${text(line)}` : path;
}

/* The methods a route answers, as a reader writes them: GET/POST. */
export const verbs = (method: unknown): string => String(method || 'ANY').split(',').join('/');

/* A finding's facts beside its title: which credential, which package and its fix. */
export function detailChip(finding: unknown): string | null {
  const detail = field(finding, 'detail');
  if (!detail) return null;
  const rule = field(finding, 'rule');
  const name = text(field(detail, 'package'));
  const version = text(field(detail, 'version'));
  if (rule === 'SCR-001' && field(detail, 'credential')) return text(field(detail, 'credential'));
  if (rule === 'DEP-004') return `${name} ≈ ${text(field(detail, 'resembles'))}`;
  if (field(finding, 'category') === 'licences' && name) return `${name} ${version} · ${text(field(detail, 'licence')) || 'no licence'}`;
  if (name) {
    if (rule === 'DEP-006') return `${name} ${version}`;
    const fixed = text(field(detail, 'fixed'));
    return fixed ? `${name} ${version} → ${fixed}` : `${name} ${version}`;
  }
  return null;
}

/* A licence finding's facts, in the words the finding body and the brief share. */
export function licenceFactList(detail: unknown): readonly (readonly [string, string])[] {
  const family = entry(LICENCE_FAMILY, field(detail, 'family')) ?? LICENCE_FAMILY.unknown;
  const facts: (readonly [string, string])[] = [
    ['Licence', `${text(field(detail, 'licence')) || 'none stated'} (${family.word.toLowerCase()})`],
    ['Package', `${text(field(detail, 'package'))} ${text(field(detail, 'version'))}, ${field(detail, 'dev') ? 'installed for development only' : field(detail, 'direct') ? 'asked for by the project' : 'a transitive dependency'}`],
    ['Read from', field(detail, 'source') === 'lockfile' ? 'the lockfile' : 'deps.dev']
  ];
  const project = text(field(detail, 'project'));
  if (project) facts.push(['Project licence', project]);
  const policy = text(field(detail, 'policy'));
  if (policy) facts.push(['Policy', `${field(detail, 'reason') === 'denied' ? 'refused by' : 'not allowed by'} ${policy}`]);
  return facts;
}

/* ---- Exploit intelligence and reach --------------------------------------- */

/* A probability as a reader says it: 21%, 3.4%, 0.04%. */
export function percent(value: unknown): string {
  const number = Number(value) * 100;
  if (!Number.isFinite(number)) return '';
  if (number >= 10) return `${Math.round(number)}%`;
  if (number >= 1) return `${number.toFixed(1).replace(/\.0$/, '')}%`;
  if (number >= 0.01) return `${number.toFixed(2).replace(/0$/, '')}%`;
  return '<0.01%';
}
/* A rank among scored CVEs, rounded down so it never claims more than it is: 99.7%, never 100%. */
export function rank(value: unknown): string {
  const number = Number(value) * 100;
  if (!Number.isFinite(number)) return '';
  return number >= 99 || number < 10 ? `${(Math.floor(number * 10) / 10).toString()}%` : `${Math.floor(number)}%`;
}
export const intelOf = (finding: unknown): unknown => at(finding, 'detail', 'intel') || null;
export const usageOf = (finding: unknown): unknown => at(finding, 'detail', 'usage') || null;
export const riskOf = (finding: unknown): unknown => at(finding, 'detail', 'risk') || null;

/* Exploited in the wild, in something that ships: what holds the grade and leads the list. */
export function exploited(finding: unknown): boolean {
  const intel = intelOf(finding);
  const usage = usageOf(finding);
  return Boolean(intel && field(intel, 'exploited') && field(finding, 'rule') !== 'DEP-005' && (!usage || PRODUCTION_TIERS.has(text(field(usage, 'tier')))));
}

/* The reach in two or three words: the tier, or the dependency a transitive package comes with. */
export function tierWord(usage: unknown): string {
  if (!usage) return '';
  const through = items(field(usage, 'through'));
  if (field(usage, 'tier') === 'transitive' && through.length) return `Via ${text(through[0])}`;
  return (entry(REACH_TIER, field(usage, 'tier')) ?? REACH_TIER.unknown).word;
}

/* A list of names as a sentence says it, with how many more there are than were sent. */
function names(list: unknown, total: unknown): string {
  const shown = items(list).filter(Boolean).map(text);
  if (!shown.length) return '';
  const said = shown.length === 1 ? text(shown[0]) : `${shown.slice(0, -1).join(', ')} and ${text(shown[shown.length - 1])}`;
  const all = Number(total);
  return all > shown.length ? `${shown.join(', ')} and ${all - shown.length} more` : said;
}

/* The reach, as one sentence that never claims more than the scan saw. */
export function tierSentence(usage: unknown): string {
  if (!usage) return '';
  const files = names(field(usage, 'files'), field(usage, 'count'));
  const through = names(field(usage, 'through'), field(usage, 'throughCount'));
  switch (field(usage, 'tier')) {
    case 'imported': return `Imported by the code${files ? `: ${files}` : ''}.`;
    case 'named': return field(usage, 'loader') === 'bundler'
      ? `Loaded at boot by Bundler.require${files ? ` (${files})` : ''}, which requires every gem the Gemfile lists for production.`
      : `Named in the code where a framework loads it by name${files ? `: ${files}` : ''}.`;
    case 'bundled': return `Shipped by the build: bundled, or served from node_modules${files ? ` (${files})` : ''}.`;
    case 'transitive': return `Not imported itself; it comes with ${through || 'a dependency'}, which the code imports.`;
    case 'installed': return field(usage, 'seen') === 'test'
      ? `Installed for production. Only tests import it${files ? ` (${files})` : ''}; frameworks load some packages by convention, so that is not proof it never runs.`
      : `Installed for production${through ? ` with ${through}` : ''}, and no import or reference was found in the files read. Frameworks load some packages by convention, so that is not proof it is unused.`;
    case 'unknown': return field(usage, 'reason') === 'graph'
      ? 'The code does not import it, and the dependency files do not record which package requires it, so how it is reached is unknown.'
      : 'Some source files were not read, so whether the code imports it is unknown.';
    case 'build': return `Only build tooling references it${through ? ` (through ${through})` : files ? ` (${files})` : ''}: it runs when the project is built, not when it serves a request.`;
    case 'test': return `Only tests import it${files ? ` (${files})` : ''}.`;
    case 'dev': return `A development dependency${through ? `, through ${through}` : ''}: installed to build and test, not to run.`;
    default: return '';
  }
}

/* The reach in a few words, for a row in a list; the finding itself carries the whole sentence. */
const fileName = (filePath: unknown): string => text(filePath).slice(text(filePath).lastIndexOf('/') + 1);
export function tierPhrase(usage: unknown): string {
  if (!usage) return '';
  const files = items(field(usage, 'files'));
  const count = Number(field(usage, 'count')) || files.length;
  const first = fileName(files[0]);
  const inFiles = first ? `${first}${count > 1 ? ` and ${plural(count - 1, 'more file', 'more files')}` : ''}` : '';
  const through = text(items(field(usage, 'through'))[0]);
  switch (field(usage, 'tier')) {
    case 'imported': return inFiles ? `Imported by ${inFiles}` : 'Imported by the code';
    case 'named': return field(usage, 'loader') === 'bundler' ? 'Loaded at boot by Bundler.require' : inFiles ? `Named in ${inFiles}` : 'Named in the code';
    case 'bundled': return inFiles ? `Shipped by the build, from ${inFiles}` : 'Shipped by the build';
    case 'transitive': return through ? `Comes with ${through}, which the code imports` : 'Comes with a dependency the code imports';
    case 'installed': return field(usage, 'seen') === 'test' ? 'Installed for production; only tests import it' : 'Installed for production; no import found';
    case 'unknown': return field(usage, 'reason') === 'graph' ? 'Reach unknown: nothing records what requires it' : 'Reach unknown: some source files were not read';
    case 'build': return 'Build tooling only';
    case 'test': return 'Only tests import it';
    case 'dev': return through ? `Development only, through ${through}` : 'Development only';
    default: return '';
  }
}

/*
 * The vulnerable packages by risk: exploited in something that ships first,
 * then the number. One row per package version: declared in two manifests
 * it is still one thing to upgrade, so the row keeps the riskiest finding
 * and counts the places. The count is the reading's own: drawing the list
 * again, or writing a brief from it, counts the same places again.
 */
export interface RiskRow {
  readonly finding: unknown;
  readonly places: number;
}
const severityRank = (finding: unknown): number => ORDER.findIndex(severity => severity === field(finding, 'severity'));
const riskScore = (finding: unknown): number => Number(field(riskOf(finding), 'score'));
export function riskRanked(findings: unknown): readonly RiskRow[] {
  const ranked = items(findings).filter(finding => riskOf(finding))
    .sort((a, b) => Number(exploited(b)) - Number(exploited(a)) || riskScore(b) - riskScore(a) ||
      severityRank(a) - severityRank(b) || String(at(a, 'detail', 'package')).localeCompare(String(at(b, 'detail', 'package'))));
  const rows: { finding: unknown; places: number }[] = [];
  const byVersion = new Map<string, { finding: unknown; places: number }>();
  for (const finding of ranked) {
    const detail = field(finding, 'detail');
    const version = field(detail, 'source') === 'range' ? field(detail, 'range') : field(detail, 'version');
    const key = `${text(field(detail, 'ecosystem'))}\0${String(field(detail, 'package')).toLowerCase()}\0${text(version)}`;
    const kept = byVersion.get(key);
    if (kept) {
      kept.places += 1;
      continue;
    }
    const row = { finding, places: 1 };
    byVersion.set(key, row);
    rows.push(row);
  }
  return rows;
}

/* Where the exploit intelligence came from, as one line: the catalog and its version, and how many CVEs EPSS scored. */
export function intelSources(result: unknown): string {
  const exploit = at(result, 'coverage', 'exploit');
  if (!exploit) return '';
  const kevState = field(exploit, 'kev');
  const kevVersion = text(field(exploit, 'kevVersion'));
  const kevCount = field(exploit, 'kevCount');
  const kev = kevState === 'ok'
    ? `CISA’s Known Exploited Vulnerabilities catalog${kevVersion ? ` ${kevVersion}` : ''}${kevCount ? ` (${typeof kevCount === 'number' ? kevCount.toLocaleString() : text(kevCount)} CVEs)` : ''}${field(exploit, 'kevStale') ? ', an earlier copy because a refresh failed' : ''}`
    : kevState === 'not-needed' ? '' : 'CISA’s catalog could not be read';
  const epssState = field(exploit, 'epss');
  const unscored = field(exploit, 'unscored');
  const epss = epssState === 'ok' || epssState === 'partial'
    ? `FIRST EPSS scores for ${text(field(exploit, 'scored'))} of ${text(field(exploit, 'asked'))} CVEs${epssState === 'partial' ? ' (some requests went unanswered)' : unscored ? ` (EPSS has not scored the other ${text(unscored)} yet)` : ''}`
    : epssState === 'not-needed' ? '' : 'EPSS could not be reached';
  return [kev, epss].filter(Boolean).join(' · ');
}

/* ---- What a result rests on ------------------------------------------------ */

export function coverageLine(result: unknown): string {
  const coverage = field(result, 'coverage') || {};
  const read = finite(field(coverage, 'read'));
  const eligible = finite(field(coverage, 'eligible'));
  const commit = text(field(result, 'commitSha')).slice(0, 7);
  const rulesOnly = Number(field(coverage, 'rulesOnly')) || 0;
  /* A result that does not say how much it read is not said to have read nothing. */
  const parts = [read !== null && eligible !== null
    ? `Read ${read} of ${eligible} files it audits at ${commit}` + (rulesOnly ? ` (${read - rulesOnly} traced, ${rulesOnly} against the rules alone)` : '')
    : `How many files were read at ${commit} was not recorded`];
  const packages = field(coverage, 'packages') || {};
  if (field(packages, 'declared')) {
    const unknown = field(packages, 'unknown');
    parts.push(`${text(field(packages, 'checked'))} of ${text(field(packages, 'declared'))} packages checked against their registry` +
      (unknown ? ` (${text(unknown)} unanswered, not counted as missing)` : ''));
  }
  const advisories = field(coverage, 'advisories') || {};
  if (field(advisories, 'versions')) {
    const unknown = field(advisories, 'unknown');
    parts.push(`${text(field(advisories, 'checked'))} of ${text(field(advisories, 'versions'))} package versions checked against OSV` +
      (unknown ? ` (${text(unknown)} unanswered)` : ''));
  }
  const setAside = field(advisories, 'setAside');
  if (setAside) parts.push(`${plural(setAside, 'manifest', 'manifests')} kept for tests set aside, as no install of the application`);
  const components = items(field(result, 'components'));
  if (components.length) {
    const ecosystems = [...new Set(components.map(component => entry(ECOSYSTEM_NAME, field(component, 'ecosystem')) ?? text(field(component, 'ecosystem'))))];
    parts.push(`${plural(field(result, 'componentsTruncated') || components.length, 'component', 'components')} in the bill of materials (${ecosystems.join(', ')})`);
  }
  const exploit = field(coverage, 'exploit');
  if (exploit && field(exploit, 'cves')) {
    const asked = field(exploit, 'asked');
    const kevVersion = text(field(exploit, 'kevVersion'));
    parts.push(`${text(asked)} ${asked === 1 ? 'CVE' : 'CVEs'} checked against ${field(exploit, 'kev') === 'ok' ? `CISA KEV${kevVersion ? ` ${kevVersion}` : ''}` : 'CISA KEV (unavailable)'} and EPSS (${text(field(exploit, 'scored'))} scored)`);
  }
  const licensing = at(result, 'licences', 'status');
  const versions = field(licensing, 'versions');
  if (licensing && versions) {
    parts.push(`${text(field(licensing, 'known'))} of ${text(versions)} package ${versions === 1 ? 'version’s licence' : 'versions’ licences'} read`);
  }
  return `${parts.join(' · ')}.`;
}

/* What was not read, in one sentence that says a quiet section is no clean bill. */
export function coverageCaveat(result: unknown): string {
  const coverage = field(result, 'coverage') || {};
  const notes: string[] = [];
  const count = (value: unknown, one: string, many: string, rest: string): void => {
    if (value) notes.push(`${plural(value, one, many)} ${rest}`);
  };
  if (field(coverage, 'treeTruncated')) notes.push('the provider truncated the file listing');
  count(at(coverage, 'skipped', 'budget'), 'file', 'files', 'beyond the audit budget were not read');
  count(at(coverage, 'skipped', 'oversize'), 'file', 'files', 'over 512 KB were not read');
  count(field(coverage, 'unreadable'), 'file', 'files', 'could not be read');
  count(at(coverage, 'packages', 'notChecked'), 'package', 'packages', 'beyond the lookup limit were not checked');
  count(at(coverage, 'packages', 'unknown'), 'registry lookup', 'registry lookups', 'went unanswered');
  const advisories = field(coverage, 'advisories') || {};
  count(field(advisories, 'unknown'), 'advisory lookup', 'advisory lookups', 'went unanswered');
  count(field(advisories, 'notChecked'), 'package version', 'package versions', 'beyond the advisory limit were not checked');
  if (Number(field(advisories, 'lockfiles')) > Number(field(advisories, 'lockfilesRead'))) notes.push('a lockfile was not read (over 512 KB or past the budget), so declared ranges stood in for installed versions');
  count(at(result, 'licences', 'status', 'notAsked'), 'package version', 'package versions', 'beyond the licence lookup limit were not checked');
  const exploit = field(coverage, 'exploit');
  if (exploit && field(exploit, 'cves')) {
    if (field(exploit, 'kev') === 'unavailable') notes.push('CISA’s exploited-vulnerability catalog could not be read, so existing exploit evidence must be treated as last known rather than current');
    else if (field(exploit, 'kevStale')) notes.push('the exploited-vulnerability catalog is an earlier copy, because a refresh failed');
    if (field(exploit, 'epss') === 'unavailable') notes.push('EPSS could not be reached, so no exploit probability is shown');
    else if (field(exploit, 'epss') === 'partial') notes.push('some EPSS requests went unanswered, so some CVEs have no exploit probability');
    const beyond = Number(field(exploit, 'cves')) - Number(field(exploit, 'asked'));
    if (beyond > 0) notes.push(`${plural(beyond, 'CVE', 'CVEs')} beyond the lookup limit have no exploit data`);
  }
  const traced = at(result, 'engine', 'traced');
  const cut = field(traced, 'cut');
  if (traced && cut) notes.push(`tracing reached the server's ${field(traced, 'limit') === 'memory' ? 'memory' : 'time'} limit, so ${plural(cut, 'file was', 'files were')} checked against the rules without being traced`);
  return notes.length ? `Not a complete read: ${notes.join('; ')}. A finding-free section here is not a finding-free repository.` : '';
}

/*
 * Why a grade sits where it does when a ceiling held it there. A kept audit
 * stores only the reasons that hold it below 50; one held by serious
 * findings keeps its capped score and its counts, which agree on their own.
 */
export function capNote(reason: unknown, counts: unknown, kept: boolean): string | null {
  const is = kept ? 'was' : 'is';
  if (reason === 'exploited') return `Held below 50 while a vulnerability CISA lists as exploited in the wild ${kept ? 'shipped' : 'ships'} with the code.`;
  if (reason === 'critical') return `Held below 50 while a confirmed critical finding ${is} open.`;
  if (reason === 'serious') {
    const serious = finite(field(counts, 'serious')) ?? 0;
    const ceiling = serious >= 6 ? 'D' : serious >= 3 ? 'C' : 'B';
    return `Held to ${ceiling} at best while ${plural(serious, 'confirmed serious finding', 'confirmed serious findings')} ${serious === 1 ? is : kept ? 'were' : 'are'} open.`;
  }
  return null;
}
export function capPhrase(reason: unknown): string {
  if (reason === 'exploited') return ' (held below 50 by a vulnerability exploited in the wild)';
  if (reason === 'critical') return ' (held below 50 by a confirmed critical finding)';
  if (reason === 'serious') return ' (held down by confirmed serious findings)';
  return '';
}

export function severityCounts(findings: unknown): Record<Severity, number> {
  const counts: Record<Severity, number> = { critical: 0, serious: 0, warning: 0 };
  for (const finding of items(findings)) {
    const severity = severityOf(finding);
    if (severity) counts[severity] += 1;
  }
  return counts;
}

/* The headline counts what is confirmed; a lead to confirm is named as one, never as an issue. */
export function headline(result: unknown, status: unknown): string {
  if (status === 'running') return 'Auditing this branch…';
  if (!result) return 'Not audited yet';
  const findings = items(field(result, 'findings'));
  const confirmed = findings.filter(finding => verdictOf(finding) === 'confirmed');
  const counts = severityCounts(confirmed);
  const leads = findings.length - confirmed.length;
  if (counts.critical) return `${plural(counts.critical, 'critical issue', 'critical issues')} to fix`;
  if (counts.serious) return `${plural(counts.serious, 'serious issue', 'serious issues')} to fix`;
  if (counts.warning) return `${plural(counts.warning, 'warning', 'warnings')}, nothing serious`;
  if (leads) return `${plural(leads, 'lead', 'leads')} to confirm, nothing confirmed`;
  return 'Nothing found in what was read';
}

/* Which reading a result is, so a redraw of the same one does not grow its ring again. */
export const resultId = (result: unknown): string => `${text(field(result, 'commitSha'))}|${text(field(result, 'auditedAt'))}|${text(field(result, 'score'))}`;

/* ---- The team's decisions and the clocks ---------------------------------- */

export const dayWord = (count: number): string => `${count} ${count === 1 ? 'day' : 'days'}`;
/* How long until a finding is due, or how late it is. */
export function clockWords(clock: unknown): string {
  const days = Math.abs(Number(field(clock, 'daysLeft'))) || 0;
  if (field(clock, 'state') === 'overdue') return `${dayWord(days || 1)} overdue`;
  return days === 0 ? 'Due today' : `Due in ${dayWord(days)}`;
}

/* A decision as an export says it: what, who, when, until when, and why in words. */
export function triageJustification(decision: unknown): string {
  const what = field(decision, 'disposition') === 'false-positive' ? 'False positive' : 'Risk accepted';
  const decidedBy = text(field(decision, 'decidedBy'));
  const decidedAt = text(field(decision, 'decidedAt'));
  const expiresAt = text(field(decision, 'expiresAt'));
  const who = decidedBy ? ` by ${decidedBy}` : '';
  const on = decidedAt ? ` on ${decidedAt.slice(0, 10)}` : '';
  const until = expiresAt ? `, until ${expiresAt.slice(0, 10)}` : '';
  return `${what}${who}${on}${until}: ${text(field(decision, 'reasonLabel')) || text(field(decision, 'reason')).replace(/-/g, ' ')}.`;
}

/* ---- The deployed site ---------------------------------------------------- */

export interface SiteAssessment {
  readonly state: 'complete' | 'partial' | 'unknown';
  readonly complete: boolean;
  readonly reasons: readonly string[];
  readonly categories: unknown;
}
/* Legacy reports without coverage evidence cannot establish a passing grade. */
export function siteAssessment(result: unknown): SiteAssessment {
  const raw = field(result, 'coverage') || {};
  const complete = field(raw, 'complete') === true && field(raw, 'state') === 'complete';
  const state = complete ? 'complete' : field(raw, 'state') === 'partial' ? 'partial' : 'unknown';
  const reasons = items(field(raw, 'reasons')).filter((reason): reason is string => typeof reason === 'string');
  if (!complete && !reasons.length) reasons.push('Coverage evidence is unavailable; run the check again.');
  return { state, complete, reasons, categories: field(raw, 'categories') || {} };
}
export function siteAssessmentLine(result: unknown): string {
  const coverage = siteAssessment(result);
  if (coverage.complete) return 'Coverage complete within the stated request and resource limits. This is a bounded security check, not a security certification.';
  const observedScore = finite(field(result, 'observedScore'));
  const observed = observedScore !== null ? ` Observed checks scored ${observedScore}/100; this is not an overall site score.` : '';
  return `Coverage ${coverage.state}. Overall grade withheld.${observed} ${coverage.reasons.join(' ')}`;
}
/* A site check's grade, when its coverage was complete enough to earn one. */
export function siteGraded(result: unknown): boolean {
  return siteAssessment(result).complete && finite(field(result, 'score')) !== null && typeof field(result, 'grade') === 'string';
}
export function siteCoverage(result: unknown): string {
  const redirects = field(result, 'redirects');
  const requested = text(field(result, 'requested'));
  const hops = redirects
    ? ` after ${plural(redirects, 'redirect', 'redirects')}${requested && requested !== text(field(result, 'origin')) ? ` from ${requested}` : ''}`
    : '';
  const duration = finite(field(result, 'durationMs'));
  const took = duration !== null ? ` in ${Math.max(1, Math.round(duration / 1000))} s` : '';
  return `${plural(field(result, 'requests'), 'anonymous request', 'anonymous requests')}${took}; the page answered ${text(field(result, 'status'))}${hops}.`;
}
