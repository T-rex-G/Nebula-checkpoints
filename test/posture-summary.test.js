'use strict';

/*
 * What the Overview's security posture says, decided from what the stores
 * returned. Each case is a way the figures could lie: counting a decision as
 * open work, counting a waiver as a finding, calling a store that did not
 * answer clean, or ranking a repository with more warnings above one with a
 * critical finding.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { summarizePosture, EXPOSURE_CATEGORY, TOP_REPOSITORIES } = require('../src/posture-summary');

const NOW = Date.parse('2026-10-10T12:00:00.000Z');
const audit = {
  weeks: 12,
  audits: [
    { owner: 'Acme', repo: 'Shop', ref: 'main', auditedAt: '2026-10-09T10:00:00.000Z', score: 62, grade: 'D', coverageComplete: true },
    { owner: 'Acme', repo: 'Api', ref: 'main', auditedAt: '2026-10-08T10:00:00.000Z', score: 91, grade: 'A', coverageComplete: false }
  ],
  findings: [
    { owner: 'Acme', repo: 'Shop', severity: 'critical', category: 'code', state: 'open', count: 1 },
    { owner: 'Acme', repo: 'Shop', severity: 'serious', category: 'dependencies', state: 'open', count: 3 },
    { owner: 'Acme', repo: 'Shop', severity: 'serious', category: 'code', state: 'accepted-risk', count: 2 },
    { owner: 'Acme', repo: 'Shop', severity: 'warning', category: 'code', state: 'false-positive', count: 1 },
    { owner: 'Acme', repo: 'Shop', severity: 'warning', category: 'hygiene', state: 'waived', count: 9 },
    { owner: 'Acme', repo: 'Api', severity: 'warning', category: 'hygiene', state: 'open', count: 5 }
  ],
  opened: [{ weeksAgo: 0, count: 2 }, { weeksAgo: 3, count: 4 }],
  fixed: [{ weeksAgo: 0, count: 1 }, { weeksAgo: 11, count: 2 }, { weeksAgo: 12, count: 7 }],
  timeToFix: { windowDays: 90, all: { count: 3, medianDays: 4.5 }, critical: { count: 1, medianDays: 2 }, serious: { count: 2, medianDays: 6 }, warning: { count: 0, medianDays: null } }
};
const exposure = {
  available: true,
  repositories: [
    { owner: 'acme', repo: 'shop', scannedAt: '2026-10-07T10:00:00.000Z', partial: false, open: { critical: 1, serious: 0, warning: 0 } },
    { owner: 'Acme', repo: 'Docs', scannedAt: '2026-10-06T10:00:00.000Z', partial: true, open: { critical: 0, serious: 0, warning: 0 } }
  ]
};
const exposureTrend = { weeks: 12, opened: [{ weeksAgo: 0, count: 1 }], fixed: [{ weeksAgo: 2, count: 1 }], accepted: 1 };
const merges = { allow: 4, warn: 1, block: 2 };

/* Everything measured. */
{
  const summary = summarizePosture({ audit, exposure, exposureTrend, merges, now: NOW, weeks: 12 });
  assert.deepStrictEqual(summary.sources, { audit: 'measured', exposure: 'measured', governance: 'measured' });
  assert.deepStrictEqual(summary.open, { critical: 2, serious: 3, warning: 5, total: 10 },
    'open is the audits\' open findings and the scans\' exposed credentials; decisions and waivers are not open work');
  assert.deepStrictEqual(summary.triaged, { acceptedRisk: 3, falsePositive: 1 }, 'accepted risks from both systems, false positives from the audits');
  assert.deepStrictEqual(summary.week, { opened: 3, fixed: 1, gated: 2, warned: 1 }, 'this week is the newest window; gated is what governance blocked');
  assert.deepStrictEqual(summary.window, { opened: 7, fixed: 4 }, 'the window total leaves out anything older than twelve weeks');
  assert.strictEqual(summary.trend.length, 12);
  assert.deepStrictEqual(summary.trend[0], { weeksAgo: 11, opened: 0, fixed: 2 }, 'the series runs oldest first');
  assert.deepStrictEqual(summary.trend[11], { weeksAgo: 0, opened: 3, fixed: 1 });
  assert.deepStrictEqual(summary.trend[9], { weeksAgo: 2, opened: 0, fixed: 1 });
  assert.strictEqual(summary.timeToFix.all.medianDays, 4.5);
  assert.deepStrictEqual(summary.categories.map(entry => [entry.category, entry.total]), [
    ['hygiene', 5], ['dependencies', 3], ['code', 1], [EXPOSURE_CATEGORY, 1]
  ], 'categories by open count; a leaked credential is its own category');
  assert.deepStrictEqual(summary.top.map(entry => `${entry.owner}/${entry.repo}`), ['Acme/Shop', 'Acme/Api'],
    'a repository with a critical finding outranks one with more warnings');
  const shop = summary.repositories.find(entry => entry.repo === 'Shop');
  assert.deepStrictEqual(shop.open, { critical: 2, serious: 3, warning: 0, total: 5 }, 'one repository, whatever case each system wrote its name in');
  assert.strictEqual(shop.audit.grade, 'D');
  assert.strictEqual(shop.exposure.at, '2026-10-07T10:00:00.000Z');
  const docs = summary.repositories.find(entry => entry.repo === 'Docs');
  assert.deepStrictEqual([docs.audit, docs.exposure.partial, docs.open.total], [null, true, 0], 'scanned but never audited is still listed');
  assert.ok(!summary.top.some(entry => entry.repo === 'Docs'), 'nothing open is not a top repository');
  assert.strictEqual(summary.generatedAt, new Date(NOW).toISOString());
}

/* A store that did not answer is unmeasured, never zero. */
{
  const summary = summarizePosture({ audit: null, exposure: null, exposureTrend: null, merges: null, now: NOW });
  assert.deepStrictEqual(summary.sources, { audit: 'unavailable', exposure: 'unavailable', governance: 'unavailable' });
  assert.strictEqual(summary.week.gated, null, 'merges governance could not count are not "none gated"');
  assert.strictEqual(summary.timeToFix, null);
  assert.deepStrictEqual(summary.repositories, []);
  const partial = summarizePosture({ audit, exposure, exposureTrend: null, merges, now: NOW });
  assert.strictEqual(partial.sources.exposure, 'partial', 'open credentials without their trend is a partial reading');
  assert.deepStrictEqual(partial.triaged, { acceptedRisk: 2, falsePositive: 1 });
  const down = summarizePosture({ audit, exposure: { available: false, repositories: [] }, now: NOW });
  assert.strictEqual(down.sources.exposure, 'unavailable');
}

/* The window is bounded and the ranking is capped. */
{
  const many = {
    ...audit,
    findings: Array.from({ length: TOP_REPOSITORIES + 3 }, (_, index) => ({
      owner: 'Acme', repo: `R${index}`, severity: 'warning', category: 'code', state: 'open', count: index + 1
    }))
  };
  const summary = summarizePosture({ audit: many, now: NOW, weeks: 4 });
  assert.strictEqual(summary.trend.length, 4);
  assert.strictEqual(summary.top.length, TOP_REPOSITORIES);
  assert.strictEqual(summary.top[0].repo, `R${TOP_REPOSITORIES + 2}`, 'most open first among equals in severity');
  assert.strictEqual(summarizePosture({ audit, now: NOW, weeks: 99 }).weeks, 12, 'an unreasonable window falls back to twelve weeks');
  const noisy = summarizePosture({ audit: { ...audit, opened: [{ weeksAgo: -1, count: 5 }, { weeksAgo: 1.5, count: 5 }, { weeksAgo: 1, count: -3 }] }, now: NOW });
  assert.strictEqual(noisy.window.opened, 0, 'a malformed bucket is not counted');
}

/*
 * The route is gated by its own capability, authenticated, never cached, and
 * never reads the session's credential: everything it draws is already in
 * the database, keyed by the identity.
 */
{
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const start = server.indexOf("app.get('/api/workspace/security-posture'");
  assert(start > 0, 'the security posture route must exist');
  const route = server.slice(start, server.indexOf('\n});', start));
  assert.match(route, /providerSessionAccess, capabilityAccess\('workspace\.posture'\), auth,/);
  assert.match(route, /Cache-Control', 'no-store'/);
  assert.doesNotMatch(route, /\.token\b/, 'the route never touches the credential');
  assert.doesNotMatch(route, /\bgh\(/, 'the route fetches nothing from the provider');
  assert.match(route, /available: false, reason: 'not-configured'/, 'no database is said, not drawn as a clean workspace');
}

console.log('posture summary tests passed');
