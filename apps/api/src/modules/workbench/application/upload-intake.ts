/*
 * How an uploaded file arrives: a slot among this deployment's concurrent
 * uploads, refused before anything is read when the declared size is over the
 * route's limit or the temporary disk cannot hold it, and the bytes streamed
 * to a private temporary file, stopped the moment they pass the limit. A slot
 * is released once, however the upload ends.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import type { Hash } from 'node:crypto';
import type { Request } from 'express';
import { member } from '../../../platform/values/fields.ts';

const MB = 1024 * 1024;

export interface UploadIntakeDeps {
  /* How many uploads this deployment takes at once, and how long one may last. */
  readonly concurrency: number;
  readonly timeoutMs: number;
}

export interface UploadIntake {
  acquireSlot(req: Request, maxBytes: number): Promise<() => void>;
  receive(req: Request, tmp: string, maxBytes: number, hash?: Hash): Promise<number>;
}

export function createUploadIntake(deps: UploadIntakeDeps): UploadIntake {
  let activeUploads = 0;

  async function acquireSlot(req: Request, maxBytes: number): Promise<() => void> {
    const rawLength = req.headers['content-length'];
    const declared = rawLength == null ? 0 : Number(rawLength);
    if (!Number.isFinite(declared) || declared < 0) throw Object.assign(new Error('Invalid Content-Length'), { status: 400 });
    if (declared > maxBytes) throw Object.assign(new Error(`Upload exceeds the ${Math.floor(maxBytes / MB)} MB route limit`), { status: 413 });
    if (activeUploads >= deps.concurrency) throw Object.assign(new Error('Another upload is already in progress — retry shortly'), { status: 429 });
    if (declared) {
      try {
        const st = await fsp.statfs(os.tmpdir());
        const available = Number(st.bavail) * Number(st.bsize);
        if (Number.isFinite(available) && declared + 32 * MB > available) {
          throw Object.assign(new Error('Not enough temporary disk space for this upload on the current hosting plan'), { status: 507 });
        }
      } catch (error) {
        if (error && member(error, 'status') === 507) throw error;
        /* Some filesystems do not expose statfs; the streamed hard limit still applies. */
      }
    }
    activeUploads += 1;
    req.setTimeout(deps.timeoutMs, () => req.destroy(new Error('Upload timed out')));
    let released = false;
    return () => { if (!released) { released = true; activeUploads = Math.max(0, activeUploads - 1); } };
  }

  function receive(req: Request, tmp: string, maxBytes: number, hash?: Hash): Promise<number> {
    return new Promise((resolve, reject) => {
      let size = 0;
      let settled = false;
      const w = fs.createWriteStream(tmp, { flags: 'wx', mode: 0o600 });
      const finishError = (error: unknown): void => {
        if (settled) return;
        settled = true;
        req.unpipe(w);
        w.destroy();
        req.resume();
        reject(error);
      };
      req.on('aborted', () => finishError(Object.assign(new Error('Upload was aborted'), { status: 499 })));
      req.on('error', finishError);
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) { finishError(Object.assign(new Error(`Upload exceeds the ${Math.floor(maxBytes / MB)} MB route limit`), { status: 413 })); return; }
        if (hash) hash.update(chunk);
      });
      w.on('error', finishError);
      w.on('finish', () => {
        if (settled) return;
        settled = true;
        resolve(size);
      });
      req.pipe(w);
    });
  }

  return { acquireSlot, receive };
}
