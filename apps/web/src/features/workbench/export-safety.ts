/*
 * The activity export, written so a spreadsheet opens it as data.
 *
 * Every cell is one line of text in quotes: control characters become a
 * space, a quote is doubled, and a cell a spreadsheet would read as a
 * formula (`=`, `+`, `-` or `@` first, after any spaces) is led by an
 * apostrophe, so a commit message or an issue title cannot run in the
 * reader's spreadsheet.
 */
import { field, items } from '../../platform/values.ts';

export function csvCell(value: unknown): string {
  let text = String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]+/g, ' ');
  if (/^\s*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

/* The first of `item`'s named fields that holds anything, or ''. */
function first(item: unknown, ...names: string[]): unknown {
  for (const name of names) {
    const value = field(item, name);
    if (value) return value;
  }
  return '';
}

export function activityCsv(activity: unknown = {}): string {
  const rows: unknown[][] = [['type', 'id', 'title', 'state', 'actor', 'timestamp', 'sha_or_tag', 'risk_score', 'severity']];
  for (const item of items(field(activity, 'commits'))) rows.push([
    'commit', first(item, 'sha'), first(item, 'message'), '', first(item, 'actor', 'author'),
    first(item, 'timestamp', 'date', 'authored_at'), first(item, 'sha'), '', ''
  ]);
  for (const item of items(field(activity, 'pulls'))) rows.push([
    'pull_request', first(item, 'number'), first(item, 'title'), first(item, 'state'), first(item, 'actor', 'user', 'author'),
    first(item, 'timestamp', 'updated_at', 'updated', 'created_at'), '', '', ''
  ]);
  for (const item of items(field(activity, 'issues'))) rows.push([
    'issue', first(item, 'number'), first(item, 'title'), first(item, 'state'), first(item, 'actor', 'user', 'author'),
    first(item, 'timestamp', 'updated_at', 'updated', 'created_at'), '', '', ''
  ]);
  for (const item of items(field(activity, 'releases'))) rows.push([
    'release', first(item, 'id'), first(item, 'name', 'tag'),
    field(item, 'state') || (field(item, 'draft') ? 'draft' : field(item, 'prerelease') ? 'prerelease' : 'published'),
    first(item, 'actor', 'author'), first(item, 'timestamp', 'published_at', 'published', 'created_at'),
    first(item, 'tag'), '', ''
  ]);
  for (const item of items(field(activity, 'intelligenceEvents'))) {
    const score = field(item, 'score');
    rows.push([
      'verified_event', first(item, 'id'),
      field(item, 'summary') || `${String(field(item, 'eventType') || 'event')} ${String(field(item, 'action') || '')}`.trim(),
      first(item, 'action'), first(item, 'actor'), first(item, 'createdAt', 'timestamp'),
      first(item, 'afterSha', 'beforeSha', 'ref'), score == null ? '' : score, first(item, 'severity')
    ]);
  }
  return rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

const ExportSafety = Object.freeze({ csvCell, activityCsv });
export default ExportSafety;
