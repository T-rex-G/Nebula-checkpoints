/*
 * The pieces every audit card is drawn with: a mark, a chip that says its
 * status in a shape and a word, the score's ring, Uranus's mark and its
 * loader, a card that folds to its heading, and the export menu. Each draws
 * the same elements, classes, roles and names the screen drew when it was
 * built node by node (ADR-093).
 */
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { KeyboardEvent, ReactElement, ReactNode } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

import { ICON } from './audit-marks.ts';
import type { Chip, ExportKind, Ring } from './audit-screen.ts';

/* ---- Marks and chips -------------------------------------------------------------- */

export function Icon({ path, className = 'audit-ico' }: { readonly path: string; readonly className?: string }): ReactElement {
  return <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className={className}><path d={path} /></svg>;
}

/*
 * A status as an outline: the tone on its edge and its glyph, the words in
 * ink. A beam sends light round the edge, for the few statuses the eye
 * should go to first.
 */
export function ChipView({ chip, role, family, severity }: { readonly chip: Chip; readonly role?: string; readonly family?: string; readonly severity?: string }): ReactElement {
  const counted = chip.count !== undefined;
  return (
    <span
      className={`nv-chip${chip.large ? ' nv-chip-lg' : ''}${chip.className ? ` ${chip.className}` : ''}`}
      data-tone={chip.tone}
      data-beam={chip.beam ? 'on' : undefined}
      data-zero={chip.zero ? 'true' : undefined}
      data-family={family}
      data-severity={severity}
      role={role}
      title={chip.title}
    >
      {chip.glyph ? <Icon path={chip.glyph} /> : null}
      {counted ? <b>{String(chip.count)}</b> : null}
      {/* A space the flex layout ignores, so the chip reads "3 serious" to a screen reader and a copy. */}
      {counted && chip.word ? ' ' : null}
      {chip.word ? <span>{chip.word}</span> : null}
    </span>
  );
}

/* Whether the reader asked for less motion: the page's own switch, or the system's. */
export function reducedMotion(): boolean {
  return document.documentElement.dataset.motion === 'off' ||
    (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

/*
 * The score as a ring: the arc is the score, the letter the grade. The arc
 * grows into place once, when a reading first arrives, and not on a redraw
 * that only changed a filter.
 */
export function RingView({ ring, fresh }: { readonly ring: Ring; readonly fresh: boolean }): ReactElement {
  const arc = useRef<SVGCircleElement>(null);
  const [start] = useState(() => (fresh && !reducedMotion() ? 0 : ring.score));
  useLayoutEffect(() => {
    if (start === ring.score) return undefined;
    let second = 0;
    const first = window.requestAnimationFrame(() => {
      second = window.requestAnimationFrame(() => { if (arc.current) arc.current.style.strokeDasharray = `${ring.score} 100`; });
    });
    return () => { window.cancelAnimationFrame(first); window.cancelAnimationFrame(second); };
  }, [start, ring.score]);
  return (
    <div className={`audit-grade audit-grade-${ring.grade}`} role="img" aria-label={ring.label} data-running={ring.running ? 'true' : undefined}>
      <svg viewBox="0 0 120 120" aria-hidden="true" className="audit-ring">
        <circle cx="60" cy="60" r="52" pathLength={100} className="audit-ring-track" />
        <circle ref={arc} cx="60" cy="60" r="52" pathLength={100} className="audit-ring-arc" transform="rotate(-90 60 60)"
          style={{ strokeDasharray: `${start === ring.score ? ring.score : start} 100` }} data-empty={ring.empty ? 'true' : undefined} />
      </svg>
      <div className="audit-grade-face">
        <span className="audit-grade-letter">{ring.letter}</span>
        <span className="audit-grade-score">{ring.said}</span>
      </div>
    </div>
  );
}

/* Uranus's mark: a planet turned on its side, its ring near upright. */
export function UranusMark({ className = 'audit-ico uranus-mark' }: { readonly className?: string }): ReactElement {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className={className}>
      <circle cx="12" cy="12" r="5.2" />
      <path d="M7.4 10.4c3 1.2 6.2 1.2 9.2 0" />
      <ellipse cx="12" cy="12" rx="10.4" ry="2.5" transform="rotate(-76 12 12)" />
    </svg>
  );
}

interface Dot {
  readonly cx: string;
  readonly cy: string;
  readonly r: string;
  readonly lit?: string;
  readonly col?: string;
  readonly index?: string;
  readonly back?: boolean;
}
/*
 * While Uranus reads: a planet of dots lit from one side, so it reads as a
 * sphere, and its near-upright ring of dots lit one after another, the far
 * side hidden where the planet stands in front of it. It says "working" and
 * nothing more: the screen does not invent the progress it cannot see.
 */
const LOADER: { readonly planet: readonly Dot[]; readonly ring: readonly Dot[] } = (() => {
  const radius = 31;
  const light = [-0.52, -0.58, 0.63] as const;
  const planet: Dot[] = [];
  const step = 6.2;
  for (let row = -5; row <= 5; row += 1) {
    for (let col = -5; col <= 5; col += 1) {
      const x = col * step;
      const y = row * step;
      if (Math.hypot(x, y) > radius) continue;
      const nx = x / radius;
      const ny = y / radius;
      const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
      const lit = Math.max(0, nx * light[0] + ny * light[1] + nz * light[2]);
      planet.push({ cx: (60 + x).toFixed(1), cy: (60 + y).toFixed(1), r: (0.95 + lit * 1.25).toFixed(2), lit: (0.34 + lit * 0.66).toFixed(2), col: String(col + 5) });
    }
  }
  const ring: Dot[] = [];
  const tilt = -76 * Math.PI / 180;
  const count = 34;
  for (let index = 0; index < count; index += 1) {
    const angle = (index / count) * Math.PI * 2;
    const lx = Math.cos(angle) * 55;
    const ly = Math.sin(angle) * 12.5;
    const x = lx * Math.cos(tilt) - ly * Math.sin(tilt);
    const y = lx * Math.sin(tilt) + ly * Math.cos(tilt);
    const back = Math.sin(angle) < 0;
    /* The planet hides the far half of the ring where it stands in front of it. */
    if (back && Math.hypot(x, y) < radius + 2) continue;
    ring.push({ cx: (60 + x).toFixed(1), cy: (60 + y).toFixed(1), r: back ? '1.25' : '1.7', index: String(index), back });
  }
  return { planet, ring };
})();
export function UranusLoader(): ReactElement {
  return (
    <div className="uranus-loader" aria-hidden="true">
      <svg viewBox="0 0 120 120" className="uranus-loader-art">
        <g className="uranus-loader-planet">
          {LOADER.planet.map(dot => <circle key={`${dot.cx},${dot.cy}`} cx={dot.cx} cy={dot.cy} r={dot.r} style={{ '--lit': dot.lit, '--col': dot.col }} />)}
        </g>
        <g className="uranus-loader-ring">
          {LOADER.ring.map(dot => <circle key={dot.index} cx={dot.cx} cy={dot.cy} r={dot.r} style={{ '--i': dot.index }} className={dot.back ? 'is-back' : undefined} />)}
        </g>
      </svg>
    </div>
  );
}

/* ---- Folding ------------------------------------------------------------------------ */

/*
 * Every section below the summary folds to its heading. Which ones are
 * folded is kept for this browser by section name only -- never a
 * repository, a path or a finding -- so a redraw, the next audit and the
 * next visit find the page as the reader left it. A folded body leaves the
 * tab order and the accessibility tree; the toggle says which way it will go.
 */
const FOLD_STORE = 'nv_ui:audit-folded';
export const FOLDS: readonly string[] = Object.freeze(['watch', 'first', 'risk', 'families', 'surface', 'licences', 'coverage', 'controls', 'owasp', 'findings', 'remediation', 'history', 'site']);
const folded = new Set<string>();
try {
  const stored: unknown = JSON.parse(window.localStorage.getItem(FOLD_STORE) || '[]');
  if (Array.isArray(stored)) for (const id of stored) if (typeof id === 'string' && FOLDS.includes(id)) folded.add(id);
} catch { /* no storage: every section starts open */ }
const foldListeners = new Set<() => void>();
let foldVersion = 0;
function foldsChanged(): void {
  foldVersion += 1;
  try { window.localStorage.setItem(FOLD_STORE, JSON.stringify([...folded])); } catch { /* the choice lasts this page */ }
  for (const listener of foldListeners) listener();
}
function subscribeFolds(listener: () => void): () => void {
  foldListeners.add(listener);
  return () => { foldListeners.delete(listener); };
}
/* Opens a section that something is about to show a result in. */
export function unfold(id: string): void {
  if (folded.delete(id)) foldsChanged();
}
function useFolded(id: string): boolean {
  useSyncExternalStore(subscribeFolds, () => foldVersion, () => foldVersion);
  return folded.has(id);
}

/*
 * A card that folds to its head: the toggle goes at the end of the head, and
 * everything after the head goes in the folding body. `name` is what the
 * toggle folds, in words.
 */
export function Foldable({ as = 'section', className, id, name, labelledBy, head, headClassName, data, children }: {
  readonly as?: 'section';
  readonly className: string;
  readonly data?: { readonly [attribute: `data-${string}`]: string | undefined };
  readonly id: string;
  readonly name: string;
  readonly labelledBy: string;
  readonly head: ReactNode;
  readonly headClassName: string;
  readonly children: ReactNode;
}): ReactElement {
  const isFolded = useFolded(id);
  const open = !isFolded;
  const Tag = as;
  return (
    <Tag className={`${className} audit-foldable`} aria-labelledby={labelledBy} {...data} data-fold={id} data-folded={open ? 'false' : 'true'}>
      <div className={headClassName}>
        {head}
        <button
          type="button"
          className="audit-fold-toggle"
          data-key={`fold:${id}`}
          data-name={name}
          aria-controls={`auditFold-${id}`}
          aria-expanded={open ? 'true' : 'false'}
          aria-label={`${open ? 'Collapse' : 'Expand'} ${name}`}
          title={open ? 'Collapse' : 'Expand'}
          onClick={() => {
            if (open) folded.add(id); else folded.delete(id);
            foldsChanged();
          }}
        ><Icon path={ICON.chevron} className="audit-ico audit-fold-chev" /></button>
      </div>
      <div className="audit-fold" id={`auditFold-${id}`} inert={!open}>
        <div className="audit-fold-inner">{children}</div>
      </div>
    </Tag>
  );
}

/* A list longer than its fold shows the first rows; "Show all" shows the rest, and a redraw remembers it by reading. */
const expanded = new Set<string>();
export function useExpanded(key: string): readonly [boolean, () => void] {
  const [, redraw] = useState(0);
  return [expanded.has(key), () => { expanded.add(key); redraw(value => value + 1); }];
}

/* ---- Export -------------------------------------------------------------------------- */

const EXPORTS: readonly (readonly [ExportKind, string, string, string, string])[] = Object.freeze([
  ['brief', ICON.markdown, 'Developer brief', 'Markdown for a person or an assistant', 'Export developer brief'],
  ['sarif', ICON.sarif, 'SARIF 2.1.0', 'For GitHub code scanning and other dashboards', 'Export SARIF'],
  ['csv', ICON.table, 'CSV', 'For a spreadsheet or a tracker import', 'Export CSV'],
  ['cyclonedx', ICON.box, 'SBOM · CycloneDX 1.5', 'Every package, its licence and its vulnerabilities', 'Export CycloneDX SBOM'],
  ['spdx', ICON.box, 'SBOM · SPDX 2.3', 'The same bill of materials, for licence and procurement tools', 'Export SPDX SBOM']
] as const);
/* One menu is open at a time: opening one closes the other. */
let closeOpenMenu: (() => void) | null = null;

/*
 * The export menu: a button that opens a small menu; Escape, a click
 * elsewhere or a choice closes it. While open the menu lives on the body: a
 * card's blur makes it the frame a fixed child is placed in, and its edge
 * would cut the menu off. It is placed against the viewport, under the
 * button when there is room and above it when there is not.
 */
function ExportControls({ onExport, menuKey, kinds, wrap }: {
  readonly onExport: (kind: ExportKind) => void;
  readonly menuKey: string;
  readonly kinds: readonly ExportKind[] | null;
  readonly wrap: { readonly current: HTMLElement | null };
}): ReactElement {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const returnFocus = useRef(false);
  const shown = EXPORTS.filter(([kind]) => !kinds || kinds.includes(kind));
  const close = (focus = false): void => { returnFocus.current = focus; setOpen(false); };
  useLayoutEffect(() => {
    if (!open) {
      if (returnFocus.current) { returnFocus.current = false; trigger.current?.focus(); }
      return undefined;
    }
    const shut = (): void => { flushSync(() => setOpen(false)); };
    if (closeOpenMenu && closeOpenMenu !== shut) closeOpenMenu();
    closeOpenMenu = shut;
    const place = (): void => {
      const box = trigger.current?.getBoundingClientRect();
      const node = menu.current;
      if (!box || !node) return;
      const width = Math.min(290, window.innerWidth - 24);
      node.style.width = `${width}px`;
      node.style.left = `${Math.max(12, Math.min(box.left, window.innerWidth - width - 12))}px`;
      const below = window.innerHeight - box.bottom;
      const height = node.offsetHeight || 190;
      node.style.top = below < height + 16 && box.top > height + 16 ? `${box.top - height - 6}px` : `${box.bottom + 6}px`;
    };
    place();
    items.current[0]?.focus({ preventScroll: true });
    const outside = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (!wrap.current?.contains(target) && !menu.current?.contains(target)) shut();
    };
    /* A scroll carries the menu with its button; once the button is off screen, the menu goes. */
    let frame = 0;
    const follow = (): void => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const box = trigger.current?.getBoundingClientRect();
        if (!trigger.current?.isConnected || !box || box.bottom < 0 || box.top > window.innerHeight) shut();
        else place();
      });
    };
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', follow);
    window.addEventListener('scroll', follow, true);
    return () => {
      if (closeOpenMenu === shut) closeOpenMenu = null;
      if (frame) window.cancelAnimationFrame(frame);
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', follow);
      window.removeEventListener('scroll', follow, true);
    };
  }, [open, wrap]);
  const keys = (event: KeyboardEvent): void => {
    if (!open) return;
    const at = items.current.findIndex(item => item === document.activeElement);
    const focus = (index: number): void => { items.current[index]?.focus(); };
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); focus((at + 1) % shown.length); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); focus((at - 1 + shown.length) % shown.length); }
    else if (event.key === 'Home') { event.preventDefault(); focus(0); }
    else if (event.key === 'End') { event.preventDefault(); focus(shown.length - 1); }
    else if (event.key === 'Tab') close();
  };
  const list = (
    <div ref={menu} className="audit-export-menu" role="menu" hidden={!open} onKeyDown={open ? keys : undefined}>
      {shown.map(([kind, path, word, hint, name], index) => (
        <button
          key={kind}
          ref={node => { items.current[index] = node; }}
          type="button"
          className="audit-export-item"
          role="menuitem"
          aria-label={name}
          tabIndex={-1}
          onClick={() => { close(); onExport(kind); }}
        ><Icon path={path} /><span className="audit-export-text"><span className="audit-export-word">{word}</span><span className="audit-export-hint">{hint}</span></span></button>
      ))}
    </div>
  );
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="btn btn-ghost audit-tool audit-export-btn"
        data-key={menuKey}
        aria-haspopup="menu"
        aria-expanded={open ? 'true' : 'false'}
        aria-label="Export"
        title="Export"
        onClick={() => setOpen(value => !value)}
        onKeyDown={keys}
      ><Icon path={ICON.download} /><span className="audit-btn-label">Export</span><Icon path={ICON.chevron} className="audit-ico audit-export-chev" /></button>
      {open ? createPortal(list, document.body) : list}
    </>
  );
}

export function ExportMenu({ onExport, menuKey, kinds }: {
  readonly onExport: (kind: ExportKind) => void;
  readonly menuKey: string;
  readonly kinds: readonly ExportKind[] | null;
}): ReactElement {
  const wrap = useRef<HTMLDivElement>(null);
  return <div ref={wrap} className="audit-export"><ExportControls onExport={onExport} menuKey={menuKey} kinds={kinds} wrap={wrap} /></div>;
}

/*
 * The export menu for a screen still built node by node (the Exposure
 * screen): its own element, drawn into by React, with the same parts.
 */
export function exportMenu(onExport: (kind: ExportKind) => void, key: string, kinds: readonly ExportKind[] | null): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'audit-export';
  const root = createRoot(wrap);
  flushSync(() => root.render(<ExportControls onExport={onExport} menuKey={key} kinds={kinds} wrap={{ current: wrap }} />));
  return wrap;
}
