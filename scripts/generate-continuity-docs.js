#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { generatedDocuments, readContinuity } = require('../src/work-continuity');

const root = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const values = Array.isArray(argv) ? argv.map(String) : [];
  if (values.length === 0) return Object.freeze({ check: false });
  if (values.length === 1 && values[0] === '--check') return Object.freeze({ check: true });
  if (values.length > 1 && values.every(value => value === '--check')) {
    throw new TypeError('Duplicate argument: --check');
  }
  const unknown = values.find(value => value !== '--check');
  throw new TypeError(`Unknown argument: ${unknown || values[0]}`);
}

function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const state = readContinuity(path.join(root, 'WORK_CONTINUITY.json'));
  const outputs = generatedDocuments(state);
  for (const [relative, content] of Object.entries(outputs)) {
    const target = path.join(root, relative);
    if (options.check) {
      if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== content) {
        throw new Error(`Generated continuity document is stale: ${relative}`);
      }
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, 'utf8');
    }
  }
  return options.check
    ? 'Generated continuity documents are current'
    : 'Generated continuity documents updated';
}

function main() {
  try {
    process.stdout.write(`${run()}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}

if (require.main === module) main();

module.exports = Object.freeze({ parseArgs, run });
