/*
 * The rendered website audit, drawn: the same card as "Check a site" above
 * it -- a mark and a title, one field with its action beside it, the limits
 * said once, small, below -- and the report once a run finishes. The same
 * elements, classes and names as before it was a component (ADR-093). The
 * run itself is rendered-audit.ts's.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { FormEvent, ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import { createAudit, reportHtml } from './rendered-audit.ts';
import type { Api, Audit, ResultView } from './rendered-audit.ts';

export type Download = (filename: string, content: string, type: string) => void;

function Report({ view, report, download }: { view: ResultView; report: unknown; download: Download }): ReactElement {
  return (
    <>
      <p>{`Audited page: ${view.url}`}</p>
      <div className="rendered-actions">
        <button className="btn btn-ghost" type="button" onClick={() => download(`${view.filename}.html`, reportHtml(report), 'text/html')}>Export HTML report</button>
        <button className="btn btn-ghost" type="button" onClick={() => download(`${view.filename}.json`, JSON.stringify(report, null, 2), 'application/json')}>Export JSON evidence</button>
      </div>
      <h4>Coverage and scope</h4>
      <ul>{view.scope.map((reason, index) => <li key={index}>{reason}</li>)}</ul>
      <div className="rendered-grid">
        {view.viewports.map((viewport, index) => (
          <figure key={index} className="rendered-viewport">
            <figcaption>{`${viewport.name} · ${viewport.width} × ${viewport.height}`}</figcaption>
            {viewport.finalUrl ? <p>{`Final page: ${viewport.finalUrl}`}</p> : null}
            {viewport.image
              ? <img src={viewport.image} alt={`${viewport.name} viewport capture of the audited page`} loading="lazy" />
              : <p>Screenshot unavailable.</p>}
            <dl className="rendered-metrics">
              {viewport.metrics.map(([title, value]) => [<dt key={`${title}:t`}>{title}</dt>, <dd key={`${title}:d`}>{value}</dd>])}
            </dl>
          </figure>
        ))}
      </div>
      <h4>Actionable observations</h4>
      <ul className="rendered-findings">
        {view.findings.length
          ? view.findings.map((finding, index) => (
            <li key={index}>
              <strong>{finding.heading}</strong>
              <p>{finding.detail}</p>
              {finding.targets ? <code>{finding.targets}</code> : null}
            </li>
          ))
          : <li>No automated issues observed within this sample. The manual checks above remain necessary.</li>}
      </ul>
    </>
  );
}

function RenderedAudit({ audit, download }: { audit: Audit; download: Download }): ReactElement {
  const state = useSyncExternalStore(audit.subscribe, audit.state);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { void audit.readiness(); }, [audit]);
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void audit.start(input.current ? input.current.value : '');
  };
  return (
    <>
      <div className="audit-site-head">
        <span className="audit-site-mark">
          <svg className="ico" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
            <rect x="2.5" y="4" width="14" height="10.5" rx="1.6" />
            <path d="M6.5 18h6M9.5 14.5V18" />
            <rect x="16.5" y="9" width="5" height="10" rx="1.2" />
          </svg>
        </span>
        <div className="audit-site-titles">
          <h2 className="exposure-heading" id="renderedAuditHeading">Rendered experience</h2>
          <p className="audit-site-lede">Desktop and mobile evidence from one anonymous page in an isolated browser: accessibility, responsive layout, search metadata and timing.</p>
        </div>
      </div>
      <form className="audit-site-form" noValidate onSubmit={submit}>
        <label className="audit-site-label" htmlFor="renderedAuditUrl">Page address</label>
        <div className="audit-site-field">
          <input
            ref={input}
            className="audit-site-input"
            id="renderedAuditUrl"
            type="url"
            inputMode="url"
            spellCheck={false}
            placeholder="https://example.com/page"
            maxLength={2048}
            disabled={state.busy}
          />
          <button className="btn btn-primary" type="submit" disabled={state.busy || !state.available}>Run rendered audit</button>
        </div>
        <p className="audit-site-hint">Cross-origin resources are blocked, and nothing is clicked or submitted. Keyboard behaviour and visual design still need a person.</p>
      </form>
      <div className="rendered-actions">
        <p className="rendered-status" role="status">{state.status}</p>
        <button className="btn btn-ghost small" type="button" hidden={!state.busy} disabled={state.cancelDisabled} onClick={() => { void audit.cancel(); }}>Cancel audit</button>
        <button className="btn btn-ghost small" type="button" hidden={state.busy} onClick={() => { void audit.readiness(); }}>Check availability</button>
      </div>
      <div className="rendered-output">
        {state.view ? <Report view={state.view} report={state.report} download={download} /> : null}
      </div>
    </>
  );
}

const mounts = new WeakMap<HTMLElement, { root: Root; audit: Audit }>();

/* The panel drawn into its place on the site-check screen, once; a second call while it is there changes nothing. */
export function mount(host: HTMLElement | null, { api, download }: { api: Api; download: Download }): void {
  if (!host || mounts.has(host)) return;
  host.hidden = false;
  host.classList.add('card', 'audit-site');
  host.setAttribute('aria-labelledby', 'renderedAuditHeading');
  host.textContent = '';
  const audit = createAudit({ api });
  const root = createRoot(host);
  mounts.set(host, { root, audit });
  flushSync(() => root.render(<RenderedAudit audit={audit} download={download} />));
}

/* The panel taken away: a run it started is cancelled, and its place is left empty and hidden. */
export function dispose(host: HTMLElement | null): void {
  if (!host) return;
  const mounted = mounts.get(host);
  if (mounted) {
    mounts.delete(host);
    mounted.audit.dispose();
    flushSync(() => mounted.root.unmount());
  }
  host.replaceChildren();
  host.hidden = true;
}

const RenderedAuditPanel = Object.freeze({ mount, dispose, reportHtml });
export default RenderedAuditPanel;
