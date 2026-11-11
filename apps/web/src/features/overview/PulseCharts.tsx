/*
 * The Overview's charts, drawn: the area chart, the radar, the gauge and the
 * ring. Every position is pulse-charts.ts's; what is here is the drawing, the
 * motion and the pointer.
 *
 * All of it is ordinary SVG with no library behind it. The gradients are
 * named per chart, because two charts with the same id would have the second
 * silently paint with the first's ramp; the colours are the stylesheet's
 * (.wp-stroke-*, .wp-fade-stop, .wp-radar-fill-*), so a theme changed after a
 * chart is drawn changes the chart with it.
 */
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent, ReactElement } from 'react';
import { flushSync } from 'react-dom';

import { areaPlan, curveLength, radarPlan, readingAt } from './pulse-charts.ts';
import type { AreaOptions } from './pulse-charts.ts';
import type { LanguageAxis, Status } from './workspace-pulse.ts';

/* A chart is drawn again only when its card changes width by more than this. */
const REFIT_PX = 24;
const REVEAL_MS = 700;

let chartSequence = 0;
const nextId = (kind: string): string => `wp-${kind}-${chartSequence += 1}`;

/*
 * Motion has one owner on this page already -- the data-motion setting and
 * the OS preference -- so a chart asks rather than decides. A reveal that
 * ignores either is a chart that animates for a reader who asked it not to.
 */
export function motionAllowed(): boolean {
  if (typeof document === 'undefined' || document.documentElement.dataset.motion === 'off') return false;
  try {
    return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch { return true; }
}

/*
 * The shared marks a chart is drawn from: a stroke gradient along the series,
 * a fill that fades the same hue to nothing, and a soft outer glow drawn wide
 * enough to hold its blur -- a filter region defaults to a tenth of the box on
 * each side, which clips the bloom off the ends of a stroke that runs to the
 * edge and leaves a square shadow where the region stops.
 */
function AreaDefs({ id }: { id: string }): ReactElement {
  return (
    <defs>
      {/* One hue, dark to light along the series, so the latest end is the brightest. */}
      <linearGradient id={`${id}-s`} x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" className="wp-stroke-from" />
        <stop offset="100%" className="wp-stroke-to" />
      </linearGradient>
      <linearGradient id={`${id}-f`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" className="wp-fade-stop" stopOpacity=".34" />
        <stop offset="72%" className="wp-fade-stop" stopOpacity=".05" />
        <stop offset="100%" className="wp-fade-stop" stopOpacity="0" />
      </linearGradient>
      <filter id={`${id}-g`} x="-30%" y="-30%" width="160%" height="160%" filterUnits="objectBoundingBox">
        <feGaussianBlur in="SourceGraphic" stdDeviation="2.4" result="b" />
        <feMerge>
          <feMergeNode in="b" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
    </defs>
  );
}

const SPLINE = { calcMode: 'spline', keyTimes: '0;.5;1', keySplines: '.4 0 .6 1;.4 0 .6 1' } as const;

/*
 * The area chart, at the width it is given. It is drawn on once, when it
 * first appears: the reveal wipes the line on in the direction it is read, so
 * the eye arrives at the latest reading last. A later reading or width is
 * drawn in place without it -- the reader has already seen the line arrive.
 */
export function AreaChart({ values, label, options, reveal }: { values: readonly number[]; label: string; options: AreaOptions; reveal: boolean }): ReactElement {
  const [id] = useState(() => nextId('area'));
  const [moving] = useState(motionAllowed);
  const [revealing, setRevealing] = useState(() => reveal && moving && values.length > 1);
  const [pointed, setPointed] = useState<number | null>(null);
  const [plateWidth, setPlateWidth] = useState(0);
  const svgRef = useRef<SVGSVGElement>(null);
  const textRef = useRef<SVGTextElement>(null);
  const plan = areaPlan(values, options);
  const [firstCurve] = useState(plan.curve);

  /* The reveal ends with its animation, and is dropped at once if what it draws changes under it: its dash is the first line's length. */
  useEffect(() => {
    if (!revealing) return undefined;
    const done = setTimeout(() => setRevealing(false), REVEAL_MS + 50);
    return () => clearTimeout(done);
  }, [revealing]);
  const drawingOn = revealing && plan.curve === firstCurve;

  const hovered = pointed !== null ? plan.points[Math.min(pointed, plan.points.length - 1)] ?? null : null;
  const hoverIndex = hovered && pointed !== null ? Math.min(pointed, plan.points.length - 1) : null;
  const name = (index: number): string => options.labels?.[index] ?? '';
  const said = hoverIndex === null ? '' : name(hoverIndex);
  const tipText = hoverIndex === null ? '' : said ? `${said} · ${values[hoverIndex]}` : String(values[hoverIndex]);

  /* The plate is cut to the words it holds, measured once they are drawn. */
  useLayoutEffect(() => {
    const text = textRef.current;
    if (!text || !tipText) return;
    const measured = typeof text.getComputedTextLength === 'function' ? text.getComputedTextLength() : tipText.length * 6.4;
    setPlateWidth(Math.ceil(measured + 18));
  }, [tipText]);

  const follow = (event: PointerEvent<SVGSVGElement>): void => {
    if (event.pointerType && event.pointerType !== 'mouse') return;
    const box = svgRef.current ? svgRef.current.getBoundingClientRect() : null;
    if (!box || !box.width) return;
    setPointed(readingAt(plan, (event.clientX - box.left) * (plan.width / box.width)));
  };
  const plateLeft = hovered ? Math.max(2, Math.min(plan.width - plateWidth - 2, hovered.x - plateWidth / 2)) : 0;
  const plateTop = hovered ? Math.max(2, hovered.y - 36) : 0;
  const last = plan.points[plan.points.length - 1];
  const length = drawingOn ? curveLength(plan.curve) : 0;
  const hoverable = plan.points.length > 1;

  return (
    <svg
      ref={svgRef}
      className="wp-area"
      viewBox={`0 0 ${plan.width} ${plan.height}`}
      role="img"
      aria-label={label}
      data-hover={hoverIndex === null ? undefined : String(hoverIndex)}
      onPointerEnter={hoverable ? follow : undefined}
      onPointerMove={hoverable ? follow : undefined}
      onPointerLeave={hoverable ? () => setPointed(null) : undefined}
    >
      <AreaDefs id={id} />
      {/*
        A hairline grid, drawn solid: a dash reads as a threshold or a
        projection, so a grid drawn that way says "target" on a chart that
        has no target.
      */}
      {plan.grid.map((y, index) => (
        <line key={index} className="wp-grid-line" x1={plan.padX} y1={y} x2={plan.width - plan.padX} y2={y} vectorEffect="non-scaling-stroke" />
      ))}
      <path d={plan.area} fill={`url(#${id}-f)`} />
      <path
        className="wp-area-line"
        d={plan.curve}
        fill="none"
        stroke={`url(#${id}-s)`}
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
        filter={`url(#${id}-g)`}
        strokeDasharray={drawingOn ? String(length) : undefined}
        strokeDashoffset={drawingOn ? String(length) : undefined}
      >
        {drawingOn
          ? <animate attributeName="stroke-dashoffset" from={String(length)} to="0" dur=".7s" fill="freeze" calcMode="spline" keySplines=".22 .61 .36 1" keyTimes="0;1" values={`${length};0`} />
          : null}
      </path>
      {plan.dots ? plan.points.map((point, index) => <circle key={index} className="wp-area-dot" cx={point.x} cy={point.y} r={2.2} />) : null}
      {last
        ? (
          <>
            {/*
              The latest reading pings: a halo that breathes under a solid
              core says "this end is live" without a label saying so. Dropped
              entirely when motion is off, rather than left as a static ring
              the reader has to interpret.
            */}
            {moving
              ? (
                <circle className="wp-area-ping" cx={last.x} cy={last.y} r={4}>
                  <animate attributeName="r" values="4;11;4" dur="2.4s" repeatCount="indefinite" {...SPLINE} />
                  <animate attributeName="opacity" values=".5;0;.5" dur="2.4s" repeatCount="indefinite" {...SPLINE} />
                </circle>
              )
              : null}
            <circle className="wp-area-head" cx={last.x} cy={last.y} r={4} />
            {plan.readout
              ? <text className="wp-area-value" x={plan.readout.x} y={plan.readout.y} textAnchor={plan.readout.anchor}>{plan.readout.text}</text>
              : null}
          </>
        )
        : null}
      {/*
        The hover layer: a crosshair, a ring on the reading and a label that
        names the day and the count. Hit by column, not by dot -- a target the
        width of a day, the full height of the plot -- and a mouse affordance
        only: the same numbers are in the table under the chart for every
        reader.
      */}
      {hoverable
        ? (
          <>
            <g className={`wp-hover${hovered ? ' is-on' : ''}`} aria-hidden="true">
              <line className="wp-hover-rule" x1={hovered ? hovered.x : 0} y1={plan.padTop} x2={hovered ? hovered.x : 0} y2={plan.baseY} />
              <circle className="wp-hover-dot" cx={hovered ? hovered.x : 0} cy={hovered ? hovered.y : 0} r={4.5} />
              <g className="wp-hover-tip">
                <rect className="wp-hover-plate" x={plateLeft} y={plateTop} width={hovered ? plateWidth : 10} height={24} rx={7} />
                <text ref={textRef} className="wp-hover-text" x={hovered ? plateLeft + 9 : 0} y={hovered ? plateTop + 16 : 0}>{tipText}</text>
              </g>
            </g>
            {/*
              The target the pointer lands on: the whole plot, transparent.
              SVG hit tests only what is painted, and the empty space of a
              chart is most of it.
            */}
            <rect className="wp-hit" x={0} y={0} width={plan.width} height={plan.height} fill="transparent" />
          </>
        )
        : null}
      {plan.axis.map((mark, index) => (
        <text key={index} className="wp-area-axis" x={mark.x} y={mark.y} textAnchor={mark.anchor}>{mark.label}</text>
      ))}
    </svg>
  );
}

/*
 * An area chart that fits its card, and refits when the card changes width
 * by more than a hair -- a rail collapsing, a window resized, a phone turned.
 *
 * The card's laid-out width, not its box on screen. On a phone a card
 * arrives scaled (a scroll-driven entrance), and a chart measured from the
 * scaled box was drawn narrower than its card and stretched to fill it,
 * blurred, and taller than it would be redrawn. A transform never reaches the
 * resize observer, so nothing refitted it.
 *
 * A card that is not laid out yet -- its screen still hidden when the reading
 * lands -- has no width to draw at. Drawn at a guess, the chart played its
 * arrival at 380 pixels and was replaced at its real width a frame after the
 * card appeared. Where the card can be watched, the chart is drawn once, at
 * the card's first real width.
 */
export function FittedArea({ host, values, label, options }: { host: HTMLElement; values: readonly number[]; label: string; options: AreaOptions }): ReactElement | null {
  const observed = typeof ResizeObserver === 'function';
  const measure = (): number => Math.round(Number(host.offsetWidth) || 0);
  const [width, setWidth] = useState<number | null>(null);
  /* Every drawing of the card measures it, before it is painted, as the card was measured when it was drawn whole. */
  useLayoutEffect(() => {
    const now = measure();
    if (now) setWidth(now);
    else if (!observed) setWidth(drawn => drawn ?? 380);
  });
  /*
   * Watched from the moment the chart's place is committed, and redrawn in
   * the frame the change is seen in: drawing inside the resize delivery can
   * resize the observed card again in the same frame, so it waits for the
   * next one, and no longer.
   */
  useLayoutEffect(() => {
    if (!observed) return undefined;
    let frame = 0;
    const watcher = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const now = measure();
        if (now) flushSync(() => setWidth(drawn => (drawn !== null && Math.abs(now - drawn) < REFIT_PX ? drawn : now)));
      });
    });
    watcher.observe(host);
    return () => { watcher.disconnect(); cancelAnimationFrame(frame); };
  }, [host]);
  if (width === null) return null;
  return <AreaChart values={values} label={label} options={{ ...options, width }} reveal />;
}

/*
 * Languages across the connected set, as a radar: every language on its own
 * spoke against a shared scale, so the shape of the estate is what is seen.
 * The rings and spokes are solid hairlines -- a dash reads as a threshold,
 * and a web made of thresholds is four rings of meaning that is not there.
 * The fill is a tint along the stroke's diagonal, classed so the stylesheet
 * owns its colour in either theme. The reveal grows the polygon out of the
 * centre, so the vertices stay on the shape while it arrives.
 */
export function RadarChart({ axes, label }: { axes: readonly LanguageAxis[]; label: string }): ReactElement {
  const [id] = useState(() => nextId('radar'));
  const [moving] = useState(motionAllowed);
  const plan = radarPlan(axes);
  return (
    <svg className="wp-radar" viewBox={`0 0 ${plan.width} ${plan.height}`} role="img" aria-label={label}>
      <defs>
        <linearGradient id={`${id}-r`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" className="wp-radar-fill-from" />
          <stop offset="100%" className="wp-radar-fill-to" />
        </linearGradient>
        <linearGradient id={`${id}-s`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" className="wp-stroke-from" />
          <stop offset="100%" className="wp-stroke-to" />
        </linearGradient>
      </defs>
      {plan.rings.map((points, index) => <polygon key={index} className="wp-radar-ring" points={points} />)}
      {plan.spokes.map((spoke, index) => (
        <line key={index} className="wp-radar-spoke" x1={plan.centre.x} y1={plan.centre.y} x2={spoke.outer.x} y2={spoke.outer.y} />
      ))}
      <polygon className="wp-radar-area" points={moving ? plan.collapsed : plan.full} fill={`url(#${id}-r)`} stroke={`url(#${id}-s)`}>
        {moving
          ? <animate attributeName="points" dur=".8s" fill="freeze" calcMode="spline" keyTimes="0;1" keySplines=".22 .61 .36 1" values={`${plan.collapsed};${plan.full}`} />
          : null}
      </polygon>
      {plan.spokes.map((spoke, index) => (
        <Fragment key={index}>
          <circle className="wp-radar-dot" cx={spoke.vertex.x} cy={spoke.vertex.y} r={3.2}>
            <title>{spoke.title}</title>
          </circle>
          {/* The full name stays reachable on the label as well as the vertex, so an elided spoke is never a language the reader cannot identify. */}
          <text className="wp-radar-label" x={spoke.label.x} y={spoke.label.y} textAnchor={spoke.label.anchor}>
            {spoke.label.text}
            {spoke.label.elided ? <title>{spoke.axis.label}</title> : null}
          </text>
        </Fragment>
      ))}
    </svg>
  );
}

/*
 * A radial gauge, drawn as one arc: a figure with a shape of its own, sitting
 * in the middle of its own measurement. Three-quarters of the circle, opened
 * at the bottom, so the gap reads as a deliberate dial rather than as a ring
 * that failed to close.
 */
const GAUGE_R = 52;
const GAUGE_C = 2 * Math.PI * GAUGE_R;
const GAUGE_SWEEP = 0.75;
const ARC = { cx: 64, cy: 64, r: GAUGE_R, fill: 'none', strokeLinecap: 'round', transform: 'rotate(135 64 64)' } as const;

export function Gauge({ ratio, status, compact, figure, unit, caption }: {
  ratio: number | null;
  status: Status;
  compact?: boolean;
  figure?: string | number;
  unit?: string;
  caption?: string;
}): ReactElement {
  const measured = typeof ratio === 'number' && Number.isFinite(ratio);
  const value = measured ? Math.max(0, Math.min(1, ratio)) : 0;
  return (
    <div className={compact ? 'wp-gauge wp-gauge-sm' : 'wp-gauge'} data-status={measured ? status : 'unknown'}>
      <svg className="wp-gauge-art" viewBox="0 0 128 128" aria-hidden="true" focusable="false">
        <circle className="wp-gauge-track" {...ARC} strokeDasharray={`${GAUGE_C * GAUGE_SWEEP} ${GAUGE_C}`} />
        {/*
          An unmeasured gauge draws its track and no arc at all. A
          zero-length arc would be a reading of zero, and "not measured" is
          not zero -- that distinction is the whole reason this model reports
          absence.
        */}
        {measured ? <circle className="wp-gauge-arc" {...ARC} strokeDasharray={`${GAUGE_C * GAUGE_SWEEP * value} ${GAUGE_C}`} /> : null}
      </svg>
      <div className="wp-gauge-core">
        <p className={`wp-gauge-figure${measured ? '' : ' wp-gauge-empty'}`}>
          {figure === undefined ? (measured ? String(Math.round(value * 100)) : '—') : String(figure)}
        </p>
        {unit ? <span className="wp-gauge-unit">{unit}</span> : null}
        {caption ? <p className="wp-gauge-caption">{caption}</p> : null}
      </div>
    </div>
  );
}

export interface RingPart {
  readonly label: string;
  readonly count: number;
  readonly status: Status;
}

/*
 * Part-to-whole as a ring rather than a bar: each state an arc on the same
 * circle, offset by what came before it, so the reader sees the shares of one
 * total instead of lengths to add up by eye. The state travels as a data
 * attribute, not the legend swatches' wp-fill-* class: that class sets
 * `fill`, a class rule outranks a presentation attribute, and every arc
 * painted itself as a filled disc.
 */
export function Donut({ parts, total }: { parts: readonly RingPart[]; total: number }): ReactElement {
  const whole = total || 1;
  let consumed = 0;
  const arcs = parts.filter(part => part.count).map(part => {
    const share = part.count / whole;
    const offset = -GAUGE_C * consumed;
    consumed += share;
    return { part, share, offset };
  });
  return (
    <svg className="wp-donut" viewBox="0 0 128 128" role="img" aria-label={parts.map(part => `${part.count} ${part.label}`).join(', ')}>
      <circle className="wp-donut-track" cx={64} cy={64} r={GAUGE_R} fill="none" />
      {arcs.map(({ part, share, offset }) => (
        <circle
          key={part.label}
          className="wp-donut-arc"
          data-status={part.status}
          cx={64}
          cy={64}
          r={GAUGE_R}
          fill="none"
          strokeLinecap="butt"
          /* A gap of two units keeps adjacent arcs from blending into one mark, clamped so a one-capability share is not erased by it. */
          strokeDasharray={`${Math.max(0, GAUGE_C * share - 2)} ${GAUGE_C}`}
          strokeDashoffset={offset}
          transform="rotate(-90 64 64)"
        >
          <title>{`${part.label}: ${part.count} of ${total}`}</title>
        </circle>
      ))}
    </svg>
  );
}
