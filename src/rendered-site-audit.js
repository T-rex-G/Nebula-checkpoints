'use strict';

const { chromium } = require('playwright-core');
const axe = require('axe-core');
const zlib = require('zlib');
const { privatePathSegment } = require('./site-url-privacy');
const { guardedFetch, PROFILES } = require('./guarded-fetch');

const LIMITS = Object.freeze({ requests: 80, bytes: 20 * 1024 * 1024, resourceBytes: 2 * 1024 * 1024, deadlineMs: 90000, resourceMs: 10000, screenshots: 2 });
const VIEWPORTS = Object.freeze([{ name: 'Desktop', width: 1440, height: 900 }, { name: 'Mobile', width: 390, height: 844 }]);
function auditError(message, code = 'RENDERED_AUDIT_UNAVAILABLE', status = 503) {
  return Object.assign(new Error(message), { code, status });
}
function renderedUrl(value) {
  let url;
  try { url = new URL(String(value)); } catch { throw auditError('Enter a public HTTPS page address.', 'RENDERED_URL_INVALID', 400); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || url.hash || url.href.length > 2048) {
    throw auditError('Use HTTPS on port 443 without a username, password or fragment.', 'RENDERED_URL_INVALID', 400);
  }
  const sensitive = /^(?:access[-_]?token|refresh[-_]?token|id[-_]?token|token|auth(?:orization)?|auth[-_]?token|password|passwd|secret|client[-_]?secret|api[-_]?key|key|signature|sig|credential|code|session[-_]?id|session[-_]?token|jwt|oauth[-_]?token)$/i;
  if ([...url.searchParams.keys()].some(key => sensitive.test(key) || /^(?:x-amz-|x-goog-)/i.test(key))) {
    throw auditError('Use a public page address without credentials, access tokens or signed query parameters.', 'RENDERED_URL_SENSITIVE', 400);
  }
  return url.href;
}
function displayUrl(value, base) {
  try { const target = new URL(value, base); if (!/^https?:$/.test(target.protocol)) return null; target.search = ''; target.hash = ''; target.username = ''; target.password = '';
    target.pathname = target.pathname.split('/').map(part => privatePathSegment(part) ? '[redacted]' : part).join('/');
    return target.href;
  } catch { return null; }
}

/* All browser HTTP traffic is intercepted and fulfilled by the DNS-pinned
   transport. A dead proxy is the backstop for unhandled browser traffic.
   No browser launch option can disable its sandbox in the shipping path. */
async function auditRenderedSite({ url, executablePath, signal, onProgress = () => {}, transport = guardedFetch,
  launch = options => chromium.launch(options), limits = LIMITS } = {}) {
  url = renderedUrl(url);
  limits = { ...LIMITS, ...limits };
  const origin = new URL(url).origin;
  const started = Date.now();
  const controller = new AbortController();
  const reasons = new Set();
  const network = { attempted: 0, completed: 0, blocked: 0, failed: 0, bytes: 0 };
  let browser;
  let timer;
  const abort = () => { controller.abort(); if (browser) void browser.close().catch(() => {}); };
  if (signal && signal.aborted) throw auditError('The audit was cancelled.', 'RENDERED_AUDIT_CANCELLED', 499);
  if (signal) signal.addEventListener('abort', abort, { once: true });
  timer = setTimeout(abort, limits.deadlineMs);
  const progress = stage => { try { onProgress({ stage }); } catch { /* advisory only */ } };
  const checkTime = () => {
    if (signal && signal.aborted) throw auditError('The audit was cancelled.', 'RENDERED_AUDIT_CANCELLED', 499);
    if (controller.signal.aborted) throw auditError('The audit exceeded its time limit.', 'RENDERED_AUDIT_TIMEOUT', 504);
  };
  const findings = [];
  const add = (viewport, category, severity, title, detail, extra = {}) => findings.push({ viewport, category, severity, title, detail, ...extra });
  try {
    progress('launching');
    try {
      browser = await launch({ headless: true, chromiumSandbox: true, ...(executablePath ? { executablePath } : {}),
        proxy: { server: 'http://127.0.0.1:9' },
        args: ['--proxy-bypass-list=<-loopback>', '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--disable-background-networking', '--disable-extensions'] });
    } catch {
      throw auditError('The isolated browser could not start. The operator must install Chromium and enable its OS sandbox.');
    }
    checkTime();
    const viewports = [];
    for (const viewport of VIEWPORTS) {
      checkTime();
      progress(viewport.name.toLowerCase());
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 1, isMobile: viewport.name === 'Mobile', hasTouch: viewport.name === 'Mobile',
        serviceWorkers: 'block', acceptDownloads: false, ignoreHTTPSErrors: false, locale: 'en-US', colorScheme: 'light' });
      try {
        await context.routeWebSocket(/.*/, socket => { network.blocked++; reasons.add('WebSockets were blocked'); socket.close(); });
        let inFlight = 0;
        let reservedBytes = 0;
        let closed = false;
        const pending = [];
        const release = () => { inFlight--; const next = pending.shift(); if (next) next(); };
        const viewportController = new AbortController();
        const stopViewport = () => { closed = true; viewportController.abort(); for (const next of pending.splice(0)) next(); };
        controller.signal.addEventListener('abort', stopViewport, { once: true });
        context.on('close', () => { controller.signal.removeEventListener('abort', stopViewport); stopViewport(); });
        await context.route('**/*', async route => {
          const request = route.request();
          let target;
          try { target = new URL(renderedUrl(request.url())); } catch { /* refused below */ }
          const reject = async reason => { network.blocked++; reasons.add(reason); await route.abort('blockedbyclient').catch(() => {}); };
          if (!target || target.origin !== origin) return reject('Cross-origin or non-HTTPS resources were blocked');
          if (!['GET', 'HEAD'].includes(request.method())) return reject('Requests that could submit data were blocked');
          if (closed || controller.signal.aborted || network.attempted >= limits.requests || network.bytes >= limits.bytes) {
            return reject('The request, byte or time limit was reached');
          }
          network.attempted++;
          if (inFlight >= 4) await new Promise(resolve => pending.push(resolve));
          if (closed || controller.signal.aborted) return reject('The page finished before all resources were assessed');
          inFlight++;
          const resourceBudget = Math.min(limits.resourceBytes, limits.bytes - network.bytes - reservedBytes);
          if (resourceBudget < 1024) { release(); return reject('The total response byte limit was reached'); }
          reservedBytes += resourceBudget;
          let chargedBytes = 0;
          try {
            const response = await transport({ url: target.href, method: request.method(), profile: PROFILES.RENDERED_SITE,
              responseType: 'buffer', maxResponseBytes: resourceBudget,
              deadlineMs: Math.max(1, Math.min(limits.resourceMs, limits.deadlineMs - (Date.now() - started))), signal: viewportController.signal,
              headers: { accept: '*/*', 'accept-encoding': 'identity', 'user-agent': 'Nebulaverse-RenderedAudit/1.0' } });
            chargedBytes = Buffer.isBuffer(response.body) ? Math.min(resourceBudget, response.body.length) : 0;
            if (!Buffer.isBuffer(response.body) || response.bodyUnread || response.truncated) return reject('A resource exceeded its limit or could not be read');
            let body = response.body;
            const encoding = String(response.headers && response.headers['content-encoding'] || 'identity').toLowerCase().trim();
            const decode = { gzip: zlib.gunzipSync, deflate: zlib.inflateSync, br: zlib.brotliDecompressSync }[encoding];
            if (encoding !== 'identity' && !decode) return reject('A resource used an unsupported encoding');
            if (decode) {
              // A refused decompression consumes its reservation too; repeatedly
              // expanding tiny compressed bodies cannot evade the total budget.
              chargedBytes = resourceBudget;
              body = decode(body, { maxOutputLength: resourceBudget });
            }
            if (body.length > resourceBudget) return reject('A decoded resource exceeded its byte limit');
            chargedBytes = Math.max(response.body.length, body.length);
            const headers = {};
            for (const [name, value] of Object.entries(response.headers || {})) {
              if (!['set-cookie', 'set-cookie2', 'content-encoding', 'content-length', 'transfer-encoding', 'connection', 'alt-svc', 'clear-site-data', 'refresh'].includes(name.toLowerCase())) {
                headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
              }
            }
            if (response.statusCode >= 300 && response.statusCode < 400 && headers.location) {
              const redirect = new URL(headers.location, target);
              if (redirect.origin !== origin) return reject('A redirect left the requested origin');
            }
            if (response.statusCode >= 400) { network.failed++; reasons.add('Some resources returned HTTP errors'); }
            await route.fulfill({ status: response.statusCode, headers, body });
            network.completed++;
          } catch {
            network.failed++;
            reasons.add('Some resources could not be fetched through the public network guard');
            await route.abort('failed').catch(() => {});
          } finally { network.bytes += chargedBytes; reservedBytes -= resourceBudget; release(); }
        });
        await context.addInitScript(() => {
          globalThis.__nvLab = { lcp: null, cls: 0 };
          try { new globalThis.PerformanceObserver(list => {
            for (const entry of list.getEntries()) globalThis.__nvLab.lcp = entry.startTime;
          }).observe({ type: 'largest-contentful-paint', buffered: true }); } catch { /* unsupported */ }
          try { new globalThis.PerformanceObserver(list => {
            for (const entry of list.getEntries()) if (!entry.hadRecentInput) globalThis.__nvLab.cls += entry.value;
          }).observe({ type: 'layout-shift', buffered: true }); } catch { /* unsupported */ }
        });
        const page = await context.newPage();
        const errors = { javascript: 0 };
        page.on('pageerror', () => { errors.javascript++; });
        page.on('dialog', dialog => void dialog.dismiss().catch(() => {}));
        context.on('page', other => { if (other !== page) { reasons.add('Popups were blocked'); void other.close().catch(() => {}); } });
        let documentResponse = null;
        page.on('response', answer => {
          if (answer.request().isNavigationRequest() && answer.frame() === page.mainFrame()) documentResponse = answer;
        });
        const documentIdentity = () => {
          const final = new URL(page.url()); final.hash = '';
          renderedUrl(final.href);
          if (final.origin !== origin || !documentResponse || documentResponse.status() < 200 || documentResponse.status() >= 300) {
            throw auditError('The final page did not load successfully within the requested public origin.', 'RENDERED_PAGE_UNAVAILABLE', 502);
          }
          return { url: final.href, response: documentResponse };
        };
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
        if (!response || response.status() < 200 || response.status() >= 300) throw auditError('The requested page did not load successfully.', 'RENDERED_PAGE_UNAVAILABLE', 502);
        try { await page.waitForLoadState('networkidle', { timeout: 5000 }); }
        catch { reasons.add('The page did not become network-idle within the sampling window'); }
        await page.waitForTimeout(1500);
        checkTime();
        const assessedDocument = documentIdentity();
        const facts = await page.evaluate(viewportWidth => {
          const doc = globalThis.document;
          const nav = globalThis.performance.getEntriesByType('navigation')[0];
          const rect = element => element.getBoundingClientRect();
          const visible = element => { const box = rect(element); return box.width > 0 && box.height > 0; };
          const elements = doc.querySelectorAll('body *');
          const sampled = Array.from({ length: Math.min(elements.length, 10000) }, (_, index) => elements[index]);
          const headings = doc.querySelectorAll('h1');
          const h1 = Array.from({ length: Math.min(headings.length, 20) }, (_, index) => (headings[index].textContent || '').trim().slice(0, 160));
          const description = doc.querySelector('meta[name="description" i]');
          const canonical = doc.querySelector('link[rel="canonical" i]');
          const robots = doc.querySelector('meta[name="robots" i]');
          return {
            title: doc.title.slice(0, 200), description: description ? (description.content || '').slice(0, 320) : '',
            canonical: canonical ? (canonical.getAttribute('href') || '').slice(0, 2048) : null,
            robots: robots ? (robots.content || '').slice(0, 200) : '', language: doc.documentElement.lang.slice(0, 50),
            h1, h1Count: headings.length, viewportMeta: Boolean(doc.querySelector('meta[name="viewport"]')),
            overflowPx: Math.max(0, doc.documentElement.scrollWidth - viewportWidth),
            overflowElements: sampled.filter(element => visible(element) && rect(element).right > viewportWidth + 2).length,
            smallTargets: sampled.filter(element => element.matches('button, a[href], input:not([type="hidden"]), select, textarea') && visible(element) && (rect(element).width < 24 || rect(element).height < 24)).length,
            elements: elements.length, sampledElements: sampled.length,
            metrics: { domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
              ttfbMs: nav ? Math.round(nav.responseStart) : null,
              lcpMs: Number.isFinite(globalThis.__nvLab && globalThis.__nvLab.lcp) ? Math.round(globalThis.__nvLab.lcp) : null,
              cls: globalThis.__nvLab ? Math.round(globalThis.__nvLab.cls * 1000) / 1000 : null }
          };
        }, viewport.width);
        facts.canonical = facts.canonical ? displayUrl(facts.canonical, assessedDocument.url) : null;
        if (facts.elements > facts.sampledElements) reasons.add('Layout inspection sampled the first 10,000 elements');
        if (!facts.title.trim()) add(viewport.name, 'SEO', 'serious', 'Add a page title', 'The rendered document has no title.');
        if (!facts.description.trim()) add(viewport.name, 'SEO', 'warning', 'Add a search description', 'The rendered document has no meta description. Search engines may choose their own excerpt.');
        if (facts.h1Count !== 1) add(viewport.name, 'Structure', 'warning', 'Review the main heading', `Found ${facts.h1Count} H1 headings. Make the page purpose clear to readers.`);
        if (!facts.canonical) add(viewport.name, 'SEO', 'warning', 'Review the canonical URL', 'No canonical link was observed. Check whether duplicate page URLs need consolidation.');
        if (/\bnoindex\b/i.test(facts.robots)) add(viewport.name, 'SEO', 'warning', 'This page requests no indexing', 'Confirm that noindex is intentional for this page.');
        if (!facts.viewportMeta) add(viewport.name, 'Responsive', 'serious', 'Declare the mobile viewport', 'No viewport meta tag was found.');
        if (facts.overflowPx > 2) add(viewport.name, 'Responsive', 'serious', 'Content extends beyond the viewport', `${facts.overflowPx}px of horizontal overflow was measured. Inspect fixed widths and long content.`);
        if (facts.smallTargets) add(viewport.name, 'Interaction', 'warning', 'Review small interaction targets', `${facts.smallTargets} visible targets are smaller than 24px in at least one dimension. Spacing exceptions require manual review.`);
        if (errors.javascript) add(viewport.name, 'Reliability', 'warning', 'JavaScript errors occurred', `${errors.javascript} uncaught errors occurred during the sample; blocked resources can contribute.`);
        progress('accessibility');
        let accessibility;
        try {
          await page.evaluate(axe.source);
          accessibility = await page.evaluate(async () => {
            const result = await globalThis.axe.run(globalThis.document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] } });
            return { violations: result.violations.slice(0, 50).map(item => ({ id: item.id, impact: item.impact, help: item.help,
              helpUrl: item.helpUrl, count: item.nodes.length,
              targets: item.nodes.slice(0, 5).map(node => node.target.map(value => String(value).slice(0, 160))) })),
              violationRules: result.violations.length, passes: result.passes.length, incomplete: result.incomplete.length };
          });
          for (const violation of accessibility.violations) add(viewport.name, 'Accessibility', ['critical', 'serious'].includes(violation.impact) ? violation.impact : 'warning', violation.help,
            `${violation.count} affected elements.`, { rule: violation.id, targets: violation.targets, helpUrl: violation.helpUrl });
          if (accessibility.incomplete) reasons.add('Some accessibility checks require manual review');
          if (accessibility.violationRules > 50) reasons.add('Accessibility evidence was capped at 50 rule violations');
        } catch { reasons.add('The accessibility engine could not finish'); accessibility = { unavailable: true }; }
        progress('capturing');
        const bytes = await page.screenshot({ type: 'jpeg', quality: 65, fullPage: false, animations: 'disabled', timeout: 10000 });
        if (bytes.length > 1500000) { reasons.add('A screenshot exceeded its evidence limit'); }
        const capturedDocument = documentIdentity();
        if (capturedDocument.url !== assessedDocument.url || capturedDocument.response !== assessedDocument.response) {
          throw auditError('The page changed while evidence was being collected. Try a stable public page.', 'RENDERED_PAGE_CHANGED', 502);
        }
        viewports.push({ ...viewport, finalUrl: displayUrl(assessedDocument.url), status: assessedDocument.response.status(), facts, errors, accessibility, screenshot: bytes.length <= 1500000 ? { mimeType: 'image/jpeg', data: bytes.toString('base64') } : null });
      } finally { await context.close().catch(() => {}); }
    }
    return { schemaVersion: 2, url: displayUrl(url), checkedAt: new Date().toISOString(), durationMs: Date.now() - started,
      coverage: { state: reasons.size ? 'partial' : 'complete', complete: !reasons.size, reasons: [...reasons] },
      network, limits, viewports, findings,
      limitations: ['One anonymous page, at two viewport sizes; no signed-in flows, clicks, form submissions or crawling.',
        'Only same-origin HTTPS resources are allowed. Cross-origin assets and cookie-dependent behavior may be missing.',
        'Accessibility automation covers a subset of WCAG. Keyboard, screen reader and visual design review are still required.',
        'Timing is a single lab sample through an intercepted network, without device or network throttling. It is not a Lighthouse score or field Core Web Vitals.',
        'Screenshots cover the initial viewport. SEO observations do not establish search indexing or rankings.'] };
  } catch (error) {
    checkTime();
    if (error && /^RENDERED_/.test(error.code || '')) throw error;
    throw auditError('The page could not be assessed in the isolated browser.', 'RENDERED_PAGE_UNAVAILABLE', 502);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', abort);
    controller.abort();
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { auditRenderedSite, renderedUrl, displayUrl, auditError, LIMITS, VIEWPORTS };
