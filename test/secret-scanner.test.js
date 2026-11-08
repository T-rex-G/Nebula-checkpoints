'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  MAX_DIRECTORY_DEPTH,
  discoverReleasableTextFiles,
  scanFiles
} = require('../apps/api/src/platform/release/secret-scanner.ts');

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nvx-secret-scanner-'));
try {
  const secrets = {
    privateKey: `-----BEGIN ${'PRIVATE'} KEY-----`,
    github: `gh${'p'}_${'A'.repeat(36)}`,
    gitlabPat: `gl${'pat'}-${'B'.repeat(24)}`,
    gitlabOauth: `gl${'oas'}-${'C'.repeat(24)}`,
    aws: `AK${'IA'}${'D'.repeat(16)}`,
    slack: `xo${'xb'}-${'E'.repeat(24)}`,
    authenticatedUrl: ['https://', 'fixture:', 'F'.repeat(24), '@example.invalid/repository'].join(''),
    gitea: `${'G'.repeat(40)}`,
    npm: `${'a1'.repeat(18)}`,
    neon: `${'H'.repeat(40)}`,
    oauth: `${'I'.repeat(40)}`,
    session: `${'J'.repeat(40)}`,
    githubClient: `${'K'.repeat(40)}`,
    githubPrivateKey: `${'L'.repeat(80)}`,
    githubWebhook: `${'M'.repeat(40)}`,
    snapshotSigning: `${'N'.repeat(40)}`,
    snapshotRetired: `${'O'.repeat(40)}`,
    snapshotLegacy: `${'P'.repeat(40)}`
  };
  const snapshotRetiredName = ['NV', 'SNAPSHOT', 'RETIRED', 'KEYS', 'JSON'].join('_');
  const snapshotLegacyName = ['NV', 'SNAPSHOT', 'LEGACY', 'KEYS', 'JSON'].join('_');
  const files = {
    README: secrets.github,
    'private-key.md': secrets.privateKey,
    'gitlab-pat.md': secrets.gitlabPat,
    'gitlab-oauth.md': secrets.gitlabOauth,
    'cloud.txt': `${secrets.aws}\n${secrets.slack}\n${secrets.authenticatedUrl}\n`,
    'gitea.conf': `GITEA_TOKEN=${secrets.gitea}`,
    'npm.conf': `NPM_TOKEN=${secrets.npm}`,
    'neon.conf': `NEON_API_KEY=${secrets.neon}`,
    'oauth.conf': `OAUTH_CLIENT_SECRET=${secrets.oauth}`,
    'session.conf': `SESSION_SECRET=${secrets.session}`,
    'github-client.conf': `GITHUB_APP_CLIENT_SECRET=${secrets.githubClient}`,
    'github-private-key.conf': `GITHUB_APP_PRIVATE_KEY_BASE64=${secrets.githubPrivateKey}`,
    'github-webhook.conf': `GITHUB_APP_WEBHOOK_SECRET=${secrets.githubWebhook}`,
    'snapshot-signing.conf': `NV_SNAPSHOT_SIGNING_SECRET=${secrets.snapshotSigning}`,
    'snapshot-retired.conf': `${snapshotRetiredName}={"retired-key":"${secrets.snapshotRetired}"}`,
    'snapshot-legacy.conf': `${snapshotLegacyName}=["${secrets.snapshotLegacy}"]`,
    'harmless.js': [
      'const GITEA_TOKEN = process.env.GITEA_TOKEN;',
      'const NPM_TOKEN = process.env.NPM_TOKEN;',
      'const SESSION_SECRET = process.env.SESSION_SECRET;',
      'const GITHUB_APP_CLIENT_SECRET = ${GITHUB_APP_CLIENT_SECRET};',
      'const NV_SNAPSHOT_SIGNING_SECRET = process.env.NV_SNAPSHOT_SIGNING_SECRET;',
      'const NV_SNAPSHOT_RETIRED_KEYS_JSON = JSON.stringify(retiredKeys);',
      'const url = "https://example.invalid/repository";'
    ].join('\n')
  };
  for (const [relative, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(temporaryRoot, relative), `${content}\n`);
  }
  fs.writeFileSync(
    path.join(temporaryRoot, 'binary.data'),
    Buffer.concat([Buffer.from([0, 1, 2, 3]), Buffer.from(secrets.github)])
  );
  fs.symlinkSync(path.join(temporaryRoot, 'README'), path.join(temporaryRoot, 'linked-secret'));

  const findings = scanFiles({
    root: temporaryRoot,
    files: [...Object.keys(files), 'binary.data', 'linked-secret']
  });
  const rules = findings.map(item => item.rule).sort();
  assert.deepStrictEqual(rules, [
    'authenticated-url',
    'aws-access-key',
    'contextual-provider-secret',
    'contextual-provider-secret',
    'contextual-provider-secret',
    'contextual-provider-secret',
    'contextual-provider-secret',
    'contextual-provider-secret',
    'contextual-provider-secret',
    'contextual-provider-secret',
    'contextual-provider-secret',
    'contextual-provider-secret',
    'contextual-provider-secret',
    'github-token',
    'gitlab-token',
    'gitlab-token',
    'private-key',
    'slack-token',
    'undecodable-text'
  ].sort());
  assert.deepStrictEqual(findings.filter(item => item.path === 'binary.data').map(item => [item.rule, item.line]), [['undecodable-text', 1]],
    'a file that is not of a binary type and does not read as text is refused, not passed unread');
  assert(!findings.some(item => item.path === 'linked-secret'));
  assert(!findings.some(item => item.path === 'harmless.js'));
  assert(findings.every(item => Number.isInteger(item.line) && item.line >= 1),
    'findings must identify a safe 1-based source line');
  assert.deepStrictEqual(
    findings.filter(item => item.path === 'cloud.txt').map(item => [item.rule, item.line]),
    [['aws-access-key', 1], ['slack-token', 2], ['authenticated-url', 3]],
    'line reporting must identify each rule without echoing its matched value'
  );
  const serializedFindings = JSON.stringify(findings);
  for (const value of Object.values(secrets)) {
    assert(!serializedFindings.includes(value), 'findings must never echo the matched secret');
  }

  const archiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nvx-secret-archive-'));
  try {
    fs.mkdirSync(path.join(archiveRoot, 'src'));
    fs.mkdirSync(path.join(archiveRoot, 'node_modules', 'ignored'), { recursive: true });
    fs.mkdirSync(path.join(archiveRoot, 'build'), { recursive: true });
    fs.mkdirSync(path.join(archiveRoot, '.git'), { recursive: true });
    fs.writeFileSync(path.join(archiveRoot, 'README.md'), 'archive\n');
    fs.writeFileSync(path.join(archiveRoot, 'src', 'index.js'), "'use strict';\n");
    fs.writeFileSync(path.join(archiveRoot, '._metadata'), 'ignored\n');
    fs.writeFileSync(path.join(archiveRoot, 'node_modules', 'ignored', 'secret.txt'), secrets.github);
    fs.writeFileSync(path.join(archiveRoot, 'build', 'secret.txt'), secrets.github);
    fs.writeFileSync(path.join(archiveRoot, '.git', 'secret.txt'), secrets.github);
    assert.deepStrictEqual(
      discoverReleasableTextFiles(archiveRoot),
      ['README.md', 'src/index.js'],
      'non-Git release archives must use the bounded walk and exclude dependency/build metadata'
    );
  } finally {
    fs.rmSync(archiveRoot, { recursive: true, force: true });
  }

  const deeplyNestedArchive = fs.mkdtempSync(path.join(os.tmpdir(), 'nvx-secret-depth-'));
  try {
    let directory = deeplyNestedArchive;
    for (let depth = 0; depth <= MAX_DIRECTORY_DEPTH; depth += 1) {
      directory = path.join(directory, `d${depth}`);
      fs.mkdirSync(directory);
    }
    assert.throws(
      () => discoverReleasableTextFiles(deeplyNestedArchive),
      /directory nesting exceeds the safe limit/i
    );
  } finally {
    fs.rmSync(deeplyNestedArchive, { recursive: true, force: true });
  }

  execFileSync('git', ['init'], { cwd: temporaryRoot, stdio: 'ignore' });
  execFileSync('git', ['add', 'README', 'harmless.js'], { cwd: temporaryRoot, stdio: 'ignore' });
  const discovered = discoverReleasableTextFiles(temporaryRoot);
  assert.deepStrictEqual(discovered, ['README', 'harmless.js']);
  assert(!discovered.includes('private-key.md'), 'untracked files are not part of a Git release manifest');
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

/*
 * A secret does not stop being a secret because it is serialized on its way
 * out. `SESSION_SECRET: JSON.stringify('...')` embeds the literal exactly as
 * plainly as an assignment does, and an archive carrying one must not qualify.
 *
 * The distinction the scanner has to keep is between a serialized *literal* and
 * a serialized *reference*: stringifying process.env or a variable exposes
 * nothing and is ordinary code, so those must stay quiet or the gate becomes
 * noise an operator learns to ignore.
 */
const serializedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nvx-secret-serialized-'));
try {
  const literal = 'z'.repeat(24);
  const cases = {
    'stringify-single.js': `SESSION_SECRET: JSON.stringify('${literal}')`,
    'stringify-double.js': `GITEA_TOKEN: JSON.stringify("${literal}")`,
    'stringify-spaced.js': `NPM_TOKEN: JSON.stringify( '${literal}' )`,
    'stringify-assign.js': `SESSION_SECRET = JSON.stringify('${literal}')`,
    'stringify-env.js': 'SESSION_SECRET: JSON.stringify(process.env.SESSION_SECRET)',
    'stringify-variable.js': 'SESSION_SECRET: JSON.stringify(retiredKeys)',
    'stringify-template.js': 'SESSION_SECRET: JSON.stringify(`${SESSION_SECRET}`)'
  };
  for (const [relative, content] of Object.entries(cases)) {
    fs.writeFileSync(path.join(serializedRoot, relative), `${content}\n`);
  }
  const flagged = new Set(
    scanFiles({ root: serializedRoot, files: Object.keys(cases) }).map(item => item.path)
  );
  for (const relative of ['stringify-single.js', 'stringify-double.js', 'stringify-spaced.js', 'stringify-assign.js']) {
    assert(flagged.has(relative), `a secret serialized through JSON.stringify must be flagged: ${relative}`);
  }
  for (const relative of ['stringify-env.js', 'stringify-variable.js', 'stringify-template.js']) {
    assert(!flagged.has(relative), `serializing a reference exposes nothing and must stay quiet: ${relative}`);
  }
} finally {
  fs.rmSync(serializedRoot, { recursive: true, force: true });
}

/*
 * Compatibility with the exposure scanner, which reads the same rules.
 *
 * The two answer different questions -- the gate asks whether a secret exists
 * and stops, the scanner enumerates every one -- and they must never disagree
 * about existence. If the gate flags a file and the scanner finds nothing in
 * it, one of them is broken and only this comparison would say which. So: for
 * every finding the gate reports, the scanner must report a candidate of the
 * same rule whose first location is the same line, and the scanner must never
 * be quiet about a file the gate flagged.
 */
{
  const { detectInText } = require('../apps/api/src/modules/quasar/index.ts');
  const compatibilityRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nvx-scanner-compat-'));
  try {
    /* Its own fixtures: the set above is scoped to the block that built it,
       and split prefixes keep this file out of its own findings. */
    const shared = {
      github: `gh${'p'}_${'Q'.repeat(36)}`,
      slack: `xo${'xb'}-${'R'.repeat(24)}`,
      gitlabPat: `gl${'pat'}-${'S'.repeat(24)}`,
      aws: `AK${'IA'}${'T'.repeat(16)}`,
      authenticatedUrl: ['https://', 'fixture:', 'U'.repeat(24), '@example.invalid/repository'].join('')
    };
    const sample = {
      'multi.txt': [`one=${shared.github}`, `two=${shared.slack}`, `three=${shared.github}`].join('\n'),
      'crlf.txt': [`a=${shared.gitlabPat}`, `b=${shared.aws}`].join('\r\n'),
      'single.txt': shared.authenticatedUrl,
      'quiet.js': 'const token = process.env.GITEA_TOKEN;'
    };
    for (const [relative, content] of Object.entries(sample)) {
      fs.writeFileSync(path.join(compatibilityRoot, relative), `${content}\n`);
    }
    const gateFindings = scanFiles({ root: compatibilityRoot, files: Object.keys(sample) });
    assert(gateFindings.length >= 5, 'the comparison needs findings to compare');

    for (const finding of gateFindings) {
      const text = fs.readFileSync(path.join(compatibilityRoot, finding.path), 'utf8');
      const detection = detectInText({ text, path: finding.path });
      const matching = detection.candidates.filter(candidate => candidate.rule === finding.rule);
      assert(
        matching.length > 0,
        `the exposure scanner is silent about a file the gate flagged: ${finding.path} ${finding.rule}`
      );
      assert.strictEqual(
        Math.min(...matching.map(candidate => candidate.occurrences[0].line)), finding.line,
        `the two disagree about where ${finding.rule} first appears in ${finding.path}`
      );
    }

    /* And the file the gate leaves alone stays quiet in both. */
    assert.strictEqual(
      detectInText({ text: fs.readFileSync(path.join(compatibilityRoot, 'quiet.js'), 'utf8'), path: 'quiet.js' })
        .candidates.length,
      0
    );

    /* The gate reports one github token in multi.txt; the scanner reports the
       file truthfully. That difference is the reason the scanner exists. */
    const multi = detectInText({
      text: fs.readFileSync(path.join(compatibilityRoot, 'multi.txt'), 'utf8'), path: 'multi.txt'
    });
    assert.strictEqual(
      gateFindings.filter(item => item.path === 'multi.txt' && item.rule === 'github-token').length, 1
    );
    assert.strictEqual(
      multi.candidates.filter(item => item.rule === 'github-token')[0].occurrenceCount, 2,
      'the same credential twice is one candidate seen twice'
    );
  } finally {
    fs.rmSync(compatibilityRoot, { recursive: true, force: true });
  }
}

/*
 * What a reader cannot see. Every character a review would miss is refused
 * wherever the release carries text, at the line it is on: control
 * characters but tab and the line ends, format characters -- bidirectional
 * controls, zero-width characters, a byte-order mark, tags -- and the line
 * and paragraph separators. A file that should be text and does not decode
 * is refused at the line of its first bad byte; a file of a binary type is
 * not read as text, and its bytes are still searched for credentials.
 */
{
  const hiddenRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nvx-secret-hidden-'));
  try {
    const hidden = {
      'control.js': 'const a = 1;\nconst b = "\u0007";\n',
      'delete.ts': 'x\u007f\n',
      'c1.css': 'a {}\nb {}\n\u0085\n',
      'reorder.js': 'if (role !== "admin\u202e") ok();\n',
      'isolate.ts': 'const a = 1;\n// \u2066note\u2069\n',
      'zero-width.md': 'one\ntw\u200bo\n',
      'joiner.js': 'const isAdmin\u200d = true;\n',
      'byte-order.html': '\ufeff<p>page</p>\n',
      'tag.txt': 'plain\nhidden \u{e0041}\u{e0042}\n',
      'separator.js': '// note\u2028run();\n',
      'soft-hyphen.json': '{"name":"pass\u00adword"}\n'
    };
    const lines = { 'control.js': 2, 'delete.ts': 1, 'c1.css': 3, 'reorder.js': 1, 'isolate.ts': 2, 'zero-width.md': 2, 'joiner.js': 1, 'byte-order.html': 1, 'tag.txt': 2, 'separator.js': 1, 'soft-hyphen.json': 1 };
    const quiet = {
      'tabs.js': 'if (a) {\r\n\treturn b;\r\n}\n',
      'escaped.js': "const marks = ['\\u202e', '\\ufeff', '\\u200b'];\n",
      'spaces.md': 'non\u00a0breaking and emoji \u{1f600}\n'
    };
    for (const [relative, content] of Object.entries({ ...hidden, ...quiet })) fs.writeFileSync(path.join(hiddenRoot, relative), content);
    const undecodable = {
      'nul.js': [Buffer.from('a\nb\nc'), Buffer.from([0]), Buffer.from('\n')],
      'stray.ts': [Buffer.from('one\ntwo\n'), Buffer.from([0xc3, 0x28]), Buffer.from('\n')],
      'overlong.css': [Buffer.from('a\n'), Buffer.from([0xc0, 0x80]), Buffer.from('\nb\n')],
      'surrogate.md': [Buffer.from('a\n'), Buffer.from([0xed, 0xa0, 0x80]), Buffer.from('\nb\nc\n')],
      'truncated.txt': [Buffer.from('end\nnear\n'), Buffer.from([0xe2, 0x82])],
      'beyond.json': [Buffer.from('[\n'), Buffer.from([0xf4, 0x90, 0x80, 0x80]), Buffer.from('\n]\n')]
    };
    const badLines = { 'nul.js': 3, 'stray.ts': 3, 'overlong.css': 2, 'surrogate.md': 2, 'truncated.txt': 3, 'beyond.json': 2 };
    for (const [relative, parts] of Object.entries(undecodable)) fs.writeFileSync(path.join(hiddenRoot, relative), Buffer.concat(parts));
    const token = `gh${'p'}_${'V'.repeat(36)}`;
    fs.writeFileSync(path.join(hiddenRoot, 'image.png'), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0x01, 0x1b]), Buffer.from(`tEXt ${token}`), Buffer.from([0, 0xff])]));
    fs.writeFileSync(path.join(hiddenRoot, 'font.WOFF2'), Buffer.from([0x77, 0x4f, 0x46, 0x32, 0, 0x01, 0x02, 0xff, 0xfe, 0x80]));
    fs.writeFileSync(path.join(hiddenRoot, 'image.png.txt'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]));

    const scanned = scanFiles({ root: hiddenRoot, files: fs.readdirSync(hiddenRoot) });
    const found = Object.fromEntries(scanned.map(item => [item.path, [item.rule, item.line]]));
    assert.strictEqual(scanned.length, Object.keys(found).length, 'one finding a file');
    for (const [relative, line] of Object.entries(lines)) assert.deepStrictEqual(found[relative], ['hidden-character', line], relative);
    for (const [relative, line] of Object.entries(badLines)) assert.deepStrictEqual(found[relative], ['undecodable-text', line], relative);
    assert.deepStrictEqual(found['image.png'], ['github-token', 1], "a binary type's bytes are searched for credentials");
    assert.deepStrictEqual(found['image.png.txt'], ['undecodable-text', 1], 'the type is the name\'s last extension');
    for (const relative of [...Object.keys(quiet), 'font.WOFF2']) assert.strictEqual(found[relative], undefined, relative);
    assert(!JSON.stringify(scanned).includes(token), 'a finding never echoes what it found');
  } finally {
    fs.rmSync(hiddenRoot, { recursive: true, force: true });
  }
}

console.log('secret scanner tests passed');
