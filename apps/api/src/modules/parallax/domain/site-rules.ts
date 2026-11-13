/*
 * What a deployed-site check can find, as data: each rule's severity and the
 * words it is reported in; the files that must never be served, each with
 * the test of what such a file has to contain; the signatures of a debug or
 * error page and of a directory index; which credentials are public by
 * design; and how a browser library names its version, in its own banner or
 * in the address a CDN serves it from.
 */
import type { Severity } from '../../../../../../packages/contracts/src/findings.ts';
import { lookupTable } from '../../../platform/values/fields.ts';

export interface SiteRule {
  readonly severity: Severity;
  readonly title: string;
  readonly why: string;
  readonly fix: string;
}

const DEFINITIONS = {
  'WEB-001': { severity: 'critical', title: 'An environment file is served publicly',
    why: 'Anyone can download it, and environment files hold database URLs, API keys and signing secrets.',
    fix: 'Stop serving it (move it out of the public directory, or deny dot-files at the server), then rotate every value it held.' },
  'WEB-002': { severity: 'critical', title: 'The Git repository is served publicly',
    why: 'With the .git directory reachable, the whole source history can be reconstructed, including any secret ever committed.',
    fix: 'Deny access to /.git at the web server or remove it from the deployed files, and treat committed secrets as leaked.' },
  'WEB-003': { severity: 'serious', title: 'No Strict-Transport-Security header',
    why: 'Without HSTS a visitor’s first request can be downgraded to plain HTTP and intercepted.',
    fix: 'Send "Strict-Transport-Security: max-age=31536000; includeSubDomains" on every HTTPS response.' },
  'WEB-004': { severity: 'warning', title: 'Strict-Transport-Security is invalid or too short',
    why: 'An invalid max-age does not establish HSTS protection. A max-age under six months lets the protection lapse between visits.',
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
  'WEB-009': { severity: 'warning', title: 'No valid Referrer-Policy',
    why: 'Full URLs, including tokens or identifiers in query strings, leak to every site the page links to.',
    fix: 'Send "Referrer-Policy: strict-origin-when-cross-origin" or stricter.' },
  'WEB-010': { severity: 'serious', title: 'Any origin may make credentialed requests',
    why: 'An untrusted reflected or null Access-Control-Allow-Origin with credentials can let another website read this endpoint’s responses with a visitor’s cookies, subject to browser cookie restrictions.',
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
  'WEB-037': { severity: 'warning', title: 'Credentialed CORS uses an invalid wildcard origin',
    why: 'Browsers reject credentialed CORS when Access-Control-Allow-Origin is *. This configuration breaks credentialed cross-origin access; it does not allow other sites to read cookie-backed responses.',
    fix: 'For credentialed clients, return one explicitly trusted origin. Otherwise remove Access-Control-Allow-Credentials and keep the public wildcard.' },
  'WEB-036': { severity: 'serious', title: 'Version-control metadata is served publicly',
    why: 'A reachable Subversion or Mercurial directory lets the source, and its history, be reconstructed from the site.',
    fix: 'Deny access to /.svn and /.hg at the web server, or remove them from the deployed files.' }
} satisfies Record<string, SiteRule>;
export type SiteRuleId = keyof typeof DEFINITIONS;
export const RULES: Readonly<Record<SiteRuleId, SiteRule>> = Object.freeze(DEFINITIONS);

/* A rule's id, when the text names one: a name inherited from Object.prototype does not. */
export function isSiteRule(value: unknown): value is SiteRuleId {
  return typeof value === 'string' && Object.hasOwn(RULES, value);
}

export interface Probe {
  readonly path: string;
  readonly rule: SiteRuleId;
  readonly looks: (body: string) => boolean;
  /* The file is itself a page, so an HTML answer can be it. */
  readonly html?: true;
}

/*
 * Files that must never be served, each recognised by what a file of that
 * kind has to contain rather than by the status alone: a single-page app
 * answers every path with its index, and that is not a leak.
 */
const ENV_LINE = /^\s*(export\s+)?[A-Z][A-Z0-9_]{1,80}\s*=/m;
export const PROBES: readonly Probe[] = Object.freeze([
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
export type DebugSignature = readonly [pattern: RegExp, name: string, anywhere?: boolean];
export const DEBUG_SIGNATURES: readonly DebugSignature[] = Object.freeze([
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
export const DIRECTORY_LISTING = /<title>\s*(?:Index of \/|Directory listing for \/)/i;

/*
 * Credentials that are public by design and belong in a browser: a
 * Supabase anonymous key, a Google browser API key. A Stripe test key is a
 * secret, but a test one; it is reported one step softer.
 */
export const PUBLIC_BY_DESIGN: ReadonlySet<string> = new Set(['supabase-anon-key', 'google-api-key']);
export const SOFTER_SECRETS: ReadonlySet<string> = new Set(['stripe-test-key']);

/*
 * Browser libraries, by the banner their builds carry or the address a CDN
 * serves them from, as the npm package the advisory database knows them by.
 */
export const LIBRARY_BANNERS: readonly (readonly [name: string, banner: RegExp])[] = Object.freeze([
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
/* A CDN's name for a library, as the npm package; a table without a prototype, since the name is read from an address. */
export const CDN_NAMES: Readonly<Record<string, string>> = lookupTable({
  jquery: 'jquery', 'jquery-ui': 'jquery-ui', jqueryui: 'jquery-ui', 'jquery-migrate': 'jquery-migrate', bootstrap: 'bootstrap', 'twitter-bootstrap': 'bootstrap',
  'angular.js': 'angular', angular: 'angular', 'moment.js': 'moment', moment: 'moment', 'handlebars.js': 'handlebars', handlebars: 'handlebars',
  dompurify: 'dompurify', 'underscore.js': 'underscore', underscore: 'underscore', vue: 'vue', axios: 'axios', 'lodash.js': 'lodash', lodash: 'lodash',
  knockout: 'knockout', 'datatables.net': 'datatables.net', datatables: 'datatables.net'
});
export const VERSION = /^\d+\.\d+\.\d+$/;
