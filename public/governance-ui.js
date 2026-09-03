/* Nebulaverse-X Policy Digital Twin interface renderer. */
(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NebulaGovernanceUI = api;
})(typeof window !== 'undefined' ? window : globalThis, function createGovernanceUi() {
  'use strict';

  const CAPABILITIES = Object.freeze(['read', 'author', 'review', 'activate', 'administer']);

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[ch]);
  }
  function escapeAttr(value) { return escapeHtml(value); }
  function asArray(value) { return Array.isArray(value) ? value : []; }
  function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
  function count(value) { const n = Number(value); return Number.isSafeInteger(n) && n >= 0 ? n : 0; }
  function hashShort(value) { const text = String(value || ''); return /^[0-9a-f]{64}$/i.test(text) ? `${text.slice(0, 8)}…${text.slice(-6)}` : 'not recorded'; }
  function formatTime(value) {
    const d = new Date(value || 0);
    if (!Number.isFinite(d.getTime())) return 'Unknown time';
    return d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  }
  function human(value) {
    return String(value || '').replace(/[-_.]+/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase());
  }
  function tone(value) {
    const v = String(value || '').toLowerCase();
    if (['approved', 'allow', 'current', 'valid', 'observe'].includes(v)) return 'ok';
    if (['pending', 'warn', 'partial', 'require-approval'].includes(v)) return 'warn';
    if (['rejected', 'deny', 'block', 'invalid', 'stale', 'unavailable', 'revoked', 'expired', 'superseded'].includes(v)) return 'danger';
    return 'neutral';
  }
  function badge(value, label) {
    const text = label || human(value);
    return `<span class="gov-badge ${tone(value)}"><span aria-hidden="true" class="gov-badge-dot"></span>${escapeHtml(text)}</span>`;
  }
  function normalizeInterfaceAccess(value, now = Date.now()) {
    const input = asObject(value);
    const raw = asObject(input.capabilities);
    const capabilities = {};
    for (const name of CAPABILITIES) capabilities[name] = raw[name] === true;
    const evidenceInput = asObject(input.evidence);
    const expiresAtMs = new Date(evidenceInput.expiresAt || 0).getTime();
    const nowMs = Number(now);
    const evidenceStatus = evidenceInput.status === 'current' && Number.isFinite(expiresAtMs) && Number.isFinite(nowMs) && expiresAtMs > nowMs
      ? 'current'
      : (evidenceInput.status === 'unavailable' ? 'unavailable' : 'stale');
    if (evidenceStatus !== 'current') {
      for (const name of CAPABILITIES) capabilities[name] = false;
    }
    return Object.freeze({
      actor: Object.freeze({ login: String(asObject(input.actor).login || '') }),
      execution: Object.freeze({
        kind: ['user', 'installation'].includes(asObject(input.execution).kind) ? input.execution.kind : 'user',
        authMethod: String(asObject(input.execution).authMethod || '')
      }),
      capabilities: Object.freeze(capabilities),
      evidence: Object.freeze({
        status: evidenceStatus,
        expiresAt: String(evidenceInput.expiresAt || '')
      })
    });
  }
  function parseJsonObject(text, label = 'Value') {
    const source = String(text == null ? '' : text).trim();
    if (!source) throw new Error(`${label} must be a JSON object`);
    if (source.length > 64 * 1024) throw new Error(`${label} is too large`);
    let value;
    try { value = JSON.parse(source); }
    catch { throw new Error(`${label} must contain valid JSON`); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
    return value;
  }
  function defaultSimulationRequest(defaultBranch = 'main') {
    const branch = String(defaultBranch || 'main').slice(0, 200) || 'main';
    return {
      schemaVersion: 1,
      scenarios: [
        { id: 'write-file', action: 'file.write', attributes: { branch, paths: ['README.md'] } },
        { id: 'reset-protected-branch', action: 'branch.reset', attributes: { branch, protected: true } },
        { id: 'merge-pull-request', action: 'pull.merge', attributes: { branch } },
        { id: 'create-release', action: 'release.create', attributes: { branch } }
      ]
    };
  }
  function actionButton(action, label, ids = {}, kind = 'ghost', disabled = false, title = '') {
    const attrs = Object.entries(ids).map(([key, value]) => ` data-${escapeAttr(key)}="${escapeAttr(value)}"`).join('');
    return `<button type="button" class="btn btn-${escapeAttr(kind)} small" data-gov-action="${escapeAttr(action)}"${attrs}${disabled ? ' disabled' : ''}${title ? ` title="${escapeAttr(title)}"` : ''}>${escapeHtml(label)}</button>`;
  }
  function reviewSummary(review) {
    const r = asObject(review);
    return `${count(r.approvalCount)}/${count(r.requiredApprovals)} approvals · ${count(r.assignedCount)} assigned`;
  }
  function renderLoading() {
    return `<section class="gov-shell" aria-busy="true" aria-label="Loading Policy Digital Twin">
      <div class="gov-skeleton gov-skeleton-title"></div>
      <div class="gov-summary-grid">${Array.from({ length: 4 }, () => '<div class="card gov-skeleton gov-skeleton-card"></div>').join('')}</div>
      <div class="card gov-skeleton gov-skeleton-panel"></div>
    </section>`;
  }
  function renderError(message) {
    return `<section class="gov-shell gov-state" role="alert">
      <div class="gov-state-orb danger" aria-hidden="true"><svg class="gov-orb-mark" viewBox="0 0 24 24"><path d="M12 4.2a7.8 7.8 0 1 1 0 15.6 7.8 7.8 0 0 1 0-15.6z"/><path d="M12 8.2v4.6"/><path d="M12 15.6v.2"/></svg></div>
      <h2>Governance evidence unavailable</h2>
      <p>${escapeHtml(message || 'The Policy Digital Twin could not be loaded.')}</p>
      <button type="button" class="btn btn-primary small" data-gov-action="refresh">Retry</button>
    </section>`;
  }
  function renderEmpty(access) {
    return `<section class="card gov-empty">
      <div class="gov-state-orb" aria-hidden="true"><svg class="gov-orb-mark" viewBox="0 0 24 24"><path d="M12 3.2l7.4 3.1v5.4c0 4.4-3.1 8-7.4 9.6-4.3-1.6-7.4-5.2-7.4-9.6V6.3z"/><path d="M12 9v3.4"/><path d="M12 15.4v.2"/></svg></div>
      <h3>No governance policy yet</h3>
      <p>Create a policy from a repository baseline or start with an empty policy. Nothing is activated automatically.</p>
      ${access.capabilities.author ? `<div class="gov-actions">${actionButton('create-policy', 'Create policy', {}, 'primary')}${actionButton('generate-baseline', 'Generate baseline')}</div>` : '<p class="hint">Repository write access is required to create governance policy drafts.</p>'}
    </section>`;
  }
  function renderSummary(twin) {
    const current = asObject(twin.current);
    const proposed = asObject(twin.proposed);
    const effective = asObject(twin.effective);
    const history = asObject(twin.history);
    const items = [
      ['Active policies', count(current.activePolicyCount), `${count(current.policyCount)} total`],
      ['Proposed versions', count(proposed.versionCount), `${count(proposed.draftCount)} drafts`],
      ['Active exceptions', count(effective.activeExceptionCount), 'actor + target bound'],
      ['Recent decisions', asArray(history.decisions).length, history.nextDecisionSeq == null ? 'latest page' : 'more available']
    ];
    return `<div class="gov-summary-grid" aria-label="Governance summary">${items.map(([label, value, sub]) => `
      <article class="card gov-metric"><span>${escapeHtml(label)}</span><strong>${value}</strong><small>${escapeHtml(sub)}</small></article>`).join('')}</div>`;
  }
  function renderPolicies(twin, access) {
    const policies = asArray(asObject(twin.current).policies);
    if (!policies.length) return renderEmpty(access);
    return `<section class="gov-section" aria-labelledby="govPoliciesTitle">
      <div class="gov-section-head"><div><h3 id="govPoliciesTitle">Current policy state</h3><p>Active heads and latest immutable versions.</p></div>${access.capabilities.author ? `<div class="gov-actions">${actionButton('create-policy', 'Create policy', {}, 'primary')}${actionButton('generate-baseline', 'Generate baseline')}</div>` : ''}</div>
      <div class="gov-card-grid">${policies.map(policy => {
        const active = asObject(policy.active);
        const latest = asObject(policy.latestVersion);
        return `<article class="card gov-policy-card">
          <div class="gov-policy-head"><div><span class="mono gov-kicker">${escapeHtml(policy.policyKey)}</span><h4>${escapeHtml(policy.name || policy.policyKey || 'Unnamed policy')}</h4></div>${active.versionId ? badge(active.enforcementMode || 'observe') : badge('neutral', 'Not active')}</div>
          <p>${escapeHtml(policy.description || 'No description')}</p>
          <dl class="gov-facts"><div><dt>Revision</dt><dd>${count(policy.revision)}</dd></div><div><dt>Versions</dt><dd>${count(policy.versionCount)}</dd></div><div><dt>Active</dt><dd>${active.versionId ? `v${count(active.versionNumber)}` : 'None'}</dd></div><div><dt>Latest review</dt><dd>${latest.review ? escapeHtml(human(latest.review.status)) : 'No version'}</dd></div></dl>
          <div class="gov-hash mono" title="Active document hash">${escapeHtml(hashShort(active.documentHash))}</div>
          <div class="gov-actions">${actionButton('select-policy', 'Inspect', { 'policy-id': policy.policyId })}${access.capabilities.author ? actionButton('new-draft', 'New draft', { 'policy-id': policy.policyId }) : ''}${active.versionId && access.capabilities.author ? actionButton('request-exception', 'Request exception', { 'policy-id': policy.policyId, 'version-id': active.versionId }) : ''}</div>
        </article>`;
      }).join('')}</div>
    </section>`;
  }
  function renderDrafts(twin, access) {
    const drafts = asArray(asObject(twin.proposed).drafts);
    if (!drafts.length) return '';
    return `<section class="gov-section" aria-labelledby="govDraftsTitle"><div class="gov-section-head"><div><h3 id="govDraftsTitle">Active drafts</h3><p>Mutable author-owned work. Submission creates an immutable version.</p></div></div><div class="gov-list">${drafts.map(draft => `
      <article class="card gov-row"><div class="gov-row-main"><strong>Draft r${count(draft.revision)}</strong><span>Policy ${escapeHtml(String(draft.policyId || '').slice(0, 8))} · ${escapeHtml(draft.authoredByLogin)}</span><small>Updated ${escapeHtml(formatTime(draft.updatedAt))}</small></div><div class="gov-actions">${access.capabilities.author ? actionButton('edit-draft', 'Edit', { 'policy-id': draft.policyId, 'draft-id': draft.draftId }) + actionButton('validate-draft', 'Validate', { 'policy-id': draft.policyId, 'draft-id': draft.draftId }) + actionButton('submit-draft', 'Submit', { 'policy-id': draft.policyId, 'draft-id': draft.draftId, revision: draft.revision }, 'primary') : ''}</div></article>`).join('')}</div></section>`;
  }
  function renderProposed(twin, access, simulation) {
    const versions = asArray(asObject(twin.proposed).versions);
    if (!versions.length) return '';
    const sim = asObject(simulation);
    return `<section class="gov-section" aria-labelledby="govProposedTitle"><div class="gov-section-head"><div><h3 id="govProposedTitle">Proposed immutable versions</h3><p>Review, simulate and activate against the current policy head.</p></div></div><div class="gov-list">${versions.map(version => {
      const review = asObject(version.review);
      const simMatches = sim.policyId === version.policyId && sim.versionId === version.versionId;
      const eligible = simMatches && asObject(sim.report).activationReadiness && asObject(sim.report).activationReadiness.eligible === true;
      const ids = { 'policy-id': version.policyId, 'version-id': version.versionId };
      return `<article class="card gov-version-row"><div class="gov-row-main"><div class="gov-row-title"><strong>${escapeHtml(version.policyKey)} v${count(version.versionNumber)}</strong>${badge(review.status || 'pending')}</div><span>${escapeHtml(reviewSummary(review))}</span><small>${escapeHtml(formatTime(version.createdAt))} · ${escapeHtml(hashShort(version.documentHash))}</small>${simMatches ? `<div class="gov-inline-result">${badge(eligible ? 'approved' : 'warn', eligible ? 'Simulation eligible' : 'Simulation blocked')}<span>${escapeHtml(hashShort(asObject(sim.report).simulationHash))}</span></div>` : ''}</div><div class="gov-actions">${actionButton('view-version', 'View JSON', ids)}${actionButton('simulate', 'Simulate', ids, simMatches ? 'ghost' : 'primary')}${access.capabilities.review && review.status === 'pending' ? actionButton('claim-review', 'Claim review', ids) + actionButton('approve', 'Approve', ids) + actionButton('reject', 'Reject', ids, 'ghost') : ''}${access.capabilities.activate ? actionButton('activate', 'Activate', ids, 'primary', !eligible, eligible ? '' : 'Run an eligible fresh simulation first') : ''}</div></article>`;
    }).join('')}</div></section>`;
  }
  function renderExceptions(twin, access) {
    const items = asArray(asObject(twin.history).exceptions);
    if (!items.length) return '';
    return `<section class="gov-section" aria-labelledby="govExceptionsTitle"><div class="gov-section-head"><div><h3 id="govExceptionsTitle">Exceptions and waivers</h3><p>Time-bounded actor- and target-specific policy relief.</p></div></div><div class="gov-list">${items.map(item => {
      const ids = { 'exception-id': item.exceptionId, 'policy-id': item.policyId, 'version-id': item.versionId };
      return `<article class="card gov-row"><div class="gov-row-main"><div class="gov-row-title"><strong>${escapeHtml(human(item.kind))} · ${escapeHtml(item.action)}</strong>${badge(item.state)}</div><span>Expires ${escapeHtml(formatTime(item.expiresAt))}</span><small>Requested ${escapeHtml(formatTime(item.createdAt))}</small></div><div class="gov-actions">${actionButton('view-exception', 'Inspect', ids)}${access.capabilities.administer && item.state === 'pending' ? actionButton('decide-exception', 'Decide', ids, 'primary') : ''}${access.capabilities.administer && item.state === 'approved' ? actionButton('revoke-exception', 'Revoke', ids, 'ghost') : ''}</div></article>`;
    }).join('')}</div></section>`;
  }
  function renderHistory(twin, access, verification) {
    const history = asObject(twin.history);
    const activations = asArray(history.activations);
    const decisions = asArray(history.decisions);
    const verify = asObject(verification);
    return `<section class="gov-section" aria-labelledby="govHistoryTitle"><div class="gov-section-head"><div><h3 id="govHistoryTitle">Evidence history</h3><p>Activation and runtime decision references from the immutable ledger.</p></div><div class="gov-actions">${actionButton('verify-chain', verify.valid === true && verify.complete === true ? 'Chain verified' : 'Verify chain')}${history.nextDecisionSeq != null ? actionButton('load-more-decisions', 'Load more', { 'after-seq': history.nextDecisionSeq }) : ''}</div></div>${verify.valid != null ? `<div class="gov-banner ${verify.valid ? 'ok' : 'danger'}" role="status">${verify.valid ? (verify.complete === true ? 'Decision chain verified' : 'Decision chain valid through the configured verification limit') : 'Decision chain verification failed'}${verify.checked != null ? ` · ${count(verify.checked)} records checked` : ''}</div>` : ''}
      <div class="gov-history-grid"><div class="card"><h4>Activations</h4>${activations.length ? `<ol class="gov-timeline">${activations.map(item => `<li><span class="gov-time">${escapeHtml(formatTime(item.createdAt))}</span><strong>${escapeHtml(human(item.action))}</strong><small>${escapeHtml(item.actorLogin)} · ${escapeHtml(String(item.versionId || '').slice(0, 8))}</small>${access.capabilities.activate ? actionButton('rollback', 'Rollback to version', { 'policy-id': item.policyId, 'version-id': item.versionId }) : ''}</li>`).join('')}</ol>` : '<p class="gov-muted">No activation history.</p>'}</div>
      <div class="card"><h4>Runtime decisions</h4>${decisions.length ? `<ol class="gov-timeline">${decisions.map(item => `<li><span class="gov-time">${escapeHtml(formatTime(item.evaluatedAt))}</span><strong>${escapeHtml(item.action)}</strong><small>${escapeHtml(human(item.enforcementOutcome))} · ${escapeHtml(human(item.effectiveEffect))} · ${escapeHtml(hashShort(item.decisionHash))}</small></li>`).join('')}</ol>` : '<p class="gov-muted">No runtime decisions.</p>'}</div></div>
    </section>`;
  }
  function renderDelivery(deliveryInput, access) {
    const delivery = asObject(deliveryInput);
    const preferences = asObject(delivery.preferences);
    const notifications = asArray(asObject(delivery.notifications).events);
    const exportsList = asArray(delivery.exports);
    const webhooks = asArray(delivery.webhooks);
    const unread = notifications.filter(item => Number(item.seq) > count(preferences.lastReadSeq)).length;
    return `<section class="gov-section" aria-labelledby="govDeliveryTitle">
      <div class="gov-section-head"><div><h3 id="govDeliveryTitle">Notifications and signed evidence</h3><p>Live-only governance events, bounded exports and administrator-managed webhooks.</p></div><div class="gov-actions">${actionButton('delivery-refresh', 'Refresh delivery')}${actionButton('create-export', 'Create signed export', {}, 'primary')}</div></div>
      ${delivery.error ? `<div class="gov-banner warn" role="status"><strong>Delivery evidence partially unavailable</strong><span>${escapeHtml(delivery.error)}</span></div>` : ''}
      <div class="gov-history-grid">
        <article class="card"><div class="gov-row-title"><h4>Notifications</h4>${badge(unread ? 'warn' : 'current', `${unread} unread`)}</div><p class="gov-muted">${preferences.enabled === false ? 'Notifications are disabled for this identity.' : 'Notifications are enabled for selected governance events.'}</p><div class="gov-actions">${actionButton('edit-notification-preferences', 'Preferences')}${notifications.length ? actionButton('mark-notifications-read', 'Mark shown as read', { 'through-seq': Math.max(...notifications.map(item => count(item.seq))) }) : ''}</div>${notifications.length ? `<ol class="gov-timeline">${notifications.slice(0, 12).map(item => `<li><span class="gov-time">${escapeHtml(formatTime(item.createdAt))}</span><strong>${escapeHtml(human(item.eventType))}</strong><small>Event ${count(item.seq)} · ${escapeHtml(hashShort(item.eventHash))}</small></li>`).join('')}</ol>` : '<p class="gov-muted">No governance notifications.</p>'}</article>
        <article class="card"><div class="gov-row-title"><h4>Signed audit exports</h4>${badge(exportsList.length ? 'current' : 'neutral', `${exportsList.length} recorded`)}</div><p class="gov-muted">Bounded JSON or CSV evidence envelopes. External storage is not part of this checkpoint.</p>${exportsList.length ? `<ol class="gov-timeline">${exportsList.slice(0, 10).map(item => `<li><span class="gov-time">${escapeHtml(formatTime(item.createdAt))}</span><strong>${escapeHtml(String(item.format || 'json').toUpperCase())} · ${count(item.eventCount)} events</strong><small>${escapeHtml(hashShort(item.envelopeHash || item.exportHash))}</small><div class="gov-actions">${actionButton('download-export', 'Download', { 'export-id': item.exportId })}${actionButton('verify-export', 'Verify', { 'export-id': item.exportId })}</div></li>`).join('')}</ol>` : '<p class="gov-muted">No signed exports have been created.</p>'}</article>
      </div>
      ${access.capabilities.administer ? `<article class="card gov-webhooks"><div class="gov-section-head"><div><h4>Administrative webhooks</h4><p>HTTPS-only, DNS-revalidated, signed delivery endpoints.</p></div>${actionButton('create-webhook', 'Add webhook', {}, 'primary')}</div>${webhooks.length ? `<div class="gov-list">${webhooks.map(item => `<div class="gov-row"><div class="gov-row-main"><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.url)}</span><small>${item.enabled === false ? 'Disabled' : 'Enabled'} · ${escapeHtml((item.eventTypes || []).join(', '))}</small></div><div class="gov-actions">${actionButton('rotate-webhook', 'Rotate secret', { 'webhook-id': item.webhookId })}${actionButton('delete-webhook', 'Delete', { 'webhook-id': item.webhookId }, 'ghost')}</div></div>`).join('')}</div>` : '<p class="gov-muted">No webhooks configured.</p>'}</article>` : ''}
    </section>`;
  }

  function renderGovernanceInterface(input = {}) {
    if (input.loading) return renderLoading();
    if (input.error) return renderError(input.error);
    const twin = asObject(input.digitalTwin);
    if (!twin.schemaVersion) return renderError('The Policy Digital Twin response is unavailable or invalid.');
    const access = normalizeInterfaceAccess(input.access, input.now == null ? Date.now() : input.now);
    const freshness = asObject(twin.freshness);
    const incomplete = Object.entries(asObject(freshness.completeness)).filter(([, complete]) => complete !== true).map(([name]) => human(name));
    const scope = asObject(twin.scope);
    const noPolicies = count(asObject(twin.current).policyCount) === 0;
    return `<section class="gov-shell" aria-busy="false">
      <header class="gov-hero"><div><span class="gov-eyebrow">Repository governance</span><h2>Policy Digital Twin</h2><p><span class="mono">${escapeHtml(scope.owner)}/${escapeHtml(scope.repo)}</span> · snapshot ${escapeHtml(formatTime(freshness.asOf))}</p></div><div class="gov-hero-actions">${badge(freshness.status || 'partial')}${access.evidence.status !== 'current' ? badge(access.evidence.status) : ''}${actionButton('refresh', 'Refresh', {}, 'ghost')}</div></header>
      ${freshness.status !== 'current' ? `<div class="gov-banner warn" role="status"><strong>Partial evidence</strong><span>${incomplete.length ? `Incomplete: ${escapeHtml(incomplete.join(', '))}.` : 'One or more evidence sections are incomplete.'} Decisions remain server-authoritative.</span></div>` : ''}
      ${access.evidence.status !== 'current' ? `<div class="gov-banner danger" role="alert"><strong>Authorization evidence ${escapeHtml(access.evidence.status)}</strong><span>Governance actions are disabled until repository permissions are refreshed.</span></div>` : ''}
      <div class="gov-access-line"><span>Signed in as <b>${escapeHtml(access.actor.login || 'unknown')}</b></span><span>${escapeHtml(access.execution.kind === 'installation' ? 'GitHub App execution · human governance actor' : human(access.execution.authMethod || 'user session'))}</span></div>
      ${renderSummary(twin)}
      ${noPolicies ? renderEmpty(access) : renderPolicies(twin, access)}
      ${renderDrafts(twin, access)}
      ${renderProposed(twin, access, input.simulation)}
      ${renderExceptions(twin, access)}
      ${renderHistory(twin, access, input.verification)}
      ${renderDelivery(input.delivery, access)}
      <footer class="gov-foot"><span>Read-model hash</span><code>${escapeHtml(hashShort(twin.readModelHash))}</code></footer>
    </section>`;
  }

  return Object.freeze({
    escapeHtml,
    normalizeInterfaceAccess,
    parseJsonObject,
    defaultSimulationRequest,
    renderGovernanceInterface
  });
});
