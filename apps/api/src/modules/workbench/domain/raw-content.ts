/*
 * How a file's bytes are served from the repository. Content a browser would
 * run -- HTML, SVG, XML and its stylesheets -- is sent as a download, never
 * rendered on this origin; anything else is shown inline under the type its
 * extension names, or as opaque bytes. A Git LFS pointer is recognised by its
 * exact text, so the real object can be fetched from LFS storage instead.
 */
import path from 'node:path';

const ACTIVE_CONTENT = /\.(html?|xhtml|svg|svgz|xml|xslt?)$/i;

const TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.json': 'application/json', '.html': 'text/html; charset=utf-8'
});

export function guessMime(repoPath: string): string {
  const extension = path.extname(repoPath || '').toLowerCase();
  return Object.hasOwn(TYPES, extension) ? TYPES[extension] ?? 'application/octet-stream' : 'application/octet-stream';
}

export interface RawHeaders {
  readonly contentType: string;
  readonly contentDisposition: string;
}

export function rawContentHeaders(repoPath: string): RawHeaders {
  const fname = path.basename(repoPath).replace(/"/g, '');
  if (ACTIVE_CONTENT.test(repoPath)) {
    return { contentType: 'application/octet-stream', contentDisposition: `attachment; filename="${fname}"` };
  }
  return { contentType: guessMime(repoPath), contentDisposition: `inline; filename="${fname}"` };
}

/* A Git LFS pointer's object id and size, when the text is exactly one. */
const LFS_POINTER = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:([a-f0-9]{64})\nsize (\d+)\s*$/;
export interface LfsPointer {
  readonly oid: string;
  readonly size: string;
}
export function lfsPointer(textValue: string): LfsPointer | null {
  const match = LFS_POINTER.exec(textValue);
  return match && match[1] !== undefined && match[2] !== undefined ? { oid: match[1], size: match[2] } : null;
}
