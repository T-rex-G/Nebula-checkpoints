/*
 * What a page's markup asks the browser to load, send and follow, read from
 * markup the check already has: the resources and forms that leave HTTPS or
 * load another origin's script unchecked, the links a visitor could follow,
 * the scripts the page loads and the libraries they name; and the paths
 * robots.txt asks a crawler to leave alone.
 */
import { parse as parseHtml, type DefaultTreeAdapterMap } from 'parse5';
import { displayPath } from './site-address.ts';
import { CDN_NAMES, LIBRARY_BANNERS, VERSION } from './site-rules.ts';
import type { RawFinding } from './site-headers.ts';

type MarkupNode = DefaultTreeAdapterMap['node'];
export interface MarkupElement {
  readonly tag: string;
  readonly attrs: Readonly<Record<string, string>>;
}

/* Every element of a page in document order, and the base its relative addresses resolve against. */
export function documentElements(html: unknown, fallbackBase: string): { readonly elements: readonly MarkupElement[]; readonly base: string } {
  const elements: MarkupElement[] = [];
  const pending: MarkupNode[] = [parseHtml(String(html || ''))];
  for (let node = pending.pop(); node; node = pending.pop()) {
    if ('tagName' in node && node.tagName) elements.push({ tag: node.tagName, attrs: Object.fromEntries((node.attrs || []).map(attr => [attr.name, attr.value])) });
    const children = 'childNodes' in node ? node.childNodes || [] : [];
    for (let i = children.length - 1; i >= 0; i -= 1) {
      const child = children[i];
      if (child) pending.push(child);
    }
  }
  let base = fallbackBase;
  const declared = elements.find(element => element.tag === 'base' && element.attrs.href !== undefined);
  if (declared) { try { base = new URL(declared.attrs.href ?? '', fallbackBase).href; } catch { /* use document URL */ } }
  return { elements, base };
}

/*
 * A script, frame, stylesheet or asset over plain HTTP; a script from another
 * origin with no integrity hash; a form that posts over plain HTTP. Only the
 * first of each kind is named, by its host, never its full address.
 */
export function markupFindings(body: unknown, origin: string, documentUrl = origin): RawFinding[] {
  const out: RawFinding[] = [];
  const { elements, base } = documentElements(body, documentUrl);
  let insecure: string | null = null;
  let unsigned: string | null = null;
  let form: string | null = null;
  for (const { tag, attrs } of elements) {
    if (tag === 'form' && attrs.action) {
      try { const action = new URL(attrs.action, base); if (action.protocol === 'http:' && !form) form = action.host; } catch { /* invalid URL */ }
    }
    if (!['script', 'iframe', 'link', 'img', 'source', 'video', 'audio'].includes(tag)) continue;
    if (tag === 'link' && !/\b(stylesheet|preload|modulepreload|icon)\b/i.test(attrs.rel || '')) continue;
    const src = attrs[tag === 'link' ? 'href' : 'src'];
    if (!src) continue;
    try {
      const target = new URL(src, base);
      if (target.protocol === 'http:' && !insecure) insecure = target.host;
      if (tag === 'script' && /^https?:$/.test(target.protocol) && target.origin !== origin && !/^sha(?:256|384|512)-/i.test(attrs.integrity || '') && !unsigned) unsigned = target.host;
    } catch { /* invalid URL */ }
  }
  if (insecure) out.push({ rule: 'WEB-018', where: `http://${insecure}` });
  if (unsigned) out.push({ rule: 'WEB-019', where: `<script src> from ${unsigned}` });
  if (form) out.push({ rule: 'WEB-033', where: `<form action> to http://${form}` });
  return out;
}

export interface Library {
  readonly name: string;
  readonly version: string;
  readonly source: 'banner' | 'address';
}

/* A library and version, from a script's own banner or the address a CDN serves it from. */
export function librariesInText(text: unknown): Library[] {
  const found: Library[] = [];
  const head = String(text || '').slice(0, 64 * 1024);
  for (const [name, pattern] of LIBRARY_BANNERS) {
    const match = pattern.exec(head);
    const version = match && match.slice(1).find(Boolean);
    if (version && VERSION.test(version)) found.push({ name, version, source: 'banner' });
  }
  return found;
}
/* A CDN's name for a library, by its own entry only: a name read from an address may be any text. */
const cdnName = (name: string | undefined): string | undefined => (name === undefined ? undefined : CDN_NAMES[name.toLowerCase()]);
export function libraryFromAddress(address: unknown): Library | null {
  let parsed: URL;
  try { parsed = new URL(String(address)); } catch { return null; }
  let path: string;
  try { path = decodeURIComponent(parsed.pathname); } catch { return null; }
  let match = /\/ajax\/libs\/([\w.-]+)\/(\d+\.\d+\.\d+)\//.exec(path);
  let name = match ? cdnName(match[1]) : undefined;
  if (match && name && match[2]) return { name, version: match[2], source: 'address' };
  match = /\/npm\/((?:@[\w.-]+\/)?[\w.-]+)@(\d+\.\d+\.\d+)(?:\/|$)/.exec(path) || /^\/((?:@[\w.-]+\/)?[\w.-]+)@(\d+\.\d+\.\d+)(?:\/|$)/.exec(path);
  name = match ? cdnName(match[1]) : undefined;
  if (match && name && match[2]) return { name, version: match[2], source: 'address' };
  match = /\/(jquery|jquery-ui|jquery-migrate|bootstrap|angular|moment|handlebars|underscore|lodash|vue|knockout)[.-](\d+\.\d+\.\d+)(?:\.min|\.slim|\.slim\.min)?\.js$/i.exec(path);
  name = match ? cdnName(match[1]) : undefined;
  if (match && name && match[2]) return { name, version: match[2], source: 'address' };
  /* WordPress names the version it serves in the query: /wp-includes/js/jquery/jquery.min.js?ver=3.6.0. */
  match = /\/(jquery|jquery-migrate|underscore|moment|lodash)(?:\.min)?\.js$/i.exec(path);
  const declared = parsed.searchParams.get('ver');
  name = match ? cdnName(match[1]) : undefined;
  if (match && name && declared && /^\d+\.\d+\.\d+$/.test(declared)) return { name, version: declared, source: 'address' };
  return null;
}

/* The links a visitor could follow from a page, on this origin, most telling first. */
const CRAWL_PRIORITY = /\b(?:log-?in|sign-?in|sign-?up|register|account|auth|admin|dashboard|settings|profile|checkout|pricing|contact|api|docs)\b/i;
const CRAWL_SKIP = /\.(?:png|jpe?g|gif|svg|webp|ico|pdf|zip|gz|tgz|mp4|mp3|webm|woff2?|ttf|css|js|json|xml|txt|map)$/i;
const CRAWL_NEVER = /\b(?:log-?out|sign-?out|delete|remove|unsubscribe|cancel|destroy)\b/i;
export function pageLinks(html: unknown, base: string, origin: string, disallowed: readonly string[]): string[] {
  const out = new Map<string, number>();
  const document = documentElements(html, base);
  for (const { tag, attrs } of document.elements) {
    if (tag !== 'a' || !attrs.href || attrs.href.startsWith('#')) continue;
    const href = attrs.href;
    let target: URL;
    try { target = new URL(href, document.base); } catch { continue; }
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
export function robotsDisallowed(text: unknown): string[] {
  const groups: { agents: string[]; paths: string[] }[] = [];
  let group: { agents: string[]; paths: string[] } = { agents: [], paths: [] };
  let rulesStarted = false;
  for (const raw of String(text || '').split(/\r?\n/).slice(0, 400)) {
    const field = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(raw.replace(/#.*/, '').trim());
    if (!field || field[1] === undefined || field[2] === undefined) continue;
    const name = field[1].toLowerCase();
    const value = field[2].trim();
    if (name === 'user-agent') {
      if (rulesStarted) { groups.push(group); group = { agents: [], paths: [] }; rulesStarted = false; }
      group.agents.push(value.toLowerCase());
    } else if (group.agents.length) {
      rulesStarted = true;
      if (name === 'disallow' && value.startsWith('/')) group.paths.push(value.replace(/\*.*$/, ''));
    }
  }
  groups.push(group);
  // A shared group applies to every named agent. Preserve conservative prefix
  // exclusions; Allow exceptions are intentionally not used to expand this scan.
  const specific = groups.filter(item => item.agents.some(agent => agent !== '*' && agent && 'nebulaverse-x-sitecheck'.includes(agent)));
  const selected = specific.length ? specific : groups.filter(item => item.agents.includes('*'));
  return [...new Set(selected.flatMap(item => item.paths))].slice(0, 200);
}

/* The addresses of the scripts a page loads, each once read as an address; a malformed one is counted, not followed. */
export function scriptSources(html: unknown, base: string, onInvalid: () => void = () => {}): string[] {
  const out: string[] = [];
  const document = documentElements(html, base);
  for (const { tag, attrs } of document.elements) {
    if (tag !== 'script' || !attrs.src) continue;
    try {
      const target = new URL(attrs.src, document.base);
      decodeURIComponent(target.pathname);
      target.hash = '';
      out.push(target.href);
    } catch { onInvalid(); }
  }
  return out;
}
