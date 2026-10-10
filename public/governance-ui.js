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
        { id: 'merge-pull-request', action: 'pull.merge', attributes: { branch, audit: { state: 'current', blocking: [] } } },
        /* The audit gate's two answers, so a policy that acts on them is exercised before it can be activated. */
        { id: 'merge-failing-audit', action: 'pull.merge', attributes: { branch, audit: { state: 'current', blocking: ['critical', 'overdue'] } } },
        { id: 'merge-unaudited-head', action: 'pull.merge', attributes: { branch, audit: { state: 'missing', blocking: [] } } },
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
  function renderEmpty(access, archivedCount = 0) {
    return `<section class="card gov-empty">
      <div class="gov-state-orb" aria-hidden="true"><svg class="gov-orb-mark" viewBox="0 0 24 24"><path d="M12 3.2l7.4 3.1v5.4c0 4.4-3.1 8-7.4 9.6-4.3-1.6-7.4-5.2-7.4-9.6V6.3z"/><path d="M12 9v3.4"/><path d="M12 15.4v.2"/></svg></div>
      <h3>No governance policy yet</h3>
      <p>Create a policy from a repository baseline or start with an empty policy. Nothing is activated automatically.${archivedCount ? ` ${archivedCount} archived ${archivedCount === 1 ? 'policy' : 'policies'} can be restored below.` : ''}</p>
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
      ['Recent decisions', asArray(history.decisions).length, (history.nextBeforeDecisionSeq ?? history.nextDecisionSeq) == null ? 'latest page' : 'more available']
    ];
    return `<div class="gov-summary-grid" aria-label="Governance summary">${items.map(([label, value, sub]) => `
      <article class="card gov-metric"><span>${escapeHtml(label)}</span><strong>${value}</strong><small>${escapeHtml(sub)}</small></article>`).join('')}</div>`;
  }
  /*
   * Where the work is, as a pipeline: drafts become immutable versions, a
   * version is reviewed, simulated, and only then activated. Each stage shows
   * how many items sit in it, and the first stage holding work is lit, so a
   * reader sees at a glance what is waiting and on whom.
   */
  const STAGE_ICON = Object.freeze({
    draft: '<path d="M5 19.5l1-4.2L15.8 5.5a2 2 0 0 1 2.8 0l.4.4a2 2 0 0 1 0 2.8L9.2 18.5z"/><path d="M13.8 7.5l3 3"/>',
    review: '<path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
    ready: '<path d="M12 3.2l7.4 3.1v5.4c0 4.4-3.1 8-7.4 9.6-4.3-1.6-7.4-5.2-7.4-9.6V6.3z"/><path d="M9 12l2.1 2.1 4-4.3"/>',
    active: '<path d="M13 3.5L5.5 13.2H12l-1 7.3 7.5-9.7H12z"/>'
  });
  function renderLifecycle(twin) {
    const proposed = asObject(twin.proposed);
    const versions = asArray(proposed.versions);
    const pending = versions.filter(version => asObject(version.review).status === 'pending').length;
    const ready = versions.filter(version => asObject(version.activationReadiness).eligible === true || asObject(version.review).status === 'approved').length;
    const stages = [
      ['draft', 'Drafts', count(proposed.draftCount), 'being written'],
      ['review', 'In review', pending, 'awaiting approval'],
      ['ready', 'Approved', ready, 'simulate, then activate'],
      ['active', 'Active', count(asObject(twin.current).activePolicyCount), 'enforcing now']
    ];
    const lit = stages.findIndex(([, , n], index) => n > 0 && index < 3);
    return `<ol class="gov-flow" aria-label="Policy lifecycle">${stages.map(([id, label, n, sub], index) => `
      <li class="gov-flow-stage" data-stage="${id}" data-state="${index === lit ? 'work' : n ? 'held' : 'empty'}">
        <span class="gov-flow-mark" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false">${STAGE_ICON[id]}</svg></span>
        <span class="gov-flow-n">${n}</span><span class="gov-flow-label">${escapeHtml(label)}</span><span class="gov-flow-sub">${escapeHtml(sub)}</span>
      </li>`).join('')}</ol>`;
  }

  /*
   * How the running policies bite, and what they decided. Two bars, each a
   * proportion with its counts in words beside it: the active policies by
   * enforcement mode, and the recent runtime decisions by outcome.
   */
  function proportionBar(label, parts) {
    const total = parts.reduce((sum, [, , n]) => sum + n, 0);
    const words = parts.filter(([, , n]) => n).map(([, word, n]) => `${n} ${word}`).join(', ');
    return `<div class="gov-bar-block"><div class="gov-bar-head"><span>${escapeHtml(label)}</span><b>${total}</b></div>
      <div class="gov-bar" role="img" aria-label="${escapeAttr(`${label}: ${total ? words : 'none'}`)}">${total ? parts.filter(([, , n]) => n).map(([tone, , n]) => `<i data-tone="${tone}" style="flex:${n}"></i>`).join('') : '<i data-tone="none" style="flex:1"></i>'}</div>
      <ul class="gov-bar-legend">${parts.map(([tone, word, n]) => `<li data-tone="${tone}"><span class="gov-dot" aria-hidden="true"></span>${escapeHtml(word)} <b>${n}</b></li>`).join('')}</ul></div>`;
  }
  function renderEnforcement(twin) {
    const policies = asArray(asObject(twin.current).policies);
    const modes = { observe: 0, warn: 0, block: 0 };
    for (const policy of policies) {
      const active = asObject(policy.active);
      if (!active.versionId) continue;
      const mode = String(active.enforcementMode || 'observe');
      modes[mode === 'enforce' ? 'block' : mode in modes ? mode : 'observe'] += 1;
    }
    const outcomes = { allow: 0, warn: 0, block: 0 };
    for (const decision of asArray(asObject(twin.history).decisions)) {
      const outcome = String(decision.enforcementOutcome || 'allow');
      outcomes[outcome in outcomes ? outcome : 'allow'] += 1;
    }
    return `<div class="card gov-enforce" aria-label="Enforcement">
      ${proportionBar('Active policies by mode', [['observe', 'observe', modes.observe], ['warn', 'warn', modes.warn], ['block', 'block', modes.block]])}
      ${proportionBar('Recent decisions', [['allow', 'allowed', outcomes.allow], ['warn', 'warned', outcomes.warn], ['block', 'blocked', outcomes.block]])}
    </div>`;
  }

  function renderPolicies(twin, access) {
    const policies = asArray(asObject(twin.current).policies);
    if (!policies.length) return renderEmpty(access);
    return `<section class="gov-section" aria-labelledby="govPoliciesTitle">
      <div class="gov-section-head"><div><h3 id="govPoliciesTitle">Current policy state</h3><p>Active heads and latest immutable versions.</p></div>${access.capabilities.author ? `<div class="gov-actions">${actionButton('create-policy', 'Create policy', {}, 'primary')}${actionButton('generate-baseline', 'Generate baseline')}</div>` : ''}</div>
      <div class="gov-card-grid">${policies.map(policy => {
        const active = asObject(policy.active);
        const latest = asObject(policy.latestVersion);
        const off = asObject(policy.switchedOff);
        const ids = { 'policy-id': policy.policyId, revision: count(policy.revision) };
        const lifecycle = [
          active.versionId && access.capabilities.activate ? actionButton('deactivate-policy', 'Switch off', { ...ids, 'version-number': count(active.versionNumber) }) : '',
          !active.versionId && off.versionId && access.capabilities.activate ? actionButton('reactivate-policy', `Turn v${count(off.versionNumber)} back on`, { ...ids, 'version-id': off.versionId }, 'primary') : '',
          access.capabilities.administer ? actionButton('archive-policy', 'Archive', { ...ids, active: active.versionId ? 'true' : 'false' }, 'ghost') : ''
        ].join('');
        return `<article class="card gov-policy-card">
          <div class="gov-policy-head"><div><span class="mono gov-kicker">${escapeHtml(policy.policyKey)}</span><h4>${escapeHtml(policy.name || policy.policyKey || 'Unnamed policy')}</h4></div>${active.versionId ? badge(active.enforcementMode || 'observe') : off.versionId ? badge('neutral', 'Switched off') : badge('neutral', 'Not active')}</div>
          <p>${escapeHtml(policy.description || 'No description')}</p>
          <dl class="gov-facts"><div><dt>Revision</dt><dd>${count(policy.revision)}</dd></div><div><dt>Versions</dt><dd>${count(policy.versionCount)}</dd></div><div><dt>Active</dt><dd>${active.versionId ? `v${count(active.versionNumber)}` : off.versionId ? `Off · was v${count(off.versionNumber)}` : 'None'}</dd></div><div><dt>Latest review</dt><dd>${latest.review ? escapeHtml(human(latest.review.status)) : 'No version'}</dd></div></dl>
          <div class="gov-hash mono" title="Active document hash">${escapeHtml(hashShort(active.documentHash))}</div>
          <div class="gov-actions">${actionButton('select-policy', 'Inspect', { 'policy-id': policy.policyId })}${access.capabilities.author ? actionButton('new-draft', 'New draft', { 'policy-id': policy.policyId }) : ''}${active.versionId && access.capabilities.author ? actionButton('request-exception', 'Request exception', { 'policy-id': policy.policyId, 'version-id': active.versionId }) : ''}</div>
          ${lifecycle ? `<div class="gov-actions gov-lifecycle-actions">${lifecycle}</div>` : ''}
        </article>`;
      }).join('')}</div>
    </section>`;
  }
  function renderDrafts(twin, access) {
    const drafts = asArray(asObject(twin.proposed).drafts);
    if (!drafts.length) return '';
    return `<section class="gov-section" aria-labelledby="govDraftsTitle"><div class="gov-section-head"><div><h3 id="govDraftsTitle">Active drafts</h3><p>Mutable author-owned work. Submission creates an immutable version.</p></div></div><div class="gov-list">${drafts.map(draft => `
      <article class="card gov-row"><div class="gov-row-main"><strong>Draft r${count(draft.revision)}</strong><span>Policy ${escapeHtml(String(draft.policyId || '').slice(0, 8))} · ${escapeHtml(draft.authoredByLogin)}</span><small>Updated ${escapeHtml(formatTime(draft.updatedAt))}</small></div><div class="gov-actions">${access.capabilities.author ? actionButton('edit-draft', 'Edit', { 'policy-id': draft.policyId, 'draft-id': draft.draftId }) + actionButton('validate-draft', 'Validate', { 'policy-id': draft.policyId, 'draft-id': draft.draftId }) + actionButton('submit-draft', 'Submit', { 'policy-id': draft.policyId, 'draft-id': draft.draftId, revision: draft.revision }, 'primary') : ''}${access.capabilities.author && (draft.authoredByLogin === access.actor.login || access.capabilities.administer) ? actionButton('discard-draft', 'Discard', { 'policy-id': draft.policyId, 'draft-id': draft.draftId, revision: draft.revision }, 'ghost') : ''}</div></article>`).join('')}</div></section>`;
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
      return `<article class="card gov-version-row"><div class="gov-row-main"><div class="gov-row-title"><strong>${escapeHtml(version.policyKey)} v${count(version.versionNumber)}</strong>${badge(review.status || 'pending')}</div><span>${escapeHtml(reviewSummary(review))}</span><small>${escapeHtml(formatTime(version.createdAt))} · ${escapeHtml(hashShort(version.documentHash))}</small>${simMatches ? `<div class="gov-inline-result">${badge(eligible ? 'approved' : 'warn', eligible ? 'Simulation eligible' : 'Simulation blocked')}<span>${escapeHtml(hashShort(asObject(sim.report).simulationHash))}</span></div>` : ''}</div><div class="gov-actions">${actionButton('view-version', 'View JSON', ids)}${actionButton('simulate', 'Simulate', ids, simMatches ? 'ghost' : 'primary')}${access.capabilities.review && review.status === 'pending' ? actionButton('claim-review', 'Claim review', ids) + actionButton('approve', 'Approve', ids) + actionButton('reject', 'Reject', ids, 'ghost') : ''}${access.capabilities.activate ? actionButton('activate', 'Activate', ids, 'primary', !eligible, eligible ? '' : 'Run an eligible fresh simulation first') : ''}${access.capabilities.author ? actionButton('withdraw-version', 'Withdraw', { ...ids, 'version-number': count(version.versionNumber) }, 'ghost') : ''}</div></article>`;
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
  /*
   * The evidence ledger as a reader can work through it: one list at a time
   * (runtime decisions or activations), filtered by outcome, a page at a time,
   * newest first. A long-lived repository has hundreds of entries, and the
   * old two timelines -- every activation with its own full-width rollback
   * button -- ran the length of the page. "Clear from view" tidies the list
   * for this reader only, up to the newest entry shown; the ledger itself is
   * immutable, so every entry stays in exports and in chain verification and
   * one press brings them back.
   */
  const LEDGER_PAGE = 8;
  const OUTCOME = Object.freeze({ block: 'Blocked', warn: 'Warned', allow: 'Allowed' });
  const ACTIVATION = Object.freeze({ activate: 'Activated', deactivate: 'Switched off', rollback: 'Rolled back' });
  const ACTIVATION_TONE = Object.freeze({ activate: 'allow', deactivate: 'warn', rollback: 'info' });
  function ago(value) {
    const at = new Date(value).getTime();
    if (!Number.isFinite(at)) return 'unknown time';
    const minutes = Math.max(0, Math.round((Date.now() - at) / 60000));
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours} h ago`;
    return `${Math.round(hours / 24)} d ago`;
  }
  function ledgerControl(action, label, data, attrs = '') {
    const ids = Object.entries(data).map(([key, value]) => ` data-${escapeAttr(key)}="${escapeAttr(value)}"`).join('');
    return `<button type="button" data-gov-action="${escapeAttr(action)}"${ids}${attrs}>${label}</button>`;
  }
  function renderHistory(twin, access, verification, viewInput) {
    const history = asObject(twin.history);
    const view = asObject(viewInput);
    const verify = asObject(verification);
    const tab = view.tab === 'activations' ? 'activations' : 'decisions';
    const decisions = asArray(history.decisions);
    const activations = asArray(history.activations);
    const all = tab === 'decisions' ? decisions : activations;
    const cleared = count(asObject(view.cleared)[tab]);
    const showCleared = view.showCleared === true;
    const live = all.filter(item => count(item.seq) > cleared);
    const pool = showCleared ? all : live;
    const kindOf = item => (tab === 'decisions'
      ? (String(item.enforcementOutcome || 'allow') in OUTCOME ? String(item.enforcementOutcome || 'allow') : 'allow')
      : (String(item.action || 'activate') in ACTIVATION ? String(item.action || 'activate') : 'activate'));
    const words = tab === 'decisions' ? OUTCOME : ACTIVATION;
    const filter = view.filter && view.filter in words ? view.filter : 'all';
    const filtered = filter === 'all' ? pool : pool.filter(item => kindOf(item) === filter);
    const limit = Math.max(LEDGER_PAGE, count(view.limit) || LEDGER_PAGE);
    const shown = filtered.slice(0, limit);
    const policies = asArray(asObject(twin.current).policies);
    const keyOf = id => { const policy = policies.find(item => item.policyId === id); return policy ? policy.policyKey : String(id || '').slice(0, 8); };
    const activeOf = id => { const policy = policies.find(item => item.policyId === id); return policy ? asObject(policy.active).versionId : null; };

    const tabs = [['decisions', 'Runtime decisions', decisions.length, (history.nextBeforeDecisionSeq ?? history.nextDecisionSeq) != null], ['activations', 'Activations', activations.length, false]]
      .map(([id, label, n, more]) => ledgerControl('ledger-tab', `${escapeHtml(label)} <span class="gov-ledger-count">${n}${more ? '+' : ''}</span>`, { tab: id, 'focus-key': `ledger-tab:${id}` },
        ` role="tab" id="govLedgerTab-${id}" aria-controls="govLedgerPanel" aria-selected="${id === tab}" class="gov-ledger-tab" tabindex="${id === tab ? 0 : -1}"`)).join('');
    const chips = [['all', 'All', pool.length], ...Object.entries(words).map(([id, word]) => [id, word, pool.filter(item => kindOf(item) === id).length])]
      .map(([id, word, n]) => ledgerControl('ledger-filter', `${escapeHtml(word)} <b>${n}</b>`, { filter: id, 'focus-key': `ledger-filter:${id}` },
        ` class="gov-ledger-chip" data-tone="${id === 'all' ? 'neutral' : tab === 'decisions' ? id : ACTIVATION_TONE[id]}" aria-pressed="${id === filter}"${n || id === 'all' ? '' : ' disabled'}`)).join('');

    const row = item => {
      const kind = kindOf(item);
      if (tab === 'decisions') {
        return `<li class="gov-ledger-row" data-tone="${kind}"${count(item.seq) <= cleared ? ' data-cleared="true"' : ''}>
          <span class="gov-ledger-mark" aria-hidden="true"></span>
          <span class="gov-ledger-what"><strong class="mono">${escapeHtml(item.action)}</strong><small>${escapeHtml(human(item.effectiveEffect))} · ${escapeHtml(hashShort(item.decisionHash))}</small></span>
          <span class="gov-ledger-state">${escapeHtml(OUTCOME[kind])}</span>
          <time class="gov-ledger-when" datetime="${escapeAttr(item.evaluatedAt)}" title="${escapeAttr(formatTime(item.evaluatedAt))}">${escapeHtml(ago(item.evaluatedAt))}</time>
        </li>`;
      }
      const current = kind !== 'deactivate' && activeOf(item.policyId) === item.versionId;
      /* One small control per row, named in full for a screen reader and on hover: the list is for reading, the control is there when wanted. */
      const restoreLabel = `${kind === 'deactivate' ? 'Turn back on' : 'Roll back to'} ${keyOf(item.policyId)} version ${String(item.versionId || '').slice(0, 8)}`;
      const restore = access.capabilities.activate && !current
        ? ledgerControl('rollback', '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4.5v4.2h4.2"/></svg>', { 'policy-id': item.policyId, 'version-id': item.versionId },
          ` class="btn btn-ghost small gov-ledger-act" aria-label="${escapeAttr(restoreLabel)}" title="${escapeAttr(restoreLabel)}"`)
        : current ? '<span class="gov-ledger-now">Current</span>' : '';
      return `<li class="gov-ledger-row" data-tone="${ACTIVATION_TONE[kind]}"${count(item.seq) <= cleared ? ' data-cleared="true"' : ''}>
        <span class="gov-ledger-mark" aria-hidden="true"></span>
        <span class="gov-ledger-what"><strong>${escapeHtml(ACTIVATION[kind])} · <span class="mono">${escapeHtml(keyOf(item.policyId))}</span></strong><small>${escapeHtml(item.actorLogin)} · version ${escapeHtml(String(item.versionId || '').slice(0, 8))}</small></span>
        <span class="gov-ledger-state">${restore}</span>
        <time class="gov-ledger-when" datetime="${escapeAttr(item.createdAt)}" title="${escapeAttr(formatTime(item.createdAt))}">${escapeHtml(ago(item.createdAt))}</time>
      </li>`;
    };

    const foot = [
      `<span class="gov-ledger-shown">${shown.length ? `Showing ${shown.length} of ${filtered.length}` : 'Nothing to show'}</span>`,
      filtered.length > shown.length ? actionButton('ledger-more', `Show ${Math.min(LEDGER_PAGE, filtered.length - shown.length)} more`, { 'focus-key': 'ledger-more' }) : '',
      tab === 'decisions' && (history.nextBeforeDecisionSeq ?? history.nextDecisionSeq) != null ? actionButton('load-more-decisions', 'Load older decisions', history.nextBeforeDecisionSeq != null ? { 'before-seq': history.nextBeforeDecisionSeq } : { 'after-seq': history.nextDecisionSeq }) : '',
      live.length ? actionButton('ledger-clear', 'Clear from view', { through: Math.max(...live.map(item => count(item.seq))), 'focus-key': 'ledger-clear' }) : '',
      all.length - live.length ? actionButton('ledger-show-cleared', showCleared ? 'Hide cleared' : `Show ${all.length - live.length} cleared`, { 'focus-key': 'ledger-show-cleared' }) : ''
    ].join('');
    const empty = all.length
      ? (live.length || showCleared ? 'No entries match this filter.' : `All ${all.length} cleared from view. They are still in the ledger.`)
      : (tab === 'decisions' ? 'No runtime decisions yet.' : 'No activation history yet.');

    return `<section class="gov-section" aria-labelledby="govHistoryTitle"><div class="gov-section-head"><div><h3 id="govHistoryTitle">Evidence history</h3><p>Every runtime decision and activation, newest first, from the immutable ledger.</p></div><div class="gov-actions">${actionButton('verify-chain', verify.valid === true && verify.complete === true ? 'Chain verified' : 'Verify chain')}</div></div>${verify.valid != null ? `<div class="gov-banner ${verify.valid ? 'ok' : 'danger'}" role="status">${verify.valid ? (verify.complete === true ? 'Decision chain verified' : 'Decision chain valid through the configured verification limit') : 'Decision chain verification failed'}${verify.checked != null ? ` · ${count(verify.checked)} records checked` : ''}</div>` : ''}
      <div class="card gov-ledger">
        <div class="gov-ledger-tabs" role="tablist" aria-label="Evidence">${tabs}</div>
        <div class="gov-ledger-chips" role="group" aria-label="Filter ${tab === 'decisions' ? 'decisions by outcome' : 'activations by kind'}">${chips}</div>
        <div id="govLedgerPanel" role="tabpanel" aria-labelledby="govLedgerTab-${tab}">
          ${shown.length ? `<ol class="gov-ledger-rows">${shown.map(row).join('')}</ol>` : `<p class="gov-muted gov-ledger-empty">${escapeHtml(empty)}</p>`}
        </div>
        <div class="gov-ledger-foot">${foot}</div>
        ${cleared ? '<p class="gov-ledger-note">Clearing tidies this view for you only. The ledger is immutable: cleared entries stay in exports and chain verification.</p>' : ''}
      </div>
    </section>`;
  }
  /*
   * Notifications are an inbox: what is unread, a few at a time, and a Clear
   * that marks them read on the server and puts them away. What was read is
   * one press away. Signed exports show the latest few; the rest unfold.
   */
  const INBOX_PAGE = 6;
  const EXPORTS_SHOWN = 4;
  function renderDelivery(deliveryInput, access, viewInput) {
    const delivery = asObject(deliveryInput);
    const view = asObject(viewInput);
    const preferences = asObject(delivery.preferences);
    const notifications = asArray(asObject(delivery.notifications).events);
    const exportsList = asArray(delivery.exports);
    const webhooks = asArray(delivery.webhooks);
    const readThrough = count(preferences.lastReadSeq);
    const unreadItems = notifications.filter(item => count(item.seq) > readThrough);
    const unread = unreadItems.length;
    const showRead = view.showRead === true;
    const inbox = showRead ? notifications : unreadItems;
    const inboxLimit = Math.max(INBOX_PAGE, count(view.inboxLimit) || INBOX_PAGE);
    const inboxShown = inbox.slice(0, inboxLimit);
    const exportsAll = view.exportsAll === true;
    const exportsShown = exportsAll ? exportsList : exportsList.slice(0, EXPORTS_SHOWN);
    const latestSeq = notifications.length ? Math.max(...notifications.map(item => count(item.seq))) : 0;
    const note = item => `<li class="gov-inbox-row"${count(item.seq) <= readThrough ? ' data-read="true"' : ''}><span class="gov-inbox-dot" aria-hidden="true"></span><span class="gov-ledger-what"><strong>${escapeHtml(human(item.eventType))}</strong><small>Event ${count(item.seq)} · ${escapeHtml(hashShort(item.eventHash))}</small></span><time class="gov-ledger-when" datetime="${escapeAttr(item.createdAt)}" title="${escapeAttr(formatTime(item.createdAt))}">${escapeHtml(ago(item.createdAt))}</time></li>`;
    const inboxFoot = [
      inbox.length > inboxShown.length ? actionButton('inbox-more', `Show ${Math.min(INBOX_PAGE, inbox.length - inboxShown.length)} more`, { 'focus-key': 'inbox-more' }) : '',
      unread ? actionButton('mark-notifications-read', `Clear ${unread}`, { 'through-seq': latestSeq }) : '',
      notifications.length - unread ? actionButton('inbox-show-read', showRead ? 'Hide read' : `Show ${notifications.length - unread} read`, { 'focus-key': 'inbox-show-read' }) : ''
    ].join('');
    return `<section class="gov-section" aria-labelledby="govDeliveryTitle">
      <div class="gov-section-head"><div><h3 id="govDeliveryTitle">Notifications and signed evidence</h3><p>Live-only governance events, bounded exports and administrator-managed webhooks.</p></div><div class="gov-actions">${actionButton('delivery-refresh', 'Refresh delivery')}${actionButton('create-export', 'Create signed export', {}, 'primary')}</div></div>
      ${delivery.error ? `<div class="gov-banner warn" role="status"><strong>Delivery evidence partially unavailable</strong><span>${escapeHtml(delivery.error)}</span></div>` : ''}
      <div class="gov-history-grid">
        <article class="card gov-inbox"><div class="gov-row-title"><h4>Notifications</h4>${badge(unread ? 'warn' : 'current', `${unread} unread`)}</div><p class="gov-muted">${preferences.enabled === false ? 'Notifications are disabled for this identity.' : 'Notifications are enabled for selected governance events.'}</p>
          ${inboxShown.length ? `<ol class="gov-ledger-rows gov-inbox-rows">${inboxShown.map(note).join('')}</ol>` : `<p class="gov-muted gov-ledger-empty">${notifications.length ? 'All caught up. Nothing unread.' : 'No governance notifications.'}</p>`}
          <div class="gov-ledger-foot">${actionButton('edit-notification-preferences', 'Preferences')}${inboxFoot}</div></article>
        <article class="card gov-exports"><div class="gov-row-title"><h4>Signed audit exports</h4>${badge(exportsList.length ? 'current' : 'neutral', `${exportsList.length} recorded`)}</div><p class="gov-muted">Bounded JSON or CSV evidence envelopes. External storage is not part of this checkpoint.</p>
          ${exportsShown.length ? `<ol class="gov-ledger-rows">${exportsShown.map(item => `<li class="gov-ledger-row gov-export-row" data-tone="neutral"><span class="gov-ledger-mark" aria-hidden="true"></span><span class="gov-ledger-what"><strong>${escapeHtml(String(item.format || 'json').toUpperCase())} · ${count(item.eventCount)} events</strong><small>${escapeHtml(hashShort(item.envelopeHash || item.exportHash))}</small></span><span class="gov-ledger-state gov-export-acts">${actionButton('download-export', 'Download', { 'export-id': item.exportId })}${actionButton('verify-export', 'Verify', { 'export-id': item.exportId })}</span><time class="gov-ledger-when" datetime="${escapeAttr(item.createdAt)}" title="${escapeAttr(formatTime(item.createdAt))}">${escapeHtml(ago(item.createdAt))}</time></li>`).join('')}</ol>` : '<p class="gov-muted gov-ledger-empty">No signed exports have been created.</p>'}
          ${exportsList.length > EXPORTS_SHOWN ? `<div class="gov-ledger-foot"><span class="gov-ledger-shown">Showing ${exportsShown.length} of ${exportsList.length}</span>${actionButton('exports-all', exportsAll ? 'Show latest only' : `Show all ${exportsList.length}`, { 'focus-key': 'exports-all' })}</div>` : ''}</article>
      </div>
      ${access.capabilities.administer ? `<article class="card gov-webhooks"><div class="gov-section-head"><div><h4>Administrative webhooks</h4><p>HTTPS-only, DNS-revalidated, signed delivery endpoints.</p></div>${actionButton('create-webhook', 'Add webhook', {}, 'primary')}</div>${webhooks.length ? `<div class="gov-list">${webhooks.map(item => `<div class="gov-row"><div class="gov-row-main"><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.url)}</span><small>${item.enabled === false ? 'Disabled' : 'Enabled'} · ${escapeHtml((item.eventTypes || []).join(', '))}</small></div><div class="gov-actions">${actionButton('rotate-webhook', 'Rotate secret', { 'webhook-id': item.webhookId })}${actionButton('delete-webhook', 'Delete', { 'webhook-id': item.webhookId }, 'ghost')}</div></div>`).join('')}</div>` : '<p class="gov-muted">No webhooks configured.</p>'}</article>` : ''}
    </section>`;
  }

  /*
   * Archived policies: out of the way, not gone. Each keeps its versions and
   * history and can come back -- switched off, so returning to enforcement is
   * still a deliberate, simulated step.
   */
  function renderArchived(archivedInput, access) {
    const archived = asArray(archivedInput);
    if (!archived.length) return '';
    return `<section class="gov-section" aria-labelledby="govArchivedTitle"><details class="card gov-archived">
      <summary><span id="govArchivedTitle" class="gov-archived-title">Archived policies</span>${badge('neutral', String(archived.length))}</summary>
      <p class="gov-muted">Archived policies enforce nothing. Their versions and evidence are kept, and restoring one brings it back switched off.</p>
      <div class="gov-list">${archived.map(item => `<article class="gov-row"><div class="gov-row-main"><strong>${escapeHtml(item.name || item.policyKey)}</strong><span class="mono">${escapeHtml(item.policyKey)}</span><small>Archived ${escapeHtml(formatTime(item.archivedAt))} · ${count(item.versionCount)} version${count(item.versionCount) === 1 ? '' : 's'}${item.keyInUse ? ' · a current policy uses this key' : ''}</small></div><div class="gov-actions">${access.capabilities.administer ? actionButton('restore-policy', 'Restore', { 'policy-id': item.policyId, name: item.name || item.policyKey }, 'ghost', item.keyInUse === true, item.keyInUse ? 'Archive or rename the current policy with this key first' : '') : ''}</div></article>`).join('')}</div>
    </details></section>`;
  }
  /*
   * The reset, kept apart from everything else on the page and spelled out
   * before it is offered: what stops, what is kept, and that it can be undone
   * policy by policy.
   */
  function renderDangerZone(twin, access) {
    if (!access.capabilities.administer) return '';
    const current = asObject(twin.current);
    const total = count(current.policyCount);
    if (!total) return '';
    const running = count(current.activePolicyCount);
    return `<section class="gov-section" aria-labelledby="govResetTitle"><article class="card gov-danger-zone">
      <div class="gov-danger-copy"><h3 id="govResetTitle">Reset governance</h3>
        <p>Switches off and archives all ${total} ${total === 1 ? 'policy' : 'policies'}${running ? ` (${running} running now)` : ''}. Enforcement stops at once. The evidence ledger, signed exports, webhooks and notification settings are kept, and every policy can be restored afterwards.</p></div>
      ${actionButton('reset-governance', 'Reset governance…', { total, running }, 'ghost danger')}
    </article></section>`;
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
      <header class="gov-hero"><div><span class="gov-eyebrow">Magnetar Sec · Kepler Twin</span><h2>Policy Digital Twin</h2><p><span class="mono">${escapeHtml(scope.owner)}/${escapeHtml(scope.repo)}</span> · snapshot ${escapeHtml(formatTime(freshness.asOf))}</p></div><div class="gov-hero-actions">${badge(freshness.status || 'partial')}${access.evidence.status !== 'current' ? badge(access.evidence.status) : ''}${actionButton('refresh', 'Refresh', {}, 'ghost')}</div></header>
      ${freshness.status !== 'current' ? `<div class="gov-banner warn" role="status"><strong>Partial evidence</strong><span>${incomplete.length ? `Incomplete: ${escapeHtml(incomplete.join(', '))}.` : 'One or more evidence sections are incomplete.'} Decisions remain server-authoritative.</span></div>` : ''}
      ${access.evidence.status !== 'current' ? `<div class="gov-banner danger" role="alert"><strong>Authorization evidence ${escapeHtml(access.evidence.status)}</strong><span>Governance actions are disabled until repository permissions are refreshed.</span></div>` : ''}
      <div class="gov-access-line"><span>Signed in as <b>${escapeHtml(access.actor.login || 'unknown')}</b></span><span>${escapeHtml(access.execution.kind === 'installation' ? 'GitHub App execution · human governance actor' : human(access.execution.authMethod || 'user session'))}</span></div>
      ${renderSummary(twin)}
      ${noPolicies ? '' : `<div class="gov-overview">${renderLifecycle(twin)}${renderEnforcement(twin)}</div>`}
      ${noPolicies ? renderEmpty(access, asArray(input.archived).length) : renderPolicies(twin, access)}
      ${renderDrafts(twin, access)}
      ${renderProposed(twin, access, input.simulation)}
      ${renderExceptions(twin, access)}
      ${renderHistory(twin, access, input.verification, input.view)}
      ${renderArchived(input.archived, access)}
      ${renderDelivery(input.delivery, access, input.view)}
      ${renderDangerZone(twin, access)}
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
