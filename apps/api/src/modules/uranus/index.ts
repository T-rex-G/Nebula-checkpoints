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
export { assertAuditActive, auditRepository } from './application/audit-repository.ts';
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
