/*
 * The page's one dialog: a question, a panel of controls, or a notice.
 *
 * `open` fills the dialog, raises it over the scrim and answers, when the
 * reader leaves it, whether they confirmed: OK is true; Cancel, the corner's
 * close control and a press on the scrim are false. A dialog asked for while
 * another is up answers the first one false and takes its place. Each opening
 * is a generation, so a flow still holding an earlier dialog can tell it is
 * no longer the one on screen (`owner`): another dialog, another screen of
 * the page or another account has taken it since.
 *
 * Focus goes in to the first field, or to the way out when the dialog is a
 * panel of controls -- a phone does not raise its keyboard for a panel --
 * and comes back, when the dialog closes, to what opened it, unless the flow
 * that awaited the dialog has already put it somewhere else.
 */

export interface ModalRequest {
  readonly title: string;
  readonly bodyHTML: string;
  readonly okText?: string;
  readonly danger?: boolean;
  /* Run once the body is in place, before focus moves: wire the dialog's own controls here. */
  readonly onOpen?: ((body: ModalBody) => void) | null;
  readonly wide?: boolean;
  /* False for a dialog with nothing to confirm: one way out, the OK button. */
  readonly cancel?: boolean;
  /* False for a panel of controls: focus goes to the way out, not to a field. */
  readonly autofocus?: boolean;
}

interface Focusable {
  readonly isConnected?: boolean;
  focus?(options?: { preventScroll?: boolean }): void;
}

export interface ModalBody {
  innerHTML: string;
  querySelector(selector: string): (Focusable & object) | null;
}

export interface ModalElements {
  readonly scrim: { contains(node: unknown): boolean; addEventListener(type: 'click', listener: (event: { readonly target: unknown }) => void): void };
  readonly modal: { classList: { toggle(name: string, on: boolean): unknown }; scrollTop: number };
  readonly title: { textContent: string | null };
  readonly body: ModalBody;
  readonly ok: { textContent: string | null; classList: { toggle(name: string, on: boolean): unknown }; addEventListener(type: 'click', listener: () => void): void } & Focusable;
  readonly cancel: { hidden: boolean; addEventListener(type: 'click', listener: () => void): void } & Focusable;
  readonly close: ({ addEventListener(type: 'click', listener: () => void): void } & Focusable) | null;
}

export interface ModalDeps {
  readonly elements: () => ModalElements;
  readonly overlay: {
    openOverlay(layer: unknown): void;
    closeOverlay(layer: unknown): void;
    overlayOpen(layer: unknown): boolean;
  };
  /* Grow the dialog from the control that opened it. */
  readonly anchor: (panel: unknown, opener: unknown) => void;
  /* Which screen of the page, and which account, a dialog was opened under. */
  readonly epoch: () => unknown;
  readonly identity: () => unknown;
  readonly activeElement: () => unknown;
  readonly setTimeout: (run: () => void, ms: number) => unknown;
  readonly requestAnimationFrame: (run: () => void) => unknown;
  /* The page's own reaction to a dialog closing. */
  readonly onClosed?: (() => void) | null;
}

export interface Modal {
  open(request: ModalRequest): Promise<boolean>;
  close(confirmed: boolean): void;
  /* Whether the dialog on screen is still the one open when this was asked. */
  owner(): () => boolean;
  /* The current opening; it changes on every open and close. */
  generation(): number;
  /* The dialog's own controls answer it. */
  wire(): void;
}

/* How long after opening focus moves in: after the entrance has begun, so the move does not jump it. */
const FOCUS_DELAY_MS = 60;

const focusable = (value: unknown): value is Focusable & { focus(options?: { preventScroll?: boolean }): void } =>
  typeof value === 'object' && value !== null && typeof Reflect.get(value, 'focus') === 'function';

export function createModal(deps: ModalDeps): Modal {
  let pending: ((confirmed: boolean) => void) | null = null;
  let returnFocus: unknown = null;
  let generation = 0;

  function owner(): () => boolean {
    const mine = generation;
    const epoch = deps.epoch();
    const identity = deps.identity();
    return () => mine === generation && epoch === deps.epoch() && identity === deps.identity() && deps.overlay.overlayOpen(deps.elements().scrim);
  }

  function open({ title, bodyHTML, okText = 'Confirm', danger = false, onOpen = null, wide = false, cancel = true, autofocus = true }: ModalRequest): Promise<boolean> {
    generation += 1;
    if (pending) { pending(false); pending = null; }
    return new Promise(resolve => {
      pending = resolve;
      returnFocus = deps.activeElement();
      const parts = deps.elements();
      parts.title.textContent = title;
      parts.modal.classList.toggle('modal-wide', Boolean(wide));
      parts.cancel.hidden = cancel === false;
      parts.body.innerHTML = bodyHTML;
      /* The dialog element is reused: a new one starts at its top, not where the last was left. */
      parts.modal.scrollTop = 0;
      parts.ok.textContent = okText;
      parts.ok.classList.toggle('danger', danger);
      deps.overlay.openOverlay(parts.scrim);
      const ownsDialog = owner();
      /* Before the entrance is painted, so its first frame already grows from the right place. */
      deps.anchor(parts.modal, returnFocus);
      if (typeof onOpen === 'function') onOpen(parts.body);
      const field = autofocus ? parts.body.querySelector('input:not([disabled]), textarea:not([disabled]), select:not([disabled])') : null;
      const first = field || (cancel === false ? parts.close || parts.ok : parts.cancel);
      if (first) deps.setTimeout(() => {
        if (ownsDialog() && first.isConnected && !parts.scrim.contains(deps.activeElement()) && focusable(first)) first.focus({ preventScroll: true });
      }, FOCUS_DELAY_MS);
    });
  }

  function close(confirmed: boolean): void {
    generation += 1;
    const parts = deps.elements();
    deps.overlay.closeOverlay(parts.scrim);
    if (pending) { pending(confirmed); pending = null; }
    if (deps.onClosed) deps.onClosed();
    const restore = returnFocus;
    returnFocus = null;
    const closing = generation;
    if (focusable(restore) && restore.isConnected) deps.requestAnimationFrame(() => {
      /*
       * Only a focus the closing dialog left behind is handed back. The flow
       * that awaited the dialog may already have moved it on -- staging a file
       * opens the staged-changes panel and focuses its commit control -- and
       * taking it back a frame later would leave the reader behind that panel.
       */
      const active = deps.activeElement();
      const left = !active || active === bodyOf(active) || parts.scrim.contains(active);
      if (closing === generation && left) restore.focus({ preventScroll: true });
    });
  }

  function wire(): void {
    const parts = deps.elements();
    parts.ok.addEventListener('click', () => close(true));
    parts.cancel.addEventListener('click', () => close(false));
    /* The corner's control answers as Cancel does: a dialog dismissed from the corner has not been confirmed. */
    if (parts.close) parts.close.addEventListener('click', () => close(false));
    parts.scrim.addEventListener('click', event => { if (event.target === parts.scrim) close(false); });
  }

  return { open, close, owner, generation: () => generation, wire };
}

/* The document's body, as seen from an element in it: where focus rests when nothing has it. */
function bodyOf(element: unknown): unknown {
  const owner = typeof element === 'object' && element !== null ? Reflect.get(element, 'ownerDocument') : null;
  return typeof owner === 'object' && owner !== null ? Reflect.get(owner, 'body') : undefined;
}
