'use strict';

/*
 * Reading inside archives without unpacking them anywhere.
 *
 * Every archive here is built in memory from real bytes -- a zip with its
 * central directory, a tar with its 512-byte headers, gzip from zlib -- so the
 * parser is tested against the formats rather than against a mock of them.
 * The hostile cases are the point: a zip bomb that declares small sizes, a
 * member named to climb out of the archive, an archive inside an archive, an
 * encrypted member, and more members than a ceiling allows.
 */

const assert = require('assert');
const crypto = require('crypto');
const zlib = require('zlib');

const {
  MAX_ARCHIVE_MEMBERS,
  MAX_EXPANDED_BYTES,
  MAX_MEMBER_BYTES,
  archiveKind,
  openArchive,
  safeMemberPath
} = require('../src/exposure-archives');
const {
  BINARY_EXTENSIONS,
  readArchive,
  readFileAtCommit,
  textFromBytes
} = require('../src/exposure-reader');
const { detectInText } = require('../src/exposure-detection');

/* Built from parts: this file is scanned by the gate it is testing. */
const TOKEN = ['gh', 'p_', 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5b'].join('');

function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data || '', 'utf8');
    const stored = entry.method === 0;
    const data = stored ? raw : zlib.deflateRawSync(raw);
    const size = entry.declaredSize == null ? raw.length : entry.declaredSize;
    const flags = entry.encrypted ? 1 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function tarHeader(name, size, type = '0') {
  const header = Buffer.alloc(512);
  header.write(name.slice(0, 100), 0, 'utf8');
  header.write('0000644\0', 100);
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  header.write(type, 156);
  header.write('ustar\0', 257);
  return header;
}

function tar(entries) {
  const blocks = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.data || '', 'utf8');
    if (entry.longName) {
      const long = Buffer.from(`${entry.longName}\0`, 'utf8');
      blocks.push(tarHeader('././@LongLink', long.length, 'L'), long, Buffer.alloc((512 - (long.length % 512)) % 512));
    }
    blocks.push(tarHeader(entry.name, data.length, entry.type || '0'), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

function open(bytes, kind, archivePath) {
  return openArchive({
    bytes, kind, path: archivePath, decodeText: textFromBytes,
    binaryExtensions: BINARY_EXTENSIONS, pathRuleExtensions: ['jks', 'p12', 'kdbx']
  });
}

(async () => {
  /* ---- What is an archive -------------------------------------------------- */
  {
    assert.strictEqual(archiveKind('a/b.zip'), 'zip');
    assert.strictEqual(archiveKind('app.JAR'), 'zip');
    assert.strictEqual(archiveKind('report.xlsx'), 'zip');
    assert.strictEqual(archiveKind('r.tar.gz'), 'tgz');
    assert.strictEqual(archiveKind('r.tgz'), 'tgz');
    assert.strictEqual(archiveKind('r.tar'), 'tar');
    assert.strictEqual(archiveKind('dump.sql.gz'), 'gz');
    assert.strictEqual(archiveKind('notes.txt'), null);
    for (const unsafe of ['../x', '/etc/passwd', 'a\\b', 'C:/x', 'a//b', 'a/./b', 'a\nb', '']) {
      assert.strictEqual(safeMemberPath(unsafe), false, unsafe);
    }
    assert.strictEqual(safeMemberPath('config/.env'), true);
  }

  /* ---- A zip: text members read, everything else counted ----------------- */
  {
    const bytes = zip([
      { name: 'config/', data: '' },
      { name: 'config/.env', data: `GITHUB_TOKEN=${TOKEN}\n` },
      { name: 'README.md', data: 'nothing here', method: 0 },
      { name: 'img/logo.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]) },
      { name: 'inner/other.zip', data: 'PK' },
      { name: '../../escape.txt', data: TOKEN },
      { name: 'locked.txt', data: 'x', encrypted: true },
      { name: 'keys/release.jks', data: Buffer.from([0xfe, 0xed, 0xfe, 0xed, 1, 2, 3]) },
      { name: 'bin/data.bin', data: Buffer.from([1, 0, 2, 0, 0, 0, 0, 3]) }
    ]);
    const opened = open(bytes, 'zip', 'dist/app.zip');
    assert.deepStrictEqual(opened.members.map(member => member.path), ['dist/app.zip!/config/.env', 'dist/app.zip!/README.md']);
    const found = detectInText({ text: opened.members[0].text });
    assert.strictEqual(found.candidates[0].rule, 'github-token', 'a credential inside an archive is found');
    assert.deepStrictEqual({ ...opened.skipped }, {
      binary: 2, 'nested-archive': 1, 'unsafe-path': 1, encrypted: 1
    }, 'an image, a nested archive, a climbing name and an encrypted member are each counted and none is read');
    assert.strictEqual(opened.examined, 8, 'a directory is not a member');
    assert.deepStrictEqual(opened.named.map(item => item.path), ['dist/app.zip!/keys/release.jks'],
      'a keystore inside an archive is found by its name');
    assert.match(opened.named[0].sha, /^[0-9a-f]{64}$/);
    assert(!JSON.stringify(opened.skipped).includes(TOKEN), 'a member that was not read leaves nothing behind');
  }

  /* ---- Zip bombs ----------------------------------------------------------- */
  {
    /* Declares a few bytes and inflates to many megabytes. The inflate is
       capped by its output, so this costs one member's ceiling, not the bomb. */
    const zeros = Buffer.alloc(MAX_MEMBER_BYTES * 8);
    const liar = zip([{ name: 'bomb.txt', data: zeros, declaredSize: 10 }]);
    assert(liar.length < 64 * 1024, 'the bomb itself is small');
    const memoryBefore = process.memoryUsage().arrayBuffers;
    const opened = open(liar, 'zip', 'bomb.zip');
    assert.deepStrictEqual(opened.members, []);
    assert.strictEqual(opened.skipped.oversize, 1);
    assert(process.memoryUsage().arrayBuffers - memoryBefore < MAX_MEMBER_BYTES * 4, 'inflating stopped at the ceiling');

    /* An honest declaration past the ceiling is refused before inflating. */
    const honest = zip([{ name: 'big.txt', data: Buffer.alloc(MAX_MEMBER_BYTES + 10, 0x61) }]);
    assert.strictEqual(open(honest, 'zip', 'big.zip').skipped.oversize, 1);

    /* Many members each under the ceiling, together past the expansion cap. */
    const each = Buffer.alloc(MAX_MEMBER_BYTES - 1, 0x61);
    const many = zip(Array.from({ length: Math.ceil(MAX_EXPANDED_BYTES / each.length) + 3 }, (_, index) => ({ name: `f${index}.txt`, data: each })));
    const capped = open(many, 'zip', 'many.zip');
    assert(capped.members.reduce((sum, member) => sum + member.text.length, 0) <= MAX_EXPANDED_BYTES);
    assert(capped.skipped.oversize >= 3);

    /* More members than the ceiling: read to the ceiling and say so. */
    const crowd = zip(Array.from({ length: MAX_ARCHIVE_MEMBERS + 5 }, (_, index) => ({ name: `n${index}.txt`, data: 'x', method: 0 })));
    const crowded = open(crowd, 'zip', 'crowd.zip');
    assert.strictEqual(crowded.examined, MAX_ARCHIVE_MEMBERS);
    assert.strictEqual(crowded.truncated, true);

    /* Not a zip at all is not an empty zip. */
    assert.strictEqual(open(Buffer.from('this is not an archive at all, just text'), 'zip', 'fake.zip'), null);
  }

  /* ---- tar, tgz and gz ----------------------------------------------------- */
  {
    const longPath = `very/${'deep/'.repeat(30)}settings.env`;
    const archive = tar([
      { name: 'app/', type: '5' },
      { name: 'app/.env', data: `TOKEN=${TOKEN}\n` },
      { name: 'ignored', longName: longPath, data: 'KEY=value\n' },
      { name: 'pax', type: 'x', data: '30 path=override/should/not/apply\n' },
      { name: 'link', type: '2', data: '' },
      { name: '../up.txt', data: 'climb' }
    ]);
    const opened = open(archive, 'tar', 'backup.tar');
    assert.deepStrictEqual(opened.members.map(member => member.path), ['backup.tar!/app/.env', `backup.tar!/${longPath}`],
      'a long name is followed; a directory, a pax header and a link are not content');
    assert.strictEqual(opened.skipped['unsafe-path'], 1);

    const tgz = open(zlib.gzipSync(archive), 'tgz', 'backup.tgz');
    assert.deepStrictEqual(tgz.members.map(member => member.path), ['backup.tgz!/app/.env', `backup.tgz!/${longPath}`]);

    const single = open(zlib.gzipSync(Buffer.from(`db_password=${TOKEN}\n`)), 'gz', 'dump/config.env.gz');
    assert.deepStrictEqual(single.members.map(member => member.path), ['dump/config.env.gz!/config.env']);

    /* A gzip bomb: tiny, expanding past the whole archive's ceiling. */
    const bomb = zlib.gzipSync(Buffer.alloc(MAX_EXPANDED_BYTES + 1024));
    assert(bomb.length < 64 * 1024);
    assert.strictEqual(open(bomb, 'tgz', 'bomb.tgz').oversize, true);
    assert.strictEqual(open(bomb, 'gz', 'bomb.gz').oversize, true);
    assert.strictEqual(open(Buffer.from('not gzip'), 'tgz', 'x.tgz'), null);
  }

  /* ---- Through the reader, and read back for a finding --------------------- */
  {
    const scope = { provider: 'github', authority: 'github.com', owner: 'acme', repo: 'demo' };
    const token = ['gh', 'o_', 'Z'.repeat(36)].join('');
    const bytes = zip([{ name: 'config/.env', data: `GITHUB_TOKEN=${TOKEN}\n` }]);
    const sha = crypto.createHash('sha1').update(bytes).digest('hex');
    const calls = [];
    const transport = async request => {
      calls.push(request.url);
      if (request.url.includes('/git/trees/')) {
        return { statusCode: 200, body: JSON.stringify({ tree: [{ path: 'dist/app.zip', mode: '100644', type: 'blob', sha, size: bytes.length }] }) };
      }
      return { statusCode: 200, body: JSON.stringify({ encoding: 'base64', content: bytes.toString('base64') }) };
    };
    const read = await readArchive({ scope, sha, path: 'dist/app.zip', token, transport });
    assert.strictEqual(read.skip, null);
    assert.deepStrictEqual(read.members.map(member => member.path), ['dist/app.zip!/config/.env']);

    const back = await readFileAtCommit({ scope, commitSha: 'c'.repeat(40), path: 'dist/app.zip!/config/.env', token, transport });
    assert.strictEqual(back.text, `GITHUB_TOKEN=${TOKEN}\n`, 'a finding inside an archive can be read back');
    const missing = await readFileAtCommit({ scope, commitSha: 'c'.repeat(40), path: 'dist/app.zip!/nope.env', token, transport });
    assert.strictEqual(missing.text, null);

    /* An archive past its ceiling is not fetched into memory whole. */
    const refused = await readArchive({ scope, sha, path: 'dist/app.zip', token, transport: async () => { throw Object.assign(new Error('too large'), { code: 'GUARDED_FETCH_RESPONSE_TOO_LARGE' }); } });
    assert.strictEqual(refused.skip, 'oversize');
  }

  console.log('exposure archive tests passed');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
