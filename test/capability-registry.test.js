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
/*
 * Exposure scanning is declared and deliberately Unavailable.
 *
 * The point of an entry that reports Unavailable is that it is an entry: the
 * registry's default for an unknown feature is also Unavailable, so a feature
 * nobody declared and a feature declared as not ready are indistinguishable
 * from a caller's view -- and one of them is a typo. Declaring it means the
 * reason is written down, and means raising the status later is a deliberate
 * edit rather than a side effect of a route appearing.
 *
 * The two non-GitHub providers carry a different reason on purpose. There is
 * no repository reader for them, and a guessed tree API would return nothing
 * and look successful, which for a security feature is worse than refusing.
 */
{
  const document = loadCapabilityDocument(
    path.join(__dirname, '..', 'config', 'public-alpha-capabilities.json')
  );
  for (const provider of ['github', 'gitlab', 'gitea']) {
    const resolved = resolveCapability(document, {
      provider, deployment: 'hosted-alpha', feature: 'exposure.scan'
    });
    assert.strictEqual(resolved.status, 'Unavailable', provider);
    assert.strictEqual(resolved.evidenceState, 'Unavailable', provider);
    assert(resolved.reason.length > 40, `${provider}: a status of Unavailable must say why`);

    /* And it cannot be asserted available, with or without the experimental
       allowance -- an Unavailable capability is not a weaker Experimental. */
    for (const allowExperimental of [false, true]) {
      assert.throws(
        () => assertCapabilityAvailable(document, {
          provider, deployment: 'hosted-alpha', feature: 'exposure.scan', allowExperimental
        }),
        error => error instanceof CapabilityError,
        `${provider}: allowExperimental=${allowExperimental}`
      );
    }
  }
  /* The providers without a reader say so, rather than repeating the generic
     "not wired up yet" that applies to the one that has it. */
  for (const provider of ['gitlab', 'gitea']) {
    assert.match(
      resolveCapability(document, { provider, deployment: 'hosted-alpha', feature: 'exposure.scan' }).reason,
      /reader/i,
      `${provider}: the reason must name what is actually missing`
    );
  }
}

console.log('capability registry tests passed');
