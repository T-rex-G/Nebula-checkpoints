/*
 * The page's short notices.
 *
 * A toast is one line in the notification stack (`#toasts`, a polite live
 * region): shown for 3.6 seconds, faded over 0.4, then removed. Its outcome
 * was carried by colour alone -- a reader saw green or red, and anyone
 * listening heard only the message -- so the tone is also written as text
 * before it, hidden visually: "Success: " or "Error: ". A success is felt
 * as well as seen, where the device can buzz.
 *
 * The document, the stack, the clock and the buzz are handed in, so the
 * same code runs on the page and under a test.
 */

export type ToastKind = '' | 'ok' | 'err';

/* How long a toast is shown before it fades, and how long the fade lasts. */
export const TOAST_SHOWN_MS = 3600;
export const TOAST_FADE_MS = 400;

const TONES: Readonly<Record<string, string>> = Object.freeze({ ok: 'Success', err: 'Error' });

/* The word a screen reader hears before a toast of this kind, or null when the kind has no tone. */
export function toneOf(kind: string): string | null {
  return Object.prototype.hasOwnProperty.call(TONES, kind) ? TONES[kind] ?? null : null;
}

/* The parts of an element a toast is made from. */
interface ToastElement {
  className: string;
  textContent: string | null;
  readonly style: { opacity: string; transition: string };
  appendChild(node: unknown): unknown;
  remove(): void;
}

export interface ToastDeps {
  readonly document: { createElement(tag: 'div' | 'span'): ToastElement; createTextNode(text: string): unknown };
  /* The stack toasts are added to; none means the page is not ready, and the toast is dropped. */
  readonly stack: () => { appendChild(node: unknown): unknown } | null;
  readonly setTimeout: (run: () => void, ms: number) => unknown;
  /* A short buzz, where the device has one; it may throw, and is then skipped. */
  readonly vibrate?: ((ms: number) => void) | null;
}

export type Toast = (message: unknown, kind?: ToastKind) => ToastElement | null;

export function createToasts(deps: ToastDeps): Toast {
  return (message, kind = '') => {
    if (kind === 'ok' && deps.vibrate) {
      try { deps.vibrate(10); } catch { /* a buzz refused is a buzz skipped */ }
    }
    const stack = deps.stack();
    if (!stack) return null;
    const toast = deps.document.createElement('div');
    toast.className = `toast ${kind}`;
    const tone = toneOf(kind);
    if (tone) {
      const label = deps.document.createElement('span');
      label.className = 'sr-only';
      label.textContent = `${tone}: `;
      toast.appendChild(label);
    }
    toast.appendChild(deps.document.createTextNode(String(message)));
    stack.appendChild(toast);
    deps.setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity .4s';
      deps.setTimeout(() => toast.remove(), TOAST_FADE_MS);
    }, TOAST_SHOWN_MS);
    return toast;
  };
}
