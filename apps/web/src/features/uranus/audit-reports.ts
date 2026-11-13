/*
 * The audit as files a reader hands on: the developer brief (Markdown), SARIF
 * 2.1.0 for code-scanning dashboards, CSV for a spreadsheet, a kept audit's
 * own brief, CSV and SARIF, and the Exposure findings as CSV and SARIF. The
 * bill of materials is audit-sbom.ts's.
 *
 * Rules, places, reasons, fixes, advisories and the prompts -- the words the
 * screen shows, from audit-terms.ts -- and never a line of the code: a
 * result carries none, and nothing here adds any. Every value is read as it
 * arrived; a value a JSON file passes on is passed on as it was sent.
 */
import { field, hasFields, items } from '../../platform/values.ts';
import {
  EVIDENCE_WORD, HEADER_NAMES, LEDGER_NAMES, LEDGER_STATE, LEDGER_STATUS, LICENCE_FAMILY, LICENCE_ORDER, ORDER, REACH, RISK_BAND, STEP_ROLE, VERDICT,
  at, capPhrase, coverageCaveat, coverageLine, detailChip, entry, finite, intelOf, intelSources, ledgerStatus, licenceFactList, location, percent,
  plural, riskOf, riskRanked, siteAssessment, siteAssessmentLine, siteCoverage, siteGraded, text, tierSentence, tierWord, triageJustification, usageOf,
  verbs, verdictOf
} from './audit-terms.ts';
import type { AuditChanges } from './audit-memory.ts';

/* ---- The developer brief -------------------------------------------------- */

/* A Markdown table cell: pipes escaped, one line. */
function cell(value: unknown): string {
  return String(value || '').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
}

/* The standards a finding is filed under, in one line. */
function standardsLine(standards: unknown): string {
  const cwe = text(field(standards, 'cwe'));
  const cweName = text(field(standards, 'cweName'));
  const owasp = text(field(standards, 'owasp'));
  const top25 = field(standards, 'top25');
  return [cwe && `${cwe}${cweName ? ` (${cweName})` : ''}`,
    owasp && `OWASP ${owasp} ${text(field(standards, 'owaspName'))}`,
    top25 && `CWE Top 25 (2025) #${text(field(top25, 'rank'))}`].filter(Boolean).join(' · ');
}

/* A dependency finding's facts: the package, its fix, its advisories, the risk, the exploit evidence and the reach. */
function packageLines(detail: unknown, lines: string[]): void {
  const range = field(detail, 'source') === 'range';
  const version = text(field(detail, 'version'));
  lines.push(`- **Package:** ${text(field(detail, 'package'))} ${range ? `${text(field(detail, 'range'))} (lowest accepted ${version})` : version}${field(detail, 'direct') ? '' : ' (transitive)'}`);
  const fixed = text(field(detail, 'fixed'));
  if (fixed) lines.push(`- **Fixed in:** ${fixed}`);
  const more = field(detail, 'more');
  lines.push(`- **Advisories:** ${items(field(detail, 'advisories')).map(advisory => `${text(field(advisory, 'id'))}${field(advisory, 'cve') ? ` (${text(field(advisory, 'cve'))})` : ''}`).join(', ')}${more ? ` and ${text(more)} more` : ''}`);
  const risk = field(detail, 'risk');
  if (risk) {
    const band = entry(RISK_BAND, field(risk, 'band'));
    lines.push(`- **Risk:** ${text(field(risk, 'score'))}/100${band ? `, ${band.word.toLowerCase()}` : ''}`);
  }
  const intel = field(detail, 'intel');
  const kev = field(intel, 'kev');
  if (intel && field(intel, 'exploited') && kev) {
    lines.push(`- **Exploited in the wild:** ${text(field(kev, 'cve'))}, in CISA’s catalog since ${text(field(kev, 'added')) || 'an unknown date'}${field(intel, 'ransomware') ? '; used in ransomware campaigns' : ''}`);
  }
  const epss = field(intel, 'epss');
  if (intel && epss) lines.push(`- **EPSS:** ${percent(field(epss, 'score'))} (${text(field(epss, 'cve'))}${field(epss, 'date') ? `, ${text(field(epss, 'date'))}` : ''})`);
  const usage = field(detail, 'usage');
  if (usage) {
    const chain = items(field(usage, 'chain'));
    lines.push(`- **Reach:** ${tierSentence(usage)}${chain.length > 1 ? ` Path: ${chain.map(text).join(' → ')}.` : ''}`);
  }
}

/* Each finding as a section: what it is, how sure, where, how it is reached, what it is filed under, and the fix and its prompt. */
function findingSection(findings: readonly unknown[], lines: string[], prefix: string, place: (finding: unknown) => string): void {
  findings.forEach((finding, index) => {
    const evidence = field(finding, 'evidence');
    lines.push(
      `## ${prefix}${index + 1}. ${text(field(finding, 'title'))}`,
      '',
      `- **Severity:** ${text(field(finding, 'severity'))}`,
      ...(field(finding, 'verdict') ? [`- **Verdict:** ${VERDICT[verdictOf(finding)].word.toLowerCase()}${evidence ? ` (${entry(EVIDENCE_WORD, evidence) ?? text(evidence)})` : ''}`] : []),
      `- **Rule:** ${text(field(finding, 'rule'))}`,
      `- **Where:** ${place(finding)}`
    );
    const clock = field(finding, 'clock');
    if (clock) {
      lines.push(`- **Due by:** ${text(field(clock, 'dueAt')).slice(0, 10)}${field(clock, 'state') === 'overdue' ? ' (overdue)' : ''} — ${text(field(clock, 'days'))} days from ${text(field(clock, 'firstSeenAt')).slice(0, 10)}, when it was first seen`);
    }
    const reach = field(finding, 'reach');
    if (reach) {
      const guard = entry(REACH, field(reach, 'auth'));
      const route = text(field(reach, 'route'));
      lines.push(`- **Reached through:** ${route ? `\`${verbs(field(reach, 'method'))} ${route}\`` : 'a server action'}${guard ? ` — ${guard.word.toLowerCase()}` : ''}`);
    }
    const trace = items(field(finding, 'trace'));
    if (trace.length) {
      lines.push(`- **Traced path:** ${trace.map(step => {
        const path = text(field(step, 'path'));
        const line = field(step, 'line');
        return `${entry(STEP_ROLE, field(step, 'role')) ?? 'Passes'} \`${line ? `${path}:${text(line)}` : path}\` (${text(field(step, 'note'))})`;
      }).join(' → ')}`);
    }
    const standards = field(finding, 'standards');
    if (standards) lines.push(`- **Standards:** ${standardsLine(standards)}`);
    const detail = field(finding, 'detail');
    const rule = field(finding, 'rule');
    if (detail && rule === 'SCR-001') lines.push(`- **Credential:** ${text(field(detail, 'credential'))}`);
    if (detail && rule === 'DEP-004') lines.push(`- **Looks like:** ${text(field(detail, 'resembles'))}`);
    if (detail && field(detail, 'package') && field(finding, 'category') === 'licences') {
      for (const [term, value] of licenceFactList(detail)) lines.push(`- **${term}:** ${value}`);
    }
    if (detail && field(detail, 'package') && Array.isArray(field(detail, 'advisories'))) packageLines(detail, lines);
    lines.push('', text(field(finding, 'why')), '');
    if (verdictOf(finding) === 'needs-validation') {
      const blocker = text(field(finding, 'blocker'));
      const check = text(field(finding, 'check'));
      if (blocker) lines.push(`**What is unknown.** ${blocker}`, '');
      if (check) lines.push(`**How to confirm.** ${check}`, '');
    }
    lines.push(`**Fix.** ${text(field(finding, 'fix'))}`, '', '```text', text(field(finding, 'prompt')), '```', '');
  });
}

/* The repository half of the brief. */
function repositoryBrief(result: unknown, lines: string[]): void {
  const findings = items(field(result, 'findings'));
  const leads = findings.filter(finding => verdictOf(finding) === 'needs-validation').length;
  const engine = at(result, 'engine', 'traced') ? field(result, 'engine') : null;
  lines.push(
    `Grade **${text(field(result, 'grade'))}** — ${text(field(result, 'score'))}/100${field(result, 'capped') ? capPhrase(field(result, 'capReason')) : ''}.`,
    `Commit \`${text(field(result, 'commitSha'))}\`, audited ${text(field(result, 'auditedAt')) || new Date().toISOString()}${engine ? ` by ${text(field(engine, 'name'))} ${text(field(engine, 'version'))}` : ''}.`,
    ...(engine ? [`${findings.length - leads} confirmed, ${leads} to confirm. A finding to confirm weighs half and names the check that settles it.`] : []),
    '',
    coverageLine(result),
    coverageCaveat(result),
    '',
    '| Family | Score | Critical | Serious | Warning |',
    '| --- | --- | --- | --- | --- |',
    ...items(field(result, 'categories')).map(category => {
      const counts = field(category, 'counts');
      return `| ${text(field(category, 'label'))} | ${text(field(category, 'score'))} | ${text(field(counts, 'critical'))} | ${text(field(counts, 'serious'))} | ${text(field(counts, 'warning'))} |`;
    }),
    ''
  );
  const ledger = items(field(result, 'ledger'));
  if (ledger.length) {
    lines.push('## Coverage', '', '| Class | Status | What was read |', '| --- | --- | --- |',
      ...ledger.map(line => `| ${text(field(line, 'label'))} | ${LEDGER_STATUS[ledgerStatus(line)].word} | ${cell(field(line, 'detail'))} |`), '');
  }
  const counts = at(result, 'surface', 'counts');
  if (counts && Number(field(counts, 'endpoints')) + Number(field(counts, 'actions'))) {
    const actions = field(counts, 'actions');
    const unknown = field(counts, 'unknown');
    lines.push(`**Attack surface:** ${plural(field(counts, 'endpoints'), 'endpoint', 'endpoints')}${actions ? ` and ${plural(actions, 'server action', 'server actions')}` : ''}; ${text(field(counts, 'guarded'))} signed in, ${text(field(counts, 'open'))} open${unknown ? `, ${text(unknown)} behind a guard to confirm` : ''}; ${text(field(counts, 'mutating'))} write data.`, '');
  }
  const controls = items(field(result, 'controls'));
  if (controls.length) {
    lines.push('**Already in place:**', '', ...controls.map(control => `- ${text(field(control, 'label'))}${field(control, 'path') ? ` (\`${text(field(control, 'path'))}\`)` : ''}`), '');
  }
  const byId = new Map(findings.map(finding => [field(finding, 'id'), finding]));
  const first = items(field(result, 'priorities')).map(id => byId.get(id)).filter(Boolean);
  if (first.length) {
    lines.push('**Fix first:**', '', ...first.map((finding, index) => `${index + 1}. ${text(field(finding, 'title'))} — ${field(finding, 'path') ? `\`${location(finding)}\`` : 'whole repository'}`), '');
  }
  const risky = riskRanked(findings);
  if (risky.length) {
    const sources = intelSources(result);
    lines.push('## Dependency risk', '', 'Ranked by exploitation in the wild, exploit probability and reach. Risk is (40 × CVSS impact + 60 × threat) × reach, out of 100.', '',
      ...(sources ? [`Sources: ${sources}.`, ''] : []),
      '| Risk | Package | Exploited | EPSS | Reach |', '| --- | --- | --- | --- | --- |',
      ...risky.map(({ finding }) => {
        const detail = field(finding, 'detail');
        const intel = intelOf(finding);
        const epss = field(intel, 'epss');
        const risk = field(detail, 'risk');
        const band = entry(RISK_BAND, field(risk, 'band'));
        const said = epss ? `${percent(field(epss, 'score'))} (${text(field(epss, 'cve'))})` : '—';
        const listed = text(at(intel, 'kev', 'cve'));
        const kev = intel && field(intel, 'exploited')
          ? `yes${listed ? ` — ${listed}` : ''}${field(intel, 'ransomware') ? ', ransomware' : ''}`
          : intel && field(intel, 'catalog') === 'unknown' ? 'unknown' : 'no';
        const version = field(detail, 'source') === 'range' ? field(detail, 'range') : field(detail, 'version');
        return `| ${text(field(risk, 'score'))}${band ? ` ${band.word.toLowerCase()}` : ''} | ${cell(`${text(field(detail, 'package'))} ${text(version)}`)} | ${kev} | ${said} | ${cell(tierWord(field(detail, 'usage')))} |`;
      }), '');
  }
  const licensing = field(result, 'licences');
  const status = field(licensing, 'status');
  if (licensing && status && field(status, 'versions')) {
    const policy = field(licensing, 'policy') && !at(licensing, 'policy', 'invalid') ? field(licensing, 'policy') : null;
    const project = field(licensing, 'project');
    const families = field(licensing, 'families');
    const tally = LICENCE_ORDER.filter(family => field(families, family))
      .map(family => `${text(field(families, family))} ${LICENCE_FAMILY[family].word.toLowerCase()}`).join(' · ');
    const expression = text(field(project, 'expression'));
    const source = text(field(project, 'source'));
    lines.push('## Licences', '',
      `Judged against ${policy ? `the policy in \`${text(field(policy, 'path'))}\`` : project && expression ? `the project\u2019s own ${expression}${source ? ` (from \`${source}\`)` : ''}` : 'use in proprietary code: no project licence was found'}. Reported, not graded.`, '',
      `${text(field(status, 'known'))} of ${plural(field(status, 'versions'), 'package version', 'package versions')} read: ${tally}.`, '');
    const listed = items(field(licensing, 'packages'));
    if (listed.length) {
      lines.push('| Package | Licence | Family | Kind |', '| --- | --- | --- | --- |',
        ...listed.map(item => `| ${cell(`${text(field(item, 'package'))} ${text(field(item, 'version'))}`)} | ${cell(field(item, 'licence') || 'none stated')} | ${(entry(LICENCE_FAMILY, field(item, 'family')) ?? LICENCE_FAMILY.unknown).word} | ${field(item, 'dev') ? 'development' : field(item, 'direct') ? 'direct' : 'transitive'} |`), '');
    }
  }
  if (!findings.length) lines.push('No findings in what was read.', '');
  findingSection(findings, lines, '', finding => (field(finding, 'path') ? `\`${location(finding)}\`` : 'whole repository'));
  const suppressed = items(field(result, 'suppressed'));
  const triaged = suppressed.filter(finding => at(finding, 'suppression', 'triage'));
  if (triaged.length) {
    lines.push('## Triaged by the team', '', 'Not scored. Each was decided by a person with reviewer access to the repository: a false positive, or a risk accepted until a date, after which it is open again.', '',
      '| Rule | Finding | Where | Decision |', '| --- | --- | --- | --- |',
      ...triaged.map(finding => `| ${text(field(finding, 'rule'))} | ${cell(field(finding, 'title'))} | \`${location(finding)}\` | ${cell(triageJustification(at(finding, 'suppression', 'triage')))} |`), '');
  }
  const waived = suppressed.filter(finding => !at(finding, 'suppression', 'triage'));
  if (waived.length) {
    lines.push('## Waived in code', '', 'Not scored. Each was waived by an `nv-audit-ignore` comment naming its rule, or, for a licence, cleared by name in the repository\u2019s licence policy.', '',
      '| Rule | Finding | Where | Reason |', '| --- | --- | --- | --- |',
      ...waived.map(finding => `| ${text(field(finding, 'rule'))} | ${cell(field(finding, 'title'))} | \`${location(finding)}\` | ${cell(at(finding, 'suppression', 'reason') || 'none given')} |`), '');
  }
}

/* The deployed site's half of the brief. */
function siteBrief(site: unknown, lines: string[]): void {
  lines.push(
    `# Deployed site: ${text(field(site, 'origin'))}`,
    '',
    siteGraded(site)
      ? `Grade **${text(field(site, 'grade'))}** — ${text(field(site, 'score'))}/100${field(site, 'capped') ? ' (held below 50 by a critical finding)' : ''}.`
      : '**Overall grade withheld.**',
    siteAssessmentLine(site),
    `Checked ${text(field(site, 'checkedAt')) || new Date().toISOString()}: ${siteCoverage(site)}`,
    '',
    '| Header | Sent |',
    '| --- | --- |',
    ...items(field(site, 'headers')).map(header => `| ${entry(HEADER_NAMES, field(header, 'name')) ?? text(field(header, 'name'))} | ${field(header, 'present') ? 'yes' : 'no'} |`),
    ''
  );
  const ledger = items(field(site, 'ledger'));
  if (ledger.length) {
    lines.push('## What was checked', '', '| Check | Result | Detail |', '| --- | --- | --- |',
      ...ledger.map(line => `| ${entry(LEDGER_NAMES, field(line, 'id')) ?? text(field(line, 'id'))} | ${entry(LEDGER_STATE, field(line, 'state')) ?? text(field(line, 'state'))} | ${cell(field(line, 'detail'))} |`), '');
  }
  const libraries = items(field(site, 'libraries'));
  if (libraries.length) {
    lines.push('## Browser libraries', '', ...libraries.map(library => {
      const ids = items(field(library, 'ids'));
      const fixed = text(field(library, 'fixed'));
      const state = field(library, 'state');
      return `- ${text(field(library, 'name'))} ${text(field(library, 'version'))}: ${state === 'vulnerable'
        ? `${plural(field(library, 'advisories'), 'advisory', 'advisories')}${ids.length ? ` (${ids.map(text).join(', ')})` : ''}${fixed ? `, fixed in ${fixed}` : ''}`
        : state === 'clean' ? 'no published advisory' : 'not checked'}`;
    }), '');
  }
  const findings = items(field(site, 'findings'));
  if (!findings.length) lines.push(siteAssessment(site).complete ? 'No findings in the completed checks.' : 'No findings in the checks completed so far. Incomplete checks cannot establish that the site is clear.', '');
  findingSection(findings, lines, 'S', finding => `\`${text(field(finding, 'where'))}\``);
}

/*
 * The developer brief: the audit as a Markdown document a reader can hand
 * to whoever fixes it, or to an assistant. Rules, places, reasons, fixes,
 * advisories and the prompts -- the same words the screen shows, and still
 * no code. A run of blank lines is one.
 */
export function brief(result: unknown, repoLabel: unknown, site: unknown): string {
  const lines = [`# Security audit: ${text(repoLabel)}`, ''];
  if (result) repositoryBrief(result, lines);
  if (site) siteBrief(site, lines);
  return lines.filter((line, index, all) => !(line === '' && all[index - 1] === '')).join('\n');
}

/* Every fix prompt of a result, numbered, for a reader to hand an assistant at once. */
export function allPrompts(result: unknown): string {
  return items(field(result, 'findings')).map((finding, index) => `${index + 1}. ${text(field(finding, 'prompt'))}`).join('\n\n');
}

/* ---- SARIF 2.1.0 ---------------------------------------------------------- */

/*
 * The format code-scanning dashboards read. One run per source: the
 * repository, with each result at its file and line, and the deployed site,
 * with each result at its logical place (a header, a path). Waived findings
 * travel as results with an in-source suppression, so a dashboard shows them
 * as dismissed rather than losing them. Rules carry their CWE and OWASP tags
 * and a security-severity GitHub sorts by.
 */
const SARIF_LEVEL: Readonly<Record<string, string>> = Object.freeze({ critical: 'error', serious: 'error', warning: 'warning' });
const SECURITY_SEVERITY: Readonly<Record<string, string>> = Object.freeze({ critical: '9.5', serious: '7.5', warning: '4.0' });
const SARIF_SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json';
const INFORMATION_URI = 'https://github.com/T-rex-G/Nebula-checkpoints';

/* A rule as SARIF describes it; its results find it by its id. */
interface SarifRule {
  readonly id: unknown;
  readonly [key: string]: unknown;
}
interface SarifPlace {
  readonly locations?: readonly unknown[];
}
interface SarifResult {
  readonly properties: Record<string, unknown>;
  suppressions?: readonly unknown[];
  readonly [key: string]: unknown;
}

/* Each rule once, described by the first finding of it. */
function sarifRules(findings: readonly unknown[]): readonly SarifRule[] {
  const rules = new Map<unknown, SarifRule>();
  for (const finding of findings) {
    const rule = field(finding, 'rule');
    if (rules.has(rule)) continue;
    const standards = field(finding, 'standards') || {};
    const cwe = field(standards, 'cwe');
    const owasp = field(standards, 'owasp');
    const top25 = field(standards, 'top25');
    const severity = field(finding, 'severity');
    /* A licence is compliance: a dashboard files it apart from security alerts, and gives it no security severity. */
    const compliance = field(finding, 'category') === 'licences';
    const tags = [compliance ? 'compliance' : 'security', field(finding, 'category'), cwe && `external/cwe/${text(cwe).toLowerCase()}`,
      owasp && `owasp-${text(owasp).replace(':', '-').toLowerCase()}`, top25 && 'cwe-top25-2025'].filter(Boolean);
    rules.set(rule, {
      id: rule,
      name: text(rule).replace('-', ''),
      shortDescription: { text: field(finding, 'title') },
      fullDescription: { text: field(finding, 'why') },
      help: { text: field(finding, 'fix'), markdown: `**Fix.** ${text(field(finding, 'fix'))}` },
      ...(cwe ? { helpUri: `https://cwe.mitre.org/data/definitions/${text(cwe).slice(4)}.html` } : {}),
      defaultConfiguration: { level: entry(SARIF_LEVEL, severity) },
      properties: {
        tags, precision: 'high', 'problem.severity': severity === 'warning' ? 'warning' : 'error', ...(compliance ? {} : { 'security-severity': entry(SECURITY_SEVERITY, severity) }),
        ...(field(standards, 'owaspBasis') ? { 'owasp-basis': field(standards, 'owaspBasis') } : {}),
        ...(top25 ? { 'cwe-top25-2025-rank': field(top25, 'rank') } : {})
      }
    });
  }
  return [...rules.values()];
}

/* Where each rule sits in the run's list, for its results to point at. */
const ruleIndex = (rules: readonly SarifRule[]): Map<unknown, number> => new Map(rules.map((rule, index) => [rule.id, index]));

/* A finding at its file and line, or nowhere in particular when it is about the whole repository. */
function filePlace(finding: unknown): SarifPlace {
  const path = field(finding, 'path');
  const line = field(finding, 'line');
  return path ? { locations: [{ physicalLocation: { artifactLocation: { uri: path, uriBaseId: 'SRCROOT' }, ...(line ? { region: { startLine: line } } : {}) } }] } : {};
}

/* A traced path as a SARIF code flow, which code-scanning dashboards draw step by step. */
function sarifFlow(trace: readonly unknown[]): readonly unknown[] {
  return [{ threadFlows: [{ locations: trace.map(step => {
    const line = field(step, 'line');
    const role = field(step, 'role');
    return {
      location: {
        physicalLocation: { artifactLocation: { uri: field(step, 'path'), uriBaseId: 'SRCROOT' }, ...(line ? { region: { startLine: line } } : {}) },
        message: { text: field(step, 'note') || entry(STEP_ROLE, role) || 'step' }
      },
      kinds: [role === 'entrypoint' ? 'source' : role === 'sink' ? 'sink' : 'pass-through']
    };
  }) }] }];
}

function sarifResult(finding: unknown, index: number | undefined, place: SarifPlace, suppression: unknown): SarifResult {
  const toConfirm = verdictOf(finding) === 'needs-validation';
  const trace = items(field(finding, 'trace'));
  const reach = field(finding, 'reach');
  const risk = riskOf(finding);
  const intel = intelOf(finding);
  const epss = field(intel, 'epss');
  const usage = usageOf(finding);
  const clock = field(finding, 'clock');
  const blocker = field(finding, 'blocker');
  const result: SarifResult = {
    ruleId: field(finding, 'rule'),
    ruleIndex: index,
    /* A lead is a note, not an error: a dashboard should not fail a build on something unconfirmed. */
    level: toConfirm ? 'note' : entry(SARIF_LEVEL, field(finding, 'severity')),
    ...(toConfirm ? { kind: 'review' } : {}),
    message: { text: `${text(field(finding, 'title'))}. ${text(field(finding, 'why'))}${toConfirm && blocker ? ` To confirm: ${text(blocker)}` : ''}` },
    ...place,
    ...(trace.length && field(place.locations?.[0], 'physicalLocation') ? { codeFlows: sarifFlow(trace) } : {}),
    partialFingerprints: { 'nebulaverseFinding/v1': field(finding, 'id') || `${text(field(finding, 'rule'))}:${text(field(finding, 'where')) || location(finding)}` },
    properties: {
      severity: field(finding, 'severity'), family: field(finding, 'category') || 'site',
      ...(field(finding, 'verdict') ? { verdict: verdictOf(finding), evidence: field(finding, 'evidence') || null } : {}),
      ...(reach ? { reach: { method: field(reach, 'method'), route: field(reach, 'route'), auth: field(reach, 'auth') } } : {}),
      ...(toConfirm && field(finding, 'check') ? { howToConfirm: field(finding, 'check') } : {}),
      ...(risk ? { risk: field(risk, 'score'), riskBand: field(risk, 'band') } : {}),
      ...(intel ? {
        knownExploited: Boolean(field(intel, 'exploited')),
        ...(field(intel, 'kev') ? { kev: field(intel, 'kev') } : {}),
        ...(epss ? { epss: field(epss, 'score'), epssPercentile: field(epss, 'percentile'), epssCve: field(epss, 'cve') } : {})
      } : {}),
      ...(usage ? { dependencyReach: field(usage, 'tier') } : {}),
      ...(clock ? { firstSeen: field(clock, 'firstSeenAt'), dueBy: field(clock, 'dueAt'), clock: field(clock, 'state') } : {})
    }
  };
  /* A dependency's own CVSS is a better sort key for a dashboard than the family's default. */
  const cvss = finite(at(finding, 'detail', 'cvss'));
  if (cvss !== null) result.properties['security-severity'] = cvss.toFixed(1);
  /* A team decision is an external suppression, accepted, with who and why; a waiver in the code is one in source. */
  const triage = field(suppression, 'triage');
  if (suppression && triage) result.suppressions = [{ kind: 'external', status: 'accepted', justification: triageJustification(triage) }];
  else if (suppression) result.suppressions = [{ kind: 'inSource', justification: field(suppression, 'reason') || 'Waived in code without a reason.' }];
  return result;
}

const sarifDocument = (runs: readonly unknown[]): string => JSON.stringify({ $schema: SARIF_SCHEMA, version: '2.1.0', runs }, null, 2);

export function sarif(result: unknown, site: unknown, meta: unknown = {}): string {
  const version = field(meta, 'version');
  const driver = (rules: readonly SarifRule[]): unknown => ({
    driver: {
      name: 'Nebulaverse-X Uranus',
      informationUri: field(meta, 'informationUri') || INFORMATION_URI,
      ...(version ? { semanticVersion: version } : {}),
      rules
    }
  });
  const runs: unknown[] = [];
  if (result) {
    const findings = items(field(result, 'findings'));
    const suppressed = items(field(result, 'suppressed'));
    const rules = sarifRules([...findings, ...suppressed]);
    const index = ruleIndex(rules);
    const engine = field(result, 'engine');
    const ledger = field(result, 'ledger');
    const exploit = at(result, 'coverage', 'exploit');
    const ref = field(result, 'ref');
    runs.push({
      tool: driver(rules),
      automationDetails: { id: `nebulaverse-audit/${text(field(meta, 'ref') || ref || 'branch')}/` },
      ...(field(meta, 'repositoryUri') ? { versionControlProvenance: [{ repositoryUri: field(meta, 'repositoryUri'), revisionId: field(result, 'commitSha'), ...(ref ? { branch: ref } : {}) }] } : {}),
      originalUriBaseIds: { SRCROOT: { uri: 'file:///' } },
      results: [
        ...findings.map(finding => sarifResult(finding, index.get(field(finding, 'rule')), filePlace(finding), null)),
        ...suppressed.map(finding => sarifResult(finding, index.get(field(finding, 'rule')), filePlace(finding), field(finding, 'suppression')))
      ],
      properties: {
        grade: field(result, 'grade'), score: field(result, 'score'), capped: Boolean(field(result, 'capped')), ...(field(result, 'capReason') ? { capReason: field(result, 'capReason') } : {}),
        ...(exploit ? { exploitSources: exploit } : {}),
        ...(engine ? { engine: `${text(field(engine, 'name'))} ${text(field(engine, 'version'))}`, traced: field(engine, 'traced') || null } : {}),
        ...(Array.isArray(ledger) ? { coverage: items(ledger).map(line => ({ class: field(line, 'id'), status: field(line, 'status') })) } : {})
      }
    });
  }
  if (site) {
    const findings = items(field(site, 'findings'));
    const rules = sarifRules(findings);
    const index = ruleIndex(rules);
    const origin = field(site, 'origin');
    const coverage = siteAssessment(site);
    runs.push({
      tool: driver(rules),
      automationDetails: { id: `nebulaverse-site/${text(origin)}/` },
      results: findings.map(finding => sarifResult(finding, index.get(field(finding, 'rule')), {
        locations: [{ logicalLocations: [{ name: field(finding, 'where'), fullyQualifiedName: `${text(origin)} ${text(field(finding, 'where'))}`, kind: 'resource' }] }]
      }, null)),
      invocations: [{ executionSuccessful: coverage.complete }],
      properties: { origin, grade: coverage.complete ? field(site, 'grade') : null, score: coverage.complete ? field(site, 'score') : null,
        observedScore: finite(field(site, 'observedScore')), capped: Boolean(field(site, 'capped')), coverage }
    });
  }
  return sarifDocument(runs);
}

/* ---- A kept audit, exported from History ---------------------------------- */

/*
 * What an audit keeps is its grade, counts and coverage and, for each
 * finding, the rule, the place and the package facts -- never a line of
 * code -- and the server adds each rule's own words. The exports say
 * exactly that much: which audit, what it found, and, when fewer findings
 * were kept than found, how many.
 */
const KEPT_WAIVED: Readonly<Record<string, string>> = Object.freeze({ triage: 'triaged by the team', policy: 'cleared by the licence policy', code: 'waived in code' });
const keptWaived = (finding: unknown): string => entry(KEPT_WAIVED, field(finding, 'waived')) ?? 'waived';
function keptPlace(finding: unknown): string {
  const pkg = field(finding, 'package');
  const path = text(field(finding, 'path'));
  if (pkg) return `${text(field(pkg, 'name'))} ${text(field(pkg, 'version'))}${path ? ` (${path})` : ''}`;
  const line = field(finding, 'line');
  return path ? `${path}${line ? `:${text(line)}` : ''}` : 'whole repository';
}
function keptNotes(audit: unknown): string[] {
  const notes: string[] = [];
  const kept = field(audit, 'findings');
  if (kept && Number(field(kept, 'stored')) < Number(field(kept, 'total'))) {
    notes.push(`${text(field(kept, 'stored'))} of ${text(field(kept, 'total'))} findings were kept, the most severe first; the rest are counted above but not listed.`);
  }
  const files = field(audit, 'files');
  if (files && !field(files, 'complete')) notes.push(`Not a complete read: ${text(field(files, 'read'))} of ${text(field(files, 'eligible'))} files were read.`);
  return notes;
}

export function keptBrief(audit: unknown, findings: unknown, label: unknown): string {
  const all = items(findings);
  const open = all.filter(finding => !field(finding, 'waived'));
  const waived = all.filter(finding => field(finding, 'waived'));
  const counts = field(audit, 'counts');
  const exploitedCount = field(audit, 'exploited');
  const lines = [`# Security audit: ${text(label)}`, '',
    `Grade **${text(field(audit, 'grade'))}** — ${text(field(audit, 'score'))}/100${capPhrase(field(audit, 'capReason'))}.`,
    `Commit \`${text(field(audit, 'commitSha'))}\` on ${text(field(audit, 'ref'))}, audited ${text(field(audit, 'auditedAt'))} by Uranus ${text(field(audit, 'engine'))}.`,
    `${ORDER.map(severity => `${text(field(counts, severity))} ${severity}`).join(' · ')}; ${text(field(audit, 'toConfirm'))} to confirm${exploitedCount ? `; ${text(exploitedCount)} exploited in the wild` : ''}.`,
    `Read ${text(at(audit, 'files', 'read'))} of ${text(at(audit, 'files', 'eligible'))} files.`, '',
    '> From the kept record: each finding’s rule, place and package, never any of the code. Each rule’s explanation is the current engine’s wording.', ''];
  for (const note of keptNotes(audit)) lines.push(note, '');
  if (!open.length) lines.push('Nothing open in what was kept.', '');
  open.forEach((finding, index) => {
    lines.push(`## ${index + 1}. ${text(field(finding, 'title'))}`, '',
      `- **Severity:** ${text(field(finding, 'severity'))}`,
      `- **Verdict:** ${verdictOf(finding) === 'needs-validation' ? 'to confirm' : 'confirmed'}`,
      `- **Rule:** ${text(field(finding, 'rule'))}`,
      `- **Where:** \`${keptPlace(finding)}\``);
    const standards = field(finding, 'standards');
    if (standards) lines.push(`- **Standards:** ${standardsLine(standards)}`);
    const pkg = field(finding, 'package');
    if (pkg) {
      const fixed = text(field(pkg, 'fixed'));
      const advisories = items(field(pkg, 'advisories'));
      if (fixed) lines.push(`- **Fixed in:** ${fixed}`);
      if (advisories.length) lines.push(`- **Advisories:** ${advisories.map(text).join(', ')}`);
    }
    const risk = field(finding, 'risk');
    const band = entry(RISK_BAND, field(risk, 'band'));
    if (risk && band) lines.push(`- **Risk:** ${text(field(risk, 'score'))}/100, ${band.word.toLowerCase()}`);
    if (field(finding, 'exploited')) lines.push(`- **Exploited in the wild:** yes${field(finding, 'ransomware') ? ', used in ransomware campaigns' : ''}`);
    const epss = finite(field(finding, 'epss'));
    if (epss !== null) lines.push(`- **EPSS:** ${percent(epss)}`);
    const firstSeen = text(field(finding, 'firstSeenAt'));
    if (firstSeen) lines.push(`- **First seen:** ${firstSeen.slice(0, 10)}`);
    lines.push('');
    const why = text(field(finding, 'why'));
    const fix = text(field(finding, 'fix'));
    const prompt = text(field(finding, 'prompt'));
    if (why) lines.push(why, '');
    if (fix) lines.push(`**Fix:** ${fix}`, '');
    if (prompt) lines.push('**Prompt for a coding assistant:**', '', '```text', prompt, '```', '');
  });
  if (waived.length) {
    lines.push('## Waived or triaged', '', 'Not scored. Kept for their clocks.', '', '| Rule | Finding | Where | How |', '| --- | --- | --- | --- |',
      ...waived.map(finding => `| ${text(field(finding, 'rule'))} | ${cell(field(finding, 'title'))} | \`${cell(keptPlace(finding))}\` | ${keptWaived(finding)} |`), '');
  }
  return `${lines.join('\n')}\n`;
}

/*
 * CSV, one finding a row. A cell that opens with =, +, -, @ or a control
 * character is prefixed with an apostrophe: a path or a title from a
 * repository is somebody else's text, and a spreadsheet must not run it as
 * a formula.
 */
function csvCell(value: unknown): string {
  let said = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(said)) said = `'${said}`;
  return /[",\r\n]/.test(said) ? `"${said.replace(/"/g, '""')}"` : said;
}
const csvText = (rows: readonly (readonly unknown[])[]): string => `${rows.map(cells => cells.map(csvCell).join(',')).join('\r\n')}\r\n`;

const KEPT_COLUMNS = Object.freeze(['Audit', 'Commit', 'Status', 'Severity', 'Verdict', 'Rule', 'Title', 'Family', 'CWE', 'CWE Top 25 (2025)', 'OWASP', 'Location', 'Line', 'Package', 'Version', 'Fixed in', 'Advisories', 'Risk', 'Known exploited', 'EPSS', 'Dependency reach', 'First seen', 'Fix']);
export function keptCsv(audit: unknown, findings: unknown): string {
  const rows: unknown[][] = [[...KEPT_COLUMNS]];
  const auditedAt = field(audit, 'auditedAt');
  const commitSha = field(audit, 'commitSha');
  for (const finding of items(findings)) {
    const standards = field(finding, 'standards') || {};
    const top25 = field(standards, 'top25');
    const pkg = field(finding, 'package');
    const risk = field(finding, 'risk');
    const epss = finite(field(finding, 'epss'));
    const firstSeen = field(finding, 'firstSeenAt');
    rows.push([auditedAt, commitSha, field(finding, 'waived') ? keptWaived(finding) : 'open', field(finding, 'severity'),
      verdictOf(finding) === 'needs-validation' ? 'to confirm' : 'confirmed', field(finding, 'rule'), field(finding, 'title'), field(finding, 'category') || '',
      field(standards, 'cwe') || '', top25 ? `#${text(field(top25, 'rank'))}` : '', field(standards, 'owasp') || '',
      field(finding, 'path') || (pkg ? '' : 'whole repository'), field(finding, 'line') || '', pkg ? field(pkg, 'name') : '', pkg ? field(pkg, 'version') : '', pkg ? field(pkg, 'fixed') || '' : '',
      pkg ? items(field(pkg, 'advisories')).map(text).join(' ') : '', risk ? `${text(field(risk, 'score'))} ${text(field(risk, 'band'))}`.trim() : '',
      pkg ? (field(finding, 'exploited') ? 'yes' : 'no') : '', epss !== null ? `${(epss * 100).toFixed(2)}%` : '',
      field(finding, 'reach') || '', firstSeen ? text(firstSeen).slice(0, 10) : '', field(finding, 'fix') || '']);
  }
  for (const note of keptNotes(audit)) {
    const row: unknown[] = Array<unknown>(KEPT_COLUMNS.length).fill('');
    row[0] = auditedAt;
    row[1] = commitSha;
    row[2] = 'note';
    row[6] = note;
    rows.push(row);
  }
  return csvText(rows);
}

export function keptSarif(audit: unknown, findings: unknown, meta: unknown = {}): string {
  const kept = items(findings);
  /* A kept finding keeps no reach to trace or detail to read; its words stand in where a rule's are missing. */
  const all = kept.map(finding => ({ ...(hasFields(finding) ? finding : {}), reach: null, detail: null, why: field(finding, 'why') || field(finding, 'title'), fix: field(finding, 'fix') || '' }));
  const rules = sarifRules(all);
  const index = ruleIndex(rules);
  const results = all.map((finding, position) => {
    const how = keptWaived(finding);
    const result = sarifResult(finding, index.get(field(finding, 'rule')), filePlace(finding),
      field(finding, 'waived') ? { reason: `${how.slice(0, 1).toUpperCase()}${how.slice(1)}.` } : null);
    const pkg = field(finding, 'package');
    const risk = field(finding, 'risk');
    const epss = finite(field(finding, 'epss'));
    const reach = field(kept[position], 'reach');
    Object.assign(result.properties, {
      ...(pkg ? { package: `${text(field(pkg, 'name'))}@${text(field(pkg, 'version'))}`, advisories: field(pkg, 'advisories'), ...(field(pkg, 'fixed') ? { fixedIn: field(pkg, 'fixed') } : {}), knownExploited: Boolean(field(finding, 'exploited')) } : {}),
      ...(risk ? { risk: field(risk, 'score'), riskBand: field(risk, 'band') } : {}),
      ...(epss !== null ? { epss } : {}),
      ...(reach ? { dependencyReach: reach } : {}),
      ...(field(finding, 'firstSeenAt') ? { firstSeen: field(finding, 'firstSeenAt') } : {})
    });
    return result;
  });
  const keptCount = field(audit, 'findings');
  const ref = field(audit, 'ref');
  const run = {
    tool: { driver: { name: 'Nebulaverse-X Uranus', informationUri: field(meta, 'informationUri') || INFORMATION_URI, semanticVersion: field(audit, 'engine'), rules } },
    automationDetails: { id: `nebulaverse-audit/${text(ref)}/${text(field(audit, 'id'))}` },
    ...(field(meta, 'repositoryUri') ? { versionControlProvenance: [{ repositoryUri: field(meta, 'repositoryUri'), revisionId: field(audit, 'commitSha'), branch: ref }] } : {}),
    originalUriBaseIds: { SRCROOT: { uri: 'file:///' } },
    invocations: [{ executionSuccessful: true, endTimeUtc: field(audit, 'auditedAt') }],
    results,
    properties: { kept: true, grade: field(audit, 'grade'), score: field(audit, 'score'), ...(field(audit, 'capReason') ? { capReason: field(audit, 'capReason') } : {}), engine: `Uranus ${text(field(audit, 'engine'))}`,
      findingsKept: keptCount ? field(keptCount, 'stored') : results.length, findingsTotal: keptCount ? field(keptCount, 'total') : results.length }
  };
  return sarifDocument([run]);
}

/* ---- CSV ------------------------------------------------------------------ */

const CSV_COLUMNS = Object.freeze(['Source', 'Status', 'Severity', 'Verdict', 'Rule', 'Title', 'Detail', 'Family', 'CWE', 'CWE Top 25 (2025)', 'OWASP', 'Location', 'Line', 'Reached through', 'Risk', 'Known exploited', 'EPSS', 'Dependency reach', 'How to confirm', 'Reason waived', 'Due by', 'Fix']);
export function csv(result: unknown, site: unknown, changes?: AuditChanges | null): string {
  const rows: unknown[][] = [[...CSV_COLUMNS]];
  const row = (source: unknown, status: string, finding: unknown, family: unknown): void => {
    const standards = field(finding, 'standards') || {};
    const top25 = field(standards, 'top25');
    const reach = field(finding, 'reach');
    const route = text(field(reach, 'route'));
    const risk = riskOf(finding);
    const intel = intelOf(finding);
    const listed = text(at(intel, 'kev', 'cve'));
    const epss = field(intel, 'epss');
    const usage = usageOf(finding);
    const suppression = field(finding, 'suppression');
    const clock = field(finding, 'clock');
    rows.push([source, status, field(finding, 'severity'), verdictOf(finding) === 'needs-validation' ? 'to confirm' : 'confirmed', field(finding, 'rule'), field(finding, 'title'), detailChip(finding) || '', family || '', field(standards, 'cwe') || '',
      top25 ? `#${text(field(top25, 'rank'))}` : '', field(standards, 'owasp') || '',
      field(finding, 'path') || field(finding, 'where') || 'whole repository', field(finding, 'line') || '',
      reach ? `${route ? `${verbs(field(reach, 'method'))} ${route}` : 'server action'} (${text(field(reach, 'auth'))})` : '',
      risk ? `${text(field(risk, 'score'))} ${text(field(risk, 'band'))}` : '',
      intel ? field(intel, 'exploited') ? (listed ? `yes (${listed})` : 'yes') : field(intel, 'catalog') === 'unknown' ? 'unknown' : 'no' : '',
      intel && epss ? `${(Number(field(epss, 'score')) * 100).toFixed(2)}% (${text(field(epss, 'cve'))})` : '',
      usage ? field(usage, 'tier') : '',
      verdictOf(finding) === 'needs-validation' ? field(finding, 'check') || '' : '',
      suppression ? field(suppression, 'triage') ? triageJustification(field(suppression, 'triage')) : field(suppression, 'reason') || '' : '',
      clock ? `${text(field(clock, 'dueAt')).slice(0, 10)}${field(clock, 'state') === 'overdue' ? ' (overdue)' : ''}` : '',
      field(finding, 'fix')]);
  };
  if (result) {
    const families = new Map(items(field(result, 'categories')).map(category => [field(category, 'id'), field(category, 'label')]));
    for (const finding of items(field(result, 'findings'))) row('repository', changes && changes.newIds.has(field(finding, 'id')) ? 'new' : 'open', finding, families.get(field(finding, 'category')));
    for (const finding of items(field(result, 'suppressed'))) {
      const decision = at(finding, 'suppression', 'triage');
      row('repository', decision ? (field(decision, 'disposition') === 'false-positive' ? 'false positive' : 'risk accepted') : 'waived', finding, families.get(field(finding, 'category')));
    }
  }
  if (site) {
    const origin = field(site, 'origin');
    for (const finding of items(field(site, 'findings'))) row(origin, 'open', finding, 'Deployed site');
    const coverage = siteAssessment(site);
    if (!coverage.complete) {
      const summary: unknown[] = Array<unknown>(CSV_COLUMNS.length).fill('');
      summary[0] = origin;
      summary[1] = `coverage-${coverage.state}`;
      summary[5] = 'Overall grade withheld';
      summary[6] = siteAssessmentLine(site);
      summary[7] = 'Coverage';
      rows.push(summary);
    }
  }
  return csvText(rows);
}

/* ---- Exposure ------------------------------------------------------------- */

/*
 * Exposure findings as CSV and SARIF. The rows arrive already made safe by
 * the caller: a rule, a displayable path (never the raw one, which can be
 * named with the credential), a line, a status. Nothing here could carry a
 * secret because nothing here is given one.
 */
const EXPOSURE_COLUMNS = Object.freeze(['Severity', 'Credential', 'Rule', 'Location', 'Line', 'Status', 'Where', 'Introduced in', 'Provider says', 'Fingerprint']);
export function exposureCsv(rows: unknown): string {
  return csvText([[...EXPOSURE_COLUMNS], ...items(rows).map(row => [field(row, 'severity'), field(row, 'label'), field(row, 'rule'), field(row, 'where'), field(row, 'line') || '', field(row, 'status'),
    [field(row, 'inTree') === false ? 'history only' : 'tree', field(row, 'archive') ? 'archive' : '', field(row, 'encoded') ? 'base64' : ''].filter(Boolean).join(' + '),
    field(row, 'commit') || '', field(row, 'verified') || '', field(row, 'fingerprint')])]);
}

export function exposureSarif(rows: unknown, meta: unknown = {}): string {
  const all = items(rows);
  const rules: unknown[] = [];
  const index = new Map<unknown, number>();
  for (const row of all) {
    const rule = field(row, 'rule');
    if (index.has(rule)) continue;
    index.set(rule, rules.length);
    const label = field(row, 'label');
    rules.push({
      id: rule,
      name: label,
      shortDescription: { text: `${text(label)} committed to the repository` },
      help: { text: 'Revoke the credential with its issuer, replace it, then remove it from the repository and its history.' },
      helpUri: 'https://cwe.mitre.org/data/definitions/798.html',
      defaultConfiguration: { level: entry(SARIF_LEVEL, field(row, 'severity')) ?? 'error' },
      properties: { tags: ['security', 'secret', 'external/cwe/cwe-798', 'owasp-a07-2025'], precision: 'high', 'security-severity': entry(SECURITY_SEVERITY, field(row, 'severity')) ?? '7.5' }
    });
  }
  const results = all.map(row => {
    const line = field(row, 'line');
    const acceptedBy = text(field(row, 'acceptedBy'));
    return {
      ruleId: field(row, 'rule'),
      ruleIndex: index.get(field(row, 'rule')),
      level: entry(SARIF_LEVEL, field(row, 'severity')) ?? 'error',
      message: { text: `${text(field(row, 'label'))} in ${text(field(row, 'where'))}${field(row, 'inTree') === false ? ', only in history' : ''}.` },
      locations: [{ physicalLocation: { artifactLocation: { uri: field(row, 'where'), uriBaseId: 'SRCROOT' }, ...(line ? { region: { startLine: line } } : {}) } }],
      partialFingerprints: { 'nebulaverseExposure/v1': field(row, 'fingerprint') },
      properties: { severity: field(row, 'severity'), status: field(row, 'status'), inTree: field(row, 'inTree') !== false, ...(field(row, 'commit') ? { introducedIn: field(row, 'commit') } : {}), ...(field(row, 'verified') ? { providerSays: field(row, 'verified') } : {}) },
      ...(field(row, 'status') === 'accepted-risk' ? { suppressions: [{ kind: 'external', justification: acceptedBy ? `Risk accepted by ${acceptedBy}` : 'Risk accepted' }] } : {})
    };
  });
  const ref = field(meta, 'ref');
  return sarifDocument([{
    tool: { driver: { name: 'Nebulaverse-X Exposure', informationUri: field(meta, 'informationUri') || INFORMATION_URI, rules } },
    automationDetails: { id: `nebulaverse-exposure/${text(ref || 'branch')}/` },
    ...(field(meta, 'repositoryUri') && field(meta, 'commitSha') ? { versionControlProvenance: [{ repositoryUri: field(meta, 'repositoryUri'), revisionId: field(meta, 'commitSha'), ...(ref ? { branch: ref } : {}) }] } : {}),
    originalUriBaseIds: { SRCROOT: { uri: 'file:///' } },
    results
  }]);
}
