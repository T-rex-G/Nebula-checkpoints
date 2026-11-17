/*
 * The findings card, decided: the filters over the list (family, OWASP
 * category, severity, verdict, exploitation, a search), a page of rows,
 * each opened into its reason, its path, its advisories, what is known of
 * its exploitation and reach, and its fix; then what the team triaged and
 * what the code waived. Nothing here draws (AuditFindings.tsx does).
 */
import { field, items } from '../../platform/values.ts';
import {
  DISPOSITION, ORDER, REACH, REACH_TIER, RISK_BAND, SEVERITY, STEP_ROLE, VERDICT,
  at, detailChip, entry, exploited, finite, intelOf, licenceFactList, location, percent, rank, riskOf, severityCounts, severityOf,
  text, tierSentence, tierWord, usageOf, verbs, verdictOf
} from './audit-terms.ts';
import type { Tone } from './audit-terms.ts';
import {
  ICON_FLAG, ICON_FLAME, ICON_GAUGE, canTriage, changesOf, clockChip, clockLine, decisionSentence, findingsOf, idOf, kevChip, reachChip, severityChip, verdictChip
} from './audit-screen.ts';
import type { Chip, ClockLine } from './audit-screen.ts';
import { FRAMEWORK_NAME, OWASP, OWASP_EDITION, standardLinks } from './audit-cards.ts';
import type { StandardLink } from './audit-cards.ts';
import type { AuditChanges } from './audit-memory.ts';

/* ---- Findings ------------------------------------------------------------------ */

export const PAGE = 40;
/* Every word a reader might search a finding by. */
function searchText(finding: unknown, families: ReadonlyMap<unknown, unknown>): string {
  const standardsOf = field(finding, 'standards') || {};
  const reach = entry(REACH, at(finding, 'reach', 'auth'));
  const intel = intelOf(finding);
  const riskOfFinding = riskOf(finding);
  const severity = severityOf(finding);
  const band = entry(RISK_BAND, field(riskOfFinding, 'band'));
  const advisories = items(at(finding, 'detail', 'advisories')).flatMap(advisory => [field(advisory, 'id'), field(advisory, 'cve')]);
  return [field(finding, 'title'), field(finding, 'rule'), field(finding, 'where') || location(finding), families.get(field(finding, 'category')),
    field(standardsOf, 'cwe'), field(standardsOf, 'cweName'), field(standardsOf, 'owasp'), field(standardsOf, 'owaspName'), detailChip(finding),
    severity ? SEVERITY[severity].word : field(finding, 'severity'),
    VERDICT[verdictOf(finding)].word, reach && reach.word, at(finding, 'reach', 'route'), ...advisories,
    intel && field(intel, 'exploited') && 'exploited kev known exploited', intel && field(intel, 'ransomware') && 'ransomware', intel && field(intel, 'epss') && 'epss',
    riskOfFinding && `risk ${band ? band.word : text(field(riskOfFinding, 'band'))}`, usageOf(finding) && tierWord(usageOf(finding))]
    .filter(Boolean).map(text).join(' ').toLowerCase();
}
export function matches(finding: unknown, query: unknown, families: ReadonlyMap<unknown, unknown>): boolean {
  const terms = text(query).toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const said = searchText(finding, families);
  return terms.every(term => said.includes(term));
}

export interface IntelFact {
  readonly icon: string;
  readonly tone: string | null;
  readonly said: string;
  readonly kevLink: string | null;
  readonly files: readonly string[];
  readonly chain: readonly string[];
}
export interface Intel {
  readonly risk: { readonly band: string; readonly score: string; readonly meter: number; readonly tone: Tone; readonly word: string; readonly factors: string } | null;
  readonly facts: readonly IntelFact[];
}
const CVE_ID = /^CVE-\d{4}-\d{4,7}$/;
/*
 * What is known about exploitation and reach for one vulnerable package:
 * the risk and the three factors it rests on, then the catalog, the EPSS
 * score and the reach, each as a fact with its source and date.
 */
export function intel(finding: unknown, offered: { readonly open: boolean }): Intel {
  const detail = field(finding, 'detail');
  const riskOfFinding = field(detail, 'risk');
  const read = field(detail, 'intel');
  const usage = field(detail, 'usage');
  let riskView: Intel['risk'] = null;
  if (riskOfFinding) {
    const band = entry(RISK_BAND, field(riskOfFinding, 'band'));
    const cvss = finite(field(detail, 'cvss'));
    const epss = field(read, 'epss');
    const impact = cvss !== null ? `CVSS ${cvss.toFixed(1)}` : 'severity (no CVSS published)';
    const threat = read && field(read, 'exploited') ? 'exploited in the wild' : read && epss ? `EPSS ${percent(field(epss, 'score'))}` : 'no exploit score';
    riskView = {
      band: text(field(riskOfFinding, 'band')),
      score: text(field(riskOfFinding, 'score')),
      meter: Math.max(0, Math.min(100, Number(field(riskOfFinding, 'score')) || 0)),
      tone: band ? band.tone : 'neutral',
      word: band ? band.word : text(field(riskOfFinding, 'band')),
      factors: `From its impact (${impact}), the threat (${threat}) and its reach (${tierWord(usage).toLowerCase() || 'unknown'}).`
    };
  }
  const facts: IntelFact[] = [];
  const fact = (icon: string, said: string, tone: string | null, more: Partial<IntelFact> = {}): void => { facts.push({ icon, said, tone, kevLink: null, files: [], chain: [], ...more }); };
  if (read) {
    const kev = field(read, 'kev');
    if (field(read, 'exploited') && kev) {
      const cve = text(field(kev, 'cve'));
      const added = text(field(kev, 'added'));
      const due = text(field(kev, 'due'));
      fact(ICON_FLAME, `CISA lists ${cve} as exploited in the wild${added ? `, added ${added}` : ''}${due ? `; US federal agencies had to fix it by ${due}` : ''}.${field(read, 'ransomware') ? ' Known to be used in ransomware campaigns.' : ''}`, 'critical',
        { kevLink: `https://www.cisa.gov/known-exploited-vulnerabilities-catalog?search_api_fulltext=${encodeURIComponent(CVE_ID.test(cve) ? cve : '')}` });
    } else if (field(read, 'catalog') === 'unlisted') {
      const cves = Number(field(read, 'cves')) || 0;
      fact(ICON_FLAME, `Not in CISA’s catalog of exploited vulnerabilities${cves > 1 ? ` (${cves} CVEs checked)` : ''}.`, null);
    } else {
      fact(ICON_FLAME, 'CISA’s catalog of exploited vulnerabilities could not be read for this audit: unknown, not clear.', 'pending');
    }
    const epss = field(read, 'epss');
    if (epss) {
      const above = finite(field(epss, 'percentile'));
      const beyond = above !== null ? `, higher than ${rank(above)} of scored CVEs` : '';
      const date = text(field(epss, 'date'));
      fact(ICON_GAUGE, `EPSS: a ${percent(field(epss, 'score'))} chance ${text(field(epss, 'cve'))} is exploited in the next 30 days${beyond}${date ? ` (FIRST, ${date})` : ''}.`, Number(field(epss, 'score')) >= 0.1 ? 'serious' : null);
    } else {
      fact(ICON_GAUGE, field(read, 'scored') === 0 && field(read, 'catalog') !== 'unknown' ? 'EPSS has no score for these CVEs yet.' : 'No EPSS score was available for this audit.', 'pending');
    }
  } else {
    const advisories = field(detail, 'advisories');
    if (Array.isArray(advisories) && items(advisories).every(advisory => !field(advisory, 'cve')) && field(finding, 'rule') !== 'DEP-006') {
      fact(ICON_GAUGE, 'These advisories carry no CVE, so there is no exploit score or catalog entry to look up.', 'pending');
    }
  }
  if (usage) {
    const tier = entry(REACH_TIER, field(usage, 'tier')) ?? REACH_TIER.unknown;
    const chain = items(field(usage, 'chain')).map(text);
    fact(tier.icon, tierSentence(usage), field(usage, 'tier') === 'unknown' ? 'pending' : null, {
      files: offered.open ? items(field(usage, 'files')).filter(Boolean).map(text) : [],
      chain: chain.length > 1 ? chain : []
    });
  }
  return { risk: riskView, facts };
}

export interface Advisory {
  readonly severity: string;
  readonly icon: string;
  readonly id: string;
  readonly cve: string;
  readonly cvss: string;
  readonly kev: boolean;
  readonly epss: string;
  readonly summary: string;
}
/* The advisories behind a dependency finding: id, CVE, how bad, what. */
export function advisories(detail: unknown): { readonly pkg: string; readonly fixed: string; readonly tags: readonly string[]; readonly list: readonly Advisory[]; readonly more: string } {
  const version = field(detail, 'source') === 'range' ? `${text(field(detail, 'range'))} (lowest accepted ${text(field(detail, 'version'))})` : text(field(detail, 'version'));
  const tags = [field(detail, 'direct') ? 'direct' : 'transitive'];
  if (field(detail, 'dev')) tags.push('dev only');
  if (field(detail, 'unfixed')) tags.push('no fix for every advisory');
  const more = field(detail, 'more');
  return {
    pkg: `${text(field(detail, 'package'))} ${version}`,
    fixed: text(field(detail, 'fixed')),
    tags,
    list: items(field(detail, 'advisories')).map(advisory => {
      const severity = severityOf(advisory);
      const cvss = finite(field(advisory, 'cvss'));
      const epss = finite(field(advisory, 'epss'));
      return {
        severity: text(field(advisory, 'severity')) || 'unrated',
        icon: (severity ? SEVERITY[severity] : SEVERITY.warning).icon,
        id: text(field(advisory, 'id')),
        cve: text(field(advisory, 'cve')),
        cvss: cvss !== null ? `CVSS ${cvss.toFixed(1)}` : '',
        kev: Boolean(field(advisory, 'kev')),
        epss: epss !== null ? `EPSS ${percent(epss)}` : '',
        summary: text(field(advisory, 'summary')) || (field(advisory, 'severity') ? '' : 'Not rated in this audit')
      };
    }),
    more: more ? `and ${text(more)} more` : ''
  };
}
/* An advisory id a link may be made of. */
export const ADVISORY_ID = /^[A-Za-z][A-Za-z0-9._-]{2,63}$/;

export interface TraceStep {
  readonly role: string;
  readonly roleWord: string;
  readonly note: string;
  readonly path: string;
  readonly line: unknown;
  readonly place: string;
}
export function trace(finding: unknown): { readonly head: string; readonly steps: readonly TraceStep[]; readonly more: string } {
  const all = items(field(finding, 'trace'));
  const shown = all.slice(0, 12);
  const source = text(field(finding, 'source'));
  return {
    head: source ? `Traced from a ${source}` : 'Traced path',
    steps: shown.map(step => {
      const note = text(field(step, 'note'));
      const path = text(field(step, 'path'));
      const line = field(step, 'line');
      return {
        role: text(field(step, 'role')) || 'propagation',
        roleWord: entry(STEP_ROLE, field(step, 'role')) ?? 'Passes',
        note: note.charAt(0).toUpperCase() + note.slice(1),
        path,
        line,
        place: line ? `${path}:${text(line)}` : path
      };
    }),
    more: all.length > shown.length ? `and ${all.length - shown.length} more steps` : ''
  };
}

export interface FindingRow {
  readonly raw: unknown;
  readonly id: string;
  readonly severity: string;
  readonly toConfirm: boolean;
  readonly pill: Chip | null;
  readonly title: string;
  readonly where: string;
  readonly family: string;
  readonly detail: string | null;
  readonly tags: readonly Chip[];
  readonly why: string;
  readonly clock: ClockLine | null;
  readonly lapsed: string | null;
  readonly reach: { readonly through: string; readonly framework: string; readonly chip: Chip | null } | null;
  readonly trace: ReturnType<typeof trace> | null;
  readonly validation: { readonly blocker: string; readonly check: string } | null;
  readonly licenceFacts: readonly (readonly [string, string])[] | null;
  readonly advisories: ReturnType<typeof advisories> | null;
  readonly intel: Intel | null;
  readonly fix: string;
  readonly rule: string;
  readonly location: string;
  readonly openable: boolean;
  readonly standards: readonly StandardLink[];
  readonly triage: { readonly label: string; readonly name: string } | null;
}
/*
 * One finding: a row that says how bad, what and where, opened into its
 * reason, its fix, the advisories behind it and a prompt. A repository
 * finding's place opens the file; a site finding's place is a header or a
 * path on the site, and is shown, not followed.
 */
export function findingRow(finding: unknown, context: {
  readonly changes: AuditChanges | null; readonly families: ReadonlyMap<unknown, unknown> | null; readonly view: unknown; readonly now: number;
  readonly offered: { readonly open: boolean; readonly triage: boolean };
}): FindingRow {
  const severity = severityOf(finding);
  const toConfirm = verdictOf(finding) === 'needs-validation';
  const id = field(finding, 'id');
  const tags: Chip[] = [];
  const kev = kevChip(finding, true);
  if (kev) tags.push(kev);
  const reach = field(finding, 'reach');
  if (toConfirm) tags.push(verdictChip(finding));
  else if (field(reach, 'auth') === 'open') { const chip = reachChip(reach); if (chip) tags.push(chip); }
  if (context.changes && context.changes.newIds.has(id)) tags.push({ tone: 'info', word: 'New', className: 'audit-new', beam: true });
  const due = clockChip(finding, context.now);
  if (due) tags.push(due);
  const triage = field(finding, 'triage');
  const lapsed = Boolean(field(triage, 'lapsed'));
  if (lapsed) tags.push({ tone: 'warning', word: 'Acceptance lapsed', glyph: ICON_FLAG, className: 'audit-lapsed-chip' });
  const detail = field(finding, 'detail');
  const dependency = Boolean(detail && field(detail, 'package') && Array.isArray(field(detail, 'advisories')));
  const guard = entry(REACH, field(reach, 'auth'));
  const route = text(field(reach, 'route'));
  const blocker = text(field(finding, 'blocker'));
  const check = text(field(finding, 'check'));
  return {
    raw: finding,
    id: text(id),
    severity: text(field(finding, 'severity')),
    toConfirm,
    pill: severity ? severityChip(severity, { className: `audit-pill audit-pill-${severity}` }) : null,
    title: text(field(finding, 'title')),
    where: text(field(finding, 'where')) || location(finding),
    family: context.families ? text(context.families.get(field(finding, 'category'))) : '',
    detail: detailChip(finding),
    tags,
    why: text(field(finding, 'why')),
    clock: clockLine(finding, context.now),
    lapsed: lapsed ? `${decisionSentence(triage, context.view, context.now)} It is open again.` : null,
    reach: reach ? {
      through: route ? `${verbs(field(reach, 'method'))} ${route}` : field(reach, 'method') === 'ACTION' ? 'a server action' : 'an endpoint',
      framework: entry(FRAMEWORK_NAME, field(reach, 'framework')) ?? '',
      chip: guard ? { tone: guard.tone, word: guard.word, glyph: guard.icon } : null
    } : null,
    trace: items(field(finding, 'trace')).length ? trace(finding) : null,
    validation: toConfirm && (blocker || check) ? { blocker, check } : null,
    licenceFacts: field(finding, 'category') === 'licences' && detail && field(detail, 'package') ? licenceFactList(detail) : null,
    advisories: dependency ? advisories(detail) : null,
    intel: dependency && (field(detail, 'risk') || field(detail, 'intel') || field(detail, 'usage')) ? intel(finding, context.offered) : null,
    fix: text(field(finding, 'fix')),
    rule: text(field(finding, 'rule')),
    location: location(finding),
    openable: Boolean(field(finding, 'path')) && context.offered.open,
    standards: standardLinks(field(finding, 'standards')),
    triage: context.offered.triage && canTriage(context.view, true) ? {
      label: lapsed ? 'Decide again' : 'Triage',
      name: `Triage: ${text(field(finding, 'title'))}, ${location(finding)}`
    } : null
  };
}

export interface Segment {
  readonly value: string | null;
  readonly key: string;
  readonly text: string;
  readonly count: number;
  readonly pressed: boolean;
  readonly disabled: boolean;
  readonly icon: string | null;
  readonly name: string | null;
}
export interface Findings {
  readonly title: string;
  readonly inScope: number;
  readonly showAll: boolean;
  readonly severities: readonly Segment[] | null;
  readonly verdicts: readonly Segment[] | null;
  readonly exploits: readonly Segment[] | null;
  readonly search: { readonly query: string } | null;
  readonly empty: string | null;
  readonly rows: readonly FindingRow[];
  readonly more: { readonly limit: number; readonly next: number; readonly said: string; readonly of: string } | null;
  readonly triaged: readonly TriagedRow[];
  readonly waived: readonly WaivedRow[];
  readonly triageUnavailable: boolean;
}
export interface TriagedRow {
  readonly raw: unknown;
  readonly id: string;
  readonly severity: string;
  readonly icon: string;
  readonly title: string;
  readonly state: { readonly tone: Tone; readonly word: string } | null;
  readonly rule: string;
  readonly where: string;
  readonly reason: string;
  readonly history: string | null;
  readonly reopen: string | null;
}
export interface WaivedRow {
  readonly severity: string;
  readonly icon: string;
  readonly title: string;
  readonly rule: string;
  readonly where: string;
  readonly policy: string;
  readonly reason: string;
}
const severityIcon = (finding: unknown): string => {
  const severity = severityOf(finding);
  return severity ? SEVERITY[severity].icon : SEVERITY.warning.icon;
};
export function findings(view: unknown, now: number, offered: {
  readonly open: boolean; readonly triage: boolean; readonly history: boolean; readonly reopen: boolean;
}): Findings | null {
  const result = field(view, 'result');
  if (!result) return null;
  const categories = items(field(result, 'categories'));
  const filter = field(view, 'filter');
  const owasp = field(view, 'owasp');
  const familyLabel = filter ? text(field(categories.find(category => field(category, 'id') === filter), 'label')) : '';
  const owaspEntry = owasp ? OWASP.find(([id]) => id === owasp) : undefined;
  const owaspLabel = owasp ? `OWASP ${text(owasp)} ${owaspEntry ? owaspEntry[1] : ''}`.trim() : '';
  const scope = [familyLabel, owaspLabel].filter(Boolean).join(' · ');
  const families = new Map(categories.map(category => [field(category, 'id'), field(category, 'label')]));
  const all = findingsOf(result);
  const inScope = all.filter(finding => (!filter || field(finding, 'category') === filter)
    && (!owasp || at(finding, 'standards', 'owasp') === `${text(owasp)}:${OWASP_EDITION}`));
  const severity = field(view, 'severity') || null;
  const verdict = field(view, 'verdict') || null;
  const exploit = field(view, 'exploit') || null;
  const query = text(field(view, 'query'));
  const counts = severityCounts(inScope);
  const leads = inScope.filter(finding => verdictOf(finding) === 'needs-validation').length;
  const live = inScope.filter(exploited).length;
  const segment = (value: string | null, key: string, said: string, count: number, pressed: boolean, disabled: boolean, icon: string | null, name: string | null): Segment =>
    ({ value, key, text: said, count, pressed, disabled, icon, name });
  const shown = inScope.filter(finding => (!severity || field(finding, 'severity') === severity)
    && (!verdict || verdictOf(finding) === verdict) && (!exploit || exploited(finding)) && matches(finding, query, families));
  const limit = Math.max(PAGE, Number(field(view, 'limit')) || PAGE);
  const changes = changesOf(field(view, 'diff'));
  const suppressed = items(field(result, 'suppressed'));
  return {
    title: scope ? `Findings — ${scope}` : 'Findings',
    inScope: inScope.length,
    showAll: Boolean(filter || owasp),
    severities: inScope.length ? [
      segment(null, 'severity:all', 'All', inScope.length, severity === null, false, null, null),
      ...ORDER.map(value => segment(value, `severity:${value}`, SEVERITY[value].word, counts[value], severity === value, !counts[value], SEVERITY[value].icon, null))
    ] : null,
    verdicts: inScope.length && (leads || verdict) ? [
      segment(null, 'verdict:all', 'Any', inScope.length, verdict === null, false, null, null),
      segment('confirmed', 'verdict:confirmed', 'Confirmed', inScope.length - leads, verdict === 'confirmed', !(inScope.length - leads) && verdict !== 'confirmed', VERDICT.confirmed.icon, null),
      segment('needs-validation', 'verdict:needs-validation', 'To confirm', leads, verdict === 'needs-validation', !leads && verdict !== 'needs-validation', VERDICT['needs-validation'].icon, null)
    ] : null,
    exploits: inScope.length && (live || exploit) ? [
      /* "Any" is also the verdict group's first option: the name says which question it answers. */
      segment(null, 'exploit:any', 'Any', inScope.length, exploit === null, false, null, `Any exploitation, ${inScope.length}`),
      segment('kev', 'exploit:kev', 'Exploited', live, exploit === 'kev', !live && exploit !== 'kev', ICON_FLAME, `Exploited in the wild, ${live}`)
    ] : null,
    search: inScope.length && (inScope.length > 3 || query) ? { query } : null,
    empty: shown.length ? null : query ? `Nothing matches “${query.trim()}”.` : filter || owasp ? 'Nothing found here, in what was read.' : 'Nothing found, in what was read.',
    rows: shown.slice(0, limit).map(finding => findingRow(finding, { changes, families, view, now, offered })),
    more: shown.length > limit ? { limit, next: limit + PAGE, said: `Show ${Math.min(PAGE, shown.length - limit)} more`, of: `${limit} of ${shown.length}` } : null,
    triaged: suppressed.filter(finding => at(finding, 'suppression', 'triage')).map(finding => {
      const decision = at(finding, 'suppression', 'triage');
      const state = entry(DISPOSITION, field(decision, 'disposition'));
      return {
        raw: finding,
        id: idOf(finding),
        severity: text(field(finding, 'severity')),
        icon: severityIcon(finding),
        title: text(field(finding, 'title')),
        state: state ? { tone: state.tone, word: state.word } : null,
        rule: text(field(finding, 'rule')),
        where: location(finding),
        reason: decisionSentence(decision, view, now),
        history: offered.history && at(view, 'triage', 'status') === 'ready' ? `Decisions about ${text(field(finding, 'title'))}, ${location(finding)}` : null,
        reopen: offered.reopen && canTriage(view, offered.triage) ? `Reopen ${text(field(finding, 'title'))}, ${location(finding)}` : null
      };
    }),
    waived: suppressed.filter(finding => !at(finding, 'suppression', 'triage')).map(finding => {
      const reason = text(at(finding, 'suppression', 'reason'));
      return {
        severity: text(field(finding, 'severity')),
        icon: severityIcon(finding),
        title: text(field(finding, 'title')),
        rule: text(field(finding, 'rule')),
        where: location(finding),
        policy: text(at(finding, 'suppression', 'policy')),
        reason
      };
    }),
    triageUnavailable: Boolean(at(result, 'triage', 'unavailable'))
  };
}
