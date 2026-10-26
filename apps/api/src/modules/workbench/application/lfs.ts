/*
 * Git LFS storage for a GitHub repository: the batch API negotiates where an
 * object lives, and its bytes are fetched from there. The negotiation names
 * the account's own credentials; the storage address it answers with must be
 * HTTPS and carry no credentials of its own, and no redirect is followed.
 */
import { PRODUCT_NAME, APP_VERSION } from '../../../platform/release/version.ts';
import { member, type Fields } from '../../../platform/values/fields.ts';

/* The guarded transport, as the server reaches the network. */
export type GuardedFetch = (url: unknown, init: Readonly<Record<string, unknown>>, timeoutMs?: number) => Promise<globalThis.Response>;

export interface LfsDeps {
  readonly fetch: GuardedFetch;
  /* Refuses an account whose provider and deployment are not qualified for LFS. */
  assertProviderBoundLfs(account: Fields): unknown;
  /* How long a transfer from storage may take. */
  readonly transferTimeoutMs: number;
}

export interface LfsTransfer {
  downloadStream(account: Fields, owner: unknown, repo: unknown, oid: string, size: number): Promise<unknown>;
}

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
  return { downloadStream };
}
