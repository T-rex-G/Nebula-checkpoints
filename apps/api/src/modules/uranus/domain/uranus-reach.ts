import { ownEntry, read } from '../../../platform/values/fields.ts';

/*
 * Uranus reach: how close a vulnerable dependency is to the running code,
 * and how urgent that makes it.
 *
 * An advisory says a version is vulnerable. It does not say the project uses
 * the package, or uses it where an attacker can reach it, and most
 * vulnerable packages in a lockfile are never loaded by anything that
 * serves a request. Three facts narrow that down without running the code:
 *
 *   - whether the code imports the package, names it where a framework
 *     loads it by name (a view engine, a database dialect, a Django app), or
 *     ships it: handed to a bundler, named as a build's entry or alias, or
 *     served from node_modules;
 *   - for a package nobody imports, which dependency the project asked for
 *     brought it in, and whether the code imports that one;
 *   - whether the only code that touches it is a test, a build script or a
 *     development tool.
 *
 * What it can never do is prove a package unused. Frameworks load packages
 * by convention and a regular expression does not execute anything, so a
 * production dependency with no import found is "installed", not
 * "unreachable", and still counts as reachable wherever a decision depends
 * on it. The words are chosen so the screen never says more than that.
 *
 * Then one number per vulnerable package, 0 to 100, from three factors a
 * reader can check: impact (the advisory's CVSS base score), threat (CISA's
 * catalog of exploited vulnerabilities, else FIRST's EPSS probability on a
 * log scale), and reach (the tier above). Only file paths and package names
 * come out of here; nothing is quoted from a file.
 */

const JS_FILE = /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/i;
const PY_FILE = /\.py$/i;
const JSON_CONFIG = /(^|\/)(\.babelrc|\.eslintrc|\.prettierrc|\.stylelintrc|\.swcrc|\.postcssrc|\.mocharc|\.nycrc|babel\.config|jest\.config|tsconfig[\w.-]*|jsconfig|nodemon|lerna|turbo|nx)(\.json|\.ya?ml)?$/i;
const BUILD_FILE = /(^|\/)((scripts?|tools?|tooling|build-tools|\.storybook|\.github|\.husky|config\/(webpack|jest|babel|vite|rollup))\/|[^/]*\.config\.[cm]?[jt]s$|(gulpfile|gruntfile|webpack\.[\w.-]*|rollup\.[\w.-]*|vite\.[\w.-]*|karma\.[\w.-]*|setup|noxfile|fabfile|tasks|manage)\.(?:[cm]?[jt]s|py)$|docs\/conf\.py$|build\.rs$|(build|settings)\.gradle(\.kts)?$|Rakefile$|[^/]+\.rake$)/i;

/* JavaScript: require, dynamic import, static import and re-export. Bounded so a long line cannot make the search slow. */
const JS_IMPORT = /\brequire(?:\.resolve)?\s*\(\s*(['"`])([^'"`\n]{1,214})\1|\bimport\s*\(\s*(['"`])([^'"`\n]{1,214})\3|\b(?:import|export)\s+(?:type\s+)?(?:[\w*$\s{},]{0,400}?\s*from\s*)?(['"])([^'"\n]{1,214})\5/g;
const JS_STRING = /(['"`])(@?[A-Za-z0-9][\w.-]{0,100}(?:\/[\w.-]{1,100})?)\1/g;
const NODE_MODULES_PATH = /node_modules\/((?:@[\w.-]{1,100}\/)?[\w.-]{1,100})/g;
const MARKUP_FILE = /\.(html?|ejs|hbs|handlebars|pug|jade|njk|twig|dust|liquid|mustache)$/i;
/* Python: `import a.b, c` and `from a.b import c, d`, at the start of a line. */
const PY_IMPORT = /^[ \t]*import[ \t]+([\w.]+(?:[ \t]+as[ \t]+\w+)?(?:[ \t]*,[ \t]*[\w.]+(?:[ \t]+as[ \t]+\w+)?)*)|^[ \t]*from[ \t]+([\w.]+)[ \t]+import[ \t]+\(?([\w \t,]*)/gm;
const PY_STRING = /(['"])([A-Za-z_][\w]{0,60}(?:\.[A-Za-z_]\w{0,60}){0,6})\1/g;

/*
 * The other languages whose packages the advisory lookup covers. Each names
 * a dependency in its own way: Go by module path, Rust by crate, Ruby by
 * require (or all at once, through Bundler.require), PHP by the namespace
 * its package autoloads, the JVM by package, .NET by namespace.
 */
const GO_FILE = /\.go$/;
const GO_IMPORT_BLOCK = /\bimport\s*\(([^)]{0,20000})\)/g;
const GO_IMPORT_LINE = /^[ \t]*import[ \t]+(?:[\w.]+[ \t]+)?"([^"\n]{1,300})"/gm;
const GO_QUOTED = /"([^"\n]{1,300})"/g;
const RUST_FILE = /\.rs$/;
const RUST_USE = /\b(?:use|extern[ \t]+crate)[ \t]+(?:::)?([A-Za-z_]\w{0,80})|\b([a-z_][a-z0-9_]{0,80})::/g;
const RUBY_FILE = /\.(rb|rake|ru)$|(^|\/)Rakefile$/;
const RUBY_REQUIRE = /\brequire[ \t]*\(?[ \t]*['"]([\w/.-]{1,200})['"]/g;
const PHP_FILE = /\.php$/;
const PHP_NAME = /\\?\b([A-Za-z_]\w{0,80}(?:\\[A-Za-z_]\w{0,80}){1,12})/g;
const JVM_FILE = /\.(java|kt|scala|groovy)$/;
const JVM_IMPORT = /^[ \t]*import[ \t]+(?:static[ \t]+)?([\w.]{1,300})/gm;
const DOTNET_FILE = /\.(cs|fs|vb)$/;
const DOTNET_USING = /^[ \t]*(?:global[ \t]+)?(?:using|open|Imports)[ \t]+(?:static[ \t]+)?([A-Za-z_][\w.]{0,300})/gm;

/* The names Ruby code requires a gem by: its own, with dashes as slashes or underscores. */
const RUBY_NAMES: Readonly<Record<string, readonly string[]>> = Object.freeze(Object.assign(Object.create(null), {
  activesupport: ['active_support'], activerecord: ['active_record'], actionpack: ['action_controller', 'action_dispatch'],
  actionview: ['action_view'], activemodel: ['active_model'], actionmailer: ['action_mailer'], activejob: ['active_job'],
  actioncable: ['action_cable'], activestorage: ['active_storage'], railties: ['rails'], rails: ['rails', 'rails/all']
}));
const rubyNames = (name: string): string[] => [...new Set([name, name.replace(/-/g, '/'), name.replace(/-/g, '_'), ...(ownEntry(RUBY_NAMES, name.toLowerCase()) || [])].map(value => value.toLowerCase()))];

/*
 * Distributions whose import name is not their package name. The rest follow
 * the convention: lower case, dashes as underscores, or as dots for a
 * namespace package (google-cloud-storage imports as google.cloud.storage).
 */
const PY_MODULES: Readonly<Record<string, readonly string[]>> = Object.freeze(Object.assign(Object.create(null), {
  pyyaml: ['yaml'], 'beautifulsoup4': ['bs4'], pillow: ['pil'], 'scikit-learn': ['sklearn'], 'scikit-image': ['skimage'],
  'python-dateutil': ['dateutil'], 'opencv-python': ['cv2'], 'opencv-python-headless': ['cv2'], 'opencv-contrib-python': ['cv2'],
  pyjwt: ['jwt'], 'python-jose': ['jose'], pycryptodome: ['crypto'], pycryptodomex: ['cryptodome'], 'python-dotenv': ['dotenv'],
  'psycopg2-binary': ['psycopg2'], 'psycopg-binary': ['psycopg'], djangorestframework: ['rest_framework'], 'django-cors-headers': ['corsheaders'],
  pymongo: ['pymongo', 'bson', 'gridfs'], pyopenssl: ['openssl'], 'python-multipart': ['multipart'], 'protobuf': ['google.protobuf'],
  'google-api-python-client': ['googleapiclient'], 'python-magic': ['magic'], 'python-slugify': ['slugify'], 'pyserial': ['serial'],
  'pywin32': ['win32api', 'win32con', 'pywintypes'], 'python-ldap': ['ldap'], 'mysqlclient': ['mysqldb'], 'pymysql': ['pymysql'],
  'msgpack-python': ['msgpack'], 'attrs': ['attr', 'attrs'], 'setuptools': ['setuptools', 'pkg_resources'], 'pyzmq': ['zmq'],
  'faiss-cpu': ['faiss'], 'faiss-gpu': ['faiss'], 'tensorflow-cpu': ['tensorflow'], 'torch': ['torch'], 'markdown': ['markdown'],
  'ruamel.yaml': ['ruamel.yaml'], 'websocket-client': ['websocket'], 'python-socketio': ['socketio'], 'python-engineio': ['engineio'],
  'flask-sqlalchemy': ['flask_sqlalchemy'], 'flask-cors': ['flask_cors'], 'flask-login': ['flask_login'], 'flask-wtf': ['flask_wtf'],
  'gitpython': ['git'], 'dnspython': ['dns'], 'pycparser': ['pycparser'], 'jinja2': ['jinja2'], 'markupsafe': ['markupsafe'],
  'typing-extensions': ['typing_extensions'], 'importlib-metadata': ['importlib_metadata'], 'pyasn1': ['pyasn1'], 'rsa': ['rsa']
}));

export function pythonModules(name: unknown): string[] {
  const key = String(name).toLowerCase().replace(/[-_.]+/g, '-');
  const known = ownEntry(PY_MODULES, key) || ownEntry(PY_MODULES, String(name).toLowerCase());
  const plain = key.replace(/-/g, '_');
  const dotted = key.replace(/-/g, '.');
  const stripped = key.replace(/-(binary|headless)$/, '').replace(/-/g, '_');
  /* python-docx imports as docx, python-magic as magic. */
  const unprefixed = key.startsWith('python-') ? key.slice(7).replace(/-/g, '_') : null;
  return [...new Set([...(known || []), plain, dotted, stripped, unprefixed].filter((value): value is string => Boolean(value)))];
}

/* The package an import specifier names, or null for a relative path, a built-in scheme or an alias. */
export function jsPackageOf(specifier: unknown): string | null {
  const spec = String(specifier || '');
  if (!spec || /^[./~#]|^[a-z][\w+.-]*:|^@\/|^\$/.test(spec)) return null;
  const scoped = /^(@[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*)/i.exec(spec);
  if (spec.startsWith('@')) return scoped && scoped[1] ? scoped[1].toLowerCase() : null;
  const plain = /^([a-z0-9][\w.-]*)/i.exec(spec);
  return plain && plain[1] ? plain[1].toLowerCase() : null;
}

export type Role = 'runtime' | 'build' | 'test';
type How = 'import' | 'name' | 'bundle';

function roleOf(filePath: string, isTest: (filePath: string) => boolean): Role {
  if (isTest(filePath)) return 'test';
  /* A type declaration never runs. */
  if (/\.d\.[cm]?ts$/i.test(filePath)) return 'build';
  if (BUILD_FILE.test(filePath) || JSON_CONFIG.test(filePath)) return 'build';
  return 'runtime';
}

const ROLES: readonly Role[] = Object.freeze(['runtime', 'build', 'test'] as const);
const HOW_RANK: Readonly<Record<How, number>> = Object.freeze({ import: 0, name: 1, bundle: 2 });

/* Commands whose package has another name, and packages whose `start` is a development server. */
const BINARIES: Readonly<Record<string, string>> = Object.freeze(Object.assign(Object.create(null), {
  ng: '@angular/cli', 'vue-cli-service': '@vue/cli-service', tsc: 'typescript', craco: '@craco/craco', nest: '@nestjs/cli',
  'sequelize-cli': 'sequelize-cli', remix: '@remix-run/dev', playwright: '@playwright/test', 'svelte-kit': '@sveltejs/kit'
}));
/* Words before the command itself. */
const LAUNCHERS: ReadonlySet<string> = new Set(['npx', 'pnpx', 'bunx', 'node', 'cross-env', 'env', 'dotenv', 'exec', 'yarn', 'pnpm', 'npm', 'run', 'bun']);
/* Tools whose arguments become part of what ships. */
const BUNDLERS: ReadonlySet<string> = new Set(['browserify', 'webpack', 'webpack-cli', 'rollup', 'esbuild', 'parcel', 'parcel-bundler', 'vite', 'uglify-js', 'terser', 'ncc', '@vercel/ncc', 'pkg', 'tsup', 'microbundle']);
/* A package that is a build tool by its name: a loader, a plugin, a preset, a compiler. */
const BUILD_TOOL = /(^|[-/])(loader|plugin|plugins|preset|presets|webpack|babel|eslint|postcss|rollup|vite|esbuild|swc|typescript|ts-node|tsconfig|prettier|stylelint|autoprefixer|tailwindcss|sass|less|jest|vitest|mocha)([-/]|$)|^@(babel|swc|rollup|vitejs|typescript-eslint|eslint|types)\//;
const DEV_SERVERS: ReadonlySet<string> = new Set(['react-scripts', 'vite', 'webpack', 'webpack-cli', 'webpack-dev-server', 'parcel', 'parcel-bundler', 'nodemon',
  'ts-node-dev', '@craco/craco', 'react-app-rewired', '@vue/cli-service', '@angular/cli', 'snowpack', 'gatsby', '@remix-run/dev', 'expo']);
const FILES_KEPT = 3;

/*
 * Where each wanted package is imported or named, by role. `wanted` is the
 * short list of vulnerable packages and the dependencies that introduce
 * them, so the scan only ever records a handful of names however large the
 * repository is.
 */
/* Where one package was seen in one role: how, in how many files, and the first few of them. */
export interface RoleUse {
  how: How;
  count: number;
  files: string[];
}
export interface UsageSlot {
  runtime: RoleUse | null;
  build: RoleUse | null;
  test: RoleUse | null;
}
type NativeEcosystem = 'go' | 'cargo' | 'rubygems' | 'packagist' | 'maven' | 'nuget';
export type UsageEcosystem = 'npm' | 'pypi' | NativeEcosystem;
export type UsageMaps = Record<UsageEcosystem, Map<string, UsageSlot>>;
export interface UsageIndex extends UsageMaps {
  bundler: string | null;
  scanned: { javascript: number; python: number };
}

/* A package the audit wants traced: its inventory key, its ecosystem and name, and for PHP the namespaces it autoloads. */
export interface WantedPackage {
  readonly key: string;
  readonly ecosystem: string;
  readonly name: unknown;
  readonly namespaces?: readonly unknown[] | null;
}

/* A file as the audit holds it: its path, and its text when it was read. */
export interface SourceFile {
  readonly path: string;
  readonly text?: unknown;
}

export function usageIndex(files: Iterable<SourceFile>, wanted: Iterable<WantedPackage>, isTest: (filePath: string) => boolean): UsageIndex {
  const npm = new Map<string, UsageSlot>();
  const pypi = new Map<string, UsageSlot>();
  const maps: UsageMaps = { npm, pypi, go: new Map(), cargo: new Map(), rubygems: new Map(), packagist: new Map(), maven: new Map(), nuget: new Map() };
  const want = {
    npm: new Set<string>(), pypi: new Map<string, string>(),
    go: new Map<string, Set<string>>(), cargo: new Map<string, Set<string>>(), rubygems: new Map<string, Set<string>>(),
    packagist: new Map<string, Set<string>>(), maven: new Map<string, Set<string>>(), nuget: new Map<string, Set<string>>()
  };
  const add = (map: Map<string, Set<string>>, name: string, key: string) => {
    let keys = map.get(name);
    if (!keys) { keys = new Set(); map.set(name, keys); }
    keys.add(key);
  };
  for (const item of wanted) {
    const name = String(item.name);
    switch (item.ecosystem) {
      case 'npm': want.npm.add(item.key); break;
      case 'pypi': for (const module of pythonModules(name)) want.pypi.set(module, item.key); break;
      case 'go': add(want.go, name.toLowerCase(), item.key); break;
      case 'cargo': add(want.cargo, name.toLowerCase().replace(/-/g, '_'), item.key); break;
      case 'rubygems': for (const required of rubyNames(name)) add(want.rubygems, required, item.key); break;
      case 'packagist': for (const space of item.namespaces || []) add(want.packagist, String(space).toLowerCase().replace(/\\+$/, ''), item.key); break;
      case 'maven': {
        /* A package is imported by the packages under its group, or under the group's first three parts. */
        const group = (name.split(':')[0] ?? '').toLowerCase();
        add(want.maven, group, item.key);
        const parts = group.split('.');
        if (parts.length > 3) add(want.maven, parts.slice(0, 3).join('.'), item.key);
        break;
      }
      case 'nuget': add(want.nuget, name.toLowerCase(), item.key); break;
      default: break;
    }
  }
  const NATIVE: readonly NativeEcosystem[] = ['go', 'cargo', 'rubygems', 'packagist', 'maven', 'nuget'];
  const nativeWanted = NATIVE.some(ecosystem => want[ecosystem].size);
  /* The longest prefix of a dotted, slashed or back-slashed name that names a wanted package. */
  const byPrefix = (map: Map<string, Set<string>>, value: unknown, separator: string): Set<string> | null => {
    const parts = String(value).toLowerCase().split(separator);
    for (let size = parts.length; size > 0; size -= 1) {
      const keys = map.get(parts.slice(0, size).join(separator));
      if (keys) return keys;
    }
    return null;
  };
  let bundler: string | null = null;
  const record = (map: Map<string, UsageSlot>, key: string, role: Role, how: How, filePath: string) => {
    let slot = map.get(key);
    if (!slot) { slot = { runtime: null, build: null, test: null }; map.set(key, slot); }
    const byRole = slot[role] || (slot[role] = { how, count: 0, files: [] });
    /* The strongest evidence names the role: an import, then a name, then a bundle. */
    if (HOW_RANK[how] < HOW_RANK[byRole.how]) byRole.how = how;
    if (!byRole.files.includes(filePath)) {
      byRole.count += 1;
      if (byRole.files.length < FILES_KEPT) byRole.files.push(filePath);
    }
  };
  const pythonMatch = (dotted: unknown): string | null => {
    const parts = String(dotted).toLowerCase().split('.');
    for (let size = parts.length; size > 0; size -= 1) {
      const key = want.pypi.get(parts.slice(0, size).join('.'));
      if (key) return key;
    }
    return null;
  };
  /* A path into node_modules is a package served or bundled from where it was installed: it ships. */
  const shipped = (text: string, role: Role, filePath: string) => {
    if (role === 'test') return;
    for (const match of text.matchAll(NODE_MODULES_PATH)) {
      const name = jsPackageOf(match[1]);
      if (name && want.npm.has(name)) record(npm, name, 'runtime', 'bundle', filePath);
    }
  };
  let js = 0;
  let py = 0;
  for (const file of files) {
    const text = file.text;
    if (typeof text !== 'string') continue;
    const role = roleOf(file.path, isTest);
    if (JS_FILE.test(file.path) && want.npm.size) {
      js += 1;
      /* Where each import's specifier opens, so the string pass below does not count it a second time. */
      const specifiers = new Set<number>();
      for (const match of text.matchAll(JS_IMPORT)) {
        const specifier = match[2] || match[4] || match[6] || '';
        specifiers.add(match.index + match[0].lastIndexOf(specifier) - 1);
        const name = jsPackageOf(specifier);
        if (name && want.npm.has(name)) record(npm, name, role, 'import', file.path);
      }
      for (const match of text.matchAll(JS_STRING)) {
        if (specifiers.has(match.index)) continue;
        const named = match[2] ?? '';
        const name = jsPackageOf(named);
        if (!name || !want.npm.has(name) || !(named.toLowerCase() === name || named.toLowerCase().startsWith(`${name}/`))) continue;
        /*
         * In build configuration a name is either a tool (a loader, a plugin,
         * a preset) or what the build bundles (an entry, a provided global,
         * an alias), and what is bundled ships. Only a tool's name is build.
         */
        if (role === 'build' && !BUILD_TOOL.test(name)) record(npm, name, 'runtime', 'bundle', file.path);
        else record(npm, name, role, 'name', file.path);
      }
      shipped(text, role, file.path);
    } else if (JSON_CONFIG.test(file.path) && want.npm.size) {
      /* A tool's own configuration names its presets and plugins. */
      for (const match of text.matchAll(JS_STRING)) {
        const named = match[2] ?? '';
        const name = jsPackageOf(named);
        if (name && want.npm.has(name) && (named.toLowerCase() === name || named.toLowerCase().startsWith(`${name}/`))) record(npm, name, role === 'test' ? 'test' : 'build', 'name', file.path);
      }
    } else if (MARKUP_FILE.test(file.path) && want.npm.size) {
      shipped(text, role, file.path);
    } else if (/(^|\/)package\.json$/.test(file.path) && want.npm.size) {
      let manifest: unknown = null;
      try { manifest = JSON.parse(text); } catch { manifest = null; }
      const declared = read(manifest, 'scripts');
      const scripts = manifest && declared && typeof declared === 'object' ? declared : {};
      for (const [script, command] of Object.entries(scripts)) {
        const serves = /^(start|serve|server|prod|production)(:|$)/.test(script);
        for (const segment of String(command).split(/&&|\|\||[;|]/)) {
          const words = segment.trim().split(/\s+/).filter(word => word && !/^[A-Z_][A-Z0-9_]*=/.test(word));
          while (words[0] !== undefined && LAUNCHERS.has(words[0])) words.shift();
          const first = words[0];
          const tool = first !== undefined ? ownEntry(BINARIES, first) || jsPackageOf(first) : null;
          /* `start` runs in production -- unless what it starts is a development server. */
          if (tool && want.npm.has(tool)) record(npm, tool, serves && !DEV_SERVERS.has(tool) ? 'runtime' : 'build', 'name', file.path);
          /* What a bundler is handed goes into the bundle, and the bundle ships. */
          if (!tool || !BUNDLERS.has(tool)) continue;
          for (const word of words.slice(1)) {
            const name = word.startsWith('-') || word.startsWith('>') ? null : jsPackageOf(word.replace(/^['"]|['"]$/g, ''));
            if (name && want.npm.has(name) && name !== tool) record(npm, name, 'runtime', 'bundle', file.path);
          }
        }
      }
    } else if (PY_FILE.test(file.path) && want.pypi.size) {
      py += 1;
      for (const match of text.matchAll(PY_IMPORT)) {
        const modules = match[1]
          ? match[1].split(',').map(part => part.trim().split(/\s+/)[0])
          : [match[2], ...String(match[3] || '').split(',').map(part => part.trim().split(/\s+/)[0]).filter(Boolean).map(name => `${String(match[2])}.${String(name)}`)];
        for (const module of modules) {
          if (!module || module.startsWith('.')) continue;
          const key = pythonMatch(module);
          if (key) record(pypi, key, role, 'import', file.path);
        }
      }
      for (const match of text.matchAll(PY_STRING)) {
        const key = pythonMatch(match[2]);
        if (key) record(pypi, key, role, 'name', file.path);
      }
    } else if (nativeWanted) {
      const hit = (ecosystem: NativeEcosystem, keys: Iterable<string> | null | undefined, how: How = 'import') => { for (const key of keys || []) record(maps[ecosystem], key, role, how, file.path); };
      if (GO_FILE.test(file.path) && want.go.size) {
        for (const block of text.matchAll(GO_IMPORT_BLOCK)) for (const quoted of (block[1] ?? '').matchAll(GO_QUOTED)) hit('go', byPrefix(want.go, quoted[1], '/'));
        for (const match of text.matchAll(GO_IMPORT_LINE)) hit('go', byPrefix(want.go, match[1], '/'));
      } else if (RUST_FILE.test(file.path) && want.cargo.size) {
        for (const match of text.matchAll(RUST_USE)) hit('cargo', want.cargo.get(String(match[1] || match[2]).toLowerCase()));
      } else if (RUBY_FILE.test(file.path) && (want.rubygems.size)) {
        for (const match of text.matchAll(RUBY_REQUIRE)) {
          const required = (match[1] ?? '').toLowerCase();
          hit('rubygems', want.rubygems.get(required) || want.rubygems.get(required.split('/')[0] ?? ''));
        }
        /* Bundler.require loads every gem the Gemfile lists for the running environment. */
        if (!bundler && role === 'runtime' && /\bBundler\.require\b/.test(text)) bundler = file.path;
      } else if (PHP_FILE.test(file.path) && want.packagist.size) {
        for (const match of text.matchAll(PHP_NAME)) hit('packagist', byPrefix(want.packagist, match[1], '\\'));
      } else if (JVM_FILE.test(file.path) && want.maven.size) {
        for (const match of text.matchAll(JVM_IMPORT)) hit('maven', byPrefix(want.maven, match[1], '.'));
      } else if (DOTNET_FILE.test(file.path) && want.nuget.size) {
        for (const match of text.matchAll(DOTNET_USING)) {
          const space = (match[1] ?? '').toLowerCase().replace(/\.$/, '');
          hit('nuget', byPrefix(want.nuget, space, '.'));
          /* A namespace that only opens a package's name: the package extends it (a provider, an adapter). */
          for (const [id, keys] of want.nuget) if (id.startsWith(`${space}.`)) hit('nuget', keys, 'name');
        }
      }
    }
  }
  return { ...maps, bundler, scanned: { javascript: js, python: py } };
}

/*
 * The tiers, closest to a request first. `production` marks every tier a
 * decision must treat as reachable: nothing below it was proved unused.
 */
export type Tier = 'imported' | 'named' | 'bundled' | 'transitive' | 'unknown' | 'installed' | 'build' | 'test' | 'dev';
export const TIERS: Readonly<Record<Tier, { readonly factor: number; readonly production: boolean }>> = Object.freeze({
  imported: { factor: 1, production: true },
  named: { factor: 0.95, production: true },
  bundled: { factor: 0.95, production: true },
  transitive: { factor: 0.9, production: true },
  unknown: { factor: 0.8, production: true },
  installed: { factor: 0.75, production: true },
  build: { factor: 0.55, production: false },
  test: { factor: 0.5, production: false },
  dev: { factor: 0.45, production: false }
});

const RUNTIME_TIER: Readonly<Record<How, Tier>> = Object.freeze({ import: 'imported', name: 'named', bundle: 'bundled' });
const firstRole = (slot: UsageSlot | null | undefined): Role | null => ROLES.find(role => slot && slot[role]) || null;

/* A tier by own name; any other value, a name inherited from Object.prototype included, is not one. */
function tierEntry(tier: unknown): { readonly factor: number; readonly production: boolean } | undefined {
  return typeof tier === 'string' ? ownEntry(TIERS, tier) : undefined;
}

/*
 * How one vulnerable package is reached. `entry` is its inventory entry,
 * `usage` the index above, `through` what introducedThrough found (null when
 * the lockfile records no requirements), `unseen` whether source files of
 * its language went unread, which turns "no import found" into "unknown".
 *
 * Only positive evidence lowers a tier: a development dependency, or a
 * package only build tooling references. A production dependency that only
 * tests import is still installed where the application runs, so it stays
 * "installed", with the tests named as what was seen.
 */
const NO_USE: ReadonlyMap<string, UsageSlot> = new Map();

/* An inventory entry as the tiers read it. */
export interface TierEntry {
  readonly ecosystem: string;
  readonly name?: unknown;
  readonly direct?: boolean;
  readonly dev?: boolean;
}
export interface Introduction {
  readonly roots: readonly { readonly name: string; readonly dev?: boolean }[];
  readonly chain: unknown;
}
export interface TierReading {
  tier: Tier;
  files?: string[];
  count?: number;
  seen?: Role;
  reason?: 'unread' | 'graph';
  through?: string[];
  throughCount?: number;
  chain?: unknown;
  loader?: 'bundler';
}
export interface TierInput {
  readonly entry: TierEntry;
  readonly key: string;
  readonly usage: UsageIndex;
  readonly through: Introduction | null | undefined;
  readonly unseen?: boolean;
  readonly keyOf?: ((ecosystem: string, name: string) => string) | null;
}

function usageMap(usage: UsageIndex, ecosystem: string): ReadonlyMap<string, UsageSlot> | undefined {
  switch (ecosystem) {
    case 'npm': case 'pypi': case 'go': case 'cargo': case 'rubygems': case 'packagist': case 'maven': case 'nuget':
      return usage[ecosystem];
    default:
      return undefined;
  }
}

export function tierOf({ entry, key, usage, through, unseen, keyOf: nameKeyOf }: TierInput): TierReading {
  const map = usageMap(usage, entry.ecosystem) || NO_USE;
  const own = map.get(key) || null;
  const files = (role: Role): { files: string[]; count: number } => {
    const use = own ? own[role] : null;
    return use ? { files: use.files, count: use.count } : { files: [], count: 0 };
  };
  if (own && own.runtime) return { tier: RUNTIME_TIER[own.runtime.how] || 'named', ...files('runtime') };
  const seen: Role | null = own && own.build ? 'build' : own && own.test ? 'test' : null;
  const hint: { files: string[]; count: number; seen?: Role } = seen ? { ...files(seen), seen } : { files: [], count: 0 };
  const quiet: TierReading = unseen ? { tier: 'unknown', reason: 'unread' } : { tier: 'installed' };
  if (!entry.direct && through && through.roots.length) {
    const keyOf = (root: { readonly name: string }) => (nameKeyOf ? nameKeyOf(entry.ecosystem, root.name)
      : entry.ecosystem === 'pypi' ? String(root.name).toLowerCase().replace(/[-_.]+/g, '-') : String(root.name).toLowerCase());
    const live = through.roots.filter(root => { const slot = map.get(keyOf(root)); return slot && slot.runtime; });
    const shown = live.length ? live : through.roots;
    const base = { through: shown.slice(0, 3).map(root => root.name), throughCount: shown.length, chain: through.chain };
    if (live.length) return { tier: 'transitive', files: [], count: 0, ...base };
    if (entry.dev || through.roots.every(root => root.dev)) return { tier: 'dev', ...hint, ...base };
    if (through.roots.every(root => root.dev || firstRole(map.get(keyOf(root))) === 'build')) return { tier: 'build', ...hint, ...base };
    return { ...quiet, ...hint, ...base };
  }
  if (entry.dev) return { tier: 'dev', ...hint };
  if (seen === 'build') return { tier: 'build', ...hint };
  /* A gem the Gemfile lists for production, where the application calls Bundler.require: it is loaded at boot. */
  if (entry.ecosystem === 'rubygems' && entry.direct && usage.bundler) return { tier: 'named', files: [usage.bundler], count: 1, loader: 'bundler' };
  if (!entry.direct && !through) {
    if (seen === 'test') return { tier: 'test', ...hint };
    return { tier: 'unknown', reason: 'graph', ...hint };
  }
  return { ...quiet, ...hint };
}

/* EPSS on a log scale: one in ten thousand is near zero, one in a hundred about a third, a half nearly all. */
/* What the exploit intelligence says of one vulnerability: listed by CISA as exploited, and its EPSS score. */
export interface ThreatIntel {
  readonly exploited?: unknown;
  readonly epss?: { readonly score?: unknown } | null;
}

export function threatOf(intel: ThreatIntel | null | undefined): number {
  if (intel && intel.exploited) return 1;
  const score = intel && intel.epss ? intel.epss.score : undefined;
  if (typeof score === 'number' && Number.isFinite(score)) return Math.min(1, Math.log10(1 + 999 * score) / 3);
  /* Unscored or unknown: neither reassuring nor alarming. */
  return 0.35;
}
const IMPACT: Readonly<Record<'critical' | 'serious' | 'warning', number>> = Object.freeze({ critical: 0.95, serious: 0.75, warning: 0.5 });
export type Band = 'urgent' | 'high' | 'moderate' | 'low';
export const BANDS: readonly (readonly [Band, number])[] = Object.freeze([['urgent', 80], ['high', 60], ['moderate', 35], ['low', 0]]);

/*
 * The risk of one vulnerable package, 0 to 100:
 *
 *   (40 x impact + 60 x threat) x reach x certainty
 *
 * where impact is the highest CVSS base score over ten (or the severity
 * when no score was published), threat is 1 for a vulnerability CISA lists
 * as exploited and otherwise EPSS on the scale above, reach is the tier's
 * factor, and certainty is lower only when a declared range admits a fixed
 * version, so the installed version may not be affected at all. A known
 * exploited vulnerability in anything that ships is never below 80, and a
 * known-malicious package is 100.
 */
export interface RiskInput {
  readonly severity?: unknown;
  readonly cvss?: unknown;
  readonly intel?: ThreatIntel | null;
  readonly tier?: unknown;
  readonly malicious?: unknown;
  readonly certainty?: number;
}
export interface Risk {
  readonly score: number;
  readonly band: Band;
  readonly factors: { readonly impact: number; readonly threat: number; readonly reach: number };
}

export function riskOf({ severity, cvss, intel, tier, malicious, certainty = 1 }: RiskInput): Risk {
  if (malicious) return { score: 100, band: 'urgent', factors: { impact: 1, threat: 1, reach: 1 } };
  const impact = typeof cvss === 'number' && Number.isFinite(cvss) ? Math.max(0, Math.min(10, cvss)) / 10 : (typeof severity === 'string' && ownEntry(IMPACT, severity)) || IMPACT.serious;
  const threat = threatOf(intel);
  const reach = (tierEntry(tier) || TIERS.unknown).factor;
  let score = Math.round((40 * impact + 60 * threat) * reach * certainty);
  if (intel && intel.exploited && (tierEntry(tier) || TIERS.unknown).production && certainty === 1) score = Math.max(score, 80);
  score = Math.max(0, Math.min(100, score));
  const band = (BANDS.find(([, floor]) => score >= floor) ?? ['low', 0])[0];
  const round = (value: number) => Math.round(value * 100) / 100;
  return { score, band, factors: { impact: round(impact), threat: round(threat), reach } };
}

/*
 * A vulnerability CISA lists as exploited, in something that ships. A range
 * that already admits the fixed version is not one: what installs may be fixed.
 */
export function exploitedInProduction(finding: unknown): boolean {
  const detail = read(finding, 'detail');
  const usage = read(detail, 'usage');
  return Boolean(read(finding, 'rule') !== 'DEP-005' && detail && read(read(detail, 'intel'), 'exploited') && usage && (tierEntry(read(usage, 'tier')) || TIERS.unknown).production);
}
