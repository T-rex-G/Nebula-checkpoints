/*
 * The one place a worker thread or a child process names the file it runs.
 *
 * A worker is started by the path of a file, and that path must be the file
 * that actually runs. Natively it is the source as written; in the compiled
 * runtime (dist/server, ADR-088) it is what tsc emitted, beside the same
 * relative path, with `.js` where the source had `.ts`. A literal path, a
 * `__filename` or a `path.join(__dirname, …)` written at the spawn site would
 * be right in one runtime and wrong in the other, so each entry is declared
 * here and resolved from this module's own location and extension.
 * test/module-boundaries.test.js refuses an entry path written anywhere else.
 */
import { fileURLToPath } from 'node:url';

export type EntryName = 'code-audit-worker' | 'rendered-site-worker';

interface Entry {
  /* Relative to this file, without its extension. */
  readonly file: string;
  /* `ts` entries run as `.ts` natively and as `.js` compiled; `js` entries are `.js` in both. */
  readonly language: 'js' | 'ts';
}

const ENTRIES: Readonly<Record<EntryName, Entry>> = Object.freeze({
  /* Uranus's analysis in a worker thread with its own heap cap: the module starts itself. */
  'code-audit-worker': Object.freeze({ file: './modules/uranus/application/audit-worker', language: 'ts' }),
  /* Parallax's rendered check in a disposable child process. */
  'rendered-site-worker': Object.freeze({ file: '../../../src/rendered-site-worker', language: 'js' })
});

/* `.ts` when the server runs its source, `.js` when it runs the compiled tree. */
const RUNTIME_EXTENSION = import.meta.url.endsWith('.ts') ? '.ts' : '.js';

export function entryFile(name: EntryName): string {
  const entry = ENTRIES[name];
  const extension = entry.language === 'ts' ? RUNTIME_EXTENSION : '.js';
  return fileURLToPath(new URL(`${entry.file}${extension}`, import.meta.url));
}
