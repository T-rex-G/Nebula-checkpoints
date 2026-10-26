/*
 * A native Git push of one file: the branch's head read from GitHub's
 * receive-pack advertisement (and held to the head the caller's view had),
 * the trees on the file's path read through the API, the new blob, trees and
 * commit built and packed here, and the push sent as Git sends it. One push
 * at a time: each holds the whole file in memory, up to this deployment's
 * ceiling, and a second is refused rather than queued.
 */
import fsp from 'node:fs/promises';
import { PRODUCT_NAME, APP_VERSION } from '../../../platform/release/version.ts';
import type { ProviderWriteTarget } from '../../../platform/mutation-gateway/mutation-gateway.ts';
import { member, type Fields } from '../../../platform/values/fields.ts';
import { normalizeBranchName, normalizeRepoPath } from '../../corona/index.ts';
import { assertExpectedHead } from '../domain/head-checks.ts';
import { buildPushObjects, buildReceiveBody, packEncode, parseAdvert, parseReport, type TreeLevel } from '../domain/git-objects.ts';
import type { Gh } from './commit-writer.ts';
import type { GuardedFetch } from './lfs.ts';

export interface NativePushDeps {
  readonly gh: Gh;
  readonly fetch: GuardedFetch;
  /* The mutation gateway's check that this request may write to the provider by this transport. */
  assertProviderMutation(target: ProviderWriteTarget): unknown;
  /* Refuses an account that is not a GitHub.com account. */
  assertGithubAccount(account: unknown): unknown;
  /* The largest file this deployment pushes natively, in bytes and as the megabytes it names. */
  readonly maxBytes: number;
  readonly maxMegabytes: number;
}

export interface NativePush {
  push(account: Fields, owner: unknown, repo: unknown, branch: unknown, repoPath: unknown, tmp: string, message: unknown, expectedHeadSha?: unknown): Promise<{ commit: string }>;
}

/* `(t.tree || []).map(...)` and `.find(...)`, as JavaScript calls them on a provider's answer and names them when they fail. */
function treeOf(value: unknown, expression: string): readonly unknown[] {
  const list = value || [];
  if (!Array.isArray(list)) throw new TypeError(`${expression} is not a function`);
  return list;
}

export function createNativePush(deps: NativePushDeps): NativePush {
  let busy = false;

  async function treeLevels(account: Fields, owner: unknown, repo: unknown, oldSha: string, parts: readonly string[]): Promise<TreeLevel[]> {
    const levels: TreeLevel[] = [];
    const repository = `/repos/${String(owner)}/${String(repo)}`;
    const cm = await deps.gh(account, `${repository}/git/commits/${oldSha}`);
    let treeSha = member(member(cm, 'tree'), 'sha');
    for (let i = 0; i <= parts.length; i++) {
      if (treeSha) {
        const t = await deps.gh(account, `${repository}/git/trees/${String(treeSha)}`);
        const entries = treeOf(member(t, 'tree'), '(t.tree || []).map').map(e => ({
          mode: member(e, 'mode') === '040000' ? '40000' : member(e, 'mode'), name: member(e, 'path'), sha: member(e, 'sha')
        }));
        levels.push({ entries });
        if (i < parts.length) {
          const d = treeOf(member(t, 'tree'), '(t.tree || []).find').find(e => member(e, 'path') === parts[i] && member(e, 'type') === 'tree');
          treeSha = d ? member(d, 'sha') : null;
        }
      } else levels.push({ entries: [] });
    }
    return levels;
  }

  async function push(account: Fields, owner: unknown, repo: unknown, requestedBranch: unknown, requestedPath: unknown, tmp: string, message: unknown, expectedHeadSha: unknown = ''): Promise<{ commit: string }> {
    deps.assertProviderMutation({ provider: account.provider || 'github', baseUrl: account.baseUrl, method: 'POST', owner, repo, transport: 'git-receive-pack' });
    const branch = normalizeBranchName(requestedBranch);
    const p = normalizeRepoPath(requestedPath);
    if (busy) throw Object.assign(new Error('Another large native push is in flight — retry in a moment'), { status: 429 });
    busy = true;
    try {
      deps.assertGithubAccount(account);
      const authH = 'Basic ' + Buffer.from(`x-access-token:${String(account.token || account)}`).toString('base64');
      const gitBase = `https://github.com/${String(owner)}/${String(repo)}.git`;
      const ad = await deps.fetch(`${gitBase}/info/refs?service=git-receive-pack`, {
        headers: { Authorization: authH, 'User-Agent': `${PRODUCT_NAME}/${APP_VERSION}` }, redirect: 'error'
      }, 30000);
      if (!ad.ok) throw Object.assign(new Error(`git advertisement failed (${ad.status})`), { status: ad.status });
      const oldSha = parseAdvert(Buffer.from(await ad.arrayBuffer()), `refs/heads/${branch}`);
      if (!oldSha) throw new Error(`Branch ${branch} not found on the remote`);
      assertExpectedHead(expectedHeadSha, oldSha);
      const parts = p.split('/');
      parts.pop();
      const levels = await treeLevels(account, owner, repo, oldSha, parts);
      const stat = await fsp.stat(tmp);
      if (stat.size > deps.maxBytes) {
        throw Object.assign(new Error(`Native Git push is limited to ${deps.maxMegabytes} MB on this deployment; use Git LFS for larger GitHub files`), { status: 413 });
      }
      const fileBuf = await fsp.readFile(tmp);
      const who = account.login || 'nebulaverse';
      const { objs, commitSha } = buildPushObjects(fileBuf, p, levels, oldSha, message, who, `${String(who)}@users.noreply.github.com`);
      const body = buildReceiveBody(oldSha, commitSha, branch, packEncode(objs));
      const pr = await deps.fetch(`${gitBase}/git-receive-pack`, {
        method: 'POST',
        headers: {
          Authorization: authH, 'Content-Type': 'application/x-git-receive-pack-request',
          Accept: 'application/x-git-receive-pack-result', 'User-Agent': `${PRODUCT_NAME}/${APP_VERSION}`
        },
        body, redirect: 'error'
      }, 300000);
      const report = parseReport(Buffer.from(await pr.arrayBuffer()), branch);
      if (!pr.ok || !report.unpackOk || !report.okRef) {
        throw Object.assign(new Error('git push rejected: ' + (report.err || `HTTP ${pr.status}`)), { status: pr.status || 409 });
      }
      return { commit: commitSha };
    } finally { busy = false; }
  }

  return { push };
}
