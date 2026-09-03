#!/usr/bin/env node
'use strict';

const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { readContinuity } = require('../src/work-continuity');

const root = path.resolve(__dirname, '..');
const statePath = path.join(root, 'WORK_CONTINUITY.json');
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

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
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: GIT_MAX_BUFFER
  }).trim();
}

function readState() {
  return readContinuity(statePath);
}

function unavailableSourceControl(state, requireClean) {
  if (requireClean) throw new Error('Source control is required to prove a clean worktree');
  return Object.freeze({
    ...state,
    sourceControlAvailable: false,
    branch: null,
    currentHead: null,
    acceptedBoundaryValid: null,
    acceptedBoundaryCommit: null,
    worktreeClean: null,
    dirtyPaths: []
  });
}

function validateHistoryResult(result, recordedBaseline, acceptedTree) {
  if (result.error) {
    throw new Error(`Git history discovery failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const outcome = result.signal ? `signal ${result.signal}` : `exit ${result.status}`;
    const detail = String(result.stderr || result.stdout || '').trim().slice(0, 4000);
    throw new Error(`Git history discovery failed (${outcome})${detail ? `: ${detail}` : ''}`);
  }
  /* One accepted tree can be reached through several transport-specific
     commits, so any recorded identity carrying that tree proves the boundary. */
  const acceptedCommits = new Set(recordedBaseline.commits.map(entry => entry.commit));
  for (const line of String(result.stdout || '').split('\n')) {
    const [commit, tree, ...extra] = line.split('\t');
    if (!extra.length && acceptedCommits.has(commit) && tree === acceptedTree) return commit;
  }
  return null;
}

function collect(options = {}) {
  const state = readState();
  const probe = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: GIT_MAX_BUFFER
  });
  if (probe.error || probe.status !== 0 || probe.stdout.trim() !== 'true') {
    return unavailableSourceControl(state, options.requireClean === true);
  }
  const branch = git(['branch', '--show-current']);
  const currentHead = git(['rev-parse', 'HEAD']);
  const history = spawnSync('git', ['log', '--format=%H%x09%T', currentHead], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: GIT_MAX_BUFFER
  });
  const acceptedBoundaryCommit = validateHistoryResult(
    history,
    state.recordedBaseline,
    state.acceptedTree
  );
  if (!acceptedBoundaryCommit) {
    throw new Error('Accepted continuity commit/tree pair is not present in HEAD ancestry');
  }
  const dirtyPaths = execFileSync('git', ['status', '--porcelain=v1'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: GIT_MAX_BUFFER
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
    acceptedBoundaryCommit,
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
    `Accepted tree: ${state.acceptedTree}`,
    ...state.recordedBaseline.commits.map(entry =>
      `Recorded ${entry.role} baseline: ${entry.commit}`),
    `Baseline decision: ${state.recordedBaseline.decision}`,
    `Recorded candidate: ${state.recordedBaseline.candidateSha256}`,
    `Worktree: ${state.worktreeClean === null ? 'unavailable' : state.worktreeClean ? 'clean' : `dirty (${state.dirtyPaths.join(', ')})`}`,
    `Next action: ${state.nextAuthorizedAction.description}`
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

module.exports = Object.freeze({ parseArgs, readState, validateHistoryResult, collect, renderHuman, run });
