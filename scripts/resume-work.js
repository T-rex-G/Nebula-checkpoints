#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const statePath = path.join(root, 'WORK_CONTINUITY.json');
const PUBLISHED_BASELINE = Object.freeze({
  repository: 'T-rex-G/Nebula-checkpoints',
  branch: 'sandbox/alpha17-live-qualification',
  commit: '315a88406487117fe32449e59eb3dfce4067b444',
  parent: '7f721a770df8e658e00163e05ebc259502f99c09',
  tree: '673737fc9a51aeffd54e068d5148de061fb559b2',
  candidateSha256: '6d29b357eca034afa413940f07d27352889c4a619be9483fc00a78d08da8b72d',
  qualificationDecision: 'no-go-evidence-integrity-correction-required'
});

function parseArgs(argv) {
  const options = { json: false, requireClean: false };
  const seen = new Set();
  for (const raw of Array.isArray(argv) ? argv : []) {
    const value = String(raw);
    if (!['--json', '--require-clean'].includes(value)) throw new TypeError(`Unknown argument: ${value}`);
    if (seen.has(value)) throw new TypeError(`Duplicate argument: ${value}`);
    seen.add(value);
    if (value === '--json') options.json = true;
    if (value === '--require-clean') options.requireClean = true;
  }
  return Object.freeze(options);
}

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function readState() {
  let state;
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    throw new Error('WORK_CONTINUITY.json is not valid JSON');
  }
  if (
    state.schemaVersion !== 2 ||
    state.project !== 'Nebulaverse-X' ||
    state.version !== '5.3.0-alpha.17.0' ||
    !/^[0-9a-f]{40}$/.test(state.acceptedThrough || '') ||
    JSON.stringify(state.publishedBaseline) !== JSON.stringify(PUBLISHED_BASELINE) ||
    !Array.isArray(state.failedQualificationRuns) ||
    state.failedQualificationRuns.some(item => !/^[0-9]+$/.test(String(item.runId || '')) || item.liveJobsSkipped !== true) ||
    !state.verification ||
    !Array.isArray(state.limitations) ||
    typeof state.nextAction !== 'string'
  ) throw new Error('WORK_CONTINUITY.json is invalid');
  const serialized = JSON.stringify(state);
  if (/lastPushedCommit|lastPushedSourceCommit|pending_publication/.test(serialized)) {
    throw new Error('WORK_CONTINUITY.json contains stale publication narration');
  }
  return state;
}

function unavailableSourceControl(state, requireClean) {
  if (requireClean) throw new Error('Source control is required to prove a clean worktree');
  return Object.freeze({
    ...state,
    sourceControlAvailable: false,
    branch: null,
    currentHead: null,
    acceptedBoundaryValid: null,
    worktreeClean: null,
    dirtyPaths: []
  });
}

function collect(options = {}) {
  const state = readState();
  const probe = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: root,
    encoding: 'utf8'
  });
  if (probe.error || probe.status !== 0 || probe.stdout.trim() !== 'true') {
    return unavailableSourceControl(state, options.requireClean === true);
  }
  const branch = git(['branch', '--show-current']);
  const currentHead = git(['rev-parse', 'HEAD']);
  const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', state.acceptedThrough, currentHead], {
    cwd: root,
    encoding: 'utf8'
  });
  if (ancestor.status !== 0) throw new Error('Accepted continuity boundary is not an ancestor of HEAD');
  const dirtyPaths = execFileSync('git', ['status', '--porcelain=v1'], {
    cwd: root,
    encoding: 'utf8'
  })
    .split('\n')
    .filter(Boolean)
    .map(line => line.slice(3));
  if (options.requireClean === true && dirtyPaths.length > 0) {
    throw new Error('Qualification requires a clean worktree');
  }
  return Object.freeze({
    ...state,
    sourceControlAvailable: true,
    branch: branch || null,
    currentHead,
    acceptedBoundaryValid: true,
    worktreeClean: dirtyPaths.length === 0,
    dirtyPaths
  });
}

function renderHuman(state) {
  return [
    `${state.project} ${state.version}`,
    `Source control: ${state.sourceControlAvailable ? 'available' : 'unavailable (release archive)'}`,
    `Branch: ${state.sourceControlAvailable ? state.branch || 'detached HEAD' : 'unavailable'}`,
    `HEAD: ${state.currentHead || 'unavailable'}`,
    `Accepted through: ${state.acceptedThrough}`,
    `Published baseline: ${state.publishedBaseline.commit} (${state.publishedBaseline.qualificationDecision})`,
    `Published candidate: ${state.publishedBaseline.candidateSha256}`,
    `Worktree: ${state.worktreeClean === null ? 'unavailable' : state.worktreeClean ? 'clean' : `dirty (${state.dirtyPaths.join(', ')})`}`,
    `Next action: ${state.nextAction}`
  ].join('\n');
}

function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const state = collect(options);
  return options.json ? JSON.stringify(state, null, 2) : renderHuman(state);
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

module.exports = Object.freeze({ parseArgs, readState, collect, renderHuman, run });
