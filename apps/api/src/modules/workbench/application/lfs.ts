/*
 * Git LFS storage for a GitHub repository: the batch API negotiates where an
 * object lives, its bytes are fetched from there or sent there, and an upload
 * is verified when storage asks for it. The negotiation names the account's
 * own credentials; every storage address it answers with must be HTTPS and
 * carry no credentials of its own, a header it hands back replaces ours of the
 * same name, and no redirect is followed. An upload
 * commits the pointer in the object's place, and the path's LFS attribute
 * when .gitattributes does not already name it.
 */
import fs from 'node:fs';
import { PRODUCT_NAME, APP_VERSION } from '../../../platform/release/version.ts';
import type { ProviderWriteTarget } from '../../../platform/mutation-gateway/mutation-gateway.ts';
import { member, type Fields } from '../../../platform/values/fields.ts';
import { lfsAttributePattern } from '../../corona/index.ts';
import type { CommitWriter, Gh } from './commit-writer.ts';

/* The guarded transport, as the server reaches the network. */
export type GuardedFetch = (url: unknown, init: Readonly<Record<string, unknown>>, timeoutMs?: number) => Promise<globalThis.Response>;

export interface LfsDeps {
  readonly fetch: GuardedFetch;
  readonly gh: Gh;
  readonly commits: Pick<CommitWriter, 'commitTree'>;
  /* Refuses an account whose provider and deployment are not qualified for LFS. */
  assertProviderBoundLfs(account: Fields): unknown;
  /* The mutation gateway's check that this request may write to the provider by this transport. */
  assertProviderMutation(target: ProviderWriteTarget): unknown;
  /* How long a transfer to or from storage may take. */
  readonly transferTimeoutMs: number;
}

export interface LfsTransfer {
  downloadStream(account: Fields, owner: unknown, repo: unknown, oid: string, size: number): Promise<unknown>;
  upload(account: Fields, owner: unknown, repo: unknown, branch: string, repoPath: string, tmp: string, oid: string, size: number, message: unknown, expectedHeadSha?: unknown): Promise<{ commit: unknown; oid: string }>;
}

/* `Buffer.from(value, 'base64')`, called as JavaScript calls it on a provider's field. */
function fromBase64(value: unknown): Buffer {
  const decoded: unknown = Reflect.apply(Buffer.from, Buffer, [value, 'base64']);
  if (!Buffer.isBuffer(decoded)) throw new TypeError('Buffer.from did not answer a Buffer');
  return decoded;
}
/* `{ ...value }` of a field a provider answered with: an object's own fields, nothing for anything else. */
function spread(value: unknown): Record<string, unknown> {
  return { ...Object(value) };
}
/*
 * Request headers, each set's over the one before. A name replaces the same
 * name in any case, so a header storage hands back is sent once, as it said,
 * rather than joined to ours of the same name.
 */
function headersOf(...sets: unknown[]): Record<string, string> {
  const merged = new Map<string, readonly [string, string]>();
  for (const set of sets) {
    for (const [name, value] of Object.entries(spread(set))) merged.set(name.toLowerCase(), [name, String(value)]);
  }
  return Object.fromEntries(merged.values());
}
const named = (headers: Readonly<Record<string, string>>, name: string): boolean => Object.keys(headers).some(key => key.toLowerCase() === name);

export function requireHttpsLfsActionUrl(raw: unknown, action: string): URL {
  let target: URL;
  try { target = new URL(String(raw || '')); }
  catch { throw Object.assign(new Error(`LFS ${action} URL is invalid`), { status: 502 }); }
  if (target.protocol !== 'https:' || target.username || target.password) {
    throw Object.assign(new Error(`LFS ${action} URL must use HTTPS without embedded credentials`), { status: 502 });
  }
  return target;
}

export function createLfsTransfer(deps: LfsDeps): LfsTransfer {
  async function downloadStream(account: Fields, owner: unknown, repo: unknown, oid: string, size: number): Promise<unknown> {
    deps.assertProviderBoundLfs(account);
    const basic = Buffer.from(`${String(account.login)}:${String(account.token)}`).toString('base64');
    const batchRes = await deps.fetch(`https://github.com/${String(owner)}/${String(repo)}.git/info/lfs/objects/batch`, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.git-lfs+json', 'Content-Type': 'application/vnd.git-lfs+json',
        Authorization: `Basic ${basic}`, 'User-Agent': `${PRODUCT_NAME}/${APP_VERSION}`
      },
      body: JSON.stringify({ operation: 'download', transfers: ['basic'], objects: [{ oid, size }] }),
      redirect: 'error'
    });
    if (!batchRes.ok) throw Object.assign(new Error('LFS download negotiation failed'), { status: 502 });
    const batch: unknown = await batchRes.json();
    const objects = member(batch, 'objects');
    const obj = objects && member(objects, '0');
    const actions = obj && member(obj, 'actions');
    const act = actions && member(actions, 'download');
    if (!act) throw Object.assign(new Error('LFS object not found in storage'), { status: 404 });
    const downloadUrl = requireHttpsLfsActionUrl(member(act, 'href'), 'download');
    const dl = await deps.fetch(downloadUrl, { headers: member(act, 'header') || {}, redirect: 'error' }, deps.transferTimeoutMs);
    if (!dl.ok) throw Object.assign(new Error(`LFS storage fetch failed (${dl.status})`), { status: 502 });
    return dl.body;
  }

  async function upload(account: Fields, owner: unknown, repo: unknown, branch: string, repoPath: string, tmp: string, oid: string, size: number, message: unknown, expectedHeadSha: unknown = ''): Promise<{ commit: unknown; oid: string }> {
    deps.assertProviderBoundLfs(account);
    deps.assertProviderMutation({ provider: account.provider || 'github', baseUrl: account.baseUrl, method: 'POST', owner, repo, transport: 'git-lfs.batch' });
    const { token, login } = account;
    const basic = Buffer.from(`${String(login)}:${String(token)}`).toString('base64');
    const batchRes = await deps.fetch(`https://github.com/${String(owner)}/${String(repo)}.git/info/lfs/objects/batch`, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.git-lfs+json', 'Content-Type': 'application/vnd.git-lfs+json',
        Authorization: `Basic ${basic}`, 'User-Agent': `${PRODUCT_NAME}/${APP_VERSION}`
      },
      body: JSON.stringify({ operation: 'upload', transfers: ['basic'], ref: { name: `refs/heads/${branch}` }, objects: [{ oid, size }] }),
      redirect: 'error'
    });
    if (!batchRes.ok) {
      const t = await batchRes.text();
      throw Object.assign(new Error(`LFS batch failed (${batchRes.status}): ${t.slice(0, 300)}`), { status: 502 });
    }
    const batch: unknown = await batchRes.json();
    const objects = member(batch, 'objects');
    const obj = objects && member(objects, '0');
    if (obj && member(obj, 'error')) throw Object.assign(new Error(`LFS: ${String(member(member(obj, 'error'), 'message'))}`), { status: 502 });
    const actions = obj && member(obj, 'actions');
    const uploadAction = actions && member(actions, 'upload');
    if (uploadAction) {
      const uploadUrl = requireHttpsLfsActionUrl(member(uploadAction, 'href'), 'upload');
      deps.assertProviderMutation({ provider: account.provider || 'github', baseUrl: account.baseUrl, method: 'PUT', owner, repo, transport: 'git-lfs.upload' });
      const up = await deps.fetch(uploadUrl, {
        method: 'PUT',
        headers: headersOf({ 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) }, member(uploadAction, 'header')),
        body: fs.createReadStream(tmp), duplex: 'half', redirect: 'error'
      }, deps.transferTimeoutMs);
      if (!up.ok) {
        const t = await up.text();
        throw Object.assign(new Error(`LFS upload failed (${up.status}): ${t.slice(0, 300)}`), { status: 502 });
      }
      const verify = member(member(obj, 'actions'), 'verify');
      if (verify) {
        const verifyUrl = requireHttpsLfsActionUrl(member(verify, 'href'), 'verification');
        const verifyHeaders = headersOf({ Accept: 'application/vnd.git-lfs+json', 'Content-Type': 'application/vnd.git-lfs+json' }, member(verify, 'header'));
        /* The account's credentials go to GitHub's own host alone, and only when the verification brings none of its own. */
        if (verifyUrl.hostname === 'github.com' && !named(verifyHeaders, 'authorization')) {
          verifyHeaders.Authorization = `Basic ${basic}`;
        }
        deps.assertProviderMutation({ provider: account.provider || 'github', baseUrl: account.baseUrl, method: 'POST', owner, repo, transport: 'git-lfs.verify' });
        const verified = await deps.fetch(verifyUrl, {
          method: 'POST', headers: verifyHeaders, body: JSON.stringify({ oid, size }), redirect: 'error'
        });
        if (!verified.ok) {
          const text = await verified.text();
          throw Object.assign(new Error(`LFS verification failed (${verified.status}): ${text.slice(0, 300)}`), { status: 502 });
        }
      }
    }
    const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${size}\n`;
    const pattern = lfsAttributePattern(repoPath);
    const attrLine = `${pattern} filter=lfs diff=lfs merge=lfs -text`;
    let attrs = '';
    try {
      /* The attributes are read and the commit made with the account's token, as the API is reached for it. */
      const meta = await deps.gh(token, `/repos/${String(owner)}/${String(repo)}/contents/.gitattributes?ref=${encodeURIComponent(branch)}`);
      if (member(meta, 'content')) attrs = fromBase64(member(meta, 'content')).toString('utf8');
    } catch (e) { if (member(e, 'status') !== 404) throw e; }
    const entries: Record<string, unknown>[] = [{ path: repoPath, mode: '100644', type: 'blob', content: pointer }];
    if (!attrs.split('\n').some(l => l.trim().startsWith(pattern + ' '))) {
      const newAttrs = attrs ? attrs.replace(/\n?$/, '\n') + attrLine + '\n' : attrLine + '\n';
      entries.push({ path: '.gitattributes', mode: '100644', type: 'blob', content: newAttrs });
    }
    const commit = await deps.commits.commitTree(token, owner, repo, branch, message, entries, expectedHeadSha);
    return { commit, oid };
  }

  return { downloadStream, upload };
}
