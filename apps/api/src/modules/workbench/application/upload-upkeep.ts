/*
 * An upload's temporary file left behind -- by a process that stopped part
 * way through, say -- is removed once it is older than the deployment's
 * stale-upload age.
 *
 * Only the files the upload routes name (nv- and sixteen hexadecimal digits,
 * in the system's temporary directory), only regular files, never a link, and
 * only by their own modification time. Upkeep runs at startup and then every
 * stale-upload age, but never more often than hourly, on a timer that does not
 * keep the process alive. A temporary directory that cannot be read, or a file
 * that went away meanwhile, is left for the next run.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/* An upload's temporary file, as http/upload-routes.ts names it. */
const UPLOAD_TEMP_NAME = /^nv-[0-9a-f]{16}$/;
const HOUR_MS = 60 * 60 * 1000;

export interface UploadUpkeepDeps {
  /* The deployment's stale-upload age, in hours (NV_STALE_UPLOAD_HOURS). */
  readonly staleHours: number;
}

export function createUploadUpkeep(deps: UploadUpkeepDeps) {
  const staleAfterMs = deps.staleHours * HOUR_MS;

  async function cleanupStaleUploads(): Promise<void> {
    const tempRoot = os.tmpdir();
    let names: string[] = [];
    try { names = await fsp.readdir(tempRoot); } catch { return; }
    const cutoff = Date.now() - staleAfterMs;
    await Promise.allSettled(names
      .filter(name => UPLOAD_TEMP_NAME.test(name))
      .map(async name => {
        const file = path.join(tempRoot, name);
        const stat = await fsp.lstat(file);
        if (stat.isFile() && stat.mtimeMs < cutoff) await fsp.unlink(file);
      }));
  }

  function startTempMaintenance(): void {
    cleanupStaleUploads().catch(() => {});
    const timer = setInterval(() => cleanupStaleUploads().catch(() => {}), Math.max(staleAfterMs, HOUR_MS));
    if (typeof timer.unref === 'function') timer.unref();
  }

  return { cleanupStaleUploads, startTempMaintenance };
}

export type UploadUpkeep = ReturnType<typeof createUploadUpkeep>;
