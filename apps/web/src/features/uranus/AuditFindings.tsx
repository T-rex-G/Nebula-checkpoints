/*
 * The findings, drawn: a row that says how bad, what and where, opened into
 * its reason, the path Uranus traced, its advisories, what is known of its
 * exploitation and reach, and its fix; and the lists of what the team
 * triaged and what the code waived. What each says is audit-findings.ts's.
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';

import { ADVISORY_ID } from './audit-findings.ts';
import type { Advisory, FindingRow, Findings, Intel, TriagedRow, WaivedRow } from './audit-findings.ts';
import { ICON } from './audit-marks.ts';
import { ChipView, Foldable, Icon, unfold } from './AuditParts.tsx';
import type { AuditHandlers } from './AuditScreen.tsx';

/* An advisory's id, a link to OSV when it is one an address can be made of. */
export function OsvLink({ id }: { readonly id: string }): ReactElement {
  if (!ADVISORY_ID.test(id)) return <span className="audit-adv-id">{id}</span>;
  return (
    <a className="audit-adv-id" href={`https://osv.dev/vulnerability/${encodeURIComponent(id)}`} target="_blank" rel="noopener noreferrer">
      {id}<Icon path={ICON.link} className="audit-ico audit-adv-out" />
    </a>
  );
}

function AdvisoryList({ advisories }: { readonly advisories: NonNullable<FindingRow['advisories']> }): ReactElement {
  return (
    <div className="audit-adv">
      <p className="audit-adv-head">
        <strong className="audit-adv-pkg">{advisories.pkg}</strong>
        {advisories.fixed ? <><Icon path={ICON.arrow} className="audit-ico audit-adv-arrow" /><strong className="audit-adv-fixed">{advisories.fixed}</strong></> : null}
        {advisories.tags.map(tag => <span key={tag} className="audit-tag">{tag}</span>)}
      </p>
      <ul className="audit-adv-list">
        {advisories.list.map((advisory: Advisory, index) => (
          <li key={`${advisory.id}:${index}`} className="audit-adv-item" data-severity={advisory.severity}>
            <Icon path={advisory.icon} />
            <span className="audit-adv-ids">
              <OsvLink id={advisory.id} />
              {advisory.cve ? <span className="audit-adv-cve">{advisory.cve}</span> : null}
              {advisory.cvss ? <span className="audit-adv-mark">{advisory.cvss}</span> : null}
              {advisory.kev ? <span className="audit-adv-mark audit-adv-kev" title="Listed by CISA as exploited in the wild">KEV</span> : null}
              {advisory.epss ? <span className="audit-adv-mark" title="Chance of exploitation in the next 30 days (FIRST EPSS)">{advisory.epss}</span> : null}
            </span>
            <span className="audit-adv-summary">{advisory.summary}</span>
          </li>
        ))}
        {advisories.more ? <li className="audit-adv-more">{advisories.more}</li> : null}
      </ul>
    </div>
  );
}

function IntelBlock({ intel, handlers }: { readonly intel: Intel; readonly handlers: AuditHandlers }): ReactElement {
  return (
    <div className="audit-intel">
      {intel.risk ? (
        <>
          <div className="audit-intel-head">
            <span className="audit-intel-title">Exploit risk</span>
            <span className="audit-intel-score"><b>{intel.risk.score}</b><span>/100</span></span>
            <ChipView chip={{ tone: intel.risk.tone, word: intel.risk.word, className: 'audit-band' }} />
            <span className="audit-intel-meter" data-band={intel.risk.band} style={{ '--risk': `${intel.risk.meter}%` }} aria-hidden="true"></span>
          </div>
          <p className="audit-intel-factors">{intel.risk.factors}</p>
        </>
      ) : null}
      {intel.facts.length ? (
        <ul className="audit-intel-facts">
          {intel.facts.map(fact => (
            <li key={fact.said} className="audit-intel-fact" data-tone={fact.tone ?? undefined}>
              <Icon path={fact.icon} />
              <span className="audit-intel-text">{fact.said}{fact.kevLink ? <>{' '}<a className="audit-intel-link" href={fact.kevLink} target="_blank" rel="noopener noreferrer">CISA KEV<Icon path={ICON.link} className="audit-ico audit-adv-out" /></a></> : null}</span>
              {fact.files.length && handlers.onOpen ? (
                <span className="audit-intel-files">
                  {fact.files.map(path => <button key={path} type="button" className="audit-inline-file" aria-label={`Open ${path}`} onClick={() => handlers.onOpen?.({ path, line: null })}>{path}</button>)}
                </span>
              ) : null}
              {fact.chain.length ? (
                <span className="audit-intel-chain" aria-label={`Dependency path: ${fact.chain.join(', then ')}`}>
                  {fact.chain.map((name, index) => <ChainStep key={`${name}:${index}`} name={name} first={index === 0} />)}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
function ChainStep({ name, first }: { readonly name: string; readonly first: boolean }): ReactElement {
  return <>{first ? null : <Icon path={ICON.arrow} className="audit-ico audit-intel-step" />}<code>{name}</code></>;
}

/* The copy button says it copied, for as long as a reader needs to see it. */
function CopyButton({ row, handlers }: { readonly row: FindingRow; readonly handlers: AuditHandlers }): ReactElement {
  const [copied, setCopied] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      className="btn btn-ghost small audit-copy"
      data-copied={copied ? 'true' : undefined}
      onClick={() => {
        void Promise.resolve(handlers.onCopy?.(row.raw)).then(done => {
          if (done !== true) return;
          setCopied(true);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setCopied(false), 1600);
        });
      }}
    ><Icon path={ICON.copy} /><span className="audit-btn-label">{copied ? 'Copied' : 'Copy fix prompt'}</span></button>
  );
}

function FindingItem({ row, handlers, open, onToggle }: {
  readonly row: FindingRow;
  readonly handlers: AuditHandlers;
  readonly open: boolean;
  readonly onToggle: (id: string, open: boolean) => void;
}): ReactElement {
  return (
    <li className="exposure-item audit-item" data-severity={row.severity} data-verdict={row.toConfirm ? 'needs-validation' : undefined}>
      <details className="audit-details" data-finding-id={row.id || undefined} open={open} onToggle={event => { if (row.id) onToggle(row.id, event.currentTarget.open); }}>
        <summary className="audit-summary-row">
          {row.pill ? <ChipView chip={row.pill} /> : null}
          <span className="audit-row-main">
            <span className="exposure-item-title">{row.title}</span>
            <span className="audit-row-sub">
              <span className="audit-row-where">{row.where}</span>
              {row.family ? <span className="audit-row-family">{row.family}</span> : null}
            </span>
          </span>
          {row.detail || row.tags.length ? (
            <span className="audit-row-tags">
              {row.detail ? <span className="audit-row-chip" title={row.detail}>{row.detail}</span> : null}
              {row.tags.map((chip, index) => <ChipView key={`${chip.word}:${index}`} chip={chip} />)}
            </span>
          ) : null}
        </summary>
        <div className="audit-body">
          <p className="exposure-item-consequence">{row.why}</p>
          {row.clock ? (
            <p className="audit-clock-line" data-state={row.clock.state}>
              <Icon path={ICON.clock} />
              <span className="audit-clock-words"><b className="audit-clock-state">{row.clock.strong}</b>{row.clock.rest}</span>
            </p>
          ) : null}
          {row.lapsed ? <p className="audit-triage-note" data-state="lapsed"><Icon path={ICON.flag} /><span>{row.lapsed}</span></p> : null}
          {row.reach ? (
            <p className="audit-reach-line">
              <Icon path={ICON.route} /><span>Reached through </span><code className="audit-reach-route">{row.reach.through}</code>
              {row.reach.framework ? <span className="audit-reach-fw">{row.reach.framework}</span> : null}
              {row.reach.chip ? <ChipView chip={row.reach.chip} /> : null}
            </p>
          ) : null}
          {row.trace ? (
            <div className="audit-trace">
              <p className="audit-trace-head"><Icon path={ICON.route} /><span>{row.trace.head}</span></p>
              <ol className="audit-trace-list">
                {row.trace.steps.map((step, index) => (
                  <li key={`${index}:${step.place}`} className="audit-trace-step" data-role={step.role}>
                    <span className="audit-trace-role">{step.roleWord}</span>
                    <span className="audit-trace-note">{step.note}</span>
                    {step.path && handlers.onOpen
                      ? <button type="button" className="audit-inline-file" aria-label={`Open ${step.place}, step ${index + 1} of the traced path`} onClick={() => handlers.onOpen?.({ path: step.path, line: step.line })}>{step.place}</button>
                      : <span className="audit-trace-where">{step.place}</span>}
                  </li>
                ))}
              </ol>
              {row.trace.more ? <p className="audit-coverage">{row.trace.more}</p> : null}
            </div>
          ) : null}
          {row.validation ? (
            <div className="audit-validate">
              {row.validation.blocker ? <div className="audit-validate-part"><span className="audit-validate-label">What is unknown</span><p>{row.validation.blocker}</p></div> : null}
              {row.validation.check ? <div className="audit-validate-part"><span className="audit-validate-label">How to confirm</span><p>{row.validation.check}</p></div> : null}
            </div>
          ) : null}
          {row.licenceFacts ? (
            <dl className="audit-licence-basis audit-licence-facts">
              {row.licenceFacts.map(([term, value]) => <div key={term} className="audit-licence-fact"><dt>{term}</dt><dd>{value}</dd></div>)}
            </dl>
          ) : null}
          {row.advisories ? <AdvisoryList advisories={row.advisories} /> : null}
          {row.intel ? <IntelBlock intel={row.intel} handlers={handlers} /> : null}
          <div className="exposure-item-action audit-fix"><span className="audit-fix-label">Fix</span><p>{row.fix}</p></div>
          <div className="audit-body-foot">
            <p className="exposure-item-where">
              <span className="audit-rule">{row.rule}</span>
              {row.openable && handlers.onOpen
                ? <button type="button" className="audit-location" aria-label={`Open ${row.location}`} onClick={() => handlers.onOpen?.(row.raw)}><Icon path={ICON.file} /><span>{row.location}</span></button>
                : <span className="audit-location-static">{row.where}</span>}
              {row.standards.length ? (
                <span className="audit-std">
                  {row.standards.map(link => <a key={link.href} className={link.className} href={link.href} target="_blank" rel="noopener noreferrer" title={link.title}>{link.text}</a>)}
                </span>
              ) : null}
            </p>
            <div className="audit-body-actions">
              {row.triage ? (
                <button type="button" className="btn btn-ghost small audit-triage-btn" data-key={`triage:${row.id}`} aria-label={row.triage.name} onClick={() => handlers.onTriage?.(row.raw)}>
                  <Icon path={ICON.flag} /><span className="audit-btn-label">{row.triage.label}</span>
                </button>
              ) : null}
              <CopyButton row={row} handlers={handlers} />
            </div>
          </div>
        </div>
      </details>
    </li>
  );
}

/*
 * Which findings the reader opened, kept per screen while a filter hides
 * them, so narrowing the list and widening it again does not fold what
 * they were reading.
 */
export interface OpenFindings {
  readonly has: (id: string) => boolean;
  readonly toggle: (id: string, open: boolean) => void;
}

export function FindingList({ rows, handlers, opened }: { readonly rows: readonly FindingRow[]; readonly handlers: AuditHandlers; readonly opened: OpenFindings }): ReactElement {
  return (
    <ul className="exposure-list audit-list">
      {rows.map((row, index) => <FindingItem key={row.id || `row:${index}`} row={row} handlers={handlers} open={row.id ? opened.has(row.id) : false} onToggle={opened.toggle} />)}
    </ul>
  );
}

function TriagedList({ rows, handlers }: { readonly rows: readonly TriagedRow[]; readonly handlers: AuditHandlers }): ReactElement {
  return (
    <details className="audit-waived audit-triaged">
      <summary className="audit-waived-head"><Icon path={ICON.flag} /><span className="audit-waived-title">Triaged by the team</span><span className="exposure-count">{String(rows.length)}</span></summary>
      <ul className="audit-waived-list">
        {rows.map(row => (
          <li key={row.id} className="audit-waived-item audit-triaged-item" data-severity={row.severity} data-finding-id={row.id}>
            <span className="audit-waived-top">
              <Icon path={row.icon} /><span className="audit-waived-name">{row.title}</span>
              {row.state ? <ChipView chip={{ tone: row.state.tone, word: row.state.word, className: 'audit-triage-chip', glyph: ICON.flag }} /> : null}
            </span>
            <span className="audit-waived-meta"><span className="audit-rule">{row.rule}</span><span className="audit-row-where">{row.where}</span></span>
            <span className="audit-waived-reason audit-triage-reason">{row.reason}</span>
            {row.history || row.reopen ? (
              <span className="audit-triage-tools">
                {row.history ? (
                  <button type="button" className="btn btn-ghost small audit-triage-history" data-key={`triage-history:${row.id}`} aria-label={row.history} onClick={() => handlers.onTriageHistory?.(row.raw)}>
                    <Icon path={ICON.history} /><span className="audit-btn-label">History</span>
                  </button>
                ) : null}
                {row.reopen ? (
                  <button type="button" className="btn btn-ghost small audit-reopen" data-key={`reopen:${row.id}`} aria-label={row.reopen} onClick={() => handlers.onReopen?.(row.raw)}>
                    <Icon path={ICON.reopen} /><span className="audit-btn-label">Reopen</span>
                  </button>
                ) : null}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

function WaivedList({ rows }: { readonly rows: readonly WaivedRow[] }): ReactElement {
  return (
    <details className="audit-waived">
      <summary className="audit-waived-head"><Icon path={ICON.waive} /><span className="audit-waived-title">Waived in code</span><span className="exposure-count">{String(rows.length)}</span></summary>
      <ul className="audit-waived-list">
        {rows.map((row, index) => (
          <li key={`${row.rule}:${row.where}:${index}`} className="audit-waived-item" data-severity={row.severity}>
            <span className="audit-waived-top"><Icon path={row.icon} /><span className="audit-waived-name">{row.title}</span></span>
            <span className="audit-waived-meta">
              <span className="audit-rule">{row.rule}</span><span className="audit-row-where">{row.where}</span>
              {/* A package cleared in the licence policy is waived there, not on its line. */}
              {row.policy ? <span className="audit-row-where">{`cleared in ${row.policy}`}</span> : null}
            </span>
            <span className={`audit-waived-reason${row.reason ? '' : ' audit-waived-bare'}`}>{row.reason ? `“${row.reason}”` : 'No reason given'}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

/* The search narrows the list as the reader types, a little after they stop. */
function Search({ query, handlers }: { readonly query: string; readonly handlers: AuditHandlers }): ReactElement {
  const input = useRef<HTMLInputElement>(null);
  const timer = useRef(0);
  useEffect(() => {
    /* A search cleared from elsewhere -- a row that reveals its finding -- clears the field. */
    if (input.current && input.current.value !== query && document.activeElement !== input.current) input.current.value = query;
  }, [query]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <label className="audit-search">
      <Icon path={ICON.search} />
      <input
        ref={input}
        className="audit-search-input"
        data-key="search"
        type="search"
        placeholder="Search rule, file, CWE…"
        autoComplete="off"
        spellCheck={false}
        defaultValue={query}
        aria-label="Search findings"
        onInput={event => {
          const value = event.currentTarget.value;
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => handlers.onQuery?.(value), 140);
        }}
        onKeyDown={event => {
          if (event.key === 'Escape' && event.currentTarget.value) { event.preventDefault(); event.currentTarget.value = ''; handlers.onQuery?.(''); }
        }}
      />
    </label>
  );
}

export function FindingsCard({ findings, handlers, opened }: {
  readonly findings: Findings;
  readonly handlers: AuditHandlers;
  readonly opened: OpenFindings;
}): ReactElement {
  const head = (
    <>
      <div className="exposure-findings-title">
        <h2 className="exposure-heading" id="auditFindingsHeading">{findings.title}</h2>
        <span className="exposure-count" aria-hidden="true">{String(findings.inScope)}</span>
      </div>
      {findings.showAll ? <button type="button" className="btn btn-ghost small" data-key="show-all" onClick={() => handlers.onFilter?.(null)}>Show all</button> : null}
    </>
  );
  const groups: readonly (readonly [string, string, 'data-severity' | 'data-verdict' | 'data-exploit', typeof findings.severities, ((value: string | null) => void) | undefined])[] = [
    ['audit-segments', 'Show by severity', 'data-severity', findings.severities, handlers.onSeverity],
    ['audit-segments audit-verdicts', 'Show by verdict', 'data-verdict', findings.verdicts, handlers.onVerdict],
    ['audit-segments audit-exploits', 'Show by exploitation', 'data-exploit', findings.exploits, handlers.onExploit]
  ];
  return (
    <Foldable className="card exposure-findings audit-findings" id="findings" name="Findings" labelledBy="auditFindingsHeading" head={head} headClassName="exposure-section-head audit-findings-head">
      {findings.severities ? (
        <div className="audit-find-tools">
          {groups.map(([className, label, attribute, segments, choose]) => (segments ? (
            <div key={label} className={className} role="group" aria-label={label}>
              {segments.map(segment => (
                <button
                  key={segment.key}
                  type="button"
                  className="audit-segment"
                  data-key={segment.key}
                  aria-pressed={segment.pressed ? 'true' : 'false'}
                  {...(segment.value ? { [attribute]: segment.value } : {})}
                  aria-label={segment.name ?? undefined}
                  disabled={segment.disabled}
                  onClick={() => choose?.(segment.value)}
                >{segment.icon ? <Icon path={segment.icon} /> : null}<span>{segment.text}</span><span className="audit-segment-n">{String(segment.count)}</span></button>
              ))}
            </div>
          ) : null))}
          {findings.search ? <Search query={findings.search.query} handlers={handlers} /> : null}
        </div>
      ) : null}
      {findings.empty
        ? <p className="exposure-empty audit-empty">{findings.empty}</p>
        : <FindingList rows={findings.rows} handlers={handlers} opened={opened} />}
      {findings.more ? (
        <button type="button" className="btn btn-ghost audit-more" data-key="more" onClick={() => handlers.onMore?.(findings.more?.next ?? 0)}>
          <span>{findings.more.said}</span><span className="audit-more-of">{findings.more.of}</span>
        </button>
      ) : null}
      {/* The two lists keep whether the reader opened them: React draws them in place. */}
      {findings.triaged.length ? <TriagedList rows={findings.triaged} handlers={handlers} /> : null}
      {findings.waived.length ? <WaivedList rows={findings.waived} /> : null}
      {findings.triageUnavailable ? <p className="exposure-caveat">The team’s decisions could not be read for this audit, so every finding is shown as found.</p> : null}
    </Foldable>
  );
}

/* A section above the list that leads to a finding opens the list first. */
export const openFindings = (): void => unfold('findings');
