/* An isolated compiler project for repository source already selected by the audit. */
import { posix } from 'node:path';
import ts from 'typescript';

export interface SemanticSource {
  readonly path: string;
  readonly text?: unknown;
}
interface SourceText {
  readonly path: string;
  readonly text: string;
}
export interface SemanticProject {
  readonly files: readonly ts.SourceFile[];
  readonly checker: ts.TypeChecker | null;
  readonly pathOf: (node: ts.Node) => string;
  readonly incomplete: boolean;
  readonly skippedFiles: number;
  readonly unresolvedImports: number;
  readonly nodes: number;
  readonly eligibleFiles: number;
  readonly rootFiles: number;
}

/* The audit worker has a 224 MiB heap and also runs the existing language readers.
 * Clamp work before activating the binder, including for direct in-process callers. */
const MAX_FILES = 192;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_FILE_BYTES = 128 * 1024;
const MAX_NODES = 140_000;
const MAX_FILE_NODES = 24_000;
const MAX_DEPTH = 256;
const MAX_INDEX_BYTES = 6 * 1024 * 1024;
const MAX_INDEX_FILES = 768;
const EXTENSIONS = [ts.Extension.Ts, ts.Extension.Tsx, ts.Extension.Js, ts.Extension.Jsx,
  ts.Extension.Mts, ts.Extension.Cts, ts.Extension.Mjs, ts.Extension.Cjs];
const SOURCE = /\.(?:[mc]?[jt]s|[jt]sx)$/;
const GENERATED = /(?:\.d\.[mc]?ts|\.min\.[mc]?js)$/;

/* The virtual filesystem has a single root and no parent, symlinks, config,
 * ambient libraries, installed packages, plugins or writable paths. */
function sourceKey(path: string): string | null {
  if (!path || path.startsWith('/') || path.includes('\\') || /[\u0000-\u001f]|^[a-z]:/i.test(path)) return null;
  const key = posix.normalize(path);
  if (key === '.' || key === '..' || key.startsWith('../')) return null;
  return key;
}

function localModule(name: string, from: string, sources: ReadonlyMap<string, SourceText>): ts.ResolvedModuleFull | undefined {
  if (!(name.startsWith('./') || name.startsWith('../') || name === '.' || name === '..')) return undefined;
  const key = sourceKey(posix.join(posix.dirname(from), name));
  if (!key) return undefined;
  // A literal JS file and a sibling TS source can be different implementations.
  // Prefer the literal implementation. Allow an emitted JS spelling to bind a
  // unique TS sibling when the literal file is absent.
  function find(file: string): ts.ResolvedModuleFull | undefined {
    const extension = EXTENSIONS.find(ext => file.endsWith(ext));
    if (extension && sources.has(file)) return { resolvedFileName: file, extension };
    return undefined;
  }
  const exact = find(key);
  if (exact) return exact;
  const ext = posix.extname(key);
  const emitted = ext === '.js' ? ['.ts', '.tsx'] : ext === '.jsx' ? ['.tsx'] :
    ext === '.mjs' ? ['.mts'] : ext === '.cjs' ? ['.cts'] : null;
  if (emitted) {
    const stem = key.slice(0, -ext.length);
    const matches = emitted.map(suffix => find(stem + suffix)).filter(entry => entry !== undefined);
    return matches.length === 1 ? matches[0] : undefined;
  }
  if (ext && EXTENSIONS.some(extension => extension === ext)) return undefined;
  for (const stem of [key, key + '/index']) {
    // The supplied tree alone cannot establish a bundler's extension order.
    const matches = EXTENSIONS.map(extension => find(stem + extension)).filter(entry => entry !== undefined);
    if (matches.length) return matches.length === 1 ? matches[0] : undefined;
  }
  return undefined;
}

function typeOnlyReference(literal: ts.StringLiteralLike): boolean {
  const parent = literal.parent;
  if (ts.isImportDeclaration(parent)) {
    const clause = parent.importClause;
    const names = clause?.namedBindings;
    return Boolean(clause?.isTypeOnly || (!clause?.name && names && ts.isNamedImports(names)
      && names.elements.length && names.elements.every(item => item.isTypeOnly)));
  }
  if (ts.isExportDeclaration(parent)) {
    const names = parent.exportClause;
    return parent.isTypeOnly || Boolean(names && ts.isNamedExports(names)
      && names.elements.length && names.elements.every(item => item.isTypeOnly));
  }
  if (ts.isExternalModuleReference(parent) && ts.isImportEqualsDeclaration(parent.parent)) return parent.parent.isTypeOnly;
  return ts.isLiteralTypeNode(parent) && ts.isImportTypeNode(parent.parent);
}

/* A sink may live in an exported helper whose caller supplies the value. Read
 * only import specifiers to find reverse edges; createProgram follows forward
 * edges from the admitted roots. Unindexed input is explicit coverage loss. */
function callerRoots(roots: string[], sources: ReadonlyMap<string, SourceText>, ordered: readonly string[],
  stop: () => boolean, skipped: Set<string>): string[] {
  const callers = new Map<string, Set<string>>();
  let indexBytes = 0, indexed = 0;
  for (const path of ordered) {
    if (stop()) break;
    const file = sources.get(path);
    if (!file) continue;
    const bytes = file.text.length > MAX_FILE_BYTES ? Infinity : Buffer.byteLength(file.text, 'utf8');
    if (indexed >= MAX_INDEX_FILES || bytes > MAX_FILE_BYTES || indexBytes + bytes > MAX_INDEX_BYTES) {
      skipped.add(path);
      continue;
    }
    indexed++;
    indexBytes += bytes;
    for (const ref of ts.preProcessFile(file.text, true, true).importedFiles) {
      const target = localModule(ref.fileName, path, sources)?.resolvedFileName;
      if (!target) continue;
      let from = callers.get(target);
      if (!from) { from = new Set(); callers.set(target, from); }
      from.add(path);
    }
  }
  const found = new Set(roots);
  const selected = [...roots];
  for (let i = 0; i < selected.length && !stop(); i++) {
    for (const path of callers.get(selected[i] ?? '') ?? []) {
      if (found.has(path)) continue;
      found.add(path);
      selected.push(path);
    }
  }
  return selected;
}

/* Inspect iteratively. A maliciously nested expression must not get into a
 * recursive downstream binder or walker solely because its byte size is small. */
function boundedSize(file: ts.SourceFile, remaining: number, stop: () => boolean): { nodes: number; fits: boolean } {
  const nodes: ts.Node[] = [file];
  const depths = [0];
  let size = 0;
  while (nodes.length) {
    const node = nodes.pop();
    const depth = depths.pop() ?? 0;
    if (!node) break;
    size++;
    if (depth > MAX_DEPTH || size > remaining || (size % 256 === 0 && stop())) return { nodes: size, fits: false };
    ts.forEachChild(node, child => { nodes.push(child); depths.push(depth + 1); });
  }
  return { nodes: size, fits: true };
}

const options: ts.CompilerOptions = {
  target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.Preserve, allowJs: true, checkJs: false, noLib: true, types: [], typeRoots: [],
  noEmit: true, skipLibCheck: true, allowImportingTsExtensions: true, moduleDetection: ts.ModuleDetectionKind.Force
};

export function buildSemanticProject(
  input: readonly SemanticSource[], stop: () => boolean, isRoot?: (file: SourceText) => boolean
): SemanticProject {
  const sources = new Map<string, SourceText>();
  const skipped = new Set<string>();
  const unresolved = new Set<string>();
  const parsed = new Map<string, ts.SourceFile>();
  const paths = new Map<ts.SourceFile, string>();
  let interrupted = false, totalBytes = 0, totalNodes = 0, attempts = 0, inspected = 0, seedCount = 0;
  const interruptedNow = (): boolean => (interrupted ||= stop());
  function result(checker: ts.TypeChecker | null): SemanticProject {
    return { files: checker ? [...parsed.values()] : [], checker,
      pathOf: node => paths.get(ts.isSourceFile(node) ? node : node.getSourceFile()) ?? '',
      incomplete: interrupted || skipped.size > 0 || unresolved.size > 0,
      skippedFiles: skipped.size, unresolvedImports: unresolved.size, nodes: totalNodes,
      eligibleFiles: sources.size, rootFiles: seedCount };
  }
  for (const file of input) {
    if (!SOURCE.test(file.path) || GENERATED.test(file.path)) continue;
    if (interruptedNow()) break;
    const key = sourceKey(file.path);
    if (!key || key !== file.path || typeof file.text !== 'string') {
      if (key) sources.delete(key);
      skipped.add(key ?? file.path); continue;
    }
    const old = sources.get(key);
    if (old && (old.text !== file.text || old.path !== file.path)) {
      sources.delete(key); skipped.add(key);
    } else if (!skipped.has(key)) sources.set(key, { path: file.path, text: file.text });
  }
  const ordered = [...sources.keys()].sort();
  const seeds = ordered.filter(key => {
    const file = sources.get(key);
    return file !== undefined && (!isRoot || isRoot(file));
  });
  seedCount = seeds.length;
  if (!seedCount || interrupted) return result(null);
  const roots = isRoot && seedCount < ordered.length ? callerRoots(seeds, sources, ordered, interruptedNow, skipped) : seeds;
  if (interrupted) return result(null);
  const keyOf = (name: string) => name.startsWith('/') ? name.slice(1) : name;
  const host: ts.CompilerHost = {
    getCurrentDirectory: () => '/', useCaseSensitiveFileNames: () => true,
    getCanonicalFileName: name => name, getDefaultLibFileName: () => '', getNewLine: () => '\n',
    getDirectories: () => [], readDirectory: () => [], directoryExists: () => false,
    fileExists: name => sources.has(keyOf(name)), readFile: name => sources.get(keyOf(name))?.text,
    writeFile: () => { throw new Error('The audit compiler accepts only in-memory reads'); },
    resolveTypeReferenceDirectiveReferences: refs => refs.map(() => ({ resolvedTypeReferenceDirective: undefined })),
    resolveModuleNameLiterals: (literals, from) => literals.map(literal => {
      const name = literal.text;
      const resolvedModule = localModule(name, keyOf(from), sources);
      if (!resolvedModule && /^(?:\.{1,2})(?:\/|$)/.test(name) && !typeOnlyReference(literal)) unresolved.add(from + '\0' + name);
      return { resolvedModule };
    }),
    getSourceFile(name, target) {
      const key = keyOf(name);
      const file = sources.get(key);
      if (!file || skipped.has(key)) return undefined;
      const cached = parsed.get(key);
      if (cached) return cached;
      const bytes = file.text.length > MAX_FILE_BYTES ? Infinity : Buffer.byteLength(file.text, 'utf8');
      if (attempts >= MAX_FILES || bytes > MAX_FILE_BYTES || totalBytes + bytes > MAX_BYTES || inspected >= MAX_NODES || interruptedNow()) {
        skipped.add(key); return undefined;
      }
      // Unsuccessful parses consume the same CPU and transient allocation budget.
      attempts++;
      totalBytes += bytes;
      try {
        const source = ts.createSourceFile(key, file.text, target, true);
        // The pinned compiler records parser recovery on the source before binding.
        if ('parseDiagnostics' in source && Array.isArray(source.parseDiagnostics) && source.parseDiagnostics.length) {
          skipped.add(key); return undefined;
        }
        const size = boundedSize(source, Math.min(MAX_FILE_NODES, MAX_NODES - inspected), interruptedNow);
        inspected += size.nodes;
        if (!size.fits) { skipped.add(key); return undefined; }
        totalNodes += size.nodes;
        parsed.set(key, source);
        paths.set(source, file.path);
        return source;
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        skipped.add(key); return undefined;
      }
    }
  };
  try {
    const program = ts.createProgram(roots, options, host);
    if (!parsed.size || interruptedNow()) return result(null);
    const checker = program.getTypeChecker();
    return result(interruptedNow() ? null : checker);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    interrupted = true;
    return result(null);
  }
}
