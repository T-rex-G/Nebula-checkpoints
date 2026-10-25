/*
 * Uranus, the repository audit, as one module: the rules that read a file,
 * the tracer that follows a value from what a caller sends to what misuses
 * it in JavaScript, TypeScript, Python, Go, Java and PHP, the map of every
 * endpoint and what guards it, the dependencies, their advisories, their
 * licences and how close each is to the running code -- and the audit of a
 * repository through the guarded reader that puts them together.
 *
 * The other modules, and the server code still in src/, reach it here only.
 */
import * as licenceRules from './domain/licences.ts';
import * as licenceLookup from './client/licence-lookup.ts';
import * as worker from './application/audit-worker.ts';
import * as watch from './application/audit-watch.ts';
import * as gate from './application/merge-gate.ts';
import * as triageRules from './domain/audit-triage.ts';
import * as historyRows from './persistence/audit-history-rows.ts';
import * as historyRecords from './persistence/audit-history-records.ts';
import { CodeAuditHistory } from './persistence/audit-history-store.ts';
import { CodeAuditTriage, LIMITS as TRIAGE_LIMITS } from './persistence/audit-triage-store.ts';

export { ENGINE, CATEGORIES, RULES, CRITICAL_CAP, SERIOUS_CAPS, SEVERITY_PENALTY, SEVERITY_ORDER } from './domain/audit-catalog.ts';
export type { Category, CategoryId, Grade, RuleDefinition, Severity } from './domain/audit-catalog.ts';
export { LIMITS } from './domain/audit-files.ts';
export type { AuditLimits, Selection, TreeEntry } from './domain/audit-files.ts';
export { gradeOf, mergeScans, priorities, score } from './domain/code-audit.ts';
export type { AnalyseInput, AuditFile, AuditPorts, Component, RegistryAnswer, Scan, ScoreReading } from './domain/code-audit.ts';
export { AUDIT_PORTS, analyse, scanRules, selectFiles } from './application/audit-engine.ts';
export { PATTERN_RULES } from './domain/audit-findings.ts';
export type { Detail, Finding, RawItem } from './domain/audit-findings.ts';
export { LEDGER } from './domain/audit-ledger.ts';
export type { Control, LedgerLine } from './domain/audit-ledger.ts';
export { sqlStatements } from './domain/audit-database.ts';
export { advisoryKey, compareVersions, dependencyInventory, introducedThrough, normalizePypi, rangeCeiling, rangeFloor, readDependencies } from './domain/dependencies.ts';
export type { DependencyReading, InventoryEntry, LockGraph } from './domain/dependencies.ts';
export { cvss3, describeAdvisory } from './domain/advisories.ts';
export type { Advisory, AdvisoryAnswer, AdvisoryDetail, ExploitAnswer } from './domain/advisories.ts';
export { fetchAdvisoryRecords, lookupAdvisories, lookupPackages, queryAdvisoryIds, registryUrl } from './client/advisory-lookup.ts';
export type { AdvisoryLookup, AuditTransport, RegistryLookup } from './client/advisory-lookup.ts';
export { assertAuditActive } from './domain/audit-cancellation.ts';
export { auditRepository } from './application/audit-repository.ts';
export type { AuditProgress, AuditReader, AuditRepositoryInput } from './application/audit-repository.ts';

/* The tracer, the surface map, reach and the lexers. */
export { analyseFlows } from './domain/uranus-flow.ts';
export type { FlowFile, FlowReading, FlowRecord } from './domain/uranus-flow.ts';
export { analyseSurface, reachOf } from './domain/uranus-surface.ts';
export { BANDS, TIERS, exploitedInProduction, jsPackageOf, pythonModules, riskOf, threatOf, tierOf, usageIndex } from './domain/uranus-reach.ts';
export { lexJs, lexPyTokens, lexPython, matching, opensWith, partners, splitArgs } from './domain/uranus-lex.ts';
export { createIntelCache, EPSS_URL, KEV_URL, lookupExploitIntel } from './client/exploit-intel.ts';
export type { IntelAnswer, IntelCache, IntelStatus } from './client/exploit-intel.ts';
export * as cfamily from './domain/uranus-cfamily.ts';
export * as surface from './domain/uranus-surface.ts';
export * as ecosystems from './domain/ecosystems.ts';
export * as exploitIntel from './client/exploit-intel.ts';
/* What each dependency may be used under: the rules and the deps.dev lookup, as one namespace. */
export const licences = Object.freeze({ ...licenceRules, ...licenceLookup });

/*
 * The audit's life after the analysis, each as one namespace with the names
 * it has always had -- several share a name such as LIMITS or SHAPE, so they
 * are not spread flat:
 *   - `auditWorker`: the analysis on a worker thread, bounded by heap and clock;
 *   - `auditWatch`: what has been published about the stored dependencies since,
 *     and the service that checks a branch's latest audit again;
 *   - `auditHistory`: the kept audits, their rows and how they read back;
 *   - `auditTriage`: the team's decisions, laid over an audit, and the merge gate.
 */
export const auditWorker = Object.freeze({ ...worker });
export const auditWatch = Object.freeze({ watchComponents: watch.watchComponents, createAuditWatch: watch.createAuditWatch, LIMITS: watch.LIMITS });
export const auditHistory = Object.freeze({
  CodeAuditHistory,
  CodeAuditHistoryError: historyRows.CodeAuditHistoryError,
  compactAudit: historyRows.compactAudit,
  compactAlert: historyRows.compactAlert,
  LIMITS: historyRows.LIMITS,
  SHAPE: historyRows.SHAPE,
  /* The shapes the routes answer with, for fixtures that stand in for the database. */
  serialize: Object.freeze({ audit: historyRecords.auditFromRow, finding: historyRecords.findingFromRow, alert: historyRecords.alertFromRow }),
  describeKept: historyRecords.describeKept,
  describeKeptAudit: historyRecords.describeKeptAudit,
  createAuditWatch: watch.createAuditWatch
});
export const auditTriage = Object.freeze({
  CodeAuditTriage,
  CodeAuditTriageError: triageRules.CodeAuditTriageError,
  DISPOSITIONS: triageRules.DISPOSITIONS,
  REASONS: triageRules.REASONS,
  EVENTS: triageRules.EVENTS,
  VOCABULARY: triageRules.VOCABULARY,
  LIMITS: TRIAGE_LIMITS,
  SHAPE: triageRules.SHAPE,
  normalizeDecision: triageRules.normalizeDecision,
  inForce: triageRules.inForce,
  applyTriage: triageRules.applyTriage,
  rescore: triageRules.rescore,
  openRows: triageRules.openRows,
  summarizeDecisions: triageRules.summarizeDecisions,
  GATE_REASONS: gate.GATE_REASONS,
  GATE_STATES: gate.GATE_STATES,
  evaluateMergeGate: gate.evaluateMergeGate,
  unavailableGate: gate.unavailableGate,
  gateAttributes: gate.gateAttributes,
  mergeAttributes: gate.mergeAttributes,
  previewMergePolicies: gate.previewMergePolicies
});
export type { WatchAlert, WatchOutcome, WatchedComponent } from './application/audit-watch.ts';
export type { Gate, GateAudit } from './application/merge-gate.ts';
export type { Decision, KeptRow } from './domain/audit-triage.ts';
export type { KeptAlert, KeptAudit, KeptComponent, KeptFinding } from './persistence/audit-history-records.ts';
export type { KeptAuditRead, RecordOutcome, WatchedAudit } from './persistence/audit-history-store.ts';
