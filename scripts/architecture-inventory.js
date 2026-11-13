'use strict';
/*
 * The architecture mission's baseline inventory, generated from git rather
 * than written by hand: every file in the baseline tree with its class, the
 * module that will own it, and the evidence that it is (or is not) in use; the
 * backend dependency graph; the browser's global surface; and the residue
 * register that the cleanup phase works from.
 *
 *   node scripts/architecture-inventory.js            write the outputs
 *   node scripts/architecture-inventory.js --check    fail if they would change
 *
 * The baseline is the commit the mission started from, read with `git show`,
 * so the inventory describes that tree however far the working tree has moved.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const BASELINE = '3bf017a8cdb11e8ef86af7ff857add9b61b6f242';
const OUT = path.join(ROOT, 'docs', 'architecture', 'mission');

const CLASSES = Object.freeze([
  'ACTIVE', 'IMMUTABLE_HISTORY', 'FIXTURE', 'VENDOR', 'GENERATED',
  'DUPLICATE_VERIFIED', 'UNREFERENCED_VERIFIED', 'UNKNOWN'
]);

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function baselineFiles() {
  return git('ls-tree', '-r', '--name-only', BASELINE).split('\n').filter(Boolean).sort();
}

function baselineText(file) {
  return execFileSync('git', ['show', `${BASELINE}:${file}`], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
}

const TEXT = /\.(js|json|md|html|css|yml|yaml|sql|txt|webmanifest|sh|svg)$|^\.|\/\.[^/]+$/;

/*
 * Owners follow the dependency map in the mission plan: the six systems, the
 * shared platform, the browser application and the tooling that qualifies it.
 */
const OWNER_RULES = [
  [/^src\/governance-|^src\/control-catalog|^src\/code-audit-policy|^public\/governance-ui/, 'kepler'],
  [/^src\/(exposure-|credential-verification|anonymous-readability-probe|secret-scanner|supabase-key-kinds)/, 'quasar'],
  [/^src\/(code-audit|uranus-|ecosystems|licences|exploit-intel|popular-packages)|^public\/code-audit-ui/, 'uranus'],
  [/^src\/(site-check|rendered-site-|site-url-privacy)|^src\/routes\/rendered-audit|^public\/rendered-audit/, 'parallax'],
  [/^src\/(intelligence|activity-feed|live-stream|snapshot-signatures)|^public\/(neural|workspace-pulse)/, 'pulsar'],
  [/^src\/(mutation-gateway|mutation-coverage|protected-paths|safe-passage)/, 'platform/mutation-gateway'],
  [/^src\/(authorization-resolver|security-foundation|local-session-policy)/, 'platform/authorization'],
  [/^src\/(alpha-|provider-disconnect|key-derivation)/, 'identity-access'],
  [/^src\/(provider-|github-app|github-account-operations)/, 'github-provider'],
  [/^src\/(workspace-posture|posture-summary|findings-inbox|pull-list|security-standards|branch-protection)|^public\/(security-posture|findings-inbox-ui|pull-board)/, 'posture'],
  [/^src\/(database-pool|migrations|backup-format|hosted-readiness)|^db\//, 'platform/persistence'],
  [/^src\/(guarded-fetch)/, 'platform/network'],
  [/^src\/(config)/, 'platform/config'],
  [/^src\/(version|release-fingerprint|asset-stamp|capability-registry|qualification-|public-alpha-qualification|work-continuity|staging-validation|test-matrix|public-assets)/, 'platform/release'],
  [/^src\/(rate-limit-|single-use-store)/, 'platform/rate-limit'],
  [/^src\/file-security/, 'platform/files'],
  [/^src\/public-errors/, 'platform/http'],
  [/^server\.js$/, 'apps/api (decomposed)'],
  [/^public\/vendor\//, 'apps/web (bundled from node_modules)'],
  [/^public\/(landing-|vortex|nebula-galaxy|nebula-singularity|light-waves|nebula-visuals|overlay-motion)/, 'apps/web/visualizations'],
  [/^public\//, 'apps/web'],
  [/^test\/e2e\//, 'test/e2e'],
  [/^test\//, 'test'],
  [/^(scripts|ci)\//, 'tooling'],
  [/^\.github\//, 'tooling/ci'],
  [/^docs\/|^README\.md$|^CHANGELOG\.md$/, 'docs'],
  [/^config\//, 'platform/config'],
  [/^staging\//, 'tooling/qualification'],
  [/./, 'repository']
];

function ownerOf(file) {
  return OWNER_RULES.find(([pattern]) => pattern.test(file))[1];
}

/* Files every tool starts from: nothing references them because they are the start. */
const ENTRYPOINTS = new Map([
  ['package.json', 'npm manifest'], ['package-lock.json', 'npm lockfile, written by npm'],
  ['server.js', 'package.json main and start script'], ['render.yaml', 'Render blueprint'],
  ['.gitignore', 'git'], ['.npmrc', 'npm configuration'], ['.nvmrc', 'Node version managers'],
  ['.env.example', 'operator environment template'], ['eslint.config.js', 'ESLint flat configuration'],
  ['jsconfig.json', 'npm run typecheck'], ['playwright.config.js', 'npm run test:e2e'],
  ['playwright.integration.config.js', 'npm run test:integration'],
  ['.github/workflows/ci.yml', 'GitHub Actions'], ['.github/workflows/public-alpha-alpha17.yml', 'GitHub Actions'],
  ['README.md', 'repository entrypoint'], ['CHANGELOG.md', 'repository entrypoint'],
  ['config/github-main-ruleset.json', 'the branch ruleset the owner applies in GitHub settings']
]);

/* Written by a generator in the tree; the generator is the proof. */
const GENERATED = new Map([
  ['docs/current/PROJECT_STATE.md', 'scripts/generate-continuity-docs.js from WORK_CONTINUITY.json'],
  ['docs/current/CONTINUATION_PROMPT.md', 'scripts/generate-continuity-docs.js from WORK_CONTINUITY.json'],
  ['public/assets/apple-touch-icon.png', 'scripts/make-brand-assets.js'],
  ['public/assets/icon-192.png', 'scripts/make-brand-assets.js'],
  ['public/assets/icon-512.png', 'scripts/make-brand-assets.js'],
  ['public/assets/icon-maskable-512.png', 'scripts/make-brand-assets.js'],
  ['public/assets/og-image.png', 'scripts/make-brand-assets.js']
]);

/*
 * Files no other file names, each examined by hand. The reason is the proof;
 * the disposition is what the cleanup phase does with it.
 */
const UNREFERENCED = new Map([
  ['.coderabbit.yaml', 'Configuration for an external review service the owner does not use; no workflow, script or test reads it']
]);

function historicalRecords() {
  return JSON.parse(baselineText('config/historical-document-integrity.json').toString('utf8')).records;
}

function manifestDocuments() {
  return new Set(JSON.parse(baselineText('docs/DOCUMENTATION_MANIFEST.json').toString('utf8')).documents.map(entry => entry.path));
}

/* The reference index: which baseline text files mention which names. */
function referenceIndex(files) {
  const corpus = new Map();
  for (const file of files) {
    if (!TEXT.test(file) || file.startsWith('public/vendor/')) continue;
    corpus.set(file, baselineText(file).toString('utf8'));
  }
  return corpus;
}

function referencesTo(file, corpus) {
  const base = path.posix.basename(file);
  const stem = base.replace(/\.(js|json)$/, '');
  const needles = [file, base];
  if (stem !== base && stem.length > 3) needles.push(`/${stem}'`, `/${stem}"`, `/${stem}\``);
  const referrers = [];
  for (const [other, text] of corpus) {
    if (other === file) continue;
    if (needles.some(needle => text.includes(needle))) referrers.push(other);
  }
  /* Code and configuration first: a document that names a file proves less than a program that loads it. */
  const rank = name => name === 'package.json' ? 0 : /\.md$/.test(name) ? 2 : 1;
  return referrers.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
}

function classify(file, context) {
  if (context.historical[file]) {
    return { class: 'IMMUTABLE_HISTORY', proof: 'SHA-256 bound in config/historical-document-integrity.json' };
  }
  if (file.startsWith('public/vendor/')) {
    return { class: 'VENDOR', proof: 'copied from the pinned npm package by scripts/copy-vendor.js; also tracked' };
  }
  if (GENERATED.has(file)) return { class: 'GENERATED', proof: `generated by ${GENERATED.get(file)}` };
  if (UNREFERENCED.has(file)) return { class: 'UNREFERENCED_VERIFIED', proof: UNREFERENCED.get(file) };
  if (/^test\/fixtures\//.test(file) || /^test\/e2e\/.*fixtures?\.js$/.test(file) || /^test\/helpers\//.test(file)) {
    const referrers = referencesTo(file, context.corpus);
    if (/^test\/fixtures\/uranus-benchmark\//.test(file)) {
      return { class: 'FIXTURE', proof: 'Uranus benchmark corpus, walked by test/uranus-benchmark.test.js' };
    }
    return { class: 'FIXTURE', proof: referrers.length ? `used by ${referrers[0]}${referrers.length > 1 ? ` and ${referrers.length - 1} more` : ''}` : 'fixture directory' };
  }
  if (ENTRYPOINTS.has(file)) return { class: 'ACTIVE', proof: `entrypoint: ${ENTRYPOINTS.get(file)}` };
  if (/^db\/migrations\/\d{3}_.+\.sql$/.test(file)) {
    return { class: 'ACTIVE', proof: 'applied in order by src/migrations.js; checksum-verified in production' };
  }
  if (/^test\/e2e\/.+\.spec\.js$/.test(file)) return { class: 'ACTIVE', proof: 'discovered by playwright.config.js (testDir test/e2e)' };
  if (/^test\/integration\//.test(file)) {
    const referrers = referencesTo(file, context.corpus);
    if (referrers.length) return { class: 'ACTIVE', proof: `run by ${referrers[0]}` };
  }
  if (context.documents.has(file)) return { class: 'ACTIVE', proof: 'registered in docs/DOCUMENTATION_MANIFEST.json' };
  const referrers = referencesTo(file, context.corpus);
  if (referrers.length && !/\.md$/.test(referrers[0])) {
    return { class: 'ACTIVE', proof: `referenced by ${referrers[0]}${referrers.length > 1 ? ` and ${referrers.length - 1} more` : ''}` };
  }
  if (referrers.length) return { class: 'UNKNOWN', proof: `named only in documents (${referrers[0]})` };
  return { class: 'UNKNOWN', proof: 'no reference found' };
}

/* --- backend dependency graph ------------------------------------------- */

function requiresOf(file, source) {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const found = [];
  const visit = node => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require' &&
        node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      const line = parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1;
      let top = node;
      while (top.parent && !ts.isSourceFile(top.parent)) top = top.parent;
      found.push({ specifier: node.arguments[0].text, line, topLevel: ts.isVariableStatement(top) || ts.isExpressionStatement(top) && top === node.parent });
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return found;
}

function resolveLocal(from, specifier, fileSet) {
  if (!specifier.startsWith('.')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  for (const candidate of [base, `${base}.js`, `${base}.json`, `${base}/index.js`]) {
    if (fileSet.has(candidate)) return candidate;
  }
  return null;
}

function stronglyConnected(nodes, edges) {
  let index = 0;
  const stack = [];
  const on = new Set();
  const indices = new Map();
  const lows = new Map();
  const components = [];
  const strong = node => {
    indices.set(node, index); lows.set(node, index); index += 1;
    stack.push(node); on.add(node);
    for (const next of edges.get(node) || []) {
      if (!indices.has(next)) { strong(next); lows.set(node, Math.min(lows.get(node), lows.get(next))); }
      else if (on.has(next)) lows.set(node, Math.min(lows.get(node), indices.get(next)));
    }
    if (lows.get(node) === indices.get(node)) {
      const component = [];
      let member;
      do { member = stack.pop(); on.delete(member); component.push(member); } while (member !== node);
      if (component.length > 1) components.push(component.sort());
    }
  };
  for (const node of nodes) if (!indices.has(node)) strong(node);
  return components;
}

function dependencyGraph(files) {
  const fileSet = new Set(files);
  const backend = files.filter(file => file === 'server.js' || /^src\/.+\.js$/.test(file));
  const modules = {};
  const edges = new Map();
  for (const file of backend) {
    const source = baselineText(file).toString('utf8');
    const local = [];
    const packages = new Set();
    const builtins = new Set();
    for (const { specifier, line } of requiresOf(file, source)) {
      const resolved = resolveLocal(file, specifier, fileSet);
      if (resolved) local.push({ file: resolved, line });
      else if (specifier.startsWith('node:') || require('module').isBuiltin(specifier)) builtins.add(specifier.replace(/^node:/, ''));
      else if (!specifier.startsWith('.')) packages.add(specifier.split('/')[0].startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]);
    }
    const unique = [...new Set(local.map(item => item.file))].sort();
    edges.set(file, unique.filter(target => backend.includes(target)));
    modules[file] = {
      owner: ownerOf(file),
      lines: source.split('\n').length,
      requires: unique,
      packages: [...packages].sort(),
      builtins: [...builtins].sort()
    };
  }
  for (const [file, targets] of edges) for (const target of targets) {
    if (modules[target]) (modules[target].requiredBy = modules[target].requiredBy || []).push(file);
  }
  for (const entry of Object.values(modules)) {
    entry.requiredBy = (entry.requiredBy || []).sort();
    entry.fanIn = entry.requiredBy.length;
    entry.fanOut = entry.requires.length;
  }
  /* Process entry files loaded by path rather than by require: invisible to the graph above. */
  const pathLoaded = {
    'src/rendered-site-worker.js': 'forked by src/rendered-site-runner.js',
    'src/code-audit-worker.js': 'spawned by itself through __filename in src/code-audit-jobs.js',
    'src/exposure-worker.js': 'started as a worker by server.js'
  };
  return {
    schemaVersion: 1,
    baseline: BASELINE,
    modules,
    cycles: stronglyConnected(backend, edges),
    pathLoadedEntrypoints: pathLoaded
  };
}

/* --- browser surface ------------------------------------------------------ */

function frontendSurface(files) {
  const scripts = files.filter(file => /^public\/[^/]+\.js$/.test(file));
  const html = baselineText('public/index.html').toString('utf8');
  const order = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(match => match[1].replace(/\?v=.*$/, ''));
  const result = { schemaVersion: 1, baseline: BASELINE, scriptOrder: order, files: {} };
  for (const file of scripts) {
    const source = baselineText(file).toString('utf8');
    const publishes = [...new Set([...source.matchAll(/(?:window|root|globalThis|self)\.(Nebula[A-Za-z]+)\s*=/g)].map(match => match[1]))].sort();
    const consumes = [...new Set([...source.matchAll(/\b(Nebula[A-Za-z]+)\b/g)].map(match => match[1]))]
      .filter(name => !publishes.includes(name)).sort();
    result.files[file] = {
      owner: ownerOf(file),
      lines: source.split('\n').length,
      publishes,
      consumes,
      htmlSinks: (source.match(/\.innerHTML\s*=|insertAdjacentHTML\(|\.outerHTML\s*=/g) || []).length,
      listeners: (source.match(/addEventListener\(/g) || []).length,
      apiCalls: (source.match(/['"`]\/api\//g) || []).length,
      commonJsExport: /module\.exports\s*=/.test(source)
    };
  }
  result.page = {
    elementIds: [...html.matchAll(/\bid="([^"]+)"/g)].length,
    pages: [...html.matchAll(/<main class="page[^"]*" id="(page-[^"]+)"/g)].map(match => match[1]),
    workbenchTabs: [...html.matchAll(/class="tab[^"]*"[^>]*data-tab="([a-z]+)"|data-tab="([a-z]+)"[^>]*class="tab\b/g)].map(match => match[1] || match[2]),
    classicScripts: order.length,
    inlineScripts: (html.match(/<script(?![^>]*\bsrc=)[^>]*>/g) || []).length
  };
  return result;
}

/* --- route inventory ------------------------------------------------------ */

function routeInventory() {
  const policy = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'oracles', 'route-policy.json'), 'utf8'));
  const owner = route => {
    const p = route.path;
    if (/governance|\/policies|\/exceptions|\/webhooks/.test(p)) return 'kepler';
    if (/exposure|credential/.test(p)) return 'quasar';
    if (/code-audit|uranus/.test(p)) return 'uranus';
    if (/site-check|site-rendered|\/site\b/.test(p)) return 'parallax';
    if (/intelligence|activity|live-events|\/stream/.test(p)) return 'pulsar';
    if (/safety|restore|snapshot|emergency|reset|\/evidence|access-surface/.test(p)) return 'corona';
    if (/posture|findings|pull-list|standards|branch-protection/.test(p)) return 'posture';
    if (/alpha|login|logout|accounts|security\/|oauth|github-app|\/me$|provider/.test(p)) return 'identity-access';
    if (/^\/api\/repo\/|^\/api\/repos|^\/api\/search|^\/api\/user|notifications|stars?/.test(p)) return 'workbench';
    return 'platform';
  };
  const routes = policy.sequence.filter(entry => entry.kind === 'route').map(route => ({
    method: route.method, path: route.path, owner: owner(route), guards: route.guards,
    beforeAlphaBoundary: route.publicByPosition
  }));
  const byOwner = {};
  for (const route of routes) byOwner[route.owner] = (byOwner[route.owner] || 0) + 1;
  return { schemaVersion: 1, baseline: BASELINE, total: routes.length, byOwner, routes };
}

/* --- residue register ----------------------------------------------------- */

function residueRegister(inventory) {
  const rows = Object.entries(inventory.files)
    .filter(([, entry]) => entry.class !== 'ACTIVE' && entry.class !== 'IMMUTABLE_HISTORY' && entry.class !== 'FIXTURE');
  const lines = [
    '# Residue register',
    '',
    `Generated by \`scripts/architecture-inventory.js\` from baseline \`${BASELINE}\`. Do not edit by hand.`,
    '',
    'Every baseline file is classified in [FILE_INVENTORY.json](FILE_INVENTORY.json). This register lists the files that are not plainly active source, history or fixtures, and the mechanisms the architecture retires, with the disposition each one receives in the cleanup phase. A file is removed only in a dedicated commit that names its proof, and every removal is entered in the deletion ledger.',
    '',
    '## Counts by class',
    '',
    '| Class | Files |',
    '|---|---:|',
    ...CLASSES.map(name => `| ${name} | ${inventory.counts[name] || 0} |`),
    '',
    '## Files outside active source, history and fixtures',
    '',
    '| File | Class | Proof | Disposition |',
    '|---|---|---|---|',
    ...rows.map(([file, entry]) => `| \`${file}\` | ${entry.class} | ${entry.proof} | ${disposition(file, entry)} |`),
    '',
    '## Mechanisms the architecture retires',
    '',
    'Active today, and replaced by the build rather than deleted as dead code. Each is removed only after its replacement is proven.',
    '',
    '| Mechanism | Where | Replaced by |',
    '|---|---|---|',
    '| Run-time comment stripping of browser files | `src/public-assets.js` | The Vite production build |',
    '| `?v=__NV_ASSET_VERSION__` stamping | `src/asset-stamp.js`, `public/index.html`, `public/sw.js` | Content-hashed file names from the build |',
    '| Hand-kept precache list | `public/sw.js` | A precache list generated from the build manifest |',
    '| Vendored browser libraries | `public/vendor/` (CodeMirror, marked, DOMPurify, Three.js) | Imports from the pinned npm packages, bundled |',
    '| `postinstall` vendor copy | `scripts/copy-vendor.js` | The bundler |',
    '| `/vendor/*` route with its CDN fallback | `server.js` | Nothing: bundled files are served as built assets |',
    '| Hand-chained unit programs | `package.json` `test:unit` | Test discovery with an explicit exclusion list |',
    ''
  ];
  return `${lines.join('\n')}`;
}

function disposition(file, entry) {
  if (entry.class === 'VENDOR') return 'Remove once the bundle imports the pinned package';
  if (entry.class === 'GENERATED') return 'Keep: regenerated by its generator, checked by its test';
  if (entry.class === 'UNREFERENCED_VERIFIED') return 'Remove, with this proof, in the cleanup phase';
  if (entry.class === 'DUPLICATE_VERIFIED') return 'Remove the duplicate';
  return 'Investigate';
}

function build() {
  const files = baselineFiles();
  const context = {
    historical: historicalRecords(),
    documents: manifestDocuments(),
    corpus: referenceIndex(files)
  };
  const inventory = { schemaVersion: 1, baseline: BASELINE, totalFiles: files.length, counts: {}, files: {} };
  for (const file of files) {
    const verdict = classify(file, context);
    inventory.files[file] = { class: verdict.class, owner: ownerOf(file), proof: verdict.proof };
    inventory.counts[verdict.class] = (inventory.counts[verdict.class] || 0) + 1;
  }
  return {
    'FILE_INVENTORY.json': `${JSON.stringify(inventory, null, 1)}\n`,
    'DEPENDENCIES.json': `${JSON.stringify(dependencyGraph(files), null, 1)}\n`,
    'ROUTE_INVENTORY.json': `${JSON.stringify(routeInventory(), null, 1)}\n`,
    'FRONTEND_SURFACE.json': `${JSON.stringify(frontendSurface(files), null, 1)}\n`,
    'RESIDUE_REGISTER.md': residueRegister(inventory)
  };
}

function main() {
  const outputs = build();
  if (process.argv.includes('--check')) {
    const stale = Object.entries(outputs)
      .filter(([name, content]) => !fs.existsSync(path.join(OUT, name)) || fs.readFileSync(path.join(OUT, name), 'utf8') !== content)
      .map(([name]) => name);
    if (stale.length) {
      console.error(`architecture inventory is stale: ${stale.join(', ')}`);
      process.exit(1);
    }
    console.log('architecture inventory is current');
    return;
  }
  fs.mkdirSync(OUT, { recursive: true });
  for (const [name, content] of Object.entries(outputs)) fs.writeFileSync(path.join(OUT, name), content);
  const inventory = JSON.parse(outputs['FILE_INVENTORY.json']);
  console.log(`classified ${inventory.totalFiles} baseline files: ${JSON.stringify(inventory.counts)}`);
}

if (require.main === module) main();

module.exports = { build, BASELINE, CLASSES };
