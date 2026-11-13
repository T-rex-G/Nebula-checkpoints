import { POLICY_PATH, readAuditPolicy } from '../../kepler/index.ts';
import { detectInText, RULE_NARRATION } from '../../quasar/index.ts';
import { ownEntry } from '../../../platform/values/fields.ts';
import { LIMITS, selectFiles as selectWith, type AuditLimits, type Selection, type TreeEntry } from '../domain/audit-files.ts';
import { analyse as analyseWith, scanRules as scanWith, type AnalyseInput, type AuditFile, type AuditPorts, type Scan } from '../domain/code-audit.ts';

/*
 * The audit wired to what it stands on: Exposure's detectors and what it
 * says of each, and Kepler's audit policy. The analysis receives them as
 * ports, so its decisions never depend on how another module is built; here
 * they are the real ones, and these are the functions the rest of the server
 * calls.
 */
export const AUDIT_PORTS: AuditPorts = Object.freeze({
  detectSecrets: (text: string) => detectInText({ text }).candidates,
  narrationOf: (rule: string) => ownEntry(RULE_NARRATION, rule),
  readAuditPolicy
});

/* Which files an audit reads, the repository's own audit policy among the first. */
export function selectFiles<E extends TreeEntry>(entries: readonly E[], limits: AuditLimits = LIMITS): Selection<E> {
  return selectWith(entries, limits, POLICY_PATH);
}

export function analyse(input: AnalyseInput) {
  return analyseWith(input, AUDIT_PORTS);
}

export function scanRules(files: readonly AuditFile[] | null | undefined): Scan {
  return scanWith(files, AUDIT_PORTS);
}
