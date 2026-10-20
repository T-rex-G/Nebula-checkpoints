import { fieldsOf, listOf, ownEntry, read } from '../../../platform/values/fields.ts';

/*
 * Manifests and lockfiles beyond npm and PyPI: Go, Maven and Gradle,
 * Composer, Bundler, Cargo and NuGet, and the Python manifests that are not
 * a requirements file (pyproject.toml, Pipfile).
 *
 * Each parser reads text the audit already holds and answers in the shapes
 * code-audit.js uses for npm and PyPI:
 *
 *   - a manifest parser: the packages a project declares,
 *     `{ ecosystem, name, path, line, spec, dev }`;
 *   - a lockfile parser: what was resolved, `{ entries, roots, flat }`, each
 *     entry `{ name, version, line, dev, top, requires }`, and `roots` the
 *     packages the project asked for, when the format records them.
 *
 * None of them evaluates anything. A version written as a variable the file
 * does not define, a local path or a git source is left out rather than
 * guessed: an advisory is only ever asked about a version that is written
 * down. Nothing from a file leaves this module but names, versions and line
 * numbers.
 */

/* A package a manifest declares: its ecosystem and name, where, the version it asks for, and whether it is only for development. */
export interface DeclaredPackage {
  ecosystem: string;
  name: string;
  path: string;
  line: number;
  spec: string;
  dev: boolean;
}

/* A package a lockfile resolved: its version, its line, whether only development needs it, whether the project asked for it, and what it requires. */
export interface LockEntry {
  name: string;
  version: string;
  line: number;
  dev: boolean;
  top: boolean;
  requires: string[];
  namespaces?: string[];
  license?: string[];
}
export interface LockRoot {
  name: string;
  dev: boolean;
}
export interface LockReading {
  entries: LockEntry[];
  roots: LockRoot[] | null;
  flat?: boolean;
}

/* A file a manifest parser reads: its path and its text. */
export interface ManifestFile {
  readonly path: string;
  readonly text: string;
}
export type ManifestParser = (file: ManifestFile) => DeclaredPackage[];
export type LockParser = (text: string) => LockReading;

/* The keys of a value as Object.keys reads it, coercing a primitive; none for a missing one. */
function keysOf(value: unknown): string[] {
  return value ? Object.keys(Object(value)) : [];
}

const lineAt = (text: string, index: number): number => text.slice(0, index).split('\n').length;
const unquote = (value: unknown): string => String(value || '').trim().replace(/^['"]|['"]$/g, '');

/* ---- Go ---------------------------------------------------------------------- */

/*
 * go.mod is both manifest and lockfile: since Go 1.17 it lists every module
 * the build selects, the ones only something else needs marked `// indirect`.
 * A replacement by another module version is followed; one by a local path is
 * not a published version and is left out.
 */
export function goModEntries(text: string): LockReading {
  const entries: LockEntry[] = [];
  const replaced = new Map<string, { name: string; version: string } | null>();
  const lines = text.split('\n');
  let block: string | null = null;
  const requireLine = (raw: string, index: number) => {
    const line = raw.replace(/\/\/(?!\s*indirect).*$/, '');
    const match = /^\s*([^\s()]+)\s+(v[^\s]+)\s*(\/\/\s*indirect)?/.exec(line);
    if (!match || match[1] === undefined || match[2] === undefined) return;
    entries.push({ name: match[1], version: match[2], line: index + 1, dev: false, top: !match[3], requires: [] });
  };
  const replaceLine = (raw: string) => {
    const match = /^\s*([^\s=]+)(?:\s+v\S+)?\s*=>\s*(\S+)(?:\s+(v\S+))?/.exec(raw.replace(/\/\/.*$/, ''));
    if (match && match[1] !== undefined) replaced.set(match[1], match[3] ? { name: match[2] ?? '', version: match[3] } : null);
  };
  lines.forEach((raw, index) => {
    const trimmed = raw.trim();
    if (block) {
      if (trimmed.startsWith(')')) { block = null; return; }
      if (block === 'require') requireLine(raw, index);
      if (block === 'replace') replaceLine(raw);
      return;
    }
    const opener = /^(require|replace)\s*\(\s*$/.exec(trimmed);
    if (opener) { block = opener[1] ?? null; return; }
    if (/^require\s+/.test(trimmed)) requireLine(trimmed.replace(/^require\s+/, ''), index);
    if (/^replace\s+/.test(trimmed)) replaceLine(trimmed.replace(/^replace\s+/, ''));
  });
  const out: LockEntry[] = [];
  for (const entry of entries) {
    if (!replaced.has(entry.name)) { out.push(entry); continue; }
    const target = replaced.get(entry.name);
    if (target) out.push({ ...entry, name: target.name, version: target.version });
  }
  return {
    entries: out.map(entry => ({ ...entry, version: entry.version.replace(/\+incompatible$/, '') })),
    roots: out.filter(entry => entry.top).map(entry => ({ name: entry.name, dev: false })),
    flat: true
  };
}

/* ---- Maven -------------------------------------------------------------------- */

/*
 * pom.xml: the dependencies a project declares, with versions resolved from
 * its own properties and dependency management. Build plugins and their
 * dependencies are tooling, not what ships, and are not read. A version the
 * file does not state (a parent's, a BOM's) is left out.
 */
export function pomPackages(file: ManifestFile): DeclaredPackage[] {
  let text = String(file.text).replace(/<!--[\s\S]*?-->/g, match => match.replace(/[^\n]/g, ' '));
  const tag = (block: string, name: string): string | null => {
    const match = new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`).exec(block);
    return match ? match[1] ?? null : null;
  };
  const properties = new Map<string, string>();
  const propertiesBlock = /<properties>([\s\S]*?)<\/properties>/.exec(text);
  if (propertiesBlock) {
    for (const match of (propertiesBlock[1] ?? '').matchAll(/<([\w.-]+)>\s*([^<]*?)\s*<\/\1>/g)) properties.set(match[1] ?? '', match[2] ?? '');
  }
  const withoutChildren = text.replace(/<(parent|dependencies|dependencyManagement|build|profiles|properties|modules|reporting)>[\s\S]*?<\/\1>/g, match => match.replace(/[^\n]/g, ' '));
  const projectVersion = tag(withoutChildren, 'version');
  if (projectVersion) properties.set('project.version', projectVersion);
  const resolve = (value: string | null): string | null => {
    let resolved = String(value || '');
    for (let depth = 0; depth < 4 && /\$\{[^}]+\}/.test(resolved); depth += 1) {
      resolved = resolved.replace(/\$\{([^}]+)\}/g, (whole: string, key: string) => properties.get(key) ?? whole);
    }
    return /\$\{/.test(resolved) ? null : resolved;
  };
  /* Versions a project manages centrally, for dependencies that name none. */
  const managed = new Map<string, string>();
  for (const management of text.matchAll(/<dependencyManagement>([\s\S]*?)<\/dependencyManagement>/g)) {
    for (const match of (management[1] ?? '').matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
      const block = match[1] ?? '';
      const group = tag(block, 'groupId');
      const artifact = tag(block, 'artifactId');
      const version = resolve(tag(block, 'version'));
      if (group && artifact && version) managed.set(`${group}:${artifact}`, version);
    }
  }
  text = text.replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g, match => match.replace(/[^\n]/g, ' '));
  /* Every build section, the project's and each profile's: plugins are tooling. */
  text = text.replace(/<build>[\s\S]*?<\/build>/g, match => match.replace(/[^\n]/g, ' '));
  const packages: DeclaredPackage[] = [];
  for (const match of text.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const block = match[1] ?? '';
    const group = resolve(tag(block, 'groupId'));
    const artifact = resolve(tag(block, 'artifactId'));
    if (!group || !artifact) continue;
    const name = `${group}:${artifact}`;
    const version = resolve(tag(block, 'version')) || managed.get(name) || null;
    const scope = tag(block, 'scope');
    packages.push({ ecosystem: 'maven', name, path: file.path, line: lineAt(text, match.index), spec: version || '', dev: scope === 'test' });
  }
  return packages;
}

/* build.gradle and build.gradle.kts: string coordinates with a literal version. */
const GRADLE_CONFIG = /^\s*(implementation|api|compile|runtimeOnly|runtime|compileOnly|testImplementation|testCompile|testRuntimeOnly|testCompileOnly|androidTestImplementation|debugImplementation|releaseImplementation|annotationProcessor|kapt|ksp)\s*\(?\s*(?:platform\s*\(\s*)?['"]([\w.-]+):([\w.-]+):([^'"$@\s]+)['"]/;
export function gradlePackages(file: ManifestFile): DeclaredPackage[] {
  const packages: DeclaredPackage[] = [];
  String(file.text).split('\n').forEach((line, index) => {
    const match = GRADLE_CONFIG.exec(line);
    if (!match) return;
    const configuration = match[1] ?? '';
    packages.push({
      ecosystem: 'maven', name: `${match[2] ?? ''}:${match[3] ?? ''}`, path: file.path, line: index + 1, spec: match[4] ?? '',
      /* Test configurations and annotation processors never reach the running application. */
      dev: /^(test|androidTest|annotationProcessor|kapt|ksp|compileOnly)/.test(configuration)
    });
  });
  return packages;
}

/* gradle.lockfile: `group:artifact:version=configurations`, one per line. */
export function gradleLockEntries(text: string): LockReading {
  const entries: LockEntry[] = [];
  String(text).split('\n').forEach((line, index) => {
    const match = /^([\w.-]+):([\w.-]+):([^=\s]+)=(.*)$/.exec(line.trim());
    if (!match) return;
    const configurations = (match[4] ?? '').split(',').map(item => item.trim()).filter(Boolean);
    const dev = configurations.length > 0 && configurations.every(item => /^test|AndroidTest|UnitTest|annotationProcessor/i.test(item));
    entries.push({ name: `${match[1] ?? ''}:${match[2] ?? ''}`, version: match[3] ?? '', line: index + 1, dev, top: false, requires: [] });
  });
  return { entries, roots: null, flat: true };
}

/* ---- Composer ----------------------------------------------------------------- */

const PLATFORM_PACKAGE = /^(php|hhvm|composer(-plugin|-runtime)?-api|ext-.+|lib-.+)$/i;

const COMPOSER_SECTIONS: readonly (readonly [string, boolean])[] = [['require', false], ['require-dev', true]];

export function composerJsonPackages(file: ManifestFile): DeclaredPackage[] {
  let manifest: unknown = null;
  try { manifest = JSON.parse(file.text); } catch { return []; }
  const packages: DeclaredPackage[] = [];
  for (const [section, dev] of COMPOSER_SECTIONS) {
    for (const [name, spec] of Object.entries(Object(read(manifest, section) || {}))) {
      if (PLATFORM_PACKAGE.test(name) || !name.includes('/')) continue;
      const at = file.text.indexOf(`"${name}"`);
      packages.push({ ecosystem: 'packagist', name, path: file.path, line: at >= 0 ? lineAt(file.text, at) : 1, spec: String(spec || ''), dev });
    }
  }
  return packages;
}

/*
 * composer.lock records what each package requires and which namespaces it
 * autoloads -- the second is how PHP code names a package, and what the
 * reach scan looks for.
 */
const COMPOSER_LOCK_SECTIONS: readonly (readonly [string, boolean])[] = [['packages', false], ['packages-dev', true]];

export function composerLockEntries(text: string): LockReading {
  let lock: unknown = null;
  try { lock = JSON.parse(text); } catch { return { entries: [], roots: null }; }
  const entries: LockEntry[] = [];
  for (const [section, dev] of COMPOSER_LOCK_SECTIONS) {
    for (const item of listOf(read(lock, section))) {
      const name = read(item, 'name');
      const version = read(item, 'version');
      if (!item || typeof name !== 'string' || typeof version !== 'string') continue;
      const declared = read(item, 'autoload');
      const autoload = declared && typeof declared === 'object' ? fieldsOf(declared) : {};
      const namespaces = [...keysOf(autoload['psr-4'] || {}), ...keysOf(autoload['psr-0'] || {})].filter(Boolean);
      const at = text.indexOf(`"name": "${name}"`);
      const license = read(item, 'license');
      entries.push({
        name, version: version.replace(/^v(?=\d)/, ''), line: at >= 0 ? lineAt(text, at) : 1, dev, top: false,
        requires: keysOf(read(item, 'require') || {}).filter(required => !PLATFORM_PACKAGE.test(required)),
        namespaces,
        license: Array.isArray(license) ? license.filter((value): value is string => typeof value === 'string').slice(0, 4) : []
      });
    }
  }
  return { entries, roots: null };
}

/* ---- Bundler ------------------------------------------------------------------ */

/* The groups a Gemfile puts gems in: development and test gems never run in production. */
export function gemfilePackages(file: ManifestFile): DeclaredPackage[] {
  const packages: DeclaredPackage[] = [];
  /* Every block a Gemfile opens, so an `end` closes the right one; only a group block marks gems. */
  const groups: boolean[] = [];
  String(file.text).split('\n').forEach((raw, index) => {
    const line = raw.replace(/#.*$/, '');
    const group = /^\s*group\s+([^)]*?)\s+do\b/.exec(line);
    if (group) { groups.push(/:(development|test)\b/.test(group[1] ?? '') && !/:production\b/.test(group[1] ?? '')); return; }
    if (/^\s*end\b/.test(line) && groups.length) { groups.pop(); return; }
    if (/\bdo\s*(\|[^|]*\|)?\s*$/.test(line) || /^\s*(if|unless|case|begin|while|until)\b/.test(line)) { groups.push(false); return; }
    const gem = /^\s*gem\s+['"]([\w.-]+)['"]\s*(?:,\s*['"]([^'"]+)['"])?(.*)$/.exec(line);
    if (!gem) return;
    const inline = /group:\s*\[?\s*:(development|test)/.test(gem[3] || '') || /groups?:\s*\[[^\]]*:(development|test)/.test(gem[3] || '');
    packages.push({ ecosystem: 'rubygems', name: gem[1] ?? '', path: file.path, line: index + 1, spec: gem[2] || '', dev: groups.some(Boolean) || inline });
  });
  return packages;
}

/*
 * Gemfile.lock: gems under `specs:` with what each requires, then the
 * project's own dependencies. A platform suffix is not part of the version.
 */
const RUBY_PLATFORM = /-(x86|x64|i[3-6]86|arm|aarch64|universal|java|jruby|mingw|mswin|darwin|linux|musl|freebsd|solaris)[\w.-]*$/;
export function gemfileLockEntries(text: string): LockReading {
  const entries: LockEntry[] = [];
  const roots: LockRoot[] = [];
  let section: string | null = null;
  let current: LockEntry | null = null;
  String(text).split('\n').forEach((line, index) => {
    if (/^\S/.test(line)) { section = line.trim(); current = null; return; }
    if (section === 'GEM') {
      const spec = /^ {4}([\w.-]+) \(([^)]+)\)\s*$/.exec(line);
      if (spec) {
        current = { name: spec[1] ?? '', version: (spec[2] ?? '').replace(RUBY_PLATFORM, ''), line: index + 1, dev: false, top: false, requires: [] };
        entries.push(current);
        return;
      }
      const dep = /^ {6}([\w.-]+)/.exec(line);
      if (dep && current) current.requires.push(dep[1] ?? '');
      return;
    }
    if (section === 'DEPENDENCIES') {
      const dep = /^ {2}([\w.-]+)/.exec(line);
      if (dep) roots.push({ name: dep[1] ?? '', dev: false });
    }
  });
  /* Several platform builds of one version are one version. */
  const seen = new Set<string>();
  const unique = entries.filter(entry => { const key = `${entry.name}@${entry.version}`; if (seen.has(key)) return false; seen.add(key); return true; });
  return { entries: unique, roots: roots.length ? roots : null };
}

/* ---- Cargo -------------------------------------------------------------------- */

/* A minimal TOML reader: the table each `key = value` sits in, with its line. */
/* One `key = value` of a TOML file: the table it sits in, and its line. */
export interface TomlPair {
  readonly table: string;
  readonly key: string;
  readonly value: string;
  readonly line: number;
}

export function tomlPairs(text: unknown): TomlPair[] {
  const out: TomlPair[] = [];
  let table = '';
  const lines = String(text).split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? '').replace(/(^|\s)#.*$/, '').trim();
    if (!line) continue;
    const header = /^\[\[?([^\]]+)\]\]?$/.exec(line);
    if (header) { table = (header[1] ?? '').trim().replace(/\s*\.\s*/g, '.'); continue; }
    const pair = /^("[^"]+"|'[^']+'|[\w.-]+)\s*=\s*(.*)$/.exec(line);
    if (!pair) continue;
    const key = pair[1] ?? '';
    let value = pair[2] ?? '';
    /* An array may run over several lines. */
    if (value.startsWith('[') && !/\]\s*$/.test(value)) {
      while (index + 1 < lines.length && !/\]\s*(,)?\s*$/.test(value)) { index += 1; value += ` ${(lines[index] ?? '').replace(/(^|\s)#.*$/, '').trim()}`; }
    }
    out.push({ table, key: unquote(key), value: value.trim(), line: pairLine(lines, index, key) });
  }
  return out;
}
function pairLine(lines: readonly string[], index: number, key: string): number {
  for (let cursor = index; cursor >= 0; cursor -= 1) if ((lines[cursor] ?? '').includes(key)) return cursor + 1;
  return index + 1;
}
const inlineVersion = (value: string): string | null => {
  if (/^['"]/.test(value)) return unquote(value);
  const version = /\bversion\s*=\s*['"]([^'"]+)['"]/.exec(value);
  if (version) return version[1] ?? null;
  return null;
};

export function cargoTomlPackages(file: ManifestFile): DeclaredPackage[] {
  const packages: DeclaredPackage[] = [];
  for (const { table, key, value, line } of tomlPairs(file.text)) {
    const kind = /(^|\.)(dependencies|dev-dependencies|build-dependencies)$/.exec(table);
    if (!kind) continue;
    if (/\b(path|git)\s*=/.test(value) && !/\bversion\s*=/.test(value)) continue;
    const spec = inlineVersion(value);
    const renamed = /\bpackage\s*=\s*['"]([\w-]+)['"]/.exec(value);
    if (spec === null) continue;
    packages.push({ ecosystem: 'cargo', name: renamed ? renamed[1] ?? '' : key, path: file.path, line, spec, dev: kind[2] !== 'dependencies' });
  }
  return packages;
}

/* Cargo.lock: every crate with what it depends on; the project's own crates have no source. */
interface CargoPackage {
  name: string | null;
  version: string | null;
  line: number;
  dev: boolean;
  top: boolean;
  requires: string[];
  local: boolean;
}

export function cargoLockEntries(text: string): LockReading {
  const entries: (LockEntry & { local: boolean })[] = [];
  const roots: LockRoot[] = [];
  const lines = String(text).split('\n');
  let current: CargoPackage | null = null;
  const flush = () => { if (current && current.name && current.version) entries.push({ ...current, name: current.name, version: current.version }); };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (/^\[\[package\]\]\s*$/.test(line)) { flush(); current = { name: null, version: null, line: index + 1, dev: false, top: false, requires: [], local: true }; continue; }
    if (/^\[/.test(line)) { flush(); current = null; continue; }
    if (!current) continue;
    const pair = /^(name|version|source)\s*=\s*"([^"]*)"/.exec(line);
    if (pair) {
      if (pair[1] === 'source') current.local = false;
      else if (pair[1] === 'name') current.name = pair[2] ?? '';
      else current.version = pair[2] ?? '';
      continue;
    }
    if (/^dependencies\s*=\s*\[/.test(line)) {
      let value = line;
      while (!/\]\s*$/.test(value) && index + 1 < lines.length) { index += 1; value += lines[index] ?? ''; }
      for (const match of value.matchAll(/"([\w-]+)[^"]*"/g)) current.requires.push(match[1] ?? '');
    }
  }
  flush();
  const local = entries.filter(entry => entry.local);
  for (const member of local) for (const name of member.requires) roots.push({ name, dev: false });
  return { entries: entries.filter(entry => !entry.local).map(({ local, ...entry }) => entry), roots: roots.length ? roots : null };
}

/* ---- NuGet -------------------------------------------------------------------- */

export function msbuildPackages(file: ManifestFile): DeclaredPackage[] {
  const packages: DeclaredPackage[] = [];
  const text = String(file.text).replace(/<!--[\s\S]*?-->/g, match => match.replace(/[^\n]/g, ' '));
  for (const match of text.matchAll(/<Package(Reference|Version)\s+([^>]*?)(\/>|>([\s\S]*?)<\/Package\1>)/g)) {
    const attributes = match[2] ?? '';
    const name = (/\b(?:Include|Update)\s*=\s*"([^"]+)"/.exec(attributes) || [])[1];
    const version = (/\bVersion\s*=\s*"([^"]+)"/.exec(attributes) || /<Version>\s*([^<]+?)\s*<\/Version>/.exec(match[4] || '') || [])[1];
    if (!name) continue;
    const assets = /\bPrivateAssets\s*=\s*"all"/i.test(attributes) || /<PrivateAssets>\s*all\s*<\/PrivateAssets>/i.test(match[4] || '');
    packages.push({ ecosystem: 'nuget', name, path: file.path, line: lineAt(text, match.index), spec: version || '', dev: assets });
  }
  /*
   * A project from before PackageReference points at the packages folder
   * NuGet restored into: `packages\Name.1.2.3\lib\...`. The folder is the
   * package and its version; an assembly version is not.
   */
  for (const match of text.matchAll(/<HintPath>[^<]*?packages[\\/]([^\\/<]+?)\.(\d+(?:\.\d+){1,3}(?:-[\w.]+)?)[\\/][^<]*<\/HintPath>/gi)) {
    const name = match[1] ?? '';
    if (packages.some(item => item.name.toLowerCase() === name.toLowerCase())) continue;
    packages.push({ ecosystem: 'nuget', name, path: file.path, line: lineAt(text, match.index), spec: match[2] ?? '', dev: false });
  }
  return packages;
}

export function packagesConfigPackages(file: ManifestFile): DeclaredPackage[] {
  const packages: DeclaredPackage[] = [];
  for (const match of String(file.text).matchAll(/<package\s+([^>]*?)\/?>/g)) {
    const attributes = match[1] ?? '';
    const id = (/\bid\s*=\s*"([^"]+)"/.exec(attributes) || [])[1];
    const version = (/\bversion\s*=\s*"([^"]+)"/.exec(attributes) || [])[1];
    if (!id || !version) continue;
    packages.push({ ecosystem: 'nuget', name: id, path: file.path, line: lineAt(file.text, match.index), spec: version, dev: /developmentDependency\s*=\s*"true"/i.test(attributes) });
  }
  return packages;
}

/* packages.lock.json: per target framework, what was resolved and what each package requires. */
export function nugetLockEntries(text: string): LockReading {
  let lock: unknown = null;
  try { lock = JSON.parse(text); } catch { return { entries: [], roots: null }; }
  const byKey = new Map<string, LockEntry>();
  const roots = new Map<string, LockRoot>();
  for (const framework of Object.values(Object(read(lock, 'dependencies') || {}))) {
    for (const [name, item] of Object.entries(Object(framework || {}))) {
      const resolved = read(item, 'resolved');
      const type = read(item, 'type');
      if (!item || typeof resolved !== 'string' || type === 'Project') continue;
      const key = `${name.toLowerCase()}@${resolved}`;
      if (type === 'Direct') roots.set(name.toLowerCase(), { name, dev: false });
      const known = byKey.get(key);
      const requires = keysOf(read(item, 'dependencies') || {});
      if (known) { known.requires = [...new Set([...known.requires, ...requires])]; continue; }
      const at = text.indexOf(`"${name}": {`);
      byKey.set(key, { name, version: resolved, line: at >= 0 ? lineAt(text, at) : 1, dev: false, top: type === 'Direct', requires });
    }
  }
  return { entries: [...byKey.values()], roots: roots.size ? [...roots.values()] : null };
}

/* ---- Python manifests beyond requirements files ------------------------------- */

const PEP508 = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*([^;]*)/;
export function pyprojectPackages(file: ManifestFile): DeclaredPackage[] {
  const packages: DeclaredPackage[] = [];
  for (const { table, key, value, line } of tomlPairs(file.text)) {
    /* PEP 621: `dependencies = ["requests>=2", ...]`, extras in optional-dependencies. */
    if ((table === 'project' && key === 'dependencies') || table === 'project.optional-dependencies' || table.startsWith('dependency-groups')) {
      const dev = table !== 'project' && /dev|test|lint|doc|type/i.test(`${table}.${key}`);
      for (const item of value.matchAll(/['"]([^'"]+)['"]/g)) {
        const match = PEP508.exec(item[1] ?? '');
        if (match) packages.push({ ecosystem: 'pypi', name: match[1] ?? '', path: file.path, line, spec: (match[3] ?? '').trim(), dev });
      }
      continue;
    }
    /* Poetry: `name = "^1.2"` or `name = { version = "^1.2" }`. */
    const poetry = /^tool\.poetry\.(dependencies|dev-dependencies|group\.[\w-]+\.dependencies)$/.exec(table);
    if (!poetry || key.toLowerCase() === 'python') continue;
    const spec = inlineVersion(value);
    if (spec === null) continue;
    packages.push({ ecosystem: 'pypi', name: key, path: file.path, line, spec, dev: poetry[1] !== 'dependencies' });
  }
  return packages;
}

export function pipfilePackages(file: ManifestFile): DeclaredPackage[] {
  const packages: DeclaredPackage[] = [];
  for (const { table, key, value, line } of tomlPairs(file.text)) {
    if (table !== 'packages' && table !== 'dev-packages') continue;
    const spec = inlineVersion(value);
    if (spec === null) continue;
    packages.push({ ecosystem: 'pypi', name: key, path: file.path, line, spec: spec === '*' ? '' : spec, dev: table === 'dev-packages' });
  }
  return packages;
}

/* ---- Dispatch ------------------------------------------------------------------ */

const base = (filePath: unknown): string => String(filePath).slice(String(filePath).lastIndexOf('/') + 1);

/* Which manifest parser reads a file, by its name. */
export function manifestParserFor(filePath: unknown): ManifestParser | null {
  const name = base(filePath);
  if (name === 'pom.xml') return pomPackages;
  if (name === 'build.gradle' || name === 'build.gradle.kts') return gradlePackages;
  if (name === 'composer.json') return composerJsonPackages;
  if (name === 'Gemfile' || name === 'gems.rb') return gemfilePackages;
  if (name === 'Cargo.toml') return cargoTomlPackages;
  if (/\.(cs|fs|vb)proj$/.test(name) || name === 'Directory.Packages.props') return msbuildPackages;
  if (name === 'packages.config') return packagesConfigPackages;
  if (name === 'pyproject.toml') return pyprojectPackages;
  if (name === 'Pipfile') return pipfilePackages;
  return null;
}

export const LOCKS: Readonly<Record<string, readonly [string, LockParser]>> = Object.freeze({
  'go.mod': ['go', goModEntries],
  'gradle.lockfile': ['maven', gradleLockEntries],
  'composer.lock': ['packagist', composerLockEntries],
  'Gemfile.lock': ['rubygems', gemfileLockEntries],
  'gems.locked': ['rubygems', gemfileLockEntries],
  'Cargo.lock': ['cargo', cargoLockEntries],
  'packages.lock.json': ['nuget', nugetLockEntries]
});

/* The manifests' own ecosystem names, as OSV spells them. */
export const OSV_NAMES: Readonly<Record<string, string>> = Object.freeze({
  npm: 'npm', pypi: 'PyPI', go: 'Go', maven: 'Maven', packagist: 'Packagist', rubygems: 'RubyGems', cargo: 'crates.io', nuget: 'NuGet'
});

/*
 * A package URL (purl) for each ecosystem, the identifier SBOMs and
 * vulnerability databases share. Names are encoded segment by segment.
 */
const PURL_TYPE: Readonly<Record<string, string>> = Object.freeze({ npm: 'npm', pypi: 'pypi', go: 'golang', maven: 'maven', packagist: 'composer', rubygems: 'gem', cargo: 'cargo', nuget: 'nuget' });
export function purl(ecosystem: string, name: string, version?: string | null): string | null {
  const type = ownEntry(PURL_TYPE, ecosystem);
  if (!type) return null;
  const encode = (value: string) => encodeURIComponent(value).replace(/%2F/gi, '/');
  let path;
  if (ecosystem === 'maven') {
    const [group = '', artifact] = String(name).split(':');
    path = `${encode(group)}/${encode(artifact || '')}`;
  } else if (ecosystem === 'npm' && name.startsWith('@')) {
    const [scope = '', rest] = name.split('/');
    path = `${encodeURIComponent(scope)}/${encodeURIComponent(rest || '')}`;
  } else if (ecosystem === 'pypi') {
    path = encodeURIComponent(String(name).toLowerCase().replace(/[-_.]+/g, '-'));
  } else {
    path = String(name).split('/').map(encodeURIComponent).join('/');
  }
  return `pkg:${type}/${path}${version ? `@${encodeURIComponent(version)}` : ''}`;
}
