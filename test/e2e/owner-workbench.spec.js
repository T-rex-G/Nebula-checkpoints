'use strict';

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');
const { projectCapabilities } = require('../../src/capability-registry');
const { workspaceCapabilities } = require('../../src/workspace-workbench');
const capabilityDocument = require('../../config/public-alpha-capabilities.json');
test.use({ serviceWorkers: 'block' });

async function fixture(page, { uncertain = false } = {}) {
  await mockPublicAlphaApi(page, { access: 'required' });
  const context = { role: 'owner', principalId: 'p1', workspaceId: 'w1',
    connection: { id: 'c1', provider: 'github', instance: 'https://github.com', providerUserId: '99', login: 'owner' } };
  let created = false, head = 'a'.repeat(40), text = '# Owner repository\n';
  const writes = [], requests = [];
  const repo = () => ({ full_name: 'owner/demo', name: 'demo', owner: 'owner', private: true,
    default_branch: 'main', stars: 0, forks: 0, pushed_at: '2026-09-01T00:00:00Z' });
  await page.route('**/api/workspace/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname.replace('/api/workspace', '');
    requests.push(path);
    const reply = (body, status = 200) => route.fulfill({ status, json: body, headers: { 'cache-control': 'no-store' } });
    if (path === '/session') return reply({ authenticated: true, csrfToken: 'owner-csrf', context });
    if (path === '/connections') return reply({ connections: [{ ...context.connection, selected: true, credentialStored: true }] });
    expect(request.headers()['x-nv-workspace']).toBe('w1');
    expect(request.headers()['x-nv-connection']).toBe('c1');
    if (request.method() !== 'GET') {
      expect(request.headers()['x-nv-csrf']).toBe('owner-csrf');
      writes.push({ path, body: request.postDataJSON() });
    }
    if (path === '/workbench/me') return reply({ authorityKind: 'workspace', principalId: 'p1', workspaceId: 'w1', connectionId: 'c1',
      provider: 'github', authority: 'github.com', login: 'owner', avatar: '', caps: { prs: false, issues: false, releases: false, lfs: false, batch: false } });
    if (path === '/workbench/safety') return reply({ readOnly: false, freezeSync: false, protected: {} });
    if (path === '/workbench/capabilities') return reply(workspaceCapabilities(projectCapabilities(capabilityDocument,
      { provider: 'github', authority: 'github.com', deployment: 'hosted-alpha' })));
    if (path === '/workbench/repos' && request.method() === 'POST') { created = true; return reply({ ...repo(), verified: true }, 201); }
    if (path === '/workbench/repos') return reply(created ? [repo()] : []);
    if (path === '/workbench/repo/owner/demo') return reply({ ...repo(), branches: [{ name: 'main', sha: head, protected: false }] });
    if (path === '/workbench/repo/owner/demo/tree') return reply([{ type: 'file', name: 'README.md', path: 'README.md', sha: 'b'.repeat(40), size: text.length }]);
    if (path === '/workbench/repo/owner/demo/file' && request.method() === 'PUT') {
      expect(request.postDataJSON().expectedHeadSha).toBe(head);
      text = request.postDataJSON().content; head = 'c'.repeat(40);
      if (uncertain) return route.abort('failed');
      return reply({ ok: true, sha: 'd'.repeat(40), commit: head, verified: true });
    }
    if (path === '/workbench/repo/owner/demo/file') return reply({ path: 'README.md', name: 'README.md', sha: 'b'.repeat(40), size: text.length,
      encoding: 'base64', content: Buffer.from(text).toString('base64') });
    return reply({ code: 'WORKSPACE_ROUTE_NOT_FOUND', error: 'This owner action is unavailable.' }, 404);
  });
  const cohortOperations = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (/^\/api\/(?:repo\/|repos$|me$|safety$|accounts|security\/csrf|login|logout)/.test(path)) cohortOperations.push(path);
  });
  await page.goto('/');
  await expect(page.locator('#page-alpha-access.active')).toBeVisible();
  await page.locator('#workspaceGitPanel summary').click();
  await expect(page.locator('#workspaceGitConnections')).toContainText('token stored');
  await page.getByRole('button', { name: 'Open owner workbench', exact: true }).click();
  await expect(page.locator('#page-repos.active')).toBeVisible();
  await page.locator('#newRepoBtn').click();
  await page.locator('#nrName').fill('demo');
  await page.locator('#modalOk').click();
  await page.getByRole('button', { name: 'Open repository owner/demo', exact: true }).click();
  await expect(page.locator('#page-work.active')).toBeVisible();
  await page.locator('#tree').getByText('README.md', { exact: true }).click();
  await expect(page.locator('.CodeMirror')).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.querySelector('.CodeMirror').CodeMirror.getValue())).toBe(text);
  return { writes, requests, cohortOperations };
}

test('owner creates, opens and commits in the existing workbench without a cohort session', async ({ page }) => {
  const f = await fixture(page);
  await page.evaluate(() => document.querySelector('.CodeMirror').CodeMirror.setValue('# Verified owner edit\n'));
  await page.locator('#commitFileBtn').click();
  await page.locator('#modalOk').click();
  await expect(page.locator('#commitFileBtn')).toBeDisabled();
  expect(f.writes.map(x => x.path)).toEqual(['/workbench/repos', '/workbench/repo/owner/demo/file']);
  expect(f.writes[1].body.content).toBe('# Verified owner edit\n');
  expect(f.cohortOperations).toEqual([]);
  expect(await page.evaluate(() => sessionStorage.getItem('nv_me'))).toBeNull();
  expect(await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('nv_draft:') || k.startsWith('nv_recent:')))).toEqual([]);
  await expect(page.locator('#page-work').getByRole('button', { name: 'Owner connections', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

test('an uncertain owner commit is never put in the offline replay queue', async ({ page }) => {
  const f = await fixture(page, { uncertain: true });
  await page.evaluate(() => document.querySelector('.CodeMirror').CodeMirror.setValue('# Interrupted owner edit\n'));
  await page.locator('#commitFileBtn').click();
  await page.locator('#modalOk').click();
  await expect(page.locator('#trustErrorBackdrop')).toContainText(/may have completed/i);
  await expect(page.locator('#trustErrorTitle')).toHaveText('The action could not be confirmed');
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  const queued = await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('nebulaverse', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    if (!db.objectStoreNames.contains('queue')) { db.close(); return 0; }
    const count = await new Promise(resolve => { const r = db.transaction('queue').objectStore('queue').count(); r.onsuccess = () => resolve(r.result); });
    db.close(); return count;
  });
  expect(queued).toBe(0);
  expect(f.writes.filter(x => x.path.endsWith('/file'))).toHaveLength(1);
  expect(f.cohortOperations).toEqual([]);
});
