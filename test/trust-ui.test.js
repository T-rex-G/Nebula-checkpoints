'use strict';

/*
 * The repository's trust summary and the public error, decided before they
 * are drawn (apps/web/src/features/trust/trust-ui.ts). Both put a server's
 * and a provider's words in front of a reader, so what is checked is what a
 * reader could be misled by: a credential shown, a state the registry never
 * named shown as evidence, a standing that hides the weakest field, a failure
 * that does not say whether anything changed.
 */

const assert = require('node:assert/strict');
const trust = require('../apps/web/src/features/trust/trust-ui.ts');

const cases = [];
const check = (name, run) => cases.push([name, run]);

check('a value shown to a reader carries no credential, and is cut to its length', () => {
  assert.equal(trust.safeValue('postgres://user:pw@db.example:5432/nv refused', 'x'), '[redacted] refused');
  assert.equal(trust.safeValue('postgresql://a/b', 'x'), '[redacted]');
  for (const token of ['ghp_0123456789abcdef', 'gho_x', 'ghu_x', 'ghs_x', 'ghr_x', 'github_pat_11ABC']) {
    assert.equal(trust.safeValue(`used ${token} here`, 'x'), 'used [redacted] here', token);
  }
  assert.equal(trust.safeValue('Token=abc123, Password: hunter2; secret=s3', 'x'), 'Token=[redacted], Password=[redacted]; secret=[redacted]');
  assert.equal(trust.safeValue('a'.repeat(700), 'x').length, 600);
  assert.equal(trust.safeValue('a'.repeat(700), 'x', 160).length, 160);
  for (const absent of [null, undefined, '']) assert.equal(trust.safeValue(absent, 'fallback'), 'fallback');
  assert.equal(trust.safeValue(0, 'fallback'), '0', 'a zero is a value');
});

check('only a state the registry names is shown as evidence', () => {
  for (const state of ['Provider-verified', 'Deterministic', 'Inferred', 'Stale', 'Unavailable']) {
    assert.equal(trust.evidenceName(state), state);
    assert.equal(trust.EVIDENCE_MARKS[state].length, 2, `${state} is a ring and its middle`);
  }
  for (const other of ['provider-verified', 'Verified', '', null, undefined, 'constructor', '__proto__']) {
    assert.equal(trust.evidenceName(other), 'Unavailable', String(other));
  }
  const middles = new Set(Object.values(trust.EVIDENCE_MARKS).map(paths => paths[1]));
  assert.equal(middles.size, 5, 'five marks, told apart by their middles');
  assert.equal(new Set(Object.values(trust.EVIDENCE_MARKS).map(paths => paths[0])).size, 1, 'on one ring');
});

check('the summary reads each field as text with the evidence behind it, in the page\'s order', () => {
  const view = trust.summaryView({
    connection: { text: 'Connected 2m ago', evidenceState: 'Provider-verified' },
    pipeline: { text: 'ghp_secret leaked', evidenceState: 'Inferred' },
    risk: { evidenceState: 'Nonsense' },
    announcement: 'Trust summary for acme/web.'
  });
  assert.deepEqual(view.fields.map(field => [field.id, field.label, field.text, field.evidence]), [
    ['trustConnection', 'Connection freshness', 'Connected 2m ago', 'Provider-verified'],
    ['trustPipeline', 'Application and evidence health', '[redacted] leaked', 'Inferred'],
    ['trustRisk', 'Risk or governance issue', 'No verified result is available.', 'Unavailable'],
    ['trustAction', 'Recommended next action', 'No verified result is available.', 'Unavailable'],
    ['trustEvidence', 'Supporting evidence', 'No verified result is available.', 'Unavailable']
  ]);
  assert.equal(view.announcement, 'Trust summary for acme/web.');
  assert.equal(trust.summaryView(null).announcement, 'Repository trust summary updated.');
  assert.equal(trust.summaryView('nonsense').fields.length, 5);
});

check('the standing counts states weakest first, and is named for the weakest', () => {
  assert.deepEqual(trust.rollup(['Provider-verified', 'Stale', 'Provider-verified', 'Inferred']),
    { text: '1 stale · 1 inferred · 2 provider-verified', worst: 'Stale' });
  assert.deepEqual(trust.rollup(['Deterministic']), { text: '1 deterministic', worst: 'Deterministic' });
  assert.deepEqual(trust.rollup([]), { text: 'Not measured', worst: 'Unavailable' }, 'nothing measured is not a clean standing');
  assert.deepEqual(trust.ROLLUP_ORDER, ['Unavailable', 'Stale', 'Inferred', 'Deterministic', 'Provider-verified']);
});

check('a failed action says what happened, whether anything changed, where things stand and what to do next', () => {
  const view = trust.errorView({
    message: 'Branch protection refused the push (token=abc).',
    providerChanged: false,
    safeState: 'Nothing was written.',
    nextAction: 'Open a pull request instead.',
    correlationId: 'nvx-0123456789abcdef',
    code: 'BRANCH_PROTECTED'
  });
  assert.deepEqual(view, {
    message: 'Branch protection refused the push (token=[redacted]',
    providerChanged: 'no',
    safeState: 'Nothing was written.',
    nextAction: 'Open a pull request instead.',
    correlationId: 'nvx-0123456789abcdef',
    copyable: true,
    code: 'BRANCH_PROTECTED'
  });
  const bare = trust.errorView(new Error(''));
  assert.deepEqual(bare, {
    message: 'The request could not be completed.',
    providerChanged: 'unknown',
    safeState: 'No verified change was applied.',
    nextAction: 'Retry, or share the correlation ID with support.',
    correlationId: 'Unavailable',
    copyable: false,
    code: 'UNSPECIFIED'
  }, 'nothing said is said as such, and there is no ID to copy');
  assert.equal(trust.errorView(new Error('Repository not found')).message, 'Repository not found');
  assert.deepEqual([true, 'yes', false, 'no', 'maybe', null].map(trust.providerChangeText), ['yes', 'yes', 'no', 'no', 'unknown', 'unknown']);
  assert.equal(trust.errorView({ correlationId: 'x'.repeat(300) }).correlationId.length, 160);
  assert.equal(trust.errorView({ code: 'C'.repeat(300) }).code.length, 120);
});

let failed = 0;
for (const [name, run] of cases) {
  try {
    run();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok - ${name}\n${error.stack}`);
  }
}
if (failed) {
  console.error(`${failed} of ${cases.length} trust checks failed`);
  process.exit(1);
}
console.log(`trust: ${cases.length} checks passed`);
