'use strict';
const assert = require('assert/strict');
const http = require('http');
const path = require('path');
const { checkDeployment } = require('../scripts/check-deployment-readiness');
const { loadMigrations } = require('../src/migrations');

(async () => {
  const migration = loadMigrations(path.join(__dirname, '../db/migrations')).at(-1).id;
  const fingerprint = 'a'.repeat(64);
  const states = {
    '/healthz': { ok: true, maintenance: false },
    '/readyz': { ok: true, database: 'connected', migration },
    '/api/version': { releaseTreeSha256: fingerprint },
    '/api/alpha/status': { mode: 'invite' }
  };
  let stalled = false;
  let redirect = false;
  const server = http.createServer((req, res) => {
    if (req.url === '/api/version' && stalled) { res.writeHead(200); res.write('{'); return; }
    if (req.url === '/api/version' && redirect) { res.writeHead(302, { Location: '/healthz' }); res.end(); return; }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(states[req.url]));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  // Positive HTTP cases need scheduling headroom under parallel browser load.
  // The stalled-body case below keeps its strict, short deadline.
  const options = { baseUrl: `http://127.0.0.1:${server.address().port}`, expectedFingerprint: fingerprint, timeoutMs: 2000 };
  try {
    assert.equal((await checkDeployment(options)).ok, true);
    states['/api/alpha/status'].mode = 'off';
    assert.equal((await checkDeployment(options)).ok, false, 'gate-off deployment cannot admit the cohort');
    const operator = await checkDeployment({ ...options, purpose: 'operator-verification' });
    assert.equal(operator.ok, true);
    assert.equal(operator.cohortAdmissionChecked, false);
    states['/api/alpha/status'].mode = 'invite';
    assert.equal((await checkDeployment({ ...options, expectedFingerprint: 'b'.repeat(64) })).ok, false);
    states['/readyz'].migration = '015_alpha_privacy';
    assert.equal((await checkDeployment(options)).ok, false);
    states['/readyz'].migration = migration;
    states['/readyz'].database = 'optional-not-configured';
    assert.equal((await checkDeployment(options)).ok, false);
    states['/readyz'].database = 'connected';
    states['/healthz'].maintenance = true;
    assert.equal((await checkDeployment(options)).ok, false);
    states['/healthz'].maintenance = false;
    stalled = true;
    const start = Date.now();
    assert.equal((await checkDeployment({ ...options, timeoutMs: 200 })).ok, false);
    assert(Date.now() - start < 3000, 'deadline must include the response body');
    stalled = false;
    redirect = true;
    assert.equal((await checkDeployment(options)).ok, false);
    await assert.rejects(checkDeployment({ ...options, purpose: 'public' }), /purpose/);
    await assert.rejects(checkDeployment({ ...options, expectedFingerprint: '' }), /fingerprint/);
    console.log('deployment readiness gate tests passed');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
