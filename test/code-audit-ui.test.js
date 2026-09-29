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
  const richBrief = ui.brief(rich, 'sandbox/demo (main)', null);
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
  const waivedBrief = ui.brief(waivedResult, 'sandbox/demo (main)', null);
  assert.match(waivedBrief, /## Waived in code\n\nNot scored\./);
  /* Each finding says how sure it is; a traced one carries its route and path, a lead the check that settles it. */
  assert.match(waivedBrief, /- \*\*Verdict:\*\* confirmed \(path traced\)\n- \*\*Rule:\*\* SEC-001\n- \*\*Where:\*\* `api\/users\.js:2`\n- \*\*Reached through:\*\* `GET \/u\/:id` — open to anyone\n- \*\*Traced path:\*\* Enters `api\/users\.js:2` \(.+\) → Reaches `api\/users\.js:2` \(used in .+\)/);
  assert.match(waivedBrief, /- \*\*Verdict:\*\* to confirm \(pattern only\)/);
  assert.match(waivedBrief, /\*\*What is unknown\.\*\* .+\n\n\*\*How to confirm\.\*\* /);
  assert.match(waivedBrief, /## Coverage\n\n\| Class \| Status \| What was read \|/);
  assert.match(waivedBrief, /\| Business logic \| Not assessed \|/);
  assert.match(waivedBrief, /by Uranus 2\.0\.0\.\n\d+ confirmed, \d+ to confirm\./);
  assert.match(waivedBrief, /\| SEC-005 \| .+ \| `src\/nonce\.js:1` \| display nonce \\\| not a secret \|/, 'a pipe in the reason cannot break the table');

  /* SARIF 2.1.0: rules once each, tagged with their CWE; results at file and line; a waiver as an in-source suppression. */
  const report = JSON.parse(ui.sarif(waivedResult, site, { ref: 'main', repositoryUri: 'https://github.com/sandbox/demo', version: '1.2.3' }));
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
  assert.strictEqual(repoRun.properties.engine, 'Uranus 2.0.0');
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
  const sarifText = ui.sarif(waivedResult, site);
  assert(!/SELECT \* FROM|canary-value|SECRET_KEY/.test(sarifText), 'SARIF never carries what was read');
  assert.strictEqual(JSON.parse(ui.sarif(null, site)).runs.length, 1);

  /* CSV: a header, a row per finding, waived rows marked, and nothing a spreadsheet would run. */
  const table = ui.csv(waivedResult, site, null);
  const rows = table.trim().split('\r\n');
  assert.strictEqual(rows[0], 'Source,Status,Severity,Verdict,Rule,Title,Detail,Family,CWE,CWE Top 25 (2025),OWASP,Location,Line,Reached through,Risk,Known exploited,EPSS,Dependency reach,How to confirm,Reason waived,Fix');
  assert(rows.some(row => row.includes(',CWE-89,#2,A05:2025,')), 'the rank and the 2025 category travel with the row');
  assert(rows.some(row => row.startsWith('repository,open,critical,confirmed,SEC-001,') && row.includes(',api/users.js,2,GET /u/:id (open),,')), 'a confirmed finding carries its route and no check');
  assert(rows.some(row => row.startsWith('repository,open,critical,to confirm,SEC-001,') && row.includes(',api/legacy.js,1,,')), 'a lead says it is one');
  assert.strictEqual(rows.length, 1 + waivedResult.findings.length + waivedResult.suppressed.length + site.findings.length);
  assert(rows.some(row => row.startsWith('repository,waived,serious,confirmed,SEC-005,')));
  assert(rows.some(row => row.includes(",'=cmd|calc!A1.js,")), 'a cell that opens with = is defused');
  assert(!rows.some(row => /,=|^=/.test(row)), 'no cell opens with =');
  assert(table.endsWith('\r\n'));
  assert(!/SELECT \* FROM|canary-value|SECRET_KEY/.test(table), 'the CSV never carries what was read');
  const quoted = ui.csv({ findings: [{ id: 'x', rule: 'SEC-001', severity: 'critical', title: 'Say "hi", then go', category: 'code', path: 'a.js', line: 2, fix: 'line one\nline two' }], categories: [] }, null, null);
  assert(quoted.includes('"Say ""hi"", then go"'), 'quotes are doubled inside a quoted cell');
  assert(quoted.includes('"line one\nline two"'));

  /* Exploit intelligence and reach travel with every export, and the brief ranks the packages by risk. */
  const { riskyResult } = require('./e2e/code-audit-risk-fixture');
  const risky = riskyResult();
  const riskyBrief = ui.brief(risky, 'sandbox/demo (main)', null);
  assert.match(riskyBrief, /Grade \*\*F\*\* — \d+\/100 \(held below 50 by a vulnerability exploited in the wild\)\./);
  assert.match(riskyBrief, /## Dependency risk\n\nRanked by exploitation in the wild, exploit probability and reach\./);
  assert.match(riskyBrief, /Sources: CISA’s Known Exploited Vulnerabilities catalog 2026\.09\.27 \(1,728 CVEs\) · FIRST EPSS scores for 4 of 4 CVEs\./);
  const riskRows = riskyBrief.split('\n').filter(line => /^\| \d+ (urgent|high|moderate|low) \|/.test(line));
  assert.deepStrictEqual(riskRows.map(line => line.split('|')[2].trim()), ['jquery 3.4.1', 'qs 6.7.0', 'lodash 4.17.15', 'systeminformation 5.3.0'], 'exploited and shipping first, then by risk');
  assert.match(riskRows[3], /\| yes — CVE-2021-21315 \| 91% \(CVE-2021-21315\) \| Dev only \|$/);
  assert.match(riskyBrief, /- \*\*Reach:\*\* Installed for production\. Only tests import it \(test\/format\.test\.js\)/);
  assert.match(riskyBrief, /4 CVEs checked against CISA KEV 2026\.09\.27 and EPSS \(4 scored\)/);
  const riskyCsv = ui.csv(risky, null, null).trim().split('\r\n');
  const jqueryRow = riskyCsv.find(row => row.includes(',jquery 3.4.1 → 3.5.0,'));
  assert(jqueryRow, 'the package, its version and its fix are named in the row');
  assert.match(jqueryRow, /,\d+ urgent,yes \(CVE-2020-11023\),84\.89% \(CVE-2020-11023\),imported,/, 'risk, catalog, EPSS and reach in their columns');
  const riskySarif = JSON.parse(ui.sarif(risky, null));
  const qsResult = riskySarif.runs[0].results.find(item => item.properties.epssCve === 'CVE-2022-24999');
  assert.strictEqual(qsResult.properties.knownExploited, false);
  assert.strictEqual(qsResult.properties.dependencyReach, 'transitive');
  assert.strictEqual(qsResult.properties['security-severity'], '7.5', 'the advisory’s own CVSS, for a dashboard to sort by');
  assert.strictEqual(riskySarif.runs[0].properties.exploitSources.kevVersion, '2026.09.27');
  const riskyPrompts = ui.allPrompts(risky);
  assert.match(riskyPrompts, /CISA lists CVE-2020-11023 as exploited in the wild/);

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
