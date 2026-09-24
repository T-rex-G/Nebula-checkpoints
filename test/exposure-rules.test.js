'use strict';

/*
 * The scan's own detectors, and the three ways a detector goes wrong.
 *
 * It misses a real credential: every rule has a positive fixture shaped like
 * the issuer's real tokens, and each must be found under its own rule and no
 * other.
 *
 * It reports something that is not a credential: documentation placeholders,
 * lockfile hashes, UUIDs, colours, commit ids and ordinary JWTs are run through
 * every rule and must produce nothing. A detector that fires on a lockfile
 * teaches a reader to stop reading the findings.
 *
 * Or it is fast only because it is wrong: the keyword pre-filter that keeps
 * sixty rules as cheap as six is proven to change no answer, by running the
 * whole corpus with it on and off.
 *
 * No fixture is written out as a literal. Each is assembled from pieces and a
 * deterministic generator, so this file never contains a string a secret
 * scanner -- this repository's own gate, or a provider's push protection --
 * would take for a real key.
 */

const assert = require('assert');
const crypto = require('crypto');

const { EXPOSURE_RULES, PATH_RULES, detectInText, detectInPath, createLocator } = require('../src/exposure-detection');
const { plausibleSecret, plausibleConnectionString, shannonEntropy, MIN_ENTROPY_BITS } = require('../src/exposure-rules');

/* ---- A deterministic generator ----------------------------------------- */

const ALPHABETS = Object.freeze({
  hex: '0123456789abcdef',
  upperHex: '0123456789ABCDEF',
  b62: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  lowerAlnum: 'abcdefghijklmnopqrstuvwxyz0123456789',
  upperAlnum: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  url: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-',
  b64: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',
  bech32: 'QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L',
  digits: '0123456789'
});

function random(seed, alphabet, length) {
  const characters = ALPHABETS[alphabet] || alphabet;
  let out = '';
  let counter = 0;
  while (out.length < length) {
    const bytes = crypto.createHash('sha256').update(`${seed}:${counter}`).digest();
    counter += 1;
    for (const byte of bytes) {
      if (out.length >= length) break;
      out += characters[byte % characters.length];
    }
  }
  return out;
}

/*
 * One fixture per rule: `secret` is what the rule must report and `line` is
 * the source text it sits in. Prefixes are split so no line of this file is a
 * token in its own right.
 */
const FIXTURES = Object.freeze({
  'aws-secret-access-key': () => {
    const secret = random('aws', 'b64', 40);
    return { secret, line: `aws_secret_access_key = "${secret}"` };
  },
  'google-api-key': () => ({ secret: `AI${'za'}${random('google', 'url', 35)}` }),
  'google-oauth-client-secret': () => ({ secret: `GOC${'SPX-'}${random('goauth', 'url', 28)}` }),
  'azure-storage-account-key': () => ({
    secret: `DefaultEndpointsProtocol=https;AccountName=acmestore01;Account${'Key='}${random('azure', 'b64', 86)}==`
  }),
  'digitalocean-token': () => ({ secret: `do${'p_v1_'}${random('do', 'hex', 64)}` }),
  'cloudflare-origin-ca-key': () => ({ secret: `v1${'.0-'}${random('cf1', 'hex', 24)}-${random('cf2', 'hex', 146)}` }),
  'hashicorp-vault-token': () => ({ secret: `hv${'s.'}${random('vault', 'url', 90)}` }),
  'terraform-cloud-token': () => ({ secret: `${random('tf1', 'b62', 14)}.atlas${'v1.'}${random('tf2', 'url', 67)}` }),
  'doppler-token': () => ({ secret: `dp${'.pt.'}${random('doppler', 'b62', 43)}` }),
  'pulumi-token': () => ({ secret: `pu${'l-'}${random('pulumi', 'hex', 40)}` }),
  'render-api-key': () => ({ secret: `rn${'d_'}${random('render', 'b62', 32)}` }),
  'neon-api-key': () => ({ secret: `na${'pi_'}${random('neon', 'lowerAlnum', 64)}` }),
  'flyio-token': () => ({ secret: `fo${'1_'}${random('fly', 'url', 43)}` }),
  'netlify-token': () => ({ secret: `nf${'p_'}${random('netlify', 'b62', 36)}` }),
  'planetscale-token': () => ({ secret: `pscale${'_tkn_'}${random('pscale', 'url', 43)}` }),
  'databricks-token': () => ({ secret: `da${'pi'}${random('databricks', 'hex', 32)}` }),
  'npm-token': () => ({ secret: `np${'m_'}${random('npm', 'b62', 36)}` }),
  'pypi-token': () => ({ secret: `py${'pi-AgEIcHlwaS5vcmc'}${random('pypi', 'url', 70)}` }),
  'docker-hub-token': () => ({ secret: `dckr${'_pat_'}${random('docker', 'url', 27)}` }),
  'circleci-token': () => ({ secret: `CCI${'PAT_'}${random('circle1', 'b62', 22)}_${random('circle2', 'hex', 40)}` }),
  'buildkite-token': () => ({ secret: `bk${'ua_'}${random('buildkite', 'hex', 40)}` }),
  'jfrog-token': () => ({ secret: `AK${'Cp'}${random('jfrog', 'b62', 69)}` }),
  'atlassian-api-token': () => ({ secret: `ATA${'TT3'}${random('atlassian', 'url', 186)}` }),
  'linear-api-key': () => ({ secret: `lin${'_api_'}${random('linear', 'b62', 40)}` }),
  'postman-api-key': () => ({ secret: `PM${'AK-'}${random('postman1', 'hex', 24)}-${random('postman2', 'hex', 34)}` }),
  'figma-token': () => ({ secret: `fi${'gd_'}${random('figma', 'url', 40)}` }),
  'sentry-token': () => ({ secret: `sntry${'u_'}${random('sentry', 'hex', 64)}` }),
  'grafana-token': () => ({ secret: `gl${'sa_'}${random('grafana1', 'b62', 32)}_${random('grafana2', 'hex', 8)}` }),
  'new-relic-key': () => ({ secret: `NR${'AK-'}${random('newrelic', 'upperAlnum', 27)}` }),
  'dynatrace-token': () => ({ secret: `dt0${'c01.'}${random('dyna1', 'upperAlnum', 24)}.${random('dyna2', 'upperAlnum', 64)}` }),
  'openai-api-key': () => ({ secret: `sk${'-proj-'}${random('openai1', 'url', 40)}T3Blbk${'FJ'}${random('openai2', 'url', 40)}` }),
  'anthropic-api-key': () => ({ secret: `sk${'-ant-api03-'}${random('anthropic', 'url', 93)}` }),
  'huggingface-token': () => ({ secret: `h${'f_'}${random('hf', 'b62', 34)}` }),
  'replicate-token': () => ({ secret: `r${'8_'}${random('replicate', 'b62', 37)}` }),
  'groq-api-key': () => ({ secret: `gs${'k_'}${random('groq', 'b62', 52)}` }),
  'perplexity-api-key': () => ({ secret: `ppl${'x-'}${random('pplx', 'b62', 48)}` }),
  'stripe-live-key': () => ({ secret: `sk${'_live_'}${random('stripe-live', 'b62', 99)}` }),
  'stripe-test-key': () => ({ secret: `sk${'_test_'}${random('stripe-test', 'b62', 99)}` }),
  'stripe-webhook-secret': () => ({ secret: `wh${'sec_'}${random('whsec', 'b62', 32)}` }),
  'square-token': () => ({ secret: `sq0${'atp-'}${random('square', 'url', 22)}` }),
  'shopify-token': () => ({ secret: `shp${'at_'}${random('shopify', 'hex', 32)}` }),
  'braintree-token': () => ({ secret: `access_token$${'production$'}${random('bt1', 'lowerAlnum', 16)}$${random('bt2', 'hex', 32)}` }),
  'flutterwave-secret-key': () => ({ secret: `FLWSE${'CK-'}${random('flw', 'hex', 32)}-X` }),
  'easypost-api-key': () => ({ secret: `EZ${'AK'}${random('easypost', 'hex', 54)}` }),
  'sendgrid-api-key': () => ({ secret: `S${'G.'}${random('sg1', 'url', 22)}.${random('sg2', 'url', 43)}` }),
  'mailgun-api-key': () => ({ secret: `ke${'y-'}${random('mailgun', 'hex', 32)}` }),
  'mailchimp-api-key': () => ({ secret: `${random('mailchimp', 'hex', 32)}-us${'14'}` }),
  'resend-api-key': () => ({ secret: `r${'e_'}${random('resend1', 'b62', 8)}_${random('resend2', 'b62', 24)}` }),
  'twilio-api-key': () => ({ secret: `S${'K'}${random('twilio', 'hex', 32)}` }),
  'slack-webhook-url': () => ({
    secret: `https://hooks.${'slack.com'}/services/T${random('slack1', 'upperAlnum', 10)}/B${random('slack2', 'upperAlnum', 10)}/${random('slack3', 'b62', 24)}`
  }),
  'discord-webhook-url': () => ({
    secret: `https://discord.com/api/web${'hooks'}/${random('discord1', 'digits', 18)}/${random('discord2', 'url', 68)}`
  }),
  'teams-webhook-url': () => ({
    secret: `https://acme.webhook.office.com/web${'hookb2'}/${random('teams1', 'hex', 32)}@${random('teams2', 'hex', 32)}/IncomingWebhook/${random('teams3', 'hex', 32)}`
  }),
  'telegram-bot-token': () => ({ secret: `${random('tg1', 'digits', 10)}:A${'A'}${random('tg2', 'url', 33)}` }),
  'firebase-cloud-messaging-key': () => ({ secret: `AA${'AA'}${random('fcm1', 'url', 7)}:${random('fcm2', 'url', 140)}` }),
  'twitter-bearer-token': () => ({ secret: `${'A'.repeat(21)}${random('twitter', 'b62', 80)}` }),
  'mapbox-secret-token': () => ({ secret: `s${'k.eyJ'}${random('mapbox1', 'url', 60)}.${random('mapbox2', 'url', 22)}` }),
  'notion-token': () => ({ secret: `nt${'n_'}${random('notion', 'b62', 46)}` }),
  'airtable-token': () => ({ secret: `pa${'t'}${random('airtable1', 'b62', 14)}.${random('airtable2', 'hex', 64)}` }),
  'hubspot-token': () => ({
    secret: `pat${'-na1-'}${random('hs1', 'hex', 8)}-${random('hs2', 'hex', 4)}-${random('hs3', 'hex', 4)}-${random('hs4', 'hex', 4)}-${random('hs5', 'hex', 12)}`
  }),
  'contentful-token': () => ({ secret: `CFP${'AT-'}${random('contentful', 'url', 43)}` }),
  'age-secret-key': () => ({ secret: `AGE-SECRET${'-KEY-1'}${random('age', 'bech32', 58)}` }),
  'pgp-private-key': () => ({ secret: `-----BEGIN PGP ${'PRIVATE KEY BLOCK'}-----` }),
  'dsa-private-key': () => ({ secret: `-----BEGIN DSA ${'PRIVATE KEY'}-----` }),
  'encrypted-private-key': () => ({ secret: `-----BEGIN ENCRYPTED ${'PRIVATE KEY'}-----` }),
  'putty-private-key': () => ({ secret: `PuTTY-User-Key${'-File-3'}: ssh-ed25519` }),
  'database-url-password': () => {
    /* The host ends the match: the database name is not part of the
       credential, so the same password to two databases is one finding. */
    const secret = `mongodb+srv://${'app'}:${random('db', 'b62', 20)}@cluster0.abcde.mongodb.net`;
    return { secret, line: `MONGO_URI="${secret}/prod?retryWrites=true"` };
  }
});

/* A Supabase key is a JWT, built rather than written. */
function jwt(claims) {
  const part = value => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${part({ alg: 'HS256', typ: 'JWT' })}.${part(claims)}.${random(JSON.stringify(claims), 'url', 43)}`;
}
const SUPABASE_FIXTURES = Object.freeze({
  'supabase-anon-key': () => ({ secret: jwt({ iss: 'supabase', ref: 'a'.repeat(20), role: 'anon', iat: 1, exp: 2 }) }),
  'supabase-service-role-key': () => ({ secret: jwt({ iss: 'supabase', ref: 'a'.repeat(20), role: 'service_role', iat: 1, exp: 2 }) })
});

const ALL_FIXTURES = Object.freeze({ ...SUPABASE_FIXTURES, ...FIXTURES });

function fixtureFor(rule) {
  const built = ALL_FIXTURES[rule]();
  return { secret: built.secret, line: built.line || `const value = '${built.secret}';` };
}

function scanRules(result) {
  const names = new Set(EXPOSURE_RULES.map(rule => rule.rule));
  return result.candidates.filter(candidate => names.has(candidate.rule));
}

/* ---- Every rule has a fixture, and every fixture is found -------------- */

{
  assert(EXPOSURE_RULES.length >= 60, `the catalogue must be broad: ${EXPOSURE_RULES.length}`);
  const names = EXPOSURE_RULES.map(rule => rule.rule);
  assert.strictEqual(new Set(names).size, names.length, 'rule names must be unique');
  /*
   * A rule's name becomes part of a finding's placeholder, and the database
   * admits a placeholder only as `<lower-case-and-dashes #n>`. A rule named
   * with a digit would find credentials and then fail to record every one.
   */
  const migration = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'db', 'migrations', '022_exposure_scans.sql'), 'utf8'
  );
  assert(migration.includes("placeholder ~ '^<[a-z-]+ #[0-9]+>$'"), 'the constraint this check mirrors must still be the one in the schema');
  for (const name of [...names, ...PATH_RULES.map(rule => rule.rule)]) {
    assert(/^[a-z-]+$/.test(name) && name.length <= 64, `${name}: a rule name must be storable in a placeholder`);
  }
  assert.deepStrictEqual(
    names.filter(name => !ALL_FIXTURES[name]), [],
    'every rule needs a positive fixture, or nothing proves it can find anything'
  );
  assert.deepStrictEqual(
    Object.keys(ALL_FIXTURES).filter(name => !names.includes(name)), [],
    'and no fixture may describe a rule that does not exist'
  );

  for (const name of names) {
    const { secret, line } = fixtureFor(name);
    const result = detectInText({ text: `${line}\n`, path: 'app/config.js' });
    const found = result.candidates;
    /*
     * Exactly one candidate, under exactly this rule, with exactly these
     * bytes. Two would be one credential reported twice -- once under a rule
     * whose narration is wrong for it -- and a reader told the wrong provider
     * rotates the wrong thing.
     */
    assert.strictEqual(found.length, 1, `${name}: expected one candidate, found ${found.map(item => item.rule).join(', ') || 'none'}`);
    assert.strictEqual(found[0].rule, name, `${name}: reported under ${found[0].rule}`);
    assert.strictEqual(found[0].secret, secret, `${name}: the match must be the credential and nothing around it`);
    assert.strictEqual(found[0].placeholder, `<${name} #1>`);
    assert.strictEqual(found[0].placeholder.includes(secret.slice(0, 8)), false, `${name}: the label must not carry the bytes`);
  }
}

/* ---- Keywords are necessary, and the pre-filter changes nothing -------- */

/*
 * A keyword is a substring every match must contain. Two checks, because a
 * wrong keyword is a silent miss: the rule is simply never run on the file
 * that holds the credential. Each keyword must appear literally in the rule's
 * own pattern, and each positive fixture must contain one.
 */
{
  for (const rule of EXPOSURE_RULES) {
    assert(Array.isArray(rule.keywords) && rule.keywords.length, `${rule.rule}: a scan rule must name its keywords`);
    const source = rule.regex.source.replace(/\\/g, '').toLowerCase();
    for (const keyword of rule.keywords) {
      assert.strictEqual(keyword, keyword.toLowerCase(), `${rule.rule}: keywords are compared lower-case`);
      assert(source.includes(keyword), `${rule.rule}: keyword ${JSON.stringify(keyword)} is not in its own pattern`);
    }
    const { line } = fixtureFor(rule.rule);
    assert(
      rule.keywords.some(keyword => line.toLowerCase().includes(keyword)),
      `${rule.rule}: its fixture contains none of its keywords, so the pre-filter would never run it`
    );
  }
}

/*
 * The same answers with the pre-filter on and off, over everything here --
 * in files of twenty fixtures each, because one file of all of them would hit
 * the per-file candidate ceiling and the comparison would be between two
 * truncated answers.
 */
{
  const lines = Object.keys(ALL_FIXTURES).map(name => fixtureFor(name).line);
  const found = new Set();
  for (let start = 0; start < lines.length; start += 20) {
    const corpus = lines.slice(start, start + 20).join('\n');
    const on = detectInText({ text: corpus, path: 'corpus.txt' });
    const off = detectInText({ text: corpus, path: 'corpus.txt', prefilter: false });
    assert.strictEqual(on.truncated, false, 'a chunk must stay under the ceiling for the comparison to mean anything');
    assert.deepStrictEqual(
      on.candidates.map(item => [item.rule, item.secret, item.occurrences]),
      off.candidates.map(item => [item.rule, item.secret, item.occurrences]),
      'the keyword pre-filter is an optimisation and must never change an answer'
    );
    for (const item of on.candidates) found.add(item.rule);
  }
  assert.deepStrictEqual(
    EXPOSURE_RULES.map(rule => rule.rule).filter(name => !found.has(name)), [],
    'every rule is found among its neighbours as well as alone'
  );
}

/* ---- Placeholders and near misses ------------------------------------ */

/*
 * Documentation is full of these, and a scanner that reports them is a
 * scanner people stop reading. Each is shaped closely enough to a real token
 * that only the plausibility check or a boundary stops it.
 */
{
  const negatives = [
    ['a run of x', `sk${'_live_'}${'x'.repeat(32)}`],
    ['a run of X', `AI${'za'}${'X'.repeat(35)}`],
    ['the word EXAMPLE', `AI${'za'}SyEXAMPLE${random('n1', 'b62', 26)}`],
    ['a sequential run', `np${'m_'}${'1234567890'.repeat(3)}abcdef`],
    ['a repeated character', `gs${'k_'}${'a'.repeat(52)}`],
    ['two alternating characters', `hf_${'ab'.repeat(17)}`],
    ['a documentation webhook', `https://hooks.${'slack.com'}/services/T00000000/B00000000/${'X'.repeat(24)}`],
    ['inside a longer identifier', `xsk${'_live_'}${random('n2', 'b62', 40)}`],
    ['a token that runs on', `np${'m_'}${random('n3', 'b62', 40)}`],
    ['a placeholder password', `mongodb://user:${'password'}@localhost:27017/app`],
    ['a template reference', `mysql://app:${'${DB_PASSWORD}'}@db.internal/app`],
    ['an environment reference', `redis://default:${'$REDIS_PASSWORD'}@cache:6379`],
    ['masked with stars', `amqp://guest:${'********'}@mq:5672`],
    /* The gate owns long PostgreSQL passwords; the scan rule stops below them
       so one connection string is never reported under two rules. */
    ['a long postgres password', `postgres://app:${random('n4', 'b62', 24)}@db.example.net/app`]
  ];
  for (const [label, text] of negatives) {
    const found = scanRules(detectInText({ text: `const v = "${text}";\n`, path: 'README.md' }));
    assert.deepStrictEqual(found.map(item => item.rule), [], `${label} must not be reported`);
  }
}

/*
 * A short PostgreSQL password is the scan's, not the gate's -- the other half
 * of the boundary above, so the split is proven from both sides.
 */
{
  const found = scanRules(detectInText({
    text: `DATABASE_URL=postgres://app:${random('pg', 'b62', 12)}@db.example.net/app\n`, path: '.env'
  }));
  assert.deepStrictEqual(found.map(item => item.rule), ['database-url-password']);
}

/* ---- Things that are not credentials --------------------------------- */

/*
 * Material every repository has, run through every rule. Any finding here is
 * a false positive a reader would see on day one.
 */
{
  const noise = [
    `"integrity": "sha512-${random('lock', 'b64', 86)}==",`,
    `"resolved": "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",`,
    `id: ${crypto.randomUUID()} parent: ${crypto.randomUUID()}`,
    `commit ${random('sha1', 'hex', 40)} tree ${random('sha2', 'hex', 40)}`,
    `color: #1f2937; background: #f9fafb; border-color: #e5e7eb;`,
    `<img src="data:image/png;base64,${random('png', 'b64', 200)}">`,
    `session = "${jwt({ sub: '123', name: 'A Person', iat: 1 })}"`,
    `const key = 'key-value store'; const skip = 'SKIP'; const patch = 'patch-1';`,
    `re_render(); hf_config = {}; pat = pattern; sk = sketch;`,
    `https://example.com/api/webhooks/not-a-discord-hook`,
    `password: process.env.DATABASE_PASSWORD`,
    `const AIza = 'AIza'; // prefix alone`,
    `-----BEGIN CERTIFICATE-----`,
    `-----BEGIN PUBLIC KEY-----`
  ].join('\n');
  const found = scanRules(detectInText({ text: noise, path: 'package-lock.json' }));
  assert.deepStrictEqual(found.map(item => `${item.rule}`), [], 'ordinary repository content must produce no finding');
}

/* ---- The plausibility check itself ----------------------------------- */

{
  assert(shannonEntropy('aaaaaaaa') === 0);
  assert(Math.abs(shannonEntropy('abababab') - 1) < 1e-9);
  assert(shannonEntropy(random('entropy', 'hex', 64)) > 3.5, 'random hex sits near four bits');
  assert(shannonEntropy(random('entropy', 'b62', 64)) > 5, 'random base-62 sits near six');
  assert.strictEqual(MIN_ENTROPY_BITS, 3);
  assert.strictEqual(plausibleSecret(random('p', 'b62', 40)), true);
  assert.strictEqual(plausibleSecret('your_api_key_here_12345'), false);
  assert.strictEqual(plausibleSecret('${STRIPE_SECRET_KEY}'), false);
  assert.strictEqual(plausibleConnectionString(`mongodb://u:${random('c', 'b62', 16)}@h/db`), true);
  assert.strictEqual(plausibleConnectionString('mongodb://u:changeme@h/db'), false);
  assert.strictEqual(plausibleConnectionString('mongodb://u:@h/db'), false);
}

/* ---- Files that are exposures by name --------------------------------- */

{
  const sha = random('blob', 'hex', 40);
  for (const [filePath, rule] of [
    ['android/app/release.jks', 'keystore-file'],
    ['certs/server.P12', 'keystore-file'],
    ['deploy/signing.pfx', 'keystore-file'],
    ['vault/passwords.kdbx', 'password-database-file']
  ]) {
    const result = detectInPath({ path: filePath, sha });
    assert.strictEqual(result.candidates.length, 1, filePath);
    assert.strictEqual(result.candidates[0].rule, rule, filePath);
    /* The identity is the blob: the same file again is the same finding. */
    assert.strictEqual(result.candidates[0].secret, `blob:${sha}`);
    assert.deepStrictEqual(result.candidates[0].occurrences, [{ line: 1, column: 1 }]);
  }
  for (const [filePath, blob] of [
    ['README.md', sha], ['keystore', sha], ['.jks', sha], ['app/release.jks', 'not-a-sha'], ['app/release.jks', '']
  ]) {
    assert.strictEqual(detectInPath({ path: filePath, sha: blob }).candidates.length, 0, `${filePath} ${blob}`);
  }
  assert.deepStrictEqual(PATH_RULES.map(rule => rule.rule), ['keystore-file', 'password-database-file']);
}

/* ---- The locator is the walk it replaced ----------------------------- */

/*
 * Held to the line-by-line walk on every offset of a file mixing all three
 * line endings, including a \r\n split across nothing and a trailing bare \r.
 */
{
  function walk(text, index) {
    let line = 1;
    let lineStart = 0;
    for (let cursor = 0; cursor < index; cursor += 1) {
      const code = text.charCodeAt(cursor);
      if (code === 10) { line += 1; lineStart = cursor + 1; }
      else if (code === 13) {
        line += 1;
        if (text.charCodeAt(cursor + 1) === 10) cursor += 1;
        lineStart = cursor + 1;
      }
    }
    return { line, column: index - lineStart + 1 };
  }
  const text = 'one\ntwo\r\nthree\rfour\n\n\r\r\nfive\r';
  const locate = createLocator(text);
  let compared = 0;
  for (let index = 0; index <= text.length; index += 1) {
    /*
     * One offset is excluded, and deliberately: the \n of a \r\n pair. The
     * walk answered "column 0" there, which is not a position in any line,
     * and no pattern can begin a match on a line ending -- so it is not an
     * offset a finding can ever carry.
     */
    if (text[index] === '\n' && text[index - 1] === '\r') continue;
    assert.deepStrictEqual(locate(index), walk(text, index), `offset ${index}`);
    compared += 1;
  }
  assert(compared >= text.length - 3, 'every other offset is compared');
}

/* ---- A large file with nothing in it stays cheap --------------------- */

/*
 * Not a timing assertion -- those flake -- but the property that makes the
 * breadth affordable: a megabyte of ordinary text containing no keyword yields
 * nothing, and is refused by no ceiling.
 */
{
  const text = 'the quick brown fox jumps over the lazy dog\n'.repeat(20_000);
  const result = detectInText({ text, path: 'big.txt' });
  assert.strictEqual(result.scanned, true);
  assert.strictEqual(result.truncated, false);
  assert.strictEqual(result.candidates.length, 0);
}

console.log(`exposure rules tests passed (${EXPOSURE_RULES.length} text rules, ${PATH_RULES.length} path rules)`);
