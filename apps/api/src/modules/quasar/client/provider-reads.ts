import { PROFILES, guardedFetch, type GuardedFetchInput } from '../../../platform/network/guarded-fetch.ts';
import { MAX_ARCHIVE_BYTES, archiveKind, type ArchiveKind } from '../domain/exposure-archives.ts';
import { isCommitSha, isSha256Hex } from '../../../../../../packages/contracts/src/ids.ts';
import { property, trimmedText } from '../../../platform/values/fields.ts';

/*
 * What every provider read in exposure-reader.ts stands on.
 *
 * The reasons an entry is declined, and the decisions made about a path and a
 * tree entry before anything is read: whether the path is safe to show and
 * what kind of entry it is. The provider each scope is read from, the checks
 * on a scope, a commit and a token, the request itself through the guarded
 * transport, and resolving a ref to the commit a scan then reads and nothing
 * else.
 */

/* An entry a scan declined to read, with the reason, so coverage can say so. */
export const SKIP_REASONS = Object.freeze({
  NOT_A_FILE: 'not-a-file',
  SYMLINK: 'symlink',
  SUBMODULE: 'submodule',
  OVERSIZE: 'oversize',
  BINARY: 'binary',
  LFS_POINTER: 'lfs-pointer',
  UNSAFE_PATH: 'unsafe-path',
  UNREADABLE: 'unreadable'
} as const);
export type SkipReason = (typeof SKIP_REASONS)[keyof typeof SKIP_REASONS];
export const MAX_BLOB_BYTES = 512 * 1024;
export const MAX_PATH_LENGTH = 1024;

/* A blob mode is a file, an executable file, a symlink or a gitlink. */
const FILE_MODES: readonly string[] = Object.freeze(['100644', '100755']);
const SYMLINK_MODE = '120000';
const GITLINK_MODE = '160000';

/*
 * History is read a page of commits at a time, and each commit a page of
 * changed files at a time. The provider stops listing a commit's files at
 * 3,000, which is thirty of these pages; a commit past that is reported as
 * partly read rather than quietly shortened.
 */
export const COMMIT_PAGE_SIZE = 100;
export const COMMIT_FILES_PAGE_SIZE = 100;

/*
 * Formats that are binary by definition, recognised from the name so they are
 * never fetched. Every one of these used to cost a provider request only to be
 * refused as binary once its bytes arrived -- and a repository's images, fonts
 * and archives are often most of its entries, so that was most of a scan.
 *
 * Only formats whose bytes cannot be UTF-8 text: each begins with a magic
 * number containing a byte the decoder rejects or a NUL, so fetching one would
 * reach the same skip this reaches without the request. SVG, which is XML,
 * is deliberately absent, and so is anything a person might plausibly have
 * named with a binary-looking extension while writing text into it (`.bin`,
 * `.dat`). The outcome is identical to before -- the file is reported as not
 * read and coverage says partial -- and only the request is saved.
 */
export const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'tif', 'tiff', 'psd', 'heic', 'avif',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'jar', 'war', 'ear', 'apk', 'aab', 'ipa',
  'dmg', 'iso', 'whl', 'nupkg',
  'mp3', 'mp4', 'm4a', 'm4v', 'wav', 'ogg', 'oga', 'flac', 'webm', 'mov', 'avi', 'mkv',
  'pdf', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp',
  'exe', 'dll', 'so', 'dylib', 'class', 'pyc', 'pyo', 'wasm',
  'sqlite', 'sqlite3',
  /* Credential containers are binary too. They are not fetched either: what a
     scan says about one comes from its name, in exposure-detection. */
  'p12', 'pfx', 'jks', 'keystore', 'bks', 'kdbx', 'kdb'
]);

export function extensionOf(filePath: unknown): string {
  const name = String(filePath || '').split('/').pop() || '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export class ExposureReaderError extends Error {
  override readonly name = 'ExposureReaderError';
  readonly code: string;
  readonly status: number;

  /*
   * Carries a code and fixed text. Every request this module makes has the
   * reader's session token in a header, and an error that quotes its own
   * request writes that token into whatever reads the error.
   */
  constructor(message: string, code = 'EXPOSURE_READ_FAILED', status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

type Fields = Readonly<Record<string, unknown>>;

/* A Git object id: SHA-1 or SHA-256, lower-case hex. */
export function isObjectId(value: string): boolean {
  return isCommitSha(value) || isSha256Hex(value);
}

/*
 * A path from a Git tree is bytes somebody else chose. Nothing here shells
 * out, so the danger is not injection -- it is a path that means one thing to
 * this server and another to whatever displays it, and a path that could be
 * read as reaching outside the repository it belongs to.
 */
export function safePath(value: unknown): value is string {
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
export interface TreeEntryClass {
  readonly skip: SkipReason | null;
  readonly archive?: ArchiveKind;
}

export function classifyTreeEntry(entry: unknown): TreeEntryClass {
  const source: Fields = entry && typeof entry === 'object' ? entry as Fields : {};
  const type = trimmedText(source.type);
  const mode = trimmedText(source.mode);

  /* Order matters. A gitlink is a submodule whether or not the provider also
     labelled it a commit, and a symlink is a symlink whatever its type says. */
  if (type === 'commit' || mode === GITLINK_MODE) return { skip: SKIP_REASONS.SUBMODULE };
  if (mode === SYMLINK_MODE) return { skip: SKIP_REASONS.SYMLINK };
  if (type !== 'blob') return { skip: SKIP_REASONS.NOT_A_FILE };
  if (!FILE_MODES.includes(mode)) return { skip: SKIP_REASONS.UNREADABLE };
  if (!safePath(source.path)) return { skip: SKIP_REASONS.UNSAFE_PATH };
  if (!isObjectId(trimmedText(source.sha))) return { skip: SKIP_REASONS.UNREADABLE };
  /*
   * An entry with no size is not a small file. The tree endpoint reports a
   * size for every blob, so its absence means this entry is not what it
   * appears to be -- and reading it would be reading an unbounded thing.
   */
  const size = source.size;
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 0) return { skip: SKIP_REASONS.UNREADABLE };
  /*
   * An archive is opened rather than skipped: its files are one download away
   * from anyone who can read the repository. It has its own, larger ceiling,
   * because it is compressed and its members are bounded again inside.
   */
  const archive = archiveKind(source.path);
  if (archive) {
    if (size > MAX_ARCHIVE_BYTES) return { skip: SKIP_REASONS.OVERSIZE };
    return { skip: null, archive };
  }
  if (size > MAX_BLOB_BYTES) return { skip: SKIP_REASONS.OVERSIZE };
  if (BINARY_EXTENSIONS.has(extensionOf(source.path))) return { skip: SKIP_REASONS.BINARY };
  return { skip: null };
}

/* ---- Providers --------------------------------------------------------- */

/*
 * One reader, for one provider, because a guessed tree API returns nothing and
 * looks successful -- which for a security feature is worse than refusing.
 * Another provider gets a reader when somebody has read its documentation and
 * written the fixtures.
 */
export interface ReaderScope {
  readonly owner: string;
  readonly repo: string;
}

export interface Reader {
  readonly provider: string;
  readonly origin: string;
  readonly headers: Readonly<Record<string, string>>;
  treePath(scope: ReaderScope, commitSha: string): string;
  blobPath(scope: ReaderScope, sha: string): string;
  commitPath(scope: ReaderScope, ref: string): string;
  commitListPath(scope: ReaderScope, commitSha: string, page: number): string;
  commitChangesPath(scope: ReaderScope, commitSha: string, page: number): string;
}

export const READERS: Readonly<Record<string, Reader>> = Object.freeze({
  github: Object.freeze<Reader>({
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
      `/repos/${encodeURIComponent(scope.owner)}/${encodeURIComponent(scope.repo)}/commits/${encodeURIComponent(ref)}`,
    /* History, newest first from a commit, a page at a time. */
    commitListPath: (scope, commitSha, page) =>
      `/repos/${encodeURIComponent(scope.owner)}/${encodeURIComponent(scope.repo)}/commits?sha=${commitSha}&per_page=${COMMIT_PAGE_SIZE}&page=${page}`,
    /* One commit with its changed files and their patches, a page of files at
       a time -- the commit's own fields repeat on every page. */
    commitChangesPath: (scope, commitSha, page) =>
      `/repos/${encodeURIComponent(scope.owner)}/${encodeURIComponent(scope.repo)}/commits/${commitSha}?per_page=${COMMIT_FILES_PAGE_SIZE}&page=${page}`
  })
});

/* Only a provider this module names: an inherited key is not a reader. */
export function readerFor(provider: unknown): Reader | null {
  const key = trimmedText(provider);
  return (Object.hasOwn(READERS, key) && READERS[key]) || null;
}

export function requireReader(scope: unknown): Reader {
  const reader = readerFor(scope && property(scope, 'provider'));
  if (!reader) {
    throw new ExposureReaderError(
      'No exposure reader is implemented for this provider',
      'EXPOSURE_PROVIDER_UNSUPPORTED',
      501
    );
  }
  return reader;
}

export function requireScope(scope: unknown): ReaderScope {
  const source: Fields = scope && typeof scope === 'object' ? scope as Fields : {};
  const owner = trimmedText(source.owner);
  const repo = trimmedText(source.repo);
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
export function requireCommit(commitSha: unknown): string {
  const value = trimmedText(commitSha).toLowerCase();
  if (!isObjectId(value)) {
    throw new ExposureReaderError('A tree must be read at an immutable commit', 'EXPOSURE_COMMIT_INVALID', 400);
  }
  return value;
}

export function requireToken(token: unknown): string {
  const value = typeof token === 'string' ? token : '';
  if (!value) throw new ExposureReaderError('A repository read requires an authorized session', 'EXPOSURE_AUTHORIZATION_MISSING', 401);
  return value;
}

/*
 * A 401 is the session being gone. Every subsequent read would fail the same
 * way, so it stops the scan rather than being skipped file by file -- and the
 * scan stops holding the token, rather than keeping it to retry with.
 */
export function assertAuthorized(statusCode: number): void {
  if (statusCode === 401) {
    throw new ExposureReaderError(
      'The authorized session for this repository is no longer valid',
      'EXPOSURE_AUTHORIZATION_REVOKED',
      401
    );
  }
}

/* What a read is answered with: a status and a body, either of which may be missing. */
export interface ReaderResponse {
  readonly statusCode?: unknown;
  readonly body?: unknown;
}

/* The guarded transport, or a stand-in with its shape. */
export type ReaderTransport = (input: GuardedFetchInput) => Promise<ReaderResponse | null | undefined>;

interface ReadRequest {
  readonly scope: ReaderScope;
  readonly reader: Reader;
  readonly apiPath: string;
  readonly token: string;
  readonly transport?: ReaderTransport | undefined;
  readonly maxResponseBytes: number;
  readonly accept?: string;
}

export async function request({ scope, reader, apiPath, token, transport, maxResponseBytes, accept = '' }: ReadRequest): Promise<ReaderResponse | null | undefined> {
  const send: ReaderTransport = typeof transport === 'function' ? transport : guardedFetch;
  const headers: NonNullable<GuardedFetchInput['headers']> = { ...reader.headers, ...(accept ? { accept } : {}), authorization: `Bearer ${token}` };
  try {
    return await send({
      url: `${reader.origin}${apiPath}`,
      profile: PROFILES.PROVIDER_READ,
      method: 'GET',
      headers,
      maxResponseBytes
    });
  } catch {
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

export function bodyText(response: ReaderResponse | null | undefined): string {
  return response && typeof response.body === 'string' ? response.body : '';
}

export function statusOf(response: ReaderResponse | null | undefined): number {
  return Number(response && response.statusCode);
}

export function parsed(response: ReaderResponse | null | undefined, maxBytes: number): Fields | null {
  const body = bodyText(response);
  if (!body || body.length > maxBytes) return null;
  try {
    const value: unknown = JSON.parse(body);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Fields : null;
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

function requireRef(ref: unknown): string {
  const value = trimmedText(ref);
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
/* What a read is asked with. Each field is checked before it is used. */
export interface ReadInput {
  readonly scope?: unknown;
  readonly token?: unknown;
  readonly transport?: ReaderTransport | undefined;
}

export async function resolveCommit(input: ReadInput & { readonly ref?: unknown } = {}): Promise<{ readonly ref: string; readonly commitSha: string }> {
  const reader = requireReader(input.scope);
  const scope = requireScope(input.scope);
  const ref = requireRef(input.ref);
  const token = requireToken(input.token);

  const response = await request({
    scope, reader, apiPath: reader.commitPath(scope, ref), token,
    /* Ask for the immutable id alone, not a potentially enormous merge diff. */
    transport: input.transport, maxResponseBytes: 1024, accept: 'application/vnd.github.sha'
  });
  assertAuthorized(statusOf(response));
  if ([403, 429].includes(statusOf(response)) || statusOf(response) >= 500) {
    throw new ExposureReaderError('The provider could not complete the read', 'EXPOSURE_READ_FAILED', 502);
  }
  if (statusOf(response) !== 200) {
    throw new ExposureReaderError('That ref could not be resolved', 'EXPOSURE_REF_UNRESOLVED', 404);
  }
  const sha = trimmedText(response && response.body).toLowerCase();
  if (!isObjectId(sha)) {
    throw new ExposureReaderError('That ref did not resolve to a commit', 'EXPOSURE_REF_UNRESOLVED', 502);
  }
  return Object.freeze({ ref, commitSha: sha });
}
