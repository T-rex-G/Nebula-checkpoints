'use strict';

/*
 * The lifecycle controls on the Policy Digital Twin.
 *
 * The server refuses a role that does not hold, so these are not the security
 * boundary -- but a control that is drawn and then refused is a promise the
 * page breaks, and one that is missing is a capability nobody can find. So
 * each role gets exactly the controls it can use, a switched-off policy offers
 * to come back rather than to be activated from scratch, and the reset is only
 * ever drawn for an administrator with something to reset.
 */

const assert = require('assert');
const ui = require('../public/governance-ui');

const POLICY = '10000000-0000-4000-8000-000000000001';
const ACTIVE = '20000000-0000-4000-8000-000000000002';
const PENDING = '30000000-0000-4000-8000-000000000003';
const review = { status: 'pending', requiredApprovals: 1, assignedCount: 0, approvalCount: 0, rejectionCount: 0, terminal: false };

function twin(policyOverrides = {}) {
  return {
    schemaVersion: 1,
    scope: { provider: 'github', authority: 'github.com', owner: 'Acme', repo: 'Demo', scopeKey: 'github:github.com:acme/demo' },
    current: {
      policyCount: 1, returnedPolicyCount: 1, activePolicyCount: policyOverrides.active === null ? 0 : 1,
      policies: [{
        policyId: POLICY, policyKey: 'release-safety', name: 'Release safety', description: '', revision: 4,
        updatedAt: '2026-09-25T00:00:00.000Z',
        active: { versionId: ACTIVE, versionNumber: 1, documentHash: 'a'.repeat(64), enforcementMode: 'block' },
        latestVersion: null, versionCount: 2, switchedOff: null,
        ...policyOverrides
      }]
    },
    proposed: {
      drafts: [{ draftId: '40000000-0000-4000-8000-000000000004', policyId: POLICY, revision: 2, documentHash: 'c'.repeat(64), authoredByLogin: 'alice', requiredApprovals: 1, disallowAuthorApproval: true, createdAt: '2026-09-25T00:00:00.000Z', updatedAt: '2026-09-25T00:00:00.000Z' }],
      draftCount: 1,
      versions: [{ policyId: POLICY, policyKey: 'release-safety', versionId: PENDING, versionNumber: 2, documentHash: 'b'.repeat(64), createdAt: '2026-09-25T00:00:00.000Z', review, simulationEvidence: { status: 'fresh-simulation-required' }, activationReadiness: { eligible: false, blockers: [] } }],
      versionCount: 1
    },
    effective: { activePolicyCount: 1, activeExceptionCount: 0, activeExceptionsByAction: [], exceptionReferences: [] },
    history: {
      activations: [{ seq: 3, policyId: POLICY, versionId: ACTIVE, action: 'deactivate', actorLogin: 'admin', createdAt: '2026-09-25T00:00:00.000Z', evidence: null }],
      decisions: [], exceptions: [], nextDecisionSeq: null, requestedAfterDecisionSeq: 0, limit: 50
    },
    freshness: { status: 'current', asOf: '2026-09-25T00:00:00.000Z', completeness: { policies: true, versions: true, drafts: true, exceptions: true, activations: true, decisions: true } },
    readModelHash: '2'.repeat(64)
  };
}
function access(login, capabilities) {
  return {
    schemaVersion: 1, repository: { provider: 'github', authority: 'github.com', owner: 'Acme', repo: 'Demo' },
    actor: { login }, execution: { kind: 'user', authMethod: 'oauth' },
    capabilities: { read: true, author: false, review: false, activate: false, administer: false, ...capabilities },
    evidence: { status: 'current', expiresAt: '2099-01-01T00:00:00.000Z' }
  };
}
const has = (html, action) => html.includes(`data-gov-action="${action}"`);
const archived = [{ policyId: '60000000-0000-4000-8000-000000000006', policyKey: 'old-policy', name: 'Old <policy>', archivedAt: '2026-09-24T00:00:00.000Z', versionCount: 3, keyInUse: false }];

/* A reader sees the state and none of the controls. */
{
  const html = ui.renderGovernanceInterface({ digitalTwin: twin(), access: access('rey', {}), archived });
  for (const action of ['deactivate-policy', 'archive-policy', 'restore-policy', 'discard-draft', 'withdraw-version', 'reset-governance']) {
    assert(!has(html, action), `a reader must not be offered ${action}`);
  }
  assert(html.includes('Archived policies'), 'the archive is readable by everyone who can read governance');
  assert(html.includes('Old &lt;policy&gt;') && !html.includes('Old <policy>'), 'archived names are escaped');
}

/* An author can clean up their own work, and only their own. */
{
  const own = ui.renderGovernanceInterface({ digitalTwin: twin(), access: access('alice', { author: true }) });
  assert(has(own, 'discard-draft'), 'the author of a draft can discard it');
  assert(has(own, 'withdraw-version'));
  assert(!has(own, 'deactivate-policy') && !has(own, 'archive-policy') && !has(own, 'reset-governance'));
  const other = ui.renderGovernanceInterface({ digitalTwin: twin(), access: access('bob', { author: true }) });
  assert(!has(other, 'discard-draft'), 'another author is not offered somebody else\'s draft');
}

/* An administrator gets the whole lifecycle, the reset apart from the rest. */
{
  const html = ui.renderGovernanceInterface({ digitalTwin: twin(), access: access('ada', { author: true, review: true, activate: true, administer: true }), archived });
  for (const action of ['deactivate-policy', 'archive-policy', 'restore-policy', 'discard-draft', 'withdraw-version', 'reset-governance']) {
    assert(has(html, action), `an administrator is offered ${action}`);
  }
  assert(!has(html, 'reactivate-policy'), 'a running policy offers to switch off, not to come back');
  assert(html.includes('Reset governance'));
  assert(html.indexOf('data-gov-action="reset-governance"') > html.indexOf('Notifications and signed evidence'),
    'the reset sits apart, after everything else on the page');
  assert(html.includes('Switched off'), 'the history names a switch-off for what it is');
}

/* Switched off: the card says so and offers the version that was running. */
{
  const html = ui.renderGovernanceInterface({
    digitalTwin: twin({ active: null, switchedOff: { versionId: ACTIVE, versionNumber: 1 } }),
    access: access('ada', { author: true, activate: true, administer: true })
  });
  assert(has(html, 'reactivate-policy'));
  assert(html.includes('Turn v1 back on'));
  assert(html.includes(`data-version-id="${ACTIVE}"`));
  assert(!has(html, 'deactivate-policy'), 'nothing to switch off');
  assert(html.includes('Off · was v1'));
}

/* A restore whose key is taken is drawn disabled, with the reason. */
{
  const html = ui.renderGovernanceInterface({
    digitalTwin: twin(), access: access('ada', { administer: true }),
    archived: [{ ...archived[0], keyInUse: true }]
  });
  assert(/data-gov-action="restore-policy"[^>]*disabled/.test(html));
  assert(html.includes('a current policy uses this key'));
}

/* Nothing to reset, no reset. */
{
  const empty = twin();
  empty.current = { policyCount: 0, returnedPolicyCount: 0, activePolicyCount: 0, policies: [] };
  const html = ui.renderGovernanceInterface({ digitalTwin: empty, access: access('ada', { administer: true, author: true }), archived });
  assert(!has(html, 'reset-governance'));
  assert(html.includes('1 archived policy can be restored below'));
}

console.log('governance lifecycle interface tests passed');
