/*
 * What each kind of sanitiser guarantees, for both flow engines.
 *
 * A sanitiser makes a value safe for a context, not for every context: a URL
 * component still carries the quote that ends a SQL string, escaped HTML is
 * still a shell command, a file's bare name is still markup. A contract
 * names the sinks a sanitised value is cleared for; every other sink still
 * counts it as the caller's.
 */

import type { Language, Step } from './uranus-cfamily.ts';

/* Every sink either engine reports. */
export type SanitisedSink = 'sql' | 'command' | 'code' | 'ssrf' | 'path' | 'redirect' | 'dom' | 'html' | 'template' | 'regex' | 'nosql' | 'merge' | 'mass' | 'deserialize' | 'xxe' | 'prompt';

const ALL_SINKS: readonly SanitisedSink[] = ['sql', 'command', 'code', 'ssrf', 'path', 'redirect', 'dom', 'html', 'template', 'regex', 'nosql', 'merge', 'mass', 'deserialize', 'xxe', 'prompt'];
/* A contract is written as what the sanitiser leaves dangerous; it clears the rest. */
const clearedExcept = (...dangerous: SanitisedSink[]): ReadonlySet<SanitisedSink> => new Set(ALL_SINKS.filter(kind => !dangerous.includes(kind)));
export const CONTRACTS = Object.freeze({
  /* Percent-encoding: no markup, no path separator, no scheme -- but quotes, parentheses and `*` survive. */
  urlComponent: clearedExcept('sql', 'command', 'code', 'regex'),
  /* Entity-escaping or markup cleaning: safe to show, nothing else. */
  html: clearedExcept('sql', 'command', 'code', 'path', 'ssrf', 'redirect', 'regex', 'template', 'deserialize'),
  /* A bare file name: no directory, and nothing else promised. */
  fileName: clearedExcept('sql', 'command', 'code', 'html', 'dom', 'regex', 'template'),
  /* A path held inside a directory. */
  path: clearedExcept('sql', 'command', 'code', 'html', 'dom', 'regex', 'template', 'ssrf', 'redirect'),
  shell: clearedExcept('sql', 'code', 'html', 'dom', 'path', 'ssrf', 'redirect', 'regex', 'template', 'deserialize'),
  sql: clearedExcept('command', 'code', 'html', 'dom', 'path', 'ssrf', 'redirect', 'regex', 'template', 'deserialize'),
  regex: clearedExcept('sql', 'command', 'code', 'html', 'dom', 'path', 'ssrf', 'redirect', 'template', 'deserialize'),
  quote: clearedExcept('sql', 'code', 'regex'),
  /* A destination checked: where a request or a redirect may go, nothing about what the text may break. */
  url: clearedExcept('sql', 'command', 'code', 'html', 'dom', 'path', 'regex', 'template', 'deserialize')
});
export type Contract = ReadonlySet<SanitisedSink>;
/* What a name, the object it is called on, or the module it came from says a sanitiser is for. */
export function contextOf(text: string): Contract | null {
  if (/html|xss|dom|purif|markup|xml|entit|bleach/i.test(text)) return CONTRACTS.html;
  if (/sql|mysql|postgres|sqlite|ident|literal/i.test(text)) return CONTRACTS.sql;
  if (/shell|shlex|cmd|command/i.test(text)) return CONTRACTS.shell;
  if (/regex|regexp/i.test(text)) return CONTRACTS.regex;
  if (/filename|basename/i.test(text)) return CONTRACTS.fileName;
  if (/path|file|dir|folder|inside|within|join/i.test(text)) return CONTRACTS.path;
  if (/url|uri|host|origin|redirect|link|domain|public|https/i.test(text)) return CONTRACTS.url;
  return null;
}
export function bothCleared(a: Contract | null, b: Contract | null): Contract | null {
  if (!a || !b) return null;
  const both = new Set([...a].filter(kind => b.has(kind)));
  return both.size ? both : null;
}

/* ---- JavaScript and Python ------------------------------------------------------- */

/*
 * Sanitisers, by what each one guarantees.
 *
 * A sanitiser makes a value safe for a context, not for every context: a URL
 * component still carries the quote that ends a SQL string, escaped HTML is
 * still a shell command, a file's bare name is still markup. A name that
 * says "sanitise", "clean" or "validate" guarantees nothing by itself.
 * So a call is read one of four ways:
 *
 *  - its result is safe whatever went in -- a number, a boolean, a hash, a
 *    count, a verdict, a schema's parsed output: the value ends there;
 *  - it encodes or checks for one context (by what it is, or by what its name
 *    or its library says it is for): the value goes on, cleared for the
 *    sinks that context covers and for no others;
 *  - it only claims to sanitise, and this repository defines it: its body is
 *    read like any helper's, and what it returns is as safe as the body made
 *    it -- a flow through it is a lead to confirm, not a certainty;
 *  - it only claims to sanitise and its body cannot be read: it is taken at
 *    its word, as before.
 */
const SAFE_RESULT = /^(parseInt|parseFloat|Number|Boolean|BigInt|isNaN|isFinite|isValid\w*|hash\w*|digest|createHash|compare\w*|bcrypt\w*|argon2\w*|uuid\w*|randomUUID|safeParse|parseAsync|safeParseAsync|toNumber|toInteger|toInt|int|float|bool|slugify|test|includes|startsWith|endsWith|indexOf|lastIndexOf|has|some|every|count\w*|exists|size|toFixed|len|isdigit|isnumeric|isalnum|abs|round|floor|ceil|max|min|typeof|format_number|UUID|uuid4|urlsafe_b64encode)$/;
/* Names that claim to sanitise, check or make safe. */
const CLAIMS_SAFE = /^(escape\w*|htmlEscape|sanitiz\w*|sanitis\w*|purify|clean\w*|validate\w*|verify\w*|assertPublic\w*|assertSafe\w*|assertAllowed\w*|assertTrusted\w*|assertHttps\w*|requireHttps\w*|requireSafe\w*|ensureSafe\w*|toSafe\w*|safeUrl|safePath|safeJoin|safe_join|normali[sz]eSafe\w*|resolveInside|within\w*|quote|quote_plus|urlencode|encodeURIComponent|basename|extname|secure_filename|mark_safe_escape)$/;
const SQL_OBJECT = /^(mysql|mysql2|connection|conn|pool|db|client|pg|knex|sequelize|sqlstring|SqlString)$/;
export type Sanitising =
  | { readonly safe: true }
  | { readonly contract: Contract }
  | { readonly claims: true };
/* How a call sanitises, if it does: `joined` is the whole dotted callee, `module` where its root was imported from. */
export const SAFE: Sanitising = Object.freeze({ safe: true });
export function sanitising(name: string, objectName: string, module: string, joined: string): Sanitising | null {
  if (SAFE_RESULT.test(name)) return SAFE;
  if (joined === 're.escape' || name === 'escapeRegExp' || name === 'escapeRegex') return { contract: CONTRACTS.regex };
  if (joined === 'shlex.quote') return { contract: CONTRACTS.shell };
  if (joined === 'html.escape' || joined === 'bleach.clean' || name === 'htmlEscape') return { contract: CONTRACTS.html };
  if (name === 'encodeURIComponent' || name === 'quote_plus' || name === 'urlencode') return { contract: CONTRACTS.urlComponent };
  if (name === 'basename' || name === 'extname' || name === 'secure_filename') return { contract: CONTRACTS.fileName };
  if (!CLAIMS_SAFE.test(name)) return null;
  if (/^escape_?string$/i.test(name)) return { contract: CONTRACTS.sql };
  if (name === 'escape' || name === 'quote') {
    if (SQL_OBJECT.test(objectName)) return { contract: CONTRACTS.sql };
    const told = contextOf(`${objectName} ${module}`);
    if (told) return { contract: told };
    /* A quote nothing places is urllib's or shlex's, safe for either's context; an escape nothing places is an HTML escape, as lodash's, markupsafe's and escape-html's are. */
    return { contract: name === 'quote' ? CONTRACTS.quote : CONTRACTS.html };
  }
  const told = contextOf(name) || contextOf(`${objectName} ${module}`);
  if (told) return { contract: told };
  return { claims: true };
}
/* What both engines' values share, as far as sanitising goes. */
interface Sanitisable {
  steps: Step[];
  cleared?: Contract | null;
  whole: boolean;
}
/*
 * A value a sanitiser returned: still the caller's, now safe for the sinks
 * the contract covers as well as any it already was. Said in the trace even
 * where the value entered on this same line: a reader must see that it was
 * sanitised, and that it was not enough.
 */
export function sanitised<V extends Sanitisable>(value: V, contract: Contract, path: string, line: number, note: string, limit: number): V {
  const steps: Step[] = [...value.steps, { path, line, role: 'propagation', note }];
  return { ...value, steps: steps.slice(0, limit), cleared: value.cleared ? new Set([...value.cleared, ...contract]) : contract, whole: false };
}
/* How safe a summarised function left a parameter it returns. */
export interface Returned<G> { cleared: Contract | null; guarded: G | null }
/* A summarised function returns one of its parameters: remember how safe every return left it. */
export function noteReturn<G>(summary: { readonly returns: Set<number>; readonly returned: Map<number, Returned<G>> } | null | undefined, value: { param: number | null; cleared: Contract | null; guarded: G | null } | null): void {
  if (!summary || !value || value.param === null) return;
  const before = summary.returned.get(value.param);
  summary.returns.add(value.param);
  summary.returned.set(value.param, before
    ? { cleared: bothCleared(before.cleared, value.cleared), guarded: before.guarded && value.guarded }
    : { cleared: value.cleared, guarded: value.guarded });
}
/* What a call to a summarised function returns to its caller: the argument, as safe as the function's body left it; one that only claims to sanitise leaves a check to be confirmed. */
export function returnedThrough<G, V extends { cleared: Contract | null; guarded: G | null }>(value: V, left: Returned<G> | undefined, claimed: G | null): V {
  const cleared = left && left.cleared ? new Set([...(value.cleared || []), ...left.cleared]) : value.cleared;
  return { ...value, cleared, guarded: value.guarded || (left && left.guarded) || claimed };
}
/*
 * `x.replace(/[^A-Za-z0-9_-]/g, '')`: every match of a class that keeps only
 * letters, digits, underscore and hyphen, replaced by nothing a sink can
 * misread. What is left carries nothing of the caller's that matters.
 */
export function isAllowListReplace(name: string, args: readonly (readonly { readonly t: string; readonly v: string; readonly src?: string }[])[]): boolean {
  if ((name !== 'replace' && name !== 'replaceAll') || args.length !== 2) return false;
  const pattern = args[0]?.length === 1 ? args[0][0] : undefined;
  const filler = args[1]?.length === 1 ? args[1][0] : undefined;
  if (!pattern || pattern.t !== 're' || !filler || filler.t !== 'str' || !/^[A-Za-z0-9_-]*$/.test(filler.v)) return false;
  const source = pattern.src || '';
  return /^\/\[\^((?:A-Z|a-z|0-9|\\w|\\d|[A-Za-z0-9_]|\\-|-)+)\]\+?\/[gimsuy]*$/.test(source) && /g/.test(source.slice(source.lastIndexOf('/')));
}

/* ---- Go, Java and PHP ----------------------------------------------------------- */

/* Calls whose result no longer carries what the caller wrote in a dangerous form. */
export const SANITISERS: Readonly<Record<Language, RegExp>> = Object.freeze(Object.assign(Object.create(null), {
  go: /^(Atoi|ParseInt|ParseUint|ParseFloat|ParseBool|Itoa|FormatInt|Base|EscapeString|QueryEscape|PathEscape|HTMLEscapeString|JSEscapeString|Parse|ParseUUID|MustParse|len|cap|int|int8|int16|int32|int64|uint|uint8|uint16|uint32|uint64|float32|float64|bool|Contains|HasPrefix|HasSuffix|EqualFold|Compare|Index|Count|Match|MatchString|IsAbs|Hash|Sum256|Sum|Equal|ConstantTimeCompare|NewString|Sprint\w*Int)$/,
  java: /^(parseInt|parseLong|parseDouble|parseFloat|parseBoolean|valueOf|fromString|escapeHtml\w*|escapeXml\w*|escapeEcmaScript|escapeJava|htmlEscape\w*|encodeForHTML\w*|encodeForSQL|encodeForURL|encodeForOS|encode|getName|normalize|isValid\w*|matches|equals\w*|contains|startsWith|endsWith|length|size|isEmpty|hashCode|sanitize\w*|clean|toInt|toLong|UUID|compare\w*)$/,
  php: /^(intval|floatval|boolval|abs|round|ceil|floor|count|strlen|mb_strlen|is_numeric|is_int|ctype_digit|ctype_alnum|ctype_alpha|htmlspecialchars|htmlentities|strip_tags|e|esc_html|esc_attr|esc_url|esc_sql|sanitize_\w+|filter_var|filter_input|escapeshellarg|escapeshellcmd|basename|realpath|urlencode|rawurlencode|addslashes|mysqli_real_escape_string|real_escape_string|quote|pg_escape_string|pg_escape_literal|password_hash|hash|md5|sha1|crc32|in_array|array_key_exists|isset|empty|preg_match|str_contains|str_starts_with|uniqid|json_encode|number_format|date|strtotime|checkdate|max|min)$/
}));

/*
 * The calls of each language that make a value safe for one context only.
 * The value goes on, cleared for the sinks its contract covers.
 */
const CONTEXT_SANITISERS: Readonly<Record<Language, readonly (readonly [RegExp, Contract])[]>> = Object.freeze(Object.assign(Object.create(null), {
  go: [
    [/^(EscapeString|HTMLEscapeString|JSEscapeString)$/, CONTRACTS.html],
    [/^(QueryEscape|PathEscape)$/, CONTRACTS.urlComponent],
    [/^Base$/, CONTRACTS.fileName]
  ],
  java: [
    [/^(escapeHtml\w*|escapeXml\w*|escapeEcmaScript|escapeJava|htmlEscape\w*|encodeForHTML\w*|clean)$/, CONTRACTS.html],
    [/^encodeForSQL$/, CONTRACTS.sql],
    [/^encodeForURL$/, CONTRACTS.urlComponent],
    [/^encodeForOS$/, CONTRACTS.shell]
  ],
  php: [
    [/^(htmlspecialchars|htmlentities|strip_tags|e|esc_html|esc_attr|sanitize_(text_field|textarea_field|email|user|url|option|meta|term_field|post_field|comment_cookies))$/, CONTRACTS.html],
    [/^(esc_sql|addslashes|mysqli_real_escape_string|real_escape_string|quote|pg_escape_string|pg_escape_literal)$/, CONTRACTS.sql],
    [/^(escapeshellarg|escapeshellcmd)$/, CONTRACTS.shell],
    [/^(basename|sanitize_file_name)$/, CONTRACTS.fileName],
    [/^(urlencode|rawurlencode)$/, CONTRACTS.urlComponent],
    [/^esc_url(_raw)?$/, CONTRACTS.url]
  ]
}));
/* The contract of a context sanitiser, by its name -- and, for a name that only says "sanitise" or "encode", by what it is called on. */
export function contractOf(language: Language, name: string, segments: readonly string[]): Contract | null {
  for (const [pattern, contract] of CONTEXT_SANITISERS[language]) if (pattern.test(name)) return contract;
  if (language === 'java' && name === 'encode' && segments.includes('URLEncoder')) return CONTRACTS.urlComponent;
  if (language === 'java' && /^sanitize\w*$/.test(name)) return contextOf(segments.join(' '));
  return null;
}
