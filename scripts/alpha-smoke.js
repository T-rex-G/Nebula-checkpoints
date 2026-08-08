'use strict';

const { performance } = require('perf_hooks');

const SMOKE_PLAN = Object.freeze([
  Object.freeze(['GET', '/healthz', 200]),
  Object.freeze(['GET', '/readyz', 200]),
  Object.freeze(['GET', '/api/version', 200]),
  Object.freeze(['GET', '/api/config', 200]),
  Object.freeze(['GET', '/api/capabilities?provider=github&authority=github.com', 200])
]);

function buildSmokePlan() {
  return SMOKE_PLAN.map(item => [...item]);
}

function validateBaseUrl(raw) {
  let url;
  try { url = new URL(String(raw || '').trim()); }
  catch { throw new TypeError('NV_ALPHA_BASE_URL must be an absolute URL'); }
  if (url.username || url.password) throw new TypeError('NV_ALPHA_BASE_URL must not contain credentials');
  if (url.hash || url.search || !['', '/'].includes(url.pathname)) {
    throw new TypeError('NV_ALPHA_BASE_URL must be an origin without a path, query, or fragment');
  }
  const loopback = ['127.0.0.1', 'localhost'].includes(url.hostname.toLowerCase());
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
    throw new TypeError('NV_ALPHA_BASE_URL must use HTTPS except for localhost or 127.0.0.1');
  }
  return url;
}

function safeCorrelation(response) {
  const raw = String(
    response.headers.get('x-correlation-id') || response.headers.get('x-request-id') || ''
  );
  return /^[A-Za-z0-9._:-]{1,100}$/.test(raw) ? raw : null;
}

async function timedRequest(baseUrl, pathname, options = {}) {
  const base = validateBaseUrl(baseUrl.toString());
  const origin = base.origin;
  let current = new URL(pathname, base);
  if (current.origin !== origin) throw new TypeError('Smoke request must remain on the alpha origin');
  const timeoutMs = Number(options.timeoutMs || 20000);
  const started = performance.now();
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    let response;
    try {
      response = await fetch(current, {
        method: options.method || 'GET',
        headers: options.headers,
        body: options.body,
        redirect: 'manual',
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
    if (response.status >= 300 && response.status < 400) {
      if (options.followRedirects === false) {
        await response.body?.cancel().catch(() => {});
        throw new Error('Mutation redirect refused');
      }
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => {});
      if (!location) throw new Error('Redirect response omitted Location');
      const target = new URL(location, current);
      if (target.origin !== origin) throw new Error('Cross-origin redirect refused');
      current = target;
      continue;
    }
    return Object.freeze({
      response,
      durationMs: Math.max(0, Math.round(performance.now() - started)),
      correlationId: safeCorrelation(response)
    });
  }
  throw new Error('Too many same-origin redirects');
}

async function runSmoke(baseUrl) {
  const base = validateBaseUrl(baseUrl);
  const results = [];
  for (const [method, pathname, expectedStatus] of buildSmokePlan()) {
    const result = await timedRequest(base, pathname, { method, timeoutMs: 20000 });
    await result.response.body?.cancel().catch(() => {});
    results.push(Object.freeze({
      status: result.response.status,
      durationMs: result.durationMs,
      correlationId: result.correlationId,
      ok: result.response.status === expectedStatus
    }));
  }
  return Object.freeze({
    ok: results.every(result => result.ok),
    checks: Object.freeze(results)
  });
}

async function main(env = process.env) {
  const result = await runSmoke(env.NV_ALPHA_BASE_URL);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: String(error.message || 'Smoke failed').slice(0, 160) })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  buildSmokePlan,
  validateBaseUrl,
  timedRequest,
  runSmoke
};
