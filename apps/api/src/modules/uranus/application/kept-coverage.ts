/* The evidence used to decide whether a retained audit can supply a complete observation. */
interface RecordedCoverage {
  readonly analysisComplete?: boolean | null;
  readonly files?: { readonly complete: boolean } | null;
  readonly findings?: { readonly total: number; readonly stored: number } | null;
  readonly watch?: { readonly state: string } | null;
}

export function completeAudit(audit: RecordedCoverage): boolean {
  return audit.analysisComplete === true
    && !(audit.files && audit.files.complete !== true)
    && !(audit.findings && audit.findings.total > audit.findings.stored)
    && !(audit.watch && ['partial', 'unavailable'].includes(audit.watch.state));
}
