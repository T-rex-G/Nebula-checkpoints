/*
 * The findings inbox, drawn.
 *
 * The same elements, classes, roles, data attributes and accessible names the
 * page drew before it was a component (ADR-093), so the stylesheet and the
 * browser suite read it unchanged. What a component adds is continuity: the
 * search box, an open record and a half-made decision survive the repaint
 * that follows every click, where the old renderer rebuilt them.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChangeEvent, MouseEvent, ReactElement, SyntheticEvent } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import { PAGE, SEVERITY_WORD, STATE_WORD, date, days, kindLabel, timelineEvents, where } from './findings-model.ts';
import type { Filters, ListView, ShownFinding, View } from './findings-model.ts';

type ReadyView = ListView;

export interface InboxUiState {
  readonly selected: Map<string, unknown>;
  readonly expanded: Set<string>;
  disposition?: string;
  progress?: string;
}

export interface Decision {
  readonly disposition: string;
  readonly reason: string;
  readonly expiresInDays?: number;
}

export interface InboxActions {
  filter(patch: Partial<Filters>, options?: { readonly keepFocus?: boolean; readonly keepScroll?: boolean }): void;
  select(item: ShownFinding, on: boolean): void;
  clearSelection(): void;
  expand(item: ShownFinding, open: boolean): void;
  events?(item: ShownFinding, host: HTMLElement): void;
  open(item: ShownFinding): void;
  decide(decision: Decision): void;
}

interface Props {
  readonly view: View;
  readonly state: InboxUiState;
  readonly actions: InboxActions;
}

function FilterChip({ label, count, pressed, onClick }: { label: string; count: number; pressed: boolean; onClick: () => void }): ReactElement {
  return (
    <button type="button" className="fi-filter" aria-pressed={pressed ? 'true' : 'false'} onClick={onClick}>
      {`${label} ${count}`}
    </button>
  );
}

/*
 * Uncontrolled, so a repaint never writes over what is being typed. The box
 * follows the address only when the query changed from somewhere else -- a
 * cleared filter, a link -- and not when it is the box's own text, trimmed.
 */
function SearchBox({ q, actions }: { q: string; actions: InboxActions }): ReactElement {
  const box = useRef<HTMLInputElement>(null);
  const typing = useRef(0);
  const latest = useRef(actions);
  latest.current = actions;
  useLayoutEffect(() => {
    const input = box.current;
    if (input && input.value.trim() !== q) input.value = q;
  }, [q]);
  useEffect(() => () => window.clearTimeout(typing.current), []);
  const typed = (event: ChangeEvent<HTMLInputElement>): void => {
    const value = event.currentTarget.value;
    window.clearTimeout(typing.current);
    typing.current = window.setTimeout(() => latest.current.filter({ q: value.trim(), pages: 1 }, { keepFocus: true }), 250);
  };
  return (
    <input
      ref={box}
      className="fi-search"
      type="search"
      placeholder="Search title, path, package or CVE"
      aria-label="Search findings"
      defaultValue={q}
      onChange={typed}
    />
  );
}

function Row({ item, state, actions }: { item: ShownFinding; state: InboxUiState; actions: InboxActions }): ReactElement {
  const decisions = useRef<HTMLDivElement>(null);
  const selectable = item.source === 'audit' && !item.decision;
  const open = state.expanded.has(item.key);
  /* Kept when pressed, so a repaint before the toggle event lands keeps the record open. */
  const pressed = (event: MouseEvent<HTMLElement>): void => {
    const details = event.currentTarget.parentElement as HTMLDetailsElement | null;
    actions.expand(item, !(details && details.open));
  };
  const toggled = (event: SyntheticEvent<HTMLDetailsElement>): void => {
    const now = event.currentTarget.open;
    actions.expand(item, now);
    if (now && item.source === 'audit' && actions.events && decisions.current) actions.events(item, decisions.current);
  };
  const pkg = item.package;
  return (
    <li className={`fi-item fi-sev-${item.severity}`} data-key={item.key} data-state={item.state}>
      <div className="fi-item-head">
        {selectable
          ? (
            <input
              className="fi-select"
              type="checkbox"
              checked={state.selected.has(item.key)}
              aria-label={`Select ${item.label} in ${item.owner}/${item.repo}`}
              onChange={event => actions.select(item, event.currentTarget.checked)}
            />
          )
          : <span className="fi-select-gap" />}
        <span className={`fi-sev fi-sev-mark-${item.severity}`}>{SEVERITY_WORD[item.severity]}</span>
        <div className="fi-main">
          <p className="fi-title">{item.label}</p>
          <p className="fi-where">{where(item)}</p>
          <div className="fi-chips">
            <span className={`fi-chip fi-state fi-state-${item.state}`}>{STATE_WORD[item.state] || item.state}</span>
            <span className="fi-chip fi-kind">{kindLabel(item.kind)}</span>
            {item.historyOnly ? <span className="fi-chip fi-note">In history only</span> : null}
            {item.exploited ? <span className="fi-chip fi-note fi-exploited">Exploited in the wild</span> : null}
            {item.ageDays !== null && item.ageDays !== undefined ? <span className="fi-chip fi-age">{`First seen ${days(item.ageDays)}`}</span> : null}
            {Array.isArray(item.owners) && item.owners.length ? <span className="fi-chip fi-owner">{`Owner ${item.owners.join(', ')}`}</span> : null}
          </div>
        </div>
        <button type="button" className="btn btn-ghost small fi-open" onClick={() => actions.open(item)}>Open</button>
      </div>
      <details className="fi-details" open={open} onToggle={toggled}>
        <summary onClick={pressed}>Record</summary>
        <div className="fi-record">
          <ol className="fi-timeline">
            {timelineEvents(item).map((event, index) => (
              <li key={index}>
                {event.at ? <time className="fi-when">{date(event.at)}</time> : null}
                <span>{event.text}</span>
              </li>
            ))}
          </ol>
          {pkg
            ? <p className="fi-fact">{`${pkg.name} ${pkg.version}${pkg.fixed ? `, fixed in ${pkg.fixed}` : ', no fixed version published'}${item.cves.length ? ` · ${item.cves.join(', ')}` : ''}`}</p>
            : null}
          {/* Filled by the page with the team's recorded decisions when the record opens. */}
          <div className="fi-decisions" ref={decisions} />
        </div>
      </details>
    </li>
  );
}

function BulkBar({ view, state, actions }: { view: ReadyView; state: InboxUiState; actions: InboxActions }): ReactElement {
  const vocabulary = view.vocabulary;
  const count = state.selected.size;
  const [disposition, setDisposition] = useState(state.disposition || 'accepted-risk');
  const reasons = vocabulary ? vocabulary.reasons.filter(entry => entry.disposition === disposition) : [];
  const [reason, setReason] = useState(reasons[0] ? reasons[0].id : '');
  const [acceptFor, setAcceptFor] = useState(vocabulary ? String(vocabulary.acceptDays.default) : '');
  if (!vocabulary) {
    return (
      <div className="fi-bulk" role="region" aria-label="Decide the selected findings" hidden={count === 0}>
        <p className="fi-bulk-count">{`${count} selected`}</p>
        <p className="wp-stat-note">Decisions are not available here.</p>
      </div>
    );
  }
  const chosenReason = reasons.some(entry => entry.id === reason) ? reason : (reasons[0] ? reasons[0].id : '');
  const accepting = disposition === 'accepted-risk';
  return (
    <div className="fi-bulk" role="region" aria-label="Decide the selected findings" hidden={count === 0}>
      <p className="fi-bulk-count">{`${count} selected`}</p>
      <div className="fi-bulk-form">
        <select
          className="fi-bulk-disposition"
          aria-label="Decision"
          value={disposition}
          onChange={event => {
            const next = event.currentTarget.value;
            state.disposition = next;
            setDisposition(next);
            const first = vocabulary.reasons.find(entry => entry.disposition === next);
            setReason(first ? first.id : '');
          }}
        >
          {vocabulary.dispositions.map(entry => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
        </select>
        <select className="fi-bulk-reason" aria-label="Reason" value={chosenReason} onChange={event => setReason(event.currentTarget.value)}>
          {reasons.map(entry => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
        </select>
        <select className="fi-bulk-days" aria-label="Accept for" hidden={!accepting} value={acceptFor} onChange={event => setAcceptFor(event.currentTarget.value)}>
          {vocabulary.acceptDays.choices.map(choice => <option key={choice} value={String(choice)}>{`${choice} days`}</option>)}
        </select>
        <button
          type="button"
          className="btn btn-primary small fi-bulk-apply"
          onClick={() => actions.decide(accepting
            ? { disposition, reason: chosenReason, expiresInDays: Number(acceptFor) }
            : { disposition, reason: chosenReason })}
        >
          Decide
        </button>
        <button type="button" className="btn btn-ghost small fi-bulk-clear" onClick={() => actions.clearSelection()}>Clear selection</button>
      </div>
      <p className="fi-bulk-progress" role="status">{state.progress || ''}</p>
    </div>
  );
}

export function FindingsInbox({ view, state, actions }: Props): ReactElement {
  if (view.state === 'loading') {
    return <p className="wp-stat-note">Reading every finding the audits and scans have kept…</p>;
  }
  if (view.state === 'unavailable') {
    return <p className="wp-stat-note">{view.reason}</p>;
  }
  if (view.state === 'empty' || view.state === 'unmeasured') {
    return (
      <div className="fi-empty">
        <p className="fi-empty-title">{view.state === 'empty' ? 'No findings' : 'The findings could not be read'}</p>
        <p className="fi-empty-text">
          {view.state === 'empty'
            ? 'Nothing any audit or exposure scan has kept is open. Audit or scan a repository and what it finds is listed here.'
            : 'Neither the audits nor the exposure scans answered. Nothing here means the workspace is clean.'}
        </p>
      </div>
    );
  }
  const ready = view as ReadyView;
  const filters = ready.filters;
  const filtered = filters.severities.length || filters.kind || filters.repo || filters.q;
  return (
    <>
      <div className="fi-filters">
        <div className="fi-views" role="group" aria-label="Which findings">
          {ready.views.map(entry => (
            <FilterChip key={entry.id} label={entry.label || entry.id} count={entry.count} pressed={filters.view === entry.id}
              onClick={() => actions.filter({ view: entry.id as Filters['view'], pages: 1 })} />
          ))}
        </div>
        <div className="fi-severities" role="group" aria-label="Severity">
          {ready.severities.map(entry => {
            const on = (filters.severities as readonly string[]).includes(entry.id);
            return (
              <FilterChip key={entry.id} label={entry.label || entry.id} count={entry.count} pressed={on}
                onClick={() => actions.filter({
                  severities: on ? filters.severities.filter(value => value !== entry.id) : [...filters.severities, entry.id as Filters['severities'][number]],
                  pages: 1
                })} />
            );
          })}
        </div>
        <div className="fi-selects">
          <select className="fi-kind-select" aria-label="Kind of finding" value={filters.kind}
            onChange={event => actions.filter({ kind: event.currentTarget.value, pages: 1 })}>
            <option value="">Every kind</option>
            {ready.kinds.map(entry => <option key={entry.id} value={entry.id}>{`${entry.label} (${entry.count})`}</option>)}
          </select>
          <select className="fi-repo-select" aria-label="Repository" value={filters.repo}
            onChange={event => actions.filter({ repo: event.currentTarget.value, pages: 1 })}>
            <option value="">Every repository</option>
            {ready.repositories.map(entry => <option key={entry.id} value={entry.id}>{`${entry.id} (${entry.count})`}</option>)}
          </select>
          <SearchBox q={filters.q} actions={actions} />
        </div>
      </div>
      <div className="fi-summary">
        <p className="fi-count">{`${ready.matching} of ${ready.total} ${ready.total === 1 ? 'finding' : 'findings'}`}</p>
        {filtered
          ? <button type="button" className="btn btn-ghost small fi-clear" onClick={() => actions.filter({ severities: [], kind: '', repo: '', q: '', pages: 1 })}>Clear filters</button>
          : null}
      </div>
      <BulkBar view={ready} state={state} actions={actions} />
      {ready.shown.length
        ? (
          <ol className="fi-list" aria-label="Findings">
            {ready.shown.map(item => <Row key={item.key} item={item} state={state} actions={actions} />)}
          </ol>
        )
        : <p className="wp-stat-note fi-none">Nothing matches these filters.</p>}
      {ready.more
        ? (
          <button type="button" className="btn btn-ghost fi-more" onClick={() => actions.filter({ pages: filters.pages + 1 }, { keepScroll: true })}>
            {`Show ${Math.min(PAGE, ready.more)} more of ${ready.more}`}
          </button>
        )
        : null}
      {ready.notes.map(note => <p key={note} className="wp-stat-note">{note}</p>)}
    </>
  );
}

/*
 * The page draws the inbox through this, as it called the old renderer: one
 * React root per host, made once, and every paint committed before it
 * returns, because the page reads the DOM straight after (focus, scroll).
 */
const roots = new WeakMap<HTMLElement, Root>();

export function renderFindingsInbox(host: HTMLElement | null, view: View, state: InboxUiState, actions: InboxActions): void {
  if (!host) return;
  host.dataset.state = view.state;
  let root = roots.get(host);
  if (!root) {
    host.textContent = '';
    root = createRoot(host);
    roots.set(host, root);
  }
  const target = root;
  flushSync(() => target.render(<FindingsInbox view={view} state={state} actions={actions} />));
}
