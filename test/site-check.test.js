'use strict';

/*
 * The anonymous site check. Each rule is shown firing on a site that has the
 * problem and staying quiet on one that does not -- and the ways a site
 * check lies are pinned: calling a single-page app's catch-all page a served
 * .env, calling an unreachable site clean, calling a question it could not
 * ask answered, and repeating what it read.
 */

const assert = require('assert');
const { checkSite, declaredSite, siteOrigin, emailDomain, libraryFromAddress, librariesInText, robotsDisallowed, displayPath, LIMITS, STAGES } = require('../src/site-check');

const NOW = Date.UTC(2026, 8, 29, 12, 0, 0);
const DAY = 86_400_000;
const SECURITY_TXT = 'Contact: mailto:security@example.com\nExpires: 2027-06-01T00:00:00Z\n';
const GOOD_HEADERS = Object.freeze({
  'content-type': 'text/html; charset=utf-8',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'content-security-policy': "default-src 'self'; script-src 'self' 'nonce-abc'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'",
  'cross-origin-opener-policy': 'same-origin',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'set-cookie': ['session=x; Path=/; Secure; HttpOnly; SameSite=Lax']
});

/* Fixtures that look like credentials, assembled so no scanner mistakes this file for a leak. */
const STRIPE_LIVE = ['sk', 'live', '9fKq2LmX7vR4tN8wZ3bY6cH1jD5sP0aE'].join('_');
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const ANON_JWT = [b64({ alg: 'HS256', typ: 'JWT' }), b64({ iss: 'supabase', ref: 'abcdefghijklmnopqrst', role: 'anon', iat: 1700000000, exp: 2000000000 }), 'x'.repeat(43)].join('.');

/*
 * A site made of paths. `pages` and `files` answer GET by path; the landing
 * page is `/`. Plain HTTP redirects to HTTPS unless told otherwise, and a
 * request carrying an Origin header is answered by `cors`.
 */
function site({ headers = GOOD_HEADERS, files = {}, pages = {}, spa = false, down = false, page = '<!doctype html><html></html>', plain = 'redirect', missing = 'not found', cors = null, tls = null } = {}) {
  const seen = [];
  const transport = async input => {
    seen.push(input);
    if (down) throw Object.assign(new Error('unreachable'), { code: 'GUARDED_FETCH_TRANSPORT_FAILED' });
    const target = new URL(input.url);
    if (input.plainHttp) {
      if (plain === 'closed') throw Object.assign(new Error('refused'), { code: 'GUARDED_FETCH_TRANSPORT_FAILED' });
      if (plain === 'serves') return { statusCode: 200, headers: { 'content-type': 'text/html' }, body: '', bodyUnread: true };
      return { statusCode: 301, headers: { location: `https://${target.host}/` }, body: '', bodyUnread: true };
    }
    const path = target.pathname;
    if (input.headers && input.headers.origin && cors) return { statusCode: 200, headers: { ...headers, ...cors(input.headers.origin) }, body: page };
    if (path === '/') return { statusCode: 200, headers, body: page, ...(tls ? { tls } : {}) };
    if (Object.prototype.hasOwnProperty.call(pages, path)) {
      const entry = pages[path];
      return { statusCode: 200, headers: { 'content-type': 'text/html', ...(entry.headers || {}) }, body: entry.body };
    }
    if (Object.prototype.hasOwnProperty.call(files, path)) {
      const entry = files[path];
      return typeof entry === 'string'
        ? { statusCode: 200, headers: { 'content-type': 'text/plain' }, body: entry.slice(0, input.maxResponseBytes) }
        : { statusCode: 200, headers: entry.headers || {}, body: String(entry.body).slice(0, input.maxResponseBytes) };
    }
    if (spa) return { statusCode: 200, headers: { 'content-type': 'text/html' }, body: '<!doctype html><html><body>app</body></html>' };
    return { statusCode: 404, headers: { 'content-type': 'text/html' }, body: missing };
  };
  return { transport, seen };
}
const check = (options, extra = {}) => checkSite({ now: () => NOW, random: () => 'fixed', ...options, ...extra });
const rules = result => result.findings.map(finding => finding.rule).sort();
const withContact = files => ({ '/.well-known/security.txt': SECURITY_TXT, ...files });

(async () => {
  /* The origin, and nothing else, is what gets checked. */
  assert.strictEqual(siteOrigin('https://App.Example.com/some/page?x=1#y'), 'https://app.example.com');
  for (const bad of ['http://app.example.com', 'ftp://x', 'https://user:pw@app.example.com', 'https://app.example.com:8443', 'not a url']) {
    assert.throws(() => siteOrigin(bad), error => error.code === 'SITE_URL_INVALID', bad);
  }
  /* A repository's declared homepage is offered only as an origin the check would accept. */
  assert.strictEqual(declaredSite('https://Demo.example.com/docs'), 'https://demo.example.com');
  for (const unusable of ['', null, 'http://demo.example.com', 'demo.example.com', 'https://user:pw@demo.example.com']) {
    assert.strictEqual(declaredSite(unusable), null, String(unusable));
  }

  /* A well-configured site with a security contact has nothing to report, and asks only as a visitor would. */
  {
    const { transport, seen } = site({ files: withContact({}) });
    const stages = [];
    const result = await check({ url: 'https://app.example.com/login', transport, onProgress: update => stages.push(update.stage) });
    assert.deepStrictEqual(rules(result), []);
    assert.strictEqual(result.grade, 'A');
    assert.strictEqual(result.origin, 'https://app.example.com');
    assert.strictEqual(result.engine, 2);
    assert(seen.length <= LIMITS.maxRequests, 'the request budget holds');
    assert.strictEqual(result.requests, seen.length);
    for (const input of seen) {
      assert.strictEqual(input.profile, 'site-probe', 'every request is the anonymous site profile');
      assert.strictEqual(input.method, 'GET');
      assert(!Object.keys(input.headers).some(name => /authorization|cookie/i.test(name)), 'no credential, no cookie');
      const target = new URL(input.url);
      if (input.plainHttp) assert.strictEqual(target.origin, 'http://app.example.com', 'plain HTTP only asks the same host');
      else assert.strictEqual(target.origin, 'https://app.example.com', 'nothing outside the origin is asked');
      assert.strictEqual(target.search, '', 'no query string is ever sent');
    }
    assert.strictEqual(seen.filter(input => input.plainHttp).length, 1);
    assert.deepStrictEqual([...new Set(stages)], STAGES, 'every stage is reported, in order');
    const ledger = Object.fromEntries(result.ledger.map(entry => [entry.id, entry.state]));
    assert.strictEqual(ledger['plain-http'], 'pass');
    assert.strictEqual(ledger.paths, 'pass');
    assert.strictEqual(ledger.contact, 'pass');
    assert.strictEqual(ledger.email, 'unknown', 'no resolver, so the email policy is not checked -- and not called clean');
    assert.strictEqual(ledger.certificate, 'unknown', 'no certificate facts, no claim');
  }

  /* A bare site: every header rule fires. */
  {
    const { transport } = site({ headers: { 'content-type': 'text/html', server: 'nginx/1.18.0', 'x-powered-by': 'Express' } });
    const result = await check({ url: 'https://bare.example.com', transport });
    assert.deepStrictEqual(rules(result), ['WEB-003', 'WEB-005', 'WEB-007', 'WEB-008', 'WEB-009', 'WEB-013', 'WEB-014', 'WEB-016']);
    const cwes = Object.fromEntries(result.findings.map(finding => [finding.rule, finding.standards && finding.standards.cwe]));
    assert.strictEqual(cwes['WEB-005'], 'CWE-693', 'every site finding carries its CWE');
    assert(result.findings.every(finding => finding.standards), 'every site rule is mapped');
    assert.deepStrictEqual(result.headers.filter(header => !header.present).map(header => header.name),
      ['strict-transport-security', 'content-security-policy', 'x-frame-options', 'x-content-type-options', 'referrer-policy', 'permissions-policy',
        'cross-origin-opener-policy', 'cross-origin-resource-policy']);
    /* A report-only policy is named as not enforced. */
    const reportOnly = await check({ url: 'https://ro.example.com', transport: site({ headers: { 'content-type': 'text/html', 'content-security-policy-report-only': "default-src 'self'" } }).transport });
    assert.strictEqual(reportOnly.findings.find(finding => finding.rule === 'WEB-005').where, 'Content-Security-Policy (report-only is not enforced)');
  }

  /* Weak versions of present headers. */
  {
    const { transport } = site({ headers: {
      ...GOOD_HEADERS,
      'strict-transport-security': 'max-age=300',
      'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'",
      'access-control-allow-origin': '*',
      'access-control-allow-credentials': 'true',
      'set-cookie': ['session=x; Path=/', 'prefs=y; Secure']
    } });
    const result = await check({ url: 'https://weak.example.com', transport });
    assert.deepStrictEqual(rules(result), ['WEB-004', 'WEB-006', 'WEB-007', 'WEB-010', 'WEB-011', 'WEB-012', 'WEB-014', 'WEB-017']);
    const cookie = result.findings.find(finding => finding.rule === 'WEB-011');
    assert.strictEqual(cookie.where, 'Set-Cookie: session', 'a cookie is named, its value never repeated');
    assert(!JSON.stringify(result).includes('session=x'));
  }

  /* A nonce makes 'unsafe-inline' inert; a script-src open to anywhere is its own finding, unless 'strict-dynamic' governs it. */
  {
    const nonce = await check({ url: 'https://nonce.example.com', transport: site({ headers: { ...GOOD_HEADERS, 'content-security-policy': "script-src 'self' 'unsafe-inline' 'nonce-r4nd0m'; frame-ancestors 'none'" } }).transport });
    assert(!rules(nonce).includes('WEB-006'));
    for (const [policy, fires] of [
      ["default-src 'self'; script-src 'self' https:; object-src 'none'; base-uri 'none'", true],
      ["default-src *; object-src 'none'; base-uri 'none'", true],
      ["script-src 'self' data:; object-src 'none'; base-uri 'none'", true],
      ["script-src 'nonce-a' 'strict-dynamic' https: 'unsafe-inline'; object-src 'none'; base-uri 'none'", false],
      ["script-src 'self' https://cdn.example.net; object-src 'none'; base-uri 'none'", false]
    ]) {
      const result = await check({ url: 'https://csp.example.com', transport: site({ headers: { ...GOOD_HEADERS, 'content-security-policy': policy }, files: withContact({}) }).transport });
      assert.strictEqual(rules(result).includes('WEB-032'), fires, policy);
    }
  }

  /* A policy that leaves base URLs or plugins open, a page that is not isolated, what the markup loads and sends. */
  {
    const loose = { ...GOOD_HEADERS, 'content-security-policy': "default-src 'self'; script-src 'self' 'nonce-abc'" };
    assert(rules(await check({ url: 'https://loose.example.com', transport: site({ headers: loose, files: withContact({}) }).transport })).includes('WEB-017'));
    const unisolated = { ...GOOD_HEADERS };
    delete unisolated['cross-origin-opener-policy'];
    assert(rules(await check({ url: 'https://o.example.com', transport: site({ headers: unisolated }).transport })).includes('WEB-016'));

    const page = [
      '<!doctype html><html><head>',
      '<link rel="stylesheet" href="http://cdn.example.net/site.css">',
      '<script src="https://cdn.thirdparty.test/lib.js"></script>',
      '<script src="https://cdn.signed.test/lib.js" integrity="sha384-abc" crossorigin="anonymous"></script>',
      '<script src="/app.js"></script><a href="http://example.org/">a link is not a load</a>',
      '<form method="post" action="http://collect.example.org/signup"><input name="email"></form>',
      '</head></html>'
    ].join('');
    const markup = await check({ url: 'https://m.example.com', transport: site({ page, files: withContact({}) }).transport });
    const byRule = Object.fromEntries(markup.findings.map(finding => [finding.rule, finding]));
    assert.strictEqual(byRule['WEB-018'].where, 'http://cdn.example.net', 'named by host, never the full address');
    assert.strictEqual(byRule['WEB-019'].where, '<script src> from cdn.thirdparty.test');
    assert.strictEqual(byRule['WEB-033'].where, '<form action> to http://collect.example.org');
    assert.deepStrictEqual(markup.scripts.thirdParty, ['cdn.thirdparty.test', 'cdn.signed.test']);
    const clean = '<!doctype html><script src="/app.js"></script><script src="https://cdn.signed.test/x.js" integrity="sha512-z"></script><a href="http://x.test">x</a><form action="/login"></form>';
    const quiet = await check({ url: 'https://q.example.com', transport: site({ page: clean, files: withContact({}) }).transport });
    assert(!['WEB-018', 'WEB-019', 'WEB-033'].some(rule => rules(quiet).includes(rule)));

    /* X-Frame-Options is covered by frame-ancestors, and the tile says so. */
    const isolated = await check({ url: 'https://ok.example.com', transport: site({ files: withContact({}) }).transport });
    const tile = isolated.headers.find(header => header.name === 'x-frame-options');
    assert.deepStrictEqual({ present: tile.present, via: tile.via }, { present: false, via: 'content-security-policy' });
    assert.strictEqual(isolated.headers.length, 8);
  }

  /* The certificate and the protocol: close to expiry, very close, fine; and an old protocol. */
  {
    const at = days => ({ protocol: 'TLSv1.3', validTo: new Date(NOW + days * DAY).toISOString(), issuer: 'Let’s Encrypt' });
    const soon = await check({ url: 'https://c.example.com', transport: site({ tls: at(10), files: withContact({}) }).transport });
    assert.deepStrictEqual(rules(soon), ['WEB-029']);
    assert.strictEqual(soon.transport.certificate.daysLeft, 10);
    assert.strictEqual(soon.findings[0].where, 'Certificate for c.example.com');
    assert.deepStrictEqual(rules(await check({ url: 'https://c.example.com', transport: site({ tls: at(21), files: withContact({}) }).transport })), ['WEB-030']);
    const fine = await check({ url: 'https://c.example.com', transport: site({ tls: at(80), files: withContact({}) }).transport });
    assert.deepStrictEqual(rules(fine), []);
    assert.strictEqual(fine.ledger.find(entry => entry.id === 'certificate').detail, 'Valid for 80 more days, issued by Let’s Encrypt');
    assert.strictEqual(fine.ledger.find(entry => entry.id === 'protocol').detail, 'Negotiated TLS 1.3');
    const old = await check({ url: 'https://c.example.com', transport: site({ tls: { ...at(80), protocol: 'TLSv1.1' }, files: withContact({}) }).transport });
    assert.deepStrictEqual(rules(old), ['WEB-031']);
  }

  /* Plain HTTP: serving the site is a finding; redirecting, or nothing listening, is not. */
  {
    const serves = await check({ url: 'https://p.example.com', transport: site({ plain: 'serves', files: withContact({}) }).transport });
    assert.deepStrictEqual(rules(serves), ['WEB-020']);
    assert.strictEqual(serves.findings[0].where, 'http://p.example.com/');
    assert.strictEqual(serves.transport.plainHttp, 'serves');
    const closed = await check({ url: 'https://p.example.com', transport: site({ plain: 'closed', files: withContact({}) }).transport });
    assert.deepStrictEqual(rules(closed), []);
    assert.strictEqual(closed.transport.plainHttp, 'closed');
    assert.strictEqual((await check({ url: 'https://p.example.com', transport: site({ files: withContact({}) }).transport })).transport.plainHttp, 'redirects');
  }

  /* Cross-origin reads: an origin reflected with credentials is found; a reflection without credentials, or none, is not. */
  {
    const reflecting = await check({ url: 'https://r.example.com', transport: site({ files: withContact({}), cors: origin => ({ 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' }) }).transport });
    assert.deepStrictEqual(rules(reflecting), ['WEB-010']);
    assert.strictEqual(reflecting.findings[0].where, 'Access-Control-Allow-Origin (reflects any origin)');
    const publicApi = await check({ url: 'https://r.example.com', transport: site({ files: withContact({}), cors: origin => ({ 'access-control-allow-origin': origin }) }).transport });
    assert.deepStrictEqual(rules(publicApi), []);
  }

  /* Served secrets are reported, capped, and never quoted -- the older files and the new ones alike. */
  {
    const { transport } = site({ files: {
      '/.env': 'DATABASE_URL=postgres-canary-value\nAPI_KEY=abc\n',
      '/.git/HEAD': 'ref: refs/heads/main\n',
      '/.DS_Store': '\u0000\u0000\u0000\u0001Bud1\u0000\u0000',
      '/.aws/credentials': '[default]\naws_access_key_id = canary-aws\n',
      '/.npmrc': '//registry.npmjs.org/:_authToken=canary-npm\n',
      '/.svn/entries': '12\n',
      '/actuator/env': '{"activeProfiles":["prod"],"propertySources":[]}',
      '/server-status': { headers: { 'content-type': 'text/html' }, body: '<html><title>Apache Status</title><h1>Apache Server Status for canary.host</h1></html>' }
    } });
    const result = await check({ url: 'https://leaky.example.com', transport });
    assert.deepStrictEqual([...new Set(rules(result))].filter(rule => rule !== 'WEB-014'), ['WEB-001', 'WEB-002', 'WEB-015', 'WEB-034', 'WEB-035', 'WEB-036']);
    assert.strictEqual(result.findings[0].severity, 'critical');
    assert(result.score <= 49 && result.grade === 'F');
    assert.strictEqual(result.capped, false, 'capped means the cap lowered the score; here the findings already had');
    assert(!JSON.stringify(result).includes('canary'), 'what a served file holds never leaves the check');
    assert.deepStrictEqual(result.findings.filter(finding => finding.rule === 'WEB-034').map(finding => finding.where).sort(), ['/actuator/env', '/server-status']);
    assert.strictEqual(result.ledger.find(entry => entry.id === 'paths').state, 'fail');
  }

  /* One served .env on an otherwise sound site: the cap is what holds it at 49. */
  {
    const result = await check({ url: 'https://one.example.com', transport: site({ files: withContact({ '/.env': 'SECRET_KEY=x\n' }) }).transport });
    assert.deepStrictEqual(rules(result), ['WEB-001']);
    assert.strictEqual(result.score, 49);
    assert.strictEqual(result.capped, true);
  }

  /* A single-page app answers every path with its page; that is not a served file, a contact or a diagnostics page. */
  {
    const result = await check({ url: 'https://spa.example.com', transport: site({ spa: true }).transport });
    assert(!rules(result).some(rule => ['WEB-001', 'WEB-002', 'WEB-015', 'WEB-034', 'WEB-035', 'WEB-036'].includes(rule)));
    assert(rules(result).includes('WEB-014'), 'nor is the catch-all page a security.txt');
  }

  /* What a missing page gives away, and a directory listing. */
  {
    const django = '<html><body><h1>Page not found (404)</h1><p>You&#x27;re seeing this error because you have <code>DEBUG = True</code> in your Django settings file.</p></body></html>';
    const debug = await check({ url: 'https://d.example.com', transport: site({ files: withContact({}), missing: django }).transport });
    assert.deepStrictEqual(rules(debug), ['WEB-021']);
    assert.strictEqual(debug.findings[0].where, 'Django debug page on a missing page');
    const node = 'TypeError: Cannot read properties of undefined (reading \'id\')<br> &nbsp; &nbsp;at Layer.handle (/app/node_modules/express/lib/router/layer.js:95:5)';
    assert.deepStrictEqual(rules(await check({ url: 'https://d.example.com', transport: site({ files: withContact({}), missing: node }).transport })), ['WEB-021']);
    const plain404 = await check({ url: 'https://d.example.com', transport: site({ files: withContact({}), missing: '<h1>Not Found</h1>' }).transport });
    assert.deepStrictEqual(rules(plain404), []);
    assert.strictEqual(plain404.ledger.find(entry => entry.id === 'errors').detail, 'A missing page answers 404 without a stack trace');
    /* A page that quotes a traceback -- documentation -- is not a debug page; a framework's own debug page is, wherever it appears. */
    const docs = await check({ url: 'https://docs.example.com', transport: site({ files: withContact({}), page: '<a href="/errors">Errors</a>', pages: {
      '/errors': { body: '<pre>Traceback (most recent call last):\n  File "app.py", line 3</pre>' }
    } }).transport });
    assert(!rules(docs).includes('WEB-021'));
    const werkzeug = await check({ url: 'https://w.example.com', transport: site({ files: withContact({}), page: '<a href="/admin">Admin</a>', pages: {
      '/admin': { body: '<title>Werkzeug Debugger</title>' }
    } }).transport });
    assert.strictEqual(werkzeug.findings.find(finding => finding.rule === 'WEB-021').where, 'Werkzeug debugger on /admin');
    const listing = await check({ url: 'https://l.example.com', transport: site({ files: withContact({}), page: '<html><head><title>Index of /</title></head><body><a href="backup.zip">backup.zip</a></body></html>' }).transport });
    assert(rules(listing).includes('WEB-022'));
  }

  /*
   * The pages a visitor reaches: this origin only, never a sign-out or a
   * file, nothing robots.txt closes, no query string sent, no token-shaped
   * path repeated -- and what those pages set and send is judged too.
   */
  {
    const landing = [
      '<!doctype html><html><body>',
      '<a href="/about">About</a><a href="/login?next=/x">Sign in</a><a href="/logout">Sign out</a>',
      '<a href="/admin/panel">Admin</a><a href="/files/report.pdf">PDF</a><a href="https://elsewhere.test/">x</a>',
      '<a href="/reset/Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z">reset</a><a href="#top">top</a>',
      '</body></html>'
    ].join('');
    const { transport, seen } = site({
      page: landing,
      files: withContact({ '/robots.txt': 'User-agent: *\nDisallow: /admin\n\nUser-agent: Googlebot\nDisallow: /about\n' }),
      pages: {
        '/about': { body: '<html><body>About us</body></html>' },
        '/login': { body: '<html><form action="http://auth.example.org/session" method="post"><input type="password"></form></html>', headers: { 'set-cookie': ['csrf=abc; Path=/'] } }
      }
    });
    const result = await check({ url: 'https://crawl.example.com', transport });
    const asked = seen.filter(input => !input.plainHttp).map(input => new URL(input.url).pathname);
    assert(asked.includes('/login') && asked.includes('/about'));
    for (const never of ['/logout', '/admin/panel', '/files/report.pdf']) assert(!asked.includes(never), `${never} is not requested`);
    assert(!asked.some(path => path.startsWith('/reset/')), 'a path carrying a token is not followed');
    assert.deepStrictEqual(result.pages.map(entry => entry.path).sort(), ['/', '/about', '/login']);
    assert(rules(result).includes('WEB-033'), 'the sign-in form posts over plain HTTP');
    assert.strictEqual(result.findings.find(finding => finding.rule === 'WEB-011').where, 'Set-Cookie: csrf', 'a cookie a crawled page sets counts');
    assert.strictEqual(robotsDisallowed('User-agent: *\nDisallow: /private/*\nDisallow:\n').join(','), '/private/');
  }

  /*
   * The JavaScript: a server-side secret shipped in a bundle is reported by
   * kind and script, never by value; a public-by-design key is not a
   * finding; a public source map is; and a library with published
   * advisories is found by its banner or its CDN address and checked
   * against OSV.
   */
  {
    const bundle = `/*! jQuery v1.12.4 | (c) jQuery Foundation */\n!function(){var k="${STRIPE_LIVE}";var anon="${ANON_JWT}";}();\n//# sourceMappingURL=app.js.map`;
    const landing = '<!doctype html><script src="/assets/app.js"></script><script src="https://cdnjs.cloudflare.com/ajax/libs/lodash.js/4.17.15/lodash.min.js"></script>';
    const osvAsked = [];
    const advisoryTransport = async input => {
      osvAsked.push(input);
      assert.strictEqual(input.profile, 'advisory-query');
      if (input.method === 'POST') {
        const queries = JSON.parse(input.body).queries;
        return { statusCode: 200, body: JSON.stringify({ results: queries.map(query => ({ vulns: query.package.name === 'jquery' ? [{ id: 'GHSA-gxr4-xjj5-5px2' }, { id: 'GHSA-rmxg-73gg-4p98' }] : [] })) }) };
      }
      const id = decodeURIComponent(new URL(input.url).pathname.split('/').pop());
      const cve = id === 'GHSA-gxr4-xjj5-5px2' ? 'CVE-2020-11022' : 'CVE-2015-9251';
      return { statusCode: 200, body: JSON.stringify({ id, aliases: [cve], database_specific: { severity: 'MODERATE' }, affected: [{ package: { ecosystem: 'npm', name: 'jquery' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: id === 'GHSA-gxr4-xjj5-5px2' ? '3.5.0' : '3.0.0' }] }] }] }) };
    };
    const { transport, seen } = site({
      page: landing,
      files: withContact({
        '/assets/app.js': { headers: { 'content-type': 'application/javascript' }, body: bundle },
        '/assets/app.js.map': { headers: { 'content-type': 'application/json' }, body: '{"version":3,"sources":["src/secret-logic.ts"],"mappings":"AAAA"}' }
      })
    });
    const result = await check({ url: 'https://js.example.com', transport, advisoryTransport });
    const secret = result.findings.find(finding => finding.rule === 'WEB-023');
    assert(secret, 'the live secret key is found');
    assert.strictEqual(secret.severity, 'critical');
    assert.match(secret.where, / in \/assets\/app\.js$/);
    assert.strictEqual(result.findings.filter(finding => finding.rule === 'WEB-023').length, 1, 'the anonymous key is public by design and is not a finding');
    assert.strictEqual(result.findings.find(finding => finding.rule === 'WEB-024').where, '/assets/app.js.map');
    const library = result.findings.find(finding => finding.rule === 'WEB-025');
    assert.strictEqual(library.where, 'jquery 1.12.4');
    assert.strictEqual(library.severity, 'warning', 'moderate advisories make a warning');
    assert.match(library.why, /2 published advisories: CVE-2020-11022, CVE-2015-9251\./);
    assert.match(library.fix, /Version 3\.5\.0 fixes them\./);
    assert.deepStrictEqual(result.libraries.map(entry => `${entry.name}@${entry.version}:${entry.source}:${entry.state}`).sort(), ['jquery@1.12.4:banner:vulnerable', 'lodash@4.17.15:address:clean']);
    assert(!seen.some(input => new URL(input.url).host === 'cdnjs.cloudflare.com'), 'a third-party script is recognised by its address, never fetched');
    assert(osvAsked.every(input => new URL(input.url).host === 'api.osv.dev'));
    assert.deepStrictEqual({ ...result.scripts, thirdParty: [...result.scripts.thirdParty] }, { read: 1, onOrigin: 1, kilobytes: 1, thirdParty: ['cdnjs.cloudflare.com'], sourceMaps: 1 });
    const text = JSON.stringify(result);
    assert(!text.includes(STRIPE_LIVE) && !text.includes(ANON_JWT) && !text.includes('secret-logic'), 'no secret, key or source leaves the check');
    /* Without the advisory transport the libraries are named, and not called clean. */
    const unasked = await check({ url: 'https://js.example.com', transport: site({ page: landing, files: withContact({ '/assets/app.js': { body: bundle } }) }).transport });
    assert(unasked.libraries.every(entry => entry.state === 'unknown'));
    assert.strictEqual(unasked.ledger.find(entry => entry.id === 'libraries').state, 'unknown');
    assert(!rules(unasked).includes('WEB-025'));
  }

  /* Libraries by banner and by address. */
  assert.deepStrictEqual(libraryFromAddress('https://cdn.jsdelivr.net/npm/bootstrap@4.3.1/dist/js/bootstrap.min.js'), { name: 'bootstrap', version: '4.3.1', source: 'address' });
  assert.deepStrictEqual(libraryFromAddress('https://code.jquery.com/jquery-3.4.1.min.js'), { name: 'jquery', version: '3.4.1', source: 'address' });
  assert.deepStrictEqual(libraryFromAddress('https://unpkg.com/vue@2.6.14/dist/vue.js'), { name: 'vue', version: '2.6.14', source: 'address' });
  assert.strictEqual(libraryFromAddress('https://cdn.example.com/app-1.2.3.js'), null);
  assert.deepStrictEqual(libraryFromAddress('https://blog.example.com/wp-includes/js/jquery/jquery.min.js?ver=3.6.0'), { name: 'jquery', version: '3.6.0', source: 'address' });
  assert.strictEqual(libraryFromAddress('https://blog.example.com/wp-includes/js/jquery/jquery.min.js?ver=abc'), null);
  assert.deepStrictEqual(librariesInText('/*!\n * AngularJS v1.7.9\n */').map(entry => entry.name), ['angular']);
  assert.deepStrictEqual(librariesInText('//! moment.js\n//! version : 2.29.1\n').map(entry => `${entry.name}@${entry.version}`), ['moment@2.29.1']);

  /* Email: a missing SPF and a DMARC policy of none are found; a shared platform's domain is not the site's to answer for. */
  {
    const asked = [];
    const txt = async name => {
      asked.push(name);
      if (name === 'example.co.uk') return ['google-site-verification=abc'];
      if (name === '_dmarc.example.co.uk') return ['v=DMARC1; p=none; rua=mailto:d@example.co.uk'];
      return [];
    };
    const result = await check({ url: 'https://www.shop.example.co.uk', transport: site({ files: withContact({}) }).transport, txt });
    assert.deepStrictEqual(asked, ['example.co.uk', '_dmarc.example.co.uk'], 'the registrable domain, not the web host');
    assert.deepStrictEqual(rules(result), ['WEB-027', 'WEB-028']);
    assert.deepStrictEqual({ ...result.email }, { state: 'checked', reason: null, domain: 'example.co.uk', spf: 'missing', dmarc: 'none' });
    const strict = async name => (name.startsWith('_dmarc.') ? ['v=DMARC1; p=reject'] : ['v=spf1 include:_spf.mail.test -all']);
    const good = await check({ url: 'https://example.com', transport: site({ files: withContact({}) }).transport, txt: strict });
    assert.deepStrictEqual(rules(good), []);
    assert.strictEqual(good.ledger.find(entry => entry.id === 'email').detail, 'example.com: SPF strict, DMARC p=reject');
    const open = async name => (name.startsWith('_dmarc.') ? ['v=DMARC1; p=quarantine'] : ['v=spf1 +all']);
    assert.deepStrictEqual(rules(await check({ url: 'https://example.com', transport: site({ files: withContact({}) }).transport, txt: open })), ['WEB-028']);
    let platformAsked = false;
    const platform = await check({ url: 'https://my-app.onrender.com', transport: site({ files: withContact({}) }).transport, txt: async () => { platformAsked = true; return []; } });
    assert.strictEqual(platformAsked, false);
    assert.strictEqual(platform.email.state, 'skipped');
    assert.strictEqual(platform.ledger.find(entry => entry.id === 'email').state, 'skip');
    const failing = await check({ url: 'https://example.com', transport: site({ files: withContact({}) }).transport, txt: async () => { throw new Error('SERVFAIL'); } });
    assert.deepStrictEqual(rules(failing), [], 'a resolver that could not answer is not a missing record');
    assert.strictEqual(failing.email.state, 'partial');
    assert.deepStrictEqual(emailDomain('a.b.example.com'), { domain: 'example.com' });
    assert.deepStrictEqual(emailDomain('docs.vercel.app'), { skipped: 'shared-platform' });
  }

  /* The security contact must say until when it is current. */
  {
    const none = await check({ url: 'https://s.example.com', transport: site({ files: { '/.well-known/security.txt': 'Contact: mailto:a@b.c\n' } }).transport });
    assert.deepStrictEqual(rules(none), ['WEB-026']);
    const lapsed = await check({ url: 'https://s.example.com', transport: site({ files: { '/.well-known/security.txt': 'Contact: mailto:a@b.c\nExpires: 2025-01-01T00:00:00Z\n' } }).transport });
    assert.deepStrictEqual(rules(lapsed), ['WEB-026']);
  }

  /* The budget holds whatever the site offers: requests and time. */
  {
    const links = Array.from({ length: 40 }, (_, index) => `<a href="/p${index}">p</a><script src="/s${index}.js"></script>`).join('');
    const { transport, seen } = site({ page: `<!doctype html>${links}`, files: withContact({}) });
    const result = await check({ url: 'https://big.example.com', transport, limits: { ...LIMITS, maxRequests: 30 } });
    assert(seen.length <= 30, `at most thirty requests, made ${seen.length}`);
    assert(result.pages.length <= LIMITS.maxPages + 1);
    /* Each request costs six seconds here: none starts once the forty-five are spent, and each is given only what is left. */
    let clock = NOW;
    const starts = [];
    const slow = async input => { starts.push({ at: clock, deadlineMs: input.deadlineMs }); clock += 6000; return transport(input); };
    await checkSite({ url: 'https://big.example.com', transport: slow, now: () => clock, random: () => 'r', limits: { ...LIMITS, deadlineMs: 45_000 } });
    assert(starts.every(start => start.at - NOW <= 44_000), 'nothing starts once the time is spent');
    assert(starts.every(start => start.at - NOW + start.deadlineMs <= 45_000), 'no request may outlive the check');
  }

  /*
   * The page a visitor lands on: redirects are followed, over HTTPS only and
   * at most three, and everything after them asks the origin they settled on.
   */
  {
    const seen = [];
    const transport = async input => {
      seen.push(input);
      const target = new URL(input.url);
      if (input.plainHttp) return { statusCode: 301, headers: { location: `https://${target.host}/` }, body: '' };
      if (target.origin === 'https://apex.example.com') return { statusCode: 301, headers: { location: 'https://www.apex.example.com/', 'set-cookie': ['first=1; Path=/'] }, body: '' };
      if (target.pathname === '/') return { statusCode: 302, headers: { location: '/en?utm=x' }, body: '' };
      if (target.pathname === '/en') return { statusCode: 200, headers: GOOD_HEADERS, body: '<!doctype html>' };
      if (target.pathname === '/.well-known/security.txt') return { statusCode: 200, headers: { 'content-type': 'text/plain' }, body: SECURITY_TXT };
      return { statusCode: 404, headers: {}, body: '' };
    };
    const result = await check({ url: 'https://apex.example.com', transport });
    assert.strictEqual(result.origin, 'https://www.apex.example.com');
    assert.strictEqual(result.requested, 'https://apex.example.com');
    assert.strictEqual(result.redirects, 2);
    assert.strictEqual(result.status, 200);
    assert.deepStrictEqual(rules(result), ['WEB-011'], 'the landed page is judged, and a cookie set on the way counts');
    assert.strictEqual(result.findings[0].where, 'Set-Cookie: first');
    assert.deepStrictEqual(seen.slice(0, 3).map(input => input.url), ['https://apex.example.com/', 'https://www.apex.example.com/', 'https://www.apex.example.com/en'], 'the query is dropped, never sent');
    assert(seen.slice(3).every(input => new URL(input.url).host === 'www.apex.example.com'), 'the rest is asked of where the page settled');
  }
  for (const [label, location, code] of [
    ['to plain HTTP', 'http://insecure.example.com/', 'SITE_REDIRECT_REFUSED'],
    ['to another port', 'https://other.example.com:8443/', 'SITE_REDIRECT_REFUSED'],
    ['in a loop', '/again', 'SITE_REDIRECT_LOOP']
  ]) {
    let asked = 0;
    const transport = async () => { asked += 1; return { statusCode: 302, headers: { location }, body: '' }; };
    await assert.rejects(check({ url: 'https://hop.example.com', transport }), error => error.code === code && error.status === 502, label);
    assert(asked <= 4, `${label}: at most three redirects are followed`);
  }

  /* An unreachable site is an error, never a clean report. */
  await assert.rejects(check({ url: 'https://down.example.com', transport: site({ down: true }).transport }), error => error.code === 'SITE_UNREACHABLE' && error.status === 502);

  /* Prompts carry the place and the fix, and ask for proof. */
  {
    const result = await check({ url: 'https://bare.example.com', transport: site({ headers: { 'content-type': 'text/html' } }).transport });
    const hsts = result.findings.find(finding => finding.rule === 'WEB-003');
    assert.match(hsts.prompt, /^On the deployed site \(Strict-Transport-Security\): /);
    assert.match(hsts.prompt, /verify it by requesting the page/);
  }

  /* A place is shown without the identifiers a path can carry. */
  assert.strictEqual(displayPath('/reset/Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z?x=1'), '/reset/…');
  assert.strictEqual(displayPath('/assets/index-4f3a2b.js'), '/assets/index-4f3a2b.js');

  console.log('site check tests passed');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
