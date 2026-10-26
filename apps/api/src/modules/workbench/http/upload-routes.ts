/*
 * The workbench's upload routes, each a raw stream body: a blob for a later
 * batch commit, and the smart upload -- one file committed by the transport
 * this deployment can carry for its size and the reader's choice (the Git
 * Data API, a native Git push, or Git LFS), with any swap reported. Every
 * upload takes a slot, streams to a private temporary file under the route's
 * limit, is scanned before anything is written, and leaves no file behind.
 *
 * The guards are handed in under the names the route policy records.
 */
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Application, Request, RequestHandler, Response } from 'express';
import { PRODUCT_NAME } from '../../../platform/release/version.ts';
import { member, type Fields } from '../../../platform/values/fields.ts';
import { normalizeTransportChoice, planUploadTransport } from '../../../../../../packages/contracts/src/upload-planning.ts';
import { normalizeBranchName, normalizeRepoPath } from '../../corona/index.ts';
import type { CommitWriter, Gh } from '../application/commit-writer.ts';
import type { LfsTransfer } from '../application/lfs.ts';
import type { NativePush } from '../application/native-push.ts';
import type { UploadIntake } from '../application/upload-intake.ts';
import { repositoryPath } from './provider-values.ts';

export interface UploadLimits {
  /* The largest blob, upload, native push and Git Data API write this deployment takes, in bytes. */
  readonly blobMaxBytes: number;
  readonly uploadMaxBytes: number;
  readonly gitPushMaxBytes: number;
  readonly gitDataMaxBytes: number;
}

export interface UploadRouteDeps {
  readonly providerSessionAccess: RequestHandler;
  readonly alphaRepositoryAccess: RequestHandler;
  readonly capabilityAccess: (feature: string) => RequestHandler;
  /* A capability required only when the request asks for what it covers. */
  readonly capabilityAccessWhen: (feature: string, applies: (req: Request) => boolean) => RequestHandler;
  readonly auth: RequestHandler;
  readonly mutationContext: (action: string) => RequestHandler;
  /* The provider account the session is acting as, as the guards attached it. */
  readonly account: (req: Request) => Fields;
  /* The server's public error answer. */
  readonly fail: (res: Response, error: unknown) => unknown;
  readonly gh: Gh;
  readonly commits: Pick<CommitWriter, 'commitTree'>;
  readonly intake: UploadIntake;
  readonly nativePush: NativePush;
  readonly lfs: LfsTransfer;
  readonly limits: UploadLimits;
  /* The upload's security scan: refuses a blocked file, with its evidence recorded. */
  scanUpload(req: Request, tmp: string, repoPath: string, size: number): Promise<unknown>;
  /* Refuses a change to a path the session's safeguards protect. */
  enforceProtectedPaths(req: Request, paths: readonly unknown[]): void;
}

/* A private name for an upload's temporary file. */
function temporaryFile(): string {
  return path.join(os.tmpdir(), 'nv-' + crypto.randomBytes(8).toString('hex'));
}

export function registerUploadRoutes(app: Application, deps: UploadRouteDeps): void {
  const { providerSessionAccess, alphaRepositoryAccess, capabilityAccess, capabilityAccessWhen, auth, mutationContext, account, fail, gh, intake, limits } = deps;
  const R = repositoryPath;

  /* A file committed by the Git Data API: its blob, then one commit. */
  async function uploadViaBlob(acct: Fields, owner: unknown, repo: unknown, branch: string, p: string, tmp: string, message: unknown, expectedHeadSha: unknown = ''): Promise<Record<string, unknown>> {
    const b64 = (await fsp.readFile(tmp)).toString('base64');
    const blob = await gh(acct, `/repos/${String(owner)}/${String(repo)}/git/blobs`, { method: 'POST', body: { content: b64, encoding: 'base64' } });
    const commit = await deps.commits.commitTree(acct, owner, repo, branch, message, [{ path: p, mode: '100644', type: 'blob', sha: member(blob, 'sha') }], expectedHeadSha);
    return { commit };
  }

  /* A git blob created from a raw stream, for a batch commit; its sha is answered. */
  app.post('/api/repo/:owner/:repo/blob', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('native-push'), capabilityAccess('upload-security'), auth, mutationContext('git.blob.create'), async (req: Request, res: Response) => {
    const tmp = temporaryFile();
    let release = (): void => {};
    try {
      release = await intake.acquireSlot(req, limits.blobMaxBytes);
      const size = await intake.receive(req, tmp, limits.blobMaxBytes);
      const securityScan = await deps.scanUpload(req, tmp, String(req.query.path || 'batch-blob'), size);
      const b64 = (await fsp.readFile(tmp)).toString('base64');
      let blob: unknown;
      try {
        blob = await gh(account(req), `${R(req)}/git/blobs`, { method: 'POST', body: { content: b64, encoding: 'base64' } });
      } catch (e) {
        if (/too large/i.test(String(member(e, 'message') || ''))) {
          res.status(413).json({ error: 'GitHub rejected this blob as too large for its API — this file will be pushed individually via Git LFS instead' });
          return;
        }
        throw e;
      }
      res.json({ ok: true, sha: member(blob, 'sha'), size, securityScan });
    } catch (e) { fail(res, e); }
    finally { release(); fsp.unlink(tmp).catch(() => {}); }
  });

  /* The smart upload router -- the headline feature. */
  app.post('/api/repo/:owner/:repo/upload', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('native-push'), capabilityAccess('upload-security'), capabilityAccessWhen('lfs', req => normalizeTransportChoice(req.query.lfs) === 'lfs'), auth, mutationContext('file.upload'), async (req: Request, res: Response) => {
    const { owner, repo } = req.params;
    const requestedPath = req.query.path;
    const requestedBranch = req.query.branch;
    const message = req.query.message || `Upload ${String(requestedPath)} via ${PRODUCT_NAME}`;
    /*
     * auto | git | lfs. It was auto|force, which offered one direction only: a
     * reader could insist on Git LFS and could never insist on ordinary Git,
     * because the size rule settled that. An 80 MB video that pushes perfectly
     * well through Git had no way to be pushed that way.
     */
    const transportChoice = normalizeTransportChoice(req.query.lfs);
    const expectedHeadSha = String(req.query.expectedHeadSha || '');
    if (!requestedPath || !requestedBranch) { res.status(400).json({ error: 'path and branch required' }); return; }
    let p: string, branch: string;
    try { p = normalizeRepoPath(requestedPath); branch = normalizeBranchName(requestedBranch); }
    catch (error) { fail(res, error); return; }

    const tmp = temporaryFile();
    let release = (): void => {};
    try {
      release = await intake.acquireSlot(req, limits.uploadMaxBytes);
      const hash = crypto.createHash('sha256');
      const size = await intake.receive(req, tmp, limits.uploadMaxBytes, hash);
      const oid = hash.digest('hex');
      const securityScan = await deps.scanUpload(req, tmp, p, size);
      /*
       * One decision, made once, for every provider: what the reader asked for,
       * what this deployment can carry, and -- when those differ -- which
       * transport is used instead and why. The browser labels a queued file with
       * this same function, so what is shown and what happens cannot drift.
       */
      const plan = planUploadTransport({
        size,
        requested: transportChoice,
        lfsAvailable: (account(req).provider || 'github') === 'github',
        gitPushMaxBytes: limits.gitPushMaxBytes,
        gitDataMaxBytes: limits.gitDataMaxBytes
      });
      if (plan.refusal) throw Object.assign(new Error(plan.refusal.message), { status: plan.refusal.status });
      /* Reported on every upload, so a transport swap is never silent. */
      const transport: { requested: unknown; fallback: unknown } = { requested: plan.requested, fallback: plan.fallback };
      let result: Record<string, unknown>;
      if (plan.route === 'lfs') {
        deps.enforceProtectedPaths(req, [p, '.gitattributes']);
        result = await deps.lfs.upload(account(req), owner, repo, branch, p, tmp, oid, size, message, expectedHeadSha);
        result.strategy = 'lfs';
      } else if (plan.route === 'git-push') {
        try {
          result = await deps.nativePush.push(account(req), owner, repo, branch, p, tmp, message, expectedHeadSha);
          result.strategy = 'git-push';
        } catch (ePush) {
          if (member(ePush, 'code') === 'BRANCH_CHANGED' || member(ePush, 'status') === 400 || member(ePush, 'status') === 401 || member(ePush, 'status') === 409) throw ePush;
          console.error(JSON.stringify({ t: new Date().toISOString(), warn: 'native push failed, laddering', status: member(ePush, 'status') || 0, err: member(ePush, 'message') }));
          try {
            result = await uploadViaBlob(account(req), owner, repo, branch, p, tmp, message, expectedHeadSha);
            result.strategy = 'git-data-blob';
          } catch (e) {
            if (/too large/i.test(String(member(e, 'message') || ''))) {
              deps.enforceProtectedPaths(req, [p, '.gitattributes']);
              result = await deps.lfs.upload(account(req), owner, repo, branch, p, tmp, oid, size, message, expectedHeadSha);
              result.strategy = 'lfs (auto-fallback)';
              /* The plan said Git and the provider disagreed at run time. That is
               * still a swap, so it is still reported. */
              transport.fallback = transport.fallback || Object.freeze({
                from: 'git', to: 'lfs',
                reason: 'the provider refused the object as too large for an ordinary Git push'
              });
            } else throw e;
          }
        }
      } else {
        result = await uploadViaBlob(account(req), owner, repo, branch, p, tmp, message, expectedHeadSha);
        result.strategy = 'git-data-api';
      }
      res.json({ ok: true, size, ...result, transport, securityScan });
    } catch (e) { fail(res, e); }
    finally { release(); fsp.unlink(tmp).catch(() => {}); }
  });
}
