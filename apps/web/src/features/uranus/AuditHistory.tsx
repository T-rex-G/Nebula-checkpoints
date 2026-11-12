/*
 * The kept history, drawn: Remediation (the clocks and the time to fix),
 * the score over time, and every kept audit of the branch, each opening
 * into what it found as it kept it. What each says is audit-history.ts's.
 */
import { useLayoutEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';

import { SEVERITY } from './audit-terms.ts';
import { HISTORY_FINDINGS } from './audit-history.ts';
import type { History, HistoryBody, HistoryRow, Remediation, Trend } from './audit-history.ts';
import { REPORT_EXPORTS } from './audit-screen.ts';
import { ICON } from './audit-marks.ts';
import { ChipView, ExportMenu, Foldable, Icon, useExpanded } from './AuditParts.tsx';
import type { AuditHandlers } from './AuditScreen.tsx';

const Lede = ({ said }: { readonly said: string }): ReactElement => <p className="audit-card-lede">{said}</p>;

export function RemediationCard({ remediation }: { readonly remediation: Remediation }): ReactElement {
  return (
    <Foldable className="card audit-remediation" id="remediation" name="Remediation" labelledBy="auditRemediationHeading" headClassName="audit-card-head"
      head={<div className="audit-card-titles"><h2 className="audit-kicker" id="auditRemediationHeading">Remediation</h2><Lede said={remediation.lede} /></div>}>
      {remediation.kind === 'loading' ? <p className="audit-hist-wait" role="status">Reading the clocks…</p> : null}
      {remediation.kind === 'error' ? <p className="audit-hist-wait audit-error" role="alert">{remediation.error}</p> : null}
      {remediation.kind === 'ready' ? (
        <>
          <ul className="audit-rem-tiles" aria-label="Open findings against their deadlines, and time to fix">
            {remediation.tiles.map(tile => (
              <li key={tile.label} className="audit-rem-tile" data-tone={tile.tone ?? undefined}>
                <span className="audit-rem-label">{tile.label}</span><strong className="audit-rem-value">{tile.value}</strong>
                {tile.sub ? <span className="audit-rem-sub">{tile.sub}</span> : null}
              </li>
            ))}
          </ul>
          <table className="audit-rem-table">
            <caption className="sr-only">Clock, open findings and time to fix, by severity</caption>
            <thead><tr>{['Severity', 'Clock', 'Open', 'Overdue', 'Median fix', 'Fixed'].map(name => <th key={name} scope="col">{name}</th>)}</tr></thead>
            <tbody>
              {remediation.rows.map(row => (
                <tr key={row.severity} data-severity={row.severity}>
                  <th className="audit-rem-sev" scope="row"><ChipView chip={{ tone: row.severity, word: SEVERITY[row.severity].word, glyph: SEVERITY[row.severity].icon }} /></th>
                  {row.cells.map(cell => <td key={cell.label} data-label={cell.label} data-alert={cell.alert ? 'true' : undefined}>{cell.value}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="audit-rem-notes">{remediation.notes.map((note, index) => <p key={`${index}:${note.said}`} className={note.className}>{note.said}</p>)}</div>
        </>
      ) : null}
    </Foldable>
  );
}

/*
 * The score over time: one series, so no legend -- the heading names it.
 * The points are buttons laid over the line, so each has a name, a focus
 * ring and a hit area larger than the mark, and says its audit in a tooltip.
 */
function TrendChart({ trend, handlers }: { readonly trend: Trend; readonly handlers: AuditHandlers }): ReactElement {
  /*
   * A point's tip shows while the pointer is over it or while it has focus:
   * the pointer leaving a point that still has focus -- a tap whose audit
   * then scrolled into view moved it from under the finger -- leaves the tip.
   */
  const [hovered, setHovered] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const shown = hovered ?? focused;
  const tip = trend.points.find(point => point.key === shown) ?? null;
  const tipNode = useRef<HTMLDivElement>(null);
  /*
   * A tip wider than the room beside its point is nudged back inside the
   * plot, and again whenever the plot changes size while it shows: on a
   * narrow screen it would run off the edge.
   */
  const showing = tip !== null;
  useLayoutEffect(() => {
    const node = tipNode.current;
    const plot = node?.parentElement;
    if (!node || !plot) return undefined;
    const place = (): void => {
      node.style.removeProperty('--nudge');
      if (node.hidden) return;
      const room = plot.getBoundingClientRect();
      const box = node.getBoundingClientRect();
      const nudge = box.left < room.left ? room.left - box.left : box.right > room.right ? room.right - box.right : 0;
      if (nudge) node.style.setProperty('--nudge', `${Math.round(nudge)}px`);
    };
    place();
    if (!showing || typeof ResizeObserver !== 'function') return undefined;
    const watch = new ResizeObserver(place);
    watch.observe(plot);
    return () => watch.disconnect();
  }, [showing, tip?.key, tip?.said]);
  return (
    <figure className="audit-trend">
      <div className="audit-trend-axis" aria-hidden="true">
        {trend.ticks.map(tick => <span key={tick.grade} className="audit-trend-tick" style={{ top: `${tick.y}%` }} title={tick.title}>{tick.grade}</span>)}
      </div>
      <div className="audit-trend-plot">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" className="audit-trend-svg">
          {trend.ticks.map(tick => <line key={tick.grade} x1="0" x2="100" y1={String(tick.y)} y2={String(tick.y)} className="audit-trend-grid" vectorEffect="non-scaling-stroke" />)}
          {trend.line ? <polyline points={trend.line} className="audit-trend-line" vectorEffect="non-scaling-stroke" /> : null}
        </svg>
        {trend.points.map(point => {
          const leaves = (current: string | null): string | null => (current === point.key ? null : current);
          return (
            <button key={point.key} type="button" className="audit-trend-dot" data-key={point.key} style={{ left: `${point.x}%`, top: `${point.y}%` }}
              data-grade={point.grade} data-latest={point.latest ? 'true' : undefined} aria-label={`${point.said}. Open this audit`}
              onClick={() => handlers.onHistoryOpen?.(point.id, { reveal: true })}
              onMouseEnter={() => setHovered(point.key)} onMouseLeave={() => setHovered(leaves)}
              onFocus={() => setFocused(point.key)} onBlur={() => setFocused(leaves)}></button>
          );
        })}
        <div ref={tipNode} className="audit-trend-tip" aria-hidden="true" hidden={!tip} data-side={tip?.side} style={tip ? { top: `${tip.y}%`, left: `${tip.x}%` } : undefined}>{tip?.said}</div>
      </div>
      <figcaption className="audit-trend-caption">{trend.caption}</figcaption>
    </figure>
  );
}

/* A kept audit exported on its own: what it found, from what it kept, in the formats the live one offers. */
function HistoryExport({ row, kept, handlers }: { readonly row: HistoryRow; readonly kept: string; readonly handlers: AuditHandlers }): ReactElement {
  return (
    <div className="audit-hist-export">
      <span className="audit-hist-export-t">{kept}</span>
      <ExportMenu onExport={kind => handlers.onHistoryExport?.(row.id, kind)} menuKey={`hist-export:${row.id}`} kinds={REPORT_EXPORTS} />
    </div>
  );
}

function HistoryFindings({ body, row, handlers }: { readonly body: HistoryBody; readonly row: HistoryRow; readonly handlers: AuditHandlers }): ReactElement {
  const [shown, showAll] = useExpanded(`history:${row.id}`);
  if (body.kind === 'loading') return <div className="audit-hist-body"><p className="audit-hist-wait" role="status">Reading what this audit kept…</p></div>;
  if (body.kind === 'error') return <div className="audit-hist-body"><p className="audit-hist-wait audit-error" role="alert">{body.error}</p></div>;
  const exporting = handlers.onHistoryExport ? <HistoryExport row={row} kept={body.kept} handlers={handlers} /> : null;
  if (body.kind === 'empty') return <div className="audit-hist-body">{exporting}<p className="audit-hist-wait">{body.said}</p></div>;
  const all = shown || body.rows.length <= HISTORY_FINDINGS + 1;
  return (
    <div className="audit-hist-body">
      {exporting}
      <ul className="audit-hist-findings" aria-label={body.label}>
        {body.rows.map((finding, index) => (
          <li key={`${finding.title}:${index}`} className="audit-hist-finding" hidden={!all && finding.hiddenUnlessAll}>
            <span className="audit-hist-sev">{finding.severity ? <ChipView chip={{ tone: finding.severity, word: SEVERITY[finding.severity].word, glyph: SEVERITY[finding.severity].icon }} /> : null}</span>
            <span className="audit-hist-text"><span className="audit-hist-title">{finding.title}</span><span className="audit-hist-where" title={finding.whereTitle ?? undefined}>{finding.where}</span></span>
            <span className="audit-hist-tags">{finding.tags.map((chip, at) => <ChipView key={`${chip.word}:${at}`} chip={chip} />)}</span>
          </li>
        ))}
      </ul>
      {!all ? <button type="button" className="btn btn-ghost audit-more" data-key={`hist-more:${row.id}`} onClick={showAll}><span>{`Show all ${body.rows.length}`}</span><span className="audit-more-of">{`${HISTORY_FINDINGS} of ${body.rows.length}`}</span></button> : null}
      {body.cut ? <p className="audit-coverage">{body.cut}</p> : null}
      {body.waived ? <p className="audit-coverage">{body.waived}</p> : null}
    </div>
  );
}

export function HistoryCard({ history, handlers }: { readonly history: History; readonly handlers: AuditHandlers }): ReactElement {
  return (
    <Foldable className="card audit-history" id="history" name="History" labelledBy="auditHistoryHeading" headClassName="audit-card-head"
      head={<div className="audit-card-titles"><h2 className="audit-kicker" id="auditHistoryHeading">History</h2><Lede said={history.lede} /></div>}>
      <TrendChart trend={history.trend} handlers={handlers} />
      <ol className="audit-hist-list" aria-label={`Audits of ${history.ref}`}>
        {history.rows.map(row => (
          <li key={row.id} className="audit-hist-row">
            <details className="audit-hist" data-audit-id={row.id} open={row.open} onToggle={event => handlers.onHistoryToggle?.(row.id, event.currentTarget.open)}>
              <summary className="audit-hist-sum" aria-label={row.name}>
                <span className="audit-hist-grade" data-grade={row.grade}>{row.grade}</span>
                <span className="audit-hist-score">{row.score}</span>
                <span className="audit-hist-main">
                  <span className="audit-hist-top">
                    <time className="audit-hist-when" dateTime={row.at} title={row.absolute}>{row.absolute}</time>
                    {row.latest ? <span className="audit-hist-tag">Latest</span> : null}
                    {row.shown ? <span className="audit-hist-tag">Shown above</span> : null}
                  </span>
                  <span className="audit-hist-sub">{row.sub}</span>
                </span>
                <span className="audit-hist-tags">{row.tags.map((chip, at) => <ChipView key={`${chip.word}:${at}`} chip={chip} />)}</span>
                <Icon path={ICON.chevron} className="audit-ico audit-hist-chev" />
              </summary>
              {row.body ? <HistoryFindings body={row.body} row={row} handlers={handlers} /> : null}
            </details>
          </li>
        ))}
      </ol>
      <div className="audit-hist-foot">
        {history.others ? <p className="audit-coverage">{history.others}</p> : null}
        <p className="audit-coverage">Kept for your account only: the 30 latest audits of each branch, for up to 400 days, and removed with your account.</p>
        <button type="button" className={`btn btn-ghost audit-tool audit-hist-clear${history.clear.armed ? ' is-armed' : ''}`} data-key="history-clear"
          aria-label={history.clear.armed ? 'Press again to delete every kept audit of this repository, on every branch' : 'Clear the kept audits of this repository'}
          title={history.clear.armed ? 'Press again to delete every kept audit of this repository, on every branch' : 'Clear the kept audits of this repository'}
          disabled={history.clear.disabled} onClick={() => handlers.onHistoryClear?.()}>
          <Icon path={ICON.trash} /><span className="audit-btn-label">{history.clear.armed ? 'Press again to clear' : 'Clear history'}</span>
        </button>
      </div>
    </Foldable>
  );
}
