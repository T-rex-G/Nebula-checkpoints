'use strict';

/*
 * Effective repository path sets for governed mutations.
 *
 * A policy rule can carry a path condition, but a rule only reaches the paths a
 * mutation actually reports. Actions that change content by naming something
 * other than a plain `path` — a rename's from/to, a batch's item list, a
 * directory move, a restore prefix — used to report no path at all, so a rule
 * protecting those paths had nothing to match and the mutation was recorded as
 * allowed. This module gives every content-changing action one complete,
 * bounded, honestly-labelled path set.
 *
 * The label matters as much as the set. `exact` means these are the paths, all
 * of them. `subtree` means this is the root of what changes and its members are
 * not knowable when the gateway decides. `unbounded` means the action can
 * rewrite anything and no path set describes it. Nothing here narrows a set it
 * cannot stand behind, because a set that looks complete and is not is worse
 * than no set at all: it produces confident evidence for a decision that was
 * never really made.
 */

const MAX_PATH_SET_ITEMS = 100;
const MAX_PATH_SET_BYTES = 8 * 1024;
const MAX_PATH_LENGTH = 1000;

class ProtectedPathError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.name = 'ProtectedPathError';
    this.code = code;
    this.status = status;
    /* The refusal happens before the gateway reaches a provider, so the caller
     * can be told plainly that nothing was changed. */
    this.providerChanged = false;
    this.safeState = 'The repository was not changed.';
    this.nextAction = 'Split this change into smaller commits and try again.';
  }
}

const PATH_COVERAGE = Object.freeze({
  EXACT: 'exact',
  SUBTREE: 'subtree',
  UNBOUNDED: 'unbounded'
});

function semantics(coverage, sources, summary) {
  return Object.freeze({ coverage, sources: Object.freeze([...sources]), summary });
}

/*
 * Every action that can change repository content, and how precisely its path
 * set is knowable at the moment the gateway decides. `sources` are the metadata
 * fields the paths are read from.
 */
const ACTION_PATH_SEMANTICS = Object.freeze({
  'file.write': semantics(PATH_COVERAGE.EXACT, ['path'], 'Writes one file'),
  'file.delete': semantics(PATH_COVERAGE.EXACT, ['path'], 'Deletes one file'),
  'file.upload': semantics(PATH_COVERAGE.EXACT, ['path'], 'Uploads one file'),
  'git.blob.create': semantics(PATH_COVERAGE.EXACT, ['path'], 'Stages one file blob'),
  'file.rename': semantics(PATH_COVERAGE.EXACT, ['from', 'to'], 'Moves one file between two paths'),
  'file.batch': semantics(PATH_COVERAGE.EXACT, ['paths'], 'Writes or deletes a list of files in one commit'),
  'directory.move': semantics(PATH_COVERAGE.SUBTREE, ['from', 'to'], 'Moves a directory and everything under it'),
  'commit.restore-paths': semantics(PATH_COVERAGE.SUBTREE, ['pathPrefix'], 'Restores everything under a prefix from history'),
  'commit.revert': semantics(PATH_COVERAGE.UNBOUNDED, [], 'Reverts a commit, which can touch any path it changed'),
  'commit.restore': semantics(PATH_COVERAGE.UNBOUNDED, [], 'Restores repository content from history'),
  'branch.reset': semantics(PATH_COVERAGE.UNBOUNDED, [], 'Moves a branch reference, which can change every path')
});

/*
 * The same normalisation the batch contract applies, so a path reaches a policy
 * rule in the one shape glob patterns are written against.
 */
function normalizeRepositoryPath(value) {
  if (typeof value !== 'string') return '';
  const candidate = value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').trim();
  if (!candidate || candidate.length > MAX_PATH_LENGTH) return '';
  if (/[\0\r\n]/.test(candidate)) return '';
  if (candidate.split('/').some(piece => !piece || piece === '.' || piece === '..')) return '';
  return candidate;
}

function collectSourceValues(metadata, sources) {
  const values = [];
  for (const source of sources) {
    const value = metadata[source];
    if (Array.isArray(value)) values.push(...value);
    else if (value != null && value !== '') values.push(value);
  }
  return values;
}

function assertPathSetFits(paths) {
  if (paths.length > MAX_PATH_SET_ITEMS) {
    throw new ProtectedPathError(
      `A governed mutation may carry at most ${MAX_PATH_SET_ITEMS} paths; split this change into smaller commits`,
      'MUTATION_PATH_SET_TOO_LARGE',
      413
    );
  }
  if (Buffer.byteLength(JSON.stringify(paths), 'utf8') > MAX_PATH_SET_BYTES) {
    throw new ProtectedPathError(
      'This change names more path text than a governed mutation can carry; split it into smaller commits',
      'MUTATION_PATH_SET_TOO_LARGE',
      413
    );
  }
}

/*
 * The path facts to merge into a mutation's metadata. Returns an empty object
 * for actions with no path semantics, so unrelated mutations are untouched.
 */
function pathFactsForAction(action, metadata = {}) {
  const definition = ACTION_PATH_SEMANTICS[String(action || '')];
  if (!definition) return {};
  if (definition.coverage === PATH_COVERAGE.UNBOUNDED) {
    return { paths: [], pathCoverage: PATH_COVERAGE.UNBOUNDED };
  }

  const source = metadata && typeof metadata === 'object' ? metadata : {};
  const values = collectSourceValues(source, definition.sources);
  const normalized = values.map(normalizeRepositoryPath);
  const paths = [...new Set(normalized.filter(Boolean))].sort();

  /*
   * A value that was named but could not be understood means the set in hand is
   * not the whole set. Reporting the remainder as complete would leave the
   * dropped path unguarded while the record claimed otherwise, so the set stops
   * claiming to be complete instead.
   */
  if (normalized.some(entry => !entry)) {
    return { paths: [], pathCoverage: PATH_COVERAGE.UNBOUNDED };
  }

  assertPathSetFits(paths);
  return { paths, pathCoverage: definition.coverage };
}

module.exports = Object.freeze({
  ProtectedPathError,
  PATH_COVERAGE,
  ACTION_PATH_SEMANTICS,
  MAX_PATH_SET_ITEMS,
  MAX_PATH_SET_BYTES,
  normalizeRepositoryPath,
  pathFactsForAction
});
