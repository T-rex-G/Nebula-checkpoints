/*
 * The Policy Digital Twin, drawn: the same elements, classes, roles and
 * names as when it was written as markup (ADR-093), so the page's handler
 * still finds every control by its data-gov-action and its data. It is drawn
 * into its place by React rather than replaced: a reading, a filter or a page
 * of the ledger changes what changed, and the control a reader is on, the
 * archive they opened and the place they scrolled to stay as they were.
 * What it says is governance.ts's.
 */
import type { ReactElement, ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import {
  archivedRows, authorActions, dangerZone, delivery, draftRows, enforcement, exceptionRows, human, ledger,
  lifecycle, policyCards, screen, summary, tone, versionRows
} from './governance.ts';
import type { Action, Bar, GovernanceInput, InterfaceAccess, LedgerRow, Screen, StageId } from './governance.ts';
import type { Fields } from '../../platform/values.ts';

/* A control's data as attributes: data-policy-id="…" and the rest, in the order they were named. */
function dataAttributes(data: Readonly<Record<string, string | number>>): Record<string, string> {
  return Object.fromEntries(Object.entries(data).map(([name, value]) => [`data-${name}`, String(value)]));
}

function Badge({ value, label }: { value: unknown; label?: string }): ReactElement {
  return (
    <span className={`gov-badge ${tone(value)}`}><span aria-hidden="true" className="gov-badge-dot"></span>{label || human(value)}</span>
  );
}

function ActionButton({ action }: { action: Action }): ReactElement {
  return (
    <button
      type="button"
      className={`btn btn-${action.kind} small`}
      data-gov-action={action.action}
      {...dataAttributes(action.data)}
      disabled={action.disabled || undefined}
      title={action.title || undefined}
    >{action.label}</button>
  );
}

function Actions({ actions, className = 'gov-actions' }: { actions: readonly Action[]; className?: string }): ReactElement {
  return <div className={className}>{actions.map(action => <ActionButton key={`${action.action}:${JSON.stringify(action.data)}`} action={action} />)}</div>;
}

function SectionHead({ id, title, lede, children }: { id: string; title: string; lede: string; children?: ReactNode }): ReactElement {
  return <div className="gov-section-head"><div><h3 id={id}>{title}</h3><p>{lede}</p></div>{children}</div>;
}

function Loading(): ReactElement {
  return (
    <section className="gov-shell" aria-busy="true" aria-label="Loading Policy Digital Twin">
      <div className="gov-skeleton gov-skeleton-title"></div>
      <div className="gov-summary-grid">{[0, 1, 2, 3].map(index => <div key={index} className="card gov-skeleton gov-skeleton-card"></div>)}</div>
      <div className="card gov-skeleton gov-skeleton-panel"></div>
    </section>
  );
}

function Failed({ message }: { message: string }): ReactElement {
  return (
    <section className="gov-shell gov-state" role="alert">
      <div className="gov-state-orb danger" aria-hidden="true">
        <svg className="gov-orb-mark" viewBox="0 0 24 24"><path d="M12 4.2a7.8 7.8 0 1 1 0 15.6 7.8 7.8 0 0 1 0-15.6z" /><path d="M12 8.2v4.6" /><path d="M12 15.6v.2" /></svg>
      </div>
      <h2>Governance evidence unavailable</h2>
      <p>{message || 'The Policy Digital Twin could not be loaded.'}</p>
      <button type="button" className="btn btn-primary small" data-gov-action="refresh">Retry</button>
    </section>
  );
}

function Empty({ access, archivedCount }: { access: InterfaceAccess; archivedCount: number }): ReactElement {
  const author = authorActions(access);
  return (
    <section className="card gov-empty">
      <div className="gov-state-orb" aria-hidden="true">
        <svg className="gov-orb-mark" viewBox="0 0 24 24"><path d="M12 3.2l7.4 3.1v5.4c0 4.4-3.1 8-7.4 9.6-4.3-1.6-7.4-5.2-7.4-9.6V6.3z" /><path d="M12 9v3.4" /><path d="M12 15.4v.2" /></svg>
      </div>
      <h3>No governance policy yet</h3>
      <p>{`Create a policy from a repository baseline or start with an empty policy. Nothing is activated automatically.${archivedCount ? ` ${archivedCount} archived ${archivedCount === 1 ? 'policy' : 'policies'} can be restored below.` : ''}`}</p>
      {author.length ? <Actions actions={author} /> : <p className="hint">Repository write access is required to create governance policy drafts.</p>}
    </section>
  );
}

function Summary({ twin }: { twin: Fields }): ReactElement {
  return (
    <div className="gov-summary-grid" aria-label="Governance summary">
      {summary(twin).map(metric => (
        <article key={metric.label} className="card gov-metric"><span>{metric.label}</span><strong>{metric.value}</strong><small>{metric.sub}</small></article>
      ))}
    </div>
  );
}

const STAGE_ICON: Readonly<Record<StageId, ReactElement>> = Object.freeze({
  draft: <><path d="M5 19.5l1-4.2L15.8 5.5a2 2 0 0 1 2.8 0l.4.4a2 2 0 0 1 0 2.8L9.2 18.5z" /><path d="M13.8 7.5l3 3" /></>,
  review: <><path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z" /><circle cx="12" cy="12" r="2.8" /></>,
  ready: <><path d="M12 3.2l7.4 3.1v5.4c0 4.4-3.1 8-7.4 9.6-4.3-1.6-7.4-5.2-7.4-9.6V6.3z" /><path d="M9 12l2.1 2.1 4-4.3" /></>,
  active: <path d="M13 3.5L5.5 13.2H12l-1 7.3 7.5-9.7H12z" />
});

function Lifecycle({ twin }: { twin: Fields }): ReactElement {
  return (
    <ol className="gov-flow" aria-label="Policy lifecycle">
      {lifecycle(twin).map(stage => (
        <li key={stage.id} className="gov-flow-stage" data-stage={stage.id} data-state={stage.state}>
          <span className="gov-flow-mark" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false">{STAGE_ICON[stage.id]}</svg></span>
          <span className="gov-flow-n">{stage.n}</span><span className="gov-flow-label">{stage.label}</span><span className="gov-flow-sub">{stage.sub}</span>
        </li>
      ))}
    </ol>
  );
}

function ProportionBar({ bar }: { bar: Bar }): ReactElement {
  const present = bar.parts.filter(part => part.n);
  return (
    <div className="gov-bar-block">
      <div className="gov-bar-head"><span>{bar.label}</span><b>{bar.total}</b></div>
      <div className="gov-bar" role="img" aria-label={bar.said}>
        {bar.total
          ? present.map(part => <i key={part.tone} data-tone={part.tone} style={{ flex: part.n }}></i>)
          : <i data-tone="none" style={{ flex: 1 }}></i>}
      </div>
      <ul className="gov-bar-legend">
        {bar.parts.map(part => <li key={part.tone} data-tone={part.tone}><span className="gov-dot" aria-hidden="true"></span>{`${part.word} `}<b>{part.n}</b></li>)}
      </ul>
    </div>
  );
}

function Enforcement({ twin }: { twin: Fields }): ReactElement {
  const [modes, outcomes] = enforcement(twin);
  return (
    <div className="card gov-enforce" aria-label="Enforcement">
      <ProportionBar bar={modes} />
      <ProportionBar bar={outcomes} />
    </div>
  );
}

function Policies({ twin, access }: { twin: Fields; access: InterfaceAccess }): ReactElement {
  const cards = policyCards(twin, access);
  if (!cards.length) return <Empty access={access} archivedCount={0} />;
  const author = authorActions(access);
  return (
    <section className="gov-section" aria-labelledby="govPoliciesTitle">
      <SectionHead id="govPoliciesTitle" title="Current policy state" lede="Active heads and latest immutable versions.">
        {author.length ? <Actions actions={author} /> : null}
      </SectionHead>
      <div className="gov-card-grid">
        {cards.map(card => (
          <article key={card.key} className="card gov-policy-card">
            <div className="gov-policy-head"><div><span className="mono gov-kicker">{card.policyKey}</span><h4>{card.name}</h4></div><Badge value={card.badge.value} label={card.badge.label} /></div>
            <p>{card.description}</p>
            <dl className="gov-facts">{card.facts.map(([term, value]) => <div key={term}><dt>{term}</dt><dd>{value}</dd></div>)}</dl>
            <div className="gov-hash mono" title="Active document hash">{card.hash}</div>
            <Actions actions={card.actions} />
            {card.lifecycle.length ? <Actions actions={card.lifecycle} className="gov-actions gov-lifecycle-actions" /> : null}
          </article>
        ))}
      </div>
    </section>
  );
}

function Drafts({ twin, access }: { twin: Fields; access: InterfaceAccess }): ReactElement | null {
  const rows = draftRows(twin, access);
  if (!rows.length) return null;
  return (
    <section className="gov-section" aria-labelledby="govDraftsTitle">
      <SectionHead id="govDraftsTitle" title="Active drafts" lede="Mutable author-owned work. Submission creates an immutable version." />
      <div className="gov-list">
        {rows.map(row => (
          <article key={row.key} className="card gov-row">
            <div className="gov-row-main"><strong>{`Draft r${row.revision}`}</strong><span>{`Policy ${row.policy} · ${row.author}`}</span><small>{`Updated ${row.updated}`}</small></div>
            <Actions actions={row.actions} />
          </article>
        ))}
      </div>
    </section>
  );
}

function Proposed({ twin, access, simulation }: { twin: Fields; access: InterfaceAccess; simulation: unknown }): ReactElement | null {
  const rows = versionRows(twin, access, simulation);
  if (!rows.length) return null;
  return (
    <section className="gov-section" aria-labelledby="govProposedTitle">
      <SectionHead id="govProposedTitle" title="Proposed immutable versions" lede="Review, simulate and activate against the current policy head." />
      <div className="gov-list">
        {rows.map(row => (
          <article key={row.key} className="card gov-version-row">
            <div className="gov-row-main">
              <div className="gov-row-title"><strong>{row.title}</strong><Badge value={row.status} /></div>
              <span>{row.review}</span>
              <small>{row.stamp}</small>
              {row.simulation
                ? <div className="gov-inline-result"><Badge value={row.simulation.eligible ? 'approved' : 'warn'} label={row.simulation.eligible ? 'Simulation eligible' : 'Simulation blocked'} /><span>{row.simulation.hash}</span></div>
                : null}
            </div>
            <Actions actions={row.actions} />
          </article>
        ))}
      </div>
    </section>
  );
}

function Exceptions({ twin, access }: { twin: Fields; access: InterfaceAccess }): ReactElement | null {
  const rows = exceptionRows(twin, access);
  if (!rows.length) return null;
  return (
    <section className="gov-section" aria-labelledby="govExceptionsTitle">
      <SectionHead id="govExceptionsTitle" title="Exceptions and waivers" lede="Time-bounded actor- and target-specific policy relief." />
      <div className="gov-list">
        {rows.map(row => (
          <article key={row.key} className="card gov-row">
            <div className="gov-row-main"><div className="gov-row-title"><strong>{row.title}</strong><Badge value={row.state} /></div><span>{row.expires}</span><small>{row.requested}</small></div>
            <Actions actions={row.actions} />
          </article>
        ))}
      </div>
    </section>
  );
}

function When({ at, title, when }: { at: string; title: string; when: string }): ReactElement {
  return <time className="gov-ledger-when" dateTime={at} title={title}>{when}</time>;
}

function LedgerEntry({ row }: { row: LedgerRow }): ReactElement {
  if (row.kind === 'decision') {
    return (
      <li className="gov-ledger-row" data-tone={row.tone} data-cleared={row.cleared ? 'true' : undefined}>
        <span className="gov-ledger-mark" aria-hidden="true"></span>
        <span className="gov-ledger-what"><strong className="mono">{row.action}</strong><small>{row.detail}</small></span>
        <span className="gov-ledger-state">{row.state}</span>
        <When at={row.at} title={row.title} when={row.when} />
      </li>
    );
  }
  const restore = row.restore;
  return (
    <li className="gov-ledger-row" data-tone={row.tone} data-cleared={row.cleared ? 'true' : undefined}>
      <span className="gov-ledger-mark" aria-hidden="true"></span>
      <span className="gov-ledger-what"><strong>{`${row.what} · `}<span className="mono">{row.policyKey}</span></strong><small>{row.detail}</small></span>
      <span className="gov-ledger-state">
        {restore === 'current'
          ? <span className="gov-ledger-now">Current</span>
          : restore
            ? (
              <button type="button" data-gov-action="rollback" {...dataAttributes(restore.data)} className="btn btn-ghost small gov-ledger-act" aria-label={restore.label} title={restore.label}>
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 12a8 8 0 1 0 2.4-5.7" /><path d="M4 4.5v4.2h4.2" /></svg>
              </button>
            )
            : null}
      </span>
      <When at={row.at} title={row.title} when={row.when} />
    </li>
  );
}

function History({ twin, access, verification, view, now }: { twin: Fields; access: InterfaceAccess; verification: unknown; view: unknown; now: number }): ReactElement {
  const book = ledger(twin, access, verification, view, now);
  return (
    <section className="gov-section" aria-labelledby="govHistoryTitle">
      <SectionHead id="govHistoryTitle" title="Evidence history" lede="Every runtime decision and activation, newest first, from the immutable ledger.">
        <div className="gov-actions"><button type="button" className="btn btn-ghost small" data-gov-action="verify-chain">{book.verify.label}</button></div>
      </SectionHead>
      {book.verify.banner ? <div className={`gov-banner ${book.verify.banner.valid ? 'ok' : 'danger'}`} role="status">{book.verify.banner.words}</div> : null}
      <div className="card gov-ledger">
        <div className="gov-ledger-tabs" role="tablist" aria-label="Evidence">
          {book.tabs.map(tab => (
            <button
              key={tab.id}
              type="button"
              data-gov-action="ledger-tab"
              data-tab={tab.id}
              data-focus-key={`ledger-tab:${tab.id}`}
              role="tab"
              id={`govLedgerTab-${tab.id}`}
              aria-controls="govLedgerPanel"
              aria-selected={tab.selected}
              className="gov-ledger-tab"
              tabIndex={tab.selected ? 0 : -1}
            >{`${tab.label} `}<span className="gov-ledger-count">{`${tab.n}${tab.more ? '+' : ''}`}</span></button>
          ))}
        </div>
        <div className="gov-ledger-chips" role="group" aria-label={book.chipsLabel}>
          {book.chips.map(chip => (
            <button
              key={chip.id}
              type="button"
              data-gov-action="ledger-filter"
              data-filter={chip.id}
              data-focus-key={`ledger-filter:${chip.id}`}
              className="gov-ledger-chip"
              data-tone={chip.tone}
              aria-pressed={chip.pressed}
              disabled={chip.disabled || undefined}
            >{`${chip.word} `}<b>{chip.n}</b></button>
          ))}
        </div>
        <div id="govLedgerPanel" role="tabpanel" aria-labelledby={`govLedgerTab-${book.tab}`}>
          {book.rows.length
            ? <ol className="gov-ledger-rows">{book.rows.map(row => <LedgerEntry key={row.key} row={row} />)}</ol>
            : <p className="gov-muted gov-ledger-empty">{book.empty}</p>}
        </div>
        <div className="gov-ledger-foot">
          <span className="gov-ledger-shown">{book.shown}</span>
          {book.foot.map(action => <ActionButton key={action.action} action={action} />)}
        </div>
        {book.clearedNote ? <p className="gov-ledger-note">Clearing tidies this view for you only. The ledger is immutable: cleared entries stay in exports and chain verification.</p> : null}
      </div>
    </section>
  );
}

function Delivery({ input, access, view, now }: { input: unknown; access: InterfaceAccess; view: unknown; now: number }): ReactElement {
  const box = delivery(input, access, view, now);
  return (
    <section className="gov-section" aria-labelledby="govDeliveryTitle">
      <SectionHead id="govDeliveryTitle" title="Notifications and signed evidence" lede="Live-only governance events, bounded exports and administrator-managed webhooks.">
        <div className="gov-actions">
          <button type="button" className="btn btn-ghost small" data-gov-action="delivery-refresh">Refresh delivery</button>
          <button type="button" className="btn btn-primary small" data-gov-action="create-export">Create signed export</button>
        </div>
      </SectionHead>
      {box.error ? <div className="gov-banner warn" role="status"><strong>Delivery evidence partially unavailable</strong><span>{box.error}</span></div> : null}
      <div className="gov-history-grid">
        <article className="card gov-inbox">
          <div className="gov-row-title"><h4>Notifications</h4><Badge value={box.unread ? 'warn' : 'current'} label={`${box.unread} unread`} /></div>
          <p className="gov-muted">{box.enabled ? 'Notifications are enabled for selected governance events.' : 'Notifications are disabled for this identity.'}</p>
          {box.inbox.length
            ? (
              <ol className="gov-ledger-rows gov-inbox-rows">
                {box.inbox.map(note => (
                  <li key={note.key} className="gov-inbox-row" data-read={note.read ? 'true' : undefined}>
                    <span className="gov-inbox-dot" aria-hidden="true"></span>
                    <span className="gov-ledger-what"><strong>{note.event}</strong><small>{note.detail}</small></span>
                    <When at={note.at} title={note.title} when={note.when} />
                  </li>
                ))}
              </ol>
            )
            : <p className="gov-muted gov-ledger-empty">{box.inboxEmpty}</p>}
          <div className="gov-ledger-foot">
            <button type="button" className="btn btn-ghost small" data-gov-action="edit-notification-preferences">Preferences</button>
            {box.inboxFoot.map(action => <ActionButton key={action.action} action={action} />)}
          </div>
        </article>
        <article className="card gov-exports">
          <div className="gov-row-title"><h4>Signed audit exports</h4><Badge value={box.exportsTotal ? 'current' : 'neutral'} label={`${box.exportsTotal} recorded`} /></div>
          <p className="gov-muted">Bounded JSON or CSV evidence envelopes. External storage is not part of this checkpoint.</p>
          {box.exports.length
            ? (
              <ol className="gov-ledger-rows">
                {box.exports.map(item => (
                  <li key={item.key} className="gov-ledger-row gov-export-row" data-tone="neutral">
                    <span className="gov-ledger-mark" aria-hidden="true"></span>
                    <span className="gov-ledger-what"><strong>{item.what}</strong><small>{item.hash}</small></span>
                    <span className="gov-ledger-state gov-export-acts">
                      <button type="button" className="btn btn-ghost small" data-gov-action="download-export" data-export-id={item.id}>Download</button>
                      <button type="button" className="btn btn-ghost small" data-gov-action="verify-export" data-export-id={item.id}>Verify</button>
                    </span>
                    <When at={item.at} title={item.title} when={item.when} />
                  </li>
                ))}
              </ol>
            )
            : <p className="gov-muted gov-ledger-empty">No signed exports have been created.</p>}
          {box.exportsFoot ? <div className="gov-ledger-foot"><span className="gov-ledger-shown">{box.exportsFoot.shown}</span><ActionButton action={box.exportsFoot.toggle} /></div> : null}
        </article>
      </div>
      {box.webhooks
        ? (
          <article className="card gov-webhooks">
            <div className="gov-section-head"><div><h4>Administrative webhooks</h4><p>HTTPS-only, DNS-revalidated, signed delivery endpoints.</p></div><button type="button" className="btn btn-primary small" data-gov-action="create-webhook">Add webhook</button></div>
            {box.webhooks.length
              ? (
                <div className="gov-list">
                  {box.webhooks.map(hook => (
                    <div key={hook.key} className="gov-row">
                      <div className="gov-row-main"><strong>{hook.name}</strong><span>{hook.url}</span><small>{hook.detail}</small></div>
                      <div className="gov-actions">
                        <button type="button" className="btn btn-ghost small" data-gov-action="rotate-webhook" data-webhook-id={hook.id}>Rotate secret</button>
                        <button type="button" className="btn btn-ghost small" data-gov-action="delete-webhook" data-webhook-id={hook.id}>Delete</button>
                      </div>
                    </div>
                  ))}
                </div>
              )
              : <p className="gov-muted">No webhooks configured.</p>}
          </article>
        )
        : null}
    </section>
  );
}

function Archived({ archived, access }: { archived: unknown; access: InterfaceAccess }): ReactElement | null {
  const rows = archivedRows(archived, access);
  if (!rows.length) return null;
  return (
    <section className="gov-section" aria-labelledby="govArchivedTitle">
      {/* Not given an open state: an archive the reader opened stays open while the screen is drawn again. */}
      <details className="card gov-archived">
        <summary><span id="govArchivedTitle" className="gov-archived-title">Archived policies</span><Badge value="neutral" label={String(rows.length)} /></summary>
        <p className="gov-muted">Archived policies enforce nothing. Their versions and evidence are kept, and restoring one brings it back switched off.</p>
        <div className="gov-list">
          {rows.map(row => (
            <article key={row.key} className="gov-row">
              <div className="gov-row-main"><strong>{row.name}</strong><span className="mono">{row.policyKey}</span><small>{row.detail}</small></div>
              <Actions actions={row.restore ? [row.restore] : []} />
            </article>
          ))}
        </div>
      </details>
    </section>
  );
}

function DangerZone({ twin, access }: { twin: Fields; access: InterfaceAccess }): ReactElement | null {
  const zone = dangerZone(twin, access);
  if (!zone) return null;
  return (
    <section className="gov-section" aria-labelledby="govResetTitle">
      <article className="card gov-danger-zone">
        <div className="gov-danger-copy"><h3 id="govResetTitle">Reset governance</h3><p>{zone.words}</p></div>
        <ActionButton action={zone.reset} />
      </article>
    </section>
  );
}

function Ready({ shown, input }: { shown: Extract<Screen, { kind: 'ready' }>; input: GovernanceInput }): ReactElement {
  const { twin, access, now } = shown;
  return (
    <section className="gov-shell" aria-busy="false">
      <header className="gov-hero">
        <div><span className="gov-eyebrow">Magnetar Sec · Kepler Twin</span><h2>Policy Digital Twin</h2><p><span className="mono">{shown.scope}</span>{` · snapshot ${shown.snapshot}`}</p></div>
        <div className="gov-hero-actions">
          <Badge value={shown.freshness} />
          {access.evidence.status !== 'current' ? <Badge value={access.evidence.status} /> : null}
          <button type="button" className="btn btn-ghost small" data-gov-action="refresh">Refresh</button>
        </div>
      </header>
      {shown.freshness !== 'current'
        ? <div className="gov-banner warn" role="status"><strong>Partial evidence</strong><span>{`${shown.incomplete.length ? `Incomplete: ${shown.incomplete.join(', ')}.` : 'One or more evidence sections are incomplete.'} Decisions remain server-authoritative.`}</span></div>
        : null}
      {access.evidence.status !== 'current'
        ? <div className="gov-banner danger" role="alert"><strong>{`Authorization evidence ${access.evidence.status}`}</strong><span>Governance actions are disabled until repository permissions are refreshed.</span></div>
        : null}
      <div className="gov-access-line"><span>Signed in as <b>{access.actor.login || 'unknown'}</b></span><span>{shown.executor}</span></div>
      <Summary twin={twin} />
      {shown.noPolicies ? null : <div className="gov-overview"><Lifecycle twin={twin} /><Enforcement twin={twin} /></div>}
      {shown.noPolicies ? <Empty access={access} archivedCount={shown.archivedCount} /> : <Policies twin={twin} access={access} />}
      <Drafts twin={twin} access={access} />
      <Proposed twin={twin} access={access} simulation={input.simulation} />
      <Exceptions twin={twin} access={access} />
      <History twin={twin} access={access} verification={input.verification} view={input.view} now={now} />
      <Archived archived={input.archived} access={access} />
      <Delivery input={input.delivery} access={access} view={input.view} now={now} />
      <DangerZone twin={twin} access={access} />
      <footer className="gov-foot"><span>Read-model hash</span><code>{shown.readModelHash}</code></footer>
    </section>
  );
}

/* The whole screen for one reading of the twin. */
export function GovernanceInterface({ input }: { input: GovernanceInput }): ReactElement {
  const shown = screen(input);
  if (shown.kind === 'loading') return <Loading />;
  if (shown.kind === 'error') return <Failed message={shown.message} />;
  return <Ready shown={shown} input={input} />;
}

const roots = new WeakMap<HTMLElement, Root>();

/* The screen drawn into its place, made once and drawn again in place; committed before this returns. */
export function render(host: HTMLElement | null, input: GovernanceInput): void {
  if (!host) return;
  let root = roots.get(host);
  if (!root) {
    host.textContent = '';
    root = createRoot(host);
    roots.set(host, root);
  }
  const drawing = root;
  flushSync(() => drawing.render(<GovernanceInterface input={input} />));
}
