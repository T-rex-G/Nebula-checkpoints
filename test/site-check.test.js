'use strict';

/*
 * The anonymous site check. Each rule is shown firing on a site that has the
 * problem and staying quiet on one that does not -- and the two ways a site
 * check lies are pinned: calling a single-page app's catch-all page a served
 * .env, and calling an unreachable site clean.
 */

const assert = require('assert');
const { checkSite, declaredSite, siteOrigin } = require('../src/site-check');

const GOOD_HEADERS = Object.freeze({
  'content-type': 'text/html; charset=utf-8',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'content-security-policy': "default-src 'self'; script-src 'self' 'nonce-abc'; frame-ancestors 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'set-cookie': ['session=x; Path=/; Secure; HttpOnly; SameSite=Lax']
});

function site({ headers = GOOD_HEADERS, files = {}, spa = false, down = false } = {}) {
  const seen = [];
  const transport = async input => {
    seen.push(input);
    if (down) throw Object.assign(new Error('unreachable'), { code: 'GUARDED_FETCH_TRANSPORT_FAILED' });
    const path = new URL(input.url).pathname;
    if (path === '/') return { statusCode: 200, headers, body: '<!doctype html><html></html>' };
    if (Object.prototype.hasOwnProperty.call(files, path)) return { statusCode: 200, headers: { 'content-type': 'text/plain' }, body: files[path] };
    if (spa) return { statusCode: 200, headers: { 'content-type': 'text/html' }, body: '<!doctype html><html><body>app</body></html>' };
    return { statusCode: 404, headers: {}, body: 'not found' };
  };
  return { transport, seen };
}
const rules = result => result.findings.map(finding => finding.rule).sort();

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

  /* A well-configured site with a security contact has nothing to report. */
  {
    const { transport, seen } = site({ files: { '/.well-known/security.txt': 'Contact: mailto:security@example.com\nExpires: 2027-01-01T00:00:00Z\n' } });
    const result = await checkSite({ url: 'https://app.example.com/login', transport });
    assert.deepStrictEqual(rules(result), []);
    assert.strictEqual(result.grade, 'A');
    assert.strictEqual(result.origin, 'https://app.example.com');
    assert(seen.length <= 10, 'ten requests at most');
    for (const input of seen) {
      assert.strictEqual(input.profile, 'site-probe', 'every request is the anonymous site profile');
      assert(['GET', 'HEAD'].includes(input.method));
      assert(!Object.keys(input.headers).some(name => /authorization|cookie/i.test(name)), 'no credential, no cookie');
      assert(new URL(input.url).origin === 'https://app.example.com', 'nothing outside the origin is asked');
    }
  }

  /* A bare site: every header rule fires. */
  {
    const { transport } = site({ headers: { 'content-type': 'text/html', server: 'nginx/1.18.0', 'x-powered-by': 'Express' } });
    const result = await checkSite({ url: 'https://bare.example.com', transport });
    assert.deepStrictEqual(rules(result), ['WEB-003', 'WEB-005', 'WEB-007', 'WEB-008', 'WEB-009', 'WEB-013', 'WEB-014']);
    assert.deepStrictEqual(result.headers.filter(header => !header.present).map(header => header.name),
      ['strict-transport-security', 'content-security-policy', 'x-frame-options', 'x-content-type-options', 'referrer-policy', 'permissions-policy']);
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
    const result = await checkSite({ url: 'https://weak.example.com', transport });
    assert.deepStrictEqual(rules(result), ['WEB-004', 'WEB-006', 'WEB-007', 'WEB-010', 'WEB-011', 'WEB-012', 'WEB-014']);
    const cookie = result.findings.find(finding => finding.rule === 'WEB-011');
    assert.strictEqual(cookie.where, 'Set-Cookie: session', 'a cookie is named, its value never repeated');
    assert(!JSON.stringify(result).includes('session=x'));
  }

  /* A nonce makes 'unsafe-inline' inert, as CSP level 2 browsers treat it. */
  {
    const { transport } = site({ headers: { ...GOOD_HEADERS, 'content-security-policy': "script-src 'self' 'unsafe-inline' 'nonce-r4nd0m'; frame-ancestors 'none'" } });
    const result = await checkSite({ url: 'https://nonce.example.com', transport });
    assert(!rules(result).includes('WEB-006'));
  }

  /* Served secrets are reported, capped, and never quoted. */
  {
    const { transport } = site({ files: {
      '/.env': 'DATABASE_URL=postgres-canary-value\nAPI_KEY=abc\n',
      '/.git/HEAD': 'ref: refs/heads/main\n',
      '/.DS_Store': '\u0000\u0000\u0000\u0001Bud1\u0000\u0000'
    } });
    const result = await checkSite({ url: 'https://leaky.example.com', transport });
    assert.deepStrictEqual(rules(result).filter(rule => rule !== 'WEB-014'), ['WEB-001', 'WEB-002', 'WEB-015']);
    assert.strictEqual(result.findings[0].severity, 'critical');
    assert(result.score <= 49 && result.grade === 'F');
    assert.strictEqual(result.capped, false, 'capped means the cap lowered the score; here the findings already had');
    assert(!JSON.stringify(result).includes('canary'), 'what a served file holds never leaves the check');
    assert.strictEqual(result.findings.find(finding => finding.rule === 'WEB-001').where, '/.env');
  }

  /* One served .env on an otherwise sound site: the cap is what holds it at 49. */
  {
    const { transport } = site({ files: { '/.env': 'SECRET_KEY=x\n', '/.well-known/security.txt': 'Contact: mailto:a@b.c\n' } });
    const result = await checkSite({ url: 'https://one.example.com', transport });
    assert.deepStrictEqual(rules(result), ['WEB-001']);
    assert.strictEqual(result.score, 49);
    assert.strictEqual(result.capped, true);
  }

  /* A single-page app answers every path with its page; that is not a served .env. */
  {
    const { transport } = site({ spa: true });
    const result = await checkSite({ url: 'https://spa.example.com', transport });
    assert(!rules(result).some(rule => ['WEB-001', 'WEB-002', 'WEB-015'].includes(rule)));
    assert(rules(result).includes('WEB-014'), 'nor is the catch-all page a security.txt');
  }

  /*
   * The page a visitor lands on: redirects are followed, over HTTPS only and
   * at most three, and everything after them asks the origin they settled on.
   */
  {
    const seen = [];
    const transport = async input => {
      seen.push(input.url);
      const target = new URL(input.url);
      if (target.origin === 'https://apex.example.com') return { statusCode: 301, headers: { location: 'https://www.apex.example.com/', 'set-cookie': ['first=1; Path=/'] }, body: '' };
      if (target.pathname === '/') return { statusCode: 302, headers: { location: '/en?utm=x' }, body: '' };
      if (target.pathname === '/en') return { statusCode: 200, headers: GOOD_HEADERS, body: '<!doctype html>' };
      if (target.pathname === '/.well-known/security.txt') return { statusCode: 200, headers: { 'content-type': 'text/plain' }, body: 'Contact: mailto:a@b.c\n' };
      return { statusCode: 404, headers: {}, body: '' };
    };
    const result = await checkSite({ url: 'https://apex.example.com', transport });
    assert.strictEqual(result.origin, 'https://www.apex.example.com');
    assert.strictEqual(result.requested, 'https://apex.example.com');
    assert.strictEqual(result.redirects, 2);
    assert.strictEqual(result.status, 200);
    assert.deepStrictEqual(rules(result), ['WEB-011'], 'the landed page is judged, and a cookie set on the way counts');
    assert.strictEqual(result.findings[0].where, 'Set-Cookie: first');
    assert.deepStrictEqual(seen.slice(0, 3), ['https://apex.example.com/', 'https://www.apex.example.com/', 'https://www.apex.example.com/en'], 'the query is dropped, never sent');
    assert(seen.slice(3).every(address => address.startsWith('https://www.apex.example.com/.')), 'the paths are asked of where the page settled');
    assert(seen.length <= 10);
  }
  for (const [label, location, code] of [
    ['to plain HTTP', 'http://insecure.example.com/', 'SITE_REDIRECT_REFUSED'],
    ['to another port', 'https://other.example.com:8443/', 'SITE_REDIRECT_REFUSED'],
    ['in a loop', '/again', 'SITE_REDIRECT_LOOP']
  ]) {
    let asked = 0;
    const transport = async () => { asked += 1; return { statusCode: 302, headers: { location }, body: '' }; };
    await assert.rejects(checkSite({ url: 'https://hop.example.com', transport }), error => error.code === code && error.status === 502, label);
    assert(asked <= 4, `${label}: at most three redirects are followed`);
  }

  /* An unreachable site is an error, never a clean report. */
  {
    const { transport } = site({ down: true });
    await assert.rejects(checkSite({ url: 'https://down.example.com', transport }), error => error.code === 'SITE_UNREACHABLE' && error.status === 502);
  }

  /* Prompts carry the place and the fix, and ask for proof. */
  {
    const { transport } = site({ headers: { 'content-type': 'text/html' } });
    const result = await checkSite({ url: 'https://bare.example.com', transport });
    const hsts = result.findings.find(finding => finding.rule === 'WEB-003');
    assert.match(hsts.prompt, /^On the deployed site \(Strict-Transport-Security\): /);
    assert.match(hsts.prompt, /verify it by requesting the page/);
  }

  console.log('site check tests passed');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
