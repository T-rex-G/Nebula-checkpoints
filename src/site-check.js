'use strict';

/*
 * A deployed site, looked at the way any visitor's browser looks at it.
 *
 * One anonymous page load for the headers the browser is told to enforce,
 * and a handful of anonymous requests for files that should never be served:
 * an environment file, the Git directory, a Finder index, and the security
 * contact that should be. Ten requests at most -- the page, up to three
 * redirects in front of it, and six fixed paths -- all through the guarded
 * transport's anonymous site profile: HTTPS on 443, public addresses only,
 * no credential and no cookie, the body cut after a few kilobytes.
 *
 * Nothing it reads is returned. A served .env is reported as served, never
 * quoted; a header is reported as missing or weak, and the only header value
 * that crosses back is a cookie's name. Soft 404s -- a single-page app that
 * answers every path with its index -- are told apart by what a file of that
 * kind has to contain, not by the status alone.
 */

const crypto = require('crypto');
const { gradeOf } = require('./code-audit');

const RULES = Object.freeze({
  'WEB-001': { severity: 'critical', title: 'An environment file is served publicly',
    why: 'Anyone can download it, and environment files hold database URLs, API keys and signing secrets.',
    fix: 'Stop serving it (move it out of the public directory, or deny dot-files at the server), then rotate every value it held.' },
  'WEB-002': { severity: 'critical', title: 'The Git repository is served publicly',
    why: 'With the .git directory reachable, the whole source history can be reconstructed, including any secret ever committed.',
    fix: 'Deny access to /.git at the web server or remove it from the deployed files, and treat committed secrets as leaked.' },
  'WEB-003': { severity: 'serious', title: 'No Strict-Transport-Security header',
    why: 'Without HSTS a visitor’s first request can be downgraded to plain HTTP and intercepted.',
    fix: 'Send "Strict-Transport-Security: max-age=31536000; includeSubDomains" on every HTTPS response.' },
  'WEB-004': { severity: 'warning', title: 'Strict-Transport-Security is too short',
    why: 'A max-age under six months lets the protection lapse between visits.',
    fix: 'Raise max-age to at least 15552000 seconds (180 days); a year is common.' },
  'WEB-005': { severity: 'serious', title: 'No Content-Security-Policy',
    why: 'Without a CSP any injected script runs with the page’s full authority, so one cross-site scripting bug becomes account takeover.',
    fix: 'Add a Content-Security-Policy that limits script sources to your own origin and known hosts, starting in report-only mode if needed.' },
  'WEB-006': { severity: 'warning', title: 'The Content-Security-Policy allows inline or evaluated script',
    why: '‘unsafe-inline’ or ‘unsafe-eval’ in script-src switches off most of what a CSP protects against.',
    fix: 'Move inline scripts to files or authorise them with nonces or hashes, and remove ‘unsafe-eval’.' },
  'WEB-007': { severity: 'warning', title: 'The page can be framed by any site',
    why: 'Without X-Frame-Options or a CSP frame-ancestors directive, another site can load the page invisibly and trick clicks on it.',
    fix: 'Send "Content-Security-Policy: frame-ancestors ’self’" (or X-Frame-Options: DENY).' },
  'WEB-008': { severity: 'warning', title: 'No X-Content-Type-Options: nosniff',
    why: 'Browsers may guess a response’s type and run an uploaded file as script.',
    fix: 'Send "X-Content-Type-Options: nosniff" on every response.' },
  'WEB-009': { severity: 'warning', title: 'No Referrer-Policy',
    why: 'Full URLs, including tokens or identifiers in query strings, leak to every site the page links to.',
    fix: 'Send "Referrer-Policy: strict-origin-when-cross-origin" or stricter.' },
  'WEB-010': { severity: 'serious', title: 'Any origin may make credentialed requests',
    why: 'A wildcard or reflected Access-Control-Allow-Origin with credentials lets any website read responses made with the visitor’s cookies.',
    fix: 'Allow an explicit list of trusted origins, and enable credentials only for those.' },
  'WEB-011': { severity: 'serious', title: 'A cookie is set without Secure',
    why: 'A cookie without Secure can travel over plain HTTP, where anyone on the network can read it.',
    fix: 'Set Secure on every cookie, and HttpOnly and SameSite on session cookies.' },
  'WEB-012': { severity: 'warning', title: 'A cookie is readable by page scripts',
    why: 'Without HttpOnly any script on the page, including an injected one, can read the cookie.',
    fix: 'Set HttpOnly on session and authentication cookies.' },
  'WEB-013': { severity: 'warning', title: 'The server announces its software and version',
    why: 'A version in Server or X-Powered-By tells an attacker exactly which known vulnerabilities to try.',
    fix: 'Remove X-Powered-By and strip the version from the Server header.' },
  'WEB-014': { severity: 'warning', title: 'No security contact is published',
    why: 'Someone who finds a vulnerability has no documented way to report it, so it may be sold or published instead.',
    fix: 'Publish /.well-known/security.txt with a Contact and an Expires line (RFC 9116).' },
  'WEB-015': { severity: 'warning', title: 'A macOS folder index is served',
    why: 'A .DS_Store file lists the names of files in the directory, including ones that are not linked anywhere.',
    fix: 'Delete .DS_Store files from the deployment and deny dot-files at the server.' }
});

const PROBES = Object.freeze([
  { path: '/.env', rule: 'WEB-001', looks: body => /^\s*(export\s+)?[A-Z][A-Z0-9_]{1,80}\s*=/m.test(body) },
  { path: '/.env.production', rule: 'WEB-001', looks: body => /^\s*(export\s+)?[A-Z][A-Z0-9_]{1,80}\s*=/m.test(body) },
  { path: '/.git/HEAD', rule: 'WEB-002', looks: body => /^(ref: refs\/|[0-9a-f]{40}\s*$)/.test(body.trim()) },
  { path: '/.git/config', rule: 'WEB-002', looks: body => /^\s*\[core\]/m.test(body) },
  { path: '/.DS_Store', rule: 'WEB-015', looks: body => body.startsWith('\u0000\u0000\u0000\u0001Bud1') }
]);

const PENALTY = Object.freeze({ critical: 40, serious: 20, warning: 6 });
const CRITICAL_CAP = 49;
const MAX_REDIRECTS = 3;

class SiteCheckError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.name = 'SiteCheckError';
    this.code = code;
    this.status = status;
  }
}

/* The site, as an origin. A path, query or fragment is dropped, not followed. */
function siteOrigin(raw) {
  let parsed;
  try { parsed = new URL(String(raw || '').trim()); }
  catch { throw new SiteCheckError('Enter the site’s full address, starting with https://', 'SITE_URL_INVALID'); }
  if (parsed.protocol !== 'https:') throw new SiteCheckError('Only HTTPS sites can be checked', 'SITE_URL_INVALID');
  if (parsed.username || parsed.password) throw new SiteCheckError('The address must not carry a username or password', 'SITE_URL_INVALID');
  if (parsed.port && parsed.port !== '443') throw new SiteCheckError('Only the standard HTTPS port can be checked', 'SITE_URL_INVALID');
  return `https://${parsed.hostname.toLowerCase().replace(/\.$/, '')}`;
}

/*
 * The address a repository declares as its deployed site (GitHub's homepage,
 * Gitea's website), offered as the check's starting value. Only an origin the
 * check would accept crosses back; anything else is no suggestion at all.
 */
function declaredSite(value) {
  try { return value ? siteOrigin(value) : null; } catch { return null; }
}

function looksLikeHtml(response) {
  const type = String(response.headers && response.headers['content-type'] || '').toLowerCase();
  return type.includes('text/html') || /^\s*<(!doctype|html|head|body)/i.test(response.body || '');
}

function cookieFindings(cookies) {
  const out = [];
  for (const cookie of (Array.isArray(cookies) ? cookies : [])) {
    const name = String(cookie).split('=')[0].trim().slice(0, 64);
    if (!/^[\w.-]+$/.test(name)) continue;
    const attributes = String(cookie).toLowerCase();
    if (!/;\s*secure\b/.test(attributes)) out.push({ rule: 'WEB-011', where: `Set-Cookie: ${name}` });
    else if (!/;\s*httponly\b/.test(attributes)) out.push({ rule: 'WEB-012', where: `Set-Cookie: ${name}` });
  }
  return out;
}

function headerFindings(headers) {
  const out = [];
  const get = name => String(headers[name] || '');
  const hsts = get('strict-transport-security');
  if (!hsts) out.push({ rule: 'WEB-003', where: 'Strict-Transport-Security' });
  else {
    const age = /max-age\s*=\s*"?(\d+)/i.exec(hsts);
    if (!age || Number(age[1]) < 15552000) out.push({ rule: 'WEB-004', where: 'Strict-Transport-Security' });
  }
  const csp = get('content-security-policy');
  if (!csp) out.push({ rule: 'WEB-005', where: 'Content-Security-Policy' });
  else {
    const script = (/(?:^|;)\s*script-src\s+([^;]*)/i.exec(csp) || /(?:^|;)\s*default-src\s+([^;]*)/i.exec(csp) || [])[1] || '';
    const nonced = /'nonce-|'sha(256|384|512)-|'strict-dynamic'/i.test(script);
    if (/'unsafe-eval'/i.test(script) || (/'unsafe-inline'/i.test(script) && !nonced)) out.push({ rule: 'WEB-006', where: 'Content-Security-Policy' });
  }
  if (!get('x-frame-options') && !/frame-ancestors/i.test(csp)) out.push({ rule: 'WEB-007', where: 'X-Frame-Options' });
  if (!/nosniff/i.test(get('x-content-type-options'))) out.push({ rule: 'WEB-008', where: 'X-Content-Type-Options' });
  if (!get('referrer-policy')) out.push({ rule: 'WEB-009', where: 'Referrer-Policy' });
  const origin = get('access-control-allow-origin').trim();
  if ((origin === '*' || origin === 'null') && /true/i.test(get('access-control-allow-credentials'))) out.push({ rule: 'WEB-010', where: 'Access-Control-Allow-Origin' });
  if (/\d/.test(get('server')) || get('x-powered-by')) out.push({ rule: 'WEB-013', where: get('x-powered-by') ? 'X-Powered-By' : 'Server' });
  return out;
}

function describe(rule, where) {
  const definition = RULES[rule];
  return {
    id: crypto.createHash('sha256').update(`${rule}\0${where}`).digest('hex').slice(0, 24),
    rule,
    category: 'site',
    severity: definition.severity,
    where,
    title: definition.title,
    why: definition.why,
    fix: definition.fix,
    prompt: `On the deployed site (${where}): ${definition.title.toLowerCase()}. ${definition.why} ${definition.fix} ` +
      'Make the change in the hosting or server configuration this repository controls, and verify it by requesting the page and reading the response headers.'
  };
}

/*
 * The check. `transport` is the guarded transport; every request it is given
 * is anonymous and bounded, and a failure to reach the page at all is an
 * error, never an empty -- and therefore clean -- report.
 */
async function checkSite({ url, transport }) {
  const requested = siteOrigin(url);
  let origin = requested;
  const request = (pathname, method = 'GET', maxResponseBytes = 4096) => transport({
    url: `${origin}${pathname}`, profile: 'site-probe', method, maxResponseBytes,
    headers: { accept: '*/*', 'accept-encoding': 'identity', 'user-agent': 'Nebulaverse-X-SiteCheck/1.0' },
    deadlineMs: 15000
  });

  /*
   * The page a visitor lands on, not the redirect in front of it: most sites
   * answer / with a hop to www or to a locale, and a redirect's headers are
   * not the page's. Each hop is a new request through the same guarded
   * profile, only to HTTPS on 443, at most three of them; the cookies set on
   * the way are the visitor's cookies too.
   */
  let page;
  let pathname = '/';
  let probed = 0;
  let redirects = 0;
  const cookies = [];
  for (let hop = 0; ; hop += 1) {
    try { page = await request(pathname, 'GET', 64 * 1024); probed += 1; }
    catch {
      throw new SiteCheckError('The site could not be reached over valid HTTPS from here. Check the address, and that it has a public certificate.', 'SITE_UNREACHABLE', 502);
    }
    const headers = page.headers || {};
    if (Array.isArray(headers['set-cookie'])) cookies.push(...headers['set-cookie']);
    const location = page.statusCode >= 300 && page.statusCode < 400 ? String(headers.location || '') : '';
    if (!location) break;
    if (hop === MAX_REDIRECTS) {
      throw new SiteCheckError('The site kept redirecting without settling on a page, so there is no page to check.', 'SITE_REDIRECT_LOOP', 502);
    }
    let next;
    try { next = new URL(location, `${origin}${pathname}`); origin = siteOrigin(next.href); }
    catch {
      throw new SiteCheckError('The site redirected to an address that is not HTTPS on the standard port, so the check stopped there.', 'SITE_REDIRECT_REFUSED', 502);
    }
    pathname = next.pathname || '/';
    redirects += 1;
  }
  const raw = [...headerFindings(page.headers || {}), ...cookieFindings(cookies)];

  const served = new Set();
  for (const probe of PROBES) {
    if (served.has(probe.rule)) continue;
    let response;
    try { response = await request(probe.path); probed += 1; }
    catch { probed += 1; continue; }
    if (response.statusCode !== 200 || response.bodyUnread || looksLikeHtml(response)) continue;
    if (probe.looks(String(response.body || ''))) {
      served.add(probe.rule);
      raw.push({ rule: probe.rule, where: probe.path });
    }
  }
  let securityTxt = false;
  try {
    const response = await request('/.well-known/security.txt');
    probed += 1;
    securityTxt = response.statusCode === 200 && !looksLikeHtml(response) && /^\s*Contact:/im.test(String(response.body || ''));
  } catch { probed += 1; }
  if (!securityTxt) raw.push({ rule: 'WEB-014', where: '/.well-known/security.txt' });

  const seen = new Set();
  const findings = raw.filter(item => {
    const key = `${item.rule}\0${item.where}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(item => describe(item.rule, item.where));
  const order = { critical: 0, serious: 1, warning: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || a.rule.localeCompare(b.rule));
  const byRule = new Map();
  for (const finding of findings) {
    const cap = PENALTY[finding.severity] * 2;
    byRule.set(finding.rule, Math.min(cap, (byRule.get(finding.rule) || 0) + PENALTY[finding.severity]));
  }
  const mean = Math.max(0, 100 - [...byRule.values()].reduce((total, penalty) => total + penalty, 0));
  const critical = findings.some(finding => finding.severity === 'critical');
  const score = critical ? Math.min(mean, CRITICAL_CAP) : mean;
  const headersSeen = page.headers || {};
  return {
    origin,
    requested,
    redirects,
    status: page.statusCode,
    requests: probed,
    score,
    grade: gradeOf(score),
    capped: critical && mean > CRITICAL_CAP,
    findings,
    headers: Object.freeze(['strict-transport-security', 'content-security-policy', 'x-frame-options', 'x-content-type-options', 'referrer-policy', 'permissions-policy']
      .map(name => ({ name, present: Boolean(headersSeen[name]) })))
  };
}

module.exports = Object.freeze({ RULES, PROBES, SiteCheckError, siteOrigin, declaredSite, checkSite });
