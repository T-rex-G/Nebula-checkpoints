/* Ordered repository trust summary and accessible public-error presentation. */
'use strict';

(function trustUiModule(global) {
  /*
   * The evidence marks, drawn rather than typed.
   *
   * These were geometric Unicode -- a diamond, a square, a triangle, a clock
   * face and an em dash -- which put five unrelated typographic shapes on a
   * surface where everything else is stroked SVG at 1.7, and left their weight
   * and alignment to whichever font happened to answer.
   *
   * They are drawn as one family now: five circles that differ only in what is
   * inside them -- a check for what the provider vouched for, an equals for
   * what was computed exactly, a wave for what was approximated, a clock for
   * what has aged, a bar for what is not there. Descending confidence, and a
   * reader compares the middles rather than five different outlines.
   *
   * Deliberately not a shield for Provider-verified, which is where this
   * landed first: the rail already spends a shield on Governance, and one
   * drawing meaning both "policy" and "attested evidence" is worse than no
   * icon. A shield is protection; this is attestation.
   */
  const EVIDENCE_STATES = Object.freeze({
    'Provider-verified': Object.freeze({
      label: 'Provider-verified',
      paths: Object.freeze(['M12 4.2a7.8 7.8 0 1 1 0 15.6 7.8 7.8 0 0 1 0-15.6z', 'M8.7 12.1l2.2 2.3 4.4-4.7'])
    }),
    Deterministic: Object.freeze({
      label: 'Deterministic',
      paths: Object.freeze(['M12 4.2a7.8 7.8 0 1 1 0 15.6 7.8 7.8 0 0 1 0-15.6z', 'M8.7 10.6h6.6M8.7 13.6h6.6'])
    }),
    Inferred: Object.freeze({
      label: 'Inferred',
      paths: Object.freeze(['M12 4.2a7.8 7.8 0 1 1 0 15.6 7.8 7.8 0 0 1 0-15.6z', 'M8.6 13.1c1.1-1.9 2.2-1.9 3.4 0s2.3 1.9 3.4 0'])
    }),
    Stale: Object.freeze({
      label: 'Stale',
      paths: Object.freeze(['M12 4.2a7.8 7.8 0 1 1 0 15.6 7.8 7.8 0 0 1 0-15.6z', 'M12 7.6V12l3 1.8'])
    }),
    Unavailable: Object.freeze({
      label: 'Unavailable',
      paths: Object.freeze(['M12 4.2a7.8 7.8 0 1 1 0 15.6 7.8 7.8 0 0 1 0-15.6z', 'M8.4 12h7.2'])
    })
  });

  const SVG_NS = 'http://www.w3.org/2000/svg';

  /*
   * Built through the DOM rather than markup: this module is held to rendering
   * every trust value through textContent, and reaching for innerHTML here
   * would open the one door that rule exists to keep shut.
   */
  function drawEvidenceMark(paths) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'trust-evidence-mark');
    for (const definition of paths) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', definition);
      svg.appendChild(path);
    }
    return svg;
  }
  const SUMMARY_FIELDS = Object.freeze([
    Object.freeze({ key: 'connection', id: 'trustConnection', label: 'Connection freshness' }),
    Object.freeze({ key: 'pipeline', id: 'trustPipeline', label: 'Application and evidence health' }),
    Object.freeze({ key: 'risk', id: 'trustRisk', label: 'Risk or governance issue' }),
    Object.freeze({ key: 'action', id: 'trustAction', label: 'Recommended next action' }),
    Object.freeze({ key: 'evidence', id: 'trustEvidence', label: 'Supporting evidence' })
  ]);
  let activeErrorKeydown = null;

  function safeValue(value, fallback, maximum = 600) {
    const text = String(value == null || value === '' ? fallback : value)
      .replace(/(?:postgres(?:ql)?:\/\/|gh[pousr]_|github_pat_)[^\s]+/gi, '[redacted]')
      .replace(/\b(token|password|secret)\s*[=:]\s*[^\s,;]+/gi, '$1=[redacted]');
    return text.slice(0, maximum);
  }

  function evidenceName(state) {
    return Object.hasOwn(EVIDENCE_STATES, state) ? state : 'Unavailable';
  }

  function renderEvidenceState(state) {
    const name = evidenceName(state);
    const descriptor = EVIDENCE_STATES[name];
    const badge = document.createElement('span');
    badge.className = `trust-evidence trust-evidence-${name.toLowerCase()}`;
    badge.dataset.evidenceState = name;
    const icon = document.createElement('span');
    icon.className = 'trust-evidence-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.appendChild(drawEvidenceMark(descriptor.paths));
    const label = document.createElement('span');
    label.textContent = descriptor.label;
    badge.append(icon, label);
    return badge;
  }

  function renderSummary(model = {}) {
    const summary = document.getElementById('trustSummary');
    if (!summary) return [];
    const rendered = [];
    for (const field of SUMMARY_FIELDS) {
      const host = document.getElementById(field.id);
      if (!host) continue;
      const value = model[field.key] || {};
      const heading = document.createElement('h3');
      heading.textContent = field.label;
      const detail = document.createElement('p');
      detail.textContent = safeValue(value.text, 'No verified result is available.');
      host.replaceChildren(heading, detail, renderEvidenceState(value.evidenceState));
      host.dataset.trustState = evidenceName(value.evidenceState);
      rendered.push(host);
    }
    renderRollup(rendered);
    summary.hidden = false;
    const status = document.getElementById('a11yStatus');
    if (status) status.textContent = safeValue(model.announcement, 'Repository trust summary updated.');
    return rendered;
  }

  /*
   * The one-line standing of the five fields, for the phone layout where the
   * detail is collapsed behind a disclosure.
   *
   * This counts states rather than summarising the prose: the prose is the
   * part that moves out of view, and inventing a sentence to stand in for it
   * would be asserting something the model never said. Counts are only what is
   * already on the cards.
   */
  const ROLLUP_ORDER = Object.freeze(['Unavailable', 'Stale', 'Inferred', 'Deterministic', 'Provider-verified']);

  function renderRollup(hosts) {
    const states = document.getElementById('trustRollupStates');
    if (!states) return;
    const counts = new Map();
    for (const host of hosts) {
      const name = host.dataset.trustState;
      counts.set(name, (counts.get(name) || 0) + 1);
    }
    const parts = ROLLUP_ORDER
      .filter(name => counts.has(name))
      .map(name => `${counts.get(name)} ${name.toLowerCase()}`);
    states.textContent = parts.length ? parts.join(' · ') : 'Not measured';
    /* Named for the weakest state present, which is the one worth a colour. */
    const worst = ROLLUP_ORDER.find(name => counts.has(name)) || 'Unavailable';
    const summary = document.getElementById('trustSummary');
    if (summary) summary.dataset.trustWorst = worst;
  }

  function bindRollup() {
    const button = document.getElementById('trustRollup');
    const summary = document.getElementById('trustSummary');
    if (!button || !summary) return;
    button.addEventListener('click', () => {
      const open = summary.dataset.open !== 'true';
      summary.dataset.open = open ? 'true' : 'false';
      button.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindRollup, { once: true });
  } else bindRollup();

  function addErrorField(parent, labelText, value) {
    const group = document.createElement('div');
    group.className = 'trust-error-field';
    const label = document.createElement('h3');
    label.textContent = labelText;
    const content = document.createElement('p');
    content.textContent = value;
    group.append(label, content);
    parent.appendChild(group);
    return content;
  }

  function providerChangeText(value) {
    if (value === true || value === 'yes') return 'yes';
    if (value === false || value === 'no') return 'no';
    return 'unknown';
  }

  function presentError(error = {}) {
    if (activeErrorKeydown) document.removeEventListener('keydown', activeErrorKeydown);
    const previous = document.getElementById('trustErrorBackdrop');
    if (previous) previous.remove();
    const returnFocus = document.activeElement;
    const backdrop = document.createElement('div');
    backdrop.id = 'trustErrorBackdrop';
    backdrop.className = 'trust-error-backdrop';
    const dialog = document.createElement('section');
    dialog.className = 'trust-error-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'trustErrorTitle');
    const title = document.createElement('h2');
    title.id = 'trustErrorTitle';
    title.textContent = 'The action was not completed';
    dialog.appendChild(title);
    addErrorField(dialog, 'What happened', safeValue(error.message, 'The request could not be completed.'));
    addErrorField(dialog, 'Provider/repository changed', providerChangeText(error.providerChanged));
    addErrorField(dialog, 'Safe state now', safeValue(error.safeState, 'No verified change was applied.'));
    addErrorField(dialog, 'Next action', safeValue(error.nextAction, 'Retry, or share the correlation ID with support.'));

    const correlationId = safeValue(error.correlationId, 'Unavailable', 160);
    const correlation = document.createElement('div');
    correlation.className = 'trust-error-field';
    const correlationHeading = document.createElement('h3');
    correlationHeading.textContent = 'Correlation ID';
    const correlationRow = document.createElement('div');
    correlationRow.className = 'trust-correlation-row';
    const correlationValue = document.createElement('code');
    correlationValue.textContent = correlationId;
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'btn btn-ghost small';
    copy.textContent = 'Copy';
    copy.disabled = correlationId === 'Unavailable';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(correlationId);
        copy.textContent = 'Copied';
      } catch {
        copy.textContent = 'Copy unavailable';
      }
    });
    correlationRow.append(correlationValue, copy);
    correlation.append(correlationHeading, correlationRow);
    dialog.appendChild(correlation);

    const details = document.createElement('details');
    const detailsSummary = document.createElement('summary');
    detailsSummary.textContent = 'Internal error code';
    const code = document.createElement('code');
    code.textContent = safeValue(error.code, 'UNSPECIFIED', 120);
    details.append(detailsSummary, code);
    dialog.appendChild(details);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'btn btn-primary trust-error-close';
    close.textContent = 'Close';
    const dismiss = () => {
      backdrop.remove();
      document.removeEventListener('keydown', onKeydown);
      activeErrorKeydown = null;
      if (returnFocus && returnFocus.isConnected && typeof returnFocus.focus === 'function') returnFocus.focus();
    };
    const onKeydown = event => {
      if (event.key === 'Escape') return dismiss();
      if (event.key !== 'Tab') return;
      const focusable = Array.from(dialog.querySelectorAll('button:not([disabled]), summary, [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'))
        .filter(element => !element.hidden && element.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    activeErrorKeydown = onKeydown;
    close.addEventListener('click', dismiss);
    backdrop.addEventListener('click', event => { if (event.target === backdrop) dismiss(); });
    document.addEventListener('keydown', onKeydown);
    dialog.appendChild(close);
    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);
    close.focus();
    return dialog;
  }

  global.NebulaTrustUI = Object.freeze({ renderEvidenceState, renderSummary, presentError });
})(window);
