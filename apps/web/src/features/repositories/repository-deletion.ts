/*
 * A repository deleted on the provider, from the workbench.
 *
 * The reader types the repository's full name, and the deletion goes through
 * a step-up: one sensitive action, verified once. The name is the one the
 * dialog was opened for; if the account or the repository open changed while
 * it was open, nothing is sent and the reader is asked to open it again.
 *
 * Once deleted, the repository is forgotten from the recently opened list, so
 * the picker never offers one that is gone, and the reader is taken to the
 * repositories -- unless another repository was opened meanwhile, which stays
 * where it is. A refusal for want of the provider's permission says how to
 * grant it.
 */
import { escapeHtml } from '../../platform/html.ts';
import { field } from '../../platform/values.ts';

export interface RepositoryDeletionDeps {
  readonly work: () => unknown;
  /* The account signed in, whose cache scope names it. */
  readonly me: () => unknown;
  readonly modal: (options: { title: string; bodyHTML: string; okText: string; danger?: boolean }) => Promise<unknown>;
  readonly value: (selector: string) => string | null;
  readonly toast: (message: unknown, kind?: string) => void;
  /* A sensitive action, verified once; resolves falsy when the reader turned the verification down. */
  readonly stepUp: (action: string, scope: unknown, path: string, options: { method: string; body: unknown }, label: string) => Promise<unknown>;
  readonly present: (error: unknown) => void;
  readonly forget: (owner: string, repo: string) => void;
  readonly showRepositories: () => void;
  readonly loadRepositories: () => unknown;
}

export const DELETE_PERMISSION = 'For OAuth, use Accounts \u2192 Allow repository deletion on GitHub. For a personal token, reconnect with repository deletion permission.';

const nameOf = (work: unknown): string => `${String(field(work, 'owner'))}/${String(field(work, 'repo'))}`;

export function createRepositoryDeletion(deps: RepositoryDeletionDeps): { remove(): Promise<void> } {
  async function remove(): Promise<void> {
    const work = deps.work();
    if (!work) return;
    const accountScope = field(deps.me(), 'offlineCacheScope');
    const owner = String(field(work, 'owner'));
    const repo = String(field(work, 'repo'));
    const fullName = `${owner}/${repo}`;
    const ok = await deps.modal({
      title: 'Delete repository',
      bodyHTML: `<p style="font-size:.9rem;line-height:1.6"><b>${escapeHtml(fullName)}</b> will be permanently deleted on GitHub \u2014 code, history, issues, releases. <b>This cannot be undone.</b></p>
      <label class="field-label" for="drName">Type <b class="mono">${escapeHtml(fullName)}</b> to confirm</label><input id="drName" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">`,
      okText: 'Delete forever', danger: true
    });
    if (!ok) return;
    if ((deps.value('#drName') ?? '').trim() !== fullName) { deps.toast('Name mismatch \u2014 aborted', 'err'); return; }
    const me = deps.me();
    if (!deps.work() || nameOf(deps.work()) !== fullName || !me || field(me, 'offlineCacheScope') !== accountScope) {
      deps.toast('Account or repository changed \u2014 reopen deletion confirmation.', 'err');
      return;
    }
    try {
      const deleted = await deps.stepUp('repository.delete', { owner, repo }, `/api/repo/${fullName}`, { method: 'DELETE', body: { confirmation: fullName } }, `Delete repository ${fullName}`);
      if (!deleted) return;
      deps.forget(owner, repo);
      deps.toast('Repository deleted', 'ok');
      if (deps.work() === work) deps.showRepositories();
      void deps.loadRepositories();
    } catch (error) {
      const message = field(error, 'message');
      if (typeof message === 'string' && /403|admin|delete_repo|forbidden/i.test(message) && !field(error, 'nextAction') && Object.isExtensible(error)) {
        (error as { nextAction?: string }).nextAction = DELETE_PERMISSION;
      }
      deps.present(error);
    }
  }
  return { remove };
}
