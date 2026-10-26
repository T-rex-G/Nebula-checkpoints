/*
 * The browser's third-party libraries and fonts, served from this origin.
 *
 * Only the allowlisted paths below are served. A normal deployment bundles
 * every one of them, so they are read from disk. If a file is missing, the
 * route falls back to the exact same path on the CDN. That fetch goes through
 * the guarded transport, its answer is held to 2 MB, and what it returns is
 * kept in memory up to 24 MB, the oldest entry dropped first.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Application, Request, Response } from 'express';
import { member } from '../../platform/values/fields.ts';

/* The guarded transport, as the server reaches the network. */
export type GuardedFetch = (url: unknown, init: Readonly<Record<string, unknown>>, timeoutMs?: number) => Promise<globalThis.Response>;

export interface VendorRouteDeps {
  readonly fetch: GuardedFetch;
  /* Where the build put the bundled vendor files. */
  readonly vendorRoot: string;
}

const MB = 1024 * 1024;
const SAFE_ASSET = /^[A-Za-z0-9@._/+-]+$/;
export const VENDOR_ALLOWLIST: ReadonlySet<string> = new Set([
  'codemirror/5.65.16/codemirror.min.js',
  'codemirror/5.65.16/codemirror.min.css',
  'codemirror/5.65.16/mode/meta.min.js',
  'codemirror/5.65.16/mode/javascript/javascript.min.js',
  'codemirror/5.65.16/mode/xml/xml.min.js',
  'codemirror/5.65.16/mode/css/css.min.js',
  'codemirror/5.65.16/mode/htmlmixed/htmlmixed.min.js',
  'codemirror/5.65.16/mode/markdown/markdown.min.js',
  'codemirror/5.65.16/mode/python/python.min.js',
  'codemirror/5.65.16/mode/shell/shell.min.js',
  'codemirror/5.65.16/mode/yaml/yaml.min.js',
  'codemirror/5.65.16/addon/search/searchcursor.min.js',
  'codemirror/5.65.16/theme/ayu-mirage.min.css',
  'codemirror/5.65.16/theme/base16-light.min.css',
  'codemirror/5.65.16/theme/dracula.min.css',
  'codemirror/5.65.16/theme/eclipse.min.css',
  'codemirror/5.65.16/theme/material-ocean.min.css',
  'codemirror/5.65.16/theme/monokai.min.css',
  'codemirror/5.65.16/theme/nord.min.css',
  'marked/15.0.12/marked.min.js',
  'three/0.185.1/three.module.min.js',
  'three/0.185.1/three.core.min.js',
  'dompurify/3.4.17/purify.min.js',
  'fonts/archivo-variable-latin.woff2',
  'fonts/public-sans-variable-latin.woff2',
  'fonts/jetbrains-mono-variable-latin.woff2',
  'fonts/fira-code-variable-latin.woff2',
  'fonts/source-code-pro-variable-latin.woff2',
  'fonts/ibm-plex-mono-400-latin.woff2',
  'fonts/ibm-plex-mono-500-latin.woff2',
  'fonts/dm-mono-400-latin.woff2',
  'fonts/dm-mono-500-latin.woff2'
]);

/* A response's body, refused once it passes the limit, whether the limit was declared or only reached. */
export async function readBoundedResponse(response: globalThis.Response, maxBytes = 2 * MB): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > maxBytes) throw Object.assign(new Error('Vendor asset exceeds the response limit'), { status: 502 });
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel('response limit exceeded'); } catch {}
      throw Object.assign(new Error('Vendor asset exceeds the response limit'), { status: 502 });
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

export function registerVendorRoute(app: Application, deps: VendorRouteDeps): void {
  const cache = new Map<string, { readonly buf: Buffer; readonly type: string }>();
  let cachedBytes = 0;

  async function proxyAsset(res: Response, upstream: string): Promise<unknown> {
    const hit = cache.get(upstream);
    if (hit) {
      res.setHeader('Content-Type', hit.type);
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      return res.end(hit.buf);
    }
    const r = await deps.fetch(upstream, {
      headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36' }
    });
    if (!r.ok) return res.status(502).json({ error: `Vendor upstream ${r.status}` });
    const buf = await readBoundedResponse(r, 2 * MB);
    const type = r.headers.get('content-type') || 'application/octet-stream';
    if (buf.length <= 2 * MB) {
      cachedBytes += buf.length;
      cache.set(upstream, { buf, type });
      while (cachedBytes > 24 * MB && cache.size) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cachedBytes -= cache.get(oldest)?.buf.length ?? 0;
        cache.delete(oldest);
      }
    }
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return res.end(buf);
  }

  app.get('/vendor/*', async (req: Request, res: Response) => {
    try {
      const p = req.params[0] || '';
      if (!SAFE_ASSET.test(p) || p.includes('..') || !VENDOR_ALLOWLIST.has(p)) return res.status(404).end();
      const localPath = path.resolve(deps.vendorRoot, p);
      if (localPath.startsWith(deps.vendorRoot + path.sep) && fs.existsSync(localPath)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        return res.sendFile(localPath);
      }
      /* Exact allowlisted CDN fallback only; normal deployments bundle every vendor asset. */
      await proxyAsset(res, 'https://cdnjs.cloudflare.com/ajax/libs/' + p);
    } catch (e) { res.status(502).json({ error: member(e, 'message') }); }
  });
}
