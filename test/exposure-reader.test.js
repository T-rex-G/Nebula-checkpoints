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
  classifyTreeEntry,
  readBlob,
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
      ['a malformed sha', blobEntry('a.js', { sha: 'nothex' }), SKIP_REASONS.UNREADABLE]
    ];
    for (const [label, entry, expected] of cases) {
      assert.strictEqual(classifyTreeEntry(entry).skip, expected, label);
    }
    assert(cases.length >= 22, 'the entry table must stay exhaustive');

    /* A path that merely looks alarming is still a path. */
    for (const safe of ['a/gitignore', 'dot.git.js', 'a/..b/c.js', 'a/b..c', 'src/.env.example']) {
      assert.strictEqual(classifyTreeEntry(blobEntry(safe)).skip, null, safe);
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
    statusCode: 200, body: JSON.stringify({ sha: COMMIT, commit: { message: 'x' } })
  });
  const resolved = await resolveCommit({ scope, ref: 'refs/heads/main', token: TOKEN, transport });
  assert.strictEqual(resolved.commitSha, COMMIT);
  assert.strictEqual(
    transport.calls[0].url,
    'https://api.github.com/repos/Acme/Demo/commits/refs%2Fheads%2Fmain'
  );
  assert.strictEqual(transport.calls[0].profile, PROFILES.PROVIDER_READ);

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
    const ok = transportReturning({ statusCode: 200, body: JSON.stringify({ sha: COMMIT }) });
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
}

  console.log('exposure reader tests passed');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
