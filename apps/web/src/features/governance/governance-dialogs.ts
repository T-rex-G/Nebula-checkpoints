/*
 * What governance's dialogs say and ask (governance-actions.ts opens them).
 * Each is markup for the modal's body; every value the server or the reader
 * supplied is escaped for where it lands -- text between tags, or an
 * attribute's quoted value -- so nothing in it is run.
 */
import { escapeAttribute, escapeHtml } from '../../platform/html.ts';
import { field } from '../../platform/values.ts';

const json = (value: unknown): string => escapeHtml(JSON.stringify(value, null, 2));
const reasonField = (rows: number): string => `<label class="field-label" for="govLifecycleReason">Reason</label><textarea id="govLifecycleReason" rows="${rows}"></textarea>`;

/* Evidence shown as it was sent, for reading. */
export const jsonBody = (value: unknown): string => `<pre class="mono gov-json-view">${json(value)}</pre>`;

export const CREATE_POLICY_BODY = `<label class="field-label" for="govPolicyKey">Stable policy key</label><input id="govPolicyKey" type="text" placeholder="release-safety" autocapitalize="off" autocorrect="off" spellcheck="false">
      <label class="field-label" for="govPolicyName">Name</label><input id="govPolicyName" type="text" placeholder="Release safety">
      <label class="field-label" for="govPolicyDescription">Description</label><textarea id="govPolicyDescription" rows="4" placeholder="What this policy protects"></textarea>
      <p class="hint">Creating a policy does not create, submit or activate a version.</p>`;

export function draftBody(document: unknown, approvalPolicy: unknown): string {
  return `<label class="field-label" for="govDraftDocument">Policy document (JSON)</label><textarea id="govDraftDocument" rows="14" class="mono" spellcheck="false">${json(document)}</textarea>
      <label class="field-label" for="govDraftApproval">Approval policy (JSON)</label><textarea id="govDraftApproval" rows="5" class="mono" spellcheck="false">${json(approvalPolicy)}</textarea>
      <p class="hint">The draft remains mutable until submission. Nothing is activated automatically.</p>`;
}

export function editDraftBody(document: unknown, approvalPolicy: unknown): string {
  return `<label class="field-label" for="govEditDocument">Policy document (JSON)</label><textarea id="govEditDocument" rows="14" class="mono" spellcheck="false">${json(document)}</textarea>
      <label class="field-label" for="govEditApproval">Approval policy (JSON)</label><textarea id="govEditApproval" rows="5" class="mono" spellcheck="false">${json(approvalPolicy)}</textarea>`;
}

/*
 * What a generated baseline says about itself, in prose. A baseline can run
 * to hundreds of rules, and the sentence that matters most -- that it records
 * rather than blocks until it is activated -- should not have to be found
 * inside the JSON below it.
 */
export function baselineSummary(baseline: unknown): string {
  const document = field(baseline, 'document');
  const described = field(document, 'description');
  const description = typeof described === 'string' ? described.trim() : '';
  const enforcement = field(document, 'enforcement');
  const mode = enforcement ? String(field(enforcement, 'mode') || '') : '';
  const rules = field(document, 'rules');
  const ruleCount = Array.isArray(rules) ? rules.length : 0;
  if (!description && !mode) return '';
  const counts = [ruleCount ? `${ruleCount} rule${ruleCount === 1 ? '' : 's'}` : 'no rules', mode ? `${mode} mode` : ''].filter(Boolean).join(' · ');
  return `<p class="hint gov-baseline-summary"><strong>${escapeHtml(counts)}</strong>${description ? ` — ${escapeHtml(description)}` : ''}</p>`;
}

export function templatesBody(templates: readonly unknown[]): string {
  const options = templates.map(item => `<option value="${escapeAttribute(field(item, 'templateId'))}">${escapeHtml(field(item, 'name') || field(item, 'templateId'))}</option>`).join('');
  return `<label class="field-label" for="govTemplateId">Template</label><select id="govTemplateId">${options}</select>
      <p class="hint">Generation is read-only. The result is not persisted or activated.</p>`;
}

/* The generated baseline, with the policy's key made from its template and its name from the template chosen. */
export function baselineBody(baseline: unknown, template: unknown): string {
  const ready = field(field(baseline, 'readiness'), 'status') === 'ready';
  const policyKey = String(field(baseline, 'templateId') || 'baseline').replace(/[^a-z0-9._-]+/gi, '-').toLowerCase();
  return `<div class="gov-banner ${ready ? 'ok' : 'warn'}"><strong>${ready ? 'Repository facts complete' : 'Review incomplete repository facts'}</strong></div>
      <label class="field-label" for="govBaselineKey">Policy key</label><input id="govBaselineKey" type="text" value="${escapeAttribute(policyKey)}" autocapitalize="off" autocorrect="off" spellcheck="false">
      <label class="field-label" for="govBaselineName">Policy name</label><input id="govBaselineName" type="text" value="${escapeAttribute(field(template, 'name') || 'Repository baseline')}">
      ${baselineSummary(baseline)}
      <pre class="mono gov-json-view">${json(baseline)}</pre>`;
}

export const SUBMIT_BODY = '<p>Submission freezes this draft as a new immutable policy version. It does not activate it.</p>';

export function simulationBody(request: unknown): string {
  return `<label class="field-label" for="govSimulationRequest">Bounded scenario request (JSON)</label><textarea id="govSimulationRequest" rows="16" class="mono" spellcheck="false">${json(request)}</textarea>
      <p class="hint">Simulation is read-only and must exercise every proposed rule before activation.</p>`;
}

export function reviewBody(rejecting: boolean): string {
  return `<p>${rejecting ? 'Rejection is terminal for this review.' : 'Your approval becomes immutable governance evidence.'}</p>
      <label class="field-label" for="govReviewRationale">Rationale${rejecting ? ' (required)' : ''}</label><textarea id="govReviewRationale" rows="5"></textarea>`;
}

/* Activation and rollback, in the words given for them or the plain ones. */
export function activationBody(said: string | null): string {
  return `<p>${said === null ? 'This changes the authoritative policy head after server-side evidence is recomputed.' : escapeHtml(said)}</p><label class="field-label" for="govActivationReason">Reason</label><textarea id="govActivationReason" rows="5"></textarea>`;
}

/* An exception asked for on the branch open, expiring when `expires` (a local date and time) says unless changed. */
export function exceptionBody(branch: unknown, expires: string): string {
  return `<label class="field-label" for="govExceptionKind">Kind</label><select id="govExceptionKind"><option value="exception">Exception (deny rules)</option><option value="waiver">Waiver (approval rules)</option></select>
      <label class="field-label" for="govExceptionAction">Registered mutation action</label><input id="govExceptionAction" type="text" placeholder="file.write" autocapitalize="off" autocorrect="off" spellcheck="false">
      <label class="field-label" for="govExceptionRules">Rule IDs (comma separated)</label><input id="govExceptionRules" type="text" placeholder="protected-main-write" autocapitalize="off" autocorrect="off" spellcheck="false">
      <label class="field-label" for="govExceptionTarget">Exact mutation target (JSON)</label><textarea id="govExceptionTarget" rows="6" class="mono" spellcheck="false">${json({ branch })}</textarea>
      <label class="field-label" for="govExceptionExpires">Expires</label><input id="govExceptionExpires" type="datetime-local" value="${escapeAttribute(expires)}">
      <label class="field-label" for="govExceptionReason">Reason</label><textarea id="govExceptionReason" rows="5"></textarea>
      <p class="hint">The request is bound to your verified human identity and this exact target.</p>`;
}

export const EXCEPTION_DECISION_BODY = `<label class="field-label" for="govExceptionDecision">Decision</label><select id="govExceptionDecision"><option value="approve">Approve</option><option value="reject">Reject</option></select>
      <label class="field-label" for="govExceptionDecisionReason">Reason</label><textarea id="govExceptionDecisionReason" rows="5"></textarea>
      <p class="hint">The requester cannot approve their own request.</p>`;

export const REVOKE_BODY = '<label class="field-label" for="govExceptionRevokeReason">Reason</label><textarea id="govExceptionRevokeReason" rows="5"></textarea>';

export function preferencesBody(enabled: boolean, types: string): string {
  return `<label class="field-label"><input id="govNotificationEnabled" type="checkbox" ${enabled ? 'checked' : ''}> Enable notifications</label><label class="field-label" for="govNotificationTypes">Event types, one per line</label><textarea id="govNotificationTypes" rows="10">${escapeHtml(types)}</textarea>`;
}

export const EXPORT_BODY = '<label class="field-label" for="govExportFormat">Format</label><select id="govExportFormat"><option value="json">JSON</option><option value="csv">CSV</option></select><label class="field-label" for="govExportLimit">Maximum events (1–1000)</label><input id="govExportLimit" type="number" min="1" max="1000" value="1000">';

export const WEBHOOK_BODY = '<label class="field-label" for="govWebhookName">Name</label><input id="govWebhookName" maxlength="120"><label class="field-label" for="govWebhookUrl">HTTPS URL</label><input id="govWebhookUrl" type="url" placeholder="https://hooks.example.com/governance"><label class="field-label" for="govWebhookTypes">Event types, one per line</label><textarea id="govWebhookTypes" rows="8">policy.activated\npolicy.decision.block</textarea>';
export const ROTATE_BODY = '<p>The previous secret will stop signing future deliveries. Update the receiver immediately.</p>';
export const DELETE_WEBHOOK_BODY = '<p>Future deliveries to this endpoint will stop.</p>';
export const SECRET_WARNING = 'This secret is shown once and cannot be recovered.';

/* The rest of a policy's life: what happens, and what is kept, said before it happens. */
export function deactivateBody(versionNumber: unknown): string {
  return `<p>Enforcement stops at once for every action this policy covers, and approved exceptions on it end. Version v${escapeHtml(versionNumber)} stays in the history; turning it back on later takes a fresh simulation.</p>
      ${reasonField(4)}`;
}

export function archiveBody(active: boolean): string {
  return `<p>${active ? 'It is switched off first, so enforcement stops at once. ' : ''}The policy leaves this list and enforces nothing. Its versions, drafts and history are kept, and you can restore it from Archived policies.</p>
      ${reasonField(4)}`;
}

export const RESTORE_BODY = `<p>It comes back switched off, with its versions and history. Turning it on again is a separate step with a fresh simulation.</p>
      ${reasonField(4)}`;

export const DISCARD_BODY = '<p>The draft and its unsubmitted edits are deleted. Submitted versions are not affected, and the discard is recorded in the governance ledger.</p>';

export const WITHDRAW_BODY = `<p>Reviewers can no longer review it and it can never be activated. It stays in the history as withdrawn.</p>
      ${reasonField(4)}`;

/* Resetting a repository's governance: every policy, how many are running, what is kept, and the name typed to confirm. */
export function resetBody(name: string, total: unknown, running: unknown): string {
  return `<ul class="gov-reset-list">
        <li>All ${escapeHtml(total)} ${Number(total) === 1 ? 'policy is' : 'policies are'} switched off and archived${Number(running) ? ` — ${escapeHtml(running)} running now` : ''}.</li>
        <li>Enforcement stops at once, and approved exceptions end.</li>
        <li>Kept: the evidence ledger, signed exports, webhooks and notification settings.</li>
        <li>Every policy can be restored afterwards from Archived policies.</li>
      </ul>
      ${reasonField(3)}
      <label class="field-label" for="govResetConfirm">Type <span class="mono">${escapeHtml(name)}</span> to confirm</label><input id="govResetConfirm" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="${escapeAttribute(name)}">`;
}
