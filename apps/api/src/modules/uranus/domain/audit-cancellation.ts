/*
 * Whether an audit may go on. Every step that waits -- a read, a lookup, a
 * worker, a transaction -- asks before it starts and again when it returns,
 * so a cancelled audit stops at the next step rather than at its end.
 *
 * Cancellation reasons can contain private context; only this fixed error leaves the audit.
 */
export function assertAuditActive(signal: AbortSignal | null | undefined): void {
  if (!signal || !signal.aborted) return;
  throw Object.assign(new Error('The audit was cancelled.'), {
    code: 'AUDIT_CANCELLED',
    status: 499,
    providerChanged: false,
    safeState: 'Nothing was changed. The audit only reads.'
  });
}
