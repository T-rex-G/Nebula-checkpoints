'use strict';
const fs = require('fs');
const { connectionRestriction } = require('../apps/api/src/modules/github-provider/index.ts');
const capability = require('../packages/contracts/src/capability.ts');
const { deepFreeze } = require('../packages/contracts/src/guards.ts');

class CapabilityError extends Error {
  constructor(message, code, status = 409) {
    super(message);
    this.name = 'CapabilityError';
    this.code = code;
    this.status = status;
  }
}

const { PROVIDER_RX, LEGACY_CAPABILITY_FEATURES: LEGACY } = capability;

/**
 * A malformed document is a deployment fault, so it stays a TypeError, as it always was.
 * @param {string} message
 * @returns {never}
 */
function refuseDocument(message) {
  throw new TypeError(message);
}

function validateCapabilityDocument(input) {
  return capability.validateCapabilityDocument(input, refuseDocument);
}

function loadCapabilityDocument(file) {
  return validateCapabilityDocument(JSON.parse(fs.readFileSync(file, 'utf8')));
}

function resolveCapability(document, context) {
  const provider = String(context.provider || 'github').toLowerCase();
  const deployment = String(context.deployment || 'hosted-alpha');
  const feature = String(context.feature || '');
  const tuple = PROVIDER_RX.test(provider) ? document.providers?.[provider]?.[deployment]?.[feature] : undefined;
  const fallback = document.defaults;
  const [status, evidenceState, reason] = tuple || [fallback.status, fallback.evidenceState, fallback.reason];
  const restriction = provider === 'github' && status !== 'Unavailable'
    ? connectionRestriction(context, feature) : null;
  return deepFreeze({
    feature, provider, authority: String(context.authority || ''),
    deployment, status: restriction ? 'Unavailable' : status, evidenceState,
    reason: restriction ? restriction.reason : reason,
    ...(restriction ? { availabilityCode: restriction.code, implementationStatus: status } : {}),
    limits: Object.freeze({ ...(fallback.limits || {}) })
  });
}

function projectCapabilities(document, context) {
  const provider = String(context.provider || 'github').toLowerCase();
  const deployment = String(context.deployment || 'hosted-alpha');
  const features = {};
  for (const feature of Object.keys(PROVIDER_RX.test(provider) ? document.providers?.[provider]?.[deployment] || {} : {}).sort()) {
    features[feature] = resolveCapability(document, { ...context, provider, deployment, feature });
  }
  return deepFreeze({ provider, authority: String(context.authority || ''), deployment, features });
}

function assertCapabilityAvailable(document, context, { qualification = [] } = {}) {
  const resolved = resolveCapability(document, context);
  if (resolved.status === 'Unavailable') {
    throw new CapabilityError(resolved.reason, resolved.availabilityCode || 'PROVIDER_CAPABILITY_UNAVAILABLE');
  }
  /*
   * Only what is Supported is served. The one exception is a qualification
   * deployment serving a capability that awaits the hosted proof only it can
   * give (src/qualification-capabilities.js); it is still reported as
   * Experimental everywhere it is described.
   */
  if (resolved.status === 'Experimental' && !qualification.includes(resolved.feature)) {
    throw new CapabilityError(resolved.reason, 'PROVIDER_CAPABILITY_EXPERIMENTAL');
  }
  return resolved;
}

function legacyCapsFor(document, context) {
  return Object.fromEntries(Object.entries(LEGACY).map(([key, feature]) => [
    key, resolveCapability(document, { ...context, feature }).status === 'Supported'
  ]));
}

module.exports = Object.freeze({
  CapabilityError, validateCapabilityDocument, loadCapabilityDocument,
  resolveCapability, projectCapabilities, assertCapabilityAvailable, legacyCapsFor
});
