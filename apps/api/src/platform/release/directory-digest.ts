/*
 * The digest of a built directory: every regular file, by its path relative to
 * the root and the SHA-256 of its bytes, in byte order of the path. The served
 * browser build (servedAssetsSha256) and the compiled server tree
 * (serverBuildSha256) are named this way, so two builds of the same source
 * compare by one value and the server can attest what it runs at startup.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function listFiles(root: string, what: string, prefix = ''): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...listFiles(root, what, relative));
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`unexpected entry in ${what}: ${relative}`);
  }
  return files;
}

export function directoryDigest(root: string, what = 'the build'): string {
  const files = listFiles(root, what).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const digest = createHash('sha256');
  for (const file of files) {
    const content = createHash('sha256').update(readFileSync(join(root, file))).digest('hex');
    digest.update(`${file}\0${content}\n`);
  }
  return digest.digest('hex');
}
