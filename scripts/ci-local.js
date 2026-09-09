#!/usr/bin/env node
'use strict';

/*
 * Run the CI verify job's steps locally, in order, read out of the workflow
 * rather than restated here.
 *
 * The failure this exists to prevent: a change was pushed after its tests were
 * run and its lint was not. `npm test` is one of eleven commands the job runs,
 * and remembering the other ten is exactly the kind of thing a person does
 * correctly until the one time it matters. A hardcoded copy of the list would
 * be a second source of truth that agrees with the workflow by luck, so the
 * list is parsed from .github/workflows/ci.yml every run.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'ci.yml');

/*
 * Steps that cannot run here, each with the reason. Anything not matched is
 * run: a new CI step is picked up without editing this file, which is the
 * whole point. Skips are printed, never silent -- a skipped gate that looks
 * like a passed one is how this class of mistake happens in the first place.
 */
const SKIPPED = [
  { match: /^npm ci$/, why: 'dependencies are already installed in the working tree' },
  { match: /^(?:npx playwright install|bash ci\/install-browser\.sh$)/, why: 'browsers are provisioned by the environment' }
];

function readRunSteps(source) {
  const lines = source.split(/\r?\n/);
  const steps = [];
  for (const line of lines) {
    const match = /^\s*-\s+run:\s+(.*\S)\s*$/.exec(line);
    if (match) steps.push(match[1]);
  }
  return steps;
}

/*
 * ${RUNNER_TEMP} and ${{ runner.temp }} are the runner's scratch directory.
 * Substituted rather than skipped, so the packaging step is actually exercised.
 */
function localise(step, tempDir) {
  return step
    .replace(/\$\{RUNNER_TEMP\}/g, tempDir)
    .replace(/\$\{\{\s*runner\.temp\s*\}\}/g, tempDir);
}

function environmentFor(step, base) {
  if (!/test:migrations/.test(step)) return base;
  /*
   * The workflow points this at its own PostgreSQL service. Locally the URL has
   * to come from the caller, and running the gate without one would report a
   * pass for a database that was never consulted.
   */
  const url = String(base.NV_TEST_DATABASE_URL || '').trim();
  if (!url) {
    throw new Error('NV_TEST_DATABASE_URL is required to run the migration gate locally');
  }
  return base;
}

function main(argv) {
  const source = fs.readFileSync(WORKFLOW, 'utf8');
  const steps = readRunSteps(source);
  if (!steps.length) throw new Error(`no run steps found in ${path.relative(ROOT, WORKFLOW)}`);

  const listOnly = argv.includes('--list');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-ci-local-'));
  const results = [];

  for (const step of steps) {
    const skip = SKIPPED.find(entry => entry.match.test(step));
    if (skip) {
      results.push({ step, state: 'skipped', why: skip.why });
      console.log(`SKIP  ${step}\n        ${skip.why}`);
      continue;
    }
    if (listOnly) {
      console.log(`RUN   ${step}`);
      results.push({ step, state: 'listed' });
      continue;
    }
    const command = localise(step, tempDir);
    console.log(`\n=== ${command}`);
    const started = Date.now();
    const outcome = spawnSync(command, {
      cwd: ROOT,
      shell: true,
      stdio: 'inherit',
      env: environmentFor(step, process.env)
    });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    if (outcome.status !== 0) {
      results.push({ step, state: 'failed' });
      console.error(`\nFAILED after ${seconds}s: ${command}`);
      console.error(summary(results));
      return 1;
    }
    results.push({ step, state: 'passed' });
    console.log(`--- passed in ${seconds}s`);
  }
  console.log(summary(results));
  return 0;
}

function summary(results) {
  const counted = state => results.filter(entry => entry.state === state).length;
  return `\n${counted('passed')} passed, ${counted('skipped')} skipped, ${counted('failed')} failed,`
    + ` ${results.length} of the workflow's steps reached.`;
}

module.exports = { readRunSteps, localise, SKIPPED, WORKFLOW };

if (require.main === module) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(String(error && error.message || error));
    process.exit(1);
  }
}
