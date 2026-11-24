/*
 * The repository audit's cards between the summary and the findings, decided:
 * what has been published since the last audit, what to fix first, the
 * dependency risk, the families, the attack surface, the licences, what was
 * covered and what is already in place, and the OWASP Top 10. Every value is
 * read as it arrived; nothing here draws (AuditCards.tsx does).
 */
import { field, items } from '../../platform/values.ts';
import {
  LEDGER_STATUS, LICENCE_FAMILY, LICENCE_ORDER, ORDER, REACH, REACH_TIER, RISK_BAND, RISK_ORDER, SEVERITY,
  at, detailChip, entry, exploited, finite, intelOf, intelSources, ledgerStatus, location, plural, resultId, riskOf, riskRanked,
  severityCounts, severityOf, text, tierPhrase, tierSentence, usageOf, verdictOf
} from './audit-terms.ts';
import type { LedgerStatus, LicenceFamily, RiskBand, Severity, Tone } from './audit-terms.ts';
import {
  ICON_FLAME, ICON_NEWS, ICON_RANSOM, epssChip, findingsOf, idOf, kevChip, latestStored, reachChip, severityChip, statusOf, tierChip, verdictChip, when
} from './audit-screen.ts';
import type { Chip } from './audit-screen.ts';

/* ---- Since the last audit ---------------------------------------------------- */

export interface WatchRow {
  readonly kind: string;
  readonly glyphTone: Tone;
  readonly exploitedKind: boolean;
  readonly name: string;
  readonly version: string;
  readonly fixed: string;
  readonly said: string;
  readonly advisory: string;
  readonly kev: string;
  readonly tags: readonly Chip[];
}
export interface Watch {
  readonly id: string;
  readonly alerts: boolean;
  readonly lede: string;
  readonly state: { readonly state: string; readonly pulse: boolean; readonly icon: 'news' | 'check' | 'unknown' | null; readonly said: string };
  readonly rows: readonly WatchRow[];
  readonly check: { readonly label: string; readonly disabled: boolean; readonly title: string | null };
  readonly again: boolean;
}
export const WATCH_FOLD = 6;
function watchSentence(alert: unknown): string {
  const cve = text(field(alert, 'cve'));
  if (field(alert, 'kind') === 'exploited') {
    const added = text(field(alert, 'kevAdded'));
    const due = text(field(alert, 'kevDue'));
    return `CISA added ${cve} to its catalog of vulnerabilities exploited in the wild${added ? ` on ${added}` : ''}${due ? `; US federal agencies must fix it by ${due}` : ''}. The audit reported it before it was listed.`;
  }
  const where = field(alert, 'dev') ? ' It is a development dependency.' : field(alert, 'direct') ? '' : ' It comes in through another package.';
  const fixed = text(field(alert, 'fixed'));
  const fix = field(alert, 'malicious') ? ' Known malicious: remove it and rotate what it could reach.' : fixed ? ` Fixed in ${fixed}.` : ' No fixed version is published yet.';
  return `Published after the audit${cve ? `, as ${cve}` : ''}.${fix}${where}`;
}
function watchRow(alert: unknown): WatchRow {
  const kind = text(field(alert, 'kind'));
  const exploitedNow = Boolean(field(alert, 'exploited'));
  const severity = severityOf(alert);
  const tags: Chip[] = [{ tone: kind === 'exploited' ? 'critical' : 'info', word: kind === 'exploited' ? 'Newly exploited' : 'New advisory',
    glyph: kind === 'exploited' ? ICON_FLAME : ICON_NEWS, beam: exploitedNow && !field(alert, 'dev'), className: 'audit-watch-kind' }];
  if (severity) tags.push(severityChip(severity));
  if (kind === 'advisory' && exploitedNow) tags.push({ tone: 'critical', word: 'Exploited', glyph: ICON_FLAME, className: 'audit-kev' });
  if (field(alert, 'ransomware')) tags.push({ tone: 'critical', word: 'Ransomware', glyph: ICON_RANSOM });
  const epss = epssChip(field(alert, 'epss'), undefined, field(alert, 'cve'));
  if (epss) tags.push(epss);
  if (field(alert, 'dev')) tags.push({ tone: 'neutral', word: 'Dev only', glyph: REACH_TIER.dev.icon });
  const cve = text(field(alert, 'cve'));
  return {
    kind,
    glyphTone: exploitedNow ? 'critical' : severity ?? 'pending',
    exploitedKind: kind === 'exploited',
    name: text(field(alert, 'name')),
    version: text(field(alert, 'version')),
    fixed: field(alert, 'fixed') && !field(alert, 'malicious') ? text(field(alert, 'fixed')) : '',
    said: watchSentence(alert),
    advisory: text(field(alert, 'id')),
    kev: cve && (kind === 'exploited' || exploitedNow) ? cve : '',
    tags
  };
}
export function watch(view: unknown, now: number, offered: { readonly run: boolean }): Watch | null {
  const state = field(view, 'watch');
  const status = field(state, 'status');
  if (status !== 'checking' && status !== 'ready' && status !== 'error') return null;
  const data = field(state, 'data') || {};
  const audit = field(data, 'audit') || latestStored(view);
  if (!audit) return null;
  const alerts = items(field(data, 'alerts'));
  const ref = text(field(audit, 'ref'));
  const components = Number(field(data, 'components')) || Number(field(audit, 'components')) || 0;
  const since = `since the audit of ${when(field(audit, 'auditedAt'), now).absolute}`;
  let said: Watch['state'];
  if (status === 'checking') {
    said = { state: 'checking', pulse: true, icon: null, said: `Asking OSV and CISA about ${plural(components, 'package version', 'package versions')} of ${ref}…` };
  } else if (status === 'error') {
    said = { state: 'error', pulse: false, icon: null, said: text(field(state, 'error')) || 'The watch could not be checked. Nothing is marked new, and nothing is marked clear.' };
  } else {
    const checked = field(audit, 'watch') || null;
    const checkedState = text(field(checked, 'state'));
    const words: string[] = [];
    if (!checked) words.push(`Not checked yet ${since}.`);
    else if (alerts.length) words.push(`${plural(alerts.length, 'new item', 'new items')} for ${plural(components, 'package version', 'package versions')} ${since}.`);
    else if (checkedState === 'unavailable') words.push('OSV could not be reached. Nothing is marked new, and nothing is marked clear.');
    else words.push(`Nothing new for ${plural(components, 'package version', 'package versions')} ${since}.`);
    if (checked) {
      const kev = field(checked, 'kev');
      const sources = kev === 'ok' ? 'OSV and CISA’s exploited catalog' : kev === 'unavailable' ? 'OSV (CISA’s catalog could not be read)' : 'OSV';
      const checkedAt = field(checked, 'checkedAt');
      words.push(Date.parse(text(checkedAt)) <= Date.parse(text(field(audit, 'auditedAt'))) + 60000
        ? `Last asked by the audit itself, ${when(checkedAt, now).relative}.`
        : `Last asked of ${sources} ${when(checkedAt, now).relative}.`);
      const answered = finite(field(checked, 'checked'));
      const total = finite(field(checked, 'total'));
      if (checkedState === 'partial' && answered !== null && total !== null) words.push(`${answered} of ${total} answered; the rest are asked again next time.`);
    }
    said = { state: !checked ? 'pending' : alerts.length ? 'alerts' : checkedState, pulse: false, icon: alerts.length ? 'news' : checkedState === 'ok' ? 'check' : 'unknown', said: words.join(' ') };
  }
  const checkableAt = field(data, 'checkableAt');
  const tooSoon = Boolean(checkableAt) && Date.parse(text(checkableAt)) > now;
  return {
    id: idOf(audit),
    alerts: alerts.length > 0,
    lede: `What has been published since the last audit of ${ref}: new advisories for the package versions it found, and CVEs CISA has since listed as exploited. OSV and CISA are asked every six hours, by package name and version only.`,
    state: said,
    rows: status === 'checking' ? [] : alerts.map(watchRow),
    check: {
      label: status === 'checking' ? 'Checking…' : 'Check now',
      disabled: status === 'checking' || tooSoon,
      title: tooSoon ? `Asked ${when(at(audit, 'watch', 'checkedAt'), now).relative}; it can be asked again ${when(checkableAt, now).relative}.` : null
    },
    again: alerts.length > 0 && statusOf(view) !== 'running' && offered.run
  };
}

/* ---- Fix first ------------------------------------------------------------------ */

export interface Priority {
  readonly id: string;
  readonly severity: Severity | null;
  readonly severityText: string;
  readonly name: string;
  readonly rank: number;
  readonly chip: Chip | null;
  readonly title: string;
  readonly where: string;
  readonly detail: string | null;
  readonly extra: readonly Chip[];
}
export function priorities(view: unknown): readonly Priority[] {
  const result = field(view, 'result');
  const chosenIds = items(field(result, 'priorities'));
  if (!result || !chosenIds.length || field(view, 'filter') || field(view, 'severity')) return [];
  const byId = new Map(findingsOf(result).map(finding => [field(finding, 'id'), finding]));
  return chosenIds.map(id => byId.get(id)).filter((finding): finding is NonNullable<unknown> => Boolean(finding)).map((finding, index) => {
    const severity = severityOf(finding);
    const toConfirm = verdictOf(finding) === 'needs-validation';
    const kev = kevChip(finding, true);
    const extra: Chip[] = [];
    if (kev) extra.push(kev);
    const reach = field(finding, 'reach');
    if (toConfirm) extra.push(verdictChip(finding));
    else if (field(reach, 'auth') === 'open') { const chip = reachChip(reach); if (chip) extra.push(chip); }
    else if (!kev && riskOf(finding) && usageOf(finding)) { const chip = tierChip(usageOf(finding)); if (chip) extra.push(chip); }
    return {
      id: idOf(finding),
      severity,
      severityText: text(field(finding, 'severity')),
      name: `${index + 1}. ${severity ? SEVERITY[severity].word : text(field(finding, 'severity'))}${toConfirm ? ', to confirm' : ''}${exploited(finding) ? ', exploited in the wild' : ''}: ${text(field(finding, 'title'))}, ${location(finding)}`,
      rank: index + 1,
      chip: severity ? severityChip(severity, { beam: (severity === 'critical' && !toConfirm) || exploited(finding) }) : null,
      title: text(field(finding, 'title')),
      where: location(finding),
      detail: detailChip(finding),
      extra
    };
  });
}

/* ---- Dependency risk ---------------------------------------------------------- */

export interface RiskRowView {
  readonly id: string;
  readonly band: string;
  readonly hiddenUnlessAll: boolean;
  readonly name: string;
  readonly score: number;
  readonly meter: number;
  readonly bandWord: string;
  readonly pkg: string;
  readonly version: string;
  readonly fixed: string;
  readonly sub: string;
  readonly subTitle: string | null;
  readonly places: number;
  readonly tags: readonly Chip[];
}
export interface Risk {
  readonly id: string;
  readonly exploitedToggle: { readonly count: number; readonly pressed: boolean; readonly label: string } | null;
  readonly catalogUnavailable: boolean;
  readonly ransom: number;
  readonly bands: readonly { readonly band: RiskBand; readonly count: number }[];
  readonly rows: readonly RiskRowView[];
  readonly note: string;
}
export const RISK_FOLD = 6;
export function risk(view: unknown): Risk | null {
  const result = field(view, 'result');
  if (!result || field(view, 'filter') || field(view, 'owasp')) return null;
  const ranked = riskRanked(findingsOf(result));
  if (!ranked.length) return null;
  const findings = ranked.map(row => row.finding);
  const live = findings.filter(exploited).length;
  const ransom = findings.filter(finding => exploited(finding) && field(intelOf(finding), 'ransomware')).length;
  const exploit = at(result, 'coverage', 'exploit');
  const catalogRead = field(exploit, 'kev') === 'ok';
  const sources = intelSources(result);
  return {
    id: resultId(result),
    exploitedToggle: live || catalogRead ? {
      count: live,
      pressed: Boolean(field(view, 'exploit')),
      label: live ? `${plural(live, 'package', 'packages')} exploited in the wild: show only these findings` : 'No package is exploited in the wild'
    } : null,
    catalogUnavailable: !(live || catalogRead) && field(exploit, 'kev') === 'unavailable',
    ransom,
    bands: RISK_ORDER.map(band => ({ band, count: findings.filter(finding => field(riskOf(finding), 'band') === band).length })),
    rows: ranked.map(({ finding, places }, index) => {
      const detail = field(finding, 'detail');
      const riskOfFinding = riskOf(finding);
      const band = entry(RISK_BAND, field(riskOfFinding, 'band'));
      const score = Number(field(riskOfFinding, 'score')) || 0;
      const version = text(field(detail, 'source') === 'range' ? field(detail, 'range') : field(detail, 'version'));
      const usage = field(detail, 'usage');
      const malicious = field(finding, 'rule') === 'DEP-006';
      const tags: Chip[] = [];
      const kev = kevChip(finding, true);
      if (kev) tags.push(kev);
      if (field(intelOf(finding), 'ransomware')) tags.push({ tone: 'critical', word: 'Ransomware', glyph: ICON_RANSOM });
      const epss = at(intelOf(finding), 'epss');
      const epssTag = epss ? epssChip(field(epss, 'score'), field(epss, 'percentile'), field(epss, 'cve')) : null;
      if (epssTag) tags.push(epssTag);
      const tier = tierChip(usage);
      if (tier) tags.push(tier);
      return {
        id: idOf(finding),
        band: text(field(riskOfFinding, 'band')),
        hiddenUnlessAll: index >= RISK_FOLD,
        name: `Risk ${text(field(riskOfFinding, 'score'))}, ${band ? band.word : text(field(riskOfFinding, 'band'))}: ${text(field(detail, 'package'))} ${version}${exploited(finding) ? ', exploited in the wild' : ''}. ${tierSentence(usage)}`,
        score,
        meter: Math.max(0, Math.min(100, score)),
        bandWord: band ? band.word : text(field(riskOfFinding, 'band')),
        pkg: text(field(detail, 'package')),
        version,
        fixed: field(detail, 'fixed') && !malicious ? text(field(detail, 'fixed')) : '',
        sub: malicious ? 'Known malicious: remove it and rotate what it could reach.' : tierPhrase(usage),
        subTitle: usage ? tierSentence(usage) : null,
        places,
        tags
      };
    }),
    note: `Risk is (40 × CVSS impact + 60 × threat) × reach, out of 100: threat is 1 for a vulnerability being exploited and otherwise EPSS on a log scale; reach is from the imports in the files read.${sources ? ` Sources: ${sources}.` : ''}`
  };
}

/* ---- Families ------------------------------------------------------------------- */

export interface Family {
  readonly id: string;
  readonly label: string;
  readonly pressed: boolean;
  readonly status: 'critical' | 'serious' | 'warning' | 'clear';
  readonly graded: boolean;
  readonly score: string;
  readonly counts: readonly { readonly severity: Severity; readonly count: number }[];
  readonly leads: number;
  readonly fill: string;
}
export function families(view: unknown): { readonly lede: string; readonly families: readonly Family[] } | null {
  const result = field(view, 'result');
  if (!result) return null;
  const categories = items(field(result, 'categories'));
  return {
    lede: categories.some(category => field(category, 'weight') === 0)
      ? 'Each scored on its own out of 100; licences are reported but not graded. Choose one to narrow the findings to it.'
      : 'Each scored on its own out of 100. Choose one to narrow the findings to it.',
    families: categories.map(category => {
      const counts = field(category, 'counts');
      const count = (severity: Severity): number => Number(field(counts, severity)) || 0;
      const toConfirm = field(category, 'toConfirm');
      return {
        id: idOf(category),
        label: text(field(category, 'label')),
        pressed: field(view, 'filter') === field(category, 'id'),
        status: count('critical') ? 'critical' : count('serious') ? 'serious' : count('warning') ? 'warning' : 'clear',
        /* A family weighed at nothing -- licences -- is reported, not scored. */
        graded: field(category, 'weight') !== 0,
        score: text(field(category, 'score')),
        counts: ORDER.filter(severity => count(severity)).map(severity => ({ severity, count: count(severity) })),
        leads: toConfirm ? ORDER.reduce((total, severity) => total + (Number(field(toConfirm, severity)) || 0), 0) : 0,
        fill: `${text(field(category, 'score'))}%`
      };
    })
  };
}

/* ---- Attack surface ---------------------------------------------------------- */

export interface Guard {
  readonly path: string;
  readonly before: string;
}
export interface Route {
  readonly hiddenUnlessAll: boolean;
  readonly method: string;
  readonly route: string;
  readonly framework: string;
  readonly path: string;
  readonly where: string;
  /* The entry as it arrived, for the page to open its file. */
  readonly raw: unknown;
  readonly auth: { readonly tone: Tone; readonly word: string; readonly icon: string; readonly beam: boolean };
  readonly writes: boolean;
  readonly admin: boolean;
}
export interface Surface {
  readonly id: string;
  readonly counts: { readonly endpoints: number; readonly actions: number; readonly guarded: number; readonly open: number; readonly unknown: number; readonly mutating: number };
  readonly guards: readonly Guard[];
  readonly routes: readonly Route[];
  readonly truncated: boolean;
}
export const SURFACE_FOLD = 6;
/* An endpoint's guard, in the endpoint list's words. */
const ENDPOINT_AUTH: Readonly<Record<'guarded' | 'open' | 'unknown' | 'platform', { readonly word: string; readonly tone: Tone; readonly icon: string }>> = Object.freeze({
  guarded: Object.freeze({ word: 'Signed in', tone: 'neutral', icon: REACH.guarded.icon }),
  open: Object.freeze({ word: 'Open', tone: 'warning', icon: REACH.open.icon }),
  unknown: Object.freeze({ word: 'Guard to confirm', tone: 'pending', icon: REACH.guarded.icon }),
  platform: Object.freeze({ word: 'Platform', tone: 'neutral', icon: REACH.guarded.icon })
});
export const FRAMEWORK_NAME: Readonly<Record<string, string>> = Object.freeze({
  express: 'Express', fastify: 'Fastify', koa: 'Koa', hono: 'Hono', next: 'Next.js', 'next-pages': 'Next.js',
  'server-action': 'Server action', sveltekit: 'SvelteKit', remix: 'Remix', 'supabase-edge': 'Edge function',
  serverless: 'Serverless', flask: 'Flask', fastapi: 'FastAPI', django: 'Django',
  'go-http': 'net/http', gin: 'Gin', echo: 'Echo', fiber: 'Fiber', chi: 'chi', gorilla: 'gorilla/mux',
  spring: 'Spring', jaxrs: 'JAX-RS', laravel: 'Laravel', symfony: 'Symfony'
});
/* What needs a look first: open and writing, then a guard to confirm, then open, then the rest. */
function surfaceRank(entryOf: unknown): number {
  const auth = field(entryOf, 'auth');
  const designed = field(entryOf, 'publicByDesign');
  if (auth === 'open' && field(entryOf, 'mutation') && !designed) return 0;
  if (auth === 'unknown') return 1;
  if (auth === 'open' && !designed) return 2;
  return auth === 'open' ? 3 : 4;
}
export function surface(view: unknown): Surface | null {
  const result = field(view, 'result');
  const counts = at(result, 'surface', 'counts');
  if (!counts) return null;
  const count = (name: string): number => Number(field(counts, name)) || 0;
  if (!(count('endpoints') + count('actions'))) return null;
  const guards = items(at(result, 'surface', 'globalGuards'));
  const entries = [...items(at(result, 'surface', 'endpoints'))].sort((a, b) => surfaceRank(a) - surfaceRank(b));
  return {
    id: resultId(result),
    counts: { endpoints: count('endpoints'), actions: count('actions'), guarded: count('guarded'), open: count('open'), unknown: count('unknown'), mutating: count('mutating') },
    guards: guards.slice(0, 4).map((guard, index) => ({
      path: text(field(guard, 'path')),
      before: index === 0 ? '' : index === guards.length - 1 || index === 3 ? ' and ' : ', '
    })),
    routes: entries.map((route, index) => {
      const auth = field(route, 'auth');
      const designed = auth === 'open' && field(route, 'publicByDesign');
      const guard = designed ? { word: 'Public by design', tone: 'neutral' as const, icon: REACH.open.icon } : entry(ENDPOINT_AUTH, auth) ?? ENDPOINT_AUTH.unknown;
      return {
        hiddenUnlessAll: index >= SURFACE_FOLD,
        method: field(route, 'action') ? 'ACTION' : String(field(route, 'method') || 'ANY').split(',').join(' '),
        route: text(field(route, 'route')) || (field(route, 'action') ? 'Server action' : '—'),
        framework: entry(FRAMEWORK_NAME, field(route, 'framework')) ?? '',
        path: text(field(route, 'path')),
        where: location(route),
        raw: route,
        auth: { ...guard, beam: auth === 'open' && Boolean(field(route, 'mutation')) && !field(route, 'publicByDesign') },
        writes: Boolean(field(route, 'mutation')),
        admin: Boolean(field(route, 'admin'))
      };
    }),
    truncated: Boolean(at(result, 'surface', 'truncated'))
  };
}

/* ---- Licences ------------------------------------------------------------------ */

export interface LicenceRow {
  readonly family: string;
  readonly hiddenUnlessAll: boolean;
  readonly findingId: string | null;
  readonly name: string;
  readonly pkg: string;
  readonly version: string;
  readonly licence: string;
  readonly familyWord: string;
  readonly familyTone: Tone;
  readonly kind: 'development' | 'transitive' | null;
}
export interface Licences {
  readonly id: string;
  readonly lede: string;
  readonly stats: readonly { readonly family: LicenceFamily; readonly count: number }[];
  readonly basis: readonly { readonly term: string; readonly value: string; readonly note: string }[];
  readonly rows: readonly LicenceRow[];
  readonly foot: string;
}
export const LICENCE_FOLD = 8;
export function licences(view: unknown): Licences | null {
  const result = field(view, 'result');
  const said = field(result, 'licences');
  const status = field(said, 'status');
  if (!said || !status || !field(status, 'versions') || field(view, 'filter') || field(view, 'owasp')) return null;
  const policyRead = field(said, 'policy');
  const policy = policyRead && !field(policyRead, 'invalid') ? policyRead : null;
  const project = field(said, 'project');
  const expression = text(field(project, 'expression'));
  const against = policy ? `the policy in ${text(field(policy, 'path'))}` : project && expression ? `the project’s own ${expression}` : 'use in proprietary code';
  const families = field(said, 'families');
  const basis: { term: string; value: string; note: string }[] = [];
  const source = text(field(project, 'source'));
  if (project && expression) basis.push({ term: 'Project', value: expression, note: source ? ` from ${source}` : '' });
  else if (project && field(project, 'unread')) basis.push({ term: 'Project', value: 'Not recognised', note: ` ${source} names no licence this audit knows; judged as proprietary code.` });
  else basis.push({ term: 'Project', value: 'None found', note: ' No licence file or manifest licence; judged as proprietary code, all rights reserved.' });
  if (policy) {
    const parts: string[] = [];
    if (field(policy, 'allow') !== null) parts.push(`${text(field(policy, 'allow'))} allowed`);
    if (field(policy, 'deny')) parts.push(`${text(field(policy, 'deny'))} refused`);
    if (field(policy, 'cleared')) parts.push(plural(field(policy, 'cleared'), 'package cleared', 'packages cleared'));
    basis.push({ term: 'Policy', value: text(field(policy, 'path')), note: parts.length ? ` — ${parts.join(', ')}` : '' });
  } else if (policyRead && field(policyRead, 'invalid')) {
    basis.push({ term: 'Policy', value: text(field(policyRead, 'path')), note: ' could not be read, so the default rules applied.' });
  } else {
    basis.push({ term: 'Policy', value: 'Default rules', note: ' Add .nebulaverse/licences.json to allow or refuse licences and clear packages by name.' });
  }
  const findings = findingsOf(result);
  const unread = (Number(field(status, 'unknown')) || 0) + (Number(field(status, 'notAsked')) || 0);
  return {
    id: resultId(result),
    lede: `What each dependency may be used under, judged against ${against}. Reported, not graded.`,
    stats: LICENCE_ORDER.filter(family => field(families, family)).map(family => ({ family, count: Number(field(families, family)) || 0 })),
    basis,
    rows: items(field(said, 'packages')).map((item, index) => {
      const familyEntry = entry(LICENCE_FAMILY, field(item, 'family')) ?? LICENCE_FAMILY.unknown;
      const finding = findings.find(found => field(found, 'category') === 'licences' && at(found, 'detail') &&
        at(found, 'detail', 'package') === field(item, 'package') && at(found, 'detail', 'version') === field(item, 'version') && at(found, 'detail', 'ecosystem') === field(item, 'ecosystem'));
      const licence = text(field(item, 'licence'));
      return {
        family: text(field(item, 'family')),
        hiddenUnlessAll: index >= LICENCE_FOLD,
        findingId: finding ? idOf(finding) : null,
        name: `${text(field(item, 'package'))} ${text(field(item, 'version'))}: ${licence || 'no licence stated'}, ${familyEntry.word}. Show the finding.`,
        pkg: text(field(item, 'package')),
        version: text(field(item, 'version')),
        licence,
        familyWord: familyEntry.word,
        familyTone: familyEntry.tone,
        kind: field(item, 'dev') ? 'development' : !field(item, 'direct') ? 'transitive' : null
      };
    }),
    foot: `${text(field(status, 'known'))} of ${plural(field(status, 'versions'), 'package version', 'package versions')} read: ${text(field(status, 'fromLock'))} from lockfiles, ${text(field(status, 'fromRegistry'))} from deps.dev${unread ? `; ${unread} could not be read` : ''}. ` +
      'Only the package names and versions were asked about. Not legal advice: a lawyer decides what a licence allows.'
  };
}

/* ---- Coverage and what is already in place ---------------------------------------------- */

export interface LedgerItem {
  readonly status: LedgerStatus;
  readonly tone: Tone;
  readonly icon: string;
  readonly word: string;
  readonly label: string;
  readonly detail: string;
  readonly found: string;
}
export interface Coverage {
  readonly ledger: readonly LedgerItem[];
  readonly controls: readonly { readonly label: string; readonly path: string }[];
}
export function coverage(view: unknown): Coverage | null {
  const result = field(view, 'result');
  const ledger = items(field(result, 'ledger'));
  if (!result || !ledger.length) return null;
  return {
    ledger: ledger.map(line => {
      const status = ledgerStatus(line);
      const mark = LEDGER_STATUS[status];
      const found: string[] = [];
      if (field(line, 'confirmed')) found.push(`${text(field(line, 'confirmed'))} confirmed`);
      if (field(line, 'toConfirm')) found.push(`${text(field(line, 'toConfirm'))} to confirm`);
      return { status, tone: mark.tone, icon: mark.icon, word: mark.word, label: text(field(line, 'label')), detail: text(field(line, 'detail')), found: found.join(' · ') };
    }),
    controls: items(field(result, 'controls')).map(control => ({ label: text(field(control, 'label')), path: text(field(control, 'path')) }))
  };
}

/* ---- The OWASP Top 10 --------------------------------------------------------- */

/*
 * The OWASP Top 10:2025, in the short words a tile has room for, and the
 * page on top10.owasp.org each links to. A result saved before the 2025
 * edition still carries 2021 labels; its chips link to the 2021 pages, and
 * the map, which is 2025's, counts only 2025 placements.
 */
export const OWASP_EDITION = '2025';
export const OWASP: readonly (readonly [string, string, string])[] = Object.freeze([
  ['A01', 'Access control', 'A01_2025-Broken_Access_Control'],
  ['A02', 'Misconfiguration', 'A02_2025-Security_Misconfiguration'],
  ['A03', 'Supply chain', 'A03_2025-Software_Supply_Chain_Failures'],
  ['A04', 'Cryptography', 'A04_2025-Cryptographic_Failures'],
  ['A05', 'Injection', 'A05_2025-Injection'],
  ['A06', 'Insecure design', 'A06_2025-Insecure_Design'],
  ['A07', 'Authentication', 'A07_2025-Authentication_Failures'],
  ['A08', 'Integrity', 'A08_2025-Software_or_Data_Integrity_Failures'],
  ['A09', 'Logging & alerting', 'A09_2025-Security_Logging_and_Alerting_Failures'],
  ['A10', 'Exceptional conditions', 'A10_2025-Mishandling_of_Exceptional_Conditions']
] as const);
const OWASP_2021: Readonly<Record<string, string>> = Object.freeze({
  A01: 'A01_2021-Broken_Access_Control', A02: 'A02_2021-Cryptographic_Failures', A03: 'A03_2021-Injection',
  A04: 'A04_2021-Insecure_Design', A05: 'A05_2021-Security_Misconfiguration', A06: 'A06_2021-Vulnerable_and_Outdated_Components',
  A07: 'A07_2021-Identification_and_Authentication_Failures', A08: 'A08_2021-Software_and_Data_Integrity_Failures',
  A09: 'A09_2021-Security_Logging_and_Monitoring_Failures', A10: 'A10_2021-Server-Side_Request_Forgery_%28SSRF%29'
});
const OWASP_2025: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(OWASP.map(([id, , slug]) => [id, `https://top10.owasp.org/2025/${slug}/`])));
function owaspUrl(id: string, year: string): string | null {
  if (year === '2021') { const slug = entry(OWASP_2021, id); return slug ? `https://owasp.org/Top10/${slug}/` : null; }
  return year === '2025' ? entry(OWASP_2025, id) ?? null : null;
}
/* Why a finding sits in its category, in a line a tooltip has room for. */
const OWASP_BASIS: Readonly<Record<string, (cwe: string) => string>> = Object.freeze({
  cwe: (cwe: string) => `OWASP maps ${cwe} to this category`,
  text: () => 'A02 names missing or weak security headers outright',
  scope: (cwe: string) => `${cwe} is on no 2025 list; filed by the category's scope`
});
export const TOP25_URL = 'https://cwe.mitre.org/top25/archive/2025/2025_cwe_top25.html';
export interface OwaspTile {
  readonly id: string;
  readonly word: string;
  readonly status: Severity | 'clear';
  readonly pressed: boolean;
  readonly name: string;
  readonly disabled: boolean;
  readonly count: string;
}
export function standards(view: unknown): { readonly said: string; readonly tiles: readonly OwaspTile[] } | null {
  const result = field(view, 'result');
  const findings = findingsOf(result);
  if (!result || !findings.some(finding => field(finding, 'standards'))) return null;
  const cwes = new Set(findings.map(finding => at(finding, 'standards', 'cwe')).filter(Boolean));
  const top25 = findings.filter(finding => at(finding, 'standards', 'top25')).length;
  return {
    said: `${plural(cwes.size, 'CWE', 'CWEs')} across ${plural(findings.length, 'finding', 'findings')}` + (top25 ? ` · ${plural(top25, 'finding', 'findings')} in the CWE Top 25` : ''),
    tiles: OWASP.map(([id, word]) => {
      const under = findings.filter(finding => at(finding, 'standards', 'owasp') === `${id}:${OWASP_EDITION}`);
      const counts = severityCounts(under);
      return {
        id, word,
        status: ORDER.find(severity => counts[severity]) ?? 'clear',
        pressed: field(view, 'owasp') === id,
        name: `${id} ${word}: ${under.length ? plural(under.length, 'finding', 'findings') : 'clear'}`,
        disabled: !under.length && field(view, 'owasp') !== id,
        count: under.length ? String(under.length) : '✓'
      };
    })
  };
}
/* A finding's CWE, OWASP category and Top 25 rank, each a link to its definition. */
export interface StandardLink {
  readonly className: string;
  readonly text: string;
  readonly href: string;
  readonly title: string;
}
export function standardLinks(standards: unknown): readonly StandardLink[] {
  if (!standards) return [];
  const links: StandardLink[] = [];
  const cwe = text(field(standards, 'cwe'));
  const cweName = text(field(standards, 'cweName'));
  const cweNumber = /^CWE-(\d{1,5})$/.exec(cwe);
  if (cweNumber) links.push({ className: 'audit-std-chip', text: cwe, href: `https://cwe.mitre.org/data/definitions/${cweNumber[1] ?? ''}.html`, title: cweName ? `${cwe}: ${cweName}` : cwe });
  const owasp = text(field(standards, 'owasp'));
  const owaspId = /^(A\d{2}):(2021|2025)$/.exec(owasp);
  const href = owaspId ? owaspUrl(owaspId[1] ?? '', owaspId[2] ?? '') : null;
  if (owaspId && href) {
    const basis = entry(OWASP_BASIS, field(standards, 'owaspBasis'));
    links.push({ className: 'audit-std-chip audit-std-owasp', text: `OWASP ${owaspId[1] ?? ''}`, href, title: `${owasp} ${text(field(standards, 'owaspName'))}${basis ? ` — ${basis(cwe)}` : ''}` });
  }
  const rankNumber = Number(at(standards, 'top25', 'rank'));
  if (at(standards, 'top25') && rankNumber >= 1 && rankNumber <= 25) {
    links.push({ className: 'audit-std-chip audit-std-top25', text: `Top 25 #${rankNumber}`, href: TOP25_URL, title: `${cwe} is number ${rankNumber} in the 2025 CWE Top 25 Most Dangerous Software Weaknesses` });
  }
  return links;
}
