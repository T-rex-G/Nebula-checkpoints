/*
 * The Overview's charts, as geometry: where every mark goes, decided before
 * anything is drawn, so it can be checked without a page. The area chart and
 * the radar are drawn from these by pulse-charts.tsx.
 */
import type { LanguageAxis } from './workspace-pulse.ts';

export interface Point {
  readonly x: number;
  readonly y: number;
}

const round = (value: number): number => Math.round(value * 10) / 10;

/*
 * A monotone curve, not a spline.
 *
 * The block this composition follows uses a curved line. The usual way to
 * get one -- Catmull-Rom through the points -- can overshoot: its tangents
 * are set from the neighbours without regard to direction, so between a zero
 * and a spike the curve is free to swing past both, and a chart of counts
 * can draw itself going negative.
 *
 * Fritsch-Carlson clamps each tangent where the direction changes and zeroes
 * it across flat runs, so the curve provably cannot leave the interval its
 * own readings define. It is chosen for that property rather than for a
 * defect observed here: against this product's series -- a trailing count,
 * which moves as plateaus rather than isolated spikes -- both fits measure
 * the same, and no fixture was found where the unclamped one leaves the
 * plot. The guarantee is the point. A future series with sharper steps is
 * exactly the case that would have needed it, and it will not be obvious
 * that it did.
 */
export function monotonePath(points: readonly Point[]): string {
  const first = points[0];
  if (!first) return '';
  if (points.length < 2) return `M${first.x},${first.y}`;
  const n = points.length;
  const at = (index: number): Point => points[index] ?? first;
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i += 1) {
    const dx = at(i + 1).x - at(i).x;
    slope.push(dx === 0 ? 0 : (at(i + 1).y - at(i).y) / dx);
  }
  const slopeAt = (index: number): number => slope[index] ?? 0;
  const tangent: number[] = [slopeAt(0)];
  for (let i = 1; i < n - 1; i += 1) {
    /* A turning point: a zero tangent is what stops the curve carrying its previous direction past the reading and overshooting it. */
    tangent.push(slopeAt(i - 1) * slopeAt(i) <= 0 ? 0 : (slopeAt(i - 1) + slopeAt(i)) / 2);
  }
  tangent.push(slopeAt(n - 2));
  for (let i = 0; i < n - 1; i += 1) {
    const s = slopeAt(i);
    if (s === 0) { tangent[i] = 0; tangent[i + 1] = 0; continue; }
    const a = (tangent[i] ?? 0) / s;
    const b = (tangent[i + 1] ?? 0) / s;
    const h = Math.hypot(a, b);
    if (h > 3) {
      tangent[i] = (3 / h) * a * s;
      tangent[i + 1] = (3 / h) * b * s;
    }
  }
  let path = `M${first.x},${first.y}`;
  for (let i = 0; i < n - 1; i += 1) {
    const from = at(i);
    const to = at(i + 1);
    const dx = (to.x - from.x) / 3;
    path += ` C${round(from.x + dx)},${round(from.y + (tangent[i] ?? 0) * dx)}`
      + ` ${round(to.x - dx)},${round(to.y - (tangent[i + 1] ?? 0) * dx)}`
      + ` ${to.x},${to.y}`;
  }
  return path;
}

/*
 * The spacing at which a dot is still its own mark rather than a bead on a
 * chain. Below this the line is left to carry the shape by itself.
 */
export const DOT_SPACING = 12;

export interface AxisMark {
  readonly index: number;
  readonly label: string;
}

export interface AreaOptions {
  readonly width?: number;
  /* The card's header carries the figure, so the endpoint does not print it again. */
  readonly headline?: boolean;
  readonly labels?: readonly string[];
  readonly axis?: readonly AxisMark[];
}

export interface AreaPlan {
  readonly width: number;
  readonly height: number;
  readonly padX: number;
  readonly padTop: number;
  readonly baseY: number;
  readonly step: number;
  readonly points: readonly Point[];
  readonly grid: readonly number[];
  readonly curve: string;
  readonly area: string;
  readonly dots: boolean;
  readonly readout: { readonly x: number; readonly y: number; readonly anchor: 'end' | 'middle'; readonly text: string } | null;
  readonly axis: readonly { readonly x: number; readonly y: number; readonly anchor: 'start' | 'middle' | 'end'; readonly label: string }[];
}

/*
 * The area chart.
 *
 * Not stretched. preserveAspectRatio="none" made the card's width scale the
 * viewBox horizontally and not vertically, so a 2-unit stroke arrived on
 * screen as a 2-unit vertical and a much thinner horizontal, and every
 * circle came out an ellipse. The box keeps its ratio now and the marks are
 * simply the size they say they are.
 *
 * Drawn at the width it will be shown at. A fixed 380-unit box scaled to a
 * card three times that wide arrived with its axis labels at three times
 * their size, its dots as coins and its stroke as a bar: every mark grew with
 * the card. With the box matched to the card, a unit is a pixel, and the plot
 * grows taller only in step and within bounds.
 */
export function areaPlan(values: readonly number[], options: AreaOptions = {}): AreaPlan {
  const width = Math.max(280, Math.min(1600, Math.round(options.width || 380)));
  const plotH = Math.round(Math.max(96, Math.min(176, width * 0.2)));
  const padX = 16;
  const padTop = 14;
  /* The band the x labels sit in is part of the box. A container sized to the plot alone gives the card its own small vertical scrollbar. */
  const axisBand = 18;
  const height = padTop + plotH + axisBand;
  const plotW = width - padX * 2;
  const peak = Math.max(...values, 1);
  const step = values.length > 1 ? plotW / (values.length - 1) : plotW;
  const at = (value: number, index: number): Point => ({
    x: round(padX + index * step),
    y: round(padTop + (1 - value / peak) * plotH)
  });
  const points = values.map(at);
  const baseY = padTop + plotH;
  const curve = monotonePath(points);
  const last = points[points.length - 1];
  const latest = values[values.length - 1];
  return {
    width,
    height,
    padX,
    padTop,
    baseY,
    step,
    points,
    /* Three lines: the peak, the middle and the floor. More than that on a 96-unit plot is chrome competing with the series. */
    grid: [0, 0.5, 1].map(fraction => round(padTop + fraction * plotH)),
    curve,
    area: `${curve} L${width - padX},${baseY} L${padX},${baseY} Z`,
    /*
     * Dots only when they can be read as dots. At the sixty-day window the
     * readings are under six units apart, and a dot on each is not sixty
     * marks, it is a bead chain laid over the line -- chrome pretending to be
     * data. A value is never printed on every point either way.
     */
    dots: step >= DOT_SPACING,
    /*
     * The endpoint is labelled only when nothing above it already says the
     * number. With the header carrying the figure, a readout here prints it
     * twice within a couple of centimetres -- and a reader who sees the same
     * value in two places starts looking for the difference between them.
     */
    readout: last && latest !== undefined && !options.headline
      ? {
        x: Math.min(last.x, width - padX - 2),
        y: Math.max(last.y - 10, 10),
        anchor: last.x > width - padX - 24 ? 'end' : 'middle',
        text: String(latest)
      }
      : null,
    axis: (options.axis || []).map(mark => ({
      x: at(0, mark.index).x,
      y: height - 5,
      anchor: mark.index === 0 ? 'start' : mark.index === values.length - 1 ? 'end' : 'middle',
      label: mark.label
    }))
  };
}

/* Which reading a pointer over the plot is nearest, from its x in the chart's own units. */
export function readingAt(plan: Pick<AreaPlan, 'padX' | 'step' | 'points'>, x: number): number {
  return Math.max(0, Math.min(plan.points.length - 1, Math.round((x - plan.padX) / plan.step)));
}

/*
 * The length of a path drawn by monotonePath, measured along its curves. The
 * reveal hides the line behind a dash this long; a dash shorter than the path
 * leaves its tail drawn before the reveal starts, so each curve is walked
 * finely and the sum is never short of the curve by more than a hair.
 */
export function curveLength(path: string): number {
  const numbers = (path.match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g) || []).map(Number);
  if (numbers.length < 2) return 0;
  let x = numbers[0] ?? 0;
  let y = numbers[1] ?? 0;
  let total = 0;
  for (let index = 2; index + 5 < numbers.length; index += 6) {
    const [c1x = 0, c1y = 0, c2x = 0, c2y = 0, ex = 0, ey = 0] = numbers.slice(index, index + 6);
    let px = x;
    let py = y;
    const SEGMENTS = 64;
    for (let step = 1; step <= SEGMENTS; step += 1) {
      const t = step / SEGMENTS;
      const u = 1 - t;
      const qx = u * u * u * x + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * ex;
      const qy = u * u * u * y + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * ey;
      total += Math.hypot(qx - px, qy - py);
      px = qx;
      py = qy;
    }
    x = ex;
    y = ey;
  }
  /* A curve walked in chords is a hair short of the curve, and the hair grows with the curve: the dash is made a little longer than the walk. */
  return numbers.length > 2 ? Math.ceil(total * 1.002) + 1 : 0;
}

/*
 * A language name is as long as it is. "TypeScript" at the nine-o'clock spoke
 * is anchored to its end, so it grows leftwards from the web -- and in a
 * square box it grew straight off the edge and arrived as "eScript". The box
 * is wider than it is tall, with the extra width spent entirely on the
 * gutters the side labels sit in, and anything past the cap is elided with
 * its full name kept on the mark.
 */
export const RADAR_LABEL_MAX = 13;

export interface RadarSpoke {
  readonly axis: LanguageAxis;
  readonly outer: Point;
  readonly vertex: Point;
  readonly label: { readonly x: number; readonly y: number; readonly anchor: 'start' | 'middle' | 'end'; readonly text: string; readonly elided: boolean };
  readonly title: string;
}

export interface RadarPlan {
  readonly width: number;
  readonly height: number;
  readonly centre: Point;
  readonly rings: readonly string[];
  readonly collapsed: string;
  readonly full: string;
  readonly spokes: readonly RadarSpoke[];
}

/*
 * The box is cut to what is drawn in it: the web and its labels reach 87
 * units from the centre and a label's own height past that, so 214 tall
 * holds them with a margin. Starts at twelve o'clock: a polygon that begins
 * at three reads as rotated, and a reader compares spokes against vertical
 * without being asked to.
 */
export function radarPlan(axes: readonly LanguageAxis[]): RadarPlan {
  const width = 340;
  const height = 214;
  const centre = { x: width / 2, y: height / 2 };
  const radius = 74;
  const peak = Math.max(...axes.map(axis => axis.count), 1);
  const step = (Math.PI * 2) / Math.max(1, axes.length);
  const point = (index: number, ratio: number): Point => {
    const angle = -Math.PI / 2 + index * step;
    return { x: round(centre.x + Math.cos(angle) * radius * ratio), y: round(centre.y + Math.sin(angle) * radius * ratio) };
  };
  const ring = (ratio: number): string => axes.map((_, index) => {
    const at = point(index, ratio);
    return `${at.x},${at.y}`;
  }).join(' ');
  const shape = (index: number, axis: LanguageAxis): Point => point(index, axis.count / peak);
  return {
    width,
    height,
    centre,
    rings: [0.25, 0.5, 0.75, 1].map(ring),
    collapsed: ring(0),
    full: axes.map((axis, index) => { const at = shape(index, axis); return `${at.x},${at.y}`; }).join(' '),
    spokes: axes.map((axis, index) => {
      /* The label sits just past its own spoke, anchored by which side of the circle it is on, so nothing overlaps the web it belongs to. */
      const seat = point(index, 1.18);
      const elided = axis.label.length > RADAR_LABEL_MAX;
      return {
        axis,
        outer: point(index, 1),
        vertex: shape(index, axis),
        label: {
          x: seat.x,
          y: seat.y + 3,
          anchor: Math.abs(seat.x - centre.x) < 6 ? 'middle' : seat.x > centre.x ? 'start' : 'end',
          text: elided ? `${axis.label.slice(0, RADAR_LABEL_MAX - 1)}…` : axis.label,
          elided
        },
        title: `${axis.label}: ${axis.count} repositor${axis.count === 1 ? 'y' : 'ies'}${axis.folded ? ` across ${axis.folded} languages` : ''}`
      };
    })
  };
}
