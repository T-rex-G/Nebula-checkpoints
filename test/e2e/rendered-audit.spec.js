'use strict';

const { test, expect, chromium } = require('@playwright/test');
const fs = require('fs');
const zlib = require('zlib');
const { auditRenderedSite } = require('../../src/rendered-site-audit');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');
const AxeBuilder = require('@axe-core/playwright').default;
test.use({ serviceWorkers: 'block' });

test('real Chromium assesses two viewports while refusing submissions, outside origins and private redirects', async ({}, info) => {
  test.setTimeout(60000);
  const requests = [];
  let active = 0;
  let peak = 0;
  const html = `<!doctype html><html lang="en"><head><title>Audit fixture</title>
    <meta name="viewport" content="width=device-width,initial-scale=1"><link rel="canonical">
    <style>body{font:18px sans-serif;background:white;color:black}main{width:650px}button{width:10px;height:10px}</style>
    <script src="/app.js"></script><script defer src="/bomb.js"></script></head><body><main><h1>Fixture heading</h1>
    <img src="/pixel.svg"><button></button><p>This deliberately broken page tests evidence collection.</p></main></body></html>`;
  const script = `document.cookie='fixture-cookie=must-not-be-forwarded';
    for(let i=0;i<12;i++) fetch('/resource/'+i).catch(()=>{});
    fetch('/submission',{method:'POST',body:'fixture-only'}).catch(()=>{});
    fetch('/private-redirect').catch(()=>{});
    fetch('https://outside.example/blocked').catch(()=>{});
    new WebSocket('wss://outside.example/socket');`;
  const report = await auditRenderedSite({ url: 'https://rendered.example/page',
    // This test-only injection accommodates restricted CI containers. The production launcher always requires the OS sandbox.
    launch: options => chromium.launch({ ...options,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
      chromiumSandbox: false, args: [...options.args, '--no-sandbox', '--disable-dev-shm-usage'] }),
    transport: async input => {
      requests.push(input); active++; peak = Math.max(peak, active);
      try {
        await new Promise(resolve => setTimeout(resolve, 15));
        const path = new URL(input.url).pathname;
        if (path === '/private-redirect') return { statusCode: 302, headers: { location: 'https://127.0.0.1/private' }, body: Buffer.alloc(0) };
        if (path === '/app.js') return { statusCode: 200, headers: { 'content-type': 'text/javascript', 'content-encoding': 'gzip' }, body: zlib.gzipSync(script) };
        if (path === '/bomb.js') return { statusCode: 200, headers: { 'content-type': 'text/javascript', 'content-encoding': 'gzip' }, body: zlib.gzipSync('document.title="Decompression cap failed";' + ' '.repeat(3 * 1024 * 1024)) };
        if (path === '/pixel.svg') return { statusCode: 200, headers: { 'content-type': 'image/svg+xml' }, body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60"><rect width="60" height="60" fill="blue"/></svg>') };
        return { statusCode: 200, headers: { 'content-type': path === '/page' ? 'text/html' : 'text/plain', 'set-cookie': 'fixture=never-forward' }, body: Buffer.from(path === '/page' ? html : 'fixture resource') };
      } finally { active--; }
    }
  });
  expect(report.viewports.map(view => view.name)).toEqual(['Desktop', 'Mobile']);
  expect(report.coverage.state).toBe('partial');
  expect(report.coverage.reasons.join(' ')).toMatch(/Cross-origin/);
  expect(report.coverage.reasons.join(' ')).toMatch(/submit data/);
  expect(report.coverage.reasons.join(' ')).toMatch(/redirect/);
  expect(report.findings.some(finding => finding.rule === 'image-alt')).toBe(true);
  expect(report.findings.some(finding => finding.category === 'Responsive' && finding.viewport === 'Mobile')).toBe(true);
  expect(report.findings.some(finding => finding.title.includes('canonical'))).toBe(true);
  expect(peak).toBeLessThanOrEqual(4);
  expect(report.network.bytes).toBeGreaterThanOrEqual(4 * 1024 * 1024);
  expect(report.network.bytes).toBeLessThanOrEqual(report.limits.bytes);
  expect(requests.every(input => new URL(input.url).origin === 'https://rendered.example' && input.method === 'GET')).toBe(true);
  expect(requests.every(input => !input.headers.cookie && !input.headers.authorization)).toBe(true);
  expect(requests.filter(input => input.url.includes('/resource/'))).toHaveLength(24);
  for (const view of report.viewports) {
    expect(view.screenshot.mimeType).toBe('image/jpeg');
    const bytes = Buffer.from(view.screenshot.data, 'base64');
    expect(bytes[0]).toBe(255); expect(bytes[1]).toBe(216);
    expect(view.facts.title).toBe('Audit fixture');
    expect(view.facts.metrics.ttfbMs).toBeGreaterThanOrEqual(0);
    await info.attach(`${view.name} rendered evidence`, { body: bytes, contentType: 'image/jpeg' });
  }
  await info.attach('rendered report', { body: JSON.stringify(report), contentType: 'application/json' });
});

async function open(page, handler) {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.route('**/api/site-rendered**', handler);
  await page.goto('/');
  await expect(page.locator('#page-overview')).toHaveClass(/active/);
  await page.evaluate(() => window.showSiteScan());
  return page.locator('#renderedAuditRoot');
}

test('rendered results show coverage and export inert evidence without persisting screenshots', async ({ page }) => {
  const result = { schemaVersion: 1, url: 'https://rendered.example', checkedAt: '2026-10-01T00:00:00Z',
    coverage: { state: 'partial', complete: false, reasons: ['A third-party resource was blocked.'] }, limitations: ['Single lab sample.'],
    viewports: [{ name: 'Mobile', width: 390, height: 844, screenshot: null, facts: { overflowPx: 40, metrics: { lcpMs: 345, cls: 0.01 } } }],
    findings: [{ viewport: 'Mobile', severity: 'serious', title: 'Review overflow', detail: '<script>window.compromised=true</script>' }] };
  const root = await open(page, route => {
    const url = new URL(route.request().url());
    return route.fulfill({ json: url.pathname.endsWith('/status') ? { available: true, message: 'Ready.' }
      : route.request().method() === 'POST' ? { state: 'running', run: 'fixture-run', stage: 'mobile' } : result });
  });
  await root.getByLabel('Page address').fill('https://rendered.example');
  await root.getByRole('button', { name: 'Run rendered audit' }).click();
  await expect(root.getByRole('status')).toContainText('Partial report');
  await expect(root).toContainText('A third-party resource was blocked.');
  await expect(root).toContainText('345 ms');
  expect(await page.evaluate(() => window.compromised)).toBeUndefined();
  const downloading = page.waitForEvent('download');
  await root.getByRole('button', { name: 'Export HTML report' }).click();
  const file = await downloading;
  const report = fs.readFileSync(await file.path(), 'utf8');
  expect(report).toContain('&lt;script&gt;');
  expect(report).toContain("default-src 'none'");
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('rendered.example');
  expect(await root.evaluate(node => node.scrollWidth <= node.clientWidth + 2)).toBe(true);
  for (const theme of ['dark', 'light']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    const assessment = await new AxeBuilder({ page }).include('#renderedAuditRoot').withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
    expect(assessment.violations.map(item => ({ id: item.id, targets: item.nodes.map(node => node.target) }))).toEqual([]);
  }
});

test('unavailable browser is explicit and cancellation stops a pending run', async ({ page }) => {
  let available = false;
  let cancelled = false;
  const root = await open(page, route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith('/status')) return route.fulfill({ json: { available, message: available ? 'Ready.' : 'Browser is unavailable on this deployment.' } });
    if (request.method() === 'DELETE') { cancelled = true; return route.fulfill({ json: { state: 'cancelled' } }); }
    return route.fulfill({ json: { state: 'running', run: 'pending-run', stage: 'desktop' } });
  });
  await expect(root.getByRole('status')).toContainText('unavailable');
  await expect(root.getByRole('button', { name: 'Run rendered audit' })).toBeDisabled();
  available = true;
  await root.getByRole('button', { name: 'Check availability' }).click();
  await root.getByLabel('Page address').fill('https://rendered.example');
  await root.getByRole('button', { name: 'Run rendered audit' }).click();
  await expect(root.getByRole('status')).toContainText('Checking');
  await root.getByRole('button', { name: 'Cancel audit' }).click();
  await expect(root.getByRole('status')).toContainText('cancelled');
  expect(cancelled).toBe(true);
  await expect(root.getByRole('button', { name: 'Run rendered audit' })).toBeEnabled();
});

test('rendered evidence names the final page and keeps public query values out of reports', async () => {
  const requested = [];
  const report = await auditRenderedSite({ url: 'https://rendered.example/start?theme=public-fixture-value',
    launch: options => chromium.launch({ ...options, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
      chromiumSandbox: false, args: [...options.args, '--no-sandbox', '--disable-dev-shm-usage'] }),
    transport: async input => {
      requested.push(input.url);
      const url = new URL(input.url);
      if (url.pathname === '/start') return { statusCode: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<!doctype html><html><title>Start</title><body><script>setTimeout(() => location.replace("/final?lang=public-language-value"), 10)</script></body></html>') };
      return { statusCode: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<!doctype html><html lang="en"><head><title>Final fixture</title><meta name="description" content="Fixture"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="canonical" href="/final?token=synthetic-canonical-token"></head><body><main><h1>Final fixture</h1></main></body></html>') };
    }
  });
  expect(requested).toContain('https://rendered.example/start?theme=public-fixture-value');
  expect(requested).toContain('https://rendered.example/final?lang=public-language-value');
  expect(report.url).toBe('https://rendered.example/start');
  expect(report.viewports).toHaveLength(2);
  for (const view of report.viewports) {
    expect(view.finalUrl).toBe('https://rendered.example/final');
    expect(view.status).toBe(200);
    expect(view.facts.canonical).toBe('https://rendered.example/final');
  }
  const evidence = JSON.stringify(report);
  expect(evidence).not.toContain('public-fixture-value');
  expect(evidence).not.toContain('public-language-value');
  expect(evidence).not.toContain('synthetic-canonical-token');
});

test('a client navigation to an HTTP error page cannot become a successful rendered report', async () => {
  await expect(auditRenderedSite({ url: 'https://rendered.example/start',
    launch: options => chromium.launch({ ...options, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
      chromiumSandbox: false, args: [...options.args, '--no-sandbox', '--disable-dev-shm-usage'] }),
    transport: async input => {
      const broken = new URL(input.url).pathname === '/broken';
      return { statusCode: broken ? 500 : 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(broken
        ? '<!doctype html><html><title>Broken page</title><body>Server error</body></html>'
        : '<!doctype html><html><title>Start</title><body><script>setTimeout(() => location.replace("/broken"), 10)</script></body></html>') };
    }
  })).rejects.toMatchObject({ code: 'RENDERED_PAGE_UNAVAILABLE' });
});

test('disposing a rendered form cancels a run acknowledged after disposal without target URLs in polls', async ({ page }) => {
  await page.setContent('<div id="isolated-rendered-root"></div>');
  await page.addScriptTag({ path: require('path').join(__dirname, '../../public/rendered-audit-ui.js') });
  await page.evaluate(() => {
    window.renderedCalls = [];
    window.NebulaRenderedAudit.mount(document.querySelector('#isolated-rendered-root'), { download() {}, api: async (url, options = {}) => {
      window.renderedCalls.push({ url, method: options.method || 'GET' });
      if (url.endsWith('/status')) return { available: true };
      if (options.method === 'POST') return new Promise(resolve => { window.resolveRenderedStart = resolve; });
      return { state: 'cancelled' };
    } });
  });
  await page.getByLabel('Page address').fill('https://rendered.example/?theme=fixture');
  await page.getByRole('button', { name: 'Run rendered audit' }).click();
  await page.evaluate(() => {
    window.NebulaRenderedAudit.dispose(document.querySelector('#isolated-rendered-root'));
    window.resolveRenderedStart({ state: 'running', run: 'dispose-fixture-run' });
  });
  await expect.poll(() => page.evaluate(() => window.renderedCalls.filter(call => call.method === 'DELETE'))).toEqual([
    { url: '/api/site-rendered?run=dispose-fixture-run', method: 'DELETE' }
  ]);
});


test('a failed cancellation stays explicit and can be retried', async ({ page }) => {
  let deletes = 0;
  const root = await open(page, route => {
    const request = route.request();
    if (new URL(request.url()).pathname.endsWith('/status')) return route.fulfill({ json: { available: true } });
    if (request.method() === 'DELETE') {
      deletes++;
      return deletes === 1 ? route.fulfill({ status: 503, json: { error: 'Synthetic cancellation failure' } })
        : route.fulfill({ json: { state: 'cancelled' } });
    }
    return route.fulfill({ json: { state: 'running', run: 'retry-cancel-run', stage: 'desktop' } });
  });
  await root.getByLabel('Page address').fill('https://rendered.example/');
  await root.getByRole('button', { name: 'Run rendered audit' }).click();
  await expect(root.getByRole('status')).toContainText('Checking');
  await root.getByRole('button', { name: 'Cancel audit' }).click();
  await expect(root.getByRole('status')).toContainText('Cancellation could not be confirmed');
  await expect(root.getByRole('button', { name: 'Run rendered audit' })).toBeDisabled();
  await root.getByRole('button', { name: 'Cancel audit' }).click();
  await expect(root.getByRole('status')).toContainText('Audit cancelled.');
  await expect(root.getByRole('button', { name: 'Run rendered audit' })).toBeEnabled();
  expect(deletes).toBe(2);
});
