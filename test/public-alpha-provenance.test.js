'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const provenance = JSON.parse(fs.readFileSync(path.join(root, 'PUBLIC_ALPHA_PROVENANCE.json'), 'utf8'));

assert.strictEqual(pkg.version, '5.3.0-alpha.17.0');
assert.strictEqual(lock.version, pkg.version);
assert.strictEqual(lock.packages[''].version, pkg.version);
assert.deepStrictEqual(provenance, {
  schemaVersion: '1.0.0',
  product: 'Nebulaverse-X',
  successorVersion: '5.3.0-alpha.17.0',
  predecessor: {
    archive: 'Nebulaverse-X-v5.3.0-alpha.16.3.zip',
    sha256: '330b1b65894d1f63d7f4597cd81370d423fa66b60f69a4bb3a1a88084eca8892',
    qualifiedPublicationCommit: 'c19389f8b25cb67caad6fd56d000ca130ef8520f',
    pushRun: '30464094438',
    pullRequestRun: '30464096155',
    buildSourceCommit: null
  },
  releaseModel: 'controlled-hosted-public-alpha',
  cohortMaximum: 10
});
console.log('public alpha provenance tests passed');
