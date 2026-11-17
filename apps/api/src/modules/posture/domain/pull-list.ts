import { fieldsOf, read } from '../../../platform/values/fields.ts';

/*
 * One open pull request as the list route answers it.
 *
 * The fields the workbench already read keep their names and meaning. The
 * board on the Overview adds three, all of them metadata GitHub returns on
 * the list itself, so no further request is made for them: when the pull
 * request was opened, how many people and teams were asked to review it, and
 * the names of its labels. A review's verdict is not among them -- the list
 * does not carry it, and the board does not claim it.
 */

export const MAX_LABELS = 8;
export const MAX_LABEL_LENGTH = 50;

function count(value: unknown): number {
  return Array.isArray(value) ? value.filter(entry => entry && typeof entry === 'object').length : 0;
}

/* The label names, each cut to its length and kept once: two labels that read the same once cut are one name. */
function labelNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const label of value) {
    const name = label && typeof label === 'object' ? String(read(label, 'name') || '').trim().slice(0, MAX_LABEL_LENGTH) : '';
    if (!name || names.includes(name)) continue;
    names.push(name);
    if (names.length === MAX_LABELS) break;
  }
  return names;
}

function isoOrNull(value: unknown): string | null {
  const at = Date.parse(String(value || ''));
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

export interface PullListItem {
  readonly number: unknown;
  readonly title: unknown;
  readonly state: unknown;
  readonly draft: boolean;
  readonly merged: boolean;
  readonly user: unknown;
  readonly avatar: unknown;
  readonly head: unknown;
  readonly base: unknown;
  readonly updated_at: unknown;
  readonly created_at: string | null;
  readonly reviewers: number;
  readonly labels: readonly string[];
}

/* Fields of a nested object as the original read them: `a && a.b`, so a missing object reads as itself. */
function nested(parent: unknown, key: string): unknown {
  return parent && read(parent, key);
}

export function pullListItem(p: unknown): PullListItem {
  const pull = fieldsOf(p);
  return {
    number: pull.number,
    title: pull.title,
    state: pull.state,
    draft: pull.draft === true,
    merged: !!pull.merged_at,
    user: nested(pull.user, 'login'),
    avatar: nested(pull.user, 'avatar_url'),
    head: nested(pull.head, 'ref'),
    base: nested(pull.base, 'ref'),
    updated_at: pull.updated_at,
    created_at: isoOrNull(pull.created_at),
    reviewers: count(pull.requested_reviewers) + count(pull.requested_teams),
    labels: labelNames(pull.labels)
  };
}
