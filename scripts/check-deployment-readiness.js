#!/usr/bin/env node
'use strict';

const path = require('path');
const { validateBaseUrl } = require('./alpha-smoke');
const { loadMigrations } = require('../src/migrations');

// This read-only gate is run from the frozen candidate, before admitting a
// cohort. Process liveness alone deliberately stays green during maintenance.
async function checkDeployment({ baseUrl, expectedFingerprint, purpose = 'cohort', timeoutMs = 10000 }) {
  const base = validateBaseUrl(baseUrl);
  if (!/^[a-f0-9]{64}$/.test(expectedFingerprint || '')) throw new Error('An exact candidate fingerprint is required');
  if (!['cohort', 'operator-verification'].includes(purpose)) throw new Error('Invalid deployment purpose');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('Invalid request deadline');
  const migration = loadMigrations(path.join(__dirname, '../db/migrations')).at(-1).id;
  const checks = [];
  async function request(route, predicate) {
    let ok = false;
    let reason = 'request failed';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(new URL(route, base), { redirect: 'error', signal: controller.signal });
      const reader = response.body?.getReader();
      if (!reader) throw new Error('empty response');
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 65536) throw new Error('response too large');
          chunks.push(Buffer.from(value));
        }
      } finally { await reader.cancel().catch(() => {}); }
      ok = response.status === 200 && predicate(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      reason = ok ? 'matched' : 'deployment does not match the required state';
    } catch { /* Report no remote response text, secrets, or supplied URL. */ }
    finally { clearTimeout(timer); }
    checks.push({ route, ok, reason });
  }
  await request('/healthz', body => body.ok === true && body.maintenance === false);
  await request('/readyz', body => body.ok === true && body.database === 'connected' && body.migration === migration);
  await request('/api/version', body => body.releaseTreeSha256 === expectedFingerprint);
  await request('/api/alpha/status', body => purpose === 'cohort' ? body.mode === 'invite' : ['off', 'invite'].includes(body.mode));
  return { ok: checks.every(check => check.ok), purpose, expectedFingerprint, migration,
    cohortAdmissionChecked: purpose === 'cohort', releaseQualification: 'requires separate live and manual evidence', checks };
}

async function main(env = process.env) {
  const result = await checkDeployment({ baseUrl: env.NV_ALPHA_BASE_URL,
    expectedFingerprint: env.NV_EXPECTED_RELEASE_TREE_SHA256,
    purpose: env.NV_DEPLOYMENT_CHECK_PURPOSE || 'cohort' });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}
if (require.main === module) main().catch(() => {
  process.stderr.write('Deployment readiness configuration is invalid; check the origin, fingerprint and purpose.\n');
  process.exitCode = 1;
});
module.exports = { checkDeployment };
