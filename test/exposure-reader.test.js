'use strict';

/*
 * Reading a repository without having a copy of it.
 *
 * Every other way to read a Git repository runs code. `git clone` runs hooks
 * and filters, a checkout smudges LFS pointers into network fetches, a
 * submodule is a second repository somebody else controls, and installing
 * dependencies to inspect them is running the thing you were trying to
 * inspect. None of that is available to a scanner that is pointed at
 * repositories it has never seen, so this reads the provider's tree and blob
 * APIs and nothing else -- no subprocess, no working directory, no code from
 * the repository ever executed.
 *
 * What is left is the boring, necessary part: a Git tree can contain entries
 * that are not files, paths that are not safe to display, blobs that are not
 * text and blobs that are larger than this server will hold. Each of those is
 * a decision, each is visible in the coverage a scan reports, and none of them
 * is allowed to look like "this repository is clean".
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { PROFILES, guardedFetch } = require('../src/guarded-fetch');
const {
  DEFAULT_TRANSPORT,
  MAX_BLOB_BYTES,
  MAX_PATH_LENGTH,
  MAX_TREE_ENTRIES,
  SKIP_REASONS,
  COMMIT_FILES_PAGE_SIZE,
  COMMIT_PAGE_SIZE,
  classifyTreeEntry,
  listCommits,
  parsePatch,
  readBlob,
  readCommitChanges,
  readTree,
  readerFor,
  resolveCommit
} = require('../src/exposure-reader');

const scope = Object.freeze({
  provider: 'github', authority: 'github.com', owner: 'Acme', repo: 'Demo'
});
const COMMIT = 'c'.repeat(40);
const TOKEN = `gh${'p'}_${'R'.repeat(36)}`;

function transportReturning(...answers) {
  const calls = [];
  const queue = answers.slice();
  const transport = async request => {
    calls.push(request);
    const answer = queue.length > 1 ? queue.shift() : queue[0];
    if (typeof answer === 'function') return answer(request);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  transport.calls = calls;
  return transport;
}

function treeResponse(entries, truncated = false) {
  return { statusCode: 200, body: JSON.stringify({ sha: 'd'.repeat(40), truncated, tree: entries }) };
}

function blobEntry(entryPath, overrides = {}) {
  return { path: entryPath, mode: '100644', type: 'blob', sha: 'e'.repeat(40), size: 120, ...overrides };
}

(async () => {
  /* ---- Nothing runs, and nothing reaches the network unguarded --------- */

  {
    assert.strictEqual(DEFAULT_TRANSPORT, guardedFetch, 'the default transport is the guarded one itself');
    /*
     * Comments stripped first. This module's own comment explains why `git
     * clone` is not an option here, and a scan that read prose as code would
     * fail on the sentence describing the thing it forbids -- which is how a
     * guard like this turns into one somebody deletes.
     */
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'exposure-reader.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert(source.includes('function readTree'), 'the comment strip must leave the code behind');
    for (const forbidden of [
      /require\('child_process'\)/, /\bspawn\w*\(/, /\bexec\w*\(/, /\bfork\(/,
      /require\('https'\)/, /require\('fs'\)/, /\bfetch\s*\(/, /\bgit\s+(?:clone|fetch|checkout)/
    ]) {
      assert.strictEqual(
        forbidden.test(source), false,
        `this module must not run anything or reach the network itself: ${forbidden}`
      );
    }
  }

  /* ---- The tree is read at a commit, never at a ref -------------------- */

  {
    const transport = transportReturning(treeResponse([blobEntry('app/config.js')]));
    const tree = await readTree({ scope, commitSha: COMMIT, token: TOKEN, transport });
    assert.strictEqual(tree.entries.length, 1);
    assert.strictEqual(tree.truncated, false);

    const [call] = transport.calls;
    assert.strictEqual(call.url, `https://api.github.com/repos/Acme/Demo/git/trees/${COMMIT}?recursive=1`);
    assert.strictEqual(call.method, 'GET');
    assert.strictEqual(call.profile, PROFILES.PROVIDER_READ);
    assert.strictEqual(call.headers.authorization, `Bearer ${TOKEN}`);
    assert.strictEqual(
      call.url.includes(TOKEN), false,
      'the token travels in a header; the transport would refuse it in the URL'
    );

    /*
     * A ref is not accepted here at all. A branch name resolved at read time
     * is a branch that can move between the tree read and the blob reads, and
     * a scan that mixed two trees would report findings at locations that
     * never existed together.
     */
    for (const bad of ['refs/heads/main', 'main', 'HEAD', `${COMMIT}x`, COMMIT.slice(0, 7), '']) {
      await assert.rejects(
        readTree({ scope, commitSha: bad, token: TOKEN, transport }),
        /commit/i,
        `a tree must be read at an immutable commit, not ${JSON.stringify(bad)}`
      );
    }
  }

  /* A truncated tree is partial coverage, not a short repository. */
  {
    const transport = transportReturning(treeResponse([blobEntry('a.js')], true));
    const tree = await readTree({ scope, commitSha: COMMIT, token: TOKEN, transport });
    assert.strictEqual(tree.truncated, true);
    assert.strictEqual(tree.skippedReason, 'tree-truncated');
  }

  /* And a tree larger than this server will walk is truncated by us. */
  {
    const many = Array.from({ length: MAX_TREE_ENTRIES + 25 }, (_value, index) => blobEntry(`f${index}.js`));
    const transport = transportReturning(treeResponse(many));
    const tree = await readTree({ scope, commitSha: COMMIT, token: TOKEN, transport });
    assert.strictEqual(tree.entries.length, MAX_TREE_ENTRIES);
    assert.strictEqual(tree.truncated, true);
    assert.strictEqual(tree.skippedReason, 'tree-truncated');
  }

  /* A malformed tree response is an error, not an empty repository. */
  {
    for (const body of ['{}', '{"tree":null}', 'not json', '[]', '{"tree":{}}']) {
      const transport = transportReturning({ statusCode: 200, body });
      await assert.rejects(
        readTree({ scope, commitSha: COMMIT, token: TOKEN, transport }),
        /tree/i,
        `an unreadable tree must not look like an empty one: ${body}`
      );
    }
    for (const statusCode of [403, 404, 409, 500]) {
      const transport = transportReturning({ statusCode, body: '{}' });
      await assert.rejects(
        readTree({ scope, commitSha: COMMIT, token: TOKEN, transport }),
        error => error.code === 'EXPOSURE_TREE_UNAVAILABLE',
        String(statusCode)
      );
    }
    /*
     * 401 is its own answer, here as for a blob. The session is gone, so every
     * subsequent read would fail identically -- and the difference matters to
     * the worker, which must stop and stop holding the token rather than
     * record a repository it could not read as one it read and found clean.
     */
    await assert.rejects(
      readTree({ scope, commitSha: COMMIT, token: TOKEN, transport: transportReturning({ statusCode: 401, body: '{}' }) }),
      error => error.code === 'EXPOSURE_AUTHORIZATION_REVOKED' && error.status === 401
    );
  }

  /* ---- What a tree entry is, and whether it may be read --------------- */

  /*
   * A Git tree is not a list of files. Every one of these is a real entry
   * kind, and reading any of them as though it were a text file is either
   * wrong or dangerous.
   */
  {
    const cases = [
      ['an ordinary file', blobEntry('src/app.js'), null],
      ['an executable file', blobEntry('bin/run.sh', { mode: '100755' }), null],
      ['a directory', blobEntry('src', { type: 'tree', mode: '040000', size: undefined }), SKIP_REASONS.NOT_A_FILE],
      /*
       * A symlink's blob content is a path, not a file. Reading it tells you
       * nothing and following it is a traversal into whatever the repository
       * chose to point at.
       */
      ['a symlink', blobEntry('link', { mode: '120000' }), SKIP_REASONS.SYMLINK],
      /*
       * A submodule is a second repository under somebody else's control, and
       * this scan is authorized for one repository.
       */
      ['a submodule', blobEntry('vendor/lib', { type: 'commit', mode: '160000' }), SKIP_REASONS.SUBMODULE],
      ['a gitlink by mode alone', blobEntry('vendor/other', { mode: '160000' }), SKIP_REASONS.SUBMODULE],
      ['an oversized file', blobEntry('big.json', { size: MAX_BLOB_BYTES + 1 }), SKIP_REASONS.OVERSIZE],
      ['a file of unknown size', blobEntry('odd.js', { size: undefined }), SKIP_REASONS.UNREADABLE],
      ['an absolute path', blobEntry('/etc/passwd'), SKIP_REASONS.UNSAFE_PATH],
      ['a traversal', blobEntry('../outside.js'), SKIP_REASONS.UNSAFE_PATH],
      ['a traversal in the middle', blobEntry('a/../../b.js'), SKIP_REASONS.UNSAFE_PATH],
      ['a windows path', blobEntry('a\\b.js'), SKIP_REASONS.UNSAFE_PATH],
      ['an empty segment', blobEntry('a//b.js'), SKIP_REASONS.UNSAFE_PATH],
      ['a dot segment', blobEntry('a/./b.js'), SKIP_REASONS.UNSAFE_PATH],
      ['a git directory', blobEntry('.git/config'), SKIP_REASONS.UNSAFE_PATH],
      ['a nested git directory', blobEntry('vendor/.git/config'), SKIP_REASONS.UNSAFE_PATH],
      ['a newline in a path', blobEntry('a\nb.js'), SKIP_REASONS.UNSAFE_PATH],
      ['a NUL in a path', blobEntry('a\u0000b.js'), SKIP_REASONS.UNSAFE_PATH],
      ['an over-long path', blobEntry(`${'a/'.repeat(MAX_PATH_LENGTH)}b.js`), SKIP_REASONS.UNSAFE_PATH],
      ['no path at all', blobEntry(''), SKIP_REASONS.UNSAFE_PATH],
      ['a missing sha', blobEntry('a.js', { sha: '' }), SKIP_REASONS.UNREADABLE],
      ['a malformed sha', blobEntry('a.js', { sha: 'nothex' }), SKIP_REASONS.UNREADABLE],
      /*
       * Binary by name, and never fetched. Each of these used to cost a
       * provider request only to be refused once its bytes arrived.
       */
      ['an image', blobEntry('public/logo.png'), SKIP_REASONS.BINARY],
      ['an image with an upper-case extension', blobEntry('public/Photo.JPEG'), SKIP_REASONS.BINARY],
      ['a font', blobEntry('fonts/inter.woff2'), SKIP_REASONS.BINARY],
      ['a keystore', blobEntry('android/app/release.jks'), SKIP_REASONS.BINARY],
      /* An archive too large to open is over its own ceiling, not binary. */
      ['an archive past its ceiling', blobEntry('dist/huge.zip', { size: 5 * 1024 * 1024 }), SKIP_REASONS.OVERSIZE],
      ['a disk image', blobEntry('dist/installer.dmg'), SKIP_REASONS.BINARY]
    ];
    for (const [label, entry, expected] of cases) {
      assert.strictEqual(classifyTreeEntry(entry).skip, expected, label);
    }
    assert(cases.length >= 22, 'the entry table must stay exhaustive');

    /*
     * Archives are opened rather than skipped -- their files are one download
     * away from anyone who can read the repository -- and say what kind they
     * are, including one larger than an ordinary file may be.
     */
    for (const [archivePath, kind] of [
      ['dist/release.tar.gz', 'tgz'], ['dist/release.tgz', 'tgz'], ['backup.tar', 'tar'], ['dump.sql.gz', 'gz'],
      ['build/app.jar', 'zip'], ['deploy/site.war', 'zip'], ['docs/Spec.DOCX', 'zip'], ['wheel.whl', 'zip']
    ]) {
      const classified = classifyTreeEntry(blobEntry(archivePath, { size: 3 * 1024 * 1024 }));
      assert.strictEqual(classified.skip, null, archivePath);
      assert.strictEqual(classified.archive, kind, archivePath);
    }

    /* A path that merely looks alarming is still a path. */
    for (const safe of ['a/gitignore', 'dot.git.js', 'a/..b/c.js', 'a/b..c', 'src/.env.example']) {
      assert.strictEqual(classifyTreeEntry(blobEntry(safe)).skip, null, safe);
    }

    /*
     * And text that merely sits near a binary name is still read. SVG is XML;
     * `.bin` and `.dat` are names people put text under; a dotfile has no
     * extension at all; and an extension in a directory name is not the
     * file's. Skipping any of these would be a place a credential could be
     * that the scan decided not to look, on a guess.
     */
    for (const text of [
      'icons/logo.svg', 'data/seed.bin', 'data/export.dat', '.png', 'assets.png/readme.md',
      'config.json', 'notes.txt', 'Makefile'
    ]) {
      assert.strictEqual(classifyTreeEntry(blobEntry(text)).skip, null, text);
    }
  }

  /* The skips come back with the tree, so coverage can be honest about them. */
  {
    const transport = transportReturning(treeResponse([
      blobEntry('app.js'),
      blobEntry('link', { mode: '120000' }),
      blobEntry('vendor/lib', { type: 'commit', mode: '160000' }),
      blobEntry('huge.bin', { size: MAX_BLOB_BYTES + 1 }),
      blobEntry('src', { type: 'tree', mode: '040000' })
    ]));
    const tree = await readTree({ scope, commitSha: COMMIT, token: TOKEN, transport });
    assert.deepStrictEqual(tree.entries.map(entry => entry.path), ['app.js']);
    assert.deepStrictEqual(
      tree.skipped.map(item => [item.path, item.reason]).sort(),
      [
        ['huge.bin', SKIP_REASONS.OVERSIZE],
        ['link', SKIP_REASONS.SYMLINK],
        ['vendor/lib', SKIP_REASONS.SUBMODULE]
      ].sort(),
      'a directory is not a skipped file; the other three are things we declined to read'
    );
  }

  /*
   * A skipped file whose path is safe carries its object id, because a file
   * can be an exposure without being read -- a committed keystore is one
   * whatever its bytes say. An unsafe path carries neither its name nor its id:
   * nothing downstream should be able to report on a path it refused to show.
   */
  {
    const keystore = blobEntry('android/release.jks');
    const transport = transportReturning(treeResponse([
      keystore,
      blobEntry('../escape.p12'),
      blobEntry('logo.png')
    ]));
    const tree = await readTree({ scope, commitSha: COMMIT, token: TOKEN, transport });
    const byReason = new Map(tree.skipped.map(item => [item.path, item]));
    assert.strictEqual(byReason.get('android/release.jks').sha, keystore.sha);
    assert.strictEqual(byReason.get('android/release.jks').reason, SKIP_REASONS.BINARY);
    const unsafe = tree.skipped.find(item => item.reason === SKIP_REASONS.UNSAFE_PATH);
    assert(unsafe, 'the unsafe entry is still reported as skipped');
    assert.strictEqual(unsafe.path, '');
    assert.strictEqual(unsafe.sha, null);
    assert.strictEqual(tree.entries.length, 0, 'none of the three is fetched');
    assert.strictEqual(transport.calls.length, 1, 'the tree read is the only request');
  }

  /* ---- Blobs ----------------------------------------------------------- */

  {
    const content = Buffer.from('const token = 1;\n', 'utf8').toString('base64');
    const transport = transportReturning({
      statusCode: 200, body: JSON.stringify({ sha: 'e'.repeat(40), size: 17, encoding: 'base64', content })
    });
    const blob = await readBlob({ scope, sha: 'e'.repeat(40), token: TOKEN, transport });
    assert.strictEqual(blob.text, 'const token = 1;\n');
    assert.strictEqual(blob.skip, null);
    assert.strictEqual(
      transport.calls[0].url,
      `https://api.github.com/repos/Acme/Demo/git/blobs/${'e'.repeat(40)}`
    );
    assert.strictEqual(transport.calls[0].profile, PROFILES.PROVIDER_READ);
  }

  /*
   * A binary file is skipped rather than scanned. Running text rules over
   * arbitrary bytes produces matches that are not credentials, and a reader
   * who is shown one stops trusting the rest.
   */
  {
    for (const [label, bytes, reason] of [
      ['a NUL byte', Buffer.from([0x68, 0x00, 0x69]), SKIP_REASONS.BINARY],
      ['invalid utf-8', Buffer.from([0xc3, 0x28, 0x41]), SKIP_REASONS.BINARY],
      ['a lone surrogate', Buffer.from([0xed, 0xa0, 0x80]), SKIP_REASONS.BINARY]
    ]) {
      const transport = transportReturning({
        statusCode: 200,
        body: JSON.stringify({ size: bytes.length, encoding: 'base64', content: bytes.toString('base64') })
      });
      const blob = await readBlob({ scope, sha: 'e'.repeat(40), token: TOKEN, transport });
      assert.strictEqual(blob.skip, reason, label);
      assert.strictEqual(blob.text, null, label);
    }
  }

  /*
   * An LFS pointer is a small text file that stands in for a large binary one.
   * It is read as the text it is and recognised for what it is -- what must
   * never happen is fetching the object it points at, which is a second
   * network read of arbitrary size against a service this scan was not
   * authorized for.
   */
  {
    const pointer = [
      'version https://git-lfs.github.com/spec/v1',
      'oid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393',
      'size 12345',
      ''
    ].join('\n');
    const transport = transportReturning({
      statusCode: 200,
      body: JSON.stringify({
        size: pointer.length, encoding: 'base64',
        content: Buffer.from(pointer, 'utf8').toString('base64')
      })
    });
    const blob = await readBlob({ scope, sha: 'e'.repeat(40), token: TOKEN, transport });
    assert.strictEqual(blob.skip, SKIP_REASONS.LFS_POINTER);
    assert.strictEqual(blob.text, null);
    assert.strictEqual(transport.calls.length, 1, 'and the object behind it is never fetched');
  }

  /* An encoding this reader does not decode is a skip, not a guess. */
  {
    for (const encoding of ['utf-8', 'none', '', undefined]) {
      const transport = transportReturning({
        statusCode: 200, body: JSON.stringify({ size: 3, encoding, content: 'abc' })
      });
      const blob = await readBlob({ scope, sha: 'e'.repeat(40), token: TOKEN, transport });
      assert.strictEqual(blob.skip, SKIP_REASONS.UNREADABLE, String(encoding));
    }
  }

  /* A blob larger than declared is still bounded. */
  {
    const big = Buffer.alloc(MAX_BLOB_BYTES + 100, 0x61);
    const transport = transportReturning({
      statusCode: 200,
      body: JSON.stringify({ size: 10, encoding: 'base64', content: big.toString('base64') })
    });
    const blob = await readBlob({ scope, sha: 'e'.repeat(40), token: TOKEN, transport });
    assert.strictEqual(
      blob.skip, SKIP_REASONS.OVERSIZE,
      'a declared size is the provider claim; the bytes are the fact'
    );
  }

  /* A refusal from the provider is a skip with a reason, not a crash: one
     unreadable file must not end a scan of ten thousand. */
  {
    for (const statusCode of [403, 404, 500]) {
      const transport = transportReturning({ statusCode, body: '{}' });
      const blob = await readBlob({ scope, sha: 'e'.repeat(40), token: TOKEN, transport });
      assert.strictEqual(blob.skip, SKIP_REASONS.UNREADABLE, String(statusCode));
    }
    /* Except an authorization failure, which means the session is gone and
       every subsequent read would fail the same way. */
    const revoked = transportReturning({ statusCode: 401, body: '{}' });
    await assert.rejects(
      readBlob({ scope, sha: 'e'.repeat(40), token: TOKEN, transport: revoked }),
      error => error.code === 'EXPOSURE_AUTHORIZATION_REVOKED',
      'a revoked session must stop the scan rather than skip every file in it'
    );
  }

  /* ---- Providers without a reader ------------------------------------- */

  /*
   * A reader is per provider and there is one. Guessing at another provider's
   * tree API would produce a scan that reported nothing and looked successful,
   * which is the worst possible outcome for a security feature.
   */
  {
    assert(readerFor('github'));
    for (const provider of ['gitlab', 'gitea', 'bitbucket', '', null]) {
      assert.strictEqual(readerFor(provider), null, String(provider));
      await assert.rejects(
        readTree({ scope: { ...scope, provider }, commitSha: COMMIT, token: TOKEN, transport: transportReturning() }),
        error => error.code === 'EXPOSURE_PROVIDER_UNSUPPORTED',
        String(provider)
      );
    }
  }

  /* ---- The token does not come back ------------------------------------ */

  {
    const surfaces = [];
    const transport = transportReturning(() => {
      const error = new Error(`connect failed while sending Bearer ${TOKEN}`);
      error.code = 'GUARDED_FETCH_TRANSPORT_FAILED';
      throw error;
    });
    try {
      await readTree({ scope, commitSha: COMMIT, token: TOKEN, transport });
    } catch (error) {
      surfaces.push(String(error.message), String(error.stack), JSON.stringify(error));
    }
    const blobTransport = transportReturning({ statusCode: 500, body: TOKEN });
    const blob = await readBlob({ scope, sha: 'e'.repeat(40), token: TOKEN, transport: blobTransport });
    surfaces.push(JSON.stringify(blob));

    assert(surfaces.length > 0);
    for (const surface of surfaces) {
      assert.strictEqual(surface.includes(TOKEN), false, `the session token reached an output: ${surface.slice(0, 90)}`);
      assert.strictEqual(surface.includes(TOKEN.slice(4, 20)), false, 'nor part of it');
    }
  }

/* ---- Resolving a ref, exactly once ---------------------------------- */

/*
 * The one place a ref is turned into a commit. It happens when a scan is
 * requested, the answer is stored on the scan row, and nothing afterwards ever
 * looks at the ref again -- which is what stops a branch moving mid-scan from
 * producing a finding set assembled from two trees.
 */
{
  const transport = transportReturning({
    statusCode: 200, body: `${COMMIT}\n`
  });
  const resolved = await resolveCommit({ scope, ref: 'refs/heads/main', token: TOKEN, transport });
  assert.strictEqual(resolved.commitSha, COMMIT);
  assert.strictEqual(
    transport.calls[0].url,
    'https://api.github.com/repos/Acme/Demo/commits/refs%2Fheads%2Fmain'
  );
  assert.strictEqual(transport.calls[0].profile, PROFILES.PROVIDER_READ);
  assert.strictEqual(transport.calls[0].headers.accept, 'application/vnd.github.sha');
  assert.match(transport.calls[0].headers['user-agent'], /^Nebulaverse-X/);
  assert.strictEqual(transport.calls[0].maxResponseBytes, 1024,
    'resolving a branch must not download a commit diff');

  /* A ref is a ref shape, not free text: nothing here interpolates a caller's
     string into a path without saying what it will accept. */
  for (const ref of ['', '..', 'refs/heads/../../x', 'a b', 'a\nb', '-leading-dash', 'a'.repeat(300), 'refs/heads/']) {
    await assert.rejects(
      resolveCommit({ scope, ref, token: TOKEN, transport }),
      error => error.code === 'EXPOSURE_REF_INVALID',
      JSON.stringify(ref)
    );
  }
  for (const ref of ['main', 'refs/heads/main', 'release/2026-09', 'v1.2.3', COMMIT]) {
    const ok = transportReturning({ statusCode: 200, body: COMMIT });
    assert.strictEqual((await resolveCommit({ scope, ref, token: TOKEN, transport: ok })).commitSha, COMMIT);
  }

  /* An answer that is not a commit is an error, not a guess. */
  for (const body of ['{}', '{"sha":"nothex"}', `{"sha":"${COMMIT.slice(0, 7)}"}`, 'not json', '[]']) {
    await assert.rejects(
      resolveCommit({ scope, ref: 'main', token: TOKEN, transport: transportReturning({ statusCode: 200, body }) }),
      error => error.code === 'EXPOSURE_REF_UNRESOLVED',
      body
    );
  }
  await assert.rejects(
    resolveCommit({ scope, ref: 'main', token: TOKEN, transport: transportReturning({ statusCode: 404, body: '{}' }) }),
    error => error.code === 'EXPOSURE_REF_UNRESOLVED'
  );
  await assert.rejects(
    resolveCommit({ scope, ref: 'main', token: TOKEN, transport: transportReturning({ statusCode: 401, body: '{}' }) }),
    error => error.code === 'EXPOSURE_AUTHORIZATION_REVOKED'
  );
  for (const statusCode of [403, 429, 500, 503]) {
    await assert.rejects(
      resolveCommit({ scope, ref: 'main', token: TOKEN, transport: transportReturning({ statusCode, body: '{}' }) }),
      error => error.status === 502 && error.code === 'EXPOSURE_READ_FAILED',
      'a provider outage or limit is not a missing branch'
    );
  }
}

/* ---- History ------------------------------------------------------------ */

/*
 * History is read the same way as the tree: the provider's API, the guarded
 * transport, the reader's token in a header, and nothing cloned. What comes
 * back is a commit id, a date and a parent count for each commit -- no
 * author, no message -- and for each commit the files it changed, reduced to
 * the lines it added.
 */
{
  const sha = index => index.toString(16).padStart(40, '0');
  const listItem = (index, parents = 1) => ({
    sha: sha(index),
    commit: {
      author: { name: 'Somebody', email: 'somebody@example.com', date: '2026-01-01T00:00:00Z' },
      committer: { date: `2026-02-${String(1 + (index % 27)).padStart(2, '0')}T10:00:00Z` },
      message: 'a message that is never kept'
    },
    parents: Array.from({ length: parents }, (_, n) => ({ sha: sha(900000 + n) }))
  });
  const page = items => ({ statusCode: 200, body: JSON.stringify(items) });

  /* Pages until a short page, newest first, and nothing personal kept. */
  const full = Array.from({ length: COMMIT_PAGE_SIZE }, (_, index) => listItem(index + 1));
  const transport = transportReturning(page(full), page([listItem(101), listItem(102, 2)]));
  const listing = await listCommits({ scope, commitSha: COMMIT, token: TOKEN, transport, maxCommits: 1000 });
  assert.strictEqual(listing.commits.length, 102);
  assert.strictEqual(listing.truncated, false);
  assert.deepStrictEqual(Object.keys(listing.commits[0]).sort(), ['committedAt', 'parents', 'sha']);
  assert.strictEqual(listing.commits[101].parents, 2, 'a merge is recognisable, so it is not scanned twice');
  assert.strictEqual(listing.commits[0].committedAt, '2026-02-02T10:00:00.000Z', 'the committer date, not the author date');
  assert.match(transport.calls[0].url, new RegExp(`/repos/Acme/Demo/commits\\?sha=${COMMIT}&per_page=${COMMIT_PAGE_SIZE}&page=1$`));
  assert.match(transport.calls[1].url, /&page=2$/);
  for (const call of transport.calls) {
    assert.strictEqual(call.profile, PROFILES.PROVIDER_READ);
    assert.strictEqual(call.method, 'GET');
    assert.strictEqual(call.headers.authorization, `Bearer ${TOKEN}`);
  }
  assert(!JSON.stringify(listing).includes('Somebody') && !JSON.stringify(listing).includes('message'));

  /* A ceiling is reported as truncated, never as a short history. */
  const capped = await listCommits({ scope, commitSha: COMMIT, token: TOKEN, transport: transportReturning(page(full)), maxCommits: 10 });
  assert.strictEqual(capped.commits.length, 10);
  assert.strictEqual(capped.truncated, true);

  /* An earlier complete history scan's commit is where reading stops. */
  const incremental = await listCommits({
    scope, commitSha: COMMIT, token: TOKEN, transport: transportReturning(page(full)), stopAt: sha(4)
  });
  assert.deepStrictEqual(incremental.commits.map(item => item.sha), [sha(1), sha(2), sha(3)]);
  assert.strictEqual(incremental.reachedBase, true);

  /* An empty repository has no history rather than an unreadable one. */
  const empty = await listCommits({ scope, commitSha: COMMIT, token: TOKEN, transport: transportReturning({ statusCode: 409, body: '{}' }) });
  assert.deepStrictEqual([...empty.commits], []);

  /* A revoked session and a throttle stop history; other failures are errors, not an empty list. */
  await assert.rejects(listCommits({ scope, commitSha: COMMIT, token: TOKEN, transport: transportReturning({ statusCode: 401, body: '{}' }) }),
    error => error.code === 'EXPOSURE_AUTHORIZATION_REVOKED');
  for (const statusCode of [403, 429]) {
    await assert.rejects(listCommits({ scope, commitSha: COMMIT, token: TOKEN, transport: transportReturning({ statusCode, body: '{}' }) }),
      error => error.code === 'EXPOSURE_RATE_LIMITED');
  }
  await assert.rejects(listCommits({ scope, commitSha: COMMIT, token: TOKEN, transport: transportReturning({ statusCode: 500, body: '{}' }) }),
    error => error.code === 'EXPOSURE_HISTORY_UNAVAILABLE');
  await assert.rejects(listCommits({ scope, commitSha: COMMIT, token: TOKEN, transport: transportReturning({ statusCode: 200, body: '{}' }) }),
    error => error.code === 'EXPOSURE_HISTORY_INVALID');
  await assert.rejects(listCommits({ scope, commitSha: 'main', token: TOKEN, transport: transportReturning(page([])) }),
    error => error.code === 'EXPOSURE_COMMIT_INVALID', 'history is read from a commit, never a ref');
}

{
  /* The new side of each hunk, with line numbers and which lines were added. */
  const hunks = parsePatch([
    '@@ -1,3 +1,4 @@',
    ' keep',
    '-old',
    '+new one',
    '+new two\r',
    ' tail',
    '\\ No newline at end of file',
    '@@ -40,2 +41,1 @@',
    ' context only',
    '-removed'
  ].join('\n'));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(hunks)), [{ lines: [
    { line: 1, text: 'keep', added: false },
    { line: 2, text: 'new one', added: true },
    { line: 3, text: 'new two', added: true },
    { line: 4, text: 'tail', added: false }
  ] }], 'a hunk that adds nothing is dropped; a carriage return is not part of the line');
  assert.deepStrictEqual([...parsePatch(null)], []);
  assert.deepStrictEqual([...parsePatch('+no header first')], []);
}

{
  const COMMIT_B = 'b'.repeat(40);
  const detail = (files, extra = {}) => ({ statusCode: 200, body: JSON.stringify({
    sha: COMMIT_B, commit: { committer: { date: '2026-03-04T05:06:07Z' } }, parents: [{ sha: COMMIT }], files, ...extra
  }) });
  const file = (filename, overrides = {}) => ({
    filename, status: 'modified', sha: 'e'.repeat(40), patch: '@@ -1 +1 @@\n-a\n+b', ...overrides
  });

  const transport = transportReturning(detail([
    file('src/app.js'),
    file('gone.txt', { status: 'removed' }),
    file('../escape.txt'),
    file('assets/logo.png', { patch: undefined }),
    file('big.json', { patch: undefined, sha: null })
  ]));
  const changes = await readCommitChanges({ scope, sha: COMMIT_B, token: TOKEN, transport });
  assert.strictEqual(changes.skip, null);
  assert.strictEqual(changes.committedAt, '2026-03-04T05:06:07.000Z');
  assert.strictEqual(changes.parents, 1);
  assert.deepStrictEqual(changes.files.map(item => item.path), ['src/app.js', 'assets/logo.png', 'big.json'],
    'a removed file has nothing new in it and an unsafe path is not described');
  assert.strictEqual(changes.unsafePaths, 1);
  assert.strictEqual(changes.files[0].hunks.length, 1);
  assert.strictEqual(changes.files[1].hunks, null, 'no patch is reported as no patch, not as no changes');
  assert.strictEqual(changes.files[1].blobSha, 'e'.repeat(40));
  assert.strictEqual(changes.files[2].blobSha, null);
  assert.match(transport.calls[0].url, new RegExp(`/commits/${COMMIT_B}\\?per_page=${COMMIT_FILES_PAGE_SIZE}&page=1$`));

  /* A commit with more files than a page is read page by page. */
  const many = Array.from({ length: COMMIT_FILES_PAGE_SIZE }, (_, index) => file(`f${index}.js`));
  const paged = transportReturning(detail(many), detail([file('last.js')]));
  const long = await readCommitChanges({ scope, sha: COMMIT_B, token: TOKEN, transport: paged });
  assert.strictEqual(long.files.length, COMMIT_FILES_PAGE_SIZE + 1);
  assert.strictEqual(paged.calls.length, 2);

  /* One unreadable commit is one commit not read, not a failed scan. */
  for (const answer of [{ statusCode: 404, body: '{}' }, { statusCode: 200, body: 'not json' }, new Error('too large')]) {
    const unreadable = await readCommitChanges({ scope, sha: COMMIT_B, token: TOKEN, transport: transportReturning(answer) });
    assert.strictEqual(unreadable.skip, SKIP_REASONS.UNREADABLE);
  }
  /* A revoked session and a throttle are not. */
  await assert.rejects(readCommitChanges({ scope, sha: COMMIT_B, token: TOKEN, transport: transportReturning({ statusCode: 401, body: '{}' }) }),
    error => error.code === 'EXPOSURE_AUTHORIZATION_REVOKED');
  await assert.rejects(readCommitChanges({ scope, sha: COMMIT_B, token: TOKEN, transport: transportReturning({ statusCode: 403, body: '{}' }) }),
    error => error.code === 'EXPOSURE_RATE_LIMITED');
  /* And the token never comes back in what is returned. */
  assert(!JSON.stringify(changes).includes(TOKEN));
}

{
  /*
   * UTF-16 text used to be refused as binary for its NULs and so was never
   * scanned. With a byte-order mark either way round, or as little-endian
   * ASCII without one, it is read as the text it is.
   */
  const plain = 'GITHUB_TOKEN=value\r\nsecond=line\r\n';
  const little = Buffer.from(plain, 'utf16le');
  const big = Buffer.from(plain, 'utf16le'); big.swap16();
  const blob = bytes => ({ statusCode: 200, body: JSON.stringify({ encoding: 'base64', content: bytes.toString('base64') }) });
  for (const bytes of [Buffer.concat([Buffer.from([0xff, 0xfe]), little]), Buffer.concat([Buffer.from([0xfe, 0xff]), big]), little]) {
    const read = await readBlob({ scope, sha: 'e'.repeat(40), token: TOKEN, transport: transportReturning(blob(bytes)) });
    assert.strictEqual(read.skip, null);
    assert.strictEqual(read.text, plain);
  }
  /* A binary file with NULs is still binary. */
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const refused = await readBlob({ scope, sha: 'e'.repeat(40), token: TOKEN, transport: transportReturning(blob(png)) });
  assert.strictEqual(refused.skip, SKIP_REASONS.BINARY);
}

  console.log('exposure reader tests passed');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
