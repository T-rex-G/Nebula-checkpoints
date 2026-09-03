#!/usr/bin/env node
'use strict';

const path = require('path');
const {
  discoverReleasableTextFiles,
  scanFiles
} = require('../src/secret-scanner');

function run(root = path.resolve(__dirname, '..')) {
  const files = discoverReleasableTextFiles(root);
  return scanFiles({ root, files });
}

function main() {
  try {
    const findings = run();
    if (findings.length) {
      process.stderr.write(`Potential embedded secrets detected:\n${findings
        .map(item => `${item.path}:${item.line}: ${item.rule}`)
        .join('\n')}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write('secret pattern check passed\n');
  } catch (error) {
    process.stderr.write(`Secret scan failed: ${error.message}\n`);
    process.exitCode = 2;
  }
}

if (require.main === module) main();

module.exports = Object.freeze({ run });
