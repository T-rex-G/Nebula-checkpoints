'use strict';

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
const BUILD_FILE = /(^|\/)((scripts?|tools?|tooling|build-tools|\.storybook|\.github|\.husky|config\/(webpack|jest|babel|vite|rollup))\/|[^/]*\.config\.[cm]?[jt]s$|(gulpfile|gruntfile|webpack\.[\w.-]*|rollup\.[\w.-]*|vite\.[\w.-]*|karma\.[\w.-]*|setup|noxfile|fabfile|tasks|manage)\.(?:[cm]?[jt]s|py)$|docs\/conf\.py$)/i;

/* JavaScript: require, dynamic import, static import and re-export. Bounded so a long line cannot make the search slow. */
const JS_IMPORT = /\brequire(?:\.resolve)?\s*\(\s*(['"`])([^'"`\n]{1,214})\1|\bimport\s*\(\s*(['"`])([^'"`\n]{1,214})\3|\b(?:import|export)\s+(?:type\s+)?(?:[\w*$\s{},]{0,400}?\s*from\s*)?(['"])([^'"\n]{1,214})\5/g;
const JS_STRING = /(['"`])(@?[A-Za-z0-9][\w.-]{0,100}(?:\/[\w.-]{1,100})?)\1/g;
const NODE_MODULES_PATH = /node_modules\/((?:@[\w.-]{1,100}\/)?[\w.-]{1,100})/g;
const MARKUP_FILE = /\.(html?|ejs|hbs|handlebars|pug|jade|njk|twig|dust|liquid|mustache)$/i;
/* Python: `import a.b, c` and `from a.b import c, d`, at the start of a line. */
const PY_IMPORT = /^[ \t]*import[ \t]+([\w.]+(?:[ \t]+as[ \t]+\w+)?(?:[ \t]*,[ \t]*[\w.]+(?:[ \t]+as[ \t]+\w+)?)*)|^[ \t]*from[ \t]+([\w.]+)[ \t]+import[ \t]+\(?([\w \t,]*)/gm;
const PY_STRING = /(['"])([A-Za-z_][\w]{0,60}(?:\.[A-Za-z_]\w{0,60}){0,6})\1/g;

/*
 * Distributions whose import name is not their package name. The rest follow
 * the convention: lower case, dashes as underscores, or as dots for a
 * namespace package (google-cloud-storage imports as google.cloud.storage).
 */
const PY_MODULES = Object.freeze({
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
});

function pythonModules(name) {
  const key = String(name).toLowerCase().replace(/[-_.]+/g, '-');
  const known = PY_MODULES[key] || PY_MODULES[String(name).toLowerCase()];
  const plain = key.replace(/-/g, '_');
  const dotted = key.replace(/-/g, '.');
  const stripped = key.replace(/-(binary|headless)$/, '').replace(/-/g, '_');
  /* python-docx imports as docx, python-magic as magic. */
  const unprefixed = key.startsWith('python-') ? key.slice(7).replace(/-/g, '_') : null;
  return [...new Set([...(known || []), plain, dotted, stripped, unprefixed].filter(Boolean))];
}

/* The package an import specifier names, or null for a relative path, a built-in scheme or an alias. */
function jsPackageOf(specifier) {
  const spec = String(specifier || '');
  if (!spec || /^[./~#]|^[a-z][\w+.-]*:|^@\/|^\$/.test(spec)) return null;
  const scoped = /^(@[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*)/i.exec(spec);
  if (spec.startsWith('@')) return scoped ? scoped[1].toLowerCase() : null;
  const plain = /^([a-z0-9][\w.-]*)/i.exec(spec);
  return plain ? plain[1].toLowerCase() : null;
}

function roleOf(filePath, isTest) {
  if (isTest(filePath)) return 'test';
  /* A type declaration never runs. */
  if (/\.d\.[cm]?ts$/i.test(filePath)) return 'build';
  if (BUILD_FILE.test(filePath) || JSON_CONFIG.test(filePath)) return 'build';
  return 'runtime';
}

const ROLES = Object.freeze(['runtime', 'build', 'test']);
const HOW_RANK = Object.freeze({ import: 0, name: 1, bundle: 2 });

/* Commands whose package has another name, and packages whose `start` is a development server. */
const BINARIES = Object.freeze({
  ng: '@angular/cli', 'vue-cli-service': '@vue/cli-service', tsc: 'typescript', craco: '@craco/craco', nest: '@nestjs/cli',
  'sequelize-cli': 'sequelize-cli', remix: '@remix-run/dev', playwright: '@playwright/test', 'svelte-kit': '@sveltejs/kit'
});
/* Words before the command itself. */
const LAUNCHERS = new Set(['npx', 'pnpx', 'bunx', 'node', 'cross-env', 'env', 'dotenv', 'exec', 'yarn', 'pnpm', 'npm', 'run', 'bun']);
/* Tools whose arguments become part of what ships. */
const BUNDLERS = new Set(['browserify', 'webpack', 'webpack-cli', 'rollup', 'esbuild', 'parcel', 'parcel-bundler', 'vite', 'uglify-js', 'terser', 'ncc', '@vercel/ncc', 'pkg', 'tsup', 'microbundle']);
/* A package that is a build tool by its name: a loader, a plugin, a preset, a compiler. */
const BUILD_TOOL = /(^|[-/])(loader|plugin|plugins|preset|presets|webpack|babel|eslint|postcss|rollup|vite|esbuild|swc|typescript|ts-node|tsconfig|prettier|stylelint|autoprefixer|tailwindcss|sass|less|jest|vitest|mocha)([-/]|$)|^@(babel|swc|rollup|vitejs|typescript-eslint|eslint|types)\//;
const DEV_SERVERS = new Set(['react-scripts', 'vite', 'webpack', 'webpack-cli', 'webpack-dev-server', 'parcel', 'parcel-bundler', 'nodemon',
  'ts-node-dev', '@craco/craco', 'react-app-rewired', '@vue/cli-service', '@angular/cli', 'snowpack', 'gatsby', '@remix-run/dev', 'expo']);
const FILES_KEPT = 3;

/*
 * Where each wanted package is imported or named, by role. `wanted` is the
 * short list of vulnerable packages and the dependencies that introduce
 * them, so the scan only ever records a handful of names however large the
 * repository is.
 */
function usageIndex(files, wanted, isTest) {
  const npm = new Map();
  const pypi = new Map();
  const want = { npm: new Set(), pypi: new Map() };
  for (const item of wanted) {
    if (item.ecosystem === 'npm') want.npm.add(item.key);
    else for (const module of pythonModules(item.name)) want.pypi.set(module, item.key);
  }
  const record = (map, key, role, how, filePath) => {
    if (!map.has(key)) map.set(key, { runtime: null, build: null, test: null });
    const slot = map.get(key);
    const byRole = slot[role] || (slot[role] = { how, count: 0, files: [] });
    /* The strongest evidence names the role: an import, then a name, then a bundle. */
    if (HOW_RANK[how] < HOW_RANK[byRole.how]) byRole.how = how;
    if (!byRole.files.includes(filePath)) {
      byRole.count += 1;
      if (byRole.files.length < FILES_KEPT) byRole.files.push(filePath);
    }
  };
  const pythonMatch = dotted => {
    const parts = String(dotted).toLowerCase().split('.');
    for (let size = parts.length; size > 0; size -= 1) {
      const key = want.pypi.get(parts.slice(0, size).join('.'));
      if (key) return key;
    }
    return null;
  };
  /* A path into node_modules is a package served or bundled from where it was installed: it ships. */
  const shipped = (text, role, filePath) => {
    if (role === 'test') return;
    for (const match of text.matchAll(NODE_MODULES_PATH)) {
      const name = jsPackageOf(match[1]);
      if (name && want.npm.has(name)) record(npm, name, 'runtime', 'bundle', filePath);
    }
  };
  let js = 0;
  let py = 0;
  for (const file of files) {
    if (typeof file.text !== 'string') continue;
    const role = roleOf(file.path, isTest);
    if (JS_FILE.test(file.path) && want.npm.size) {
      js += 1;
      /* Where each import's specifier opens, so the string pass below does not count it a second time. */
      const specifiers = new Set();
      for (const match of file.text.matchAll(JS_IMPORT)) {
        const specifier = match[2] || match[4] || match[6];
        specifiers.add(match.index + match[0].lastIndexOf(specifier) - 1);
        const name = jsPackageOf(specifier);
        if (name && want.npm.has(name)) record(npm, name, role, 'import', file.path);
      }
      for (const match of file.text.matchAll(JS_STRING)) {
        if (specifiers.has(match.index)) continue;
        const name = jsPackageOf(match[2]);
        if (!name || !want.npm.has(name) || !(match[2].toLowerCase() === name || match[2].toLowerCase().startsWith(`${name}/`))) continue;
        /*
         * In build configuration a name is either a tool (a loader, a plugin,
         * a preset) or what the build bundles (an entry, a provided global,
         * an alias), and what is bundled ships. Only a tool's name is build.
         */
        if (role === 'build' && !BUILD_TOOL.test(name)) record(npm, name, 'runtime', 'bundle', file.path);
        else record(npm, name, role, 'name', file.path);
      }
      shipped(file.text, role, file.path);
    } else if (JSON_CONFIG.test(file.path) && want.npm.size) {
      /* A tool's own configuration names its presets and plugins. */
      for (const match of file.text.matchAll(JS_STRING)) {
        const name = jsPackageOf(match[2]);
        if (name && want.npm.has(name) && (match[2].toLowerCase() === name || match[2].toLowerCase().startsWith(`${name}/`))) record(npm, name, role === 'test' ? 'test' : 'build', 'name', file.path);
      }
    } else if (MARKUP_FILE.test(file.path) && want.npm.size) {
      shipped(file.text, role, file.path);
    } else if (/(^|\/)package\.json$/.test(file.path) && want.npm.size) {
      let manifest = null;
      try { manifest = JSON.parse(file.text); } catch { manifest = null; }
      const scripts = manifest && manifest.scripts && typeof manifest.scripts === 'object' ? manifest.scripts : {};
      for (const [script, command] of Object.entries(scripts)) {
        const serves = /^(start|serve|server|prod|production)(:|$)/.test(script);
        for (const segment of String(command).split(/&&|\|\||[;|]/)) {
          const words = segment.trim().split(/\s+/).filter(word => word && !/^[A-Z_][A-Z0-9_]*=/.test(word));
          while (words.length && LAUNCHERS.has(words[0])) words.shift();
          const tool = words.length ? BINARIES[words[0]] || jsPackageOf(words[0]) : null;
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
      for (const match of file.text.matchAll(PY_IMPORT)) {
        const modules = match[1]
          ? match[1].split(',').map(part => part.trim().split(/\s+/)[0])
          : [match[2], ...String(match[3] || '').split(',').map(part => part.trim().split(/\s+/)[0]).filter(Boolean).map(name => `${match[2]}.${name}`)];
        for (const module of modules) {
          if (!module || module.startsWith('.')) continue;
          const key = pythonMatch(module);
          if (key) record(pypi, key, role, 'import', file.path);
        }
      }
      for (const match of file.text.matchAll(PY_STRING)) {
        const key = pythonMatch(match[2]);
        if (key) record(pypi, key, role, 'name', file.path);
      }
    }
  }
  return { npm, pypi, scanned: { javascript: js, python: py } };
}

/*
 * The tiers, closest to a request first. `production` marks every tier a
 * decision must treat as reachable: nothing below it was proved unused.
 */
const TIERS = Object.freeze({
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

const RUNTIME_TIER = Object.freeze({ import: 'imported', name: 'named', bundle: 'bundled' });
const firstRole = slot => ROLES.find(role => slot && slot[role]) || null;

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
function tierOf({ entry, key, usage, through, unseen }) {
  const map = entry.ecosystem === 'pypi' ? usage.pypi : usage.npm;
  const own = map.get(key) || null;
  const files = role => (own && own[role] ? { files: own[role].files, count: own[role].count } : { files: [], count: 0 });
  if (own && own.runtime) return { tier: RUNTIME_TIER[own.runtime.how] || 'named', ...files('runtime') };
  const seen = own && own.build ? 'build' : own && own.test ? 'test' : null;
  const hint = seen ? { ...files(seen), seen } : { files: [], count: 0 };
  const quiet = unseen ? { tier: 'unknown', reason: 'unread' } : { tier: 'installed' };
  if (!entry.direct && through && through.roots.length) {
    const keyOf = root => (entry.ecosystem === 'pypi' ? String(root.name).toLowerCase().replace(/[-_.]+/g, '-') : String(root.name).toLowerCase());
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
  if (!entry.direct && !through) {
    if (seen === 'test') return { tier: 'test', ...hint };
    return { tier: 'unknown', reason: 'graph', ...hint };
  }
  return { ...quiet, ...hint };
}

/* EPSS on a log scale: one in ten thousand is near zero, one in a hundred about a third, a half nearly all. */
function threatOf(intel) {
  if (intel && intel.exploited) return 1;
  if (intel && intel.epss && Number.isFinite(intel.epss.score)) return Math.min(1, Math.log10(1 + 999 * intel.epss.score) / 3);
  /* Unscored or unknown: neither reassuring nor alarming. */
  return 0.35;
}
const IMPACT = Object.freeze({ critical: 0.95, serious: 0.75, warning: 0.5 });
const BANDS = Object.freeze([['urgent', 80], ['high', 60], ['moderate', 35], ['low', 0]]);

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
function riskOf({ severity, cvss, intel, tier, malicious, certainty = 1 }) {
  if (malicious) return { score: 100, band: 'urgent', factors: { impact: 1, threat: 1, reach: 1 } };
  const impact = Number.isFinite(cvss) ? Math.max(0, Math.min(10, cvss)) / 10 : IMPACT[severity] || IMPACT.serious;
  const threat = threatOf(intel);
  const reach = (TIERS[tier] || TIERS.unknown).factor;
  let score = Math.round((40 * impact + 60 * threat) * reach * certainty);
  if (intel && intel.exploited && (TIERS[tier] || TIERS.unknown).production && certainty === 1) score = Math.max(score, 80);
  score = Math.max(0, Math.min(100, score));
  const band = BANDS.find(([, floor]) => score >= floor)[0];
  const round = value => Math.round(value * 100) / 100;
  return { score, band, factors: { impact: round(impact), threat: round(threat), reach } };
}

/*
 * A vulnerability CISA lists as exploited, in something that ships. A range
 * that already admits the fixed version is not one: what installs may be fixed.
 */
function exploitedInProduction(finding) {
  const detail = finding && finding.detail;
  return Boolean(finding.rule !== 'DEP-005' && detail && detail.intel && detail.intel.exploited && detail.usage && (TIERS[detail.usage.tier] || TIERS.unknown).production);
}

module.exports = Object.freeze({ usageIndex, tierOf, riskOf, threatOf, jsPackageOf, pythonModules, exploitedInProduction, TIERS, BANDS });
