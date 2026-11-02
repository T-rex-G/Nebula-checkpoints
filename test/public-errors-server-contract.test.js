'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { correlationId, structuredLogging } = require('../apps/api/src/http/pipeline/index.ts');
const { currentRoutePolicy } = require('./oracles/current-route-policy');

const root = path.join(__dirname, '..');
/*
 * The central failure answer is the HTTP layer's (apps/api/src/http/errors.ts).
 * That the composed server answers a failure under any module's route with
 * it is test/composition.test.js's; that the composition root hands every
 * route that takes a failure answer this one, and no other, is
 * test/composition-root.test.js's, over the root's syntax tree.
 */
const httpErrors = fs.readFileSync(path.join(root, 'apps', 'api', 'src', 'http', 'errors.ts'), 'utf8');
assert(httpErrors.includes('publicErrorBody(error'));
assert(!/function sendFailure[\s\S]{0,900}\.json\(\{ error: (?:e|error)\.message/.test(httpErrors),
  'central fail helper must not expose raw errors');

/* A request as the pipeline sees it, and a response that records what it was told. */
function exchange(headers = {}) {
  const res = new EventEmitter();
  res.headers = {};
  res.locals = {};
  res.statusCode = 200;
  res.setHeader = (name, value) => { res.headers[name.toLowerCase()] = value; };
  return { req: { headers, method: 'GET', path: '/api/version' }, res };
}
function run(step, req, res) {
  let passed = false;
  step(req, res, () => { passed = true; });
  assert(passed, 'a pipeline step must pass the request on');
}

/* Every answer carries one safe identity, and the logs and errors read the same one. */
{
  const { req, res } = exchange();
  run(correlationId(), req, res);
  assert.match(res.headers['x-nebulaverse-correlation-id'], /^nvx-[0-9a-f]{16}$/);
  assert.strictEqual(res.locals.correlationId, res.headers['x-nebulaverse-correlation-id']);
}
/* A well-formed identity a caller supplies is kept, so a support reference survives a retry. */
{
  const { req, res } = exchange({ 'x-nebulaverse-correlation-id': 'nvx-0123456789abcdef' });
  run(correlationId(), req, res);
  assert.strictEqual(res.locals.correlationId, 'nvx-0123456789abcdef');
}
/* Anything else is replaced, never echoed: the header is not a channel into the logs. */
for (const supplied of ['nvx-0123456789ABCDEF', 'nvx-0123', 'x'.repeat(40), 'nvx-0123456789abcdef\r\nSet-Cookie: a=b']) {
  const { req, res } = exchange({ 'x-nebulaverse-correlation-id': supplied });
  run(correlationId(), req, res);
  assert.notStrictEqual(res.locals.correlationId, supplied);
  assert.match(res.locals.correlationId, /^nvx-[0-9a-f]{16}$/);
}
/* The log line written when the answer has gone names the request by that identity. */
{
  const lines = [];
  const { req, res } = exchange();
  run(correlationId(), req, res);
  run(structuredLogging(line => lines.push(line)), req, res);
  res.statusCode = 204;
  res.emit('finish');
  assert.strictEqual(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.strictEqual(entry.correlationId, res.locals.correlationId);
  assert.deepStrictEqual([entry.m, entry.p, entry.s], ['GET', '/api/version', 204]);
}
/* Only API requests are logged: the page and its files are not request records. */
{
  const lines = [];
  const { req, res } = exchange();
  req.path = '/assets/app.js';
  run(structuredLogging(line => lines.push(line)), req, res);
  res.emit('finish');
  assert.deepStrictEqual(lines, []);
}

/* And the server installs the identity before the logging that reads it. */
const steps = currentRoutePolicy(root).sequence.filter(entry => entry.kind === 'middleware').map(entry => entry.label);
assert(steps.indexOf('correlation-id') > -1 && steps.indexOf('correlation-id') < steps.indexOf('structured-logging'),
  'correlation middleware must run before request logging');

console.log('public error server contract tests passed');
