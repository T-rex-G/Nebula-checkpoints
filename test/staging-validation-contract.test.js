'use strict';

const fs = require('fs');
const assert = require('assert');
const pkg = require('../package.json');
const ci = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
const config = fs.readFileSync('playwright.config.js', 'utf8');
const spec = fs.readFileSync('test/e2e/task20-accessibility.spec.js', 'utf8');
const fixtures = fs.readFileSync('test/e2e/task20-fixtures.js', 'utf8');
const gate = fs.readFileSync('scripts/staging-gate.js', 'utf8');
const validation = fs.readFileSync('src/staging-validation.js', 'utf8');
const stagingSpec = fs.readFileSync('TASK_20_STAGING_VALIDATION_SPEC.md', 'utf8');

assert.ok(pkg.scripts['test:staging:gate']);
assert.ok(pkg.scripts['staging:plan']);
assert.ok(pkg.scripts['staging:verify']);
assert.ok(pkg.scripts['test:e2e']);
assert.match(ci, /test:staging:gate/);
assert.match(config, /projects:/);
assert.match(config, /name: 'desktop'/);
assert.match(config, /name: 'mobile'/);
assert.match(config, /devices\['Pixel 5'\]/, 'mobile staging must use the installed Chromium engine');
assert.match(config, /test\/e2e/);
assert.match(spec, /test\.use\(\{ serviceWorkers: 'block' \}\)/, 'route-mocked Task 20 tests must block service workers');
assert.match(spec, /test\.use\(\{ serviceWorkers: 'allow' \}\)/, 'cache-boundary coverage must exercise the active service worker');
assert.match(spec, /navigator\.serviceWorker\.ready/, 'cache-boundary coverage must wait for service-worker activation');
assert.match(validation, /--project=mobile --grep "More navigation activates"/, 'mobile staging must select only the intended mobile flow');
assert.doesNotMatch(validation, /--project=mobile --grep "mobile"/, 'the mobile project name must not make every Task 20 test match');
assert.match(stagingSpec, /--project=mobile --grep "More navigation activates"/, 'the staging spec must match the prescribed mobile command');

for (const signal of [
  '#settingsBtnWork',
  'Shift+Tab',
  'toBeFocused',
  '#sheetScrim',
  'data-act="governance"',
  'caches.keys',
  "unroute('**/api/**')",
  'setOffline(true)',
  "getByRole('alert')"
]) assert.ok(spec.includes(signal), `missing behavioral browser assertion: ${signal}`);

for (const route of [
  '/api/me',
  '/api/repos',
  '/api/repo/acme/demo/governance/digital-twin',
  '/api/repo/acme/demo/governance/notifications',
  '/api/repo/acme/demo/governance/exports',
  '/api/repo/acme/demo/governance/webhooks'
]) assert.ok(fixtures.includes(route), `missing Task 20 browser fixture route: ${route}`);

assert.match(gate, /NV_STAGING_SUBJECT_SHA256/);
assert.match(gate, /versioned object envelope/);
assert.match(gate, /artifact hash mismatch/);
assert.match(gate, /regular non-symlink file/);
assert.match(validation, /CATALOG_HASH/);
assert.match(validation, /evidence requires at least one artifact file/);
assert.match(validation, /commandHash does not match the prescribed command/);
assert.match(validation, /expectedSubjectHash is required/);

console.log('staging validation contract tests passed');
