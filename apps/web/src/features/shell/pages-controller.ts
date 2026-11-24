/*
 * The screens at work: one shown at a time, the next one brought in, the top
 * bar measured for the layout beneath it, and the galaxy leaning toward a
 * pointer on a desk. What each step is is pages.ts's.
 *
 * Every arrival is counted, so a start that ends late can tell the reader
 * has moved since it began, and the screen in view can be named without one
 * -- the alpha's gate replaces the screens without showing one of them.
 */
import { crossFades, keepsAddress, lean, visualFor } from './pages.ts';

interface Screen {
  readonly classList: { add(name: string): void; remove(name: string): void };
  querySelector(selector: string): { scrollTop: number } | null;
}

interface ViewTransition {
  readonly ready: Promise<unknown>;
  readonly updateCallbackDone: Promise<unknown>;
}

export interface PagesDeps {
  readonly screens: () => readonly Screen[];
  readonly screen: (name: string) => Screen | null;
  /* The top bar of the screen in view, and the property its height is written to. */
  readonly activeTopbar: () => { readonly offsetHeight: number } | null;
  readonly setRootProperty: (name: string, value: string) => void;
  readonly startViewTransition: ((change: () => void) => ViewTransition) | null;
  readonly motion: () => boolean;
  readonly layerLeaving: () => boolean;
  readonly reducedMotion: () => boolean;
  readonly scrollToTop: () => void;
  readonly setTimeout: (run: () => void, ms: number) => unknown;
  readonly requestAnimationFrame: (run: () => void) => unknown;
  readonly paintRail: (name: string) => void;
  readonly mountVisual: (kind: string, selector: string) => void;
  /* The address names no screen's state. */
  readonly clearAddress: () => void;
  readonly paintDock: (name: string) => void;
}

export interface Pages {
  /* The screen in view. */
  current(): string;
  /* How many times the reader has arrived on a screen. */
  arrivals(): number;
  /* The screen in view, named by something that replaced the screens without showing one. */
  setCurrent(name: string): void;
  /* Bring a screen in. Settles once it is the one showing. */
  show(name: string): Promise<void>;
  /* The top bar's height, for the layout beneath it, measured once it is laid out. */
  measureTopbar(): void;
  /* Run a change of screen, cross-faded where it may be. Settles once the change has run. */
  withTransition(change: () => void): Promise<void>;
}

export function createPages(deps: PagesDeps, start = 'alpha-access'): Pages {
  let current = start;
  let arrivals = 0;

  function withTransition(change: () => void): Promise<void> {
    const start = deps.startViewTransition;
    if (start && crossFades({ available: true, motion: deps.motion(), layerLeaving: deps.layerLeaving(), reducedMotion: deps.reducedMotion() })) {
      const transition = start(change);
      /* A navigation that supersedes this one may skip only the animation; its change still runs. That is expected; anything else is not hidden. */
      transition.ready.catch((error: unknown) => {
        if (!(error instanceof Error) || error.name !== 'AbortError') throw error;
      });
      return transition.updateCallbackDone.then(() => undefined, () => undefined);
    }
    change();
    return Promise.resolve();
  }

  function measureTopbar(): void {
    deps.requestAnimationFrame(() => {
      const bar = deps.activeTopbar();
      if (bar) deps.setRootProperty('--tbh', `${bar.offsetHeight}px`);
    });
  }

  function show(name: string): Promise<void> {
    deps.setTimeout(measureTopbar, 30);
    if (current === name) return Promise.resolve();
    current = name;
    arrivals += 1;
    deps.paintRail(name);
    /* Mounted here rather than by each caller: six paths reach these screens. */
    const visual = visualFor(name);
    if (visual) deps.mountVisual(visual[0], visual[1]);
    const swapped = withTransition(() => {
      for (const screen of deps.screens()) screen.classList.remove('active');
      const shown = deps.screen(name);
      if (!shown) return;
      shown.classList.add('active');
      deps.scrollToTop();
      const region = shown.querySelector('.container');
      if (region) region.scrollTop = 0;
      if (!keepsAddress(name)) deps.clearAddress();
    });
    /*
     * The dock asks what is on screen, so it asks once the screen is: before
     * the swap it read the previous screen, inside it a document mid-change
     * under a transition holding the old frame. Two frames later both have
     * settled.
     */
    deps.requestAnimationFrame(() => deps.requestAnimationFrame(() => deps.paintDock(name)));
    return swapped;
  }

  return { current: () => current, arrivals: () => arrivals, setCurrent: name => { current = name; }, show, measureTopbar, withTransition };
}

/* The galaxy's lean, wired to its hero: never on a touch screen, never with motion off, one frame per move at most. */
export interface LeanDeps {
  readonly hero: { addEventListener(type: string, listener: (event: { readonly clientX: number; readonly clientY: number }) => void, options?: { passive?: boolean }): void; getBoundingClientRect(): { readonly left: number; readonly top: number; readonly width: number; readonly height: number } };
  readonly art: { readonly style: { setProperty(name: string, value: string): void; removeProperty(name: string): void } };
  readonly motionOff: () => boolean;
  readonly requestAnimationFrame: (run: () => void) => number;
}
export function watchLean(deps: LeanDeps): void {
  let frame = 0;
  deps.hero.addEventListener('pointermove', event => {
    if (frame || deps.motionOff()) return;
    frame = deps.requestAnimationFrame(() => {
      frame = 0;
      const { ry, rx } = lean(deps.hero.getBoundingClientRect(), event.clientX, event.clientY);
      deps.art.style.setProperty('--gx-ry', ry);
      deps.art.style.setProperty('--gx-rx', rx);
    });
  }, { passive: true });
  deps.hero.addEventListener('pointerleave', () => {
    deps.art.style.removeProperty('--gx-ry');
    deps.art.style.removeProperty('--gx-rx');
  });
}
