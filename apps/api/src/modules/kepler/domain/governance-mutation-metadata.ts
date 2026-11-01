/*
 * What the evidence ledger records about a governance-shaped change: the
 * identifiers it names, bounded, and the few facts a decision turns on --
 * never the text a person wrote. Exposure and code-audit decisions are
 * recorded the same way, since they too are decisions this server makes
 * about its own rows rather than changes to a repository.
 */
import { createHash } from 'node:crypto';
import { cleanText } from '../../../platform/values/text.ts';

interface MetadataRequest {
  readonly body?: unknown;
  readonly params?: unknown;
}

/* A request body, read field by field; every field is bounded where it is read. */
type Body = Readonly<Record<string, unknown>>;

export function governanceMutationMetadata(req: MetadataRequest, action: string): Record<string, unknown> {
  const body = (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : {}) as Body;
  const params = req.params as Readonly<Record<string, unknown>>;
  const boundedId = (value: unknown) => cleanText(String(value || ''), 80);
  switch (action) {
    case 'governance.policy.create':
      return { policyKey: cleanText(String(body.policyKey || ''), 64) };
    case 'governance.draft.create':
      return { policyId: boundedId(params.policyId) };
    case 'governance.draft.update':
    case 'governance.draft.submit': {
      const expectedRevision = Number(body.expectedRevision);
      return {
        policyId: boundedId(params.policyId),
        draftId: boundedId(params.draftId),
        expectedRevision: Number.isSafeInteger(expectedRevision) && expectedRevision >= 0 ? expectedRevision : null
      };
    }
    case 'governance.reviewer.assign':
      return {
        policyId: boundedId(params.policyId),
        versionId: boundedId(params.versionId)
      };
    case 'governance.approval.decide':
      return {
        policyId: boundedId(params.policyId),
        versionId: boundedId(params.versionId),
        decision: cleanText(String(body.decision || ''), 16).toLowerCase()
      };
    case 'governance.exception.request': {
      const rawRuleIds = Array.isArray(body.ruleIds) ? body.ruleIds : [];
      const ruleIds = rawRuleIds.slice(0, 51)
        .map((value: unknown) => cleanText(String(value || ''), 64).toLowerCase())
        .sort();
      return {
        policyId: boundedId(params.policyId),
        versionId: boundedId(params.versionId),
        kind: cleanText(String(body.kind || ''), 16).toLowerCase(),
        action: cleanText(String(body.action || ''), 100).toLowerCase(),
        ruleIds: ruleIds,
        target: body.target && typeof body.target === 'object' && !Array.isArray(body.target) ? body.target : null,
        ruleCount: rawRuleIds.length,
        expiresAt: cleanText(String(body.expiresAt || ''), 80)
      };
    }
    case 'governance.exception.decide':
      return {
        exceptionId: boundedId(params.exceptionId),
        decision: cleanText(String(body.decision || ''), 16).toLowerCase()
      };
    case 'governance.exception.revoke':
      return { exceptionId: boundedId(params.exceptionId) };
    case 'governance.policy.deactivate':
    case 'governance.policy.archive': {
      const expectedRevision = Number(body.expectedRevision);
      return {
        policyId: boundedId(params.policyId),
        expectedRevision: Number.isSafeInteger(expectedRevision) && expectedRevision >= 0 ? expectedRevision : null
      };
    }
    case 'governance.policy.restore':
      return { policyId: boundedId(params.policyId) };
    case 'governance.draft.discard': {
      const expectedRevision = Number(body.expectedRevision);
      return {
        policyId: boundedId(params.policyId),
        draftId: boundedId(params.draftId),
        expectedRevision: Number.isSafeInteger(expectedRevision) && expectedRevision >= 0 ? expectedRevision : null
      };
    }
    case 'governance.version.withdraw':
      return { policyId: boundedId(params.policyId), versionId: boundedId(params.versionId) };
    case 'governance.reset':
      /* Whether the typed confirmation matched, not what was typed. */
      return {
        confirmed: cleanText(String(body.confirm || ''), 400).toLowerCase() === `${params.owner}/${params.repo}`.toLowerCase()
      };
    case 'governance.policy.activate':
    case 'governance.policy.rollback': {
      const expectedRevision = Number(body.expectedRevision);
      const simulation = (body.simulation && typeof body.simulation === 'object' ? body.simulation : {}) as Body;
      return {
        policyId: boundedId(params.policyId),
        versionId: boundedId(params.versionId),
        expectedRevision: Number.isSafeInteger(expectedRevision) && expectedRevision >= 0 ? expectedRevision : null,
        simulationHash: cleanText(String(simulation.simulationHash || ''), 64).toLowerCase()
      };
    }
    /*
     * The two exposure actions that contact somebody else. Every other one
     * records only that it happened, which is right for a decision this server
     * makes about its own rows -- but a request refused before it reached the
     * store (an unconfirmed press, a key that is not the anonymous one, a file
     * with no project beside it) leaves no attempt row anywhere, so the ledger
     * is the only place that remembers it was asked for.
     *
     * The column names stay out. The count bounds the request, and the probe
     * table already holds the names for the probes that actually ran.
     */
    case 'exposure.credential.verify':
      return { fingerprint: boundedId(params.fingerprint) };
    /* The decision as asked for: the words chosen from the list, never anything the repository wrote. */
    case 'code-audit.finding.triage': {
      const days = Number(body.expiresInDays);
      return {
        findingId: boundedId(params.findingId),
        rule: cleanText(String(body.rule || ''), 16),
        disposition: cleanText(String(body.disposition || ''), 20).toLowerCase(),
        reason: cleanText(String(body.reason || ''), 40).toLowerCase(),
        expiresInDays: Number.isSafeInteger(days) && days > 0 && days <= 3650 ? days : null
      };
    }
    case 'code-audit.finding.reopen':
      return { findingId: boundedId(params.findingId) };
    case 'exposure.readability.probe':
      return {
        fingerprint: boundedId(params.fingerprint),
        relation: cleanText(String(body.relation || ''), 64),
        columnCount: Array.isArray(body.projection) ? Math.min(body.projection.length, 100) : 0
      };
    case 'governance.notification.preferences.update':
      return {
        enabled: body.enabled === true,
        eventCount: Array.isArray(body.eventTypes) ? Math.min(body.eventTypes.length, 100) : 0
      };
    case 'governance.notification.read': {
      const throughSeq = Number(body.throughSeq);
      return { throughSeq: Number.isSafeInteger(throughSeq) && throughSeq >= 0 ? throughSeq : null };
    }
    case 'governance.webhook.create':
    case 'governance.webhook.update':
      return {
        webhookId: boundedId(params.webhookId),
        destinationHash: createHash('sha256').update(String(body.url || '')).digest('hex'),
        eventCount: Array.isArray(body.eventTypes) ? Math.min(body.eventTypes.length, 100) : 0,
        enabled: body.enabled !== false
      };
    case 'governance.webhook.rotate':
    case 'governance.webhook.delete':
      return { webhookId: boundedId(params.webhookId) };
    case 'governance.audit.export.create': {
      const afterEventSeq = Number(body.afterEventSeq);
      const throughEventSeq = Number(body.throughEventSeq);
      return {
        format: cleanText(String(body.format || ''), 8).toLowerCase(),
        afterEventSeq: Number.isSafeInteger(afterEventSeq) && afterEventSeq >= 0 ? afterEventSeq : null,
        throughEventSeq: Number.isSafeInteger(throughEventSeq) && throughEventSeq >= 0 ? throughEventSeq : null
      };
    }
    default:
      return {};
  }
}
