/*
 * The address and the workbench, kept in step.
 *
 * The address follows the workbench: a tab change is a step the reader can
 * take back, so it is pushed; anything else (a file opening, the branch
 * settling) replaces the current entry. While an address is being applied
 * nothing is pushed, or Back would walk into the step it just took -- and
 * applications are counted rather than flagged, so one ending does not
 * declare another, still on its way, ended, nor one that ended still going.
 *
 * Back, Forward, a pasted link or an edited address: the same repository
 * moves to the branch, tab and file it names; another repository opens; the
 * findings inbox takes its filters. An address that names nothing -- another
 * screen's, or one mangled in transit -- leaves the workbench as it was. And
 * nothing is applied before the session is known: start-up applies the
 * address itself once it can, after the capabilities that decide which tabs
 * may open have loaded.
 */
import type { Route } from '../../platform/router.ts';

/* The workbench as the address names it. */
export interface WorkbenchPlace {
  readonly owner: string;
  readonly repo: string;
  readonly branch: string;
}

/* The address of the workbench as it stands, or null when there is no workbench to name. */
export function workbenchRoute(page: string, work: { readonly owner?: unknown; readonly repo?: unknown; readonly branch?: unknown } | null, tab: string, file: string | null): Route | null {
  if (page !== 'work' || !work || !work.repo) return null;
  return { kind: 'workbench', owner: String(work.owner), repo: String(work.repo), branch: String(work.branch), tab, file: file || null };
}

/* Whether an address names the repository already open on the workbench: owners and names compared as GitHub does, without case. */
export function sameRepository(page: string, work: { readonly owner?: unknown; readonly repo?: unknown } | null, owner: string, repo: string): boolean {
  return page === 'work' && !!work && String(work.owner).toLowerCase() === owner.toLowerCase() && String(work.repo).toLowerCase() === repo.toLowerCase();
}

/* Whether a branch the address names is one to move to: named, not the current one, and one the repository has. */
export function branchToTake(named: string | null | undefined, current: unknown, offered: readonly string[]): named is string {
  return !!named && named !== current && offered.includes(named);
}

export interface RouteSyncDeps {
  readonly page: () => string;
  readonly work: () => { readonly owner?: unknown; readonly repo?: unknown; readonly branch?: unknown } | null;
  readonly tab: () => string;
  readonly file: () => string | null;
  readonly signedIn: () => boolean;
  readonly hash: () => string;
  readonly currentRoute: () => Route;
  readonly parseRoute: (hash: string) => Route;
  readonly formatRoute: (route: Route) => string;
  readonly writeRoute: (route: Route, options?: { push?: boolean }) => boolean;
  readonly findingsOffered: () => boolean;
  /* The inbox, with the filters an address's query names. */
  readonly showFindings: (query: string) => void;
  /* Open a repository: true opened, false refused, null when a later open took over. */
  readonly openRepo: (owner: string, repo: string) => Promise<boolean | null>;
  readonly branches: () => readonly string[];
  /* Move the open workbench to a branch, as the branch control would. */
  readonly selectBranch: (branch: string) => void;
  /* Set the branch of a repository just opened, before its files are read. */
  readonly startOnBranch: (branch: string) => void;
  readonly switchTab: (tab: string) => void;
  readonly openFile: (path: string) => unknown;
}

export interface RouteSync {
  /* The address follows the workbench; `push` for a step the reader can take back. */
  save(push?: boolean): void;
  /* The address changed under the page. */
  apply(): Promise<void>;
  /* Start-up: open what the address names. Whether it named something that opened. */
  restore(): Promise<boolean>;
  /* An address the page wrote itself, so it is not applied back. */
  wrote(route: Route): void;
}

export function createRouteSync(deps: RouteSyncDeps): RouteSync {
  /* How many addresses are being applied at once: start-up's own, and one the reader navigated to while it was on its way. */
  let applying = 0;
  let lastApplied = '';

  function save(push = false): void {
    const route = workbenchRoute(deps.page(), deps.work(), deps.tab(), deps.file());
    if (!route) return;
    /* Written or already there -- the router answers "unchanged" only when the address is this route -- it is the page's own. */
    deps.writeRoute(route, { push: push && applying === 0 });
    lastApplied = deps.formatRoute(route);
  }

  async function restore(): Promise<boolean> {
    const route = deps.currentRoute();
    if (route.kind === 'findings' && deps.findingsOffered()) {
      lastApplied = deps.hash();
      deps.showFindings(route.query);
      return true;
    }
    if (route.kind !== 'workbench') return false;
    lastApplied = deps.hash();
    applying += 1;
    try {
      const opened = await deps.openRepo(route.owner, route.repo);
      /* A later open took over: the address is being applied there, not failed here. */
      if (opened === null) return true;
      if (!opened) return false;
      const work = deps.work();
      if (branchToTake(route.branch, work ? work.branch : undefined, deps.branches())) deps.startOnBranch(route.branch);
      if (route.tab && route.tab !== 'editor') deps.switchTab(route.tab);
      if (route.file) deps.openFile(route.file);
      return true;
    } catch { return false; }
    finally { applying -= 1; }
  }

  async function apply(): Promise<void> {
    if (!deps.signedIn()) return;
    const hash = deps.hash();
    if (hash === lastApplied) return;
    const route = deps.parseRoute(hash);
    if (route.kind === 'findings') {
      lastApplied = hash;
      if (deps.findingsOffered()) deps.showFindings(route.query);
      return;
    }
    if (route.kind !== 'workbench') return;
    lastApplied = hash;
    applying += 1;
    try {
      if (!sameRepository(deps.page(), deps.work(), route.owner, route.repo)) { await restore(); return; }
      const work = deps.work();
      if (branchToTake(route.branch, work ? work.branch : undefined, deps.branches())) deps.selectBranch(route.branch);
      if (route.tab !== deps.tab()) deps.switchTab(route.tab);
      if (route.file && deps.file() !== route.file) await deps.openFile(route.file);
    } catch { /* a stale or foreign address leaves the workbench as it was */ }
    finally { applying -= 1; }
  }

  return { save, apply, restore, wrote: route => { lastApplied = deps.formatRoute(route); } };
}
