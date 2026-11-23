/*
 * A recovery snapshot taken, and the repository's branches restored from one.
 *
 * A snapshot records where every branch and tag points. It is signed and kept
 * on the server when it can be, and kept in this browser and downloaded
 * either way. It is kept under the repository it was taken of, whatever is
 * open when it arrives, and only one that can be read is kept: a snapshot
 * without its branches is said as unreadable rather than kept and then
 * stopping the dialog with a script's error. "Signed" is said only of one
 * the server signed.
 *
 * Recovery compares a snapshot -- pasted, or the last one kept -- with the
 * live repository and shows what restoring would move before anything moves,
 * then asks for RESTORE typed. Every step belongs to the repository it was
 * started on: confirmed after another was opened, nothing is compared or
 * restored. Once branches have moved the repository is read again, so the
 * heads the page writes on are the ones the branches point at now.
 */
import { escapeHtml } from '../../platform/html.ts';
import { field, items } from '../../platform/values.ts';
import { safetyKey } from './protected-paths.ts';

export interface SnapshotRecoveryDeps {
  readonly api: (path: string, options?: { method: string; body: unknown }) => Promise<unknown>;
  /* The open repository: a record whose identity is the repository. */
  readonly work: () => unknown;
  /* What this browser keeps under a name; null when it keeps nothing there or refuses. */
  readonly stored: (name: string) => string | null;
  readonly store: (name: string, value: string) => void;
  readonly modal: (options: { title: string; bodyHTML: string; okText: string; danger?: boolean }) => Promise<unknown>;
  readonly value: (selector: string) => string | null;
  readonly toast: (message: unknown, kind?: string) => void;
  readonly download: (name: string, text: string, type?: string) => void;
  /* A snapshot kept: the posture and the Safeguards screen, which count it, read it again. */
  readonly snapshotTaken: () => void;
  /* Branches restored: the repository and its tree read again. */
  readonly restored: () => void;
}

export interface SnapshotRecovery {
  snapshot(): Promise<void>;
  recover(): Promise<void>;
}

export const SNAPSHOT_KEY = 'nv_snap_';
export const SNAPSHOT_UNREADABLE = 'The snapshot could not be read, so it was not kept.';
export const RESTORE_UNREADABLE = 'The branches were sent to be restored, but the answer could not be read. Refresh to see where they stand.';

const record = (value: unknown): boolean => typeof value === 'object' && value !== null;
const text = (value: unknown): string => (value == null ? '' : String(value));
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/* A snapshot this page can keep and describe: its branches listed, and when it was taken. */
export function readableSnapshot(snap: unknown): boolean {
  return record(snap) && Array.isArray(field(snap, 'refs')) && typeof field(snap, 'capturedAt') === 'string';
}

/* A snapshot or emergency manifest recovery can compare. */
export function recoverable(snap: unknown): boolean {
  const kind = field(snap, 'kind');
  return record(snap) && (kind === 'nebulaverse-snapshot' || kind === 'nebulaverse-emergency-manifest') && Array.isArray(field(snap, 'refs'));
}

export function snapshotSummary(snap: unknown, signedId: string | null): string {
  const refs = items(field(snap, 'refs'));
  const tags = items(field(snap, 'tags'));
  const manifest = field(snap, 'manifest');
  const files = record(manifest) ? `, ${items(field(manifest, 'files')).length} files indexed` : '';
  return `<p class="hint">${refs.length} branch${refs.length === 1 ? '' : 'es'}, ${tags.length} tag(s)${files}. ${signedId !== null ? `Signed and retained in Neon as <span class="mono">${escapeHtml(signedId)}</span>.` : 'Saved locally because durable Neon evidence was unavailable.'} A portable copy was downloaded.</p>
        <div style="max-height:34vh;overflow-y:auto;margin-top:8px">${refs.map(ref =>
          `<p class="hint" style="margin:2px 0"><span class="mono">${escapeHtml(field(ref, 'name'))}</span> \u2014 <span class="mono">${escapeHtml(text(field(ref, 'sha')).slice(0, 8))}</span>${field(ref, 'protected') ? ' (protected)' : ''}</p>`).join('')}</div>`;
}

export function createSnapshotRecovery(deps: SnapshotRecoveryDeps): SnapshotRecovery {
  function place() {
    const work = deps.work();
    return {
      work,
      key: safetyKey(work),
      address: `/api/repo/${String(field(work, 'owner'))}/${String(field(work, 'repo'))}`,
      here: (): boolean => deps.work() === work
    };
  }

  async function snapshot(): Promise<void> {
    const { work, key, address, here } = place();
    if (!work) return;
    try {
      deps.toast('Capturing recovery snapshot\u2026', 'ok');
      let signed: unknown = null;
      try { signed = await deps.api(`${address}/signed-snapshot`, { method: 'POST', body: { manifest: true } }); } catch { signed = null; }
      const signedSnapshot = field(signed, 'snapshot');
      const isSigned = record(signedSnapshot);
      const snap = isSigned ? signedSnapshot : await deps.api(`${address}/refs-snapshot?manifest=1`);
      if (!readableSnapshot(snap)) { if (here()) deps.toast(SNAPSHOT_UNREADABLE, 'err'); return; }
      const json = JSON.stringify(snap);
      deps.store(SNAPSHOT_KEY + key, json);
      const name = typeof field(snap, 'repo') === 'string' && field(snap, 'repo') ? String(field(snap, 'repo')) : String(field(work, 'repo'));
      deps.download(`${name}-${String(field(snap, 'capturedAt')).slice(0, 10)}.nvsnap.json`, JSON.stringify(snap, null, 2));
      if (here()) await deps.modal({ title: 'Recovery snapshot captured', okText: 'Done', bodyHTML: snapshotSummary(snap, isSigned ? text(field(signed, 'snapshotId')) : null) });
      /* Once the dialog has handed focus back, so a redrawn screen keeps it on the control that took the snapshot. */
      deps.snapshotTaken();
    } catch (error) {
      if (here()) deps.toast(field(error, 'message'), 'err');
    }
  }

  async function recover(): Promise<void> {
    const { work, key, address, here } = place();
    if (!work) return;
    const stored = deps.stored(SNAPSHOT_KEY + key);
    const ok = await deps.modal({
      title: 'Verified recovery workflow', okText: 'Analyze snapshot', danger: true,
      bodyHTML: `<p class="hint">Nebulaverse-X first compares the snapshot with the live repository and creates a non-mutating restore preview. No branch is changed during analysis.</p>
      <textarea id="recJson" rows="4" placeholder="Paste a .nvsnap.json file\u2026" style="width:100%;margin-top:8px"></textarea>
      ${stored ? '<p class="hint" style="margin-top:6px">Leave empty to use the last snapshot captured on this device.</p>' : ''}`
    });
    if (!ok || !here()) return;
    const typed = (deps.value('#recJson') ?? '').trim();
    let snap: unknown;
    try { snap = JSON.parse(typed || stored || 'null'); } catch { deps.toast('That snapshot could not be read', 'err'); return; }
    if (!recoverable(snap)) { deps.toast('Not a Nebulaverse-X snapshot or emergency manifest', 'err'); return; }
    try {
      deps.toast('Comparing recovery snapshot with the live repository\u2026', 'ok');
      const [comparison, preview] = await Promise.all([
        deps.api(`${address}/snapshot-compare`, { method: 'POST', body: { snapshot: snap } }),
        deps.api(`${address}/restore-preview`, { method: 'POST', body: { snapshot: snap } })
      ]);
      if (!here()) return;
      const compared = field(field(comparison, 'comparison'), 'counts');
      const counts = record(compared) ? compared : record(field(preview, 'counts')) ? field(preview, 'counts') : {};
      const n = (name: string): number => count(field(counts, name));
      const actions = items(field(preview, 'actions'));
      const warnings = items(field(preview, 'warnings'));
      const canRestore = Boolean(field(preview, 'canRestore'));
      const actionRows = actions.slice(0, 50).map(action =>
        `<p class="hint" style="margin:3px 0"><span class="mono">${escapeHtml(field(action, 'name'))}</span> \u2014 ${field(action, 'action') === 'recreate' ? 'recreate' : 'move'} to <span class="mono">${escapeHtml(text(field(action, 'to')).slice(0, 12))}</span>${field(action, 'protected') ? ' \u00b7 provider protected' : ''}</p>`
      ).join('');
      const proceed = await deps.modal({
        title: 'Recovery impact preview', okText: canRestore ? 'Continue to confirmation' : 'Close', danger: true,
        bodyHTML: `<div class="neural-report-banner"><b>No repository changes have been made.</b><p>${n('refsToMove')} branch(es) would move, ${n('refsToRecreate')} would be recreated, and ${n('newerRefsPreserved')} newer branch(es) would be preserved.</p></div>
        <p class="hint">File comparison: ${n('filesModified')} modified, ${n('filesToRestore')} absent from the current tree, ${n('newerFilesPreserved')} newer file(s) preserved. Reference restore changes branch pointers only.</p>
        ${warnings.map(warning => `<p class="hint">\u26a0 ${escapeHtml(warning)}</p>`).join('')}
        <div style="max-height:26vh;overflow-y:auto;margin-top:8px">${actionRows || '<p class="hint">All recorded branch references already match.</p>'}</div>`
      });
      if (!proceed || !here() || !canRestore || !actions.length) return;
      const confirm = await deps.modal({
        title: 'Confirm branch reference recovery', okText: 'Restore refs', danger: true,
        bodyHTML: `<p class="hint">This force-updates or recreates <b>${actions.length}</b> branch reference(s). Commits created after the snapshot are not deleted, but these branches will no longer point to them.</p>
        <label class="field-label" for="recConfirm">Type <span class="mono">RESTORE</span> to confirm</label>
        <input id="recConfirm" type="text" autocomplete="off" spellcheck="false" autocapitalize="off" autocorrect="off" inputmode="text" placeholder="RESTORE">`
      });
      if (!confirm || !here()) return;
      if ((deps.value('#recConfirm') ?? '').trim().toUpperCase() !== 'RESTORE') { deps.toast('Recovery confirmation did not match', 'err'); return; }
      const out = await deps.api(`${address}/restore-refs`, { method: 'POST', body: { confirm: 'RESTORE', authorization: field(preview, 'authorization') } });
      if (!here()) return;
      deps.restored();
      const report = field(out, 'report');
      if (!Array.isArray(report)) { deps.toast(RESTORE_UNREADABLE, 'err'); return; }
      const done = report.filter(entry => field(entry, 'ok')).length;
      await deps.modal({
        title: `Recovery complete \u2014 ${done}/${report.length}`, okText: 'Done',
        bodyHTML: `<div style="max-height:40vh;overflow-y:auto">${report.map(entry =>
          `<p class="hint" style="margin:2px 0"><span class="mono">${escapeHtml(field(entry, 'name'))}</span> \u2014 ${field(entry, 'ok') ? escapeHtml(field(entry, 'action')) : 'failed: ' + escapeHtml(text(field(entry, 'error')))}</p>`).join('')}</div>`
      });
    } catch (error) {
      if (here()) deps.toast(field(error, 'message'), 'err');
    }
  }

  return { snapshot, recover };
}
