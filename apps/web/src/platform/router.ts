/*
 * The page's addresses (ADR-092).
 *
 * Two screens have an address, and every address the page has ever written
 * still opens the same thing, byte for byte:
 *
 *   #/owner/repo@branch/tab           the workbench, on a branch and a tab
 *   #/owner/repo@branch/tab/path      ... with a file open
 *   #/findings?filters                the findings inbox and its filters
 *
 * Each component of a workbench address is percent-encoded with
 * encodeURIComponent, so a branch named `feature/x` or a file under
 * `docs/` stays one component; a tab is lowercase letters. Every other
 * screen has no address. This is the one place an address is read or
 * written: the workbench, the inbox and the history all go through it, so
 * the two directions cannot disagree.
 */

export interface WorkbenchRoute {
  readonly kind: 'workbench';
  readonly owner: string;
  readonly repo: string;
  readonly branch: string;
  readonly tab: string;
  /* The file open in the editor, or null. */
  readonly file: string | null;
}

export interface FindingsRoute {
  readonly kind: 'findings';
  /* The filters as the address carries them: empty, or starting with "?". */
  readonly query: string;
}

export interface NoRoute {
  readonly kind: 'none';
}

export type Route = WorkbenchRoute | FindingsRoute | NoRoute;

export const NO_ROUTE: NoRoute = Object.freeze({ kind: 'none' });

const WORKBENCH = /^#\/([^/]+)\/([^/@]+)@([^/]+)\/([a-z]+)(?:\/(.+))?$/;
const FINDINGS = /^#\/findings(\?.*)?$/;

/*
 * What an address names. One that is neither screen's, or whose components
 * are not valid percent-encoding (a link mangled in transit), names nothing:
 * the page stays where it is rather than opening a guess.
 */
export function parseRoute(hash: string): Route {
  const findings = FINDINGS.exec(hash);
  if (findings) return Object.freeze({ kind: 'findings', query: findings[1] || '' });
  const work = WORKBENCH.exec(hash);
  if (!work) return NO_ROUTE;
  try {
    return Object.freeze({
      kind: 'workbench',
      owner: decodeURIComponent(work[1] || ''),
      repo: decodeURIComponent(work[2] || ''),
      branch: decodeURIComponent(work[3] || ''),
      tab: work[4] || '',
      file: work[5] ? decodeURIComponent(work[5]) : null
    });
  } catch {
    return NO_ROUTE;
  }
}

/* The address of a route: the exact bytes the page writes for it. */
export function formatRoute(route: Route): string {
  switch (route.kind) {
    case 'workbench':
      return `#/${encodeURIComponent(route.owner)}/${encodeURIComponent(route.repo)}` +
        `@${encodeURIComponent(route.branch)}/${route.tab}` +
        (route.file ? `/${encodeURIComponent(route.file)}` : '');
    case 'findings':
      return `#/findings${route.query}`;
    case 'none':
      return '';
  }
}

/* The route the address bar holds now. */
export function currentRoute(): Route {
  return parseRoute(window.location.hash);
}

/*
 * Puts a route in the address bar: a new history entry when `push` (a step
 * the reader can take back), otherwise in place of the current one. The
 * path and query are kept as they are. The whole address is compared, not
 * only the fragment, so a screen with no address also clears a bare "#"
 * left behind (the fragment reads as empty either way). Answers whether the
 * address changed.
 */
export function writeRoute(route: Route, { push = false }: { push?: boolean } = {}): boolean {
  const url = `${window.location.pathname}${window.location.search}${formatRoute(route)}`;
  if (window.location.href === `${window.location.origin}${url}`) return false;
  if (push) window.history.pushState(null, '', url);
  else window.history.replaceState(null, '', url);
  return true;
}

/* Back, Forward, a pasted link or an edited address. Answers the way to stop listening. */
export function onRouteChange(listener: (route: Route) => void): () => void {
  const changed = (): void => { listener(currentRoute()); };
  window.addEventListener('popstate', changed);
  window.addEventListener('hashchange', changed);
  return () => {
    window.removeEventListener('popstate', changed);
    window.removeEventListener('hashchange', changed);
  };
}
