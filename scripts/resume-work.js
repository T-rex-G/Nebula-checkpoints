'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const statePath = path.join(root, 'WORK_CONTINUITY.json');

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function readState() {
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  if (
    state.schemaVersion !== 1
    || state.project !== 'Nebulaverse-X'
    || typeof state.branch !== 'string'
    || !/^[0-9a-f]{40}$/.test(state.acceptedThrough || '')
    || !state.activePlan
    || typeof state.nextAction !== 'string'
  ) {
    throw new Error('WORK_CONTINUITY.json is invalid');
  }
  return state;
}

function collect() {
  const state = readState();
  const branch = git(['branch', '--show-current']);
  const currentHead = git(['rev-parse', 'HEAD']);
  if (branch !== state.branch) {
    throw new Error(`Continuity branch mismatch: expected ${state.branch}, found ${branch || 'detached HEAD'}`);
  }
  const ancestor = spawnSync(
    'git',
    ['merge-base', '--is-ancestor', state.acceptedThrough, currentHead],
    { cwd: root, encoding: 'utf8' }
  );
  if (ancestor.status !== 0) {
    throw new Error('Accepted continuity boundary is not an ancestor of HEAD');
  }
  const dirtyPaths = execFileSync(
    'git',
    ['status', '--porcelain=v1'],
    { cwd: root, encoding: 'utf8' }
  )
    .split('\n')
    .filter(Boolean)
    .map(line => line.slice(3));
  return Object.freeze({
    ...state,
    branch,
    currentHead,
    acceptedBoundaryValid: true,
    worktreeClean: dirtyPaths.length === 0,
    dirtyPaths
  });
}

function renderHuman(state) {
  const tasks = Object.entries(state.activePlan.tasks)
    .map(([number, task]) => `  Task ${number}: ${task.status}`)
    .join('\n');
  return [
    `${state.project} ${state.version}`,
    `Branch: ${state.branch}`,
    `HEAD: ${state.currentHead}`,
    `Accepted through: ${state.acceptedThrough}`,
    `Worktree: ${state.worktreeClean ? 'clean' : `dirty (${state.dirtyPaths.join(', ')})`}`,
    `Plan ${state.activePlan.number}: ${state.activePlan.status}`,
    tasks,
    `Next action: ${state.nextAction}`,
    `Recovery remote: ${state.remote.status}`
  ].join('\n');
}

const state = collect();
process.stdout.write(
  process.argv.includes('--json')
    ? `${JSON.stringify(state, null, 2)}\n`
    : `${renderHuman(state)}\n`
);
