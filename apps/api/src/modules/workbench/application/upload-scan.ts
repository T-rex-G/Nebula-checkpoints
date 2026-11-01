/*
 * Every uploaded file is scanned before it is written anywhere.
 *
 * A file a signature rule matches is refused with 422 MALWARE_DETECTED,
 * naming the rules, and -- when the upload was for a repository -- recorded on
 * that repository's evidence chain with the actor, the path, the size and the
 * matches, each bounded. A record that cannot be appended does not change the
 * refusal. A clean file answers what was asked of it: the built-in signatures
 * always, and YARA as it is configured and available, with its error when it
 * failed.
 *
 * The scanner is the platform's (platform/files/file-security.ts), and the
 * evidence chain and its key are Corona's; all come in as dependencies.
 */
import { randomUUID } from 'node:crypto';
import { cleanText } from '../../../platform/values/text.ts';

interface ScanMatch { readonly engine?: unknown; readonly rule?: unknown; readonly severity?: unknown }
export interface UploadScanResult {
  readonly blocked?: boolean;
  readonly matches?: readonly ScanMatch[] | null;
  readonly builtin?: { readonly matches?: readonly unknown[] | null } | null;
  readonly yara?: {
    readonly configured?: unknown;
    readonly available?: unknown;
    readonly matches?: readonly unknown[] | null;
    readonly error?: unknown;
  } | null;
}

export interface ScanRequest {
  readonly params?: { readonly owner?: string; readonly repo?: string } | null;
  readonly [field: string]: unknown;
}

export interface UploadScanDeps {
  readonly scan: (file: string, options: { readonly repoPath: unknown; readonly size: unknown }) => Promise<UploadScanResult>;
  /* The repository's evidence chain for the request's identity (Corona). */
  readonly evidenceKey: (req: ScanRequest) => string;
  readonly appendEvidence: (key: string, type: string, id: string, details: unknown) => Promise<unknown>;
  readonly retainedActor: (req: never) => unknown;
}

export function createUploadScan(deps: UploadScanDeps) {
  const actorOf = deps.retainedActor as unknown as (req: ScanRequest) => unknown;

  return async function scanUploadOrThrow(req: ScanRequest, tmp: string, repoPath: unknown, size: unknown) {
    const result = await deps.scan(tmp, { repoPath, size });
    if (result.blocked) {
      const matches = (result.matches || []).map(match => ({
        engine: cleanText(match.engine || 'signature', 40),
        rule: cleanText(match.rule || 'MATCH', 128),
        severity: cleanText(match.severity || 'critical', 20)
      }));
      if (req.params && req.params.owner && req.params.repo) {
        deps.appendEvidence(deps.evidenceKey(req), 'malware-blocked', randomUUID(), {
          actor: actorOf(req),
          path: cleanText(repoPath || 'batch blob', 500),
          size: Number(size || 0),
          matches,
          blockedAt: new Date().toISOString()
        }).catch(() => {});
      }
      throw Object.assign(new Error(`Upload blocked by malware signature rule: ${matches.map(match => match.rule).join(', ')}`), {
        status: 422,
        code: 'MALWARE_DETECTED'
      });
    }
    return {
      builtin: { available: true, matches: (result.builtin && result.builtin.matches || []).length },
      yara: {
        configured: !!(result.yara && result.yara.configured),
        available: !!(result.yara && result.yara.available),
        matches: (result.yara && result.yara.matches || []).length,
        ...(result.yara && result.yara.error ? { error: cleanText(result.yara.error, 240) } : {})
      }
    };
  };
}

export type UploadScan = ReturnType<typeof createUploadScan>;
