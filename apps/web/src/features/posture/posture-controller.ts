/*
 * The workspace's posture at work: what the overview's rail, pulse and
 * security card read of the server.
 *
 * The workspace posture is the credential's real reach, the recovery points
 * that exist, the leaked credentials still open, and whether the server's
 * boundary is up: one request, read again at most once a minute, and bound to
 * the identity that asked -- an answer for a previous account never paints
 * the next one's overview.
 *
 * The security posture card (security-posture.ts) is read on the same terms,
 * and not asked at all by a deployment that does not offer it. The
 * repositories nobody has read come from the inventory the session holds, so
 * the card is drawn again whenever that changes.
 *
 * Upload scanning is asked once the overview is first shown, never during
 * start-up, which spent a request on every sign-in that never reached a
 * screen showing it. A refusal is an answer and is left as it is -- the
 * endpoint is capability-gated, and calling a refusal "not scanned" would
 * accuse the deployment of something never established -- but a request
 * that never reached the server is not one: it is asked again the next time
 * the overview is shown. It used to count as the answer for the rest of the
 * page's life.
 */
import { field } from '../../platform/values.ts';
import { model as postureModel } from './security-posture.ts';
import type { PostureActions } from './SecurityPosture.tsx';
import type { PostureView } from './security-posture.ts';

export const POSTURE_TTL_MS = 60 * 1000;

export interface PostureState {
  readonly me: unknown;
  readonly uiEpoch: number;
  readonly repos: unknown;
  posture: unknown;
  securityPosture: unknown;
  scanner: unknown;
}

export interface PostureDeps<Host> {
  readonly state: PostureState;
  readonly api: (path: string) => Promise<unknown>;
  readonly now: () => number;
  /* A failure that never reached the server, as the transport tells it. */
  readonly isOffline: (error: unknown) => boolean;
  /* What a deployment offers ('Supported' when it does). */
  readonly capability: (name: string) => unknown;
  readonly paintBoundary: (boundary: unknown) => void;
  /* The overview's pulse, drawn from what the session now holds. */
  readonly renderPulse: () => void;
  /* The findings inbox and the pull board are let go of with the posture; the inbox is read again with it. */
  readonly clearFindings: () => void;
  readonly invalidateFindings: () => void;
  readonly clearPullBoard: () => void;
  /* The security card's section and body. */
  readonly section: () => { hidden: boolean } | null;
  readonly host: () => Host | null;
  readonly draw: (host: Host, view: PostureView, actions: PostureActions) => void;
  readonly openTool: (owner: string, repo: string, tab: string) => void;
  /* The inbox a card's counts open, when this deployment offers one. */
  readonly inbox: () => ((filters: string) => void) | null;
}

export interface Posture {
  load(force?: boolean): Promise<void>;
  /* Let go of every reading, as a change of identity needs. */
  clear(): void;
  /* Anything that changes what the posture reports marks it for reading again. */
  invalidate(): void;
  securityOffered(): boolean;
  renderSecurity(): void;
  loadSecurity(force?: boolean): Promise<void>;
  loadScanner(): Promise<void>;
}

export function createPosture<Host>(deps: PostureDeps<Host>): Posture {
  const { state } = deps;
  let postureRequest = 0;
  let postureAt = 0;
  let securityRequest = 0;
  let securityAt = 0;
  let scannerAsked = false;

  const fresh = (at: number): boolean => !!at && deps.now() - at < POSTURE_TTL_MS;

  async function load(force?: boolean): Promise<void> {
    if (!state.me) return;
    if (!force && fresh(postureAt)) return;
    const asked = ++postureRequest;
    const epoch = state.uiEpoch;
    const identity = state.me;
    const stale = (): boolean => asked !== postureRequest || epoch !== state.uiEpoch || identity !== state.me;
    postureAt = deps.now();
    try {
      const posture = await deps.api('/api/workspace/posture');
      if (stale()) return;
      state.posture = posture && typeof posture === 'object' ? posture : null;
      deps.paintBoundary(state.posture ? field(state.posture, 'boundary') : { state: 'unknown' });
    } catch (error) {
      if (stale()) return;
      postureAt = 0;
      deps.paintBoundary({ state: deps.isOffline(error) ? 'offline' : 'unreachable' });
    }
    deps.renderPulse();
  }

  function clearSecurity(): void {
    securityRequest += 1;
    securityAt = 0;
    state.securityPosture = null;
  }

  function clear(): void {
    postureRequest += 1;
    postureAt = 0;
    state.posture = null;
    deps.paintBoundary(null);
    clearSecurity();
    deps.clearFindings();
    deps.clearPullBoard();
  }

  function invalidate(): void {
    postureAt = 0;
    securityAt = 0;
    deps.invalidateFindings();
  }

  const securityOffered = (): boolean => deps.capability('workspace.posture') === 'Supported';

  function renderSecurity(): void {
    const section = deps.section();
    const host = deps.host();
    if (!section || !host) return;
    section.hidden = !securityOffered();
    if (section.hidden) return;
    deps.draw(host, postureModel(state.securityPosture, state.repos), {
      audit: (owner, repo) => { deps.openTool(owner, repo, 'audit'); },
      inbox: deps.inbox()
    });
  }

  async function loadSecurity(force?: boolean): Promise<void> {
    if (!state.me) return;
    if (!securityOffered()) { renderSecurity(); return; }
    if (!force && fresh(securityAt)) { renderSecurity(); return; }
    const asked = ++securityRequest;
    const epoch = state.uiEpoch;
    const identity = state.me;
    const stale = (): boolean => asked !== securityRequest || epoch !== state.uiEpoch || identity !== state.me;
    securityAt = deps.now();
    if (!state.securityPosture) renderSecurity();
    try {
      const summary = await deps.api('/api/workspace/security-posture');
      if (stale()) return;
      state.securityPosture = summary && typeof summary === 'object' ? summary : { available: false, reason: 'unreadable' };
    } catch (error) {
      if (stale()) return;
      securityAt = 0;
      state.securityPosture = { available: false, reason: deps.isOffline(error) ? 'offline' : 'unreadable' };
    }
    renderSecurity();
  }

  async function loadScanner(): Promise<void> {
    if (scannerAsked) return;
    scannerAsked = true;
    try {
      const status = await deps.api('/api/security/scanner-status');
      if (status === null || status === undefined) throw new TypeError('no scanner status');
      const builtin = field(status, 'builtin');
      const yara = field(status, 'yara');
      state.scanner = {
        active: !!(builtin && field(builtin, 'available')) || !!(yara && field(yara, 'configured')),
        rulesConfigured: !!(yara && field(yara, 'configured'))
      };
    } catch (error) {
      state.scanner = null;
      if (deps.isOffline(error)) scannerAsked = false;
    }
    deps.renderPulse();
  }

  return { load, clear, invalidate, securityOffered, renderSecurity, loadSecurity, loadScanner };
}
