/*
 * One typed external store (ADR-092).
 *
 * The page keeps what it knows in one place, and anything that shows it --
 * the workbench as it is, a React component as it becomes one -- is told
 * when it changes. A store holds named slices, fixed when it is made. A slice
 * is replaced whole with `set`, or, for a record whose identity is how the
 * page tells one repository, file or session from the next, changed in place
 * with `mutate`: the record stays the same object, so a guard holding it
 * still recognises it, and the change is announced all the same.
 *
 * Each slice counts its changes. A reader is known by the slices it reads:
 * `stamp` runs it over a view that notes each slice it touches and answers
 * those slices' counts, so two equal stamps mean nothing the reader reads
 * has changed between them, whether the slice was replaced or changed in
 * place. That is what a component gives useSyncExternalStore, and it renders
 * again when, and only when, a slice it reads has changed.
 *
 * Nothing is copied, so a slice read is the slice itself: a reader that
 * changes it in place, outside `mutate`, changes the page without telling
 * anyone, and a rule over the page's syntax tree refuses that
 * (test/page-rules.test.js).
 */
import { useSyncExternalStore } from 'react';

export interface Store<S extends object> {
  /* The slices as they are now. */
  readonly get: () => Readonly<S>;
  /* Replaces one slice; listeners hear of it when the value differs. */
  readonly set: <K extends keyof S>(key: K, value: S[K]) => void;
  /* Changes one slice in place, then announces it, even if nothing measurable moved. */
  readonly mutate: <K extends keyof S>(key: K, change: (slice: S[K]) => void) => void;
  /* The change counts of the slices `read` reads, in one comparable string. */
  readonly stamp: (read: (slices: Readonly<S>) => unknown) => string;
  /* Hears every change until the returned function is called. */
  readonly subscribe: (listener: () => void) => () => void;
}

export function createStore<S extends object>(initial: S): Store<S> {
  const slices: S = { ...initial };
  const keys = Object.freeze(Object.keys(slices) as (keyof S)[]);
  const counts = new Map<keyof S, number>(keys.map(key => [key, 0]));
  const listeners = new Set<() => void>();

  const announce = (key: keyof S): void => {
    counts.set(key, (counts.get(key) ?? 0) + 1);
    /* A listener added by another, while this runs, hears the next change, not this one. */
    for (const listener of [...listeners]) listener();
  };

  const stamp = (read: (view: Readonly<S>) => unknown): string => {
    const touched = new Set<keyof S>();
    const view = {} as S;
    for (const key of keys) {
      Object.defineProperty(view, key, {
        enumerable: true,
        get: () => { touched.add(key); return slices[key]; }
      });
    }
    read(Object.freeze(view));
    /* By position, in the order the slices were made, so the same reads always stamp alike. */
    return keys.flatMap((key, index) => (touched.has(key) ? [`${index}:${counts.get(key)}`] : [])).join(' ');
  };

  return Object.freeze({
    get: () => slices,
    set: <K extends keyof S>(key: K, value: S[K]): void => {
      if (Object.is(slices[key], value)) return;
      slices[key] = value;
      announce(key);
    },
    mutate: <K extends keyof S>(key: K, change: (slice: S[K]) => void): void => {
      change(slices[key]);
      announce(key);
    },
    stamp,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    }
  });
}

/*
 * What a component shows of a store: the selection, read again when a slice
 * it reads has changed. A selection that builds a new object each time costs
 * nothing more: what React compares is the stamp, never the selection.
 */
export function useStore<S extends object, T>(store: Store<S>, select: (slices: Readonly<S>) => T): T {
  const stamp = (): string => store.stamp(select);
  useSyncExternalStore(store.subscribe, stamp, stamp);
  return select(store.get());
}
