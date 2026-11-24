import * as licences from './licences.ts';
import type { SurfaceReading } from './uranus-surface.ts';
import type { FlowReading } from './uranus-flow.ts';
import type { Finding } from './audit-findings.ts';
import type { RuleFile } from './line-rules.ts';
import type { Scan } from './code-audit.ts';
import {
  CF_EXT, EXCLUDED_DIR, FIREBASE_RULES, JS_EXT, LOCKFILES, OTHER_LOCKFILES, PY_EXT, READ_LOCKS, SOURCE_EXT,
  baseName, extensionOf, isDockerfile, isFixturePath, isTestPath
} from './audit-files.ts';

/*
 * What an audit says beside its findings: the endpoints it mapped, how much
 * of each class of attack it could assess, and what the repository already
 * does right.
 */

export type LicenceSummary = ReturnType<typeof licences.licenceFindings>['summary'];
type LedgerNeed = 'code' | 'surface' | 'ai' | 'any' | 'manifest' | 'infra' | 'licences' | 'never';
interface LedgerClass {
  readonly id: string;
  readonly label: string;
  readonly rules: readonly string[];
  readonly needs: LedgerNeed;
}
export type LedgerStatus = 'covered' | 'partial' | 'patterns' | 'not-applicable' | 'not-assessed';
export interface LedgerLine {
  readonly id: string;
  readonly label: string;
  readonly status: LedgerStatus;
  readonly detail: string;
  readonly confirmed: number;
  readonly toConfirm: number;
}
export interface Control {
  readonly id: string;
  readonly label: string;
  readonly path: string | null;
}
/* What the ledger and the controls read of a rules-only pass beyond the traced files; any part of it may be missing. */
type Beyond = Partial<Scan> | null;

/* A language-model SDK in use: what makes the AI class of attack apply. */
export const AI_USE = /(['"](openai|@anthropic-ai\/sdk|ai|@ai-sdk\/\w+|langchain|@langchain\/\w+|@google\/generative-ai|groq-sdk|cohere-ai)['"]|\bimport\s+(openai|anthropic)\b|from\s+(openai|anthropic|langchain\w*)\s+import|google\.generativeai)/;
/* The endpoints, as the screen lists them: bounded, and with nothing but a method, a route and a place. */
export function surfaceSummary(surface: SurfaceReading) {
  return {
    counts: surface.counts,
    projectHasAuth: surface.projectHasAuth,
    globalGuards: surface.globalGuards.map(guard => ({ kind: guard.kind, path: guard.path })),
    endpoints: surface.surfaces.slice(0, 200).map(entry => ({
      method: entry.method, route: entry.route, path: entry.path, line: entry.line, framework: entry.framework,
      auth: entry.auth, mutation: entry.mutation, publicByDesign: entry.publicByDesign, admin: entry.admin, action: entry.action
    })),
    truncated: surface.surfaces.length > 200
  };
}

/*
 * The coverage ledger: each class of attack, and whether this audit traced
 * it, only matched its patterns, found nothing it applies to, or cannot
 * assess it at all. A class is not "clear" because nothing was reported; it
 * is clear because it was looked at, and the ledger says which.
 */
export const LEDGER: readonly LedgerClass[] = Object.freeze([
  { id: 'injection', label: 'Injection', rules: ['SEC-001', 'SEC-010', 'SEC-011', 'SEC-024', 'SEC-026', 'SEC-029', 'SEC-030', 'SEC-033', 'SEC-034', 'SUP-009'], needs: 'code' },
  { id: 'access', label: 'Access control', rules: ['ACC-001', 'ACC-002', 'ACC-003', 'ACC-004', 'ACC-005', 'SEC-014', 'SEC-015', 'SEC-016', 'SEC-017', 'SEC-018'], needs: 'surface' },
  { id: 'requests', label: 'URLs, files and redirects', rules: ['SEC-020', 'SEC-021', 'SEC-022'], needs: 'code' },
  { id: 'browser', label: 'Browser and markup', rules: ['SEC-002', 'SEC-003', 'SEC-004'], needs: 'code' },
  { id: 'objects', label: 'Records and objects', rules: ['SEC-027', 'SEC-028', 'SEC-007'], needs: 'code' },
  { id: 'ai', label: 'AI and model output', rules: ['AI-001', 'AI-002', 'AI-003'], needs: 'ai' },
  { id: 'secrets', label: 'Secrets and cryptography', rules: ['SCR-001', 'SEC-005', 'SEC-006', 'SEC-009', 'SEC-019', 'SEC-023', 'SEC-025'], needs: 'any' },
  { id: 'supply', label: 'Supply chain', rules: ['SUP-001', 'SUP-002', 'SUP-003', 'SUP-004', 'SUP-005', 'SUP-006', 'SUP-007', 'SUP-008', 'DEP-001', 'DEP-002', 'DEP-003', 'DEP-004', 'DEP-005', 'DEP-006'], needs: 'manifest' },
  { id: 'infrastructure', label: 'Infrastructure', rules: ['IAC-001', 'IAC-002', 'IAC-003', 'IAC-004', 'IAC-005', 'IAC-006', 'IAC-007', 'IAC-008', 'IAC-009', 'IAC-010'], needs: 'infra' },
  { id: 'configuration', label: 'Configuration', rules: ['SEC-008', 'SEC-012', 'SEC-013', 'SEC-031', 'SEC-032', 'HYG-001', 'HYG-002', 'HYG-003', 'HYG-004', 'HYG-005', 'HYG-006', 'HYG-007'], needs: 'any' },
  { id: 'licences', label: 'Licences', rules: Object.keys(licences.RULES), needs: 'licences' },
  { id: 'logic', label: 'Business logic', rules: [], needs: 'never' }
]);
const TRACED_LANGUAGES: ReadonlySet<string> = new Set([...JS_EXT, ...PY_EXT, ...CF_EXT]);
export interface LedgerInput {
  readonly findings: readonly Finding[];
  readonly prepared: readonly RuleFile[];
  readonly allPaths: readonly string[];
  readonly surface: SurfaceReading;
  readonly flowResult: FlowReading;
  readonly beyond?: Beyond;
  readonly licences?: LicenceSummary | null;
}
export function ledger({ findings, prepared, allPaths, surface, flowResult, beyond = null, licences: licenceSummary = null }: LedgerInput): LedgerLine[] {
  const sourceFiles = prepared.filter(file => SOURCE_EXT.has(file.ext) && !isTestPath(file.path));
  const traced = sourceFiles.filter(file => TRACED_LANGUAGES.has(file.ext) && !['vue', 'svelte', 'astro', 'html', 'htm'].includes(file.ext)).length;
  const extensionsBeyond = (beyond && beyond.extensions) || {};
  const beyondExtensions = Object.keys(extensionsBeyond);
  const untraced = [...new Set([...sourceFiles.map(file => file.ext), ...beyondExtensions].filter(ext => !TRACED_LANGUAGES.has(ext)))];
  const aiUsed = prepared.some(file => AI_USE.test(file.text || '')) || Boolean(beyond && beyond.aiUsed);
  /* Source files beyond the traced set that the tracer could have followed: read and ruled, not followed. */
  const rulesOnly = beyondExtensions.filter(ext => TRACED_LANGUAGES.has(ext)).reduce((sum, ext) => sum + (extensionsBeyond[ext] ?? 0), 0);
  const infra = allPaths.some(filePath => isDockerfile(filePath) || /\.tf$/.test(filePath) || /(^|\/)(k8s|kubernetes|helm|charts|manifests)\//.test(filePath) || /^\.github\/workflows\//.test(filePath));
  const manifest = allPaths.some(filePath => (/(^|\/)(package\.json|requirements[^/]*\.txt|pyproject\.toml|Pipfile|go\.mod|Gemfile|composer\.json)$/.test(filePath) && !isFixturePath(filePath)) || /^\.github\/workflows\//.test(filePath));
  const databasePaths = allPaths.filter(filePath => !isTestPath(filePath) && !EXCLUDED_DIR.test(filePath) && (extensionOf(filePath) === 'sql' || FIREBASE_RULES.has(baseName(filePath))));
  const databaseRead = new Set([...prepared.filter(file => file.ext === 'sql' || FIREBASE_RULES.has(file.base)).map(file => file.path), ...((beyond && beyond.databasePaths) || [])]);
  const databaseMissing = databasePaths.filter(filePath => !databaseRead.has(filePath)).length;
  const rulesDb = databasePaths.length > databaseMissing;
  const failed = flowResult.stats && flowResult.stats.failed;
  const deep = (flowResult.stats && flowResult.stats.deep) || 0;
  const cut = (flowResult.stats && flowResult.stats.cut) || 0;
  const limit = flowResult.stats && flowResult.stats.limit;
  const followed = (['javascript', 'python', 'go', 'java', 'php'] as const).reduce((sum, language) => sum + ((flowResult.stats && flowResult.stats[language]) || 0), 0);
  /* Why tracing stopped, in the words the ledger uses for it. */
  const stopped = limit === 'memory' ? 'needed more memory than this server gives one audit' : 'ran past the time this server gives one audit';
  return LEDGER.map(entry => {
    const under = findings.filter(finding => entry.rules.includes(finding.rule));
    const counts = { confirmed: under.filter(finding => finding.verdict !== 'needs-validation').length, toConfirm: under.filter(finding => finding.verdict === 'needs-validation').length };
    let status: LedgerStatus = 'covered';
    let detail: string;
    if (entry.needs === 'never') {
      status = 'not-assessed';
      detail = 'Rules cannot know what the product should allow. Prices, quotas, state machines and workflows need a person or an agent to read them.';
    } else if (entry.needs === 'code') {
      if (!traced && !untraced.length) { status = 'not-applicable'; detail = 'No application code was found to read.'; }
      else if (!traced) { status = 'patterns'; detail = `Only pattern-checked: values are traced in JavaScript, TypeScript, Python, Go, Java and PHP, and this code is ${untraced.join(', ')}.`; }
      else if (limit && !followed) { status = 'patterns'; detail = `Only pattern-checked: following values across ${traced} files ${stopped}, so every file was checked against the rules instead.`; }
      else if (untraced.length || failed || deep || cut || rulesOnly) {
        status = 'partial';
        const gaps = [];
        if (untraced.length) gaps.push(`${untraced.join(', ')} files were only pattern-checked`);
        if (failed) gaps.push(`${failed} files could not be followed`);
        if (deep) gaps.push(`${deep} ${deep === 1 ? 'file nests' : 'files nest'} expressions deeper than values are followed`);
        if (cut) gaps.push(`${cut} ${cut === 1 ? 'file was' : 'files were'} left to the rules when tracing ${stopped} (server code is traced first)`);
        if (rulesOnly) gaps.push(`${rulesOnly} more ${rulesOnly === 1 ? 'file' : 'files'} beyond the traced set ${rulesOnly === 1 ? 'was' : 'were'} checked against the rules`);
        detail = `Traced across ${cut ? followed : traced} files; ${gaps.join('; ')}.`;
      }
      else detail = `Values followed from what a caller sends to what uses them, across ${traced} files.`;
    } else if (entry.needs === 'surface') {
      const endpoints = surface.counts.endpoints + surface.counts.actions;
      if (limit && !followed) {
        status = 'patterns';
        detail = `Endpoints not mapped: tracing ${stopped}.${rulesDb ? ' The database rules were read.' : ''}`;
      } else if (!endpoints && !rulesDb && !cut) { status = 'not-applicable'; detail = 'No endpoints, server actions or database rules were found.'; }
      else {
        detail = `${endpoints} ${endpoints === 1 ? 'endpoint' : 'endpoints'} mapped (${surface.counts.guarded} guarded, ${surface.counts.open} open${surface.counts.unknown ? `, ${surface.counts.unknown} behind a guard to confirm` : ''})${rulesDb ? ', and the database rules read' : ''}.`;
        if (untraced.length) { status = 'partial'; detail += ` Endpoints in ${untraced.join(', ')} are not mapped.`; }
        if (cut) { status = 'partial'; detail += ` Endpoints in the ${cut} ${cut === 1 ? 'file' : 'files'} tracing did not reach are not mapped.`; }
        if (rulesOnly) { status = 'partial'; detail += ` Endpoints in the ${rulesOnly} ${rulesOnly === 1 ? 'file' : 'files'} beyond the traced set are not mapped.`; }
      }
      if (databaseMissing) {
        status = 'partial';
        detail = `${endpoints} endpoints mapped; ${databasePaths.length - databaseMissing} of ${databasePaths.length} database rule files checked. ${databaseMissing} could not be checked.`;
      }
    } else if (entry.needs === 'ai') {
      if (!aiUsed) { status = 'not-applicable'; detail = 'No language-model SDK is used.'; }
      else detail = 'Model replies followed to code, queries and markup; prompts checked for user text in the instructions.';
    } else if (entry.needs === 'infra') {
      if (!infra) { status = 'not-applicable'; detail = 'No containers, Terraform, Kubernetes or workflows were found.'; }
      else detail = 'Containers, Terraform, Kubernetes manifests and workflows read.';
    } else if (entry.needs === 'manifest') {
      if (!manifest) { status = 'not-applicable'; detail = 'No package manifest or workflow was found.'; }
      else detail = 'Manifests, lockfiles, install scripts and workflows read; versions checked against OSV.';
    } else if (entry.needs === 'licences') {
      const counted = licenceSummary && licenceSummary.status;
      if (!licenceSummary || !counted) { status = 'not-assessed'; detail = 'Licences were not looked up for this audit.'; }
      else if (!counted.versions) { status = 'not-applicable'; detail = 'No dependency with a version was found.'; }
      else {
        const against = licenceSummary.policy && !licenceSummary.policy.invalid ? `the policy in ${licenceSummary.policy.path}`
          : licenceSummary.project && licenceSummary.project.expression ? `the project's own ${licenceSummary.project.expression}` : 'use in proprietary code, as no project licence was found';
        const open = counted.unknown + counted.notAsked;
        detail = `${counted.known} of ${counted.versions} package ${counted.versions === 1 ? 'version' : 'versions'} read (${counted.fromLock} from lockfiles, ${counted.fromRegistry} from deps.dev) and judged against ${against}.`;
        if (open) { status = 'partial'; detail += ` ${open} could not be read${counted.notAsked ? `, ${counted.notAsked} of them past the lookup budget` : ''}.`; }
      }
    } else {
      detail = 'Every file read was checked.';
    }
    return { id: entry.id, label: entry.label, status, detail, ...counts };
  });
}

/*
 * What the repository already does right, found the same way the findings
 * are: a reviewer weighs a codebase by its defences as well as its gaps.
 * Each names the first file it was seen in.
 */
export const CONTROLS: readonly (readonly [string, string, RegExp])[] = Object.freeze([
  ['auth-library', 'An established authentication library', /(['"](next-auth|@auth\/[\w-]+|@clerk\/[\w-]+|@supabase\/ssr|@supabase\/auth-helpers-[\w-]+|passport|lucia|better-auth|@kinde-oss\/[\w-]+|@auth0\/[\w-]+|firebase\/auth|iron-session)['"]|flask_login|django\.contrib\.auth|fastapi_users|authlib)/],
  ['validation', 'Input validated by a schema', /from\s+['"](zod|yup|joi|valibot|superstruct|ajv|class-validator|@sinclair\/typebox|@hapi\/joi|arktype)['"]|require\(\s*['"](zod|joi|yup|ajv)['"]\s*\)|\bpydantic\b|\bmarshmallow\b/],
  ['orm', 'Queries through an ORM or placeholders', /(['"](@prisma\/client|drizzle-orm|sequelize|typeorm|@mikro-orm\/core|kysely|knex)['"]|\bsqlalchemy\b|django\.db|\bpeewee\b|tortoise)/],
  ['password-hash', 'Passwords hashed with a slow hash', /\b(bcrypt|bcryptjs|argon2|scrypt|passlib|generate_password_hash|make_password)\b/],
  ['rate-limit', 'Rate limiting', /(rateLimit|rate-limit|ratelimit|RateLimiter|slowDown|@upstash\/ratelimit|flask_limiter|slowapi|express-slow-down)/],
  ['csrf', 'CSRF protection', /\b(csurf|csrf-csrf|lusca|CSRFProtect|CsrfViewMiddleware|@edge-csrf|csrfToken|doubleCsrf)\b/],
  ['headers', 'Security headers set in code', /\bhelmet\s*\(|Content-Security-Policy|contentSecurityPolicy|Strict-Transport-Security|SECURE_HSTS_SECONDS|Talisman\(/],
  ['webhook-signature', 'Webhook signatures verified', /(constructEvent|verifySignature|verify_signature|webhooks?\.verify|timingSafeEqual|compare_digest)/]
]);
export interface ControlsInput {
  readonly prepared: readonly RuleFile[];
  readonly allPaths: readonly string[];
  readonly findings: readonly Finding[];
  readonly supabase: boolean;
  readonly beyond?: Beyond;
}
export function controls({ prepared, allPaths, findings, supabase, beyond = null }: ControlsInput): Control[] {
  const out: Control[] = [];
  const firstWith = (pattern: RegExp): RuleFile | undefined => prepared.find(file => !isTestPath(file.path) && !READ_LOCKS.has(file.base) && pattern.test(file.text || ''));
  const seenBeyond: Readonly<Record<string, string>> = (beyond && beyond.controls) || {};
  for (const [id, label, pattern] of CONTROLS) {
    const file = firstWith(pattern);
    if (file) out.push({ id, label, path: file.path });
    else {
      const seen = seenBeyond[id];
      if (typeof seen === 'string') out.push({ id, label, path: seen });
    }
  }
  const has = (rule: string): boolean => findings.some(finding => finding.rule === rule);
  const paths = new Set(allPaths);
  const dependabot = allPaths.find(filePath => /^\.github\/dependabot\.ya?ml$|^renovate\.json5?$|^\.renovaterc(\.json)?$|^\.github\/renovate\.json5?$/.test(filePath));
  if (dependabot) out.push({ id: 'updates', label: 'Dependency updates automated', path: dependabot });
  const policy = allPaths.find(filePath => /^(\.github\/)?SECURITY\.md$/i.test(filePath));
  if (policy) out.push({ id: 'policy', label: 'A security policy for reporters', path: policy });
  const secretScan = prepared.find(file => /^\.pre-commit-config\.ya?ml$|^\.gitleaks\.toml$|^\.github\/workflows\//.test(file.path) && /gitleaks|trufflehog|detect-secrets|ggshield/.test(file.text || ''));
  if (secretScan) out.push({ id: 'secret-scanning', label: 'Secrets scanned before they land', path: secretScan.path });
  const sast = prepared.find(file => /^\.github\/workflows\//.test(file.path) && /codeql-action|semgrep|snyk\/actions|sonarsource|bearer\/bearer-action/.test(file.text || ''));
  if (sast) out.push({ id: 'code-scanning', label: 'Code scanning in CI', path: sast.path });
  const workflows = allPaths.some(filePath => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(filePath));
  if (workflows && !has('SUP-008')) out.push({ id: 'pinned-actions', label: 'Third-party actions pinned to commits', path: null });
  const tables = prepared.some(file => file.ext === 'sql' && /create\s+table/i.test(file.text || ''));
  const databaseRead = new Set([...prepared.filter(file => file.ext === 'sql').map(file => file.path), ...((beyond && beyond.databasePaths) || [])]);
  const allSqlRead = allPaths.filter(filePath => extensionOf(filePath) === 'sql' && !isTestPath(filePath) && !EXCLUDED_DIR.test(filePath)).every(filePath => databaseRead.has(filePath));
  if (supabase && tables && allSqlRead && !has('SEC-014') && !has('SEC-015') && !has('SEC-016')) out.push({ id: 'rls', label: 'Row level security on every table', path: null });
  const manifest = allPaths.find(filePath => baseName(filePath) === 'package.json');
  const npmLocked = manifest && !has('HYG-003') && LOCKFILES.some(lock => paths.has(lock) || allPaths.some(filePath => baseName(filePath) === lock));
  /* The other ecosystems' lockfiles pin what installs just the same. */
  const otherLock = allPaths.find(filePath => OTHER_LOCKFILES.has(baseName(filePath)) && !EXCLUDED_DIR.test(filePath));
  if (npmLocked || otherLock) out.push({ id: 'lockfile', label: 'A committed lockfile', path: npmLocked ? null : otherLock ?? null });
  return out;
}
