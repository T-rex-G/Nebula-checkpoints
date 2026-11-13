/*
 * A finding as it leaves the server.
 *
 * The narration travels with the finding rather than being rebuilt in the
 * browser. It is a lookup table, so the words are the same wherever they are
 * read, and keeping it server-side means the table is reviewed in one place
 * rather than in two languages.
 *
 * Both sentences, and they are not the same sentence. `narration` says what
 * the credential is and what it costs; `dispositionNarration` says what this
 * repository has since decided about it. A screen that shows the first and
 * prints the second as a slug ("Status: accepted-risk") makes the decision
 * look like machine bookkeeping rather than something a named person did.
 */
import { member } from '../../../platform/values/fields.ts';
import type { Fields } from '../../../platform/values/fields.ts';
import { ADAPTERS as VERIFICATION_ADAPTERS } from '../client/credential-verification.ts';
import { describeDisposition, describeFinding, safeDisplayPath } from '../domain/exposure-narration.ts';

/* The rules a verifier exists for. */
export const EXPOSURE_VERIFIABLE_RULES: ReadonlySet<unknown> = new Set<unknown>(Object.values(VERIFICATION_ADAPTERS).map(adapter => adapter.rule));

export function exposureFindingPayload(finding: unknown): Fields | null {
  if (!finding) return null;
  const displayPath = safeDisplayPath(String(member(finding, 'path') || ''));
  return {
    ...Object(finding),
    path: displayPath,
    narration: describeFinding(finding),
    dispositionNarration: describeDisposition(member(finding, 'disposition')),
    /*
     * The path as a screen may show it. A file can be named with a credential
     * -- `ghp_...txt` is not unheard of -- and a summary row that printed the
     * raw path would publish exactly what the rest of this payload is careful
     * never to carry.
     */
    displayPath,
    /*
     * Which questions this finding can be asked. Three verifiers exist and
     * dozens of rules; offering "check whether it still works" on a finding
     * nothing can check would send a reader through a two-press confirmation
     * to be told "unverifiable" every time.
     */
    verifiable: EXPOSURE_VERIFIABLE_RULES.has(member(finding, 'rule')),
    probeable: member(finding, 'rule') === 'supabase-anon-key'
  };
}
