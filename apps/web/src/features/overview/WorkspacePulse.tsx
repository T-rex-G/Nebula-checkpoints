/*
 * The workspace pulse, drawn: the trust score, the capabilities, repository
 * activity and the recent-activity feed.
 *
 * The same elements, classes, roles and accessible names the cards drew
 * before they were components (ADR-093). What a component adds is
 * continuity: a reading that lands is drawn into the card the reader is in --
 * the table they opened stays open, the day under their pointer stays named,
 * the ledger they unfolded stays unfolded -- where the old renderer rebuilt
 * each card beneath them.
 *
 * The figures are workspace-pulse.ts's and the charts' geometry
 * pulse-charts.ts's.
 */
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import { repaintCard } from '../../components/held-repaint.ts';
import { NumbersTable } from '../../components/NumbersTable.tsx';
import { Donut, FittedArea, Gauge } from './PulseCharts.tsx';
import { CRITICAL_CAP, GRADES, KIND_LABEL, dailyCommits, feedMarks, feedView, repositories, since } from './workspace-pulse.ts';
import type { ActivityView, FeedEvent, FeedReading, PulseView, SignalsView, Status, TrustView } from './workspace-pulse.ts';

/*
 * Status marks never carry meaning by colour alone: each one ships with a
 * glyph and a word, so the reading survives colour blindness, a mono print
 * and forced-colours mode.
 */
const STATUS_GLYPH: Readonly<Record<Status, string>> = Object.freeze({
  good: '✓', warning: '△', critical: '✕', unknown: '—', muted: '○'
});
const STATUS_WORD: Readonly<Record<Status, string>> = Object.freeze({
  good: 'Healthy', warning: 'Needs attention', critical: 'At risk', unknown: 'Not measured', muted: 'Not offered'
});

function StatusMark({ status }: { status: Status }): ReactElement {
  return (
    <span className={`wp-mark wp-${status}`}>
      <span className="wp-mark-glyph" aria-hidden="true">{STATUS_GLYPH[status]}</span>
      <span className="wp-mark-word">{STATUS_WORD[status]}</span>
    </span>
  );
}

const GRADE_BANDS = GRADES.map((entry, index) => {
  const above = GRADES[index - 1];
  return index === GRADES.length - 1 && above ? `${entry.grade} below ${above.min}` : `${entry.grade} ${entry.min}+`;
}).join(', ');

function TrustCard({ trust }: { trust: TrustView }): ReactElement {
  return (
    <>
      <div className="wp-hero">
        {/*
          The label row the design uses everywhere: a mono caption on the left
          and the live reading on the right. The dot pulses only while there
          is a reading to pulse about -- animating an unmeasured state would
          suggest something is live when nothing is.
        */}
        <div className="wp-head">
          <span className="wp-label">TRUST SCORE</span>
          {trust.score !== null
            ? (
              <span className={`wp-live wp-${trust.status}`}>
                <span className="wp-dot" aria-hidden="true" />
                <span>{STATUS_WORD[trust.status]}</span>
              </span>
            )
            : null}
        </div>
        {/*
          The score is the page's headline reading, so it is drawn as its own
          measurement rather than set above a line about it. Out of 100 by
          definition, which is what makes an arc the honest shape for it.
        */}
        <div className="wp-dial">
          <Gauge
            ratio={trust.score === null ? null : trust.score / 100}
            status={trust.status}
            figure={trust.score === null ? '—' : trust.score}
            caption={trust.score === null ? 'not measured' : 'out of 100'}
          />
          <div className="wp-dial-read">
            {/*
              The letter is the score read at a coarser grain, not a second
              measurement: the bands are fixed and printed in the table below,
              so a reader can check the one against the other.
            */}
            {trust.grade
              ? (
                <p className={`wp-grade wp-${trust.status}`} aria-label={`Grade ${trust.grade}`}>
                  <span className="wp-grade-letter">{trust.grade}</span>
                  <span className="wp-grade-word">grade</span>
                </p>
              )
              : null}
            <p className="wp-hero-note">
              {trust.score === null ? 'No signal has loaded yet.' : `From ${trust.measuredCount} of ${trust.componentCount} signals measured in this session.`}
            </p>
            {trust.capped
              ? <p className="wp-hero-note wp-cap-note">Held below 50 while a critical leaked credential is still exposed. Rotate it, or record that the provider rejects it, to lift the cap.</p>
              : null}
          </div>
        </div>
      </div>
      {/*
        One small dial per signal carries its own reading and its own colour
        in one mark, and puts the percentage where the eye already is.
      */}
      <ul className="wp-components">
        {trust.components.map(component => (
          <li key={component.id} className="wp-component">
            <Gauge ratio={component.ratio} status={component.status} compact />
            <div className="wp-component-text">
              <div className="wp-component-head">
                <span className="wp-component-label">{component.label}</span>
                <StatusMark status={component.status} />
              </div>
              <p className="wp-component-detail">{component.detail}</p>
            </div>
          </li>
        ))}
      </ul>
      <NumbersTable
        caption="Trust score components"
        headings={['Signal', 'Weight', 'Reading', 'State']}
        rows={trust.components.map(component => [
          component.label,
          `${Math.round(component.weight * 100)}%`,
          component.ratio === null ? 'not measured' : `${Math.round(component.ratio * 100)}%`,
          STATUS_WORD[component.status]
        ])}
        note={`Weights renormalise across the signals measured. Grades: ${GRADE_BANDS}. An open critical leaked credential caps the score at ${CRITICAL_CAP}.`}
      />
    </>
  );
}

/*
 * Part-to-whole: the offered capabilities by their evidence. The count sits
 * in the middle of the ring that measures it, so the figure is not printed
 * twice on one card. An absent reading has no ring to sit in and is set in
 * prose rather than at figure size, which would read as an alarm rather than
 * as "nothing has loaded".
 */
function SignalsCard({ signals }: { signals: SignalsView }): ReactElement {
  if (!signals.measured) {
    return (
      <div className="wp-stat">
        <span className="wp-label">CAPABILITIES</span>
        <p className="wp-stat-value wp-stat-empty">Not measured</p>
        <p className="wp-stat-note">The capability projection has not loaded.</p>
      </div>
    );
  }
  return (
    <>
      <div className="wp-stat">
        <span className="wp-label">CAPABILITIES</span>
        <p className="wp-stat-note">capabilities offered, by the evidence behind each</p>
      </div>
      <div className="wp-ring">
        <Donut parts={signals.breakdown} total={signals.total} />
        <div className="wp-ring-core">
          <p className="wp-ring-figure">{String(signals.live)}</p>
          <span className="wp-ring-unit">offered</span>
        </div>
      </div>
      <ul className="wp-legend">
        {signals.breakdown.map(part => (
          <li key={part.id} className="wp-legend-item">
            <span className={`wp-swatch wp-fill-${part.status}`} aria-hidden="true" />
            <span className="wp-legend-label">{part.label}</span>
            <span className="wp-legend-value">{String(part.count)}</span>
          </li>
        ))}
      </ul>
      <p className="wp-stat-note wp-evidence-note">
        {`${signals.providerVerified} of ${signals.total} Provider-verified in the registry. This is registry evidence, not current release qualification.`}
      </p>
      <NumbersTable
        caption="Evidence maturity"
        headings={['Evidence', 'Capabilities']}
        rows={signals.evidence.filter(part => part.count > 0).map(part => [part.label, part.count])}
      />
    </>
  );
}

/* Two labels, not thirty: a tick under every day is a band of unreadable text that tells the reader nothing the ends do not. */
function ActivityCard({ host, activity }: { host: HTMLElement; activity: ActivityView }): ReactElement {
  const head = (
    <div className="wp-head">
      <span className="wp-label">REPOSITORY ACTIVITY</span>
    </div>
  );
  if (!activity.measured) {
    return (
      <>
        {head}
        <p className="wp-stat-note">No repository has reported a last-push time yet.</p>
      </>
    );
  }
  const last = activity.series.length - 1;
  return (
    <>
      {head}
      {/*
        The figure leads, the sentence explains: the count sits on its own,
        right-aligned against the description, so the card answers "how much"
        before it is read at all -- and the sentence still says what the count
        is of and over what window.
      */}
      <div className="wp-area-head-row">
        <div className="wp-area-head-said">
          <p className="wp-area-head-title">Repositories pushed</p>
          <p className="wp-area-head-desc">{`trailing ${activity.rollingDays}-day count, last ${activity.windowDays} days`}</p>
        </div>
        <p className="wp-area-head-figure">
          {String(activity.windowTotal)}
          <span className="wp-area-head-of">{`of ${activity.total}`}</span>
        </p>
      </div>
      <FittedArea
        host={host}
        values={activity.series}
        label={`Repositories pushed, as a trailing ${activity.rollingDays}-day count over the last ${activity.windowDays} days.`}
        options={{
          headline: true,
          labels: activity.series.map((_, index) => (last - index === 0 ? 'today' : `${last - index}d ago`)),
          axis: [{ index: 0, label: `${activity.windowDays}d ago` }, { index: last, label: 'today' }]
        }}
      />
      {activity.unknownCount > 0
        ? (
          <p className="wp-stat-note">
            {`${activity.unknownCount} repository${activity.unknownCount === 1 ? '' : 's'} reported no last-push time and ${activity.unknownCount === 1 ? 'is' : 'are'} not counted above.`}
          </p>
        )
        : null}
      <NumbersTable caption="Repositories by last push" headings={['Period', 'Repositories']} rows={activity.buckets.map(bucket => [bucket.label, bucket.count])} />
    </>
  );
}

/* --------------------------------------------------------------- the feed */

const FEED_FOLD_KEY = 'nv_feed_rows_open';

function FeedRow({ event, now }: { event: FeedEvent; now: number }): ReactElement {
  const marks = feedMarks(event);
  const timed = Number.isFinite(event.at);
  return (
    <li className="wp-feed-row">
      <p className="wp-feed-head">
        <span className={`wp-feed-kind wp-feed-kind-${event.kind}`}>{KIND_LABEL[event.kind] || event.kind}</span>
        <span className="wp-feed-repo">{event.repo}</span>
        {/*
          The time carries a machine-readable stamp as well as the words. "3h
          ago" is unreadable to anything that is not a person reading it at
          this moment, and this card is the one place on the overview where
          when it happened is the whole point.
        */}
        <time
          className="wp-feed-when"
          dateTime={timed ? new Date(event.at).toISOString() : undefined}
          title={timed ? new Date(event.at).toLocaleString() : undefined}
        >
          {since(event.at, now)}
        </time>
      </p>
      <p className="wp-feed-title">{event.title || event.ref}</p>
      {marks.length ? <p className="wp-feed-meta">{marks.join(' · ')}</p> : null}
    </li>
  );
}

/* The choice of fold sticks, per browser: a reader who opened the ledger did so to read it. Storage throws in a private window. */
function foldRemembered(): boolean {
  try { return localStorage.getItem(FEED_FOLD_KEY) === 'open'; } catch { return false; }
}

function FeedBody({ host, feed }: { host: HTMLElement; feed: FeedReading }): ReactElement {
  const count = feed.events.length;
  /*
   * The bounds, twice: a line and a sentence. The line carries the three
   * facts that change how the chart is read, including the word "sample";
   * the sentence that says it at length sits with the rows, where somebody
   * who opened the ledger is reading carefully anyway.
   */
  const scope = feed.inventoryCount
    ? `Commits from the last ${feed.days} days across ${feed.repositories} of ${feed.inventoryCount} ${repositories(feed.inventoryCount)} in the first inventory page. Up to ${feed.perRepositoryLimit} commits per repository${feed.truncated ? `; showing ${count} of ${feed.totalEvents} returned commits` : ''}. This is a bounded sample, not a complete activity history.`
    : null;
  const scopeFull = scope ? <p className="wp-stat-note wp-feed-scope-full">{scope}</p> : null;
  let lead: ReactElement;
  if (feed.body === 'no-repositories') {
    lead = <p className="wp-stat-note">No repositories are available to this session yet. Connect a sandbox repository to see recent activity.</p>;
  } else if (feed.body === 'unmeasured') {
    /* Not measured is not "nothing happened": no repository answered, and saying "no recent activity" here would be inventing a quiet week. */
    lead = <p className="wp-stat-note">No repository could be read, so recent activity is not measured.</p>;
  } else if (feed.body === 'quiet') {
    lead = <p className="wp-stat-note">{`No commits in the last ${feed.days} days across the ${feed.repositories} most recently pushed ${repositories(feed.repositories)}.`}</p>;
  } else {
    /*
     * The shape first, then the rows: the same events counted per day, so
     * nothing new is fetched and nothing can disagree, drawn as the card
     * above it is drawn -- one chart language on one overview. The header
     * carries the figure, so the plot is not asked to print it as well.
     */
    const days = dailyCommits(feed.events.map(event => ({ at: event.at })), feed.now, feed.days);
    lead = (
      <>
        <div className="wp-area-head-row">
          <div className="wp-area-head-said">
            <p className="wp-area-head-title">Commits</p>
            {/* The window and the caveat belong together on the description line. */}
            <p className="wp-area-head-desc">{`last ${feed.days} days · today still counting`}</p>
          </div>
          <p className="wp-area-head-figure">
            {String(count)}
            <span className="wp-area-head-of">{`${feed.repositories} ${repositories(feed.repositories)}`}</span>
          </p>
        </div>
        <FittedArea
          host={host}
          values={days.map(day => day.count)}
          label={`Commits per day over the last ${feed.days} days.`}
          options={{
            headline: true,
            labels: days.map(day => day.label),
            axis: [{ index: 0, label: days[0] ? days[0].label : '' }, { index: days.length - 1, label: 'today' }]
          }}
        />
        {/*
          The rows are the evidence, not the headline. Folded away, the card
          is the shape; opened, it is the ledger. <details> rather than a
          button and a hidden list: it already means this, it is
          keyboard-operable and announced with no code from here, and
          find-in-page opens it on its own.
        */}
        <details
          className="wp-feed-fold"
          open={foldRemembered()}
          onToggle={event => {
            const open = event.currentTarget.open;
            try { localStorage.setItem(FEED_FOLD_KEY, open ? 'open' : 'closed'); } catch { /* private mode */ }
          }}
        >
          <summary className="wp-feed-summary">
            <span className="wp-feed-summary-word">{`${count} commit${count === 1 ? '' : 's'}`}</span>
            <span className="wp-feed-summary-hint">with repository, sha and author</span>
          </summary>
          <ul className="wp-feed">
            {feed.events.map((event, index) => <FeedRow key={`${index}:${event.repo}:${event.ref}`} event={event} now={feed.now} />)}
          </ul>
          {scopeFull}
        </details>
      </>
    );
  }
  return (
    <>
      {lead}
      {feed.inventoryCount
        ? <p className="wp-stat-note wp-feed-scope">{`${feed.days}d · ${feed.repositories} of ${feed.inventoryCount} ${repositories(feed.inventoryCount)} · bounded sample`}</p>
        : null}
      {feed.body !== 'events' ? scopeFull : null}
      {feed.generatedAt !== null
        ? <time className="wp-stat-note wp-feed-updated" dateTime={new Date(feed.generatedAt).toISOString()}>{`Updated ${new Date(feed.generatedAt).toLocaleString()}`}</time>
        : null}
      {feed.undated > 0
        ? <p className="wp-stat-note">{`${feed.undated} event${feed.undated === 1 ? '' : 's'} reported no time and ${feed.undated === 1 ? 'is' : 'are'} not listed above.`}</p>
        : null}
      {feed.failed.length
        ? <p className="wp-stat-note">{`Not read: ${feed.failed.map(entry => `${entry.repo} (${entry.reason})`).join('; ')}.`}</p>
        : null}
    </>
  );
}

function Feed({ host, current }: { host: HTMLElement; current: unknown }): ReactElement {
  const feed = feedView(current);
  if (feed.state === 'loading') return <p className="wp-stat-note">Reading recent activity…</p>;
  if (feed.state === 'error') return <p className="wp-stat-note">{feed.message}</p>;
  return <FeedBody host={host} feed={feed} />;
}

/* ------------------------------------------------------------- the pages */

/*
 * Each card names itself through a heading that lives outside the region this
 * draws. Drawing over the whole card took that heading with it, and a card
 * with no accessible name is a card a screen reader cannot announce or a test
 * find -- so each is drawn into a body element that owns nothing but the
 * reading.
 */
function body(host: HTMLElement | null | undefined): HTMLElement | null {
  if (!host) return null;
  const inner = host.querySelector('.wp-body');
  return inner instanceof HTMLElement ? inner : host;
}

const roots = new WeakMap<HTMLElement, Root>();

/*
 * One React root per card body, made once, and every paint committed before
 * it returns. Each card is drawn once no press is down on its screen
 * (components/held-repaint.ts): a press on a moved element is lost.
 */
function paint(host: HTMLElement | null, draw: (target: HTMLElement) => ReactElement): void {
  if (!host) return;
  repaintCard(host, () => {
    let root = roots.get(host);
    if (!root) {
      host.textContent = '';
      root = createRoot(host);
      roots.set(host, root);
    }
    const target = root;
    flushSync(() => target.render(draw(host)));
  });
}

export interface PulseRoots {
  readonly trust?: HTMLElement | null;
  readonly signals?: HTMLElement | null;
  readonly activity?: HTMLElement | null;
}

export function render(hosts: PulseRoots | null, current: PulseView): PulseView {
  if (!hosts || typeof document === 'undefined') return current;
  paint(body(hosts.trust), () => <TrustCard trust={current.trust} />);
  paint(body(hosts.signals), () => <SignalsCard signals={current.signals} />);
  paint(body(hosts.activity), host => <ActivityCard host={host} activity={current.activity} />);
  return current;
}

/*
 * The feed taken off the page, as a purge or a change of identity needs: its
 * component is unmounted rather than its elements removed from under it, so
 * the next reading draws a new card instead of one React still thinks is
 * there.
 */
export function clearActivityFeed(root: HTMLElement | null): void {
  const host = body(root);
  if (!host) return;
  const mounted = roots.get(host);
  if (mounted) {
    roots.delete(host);
    flushSync(() => mounted.unmount());
  }
  host.replaceChildren();
}

/*
 * The feed is drawn on its own clock. It arrives from the network while the
 * cards above are already computed from what the session holds, so folding it
 * into render() would mean either holding the whole grid back until a request
 * lands, or drawing cards that have not changed every time it does.
 */
export function renderActivityFeed<T>(root: HTMLElement | null, current: T): T {
  if (!root || typeof document === 'undefined') return current;
  paint(body(root), host => <Feed host={host} current={current} />);
  return current;
}
