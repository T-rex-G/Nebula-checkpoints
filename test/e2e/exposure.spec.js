'use strict';

const { test, expect } = require('@playwright/test');
const { mockTask20Api, openRepository } = require('./task20-fixtures');

test.use({ serviceWorkers: 'block' });

/*
 * The exposure screen, and the one thing it must never do.
 *
 * A findings list that is empty reads as "nothing here, so nothing is wrong".
 * That reading is correct only when the scan read the whole tree, and a scan
 * stops short for perfectly ordinary reasons -- a ceiling, a truncated
 * listing, a file it could not decode. So the screen leads with what was
 * proven and with how much was actually read, and an empty list under partial
 * coverage says so in words rather than leaving the reader to infer it.
 *
 * These cases are built around that. Everything else here -- the credential
 * never reaching the DOM, the keyboard path, both themes, 320px -- protects it
 * from being true only on a developer's screen.
 */

const SECRET = `gh${'p'}_${'E'.repeat(36)}`;

function scan(overrides = {}) {
  return {
    scanId: '90000000-0000-4000-8000-000000000001',
    scope: { provider: 'github', authority: 'github.com', owner: 'acme', repo: 'demo' },
    requestedBy: 'alice',
    refName: 'refs/heads/main',
    commitSha: 'c'.repeat(40),
    rulesVersion: 1,
    engineVersion: 1,
    fingerprintKeyVersion: 1,
    configVersion: 1,
    state: 'complete',
    coverage: 'complete',
    skippedReason: null,
    filesScanned: 120,
    bytesScanned: 4096,
    parentScanId: null,
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    retainUntil: new Date(Date.now() + 86400000).toISOString(),
    ...overrides
  };
}

function finding(overrides = {}) {
  return {
    fingerprint: 'f'.repeat(64),
    fingerprintKeyVersion: 1,
    rulesVersion: 1,
    engineVersion: 1,
    rule: 'github-token',
    path: 'app/config.js',
    placeholder: '<github-token #1>',
    occurrences: [{ line: 4, column: 11 }],
    occurrenceCount: 1,
    truncated: false,
    scope: { provider: 'github', authority: 'github.com', owner: 'acme', repo: 'demo' },
    commit: 'c'.repeat(40),
    disposition: 'open',
    narration: {
      narrationVersion: 1,
      severity: 'critical',
      what: '<github-token #1> is a credential this scan recognised.',
      consequence: 'A GitHub access token is in the repository. Anyone who has it can act as the account that issued it.',
      action: 'Revoke the token in GitHub developer settings now.',
      where: 'In app/config.js, at line 4.'
    },
    ...overrides
  };
}

/*
 * An anonymous key, which is the finding the probe exists for. Its narration
 * is the one in the table that does not say "this is a leak", because it is
 * not one: the key is published on purpose and the question is what it can
 * reach.
 */
function anonKeyFinding(overrides = {}) {
  return finding({
    fingerprint: 'b'.repeat(64),
    rule: 'supabase-anon-key',
    path: 'src/supabase.js',
    placeholder: '<supabase-anon-key #1>',
    narration: {
      narrationVersion: 1,
      severity: 'warning',
      what: '<supabase-anon-key #1> is a credential this scan recognised.',
      consequence: 'A Supabase anonymous key is in the repository. That is normal -- it is meant to be public and it is in the browser bundle of every app that uses one. What it can actually read is decided by the row-level security policies on the project, and those are not visible from here.',
      action: 'Do not rotate it; that fixes nothing and breaks the app. Check what the anonymous role can read instead, which is what the readability check below asks the project directly.',
      where: 'In src/supabase.js, at line 4.'
    },
    ...overrides
  });
}

async function mockExposure(page, { findings = [], scanState = null, acceptStatus = 201, probe = null, probeStatus = 201, verifications = {}, probes = {} } = {}) {
  const state = { requests: [], verifyBodies: [], scanBodies: [], acceptCalls: [], probeBodies: [],
    currentScan: scanState || scan({ state: 'queued', coverage: 'unknown', finishedAt: null }),
    currentFindings: findings, scanError: null, statusError: false };
  await mockTask20Api(page);
  await page.route('**/api/repo/acme/demo/exposure/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    state.requests.push(`${request.method()} ${url.pathname}`);
    if (url.pathname.endsWith('/exposure/findings')) {
      return route.fulfill({ json: { findings: state.currentFindings, verifications, probes } });
    }
    if (url.pathname.endsWith('/exposure/scans') && request.method() === 'POST') {
      state.scanBodies.push(request.postDataJSON());
      if (state.scanError) return route.fulfill({ status: 502, json: { code: state.scanError, error: 'Private upstream detail' } });
      return route.fulfill({ status: 201, json: { scan: state.currentScan, created: true } });
    }
    if (/\/exposure\/scans\/[^/]+$/.test(url.pathname) && request.method() === 'GET') {
      if (state.statusError) return route.fulfill({ status: 502, json: { error: 'Status unavailable' } });
      return route.fulfill({ json: { scan: state.currentScan } });
    }
    if (url.pathname.endsWith('/cancel')) {
      return route.fulfill({ status: 201, json: { scan: scan({ state: 'canceled', coverage: 'partial', skippedReason: 'canceled' }) } });
    }
    if (url.pathname.endsWith('/probe-readability') && request.method() === 'POST') {
      state.probeBodies.push(request.postDataJSON());
      if (probeStatus !== 201) {
        return route.fulfill({
          status: probeStatus,
          json: { error: 'No project reference was found beside that key', code: 'EXPOSURE_PROBE_NO_PROJECT' }
        });
      }
      return route.fulfill({
        status: 201,
        json: {
          probe: {
            probeId: 'p-1', fingerprint: 'b'.repeat(64),
            state: 'readable', reason: 'rows-visible',
            projectRef: 'q'.repeat(20), relation: 'profiles', projection: ['id', 'email'],
            testedRole: 'anon', rowCount: 1,
            observedAt: new Date().toISOString(),
            freshnessDeadline: new Date(Date.now() + 3600000).toISOString(),
            ...(probe || {})
          },
          narration: (probe && probe.narration)
            || 'The anonymous role read a row from that table, so anyone with the published key can read it too.'
        }
      });
    }
    if (url.pathname.endsWith('/accept-risk') && request.method() === 'POST') {
      state.acceptCalls.push(url.pathname);
      if (acceptStatus !== 201) {
        return route.fulfill({
          status: acceptStatus,
          json: { error: 'The administrator governance role is required', code: 'GOVERNANCE_ROLE_REQUIRED' }
        });
      }
      return route.fulfill({
        status: 201,
        json: {
          finding: finding({
            disposition: 'accepted-risk',
            dispositionBy: 'alice',
            dispositionAt: new Date().toISOString(),
            dispositionNarration: 'Somebody reviewed this finding and accepted the risk. It is recorded against their name and the credential is still in the repository.'
          })
        }
      });
    }
    if (url.pathname.endsWith('/verify') && request.method() === 'POST') {
      state.verifyBodies.push(request.postDataJSON());
      return route.fulfill({
        status: 201,
        json: {
          verification: {
            verificationId: 'v-1', fingerprint: 'f'.repeat(64), state: 'verified',
            reason: 'identity-confirmed', adapter: 'github-user-token',
            observedAt: new Date().toISOString(),
            freshnessDeadline: new Date(Date.now() + 86400000).toISOString()
          },
          finding: null,
          narration: 'The provider identified the account this credential belongs to, which means it is live.'
        }
      });
    }
    return route.fulfill({ status: 404, json: { error: 'Not found' } });
  });
  return state;
}

/*
 * Both navigations, because they are different on purpose. A phone has no tab
 * strip -- it reaches destinations through the More sheet -- so a destination
 * that exists only as a tab is a destination a phone cannot reach at all.
 * This helper takes whichever path the viewport actually offers, which means
 * these cases fail if either one is missing.
 */
async function openExposure(page) {
  await openRepository(page);
  const tab = page.locator('.tab[data-tab="exposure"]');
  if (await tab.isVisible().catch(() => false)) {
    await tab.click();
  } else {
    await page.locator('#bottomNav button[data-nav="more"]').click();
    await page.locator('.sheet-item[data-act="exposure"]').click();
  }
  await page.locator('#tab-exposure.active').waitFor();
}

test('the screen is reachable on a phone as well as a desktop', async ({ page }) => {
  /*
   * Named explicitly because it is the failure this spec caught: the screen
   * existed as a tab, the tab strip is hidden at phone width, and the whole
   * destination was unreachable on the device this product is most used on.
   */
  await mockExposure(page, { findings: [finding()] });
  await openRepository(page);

  const tabVisible = await page.locator('.tab[data-tab="exposure"]').isVisible().catch(() => false);
  const sheetEntry = page.locator('.sheet-item[data-act="exposure"]');
  await expect(sheetEntry).toHaveCount(1, { timeout: 5000 });
  if (!tabVisible) {
    await page.locator('#bottomNav button[data-nav="more"]').click();
    await expect(sheetEntry).toBeVisible();
  }
});

test('the screen leads with what was proven, not with a list', async ({ page }) => {
  await mockExposure(page, { findings: [finding()] });
  await openExposure(page);

  const proof = page.locator('#exposureProofLine');
  await expect(proof).toBeVisible();
  /* The item, not the list: an empty `ul` has no height and is correctly
     reported hidden, which would make this assertion about layout rather
     than about the screen saying anything. */
  await expect(page.locator('.exposure-item').first()).toBeVisible();

  /* The proof sits above the list in the document, which is the order a
     screen reader and a keyboard both take it in. */
  const order = await page.evaluate(() => {
    const proofEl = document.querySelector('#exposureProofLine');
    const listEl = document.querySelector('#exposureList');
    return proofEl.compareDocumentPosition(listEl) & Node.DOCUMENT_POSITION_FOLLOWING ? 'proof-first' : 'list-first';
  });
  expect(order).toBe('proof-first');
});

test('an empty list under partial coverage is not an all-clear', async ({ page }) => {
  await mockExposure(page, {
    findings: [],
    scanState: scan({ state: 'partial', coverage: 'partial', skippedReason: 'file-count-limit' })
  });
  await openExposure(page);

  /*
   * The scan comes back partial, the way the server reports one that hit a
   * ceiling. Driven through the request rather than by reaching into the
   * page, so what is tested is the screen's reading of a server answer.
   */
  await page.getByRole('button', { name: /Scan this branch/i }).click();
  await expect(page.locator('#exposureCoverage')).toHaveAttribute('data-coverage', 'partial');

  const empty = page.locator('#exposureEmpty');
  await expect(empty).toBeVisible();
  /*
   * The sentence, not merely the absence of a green tick. A reader who sees
   * "no credentials were found" and nothing else will conclude the repository
   * is clean, and a partial scan does not support that.
   */
  await expect(empty).not.toHaveText(/^No credentials were found in the tree this scan read\.$/);
});

test('a scan in progress never shows a settled state', async ({ page }) => {
  const state = await mockExposure(page, { findings: [] });
  await openExposure(page);
  await page.getByRole('button', { name: /Scan this branch/i }).click();

  /*
   * The request body is a parsed object carrying the branch. `api` serialises
   * for the caller, so a call site that stringifies as well sends a JSON
   * string -- which the server parses to a string, reads no `ref` from, and
   * silently scans the default branch instead of the one on screen.
   */
  await expect.poll(() => state.scanBodies.length).toBe(1);
  expect(typeof state.scanBodies[0]).toBe('object');
  expect(state.scanBodies[0]).toHaveProperty('ref');

  await expect(page.locator('#exposureState')).toHaveAttribute('data-state', /queued|running/);
  await expect(page.locator('#exposureProofLine')).toContainText(/Nothing is proven until it finishes/i);
  /* And the cancel control appears, because a scan in progress is the only
     time there is something to cancel. */
  await expect(page.getByRole('button', { name: /Cancel scan/i })).toBeVisible();
});

test('a requested scan progresses to completion and loads its findings', async ({ page }) => {
  const state = await mockExposure(page);
  await openExposure(page);
  await page.locator('#exposureScanBtn').click();
  await expect(page.locator('#exposureState')).toHaveText('Queued');
  state.currentScan = scan({ state: 'running', coverage: 'unknown', filesScanned: 10 });
  await expect(page.locator('#exposureState')).toHaveText('Running');
  state.currentScan = scan();
  state.currentFindings = [finding()];
  await expect(page.locator('#exposureState')).toHaveText('Complete');
  await expect(page.locator('.exposure-item')).toHaveCount(1);
  await expect(page.locator('#exposureFiles')).toHaveText('120');
  await expect(page.locator('#exposureScanBtn')).toBeEnabled();
  await expect(page.locator('#exposureCancelBtn')).toBeHidden();
  expect(state.scanBodies).toHaveLength(1);
});

test('failed scan startup explains a next step without provider details', async ({ page }) => {
  const state = await mockExposure(page);
  state.scanError = 'EXPOSURE_READ_FAILED';
  await openExposure(page);
  await page.locator('#exposureScanBtn').click();
  await expect(page.locator('#exposureProofLine')).toContainText('Try again shortly');
  await expect(page.locator('#exposureProofLine')).not.toContainText('Private upstream detail');
  await expect(page.locator('#exposureState')).toHaveText('Not started');
  await expect(page.locator('#exposureScanBtn')).toBeEnabled();
});

test('a failed status read can be retried without requesting another scan', async ({ page }) => {
  const state = await mockExposure(page);
  state.statusError = true;
  await openExposure(page);
  await page.locator('#exposureScanBtn').click();
  await expect(page.locator('#exposureRefreshBtn')).toBeVisible();
  state.statusError = false;
  state.currentScan = scan();
  await page.locator('#exposureRefreshBtn').click();
  await expect(page.locator('#exposureState')).toHaveText('Complete');
  await expect(page.locator('#exposureRefreshBtn')).toBeHidden();
  expect(state.scanBodies).toHaveLength(1);
});

test('a late status response cannot restore a cleared repository scan', async ({ page }) => {
  await mockExposure(page);
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  await page.route('**/exposure/scans/90000000-0000-4000-8000-000000000001', async route => {
    await delayed;
    await route.fulfill({ json: { scan: scan() } });
  });
  await openExposure(page);
  await page.locator('#exposureScanBtn').click();
  await page.waitForRequest(request => request.method() === 'GET' && /\/exposure\/scans\//.test(request.url()));
  await page.evaluate(() => window.clearExposureState());
  const response = page.waitForResponse(url => /\/exposure\/scans\//.test(url.url()));
  release();
  await response;
  await expect(page.locator('#exposureState')).toHaveText('Not started');
  await expect(page.locator('.exposure-item')).toHaveCount(0);
});

test('checking whether a credential is live takes two deliberate presses', async ({ page }) => {
  /*
   * The property this whole route exists to protect. One press must not send
   * somebody's leaked credential to a third party, however clear the label is,
   * and the second press is the one that does.
   */
  const state = await mockExposure(page, { findings: [finding()] });
  await openExposure(page);

  const verify = page.locator('.exposure-verify').first();
  await expect(verify).toHaveText(/Check whether it still works/i);

  await verify.click();
  expect(state.verifyBodies).toHaveLength(0);
  /* The armed control says what the next press does, rather than asking
     whether the reader is sure. */
  await expect(verify).toHaveText(/Send this credential to the provider/i);
  await expect(page.locator('.exposure-item-warning')).toContainText(/issuing service/i);
  await expect(page.locator('.exposure-item-warning')).toContainText(/own this credential or have explicit permission/i);

  await verify.click();
  await expect(page.locator('.exposure-item-liveness')).toBeVisible();
  expect(state.verifyBodies).toHaveLength(1);
  /* And the confirmation the server demands actually travels. */
  expect(state.verifyBodies[0]).toEqual({ confirm: 'use-this-credential', authorized: true });
});

test('a live credential is reported without becoming the finding status', async ({ page }) => {
  await mockExposure(page, { findings: [finding()] });
  await openExposure(page);

  await page.locator('.exposure-verify').first().click();
  await page.locator('.exposure-verify').first().click();

  const liveness = page.locator('.exposure-item-liveness');
  await expect(liveness).toHaveAttribute('data-state', 'verified');
  await expect(liveness).toContainText(/live/i);
  /*
   * The disposition is what this repository decided; the verification is what
   * the provider reported. A live credential leaves the finding open, and the
   * two lines stay separate so a reader is never asked to infer one from the
   * other.
   */
  await expect(page.locator('.exposure-item-disposition')).toContainText(/open/i);
});

test('arming one finding does not arm another', async ({ page }) => {
  const second = finding({
    fingerprint: 'a'.repeat(64), path: 'lib/other.js',
    placeholder: '<github-token #2>',
    narration: { ...finding().narration, what: '<github-token #2> is a credential this scan recognised.' }
  });
  const state = await mockExposure(page, { findings: [finding(), second] });
  await openExposure(page);

  const buttons = page.locator('.exposure-verify');
  await expect(buttons).toHaveCount(2);
  await buttons.nth(0).click();
  await expect(buttons.nth(0)).toHaveText(/Send this credential/i);
  await expect(buttons.nth(1)).toHaveText(/Check whether it still works/i);

  /* Arming the second disarms the first, so a press cannot land on a finding
     the reader stopped looking at. */
  await buttons.nth(1).click();
  await expect(buttons.nth(0)).toHaveText(/Check whether it still works/i);
  expect(state.verifyBodies).toHaveLength(0);
});

test('accepting an intended exposure takes two presses and says whose name is on it', async ({ page }) => {
  /*
   * The other half of triage. Without this a reader looking at a screen of
   * findings they know are intended -- a fixture's sample key, a credential
   * revoked before anyone looked -- has one move left, which is to stop
   * reading the screen.
   *
   * It must not read as a dismissal. The finding stays, the sentence under it
   * says the credential is still in the repository, and the name is visible.
   */
  const state = await mockExposure(page, { findings: [finding()] });
  await openExposure(page);

  const accept = page.locator('.exposure-accept').first();
  await expect(accept).toHaveText(/This one is intended/i);

  await accept.click();
  expect(state.acceptCalls).toHaveLength(0);
  await expect(accept).toHaveText(/Record me as accepting this exposure/i);
  /* The question names the cost rather than asking whether the reader is
     sure, and it says the decision does not undo itself. */
  await expect(page.locator('.exposure-item-warning')).toContainText(/stays in the repository/i);
  await expect(page.locator('.exposure-item-warning')).toContainText(/nothing here undoes the decision/i);

  await accept.click();

  const item = page.locator('.exposure-item').first();
  await expect(item).toHaveAttribute('data-disposition', 'accepted-risk');
  expect(state.acceptCalls).toHaveLength(1);
  await expect(page.locator('.exposure-item-provenance')).toContainText(/Accepted by alice/i);
  /* An accepted finding is still a finding: it keeps its consequence and it
     says the credential has not gone anywhere. */
  await expect(page.locator('.exposure-item-disposition')).toContainText(/still in the repository/i);
  await expect(page.locator('.exposure-item-consequence')).toContainText(/act as the account/i);
  /* And it stops offering the two actions, because it is no longer open. */
  await expect(page.locator('.exposure-accept')).toHaveCount(0);
  await expect(page.locator('.exposure-verify')).toHaveCount(0);
});

test('only one control is armed at a time', async ({ page }) => {
  /*
   * Two armed buttons on one screen make the next click ambiguous, and one of
   * these two clicks sends a credential to a third party while the other is
   * irreversible. Arming either disarms the other.
   */
  const state = await mockExposure(page, { findings: [finding()] });
  await openExposure(page);

  const verify = page.locator('.exposure-verify').first();
  const accept = page.locator('.exposure-accept').first();

  await verify.click();
  await expect(verify).toHaveText(/Send this credential to the provider/i);

  await accept.click();
  await expect(verify).toHaveText(/Check whether it still works/i);
  await expect(accept).toHaveText(/Record me as accepting/i);

  await verify.click();
  await expect(accept).toHaveText(/This one is intended/i);

  /* Nothing was sent and nothing was accepted by any of that re-arming. */
  expect(state.verifyBodies).toHaveLength(0);
  expect(state.acceptCalls).toHaveLength(0);
});

test('a refusal to accept says it is the role, not that something went wrong', async ({ page }) => {
  /*
   * Who may accept an exposure is a role the server holds, and the reader
   * whose press was refused can do something about "you need an
   * administrator" and nothing at all about "that did not work".
   */
  await mockExposure(page, { findings: [finding()], acceptStatus: 403 });
  await openExposure(page);

  const accept = page.locator('.exposure-accept').first();
  await accept.click();
  await accept.click();

  await expect(page.locator('#exposureProofLine')).toContainText(/governance administrator/i);
  /* The finding is unchanged: a refused acceptance must not look accepted. */
  await expect(page.locator('.exposure-item').first()).toHaveAttribute('data-disposition', 'open');
  await expect(page.locator('.exposure-item-provenance')).toHaveCount(0);
});

test('an anonymous key is not reported as a leak, and asks the question instead', async ({ page }) => {
  /*
   * The mistake this whole rule exists to avoid. An anonymous key is in the
   * browser bundle of every app that uses one, so reporting it as a critical
   * leak makes every project a wall of red and teaches readers to scroll past
   * the screen. What it needs is not a rotation, it is a question.
   */
  const state = await mockExposure(page, { findings: [anonKeyFinding()] });
  await openExposure(page);

  const item = page.locator('.exposure-item').first();
  await expect(item).toHaveAttribute('data-severity', 'warning');
  await expect(item).toContainText(/meant to be public/i);
  await expect(item).toContainText(/Do not rotate it/i);

  /* The form asks for the two things this server will not invent. */
  const form = page.locator('.exposure-probe-form');
  await expect(form).toBeVisible();
  await expect(form.locator('.exposure-probe-input[data-field="relation"]')).toBeVisible();
  await expect(form.locator('.exposure-probe-input[data-field="columns"]')).toBeVisible();

  /* A press with nothing typed is a mis-click, not a question. */
  await page.locator('.exposure-probe').click();
  expect(state.probeBodies).toHaveLength(0);
  await expect(page.locator('#exposureLive')).toContainText(/Name a table/i);
});

test('asking a project takes two presses and carries the question that was typed', async ({ page }) => {
  const state = await mockExposure(page, { findings: [anonKeyFinding()] });
  await openExposure(page);

  await page.locator('.exposure-probe-input[data-field="relation"]').fill('profiles');
  await page.locator('.exposure-probe-input[data-field="columns"]').fill('id, email');

  const ask = page.locator('.exposure-probe');
  await ask.click();
  expect(state.probeBodies).toHaveLength(0);
  await expect(ask).toHaveText(/Ask this project now/i);
  await expect(page.locator('.exposure-item-warning')).toContainText(/single row/i);
  await expect(page.locator('.exposure-item-warning')).toContainText(/own this project or have explicit permission/i);
  /* The typed question survives the re-render that arming causes. */
  await expect(page.locator('.exposure-probe-input[data-field="relation"]')).toHaveValue('profiles');

  await ask.click();
  const answer = page.locator('.exposure-item-readability');
  await expect(answer).toBeVisible();
  await expect(answer).toHaveAttribute('data-state', 'readable');
  expect(state.probeBodies).toHaveLength(1);
  expect(state.probeBodies[0]).toEqual({
    confirm: 'contact-this-project', authorized: true, relation: 'profiles', projection: ['id', 'email']
  });

  /* The answer carries the question, because "readable" means nothing without
     it, and it does not become the finding's status. */
  await expect(answer).toContainText(/profiles/);
  await expect(answer).toContainText(/id, email/);
  await expect(page.locator('.exposure-item').first()).toHaveAttribute('data-disposition', 'open');
});

test('a denied answer is not shown as an all-clear', async ({ page }) => {
  /*
   * A 403 on two columns of one table under one role is evidence about that
   * request. A reader told "protected" would stop looking, so the answer says
   * what it actually establishes.
   */
  await mockExposure(page, {
    findings: [anonKeyFinding()],
    probe: {
      state: 'denied', reason: 'access-denied-for-tested-request', rowCount: 0,
      narration: 'That exact request was refused. This is evidence about this request only, not about the table or about the project.'
    }
  });
  await openExposure(page);

  await page.locator('.exposure-probe-input[data-field="relation"]').fill('profiles');
  await page.locator('.exposure-probe-input[data-field="columns"]').fill('id');
  await page.locator('.exposure-probe').click();
  await page.locator('.exposure-probe').click();

  const answer = page.locator('.exposure-item-readability');
  await expect(answer).toHaveAttribute('data-state', 'denied');
  await expect(answer).toContainText(/this request only/i);
  await expect(answer).not.toContainText(/protected|secure|safe/i);
});

test('a service-role key gets no probe form at all', async ({ page }) => {
  /*
   * Same shape, opposite finding. It bypasses every policy, so a readable
   * answer would come back whatever the project permits -- and would have used
   * an administrator credential to produce it.
   */
  await mockExposure(page, {
    findings: [anonKeyFinding({
      fingerprint: 'c'.repeat(64),
      rule: 'supabase-service-role-key',
      placeholder: '<supabase-service-role-key #1>',
      narration: {
        narrationVersion: 1, severity: 'critical',
        what: '<supabase-service-role-key #1> is a credential this scan recognised.',
        consequence: 'A Supabase service-role key is in the repository. It bypasses row-level security completely.',
        action: 'Rotate the service-role key in the project API settings now.',
        where: 'In src/supabase.js, at line 9.'
      }
    })]
  });
  await openExposure(page);

  await expect(page.locator('.exposure-item').first()).toHaveAttribute('data-severity', 'critical');
  await expect(page.locator('.exposure-probe-form')).toHaveCount(0);
  /* It is still a credential, so it can still be checked and triaged. */
  await expect(page.locator('.exposure-verify')).toHaveCount(1);
  await expect(page.locator('.exposure-accept')).toHaveCount(1);
});

test('a file with no project to ask says so, rather than failing vaguely', async ({ page }) => {
  await mockExposure(page, { findings: [anonKeyFinding()], probeStatus: 409 });
  await openExposure(page);

  await page.locator('.exposure-probe-input[data-field="relation"]').fill('profiles');
  await page.locator('.exposure-probe-input[data-field="columns"]').fill('id');
  await page.locator('.exposure-probe').click();
  await page.locator('.exposure-probe').click();

  await expect(page.locator('#exposureProofLine')).toContainText(/no project reference/i);
  await expect(page.locator('.exposure-item-readability')).toHaveCount(0);
});

test('answers already on record are on the screen before anything is pressed', async ({ page }) => {
  /*
   * A screen that showed only what was asked in this session would forget, and
   * re-asking to redisplay a fact would mean using somebody's credential a
   * second time to learn nothing new. Both answers arrive with the list.
   */
  const state = await mockExposure(page, {
    findings: [finding(), anonKeyFinding()],
    verifications: {
      ['f'.repeat(64)]: {
        verificationId: 'v-old', fingerprint: 'f'.repeat(64), state: 'verified',
        reason: 'identity-confirmed', adapter: 'github-user-token',
        observedAt: new Date(Date.now() - 86400000).toISOString(),
        freshnessDeadline: new Date(Date.now() - 3600000).toISOString(),
        narration: 'The provider identified the account this credential belongs to, which means it is live.'
      }
    },
    probes: {
      ['b'.repeat(64)]: {
        probeId: 'p-old', fingerprint: 'b'.repeat(64), state: 'readable',
        reason: 'rows-visible', projectRef: 'q'.repeat(20),
        relation: 'profiles', projection: ['id', 'email'],
        testedRole: 'anon', rowCount: 1,
        observedAt: new Date(Date.now() - 604800000).toISOString(),
        freshnessDeadline: new Date(Date.now() - 600000).toISOString(),
        narration: 'The anonymous role read a row from that table, so anyone with the published key can read it too.'
      }
    }
  });
  await openExposure(page);

  await expect(page.locator('.exposure-item-liveness')).toHaveAttribute('data-state', 'verified');
  const readability = page.locator('.exposure-item-readability');
  await expect(readability).toHaveAttribute('data-state', 'readable');
  await expect(readability).toContainText(/profiles/);

  /* Nothing was re-asked to put them there. */
  expect(state.verifyBodies).toHaveLength(0);
  expect(state.probeBodies).toHaveLength(0);
});

test('no credential reaches the DOM, the storage or a copy of the page', async ({ page }) => {
  /*
   * The server never sends one. This asserts the screen does not reconstruct
   * one either -- from a path, a placeholder, or anything it caches.
   */
  await mockExposure(page, {
    findings: [finding({
      path: `secrets/${SECRET}.js`,
      narration: { ...finding().narration, where: 'In secrets/ (a file whose name is not shown, because it is itself credential-shaped).' }
    })]
  });
  await openExposure(page);
  await expect(page.locator('.exposure-item').first()).toBeVisible();

  const leaked = await page.evaluate(secret => {
    const surfaces = [document.documentElement.outerHTML];
    try { surfaces.push(JSON.stringify(window.localStorage)); } catch { /* blocked storage is fine */ }
    try { surfaces.push(JSON.stringify(window.sessionStorage)); } catch { /* blocked storage is fine */ }
    try { surfaces.push(JSON.stringify(window.state && window.state.exposure)); } catch { /* not exposed is fine */ }
    return surfaces.filter(Boolean).some(surface => surface.includes(secret));
  }, SECRET);
  expect(leaked).toBe(false);
});

test('provider text is inserted as text, never as markup', async ({ page }) => {
  /*
   * A path is bytes a repository chose. One that contains markup must render
   * as the characters it is -- an element created from it would be a
   * repository choosing what this page contains.
   */
  await mockExposure(page, {
    findings: [finding({
      narration: { ...finding().narration, where: 'In <img src=x onerror="window.__xss=1"> at line 4.' }
    })]
  });
  await openExposure(page);
  await expect(page.locator('.exposure-item-where').first()).toContainText('<img');
  expect(await page.evaluate(() => Boolean(window.__xss))).toBe(false);
  expect(await page.locator('.exposure-item-where img').count()).toBe(0);
});

test('the screen is operable from the keyboard and announces changes', async ({ page }) => {
  await mockExposure(page, { findings: [finding()] });
  await openExposure(page);

  const live = page.locator('#exposureLive');
  await expect(live).toHaveAttribute('role', 'status');
  await expect(live).toHaveAttribute('aria-live', 'polite');

  const scanButton = page.getByRole('button', { name: /Scan this branch/i });
  await scanButton.focus();
  await expect(scanButton).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(live).toHaveText(/Scan requested/i, { timeout: 5000 });
});

test('both themes and a 320px screen keep it readable', async ({ page }) => {
  await mockExposure(page, { findings: [finding()] });
  await openExposure(page);

  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
    const contrast = await page.evaluate(() => {
      const item = document.querySelector('.exposure-item-consequence');
      const style = getComputedStyle(item);
      return { color: style.color, background: getComputedStyle(document.body).backgroundColor };
    });
    expect(contrast.color).not.toBe(contrast.background);
  }

  await page.setViewportSize({ width: 320, height: 720 });
  const overflow = await page.evaluate(() => {
    const shell = document.querySelector('.exposure-shell');
    return { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, shellWidth: shell.getBoundingClientRect().width };
  });
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
  expect(overflow.shellWidth).toBeLessThanOrEqual(320);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
    for (const selector of ['.exposure-proof', '.exposure-findings']) {
      const bounds = await page.locator(selector).evaluate(card => {
        const rect = card.getBoundingClientRect();
        const title = card.querySelector('h2').getBoundingClientRect();
        return { inset: title.left - rect.left, rightInset: rect.right - title.right,
          padding: parseFloat(getComputedStyle(card).paddingTop) };
      });
      expect(bounds.inset).toBeGreaterThanOrEqual(16);
      expect(bounds.rightInset).toBeGreaterThanOrEqual(16);
      expect(bounds.padding).toBeGreaterThanOrEqual(16);
    }
    const button = page.locator('#exposureScanBtn');
    await button.scrollIntoViewIfNeeded();
    expect((await button.boundingBox()).height).toBeGreaterThanOrEqual(44);
    await expect(page.locator('.exposure-intro')).toContainText('Hosted app URL scanning is not available yet');
    await page.screenshot({ path: test.info().outputPath(`exposure-320-${theme}.png`), fullPage: true });
  }
});

test('switching repository does not leave the previous findings on screen', async ({ page }) => {
  await mockExposure(page, { findings: [finding()] });
  await openExposure(page);
  await expect(page.locator('.exposure-item')).toHaveCount(1);

  await page.evaluate(() => window.clearExposureState());
  /*
   * Whether or not the helper is reachable from here, the guarantee is that
   * findings belong to one repository and one identity: leaving them up after
   * a switch would show somebody another repository's exposures.
   */
  const stale = await page.evaluate(() => document.querySelectorAll('.exposure-item').length);
  expect(stale).toBe(0);
});
