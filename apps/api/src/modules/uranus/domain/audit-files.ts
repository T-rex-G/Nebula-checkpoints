import * as ecosystems from './ecosystems.ts';
import * as licences from './licences.ts';

/*
 * Uranus: which files an audit reads, and how it tells one kind from another
 * -- source, tests, fixtures, manifests, lockfiles, containers -- with the
 * budget that bounds how much it reads.
 */

/* How much one audit reads and asks; a caller may pass its own, and the overflow pass is optional. */
export interface AuditLimits {
  readonly maxFiles: number;
  readonly maxTotalBytes: number;
  readonly maxFileBytes: number;
  readonly maxLineScan: number;
  readonly maxPackages: number;
  readonly maxAdvisoryQueries: number;
  readonly advisoryBatch: number;
  readonly maxAdvisoryDetails: number;
  readonly readConcurrency: number;
  readonly lookupConcurrency: number;
  readonly maxOverflowFiles?: number;
  readonly maxOverflowBytes?: number;
  readonly queryBatchBytes: number;
  readonly scanBatchBytes: number;
  readonly queryConcurrency?: number;
}

export const LIMITS: AuditLimits = Object.freeze({
  maxFiles: 600,
  maxTotalBytes: 12 * 1024 * 1024,
  maxFileBytes: 512 * 1024,
  maxLineScan: 20000,
  maxPackages: 120,
  /* As many versions as the bill of materials holds: a batch of 250 is one small request. */
  maxAdvisoryQueries: 5000,
  advisoryBatch: 250,
  maxAdvisoryDetails: 160,
  readConcurrency: 8,
  lookupConcurrency: 6,
  /*
   * Beyond the traced set: files read in batches through the provider's query
   * API and checked against every per-file rule, a batch at a time, so what is
   * held at once stays near one batch whatever the size of the branch.
   */
  maxOverflowFiles: 6000,
  maxOverflowBytes: 64 * 1024 * 1024,
  queryBatchBytes: 3 * 1024 * 1024,
  scanBatchBytes: 6 * 1024 * 1024,
  queryConcurrency: 2
});

export const JS_EXT: ReadonlySet<string> = new Set(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'vue', 'svelte', 'astro']);
export const PY_EXT: ReadonlySet<string> = new Set(['py']);
/* Go, Java and PHP: traced by Uranus's own reader for the C family of languages. */
export const CF_EXT: ReadonlySet<string> = new Set(['go', 'java', 'php']);
/* The source files that can import each ecosystem's packages. */
export const ECOSYSTEM_LANGUAGES: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  npm: JS_EXT, pypi: PY_EXT, go: new Set(['go']), cargo: new Set(['rs']), rubygems: new Set(['rb']),
  packagist: new Set(['php']), maven: new Set(['java', 'kt']), nuget: new Set(['cs'])
});
export const SOURCE_EXT: ReadonlySet<string> = new Set([...JS_EXT, ...PY_EXT, 'rb', 'php', 'go', 'java', 'kt', 'cs', 'rs', 'html', 'htm']);
export const SCRIPT_EXT: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'ps1', 'yml', 'yaml', 'toml', 'json', 'cfg', 'ini', 'conf', 'env', 'txt', 'sql', 'rules', 'properties', 'tf', 'tfvars']);
export const EXCLUDED_DIR = /(^|\/)(node_modules|vendor|bower_components|dist|build|out|\.next|\.nuxt|\.svelte-kit|\.output|coverage|\.venv|venv|__pycache__|\.git|target|Pods)\//;
export const EXCLUDED_FILE = /(\.min\.(js|css)|\.map|\.bundle\.js|\.chunk\.js)$/i;
export const LOCKFILES: readonly string[] = Object.freeze(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock', 'npm-shrinkwrap.json']);
/* The lockfiles read for installed versions. The others are only noticed. */
export const OTHER_LOCKFILES: ReadonlySet<string> = new Set(['poetry.lock', 'Pipfile.lock', 'Cargo.lock', 'Gemfile.lock', 'gems.locked', 'composer.lock', 'packages.lock.json', 'gradle.lockfile', 'go.sum']);
export const READ_LOCKS: ReadonlySet<string> = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'poetry.lock', 'Pipfile.lock',
  ...Object.keys(ecosystems.LOCKS)]);
/* Manifests read for what a project declares, in every ecosystem the advisory lookup covers. */
export const MANIFESTS = /(^|\/)(package\.json|pyproject\.toml|Pipfile|setup\.py|pom\.xml|build\.gradle(\.kts)?|composer\.json|Gemfile|gems\.rb|Cargo\.toml|Directory\.Packages\.props|packages\.config|[^/]+\.(cs|fs|vb)proj)$/;
export const FIREBASE_RULES: ReadonlySet<string> = new Set(['firestore.rules', 'storage.rules', 'database.rules.json']);

export function extensionOf(filePath: string): string {
  const base = String(filePath).split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}
export function baseName(filePath: string): string {
  return String(filePath).split('/').pop() ?? '';
}
export function dirName(filePath: string): string {
  const index = String(filePath).lastIndexOf('/');
  return index < 0 ? '' : filePath.slice(0, index);
}
export function isDockerfile(filePath: string): boolean {
  return /^(Dockerfile|Containerfile)(\..+)?$|\.dockerfile$/i.test(baseName(filePath));
}
export function isTestPath(filePath: string): boolean {
  return /(^|\/)(tests?|__tests__|spec|specs|e2e|cypress|playwright)\//i.test(filePath) ||
    /\.(test|spec)\.[a-z]+$/i.test(filePath) || /(^|\/)test_[^/]+\.py$|_test\.(py|go)$/.test(filePath);
}
/*
 * A manifest or lockfile kept for the tests: a fixture project a test reads,
 * test data. It describes no install of the application, so its packages
 * are neither its inventory nor its advisories.
 */
export function isFixturePath(filePath: string): boolean {
  return isTestPath(filePath) || /(^|\/)(__fixtures__|fixtures?|testdata|test-data)\//i.test(filePath);
}

/*
 * Which files an audit reads, most telling first. Manifests and build files
 * decide what runs on install and in production; then application source.
 * The order matters only when a repository is larger than the budget, and
 * then it decides what the coverage statement has to admit it did not read.
 */
function auditPriority(filePath: string, policyPath: string | null): number | null {
  const base = baseName(filePath);
  if (MANIFESTS.test(filePath) || isRequirements(base) || base === '.gitignore' || base === 'tsconfig.json' || isDockerfile(filePath) || FIREBASE_RULES.has(base)) return 0;
  /* The project's own licence and its licence policy: what every dependency's licence is judged against. */
  if (licences.isLicenceFile(filePath) || licences.POLICY_PATHS.includes(filePath)) return 0;
  /* The repository's own clock for its findings. */
  if (policyPath !== null && filePath === policyPath) return 0;
  if (READ_LOCKS.has(base) || (extensionOf(filePath) === 'sql' && /(^|\/)(supabase|migrations?|db|database|sql|schema)\//i.test(filePath))) return 1;
  if (/^\.github\/workflows\//.test(filePath) || base === 'Makefile' || /\.(sh|ps1)$/.test(base) || /^\.env/.test(base) ||
    /^(next|vite|nuxt|svelte|astro)\.config\./.test(base) || base === 'vercel.json' || base === 'netlify.toml' ||
    base === 'settings.py' || base === 'docker-compose.yml' || base === 'docker-compose.yaml') return 1;
  const ext = extensionOf(filePath);
  if (SOURCE_EXT.has(ext)) return isTestPath(filePath) ? 3 : 2;
  if (SCRIPT_EXT.has(ext)) return 4;
  return null;
}

/* A file in the tree as the provider lists it: a path, and a size the selection trusts only when it is a whole number. */
export interface TreeEntry {
  readonly path: string;
  readonly size?: unknown;
}
export type SelectedEntry<E extends TreeEntry> = E & { readonly size: number; readonly priority: number };
export interface Selection<E extends TreeEntry> {
  readonly selected: SelectedEntry<E>[];
  readonly overflow: SelectedEntry<E>[];
  readonly eligible: number;
  readonly skipped: { excluded: number; oversize: number; budget: number };
}

/* `policyPath` is the repository's own audit policy, which the audit reads first; the module's wiring names it. */
export function selectFiles<E extends TreeEntry>(entries: readonly E[], limits: AuditLimits = LIMITS, policyPath: string | null = null): Selection<E> {
  const candidates: SelectedEntry<E>[] = [];
  const skipped = { excluded: 0, oversize: 0, budget: 0 };
  for (const entry of entries) {
    if (EXCLUDED_DIR.test(`${entry.path}`) || EXCLUDED_FILE.test(entry.path)) { skipped.excluded += 1; continue; }
    if (LOCKFILES.includes(baseName(entry.path)) && !READ_LOCKS.has(baseName(entry.path))) continue;
    const priority = auditPriority(entry.path, policyPath);
    if (priority === null) continue;
    const size = entry.size;
    if (typeof size !== 'number' || !Number.isInteger(size) || size > limits.maxFileBytes) { skipped.oversize += 1; continue; }
    candidates.push({ ...entry, size, priority });
  }
  candidates.sort((a, b) => a.priority - b.priority || a.path.localeCompare(b.path));
  const selected: SelectedEntry<E>[] = [];
  const overflow: SelectedEntry<E>[] = [];
  let bytes = 0;
  let overflowBytes = 0;
  for (const candidate of candidates) {
    if (selected.length < limits.maxFiles && bytes + candidate.size <= limits.maxTotalBytes) {
      selected.push(candidate);
      bytes += candidate.size;
      continue;
    }
    /* Past the traced set: read for the rules alone, up to their own ceiling. */
    if (overflow.length < (limits.maxOverflowFiles || 0) && overflowBytes + candidate.size <= (limits.maxOverflowBytes || 0)) {
      overflow.push(candidate);
      overflowBytes += candidate.size;
      continue;
    }
    skipped.budget += 1;
  }
  return { selected, overflow, eligible: candidates.length + skipped.oversize, skipped };
}
export const isRequirements = (base: string): boolean => /^requirements([-_.][\w.-]+)?\.txt$/i.test(base);
