'use strict';

/*
 * The findings inbox, decided from what the stores returned. Each case is a
 * way the list could mislead: a decision read as open work, a finding that
 * came back after a fix read as ordinary, a credential removed from the tree
 * read as gone, a credential-shaped path shown in full, or a store that did
 * not answer read as an empty inbox.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildInbox, STATES, EXPOSURE_KIND } = require('../src/findings-inbox');

const NOW = Date.parse('2026-10-10T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const at = days => new Date(NOW - days * DAY).toISOString();
const auditFinding = (id, overrides = {}) => ({
  id, rule: 'SEC-011', title: 'A shell command is built by string interpolation', category: 'code', severity: 'serious',
  verdict: 'needs-validation', path: `src/${id}.js`, line: 4, package: null, exploited: false,
  firstSeenAt: at(30), owner: 'Acme', repo: 'Shop', ref: 'main', auditedAt: at(1),
  decision: null, timesFixed: 0, regressedAfter: null, ...overrides
});
const audit = {
  truncated: false,
  findings: [
    auditFinding('a'.repeat(24)),
    auditFinding('b'.repeat(24), { severity: 'critical', firstSeenAt: at(2) }),
    auditFinding('c'.repeat(24), { timesFixed: 1, regressedAfter: at(10), firstSeenAt: at(5) }),
    auditFinding('d'.repeat(24), { severity: 'critical', decision: { disposition: 'accepted-risk', reason: 'low-impact', expiresAt: at(-30) } }),
    auditFinding('e'.repeat(24), {
      category: 'dependencies', rule: 'DEP-003', path: 'package-lock.json',
      package: { ecosystem: 'npm', name: 'jquery', version: '3.4.1', fixed: '3.5.0', cves: ['CVE-2020-11023'] }, exploited: true
    })
  ]
};
const exposure = {
  truncated: true,
  findings: [
    { fingerprint: 'f1', scope: { owner: 'Acme', repo: 'Api' }, rule: 'github-token', path: 'config/ghp_secretlooking/token.txt', disposition: 'open', firstObservedAt: at(1) },
    { fingerprint: 'f2', scope: { owner: 'Acme', repo: 'Api' }, rule: 'aws-access-key', path: 'old.env', disposition: 'removed-from-tree', firstObservedAt: at(40) },
    { fingerprint: 'f3', scope: { owner: 'Acme', repo: 'Api' }, rule: 'slack-webhook', path: 'hook.txt', disposition: 'accepted-risk', dispositionAt: at(3), firstObservedAt: at(50) }
  ]
};
const severityOf = rule => ({ 'github-token': 'critical', 'aws-access-key': 'serious', 'slack-webhook': 'warning' })[rule];
const displayPath = value => value.replace(/ghp_[^/]+/, '[withheld]');

/*
 * Undated findings tie on age, and a tie falls through to the key -- in either
 * input order. A comparator that called both of two undated findings the
 * older one left the order to the sort and the input, so the list and its
 * pages could reorder between reloads.
 */
{
  const undated = [auditFinding('y'.repeat(24), { firstSeenAt: null }), auditFinding('x'.repeat(24), { firstSeenAt: null })];
  const forward = buildInbox({ audit: { truncated: false, findings: undated }, exposure: null, now: NOW });
  const backward = buildInbox({ audit: { truncated: false, findings: [...undated].reverse() }, exposure: null, now: NOW });
  assert.deepStrictEqual(forward.findings.map(item => item.id), ['x'.repeat(24), 'y'.repeat(24)], 'undated findings fall back to their key');
  assert.deepStrictEqual(backward.findings.map(item => item.id), forward.findings.map(item => item.id), 'the order does not depend on the input');
  /* A dated finding still comes before an undated one of the same severity and state. */
  const mixed = buildInbox({ audit: { truncated: false, findings: [auditFinding('z'.repeat(24), { firstSeenAt: null }), auditFinding('w'.repeat(24), { firstSeenAt: at(20) })] }, exposure: null, now: NOW });
  assert.deepStrictEqual(mixed.findings.map(item => item.id), ['w'.repeat(24), 'z'.repeat(24)]);
}

{
  const inbox = buildInbox({ audit, exposure, now: NOW, severityOf, displayPath });
  assert.deepStrictEqual(inbox.sources, { audit: 'measured', exposure: 'measured' });
  assert.strictEqual(inbox.truncated, true, 'a store that held more than it returned is said');
  assert.strictEqual(inbox.total, 8);
  const order = inbox.findings.map(item => `${item.source}:${item.severity}:${item.state}`);
  assert.deepStrictEqual(order, [
    'audit:critical:new',
    'exposure:critical:new',
    'audit:serious:regressed',
    'exposure:serious:open',
    'audit:serious:open',
    'audit:serious:open',
    'audit:critical:accepted-risk',
    'exposure:warning:accepted-risk'
  ], 'undecided first, most severe first, a regression before the rest of its severity, the oldest first among equals, decisions last');
  const regressed = inbox.findings.find(item => item.state === 'regressed');
  assert.deepStrictEqual([regressed.timesFixed, regressed.regressedAfter], [1, at(10)]);
  const token = inbox.findings.find(item => item.id === 'f1');
  assert.strictEqual(token.path, 'config/[withheld]/token.txt', 'a credential-shaped path is masked');
  assert.strictEqual(token.kind, EXPOSURE_KIND);
  const removed = inbox.findings.find(item => item.id === 'f2');
  assert.deepStrictEqual([removed.state, removed.historyOnly], ['open', true], 'removed from the tree is still open: the history holds it');
  const dependency = inbox.findings.find(item => item.kind === 'dependencies');
  assert.deepStrictEqual(dependency.package, { ecosystem: 'npm', name: 'jquery', version: '3.4.1', fixed: '3.5.0' });
  assert.deepStrictEqual([dependency.cves, dependency.exploited], [['CVE-2020-11023'], true]);
  assert.deepStrictEqual(inbox.counts.bySeverity, { critical: 2, serious: 4 }, 'counts by severity leave out what a decision covers');
  assert.deepStrictEqual(inbox.counts.byState, { new: 2, regressed: 1, open: 3, 'accepted-risk': 2 });
  assert.deepStrictEqual(inbox.counts.byRepository, { 'Acme/Shop': 4, 'Acme/Api': 2 });
  assert.deepStrictEqual(inbox.counts.byKind, { code: 3, 'leaked-credentials': 2, dependencies: 1 });
  assert.ok(inbox.findings.every(item => STATES.includes(item.state)));
  assert.strictEqual(new Set(inbox.findings.map(item => item.key)).size, inbox.total, 'every finding has its own key');
}

/* A store that did not answer is unmeasured, not empty. */
{
  const inbox = buildInbox({ audit: null, exposure: null, now: NOW });
  assert.deepStrictEqual(inbox.sources, { audit: 'unavailable', exposure: 'unavailable' });
  assert.strictEqual(inbox.total, 0);
  const half = buildInbox({ audit, exposure: null, now: NOW });
  assert.deepStrictEqual(half.sources, { audit: 'measured', exposure: 'unavailable' });
  assert.strictEqual(half.truncated, false);
}

/* The routes: gated, uncached, credential-free, provider-free where they should be. */
{
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const slice = name => {
    const start = server.indexOf(name);
    assert(start > 0, `${name} must exist`);
    return server.slice(start, server.indexOf('\n});', start));
  };
  const inbox = slice("app.get('/api/workspace/findings'");
  assert.match(inbox, /providerSessionAccess, capabilityAccess\('findings\.inbox'\), auth,/);
  assert.match(inbox, /Cache-Control', 'no-store'/);
  assert.doesNotMatch(inbox, /\.token\b/);
  assert.doesNotMatch(inbox, /\bgh\(/, 'the inbox fetches nothing from the provider');
  assert.match(inbox, /displayPath: safeDisplayPath/, 'exposure paths are masked on the server');
  const owners = slice("app.get('/api/repo/:owner/:repo/codeowners'");
  assert.match(owners, /providerSessionAccess, alphaRepositoryAccess, capabilityAccess\('file\.read'\), auth,/);
  assert.match(owners, /codeowners\.serialize\(codeowners\.parse\(text\)\)/, 'patterns and owners only leave the server');
}

console.log('findings inbox tests passed');
