/*
 * The security scan: a branch's dependencies checked against the OSV
 * database, the provider's Dependabot alerts, and the upload malware gate's
 * state, in one report.
 *
 * A scan whose OSV check could not be reached is said to be incomplete and
 * never clean. The report belongs to the repository and branch it was asked
 * for: one that arrives after another repository or branch was opened is not
 * shown over it, nor its failure said there. A
 * part the answer does not carry is read as none rather than stopping the
 * report at a script's error, and every name in it is text.
 */
import { escapeHtml } from '../../platform/html.ts';
import { field, items } from '../../platform/values.ts';

export interface SecurityScanDeps {
  readonly api: (path: string) => Promise<unknown>;
  readonly work: () => unknown;
  readonly modal: (options: { title: string; bodyHTML: string; okText: string }) => Promise<unknown>;
  readonly toast: (message: unknown, kind?: string) => void;
}

const text = (value: unknown): string => (value == null ? '' : String(value));
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/* The upload gate's state when the server could not say it: nothing active, nothing configured, and why. */
export const scannerUnknown = (error: unknown): Record<string, unknown> => ({
  builtin: { available: false }, yara: { configured: false, required: false }, error: field(error, 'message')
});

/* The report on a scan's answer and the upload gate: its title and its body. */
export function scanReport(answer: unknown, scanner: unknown): { title: string; bodyHTML: string } {
  const vulnerable = items(field(answer, 'vulnerable'));
  const details = field(answer, 'details');
  const scanned = count(field(answer, 'scanned'));
  const osv = field(answer, 'osv');
  const osvUnavailable = Boolean(scanned && (!osv || field(osv, 'available') === false));
  const sources = items(field(answer, 'sources'));
  const db = field(answer, 'dependabot');
  const rows = vulnerable.map(v => {
    const ids = items(field(v, 'ids'));
    const d = ids.map(id => field(details, String(id))).filter(Boolean)[0];
    return `<div class="glass" style="padding:8px;margin:6px 0">
        <p style="margin:0"><span class="mono">${escapeHtml(field(v, 'name'))}@${escapeHtml(field(v, 'version'))}</span> <span class="hint">(${escapeHtml(field(v, 'ecosystem'))})</span></p>
        <p class="hint" style="margin:4px 0 0">${escapeHtml(ids.join(', '))}${field(d, 'severity') ? ` \u2014 ${escapeHtml(field(d, 'severity'))}` : ''}</p>
        ${field(d, 'summary') ? `<p class="hint" style="margin:4px 0 0">${escapeHtml(field(d, 'summary'))}</p>` : ''}</div>`;
  }).join('');
  const yara = field(scanner, 'yara');
  return {
    title: osvUnavailable ? 'Dependency scan incomplete' : (vulnerable.length ? `${vulnerable.length} vulnerable package(s)` : 'No known vulnerabilities'),
    bodyHTML: `${osvUnavailable ? `<div class="neural-report-banner"><b>OSV could not be reached.</b><p>${escapeHtml(field(osv, 'error') || 'The vulnerability database did not return a usable response.')} No clean result is claimed; retry the scan later.</p></div>` : ''}<p class="hint">${scanned} package(s) ${osvUnavailable ? 'resolved from manifests' : 'checked against the OSV database'}${sources.length ? ' from ' + escapeHtml(sources.map(source => text(field(source, 'file'))).join(', ')) : ''}.</p>
        ${field(answer, 'approximate') ? '<p class="hint">Versions came from package.json ranges \u2014 commit a lockfile for exact results.</p>' : ''}
        ${!scanned ? '<p class="hint">No supported manifest found (package-lock.json, package.json, requirements.txt, go.mod, Cargo.lock, Gemfile.lock).</p>' : ''}
        <div class="neural-report-banner"><b>Upload malware gate</b><p>Built-in whole-file signature scan: <b>${field(field(scanner, 'builtin'), 'available') ? 'active' : 'unavailable'}</b>. Optional YARA adapter: <b>${field(yara, 'configured') ? (field(yara, 'required') ? 'configured and required' : 'configured') : 'not configured'}</b>${field(scanner, 'error') ? ` \u2014 ${escapeHtml(field(scanner, 'error'))}` : ''}.</p></div>
        <div style="max-height:44vh;overflow-y:auto">${rows}</div>
        ${field(db, 'available') ? `<p class="hint" style="margin-top:8px">Dependabot: ${items(field(db, 'alerts')).length} open alert(s).</p>` : (field(db, 'note') ? `<p class="hint" style="margin-top:8px">Dependabot unavailable \u2014 ${escapeHtml(field(db, 'note'))}.</p>` : '')}`
  };
}

export function createSecurityScan(deps: SecurityScanDeps): { scan(): Promise<void> } {
  async function scan(): Promise<void> {
    const work = deps.work();
    if (!work) return;
    /* A branch is switched on the open repository's record, so the branch is asked for as well. */
    const branch = String(field(work, 'branch'));
    const here = (): boolean => deps.work() === work && String(field(work, 'branch')) === branch;
    try {
      deps.toast('Scanning dependencies and checking upload defenses\u2026', 'ok');
      const [answer, scanner] = await Promise.all([
        deps.api(`/api/repo/${String(field(work, 'owner'))}/${String(field(work, 'repo'))}/audit-deps?ref=${encodeURIComponent(branch)}`),
        deps.api('/api/security/scanner-status').catch(scannerUnknown)
      ]);
      if (!here()) return;
      await deps.modal({ ...scanReport(answer, scanner), okText: 'Done' });
    } catch (error) {
      if (here()) deps.toast(field(error, 'message'), 'err');
    }
  }
  return { scan };
}
