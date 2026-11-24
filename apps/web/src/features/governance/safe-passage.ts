/*
 * Safe Passage, as the page offers it.
 *
 * A write refused because it needs approval comes back with the route to
 * approval attached: a branch derived from the change, and a pull request
 * into the branch that refused it. The server has already checked that
 * policy permits every step, so taking the route uses the ordinary governed
 * endpoints -- there is no separate privileged path to take, which is the
 * point.
 *
 * It is offered, never taken without the reader, and the content sent is
 * exactly the content that was refused, to the repository that refused it.
 * The branch already existing is the shape of a second attempt at the same
 * change, not a failure: GitHub answers it 422, and the name was checked
 * before it was sent, so nothing else answers 422 there.
 */
import type { ModalRequest } from '../../components/modal.ts';
import type { RequestOptions } from '../../platform/transport.ts';
import { escapeHtml } from '../../platform/html.ts';
import { field, hasFields } from '../../platform/values.ts';

/* The route a refusal offers, as the server sends it. */
export interface SafePassageOffer {
  readonly path: string;
  readonly branch: string;
  readonly baseBranch: string;
}

/* The change that was refused: the same bytes go to the new branch. */
export interface RefusedChange {
  readonly content: string;
  readonly message?: unknown;
  readonly sha?: unknown;
}

/* The offer an error carries, when it carries one the reader can take. */
export function offerOf(error: unknown): SafePassageOffer | null {
  const offer = field(error, 'safePassage');
  if (!hasFields(offer) || offer.available !== true) return null;
  const text = (value: unknown): string => (value == null ? '' : String(value));
  return { path: text(offer.path), branch: text(offer.branch), baseBranch: text(offer.baseBranch) };
}

/* What the reader is asked: why the change was held, and the three steps of the route. */
export function offerBody(offer: SafePassageOffer): string {
  return `<p class="sp-lead">Writing <b class="mono">${escapeHtml(offer.path)}</b> to
        <b class="mono">${escapeHtml(offer.baseBranch)}</b> needs approval under the active policy, so it was not committed.</p>
      <p class="sp-lead">Your change can go to a branch of its own and open a pull request for review instead. Nothing is
        changed on <b class="mono">${escapeHtml(offer.baseBranch)}</b> until someone approves it.</p>
      <ul class="sp-route">
        <li><span class="sp-step">Branch</span><span class="mono">${escapeHtml(offer.branch)}</span></li>
        <li><span class="sp-step">Commit</span><span class="mono">${escapeHtml(offer.path)}</span></li>
        <li><span class="sp-step">Pull request</span><span class="mono">${escapeHtml(offer.branch)} → ${escapeHtml(offer.baseBranch)}</span></li>
      </ul>
      <p class="hint">The content sent is exactly what you tried to commit.</p>`;
}

/* The pull request's description: why it exists. */
export function pullBody(offer: SafePassageOffer): string {
  return `Opened by Safe Passage. Writing \`${offer.path}\` to \`${offer.baseBranch}\` requires approval under the active policy, so the change is proposed here for review instead.`;
}

/* Said when the reader opened another repository while the offer was on screen. */
export const MOVED_ON = 'Another repository is open now, so the change was not sent for review.';

export interface SafePassageDeps {
  readonly modal: (request: ModalRequest) => Promise<boolean>;
  readonly api: (path: string, opts?: RequestOptions) => Promise<unknown>;
  readonly toast: (message: string, kind?: 'ok' | 'err' | '') => unknown;
  readonly presentError: (error: unknown) => unknown;
  /* The open repository's path in the API, or null when none is open. */
  readonly repository: () => string | null;
}

/*
 * What taking the route came to: false when it was not offered or not taken,
 * true when it was taken and a step failed (the failure is already shown),
 * or what was written and the pull request opened.
 */
export type SafePassageOutcome = false | true | { readonly written: unknown; readonly pull: unknown };

export function createSafePassage(deps: SafePassageDeps): (error: unknown, change: RefusedChange | null | undefined) => Promise<SafePassageOutcome> {
  return async (error, change) => {
    const offer = offerOf(error);
    if (!offer || !change || typeof change.content !== 'string') return false;
    const repository = deps.repository();
    if (!repository) return false;
    const accepted = await deps.modal({ title: 'This change needs approval', okText: 'Send for review', bodyHTML: offerBody(offer) });
    if (!accepted) return false;
    /* The route is the refused repository's: one opened while the dialog was up is not sent the change. */
    if (deps.repository() !== repository) {
      deps.toast(MOVED_ON, 'err');
      return true;
    }
    const message = String(change.message || '').trim() || `Update ${offer.path}`;
    try {
      await deps.api(`/api/repo/${repository}/branches`, { method: 'POST', body: { name: offer.branch, from: offer.baseBranch } });
    } catch (branchError) {
      if (field(branchError, 'status') !== 422) {
        deps.presentError(branchError);
        return true;
      }
    }
    try {
      const written = await deps.api(`/api/repo/${repository}/file`, {
        method: 'PUT',
        body: { path: offer.path, content: change.content, message, branch: offer.branch, sha: change.sha }
      });
      const pull = await deps.api(`/api/repo/${repository}/pulls`, {
        method: 'POST',
        body: { title: message, head: offer.branch, base: offer.baseBranch, body: pullBody(offer) }
      });
      const number = field(pull, 'number');
      deps.toast(number ? `Opened pull request #${String(number)} ✦` : 'Sent for review ✦', 'ok');
      return { written, pull };
    } catch (routeError) {
      deps.presentError(routeError);
      return true;
    }
  };
}
