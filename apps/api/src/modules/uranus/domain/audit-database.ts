import { opensWith } from './uranus-lex.ts';
import { read } from '../../../platform/values/fields.ts';
import { fingerprint, keyLine, parseJson, suppression, type Suppression } from './audit-text.ts';
import { JS_EXT, isTestPath } from './audit-files.ts';
import { inCode, type RuleFile, type RuleHit } from './line-rules.ts';

/* One statement of SQL with the line it starts on. */
export interface SqlStatement {
  readonly sql: string;
  readonly line: number;
}
/* What a migration does to a table's row level security, as a digest and a state: never SQL or a table's name. */
export interface SqlEvent {
  readonly key: string;
  readonly public: boolean;
  readonly action: string;
  readonly path: string;
  readonly line: number;
  readonly suppression: Suppression | null;
}
export interface DatabaseFinding {
  readonly rule: string;
  readonly path: string;
  readonly line: number;
  readonly suppression: Suppression | null;
  readonly semantic: string;
}
interface TableState {
  public: boolean;
  created: SqlEvent | null;
  state: SqlEvent | null;
  forced: boolean;
}

/* ---- Database rules ---------------------------------------------------------- */

/*
 * SQL as statements, comments removed, each with the line it starts on.
 * Quoted strings and dollar-quoted bodies (functions, DO blocks) are kept
 * whole, so a semicolon inside one does not split the statement.
 */
export function sqlStatements(text: string): SqlStatement[] {
  const out: SqlStatement[] = [];
  let line = 1;
  let startLine = 1;
  let buffer = '';
  /* Whether the buffer holds anything but whitespace -- asked of every character, so kept, never re-trimmed. */
  let filled = false;
  const skip = (from: number, to: number): void => {
    for (let cursor = from; cursor < to; cursor += 1) if (text[cursor] === '\n') line += 1;
  };
  const flush = () => {
    if (filled) out.push({ sql: buffer.replace(/\s+/g, ' ').trim(), line: startLine });
    buffer = '';
    filled = false;
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (char === '-' && text[index + 1] === '-') {
      const end = text.indexOf('\n', index);
      index = (end === -1 ? text.length : end) - 1;
      continue;
    }
    if (char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2);
      const stop = end === -1 ? text.length : end + 2;
      skip(index, stop);
      index = stop - 1;
      buffer += ' ';
      continue;
    }
    const tag = char === '$' ? /^\$[A-Za-z_]*\$/.exec(text.slice(index, index + 40)) : null;
    if (tag || char === "'") {
      const close = tag ? tag[0] : "'";
      const end = text.indexOf(close, index + close.length);
      const stop = end === -1 ? text.length : end + close.length;
      if (!filled) startLine = line;
      skip(index, stop);
      buffer += tag ? ' $body$ ' : text.slice(index, stop);
      filled = true;
      index = stop - 1;
      continue;
    }
    if (char === '\n') line += 1;
    if (char === ';') { flush(); continue; }
    if (/\S/.test(char)) {
      if (!filled) startLine = line;
      filled = true;
    }
    buffer += char;
  }
  flush();
  return out;
}

const SQL_NAME = '((?:"[^"]+"|[A-Za-z_][\\w$]*)(?:\\s*\\.\\s*(?:"[^"]+"|[A-Za-z_][\\w$]*))?)';
const SQL_CREATE = new RegExp(`^create\\s+(?:unlogged\\s+)?table\\s+(?:if\\s+not\\s+exists\\s+)?${SQL_NAME}`, 'i');
const SQL_RLS = new RegExp(`^alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?${SQL_NAME}\\s+(enable|disable|force|no\\s+force)\\s+row\\s+level\\s+security`, 'i');
const SQL_POLICY = new RegExp(`^create\\s+policy\\s+(?:"[^"]*"|\\S+)\\s+on\\s+${SQL_NAME}(.*)$`, 'i');

function tableName(raw: string): { schema: string | null; name: string } {
  const parts = raw.split('.').map(part => part.trim().replace(/^"|"$/g, '').toLowerCase());
  return parts.length === 2 ? { schema: parts[0] ?? null, name: parts[1] ?? '' } : { schema: null, name: parts[0] ?? '' };
}

/*
 * Row level security across every migration, in the order they apply --
 * migration files are named by timestamp, so path order is apply order. What
 * matters is a table's final state: disabled in one migration and enabled in
 * a later one is fixed; created and never enabled is open.
 */
export function sqlEvents(files: readonly RuleFile[]): SqlEvent[] {
  const events: SqlEvent[] = [];
  for (const file of files.filter(file => file.ext === 'sql' && !isTestPath(file.path))) {
    const lines = file.text.split('\n');
    for (const statement of sqlStatements(file.text)) {
      const create = SQL_CREATE.exec(statement.sql);
      const alter = SQL_RLS.exec(statement.sql);
      const policy = SQL_POLICY.exec(statement.sql);
      let action = create ? 'create' : alter ? (alter[2] ?? '').toLowerCase().replace(/\s+/g, ' ') : null;
      if (policy) {
        const rest = policy[2] ?? '';
        const command = (/\bfor\s+(all|select|insert|update|delete)\b/i.exec(rest)?.[1] ?? 'all').toLowerCase();
        const open = /\b(using|with\s+check)\s*\(\s*\(?\s*true\s*\)?\s*\)/i.test(rest);
        if (open && command !== 'select') action = 'open-policy';
      }
      const named = (create || alter || policy)?.[1];
      if (!action || named === undefined) continue;
      const { schema, name } = tableName(named);
      const rule = action === 'create' ? 'SEC-015' : action === 'disable' ? 'SEC-014' : 'SEC-016';
      /* Only a digest and finite state cross the worker boundary, never SQL or table identifiers. */
      events.push({ key: fingerprint('sql-table', schema || 'public', name), public: !schema || schema === 'public',
        action, path: file.path, line: statement.line, suppression: suppression(lines, statement.line, rule) });
    }
  }
  return events;
}

export function sqlFindings(events: readonly SqlEvent[], supabase: boolean): DatabaseFinding[] {
  const out: DatabaseFinding[] = [];
  const tables = new Map<string, TableState>();
  const finding = (rule: string, event: SqlEvent): DatabaseFinding => ({ rule, path: event.path, line: event.line, suppression: event.suppression,
    semantic: fingerprint('sql-finding', event.key, event.action) });
  for (const event of [...events].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)) {
    const entry = tables.get(event.key) || { public: event.public, created: null, state: null, forced: false };
    if (event.action === 'create' && !entry.created) entry.created = event;
    if (event.action === 'enable' || event.action === 'disable') entry.state = event;
    /* FORCE changes owner bypass; only ENABLE actually turns RLS on. */
    if (event.action === 'force' || event.action === 'no force') entry.forced = event.action === 'force';
    if (event.action === 'open-policy') out.push(finding('SEC-016', event));
    tables.set(event.key, entry);
  }
  for (const entry of tables.values()) {
    if (entry.state && entry.state.action === 'disable') {
      out.push(finding('SEC-014', entry.state));
    } else if (supabase && entry.created && !entry.state && entry.public) {
      out.push(finding('SEC-015', entry.created));
    }
  }
  return out;
}

/*
 * Firebase security rules. A write allowed unconditionally anywhere, or the
 * test-mode rule that allows everything until a date, is an open write. An
 * unconditional read is reported only on the catch-all match, where it
 * publishes the whole database; a public read of one collection is usually
 * the point of that collection.
 */
export function firebaseFindings(file: RuleFile): RuleHit[] {
  const out: RuleHit[] = [];
  if (file.base === 'database.rules.json') {
    const root = read(parseJson(file.text.replace(/^\s*\/\/.*$/gm, '')), 'rules');
    if (root && typeof root === 'object') {
      const write = read(root, '.write');
      const readable = read(root, '.read');
      if (write === true || write === 'true') out.push({ rule: 'SEC-017', line: keyLine(file.text, '.write') });
      if (readable === true || readable === 'true') out.push({ rule: 'SEC-018', line: keyLine(file.text, '.read') });
    }
    return out;
  }
  const stack: { path: string; depth: number }[] = [];
  let depth = 0;
  file.text.split('\n').forEach((raw, index) => {
    const line = raw.replace(/\/\/.*$/, '');
    const match = /\bmatch\s+(\S+)\s*\{/.exec(line);
    if (match) stack.push({ path: match[1] ?? '', depth: depth + 1 });
    const allow = /\ballow\s+([a-z,\s]+?)\s*(?::\s*if\s+(.+?))?\s*;/i.exec(line);
    if (allow) {
      const operations = (allow[1] ?? '').split(',').map(part => part.trim().toLowerCase()).filter(Boolean);
      const condition = (allow[2] || 'true').trim();
      const always = /^true$/i.test(condition) || /^request\.time\s*<\s*timestamp\.date\s*\(/i.test(condition);
      const writes = operations.some(operation => ['write', 'create', 'update', 'delete'].includes(operation));
      const reads = operations.some(operation => ['read', 'get', 'list'].includes(operation));
      const innermost = stack[stack.length - 1];
      const catchAll = innermost !== undefined && /\{\w+=\*\*\}/.test(innermost.path) &&
        stack.slice(0, -1).every(level => /\{(database|bucket)\}|\/documents$|\/o$/.test(level.path));
      if (always && writes) out.push({ rule: 'SEC-017', line: index + 1 });
      else if (always && reads && catchAll) out.push({ rule: 'SEC-018', line: index + 1 });
    }
    /* A match path's own wildcards are braces too; only the block's brace opens a level. */
    const structural = match ? `${line.slice(0, match.index)}{${line.slice(match.index + match[0].length)}` : line;
    for (const char of structural) {
      if (char === '{') depth += 1;
      if (char === '}') {
        if (stack[stack.length - 1]?.depth === depth) stack.pop();
        depth -= 1;
      }
    }
  });
  return out;
}

/*
 * Code that runs in the browser: a file that declares itself client code, a
 * single-file component of a front-end framework, or anything served as-is
 * from a public folder -- and not a server route that shares its folder.
 */
export function clientFile(file: RuleFile): boolean {
  if (isTestPath(file.path) || !JS_EXT.has(file.ext)) return false;
  if (/(^|\/)(api|server|functions|pages\/api)\//.test(file.path) || /\.server\.|(^|\/)\+server\./.test(file.path)) return false;
  if (opensWith(file.text, 'use client')) return true;
  if (/(^|\/)(public|static)\//.test(file.path)) return true;
  return ['vue', 'svelte'].includes(file.ext);
}

export function serviceRoleFindings(file: RuleFile): RuleHit[] {
  if (!clientFile(file)) return [];
  const lines = file.text.split('\n');
  const index = lines.findIndex(line => inCode(/\b[A-Za-z0-9_]*SERVICE_ROLE[A-Za-z0-9_]*\b|\bserviceRoleKey\b/, line));
  return index < 0 ? [] : [{ rule: 'SEC-019', line: index + 1 }];
}
