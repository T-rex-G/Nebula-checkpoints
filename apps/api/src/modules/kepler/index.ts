/*
 * Kepler: repository governance. Policies, their review and activation, the
 * evaluation the mutation gateway consults, exceptions, templates, the
 * digital twin, delivery of governance events, and the evidence each leaves.
 * The rest of the server reaches this module through this file only.
 */
export {
  CONTROL_CATALOG,
  ControlMappingError,
  LEGACY_CONTROL_CATALOG,
  TASK_14_CONTROL_CATALOG,
  TASK_19_CONTROL_CATALOG,
  TASK_20_CONTROL_CATALOG,
  TASK_21_CONTROL_CATALOG,
  TASK_22_CONTROL_CATALOG,
  TASK_23_CONTROL_CATALOG,
  deriveControlMapping,
  normalizeControlMapping,
  normalizeControlRefs
} from './domain/control-catalog.ts';
export type { ControlCatalog, ControlMapping, MappedControl, MappingSource } from './domain/control-catalog.ts';
export { CLOCK_STATES, DAY_MS, DEFAULT_SLA, POLICY_PATH, SLA_DAYS, clockOf, daysFor, readAuditPolicy, slaOf } from './domain/code-audit-policy.ts';
export type { AuditPolicy, ClockedFinding, FindingClock, Sla, SlaSeverity } from './domain/code-audit-policy.ts';
export {
  GOVERNANCE_AUDIT_GENESIS,
  GovernanceError,
  POLICY_DOCUMENT_MAX_BYTES,
  computeGovernanceReviewState,
  createGovernanceAuditRecord,
  normalizeApprovalPolicy,
  normalizeAuditDetails,
  normalizeIdentityKey,
  normalizePolicyDocument,
  normalizePolicyKey,
  normalizePolicyScope,
  normalizeUuid,
  policyDocumentHash,
  verifyGovernanceAuditChain
} from './domain/governance-model.ts';
export type { ApprovalPolicy, AuditChainVerdict, AuditRecord, AuditRecordInput, EnforcementMode, GovernanceReviewState, PolicyDocument, PolicyEffect, PolicyRule } from './domain/governance-model.ts';
export { projectGovernanceInterfaceAccess } from './domain/governance-interface.ts';
export type { GovernanceCapabilities, GovernanceInterfaceAccess } from './domain/governance-interface.ts';
export { GovernanceDigitalTwinError, MAX_HISTORY_LIMIT, buildPolicyDigitalTwinReadModel, normalizeDigitalTwinOptions } from './domain/governance-digital-twin.ts';
export type { DigitalTwinOptions, DigitalTwinReadModel } from './domain/governance-digital-twin.ts';
export { GovernanceSimulationError, evaluatePolicyDocument, normalizeSimulationRequest, simulatePolicyImpact } from './domain/governance-simulation.ts';
export type { PolicyEvaluation, ScenarioEvaluation, SimulationReport, SimulationRequest } from './domain/governance-simulation.ts';
export {
  EXCEPTION_KINDS,
  MAX_DURATION_MS,
  MAX_TARGET_BYTES,
  MIN_DURATION_MS,
  applyPolicyExceptions,
  computeExceptionState,
  normalizeActiveException,
  normalizeExceptionRequest,
  normalizeExceptionTarget
} from './domain/governance-exceptions.ts';
export type { ActiveException, ExceptionApplication, ExceptionKind, ExceptionOutcome, ExceptionRequest, ExceptionState } from './domain/governance-exceptions.ts';
export { GovernanceTemplateError, TEMPLATE_CATALOG, generateRepositoryBaseline, getPolicyTemplate, listPolicyTemplates, normalizeRepositoryFacts } from './domain/governance-templates.ts';
export type { PolicyTemplate, RepositoryBaseline, RepositoryFacts, TemplateCatalog, TemplateSummary } from './domain/governance-templates.ts';
export {
  DEFAULT_NOTIFICATION_EVENT_TYPES,
  GovernanceDeliveryError,
  MAX_EXPORT_BYTES,
  MAX_EXPORT_EVENTS,
  SUPPORTED_EVENT_TYPES,
  buildGovernanceEvent,
  buildSignedEvidenceExport,
  csvFormulaSafe,
  deriveWebhookSigningSecret,
  normalizeEventTypes,
  normalizeGovernanceEvent,
  normalizeNotificationPreferences,
  normalizeWebhookDefinition,
  normalizeWebhookDestination,
  signWebhookPayload,
  verifySignedEvidenceExport,
  verifyWebhookSignature
} from './delivery/governance-delivery.ts';
export type { GovernanceEvent, NotificationPreferences, SignedEvidenceExport, WebhookDefinition, WebhookDestination } from './delivery/governance-delivery.ts';
export { GUARDED_TO_WEBHOOK_CODE, MAX_WEBHOOK_BODY_BYTES, processWebhookDeliveryBatch, sendPinnedHttpsWebhook, startWebhookWorker } from './delivery/governance-webhook-worker.ts';
export type { WebhookDeliveryStore, WebhookWorker, WebhookWorkerOptions } from './delivery/governance-webhook-worker.ts';
export {
  GovernanceEnforcementError,
  POLICY_DECISION_GENESIS,
  activePolicySetStepEvaluator,
  createGovernanceRuntime,
  descriptorEvidenceHash,
  evaluateActivePolicySet,
  normalizeEnforcementMode,
  normalizePolicyDecision
} from './domain/governance-enforcement.ts';
export type { DecisionStore, GovernanceRuntime, GovernanceRuntimeOptions, PolicyDecision, PolicyEvaluationEntry } from './domain/governance-enforcement.ts';
export { GovernanceApiError, assertGovernanceAuthorization, createGovernanceApiService } from './application/governance-api.ts';
export type { GovernanceApiOptions, GovernanceApiStore, GovernanceContext, ServiceInput } from './application/governance-api.ts';
export { GovernanceStore, translateDatabaseError } from './persistence/governance-store.ts';
export type { AuthorizationEvidence, GovernanceActor, GovernanceStoreOptions } from './persistence/governance-store.ts';
