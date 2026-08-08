'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
assert(server.includes("require('./src/public-errors')"));
assert(server.includes("res.setHeader('X-Nebulaverse-Correlation-Id'"));
assert(server.includes('res.locals.correlationId'));
assert(server.includes('publicErrorBody(error'));
assert(!/const fail[\s\S]{0,300}\.json\(\{ error: (?:e|error)\.message/.test(server),
  'central fail helper must not expose raw errors');

const correlationStart = server.indexOf("res.setHeader('X-Nebulaverse-Correlation-Id'");
const loggingStart = server.indexOf('/* structured request logging */');
assert(correlationStart >= 0 && correlationStart < loggingStart,
  'correlation middleware must run before request logging');

console.log('public error server contract tests passed');
