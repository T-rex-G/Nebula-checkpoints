/*
 * The Exposure screen's words and reckoning: what a scan proved, said so a
 * scan that has not finished, or finished without reading everything, never
 * reads as a clean repository; what it read, in numbers that add up; the
 * history's labels; a finding's severity, name, place and first line; which
 * findings a view keeps; the rows an export may carry, never a raw path; and
 * whether a provider's answer is still fresh.
 *
 * Every table here is looked up by its own names only: a state, a severity or
 * a word the server never sent is not answered by a name every object has.
 */
import { field, items } from '../../platform/values.ts';

const own = <T>(table: Readonly<Record<string, T>>, name: unknown): T | undefined =>
  (typeof name === 'string' && Object.hasOwn(table, name) ? table[name] : undefined);

/*
 * Used only if the server sends an attempt with no narration. The words there
 * come from a reviewed lookup table; these exist so a missing entry reads as
 * an unfinished sentence rather than an empty element.
 */
export const VERIFICATION_FALLBACK: Readonly<Record<string, string>> = Object.freeze({
  verified: 'The provider confirmed this credential is live.',
  rejected: 'The provider refused this credential, so it no longer works.',
  unverifiable: 'The provider was asked and could not tell us either way.'
});
export const PROBE_FALLBACK: Readonly<Record<string, string>> = Object.freeze({
  readable: 'The anonymous role read a row from that table.',
  denied: 'That request was refused, which is evidence about that request and not about the whole table.',
  unverifiable: 'Nothing was established about what the anonymous role can read.'
});
export const DISPOSITION_FALLBACK: Readonly<Record<string, string>> = Object.freeze({
  open: 'This finding is open and nothing has established that the credential stopped working.',
  'credential-rejected': 'The issuing provider refused this credential, so it no longer works.',
  'accepted-risk': 'Somebody accepted this risk. The credential is still in the repository.',
  'removed-from-tree': 'This credential is no longer in the tree, but it is still in the history.'
});

/*
 * The one place a scan's state becomes words. `pending`, `partial`, `failed`
 * and `canceled` all render as themselves and none of them renders green.
 */
export const STATE_WORDS: Readonly<Record<string, string>> = Object.freeze({
  queued: 'Queued', running: 'Running', complete: 'Complete', partial: 'Finished, partial', failed: 'Failed', canceled: 'Canceled'
});
export const COVERAGE_WORDS: Readonly<Record<string, string>> = Object.freeze({
  unknown: 'Unknown', complete: 'Whole tree read', partial: 'Part of the tree read'
});
export const SKIPPED_WORDS: Readonly<Record<string, string>> = Object.freeze({
  'file-count-limit': 'the file ceiling was reached',
  'byte-limit': 'the byte ceiling was reached',
  'time-limit': 'the time ceiling was reached',
  'tree-truncated': 'the provider truncated the file listing',
  'unreadable-files': 'some files were not read',
  canceled: 'it was canceled',
  'transport-refused': 'the repository could not be read',
  'authorization-revoked': 'the authorised session is no longer valid',
  'finding-limit': 'the finding ceiling was reached',
  'configuration-changed': 'the scanner was upgraded before this scan ran',
  'commit-limit': 'the commit ceiling was reached, so the oldest history was not read',
  'rate-limited': 'GitHub asked for fewer requests, so the history was not read to the end'
});
/* A table's word for a name, or nothing for a name it does not hold. */
export const wordFor = (table: Readonly<Record<string, string>>, name: unknown): string | undefined => own(table, name);

const running = (state: unknown): boolean => state === 'queued' || state === 'running';

export function proofLine(scan: unknown): string {
  if (!scan) return 'Start a scan to check this branch for exposed credentials.';
  if (running(field(scan, 'state'))) return 'A scan is in progress. Nothing is proven until it finishes.';
  if (field(scan, 'coverage') === 'complete' && field(scan, 'state') === 'complete') {
    return field(scan, 'scanMode') === 'history'
      ? 'This scan read the whole tree at the commit below and every commit before it, and checked supported credential patterns. This is not a full application security audit.'
      : 'This scan read the whole tree at the commit below and checked supported credential patterns. It did not read the history, where a deleted credential can still be. This is not a full application security audit.';
  }
  return 'This scan did not read the whole tree, so it cannot tell you the repository is clean.';
}

const whole = (value: unknown): number => (Number.isInteger(value) ? value as number : 0);
const plural = (count: unknown, one: string, many: string): string => `${String(count)} ${count === 1 ? one : many}`;

/*
 * What the scan read, in numbers that add up: text files read, binary files
 * not scanned, others not read, and any a ceiling stopped before.
 */
export function breakdownLine(scan: unknown): string {
  const total = field(scan, 'filesTotal');
  if (!scan || !Number.isInteger(total)) return '';
  const read = whole(field(scan, 'filesScanned'));
  const binary = whole(field(scan, 'filesSkippedBinary'));
  const other = whole(field(scan, 'filesSkippedOther'));
  const unreached = Math.max(0, (total as number) - read - binary - other);
  const parts = [`Read ${read} of ${plural(total, 'file', 'files')}.`];
  if (binary) parts.push(`${plural(binary, 'binary file', 'binary files')} (images, fonts, archives) not scanned.`);
  if (other) parts.push(`${plural(other, 'other', 'others')} not read (links, submodules, oversized or unreadable).`);
  if (unreached && !running(field(scan, 'state'))) parts.push(`${plural(unreached, 'file', 'files')} not reached before a limit.`);
  const archives = field(scan, 'archivesScanned');
  if (Number.isInteger(archives) && (archives as number) > 0) {
    parts.push(`Opened ${plural(archives, 'archive', 'archives')} and read ${plural(whole(field(scan, 'archiveMembersScanned')), 'file', 'files')} inside.`);
  }
  const commits = field(scan, 'commitsTotal');
  if (field(scan, 'scanMode') === 'history' && Number.isInteger(commits)) {
    const base = field(scan, 'historyBaseCommit');
    const since = base ? ` since the last full history scan (${String(base).slice(0, 7)})` : '';
    parts.push(`Read ${whole(field(scan, 'commitsScanned'))} of ${plural(commits, 'commit', 'commits')}${since}.`);
    const skipped = field(scan, 'commitsSkipped');
    if (Number(skipped) > 0) parts.push(`${plural(skipped, 'commit', 'commits')} could not be read.`);
  }
  return parts.join(' ');
}

/* Whether the next scan reads history: a preference kept in this browser only, and a blocked storage means the default. */
export const HISTORY_PREFERENCE = 'nv_exposure_history';
export function historyPreferred(storage: () => { getItem(key: string): string | null }): boolean {
  try { return storage().getItem(HISTORY_PREFERENCE) !== '0'; } catch { return true; }
}

/* ---- The history ---------------------------------------------------------------------------- */

export function refLabel(refName: unknown): string {
  return String(refName || '').replace(/^refs\/(?:heads|tags)\//, '') || 'HEAD';
}

/* Today and yesterday by name, anything older by date. */
export function dayLabel(date: Date, now: Date = new Date()): string {
  const startOf = (value: Date): number => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(date)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' });
}

export function scanCounts(scan: unknown): string {
  const counts = field(scan, 'severityCounts') || {};
  const parts = (['critical', 'serious', 'warning'] as const)
    .filter(key => Number(field(counts, key)) > 0)
    .map(key => `${String(field(counts, key))} ${key}`);
  if (parts.length) return parts.join(' \u00b7 ');
  const state = field(scan, 'state');
  if (running(state)) return 'In progress';
  if (state === 'failed' || state === 'canceled') return 'No results';
  return field(scan, 'coverage') === 'complete' ? 'Nothing found' : 'Nothing found in what was read';
}

/* ---- A finding ------------------------------------------------------------------------------ */

export type Severity = 'critical' | 'serious' | 'warning';
export const SEVERITY_RANK: Readonly<Record<Severity, number>> = Object.freeze({ critical: 0, serious: 1, warning: 2 });
export const SEVERITY_WORDS: Readonly<Record<Severity, string>> = Object.freeze({ critical: 'Critical', serious: 'Serious', warning: 'Warning' });
export const DISPOSITION_WORDS: Readonly<Record<string, string>> = Object.freeze({
  open: 'Open', 'credential-rejected': 'No longer works', 'accepted-risk': 'Accepted', 'removed-from-tree': 'Removed from tree'
});
/* What a finding's disposition looks like as a chip: only an open one asks for work. */
export const DISPOSITION_TONE: Readonly<Record<string, readonly [string, string]>> = Object.freeze({
  open: Object.freeze(['serious', 'open'] as const),
  'credential-rejected': Object.freeze(['good', 'check'] as const),
  'accepted-risk': Object.freeze(['info', 'shield'] as const),
  'removed-from-tree': Object.freeze(['neutral', 'history'] as const)
});

/* A finding's severity as the narration states it, and serious when it states none the screen knows. */
export function severityOf(finding: unknown): Severity {
  const severity = field(field(finding, 'narration'), 'severity');
  return own(SEVERITY_RANK, severity) === undefined ? 'serious' : severity as Severity;
}

export const dispositionOf = (finding: unknown): string => String(field(finding, 'disposition') || 'open');

export function sortFindings<T>(findings: readonly T[] | null | undefined): T[] {
  return [...(findings || [])].sort((a, b) => (
    SEVERITY_RANK[severityOf(a)] - SEVERITY_RANK[severityOf(b)]
    || String(field(a, 'path') || '').localeCompare(String(field(b, 'path') || ''))
    || String(field(a, 'rule') || '').localeCompare(String(field(b, 'rule') || ''))
  ));
}

/* A rule name made readable: `stripe-live-key` is "Stripe live key", initialisms in capitals, names as their owners spell them. */
const INITIALISMS: ReadonlySet<string> = new Set(['aws', 'api', 'url', 'ca', 'pgp', 'dsa', 'jwt', 'ci', 'ssh', 'id', 'ad']);
const NAMES: Readonly<Record<string, string>> = Object.freeze({
  github: 'GitHub', gitlab: 'GitLab', oauth: 'OAuth', openai: 'OpenAI', huggingface: 'Hugging Face',
  digitalocean: 'DigitalOcean', hashicorp: 'HashiCorp', pypi: 'PyPI', npm: 'npm', jfrog: 'JFrog',
  circleci: 'CircleCI', planetscale: 'PlanetScale', flyio: 'Fly.io', sendgrid: 'SendGrid',
  mailchimp: 'Mailchimp', easypost: 'EasyPost', putty: 'PuTTY', mongodb: 'MongoDB',
  xai: 'xAI', openrouter: 'OpenRouter', langsmith: 'LangSmith', onepassword: '1Password',
  launchdarkly: 'LaunchDarkly', sonarqube: 'SonarQube', nuget: 'NuGet', rubygems: 'RubyGems',
  cratesio: 'crates.io', woocommerce: 'WooCommerce', npmrc: '.npmrc', sourcegraph: 'Sourcegraph',
  bitbucket: 'Bitbucket', datadog: 'Datadog', hubspot: 'HubSpot', airtable: 'Airtable'
});
export function ruleLabel(rule: unknown): string {
  const words = String(rule || 'credential').split('-').filter(Boolean);
  return words.map((word, index) => {
    const named = own(NAMES, word);
    if (named) return named;
    if (INITIALISMS.has(word)) return word.toUpperCase();
    return index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word;
  }).join(' ');
}

export function firstLine(finding: unknown): number | null {
  const occurrence = items(field(finding, 'occurrences'))[0];
  const line = field(occurrence, 'line');
  return Number.isInteger(line) ? line as number : null;
}

/* Where a finding sits: in the tree or only in history, inside an archive, decoded from base64. */
export function whereOf(finding: unknown): { tree: boolean; history: boolean; archive: boolean; encoded: boolean } {
  return {
    tree: field(finding, 'inTree') !== false,
    history: field(finding, 'inTree') === false,
    archive: String(field(finding, 'path') || '').includes('!/'),
    encoded: field(finding, 'decodedFrom') === 'base64'
  };
}

export interface ExposureView { readonly severity: unknown; readonly status: unknown; readonly where: unknown; readonly query: unknown }

export function matches(finding: unknown, view: ExposureView): boolean {
  if (view.severity && severityOf(finding) !== view.severity) return false;
  if (view.status !== 'all' && dispositionOf(finding) !== view.status) return false;
  if (view.where !== 'all') {
    const where = whereOf(finding);
    if (typeof view.where !== 'string' || !Object.hasOwn(where, view.where) || !where[view.where as keyof typeof where]) return false;
  }
  const terms = String(view.query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const text = [ruleLabel(field(finding, 'rule')), field(finding, 'rule'), field(finding, 'displayPath'), SEVERITY_WORDS[severityOf(finding)],
    own(DISPOSITION_WORDS, dispositionOf(finding))].filter(Boolean).join(' ').toLowerCase();
  return terms.every(term => text.includes(term));
}

/* The findings a view shows: the server's page as it came when it is paged, else those the view keeps. */
export function filtered<T>(current: { readonly paged: unknown; readonly findings: readonly T[]; readonly view: ExposureView }): readonly T[] {
  return current.paged ? current.findings : current.findings.filter(finding => matches(finding, current.view));
}

/* Whether a provider's answer was observed already and is not yet past its deadline. */
export function answerFresh(answer: unknown, now: number): boolean {
  const deadline = Date.parse(String(field(answer, 'freshnessDeadline') || ''));
  const observed = Date.parse(String(field(answer, 'observedAt') || ''));
  return Number.isFinite(observed) && Number.isFinite(deadline) && observed <= now && deadline > now;
}

/* Rows safe to hand to an export: the displayable path, never the raw one. */
export function exportRows(findings: readonly unknown[], verifications: unknown, now: number): Record<string, unknown>[] {
  return sortFindings(findings).map(finding => {
    const fingerprint = field(finding, 'fingerprint');
    const verification = typeof fingerprint === 'string' && Object.hasOwn(verifications as object, fingerprint) ? field(verifications, fingerprint) : undefined;
    const where = whereOf(finding);
    const commit = String(field(finding, 'introducedCommit') || '');
    return {
      severity: severityOf(finding), label: ruleLabel(field(finding, 'rule')), rule: String(field(finding, 'rule') || 'credential'),
      where: field(finding, 'displayPath') || 'a file', line: firstLine(finding), status: dispositionOf(finding),
      inTree: field(finding, 'inTree') !== false, archive: where.archive, encoded: where.encoded,
      commit: /^[0-9a-f]{7,40}$/.test(commit) ? commit.slice(0, 12) : '',
      verified: verification ? (answerFresh(verification, now) ? field(verification, 'state') : `previously ${String(field(verification, 'state'))} (expired or undated)`) : '',
      fingerprint: fingerprint || '',
      acceptedBy: field(finding, 'disposition') === 'accepted-risk' ? field(finding, 'dispositionBy') || '' : ''
    };
  });
}

/* The findings' address for a view, from a cursor. */
export function findingsUrl(path: string, view: ExposureView, cursor: unknown = null, limit = 50): string {
  const params = new URLSearchParams({ limit: String(limit) });
  if (view.severity) params.set('severity', String(view.severity));
  if (view.status !== 'all') params.set('status', String(view.status));
  if (view.where !== 'all') params.set('where', String(view.where));
  if (view.query) params.set('q', String(view.query));
  if (cursor) params.set('cursor', String(cursor));
  return `/api/repo/${path}/exposure/findings?${params}`;
}
