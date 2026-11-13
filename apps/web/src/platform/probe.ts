/*
 * The read-only probe the browser suite reads the interface's state through
 * (ADR-092).
 *
 * The page publishes nothing on window. A test that needs to see what the
 * screen is built from -- where the graph's camera is, which limits the
 * server sent -- asks this probe, and the probe exists only when the test
 * harness asked for it: the harness sets the marker before the page's first
 * script runs, and the application reads it once and deletes it before any
 * other module of its own is evaluated. Without the marker nothing is
 * defined, so a production page carries no probe and no way to ask for one
 * afterwards.
 *
 * What it answers is a copy, never the state itself: plain data only (no
 * element, no function, no live collection), frozen all the way down, and
 * only the fields the allowlist below names for each source. A test can read
 * the interface; it cannot steer it. Nothing secret is on the list: no token,
 * no CSRF value, no step-up grant, no repository content.
 */

/* Set by the harness before the page's first script, and deleted at boot. */
const MARKER = '__NV_HARNESS__';
/* Defined only when the marker asked for it. */
const PROBE = '__NV_PROBE__';
/* How deep a copy follows nested data; anything deeper is left out. */
const DEPTH_LIMIT = 8;

/* Every source the probe can read, and the fields of each it may show. */
export const PROBE_ALLOWLIST = Object.freeze({
  /* The Neural graph: its camera, its layout and what is drawn. */
  neural: Object.freeze([
    'active', 'paused', 'width', 'height', 'zoom', 'panX', 'panY', 'camTarget', 'userCamera', 'insets',
    'nodes', 'panels', 'selected', 'focusGroup', 'layoutMode', 'fieldState', 'frames', 'lastDraw', 'raf',
    'interacting'
  ]),
  /* The transfer limits the server sent, and whether all of them are known. */
  runtime: Object.freeze(['uploadMaxMb', 'gitDataMaxMb', 'nativePushMaxMb', 'contentsMaxMb', 'known']),
  /* The design's WebGL pieces on the page: whether each holds a still frame, runs its loop, and how many frames it has drawn. */
  artwork: Object.freeze(['pieces'])
});

export type ProbeSource = keyof typeof PROBE_ALLOWLIST;

const isSource = (name: string): name is ProbeSource => Object.prototype.hasOwnProperty.call(PROBE_ALLOWLIST, name);

/* Read once, at the first import, and removed whatever it held. */
const asked: boolean = (() => {
  if (typeof window === 'undefined' || !Object.prototype.hasOwnProperty.call(window, MARKER)) return false;
  const value = Reflect.get(window, MARKER) === true;
  Reflect.deleteProperty(window, MARKER);
  return value;
})();

const sources = new Map<ProbeSource, () => unknown>();

/* Whether a value is data a test may hold a copy of: no element, canvas, path or class instance. */
function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/*
 * A plain, frozen copy. Arrays and plain objects are followed, a Set becomes
 * the array of its members, and a value reached twice is the same copy both
 * times, so a graph that refers back to itself copies without looping.
 * Functions, elements and every other instance are left out.
 */
function copy(value: unknown, depth: number, seen: Map<object, unknown>): unknown {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint' ? undefined : value;
  }
  const known = seen.get(value);
  if (known !== undefined) return known;
  if (depth >= DEPTH_LIMIT) return undefined;
  if (Array.isArray(value) || value instanceof Set) {
    const out: unknown[] = [];
    seen.set(value, out);
    for (const item of value) out.push(copy(item, depth + 1, seen));
    return Object.freeze(out);
  }
  if (!isPlainObject(value)) return undefined;
  const out: Record<string, unknown> = {};
  seen.set(value, out);
  for (const [key, item] of Object.entries(value)) {
    const copied = copy(item, depth + 1, seen);
    if (copied !== undefined) out[key] = copied;
  }
  return Object.freeze(out);
}

/* What one source shows now: its allowlisted fields, copied, or null before the source exists. */
function read(name: unknown): unknown {
  if (typeof name !== 'string' || !isSource(name)) throw new TypeError(`The probe has no source named ${String(name)}`);
  const source = sources.get(name);
  if (!source) return null;
  const value = source();
  if (value === null || typeof value !== 'object') return null;
  const seen = new Map<object, unknown>();
  const out: Record<string, unknown> = {};
  for (const field of PROBE_ALLOWLIST[name]) {
    const copied = copy(Reflect.get(value, field), 1, seen);
    out[field] = copied === undefined ? null : copied;
  }
  return Object.freeze(out);
}

/*
 * Name a source the probe may read. Outside the harness this keeps nothing,
 * so the production page holds no reference the probe could have used.
 */
export function probeSource(name: ProbeSource, current: () => unknown): void {
  if (asked) sources.set(name, current);
}

if (asked) {
  Object.defineProperty(window, PROBE, {
    value: Object.freeze({ read }),
    enumerable: false,
    writable: false,
    configurable: false
  });
}
