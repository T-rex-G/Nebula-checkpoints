'use strict';

// Synthetic transport regression coverage for the defects found by the audit.
const assert = require('node:assert/strict');
const { checkSite, LIMITS, PROBES, emailDomain } = require('../src/site-check');
const { normalizeTarget } = require('../src/guarded-fetch');
const NOW = Date.UTC(2026, 8, 30);
const HEADERS = {
  'content-type': 'text/html',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'content-security-policy': "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'cross-origin-opener-policy': 'same-origin',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin'
};
const SECRET = ['sk', 'live', '9fKq2LmX7vR4tN8wZ3bY6cH1jD5sP0aE'].join('_');
const entry = (result, id) => result.ledger.find(item => item.id === id);
const rules = result => result.findings.map(item => item.rule);
function transport({ headers = HEADERS, html = '<!doctype html><html></html>', override = () => null, guard = false, seen = [] } = {}) {
  return async input => {
    seen.push(input);
    if (guard) normalizeTarget(input.url, input.profile, { plainHttp: input.plainHttp });
    const url = new URL(input.url);
    const altered = override(url, input);
    if (altered) return altered;
    if (input.plainHttp) return { statusCode: 301, headers: { location: 'https://example.com/' }, body: '' };
    if (url.pathname === '/') return { statusCode: 200, headers, body: html };
    if (url.pathname === '/.well-known/security.txt') return { statusCode: 200, headers: { 'content-type': 'text/plain' }, body: 'Contact: mailto:security@example.com\nExpires: 2027-06-01T00:00:00Z\n' };
    return { statusCode: 404, headers: { 'content-type': 'text/plain' }, body: 'not found' };
  };
}
const run = (options = {}) => checkSite({ url: 'https://example.com', now: () => NOW, random: () => 'audit-fixture', ...options });
async function main() {
  {
    const result = await run({ transport: transport({ override: url => PROBES.some(p => p.path === url.pathname) ? { statusCode: 503, headers: {}, body: 'upstream unavailable' } : null }) });
    assert.equal(entry(result, 'paths').state, 'unknown');
    assert.equal(result.coverage.complete, false);
    assert.equal(result.score, null);
  }
  {
    const result = await run({ transport: transport({ override: url => PROBES.some(p => p.path === url.pathname) ? { statusCode: 200, headers: {}, body: '', bodyUnread: true } : null }) });
    assert.equal(entry(result, 'paths').state, 'unknown');
    assert.equal(result.coverage.complete, false);
  }
  {
    const result = await run({ transport: transport({ html: '<!doctype html><script src="/good.js"></script><script src="/bad.js"></script>', override: url => {
      if (url.pathname === '/good.js') return { statusCode: 200, headers: {}, body: 'console.log(1)' };
      if (url.pathname === '/bad.js') throw new Error('timeout');
    } }) });
    assert.equal(entry(result, 'scripts').state, 'unknown');
  }
  {
    const result = await run({ transport: transport({ headers: { ...HEADERS, 'content-security-policy': "object-src 'none'; base-uri 'none'; frame-ancestors *" } }) });
    assert.equal(result.score, null);
    assert(rules(result).includes('WEB-032'));
    assert(rules(result).includes('WEB-007'));
  }
  {
    const result = await run({ transport: transport({ headers: { ...HEADERS, 'access-control-allow-origin': '*', 'access-control-allow-credentials': 'true' } }) });
    assert(rules(result).includes('WEB-037'));
    assert(!rules(result).includes('WEB-010'));
  }
  {
    const observed = [];
    const result = await run({ transport: transport({ guard: true, seen: observed, html: '<!doctype html><script src="/app.js?v=1"></script>', override: url => url.pathname === '/app.js' ? { statusCode: 200, headers: {}, body: `const secret = "${SECRET}";` } : null }) });
    assert.equal(result.scripts.read, 1);
    assert(rules(result).includes('WEB-023'));
  }
  {
    const result = await run({ transport: transport({ html: '<!doctype html><script src="/bad%ZZ.js"></script>' }) });
    assert.equal(result.coverage.complete, false);
  }
  {
    const text = ' '.repeat(LIMITS.detectChunk - 5) + SECRET + ';';
    const result = await run({ transport: transport({ html: '<!doctype html><script src="/chunk.js"></script>', override: url => url.pathname === '/chunk.js' ? { statusCode: 200, headers: {}, body: text } : null }) });
    assert(rules(result).includes('WEB-023'));
  }
  {
    // Assemble this synthetic credential at runtime so shipped-source secret checks stay useful.
    const remote = new URL('postgres://production.example.com/db');
    remote.username = 'fixture-service'; remote.password = 'synthetic-password';
    const make = extra => transport({ html: '<!doctype html><script src="/bundle.js"></script>', override: url => url.pathname === '/bundle.js' ? { statusCode: 200, headers: {}, body: `const remote="${remote.href}";${extra}` } : null });
    const original = await run({ transport: make('') });
    const localSameLine = await run({ transport: make('const local="postgres://svc:demo@localhost/db";') });
    assert(rules(original).includes('WEB-023'));
    assert(rules(localSameLine).includes('WEB-023'));
  }
  {
    const result = await run({ transport: transport({ html: '<!doctype html><script src=/unquoted.js></script>', override: url => url.pathname === '/unquoted.js' ? { statusCode: 200, headers: {}, body: `const secret = "${SECRET}";` } : null }) });
    assert.equal(result.scripts.onOrigin, 1);
  }
  {
    let clock = NOW;
    const result = await checkSite({ url: 'https://example.com', now: () => clock, transport: transport(), txt: async name => {
      clock += 30_000;
      return name.startsWith('_dmarc.') ? ['v=DMARC1; p=reject'] : ['v=spf1 -all'];
    } });
    assert.equal(result.email.state, 'partial');
    assert.equal(result.coverage.complete, false);
  }
  assert.deepEqual(emailDomain('www.example.com.bd'), { domain: 'example.com.bd' });
  console.log('site check accuracy regressions passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
