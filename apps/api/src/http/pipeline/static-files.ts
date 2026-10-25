/*
 * The request body and the built page's files.
 *
 * JSON bodies are parsed after the webhook route, which needs the exact bytes
 * GitHub signed and reads them raw. The browser build's files are served with
 * the cache rule each one's name earns (platform/release/web-build.ts).
 */
import express from 'express';
import type { RequestHandler } from 'express';
import { webCacheControl } from '../../platform/release/web-build.ts';

export const JSON_BODY_LIMIT = '30mb';

export function jsonBody(): RequestHandler {
  return express.json({ limit: JSON_BODY_LIMIT });
}

export function staticFiles(webRoot: string): RequestHandler {
  return express.static(webRoot, {
    index: false,
    setHeaders(res, filePath) { res.setHeader('Cache-Control', webCacheControl(webRoot, filePath)); }
  });
}
