/*
 * The GitHub App's part of Settings, at work: its status read, drawn, and
 * read again; a connection started, refreshed or let go; and the reader told
 * what GitHub answered when it sends them back.
 *
 * A disconnect the server has not finished -- the provider's own clean-up
 * still pending -- leaves the installation connected, so the page keeps
 * everything it holds and says so, as every other disconnect does. Only a
 * finished disconnect clears this browser and tells the other tabs.
 */
import type { RequestOptions } from '../../platform/transport.ts';
import { field } from '../../platform/values.ts';
import { ACTION_LABELS, addressFrom, callbackNotice, githubAppBody, isAction, isGithubUrl, type SignedIn } from './github-app.ts';

export interface ActionButton {
  disabled: boolean;
  textContent: string | null;
  readonly dataset: { readonly githubAppAction?: string; readonly connectionKey?: string; readonly installationId?: string };
}

/* Where a press landed: an element, asked for the nearest control around it. */
export interface PressTarget {
  closest(selector: string): ActionButton | null;
}

export interface GithubAppDeps {
  readonly api: (path: string, options?: RequestOptions) => Promise<unknown>;
  readonly toast: (message: string, kind?: string) => void;
  readonly presentError: (error: unknown) => void;
  readonly confirm: (question: string) => boolean;
  /* Whether this deployment offers the App, as its configuration said. */
  readonly configured: () => boolean;
  readonly me: () => SignedIn | null;
  /* Where the section is drawn, while Settings is open. */
  readonly body: () => { innerHTML: string } | null;
  readonly formatDate: (date: Date) => string;
  readonly navigate: (url: string) => void;
  readonly attached: (node: unknown) => boolean;
  readonly purgeLocalData: (full: boolean) => Promise<void>;
  readonly broadcastIdentityBoundary: () => void;
  /* The last account left the session. */
  readonly signedOut: () => void;
  /* Another account of the session is the one in use now. */
  readonly identityChanged: () => Promise<void>;
  readonly address: () => { readonly pathname: string; readonly search: string; readonly hash: string };
  readonly replaceAddress: (url: string) => void;
}

export interface GithubApp {
  /* The status, as the server tells it; a failure read is shown as one, never thrown. */
  status(): Promise<unknown>;
  /* Draw the status into Settings once it arrives, unless `stillOpen` says that Settings is gone or a later read has begun. */
  show(stillOpen: () => boolean): Promise<void>;
  /* Read the status again where Settings shows it. */
  reload(): Promise<void>;
  /* A press inside the page: the GitHub App control it landed in, if any, does its work. */
  onClick(target: PressTarget | null): Promise<void>;
  /* What GitHub answered, when it has just sent the reader back. */
  notice(): void;
}

const DISCONNECT_QUESTION = 'Disconnect this GitHub App installation from Nebulaverse-X? This does not uninstall it from GitHub.';
const SKELETON = '<div class="skeleton" style="height:72px"></div>';

export function createGithubApp(deps: GithubAppDeps): GithubApp {
  /* Each read is numbered: only the latest draws, so an earlier answer arriving late cannot replace a newer one. */
  let reads = 0;

  async function status(): Promise<unknown> {
    if (!deps.me()) return { enabled: deps.configured(), webhookConfigured: false, connections: [] };
    try {
      return await deps.api('/api/github-app/status');
    } catch (error) {
      return { enabled: deps.configured(), webhookConfigured: false, connections: [], error: String(field(error, 'message') ?? error) };
    }
  }

  const draw = (body: { innerHTML: string }, read: unknown): void => { body.innerHTML = githubAppBody(read, deps.me(), deps.formatDate); };

  async function show(stillOpen: () => boolean): Promise<void> {
    const read = ++reads;
    const answer = await status();
    const body = deps.body();
    if (read === reads && stillOpen() && body) draw(body, answer);
  }

  async function reload(): Promise<void> {
    const body = deps.body();
    if (!body) return;
    const read = ++reads;
    body.innerHTML = SKELETON;
    const answer = await status();
    if (read === reads) draw(body, answer);
  }

  async function connect(): Promise<boolean> {
    const result = await deps.api('/api/github-app/connect', { method: 'POST', body: {} });
    const url = field(result, 'url');
    if (!isGithubUrl(url)) throw new Error('GitHub returned an invalid authorization destination');
    deps.navigate(url);
    return true;
  }

  async function disconnect(body: object): Promise<void> {
    const result = await deps.api('/api/github-app/disconnect', { method: 'POST', body });
    if (field(result, 'ok') === false && field(result, 'status') === 'pending') {
      deps.toast('Provider cleanup is pending. Keep this session open and retry shortly.');
      return;
    }
    const empty = !!field(result, 'empty');
    await deps.purgeLocalData(empty);
    deps.broadcastIdentityBoundary();
    deps.toast('GitHub App installation disconnected ✦', 'ok');
    if (empty) { deps.signedOut(); return; }
    try { await deps.identityChanged(); } catch { /* the panel is read again below either way */ }
    await reload();
  }

  async function onClick(target: PressTarget | null): Promise<void> {
    const button = target ? target.closest('[data-github-app-action]') : null;
    if (!button) return;
    const action = button.dataset.githubAppAction;
    if (button.disabled || !isAction(action)) return;
    const address = addressFrom(button.dataset);
    if ((action === 'refresh' || action === 'disconnect') && !address) return;
    if (action === 'disconnect' && !deps.confirm(DISCONNECT_QUESTION)) return;
    const [busy, idle] = ACTION_LABELS[action];
    /* A connection on its way to GitHub keeps its control busy: the page is leaving. */
    let leaving = false;
    button.disabled = true;
    button.textContent = busy;
    try {
      if (action === 'connect' || action === 'reauthorize') leaving = await connect();
      else if (action === 'refresh') {
        await deps.api('/api/github-app/refresh', { method: 'POST', body: address ?? {} });
        deps.toast('GitHub App installation health refreshed ✦', 'ok');
        await reload();
      } else await disconnect(address ?? {});
    } catch (error) {
      deps.presentError(error);
    } finally {
      if (!leaving && deps.attached(button)) {
        button.disabled = false;
        button.textContent = idle;
      }
    }
  }

  function notice(): void {
    const where = deps.address();
    const found = callbackNotice(where.search);
    if (!found) return;
    deps.replaceAddress(`${where.pathname}${found.query ? `?${found.query}` : ''}${where.hash}`);
    deps.toast(found.message, found.tone);
  }

  return { status, show, reload, onClick, notice };
}
