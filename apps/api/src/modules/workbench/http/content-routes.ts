/*
 * The workbench's content routes: a folder's listing, every file path on a
 * branch, a file's text (or what it is when it is an LFS pointer or too large
 * to show), a file's raw bytes -- from LFS storage when the file is a pointer
 * -- and the writes: a file saved or deleted, a file renamed, and many staged
 * changes committed at once. Every write is one commit through the commit
 * writer, on the head the caller's view was loaded at.
 *
 * The guards are handed in under the names the route policy records.
 */
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Application, Request, RequestHandler, Response } from 'express';
import { PRODUCT_NAME } from '../../../platform/release/version.ts';
import { isFields, member, type Fields } from '../../../platform/values/fields.ts';
import { normalizeFileBatch } from '../../../platform/mutation-gateway/mutation-coverage.ts';
import { normalizeBranchName, normalizeRepoPath } from '../../corona/index.ts';
import type { CommitWriter, Gh } from '../application/commit-writer.ts';
import type { LfsTransfer } from '../application/lfs.ts';
import { assertExpectedHead, requireAggregateExpectedHead } from '../domain/head-checks.ts';
import { lfsPointer, rawContentHeaders } from '../domain/raw-content.ts';
import { bodyField, fromWebBody, listed, repositoryPath, text } from './provider-values.ts';

const MB = 1024 * 1024;

export interface ContentRouteDeps {
  readonly providerSessionAccess: RequestHandler;
  readonly alphaRepositoryAccess: RequestHandler;
  readonly capabilityAccess: (feature: string) => RequestHandler;
  readonly auth: RequestHandler;
  readonly mutationContext: (action: string) => RequestHandler;
  /* The provider account the session is acting as, as the guards attached it. */
  readonly account: (req: Request) => Fields;
  /* The server's public error answer. */
  readonly fail: (res: Response, error: unknown) => unknown;
  readonly gh: Gh;
  /* The provider's REST API answered as the raw response, for bytes that are streamed on. */
  ghRaw(account: Fields, apiPath: string, options: { readonly accept: string }): Promise<globalThis.Response>;
  readonly commits: CommitWriter;
  readonly lfs: LfsTransfer;
  /* Refuses an account whose provider and deployment are not qualified for LFS. */
  assertProviderBoundLfs(account: Fields): unknown;
  /* The mutation gateway's operations so far in this request. */
  executionSnapshot(): { readonly operationIds: readonly unknown[] } | null;
}

/* A path in a contents URL, each segment encoded. */
function encodePath(repoPath: string): string {
  return (repoPath || '').split('/').map(encodeURIComponent).join('/');
}

/* `Buffer.from(value, 'base64')`, called as JavaScript calls it on a provider's field. */
function fromBase64(value: unknown): Buffer {
  const decoded: unknown = Reflect.apply(Buffer.from, Buffer, [value, 'base64']);
  if (!Buffer.isBuffer(decoded)) throw new TypeError('Buffer.from did not answer a Buffer');
  return decoded;
}

/* `body.path = normalized`, as a sloppy-mode assignment makes it: a body that is not an object keeps nothing. */
function setBodyField(req: Request, name: string, value: unknown): void {
  const body: unknown = req.body;
  if (isFields(body)) Reflect.set(body, name, value);
}

export function registerContentRoutes(app: Application, deps: ContentRouteDeps): void {
  const { providerSessionAccess, alphaRepositoryAccess, capabilityAccess, auth, mutationContext, account, fail, gh, commits } = deps;
  const R = repositoryPath;

  app.get('/api/repo/:owner/:repo/tree', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('tree.read'), auth, async (req: Request, res: Response) => {
    try {
      const p = req.query.path ? normalizeRepoPath(req.query.path) : '';
      const items = await gh(account(req),
        `${R(req)}/contents/${encodePath(p)}?ref=${encodeURIComponent(String(req.query.ref))}`);
      const list: unknown[] = Array.isArray(items) ? items : [items];
      list.sort((a, b) => (member(a, 'type') === member(b, 'type')
        ? text(member(a, 'name'), 'a.name.localeCompare').localeCompare(String(member(b, 'name')))
        : member(a, 'type') === 'dir' ? -1 : 1));
      res.json(list.map(i => ({ name: member(i, 'name'), path: member(i, 'path'), type: member(i, 'type'), size: member(i, 'size'), sha: member(i, 'sha') })));
    } catch (e) { fail(res, e); }
  });

  /* Every file path on a branch, for the command palette's fuzzy finder. */
  app.get('/api/repo/:owner/:repo/files', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('tree.read'), capabilityAccess('branches.read'), auth, async (req: Request, res: Response) => {
    try {
      const ref = req.query.ref;
      const br = await gh(account(req), `${R(req)}/branches/${encodeURIComponent(String(ref))}`);
      const tree = await gh(account(req),
        `${R(req)}/git/trees/${String(member(member(br, 'commit'), 'sha'))}?recursive=1`);
      res.json({
        truncated: !!member(tree, 'truncated'),
        files: listed(member(tree, 'tree') || [], '(tree.tree || []).filter').filter(t => member(t, 'type') === 'blob').map(t => member(t, 'path')).slice(0, 8000)
      });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/repo/:owner/:repo/file', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('file.read'), auth, async (req: Request, res: Response) => {
    try {
      const requestedPath = normalizeRepoPath(req.query.path);
      const meta = await gh(account(req),
        `${R(req)}/contents/${encodePath(requestedPath)}?ref=${encodeURIComponent(String(req.query.ref))}`);
      if (member(meta, 'content')) {
        const pointer = lfsPointer(fromBase64(member(meta, 'content')).toString('utf8'));
        if (pointer) {
          res.json({ lfs: true, name: member(meta, 'name'), path: member(meta, 'path'), sha: member(meta, 'sha'), size: parseInt(pointer.size, 10), oid: pointer.oid });
          return;
        }
      }
      if (Number(member(meta, 'size')) > MB) {
        res.json({ tooLarge: true, name: member(meta, 'name'), path: member(meta, 'path'), sha: member(meta, 'sha'), size: member(meta, 'size') });
        return;
      }
      res.json({ name: member(meta, 'name'), path: member(meta, 'path'), sha: member(meta, 'sha'), size: member(meta, 'size'), content: member(meta, 'content'), encoding: member(meta, 'encoding') });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/repo/:owner/:repo/raw', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('file.read'), auth, async (req: Request, res: Response) => {
    try {
      const p = normalizeRepoPath(req.query.path);
      const r = await deps.ghRaw(account(req),
        `${R(req)}/contents/${encodePath(p)}?ref=${encodeURIComponent(String(req.query.ref))}`,
        { accept: 'application/vnd.github.raw+json' });
      if (!r.ok) { res.status(r.status).json({ error: 'Could not fetch raw content' }); return; }
      if (r.body === null) throw new TypeError("Cannot read properties of null (reading 'getReader')");
      /* Peek at the head: an LFS pointer is about 130 bytes of text. */
      const reader = r.body.getReader();
      const cancelReader = (): void => { void reader.cancel().catch(() => {}); };
      res.once('close', cancelReader);
      const setRawHeaders = (): void => {
        const headers = rawContentHeaders(p);
        res.setHeader('Content-Type', headers.contentType);
        res.setHeader('Content-Disposition', headers.contentDisposition);
      };
      try {
        const headChunks: Buffer[] = [];
        let total = 0, ended = false;
        while (total < 400) {
          const { value, done } = await reader.read();
          if (done) { ended = true; break; }
          headChunks.push(Buffer.from(value));
          total += value.length;
        }
        const headBuf = Buffer.concat(headChunks);
        const pointer = ended ? lfsPointer(headBuf.toString('utf8')) : null;
        if (pointer) {
          deps.assertProviderBoundLfs(account(req));
          setRawHeaders();
          /* It is a pointer: the real bytes come from LFS storage. */
          const stream = await deps.lfs.downloadStream(account(req), req.params.owner, req.params.repo, pointer.oid, parseInt(pointer.size, 10));
          res.setHeader('Content-Length', pointer.size);
          await pipeline(fromWebBody(stream), res);
          return;
        }
        setRawHeaders();
        async function* chunks(): AsyncGenerator<Buffer> {
          yield headBuf;
          if (ended) return;
          for (;;) {
            const { value, done } = await reader.read();
            if (done) return;
            yield Buffer.from(value);
          }
        }
        await pipeline(Readable.from(chunks()), res);
      } finally {
        res.removeListener('close', cancelReader);
        await reader.cancel().catch(() => {});
      }
    } catch (e) { fail(res, e); }
  });

  app.put('/api/repo/:owner/:repo/file', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('file.write'), auth, mutationContext('file.write'), async (req: Request, res: Response) => {
    try {
      if (req.body) {
        setBodyField(req, 'path', normalizeRepoPath(member(req.body, 'path')));
        setBodyField(req, 'branch', normalizeBranchName(member(req.body, 'branch')));
      }
      const p = bodyField(req, 'path');
      const content = bodyField(req, 'content');
      const message = bodyField(req, 'message');
      const branch = bodyField(req, 'branch');
      const expectedHeadSha = bodyField(req, 'expectedHeadSha');
      if (!p || content == null || !branch) { res.status(400).json({ error: 'path, content, branch required' }); return; }
      const blob = await gh(account(req), `${R(req)}/git/blobs`, {
        method: 'POST', body: { content: Buffer.from(String(content), 'utf8').toString('base64'), encoding: 'base64' }
      });
      const commit = await commits.commitTree(account(req), req.params.owner, req.params.repo, String(branch),
        message || `Update ${String(p)} via ${PRODUCT_NAME}`, [{ path: p, sha: member(blob, 'sha') }], expectedHeadSha);
      res.json({ ok: true, sha: member(blob, 'sha'), commit });
    } catch (e) { fail(res, e); }
  });

  app.delete('/api/repo/:owner/:repo/file', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('file.delete'), auth, mutationContext('file.delete'), async (req: Request, res: Response) => {
    try {
      if (req.body) {
        setBodyField(req, 'path', normalizeRepoPath(member(req.body, 'path')));
        setBodyField(req, 'branch', normalizeBranchName(member(req.body, 'branch')));
      }
      const p = bodyField(req, 'path');
      const message = bodyField(req, 'message');
      const branch = bodyField(req, 'branch');
      const sha = bodyField(req, 'sha');
      const expectedHeadSha = bodyField(req, 'expectedHeadSha');
      if (!p || !branch || !sha) { res.status(400).json({ error: 'path, branch, sha required' }); return; }
      const commit = await commits.commitTree(account(req), req.params.owner, req.params.repo, String(branch),
        message || `Delete ${String(p)} via ${PRODUCT_NAME}`, [{ path: p, sha: null }], expectedHeadSha);
      res.json({ ok: true, commit });
    } catch (e) { fail(res, e); }
  });

  /* A rename or move of any size: the blob is linked under its new path, never uploaded again. */
  app.post('/api/repo/:owner/:repo/rename', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('file.rename'), auth, mutationContext('file.rename'), async (req: Request, res: Response) => {
    try {
      const requestedFrom = bodyField(req, 'from');
      const requestedTo = bodyField(req, 'to');
      const requestedBranch = bodyField(req, 'branch');
      const message = bodyField(req, 'message');
      const expectedHeadSha = bodyField(req, 'expectedHeadSha');
      if (!requestedFrom || !requestedTo || !requestedBranch) { res.status(400).json({ error: 'from, to, branch required' }); return; }
      const from = normalizeRepoPath(requestedFrom, 'source path');
      const to = normalizeRepoPath(requestedTo, 'destination path');
      const branch = normalizeBranchName(requestedBranch);
      if (from === to) { res.status(400).json({ error: 'Destination equals source' }); return; }
      /*
       * The source is found in the tree of the head this request observed, and
       * that head is the one the commit must land on. A directory listing capped
       * at a thousand entries could not find a file past the thousandth, and a
       * lookup against one head followed by a commit against a newer one would
       * re-link content the branch had already moved past.
       */
      const ref = await gh(account(req), `${R(req)}/git/ref/heads/${encodeURIComponent(branch)}`);
      const observedHead = member(member(ref, 'object'), 'sha');
      assertExpectedHead(expectedHeadSha, observedHead);
      const head = await gh(account(req), `${R(req)}/git/commits/${String(observedHead)}`);
      const entry = await commits.gitTreeEntryByPath(account(req), req.params.owner, req.params.repo, member(member(head, 'tree'), 'sha'), from);
      if (!entry) { res.status(404).json({ error: 'Source file not found' }); return; }
      if (member(entry, 'type') === 'tree') { res.status(400).json({ error: `${from} is a folder. Use folder move to move it.`, code: 'SOURCE_IS_FOLDER' }); return; }
      const commit = await commits.commitTree(account(req), req.params.owner, req.params.repo, branch,
        message || `Rename ${from} → ${to} via ${PRODUCT_NAME}`, [
          { path: to, sha: member(entry, 'sha'), preserveFrom: from },
          { path: from, sha: null, preserveFrom: from }
        ], observedHead, { mustNotExist: [to] });
      res.json({ ok: true, commit });
    } catch (e) { fail(res, e); }
  });

  /* Many staged changes committed atomically. */
  app.post('/api/repo/:owner/:repo/batch', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('file.batch'), auth, mutationContext('file.batch'), async (req: Request, res: Response) => {
    try {
      const requestedBranch = bodyField(req, 'branch');
      const message = bodyField(req, 'message');
      const requestedOps = bodyField(req, 'ops');
      const requestedHead = bodyField(req, 'expectedHeadSha');
      if (!requestedBranch || !Array.isArray(requestedOps) || !requestedOps.length) { res.status(400).json({ error: 'branch and ops required' }); return; }
      const branch = normalizeBranchName(requestedBranch);
      const expectedHeadSha = requireAggregateExpectedHead(requestedHead);
      const normalizedBatch = normalizeFileBatch(requestedOps);
      const ops = normalizedBatch.items;
      const entries: Record<string, unknown>[] = [];
      for (const op of ops) {
        const itemPath = normalizeRepoPath(op.path);
        if (op.op === 'put' && op.sha) entries.push({ path: itemPath, mode: '100644', type: 'blob', sha: op.sha });
        else if (op.op === 'put') entries.push({ path: itemPath, mode: '100644', type: 'blob', content: String(op.content ?? '') });
        else entries.push({ path: itemPath, mode: '100644', type: 'blob', sha: null });
      }
      const commit = await commits.commitTree(account(req), req.params.owner, req.params.repo, branch,
        message || `Batch commit (${ops.length} changes) via ${PRODUCT_NAME}`, entries, expectedHeadSha);
      const execution = deps.executionSnapshot();
      res.json({
        ok: true, commit, count: ops.length, batchHash: normalizedBatch.batchHash, itemIds: normalizedBatch.itemIds,
        providerOperationIds: execution ? execution.operationIds : []
      });
    } catch (e) { fail(res, e); }
  });
}
