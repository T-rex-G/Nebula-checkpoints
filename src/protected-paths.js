'use strict';

const crypto = require('crypto');

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

/* ------------------------------------------------------------------ *
 * Protected path declarations
 *
 * A protected path is one pattern an operator names. Turning it into policy is
 * where the mistakes live: it needs a rule for every action that can change a
 * path, and it needs the subtree cases, because a file under .github/workflows
 * travels with a move of .github. Hand-authoring that is how the original gap
 * appeared — the reasonable thing to write is the file.write rule, and the
 * reasonable thing to write is not enough.
 *
 * The expansion is deterministic, so the same declarations always produce the
 * same policy version for a reviewer to read, and it reports what it could not
 * narrow instead of leaving the operator to discover it.
 * ------------------------------------------------------------------ */

const MAX_DECLARATIONS = 32;
const DECLARATION_EFFECTS = new Set(['deny', 'require-approval']);

function declarationFail(message) {
  throw new ProtectedPathError(message, 'PROTECTED_PATH_DECLARATION_INVALID', 400);
}

/* A pattern is a repository path that may use glob wildcards. It is normalised
 * the same way a path is, so a rule and the mutation it judges are written in
 * one shape. */
function normalizeProtectedPattern(value) {
  if (typeof value !== 'string') return '';
  const candidate = value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/').trim();
  if (!candidate || candidate.length > MAX_PATH_LENGTH) return '';
  if (/[\0\r\n]/.test(candidate)) return '';
  if (candidate.split('/').some(piece => !piece || piece === '.' || piece === '..')) return '';
  return candidate;
}

function hasWildcard(segment) {
  return segment.includes('*') || segment.includes('?');
}

/*
 * A directory move or a prefix restore names a directory, not the files inside
 * it, so a pattern can only be narrowed to those actions when every directory
 * that could carry the pattern is knowable from the pattern itself. That holds
 * for a literal path and for a literal prefix followed by `**`; a wildcard in
 * the middle of a pattern leaves directories that match nothing in the pattern
 * but still contain what it protects.
 */
function subtreeNarrowable(pattern) {
  const segments = pattern.split('/');
  const wildcardAt = segments.findIndex(hasWildcard);
  if (wildcardAt === -1) return true;
  return wildcardAt === segments.length - 1 && segments[wildcardAt] === '**' && wildcardAt > 0;
}

/* Every directory a move of which would carry the protected pattern with it. */
function ancestorPathsFor(pattern) {
  if (!subtreeNarrowable(pattern)) return [];
  const segments = pattern.split('/');
  const wildcardAt = segments.findIndex(hasWildcard);
  /* A literal pattern names a leaf; its own last segment is not a directory
   * above it. A `**` pattern's literal part is all directory. */
  const directorySegments = wildcardAt === -1 ? segments.slice(0, -1) : segments.slice(0, wildcardAt);
  const ancestors = [];
  for (let index = 0; index < directorySegments.length; index += 1) {
    ancestors.push(directorySegments.slice(0, index + 1).join('/'));
  }
  return ancestors;
}

function ruleIdFor(pattern, action) {
  const digest = crypto.createHash('sha256').update(pattern, 'utf8').digest('hex').slice(0, 8);
  return `protected-path-${digest}-${action}`;
}

/* A rule that gates a whole action is the same rule whichever protected path
 * asked for it, so it is emitted once per effect rather than once per pattern. */
function wholeActionRuleId(effect, action) {
  return `protected-path-guard-${effect}-${action}`;
}

function readableList(values) {
  if (values.length === 1) return values[0];
  return `${values.slice(0, -1).join(', ')} and ${values[values.length - 1]}`;
}

function normalizeDeclarations(input) {
  if (!Array.isArray(input) || input.length < 1) {
    declarationFail('At least one protected path must be declared');
  }
  if (input.length > MAX_DECLARATIONS) {
    declarationFail(`At most ${MAX_DECLARATIONS} protected paths can be declared in one policy`);
  }
  const seen = new Set();
  return input.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) declarationFail('Each protected path must be an object');
    const pattern = normalizeProtectedPattern(raw.pattern);
    if (!pattern) declarationFail(`Protected path pattern is invalid: ${String(raw.pattern || '').slice(0, 120) || '(empty)'}`);
    if (seen.has(pattern)) declarationFail(`Protected path ${pattern} is declared more than once`);
    seen.add(pattern);
    const effect = String(raw.effect || 'deny').trim().toLowerCase();
    if (!DECLARATION_EFFECTS.has(effect)) {
      declarationFail(`Protected path ${pattern} must be declared deny or require-approval`);
    }
    return {
      pattern,
      effect,
      guardWholeActions: raw.guardWholeActions !== false
    };
  });
}

/*
 * Expand declarations into policy rules and a plain statement of what the
 * expansion covers. Returns { rules, coverage }.
 */
function expandProtectedPaths(declarationsInput) {
  const declarations = normalizeDeclarations(declarationsInput);
  const rules = [];
  const coverage = [];
  const wholeActionRules = new Map();

  for (const declaration of declarations) {
    const { pattern, effect, guardWholeActions } = declaration;
    const ancestorPaths = ancestorPathsFor(pattern);
    const narrowable = subtreeNarrowable(pattern);
    const narrowedActions = [];
    const wholeActionGuards = [];
    const limits = [];

    const addRule = (action, conditions, description) => {
      const rule = { id: ruleIdFor(pattern, action), action, effect, description };
      rule.conditions = conditions;
      rules.push(rule);
    };
    const addWholeActionRule = (action, description) => {
      const id = wholeActionRuleId(effect, action);
      if (wholeActionRules.has(id)) return;
      const rule = { id, action, effect, description };
      wholeActionRules.set(id, rule);
      rules.push(rule);
    };

    for (const [action, definition] of Object.entries(ACTION_PATH_SEMANTICS)) {
      if (definition.coverage === PATH_COVERAGE.EXACT) {
        narrowedActions.push(action);
        addRule(action, { path: [pattern] }, `${pattern} is a protected path`);
        continue;
      }
      if (definition.coverage === PATH_COVERAGE.SUBTREE) {
        if (narrowable) {
          narrowedActions.push(action);
          addRule(action, { path: [pattern, ...ancestorPaths] }, `${pattern} and the directories holding it are protected`);
        } else if (guardWholeActions) {
          wholeActionGuards.push(action);
          addWholeActionRule(action, 'Gated as a whole action: a protected path here names no fixed directory');
        } else {
          narrowedActions.push(action);
          addRule(action, { path: [pattern] }, `${pattern} is a protected path`);
        }
        continue;
      }
      if (guardWholeActions) {
        wholeActionGuards.push(action);
        addWholeActionRule(action, 'Gated as a whole action: it can change any path, including a protected one');
      }
    }

    if (ancestorPaths.length) {
      limits.push(
        `Changing ${readableList(ancestorPaths)} as a directory is gated too, because ${pattern} travels with it.`
      );
    }
    if (!narrowable) {
      const note = guardWholeActions
        ? `${pattern} names no fixed directory, so a directory move or a prefix restore cannot be narrowed to it; those actions are gated as a whole.`
        : `${pattern} names no fixed directory, so a directory move or a prefix restore that carries it is not gated.`;
      limits.push(note);
    }
    const unbounded = Object.keys(ACTION_PATH_SEMANTICS)
      .filter(action => ACTION_PATH_SEMANTICS[action].coverage === PATH_COVERAGE.UNBOUNDED)
      .sort();
    limits.push(guardWholeActions
      ? `${readableList(unbounded)} are gated as whole actions: they can change any path, so they cannot be narrowed to ${pattern}.`
      : `${readableList(unbounded)} are not gated: they can change ${pattern} without a policy decision on this path.`);

    coverage.push(Object.freeze({
      pattern,
      effect,
      guardWholeActions,
      narrowable,
      ancestorPaths: Object.freeze(ancestorPaths),
      narrowedActions: Object.freeze(narrowedActions.slice().sort()),
      wholeActionGuards: Object.freeze(wholeActionGuards.slice().sort()),
      limits: Object.freeze(limits)
    }));
  }

  rules.sort((left, right) => left.id.localeCompare(right.id));
  return Object.freeze({ rules: Object.freeze(rules), coverage: Object.freeze(coverage) });
}

module.exports = Object.freeze({
  ProtectedPathError,
  PATH_COVERAGE,
  ACTION_PATH_SEMANTICS,
  MAX_PATH_SET_ITEMS,
  MAX_PATH_SET_BYTES,
  normalizeRepositoryPath,
  pathFactsForAction,
  MAX_DECLARATIONS,
  normalizeProtectedPattern,
  expandProtectedPaths
});
