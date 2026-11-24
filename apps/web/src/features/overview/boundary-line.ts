/*
 * The rail's boundary line says what the server last reported. It was static
 * markup that read "Boundary online" before a single request had been made,
 * and kept saying it with the database down.
 *
 * A state is looked up among the line's own states only: one named like a
 * property every object has ("toString") used to be taken for one of them
 * and throw out of the reading that drew it.
 */
import { field } from '../../platform/values.ts';

export const BOUNDARY_COPY = Object.freeze({
  checking: Object.freeze(['Checking boundary', 'Waiting for the server\u2019s report'] as const),
  online: Object.freeze(['Boundary online', 'Server-owned controls active'] as const),
  local: Object.freeze(['Boundary online', 'Server controls active \u00b7 no database configured'] as const),
  degraded: Object.freeze(['Boundary degraded', 'The server database is unavailable'] as const),
  maintenance: Object.freeze(['Maintenance', 'The server is not accepting changes'] as const),
  offline: Object.freeze(['Offline', 'Changes queue until the network returns'] as const),
  unreachable: Object.freeze(['Boundary unreachable', 'The server did not report its state'] as const),
  unknown: Object.freeze(['Boundary unknown', 'The server\u2019s report could not be read'] as const)
});
export type BoundaryKey = keyof typeof BOUNDARY_COPY;

const isKey = (value: unknown): value is BoundaryKey => typeof value === 'string' && Object.hasOwn(BOUNDARY_COPY, value);

/* Which line a report draws: nothing reported yet is "checking". */
export function boundaryKey(boundary: unknown): BoundaryKey {
  if (!boundary) return 'checking';
  if (field(boundary, 'maintenance')) return 'maintenance';
  const said = field(boundary, 'state');
  if (said === 'online') return field(boundary, 'database') === 'not-configured' ? 'local' : 'online';
  return isKey(said) ? said : 'checking';
}

interface Words { textContent: string | null }
export interface BoundaryRoot {
  readonly dataset: { state?: string };
  querySelector(selector: string): Words | null;
}

/* The line drawn for a report: its state for the styles, its title and what it means. */
export function paintBoundary(root: BoundaryRoot | null, boundary: unknown): void {
  if (!root) return;
  const key = boundaryKey(boundary);
  const [title, detail] = BOUNDARY_COPY[key];
  root.dataset.state = key;
  const t = root.querySelector('.nv-rail-state-t');
  const d = root.querySelector('.nv-rail-d');
  if (t) t.textContent = title;
  if (d) d.textContent = detail;
}
