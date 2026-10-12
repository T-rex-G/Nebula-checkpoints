'use strict';

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

const MAX_LABELS = 8;
const MAX_LABEL_LENGTH = 50;

function count(value) {
  return Array.isArray(value) ? value.filter(entry => entry && typeof entry === 'object').length : 0;
}

function labelNames(value) {
  if (!Array.isArray(value)) return [];
  const names = [];
  for (const label of value) {
    const name = label && typeof label === 'object' ? String(label.name || '').trim() : '';
    if (!name || names.includes(name)) continue;
    names.push(name.slice(0, MAX_LABEL_LENGTH));
    if (names.length === MAX_LABELS) break;
  }
  return names;
}

function isoOrNull(value) {
  const at = Date.parse(String(value || ''));
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

function pullListItem(p) {
  const pull = p && typeof p === 'object' ? p : {};
  return {
    number: pull.number,
    title: pull.title,
    state: pull.state,
    draft: pull.draft === true,
    merged: !!pull.merged_at,
    user: pull.user && pull.user.login,
    avatar: pull.user && pull.user.avatar_url,
    head: pull.head && pull.head.ref,
    base: pull.base && pull.base.ref,
    updated_at: pull.updated_at,
    created_at: isoOrNull(pull.created_at),
    reviewers: count(pull.requested_reviewers) + count(pull.requested_teams),
    labels: labelNames(pull.labels)
  };
}

module.exports = { pullListItem, MAX_LABELS, MAX_LABEL_LENGTH };
