'use strict';

/*
 * The findings inbox: every open finding across the workspace, from the audits
 * and the exposure scans, in one list a person can work through.
 *
 * Pure: the route hands in what the two stores returned (null for a store that
 * could not answer) and this decides each finding's state and the order they
 * are read in. Nothing here reads a repository. A path from an exposure scan
 * is shown through the same masking the findings screen uses, because a path
 * can itself carry the credential it leads to.
 *
 * States, in the order a person should meet them:
 *   regressed  fixed once on this branch and seen again since
 *   new        first seen in the last seven days
 *   open       everything else still open
 *   accepted-risk / false-positive   a team decision covers it
 * An exposure finding removed from the tree is still open -- its history
 * holds it -- and says so with `historyOnly`.
 */

const SEVERITY_RANK = Object.freeze({ critical: 0, serious: 1, warning: 2 });
const STATE_RANK = Object.freeze({ regressed: 0, new: 1, open: 2, 'accepted-risk': 3, 'false-positive': 4 });
const STATES = Object.freeze(Object.keys(STATE_RANK));
const NEW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const EXPOSURE_KIND = 'leaked-credentials';

function ageDays(at, now) {
  const time = Date.parse(at || '');
  return Number.isFinite(time) ? Math.max(0, Math.floor((now - time) / DAY_MS)) : null;
}

function auditItem(finding, now) {
  const decided = finding.decision && finding.decision.disposition;
  const first = Date.parse(finding.firstSeenAt || '');
  const state = decided || (finding.regressedAfter ? 'regressed'
    : Number.isFinite(first) && now - first <= NEW_WINDOW_MS ? 'new' : 'open');
  return {
    key: `audit:${String(finding.owner).toLowerCase()}/${String(finding.repo).toLowerCase()}:${finding.id}`,
    source: 'audit',
    id: finding.id,
    owner: finding.owner,
    repo: finding.repo,
    ref: finding.ref || null,
    rule: finding.rule,
    title: finding.title || finding.rule,
    kind: finding.category || 'other',
    severity: SEVERITY_RANK[finding.severity] === undefined ? 'warning' : finding.severity,
    state,
    path: finding.path || null,
    line: Number.isInteger(finding.line) ? finding.line : null,
    package: finding.package ? {
      ecosystem: finding.package.ecosystem, name: finding.package.name,
      version: finding.package.version, fixed: finding.package.fixed || null
    } : null,
    cves: finding.package && Array.isArray(finding.package.cves) ? finding.package.cves.slice(0, 6) : [],
    exploited: finding.exploited === true,
    verdict: finding.verdict || null,
    firstSeenAt: finding.firstSeenAt || null,
    ageDays: ageDays(finding.firstSeenAt, now),
    timesFixed: Number(finding.timesFixed) || 0,
    regressedAfter: finding.regressedAfter || null,
    decision: finding.decision || null,
    historyOnly: false
  };
}

function exposureItem(finding, now, { severityOf, displayPath }) {
  const scope = finding.scope || {};
  const accepted = finding.disposition === 'accepted-risk';
  const first = Date.parse(finding.firstObservedAt || '');
  return {
    key: `exposure:${String(scope.owner).toLowerCase()}/${String(scope.repo).toLowerCase()}:${finding.fingerprint}`,
    source: 'exposure',
    id: finding.fingerprint,
    owner: scope.owner,
    repo: scope.repo,
    ref: null,
    rule: finding.rule,
    title: null,
    kind: EXPOSURE_KIND,
    severity: (() => {
      const severity = severityOf(finding.rule);
      return SEVERITY_RANK[severity] === undefined ? 'serious' : severity;
    })(),
    state: accepted ? 'accepted-risk' : Number.isFinite(first) && now - first <= NEW_WINDOW_MS ? 'new' : 'open',
    path: finding.path ? displayPath(finding.path) : null,
    line: null,
    package: null,
    cves: [],
    exploited: false,
    verdict: null,
    firstSeenAt: finding.firstObservedAt || null,
    ageDays: ageDays(finding.firstObservedAt, now),
    timesFixed: 0,
    regressedAfter: null,
    decision: accepted ? { disposition: 'accepted-risk', reason: null, expiresAt: null, decidedAt: finding.dispositionAt || null } : null,
    historyOnly: finding.disposition === 'removed-from-tree'
  };
}

function compare(a, b) {
  const decidedA = a.decision ? 1 : 0;
  const decidedB = b.decision ? 1 : 0;
  return decidedA - decidedB
    || SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    || STATE_RANK[a.state] - STATE_RANK[b.state]
    || (b.ageDays === null ? -1 : a.ageDays === null ? 1 : b.ageDays - a.ageDays)
    || a.key.localeCompare(b.key);
}

function tally(items, pick) {
  const counts = {};
  for (const item of items) {
    const key = pick(item);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

/*
 * `audit` is CodeAuditHistory#workspaceFindings, `exposure` is
 * ExposureStore#workspaceFindings; `severityOf` names an exposure rule's
 * severity and `displayPath` masks a credential-shaped path.
 */
function buildInbox(input = {}) {
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  const severityOf = typeof input.severityOf === 'function' ? input.severityOf : () => 'serious';
  const displayPath = typeof input.displayPath === 'function' ? input.displayPath : value => value;
  const audit = input.audit && Array.isArray(input.audit.findings) ? input.audit : null;
  const exposure = input.exposure && Array.isArray(input.exposure.findings) ? input.exposure : null;
  const items = [
    ...(audit ? audit.findings.map(finding => auditItem(finding, now)) : []),
    ...(exposure ? exposure.findings.map(finding => exposureItem(finding, now, { severityOf, displayPath })) : [])
  ].sort(compare);
  const undecided = items.filter(item => !item.decision);
  return {
    generatedAt: new Date(now).toISOString(),
    sources: { audit: audit ? 'measured' : 'unavailable', exposure: exposure ? 'measured' : 'unavailable' },
    truncated: Boolean((audit && audit.truncated) || (exposure && exposure.truncated)),
    total: items.length,
    counts: {
      bySeverity: tally(undecided, item => item.severity),
      byState: tally(items, item => item.state),
      byKind: tally(undecided, item => item.kind),
      byRepository: tally(undecided, item => `${item.owner}/${item.repo}`)
    },
    findings: items
  };
}

module.exports = Object.freeze({ buildInbox, STATES, EXPOSURE_KIND, NEW_WINDOW_MS });
