/*
 * How the page looks: dark or light, the design preset, motion, and how the
 * editor writes.
 *
 * Two design presets, one product: Nebula (the default -- violet glass over
 * the nebula) and Obsidian (stone: near-black or quartz). The theme picks
 * dark or light within either. theme-boot.js applies the stored choices
 * before the first paint, so a reload never flashes the other look; this
 * applies them again once the page runs, keeps them, and changes them.
 *
 * A change of look is revealed rather than cut: the new one grows as a
 * circle from the control that asked for it, drawn by the browser's own view
 * transition on the compositor. Without the API, with motion off, or while a
 * layer is still leaving, the change is simply made.
 *
 * What is kept is read back only as what it may be: a design that is one of
 * the two, a size that is a number the editor can show, a theme and a font
 * the editor offers. Storage written by an older page, or by hand, is read
 * past, not applied.
 */
import type { EditorSettings } from '../../platform/page-state.ts';

export const DESIGNS = Object.freeze(['nebula', 'obsidian'] as const);
export type Design = (typeof DESIGNS)[number];
export type Theme = 'dark' | 'light';

/* The browser's own chrome, coloured to match each look. */
export const THEME_COLOR: Readonly<Record<Design, Readonly<Record<Theme, string>>>> = Object.freeze({
  nebula: Object.freeze({ dark: '#06030F', light: '#F5F3FB' }),
  obsidian: Object.freeze({ dark: '#07080A', light: '#F4F2EE' })
});

/* The editor's colour themes, as [CodeMirror name, what the reader is shown]. */
export const EDITOR_THEMES: readonly (readonly [string, string])[] = Object.freeze([
  ['material-ocean', 'Material Ocean'], ['dracula', 'Dracula'], ['monokai', 'Monokai'],
  ['nord', 'Nord'], ['ayu-mirage', 'Ayu Mirage'], ['base16-light', 'Base16 Light'], ['eclipse', 'Eclipse (light)']
] as const);
export const EDITOR_FONTS: readonly string[] = Object.freeze(['DM Mono', 'JetBrains Mono', 'Fira Code', 'Source Code Pro', 'IBM Plex Mono']);

/* The sizes the editor's text may take, in pixels: the settings' slider's own range. */
export const FONT_SIZES = Object.freeze({ min: 11, max: 20 });

export const isDesign = (value: unknown): value is Design => value === 'nebula' || value === 'obsidian';

/* The browser chrome's colour for a look; anything not obsidian is nebula, anything not light is dark. */
export function themeColor(design: unknown, theme: unknown): string {
  return THEME_COLOR[design === 'obsidian' ? 'obsidian' : 'nebula'][theme === 'light' ? 'light' : 'dark'];
}

/* The theme a press of the toggle turns to. */
export function nextTheme(current: unknown): Theme {
  return current === 'dark' ? 'light' : 'dark';
}

/*
 * The settings kept in storage, read as only what they may be: each a field
 * of the right kind and range, the rest left as it is. Nothing kept, and a
 * reader who asked their system for less motion, starts with motion off.
 */
export function settingsFrom(stored: unknown, reducedMotion: boolean): Partial<EditorSettings> {
  if (stored === null || stored === undefined) return reducedMotion ? { motion: false } : {};
  if (typeof stored !== 'object') return {};
  const read: Partial<EditorSettings> = {};
  const value = (name: keyof EditorSettings): unknown => Reflect.get(stored, name);
  const size = value('fontSize');
  if (typeof size === 'number' && Number.isFinite(size) && size >= FONT_SIZES.min && size <= FONT_SIZES.max) read.fontSize = size;
  for (const name of ['wrap', 'motion'] as const) {
    const flag = value(name);
    if (typeof flag === 'boolean') read[name] = flag;
  }
  const theme = value('editorTheme');
  if (typeof theme === 'string' && EDITOR_THEMES.some(([id]) => id === theme)) read.editorTheme = theme;
  const font = value('editorFont');
  if (typeof font === 'string' && EDITOR_FONTS.includes(font)) read.editorFont = font;
  const design = value('design');
  if (isDesign(design)) read.design = design;
  return read;
}

/* Where a revealed change grows from, and how far it must grow to cover the screen. */
export function revealCircle(box: { readonly left: number; readonly top: number; readonly width: number; readonly height: number } | null, width: number, height: number): { readonly x: number; readonly y: number; readonly radius: number } {
  const x = box ? box.left + box.width / 2 : width / 2;
  const y = box ? box.top + box.height / 2 : height / 2;
  return { x, y, radius: Math.hypot(Math.max(x, width - x), Math.max(y, height - y)) };
}

/* An arrow key in a radio group: one choice on (right, down) or back (left, up), or none. */
export function radioStep(key: string): -1 | 0 | 1 {
  if (key === 'ArrowRight' || key === 'ArrowDown') return 1;
  if (key === 'ArrowLeft' || key === 'ArrowUp') return -1;
  return 0;
}
