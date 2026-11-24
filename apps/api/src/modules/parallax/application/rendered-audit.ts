/*
 * One public page, rendered by a real browser at two viewport sizes and
 * assessed as a visitor would meet it: its title, description, headings and
 * canonical link; whether it fits a phone; its interaction targets; the
 * JavaScript errors it throws; an automated accessibility pass; a lab timing
 * sample; and a screenshot of each viewport.
 *
 * All browser HTTP traffic is intercepted and fulfilled by the DNS-pinned
 * transport. A dead proxy is the backstop for unhandled browser traffic.
 * No browser launch option can disable its sandbox in the shipping path.
 */
import zlib from 'node:zlib';
import axe from 'axe-core';
import { chromium, type Browser, type LaunchOptions, type Response as PageResponse } from 'playwright-core';
import { guardedFetch, PROFILES, type GuardedFetchInput } from '../../../platform/network/guarded-fetch.ts';
import { lookupTable, ownEntry, read } from '../../../platform/values/fields.ts';
import { LIMITS, VIEWPORTS, auditError, displayUrl, httpsAddress, renderedUrl, type RenderedLimits } from '../domain/rendered-address.ts';

/* What the transport answers a browser request with: the part of the guarded response the interception reads. */
export interface RenderedResponse {
  readonly statusCode: number;
  readonly headers?: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly body?: unknown;
  readonly bodyUnread?: boolean;
  readonly truncated?: boolean;
}
export type RenderedTransport = (input: GuardedFetchInput) => Promise<RenderedResponse>;

/* The encodings a resource may arrive in, each with its bounded decoder; a table without a prototype, since the name is a response header's. */
const DECODERS: Readonly<Record<string, (body: Buffer, options: zlib.ZlibOptions & zlib.BrotliOptions) => Buffer>> = lookupTable({
  gzip: zlib.gunzipSync, deflate: zlib.inflateSync, br: zlib.brotliDecompressSync
});
/* Response headers the browser is never handed: cookies, the transport's own framing, and instructions to clear or reload. */
const WITHHELD_HEADERS = ['set-cookie', 'set-cookie2', 'content-encoding', 'content-length', 'transfer-encoding', 'connection', 'alt-svc', 'clear-site-data', 'refresh'];

/*
 * The slice of the DOM the in-page measurements touch. The server is not
 * compiled against the DOM, so what they read is declared here, and each
 * in-page function checks for it before it reads: the functions run in the
 * page, from their source text, and can reach nothing of this module.
 */
interface PageBox { readonly width: number; readonly height: number; readonly right: number }
interface PageElement {
  readonly textContent: string | null;
  readonly content?: string;
  getBoundingClientRect(): PageBox;
  matches(selector: string): boolean;
  getAttribute(name: string): string | null;
}
interface PageScope {
  readonly document: {
    readonly title: string;
    readonly documentElement: { readonly lang: string; readonly scrollWidth: number };
    querySelectorAll(selector: string): { readonly length: number; readonly [index: number]: PageElement | undefined };
    querySelector(selector: string): PageElement | null;
  };
  readonly performance: { getEntriesByType(type: string): readonly ({ readonly domContentLoadedEventEnd: number; readonly responseStart: number } | undefined)[] };
  readonly __nvLab?: { lcp: number | null; cls: number };
}
interface LabEntry { readonly startTime: number; readonly hadRecentInput?: boolean; readonly value: number }
interface ObserverScope {
  __nvLab: { lcp: number | null; cls: number };
  readonly PerformanceObserver?: new (callback: (list: { getEntries(): readonly LabEntry[] }) => void) => { observe(options: { readonly type: string; readonly buffered: boolean }): void };
}
interface AxeScope {
  readonly document: unknown;
  readonly axe: { run(context: unknown, options: unknown): Promise<{
    readonly violations: readonly { readonly id: string; readonly impact: string | null; readonly help: string; readonly helpUrl: string; readonly nodes: readonly { readonly target: readonly unknown[] }[] }[];
    readonly passes: readonly unknown[];
    readonly incomplete: readonly unknown[];
  }> };
}

export interface RenderedFinding {
  readonly viewport: string;
  readonly category: string;
  readonly severity: string;
  readonly title: string;
  readonly detail: string;
  readonly rule?: string;
  readonly targets?: readonly (readonly string[])[];
  readonly helpUrl?: string;
}

export interface RenderedAuditInput {
  readonly url: unknown;
  readonly executablePath?: string | null;
  readonly signal?: AbortSignal | null;
  readonly onProgress?: (progress: { readonly stage: string }) => void;
  readonly transport?: RenderedTransport;
  readonly launch?: (options: LaunchOptions) => Promise<Browser>;
  readonly limits?: Partial<RenderedLimits>;
}

export async function auditRenderedSite({ url: requestedUrl, executablePath, signal, onProgress = () => {}, transport = guardedFetch,
  launch = options => chromium.launch(options), limits: requestedLimits = LIMITS }: RenderedAuditInput = { url: undefined }) {
  const url = renderedUrl(requestedUrl);
  const limits: RenderedLimits = { ...LIMITS, ...requestedLimits };
  const origin = new URL(url).origin;
  const started = Date.now();
  const controller = new AbortController();
  const reasons = new Set<string>();
  const network = { attempted: 0, completed: 0, blocked: 0, failed: 0, bytes: 0 };
  let browser: Browser | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abort = (): void => { controller.abort(); if (browser) void browser.close().catch(() => {}); };
  if (signal && signal.aborted) throw auditError('The audit was cancelled.', 'RENDERED_AUDIT_CANCELLED', 499);
  if (signal) signal.addEventListener('abort', abort, { once: true });
  timer = setTimeout(abort, limits.deadlineMs);
  const progress = (stage: string): void => { try { onProgress({ stage }); } catch { /* advisory only */ } };
  const checkTime = (): void => {
    if (signal && signal.aborted) throw auditError('The audit was cancelled.', 'RENDERED_AUDIT_CANCELLED', 499);
    if (controller.signal.aborted) throw auditError('The audit exceeded its time limit.', 'RENDERED_AUDIT_TIMEOUT', 504);
  };
  const findings: RenderedFinding[] = [];
  const add = (viewport: string, category: string, severity: string, title: string, detail: string, extra: Partial<RenderedFinding> = {}): void => { findings.push({ viewport, category, severity, title, detail, ...extra }); };
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
        await context.routeWebSocket(/.*/, socket => { network.blocked++; reasons.add('WebSockets were blocked'); void socket.close(); });
        let inFlight = 0;
        let reservedBytes = 0;
        let closed = false;
        const pending: (() => void)[] = [];
        const release = (): void => { inFlight--; const next = pending.shift(); if (next) next(); };
        const viewportController = new AbortController();
        const stopViewport = (): void => { closed = true; viewportController.abort(); for (const next of pending.splice(0)) next(); };
        controller.signal.addEventListener('abort', stopViewport, { once: true });
        context.on('close', () => { controller.signal.removeEventListener('abort', stopViewport); stopViewport(); });
        await context.route('**/*', async route => {
          const request = route.request();
          let target: URL | undefined;
          try { target = httpsAddress(request.url()); } catch { /* refused below */ }
          const reject = async (reason: string): Promise<void> => { network.blocked++; reasons.add(reason); await route.abort('blockedbyclient').catch(() => {}); };
          if (!target || target.origin !== origin) return reject('Cross-origin or non-HTTPS resources were blocked');
          if (!['GET', 'HEAD'].includes(request.method())) return reject('Requests that could submit data were blocked');
          if (closed || controller.signal.aborted || network.attempted >= limits.requests || network.bytes >= limits.bytes) {
            return reject('The request, byte or time limit was reached');
          }
          network.attempted++;
          if (inFlight >= 4) await new Promise<void>(resolve => pending.push(resolve));
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
            const decode = ownEntry(DECODERS, encoding);
            if (encoding !== 'identity' && !decode) return reject('A resource used an unsupported encoding');
            if (decode) {
              // A refused decompression consumes its reservation too; repeatedly
              // expanding tiny compressed bodies cannot evade the total budget.
              chargedBytes = resourceBudget;
              body = decode(body, { maxOutputLength: resourceBudget });
            }
            if (body.length > resourceBudget) return reject('A decoded resource exceeded its byte limit');
            chargedBytes = Math.max(response.body.length, body.length);
            const headers: Record<string, string> = {};
            for (const [name, value] of Object.entries(response.headers || {})) {
              if (!WITHHELD_HEADERS.includes(name.toLowerCase())) {
                headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
              }
            }
            const location = headers.location;
            if (response.statusCode >= 300 && response.statusCode < 400 && location) {
              const redirect = new URL(location, target);
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
          const scope: unknown = globalThis;
          const isGlobal = (value: unknown): value is ObserverScope => typeof value === 'object' && value !== null;
          if (!isGlobal(scope)) return;
          scope.__nvLab = { lcp: null, cls: 0 };
          try {
            if (!scope.PerformanceObserver) throw new Error('unsupported');
            new scope.PerformanceObserver(list => {
              for (const entry of list.getEntries()) scope.__nvLab.lcp = entry.startTime;
            }).observe({ type: 'largest-contentful-paint', buffered: true });
          } catch { /* unsupported */ }
          try {
            if (!scope.PerformanceObserver) throw new Error('unsupported');
            new scope.PerformanceObserver(list => {
              for (const entry of list.getEntries()) if (!entry.hadRecentInput) scope.__nvLab.cls += entry.value;
            }).observe({ type: 'layout-shift', buffered: true });
          } catch { /* unsupported */ }
        });
        const page = await context.newPage();
        const errors = { javascript: 0 };
        page.on('pageerror', () => { errors.javascript++; });
        page.on('dialog', dialog => void dialog.dismiss().catch(() => {}));
        context.on('page', other => { if (other !== page) { reasons.add('Popups were blocked'); void other.close().catch(() => {}); } });
        let documentResponse: PageResponse | null = null;
        page.on('response', answer => {
          if (answer.request().isNavigationRequest() && answer.frame() === page.mainFrame()) documentResponse = answer;
        });
        const documentIdentity = (): { readonly url: string; readonly response: PageResponse } => {
          let final: URL | null = null;
          try { final = new URL(page.url()); final.hash = ''; final = httpsAddress(final.href); } catch { final = null; }
          const answered: PageResponse | null = documentResponse;
          if (!final || final.origin !== origin || !answered || answered.status() < 200 || answered.status() >= 300) {
            throw auditError('The final page did not load successfully within the requested public origin.', 'RENDERED_PAGE_UNAVAILABLE', 502);
          }
          return { url: final.href, response: answered };
        };
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
        if (!response || response.status() < 200 || response.status() >= 300) throw auditError('The requested page did not load successfully.', 'RENDERED_PAGE_UNAVAILABLE', 502);
        try { await page.waitForLoadState('networkidle', { timeout: 5000 }); }
        catch { reasons.add('The page did not become network-idle within the sampling window'); }
        await page.waitForTimeout(1500);
        checkTime();
        const assessedDocument = documentIdentity();
        const measured = await page.evaluate(viewportWidth => {
          const scope: unknown = globalThis;
          const isPage = (value: unknown): value is PageScope => typeof value === 'object' && value !== null && 'document' in value && 'performance' in value;
          if (!isPage(scope)) throw new Error('The page has no document to measure.');
          const doc = scope.document;
          const nav = scope.performance.getEntriesByType('navigation')[0];
          const rect = (element: PageElement): PageBox => element.getBoundingClientRect();
          const visible = (element: PageElement): boolean => { const box = rect(element); return box.width > 0 && box.height > 0; };
          const elements = doc.querySelectorAll('body *');
          const sampled = Array.from({ length: Math.min(elements.length, 10000) }, (_, index) => elements[index]).filter((element): element is PageElement => element !== undefined);
          const headings = doc.querySelectorAll('h1');
          const h1 = Array.from({ length: Math.min(headings.length, 20) }, (_, index) => ((headings[index] && headings[index].textContent) || '').trim().slice(0, 160));
          const description = doc.querySelector('meta[name="description" i]');
          const canonical = doc.querySelector('link[rel="canonical" i]');
          const robots = doc.querySelector('meta[name="robots" i]');
          const lab = scope.__nvLab;
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
              lcpMs: Number.isFinite(lab && lab.lcp) && lab && lab.lcp !== null ? Math.round(lab.lcp) : null,
              cls: lab ? Math.round(lab.cls * 1000) / 1000 : null }
          };
        }, viewport.width);
        const facts = { ...measured, canonical: measured.canonical ? displayUrl(measured.canonical, assessedDocument.url) : null };
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
          const assessed = await page.evaluate(async () => {
            const scope: unknown = globalThis;
            const withAxe = (value: unknown): value is AxeScope => typeof value === 'object' && value !== null && 'axe' in value && 'document' in value;
            if (!withAxe(scope)) throw new Error('The accessibility engine did not load.');
            const result = await scope.axe.run(scope.document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] } });
            return { violations: result.violations.slice(0, 50).map(item => ({ id: item.id, impact: item.impact, help: item.help,
              helpUrl: item.helpUrl, count: item.nodes.length,
              targets: item.nodes.slice(0, 5).map(node => node.target.map(value => String(value).slice(0, 160))) })),
              violationRules: result.violations.length, passes: result.passes.length, incomplete: result.incomplete.length };
          });
          for (const violation of assessed.violations) add(viewport.name, 'Accessibility', violation.impact === 'critical' || violation.impact === 'serious' ? violation.impact : 'warning', violation.help,
            `${violation.count} affected elements.`, { rule: violation.id, targets: violation.targets, helpUrl: violation.helpUrl });
          if (assessed.incomplete) reasons.add('Some accessibility checks require manual review');
          if (assessed.violationRules > 50) reasons.add('Accessibility evidence was capped at 50 rule violations');
          accessibility = assessed;
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
    if (error && /^RENDERED_/.test(String(read(error, 'code') || ''))) throw error;
    throw auditError('The page could not be assessed in the isolated browser.', 'RENDERED_PAGE_UNAVAILABLE', 502);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', abort);
    controller.abort();
    if (browser) await browser.close().catch(() => {});
  }
}

export type RenderedReport = Awaited<ReturnType<typeof auditRenderedSite>>;
