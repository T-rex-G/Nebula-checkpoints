'use strict';

/*
 * The workspace's security posture, as the Overview draws it.
 *
 * Three systems already measure a repository one at a time: the audit engine
 * counts findings and how long fixing them took, the exposure scanner counts
 * leaked credentials, and governance records every merge it was asked to
 * decide. This reads them together, for the repositories the signed-in
 * identity has audited or scanned, and nothing else -- no repository is
 * reached over the network to build it, and nothing a reader could not
 * already see one repository at a time is added by putting them side by side.
 *
 * Pure: the route hands in what the stores returned (and null for a store
 * that could not answer), and this decides what the figures are. A store that
 * could not answer leaves its part unmeasured rather than zero, because "no
 * findings" and "could not read the findings" are the opposite of each other.
 */

const SEVERITIES = Object.freeze(['critical', 'serious', 'warning']);
/* Exposure findings are their own category: a credential in the history is not a code finding. */
const EXPOSURE_CATEGORY = 'leaked-credentials';
const TOP_REPOSITORIES = 6;

function weeklySeries(weeks, entries) {
  const counts = new Array(weeks).fill(0);
  for (const entry of Array.isArray(entries) ? entries : []) {
    const index = Number(entry && entry.weeksAgo);
    const count = Number(entry && entry.count);
    if (Number.isSafeInteger(index) && index >= 0 && index < weeks && Number.isFinite(count) && count > 0) counts[index] += count;
  }
  return counts;
}

function emptyOpen() {
  return { critical: 0, serious: 0, warning: 0, total: 0 };
}

function repositoryKey(owner, repo) {
  return `${String(owner || '').toLowerCase()}/${String(repo || '').toLowerCase()}`;
}

/*
 * `audit` is CodeAuditHistory#workspace, `exposure` is the posture reader's
 * exposure reading ({ available, repositories }), `exposureTrend` is
 * ExposureStore#workspaceTrend and `merges` is GovernanceStore#countMergeOutcomes
 * for the last seven days. Any of them may be null.
 */
function summarizePosture(input = {}) {
  const weeks = Number.isSafeInteger(input.weeks) && input.weeks >= 1 && input.weeks <= 52 ? input.weeks : 12;
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  const audit = input.audit && typeof input.audit === 'object' ? input.audit : null;
  const exposure = input.exposure && input.exposure.available === true ? input.exposure : null;
  const exposureTrend = input.exposureTrend && typeof input.exposureTrend === 'object' ? input.exposureTrend : null;
  const merges = input.merges && typeof input.merges === 'object' ? input.merges : null;

  const repositories = new Map();
  function repository(owner, repo) {
    const key = repositoryKey(owner, repo);
    if (!repositories.has(key)) repositories.set(key, { owner, repo, open: emptyOpen(), audit: null, exposure: null });
    return repositories.get(key);
  }

  const open = emptyOpen();
  const triaged = { acceptedRisk: 0, falsePositive: 0 };
  const categories = new Map();
  const count = (category, severity, amount) => {
    if (!categories.has(category)) categories.set(category, emptyOpen());
    const entry = categories.get(category);
    entry[severity] += amount;
    entry.total += amount;
  };

  if (audit) {
    for (const row of Array.isArray(audit.audits) ? audit.audits : []) {
      repository(row.owner, row.repo).audit = {
        at: row.auditedAt, ref: row.ref, grade: row.grade, score: row.score, complete: row.coverageComplete === true
      };
    }
    for (const row of Array.isArray(audit.findings) ? audit.findings : []) {
      const amount = Number(row.count) || 0;
      if (!amount || !SEVERITIES.includes(row.severity)) continue;
      if (row.state === 'accepted-risk') { triaged.acceptedRisk += amount; continue; }
      if (row.state === 'false-positive') { triaged.falsePositive += amount; continue; }
      if (row.state !== 'open') continue;
      const entry = repository(row.owner, row.repo);
      entry.open[row.severity] += amount;
      entry.open.total += amount;
      open[row.severity] += amount;
      open.total += amount;
      count(String(row.category || 'other'), row.severity, amount);
    }
  }

  if (exposure) {
    for (const row of Array.isArray(exposure.repositories) ? exposure.repositories : []) {
      const entry = repository(row.owner, row.repo);
      entry.exposure = { at: row.scannedAt || null, partial: row.partial === true };
      for (const severity of SEVERITIES) {
        const amount = Number(row.open && row.open[severity]) || 0;
        if (!amount) continue;
        entry.open[severity] += amount;
        entry.open.total += amount;
        open[severity] += amount;
        open.total += amount;
        count(EXPOSURE_CATEGORY, severity, amount);
      }
    }
  }
  if (exposureTrend) triaged.acceptedRisk += Number(exposureTrend.accepted) || 0;

  const opened = weeklySeries(weeks, [
    ...(audit ? audit.opened || [] : []),
    ...(exposureTrend ? exposureTrend.opened || [] : [])
  ]);
  const fixed = weeklySeries(weeks, [
    ...(audit ? audit.fixed || [] : []),
    ...(exposureTrend ? exposureTrend.fixed || [] : [])
  ]);
  const trend = opened.map((_, index) => ({ weeksAgo: index, opened: opened[index], fixed: fixed[index] })).reverse();
  const openedTotal = opened.reduce((sum, value) => sum + value, 0);
  const fixedTotal = fixed.reduce((sum, value) => sum + value, 0);

  const ranked = [...repositories.values()]
    .map(entry => ({ ...entry, open: { ...entry.open } }))
    .sort((a, b) => b.open.critical - a.open.critical || b.open.serious - a.open.serious
      || b.open.total - a.open.total || repositoryKey(a.owner, a.repo).localeCompare(repositoryKey(b.owner, b.repo)));

  return {
    generatedAt: new Date(now).toISOString(),
    weeks,
    sources: {
      audit: audit ? 'measured' : 'unavailable',
      exposure: exposure && exposureTrend ? 'measured' : exposure ? 'partial' : 'unavailable',
      governance: merges ? 'measured' : 'unavailable'
    },
    open,
    triaged,
    week: {
      opened: opened[0],
      fixed: fixed[0],
      gated: merges ? (Number(merges.block) || 0) : null,
      warned: merges ? (Number(merges.warn) || 0) : null
    },
    window: { opened: openedTotal, fixed: fixedTotal },
    trend,
    timeToFix: audit && audit.timeToFix ? audit.timeToFix : null,
    categories: [...categories.entries()]
      .map(([category, counts]) => ({ category, ...counts }))
      .sort((a, b) => b.total - a.total || a.category.localeCompare(b.category)),
    top: ranked.filter(entry => entry.open.total > 0).slice(0, TOP_REPOSITORIES),
    repositories: ranked.map(entry => ({
      owner: entry.owner,
      repo: entry.repo,
      open: entry.open,
      audit: entry.audit,
      exposure: entry.exposure
    }))
  };
}

module.exports = Object.freeze({ summarizePosture, EXPOSURE_CATEGORY, TOP_REPOSITORIES, SEVERITIES });
