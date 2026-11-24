/*
 * Uranus: where a JavaScript or TypeScript file says its endpoints are,
 * found before the flow engine (uranus-flow.ts) walks it -- routes registered
 * on a router (Express, Fastify, Koa, Hono, Elysia), handlers named at a route
 * and written elsewhere, file-based routes (Next.js, SvelteKit, Remix,
 * Supabase edge functions, Lambda) and server actions. Each is recorded on
 * the file's context with a hint the walk reads when it reaches the handler.
 */
import { matching, opensWith, splitArgs } from './uranus-lex.ts';
import { at, functionAt, isPunc, isStr, isWord, lastOf, type Tokens } from './uranus-shape.ts';
import type { FileContext, FlowRoute, Hint, HintKind } from './uranus-flow.ts';
import type { RouteUse } from './uranus-surface.ts';

const ROUTER_OBJECT = /^(app|router|api|server|r|route|routes|fastify|instance|v1|v2|admin\w*|\w*[Rr]outer|\w*[Aa]pp|hono|elysia|srv)$/;
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'del', 'all', 'options', 'head']);
const ROUTE_TEXT = /^[A-Za-z0-9/_:.\-*[\]{}()$+?@~<>]*$/; /* `<` and `>` are Flask's and Django's converters */

export function safeRoute(value: unknown): string | null {
  const text = String(value || '').trim();
  if (!text.startsWith('/') || text.length > 120 || !ROUTE_TEXT.test(text)) return null;
  return text;
}

/*
 * Express-style registrations -- app.post('/x', mw, handler), router.route('/x').get(h),
 * fastify.get('/x', opts, h), app.get('/x', c => ...) in Hono -- and the
 * handler functions they name, found once so the walker knows which
 * parameter is the request when it reaches each handler.
 */
export function jsRoutes(tokens: Tokens, ctx: FileContext): void {
  const hints = new Map<number, Hint>();
  const named = new Map<string, Hint>();
  /* The router's own name for the endpoint list; they all register the same way. */
  const framework = /['"]hono(\/[\w-]+)?['"]/.test(ctx.text) ? 'hono'
    : /['"](koa|koa-router|@koa\/router)['"]/.test(ctx.text) ? 'koa'
      : /['"]fastify['"]/.test(ctx.text) ? 'fastify' : 'express';
  for (let index = 0; index < tokens.length; index += 1) {
    const token = at(tokens, index);
    if (token.t !== 'id' || !isPunc(tokens[index + 1], '.')) continue;
    if (isPunc(tokens[index - 1], '.')) continue;
    const object = token.v;
    let cursor = index + 2;
    let path: string | null = null;
    /* router.route('/x').get(...) */
    const mounted = tokens[cursor + 2];
    if (tokens[cursor]?.v === 'route' && isPunc(tokens[cursor + 1], '(') && isStr(mounted)) {
      path = mounted.v;
      cursor = matching(tokens, cursor + 1) + 1;
      if (!isPunc(tokens[cursor], '.')) continue;
      cursor += 1;
    }
    const method = tokens[cursor];
    if (!method || !HTTP_METHODS.has(String(method.v)) || !isPunc(tokens[cursor + 1], '(')) continue;
    if (!ROUTER_OBJECT.test(object) && !path) continue;
    const { args, close } = splitArgs(tokens, cursor + 1);
    if (!args.length) continue;
    let handlerArgs = args;
    if (!path) {
      const opening = args[0]?.[0];
      if (!opening || !(isStr(opening) || (opening.t === 'tpl' && opening.exprs.length === 0))) continue;
      path = opening.t === 'tpl' ? opening.parts.join('') : opening.v;
      handlerArgs = args.slice(1);
    }
    const route = safeRoute(path);
    if (!route) continue;
    const entry: FlowRoute = {
      method: method.v === 'del' ? 'DELETE' : method.v === 'all' ? 'ANY' : method.v.toUpperCase(),
      route, path: ctx.path, line: token.line, framework, middleware: [], bodyStart: null, bodyEnd: null
    };
    const hint: Hint = { kind: 'route', route: entry };
    handlerArgs.forEach((arg, position) => {
      const opening = arg[0];
      const closing = arg[arg.length - 1];
      if (!opening || !closing) return;
      const place = tokens.indexOf(opening, cursor + 1);
      const fn = place >= 0 ? functionAt(tokens, place, close) : null;
      if (fn) {
        if (position === handlerArgs.length - 1) hints.set(fn.start, hint);
        else hints.set(fn.start, { kind: 'route', route: null });
        return;
      }
      /* A named handler or middleware: auth, requireUser, controller.create. */
      const words = arg.filter(t => t.t === 'id').map(t => t.v);
      if (position < handlerArgs.length - 1) entry.middleware.push(...words);
      else if (words.length) {
        named.set(lastOf(words), hint);
        entry.handlerName = lastOf(words);
        if (words.length > 1) entry.middleware.push(...words.slice(0, -1));
      }
      /* A wrapped handler: withAuth(async (req, res) => ...) */
      for (let inner = place; inner >= 0 && inner < tokens.indexOf(closing, place); inner += 1) {
        const nested = functionAt(tokens, inner, close);
        if (nested) { hints.set(nested.start, hint); entry.middleware.push(...words.slice(0, 1)); break; }
      }
    });
    ctx.routes.push(entry);
  }
  /* Global middleware: app.use(requireAuth), app.use('/api', auth, router). */
  const uses: RouteUse[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = at(tokens, index);
    if (token.t === 'id' && ROUTER_OBJECT.test(token.v) && isPunc(tokens[index + 1], '.') && isWord(tokens[index + 2], 'use') && isPunc(tokens[index + 3], '(')) {
      const { args } = splitArgs(tokens, index + 3);
      const mount = args[0]?.[0];
      const prefix = isStr(mount) ? safeRoute(mount.v) : null;
      const words = args.flat().filter(t => t.t === 'id').map(t => t.v);
      uses.push({ line: token.line, prefix, words });
    }
  }
  ctx.uses = uses;
  /* Message listeners: addEventListener('message', e => ...), window.onmessage = e => ... */
  for (let index = 0; index < tokens.length; index += 1) {
    const token = at(tokens, index);
    const event = tokens[index + 2];
    if (token.v === 'addEventListener' && isPunc(tokens[index + 1], '(') && isStr(event) && event.v === 'message' && isPunc(tokens[index + 3], ',')) {
      const fn = functionAt(tokens, index + 4, tokens.length);
      if (fn) hints.set(fn.start, { kind: 'message' });
    }
    if (token.v === 'onmessage' && isPunc(tokens[index + 1], '=')) {
      const fn = functionAt(tokens, index + 2, tokens.length);
      if (fn) hints.set(fn.start, { kind: 'message' });
    }
  }
  ctx.handlerHints = hints;
  ctx.namedHandlers = named;
}

/*
 * File-based routers: a Next.js route handler's exported GET/POST, a pages
 * API route's default export, a server action file, SvelteKit's +server,
 * Remix and React Router's action and loader, a Supabase edge function.
 */
const NEXT_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

type FileRouteKind = 'next-app' | 'next-pages' | 'kit' | 'kit-actions' | 'remix' | 'edge' | 'lambda';

export function routeFromPath(path: string, kind: FileRouteKind | null): string {
  let route = path.replace(/^src\//, '');
  if (kind === 'next-app') route = route.replace(/^(app)\//, '/').replace(/\/route\.[a-z]+$/, '').replace(/\/\([^/)]+\)/g, '');
  if (kind === 'next-pages') route = route.replace(/^pages\//, '/').replace(/\.[a-z]+$/, '').replace(/\/index$/, '');
  if (kind === 'kit') route = route.replace(/^routes\//, '/').replace(/\/\+server\.[a-z]+$|\/\+page\.server\.[a-z]+$/, '').replace(/\/\([^/)]+\)/g, '');
  if (kind === 'remix') route = route.replace(/^app\/routes\//, '/').replace(/\.[a-z]+$/, '').replace(/\./g, '/').replace(/\$(\w+)/g, ':$1').replace(/\/_index$|\/index$/, '').replace(/\/route$/, '');
  if (kind === 'edge') route = route.replace(/^supabase\/functions\//, '/functions/v1/').replace(/\/index\.[a-z]+$/, '');
  route = route || '/';
  return safeRoute(route.startsWith('/') ? route : `/${route}`) || '/';
}

export function fileRouteKind(path: string): FileRouteKind | null {
  const plain = path.replace(/^src\//, '');
  if (/^app\/.*route\.(js|ts|mjs)$/.test(plain) || /^app\/route\.(js|ts)$/.test(plain)) return 'next-app';
  if (/^pages\/api\/.+\.(js|ts|mjs)$/.test(plain)) return 'next-pages';
  if (/^routes\/.*\+server\.(js|ts)$/.test(plain)) return 'kit';
  if (/^routes\/.*\+page\.server\.(js|ts)$/.test(plain)) return 'kit-actions';
  if (/^app\/routes\/.+\.(jsx?|tsx?)$/.test(path)) return 'remix';
  if (/^supabase\/functions\/[^/]+\/index\.(ts|js)$/.test(path)) return 'edge';
  if (/(^|\/)(netlify\/functions|api|functions|lambda|handlers?)\/[^/]+\.(js|ts|mjs)$/.test(path)) return 'lambda';
  return null;
}

export function fileRoutes(tokens: Tokens, ctx: FileContext): void {
  const kind = fileRouteKind(ctx.path);
  const hints = ctx.handlerHints;
  const useServerFile = opensWith(ctx.text, 'use server');
  ctx.serverActions = useServerFile;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = at(tokens, index);
    if (!isWord(token, 'export')) continue;
    let cursor = index + 1;
    const isDefault = isWord(tokens[cursor], 'default');
    if (isDefault) cursor += 1;
    let fnAt = cursor;
    let name: string | null = null;
    const declared = tokens[cursor + 1];
    if (isWord(tokens[cursor], 'async') && isWord(tokens[cursor + 1], 'function')) { name = tokens[cursor + 2]?.t === 'id' ? at(tokens, cursor + 2).v : null; }
    else if (isWord(tokens[cursor], 'function')) { name = declared?.t === 'id' ? declared.v : null; }
    else if ((isWord(tokens[cursor], 'const') || isWord(tokens[cursor], 'let')) && declared && isPunc(tokens[cursor + 2], '=')) {
      name = declared.v;
      fnAt = cursor + 3;
      /* export const POST = withAuth(async (req) => ...): the inner function. */
      if (!functionAt(tokens, fnAt, tokens.length)) {
        for (let inner = fnAt; inner < Math.min(tokens.length, fnAt + 12); inner += 1) {
          if (functionAt(tokens, inner, tokens.length)) { fnAt = inner; break; }
        }
      }
    }
    const fn = functionAt(tokens, fnAt, tokens.length);
    if (!fn) continue;
    const line = token.line;
    const add = (method: string, framework: string, hintKind: HintKind): void => {
      const entry: FlowRoute = { method, route: routeFromPath(ctx.path, kind === 'kit-actions' ? 'kit' : kind), path: ctx.path, line, framework, middleware: [], bodyStart: null, bodyEnd: null };
      ctx.routes.push(entry);
      hints.set(fn.start, { kind: hintKind, route: entry });
    };
    if (kind === 'next-app' && name && NEXT_METHODS.has(name)) add(name, 'next', 'next-route');
    else if (kind === 'next-pages' && isDefault) add('ANY', 'next-pages', 'route');
    else if (kind === 'kit' && name && NEXT_METHODS.has(name)) add(name, 'sveltekit', 'kit');
    else if (kind === 'remix' && (name === 'action' || name === 'loader')) add(name === 'action' ? 'POST' : 'GET', 'remix', 'kit');
    else if (kind === 'lambda' && (name === 'handler' || isDefault)) add('ANY', 'serverless', 'lambda');
    else if (useServerFile && name) {
      const entry: FlowRoute = { method: 'ACTION', route: null, action: true, path: ctx.path, line, framework: 'server-action', middleware: [], bodyStart: null, bodyEnd: null };
      ctx.routes.push(entry);
      hints.set(fn.start, { kind: 'action', route: entry });
    }
  }
  /* SvelteKit form actions: export const actions = { default: async ({ request }) => ... } */
  if (kind === 'kit-actions') {
    for (let index = 0; index < tokens.length; index += 1) {
      if (at(tokens, index).v === 'actions' && isPunc(tokens[index + 1], '=') && isPunc(tokens[index + 2], '{')) {
        const close = matching(tokens, index + 2);
        for (let inner = index + 3; inner < close; inner += 1) {
          const fn = functionAt(tokens, inner, close);
          if (fn) {
            const entry: FlowRoute = { method: 'POST', route: routeFromPath(ctx.path, 'kit'), path: ctx.path, line: at(tokens, inner).line, framework: 'sveltekit', middleware: [], bodyStart: null, bodyEnd: null };
            ctx.routes.push(entry);
            hints.set(fn.start, { kind: 'kit', route: entry });
            inner = fn.next;
          }
        }
      }
    }
  }
  /* Supabase edge function and Deno: serve(async (req) => ...), Deno.serve(...) */
  if (kind === 'edge') {
    for (let index = 0; index < tokens.length; index += 1) {
      const token = at(tokens, index);
      if ((token.v === 'serve' || (token.v === 'Deno' && tokens[index + 2]?.v === 'serve')) && tokens.slice(index, index + 4).some(t => isPunc(t, '('))) {
        const open = tokens.findIndex((t, i) => i > index && isPunc(t, '('));
        for (let inner = open + 1; inner < Math.min(tokens.length, open + 8); inner += 1) {
          const fn = functionAt(tokens, inner, tokens.length);
          if (fn) {
            const entry: FlowRoute = { method: 'ANY', route: routeFromPath(ctx.path, 'edge'), path: ctx.path, line: token.line, framework: 'supabase-edge', middleware: [], bodyStart: null, bodyEnd: null };
            ctx.routes.push(entry);
            hints.set(fn.start, { kind: 'route', route: entry });
            break;
          }
        }
        break;
      }
    }
  }
  /* Inline server actions: a function whose body opens with 'use server'. */
  for (let index = 0; index < tokens.length; index += 1) {
    const fn = functionAt(tokens, index, tokens.length);
    const directive = fn ? tokens[fn.bodyStart] : undefined;
    if (fn && fn.block && isStr(directive) && directive.v === 'use server' && !hints.has(fn.start)) {
      const entry: FlowRoute = { method: 'ACTION', route: null, action: true, path: ctx.path, line: at(tokens, index).line, framework: 'server-action', middleware: [], bodyStart: null, bodyEnd: null };
      ctx.routes.push(entry);
      hints.set(fn.start, { kind: 'action', route: entry });
    }
  }
}
