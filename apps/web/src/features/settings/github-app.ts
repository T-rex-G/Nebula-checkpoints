/*
 * The GitHub App, as Settings shows it.
 *
 * An installation is reached through the server, which sends each
 * connection in one of two shapes. A deployment open to anyone names it by
 * its installation number, with the account it belongs to and who
 * authorized it. The invite-only alpha keeps every login out of the page:
 * a connection there is its stable key, its access and its health, and
 * nothing else. The page addresses a connection by whichever it was given --
 * the key when there is one, the number otherwise -- and draws only what
 * it was told, so neither shape is shown as a missing value.
 */
import { IDENTITY_KEY } from '../../../../../packages/contracts/src/ids.ts';
import { escapeAttribute, escapeHtml } from '../../platform/html.ts';
import { field, hasFields, items } from '../../platform/values.ts';

/* How a request to the server names one connection: exactly one of the two. */
export type ConnectionAddress = { readonly connectionKey: string } | { readonly installationId: number };

/* Who is signed in, as far as the GitHub App's controls care. */
export interface SignedIn {
  readonly provider?: unknown;
  readonly authMethod?: unknown;
}

/* A connection the server sent, read into what Settings draws. */
export interface ConnectionView {
  readonly address: ConnectionAddress | null;
  readonly account: string;
  readonly accountType: string;
  readonly installation: number | null;
  readonly avatar: string;
  readonly access: string;
  readonly authorizedBy: string;
  readonly healthy: boolean;
  readonly health: string;
  readonly verifiedAt: string;
  readonly manageUrl: string;
}

/* GitHub's own pages, and nowhere else: where an installation is managed and where an authorization starts. */
export function isGithubUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https:\/\/github\.com\//i.test(value);
}

/* A whole, positive installation number, or null. */
function installationOf(value: unknown): number | null {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/* The address a connection is reached by: its key when the server gave one, its installation number otherwise. */
export function addressOf(connection: unknown): ConnectionAddress | null {
  const key = field(connection, 'connectionKey');
  if (typeof key === 'string' && IDENTITY_KEY.test(key)) return { connectionKey: key };
  const installationId = installationOf(field(connection, 'installationId'));
  return installationId === null ? null : { installationId };
}

/* An address written onto a control, and read back from it. */
export function addressAttributes(address: ConnectionAddress): string {
  return 'connectionKey' in address
    ? `data-connection-key="${escapeAttribute(address.connectionKey)}"`
    : `data-installation-id="${address.installationId}"`;
}
export function addressFrom(dataset: { readonly connectionKey?: string; readonly installationId?: string }): ConnectionAddress | null {
  return addressOf({ connectionKey: dataset.connectionKey, installationId: dataset.installationId });
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const capitalized = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

/* When the server last saw the installation answer, in the reader's own words for a date; never "Invalid Date". */
export function verifiedText(value: unknown, format: (date: Date) => string): string {
  const raw = text(value);
  if (!raw) return 'Not verified yet';
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? 'Not verified yet' : format(date);
}

export function connectionView(connection: unknown, format: (date: Date) => string): ConnectionView {
  const status = text(field(connection, 'status'));
  const manage = field(connection, 'installationUrl');
  const avatar = text(field(connection, 'avatar'));
  return {
    address: addressOf(connection),
    account: text(field(connection, 'accountLogin')) || 'GitHub installation',
    accountType: text(field(connection, 'accountType')) || 'Account',
    installation: installationOf(field(connection, 'installationId')),
    avatar: /^https:\/\//i.test(avatar) ? avatar : '',
    access: field(connection, 'repositorySelection') === 'all' ? 'All repositories approved for this installation' : 'Selected repositories only',
    authorizedBy: text(field(connection, 'authorizedByLogin')),
    healthy: status === 'connected',
    health: status === 'connected' ? 'Healthy' : status ? capitalized(status) : 'Unavailable',
    verifiedAt: verifiedText(field(connection, 'lastVerifiedAt'), format),
    manageUrl: isGithubUrl(manage) ? manage : ''
  };
}

/* Only a GitHub identity signed in with a token or OAuth can authorize an installation: one signed in through the App cannot vouch for itself. */
export function canAuthorize(me: SignedIn | null): boolean {
  return !!me && me.provider === 'github' && me.authMethod !== 'github-app';
}

function connectionCard(view: ConnectionView, authorize: boolean): string {
  const address = view.address ? addressAttributes(view.address) : '';
  const subtitle = view.installation === null ? escapeHtml(view.accountType) : `${escapeHtml(view.accountType)} · Installation #${view.installation}`;
  /* A connection with no address the server would accept offers nothing that would be refused. */
  const addressed = view.address
    ? `<button class="btn btn-ghost small" data-github-app-action="refresh" ${address}>Refresh health</button>`
    : '';
  const disconnect = view.address
    ? `<button class="btn btn-ghost small danger" data-github-app-action="disconnect" ${address}>Disconnect</button>`
    : '';
  return `<div class="github-app-connection"${address ? ` ${address}` : ''}>
      <div class="github-app-connection-head">
        <div class="github-app-identity">
          ${view.avatar ? `<img class="avatar" src="${escapeAttribute(view.avatar)}" alt="">` : ''}
          <div><b>${escapeHtml(view.account)}</b><span>${subtitle}</span></div>
        </div>
        <span class="github-app-health ${view.healthy ? 'healthy' : 'warning'}">${escapeHtml(view.health)}</span>
      </div>
      <dl class="github-app-meta">
        <div><dt>Repository access</dt><dd>${escapeHtml(view.access)}</dd></div>
        ${view.authorizedBy ? `<div><dt>Authorized by</dt><dd>${escapeHtml(view.authorizedBy)}</dd></div>` : ''}
        <div><dt>Last verified</dt><dd>${escapeHtml(view.verifiedAt)}</dd></div>
      </dl>
      <div class="github-app-actions">
        ${addressed}
        <button class="btn btn-ghost small" data-github-app-action="reauthorize" ${authorize ? '' : 'disabled'}>Reauthorize</button>
        ${view.manageUrl ? `<a class="btn btn-ghost small" href="${escapeAttribute(view.manageUrl)}" target="_blank" rel="noopener noreferrer">Manage on GitHub</a>` : ''}
        ${disconnect}
      </div>
    </div>`;
}

/* The GitHub App's part of Settings: unavailable, nothing connected yet, or each connection with what can be done to it. */
export function githubAppBody(status: unknown, me: SignedIn | null, format: (date: Date) => string): string {
  if (!hasFields(status) || status.enabled !== true) {
    return `<div class="github-app-connection github-app-unavailable">
      <div><b>GitHub App is optional</b><p>It is not configured on this deployment. GitHub token and OAuth access remain available.</p></div>
    </div>`;
  }
  const authorize = canAuthorize(me);
  const connect = `<button class="btn btn-ghost small" data-github-app-action="connect" ${authorize ? '' : 'disabled'}>Connect GitHub App</button>`;
  const guide = authorize
    ? 'GitHub will ask you to authorize your identity and choose repository access.'
    : 'Switch to a GitHub PAT or OAuth account to authorize or reauthorize an installation.';
  const cards = items(status.connections).filter(hasFields).map(connection => connectionCard(connectionView(connection, format), authorize)).join('');
  const error = text(status.error);
  return `${error ? `<p class="hint github-app-error">⚠ ${escapeHtml(error)}</p>` : ''}
    ${cards || `<div class="github-app-connection github-app-empty"><div><b>No installation connected</b><p>${escapeHtml(guide)}</p></div>${connect}</div>`}
    ${cards ? `<p class="hint github-app-guide">${escapeHtml(guide)}</p>${authorize ? connect : ''}` : ''}`;
}

/* What a control says while it works, and again once it is done. */
export const ACTION_LABELS = Object.freeze({
  connect: ['Opening GitHub…', 'Connect GitHub App'],
  reauthorize: ['Opening GitHub…', 'Reauthorize'],
  refresh: ['Checking…', 'Refresh health'],
  disconnect: ['Disconnecting…', 'Disconnect']
} as const);
export type GithubAppAction = keyof typeof ACTION_LABELS;
export function isAction(value: unknown): value is GithubAppAction {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ACTION_LABELS, value);
}

/* The result GitHub sends the reader back with, read and taken out of the address. */
export interface CallbackNotice {
  readonly query: string;
  readonly message: string;
  readonly tone: 'ok' | 'err';
}
export function callbackNotice(search: string): CallbackNotice | null {
  const params = new URLSearchParams(search);
  const result = params.get('githubApp');
  if (!result) return null;
  const code = params.get('code');
  params.delete('githubApp');
  params.delete('code');
  if (result === 'connected') return { query: params.toString(), message: 'GitHub App installation connected securely ✦', tone: 'ok' };
  const detail = code ? ` (${code.replace(/_/g, ' ').toLowerCase()})` : '';
  return { query: params.toString(), message: `GitHub App connection was not completed${detail}`, tone: 'err' };
}
