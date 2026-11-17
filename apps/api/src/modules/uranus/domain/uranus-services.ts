/*
 * Uranus: the functions of a repository by name, read as the surface reads a
 * handler.
 *
 * A guarded endpoint that hands a caller's id to a service -- `invoices.byId(
 * req.params.id)` -- fetches the record there, not in the handler. Read by
 * itself the handler holds no lookup, so whether the record is tied to the
 * caller is decided in the service's body. This index lets the surface read
 * that body: each function, method and exported arrow of a JavaScript,
 * TypeScript or Python file, under its own name, as the same text the flow
 * engine gives a route's body (tokens joined by spaces; a Python body one
 * logical line per line).
 *
 * A name defined more than once is ambiguous, and the index says so rather
 * than guess which definition a call reaches.
 */
import { lexJs, lexPython } from './uranus-lex.ts';
import type { Token } from './uranus-lex.ts';
import { jsFunctions, pyFunctions } from './uranus-shape.ts';
import type { FileShape } from './uranus-shape.ts';
import type { SourceFile } from './uranus-reach.ts';

const JS_FILE = /\.(m?js|cjs|jsx|ts|tsx|mts|cts)$/;
const PY_FILE = /\.py$/;
const TEST_FILE = /(^|\/)(test|tests|__tests__|spec|e2e|fixtures?)\/|\.(test|spec)\.[a-z]+$|(^|\/)test_[^/]*\.py$|_test\.py$/;
/* Past this, a file is generated or vendored, not a service someone wrote. */
const MAX_FILE_BYTES = 400_000;
/* A name that could be defined in more files than this is too common to resolve to one definition. */
const MAX_CANDIDATES = 12;

export interface ServiceBody {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

/* Every definition of a name, read on first ask; one entry means the name is unambiguous. */
export type ServiceIndex = (name: string) => readonly ServiceBody[];

const tokenText = (token: Token): string => (token.t === 'tpl' ? token.parts.join(' ') : token.v);

function shape(): FileShape<null> {
  return { imports: new Map(), exportsMap: new Map(), functions: new Map(), aliases: new Map() };
}

/* Every function of one file, under the member name a call would use. */
function definitions(file: SourceFile & { readonly text: string }): Map<string, ServiceBody[]> {
  const found = new Map<string, ServiceBody[]>();
  const add = (name: string, body: ServiceBody): void => {
    /* `Users.find` and `users.find` are both called `find`: a call names the member, not its holder. */
    const member = name.slice(name.lastIndexOf('.') + 1);
    if (!member || member === 'constructor') return;
    const known = found.get(member);
    if (known) known.push(body); else found.set(member, [body]);
  };
  try {
    if (JS_FILE.test(file.path)) {
      const tokens = lexJs(file.text);
      const read = shape();
      jsFunctions(tokens, read);
      for (const [name, entry] of read.functions) {
        if ('fn' in entry) add(name, { path: file.path, line: entry.fn.line, text: tokens.slice(entry.fn.bodyStart, entry.fn.bodyEnd).map(tokenText).join(' ') });
      }
    } else if (PY_FILE.test(file.path)) {
      const lines = lexPython(file.text);
      const read = shape();
      pyFunctions(lines, read);
      for (const [name, entry] of read.functions) {
        if (!('py' in entry)) continue;
        let end = entry.lineIndex + 1;
        while (end < lines.length && (lines[end]?.indent ?? 0) > entry.indent) end += 1;
        add(name, { path: file.path, line: entry.line, text: lines.slice(entry.lineIndex, end).map(line => line.tokens.map(tokenText).join(' ')).join('\n') });
      }
    }
  } catch {
    /* A file the lexers cannot read holds no service this index can vouch for. */
  }
  return found;
}

/* What a name too common to resolve answers: two definitions, so no caller takes it for one. */
const AMBIGUOUS: readonly ServiceBody[] = Object.freeze([{ path: '', line: 0, text: '' }, { path: '', line: 0, text: '' }]);

/*
 * Only a file whose text holds the name is read, and each file once: most
 * handlers name no service, and an audit should not lex the repository
 * again to learn that.
 */
export function serviceIndex(files: readonly SourceFile[]): ServiceIndex {
  const readable = files.filter((file): file is SourceFile & { readonly text: string } =>
    typeof file.text === 'string' && file.text.length <= MAX_FILE_BYTES && (JS_FILE.test(file.path) || PY_FILE.test(file.path)) && !TEST_FILE.test(file.path));
  const read = new Map<string, Map<string, ServiceBody[]>>();
  const asked = new Map<string, readonly ServiceBody[]>();
  return name => {
    const known = asked.get(name);
    if (known) return known;
    const bodies: ServiceBody[] = [];
    /* Where the name could be defined -- `name(`, `name =`, `exports.name =`, `def name`; not `.name(`, which only calls it. */
    const word = name.replace(/\$/g, '\\$');
    const definedHere = new RegExp(`(?:^|[^.\\w$])${word}\\s*[=:(]|\\.${word}\\s*=(?!=)|\\bdef\\s+${word}\\b`, 'm');
    const candidates = readable.filter(file => file.text.includes(name) && definedHere.test(file.text));
    if (candidates.length > MAX_CANDIDATES) { asked.set(name, AMBIGUOUS); return AMBIGUOUS; }
    for (const file of candidates) {
      let defined = read.get(file.path);
      if (!defined) { defined = definitions(file); read.set(file.path, defined); }
      bodies.push(...(defined.get(name) ?? []));
    }
    asked.set(name, bodies);
    return bodies;
  };
}
