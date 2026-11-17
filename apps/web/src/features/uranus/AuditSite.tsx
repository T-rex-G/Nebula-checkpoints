/*
 * The deployed site, drawn: the card on the Website page, where checks run
 * for any address, and the card the audit shows for its repository's
 * address. What each says is audit-site.ts's.
 */
import { useLayoutEffect, useRef } from 'react';
import type { ReactElement, ReactNode } from 'react';

import { REPORT_EXPORTS } from './audit-screen.ts';
import { SITE_FOLD, site as siteCard, siteLink as siteLinkCard } from './audit-site.ts';
import type { SiteReading } from './audit-site.ts';
import { ICON } from './audit-marks.ts';
import { TallyView, ProgressView } from './AuditCards.tsx';
import { FindingList } from './AuditFindings.tsx';
import type { OpenFindings } from './AuditFindings.tsx';
import { ExportMenu, Foldable, Icon, RingView, useExpanded } from './AuditParts.tsx';
import type { AuditHandlers } from './AuditScreen.tsx';

/* The mark and titles every site card opens with. */
function SiteHead({ kicker, id, heading, lede }: { readonly kicker?: string; readonly id: string; readonly heading: string; readonly lede: string }): ReactElement {
  return (
    <>
      <span className="audit-site-mark"><Icon path={ICON.globe} /></span>
      <div className="audit-site-titles">
        {kicker ? <p className="audit-site-kicker">{kicker}</p> : null}
        <h2 className="exposure-heading" id={id}>{heading}</h2>
        <p className="audit-site-lede">{lede}</p>
      </div>
    </>
  );
}

/*
 * The address field. It is the reader's while they type -- what they type is
 * handed on as they go -- and a new address from the page (a check settles
 * on the site's origin) replaces what it shows.
 */
function Address({ id, url, disabled, handlers }: { readonly id: string; readonly url: string; readonly disabled: boolean; readonly handlers: AuditHandlers }): ReactElement {
  const input = useRef<HTMLInputElement>(null);
  const shown = useRef(url);
  useLayoutEffect(() => {
    if (shown.current === url) return;
    shown.current = url;
    if (input.current) input.current.value = url;
  }, [url]);
  return (
    <input ref={input} className="audit-site-input" id={id} type="url" inputMode="url" autoComplete="url" spellCheck={false} placeholder="https://your-app.example.com"
      defaultValue={url} disabled={disabled} onInput={event => handlers.onSiteInput?.(event.currentTarget.value)} />
  );
}

/* A finished check: its grade, what it found, what was checked and the findings. */
function Reading({ reading, exportable, handlers, opened }: {
  readonly reading: SiteReading; readonly exportable: boolean; readonly handlers: AuditHandlers; readonly opened: OpenFindings;
}): ReactElement {
  const [shown, showAll] = useExpanded(`site:${reading.id}`);
  const total = reading.rows.length;
  /* The worst first; past five, the rest fold behind one button so the page stays readable. */
  const all = shown || total <= SITE_FOLD;
  const rows = all ? reading.rows : reading.rows.slice(0, SITE_FOLD);
  return (
    <>
      <div className="audit-grade-row audit-site-grade">
        <RingView key={reading.id} ring={reading.ring} fresh />
        <div className="audit-grade-read">
          <span className="audit-origin" title={reading.origin}><Icon path={ICON.globe} /><span>{reading.host}</span></span>
          <p className="audit-verdict audit-verdict-sm">{reading.verdict}</p>
          <TallyView tally={reading.tally} />
          <div className="audit-notes">
            {reading.cap ? <p className="audit-cap">Held below 50 while a critical finding is open.</p> : null}
            {reading.diff ? <p className="audit-diff">{reading.diff}</p> : null}
            <p className="audit-coverage">{reading.coverage}</p>
          </div>
        </div>
      </div>
      <p className={reading.assessment.complete ? 'audit-coverage audit-site-assessment' : 'exposure-caveat audit-site-assessment'} data-coverage={reading.assessment.state}>{reading.assessment.said}</p>
      <ul className="audit-headers" aria-label="Security headers">
        {reading.headers.map((header, index) => (
          <li key={`${header.name}:${index}`} className="audit-header" data-present={header.present ? 'true' : 'false'} data-via={header.via ? 'true' : undefined} title={header.title ?? undefined}>
            <span className="audit-header-glyph">{header.glyph}</span>
            <span className="audit-header-text"><span className="audit-header-name">{header.name}</span><span className="audit-header-job">{header.job}</span></span>
            <span className="audit-header-state">{header.state}</span>
          </li>
        ))}
      </ul>
      {reading.ledger ? (
        <div className="audit-site-ledger">
          <div className="audit-site-ledger-head"><h3 className="audit-site-list-title">What was checked</h3><span className="audit-site-ledger-sum">{reading.ledger.summary}</span></div>
          <ul className="audit-site-ledger-list" aria-label="What was checked">
            {reading.ledger.rows.map((row, index) => (
              <li key={`${row.name}:${index}`} className="audit-site-ledger-row" data-state={row.state}>
                <span className="audit-site-ledger-glyph" aria-hidden="true">{row.glyph}</span>
                <span className="sr-only">{row.said}</span>
                <span className="audit-site-ledger-text"><span className="audit-site-ledger-name">{row.name}</span><span className="audit-site-ledger-detail">{row.detail}</span></span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {reading.libraries.length ? (
        <ul className="audit-site-libs" aria-label="Browser libraries">
          {reading.libraries.map((library, index) => (
            <li key={`${library.name}:${index}`} className="audit-site-lib" data-state={library.state} title={library.title}>
              <span className="audit-site-lib-name">{library.name}</span><span className="audit-site-lib-state">{library.said}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {total || exportable ? (
        <div className="audit-site-list-head">
          <div className="exposure-findings-title"><h3 className="audit-site-list-title">Findings</h3><span className="exposure-count" aria-hidden="true">{String(total)}</span></div>
          <div className="audit-actions">
            {total ? (
              <button type="button" className="btn btn-ghost audit-tool" data-key="site-prompts" aria-label="Copy all fix prompts" title="Copy all fix prompts" onClick={() => handlers.onSiteCopyAll?.()}>
                <Icon path={ICON.copy} /><span className="audit-btn-label">Prompts</span>
              </button>
            ) : null}
            {exportable ? <ExportMenu onExport={kind => handlers.onExport?.(kind)} menuKey="site-export" kinds={REPORT_EXPORTS} /> : null}
          </div>
        </div>
      ) : null}
      {total ? <FindingList rows={rows} handlers={{ onCopy: handlers.onCopy }} opened={opened} /> : null}
      {total && !all ? (
        <button type="button" className="btn btn-ghost audit-more" data-key="site-more" onClick={showAll}>
          <span>{`Show ${total - SITE_FOLD} more`}</span><span className="audit-more-of">{`${SITE_FOLD} of ${total}`}</span>
        </button>
      ) : null}
    </>
  );
}

/* The site card: on the Website page for any address, or within the audit, folding with its other sections. */
export function SiteCard({ input, handlers, opened, now }: { readonly input: unknown; readonly handlers: AuditHandlers; readonly opened: OpenFindings; readonly now: number }): ReactElement {
  const card = siteCard(input, { export: Boolean(handlers.onExport) }, now);
  const headingId = `${card.idPrefix}Heading`;
  const head = <SiteHead id={headingId} heading={card.heading} lede={card.lede} />;
  const body: ReactNode = (
    <>
      {/* Opened from a repository's audit: the check is for that repository, and the way back is one press. */}
      {card.from ? (
        <div className="audit-site-from">
          <span className="audit-site-from-t">{`For ${card.from}`}</span>
          {handlers.onSiteBack ? <button type="button" className="btn btn-ghost audit-tool" data-key="site-back" onClick={() => handlers.onSiteBack?.()}>Back to the audit</button> : null}
        </div>
      ) : null}
      <form className="audit-site-form" noValidate onSubmit={event => {
        event.preventDefault();
        const field = event.currentTarget.elements.namedItem(`${card.idPrefix}Url`);
        handlers.onSiteCheck?.(field instanceof HTMLInputElement ? field.value : card.url);
      }}>
        <label className="audit-site-label" htmlFor={`${card.idPrefix}Url`}>Site address</label>
        <div className="audit-site-field">
          <Address id={`${card.idPrefix}Url`} url={card.url} disabled={card.running} handlers={handlers} />
          <button type="submit" className="btn btn-primary" disabled={card.running}>{card.submit}</button>
        </div>
        {card.suggested ? <p className="audit-site-hint">Filled in from the repository’s homepage.</p> : null}
        {card.standaloneHint ? <p className="audit-site-hint">Any site you may test: it is asked only what any visitor’s browser asks, and nothing is submitted, guessed or tried.</p> : null}
      </form>
      {card.progress ? <ProgressView progress={card.progress} className="audit-progress audit-site-progress" steps="Site check steps" bar="Site check progress" /> : null}
      {card.error !== null ? <p className="audit-lede audit-error" role="alert">{card.error}</p> : null}
      {card.reading ? <Reading reading={card.reading} exportable={card.exportable} handlers={handlers} opened={opened} /> : null}
    </>
  );
  if (card.standalone) {
    return <section className="card audit-site" aria-labelledby={headingId}><div className="audit-site-head">{head}</div>{body}</section>;
  }
  return <Foldable className="card audit-site" id="site" name="Deployed site" labelledBy={headingId} headClassName="audit-site-head" head={head}>{body}</Foldable>;
}

/*
 * The deployed site as the audit shows it: this repository's address, what
 * the latest check of it found, and the way to the Website page, where
 * checks run.
 */
export function SiteLinkCard({ input, handlers, now }: { readonly input: unknown; readonly handlers: AuditHandlers; readonly now: number }): ReactElement {
  const link = siteLinkCard(input, now);
  const reading = link.reading;
  const open = (check: boolean): void => handlers.onSiteOpen?.({ check });
  return (
    <Foldable className="card audit-site audit-site-link" id="site" name="Deployed site" labelledBy="auditSiteHeading" headClassName="audit-site-head"
      head={<SiteHead kicker="Parallax Probe · Website" id="auditSiteHeading" heading="Deployed site" lede="Site checks run on the Website page. The latest one for this address shows here and joins this audit’s exports." />}>
      <div className="audit-site-link-body">
        <div className="audit-site-where">
          {link.url ? (
            <>
              <span className="audit-origin" title={link.url}><Icon path={ICON.globe} /><span>{link.host}</span></span>
              {link.suggested ? <span className="audit-site-hint">From the repository’s homepage</span> : null}
            </>
          ) : <span className="audit-site-hint">The repository declares no homepage; add the address on the Website page.</span>}
        </div>
        {link.running ? <p className="audit-lede audit-muted">Checking on the Website page…</p> : null}
        {reading ? (
          <div className="audit-grade-row audit-site-grade">
            <RingView key={reading.id} ring={reading.ring} fresh />
            <div className="audit-grade-read">
              <p className="audit-verdict audit-verdict-sm">{reading.verdict}</p>
              <TallyView tally={reading.tally} />
              {reading.checked ? <p className="audit-coverage">{reading.checked}</p> : null}
            </div>
          </div>
        ) : null}
        {!link.running && !reading ? <p className="audit-lede audit-muted">{link.idle}</p> : null}
        <div className="audit-actions audit-site-link-actions">
          {link.held ? (
            <>
              <button type="button" className="btn btn-primary" data-key="site-open" onClick={() => open(false)}>Open in Parallax</button>
              <button type="button" className="btn btn-ghost" data-key="site-again" disabled={link.running} onClick={() => open(true)}>Check again</button>
            </>
          ) : (
            <button type="button" className="btn btn-primary" data-key="site-open" disabled={link.running} onClick={() => open(Boolean(link.url))}>{link.url ? 'Check in Parallax' : 'Open Parallax'}</button>
          )}
        </div>
      </div>
    </Foldable>
  );
}
