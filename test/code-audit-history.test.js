'use strict';

/*
 * The audit history against a real PostgreSQL server.
 *
 * What this store promises rests on the database: that no column can take a
 * line of code is a set of CHECK constraints, that an account's audits leave
 * with it is a cascade, that one identity never reads another's is the WHERE
 * clause every statement carries. A fake would pass whatever it was written to
 * pass, so this gate needs a server and refuses without one.
 */

const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const { Client, Pool } = require('pg');

const { loadMigrations, runMigrations } = require('../src/migrations');
const { CodeAuditHistory, createAuditWatch, compactAudit, LIMITS } = require('../src/code-audit-history');

const DIRECTORY = path.join(__dirname, '..', 'db', 'migrations');
const ADMIN_URL = String(process.env.NV_TEST_DATABASE_URL || '').trim();
if (!ADMIN_URL) throw new Error('NV_TEST_DATABASE_URL is required: this gate runs the audit history against a real PostgreSQL server');

/* Text an audit result carries in memory that must never reach a row. */
const CANARY = ['canary-trace-note', 'canary-prompt', 'canary-summary', 'canary-waiver', 'canary-why', 'canary-source-line', `gh${'p'}_${'Q'.repeat(36)}`];

const scope = Object.freeze({ provider: 'github', authority: 'github.com', owner: 'Acme', repo: 'Shop' });
const IDENTITY = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const T0 = Date.parse('2026-09-20T10:00:00.000Z');
const HOUR = 60 * 60 * 1000;

const id = seed => crypto.createHash('sha256').update(String(seed)).digest('hex').slice(0, 24);
const sha = seed => crypto.createHash('sha1').update(String(seed)).digest('hex');

function codeFinding(seed, severity = 'serious') {
  return {
    id: id(seed), rule: 'SEC-011', category: 'code', severity, path: `routes/${seed}.js`, line: 12,
    title: 'A shell command is built by string interpolation', why: 'canary-why', fix: 'x', detail: null,
    prompt: 'canary-prompt', verdict: 'needs-validation', evidence: 'traced',
    trace: [{ path: `routes/${seed}.js`, line: 10, role: 'entrypoint', note: 'canary-trace-note' }],
    source: 'canary-source-line', blocker: CANARY[6], check: 'y'
  };
}
function packageFinding(seed, { name = 'jquery', version = '3.4.1', exploited = false, ecosystem = 'npm' } = {}) {
  return {
    id: id(seed), rule: 'DEP-003', category: 'dependencies', severity: 'serious', path: 'package-lock.json', line: 40,
    title: 't', why: 'canary-why', fix: 'x', prompt: 'canary-prompt', verdict: 'confirmed', evidence: 'fact', trace: null,
    detail: {
      package: name, version, ecosystem, purl: `pkg:${ecosystem}/${name}@${version}`, direct: true, dev: false, source: 'lock', range: null,
      fixed: '3.5.0', unfixed: false, cvss: 6.1,
      advisories: [{ id: 'GHSA-jpcq-cgw6-v4j6', cve: 'CVE-2020-11023', severity: 'serious', cvss: 6.1, summary: 'canary-summary' }],
      more: 0,
      usage: { tier: 'imported', files: ['canary-source-line.js'], count: 1, loader: null },
      intel: exploited ? { exploited: true, ransomware: false, kev: { cve: 'CVE-2020-11023', added: '2025-01-23', due: '2025-02-13', ransomware: false }, epss: { cve: 'CVE-2020-11023', score: 0.85, percentile: 0.997 }, catalog: 'listed' } : null,
      risk: { score: exploited ? 92 : 55, band: exploited ? 'urgent' : 'moderate' }
    }
  };
}
function auditResult({ commit = 'one', ref = 'main', findings, auditedAt = T0, components } = {}) {
  return {
    commitSha: sha(commit), ref, auditedAt: new Date(auditedAt).toISOString(),
    score: 62, grade: 'D', capped: false, capReason: null, engine: { name: 'Uranus', version: '2.0.0' },
    categories: [{ id: 'code', score: 70 }, { id: 'dependencies', score: 55 }],
    findings: findings || [codeFinding('a'), packageFinding('dep')],
    suppressed: [{ rule: 'SEC-005', path: 'x.js', line: 3, reason: 'canary-waiver' }],
    dependencyRisk: { exploited: 0, bands: { urgent: 0, high: 0, moderate: 1, low: 0 } },
    coverage: { read: 30, eligible: 33, complete: false },
    components: components || [
      { ecosystem: 'npm', name: 'jquery', version: '3.4.1', direct: true, dev: false, advisories: { ids: ['GHSA-jpcq-cgw6-v4j6', 'GHSA-gxr4-xjj5-5px2'], cves: ['CVE-2020-11023'], exploited: [] } },
      { ecosystem: 'npm', name: 'express', version: '4.17.1', direct: true, dev: false },
      { ecosystem: 'npm', name: 'bad name with spaces', version: '1.0.0', direct: false, dev: false }
    ],
    componentsTruncated: 0
  };
}

async function withClient(connectionString, run) {
  const client = new Client({ connectionString });
  await client.connect();
  try { return await run(client); } finally { await client.end(); }
}

(async () => {
  const databaseName = `nvx_audit_history_${crypto.randomBytes(6).toString('hex')}`;
  await withClient(ADMIN_URL, client => client.query(`CREATE DATABASE ${databaseName}`));
  const url = new URL(ADMIN_URL);
  url.pathname = `/${databaseName}`;
  const pool = new Pool({ connectionString: url.toString(), max: 4 });
  try {
    await withClient(url.toString(), client => runMigrations(client, loadMigrations(DIRECTORY)));
    const history = new CodeAuditHistory({ pool });

    /* ---- Recording: the first audit of a branch has nothing to compare with -- */
    const first = await history.record({ scope, identityKey: IDENTITY, result: auditResult(), now: T0 });
    assert.strictEqual(first.previous, null);
    assert.strictEqual(first.newIds, null);
    assert.deepStrictEqual(first.stored, { findings: 2, components: 2 }, 'a component whose name is not a package name is left out, not stored approximately');

    /* ---- The second is compared with the first ---------------------------- */
    const second = await history.record({
      scope, identityKey: IDENTITY, now: T0 + HOUR,
      result: auditResult({ commit: 'two', auditedAt: T0 + HOUR, findings: [packageFinding('dep', { exploited: true }), codeFinding('b', 'critical'), codeFinding('c', 'warning')] })
    });
    assert.strictEqual(second.previous.auditId, first.auditId);
    assert.deepStrictEqual(second.newIds.sort(), [id('b'), id('c')].sort());
    assert.strictEqual(second.resolved, 1);

    const listed = await history.list({ scope, identityKey: IDENTITY, ref: 'main' });
    assert.deepStrictEqual(listed.audits.map(audit => audit.id), [second.auditId, first.auditId], 'newest first');
    assert.deepStrictEqual(listed.audits[0].diff, { new: 2, resolved: 1 });
    assert.strictEqual(listed.audits[1].diff, null);
    assert.deepStrictEqual(listed.audits[0].counts, { critical: 1, serious: 1, warning: 1 });
    assert.strictEqual(listed.audits[0].waived, 1);
    assert.deepStrictEqual(listed.audits[0].categories, [{ id: 'code', score: 70 }, { id: 'dependencies', score: 55 }]);
    assert.deepStrictEqual(listed.branches, [{ ref: 'main', audits: 2, lastAt: new Date(T0 + HOUR).toISOString() }]);
    /* The audit is the watch's first check, so the watch does not ask the same questions again straight away. */
    assert.deepStrictEqual(listed.audits[0].watch, { checkedAt: new Date(T0 + HOUR).toISOString(), state: 'ok', checked: 0, total: 2, kev: 'not-needed' });

    /* ---- One audit's findings, worst first, with the rule's own title ------- */
    const read = await history.read({ scope, identityKey: IDENTITY, auditId: second.auditId });
    assert.deepStrictEqual(read.findings.map(finding => finding.severity), ['critical', 'serious', 'warning']);
    const dep = read.findings.find(finding => finding.rule === 'DEP-003');
    assert.strictEqual(dep.title, require('../src/code-audit').RULES['DEP-003'].title);
    assert.deepStrictEqual(dep.package, { ecosystem: 'npm', name: 'jquery', version: '3.4.1', fixed: '3.5.0', advisories: ['GHSA-jpcq-cgw6-v4j6'], cves: ['CVE-2020-11023'], cvss: 6.1 });
    assert.deepStrictEqual([dep.exploited, dep.reach, dep.epss, dep.risk], [true, 'imported', 0.85, { score: 92, band: 'urgent' }]);
    assert.strictEqual(await history.read({ scope, identityKey: OTHER, auditId: second.auditId }), null, 'another identity reads nothing');
    assert.strictEqual(await history.read({ scope: { ...scope, repo: 'Other' }, identityKey: IDENTITY, auditId: second.auditId }), null, 'nor through another repository');
    assert.strictEqual(await history.read({ scope, identityKey: IDENTITY, auditId: 'not-a-uuid' }), null);
    assert.deepStrictEqual((await history.list({ scope, identityKey: OTHER, ref: 'main' })).audits, []);

    /* ---- Only the latest audit of a branch keeps its components ------------ */
    const watched = await history.watched({ scope, identityKey: IDENTITY, ref: 'main' });
    assert.strictEqual(watched.audit.id, second.auditId);
    assert.deepStrictEqual(watched.components.map(component => component.name), ['express', 'jquery']);
    assert.deepStrictEqual(watched.components.find(component => component.name === 'jquery').advisoryIds, ['GHSA-jpcq-cgw6-v4j6', 'GHSA-gxr4-xjj5-5px2']);
    const orphaned = await pool.query('SELECT count(*)::int AS n FROM nv_code_audit_components WHERE audit_id=$1', [first.auditId]);
    assert.strictEqual(orphaned.rows[0].n, 0);

    /* ---- The watch's answers: kept by what they are about ------------------ */
    const alert = { kind: 'advisory', ecosystem: 'npm', name: 'express', version: '4.17.1', direct: true, dev: false, id: 'GHSA-rv95-896h-c2vc', cve: 'CVE-2024-29041', severity: 'warning', cvss: 6.1, fixed: '4.19.2', malicious: false, exploited: false, ransomware: false, epss: 0.001 };
    const exploited = { kind: 'exploited', ecosystem: 'npm', name: 'jquery', version: '3.4.1', direct: true, dev: false, id: null, cve: 'CVE-2020-11023', exploited: true, ransomware: false, kevAdded: '2025-01-23', kevDue: '2025-02-13', epss: 0.85 };
    const saved = await history.saveWatch({ scope, identityKey: IDENTITY, auditId: second.auditId, now: T0 + 2 * HOUR, outcome: { state: 'ok', checked: 2, total: 2, kev: 'ok', alerts: [alert, exploited, { ...alert, name: 'has space' }] } });
    assert.deepStrictEqual(saved.map(item => item.kind), ['exploited', 'advisory'], 'exploited first; a malformed alert is dropped');
    assert.strictEqual(saved[1].firstSeenAt, new Date(T0 + 2 * HOUR).toISOString());
    assert.strictEqual(saved[0].kevAdded, '2025-01-23');
    const again = await history.saveWatch({ scope, identityKey: IDENTITY, auditId: second.auditId, now: T0 + 9 * HOUR, outcome: { state: 'partial', checked: 1, total: 2, kev: 'ok', alerts: [alert] } });
    assert.strictEqual(again.length, 2, 'a partial check never drops an alert it did not see again');
    assert.strictEqual(again.find(item => item.kind === 'advisory').firstSeenAt, new Date(T0 + 2 * HOUR).toISOString(), 'first seen survives');
    const complete = await history.saveWatch({ scope, identityKey: IDENTITY, auditId: second.auditId, now: T0 + 10 * HOUR, outcome: { state: 'ok', checked: 2, total: 2, kev: 'ok', alerts: [alert] } });
    assert.deepStrictEqual(complete.map(item => item.kind), ['advisory'], 'a complete check drops what it no longer finds');
    assert.strictEqual(await history.saveWatch({ scope, identityKey: OTHER, auditId: second.auditId, outcome: { state: 'ok', alerts: [alert] } }), null, 'another identity cannot write to it');
    const state = (await history.list({ scope, identityKey: IDENTITY, ref: 'main' })).audits[0].watch;
    assert.deepStrictEqual(state, { checkedAt: new Date(T0 + 10 * HOUR).toISOString(), state: 'ok', checked: 2, total: 2, kev: 'ok' });

    /* ---- The watch as a service: stale, forced, throttled, never doubled ---- */
    {
      let clock = T0 + 11 * HOUR;
      let checks = 0;
      const watch = createAuditWatch({
        history, now: () => clock,
        check: async ({ components }) => { checks += 1; await new Promise(resolve => setTimeout(resolve, 20)); return { state: 'ok', checked: components.length, total: components.length, kev: 'ok', alerts: [alert] }; }
      });
      const early = await watch.refresh({ scope, identityKey: IDENTITY, ref: 'main' });
      assert.strictEqual(early.fresh, false, 'an hour after the last check is not stale');
      assert.strictEqual(checks, 0);
      clock = T0 + 17 * HOUR;
      const [one, two] = await Promise.all([
        watch.refresh({ scope, identityKey: IDENTITY, ref: 'main' }),
        watch.refresh({ scope, identityKey: IDENTITY, ref: 'main' })
      ]);
      assert.strictEqual(checks, 1, 'two viewers at once cause one check');
      assert(one.fresh && two.fresh);
      assert.strictEqual(one.alerts.length, 1);
      clock += 5 * 60 * 1000;
      assert.strictEqual((await watch.refresh({ scope, identityKey: IDENTITY, ref: 'main', force: true })).fresh, false, 'asked again too soon');
      clock += 6 * 60 * 1000;
      assert.strictEqual((await watch.refresh({ scope, identityKey: IDENTITY, ref: 'main', force: true })).fresh, true);
      assert.strictEqual(checks, 2);
      assert.deepStrictEqual(await watch.refresh({ scope, identityKey: IDENTITY, ref: 'never-audited' }), { audit: null, alerts: [], components: 0, fresh: false, checkableAt: null });
    }

    /* ---- Retention: per branch, by age, and components for recent branches -- */
    {
      const tight = new CodeAuditHistory({ pool, limits: { keepPerBranch: 3, watchedBranches: 2 } });
      const small = { ...scope, repo: 'Retention' };
      for (let index = 0; index < 5; index += 1) {
        await tight.record({ scope: small, identityKey: IDENTITY, now: T0 + index * HOUR, result: auditResult({ commit: `r${index}`, auditedAt: T0 + index * HOUR }) });
      }
      assert.strictEqual((await tight.list({ scope: small, identityKey: IDENTITY, ref: 'main' })).audits.length, 3);
      for (const [index, ref] of ['dev', 'release'].entries()) {
        await tight.record({ scope: small, identityKey: IDENTITY, now: T0 + (6 + index) * HOUR, result: auditResult({ commit: ref, ref, auditedAt: T0 + (6 + index) * HOUR }) });
      }
      assert.strictEqual(await tight.watched({ scope: small, identityKey: IDENTITY, ref: 'main' }).then(found => found.components.length), 0, 'the least recently audited branch gives up its components');
      assert.strictEqual(await tight.watched({ scope: small, identityKey: IDENTITY, ref: 'release' }).then(found => found.components.length), 2);
      await tight.record({ scope: small, identityKey: IDENTITY, now: T0 + 500 * 24 * HOUR, result: auditResult({ commit: 'late', auditedAt: T0 + 500 * 24 * HOUR }) });
      assert.deepStrictEqual((await tight.list({ scope: small, identityKey: IDENTITY, ref: 'main' })).audits.map(audit => audit.auditedAt), [new Date(T0 + 500 * 24 * HOUR).toISOString()], 'audits past the age limit are removed');
      assert.strictEqual(LIMITS.keepPerBranch, 30);
    }

    /* ---- The database refuses what the store would never write -------------- */
    await assert.rejects(pool.query(
      `INSERT INTO nv_code_audit_findings (audit_id, finding_id, rule, category, severity, verdict, ecosystem, package_name, package_version)
       VALUES ($1, $2, 'DEP-003', 'dependencies', 'serious', 'confirmed', 'npm', 'const x = require("y");', '1.0.0')`,
      [second.auditId, id('sql')]
    ), /check constraint/, 'a line of code is not a package name');
    await assert.rejects(pool.query(
      `INSERT INTO nv_code_audit_findings (audit_id, finding_id, rule, category, severity, verdict, advisory_ids)
       VALUES ($1, $2, 'SEC-011', 'code', 'serious', 'confirmed', ARRAY['a summary with spaces'])`,
      [second.auditId, id('sql2')]
    ), /check constraint/);
    await assert.rejects(pool.query(
      `UPDATE nv_code_audits SET category_ids=ARRAY['code'], category_scores=ARRAY[101]::smallint[] WHERE audit_id=$1`,
      [second.auditId]
    ), /check constraint/);

    /* ---- Nothing an audit read is anywhere in the tables --------------------- */
    {
      const dump = [];
      for (const table of ['nv_code_audits', 'nv_code_audit_findings', 'nv_code_audit_components', 'nv_code_audit_alerts']) {
        dump.push(JSON.stringify((await pool.query(`SELECT * FROM ${table}`)).rows));
      }
      const text = dump.join('\n');
      for (const canary of CANARY) assert(!text.includes(canary), `${canary.slice(0, 16)}… must never be stored`);
      assert(!text.includes('canary-source-line.js'), 'the files that import a package are not stored');
    }

    /* ---- Clearing is one identity, one repository ---------------------------- */
    await history.record({ scope, identityKey: OTHER, result: auditResult(), now: T0 });
    assert.strictEqual(await history.clear({ scope, identityKey: IDENTITY }), 2);
    assert.deepStrictEqual((await history.list({ scope, identityKey: IDENTITY, ref: 'main' })).audits, []);
    assert.strictEqual((await history.list({ scope, identityKey: OTHER, ref: 'main' })).audits.length, 1, 'another identity keeps its own');
    const left = await pool.query('SELECT count(*)::int AS n FROM nv_code_audit_alerts WHERE audit_id=$1', [second.auditId]);
    assert.strictEqual(left.rows[0].n, 0, 'alerts leave with their audit');

    /* ---- An audit with no commit is not an audit ----------------------------- */
    assert.throws(() => compactAudit({ ...auditResult(), commitSha: 'HEAD' }), error => error.code === 'CODE_AUDIT_RESULT_INVALID');

    console.log('code audit history tests passed');
  } finally {
    await pool.end();
    await withClient(ADMIN_URL, client => client.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`));
  }
})().catch(error => { console.error(error); process.exit(1); });
