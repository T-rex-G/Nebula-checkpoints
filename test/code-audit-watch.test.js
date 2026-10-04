'use strict';

/*
 * The watch: what has been published about stored components since their
 * audit, and nothing that the audit already said. Against stand-ins for OSV
 * and for CISA's catalog, recording what was asked.
 */

const assert = require('assert');
const { watchComponents } = require('../src/code-audit-watch');
const { KEV_URL, EPSS_URL, createIntelCache } = require('../src/exploit-intel');
const { compactAudit, compactAlert } = require('../src/code-audit-history');

const kevEntry = (cveID, dateAdded, dueDate, ransomware = 'Unknown') => ({ cveID, dateAdded, dueDate, knownRansomwareCampaignUse: ransomware, vendorProject: 'x', product: 'y' });
const record = (id, aliases, { name = 'jquery', ecosystem = 'npm', fixed = '3.5.0', rated = 'HIGH' } = {}) => ({
  id, aliases, summary: 'An advisory summary',
  database_specific: { severity: rated },
  affected: [{ package: { ecosystem, name }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed }] }] }]
});

function services({ vulns = {}, records = {}, kev = [], osvDown = false, kevDown = false, failNames = [] } = {}) {
  const calls = [];
  const transport = async input => {
    calls.push(input);
    if (input.url.endsWith('/querybatch')) {
      if (osvDown) throw new Error('unreachable');
      const queries = JSON.parse(input.body).queries;
      if (queries.some(query => failNames.includes(query.package.name))) return { statusCode: 503, body: '' };
      return { statusCode: 200, body: JSON.stringify({ results: queries.map(query => ({ vulns: (vulns[`${query.package.name}@${query.version}`] || []).map(id => ({ id })) })) }) };
    }
    const match = /\/vulns\/([^/]+)$/.exec(input.url);
    if (match) {
      const found = records[decodeURIComponent(match[1])];
      return found ? { statusCode: 200, body: JSON.stringify(found) } : { statusCode: 404, body: '' };
    }
    if (input.url === KEV_URL) {
      if (kevDown) throw new Error('unreachable');
      return { statusCode: 200, body: JSON.stringify({ catalogVersion: '2026.10.01', count: kev.length, vulnerabilities: kev }) };
    }
    const url = new URL(input.url);
    if (`${url.origin}${url.pathname}` === EPSS_URL) return { statusCode: 200, body: JSON.stringify({ status: 'OK', data: [] }) };
    return { statusCode: 404, body: '' };
  };
  return { transport, calls };
}

const stored = [
  { ecosystem: 'npm', name: 'jquery', version: '3.4.1', direct: true, dev: false, advisoryIds: ['GHSA-jpcq-cgw6-v4j6', 'GHSA-gxr4-xjj5-5px2'], cves: ['CVE-2020-11023', 'CVE-2020-11022'], exploitedCves: ['CVE-2020-11022'] },
  { ecosystem: 'npm', name: 'express', version: '4.17.1', direct: true, dev: false, advisoryIds: [], cves: [], exploitedCves: [] },
  { ecosystem: 'pypi', name: 'Django', version: '3.2.0', direct: false, dev: false, advisoryIds: [], cves: [], exploitedCves: [] }
];

(async () => {
  /* ---- New advisories and newly exploited CVEs, and only those -------------------- */
  {
    const { transport, calls } = services({
      vulns: {
        /* Two the audit knew, one new record that is an alias of one it knew, and one genuinely new. */
        'jquery@3.4.1': ['GHSA-jpcq-cgw6-v4j6', 'GHSA-gxr4-xjj5-5px2', 'PYSEC-2026-1', 'GHSA-new1-new1-new1'],
        'express@4.17.1': ['GHSA-rv95-896h-c2vc']
      },
      records: {
        'PYSEC-2026-1': record('PYSEC-2026-1', ['GHSA-jpcq-cgw6-v4j6']),
        'GHSA-new1-new1-new1': record('GHSA-new1-new1-new1', ['CVE-2026-0001'], { fixed: '3.7.1', rated: 'CRITICAL' }),
        'GHSA-rv95-896h-c2vc': record('GHSA-rv95-896h-c2vc', ['CVE-2024-29041'], { name: 'express', fixed: '4.19.2', rated: 'MODERATE' })
      },
      /* CVE-2020-11023 was not listed at the audit and is now; CVE-2020-11022 was already. */
      kev: [kevEntry('CVE-2020-11023', '2025-01-23', '2025-02-13'), kevEntry('CVE-2020-11022', '2024-01-01', '2024-01-22'), kevEntry('CVE-2026-0001', '2026-09-30', '2026-10-21', 'Known')]
    });
    const outcome = await watchComponents({ components: stored, advisoryTransport: transport, intelTransport: transport, intelCache: createIntelCache() });
    assert.strictEqual(outcome.state, 'ok');
    assert.deepStrictEqual([outcome.checked, outcome.total, outcome.kev], [3, 3, 'ok']);
    assert.deepStrictEqual(outcome.alerts.map(alert => [alert.kind, alert.name, alert.id || alert.cve]), [
      ['advisory', 'jquery', 'GHSA-new1-new1-new1'],
      ['exploited', 'jquery', 'CVE-2020-11023'],
      ['advisory', 'express', 'GHSA-rv95-896h-c2vc']
    ], 'exploited first; an alias of a known advisory and an already-listed CVE are not news');
    const fresh = outcome.alerts[0];
    assert.deepStrictEqual([fresh.severity, fresh.fixed, fresh.cve, fresh.exploited, fresh.ransomware, fresh.kevAdded], ['critical', '3.7.1', 'CVE-2026-0001', true, true, '2026-09-30']);
    assert.deepStrictEqual([outcome.alerts[1].kevAdded, outcome.alerts[1].kevDue], ['2025-01-23', '2025-02-13']);
    assert.deepStrictEqual(outcome.alerts[2].severity, 'warning');

    /* What left: package names, versions and identifiers, anonymously, through the two profiles. */
    for (const call of calls) {
      assert(['advisory-query', 'threat-intel'].includes(call.profile) || call.url === KEV_URL || call.url.startsWith(EPSS_URL), `unexpected request ${call.url}`);
      assert(!call.headers || !call.headers.authorization, 'anonymous');
    }
    assert(!calls.some(call => /GHSA-jpcq-cgw6-v4j6|GHSA-gxr4-xjj5-5px2/.test(call.url)), 'records the audit already had are not fetched again');

    /* Every alert fits the table it is stored in. */
    assert(outcome.alerts.every(alert => compactAlert(alert)), 'each alert is storable');
  }

  /* ---- An unanswered question is never "nothing new" ------------------------------- */
  {
    const { transport } = services({ osvDown: true, kev: [kevEntry('CVE-2020-11023', '2025-01-23', '2025-02-13')] });
    const outcome = await watchComponents({ components: stored, advisoryTransport: transport, intelTransport: transport, intelCache: createIntelCache() });
    assert.strictEqual(outcome.state, 'partial', 'CISA can answer while OSV is unavailable');
    assert.strictEqual(outcome.checked, 0);
    assert.deepStrictEqual(outcome.alerts.map(alert => alert.kind), ['exploited'], 'the catalog is still asked when OSV is down');
  }
  {
    const { transport } = services({ failNames: ['Django'], kevDown: true });
    const outcome = await watchComponents({ components: stored, advisoryTransport: transport, intelTransport: transport, intelCache: createIntelCache(), limits: { ...require('../src/code-audit-watch').LIMITS, advisoryBatch: 2 } });
    assert.strictEqual(outcome.state, 'partial', 'one failed batch of two');
    assert.deepStrictEqual([outcome.checked, outcome.total], [2, 3]);
    assert.strictEqual(outcome.kev, 'unavailable');
    assert.deepStrictEqual(outcome.alerts, [], 'an unreadable catalog never announces an exploitation');
  }
  {
    const { transport } = services();
    const outcome = await watchComponents({ components: [], advisoryTransport: transport, intelTransport: transport, intelCache: createIntelCache() });
    assert.deepStrictEqual([outcome.state, outcome.total, outcome.alerts.length], ['ok', 0, 0]);
  }

  /* ---- An audit result reduced to rows: what is kept and what is not --------------- */
  {
    const result = {
      commitSha: 'f'.repeat(40), ref: 'main', score: 48, grade: 'F', capped: true, capReason: 'exploited', auditedAt: '2026-09-29T08:00:00.000Z',
      engine: { name: 'Uranus', version: '2.0.0' }, categories: [{ id: 'code', score: 40 }, { id: 'Bad Id', score: 10 }],
      findings: [
        { id: 'a'.repeat(24), rule: 'SEC-011', category: 'code', severity: 'critical', verdict: 'needs-validation', path: 'x.js', line: 3, prompt: 'P', trace: [{ note: 'N' }] },
        { id: 'not-an-id', rule: 'SEC-011', category: 'code', severity: 'critical', path: 'y.js', line: 1 },
        { id: 'b'.repeat(24), rule: 'DEP-003', category: 'dependencies', severity: 'serious', path: 'go.mod', line: 5, detail: { ecosystem: 'go', package: 'github.com/gin-gonic/gin', version: 'v1.6.0', fixed: 'v1.9.1', advisories: [{ id: 'GO-2023-1737', cve: 'CVE-2023-29401', summary: 'S' }], cvss: 4.33, usage: { tier: 'unknown', files: ['secret/path.go'] }, risk: { score: 41.6, band: 'moderate' } } }
      ],
      suppressed: [], dependencyRisk: { exploited: 1, bands: { urgent: 1 } }, coverage: { read: 5, eligible: 9, complete: false },
      components: [{ ecosystem: 'go', name: 'github.com/gin-gonic/gin', version: 'v1.6.0', direct: false, dev: false, advisories: { ids: ['GO-2023-1737', 'bad id'], cves: ['CVE-2023-29401'], exploited: [] } }]
    };
    const compact = compactAudit(result);
    assert.deepStrictEqual([compact.audit.cap_reason, compact.audit.critical_count, compact.audit.to_confirm_count, compact.audit.findings_total, compact.audit.findings_stored], ['exploited', 2, 1, 3, 2]);
    assert.deepStrictEqual(compact.audit.category_ids, ['code'], 'a category id outside the shape is left out');
    const go = compact.findings.find(row => row.rule === 'DEP-003');
    assert.deepStrictEqual([go.package_name, go.package_version, go.fixed_version, go.cvss, go.risk_score, go.reach_tier, go.advisory_ids, go.cve_ids], ['github.com/gin-gonic/gin', 'v1.6.0', 'v1.9.1', 4.3, 42, 'unknown', ['GO-2023-1737'], ['CVE-2023-29401']]);
    assert.deepStrictEqual(compact.components[0].advisory_ids, ['GO-2023-1737']);
    const text = JSON.stringify(compact);
    for (const leaked of ['"P"', '"N"', '"S"', 'secret/path.go']) assert(!text.includes(leaked), `${leaked} must not survive compaction`);
  }

  console.log('code audit watch tests passed');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
