'use strict';
/*
 * Quasar's twelve exposure routes, over HTTP (D12): registered by the module
 * with the guards, the store, the repository reader and the two outbound
 * clients handed in, so what the routes decide is read without a database or
 * a provider. The verifier and the prober are the real ones, given a stand-in
 * transport: a grant the route mints is accepted only if it binds exactly
 * what the route resolved, so a request reaching that transport is the proof
 * the grant is right.
 *
 * What each route must hold: the chain the route policy records; the
 * identity in every store call; an explicit word before anything irreversible
 * or outbound, checked before the repository is read; a credential recovered
 * from the file at the finding's commit and matched by fingerprint, never
 * stored and never answered; and failures through the public error body.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const quasar = require('../apps/api/src/modules/quasar/index.ts');
const { KEY_PURPOSES, deriveKey } = require('../apps/api/src/platform/crypto/key-derivation.ts');
const { publicErrorBody } = require('../apps/api/src/http/errors.ts');
const { locations } = require('./oracles/route-policy');

const root = path.resolve(__dirname, '..');
const BASE = '/api/repo/:owner/:repo/exposure/';

/* ---- The chain in front of each route, as the route policy reads it ---- */
{
  const routes = locations(root).filter(entry => entry.kind === 'route' && entry.path.startsWith(BASE));
  assert.equal(routes.length, 12, `expected twelve exposure routes, found ${routes.length}`);
  for (const route of routes) {
    assert(route.at.startsWith('apps/api/src/modules/quasar/http/exposure-routes.ts:'), `${route.path} is registered by Quasar (${route.at})`);
    assert.deepEqual(route.guards.slice(0, 4), ['providerSessionAccess', 'alphaRepositoryAccess', "capabilityAccess('exposure.scan')", 'auth'],
      `${route.method} ${route.path}: the session, the alpha boundary, its own capability and authentication, in that order`);
    assert(route.guards[4].startsWith('governanceAccess('), `${route.path}: then a governance role`);
    /* Only a read records nothing; everything that decides something records it. */
    assert.equal(route.guards.length, route.method === 'GET' ? 5 : 6, `${route.method} ${route.path}`);
  }
  const chain = (method, tail) => routes.find(route => route.method === method && route.path === BASE + tail).guards;
  /* Accepting a risk and using a credential are an administrator's; every other route is the reader's own work. */
  for (const tail of ['findings/:fingerprint/verify', 'findings/:fingerprint/probe-readability', 'findings/:fingerprint/accept-risk']) {
    assert.equal(chain('POST', tail)[4], "governanceAccess('administrator')", tail);
  }
  assert.equal(routes.filter(route => route.guards[4] === "governanceAccess('administrator')").length, 3);
  for (const route of routes.filter(item => item.guards[4] !== "governanceAccess('administrator')")) {
    assert.equal(route.guards[4], "governanceAccess('reader', OWN_WORK)", route.path);
  }
  for (const [tail, action] of [
    ['scans', 'exposure.scan.request'], ['scans/:scanId/cancel', 'exposure.scan.cancel'],
    ['findings/:fingerprint/accept-risk', 'exposure.finding.accept-risk'], ['findings/:fingerprint/verify', 'exposure.credential.verify'],
    ['findings/:fingerprint/probe-readability', 'exposure.readability.probe'], ['clear', 'exposure.history.clear']
  ]) {
    assert.equal(chain('POST', tail)[5], `governanceMutationContext('${action}')`, tail);
  }
  /* Accepting a risk names the exposure capability with no experimental opt-in. */
  assert(!chain('POST', 'findings/:fingerprint/accept-risk').some(guard => guard.includes('allowExperimental')));
}

/*
 * What the routes do with a credential is asked of them below: each route that
 * uses one reads the finding back through the reader, at its commit; the
 * project's address is the prober's to build from a validated reference; the
 * credential goes to the verifier or the prober and to nothing else -- no part
 * of it reaches a response or a record -- and no error's message reaches a
 * response. The reader handed to the routes holds no way to read a tree, by its
 * type, and the worker cannot resolve a ref at all (test/module-rules.test.js).
 */

/* ---- The routes, exercised ---- */
const MASTER = 'q'.repeat(64);
const KEYS = {
  fingerprint: deriveKey(MASTER, KEY_PURPOSES.EXPOSURE_FINDING_FINGERPRINT),
  verification: deriveKey(MASTER, KEY_PURPOSES.EXPOSURE_VERIFICATION_AUTHORIZATION),
  verificationSubject: deriveKey(MASTER, KEY_PURPOSES.EXPOSURE_VERIFICATION_SUBJECT),
  readability: deriveKey(MASTER, KEY_PURPOSES.EXPOSURE_READABILITY_AUTHORIZATION)
};
const SCOPE = Object.freeze({ provider: 'github', authority: 'github.com', owner: 'acme', repo: 'demo' });
const IDENTITY = 'a'.repeat(64);
const COMMIT = 'c'.repeat(40);
const FILE = 'app/config.js';
const PROJECT_REF = 'abcdefghijklmnopqrst';
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const ANON_KEY = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ iss: 'supabase', ref: PROJECT_REF, role: 'anon', iat: 1, exp: 9999999999 })}.${'s'.repeat(43)}`;
const PAT = `ghp_${'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'}`;
const TEXT = `const url = "https://${PROJECT_REF}.supabase.co";\nconst key = "${ANON_KEY}";\nconst gh = "${PAT}";\n`;
const built = quasar.buildFindings({ detection: quasar.detectInText({ text: TEXT }), path: FILE, scope: SCOPE, commit: COMMIT, hmacKey: KEYS.fingerprint, keyVersion: 1 });
const fingerprintOf = rule => built.findings.find(finding => finding.rule === rule).fingerprint;
const GITHUB = fingerprintOf('github-token');
const ANON = fingerprintOf('supabase-anon-key');
/* Every six-character run of a secret: a part of one is a lead to the rest. */
const fragmentsOf = secret => Array.from({ length: Math.max(0, secret.length - 5) }, (_, at) => secret.slice(at, at + 6));
const storedFinding = (fingerprint, rule, extra = {}) => ({
  fingerprint, rule, path: FILE, commit: COMMIT, fingerprintKeyVersion: 1, disposition: 'open',
  placeholder: `<${rule}-1>`, occurrences: [{ line: 3, column: 13 }], occurrenceCount: 1, ...extra
});

(async () => {
  const calls = [];
  const answers = {};
  const failing = new Map();
  let configured = true;
  let nudges = 0;
  let blob = { text: TEXT, skip: null };
  const verifierRequests = [];
  const proberRequests = [];
  const grants = [];
  /* What the routes hand the verifier and the prober, by field. */
  const handed = [];
  const store = new Proxy({}, {
    get: (_target, name) => async input => {
      calls.push([String(name), input]);
      if (failing.has(name)) throw failing.get(name);
      return typeof answers[name] === 'function' ? answers[name](input) : answers[name];
    }
  });
  const app = express();
  app.use(express.json());
  quasar.registerExposureRoutes(app, {
    providerSessionAccess: (req, _res, next) => { req.gh = { login: 'alice', token: 'gho_reader' }; next(); },
    alphaRepositoryAccess: (_req, _res, next) => next(),
    capabilityAccess: () => (_req, _res, next) => next(),
    auth: (_req, _res, next) => next(),
    governanceAccess: () => (req, _res, next) => { req.governance = { scope: SCOPE, actor: { identityKey: IDENTITY } }; next(); },
    OWN_WORK: Object.freeze({ publicRepositories: true }),
    governanceMutationContext: () => (_req, _res, next) => next(),
    governance: req => req.governance,
    account: req => req.gh,
    retainedActor: req => req.gh.login,
    publicErrorBody,
    exposureService: () => {
      if (!configured) throw Object.assign(new Error('Exposure scanning requires the configured PostgreSQL DATABASE_URL'), { status: 503, code: 'EXPOSURE_DATABASE_REQUIRED' });
      return store;
    },
    nudgeWorker: () => { nudges++; },
    keys: KEYS,
    reader: {
      resolveCommit: async input => { calls.push(['resolveCommit', input]); return { ref: 'refs/heads/main', commitSha: COMMIT }; },
      readFileAtCommit: async input => { calls.push(['readFileAtCommit', input]); return blob; }
    },
    verifyCredential: input => (grants.push(input.authorization), handed.push(['verifier', Object.keys(input).sort()]), quasar.credentialVerifier.verifyCredential)({
      ...input, transport: async request => { verifierRequests.push(request); return { statusCode: 401, body: '{}' }; }
    }),
    probeReadability: input => (grants.push(input.authorization), handed.push(['prober', Object.keys(input).sort()]), quasar.readabilityProbe.probeAnonymousReadability)({
      ...input, transport: async request => { proberRequests.push(request); return { statusCode: 200, body: '[{"id":1}]' }; }
    })
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/repo/acme/demo/exposure/`;
  const call = async (method, tail, body, headers = {}) => {
    calls.length = 0;
    const response = await fetch(base + tail, {
      method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) };
  };
  const storeCalls = () => calls.filter(([name]) => !['resolveCommit', 'readFileAtCommit'].includes(name));
  const reads = () => calls.filter(([name]) => name === 'readFileAtCommit');
  /* The boundary lives in the store's WHERE clause: every call carries this person's identity. */
  const everyCallCarriesTheIdentity = label => {
    assert(storeCalls().length > 0, label);
    for (const [name, input] of storeCalls()) assert.equal(input.identityKey, IDENTITY, `${label}: ${name} carries the identity`);
  };

  try {
    /* Requesting a scan: the ref is resolved once, here, and the commit is what the scan records. */
    {
      answers.requestScan = { scan: { scanId: 's1', state: 'queued' }, created: true };
      const created = await call('POST', 'scans', { ref: 'main' }, { 'idempotency-key': 'key-1' });
      assert.equal(created.status, 201);
      assert.deepEqual(created.body, { scan: { scanId: 's1', state: 'queued' }, created: true });
      const [resolve, request] = calls;
      assert.deepEqual(resolve, ['resolveCommit', { scope: SCOPE, ref: 'main', token: 'gho_reader' }]);
      assert.equal(request[0], 'requestScan');
      assert.equal(request[1].commitSha, COMMIT, 'the scan records the resolved commit');
      assert.equal(request[1].refName, 'refs/heads/main');
      assert.equal(request[1].requestedBy, 'alice');
      assert.equal(request[1].scanMode, 'tree');
      assert.equal(request[1].idempotencyKey, 'key-1');
      assert.equal(request[1].fingerprintKeyId, quasar.fingerprintKeyId(KEYS.fingerprint));
      assert.equal(request[1].rulesVersion, quasar.RULES_VERSION);
      assert.equal(request[1].configVersion, quasar.EXPOSURE_CONFIG_VERSION);
      assert.equal(nudges, 1, 'a requested scan starts the worker now rather than at its next tick');
      everyCallCarriesTheIdentity('request');

      /* History is read only when asked for, and only a literal true asks; a repeated request is not a new one. */
      answers.requestScan = { scan: { scanId: 's1' }, created: false };
      const again = await call('POST', 'scans', { history: 'true' });
      assert.equal(again.status, 200);
      assert.equal(calls[0][1].ref, 'HEAD');
      assert.equal(calls[1][1].scanMode, 'tree');
      assert.match(calls[1][1].idempotencyKey, /^[0-9a-f-]{36}$/, 'without a key, each request is its own');
      await call('POST', 'scans', { history: true });
      assert.equal(calls[1][1].scanMode, 'history');
    }

    /* A scan, and a missing one. */
    {
      answers.getScan = null;
      assert.deepEqual((await call('GET', 'scans/s9')).body, { error: 'Not found', code: 'EXPOSURE_SCAN_NOT_FOUND' });
      answers.getScan = { scanId: 's1' };
      const found = await call('GET', 'scans/s1');
      assert.deepEqual(found.body, { scan: { scanId: 's1' } });
      assert.equal(calls[0][1].scanId, 's1');
      everyCallCarriesTheIdentity('scan');
    }

    /* The history: severities summed by the narration table's, an unknown or inherited rule as serious. */
    {
      answers.listScans = [{ scanId: 's1' }, { scanId: 's2' }];
      answers.scanRuleCounts = [
        { scanId: 's1', rule: 'github-token', total: 2 }, { scanId: 's1', rule: 'made-up-rule', total: 1 },
        { scanId: 's1', rule: 'constructor', total: 4 }
      ];
      const history = await call('GET', 'scans?limit=5&beforeAt=2026-10-01T00:00:00.000Z&beforeId=s0');
      assert.equal(history.status, 200);
      assert.deepEqual(history.body.scans, [
        { scanId: 's1', severityCounts: { critical: 2, serious: 5, warning: 0 } },
        { scanId: 's2', severityCounts: { critical: 0, serious: 0, warning: 0 } }
      ]);
      assert.deepEqual(calls[0][1].before, { createdAt: '2026-10-01T00:00:00.000Z', scanId: 's0' });
      assert.equal(calls[0][1].limit, 5);
      assert.deepEqual(calls[1][1].scanIds, ['s1', 's2'], 'rule counts in one query');
      everyCallCarriesTheIdentity('history');
    }

    /* Clearing: the explicit word, refused before the store is even asked for. */
    {
      configured = false;
      const refused = await call('POST', 'clear', { confirm: 'clear' });
      assert.equal(refused.status, 400);
      assert.equal(refused.body.code, 'EXPOSURE_CLEAR_UNCONFIRMED');
      configured = true;
      answers.clearHistory = { scans: 2 };
      const cleared = await call('POST', 'clear', { confirm: 'clear-exposure-history' });
      assert.equal(cleared.status, 201);
      assert.deepEqual(cleared.body, { cleared: { scans: 2 } });
      everyCallCarriesTheIdentity('clear');
    }

    /* Cancelling. */
    {
      answers.cancelScan = null;
      assert.equal((await call('POST', 'scans/s1/cancel')).status, 404);
      answers.cancelScan = { scanId: 's1', state: 'cancelled' };
      assert.equal((await call('POST', 'scans/s1/cancel')).status, 201);
      everyCallCarriesTheIdentity('cancel');
    }

    /* The findings: each described, both sentences, the path masked, and the questions it can be asked. */
    {
      const hidden = `archive.zip!/${PAT}.txt`;
      answers.listFindingsPage = {
        findings: [storedFinding(GITHUB, 'github-token', { path: hidden, disposition: 'accepted-risk' }), storedFinding(ANON, 'supabase-anon-key'), storedFinding('e'.repeat(64), 'made-up-rule')],
        nextCursor: 'next'
      };
      answers.latestAnswers = {
        verifications: { [GITHUB]: { state: 'rejected', reason: 'provider-rejected', observedAt: new Date().toISOString() } },
        probes: { [ANON]: { state: 'readable', reason: 'rows-visible', observedAt: new Date().toISOString() } }
      };
      const page = await call('GET', 'findings?status=open&q=tok&severity=critical&where=tree&cursor=c1');
      assert.equal(page.status, 200);
      assert.equal(page.body.nextCursor, 'next');
      const [github, anon, unknown] = page.body.findings;
      assert.deepEqual(github.narration, JSON.parse(JSON.stringify(quasar.describeFinding(answers.listFindingsPage.findings[0]))));
      assert.equal(github.dispositionNarration, quasar.describeDisposition('accepted-risk'), 'the decision is a sentence, not a slug');
      assert.equal(github.path, github.displayPath);
      assert(!page.text.includes(PAT), 'a credential-shaped file name is never answered');
      assert.deepEqual([github.verifiable, anon.verifiable, unknown.verifiable], [true, false, false], 'verification only where a verifier exists');
      assert.deepEqual([github.probeable, anon.probeable, unknown.probeable], [false, true, false], 'a readability probe only for an anonymous key');
      assert.equal(page.body.verifications[GITHUB].narration, quasar.describeVerification(answers.latestAnswers.verifications[GITHUB]));
      assert.equal(page.body.probes[ANON].narration, quasar.describeProbe(answers.latestAnswers.probes[ANON]));
      const [list, latest] = calls;
      assert.equal(list[0], 'listFindingsPage');
      assert.deepEqual(list[1].dispositions, ['open']);
      assert.equal(list[1].currentGeneration, true);
      assert.deepEqual(latest[1].fingerprints, [GITHUB, ANON, 'e'.repeat(64)]);
      assert(!calls.some(([name]) => name === 'latestLocations'), 'a later location read must not overwrite snapshot evidence');
      everyCallCarriesTheIdentity('findings');
      await call('GET', 'findings?status=all');
      assert.equal(calls[0][1].dispositions, undefined);
    }

    /* A scan's report: each observation with its finding, described with that scan's locations. */
    {
      answers.scanReportPage = {
        nextCursor: null, complete: true,
        observations: [{ observation: { scanId: 's1', occurrences: [{ line: 9, column: 1 }], occurrenceCount: 4, inTree: false, introducedCommit: COMMIT }, finding: storedFinding(GITHUB, 'github-token') }]
      };
      const report = await call('GET', 'scans/s1/observations');
      assert.equal(report.status, 200);
      const [entry] = report.body.observations;
      assert.deepEqual(entry.finding.occurrences, [{ line: 9, column: 1 }]);
      assert.equal(entry.finding.occurrenceCount, 4);
      assert.equal(entry.finding.inTree, false);
      assert.equal(typeof entry.finding.narration, 'object');
      everyCallCarriesTheIdentity('report');
    }

    /* Verifying: the explicit word, before anything is read. */
    {
      for (const body of [undefined, {}, { confirm: 'use-this-credential' }, { confirm: 'use-this-credential', authorized: 'true' }, { authorized: true }]) {
        const refused = await call('POST', `findings/${GITHUB}/verify`, body);
        assert.equal(refused.status, 400, JSON.stringify(body));
        assert.equal(refused.body.code, 'EXPOSURE_VERIFY_UNCONFIRMED');
        assert.deepEqual(calls, [], 'refused before the store or the repository is read');
      }
      const confirm = { confirm: 'use-this-credential', authorized: true };
      answers.getFinding = null;
      assert.equal((await call('POST', `findings/${GITHUB}/verify`, confirm)).body.code, 'EXPOSURE_FINDING_NOT_FOUND');
      answers.getFinding = storedFinding(GITHUB, 'github-token', { commit: null });
      assert.equal((await call('POST', `findings/${GITHUB}/verify`, confirm)).body.code, 'EXPOSURE_PROVENANCE_REQUIRED');
      assert.deepEqual(reads(), []);

      /* A file that is gone, unreadable or changed yields no candidate, and nothing is sent. */
      answers.getFinding = storedFinding(GITHUB, 'github-token');
      for (const [answer, why] of [[{ text: null, skip: 'missing' }, 'gone'], [{ text: null, skip: 'too-large' }, 'unreadable'], [{ text: 'const a = 1;\n', skip: null }, 'changed']]) {
        blob = answer;
        const gone = await call('POST', `findings/${GITHUB}/verify`, confirm);
        assert.equal(gone.status, 409, why);
        assert.equal(gone.body.code, 'EXPOSURE_CANDIDATE_GONE', why);
      }
      assert.equal(verifierRequests.length, 0);

      /* The file at the finding's commit, re-detected, the candidate matched by fingerprint, the grant accepted by the real verifier. */
      blob = { text: TEXT, skip: null };
      answers.recordVerification = input => ({ verification: { state: input.record.state, reason: input.record.reason }, finding: storedFinding(GITHUB, 'github-token') });
      const verified = await call('POST', `findings/${GITHUB.toUpperCase()}/verify`, confirm);
      assert.equal(verified.status, 201);
      assert.deepEqual(reads()[0][1], { scope: SCOPE, commitSha: COMMIT, path: FILE, token: 'gho_reader' });
      assert.equal(verifierRequests.length, 1, 'the grant binds what the route resolved, so the verifier sends it');
      assert(verifierRequests[0].url.startsWith('https://api.github.com/'));
      const recorded = calls.find(([name]) => name === 'recordVerification')[1];
      assert.equal(recorded.fingerprint, GITHUB);
      assert.equal(recorded.requestedBy, 'alice');
      assert.equal(recorded.authorizationId, recorded.record.authorizationId);
      assert.equal(recorded.record.state, 'rejected', 'the provider\'s answer is the record');
      assert.equal(verified.body.narration, quasar.describeVerification(recorded.record));
      assert.equal(verified.body.finding.dispositionNarration, quasar.describeDisposition('open'));
      assert(!verified.text.includes(PAT) && !JSON.stringify(recorded).includes(PAT), 'the credential reaches neither the response nor the record');
      assert.deepEqual(fragmentsOf(PAT).filter(part => verified.text.includes(part) || JSON.stringify(recorded).includes(part)), [], 'nor any part of it');
      assert.deepEqual(handed.filter(([to]) => to === 'verifier').at(-1)[1], ['actorLogin', 'authorization', 'authorizationKey', 'candidate', 'now', 'subjectKey'],
        'the verifier is handed the candidate and its grant, never an address');
      const grant = grants.at(-1);
      assert.equal(Date.parse(grant.expiresAt) - Date.parse(grant.issuedAt), 60_000, 'the grant is spent now or not at all');
      assert.deepEqual([grant.candidateFingerprint, grant.commit, grant.actorLogin], [GITHUB, COMMIT, 'alice']);
      everyCallCarriesTheIdentity('verify');
    }

    /* The verifier is reached only with a grant the route minted for it: one signed with another key is refused before the network. */
    {
      const candidate = quasar.revealForVerification(built.probes.find(probe => probe.fingerprint === GITHUB));
      const adapter = quasar.credentialVerifier.adapterForCandidate(candidate);
      const issuedAt = new Date();
      const grant = key => quasar.credentialVerifier.signVerificationAuthorization({
        hmacKey: key, authorizationId: 'auth-1', actorLogin: 'alice', scope: SCOPE, commit: COMMIT, candidateFingerprint: GITHUB,
        adapter: adapter.id, targetId: adapter.targetId, issuedAt: issuedAt.toISOString(), expiresAt: new Date(issuedAt.getTime() + 60_000).toISOString()
      });
      const sent = [];
      const transport = async request => { sent.push(request); return { statusCode: 401, body: '{}' }; };
      const verify = authorization => quasar.credentialVerifier.verifyCredential({ candidate, authorization, authorizationKey: KEYS.verification, subjectKey: KEYS.verificationSubject, actorLogin: 'alice', now: issuedAt.getTime(), transport });
      await verify(grant(KEYS.readability));
      assert.equal(sent.length, 0, 'a grant signed with the readability key is not a verification grant');
      await verify(grant(KEYS.verification));
      assert.equal(sent.length, 1);
    }

    /* Probing readability: the word, an anonymous key, the operator's relation and columns, a project from the file. */
    {
      for (const body of [undefined, { confirm: 'contact-this-project' }, { confirm: 'contact-this-project', authorized: 'yes' }]) {
        assert.equal((await call('POST', `findings/${ANON}/probe-readability`, body)).body.code, 'EXPOSURE_PROBE_UNCONFIRMED');
        assert.deepEqual(calls, [], 'refused before anything is read');
      }
      const ask = { confirm: 'contact-this-project', authorized: true, relation: ' profiles ', projection: [' id ', 'name'] };
      answers.getFinding = storedFinding(GITHUB, 'github-token');
      const notAnonymous = await call('POST', `findings/${GITHUB}/probe-readability`, ask);
      assert.equal(notAnonymous.body.code, 'EXPOSURE_PROBE_NOT_ANONYMOUS');
      assert.deepEqual(reads(), [], 'decided before the file is read');

      answers.getFinding = storedFinding(ANON, 'supabase-anon-key');
      blob = { text: `const key = "${ANON_KEY}";\n`, skip: null };
      assert.equal((await call('POST', `findings/${ANON}/probe-readability`, ask)).body.code, 'EXPOSURE_PROBE_NO_PROJECT');
      blob = { text: TEXT, skip: null };
      answers.recordReadabilityProbe = input => ({ probe: { state: input.record.state, rowCount: input.record.rowCount } });
      const probed = await call('POST', `findings/${ANON}/probe-readability`, ask);
      assert.equal(probed.status, 201);
      assert.equal(proberRequests.length, 1, 'the grant binds the project, the relation and the columns, so the prober sends it');
      assert.equal(proberRequests[0].url, `https://${PROJECT_REF}.supabase.co/rest/v1/profiles?select=${encodeURIComponent('id,name')}&limit=1`);
      const recorded = calls.find(([name]) => name === 'recordReadabilityProbe')[1];
      assert.equal(recorded.record.state, 'readable');
      assert.deepEqual(recorded.record.projection, ['id', 'name']);
      assert.equal(probed.body.narration, quasar.describeProbe(recorded.record));
      assert(!probed.text.includes(ANON_KEY) && !JSON.stringify(recorded).includes(ANON_KEY), 'the key reaches neither the response nor the record');
      assert.deepEqual(fragmentsOf(ANON_KEY.split('.')[2]).filter(part => probed.text.includes(part) || JSON.stringify(recorded).includes(part)), [], 'nor any part of its signature');
      const grant = grants.at(-1);
      assert.equal(Date.parse(grant.expiresAt) - Date.parse(grant.issuedAt), 60_000, 'the grant is spent now or not at all');
      assert.deepEqual([grant.projectRef, grant.relation, grant.projection], [PROJECT_REF, 'profiles', ['id', 'name']], 'bound to the project in the file and the question the operator asked');
      assert.deepEqual(handed.filter(([to]) => to === 'prober').at(-1)[1],
        ['actorLogin', 'anonKey', 'authorization', 'authorizationKey', 'candidate', 'now', 'projectRef', 'projection', 'relation'],
        'the prober is handed a validated reference and the question, never an address to send the key to');
      everyCallCarriesTheIdentity('probe');
    }

    /* The two answer histories, narrated, with the fingerprint lower-cased. */
    {
      answers.listVerifications = [{ state: 'verified', reason: 'provider-accepted' }];
      const verifications = await call('GET', `findings/${GITHUB.toUpperCase()}/verifications?limit=3`);
      assert.equal(verifications.body.verifications[0].narration, quasar.describeVerification(answers.listVerifications[0]));
      assert.equal(calls[0][1].fingerprint, GITHUB);
      assert.equal(calls[0][1].limit, 3);
      everyCallCarriesTheIdentity('verifications');
      answers.listReadabilityProbes = [{ state: 'denied', reason: 'access-denied-for-tested-request' }];
      const probes = await call('GET', `findings/${ANON}/readability-probes`);
      assert.equal(probes.body.probes[0].narration, quasar.describeProbe(answers.listReadabilityProbes[0]));
      everyCallCarriesTheIdentity('readability probes');
    }

    /* Accepting the risk: recorded under the person who decided. */
    {
      answers.acceptRisk = null;
      assert.equal((await call('POST', `findings/${GITHUB}/accept-risk`)).body.code, 'EXPOSURE_FINDING_NOT_FOUND');
      answers.acceptRisk = storedFinding(GITHUB, 'github-token', { disposition: 'accepted-risk' });
      const accepted = await call('POST', `findings/${GITHUB}/accept-risk`);
      assert.equal(accepted.status, 201);
      assert.equal(accepted.body.finding.dispositionNarration, quasar.describeDisposition('accepted-risk'));
      assert.equal(calls[0][1].actor, 'alice');
      everyCallCarriesTheIdentity('accept-risk');
    }

    /* Failures go through the public error body: a coded error keeps its status and code, anything else is a 500 that says nothing. */
    {
      failing.set('getScan', Object.assign(new Error('Scan id is invalid'), { code: 'EXPOSURE_STORE_INVALID', status: 400 }));
      const coded = await call('GET', 'scans/s1');
      assert.equal(coded.status, 400);
      assert.equal(coded.body.code, 'EXPOSURE_STORE_INVALID');
      failing.set('getScan', new Error(`provider said ${PAT}`));
      const plain = await call('GET', 'scans/s1');
      assert.equal(plain.status, 500);
      assert.equal(plain.body.code, 'OPERATION_FAILED');
      assert(!plain.text.includes(PAT), 'a message is never echoed');
      failing.clear();
      /* Every route, its store failing with a message that must not be repeated. */
      const leak = new Error(`provider said ${PAT}`);
      for (const [method, tail, body, storeMethod] of [
        ['POST', 'scans', {}, 'requestScan'], ['GET', 'scans/s1', undefined, 'getScan'], ['GET', 'scans', undefined, 'listScans'],
        ['POST', 'clear', { confirm: 'clear-exposure-history' }, 'clearHistory'], ['POST', 'scans/s1/cancel', undefined, 'cancelScan'],
        ['GET', 'findings', undefined, 'listFindingsPage'], ['GET', 'scans/s1/observations', undefined, 'scanReportPage'],
        ['POST', `findings/${GITHUB}/verify`, { confirm: 'use-this-credential', authorized: true }, 'getFinding'],
        ['GET', `findings/${GITHUB}/verifications`, undefined, 'listVerifications'],
        ['POST', `findings/${ANON}/probe-readability`, { confirm: 'contact-this-project', authorized: true, relation: 'profiles', projection: ['id'] }, 'getFinding'],
        ['GET', `findings/${ANON}/readability-probes`, undefined, 'listReadabilityProbes'], ['POST', `findings/${GITHUB}/accept-risk`, undefined, 'acceptRisk']
      ]) {
        failing.set(storeMethod, leak);
        const failed = await call(method, tail, body);
        assert.equal(failed.status, 500, `${method} ${tail}`);
        assert.equal(failed.body.code, 'OPERATION_FAILED', `${method} ${tail}`);
        assert(!failed.text.includes(PAT), `${method} ${tail} never echoes a message`);
        failing.clear();
      }
      configured = false;
      const unconfigured = await call('GET', 'findings');
      assert.equal(unconfigured.status, 503);
      assert.equal(unconfigured.body.code, 'EXPOSURE_DATABASE_REQUIRED');
      configured = true;
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  console.log('quasar exposure routes tests passed');
})().catch(error => { console.error(error); process.exit(1); });
