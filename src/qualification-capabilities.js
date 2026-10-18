'use strict';

/*
 * A staging deployment that GitHub can reach may serve a capability that
 * still awaits the proof only such a deployment can give.
 *
 * Every other path serves Supported capabilities only (capability-registry.js
 * says why). This is the single exception, and it is narrow on purpose:
 *
 *   - it names features, never a blanket "serve Experimental";
 *   - only features listed here as awaiting hosted proof can be named, and
 *     only while the registry still calls them Experimental -- a feature that
 *     has been promoted, or that never needed a reachable deployment, makes
 *     the server refuse to start rather than quietly serve it;
 *   - the deployment says so: /api/config reports the features it serves this
 *     way, and the cohort readiness gate (scripts/check-deployment-readiness.js)
 *     refuses a deployment that carries any, so production never runs with it.
 *
 * Live events were the case -- a webhook delivery needs an address GitHub
 * can reach, which no CI runner has -- until the hosted gate proved them and
 * they were promoted. No capability awaits hosted proof now, so any value is
 * refused at start: a deployment still carrying the variable is one whose
 * configuration was not brought up to date with the promotion.
 */
const AWAITING_HOSTED_PROOF = Object.freeze([]);
const VARIABLE = 'NV_QUALIFICATION_CAPABILITIES';

function loadQualificationCapabilities(env, document, { provider = 'github', deployment = 'hosted-alpha' } = {}) {
  const raw = String(env && env.NV_QUALIFICATION_CAPABILITIES || '').trim();
  if (!raw) return Object.freeze([]);
  const features = [...new Set(raw.split(',').map(item => item.trim()).filter(Boolean))].sort();
  for (const feature of features) {
    if (!AWAITING_HOSTED_PROOF.includes(feature)) {
      throw new Error(AWAITING_HOSTED_PROOF.length
        ? `${VARIABLE} may name only ${AWAITING_HOSTED_PROOF.join(', ')}; ${feature} is not awaiting hosted proof`
        : `${VARIABLE} names ${feature}, but no capability awaits hosted proof; remove it`);
    }
    const tuple = document && document.providers && document.providers[provider]
      && document.providers[provider][deployment] && document.providers[provider][deployment][feature];
    if (!Array.isArray(tuple) || tuple[0] !== 'Experimental') {
      throw new Error(`${VARIABLE} names ${feature}, which is no longer awaiting qualification; remove it`);
    }
  }
  return Object.freeze(features);
}

module.exports = Object.freeze({ AWAITING_HOSTED_PROOF, VARIABLE, loadQualificationCapabilities });
