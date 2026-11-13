import { PROFILES, guardedFetch } from '../../../platform/network/guarded-fetch.ts';
import {
  MAX_ARCHIVE_BYTES, archiveKind, openArchive, type ArchiveKind, type ArchiveMember, type NamedMember
} from '../domain/exposure-archives.ts';
import { PATH_RULES } from '../domain/exposure-rules.ts';
import { listOf, property, trimmedText } from '../../../platform/values/fields.ts';
import {
  requireReader, requireScope, requireCommit, requireToken, request, assertAuthorized, statusOf, ExposureReaderError,
  parsed, classifyTreeEntry, SKIP_REASONS, safePath, isObjectId, MAX_BLOB_BYTES, READERS, BINARY_EXTENSIONS, bodyText,
  COMMIT_PAGE_SIZE, COMMIT_FILES_PAGE_SIZE, type SkipReason, type ReadInput, type ReaderTransport, type ReaderResponse
} from './provider-reads.ts';
export {
  SKIP_REASONS, MAX_BLOB_BYTES, MAX_PATH_LENGTH, COMMIT_PAGE_SIZE, COMMIT_FILES_PAGE_SIZE, BINARY_EXTENSIONS,
  extensionOf, ExposureReaderError, safePath, classifyTreeEntry, readerFor, resolveCommit
} from './provider-reads.ts';
export type { SkipReason, TreeEntryClass, ReaderScope, Reader, ReaderResponse, ReaderTransport, ReadInput } from './provider-reads.ts';

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

/*
 * Bounds, and each is a number this server can afford rather than a number the
 * provider offers. GitHub's recursive tree truncates at 100,000 entries; this
 * stops at a fifth of that, because the work after the tree read is a blob
 * fetch per file and one free web service cannot spend that.
 */
export const MAX_TREE_ENTRIES = 20_000;
const MAX_TREE_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_BLOB_RESPONSE_BYTES = 1024 * 1024;

const LFS_POINTER_PREFIX = 'version https://git-lfs.github.com/spec/v1';
const MAX_COMMIT_FILE_PAGES = 30;
const MAX_COMMIT_LIST_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_COMMIT_RESPONSE_BYTES = 8 * 1024 * 1024;

/*
 * The tree at a commit, filtered to the files a scan may read, with everything
 * it declined reported alongside.
 */
export interface TreeFile {
  readonly path: string;
  readonly sha: string;
  readonly size: number;
  readonly archive?: ArchiveKind;
}

export interface SkippedEntry {
  readonly path: string;
  readonly reason: SkipReason;
  readonly sha: string | null;
}

export interface Tree {
  readonly commitSha: string;
  readonly entries: readonly TreeFile[];
  readonly skipped: readonly SkippedEntry[];
  readonly truncated: boolean;
  readonly skippedReason: 'tree-truncated' | null;
}

export async function readTree(input: ReadInput & { readonly commitSha?: unknown } = {}): Promise<Tree> {
  const reader = requireReader(input.scope);
  const scope = requireScope(input.scope);
  const commitSha = requireCommit(input.commitSha);
  const token = requireToken(input.token);

  const response = await request({
    scope, reader, apiPath: reader.treePath(scope, commitSha), token,
    transport: input.transport, maxResponseBytes: MAX_TREE_RESPONSE_BYTES
  });
  assertAuthorized(statusOf(response));
  if (statusOf(response) !== 200) {
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

  const entries: TreeFile[] = [];
  const skipped: SkippedEntry[] = [];
  let truncated = Boolean(body.truncated);
  for (const entry of listOf(body.tree)) {
    if (entries.length >= MAX_TREE_ENTRIES) {
      truncated = true;
      break;
    }
    const { skip, archive } = classifyTreeEntry(entry);
    if (!skip) {
      /* A file this scan may read: classifyTreeEntry has checked its path is a string and its size an integer. */
      entries.push(Object.freeze({
        path: String(property(entry, 'path')), sha: trimmedText(property(entry, 'sha')).toLowerCase(), size: Number(property(entry, 'size')),
        ...(archive ? { archive } : {})
      }));
      continue;
    }
    /* A directory was never a file, so it is not something a reader missed. */
    if (skip === SKIP_REASONS.NOT_A_FILE) continue;
    /*
     * The object id travels with a skipped file whose path is safe, because a
     * file can be an exposure without being read: a committed keystore is one
     * whatever its bytes say, and its identity is the blob, not a string in it.
     */
    const entryPath = property(entry, 'path');
    const safe = skip !== SKIP_REASONS.UNSAFE_PATH && safePath(entryPath);
    const sha = trimmedText(property(entry, 'sha')).toLowerCase();
    skipped.push(Object.freeze({
      path: safe ? entryPath : '',
      reason: skip,
      sha: safe && isObjectId(sha) ? sha : null
    }));
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

export function utf16Text(bytes: Buffer | null | undefined): string | null {
  if (!bytes || bytes.length < 4 || bytes.length % 2 !== 0) return null;
  let encoding: 'utf-16le' | 'utf-16be';
  let body = bytes;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) { encoding = 'utf-16le'; body = bytes.subarray(2); }
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) { encoding = 'utf-16be'; body = bytes.subarray(2); }
  else {
    /* No mark: ASCII in little-endian pairs, the high byte of nearly every
       pair zero. A binary file does not look like that. */
    let wide = 0;
    const pairs = bytes.length / 2;
    for (let index = 0; index < bytes.length; index += 2) {
      if (bytes[index + 1] === 0 && bytes[index] !== 0) wide += 1;
    }
    if (wide / pairs < 0.9) return null;
    encoding = 'utf-16le';
  }
  let decoded: string;
  try {
    decoded = new TextDecoder(encoding, { fatal: true }).decode(body);
  } catch {
    return null;
  }
  let printable = 0;
  for (let index = 0; index < decoded.length; index += 1) {
    const code = decoded.charCodeAt(index);
    if (code >= 32 || code === 9 || code === 10 || code === 13) printable += 1;
  }
  return decoded.length && printable / decoded.length >= 0.95 ? decoded : null;
}

/*
 * One blob as text, or a reason it was not read. A single unreadable file must
 * not end a scan of ten thousand, so almost everything here is a skip rather
 * than an error -- the exception being a revoked session, which would make
 * every remaining read fail identically.
 */
/* A file's text, or the reason there is none. */
export interface BlobText {
  readonly text: string | null;
  readonly skip: string | null;
}

export async function readBlob(input: ReadInput & { readonly sha?: unknown; readonly path?: unknown } = {}): Promise<BlobText> {
  const reader = requireReader(input.scope);
  const scope = requireScope(input.scope);
  const token = requireToken(input.token);
  const sha = trimmedText(input.sha).toLowerCase();
  if (!isObjectId(sha)) {
    return Object.freeze({ text: null, skip: SKIP_REASONS.UNREADABLE });
  }

  const response = await request({
    scope, reader, apiPath: reader.blobPath(scope, sha), token,
    transport: input.transport, maxResponseBytes: MAX_BLOB_RESPONSE_BYTES
  });
  assertAuthorized(statusOf(response));
  if (statusOf(response) !== 200) {
    return Object.freeze({ text: null, skip: SKIP_REASONS.UNREADABLE });
  }
  const body = parsed(response, MAX_BLOB_RESPONSE_BYTES);
  if (!body || trimmedText(body.encoding) !== 'base64' || typeof body.content !== 'string') {
    return Object.freeze({ text: null, skip: SKIP_REASONS.UNREADABLE });
  }

  let bytes: Buffer;
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
  return textFromBytes(bytes);
}

/*
 * Bytes as text, or why not -- the one rule for what counts as a text file,
 * used for a blob and for a file inside an archive alike.
 */
export function textFromBytes(bytes: Buffer): BlobText {
  /*
   * Windows tools write UTF-16 -- a `.reg` export, a PowerShell profile, a
   * config saved from Notepad -- and every other character of it is a NUL, so
   * it read as binary and was never scanned. It is decoded as text when it
   * says so with a byte-order mark, or when it is unmistakably ASCII written
   * two bytes at a time.
   */
  const wide = utf16Text(bytes);
  if (wide !== null) {
    if (wide.startsWith(LFS_POINTER_PREFIX)) return Object.freeze({ text: null, skip: SKIP_REASONS.LFS_POINTER });
    return Object.freeze({ text: wide, skip: null });
  }
  if (bytes.includes(0)) {
    return Object.freeze({ text: null, skip: SKIP_REASONS.BINARY });
  }
  let decoded: string;
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

/* ---- Many files in one request ----------------------------------------- */

const GRAPHQL_URL = 'https://api.github.com/graphql';
export const MAX_TEXTS_PER_QUERY = 100;
/* JSON-escaped text runs somewhat larger than the bytes it carries. */
const MAX_TEXTS_RESPONSE_BYTES = 8 * 1024 * 1024;

/*
 * The text of many files at one commit, by path, in one request to GitHub's
 * GraphQL API through the guarded transport's provider-query profile -- where
 * the REST API needs a request per file, which is what capped an audit at a
 * few hundred files. Each path is a query variable, never spliced into the
 * query text. A file GitHub reports as binary or truncated, an LFS pointer,
 * or one missing from the answer is a skip, and a request that fails leaves
 * every file in it unreadable rather than failing the audit -- except a
 * revoked session, which would fail every request after it the same way.
 */
/* Texts by path; `failed` says the request itself did not complete. */
export type BlobTexts = Map<string, BlobText> & { failed?: boolean };

export async function readBlobTexts(input: ReadInput & { readonly commitSha?: unknown; readonly paths?: unknown } = {}): Promise<BlobTexts> {
  const reader = requireReader(input.scope);
  const scope = requireScope(input.scope);
  if (reader !== READERS.github) {
    throw new ExposureReaderError('Batched reads are implemented for GitHub only', 'EXPOSURE_PROVIDER_UNSUPPORTED', 501);
  }
  const token = requireToken(input.token);
  const commitSha = requireCommit(input.commitSha);
  const paths = listOf(input.paths).filter(filePath => safePath(filePath)).slice(0, MAX_TEXTS_PER_QUERY);
  const out: BlobTexts = new Map();
  if (!paths.length) return out;
  const variables: Record<string, string> = { owner: scope.owner, name: scope.repo };
  const declarations = ['$owner: String!', '$name: String!'];
  const fields: string[] = [];
  paths.forEach((filePath, index) => {
    variables[`e${index}`] = `${commitSha}:${filePath}`;
    declarations.push(`$e${index}: String!`);
    fields.push(`f${index}: object(expression: $e${index}) { ... on Blob { text isBinary isTruncated byteSize } }`);
  });
  const query = `query(${declarations.join(', ')}) { repository(owner: $owner, name: $name) { ${fields.join(' ')} } }`;
  const send: ReaderTransport = typeof input.transport === 'function' ? input.transport : guardedFetch;
  let response: ReaderResponse | null | undefined;
  try {
    response = await send({
      url: GRAPHQL_URL,
      profile: PROFILES.PROVIDER_QUERY,
      method: 'POST',
      headers: {
        accept: 'application/json', 'content-type': 'application/json',
        'user-agent': 'Nebulaverse-X-Exposure-Reader/1.0', authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ query, variables }),
      maxResponseBytes: MAX_TEXTS_RESPONSE_BYTES
    });
  } catch {
    for (const filePath of paths) out.set(filePath, Object.freeze({ text: null, skip: SKIP_REASONS.UNREADABLE }));
    /* Said separately, so a caller can ask again for fewer files at a time -- an answer over the size bound is the usual cause. */
    out.failed = true;
    return out;
  }
  assertAuthorized(statusOf(response));
  const body = statusOf(response) === 200 ? parsed(response, MAX_TEXTS_RESPONSE_BYTES) : null;
  const data = body && body.data;
  const found = data && property(data, 'repository');
  const repository = found && typeof found === 'object' ? found : null;
  paths.forEach((filePath, index) => {
    const blob = repository ? property(repository, `f${index}`) : null;
    if (!blob || typeof blob !== 'object') return out.set(filePath, Object.freeze({ text: null, skip: SKIP_REASONS.UNREADABLE }));
    const blobText = property(blob, 'text');
    if (property(blob, 'isBinary') === true || typeof blobText !== 'string') return out.set(filePath, Object.freeze({ text: null, skip: SKIP_REASONS.BINARY }));
    if (property(blob, 'isTruncated') === true || Number(property(blob, 'byteSize')) > MAX_BLOB_BYTES) return out.set(filePath, Object.freeze({ text: null, skip: SKIP_REASONS.OVERSIZE }));
    if (blobText.includes('\u0000')) return out.set(filePath, Object.freeze({ text: null, skip: SKIP_REASONS.BINARY }));
    if (blobText.startsWith(LFS_POINTER_PREFIX)) return out.set(filePath, Object.freeze({ text: null, skip: SKIP_REASONS.LFS_POINTER }));
    return out.set(filePath, Object.freeze({ text: blobText, skip: null }));
  });
  return out;
}

/* ---- Archives ----------------------------------------------------------- */

/* Base64 inside JSON is a third larger than the bytes it carries. */
const MAX_ARCHIVE_RESPONSE_BYTES = Math.ceil(MAX_ARCHIVE_BYTES * 1.4) + 64 * 1024;
const PATH_RULE_EXTENSIONS: readonly string[] = Object.freeze(PATH_RULES.flatMap(rule => rule.extensions));

/* What an archive held, or why it was not opened. */
export interface ArchiveRead {
  readonly skip: SkipReason | null;
  readonly members: readonly ArchiveMember[];
  readonly named: readonly NamedMember[];
  readonly examined: number;
  readonly membersSkipped: number;
  readonly membersSkippedBinary: number;
  readonly truncated: boolean;
}

function archiveSkip(reason: SkipReason): ArchiveRead {
  return Object.freeze({
    skip: reason, members: Object.freeze([]), named: Object.freeze([]),
    examined: 0, membersSkipped: 0, membersSkippedBinary: 0, truncated: false
  });
}

/*
 * The text files inside one archive blob, each located as
 * `<archive>!/<member>`, with credential containers found by name and counts
 * of what was not read. An archive that does not parse is one unreadable file.
 */
export async function readArchive(input: ReadInput & { readonly sha?: unknown; readonly path?: unknown } = {}): Promise<ArchiveRead> {
  const reader = requireReader(input.scope);
  const scope = requireScope(input.scope);
  const token = requireToken(input.token);
  const sha = trimmedText(input.sha).toLowerCase();
  const archivePath = typeof input.path === 'string' ? input.path : '';
  const kind = archiveKind(archivePath);
  if (!kind || !isObjectId(sha)) {
    return archiveSkip(SKIP_REASONS.UNREADABLE);
  }
  let response: ReaderResponse | null | undefined;
  try {
    response = await request({
      scope, reader, apiPath: reader.blobPath(scope, sha), token,
      transport: input.transport, maxResponseBytes: MAX_ARCHIVE_RESPONSE_BYTES
    });
  } catch {
    return archiveSkip(SKIP_REASONS.OVERSIZE);
  }
  assertAuthorized(statusOf(response));
  if (statusOf(response) !== 200) return archiveSkip(SKIP_REASONS.UNREADABLE);
  const body = parsed(response, MAX_ARCHIVE_RESPONSE_BYTES);
  if (!body || trimmedText(body.encoding) !== 'base64' || typeof body.content !== 'string') {
    return archiveSkip(SKIP_REASONS.UNREADABLE);
  }
  const bytes = Buffer.from(body.content, 'base64');
  if (bytes.length > MAX_ARCHIVE_BYTES) return archiveSkip(SKIP_REASONS.OVERSIZE);
  const opened = openArchive({
    bytes, kind, path: archivePath, decodeText: textFromBytes,
    binaryExtensions: BINARY_EXTENSIONS, pathRuleExtensions: PATH_RULE_EXTENSIONS
  });
  if (!opened) return archiveSkip(SKIP_REASONS.UNREADABLE);
  if (opened.oversize) return archiveSkip(SKIP_REASONS.OVERSIZE);
  const skippedCount = Object.values(opened.skipped).reduce((sum, value) => sum + value, 0);
  return Object.freeze({
    skip: null,
    members: opened.members,
    named: opened.named,
    examined: opened.examined,
    membersSkipped: skippedCount,
    membersSkippedBinary: opened.skipped.binary || 0,
    truncated: opened.truncated
  });
}

/*
 * One file's text at one commit, for reading a finding back -- a verification
 * or a readability probe re-detects rather than trusting anything stored. A
 * path inside an archive is read by opening that archive at that commit.
 */
export async function readFileAtCommit(input: ReadInput & { readonly commitSha?: unknown; readonly path?: unknown } = {}): Promise<BlobText> {
  const filePath = typeof input.path === 'string' ? input.path : '';
  const marker = filePath.indexOf('!/');
  const outer = marker > 0 ? filePath.slice(0, marker) : filePath;
  const tree = await readTree({
    scope: input.scope, commitSha: input.commitSha, token: input.token, transport: input.transport
  });
  const entry = tree.entries.find(item => item.path === outer);
  if (!entry) return Object.freeze({ text: null, skip: 'missing' });
  if (marker > 0) {
    if (!entry.archive) return Object.freeze({ text: null, skip: 'missing' });
    const archive = await readArchive({
      scope: input.scope, sha: entry.sha, path: entry.path, token: input.token, transport: input.transport
    });
    const member = archive.skip ? null : archive.members.find(item => item.path === filePath);
    return member ? Object.freeze({ text: member.text, skip: null }) : Object.freeze({ text: null, skip: 'missing' });
  }
  if (entry.archive) return Object.freeze({ text: null, skip: 'missing' });
  return readBlob({ scope: input.scope, sha: entry.sha, path: entry.path, token: input.token, transport: input.transport });
}

/* ---- History ----------------------------------------------------------- */

/*
 * A credential deleted in the commit after the one that added it is still in
 * the repository: anyone with a clone can check out the earlier commit and
 * read it. The tree at one commit cannot show that, so history is read too --
 * every commit's changes, through the same provider API and the same guarded
 * transport, with nothing cloned and nothing run.
 *
 * What is scanned is what each commit added. A line that was already there is
 * the business of the commit that added it, so a credential is reported once,
 * at the commit that introduced it, rather than once for every commit that
 * happened to leave it alone.
 */

function parsedArray(response: ReaderResponse | null | undefined, maxBytes: number): readonly unknown[] | null {
  const body = bodyText(response);
  if (!body || body.length > maxBytes) return null;
  try {
    const value: unknown = JSON.parse(body);
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/*
 * A 403 or 429 from a history read is the provider asking us to stop, and
 * every following read would get the same answer. It ends the history part of
 * a scan -- recorded as partial, with the reason -- instead of being counted
 * as one unreadable commit after another.
 */
function assertNotThrottled(statusCode: number): void {
  if (statusCode === 403 || statusCode === 429) {
    throw new ExposureReaderError(
      'The provider asked for fewer requests',
      'EXPOSURE_RATE_LIMITED',
      429
    );
  }
}

function commitDate(item: unknown): string | null {
  const found = item && property(item, 'commit');
  const commit = found && typeof found === 'object' ? found : {};
  const committer = property(commit, 'committer');
  const committed = Date.parse(trimmedText(committer && property(committer, 'date')));
  if (Number.isFinite(committed)) return new Date(committed).toISOString();
  const author = property(commit, 'author');
  const authored = Date.parse(trimmedText(author && property(author, 'date')));
  return Number.isFinite(authored) ? new Date(authored).toISOString() : null;
}

/*
 * The commits reachable from a commit, newest first, up to a ceiling. A prior
 * scan's tip is not a safe stopping point: newly merged branches can contain
 * older commits after that tip in the provider's date-ordered listing. Read
 * the bounded reachable history again until ancestry coverage can be proven.
 * Only ids, dates and parent counts are retained, never authors or messages.
 */
export interface CommitSummary {
  readonly sha: string;
  readonly committedAt: string | null;
  readonly parents: number;
}

export interface HistoryInput extends ReadInput {
  readonly commitSha?: unknown;
  readonly maxCommits?: unknown;
  readonly beforePage?: (() => unknown) | undefined;
}

export async function listCommits(input: HistoryInput = {}): Promise<{ readonly commits: readonly CommitSummary[]; readonly truncated: boolean }> {
  const reader = requireReader(input.scope);
  const scope = requireScope(input.scope);
  const commitSha = requireCommit(input.commitSha);
  const token = requireToken(input.token);
  const asked = input.maxCommits;
  const maxCommits = typeof asked === 'number' && Number.isInteger(asked) && asked > 0 ? asked : 1000;

  const commits: CommitSummary[] = [];
  const seen = new Set<string>();
  let truncated = false;
  /* A repeated or malformed full page must not create an endless listing.
     One lookahead page distinguishes an exact ceiling from a longer history. */
  const maxPages = Math.ceil(maxCommits / COMMIT_PAGE_SIZE) + 1;
  for (let page = 1; page <= maxPages; page += 1) {
    if (typeof input.beforePage === 'function') await input.beforePage();
    const response = await request({
      scope, reader, apiPath: reader.commitListPath(scope, commitSha, page), token,
      transport: input.transport, maxResponseBytes: MAX_COMMIT_LIST_RESPONSE_BYTES
    });
    const status = statusOf(response);
    assertAuthorized(status);
    assertNotThrottled(status);
    /* An empty repository answers 409 to a history read. Anything else that
       is not a page is not a short history, and is not reported as one. */
    if (status === 409 && page === 1) break;
    if (status !== 200) {
      throw new ExposureReaderError('The repository history could not be read', 'EXPOSURE_HISTORY_UNAVAILABLE', 502);
    }
    const items = parsedArray(response, MAX_COMMIT_LIST_RESPONSE_BYTES);
    if (!items) {
      throw new ExposureReaderError('The repository history response was not a list', 'EXPOSURE_HISTORY_INVALID', 502);
    }
    for (const item of items) {
      const sha = trimmedText(item && property(item, 'sha')).toLowerCase();
      if (!isObjectId(sha) || seen.has(sha)) continue;
      if (commits.length >= maxCommits) { truncated = true; break; }
      seen.add(sha);
      commits.push(Object.freeze({
        sha,
        committedAt: commitDate(item),
        parents: listOf(item && property(item, 'parents')).length
      }));
    }
    if (truncated || items.length < COMMIT_PAGE_SIZE) break;
    if (page === maxPages) truncated = true;
  }
  return Object.freeze({ commits: Object.freeze(commits), truncated });
}

/*
 * A unified diff, reduced to the new side of each hunk: the lines a reader of
 * the file at this commit would see, each with its line number and whether
 * this commit added it. Context lines are kept because some credentials are
 * only recognisable beside the words around them; only a match on an added
 * line is ever reported.
 */
export interface PatchLine {
  readonly line: number;
  readonly text: string;
  readonly added: boolean;
}

export interface Hunk {
  readonly lines: readonly PatchLine[];
}

export function parsePatch(patch: unknown): readonly Hunk[] {
  const source = typeof patch === 'string' ? patch : '';
  const hunks: { readonly lines: PatchLine[] }[] = [];
  let current: { readonly lines: PatchLine[] } | null = null;
  let next = 0;
  for (const raw of source.split('\n')) {
    const header = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (header) {
      current = { lines: [] };
      hunks.push(current);
      next = Number(header[1]);
      continue;
    }
    if (!current) continue;
    const marker = raw.charAt(0);
    const content = raw.slice(1).replace(/\r$/, '');
    if (marker === '+') {
      current.lines.push(Object.freeze({ line: next, text: content, added: true }));
      next += 1;
    } else if (marker === ' ') {
      current.lines.push(Object.freeze({ line: next, text: content, added: false }));
      next += 1;
    }
    /* A removed line has no place in the new file, and `\ No newline at end
       of file` is a note about the line before it. */
  }
  return Object.freeze(hunks
    .filter(hunk => hunk.lines.some(line => line.added))
    .map(hunk => Object.freeze({ lines: Object.freeze(hunk.lines) })));
}

/*
 * One commit's changes. A file whose path is unsafe is reported and not
 * described; a removed file has nothing new in it; a file the provider sent
 * no patch for -- a binary, or a diff too large to include -- comes back
 * without hunks and with its blob id, so a caller can read the blob instead
 * or report it as not read.
 */
export interface ChangedFile {
  readonly path: string;
  readonly status: string;
  readonly blobSha: string | null;
  readonly hunks: readonly Hunk[] | null;
}

export interface CommitChanges {
  readonly sha: string;
  readonly skip: SkipReason | null;
  readonly files: readonly ChangedFile[];
  readonly committedAt: string | null;
  readonly parents: number;
  readonly unsafePaths?: number;
  readonly truncated?: boolean;
}

export async function readCommitChanges(input: ReadInput & { readonly sha?: unknown; readonly beforePage?: (() => unknown) | undefined } = {}): Promise<CommitChanges> {
  const reader = requireReader(input.scope);
  const scope = requireScope(input.scope);
  const sha = requireCommit(input.sha);
  const token = requireToken(input.token);

  const files: ChangedFile[] = [];
  let unsafePaths = 0;
  let truncated = false;
  let committedAt: string | null = null;
  let parents = 0;
  for (let page = 1; page <= MAX_COMMIT_FILE_PAGES; page += 1) {
    /* Outside the transport catch: losing access is not an unreadable commit. */
    if (typeof input.beforePage === 'function') await input.beforePage();
    let response: ReaderResponse | null | undefined;
    try {
      response = await request({
        scope, reader, apiPath: reader.commitChangesPath(scope, sha, page), token,
        transport: input.transport, maxResponseBytes: MAX_COMMIT_RESPONSE_BYTES
      });
    } catch {
      /* A commit too large to fetch is one commit not read, not a failed
         scan: it is reported, and the rest of history is still read. */
      return Object.freeze({ sha, skip: SKIP_REASONS.UNREADABLE, files: Object.freeze(files), committedAt, parents });
    }
    const status = statusOf(response);
    assertAuthorized(status);
    assertNotThrottled(status);
    if (status !== 200) {
      return Object.freeze({ sha, skip: SKIP_REASONS.UNREADABLE, files: Object.freeze(files), committedAt, parents });
    }
    const body = parsed(response, MAX_COMMIT_RESPONSE_BYTES);
    if (!body || !Array.isArray(body.files)) {
      return Object.freeze({ sha, skip: SKIP_REASONS.UNREADABLE, files: Object.freeze(files), committedAt, parents });
    }
    if (page === 1) {
      committedAt = commitDate(body);
      parents = listOf(body.parents).length;
    }
    const changed = listOf(body.files);
    for (const file of changed) {
      const filename = file && property(file, 'filename');
      const filePath = typeof filename === 'string' ? filename : '';
      const status = trimmedText(file && property(file, 'status'));
      if (status === 'removed') continue;
      if (!safePath(filePath)) { unsafePaths += 1; continue; }
      const blobSha = trimmedText(file && property(file, 'sha')).toLowerCase();
      const found = file && property(file, 'patch');
      const patch = typeof found === 'string' ? found : null;
      files.push(Object.freeze({
        path: filePath,
        status,
        blobSha: isObjectId(blobSha) ? blobSha : null,
        hunks: patch === null ? null : parsePatch(patch)
      }));
    }
    if (changed.length < COMMIT_FILES_PAGE_SIZE) break;
    if (page === MAX_COMMIT_FILE_PAGES) truncated = true;
  }
  return Object.freeze({
    sha, skip: null, committedAt, parents, files: Object.freeze(files), unsafePaths, truncated
  });
}

export const DEFAULT_TRANSPORT = guardedFetch;
