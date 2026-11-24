'use strict';
/*
 * Exposure scanning, asked of the composed server, end to end.
 *
 * Quasar's routes queue a scan of a repository at a commit; its worker reads
 * the tree and the files through the guarded transport, finds credentials and
 * keeps a keyed fingerprint of each, never the credential; a finding's
 * credential is then verified with its provider, once someone with the right
 * to do so confirms it. The composition hands the worker the fingerprint key,
 * and the routes four keys, each derived for its own purpose: the fingerprint,
 * the verification grant, the verification subject and the readability grant.
 *
 * This builds the application the server listens with, on a database of its
 * own, stands in for GitHub and for the credential's provider at the guarded
 * transport (nothing leaves the machine), and asks it. What each key made --
 * a finding's fingerprint, the verified subject's digest -- is made again here
 * from the session secret and the key's purpose, and must be the same.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { composedApplication, browser, standInForOutbound, standInForGuardedTransport, bodyOf } = require('./helpers/composed-application');
const { disposableDatabase, watchOverlappingQueries } = require('./helpers/disposable-database');
const { deriveKey, KEY_PURPOSES } = require('../apps/api/src/platform/crypto/key-derivation.ts');
const { detectInText } = require('../apps/api/src/modules/quasar/domain/exposure-detection.ts');
const { buildFindings, FINGERPRINT_KEY_VERSION } = require('../apps/api/src/modules/quasar/domain/exposure-findings.ts');

const SECRET = 's'.repeat(48);
const BASE = Object.freeze({ NODE_ENV: 'test', SESSION_SECRET: SECRET, NV_GOVERNANCE_RUNTIME_FAILURE_MODE: 'warn' });
const OCTO = `ghp_o${'z'.repeat(35)}`;
const SCOPE = Object.freeze({ provider: 'github', authority: 'github.com', owner: 'acme', repo: 'demo' });
const COMMIT = 'c'.repeat(40);
const BLOB = 'b'.repeat(40);
const PATH = 'config/deploy.env';
/* A credential, put together here so that no file holds one: an npm token, whose provider says whose it is. */
const CREDENTIAL = ['npm', 'Zq8Xv2Lm9Kp4Rt7Wy1Bn6Cd3Fg5Hj0Ks8LqT'].join('_');
const FILE = `# deployment\nREGISTRY=https://registry.npmjs.org\nNPM_TOKEN=${CREDENTIAL}\n`;
const SUBJECT = 'composition-npm';
/* And a Supabase project's anonymous key, beside the project it opens: a JWT whose role is anon, put together here too. */
const PROJECT = 'compositionprojectab';
const segment = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const ANON_KEY = [segment({ alg: 'HS256', typ: 'JWT' }), segment({ iss: 'supabase', ref: PROJECT, role: 'anon', iat: 1767225600, exp: 2082758400 }), crypto.randomBytes(32).toString('base64url')].join('.');
const SUPABASE_PATH = 'web/supabase.js';
const SUPABASE_FILE = `export const supabase = createClient('https://${PROJECT}.supabase.co', '${ANON_KEY}');\n`;
const SUPABASE_BLOB = 'd'.repeat(40);

(async () => {
  assert.equal(CREDENTIAL.length, 40, 'npm_ and thirty-six characters');
  const overlapping = watchOverlappingQueries();
  const database = await disposableDatabase('exposure');
  const github = standInForOutbound([
    ['GET /user$', { body: { login: 'octo', id: 7, name: 'Octo' }, headers: { 'x-oauth-scopes': 'repo' } }],
    ['GET /repos/acme/demo/collaborators/octo/permission$', { body: { permission: 'admin', role_name: 'admin', user: { login: 'octo', id: 7 } } }],
    ['GET /repos/acme/demo$', { body: { full_name: 'acme/demo', default_branch: 'main', private: true, visibility: 'private', permissions: { admin: true } } }]
  ]);
  /* GitHub's repository reads, and the registry the token belongs to, as the guarded transport reaches them. */
  const transport = standInForGuardedTransport([
    ['GET ^https://api\\.github\\.com/repos/acme/demo/commits/main$', { body: COMMIT }],
    [`GET ^https://api\\.github\\.com/repos/acme/demo/git/trees/${COMMIT}\\?recursive=1$`, {
      body: {
        sha: COMMIT, truncated: false, tree: [
          { path: PATH, mode: '100644', type: 'blob', sha: BLOB, size: Buffer.byteLength(FILE) },
          { path: SUPABASE_PATH, mode: '100644', type: 'blob', sha: SUPABASE_BLOB, size: Buffer.byteLength(SUPABASE_FILE) }
        ]
      }
    }],
    [`GET ^https://api\\.github\\.com/repos/acme/demo/git/blobs/${BLOB}$`, {
      body: { sha: BLOB, size: Buffer.byteLength(FILE), encoding: 'base64', content: Buffer.from(FILE).toString('base64') }
    }],
    [`GET ^https://api\\.github\\.com/repos/acme/demo/git/blobs/${SUPABASE_BLOB}$`, {
      body: { sha: SUPABASE_BLOB, size: Buffer.byteLength(SUPABASE_FILE), encoding: 'base64', content: Buffer.from(SUPABASE_FILE).toString('base64') }
    }],
    ['GET ^https://registry\\.npmjs\\.org/-/whoami$', (href, sent) => (sent.authorization === `Bearer ${CREDENTIAL}`
      ? { body: { username: SUBJECT } }
      : { status: 401, body: { error: 'not this token' } })],
    [`GET ^https://${PROJECT}\\.supabase\\.co/rest/v1/profiles\\?select=id&limit=\\d+$`, { body: [{ id: 1 }] }]
  ], { names: { 'api.github.com': '140.82.112.6', 'registry.npmjs.org': '104.16.1.35', [`${PROJECT}.supabase.co`]: '104.18.38.10' } });
  const application = await composedApplication({ ...BASE, DATABASE_URL: database.url });
  const client = await database.client();
  try {
    assert.equal(await application.core.ready(), true, 'the store is opened and migrated');
    const page = browser(application);
    assert.equal((await page.signIn(OCTO)).status, 200);
    const csrf = await page.csrf();
    const answer = async pending => {
      const response = await pending;
      const text = await response.clone().text();
      return { status: response.status, body: await bodyOf(response), text };
    };

    /*
     * ---- A scan asked for is run, and what it finds is fingerprinted, never kept ----
     * Replaces exposure scanning's checks that the server mounts the
     * exposure routes and hands them the module's own reader. The commit the
     * branch is at is resolved when the scan is asked for; the worker reads
     * the tree and the file at it, finds the token, and keeps a fingerprint
     * made with the fingerprint key -- the same one made here from the session
     * secret -- and nowhere the token itself.
     */
    const requested = await answer(page.request('/api/repo/acme/demo/exposure/scans', {
      method: 'POST', body: { ref: 'main' }, headers: { 'x-nv-csrf': csrf, 'Idempotency-Key': 'composition-exposure-scan' }
    }));
    assert.equal(requested.status, 201, requested.text);
    const scanId = requested.body.scan.scanId;
    const deadline = Date.now() + 15_000;
    let scan = requested.body.scan;
    while (['queued', 'running'].includes(scan.state)) {
      assert(Date.now() < deadline, `the scan should end: ${JSON.stringify(scan)}`);
      await new Promise(resolve => setTimeout(resolve, 100));
      scan = (await answer(page.request(`/api/repo/acme/demo/exposure/scans/${scanId}`))).body.scan;
    }
    assert.deepEqual([scan.state, scan.commitSha], ['complete', COMMIT], `the scan reads the commit the branch was at: ${JSON.stringify(scan)}`);
    const listed = await answer(page.request('/api/repo/acme/demo/exposure/findings'));
    assert.equal(listed.status, 200, listed.text);
    assert.deepEqual(listed.body.findings.map(finding => [finding.rule, finding.path]).sort(),
      [['contextual-provider-secret', PATH], ['npm-token', PATH], ['supabase-anon-key', SUPABASE_PATH]],
      'each credential is found where it is: the token by its own shape and by the setting that names it, the anonymous key by its role');
    const { fingerprint } = listed.body.findings.find(finding => finding.rule === 'npm-token');
    const fingerprintKey = deriveKey(SECRET, KEY_PURPOSES.EXPOSURE_FINDING_FINGERPRINT);
    const expected = [[FILE, PATH], [SUPABASE_FILE, SUPABASE_PATH]].flatMap(([text, path]) => buildFindings({
      detection: detectInText({ text }), path, scope: SCOPE, commit: COMMIT, hmacKey: fingerprintKey, keyVersion: FINGERPRINT_KEY_VERSION
    }).probes.map(probe => probe.fingerprint));
    assert.deepEqual(expected.sort(), listed.body.findings.map(finding => finding.fingerprint).sort(), 'each fingerprint is made with the fingerprint key');

    /*
     * ---- A finding's credential is verified with its provider, once confirmed ----
     * Replaces exposure scanning's checks that the server takes each grant's
     * key from the settings and hands it to the routes under its own name,
     * with the module's own verifier. Unconfirmed, nothing is read. Confirmed,
     * the file is read again at the finding's commit, the token found again by
     * its fingerprint -- made with the routes' fingerprint key -- and the
     * registry asked whose it is, under a grant made with the verification
     * key. The answer is kept as a digest of the subject, made with the
     * verification subject key: the same one made here.
     */
    {
      const before = transport.requests.length;
      const unconfirmed = await answer(page.request(`/api/repo/acme/demo/exposure/findings/${fingerprint}/verify`, {
        method: 'POST', body: {}, headers: { 'x-nv-csrf': csrf, 'Idempotency-Key': 'composition-exposure-unconfirmed' }
      }));
      assert.deepEqual([unconfirmed.status, unconfirmed.body.code, transport.requests.length], [400, 'EXPOSURE_VERIFY_UNCONFIRMED', before],
        'unconfirmed, a verification reads nothing and asks nobody');
      const verified = await answer(page.request(`/api/repo/acme/demo/exposure/findings/${fingerprint}/verify`, {
        method: 'POST', body: { confirm: 'use-this-credential', authorized: true }, headers: { 'x-nv-csrf': csrf, 'Idempotency-Key': 'composition-exposure-verify' }
      }));
      assert.equal(verified.status, 201, verified.text);
      assert.equal(verified.body.verification.state, 'verified', 'the registry says whose the token is');
      assert.deepEqual(transport.requests.slice(before).filter(request => request.url.startsWith('https://registry.npmjs.org')).map(request => request.authorization),
        [`Bearer ${CREDENTIAL}`], 'the registry is asked once, with the token');
      const subjectKey = deriveKey(SECRET, KEY_PURPOSES.EXPOSURE_VERIFICATION_SUBJECT);
      const digest = crypto.createHmac('sha256', subjectKey).update(`npm-token|${SUBJECT}`, 'utf8').digest('hex').slice(0, 32);
      assert.deepEqual((await client.query('SELECT subject_digest FROM nv_exposure_verifications')).rows, [{ subject_digest: digest }],
        'the subject is kept as a digest made with the verification subject key');
    }

    /*
     * ---- What the public can read of a project is asked with its anonymous key alone ----
     * Replaces exposure scanning's check that the server hands the routes the
     * module's own prober and the readability grant's key. The project named
     * beside the anonymous key is asked for one relation's column, once, under
     * a grant made with the readability key, and the answer is kept.
     */
    const probed = await (async () => {
      const { fingerprint: anonymous } = listed.body.findings.find(finding => finding.rule === 'supabase-anon-key');
      const before = transport.requests.length;
      const answered = await answer(page.request(`/api/repo/acme/demo/exposure/findings/${anonymous}/probe-readability`, {
        method: 'POST', body: { confirm: 'contact-this-project', authorized: true, relation: 'profiles', projection: ['id'] },
        headers: { 'x-nv-csrf': csrf, 'Idempotency-Key': 'composition-exposure-probe' }
      }));
      assert.equal(answered.status, 201, answered.text);
      assert.equal(answered.body.probe.state, 'readable', 'the project answers the anonymous key with rows');
      assert.equal(transport.requests.slice(before).filter(request => request.url.startsWith(`https://${PROJECT}.supabase.co/`)).length, 1, 'and is asked once');
      return answered;
    })();

    /* Nothing the server answered or kept holds the token or the key. */
    {
      const answered = [requested.text, listed.text, probed.text];
      assert(!answered.some(text => text.includes(CREDENTIAL) || text.includes(ANON_KEY)), 'no answer holds the token or the key');
      const tables = (await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'nv_exposure%'")).rows.map(row => row.table_name);
      for (const table of tables) {
        const rows = (await client.query(`SELECT * FROM ${table}`)).rows;
        assert(!JSON.stringify(rows).includes(CREDENTIAL) && !JSON.stringify(rows).includes(ANON_KEY), `${table} keeps neither`);
      }
    }
  } finally {
    await client.end();
    transport.restore();
    github.restore();
    await application.close();
    await database.drop();
  }
  /* A warning is emitted on the next turn; it has had one by now. */
  await new Promise(resolve => setImmediate(resolve));
  overlapping.stop();
  assert.deepEqual(overlapping.seen, [], 'no database client was handed a query while it was still running one');
  console.log('composition, exposure scanning: ok');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
