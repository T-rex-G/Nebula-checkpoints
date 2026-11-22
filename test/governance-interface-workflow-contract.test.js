'use strict';
/*
 * Every governance workflow reaches its own route, driven through
 * features/governance/governance-actions.ts: each write carries a fresh
 * idempotency key, and an activation forgets the simulation it used, since
 * the read model it was made against is no longer the authoritative one.
 * JSON inputs pass the module's bounded parser: test/e2e/governance-lifecycle.spec.js
 * refuses each malformed one before a request.
 */
const assert = require('assert');
const crypto = require('crypto');
const { createGovernance } = require('../apps/web/src/features/governance/governance-actions.ts');

const sent = [];
const inputs = {
  '#govPolicyKey': 'release', '#govPolicyName': 'Release', '#govPolicyDescription': '',
  '#govDraftDocument': '{}', '#govDraftApproval': '{}', '#govEditDocument': '{}', '#govEditApproval': '{}',
  '#govTemplateId': 't1', '#govBaselineKey': 'baseline', '#govBaselineName': 'Baseline',
  '#govSimulationRequest': '{}', '#govReviewRationale': 'fine', '#govActivationReason': 'ready',
  '#govExceptionKind': 'exception', '#govExceptionAction': 'file.write', '#govExceptionRules': 'r1', '#govExceptionTarget': '{"branch":"main"}',
  '#govExceptionExpires': '2026-12-01T10:00', '#govExceptionReason': 'hotfix', '#govExceptionDecision': 'approve', '#govExceptionDecisionReason': 'ok',
  '#govExceptionRevokeReason': 'done'
};
const state = {
  work: { owner: 'acme', repo: 'demo', branch: 'main', default_branch: 'main' },
  governance: { digitalTwin: { current: { policies: [{ policyId: 'p1', name: 'Release', revision: 2 }] } }, delivery: {} }
};
function answer(path, method) {
  if (/\/templates$/.test(path)) return { templates: [{ templateId: 't1', name: 'Template' }] };
  if (/\/baselines\/generate$/.test(path)) return { baseline: { templateId: 't1', document: {}, approvalPolicy: {} } };
  if (/\/policies$/.test(path) && method === 'POST') return { policy: { policyId: 'p2' } };
  if (/\/drafts\/d1$/.test(path) && method === 'GET') return { draft: { revision: 1, document: {} } };
  if (/\/simulate$/.test(path)) return { simulation: { activationReadiness: { eligible: true }, simulationHash: 'h' } };
  if (/\/digital-twin/.test(path)) return { digitalTwin: state.governance.digitalTwin };
  return {};
}
const governance = createGovernance({
  state,
  mutate: change => change(state.governance),
  api: async (path, init = {}) => { sent.push({ path, method: init.method || 'GET', key: init.headers && init.headers['Idempotency-Key'] }); return answer(path, init.method || 'GET'); },
  modal: async () => true, toast() {}, stepUp: async () => null,
  $: selector => (selector in inputs ? { value: inputs[selector] } : null),
  doc: { createElement: () => ({}), body: { appendChild() {} }, activeElement: null },
  storage: () => ({ getItem: () => null, setItem() {} }),
  draw() {}, requestAnimationFrame: run => run(), setTimeout: () => 0, clearTimeout() {},
  now: () => Date.UTC(2026, 10, 17), randomId: () => crypto.randomUUID(), cssEscape: value => value
});

const base = '/api/repo/acme/demo/governance';
const workflows = [
  ['create-policy', {}, [['POST', `${base}/policies`, 'policy-create']]],
  ['generate-baseline', {}, [['GET', `${base}/templates`], ['POST', `${base}/baselines/generate`], ['POST', `${base}/policies`, 'baseline-policy-create'], ['POST', `${base}/policies/p2/drafts`, 'baseline-draft-create']]],
  ['new-draft', { policyId: 'p1' }, [['POST', `${base}/policies/p1/drafts`, 'draft-create']]],
  ['edit-draft', { policyId: 'p1', draftId: 'd1' }, [['GET', `${base}/policies/p1/drafts/d1`], ['PATCH', `${base}/policies/p1/drafts/d1`, 'draft-update']]],
  ['validate-draft', { policyId: 'p1', draftId: 'd1' }, [['POST', `${base}/policies/p1/drafts/d1/validate`]]],
  ['submit-draft', { policyId: 'p1', draftId: 'd1', revision: '1' }, [['POST', `${base}/policies/p1/drafts/d1/submit`, 'draft-submit']]],
  ['simulate', { policyId: 'p1', versionId: 'v1' }, [['POST', `${base}/policies/p1/versions/v1/simulate`]]],
  ['claim-review', { policyId: 'p1', versionId: 'v1' }, [['POST', `${base}/policies/p1/versions/v1/reviewers/me`, 'review-claim']]],
  ['approve', { policyId: 'p1', versionId: 'v1' }, [['POST', `${base}/policies/p1/versions/v1/decisions`, 'review-approve']]],
  ['reject', { policyId: 'p1', versionId: 'v1' }, [['POST', `${base}/policies/p1/versions/v1/decisions`, 'review-reject']]],
  ['activate', { policyId: 'p1', versionId: 'v1' }, [['POST', `${base}/policies/p1/versions/v1/activate`, 'policy-activate']]],
  ['rollback', { policyId: 'p1', versionId: 'v0' }, [['POST', `${base}/policies/p1/versions/v0/simulate`], ['POST', `${base}/policies/p1/versions/v0/rollback`, 'policy-rollback']]],
  ['request-exception', { policyId: 'p1', versionId: 'v1' }, [['POST', `${base}/policies/p1/versions/v1/exceptions`, 'exception-request']]],
  ['decide-exception', { exceptionId: 'x1' }, [['POST', `${base}/exceptions/x1/decision`, 'exception-decision']]],
  ['revoke-exception', { exceptionId: 'x1' }, [['POST', `${base}/exceptions/x1/revoke`, 'exception-revoke']]]
];

(async () => {
  const keys = new Set();
  for (const [action, data, expected] of workflows) {
    sent.length = 0;
    await governance.handlers[action]({ dataset: data });
    const asked = sent.filter(request => !/\/(digital-twin|notifications|exports|webhooks|archive)/.test(request.path));
    assert.deepStrictEqual(asked.map(request => [request.method, request.path]), expected.map(([method, path]) => [method, path]), action);
    expected.forEach(([, , key], index) => {
      if (!key) { assert.strictEqual(asked[index].key, undefined, `${action}: a read carries no key`); return; }
      assert.match(asked[index].key, new RegExp(`^governance-ui:${key}:[0-9a-f-]{36}$`), action);
      assert(!keys.has(asked[index].key), `${action}: every write has its own idempotency key`);
      keys.add(asked[index].key);
    });
    if (action === 'activate') {
      assert.strictEqual(state.governance.simulation, null, 'authoritative read-model changes must invalidate stale simulation evidence');
      state.governance.digitalTwin = { current: { policies: [{ policyId: 'p1', name: 'Release', revision: 2 }] } };
    }
  }
  console.log('governance interface workflow contract tests passed');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
