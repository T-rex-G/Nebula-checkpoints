/*
 * The security posture on the Overview, drawn.
 *
 * The same elements, classes, roles and accessible names the card drew
 * before it was a component (ADR-093), so the stylesheet and the browser
 * suite read it unchanged. What a component adds is continuity: a reading
 * that lands keeps the elements the reader is on -- the table they opened,
 * the week under their pointer, the name they are about to press -- where the
 * old renderer rebuilt the card beneath them.
 *
 * The figures and the words are security-posture.ts's.
 */
import { Fragment, useLayoutEffect, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import { repaintCard } from '../../components/held-repaint.ts';
import { NumbersTable } from '../../components/NumbersTable.tsx';
import { SEVERITIES, categoryLabel, chartPlan, days, plural, severityWords, weekName, weekSentence } from './security-posture.ts';
import type { OpenCounts, PostureView, ReadyView, Unread } from './security-posture.ts';

export interface PostureActions {
  audit?(owner: string, repo: string): void;
  inbox?: ((filters: string) => void) | null;
}

/* A width change smaller than this is not worth drawing the chart again for. */
const REDRAW_PX = 24;

/*
 * One bar split by severity, with a 2px gap between segments so adjacent
 * fills never merge. The text beside it carries the same counts, so the
 * colour is never the only way to read them.
 */
function SeverityBar({ open, scale }: { open: OpenCounts; scale?: number }): ReactElement {
  const total = Math.max(1, scale || open.total || 0);
  return (
    <span className="pp-sevbar" aria-hidden="true">
      {SEVERITIES.filter(severity => open[severity]).map(severity => (
        <span
          key={severity}
          className={`pp-sevbar-part pp-sev-${severity}`}
          style={{ flexGrow: open[severity], maxWidth: `${(open[severity] / total) * 100}%` }}
        />
      ))}
    </span>
  );
}

function Tile({ label, figure, detail, className }: { label: string; figure: string; detail: ReactNode; className?: string }): ReactElement {
  return (
    <div className={`pp-tile${className ? ` ${className}` : ''}`}>
      <p className="pp-tile-label">{label}</p>
      <p className="pp-tile-figure">{figure}</p>
      {typeof detail === 'string' ? <p className="pp-tile-detail">{detail}</p> : detail}
    </div>
  );
}

/*
 * Opened and fixed per week: two bars to a week, side by side, on one axis
 * that starts at zero. Each week is a hit target the full height of the
 * plot, so a reader does not have to land on a two-pixel bar to read it.
 */
function TrendChart({ view, width }: { view: ReadyView; width: number }): ReactElement {
  const plan = chartPlan(view, width);
  const [pointed, setPointed] = useState<number | null>(null);
  const tip = plan.weeks.find(week => week.weeksAgo === pointed) ?? null;
  return (
    <div className="pp-chart">
      <svg viewBox={`0 0 ${plan.width} ${plan.height}`} width={plan.width} height={plan.height} className="pp-chart-svg" role="img" aria-label={plan.label}>
        {plan.ticks.map(tick => (
          <Fragment key={tick.value}>
            <line x1={plan.left} x2={plan.right} y1={tick.y} y2={tick.y} className={tick.value === 0 ? 'pp-axis' : 'pp-gridline'} />
            <text x={plan.left - 6} y={tick.y + 3} className="pp-tick" textAnchor="end">{String(tick.value)}</text>
          </Fragment>
        ))}
        {plan.weeks.map(week => (
          <Fragment key={week.weeksAgo}>
            {week.bars.map(bar => <path key={bar.kind} className={`pp-bar pp-bar-${bar.kind}`} d={bar.d} />)}
            <rect
              x={week.hit.x}
              y={week.hit.y}
              width={week.hit.width}
              height={week.hit.height}
              className={`pp-hit${tip === week ? ' is-hover' : ''}`}
              data-week={week.weeksAgo}
              onPointerEnter={() => setPointed(week.weeksAgo)}
              onPointerLeave={() => setPointed(current => (current === week.weeksAgo ? null : current))}
            />
          </Fragment>
        ))}
        <text x={plan.left} y={plan.height - 6} className="pp-tick" textAnchor="start">{`${plan.weeks.length} weeks ago`}</text>
        <text x={plan.right} y={plan.height - 6} className="pp-tick" textAnchor="end">this week</text>
      </svg>
      {/* The pointer's reading. Kept out of the accessibility tree: the table under the chart says the same for every week, without a pointer. */}
      <div
        className="pp-tip"
        hidden={!tip}
        aria-hidden="true"
        style={tip ? { left: `${Math.min(86, Math.max(14, tip.share * 100))}%` } : undefined}
      >
        {tip ? tip.label : ''}
      </div>
    </div>
  );
}

/*
 * The chart drawn at the width its panel has, and drawn again when that
 * width changes by more than a hair: a viewBox stretched to fit would scale
 * the axis labels with it, to a smudge on a phone and a shout on a monitor.
 *
 * A panel that is not laid out yet -- its screen still hidden when the
 * reading lands -- has no width to draw at. The chart used to be drawn at a
 * 480-pixel guess then, and the hair it would not be redrawn for was measured
 * from the guess: a panel that turned out 499 pixels wide kept a chart drawn
 * for 480, stretched to fit. Where the panel can be watched, the chart waits
 * for its first real width, as the pulse's area charts do; a panel taken out
 * of the layout later keeps the chart it has.
 */
function FittedTrend({ view }: { view: ReadyView }): ReactElement {
  const plot = useRef<HTMLDivElement>(null);
  const observed = typeof ResizeObserver === 'function';
  const [width, setWidth] = useState<number | null>(null);
  /* The laid-out width, which a card's entrance transform does not shrink (as workspace-pulse's fittedArea); 0 when it is not laid out. */
  const measure = (): number => Math.round(Number(plot.current ? plot.current.offsetWidth : 0) || 0);
  /* Measured before the first paint of every reading, as the card was when it was drawn whole. */
  useLayoutEffect(() => {
    const now = measure();
    if (now) setWidth(now);
    else if (!observed) setWidth(drawn => drawn ?? 480);
  }, [view]);
  /* Watched from the moment the plot is committed, and redrawn in the frame the change is seen in. */
  useLayoutEffect(() => {
    const node = plot.current;
    if (!node || !observed) return undefined;
    let frame = 0;
    const watcher = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const now = measure();
        if (now) flushSync(() => setWidth(drawn => (drawn !== null && Math.abs(now - drawn) < REDRAW_PX ? drawn : now)));
      });
    });
    watcher.observe(node);
    return () => { watcher.disconnect(); cancelAnimationFrame(frame); };
  }, []);
  return <div className="pp-plot" ref={plot}>{width === null ? null : <TrendChart view={view} width={width} />}</div>;
}

function Legend(): ReactElement {
  return (
    <div className="pp-legend">
      {([['opened', 'Opened'], ['fixed', 'Fixed']] as const).map(([kind, label]) => (
        <span key={kind} className="pp-legend-item">
          <span className={`pp-swatch pp-swatch-${kind}`} aria-hidden="true" />
          <span>{label}</span>
        </span>
      ))}
    </div>
  );
}

function RepositoryButton({ owner, repo, actions, className }: { owner: string; repo: string; actions: PostureActions | undefined; className: string }): ReactElement {
  return (
    <button
      className={className}
      type="button"
      title={`Open the audit of ${owner}/${repo}`}
      onClick={() => { if (actions && actions.audit) actions.audit(owner, repo); }}
    >
      {`${owner}/${repo}`}
    </button>
  );
}

function UnreadRow({ view, actions }: { view: Unread; actions: PostureActions | undefined }): ReactElement | null {
  if (!view.unread.length) return null;
  return (
    <div className="pp-unread">
      <p className="pp-unread-label">Not yet audited or scanned</p>
      <div className="pp-unread-list">
        {view.unread.map(entry => <RepositoryButton key={entry.key} owner={entry.owner} repo={entry.repo} actions={actions} className="pp-chip" />)}
        {view.unreadMore ? <span className="pp-chip-more">{`+${view.unreadMore} more`}</span> : null}
      </div>
    </div>
  );
}

function Ready({ view, actions }: { view: ReadyView; actions: PostureActions | undefined }): ReactElement {
  const fix = view.timeToFix && view.timeToFix.all;
  const windowDays = view.timeToFix ? view.timeToFix.windowDays : 90;
  const topScale = Math.max(...view.top.map(entry => entry.open.total));
  const categoryScale = Math.max(...view.categories.map(entry => entry.total));
  const inbox = actions && actions.inbox;
  return (
    <>
      <p className="pp-week">{weekSentence(view)}</p>
      <div className="pp-tiles">
        <Tile
          label="Open findings"
          figure={String(view.open.total)}
          className="pp-tile-open"
          detail={(
            <div className="pp-tile-detail">
              <SeverityBar open={view.open} />
              <span className="pp-sevwords">{severityWords(view.open)}</span>
            </div>
          )}
        />
        <Tile
          label="Decided"
          figure={String(view.triaged.acceptedRisk + view.triaged.falsePositive)}
          detail={`${view.triaged.acceptedRisk} accepted ${view.triaged.acceptedRisk === 1 ? 'risk' : 'risks'} · ${view.triaged.falsePositive} not a problem`}
        />
        <Tile
          label="Median time to fix"
          figure={fix && fix.count ? days(fix.medianDays) ?? '—' : '—'}
          detail={fix && fix.count ? `${plural(fix.count, 'finding', 'findings')} fixed in ${windowDays} days` : `Nothing fixed in the last ${windowDays} days`}
        />
        <Tile
          label="Repositories read"
          figure={view.inventory ? `${view.covered} of ${view.inventory}` : String(view.readCount)}
          detail={view.inventory ? 'in this inventory, audited or scanned' : 'audited or scanned'}
        />
      </div>
      <div className="pp-grid">
        <section className="pp-panel pp-trend" aria-labelledby="ppTrendTitle">
          <div className="pp-panel-head">
            <h4 className="pp-panel-title" id="ppTrendTitle">{`Opened and fixed, last ${view.trend.length} weeks`}</h4>
            <Legend />
          </div>
          <FittedTrend view={view} />
          <NumbersTable
            caption="Findings opened and fixed per week"
            headings={['Week', 'Opened', 'Fixed']}
            rows={view.trend.slice().reverse().map(entry => [weekName(entry.weeksAgo), entry.opened, entry.fixed])}
          />
        </section>
        <section className="pp-panel pp-where" aria-labelledby="ppWhereTitle">
          <h4 className="pp-panel-title" id="ppWhereTitle">Where the open findings are</h4>
          {view.top.length
            ? (
              <ol className="pp-repos">
                {view.top.map(entry => (
                  <li key={`${entry.owner}/${entry.repo}`} className="pp-repo">
                    <RepositoryButton owner={entry.owner} repo={entry.repo} actions={actions} className="pp-repo-name" />
                    <span className="pp-repo-count" aria-label={`${entry.open.total} open: ${severityWords(entry.open)}`}>{String(entry.open.total)}</span>
                    <SeverityBar open={entry.open} scale={topScale} />
                  </li>
                ))}
              </ol>
            )
            : <p className="wp-stat-note">Nothing is open in any repository that has been read.</p>}
          {view.categories.length
            ? (
              <>
                <h5 className="pp-sub-title">By kind</h5>
                <ul className="pp-cats">
                  {view.categories.map(entry => (
                    <li key={entry.category} className="pp-cat">
                      <span className="pp-cat-name">{categoryLabel(entry.category)}</span>
                      <span className="pp-cat-track" aria-hidden="true">
                        <span className="pp-cat-fill" style={{ width: `${Math.max(4, (entry.total / categoryScale) * 100)}%` }} />
                      </span>
                      <span className="pp-cat-count">{String(entry.total)}</span>
                    </li>
                  ))}
                </ul>
              </>
            )
            : null}
          <NumbersTable
            caption="Open findings by repository"
            headings={['Repository', 'Critical', 'Serious', 'Warning', 'Total']}
            rows={view.top.map(entry => [`${entry.owner}/${entry.repo}`, entry.open.critical, entry.open.serious, entry.open.warning, entry.open.total])}
          />
        </section>
      </div>
      {inbox
        ? (
          <button className="btn btn-ghost small pp-inbox-link" type="button" onClick={() => inbox('')}>
            {`Work through the ${plural(view.open.total, 'open finding', 'open findings')}`}
          </button>
        )
        : null}
      <UnreadRow view={view} actions={actions} />
      {view.notes.map(note => <p key={note} className="wp-stat-note">{note}</p>)}
    </>
  );
}

function Body({ view, actions }: { view: PostureView; actions: PostureActions | undefined }): ReactElement {
  switch (view.state) {
    case 'loading':
      return <p className="wp-stat-note">Reading the audits and scans this account has kept…</p>;
    case 'unavailable':
      return <p className="wp-stat-note">{view.reason}</p>;
    case 'empty':
    case 'unmeasured':
      return (
        <>
          <div className="pp-empty">
            <p className="pp-empty-title">{view.state === 'unmeasured' ? 'The posture could not be read' : 'Nothing audited or scanned yet'}</p>
            <p className="pp-empty-text">
              {view.state === 'unmeasured'
                ? 'Neither the audits nor the exposure scans answered. Nothing here means the workspace is clean.'
                : 'Audit a repository, or scan it for leaked credentials, and what they find is summarised here across the whole workspace.'}
            </p>
          </div>
          <UnreadRow view={view} actions={actions} />
        </>
      );
    case 'ready':
      return <Ready view={view} actions={actions} />;
  }
}

function SecurityPosture({ view, actions }: { view: PostureView; actions: PostureActions | undefined }): ReactElement {
  return (
    <>
      <div className="wp-head pp-head">
        <span className="wp-label">SECURITY POSTURE</span>
        <span className="pp-scope">Audits, exposure scans and governance</span>
      </div>
      <Body view={view} actions={actions} />
    </>
  );
}

/*
 * The page draws the card through this, as it called the old renderer: one
 * React root per host, made once, and every paint committed before it
 * returns. Redrawn once no press is down on its screen
 * (components/held-repaint.ts): a press on a moved element is lost.
 */
const roots = new WeakMap<HTMLElement, Root>();

export function render(host: HTMLElement | null, view: PostureView, actions?: PostureActions): void {
  if (!host || typeof document === 'undefined') return;
  repaintCard(host, () => draw(host, view, actions));
}

function draw(host: HTMLElement, view: PostureView, actions: PostureActions | undefined): void {
  host.dataset.state = view.state;
  let root = roots.get(host);
  if (!root) {
    host.textContent = '';
    root = createRoot(host);
    roots.set(host, root);
  }
  const target = root;
  flushSync(() => target.render(<SecurityPosture view={view} actions={actions} />));
}
