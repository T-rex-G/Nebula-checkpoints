'use strict';

const { PROFILES, guardedFetch } = require('./guarded-fetch');

/*
 * Reading a repository without having a copy of it.
 *
 * Every ordinary way to read a Git repository runs code. `git clone` runs
 * hooks and clean/smudge filters; a checkout turns LFS pointers into network
 * fetches; a submodule is a second repository under somebody else's control;
 * and installing dependencies in order to inspect them is running the thing
 * you were trying to inspect. A scanner pointed at repositories it has never
 * seen cannot afford any of it, so this reads the provider's tree and blob
 * APIs and nothing else. No subprocess, no working directory, no temporary
 * clone to clean up, and nothing from the repository ever executed.
 *
 * It also avoids the other tempting shortcut. Keeping a clone on disk would
 * mean a quota, an orphan-recovery path at startup, and a `finally` block that
 * cannot run after SIGKILL. Not writing anything down means there is nothing
 * to recover: a restarted scan asks the provider again at the same immutable
 * commit.
 *
 * What remains is the necessary, unglamorous part. A Git tree is not a list of
 * files: it holds directories, symlinks whose contents are paths, submodule
 * gitlinks, blobs larger than this server will hold, and paths that are not
 * safe to display. Each of those is a decision this file makes explicitly,
 * each one is reported, and none of them is allowed to look like "this
 * repository is clean".
 */

/* An entry a scan declined to read, with the reason, so coverage can say so. */
const SKIP_REASONS = Object.freeze({
  NOT_A_FILE: 'not-a-file',
  SYMLINK: 'symlink',
  SUBMODULE: 'submodule',
  OVERSIZE: 'oversize',
  BINARY: 'binary',
  LFS_POINTER: 'lfs-pointer',
  UNSAFE_PATH: 'unsafe-path',
  UNREADABLE: 'unreadable'
});

/*
 * Bounds, and each is a number this server can afford rather than a number the
 * provider offers. GitHub's recursive tree truncates at 100,000 entries; this
 * stops at a fifth of that, because the work after the tree read is a blob
 * fetch per file and one free web service cannot spend that.
 */
const MAX_TREE_ENTRIES = 20_000;
const MAX_BLOB_BYTES = 512 * 1024;
const MAX_PATH_LENGTH = 1024;
const MAX_TREE_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_BLOB_RESPONSE_BYTES = 1024 * 1024;

/* A blob mode is a file, an executable file, a symlink or a gitlink. */
const FILE_MODES = Object.freeze(['100644', '100755']);
const SYMLINK_MODE = '120000';
const GITLINK_MODE = '160000';

const LFS_POINTER_PREFIX = 'version https://git-lfs.github.com/spec/v1';

class ExposureReaderError extends Error {
  /*
   * Carries a code and fixed text. Every request this module makes has the
   * reader's session token in a header, and an error that quotes its own
   * request writes that token into whatever reads the error.
   */
  constructor(message, code = 'EXPOSURE_READ_FAILED', status = 502) {
    super(message);
    this.name = 'ExposureReaderError';
    this.code = code;
    this.status = status;
  }
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/*
 * A path from a Git tree is bytes somebody else chose. Nothing here shells
 * out, so the danger is not injection -- it is a path that means one thing to
 * this server and another to whatever displays it, and a path that could be
 * read as reaching outside the repository it belongs to.
 */
function safePath(value) {
  const candidate = typeof value === 'string' ? value : '';
  if (!candidate || candidate.length > MAX_PATH_LENGTH) return false;
  /* Control characters, which includes the newline that would let one path
     render as two in anything that prints a list. */
  if (/[\u0000-\u001f\u007f]/.test(candidate)) return false;
  if (candidate.startsWith('/') || /^[A-Za-z]:/.test(candidate)) return false;
  if (candidate.includes('\\')) return false;
  const segments = candidate.split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) return false;
  /* `.git` at any level is repository metadata, not content, and a tree that
     contains one is either unusual or hostile. */
  if (segments.some(segment => segment.toLowerCase() === '.git')) return false;
  return true;
}

/*
 * Returns `{ skip }` -- null when the entry is a file this scan may read, and
 * a reason otherwise. A directory is `not-a-file` rather than a skip a reader
 * should be told about: there was never a file there to miss.
 */
function classifyTreeEntry(entry) {
  const source = entry && typeof entry === 'object' ? entry : {};
  const type = text(source.type);
  const mode = text(source.mode);

  /* Order matters. A gitlink is a submodule whether or not the provider also
     labelled it a commit, and a symlink is a symlink whatever its type says. */
  if (type === 'commit' || mode === GITLINK_MODE) return { skip: SKIP_REASONS.SUBMODULE };
  if (mode === SYMLINK_MODE) return { skip: SKIP_REASONS.SYMLINK };
  if (type !== 'blob') return { skip: SKIP_REASONS.NOT_A_FILE };
  if (!FILE_MODES.includes(mode)) return { skip: SKIP_REASONS.UNREADABLE };
  if (!safePath(source.path)) return { skip: SKIP_REASONS.UNSAFE_PATH };
  if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(text(source.sha))) return { skip: SKIP_REASONS.UNREADABLE };
  /*
   * An entry with no size is not a small file. The tree endpoint reports a
   * size for every blob, so its absence means this entry is not what it
   * appears to be -- and reading it would be reading an unbounded thing.
   */
  if (!Number.isInteger(source.size) || source.size < 0) return { skip: SKIP_REASONS.UNREADABLE };
  if (source.size > MAX_BLOB_BYTES) return { skip: SKIP_REASONS.OVERSIZE };
  return { skip: null };
}

/* ---- Providers --------------------------------------------------------- */

/*
 * One reader, for one provider, because a guessed tree API returns nothing and
 * looks successful -- which for a security feature is worse than refusing.
 * Another provider gets a reader when somebody has read its documentation and
 * written the fixtures.
 */
const READERS = Object.freeze({
  github: Object.freeze({
    provider: 'github',
    origin: 'https://api.github.com',
    headers: Object.freeze({
      accept: 'application/vnd.github+json',
      'user-agent': 'Nebulaverse-X-Exposure-Reader/1.0',
      'x-github-api-version': '2022-11-28'
    }),
    treePath: (scope, commitSha) =>
      `/repos/${encodeURIComponent(scope.owner)}/${encodeURIComponent(scope.repo)}/git/trees/${commitSha}?recursive=1`,
    blobPath: (scope, sha) =>
      `/repos/${encodeURIComponent(scope.owner)}/${encodeURIComponent(scope.repo)}/git/blobs/${sha}`,
    commitPath: (scope, ref) =>
      `/repos/${encodeURIComponent(scope.owner)}/${encodeURIComponent(scope.repo)}/commits/${encodeURIComponent(ref)}`
  })
});

function readerFor(provider) {
  return READERS[text(provider)] || null;
}

function requireReader(scope) {
  const reader = readerFor(scope && scope.provider);
  if (!reader) {
    throw new ExposureReaderError(
      'No exposure reader is implemented for this provider',
      'EXPOSURE_PROVIDER_UNSUPPORTED',
      501
    );
  }
  return reader;
}

function requireScope(scope) {
  const source = scope && typeof scope === 'object' ? scope : {};
  const owner = text(source.owner);
  const repo = text(source.repo);
  if (!owner || !repo) throw new ExposureReaderError('A read requires an owner and a repository', 'EXPOSURE_SCOPE_INVALID', 400);
  return { owner, repo };
}

/*
 * A commit and never a ref. A branch name resolved at read time is a branch
 * that can move between the tree read and the blob reads, and a scan that
 * mixed two trees would report findings at locations that never existed
 * together. The ref is resolved once, before the scan is accepted, and what
 * arrives here is the answer.
 */
function requireCommit(commitSha) {
  const value = text(commitSha).toLowerCase();
  if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(value)) {
    throw new ExposureReaderError('A tree must be read at an immutable commit', 'EXPOSURE_COMMIT_INVALID', 400);
  }
  return value;
}

function requireToken(token) {
  const value = typeof token === 'string' ? token : '';
  if (!value) throw new ExposureReaderError('A repository read requires an authorized session', 'EXPOSURE_AUTHORIZATION_MISSING', 401);
  return value;
}

/*
 * A 401 is the session being gone. Every subsequent read would fail the same
 * way, so it stops the scan rather than being skipped file by file -- and the
 * scan stops holding the token, rather than keeping it to retry with.
 */
function assertAuthorized(statusCode) {
  if (statusCode === 401) {
    throw new ExposureReaderError(
      'The authorized session for this repository is no longer valid',
      'EXPOSURE_AUTHORIZATION_REVOKED',
      401
    );
  }
}

async function request({ scope, reader, apiPath, token, transport, maxResponseBytes, accept = '' }) {
  const send = typeof transport === 'function' ? transport : guardedFetch;
  try {
    return await send({
      url: `${reader.origin}${apiPath}`,
      profile: PROFILES.PROVIDER_READ,
      method: 'GET',
      headers: { ...reader.headers, ...(accept ? { accept } : {}), authorization: `Bearer ${token}` },
      maxResponseBytes
    });
  } catch (error) {
    /* The transport's own error can quote the request it failed to send, so
       only its code crosses this boundary. */
    throw new ExposureReaderError(
      'A repository read could not be completed',
      'EXPOSURE_READ_FAILED',
      502
    );
  } finally {
    void scope;
  }
}

function parsed(response, maxBytes) {
  const body = response && typeof response.body === 'string' ? response.body : '';
  if (!body || body.length > maxBytes) return null;
  try {
    const value = JSON.parse(body);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/*
 * A ref is a branch, a tag or an object id, and it is bounded here rather than
 * interpolated. A path segment built from a caller's free text is the kind of
 * thing that works until somebody sends `..`, and while the transport would
 * refuse the resulting URL, refusing it by shape says which field was wrong.
 */
const REF_PATTERN = /^(?!-)[A-Za-z0-9][A-Za-z0-9._\/-]{0,254}$/;

function requireRef(ref) {
  const value = text(ref);
  if (!value || value.endsWith('/') || !REF_PATTERN.test(value) || value.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new ExposureReaderError('A scan ref must be a branch, tag or object id', 'EXPOSURE_REF_INVALID', 400);
  }
  return value;
}

/*
 * The one place a ref becomes a commit.
 *
 * It happens when a scan is requested, the answer is stored on the scan row,
 * and nothing afterwards looks at the ref again. That is what stops a branch
 * moving mid-scan from producing a finding set assembled from two trees, with
 * locations that never existed together -- so this function exists once and
 * the worker deliberately cannot reach it.
 */
async function resolveCommit(input = {}) {
  const reader = requireReader(input.scope);
  const scope = requireScope(input.scope);
  const ref = requireRef(input.ref);
  const token = requireToken(input.token);

  const response = await request({
    scope, reader, apiPath: reader.commitPath(scope, ref), token,
    /* Ask for the immutable id alone, not a potentially enormous merge diff. */
    transport: input.transport, maxResponseBytes: 1024, accept: 'application/vnd.github.sha'
  });
  assertAuthorized(Number(response && response.statusCode));
  if ([403, 429].includes(Number(response && response.statusCode)) || Number(response && response.statusCode) >= 500) {
    throw new ExposureReaderError('The provider could not complete the read', 'EXPOSURE_READ_FAILED', 502);
  }
  if (Number(response && response.statusCode) !== 200) {
    throw new ExposureReaderError('That ref could not be resolved', 'EXPOSURE_REF_UNRESOLVED', 404);
  }
  const sha = text(response && response.body).toLowerCase();
  if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(sha)) {
    throw new ExposureReaderError('That ref did not resolve to a commit', 'EXPOSURE_REF_UNRESOLVED', 502);
  }
  return Object.freeze({ ref, commitSha: sha });
}

/*
 * The tree at a commit, filtered to the files a scan may read, with everything
 * it declined reported alongside.
 */
async function readTree(input = {}) {
  const reader = requireReader(input.scope);
  const scope = requireScope(input.scope);
  const commitSha = requireCommit(input.commitSha);
  const token = requireToken(input.token);

  const response = await request({
    scope, reader, apiPath: reader.treePath(scope, commitSha), token,
    transport: input.transport, maxResponseBytes: MAX_TREE_RESPONSE_BYTES
  });
  assertAuthorized(Number(response && response.statusCode));
  if (Number(response && response.statusCode) !== 200) {
    throw new ExposureReaderError('The repository tree could not be read', 'EXPOSURE_TREE_UNAVAILABLE', 502);
  }
  const body = parsed(response, MAX_TREE_RESPONSE_BYTES);
  if (!body || !Array.isArray(body.tree)) {
    /*
     * An unreadable tree is not an empty repository. Returning zero entries
     * here would produce a scan that completed, found nothing, and told a
     * reader their repository was clean.
     */
    throw new ExposureReaderError('The repository tree response was not a tree', 'EXPOSURE_TREE_INVALID', 502);
  }

  const entries = [];
  const skipped = [];
  let truncated = Boolean(body.truncated);
  for (const entry of body.tree) {
    if (entries.length >= MAX_TREE_ENTRIES) {
      truncated = true;
      break;
    }
    const { skip } = classifyTreeEntry(entry);
    if (!skip) {
      entries.push(Object.freeze({
        path: entry.path, sha: text(entry.sha).toLowerCase(), size: entry.size
      }));
      continue;
    }
    /* A directory was never a file, so it is not something a reader missed. */
    if (skip === SKIP_REASONS.NOT_A_FILE) continue;
    skipped.push(Object.freeze({ path: typeof entry.path === 'string' ? entry.path : '', reason: skip }));
  }

  return Object.freeze({
    commitSha,
    entries: Object.freeze(entries),
    skipped: Object.freeze(skipped),
    truncated,
    /* The store's vocabulary, so a caller does not translate. */
    skippedReason: truncated ? 'tree-truncated' : null
  });
}

/*
 * One blob as text, or a reason it was not read. A single unreadable file must
 * not end a scan of ten thousand, so almost everything here is a skip rather
 * than an error -- the exception being a revoked session, which would make
 * every remaining read fail identically.
 */
async function readBlob(input = {}) {
  const reader = requireReader(input.scope);
  const scope = requireScope(input.scope);
  const token = requireToken(input.token);
  const sha = text(input.sha).toLowerCase();
  if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(sha)) {
    return Object.freeze({ text: null, skip: SKIP_REASONS.UNREADABLE });
  }

  const response = await request({
    scope, reader, apiPath: reader.blobPath(scope, sha), token,
    transport: input.transport, maxResponseBytes: MAX_BLOB_RESPONSE_BYTES
  });
  assertAuthorized(Number(response && response.statusCode));
  if (Number(response && response.statusCode) !== 200) {
    return Object.freeze({ text: null, skip: SKIP_REASONS.UNREADABLE });
  }
  const body = parsed(response, MAX_BLOB_RESPONSE_BYTES);
  if (!body || text(body.encoding) !== 'base64' || typeof body.content !== 'string') {
    return Object.freeze({ text: null, skip: SKIP_REASONS.UNREADABLE });
  }

  let bytes;
  try {
    bytes = Buffer.from(body.content, 'base64');
  } catch {
    return Object.freeze({ text: null, skip: SKIP_REASONS.UNREADABLE });
  }
  /*
   * The declared size is the provider's claim; the bytes are the fact. A
   * response that decodes to more than the ceiling is over the ceiling
   * whatever its `size` field said.
   */
  if (bytes.length > MAX_BLOB_BYTES) {
    return Object.freeze({ text: null, skip: SKIP_REASONS.OVERSIZE });
  }
  if (bytes.includes(0)) {
    return Object.freeze({ text: null, skip: SKIP_REASONS.BINARY });
  }
  let decoded;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    /* Not text, and running text rules over arbitrary bytes produces matches
       that are not credentials -- a reader shown one stops trusting the rest. */
    return Object.freeze({ text: null, skip: SKIP_REASONS.BINARY });
  }
  /*
   * An LFS pointer stands in for a large binary object. It is recognised and
   * left alone: fetching what it points at is a second network read of
   * arbitrary size against a service this scan was never authorized for, which
   * is exactly the smudge a clone would have done for us.
   */
  if (decoded.startsWith(LFS_POINTER_PREFIX)) {
    return Object.freeze({ text: null, skip: SKIP_REASONS.LFS_POINTER });
  }
  return Object.freeze({ text: decoded, skip: null });
}

module.exports = Object.freeze({
  DEFAULT_TRANSPORT: guardedFetch,
  ExposureReaderError,
  MAX_BLOB_BYTES,
  MAX_PATH_LENGTH,
  MAX_TREE_ENTRIES,
  SKIP_REASONS,
  classifyTreeEntry,
  readBlob,
  readTree,
  readerFor,
  resolveCommit,
  safePath
});
