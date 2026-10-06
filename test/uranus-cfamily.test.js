'use strict';

/*
 * Uranus in Go, Java and PHP, flow by flow and endpoint by endpoint.
 *
 * Each sink is shown reached by a caller's value and shown quiet when the
 * value is parameterised, parsed, reduced, allow-listed, validated before
 * the call or never the caller's. Each framework's endpoints are shown
 * mapped with the guard in front of them, including handlers written in
 * another file. And the whole is shown inside the audit: counted, reached
 * and in the coverage ledger.
 */

const assert = require('assert');
const { analyseCFamily, lex, functionsOf } = require('../src/uranus-cfamily');
const { analyseFlows } = require('../src/uranus-flow');
const { analyseSurface, reachOf } = require('../src/uranus-surface');
const audit = require('../src/code-audit');

/* The line a fragment of a fixture is on, so expectations read as code, not numbers. */
function at(text, fragment, nth = 1) {
  let index = -1;
  for (let found = 0; found < nth; found += 1) {
    index = text.indexOf(fragment, index + 1);
    assert(index !== -1, `fixture has no ${JSON.stringify(fragment)}`);
  }
  return text.slice(0, index).split('\n').length;
}
function run(files) {
  return analyseCFamily(files);
}
function rulesOf(result) {
  return result.flows.map(flow => `${flow.rule}@${flow.path}:${flow.line}`).sort();
}
function fires(label, files, expected) {
  const result = run(files);
  const found = rulesOf(result);
  for (const want of expected) assert(found.includes(want), `${label}: expected ${want}, got ${found.join(', ') || 'nothing'}`);
  return result;
}
function quiet(label, files) {
  const result = run(files);
  assert.deepStrictEqual(rulesOf(result), [], `${label}: expected no flows, got ${rulesOf(result).join(', ')}`);
  return result;
}
const one = (path, text) => [{ path, text }];

/* ---- Go ------------------------------------------------------------------------------ */

function goFile(body, imports = '"database/sql"\n\t"net/http"') {
  return `package main\n\nimport (\n\t${imports}\n)\n\n${body}\n`;
}

{
  const sql = goFile(`func user(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	q := "SELECT * FROM users WHERE id = " + id
	db.Query(q)
}`);
  const result = fires('go: a query string into SQL', one('main.go', sql), [`SEC-001@main.go:${at(sql, 'db.Query(q)')}`]);
  const flow = result.flows[0];
  assert.strictEqual(flow.verdict, 'confirmed');
  assert.strictEqual(flow.source, 'query string');
  assert.deepStrictEqual(flow.trace.map(step => step.role), ['entrypoint', 'propagation', 'sink'], 'the trace runs from the request to the call');
  assert.strictEqual(flow.trace[0].line, at(sql, 'r.URL.Query()'));

  quiet('go: a placeholder', one('main.go', goFile(`func user(w http.ResponseWriter, r *http.Request) {
	db.Query("SELECT * FROM users WHERE id = $1", r.URL.Query().Get("id"))
}`)));
  quiet('go: a parsed number', one('main.go', goFile(`func user(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.Atoi(r.FormValue("id"))
	db.Query(fmt.Sprintf("SELECT * FROM users WHERE id = %d", id))
}`)));

  const shell = goFile(`func run(w http.ResponseWriter, r *http.Request) {
	host := r.FormValue("host")
	exec.Command("sh", "-c", "ping -c 1 "+host).Run()
}`);
  fires('go: a shell', one('main.go', shell), [`SEC-011@main.go:${at(shell, 'exec.Command')}`]);
  quiet('go: an argument vector', one('main.go', goFile(`func run(w http.ResponseWriter, r *http.Request) {
	exec.Command("ping", "-c", "1", r.FormValue("host")).Run()
}`)));

  const file = goFile(`func download(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	data, _ := os.ReadFile("/srv/files/" + name)
	w.Write(data)
}`);
  fires('go: a path', one('main.go', file), [`SEC-022@main.go:${at(file, 'os.ReadFile')}`]);
  quiet('go: a base name', one('main.go', goFile(`func download(w http.ResponseWriter, r *http.Request) {
	name := filepath.Base(r.URL.Query().Get("name"))
	data, _ := os.ReadFile("/srv/files/" + name)
	w.Write(data)
}`)));

  const fetch = goFile(`func proxy(w http.ResponseWriter, r *http.Request) {
	target := r.URL.Query().Get("url")
	http.Get(target)
}`);
  fires('go: an outbound request', one('main.go', fetch), [`SEC-021@main.go:${at(fetch, 'http.Get')}`]);
  quiet('go: a fixed host', one('main.go', goFile(`func proxy(w http.ResponseWriter, r *http.Request) {
	http.Get("https://api.example.com/v1/items/" + r.URL.Query().Get("id"))
}`)));

  const html = goFile(`func hello(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	fmt.Fprintf(w, "<h1>Hello %s</h1>", name)
}`);
  fires('go: an HTML response', one('main.go', html), [`SEC-033@main.go:${at(html, 'fmt.Fprintf')}`]);

  const bound = goFile(`type Search struct { Term string }
func search(w http.ResponseWriter, r *http.Request) {
	var body Search
	json.NewDecoder(r.Body).Decode(&body)
	db.Query("SELECT * FROM items WHERE name = '" + body.Term + "'")
}`);
  fires('go: a decoded body', one('main.go', bound), [`SEC-001@main.go:${at(bound, 'db.Query')}`]);

  const gin = goFile(`func setup(r *gin.Engine) {
	r.GET("/next", func(c *gin.Context) {
		target := c.Query("next")
		c.Redirect(302, target)
		c.Redirect(302, "/home/"+target)
	})
}`, '"github.com/gin-gonic/gin"');
  const ginResult = fires('go: a gin redirect', one('main.go', gin), [`SEC-020@main.go:${at(gin, 'c.Redirect(302, target)')}`]);
  assert(!rulesOf(ginResult).includes(`SEC-020@main.go:${at(gin, '"/home/"+target')}`), 'a redirect led by a local path stays on this site');

  /* validated before the call: equality with literals inside the block, and past an early exit */
  quiet('go: an allow-list by equality', one('main.go', goFile(`func sort(w http.ResponseWriter, r *http.Request) {
	col := r.URL.Query().Get("sort")
	if col == "name" || col == "created" {
		db.Query("SELECT * FROM items ORDER BY " + col)
	}
}`)));
  quiet('go: an early exit', one('main.go', goFile(`func sort(w http.ResponseWriter, r *http.Request) {
	col := r.URL.Query().Get("sort")
	if col != "name" && col != "created" {
		http.Error(w, "bad sort", 400)
		return
	}
	db.Query("SELECT * FROM items ORDER BY " + col)
}`)));
  const after = goFile(`func sort(w http.ResponseWriter, r *http.Request) {
	col := r.URL.Query().Get("sort")
	if col == "name" {
		db.Query("SELECT * FROM items ORDER BY " + col)
	}
	db.Query("SELECT * FROM items ORDER BY " + col)
}`);
  const afterResult = fires('go: a check holds only inside its block', one('main.go', after), [`SEC-001@main.go:${at(after, 'db.Query', 2)}`]);
  assert.strictEqual(afterResult.flows.length, 1, 'the call inside the block stays quiet');

  /* a helper in the same file, and one in another file */
  const helper = goFile(`func find(q string) {
	db.Query("SELECT * FROM t WHERE name = '" + q + "'")
}
func handler(w http.ResponseWriter, r *http.Request) {
	find(r.FormValue("q"))
}`);
  const helped = fires('go: a helper', one('main.go', helper), [`SEC-001@main.go:${at(helper, 'db.Query')}`]);
  assert.strictEqual(helped.flows[0].viaHelper, 'function');
  const store = goFile(`func FindByName(q string) {
	db.Query("SELECT * FROM t WHERE name = '" + q + "'")
}`);
  const api = goFile(`func handler(w http.ResponseWriter, r *http.Request) {
	FindByName(r.FormValue("q"))
}`);
  const across = fires('go: a helper in another file', [{ path: 'store/users.go', text: store }, { path: 'api/users.go', text: api }], [`SEC-001@store/users.go:${at(store, 'db.Query')}`]);
  assert.strictEqual(across.flows[0].viaHelper, 'file');
  assert.strictEqual(across.flows[0].trace[0].path, 'api/users.go', 'the trace starts where the request is read');
}

/* ---- Go endpoints ---------------------------------------------------------------- */

{
  const main = goFile(`func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /files", api.ServeFile)
	mux.HandleFunc("DELETE /users/{id}", requireAuth(api.DeleteUser))
	r := gin.Default()
	v1 := r.Group("/v1", AuthRequired())
	v1.POST("/run", run)
	r.GET("/public/ping", func(c *gin.Context) { c.String(200, "ok") })
}`, '"net/http"\n\t"github.com/gin-gonic/gin"');
  const handlers = goFile(`func ServeFile(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	data, _ := os.ReadFile("/srv/" + name)
	w.Write(data)
}
func DeleteUser(w http.ResponseWriter, r *http.Request) {
	db.Exec("DELETE FROM users WHERE id = $1", r.PathValue("id"))
}`);
  const result = run([{ path: 'cmd/main.go', text: main }, { path: 'internal/api/handlers.go', text: handlers }]);
  const route = (method, path) => result.routes.find(entry => entry.method === method && entry.route === path);
  const files = route('GET', '/files');
  assert(files, 'Go 1.22 method patterns are read');
  assert.strictEqual(files.framework, 'go-http');
  assert.strictEqual(files.handlerPath, 'internal/api/handlers.go', 'a handler named from another package is found in its file');
  assert.strictEqual(files.startLine, at(handlers, 'func ServeFile'));
  const remove = route('DELETE', '/users/{id}');
  assert.deepStrictEqual(remove.middleware, ['requireAuth'], 'the wrapper around a handler is its middleware; the package name is not');
  const grouped = route('POST', '/v1/run');
  assert(grouped && grouped.framework === 'gin', 'a gin group keeps its prefix');
  assert(grouped.middleware.includes('AuthRequired'), 'and its middleware');
  assert(route('GET', '/public/ping'));

  const surface = analyseSurface({ routes: result.routes, files: [{ path: 'cmd/main.go', text: main }] });
  const byRoute = new Map(surface.surfaces.map(entry => [`${entry.method} ${entry.route}`, entry]));
  assert.strictEqual(byRoute.get('DELETE /users/{id}').auth, 'guarded');
  assert.strictEqual(byRoute.get('POST /v1/run').auth, 'guarded');
  assert.strictEqual(byRoute.get('GET /files').auth, 'open');
  assert.strictEqual(byRoute.get('DELETE /users/{id}').mutation, true);
  /* a guarded delete by the caller's id, never tied to the caller */
  assert(surface.raw.some(item => item.rule === 'ACC-002' && item.line === at(main, 'DELETE /users/{id}')), 'a record deleted by any id is one to confirm');
  /* the flow in the other file is reached through its route */
  const flow = result.flows.find(item => item.rule === 'SEC-022');
  assert.deepStrictEqual(reachOf(flow, surface.surfaces), { method: 'GET', route: '/files', auth: 'open', framework: 'go-http' });

  /* handlers written below their routes: each flow is reached through its own route, not the one registered before it */
  const below = goFile(`func main() {
	r := gin.Default()
	admin := r.Group("/admin", AuthRequired())
	admin.DELETE("/files/:name", removeFile)
	r.GET("/files/download", download)
}

func download(c *gin.Context) {
	data, _ := os.ReadFile("/srv/files/" + c.Query("name"))
	c.Data(200, "application/octet-stream", data)
}

func removeFile(c *gin.Context) {
	os.Remove("/srv/files/" + c.Param("name"))
}`, '"os"\n\t"github.com/gin-gonic/gin"');
  const belowResult = run(one('main.go', below));
  const belowSurface = analyseSurface({ routes: belowResult.routes, files: [] });
  const reached = belowResult.flows.map(item => `${item.line} ${reachOf(item, belowSurface.surfaces).method} ${reachOf(item, belowSurface.surfaces).route}`);
  assert.deepStrictEqual(reached, [`${at(below, 'os.ReadFile')} GET /files/download`, `${at(below, 'os.Remove')} DELETE /admin/files/:name`]);

  /* a check inside the handler guards it */
  const inside = goFile(`func main() { http.HandleFunc("/admin/stats", stats) }
func stats(w http.ResponseWriter, r *http.Request) {
	if _, err := jwt.Parse(r.Header.Get("Authorization"), key); err != nil {
		http.Error(w, "no", http.StatusUnauthorized)
		return
	}
}`);
  const checked = analyseSurface({ routes: run(one('main.go', inside)).routes, files: [] });
  assert.strictEqual(checked.surfaces[0].auth, 'guarded');
  assert(!checked.raw.some(item => item.rule === 'ACC-003'));
  const open = goFile(`func main() { http.HandleFunc("/admin/stats", stats) }
func stats(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok")) }`);
  const exposed = analyseSurface({ routes: run(one('main.go', open)).routes, files: [] });
  assert(exposed.raw.some(item => item.rule === 'ACC-003'), 'an open admin route is reported');
}

/* ---- Java ------------------------------------------------------------------------- */

function controller(body, imports = '') {
  return `package com.example;\n\nimport org.springframework.web.bind.annotation.*;\n${imports}\n@RestController\n@RequestMapping("/api")\npublic class UserController {\n${body}\n}\n`;
}

{
  const sql = controller(`  @GetMapping("/users")
  public List<User> find(@RequestParam String name) {
    return jdbcTemplate.query("SELECT * FROM users WHERE name = '" + name + "'", mapper);
  }`);
  const result = fires('java: a request parameter into SQL', one('UserController.java', sql), [`SEC-001@UserController.java:${at(sql, 'jdbcTemplate.query')}`]);
  assert.strictEqual(result.flows[0].source, 'query string');
  quiet('java: a placeholder', one('UserController.java', controller(`  @GetMapping("/users")
  public List<User> find(@RequestParam String name) {
    return jdbcTemplate.query("SELECT * FROM users WHERE name = ?", mapper, name);
  }`)));
  quiet('java: a parsed number', one('UserController.java', controller(`  @GetMapping("/users")
  public User find(@RequestParam String id) {
    int key = Integer.parseInt(id);
    return jdbcTemplate.queryForObject("SELECT * FROM users WHERE id = " + key, mapper);
  }`)));

  const resources = controller(`  @PostMapping("/login")
  public Result login(@RequestParam String user) throws Exception {
    return lookup(user);
  }
  protected Result lookup(String account) throws Exception {
    String query = "";
    try (Connection connection = dataSource.getConnection()) {
      query = "SELECT * FROM accounts WHERE name = '" + account + "'";
      return execute(connection, query);
    }
  }
  private Result execute(Connection connection, String query) throws Exception {
    try (Statement statement = connection.createStatement()) {
      ResultSet results = statement.executeQuery(query);
      return null;
    }
  }`);
  const chained = fires('java: try-with-resources and a helper of a helper', one('UserController.java', resources), [`SEC-001@UserController.java:${at(resources, 'statement.executeQuery')}`]);
  assert.strictEqual(chained.flows[0].trace[0].line, at(resources, 'public Result login'), 'the trace starts at the endpoint');

  const base = `package com.example;\npublic class UploadBase {\n  protected void save(String name) throws Exception {\n    new File(uploads, name).createNewFile();\n  }\n}\n`;
  const child = `package com.example;\n@RestController\npublic class Upload extends UploadBase {\n  @PostMapping("/upload")\n  public void upload(@RequestParam("fullName") String name) throws Exception {\n    super.save(name);\n  }\n}\n`;
  fires('java: a method of the parent class', [{ path: 'src/main/java/com/example/UploadBase.java', text: base }, { path: 'src/main/java/com/example/Upload.java', text: child }], [`SEC-022@src/main/java/com/example/UploadBase.java:${at(base, 'new File')}`]);

  const shell = controller(`  @PostMapping("/ping")
  public String ping(@RequestParam String host) throws Exception {
    Runtime.getRuntime().exec("ping -c 1 " + host);
    return "ok";
  }`);
  fires('java: a shell', one('UserController.java', shell), [`SEC-011@UserController.java:${at(shell, 'getRuntime')}`]);

  const redirect = controller(`  @GetMapping("/go")
  public void go(@RequestParam String next, HttpServletResponse response) throws Exception {
    response.sendRedirect(next);
  }`);
  fires('java: a redirect', one('UserController.java', redirect), [`SEC-020@UserController.java:${at(redirect, 'sendRedirect')}`]);

  const fetch = controller(`  @GetMapping("/proxy")
  public String proxy(@RequestParam String url) {
    return restTemplate.getForObject(url, String.class);
  }`);
  fires('java: an outbound request', one('UserController.java', fetch), [`SEC-021@UserController.java:${at(fetch, 'getForObject')}`]);
  quiet('java: a pinned URL', one('UserController.java', controller(`  @GetMapping("/proxy")
  public String proxy(@RequestParam String url) {
    if (url.matches("https://api\\\\.example\\\\.com/status")) {
      return restTemplate.getForObject(url, String.class);
    }
    return null;
  }`)));
  quiet('java: an allow-list', one('UserController.java', controller(`  @GetMapping("/sorted")
  public List<User> sorted(@RequestParam String column) {
    if (!ALLOWED.contains(column)) throw new IllegalArgumentException();
    return jdbcTemplate.query("SELECT * FROM users ORDER BY " + column, mapper);
  }`)));
  quiet('java: equality with a literal', one('UserController.java', controller(`  @GetMapping("/sorted")
  public List<User> sorted(@RequestParam String column) {
    if ("name".equals(column)) {
      return jdbcTemplate.query("SELECT * FROM users ORDER BY " + column, mapper);
    }
    return null;
  }`)));

  const token = controller(`  @PostMapping("/restore")
  public Object restore(@RequestParam String token) throws Exception {
    String b64 = token.replace('-', '+');
    try (ObjectInputStream in = new ObjectInputStream(new ByteArrayInputStream(Base64.getDecoder().decode(b64)))) {
      return in.readObject();
    }
  }`);
  fires('java: a deserializer', one('UserController.java', token), [`SEC-024@UserController.java:${at(token, 'new ObjectInputStream')}`]);

  const xml = controller(`  @PostMapping("/import")
  public void importXml(@RequestBody String body) throws Exception {
    DocumentBuilder builder = DocumentBuilderFactory.newInstance().newDocumentBuilder();
    builder.parse(new InputSource(new StringReader(body)));
  }`);
  fires('java: XML with external entities', one('UserController.java', xml), [`SEC-034@UserController.java:${at(xml, 'builder.parse')}`]);
  quiet('java: a hardened parser', one('UserController.java', controller(`  @PostMapping("/import")
  public void importXml(@RequestBody String body) throws Exception {
    DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
    factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
    DocumentBuilder builder = factory.newDocumentBuilder();
    builder.parse(new InputSource(new StringReader(body)));
  }`)));

  /* Spring endpoints: the class prefix, the verb, the guard */
  const routes = controller(`  @GetMapping("/users/{id}")
  public User one(@PathVariable Long id) { return repo.findById(id).orElseThrow(); }

  @PreAuthorize("hasRole('ADMIN')")
  @DeleteMapping("/users/{id}")
  public void remove(@PathVariable Long id) { repo.deleteById(id); }

  @PostMapping("/users")
  public User create(@RequestBody User user) { return repo.save(user); }`);
  const mapped = run(one('UserController.java', routes)).routes;
  assert.deepStrictEqual(mapped.map(entry => `${entry.method} ${entry.route}`), ['GET /api/users/{id}', 'DELETE /api/users/{id}', 'POST /api/users']);
  const surface = analyseSurface({ routes: mapped, files: [] });
  const auth = Object.fromEntries(surface.surfaces.map(entry => [`${entry.method} ${entry.route}`, entry.auth]));
  assert.strictEqual(auth['DELETE /api/users/{id}'], 'guarded');
  assert.strictEqual(auth['POST /api/users'], 'open');
  assert(surface.raw.some(item => item.rule === 'ACC-001' && item.line === at(routes, 'public User create')), 'an open write is reported');

  /* a Spring Security filter chain turns "open" into a guard to confirm */
  const config = 'package com.example;\n@EnableWebSecurity\npublic class Security {\n  @Bean SecurityFilterChain chain(HttpSecurity http) throws Exception {\n    return http.authorizeHttpRequests(a -> a.anyRequest().authenticated()).build();\n  }\n}\n';
  const withChain = analyseSurface({ routes: mapped, files: [{ path: 'src/main/java/com/example/Security.java', text: config }] });
  assert.deepStrictEqual(withChain.globalGuards.map(guard => guard.kind), ['spring-security']);
  const create = withChain.raw.find(item => item.rule === 'ACC-001');
  assert.strictEqual(create.verdict, 'needs-validation');
  assert.strictEqual(create.blocker.kind, 'spring-security');
}

/* ---- PHP ---------------------------------------------------------------------------- */

{
  const plain = `<?php
$id = $_GET['id'];
$result = mysqli_query($conn, "SELECT * FROM users WHERE id = '$id'");
echo "<p>Hello " . $_GET['name'] . "</p>";
shell_exec("ping -c 1 " . $_POST['host']);
include($_GET['page'] . '.php');
$prefs = unserialize($_COOKIE['prefs']);
header("Location: " . $_GET['next']);
?>
<div><?= $_GET['q'] ?></div>
`;
  fires('php: a plain script', one('search.php', plain), [
    `SEC-001@search.php:${at(plain, 'mysqli_query')}`,
    `SEC-033@search.php:${at(plain, 'echo')}`,
    `SEC-011@search.php:${at(plain, 'shell_exec')}`,
    `SEC-010@search.php:${at(plain, 'include(')}`,
    `SEC-024@search.php:${at(plain, 'unserialize')}`,
    `SEC-020@search.php:${at(plain, 'header(')}`,
    `SEC-033@search.php:${at(plain, '<?=')}`
  ]);
  quiet('php: made safe', one('safe.php', `<?php
$id = intval($_GET['id']);
mysqli_query($conn, "SELECT * FROM users WHERE id = $id");
$stmt = $pdo->prepare("SELECT * FROM users WHERE name = ?");
$stmt->execute([$_GET['name']]);
echo htmlspecialchars($_GET['name']);
shell_exec("ping -c 1 " . escapeshellarg($_POST['host']));
$doc = simplexml_load_string(file_get_contents('php://input'));
`));

  /* validated before the call */
  quiet('php: a number check', one('ping.php', `<?php
$target = $_REQUEST['ip'];
$octet = explode(".", $target);
if (is_numeric($octet[0]) && is_numeric($octet[1]) && sizeof($octet) == 2) {
  $target = $octet[0] . '.' . $octet[1];
  shell_exec('ping ' . $target);
}
`));
  quiet('php: an allow-list before an early exit', one('sort.php', `<?php
$column = $_GET['sort'];
if (!in_array($column, ['name', 'created'], true)) {
  exit;
}
mysqli_query($conn, "SELECT * FROM items ORDER BY $column");
`));
  quiet('php: an anchored pattern', one('user.php', `<?php
$name = $_GET['name'];
if (preg_match('/^[a-z0-9_]+$/', $name)) {
  mysqli_query($conn, "SELECT * FROM users WHERE name = '$name'");
}
`));
  const loose = `<?php
$name = $_GET['name'];
if (preg_match('/[a-z]/', $name)) {
  mysqli_query($conn, "SELECT * FROM users WHERE name = '$name'");
}
`;
  const partial = fires('php: an unanchored pattern proves nothing', one('user.php', loose), [`SEC-001@user.php:${at(loose, 'mysqli_query')}`]);
  assert.strictEqual(partial.flows[0].verdict, 'needs-validation', 'but a check was made, so it is one to confirm');
  const upload = `<?php
$name = $_FILES['uploaded']['name'];
$ext = substr($name, strrpos($name, '.') + 1);
$stored = bin2hex(random_bytes(16)) . '.' . $ext;
if (strtolower($ext) == 'jpg' || strtolower($ext) == 'png') {
  rename($tmp, '/var/uploads/' . $stored);
}
`;
  quiet('php: what is built from a checked value is checked with it', one('upload.php', upload));

  const xml = `<?php
$doc = new DOMDocument();
$doc->loadXML(file_get_contents('php://input'), LIBXML_NOENT | LIBXML_DTDLOAD);
`;
  fires('php: XML with entities substituted', one('import.php', xml), [`SEC-034@import.php:${at(xml, 'loadXML')}`]);
}

/* ---- Laravel -------------------------------------------------------------------------- */

{
  const routes = `<?php
use App\\Http\\Controllers\\Admin\\UserController;
use App\\Http\\Controllers\\PostController;
use Illuminate\\Support\\Facades\\Route;

Route::get('/posts/search', [PostController::class, 'search']);
Route::middleware(['auth'])->group(function () {
    Route::post('/posts', [PostController::class, 'store']);
});
Route::delete('/admin/posts/{id}', function ($id) {
    DB::delete("DELETE FROM posts WHERE id = $id");
});
Route::get('/admin/users', [UserController::class, 'index']);
Route::delete('/admin/users/{id}', [UserController::class, 'destroy']);
Route::controller(PostController::class)->group(function () {
    Route::get('/posts/latest', 'latest');
});
`;
  const posts = `<?php
namespace App\\Http\\Controllers;

use Illuminate\\Http\\Request;
use Illuminate\\Support\\Facades\\DB;

class PostController extends Controller
{
    public function search(Request $request)
    {
        $term = $request->input('q');
        return DB::select("SELECT * FROM posts WHERE title LIKE '%" . $term . "%'");
    }

    public function store(Request $request)
    {
        $post = Post::create($request->all());
        Http::get($request->input('callback'));
        return redirect()->away($request->input('next'));
    }

    public function latest()
    {
        return DB::select('SELECT * FROM posts ORDER BY id DESC LIMIT 10');
    }
}
`;
  const users = `<?php
namespace App\\Http\\Controllers\\Admin;

class UserController extends Controller
{
    public function __construct()
    {
        $this->middleware('auth')->except(['index']);
    }

    public function index(Request $request)
    {
        return User::all();
    }

    public function destroy($id)
    {
        return User::findOrFail($id)->delete();
    }
}
`;
  const files = [
    { path: 'routes/web.php', text: routes },
    { path: 'app/Http/Controllers/PostController.php', text: posts },
    { path: 'app/Http/Controllers/Admin/UserController.php', text: users },
    /* a controller of the same name elsewhere: the route's `use` says which one it means */
    { path: 'app/Http/Controllers/Api/UserController.php', text: '<?php\nclass UserController { public function index() {} }\n' }
  ];
  const result = fires('laravel: controllers and a route closure', files, [
    `SEC-001@app/Http/Controllers/PostController.php:${at(posts, 'DB::select("SELECT')}`,
    `SEC-028@app/Http/Controllers/PostController.php:${at(posts, 'Post::create')}`,
    `SEC-021@app/Http/Controllers/PostController.php:${at(posts, 'Http::get')}`,
    `SEC-020@app/Http/Controllers/PostController.php:${at(posts, 'redirect()->away')}`,
    `SEC-001@routes/web.php:${at(routes, 'DB::delete')}`
  ]);
  assert.strictEqual(result.flows.find(flow => flow.rule === 'SEC-028').verdict, 'needs-validation', 'mass assignment depends on the model, so it is one to confirm');
  const route = (method, path) => result.routes.find(entry => entry.method === method && entry.route === path);
  assert.strictEqual(route('GET', '/posts/search').handlerPath, 'app/Http/Controllers/PostController.php');
  assert.deepStrictEqual(route('POST', '/posts').middleware, ['auth']);
  assert.strictEqual(route('GET', '/admin/users').handlerPath, 'app/Http/Controllers/Admin/UserController.php', 'the imported controller, not its namesake');
  assert.deepStrictEqual(route('GET', '/admin/users').middleware, [], 'the constructor excepts index from auth');
  assert.deepStrictEqual(route('DELETE', '/admin/users/{id}').middleware, ['auth'], 'and applies it to destroy');
  assert.strictEqual(route('GET', '/posts/latest').handlerPath, 'app/Http/Controllers/PostController.php', 'a controller group names only the method');

  const surface = analyseSurface({ routes: result.routes, files });
  const byRoute = new Map(surface.surfaces.map(entry => [`${entry.method} ${entry.route}`, entry]));
  assert.strictEqual(byRoute.get('POST /posts').auth, 'guarded');
  assert.strictEqual(byRoute.get('GET /admin/users').auth, 'open');
  assert(surface.raw.some(item => item.rule === 'ACC-003' && item.line === at(routes, "Route::get('/admin/users'")), 'an open admin listing');
  assert(surface.raw.some(item => item.rule === 'ACC-003' && item.line === at(routes, "Route::delete('/admin/posts")), 'an open admin delete');
  assert(surface.raw.some(item => item.rule === 'ACC-002' && item.line === at(routes, "Route::delete('/admin/users")), 'a guarded delete by any id is one to confirm');
  /* a flow in a controller is reached through the route that names it */
  const search = result.flows.find(flow => flow.rule === 'SEC-001' && flow.path.endsWith('PostController.php'));
  assert.deepStrictEqual(reachOf(search, surface.surfaces), { method: 'GET', route: '/posts/search', auth: 'open', framework: 'laravel' });
  const stored = result.flows.find(flow => flow.rule === 'SEC-021');
  assert.strictEqual(reachOf(stored, surface.surfaces).auth, 'guarded');

  /* ownership: a record fetched by id and tied to the signed-in user is not reported */
  const owned = [{ ...route('DELETE', '/admin/users/{id}'), bodyText: 'public function destroy ( $id ) { return User :: where ( "user_id" , Auth :: id ( ) ) -> findOrFail ( $id ) -> delete ( ) ; }' }];
  assert(!analyseSurface({ routes: owned, files }).raw.some(item => item.rule === 'ACC-002'));
}

/* ---- Symfony -------------------------------------------------------------------------- */

{
  const symfony = `<?php
namespace App\\Controller;

#[Route('/reports')]
class ReportController extends AbstractController
{
    #[Route('/{id}', name: 'report_show', methods: ['GET'])]
    public function show(string $id, Connection $db): Response
    {
        return $this->json($db->executeQuery("SELECT * FROM reports WHERE id = " . $id));
    }

    #[Route('/export', methods: ['POST', 'PUT'])]
    #[IsGranted('ROLE_ADMIN')]
    public function export(Request $request): Response
    {
        return new BinaryFileResponse('/var/reports/' . $request->query->get('file'));
    }
}
`;
  const result = fires('symfony: attributes and DBAL', one('src/Controller/ReportController.php', symfony), [
    `SEC-001@src/Controller/ReportController.php:${at(symfony, 'executeQuery')}`,
    `SEC-022@src/Controller/ReportController.php:${at(symfony, 'BinaryFileResponse')}`
  ]);
  assert.strictEqual(result.flows.find(flow => flow.rule === 'SEC-001').verdict, 'needs-validation', 'a route parameter the router may constrain is one to confirm');
  assert.deepStrictEqual(result.routes.map(entry => `${entry.method} ${entry.route} ${entry.framework}`), ['GET /reports/{id} symfony', 'POST,PUT /reports/export symfony']);
  const surface = analyseSurface({ routes: result.routes, files: [] });
  assert.strictEqual(surface.surfaces.find(entry => entry.route === '/reports/export').auth, 'guarded');
}

/* ---- Robustness ---------------------------------------------------------------------- */

{
  /* names that are also Object.prototype's own are read as names */
  const java = controller(`  @GetMapping("/x")
  public String x(@RequestParam String v) {
    Object o = v.toString();
    return o.constructor(v).hasOwnProperty(v).valueOf();
  }`);
  const result = run(one('X.java', java));
  assert.strictEqual(result.stats.failed, 0);
  const js = { path: 'server/app.js', text: "const app = require('express')();\napp.get('/x', (req, res) => { res.send(String(req.constructor) + req.toString()); });\n", client: false };
  assert.deepStrictEqual(analyseFlows([js]).flows, [], 'req.constructor and req.toString are not request fields');
  const odd = audit.analyse({ files: [{ path: 'constructor', text: 'x' }, { path: 'toString', text: 'y' }, { path: '__proto__', text: 'z' }], paths: ['constructor', 'toString', '__proto__'] });
  assert(Array.isArray(odd.findings), 'files named like Object.prototype members are ordinary files');

  /* the lexer: PHP inline HTML, heredoc and comments; Java text blocks; Go raw strings */
  const tokens = lex('<p>hi</p><?php $a = <<<SQL\nSELECT $b\nSQL;\n# note\n$c = 1; ?><b></b>', 'php');
  assert(tokens.some(token => token.t === 'str' && Array.isArray(token.interp) && token.interp.includes('$b')), 'a heredoc interpolates');
  assert(!tokens.some(token => token.v === 'note' || token.v === 'hi'), 'comments and page text are not code');
  const go = lex('x := `raw ${y}`', 'go');
  assert(go.some(token => token.t === 'str' && token.v === 'raw ${y}'));
  const fns = functionsOf(lex('func (s *Server) Handle(w http.ResponseWriter, r *http.Request) { go func() {}() }', 'go'), 'go');
  assert.deepStrictEqual(fns.map(fn => fn.name), ['Handle', null], 'a method and the literal inside it');

  /* bounded: a file past the size limit is not read, a deadline cuts the rest */
  const big = { path: 'big.go', text: `package main\n${'// x\n'.repeat(10)}` };
  assert.strictEqual(analyseCFamily([big], { maxBytes: 20 }).stats.go, 0);
  let calls = 0;
  const cut = analyseCFamily([{ path: 'a.go', text: 'package a' }, { path: 'b.go', text: 'package b' }], { late: () => (calls += 1) > 1 });
  assert.strictEqual(cut.stats.go + cut.stats.cut, 2);
  assert.strictEqual(cut.stats.cut, 1);
}

/* ---- In the audit ------------------------------------------------------------------- */

{
  const handler = goFile(`func main() { http.HandleFunc("/user", user) }
func user(w http.ResponseWriter, r *http.Request) {
	db.Query("SELECT * FROM users WHERE id = " + r.URL.Query().Get("id"))
}`);
  const java = controller(`  @PostMapping("/users")
  public User create(@RequestBody User user) { return repo.save(user); }`);
  const php = "<?php\necho $_GET['q'];\n";
  const files = [
    { path: 'main.go', text: handler },
    { path: 'src/main/java/com/example/UserController.java', text: java },
    { path: 'public/index.php', text: php },
    /* tests are not the application */
    { path: 'main_test.go', text: goFile('func TestX(t *testing.T) { db.Query("SELECT " + os.Getenv("X")) }') },
    { path: 'src/test/java/com/example/UserControllerTest.java', text: 'class T { void t(HttpServletRequest r) { stmt.executeQuery("SELECT " + r.getParameter("x")); } }' },
    { path: 'go.mod', text: 'module example.com/app\n\ngo 1.22\n' }
  ];
  const result = audit.analyse({ files, paths: files.map(file => file.path) });
  assert.strictEqual(result.engine.version, '2.4.0');
  assert.strictEqual(result.engine.traced.go, 1);
  assert.strictEqual(result.engine.traced.java, 1);
  assert.strictEqual(result.engine.traced.php, 1);
  const sql = result.findings.find(finding => finding.rule === 'SEC-001');
  assert(sql && sql.path === 'main.go' && sql.evidence === 'traced', 'the Go flow is a traced finding');
  assert.deepStrictEqual(sql.reach, { method: 'ANY', route: '/user', auth: 'open', framework: 'go-http' });
  assert(result.findings.some(finding => finding.rule === 'SEC-033' && finding.path === 'public/index.php'));
  assert(result.findings.some(finding => finding.rule === 'ACC-001' && finding.path.endsWith('UserController.java')));
  assert(!result.findings.some(finding => /_test\.go$|src\/test\//.test(finding.path || '')), 'test files are not traced');
  const injection = result.ledger.find(entry => entry.id === 'injection');
  assert.strictEqual(injection.status, 'covered');
  assert.match(injection.detail, /across 3 files/);
  assert.strictEqual(result.surface.counts.endpoints, 2);
  assert(result.surface.endpoints.some(entry => entry.framework === 'spring'));

  /* code the tracer does not read is still named as pattern-checked */
  const kotlin = audit.analyse({ files: [{ path: 'App.kt', text: 'fun main() {}' }], paths: ['App.kt'] });
  assert.match(kotlin.ledger.find(entry => entry.id === 'injection').detail, /JavaScript, TypeScript, Python, Go, Java and PHP, and this code is kt/);

  /* the XXE rule is filed under its weakness */
  const rule = result.findings.length ? audit.RULES['SEC-034'] : null;
  assert(rule && rule.category === 'code');
  const standards = require('../src/security-standards').standardsFor('SEC-034');
  assert.strictEqual(standards.cwe, 'CWE-611');
  assert.strictEqual(standards.owasp, 'A02:2025');
}

/*
 * A file somebody else wrote decides how long the tracer runs. None of these
 * may cost more than a straight read: brackets left open by the thousand,
 * calls nested twenty thousand deep, and a prefix that a pattern would once
 * rescan from every one of its repeats. Each is ~400 KB; read in linear time
 * it takes a fraction of a second, and the quadratic readings these replace
 * took from two to fourteen seconds. The bound leaves room for a slow runner.
 */
{
  const SIZE = 400 * 1024;
  const fill = unit => unit.repeat(Math.floor(SIZE / unit.length));
  const crafted = {
    'XML parser hardening, repeated': { path: 'src/X.java', text: 'class X { void f(javax.xml.parsers.DocumentBuilder b, String s) { b.parse(s); } }\n' + fill('setXIncludeAware(false);') },
    'class-level mapping, unclosed': { path: 'src/B.java', text: fill('@RequestMapping("/a" ') + '\nclass B {}' },
    'class-level guard, no class': { path: 'src/A.java', text: fill('@PreAuthorize(x) ') },
    'Symfony route attributes, unclosed': { path: 'app/C.php', text: '<?php\n' + fill("#[Route('/a' ") },
    'Symfony guard attributes, unclosed': { path: 'app/D.php', text: '<?php\n' + fill('#[IsGranted(x ') },
    'controller middleware, unclosed': { path: 'app/Http/Controllers/E.php', text: '<?php\nclass E { function __construct() { ' + fill("$this->middleware(['a', ") + '} }' },
    'static middleware, never closed': { path: 'app/Http/Controllers/F.php', text: '<?php\nclass F {\n' + fill('public static function middleware(): array {\n') },
    'Go import blocks, unclosed': { path: 'main.go', text: 'package main\n' + fill('import (\n') },
    'calls left open': { path: 'n.php', text: '<?php\n$c = $_GET["c"];\n' + fill('exec(') + 'c' },
    'calls nested deep': { path: 'src/N.java', text: 'class N { void f(String s) { ' + 'g('.repeat(30000) + 's' + ')'.repeat(30000) + '; } }' },
    'Go calls nested deep': { path: 'n.go', text: 'package main\nfunc f(r *http.Request) { x := r.URL.Query().Get("a"); ' + 'exec.Command('.repeat(20000) + 'x' + ')'.repeat(20000) + ' }' }
  };
  for (const [name, file] of Object.entries(crafted)) {
    const started = Date.now();
    analyseCFamily([{ ...file, client: false }], { deadline: Date.now() + 120000 });
    const took = Date.now() - started;
    assert(took < 2500, `${name}: ${took} ms -- a crafted file must not make the tracer quadratic`);
  }
}

console.log('uranus go, java and php tests passed');
