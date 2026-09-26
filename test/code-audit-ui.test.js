'use strict';

/*
 * The audit's words outside the screen: the developer brief a reader hands
 * on, and the comparison with the last audit. Both carry rules, places,
 * reasons and fixes -- never what a file or a site returned.
 */

const assert = require('assert');
const { analyse } = require('../src/code-audit');
const { checkSite } = require('../src/site-check');
const ui = require('../public/code-audit-ui');

(async () => {
  const files = [
    { path: 'package.json', text: JSON.stringify({ name: 'demo', dependencies: { react: '*' } }) },
    { path: 'api/users.js', text: 'db.query(`SELECT * FROM users WHERE id = ${req.params.id}`);\n' }
  ];
  const result = {
    ...analyse({ files, paths: files.map(file => file.path) }),
    commitSha: 'c'.repeat(40),
    auditedAt: '2026-09-26T12:00:00.000Z',
    coverage: { read: 2, eligible: 2, packages: { declared: 1, checked: 1, unknown: 0, notChecked: 0 }, skipped: {} }
  };
  const site = {
    ...(await checkSite({
      url: 'https://demo.example.com',
      transport: async input => new URL(input.url).pathname === '/.env'
        ? { statusCode: 200, headers: { 'content-type': 'text/plain' }, body: 'SECRET_KEY=canary-value\n' }
        : new URL(input.url).pathname === '/'
          ? { statusCode: 200, headers: { 'content-type': 'text/html' }, body: '<!doctype html>' }
          : { statusCode: 404, headers: {}, body: '' }
    })),
    checkedAt: '2026-09-26T12:01:00.000Z'
  };

  /* Both halves, in order, each finding with its place, reason, fix and prompt. */
  const both = ui.brief(result, 'sandbox/demo (main)', site);
  assert(both.startsWith('# Security audit: sandbox/demo (main)\n'));
  assert(both.indexOf('A SQL statement is built by string interpolation') < both.indexOf('# Deployed site: https://demo.example.com'));
  assert.match(both, /## S1\. An environment file is served publicly/);
  assert.match(both, /- \*\*Where:\*\* `\/\.env`/);
  assert.match(both, /\| Strict-Transport-Security \| no \|/);
  assert(!/SELECT \* FROM|canary-value|SECRET_KEY/.test(both), 'the brief never carries what was read');
  assert(!/\n\n\n/.test(both), 'no runs of blank lines');

  /* A site alone -- a provider without a repository reader -- is still a brief. */
  const siteOnly = ui.brief(null, 'group/demo (main)', site);
  assert(siteOnly.includes('# Deployed site: https://demo.example.com'));
  assert(!siteOnly.includes('| Family |'));
  assert.strictEqual(ui.allPrompts(null), '');
  assert.match(ui.allPrompts(site), /^1\. On the deployed site \(\/\.env\): /);

  /* The comparison: identities only, new and resolved. */
  assert.strictEqual(ui.diff(result, null), null);
  const changed = ui.diff(result, { at: '2026-09-25T00:00:00.000Z', ids: [result.findings[0].id, 'f'.repeat(24)] });
  assert.strictEqual(changed.resolved, 1);
  assert.strictEqual(changed.newIds.size, result.findings.length - 1);
  assert.strictEqual(ui.storageKey('Sandbox/Demo'), 'nv_audit:sandbox/demo');

  console.log('code audit UI tests passed');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
