/*
 * The alpha's privacy actions: disconnect the providers, disconnect and see
 * what to revoke by hand, end the alpha session, delete the alpha's data.
 *
 * None of them claims more than happened. A provider clean-up the server has
 * not finished leaves everything as it was, and says so; only a finished one
 * clears this browser and tells the other tabs. Revocation at the provider is
 * a separate act the reader takes, so the page offers its links -- GitHub's
 * own pages, over https -- and never says a credential was revoked. A
 * retired provider has no link: its step is said, never built from saved
 * configuration. Deleting the alpha's data is typed out in full first.
 */
import type { ModalRequest } from '../../components/modal.ts';
import type { RequestOptions } from '../../platform/transport.ts';
import { escapeAttribute, escapeHtml } from '../../platform/html.ts';
import { field, hasFields, items } from '../../platform/values.ts';

export const DELETE_PHRASE = 'DELETE ALPHA DATA';

/* What to revoke by hand: a link for each step that has one, the step said for each that has none. */
export function revocationGuidanceBody(guidance: unknown): string {
  const list = items(guidance).filter(hasFields);
  const text = (value: unknown): string => (value == null ? '' : String(value));
  const links = list
    .filter(item => /^https:\/\//i.test(text(item.url)))
    .map(item => `<a class="btn btn-ghost small" href="${escapeAttribute(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.label || 'Open provider settings')}</a>`)
    .join('');
  const steps = list.filter(item => item.label && !item.url).map(item => `<li>${escapeHtml(item.label)}</li>`).join('');
  return `<p class="hint">Nebulaverse-X removed its token-bearing provider state. Provider revocation is a separate action and is never claimed automatically.</p>
    ${steps ? `<ul class="hint revocation-steps">${steps}</ul>` : ''}
    <div class="about-actions">${links || (steps ? '' : '<span class="hint">No provider revocation link was returned.</span>')}</div>`;
}

const pending = (result: unknown): boolean => field(result, 'ok') === false && field(result, 'status') === 'pending';

export interface AlphaPrivacyDeps {
  readonly api: (path: string, options?: RequestOptions) => Promise<unknown>;
  readonly modal: (request: ModalRequest) => Promise<unknown>;
  readonly closeModal: (confirmed: boolean) => void;
  readonly toast: (message: string, kind?: string) => void;
  readonly presentError: (error: unknown) => void;
  readonly purgeLocalData: (full: boolean) => Promise<void>;
  readonly broadcastIdentityBoundary: () => void;
  /* The sign-in screen's alpha panels, put back for a reader who has left. */
  readonly restoreLoginChrome: () => void;
  readonly showSignIn: () => void;
  /* What was typed into the deletion's confirmation, read as the dialog closes. */
  readonly typedConfirmation: () => string;
  readonly attached: (node: unknown) => boolean;
}

export interface PrivacyButton {
  disabled: boolean;
  readonly dataset: { readonly alphaPrivacyAction?: string };
}

export interface AlphaPrivacy {
  /* After an account leaves: what to revoke by hand, when there is anything. */
  showRevocationGuidance(guidance: unknown): Promise<unknown> | null;
  disconnectProviders(openGuidance: boolean): Promise<void>;
  deleteData(): Promise<void>;
  endSession(): Promise<void>;
  /* A press inside the page: the alpha privacy control it landed in, if any, does its work. */
  onClick(target: { closest(selector: string): PrivacyButton | null } | null): Promise<void>;
}

export function createAlphaPrivacy(deps: AlphaPrivacyDeps): AlphaPrivacy {
  async function left(message: string): Promise<void> {
    await deps.purgeLocalData(true);
    deps.broadcastIdentityBoundary();
    deps.showSignIn();
    deps.toast(message, 'ok');
  }

  function showRevocationGuidance(guidance: unknown): Promise<unknown> | null {
    if (!Array.isArray(guidance) || !guidance.length) return null;
    return deps.modal({ title: 'Revoke at provider', okText: 'Done', bodyHTML: revocationGuidanceBody(guidance) });
  }

  async function disconnectProviders(openGuidance: boolean): Promise<void> {
    const result = await deps.api('/api/alpha/providers/disconnect-all', { method: 'POST', body: {} });
    if (pending(result)) {
      deps.toast('Provider cleanup is pending. Keep this session open and retry shortly.');
      return;
    }
    await deps.purgeLocalData(true);
    deps.broadcastIdentityBoundary();
    deps.restoreLoginChrome();
    deps.showSignIn();
    if (openGuidance) {
      await deps.modal({ title: 'Revoke at provider', okText: 'Done', bodyHTML: revocationGuidanceBody(field(result, 'revocationGuidance')) });
    } else {
      deps.toast('Disconnected from Nebulaverse-X. Provider credentials were not claimed as revoked.', 'ok');
    }
  }

  async function deleteData(): Promise<void> {
    const accepted = await deps.modal({
      title: 'Delete alpha data',
      okText: 'Delete alpha data',
      danger: true,
      bodyHTML: `<p class="hint">This fails closed until provider cleanup is verified. Type <span class="mono">${DELETE_PHRASE}</span> to continue.</p>
      <input id="alphaDeleteConfirm" type="text" autocomplete="off" spellcheck="false" autocapitalize="off" autocorrect="off" inputmode="text" aria-label="Deletion confirmation">`
    });
    if (!accepted) return;
    if (deps.typedConfirmation() !== DELETE_PHRASE) {
      deps.toast(`Type ${DELETE_PHRASE} exactly to confirm deletion.`, 'err');
      return;
    }
    const result = await deps.api('/api/alpha/delete', { method: 'POST', body: { confirm: DELETE_PHRASE } });
    if (pending(result)) {
      deps.toast('Alpha data deletion is pending provider cleanup. Keep this session open and retry shortly.');
      return;
    }
    await left('Alpha data deletion completed ✦');
  }

  async function endSession(): Promise<void> {
    await deps.api('/api/alpha/end', { method: 'POST', body: {} });
    await left('Alpha session ended ✦');
  }

  async function onClick(target: { closest(selector: string): PrivacyButton | null } | null): Promise<void> {
    const button = target ? target.closest('[data-alpha-privacy-action]') : null;
    if (!button || button.disabled) return;
    const action = button.dataset.alphaPrivacyAction;
    button.disabled = true;
    deps.closeModal(false);
    try {
      if (action === 'disconnect') await disconnectProviders(false);
      if (action === 'revoke') await disconnectProviders(true);
      if (action === 'end') await endSession();
      if (action === 'delete') await deleteData();
    } catch (error) {
      deps.presentError(error);
    } finally {
      if (deps.attached(button)) button.disabled = false;
    }
  }

  return { showRevocationGuidance, disconnectProviders, deleteData, endSession, onClick };
}
