'use strict';

/*
 * The repository audit: what a code-level reviewer would flag in a quickly
 * built application, beyond the leaked credentials Exposure already finds.
 *
 * Four families, each a list of deterministic rules over files read through
 * the same guarded reader Exposure uses:
 *
 *   supply chain   code that fetches and runs something at install time, pipes
 *                  a remote script into a shell, decodes and executes a
 *                  payload, or ships local credentials off the machine;
 *   code           the handful of mistakes that turn into incidents -- SQL
 *                  built from input, HTML sinks fed variables, a CORS policy
 *                  that trusts every origin with credentials, secrets in
 *                  variables the bundler hands to the browser, webhooks that
 *                  never check who sent them, TLS verification switched off;
 *   dependencies   packages the manifest names that the public registry has
 *                  never heard of -- the names an assistant invents, which
 *                  anyone can later publish;
 *   hygiene        a committed .env, a .gitignore that would let one in, no
 *                  lockfile or two of them, open-ended versions, an unpinned
 *                  base image, TypeScript's strict mode off, no README, no
 *                  tests.
 *
 * What it will not do is repeat what it read. A finding names a rule, a path
 * and a line -- never the line itself -- so the audit carries no source text
 * to the browser, to a log or to anywhere it could be kept. Every finding
 * carries the fix in words and a prompt a reader can paste into an assistant,
 * both written from the rule, not from the code.
 *
 * And it says how much it read. A clean audit of a third of a repository is
 * not a clean repository, so coverage is part of the result, and the grade is
 * never better than the evidence under it: an open critical finding caps it.
 */

const crypto = require('crypto');

const CATEGORIES = Object.freeze([
  Object.freeze({ id: 'supply-chain', label: 'Supply chain', weight: 0.3 }),
  Object.freeze({ id: 'code', label: 'Code security', weight: 0.35 }),
  Object.freeze({ id: 'dependencies', label: 'Dependencies', weight: 0.15 }),
  Object.freeze({ id: 'hygiene', label: 'Project hygiene', weight: 0.2 })
]);

const SEVERITY_PENALTY = Object.freeze({ critical: 40, serious: 20, warning: 6 });
const CRITICAL_CAP = 49;
const GRADES = Object.freeze([['A', 90], ['B', 80], ['C', 70], ['D', 60], ['F', 0]]);

const LIMITS = Object.freeze({
  maxFiles: 600,
  maxTotalBytes: 12 * 1024 * 1024,
  maxFileBytes: 512 * 1024,
  maxLineScan: 20000,
  maxPackages: 120,
  readConcurrency: 8,
  lookupConcurrency: 6
});

const JS_EXT = new Set(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'vue', 'svelte', 'astro']);
const PY_EXT = new Set(['py']);
const SOURCE_EXT = new Set([...JS_EXT, ...PY_EXT, 'rb', 'php', 'go', 'java', 'kt', 'cs', 'rs', 'html', 'htm']);
const SCRIPT_EXT = new Set(['sh', 'bash', 'zsh', 'ps1', 'yml', 'yaml', 'toml', 'json', 'cfg', 'ini', 'conf', 'env', 'txt']);
const EXCLUDED_DIR = /(^|\/)(node_modules|vendor|bower_components|dist|build|out|\.next|\.nuxt|\.svelte-kit|\.output|coverage|\.venv|venv|__pycache__|\.git|target|Pods)\//;
const EXCLUDED_FILE = /(\.min\.(js|css)|\.map|\.bundle\.js|\.chunk\.js)$/i;
/* What inserted markup reads like when it came from outside the code. */
const UNTRUSTED = /(location\.|\.hash\b|\.search\b|searchParams|\bparams\b|\bquery\b|\.value\b|\binput\w*|response|\.json\b|\bdata\.|\bmessage|\bcomment|\buser\w*|\busername|\bbody\b|\btitle\b|\bname\b|\bdescription|\bcontent\b|\bpayload|\bhtml\b|\bmarkup\b|\btext\b)/i;
const LOCKFILES = Object.freeze(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock', 'npm-shrinkwrap.json']);

function extensionOf(filePath) {
  const base = String(filePath).split('/').pop();
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}
function baseName(filePath) {
  return String(filePath).split('/').pop();
}
function dirName(filePath) {
  const index = String(filePath).lastIndexOf('/');
  return index < 0 ? '' : filePath.slice(0, index);
}
function isDockerfile(filePath) {
  return /^(Dockerfile|Containerfile)(\..+)?$|\.dockerfile$/i.test(baseName(filePath));
}
function isTestPath(filePath) {
  return /(^|\/)(tests?|__tests__|spec|specs|e2e|cypress|playwright)\//i.test(filePath) ||
    /\.(test|spec)\.[a-z]+$/i.test(filePath) || /(^|\/)test_[^/]+\.py$|_test\.(py|go)$/.test(filePath);
}

/*
 * Which files an audit reads, most telling first. Manifests and build files
 * decide what runs on install and in production; then application source.
 * The order matters only when a repository is larger than the budget, and
 * then it decides what the coverage statement has to admit it did not read.
 */
function auditPriority(filePath) {
  const base = baseName(filePath);
  if (base === 'package.json' || base === 'requirements.txt' || base === 'pyproject.toml' || base === 'Pipfile' ||
    base === 'setup.py' || base === '.gitignore' || base === 'tsconfig.json' || isDockerfile(filePath)) return 0;
  if (/^\.github\/workflows\//.test(filePath) || base === 'Makefile' || /\.(sh|ps1)$/.test(base) || /^\.env/.test(base) ||
    /^(next|vite|nuxt|svelte|astro)\.config\./.test(base) || base === 'vercel.json' || base === 'netlify.toml' ||
    base === 'settings.py' || base === 'docker-compose.yml' || base === 'docker-compose.yaml') return 1;
  const ext = extensionOf(filePath);
  if (SOURCE_EXT.has(ext)) return isTestPath(filePath) ? 3 : 2;
  if (SCRIPT_EXT.has(ext)) return 4;
  return null;
}

function selectFiles(entries, limits = LIMITS) {
  const candidates = [];
  const skipped = { excluded: 0, oversize: 0, budget: 0 };
  for (const entry of entries) {
    if (EXCLUDED_DIR.test(`${entry.path}`) || EXCLUDED_FILE.test(entry.path)) { skipped.excluded += 1; continue; }
    if (LOCKFILES.includes(baseName(entry.path))) continue;
    const priority = auditPriority(entry.path);
    if (priority === null) continue;
    if (!Number.isInteger(entry.size) || entry.size > limits.maxFileBytes) { skipped.oversize += 1; continue; }
    candidates.push({ ...entry, priority });
  }
  candidates.sort((a, b) => a.priority - b.priority || a.path.localeCompare(b.path));
  const selected = [];
  let bytes = 0;
  for (const candidate of candidates) {
    if (selected.length >= limits.maxFiles || bytes + candidate.size > limits.maxTotalBytes) { skipped.budget += 1; continue; }
    selected.push(candidate);
    bytes += candidate.size;
  }
  return { selected, eligible: candidates.length, skipped };
}

/* ---- Rules ----------------------------------------------------------------- */

/*
 * Each rule says what it found in words a person can act on, and how to fix
 * it. The words are the rule's own: the audit never quotes the code.
 */
const RULES = Object.freeze({
  'SUP-001': { category: 'supply-chain', severity: 'critical', title: 'An install script fetches or evaluates code',
    why: 'A preinstall, install, postinstall or prepare script runs on every machine that installs the package, before anyone reads it. Fetching or evaluating code there is how compromised packages steal credentials from developer laptops and CI.',
    fix: 'Remove network fetches and eval from lifecycle scripts. If a build step is needed, run it explicitly from a documented command, and vendor or pin whatever it downloads with a checksum.' },
  'SUP-002': { category: 'supply-chain', severity: 'serious', title: 'A remote script is piped straight into a shell',
    why: 'Whatever the server returns at that moment runs with the privileges of the build, with nothing checked. A compromised or hijacked host, or a man in the middle on plain HTTP, becomes code execution.',
    fix: 'Download the script to a file, verify it against a pinned checksum or signature, then run it. Prefer a package manager or a pinned release artifact.' },
  'SUP-003': { category: 'supply-chain', severity: 'critical', title: 'Encoded content is decoded and executed',
    why: 'Decoding a string and passing it to eval, Function or exec hides what runs from every reviewer and scanner. It is the signature of injected malware far more often than of a legitimate need.',
    fix: 'Replace the decoded execution with the plain code it stands for. If you did not write it, treat the repository as compromised: rotate its secrets and review recent commits.' },
  'SUP-004': { category: 'supply-chain', severity: 'warning', title: 'A long encoded payload is embedded in source',
    why: 'A multi-kilobyte encoded blob in application code cannot be reviewed. Often it is an inlined asset; sometimes it is a packed payload waiting to be decoded.',
    fix: 'Move assets into files and load them normally. If the blob is code, replace it with its source.' },
  'SUP-005': { category: 'supply-chain', severity: 'critical', title: 'Local credentials or the whole environment are read and sent out',
    why: 'Reading a credential store (SSH keys, cloud credentials, .npmrc, git credentials) or serialising the entire environment alongside a network call is how credential-stealing packages work.',
    fix: 'Remove the code. Read only the specific configuration values the application needs, and never transmit environment variables or local credential files.' },
  'SUP-006': { category: 'supply-chain', severity: 'warning', title: 'A dependency is installed from a URL or Git repository',
    why: 'A dependency fetched from a branch or URL has no published version, so what installs can change without the manifest changing and no advisory database tracks it.',
    fix: 'Depend on a published registry version, or pin the Git dependency to a full commit hash.' },
  'SUP-007': { category: 'supply-chain', severity: 'critical', title: 'A privileged workflow checks out pull-request code',
    why: 'pull_request_target and workflow_run jobs run with the repository’s secrets and a write token. Checking out the pull request’s head there runs whatever a stranger’s pull request contains -- build scripts, test hooks, install scripts -- with those secrets in reach.',
    fix: 'Build and test contributed code under the pull_request trigger, which has no secrets. If a privileged step is needed, keep it off the contributed code, or pass only artifacts from the unprivileged run to a workflow_run job that never executes them.' },
  'SUP-008': { category: 'supply-chain', severity: 'warning', title: 'A third-party action is not pinned to a commit',
    why: 'A tag or branch can be moved to different code at any time by whoever controls the action, and the next run executes it with the job’s secrets. That is how the tj-actions/changed-files compromise reached thousands of repositories.',
    fix: 'Pin the action to its full 40-character commit SHA with the version in a comment beside it, and let Dependabot or Renovate propose updates.' },
  'SUP-009': { category: 'supply-chain', severity: 'serious', title: 'Untrusted event text is spliced into a workflow script',
    why: 'Expressions are substituted into the script before the shell sees it, so an issue title, pull-request body, branch name or commit message that contains shell syntax becomes a command, run with the job’s token and secrets.',
    fix: 'Pass the value through an environment variable -- env: TITLE: ${{ github.event.issue.title }} -- and use "$TITLE", quoted, in the script, so the shell treats it as data.' },

  'SEC-001': { category: 'code', severity: 'critical', title: 'A SQL statement is built by string interpolation',
    why: 'Values spliced into SQL text are parsed as SQL. Any of them that a user can influence is an injection: read or delete data, bypass login.',
    fix: 'Use parameterised queries or the query builder’s placeholders, and pass values separately from the statement text.' },
  'SEC-002': { category: 'code', severity: 'serious', title: 'HTML is written from a variable without sanitising it',
    why: 'Assigning dynamic content to innerHTML, outerHTML, dangerouslySetInnerHTML or v-html renders any markup it contains, so user-controlled text becomes script (cross-site scripting).',
    fix: 'Set textContent instead, or render through the framework’s escaping. If HTML is required, sanitise it with a vetted sanitiser such as DOMPurify first.' },
  'SEC-003': { category: 'code', severity: 'serious', title: 'CORS lets any origin make credentialed requests',
    why: 'Reflecting every origin or allowing "*" together with credentials lets any website call this API with the visitor’s cookies and read the answer.',
    fix: 'Allow an explicit list of trusted origins, and enable credentials only for those.' },
  'SEC-004': { category: 'code', severity: 'warning', title: 'A cookie is set without HttpOnly or Secure',
    why: 'Without HttpOnly any script on the page can read the cookie; without Secure it travels over plain HTTP. For a session cookie either one is a takeover waiting for an XSS or a hostile network.',
    fix: 'Set httpOnly: true, secure: true and sameSite: ‘lax’ or ‘strict’ on session and authentication cookies.' },
  'SEC-005': { category: 'code', severity: 'serious', title: 'A non-cryptographic random number generates a secret value',
    why: 'Math.random() and Python’s random module are predictable. Tokens, reset codes, passwords or session identifiers made from them can be guessed.',
    fix: 'Use crypto.randomUUID() or crypto.getRandomValues() in JavaScript, crypto.randomBytes() in Node, and the secrets module in Python.' },
  'SEC-006': { category: 'code', severity: 'critical', title: 'A secret is placed in a variable the browser receives',
    why: 'Build tools copy variables with public prefixes (NEXT_PUBLIC_, VITE_, REACT_APP_, EXPO_PUBLIC_ and the like) into the JavaScript every visitor downloads. A secret named that way is published.',
    fix: 'Rename it without the public prefix, use it only in server code, and rotate the value: it has already shipped to browsers.' },
  'SEC-007': { category: 'code', severity: 'serious', title: 'A webhook endpoint never verifies its sender',
    why: 'Anyone who finds the URL can post a forged event (a paid invoice, a merged pull request) unless the handler checks the provider’s signature.',
    fix: 'Verify the provider’s signature header against the raw request body with the shared secret, using a constant-time comparison, before acting on the event.' },
  'SEC-008': { category: 'code', severity: 'serious', title: 'TLS certificate verification is switched off',
    why: 'With verification off, anyone on the network path can impersonate the server and read or alter the traffic, including credentials.',
    fix: 'Remove the override. If a private CA is involved, configure that CA as trusted instead of disabling checks.' },
  'SEC-009': { category: 'code', severity: 'critical', title: 'A token is accepted without verifying its signature',
    why: 'Decoding a JWT without verifying it, or allowing the "none" algorithm, accepts any token anyone writes, so every claim in it, including who the user is, can be forged.',
    fix: 'Verify every token with the expected algorithm and key (jwt.verify, jose.jwtVerify, PyJWT with algorithms=[...]) before trusting its claims.' },
  'SEC-010': { category: 'code', severity: 'critical', title: 'Request input is executed as code',
    why: 'Passing request data to eval, Function or exec gives whoever sends the request the ability to run code on the server.',
    fix: 'Never evaluate input. Parse it as data (JSON.parse, a schema validator) and act on the parsed values.' },
  'SEC-011': { category: 'code', severity: 'serious', title: 'A shell command is built by string interpolation',
    why: 'Values spliced into a shell command are parsed by the shell. One that carries a semicolon or backtick runs a second command.',
    fix: 'Call the program with an argument array (execFile, spawn without a shell, subprocess.run([...]) with shell=False) so values are never parsed as shell syntax.' },
  'SEC-012': { category: 'code', severity: 'warning', title: 'Sign-in and account routes have no rate limiting',
    why: 'Without a limit, login, sign-up, password-reset and code-verification endpoints can be hammered for credential stuffing, enumeration or SMS/email cost.',
    fix: 'Add a per-IP and per-account rate limit to authentication routes (for example express-rate-limit, @upstash/ratelimit or Flask-Limiter).' },
  'SEC-013': { category: 'code', severity: 'serious', title: 'Debug mode is enabled in application configuration',
    why: 'Framework debug modes print stack traces, settings and sometimes an interactive console to anyone who triggers an error.',
    fix: 'Drive debug from an environment variable that defaults to off, and make sure production never sets it.' },

  'DEP-001': { category: 'dependencies', severity: 'serious', title: 'A dependency does not exist in the public registry',
    why: 'A package name the registry has never heard of is often one an assistant invented. Anyone can publish under that name later, and the next install will fetch their code.',
    fix: 'Check the name against the package’s documentation. Replace it with the real package, or remove it if nothing uses it.' },
  'DEP-002': { category: 'dependencies', severity: 'warning', title: 'A scoped dependency is not in the public registry',
    why: 'A scoped package missing from the public registry is either private (fine, if the registry is configured) or invented. If the scope is not yours, anyone who registers it controls what installs.',
    fix: 'Confirm the scope belongs to your organisation and the registry is configured in .npmrc; otherwise replace or remove the dependency.' },

  'HYG-001': { category: 'hygiene', severity: 'critical', title: 'An environment file is committed',
    why: 'Anyone who can read the repository, now or in any fork or clone, can read what the file holds. Removing it later does not remove it from history.',
    fix: 'Delete the file, add it to .gitignore, rotate every value it contained, and keep a .env.example with placeholder values instead.' },
  'HYG-002': { category: 'hygiene', severity: 'serious', title: '.gitignore does not exclude environment files',
    why: 'The project reads configuration from the environment, and nothing stops the next person committing their .env with it.',
    fix: 'Add ".env" and ".env.*" (with "!.env.example") to .gitignore.' },
  'HYG-003': { category: 'hygiene', severity: 'warning', title: 'The JavaScript project has no lockfile',
    why: 'Without a lockfile every install resolves versions afresh, so builds are not reproducible and a newly published malicious patch version installs silently.',
    fix: 'Commit the lockfile your package manager produces (package-lock.json, pnpm-lock.yaml or yarn.lock) and install with the frozen/ci mode.' },
  'HYG-004': { category: 'hygiene', severity: 'warning', title: 'More than one lockfile is committed',
    why: 'Two package managers resolve the same manifest differently, so which versions are installed depends on who ran what.',
    fix: 'Choose one package manager, delete the other lockfiles, and record the choice in package.json ("packageManager").' },
  'HYG-005': { category: 'hygiene', severity: 'warning', title: 'Dependencies accept any future version',
    why: 'A version of "*", "latest", "x" or an open-ended ">=" range installs whatever is published next, including a breaking or malicious release.',
    fix: 'Use a caret or exact version range and let the lockfile pin the resolved versions.' },
  'HYG-006': { category: 'hygiene', severity: 'warning', title: 'A container base image is not pinned',
    why: 'An image tagged latest, or with no tag, changes underneath the build, so the same Dockerfile produces different images over time.',
    fix: 'Pin the base image to a specific version tag, ideally with its digest (image:1.2.3@sha256:...).' },
  'HYG-007': { category: 'hygiene', severity: 'warning', title: 'TypeScript strict mode is off',
    why: 'Without strict mode, null and undefined flow through unchecked and implicit any hides type errors that become runtime failures.',
    fix: 'Set "strict": true in tsconfig.json and fix what it reports, or enable its checks one at a time.' },
  'HYG-008': { category: 'hygiene', severity: 'warning', title: 'The repository has no README',
    why: 'Nobody arriving at the repository, reviewers and future maintainers included, can tell what it does or how to run it safely.',
    fix: 'Add a README covering what the project is, how to run it locally, how configuration and secrets are supplied, and how to report a security issue.' },
  'HYG-009': { category: 'hygiene', severity: 'warning', title: 'No automated tests were found',
    why: 'Without tests every change, including a security fix, is verified by hand or not at all.',
    fix: 'Add a test runner and start with tests for authentication, authorisation and payment paths.' }
});

/* Why the per-rule contribution to a category is capped: one rule firing thirty times is one problem. */
const RULE_CAP = 2;

function lineOf(text, index) {
  let line = 1;
  for (let cursor = text.indexOf('\n'); cursor !== -1 && cursor < index; cursor = text.indexOf('\n', cursor + 1)) line += 1;
  return line;
}

/*
 * Whether a position on a line of JavaScript or Python sits inside a string
 * literal. Text there is data -- a message, a test fixture, a rule's own
 * description -- not a call, so a rule about a call does not fire on it. What
 * a template's ${...} or an f-string's {...} holds is code again, so hiding a
 * call there does not hide it. One line at a time: a string that spans lines
 * is read as code, which is the cautious direction.
 */
function inString(line, position) {
  const stack = [];
  for (let index = 0; index < position && index < line.length; index += 1) {
    const char = line[index];
    const top = stack[stack.length - 1];
    if (top && top.quote) {
      if (char === '\\') { index += 1; continue; }
      if (top.quote === '`' && char === '$' && line[index + 1] === '{') { stack.push({ brace: true }); index += 1; continue; }
      if (top.format && char === '{') {
        if (line[index + 1] === '{') { index += 1; continue; }
        stack.push({ brace: true });
        continue;
      }
      if (char === top.quote) stack.pop();
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      const prefix = line.slice(Math.max(0, index - 2), index);
      stack.push({ quote: char, format: char !== '`' && /(^|[^\w])[rR]?[fF]$|(^|[^\w])[fF][rR]$/.test(prefix) });
    } else if (top && top.brace && char === '{') {
      stack.push({ brace: true });
    } else if (top && top.brace && char === '}') {
      stack.pop();
    }
  }
  const top = stack[stack.length - 1];
  return Boolean(top && top.quote);
}

/* True when the pattern occurs on the line as code, not only inside a string. */
function inCode(pattern, line) {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  for (const match of line.matchAll(new RegExp(pattern.source, flags))) {
    if (!inString(line, match.index)) return true;
  }
  return false;
}
/* True when the pattern occurs inside a string literal: how code names a file. */
function inText(pattern, line) {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  for (const match of line.matchAll(new RegExp(pattern.source, flags))) {
    if (inString(line, match.index)) return true;
  }
  return false;
}
const lexical = file => JS_EXT.has(file.ext) || PY_EXT.has(file.ext);

/*
 * Every line-level rule: the files it applies to, and a test on one line.
 * Lines longer than the scan bound are cut, never skipped, so a minified
 * payload on one line is still looked at.
 */
const LINE_RULES = Object.freeze([
  {
    rule: 'SUP-002',
    applies: file => ['sh', 'bash', 'zsh', 'ps1', 'yml', 'yaml'].includes(file.ext) || isDockerfile(file.path) ||
      file.base === 'Makefile' || file.base === 'package.json',
    test: line => /\b(curl|wget)\b[^|\n]{0,300}\|\s*(sudo\s+)?(ba|z|da)?sh\b/.test(line) ||
      /\b(iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^|\n]{0,300}\|\s*iex\b/i.test(line)
  },
  {
    rule: 'SUP-003',
    applies: file => JS_EXT.has(file.ext) || PY_EXT.has(file.ext) || file.ext === 'html',
    /* In HTML an attribute's quotes hold script, so only JavaScript and Python have strings to discount. */
    test: (line, file) => [
      /\beval\s*\(\s*(atob|Buffer\.from|unescape|decodeURIComponent|String\.fromCharCode)\s*\(/,
      /\bnew\s+Function\s*\(\s*(atob|Buffer\.from|unescape)\s*\(/,
      /\b(exec|eval)\s*\(\s*(base64\.b64decode|codecs\.decode|zlib\.decompress|marshal\.loads|bytes\.fromhex)\s*\(/
    ].some(pattern => (lexical(file) ? inCode(pattern, line) : pattern.test(line)))
  },
  {
    rule: 'SUP-004',
    applies: file => JS_EXT.has(file.ext) || PY_EXT.has(file.ext),
    test: line => {
      const match = /[A-Za-z0-9+/]{1200,}={0,2}/.exec(line);
      return Boolean(match) && !/data:[a-z/+.-]+;base64,$/i.test(line.slice(Math.max(0, match.index - 60), match.index));
    }
  },
  {
    rule: 'SUP-005',
    applies: file => (JS_EXT.has(file.ext) || PY_EXT.has(file.ext) || file.ext === 'sh') && !isTestPath(file.path),
    /* Code names a credential file in a string; the same words elsewhere (a pattern, an identifier) read nothing. */
    test: (line, file) => {
      const store = /(\.ssh\/id_(rsa|ed25519|ecdsa)|\.aws\/credentials|\.git-credentials|\.docker\/config\.json|\.kube\/config|Login Data|\.config\/gcloud)/;
      return lexical(file) ? inText(store, line) : store.test(line);
    }
  },
  {
    rule: 'SEC-001',
    applies: file => !isTestPath(file.path) && (JS_EXT.has(file.ext) || PY_EXT.has(file.ext) || ['rb', 'php', 'go', 'java', 'kt', 'cs'].includes(file.ext)),
    test: (line, file) => [
      /\.(query|execute|raw|exec|all|get|run|prepare|\$queryRawUnsafe|\$executeRawUnsafe)\s*\(\s*`[^`]*\b(SELECT|INSERT|UPDATE|DELETE)\b[^`]*\$\{/i,
      /\.(query|execute|raw|exec)\s*\(\s*["'][^"'\n]*\b(SELECT|INSERT|UPDATE|DELETE)\b[^"'\n]*["']\s*\+/i,
      /\.execute\s*\(\s*f["'][^"'\n]*\b(SELECT|INSERT|UPDATE|DELETE)\b[^"'\n]*\{/i,
      /\.execute\s*\(\s*["'][^"'\n]*\b(SELECT|INSERT|UPDATE|DELETE)\b[^"'\n]*["']\s*(%\s*[\w(]|\.format\s*\()/i
    ].some(pattern => (lexical(file) ? inCode(pattern, line) : pattern.test(line)))
  },
  {
    rule: 'SEC-002',
    applies: file => (JS_EXT.has(file.ext) || file.ext === 'html') && !isTestPath(file.path),
    test: (line, file) => {
      if (/(\besc\w*\s*\(|escape\w*\s*\(|sanitiz\w*\s*\(|DOMPurify|purify\w*\s*\()/i.test(line)) return false;
      /* A framework's raw-HTML escape hatch fed anything but a literal. */
      if (/dangerouslySetInnerHTML\s*=\s*\{\{\s*__html\s*:\s*[A-Za-z_$]/.test(line) || /\bv-html\s*=\s*["'][A-Za-z_$]/.test(line)) return true;
      /*
       * innerHTML and document.write only when what is inserted reads like
       * data from outside the code: a URL, a form, a response, a message, a
       * user's name. Markup assembled from the code's own constants is how
       * most interfaces are built, and flagging all of it would bury the
       * one assignment that matters.
       */
      const sink = /(\.(inner|outer)HTML\s*\+?=|\bdocument\.write(ln)?\s*\(|insertAdjacentHTML\s*\([^,]*,)\s*(.*)$/.exec(line);
      if (!sink || (JS_EXT.has(file.ext) && inString(line, sink.index))) return false;
      const inserted = sink[4] || '';
      const parts = [];
      for (const match of inserted.matchAll(/\$\{([^}]*)\}/g)) parts.push(match[1]);
      const concat = /["'`]\s*\+\s*([^;]+)/.exec(inserted);
      if (concat) parts.push(concat[1]);
      if (/^[A-Za-z_$][\w$.]*\s*;?\s*$/.test(inserted)) parts.push(inserted);
      return parts.some(part => UNTRUSTED.test(part));
    }
  },
  {
    rule: 'SEC-004',
    applies: file => !isTestPath(file.path) && (JS_EXT.has(file.ext) || PY_EXT.has(file.ext)),
    test: line => /\b(httpOnly|secure)\s*:\s*false\b/.test(line) ||
      (/\bres\.cookie\s*\(/.test(line) && !/httpOnly\s*:\s*true/.test(line) && /\)\s*;?\s*$/.test(line)) ||
      (/\.set_cookie\s*\(/.test(line) && !/httponly\s*=\s*True/i.test(line) && /\)\s*$/.test(line))
  },
  {
    rule: 'SEC-005',
    applies: file => (JS_EXT.has(file.ext) || PY_EXT.has(file.ext)) && !isTestPath(file.path),
    test: line => (inCode(/\bMath\.random\s*\(/, line) || inCode(/\brandom\.(random|randint|choice|choices|randrange|getrandbits)\s*\(/, line)) &&
      /(token|secret|passw|otp|nonce|salt|session|api_?key|reset|invite|verification|verify_code|auth_code)/i.test(line)
  },
  {
    /*
     * The variable is only public when it is read as a variable: through the
     * environment in code, or set in an env file or a CI env block. The same
     * words inside an identifier or an error code mean nothing.
     */
    rule: 'SEC-006',
    applies: file => SOURCE_EXT.has(file.ext) || /^\.env/.test(file.base) || file.ext === 'yml' || file.ext === 'yaml' || file.ext === 'toml',
    test: (line, file) => {
      const name = '(NEXT_PUBLIC_|VITE_|REACT_APP_|EXPO_PUBLIC_|NUXT_PUBLIC_|GATSBY_)[A-Z0-9_]*(SECRET|PRIVATE|SERVICE_ROLE|PASSWORD|PASSWD|ACCESS_KEY|SK_LIVE|SK_TEST)[A-Z0-9_]*';
      if (/^\.env/.test(file.base) || ['yml', 'yaml', 'toml'].includes(file.ext)) return new RegExp(`^\\s*(export\\s+)?${name}\\s*[=:]`).test(line);
      const read = new RegExp(`(process\\.env|import\\.meta\\.env)(\\.|\\[\\s*['"])${name}\\b`);
      return lexical(file) ? inCode(read, line) : read.test(line);
    }
  },
  {
    rule: 'SEC-008',
    applies: file => !isTestPath(file.path) && (SOURCE_EXT.has(file.ext) || /^\.env/.test(file.base) || file.ext === 'yml' || file.ext === 'yaml' || isDockerfile(file.path)),
    test: line => /\brejectUnauthorized\s*:\s*false\b/.test(line) || /NODE_TLS_REJECT_UNAUTHORIZED\s*[=:]\s*['"]?0/.test(line) ||
      /\bverify\s*=\s*False\b/.test(line) || /ssl\._create_unverified_context/.test(line) || /InsecureSkipVerify\s*:\s*true/.test(line) ||
      /CURLOPT_SSL_VERIFYPEER\s*,\s*(false|0)/i.test(line)
  },
  {
    rule: 'SEC-009',
    applies: file => !isTestPath(file.path) && (JS_EXT.has(file.ext) || PY_EXT.has(file.ext)),
    test: line => /algorithms?\s*[:=]\s*\[?\s*['"]none['"]/i.test(line) ||
      /["']verify_signature["']\s*:\s*False/.test(line) || /jwt\.decode\s*\([^)]*verify\s*=\s*False/.test(line)
  },
  {
    rule: 'SEC-010',
    applies: file => !isTestPath(file.path) && (JS_EXT.has(file.ext) || PY_EXT.has(file.ext) || file.ext === 'php'),
    test: (line, file) => (lexical(file)
      ? inCode(/\b(eval|new\s+Function|exec)\s*\(\s*(req|request)\.(body|query|params|args|form|json|data|values|GET|POST)/, line)
      : /\b(eval|new\s+Function|exec)\s*\(\s*(req|request)\.(body|query|params|args|form|json|data|values|GET|POST)/.test(line)) ||
      /\beval\s*\(\s*\$_(GET|POST|REQUEST|COOKIE)/.test(line)
  },
  {
    rule: 'SEC-011',
    applies: file => !isTestPath(file.path) && (JS_EXT.has(file.ext) || PY_EXT.has(file.ext)),
    test: line => [
      /\b(exec|execSync)\s*\(\s*`[^`]*\$\{/,
      /\b(exec|execSync)\s*\(\s*["'][^"'\n]*["']\s*\+\s*[A-Za-z_$]/,
      /\bsubprocess\.(run|call|Popen|check_output|check_call)\s*\((?=[^)]*shell\s*=\s*True)[^)]*(f["']|\+|%|\.format)/,
      /\bos\.system\s*\(\s*(f["']|[^)]*(\+|%|\.format))/
    ].some(pattern => inCode(pattern, line))
  },
  {
    rule: 'SEC-013',
    applies: file => PY_EXT.has(file.ext) && !isTestPath(file.path),
    test: (line, file) => (file.base === 'settings.py' && /^\s*DEBUG\s*=\s*True\b/.test(line)) ||
      /\bapp\.run\s*\([^)]*debug\s*=\s*True/.test(line)
  }
]);

/*
 * GitHub Actions workflows, the three ways a workflow hands the repository to
 * an outsider: a privileged trigger that checks out their code, their text
 * substituted into a script, and a third-party action whose tag can be moved.
 * Read line by line with the indentation of a run or script block tracked,
 * because the same expression is the fix in an env mapping and the bug in a
 * script. First-party actions (actions/*, github/*) may use a version tag.
 */
const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const EVENT_TEXT = /\$\{\{[^}]*\b(github\.event\.(issue\.(title|body)|pull_request\.(title|body|head\.ref|head\.label|head\.repo\.default_branch)|comment\.body|review\.body|review_comment\.body|discussion\.(title|body)|head_commit\.(message|author\.(name|email))|commits\b[^}]*\.(message|author)|workflow_run\.(head_branch|display_title|head_commit\.message))|github\.head_ref)\b/;
const PRIVILEGED_TRIGGER = /^\s*(pull_request_target|workflow_run)\s*:|^\s*on\s*:.*\b(pull_request_target|workflow_run)\b|^\s*-\s*(pull_request_target|workflow_run)\s*$/m;
const HEAD_CHECKOUT = /^\s*(-\s+)?ref\s*:.*\$\{\{\s*(github\.event\.pull_request\.head\.(sha|ref)|github\.head_ref|github\.event\.workflow_run\.head_(sha|branch))\s*\}\}/;

function workflowFindings(file) {
  const out = [];
  const privileged = PRIVILEGED_TRIGGER.test(file.text);
  let block = null;
  file.text.split('\n').forEach((line, index) => {
    const indent = line.search(/\S/);
    if (block !== null && indent !== -1 && indent <= block) block = null;
    const key = /^(\s*(?:-\s+)?)(run|script)\s*:\s*(.*)$/.exec(line);
    if (key) {
      if (/^[|>][-+]?\s*$/.test(key[3])) block = key[1].length;
      else if (EVENT_TEXT.test(key[3])) out.push({ rule: 'SUP-009', line: index + 1 });
      return;
    }
    if (block !== null) {
      if (EVENT_TEXT.test(line)) out.push({ rule: 'SUP-009', line: index + 1 });
      return;
    }
    if (privileged && HEAD_CHECKOUT.test(line)) out.push({ rule: 'SUP-007', line: index + 1 });
    const uses = /^\s*(?:-\s+)?uses\s*:\s*['"]?([^'"\s#]+)/.exec(line);
    if (!uses || uses[1].startsWith('./')) return;
    const target = uses[1];
    if (target.startsWith('docker://')) {
      if (!target.includes('@sha256:')) out.push({ rule: 'SUP-008', line: index + 1 });
      return;
    }
    const at = target.lastIndexOf('@');
    const owner = target.split('/')[0].toLowerCase();
    if (owner === 'actions' || owner === 'github') return;
    if (at < 0 || !/^[0-9a-f]{40}$/i.test(target.slice(at + 1))) out.push({ rule: 'SUP-008', line: index + 1 });
  });
  return out;
}

/*
 * Rules that need the whole file: co-occurrence rather than a line on its own.
 * Each returns the line the finding points at, or 0.
 */
function fileRules(file) {
  const out = [];
  if (WORKFLOW.test(file.path)) out.push(...workflowFindings(file));
  const text = file.text;
  const js = JS_EXT.has(file.ext);
  const py = PY_EXT.has(file.ext);

  /* SUP-005, the environment serialised in a file that also talks to the network. */
  if ((js || py) && !isTestPath(file.path)) {
    const dump = /JSON\.stringify\s*\(\s*process\.env\s*\)|\bdict\s*\(\s*os\.environ\s*\)|json\.dumps\s*\(\s*(dict\s*\()?\s*os\.environ/.exec(text);
    if (dump && /\b(fetch|axios|https?\.request|request\.post|requests\.(post|put)|urllib|XMLHttpRequest|net\.connect|dns\.resolve)\b/.test(text)) {
      out.push({ rule: 'SUP-005', line: lineOf(text, dump.index) });
    }
  }

  /* SEC-003, a permissive origin together with credentials, in code rather than in a string about it. */
  if ((js || py) && !isTestPath(file.path)) {
    const wildcard = [...text.matchAll(/(origin\s*:\s*(['"]\*['"]|true)|Access-Control-Allow-Origin['"]?\s*[,:]\s*['"]\*['"]|allow_origins\s*=\s*\[\s*['"]\*['"]\s*\]|CORS_ALLOW_ALL_ORIGINS\s*=\s*True|origins\s*=\s*['"]\*['"])/g)]
      .find(match => {
        const start = text.lastIndexOf('\n', match.index) + 1;
        const end = text.indexOf('\n', match.index);
        return !inString(text.slice(start, end === -1 ? text.length : end), match.index - start);
      });
    if (wildcard && /(credentials\s*:\s*true|Allow-Credentials['"]?\s*[,:]\s*['"]?true|allow_credentials\s*=\s*True|supports_credentials\s*=\s*True|CORS_ALLOW_CREDENTIALS\s*=\s*True)/i.test(text)) {
      out.push({ rule: 'SEC-003', line: lineOf(text, wildcard.index) });
    }
  }

  /* SEC-007, a webhook route in a file with no signature check anywhere. */
  if ((js || py) && !isTestPath(file.path)) {
    const route = /(\.(post|all|use)\s*\(\s*['"`][^'"`\n]*webhook|@(app|router|bp|blueprint)\.(post|route)\s*\(\s*['"][^'"\n]*webhook)/i.exec(text);
    const nextRoute = /(^|\/)(pages\/api|app\/api|api)\/[^ ]*webhook/i.test(file.path) && /export\s+(async\s+)?(function\s+POST|default|const\s+POST)/.test(text);
    const verified = /(constructEvent|verifySignature|verify_signature|verifyWebhook|webhooks?\.verify|createHmac|hmac\.|timingSafeEqual|compare_digest|x-hub-signature|stripe-signature|svix|x-signature|signature)/i.test(text);
    if ((route || nextRoute) && !verified) out.push({ rule: 'SEC-007', line: route ? lineOf(text, route.index) : 1 });
  }

  /* SEC-009, a token decoded in a file that never verifies one. */
  if (js && /\bjwt\.decode\s*\(/.test(text) && !/\b(jwt\.verify|jwtVerify|verifyToken|verify\s*\()/.test(text)) {
    const decode = /\bjwt\.decode\s*\(/.exec(text);
    out.push({ rule: 'SEC-009', line: lineOf(text, decode.index), severity: 'warning' });
  }
  return out;
}

/* ---- Manifests --------------------------------------------------------------- */

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function keyLine(text, key) {
  const index = text.indexOf(`"${key}"`);
  return index < 0 ? 1 : lineOf(text, index);
}

function packageJsonFindings(file) {
  const out = [];
  const manifest = parseJson(file.text);
  if (!manifest || typeof manifest !== 'object') return { out, packages: [] };
  const scripts = manifest.scripts && typeof manifest.scripts === 'object' ? manifest.scripts : {};
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'preuninstall', 'postuninstall']) {
    const script = String(scripts[hook] || '');
    if (/\b(curl|wget|Invoke-WebRequest|iwr|node\s+-e|node\s+--eval|eval|base64\s+(-d|--decode)|bash\s+-c|sh\s+-c|powershell|python\s+-c)\b/i.test(script)) {
      out.push({ rule: 'SUP-001', line: keyLine(file.text, hook) });
    }
  }
  const packages = [];
  const open = [];
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const deps = manifest[section] && typeof manifest[section] === 'object' ? manifest[section] : {};
    for (const [name, rawVersion] of Object.entries(deps)) {
      const version = String(rawVersion || '').trim();
      if (/^(git\+|git:|github:|gitlab:|bitbucket:|https?:)/.test(version) || /^[\w.-]+\/[\w.-]+(#.*)?$/.test(version)) {
        out.push({ rule: 'SUP-006', line: keyLine(file.text, name) });
        continue;
      }
      if (/^(file:|link:|workspace:|portal:|npm:)/.test(version)) continue;
      if (section !== 'peerDependencies' && (version === '*' || version === '' || /^(latest|x|next)$/i.test(version) || /^>=?\s*[\d.]+$/.test(version))) {
        open.push(name);
      }
      if (/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(name)) packages.push({ ecosystem: 'npm', name, path: file.path, line: keyLine(file.text, name) });
    }
  }
  if (open.length) out.push({ rule: 'HYG-005', line: keyLine(file.text, open[0]) });
  return { out, packages, hasDependencies: packages.length > 0 };
}

function requirementsPackages(file) {
  const packages = [];
  file.text.split('\n').forEach((raw, index) => {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line || line.startsWith('-') || /^(git\+|https?:|\.|\/)/.test(line) || line.includes('@ ')) return;
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(line);
    if (match) packages.push({ ecosystem: 'pypi', name: match[1], path: file.path, line: index + 1 });
  });
  return packages;
}

/* PEP 503: the name PyPI answers to. */
function normalizePypi(name) {
  return String(name).toLowerCase().replace(/[-_.]+/g, '-');
}

/* ---- The audit ----------------------------------------------------------------- */

function fingerprint(rule, filePath, ordinal) {
  return crypto.createHash('sha256').update(`${rule}\0${filePath}\0${ordinal}`).digest('hex').slice(0, 24);
}

function describe(rule, filePath, line, severityOverride) {
  const definition = RULES[rule];
  const severity = severityOverride || definition.severity;
  const where = filePath ? `${filePath}${line ? ` (line ${line})` : ''}` : 'this repository';
  return {
    rule,
    category: definition.category,
    severity,
    path: filePath || null,
    line: line || null,
    title: definition.title,
    why: definition.why,
    fix: definition.fix,
    /*
     * A prompt a reader can paste into a coding assistant. Written from the
     * rule and the location only, so it carries no code and asks for the fix
     * to be proved rather than asserted.
     */
    prompt: `In ${where}: ${definition.title.toLowerCase()}. ${definition.why} ${definition.fix} ` +
      'Make the smallest change that fixes it, keep the existing behaviour otherwise, and add or update a test that fails before the fix and passes after.'
  };
}

function gradeOf(score) {
  if (!Number.isFinite(score)) return null;
  return GRADES.find(([, min]) => score >= min)[0];
}

function score(findings) {
  const categories = CATEGORIES.map(category => {
    const inCategory = findings.filter(finding => finding.category === category.id);
    const byRule = new Map();
    for (const finding of inCategory) {
      const entry = byRule.get(finding.rule) || { penalty: 0, count: 0, cap: SEVERITY_PENALTY[finding.severity] * RULE_CAP };
      entry.penalty = Math.min(entry.cap, entry.penalty + SEVERITY_PENALTY[finding.severity]);
      entry.count += 1;
      byRule.set(finding.rule, entry);
    }
    const penalty = [...byRule.values()].reduce((total, entry) => total + entry.penalty, 0);
    const counts = { critical: 0, serious: 0, warning: 0 };
    for (const finding of inCategory) counts[finding.severity] += 1;
    return { id: category.id, label: category.label, weight: category.weight, score: Math.max(0, 100 - penalty), counts };
  });
  const mean = Math.round(categories.reduce((total, category) => total + category.score * category.weight, 0) /
    categories.reduce((total, category) => total + category.weight, 0));
  const critical = findings.some(finding => finding.severity === 'critical');
  const total = critical ? Math.min(mean, CRITICAL_CAP) : mean;
  return { score: total, grade: gradeOf(total), capped: critical && mean > CRITICAL_CAP, categories };
}

/*
 * Runs the rules over files that have already been read. Pure: the same files
 * and the same registry answers give the same result, which is what lets it be
 * tested without a provider.
 */
function analyse({ files, paths, registry = new Map() }) {
  const raw = [];
  const packages = [];
  const allPaths = Array.isArray(paths) ? paths : files.map(file => file.path);
  const pathSet = new Set(allPaths);
  let usesEnvironment = false;
  let authRoute = null;
  let rateLimited = false;
  let packageJsonWithDependencies = null;

  for (const source of files) {
    const file = { ...source, ext: extensionOf(source.path), base: baseName(source.path) };
    if (typeof file.text !== 'string') continue;
    if (/process\.env\.|import\.meta\.env\.|os\.environ|os\.getenv|getenv\s*\(|dotenv/.test(file.text) || /^\.env\.(example|sample|template)$/.test(file.base)) usesEnvironment = true;
    if (/(rateLimit|rate-limit|ratelimit|RateLimiter|slowDown|express-slow-down|@upstash\/ratelimit|flask_limiter|Limiter\s*\(|throttle)/i.test(file.text)) rateLimited = true;
    if (!authRoute && (JS_EXT.has(file.ext) || PY_EXT.has(file.ext)) && !isTestPath(file.path)) {
      const auth = /(\.(post|put)\s*\(\s*['"`][^'"`\n]*(login|log-in|signin|sign-in|signup|sign-up|register|reset-password|forgot|otp|verify-code|magic-link)|@(app|router|bp)\.(post|route)\s*\(\s*['"][^'"\n]*(login|signin|signup|register|reset|otp))/i.exec(file.text);
      const nextAuth = /(^|\/)(pages\/api|app\/api)\/[^ ]*(login|signin|signup|register|reset|otp)/i.test(file.path) && /export\s+(async\s+)?(function\s+POST|default|const\s+POST)/.test(file.text);
      if (auth) authRoute = { path: file.path, line: lineOf(file.text, auth.index) };
      else if (nextAuth) authRoute = { path: file.path, line: 1 };
    }

    if (file.base === 'package.json') {
      const manifest = packageJsonFindings(file);
      manifest.out.forEach(finding => raw.push({ ...finding, path: file.path }));
      packages.push(...manifest.packages);
      if (manifest.hasDependencies && !packageJsonWithDependencies) packageJsonWithDependencies = file.path;
    }
    if (file.base === 'requirements.txt') packages.push(...requirementsPackages(file));
    if (isDockerfile(file.path)) {
      const stages = new Set();
      file.text.split('\n').forEach((line, index) => {
        const from = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
        if (!from) return;
        const image = from[1];
        if (from[2]) stages.add(from[2].toLowerCase());
        if (image === 'scratch' || image.startsWith('$') || stages.has(image.toLowerCase())) return;
        if (image.includes('@sha256:')) return;
        const tag = image.includes(':') ? image.slice(image.lastIndexOf(':') + 1) : '';
        if (!tag || tag === 'latest' || image.lastIndexOf(':') < image.lastIndexOf('/')) raw.push({ rule: 'HYG-006', path: file.path, line: index + 1 });
      });
    }
    if (file.base === 'tsconfig.json' && !dirName(file.path).split('/').some(part => part === 'node_modules')) {
      const strict = /"strict"\s*:\s*(true|false)/.exec(file.text);
      if (!strict || strict[1] === 'false') {
        if (!/"extends"\s*:/.test(file.text) || (strict && strict[1] === 'false')) raw.push({ rule: 'HYG-007', path: file.path, line: strict ? lineOf(file.text, strict.index) : 1 });
      }
    }

    const lines = file.text.split('\n');
    for (const definition of LINE_RULES) {
      if (!definition.applies(file)) continue;
      lines.forEach((line, index) => {
        const bounded = line.length > LIMITS.maxLineScan ? line.slice(0, LIMITS.maxLineScan) : line;
        /* A comment that only mentions the pattern is not the pattern. */
        if (/^\s*(\/\/|#|\*|<!--)/.test(bounded) && definition.rule !== 'SEC-006') return;
        if (definition.test(bounded, file)) raw.push({ rule: definition.rule, path: file.path, line: index + 1 });
      });
    }
    fileRules(file).forEach(finding => raw.push({ ...finding, path: file.path }));
  }

  /* Repository-level rules, from what is present rather than what is written. */
  for (const filePath of allPaths) {
    const base = baseName(filePath);
    if (/^\.env(\.(local|production|prod|development|dev|staging|stage|test))?$/.test(base) && !EXCLUDED_DIR.test(filePath)) {
      raw.push({ rule: 'HYG-001', path: filePath, line: null });
    }
  }
  const gitignore = files.find(file => file.path === '.gitignore');
  if (usesEnvironment && (!gitignore || !/^\s*(\/?\.env\b|\.env\*|\*\.env|\.env\.\*)/m.test(gitignore.text || ''))) {
    raw.push({ rule: 'HYG-002', path: gitignore ? '.gitignore' : null, line: null });
  }
  if (packageJsonWithDependencies) {
    const dir = dirName(packageJsonWithDependencies);
    const locks = LOCKFILES.filter(lock => pathSet.has(dir ? `${dir}/${lock}` : lock));
    if (!locks.length && !LOCKFILES.some(lock => pathSet.has(lock))) raw.push({ rule: 'HYG-003', path: packageJsonWithDependencies, line: null });
    if (locks.filter(lock => lock !== 'npm-shrinkwrap.json').length > 1) raw.push({ rule: 'HYG-004', path: packageJsonWithDependencies, line: null });
  }
  if (!allPaths.some(filePath => /^readme(\.[a-z]+)?$/i.test(filePath))) raw.push({ rule: 'HYG-008', path: null, line: null });
  const sourceCount = allPaths.filter(filePath => SOURCE_EXT.has(extensionOf(filePath)) && !EXCLUDED_DIR.test(filePath)).length;
  if (sourceCount >= 5 && !allPaths.some(filePath => isTestPath(filePath))) raw.push({ rule: 'HYG-009', path: null, line: null });
  if (authRoute && !rateLimited) raw.push({ rule: 'SEC-012', path: authRoute.path, line: authRoute.line });

  /* Dependencies the public registry answered for. Unknown is not missing. */
  const dependencyStatus = { checked: 0, missing: 0, unknown: 0 };
  for (const entry of dedupePackages(packages)) {
    const answer = registry.get(packageKey(entry));
    if (!answer) continue;
    dependencyStatus.checked += 1;
    if (answer === 'unknown') { dependencyStatus.unknown += 1; continue; }
    if (answer !== 'missing') continue;
    dependencyStatus.missing += 1;
    raw.push({ rule: entry.name.startsWith('@') ? 'DEP-002' : 'DEP-001', path: entry.path, line: entry.line });
  }

  /* One finding per rule and location, with an identity stable across runs. */
  const seen = new Map();
  const findings = [];
  for (const item of raw) {
    const key = `${item.rule}\0${item.path || ''}\0${item.line || ''}`;
    if (seen.has(key)) continue;
    seen.set(key, true);
    const ordinal = findings.filter(existing => existing.rule === item.rule && existing.path === (item.path || null)).length;
    findings.push({ id: fingerprint(item.rule, item.path || '', ordinal), ...describe(item.rule, item.path, item.line, item.severity) });
  }
  const order = { critical: 0, serious: 1, warning: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || String(a.path).localeCompare(String(b.path)) || (a.line || 0) - (b.line || 0));
  return { findings, dependencyStatus, ...score(findings) };
}

function packageKey(entry) {
  return `${entry.ecosystem}:${entry.ecosystem === 'pypi' ? normalizePypi(entry.name) : entry.name.toLowerCase()}`;
}
function dedupePackages(packages) {
  const out = new Map();
  for (const entry of packages) if (!out.has(packageKey(entry))) out.set(packageKey(entry), entry);
  return [...out.values()];
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

/*
 * Does the public registry know this name? Asked with HEAD through the
 * guarded transport, so nothing but a status comes back. Only a 404 is
 * "missing": a timeout, a refusal or a 5xx is "unknown", and unknown is never
 * reported as a finding -- an unreachable registry is not an invented package.
 */
function registryUrl(entry) {
  if (entry.ecosystem === 'npm') return `https://registry.npmjs.org/${entry.name.startsWith('@') ? `@${encodeURIComponent(entry.name.slice(1))}` : encodeURIComponent(entry.name)}`;
  return `https://pypi.org/pypi/${encodeURIComponent(normalizePypi(entry.name))}/json`;
}

async function lookupPackages(packages, transport, limits = LIMITS) {
  const answers = new Map();
  const unique = dedupePackages(packages).slice(0, limits.maxPackages);
  await boundedMap(unique, limits.lookupConcurrency, async entry => {
    let answer = 'unknown';
    try {
      const response = await transport({
        url: registryUrl(entry), profile: 'provider-read', method: 'HEAD',
        headers: { accept: 'application/json', 'user-agent': 'Nebulaverse-X-Audit/1.0' }, maxResponseBytes: 1024
      });
      const status = Number(response && response.statusCode);
      if (status === 404) answer = 'missing';
      else if ((status >= 200 && status < 400)) answer = 'exists';
    } catch { answer = 'unknown'; }
    answers.set(packageKey(entry), answer);
  });
  return { answers, asked: unique.length, total: dedupePackages(packages).length };
}

/*
 * The whole audit against a provider: resolve the ref once, list the tree at
 * that commit, read what fits the budget, ask the registries, analyse.
 */
async function auditRepository({ reader, scope, ref, token, transport, registryTransport, limits = LIMITS }) {
  const resolved = await reader.resolveCommit({ scope, ref, token, transport });
  const tree = await reader.readTree({ scope, commitSha: resolved.commitSha, token, transport });
  const paths = [...tree.entries.map(entry => entry.path), ...tree.skipped.filter(entry => entry.path).map(entry => entry.path)];
  const selection = selectFiles(tree.entries, limits);
  let unreadable = 0;
  const files = (await boundedMap(selection.selected, limits.readConcurrency, async entry => {
    const blob = await reader.readBlob({ scope, sha: entry.sha, token, transport });
    if (typeof blob.text !== 'string') { unreadable += 1; return null; }
    return { path: entry.path, text: blob.text };
  })).filter(Boolean);

  const packages = [];
  for (const file of files) {
    if (baseName(file.path) === 'package.json') packages.push(...packageJsonFindings({ ...file, ext: 'json', base: 'package.json' }).packages);
    if (baseName(file.path) === 'requirements.txt') packages.push(...requirementsPackages(file));
  }
  const registry = registryTransport ? await lookupPackages(packages, registryTransport, limits) : { answers: new Map(), asked: 0, total: 0 };
  const result = analyse({ files, paths, registry: registry.answers });
  return {
    commitSha: resolved.commitSha,
    ref: resolved.ref,
    coverage: {
      treeTruncated: Boolean(tree.truncated),
      filesInTree: paths.length,
      eligible: selection.eligible,
      read: files.length,
      unreadable,
      skipped: selection.skipped,
      complete: !tree.truncated && selection.skipped.budget === 0 && unreadable === 0,
      packages: { declared: registry.total, checked: result.dependencyStatus.checked, unknown: result.dependencyStatus.unknown, notChecked: Math.max(0, registry.total - registry.asked) }
    },
    ...result
  };
}

module.exports = Object.freeze({
  CATEGORIES, RULES, LIMITS, CRITICAL_CAP, SEVERITY_PENALTY,
  analyse, auditRepository, selectFiles, lookupPackages, registryUrl, normalizePypi, gradeOf
});
