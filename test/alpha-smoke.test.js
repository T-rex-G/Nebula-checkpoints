'use strict';

const assert = require('assert');
const { buildSmokePlan, validateBaseUrl } = require('../scripts/alpha-smoke');

assert.deepStrictEqual(buildSmokePlan(), [
  ['GET', '/healthz', 200],
  ['GET', '/readyz', 200],
  ['GET', '/api/version', 200],
  ['GET', '/api/config', 200],
  ['GET', '/api/capabilities?provider=github&authority=github.com', 200]
]);
assert.strictEqual(validateBaseUrl('https://alpha.example').origin, 'https://alpha.example');
assert.strictEqual(validateBaseUrl('http://127.0.0.1:10000').origin, 'http://127.0.0.1:10000');
assert.throws(() => validateBaseUrl('http://alpha.example'), /HTTPS/);
assert.throws(() => validateBaseUrl('https://user:secret@alpha.example'), /credentials/);

console.log('alpha smoke planner tests passed');
