'use strict';
const assert = require('assert');
const path = require('path');
const {
  CapabilityError,
  validateCapabilityDocument,
  loadCapabilityDocument,
  resolveCapability,
  projectCapabilities,
  assertCapabilityAvailable,
  legacyCapsFor
} = require('../src/capability-registry');

function capabilityDocument(overrides = {}) {
  return {
    schemaVersion: '1.0.0',
    release: '5.3.0-alpha.17.0',
    statuses: ['Supported', 'Experimental', 'Unavailable'],
    evidenceStates: ['Provider-verified', 'Deterministic', 'Inferred', 'Stale', 'Unavailable'],
    defaults: {
      status: 'Unavailable',
      evidenceState: 'Unavailable',
      reason: 'This feature is not qualified for this provider and deployment.',
      limits: {}
    },
    providers: {
      github: {
        'hosted-alpha': {
          'future.feature': ['Supported', 'Provider-verified', 'Qualified test feature.']
        }
      }
    },
    ...overrides
  };
}

const futureFeature = {
  provider: 'github', authority: 'github.com', deployment: 'hosted-alpha', feature: 'future.feature'
};

assert.throws(
  () => assertCapabilityAvailable(validateCapabilityDocument(capabilityDocument({
    statuses: ['Enabled'],
    evidenceStates: ['Observed'],
    providers: {
      github: {
        'hosted-alpha': {
          'future.feature': ['Enabled', 'Observed', 'An unqualified future capability.']
        }
      }
    }
  })), futureFeature),
  /capability statuses must be exactly/,
  'self-declared status vocabularies must be rejected before a decision is served'
);

assert.throws(
  () => assertCapabilityAvailable(validateCapabilityDocument(capabilityDocument({
    evidenceStates: ['Observed'],
    providers: {
      github: {
        'hosted-alpha': {
          'future.feature': ['Supported', 'Observed', 'An unqualified future capability.']
        }
      }
    }
  })), futureFeature),
  /capability evidenceStates must be exactly/,
  'self-declared evidence vocabularies must be rejected before a decision is served'
);

assert.throws(
  () => resolveCapability(validateCapabilityDocument(capabilityDocument({
    defaults: {
      status: 'Supported', evidenceState: 'Unavailable', reason: 'Unsafe fallback.', limits: {}
    }
  })), { ...futureFeature, feature: 'unknown.feature' }),
  /default capability status must be Unavailable/,
  'a supported fallback must be rejected before an unknown feature is resolved'
);

assert.throws(
  () => resolveCapability(validateCapabilityDocument(capabilityDocument({
    defaults: {
      status: 'Unavailable', evidenceState: 'Provider-verified', reason: 'Unsafe fallback.', limits: {}
    }
  })), { ...futureFeature, feature: 'unknown.feature' }),
  /default capability evidenceState must be Unavailable/,
  'a verified fallback must be rejected before an unknown feature is resolved'
);

const registryDocument = require('../config/public-alpha-capabilities.json');
const document = loadCapabilityDocument(path.join(__dirname, '..', 'config', 'public-alpha-capabilities.json'));
assert.strictEqual(document.schemaVersion, '1.0.0');
assert.deepStrictEqual(document.statuses, ['Supported', 'Experimental', 'Unavailable']);
assert.deepStrictEqual(document.evidenceStates, ['Provider-verified', 'Deterministic', 'Inferred', 'Stale', 'Unavailable']);

const githubWrite = resolveCapability(document, {
  provider: 'github', authority: 'github.com', deployment: 'hosted-alpha', feature: 'file.write'
});
assert.strictEqual(githubWrite.status, 'Supported');
assert.strictEqual(githubWrite.evidenceState, 'Provider-verified');

/*
 * The experimental opt-in, shown on whichever capability is still
 * experimental rather than on a named one.
 *
 * Naming one meant rewriting this test every time the live harness promoted
 * it -- rate.read, then pulls.read -- and a promoted capability cannot stand
 * for the unpromoted case. Reading the registry keeps the demonstration
 * honest as the set shrinks, and says so when it finally empties.
 */
const experimentalFeature = Object.entries(registryDocument.providers.github['hosted-alpha'])
  .find(([, tuple]) => tuple[0] === 'Experimental' && tuple[1] === 'Inferred');
assert(
  experimentalFeature,
  'no GitHub capability is experimental any more; this demonstration needs rewriting'
);
const githubExperimentalContext = {
  provider: 'github', authority: 'github.com', deployment: 'hosted-alpha', feature: experimentalFeature[0]
};
const githubExperimental = resolveCapability(document, githubExperimentalContext);
assert.strictEqual(githubExperimental.status, 'Experimental');
assert.strictEqual(githubExperimental.evidenceState, 'Inferred');
assert.throws(
  () => assertCapabilityAvailable(document, githubExperimentalContext),
  error => error instanceof CapabilityError && error.code === 'PROVIDER_CAPABILITY_EXPERIMENTAL'
);
assert.strictEqual(
  assertCapabilityAvailable(document, { ...githubExperimentalContext, allowExperimental: true }).status,
  'Experimental'
);

const githubRate = resolveCapability(document, {
  provider: 'github', authority: 'github.com', deployment: 'hosted-alpha', feature: 'rate.read'
});
assert.strictEqual(githubRate.status, 'Supported');
assert.strictEqual(githubRate.evidenceState, 'Provider-verified');
for (const provider of ['gitlab', 'gitea']) {
  const rate = resolveCapability(document, {
    provider,
    authority: `${provider}.example.com`,
    deployment: 'hosted-alpha',
    feature: 'rate.read'
  });
  assert.strictEqual(rate.status, 'Unavailable');
  assert.strictEqual(rate.evidenceState, 'Unavailable');
  assert.strictEqual(rate.reason, 'Rate-limit reads are qualified only for GitHub in the hosted alpha.');
}

const giteaActions = resolveCapability(document, {
  provider: 'gitea', authority: 'gitea.example.com', deployment: 'hosted-alpha', feature: 'workflows.read'
});
assert.strictEqual(giteaActions.status, 'Unavailable');
assert.match(giteaActions.reason, /not qualified/i);

const giteaBatchReason = 'Gitea batch mutation is unavailable; only single-file Contents API write and delete are provider-qualified.';
const giteaBatch = resolveCapability(document, {
  provider: 'gitea', authority: 'gitea.example.com', deployment: 'hosted-alpha', feature: 'file.batch'
});
assert.strictEqual(giteaBatch.status, 'Unavailable');
assert.strictEqual(giteaBatch.evidenceState, 'Unavailable');
assert.strictEqual(giteaBatch.reason, giteaBatchReason);
assert.throws(
  () => assertCapabilityAvailable(document, {
    provider: 'gitea', authority: 'gitea.example.com', deployment: 'hosted-alpha', feature: 'file.batch'
  }),
  error => error instanceof CapabilityError &&
    error.code === 'PROVIDER_CAPABILITY_UNAVAILABLE' &&
    error.status === 409 &&
    error.message === giteaBatchReason
);

assert.throws(
  () => assertCapabilityAvailable(document, {
    provider: 'gitea', authority: 'gitea.example.com', deployment: 'hosted-alpha', feature: 'workflows.read'
  }),
  error => error instanceof CapabilityError && error.code === 'PROVIDER_CAPABILITY_UNAVAILABLE' && error.status === 409
);

const projected = projectCapabilities(document, {
  provider: 'gitlab', authority: 'gitlab.com', deployment: 'hosted-alpha'
});
assert.strictEqual(projected.provider, 'gitlab');
assert(projected.features['repository.read']);
assert(!JSON.stringify(projected).includes('token'));

assert.deepStrictEqual(legacyCapsFor(document, {
  provider: 'gitea', authority: 'gitea.example.com', deployment: 'hosted-alpha'
}), {
  prs: false, issues: false, releases: false, actions: false,
  lfs: false, tm: false, batch: false, search: false, notif: false, compare: false
});
console.log('capability registry tests passed');
