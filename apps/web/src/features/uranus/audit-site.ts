/*
 * The deployed site, decided: an address, the grade its responses earn,
 * which of the headers a browser enforces were sent, what was checked and
 * the findings -- on the Website page, where checks run, and as the audit
 * shows the latest check of its repository's address. The address is the
 * only thing typed here, and only its origin is ever requested.
 */
import { field, items } from '../../platform/values.ts';
import {
  HEADER_JOBS, HEADER_NAMES, LEDGER_GLYPH, LEDGER_NAMES, LEDGER_STATE,
  entry, finite, headline, plural, siteAssessment, siteAssessmentLine, siteCoverage, text
} from './audit-terms.ts';
import { changesOf, findingTally, findingsOf, ring } from './audit-screen.ts';
import type { Progress, Ring, Tally } from './audit-screen.ts';
import { findingRow } from './audit-findings.ts';
import type { FindingRow } from './audit-findings.ts';

/* ---- A running check ------------------------------------------------------------ */

const SITE_STEPS = Object.freeze([
  { id: 'connect', label: 'Connect', stages: ['page', 'transport'] },
  { id: 'probe', label: 'Probe', stages: ['paths'] },
  { id: 'crawl', label: 'Read', stages: ['pages', 'scripts'] },
  { id: 'lookup', label: 'Look up', stages: ['libraries', 'email'] }
]);
function siteStageLine(stage: string, done: number, total: number): string {
  switch (stage) {
    case 'transport': return 'Checking the certificate, plain HTTP and cross-origin reads';
    case 'paths': return total ? `Asking for files that should never be served · ${done} of ${total}` : 'Asking for files that should never be served';
    case 'pages': return total ? `Reading the pages the site links to · ${done} of ${total}` : 'Reading the pages the site links to';
    case 'scripts': return total ? `Reading the site’s JavaScript for secrets and libraries · ${done} of ${total}` : 'Looking for the site’s JavaScript';
    case 'libraries': return 'Asking OSV about the libraries found';
    case 'email': return 'Looking up the domain’s SPF and DMARC records';
    default: return 'Requesting the page a visitor lands on';
  }
}
/* Where a running site check is: four steps, a line in words, and a bar that moves through the steps and within one by its count. */
export function siteProgress(progress: unknown): Progress {
  const asked = field(progress, 'stage');
  const stage = typeof asked === 'string' && asked ? asked : 'page';
  const current = Math.max(0, SITE_STEPS.findIndex(step => step.stages.includes(stage)));
  const total = Math.max(0, Number(field(progress, 'total')) || 0);
  const done = Math.min(total, Math.max(0, Number(field(progress, 'done')) || 0));
  const fraction = Math.min(1, (current + (total ? done / total : 0.5)) / SITE_STEPS.length);
  const line = siteStageLine(stage, Number(field(progress, 'done')) || 0, Number(field(progress, 'total')) || 0);
  return {
    stage,
    steps: SITE_STEPS.map((item, index) => ({ id: item.id, label: item.label, state: index < current ? 'done' : index === current ? 'active' : 'next' })),
    line,
    fraction,
    busy: false,
    value: { max: 100, now: Math.round(fraction * 100), said: line },
    announce: { key: SITE_STEPS[current]?.id ?? 'connect', said: line }
  };
}

/* ---- A finished check -------------------------------------------------------------- */

export interface Header {
  readonly present: boolean;
  readonly via: boolean;
  readonly name: string;
  readonly job: string;
  readonly glyph: string;
  readonly state: string;
  readonly title: string | null;
}
export interface LedgerRow {
  readonly state: string;
  readonly glyph: string;
  readonly said: string;
  readonly name: string;
  readonly detail: string;
}
export interface Library {
  readonly state: string;
  readonly name: string;
  readonly said: string;
  readonly title: string;
}
export interface SiteReading {
  readonly id: string;
  readonly ring: Ring;
  readonly origin: string;
  readonly host: string;
  readonly verdict: string;
  readonly tally: Tally;
  readonly cap: boolean;
  readonly diff: string | null;
  readonly coverage: string;
  readonly assessment: { readonly state: string; readonly complete: boolean; readonly said: string };
  readonly headers: readonly Header[];
  readonly ledger: { readonly summary: string; readonly rows: readonly LedgerRow[] } | null;
  readonly libraries: readonly Library[];
  /* Every finding, worst first; the card shows the first five until the reader asks for the rest. */
  readonly rows: readonly FindingRow[];
}
/* What a finished check says: the same for the Website page and for the audit's card. */
export function siteReading(site: unknown, now: number): SiteReading {
  const result = field(site, 'result');
  const assessment = siteAssessment(result);
  const score = finite(field(result, 'score'));
  const grade = field(result, 'grade');
  const graded = assessment.complete && score !== null && typeof grade === 'string';
  const origin = text(field(result, 'origin'));
  const findings = findingsOf(result);
  const changes = changesOf(field(site, 'diff'));
  let diff: string | null = null;
  if (changes) {
    const previous = changes.previousAt;
    const at = typeof previous === 'string' || typeof previous === 'number' ? new Date(previous) : null;
    const since = previous && at && Number.isFinite(at.getTime()) ? ` since the check of ${at.toLocaleString()}` : '';
    const added = plural(changes.newIds.size, 'new finding', 'new findings');
    /* A count of resolved findings is said only when the check was complete and the count is known. */
    diff = !assessment.complete
      ? `${added}${since}. Resolution cannot be established from this incomplete check.`
      : changes.resolved !== null ? `${added}, ${changes.resolved} resolved${since}.` : `${added}${since}.`;
  }
  const ledger = items(field(result, 'ledger'));
  const counts: Record<string, number> = {};
  for (const line of ledger) {
    const state = text(field(line, 'state'));
    counts[state] = (counts[state] ?? 0) + 1;
  }
  const said = (state: string, words: string): string => (counts[state] ? `${counts[state]} ${words}` : '');
  return {
    id: `${origin}|${text(field(result, 'checkedAt'))}`,
    ring: ring(graded ? result : { ...(typeof result === 'object' && result !== null ? result : {}), grade: null, score: null }, 'done',
      graded ? `Site grade ${text(grade)}, ${text(score)} out of 100` : `Site coverage ${assessment.state}; overall grade withheld`),
    origin,
    host: origin.replace(/^https:\/\//, ''),
    verdict: findings.length ? headline(result, 'done') : assessment.complete ? 'Nothing found in the completed checks' : 'No findings in the checks completed so far',
    tally: findingTally(findings),
    cap: Boolean(field(result, 'capped')) && graded,
    diff,
    coverage: siteCoverage(result),
    assessment: { state: assessment.state, complete: assessment.complete, said: siteAssessmentLine(result) },
    headers: items(field(result, 'headers')).map(header => {
      const present = Boolean(field(header, 'present'));
      const via = field(header, 'via');
      const covered = !present && Boolean(via);
      const name = field(header, 'name');
      return {
        present: present || covered,
        via: covered,
        name: entry(HEADER_NAMES, name) ?? text(name),
        job: entry(HEADER_JOBS, name) ?? '',
        glyph: present || covered ? '✓' : '✕',
        state: present ? 'sent' : covered ? `via ${via === 'content-security-policy' ? 'CSP' : text(via)}` : 'not sent',
        title: covered ? `Not sent, but ${entry(HEADER_NAMES, via) ?? text(via)} does its job` : null
      };
    }),
    ledger: ledger.length ? {
      summary: [said('pass', 'passed'), said('fail', 'failed'), said('warn', 'worth a look'), said('unknown', 'unknown'), said('skip', 'skipped')].filter(Boolean).join(' · '),
      rows: ledger.map(line => {
        const state = field(line, 'state');
        return {
          state: text(state),
          glyph: entry(LEDGER_GLYPH, state) ?? '?',
          said: `${entry(LEDGER_STATE, state) ?? text(state)}: `,
          name: entry(LEDGER_NAMES, field(line, 'id')) ?? text(field(line, 'id')),
          detail: text(field(line, 'detail'))
        };
      })
    } : null,
    libraries: items(field(result, 'libraries')).map(library => {
      const state = field(library, 'state');
      const fixed = text(field(library, 'fixed'));
      return {
        state: text(state),
        name: `${text(field(library, 'name'))} ${text(field(library, 'version'))}`,
        said: state === 'vulnerable' ? `${plural(field(library, 'advisories'), 'advisory', 'advisories')}${fixed ? ` · fixed in ${fixed}` : ''}` : state === 'clean' ? 'No advisory' : 'Not checked',
        title: field(library, 'source') === 'address' ? 'Recognised from the address it is served from' : 'Recognised from its own banner'
      };
    }),
    /* A site finding's place is a header or a path on the site: shown, never opened, and never the team's to triage. */
    rows: findings.map(finding => findingRow(finding, { changes, families: null, view: {}, now, offered: { open: false, triage: false } }))
  };
}

export const SITE_FOLD = 5;
export interface Site {
  readonly standalone: boolean;
  readonly idPrefix: string;
  readonly heading: string;
  readonly lede: string;
  readonly from: string;
  readonly url: string;
  readonly running: boolean;
  readonly submit: string;
  readonly suggested: boolean;
  readonly standaloneHint: boolean;
  readonly error: string | null;
  readonly progress: Progress | null;
  readonly reading: SiteReading | null;
  readonly exportable: boolean;
}
/* The site card: on its own page for any address, or within the audit. */
export function site(input: unknown, offered: { readonly export: boolean }, now: number): Site {
  const standalone = field(input, 'standalone') === true;
  const status = field(input, 'status');
  const result = field(input, 'result');
  const running = status === 'running';
  return {
    standalone,
    idPrefix: standalone ? 'standaloneSite' : 'auditSite',
    /* On its own page the hero above already says what is checked; the card says how. */
    heading: standalone ? 'Check a site' : 'Deployed site',
    lede: standalone
      ? 'Anonymous GET requests only — at most sixty, in under a minute — and nothing it reads is kept.'
      : 'The certificate, headers, exposed files, the pages and scripts a visitor loads, their libraries and the domain’s email policy. Anonymous requests only; nothing kept.',
    from: standalone ? text(field(input, 'from')) : '',
    url: text(field(input, 'url')),
    running,
    submit: running ? 'Checking…' : result ? 'Check again' : 'Check site',
    suggested: Boolean(field(input, 'suggested')) && !result,
    standaloneHint: standalone && !result && !running,
    error: status === 'error' ? text(field(input, 'error')) || 'The site could not be checked.' : null,
    progress: running ? siteProgress(field(input, 'progress')) : null,
    reading: result && !running ? siteReading(input, now) : null,
    exportable: offered.export && !field(input, 'hasRepositoryResult')
  };
}

/*
 * The deployed site, as an audit shows it. Site checks run in one place --
 * the Website page, on the Parallax probe -- so the audit does not carry a
 * second scanner: it names this repository's address, says what the latest
 * check of that address found, and sends the reader there.
 */
export interface SiteLink {
  readonly url: string;
  readonly host: string;
  readonly suggested: boolean;
  readonly running: boolean;
  /* A check of the address is held, even while another runs: the way to it stays open. */
  readonly held: boolean;
  readonly reading: { readonly id: string; readonly ring: Ring; readonly verdict: string; readonly tally: Tally; readonly checked: string | null } | null;
  readonly idle: string;
}
export function siteLink(input: unknown, now: number): SiteLink {
  const url = text(field(input, 'url'));
  const result = field(input, 'result');
  const running = field(input, 'status') === 'running';
  let reading: SiteLink['reading'] = null;
  if (!running && result) {
    const full = siteReading(input, now);
    const at = Date.parse(text(field(result, 'checkedAt')));
    reading = { id: full.id, ring: full.ring, verdict: full.verdict, tally: full.tally, checked: Number.isFinite(at) ? `Checked ${new Date(at).toLocaleString()}.` : null };
  }
  return {
    url,
    host: url.replace(/^https:\/\//, '').replace(/\/$/, ''),
    suggested: Boolean(field(input, 'suggested')),
    running,
    held: Boolean(result),
    reading,
    idle: url ? 'Not checked yet in this session.' : 'No site checked yet.'
  };
}
