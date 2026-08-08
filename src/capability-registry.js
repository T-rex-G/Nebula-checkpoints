'use strict';
const fs = require('fs');

class CapabilityError extends Error {
  constructor(message, code, status = 409) {
    super(message);
    this.name = 'CapabilityError';
    this.code = code;
    this.status = status;
  }
}

const FEATURE_RX = /^[a-z][a-z0-9.-]{1,80}$/;
const PROVIDER_RX = /^(github|gitlab|gitea)$/;
const CAPABILITY_STATUSES = Object.freeze(['Supported', 'Experimental', 'Unavailable']);
const EVIDENCE_STATES = Object.freeze(['Provider-verified', 'Deterministic', 'Inferred', 'Stale', 'Unavailable']);
const LEGACY = Object.freeze({
  prs: 'pulls.read', issues: 'issues.read', releases: 'releases.read',
  actions: 'workflows.read', lfs: 'lfs', tm: 'recovery',
  batch: 'file.batch', search: 'search', notif: 'notifications', compare: 'recovery'
});

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function hasExactVocabulary(value, expected) {
  return Array.isArray(value) && value.length === expected.length &&
    new Set(value).size === expected.length && expected.every(entry => value.includes(entry));
}

function validateCapabilityDocument(input) {
  if (!input || input.schemaVersion !== '1.0.0') throw new TypeError('capability schemaVersion must be 1.0.0');
  if (input.release !== '5.3.0-alpha.17.0') throw new TypeError('capability release must match 5.3.0-alpha.17.0');
  if (!hasExactVocabulary(input.statuses, CAPABILITY_STATUSES)) {
    throw new TypeError('capability statuses must be exactly Supported, Experimental, Unavailable');
  }
  if (!hasExactVocabulary(input.evidenceStates, EVIDENCE_STATES)) {
    throw new TypeError('capability evidenceStates must be exactly Provider-verified, Deterministic, Inferred, Stale, Unavailable');
  }
  if (!input.defaults || input.defaults.status !== 'Unavailable') {
    throw new TypeError('default capability status must be Unavailable');
  }
  if (input.defaults.evidenceState !== 'Unavailable') {
    throw new TypeError('default capability evidenceState must be Unavailable');
  }
  const statuses = new Set(CAPABILITY_STATUSES);
  const evidence = new Set(EVIDENCE_STATES);
  for (const provider of Object.keys(input.providers || {})) {
    if (!PROVIDER_RX.test(provider)) throw new TypeError(`unsupported capability provider: ${provider}`);
    for (const [deployment, features] of Object.entries(input.providers[provider] || {})) {
      if (deployment !== 'hosted-alpha') throw new TypeError(`unsupported deployment profile: ${deployment}`);
      for (const [feature, tuple] of Object.entries(features || {})) {
        if (!FEATURE_RX.test(feature)) throw new TypeError(`invalid capability feature: ${feature}`);
        if (!Array.isArray(tuple) || tuple.length !== 3) throw new TypeError(`capability ${feature} must be [status,evidenceState,reason]`);
        if (!statuses.has(tuple[0])) throw new TypeError(`invalid capability status: ${tuple[0]}`);
        if (!evidence.has(tuple[1])) throw new TypeError(`invalid evidence state: ${tuple[1]}`);
        if (!String(tuple[2] || '').trim()) throw new TypeError(`capability ${feature} requires a reason`);
      }
    }
  }
  return deepFreeze(JSON.parse(JSON.stringify(input)));
}

function loadCapabilityDocument(file) {
  return validateCapabilityDocument(JSON.parse(fs.readFileSync(file, 'utf8')));
}

function resolveCapability(document, context) {
  const provider = String(context.provider || 'github').toLowerCase();
  const deployment = String(context.deployment || 'hosted-alpha');
  const feature = String(context.feature || '');
  const tuple = document.providers?.[provider]?.[deployment]?.[feature];
  const fallback = document.defaults;
  const [status, evidenceState, reason] = tuple || [fallback.status, fallback.evidenceState, fallback.reason];
  return deepFreeze({
    feature, provider, authority: String(context.authority || ''),
    deployment, status, evidenceState, reason, limits: Object.freeze({ ...(fallback.limits || {}) })
  });
}

function projectCapabilities(document, context) {
  const provider = String(context.provider || 'github').toLowerCase();
  const deployment = String(context.deployment || 'hosted-alpha');
  const features = {};
  for (const feature of Object.keys(document.providers?.[provider]?.[deployment] || {}).sort()) {
    features[feature] = resolveCapability(document, { ...context, provider, deployment, feature });
  }
  return deepFreeze({ provider, authority: String(context.authority || ''), deployment, features });
}

function assertCapabilityAvailable(document, context) {
  const resolved = resolveCapability(document, context);
  if (resolved.status === 'Unavailable') {
    throw new CapabilityError(resolved.reason, 'PROVIDER_CAPABILITY_UNAVAILABLE');
  }
  if (resolved.status === 'Experimental' && context.allowExperimental !== true) {
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
