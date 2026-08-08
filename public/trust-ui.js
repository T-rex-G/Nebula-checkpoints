/* Ordered repository trust summary and accessible public-error presentation. */
'use strict';

(function trustUiModule(global) {
  const EVIDENCE_STATES = Object.freeze({
    'Provider-verified': Object.freeze({ icon: '◆', label: 'Provider-verified' }),
    Deterministic: Object.freeze({ icon: '■', label: 'Deterministic' }),
    Inferred: Object.freeze({ icon: '△', label: 'Inferred' }),
    Stale: Object.freeze({ icon: '◷', label: 'Stale' }),
    Unavailable: Object.freeze({ icon: '—', label: 'Unavailable' })
  });
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
    icon.textContent = descriptor.icon;
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
    summary.hidden = false;
    const status = document.getElementById('a11yStatus');
    if (status) status.textContent = safeValue(model.announcement, 'Repository trust summary updated.');
    return rendered;
  }

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
