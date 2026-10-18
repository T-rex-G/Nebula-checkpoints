/*
 * The repositories in the browser's inventory, read one way.
 *
 * The security posture card and the pull-request board both start from the
 * repository list the workbench already holds, and both must agree about
 * which repositories it names: the same owner/name parsing, the same
 * case-insensitive key, the same treatment of a duplicate or a malformed
 * entry. Two copies of this drifted apart once a fix landed in only one of
 * them, so there is one.
 *
 * Loaded before the cards that use it, and requireable on its own for tests.
 */
(function (global) {
  'use strict';

  /* One repository, case-insensitively: GitHub treats `Acme/Web` and `acme/web` as the same one. */
  function repoKey(owner, name) {
    return `${String(owner || '')}/${String(name || '')}`.toLowerCase();
  }

  /*
   * Each repository once, as `{ owner, repo, key, pushedAt }`, in the order
   * given. `owner` may be a login or a GitHub owner object; an entry with
   * neither an owner and name nor a full_name is left out rather than guessed.
   */
  function inventory(repos) {
    const list = [];
    const seen = new Set();
    for (const repo of Array.isArray(repos) ? repos : []) {
      if (!repo) continue;
      let owner = repo.owner && typeof repo.owner === 'object' ? repo.owner.login : repo.owner;
      let name = repo.name;
      if ((!owner || !name) && repo.full_name) [owner, name] = String(repo.full_name).split('/');
      if (!owner || !name) continue;
      const key = repoKey(owner, name);
      if (seen.has(key)) continue;
      seen.add(key);
      list.push({ owner: String(owner), repo: String(name), key, pushedAt: Date.parse(repo.pushed_at || repo.updated_at || '') || 0 });
    }
    return list;
  }

  global.NebulaRepoInventory = Object.freeze({ inventory, repoKey });
})(typeof globalThis === 'undefined' ? this : globalThis);

if (typeof module === 'object' && module.exports) module.exports = globalThis.NebulaRepoInventory;
