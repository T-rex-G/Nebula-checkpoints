'use strict';
/*
 * The governance screen as the page draws it, as markup.
 *
 * The view is a React component, so a check of what it draws renders it: the
 * module is run against Node's own React (test/helpers/page-module.js) and
 * rendered to static HTML, which is the elements, attributes and words the
 * reader's browser receives on the first paint. Nothing of its text is read.
 */
const { createElement } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { loadPageModule } = require('./page-module');

const view = loadPageModule('apps/web/src/features/governance/GovernanceView.tsx', {});
const model = loadPageModule('apps/web/src/features/governance/governance.ts', {});

/* The whole screen for one input, as the page would draw it. */
function markup(input = {}) {
  return renderToStaticMarkup(createElement(view.GovernanceInterface, { input }));
}

/* A value made in the module's own context, as a plain value of this one: deepStrictEqual compares prototypes. */
const plain = value => JSON.parse(JSON.stringify(value));

/*
 * A screen with every part drawn: an administrator, a running policy and a
 * switched-off one, a draft, a version in review with its simulation, an
 * exception, both ledgers, archived policies, the inbox, exports and
 * webhooks. For checks that sweep the whole screen.
 */
function sample() {
  const POLICY = '10000000-0000-4000-8000-000000000001';
  const ACTIVE = '20000000-0000-4000-8000-000000000002';
  const PENDING = '30000000-0000-4000-8000-000000000003';
  const at = '2026-09-25T00:00:00.000Z';
  const review = { status: 'pending', requiredApprovals: 1, assignedCount: 0, approvalCount: 0 };
  return {
    now: Date.parse('2026-09-25T12:00:00.000Z'),
    access: {
      actor: { login: 'ada' }, execution: { kind: 'user', authMethod: 'oauth' },
      capabilities: { read: true, author: true, review: true, activate: true, administer: true },
      evidence: { status: 'current', expiresAt: '2099-01-01T00:00:00.000Z' }
    },
    digitalTwin: {
      schemaVersion: 1,
      scope: { owner: 'Acme', repo: 'Demo' },
      freshness: { status: 'partial', asOf: at, completeness: { policies: true, decisions: false } },
      current: {
        policyCount: 2, activePolicyCount: 1,
        policies: [
          { policyId: POLICY, policyKey: 'release-safety', name: 'Release safety', description: 'Protect releases', revision: 4, versionCount: 2,
            active: { versionId: ACTIVE, versionNumber: 1, documentHash: 'a'.repeat(64), enforcementMode: 'block' }, latestVersion: { review } },
          { policyId: 'p2', policyKey: 'old-gate', name: 'Old gate', revision: 2, versionCount: 1, active: null, switchedOff: { versionId: 'v9', versionNumber: 1 } }
        ]
      },
      proposed: {
        draftCount: 1, versionCount: 1,
        drafts: [{ draftId: 'd1', policyId: POLICY, revision: 2, authoredByLogin: 'ada', updatedAt: at }],
        versions: [{ policyId: POLICY, policyKey: 'release-safety', versionId: PENDING, versionNumber: 2, documentHash: 'b'.repeat(64), createdAt: at, review }]
      },
      effective: { activeExceptionCount: 1 },
      history: {
        decisions: [{ seq: 2, action: 'file.write', enforcementOutcome: 'block', effectiveEffect: 'deny', evaluatedAt: at, decisionHash: 'c'.repeat(64) }],
        activations: [{ seq: 1, policyId: POLICY, versionId: ACTIVE, action: 'activate', actorLogin: 'ada', createdAt: at }],
        exceptions: [{ exceptionId: 'x1', policyId: POLICY, versionId: ACTIVE, kind: 'exception', action: 'file.write', state: 'pending', expiresAt: at, createdAt: at }],
        nextBeforeDecisionSeq: 1
      },
      readModelHash: 'd'.repeat(64)
    },
    simulation: { policyId: POLICY, versionId: PENDING, report: { activationReadiness: { eligible: true }, simulationHash: 'e'.repeat(64) } },
    verification: { valid: true, complete: true, checked: 2 },
    archived: [{ policyId: 'a1', policyKey: 'retired', name: 'Retired', archivedAt: at, versionCount: 3 }],
    delivery: {
      preferences: { enabled: true, lastReadSeq: 0 },
      notifications: { events: [{ seq: 1, eventType: 'policy.activated', eventHash: 'f'.repeat(64), createdAt: at }] },
      exports: [{ exportId: 'e1', format: 'json', eventCount: 2, envelopeHash: '1'.repeat(64), createdAt: at }],
      webhooks: [{ webhookId: 'w1', name: 'Alerts', url: 'https://hooks.example.com/governance', eventTypes: ['policy.activated'], enabled: true }]
    },
    view: {}
  };
}

module.exports = { markup, model, plain, sample };
