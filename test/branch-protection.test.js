'use strict';

/*
 * The provider's branch rules, read into one shape. Each provider is fed the
 * JSON its API answers with, so a change to how a field is read fails here;
 * what a restricted reader cannot see must come back unknown, never on.
 */

const assert = require('assert');
const { readBranchProtection, CONTROLS } = require('../src/branch-protection');

const fail = status => Object.assign(new Error(`status ${status}`), { status });
const reader = (routes, seen = []) => async path => {
  seen.push(path);
  if (!(path in routes)) throw fail(404);
  const value = routes[path];
  if (typeof value === 'number') throw fail(value);
  return value;
};
const states = result => Object.fromEntries(result.controls.map(control => [control.id, control.state]));

(async () => {
  assert.deepStrictEqual(CONTROLS.map(([id]) => id), ['review', 'checks', 'force-push', 'deletion', 'signed', 'linear', 'conversation', 'admins']);

  /* ---- GitHub: classic protection read in full ---------------------------------- */
  {
    const seen = [];
    const result = await readBranchProtection({
      provider: 'github', owner: 'acme', repo: 'api', webBase: 'https://github.com',
      read: reader({
        '': { default_branch: 'main' },
        '/branches/main': { protected: true },
        '/branches/main/protection': {
          required_pull_request_reviews: { required_approving_review_count: 2, require_code_owner_reviews: true, dismiss_stale_reviews: true },
          required_status_checks: { strict: true, contexts: ['ci', 'lint'], checks: [{ context: 'ci' }] },
          enforce_admins: { enabled: true },
          allow_force_pushes: { enabled: false },
          allow_deletions: { enabled: false },
          required_signatures: { enabled: false },
          required_linear_history: { enabled: true },
          required_conversation_resolution: { enabled: true }
        },
        '/rules/branches/main': []
      }, seen)
    });
    assert.strictEqual(result.branch, 'main', 'the default branch when none is named');
    assert.strictEqual(result.protected, true);
    assert.strictEqual(result.access, 'full');
    assert.deepStrictEqual(states(result), { review: 'on', checks: 'on', 'force-push': 'on', deletion: 'on', signed: 'off', linear: 'on', conversation: 'on', admins: 'on' });
    assert.strictEqual(result.controls[0].detail, '2 approvals, code owners, stale approvals dismissed');
    assert.strictEqual(result.controls[1].detail, '2 checks, branch must be up to date');
    assert.strictEqual(result.enforced, 7);
    assert.strictEqual(result.known, 8);
    assert.strictEqual(result.settingsUrl, 'https://github.com/acme/api/settings/branches');
    assert(seen.every(path => !/\?|token/i.test(path)), 'paths are relative and carry nothing but the branch');
  }

  /* ---- GitHub: a reader without administration sees rulesets, the rest is unknown ---- */
  {
    const result = await readBranchProtection({
      provider: 'github', owner: 'acme', repo: 'api', branch: 'release/2.4',
      read: reader({
        '/branches/release%2F2.4': { protected: true, protection: { required_status_checks: { contexts: ['build'] } } },
        '/branches/release%2F2.4/protection': 403,
        '/rules/branches/release%2F2.4': [
          { type: 'pull_request', ruleset_id: 7, parameters: { required_approving_review_count: 1, required_review_thread_resolution: true } },
          { type: 'non_fast_forward', ruleset_id: 7 },
          { type: 'deletion', ruleset_id: 9 }
        ]
      })
    });
    assert.strictEqual(result.access, 'partial');
    assert.deepStrictEqual(states(result), { review: 'on', checks: 'on', 'force-push': 'on', deletion: 'on', signed: 'unknown', linear: 'unknown', conversation: 'on', admins: 'unknown' });
    assert.deepStrictEqual(result.sources, ['2 rulesets']);
    assert.strictEqual(result.known, 5, 'unknown is never counted');
    assert.strictEqual(result.settingsUrl, null, 'no web base, no link');
  }

  /* ---- GitHub: an unprotected branch ------------------------------------------------ */
  {
    const result = await readBranchProtection({
      provider: 'github', owner: 'acme', repo: 'api', branch: 'main',
      read: reader({ '/branches/main': { protected: false }, '/rules/branches/main': [] })
    });
    assert.strictEqual(result.protected, false);
    assert.strictEqual(result.enforced, 0);
    assert(result.controls.every(control => control.state === 'off'));
  }

  /* ---- GitHub: a missing branch is the provider's error, not an empty reading ------- */
  await assert.rejects(readBranchProtection({ provider: 'github', owner: 'a', repo: 'b', branch: 'nope', read: reader({}) }), error => error.status === 404);
  await assert.rejects(readBranchProtection({ provider: 'github', owner: 'a', repo: 'b', branch: 'main',
    read: reader({ '/branches/main': { protected: true }, '/branches/main/protection': 500, '/rules/branches/main': [] }) }), error => error.status === 500,
    'a provider failure is not read as "no protection"');

  for (const provider of ['gitlab', 'gitea']) {
    let reads = 0;
    await assert.rejects(readBranchProtection({ provider, owner: 'acme', repo: 'api', branch: 'main',
      read: async () => { reads++; return {}; } }), error => error.code === 'BRANCH_RULES_UNSUPPORTED');
    assert.strictEqual(reads, 0, 'retired branch rule readers never contact the provider');
  }

  await assert.rejects(readBranchProtection({ provider: 'svn', owner: 'a', repo: 'b', branch: 'main', read: reader({}) }), error => error.status === 501);
  await assert.rejects(readBranchProtection({ provider: 'github', owner: 'a', repo: 'b', read: reader({ '': {} }) }), error => error.code === 'BRANCH_NOT_FOUND');

  console.log('branch protection tests passed');
})().catch(error => { console.error(error); process.exit(1); });
