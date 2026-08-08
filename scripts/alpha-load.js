'use strict';

const { validateBaseUrl, timedRequest } = require('./alpha-smoke');

function boundedInteger(value, label, minimum, maximum) {
  const raw = String(value);
  if (!/^\d+$/.test(raw)) throw new TypeError(`${label} must be an integer`);
  const number = Number(raw);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new RangeError(`${label} must be between ${minimum} and ${maximum}`);
  }
  return number;
}

function buildLoadPlan({ testers, readsPerTester, mutations }) {
  const workerCount = boundedInteger(testers, 'testers', 1, Number.MAX_SAFE_INTEGER);
  const reads = boundedInteger(readsPerTester, 'readsPerTester', 1, Number.MAX_SAFE_INTEGER);
  const mutationCount = boundedInteger(mutations, 'mutations', 0, Number.MAX_SAFE_INTEGER);
  if (workerCount > 5) throw new RangeError('maximum 5 testers');
  if (reads > 10) throw new RangeError('maximum 10 reads per tester');
  if (mutationCount > 1) throw new RangeError('maximum one mutation');
  const readWorkers = Array.from({ length: workerCount }, (_, worker) => Object.freeze(
    Array.from({ length: reads }, (_, index) => Object.freeze({
      worker,
      index,
      path: index === 0 ? '/healthz' : '/api/alpha/status'
    }))
  ));
  const mutationPlan = mutationCount ? Object.freeze([Object.freeze({ index: 0 })]) : Object.freeze([]);
  return Object.freeze({
    readWorkers: Object.freeze(readWorkers),
    mutations: mutationPlan
  });
}

function percentile(values, ratio) {
  if (!Array.isArray(values) || !values.length) return 0;
  const sorted = values.map(Number).sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(Number(ratio) * sorted.length) - 1));
  return sorted[index];
}

function parseJsonEnvironment(env, key, fallback) {
  const raw = String(env[key] || '').trim();
  if (!raw && fallback !== undefined) return fallback;
  if (!raw) throw new TypeError(`${key} is required`);
  try { return JSON.parse(raw); }
  catch { throw new TypeError(`${key} must be valid JSON`); }
}

function loadCookies(env, testers) {
  const cookies = parseJsonEnvironment(env, 'NV_ALPHA_SESSION_COOKIES');
  if (!Array.isArray(cookies) || cookies.length < testers) {
    throw new TypeError('NV_ALPHA_SESSION_COOKIES must contain one cookie per tester');
  }
  return cookies.slice(0, testers).map(cookie => {
    const value = String(cookie || '');
    if (!value || value.length > 4096 || /[\r\n]/.test(value)) {
      throw new TypeError('NV_ALPHA_SESSION_COOKIES contains an invalid cookie');
    }
    return value;
  });
}

function normalizeRequest(input, label) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError(`${label} must be an object`);
  }
  const method = String(input.method || '').toUpperCase();
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    throw new TypeError(`${label}.method must be a mutation method`);
  }
  const pathname = String(input.path || '');
  if (!pathname.startsWith('/api/') || pathname.startsWith('//') || /[\r\n]/.test(pathname)) {
    throw new TypeError(`${label}.path must be a same-origin /api/ path`);
  }
  const expectedStatus = boundedInteger(input.expectedStatus, `${label}.expectedStatus`, 100, 599);
  const headers = input.headers && typeof input.headers === 'object' && !Array.isArray(input.headers)
    ? Object.fromEntries(Object.entries(input.headers).map(([key, value]) => [String(key), String(value)]))
    : {};
  const body = typeof input.body === 'string' ? input.body : JSON.stringify(input.body ?? {});
  return Object.freeze({ method, path: pathname, expectedStatus, headers: Object.freeze(headers), body });
}

async function readSafeJson(response) {
  const length = Number(response.headers.get('content-length') || 0);
  if (length > 65536) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 65536) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
  } catch {
    await reader.cancel().catch(() => {});
    return null;
  } finally {
    reader.releaseLock();
  }
}

function statusCounts(results) {
  const counts = {};
  for (const result of results) counts[result.status] = (counts[result.status] || 0) + 1;
  return counts;
}

async function runLoad(env = process.env) {
  const base = validateBaseUrl(env.NV_ALPHA_BASE_URL);
  const testers = boundedInteger(env.NV_ALPHA_TESTERS || '5', 'NV_ALPHA_TESTERS', 1, 5);
  const readsPerTester = boundedInteger(env.NV_ALPHA_READS_PER_TESTER || '10', 'NV_ALPHA_READS_PER_TESTER', 1, 10);
  const mutations = boundedInteger(env.NV_ALPHA_MUTATIONS || '0', 'NV_ALPHA_MUTATIONS', 0, 1);
  const plan = buildLoadPlan({ testers, readsPerTester, mutations });
  const cookies = loadCookies(env, testers);
  const readResults = (await Promise.all(plan.readWorkers.map(async (tasks, worker) => {
    const results = [];
    for (const task of tasks) {
      const timed = await timedRequest(base, task.path, {
        method: 'GET',
        timeoutMs: 30000,
        headers: { Cookie: cookies[worker] }
      });
      const body = await readSafeJson(timed.response);
      results.push(Object.freeze({
        status: timed.response.status,
        durationMs: timed.durationMs,
        memoryMb: Number.isFinite(Number(body?.memoryMb)) ? Number(body.memoryMb) : null
      }));
    }
    return results;
  }))).flat();

  let mutationResult = null;
  let cleanupResult = Object.freeze({ attempted: false, ok: mutations === 0 });
  if (mutations === 1) {
    const mutation = normalizeRequest(parseJsonEnvironment(env, 'NV_ALPHA_MUTATION_REQUEST'), 'NV_ALPHA_MUTATION_REQUEST');
    const cleanup = normalizeRequest(parseJsonEnvironment(env, 'NV_ALPHA_CLEANUP_REQUEST'), 'NV_ALPHA_CLEANUP_REQUEST');
    let mutationError;
    try {
      const timed = await timedRequest(base, mutation.path, {
        method: mutation.method,
        timeoutMs: 30000,
        followRedirects: false,
        headers: { ...mutation.headers, Cookie: cookies[0] },
        body: mutation.body
      });
      await timed.response.body?.cancel().catch(() => {});
      mutationResult = Object.freeze({
        status: timed.response.status,
        durationMs: timed.durationMs,
        ok: timed.response.status === mutation.expectedStatus
      });
    } catch (error) {
      mutationError = error;
      mutationResult = Object.freeze({ status: 0, durationMs: 0, ok: false });
    } finally {
      try {
        const timed = await timedRequest(base, cleanup.path, {
          method: cleanup.method,
          timeoutMs: 30000,
          followRedirects: false,
          headers: { ...cleanup.headers, Cookie: cookies[0] },
          body: cleanup.body
        });
        await timed.response.body?.cancel().catch(() => {});
        cleanupResult = Object.freeze({
          attempted: true,
          status: timed.response.status,
          durationMs: timed.durationMs,
          ok: timed.response.status === cleanup.expectedStatus
        });
      } catch {
        cleanupResult = Object.freeze({ attempted: true, status: 0, durationMs: 0, ok: false });
      }
    }
    if (mutationError && !cleanupResult.ok) {
      // The aggregate result below records both failures without echoing the request or error.
    }
  }

  const durations = readResults.map(result => result.durationMs);
  const memoryObservations = readResults
    .map(result => result.memoryMb)
    .filter(value => Number.isFinite(value));
  return Object.freeze({
    ok: readResults.every(result => result.status >= 200 && result.status < 400) &&
      (mutations === 0 || !!mutationResult?.ok) && cleanupResult.ok,
    workers: testers,
    reads: readResults.length,
    mutations,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    statusCounts: Object.freeze(statusCounts(readResults)),
    memoryObservations: Object.freeze(memoryObservations),
    mutation: mutationResult,
    cleanup: cleanupResult
  });
}

async function main(env = process.env) {
  const result = await runLoad(env);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      error: String(error.message || 'Load qualification failed').slice(0, 160)
    })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  buildLoadPlan,
  percentile,
  readSafeJson,
  runLoad
};
