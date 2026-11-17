/*
 * The Neural command center's panels, drawn: the card a chosen node opens,
 * the groups list beside the map, and the strip of events under it. Each
 * says what its model decided (graph-card.ts, graph-legend.ts,
 * graph-timeline.ts); the page puts each in its place, keeps the card beside
 * its node, and answers what the reader presses through the handlers it
 * passes. A panel drawn again keeps its elements -- and so the control the
 * reader has focused -- where the classic page replaced them all.
 */
import type { ReactElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';

import type { CardAction, CardModel } from './graph-card.ts';
import type { Legend, LegendRow, LegendTool } from './graph-legend.ts';
import { MARK_PATHS, iconPath } from './graph-marks.ts';
import type { NodeMark } from './graph-model.ts';
import type { StripCard } from './graph-timeline.ts';

/* A type's icon on the 24-unit grid; the hub's is filled. Nothing for a type without one. */
export function TypeIcon({ type }: { readonly type: string }): ReactElement | null {
  const d = iconPath(type);
  if (!d) return null;
  return <svg viewBox="0 0 24 24" aria-hidden="true">{type === 'repo' ? <path fill="currentColor" stroke="none" d={d} /> : <path d={d} />}</svg>;
}

function Mark({ mark }: { readonly mark: NodeMark }): ReactElement {
  const { paths, filled } = MARK_PATHS[mark];
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {paths.map((d, i) => (filled ? <path key={i} fill="currentColor" stroke="none" d={d} /> : <path key={i} d={d} />))}
    </svg>
  );
}

/* What the card does when the reader presses in it. */
export interface CardHandlers {
  readonly onClose: () => void;
  readonly onGoto: (id: string) => void;
  readonly onAction: (action: CardAction) => void;
}

export function NeuralCard({ card, handlers }: { readonly card: CardModel; readonly handlers: CardHandlers }): ReactElement {
  const icon = iconPath(card.type) ? <TypeIcon type={card.type} /> : card.mark ? <Mark mark={card.mark} /> : card.glyph;
  return (
    <>
      <header className="neural-card-head">
        <span className="neural-card-icon" aria-hidden="true">{icon}</span>
        <div className="neural-card-title"><span className="neural-card-kicker">{card.kicker}</span><h3 id="neuralCardTitle">{card.title}</h3></div>
        <button type="button" className="neural-card-close" data-neural-card-close="" aria-label="Close details" onClick={handlers.onClose}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17" /></svg>
        </button>
      </header>
      <div className="neural-card-body">
        <span className="neural-card-status" data-severity={card.severity}><i aria-hidden="true" />{card.status}</span>
        <p className="neural-card-copy">{card.description}</p>
        {card.facts.length ? (
          <dl className="neural-card-facts">{card.facts.map(([label, value], i) => <div key={i}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
        ) : null}
        <h4 className="neural-card-section">Connected <span>{card.connected}</span></h4>
        {card.links.length ? (
          <>
            <ul className="neural-card-links">
              {card.links.map((link, i) => (
                <li key={i}>
                  <button type="button" data-neural-goto={link.id} style={{ '--node': link.color }} onClick={() => handlers.onGoto(link.id)}>
                    <i aria-hidden="true"><TypeIcon type={link.type} /></i>
                    <span><b>{link.label}</b><small>{link.relation}</small></span>
                    {link.severity !== 'normal' ? <em data-severity={link.severity} aria-label={link.severity === 'critical' ? 'critical' : 'warning'} /> : null}
                  </button>
                </li>
              ))}
            </ul>
            {card.more > 0 ? <p className="neural-card-more">{`${card.more} more in the graph`}</p> : null}
          </>
        ) : <p className="neural-card-more">Nothing connected in this mode.</p>}
        <div className="neural-card-actions">
          {card.actions.map((action, i) => (
            <button key={i} className="btn btn-ghost small" data-neural-action={action.action} data-path={action.path} data-branch={action.branch} data-url={action.url}
              onClick={() => handlers.onAction(action)}>{action.label}</button>
          ))}
        </div>
      </div>
    </>
  );
}

const EYE_OPEN = (
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z" /><circle cx="12" cy="12" r="2.8" /></svg>
);
const EYE_SHUT = (
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4l16 16M9.9 5.8A9.8 9.8 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.9 3.7M6.1 7.4C3.8 9.1 2.5 12 2.5 12s3.5 6.5 9.5 6.5a9.6 9.6 0 0 0 4.2-.9" /></svg>
);

/* What the groups list does when the reader presses in it. */
export interface LegendHandlers {
  readonly onTool: (action: LegendTool) => void;
  /* The eye: hide the group, or show it again. */
  readonly onToggle: (type: string) => void;
  /* The group's name: light and frame it. */
  readonly onGroup: (type: string) => void;
}

function GroupRow({ row, handlers }: { readonly row: LegendRow; readonly handlers: LegendHandlers }): ReactElement {
  const verb = row.hidden ? 'Show' : 'Hide';
  return (
    <div className={`neural-group-row${row.hidden ? ' is-hidden' : ''}`} style={{ '--node': row.color }}>
      <button type="button" className={`neural-chip${row.on ? ' is-on' : ''}`} data-neural-group={row.type} aria-pressed={row.on} aria-disabled={row.hidden ? 'true' : undefined}
        onClick={() => handlers.onGroup(row.type)}>
        <span className="ng-icon" aria-hidden="true"><TypeIcon type={row.type} /></span><span className="ng-name" title={row.plural}>{row.name}</span>
        {row.critical ? <i className="ng-pip is-critical" title={`${row.critical} critical`}>{row.critical}</i> : null}
        {row.warning ? <i className="ng-pip is-warning" title={`${row.warning} to review`}>{row.warning}</i> : null}
        <b>{row.count}</b>{row.total !== null ? <small>{`of ${row.total}`}</small> : null}
      </button>
      <button type="button" className="neural-eye" data-neural-toggle={row.type} aria-pressed={!row.hidden}
        aria-label={`${verb} ${row.plural.toLowerCase()}`} title={`${verb} ${row.plural.toLowerCase()}`} onClick={() => handlers.onToggle(row.type)}>
        {row.hidden ? EYE_SHUT : EYE_OPEN}
      </button>
    </div>
  );
}

export function NeuralLegend({ legend, handlers }: { readonly legend: Legend; readonly handlers: LegendHandlers }): ReactElement {
  return (
    <>
      {legend.tools.length ? (
        <div className="neural-groups-tools">
          {legend.tools.map(tool => (
            <button key={tool.action} type="button" className="neural-groups-tool" data-neural-groups={tool.action} onClick={() => handlers.onTool(tool.action)}>{tool.label}</button>
          ))}
        </div>
      ) : null}
      {legend.categories.map(category => (
        <section key={category.name} className="neural-group-cat" aria-label={category.name}>
          <h4>{category.name}</h4>
          {category.rows.map(row => <GroupRow key={row.type} row={row} handlers={handlers} />)}
        </section>
      ))}
    </>
  );
}

/* The strip of events under the stage; pressing one moves the slider to it. */
export function NeuralEvents({ cards, onPick }: { readonly cards: readonly StripCard[]; readonly onPick: (index: number) => void }): ReactElement {
  if (!cards.length) return <div className="neural-event-card"><b>No events</b><small>Refresh or use demo mode</small></div>;
  return (
    <>
      {cards.map(card => (
        <button key={card.index} className={`neural-event-card ${card.active ? 'active' : ''}`} data-event-index={card.index} onClick={() => onPick(card.index)}>
          <b>{card.label}</b><small>{card.detail}</small>
        </button>
      ))}
    </>
  );
}

/*
 * Each panel's element is the page's own (index.html), so the stylesheet and
 * the rest of the page find it where they always have; React draws inside
 * it, at once, so the page can measure what it drew.
 */
const roots = new WeakMap<Element, Root>();
function draw(host: Element, element: ReactElement | null): void {
  let root = roots.get(host);
  if (!root) {
    if (!element) return;
    root = createRoot(host);
    roots.set(host, root);
  }
  const drawing = root;
  flushSync(() => drawing.render(element));
}

export function renderCard(host: Element, card: CardModel, handlers: CardHandlers): void { draw(host, <NeuralCard card={card} handlers={handlers} />); }
export function renderLegend(host: Element, legend: Legend, handlers: LegendHandlers): void { draw(host, <NeuralLegend legend={legend} handlers={handlers} />); }
export function renderEvents(host: Element, cards: readonly StripCard[], onPick: (index: number) => void): void { draw(host, <NeuralEvents cards={cards} onPick={onPick} />); }
/* A panel emptied: the card closed. */
export function clearPanel(host: Element): void { draw(host, null); }
