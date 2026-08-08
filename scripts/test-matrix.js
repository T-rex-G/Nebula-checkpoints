#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { runTestMatrix } = require('../src/test-matrix');

function parseArgs(argv) {
  const args = { allowMissingDependencies: false, requireSubjectHash: false, report: null };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--allow-missing-dependencies') args.allowMissingDependencies = true;
    else if (value === '--require-all') args.allowMissingDependencies = false;
    else if (value === '--require-subject') args.requireSubjectHash = true;
    else if (value === '--report') args.report = argv[++i];
    else throw new TypeError(`Unknown argument: ${value}`);
  }
  return args;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const report = runTestMatrix({
    root: process.cwd(),
    allowMissingDependencies: args.allowMissingDependencies,
    requireSubjectHash: args.requireSubjectHash,
    subjectHash: process.env.NV_STAGING_SUBJECT_SHA256
  });
  const summary = `${report.counts.total} test programs: ${report.counts.passed} passed, ${report.counts.blocked} blocked, ${report.counts.failed} failed`;
  process.stdout.write(`${summary}\nreportHash=${report.reportHash}\n`);
  for (const test of report.tests.filter(item => item.status !== 'pass')) {
    process.stdout.write(`${test.status.toUpperCase()} ${test.path}${test.blockedModule ? ` (${test.blockedModule})` : ''}\n`);
  }
  if (args.report) {
    const target = path.resolve(args.report);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  }
  if (report.counts.failed > 0 || (!args.allowMissingDependencies && report.counts.blocked > 0)) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
}
