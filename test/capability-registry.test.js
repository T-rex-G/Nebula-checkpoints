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

/* The beta profile carries only what is Supported or plainly Unavailable: Experimental has no place in it. */
assert.throws(
  () => validateCapabilityDocument(capabilityDocument({ providers: { github: { 'hosted-beta': {
    'future.feature': ['Experimental', 'Deterministic', 'Not yet provider-verified.']
  } } } })),
  /hosted-beta cannot carry Experimental capability future\.feature/
);
assert.strictEqual(
  validateCapabilityDocument(capabilityDocument({ providers: { github: { 'hosted-beta': {
    'future.feature': ['Supported', 'Provider-verified', 'Qualified test feature.'],
    'later.feature': ['Unavailable', 'Unavailable', 'Not offered in this release.']
  } } } })).providers.github['hosted-beta']['future.feature'][0],
  'Supported'
);
assert.throws(
  () => validateCapabilityDocument(capabilityDocument({ providers: { github: { 'hosted-gamma': {} } } })),
  /unsupported deployment profile: hosted-gamma/
);

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
 * What is Experimental is refused, shown on a registry with one capability
 * held back. The real registry has none left -- the live harness and the
 * hosted gate promoted the last four -- so the refusal is demonstrated on a
 * copy rather than lost with them, and the copy says the real one is empty.
 */
assert.deepStrictEqual(
  Object.entries(registryDocument.providers.github['hosted-alpha']).filter(([, tuple]) => tuple[0] !== 'Supported'),
  [],
  'every GitHub capability in the hosted alpha is Supported'
);
const heldBack = structuredClone(registryDocument);
heldBack.providers.github['hosted-alpha']['live-events'] = ['Experimental', 'Inferred', 'Held back for this demonstration.'];
const experimentalDocument = validateCapabilityDocument(heldBack);
const githubExperimentalContext = {
  provider: 'github', authority: 'github.com', deployment: 'hosted-alpha', feature: 'live-events'
};
const githubExperimental = resolveCapability(experimentalDocument, githubExperimentalContext);
assert.strictEqual(githubExperimental.status, 'Experimental');
assert.strictEqual(githubExperimental.evidenceState, 'Inferred');
assert.throws(
  () => assertCapabilityAvailable(experimentalDocument, githubExperimentalContext),
  error => error instanceof CapabilityError && error.code === 'PROVIDER_CAPABILITY_EXPERIMENTAL'
);
/* There is no opt-in any more: what is not Supported is refused, whatever the caller asks for. */
assert.throws(
  () => assertCapabilityAvailable(experimentalDocument, { ...githubExperimentalContext, allowExperimental: true }),
  error => error instanceof CapabilityError && error.code === 'PROVIDER_CAPABILITY_EXPERIMENTAL'
);

const githubRate = resolveCapability(document, {
  provider: 'github', authority: 'github.com', deployment: 'hosted-alpha', feature: 'rate.read'
});
assert.strictEqual(githubRate.status, 'Supported');
assert.strictEqual(githubRate.evidenceState, 'Provider-verified');
assert.deepStrictEqual(Object.keys(document.providers), ['github']);
for (const provider of ['gitlab', 'gitea', 'unknown']) {
  const context = { provider, authority: `${provider}.example.com`, deployment: 'hosted-alpha' };
  for (const feature of Object.keys(document.providers.github['hosted-alpha'])) {
    const resolved = resolveCapability(document, { ...context, feature });
    assert.strictEqual(resolved.status, 'Unavailable');
    assert.strictEqual(resolved.evidenceState, 'Unavailable');
    assert.throws(() => assertCapabilityAvailable(document, { ...context, feature, allowExperimental: true }),
      error => error instanceof CapabilityError && error.code === 'PROVIDER_CAPABILITY_UNAVAILABLE');
  }
  assert.deepStrictEqual(projectCapabilities(document, context).features, {});
  assert(Object.values(legacyCapsFor(document, context)).every(value => value === false));
  const unsupportedDocument = structuredClone(document);
  unsupportedDocument.providers[provider] = structuredClone(document.providers.github);
  assert.throws(() => validateCapabilityDocument(unsupportedDocument), /unsupported capability provider/);
  assert.strictEqual(resolveCapability(unsupportedDocument, { ...context, feature: 'file.write' }).status, 'Unavailable');
  assert.deepStrictEqual(projectCapabilities(unsupportedDocument, context).features, {});
}

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
  /*
   * GitHub is Supported and Provider-verified. Detection, identity, storage and
   * verification are the product's own and fixture-tested end to end; the one
   * part that talks to the provider -- the reader -- is exercised by the
   * live-provider harness through the product's own module. The reason says
   * which evidence the claim rests on, as every claim here must.
   *
   * The controls that matter were never the status: a governance role on the
   * one route that records a human decision, and an explicit typed
   * confirmation on the one route that uses a discovered credential. A
   * capability status says how well proven a feature is; it is a poor
   * substitute for deciding who may do what.
   */
  {
    const github = resolveCapability(document, {
      provider: 'github', deployment: 'hosted-alpha', feature: 'exposure.scan'
    });
    assert.strictEqual(github.status, 'Supported');
    assert.strictEqual(github.evidenceState, 'Provider-verified');
    assert.match(github.reason, /live-provider harness/i, 'a claim must say what evidence it rests on');
    assertCapabilityAvailable(document, {
      provider: 'github', deployment: 'hosted-alpha', feature: 'exposure.scan'
    });

    /* Live events rest on the hosted gate's delivery check, and say so. */
    const liveEvents = resolveCapability(document, {
      provider: 'github', deployment: 'hosted-alpha', feature: 'live-events'
    });
    assert.deepStrictEqual([liveEvents.status, liveEvents.evidenceState], ['Supported', 'Provider-verified']);
    assert.match(liveEvents.reason, /hosted staging deployment/, 'a hosted claim must say where it was proven');
    assertCapabilityAvailable(document, { provider: 'github', deployment: 'hosted-alpha', feature: 'live-events' });

    /* What is Experimental still refuses a route, whether or not it asks to be let in. */
    for (const allowExperimental of [false, true]) {
      assert.throws(
        () => assertCapabilityAvailable(experimentalDocument, {
          provider: 'github', deployment: 'hosted-alpha', feature: 'live-events', allowExperimental
        }),
        error => error instanceof CapabilityError && error.code === 'PROVIDER_CAPABILITY_EXPERIMENTAL',
        `an experimental capability is refused (allowExperimental=${allowExperimental})`
      );
    }
  }

  for (const provider of ['gitlab', 'gitea']) {
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

}

console.log('capability registry tests passed');
