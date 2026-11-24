/*
 * The Exposure screen's controls bound: scan, retry, cancel, open all, clear
 * and older scans; the history-depth preference; and, delegated because both
 * lists are rebuilt on every render, a scan's report read when its disclosure
 * opens, a finding remembered open or closed, the two-press controls pressed,
 * and the readability question's fields kept as they are typed.
 *
 * A disclosure's `toggle` does not bubble, so those listeners listen in the
 * capture phase, and they only record what is open: drawing again from inside
 * a toggle would rebuild the element that fired it. Typed values live in the
 * screen's state rather than in the page, so a half-typed table name survives
 * every redraw; nothing redraws on a keystroke, so the field keeps its focus.
 * Every table is looked up by its own names only, and a field is kept only
 * under the two names the question has.
 */
import type { ExposureState } from './exposure-controller.ts';
import { HISTORY_PREFERENCE } from './exposure-words.ts';

/* The parts of an element these controls use. */
export interface ControlTarget {
  readonly dataset: Record<string, string | undefined>;
  readonly value?: string;
  readonly checked?: boolean;
  readonly open?: boolean;
  closest?(selector: string): ControlTarget | null;
}
export interface ControlHost {
  readonly checked?: boolean;
  addEventListener(type: string, listener: (event: { readonly target: unknown }) => void, capture?: boolean): void;
}

export interface ExposureControlsDeps {
  readonly $: (selector: string) => ControlHost | null;
  readonly current: () => ExposureState;
  readonly mutate: (change: (exposure: ExposureState) => void) => void;
  /* The count by severity and the open-all control, redrawn alone. */
  readonly tally: (current: ExposureState) => void;
  readonly request: () => unknown;
  readonly refreshScan: () => unknown;
  readonly load: (options: { filterOnly: boolean }) => unknown;
  readonly cancel: () => unknown;
  readonly toggleAll: () => unknown;
  readonly clearHistory: () => unknown;
  readonly loadHistory: (options: { more: boolean }) => unknown;
  readonly loadReport: (scanId: string) => unknown;
  readonly verify: (fingerprint: string | undefined) => unknown;
  readonly accept: (fingerprint: string | undefined) => unknown;
  readonly probe: (fingerprint: string | undefined) => unknown;
  /* Keep the reader's history-depth choice; a page that cannot keep it leaves the default standing. */
  readonly remember: (key: string, value: string) => void;
  /* Whether an event's target is a native disclosure. */
  readonly isDisclosure: (target: unknown) => boolean;
}

const DRAFT_FIELDS: readonly string[] = Object.freeze(['relation', 'columns']);
const own = (table: object, key: unknown): unknown => (typeof key === 'string' && Object.hasOwn(table, key) ? (table as Record<string, unknown>)[key] : undefined);
const running = (state: unknown): boolean => state === 'queued' || state === 'running';
const closest = (target: unknown, selector: string): ControlTarget | null => {
  const node = target as ControlTarget | null;
  return node && typeof node.closest === 'function' ? node.closest(selector) : null;
};

export function bindExposureControls(deps: ExposureControlsDeps): void {
  const { $ } = deps;
  const on = (selector: string, type: string, run: (host: ControlHost) => void): void => {
    const host = $(selector);
    if (host) host.addEventListener(type, () => run(host));
  };
  on('#exposureScanBtn', 'click', () => { void deps.request(); });
  on('#exposureRefreshBtn', 'click', () => {
    const scan = deps.current().scan;
    if (scan && running(scan.state)) void deps.refreshScan();
    else void deps.load({ filterOnly: true });
  });
  on('#exposureCancelBtn', 'click', () => { void deps.cancel(); });
  on('#exposureExpandAllBtn', 'click', () => { deps.toggleAll(); });
  on('#exposureClearBtn', 'click', () => { void deps.clearHistory(); });
  on('#exposureHistoryMoreBtn', 'click', () => { void deps.loadHistory({ more: true }); });
  on('#exposureHistoryToggle', 'change', depth => {
    try { deps.remember(HISTORY_PREFERENCE, depth.checked ? '1' : '0'); } catch { /* the default stands */ }
  });

  const history = $('#exposureHistory');
  if (history) {
    history.addEventListener('toggle', event => {
      const details = event.target as ControlTarget;
      if (!deps.isDisclosure(details) || !details.dataset.scanId) return;
      const scanId = details.dataset.scanId;
      const current = deps.current();
      if (details.open) {
        deps.mutate(() => { current.openScans.add(scanId); });
        if (!own(current.reports, scanId)) void deps.loadReport(scanId);
      } else {
        deps.mutate(() => { current.openScans.delete(scanId); });
      }
    }, true);
  }

  const list = $('#exposureList');
  if (!list) return;
  list.addEventListener('toggle', event => {
    const details = event.target as ControlTarget;
    if (!deps.isDisclosure(details) || !details.dataset.fingerprint) return;
    const fingerprint = details.dataset.fingerprint;
    const current = deps.current();
    if (details.open) deps.mutate(() => { current.expanded.add(fingerprint); });
    else deps.mutate(() => { current.expanded.delete(fingerprint); });
    deps.tally(current);
  }, true);
  list.addEventListener('click', event => {
    const verify = closest(event.target, '.exposure-verify');
    if (verify) { void deps.verify(verify.dataset.fingerprint); return; }
    const accept = closest(event.target, '.exposure-accept');
    if (accept) { void deps.accept(accept.dataset.fingerprint); return; }
    const probe = closest(event.target, '.exposure-probe');
    if (probe) void deps.probe(probe.dataset.fingerprint);
  });
  list.addEventListener('input', event => {
    const input = closest(event.target, '.exposure-probe-input');
    if (!input) return;
    const fingerprint = input.dataset.fingerprint;
    const name = input.dataset.field;
    if (typeof fingerprint !== 'string' || !DRAFT_FIELDS.includes(String(name))) return;
    const current = deps.current();
    const kept = own(current.probeDrafts, fingerprint) as { relation?: unknown; columns?: unknown } | undefined;
    const draft: Record<string, unknown> = kept || { relation: '', columns: '' };
    deps.mutate(() => {
      draft[String(name)] = input.value;
      /* Defined rather than assigned, so a finding named like an object's own machinery is kept as itself. */
      Object.defineProperty(current.probeDrafts, fingerprint, { value: draft, writable: true, enumerable: true, configurable: true });
    });
  });
}
