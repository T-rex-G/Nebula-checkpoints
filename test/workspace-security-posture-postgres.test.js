'use strict';

/*
 * The Overview's security posture, against a real PostgreSQL server.
 *
 * Every figure it draws comes from three statements: the audit history's
 * workspace read, the exposure trend (tested beside the exposure store), and
 * the count of merges governance decided. Which audit stands for a
 * repository, which findings a team decision still covers, what counts as
 * fixed and which identity's rows are read are all decided in SQL, so a fake
 * would prove only what it was written to; this gate needs a server.
 */

const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const { Client, Pool } = require('pg');

const { loadMigrations, runMigrations } = require('../src/migrations');
const { CodeAuditHistory } = require('../src/code-audit-history');
const { GovernanceStore } = require('../src/governance-store');
const { normalizeMutationDescriptor } = require('../src/mutation-gateway');

const DIRECTORY = path.join(__dirname, '..', 'db', 'migrations');
const ADMIN_URL = String(process.env.NV_TEST_DATABASE_URL || '').trim();
if (!ADMIN_URL) throw new Error('NV_TEST_DATABASE_URL is required: this gate runs the workspace posture against a real PostgreSQL server');

const IDENTITY = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-09-01T09:00:00.000Z');
const id = seed => crypto.createHash('sha256').update(String(seed)).digest('hex').slice(0, 24);
const sha = seed => crypto.createHash('sha1').update(String(seed)).digest('hex');
const scopeOf = repo => ({ provider: 'github', authority: 'github.com', owner: 'Acme', repo });

function finding(seed, severity, category = 'code', rule = 'SEC-011') {
  return {
    id: id(seed), rule, category, severity, path: `src/${seed}.js`, line: 3,
    title: 't', why: 'w', fix: 'f', detail: null, prompt: 'p', verdict: 'needs-validation', evidence: 'traced', trace: null
  };
}
function triaged(seed, severity, rule = 'SEC-011') {
  return { ...finding(seed, severity, 'code', rule), suppression: { triage: { disposition: 'accepted-risk', reason: 'low-impact' } } };
}
function result({ commit, ref = 'main', at, findings = [], suppressed = [] }) {
  return {
    commitSha: sha(commit), ref, auditedAt: new Date(at).toISOString(),
    score: 70, grade: 'C', capped: false, capReason: null, engine: { name: 'Uranus', version: '2.0.0' },
    categories: [{ id: 'code', score: 70 }],
    findings, suppressed,
    dependencyRisk: { exploited: 0, bands: { urgent: 0, high: 0, moderate: 0, low: 0 } },
    coverage: { read: 4, eligible: 4, complete: true },
    components: [], componentsTruncated: 0
  };
}
async function withClient(connectionString, run) {
  const client = new Client({ connectionString });
  await client.connect();
  try { return await run(client); } finally { await client.end(); }
}
function triageRow(repo, seed, disposition, expiresAt, rule = 'SEC-011') {
  return [
    'github', 'github.com', 'Acme', repo, id(seed), rule, disposition,
    disposition === 'false-positive' ? 'misread' : 'low-impact',
    'alice', 'c'.repeat(64), new Date(T0).toISOString(), expiresAt
  ];
}

(async () => {
  const databaseName = `nvx_workspace_posture_${crypto.randomBytes(6).toString('hex')}`;
  await withClient(ADMIN_URL, client => client.query(`CREATE DATABASE ${databaseName}`));
  const url = new URL(ADMIN_URL);
  url.pathname = `/${databaseName}`;
  const pool = new Pool({ connectionString: url.toString(), max: 4 });
  try {
    await withClient(url.toString(), client => runMigrations(client, loadMigrations(DIRECTORY)));
    const history = new CodeAuditHistory({ pool });

    /*
     * Shop, on main. The first audit sees four findings; three days later the
     * second no longer sees `fixed` (a resolution, three days to fix), still
     * sees the other three -- one of them now covered by an accepted risk in
     * force, one by a decision that has since expired, one by a false
     * positive -- and sees one new finding.
     */
    const shop = scopeOf('Shop');
    await history.record({ scope: shop, identityKey: IDENTITY, now: T0, result: result({
      commit: 'shop-1', at: T0,
      findings: [finding('fixed', 'critical'), finding('kept', 'serious'), finding('accepted', 'serious'), finding('lapsed', 'warning')],
      suppressed: [triaged('dismissed', 'warning', 'SEC-012')]
    }) });
    await history.record({ scope: shop, identityKey: IDENTITY, now: T0 + 3 * DAY, result: result({
      commit: 'shop-2', at: T0 + 3 * DAY,
      findings: [finding('kept', 'serious'), finding('new', 'critical', 'secrets', 'SEC-006')],
      suppressed: [triaged('accepted', 'serious'), triaged('lapsed', 'warning'), triaged('dismissed', 'warning', 'SEC-012'), triaged('reopened', 'warning'),
        { ...finding('in-code', 'serious'), suppression: { reason: 'r', line: 2 } }]
    }) });
    /*
     * After the second audit: this identity accepts `kept` itself, which
     * applies at once, and a teammate dismisses `new`, which waits for the
     * next audit -- the auditor never saw it.
     */
    const mine = triageRow('Shop', 'kept', 'accepted-risk', new Date(T0 + 30 * DAY).toISOString());
    mine[9] = IDENTITY;
    const teammate = triageRow('Shop', 'new', 'false-positive', null, 'SEC-006');
    for (const row of [
      mine, teammate,
      triageRow('Shop', 'accepted', 'accepted-risk', new Date(T0 + 60 * DAY).toISOString()),
      triageRow('Shop', 'lapsed', 'accepted-risk', new Date(T0 + 4 * DAY).toISOString()),
      triageRow('Shop', 'dismissed', 'false-positive', null, 'SEC-012')
    ]) {
      await pool.query(
        `INSERT INTO nv_code_audit_triage (provider, authority, owner_login, repo_name, finding_id, rule, disposition, reason,
           decided_by, decided_by_key, decided_at, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, row);
    }

    /* Api: audited on main, then on a branch with nothing open. The branch is the latest audit and stands for the repository. */
    const api = scopeOf('Api');
    await history.record({ scope: api, identityKey: IDENTITY, now: T0 + DAY, result: result({ commit: 'api-1', at: T0 + DAY, findings: [finding('api-main', 'serious')] }) });
    await history.record({ scope: api, identityKey: IDENTITY, now: T0 + 2 * DAY, result: result({ commit: 'api-2', ref: 'feature', at: T0 + 2 * DAY }) });

    /* Another identity's audit of the same repository is not this workspace. */
    await history.record({ scope: shop, identityKey: OTHER, now: T0, result: result({ commit: 'other', at: T0, findings: [finding('theirs', 'critical')] }) });

    const now = T0 + 5 * DAY;
    const read = await history.workspace({ provider: 'github', authority: 'github.com', identityKey: IDENTITY, now, weeks: 12 });
    assert.deepStrictEqual(read.audits.map(row => [row.repo, row.ref, row.grade, row.coverageComplete]), [
      ['Shop', 'main', 'C', true],
      ['Api', 'feature', 'C', true]
    ], 'each repository is its latest audit, newest first, whichever branch that was');
    const states = Object.fromEntries(read.findings
      .filter(row => row.repo === 'Shop')
      .map(row => [`${row.severity}:${row.category}:${row.state}`, row.count]));
    assert.deepStrictEqual(states, {
      'critical:secrets:open': 1,
      'serious:code:accepted-risk': 2,
      'warning:code:open': 2,
      'warning:code:false-positive': 1,
      'serious:code:waived': 1
    }, 'a decision the audit saw, or this identity made, covers its finding; a teammate\'s later one waits for the next audit; an expired or reopened one leaves it open; a waiver in the code is not a finding');
    assert.strictEqual(read.findings.filter(row => row.repo === 'Api').length, 0,
      'the branch audit with nothing open stands for Api, so main\'s finding is not counted twice');
    assert.deepStrictEqual(read.fixed, [{ weeksAgo: 0, count: 1 }], 'the finding the second audit stopped seeing was fixed this week');
    assert.deepStrictEqual(
      read.opened.reduce((sum, row) => sum + row.count, 0), 7,
      'opened counts every finding first seen in the window on the branch read -- the open ones, the covered ones and the fixed one -- and no waiver in the code'
    );
    assert.strictEqual(read.timeToFix.all.count, 1);
    assert.strictEqual(read.timeToFix.all.medianDays, 3, 'three days from first seen to the audit that no longer saw it');
    assert.strictEqual(read.timeToFix.critical.count, 1);
    assert.strictEqual(read.timeToFix.serious.count, 0);

    const later = await history.workspace({ provider: 'github', authority: 'github.com', identityKey: IDENTITY, now: T0 + 15 * DAY, weeks: 12 });
    assert.deepStrictEqual(later.fixed, [{ weeksAgo: 1, count: 1 }], 'the series is rolling windows ending at the moment asked about');
    const beyond = await history.workspace({ provider: 'github', authority: 'github.com', identityKey: IDENTITY, now: T0 + 200 * DAY, weeks: 12 });
    assert.deepStrictEqual([beyond.opened, beyond.fixed], [[], []], 'nothing older than the window is in it');

    const theirs = await history.workspace({ provider: 'github', authority: 'github.com', identityKey: OTHER, now, weeks: 12 });
    assert.deepStrictEqual(theirs.audits.map(row => row.repo), ['Shop']);
    assert.deepStrictEqual(theirs.findings.map(row => [row.severity, row.state, row.count]), [['critical', 'open', 1]],
      'another identity reads its own audit and nothing of this one');
    const elsewhere = await history.workspace({ provider: 'github', authority: 'ghe.example.com', identityKey: IDENTITY, now, weeks: 12 });
    assert.deepStrictEqual(elsewhere.audits, [], 'another authority is another workspace');
    await assert.rejects(history.workspace({ provider: 'github', authority: 'github.com', identityKey: 'nope' }), error => error.code === 'CODE_AUDIT_IDENTITY_INVALID');

    /* ---- The findings inbox, one row per finding ---------------------- */
    /*
     * Loop: a finding seen, then fixed (an audit that read every file no
     * longer saw it), then seen again. The inbox says it came back, and when
     * it was last fixed.
     */
    const loop = scopeOf('Loop');
    await history.record({ scope: loop, identityKey: IDENTITY, now: T0, result: result({ commit: 'loop-1', at: T0, findings: [finding('again', 'serious')] }) });
    await history.record({ scope: loop, identityKey: IDENTITY, now: T0 + DAY, result: result({ commit: 'loop-2', at: T0 + DAY }) });
    await history.record({ scope: loop, identityKey: IDENTITY, now: T0 + 2 * DAY, result: result({ commit: 'loop-3', at: T0 + 2 * DAY, findings: [finding('again', 'serious')] }) });
    const inbox = await history.workspaceFindings({ provider: 'github', authority: 'github.com', identityKey: IDENTITY, now });
    assert.strictEqual(inbox.truncated, false);
    const byId = new Map(inbox.findings.map(item => [`${item.repo}:${item.id}`, item]));
    const shopRow = seed => byId.get(`Shop:${id(seed)}`);
    assert.deepStrictEqual(shopRow('kept').decision && shopRow('kept').decision.disposition, 'accepted-risk', 'a decision this identity made applies at once');
    assert.strictEqual(shopRow('new').decision, null, 'a teammate\'s later decision waits for the next audit');
    assert.strictEqual(shopRow('accepted').decision.disposition, 'accepted-risk');
    assert.strictEqual(shopRow('accepted').decision.reason, 'low-impact');
    assert.strictEqual(shopRow('lapsed').decision, null, 'an expired acceptance is no decision');
    assert.strictEqual(shopRow('dismissed').decision.disposition, 'false-positive');
    assert.strictEqual(shopRow('reopened').decision, null, 'a reopened finding is open');
    assert.strictEqual(byId.has(`Shop:${id('in-code')}`), false, 'a waiver in the code is not listed');
    assert.strictEqual(byId.has(`Shop:${id('fixed')}`), false, 'a fixed finding is not listed');
    assert.strictEqual(inbox.findings.filter(item => item.repo === 'Api').length, 0, 'Api stands as its latest, empty, audit');
    const again = byId.get(`Loop:${id('again')}`);
    assert.deepStrictEqual([again.timesFixed, again.regressedAfter], [1, new Date(T0 + DAY).toISOString()],
      'a finding fixed and seen again says so, and when it was fixed');
    assert.strictEqual(shopRow('kept').regressedAfter, null);
    assert.strictEqual(again.ref, 'main');
    assert.strictEqual(again.title, 'A shell command is built by string interpolation', 'the title is the rule\'s own, never text from the repository');
    assert.deepStrictEqual(inbox.findings.map(item => item.severity), [...inbox.findings.map(item => item.severity)].sort((a, b) =>
      ['critical', 'serious', 'warning'].indexOf(a) - ['critical', 'serious', 'warning'].indexOf(b)), 'most severe first');
    const capped = await history.workspaceFindings({ provider: 'github', authority: 'github.com', identityKey: IDENTITY, now, limit: 2 });
    assert.deepStrictEqual([capped.findings.length, capped.truncated], [2, true], 'a bounded read says it was bounded');
    const theirInbox = await history.workspaceFindings({ provider: 'github', authority: 'github.com', identityKey: OTHER, now });
    assert.deepStrictEqual(theirInbox.findings.map(item => item.id), [id('theirs')], 'another identity\'s inbox is its own');

    /* ---- Merges governance decided ------------------------------------- */
    const governance = new GovernanceStore(pool, { secret: 'workspace-posture-postgres-secret-0123456789' });
    const decide = async (identityKey, action, repo = 'Shop') => {
      const target = { provider: 'github', owner: 'Acme', repo };
      const scopeKey = `github:github.com:acme/${repo.toLowerCase()}`;
      const authorization = {
        schemaVersion: 1,
        scope: { ...target, authority: 'github.com', scopeKey },
        executionPrincipal: { kind: 'user', identityKey, login: 'alice', authMethod: 'oauth' },
        governanceActor: { kind: 'human', identityKey, login: 'alice', verified: true },
        repositoryAccess: { baseRole: 'admin', providerRole: 'admin', level: 50, source: 'github.collaborator.permission', complete: true },
        governanceRoles: { reader: true, author: true, reviewer: true, activator: true, administrator: true },
        installationCapabilities: null,
        evidence: { status: 'resolved', fetchedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), reasonCode: null }
      };
      const merge = action === 'pull.merge';
      const descriptor = normalizeMutationDescriptor({
        ...target, actorIdentityKey: identityKey, actorLogin: 'alice', action,
        method: 'PUT', route: merge ? '/api/repo/:owner/:repo/pulls/:num/merge' : '/api/repo/:owner/:repo/file',
        authorization, metadata: merge ? { branch: 'main' } : { branch: 'main', path: 'README.md' },
        ...(merge ? { security: { stepUpAction: 'pull.merge', assurance: 'credential', authorizedAt: Date.now() } } : {})
      });
      return governance.evaluateAndAppendPolicyDecision({ scope: target, descriptor });
    };
    const start = Date.now() - 1000;
    await decide(IDENTITY, 'pull.merge');
    await decide(IDENTITY, 'pull.merge', 'Api');
    await decide(IDENTITY, 'file.write');
    await decide(OTHER, 'pull.merge');
    assert.deepStrictEqual({ ...(await governance.countMergeOutcomes({ actorIdentityKey: IDENTITY, since: start })) },
      { allow: 2, warn: 0, block: 0 }, 'this identity\'s merges across repositories, and nothing else it did');
    assert.deepStrictEqual({ ...(await governance.countMergeOutcomes({ actorIdentityKey: OTHER, since: start })) },
      { allow: 1, warn: 0, block: 0 }, 'another identity\'s merges are its own');
    assert.deepStrictEqual({ ...(await governance.countMergeOutcomes({ actorIdentityKey: IDENTITY, since: Date.now() + 60_000 })) },
      { allow: 0, warn: 0, block: 0 }, 'nothing decided before the start is counted');
    await assert.rejects(governance.countMergeOutcomes({ actorIdentityKey: 'nope', since: start }), error => error.code === 'GOVERNANCE_ACTOR_INVALID');
    await assert.rejects(governance.countMergeOutcomes({ actorIdentityKey: IDENTITY, since: 'never' }), error => error.code === 'GOVERNANCE_SINCE_INVALID');

    console.log('workspace security posture PostgreSQL tests passed');
  } finally {
    /* pool.end() resolves before its sockets close; the forced drop may reach one on its way out. */
    pool.on('error', () => {});
    await pool.end();
    await withClient(ADMIN_URL, client => client.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`));
  }
})().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
