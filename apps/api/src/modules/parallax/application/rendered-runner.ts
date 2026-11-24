/*
 * The rendered audit in a disposable process, environment and temporary
 * directory. No provider, session or database credentials are passed to
 * Chromium or its JavaScript host. The process group is killed on
 * cancellation and on timeout, browser descendants included.
 */
import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { entryFile } from '../../../entrypoint.ts';
import { read } from '../../../platform/values/fields.ts';
import { auditError, renderedUrl } from '../domain/rendered-address.ts';

/* Chromium creates its own process group. Killing only the Node worker's
   group would leave it behind. Snapshot Linux parentage, then stop descendants
   before the worker; reading stat never collects arguments or environment. */
export function killProcessTree(pid: unknown): void {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1) return;
  const children = new Map<number, number[]>();
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');
      const parent = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      const siblings = children.get(parent) || [];
      children.set(parent, siblings);
      siblings.push(Number(entry));
    } catch { /* The process exited while the snapshot was read. */ }
  }
  const stop = (target: number): void => {
    for (const child of children.get(target) || []) stop(child);
    try { process.kill(-target, 'SIGKILL'); } catch { /* not a group leader */ }
    try { process.kill(target, 'SIGKILL'); } catch { /* exited */ }
  };
  stop(pid);
}

export interface RenderedRun {
  readonly url: unknown;
  readonly executablePath?: string | null;
  readonly signal?: AbortSignal | null;
  readonly onProgress?: (progress: unknown) => void;
}

/* A report crosses back from the child by structured clone; this side does not claim to know its type. */
export function runRenderedSite({ url: requestedUrl, executablePath, signal, onProgress = () => {} }: RenderedRun): Promise<unknown> {
  const url = renderedUrl(requestedUrl);
  if (process.platform !== 'linux') return Promise.reject(auditError('The isolated rendered worker requires a Linux deployment.'));
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(auditError('Audit cancelled.', 'RENDERED_AUDIT_CANCELLED', 499));
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-rendered-'));
    let child: ChildProcess;
    try { child = fork(entryFile('rendered-site-worker'), [], {
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', TMPDIR: directory, LANG: 'C.UTF-8' },
      execArgv: ['--max-old-space-size=256'], detached: process.platform !== 'win32',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    }); } catch {
      fs.rmSync(directory, { recursive: true, force: true });
      return reject(auditError('The isolated audit process could not start.'));
    }
    let settled = false;
    const stop = (): void => { try { killProcessTree(child.pid); } catch { child.kill('SIGKILL'); } };
    const finish = (error: Error | null, result?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', cancel);
      stop();
      fs.rm(directory, { recursive: true, force: true, maxRetries: 3 }, () => {});
      if (error) reject(error); else resolve(result);
    };
    const cancel = (): void => finish(auditError('Audit cancelled.', 'RENDERED_AUDIT_CANCELLED', 499));
    const timer = setTimeout(() => finish(auditError('The browser exceeded its time limit.', 'RENDERED_AUDIT_TIMEOUT', 504)), 95000);
    if (signal) signal.addEventListener('abort', cancel, { once: true });
    child.on('message', (message: unknown) => {
      if (!message || typeof message !== 'object') return;
      const progress = read(message, 'progress');
      const result = read(message, 'result');
      const failure = read(message, 'error');
      if (progress) { try { onProgress(progress); } catch { /* advisory only */ } }
      else if (result) finish(null, result);
      else if (failure) {
        /* Each part as the worker sent it, and what an absent part means to an Error and to auditError. */
        const text = read(failure, 'message');
        const code = read(failure, 'code');
        const status = read(failure, 'status');
        finish(auditError(text === undefined ? '' : String(text), code === undefined ? undefined : String(code), typeof status === 'number' ? status : undefined));
      }
    });
    child.on('error', () => finish(auditError('The isolated audit process could not start.')));
    child.on('exit', () => finish(auditError('The isolated audit process exited before returning a report.')));
    child.send({ url, executablePath }, error => { if (error) finish(auditError('The isolated audit process could not start.')); });
  });
}
