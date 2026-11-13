import { fieldsOf, lookupTable, read } from '../../../platform/values/fields.ts';
import * as ecosystems from './ecosystems.ts';
import type { DeclaredPackage, LockRoot, ManifestFile } from './ecosystems.ts';
import * as POPULAR from './popular-packages.ts';
import { keyLine, parseJson } from './audit-text.ts';
import { baseName, dirName, isFixturePath, isRequirements } from './audit-files.ts';
import type { RuleHit } from './line-rules.ts';

/*
 * What a repository depends on: the packages its manifests declare, the
 * versions its lockfiles installed and what required what, how versions and
 * ranges compare, and the names one keystroke from a popular package.
 */

/* ---- Types ------------------------------------------------------------------------ */

/* What one lockfile says was installed, and what that requires by name. */
export interface Installed {
  name: string;
  version: string;
  line: number;
  dev: boolean;
  top: boolean;
  requires: string[];
  location?: string;
  license?: string | readonly string[] | null;
  namespaces?: string[];
}
export interface LockParse {
  readonly entries: Installed[];
  readonly roots: LockRoot[] | null;
  readonly workspaces?: string[];
  readonly flat?: boolean;
}
type LockParser = (text: string) => LockParse;
/* One package version worth asking about, and where a reader would change it. */
export interface InventoryEntry {
  readonly ecosystem: string;
  readonly name: string;
  readonly path: string;
  readonly line: number;
  readonly direct: boolean;
  readonly dev: boolean;
  readonly version: string;
  readonly source: 'lock' | 'pin' | 'range';
  readonly lock?: string;
  readonly license?: string | readonly string[] | null;
  readonly range?: string;
}
/* A lockfile's requirement graph: which package requires which, by name, and which the project asked for. */
export interface LockGraph {
  readonly ecosystem: string;
  readonly requires: Map<string, Set<string>>;
  readonly names: Map<string, string>;
  readonly roots: Map<string, LockRoot>;
  readonly namespaces: Map<string, string[]>;
  readonly linked: boolean;
  parents?: Map<string, string[]>;
}
export interface DependencyReading {
  readonly inventory: InventoryEntry[];
  readonly graphs: Map<string, LockGraph>;
  readonly setAside: string[];
}
interface ManifestRecord {
  readonly dir: string;
  readonly ecosystem: string;
  readonly packages: DeclaredPackage[];
}
interface LockRecord {
  readonly dir: string;
  readonly ecosystem: string;
  readonly path: string;
  readonly entries: Installed[];
  readonly roots: LockRoot[] | null;
  readonly workspaces: string[] | null;
  readonly flat: boolean;
  readonly declared: LockRoot[];
  readonly index: Map<string, Installed>;
  locations: Map<string, Installed>;
}
export interface PackageJsonReading {
  readonly out: RuleHit[];
  readonly packages: DeclaredPackage[];
  readonly hasDependencies?: boolean;
}
/* A requirements file: its base name says whether only development needs it. */
export interface RequirementsFile extends ManifestFile {
  readonly base: string;
}

/* ---- Manifests --------------------------------------------------------------- */

export function packageJsonFindings(file: ManifestFile): PackageJsonReading {
  const out: RuleHit[] = [];
  const manifest = parseJson(file.text);
  if (!manifest || typeof manifest !== 'object') return { out, packages: [] };
  const declaredScripts = read(manifest, 'scripts');
  const scripts = declaredScripts && typeof declaredScripts === 'object' ? fieldsOf(declaredScripts) : {};
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'preuninstall', 'postuninstall']) {
    const script = String(scripts[hook] || '');
    if (/\b(curl|wget|Invoke-WebRequest|iwr|node\s+-e|node\s+--eval|eval|base64\s+(-d|--decode)|bash\s+-c|sh\s+-c|powershell|python\s+-c)\b/i.test(script)) {
      out.push({ rule: 'SUP-001', line: keyLine(file.text, hook) });
    }
  }
  const packages: DeclaredPackage[] = [];
  const open: string[] = [];
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const declared = read(manifest, section);
    const deps = declared && typeof declared === 'object' ? fieldsOf(declared) : {};
    for (const [name, rawVersion] of Object.entries(deps)) {
      const version = String(rawVersion || '').trim();
      if (/^(git\+|git:|github:|gitlab:|bitbucket:|https?:)/.test(version) || /^[\w.-]+\/[\w.-]+(#.*)?$/.test(version)) {
        out.push({ rule: 'SUP-006', line: keyLine(file.text, name) });
        continue;
      }
      if (/^(file:|link:|workspace:|portal:|npm:)/.test(version)) continue;
      if (section !== 'peerDependencies' && (version === '*' || version === '' || /^(latest|x|next)$/i.test(version) || /^>=?\s*[\d.]+$/.test(version))) {
        open.push(name);
      }
      if (/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(name)) {
        packages.push({ ecosystem: 'npm', name, path: file.path, line: keyLine(file.text, name), spec: version, dev: section === 'devDependencies' });
      }
    }
  }
  const first = open[0];
  if (first !== undefined) out.push({ rule: 'HYG-005', line: keyLine(file.text, first) });
  return { out, packages, hasDependencies: packages.length > 0 };
}

export function requirementsPackages(file: RequirementsFile): DeclaredPackage[] {
  const packages: DeclaredPackage[] = [];
  file.text.split('\n').forEach((raw, index) => {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line || line.startsWith('-') || /^(git\+|https?:|\.|\/)/.test(line) || line.includes('@ ')) return;
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*([^;]*)/.exec(line);
    if (match) packages.push({ ecosystem: 'pypi', name: match[1] ?? '', path: file.path, line: index + 1, spec: (match[3] ?? '').trim(), dev: /dev|test/i.test(file.base) });
  });
  return packages;
}

/* ---- Installed versions --------------------------------------------------------- */

/*
 * What the lockfiles say is installed: name, version, the line it is on, and
 * whether only development tooling needs it. Each parser reads the format's
 * stable shape and skips what it does not recognise -- an unparsed entry is
 * a package not checked, which coverage reports, never a guess.
 */
/*
 * Each lockfile parser answers with the versions it installed and, where the
 * format records them, what each package requires by name and which packages
 * the project itself asked for (`roots`). The requirements are what let a
 * transitive vulnerability be traced to the dependency that brought it in.
 */
const requiredNames = (...maps: unknown[]): string[] => [...new Set(maps.flatMap(map => (map && typeof map === 'object' ? Object.keys(map) : [])))];

function packageLockEntries(text: string): LockParse {
  const lock = parseJson(text);
  if (!lock || typeof lock !== 'object') return { entries: [], roots: null };
  const lines = new Map<string, number>();
  text.split('\n').forEach((line, index) => {
    const key = /^\s*"((?:node_modules\/)[^"]+)"\s*:\s*\{/.exec(line)?.[1];
    if (key !== undefined && !lines.has(key)) lines.set(key, index + 1);
  });
  const out: Installed[] = [];
  const packages = read(lock, 'packages');
  if (packages && typeof packages === 'object') {
    const workspaces: string[] = [];
    for (const entry of Object.values(fieldsOf(packages))) {
      const resolved = read(entry, 'resolved');
      if (read(entry, 'link') !== true || typeof resolved !== 'string') continue;
      const dir = resolved.replace(/^\.\//, '');
      if (dir && !dir.startsWith('/') && !dir.split('/').includes('..')) workspaces.push(dir);
    }
    const root = read(packages, '');
    const roots = root && typeof root === 'object'
      ? [...requiredNames(read(root, 'dependencies'), read(root, 'optionalDependencies')).map(name => ({ name, dev: false })), ...requiredNames(read(root, 'devDependencies')).map(name => ({ name, dev: true }))]
      : null;
    for (const [key, entry] of Object.entries(fieldsOf(packages))) {
      const version = read(entry, 'version');
      if (!key || !entry || typeof entry !== 'object' || read(entry, 'link') || typeof version !== 'string') continue;
      const declaredName = read(entry, 'name');
      const name = typeof declaredName === 'string' && declaredName ? declaredName : key.slice(key.lastIndexOf('node_modules/') + 13);
      /* Workspace package records describe local projects, not installed registry components. */
      if (!key.includes('node_modules/')) continue;
      const license = read(entry, 'license');
      out.push({ name, version, location: key, line: lines.get(key) || 1, dev: Boolean(read(entry, 'dev')), top: key === `node_modules/${name}`, requires: requiredNames(read(entry, 'dependencies'), read(entry, 'optionalDependencies')),
        license: typeof license === 'string' ? license.slice(0, 120) : null });
    }
    return { entries: out, roots, workspaces };
  }
  const walk = (dependencies: unknown, top: boolean): void => {
    for (const [name, entry] of Object.entries(fieldsOf(dependencies))) {
      const version = read(entry, 'version');
      if (!entry || typeof version !== 'string' || /^(file|link|git|github|https?):/.test(version)) continue;
      out.push({ name, version, line: keyLine(text, name), dev: Boolean(read(entry, 'dev')), top, requires: requiredNames(read(entry, 'requires')) });
      const nested = read(entry, 'dependencies');
      if (nested) walk(nested, false);
    }
  };
  walk(read(lock, 'dependencies'), true);
  return { entries: out, roots: null };
}

/* A package name as a YAML or yarn key writes it: quoted or not, with a range or a version after it. */
const LOCK_DEP_LINE = /^\s+['"]?((?:@[^@/\s'"]+\/)?[^@\s'":]+)['"]?:?\s+\S/;
/* The same name as a YAML map key, whatever follows it. */
const LOCK_KEY_LINE = /^\s+['"]?((?:@[^@/\s'"]+\/)?[^@\s'":]+)['"]?:/;

function yarnLockEntries(text: string): LockParse {
  const out: Installed[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const header = /^"?((?:@[^@/\s"]+\/)?[^@\s",]+)@[^\n]*:\s*$/.exec(lines[index] ?? '');
    if (!header) continue;
    let version: string | null = null;
    let listing = false;
    const requires: string[] = [];
    let cursor = index + 1;
    for (; cursor < lines.length && /^\s/.test(lines[cursor] ?? ''); cursor += 1) {
      const line = lines[cursor] ?? '';
      const found = /^\s{2}version:?\s+"?([^"\s]+)"?\s*$/.exec(line);
      if (found) { version = found[1] ?? ''; listing = false; continue; }
      if (/^\s{2}\S/.test(line)) { listing = /^\s{2}(dependencies|optionalDependencies):\s*$/.test(line); continue; }
      const dep = listing && /^\s{4}\S/.test(line) && LOCK_DEP_LINE.exec(line);
      if (dep) requires.push(dep[1] ?? '');
    }
    if (version && !/^0\.0\.0-use\.local$/.test(version)) out.push({ name: header[1] ?? '', version, line: index + 1, dev: false, top: false, requires });
    index = cursor - 1;
  }
  return { entries: out, roots: null };
}

/*
 * pnpm keeps versions under `packages:` and, from lockfile 9, what each
 * resolved package requires under `snapshots:`; `importers:` names what each
 * workspace project asked for.
 */
function pnpmLockEntries(text: string): LockParse {
  const out: Installed[] = [];
  const byKey = new Map<string, Installed>();
  const edges = new Map<string, Set<string>>();
  const roots: LockRoot[] = [];
  let section: string | null = null;
  let current: string | null = null;
  let listing: boolean | null = false;
  let rootDev: boolean | null = null;
  text.split('\n').forEach((line, index) => {
    if (/^\S/.test(line)) {
      section = /^(packages|snapshots|importers|dependencies|devDependencies|optionalDependencies):\s*$/.exec(line)?.[1] || null;
      current = null;
      listing = section === 'importers' ? null : false;
      /* Lockfile 5 lists the project's own dependencies at the top level. */
      rootDev = section === 'devDependencies' ? true : section === 'dependencies' || section === 'optionalDependencies' ? false : null;
      return;
    }
    if (rootDev !== null) {
      const dep = /^ {2}\S/.test(line) && LOCK_KEY_LINE.exec(line);
      if (dep) roots.push({ name: dep[1] ?? '', dev: rootDev });
      return;
    }
    if (section === 'importers') {
      if (/^ {4}\S/.test(line)) { listing = /^ {4}(dependencies|devDependencies|optionalDependencies):\s*$/.test(line) ? /devDependencies/.test(line) : null; return; }
      const dep = listing !== null && /^ {6}\S/.test(line) && LOCK_KEY_LINE.exec(line);
      if (dep && listing !== null) roots.push({ name: dep[1] ?? '', dev: listing });
      return;
    }
    if (section !== 'packages' && section !== 'snapshots') return;
    const entry = /^ {2}['"]?\/?((?:@[^@/\s'"]+\/)?[^@/\s'"(]+)[@/](\d[^:('"\s]*)(?:\([^:]*\))?['"]?:\s*$/.exec(line);
    if (entry) {
      current = `${entry[1]}@${entry[2]}`;
      listing = false;
      if (section === 'packages' && !byKey.has(current)) {
        const item: Installed = { name: entry[1] ?? '', version: entry[2] ?? '', line: index + 1, dev: false, top: false, requires: [] };
        byKey.set(current, item);
        out.push(item);
      }
      return;
    }
    if (!current) return;
    if (/^ {4}\S/.test(line)) {
      listing = /^ {4}(dependencies|optionalDependencies):\s*$/.test(line);
      const item = byKey.get(current);
      if (section === 'packages' && /^ {4}dev:\s*true\s*$/.test(line) && item) item.dev = true;
      return;
    }
    const dep = listing && /^ {6}\S/.test(line) && LOCK_DEP_LINE.exec(line);
    if (dep) {
      let required = edges.get(current);
      if (!required) { required = new Set(); edges.set(current, required); }
      required.add(dep[1] ?? '');
    }
  });
  for (const [key, names] of edges) {
    const item = byKey.get(key);
    if (item) item.requires = [...new Set([...item.requires, ...names])];
  }
  return { entries: out, roots: roots.length ? roots : null };
}

function poetryLockEntries(text: string): LockParse {
  const out: Installed[] = [];
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    if (!/^\[\[package\]\]\s*$/.test(line)) return;
    let name: string | null = null;
    let version: string | null = null;
    let dev = false;
    let table = 'package';
    const requires: string[] = [];
    /* A package runs to the next package or the next top-level table; its own tables are `[package.*]`. */
    for (let cursor = index + 1; cursor < lines.length && !/^\[\[/.test(lines[cursor] ?? ''); cursor += 1) {
      const text = lines[cursor] ?? '';
      const heading = /^\[([^\]]+)\]\s*$/.exec(text)?.[1];
      if (heading !== undefined) {
        if (!heading.startsWith('package.')) break;
        table = heading;
        continue;
      }
      if (table === 'package.dependencies') {
        const dep = /^([A-Za-z0-9][\w.-]*)\s*=/.exec(text);
        if (dep) requires.push(dep[1] ?? '');
        continue;
      }
      if (table !== 'package') continue;
      const pair = /^(name|version|category)\s*=\s*"([^"]*)"/.exec(text);
      if (!pair) continue;
      if (pair[1] === 'name') name = pair[2] ?? '';
      if (pair[1] === 'version') version = pair[2] ?? '';
      if (pair[1] === 'category') dev = pair[2] === 'dev';
    }
    if (name && version) out.push({ name, version, line: index + 1, dev, top: false, requires });
  });
  return { entries: out, roots: null };
}

const PIPFILE_SECTIONS: readonly (readonly [string, boolean])[] = [['default', false], ['develop', true]];
function pipfileLockEntries(text: string): LockParse {
  const lock = parseJson(text);
  const out: Installed[] = [];
  for (const [section, dev] of PIPFILE_SECTIONS) {
    for (const [name, entry] of Object.entries(fieldsOf(read(lock, section)))) {
      const version = entry ? /^==\s*([^\s,;]+)$/.exec(String(read(entry, 'version') || ''))?.[1] : undefined;
      if (version !== undefined) out.push({ name, version, line: keyLine(text, name), dev, top: true, requires: [] });
    }
  }
  /* Pipfile.lock records no requirements between packages. */
  return { entries: out, roots: null, flat: true };
}

export const LOCK_PARSERS = lookupTable<Record<string, readonly [string, LockParser]>>({
  'package-lock.json': ['npm', packageLockEntries],
  'npm-shrinkwrap.json': ['npm', packageLockEntries],
  'yarn.lock': ['npm', yarnLockEntries],
  'pnpm-lock.yaml': ['npm', pnpmLockEntries],
  'poetry.lock': ['pypi', poetryLockEntries],
  'Pipfile.lock': ['pypi', pipfileLockEntries],
  ...ecosystems.LOCKS
});

export function nameKey(ecosystem: string, name: unknown): string {
  return ecosystem === 'pypi' ? normalizePypi(name) : String(name).toLowerCase();
}

/*
 * Every package version worth asking about, most useful first: what the
 * manifests declare, at the version the lockfile beside them installed; then
 * what those bring in; then, for a manifest with no lockfile entry, an exact
 * pin or the lowest version its range accepts -- marked as a range, because
 * that is a statement about what could install, not what did.
 *
 * Beside the inventory, one requirement graph per lockfile: which package
 * requires which, by name, and which the project asked for itself. It is
 * what names the dependency a transitive vulnerability came in with.
 */
/* A file as the audit holds it: a path, and its text when it was read. */
export interface DependencyFile {
  readonly path: string;
  readonly text?: unknown;
}

export function readDependencies(files: readonly DependencyFile[]): DependencyReading {
  const manifests: ManifestRecord[] = [];
  const locks: LockRecord[] = [];
  const setAside: string[] = [];
  for (const source of files) {
    const text = source.text;
    if (typeof text !== 'string') continue;
    const file = { ...source, text };
    const base = baseName(file.path);
    const dir = dirName(file.path);
    const manifestParser = ecosystems.manifestParserFor(file.path);
    const lockParser = LOCK_PARSERS[base];
    if (isFixturePath(file.path)) {
      if (base === 'package.json' || isRequirements(base) || manifestParser || lockParser) setAside.push(file.path);
      continue;
    }
    if (base === 'package.json') {
      manifests.push({ dir, ecosystem: 'npm', packages: packageJsonFindings(file).packages });
    } else if (isRequirements(base)) {
      manifests.push({ dir, ecosystem: 'pypi', packages: requirementsPackages({ ...file, base }) });
    } else if (manifestParser) {
      /* One manifest can only speak for one ecosystem; an empty one declares nothing. */
      const packages = manifestParser(file);
      const first = packages[0];
      if (first) manifests.push({ dir, ecosystem: first.ecosystem, packages });
    } else if (lockParser) {
      const [ecosystem, parse] = lockParser;
      const parsed = parse(file.text);
      locks.push({ dir, ecosystem, path: file.path, entries: parsed.entries, roots: parsed.roots, workspaces: Array.isArray(parsed.workspaces) ? parsed.workspaces : null, flat: Boolean(parsed.flat), declared: [], index: new Map(), locations: new Map() });
    }
  }
  const entries: InventoryEntry[] = [];
  const installedDirect = new Set<string>();
  /* Each lockfile indexed by name once, so a large one is not searched once per declared package. */
  for (const lock of locks) {
    lock.locations = new Map(lock.entries.flatMap((entry): [string, Installed][] => (entry.location ? [[entry.location, entry]] : [])));
    for (const entry of lock.entries) {
      const key = nameKey(lock.ecosystem, entry.name);
      const known = lock.index.get(key);
      if (!known || (entry.top && !known.top)) lock.index.set(key, entry);
    }
  }
  for (const manifest of manifests) {
    const workspaceDir = (candidate: LockRecord): string => candidate.dir ? manifest.dir.slice(candidate.dir.length + 1) : manifest.dir;
    const above = (candidate: LockRecord): boolean => candidate.ecosystem === manifest.ecosystem && (!candidate.dir || manifest.dir.startsWith(`${candidate.dir}/`));
    /*
     * A lock that lists its workspaces (npm's packages map) answers only for those. One that does not
     * (yarn, pnpm, poetry and the rest) is the nearest lock above, as a monorepo installs from its root.
     */
    const lock = locks.find(candidate => candidate.ecosystem === manifest.ecosystem && candidate.dir === manifest.dir) ||
      locks.find(candidate => above(candidate) && candidate.workspaces && candidate.workspaces.includes(workspaceDir(candidate))) ||
      locks.filter(candidate => above(candidate) && candidate.workspaces === null).sort((a, b) => b.dir.length - a.dir.length)[0];
    for (const declared of manifest.packages) {
      const key = nameKey(manifest.ecosystem, declared.name);
      if (lock) lock.declared.push({ name: declared.name, dev: Boolean(declared.dev) });
      let installed: Installed | null | undefined = lock ? lock.index.get(key) : null;
      if (lock && lock.dir !== manifest.dir && !lock.workspaces) {
        /* That lock cannot prove it installed this manifest, so an exact pin it did not install stands. */
        const pin = installed && exactVersion(String(declared.spec || '').trim(), manifest.ecosystem);
        if (installed && pin && pin !== installed.version) installed = null;
      } else if (lock && lock.dir !== manifest.dir) {
        /* A linked npm workspace resolves its own nested install before walking up to the root. */
        let dir = workspaceDir(lock);
        installed = null;
        while (true) {
          installed = lock.locations.get(`${dir ? `${dir}/` : ''}node_modules/${declared.name}`);
          if (installed || !dir) break;
          dir = dirName(dir);
        }
      }
      const base = { ecosystem: manifest.ecosystem, name: declared.name, path: declared.path, line: declared.line, direct: true, dev: Boolean(declared.dev) };
      if (installed && lock) {
        entries.push({ ...base, version: installed.version, source: 'lock', lock: lock.path, license: installed.license || null });
        installedDirect.add(advisoryKey({ ecosystem: manifest.ecosystem, name: declared.name, version: installed.version }));
        continue;
      }
      const spec = String(declared.spec || '').trim();
      const pinned = exactVersion(spec, manifest.ecosystem);
      if (pinned) { entries.push({ ...base, version: pinned, source: 'pin' }); continue; }
      const floor = rangeFloor(spec, manifest.ecosystem);
      if (floor) entries.push({ ...base, version: floor, source: 'range', range: spec });
    }
  }
  for (const lock of locks) {
    /* A lockfile with no manifest beside it (go.mod is both) still says which packages were asked for. */
    const asked = !lock.declared.length && lock.roots ? new Set(lock.roots.map(root => nameKey(lock.ecosystem, root.name))) : null;
    for (const entry of lock.entries) {
      if (installedDirect.has(advisoryKey({ ecosystem: lock.ecosystem, name: entry.name, version: entry.version }))) continue;
      const direct = Boolean(asked && asked.has(nameKey(lock.ecosystem, entry.name)));
      entries.push({ ecosystem: lock.ecosystem, name: entry.name, version: entry.version, path: lock.path, line: entry.line, direct, dev: entry.dev, source: 'lock', lock: lock.path, license: entry.license || null });
    }
  }
  const seen = new Set();
  const inventory = entries.filter(entry => {
    const key = `${advisoryKey(entry)}\0${entry.path}`;
    /* A version starts with a digit; Go writes a v before it. */
    if (seen.has(key) || !/^v?\d/.test(entry.version)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => Number(b.direct) - Number(a.direct));

  const graphs = new Map<string, LockGraph>();
  for (const lock of locks) {
    const requires = new Map<string, Set<string>>();
    const names = new Map<string, string>();
    for (const entry of lock.entries) {
      const key = nameKey(lock.ecosystem, entry.name);
      names.set(key, entry.name);
      let required = requires.get(key);
      if (!required) { required = new Set(); requires.set(key, required); }
      for (const name of entry.requires || []) required.add(nameKey(lock.ecosystem, name));
    }
    /* What the project asked for: its manifests, else what the lockfile itself records. */
    const rootList = lock.declared.length ? lock.declared : lock.roots || [];
    const roots = new Map<string, LockRoot>();
    for (const root of rootList) {
      const key = nameKey(lock.ecosystem, root.name);
      const known = roots.get(key);
      roots.set(key, { name: root.name, dev: known ? known.dev && root.dev : root.dev });
    }
    const namespaces = new Map<string, string[]>();
    for (const entry of lock.entries) if (Array.isArray(entry.namespaces) && entry.namespaces.length) namespaces.set(nameKey(lock.ecosystem, entry.name), entry.namespaces);
    graphs.set(lock.path, { ecosystem: lock.ecosystem, requires, names, roots, namespaces, linked: !lock.flat && [...requires.values()].some(set => set.size > 0) });
  }
  return { inventory, graphs, setAside };
}

export function dependencyInventory(files: readonly DependencyFile[]): InventoryEntry[] {
  return readDependencies(files).inventory;
}

/*
 * The dependencies the project asked for that bring this package in, and
 * the shortest chain from one of them to it. Walked up from the package, so
 * the cost is the part of the graph above it, never the whole lockfile.
 */
/* The dependencies that bring a package in, and the shortest chain from one of them to it. */
export interface Introduced {
  readonly roots: LockRoot[];
  readonly chain: string[];
}
export function introducedThrough(graph: LockGraph | null | undefined, name: string): Introduced | null {
  if (!graph || !graph.linked || !graph.roots.size) return null;
  let parents = graph.parents;
  if (!parents) {
    parents = new Map();
    for (const [parent, children] of graph.requires) {
      for (const child of children) {
        let list = parents.get(child);
        if (!list) { list = []; parents.set(child, list); }
        list.push(parent);
      }
    }
    graph.parents = parents;
  }
  const start = nameKey(graph.ecosystem, name);
  const below = new Map<string, string | null>([[start, null]]);
  const queue = [start];
  const found: string[] = [];
  for (const node of queue) {
    if (node !== start && graph.roots.has(node)) { found.push(node); continue; }
    for (const parent of parents.get(node) || []) {
      if (below.has(parent)) continue;
      below.set(parent, node);
      queue.push(parent);
    }
  }
  if (!found.length) return { roots: [], chain: [] };
  const chain: string[] = [];
  for (let node: string | null | undefined = found[0]; node !== null && node !== undefined && chain.length < 8; node = below.get(node)) chain.push(graph.names.get(node) || node);
  return { roots: found.flatMap(key => { const root = graph.roots.get(key); return root ? [{ name: root.name, dev: root.dev }] : []; }), chain };
}

export function advisoryKey(entry: { readonly ecosystem: string; readonly name: unknown; readonly version: string }): string {
  return `${entry.ecosystem}:${nameKey(entry.ecosystem, entry.name)}@${entry.version}`;
}

/* ---- Versions ------------------------------------------------------------------ */

/*
 * Ordering versions well enough to say which advisory range a version sits in
 * and whether a fix is inside a declared range: numbers compare as numbers,
 * a pre-release sorts before its release, build metadata is ignored.
 */
function versionTokens(version: unknown): string[] {
  return String(version).replace(/^v/i, '').replace(/\+.*$/, '').toLowerCase().match(/\d+|[a-z]+/g) || [];
}
export function compareVersions(a: unknown, b: unknown): number {
  const left = versionTokens(a).map(token => (/^\d+$/.test(token) ? Number(token) : token));
  const right = versionTokens(b).map(token => (/^\d+$/.test(token) ? Number(token) : token));
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const x = left[index];
    const y = right[index];
    if (x === undefined) return typeof y === 'string' && y !== 'post' ? 1 : -1;
    if (y === undefined) return typeof x === 'string' && x !== 'post' ? -1 : 1;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1;
    if (typeof x === 'number') return 1;
    if (typeof y === 'number') return -1;
    return x < y ? -1 : 1;
  }
  return 0;
}

function padded(version: string): string {
  const parts = String(version).split('.');
  while (parts.length < 3) parts.push('0');
  return parts.join('.');
}

/*
 * The version a spec pins exactly, or null. What "exact" looks like differs:
 * a bare version is exact in npm, Maven, NuGet, Bundler and Composer, but a
 * caret range in Cargo; PyPI needs `==`; a Go requirement is always exact.
 */
function exactVersion(spec: unknown, ecosystem: string): string | null {
  const text = String(spec || '').trim();
  const pick = (match: RegExpExecArray | null): string | null => (match ? match[1] ?? null : null);
  switch (ecosystem) {
    case 'npm': return pick(/^=?v?(\d+\.\d+\.\d+(?:-[\w.]+)?)$/.exec(text));
    case 'pypi': return pick(/^===?\s*([\w.!+-]+)$/.exec(text));
    case 'cargo': return pick(/^=\s*(\d[\w.+-]*)$/.exec(text));
    case 'rubygems': return pick(/^=?\s*(\d[\w.]*)$/.exec(text));
    case 'packagist': return pick(/^=?\s*v?(\d+(?:\.\d+)+(?:-[\w.]+)?)$/.exec(text));
    case 'maven': case 'nuget': return pick(/^\[?\s*v?(\d[\w.+-]*?)\s*\]?$/.exec(text));
    case 'go': return pick(/^(v?\d[\w.+-]*)$/.exec(text));
    default: return null;
  }
}

/*
 * The lowest version a declared range accepts, or null when it has no floor.
 * npm, Cargo and Composer share caret ranges (a bare Cargo version is one);
 * Bundler's `~>` and Composer's `~` are pessimistic; Poetry writes carets in
 * a PyPI manifest.
 */
const NPM_LIKE: ReadonlySet<string> = new Set(['npm', 'cargo', 'packagist']);
export function rangeFloor(spec: unknown, ecosystem: string): string | null {
  const text = String(spec || '').trim().split(/\s*,\s*/)[0];
  if (!text || /\|\||^[<*xX]|^latest$|^next$/.test(text)) return null;
  let match: RegExpExecArray | null = null;
  if (NPM_LIKE.has(ecosystem) || (ecosystem === 'pypi' && /^[\^~](?!=)/.test(text))) {
    match = /^(?:\^|~|>=|=)?\s*v?(\d+(?:\.(?:\d+|[xX*]))?(?:\.(?:\d+|[xX*]))?)/.exec(text);
  } else if (ecosystem === 'pypi') {
    match = /^(?:>=|~=|==)\s*([\d]+(?:\.\d+)*)/.exec(text);
  } else if (ecosystem === 'rubygems') {
    match = /^(?:~>|>=|=)\s*(\d+(?:\.\d+)*)/.exec(text);
  }
  return match ? padded((match[1] ?? '').replace(/\.[xX*]/g, '.0')) : null;
}

/* The first version a declared range refuses, or null when it has no ceiling. */
/*
 * In the arithmetic below a part the range leaves open is null, and counts
 * as nought, exactly as JavaScript adds it: `Number(part)` says so.
 */
export function rangeCeiling(spec: unknown, ecosystem: string): string | null {
  const text = String(spec || '').trim();
  const upper = /<\s*=?\s*v?([\d.]+)/.exec(text);
  if (upper) return padded(upper[1] ?? '');
  const numbers = (/(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?/.exec(text) || []).slice(1).map(part => (part === undefined || /[xX*]/.test(part) ? null : Number(part)));
  const [major, minor, patch] = numbers;
  if (major === undefined || major === null) return null;
  /* Pessimistic: the last written part may rise, the one before it may not. */
  const pessimistic = (): string => (patch !== null && patch !== undefined ? `${major}.${Number(minor) + 1}.0` : `${major + 1}.0.0`);
  if (ecosystem === 'rubygems') return text.startsWith('~>') ? pessimistic() : null;
  if (ecosystem === 'packagist' && /^~(?!>)/.test(text)) return pessimistic();
  if (ecosystem === 'pypi' && !/^[\^~](?!=)/.test(text)) {
    if (!text.startsWith('~=')) return null;
    return patch !== null && patch !== undefined ? `${major}.${Number(minor) + 1}.0` : `${major + 1}.0.0`;
  }
  if (!NPM_LIKE.has(ecosystem) && ecosystem !== 'pypi') return null;
  /* A bare Cargo version is a caret range. */
  const caret = text.startsWith('^') || (ecosystem === 'cargo' && /^\d/.test(text));
  if (caret) {
    if (major > 0 || minor === null) return `${major + 1}.0.0`;
    if (Number(minor) > 0 || patch === null) return `0.${Number(minor) + 1}.0`;
    return `0.0.${Number(patch) + 1}`;
  }
  if (text.startsWith('~')) return minor === null ? `${major + 1}.0.0` : `${major}.${Number(minor) + 1}.0`;
  if (minor === null) return `${major + 1}.0.0`;
  if (patch === null) return `${major}.${Number(minor) + 1}.0`;
  return null;
}

/* ---- Look-alike names ---------------------------------------------------------- */

/* Optimal string alignment distance, stopping early past one edit. */
function withinOneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  /* The distance table, row by row in one array: cell (i, j) is the distance between a's first i letters and b's first j. */
  const width = b.length + 1;
  const rows = new Array<number>((a.length + 1) * width).fill(0);
  const cell = (i: number, j: number): number => rows[i * width + j] ?? 0;
  for (let i = 0; i <= a.length; i += 1) rows[i * width] = i;
  for (let j = 1; j <= b.length; j += 1) rows[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let distance = Math.min(cell(i - 1, j) + 1, cell(i, j - 1) + 1, cell(i - 1, j - 1) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) distance = Math.min(distance, cell(i - 2, j - 2) + 1);
      rows[i * width + j] = distance;
    }
  }
  return cell(a.length, b.length) === 1;
}

const POPULAR_SETS: ReadonlyMap<string, readonly string[]> = new Map([
  ['npm', Object.freeze(POPULAR.NPM.map(name => name.toLowerCase()))],
  ['pypi', Object.freeze(POPULAR.PYPI.map(normalizePypi))]
]);

/* A declared name one keystroke from a popular one, or the same letters with the separators moved. */
export function lookAlike(ecosystem: string, name: string): string | null {
  if (ecosystem === 'npm' && name.startsWith('@')) return null;
  const candidate = nameKey(ecosystem, name);
  const popular = POPULAR_SETS.get(ecosystem);
  if (!popular || popular.includes(candidate) || candidate.length < 5) return null;
  const squash = (value: string): string => value.replace(/[-_.]/g, '');
  return popular.find(target => target.length >= 5 && (withinOneEdit(candidate, target) || (squash(candidate) === squash(target)))) || null;
}

/* PEP 503: the name PyPI answers to. */
export function normalizePypi(name: unknown): string {
  return String(name).toLowerCase().replace(/[-_.]+/g, '-');
}

export function packageKey(entry: { readonly ecosystem: string; readonly name: string }): string {
  return `${entry.ecosystem}:${entry.ecosystem === 'pypi' ? normalizePypi(entry.name) : entry.name.toLowerCase()}`;
}
export function dedupePackages<T extends { readonly ecosystem: string; readonly name: string }>(packages: readonly T[]): T[] {
  const out = new Map<string, T>();
  for (const entry of packages) if (!out.has(packageKey(entry))) out.set(packageKey(entry), entry);
  return [...out.values()];
}
