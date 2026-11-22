/*
 * A repository opened into the workbench.
 *
 * Nothing opens for nobody, and a start-up on its way is waited for. The
 * last repository's views are let go of before the first await, so no
 * section is drawn with its findings under the new one's name and every
 * request still on its way for it lands on a view that is no longer its own.
 * The header names the repository as typed at once, and as the provider
 * spells it once it answers, so a pasted "Owner/Repo" and a listed
 * "owner/repo" are one repository everywhere a key is made of it. Somebody
 * else's repository opens read-only. The answer is checked before anything is
 * marked open: one without its branches used to mark the repository open,
 * then throw the script's own error and go back to the list with the
 * workbench still holding it. An open that fails goes back to the list with
 * focus on what the reader pressed; an open overtaken by another, or let go
 * of with the account, leaves the workbench to whoever owns it.
 */
import { field } from '../../platform/values.ts';
import { LOADING_SUMMARY, UNAVAILABLE_SUMMARY, trustSummary } from './repository-trust.ts';
import type { Reading, TrustSummary } from './repository-trust.ts';
import { rememberRepository, repositoryVisitor } from './recent-repositories.ts';
import type { RecentStorage } from './recent-repositories.ts';

export interface OpenerState {
  readonly me: unknown;
  work: unknown;
  opening: unknown;
}

export interface Focusable { readonly isConnected: boolean; focus(options: { preventScroll: boolean }): void }

export interface OpenerDeps {
  readonly state: OpenerState;
  readonly api: (path: string) => Promise<unknown>;
  /* A start-up on its way, waited for before anything opens. */
  readonly arriving: () => Promise<unknown> | null;
  /* What the reader pressed to get here: the workbench hides it while the repository loads. */
  readonly pressed: () => Focusable | null;
  readonly showPage: (name: string) => unknown;
  /* Everything on screen that belongs to one repository, let go of together. */
  readonly resetViews: () => void;
  /* The workbench emptied for the repository about to open: its tree, file, staged changes and lists. */
  readonly emptyWorkbench: () => void;
  /* The header's name, as typed or as spelled, and the badges and read-only mark it carries. */
  readonly name: (owner: string, repo: string) => void;
  readonly badges: (privateRepo: boolean, visitor: boolean) => void;
  readonly readOnly: (visitor: boolean) => void;
  readonly branches: (names: readonly unknown[], defaultBranch: unknown) => void;
  /* What follows an open: the shield, the editor, the tree, the rate and the address. */
  readonly arrive: () => void;
  readonly drawTrust: (summary: TrustSummary) => void;
  readonly presentError: (error: unknown) => void;
  /* The star changed in place on the repository it was read for, through the page's store. */
  readonly star: (work: unknown, starred: unknown) => void;
  readonly storage: () => RecentStorage;
}

export interface RepositoryOpener {
  /* True when this repository is open at the end, false when it could not be opened, null when another was opened meanwhile. */
  open(owner: string, repo: string): Promise<boolean | null>;
  /* The account is leaving: a repository still opening for it never finishes opening. */
  forget(): void;
  /* The trust summary read for the repository open, and drawn only while it is. */
  loadTrust(): Promise<void>;
  /* Which open is the latest: a caller waiting on one compares before acting. */
  generation(): number;
}

/* `value[name]` as JavaScript reads it, throwing for null or undefined as the expression did. */
const prop = (value: unknown, name: string): unknown => (value as Record<string, unknown>)[name];
const path = (work: unknown): string => `${String(field(work, 'owner'))}/${String(field(work, 'repo'))}`;

export function createRepositoryOpener(deps: OpenerDeps): RepositoryOpener {
  const { state } = deps;
  let request = 0;

  async function loadTrust(): Promise<void> {
    const key = path(state.work);
    deps.drawTrust(LOADING_SUMMARY);
    const readings = await Promise.allSettled([
      deps.api(`/api/repo/${key}/live-events/status`),
      deps.api(`/api/repo/${key}/access-surface`),
      deps.api(`/api/repo/${key}/evidence`)
    ]) as [Reading, Reading, Reading];
    if (!state.work || path(state.work) !== key) return;
    deps.drawTrust(trustSummary(...readings));
  }

  function forget(): void {
    request += 1;
    state.opening = null;
  }

  async function open(owner: string, repo: string): Promise<boolean | null> {
    const arriving = deps.arriving();
    if (arriving) await arriving;
    if (!state.me) return false;
    const asked = ++request;
    const opener = deps.pressed();
    void deps.showPage('work');
    /* No repository is open until this one answers: nothing may act on the last one meanwhile. */
    state.work = null;
    deps.resetViews();
    deps.name(owner, repo);
    deps.badges(false, false);
    deps.emptyWorkbench();
    const opened = (async (): Promise<{ info?: unknown; error?: unknown }> => {
      try { return { info: await deps.api(`/api/repo/${owner}/${repo}`) }; }
      catch (error) { return { error }; }
    })();
    state.opening = opened;
    const answer = await opened;
    if (state.opening === opened) state.opening = null;
    /* Another repository was chosen while this one loaded: that one owns the workbench. */
    if (asked !== request) return null;
    try {
      if ('error' in answer) throw answer.error;
      const info = answer.info;
      const branchList = field(info, 'branches');
      if (!Array.isArray(branchList) || !branchList.every(branch => branch && typeof branch === 'object')) throw new Error('The repository answered without its branches, so it was not opened.');
      /* The provider's spelling of the name, when it names this repository. */
      const canonical = String(field(info, 'full_name') || '').split('/');
      if (canonical.length >= 2 && canonical.join('/').toLowerCase() === `${owner}/${repo}`.toLowerCase()) {
        owner = canonical.slice(0, -1).join('/');
        repo = canonical[canonical.length - 1] || repo;
        deps.name(owner, repo);
      }
      const visitor = repositoryVisitor(field(info, 'permission'));
      state.work = { owner, repo, branch: field(info, 'default_branch'), ...(info as object), visitor };
      const work = state.work;
      deps.badges(!!field(info, 'private'), visitor);
      deps.readOnly(visitor);
      deps.branches(branchList.map(branch => field(branch, 'name')), field(info, 'default_branch'));
      deps.arrive();
      loadTrust().catch(error => {
        deps.drawTrust(UNAVAILABLE_SUMMARY);
        deps.presentError(error);
      });
      deps.api(`/api/repo/${owner}/${repo}/star`).then(answered => { if (state.work === work) deps.star(work, prop(answered, 'starred')); }).catch(() => {});
      rememberRepository(deps.storage, owner, repo, visitor);
      return true;
    } catch (error) {
      /*
       * The list comes back before the error is shown, and focus with it to
       * what the reader pressed. The workbench had hidden that control, so the
       * dialog -- which gives focus back to whatever held it when it opened --
       * gave it to nothing, and a keyboard reader who dismissed it started
       * again from the top of the page.
       */
      await deps.showPage('repos');
      if (asked !== request) return null;
      if (opener && opener.isConnected) opener.focus({ preventScroll: true });
      deps.presentError(error);
      return false;
    }
  }

  return { open, forget, loadTrust, generation: () => request };
}
