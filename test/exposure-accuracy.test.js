'use strict';

// Scanner accuracy regressions use synthetic credentials and in-memory readers.
// Database pagination and watch preservation run in the PostgreSQL gates.
const assert = require('node:assert/strict');
const repo = require('node:path').join(__dirname, '..');
const { detectInText, RULES_VERSION, DETECTION_ENGINE_VERSION } = require(repo + '/src/exposure-detection');
const { createExposureRunner } = require(repo + '/src/exposure-worker');
const { fingerprintKeyId, FINGERPRINT_KEY_VERSION } = require(repo + '/src/exposure-findings');
const { EXPOSURE_CONFIG_VERSION } = require(repo + '/src/exposure-store');

const key = Buffer.alloc(32, 17);
const scope = { provider: 'github', authority: 'github.com', owner: 'fixture', repo: 'fixture' };
const tip = 'a'.repeat(40);
const merged = 'b'.repeat(40);
const secret = 'gh' + 'p_' + 'SyntheticOnly0123456789ABCDEFGHIJKLMN'.slice(0, 36).padEnd(36, 'Z');

async function runFixture({ tree = [], blobText = '', commits = [], changes, budgets, now, onReadBlob, readArchive, scanMode = 'history' } = {}) {
  const output = { findings: [], readCommits: [], listed: 0, final: null };
  const scan = {
    scanId: 'audit-fixture', scope, requestedBy: 'fixture', commitSha: tip, scanMode,
    rulesVersion: RULES_VERSION, engineVersion: DETECTION_ENGINE_VERSION,
    fingerprintKeyVersion: FINGERPRINT_KEY_VERSION, fingerprintKeyId: fingerprintKeyId(key),
    configVersion: EXPOSURE_CONFIG_VERSION
  };
  await createExposureRunner({
    fingerprintKey: key,
    budgets,
    now: now || (() => 1000),
    sessionResolver: async () => ({ token: 'synthetic-fixture-no-network' }),
    store: {
      claimScan: async () => ({ scan, claimOwner: 'fixture-worker' }),
      renewClaim: async () => true,
      recordObservations: async input => { output.findings.push(...input.findings); },
      finalizeScan: async input => { output.final = input; }
    },
    reader: {
      readTree: async () => ({ entries: tree, skipped: [], truncated: false }),
      readBlob: async () => { if (onReadBlob) onReadBlob(); return { text: blobText, skip: null }; },
      listCommits: async () => { output.listed += 1; return { commits, truncated: false }; },
      readCommitChanges: async ({ sha }) => { output.readCommits.push(sha); return changes ? changes(sha) : { sha, files: [] }; },
      ...(readArchive ? { readArchive } : {})
    }
  }).runOnce();
  return output;
}

(async () => {
  const reports = [];

  // A Kubernetes/config file can have more than 200 ordinary base64 values.
  const harmless = Buffer.from('Harmless configuration string 12345').toString('base64');
  const encoded = Buffer.from(secret).toString('base64');
  assert.equal(detectInText({ text: encoded }).candidates.length, 1);
  const with200 = Array(200).fill(harmless).concat(encoded).join('\n');
  const decoded = detectInText({ text: with200 });
  assert.equal(decoded.candidates.length, 0);
  assert.equal(decoded.truncated, true);
  const encodedRun = await runFixture({
    scanMode: 'tree', blobText: with200,
    tree: [{ path: 'config.yaml', sha: 'c'.repeat(40), size: Buffer.byteLength(with200) }]
  });
  assert.equal(encodedRun.final.coverage, 'partial');
  reports.push({ case: 'base64-ceiling-silent', encodedSecretAloneFindings: 1, after200HarmlessRuns: decoded.candidates.length, truncated: decoded.truncated, workerCoverage: encodedRun.final.coverage });

  // The secret is introduced during a merge conflict resolution and removed
  // by the next (tip) commit. Neither parent contains it.
  const mergeResult = await runFixture({
    commits: [{ sha: tip, parents: 1 }, { sha: merged, parents: 2 }],
    changes: sha => ({ sha, files: sha === merged ? [{
      path: 'config.env', hunks: [{ lines: [{ line: 1, added: true, text: secret }] }]
    }] : [] })
  });
  assert(mergeResult.readCommits.includes(merged));
  assert.equal(mergeResult.final.coverage, 'complete');
  assert.equal(mergeResult.findings.length, 1);
  reports.push({ case: 'merge-history-skipped', commitsReportedScanned: mergeResult.final.commitsScanned, actualCommitReads: mergeResult.readCommits.length, findings: mergeResult.findings.length, coverage: mergeResult.final.coverage });

  // A last tree blob arriving just after the deadline suppresses history.
  let clock = 1000;
  const deadlineResult = await runFixture({
    tree: [{ path: 'readme.txt', sha: 'c'.repeat(40), size: 5 }], blobText: 'hello',
    now: () => clock, onReadBlob: () => { clock = 1011; },
    budgets: { maxWallClockMs: 10 }, commits: [{ sha: tip, parents: 1 }]
  });
  assert.equal(deadlineResult.listed, 0);
  assert.equal(deadlineResult.final.coverage, 'partial');
  reports.push({ case: 'deadline-skips-all-history', historyListingCalls: deadlineResult.listed, commitsReportedScanned: deadlineResult.final.commitsScanned, coverage: deadlineResult.final.coverage, skippedReason: deadlineResult.final.skippedReason });

  // maxBytes is documented as decoded bytes scanned but history ignores it.
  const budgetResult = await runFixture({
    budgets: { maxBytes: 10 }, commits: [{ sha: tip, parents: 1 }],
    changes: sha => ({ sha, files: [{ path: 'large-history.txt', hunks: [{ lines: [{ line: 1, added: true, text: 'a'.repeat(1000) }] }] }] })
  });
  assert(budgetResult.final.bytesScanned <= 10);
  assert.equal(budgetResult.final.coverage, 'partial');
  reports.push({ case: 'history-ignores-byte-budget', maxBytes: 10, bytesScanned: budgetResult.final.bytesScanned, coverage: budgetResult.final.coverage });

  // Compression creates the same accounting gap in a current-tree scan.
  const archiveResult = await runFixture({
    scanMode: 'tree', budgets: { maxBytes: 100 },
    tree: [{ path: 'fixture.zip', sha: 'c'.repeat(40), size: 90, archive: 'zip' }],
    readArchive: async () => ({ skip: null, members: [{ path: 'fixture.zip!/a.txt', text: 'a'.repeat(1000) }], named: [], membersSkipped: 0, truncated: false })
  });
  assert(archiveResult.final.bytesScanned <= 100);
  assert.equal(archiveResult.final.coverage, 'partial');
  reports.push({ case: 'archive-decoded-bytes-ignore-budget', maxBytes: 100, bytesScanned: archiveResult.final.bytesScanned, coverage: archiveResult.final.coverage });

  console.log(`Exposure accuracy regressions passed (${reports.length} cases)`);
})().catch(error => { console.error(error); process.exitCode = 1; });
