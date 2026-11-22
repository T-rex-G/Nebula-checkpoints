/*
 * The overview's core panel: the rail that says where this session actually
 * is, the line under it that states the reading, the greeting, and the
 * pointer light.
 *
 * The rail reads the same identity the capability set resolves, so the rail
 * and the capabilities can never name two different hosts. A session with no
 * GitHub identity says "Not connected" rather than show a provider it is not
 * talking to: the live dot is what claims a connection, and a claim without a
 * source is the one thing this surface must not make. It says "Connected"
 * rather than "Live": an identity proves a session, not that anything is
 * being watched in real time.
 *
 * The line states the reading, not a slogan. It used to say "Secure by
 * default. Proven by design." to every session, including one with a leaked
 * key open and nothing scanned -- a claim this panel never checked.
 */
import { field } from '../../platform/values.ts';
import type { PulseView } from './workspace-pulse.ts';

/* Whether the session is a connection this panel may claim: a GitHub identity, and nothing retired. */
export const connected = (me: unknown): boolean => !!me && field(me, 'provider') === 'github';

interface Words { textContent: string | null }
interface LiveDot extends Words { readonly classList: { toggle(name: string, on: boolean): unknown } }

export function paintCoreState(scope: Words | null, live: LiveDot | null, me: unknown): void {
  if (!scope) return;
  const on = connected(me);
  scope.textContent = on ? 'github.com' : 'Not connected';
  if (live) {
    live.textContent = on ? 'Connected' : 'Not connected';
    live.classList.toggle('is-idle', !on);
  }
}

export function coreLineText(pulse: PulseView | null | undefined, me: unknown): string {
  const trust = pulse && pulse.trust;
  if (!me) return 'Sign in to measure this workspace.';
  if (!trust || trust.score === null) return 'Measuring this workspace\u2026';
  const attention = trust.attention
    ? `${trust.attention} ${trust.attention === 1 ? 'signal needs' : 'signals need'} attention`
    : 'every measured signal healthy';
  return `Grade ${trust.grade} \u00b7 ${trust.score}/100 \u00b7 ${attention}${trust.capped ? ' \u00b7 capped by a critical leak' : ''}.`;
}

/*
 * The line drawn through the page's repaint (components/held-repaint.ts),
 * which waits for a press on the overview to end: a line that wraps anew
 * moves every card below it.
 */
export function paintCoreLine<Line extends Words>(line: Line | null, pulse: PulseView | null | undefined, me: unknown, repaint: (host: Line, draw: () => void) => void): void {
  if (!line) return;
  const said = coreLineText(pulse, me);
  repaint(line, () => { line.textContent = said; });
}

/* Who the overview greets: the reader's name, their login, or a tester. */
export function greeting(me: unknown): string {
  return String((me && (field(me, 'name') || field(me, 'login'))) || 'tester');
}

/*
 * Repositories with a recovery reference held in this browser. The account
 * boundary's purge removes every one of these keys, so this can only ever
 * count the current identity's references.
 */
export function localSnapshotKeys(storage: () => { readonly [key: string]: unknown } | null): Set<string> {
  const keys = new Set<string>();
  try {
    const held = storage();
    if (held) for (const key of Object.keys(held)) {
      if (key.startsWith('nv_snap_')) keys.add(key.slice('nv_snap_'.length).toLowerCase());
    }
  } catch { /* storage unavailable: no browser-held references to count */ }
  return keys;
}

interface Panel {
  getBoundingClientRect(): { readonly left: number; readonly top: number; readonly width: number; readonly height: number };
  readonly style: { setProperty(name: string, value: string): void };
  addEventListener(type: 'pointermove', listener: (event: { readonly clientX: number; readonly clientY: number; readonly pointerType: string }) => void, options: { passive: boolean }): void;
}

/*
 * The pointer light: two custom properties and one radial gradient. The
 * browser repaints a background, with no layer to composite and nothing to
 * lay out. The listener is passive and added only where a fine pointer can
 * hover, so a phone never pays for it; with motion off the properties are
 * simply not written, and the surface keeps what it last had -- the same
 * surface it has at rest.
 */
export const FINE_POINTER = '(hover:hover) and (pointer:fine)';
export type MatchMedia = (query: string) => { readonly matches: boolean };
export function wireCorePointer(panel: Panel | null, media: MatchMedia | null | undefined, motion: () => boolean): void {
  if (!panel || !media || !media(FINE_POINTER).matches) return;
  panel.addEventListener('pointermove', event => {
    if (!motion() || event.pointerType === 'touch') return;
    const box = panel.getBoundingClientRect();
    if (!box.width || !box.height) return;
    panel.style.setProperty('--nv-px', `${((event.clientX - box.left) / box.width) * 100}%`);
    panel.style.setProperty('--nv-py', `${((event.clientY - box.top) / box.height) * 100}%`);
  }, { passive: true });
}
