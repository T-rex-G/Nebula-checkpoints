'use strict';
/*
 * A repository's governance, asked of the composed server.
 *
 * Governance -- a repository's policies, their drafts, versions and reviews,
 * the Digital Twin that shows them, and their life after activation -- is
 * Kepler's. The composition builds governance's host over the database,
 * attaches each request's governance context with one guard, and registers
 * Kepler's routes; Corona's read-only mode lets governance's own control plane
 * through and nothing else of it. These checks build the application the server
 * listens with, on a database of its own, and ask it as three people: the
 * repository's administrator, a maintainer and a reader, as GitHub says.
 */
const assert = require('node:assert/strict');
const { composedApplication, browser, standInForOutbound, bodyOf } = require('./helpers/composed-application');
const { disposableDatabase, watchOverlappingQueries } = require('./helpers/disposable-database');
const { identityKey } = require('../apps/api/src/modules/identity-access/index.ts');

const BASE = Object.freeze({ NODE_ENV: 'test', SESSION_SECRET: 's'.repeat(48), NV_GOVERNANCE_RUNTIME_FAILURE_MODE: 'warn' });
/* Three people, told apart by their tokens, and what GitHub says each may do. */
const PEOPLE = Object.freeze({
  octo: { token: `ghp_o${'z'.repeat(35)}`, id: 7, permission: 'admin', role: 'admin' },
  mae: { token: `ghp_m${'z'.repeat(35)}`, id: 8, permission: 'write', role: 'maintain' },
  rita: { token: `ghp_r${'z'.repeat(35)}`, id: 9, permission: 'read', role: 'read' }
});
const DOCUMENT = Object.freeze({ schemaVersion: 1, rules: [{ id: 'deny-reset', action: 'branch.reset', effect: 'deny' }] });

(async () => {
  const overlapping = watchOverlappingQueries();
  const database = await disposableDatabase('governance');
  const whoseToken = options => Object.keys(PEOPLE).find(login => String(new Headers(options.headers || {}).get('authorization')).includes(PEOPLE[login].token));
  const github = standInForOutbound([
    ['GET /user$', (href, options) => {
      const login = whoseToken(options);
      return { body: { login, id: PEOPLE[login].id, name: login }, headers: { 'x-oauth-scopes': 'repo' } };
    }],
    ['GET /repos/acme/demo/collaborators/\\w+/permission$', href => {
      const login = /collaborators\/(\w+)\//.exec(href)[1];
      return { body: { permission: PEOPLE[login].permission, role_name: PEOPLE[login].role, user: { login, id: PEOPLE[login].id } } };
    }],
    ['GET /repos/acme/demo$', { body: { full_name: 'acme/demo', default_branch: 'main', private: true, visibility: 'private', permissions: { admin: true } } }]
  ]);
  const application = await composedApplication({ ...BASE, DATABASE_URL: database.url });
  const client = await database.client();
  try {
    assert.equal(await application.core.ready(), true, 'the store is opened and migrated');
    const people = {};
    for (const [login, person] of Object.entries(PEOPLE)) {
      const page = browser(application);
      assert.equal((await page.signIn(person.token)).status, 200);
      people[login] = { page, csrf: await page.csrf(), key: identityKey({ provider: 'github', login, baseUrl: '' }) };
    }
    let writes = 0;
    const ask = (login, route, body, method = 'POST') => people[login].page.request(`/api/repo/acme/demo/governance${route}`, {
      method, body, headers: { 'x-nv-csrf': people[login].csrf, 'Idempotency-Key': `composition-governance-${++writes}` }
    });
    const read = (login, route) => people[login].page.request(`/api/repo/acme/demo/governance${route}`);
    const answer = async pending => {
      const response = await pending;
      return { status: response.status, body: await bodyOf(response) };
    };

    /*
     * ---- A repository's governance is the composed server's, behind one guard ----
     * Replaces the governance API contract's checks that the composition
     * loads governance through Kepler's index, builds its host over the
     * durable store, registers Kepler's governance and lifecycle routes, and
     * attaches one governance context that the routes read; and the
     * governance interface contract's that the Digital Twin reads that
     * context. The administrator creates a policy and drafts and submits a
     * version of it; every one of the three reads it; the Digital Twin shows
     * each person what GitHub's answer lets them do; and the policy, archived,
     * is listed as such.
     */
    const policy = await (async () => {
      const created = await answer(ask('octo', '/policies', { policyKey: 'release-safety', name: 'Release safety' }));
      assert.equal(created.status, 201, JSON.stringify(created.body));
      return created.body.policy;
    })();
    assert.equal(policy.policyKey, 'release-safety');
    const draft = await answer(ask('octo', `/policies/${policy.policyId}/drafts`, { document: DOCUMENT }));
    assert.equal(draft.status, 201, JSON.stringify(draft.body));
    const submitted = await answer(ask('octo', `/policies/${policy.policyId}/drafts/${draft.body.draft.draftId}/submit`, { expectedRevision: draft.body.draft.revision }));
    assert.equal(submitted.status, 201, JSON.stringify(submitted.body));
    const version = submitted.body.version;
    for (const login of Object.keys(PEOPLE)) {
      const listed = await answer(read(login, '/policies'));
      assert.deepEqual([listed.status, listed.body.policies.map(item => item.policyKey)], [200, ['release-safety']], `${login} reads the repository's policies`);
    }
    const capabilities = {};
    for (const login of Object.keys(PEOPLE)) {
      const twin = await answer(read(login, '/digital-twin'));
      assert.equal(twin.status, 200, JSON.stringify(twin.body));
      capabilities[login] = twin.body.access.capabilities;
    }
    assert.deepEqual(capabilities, {
      octo: { read: true, author: true, review: true, activate: true, administer: true },
      mae: { read: true, author: true, review: true, activate: false, administer: false },
      rita: { read: true, author: false, review: false, activate: false, administer: false }
    }, 'the Digital Twin shows each person what GitHub\'s answer lets them do');

    /*
     * ---- A body's claims are not taken ----
     * Replaces the governance API contract's checks that the composition
     * takes no governance roles, actor identity or reviewer identity from a
     * request's body. The reader's request to create a policy, claiming to be
     * the administrator, is refused as the reader's; the maintainer's claim
     * to review in the administrator's name is refused outright; asked in
     * their own name, the review is theirs.
     */
    {
      const claimed = await answer(ask('rita', '/policies', {
        policyKey: 'claimed', name: 'Claimed', governanceRoles: { administrator: true, author: true }, actorIdentityKey: people.octo.key
      }));
      assert.deepEqual([claimed.status, claimed.body.code], [403, 'GOVERNANCE_ROLE_REQUIRED'], 'a reader claiming the administrator\'s roles and identity is refused as a reader');
      assert.equal((await client.query("SELECT count(*)::int AS n FROM nv_governance_policy_decisions WHERE actor_login='rita'")).rows[0].n, 0,
        'by the governance guard, before the gateway is entered: the refused write leaves no policy decision behind');
      const reviewers = `/policies/${policy.policyId}/versions/${version.versionId}/reviewers/me`;
      const inTheirName = await answer(ask('mae', reviewers, { reviewerIdentityKey: people.octo.key }));
      assert.deepEqual([inTheirName.status, inTheirName.body.code], [400, 'GOVERNANCE_REVIEWER_IDENTITY_FORBIDDEN'], 'a review claimed in another\'s name is refused');
      const own = await answer(ask('mae', reviewers, {}));
      assert.equal(own.status, 201, JSON.stringify(own.body));
      const review = await answer(read('rita', `/policies/${policy.policyId}/versions/${version.versionId}/review`));
      assert.equal(review.status, 200, JSON.stringify(review.body));
      assert.equal(review.body.review.assignedCount, 1, 'one reviewer is assigned');
      const assigned = (await client.query('SELECT reviewer_login, reviewer_identity_key FROM nv_governance_review_assignments')).rows;
      assert.deepEqual(assigned, [{ reviewer_login: 'mae', reviewer_identity_key: people.mae.key }], 'and it is the maintainer who asked');
      assert.equal((await client.query("SELECT count(*)::int AS n FROM nv_governance_policies WHERE policy_key='claimed'")).rows[0].n, 0, 'and no policy is kept for the reader');
    }

    /*
     * ---- Read-only mode lets governance's own control plane through, and nothing else of it ----
     * Replaces the governance API contract's check that the composition gives
     * no route under /governance an exemption of its own. Governance changes
     * rows this server keeps, not the repository, so its control plane --
     * policies and their drafts, versions, reviews and lifecycle -- is let
     * through read-only mode; its webhooks are not part of it, and are
     * refused like any other write.
     */
    {
      const on = await answer(people.octo.page.request('/api/safety', { method: 'POST', body: { readOnly: true }, headers: { 'x-nv-csrf': people.octo.csrf } }));
      assert.deepEqual([on.status, on.body.readOnly], [200, true], 'the administrator turns read-only mode on');
      const validated = await answer(ask('octo', `/policies/${policy.policyId}/validate`, { document: DOCUMENT }));
      assert.equal(validated.status, 200, `a control-plane request is let through read-only mode: ${JSON.stringify(validated.body)}`);
      const webhook = await answer(ask('octo', '/webhooks', { name: 'Receiver', url: 'https://receiver.invalid/events', eventTypes: ['policy.activated'], enabled: true }));
      assert.equal(webhook.status, 423, `a governance webhook is refused in read-only mode: ${JSON.stringify(webhook.body)}`);
      assert.match(String(webhook.body.error), /Read-only mode is on/);
      const off = await answer(people.octo.page.request('/api/safety', { method: 'POST', body: { readOnly: false }, headers: { 'x-nv-csrf': people.octo.csrf } }));
      assert.deepEqual([off.status, off.body.readOnly], [200, false]);
    }

    /* The policy's life after activation is Kepler's lifecycle routes'. */
    {
      const current = await answer(read('octo', `/policies/${policy.policyId}`));
      assert.equal(current.status, 200, JSON.stringify(current.body));
      const archived = await answer(ask('octo', `/policies/${policy.policyId}/archive`, { expectedRevision: current.body.policy.revision, reason: 'Superseded by the organisation policy.' }));
      assert.equal(archived.status, 201, JSON.stringify(archived.body));
      const listed = await answer(read('rita', '/archive'));
      assert.deepEqual([listed.status, listed.body.policies.map(item => item.policyKey)], [200, ['release-safety']], 'an archived policy is listed as such');
    }
  } finally {
    await client.end();
    github.restore();
    await application.close();
    await database.drop();
  }
  /* A warning is emitted on the next turn; it has had one by now. */
  await new Promise(resolve => setImmediate(resolve));
  overlapping.stop();
  assert.deepEqual(overlapping.seen, [], 'no database client was handed a query while it was still running one');
  console.log('composition, governance: ok');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
