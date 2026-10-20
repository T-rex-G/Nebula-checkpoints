import { lineOf } from './audit-text.ts';
import { JS_EXT, PY_EXT, SOURCE_EXT, isDockerfile, isTestPath } from './audit-files.ts';

/*
 * The rules that read a file line by line, and the few that need the whole
 * file: supply chain, code patterns, workflows. A rule about a call never
 * fires on a string that only mentions it.
 */

/* A file as the rules read it: its path, its text, and its extension and base name, worked out once. */
export interface RuleFile {
  readonly path: string;
  readonly text: string;
  readonly ext: string;
  readonly base: string;
}
/* What a rule found: the rule and the line, and a severity when the rule sets its own. */
export interface RuleHit {
  readonly rule: string;
  readonly line: number;
  readonly severity?: 'critical' | 'serious' | 'warning';
}
interface LineRule {
  readonly rule: string;
  readonly applies: (file: RuleFile) => boolean;
  readonly test: (line: string, file: RuleFile) => boolean;
}

/* What inserted markup reads like when it came from outside the code. */
const UNTRUSTED = /(location\.|\.hash\b|\.search\b|searchParams|\bparams\b|\bquery\b|\.value\b|\binput\w*|response|\.json\b|\bdata\.|\bmessage|\bcomment|\buser\w*|\busername|\bbody\b|\btitle\b|\bname\b|\bdescription|\bcontent\b|\bpayload|\bhtml\b|\bmarkup\b|\btext\b)/i;
/*
 * Whether a position on a line of JavaScript or Python sits inside a string
 * literal. Text there is data -- a message, a test fixture, a rule's own
 * description -- not a call, so a rule about a call does not fire on it. What
 * a template's ${...} or an f-string's {...} holds is code again, so hiding a
 * call there does not hide it. One line at a time: a string that spans lines
 * is read as code, which is the cautious direction.
 */
interface Opened {
  readonly quote?: string;
  readonly format?: boolean;
  readonly brace?: boolean;
}
export function inString(line: string, position: number): boolean {
  const stack: Opened[] = [];
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

/*
 * The global form of a rule's pattern, compiled once. The rules run on every
 * line of every file, and building a fresh expression and iterator for each
 * line was most of what an audit spent. The rules are a fixed set, so the
 * cache is too; the bound only guards against a caller that builds its
 * patterns from data.
 */
const GLOBAL_PATTERNS = new Map<string, Map<string, RegExp>>();
function globalPattern(pattern: RegExp): RegExp {
  /* Keyed by flags, then by the source string itself: joining the two per line cost more than the match. */
  let byFlags = GLOBAL_PATTERNS.get(pattern.flags);
  if (!byFlags) GLOBAL_PATTERNS.set(pattern.flags, byFlags = new Map());
  let compiled = byFlags.get(pattern.source);
  if (!compiled) {
    if (byFlags.size >= 512) byFlags.clear();
    compiled = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    byFlags.set(pattern.source, compiled);
  }
  compiled.lastIndex = 0;
  return compiled;
}
/* Whether any match of the pattern on the line is, or is not, inside a string. */
function occurs(pattern: RegExp, line: string, wantString: boolean): boolean {
  const compiled = globalPattern(pattern);
  for (let match = compiled.exec(line); match; match = compiled.exec(line)) {
    if (match[0] === '') compiled.lastIndex += 1;
    if (inString(line, match.index) === wantString) return true;
  }
  return false;
}
/*
 * A line of JavaScript or Python up to a comment that follows its code:
 * `//` or `/*` (or Python's `#`) after a space or the end of a statement,
 * outside any string. A regular expression's escaped slashes never start one.
 */
export function codeOf(line: string, python: boolean): string {
  const marker = python ? /(^|[\s;,)\]}])#/g : /(^|[\s;,)\]}])\/[/*]/g;
  for (let match = marker.exec(line); match; match = marker.exec(line)) {
    const at = match.index + (match[1] ?? '').length;
    if (!inString(line, at)) return line.slice(0, at);
  }
  return line;
}
/* True when the pattern occurs on the line as code, not only inside a string. */
export const inCode = (pattern: RegExp, line: string): boolean => occurs(pattern, line, false);
/* True when the pattern occurs inside a string literal: how code names a file. */
const inText = (pattern: RegExp, line: string): boolean => occurs(pattern, line, true);
export const lexical = (file: RuleFile): boolean => JS_EXT.has(file.ext) || PY_EXT.has(file.ext);
/* SUP-005: a credential store, the calls that read a file, and the ways code names the user's home directory. */
const CREDENTIAL_STORE = /(\.ssh\/id_(rsa|ed25519|ecdsa)|\.aws\/credentials|\.git-credentials|\.docker\/config\.json|\.kube\/config|Login Data|\.config\/gcloud)/;
const LOCAL_READ = /\b(readFileSync|readFile|createReadStream|readSync|read_text|read_bytes|open)\s*\(/;
const HOME_DIR = /\bhomedir\s*\(|\bexpanduser\s*\(|\bPath\.home\s*\(|\bprocess\.env\.(HOME|USERPROFILE)\b|\b(environ(\.get)?\s*[[(]|getenv\s*\()\s*['"](HOME|USERPROFILE)['"]|['"`]~[\/]/;
const SHELL_CREDENTIAL_READ = /(~|\$\{?HOME\}?|\/root|\/home\/[\w.-]+)\/[^\s'"]*(\.ssh\/id_(rsa|ed25519|ecdsa)|\.aws\/credentials|\.git-credentials|\.docker\/config\.json|\.kube\/config|\.config\/gcloud)/;
/* A value read straight off an incoming request, in the frameworks that name it so. */
const REQUEST_VALUE = '(req|request|ctx\\.request|ctx)\\.(query|body|params)\\b';
const REDIRECT_REQUEST = new RegExp(`\\b(res|reply|ctx|response|NextResponse)\\.redirect\\s*\\(\\s*(\\d{3}\\s*,\\s*)?${REQUEST_VALUE}`);
const FETCH_REQUEST = new RegExp(`\\b(fetch|axios(\\.(get|post|put|patch|delete|head|request))?|got(\\.(get|post))?|needle|superagent\\.(get|post)|https?\\.(get|request))\\s*\\(\\s*${REQUEST_VALUE}`);
const FILE_REQUEST = new RegExp(`\\b(res\\.(sendFile|download)|(fs|fsp|fs\\.promises)\\.(readFile|readFileSync|createReadStream|writeFile|writeFileSync|appendFile|unlink|unlinkSync|rm|rmSync))\\s*\\(\\s*(path\\.(join|resolve)\\s*\\(\\s*([^()]*?,\\s*)?)?${REQUEST_VALUE}`);
/* A variable a bundler ships to the browser, named as if it held a secret. */
const PUBLIC_SECRET = '(NEXT_PUBLIC_|VITE_|REACT_APP_|EXPO_PUBLIC_|NUXT_PUBLIC_|GATSBY_)[A-Z0-9_]*(SECRET|PRIVATE|SERVICE_ROLE|PASSWORD|PASSWD|ACCESS_KEY|SK_LIVE|SK_TEST)[A-Z0-9_]*';
const PUBLIC_SECRET_SET = new RegExp(`^\\s*(export\\s+)?${PUBLIC_SECRET}\\s*[=:]`);
const PUBLIC_SECRET_READ = new RegExp(`(process\\.env|import\\.meta\\.env)(\\.|\\[\\s*['"])${PUBLIC_SECRET}\\b`);

/*
 * Every line-level rule: the files it applies to, and a test on one line.
 * Lines longer than the scan bound are cut, never skipped, so a minified
 * payload on one line is still looked at.
 */
export const LINE_RULES: readonly LineRule[] = Object.freeze([
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
      return match !== null && !/data:[a-z/+.-]+;base64,$/i.test(line.slice(Math.max(0, match.index - 60), match.index));
    }
  },
  {
    rule: 'SUP-005',
    applies: file => (JS_EXT.has(file.ext) || PY_EXT.has(file.ext) || file.ext === 'sh') && !isTestPath(file.path),
    /*
     * Code names a credential file in a string, and reads it from this
     * machine: a file API on the line, or the user's home directory in the
     * file. The same path as a URL a scanner asks a website for, or in a
     * pattern or an identifier, reads nothing.
     */
    test: (line, file) => {
      if (!lexical(file)) return SHELL_CREDENTIAL_READ.test(line);
      return inText(CREDENTIAL_STORE, line) && (LOCAL_READ.test(line) || HOME_DIR.test(line) || HOME_DIR.test(file.text));
    }
  },
  {
    rule: 'SEC-001',
    applies: file => !isTestPath(file.path) && (JS_EXT.has(file.ext) || PY_EXT.has(file.ext) || ['rb', 'php', 'go', 'java', 'kt', 'cs'].includes(file.ext)),
    test: (line, file) => [
      /\.(query|execute|raw|exec|all|get|run|prepare|\$queryRawUnsafe|\$executeRawUnsafe)\s*\(\s*`[^`]*\b(SELECT|INSERT|UPDATE|DELETE)\b[^`]*\$\{/i,
      /* a quoted statement, which may hold the other quote ("... name = '" + x), followed by a splice */
      /\.(query|execute|raw|exec)\s*\(\s*(?:"[^"\n]*\b(SELECT|INSERT|UPDATE|DELETE)\b[^"\n]*"|'[^'\n]*\b(SELECT|INSERT|UPDATE|DELETE)\b[^'\n]*')\s*\+/i,
      /\.execute\s*\(\s*f(?:"[^"\n]*\b(SELECT|INSERT|UPDATE|DELETE)\b[^"\n]*\{|'[^'\n]*\b(SELECT|INSERT|UPDATE|DELETE)\b[^'\n]*\{)/i,
      /\.execute\s*\(\s*(?:"[^"\n]*\b(SELECT|INSERT|UPDATE|DELETE)\b[^"\n]*"|'[^'\n]*\b(SELECT|INSERT|UPDATE|DELETE)\b[^'\n]*')\s*(%\s*[\w(]|\.format\s*\()/i
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
      const parts: string[] = [];
      for (const match of inserted.matchAll(/\$\{([^}]*)\}/g)) parts.push(match[1] ?? '');
      const concat = /["'`]\s*\+\s*([^;]+)/.exec(inserted);
      if (concat) parts.push(concat[1] ?? '');
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
      /* A reset or invite is a secret when it is the token, code or link -- not a UI key that forces a re-render. */
      /(token|secret|passw|otp|nonce|salt|session|api_?key|reset[_-]?(token|code|link|hash|secret|pass)|invite[_-]?(token|code|link|secret)|verification|verify_code|auth_code)/i.test(line)
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
      if (/^\.env/.test(file.base) || ['yml', 'yaml', 'toml'].includes(file.ext)) return PUBLIC_SECRET_SET.test(line);
      return lexical(file) ? inCode(PUBLIC_SECRET_READ, line) : PUBLIC_SECRET_READ.test(line);
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
  },
  /*
   * Request values handed straight to a redirect, an outbound fetch or the
   * file system. Only the direct hand-off: a value that went through a check
   * first is on another line, and guessing at data flow would flag the fix.
   */
  {
    rule: 'SEC-020',
    applies: file => !isTestPath(file.path) && (JS_EXT.has(file.ext) || PY_EXT.has(file.ext)),
    test: line => inCode(REDIRECT_REQUEST, line) ||
      inCode(/\bredirect\s*\(\s*request\.(args|form|values|GET|POST)\b/, line) ||
      inCode(/\bredirect\s*\(\s*(searchParams|request\.args|req\.query)\.get\s*\(/, line)
  },
  {
    rule: 'SEC-021',
    applies: file => !isTestPath(file.path) && (JS_EXT.has(file.ext) || PY_EXT.has(file.ext)),
    test: line => inCode(FETCH_REQUEST, line) ||
      inCode(/\b(requests|httpx)\.(get|post|put|patch|delete|head|request)\s*\(\s*request\.(args|form|values|json|GET|POST)\b/, line) ||
      inCode(/\burlopen\s*\(\s*request\.(args|form|values|json|GET|POST)\b/, line)
  },
  {
    rule: 'SEC-022',
    applies: file => !isTestPath(file.path) && (JS_EXT.has(file.ext) || PY_EXT.has(file.ext)),
    test: line => inCode(FILE_REQUEST, line) ||
      inCode(/\b(open|send_file|send_from_directory)\s*\(\s*(os\.path\.join\s*\(\s*([^()]*?,\s*)?)?request\.(args|form|values|GET|POST)\b/, line)
  },
  {
    /* A general-purpose hash applied to something the line calls a password. */
    rule: 'SEC-023',
    applies: file => !isTestPath(file.path) && (JS_EXT.has(file.ext) || PY_EXT.has(file.ext)),
    test: line => /passw/i.test(line) && (
      inCode(/\bcreateHash\s*\(\s*['"](md5|sha1|sha224|sha256|sha384|sha512)['"]/i, line) ||
      inCode(/\bhashlib\.(md5|sha1|sha224|sha256|sha384|sha512)\s*\(/, line) ||
      inCode(/\b(md5|sha1|sha256)\s*\(\s*[\w.]*passw/i, line))
  },
  {
    rule: 'SEC-024',
    applies: file => !isTestPath(file.path) && (JS_EXT.has(file.ext) || PY_EXT.has(file.ext) || file.ext === 'php'),
    test: (line, file) => (lexical(file) ? inCode : (pattern: RegExp, text: string) => pattern.test(text))(
      /\b(pickle|cPickle|_pickle|marshal|shelve|dill)\.loads?\s*\(|\byaml\.unsafe_load\s*\(|\bjsonpickle\.decode\s*\(|\bunserialize\s*\(\s*\$_(GET|POST|REQUEST|COOKIE)|\b(serialize|nodeSerialize)\.unserialize\s*\(/, line) ||
      (inCode(/\byaml\.load\s*\(/, line) && !/Loader\s*=\s*(yaml\.)?(Safe|CSafe|Base)Loader/.test(line))
  },
  {
    /* The provider SDKs' own switch for running in a browser, set on. */
    rule: 'AI-003',
    applies: file => JS_EXT.has(file.ext) && !isTestPath(file.path),
    test: line => inCode(/\bdangerouslyAllowBrowser\s*:\s*true\b/, line)
  },
  {
    /* A stack trace or a traceback put into what the client receives. */
    rule: 'SEC-031',
    applies: file => !isTestPath(file.path) && (JS_EXT.has(file.ext) || PY_EXT.has(file.ext)),
    test: (line, file) => (JS_EXT.has(file.ext)
      ? inCode(/\b(res|reply|response|ctx)\s*\.\s*(status\s*\(\s*\d+\s*\)\s*\.\s*)?(send|json|end|write)\s*\([^)]*\b(err|error|e|ex|exception)\s*\.\s*stack\b/, line) ||
        inCode(/\bstack\s*:\s*(err|error|e|ex)\s*\.\s*stack\b/, line) ||
        inCode(/\b(NextResponse|Response)\s*\.\s*json\s*\([^)]*\b(err|error|e)\s*\.\s*stack\b/, line)
      : /\btraceback\s*\.\s*format_exc\s*\(\s*\)/.test(line) && /\b(return|jsonify|Response|JSONResponse|HTTPException|make_response)\b/.test(line)) &&
      !/NODE_ENV|isDev|DEBUG|development/.test(line)
  },
  {
    rule: 'SEC-025',
    applies: file => !isTestPath(file.path) && (JS_EXT.has(file.ext) || PY_EXT.has(file.ext)),
    test: (line, file) => inCode(/\bjwt\.(sign|verify|encode)\s*\(\s*[^,]+,\s*['"][^'"]{4,}['"]/, line) ||
      (PY_EXT.has(file.ext) && (/^\s*SECRET_KEY\s*=\s*['"][^'"]{8,}['"]/.test(line) ||
        /\bapp\.(secret_key|config\[\s*['"](SECRET_KEY|JWT_SECRET_KEY)['"]\s*\])\s*=\s*['"][^'"]{4,}['"]/.test(line))) ||
      inCode(/\b(secret|secretOrPrivateKey)\s*:\s*['"][^'"]{8,}['"]/, line) && /\b(session|jwt|cookie|express-session|passport)\b/i.test(line)
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
export const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const EVENT_TEXT = /\$\{\{[^}]*\b(github\.event\.(issue\.(title|body)|pull_request\.(title|body|head\.ref|head\.label|head\.repo\.default_branch)|comment\.body|review\.body|review_comment\.body|discussion\.(title|body)|head_commit\.(message|author\.(name|email))|commits\b[^}]*\.(message|author)|workflow_run\.(head_branch|display_title|head_commit\.message))|github\.head_ref)\b/;
const PRIVILEGED_TRIGGER = /^\s*(pull_request_target|workflow_run)\s*:|^\s*on\s*:.*\b(pull_request_target|workflow_run)\b|^\s*-\s*(pull_request_target|workflow_run)\s*$/m;
const HEAD_CHECKOUT = /^\s*(-\s+)?ref\s*:.*\$\{\{\s*(github\.event\.pull_request\.head\.(sha|ref)|github\.head_ref|github\.event\.workflow_run\.head_(sha|branch))\s*\}\}/;

function workflowFindings(file: RuleFile): RuleHit[] {
  const out: RuleHit[] = [];
  file.text.split('\n').forEach((line, index) => {
    if (/^\s*permissions\s*:\s*['"]?write-all['"]?\s*(#.*)?$/.test(line)) out.push({ rule: 'IAC-004', line: index + 1 });
  });
  const privileged = PRIVILEGED_TRIGGER.test(file.text);
  let block: number | null = null;
  file.text.split('\n').forEach((line, index) => {
    const indent = line.search(/\S/);
    if (block !== null && indent !== -1 && indent <= block) block = null;
    const key = /^(\s*(?:-\s+)?)(run|script)\s*:\s*(.*)$/.exec(line);
    if (key) {
      const value = key[3] ?? '';
      if (/^[|>][-+]?\s*$/.test(value)) block = (key[1] ?? '').length;
      else if (EVENT_TEXT.test(value)) out.push({ rule: 'SUP-009', line: index + 1 });
      return;
    }
    if (block !== null) {
      if (EVENT_TEXT.test(line)) out.push({ rule: 'SUP-009', line: index + 1 });
      return;
    }
    if (privileged && HEAD_CHECKOUT.test(line)) out.push({ rule: 'SUP-007', line: index + 1 });
    const target = /^\s*(?:-\s+)?uses\s*:\s*['"]?([^'"\s#]+)/.exec(line)?.[1];
    if (target === undefined || target.startsWith('./')) return;
    if (target.startsWith('docker://')) {
      if (!target.includes('@sha256:')) out.push({ rule: 'SUP-008', line: index + 1 });
      return;
    }
    const at = target.lastIndexOf('@');
    const owner = (target.split('/')[0] ?? '').toLowerCase();
    if (owner === 'actions' || owner === 'github') return;
    if (at < 0 || !/^[0-9a-f]{40}$/i.test(target.slice(at + 1))) out.push({ rule: 'SUP-008', line: index + 1 });
  });
  return out;
}

/*
 * Rules that need the whole file: co-occurrence rather than a line on its own.
 * Each returns the line the finding points at, or 0.
 */
export function fileRules(file: RuleFile): RuleHit[] {
  const out: RuleHit[] = [];
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

  /* SEC-032, a to-do that names security work. Comments only: the words in code are not a note. */
  if ((js || py || ['rb', 'php', 'go', 'java', 'kt', 'cs'].includes(file.ext)) && !isTestPath(file.path)) {
    const todo = /(\/\/|#|\/\*|\*|<!--)\s*(TODO|FIXME|HACK|XXX)\b[^\n]{0,120}?\b(auth\w*|authori[sz]\w*|permission\w*|access control|csrf|sanitiz\w*|sanitis\w*|validat\w*|escap\w*|rate[- ]?limit\w*|security|insecure|encrypt\w*|password|secret|admin|owner\w*|verify|signature)\b/i;
    let reported = 0;
    file.text.split('\n').forEach((line, index) => {
      if (reported >= 3 || !todo.test(line)) return;
      const at = line.search(/\/\/|#|\/\*|<!--|^\s*\*/);
      if (at >= 0 && (js || py) && inString(line, at)) return;
      out.push({ rule: 'SEC-032', line: index + 1 });
      reported += 1;
    });
  }

  /* SEC-009, a token decoded in a file that never verifies one. */
  if (js && /\bjwt\.decode\s*\(/.test(text) && !/\b(jwt\.verify|jwtVerify|verifyToken|verify\s*\()/.test(text)) {
    const decode = /\bjwt\.decode\s*\(/.exec(text);
    if (decode) out.push({ rule: 'SEC-009', line: lineOf(text, decode.index), severity: 'warning' });
  }
  return out;
}
