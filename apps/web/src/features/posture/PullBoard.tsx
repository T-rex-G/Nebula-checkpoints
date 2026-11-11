/*
 * The open pull requests on the Overview, drawn.
 *
 * The same elements, classes, roles and accessible names the card drew
 * before it was a component (ADR-093), so the stylesheet and the browser
 * suite read it unchanged. What a component adds is continuity: a column's
 * "Show more" keeps the control the reader pressed, and with it their focus,
 * where the old renderer rebuilt the card beneath them.
 *
 * The decisions -- which repositories, which column, what the first line
 * says -- are pull-board.ts's.
 */
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import { repaintCard } from '../../components/held-repaint.ts';
import { COLUMN_SHOWN, LABELS_SHOWN, ago, notes, plural, sentence, waitPhrase } from './pull-board.ts';
import type { BoardColumn, BoardView, PullEntry, ReadError } from './pull-board.ts';

export interface BoardActions {
  open?(owner: string, repo: string, number: number): void;
  refresh?(): void;
}

/* Which columns a reader has opened past the first few. Kept for the page's life only. */
const expandedColumns = new Set<string>();

const UNAVAILABLE: Readonly<Record<Exclude<ReadError, 'limited'>, string>> = Object.freeze({
  offline: 'You are offline, so the pull requests could not be read.',
  scope: 'Every repository asked is outside this session\'s repository scope.',
  unreadable: 'The pull requests could not be read just now.'
});

function Card({ entry, actions }: { entry: PullEntry; actions: BoardActions | undefined }): ReactElement {
  const meta: string[] = [];
  if (entry.author) meta.push(entry.author);
  const opened = ago(entry.ageDays);
  if (opened) meta.push(`opened ${opened}`);
  if (entry.reviewers) meta.push(plural(entry.reviewers, 'reviewer asked', 'reviewers asked'));
  const shownLabels = entry.labels.slice(0, LABELS_SHOWN);
  const chips = entry.idle || shownLabels.length > 0;
  return (
    <li className={`pb-item${entry.idle ? ' pb-idle' : ''}`}>
      <button
        className="pb-open"
        type="button"
        aria-label={`Open pull request #${entry.number} in ${entry.owner}/${entry.repo}: ${entry.title}`}
        onClick={() => { if (actions && actions.open) actions.open(entry.owner, entry.repo, entry.number); }}
      >
        <span className="pb-title">{entry.title}</span>
        <span className="pb-where">{`${entry.owner}/${entry.repo} #${entry.number}`}</span>
        {meta.length ? <span className="pb-meta">{meta.join(' · ')}</span> : null}
        {entry.head && entry.base ? <span className="pb-branch">{`${entry.head} → ${entry.base}`}</span> : null}
      </button>
      {chips
        ? (
          <div className="pb-chips">
            {entry.idle ? <span className="pb-chip pb-chip-idle">{`Idle ${plural(entry.idleDays ?? 0, 'day', 'days')}`}</span> : null}
            {shownLabels.map((label, index) => <span key={`${index}:${label}`} className="pb-chip">{label}</span>)}
            {entry.labels.length > LABELS_SHOWN ? <span className="pb-chip pb-chip-more">{`+${entry.labels.length - LABELS_SHOWN}`}</span> : null}
          </div>
        )
        : null}
    </li>
  );
}

function Column({ definition, actions, repaint }: { definition: BoardColumn; actions: BoardActions | undefined; repaint: () => void }): ReactElement {
  const titleId = `pbCol-${definition.id}`;
  const count = definition.items.length;
  const expanded = expandedColumns.has(definition.id);
  const shown = expanded ? definition.items : definition.items.slice(0, COLUMN_SHOWN);
  return (
    <section className={`pb-col pb-col-${definition.id}`} aria-labelledby={titleId}>
      <div className="pb-col-head">
        <h3 className="pb-col-title" id={titleId}>{definition.title}</h3>
        <span className="pb-col-count" aria-label={plural(count, 'pull request', 'pull requests')}>{String(count)}</span>
      </div>
      <p className="pb-col-hint">{definition.hint}</p>
      {!count ? <p className="pb-col-empty">{definition.empty}</p> : (
        <>
          <ol className="pb-list">
            {shown.map(entry => <Card key={entry.key} entry={entry} actions={actions} />)}
          </ol>
          {count > COLUMN_SHOWN
            ? (
              <button
                className="btn btn-ghost small pb-more"
                type="button"
                aria-expanded={expanded}
                onClick={() => {
                  if (expanded) expandedColumns.delete(definition.id);
                  else expandedColumns.add(definition.id);
                  repaint();
                }}
              >
                {expanded ? 'Show fewer' : `Show ${count - COLUMN_SHOWN} more`}
              </button>
            )
            : null}
        </>
      )}
    </section>
  );
}

/* What the card says below its head, by the state of the reading. */
function Body({ view, actions, repaint }: { view: BoardView; actions: BoardActions | undefined; repaint: () => void }): ReactElement | null {
  if (view.state === 'no-repositories') return <p className="wp-stat-note">No repositories in this inventory yet, so there is nothing to read.</p>;
  if (view.state === 'loading') {
    return <p className="wp-stat-note">{`Reading the open pull requests of ${plural(view.asked, 'repository', 'repositories')}…`}</p>;
  }
  const lines = notes(view);
  let first: ReactElement;
  if (view.state === 'unavailable') {
    first = view.reason === 'limited'
      ? <p className="wp-stat-note">{`GitHub is limiting requests for this account, so the pull requests could not be read. Read again in ${waitPhrase(view.coverage.retryAfter)}.`}</p>
      : <p className="wp-stat-note">{UNAVAILABLE[view.reason]}</p>;
  } else {
    first = (
      <>
        <p className="pb-sentence">{sentence(view)}</p>
        {view.state === 'ready'
          ? <div className="pb-columns">{view.columns.map(definition => <Column key={definition.id} definition={definition} actions={actions} repaint={repaint} />)}</div>
          : null}
      </>
    );
  }
  return (
    <>
      {first}
      {lines.length ? <ul className="pb-notes">{lines.map((line, index) => <li key={`${index}:${line}`}>{line}</li>)}</ul> : null}
    </>
  );
}

function PullBoard({ view, actions, repaint }: { view: BoardView; actions: BoardActions | undefined; repaint: () => void }): ReactElement {
  const refresh = actions && actions.refresh && view.state !== 'loading' && view.state !== 'no-repositories' ? actions.refresh : null;
  return (
    <>
      <div className="wp-head pb-head">
        <span className="wp-label">PULL REQUESTS</span>
        {refresh
          ? <button className="btn btn-ghost small pb-refresh" type="button" aria-label="Read the pull requests again" onClick={() => refresh()}>Read again</button>
          : null}
      </div>
      <Body view={view} actions={actions} repaint={repaint} />
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

export function render(host: HTMLElement | null, view: BoardView, actions?: BoardActions): void {
  if (!host || typeof document === 'undefined') return;
  repaintCard(host, () => draw(host, view, actions));
}

function draw(host: HTMLElement, view: BoardView, actions: BoardActions | undefined): void {
  host.dataset.state = view.state;
  let root = roots.get(host);
  if (!root) {
    host.textContent = '';
    root = createRoot(host);
    roots.set(host, root);
  }
  const target = root;
  const repaint = (): void => render(host, view, actions);
  flushSync(() => target.render(<PullBoard view={view} actions={actions} repaint={repaint} />));
}
