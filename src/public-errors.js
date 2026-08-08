'use strict';

const crypto = require('crypto');

const SAFE_CODE = /^[A-Z][A-Z0-9_]{2,80}$/;
const SAFE_CORRELATION = /^nvx-[0-9a-f]{16}$/;
const SECRET_SIGNAL = /(?:gh[pousr]_|glpat-|(?:access[_ -]?)?token\s*[=:]|authorization\s*:|bearer\s+|pass(?:word)?\s*[=:]|private[_ -]?key|client[_ -]?secret|session[_ -]?cookie|postgres(?:ql)?:\/\/)/i;

function clean(value, max) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, max);
}

function createCorrelationId(randomBytes = crypto.randomBytes) {
  return `nvx-${randomBytes(8).toString('hex')}`;
}

function publicErrorBody(error, context = {}) {
  const correlationId = SAFE_CORRELATION.test(String(context.correlationId || ''))
    ? context.correlationId
    : createCorrelationId();
  const raw = clean(error && error.message, 300);
  const known = SAFE_CODE.test(String(error && error.code || ''));
  const safeMessage = raw && !SECRET_SIGNAL.test(raw) && known
    ? raw
    : 'Operation could not be completed';
  const changed = error && error.providerChanged;
  return Object.freeze({
    error: safeMessage,
    code: known ? error.code : 'OPERATION_FAILED',
    correlationId,
    providerChanged: changed === true ? 'yes' : changed === false ? 'no' : 'unknown',
    safeState: clean(error && error.safeState, 300) || (
      changed === false
        ? 'No provider change was confirmed.'
        : 'The final provider state is not yet confirmed.'
    ),
    nextAction: clean(error && error.nextAction, 300)
      || 'Retry once. If the problem remains, copy the support correlation ID.'
  });
}

module.exports = Object.freeze({ createCorrelationId, publicErrorBody });
