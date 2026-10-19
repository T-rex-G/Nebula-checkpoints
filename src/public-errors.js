'use strict';

const crypto = require('crypto');
const envelope = require('../packages/contracts/src/api-envelope.ts');

/* The body every refusal is sent as is the API envelope contract; minting its support reference is this platform's part. */
function createCorrelationId(randomBytes = crypto.randomBytes) {
  return `nvx-${randomBytes(8).toString('hex')}`;
}

function publicErrorBody(error, context = {}) {
  return envelope.publicErrorBody(error, context, createCorrelationId);
}

module.exports = Object.freeze({ createCorrelationId, publicErrorBody });
