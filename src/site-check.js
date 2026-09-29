'use strict';

/*
 * A deployed site, looked at the way any visitor's browser -- and anyone
 * probing it -- looks at it.
 *
 * The page a visitor lands on and the headers it is told to enforce; the
 * certificate and the protocol the connection settled on; whether plain HTTP
 * sends a visitor on to HTTPS; whether another website may read answers made
 * with the visitor's cookies; the files that must never be served; what a
 * missing page gives away; the pages the landing page links to (as far as
 * robots.txt allows); the JavaScript those pages load, read for secrets,
 * public source maps and library versions with published advisories; and
 * whether anyone may send email as the domain.
 *
 * Every request goes through the guarded transport's anonymous site profile:
 * GET only, HTTPS on 443 to a public address (and one plain-HTTP question on
 * port 80 whose answer body is never read), no credential and no cookie,
 * every body cut at a bound. At most sixty requests and forty-five seconds;
 * nothing is sent but the requests a browser would send, nothing is tried,
 * guessed or submitted, and pages robots.txt closes to crawlers are left
 * alone.
 *
 * Nothing it reads is returned. A served .env is reported as served, never
 * quoted; a secret in a script is reported by its kind and the script's path;
 * a header is reported as missing or weak, and the only header value that
 * crosses back is a cookie's name. Soft 404s -- a single-page app that
 * answers every path with its index -- are told apart by what a file of that
 * kind has to contain, not by the status alone.
 */

const crypto = require('crypto');
const { gradeOf, lookupAdvisories, advisoryKey, compareVersions } = require('./code-audit');
const { standardsFor } = require('./security-standards');
const { detectInText } = require('./exposure-detection');
const { RULE_NARRATION } = require('./exposure-narration');

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
    fix: 'Delete .DS_Store files from the deployment and deny dot-files at the server.' },
  'WEB-016': { severity: 'warning', title: 'The page does not isolate its browsing context',
    why: 'Without Cross-Origin-Opener-Policy, a window this page opens -- or one that opened it -- keeps a handle to it, which is how tab-nabbing and cross-site leak attacks reach a signed-in page.',
    fix: 'Send "Cross-Origin-Opener-Policy: same-origin" (or same-origin-allow-popups if the site relies on popups such as an OAuth window).' },
  'WEB-017': { severity: 'warning', title: 'The Content-Security-Policy leaves base URLs or plugins open',
    why: 'A policy without base-uri lets injected markup re-point every relative script to another host, and one that does not rule out object and embed lets a plugin run script the policy never listed.',
    fix: 'Add "base-uri \u2019none\u2019" (or \u2019self\u2019) and "object-src \u2019none\u2019" to the policy.' },
  'WEB-018': { severity: 'serious', title: 'The page loads resources over plain HTTP',
    why: 'Anything fetched over HTTP from an HTTPS page can be read and replaced on the network. Scripts and frames loaded that way are blocked by browsers, which breaks the page; images and media are shown with the padlock taken away.',
    fix: 'Load every script, stylesheet, frame and asset over https://, and add "upgrade-insecure-requests" to the Content-Security-Policy.' },
  'WEB-019': { severity: 'warning', title: 'A third-party script loads without an integrity check',
    why: 'A script from another origin runs with the page\u2019s full authority. Without a Subresource Integrity hash, whoever controls that host -- or compromises it -- controls the page.',
    fix: 'Add integrity="sha384-..." and crossorigin="anonymous" to third-party script tags, or serve the script from your own origin.' },
  'WEB-020': { severity: 'serious', title: 'The site answers over plain HTTP without sending visitors to HTTPS',
    why: 'Someone who types the address without https:// gets the page unencrypted, where anyone on the network can read or change it -- including the link to the HTTPS version.',
    fix: 'Answer every plain-HTTP request with a 301 redirect to the same path on https://, and send Strict-Transport-Security so browsers stop asking over HTTP at all.' },
  'WEB-021': { severity: 'serious', title: 'An error page reveals a stack trace or debug mode',
    why: 'A framework running in debug mode, or an error page that prints its stack, shows file paths, versions, settings and sometimes secrets to anyone who asks for a page that does not exist.',
    fix: 'Turn debug mode off in production (DEBUG=False, APP_DEBUG=false, NODE_ENV=production) and serve a plain error page; log the details server-side instead.' },
  'WEB-022': { severity: 'warning', title: 'A directory listing is served',
    why: 'A listed directory names every file in it, including backups and files that are not linked from anywhere.',
    fix: 'Turn off automatic indexes at the web server (autoindex off; Options -Indexes) or put an index page in the directory.' },
  'WEB-023': { severity: 'critical', title: 'A secret is shipped in the site’s JavaScript or page',
    why: 'Everything a browser downloads can be read by anyone. A server-side credential in a script or page -- a secret API key, a service-role key, a token -- is published to every visitor.',
    fix: 'Rotate the credential now, then move the call that needs it to your server and keep the key in a server-side environment variable. Only keys designed to be public belong in the browser.' },
  'WEB-024': { severity: 'warning', title: 'Source maps are public',
    why: 'A source map rebuilds the original source of the bundled JavaScript -- comments, internal names and the logic behind every check -- for anyone who downloads it.',
    fix: 'Stop deploying .map files to the public site (hidden source maps, or upload them only to your error tracker), or restrict them to your own network.' },
  'WEB-025': { severity: 'serious', title: 'A JavaScript library with known vulnerabilities is loaded',
    why: 'The page loads a library version with published advisories; the ones that apply in a browser are usually cross-site scripting or prototype pollution reachable through the page.',
    fix: 'Upgrade the library to a version without the advisories, rebuild and redeploy, and check that nothing else pins the old copy.' },
  'WEB-026': { severity: 'warning', title: 'The security contact file has no valid expiry',
    why: 'RFC 9116 requires security.txt to carry an Expires date, so a reader can tell a maintained contact from a stale one; without it, or past it, reports may be sent nowhere.',
    fix: 'Add "Expires:" with a date within the next year to /.well-known/security.txt and renew it before it lapses.' },
  'WEB-027': { severity: 'warning', title: 'No DMARC policy protects the domain’s email',
    why: 'Without a DMARC policy that rejects or quarantines mail failing authentication, anyone can send email that appears to come from this domain -- the usual start of a phishing attack on its users.',
    fix: 'Publish a TXT record at _dmarc.<domain> such as "v=DMARC1; p=quarantine; rua=mailto:dmarc@<domain>", then move to p=reject once reports look clean.' },
  'WEB-028': { severity: 'warning', title: 'No SPF record says who may send the domain’s email',
    why: 'Without an SPF record -- or with one that ends in +all -- receiving servers cannot tell mail from this domain’s real senders from forged mail.',
    fix: 'Publish a TXT record "v=spf1 include:<your mail provider> -all", or "v=spf1 -all" if the domain sends no email.' },
  'WEB-029': { severity: 'serious', title: 'The certificate expires within two weeks',
    why: 'When the certificate lapses every visitor gets a full-page browser warning, and many will click through it -- or leave.',
    fix: 'Renew the certificate now, and automate renewal (ACME / your host’s managed certificates) so it happens weeks before expiry.' },
  'WEB-030': { severity: 'warning', title: 'The certificate expires within a month',
    why: 'Automated renewal normally runs a month before expiry; a certificate this close to its end date suggests renewal is manual or failing.',
    fix: 'Check that automatic renewal is configured and succeeding, and renew now if it is not.' },
  'WEB-031': { severity: 'serious', title: 'The connection settled on an outdated TLS version',
    why: 'TLS 1.0 and 1.1 have known weaknesses and are refused by current browsers; a server that still negotiates them is misconfigured.',
    fix: 'Allow only TLS 1.2 and TLS 1.3 at the web server or load balancer.' },
  'WEB-032': { severity: 'warning', title: 'The Content-Security-Policy lets scripts load from anywhere',
    why: 'A script-src that allows *, any https: or data: URL lets an injected tag load an attacker’s script from their own host, so the policy stops little.',
    fix: 'List the hosts scripts may come from (or use nonces with ’strict-dynamic’), and remove *, https: and data: from script-src.' },
  'WEB-033': { severity: 'serious', title: 'A form sends its data over plain HTTP',
    why: 'A form whose action is an http:// address sends what visitors type -- often a password -- unencrypted, even though the page itself is HTTPS.',
    fix: 'Point the form’s action at an https:// address, or a relative path on this origin.' },
  'WEB-034': { severity: 'serious', title: 'A server diagnostics page is served',
    why: 'Status, profiler and environment pages list configuration, internal addresses, request details and sometimes credentials, and are meant for operators only.',
    fix: 'Disable the endpoint in production or restrict it to an internal network or an authenticated operator.' },
  'WEB-035': { severity: 'critical', title: 'A credentials file is served publicly',
    why: 'Anyone can download it, and files like this hold cloud keys, registry tokens and database passwords.',
    fix: 'Remove it from the public directory (deny dot-files and backup files at the server) and rotate every credential it held.' },
  'WEB-036': { severity: 'serious', title: 'Version-control metadata is served publicly',
    why: 'A reachable Subversion or Mercurial directory lets the source, and its history, be reconstructed from the site.',
    fix: 'Deny access to /.svn and /.hg at the web server, or remove them from the deployed files.' }
});

/*
 * Files that must never be served, each recognised by what a file of that
 * kind has to contain rather than by the status alone: a single-page app
 * answers every path with its index, and that is not a leak.
 */
const ENV_LINE = /^\s*(export\s+)?[A-Z][A-Z0-9_]{1,80}\s*=/m;
const PROBES = Object.freeze([
  { path: '/.env', rule: 'WEB-001', looks: body => ENV_LINE.test(body) },
  { path: '/.env.local', rule: 'WEB-001', looks: body => ENV_LINE.test(body) },
  { path: '/.env.production', rule: 'WEB-001', looks: body => ENV_LINE.test(body) },
  { path: '/.env.development', rule: 'WEB-001', looks: body => ENV_LINE.test(body) },
  { path: '/.git/HEAD', rule: 'WEB-002', looks: body => /^(ref: refs\/|[0-9a-f]{40}\s*$)/.test(body.trim()) },
  { path: '/.git/config', rule: 'WEB-002', looks: body => /^\s*\[core\]/m.test(body) },
  { path: '/.svn/entries', rule: 'WEB-036', looks: body => /^\s*(?:\d{1,2}\s*$|<\?xml[^>]*>\s*<wc-entries)/m.test(body) },
  { path: '/.hg/requires', rule: 'WEB-036', looks: body => /^(?:revlogv1|store|fncache|dotencode|generaldelta)\s*$/m.test(body) },
  { path: '/.DS_Store', rule: 'WEB-015', looks: body => body.startsWith('\u0000\u0000\u0000\u0001Bud1') },
  { path: '/.aws/credentials', rule: 'WEB-035', looks: body => /^\s*aws_(?:access_key_id|secret_access_key)\s*=/mi.test(body) },
  { path: '/.npmrc', rule: 'WEB-035', looks: body => /(?:^|\n)\s*(?:\/\/[^\n]*:)?_(?:authToken|auth|password)\s*=/.test(body) },
  { path: '/.docker/config.json', rule: 'WEB-035', looks: body => /"auths"\s*:\s*\{/.test(body) },
  { path: '/wp-config.php.bak', rule: 'WEB-035', looks: body => /define\(\s*['"]DB_PASSWORD['"]/.test(body) },
  { path: '/server-status', rule: 'WEB-034', looks: body => /Apache Server Status for|Server Version:\s*Apache/i.test(body), html: true },
  { path: '/phpinfo.php', rule: 'WEB-034', looks: body => /<title>phpinfo\(\)<\/title>|PHP Version\s*<\/t[dh]>/i.test(body), html: true },
  { path: '/actuator/env', rule: 'WEB-034', looks: body => /"(?:propertySources|activeProfiles)"\s*:/.test(body) },
  { path: '/debug/pprof/', rule: 'WEB-034', looks: body => /Types of profiles available/i.test(body), html: true },
  { path: '/_profiler/', rule: 'WEB-034', looks: body => /Symfony Profiler/i.test(body), html: true },
  { path: '/elmah.axd', rule: 'WEB-034', looks: body => /Error Log for/i.test(body), html: true }
]);

/*
 * What a framework's debug or error page prints, and a directory index, in
 * the first bytes of a page. A framework's own debug page (flagged) is
 * recognised on any page read; a bare stack trace only on the missing page
 * the check asks for, since documentation may quote one.
 */
const DEBUG_SIGNATURES = Object.freeze([
  [/You(?:'|&#x27;|&#39;|’)re seeing this error because you have <code>DEBUG = True<\/code>/, 'Django debug page', true],
  [/Werkzeug Debugger|The debugger caught an exception in your WSGI application/, 'Werkzeug debugger', true],
  [/Whoops! There was an error\.|Illuminate\\(?:Foundation|Database|Routing)\\|<title>[^<]*\| Ignition<\/title>/, 'Laravel error page', true],
  [/Action Controller: Exception caught|<h1>Routing Error<\/h1>/, 'Rails development error page', true],
  [/Server Error in '\/' Application|<b>\s*Stack Trace:\s*<\/b>/, 'ASP.NET error page', true],
  [/<b>(?:Fatal error|Parse error|Warning|Notice)<\/b>:\s[^<]{0,300} on line <b>\d+<\/b>/, 'PHP error output', true],
  [/Traceback \(most recent call last\):/, 'Python traceback'],
  [/\bat (?:java|javax|org\.springframework|org\.apache|com\.sun)\.[\w.$]+\([\w.]+(?:\.java)?:\d+\)/, 'Java stack trace'],
  [/(?:Error|TypeError|ReferenceError|SyntaxError)[^<\n]{0,200}(?:<br>|\n)(?:\s|&nbsp;)*at [\w.<>$]+ \((?:\/|[A-Z]:\\)[^)]+:\d+:\d+\)/, 'Node.js stack trace']
]);
const DIRECTORY_LISTING = /<title>\s*(?:Index of \/|Directory listing for \/)/i;

/*
 * Credentials that are public by design and belong in a browser: a
 * Supabase anonymous key, a Google browser API key. A Stripe test key is a
 * secret, but a test one; it is reported one step softer.
 */
const PUBLIC_BY_DESIGN = new Set(['supabase-anon-key', 'google-api-key']);
const SOFTER_SECRETS = new Set(['stripe-test-key']);
const LOCAL_URL = /@(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|host\.docker\.internal|postgres|mysql|mongo|redis|db|database)(:\d+)?[/?\s'"`]/i;

/*
 * Browser libraries, by the banner their builds carry or the address a CDN
 * serves them from, as the npm package the advisory database knows them by.
 */
const LIBRARY_BANNERS = Object.freeze([
  ['jquery', /jQuery (?:JavaScript Library )?v(\d+\.\d+\.\d+)/],
  ['jquery-ui', /jQuery UI - v(\d+\.\d+\.\d+)/],
  ['jquery-migrate', /jQuery Migrate - v(\d+\.\d+\.\d+)/],
  ['bootstrap', /Bootstrap v(\d+\.\d+\.\d+)/],
  ['angular', /AngularJS v(\d+\.\d+\.\d+)/],
  ['moment', /\/\/! moment\.js\s*(?:\n|\r\n)\s*\/\/! version : (\d+\.\d+\.\d+)/],
  ['handlebars', /@license handlebars v(\d+\.\d+\.\d+)|Handlebars\.VERSION\s*=\s*["'](\d+\.\d+\.\d+)/],
  ['dompurify', /@license DOMPurify (\d+\.\d+\.\d+)/],
  ['underscore', /Underscore\.js (\d+\.\d+\.\d+)/],
  ['vue', /Vue\.js v(\d+\.\d+\.\d+)/],
  ['axios', /Axios v(\d+\.\d+\.\d+)/],
  ['knockout', /Knockout JavaScript library v(\d+\.\d+\.\d+)/],
  ['datatables.net', /DataTables (\d+\.\d+\.\d+)/],
  ['lodash', /@license\s*(?:\*\s*)?Lodash[^\n]*\n[\s\S]{0,400}?var VERSION = '(\d+\.\d+\.\d+)'|lodash\.com\/license[\s\S]{0,300}?VERSION\s*=\s*"(\d+\.\d+\.\d+)"/]
]);
const CDN_NAMES = Object.freeze({
  jquery: 'jquery', 'jquery-ui': 'jquery-ui', jqueryui: 'jquery-ui', 'jquery-migrate': 'jquery-migrate', bootstrap: 'bootstrap', 'twitter-bootstrap': 'bootstrap',
  'angular.js': 'angular', angular: 'angular', 'moment.js': 'moment', moment: 'moment', 'handlebars.js': 'handlebars', handlebars: 'handlebars',
  dompurify: 'dompurify', 'underscore.js': 'underscore', underscore: 'underscore', vue: 'vue', axios: 'axios', 'lodash.js': 'lodash', lodash: 'lodash',
  knockout: 'knockout', 'datatables.net': 'datatables.net', datatables: 'datatables.net'
});
const VERSION = /^\d+\.\d+\.\d+$/;

/*
 * Where a site's email policy is looked up: the registrable domain, not the
 * web host. A host on a shared platform's domain has no email policy of its
 * own to check -- the platform's is not the site's -- and is skipped.
 */
const MULTI_PART_SUFFIXES = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.jp', 'ne.jp', 'or.jp', 'com.br', 'com.mx',
  'com.tr', 'co.in', 'co.za', 'com.sg', 'com.hk', 'com.cn', 'com.tw', 'co.kr', 'com.ar', 'com.eg', 'com.sa', 'com.my', 'co.id', 'com.ph', 'com.vn', 'com.ua', 'co.il', 'com.pl']);
const SHARED_PLATFORMS = Object.freeze(['onrender.com', 'vercel.app', 'netlify.app', 'herokuapp.com', 'github.io', 'pages.dev', 'workers.dev', 'fly.dev', 'railway.app',
  'web.app', 'firebaseapp.com', 'azurewebsites.net', 'azurestaticapps.net', 'cloudfront.net', 'amplifyapp.com', 'appspot.com', 'glitch.me', 'replit.app', 'repl.co',
  'surge.sh', 'deno.dev', 'supabase.co', 'gitlab.io', 'onrender.app', 'ngrok.app', 'ngrok-free.app', 'lovable.app', 'bolt.new', 'webflow.io', 'wixsite.com', 'framer.app']);
function emailDomain(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (SHARED_PLATFORMS.some(suffix => host === suffix || host.endsWith(`.${suffix}`))) return { skipped: 'shared-platform' };
  const labels = host.split('.');
  if (labels.length < 2) return { skipped: 'no-domain' };
  const lastTwo = labels.slice(-2).join('.');
  const keep = MULTI_PART_SUFFIXES.has(lastTwo) ? 3 : 2;
  return { domain: labels.slice(-keep).join('.') };
}

const PENALTY = Object.freeze({ critical: 40, serious: 20, warning: 6 });
const CRITICAL_CAP = 49;
const MAX_REDIRECTS = 3;
const LIMITS = Object.freeze({
  /* Every request the check may make, redirects and all. */
  maxRequests: 60,
  concurrency: 4,
  /* The whole check, from the first request to the last answer. */
  deadlineMs: 45_000,
  requestMs: 15_000,
  pageBytes: 256 * 1024,
  probeBytes: 4096,
  errorPageBytes: 32 * 1024,
  scriptBytes: 2 * 1024 * 1024,
  scriptBudgetBytes: 12 * 1024 * 1024,
  /* The landing page and at most this many more, from its own links. */
  maxPages: 5,
  maxScripts: 12,
  maxMaps: 3,
  maxLibraries: 20,
  detectChunk: 1024 * 1024
});
const STAGES = Object.freeze(['page', 'transport', 'paths', 'pages', 'scripts', 'libraries', 'email']);

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

/* One directive's sources, or null when the policy does not state it. */
function cspDirective(csp, name) {
  const found = new RegExp(`(?:^|;)\\s*${name}\\s+([^;]*)`, 'i').exec(csp);
  return found ? found[1] : null;
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
  if (!csp) out.push({ rule: 'WEB-005', where: get('content-security-policy-report-only') ? 'Content-Security-Policy (report-only is not enforced)' : 'Content-Security-Policy' });
  else {
    const script = cspDirective(csp, 'script-src') || cspDirective(csp, 'default-src') || '';
    const nonced = /'nonce-|'sha(256|384|512)-|'strict-dynamic'/i.test(script);
    if (/'unsafe-eval'/i.test(script) || (/'unsafe-inline'/i.test(script) && !nonced)) out.push({ rule: 'WEB-006', where: 'Content-Security-Policy' });
    /* 'strict-dynamic' makes a nonce-capable browser ignore host sources, so a wide list beside it is a fallback, not an opening. */
    if (script && !/'strict-dynamic'/i.test(script) && /(?:^|\s)(?:\*|https?:|data:)(?=\s|$)/i.test(script)) out.push({ rule: 'WEB-032', where: 'Content-Security-Policy: script-src' });
  }
  if (!get('x-frame-options') && !/frame-ancestors/i.test(csp)) out.push({ rule: 'WEB-007', where: 'X-Frame-Options' });
  if (!/nosniff/i.test(get('x-content-type-options'))) out.push({ rule: 'WEB-008', where: 'X-Content-Type-Options' });
  if (!get('referrer-policy')) out.push({ rule: 'WEB-009', where: 'Referrer-Policy' });
  const origin = get('access-control-allow-origin').trim();
  if ((origin === '*' || origin === 'null') && /true/i.test(get('access-control-allow-credentials'))) out.push({ rule: 'WEB-010', where: 'Access-Control-Allow-Origin' });
  if (/\d/.test(get('server')) || get('x-powered-by')) out.push({ rule: 'WEB-013', where: get('x-powered-by') ? 'X-Powered-By' : 'Server' });
  if (!/same-origin/i.test(get('cross-origin-opener-policy'))) out.push({ rule: 'WEB-016', where: 'Cross-Origin-Opener-Policy' });
  if (csp) {
    const objects = cspDirective(csp, 'object-src') || cspDirective(csp, 'default-src');
    const baseOpen = cspDirective(csp, 'base-uri') === null;
    const pluginsOpen = objects === null || !/'none'|'self'/i.test(objects) || /\*|https?:/i.test(objects);
    if (baseOpen || pluginsOpen) out.push({ rule: 'WEB-017', where: 'Content-Security-Policy' });
  }
  return out;
}

/*
 * What a page asks the browser to load and send, read from markup the check
 * already has: a script, frame, stylesheet or asset over plain HTTP; a script
 * from another origin with no integrity hash; a form that posts over plain
 * HTTP. Only the first of each kind is named, by its host, never its full
 * address.
 */
function markupFindings(body, origin) {
  const out = [];
  const html = String(body || '');
  if (!html) return out;
  const self = new URL(origin).host;
  const tags = [...html.matchAll(/<(script|iframe|link|img|source|video|audio)\b([^>]*)>/gi)];
  let insecure = null;
  let unsigned = null;
  for (const [, tag, attributes] of tags) {
    const src = (/\b(?:src|href)\s*=\s*["']([^"']+)["']/i.exec(attributes) || [])[1] || '';
    if (tag.toLowerCase() === 'link' && !/\brel\s*=\s*["'][^"']*(stylesheet|preload|modulepreload|icon)/i.test(attributes)) continue;
    if (/^http:\/\//i.test(src) && !insecure) insecure = src;
    if (tag.toLowerCase() === 'script' && /^(https:)?\/\//i.test(src) && !unsigned) {
      try {
        const host = new URL(src, origin).host;
        if (host !== self && !/\bintegrity\s*=\s*["']sha(256|384|512)-/i.test(attributes)) unsigned = host;
      } catch { /* not an address */ }
    }
  }
  if (insecure) out.push({ rule: 'WEB-018', where: `http://${hostOf(insecure) || 'an http:// address'}` });
  if (unsigned) out.push({ rule: 'WEB-019', where: `<script src> from ${unsigned}` });
  const form = /<form\b[^>]*\baction\s*=\s*["'](http:\/\/[^"']+)["']/i.exec(html);
  if (form) out.push({ rule: 'WEB-033', where: `<form action> to http://${hostOf(form[1]) || 'an http:// address'}` });
  return out;
}

function hostOf(address) {
  try { return new URL(address).host; } catch { return ''; }
}

/*
 * A path as it may be shown: its query dropped, a long opaque segment -- a
 * token, an id -- replaced, and bounded. A link can carry an identifier, and
 * the check repeats places, never identifiers.
 */
function displayPath(pathname) {
  const clean = String(pathname || '/').split(/[?#]/)[0]
    .split('/').map(segment => (/^[A-Za-z0-9_-]{24,}$/.test(segment) && /\d/.test(segment) ? '…' : segment)).join('/');
  return clean.length > 96 ? `${clean.slice(0, 95)}…` : clean || '/';
}

function describe(rule, where, extra = {}) {
  const definition = RULES[rule];
  const severity = extra.severity || definition.severity;
  const why = extra.note ? `${definition.why} ${extra.note}` : definition.why;
  const fix = extra.fixNote ? `${definition.fix} ${extra.fixNote}` : definition.fix;
  return {
    id: crypto.createHash('sha256').update(`${rule}\0${where}`).digest('hex').slice(0, 24),
    rule,
    category: 'site',
    severity,
    where,
    title: definition.title,
    why,
    fix,
    standards: standardsFor(rule),
    prompt: `On the deployed site (${where}): ${definition.title.toLowerCase()}. ${why} ${fix} ` +
      'Make the change in the hosting or server configuration this repository controls, and verify it by requesting the page and reading the response headers.'
  };
}

async function boundedMap(values, limit, operation) {
  const results = new Array(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await operation(values[index], index);
    }
  }));
  return results;
}

/* Every credential in a script or page, by kind; the value never leaves this function. */
function shippedSecrets(text) {
  const kinds = new Map();
  const source = String(text || '');
  for (let start = 0; start < source.length; start += LIMITS.detectChunk) {
    const chunk = source.slice(start, start + LIMITS.detectChunk);
    for (const candidate of detectInText({ text: chunk }).candidates) {
      if (PUBLIC_BY_DESIGN.has(candidate.rule)) continue;
      if (candidate.rule === 'database-url-password' || candidate.rule === 'authenticated-url') {
        const lines = chunk.split('\n');
        if ((candidate.occurrences || []).every(occurrence => LOCAL_URL.test(lines[(occurrence.line || 1) - 1] || ''))) continue;
      }
      if (!kinds.has(candidate.rule)) kinds.set(candidate.rule, credentialKind(candidate.rule));
    }
  }
  return [...kinds.entries()].map(([rule, kind]) => ({ rule, kind }));
}

function credentialKind(rule) {
  const narration = RULE_NARRATION[rule];
  const match = narration && /^(?:An?|The) (.+?) (?:is|are|was|were) /.exec(narration.consequence);
  const kind = match && match[1].length <= 48 ? match[1] : 'credential';
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

/* A library and version, from a script's own banner or the address a CDN serves it from. */
function librariesInText(text) {
  const found = [];
  const head = String(text || '').slice(0, 64 * 1024);
  for (const [name, pattern] of LIBRARY_BANNERS) {
    const match = pattern.exec(head);
    const version = match && match.slice(1).find(Boolean);
    if (version && VERSION.test(version)) found.push({ name, version, source: 'banner' });
  }
  return found;
}
function libraryFromAddress(address) {
  let parsed;
  try { parsed = new URL(address); } catch { return null; }
  const path = decodeURIComponent(parsed.pathname);
  let match = /\/ajax\/libs\/([\w.-]+)\/(\d+\.\d+\.\d+)\//.exec(path);
  if (match && CDN_NAMES[match[1].toLowerCase()]) return { name: CDN_NAMES[match[1].toLowerCase()], version: match[2], source: 'address' };
  match = /\/npm\/((?:@[\w.-]+\/)?[\w.-]+)@(\d+\.\d+\.\d+)(?:\/|$)/.exec(path) || /^\/((?:@[\w.-]+\/)?[\w.-]+)@(\d+\.\d+\.\d+)(?:\/|$)/.exec(path);
  if (match && CDN_NAMES[match[1].toLowerCase()]) return { name: CDN_NAMES[match[1].toLowerCase()], version: match[2], source: 'address' };
  match = /\/(jquery|jquery-ui|jquery-migrate|bootstrap|angular|moment|handlebars|underscore|lodash|vue|knockout)[.-](\d+\.\d+\.\d+)(?:\.min|\.slim|\.slim\.min)?\.js$/i.exec(path);
  if (match) return { name: CDN_NAMES[match[1].toLowerCase()], version: match[2], source: 'address' };
  /* WordPress names the version it serves in the query: /wp-includes/js/jquery/jquery.min.js?ver=3.6.0. */
  match = /\/(jquery|jquery-migrate|underscore|moment|lodash)(?:\.min)?\.js$/i.exec(path);
  const declared = parsed.searchParams.get('ver');
  if (match && declared && /^\d+\.\d+\.\d+$/.test(declared)) return { name: CDN_NAMES[match[1].toLowerCase()], version: declared, source: 'address' };
  return null;
}

/* The links a visitor could follow from a page, on this origin, most telling first. */
const CRAWL_PRIORITY = /\b(?:log-?in|sign-?in|sign-?up|register|account|auth|admin|dashboard|settings|profile|checkout|pricing|contact|api|docs)\b/i;
const CRAWL_SKIP = /\.(?:png|jpe?g|gif|svg|webp|ico|pdf|zip|gz|tgz|mp4|mp3|webm|woff2?|ttf|css|js|json|xml|txt|map)$/i;
const CRAWL_NEVER = /\b(?:log-?out|sign-?out|delete|remove|unsubscribe|cancel|destroy)\b/i;
function pageLinks(html, base, origin, disallowed) {
  const out = new Map();
  for (const [, href] of String(html || '').matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"'#][^"']*)["']/gi)) {
    let target;
    try { target = new URL(href, base); } catch { continue; }
    if (target.origin !== origin) continue;
    const path = target.pathname || '/';
    if (path === '/' || CRAWL_SKIP.test(path) || CRAWL_NEVER.test(path) || path.length > 200) continue;
    if (displayPath(path) !== path) continue;
    if (disallowed.some(prefix => path.startsWith(prefix))) continue;
    if (!out.has(path)) out.set(path, CRAWL_PRIORITY.test(path) ? 0 : 1);
  }
  return [...out.entries()].sort((a, b) => a[1] - b[1] || a[0].length - b[0].length).map(([path]) => path);
}

/* The paths robots.txt asks every crawler to leave alone. The check honours them. */
function robotsDisallowed(text) {
  const out = [];
  let applies = false;
  for (const raw of String(text || '').split(/\r?\n/).slice(0, 400)) {
    const line = raw.replace(/#.*/, '').trim();
    const field = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!field) continue;
    const name = field[1].toLowerCase();
    if (name === 'user-agent') applies = field[2].trim() === '*';
    else if (name === 'disallow' && applies && field[2].trim().startsWith('/')) out.push(field[2].trim().replace(/\*.*$/, ''));
  }
  return out.slice(0, 200);
}

function scriptSources(html, base) {
  const out = [];
  for (const [, attributes] of String(html || '').matchAll(/<script\b([^>]*)>/gi)) {
    const src = (/\bsrc\s*=\s*["']([^"']+)["']/i.exec(attributes) || [])[1];
    if (!src) continue;
    try { out.push(new URL(src, base).href); } catch { /* not an address */ }
  }
  return out;
}

function hstsSummary(value) {
  const text = String(value || '');
  if (!text) return null;
  const age = /max-age\s*=\s*"?(\d+)/i.exec(text);
  return Object.freeze({
    maxAge: age ? Number(age[1]) : null,
    includeSubDomains: /includeSubDomains/i.test(text),
    preload: /(?:^|;)\s*preload\s*(?:;|$)/i.test(text)
  });
}

/*
 * The check. `transport` is the guarded transport; every request it is given
 * is anonymous and bounded. `advisoryTransport` asks OSV about the libraries
 * found, and `txt` looks up the domain's email policy; either may be absent,
 * and what it would have answered is then reported as not checked, never as
 * clean. A failure to reach the page at all is an error, never an empty --
 * and therefore clean -- report.
 */
async function checkSite({ url, transport, advisoryTransport = null, txt = null, onProgress = null, limits = LIMITS, now = Date.now, random = () => crypto.randomBytes(6).toString('hex') }) {
  const requested = siteOrigin(url);
  let origin = requested;
  const startedAt = now();
  let probed = 0;
  const progress = update => { if (typeof onProgress === 'function') { try { onProgress(update); } catch { /* progress is advisory */ } } };
  const remaining = () => limits.deadlineMs - (now() - startedAt);
  const request = async (target, { method = 'GET', maxResponseBytes = limits.probeBytes, headers = {}, plainHttp = false } = {}) => {
    if (probed >= limits.maxRequests) throw new SiteCheckError('request budget spent', 'SITE_BUDGET');
    const left = remaining();
    if (left < 1000) throw new SiteCheckError('time budget spent', 'SITE_BUDGET');
    probed += 1;
    return transport({
      url: /^https?:\/\//.test(target) ? target : `${origin}${target}`, profile: 'site-probe', method, maxResponseBytes, plainHttp: plainHttp || undefined,
      headers: { accept: '*/*', 'accept-encoding': 'identity', 'user-agent': 'Nebulaverse-X-SiteCheck/2.0', ...headers },
      deadlineMs: Math.min(limits.requestMs, left)
    });
  };
  const raw = [];
  const ledger = new Map();
  const note = (id, state, detail) => ledger.set(id, { id, state, detail });

  /*
   * The page a visitor lands on, not the redirect in front of it: most sites
   * answer / with a hop to www or to a locale, and a redirect's headers are
   * not the page's. Each hop is a new request through the same guarded
   * profile, only to HTTPS on 443, at most three of them; the cookies set on
   * the way are the visitor's cookies too.
   */
  progress({ stage: 'page' });
  let page;
  let pathname = '/';
  let redirects = 0;
  const cookies = [];
  for (let hop = 0; ; hop += 1) {
    try { page = await request(pathname, { maxResponseBytes: limits.pageBytes }); }
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
  const landing = pathname;
  const pageHeaders = page.headers || {};
  raw.push(...headerFindings(pageHeaders));
  const html = looksLikeHtml(page) ? String(page.body || '') : '';
  const host = new URL(origin).hostname;
  const presentHeaders = ['strict-transport-security', 'content-security-policy', 'x-frame-options', 'x-content-type-options', 'referrer-policy', 'cross-origin-opener-policy']
    .filter(name => pageHeaders[name] || (name === 'x-frame-options' && /frame-ancestors/i.test(String(pageHeaders['content-security-policy'] || '')))).length;
  note('headers', presentHeaders >= 6 ? 'pass' : presentHeaders >= 3 ? 'warn' : 'fail', `${presentHeaders} of the 6 protective headers sent`);

  /* ---- The connection: certificate, protocol, plain HTTP, cross-origin reads ---- */
  progress({ stage: 'transport' });
  const tls = page.tls || null;
  let certificate = null;
  if (tls && tls.validTo) {
    const daysLeft = Math.floor((new Date(tls.validTo).getTime() - now()) / 86_400_000);
    certificate = Object.freeze({ protocol: tls.protocol || null, validTo: tls.validTo, daysLeft, issuer: tls.issuer || null });
    if (daysLeft <= 14) raw.push({ rule: 'WEB-029', where: `Certificate for ${host}` });
    else if (daysLeft <= 30) raw.push({ rule: 'WEB-030', where: `Certificate for ${host}` });
    note('certificate', daysLeft <= 14 ? 'fail' : daysLeft <= 30 ? 'warn' : 'pass', `Valid for ${Math.max(0, daysLeft)} more days${tls.issuer ? `, issued by ${tls.issuer}` : ''}`);
  } else {
    note('certificate', 'unknown', 'The certificate’s dates were not available to the check');
  }
  if (tls && /^(?:TLSv1(?:\.1)?|SSLv3)$/.test(tls.protocol || '')) raw.push({ rule: 'WEB-031', where: `${tls.protocol} on ${host}` });
  if (tls && tls.protocol) note('protocol', /^(?:TLSv1(?:\.1)?|SSLv3)$/.test(tls.protocol) ? 'fail' : 'pass', `Negotiated ${tls.protocol.replace('TLSv', 'TLS ')}`);

  let plain = 'unknown';
  try {
    const answer = await request(`http://${host}/`, { plainHttp: true });
    const location = String(answer.headers && answer.headers.location || '');
    const upgrades = answer.statusCode >= 300 && answer.statusCode < 400 && /^https:\/\//i.test(location);
    plain = upgrades ? 'redirects' : answer.statusCode >= 200 && answer.statusCode < 400 ? 'serves' : 'refuses';
    if (plain === 'serves') raw.push({ rule: 'WEB-020', where: `http://${host}/` });
  } catch (error) {
    plain = error && error.code === 'SITE_BUDGET' ? 'unknown' : 'closed';
  }
  note('plain-http', plain === 'serves' ? 'fail' : plain === 'unknown' ? 'unknown' : 'pass',
    { redirects: 'Plain HTTP redirects to HTTPS', serves: 'Plain HTTP serves the site without redirecting', refuses: 'Plain HTTP answers with an error, not the site', closed: 'Nothing answers on plain HTTP', unknown: 'Plain HTTP was not checked' }[plain]);
  const hsts = hstsSummary(pageHeaders['strict-transport-security']);
  if (hsts) note('hsts', hsts.maxAge >= 15552000 ? 'pass' : 'warn',
    `HSTS for ${Math.round((hsts.maxAge || 0) / 86400)} days${hsts.includeSubDomains ? ', subdomains included' : ''}${hsts.preload && hsts.maxAge >= 31536000 && hsts.includeSubDomains ? ', ready for the preload list' : ''}`);
  else note('hsts', 'fail', 'No Strict-Transport-Security header');

  /* Does the site let any other website read its answers with the visitor's cookies? Asked once, as another origin would. */
  const foreignOrigin = 'https://nv-origin-check.invalid';
  try {
    const answer = await request(landing, { headers: { origin: foreignOrigin } });
    const allowed = String(answer.headers && answer.headers['access-control-allow-origin'] || '').trim();
    const credentials = /true/i.test(String(answer.headers && answer.headers['access-control-allow-credentials'] || ''));
    const reflected = allowed === foreignOrigin && credentials;
    if (reflected) raw.push({ rule: 'WEB-010', where: 'Access-Control-Allow-Origin (reflects any origin)' });
    note('cors', reflected || (allowed === '*' && credentials) ? 'fail' : 'pass', reflected ? 'Any origin is trusted with the visitor’s cookies' : 'Other origins are not trusted with the visitor’s cookies');
  } catch {
    note('cors', 'unknown', 'Cross-origin access was not checked');
  }

  /* ---- Paths that must never be served, told apart from a catch-all page ------- */
  progress({ stage: 'paths', done: 0, total: PROBES.length + 2 });
  let baseline = null;
  try {
    const missing = await request(`/nv-site-check-${random()}`, { maxResponseBytes: limits.errorPageBytes });
    baseline = { status: missing.statusCode, length: String(missing.body || '').length, html: looksLikeHtml(missing) };
    const body = String(missing.body || '');
    const debug = DEBUG_SIGNATURES.find(([pattern]) => pattern.test(body));
    if (debug) raw.push({ rule: 'WEB-021', where: `${debug[1]} on a missing page` });
    note('errors', debug ? 'fail' : 'pass', debug ? `A missing page shows a ${debug[1]}` : `A missing page answers ${missing.statusCode} without a stack trace`);
  } catch {
    note('errors', 'unknown', 'The error page was not checked');
  }
  if (DIRECTORY_LISTING.test(html)) raw.push({ rule: 'WEB-022', where: displayPath(landing) });
  let served = 0;
  let asked = 0;
  let done = 0;
  await boundedMap(PROBES, limits.concurrency, async probe => {
    let response;
    try { response = await request(probe.path); asked += 1; }
    catch { return; }
    finally { done += 1; progress({ stage: 'paths', done, total: PROBES.length + 2 }); }
    if (response.statusCode !== 200 || response.bodyUnread) return;
    if (!probe.html && looksLikeHtml(response)) return;
    const body = String(response.body || '');
    if (probe.looks(body)) {
      served += 1;
      raw.push({ rule: probe.rule, where: probe.path });
    }
  });
  note('paths', served ? 'fail' : asked ? 'pass' : 'unknown', served
    ? `${served} of ${asked} paths that should never be served ${served === 1 ? 'is' : 'are'} served`
    : `${asked} paths that should never be served: none is`);

  let securityTxt = { contact: false, expires: null };
  try {
    const response = await request('/.well-known/security.txt', { maxResponseBytes: 8192 });
    const body = String(response.body || '');
    if (response.statusCode === 200 && !looksLikeHtml(response)) {
      const expires = /^\s*Expires:\s*(\S+)/im.exec(body);
      const date = expires ? new Date(expires[1]) : null;
      securityTxt = { contact: /^\s*Contact:/im.test(body), expires: date && !Number.isNaN(date.getTime()) ? date.toISOString() : null };
    }
  } catch { /* unanswered is the same as absent for a contact */ }
  progress({ stage: 'paths', done: PROBES.length + 1, total: PROBES.length + 2 });
  if (!securityTxt.contact) raw.push({ rule: 'WEB-014', where: '/.well-known/security.txt' });
  else if (!securityTxt.expires || new Date(securityTxt.expires).getTime() < now()) raw.push({ rule: 'WEB-026', where: '/.well-known/security.txt' });
  note('contact', !securityTxt.contact ? 'fail' : !securityTxt.expires || new Date(securityTxt.expires).getTime() < now() ? 'warn' : 'pass',
    !securityTxt.contact ? 'No security contact is published' : securityTxt.expires ? `security.txt names a contact until ${securityTxt.expires.slice(0, 10)}` : 'security.txt names a contact but no expiry');

  let disallowed = [];
  try {
    const robots = await request('/robots.txt', { maxResponseBytes: 16 * 1024 });
    if (robots.statusCode === 200 && !looksLikeHtml(robots)) disallowed = robotsDisallowed(robots.body);
  } catch { /* no robots.txt, nothing disallowed */ }
  progress({ stage: 'paths', done: PROBES.length + 2, total: PROBES.length + 2 });

  /* ---- Pages a visitor reaches from the landing page ---------------------------- */
  const pages = [{ path: displayPath(landing), status: page.statusCode, html }];
  const toVisit = pageLinks(html, `${origin}${landing}`, origin, disallowed).slice(0, limits.maxPages);
  progress({ stage: 'pages', done: 0, total: toVisit.length });
  let visited = 0;
  await boundedMap(toVisit, limits.concurrency, async path => {
    try {
      const response = await request(path, { maxResponseBytes: limits.pageBytes });
      const headers = response.headers || {};
      if (Array.isArray(headers['set-cookie'])) cookies.push(...headers['set-cookie']);
      const body = looksLikeHtml(response) ? String(response.body || '') : '';
      pages.push({ path: displayPath(path), status: response.statusCode, html: body });
      if (body) {
        const debug = DEBUG_SIGNATURES.find(([pattern, , anywhere]) => anywhere && pattern.test(body));
        if (debug) raw.push({ rule: 'WEB-021', where: `${debug[1]} on ${displayPath(path)}` });
        if (DIRECTORY_LISTING.test(body)) raw.push({ rule: 'WEB-022', where: displayPath(path) });
      }
    } catch { /* a page that did not answer is simply not among those read */ }
    finally { visited += 1; progress({ stage: 'pages', done: visited, total: toVisit.length }); }
  });
  for (const visitedPage of pages) {
    if (!visitedPage.html) continue;
    raw.push(...markupFindings(visitedPage.html, origin));
    for (const secret of shippedSecrets(visitedPage.html)) raw.push({ rule: 'WEB-023', where: `${secret.kind} in ${visitedPage.path}`, soft: SOFTER_SECRETS.has(secret.rule) });
  }
  raw.push(...cookieFindings(cookies));
  note('pages', 'pass', `${pages.length} ${pages.length === 1 ? 'page' : 'pages'} read: ${pages.map(entry => entry.path).slice(0, 6).join(', ')}${disallowed.length ? '; robots.txt honoured' : ''}`);
  const cookieNames = new Set(cookies.map(cookie => String(cookie).split('=')[0].trim()).filter(Boolean));
  note('cookies', raw.some(item => item.rule === 'WEB-011') ? 'fail' : raw.some(item => item.rule === 'WEB-012') ? 'warn' : 'pass',
    cookieNames.size ? `${cookieNames.size} ${cookieNames.size === 1 ? 'cookie' : 'cookies'} set to an anonymous visitor` : 'No cookie set to an anonymous visitor');

  /* ---- The JavaScript the pages load --------------------------------------------- */
  const allScripts = [...new Set(pages.flatMap(entry => scriptSources(entry.html, `${origin}${entry.path}`)))];
  const own = allScripts.filter(address => hostOf(address) === new URL(origin).host && /^https:/.test(address)).slice(0, limits.maxScripts);
  const thirdParty = [...new Set(allScripts.filter(address => hostOf(address) && hostOf(address) !== new URL(origin).host).map(hostOf))].slice(0, 12);
  const libraries = new Map();
  const addLibrary = found => {
    if (!found || !found.name || !VERSION.test(found.version)) return;
    const key = `${found.name}@${found.version}`;
    if (!libraries.has(key) && libraries.size < limits.maxLibraries) libraries.set(key, found);
  };
  allScripts.forEach(address => addLibrary(libraryFromAddress(address)));
  progress({ stage: 'scripts', done: 0, total: own.length });
  let scriptBytes = 0;
  let scriptsRead = 0;
  let mapsPublic = 0;
  const maps = [];
  let scanned = 0;
  await boundedMap(own, limits.concurrency, async address => {
    try {
      if (scriptBytes >= limits.scriptBudgetBytes) return;
      const response = await request(address, { maxResponseBytes: limits.scriptBytes });
      if (response.statusCode !== 200 || response.bodyUnread) return;
      const text = String(response.body || '');
      scriptBytes += text.length;
      scriptsRead += 1;
      const path = displayPath(new URL(address).pathname);
      for (const secret of shippedSecrets(text)) raw.push({ rule: 'WEB-023', where: `${secret.kind} in ${path}`, soft: SOFTER_SECRETS.has(secret.rule) });
      librariesInText(text).forEach(addLibrary);
      const declared = [...text.slice(-4096).matchAll(/\/[/*][#@]\s*sourceMappingURL=([^\s'"*]+)/g)].pop();
      const header = response.headers && (response.headers.sourcemap || response.headers['x-sourcemap']);
      const reference = header || (declared && declared[1]);
      if (reference && !/^data:/i.test(reference)) {
        try {
          const map = new URL(reference, address);
          if (map.origin === origin && maps.length < limits.maxMaps) maps.push(map.href);
        } catch { /* not an address */ }
      }
    } catch { /* unread */ }
    finally { scanned += 1; progress({ stage: 'scripts', done: scanned, total: own.length }); }
  });
  await boundedMap(maps, limits.concurrency, async address => {
    try {
      const response = await request(address, { maxResponseBytes: 1024 });
      if (response.statusCode === 200 && /^\s*\{\s*"version"\s*:\s*3\b|"mappings"\s*:/.test(String(response.body || ''))) {
        mapsPublic += 1;
        raw.push({ rule: 'WEB-024', where: displayPath(new URL(address).pathname) });
      }
    } catch { /* unread */ }
  });
  const secretsFound = raw.filter(item => item.rule === 'WEB-023').length;
  note('scripts', secretsFound ? 'fail' : own.length ? (scriptsRead ? 'pass' : 'unknown') : 'pass', own.length
    ? `${scriptsRead} of ${own.length} ${own.length === 1 ? 'script' : 'scripts'} on this origin read (${scriptBytes < 1024 ? 'under 1 KB' : `${Math.round(scriptBytes / 1024)} KB`})${secretsFound ? `; ${secretsFound} secret${secretsFound === 1 ? '' : 's'} found` : ', no server-side secret in them'}`
    : 'No script is loaded from this origin');
  note('maps', mapsPublic ? 'warn' : 'pass', mapsPublic ? `${mapsPublic} source ${mapsPublic === 1 ? 'map is' : 'maps are'} public` : maps.length ? 'Referenced source maps are not served' : 'No source map is referenced');

  /* ---- Libraries against the advisory database ----------------------------------- */
  const libraryList = [...libraries.values()];
  const libraryReport = [];
  progress({ stage: 'libraries', done: 0, total: libraryList.length });
  if (libraryList.length && typeof advisoryTransport === 'function') {
    let answers = null;
    try {
      ({ answers } = await lookupAdvisories(libraryList.map(entry => ({ ecosystem: 'npm', name: entry.name, version: entry.version })), advisoryTransport));
    } catch { answers = null; }
    for (const entry of libraryList) {
      const answer = answers && answers.get(advisoryKey({ ecosystem: 'npm', name: entry.name, version: entry.version }));
      if (!answer || answer === 'unknown') { libraryReport.push({ ...entry, state: 'unknown', advisories: 0 }); continue; }
      const advisories = answer.advisories || [];
      const rated = advisories.filter(advisory => advisory.severity);
      const order = { critical: 0, serious: 1, warning: 2 };
      const worst = rated.map(advisory => advisory.severity).sort((a, b) => order[a] - order[b])[0] || (advisories.length ? 'warning' : null);
      const fixes = rated.map(advisory => advisory.fixed).filter(Boolean);
      const fixed = rated.length && fixes.length === rated.length ? fixes.sort(compareVersions)[fixes.length - 1] : null;
      libraryReport.push({ ...entry, state: advisories.length ? 'vulnerable' : 'clean', advisories: advisories.length, severity: worst, fixed, ids: advisories.slice(0, 4).map(advisory => advisory.cve || advisory.id) });
      if (advisories.length) {
        raw.push({
          rule: 'WEB-025', where: `${entry.name} ${entry.version}`,
          severity: worst === 'critical' ? 'serious' : worst === 'serious' ? 'serious' : 'warning',
          note: `${advisories.length} published ${advisories.length === 1 ? 'advisory' : 'advisories'}: ${advisories.slice(0, 4).map(advisory => advisory.cve || advisory.id).join(', ')}.`,
          fixNote: fixed ? `Version ${fixed} fixes ${advisories.length === 1 ? 'it' : 'them'}.` : ''
        });
      }
    }
  } else {
    libraryList.forEach(entry => libraryReport.push({ ...entry, state: 'unknown', advisories: 0 }));
  }
  progress({ stage: 'libraries', done: libraryList.length, total: libraryList.length });
  const vulnerable = libraryReport.filter(entry => entry.state === 'vulnerable').length;
  note('libraries', vulnerable ? 'fail' : libraryReport.some(entry => entry.state === 'unknown') ? 'unknown' : 'pass', libraryList.length
    ? `${libraryList.length} ${libraryList.length === 1 ? 'library' : 'libraries'} recognised${vulnerable ? `, ${vulnerable} with published advisories` : libraryReport.some(entry => entry.state === 'unknown') ? ', not all checked against advisories' : ', none with a published advisory'}`
    : 'No versioned browser library recognised');

  /* ---- Email: can someone send mail as this domain? ------------------------------ */
  progress({ stage: 'email' });
  const mail = emailDomain(host);
  let email;
  if (mail.skipped) {
    email = { state: 'skipped', reason: mail.skipped, domain: null, spf: null, dmarc: null };
    note('email', 'skip', mail.skipped === 'shared-platform' ? 'Skipped: the site is on a shared platform’s domain, whose email is not the site’s' : 'Skipped: no domain to look up');
  } else if (typeof txt !== 'function') {
    email = { state: 'unknown', reason: 'not-asked', domain: mail.domain, spf: null, dmarc: null };
    note('email', 'unknown', 'The domain’s email policy was not looked up');
  } else {
    let spf = null;
    let dmarc = null;
    try {
      const records = await txt(mail.domain);
      const policy = records.find(record => /^v=spf1\b/i.test(record.trim()));
      spf = !policy ? 'missing' : /[+]?all\s*$/i.test(policy.trim()) && !/[-~?]all\s*$/i.test(policy.trim()) ? 'open' : /-all\s*$/i.test(policy.trim()) ? 'strict' : /~all\s*$/i.test(policy.trim()) ? 'soft' : 'neutral';
    } catch { spf = null; }
    try {
      const records = await txt(`_dmarc.${mail.domain}`);
      const policy = records.find(record => /^v=DMARC1\b/i.test(record.trim()));
      const mode = policy && /(?:^|;)\s*p\s*=\s*(none|quarantine|reject)/i.exec(policy);
      dmarc = !policy ? 'missing' : mode ? mode[1].toLowerCase() : 'none';
    } catch { dmarc = null; }
    if (spf === 'missing' || spf === 'open') raw.push({ rule: 'WEB-028', where: `${mail.domain} (SPF ${spf === 'open' ? 'allows anyone' : 'missing'})` });
    if (dmarc === 'missing' || dmarc === 'none') raw.push({ rule: 'WEB-027', where: `_dmarc.${mail.domain} (${dmarc === 'none' ? 'p=none' : 'missing'})` });
    email = { state: spf === null || dmarc === null ? 'partial' : 'checked', reason: null, domain: mail.domain, spf, dmarc };
    note('email', dmarc === 'missing' || dmarc === 'none' || spf === 'missing' || spf === 'open' ? 'warn' : spf === null || dmarc === null ? 'unknown' : 'pass',
      `${mail.domain}: SPF ${spf || 'unknown'}, DMARC ${dmarc === null ? 'unknown' : dmarc === 'missing' ? 'missing' : `p=${dmarc}`}`);
  }

  /* ---- The report ------------------------------------------------------------------ */
  const seen = new Set();
  const findings = raw.filter(item => {
    const key = `${item.rule}\0${item.where}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(item => describe(item.rule, item.where, {
    severity: item.severity || (item.soft ? 'warning' : null),
    note: item.note, fixNote: item.fixNote
  }));
  const order = { critical: 0, serious: 1, warning: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || a.rule.localeCompare(b.rule) || a.where.localeCompare(b.where));
  const byRule = new Map();
  for (const finding of findings) {
    const cap = PENALTY[finding.severity] * 2;
    byRule.set(finding.rule, Math.min(cap, (byRule.get(finding.rule) || 0) + PENALTY[finding.severity]));
  }
  const mean = Math.max(0, 100 - [...byRule.values()].reduce((total, penalty) => total + penalty, 0));
  const critical = findings.some(finding => finding.severity === 'critical');
  const score = critical ? Math.min(mean, CRITICAL_CAP) : mean;
  const LEDGER_ORDER = ['certificate', 'protocol', 'plain-http', 'hsts', 'headers', 'cookies', 'cors', 'paths', 'errors', 'pages', 'scripts', 'maps', 'libraries', 'contact', 'email'];
  return {
    engine: 2,
    origin,
    requested,
    redirects,
    status: page.statusCode,
    requests: probed,
    score,
    grade: gradeOf(score),
    capped: critical && mean > CRITICAL_CAP,
    findings,
    /*
     * The headers a browser enforces, each sent or not. X-Frame-Options is
     * the old spelling of CSP frame-ancestors; a page that sends the newer
     * one is protected, and says so rather than showing a missing header.
     */
    headers: Object.freeze(['strict-transport-security', 'content-security-policy', 'x-frame-options', 'x-content-type-options', 'referrer-policy', 'permissions-policy', 'cross-origin-opener-policy', 'cross-origin-resource-policy']
      .map(name => {
        const present = Boolean(pageHeaders[name]);
        const via = !present && name === 'x-frame-options' && /frame-ancestors/i.test(String(pageHeaders['content-security-policy'] || ''))
          ? 'content-security-policy' : null;
        return Object.freeze({ name, present, via });
      })),
    transport: Object.freeze({ certificate, plainHttp: plain, hsts }),
    pages: pages.map(entry => Object.freeze({ path: entry.path, status: entry.status })),
    scripts: Object.freeze({ read: scriptsRead, onOrigin: own.length, kilobytes: Math.ceil(scriptBytes / 1024), thirdParty, sourceMaps: mapsPublic }),
    libraries: libraryReport.map(entry => Object.freeze({ name: entry.name, version: entry.version, source: entry.source, state: entry.state, advisories: entry.advisories, severity: entry.severity || null, fixed: entry.fixed || null, ids: entry.ids || [] })),
    email: Object.freeze(email),
    ledger: LEDGER_ORDER.filter(id => ledger.has(id)).map(id => Object.freeze(ledger.get(id))),
    durationMs: Math.max(0, now() - startedAt)
  };
}

module.exports = Object.freeze({ RULES, PROBES, LIMITS, STAGES, SiteCheckError, siteOrigin, declaredSite, checkSite, emailDomain, libraryFromAddress, librariesInText, robotsDisallowed, displayPath });
