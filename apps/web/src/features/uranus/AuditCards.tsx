/*
 * The repository audit's cards, drawn: the summary and its running audit,
 * what was published since the last audit, what to fix first, the
 * dependency risk, the families, the attack surface, the licences, the
 * coverage, what is already in place and the OWASP Top 10. What each says
 * is decided in audit-screen.ts and audit-cards.ts.
 */
import { useRef } from 'react';
import type { ReactElement, ReactNode } from 'react';

import { LICENCE_FAMILY, REACH, RISK_BAND, SEVERITY, VERDICT } from './audit-terms.ts';
import { RISK_FOLD, SURFACE_FOLD, LICENCE_FOLD, WATCH_FOLD } from './audit-cards.ts';
import type { Coverage, Family, Licences, OwaspTile, Priority, Risk, Surface, Watch } from './audit-cards.ts';
import type { Progress, Split, Summary, Tally } from './audit-screen.ts';
import { SCOPE } from './audit-screen.ts';
import { FAMILY_ICON, ICON } from './audit-marks.ts';
import { ChipView, ExportMenu, Foldable, Icon, RingView, UranusLoader, UranusMark, unfold, useExpanded } from './AuditParts.tsx';
import { OsvLink } from './AuditFindings.tsx';
import type { AuditHandlers } from './AuditScreen.tsx';

/* A head of title and lede, the shape most cards share. */
function Titles({ id, title, lede, className = 'audit-card-titles' }: { readonly id: string; readonly title: string; readonly lede: ReactNode; readonly className?: string }): ReactElement {
  return <div className={className}><h2 className="audit-kicker" id={id}>{title}</h2>{lede}</div>;
}
const Lede = ({ said }: { readonly said: string }): ReactElement => <p className="audit-card-lede">{said}</p>;

/* An icon and a short word; the accessible name says the whole action. */
function IconButton({ path, word, name, className, onClick, dataKey, disabled, title }: {
  readonly path: string; readonly word: string; readonly name: string; readonly className: string; readonly onClick?: () => void;
  readonly dataKey: string; readonly disabled?: boolean; readonly title?: string | null;
}): ReactElement {
  return (
    <button type="button" className={className} data-key={dataKey} aria-label={name} title={title ?? name} disabled={disabled} onClick={onClick}>
      <Icon path={path} /><span className="audit-btn-label">{word}</span>
    </button>
  );
}

/* "Show all": the rows past the fold are drawn hidden, so a reader of the page's text still finds them. */
function More({ dataKey, total, fold, onShow }: { readonly dataKey: string; readonly total: number; readonly fold: number; readonly onShow: () => void }): ReactElement {
  return <button type="button" className="btn btn-ghost audit-more" data-key={dataKey} onClick={onShow}><span>{`Show all ${total}`}</span><span className="audit-more-of">{`${fold} of ${total}`}</span></button>;
}

export function TallyView({ tally }: { readonly tally: Tally }): ReactElement {
  return (
    <ul className="audit-tally" aria-label={tally.label}>
      {tally.items.map(item => (
        <li key={item.severity} className="audit-tally-item" data-severity={item.severity} data-zero={item.count ? 'false' : 'true'}>
          <ChipView chip={{ tone: item.severity, word: SEVERITY[item.severity].word, glyph: SEVERITY[item.severity].icon, count: item.count, large: true, zero: !item.count,
            beam: tally.beam && item.severity === 'critical' && item.count > 0 }} />
        </li>
      ))}
    </ul>
  );
}

function SplitView({ split }: { readonly split: Split }): ReactElement {
  return (
    <div className="audit-split" aria-label={split.label}>
      <ChipView chip={{ tone: VERDICT.confirmed.tone, word: 'confirmed', glyph: VERDICT.confirmed.icon, count: split.confirmed, zero: split.confirmed === 0 }} />
      <ChipView chip={{ tone: VERDICT['needs-validation'].tone, word: 'to confirm', glyph: VERDICT['needs-validation'].icon, count: split.leads, zero: !split.leads }} />
    </div>
  );
}

/*
 * Where a running audit is: four steps, the current one lit, a line in
 * words, and how many of the files have been read. Only a change of step is
 * announced; the running count would be noise.
 */
export function ProgressView({ progress, className, steps, bar }: { readonly progress: Progress; readonly className: string; readonly steps: string; readonly bar: string }): ReactElement {
  const announced = useRef<{ key: string; said: string } | null>(null);
  if (!announced.current || announced.current.key !== progress.announce.key) announced.current = { key: progress.announce.key, said: progress.announce.said };
  const value = progress.value;
  return (
    <div className={className} data-stage={progress.stage}>
      <ol className="audit-steps" aria-label={steps}>
        {progress.steps.map(step => (
          <li key={step.id} className="audit-step" data-step={step.id} data-state={step.state} aria-current={step.state === 'active' ? 'step' : undefined}>
            <span className="audit-step-dot"></span><span className="audit-step-label">{step.label}</span>
          </li>
        ))}
      </ol>
      <p className="audit-progress-line">{progress.line}</p>
      <div className="audit-progress-bar" role="progressbar" aria-label={bar} style={{ '--audit-read': progress.fraction.toFixed(4) }} data-busy={progress.busy ? 'true' : 'false'}
        aria-valuemin={value ? 0 : undefined} aria-valuemax={value ? value.max : undefined} aria-valuenow={value ? value.now : undefined} aria-valuetext={value ? value.said : undefined}>
        <span className="audit-progress-fill"></span>
      </div>
      <span className="sr-only" role="status" data-step={announced.current.key}>{announced.current.said}</span>
    </div>
  );
}

export function SummaryCard({ summary, fresh, handlers }: { readonly summary: Summary; readonly fresh: boolean; readonly handlers: AuditHandlers }): ReactElement {
  const body = summary.body;
  return (
    <section className="card audit-summary" aria-labelledby="auditSummaryHeading">
      <div className="audit-grade-row" data-stored={summary.stored ? 'true' : undefined}>
        {summary.scanning
          ? <div className="audit-grade audit-grade-scan" role="img" aria-label="Auditing" data-running="true"><UranusLoader /></div>
          : <RingView key={summary.ringId ?? 'none'} ring={summary.ring} fresh={fresh} />}
        <div className="audit-grade-read">
          <div className="audit-summary-head">
            <h2 className="audit-kicker" id="auditSummaryHeading">Repository audit</h2>
            {summary.ref ? <span className="audit-ref">{summary.ref}</span> : null}
          </div>
          <p className="audit-verdict">{summary.verdict}</p>
          {summary.error !== null ? <p className="audit-lede audit-error" role="alert">{summary.error}</p> : null}
          {body.kind === 'progress' ? <ProgressView progress={body.progress} className="audit-progress" steps="Audit steps" bar="Files read" /> : null}
          {body.kind === 'stored' ? (
            <>
              <TallyView tally={body.tally} />
              <div className="audit-notes">
                {body.cap ? <p className="audit-cap">{body.cap}</p> : null}
                <p className="audit-stored-note">{body.note}</p>
              </div>
            </>
          ) : null}
          {body.kind === 'scope' ? <ul className="audit-scope" aria-label="What the audit checks">{SCOPE.map(item => <li key={item}>{item}</li>)}</ul> : null}
          {body.kind === 'result' ? (
            <>
              <TallyView tally={body.tally} />
              {body.split ? <SplitView split={body.split} /> : null}
              {body.cap || body.diff || body.waived || body.clocks ? (
                <div className="audit-notes">
                  {body.cap ? <p className="audit-cap">{body.cap}</p> : null}
                  {body.diff ? <p className="audit-diff">{body.diff}</p> : null}
                  {body.waived ? <p className="audit-waived-note">{body.waived}</p> : null}
                  {body.clocks ? <p className="audit-clock-note" data-state={body.clocks.state}><Icon path={ICON.clock} /><span>{body.clocks.said}</span></p> : null}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
      {summary.evidence ? (
        <dl className="audit-evidence" aria-label={summary.evidence.label}>
          {summary.evidence.items.map(item => (
            <div key={item.term} className="audit-evidence-item" title={item.title}>
              <dt><Icon path={ICON[item.icon]} /><span>{item.term}</span></dt>
              <dd>{item.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {summary.engine ? (
        <p className="audit-engine-line">
          <UranusMark /><strong>{summary.engine.name}</strong>{' '}<span>{summary.engine.parts}</span>
        </p>
      ) : null}
      {summary.caveat ? <p className="exposure-caveat">{summary.caveat}</p> : null}
      <div className="audit-actions">
        <button type="button" className="btn btn-primary audit-run" disabled={summary.run.disabled} onClick={() => handlers.onRun?.()}>
          <Icon path={ICON.run} /><span className="audit-btn-label">{summary.run.label}</span>
        </button>
        {summary.exports ? <ExportMenu onExport={kind => handlers.onExport?.(kind)} menuKey="export" kinds={summary.exports.kinds} /> : null}
        {summary.prompts ? <IconButton path={ICON.copy} word="Prompts" name="Copy all fix prompts" className="btn btn-ghost audit-tool" dataKey="prompts" onClick={() => handlers.onCopyAll?.()} /> : null}
      </div>
    </section>
  );
}
export function UnavailableCard({ reason }: { readonly reason: string }): ReactElement {
  return (
    <section className="card audit-summary audit-unavailable" aria-labelledby="auditSummaryHeading">
      <h2 className="audit-kicker" id="auditSummaryHeading">Repository audit</h2>
      <p className="audit-verdict">Repository audit is unavailable.</p>
      <p className="audit-coverage">{reason}</p>
      <p className="audit-coverage">The deployed-site check below does not read the repository and works here.</p>
    </section>
  );
}

/* ---- Since the last audit ---------------------------------------------------- */

export function WatchCard({ watch, handlers }: { readonly watch: Watch; readonly handlers: AuditHandlers }): ReactElement {
  const [shown, showAll] = useExpanded(`watch:${watch.id}`);
  const all = shown || watch.rows.length <= WATCH_FOLD + 1;
  const stateIcon = watch.state.icon === 'news' ? ICON.news : watch.state.icon === 'check' ? ICON.check : ICON.unknown;
  return (
    <Foldable className="card audit-watch" id="watch" name="Since the last audit" labelledBy="auditWatchHeading" headClassName="audit-card-head"
      head={<Titles id="auditWatchHeading" title="Since the last audit" lede={<Lede said={watch.lede} />} />} data={{ 'data-alerts': watch.alerts ? 'true' : undefined }}>
      <p className="audit-watch-state" role="status" data-state={watch.state.state}>
        {watch.state.pulse ? <span className="audit-watch-pulse"></span> : null}
        {watch.state.icon ? <Icon path={stateIcon} className="audit-ico audit-watch-state-ico" /> : null}
        <span>{watch.state.said}</span>
      </p>
      {watch.rows.length ? (
        <ol className="audit-watch-list" aria-label="Published since the last audit">
          {watch.rows.map((row, index) => (
            <li key={`${row.advisory}:${row.name}:${index}`} className="audit-watch-row" data-kind={row.kind} hidden={!all && index >= WATCH_FOLD}>
              <span className="audit-watch-glyph" data-tone={row.glyphTone}><Icon path={row.exploitedKind ? ICON.flame : ICON.news} /></span>
              <div className="audit-watch-main">
                <p className="audit-risk-pkg">
                  <span className="audit-risk-name">{row.name}</span><span className="audit-risk-ver">{row.version}</span>
                  {row.fixed ? <><Icon path={ICON.arrow} className="audit-ico audit-risk-arrow" /><span className="audit-risk-fix">{row.fixed}</span></> : null}
                </p>
                <p className="audit-watch-sub">{row.said}</p>
                {row.advisory || row.kev ? (
                  <p className="audit-watch-refs">
                    {row.advisory ? <OsvLink id={row.advisory} /> : null}
                    {row.kev ? <a className="audit-adv-id" href={`https://www.cisa.gov/known-exploited-vulnerabilities-catalog?search_api_fulltext=${encodeURIComponent(row.kev)}`} target="_blank" rel="noopener noreferrer">CISA KEV<Icon path={ICON.link} className="audit-ico audit-adv-out" /></a> : null}
                  </p>
                ) : null}
              </div>
              <div className="audit-risk-tags">{row.tags.map((chip, at) => <ChipView key={`${chip.word}:${at}`} chip={chip} />)}</div>
            </li>
          ))}
        </ol>
      ) : null}
      {watch.rows.length && !all ? <More dataKey="watch-more" total={watch.rows.length} fold={WATCH_FOLD} onShow={showAll} /> : null}
      <div className="audit-watch-actions">
        <IconButton path={ICON.search} word={watch.check.label} name="Check for new advisories now" className="btn btn-ghost audit-tool" dataKey="watch-check"
          disabled={watch.check.disabled} title={watch.check.title} onClick={() => handlers.onWatchCheck?.()} />
        {watch.again ? <IconButton path={ICON.run} word="Audit again" name="Audit again to rank these by reach and risk" className="btn btn-ghost audit-tool" dataKey="watch-run" onClick={() => handlers.onRun?.()} /> : null}
      </div>
    </Foldable>
  );
}

/* ---- Fix first ------------------------------------------------------------------ */

export function PrioritiesCard({ rows, reveal }: { readonly rows: readonly Priority[]; readonly reveal: (id: string) => void }): ReactElement {
  return (
    <Foldable className="card audit-first" id="first" name="Fix first" labelledBy="auditFirstHeading" headClassName="audit-card-head audit-first-head"
      head={<h2 className="audit-kicker" id="auditFirstHeading">Fix first</h2>}>
      <ol className="audit-first-list">
        {rows.map(row => (
          <li key={row.id || row.rank} className="audit-first-item" data-severity={row.severityText}>
            <button type="button" className="audit-first-btn" aria-label={row.name} onClick={() => reveal(row.id)}>
              <span className="audit-first-rank">{String(row.rank)}</span>
              <span className="audit-first-tags">{row.chip ? <ChipView chip={row.chip} /> : null}</span>
              <span className="audit-first-body">
                <span className="audit-first-title">{row.title}</span><span className="audit-first-where">{row.where}</span>
                {row.detail || row.extra.length ? (
                  <span className="audit-first-extra">
                    {row.detail ? <span className="audit-first-chip">{row.detail}</span> : null}
                    {row.extra.map((chip, at) => <ChipView key={`${chip.word}:${at}`} chip={chip} />)}
                  </span>
                ) : null}
              </span>
              <Icon path={ICON.arrow} className="audit-ico audit-first-go" />
            </button>
          </li>
        ))}
      </ol>
    </Foldable>
  );
}

/* ---- Dependency risk ---------------------------------------------------------- */

export function RiskCard({ risk, handlers, reveal, showFindings }: { readonly risk: Risk; readonly handlers: AuditHandlers; readonly reveal: (id: string) => void; readonly showFindings: () => void }): ReactElement {
  const [shown, showAll] = useExpanded(`risk:${risk.id}`);
  const all = shown || risk.rows.length <= RISK_FOLD + 1;
  const toggle = risk.exploitedToggle;
  return (
    <Foldable className="card audit-risk" id="risk" name="Dependency risk" labelledBy="auditRiskHeading" headClassName="audit-card-head"
      head={<Titles id="auditRiskHeading" title="Dependency risk" lede={<Lede said="Each vulnerable package, ranked by whether it is exploited in the wild, how likely it is to be, and how close it sits to the code that runs." />} />}>
      <div className="audit-surface-stats audit-risk-stats" role="list">
        {toggle ? (
          <div role="listitem">
            <button type="button" className="audit-risk-stat" data-key="risk-exploited" aria-pressed={toggle.pressed ? 'true' : 'false'} aria-label={toggle.label} disabled={!toggle.count}
              onClick={() => {
                if (!handlers.onExploit) return;
                const showing = !toggle.pressed;
                handlers.onExploit(showing ? 'kev' : null);
                /* The filter narrows the findings list further down: take the reader to what it now shows. */
                if (!showing) return;
                showFindings();
              }}
            ><ChipView chip={{ tone: 'critical', word: 'exploited in the wild', glyph: ICON.flame, count: toggle.count, large: true, zero: !toggle.count, beam: toggle.count > 0 }} /></button>
          </div>
        ) : null}
        {risk.catalogUnavailable ? <div role="listitem"><ChipView chip={{ tone: 'pending', word: 'Exploit catalog unavailable', glyph: ICON.flame, large: true, title: 'CISA’s catalog could not be read: nothing is marked exploited, and nothing is marked clear' }} /></div> : null}
        {risk.ransom ? <div role="listitem"><ChipView chip={{ tone: 'critical', word: 'used by ransomware', glyph: ICON.ransom, count: risk.ransom, large: true }} /></div> : null}
        {risk.bands.map(band => (
          <div key={band.band} role="listitem"><ChipView chip={{ tone: RISK_BAND[band.band].tone, word: RISK_BAND[band.band].word.toLowerCase(), count: band.count, large: true, zero: !band.count, className: 'audit-band-stat' }} /></div>
        ))}
      </div>
      <ol className="audit-risks" aria-label="Vulnerable packages by risk">
        {risk.rows.map((row, index) => (
          <li key={`${row.id}:${index}`} className="audit-risk-row" data-band={row.band} hidden={!all && row.hiddenUnlessAll}>
            <button type="button" className="audit-risk-btn" aria-label={row.name} onClick={() => reveal(row.id)}>
              <span className="audit-risk-score" data-band={row.band} style={{ '--risk': `${row.meter}%` }}><b>{String(row.score)}</b><span className="audit-risk-band">{row.bandWord}</span></span>
              <span className="audit-risk-main">
                <span className="audit-risk-pkg">
                  <span className="audit-risk-name">{row.pkg}</span><span className="audit-risk-ver">{row.version}</span>
                  {row.fixed ? <><Icon path={ICON.arrow} className="audit-ico audit-risk-arrow" /><span className="audit-risk-fix">{row.fixed}</span></> : null}
                </span>
                <span className="audit-risk-sub" title={row.subTitle ?? undefined}>{row.sub}</span>
                {row.places > 1 ? <span className="audit-risk-places">{`Declared in ${row.places} places; the finding below each one says where.`}</span> : null}
              </span>
              <span className="audit-risk-tags">{row.tags.map((chip, at) => <ChipView key={`${chip.word}:${at}`} chip={chip} />)}</span>
              <Icon path={ICON.arrow} className="audit-ico audit-risk-go" />
            </button>
          </li>
        ))}
      </ol>
      {!all ? <More dataKey="risk-more" total={risk.rows.length} fold={RISK_FOLD} onShow={showAll} /> : null}
      <p className="audit-coverage audit-risk-note">{risk.note}</p>
    </Foldable>
  );
}

/* ---- Families --------------------------------------------------------------------- */

export function FamiliesCard({ lede, families, handlers }: { readonly lede: string; readonly families: readonly Family[]; readonly handlers: AuditHandlers }): ReactElement {
  return (
    <Foldable className="audit-families" id="families" name="Families" labelledBy="auditFamiliesHeading" headClassName="audit-card-head audit-families-head"
      head={<Titles id="auditFamiliesHeading" title="Families" lede={<Lede said={lede} />} />}>
      <ul className="audit-categories" aria-label="Audit families">
        {families.map(family => (
          <li key={family.id} className="audit-category">
            <button type="button" className="audit-category-btn" data-key={`family:${family.id}`} aria-pressed={family.pressed ? 'true' : 'false'} data-status={family.status} data-family={family.id}
              onClick={() => {
                /* The narrowed list is where the answer appears: it opens if it was folded. */
                unfold('findings');
                handlers.onFilter?.(family.pressed ? null : family.id);
              }}>
              <span className="audit-category-top"><Icon path={FAMILY_ICON[family.id] ?? ICON.shield} className="audit-ico audit-category-ico" /><span className="audit-category-label">{family.label}</span></span>
              {family.graded
                ? <span className="audit-category-score">{family.score}<span className="audit-category-of">/100</span></span>
                : <span className="audit-category-score audit-category-ungraded">Not graded</span>}
              <span className="audit-category-counts">
                {family.status === 'clear'
                  ? <ChipView chip={{ tone: 'good', word: 'Clear', glyph: ICON.check, className: 'audit-category-ok' }} />
                  : family.counts.map(item => <ChipView key={item.severity} severity={item.severity} chip={{ tone: item.severity, word: item.severity, glyph: SEVERITY[item.severity].icon, count: item.count, className: 'audit-category-count' }} />)}
                {family.leads ? <span className="audit-category-leads">{`${family.leads} to confirm`}</span> : null}
              </span>
              {family.graded ? <span className="audit-category-meter" aria-hidden="true" style={{ '--audit-fill': family.fill }}></span> : null}
            </button>
          </li>
        ))}
      </ul>
    </Foldable>
  );
}

/* ---- Attack surface ------------------------------------------------------------------ */

export function SurfaceCard({ surface, handlers }: { readonly surface: Surface; readonly handlers: AuditHandlers }): ReactElement {
  const [shown, showAll] = useExpanded(`surface:${surface.id}`);
  const all = shown || surface.routes.length <= SURFACE_FOLD + 1;
  const counts = surface.counts;
  const stat = (chip: Parameters<typeof ChipView>[0]['chip']): ReactElement => <ChipView role="listitem" chip={chip} />;
  return (
    <Foldable className="card audit-surface" id="surface" name="Attack surface" labelledBy="auditSurfaceHeading" headClassName="audit-card-head"
      head={<Titles id="auditSurfaceHeading" title="Attack surface" lede={<Lede said="Every endpoint and server action a caller can reach, and what stands in front of it." />} />}>
      <div className="audit-surface-stats" role="list">
        {stat({ tone: 'neutral', word: counts.endpoints === 1 ? 'endpoint' : 'endpoints', glyph: ICON.route, count: counts.endpoints, large: true })}
        {counts.actions ? stat({ tone: 'neutral', word: counts.actions === 1 ? 'server action' : 'server actions', glyph: ICON.spark, count: counts.actions, large: true }) : null}
        {stat({ tone: 'neutral', word: 'signed in', glyph: ICON.lock, count: counts.guarded, large: true, zero: !counts.guarded })}
        {stat({ tone: 'warning', word: 'open', glyph: REACH.open.icon, count: counts.open, large: true, zero: !counts.open })}
        {counts.unknown ? stat({ tone: 'pending', word: 'guard to confirm', glyph: ICON.lock, count: counts.unknown, large: true }) : null}
        {stat({ tone: 'neutral', word: counts.mutating === 1 ? 'writes data' : 'write data', glyph: ICON.write, count: counts.mutating, large: true, zero: !counts.mutating })}
      </div>
      {surface.guards.length ? (
        <p className="audit-surface-guards">
          <Icon path={ICON.shield} /><span>Guarded across the app by </span>
          {surface.guards.map((guard, index) => (
            <GuardPart key={`${guard.path}:${index}`} guard={guard} handlers={handlers} />
          ))}
          {'.'}
        </p>
      ) : null}
      {surface.routes.length ? (
        <ul className="audit-routes" aria-label="Endpoints">
          {surface.routes.map((route, index) => (
            <li key={`${route.method}:${route.route}:${index}`} className="audit-route" hidden={!all && route.hiddenUnlessAll}>
              <span className="audit-route-method">{route.method}</span>
              <span className="audit-route-main">
                <span className="audit-route-path">{route.route}</span>
                <span className="audit-route-meta">
                  {route.framework ? <span className="audit-route-fw">{route.framework}</span> : null}
                  {route.path && handlers.onOpen
                    ? <button type="button" className="audit-inline-file" aria-label={`Open ${route.where}`} onClick={() => handlers.onOpen?.(route.raw)}>{route.where}</button>
                    : route.path ? <span className="audit-route-file">{route.where}</span> : null}
                </span>
              </span>
              <span className="audit-route-tags">
                <ChipView chip={{ tone: route.auth.tone, word: route.auth.word, glyph: route.auth.icon, beam: route.auth.beam }} />
                {route.writes ? <ChipView chip={{ tone: 'neutral', word: 'Writes', glyph: ICON.write }} /> : null}
                {route.admin ? <ChipView chip={{ tone: 'serious', word: 'Admin', glyph: ICON.shield }} /> : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {surface.routes.length && !all ? <More dataKey="surface-more" total={surface.routes.length} fold={SURFACE_FOLD} onShow={showAll} /> : null}
      {surface.routes.length && surface.truncated ? <p className="audit-coverage">{`The first ${surface.routes.length} are listed; the counts above include every one.`}</p> : null}
    </Foldable>
  );
}
function GuardPart({ guard, handlers }: { readonly guard: Surface['guards'][number]; readonly handlers: AuditHandlers }): ReactElement {
  return (
    <>
      {guard.before}
      {guard.path && handlers.onOpen
        ? <button type="button" className="audit-inline-file" aria-label={`Open ${guard.path}`} onClick={() => handlers.onOpen?.({ path: guard.path, line: null })}>{guard.path}</button>
        : <code>{guard.path || 'a shared guard'}</code>}
    </>
  );
}

/* ---- Licences ------------------------------------------------------------------ */

export function LicencesCard({ licences, reveal }: { readonly licences: Licences; readonly reveal: (id: string) => void }): ReactElement {
  const [shown, showAll] = useExpanded(`licences:${licences.id}`);
  const all = shown || licences.rows.length <= LICENCE_FOLD + 1;
  return (
    <Foldable className="card audit-licences" id="licences" name="Licences" labelledBy="auditLicencesHeading" headClassName="audit-card-head"
      head={<Titles id="auditLicencesHeading" title="Licences" lede={<Lede said={licences.lede} />} />}>
      <div className="audit-surface-stats audit-licence-stats" role="list">
        {licences.stats.map(stat => (
          <ChipView key={stat.family} role="listitem" family={stat.family}
            chip={{ tone: LICENCE_FAMILY[stat.family].tone, word: LICENCE_FAMILY[stat.family].word.toLowerCase(), count: stat.count, large: true, className: 'audit-licence-stat' }} />
        ))}
      </div>
      <dl className="audit-licence-basis">
        {licences.basis.map(fact => (
          <div key={fact.term} className="audit-licence-fact"><dt>{fact.term}</dt><dd>{fact.value}{fact.note ? <span className="audit-licence-note">{fact.note}</span> : null}</dd></div>
        ))}
      </dl>
      {licences.rows.length ? (
        <ul className="audit-licence-list" aria-label="Dependencies that are not permissively licensed">
          {licences.rows.map((row, index) => {
            const parts = (
              <>
                <span className="audit-licence-main">
                  <span className="audit-licence-pkg"><span className="audit-licence-name">{row.pkg}</span><span className="audit-licence-ver">{row.version}</span></span>
                  <span className="audit-licence-expr" title={row.licence || undefined}>{row.licence || 'No licence stated'}</span>
                </span>
                <span className="audit-licence-tags">
                  <ChipView chip={{ tone: row.familyTone, word: row.familyWord, className: 'audit-licence-family' }} />
                  {row.kind === 'development' ? <ChipView chip={{ tone: 'neutral', word: 'Development', title: 'Installed for development only; it does not ship' }} /> : null}
                  {row.kind === 'transitive' ? <ChipView chip={{ tone: 'neutral', word: 'Transitive', title: 'Came with another dependency' }} /> : null}
                </span>
              </>
            );
            const findingId = row.findingId;
            return (
              <li key={`${row.pkg}:${row.version}:${index}`} className="audit-licence-row" data-family={row.family} hidden={!all && row.hiddenUnlessAll}>
                {findingId !== null
                  ? <button type="button" className="audit-licence-btn" aria-label={row.name} onClick={() => reveal(findingId)}>{parts}<Icon path={ICON.arrow} className="audit-ico audit-licence-go" /></button>
                  : <div className="audit-licence-btn">{parts}</div>}
              </li>
            );
          })}
        </ul>
      ) : null}
      {licences.rows.length && !all ? <More dataKey="licences-more" total={licences.rows.length} fold={LICENCE_FOLD} onShow={showAll} /> : null}
      <p className="audit-coverage audit-licence-foot">{licences.foot}</p>
    </Foldable>
  );
}

/* ---- Coverage and what is already in place ---------------------------------------------- */

export function CoverageCards({ coverage, handlers }: { readonly coverage: Coverage; readonly handlers: AuditHandlers }): ReactElement {
  return (
    <>
      <Foldable className="card audit-ledger" id="coverage" name="Coverage" labelledBy="auditLedgerHeading" headClassName="audit-card-head"
        head={<Titles id="auditLedgerHeading" title="Coverage" lede={<Lede said="What this read looked at, and how closely. Nothing reported is not the same as clear." />} />}>
        <ul className="audit-ledger-list">
          {coverage.ledger.map((item, index) => (
            <li key={`${item.label}:${index}`} className="audit-ledger-item" data-status={item.status}>
              <span className="audit-ledger-mark" data-tone={item.tone}><Icon path={item.icon} /></span>
              <span className="audit-ledger-text">
                <span className="audit-ledger-top"><span className="audit-ledger-name">{item.label}</span><ChipView chip={{ tone: item.tone, word: item.word, className: 'audit-ledger-chip' }} /></span>
                <span className="audit-ledger-detail">{item.detail}</span>
                {item.found ? <span className="audit-ledger-found">{item.found}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      </Foldable>
      <Foldable className="card audit-controls" id="controls" name="Already in place" labelledBy="auditControlsHeading" headClassName="audit-card-head"
        head={<Titles id="auditControlsHeading" title="Already in place" lede={<Lede said="Defences the read recognised, each with where it was first seen." />} />}>
        {coverage.controls.length ? (
          <ul className="audit-controls-list">
            {coverage.controls.map((control, index) => (
              <li key={`${control.label}:${index}`} className="audit-control">
                <span className="audit-control-mark"><Icon path={ICON.check} /></span>
                <span className="audit-control-text">
                  <span className="audit-control-name">{control.label}</span>
                  {control.path && handlers.onOpen
                    ? <button type="button" className="audit-inline-file" aria-label={`Open ${control.path}`} onClick={() => handlers.onOpen?.({ path: control.path, line: null })}>{control.path}</button>
                    : <span className="audit-control-where">{control.path || 'Across the repository'}</span>}
                </span>
              </li>
            ))}
          </ul>
        ) : <p className="audit-controls-none">None recognised. The read knows the common libraries and settings by name, so a defence of your own may still be there.</p>}
      </Foldable>
    </>
  );
}

/* ---- The OWASP Top 10 ------------------------------------------------------------ */

export function StandardsCard({ said, tiles, handlers }: { readonly said: string; readonly tiles: readonly OwaspTile[]; readonly handlers: AuditHandlers }): ReactElement {
  return (
    <Foldable className="card audit-owasp" id="owasp" name="OWASP Top 10" labelledBy="auditOwaspHeading" headClassName="audit-owasp-head"
      head={<Titles id="auditOwaspHeading" title="OWASP Top 10 · 2025" className="audit-card-titles audit-owasp-titles" lede={<span className="audit-owasp-cwe">{said}</span>} />}>
      <ul className="audit-owasp-grid" aria-label="OWASP Top 10 categories">
        {tiles.map(tile => (
          <li key={tile.id} className="audit-owasp-item">
            <button type="button" className="audit-owasp-btn" data-key={`owasp:${tile.id}`} data-status={tile.status} aria-pressed={tile.pressed ? 'true' : 'false'} aria-label={tile.name} disabled={tile.disabled}
              onClick={() => { unfold('findings'); handlers.onOwasp?.(tile.pressed ? null : tile.id); }}>
              <span className="audit-owasp-id">{tile.id}</span><span className="audit-owasp-word">{tile.word}</span><span className="audit-owasp-n">{tile.count}</span>
            </button>
          </li>
        ))}
      </ul>
    </Foldable>
  );
}
