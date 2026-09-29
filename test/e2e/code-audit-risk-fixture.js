'use strict';

/*
 * A small project whose vulnerable packages sit at every distance from the
 * running code -- jQuery imported by the page (listed by CISA as exploited),
 * qs brought in by Express (which the server imports), lodash only a test
 * imports, and systeminformation as a development tool (also listed by
 * CISA) -- analysed by the real engine with the EPSS scores and catalog
 * entries FIRST and CISA publish for those CVEs.
 */

const { analyse } = require('../../src/code-audit');

function riskyResult() {
  const lock = {
    lockfileVersion: 3,
    packages: {
      '': { name: 'demo', dependencies: { express: '^4.17.0', jquery: '^3.4.0', lodash: '^4.17.0' }, devDependencies: { systeminformation: '^5.3.0' } },
      'node_modules/express': { version: '4.17.1', dependencies: { 'body-parser': '1.19.0', qs: '6.7.0' } },
      'node_modules/body-parser': { version: '1.19.0', dependencies: { qs: '6.7.0' } },
      'node_modules/qs': { version: '6.7.0' },
      'node_modules/jquery': { version: '3.4.1' },
      'node_modules/lodash': { version: '4.17.15' },
      'node_modules/systeminformation': { version: '5.3.0', dev: true }
    }
  };
  const files = [
    { path: 'README.md', text: '# demo\n' },
    { path: 'package.json', text: JSON.stringify({ name: 'demo', scripts: { start: 'node server.js' }, dependencies: lock.packages[''].dependencies, devDependencies: lock.packages[''].devDependencies }, null, 2) },
    { path: 'package-lock.json', text: JSON.stringify(lock, null, 2) },
    { path: 'server.js', text: "const express = require('express');\nconst app = express();\napp.use(express.static('web'));\napp.listen(3000);\n" },
    { path: 'web/main.js', text: "import $ from 'jquery';\n$('#app').addClass('ready');\n" },
    { path: 'test/format.test.js', text: "const _ = require('lodash');\n" }
  ];
  const advisory = (id, cve, severity, cvss, summary, fixed) => ({ id, cve, rated: true, severity, cvss, summary, fixed, malicious: false });
  const advisories = new Map([
    ['npm:express@4.17.1', { advisories: [] }],
    ['npm:body-parser@1.19.0', { advisories: [] }],
    ['npm:jquery@3.4.1', { advisories: [advisory('GHSA-jpcq-cgw6-v4j6', 'CVE-2020-11023', 'warning', 6.1, 'Potential XSS vulnerability in jQuery', '3.5.0')] }],
    ['npm:qs@6.7.0', { advisories: [advisory('GHSA-hrpp-h998-j3pp', 'CVE-2022-24999', 'serious', 7.5, 'qs vulnerable to Prototype Pollution', '6.7.3')] }],
    ['npm:lodash@4.17.15', { advisories: [advisory('GHSA-35jh-r3h4-6jhm', 'CVE-2021-23337', 'serious', 7.2, 'Command Injection in lodash', '4.17.21')] }],
    ['npm:systeminformation@5.3.0', { advisories: [advisory('GHSA-2m8v-572m-ff2v', 'CVE-2021-21315', 'serious', 7.8, 'Command injection in systeminformation', '5.3.1')] }]
  ]);
  const intel = new Map([
    ['CVE-2020-11023', { epss: 0.84887, percentile: 0.99705, epssDate: '2026-09-28', kev: { added: '2025-01-23', due: '2025-02-13', ransomware: false } }],
    ['CVE-2022-24999', { epss: 0.15622, percentile: 0.96731, epssDate: '2026-09-28', kev: null }],
    ['CVE-2021-23337', { epss: 0.21333, percentile: 0.97527, epssDate: '2026-09-28', kev: null }],
    ['CVE-2021-21315', { epss: 0.90675, percentile: 0.99801, epssDate: '2026-09-28', kev: { added: '2022-01-18', due: '2022-02-01', ransomware: false } }]
  ]);
  return {
    ...analyse({ files, paths: files.map(file => file.path), advisories, intel }),
    commitSha: 'a'.repeat(40),
    ref: 'main',
    auditedAt: new Date().toISOString(),
    coverage: {
      treeTruncated: false, filesInTree: files.length, eligible: files.length - 1, read: files.length - 1, unreadable: 0,
      skipped: { excluded: 0, oversize: 0, budget: 0 }, complete: true,
      packages: { declared: 4, checked: 4, unknown: 0, notChecked: 0 },
      advisories: { versions: 7, checked: 7, unknown: 0, notChecked: 0, vulnerable: 4, malicious: 0, lockfiles: 1, lockfilesRead: 1 },
      exploit: { cves: 4, asked: 4, kev: 'ok', kevVersion: '2026.09.27', kevCount: 1728, kevStale: false, epss: 'ok', scored: 4, unscored: 0 }
    }
  };
}

module.exports = { riskyResult };
