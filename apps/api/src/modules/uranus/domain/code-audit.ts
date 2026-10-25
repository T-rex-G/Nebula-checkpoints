/*
 * Uranus, the repository audit: what a code-level reviewer would flag in a
 * quickly built application, beyond the leaked credentials Exposure already
 * finds. Nebulaverse-X calls repositories galaxies; Uranus is the planet that
 * reads them -- the one that turns on its side to look at everything.
 *
 * Seven families, each a set of deterministic rules over files read through
 * the same guarded reader Exposure uses:
 *
 *   supply chain   code that fetches and runs something at install time, pipes
 *                  a remote script into a shell, decodes and executes a
 *                  payload, ships local credentials off the machine, or a
 *                  workflow that hands its secrets to a stranger's code;
 *   code           the mistakes that turn into incidents -- SQL, shells, eval,
 *                  templates and regular expressions built from input, HTML
 *                  sinks fed by the request or the URL, outbound requests and
 *                  file paths a caller chooses, records written as they
 *                  arrived, a model's reply executed, CORS, cookies, webhooks,
 *                  TLS, tokens, and the database rules (Supabase row level
 *                  security, Firebase security rules);
 *   access         the endpoints themselves: which change data without asking
 *                  who is calling, which fetch a record by the caller's id and
 *                  never check it is theirs, which administrative routes are
 *                  open, which server actions and edge functions trust anyone;
 *   secrets        credentials committed to the code, found by the same
 *                  detector set Exposure runs and never repeated;
 *   dependencies   packages the registry has never heard of, versions with a
 *                  published vulnerability or listed as malicious in OSV,
 *                  and names one keystroke from a popular package;
 *   infrastructure containers that run as root, pull files from URLs or
 *                  bake secrets in; Terraform that makes a bucket public,
 *                  opens an admin port to the internet or stores data
 *                  unencrypted; Kubernetes workloads that run privileged;
 *                  workflows that hand their token write access to everything;
 *   hygiene        a committed .env, a .gitignore that would let one in, no
 *                  lockfile or two of them, open-ended versions, an unpinned
 *                  base image, TypeScript's strict mode off, security to-dos,
 *                  no README, no tests.
 *
 * Uranus follows values, not only lines. uranus-flow.ts traces what a
 * caller sends -- request bodies, query strings, route parameters, server
 * action arguments, the page's URL, a language model's reply -- through
 * variables, helpers and imports to the call that misuses it, and
 * uranus-surface.ts maps every endpoint and what guards it. A finding
 * that was traced carries its trace: the lines the value entered, travelled
 * and was used on, never their text.
 *
 * Every finding says how sure it is, as the audits of Cloudflare's harness
 * do: confirmed, when the file states the fact or the whole path was
 * traced; to confirm, when the pattern is there but a decisive fact is not
 * visible -- a guard that might live elsewhere, a value whose origin was not
 * followed. A finding to confirm names what is unknown and the one check that
 * settles it, weighs half in the score, and never caps the grade.
 *
 * What it will not do is repeat what it read. A finding names a rule, a path
 * and a line -- never the line itself -- so the audit carries no source text
 * to the browser, to a log or to anywhere it could be kept. Every finding
 * carries the fix in words and a prompt a reader can paste into an assistant,
 * both written from the rule, not from the code.
 *
 * And it says how much it read. A clean audit of a third of a repository is
 * not a clean repository, so coverage is part of the result -- files read,
 * and which classes of attack were traced, only pattern-checked, or not
 * assessed at all -- and the grade is never better than the evidence under
 * it: a confirmed critical finding caps it.
 */

import type { AuditPolicy } from '../../kepler/index.ts';
import * as ecosystems from './ecosystems.ts';
import type { DeclaredPackage } from './ecosystems.ts';
import * as licences from './licences.ts';
import type { LicenceAnswer } from './licences.ts';
import { lexJs, lexPyTokens } from './uranus-lex.ts';
import { analyseFlows, type FlowReading, type Settled } from './uranus-flow.ts';
import { analyseSurface, reachOf } from './uranus-surface.ts';
import { exploitedInProduction } from './uranus-reach.ts';
import { CATEGORIES, CRITICAL_CAP, ENGINE, GRADES, RULE_CAP, SERIOUS_CAPS, SEVERITY_ORDER, SEVERITY_PENALTY, type CategoryId, type Grade, type Severity } from './audit-catalog.ts';
import {
  CF_EXT, EXCLUDED_DIR, FIREBASE_RULES, JS_EXT, LIMITS, LOCKFILES, PY_EXT, READ_LOCKS, SOURCE_EXT,
  baseName, dirName, extensionOf, isDockerfile, isFixturePath, isRequirements, isTestPath
} from './audit-files.ts';
import { fingerprint, lineOf, suppression, type Suppression } from './audit-text.ts';
import { LINE_RULES, WORKFLOW, codeOf, fileRules, lexical, type RuleFile } from './line-rules.ts';
import { clientFile, firebaseFindings, serviceRoleFindings, sqlEvents, sqlFindings, type SqlEvent } from './audit-database.ts';
import { secretFindings, type SecretPorts } from './audit-secrets.ts';
import { dockerfileFindings, manifestFindings, terraformFindings } from './audit-infrastructure.ts';
import { advisoryKey, dedupePackages, lookAlike, nameKey, packageJsonFindings, packageKey, readDependencies, requirementsPackages, type DependencyReading, type InventoryEntry } from './dependencies.ts';
import { advisoryFindings, assessDependencyRisk, type AdvisoryAnswer, type ExploitAnswer } from './advisories.ts';
import { SPLICE_RULES, assurance, boundToLiteral, describe, parsedAsNumber, splicedNames, type Finding, type RawItem } from './audit-findings.ts';
import { AI_USE, CONTROLS, controls, ledger, surfaceSummary } from './audit-ledger.ts';

/* ---- Types ------------------------------------------------------------------------ */

/*
 * What the audit stands on from other modules, handed in rather than reached
 * for: Exposure's detectors, and Kepler's reading of the repository's audit
 * policy. The module's wiring passes the real ones; a decision here never
 * depends on how they are fetched.
 */
export interface AuditPorts extends SecretPorts {
  readonly readAuditPolicy: (files: readonly AuditFile[]) => AuditPolicy;
}
/* A file as the audit holds it: a path, and its text when it was read. */
export interface AuditFile {
  readonly path: string;
  readonly text?: unknown;
}
/* What the per-file rules learn about the repository as a whole while they read it. */
interface ScanContext {
  readonly raw: RawItem[];
  readonly packages: DeclaredPackage[];
  usesEnvironment: boolean;
  rateLimited: boolean;
  authRoute: { readonly path: string; readonly line: number } | null;
  packageJsonWithDependencies: string | null;
}
/* A rules-only pass over files beyond the traced set: rules, places, packages and flags -- never text. */
export interface Scan {
  readonly raw: RawItem[];
  readonly packages: DeclaredPackage[];
  readonly usesEnvironment: boolean;
  readonly rateLimited: boolean;
  readonly authRoute: ScanContext['authRoute'];
  readonly packageJsonWithDependencies: string | null;
  readonly controls: Readonly<Record<string, string>>;
  readonly extensions: Readonly<Record<string, number>>;
  readonly aiUsed: boolean;
  readonly files: number;
  readonly database: SqlEvent[];
  readonly databasePaths: string[];
}
export type RegistryAnswer = 'exists' | 'missing' | 'unknown';
interface CategoryScore {
  readonly id: CategoryId;
  readonly label: string;
  readonly weight: number;
  readonly score: number;
  readonly counts: Record<Severity, number>;
  readonly toConfirm: Record<Severity, number>;
}
/*
 * What the grade and the fix-first list read of a finding. An audit's own
 * findings carry far more; a finding the page holds and sends back after a
 * decision carries this much, and is scored the same way.
 */
export interface ScoredFinding {
  readonly id: string;
  readonly rule: string;
  readonly category: string;
  readonly severity: Severity;
  readonly verdict?: string;
  readonly reach?: { readonly auth?: unknown } | null;
  readonly detail?: {
    readonly risk?: { readonly score: number } | null;
    readonly direct?: boolean;
    readonly intel?: unknown;
    readonly usage?: unknown;
  } | null;
}
export interface ScoreReading {
  readonly score: number;
  readonly grade: Grade | null;
  readonly capped: boolean;
  readonly capReason: 'critical' | 'exploited' | 'serious' | null;
  readonly categories: CategoryScore[];
}
/* One component of the bill of materials, and, once the audit has its answers, the advisories it had then. */
export interface Component {
  readonly ecosystem: string;
  readonly name: string;
  readonly version: string;
  readonly purl: string | null;
  direct: boolean;
  dev: boolean;
  readonly source: InventoryEntry['source'];
  license: string | readonly string[] | null;
  readonly path: string;
  lock?: string | null;
  dependsOn?: string[];
  advisories?: { readonly ids: string[]; readonly cves: string[]; readonly exploited: string[] };
}
export interface AnalyseInput {
  readonly files: readonly AuditFile[];
  readonly paths?: readonly string[] | null;
  readonly registry?: ReadonlyMap<string, RegistryAnswer>;
  readonly advisories?: ReadonlyMap<string, AdvisoryAnswer>;
  readonly licences?: ReadonlyMap<string, LicenceAnswer> | null;
  readonly intel?: ReadonlyMap<string, ExploitAnswer> | null;
  readonly trace?: { readonly skip?: 'memory' | 'time' | null; readonly deadline?: number; readonly heapCeiling?: number };
  readonly extra?: Partial<Scan> | null;
}

/* ---- The audit ----------------------------------------------------------------- */

/*
 * Names and operations distinguish different mistakes at the same location.
 * Comments, whitespace and literal values do not participate: moving code or
 * rotating a credential must not expose its value through a finding digest.
 * Only the digest crosses out of this analysis. Identical operations still
 * need an occurrence count, but unrelated findings never renumber them.
 */
function semanticLines(file: { readonly path: string; readonly text: string }): Map<number, string> {
  const byLine = new Map<number, string[]>();
  const tokens = extensionOf(file.path) === 'py' ? lexPyTokens(file.text) : lexJs(file.text);
  for (const token of tokens) {
    if (token.t === 'nl') continue;
    const material = ['id', 'kw', 'punc'].includes(token.t) ? `${token.t}:${token.v}` : `${token.t}:literal`;
    let materials = byLine.get(token.line);
    if (!materials) { materials = []; byLine.set(token.line, materials); }
    materials.push(material);
  }
  return new Map([...byLine].map(([line, material]) => [line, fingerprint('semantic-v1', '', material.join('\0'))]));
}

function findingSemantic(item: RawItem, lineIdentity: string | null | undefined): string {
  if (item.semantic) return item.semantic;
  const detail = item.detail || {};
  if (detail.package) return fingerprint('package', detail.ecosystem || '', `${detail.package}\0${detail.version || ''}`);
  return lineIdentity || 'repository';
}

export function gradeOf(score: unknown): Grade | null {
  if (typeof score !== 'number' || !Number.isFinite(score)) return null;
  return GRADES.find(([, min]) => score >= min)?.[0] ?? null;
}

export function score(findings: readonly ScoredFinding[]): ScoreReading {
  /* A finding to confirm weighs half: it is a lead, not a fact. Only a confirmed critical caps the grade. */
  const weight = (finding: ScoredFinding): number => (finding.verdict === 'needs-validation' ? 0.5 : 1);
  const categories = CATEGORIES.map((category): CategoryScore => {
    const inCategory = findings.filter(finding => finding.category === category.id);
    const byRule = new Map<string, { penalty: number; count: number; cap: number }>();
    for (const finding of inCategory) {
      const entry = byRule.get(finding.rule) || { penalty: 0, count: 0, cap: SEVERITY_PENALTY[finding.severity] * RULE_CAP };
      entry.cap = Math.max(entry.cap, SEVERITY_PENALTY[finding.severity] * RULE_CAP);
      entry.penalty = Math.min(entry.cap, entry.penalty + SEVERITY_PENALTY[finding.severity] * weight(finding));
      entry.count += 1;
      byRule.set(finding.rule, entry);
    }
    const penalty = [...byRule.values()].reduce((total, entry) => total + entry.penalty, 0);
    const counts = { critical: 0, serious: 0, warning: 0 };
    const toConfirm = { critical: 0, serious: 0, warning: 0 };
    for (const finding of inCategory) {
      counts[finding.severity] += 1;
      if (finding.verdict === 'needs-validation') toConfirm[finding.severity] += 1;
    }
    return { id: category.id, label: category.label, weight: category.weight, score: Math.max(0, Math.round(100 - penalty)), counts, toConfirm };
  });
  const mean = Math.round(categories.reduce((total, category) => total + category.score * category.weight, 0) /
    categories.reduce((total, category) => total + category.weight, 0));
  const critical = findings.some(finding => finding.severity === 'critical' && finding.verdict !== 'needs-validation');
  /* A vulnerability being exploited in the wild, in something that ships, holds the grade down like a confirmed critical. */
  const exploited = findings.some(exploitedInProduction);
  const held = critical || exploited;
  /* Only categories the grade weighs count: a licence is compliance, and never moves the grade. */
  const graded: ReadonlySet<string> = new Set(CATEGORIES.filter(category => category.weight > 0).map(category => category.id));
  const serious = findings.filter(finding => finding.severity === 'serious' && finding.verdict !== 'needs-validation' && graded.has(finding.category)).length;
  const seriousCap = SERIOUS_CAPS.find(([atLeast]) => serious >= atLeast)?.[1] ?? 100;
  const ceiling = held ? CRITICAL_CAP : seriousCap;
  const total = Math.min(mean, ceiling);
  const capped = mean > ceiling;
  const capReason = capped ? (held ? (critical ? 'critical' : 'exploited') : 'serious') : null;
  return { score: total, grade: gradeOf(total), capped, capReason, categories };
}

/*
 * Runs the rules over files that have already been read. Pure: the same files
 * and the same registry answers give the same result, which is what lets it be
 * tested without a provider.
 */
/*
 * `trace` bounds the part of the analysis that grows with the code: a
 * `deadline` and a `heapCeiling` past which no further file is traced, or
 * `skip` ('memory', 'time') to check every file against the rules without
 * tracing at all, the answer when a first attempt ran out of room. Either
 * way the coverage ledger says what was and was not followed.
 */
/*
 * Every rule that reads one file on its own, for one file: what the traced
 * analysis and the rules-only pass beyond it share, so a file checked in
 * either is checked the same way. What it learns about the repository as a
 * whole -- that it reads the environment, limits rates, has a sign-in route,
 * declares packages -- goes on the context.
 */
function scanContext(): ScanContext {
  return { raw: [], packages: [], usesEnvironment: false, rateLimited: false, authRoute: null, packageJsonWithDependencies: null };
}
function scanFile(file: RuleFile, context: ScanContext, ports: SecretPorts): void {
  secretFindings(file, ports).forEach(finding => context.raw.push({ ...finding, path: file.path }));
  if (FIREBASE_RULES.has(file.base)) firebaseFindings(file).forEach(finding => context.raw.push({ ...finding, path: file.path }));
  serviceRoleFindings(file).forEach(finding => context.raw.push({ ...finding, path: file.path }));
  if (/process\.env\.|import\.meta\.env\.|os\.environ|os\.getenv|getenv\s*\(|dotenv/.test(file.text) || /^\.env\.(example|sample|template)$/.test(file.base)) context.usesEnvironment = true;
  if (/(rateLimit|rate-limit|ratelimit|RateLimiter|slowDown|express-slow-down|@upstash\/ratelimit|flask_limiter|Limiter\s*\(|throttle)/i.test(file.text)) context.rateLimited = true;
  if (!context.authRoute && (JS_EXT.has(file.ext) || PY_EXT.has(file.ext)) && !isTestPath(file.path)) {
    const auth = /(\.(post|put)\s*\(\s*['"`][^'"`\n]*(login|log-in|signin|sign-in|signup|sign-up|register|reset-password|forgot|otp|verify-code|magic-link)|@(app|router|bp)\.(post|route)\s*\(\s*['"][^'"\n]*(login|signin|signup|register|reset|otp))/i.exec(file.text);
    const nextAuth = /(^|\/)(pages\/api|app\/api)\/[^ ]*(login|signin|signup|register|reset|otp)/i.test(file.path) && /export\s+(async\s+)?(function\s+POST|default|const\s+POST)/.test(file.text);
    if (auth) context.authRoute = { path: file.path, line: lineOf(file.text, auth.index) };
    else if (nextAuth) context.authRoute = { path: file.path, line: 1 };
  }

  if (file.base === 'package.json' && !isFixturePath(file.path)) {
    const manifest = packageJsonFindings(file);
    manifest.out.forEach(finding => context.raw.push({ ...finding, path: file.path }));
    context.packages.push(...manifest.packages);
    if (manifest.hasDependencies && !context.packageJsonWithDependencies) context.packageJsonWithDependencies = file.path;
  }
  if (isRequirements(file.base) && !isFixturePath(file.path)) context.packages.push(...requirementsPackages(file));
  if (isDockerfile(file.path)) context.raw.push(...dockerfileFindings(file).map(finding => ({ ...finding, path: file.path })));
  if (file.ext === 'tf') context.raw.push(...terraformFindings(file).map(finding => ({ ...finding, path: file.path })));
  if ((file.ext === 'yml' || file.ext === 'yaml') && !WORKFLOW.test(file.path)) context.raw.push(...manifestFindings(file).map(finding => ({ ...finding, path: file.path })));
  if (isDockerfile(file.path)) {
    const stages = new Set<string>();
    file.text.split('\n').forEach((line, index) => {
      const from = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
      if (!from) return;
      const image = from[1] ?? '';
      if (from[2]) stages.add(from[2].toLowerCase());
      if (image === 'scratch' || image.startsWith('$') || stages.has(image.toLowerCase())) return;
      if (image.includes('@sha256:')) return;
      const tag = image.includes(':') ? image.slice(image.lastIndexOf(':') + 1) : '';
      if (!tag || tag === 'latest' || image.lastIndexOf(':') < image.lastIndexOf('/')) context.raw.push({ rule: 'HYG-006', path: file.path, line: index + 1 });
    });
  }
  if (file.base === 'tsconfig.json' && !dirName(file.path).split('/').some(part => part === 'node_modules')) {
    const strict = /"strict"\s*:\s*(true|false)/.exec(file.text);
    if (!strict || strict[1] === 'false') {
      if (!/"extends"\s*:/.test(file.text) || (strict && strict[1] === 'false')) context.raw.push({ rule: 'HYG-007', path: file.path, line: strict ? lineOf(file.text, strict.index) : 1 });
    }
  }

  const rules = LINE_RULES.filter(definition => definition.applies(file));
  if (rules.length) {
    /* Each line is bounded and classed once, then every rule that applies reads it. */
    for (const [index, line] of file.text.split('\n').entries()) {
      const bounded = line.length > LIMITS.maxLineScan ? line.slice(0, LIMITS.maxLineScan) : line;
      /* A comment that only mentions the pattern is not the pattern, whether it has the line or follows the code. */
      const comment = /^\s*(\/\/|#|\/?\*|<!--)/.test(bounded);
      const code = comment ? '' : lexical(file) ? codeOf(bounded, PY_EXT.has(file.ext)) : bounded;
      for (const definition of rules) {
        if (definition.rule === 'SEC-006') {
          if (definition.test(bounded, file)) context.raw.push({ rule: definition.rule, path: file.path, line: index + 1 });
        } else if (code && definition.test(code, file)) {
          context.raw.push({ rule: definition.rule, path: file.path, line: index + 1 });
        }
      }
    }
  }
  fileRules(file).forEach(finding => context.raw.push({ ...finding, path: file.path }));
}

/*
 * The rules alone, for files beyond what the traced analysis reads: every
 * per-file rule, the waivers written beside what they find (read here, while
 * the text is at hand), and what the repository-wide rules and the ledger need
 * to know. What leaves is rules, places, packages and flags -- never text --
 * so a batch can be read, checked and dropped before the next is read.
 */
export function scanRules(files: readonly AuditFile[] | null | undefined, ports: SecretPorts): Scan {
  const context = scanContext();
  const controlsFound: Record<string, string> = {};
  const extensions: Record<string, number> = {};
  let read = 0;
  let aiUsed = false;
  const database: SqlEvent[] = [];
  const databasePaths: string[] = [];
  for (const source of Array.isArray(files) ? files : []) {
    const text = source.text;
    const ext = extensionOf(source.path);
    const base = baseName(source.path);
    if (typeof text !== 'string' || READ_LOCKS.has(base)) continue;
    const file: RuleFile = { ...source, text, ext, base };
    read += 1;
    const before = context.raw.length;
    scanFile(file, context, ports);
    const identities = context.raw.length > before ? semanticLines(file) : new Map();
    let lines: string[] | null = null;
    for (const item of context.raw.slice(before)) {
      item.semantic = findingSemantic(item, item.line === null || item.line === undefined ? undefined : identities.get(item.line));
      if (!item.path || !item.line) { item.suppression = null; continue; }
      if (!lines) lines = file.text.split('\n');
      item.suppression = suppression(lines, item.line, item.rule);
    }
    const test = isTestPath(file.path);
    if (!test && (file.ext === 'sql' || FIREBASE_RULES.has(file.base))) databasePaths.push(file.path);
    if (file.ext === 'sql') database.push(...sqlEvents([file]));
    if (!test && SOURCE_EXT.has(file.ext)) extensions[file.ext] = (extensions[file.ext] || 0) + 1;
    if (!aiUsed && AI_USE.test(file.text)) aiUsed = true;
    if (!test) for (const [id, , pattern] of CONTROLS) if (!controlsFound[id] && pattern.test(file.text)) controlsFound[id] = file.path;
  }
  return {
    raw: context.raw, packages: context.packages, usesEnvironment: context.usesEnvironment, rateLimited: context.rateLimited,
    authRoute: context.authRoute, packageJsonWithDependencies: context.packageJsonWithDependencies,
    controls: controlsFound, extensions, aiUsed, files: read, database, databasePaths
  };
}
/* Two rules-only passes as one: the first place anything was seen wins, counts add. */
export function mergeScans(a: Scan | null | undefined, b: Scan | null | undefined): Scan | null {
  if (!a) return b ?? null;
  if (!b) return a;
  const extensions = { ...a.extensions };
  for (const [ext, count] of Object.entries(b.extensions || {})) extensions[ext] = (extensions[ext] || 0) + count;
  return {
    raw: [...a.raw, ...b.raw], packages: [...a.packages, ...b.packages],
    usesEnvironment: a.usesEnvironment || b.usesEnvironment, rateLimited: a.rateLimited || b.rateLimited,
    authRoute: a.authRoute || b.authRoute, packageJsonWithDependencies: a.packageJsonWithDependencies || b.packageJsonWithDependencies,
    controls: { ...b.controls, ...a.controls }, extensions, aiUsed: a.aiUsed || b.aiUsed, files: (a.files || 0) + (b.files || 0),
    database: [...(a.database || []), ...(b.database || [])], databasePaths: [...(a.databasePaths || []), ...(b.databasePaths || [])]
  };
}

export function analyse({ files, paths, registry = new Map(), advisories = new Map(), licences: licenceAnswers = null, intel = null, trace = {}, extra = null }: AnalyseInput, ports: AuditPorts) {
  const prepared: RuleFile[] = [];
  const allPaths: readonly string[] = Array.isArray(paths) ? paths : files.map(file => file.path);
  const pathSet = new Set(allPaths);
  /* Supabase serves the public schema over its API, so a table there without row level security is open. */
  const supabase = allPaths.some(filePath => /(^|\/)supabase\//.test(filePath)) ||
    files.some(file => (baseName(file.path) === 'package.json' || isRequirements(baseName(file.path))) && /supabase/i.test(String(file.text || '')));

  const context = scanContext();
  for (const source of files) {
    const text = source.text;
    if (typeof text !== 'string') continue;
    const file: RuleFile = { ...source, text, ext: extensionOf(source.path), base: baseName(source.path) };
    /* A lockfile is read for installed versions only, and a licence file for its licence; neither is code. */
    if (READ_LOCKS.has(file.base) || licences.isLicenceFile(file.path)) continue;
    prepared.push(file);
    scanFile(file, context, ports);
  }
  const { raw, packages } = context;
  /* What the rules-only pass beyond the traced files found, merged before identities are given. */
  const beyond = extra && typeof extra === 'object' ? extra : null;
  if (beyond) {
    raw.push(...(Array.isArray(beyond.raw) ? beyond.raw : []));
    packages.push(...(Array.isArray(beyond.packages) ? beyond.packages : []));
  }
  const usesEnvironment = context.usesEnvironment || Boolean(beyond && beyond.usesEnvironment);
  const rateLimited = context.rateLimited || Boolean(beyond && beyond.rateLimited);
  const authRoute = context.authRoute || (beyond && beyond.authRoute) || null;
  const packageJsonWithDependencies = context.packageJsonWithDependencies || (beyond && beyond.packageJsonWithDependencies) || null;

  /* Repository-level rules, from what is present rather than what is written. */
  for (const filePath of allPaths) {
    const base = baseName(filePath);
    if (/^\.env(\.(local|production|prod|development|dev|staging|stage|test))?$/.test(base) && !EXCLUDED_DIR.test(filePath)) {
      raw.push({ rule: 'HYG-001', path: filePath, line: null });
    }
  }
  const gitignore = files.find(file => file.path === '.gitignore');
  if (usesEnvironment && (!gitignore || !/^\s*(\/?\.env\b|\.env\*|\*\.env|\.env\.\*)/m.test(String(gitignore.text || '')))) {
    raw.push({ rule: 'HYG-002', path: gitignore ? '.gitignore' : null, line: null });
  }
  if (packageJsonWithDependencies) {
    const dir = dirName(packageJsonWithDependencies);
    const locks = LOCKFILES.filter(lock => pathSet.has(dir ? `${dir}/${lock}` : lock));
    if (!locks.length && !LOCKFILES.some(lock => pathSet.has(lock))) raw.push({ rule: 'HYG-003', path: packageJsonWithDependencies, line: null });
    if (locks.filter(lock => lock !== 'npm-shrinkwrap.json').length > 1) raw.push({ rule: 'HYG-004', path: packageJsonWithDependencies, line: null });
  }
  if (!allPaths.some(filePath => /^readme(\.[a-z]+)?$/i.test(filePath))) raw.push({ rule: 'HYG-008', path: null, line: null });
  const sourceCount = allPaths.filter(filePath => SOURCE_EXT.has(extensionOf(filePath)) && !EXCLUDED_DIR.test(filePath)).length;
  if (sourceCount >= 5 && !allPaths.some(filePath => isTestPath(filePath))) raw.push({ rule: 'HYG-009', path: null, line: null });
  if (authRoute && !rateLimited) raw.push({ rule: 'SEC-012', path: authRoute.path, line: authRoute.line });
  raw.push(...sqlFindings([...sqlEvents(prepared), ...((beyond && beyond.database) || [])], supabase));

  /* Declared names one keystroke from a popular package. */
  for (const entry of dedupePackages(packages)) {
    const resembles = lookAlike(entry.ecosystem, entry.name);
    if (resembles) raw.push({ rule: 'DEP-004', path: entry.path, line: entry.line, detail: { package: entry.name, resembles } });
  }

  /* Versions with published advisories, placed by how close they are to the running code and how exploited they are. */
  const dependencies = readDependencies(files);
  const vulnerabilities = advisoryFindings(dependencies.inventory, advisories);
  const dependencyRisk = vulnerabilities.out.length
    ? assessDependencyRisk(vulnerabilities.out, { files, allPaths, graphs: dependencies.graphs, intel: intel instanceof Map && intel.size ? intel : null })
    : null;
  raw.push(...vulnerabilities.out.map(item => item.finding));

  /*
   * What each package version may be used under, against the project's own
   * licence and the repository's policy. Asked only when the licences were
   * looked up: an analysis given none says nothing about licences.
   */
  let licenceSummary = null;
  if (licenceAnswers instanceof Map) {
    const judged = licences.licenceFindings(dependencies.inventory, licenceAnswers, { project: licences.projectLicence(files), policy: licences.readPolicy(files) });
    raw.push(...judged.out);
    licenceSummary = judged.summary;
  }

  /* Dependencies the public registry answered for. Unknown is not missing. */
  const dependencyStatus = { checked: 0, missing: 0, unknown: 0 };
  for (const entry of dedupePackages(packages)) {
    const answer = registry.get(packageKey(entry));
    if (!answer) continue;
    dependencyStatus.checked += 1;
    if (answer === 'unknown') { dependencyStatus.unknown += 1; continue; }
    if (answer !== 'missing') continue;
    dependencyStatus.missing += 1;
    raw.push({ rule: entry.name.startsWith('@') ? 'DEP-002' : 'DEP-001', path: entry.path, line: entry.line });
  }

  /*
   * Uranus: values followed from what a caller sends to what misuses them,
   * and every endpoint with what guards it. A traced flow at a line a rule
   * already flagged replaces the pattern with the trace; a flow no rule saw
   * is a finding of its own. Tests are not the application and are not read.
   */
  const flowInput = prepared.filter(file => !isTestPath(file.path) && (JS_EXT.has(file.ext) || PY_EXT.has(file.ext) || CF_EXT.has(file.ext)))
    .map(file => ({ path: file.path, text: file.text, client: clientFile(file) }));
  let flowResult: FlowReading = { flows: [], routes: [], settled: [], stats: { javascript: 0, python: 0, go: 0, java: 0, php: 0, functions: 0, routes: 0, flows: 0, helpers: 0, cut: 0 } };
  if (trace.skip) {
    flowResult.stats.cut = flowInput.length;
    flowResult.stats.limit = trace.skip;
  } else {
    try {
      flowResult = analyseFlows(flowInput, { deadline: trace.deadline, heapCeiling: trace.heapCeiling });
    } catch { flowResult.stats.failed = flowInput.length; }
  }
  const surface = analyseSurface({ routes: flowResult.routes, files: prepared });
  const traced = flowResult.flows.map((flow): RawItem => ({
    rule: flow.rule, path: flow.path, line: flow.line, severity: flow.severity, verdict: flow.verdict, trace: flow.trace,
    flowBlocker: flow.blocker, source: flow.source, reach: reachOf(flow, surface.surfaces), evidence: 'traced'
  }));
  const surfaced = surface.raw.map((item): RawItem => ({ ...item, flowBlocker: item.blocker, evidence: 'surface', severity: undefined }));
  raw.unshift(...traced, ...surfaced);

  /* One finding per rule and location, with an identity stable across runs. */
  const seen = new Map<string, boolean>();
  const findings: Finding[] = [];
  const suppressed: (Finding & { suppression: Suppression })[] = [];
  const linesByPath = new Map<string, string[] | null>();
  const linesOf = (filePath: string): string[] | null => {
    let lines = linesByPath.get(filePath);
    if (lines === undefined) {
      const source = files.find(file => file.path === filePath);
      lines = source && typeof source.text === 'string' ? source.text.split('\n') : null;
      linesByPath.set(filePath, lines);
    }
    return lines;
  };
  const identitiesByPath = new Map<string | null | undefined, Map<number, string>>();
  const identityAt = (item: RawItem): string | undefined => {
    let identities = identitiesByPath.get(item.path);
    if (!identities) {
      const source = files.find(file => file.path === item.path);
      const text = source ? source.text : undefined;
      identities = source && typeof text === 'string' ? semanticLines({ path: source.path, text }) : new Map<number, string>();
      identitiesByPath.set(item.path, identities);
    }
    return item.line === null || item.line === undefined ? undefined : identities.get(item.line);
  };
  /* Count only indistinguishable repetitions, including waived occurrences. */
  const ordinals = new Map<string, number>();
  /*
   * A pattern lead every spliced name of which a check has already settled
   * -- an allow-list, a number test, an anchored pattern -- is not a lead:
   * the trace saw the value arrive and saw it made safe before this line.
   */
  const settledByPath = new Map<string, Settled[]>();
  for (const entry of flowResult.settled || []) {
    let marks = settledByPath.get(entry.path);
    if (!marks) { marks = []; settledByPath.set(entry.path, marks); }
    marks.push(entry);
  }
  const settledLead = (item: RawItem): boolean => {
    const line = item.line;
    if (!SPLICE_RULES.has(item.rule) || item.evidence || !item.path || !line) return false;
    const marks = settledByPath.get(item.path);
    const lines = linesOf(item.path);
    const text = lines ? lines[line - 1] : null;
    if (!text) return false;
    const spliced = splicedNames(text);
    return spliced.length > 0 && spliced.every(name => (marks && marks.some(mark => mark.name === name && line >= mark.from && line <= mark.to)) ||
      parsedAsNumber(lines, line, name) || boundToLiteral(lines, name));
  };
  for (const item of raw) {
    const key = `${item.rule}\0${item.path || ''}\0${item.line || ''}`;
    if (seen.has(key)) continue;
    if (settledLead(item)) continue;
    seen.set(key, true);
    const semantic = findingSemantic(item, item.semantic ? null : identityAt(item));
    const place = `${item.rule}\0${item.path || ''}\0${semantic}`;
    const ordinal = ordinals.get(place) || 0;
    ordinals.set(place, ordinal + 1);
    const finding: Finding = { id: fingerprint(item.rule, item.path || '', `${semantic}\0${ordinal}`), ...describe(item.rule, item.path, item.line, item.severity, item.detail), ...assurance(item) };
    /* A rules-only item carries its waiver, read while its file's text was at hand. */
    const waiver = item.suppression !== undefined ? item.suppression
      : item.path && item.line ? suppression(linesOf(item.path), item.line, item.rule) : null;
    if (waiver) suppressed.push({ ...finding, suppression: waiver });
    else findings.push(finding);
  }
  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
    Number(a.verdict === 'needs-validation') - Number(b.verdict === 'needs-validation') ||
    String(a.path).localeCompare(String(b.path)) || (a.line || 0) - (b.line || 0));
  const engine = { ...ENGINE, traced: {
    javascript: flowResult.stats.javascript || 0, python: flowResult.stats.python || 0,
    go: flowResult.stats.go || 0, java: flowResult.stats.java || 0, php: flowResult.stats.php || 0, functions: flowResult.stats.functions || 0,
    endpoints: surface.counts.endpoints, actions: surface.counts.actions, flows: flowResult.flows.length,
    crossFile: flowResult.flows.filter(flow => flow.viaHelper === 'file').length, failed: flowResult.stats.failed || 0,
    deep: flowResult.stats.deep || 0, cut: flowResult.stats.cut || 0, limit: flowResult.stats.limit || null,
    /* Files beyond the traced set, checked against every per-file rule. */
    rulesOnly: beyond ? beyond.files || 0 : 0
  } };
  const bill = componentList(dependencies, licenceAnswers);
  return {
    findings, suppressed, dependencyStatus, advisoryStatus: vulnerabilities.status, manifestsSetAside: dependencies.setAside.length, dependencyRisk, priorities: priorities(findings), ...score(findings),
    licences: licenceSummary,
    policy: ports.readAuditPolicy(files),
    components: bill.components, componentsTruncated: bill.truncated,
    engine,
    surface: surfaceSummary(surface),
    ledger: ledger({ findings, prepared, allPaths, surface, flowResult, beyond, licences: licenceSummary }),
    controls: controls({ prepared, allPaths, findings, supabase, beyond })
  };
}

/*
 * The bill of materials: every package version the manifests and lockfiles
 * name, once each, with its package URL, what it depends on (by the same
 * URLs, where the lockfile records it), whether the project asked for it,
 * and the licence the lockfile states. Names, versions and licences only.
 */
const MAX_COMPONENTS = 5000;
function componentList({ inventory, graphs }: DependencyReading, licenceAnswers: ReadonlyMap<string, LicenceAnswer> | null = null): { components: Component[]; truncated: number } {
  const byKey = new Map<string, Component>();
  /* A licence deps.dev answered fills in what the lockfile did not state. */
  const answered = (entry: InventoryEntry): string | null => {
    const answer = licenceAnswers instanceof Map ? licenceAnswers.get(licences.versionKey(entry)) : null;
    return answer && typeof answer === 'object' && typeof answer.value === 'string' ? answer.value.slice(0, 120) : null;
  };
  for (const entry of inventory) {
    const key = advisoryKey(entry);
    const known = byKey.get(key);
    if (known) {
      known.direct = known.direct || entry.direct;
      known.dev = known.dev && entry.dev;
      if (!known.license) known.license = entry.license || answered(entry);
      continue;
    }
    byKey.set(key, {
      ecosystem: entry.ecosystem, name: entry.name, version: entry.version, purl: ecosystems.purl(entry.ecosystem, entry.name, entry.version),
      direct: Boolean(entry.direct), dev: Boolean(entry.dev), source: entry.source, license: entry.license || answered(entry), path: entry.path, lock: entry.lock || null
    });
  }
  /* Each requirement resolved to the version the same lockfile installed. */
  const versionIn = new Map<string, Component>();
  for (const component of byKey.values()) {
    if (!component.lock) continue;
    versionIn.set(`${component.lock}\0${nameKey(component.ecosystem, component.name)}`, component);
  }
  const components = [...byKey.values()].sort((a, b) => Number(b.direct) - Number(a.direct) || a.ecosystem.localeCompare(b.ecosystem) || a.name.localeCompare(b.name));
  for (const component of components) {
    const graph = component.lock ? graphs.get(component.lock) : undefined;
    const requires = graph && graph.requires.get(nameKey(component.ecosystem, component.name));
    component.dependsOn = requires
      ? [...requires].flatMap(name => { const target = versionIn.get(`${component.lock}\0${name}`); return target && target.purl ? [target.purl] : []; }).slice(0, 200)
      : [];
    delete component.lock;
  }
  return { components: components.slice(0, MAX_COMPONENTS), truncated: components.length > MAX_COMPONENTS ? components.length : 0 };
}

/*
 * What to fix first: the three findings that would most change the outcome,
 * no two from the same rule, so the list reads as three different jobs.
 * A confirmed critical, or a vulnerability CISA lists as exploited in a
 * package that ships, first; then severity; among equals, the families an
 * attacker reaches first -- a live credential or an open database before a
 * code pattern, a code pattern before a dependency, anything before hygiene
 * -- then the riskier dependency, and a direct one before one that came
 * with it.
 */
const REACH: ReadonlyMap<string, number> = new Map([['secrets', 0], ['access', 1], ['code', 1], ['supply-chain', 2], ['dependencies', 3], ['infrastructure', 3], ['hygiene', 4]]);
export function priorities(findings: readonly ScoredFinding[]): string[] {
  const openReach = (finding: ScoredFinding): number => (finding.reach && finding.reach.auth === 'open' ? 0 : 1);
  /* Being exploited now outranks being severe in theory: such a vulnerability stands with the confirmed criticals. */
  const urgent = (finding: ScoredFinding): number => ((finding.severity === 'critical' && finding.verdict !== 'needs-validation') || exploitedInProduction(finding) ? 0 : 1);
  const risk = (finding: ScoredFinding): number => (finding.detail && finding.detail.risk ? finding.detail.risk.score : -1);
  const ranked = [...findings].sort((a, b) => Number(a.verdict === 'needs-validation') - Number(b.verdict === 'needs-validation') ||
    urgent(a) - urgent(b) ||
    Number(exploitedInProduction(b)) - Number(exploitedInProduction(a)) ||
    SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
    openReach(a) - openReach(b) ||
    (REACH.get(a.category) ?? 5) - (REACH.get(b.category) ?? 5) ||
    risk(b) - risk(a) ||
    Number(Boolean(b.detail && b.detail.direct)) - Number(Boolean(a.detail && a.detail.direct)));
  const out: string[] = [];
  const rules = new Set<string>();
  for (const finding of ranked) {
    /* A licence is a decision for the owners, not a defect to fix first. */
    if (finding.category === 'licences') continue;
    if (rules.has(finding.rule)) continue;
    rules.add(finding.rule);
    out.push(finding.id);
    if (out.length === 3) break;
  }
  return out;
}
