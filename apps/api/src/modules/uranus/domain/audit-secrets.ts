import type { DetectedCandidate, RuleNarration } from '../../quasar/index.ts';
import { isTestPath } from './audit-files.ts';
import type { RuleFile, RuleHit } from './line-rules.ts';

/* Exposure's detectors and what it says of each, as the audit is handed them: the module's wiring passes Quasar's own. */
export interface SecretPorts {
  readonly detectSecrets: (text: string) => readonly DetectedCandidate[];
  readonly narrationOf: (rule: string) => RuleNarration | undefined;
}

/* A committed credential: the detector's kind of credential in words, never its value. */
export interface SecretHit extends RuleHit {
  readonly detail: { readonly credential: string };
}

/* ---- Secrets ------------------------------------------------------------------ */

/*
 * What kind of credential, in words, from the narration Exposure keeps for
 * each detector: its consequence opens by naming the thing.
 */
function credentialKind(rule: string, narrationOf: SecretPorts['narrationOf']): string {
  const narration = narrationOf(rule);
  const named = narration ? /^(?:An?|The) (.+?) (?:is|are|was|were) /.exec(narration.consequence)?.[1] : undefined;
  const kind = named !== undefined && named.length <= 48 ? named : 'provider secret';
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

/*
 * Every credential in a file, as a detector name and a line. The detector
 * hands back the matched text so Exposure can verify it; here nothing is kept
 * but where it matched and what kind it is, and the candidate goes out of
 * scope with this call.
 */
/*
 * A connection string to the machine itself or to a CI service container --
 * localhost, a loopback address, a compose service called db -- carries a
 * throwaway password for a database nobody else can reach. Exposure still
 * lists it; the audit does not grade an application on it.
 */
const LOCAL_URL = /@(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|host\.docker\.internal|postgres|postgresql|mysql|mariadb|mongo|mongodb|redis|db|database)(:\d+)?[/?\s'"`]|@(localhost|127\.0\.0\.1)$/i;
const URL_RULES = new Set(['authenticated-url', 'database-url-password']);

export function secretFindings(file: RuleFile, { detectSecrets, narrationOf }: SecretPorts): SecretHit[] {
  /* Tests hold fixtures on purpose, and are not the application; Exposure reads them. */
  if (isTestPath(file.path)) return [];
  const out: SecretHit[] = [];
  let lines: string[] | null = null;
  for (const candidate of detectSecrets(file.text)) {
    const narration = narrationOf(candidate.rule);
    const severity = narration ? narration.severity : 'serious';
    const detail = { credential: credentialKind(candidate.rule, narrationOf) };
    for (const occurrence of candidate.occurrences.slice(0, 3)) {
      if (!Number.isInteger(occurrence.line)) continue;
      if (URL_RULES.has(candidate.rule)) {
        lines = lines || file.text.split('\n');
        if (LOCAL_URL.test(lines[occurrence.line - 1] || '')) continue;
      }
      out.push({ rule: 'SCR-001', line: occurrence.line, severity, detail });
    }
  }
  return out;
}
