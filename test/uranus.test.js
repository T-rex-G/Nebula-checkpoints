'use strict';

/*
 * Uranus, flow by flow and endpoint by endpoint.
 *
 * Every sink is shown reached by a caller's value, with the trace that proves
 * it, and shown quiet when the value is parameterised, parsed, reduced,
 * allow-listed or never the caller's -- a flow engine that only ever fires is
 * a pattern matcher with extra steps. The endpoint map is shown finding the
 * handler that changes data for anyone, the record fetched by any id and the
 * open admin route, and staying quiet on the guarded, the owner-scoped and
 * the public-by-design.
 */

const assert = require('assert');
const { lexJs, lexPython } = require('../src/uranus-lex');
const { analyseFlows } = require('../src/uranus-flow');
const { analyseSurface } = require('../src/uranus-surface');
const audit = require('../src/code-audit');

const I = '$'; /* splits template interpolations so this file stays plain text */
const tpl = (...parts) => parts.join('');

function flows(files) {
  return analyseFlows(files.map(file => ({ client: false, ...file }))).flows;
}
function rulesOf(result) {
  return result.map(flow => `${flow.rule}@${flow.path}:${flow.line}`).sort();
}
function fires(label, files, expected) {
  const result = flows(files);
  const found = rulesOf(result);
  for (const want of expected) assert(found.includes(want), `${label}: expected ${want}, got ${found.join(', ') || 'nothing'}`);
  return result;
}
function quiet(label, files) {
  const result = flows(files);
  assert.deepStrictEqual(rulesOf(result), [], `${label}: expected no flows, got ${rulesOf(result).join(', ')}`);
}
function express(body) {
  return { path: 'server/app.js', text: `const express = require('express');\nconst app = express();\n${body}\n` };
}

/* ---- The lexers ----------------------------------------------------------------- */
{
  const tokens = lexJs(tpl('const q = `SELECT ', I, '{req.params.id} AND ', I, '{a + `n', I, '{b}`}`;\nconst r = /ab+c/g.test(s);\nreturn <p>Don\'t {x}</p>;\n'));
  const template = tokens.find(token => token.t === 'tpl');
  assert.deepStrictEqual(template.exprs[0].map(token => token.v), ['req', '.', 'params', '.', 'id'], 'an interpolation is lexed as code');
  assert(tokens.some(token => token.t === 're'), 'a regular expression literal is one token');
  assert(tokens.some(token => token.v === 'x' && token.line === 3), 'an apostrophe in JSX text does not swallow the rest of the file');
  assert(tokens.every((token, index) => token.i === index), 'every token knows its place');

  const lines = lexPython('def f(request):\n    q = f"SELECT {request.args[\'id\']}"\n    cur.execute(q,\n        (1,))\n');
  assert.strictEqual(lines.length, 3, 'a call continued inside brackets is one logical line');
  assert.strictEqual(lines[1].tokens.find(token => token.t === 'tpl').exprs[0][0].v, 'request', 'an f-string holds code');
}

/* ---- Injection, traced ------------------------------------------------------------ */
{
  const sql = fires('SQL from a route parameter', [express(tpl("app.get('/users/:id', async (req, res) => {\n  const id = req.params.id;\n  const rows = await db.query(`SELECT * FROM users WHERE id = ", I, "{id}`);\n  res.json(rows);\n});"))], ['SEC-001@server/app.js:5']);
  assert.deepStrictEqual(sql[0].trace.map(step => [step.role, step.line]), [['entrypoint', 4], ['sink', 5]]);
  assert.strictEqual(sql[0].verdict, 'confirmed');
  assert.strictEqual(sql[0].source, 'route parameter');
  quiet('placeholders', [express("app.get('/u/:id', async (req, res) => { await db.query('SELECT * FROM u WHERE id = $1', [req.params.id]); });")]);
  quiet('a parsed number', [express(tpl("app.get('/u', async (req, res) => { const n = parseInt(req.query.page, 10); await db.query(`SELECT * FROM u LIMIT ", I, "{n}`); });"))]);
  quiet('an allow-listed column', [express(tpl("const SORTS = ['name'];\napp.get('/u', async (req, res) => { const s = SORTS.includes(req.query.sort) ? req.query.sort : 'name'; await db.query(`SELECT * FROM u ORDER BY ", I, "{s}`); });"))]);
  quiet('a tagged template is parameterised', [express(tpl("app.get('/u', async (req, res) => { await sql`SELECT * FROM u WHERE id = ", I, "{req.query.id}`; });"))]);
  fires('prisma unsafe', [{ path: 'app/api/items/route.ts', text: tpl("export async function GET(request) {\n  const q = new URL(request.url).searchParams.get('q');\n  return prisma.$queryRawUnsafe(`SELECT * FROM items WHERE name = '", I, "{q}'`);\n}\n") }], ['SEC-001@app/api/items/route.ts:3']);

  fires('a shell', [express("const { exec } = require('child_process');\napp.post('/run', (req, res) => { exec('ls ' + req.body.dir, () => {}); });")], ['SEC-011@server/app.js:4']);
  quiet('an argument vector', [express("const { spawn } = require('child_process');\napp.post('/run', (req, res) => { spawn('ls', [req.body.dir]); });")]);
  quiet('a constant command', [express("const { exec } = require('child_process');\napp.post('/run', (req, res) => { exec('git status'); });")]);
  fires('eval', [express("app.post('/calc', (req, res) => { res.json(eval(req.body.expr)); });")], ['SEC-010@server/app.js:3']);
  fires('a template engine', [express("const ejs = require('ejs');\napp.get('/r', (req, res) => { res.send(ejs.render(req.query.t)); });")], ['SEC-030@server/app.js:4']);
  fires('a regular expression', [express("app.get('/s', (req, res) => { const re = new RegExp(req.query.q); });")], ['SEC-026@server/app.js:3']);
  fires('reflected HTML', [express(tpl("app.get('/hi', (req, res) => { res.send(`<h1>Hello ", I, "{req.query.name}</h1>`); });"))], ['SEC-033@server/app.js:3']);
  quiet('JSON is not HTML', [express("app.get('/hi', (req, res) => { res.json({ name: req.query.name }); });")]);
}

/* ---- Requests, files and redirects --------------------------------------------------- */
{
  fires('SSRF', [express("app.get('/p', async (req, res) => { const r = await fetch(req.query.url); });")], ['SEC-021@server/app.js:3']);
  quiet('a fixed host', [express(tpl("app.get('/p', async (req, res) => { await fetch(`https://api.example.com/items/", I, "{req.query.id}`); });"))]);
  quiet('a constant base', [express("const BASE = process.env.API;\napp.get('/p', async (req, res) => { await fetch(BASE + '/items/' + req.query.id); });")]);
  quiet('an allow-listed host', [express("const ALLOWED_HOSTS = new Set(['a.example']);\napp.get('/p', async (req, res) => {\n  const url = new URL(req.query.u);\n  if (!ALLOWED_HOSTS.has(url.hostname)) return res.status(400).end();\n  await fetch(url);\n});")]);
  quiet('the browser fetching its own API', [{ path: 'src/Search.tsx', client: true, text: "'use client'\nexport default function S({ q }) { fetch('/api/search?q=' + encodeURIComponent(q)); return null; }\n" }]);

  const guarded = fires('a weak test', [express("app.get('/p', async (req, res) => {\n  const url = req.query.u;\n  if (!url.startsWith('https://')) return res.status(400).end();\n  await fetch(url);\n});")], ['SEC-021@server/app.js:6']);
  assert.strictEqual(guarded[0].verdict, 'needs-validation', 'a value tested before use is something to confirm');
  assert.deepStrictEqual(guarded[0].blocker, { reason: 'guarded', path: 'server/app.js', line: 5 });

  fires('path traversal', [express("const fs = require('fs');\nconst path = require('path');\napp.get('/f', (req, res) => { fs.readFile(path.join(__dirname, 'files', req.query.name), () => {}); });")], ['SEC-022@server/app.js:5']);
  quiet('a bare name', [express("const fs = require('fs');\nconst path = require('path');\napp.get('/f', (req, res) => { fs.readFile(path.join(__dirname, 'files', path.basename(req.query.name)), () => {}); });")]);
  quiet('sendFile under a root', [express("app.get('/f', (req, res) => { res.sendFile(req.query.f, { root: 'public' }); });")]);
  fires('an open redirect', [express("app.get('/go', (req, res) => { res.redirect(req.query.next); });")], ['SEC-020@server/app.js:3']);
  quiet('a local redirect', [express("app.get('/go', (req, res) => { res.redirect('/profile/' + req.query.tab); });")]);
}

/* ---- Records and objects ---------------------------------------------------------------- */
{
  const mass = fires('a body written as it came', [express("app.post('/users', async (req, res) => { await User.create(req.body); });")], ['SEC-028@server/app.js:3']);
  assert.strictEqual(mass[0].verdict, 'needs-validation');
  fires('a whole JSON body into prisma', [{ path: 'app/api/posts/route.ts', text: 'export async function POST(request) {\n  const body = await request.json();\n  return prisma.post.create({ data: body });\n}\n' }], ['SEC-028@app/api/posts/route.ts:3']);
  quiet('chosen fields', [express("app.post('/posts', async (req, res) => { const { title, body } = req.body; await Post.create({ title, body, author: req.user.id }); });")]);
  fires('NoSQL operators', [express("app.post('/login', async (req, res) => { await User.findOne({ email: req.body.email, password: req.body.password }); });")], ['SEC-029@server/app.js:3']);
  fires('a deep merge', [express("const _ = require('lodash');\napp.post('/prefs', (req, res) => { _.merge(settings, req.body); });")], ['SEC-027@server/app.js:4']);
}

/* ---- Frameworks ---------------------------------------------------------------------------- */
{
  fires('a server action', [{ path: 'app/actions.ts', text: tpl("'use server'\nexport async function remove(id) {\n  await db.execute(`DELETE FROM posts WHERE id = ", I, "{id}`);\n}\n") }], ['SEC-001@app/actions.ts:3']);
  fires('Hono', [{ path: 'src/index.ts', text: tpl("import { Hono } from 'hono';\nconst app = new Hono();\napp.get('/u', async (c) => { await db.query(`SELECT * FROM u WHERE n = '", I, "{c.req.query('n')}'`); });\n") }], ['SEC-001@src/index.ts:3']);
  fires('Koa', [{ path: 'src/koa.js', text: "router.get('/go', async (ctx) => { ctx.redirect(ctx.query.next); });\n" }], ['SEC-020@src/koa.js:1']);
  fires('NestJS', [{ path: 'src/users.controller.ts', text: tpl("@Controller('users')\nexport class UsersController {\n  @Get()\n  find(@Query('q') q: string) {\n    return this.db.query(`SELECT * FROM users WHERE name = '", I, "{q}'`);\n  }\n}\n") }], ['SEC-001@src/users.controller.ts:5']);
  fires('SvelteKit', [{ path: 'src/routes/api/go/+server.ts', text: "import { redirect } from '@sveltejs/kit';\nexport async function GET({ url }) { redirect(302, url.searchParams.get('next')); }\n" }], ['SEC-020@src/routes/api/go/+server.ts:2']);
  fires('a Supabase edge function', [{ path: 'supabase/functions/proxy/index.ts', text: "Deno.serve(async (req) => {\n  const { target } = await req.json();\n  return fetch(target);\n});\n" }], ['SEC-021@supabase/functions/proxy/index.ts:3']);
  fires('the page URL into the DOM', [{ path: 'web/app.js', client: true, text: "const q = new URLSearchParams(location.search).get('q');\ndocument.getElementById('out').innerHTML = q;\n" }], ['SEC-002@web/app.js:2']);
  fires('a message from another window', [{ path: 'web/embed.js', client: true, text: "window.addEventListener('message', (event) => { box.innerHTML = event.data; });\n" }], ['SEC-002@web/embed.js:1']);
  fires('JSX raw HTML', [{ path: 'src/Page.tsx', client: true, text: "'use client'\nexport default function P() { const q = useSearchParams().get('bio'); return <div dangerouslySetInnerHTML={{ __html: q }} />; }\n" }], ['SEC-002@src/Page.tsx:2']);
}

/* ---- Across functions and files ---------------------------------------------------------------- */
{
  const across = fires('an imported helper', [
    express("const { findUser } = require('./users');\napp.get('/lookup', async (req, res) => { res.json(await findUser(req.query.email)); });"),
    { path: 'server/users.js', text: "const db = require('./db');\nasync function findUser(email) {\n  return db.query(\"SELECT * FROM users WHERE email = '\" + email + \"'\");\n}\nmodule.exports = { findUser };\n" }
  ], ['SEC-001@server/users.js:3']);
  assert.deepStrictEqual(across[0].trace.map(step => `${step.role}:${step.path}:${step.line}`), ['entrypoint:server/app.js:4', 'propagation:server/app.js:4', 'sink:server/users.js:3']);
  assert.strictEqual(across[0].viaHelper, 'file');
  quiet('a helper that parameterises', [
    express("const { findUser } = require('./users');\napp.get('/lookup', async (req, res) => { res.json(await findUser(req.query.email)); });"),
    { path: 'server/users.js', text: "async function findUser(email) { return db.query('SELECT * FROM users WHERE email = $1', [email]); }\nmodule.exports = { findUser };\n" }
  ]);
  fires('a helper in the same file', [express(tpl("function byName(n) { return pool.query(`SELECT * FROM u WHERE n = '", I, "{n}'`); }\napp.get('/u', (req, res) => byName(req.query.n));"))], ['SEC-001@server/app.js:3']);
}

/* ---- Python ---------------------------------------------------------------------------------------- */
{
  const py = text => ({ path: 'api/views.py', text });
  fires('Flask SQL', [py("from flask import request\n@app.route('/s')\ndef s():\n    term = request.args.get('q')\n    cur.execute(f\"SELECT * FROM t WHERE n = '{term}'\")\n")], ['SEC-001@api/views.py:5']);
  quiet('Flask placeholders', [py("from flask import request\n@app.route('/s')\ndef s():\n    cur.execute(\"SELECT * FROM t WHERE n = %s\", (request.args.get('q'),))\n")]);
  fires('a shell with shell=True', [py("@app.post('/p')\ndef p():\n    subprocess.run(f\"ping {request.json['host']}\", shell=True)\n")], ['SEC-011@api/views.py:3']);
  quiet('an argument list', [py("@app.post('/p')\ndef p():\n    subprocess.run(['ping', request.json['host']])\n")]);
  fires('pickle', [py("@app.post('/l')\ndef l():\n    return pickle.loads(request.data)\n")], ['SEC-024@api/views.py:3']);
  fires('a template from input', [py("@app.get('/t')\ndef t():\n    return render_template_string(request.args['t'])\n")], ['SEC-030@api/views.py:3']);
  fires('FastAPI parameters', [{ path: 'app/main.py', text: "from fastapi import FastAPI\napp = FastAPI()\n@app.get('/items')\ndef items(q: str):\n    return db.execute(f\"SELECT * FROM items WHERE name = '{q}'\")\n" }], ['SEC-001@app/main.py:5']);
  quiet('an integer', [py("@app.get('/n')\ndef n():\n    k = int(request.args['n'])\n    os.system('echo ' + str(k))\n")]);
}

/* ---- Language models --------------------------------------------------------------------------------- */
{
  const ai = fires('a reply executed', [{ path: 'app/api/run/route.ts', text: tpl("import OpenAI from 'openai';\nconst openai = new OpenAI();\nexport async function POST(req) {\n  const { task } = await req.json();\n  const r = await openai.chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'system', content: `Do ", I, "{task}` }] });\n  eval(r.choices[0].message.content);\n}\n") }], ['AI-001@app/api/run/route.ts:6', 'AI-002@app/api/run/route.ts:5']);
  assert.strictEqual(ai.find(flow => flow.rule === 'AI-001').severity, 'critical');
  assert.strictEqual(ai.find(flow => flow.rule === 'AI-002').verdict, 'needs-validation');
}

/* ---- The endpoint map --------------------------------------------------------------------------------- */
function surfaceOf(files) {
  const { routes } = analyseFlows(files);
  return analyseSurface({ routes, files });
}
{
  const withAuth = { path: 'server/auth.js', text: "const jwt = require('jsonwebtoken');\nfunction requireAuth(req, res, next) { jwt.verify(req.headers.authorization, KEY); next(); }\nmodule.exports = { requireAuth };\n" };
  const routes = { path: 'server/routes.js', text: [
    "const router = require('express').Router();",
    "router.post('/posts', async (req, res) => { await Post.create({ title: req.body.title }); });",
    "router.delete('/posts/:id', requireAuth, async (req, res) => { await Post.findByIdAndDelete(req.params.id); res.end(); });",
    "router.delete('/notes/:id', requireAuth, async (req, res) => { await Note.deleteOne({ _id: req.params.id, owner: req.user.id }); res.end(); });",
    "router.get('/admin/users', async (req, res) => res.json(await User.find()));",
    "router.post('/webhooks/stripe', async (req, res) => { await Order.create({ paid: true }); });",
    "router.get('/posts', async (req, res) => res.json(await Post.find()));",
    'module.exports = router;', ''
  ].join('\n') };
  const result = surfaceOf([withAuth, routes]);
  const by = rule => result.raw.filter(item => item.rule === rule).map(item => `${item.line}:${item.verdict}`);
  assert.deepStrictEqual(by('ACC-001'), ['2:confirmed'], 'an open handler that writes is found, and confirmed where the project signs users in elsewhere');
  assert.deepStrictEqual(by('ACC-002'), ['3:needs-validation'], 'a record fetched by any id, with no owner check, is something to confirm');
  assert.deepStrictEqual(by('ACC-003'), ['5:confirmed']);
  assert.strictEqual(result.counts.guarded, 2);
  assert(result.surfaces.find(surface => surface.route === '/webhooks/stripe').publicByDesign, 'webhooks are public by design');

  /* A middleware the read cannot tie to a route turns "open" into "confirm the guard". */
  const next = surfaceOf([withAuth, { path: 'middleware.ts', text: "export { default } from 'next-auth/middleware';\nexport const config = { matcher: ['/api/:path*'] };\n" },
    { path: 'app/api/posts/route.ts', text: 'export async function POST(request) { const b = await request.json(); await prisma.post.create({ data: { title: b.title } }); }\n' }]);
  assert.deepStrictEqual(next.raw.map(item => [item.rule, item.verdict, item.blocker.reason]), [['ACC-001', 'needs-validation', 'global-guard']]);

  /* A project with no sign-in anywhere: whether anyone may write is a product decision. */
  const bare = surfaceOf([{ path: 'server/app.js', text: "app.post('/todos', async (req, res) => { await Todo.create({ text: req.body.text }); });\n" }]);
  assert.deepStrictEqual(bare.raw.map(item => [item.rule, item.blocker.reason]), [['ACC-001', 'no-auth-anywhere']]);

  const action = surfaceOf([withAuth, { path: 'app/actions.ts', text: "'use server'\nexport async function remove(id) { await db.post.delete({ where: { id } }); }\nexport async function go(to) { redirect('/done'); }\n" }]);
  assert.deepStrictEqual(action.raw.map(item => `${item.rule}:${item.line}`), ['ACC-004:2'], 'a server action that writes without a session check; one that only redirects is not a finding');

  const edge = surfaceOf([{ path: 'supabase/config.toml', text: '[functions.admin-sync]\nverify_jwt = false\n' },
    { path: 'supabase/functions/admin-sync/index.ts', text: "Deno.serve(async (req) => { await supabase.from('users').delete().neq('id', 0); return new Response('ok'); });\n" }]);
  assert.deepStrictEqual(edge.raw.map(item => item.rule), ['ACC-005']);
}

/* ---- The audit carries it, and still never the code ----------------------------------------------------- */
{
  const canary = 'uranus-canary-7f3c';
  const result = audit.analyse({ files: [
    { path: 'README.md', text: '# x\n' },
    { path: '.gitignore', text: '.env\n' },
    { path: 'package-lock.json', text: '{}' },
    { path: 'test/a.test.js', text: 'x\n' },
    express(tpl("app.get('/u/:id', async (req, res) => {\n  const ", canary.replace(/-/g, '_'), " = req.params.id;\n  await db.query(`SELECT * FROM users WHERE id = ", I, "{", canary.replace(/-/g, '_'), "}`);\n});"))
  ] });
  const finding = result.findings.find(item => item.rule === 'SEC-001');
  assert.strictEqual(finding.verdict, 'confirmed');
  assert.strictEqual(finding.evidence, 'traced');
  assert.strictEqual(finding.reach.auth, 'open');
  assert(!JSON.stringify(result).includes(canary.replace(/-/g, '_')), 'no identifier or text from the code leaves the audit');
  assert.strictEqual(result.engine.name, 'Uranus');
  assert(result.ledger.find(entry => entry.id === 'logic').status === 'not-assessed', 'business logic is said to be out of reach, not clear');
  assert(result.ledger.find(entry => entry.id === 'injection').status === 'covered');
  assert.strictEqual(result.surface.endpoints.length, 1);
}

/* ---- Bounded ------------------------------------------------------------------------------------------ */
{
  const handlers = [];
  for (let index = 0; index < 1500; index += 1) handlers.push(tpl(`app.get('/r${index}', async (req, res) => { const v${index} = req.query.v; await db.query('SELECT $1', [v${index}]); res.json({ ok: `, I, `{v${index}} }); });`));
  const started = Date.now();
  const result = analyseFlows([{ path: 'server/big.js', text: handlers.join('\n') }]);
  assert(Date.now() - started < 8000, 'a 1500-route file is analysed in seconds');
  assert.strictEqual(result.routes.length, 1500);
}

console.log('uranus tests passed');
