/*
 * The repository audit, drawn: the summary, what was published since, what
 * to fix first, the dependency risk, the families, the attack surface, the
 * licences, the coverage, the OWASP Top 10, the findings, the remediation
 * clocks, the kept history and the deployed site -- and the site check on
 * its own page. Each card is decided in its model (audit-screen.ts,
 * audit-cards.ts, audit-findings.ts, audit-history.ts, audit-site.ts) and
 * drawn by its component; this file puts them in their place and keeps what
 * the reader opened while the page draws them again.
 */
import { useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';

import { field } from '../../platform/values.ts';
import { text } from './audit-terms.ts';
import { summary } from './audit-screen.ts';
import type { ExportKind } from './audit-screen.ts';
import { coverage, families, licences, priorities, risk, standards, surface, watch } from './audit-cards.ts';
import { findings } from './audit-findings.ts';
import { history, remediation } from './audit-history.ts';
import {
  CoverageCards, FamiliesCard, LicencesCard, PrioritiesCard, RiskCard, StandardsCard, SummaryCard, SurfaceCard, UnavailableCard, WatchCard
} from './AuditCards.tsx';
import { FindingsCard } from './AuditFindings.tsx';
import type { OpenFindings } from './AuditFindings.tsx';
import { HistoryCard, RemediationCard } from './AuditHistory.tsx';
import { reducedMotion, unfold } from './AuditParts.tsx';
import { SiteCard, SiteLinkCard } from './AuditSite.tsx';

export { exportMenu } from './AuditParts.tsx';

/*
 * What the page does when the reader acts. Each is optional: a control whose
 * action the page does not offer is not drawn, or does nothing.
 */
export interface AuditHandlers {
  readonly onRun?: () => void;
  readonly onExport?: (kind: ExportKind) => void;
  readonly onCopyAll?: () => void;
  /* Copies a finding's fix prompt; true once it is on the clipboard, so the button can say so. */
  readonly onCopy?: (finding: unknown) => Promise<boolean> | boolean;
  readonly onWatchCheck?: () => void;
  readonly onHistoryToggle?: (id: string, open: boolean) => void;
  readonly onHistoryOpen?: (id: string, options: { readonly reveal: boolean }) => void;
  readonly onHistoryClear?: () => void;
  readonly onHistoryExport?: (id: string, kind: ExportKind) => void;
  readonly onTriage?: (finding: unknown) => void;
  readonly onReopen?: (finding: unknown) => void;
  readonly onTriageHistory?: (finding: unknown) => void;
  readonly onFilter?: (family: string | null) => void;
  readonly onOwasp?: (category: string | null) => void;
  readonly onSeverity?: (severity: string | null) => void;
  readonly onVerdict?: (verdict: string | null) => void;
  readonly onExploit?: (exploit: string | null) => void;
  /* A finding the list is not showing, asked for from a card above it: the page clears what hides it. */
  readonly onReveal?: (id: string) => void;
  readonly onQuery?: (query: string) => void;
  readonly onMore?: (limit: number) => void;
  readonly onOpen?: (finding: unknown) => void;
  readonly onSiteOpen?: (options: { readonly check: boolean }) => void;
  readonly onSiteBack?: (() => void) | null;
  readonly onSiteInput?: (value: string) => void;
  readonly onSiteCheck?: (address: string) => void;
  readonly onSiteCopyAll?: () => void;
}

/*
 * The findings the reader opened, kept by the screen while a filter hides
 * them, so narrowing the list and widening it again does not fold what they
 * were reading.
 */
function useOpenFindings(): OpenFindings {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  return useMemo(() => ({
    has: (id: string) => open.has(id),
    toggle: (id: string, value: boolean) => setOpen(current => {
      if (current.has(id) === value) return current;
      const next = new Set(current);
      if (value) next.add(id); else next.delete(id);
      return next;
    })
  }), [open]);
}

const findingNode = (host: HTMLElement, id: string): Element | null => host.querySelector(`details[data-finding-id="${CSS.escape(id)}"]`);

export function AuditScreen({ host, view, handlers, now }: { readonly host: HTMLElement; readonly view: unknown; readonly handlers: AuditHandlers; readonly now: number }): ReactElement {
  const opened = useOpenFindings();
  const offered = { open: Boolean(handlers.onOpen), triage: Boolean(handlers.onTriage), history: Boolean(handlers.onTriageHistory), reopen: Boolean(handlers.onReopen) };
  /*
   * Opens a finding from a card above the list, brings it into view and puts
   * focus on its row. A finding the list is not showing -- past the page, or
   * hidden by a filter or a search -- is brought into it first, so the press
   * is never silently lost.
   */
  const reveal = (id: string): void => {
    if (!findingNode(host, id) && handlers.onReveal) handlers.onReveal(id);
    const details = findingNode(host, id);
    if (!details) return;
    flushSync(() => { unfold('findings'); opened.toggle(id, true); });
    details.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
    const summaryRow = details.querySelector('summary');
    if (summaryRow) summaryRow.focus({ preventScroll: true });
  };
  /* The exploited filter narrows the list further down: the reader is taken to what it now shows. */
  const showFindings = (): void => {
    flushSync(() => unfold('findings'));
    host.querySelector('.audit-findings')?.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
  };
  const unavailable = text(field(view, 'unavailable'));
  const site = field(view, 'site');
  let siteCard: ReactElement | null = null;
  if (site && field(site, 'link')) siteCard = <SiteLinkCard input={site} handlers={handlers} now={now} />;
  else if (site && typeof site === 'object') siteCard = <SiteCard input={{ ...site, hasRepositoryResult: Boolean(field(view, 'result')) }} handlers={handlers} opened={opened} now={now} />;
  if (unavailable) return <><UnavailableCard reason={unavailable} />{siteCard}</>;
  const shown = summary(view, now, { export: Boolean(handlers.onExport), prompts: Boolean(handlers.onCopyAll) });
  const watching = watch(view, now, { run: Boolean(handlers.onRun) });
  const first = priorities(view);
  const ranked = risk(view);
  const grouped = families(view);
  const reached = surface(view);
  const licensed = licences(view);
  const covered = coverage(view);
  const standard = standards(view);
  const listed = findings(view, now, offered);
  const clocks = remediation(view);
  const kept = history(view, now);
  return (
    <>
      <SummaryCard summary={shown} fresh={shown.ringId !== null} handlers={handlers} />
      {watching ? <WatchCard watch={watching} handlers={handlers} /> : null}
      {first.length ? <PrioritiesCard rows={first} reveal={reveal} /> : null}
      {ranked ? <RiskCard risk={ranked} handlers={handlers} reveal={reveal} showFindings={showFindings} /> : null}
      {grouped ? <FamiliesCard lede={grouped.lede} families={grouped.families} handlers={handlers} /> : null}
      {reached ? <SurfaceCard surface={reached} handlers={handlers} /> : null}
      {licensed ? <LicencesCard licences={licensed} reveal={reveal} /> : null}
      {covered ? <CoverageCards coverage={covered} handlers={handlers} /> : null}
      {standard ? <StandardsCard said={standard.said} tiles={standard.tiles} handlers={handlers} /> : null}
      {listed ? <FindingsCard findings={listed} handlers={handlers} opened={opened} /> : null}
      {clocks ? <RemediationCard remediation={clocks} /> : null}
      {kept ? <HistoryCard history={kept} handlers={handlers} /> : null}
      {siteCard}
    </>
  );
}

/* The site check on its own page: the same card, for any address. */
export function SiteScreen({ site, handlers, now }: { readonly site: unknown; readonly handlers: AuditHandlers; readonly now: number }): ReactElement {
  const opened = useOpenFindings();
  return <SiteCard input={{ ...(typeof site === 'object' && site !== null ? site : {}), standalone: true }} handlers={handlers} opened={opened} now={now} />;
}

/*
 * One root per place on the page, made once and drawn again in place, and
 * committed before a call returns: the page reads what it drew straight
 * after (a history row it scrolls to, a toast's focus).
 */
const roots = new WeakMap<HTMLElement, Root>();
function draw(host: HTMLElement, screen: ReactElement): void {
  let root = roots.get(host);
  if (!root) {
    host.replaceChildren();
    root = createRoot(host);
    roots.set(host, root);
  }
  const drawing = root;
  flushSync(() => drawing.render(screen));
}

export function render(host: HTMLElement | null, view: unknown, handlers: AuditHandlers): void {
  if (!host) return;
  draw(host, <AuditScreen host={host} view={view} handlers={handlers} now={Date.now()} />);
}
export function renderSiteScan(host: HTMLElement | null, site: unknown, handlers: AuditHandlers): void {
  if (!host) return;
  draw(host, <SiteScreen site={site} handlers={handlers} now={Date.now()} />);
}

/*
 * A screen taken off the page -- a purge, a change of account, a capability
 * withdrawn: its components are unmounted rather than their elements removed
 * from under them, and its place is left empty for whatever comes next.
 */
export function clear(host: HTMLElement | null): void {
  if (!host) return;
  const root = roots.get(host);
  if (root) {
    roots.delete(host);
    flushSync(() => root.unmount());
  }
  host.replaceChildren();
}
