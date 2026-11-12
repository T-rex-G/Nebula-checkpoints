'use strict';

/*
 * The audit's words outside the screen: the developer brief a reader hands
 * on, and the comparison with the last audit. Both carry rules, places,
 * reasons and fixes -- never what a file or a site returned.
 */

const assert = require('assert');
const { analyse } = require('../apps/api/src/modules/uranus/index.ts');
const { checkSite } = require('../apps/api/src/modules/parallax/index.ts').siteCheck;
const reports = require('../apps/web/src/features/uranus/audit-reports.ts');
const memory = require('../apps/web/src/features/uranus/audit-memory.ts');
const sbom = require('../apps/web/src/features/uranus/audit-sbom.ts');
const terms = require('../apps/web/src/features/uranus/audit-terms.ts');

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
      txt: async () => [],
      transport: async input => new URL(input.url).pathname === '/.env'
        ? { statusCode: 200, headers: { 'content-type': 'text/plain' }, body: 'SECRET_KEY=canary-value\n' }
        : new URL(input.url).pathname === '/'
          ? { statusCode: 200, headers: { 'content-type': 'text/html' }, body: '<!doctype html>', tls: { protocol: 'TLSv1.3', validTo: '2099-01-01T00:00:00.000Z' } }
          : { statusCode: 404, headers: {}, body: '' }
    })),
    checkedAt: '2026-09-26T12:01:00.000Z'
  };

  /* Both halves, in order, each finding with its place, reason, fix and prompt. */
  const both = reports.brief(result, 'sandbox/demo (main)', site);
  assert(both.startsWith('# Security audit: sandbox/demo (main)\n'));
  assert(both.indexOf('A SQL statement is built by string interpolation') < both.indexOf('# Deployed site: https://demo.example.com'));
  assert.match(both, /## S1\. An environment file is served publicly/);
  assert.match(both, /- \*\*Where:\*\* `\/\.env`/);
  assert.match(both, /\| Strict-Transport-Security \| no \|/);
  assert(!/SELECT \* FROM|canary-value|SECRET_KEY/.test(both), 'the brief never carries what was read');
  assert(!/\n\n\n/.test(both), 'no runs of blank lines');

  /* A site alone -- a provider without a repository reader -- is still a brief. */
  const siteOnly = reports.brief(null, 'group/demo (main)', site);
  assert(siteOnly.includes('# Deployed site: https://demo.example.com'));
  assert(!siteOnly.includes('| Family |'));
  assert.strictEqual(reports.allPrompts(null), '');
  assert.match(reports.allPrompts(site), /^1\. On the deployed site \(\/\.env\): /);

  /* Failed evidence remains visible in every export, even when there are no findings.
     An old saved A cannot become trusted simply because its findings list is empty. */
  for (const [state, coverage] of [
    ['partial', { state: 'partial', complete: false, reasons: ['scripts: One script could not be read.'], categories: { scripts: { state: 'partial', complete: false } } }],
    ['unknown', { state: 'unknown', complete: false, reasons: [] }],
    ['unknown', undefined]
  ]) {
    const incomplete = { ...site, findings: [], score: 100, grade: 'A', observedScore: 100, coverage };
    const brief = reports.brief(null, 'demo', incomplete);
    assert.match(brief, /\*\*Overall grade withheld\.\*\*/);
    assert(brief.includes(`Coverage ${state}. Overall grade withheld.`));
    assert.match(brief, /Observed checks scored 100\/100; this is not an overall site score/);
    assert.match(brief, /Incomplete checks cannot establish that the site is clear/);
    assert(!brief.includes('Grade **A**'));
    const sarif = JSON.parse(reports.sarif(null, incomplete)).runs[0];
    assert.strictEqual(sarif.invocations[0].executionSuccessful, false);
    assert.strictEqual(sarif.properties.grade, null);
    assert.strictEqual(sarif.properties.score, null);
    assert.strictEqual(sarif.properties.observedScore, 100);
    assert.strictEqual(sarif.properties.coverage.state, state);
    const csv = reports.csv(null, incomplete);
    assert(csv.includes(`coverage-${state}`));
    assert(csv.includes('Overall grade withheld'));
    if (coverage && coverage.reasons.length) {
      assert(brief.includes(coverage.reasons[0]));
      assert(csv.includes(coverage.reasons[0]));
    } else assert(brief.includes('Coverage evidence is unavailable; run the check again.'));
  }
  assert.strictEqual(site.coverage.complete, true, 'the baseline fixture supplies each required evidence source');
  assert.strictEqual(JSON.parse(reports.sarif(null, site)).runs[0].invocations[0].executionSuccessful, true);
  assert.match(siteOnly, /Coverage complete within the stated request and resource limits/);

  /* What a finding adds to its rule travels with it: the credential's kind, the advisories, the fix first. */
  const token = `gh${'p'}_${'B'.repeat(36)}`;
  const richFiles = [
    { path: 'scripts/release.sh', text: `export GITHUB_TOKEN=${token}\n` },
    { path: 'package.json', text: JSON.stringify({ dependencies: { lodash: '4.17.15' } }, null, 2) }
  ];
  const rich = {
    ...analyse({ files: richFiles, paths: richFiles.map(file => file.path), advisories: new Map([['npm:lodash@4.17.15', { advisories: [
      { id: 'GHSA-35jh-r3h4-6jhm', cve: 'CVE-2021-23337', rated: true, severity: 'serious', summary: 'Command Injection in lodash', fixed: '4.17.21', malicious: false }
    ] }]]) }),
    commitSha: 'd'.repeat(40),
    coverage: { read: 2, eligible: 2, packages: {}, advisories: { versions: 1, checked: 1, unknown: 0, notChecked: 0, lockfiles: 1, lockfilesRead: 0 }, skipped: {} }
  };
  const richBrief = reports.brief(rich, 'sandbox/demo (main)', null);
  assert.match(richBrief, /\*\*Fix first:\*\*\n\n1\. A credential is committed to the repository — `scripts\/release\.sh:1`/);
  assert.match(richBrief, /- \*\*Credential:\*\* GitHub access token/);
  assert.match(richBrief, /- \*\*Package:\*\* lodash 4\.17\.15\n- \*\*Fixed in:\*\* 4\.17\.21\n- \*\*Advisories:\*\* GHSA-35jh-r3h4-6jhm \(CVE-2021-23337\)/);
  assert.match(richBrief, /1 of 1 package versions checked against OSV/);
  assert.match(richBrief, /a lockfile was not read \(over 512 KB or past the budget\), so declared ranges stood in for installed versions/);
  assert(!richBrief.includes(token), 'the credential is never in the brief');

  /* Each finding is filed under its CWE and OWASP category in the brief. */
  assert.match(both, /- \*\*Standards:\*\* CWE-89 \(SQL Injection\) · OWASP A05:2025 Injection · CWE Top 25 \(2025\) #2/);

  /* A waiver travels with the brief, the SARIF and the CSV -- listed, with its reason, never scored. */
  const waivedFiles = [
    { path: 'src/nonce.js', text: 'const token = Math.random(); // nv-audit-ignore SEC-005 -- display nonce | not a secret\n' },
    { path: 'api/users.js', text: "app.get('/u/:id', async (req, res) => {\n  await db.query(`SELECT * FROM users WHERE id = ${req.params.id}`);\n});\n" },
    { path: 'api/legacy.js', text: 'db.query(`SELECT * FROM logs WHERE day = ${day}`);\n' },
    { path: '=cmd|calc!A1.js', text: 'const sessionToken = Math.random();\n' }
  ];
  const waivedResult = { ...analyse({ files: waivedFiles, paths: waivedFiles.map(file => file.path) }), commitSha: 'e'.repeat(40), ref: 'main',
    coverage: { read: 3, eligible: 3, packages: {}, skipped: {} } };
  assert.strictEqual(waivedResult.suppressed.length, 1);
  const waivedBrief = reports.brief(waivedResult, 'sandbox/demo (main)', null);
  assert.match(waivedBrief, /## Waived in code\n\nNot scored\./);
  /* Each finding says how sure it is; a traced one carries its route and path, a lead the check that settles it. */
  assert.match(waivedBrief, /- \*\*Verdict:\*\* confirmed \(path traced\)\n- \*\*Rule:\*\* SEC-001\n- \*\*Where:\*\* `api\/users\.js:2`\n- \*\*Reached through:\*\* `GET \/u\/:id` — open to anyone\n- \*\*Traced path:\*\* Enters `api\/users\.js:2` \(.+\) → Reaches `api\/users\.js:2` \(used in .+\)/);
  assert.match(waivedBrief, /- \*\*Verdict:\*\* to confirm \(pattern only\)/);
  assert.match(waivedBrief, /\*\*What is unknown\.\*\* .+\n\n\*\*How to confirm\.\*\* /);
  assert.match(waivedBrief, /## Coverage\n\n\| Class \| Status \| What was read \|/);
  assert.match(waivedBrief, /\| Business logic \| Not assessed \|/);
  assert.match(waivedBrief, /by Uranus 2\.4\.0\.\n\d+ confirmed, \d+ to confirm\./);
  assert.match(waivedBrief, /\| SEC-005 \| .+ \| `src\/nonce\.js:1` \| display nonce \\\| not a secret \|/, 'a pipe in the reason cannot break the table');

  /* SARIF 2.1.0: rules once each, tagged with their CWE; results at file and line; a waiver as an in-source suppression. */
  const report = JSON.parse(reports.sarif(waivedResult, site, { ref: 'main', repositoryUri: 'https://github.com/sandbox/demo', version: '1.2.3' }));
  assert.strictEqual(report.version, '2.1.0');
  assert.strictEqual(report.runs.length, 2, 'one run for the repository, one for the site');
  const [repoRun, siteRun] = report.runs;
  assert.strictEqual(repoRun.tool.driver.name, 'Nebulaverse-X Uranus');
  const ruleIds = repoRun.tool.driver.rules.map(rule => rule.id);
  assert.strictEqual(new Set(ruleIds).size, ruleIds.length, 'each rule is described once');
  const sqlRule = repoRun.tool.driver.rules.find(rule => rule.id === 'SEC-001');
  assert(sqlRule.properties.tags.includes('external/cwe/cwe-89'));
  assert(sqlRule.properties.tags.includes('owasp-a05-2025'));
  assert(sqlRule.properties.tags.includes('cwe-top25-2025'), 'a Top 25 weakness is tagged so a dashboard can filter by it');
  assert.strictEqual(sqlRule.properties['cwe-top25-2025-rank'], 2);
  assert.strictEqual(sqlRule.properties['owasp-basis'], 'cwe');
  assert.strictEqual(sqlRule.properties['security-severity'], '9.5');
  assert.strictEqual(sqlRule.helpUri, 'https://cwe.mitre.org/data/definitions/89.html');
  const sqlResult = repoRun.results.find(item => item.ruleId === 'SEC-001' && item.locations[0].physicalLocation.artifactLocation.uri === 'api/users.js');
  assert.strictEqual(sqlResult.level, 'error');
  assert.deepStrictEqual(sqlResult.locations[0].physicalLocation.region, { startLine: 2 });
  assert.strictEqual(sqlResult.properties.verdict, 'confirmed');
  assert.strictEqual(sqlResult.properties.evidence, 'traced');
  assert.deepStrictEqual(sqlResult.properties.reach, { method: 'GET', route: '/u/:id', auth: 'open' });
  /* The traced path travels as a code flow a dashboard can step through: where the value entered, where it was used. */
  assert.deepStrictEqual(sqlResult.codeFlows[0].threadFlows[0].locations.map(step => [step.kinds[0], step.location.physicalLocation.region.startLine]), [['source', 2], ['sink', 2]]);
  /* A lead is a note to review, never an error that fails a build, and says how to confirm it. */
  const lead = repoRun.results.find(item => item.ruleId === 'SEC-001' && item.locations[0].physicalLocation.artifactLocation.uri === 'api/legacy.js');
  assert.strictEqual(lead.level, 'note');
  assert.strictEqual(lead.kind, 'review');
  assert.strictEqual(lead.properties.verdict, 'needs-validation');
  assert(lead.properties.howToConfirm.length > 20);
  assert(!lead.codeFlows);
  assert.strictEqual(repoRun.properties.engine, 'Uranus 2.4.0');
  assert(repoRun.properties.coverage.some(entry => entry.class === 'logic' && entry.status === 'not-assessed'));
  assert.strictEqual(repoRun.tool.driver.rules[sqlResult.ruleIndex].id, 'SEC-001', 'ruleIndex points at its rule');
  assert(sqlResult.partialFingerprints['nebulaverseFinding/v1']);
  const waivedSarif = repoRun.results.filter(item => item.suppressions);
  assert.strictEqual(waivedSarif.length, 1);
  assert.deepStrictEqual(waivedSarif[0].suppressions, [{ kind: 'inSource', justification: 'display nonce | not a secret' }]);
  assert.deepStrictEqual(repoRun.versionControlProvenance, [{ repositoryUri: 'https://github.com/sandbox/demo', revisionId: 'e'.repeat(40), branch: 'main' }]);
  assert.strictEqual(repoRun.tool.driver.semanticVersion, '1.2.3');
  const envResult = siteRun.results.find(item => item.ruleId === 'WEB-001');
  assert.strictEqual(envResult.locations[0].logicalLocations[0].fullyQualifiedName, 'https://demo.example.com /.env');
  const sarifText = reports.sarif(waivedResult, site);
  assert(!/SELECT \* FROM|canary-value|SECRET_KEY/.test(sarifText), 'SARIF never carries what was read');
  assert.strictEqual(JSON.parse(reports.sarif(null, site)).runs.length, 1);

  /* CSV: a header, a row per finding, waived rows marked, and nothing a spreadsheet would run. */
  const table = reports.csv(waivedResult, site, null);
  const rows = table.trim().split('\r\n');
  assert.strictEqual(rows[0], 'Source,Status,Severity,Verdict,Rule,Title,Detail,Family,CWE,CWE Top 25 (2025),OWASP,Location,Line,Reached through,Risk,Known exploited,EPSS,Dependency reach,How to confirm,Reason waived,Due by,Fix');
  assert(rows.some(row => row.includes(',CWE-89,#2,A05:2025,')), 'the rank and the 2025 category travel with the row');
  assert(rows.some(row => row.startsWith('repository,open,critical,confirmed,SEC-001,') && row.includes(',api/users.js,2,GET /u/:id (open),,')), 'a confirmed finding carries its route and no check');
  assert(rows.some(row => row.startsWith('repository,open,critical,to confirm,SEC-001,') && row.includes(',api/legacy.js,1,,')), 'a lead says it is one');
  assert.strictEqual(rows.length, 1 + waivedResult.findings.length + waivedResult.suppressed.length + site.findings.length);
  assert(rows.some(row => row.startsWith('repository,waived,serious,confirmed,SEC-005,')));
  assert(rows.some(row => row.includes(",'=cmd|calc!A1.js,")), 'a cell that opens with = is defused');
  assert(!rows.some(row => /,=|^=/.test(row)), 'no cell opens with =');
  assert(table.endsWith('\r\n'));
  assert(!/SELECT \* FROM|canary-value|SECRET_KEY/.test(table), 'the CSV never carries what was read');
  const quoted = reports.csv({ findings: [{ id: 'x', rule: 'SEC-001', severity: 'critical', title: 'Say "hi", then go', category: 'code', path: 'a.js', line: 2, fix: 'line one\nline two' }], categories: [] }, null, null);
  assert(quoted.includes('"Say ""hi"", then go"'), 'quotes are doubled inside a quoted cell');
  assert(quoted.includes('"line one\nline two"'));

  /* Exploit intelligence and reach travel with every export, and the brief ranks the packages by risk. */
  const { riskyResult } = require('./e2e/code-audit-risk-fixture');
  const risky = riskyResult();
  const riskyBrief = reports.brief(risky, 'sandbox/demo (main)', null);
  assert.match(riskyBrief, /Grade \*\*F\*\* — \d+\/100 \(held below 50 by a vulnerability exploited in the wild\)\./);
  assert.match(riskyBrief, /## Dependency risk\n\nRanked by exploitation in the wild, exploit probability and reach\./);
  assert.match(riskyBrief, /Sources: CISA’s Known Exploited Vulnerabilities catalog 2026\.09\.27 \(1,728 CVEs\) · FIRST EPSS scores for 4 of 4 CVEs\./);
  const riskRows = riskyBrief.split('\n').filter(line => /^\| \d+ (urgent|high|moderate|low) \|/.test(line));
  assert.deepStrictEqual(riskRows.map(line => line.split('|')[2].trim()), ['jquery 3.4.1', 'qs 6.7.0', 'lodash 4.17.15', 'systeminformation 5.3.0'], 'exploited and shipping first, then by risk');
  assert.match(riskRows[3], /\| yes — CVE-2021-21315 \| 91% \(CVE-2021-21315\) \| Dev only \|$/);
  assert.match(riskyBrief, /- \*\*Reach:\*\* Installed for production\. Only tests import it \(test\/format\.test\.js\)/);
  assert.match(riskyBrief, /4 CVEs checked against CISA KEV 2026\.09\.27 and EPSS \(4 scored\)/);
  const riskyCsv = reports.csv(risky, null, null).trim().split('\r\n');
  const jqueryRow = riskyCsv.find(row => row.includes(',jquery 3.4.1 → 3.5.0,'));
  assert(jqueryRow, 'the package, its version and its fix are named in the row');
  assert.match(jqueryRow, /,\d+ urgent,yes \(CVE-2020-11023\),84\.89% \(CVE-2020-11023\),imported,/, 'risk, catalog, EPSS and reach in their columns');
  const riskySarif = JSON.parse(reports.sarif(risky, null));
  const qsResult = riskySarif.runs[0].results.find(item => item.properties.epssCve === 'CVE-2022-24999');
  assert.strictEqual(qsResult.properties.knownExploited, false);
  assert.strictEqual(qsResult.properties.dependencyReach, 'transitive');
  assert.strictEqual(qsResult.properties['security-severity'], '7.5', 'the advisory’s own CVSS, for a dashboard to sort by');
  assert.strictEqual(riskySarif.runs[0].properties.exploitSources.kevVersion, '2026.09.27');
  const riskyPrompts = reports.allPrompts(risky);
  assert.match(riskyPrompts, /CISA lists CVE-2020-11023 as exploited in the wild/);

  /* The bill of materials: every component once, by package URL, with the vulnerabilities found against it. */
  const bom = JSON.parse(sbom.cyclonedx(risky, { name: 'sandbox/demo', ref: 'main' }));
  assert.strictEqual(bom.bomFormat, 'CycloneDX');
  assert.strictEqual(bom.specVersion, '1.5');
  assert.match(bom.serialNumber, /^urn:uuid:[0-9a-f-]{36}$/);
  assert.deepStrictEqual(bom.components.map(component => component.purl).sort(), risky.components.map(component => component.purl).sort());
  const jquery = bom.vulnerabilities.find(vulnerability => vulnerability.id === 'GHSA-jpcq-cgw6-v4j6');
  assert.deepStrictEqual(jquery.affects, [{ ref: 'pkg:npm/jquery@3.4.1' }]);
  assert.deepStrictEqual(jquery.ratings, [{ source: { name: 'OSV' }, score: 6.1, method: 'CVSSv3', severity: 'medium' }]);
  assert(jquery.properties.some(property => property.name === 'nebulaverse:cisa-kev' && property.value === 'true'));
  assert.strictEqual(jquery.references[0].id, 'CVE-2020-11023');
  assert.deepStrictEqual(bom.dependencies.find(entry => entry.ref === 'root').dependsOn.sort(), ['pkg:npm/express@4.17.1', 'pkg:npm/jquery@3.4.1', 'pkg:npm/lodash@4.17.15', 'pkg:npm/systeminformation@5.3.0']);
  assert.deepStrictEqual(bom.dependencies.find(entry => entry.ref === 'pkg:npm/express@4.17.1').dependsOn.sort(), ['pkg:npm/body-parser@1.19.0', 'pkg:npm/qs@6.7.0']);
  assert.strictEqual(bom.components.find(component => component.name === 'systeminformation').scope, 'optional', 'a development dependency is optional');
  const spdxDocument = JSON.parse(sbom.spdx(risky, { name: 'sandbox/demo', repositoryUri: 'https://github.com/sandbox/demo' }));
  assert.strictEqual(spdxDocument.spdxVersion, 'SPDX-2.3');
  assert.strictEqual(spdxDocument.packages.length, risky.components.length + 1);
  assert.match(spdxDocument.creationInfo.created, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  const root = spdxDocument.packages[0];
  assert.strictEqual(root.SPDXID, 'SPDXRef-Root');
  const devRelation = spdxDocument.relationships.find(relation => relation.relationshipType === 'DEV_DEPENDENCY_OF');
  assert.strictEqual(spdxDocument.packages.find(item => item.SPDXID === devRelation.spdxElementId).name, 'systeminformation');
  const jqueryPackage = spdxDocument.packages.find(item => item.name === 'jquery');
  assert(jqueryPackage.externalRefs.some(ref => ref.referenceCategory === 'SECURITY' && ref.referenceLocator === 'https://osv.dev/vulnerability/GHSA-jpcq-cgw6-v4j6'));
  assert(!/format\.test\.js|\$\('#app'\)/.test(sbom.cyclonedx(risky, {}) + sbom.spdx(risky, {})), 'the SBOM names packages, never a line of code');
  assert.match(reports.brief(risky, 'sandbox/demo (main)', null), /6 components in the bill of materials \(npm\)/);

  /*
   * The team's decisions and the clocks travel with every export: a decision
   * in force is an accepted external suppression with who, when, until when
   * and the reason in words; an open finding says when it is due, and that it
   * is late when it is.
   */
  {
    const { applyTriage } = require('../apps/api/src/modules/uranus/index.ts').auditTriage;
    const [sql, ...others] = result.findings;
    assert(others.length, 'the fixture has findings left open beside the decided one');
    const clocked = {
      ...result,
      findings: [sql, ...others.map(finding => ({ ...finding,
        clock: { state: 'overdue', days: 30, firstSeenAt: '2026-08-01T00:00:00.000Z', dueAt: '2026-08-31T00:00:00.000Z', daysLeft: -26, clock: 'severity' } }))]
    };
    const decided = applyTriage(clocked, new Map([[sql.id, {
      findingId: sql.id, rule: sql.rule, disposition: 'accepted-risk', reason: 'fix-scheduled',
      decidedBy: 'alpha-tester', decidedAt: '2026-09-20T09:00:00.000Z', expiresAt: '2026-12-19T09:00:00.000Z'
    }]]), { now: Date.parse('2026-09-26T12:00:00.000Z') });
    assert.strictEqual(decided.findings.length, others.length, 'the decided finding leaves the open list');
    const justification = 'Risk accepted by alpha-tester on 2026-09-20, until 2026-12-19: A fix is scheduled.';

    const run = JSON.parse(reports.sarif(decided, null)).runs[0];
    const accepted = run.results.find(item => item.suppressions);
    assert.strictEqual(accepted.ruleId, sql.rule);
    assert.deepStrictEqual(accepted.suppressions, [{ kind: 'external', status: 'accepted', justification }]);
    const late = run.results.find(item => !item.suppressions);
    assert.deepStrictEqual([late.properties.clock, late.properties.dueBy], ['overdue', '2026-08-31T00:00:00.000Z']);

    const lines = reports.csv(decided, null, null).trim().split('\r\n');
    const acceptedRow = lines.find(row => row.startsWith('repository,risk accepted,'));
    assert(acceptedRow, 'a decided finding is listed with its decision as its status');
    assert(acceptedRow.includes(`,"${justification}",`) || acceptedRow.includes(`,${justification},`), 'the reason column carries the decision in words');
    assert(lines.some(row => row.startsWith('repository,open,') && row.includes(',2026-08-31 (overdue),')), 'Due by says when, and that it is late');

    const text = reports.brief(decided, 'sandbox/demo (main)', null);
    assert.match(text, /## Triaged by the team\n\nNot scored\./);
    assert(text.includes(`| ${sql.rule} | `) && text.includes(justification), 'the brief lists the decision with its reason');
    assert.match(text, /- \*\*Due by:\*\* 2026-08-31 \(overdue\) — 30 days from 2026-08-01, when it was first seen/);
    assert(!/fix-scheduled/.test(text + reports.csv(decided, null, null)), 'a reason is said in words, never as its key');
  }

  /* The comparison: identities only, new and resolved. */
  assert.strictEqual(memory.diff(result, null), null);
  const changed = memory.diff(result, { engine: `repository:${result.engine.version}`, at: '2026-09-25T00:00:00.000Z', ids: [result.findings[0].id, 'f'.repeat(24)] });
  assert.equal(memory.diff(result, { engine: 'repository:2.0.0', ids: ['legacy'] }), null, 'engine changes start a fresh comparison');
  assert.equal(memory.diff(result, { ids: ['legacy'] }), null, 'unversioned browser history is not compared with new identities');
  assert.strictEqual(changed.resolved, 1);
  assert.strictEqual(changed.newIds.size, result.findings.length - 1);
  assert.strictEqual(memory.storageKey('Sandbox/Demo'), 'nv_audit:sandbox/demo');

  /* A kept audit exports from what it kept, says so, and says when fewer findings were kept than found. */
  {
    const { describeKept } = require('../apps/api/src/modules/uranus/index.ts').auditHistory;
    const audit = { id: '00000000-0000-4000-8000-000000000001', ref: 'main', commitSha: 'a'.repeat(40), engine: '2.3.0', auditedAt: '2026-10-01T10:00:00.000Z',
      score: 41, grade: 'F', capReason: 'critical', counts: { critical: 1, serious: 1, warning: 4 }, toConfirm: 1, exploited: 1,
      files: { read: 40, eligible: 40, complete: true }, findings: { total: 6, stored: 3 } };
    const findings = [
      { id: 'f1', rule: 'SEC-001', title: 'A SQL statement is built by string interpolation', category: 'code', severity: 'critical', verdict: 'confirmed', path: 'api/users.js', line: 4, package: null, risk: null, reach: null, exploited: false, ransomware: false, epss: null, firstSeenAt: '2026-09-20T00:00:00.000Z', waived: null },
      { id: 'f2', rule: 'DEP-003', title: 'A dependency has a published vulnerability', category: 'dependencies', severity: 'serious', verdict: 'confirmed', path: 'package-lock.json', line: 12,
        package: { ecosystem: 'npm', name: 'jquery', version: '3.4.1', fixed: '3.5.0', advisories: ['GHSA-gxr4-xjj5-5px2'], cves: ['CVE-2020-11022'], cvss: 6.1 }, risk: { score: 71, band: 'high' }, reach: 'bundled', exploited: true, ransomware: false, epss: 0.0212, firstSeenAt: '2026-09-20T00:00:00.000Z', waived: null },
      { id: 'f3', rule: 'SEC-005', title: 'A non-cryptographic random number generates a secret value', category: 'code', severity: 'warning', verdict: 'confirmed', path: 'src/nonce.js', line: 1, package: null, risk: null, reach: null, exploited: false, ransomware: false, epss: null, firstSeenAt: null, waived: 'triage' }
    ].map(describeKept);
    assert(findings.every(finding => finding.why && finding.fix && finding.prompt && finding.standards), 'each kept finding carries its rule’s words');
    assert(findings[1].prompt.includes('jquery 3.4.1 -- GHSA-gxr4-xjj5-5px2; fixed in 3.5.0'));
    const keptBrief = reports.keptBrief(audit, findings, 'sandbox/demo (main)');
    assert(keptBrief.includes('Grade **F** — 41/100 (held below 50 by a confirmed critical finding).'));
    assert(keptBrief.includes('3 of 6 findings were kept, the most severe first'));
    assert(keptBrief.includes('`jquery 3.4.1 (package-lock.json)`'));
    assert(keptBrief.includes('- **Exploited in the wild:** yes'));
    assert(keptBrief.includes('| SEC-005 | A non-cryptographic random number generates a secret value | `src/nonce.js:1` | triaged by the team |'));
    assert(!/## \d+\. A non-cryptographic/.test(keptBrief), 'a triaged finding is not listed as open');
    const keptRows = reports.keptCsv(audit, findings).trim().split('\r\n');
    assert.strictEqual(keptRows.length, 1 + findings.length + 1, 'a row per kept finding and one for the note');
    assert(keptRows[2].includes('jquery,3.4.1,3.5.0,GHSA-gxr4-xjj5-5px2,71 high,yes,2.12%,bundled'));
    assert(keptRows[3].includes('triaged by the team'));
    assert(keptRows[4].includes('3 of 6 findings were kept'));
    const keptRun = JSON.parse(reports.keptSarif(audit, findings, { repositoryUri: 'https://github.com/sandbox/demo' })).runs[0];
    assert.strictEqual(keptRun.properties.findingsKept, 3);
    assert.strictEqual(keptRun.properties.findingsTotal, 6);
    assert.strictEqual(keptRun.results[1].properties.dependencyReach, 'bundled');
    assert.strictEqual(keptRun.results[2].suppressions[0].justification, 'Triaged by the team.');
    assert.strictEqual(keptRun.versionControlProvenance[0].revisionId, audit.commitSha);
  }

  /* A count the server could not establish is never shown as zero. */
  {
    const known = memory.diffSentence({ newIds: new Set(['a', 'b']), resolved: 1, previousAt: null });
    assert.strictEqual(known, '2 new findings, 1 resolved.');
    const unknown = memory.diffSentence({ newIds: new Set(['a']), resolved: null, previousAt: null });
    assert(!/\b0 resolved\b/.test(unknown) && unknown.startsWith('1 new finding.'), unknown);
    assert(/Nothing is counted as resolved: this audit did not have the evidence to prove a fix/.test(unknown), 'the reader is told why nothing is counted as resolved');
  }

  /*
   * One risk row per package version, with the places that declare it.
   * Ranking again -- a redraw, a brief written from the same result --
   * counts the same places again: the count used to be kept beside each
   * finding and grew by one with every ranking.
   */
  {
    const twice = riskyResult();
    const jquery = twice.findings.find(finding => finding.detail && finding.detail.package === 'jquery');
    twice.findings.push({ ...jquery, id: `${jquery.id}-site`, path: 'site/package-lock.json' });
    const first = terms.riskRanked(twice.findings);
    assert.deepStrictEqual(first.map(row => [row.finding.detail.package, row.places]),
      [['jquery', 2], ['qs', 1], ['lodash', 1], ['systeminformation', 1]], 'one row a version, counting the places that declare it');
    reports.brief(twice, 'sandbox/demo (main)', null);
    assert.deepStrictEqual(terms.riskRanked(twice.findings).map(row => row.places), first.map(row => row.places), 'ranking again counts the same places');
    assert.strictEqual(reports.brief(twice, 'x', null).split('\n').filter(line => /^\| \d+ \w+ \| jquery /.test(line)).length, 1, 'the brief lists the version once');
    const advisory = JSON.parse(sbom.cyclonedx(twice, {})).vulnerabilities.find(vulnerability => vulnerability.id === 'GHSA-jpcq-cgw6-v4j6');
    assert.deepStrictEqual(advisory.affects, [{ ref: 'pkg:npm/jquery@3.4.1' }], 'an advisory found twice affects its package once');
  }

  /*
   * What this browser remembers: identities and the engine only, read back
   * as written; a result without its findings is not remembered, and is
   * not compared, rather than counting every earlier finding as resolved.
   */
  {
    const store = new Map();
    const before = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
      getItem: key => (store.has(key) ? store.get(key) : null), setItem: (key, value) => store.set(key, String(value))
    } });
    try {
      memory.remember('Sandbox/Demo', result);
      assert.deepStrictEqual([...store.keys()], ['nv_audit:sandbox/demo']);
      const kept = memory.readPrevious('sandbox/DEMO');
      assert.deepStrictEqual(Object.keys(kept), ['at', 'engine', 'ids']);
      assert.deepStrictEqual(kept.ids, result.findings.map(finding => finding.id));
      assert.strictEqual(kept.engine, `repository:${result.engine.version}`);
      assert.strictEqual(memory.diff(result, kept).newIds.size, 0);
      assert.strictEqual(memory.diff(result, kept).resolved, 0);
      memory.remember('other/repo', { auditedAt: 'x' });
      assert(!store.has('nv_audit:other/repo'), 'a result without findings is not remembered');
      assert.strictEqual(memory.diff({ engine: result.engine }, kept), null, 'nor compared');
      store.set('nv_audit:broken/repo', '{not json');
      assert.strictEqual(memory.readPrevious('broken/repo'), null, 'a damaged record reads as none');
    } finally {
      if (before) Object.defineProperty(globalThis, 'localStorage', before);
      else delete globalThis.localStorage;
    }
    assert.strictEqual(memory.readPrevious('sandbox/demo'), null, 'no storage reads as no record');
    assert.strictEqual(memory.diffSentence({ newIds: new Set(['a']), resolved: 2, previousAt: 'not a time' }), '1 new finding, 2 resolved.', 'a time that is none is not said');
    assert.strictEqual(memory.diff(result, { engine: 'site:3', ids: [] }), null, 'a site check is not compared with a repository audit');
  }

  /*
   * A word the audit does not know is said as sent, and never looked up
   * among the properties every object has: a check named `constructor` is
   * not the source of a function, and a risk band named `toString` writes
   * its score without a band rather than failing the whole export.
   */
  {
    const odd = {
      ...site,
      ledger: [{ id: 'constructor', state: 'toString', detail: 'two\nlines | here' }],
      headers: [{ name: 'hasOwnProperty', present: true }]
    };
    const text = reports.brief(null, 'odd', odd);
    assert(text.includes('| constructor | toString | two lines \\| here |'), 'unknown names are said as sent, on one table line');
    assert(text.includes('| hasOwnProperty | yes |'));
    assert(!/function|\[native code\]|\[object Object\]|undefined/.test(text), 'nothing of an object is written for a name');
    const banded = riskyResult();
    for (const finding of banded.findings) if (finding.detail && finding.detail.risk) finding.detail.risk = { ...finding.detail.risk, band: 'toString' };
    const bandless = reports.brief(banded, 'x', null);
    assert.match(bandless, /- \*\*Risk:\*\* \d+\/100\n/, 'a band that is no band is not said');
    assert(!/function|\[native code\]|undefined/.test(bandless));
    assert.deepStrictEqual(terms.severityCounts([{ severity: 'critical' }, { severity: 'info' }, { severity: 'constructor' }, null]), { critical: 1, serious: 0, warning: 0 });
    assert.strictEqual(terms.ledgerStatus({ id: 'logic', status: 'toString' }), 'not-assessed');
    assert.strictEqual(terms.tierWord({ tier: 'constructor' }), 'Reach unknown');
  }

  /* A finding exploited in the wild that names no catalog entry says yes, with nothing empty after it. */
  {
    const unnamed = riskyResult();
    for (const finding of unnamed.findings) if (finding.detail && finding.detail.intel && finding.detail.intel.exploited) finding.detail.intel = { ...finding.detail.intel, kev: null };
    const rows = reports.csv(unnamed, null, null).split('\r\n');
    assert(rows.some(row => /,\d+ urgent,yes,/.test(row)), 'the CSV says yes');
    assert(!rows.some(row => row.includes('yes ()')));
    assert(!/yes — \|/.test(reports.brief(unnamed, 'x', null)));
  }

  /* A result that does not say how many files it read is not said to have read "undefined" of them. */
  {
    const uncounted = { ...result, coverage: {} };
    const line = terms.coverageLine(uncounted);
    assert(line.startsWith(`How many files were read at ${'c'.repeat(7)} was not recorded`), line);
    assert(!/undefined/.test(reports.brief(uncounted, 'x', null)));
  }

  /*
   * An export of a value that is not an audit says what it can and fails
   * nothing: every format is still its format, and no word of an object
   * reaches a reader.
   */
  for (const value of [{}, { findings: 'none', suppressed: {}, categories: null, ledger: 7, components: [null, 3, { purl: 'pkg:npm/x@1', dependsOn: 'y' }] }]) {
    const said = reports.brief(value, 'x', { origin: 'https://x.example', findings: null, headers: 'no' });
    assert(said.startsWith('# Security audit: x'));
    assert(!/undefined|\[object Object\]|NaN/.test(said), said);
    assert.strictEqual(JSON.parse(reports.sarif(value, { findings: {} }, {})).runs.length, 2);
    assert(reports.csv(value, null, null).startsWith('Source,Status,'));
    assert.strictEqual(JSON.parse(sbom.cyclonedx(value, {})).bomFormat, 'CycloneDX');
    assert.strictEqual(JSON.parse(sbom.spdx(value, {})).spdxVersion, 'SPDX-2.3');
    assert.strictEqual(reports.allPrompts(value), '');
    assert(reports.keptBrief(value, 'none', 'x').startsWith('# Security audit: x'));
    assert(reports.keptCsv(value, [{}]).startsWith('Audit,Commit,'));
    assert.strictEqual(JSON.parse(reports.keptSarif(value, [null, {}])).runs[0].results.length, 2);
    assert(reports.exposureCsv('none').startsWith('Severity,Credential,'));
    assert.strictEqual(JSON.parse(reports.exposureSarif([{}], {})).runs[0].results.length, 1);
  }

  /* The words the screen shares with the exports: a clock, the headline, the coverage a class is said to have had. */
  {
    assert.strictEqual(terms.clockWords({ state: 'overdue', daysLeft: 0 }), '1 day overdue', 'overdue is at least a day late');
    assert.strictEqual(terms.clockWords({ state: 'overdue', daysLeft: -26 }), '26 days overdue');
    assert.strictEqual(terms.clockWords({ state: 'due-soon', daysLeft: 0 }), 'Due today');
    assert.strictEqual(terms.clockWords({ state: 'due-soon', daysLeft: 1 }), 'Due in 1 day');
    assert.strictEqual(terms.headline(null, 'idle'), 'Not audited yet');
    assert.strictEqual(terms.headline(result, 'running'), 'Auditing this branch…');
    assert.strictEqual(terms.headline(result, 'done'), '3 warnings, nothing serious', 'the critical SQL finding is a lead to confirm, not an issue');
    assert.strictEqual(terms.headline({ findings: [{ severity: 'critical', verdict: 'confirmed' }, { severity: 'critical' }] }, 'done'), '2 critical issues to fix', 'a finding from before verdicts is confirmed');
    assert.strictEqual(terms.headline({ findings: [{ severity: 'critical', verdict: 'needs-validation' }] }, 'done'), '1 lead to confirm, nothing confirmed', 'a lead is never an issue');
    assert.strictEqual(terms.headline({ findings: [] }, 'done'), 'Nothing found in what was read');
    assert.match(reports.brief(result, 'x', null), /\| Injection \| Traced \|/, 'a class Uranus traces says it traced');
    assert.match(reports.brief(result, 'x', null), /\| Configuration \| Checked \|/);
    assert.strictEqual(terms.siteAssessment({ coverage: { complete: true, state: 'partial' } }).complete, false, 'complete only when the state says so too');
  }

  /* Probabilities and ranks as a reader says them, never claiming more than they are. */
  {
    assert.deepStrictEqual([0.8489, 0.21, 0.0212, 0.01, 0.0004, 0.00001, 'x'].map(terms.percent), ['85%', '21%', '2.1%', '1%', '0.04%', '<0.01%', '']);
    assert.deepStrictEqual([0.9971, 0.5, 0.05, 'x'].map(terms.rank), ['99.7%', '50%', '5%', '']);
  }

  /* A package that comes with another is said to: by name in a row, and in the brief's risk table. */
  {
    assert.strictEqual(terms.tierWord({ tier: 'transitive', through: ['express', 'body-parser'] }), 'Via express');
    assert.strictEqual(terms.tierWord({ tier: 'transitive', through: [] }), 'Via a dependency');
    assert.match(reports.brief(riskyResult(), 'x', null), /\| qs 6\.7\.0 \| no \| [^|]+ \| Via express \|/);
  }

  /* Exploited in something that ships ranks first, whatever the scores. */
  {
    const finding = (name, score, exploitedNow) => ({ id: name, rule: 'DEP-003', severity: 'serious',
      detail: { package: name, version: '1.0.0', ecosystem: 'npm', risk: { score, band: 'high' }, intel: { exploited: exploitedNow }, usage: { tier: 'imported' } } });
    assert.deepStrictEqual(terms.riskRanked([finding('quiet', 90, false), finding('loud', 40, true)]).map(row => row.finding.id), ['loud', 'quiet']);
  }

  /* What the exploit intelligence could not establish is said in the caveat, each in its own words. */
  {
    const caveat = exploit => terms.coverageCaveat({ ...result, coverage: { ...result.coverage, exploit } });
    assert.match(caveat({ cves: 3, asked: 3, kev: 'ok', kevStale: true, epss: 'ok' }), /the exploited-vulnerability catalog is an earlier copy, because a refresh failed/);
    assert.match(caveat({ cves: 3, asked: 3, kev: 'unavailable', epss: 'ok' }), /CISA’s exploited-vulnerability catalog could not be read, so existing exploit evidence must be treated as last known rather than current/);
    assert.match(caveat({ cves: 3, asked: 3, kev: 'ok', epss: 'unavailable' }), /EPSS could not be reached, so no exploit probability is shown/);
    assert.match(caveat({ cves: 3, asked: 3, kev: 'ok', epss: 'partial' }), /some EPSS requests went unanswered/);
    assert.match(caveat({ cves: 5, asked: 3, kev: 'ok', epss: 'ok' }), /2 CVEs beyond the lookup limit have no exploit data/);
    assert.strictEqual(caveat({ cves: 3, asked: 3, kev: 'ok', epss: 'ok' }), '', 'a complete reading carries no caveat');
  }

  /* A false positive is listed as one. */
  {
    const { applyTriage } = require('../apps/api/src/modules/uranus/index.ts').auditTriage;
    const [lead] = result.findings;
    const dismissed = applyTriage(result, new Map([[lead.id, { findingId: lead.id, rule: lead.rule, disposition: 'false-positive', reason: 'test-code', decidedBy: 'alpha-tester', decidedAt: '2026-09-20T09:00:00.000Z' }]]), { now: Date.parse('2026-09-26T12:00:00.000Z') });
    assert(reports.csv(dismissed, null, null).split('\r\n').some(row => row.startsWith(`repository,false positive,critical,to confirm,${lead.rule},`)));
  }

  /* A site check is compared with the site check before it, by the engine that made it. */
  {
    assert.strictEqual(memory.engineIdentity({ engine: 3 }), 'site:3');
    assert.strictEqual(memory.engineIdentity({ engine: { version: '2.4.0' } }), 'repository:2.4.0');
    assert.strictEqual(memory.engineIdentity({ engine: {} }), null);
    const changes = memory.diff({ engine: 3, findings: [{ id: 'a' }, { id: 'c' }] }, { engine: 'site:3', at: '2026-09-25T00:00:00.000Z', ids: ['a', 'b'] });
    assert.deepStrictEqual([[...changes.newIds], changes.resolved, changes.previousAt], [['c'], 1, '2026-09-25T00:00:00.000Z']);
  }

  /* The CSV marks what is new since the last audit. */
  {
    const changes = { previousAt: null, newIds: new Set([result.findings[0].id]), resolved: 0 };
    const rows = reports.csv(result, null, changes).trim().split('\r\n').slice(1);
    assert.deepStrictEqual(rows.map(row => row.split(',')[1]), result.findings.map((finding, index) => (index === 0 ? 'new' : 'open')));
  }

  /* Exposure findings as CSV and SARIF: places and states only, an accepted risk dismissed with who accepted it. */
  {
    const rows = [
      { severity: 'critical', label: 'GitHub token', rule: 'SCR-001', where: 'scripts/release.sh', line: 3, status: 'open', inTree: true, fingerprint: 'f'.repeat(16), commit: 'abc1234', verified: 'active' },
      { severity: 'warning', label: 'AWS key', rule: 'SCR-002', where: '=cmd.js', line: null, status: 'accepted-risk', acceptedBy: 'ada', inTree: false, archive: true, encoded: true, fingerprint: 'e'.repeat(16) }
    ];
    const table = reports.exposureCsv(rows).trim().split('\r\n');
    assert.strictEqual(table[0], 'Severity,Credential,Rule,Location,Line,Status,Where,Introduced in,Provider says,Fingerprint');
    assert.strictEqual(table[2], `warning,AWS key,SCR-002,'=cmd.js,,accepted-risk,history only + archive + base64,,,${'e'.repeat(16)}`);
    const run = JSON.parse(reports.exposureSarif(rows, { ref: 'main', repositoryUri: 'https://github.com/sandbox/demo', commitSha: 'b'.repeat(40) })).runs[0];
    assert.deepStrictEqual(run.results.map(item => [item.ruleId, item.ruleIndex, item.level]), [['SCR-001', 0, 'error'], ['SCR-002', 1, 'warning']]);
    assert.deepStrictEqual(run.results[1].suppressions, [{ kind: 'external', justification: 'Risk accepted by ada' }]);
    assert.strictEqual(run.results[0].suppressions, undefined);
    assert.strictEqual(run.results[1].message.text, 'AWS key in =cmd.js, only in history.');
    assert.deepStrictEqual(run.versionControlProvenance, [{ repositoryUri: 'https://github.com/sandbox/demo', revisionId: 'b'.repeat(40), branch: 'main' }]);
    assert.strictEqual(run.automationDetails.id, 'nebulaverse-exposure/main/');
    assert.strictEqual(run.tool.driver.rules[0].properties['security-severity'], '9.5');
  }

  console.log('code audit UI tests passed');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
