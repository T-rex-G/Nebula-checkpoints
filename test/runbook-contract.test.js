'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'docs', 'operations', 'runbooks');
const required = [
  '01-service-cold-start-outage.md',
  '02-neon-outage-quota.md',
  '03-provider-outage-rate-limit.md',
  '04-credential-exposure.md',
  '05-orphan-cleanup.md',
  '06-failed-deploy-rollback.md',
  '07-database-backup-restore.md',
  '08-tester-revocation-deletion.md',
  '09-capacity-saturation.md',
  '10-alpha-shutdown.md',
  'OPERATOR_CHECKLIST.md'
];

for (const file of required) {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  if (file !== 'OPERATOR_CHECKLIST.md') {
    for (const heading of ['## Trigger', '## Containment', '## Verification', '## Recovery', '## Evidence']) {
      assert(text.includes(heading), `${file} missing ${heading}`);
    }
    assert(text.includes('```bash'), `${file} must include a copyable command block`);
  }
  assert(!/TB[D]|TO[D]O|fill in|implement\s+later/i.test(text), `${file} contains an unfinished marker`);
  assert(!/postgres(?:ql)?:\/\/[^\s`]+/i.test(text), `${file} contains a literal database URL`);
  assert(!/(?:password|token|secret|key)\s*=\s*[^$\s`][^\s`]*/i.test(text), `${file} contains a literal secret-like value`);
}

for (const file of ['06-failed-deploy-rollback.md', '09-capacity-saturation.md']) {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  for (const line of text.split('\n').filter(value => value.startsWith('curl '))) {
    assert(line.includes('--fail'), `${file} verification probe must fail on HTTP errors`);
  }
}

const credentialExposure = fs.readFileSync(path.join(root, '04-credential-exposure.md'), 'utf8');
assert.match(credentialExposure, /SESSION_SECRET.*reconnect.*verified-live-events.*webhook delivery health/is);

const securityDeployment = fs.readFileSync(path.join(root, '..', 'SECURITY_DEPLOYMENT.md'), 'utf8');
const compatibilityStep = securityDeployment.indexOf('NV_SNAPSHOT_LEGACY_KEYS_JSON` compatibility keyring');
const rotationStep = securityDeployment.indexOf('Rotate the value in Render');
assert(compatibilityStep >= 0 && rotationStep > compatibilityStep,
  'legacy snapshot compatibility must be staged before SESSION_SECRET rotation');

console.log('runbook contract tests passed');
