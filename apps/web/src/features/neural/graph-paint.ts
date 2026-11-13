/*
 * The colours the Neural map is drawn in: a palette for each design preset
 * and theme, and the arithmetic on colours the drawing does.
 */

export type Design = 'nebula' | 'obsidian';
export type Theme = 'light' | 'dark';

export interface HubTone {
  readonly halo: string;
  readonly orb: readonly [string, string, string];
  readonly glow: string;
  readonly rim: string;
  readonly rimOn: string;
  readonly arc: string;
  readonly arcOuter: string;
  readonly light: readonly [string, string];
  readonly deep: readonly [string, string];
  readonly label: string;
}

export interface Palette {
  /* Names the design and the theme, so a change of either redraws the graph. */
  readonly theme: string;
  readonly light: boolean;
  readonly surface: string;
  readonly grid: string;
  readonly ring: string;
  readonly panel: string;
  readonly panelEdge: number;
  readonly text: string;
  readonly muted: string;
  readonly row: string;
  /* A group's colour as ink on this ground. */
  readonly ink: (color: string) => string;
  /* Whether light adds: the dark grounds glow, the light ones do not. */
  readonly glow: boolean;
  /* The field's colour as r,g,b, and its dots' and mesh's strengths. */
  readonly field: string;
  readonly fieldBase: number;
  readonly fieldDot: number;
  readonly fieldLine: number;
  readonly hub: HubTone;
  readonly spine: string;
}

/* A near-white type colour (identities) cannot be darkened into contrast on
 * a white ground, so the light theme draws it in slate instead. */
export function luminanceOf(hex: string): number {
  const h = String(hex).replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(h)) return 0;
  const v = parseInt(h, 16);
  return (.2126 * (v >> 16) + .7152 * ((v >> 8) & 255) + .0722 * (v & 255)) / 255;
}

export function hexAlpha(hex: string, alpha: number): string {
  /* Ink can arrive as rgb() -- the light palettes darken a group's colour --
   * and returning it unchanged painted a pager button solid in its own
   * chevron's colour, so the chevron vanished into a filled disc. */
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(String(hex));
  if (rgb) return `rgba(${rgb[1]},${rgb[2]},${rgb[3]},${alpha})`;
  const h = String(hex).replace('#', '');
  if (!/^[0-9a-f]{3}([0-9a-f]{3})?$/i.test(h)) return hex;
  const v = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return `rgba(${v >> 16},${(v >> 8) & 255},${v & 255},${alpha})`;
}

export function darken(hex: string, amount: number): string {
  const h = String(hex).replace('#', '');
  const v = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  const f = 1 - amount;
  return `rgb(${Math.round((v >> 16) * f)},${Math.round(((v >> 8) & 255) * f)},${Math.round((v & 255) * f)})`;
}

/*
 * Two design presets. Nebula's panels are indigo glass with indigo ink;
 * Obsidian's are the stone's own surface -- warm charcoal ink on quartz, cool
 * ivory on obsidian.
 */
export function paletteFor(design: Design, theme: Theme): Palette {
  const light = theme === 'light';
  if (design !== 'obsidian') {
    return light ? {
      theme: 'nebula-light', light, surface: '#ffffff', grid: 'rgba(76,29,149,.08)', ring: 'rgba(124,58,237,.18)',
      panel: 'rgba(255,255,255,.9)', panelEdge: .38, text: '#1e1b4b', muted: '#5b5f7a', row: 'rgba(49,46,129,.05)',
      ink: color => (luminanceOf(color) > .78 ? '#475569' : darken(color, .28)), glow: false,
      field: '91,33,182', fieldBase: .12, fieldDot: .7, fieldLine: .26,
      hub: {
        halo: 'rgba(124,58,237,.2)', orb: ['#5b3fd0', '#2e1878', '#0f0830'], glow: 'rgba(124,58,237,.7)',
        rim: 'rgba(167,139,250,.45)', rimOn: 'rgba(196,181,253,.8)', arc: 'rgba(167,139,250,.6)', arcOuter: '#a78bfa',
        light: ['#d9ceff', '#8b74ff'], deep: ['#7a5cff', '#3a23a8'], label: 'rgba(91,33,182,.18)'
      },
      spine: '#7c3aed'
    } : {
      theme: 'nebula-dark', light, surface: '#0e0a22', grid: 'rgba(196,181,253,.07)', ring: 'rgba(167,139,250,.22)',
      panel: 'rgba(14,10,32,.8)', panelEdge: .34, text: '#eef0ff', muted: '#9aa0c3', row: 'rgba(255,255,255,.035)',
      ink: color => color, glow: true,
      field: '196,181,253', fieldBase: .14, fieldDot: .92, fieldLine: .34,
      hub: {
        halo: 'rgba(124,58,237,.42)', orb: ['#5b3fd0', '#2e1878', '#0f0830'], glow: 'rgba(124,58,237,.7)',
        rim: 'rgba(167,139,250,.45)', rimOn: 'rgba(196,181,253,.8)', arc: 'rgba(167,139,250,.6)', arcOuter: '#a78bfa',
        light: ['#d9ceff', '#8b74ff'], deep: ['#7a5cff', '#3a23a8'], label: 'rgba(196,181,253,.3)'
      },
      spine: '#a78bfa'
    };
  }
  return light ? {
    theme: 'obsidian-light', light, surface: '#fbfaf8', grid: 'rgba(41,37,36,.07)', ring: 'rgba(120,108,98,.22)',
    panel: 'rgba(255,255,255,.9)', panelEdge: .34, text: '#1c1917', muted: '#6b645d', row: 'rgba(41,37,36,.045)',
    ink: color => (luminanceOf(color) > .78 ? '#57534e' : darken(color, .3)), glow: false,
    field: '41,37,36', fieldBase: .1, fieldDot: .62, fieldLine: .22,
    /* Obsidian's hub is a stone: a graphite sphere with the mark cut in
     * silver, lit white rather than violet. */
    hub: {
      halo: 'rgba(28,25,23,.1)', orb: ['#4a4b52', '#232428', '#0b0c0e'], glow: 'rgba(28,25,23,.28)',
      rim: 'rgba(28,25,23,.28)', rimOn: 'rgba(28,25,23,.55)', arc: 'rgba(41,37,36,.45)', arcOuter: '#57534e',
      light: ['#fafaf9', '#b5b0aa'], deep: ['#8a847e', '#35312d'], label: 'rgba(28,25,23,.14)'
    },
    spine: '#57534e'
  } : {
    theme: 'obsidian-dark', light, surface: '#0c0d10', grid: 'rgba(226,232,240,.055)', ring: 'rgba(203,213,225,.17)',
    panel: 'rgba(14,15,19,.84)', panelEdge: .3, text: '#eceef1', muted: '#9aa1ab', row: 'rgba(255,255,255,.04)',
    ink: color => color, glow: true,
    field: '236,238,241', fieldBase: .12, fieldDot: .85, fieldLine: .27,
    hub: {
      halo: 'rgba(226,232,240,.12)', orb: ['#4a4b52', '#1f2024', '#0a0b0d'], glow: 'rgba(226,232,240,.18)',
      rim: 'rgba(255,255,255,.2)', rimOn: 'rgba(255,255,255,.55)', arc: 'rgba(226,232,240,.5)', arcOuter: '#d4d4d8',
      light: ['#fafaf9', '#b5b0aa'], deep: ['#8a847e', '#35312d'], label: 'rgba(255,255,255,.18)'
    },
    spine: '#d4d4d8'
  };
}
