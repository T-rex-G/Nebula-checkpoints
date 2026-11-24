/*
 * The repository's trust summary and the public error, drawn.
 *
 * The same elements, classes, roles and accessible names as before they were
 * components (ADR-093). Every value reaches the page as text React writes:
 * nothing a server or a provider said is ever parsed as markup. What is said
 * is trust-ui.ts's.
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import { EVIDENCE_MARKS, errorView, rollup, summaryView } from './trust-ui.ts';
import type { ErrorView, EvidenceState, SummaryField } from './trust-ui.ts';

export function EvidenceBadge({ state }: { state: EvidenceState }): ReactElement {
  return (
    <span className={`trust-evidence trust-evidence-${state.toLowerCase()}`} data-evidence-state={state}>
      <span className="trust-evidence-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" aria-hidden="true" className="trust-evidence-mark">
          {EVIDENCE_MARKS[state].map(d => <path key={d} d={d} />)}
        </svg>
      </span>
      <span>{state}</span>
    </span>
  );
}

function Field({ entry }: { entry: SummaryField }): ReactElement {
  return (
    <>
      <h3>{entry.label}</h3>
      <p>{entry.text}</p>
      <EvidenceBadge state={entry.evidence} />
    </>
  );
}

const roots = new WeakMap<HTMLElement, Root>();

function rootOf(host: HTMLElement): Root {
  let root = roots.get(host);
  if (!root) {
    host.textContent = '';
    root = createRoot(host);
    roots.set(host, root);
  }
  return root;
}

/*
 * The five fields of the summary, each drawn into the page's own place for
 * it, with the one-line standing for the phone layout and the announcement
 * for a screen reader. Answers the places it drew into.
 */
export function renderSummary(model: unknown = {}): HTMLElement[] {
  const summary = document.getElementById('trustSummary');
  if (!summary) return [];
  const view = summaryView(model);
  const drawn: HTMLElement[] = [];
  const states: EvidenceState[] = [];
  for (const entry of view.fields) {
    const host = document.getElementById(entry.id);
    if (!host) continue;
    const root = rootOf(host);
    flushSync(() => root.render(<Field entry={entry} />));
    host.dataset.trustState = entry.evidence;
    drawn.push(host);
    states.push(entry.evidence);
  }
  const standing = rollup(states);
  const line = document.getElementById('trustRollupStates');
  if (line) {
    line.textContent = standing.text;
    summary.dataset.trustWorst = standing.worst;
  }
  summary.hidden = false;
  const status = document.getElementById('a11yStatus');
  if (status) status.textContent = view.announcement;
  return drawn;
}

/* The phone layout's disclosure: the standing line opens and closes the detail. */
function bindRollup(): void {
  const button = document.getElementById('trustRollup');
  const summary = document.getElementById('trustSummary');
  if (!button || !summary) return;
  button.addEventListener('click', () => {
    const open = summary.dataset.open !== 'true';
    summary.dataset.open = open ? 'true' : 'false';
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindRollup, { once: true });
else bindRollup();

function ErrorField({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="trust-error-field">
      <h3>{label}</h3>
      <p>{value}</p>
    </div>
  );
}

type CopyState = 'Copy' | 'Copied' | 'Copy unavailable';

function ErrorDialog({ view, onClose, dialogRef, closeRef }: {
  view: ErrorView;
  onClose: () => void;
  dialogRef: { current: HTMLElement | null };
  closeRef: { current: HTMLButtonElement | null };
}): ReactElement {
  const [copy, setCopy] = useState<CopyState>('Copy');
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);
  const copyId = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(view.correlationId);
      if (live.current) setCopy('Copied');
    } catch {
      if (live.current) setCopy('Copy unavailable');
    }
  };
  return (
    <section ref={dialogRef} className="trust-error-dialog" role="dialog" aria-modal="true" aria-labelledby="trustErrorTitle">
      <h2 id="trustErrorTitle">The action was not completed</h2>
      <ErrorField label="What happened" value={view.message} />
      <ErrorField label="Provider/repository changed" value={view.providerChanged} />
      <ErrorField label="Safe state now" value={view.safeState} />
      <ErrorField label="Next action" value={view.nextAction} />
      <div className="trust-error-field">
        <h3>Correlation ID</h3>
        <div className="trust-correlation-row">
          <code>{view.correlationId}</code>
          <button type="button" className="btn btn-ghost small" disabled={!view.copyable} onClick={() => { void copyId(); }}>{copy}</button>
        </div>
      </div>
      <details>
        <summary>Internal error code</summary>
        <code>{view.code}</code>
      </details>
      <button ref={closeRef} type="button" className="btn btn-primary trust-error-close" onClick={onClose}>Close</button>
    </section>
  );
}

/* What focus returns to: an element of the page that can take it. */
type Focusable = HTMLElement | SVGElement;
const focusable = (element: Element | null): element is Focusable => element instanceof HTMLElement || element instanceof SVGElement;

/* The dialog showing now, if any: its backdrop, its root, how it is put away, and what held focus before it. */
let open: { backdrop: HTMLElement; root: Root; onKeydown: (event: KeyboardEvent) => void; returnFocus: Focusable | null } | null = null;

/* Takes the dialog down without giving focus anywhere: a new one is about to take it. */
function takeDown(): void {
  if (!open) return;
  const { backdrop, root, onKeydown } = open;
  open = null;
  document.removeEventListener('keydown', onKeydown);
  root.unmount();
  backdrop.remove();
}

const FOCUSABLE = 'button:not([disabled]), summary, [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/*
 * A failed action, said in full in a modal dialog: what happened, whether the
 * provider or repository changed, the safe state now, the next action, the
 * correlation ID to copy, and the internal code folded away. Focus is held
 * inside it, Escape or Close puts it away, and focus goes back to what held
 * it when it opened. Answers the dialog.
 */
export function presentError(error: unknown = {}): HTMLElement | null {
  /*
   * A dialog that replaces another returns focus where the first would have:
   * the element focused when it opened. Focus is on the first dialog's Close
   * button now, which goes with it, and closing the second used to leave a
   * keyboard reader at the top of the page.
   */
  const active = document.activeElement;
  const returnFocus = open ? open.returnFocus : focusable(active) ? active : null;
  takeDown();
  /* One dialog at a time, whoever drew the last. */
  document.getElementById('trustErrorBackdrop')?.remove();
  const backdrop = document.createElement('div');
  backdrop.id = 'trustErrorBackdrop';
  backdrop.className = 'trust-error-backdrop';
  const dialogRef: { current: HTMLElement | null } = { current: null };
  const closeRef: { current: HTMLButtonElement | null } = { current: null };
  const dismiss = (): void => {
    takeDown();
    if (returnFocus && returnFocus.isConnected) returnFocus.focus();
  };
  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') { dismiss(); return; }
    if (event.key !== 'Tab' || !dialogRef.current) return;
    const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(element => !element.hidden && element.offsetParent !== null);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  backdrop.addEventListener('click', event => { if (event.target === backdrop) dismiss(); });
  const root = createRoot(backdrop);
  open = { backdrop, root, onKeydown, returnFocus };
  document.addEventListener('keydown', onKeydown);
  flushSync(() => root.render(<ErrorDialog view={errorView(error)} onClose={dismiss} dialogRef={dialogRef} closeRef={closeRef} />));
  document.body.appendChild(backdrop);
  if (closeRef.current) closeRef.current.focus();
  return dialogRef.current;
}

const TrustUI = Object.freeze({ renderSummary, presentError });
export default TrustUI;
